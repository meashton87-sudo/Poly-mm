"""Pluggable decision engine.

The contract is a single function::

    decide(state: dict) -> {"action": "buy" | "hold" | "skip", "confidence": float}

``decide`` below is a stub. To plug in an external model, either replace its
body or point ``DECISION_ENGINE`` in ``.env`` at any importable callable with
the same signature, e.g. ``DECISION_ENGINE=my_models.memes:decide``.

Engines may return extra keys (e.g. ``"reason"``); they are passed through to
the dashboard and trade log.
"""

from __future__ import annotations

import importlib
import logging
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
    return {**raw, "action": action, "confidence": confidence}


def safe_decide(fn: DecisionFn, state: dict[str, Any]) -> dict[str, Any]:
    """Call the engine, turning exceptions into a ``skip``."""
    try:
        return normalize_decision(fn(state))
    except Exception as exc:  # noqa: BLE001 - engine is untrusted user code
        log.exception("decision engine raised")
        return {"action": "skip", "confidence": 0.0, "reason": f"engine error: {exc}"}
