"""Monte Carlo simulator: does the protection actually pay for itself?

World: a 2-leg parlay (Bucs ML x Irving over) with a drifting true probability
and one news shock (injury) mid-session. Six books track the truth with
different lags (sharp books first, rec books last) plus their own bias and vig.
Traders:
  - noise traders: random side, small size, trade at our price
  - informed traders: see the truth instantly, sweep any quote that's wrong

Two market makers run the same world:
  - naive:      equal-weight average, tight spread, no guards / toxicity
  - protected:  the default config in this repo
Reported P&L is the expected value at the final true probability (much lower
variance than drawing one outcome per trial).

    python -m polymm.sim --trials 50
"""

from __future__ import annotations

import argparse
import math
import random
import statistics
from dataclasses import dataclass

from .engine import MarketMaker, MMConfig, ParlayMarket
from .exchange import PaperExchange
from .fair_value import BookQuote, FairValueConfig
from .guards import GuardConfig
from .odds import expit, logit, prob_to_american
from .quoting import QuoteParams
from .risk import RiskLimits
from .toxicity import ToxicityConfig

# book -> how many seconds behind the truth its line is
BOOKS = {
    "pinnacle": 2.0, "circa": 3.0, "fanduel": 10.0,
    "draftkings": 15.0, "hardrock": 25.0, "betmgm": 30.0,
}
PARLAY_HOLD = {"draftkings": 0.14, "hardrock": 0.04}
VIG = 0.045


def naive_config() -> MMConfig:
    return MMConfig(
        fair=FairValueConfig(book_weights={}, default_weight=1.0, recency_half_life=1e9,
                             max_quote_age=1e9, outlier_k=1e9, sigma_floor_logit=0.0),
        quote=QuoteParams(base_half_spread=0.005, uncertainty_mult=0.0, min_edge=0.003,
                          max_skew=0.0, toxicity_widen=0.0, anchor_ask_to_books=False),
        risk=RiskLimits(max_order_shares=500, max_position_shares=1e9, max_market_loss=1e9,
                        max_portfolio_loss=1e9, max_leg_exposure=1e9, max_cvar=1e9,
                        max_daily_loss=1e9),
        guards=GuardConfig(max_feed_silence=1e9, jump_threshold_logit=1e9,
                           max_dispersion_logit=1e9, pull_on_sharp_divergence=False),
        toxicity=ToxicityConfig(burst_fills=10**9, adverse_scale=1e9),
    )


@dataclass
class TrialResult:
    expected_pnl: float
    volume: float
    final_position: float
    pulled_seconds: int


def _two_way(p: float, bias: float) -> tuple[float, float]:
    p = expit(logit(p) + bias)
    # spread the vig proportionally and round to whole American odds
    a = prob_to_american(min(p * (1 + VIG / 2), 0.99))
    b = prob_to_american(min((1 - p) * (1 + VIG / 2), 0.99))
    return (round(a), round(b))


def run_trial(cfg: MMConfig, seed: int, T: int = 1200, news_at: int = 600,
              informed_rate: float = 0.25, noise_rate: float = 0.08) -> TrialResult:
    rng = random.Random(seed)
    legs = ("bucs_ml", "irving_over")
    xs = {"bucs_ml": logit(0.32), "irving_over": logit(0.34)}
    bias = {(b, l): rng.gauss(0, 0.04) for b in BOOKS for l in legs}
    news_leg = rng.choice(legs)
    news_shift = rng.choice((-1, 1)) * 0.6

    ex = PaperExchange()
    mm = MarketMaker(ex, [ParlayMarket("bucs_irving", legs, "Bucs ML + Irving o24.5")], cfg)
    clock = {"now": 0.0}
    ex.on_fill = lambda m, s, p, q, cp: mm.on_fill(m, s, p, q, clock["now"], cp)

    history: list[dict[str, float]] = []
    volume, pulled = 0.0, 0
    for t in range(T):
        clock["now"] = float(t)
        for l in legs:
            xs[l] += rng.gauss(0, 0.004)
        if t == news_at:
            xs[news_leg] += news_shift
        history.append({l: expit(x) for l, x in xs.items()})
        truth = math.prod(history[-1].values())

        # Each book reprices every 5s on a lagged view of the truth.
        batch = []
        for i, (b, lag) in enumerate(BOOKS.items()):
            if (t + i) % 5:
                continue
            seen = history[max(0, t - int(lag))]
            for l in legs:
                batch.append(BookQuote(b, l, _two_way(seen[l], bias[(b, l)]), float(t)))
            if b in PARLAY_HOLD:
                p_seen = math.prod(seen.values()) * (1 + PARLAY_HOLD[b])
                mm.parlay_prices.setdefault("bucs_irving", {})[b] = prob_to_american(p_seen)
        if batch:
            mm.on_book_quotes(batch, float(t))
        mm.on_timer(float(t))
        if "bucs_irving" not in mm.quotes:
            pulled += 1

        # Informed flow: sweep anything mispriced vs the truth.
        if rng.random() < informed_rate:
            ask, bid = ex.best("bucs_irving", "SELL"), ex.best("bucs_irving", "BUY")
            if ask and ask.price < truth - 0.002:
                volume += ex.take("bucs_irving", "BUY", 500, ask.price, "sharp_bot")
            elif bid and bid.price > truth + 0.002:
                volume += ex.take("bucs_irving", "SELL", 500, bid.price, "sharp_bot")
        # Noise flow.
        if rng.random() < noise_rate:
            side = rng.choice(("BUY", "SELL"))
            limit = 1.0 if side == "BUY" else 0.0
            volume += ex.take("bucs_irving", side, rng.uniform(10, 100), limit, f"retail{rng.randrange(50)}")

    final_truth = math.prod(history[-1].values())
    pos = mm.portfolio.positions["bucs_irving"]
    return TrialResult(pos.cash + pos.yes_shares * final_truth, volume, pos.yes_shares, pulled)


def summarize(name: str, rs: list[TrialResult]) -> str:
    pnl = sorted(r.expected_pnl for r in rs)
    p5 = pnl[max(0, int(0.05 * len(pnl)) - 1)]
    return (f"{name:>10}: mean EV P&L {statistics.mean(pnl):+8.2f}  "
            f"median {statistics.median(pnl):+8.2f}  5th pct {p5:+8.2f}  "
            f"volume {statistics.mean(r.volume for r in rs):7.0f} sh  "
            f"time pulled {statistics.mean(r.pulled_seconds for r in rs):5.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trials", type=int, default=40)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    seeds = [args.seed * 10_000 + i for i in range(args.trials)]
    print(summarize("naive", [run_trial(naive_config(), s) for s in seeds]))
    print(summarize("protected", [run_trial(MMConfig(), s) for s in seeds]))


if __name__ == "__main__":
    main()
