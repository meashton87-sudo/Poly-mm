"""Grade every clock-critical decision in the analysis seasons; save to data/cache/decisions.parquet."""
import sys
import time

from nflclock import analyze, config

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else None
    t0 = time.time()
    res = analyze.run(n=n, workers=4, limit_games=limit)
    out = config.CACHE_DIR / ("decisions.parquet" if limit is None else "decisions_sample.parquet")
    res.to_parquet(out)
    print(f"saved {len(res)} graded decisions to {out} in {time.time() - t0:.0f}s")
