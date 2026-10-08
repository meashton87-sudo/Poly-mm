"""Portfolio risk across parlay markets that share legs.

The danger in parlay market making is not one market, it's the same leg
sitting inside many markets: if you're short Bucs+Irving, Bucs+Mahomes and
Bucs+Lakers, you are really short "Bucs win" several times over. So risk is
computed on the joint distribution of *legs*, never per market in isolation.

All checks are scenario-based: enumerate every combination of leg outcomes
(exact for <= max_exact_legs legs), compute portfolio P&L in each, then:
  - worst-case loss          (hard limit, no probabilities involved)
  - CVaR at alpha            (probability weighted tail, uses fair values + correlation)
  - per-leg exposure         E[PnL | leg misses] - E[PnL | leg hits]
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .parlay import Pair, sample_outcomes


@dataclass
class RiskLimits:
    max_order_shares: float = 500.0
    max_position_shares: float = 2000.0  # |net YES| per market
    max_market_loss: float = 500.0  # worst-case $ loss in any single market
    max_portfolio_loss: float = 1500.0  # worst-case $ loss across everything
    max_leg_exposure: float = 1000.0  # $ swing on any single leg outcome
    max_cvar: float = 800.0  # expected loss in worst (1-alpha) tail
    cvar_alpha: float = 0.95
    max_daily_loss: float = 750.0  # realised + marked; trips the kill switch
    max_exact_legs: int = 14
    mc_samples: int = 20_000


@dataclass
class Position:
    yes_shares: float = 0.0
    cash: float = 0.0  # net cash flow; P&L at resolution = cash + yes_shares * 1{win}

    def apply_fill(self, side: str, price: float, size: float) -> None:
        if side == "BUY":
            self.yes_shares += size
            self.cash -= price * size
        else:
            self.yes_shares -= size
            self.cash += price * size


@dataclass
class MarketDef:
    market_id: str
    legs: tuple[str, ...]  # market resolves YES iff all legs hit


@dataclass
class Portfolio:
    markets: dict[str, MarketDef] = field(default_factory=dict)
    positions: dict[str, Position] = field(default_factory=dict)
    realized_pnl: float = 0.0

    def add_market(self, m: MarketDef) -> None:
        self.markets[m.market_id] = m
        self.positions.setdefault(m.market_id, Position())

    def leg_ids(self) -> list[str]:
        return sorted({l for m in self.markets.values() for l in m.legs})

    def mark_to_fair(self, fairs: Mapping[str, float]) -> float:
        return sum(p.cash + p.yes_shares * fairs.get(mid, 0.0) for mid, p in self.positions.items())


class RiskEngine:
    def __init__(self, portfolio: Portfolio, limits: RiskLimits):
        self.pf = portfolio
        self.limits = limits
        self.killed = False
        self.kill_reason = ""

    # ----- scenario machinery -------------------------------------------------

    def _scenarios(
        self, leg_probs: Mapping[str, float] | None, corr: Mapping[Pair, float] | None
    ) -> tuple[list[str], list[tuple[bool, ...]], list[float]]:
        legs = self.pf.leg_ids()
        corr = corr or {}
        has_corr = any(corr.get((a, b), 0) for a in legs for b in legs if a < b)
        if len(legs) <= self.limits.max_exact_legs and not has_corr:
            outs = list(itertools.product((True, False), repeat=len(legs)))
            if leg_probs is None:
                return legs, outs, [1 / len(outs)] * len(outs)
            ps = [leg_probs[l] for l in legs]
            w = [math.prod(p if o else 1 - p for p, o in zip(ps, out)) for out in outs]
            return legs, outs, w
        if leg_probs is None:
            if len(legs) > self.limits.max_exact_legs:
                raise ValueError("too many legs for exact worst case; supply probabilities")
            outs = list(itertools.product((True, False), repeat=len(legs)))
            return legs, outs, [1 / len(outs)] * len(outs)
        samples = sample_outcomes(legs, [leg_probs[l] for l in legs], corr, self.limits.mc_samples)
        counts: dict[tuple[bool, ...], int] = {}
        for s in samples:
            counts[s] = counts.get(s, 0) + 1
        outs = list(counts)
        # Worst case must include every reachable outcome, not just sampled ones.
        if len(legs) <= self.limits.max_exact_legs:
            for o in itertools.product((True, False), repeat=len(legs)):
                counts.setdefault(o, 0)
            outs = list(counts)
        return legs, outs, [counts[o] / len(samples) for o in outs]

    def _wins(self, legs: list[str], outcome: tuple[bool, ...], market_id: str) -> bool:
        idx = {l: i for i, l in enumerate(legs)}
        return all(outcome[idx[l]] for l in self.pf.markets[market_id].legs)

    def _pnl_vectors(self, legs, outs) -> dict[str, list[float]]:
        return {
            mid: [pos.cash + pos.yes_shares * self._wins(legs, o, mid) for o in outs]
            for mid, pos in self.pf.positions.items()
        }

    # ----- reporting ----------------------------------------------------------

    def report(
        self, leg_probs: Mapping[str, float] | None = None, corr: Mapping[Pair, float] | None = None
    ) -> dict:
        legs, outs, w = self._scenarios(leg_probs, corr)
        per_mkt = self._pnl_vectors(legs, outs)
        total = [sum(v[i] for v in per_mkt.values()) for i in range(len(outs))]
        rep = {
            "worst_case_loss": max(0.0, -min(total)),
            "market_worst_loss": {m: max(0.0, -min(v)) for m, v in per_mkt.items()},
        }
        if leg_probs is not None:
            rep["expected_pnl"] = sum(p * x for p, x in zip(w, total))
            rep["cvar"] = _cvar(total, w, self.limits.cvar_alpha)
            rep["leg_exposure"] = {
                l: _leg_exposure(total, w, outs, i) for i, l in enumerate(legs)
            }
        return rep

    # ----- pre-trade ----------------------------------------------------------

    def max_order_size(
        self, market_id: str, side: str, price: float,
        leg_probs: Mapping[str, float] | None = None, corr: Mapping[Pair, float] | None = None,
    ) -> float:
        """Largest size we may add on `side` at `price` without breaching any limit."""
        if self.killed:
            return 0.0
        lim = self.limits
        pos = self.pf.positions[market_id]
        sgn = 1 if side == "BUY" else -1

        cap = lim.max_order_shares
        cap = min(cap, max(0.0, lim.max_position_shares - sgn * pos.yes_shares))
        if cap <= 0:
            return 0.0

        legs, outs, w = self._scenarios(leg_probs, corr)
        per_mkt = self._pnl_vectors(legs, outs)
        total = [sum(v[i] for v in per_mkt.values()) for i in range(len(outs))]
        mkt = per_mkt[market_id]
        # P&L change per share in each scenario (linear in size).
        d = [sgn * ((1.0 if self._wins(legs, o, market_id) else 0.0) - price) for o in outs]

        # Worst-case constraints are linear in size => solve exactly.
        for base, L in ((total, lim.max_portfolio_loss), (mkt, lim.max_market_loss)):
            for b, di in zip(base, d):
                if di < 0:
                    cap = min(cap, max(0.0, (b + L) / -di))

        if leg_probs is None or cap <= 0:
            return math.floor(cap)

        # Probability-weighted limits: bisection (monotone in practice).
        def ok(x: float) -> bool:
            t = [b + x * di for b, di in zip(total, d)]
            if _cvar(t, w, lim.cvar_alpha) > lim.max_cvar:
                return False
            return all(abs(_leg_exposure(t, w, outs, i)) <= lim.max_leg_exposure for i in range(len(legs)))

        if ok(cap):
            return math.floor(cap)
        if not ok(0.0):
            # Already over a soft limit: allow only risk-reducing flow.
            cur_cvar = _cvar(total, w, lim.cvar_alpha)
            t = [b + 1.0 * di for b, di in zip(total, d)]
            return math.floor(cap) if _cvar(t, w, lim.cvar_alpha) < cur_cvar else 0.0
        lo, hi = 0.0, cap
        for _ in range(25):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if ok(mid) else (lo, mid)
        return math.floor(lo)

    def check_kill(self, fairs: Mapping[str, float], start_equity: float = 0.0) -> bool:
        pnl = self.pf.realized_pnl + self.pf.mark_to_fair(fairs) - start_equity
        if pnl < -self.limits.max_daily_loss and not self.killed:
            self.killed, self.kill_reason = True, f"daily loss {pnl:.2f} breached limit"
        return self.killed


def _cvar(pnl: Sequence[float], w: Sequence[float], alpha: float) -> float:
    """Expected loss in the worst (1 - alpha) probability mass. Positive = loss."""
    tail = 1 - alpha
    acc, loss = 0.0, 0.0
    for x, p in sorted(zip(pnl, w)):
        if p <= 0:
            continue
        take = min(p, tail - acc)
        loss += -x * take
        acc += take
        if acc >= tail - 1e-15:
            break
    return loss / tail if acc > 0 else 0.0


def _leg_exposure(pnl, w, outs, i) -> float:
    """E[PnL | leg misses] - E[PnL | leg hits]: positive = we lose when it hits."""
    hit = [(x, p) for x, p, o in zip(pnl, w, outs) if o[i]]
    miss = [(x, p) for x, p, o in zip(pnl, w, outs) if not o[i]]
    ph, pm = sum(p for _, p in hit), sum(p for _, p in miss)
    if ph <= 0 or pm <= 0:
        return 0.0
    return sum(x * p for x, p in miss) / pm - sum(x * p for x, p in hit) / ph
