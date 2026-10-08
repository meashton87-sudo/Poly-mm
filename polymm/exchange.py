"""Exchange adapters.

`PaperExchange` is an in-memory matcher used by tests and the simulator.
`PolymarketExchange` is a thin wrapper over the official `py-clob-client`
(pip install py-clob-client). It is a starting point, not battle-tested:
paper trade first, then go live with tiny limits.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Callable, Protocol


class Exchange(Protocol):
    def place(self, market_id: str, side: str, price: float, size: float) -> str: ...
    def cancel(self, order_id: str) -> None: ...
    def cancel_market(self, market_id: str) -> None: ...


@dataclass
class RestingOrder:
    order_id: str
    market_id: str
    side: str  # our side: BUY = bid for YES, SELL = offer YES
    price: float
    size: float


FillCallback = Callable[[str, str, float, float, str], None]  # market, side, price, size, cp


class PaperExchange:
    def __init__(self) -> None:
        self.orders: dict[str, RestingOrder] = {}
        self._ids = itertools.count(1)
        self.on_fill: FillCallback | None = None
        self.n_places = 0
        self.n_cancels = 0

    def place(self, market_id: str, side: str, price: float, size: float) -> str:
        oid = f"o{next(self._ids)}"
        self.orders[oid] = RestingOrder(oid, market_id, side, price, size)
        self.n_places += 1
        return oid

    def cancel(self, order_id: str) -> None:
        if self.orders.pop(order_id, None) is not None:
            self.n_cancels += 1

    def cancel_market(self, market_id: str) -> None:
        for oid in [o.order_id for o in self.orders.values() if o.market_id == market_id]:
            self.cancel(oid)

    def best(self, market_id: str, side: str) -> RestingOrder | None:
        os_ = [o for o in self.orders.values() if o.market_id == market_id and o.side == side]
        if not os_:
            return None
        return max(os_, key=lambda o: o.price) if side == "BUY" else min(os_, key=lambda o: o.price)

    def take(self, market_id: str, taker_side: str, size: float, limit: float,
             counterparty: str = "") -> float:
        """A taker hits our resting orders. taker_side BUY lifts our SELL (ask)."""
        our_side = "SELL" if taker_side == "BUY" else "BUY"
        filled = 0.0
        while filled < size:
            o = self.best(market_id, our_side)
            if o is None or (taker_side == "BUY" and o.price > limit) or (taker_side == "SELL" and o.price < limit):
                break
            q = min(o.size, size - filled)
            o.size -= q
            filled += q
            if o.size <= 1e-9:
                del self.orders[o.order_id]
            if self.on_fill:
                # Note: the callback may cancel/replace orders; loop re-reads the book.
                self.on_fill(market_id, our_side, o.price, q, counterparty)
        return filled


class PolymarketExchange:
    """Live adapter. Our quoting is in YES terms; the ask is implemented as a
    BUY of the NO token at (1 - ask) so we never need YES inventory to offer.
    Holding YES + NO later can be merged back to USDC.

    Fills must be fed to `MarketMaker.on_fill` from the user websocket channel
    (wss://ws-subscriptions-clob.polymarket.com/ws/user) — not implemented here.
    """

    def __init__(self, private_key: str, tokens: dict[str, tuple[str, str]],
                 host: str = "https://clob.polymarket.com", chain_id: int = 137,
                 signature_type: int | None = None, funder: str | None = None):
        from py_clob_client.client import ClobClient  # lazy: optional dependency

        kwargs = {}
        if signature_type is not None:
            kwargs["signature_type"] = signature_type
        if funder is not None:
            kwargs["funder"] = funder
        self.client = ClobClient(host, key=private_key, chain_id=chain_id, **kwargs)
        self.client.set_api_creds(self.client.create_or_derive_api_creds())
        self.tokens = tokens  # market_id -> (yes_token_id, no_token_id)
        self._order_market: dict[str, str] = {}

    def place(self, market_id: str, side: str, price: float, size: float) -> str:
        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.order_builder.constants import BUY

        yes, no = self.tokens[market_id]
        token, px = (yes, price) if side == "BUY" else (no, round(1 - price, 4))
        signed = self.client.create_order(OrderArgs(price=px, size=size, side=BUY, token_id=token))
        resp = self.client.post_order(signed, OrderType.GTC)
        oid = resp.get("orderID") or resp.get("orderId")
        if not oid:
            raise RuntimeError(f"order rejected: {resp}")
        self._order_market[oid] = market_id
        return oid

    def cancel(self, order_id: str) -> None:
        self.client.cancel(order_id)
        self._order_market.pop(order_id, None)

    def cancel_market(self, market_id: str) -> None:
        for oid in [o for o, m in self._order_market.items() if m == market_id]:
            self.cancel(oid)

    def cancel_everything(self) -> None:
        self.client.cancel_all()
        self._order_market.clear()
