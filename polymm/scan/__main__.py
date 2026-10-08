"""Prediction-market value scanner.

    python -m polymm.scan --offline                 # demo on bundled snapshot
    python -m polymm.scan --save-snapshot snap/     # live scan, keep raw data for replay
    python -m polymm.scan                           # live Polymarket + Kalshi
    ODDS_API_KEY=... python -m polymm.scan          # + sportsbook value
    python -m polymm.scan --watch 60 --webhook URL  # loop, alert on new finds
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from .fees import FeeModel
from .matching import load_mapping
from .scanner import Snapshot, enrich_depth, format_opportunity, post_webhook, scan, to_json
from .sources import (fetch_kalshi, fetch_odds_api_h2h, fetch_polymarket, parse_kalshi_events,
                      parse_polymarket_markets)
from .strategies import ScanConfig

FIXTURES = Path(__file__).parent / "fixtures"
OFFLINE_NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)


def _fetch(name: str, fn) -> list:
    """One venue being down (or blocked) shouldn't stop the scan of the others."""
    print(f"fetching {name}...", flush=True)
    try:
        rows = fn()
    except Exception as e:
        print(f"  !! {name} failed: {e}")
        if "CERTIFICATE_VERIFY_FAILED" in str(e):
            print("     fix: python -m pip install truststore   (then run the scan again)")
        return []
    print(f"  got {len(rows)} rows")
    return rows


def load_snapshot(args) -> Snapshot:
    if args.offline:
        d = Path(args.offline)
        read = lambda n: json.loads((d / n).read_text()) if (d / n).exists() else []
        pm, ks, odds = read("polymarket_markets.json"), read("kalshi_events.json"), read("odds_api_h2h.json")
        mapping = load_mapping(args.mapping) if args.mapping else read("mapping.json")
    else:
        key = args.odds_api_key or os.environ.get("ODDS_API_KEY")
        pm = _fetch("Polymarket", lambda: fetch_polymarket(min_volume=args.min_volume)) \
            if "polymarket" in args.venues else []
        ks = _fetch("Kalshi", fetch_kalshi) if "kalshi" in args.venues else []
        odds = _fetch("The Odds API", lambda: fetch_odds_api_h2h(key)) if key else []
        mapping = load_mapping(args.mapping) if args.mapping else []
        if args.save_snapshot:
            d = Path(args.save_snapshot)
            d.mkdir(parents=True, exist_ok=True)
            for name, obj in (("polymarket_markets", pm), ("kalshi_events", ks), ("odds_api_h2h", odds)):
                (d / f"{name}.json").write_text(json.dumps(obj))
    contracts = parse_polymarket_markets(pm) + parse_kalshi_events(ks)
    contracts = [c for c in contracts if c.volume >= args.min_volume]
    return Snapshot(contracts, odds, mapping)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", nargs="?", const=str(FIXTURES), metavar="DIR",
                    help="scan a saved snapshot (default: bundled sample) instead of live APIs")
    ap.add_argument("--venues", default="polymarket,kalshi")
    ap.add_argument("--odds-api-key")
    ap.add_argument("--mapping", help="JSON file of confirmed Polymarket<->Kalshi pairs")
    ap.add_argument("--min-arb-edge", type=float, default=0.005)
    ap.add_argument("--min-value-edge", type=float, default=0.02)
    ap.add_argument("--min-volume", type=float, default=0.0)
    ap.add_argument("--max-days", type=float, help="skip markets resolving later than this")
    ap.add_argument("--kalshi-fee-rate", type=float, default=0.07)
    ap.add_argument("--polymarket-fee-rate", type=float, default=0.0)
    ap.add_argument("--hide-unverified", action="store_true", help="drop fuzzy cross-venue matches")
    ap.add_argument("--depth", action="store_true", help="check real order-book depth for top results")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--json", help="write results to this file")
    ap.add_argument("--save-snapshot", help="dir to save raw API responses (replay with --offline DIR)")
    ap.add_argument("--watch", type=float, help="rescan every N seconds")
    ap.add_argument("--webhook", help="Discord/Slack webhook for NEW opportunities")
    args = ap.parse_args()

    cfg = ScanConfig(min_arb_edge=args.min_arb_edge, min_value_edge=args.min_value_edge,
                     max_days=args.max_days)
    fees = FeeModel(kalshi_rate=args.kalshi_fee_rate, polymarket_rate=args.polymarket_fee_rate)
    seen: set[str] = set()
    while True:
        snap = load_snapshot(args)
        opps = scan(snap, cfg, fees, now=OFFLINE_NOW if args.offline == str(FIXTURES) else None)
        if args.hide_unverified:
            opps = [o for o in opps if o.confidence != "needs-verification"]
        opps = opps[:args.top]
        if args.depth and not args.offline:
            enrich_depth(opps)
        n_pm = sum(c.venue == "polymarket" for c in snap.contracts)
        print(f"\n=== {datetime.now():%H:%M:%S}  scanned {n_pm} Polymarket + "
              f"{len(snap.contracts) - n_pm} Kalshi contracts, {len(snap.odds_events)} sportsbook events: "
              f"{len(opps)} opportunities ===\n")
        for o in opps:
            print(format_opportunity(o) + "\n")
        if args.json:
            Path(args.json).write_text(json.dumps([to_json(o) for o in opps], indent=2, default=str))
        new = [o for o in opps if o.key not in seen]
        seen |= {o.key for o in opps}
        if args.webhook and new:
            post_webhook(args.webhook, new)
        if not args.watch:
            break
        time.sleep(args.watch)


if __name__ == "__main__":
    main()
