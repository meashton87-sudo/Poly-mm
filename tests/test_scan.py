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
