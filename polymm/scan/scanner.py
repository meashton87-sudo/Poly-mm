"""Run every strategy over a market snapshot, rank, report, alert."""

from __future__ import annotations

import json
import urllib.request

from .sources import urlopen
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..odds import fmt_american
from .fees import FeeModel
from .matching import match_cross_venue
from .models import Contract, Opportunity
from .strategies import ScanConfig, calibration_value, cross_venue, multi_outcome_arbs, sportsbook_value

_CONF_RANK = {"arb": 0, "model": 1, "needs-verification": 2}


@dataclass
class Snapshot:
    contracts: list[Contract]
    odds_events: list[dict] = field(default_factory=list)
    mapping: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def scan(snap: Snapshot, cfg: ScanConfig | None = None, fees: FeeModel | None = None,
         now: datetime | None = None, calibration=None) -> list[Opportunity]:
    cfg, fees = cfg or ScanConfig(), fees or FeeModel()
    now = now or datetime.now(timezone.utc)
    live = [c for c in snap.contracts if c.tradable(now)]
    pairs = match_cross_venue(live, snap.mapping)
    book_priced: set[str] = set()
    opps = (multi_outcome_arbs(live, fees, cfg, now)
            + cross_venue(pairs, fees, cfg, now)
            + sportsbook_value(live, snap.odds_events, fees, cfg, now, matched=book_priced))
    opps += calibration_value(live, calibration, fees, cfg, now, skip=book_priced)
    if cfg.max_days is not None:
        opps = [o for o in opps if o.days_to_close is None or o.days_to_close <= cfg.max_days]
    # Best first: locked profit before model edges, then by annualised return
    # (a 2% arb resolving tomorrow beats a 4% arb resolving next year).
    opps.sort(key=lambda o: (_CONF_RANK.get(o.confidence, 3), -(o.annualized or o.roi)))
    return opps


def format_opportunity(o: Opportunity) -> str:
    head = f"[{o.kind} | {o.confidence}] {o.title}"
    stats = f"    edge ${o.edge:.3f}/unit  ROI {o.roi:6.1%}"
    if o.annualized is not None:
        stats += f"  ~{o.annualized:,.0%} annualised  ({o.days_to_close:.1f}d)"
    if o.fair is not None:
        stats += f"  fair {o.fair:.3f} ({fmt_american(o.fair)})"
    if o.kelly is not None:
        stats += f"  1/{round(1 / o.kelly_fraction)}-Kelly {o.kelly * o.kelly_fraction:.1%} of bankroll"
    if o.max_units is not None:
        stats += f"  size@price {o.max_units:,.0f}"
    lines = [head, stats]
    lines += [f"      {l.label}" + (f" (+fee {l.fee:.4f})" if l.fee else "") for l in o.legs]
    lines += [f"      - {n}" for n in o.notes]
    urls = sorted({l.contract.url for l in o.legs if l.contract.url})
    lines += [f"      {u}" for u in urls]
    return "\n".join(lines)


def _c(x: float) -> str:
    """Price in cents, e.g. 0.315 -> '31.5¢'."""
    v = x * 100
    return f"{v:.0f}¢" if abs(v - round(v)) < 0.05 else f"{v:.1f}¢"


def _venue(v: str) -> str:
    return {"polymarket": "Polymarket", "kalshi": "Kalshi"}.get(v, v)


def _what(l) -> str:
    c = l.contract
    if l.side == "YES":
        return c.outcome if c.outcome != "Yes" else "YES"
    return c.no_label if c.no_is_named_outcome else f"NO on '{c.outcome}'" if c.outcome != "Yes" else "NO"


