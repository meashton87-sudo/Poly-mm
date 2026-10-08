"""Adverse selection / toxic flow detection.

The fills you get are not random. Someone who just saw the injury tweet will
happily lift your stale ask. The standard tool is the *markout*: after each
fill, look at where fair value went `h` seconds later. If fills are
consistently followed by fair moving against you, your flow is toxic and you
need to widen, shrink, or pull.

Also tracks fill *bursts*: several fills on one side in a few seconds is the
signature of someone sweeping you on information. Pull that side, now.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field


@dataclass
class Fill:
    ts: float
    market_id: str
    side: str  # our side: "BUY" (we bought YES) or "SELL" (we sold YES)
    price: float
    size: float
    fair_at_fill: float
    counterparty: str = ""


@dataclass
class CounterpartyStats:
    fills: int = 0
    shares: float = 0.0
    markout_sum: float = 0.0  # $ per share, size weighted

    @property
    def avg_markout(self) -> float:
        return self.markout_sum / self.shares if self.shares else 0.0


@dataclass
class ToxicityConfig:
    horizon: float = 30.0  # seconds after fill to measure markout
    ewma_alpha: float = 0.2
    adverse_scale: float = 0.01  # adverse fair move (prob) that maps to score 1.0
    burst_window: float = 5.0
    burst_fills: int = 3
    burst_cooldown: float = 30.0
    toxic_min_fills: int = 5
    toxic_markout: float = -0.005


@dataclass
class ToxicityTracker:
    cfg: ToxicityConfig = field(default_factory=ToxicityConfig)
    _pending: deque = field(default_factory=deque)
    _ewma: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    _recent: dict[tuple[str, str], deque] = field(default_factory=lambda: defaultdict(deque))
    _side_blocked_until: dict[tuple[str, str], float] = field(default_factory=dict)
    counterparties: dict[str, CounterpartyStats] = field(default_factory=lambda: defaultdict(CounterpartyStats))

    def on_fill(self, fill: Fill) -> bool:
        """Record a fill. Returns True if this fill triggered a burst block."""
        self._pending.append(fill)
        q = self._recent[(fill.market_id, fill.side)]
        q.append(fill.ts)
        while q and fill.ts - q[0] > self.cfg.burst_window:
            q.popleft()
        if len(q) >= self.cfg.burst_fills:
            self._side_blocked_until[(fill.market_id, fill.side)] = fill.ts + self.cfg.burst_cooldown
            return True
        return False

    def on_time(self, now: float, fair_of: dict[str, float]) -> None:
        """Resolve markouts whose horizon has elapsed, using current fair values."""
        while self._pending and now - self._pending[0].ts >= self.cfg.horizon:
            f = self._pending.popleft()
            fair_now = fair_of.get(f.market_id)
            if fair_now is None:
                continue
            sgn = 1 if f.side == "BUY" else -1
            # Fair drift since the fill, signed so negative = it went against us.
            drift = sgn * (fair_now - f.fair_at_fill)
            a = self.cfg.ewma_alpha
            self._ewma[f.market_id] = (1 - a) * self._ewma[f.market_id] + a * drift
            if f.counterparty:
                cs = self.counterparties[f.counterparty]
                cs.fills += 1
                cs.shares += f.size
                cs.markout_sum += sgn * (fair_now - f.price) * f.size

    def score(self, market_id: str) -> float:
        """0 = benign flow, 1 = very toxic."""
        return min(max(-self._ewma[market_id] / self.cfg.adverse_scale, 0.0), 1.0)

    def side_blocked(self, market_id: str, side: str, now: float) -> bool:
        return now < self._side_blocked_until.get((market_id, side), float("-inf"))

    def toxic_counterparties(self) -> list[str]:
        return [
            cp for cp, s in self.counterparties.items()
            if s.fills >= self.cfg.toxic_min_fills and s.avg_markout < self.cfg.toxic_markout
        ]
