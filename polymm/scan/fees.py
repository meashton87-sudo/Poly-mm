"""Taker fees per venue. An "arb" that ignores fees is usually not an arb.

Kalshi: fee = roundup(0.07 * contracts * P * (1 - P)) to the cent (general
markets; some series use a different multiplier -- override `kalshi_rate`).
Polymarket: most markets are fee-free, but some (e.g. short-dated crypto)
charge taker fees. `polymarket_rate` uses the same P*(1-P) shape; set it per
your markets. Check both venues' current fee schedules before trading.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class FeeModel:
    kalshi_rate: float = 0.07
    polymarket_rate: float = 0.0
    # Kalshi rounds the fee *per order* up to the cent; this is the order size
    # the per-contract fee is amortised over when ranking opportunities.
    assumed_contracts: int = 100

    def per_contract(self, venue: str, price: float) -> float:
        if venue == "kalshi":
            n = self.assumed_contracts
            return math.ceil(self.kalshi_rate * n * price * (1 - price) * 100 - 1e-9) / 100 / n
        if venue == "polymarket":
            return self.polymarket_rate * price * (1 - price)
        return 0.0
