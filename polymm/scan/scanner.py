"""Run every strategy over a market snapshot, rank, report, alert."""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..odds import fmt_american
from .fees import FeeModel
from .matching import match_cross_venue
from .models import Contract, Opportunity
from .strategies import ScanConfig, cross_venue, multi_outcome_arbs, sportsbook_value

_CONF_RANK = {"arb": 0, "model": 1, "needs-verification": 2}


@dataclass
class Snapshot:
    contracts: list[Contract]
    odds_events: list[dict] = field(default_factory=list)
    mapping: list[dict] = field(default_factory=list)


def scan(snap: Snapshot, cfg: ScanConfig | None = None, fees: FeeModel | None = None,
         now: datetime | None = None) -> list[Opportunity]:
    cfg, fees = cfg or ScanConfig(), fees or FeeModel()
    now = now or datetime.now(timezone.utc)
    live = [c for c in snap.contracts if c.close_time is None or c.close_time > now]
    pairs = match_cross_venue(live, snap.mapping)
    opps = (multi_outcome_arbs(live, fees, cfg, now)
            + cross_venue(pairs, fees, cfg, now)
            + sportsbook_value(live, snap.odds_events, fees, cfg, now))
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
        stats += f"  1/4-Kelly {o.kelly / 4:.1%} of bankroll"
    if o.max_units is not None:
        stats += f"  size@price {o.max_units:,.0f}"
    lines = [head, stats]
    lines += [f"      {l.label}" + (f" (+fee {l.fee:.4f})" if l.fee else "") for l in o.legs]
    lines += [f"      - {n}" for n in o.notes]
    urls = sorted({l.contract.url for l in o.legs if l.contract.url})
    lines += [f"      {u}" for u in urls]
    return "\n".join(lines)


def to_json(o: Opportunity) -> dict:
    return {
        "kind": o.kind, "title": o.title, "confidence": o.confidence, "edge": round(o.edge, 5),
        "cost": round(o.cost, 5), "roi": round(o.roi, 5), "annualized": o.annualized,
        "days_to_close": o.days_to_close, "fair": o.fair, "kelly": o.kelly, "max_units": o.max_units,
        "notes": o.notes,
        "legs": [{"venue": l.contract.venue, "id": l.contract.id, "side": l.side, "price": l.price,
                  "fee": l.fee, "label": l.label, "url": l.contract.url,
                  "token": l.contract.yes_token if l.side == "YES" else l.contract.no_token}
                 for l in o.legs],
    }


def post_webhook(url: str, opps: list[Opportunity]) -> None:
    """Discord/Slack-compatible incoming webhook (both accept {"content"}/{"text"})."""
    body = "\n\n".join(format_opportunity(o) for o in opps)[:1900]
    data = json.dumps({"content": body, "text": body}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()


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
