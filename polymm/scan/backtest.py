"""Walk-forward backtest of the "Historical edge" strategy on Kalshi history.

Uses Jon Becker's prediction-market-analysis dataset. Kalshi only: its trades
carry exact timestamps and the taker's side, which is what the strategy does
(buy at the ask). Cross-venue and sportsbook signals can't be replayed from
this data: there are no historical order books or sportsbook lines in it.

No peeking at the future:
  * For each test month M, the win-rate table is built only from markets that
    closed BEFORE M. Same pooling, shrinkage, fee and edge rules as the live scanner.
  * A real past taker trade at price p is the evidence that p was buyable at
    that moment. The strategy "buys" the first such trade it would have liked
    in each market and side, at most as many contracts as that trade had.
  * The result is what the market actually resolved to.

Benchmark: buying the first trade of every market in the same price range and
holding period, with no edge filter. If the strategy can't beat that, it has no edge.

    python -m polymm.scan.backtest --demo                     # synthetic data, shows the mechanics
    python -m polymm.scan.backtest --archive data.tar.zst     # the real dataset
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import random
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from .calibration import ALL, Calibration, iter_archive, iter_dir
from .categories import kalshi_group


@dataclass
class BacktestConfig:
    start: str | None = None  # first test month "YYYY-MM"; default: once there's enough history
    min_train_positions: int = 50_000  # market-price observations needed before the first test month
    min_edge: float = 0.02  # same defaults as the live scanner
    sigma_mult: float = 2.0
    min_markets: int = 300
    prior_markets: float = 100.0
    window: int = 1
    min_price: int = 6  # cents; 95c+ / 5c- is "already decided" in the scanner
    max_price: int = 94
    max_days: float = 60.0
    fee_rate: float = 0.07
    stake: float = 10.0  # flat $ per bet
    bankroll: float = 1000.0  # for the compounding simulation
    kelly_fraction: float = 0.125  # eighth-Kelly, as the dashboard suggests
    cap_to_trade_size: bool = True  # never assume more size than the real trade had
    bootstrap: int = 500


def kalshi_fee(contracts: int, price: float, rate: float = 0.07) -> float:
    """Kalshi taker fee for one order: roundup(rate * C * P * (1 - P)) to the cent."""
    return math.ceil(rate * contracts * price * (1 - price) * 100 - 1e-9) / 100


# ---------------------------------------------------------------------- data store

class Store:
    """Kalshi markets + trades reduced to what the backtest needs, in a DuckDB file
    (so the 36 GB archive only has to be streamed once)."""

    def __init__(self, db_path: str | Path = ":memory:"):
        import duckdb

        self.con = duckdb.connect(str(db_path))
        self.con.execute("SET TimeZone = 'UTC'")
        self.con.execute("""
            CREATE TABLE IF NOT EXISTS k_markets (ticker VARCHAR, event_ticker VARCHAR, result VARCHAR,
                                                  close_time TIMESTAMP);
            CREATE TABLE IF NOT EXISTS k_trades (ticker VARCHAR, taker_side VARCHAR, yes_price SMALLINT,
                                                 no_price SMALLINT, cnt INTEGER, ts TIMESTAMP);
            CREATE TABLE IF NOT EXISTS meta (k VARCHAR PRIMARY KEY, v VARCHAR);
        """)

    @property
    def complete(self) -> bool:
        return bool(self.con.execute("SELECT 1 FROM meta WHERE k = 'complete'").fetchone())

    def add_file(self, kind: str, path: str) -> None:
        src = f"read_parquet('{str(path).replace(chr(39), chr(39) * 2)}', union_by_name=true)"
        if kind == "kalshi/markets":
            self.con.execute(f"""
                INSERT INTO k_markets
                SELECT ticker, event_ticker, result, CAST(close_time AS TIMESTAMP) FROM {src}
                WHERE status = 'finalized' AND result IN ('yes', 'no')""")
        elif kind == "kalshi/trades":
            self.con.execute(f"""
                INSERT INTO k_trades
                SELECT ticker, taker_side, yes_price, no_price, CAST("count" AS INTEGER),
                       CAST(created_time AS TIMESTAMP)
                FROM {src} WHERE taker_side IN ('yes', 'no')""")

    def load(self, files, log=print) -> None:
        n = 0
        for kind, path in files:
            self.add_file(kind, path)
            n += 1
            if n % 50 == 0:
                log(f"  loaded {n} files")
        self.con.execute("INSERT OR REPLACE INTO meta VALUES ('complete', ?)", [datetime.now().isoformat()])
        log(f"loaded {n} Kalshi files")


# ---------------------------------------------------------------------- backtest

def _prepare(con) -> list[str]:
    con.execute("SET TimeZone = 'UTC'")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE mk AS
        SELECT ticker, any_value(event_ticker) AS ev, any_value(result) AS result, max(close_time) AS close_time
        FROM k_markets GROUP BY ticker""")
    cats = [r[0] for r in con.execute(
        "SELECT DISTINCT regexp_extract(ev, '^([A-Z0-9]+)', 1) FROM mk").fetchall()]
    con.execute("CREATE OR REPLACE TEMP TABLE cat_group (cat VARCHAR, grp VARCHAR)")
    if cats:
        con.executemany("INSERT INTO cat_group VALUES (?, ?)", [(c, kalshi_group(c)) for c in cats])
    # Every taker purchase in a resolved market: side bought, price paid, did it win.
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pos AS
        SELECT t.ticker, m.ev, g.grp, t.taker_side AS side,
               CAST(CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END AS INTEGER) AS price,
               (t.taker_side = m.result) AS won, t.cnt, t.ts, m.close_time
        FROM k_trades t
        JOIN mk m USING (ticker)
        JOIN cat_group g ON g.cat = regexp_extract(m.ev, '^([A-Z0-9]+)', 1)""")
    return sorted({kalshi_group(c) for c in cats})


def _monthly_training(con) -> list[tuple]:
    """(close_month, group, side, price, markets, wins): what was known once each month closed.
    Each market counts once per price (its trades share one outcome)."""
    return con.execute("""
        SELECT cm, grp, side, price, COUNT(*) AS n, SUM(CASE WHEN won THEN 1 ELSE 0 END) AS wins
        FROM (SELECT DISTINCT date_trunc('month', close_time) AS cm, grp, ticker, side, price, won
              FROM pos WHERE price BETWEEN 1 AND 99 AND close_time IS NOT NULL)
        GROUP BY ALL ORDER BY cm""").fetchall()


def _month_add(d: datetime, k: int = 1) -> datetime:
    y, m = divmod(d.month - 1 + k, 12)
    return d.replace(year=d.year + y, month=m + 1, day=1, hour=0, minute=0, second=0, microsecond=0)


def run_backtest(con, cfg: BacktestConfig, log=print) -> dict:
    t0 = time.time()
    groups = _prepare(con)
    train_rows = _monthly_training(con)
    if not train_rows:
        raise ValueError("no resolved Kalshi trades found")
    last_trade = con.execute("SELECT max(ts) FROM pos").fetchone()[0]
    last_month = last_trade.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # Choose the first test month.
    if cfg.start:
        start = datetime.strptime(cfg.start, "%Y-%m")
    else:
        acc, start = 0, None
        for cm, *_rest, n, _w in train_rows:
            acc += n
            if acc >= cfg.min_train_positions:
                start = _month_add(cm)
                break
        if start is None:
            raise ValueError(f"not enough history: fewer than {cfg.min_train_positions:,} market-price observations")

    # Walk forward: month by month, decide which (group, side, price) cells are buys.
    cum: dict = defaultdict(dict)
    i = 0
    qual: list[tuple] = []
    month = start
    from .fees import FeeModel

    fee_model = FeeModel(kalshi_rate=cfg.fee_rate)
    while month <= last_month:
        while i < len(train_rows) and train_rows[i][0] < month:  # strictly before this month
            cm, g, side, price, n, w = train_rows[i]
            for key in (f"{g}|{side}", f"{ALL}|{side}"):
                cur = cum[key].get(str(price), [0, 0])
                cum[key][str(price)] = [cur[0] + n, cur[1] + w]
            i += 1
        cal = Calibration({"tables": {"kalshi": {"taker": cum}}}, window=cfg.window,
                          prior_markets=cfg.prior_markets, min_markets=cfg.min_markets)
        for g in groups:
            for side in ("yes", "no"):
                for cents in range(cfg.min_price, cfg.max_price + 1):
                    p = cents / 100
                    w = cal.win_prob("kalshi", side, p, g)
                    if w is None:
                        continue
                    edge = w.p - p - fee_model.per_contract("kalshi", p)
                    if edge >= max(cfg.min_edge, cfg.sigma_mult * w.se):
                        qual.append((month, g, side, cents, w.p, w.n, w.group))
        month = _month_add(month)
    log(f"walk-forward: {len(qual):,} (month, category, side, price) cells qualified")

    con.execute("CREATE OR REPLACE TEMP TABLE qual (m TIMESTAMP, grp VARCHAR, side VARCHAR, price INTEGER, "
                "p_hat DOUBLE, hist_n BIGINT, basis VARCHAR)")
    if qual:
        con.executemany("INSERT INTO qual VALUES (?, ?, ?, ?, ?, ?, ?)", qual)

    window_filter = """p.ts >= ? AND p.close_time IS NOT NULL AND p.close_time > p.ts
                       AND date_diff('second', p.ts, p.close_time) <= ? * 86400
                       AND p.price BETWEEN ? AND ?"""
    params = [start, cfg.max_days, cfg.min_price, cfg.max_price]
    bets = con.execute(f"""
        SELECT ticker, ev, grp, side, price, won, cnt, ts, close_time, p_hat, hist_n, basis FROM (
            SELECT p.*, q.p_hat, q.hist_n, q.basis,
                   row_number() OVER (PARTITION BY p.ticker, p.side ORDER BY p.ts) AS rn
            FROM pos p
            JOIN qual q ON q.m = date_trunc('month', p.ts) AND q.grp = p.grp
                       AND q.side = p.side AND q.price = p.price
            WHERE {window_filter}
        ) WHERE rn = 1 ORDER BY ts""", params).fetchall()
    cols = ["ticker", "ev", "grp", "side", "price", "won", "cnt", "ts", "close_time", "p_hat", "hist_n", "basis"]
    bets = [dict(zip(cols, r)) for r in bets]
    log(f"strategy would have placed {len(bets):,} bets")

    # Benchmark: first trade of every market+side in the same window, no edge filter.
    stake, rate = cfg.stake, cfg.fee_rate
    contracts_sql = (f"CASE WHEN {int(cfg.cap_to_trade_size)} = 1 THEN least(greatest(floor({stake} / (price / 100.0)), 1), cnt) "
                     f"ELSE greatest(floor({stake} / (price / 100.0)), 1) END")
    fee_sql = f"ceil({rate} * c * (price / 100.0) * (1 - price / 100.0) * 100 - 1e-9) / 100"
    base = con.execute(f"""
        WITH first AS (
            SELECT * FROM (
                SELECT p.*, row_number() OVER (PARTITION BY p.ticker, p.side ORDER BY p.ts) AS rn
                FROM pos p WHERE {window_filter}) WHERE rn = 1),
        sized AS (SELECT *, {contracts_sql} AS c FROM first)
        SELECT COUNT(*), SUM(c * price / 100.0 + {fee_sql}),
               SUM(CASE WHEN won THEN c ELSE 0 END - c * price / 100.0 - {fee_sql}),
               AVG(CASE WHEN won THEN 1.0 ELSE 0 END), AVG(price / 100.0)
        FROM sized""", params).fetchone()
    benchmark = {"bets": base[0], "cost": base[1] or 0.0, "pnl": base[2] or 0.0,
                 "win_rate": base[3], "avg_price": base[4]}
    benchmark["roi"] = benchmark["pnl"] / benchmark["cost"] if benchmark["cost"] else 0.0

    report = _evaluate(bets, cfg)
    report.update({
        "config": asdict(cfg), "test_start": start.strftime("%Y-%m"), "test_end": last_month.strftime("%Y-%m"),
        "benchmark": benchmark, "runtime_s": round(time.time() - t0, 1),
    })
    return report


# ---------------------------------------------------------------------- scoring

def _flat(b: dict, cfg: BacktestConfig) -> tuple[int, float, float]:
    p = b["price"] / 100
    c = max(1, math.floor(cfg.stake / p))
    if cfg.cap_to_trade_size:
        c = min(c, int(b["cnt"]))
    fee = kalshi_fee(c, p, cfg.fee_rate)
    cost = c * p + fee
    return c, cost, (c if b["won"] else 0) - cost


def _summ(rows: list[tuple[float, float, bool, float]]) -> dict:
    """rows: (cost, pnl, won, p_hat)."""
    cost = sum(r[0] for r in rows)
    pnl = sum(r[1] for r in rows)
    return {"bets": len(rows), "cost": cost, "pnl": pnl, "roi": pnl / cost if cost else 0.0,
            "win_rate": sum(r[2] for r in rows) / len(rows) if rows else 0.0,
            "predicted_win_rate": sum(r[3] for r in rows) / len(rows) if rows else 0.0}


def _evaluate(bets: list[dict], cfg: BacktestConfig) -> dict:
    flat_rows, by_group, by_bucket, by_month, by_event = [], defaultdict(list), defaultdict(list), \
        defaultdict(list), defaultdict(lambda: [0.0, 0.0])
    curve, running = [], 0.0
    for b in bets:
        _, cost, pnl = _flat(b, cfg)
        row = (cost, pnl, bool(b["won"]), b["p_hat"])
        flat_rows.append(row)
        by_group[b["grp"]].append(row)
        lo = (b["price"] // 10) * 10
        by_bucket[f"{lo}-{lo + 9}c"].append(row)
        by_month[b["ts"].strftime("%Y-%m")].append(row)
        by_event[b["ev"]][0] += cost
        by_event[b["ev"]][1] += pnl
    # Flat-stake cumulative P&L, booked when each market resolves.
    for b, row in sorted(zip(bets, flat_rows), key=lambda x: x[0]["close_time"]):
        running += row[1]
        curve.append((b["close_time"].isoformat(), round(running, 2)))

    # Confidence interval: resample whole events (bets in one event are correlated).
    ci = None
    if len(by_event) >= 20:
        rng = random.Random(0)
        ev = list(by_event.values())
        rois = []
        for _ in range(cfg.bootstrap):
            s = [ev[rng.randrange(len(ev))] for _ in ev]
            c = sum(x[0] for x in s)
            rois.append(sum(x[1] for x in s) / c if c else 0.0)
        rois.sort()
        ci = (rois[int(0.025 * len(rois))], rois[int(0.975 * len(rois)) - 1])

    return {
        "flat": {**_summ(flat_rows), "roi_ci95": ci, "events": len(by_event), "stake": cfg.stake},
        "by_category": {k: _summ(v) for k, v in sorted(by_group.items(), key=lambda kv: -len(kv[1]))},
        "by_price": {k: _summ(v) for k, v in sorted(by_bucket.items(), key=lambda kv: int(kv[0].split("-")[0]))},
        "by_month": {k: _summ(v) for k, v in sorted(by_month.items())},
        "flat_curve": curve,
        "bankroll": _simulate_bankroll(bets, cfg),
    }


def _simulate_bankroll(bets: list[dict], cfg: BacktestConfig) -> dict:
    """Compounding: eighth-Kelly of current equity, money locked until each market resolves."""
    cash, open_heap, seq = cfg.bankroll, [], 0
    open_cost = 0.0
    curve, peak, max_dd, placed, skipped = [], cfg.bankroll, 0.0, 0, 0

    def settle_until(t):
        nonlocal cash, open_cost, peak, max_dd
        while open_heap and (t is None or open_heap[0][0] <= t):
            close, _, payout, cost = heapq.heappop(open_heap)
            cash += payout
            open_cost -= cost
            eq = cash + open_cost
            peak = max(peak, eq)
            max_dd = max(max_dd, (peak - eq) / peak if peak else 0.0)
            curve.append((close.isoformat(), round(eq, 2)))

    for b in bets:
        settle_until(b["ts"])
        p = b["price"] / 100
        p_eff = p + cfg.fee_rate * p * (1 - p)
        kelly = max(0.0, (b["p_hat"] - p_eff) / (1 - p_eff))
        equity = cash + open_cost
        budget = min(cfg.kelly_fraction * kelly * equity, cash)
        c = math.floor(budget / p_eff)
        if cfg.cap_to_trade_size:
            c = min(c, int(b["cnt"]))
        if c < 1:
            skipped += 1
            continue
        cost = c * p + kalshi_fee(c, p, cfg.fee_rate)
        if cost > cash:
            skipped += 1
            continue
        cash -= cost
        open_cost += cost
        seq += 1
        placed += 1
        heapq.heappush(open_heap, (b["close_time"], seq, c if b["won"] else 0, cost))
    settle_until(None)
    final = cash
    return {"start": cfg.bankroll, "final": round(final, 2), "return": final / cfg.bankroll - 1,
            "max_drawdown": max_dd, "placed": placed, "skipped_too_small": skipped, "curve": curve}


# ---------------------------------------------------------------------- output

def summary_text(r: dict) -> str:
    f, bm, br = r["flat"], r["benchmark"], r["bankroll"]
    ci = f["roi_ci95"]
    lines = [
        f"Kalshi walk-forward backtest, {r['test_start']} to {r['test_end']}",
        "",
        f"Strategy ({f['bets']:,} bets across {f['events']:,} events, ${f['stake']:.0f} flat stake each):",
        f"  staked ${f['cost']:,.0f}, P&L ${f['pnl']:+,.0f}, ROI {f['roi']:+.2%}"
        + (f"  (95% CI {ci[0]:+.2%} to {ci[1]:+.2%})" if ci else "  (too few events for a CI)"),
        f"  won {f['win_rate']:.1%} vs {f['predicted_win_rate']:.1%} predicted",
        f"Benchmark (buy the first trade of every market in the same price/time window, no filter):",
        f"  {bm['bets']:,} bets, ROI {bm['roi']:+.2%}",
        f"Compounding ${br['start']:,.0f} at eighth-Kelly: ended ${br['final']:,.0f} ({br['return']:+.1%}), "
        f"max drawdown {br['max_drawdown']:.1%}, {br['placed']:,} bets placed",
        "",
        "By category:",
    ]
    for k, v in r["by_category"].items():
        lines.append(f"  {k:<14} {v['bets']:>7,} bets  ROI {v['roi']:+7.2%}  won {v['win_rate']:.1%} "
                     f"(predicted {v['predicted_win_rate']:.1%})")
    lines.append("By price paid:")
    for k, v in r["by_price"].items():
        lines.append(f"  {k:<14} {v['bets']:>7,} bets  ROI {v['roi']:+7.2%}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- synthetic data

def make_synthetic_dataset(root: str | Path, months: int = 24, markets_per_month: int = 1500,
                           trades_per_market: int = 30, bias: float = 0.03, bias_months: tuple[int, int] | None = None,
                           seed: float = 0.42) -> None:
    """A fake Kalshi history in the dataset's layout, with a known favourite-longshot
    bias: the market prices a true probability q at q + bias * (1 - 2q) (longshots
    too dear, favourites too cheap). `bias_months=(a, b)` applies it only to markets
    closing in months a..b-1; outside that range the market is perfectly calibrated."""
    import duckdb

    root = Path(root)
    (root / "kalshi/markets").mkdir(parents=True, exist_ok=True)
    (root / "kalshi/trades").mkdir(parents=True, exist_ok=True)
    a, b = bias_months or (0, months)
    con = duckdb.connect()
    con.execute(f"SELECT setseed({seed})")
    con.execute(f"""
        CREATE TABLE m AS
        SELECT i, (['KXHIGHNY', 'KXNFLGAME', 'KXBTCD'])[1 + i % 3] || '-' || i AS ev,
               'T' || i AS ticker, i // {markets_per_month} AS month,
               0.03 + 0.94 * random() AS q, random() AS u,
               TIMESTAMP '2023-01-01' + to_months(CAST(i // {markets_per_month} AS INTEGER))
                   + to_seconds(CAST(floor(random() * 27 * 86400) AS BIGINT)) AS close_time
        FROM range({months * markets_per_month}) t(i)""")
    con.execute(f"""
        CREATE TABLE m2 AS
        SELECT *, CASE WHEN u < q THEN 'yes' ELSE 'no' END AS result,
               q + (CASE WHEN month >= {a} AND month < {b} THEN {bias} ELSE 0 END) * (1 - 2 * q) AS mkt
        FROM m""")
    con.execute(f"""COPY (SELECT ticker, ev AS event_ticker, 'finalized' AS status, result, close_time FROM m2)
                    TO '{root}/kalshi/markets/markets.parquet' (FORMAT parquet)""")
    con.execute(f"""
        COPY (
            SELECT ticker || '-' || j AS trade_id, ticker, taker_side, yes_price, 100 - yes_price AS no_price,
                   "count", created_time
            FROM (
                SELECT ticker, j,
                       CASE WHEN random() < 0.5 THEN 'yes' ELSE 'no' END AS taker_side,
                       CAST(least(99, greatest(1, round(100 * (mkt + 0.02 * (random() - 0.5))))) AS INTEGER) AS yes_price,
                       1 + CAST(floor(random() * 60) AS INTEGER) AS "count",
                       close_time - to_seconds(CAST(floor(random() * 30 * 86400) AS BIGINT)) AS created_time
                FROM m2, range({trades_per_market}) r(j)))
        TO '{root}/kalshi/trades/trades.parquet' (FORMAT parquet)""")


# ---------------------------------------------------------------------- CLI

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--archive", help="data.tar.zst (path or URL) from prediction-market-analysis")
    src.add_argument("--data", help="an extracted dataset 'data' directory")
    src.add_argument("--db", help="reuse a store built by an earlier run")
    src.add_argument("--demo", action="store_true", help="synthetic data with a known 3c bias (not real results)")
    ap.add_argument("--store", default="backtest_kalshi.duckdb", help="where to keep the reduced Kalshi data")
    ap.add_argument("--start", help="first test month, YYYY-MM")
    ap.add_argument("--min-edge", type=float, default=0.02)
    ap.add_argument("--max-days", type=float, default=60)
    ap.add_argument("--stake", type=float, default=10.0)
    ap.add_argument("--bankroll", type=float, default=1000.0)
    ap.add_argument("--out", default="backtest_report.html")
    args = ap.parse_args()

    try:
        import duckdb  # noqa: F401
        if args.archive:
            import zstandard  # noqa: F401
    except ImportError as e:
        sys.exit(f"missing dependency ({e.name}). Run:  python -m pip install duckdb zstandard")

    log = lambda m: print(m, flush=True)
    cfg = BacktestConfig(start=args.start, min_edge=args.min_edge, max_days=args.max_days,
                         stake=args.stake, bankroll=args.bankroll)
    label = "real Kalshi history (prediction-market-analysis dataset)"
    if args.demo:
        tmp = Path(tempfile.mkdtemp())
        log("generating synthetic history with a known 3c favourite-longshot bias...")
        make_synthetic_dataset(tmp / "data")
        store = Store()
        store.load(iter_dir(tmp / "data"), log)
        cfg.min_train_positions = 20_000
        label = "SYNTHETIC DEMO DATA: a made-up market with a 3c bias built in. Not real results."
    else:
        db = args.db or args.store
        store = Store(db)
        if args.archive or args.data:
            if store.complete:
                log(f"{db} already has the data; reusing it (delete it to reload)")
            else:
                kinds = {"kalshi/markets", "kalshi/trades"}
                files = iter_archive(args.archive, Path(db).resolve().parent, log, kinds) if args.archive \
                    else iter_dir(args.data, kinds)
                store.load(files, log)
        elif not store.complete:
            sys.exit(f"{db} is empty or incomplete; run with --archive or --data first")

    r = run_backtest(store.con, cfg, log)
    r["data_label"] = label
    print("\n" + summary_text(r))
    from .backtest_report import write_html

    write_html(r, args.out)
    Path(args.out).with_suffix(".json").write_text(json.dumps(r, default=str))
    print(f"\nreport: {Path(args.out).resolve()}")


if __name__ == "__main__":
    main()
