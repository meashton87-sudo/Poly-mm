"""Normalised view of a binary contract on any prediction market venue."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Contract:
    """One binary contract. Prices are dollars per $1 payout (= probability).

    On Polymarket and Kalshi the NO side is the same order book as YES, so
    no_ask = 1 - yes_bid and no_bid = 1 - yes_ask.
    """

    venue: str  # "polymarket" | "kalshi"
    id: str  # Polymarket condition id / slug, Kalshi market ticker
    title: str  # the full question
    outcome: str  # what YES means: "Yes", "Buccaneers", "25 bps cut", ...
    yes_bid: float | None
    yes_ask: float | None
    no_label: str = "No"  # what NO means, for display
    # True only when NO is itself a named outcome (Polymarket "Bucs vs Lions":
    # NO on Buccaneers == YES on Lions). Kalshi's no_sub_title repeats the YES
    # text, so a Kalshi NO is never "the other team".
    no_is_named_outcome: bool = False
    yes_ask_size: float | None = None
    yes_bid_size: float | None = None
    group: str | None = None  # mutually exclusive set this contract belongs to
    group_title: str = ""
    exhaustive: bool | None = None  # does the group cover every outcome? None = unknown
    close_time: datetime | None = None  # when it resolves (money is locked until then)
    trading_close: datetime | None = None  # when trading stops, if earlier/known
    volume: float = 0.0
    url: str = ""
    yes_token: str | None = None  # Polymarket CLOB token ids
    no_token: str | None = None
    indicative: bool = False  # prices are last/mid, not a live top of book
    category: str = "Other"  # Sports / Weather / Crypto / Politics / ...

    @property
    def no_ask(self) -> float | None:
        return None if self.yes_bid is None else round(1 - self.yes_bid, 6)

    @property
    def no_bid(self) -> float | None:
        return None if self.yes_ask is None else round(1 - self.yes_ask, 6)

    @property
    def mid(self) -> float | None:
        if self.yes_bid is None or self.yes_ask is None:
            return None
        return (self.yes_bid + self.yes_ask) / 2

    def ask(self, side: str) -> float | None:
        return self.yes_ask if side == "YES" else self.no_ask

    @property
    def key(self) -> str:
        return f"{self.venue}:{self.id}"

    def tradable(self, now: datetime) -> bool:
        end = self.trading_close or self.close_time
        return end is None or end > now


@dataclass
class Leg:
    contract: Contract
    side: str  # "YES" | "NO"
    price: float  # ask we pay
    fee: float  # per contract

    @property
    def label(self) -> str:
        what = self.contract.outcome if self.side == "YES" else self.contract.no_label
        return f"BUY {self.side} '{what}' on {self.contract.venue} @ {self.price:.3f}"


@dataclass
class Opportunity:
    kind: str  # multi_outcome_arb | cross_venue_arb | cross_venue_value | sportsbook_value | calibration_value
    title: str
    legs: list[Leg]
    edge: float  # $ expected (arb: guaranteed) profit per $1-payout unit, after fees
    cost: float  # $ paid per unit incl. fees
    fair: float | None = None  # model probability (value trades)
    confidence: str = "arb"  # arb | needs-verification | model
    days_to_close: float | None = None
    max_units: float | None = None  # executable size at quoted prices, if known
    notes: list[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)  # strategy-specific detail for explanations

    @property
    def kelly_fraction(self) -> float:
        """How much of full Kelly we suggest: base rates are noisier than book prices."""
        return 0.125 if self.kind == "calibration_value" else 0.25

    @property
    def roi(self) -> float:
        return self.edge / self.cost if self.cost > 0 else 0.0

    @property
    def annualized(self) -> float | None:
        """Simple annualised return for locked trades (capital is tied up until
        resolution). Meaningless for one-off model edges, so None there."""
        if self.days_to_close is None or not self.kind.endswith("arb"):
            return None
        return self.roi * 365 / max(self.days_to_close, 0.5)

    @property
    def kelly(self) -> float | None:
        """Full-Kelly bankroll fraction for single-leg value bets."""
        if self.fair is None or len(self.legs) != 1:
            return None
        a = self.cost
        return max(0.0, (self.fair - a) / (1 - a)) if a < 1 else 0.0

    @property
    def key(self) -> str:
        return self.kind + "|" + "|".join(f"{l.contract.key}:{l.side}" for l in self.legs)
