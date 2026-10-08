import json
from datetime import datetime, timezone

import pytest

from polymm.scan.__main__ import FIXTURES, OFFLINE_NOW
from polymm.scan.fees import FeeModel
from polymm.scan.matching import Pair, match_cross_venue, team_matches, tokens
from polymm.scan.models import Contract
from polymm.scan.scanner import Snapshot, executable_units, scan
from polymm.scan.sources import parse_kalshi_events, parse_polymarket_markets
from polymm.scan.strategies import ScanConfig, cross_venue, multi_outcome_arbs, sportsbook_value

NOW = OFFLINE_NOW
END = datetime(2026, 12, 31, tzinfo=timezone.utc)


def _load(name):
    return json.loads((FIXTURES / name).read_text())


def _snapshot():
    cs = parse_polymarket_markets(_load("polymarket_markets.json")) + parse_kalshi_events(_load("kalshi_events.json"))
    return Snapshot(cs, _load("odds_api_h2h.json"), _load("mapping.json"))


def C(venue, id, bid, ask, title="q", outcome="Yes", **kw):
    return Contract(venue, id, title, outcome, bid, ask, close_time=kw.pop("close_time", END), **kw)


# ------------------------------------------------------------------ parsing

def test_parse_polymarket():
    cs = {c.id: c for c in parse_polymarket_markets(_load("polymarket_markets.json"))}
    assert "0xold" not in cs  # closed
    fed = cs["0xfed1"]
    assert fed.outcome == "No change" and fed.group == "0xnegfed" and fed.no_ask == pytest.approx(0.45)
    game = cs["0xtbdet"]
    assert game.outcome == "Buccaneers" and game.no_label == "Lions" and game.no_is_named_outcome
    assert game.group is None


def test_parse_kalshi_dollars_and_legacy_cents():
    cs = {c.id: c for c in parse_kalshi_events(_load("kalshi_events.json"))}
    assert not any(k.startswith("KXMVE") for k in cs)  # combos skipped
    tb = cs["KXNFLGAME-26OCT11TBDET-TB"]
    assert tb.yes_ask == pytest.approx(0.30) and tb.group == "KXNFLGAME-26OCT11TBDET"
    assert not tb.no_is_named_outcome  # Kalshi NO on Tampa Bay is NOT "Detroit"
    legacy = parse_kalshi_events([{"event_ticker": "E", "markets": [
        {"ticker": "T", "title": "t", "status": "active", "yes_bid": 40, "yes_ask": 42}]}])
    assert legacy[0].yes_ask == pytest.approx(0.42) and legacy[0].yes_bid == pytest.approx(0.40)


# ------------------------------------------------------------------ fees

def test_kalshi_fee():
    f = FeeModel(assumed_contracts=100)
    assert f.per_contract("kalshi", 0.5) == pytest.approx(0.0175)  # 0.07*.25 = 1.75c
    assert f.per_contract("polymarket", 0.5) == 0


# ------------------------------------------------------------------ strategies

def test_multi_outcome_yes_arb_flagged_unless_exhaustive():
    cs = [C("polymarket", f"m{i}", a - 0.01, a, group="g") for i, a in enumerate((0.5, 0.3, 0.15))]
    (o,) = multi_outcome_arbs(cs, FeeModel(), ScanConfig(), NOW)
    assert o.edge == pytest.approx(0.05) and o.confidence == "needs-verification"
    for c in cs:
        c.exhaustive = True
    assert multi_outcome_arbs(cs, FeeModel(), ScanConfig(), NOW)[0].confidence == "arb"


def test_multi_outcome_no_arb_and_fees_kill_thin_ones():
    # YES bids sum to 1.10 -> NO asks cost 1.90 for a guaranteed payout of n - 1 = 2.
    cs = [C("polymarket", f"m{i}", b, b + 0.01, group="g") for i, b in enumerate((0.5, 0.35, 0.25))]
    (o,) = multi_outcome_arbs(cs, FeeModel(), ScanConfig(), NOW)
    assert o.legs[0].side == "NO" and o.edge == pytest.approx(0.10)
    # Bundled Kalshi Oscar event: bids sum 1.03 but 7% fees eat the edge.
    k = [c for c in parse_kalshi_events(_load("kalshi_events.json")) if c.group == "KXOSCARPIC-27"]
    assert multi_outcome_arbs(k, FeeModel(), ScanConfig(), NOW) == []


