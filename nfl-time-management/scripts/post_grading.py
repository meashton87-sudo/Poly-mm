"""After grading: percentile grade scales, coach-tendency models, coach profiles, live-tool game files.

usage: python scripts/post_grading.py [game_id ...]
"""
import sys

from nflclock import config, data, report, tendency, webexport

if __name__ == "__main__":
    graded = report.load_graded()
    core = graded[graded["season"].isin(config.ANALYSIS_SEASONS)]
    scale, tend = tendency.build_all(core)
    for fam, f in scale["families"].items():
        print(f"{fam:15s} n={f['n']:5d} optimal={f['share_optimal']:.0%}  cost at 90th/95th/99th pct: "
              f"{tendency.np.quantile(f['q'], 0.90) * 100:.2f} / {tendency.np.quantile(f['q'], 0.95) * 100:.2f} / "
              f"{tendency.np.quantile(f['q'], 0.99) * 100:.2f} WP pts")
    for fam, m in tend["families"].items():
        print(f"tendency {fam:15s} n={m['n']:5d} classes={m['classes']} shares={ {k: round(v, 2) for k, v in m['share'].items()} }")
    out = report.summarize(graded)
    pbp = data.load(tuple(range(2016, 2027)))
    prof = tendency.coach_profiles(pbp, out["by_coach"])
    print(f"coach profiles: {len(prof['coaches'])}")
    for gid in sys.argv[1:] or ["2026_05_BUF_LA"]:
        webexport.export_game(gid)
        print("exported", gid)
