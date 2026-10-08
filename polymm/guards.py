"""Speed / circuit breakers: reasons to pull quotes *before* thinking further.

Getting run over almost always looks like one of these:
  - your odds feed went quiet (you're quoting yesterday's price)
  - fair value jumped (injury, lineup news) and you're mid-requote
  - the sharp book moved and the rec books haven't yet (news is propagating)
  - books disagree wildly (someone's stale; you don't know who)
  - the game started (pre-game model, live market)
  - an operator hit the news button
Any of these => cancel first, ask questions later.
"""

from __future__ import annotations

import math
from collections import defaultdict, deque
from dataclasses import dataclass, field

from .fair_value import FairEstimate
from .odds import logit


@dataclass
class GuardConfig:
    max_feed_silence: float = 30.0  # seconds without any update on a leg
    jump_window: float = 60.0
    jump_threshold_logit: float = 0.25  # ~ 0.30 -> 0.355 prob
    jump_cooldown: float = 45.0
    max_dispersion_logit: float = 0.35
    pull_on_sharp_divergence: bool = True
    sharp_cooldown: float = 30.0
    news_cooldown: float = 300.0
    pregame_cutoff: float = 60.0  # stop quoting this many seconds before start


@dataclass
class Guards:
    cfg: GuardConfig = field(default_factory=GuardConfig)
    last_update: dict[str, float] = field(default_factory=dict)
    start_times: dict[str, float] = field(default_factory=dict)
    _hist: dict[str, deque] = field(default_factory=lambda: defaultdict(deque))
    _halt_until: dict[str, float] = field(default_factory=dict)
    _halt_reason: dict[str, str] = field(default_factory=dict)

    def _halt(self, leg: str, until: float, reason: str) -> None:
        if until > self._halt_until.get(leg, -math.inf):
            self._halt_until[leg] = until
            self._halt_reason[leg] = reason

    def on_feed_update(self, leg: str, now: float) -> None:
        self.last_update[leg] = now

    def on_news(self, leg: str, now: float, note: str = "manual news") -> None:
        self._halt(leg, now + self.cfg.news_cooldown, note)

    def on_estimate(self, est: FairEstimate, now: float) -> None:
        if not est.ok:
            return
        x = logit(est.p)
        h = self._hist[est.leg_id]
        h.append((now, x))
        while h and now - h[0][0] > self.cfg.jump_window:
            h.popleft()
        if max(abs(x - hx) for _, hx in h) > self.cfg.jump_threshold_logit:
            self._halt(est.leg_id, now + self.cfg.jump_cooldown, "fair value jump")
            # Re-anchor so we don't re-trip forever on the same move.
            h.clear()
            h.append((now, x))
        if est.sharp_divergence and self.cfg.pull_on_sharp_divergence:
            self._halt(est.leg_id, now + self.cfg.sharp_cooldown, "sharp book diverging")

    def leg_problems(self, leg: str, est: FairEstimate | None, now: float) -> list[str]:
        out = []
        last = self.last_update.get(leg)
        if last is None or now - last > self.cfg.max_feed_silence:
            out.append("stale feed")
        if now < self._halt_until.get(leg, -math.inf):
            out.append(self._halt_reason[leg])
        if est is None or not est.ok:
            out.append(f"no fair value ({est.reason if est else 'no data'})")
        elif est.dispersion_logit > self.cfg.max_dispersion_logit:
            out.append("books disagree")
        start = self.start_times.get(leg)
        if start is not None and now > start - self.cfg.pregame_cutoff:
            out.append("event starting/started")
        return out
