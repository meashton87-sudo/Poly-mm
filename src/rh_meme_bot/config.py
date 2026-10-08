"""Configuration loaded from environment variables / a .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
DEFAULT_CHAIN_ID = 4663
DEFAULT_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"


def _get(name: str, default: str) -> str:
    value = os.getenv(name)
    return default if value is None or value.strip() == "" else value.strip()


def _get_float(name: str, default: float) -> float:
    raw = _get(name, str(default))
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw!r}") from exc


def _get_int(name: str, default: int) -> int:
    raw = _get(name, str(default))
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _get_optional_int(name: str) -> int | None:
    raw = _get(name, "")
    return _get_int(name, 0) if raw else None


@dataclass(frozen=True)
class RiskThresholds:
    min_liquidity: float = 1.0
    min_confidence: float = 0.7
    max_risk_score: float = 0.5


@dataclass(frozen=True)
class Config:
    rpc_url: str = DEFAULT_RPC_URL
    chain_id: int = DEFAULT_CHAIN_ID
    factory_address: str = DEFAULT_FACTORY
    poll_interval: float = 3.0
    start_block: int | None = None
    lookback_blocks: int = 5000
    max_block_range: int = 2000
    quote_tokens: tuple[str, ...] = ()
    risk: RiskThresholds = field(default_factory=RiskThresholds)
    decision_engine: str = ""
    paper_trade_size: float = 0.1
    paper_log_path: Path = Path("data/paper_trades.jsonl")
    mark_interval: float = 15.0
    recheck_delay: float = 20.0
    recheck_attempts: int = 3
    observe_delay: float = 0.0

    @classmethod
    def from_env(cls, env_file: str | os.PathLike | None = None) -> "Config":
        """Load config from the process environment, after reading ``.env``."""
        load_dotenv(env_file, override=False)
        quote_raw = _get("QUOTE_TOKENS", "")
        quote_tokens = tuple(t.strip() for t in quote_raw.split(",") if t.strip())
        cfg = cls(
            rpc_url=_get("RPC_URL", DEFAULT_RPC_URL),
            chain_id=_get_int("CHAIN_ID", DEFAULT_CHAIN_ID),
            factory_address=_get("UNISWAP_V3_FACTORY", DEFAULT_FACTORY),
            poll_interval=_get_float("POLL_INTERVAL", 3.0),
            start_block=_get_optional_int("START_BLOCK"),
            lookback_blocks=_get_int("LOOKBACK_BLOCKS", 5000),
            max_block_range=_get_int("MAX_BLOCK_RANGE", 2000),
            quote_tokens=quote_tokens,
            risk=RiskThresholds(
                min_liquidity=_get_float("MIN_LIQUIDITY", 1.0),
                min_confidence=_get_float("MIN_CONFIDENCE", 0.7),
                max_risk_score=_get_float("MAX_RISK_SCORE", 0.5),
            ),
            decision_engine=_get("DECISION_ENGINE", ""),
            paper_trade_size=_get_float("PAPER_TRADE_SIZE", 0.1),
            paper_log_path=Path(_get("PAPER_LOG_PATH", "data/paper_trades.jsonl")),
            mark_interval=_get_float("MARK_INTERVAL", 15.0),
            recheck_delay=_get_float("RECHECK_DELAY", 20.0),
            recheck_attempts=_get_int("RECHECK_ATTEMPTS", 3),
            observe_delay=_get_float("OBSERVE_DELAY", 0.0),
        )
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.poll_interval <= 0:
            raise ValueError("POLL_INTERVAL must be > 0")
        if self.max_block_range <= 0:
            raise ValueError("MAX_BLOCK_RANGE must be > 0")
        if self.lookback_blocks < 0:
            raise ValueError("LOOKBACK_BLOCKS must be >= 0")
        if not 0.0 <= self.risk.min_confidence <= 1.0:
            raise ValueError("MIN_CONFIDENCE must be within [0, 1]")
        if not 0.0 <= self.risk.max_risk_score <= 1.0:
            raise ValueError("MAX_RISK_SCORE must be within [0, 1]")
        if self.risk.min_liquidity < 0:
            raise ValueError("MIN_LIQUIDITY must be >= 0")
        if self.observe_delay < 0:
            raise ValueError("OBSERVE_DELAY must be >= 0")
        if self.paper_trade_size <= 0:
            raise ValueError("PAPER_TRADE_SIZE must be > 0")
