"""Turn a fair value into a two-sided Polymarket quote.

Prices are Polymarket YES prices (= probability). A taker *buying* YES from
our ask at price a is getting American odds of prob_to_american(a); that is
the number you compare to "DraftKings +700".

half_spread = base
            + uncertainty_mult * sigma(fair)        (don't be tight when unsure)
            + toxicity widening                       (recent fills went against us)
reservation = fair - max_skew * inventory / max_inventory   (lean against inventory)
bid/ask = reservation -/+ half_spread, rounded to the tick
then hard bounds: never inside fair +/- min_edge; bid strictly below the best
book parlay price (else: bet the book, sell to us, free lock).
If anchoring to books, the ask is lifted to just-beat the best book: there is
no reason to give away more edge than needed to be the best price in town.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .odds import fmt_american


@dataclass
class QuoteParams:
    tick: float = 0.01
    min_price: float = 0.01
    max_price: float = 0.99
    base_half_spread: float = 0.004
    uncertainty_mult: float = 1.0
    min_edge: float = 0.003  # hard floor on edge per share, after tick rounding
    max_skew: float = 0.02
    toxicity_widen: float = 0.02  # extra half-spread at toxicity score 1.0
    base_size: float = 250.0  # shares per side
    min_size: float = 5.0  # Polymarket min order size
    anchor_ask_to_books: bool = True
    book_improvement: float = 0.005  # how much better than best book our ask is


@dataclass
class Quote:
    fair: float
    bid: float | None
    bid_size: float
    ask: float | None
    ask_size: float
    half_spread: float
    reservation: float

    def describe(self) -> str:
        parts = [f"fair {self.fair:.4f} ({fmt_american(self.fair)})"]
        if self.bid is not None:
            parts.append(f"bid {self.bid:.3f} x {self.bid_size:.0f}")
        if self.ask is not None:
            parts.append(f"ask {self.ask:.3f} x {self.ask_size:.0f} "
                         f"(bettor gets {fmt_american(self.ask)})")
        return " | ".join(parts)


def _floor_tick(x: float, tick: float) -> float:
    return round(math.floor(x / tick + 1e-9) * tick, 10)


def _round_tick(x: float, tick: float) -> float:
    return round(round(x / tick) * tick, 10)


def _ceil_tick(x: float, tick: float) -> float:
    return round(math.ceil(x / tick - 1e-9) * tick, 10)


def make_quote(
    fair: float,
    sigma: float,
    params: QuoteParams,
    inventory: float = 0.0,
    max_inventory: float = 1000.0,
    toxicity: float = 0.0,
    best_book_prob: float | None = None,
    max_bid_size: float = math.inf,
    max_ask_size: float = math.inf,
) -> Quote:
    """inventory is net YES shares (negative = short YES / long NO)."""
    tox = min(max(toxicity, 0.0), 1.0)
    inv_frac = max(min(inventory / max_inventory, 1.0), -1.0) if max_inventory > 0 else 0.0

    half = params.base_half_spread + params.uncertainty_mult * sigma + params.toxicity_widen * tox
    res = fair - params.max_skew * inv_frac

    # Round to the nearest tick (on a 1c grid always rounding outward is very
    # costly for a 10c parlay), then enforce the min-edge floor outward.
    bid = min(_round_tick(res - half, params.tick), _floor_tick(fair - params.min_edge, params.tick))
    ask = max(_round_tick(res + half, params.tick), _ceil_tick(fair + params.min_edge, params.tick))

    if best_book_prob is not None:
        # Never bid at/above what a book sells the same parlay for.
        bid = min(bid, _floor_tick(best_book_prob - params.tick, params.tick))
        if params.anchor_ask_to_books:
            target = _floor_tick(best_book_prob - params.book_improvement, params.tick)
            ask = max(ask, target)

    # Size: shrink the side that adds to inventory, and everything when toxic.
    size = params.base_size * (1 - 0.75 * tox)
    bid_size = min(size * (1 - max(inv_frac, 0.0)), max_bid_size)
    ask_size = min(size * (1 + min(inv_frac, 0.0)), max_ask_size)

    bid_out = bid if params.min_price <= bid and bid_size >= params.min_size else None
    ask_out = ask if ask <= params.max_price and ask_size >= params.min_size else None
    if bid_out is not None and ask_out is not None and bid_out >= ask_out:
        bid_out = None  # can only happen with extreme skew; drop the risky side

    return Quote(fair=fair, bid=bid_out, bid_size=math.floor(bid_size) if bid_out else 0.0,
                 ask=ask_out, ask_size=math.floor(ask_size) if ask_out else 0.0,
                 half_spread=half, reservation=res)
