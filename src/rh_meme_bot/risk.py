"""Heuristic risk scoring and threshold gating.

The score is a cheap, transparent pre-signal handed to the decision engine and
used as a hard gate. It is not a safety guarantee.
"""

from __future__ import annotations

from typing import Any

from .config import RiskThresholds

# Weights add up to more than 1 on purpose; the score is clamped.
RISK_WEIGHTS = {
    "no_bytecode": 1.0,
    "owner_not_renounced": 0.3,
    "owner_unknown": 0.15,
    "no_supply": 0.5,
    "missing_metadata": 0.1,
    "zero_liquidity": 0.4,
    "unknown_liquidity": 0.15,
    "liquidity_removed": 0.4,
}


def score_risk(state: dict[str, Any]) -> tuple[float, list[str]]:
    """Return (score in [0, 1], list of triggered flags) for a state dict."""
    flags: list[str] = []
    token = state.get("token") or {}

    if not token.get("has_bytecode"):
        flags.append("no_bytecode")
    owner_status = token.get("owner_status")
    if owner_status == "owned":
        flags.append("owner_not_renounced")
    elif owner_status in ("no_owner_fn", "unknown", None):
        flags.append("owner_unknown")
    if not token.get("total_supply_raw"):
        flags.append("no_supply")
    if not token.get("symbol") or token.get("decimals") is None:
        flags.append("missing_metadata")

    pool = state.get("pool") or {}
    if pool.get("liquidity") == 0:
        flags.append("zero_liquidity")
    if state.get("quote_reserve") is None:
        flags.append("unknown_liquidity")
    if ((state.get("activity") or {}).get("quote_removed") or 0) > 0:
        flags.append("liquidity_removed")

    score = min(1.0, sum(RISK_WEIGHTS[f] for f in flags))
    return round(score, 4), flags


def apply_gates(
    decision: dict[str, Any], state: dict[str, Any], thresholds: RiskThresholds
) -> tuple[str, list[str]]:
    """Return (final_action, reasons) after enforcing configured thresholds.

    Only a ``buy`` can be vetoed; ``hold``/``skip`` pass through unchanged.
    """
    action = decision["action"]
    if action != "buy":
        return action, []
    reasons: list[str] = []
    if decision["confidence"] < thresholds.min_confidence:
        reasons.append(
            f"confidence {decision['confidence']:.2f} < {thresholds.min_confidence:.2f}"
        )
    # Use the stricter of the heuristic and the engine's own score, so an
    # engine can raise risk but never talk down a hard red flag.
    heuristic = state.get("risk_score", 1.0)
    engine = decision.get("engine_risk")
    risk = heuristic if engine is None else max(heuristic, engine)
    if risk > thresholds.max_risk_score:
        source = "engine" if engine is not None and engine > heuristic else "heuristic"
        reasons.append(f"{source} risk {risk:.2f} > {thresholds.max_risk_score:.2f}")
    reserve = state.get("quote_reserve")
    if thresholds.min_liquidity > 0 and (reserve is None or reserve < thresholds.min_liquidity):
        shown = "unknown" if reserve is None else f"{reserve:.4g}"
        reasons.append(f"liquidity {shown} < {thresholds.min_liquidity:g}")
    if state.get("price") in (None, 0):
        reasons.append("no price")
    return ("skip" if reasons else "buy"), reasons
