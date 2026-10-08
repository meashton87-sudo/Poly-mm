"""Main loop: watch factory -> build state -> decide -> gate -> paper trade."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .chain import ChainReader, FactoryWatcher, PoolCreated
from .config import Config
from .decision import DecisionFn, safe_decide
from .executor import PaperExecutor
from .risk import apply_gates, score_risk

log = logging.getLogger(__name__)


@dataclass
class LaunchRow:
    """One detected pool as shown on the dashboard."""

    seen_at: float
    event: PoolCreated
    symbol: str | None = None
    price: float | None = None
    quote_reserve: float | None = None
    risk_score: float | None = None
    risk_flags: list[str] = field(default_factory=list)
    decision: dict[str, Any] | None = None
    final_action: str | None = None
    gate_reasons: list[str] = field(default_factory=list)
    attempts: int = 0
    error: str | None = None


class BotState:
    """Thread-safe snapshot store shared between the worker and the dashboard."""

    def __init__(self, max_rows: int = 200, max_log: int = 500) -> None:
        self.lock = threading.Lock()
        self.launches: deque[LaunchRow] = deque(maxlen=max_rows)
        self.actions: deque[tuple[float, str, str]] = deque(maxlen=max_log)
        self.chain_id: int | None = None
        self.head_block: int | None = None
        self.next_block: int | None = None
        self.last_poll: float | None = None
        self.last_error: str | None = None
        self.pools_seen = 0
        self.action_count = 0

    def log_action(self, level: str, message: str) -> None:
        with self.lock:
            self.actions.append((time.time(), level, message))
            self.action_count += 1


def classify_tokens(event: PoolCreated, quote_tokens: set[str]) -> tuple[str, str, bool]:
    """Return (target_token, quote_token, quote_is_known).

    The target is the side that is *not* a configured quote token. When
    neither (or both) sides are known quotes, token0 is treated as the target.
    """
    t0, t1 = event.token0.lower(), event.token1.lower()
    if t1 in quote_tokens and t0 not in quote_tokens:
        return event.token0, event.token1, True
    if t0 in quote_tokens and t1 not in quote_tokens:
        return event.token1, event.token0, True
    return event.token0, event.token1, t1 in quote_tokens


def build_state(
    reader: ChainReader, event: PoolCreated, quote_tokens: set[str]
) -> dict[str, Any]:
    """Assemble the dict passed to ``decide``. Keys are documented in the README."""
    target, quote, quote_known = classify_tokens(event, quote_tokens)
    token = reader.get_token_info(target)
    quote_info = reader.get_token_info(quote)

    pool_info: dict[str, Any] = {}
    price: float | None = None
    try:
        pp = reader.get_pool_price(event.pool, event.token0, event.token1)
        pool_info = pp.to_dict()
        price = pp.price_token0_in_token1 if target == event.token0 else pp.price_token1_in_token0
    except Exception as exc:  # noqa: BLE001 - uninitialized pools revert on slot0
        pool_info = {"error": str(exc)}

    quote_reserve = reader.get_balance(quote, event.pool) if quote_known else None
    target_reserve = reader.get_balance(target, event.pool)

    state: dict[str, Any] = {
        "chain_id": reader.expected_chain_id,
        "event": event.to_dict(),
        "token": token.to_dict(),
        "quote_token": quote,
        "quote_token_info": quote_info.to_dict(),
        "quote_is_known": quote_known,
        "pool": pool_info,
        "price": price or None,
        "quote_reserve": quote_reserve,
        "token_reserve": target_reserve,
        "timestamp": time.time(),
    }
    score, flags = score_risk(state)
    state["risk_score"] = score
    state["risk_flags"] = flags
    return state


class Bot:
    def __init__(
        self,
        config: Config,
        reader: ChainReader,
        decide_fn: DecisionFn,
        executor: PaperExecutor,
        state: BotState | None = None,
    ) -> None:
        self.config = config
        self.reader = reader
        self.decide_fn = decide_fn
        self.executor = executor
        self.state = state or BotState()
        self.quote_tokens = {t.lower() for t in config.quote_tokens}
        self.watcher: FactoryWatcher | None = None
        # Pools whose price/liquidity weren't ready yet: (due_at, row).
        self._rechecks: list[tuple[float, LaunchRow]] = []
        self._last_mark = 0.0

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        chain_id = self.reader.check_connection()
        head = self.reader.latest_block()
        start = self.config.start_block
        if start is None:
            start = max(0, head - self.config.lookback_blocks)
        self.watcher = FactoryWatcher(self.reader, start)
        with self.state.lock:
            self.state.chain_id = chain_id
            self.state.head_block = head
            self.state.next_block = start
        self.state.log_action("info", f"connected to chain {chain_id}, scanning from block {start}")

    def run(self, stop: threading.Event) -> None:
        backoff = self.config.poll_interval
        while not stop.is_set():
            try:
                if self.watcher is None:
                    self.start()
                self.tick()
                backoff = self.config.poll_interval
            except Exception as exc:  # noqa: BLE001 - keep the loop alive on RPC errors
                log.exception("poll failed")
                with self.state.lock:
                    self.state.last_error = f"{type(exc).__name__}: {exc}"
                self.state.log_action("error", f"poll failed: {exc}")
                backoff = min(backoff * 2, 60.0)
            stop.wait(backoff)

    # -- per-iteration work ----------------------------------------------

    def tick(self) -> None:
        assert self.watcher is not None
        events = self.watcher.poll()
        with self.state.lock:
            self.state.head_block = self.watcher.next_block - 1
            self.state.next_block = self.watcher.next_block
            self.state.last_poll = time.time()
            self.state.last_error = None
        # Run due re-checks before new events so a fresh pool isn't re-checked
        # in the same tick it was first seen.
        self._run_rechecks()
        for event in events:
            row = LaunchRow(seen_at=time.time(), event=event)
            with self.state.lock:
                self.state.launches.appendleft(row)
                self.state.pools_seen += 1
            self.state.log_action("info", f"new pool {event.pool} (fee {event.fee}) "
                                          f"block {event.block_number}")
            self.evaluate(row)
        self._mark_positions()

    def evaluate(self, row: LaunchRow) -> None:
        row.attempts += 1
        try:
            st = build_state(self.reader, row.event, self.quote_tokens)
        except Exception as exc:  # noqa: BLE001
            row.error = str(exc)
            self.state.log_action("error", f"state build failed for {row.event.pool}: {exc}")
            return

        decision = safe_decide(self.decide_fn, st)
        final_action, reasons = apply_gates(decision, st, self.config.risk)

        with self.state.lock:
            row.symbol = st["token"].get("symbol")
            row.price = st.get("price")
            row.quote_reserve = st.get("quote_reserve")
            row.risk_score = st["risk_score"]
            row.risk_flags = st["risk_flags"]
            row.decision = decision
            row.final_action = final_action
            row.gate_reasons = reasons
            row.error = None

        self.executor.record_decision(st, decision, final_action, reasons)
        label = row.symbol or row.event.pool[:10]
        msg = (f"{label}: engine={decision['action']} ({decision['confidence']:.2f}) "
               f"-> {final_action}")
        if reasons:
            msg += f" [{'; '.join(reasons)}]"
        self.state.log_action("decision", msg)

        if final_action == "buy":
            pos = self.executor.buy(st, decision)
            if pos:
                self.state.log_action(
                    "trade",
                    f"PAPER BUY {pos.symbol or pos.token[:10]} qty={pos.quantity:.6g} "
                    f"@ {pos.entry_price:.6g} (size {pos.size_quote:g})",
                )
        elif self._needs_recheck(st) and row.attempts <= self.config.recheck_attempts:
            self._rechecks.append((time.time() + self.config.recheck_delay, row))

    @staticmethod
    def _needs_recheck(st: dict[str, Any]) -> bool:
        # Pools are usually created before they're initialized and funded.
        return not st.get("price") or not st.get("pool", {}).get("liquidity")

    def _run_rechecks(self) -> None:
        now = time.time()
        due = [r for t, r in self._rechecks if t <= now]
        self._rechecks = [(t, r) for t, r in self._rechecks if t > now]
        for row in due:
            self.state.log_action("info", f"re-checking {row.event.pool} "
                                          f"(attempt {row.attempts + 1})")
            self.evaluate(row)

    def _mark_positions(self) -> None:
        now = time.time()
        if now - self._last_mark < self.config.mark_interval:
            return
        self._last_mark = now
        for pos in self.executor.open_positions():
            try:
                # Uniswap orders pool tokens by address: token0 < token1.
                is_token0 = pos.token.lower() < (pos.quote_token or "").lower()
                t0, t1 = (pos.token, pos.quote_token) if is_token0 else (pos.quote_token, pos.token)
                pp = self.reader.get_pool_price(pos.pool, t0, t1)
                price = pp.price_token0_in_token1 if is_token0 else pp.price_token1_in_token0
                self.executor.mark(pos.id, price)
            except Exception as exc:  # noqa: BLE001
                log.debug("mark failed for %s: %s", pos.pool, exc)
