"""Everything after grading: grades/tendencies/coach profiles, weekly cards, backtests, game card, exports.

usage: python scripts/finalize.py [--week 5] [--season 2026] [--game 2026_05_BUF_LA] [--skip-card] [--skip-backtest]
"""
import argparse
import json
import time

from nflclock import backtest, config, data, gamecard, report, tendency, webexport, weekly

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, default=2026)
    p.add_argument("--week", type=int, default=5)
    p.add_argument("--game", default="2026_05_BUF_LA")
    p.add_argument("--skip-card", action="store_true")
    p.add_argument("--skip-backtest", action="store_true")
    a = p.parse_args()
    t0 = time.time()
    graded = report.load_graded()
    core = graded[graded["season"].isin(config.ANALYSIS_SEASONS)]
    print("grade scales + tendency models ...", flush=True)
    tendency.build_all(core)
    out = report.summarize(graded)
    pbp = data.load(tuple(range(2016, a.season + 1)))
    print("coach profiles ...", flush=True)
    tendency.coach_profiles(pbp, out["by_coach"])
    print(f"worst decisions {a.season} week {a.week} ...", flush=True)
    cards = weekly.write_week(a.season, a.week)
    for c in cards[:8]:
        print(f"  {c['team']:>3} {c['grade']} +{c['cost'] * 100:4.1f}  {c['matchup']}: {c['situation']} -- chose {c['chose']}, better {c['better']}")
    print("confirmation pass on headline mistakes (fresh seeds, 4,000 sims per option) ...", flush=True)
    from nflclock import analyze
    import pandas as pd
    top = report.summarize(graded)["top"]
    keys = list(top["key"].head(40)) + [c["key"] for c in cards]
    conf = analyze.confirm(graded, keys, n=4000)
    conf["confirmed"] = (conf["confirm_rec"] != conf["actual"]) & (conf["confirm_gain"] > 2 * conf["confirm_se"])
    conf.to_csv(config.REPORT_DIR / "confirmations.csv", index=False)
    print(f"  confirmed {int(conf['confirmed'].sum())} of {len(conf)}")
    cmap = conf.set_index("key")
    for c in cards:
        if c["key"] in cmap.index:
            r = cmap.loc[c["key"]]
            c.update(confirmed=bool(r["confirmed"]), confirm_gain=float(r["confirm_gain"]), confirm_se=float(r["confirm_se"]))
    wk = config.REPORT_DIR / f"worst_decisions_{a.season}_wk{a.week:02d}.json"
    wk.write_text(json.dumps(cards, indent=1, default=float))
    if not a.skip_backtest:
        print("backtests ...", flush=True)
        bt = backtest.run_all(core.assign(sig_error=core["sig_error"]), pbp)
        print(json.dumps({k: v for k, v in bt["decision_outcome"].items() if k != "table"}, indent=1, default=float)[:1500])
        if "out_of_sample" in bt:
            print("out of sample", {k: v for k, v in bt["out_of_sample"].items() if k in ("season", "sim_wp_home", "model_wp_home", "nflfastr_wp_home")})
    if not a.skip_card:
        print(f"game card {a.game} ...", flush=True)
        gamecard.build(a.game)
    print("report tables + dashboard datasets ...", flush=True)
    sens_p = config.CACHE_DIR / "sensitivity.parquet"
    import pandas as pd
    sens = pd.read_parquet(sens_p) if sens_p.exists() else None
    out = report.write_tables(graded, sens)
    report.export_dashboard_files(out)
    webexport.export_game(a.game)
    print(f"done in {time.time() - t0:.0f}s")
