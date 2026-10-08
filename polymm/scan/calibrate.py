"""Build calibration.json from the prediction-market-analysis dataset.

    pip install duckdb zstandard
    python -m polymm.scan.calibrate --archive data.tar.zst
    python -m polymm.scan.calibrate --archive https://s3.jbecker.dev/data.tar.zst
    python -m polymm.scan.calibrate --data C:/path/to/prediction-market-analysis/data

Tip: the archive is ~36 GB. Downloading it first in a browser or download
manager (which can resume) and passing the file is more robust than streaming
the URL directly.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .calibration import ALL, Calibration, build_from_archive, build_from_dir

DATASET_URL = "https://s3.jbecker.dev/data.tar.zst"


def summarize(cal: dict) -> str:
    c = Calibration(cal, min_markets=1)
    lines = [f"{cal['total_positions']:,} market-price observations from {cal['files']}"]
    for venue in cal["tables"]:
        lines.append(f"\n{venue}: historical win rate of the side bought, by price (all markets)")
        lines.append("   price    YES won    NO won")
        for cents in (5, 10, 20, 30, 50, 70, 80, 90, 95):
            cells = []
            for side in ("yes", "no"):
                w = c.win_prob(venue, side, cents / 100, ALL)
                cells.append(f"{w.p:8.1%}" if w else "       -")
            lines.append(f"   {cents:3d}¢  {cells[0]}  {cells[1]}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--archive", help=f"data.tar.zst path or URL (dataset: {DATASET_URL})")
    src.add_argument("--data", help="an already-extracted dataset 'data' directory")
    ap.add_argument("--out", default="calibration.json")
    args = ap.parse_args()

    try:
        import duckdb  # noqa: F401
        if args.archive:
            import zstandard  # noqa: F401
    except ImportError as e:
        sys.exit(f"missing dependency ({e.name}). Run:  python -m pip install duckdb zstandard")

    t0 = time.time()
    log = lambda m: print(m, flush=True)
    if args.archive:
        out_dir = Path(args.out).resolve().parent
        cal = build_from_archive(args.archive, out_dir, log)
    else:
        cal = build_from_dir(args.data, log)
    if not cal["tables"]:
        sys.exit("no Kalshi or Polymarket market+trade files found; is this the right dataset?")
    Path(args.out).write_text(json.dumps(cal))
    print(f"\nwrote {args.out} in {(time.time() - t0) / 60:.1f} min")
    print(summarize(cal))


if __name__ == "__main__":
    main()
