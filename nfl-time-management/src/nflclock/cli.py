"""Command-line interface.

  nflclock build                      fit every model (downloads nflverse data if needed)
  nflclock validate                   simulator vs. real outcomes
  nflclock analyze                    grade every 2023-25 clock decision
  nflclock report                     build the HTML report
  nflclock decide --qtr 4 --clock 2:31 --score 20-24 --ball us --down 2 --ytg 7 --yardline "opp 41" \\
                  --timeouts 2-3 --running --us KC --them BUF
"""
from __future__ import annotations

import argparse
import sys

import pandas as pd


def _decide(a):
    from .decide import DecisionEngine, Situation, parse_clock, parse_yardline
    us_score, them_score = (int(x) for x in a.score.split("-"))
    to_us, to_them = (int(x) for x in a.timeouts.split("-"))
    overrides = {}
    if a.kicker_rating is not None:
        overrides.setdefault("us", {})["kicker_rating"] = a.kicker_rating
    if a.punter_rating is not None:
        overrides.setdefault("us", {})["punter_rating"] = a.punter_rating
    sit = Situation(
        qtr=a.qtr, clock=parse_clock(a.clock), score_us=us_score, score_them=them_score,
        possession=a.ball, down=a.down, ytg=a.ytg, yardline=parse_yardline(a.yardline),
        to_us=to_us, to_them=to_them, clock_running=a.running, us_home=not a.away, phase=a.phase,
        us=a.us, them=a.them, spread_us=a.spread, receive_2h=a.receive_2h, indoor=a.indoor,
        wind=a.wind, temp=a.temp, overrides=overrides,
    )
    eng = DecisionEngine()
    df = eng.evaluate(sit, n=a.sims)
    us, them = df.attrs.get("us"), df.attrs.get("them")
    print(f"\nSituation: Q{a.qtr} {a.clock} | {a.us or 'us'} {us_score} - {them_score} {a.them or 'them'} | "
          f"ball: {a.ball} | {a.down}&{a.ytg} at {a.yardline} | TO {to_us}-{to_them} | "
          f"clock {'running' if a.running else 'stopped'}")
    if us is not None:
        print(f"  {us.team}: pass off {us.off_pass:+.3f} rush off {us.off_rush:+.3f} | pass def {us.def_pass:+.3f} "
              f"rush def {us.def_rush:+.3f} (EPA/play; defense + = worse) | K {us.kicker} ({us.kicker_rating:+.2f}) "
              f"P {us.punter} ({us.punter_rating:+.1f} yds)")
        print(f"  {them.team}: pass off {them.off_pass:+.3f} rush off {them.off_rush:+.3f} | pass def "
              f"{them.def_pass:+.3f} rush def {them.def_rush:+.3f}")
    print(f"  ratings as of {eng.ratings_asof[0]} week {eng.ratings_asof[1]}; {a.sims} simulations per option\n")
    show = df.copy()
    show["win_prob"] = (show["win_prob"] * 100).map("{:.1f}%".format)
    show["vs_best"] = (show["vs_best"] * 100).map("{:+.1f}".format)
    show["se"] = (show["se"] * 100).map("±{:.1f}".format)
    print(show.to_string(index=False))
    print(f"\nRecommendation: {df.iloc[0]['option']}")


