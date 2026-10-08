"""Odds conversion and de-vigging.

Every sportsbook price embeds a margin ("vig" / "hold"). Before you can average
books into a fair value you have to strip it out, otherwise your "fair" is
systematically too high on every side and you'll sell too cheap.
"""

from __future__ import annotations

import math
from enum import Enum
from typing import Sequence


def american_to_decimal(american: float) -> float:
    if american == 0 or -100 < american < 100:
        raise ValueError(f"invalid American odds: {american}")
    return 1 + (american / 100 if american > 0 else 100 / -american)


def decimal_to_american(decimal: float) -> float:
    if decimal <= 1:
        raise ValueError(f"invalid decimal odds: {decimal}")
    return (decimal - 1) * 100 if decimal >= 2 else -100 / (decimal - 1)


def american_to_prob(american: float) -> float:
    """Raw implied probability (still includes vig)."""
    return 1 / american_to_decimal(american)


def prob_to_american(p: float) -> float:
    if not 0 < p < 1:
        raise ValueError(f"probability must be in (0, 1): {p}")
    return decimal_to_american(1 / p)


def fmt_american(p: float) -> str:
    a = prob_to_american(p)
    return f"+{a:.0f}" if a > 0 else f"{a:.0f}"


def logit(p: float) -> float:
    return math.log(p / (1 - p))


def expit(x: float) -> float:
    if x >= 0:
        return 1 / (1 + math.exp(-x))
    e = math.exp(x)
    return e / (1 + e)


class DevigMethod(str, Enum):
    MULTIPLICATIVE = "multiplicative"  # proportional; simple, overprices longshots
    ADDITIVE = "additive"  # subtract equal margin from each side
    POWER = "power"  # p_i = q_i^k; handles favourite-longshot bias
    SHIN = "shin"  # models insider share z; standard for sharp-ish devig


def _bisect(f, lo: float, hi: float, tol: float = 1e-12, iters: int = 200) -> float:
    flo = f(lo)
    for _ in range(iters):
        mid = (lo + hi) / 2
        fm = f(mid)
        if abs(fm) < tol or hi - lo < tol:
            return mid
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return (lo + hi) / 2


def devig(implied: Sequence[float], method: DevigMethod = DevigMethod.SHIN) -> list[float]:
    """Convert raw implied probabilities of a complete set of outcomes into fair
    probabilities that sum to 1."""
    q = list(implied)
    if len(q) < 2 or any(not 0 < x < 1 for x in q):
        raise ValueError(f"need >=2 implied probabilities in (0,1): {q}")
    total = sum(q)
    if total <= 1:
        # No vig (or an arb/negative-hold line). Normalise and move on.
        return [x / total for x in q]

    if method == DevigMethod.MULTIPLICATIVE:
        return [x / total for x in q]

    if method == DevigMethod.ADDITIVE:
        m = (total - 1) / len(q)
        out = [x - m for x in q]
        if min(out) <= 0:  # additive breaks on deep longshots
            return devig(q, DevigMethod.MULTIPLICATIVE)
        return out

    if method == DevigMethod.POWER:
        k = _bisect(lambda k: sum(x**k for x in q) - 1, 1.0, 50.0)
        return [x**k for x in q]

    if method == DevigMethod.SHIN:

        def shin_probs(z: float) -> list[float]:
            return [
                (math.sqrt(z * z + 4 * (1 - z) * x * x / total) - z) / (2 * (1 - z))
                for x in q
            ]

        z = _bisect(lambda z: sum(shin_probs(z)) - 1, 0.0, 0.999)
        p = shin_probs(z)
        s = sum(p)
        return [x / s for x in p]

    raise ValueError(f"unknown devig method {method}")


def devig_american(prices: Sequence[float], method: DevigMethod = DevigMethod.SHIN) -> list[float]:
    return devig([american_to_prob(a) for a in prices], method)
