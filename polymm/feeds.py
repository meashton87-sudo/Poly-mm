"""Odds feed adapters.

`parse_odds_api_event` turns a The Odds API (the-odds-api.com, v4) event
payload into BookQuotes for one leg. Polling REST is fine for pre-game; for
live you want a push feed (OddsJam, OpticOdds, Unabated, direct book scrapes):
latency is the whole game there.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from .fair_value import BookQuote


@dataclass(frozen=True)
class LegSelector:
    """Which outcome of which market is our leg.

    Moneyline:   LegSelector("bucs_ml", "h2h", "Tampa Bay Buccaneers")
    Player prop: LegSelector("irving_pts", "player_points", "Over",
                             description="Kyrie Irving", point=24.5)
    """

    leg_id: str
    market_key: str
    outcome: str
    description: str | None = None
    point: float | None = None


def _ts(s: str | None, default: float) -> float:
    if not s:
        return default
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def parse_odds_api_event(event: dict, sel: LegSelector, now: float) -> list[BookQuote]:
    out = []
    for bm in event.get("bookmakers", []):
        for mkt in bm.get("markets", []):
            if mkt.get("key") != sel.market_key:
                continue
            outs = mkt.get("outcomes", [])
            if sel.description is not None:
                outs = [o for o in outs if o.get("description") == sel.description]
            if sel.point is not None:
                outs = [o for o in outs if o.get("point") is not None and abs(abs(o["point"]) - abs(sel.point)) < 1e-9]
            ours = [o for o in outs if o.get("name") == sel.outcome]
            others = [o for o in outs if o.get("name") != sel.outcome]
            if len(ours) != 1 or not others:
                continue
            prices = (float(ours[0]["price"]),) + tuple(float(o["price"]) for o in others)
            ts = _ts(mkt.get("last_update") or bm.get("last_update"), now)
            out.append(BookQuote(bm["key"], sel.leg_id, prices, min(ts, now)))
    return out


def fetch_odds_api(path: str, params: dict, api_key: str | None = None, timeout: float = 5.0) -> object:
    key = api_key or os.environ["ODDS_API_KEY"]
    q = urllib.parse.urlencode({**params, "apiKey": key, "oddsFormat": "american"})
    from .scan.sources import urlopen  # OS-trusted SSL (see ssl_context)

    with urlopen(f"https://api.the-odds-api.com/v4/{path}?{q}", timeout=timeout) as r:
        return json.load(r)


def poll_leg(sport: str, event_id: str, sel: LegSelector, now: float,
             regions: str = "us,us2,eu") -> Iterable[BookQuote]:
    event = fetch_odds_api(f"sports/{sport}/events/{event_id}/odds",
                           {"regions": regions, "markets": sel.market_key})
    return parse_odds_api_event(event, sel, now)
