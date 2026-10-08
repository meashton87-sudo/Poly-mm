"""Leg-level fair value from multiple sportsbooks.

Pipeline per leg:
  1. drop stale quotes
  2. de-vig each book's two-way (or n-way) market
  3. reject outliers (robust, in logit space) -- but a *sharp* book being the
     outlier is treated as news, not noise
  4. weighted average in logit space (book sharpness x recency decay)
  5. uncertainty = cross-book dispersion / sqrt(effective n) + model-risk floor
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Iterable, Sequence

from .odds import DevigMethod, american_to_prob, devig, expit, logit


@dataclass(frozen=True)
class BookQuote:
    """One sportsbook's line on one leg.

    `prices` are American odds for every outcome of the market, with index 0
    being the side we care about (e.g. [Bucs ML, Opp ML] or [Over, Under]).
    """

    book: str
    leg_id: str
    prices: tuple[float, ...]
    ts: float

    def fair_prob(self, method: DevigMethod) -> float:
        return _devig_first(self.prices, method)


@lru_cache(maxsize=65536)
def _devig_first(prices: tuple[float, ...], method: DevigMethod) -> float:
    # Pure function of the line; books re-send identical lines constantly.
    return devig([american_to_prob(a) for a in prices], method)[0]


# Sharp books move first and carry the most information; recreational books
# lag and shade toward public sides. Tune these from your own closing-line data.
DEFAULT_BOOK_WEIGHTS: dict[str, float] = {
    "pinnacle": 3.0,
    "circa": 3.0,
    "bookmaker": 2.0,
    "betonline": 1.5,
    "fanduel": 1.2,
    "draftkings": 1.0,
    "betmgm": 0.8,
    "caesars": 0.8,
    "hardrock": 0.8,
    "espnbet": 0.7,
}


@dataclass
class FairValueConfig:
    devig_method: DevigMethod = DevigMethod.SHIN
    book_weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_BOOK_WEIGHTS))
    default_weight: float = 0.5
    max_quote_age: float = 60.0  # seconds; older quotes are ignored entirely
    recency_half_life: float = 20.0  # seconds; weight halves every half-life
    min_books: int = 2
    # Outlier rejection: drop books further than max(k * robust_sigma, floor) from median.
    outlier_k: float = 3.0
    outlier_floor_logit: float = 0.15
    # A book with weight >= this is "sharp": if it disagrees with the pack we
    # assume it has news and flag the estimate rather than discarding it.
    sharp_weight: float = 2.0
    # Model-risk floor on the logit standard error: even 10 books agreeing
    # doesn't make them right.
    sigma_floor_logit: float = 0.04


@dataclass
class FairEstimate:
    leg_id: str
    p: float
    sigma_logit: float
    n_books: int
    books_used: list[str]
    rejected: list[str]
    dispersion_logit: float
    ok: bool = True
    sharp_divergence: bool = False
    reason: str = ""

    @property
    def sigma_prob(self) -> float:
        return self.sigma_logit * self.p * (1 - self.p)


def _weight(book: str, cfg: FairValueConfig) -> float:
    return cfg.book_weights.get(book.lower(), cfg.default_weight)


def estimate_leg(
    leg_id: str, quotes: Iterable[BookQuote], now: float, cfg: FairValueConfig
) -> FairEstimate:
    fresh: list[tuple[BookQuote, float, float]] = []  # (quote, logit_p, weight)
    for q in quotes:
        age = now - q.ts
        if age > cfg.max_quote_age or age < -1.0:
            continue
        try:
            x = logit(q.fair_prob(cfg.devig_method))
        except ValueError:
            continue
        w = _weight(q.book, cfg) * 0.5 ** (max(age, 0.0) / cfg.recency_half_life)
        fresh.append((q, x, w))

    if len(fresh) < cfg.min_books:
        return FairEstimate(leg_id, float("nan"), float("inf"), len(fresh),
                            [q.book for q, _, _ in fresh], [], float("inf"),
                            ok=False, reason=f"only {len(fresh)} fresh books")

    xs = [x for _, x, _ in fresh]
    med = statistics.median(xs)
    mad = statistics.median(abs(x - med) for x in xs) * 1.4826
    band = max(cfg.outlier_k * mad, cfg.outlier_floor_logit)

    kept, rejected, sharp_div = [], [], False
    for q, x, w in fresh:
        if abs(x - med) > band:
            rejected.append(q.book)
            if _weight(q.book, cfg) >= cfg.sharp_weight:
                sharp_div = True
        else:
            kept.append((q, x, w))

    if len(kept) < cfg.min_books:
        return FairEstimate(leg_id, float("nan"), float("inf"), len(kept),
                            [q.book for q, _, _ in kept], rejected, float("inf"),
                            ok=False, sharp_divergence=sharp_div,
                            reason="too few books after outlier rejection")

    wsum = sum(w for _, _, w in kept)
    mean = sum(x * w for _, x, w in kept) / wsum
    disp = math.sqrt(sum(w * (x - mean) ** 2 for _, x, w in kept) / wsum)
    n_eff = wsum**2 / sum(w * w for _, _, w in kept)
    sigma = math.sqrt(disp**2 / n_eff + cfg.sigma_floor_logit**2)

    return FairEstimate(
        leg_id=leg_id,
        p=expit(mean),
        sigma_logit=sigma,
        n_books=len(kept),
        books_used=[q.book for q, _, _ in kept],
        rejected=rejected,
        dispersion_logit=disp,
        ok=True,
        sharp_divergence=sharp_div,
        reason="sharp book diverging from market" if sharp_div else "",
    )


def best_book_parlay_prob(american_prices: Sequence[float]) -> float | None:
    """The most generous parlay price any book offers, as an implied probability.

    This is a hard boundary for us: a bettor can buy the parlay there, so if
    our *bid* is above it they can buy at the book and sell to us for a lock.
    """
    if not american_prices:
        return None
    return min(american_to_prob(a) for a in american_prices)
