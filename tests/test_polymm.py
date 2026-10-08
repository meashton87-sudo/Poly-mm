import math
import random

import pytest

from polymm.engine import MarketMaker, MMConfig, ParlayMarket
from polymm.exchange import PaperExchange
from polymm.fair_value import BookQuote, FairEstimate, FairValueConfig, best_book_parlay_prob, estimate_leg
from polymm.feeds import LegSelector, parse_odds_api_event
from polymm.guards import GuardConfig, Guards
from polymm.odds import DevigMethod, american_to_prob, devig, devig_american, prob_to_american
from polymm.parlay import bivariate_normal_cdf, joint_prob, parlay_fair, sample_outcomes
from polymm.quoting import QuoteParams, make_quote
from polymm.risk import MarketDef, Portfolio, RiskEngine, RiskLimits
from polymm.toxicity import Fill, ToxicityTracker


# ---------------------------------------------------------------- odds

def test_american_conversions():
    assert american_to_prob(+700) == pytest.approx(0.125)
    assert american_to_prob(-110) == pytest.approx(110 / 210)
    for a in (-500, -110, +100, +150, +799):
        assert prob_to_american(american_to_prob(a)) == pytest.approx(a)


@pytest.mark.parametrize("method", list(DevigMethod))
def test_devig_sums_to_one_and_removes_vig(method):
    p = devig_american([-110, -110], method)
    assert sum(p) == pytest.approx(1)
    assert p[0] == pytest.approx(0.5)
    fav, dog = devig_american([-300, +250], method)
    assert fav + dog == pytest.approx(1)
    assert fav < american_to_prob(-300) and dog < american_to_prob(+250)


def test_shin_and_power_shade_longshots_more_than_multiplicative():
    q = [american_to_prob(-1000), american_to_prob(+650)]
    mult = devig(q, DevigMethod.MULTIPLICATIVE)[1]
    assert devig(q, DevigMethod.SHIN)[1] < mult
    assert devig(q, DevigMethod.POWER)[1] < mult


# ---------------------------------------------------------------- fair value

def _quotes(leg, lines, ts=0.0):
    return [BookQuote(b, leg, px, ts) for b, px in lines.items()]


def test_estimate_weights_and_rejects_outlier():
    lines = {"pinnacle": (+215, -238), "circa": (+212, -240), "fanduel": (+220, -270),
             "draftkings": (+210, -258), "betmgm": (+500, -800)}  # mgm is stale garbage
    est = estimate_leg("x", _quotes("x", lines), 1.0, FairValueConfig())
    assert est.ok and "betmgm" in est.rejected
    assert 0.29 < est.p < 0.32
    assert not est.sharp_divergence


def test_sharp_book_outlier_is_flagged_as_news():
    lines = {"pinnacle": (+400, -500), "fanduel": (+220, -270), "draftkings": (+210, -258),
             "betmgm": (+215, -260), "caesars": (+218, -265)}
    est = estimate_leg("x", _quotes("x", lines), 1.0, FairValueConfig())
    assert est.sharp_divergence and "pinnacle" in est.rejected


def test_stale_quotes_ignored():
    cfg = FairValueConfig(max_quote_age=30)
    qs = _quotes("x", {"pinnacle": (+215, -238), "circa": (+212, -240)}, ts=0.0)
    assert estimate_leg("x", qs, 10.0, cfg).ok
    assert not estimate_leg("x", qs, 31.0, cfg).ok


def test_best_book_parlay_prob():
    assert best_book_parlay_prob([+700, +799]) == pytest.approx(1 / 8.99)
    assert best_book_parlay_prob([]) is None


# ---------------------------------------------------------------- parlay

def _est(leg, p, sigma=0.05):
    return FairEstimate(leg, p, sigma, 5, [], [], 0.0)


def test_independent_parlay_is_product():
    pf = parlay_fair([_est("a", 0.3), _est("b", 0.35)])
    assert pf.p == pytest.approx(0.105)
    assert pf.sigma_prob > 0


def test_bivariate_cdf_matches_monte_carlo():
    p = joint_prob(["a", "b"], [0.4, 0.3], {("a", "b"): 0.5})
    hits = sum(all(o) for o in sample_outcomes(["a", "b"], [0.4, 0.3], {("a", "b"): 0.5}, 100_000))
    assert p == pytest.approx(hits / 100_000, abs=0.005)
    assert p > 0.12  # positive correlation raises the joint above the product
    assert bivariate_normal_cdf(0, 0, 0.0) == pytest.approx(0.25)
    assert bivariate_normal_cdf(0, 0, 0.5) == pytest.approx(1 / 3, abs=1e-6)  # 1/4 + asin(.5)/2pi


def test_correlation_adds_uncertainty():
    legs = [_est("a", 0.5), _est("b", 0.5)]
    assert parlay_fair(legs, {("a", "b"): 0.3}).sigma_prob > parlay_fair(legs).sigma_prob


