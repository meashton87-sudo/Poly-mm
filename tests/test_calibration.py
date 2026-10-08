"""Calibration builder against a synthetic copy of the prediction-market-analysis layout."""

import io
import json
import tarfile
from datetime import datetime, timezone

import pytest

duckdb = pytest.importorskip("duckdb")
zstandard = pytest.importorskip("zstandard")

from polymm.scan.calibration import Builder, Calibration, build_from_archive, build_from_dir  # noqa: E402
from polymm.scan.fees import FeeModel  # noqa: E402
from polymm.scan.models import Contract  # noqa: E402
from polymm.scan.strategies import ScanConfig, calibration_value  # noqa: E402

NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)


def _write_dataset(root):
    """Kalshi: 10 weather markets, takers buy YES at 10c 100x each, only 1 market hits.
    Polymarket: a resolved NO market with one 20c YES buy and one 75c NO buy."""
    con = duckdb.connect()
    (root / "kalshi/markets").mkdir(parents=True)
    (root / "kalshi/trades").mkdir(parents=True)
    (root / "polymarket/markets").mkdir(parents=True)
    (root / "polymarket/trades").mkdir(parents=True)
    (root / "polymarket/legacy_trades").mkdir(parents=True)
    markets = ", ".join(f"('KXHIGHNY-A{i}', 'KXHIGHNY-26OCT0{i}', 'finalized', '{'yes' if i == 0 else 'no'}')"
                        for i in range(10))
    markets += ", ('KXHIGHNY-OPEN', 'KXHIGHNY-26OCT09', 'open', '')"
    for part in ("a", "b"):  # the same markets fetched twice must not double count
        con.execute(f"""COPY (SELECT * FROM (VALUES {markets}) t(ticker, event_ticker, status, result))
                        TO '{root}/kalshi/markets/{part}.parquet' (FORMAT parquet)""")
    con.execute(f"""COPY (
        SELECT m.ticker, 'yes' AS taker_side, 10 AS yes_price, 90 AS no_price, 't' || m.ticker || i AS trade_id
        FROM (VALUES {', '.join(f"('KXHIGHNY-A{i}')" for i in range(10))}, ('KXHIGHNY-OPEN')) m(ticker),
             range(100) r(i)) TO '{root}/kalshi/trades/0.parquet' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('m1', 'Highest temperature in NYC?', '["111","222"]', '["0","1"]', true),
        ('m2', 'Unresolved?', '["333","444"]', '["0.5","0.5"]', true)
        ) t(id, question, clob_token_ids, outcome_prices, closed))
        TO '{root}/polymarket/markets/0.parquet' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT * FROM (VALUES
        ('0', '111', 20000000, 100000000),
        ('222', '0', 100000000, 75000000)
        ) t(maker_asset_id, taker_asset_id, maker_amount, taker_amount))
        TO '{root}/polymarket/trades/0.parquet' (FORMAT parquet)""")
    # Present in the real archive but not used: must be skipped, not crash.
    con.execute(f"COPY (SELECT 1 AS x) TO '{root}/polymarket/legacy_trades/0.parquet' (FORMAT parquet)")


def _check(cal):
    k = cal["tables"]["kalshi"]
    assert k["taker"]["Weather|yes"]["10"] == [1000, 100]  # 10% of 10c YES buys won
    assert k["all"]["*|no"]["90"] == [1000, 900]  # makers on the other side
    assert "*|no" not in k["taker"]  # nobody took NO
    p = cal["tables"]["polymarket"]["all"]
    assert p["Weather|yes"]["20"] == [1, 0] and p["Weather|no"]["80"] == [1, 1]
    assert p["*|no"]["75"] == [1, 1] and p["*|yes"]["25"] == [1, 0]


def test_build_from_extracted_dir(tmp_path):
    _write_dataset(tmp_path / "data")
    cal = build_from_dir(tmp_path / "data", log=lambda m: None)
    assert cal["files"]["kalshi/markets"] == 2
    _check(cal)


