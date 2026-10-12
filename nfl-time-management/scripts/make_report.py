"""Sensitivity analysis, decision charts and report tables from graded decisions."""
import sys
import time

import pandas as pd

from nflclock import analyze, charts, config, report

if __name__ == "__main__":
    skip_sens = "--no-sensitivity" in sys.argv
    t0 = time.time()
    graded = report.load_graded()
    sens_path = config.CACHE_DIR / "sensitivity.parquet"
    sens = None
    if not skip_sens:
        if sens_path.exists():
            sens = pd.read_parquet(sens_path)
        else:
            print("sensitivity: re-grading 4th downs and run/pass calls with league-average teams ...", flush=True)
            raw = pd.read_parquet(config.CACHE_DIR / "decisions.parquet")
            sens = analyze.sensitivity(raw)
            sens.to_parquet(sens_path)
    if not (config.REPORT_DIR / "decision_charts.json").exists() or "--charts" in sys.argv:
        print("decision charts ...", flush=True)
        charts.build_all()
    out = report.write_tables(graded, sens)
    print(report.markdown_summary(out))
    if "sensitivity" in out:
        print(out["sensitivity"].to_string())
    print(f"done in {time.time() - t0:.0f}s")
