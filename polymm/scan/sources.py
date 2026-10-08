"""Market data: Polymarket (Gamma + CLOB), Kalshi (trade-api v2), sportsbooks.

Parsers are pure functions over the venues' JSON so they can be tested and
run offline against saved snapshots; fetchers are thin urllib wrappers.
Field names follow the public docs as of 2026: Kalshi prices are the
`*_dollars` strings (legacy integer-cent fields are accepted as a fallback);
Polymarket Gamma ships `outcomes` / `outcomePrices` / `clobTokenIds` as JSON
encoded strings.
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Iterable

from .models import Contract

GAMMA = "https://gamma-api.polymarket.com"

# Progress messages from long fetches; the desktop app swaps this for its own logger.
progress = print
CLOB = "https://clob.polymarket.com"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"


def ssl_context() -> ssl.SSLContext | None:
    """Certificate verification that works on stock Windows/macOS Pythons.

    Python's bundled OpenSSL often can't see roots that the OS trusts (on
    Windows they're fetched lazily), giving CERTIFICATE_VERIFY_FAILED. If
    `truststore` is installed, verify with the OS itself; else use `certifi`'s
    bundle; else Python's default. Verification is never turned off.
    """
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        pass
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


_SSL = ssl_context()


def urlopen(req, timeout: float):
    return urllib.request.urlopen(req, timeout=timeout, context=_SSL)


def _get(url: str, params: dict | None = None, timeout: float = 15.0, retries: int = 3) -> object:
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "polymm-scanner/0.1", "Accept": "application/json"})
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:
            cert_error = isinstance(getattr(e, "reason", e), ssl.SSLCertVerificationError)
            if attempt == retries - 1 or cert_error:  # retrying won't fix a cert problem
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def _dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _f(x) -> float | None:
    if x is None or x == "":
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _jsonish(x) -> list:
    if isinstance(x, list):
        return x
    if isinstance(x, str) and x:
        try:
            return json.loads(x)
        except json.JSONDecodeError:
            return []
    return []


# --------------------------------------------------------------------- Polymarket

def parse_polymarket_markets(markets: Iterable[dict]) -> list[Contract]:
    out = []
    for m in markets:
        if m.get("closed") or m.get("active") is False or m.get("enableOrderBook") is False:
            continue
        if m.get("acceptingOrders") is False:
            continue  # trading halted / awaiting resolution: the "prices" are stale
        uma = str(m.get("umaResolutionStatus") or m.get("umaResolutionStatuses") or "").lower()
        if any(s in uma for s in ("proposed", "disputed", "resolved")):
            continue  # outcome already reported, just not finalised
        outcomes = _jsonish(m.get("outcomes"))
        tokens = _jsonish(m.get("clobTokenIds"))
        if len(outcomes) != 2:
            continue
        bid, ask = _f(m.get("bestBid")), _f(m.get("bestAsk"))
        bid = bid if bid is not None and 0 < bid < 1 else None
        ask = ask if ask is not None and 0 < ask < 1 else None  # None = nobody selling
        indicative = False
        if bid is None and ask is None:
            prices = [_f(p) for p in _jsonish(m.get("outcomePrices"))]
            if len(prices) != 2 or prices[0] is None:
                continue
            bid = ask = prices[0]
            indicative = True
        events = m.get("events") or [{}]
        ev = events[0] if isinstance(events[0], dict) else {}
        neg_risk = bool(m.get("negRisk"))
        is_yes_no = [o.lower() for o in outcomes] == ["yes", "no"]
        out.append(Contract(
            venue="polymarket",
            id=str(m.get("conditionId") or m.get("id") or m.get("slug")),
            title=m.get("question", ""),
            outcome=(m.get("groupItemTitle") or outcomes[0]) if is_yes_no else outcomes[0],
            no_label="No" if is_yes_no else outcomes[1],
            no_is_named_outcome=not is_yes_no,
            yes_bid=bid,
            yes_ask=ask,
            group=(m.get("negRiskMarketID") or ev.get("id")) if neg_risk else None,
            group_title=ev.get("title", "") if neg_risk else "",
            exhaustive=None,
            close_time=_dt(m.get("endDate") or m.get("gameStartTime")),
            volume=_f(m.get("volumeNum") or m.get("volume")) or 0.0,
            url=f"https://polymarket.com/event/{ev.get('slug') or m.get('slug', '')}",
            yes_token=str(tokens[0]) if len(tokens) == 2 else None,
            no_token=str(tokens[1]) if len(tokens) == 2 else None,
            indicative=indicative,
        ))
    return out


def fetch_polymarket(max_pages: int = 150, page_size: int = 500, min_volume: float = 0.0) -> list[dict]:
    """Page through every open market, highest volume first.

    Gamma silently caps `limit` (100 per page in practice), so a short page is
    not the end: advance by what we actually got and stop on an empty page.
    """
    base = {"active": "true", "closed": "false", "limit": page_size, "volume_num_min": min_volume}
    order = {"order": "volume24hr", "ascending": "false"}
    rows: dict[str, dict] = {}
    offset = 0
    for page in range(max_pages):
        try:
            batch = _get(f"{GAMMA}/markets", {**base, **order, "offset": offset})
        except Exception:
            if not order:
                raise
            order = {}  # sort field not accepted: fall back to default order
            batch = _get(f"{GAMMA}/markets", {**base, "offset": offset})
        if not batch:
            break
        before = len(rows)
        for m in batch:
            rows[str(m.get("id") or m.get("conditionId"))] = m
        if len(rows) == before:
            break  # offset ignored / looping on the same page
        offset += len(batch)
        if page % 10 == 9:
            progress(f"  ... {len(rows)} Polymarket markets so far")
    return list(rows.values())


def polymarket_book(token_id: str) -> dict:
    """{'bids': [{'price','size'}...], 'asks': [...]} for one outcome token."""
    return _get(f"{CLOB}/book", {"token_id": token_id})


# --------------------------------------------------------------------- Kalshi

def _kalshi_price(m: dict, name: str) -> float | None:
    v = _f(m.get(f"{name}_dollars"))
    if v is None:
        cents = _f(m.get(name))
        v = cents / 100 if cents is not None else None
    return v if v and 0 < v < 1 else None


def parse_kalshi_events(events: Iterable[dict]) -> list[Contract]:
    out = []
    for ev in events:
        et = ev.get("event_ticker", "")
        if et.upper().startswith("KXMVE"):
            continue  # multivariate combos (Kalshi's parlays); skip
        mutex = bool(ev.get("mutually_exclusive"))
        series = (ev.get("series_ticker") or et.split("-")[0]).lower()
        for m in ev.get("markets") or []:
            if m.get("status") not in (None, "active", "open"):
                continue
            ask, bid = _kalshi_price(m, "yes_ask"), _kalshi_price(m, "yes_bid")
            if ask is None and bid is None and not mutex:
                continue
            # Keep price-less members of a mutually exclusive set: dropping them
            # would make the rest look like a cheap "complete" set.
            out.append(Contract(
                venue="kalshi",
                id=m["ticker"],
                title=m.get("title") or ev.get("title", ""),
                outcome=m.get("yes_sub_title") or "Yes",
                no_label=f"not {m.get('yes_sub_title') or 'Yes'}",
                yes_bid=bid,
                yes_ask=ask,
                yes_ask_size=_f(m.get("yes_ask_size_fp")),
                yes_bid_size=_f(m.get("yes_bid_size_fp")),
                group=et if mutex else None,
                group_title=ev.get("title", "") if mutex else "",
                exhaustive=None,
                # Resolution (for game dates / days locked) vs when trading actually stops.
                close_time=_dt(m.get("expected_expiration_time") or m.get("close_time")),
                trading_close=_dt(m.get("close_time")),
                volume=_f(m.get("volume_fp") or m.get("volume")) or 0.0,
                url=f"https://kalshi.com/markets/{series}",
            ))
    return out


def fetch_kalshi(max_pages: int = 200) -> list[dict]:
    events, cursor = [], None
    for page in range(max_pages):
        if page % 10 == 9:
            progress(f"  ... {len(events)} Kalshi events so far")
        params = {"status": "open", "with_nested_markets": "true", "limit": 200}
        if cursor:
            params["cursor"] = cursor
        resp = _get(f"{KALSHI}/events", params)
        events += resp.get("events", [])
        cursor = resp.get("cursor")
        if not cursor:
            break
    return events


def kalshi_book(ticker: str) -> dict:
    """Kalshi books only list bids; YES asks are implied by NO bids (1 - p)."""
    return _get(f"{KALSHI}/markets/{ticker}/orderbook").get("orderbook", {})


# --------------------------------------------------------------------- sportsbooks

DEFAULT_SPORTS = (
    "americanfootball_nfl", "americanfootball_ncaaf", "basketball_nba", "basketball_ncaab",
    "baseball_mlb", "icehockey_nhl", "soccer_epl", "soccer_uefa_champs_league", "mma_mixed_martial_arts",
)


def fetch_odds_api_h2h(api_key: str, sports: Iterable[str] = DEFAULT_SPORTS,
                       regions: str = "us,us2,eu") -> list[dict]:
    out = []
    for s in sports:
        try:
            out += _get(f"https://api.the-odds-api.com/v4/sports/{s}/odds",
                        {"apiKey": api_key, "regions": regions, "markets": "h2h", "oddsFormat": "american"})
        except Exception as e:  # one bad sport shouldn't kill the scan
            progress(f"  [odds-api] {s}: {e}")
    return out