def test_build_streams_tar_zst_archive(tmp_path):
    _write_dataset(tmp_path / "data")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(tmp_path / "data", arcname="data")
    archive = tmp_path / "data.tar.zst"
    archive.write_bytes(zstandard.ZstdCompressor().compress(buf.getvalue()))
    cal = build_from_archive(str(archive), tmp_path, log=lambda m: None)
    _check(cal)
    assert not list(tmp_path.glob("tmp*"))  # temp dir cleaned up


def test_classify_member_paths():
    assert Builder.classify("data/kalshi/trades/x.parquet") == "kalshi/trades"
    assert Builder.classify("./data/polymarket/markets/0001.parquet") == "polymarket/markets"
    assert Builder.classify("data/polymarket/legacy_trades/x.parquet") is None
    assert Builder.classify("data/polymarket/blocks/x.parquet") is None


def _cal(win_rate_at_10=0.04, n=50_000):
    """A table where 10c YES longshots historically won 4% (overpriced) and
    90c NOs therefore won 96% (underpriced)."""
    buckets_yes = {str(c): [n, int(n * (win_rate_at_10 if c == 10 else c / 100))] for c in range(1, 100)}
    buckets_no = {str(c): [n, int(n * ((1 - win_rate_at_10) if c == 90 else c / 100))] for c in range(1, 100)}
    return Calibration({"total_positions": n * 198, "tables": {"kalshi": {"taker": {
        "*|yes": buckets_yes, "*|no": buckets_no}}}}, window=0)


def test_lookup_shrinks_and_falls_back_to_all_markets():
    cal = _cal()
    w = cal.win_prob("kalshi", "no", 0.90, "Weather")  # no Weather table -> all markets
    assert w.group == "*" and 0.95 < w.p < 0.96 and w.n == 50_000
    thin = Calibration({"tables": {"kalshi": {"taker": {"*|no": {"90": [10, 10]}}}}}, window=0, min_trades=5)
    assert thin.win_prob("kalshi", "no", 0.90).p < 0.91  # 10/10 wins barely moves a 300-trade prior
    assert cal.win_prob("polymarket", "yes", 0.5) is None


def test_calibration_value_flags_underpriced_favourites_only():
    cal = _cal()
    longshot = Contract("kalshi", "K1", "Will it snow in Miami?", "Yes", yes_bid=0.10, yes_ask=0.11,
                        close_time=datetime(2026, 10, 20, tzinfo=timezone.utc))
    opps = calibration_value([longshot], cal, FeeModel(), ScanConfig(), NOW)
    assert len(opps) == 1 and opps[0].legs[0].side == "NO"  # buy NO at 90c, historically worth ~95.6c
    assert opps[0].fair > 0.95
    far = Contract("kalshi", "K2", "q", "Yes", yes_bid=0.10, yes_ask=0.11,
                   close_time=datetime(2027, 6, 1, tzinfo=timezone.utc))
    assert calibration_value([far], cal, FeeModel(), ScanConfig(), NOW) == []  # too far out
    assert calibration_value([longshot], None, FeeModel(), ScanConfig(), NOW) == []


def test_calibration_defers_to_sportsbooks_on_the_same_game():
    from polymm.scan.__main__ import FIXTURES
    from polymm.scan.scanner import Snapshot, scan
    from polymm.scan.sources import parse_polymarket_markets

    n = 40000
    no_bias = {str(c): [n, int(n * min(0.999, c / 100 + (0.04 if c > 55 else 0)))] for c in range(1, 100)}
    cal = Calibration({"tables": {"polymarket": {"all": {"*|no": no_bias}}}})
    contracts = parse_polymarket_markets(json.loads((FIXTURES / "polymarket_markets.json").read_text()))
    odds = json.loads((FIXTURES / "odds_api_h2h.json").read_text())
    opps = scan(Snapshot(contracts, odds), now=NOW, calibration=cal)
    game = [o for o in opps if o.legs[0].contract.id == "0xtbdet"]
    assert {o.kind for o in game} == {"sportsbook_value"}
    assert any(o.kind == "calibration_value" for o in opps)  # still fires on non-sports markets