# ---------------------------------------------------------------- quoting

def test_quote_brackets_fair_and_respects_book_bound():
    q = make_quote(0.107, 0.004, QuoteParams(), best_book_prob=american_to_prob(+799))
    assert q.bid < 0.107 - 0.003 < 0.107 + 0.003 <= q.ask
    assert q.bid < american_to_prob(+799)


def test_bid_never_at_or_above_book_parlay_price():
    q = make_quote(0.105, 0.0, QuoteParams(min_edge=0.001, base_half_spread=0.0),
                   best_book_prob=0.106)
    assert q.bid <= 0.096


def test_anchor_ask_does_not_give_away_edge():
    p = QuoteParams(base_half_spread=0.0, uncertainty_mult=0, tick=0.001)
    q = make_quote(0.100, 0.0, p, best_book_prob=0.125)
    assert q.ask == pytest.approx(0.120)  # just beats the book, not fair + tiny edge


def test_inventory_skews_and_shrinks():
    p = QuoteParams(tick=0.001)
    flat = make_quote(0.3, 0.005, p)
    long = make_quote(0.3, 0.005, p, inventory=800, max_inventory=1000)
    assert long.ask < flat.ask and long.bid <= flat.bid
    assert long.bid_size < flat.bid_size


def test_toxicity_widens_and_shrinks():
    p = QuoteParams(tick=0.001)
    calm, toxic = make_quote(0.3, 0.005, p), make_quote(0.3, 0.005, p, toxicity=1.0)
    assert toxic.ask - toxic.bid > calm.ask - calm.bid
    assert toxic.ask_size < calm.ask_size


def test_risk_cap_removes_side():
    q = make_quote(0.3, 0.005, QuoteParams(), max_ask_size=0)
    assert q.ask is None and q.bid is not None


# ---------------------------------------------------------------- risk

def _two_parlays_sharing_bucs():
    pf = Portfolio()
    pf.add_market(MarketDef("bucs_irving", ("bucs", "irving")))
    pf.add_market(MarketDef("bucs_lakers", ("bucs", "lakers")))
    return pf


def test_worst_case_of_short_parlay():
    pf = _two_parlays_sharing_bucs()
    pf.positions["bucs_irving"].apply_fill("SELL", 0.12, 1000)
    rep = RiskEngine(pf, RiskLimits()).report()
    assert rep["worst_case_loss"] == pytest.approx(880)


def test_shared_leg_limits_size_across_markets():
    pf = _two_parlays_sharing_bucs()
    lim = RiskLimits(max_order_shares=10_000, max_position_shares=10_000, max_market_loss=1e9,
                     max_portfolio_loss=1000, max_leg_exposure=1e9, max_cvar=1e9)
    risk = RiskEngine(pf, lim)
    pf.positions["bucs_irving"].apply_fill("SELL", 0.12, 1000)  # 880 at risk if Bucs+Irving hit
    # Selling Bucs+Lakers too: worst case is all three hitting -> both lose.
    size = risk.max_order_size("bucs_lakers", "SELL", 0.12)
    assert size == math.floor(120 / 0.88)
    # Buying it instead *hedges* the shared scenario, so it's allowed up to the order cap.
    assert risk.max_order_size("bucs_lakers", "BUY", 0.12) > size


def test_leg_exposure_and_cvar_limits():
    pf = _two_parlays_sharing_bucs()
    probs = {"bucs": 0.3, "irving": 0.35, "lakers": 0.5}
    loose = RiskLimits(max_order_shares=10_000, max_position_shares=10_000, max_market_loss=1e9,
                       max_portfolio_loss=1e9, max_cvar=1e9, max_leg_exposure=1e9)
    unlimited = RiskEngine(pf, loose).max_order_size("bucs_irving", "SELL", 0.12, probs)
    loose.max_leg_exposure = 200
    capped = RiskEngine(pf, loose).max_order_size("bucs_irving", "SELL", 0.12, probs)
    assert 0 < capped < unlimited
    pf.positions["bucs_irving"].apply_fill("SELL", 0.12, capped)
    exp = RiskEngine(pf, loose).report(probs)["leg_exposure"]
    assert max(abs(v) for v in exp.values()) <= 200 + 1


def test_kill_switch():
    pf = _two_parlays_sharing_bucs()
    pf.positions["bucs_irving"].apply_fill("SELL", 0.10, 1000)
    risk = RiskEngine(pf, RiskLimits(max_daily_loss=100))
    assert risk.check_kill({"bucs_irving": 0.25})
    assert risk.max_order_size("bucs_irving", "BUY", 0.2) == 0


# ---------------------------------------------------------------- toxicity / guards