def test_cross_venue_arb_and_inverted_pairs():
    a, b = C("polymarket", "p", 0.30, 0.31), C("kalshi", "k", 0.36, 0.37)
    (o,) = cross_venue([Pair(a, b, 1.0, confirmed=True)], FeeModel(), ScanConfig(), NOW)
    assert [l.side for l in o.legs] == ["YES", "NO"] and o.confidence == "arb"
    assert o.edge == pytest.approx(1 - 0.31 - 0.64 - FeeModel().per_contract("kalshi", 0.64))
    # Inverted: kalshi YES == polymarket NO, so buy YES on both.
    b2 = C("kalshi", "k2", 0.62, 0.63)
    (o2,) = cross_venue([Pair(a, b2, 1.0, confirmed=True, inverted=True)], FeeModel(), ScanConfig(), NOW)
    assert [l.side for l in o2.legs] == ["YES", "YES"]


def test_cross_venue_soft_value():
    a, b = C("polymarket", "p", 0.40, 0.41), C("kalshi", "k", 0.42, 0.47)  # .41 + .58 + fee > 1: no lock
    opps = cross_venue([Pair(a, b, 0.9)], FeeModel(), ScanConfig(min_value_edge=0.02), NOW)
    assert [o.kind for o in opps] == ["cross_venue_value"]
    assert opps[0].fair == pytest.approx(0.445) and opps[0].confidence == "needs-verification"


def test_sportsbook_value_only_matches_the_right_game():
    odds = _load("odds_api_h2h.json")
    game = C("polymarket", "g", 0.26, 0.27, title="Buccaneers vs. Lions", outcome="Buccaneers",
             no_label="Lions", no_is_named_outcome=True, close_time=datetime(2026, 10, 11, 17, tzinfo=timezone.utc))
    futures = C("polymarket", "sb", 0.01, 0.02, title="Will the Buccaneers win the Super Bowl?",
                outcome="Buccaneers", close_time=datetime(2027, 2, 8, tzinfo=timezone.utc))
    opps = sportsbook_value([game, futures], odds, FeeModel(), ScanConfig(), NOW)
    assert len(opps) == 1 and opps[0].legs[0].contract.id == "g"
    assert opps[0].fair == pytest.approx(0.30, abs=0.01)
    assert sportsbook_value([game], odds, FeeModel(), ScanConfig(),
                            datetime(2026, 10, 11, 18, tzinfo=timezone.utc)) == []  # started


# ------------------------------------------------------------------ matching

def test_team_matching_is_whole_word():
    assert team_matches("Buccaneers", "Tampa Bay Buccaneers")
    assert team_matches("Tampa Bay", "Tampa Bay Buccaneers")
    assert not team_matches("LA", "Atlanta Falcons")
    assert not team_matches("Yes", "Detroit Lions")


def test_fuzzy_matching_respects_numbers():
    assert "150000" in tokens("Will BTC hit $150k?")
    p150 = C("polymarket", "a", .3, .31, "Will Bitcoin reach $150,000 by December 31, 2026?")
    k200 = C("kalshi", "b", .1, .11, "Will Bitcoin reach $200,000 by Dec 31, 2026?")
    k150 = C("kalshi", "c", .36, .37, "Will Bitcoin reach $150,000 by Dec 31, 2026?")
    pairs = match_cross_venue([p150, k200, k150])
    assert [(p.a.id, p.b.id) for p in pairs] == [("a", "c")]
    assert not pairs[0].confirmed


def test_executable_units():
    assert executable_units([(0.31, 100), (0.32, 50), (0.35, 999)], 0.32) == 150


# ------------------------------------------------------------------ end to end

def test_offline_scan_finds_planted_opportunities():
    opps = scan(_snapshot(), now=NOW)
    kinds = {(o.kind, o.confidence) for o in opps}
    assert ("cross_venue_arb", "arb") in kinds  # confirmed BTC 150k pair
    assert ("cross_venue_arb", "needs-verification") in kinds  # fuzzy BTC 200k pair
    assert ("multi_outcome_arb", "needs-verification") in kinds  # Fed set
    assert ("sportsbook_value", "model") in kinds  # Bucs on Polymarket
    assert opps[0].confidence == "arb"
    # Never recommends buying "NO Detroit" on Kalshi as if it were the Bucs.
    assert not any(l.contract.venue == "kalshi" and l.side == "NO"
                   for o in opps if o.kind == "sportsbook_value" for l in o.legs)


def test_polymarket_paging_survives_server_page_cap(monkeypatch):
    from polymm.scan import sources

    allm = [{"id": str(i)} for i in range(250)]
    calls = []

    def fake_get(url, params=None, **kw):
        calls.append(params)
        o = params["offset"]
        return allm[o:o + 100]  # server caps at 100 regardless of limit

    monkeypatch.setattr(sources, "_get", fake_get)
    assert len(sources.fetch_polymarket()) == 250


def test_plain_english_explanations():
    from polymm.scan.scanner import explain, to_json

    opps = scan(_snapshot(), now=NOW)
    for o in opps:
        e = explain(o)
        assert e["headline"] and e["summary"] and len(e["steps"]) == len(o.legs)
        assert to_json(o)["legs"][0]["market"]
    lock = next(o for o in opps if o.confidence == "arb")
    assert "Locked profit" in explain(lock)["headline"]
    fuzzy = next(o for o in opps if o.kind == "cross_venue_arb" and o.confidence != "arb")
    assert explain(fuzzy)["summary"].startswith("IF both markets")