def _grades(a):
    from . import config
    from .report import CLOCK_FAMILIES, FAMILY_LABEL, OPTION_LABEL, _situation
    path = config.REPORT_DIR / "all_graded_decisions.csv.gz"
    if not path.exists():
        print("No graded decisions yet: run `nflclock analyze` and `python scripts/make_report.py` first.")
        return
    df = pd.read_csv(path)
    team = a.team.upper()
    t = df[(df["team"] == team) & df["decision"].isin(CLOCK_FAMILIES)]
    if a.season:
        t = t[t["season"] == a.season]
    if t.empty:
        print(f"No graded clock decisions for {team}.")
        return
    t = t.assign(cost=t["gain"].where(t["actual"] != t["recommended"], 0.0))
    print(f"\n{team} clock and game-management report card")
    by = t.groupby("season").agg(coach=("coach", lambda x: x.mode().iat[0]), graded=("cost", "size"),
                                 mistakes=("sig_error", "sum"), wins_lost=("cost", "sum"))
    league = df[df["decision"].isin(CLOCK_FAMILIES)]
    league = league.assign(cost=league["gain"].where(league["actual"] != league["recommended"], 0.0))
    lg = league.groupby(["season", "team"])["cost"].sum().groupby("season").mean()
    by["league_avg"] = lg.reindex(by.index)
    print(by.round(2).to_string())
    fam = t.groupby("decision").agg(graded=("cost", "size"), mistakes=("sig_error", "sum"), wins_lost=("cost", "sum"))
    fam.index = fam.index.map(FAMILY_LABEL)
    print("\nBy decision type:")
    print(fam.sort_values("wins_lost", ascending=False).round(2).to_string())
    worst = t[t["sig_error"]].sort_values("gain", ascending=False).head(a.top)
    if len(worst):
        print(f"\nCostliest {len(worst)} decisions:")
        for _, r in worst.iterrows():
            print(f"  {r['season']} wk {int(r['week'])} vs {r['opp']}: {_situation(r)} -- chose "
                  f"{OPTION_LABEL[r['actual']]}, better: {OPTION_LABEL[r['recommended']]} "
                  f"(+{r['gain'] * 100:.1f} WP pts)")


def main(argv=None):
    p = argparse.ArgumentParser(prog="nflclock", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    sub.add_parser("validate")
    an = sub.add_parser("analyze")
    an.add_argument("--sims", type=int, default=600)
    an.add_argument("--games", type=int, default=None)
    sub.add_parser("report")
    g = sub.add_parser("grades", help="a team's graded clock decisions (after the analysis has run)")
    g.add_argument("--team", required=True)
    g.add_argument("--season", type=int, default=None)
    g.add_argument("--top", type=int, default=8)
    d = sub.add_parser("decide")
    d.add_argument("--qtr", type=int, required=True)
    d.add_argument("--clock", required=True, help="time left in quarter, e.g. 2:31")
    d.add_argument("--score", required=True, help="us-them, e.g. 20-24")
    d.add_argument("--ball", choices=["us", "them"], default="us")
    d.add_argument("--down", type=int, default=1)
    d.add_argument("--ytg", type=float, default=10)
    d.add_argument("--yardline", default="own 25", help="'own 25', 'opp 30' or yards to goal")
    d.add_argument("--timeouts", default="3-3", help="us-them")
    d.add_argument("--running", action="store_true", help="clock is running")
    d.add_argument("--away", action="store_true", help="we are the away team")
    d.add_argument("--phase", choices=["snap", "pat", "kickoff"], default="snap")
    d.add_argument("--us")
    d.add_argument("--them")
    d.add_argument("--spread", type=float, default=None, help="pregame spread from our view (+ favoured)")
    d.add_argument("--receive-2h", dest="receive_2h", choices=["us", "them"], default="them")
    d.add_argument("--indoor", action="store_true")
    d.add_argument("--wind", type=float, default=0.0)
    d.add_argument("--temp", type=float, default=65.0)
    d.add_argument("--kicker-rating", type=float, default=None, help="override our kicker (logit shift)")
    d.add_argument("--punter-rating", type=float, default=None, help="override our punter (net yds over avg)")
    d.add_argument("--sims", type=int, default=4000)
    a = p.parse_args(argv)
    if a.cmd == "decide":
        _decide(a)
    elif a.cmd == "grades":
        _grades(a)
    elif a.cmd == "build":
        from . import data
        from .decide import PERSONNEL_PATH, build_personnel
        from .models import build
        import json
        b = build()
        b.save()
        pbp = data.load(tuple(sorted(set(range(2016, 2027)))))
        PERSONNEL_PATH.write_text(json.dumps(build_personnel(b, pbp), indent=1))
    elif a.cmd == "validate":
        import runpy
        runpy.run_path(str(_scripts() / "validate_sim.py"), run_name="__main__")
    elif a.cmd == "analyze":
        from . import analyze, config
        res = analyze.run(n=a.sims, limit_games=a.games)
        res.to_parquet(config.CACHE_DIR / "decisions.parquet")
    elif a.cmd == "report":
        import runpy
        runpy.run_path(str(_scripts() / "make_report.py"), run_name="__main__")
    return 0


def _scripts():
    from pathlib import Path
    return Path(__file__).resolve().parents[2] / "scripts"


if __name__ == "__main__":
    sys.exit(main())
