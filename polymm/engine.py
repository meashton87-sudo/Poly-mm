"""The market-making loop: odds in -> fair -> guards -> risk -> quote -> orders.

Event driven and clock-injected (every handler takes `now`) so the same code
runs live, in replay, and in the simulator. Ordering principle: when in doubt
CANCEL FIRST, then recompute. A pulled quote costs you a little spread; a
stale quote during an injury costs you the max loss.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .exchange import Exchange
from .fair_value import BookQuote, FairEstimate, FairValueConfig, best_book_parlay_prob, estimate_leg
from .guards import GuardConfig, Guards
from .parlay import Pair, ParlayFair, _pair, parlay_fair
from .quoting import Quote, QuoteParams, make_quote
from .risk import MarketDef, Portfolio, RiskEngine, RiskLimits
from .toxicity import Fill, ToxicityConfig, ToxicityTracker


@dataclass
class ParlayMarket:
    market_id: str
    legs: tuple[str, ...]
    name: str = ""
    corr: dict[Pair, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.corr = {_pair(*k): v for k, v in self.corr.items()}


@dataclass
class MMConfig:
    fair: FairValueConfig = field(default_factory=FairValueConfig)
    quote: QuoteParams = field(default_factory=QuoteParams)
    risk: RiskLimits = field(default_factory=RiskLimits)
    guards: GuardConfig = field(default_factory=GuardConfig)
    toxicity: ToxicityConfig = field(default_factory=ToxicityConfig)
    corr_sigma: float = 0.1
    size_tolerance: float = 0.25  # don't replace an order for a small size change


@dataclass
class LiveOrder:
    order_id: str
    price: float
    size: float


class MarketMaker:
    def __init__(self, exchange: Exchange, markets: list[ParlayMarket], cfg: MMConfig | None = None):
        self.ex = exchange
        self.cfg = cfg or MMConfig()
        self.markets = {m.market_id: m for m in markets}
        self.portfolio = Portfolio()
        for m in markets:
            self.portfolio.add_market(MarketDef(m.market_id, m.legs))
        self.risk = RiskEngine(self.portfolio, self.cfg.risk)
        self.guards = Guards(self.cfg.guards)
        self.tox = ToxicityTracker(self.cfg.toxicity)

        self.book_quotes: dict[str, dict[str, BookQuote]] = {}
        self.parlay_prices: dict[str, dict[str, float]] = {}
        self.leg_est: dict[str, FairEstimate] = {}
        self.fairs: dict[str, ParlayFair] = {}
        self.quotes: dict[str, Quote] = {}
        self.orders: dict[tuple[str, str], LiveOrder] = {}
        self.pull_reasons: dict[str, list[str]] = {}
        self.log: list[str] = []

    # ----- inputs -------------------------------------------------------------

    def set_start_time(self, leg: str, ts: float) -> None:
        self.guards.start_times[leg] = ts

    def on_book_quote(self, q: BookQuote, now: float) -> None:
        self.on_book_quotes([q], now)

    def on_book_quotes(self, qs: list[BookQuote], now: float) -> None:
        """Batch update (e.g. one poll of the odds feed); requotes each market once."""
        legs = []
        for q in qs:
            self.book_quotes.setdefault(q.leg_id, {})[q.book] = q
            self.guards.on_feed_update(q.leg_id, now)
            if q.leg_id not in legs:
                legs.append(q.leg_id)
        mids = []
        for leg in legs:
            self.guards.on_estimate(self._estimate(leg, now), now)
            mids += [m for m in self._markets_with(leg) if m not in mids]
        for mid in mids:
            self.requote(mid, now)

    def on_parlay_price(self, market_id: str, book: str, american: float, now: float) -> None:
        self.parlay_prices.setdefault(market_id, {})[book] = american
        self.requote(market_id, now)

    def on_news(self, leg: str, now: float, note: str = "manual news") -> None:
        """Operator / news-feed hook: injury, lineup change, weather. Pull instantly."""
        self.guards.on_news(leg, now, note)
        for mid in self._markets_with(leg):
            self.pull(mid, [note])

    def on_fill(self, market_id: str, side: str, price: float, size: float, now: float,
                counterparty: str = "") -> None:
        self.portfolio.positions[market_id].apply_fill(side, price, size)
        o = self.orders.get((market_id, side))
        if o is not None:
            o.size -= size
            if o.size <= 1e-9:
                del self.orders[(market_id, side)]
        fair = self.fairs[market_id].p if market_id in self.fairs else price
        burst = self.tox.on_fill(Fill(now, market_id, side, price, size, fair, counterparty))
        self.log.append(f"[{now:8.1f}] FILL {market_id} {side} {size:.0f} @ {price:.3f} (fair {fair:.4f})")
        if burst:
            self.log.append(f"[{now:8.1f}] burst on {market_id} {side}: pulling that side")
            self._cancel(market_id, side)
        self.requote(market_id, now)

    def on_timer(self, now: float) -> None:
        self.tox.on_time(now, {m: f.p for m, f in self.fairs.items() if f.ok})
        if self.risk.check_kill({m: f.p for m, f in self.fairs.items() if f.ok}):
            for mid in self.markets:
                self.pull(mid, [f"KILL: {self.risk.kill_reason}"])
            return
        for mid in self.markets:
            self.requote(mid, now)

    # ----- core ---------------------------------------------------------------

    def _markets_with(self, leg: str) -> list[str]:
        return [mid for mid, m in self.markets.items() if leg in m.legs]

    def _estimate(self, leg: str, now: float) -> FairEstimate:
        est = estimate_leg(leg, self.book_quotes.get(leg, {}).values(), now, self.cfg.fair)
        self.leg_est[leg] = est
        return est

    def _leg_probs(self) -> dict[str, float] | None:
        legs = self.portfolio.leg_ids()
        if all(l in self.leg_est and self.leg_est[l].ok for l in legs):
            return {l: self.leg_est[l].p for l in legs}
        return None  # fall back to worst-case-only limits

    def _all_corr(self) -> dict[Pair, float]:
        out: dict[Pair, float] = {}
        for m in self.markets.values():
            out.update(m.corr)
        return out

    def requote(self, market_id: str, now: float) -> Quote | None:
        m = self.markets[market_id]
        problems = [f"KILL: {self.risk.kill_reason}"] if self.risk.killed else []
        ests = []
        for leg in m.legs:
            est = self._estimate(leg, now)
            ests.append(est)
            problems += [f"{leg}: {p}" for p in self.guards.leg_problems(leg, est, now)]
        if problems:
            self.pull(market_id, problems)
            return None

        pf = parlay_fair(ests, m.corr, self.cfg.corr_sigma)
        self.fairs[market_id] = pf
        best_book = best_book_parlay_prob(list(self.parlay_prices.get(market_id, {}).values()))
        if best_book is not None and pf.p >= best_book:
            # A book is offering better than our fair: our inputs are stale or that
            # book is off. Either way, don't trust ourselves right now.
            self.pull(market_id, [f"fair {pf.p:.4f} >= best book parlay {best_book:.4f}"])
            return None

        pos = self.portfolio.positions[market_id]
        qp = self.cfg.quote
        tox = self.tox.score(market_id)
        common = dict(fair=pf.p, sigma=pf.sigma_prob, params=qp, inventory=pos.yes_shares,
                      max_inventory=self.cfg.risk.max_position_shares, toxicity=tox,
                      best_book_prob=best_book)
        draft = make_quote(**common)

        leg_p, corr = self._leg_probs(), self._all_corr()
        max_bid = max_ask = 0.0
        if draft.bid is not None and not self.tox.side_blocked(market_id, "BUY", now):
            max_bid = self.risk.max_order_size(market_id, "BUY", draft.bid, leg_p, corr)
        if draft.ask is not None and not self.tox.side_blocked(market_id, "SELL", now):
            max_ask = self.risk.max_order_size(market_id, "SELL", draft.ask, leg_p, corr)
        q = make_quote(**common, max_bid_size=max_bid, max_ask_size=max_ask)

        self.quotes[market_id] = q
        self.pull_reasons.pop(market_id, None)
        self._sync(market_id, "BUY", q.bid, q.bid_size)
        self._sync(market_id, "SELL", q.ask, q.ask_size)
        return q

    def pull(self, market_id: str, reasons: list[str]) -> None:
        if self.pull_reasons.get(market_id) != reasons:
            self.log.append(f"PULL {market_id}: {'; '.join(reasons)}")
        self.pull_reasons[market_id] = reasons
        self.quotes.pop(market_id, None)
        self._cancel(market_id, "BUY")
        self._cancel(market_id, "SELL")

    def _cancel(self, market_id: str, side: str) -> None:
        o = self.orders.pop((market_id, side), None)
        if o is not None:
            self.ex.cancel(o.order_id)

    def _sync(self, market_id: str, side: str, price: float | None, size: float) -> None:
        cur = self.orders.get((market_id, side))
        if price is None or size <= 0:
            self._cancel(market_id, side)
            return
        if cur is not None and math.isclose(cur.price, price) and \
                abs(cur.size - size) <= self.cfg.size_tolerance * max(size, 1.0) and cur.size <= size:
            return  # close enough; avoid churn / rate limits
        self._cancel(market_id, side)
        oid = self.ex.place(market_id, side, price, size)
        self.orders[(market_id, side)] = LiveOrder(oid, price, size)

    # ----- reporting ----------------------------------------------------------

    def status(self) -> str:
        lines = []
        for mid, m in self.markets.items():
            pos = self.portfolio.positions[mid]
            head = f"{m.name or mid}: pos {pos.yes_shares:+.0f} YES, cash {pos.cash:+.2f}"
            if mid in self.quotes:
                lines.append(f"{head}\n    {self.quotes[mid].describe()}")
            else:
                lines.append(f"{head}\n    PULLED: {'; '.join(self.pull_reasons.get(mid, ['-']))}")
        return "\n".join(lines)
