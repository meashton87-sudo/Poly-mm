"""Pluggable decision engine.

The contract is a single function::

    decide(state: dict) -> {"action": "buy" | "hold" | "skip", "confidence": float}

``decide`` below is a stub. To plug in an external model, either replace its
body or point ``DECISION_ENGINE`` in ``.env`` at any importable callable with
the same signature, e.g. ``DECISION_ENGINE=my_models.memes:decide``.

Engines may also return:

* ``"risk_score"``: the engine's own risk estimate, in [0, 1], or on a 1..N
  scale if ``"risk_levels": N`` is also returned. The risk gate uses the higher
  of this and the built-in heuristic score.
* any other keys (e.g. ``"reason"``), passed through to the dashboard and log.
"""

from __future__ import annotations

import importlib
import logging
import os
import sys
from typing import Any, Callable

log = logging.getLogger(__name__)

VALID_ACTIONS = ("buy", "hold", "skip")

DecisionFn = Callable[[dict[str, Any]], dict[str, Any]]


def decide(state: dict[str, Any]) -> dict[str, Any]:
    """Stub decision engine. Replace with a call to your model.

    ``state`` is built by :func:`rh_meme_bot.bot.build_state` and contains the
    pool event, target/quote token info, price, liquidity and the heuristic
    risk score. See the README for the full schema.
    """
    return {"action": "hold", "confidence": 0.0, "reason": "stub engine"}


def load_decision_fn(spec: str | None) -> DecisionFn:
    """Resolve ``"package.module:function"`` to a callable; empty -> built-in stub."""
    if not spec:
        return decide
    module_name, sep, attr = spec.partition(":")
    if not sep or not module_name or not attr:
        raise ValueError(f"DECISION_ENGINE must look like 'module:function', got {spec!r}")
    # The ``rh-meme-bot`` console script doesn't put the working directory on
    # sys.path (``python -m`` does); add it so a local engine file is importable.
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    module = importlib.import_module(module_name)
    fn = getattr(module, attr)
    if not callable(fn):
        raise TypeError(f"{spec} is not callable")
    return fn


def normalize_decision(raw: Any) -> dict[str, Any]:
    """Validate an engine's output, coercing it into the documented shape.

    Anything malformed degrades to ``skip`` with zero confidence so a buggy
    model can never trigger a buy.
    """
    if not isinstance(raw, dict):
        return {"action": "skip", "confidence": 0.0,
                "reason": f"invalid engine output type: {type(raw).__name__}"}
    action = str(raw.get("action", "")).lower().strip()
    if action not in VALID_ACTIONS:
        return {**raw, "action": "skip", "confidence": 0.0,
                "reason": f"invalid action {raw.get('action')!r}"}
    try:
        confidence = float(raw.get("confidence", 0.0))
    except (TypeError, ValueError):
        return {**raw, "action": "skip", "confidence": 0.0, "reason": "invalid confidence"}
    if confidence != confidence:  # NaN
        confidence = 0.0
    confidence = min(max(confidence, 0.0), 1.0)
    out = {**raw, "action": action, "confidence": confidence}
    if raw.get("risk_score") is not None:
        out["engine_risk"] = _normalize_risk(raw["risk_score"], raw.get("risk_levels"))
    return out


def _normalize_risk(score: Any, levels: Any) -> float:
    """Map an engine risk score onto [0, 1].

    With ``risk_levels=N`` the score is read as 1..N (1 = safe). Without it the
    score must already be in [0, 1]. Anything unparseable counts as maximum
    risk, so a malformed score can only block a buy, never allow one.
    """
    try:
        s = float(score)
        if s != s:
            return 1.0
        if levels is not None:
            n = int(levels)
            if n < 2:
                return 1.0
            return min(max((s - 1.0) / (n - 1.0), 0.0), 1.0)
        return s if 0.0 <= s <= 1.0 else 1.0
    except (TypeError, ValueError):
        return 1.0


def safe_decide(fn: DecisionFn, state: dict[str, Any]) -> dict[str, Any]:
    """Call the engine, turning exceptions into a ``skip``."""
    try:
        return normalize_decision(fn(state))
    except Exception as exc:  # noqa: BLE001 - engine is untrusted user code
        log.exception("decision engine raised")
        return {"action": "skip", "confidence": 0.0, "reason": f"engine error: {exc}"}