def explain(o: Opportunity) -> dict:
    """Plain-English headline, summary and step list for one opportunity."""
    steps = [f"Buy {_what(l)} on {_venue(l.contract.venue)} at {_c(l.price)}"
             + (f" (+{_c(l.fee)} fee)" if l.fee >= 0.0005 else "") for l in o.legs]
    profit = f"{_c(o.edge)} profit per $1 payout ({o.roi:.1%} return)"
    if o.kind == "cross_venue_arb":
        headline = "Locked profit across Polymarket and Kalshi" if o.confidence == "arb" \
            else "Possible locked profit — confirm both markets ask the same question"
        summary = (f"These two bets cover both outcomes, so exactly one of them pays $1. "
                   f"Together they cost {_c(o.cost)} including fees: {profit}.")
        if o.confidence != "arb":
            summary = "IF both markets resolve the same way: " + summary[0].lower() + summary[1:]
    elif o.kind == "multi_outcome_arb":
        n = len(o.legs)
        if o.legs[0].side == "YES":
            headline = "Buy every outcome for less than $1"
            summary = (f"Buying YES on all {n} outcomes costs {_c(o.cost)} in total; whichever one happens pays $1: "
                       f"{profit}. Only safe if one of these {n} outcomes is certain to happen.")
        else:
            headline = f"Buy NO on all {n} outcomes for less than ${n - 1}"
            summary = (f"Buying NO on all {n} costs ${o.cost:.2f}; at most one outcome can happen, so at least "
                       f"{n - 1} NOs pay $1 each: {_c(o.edge)} profit per set ({o.roi:.1%}).")
    elif o.kind == "sportsbook_value":
        l = o.legs[0]
        headline = f"Priced below the sportsbooks: {_what(l)}"
        summary = (f"Sportsbooks (with their margin removed) give this a {o.fair:.1%} chance, "
                   f"but {_venue(l.contract.venue)} sells it at {_c(l.price)}. Expected profit "
                   f"{_c(o.edge)} per $1 share ({o.roi:.1%}). Not guaranteed: it's still a bet you can lose.")
    elif o.kind == "calibration_value":
        l = o.legs[0]
        headline = f"Historically underpriced: {_what(l)} at {_c(l.price)}"
        g = o.extra.get("group", "*")
        where = f"past {g} markets" if g not in ("*", "Other") else "past markets"
        summary = (f"Across {o.extra.get('markets', 0):,} {where} on {_venue(l.contract.venue)}, "
                   f"{l.side} contracts bought at about this price won {o.fair:.1%} of the time, "
                   f"but this one costs {_c(l.price)}. Expected {_c(o.edge)} per $1 share ({o.roi:.1%}) "
                   f"if this market behaves like the ones before it. A base rate, not a tip: "
                   f"spread small stakes over many of these.")
    else:  # cross_venue_value
        l = o.legs[0]
        other = "Kalshi" if l.contract.venue == "polymarket" else "Polymarket"
        headline = f"Cheaper on {_venue(l.contract.venue)} than on {other}"
        summary = (f"{other} prices this at about {o.fair:.1%}; {_venue(l.contract.venue)} sells it at {_c(l.price)}. "
                   f"Expected {_c(o.edge)} per $1 share ({o.roi:.1%}) if {other} is right. Not a locked profit.")
    if o.kelly:
        frac = "quarter" if o.kelly_fraction == 0.25 else "eighth"
        summary += f" Suggested stake: up to {o.kelly * o.kelly_fraction:.1%} of your bankroll ({frac}-Kelly)."
    return {"headline": headline, "summary": summary, "steps": steps}


def to_json(o: Opportunity) -> dict:
    return {
        **explain(o),
        "key": o.key,
        "category": o.legs[0].contract.category if o.legs else "Other",
        "kind": o.kind, "title": o.title, "confidence": o.confidence, "edge": round(o.edge, 5),
        "cost": round(o.cost, 5), "roi": round(o.roi, 5), "annualized": o.annualized,
        "days_to_close": o.days_to_close, "fair": o.fair, "kelly": o.kelly, "max_units": o.max_units,
        "notes": o.notes,
        "legs": [{"venue": l.contract.venue, "id": l.contract.id, "market": l.contract.title,
                  "side": l.side, "price": l.price,
                  "fee": l.fee, "label": l.label, "url": l.contract.url,
                  "token": l.contract.yes_token if l.side == "YES" else l.contract.no_token}
                 for l in o.legs],
    }


def post_webhook(url: str, opps: list[Opportunity]) -> None:
    """Discord/Slack-compatible incoming webhook (both accept {"content"}/{"text"})."""
    body = "\n\n".join(format_opportunity(o) for o in opps)[:1900]
    data = json.dumps({"content": body, "text": body}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    urlopen(req, timeout=10).read()


# ------------------------------------------------------------------ depth check

def executable_units(asks: list[tuple[float, float]], limit_price: float) -> float:
    """Shares available at or below limit_price. asks = [(price, size), ...]."""
    return sum(sz for px, sz in asks if px <= limit_price + 1e-12)


def enrich_depth(opps: list[Opportunity], top: int = 20) -> None:
    """Replace quoted top-of-book with real book depth for the best opportunities.

    Only legs priced at their quoted ask are counted, so the size reported is
    what you can actually fill without the edge shrinking.
    """
    from .sources import kalshi_book, polymarket_book

    for o in opps[:top]:
        sizes = []
        for l in o.legs:
            c = l.contract
            try:
                if c.venue == "polymarket":
                    tok = c.yes_token if l.side == "YES" else c.no_token
                    book = polymarket_book(tok)
                    asks = [(float(a["price"]), float(a["size"])) for a in book.get("asks", [])]
                else:
                    book = kalshi_book(c.id)
                    # YES asks are 1 - NO bids, and vice versa.
                    opp_side = "no" if l.side == "YES" else "yes"
                    lvls = book.get(f"{opp_side}_dollars") or [[p / 100, q] for p, q in book.get(opp_side) or []]
                    asks = [(round(1 - float(p), 4), float(q)) for p, q in lvls]
                sizes.append(executable_units(asks, l.price))
            except Exception as e:
                o.notes.append(f"depth check failed for {c.key}: {e}")
                sizes.append(None)
        if sizes and all(s is not None for s in sizes):
            o.max_units = min(sizes)
