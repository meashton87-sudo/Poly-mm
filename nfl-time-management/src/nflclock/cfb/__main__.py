"""python -m nflclock.cfb build: Coach mode's college (and high-school) data, end to end.

  download + prune (cached)  ->  normalize + enrich (cached)  ->  artifacts/bundle_cfb.pkl  ->  web/engine_data_cfb.json
  -> web/cfb_overlay.json (needs web/playbook.json: run after dailygame.build)  ->  tendency  ->  drills + difficulty
  -> web/coach.json, web/drills/c<k>.json  ->  the high-school level (web/engine_data_hs.json, web/coach_hs.json,
  web/drills/hs_c<k>.json)  ->  artifacts/cfb_build_report.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from .. import config as C
from . import config as K


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m nflclock.cfb")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="download, fit and export everything")
    b.add_argument("--rules", default="ncaa2026", help="ruleset the drills are played under")
    b.add_argument("--diff-rules", default="auto",
                   help="ruleset for difficulty: auto = --rules when the simulator has rulesets (WS1), else nfl (provisional)")
    b.add_argument("--refresh-current", action="store_true", help="download the current season again")
    b.add_argument("--no-difficulty", action="store_true", help="skip the difficulty simulations (diff 3 everywhere)")
    b.add_argument("--no-hs", action="store_true", help="skip the high-school level")
    b.add_argument("--workers", type=int, default=4)
    d = sub.add_parser("difficulty", help="recompute difficulty only (e.g. once GameContext(rules) lands): one flag re-run")
    d.add_argument("--rules", default="ncaa2026")
    d.add_argument("--hs-rules", default="nfhs")
    d.add_argument("--workers", type=int, default=4)
    d.add_argument("--level", default="all", choices=["cfb", "hs", "all"])
    a = ap.parse_args(argv)
    from . import build as B
    t0 = time.time()
    if a.cmd == "build":
        rep = B.build(rules=a.rules, diff_rules=a.diff_rules, refresh_current=a.refresh_current,
                      difficulty=not a.no_difficulty, hs=not a.no_hs, workers=a.workers)
    else:
        rep = {lv: B.redo_difficulty(rules=a.rules if lv == "cfb" else a.hs_rules, workers=a.workers, level=lv)
               for lv in (("cfb", "hs") if a.level == "all" else (a.level,))}
    rep["seconds"] = round(time.time() - t0, 1)
    C.ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    (C.ARTIFACT_DIR / "cfb_build_report.json").write_text(json.dumps(rep, indent=1, default=str))
    print(json.dumps({k: rep[k] for k in ("seconds", "sizes", "drills_by_category") if k in rep}, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
