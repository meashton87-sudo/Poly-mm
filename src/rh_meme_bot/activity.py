"""Summarize a pool's trading and liquidity activity since creation.

Everything is from the *target* token's point of view: a "buy" is a swap where
the pool paid out the target token (and received the quote token).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from .chain import PoolLog, sqrt_price_x96_to_price


def summarize_activity(
    logs: list[PoolLog],
    target_is_token0: bool,
    decimals0: int,
    decimals1: int,
    age_seconds: float | None,
    blocks_observed: int,
) -> dict[str, Any]:
    """Return momentum / buy-pressure / liquidity-change stats for the state dict.

    Volumes are in whole quote tokens. Prices are quote per target token.
    """
    q_dec = decimals1 if target_is_token0 else decimals0
    scale = Decimal(10) ** q_dec

    def quote_amt(log: PoolLog) -> Decimal:
        raw = log.amount1 if target_is_token0 else log.amount0
        return Decimal(raw) / scale

    buys = sells = 0
    buy_vol = sell_vol = Decimal(0)
    recipients: set[str] = set()
    buyers: set[str] = set()
    prices: list[float] = []
    mints = burns = 0
    quote_added = quote_removed = Decimal(0)

    for log in logs:
        if log.kind == "swap":
            target_delta = log.amount0 if target_is_token0 else log.amount1
            q = quote_amt(log)
            if target_delta < 0:  # pool paid out target -> someone bought
                buys += 1
                buy_vol += abs(q)
                if log.recipient:
                    buyers.add(log.recipient)
            elif target_delta > 0:
                sells += 1
                sell_vol += abs(q)
            if log.recipient:
                recipients.add(log.recipient)
            if log.sqrt_price_x96:
                p01 = sqrt_price_x96_to_price(log.sqrt_price_x96, decimals0, decimals1)
                price = p01 if target_is_token0 else (Decimal(1) / p01 if p01 else Decimal(0))
                if price > 0:
                    prices.append(float(price))
        elif log.kind == "mint":
            mints += 1
            quote_added += quote_amt(log)
        elif log.kind == "burn":
            burns += 1
            quote_removed += quote_amt(log)

    swaps = buys + sells
    minutes = (age_seconds / 60.0) if age_seconds and age_seconds > 0 else None
    first, last = (prices[0], prices[-1]) if prices else (None, None)
    high = max(prices) if prices else None

    def pct(a: float | None, b: float | None) -> float | None:
        return None if not a or b is None else round((b / a - 1.0) * 100.0, 4)

    return {
        "age_seconds": age_seconds,
        "blocks_observed": blocks_observed,
        "swap_count": swaps,
        "buy_count": buys,
        "sell_count": sells,
        "buy_ratio": round(buys / swaps, 4) if swaps else None,
        "buy_volume_quote": float(buy_vol),
        "sell_volume_quote": float(sell_vol),
        "net_flow_quote": float(buy_vol - sell_vol),
        # Swap recipients approximate traders (routers can forward to users).
        "unique_recipients": len(recipients),
        "unique_buyers": len(buyers),
        "swaps_per_minute": round(swaps / minutes, 4) if minutes else None,
        "first_swap_price": first,
        "last_swap_price": last,
        "high_price": high,
        "price_change_pct": pct(first, last),
        "drawdown_from_high_pct": pct(high, last),
        "mint_count": mints,
        "burn_count": burns,
        "quote_added": float(quote_added),
        "quote_removed": float(quote_removed),
    }
