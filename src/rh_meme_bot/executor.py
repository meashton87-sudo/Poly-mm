"""Paper-trading executor with a pluggable (stubbed) swap backend."""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol


@dataclass
class SwapRequest:
    pool: str
    token_in: str
    token_out: str
    amount_in: float
    fee: int
    min_amount_out: float = 0.0


@dataclass
class SwapResult:
    success: bool
    amount_out: float
    tx_hash: str | None = None
    simulated: bool = True
    error: str | None = None


class SwapBackend(Protocol):
    """What a real executor must implement to place swaps on-chain."""

    def swap(self, request: SwapRequest, expected_price: float) -> SwapResult: ...


class StubSwapBackend:
    """Fills every swap at the quoted price. No transaction is sent.

    Replace with a backend that signs and submits a Uniswap V3
    ``exactInputSingle`` call via the SwapRouter when going live.
    """

    def swap(self, request: SwapRequest, expected_price: float) -> SwapResult:
        if expected_price <= 0:
            return SwapResult(success=False, amount_out=0.0, error="no price")
        # expected_price is quote per target token; amount_in is in quote units.
        return SwapResult(success=True, amount_out=request.amount_in / expected_price)


@dataclass
class Position:
    id: str
    pool: str
    token: str
    symbol: str | None
    quote_token: str | None
    entry_price: float
    size_quote: float
    quantity: float
    opened_at: float
    confidence: float
    last_price: float | None = None
    last_marked_at: float | None = None
    status: str = "open"
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def pnl_pct(self) -> float | None:
        if self.last_price is None or self.entry_price <= 0:
            return None
        return (self.last_price / self.entry_price - 1.0) * 100.0


class PaperExecutor:
    """Records simulated buys and marks them to market.

    Every action is appended as one JSON line to ``log_path``.
    """

    def __init__(
        self,
        log_path: Path,
        trade_size: float,
        backend: SwapBackend | None = None,
    ) -> None:
        self.log_path = Path(log_path)
        self.trade_size = trade_size
        self.backend: SwapBackend = backend or StubSwapBackend()
        self.positions: dict[str, Position] = {}
        self._lock = threading.Lock()

    def has_position(self, pool: str) -> bool:
        with self._lock:
            return any(p.pool == pool and p.status == "open" for p in self.positions.values())

    def open_positions(self) -> list[Position]:
        with self._lock:
            return [p for p in self.positions.values() if p.status == "open"]

    def buy(self, state: dict[str, Any], decision: dict[str, Any]) -> Position | None:
        """Simulate a buy of the state's target token at the current pool price."""
        event = state["event"]
        price = state.get("price")
        if not price or self.has_position(event["pool"]):
            return None
        request = SwapRequest(
            pool=event["pool"],
            token_in=state.get("quote_token") or "",
            token_out=state["token"]["address"],
            amount_in=self.trade_size,
            fee=int(event["fee"]),
        )
        result = self.backend.swap(request, expected_price=float(price))
        if not result.success:
            self._write({"type": "buy_failed", "ts": time.time(),
                         "pool": event["pool"], "error": result.error})
            return None

        now = time.time()
        pos = Position(
            id=uuid.uuid4().hex[:8],
            pool=event["pool"],
            token=state["token"]["address"],
            symbol=state["token"].get("symbol"),
            quote_token=state.get("quote_token"),
            entry_price=float(price),
            size_quote=self.trade_size,
            quantity=result.amount_out,
            opened_at=now,
            confidence=float(decision.get("confidence", 0.0)),
            last_price=float(price),
            last_marked_at=now,
            meta={"simulated": result.simulated, "tx_hash": result.tx_hash,
                  "risk_score": state.get("risk_score")},
        )
        with self._lock:
            self.positions[pos.id] = pos
        self._write({"type": "open", "ts": now, "position": asdict(pos)})
        return pos

    def mark(self, position_id: str, price: float) -> None:
        with self._lock:
            pos = self.positions.get(position_id)
            if pos is None:
                return
            pos.last_price = price
            pos.last_marked_at = time.time()

    def record_decision(self, state: dict[str, Any], decision: dict[str, Any],
                        final_action: str, gate_reasons: list[str]) -> None:
        self._write({
            "type": "decision",
            "ts": time.time(),
            "pool": state["event"]["pool"],
            "token": state["token"]["address"],
            "symbol": state["token"].get("symbol"),
            "price": state.get("price"),
            "risk_score": state.get("risk_score"),
            "decision": decision,
            "final_action": final_action,
            "gate_reasons": gate_reasons,
        })

    def _write(self, record: dict[str, Any]) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")
