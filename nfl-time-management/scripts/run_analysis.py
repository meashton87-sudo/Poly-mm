"""Grade every clock-critical decision; save to data/cache/decisions*.parquet.

usage: python scripts/run_analysis.py [sims=600] [--seasons 2023,2024,2025] [--games N] [--families a,b]
"""
import argparse
import time

from nflclock import analyze, config

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("sims", nargs="?", type=int, default=600)
    p.add_argument("--seasons", default=",".join(str(s) for s in config.ANALYSIS_SEASONS))
    p.add_argument("--games", type=int, default=None, help="random sample of games (for a quick look)")
    p.add_argument("--families", default=None, help="comma-separated decision families")
    a = p.parse_args()
    seasons = [int(s) for s in a.seasons.split(",")]
    families = a.families.split(",") if a.families else None
    t0 = time.time()
    res = analyze.run(seasons=seasons, n=a.sims, workers=4, limit_games=a.games, families=families)
    if seasons == config.ANALYSIS_SEASONS and a.games is None and families is None:
        name = "decisions.parquet"
    else:
        name = f"decisions_{'-'.join(map(str, seasons))}{'_sample' if a.games else ''}" \
               f"{'_' + '-'.join(families) if families else ''}.parquet"
    out = config.CACHE_DIR / name
    res.to_parquet(out)
    print(f"saved {len(res)} graded decisions to {out} in {time.time() - t0:.0f}s")