def test_app_serves_page_and_blocks_cross_site_scans():
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    from polymm.scan.__main__ import build_parser
    from polymm.scan.app import App, make_handler

    args = build_parser().parse_args(["--offline"])
    args.interval, args.webhook = 300, None
    app = App(args)
    app.scan_once()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        assert b"Market Scanner" in urllib.request.urlopen(base + "/").read()
        state = json.load(urllib.request.urlopen(base + "/api/state"))
        assert len(state["opportunities"]) == 4 and state["opportunities"][0]["headline"]
        req = urllib.request.Request(base + "/api/scan", method="POST", headers={"Origin": "https://evil.example"})
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        assert e.value.code == 403
    finally:
        srv.shutdown()


# ------------------------------------------------------------------ resolved / stale markets

def _weather_event(brackets, close="2026-10-09T04:59:00Z", expire="2026-10-09T14:00:00Z", ticker="KXHIGHNY-26OCT08"):
    def px(v):
        return None if v is None else f"{v:.4f}"
    return {"event_ticker": ticker, "series_ticker": "KXHIGHNY", "mutually_exclusive": True,
            "title": "Highest temperature in NYC today?",
            "markets": [{"ticker": f"{ticker}-{i}", "title": "High temp in NYC?", "yes_sub_title": name,
                         "status": "active", "yes_bid_dollars": px(b), "yes_ask_dollars": px(a),
                         "close_time": close, "expected_expiration_time": expire}
                        for i, (name, b, a) in enumerate(brackets)]}


def test_bracket_with_no_sellers_does_not_shrink_the_set():
    # Asks on the priced brackets sum to 96c, but the last bracket has no offer at
    # all. That is NOT a complete set for 96c.
    ev = _weather_event([("<66", .01, .02), ("66-67", .02, .03), ("68-69", .30, .32),
                         ("70-71", .45, .47), ("72-73", .10, .12), (">=74", None, None)])
    cs = parse_kalshi_events([ev])
    assert len(cs) == 6
    assert multi_outcome_arbs(cs, FeeModel(), ScanConfig(), NOW) == []


def test_already_decided_weather_is_hidden_by_default():
    # Afternoon: the high is known. Winner bids 97c, stale 2c bids linger on dead
    # brackets, so "buy every NO" looks like a lock.
    ev = _weather_event([("<66", .02, .03), ("66-67", .02, .03), ("68-69", .97, .99),
                         ("70-71", .02, .03), ("72-73", .02, .03)])
    cs = parse_kalshi_events([ev])
    assert multi_outcome_arbs(cs, FeeModel(), ScanConfig(), NOW) == []
    shown = multi_outcome_arbs(cs, FeeModel(), ScanConfig(include_decided=True), NOW)
    assert shown and shown[0].legs[0].side == "NO"
    from polymm.scan.strategies import decided_groups
    assert decided_groups(cs, ScanConfig()) == 1


def test_market_whose_trading_closed_is_dropped_even_if_not_yet_settled():
    # Yesterday's event: trading closed, settlement pending tomorrow.
    ev = _weather_event([("a", .30, .31), ("b", .30, .31), ("c", .30, .31)],
                        close="2026-10-08T04:59:00Z", expire="2026-10-08T23:00:00Z", ticker="KXHIGHNY-26OCT07")
    snap = Snapshot(parse_kalshi_events([ev]))
    assert all(not c.tradable(NOW) for c in snap.contracts)
    assert scan(snap, now=NOW) == []


def test_polymarket_halted_or_resolving_markets_skipped():
    base = {"question": "q", "outcomes": '["Yes","No"]', "bestBid": 0.5, "bestAsk": 0.51,
            "endDate": "2026-12-01T00:00:00Z", "active": True, "closed": False}
    assert len(parse_polymarket_markets([{**base, "conditionId": "ok"}])) == 1
    assert parse_polymarket_markets([{**base, "conditionId": "x", "acceptingOrders": False}]) == []
    assert parse_polymarket_markets([{**base, "conditionId": "y", "umaResolutionStatus": "proposed"}]) == []
    no_ask = parse_polymarket_markets([{**base, "conditionId": "z", "bestAsk": 1.0}])
    assert no_ask[0].yes_ask is None and not no_ask[0].indicative


def test_unconfirmed_pair_far_apart_is_not_the_same_question():
    a, b = C("polymarket", "p", 0.05, 0.06), C("kalshi", "k", 0.60, 0.62)
    assert cross_venue([Pair(a, b, 0.7)], FeeModel(), ScanConfig(), NOW) == []