def test_markouts_and_bursts():
    tox = ToxicityTracker()
    for i in range(3):
        burst = tox.on_fill(Fill(float(i), "m", "SELL", 0.10, 100, 0.10, "sharp"))
    assert burst and tox.side_blocked("m", "SELL", 3.0)
    assert not tox.side_blocked("m", "BUY", 3.0)
    tox.on_time(100.0, {"m": 0.13})  # fair rose 3c after we sold: adverse
    assert tox.score("m") > 0.5
    assert tox.counterparties["sharp"].avg_markout < 0


def test_guards():
    g = Guards(GuardConfig(max_feed_silence=10, jump_threshold_logit=0.2))
    est = _est("a", 0.30)
    g.on_feed_update("a", 0.0)
    g.on_estimate(est, 0.0)
    assert g.leg_problems("a", est, 5.0) == []
    assert "stale feed" in g.leg_problems("a", est, 11.0)
    g.on_feed_update("a", 12.0)
    g.on_estimate(_est("a", 0.40), 12.0)
    assert "fair value jump" in g.leg_problems("a", est, 13.0)
    g.on_news("b", 0.0)
    g.on_feed_update("b", 1.0)
    assert any("news" in p for p in g.leg_problems("b", est, 1.0))


# ---------------------------------------------------------------- engine

LINES = {
    "bucs": {"pinnacle": (+215, -238), "circa": (+210, -240), "fanduel": (+220, -270),
             "draftkings": (+210, -258)},
    "irving": {"pinnacle": (+172, -190), "circa": (+170, -195), "fanduel": (+175, -215),
               "draftkings": (+165, -200)},
}


def _mm(cfg=None):
    ex = PaperExchange()
    mm = MarketMaker(ex, [ParlayMarket("bi", ("bucs", "irving"))], cfg)
    clock = [0.0]
    ex.on_fill = lambda m, s, p, q, cp: mm.on_fill(m, s, p, q, clock[0], cp)
    mm.on_book_quotes([BookQuote(b, l, px, 0.0) for l, bs in LINES.items() for b, px in bs.items()], 0.0)
    return mm, ex, clock


def test_engine_quotes_and_fills():
    mm, ex, _ = _mm()
    q = mm.quotes["bi"]
    assert q.bid < mm.fairs["bi"].p < q.ask
    assert ex.best("bi", "BUY").price == q.bid and ex.best("bi", "SELL").price == q.ask
    ex.take("bi", "BUY", 50, 1.0, "retail")
    pos = mm.portfolio.positions["bi"]
    assert pos.yes_shares == -50 and pos.cash == pytest.approx(50 * q.ask)
    assert mm.quotes["bi"].ask_size <= q.ask_size  # short now: offer less


def test_engine_pulls_on_news_and_staleness():
    mm, ex, _ = _mm()
    mm.on_news("bucs", 1.0, "QB injury")
    assert "bi" not in mm.quotes and not ex.orders
    mm2, ex2, _ = _mm()
    mm2.on_timer(1000.0)
    assert "bi" not in mm2.quotes and not ex2.orders


def test_engine_pulls_when_book_offers_better_than_fair():
    mm, ex, _ = _mm()
    mm.on_parlay_price("bi", "hardrock", +1200, 1.0)
    assert "bi" not in mm.quotes and not ex.orders


def test_engine_burst_pulls_side():
    mm, ex, clock = _mm()
    for t in range(3):
        clock[0] = float(t)
        ex.take("bi", "BUY", 10, 1.0, "bot")
    assert ex.best("bi", "SELL") is None and ex.best("bi", "BUY") is not None


# ---------------------------------------------------------------- feeds

def test_parse_odds_api():
    event = {"bookmakers": [
        {"key": "draftkings", "last_update": "2026-10-08T17:00:00Z", "markets": [
            {"key": "h2h", "outcomes": [{"name": "Tampa Bay Buccaneers", "price": 210},
                                         {"name": "Detroit Lions", "price": -258}]},
            {"key": "player_points", "outcomes": [
                {"name": "Over", "description": "Kyrie Irving", "price": 165, "point": 24.5},
                {"name": "Under", "description": "Kyrie Irving", "price": -200, "point": 24.5},
                {"name": "Over", "description": "Luka Doncic", "price": -110, "point": 30.5}]}]}]}
    ml = parse_odds_api_event(event, LegSelector("bucs", "h2h", "Tampa Bay Buccaneers"), 2e9)
    assert ml[0].prices == (210, -258)
    pts = parse_odds_api_event(event, LegSelector("irv", "player_points", "Over", "Kyrie Irving", 24.5), 2e9)
    assert pts[0].prices == (165, -200) and pts[0].book == "draftkings"


# ---------------------------------------------------------------- sim smoke

def test_protected_beats_naive_in_sim():
    from polymm.sim import naive_config, run_trial
    seeds = range(4)
    naive = sum(run_trial(naive_config(), s, T=800, news_at=400).expected_pnl for s in seeds)
    prot = sum(run_trial(MMConfig(), s, T=800, news_at=400).expected_pnl for s in seeds)
    assert prot > naive
