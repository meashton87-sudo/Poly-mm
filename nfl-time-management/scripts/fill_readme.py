"""Write the latest validation, grading and example results into README.md (re-runnable).

usage: python scripts/fill_readme.py
"""
import json
import re
import subprocess
import sys

import pandas as pd

from nflclock import config, report

README = config.ROOT / "README.md"
R = config.REPORT_DIR
NAMES = {"sim_wp_home": "nflclock simulator", "model_wp_home": "nflclock WP model", "nflfastr_wp_home": "nflfastR (public)"}
DRIVE_NAMES = {"end_of_1st_half": "End of 1st half", "trailing_4q_final5": "Trailing, final 5:00",
               "leading_4q_final5": "Leading, final 5:00"}


def put(text: str, key: str, block: str) -> str:
    """Replace the bare placeholder once, then the marked block on later runs."""
    marked = f"<!-- {key}:start -->\n{block.strip()}\n<!-- {key}:end -->"
    pat = re.compile(rf"<!-- {key}:start -->.*?<!-- {key}:end -->", re.S)
    if pat.search(text):
        return pat.sub(lambda _: marked, text)
    fenced = f"```\n{key}\n```"   # a placeholder inside a code fence: replace the fence too
    if fenced in text:
        return text.replace(fenced, marked, 1)
    return text.replace(key, marked, 1)


def validation_block() -> str:
    cal = json.loads((R / "validation_calibration.json").read_text())
    lines = ["Late-game win probability on real 4th-quarter snaps (final 10:00, one-score games), 2023–2025:", "",
             "| Model | Log loss | Brier | Calibration error | Snaps |", "|---|---:|---:|---:|---:|"]
    for k, name in NAMES.items():
        if k in cal:
            m = cal[k]
            lines.append(f"| {name} | {m['logloss']:.4f} | {m['brier']:.4f} | {m['ece']:.3f} | {m['n']:,} |")
    drv = pd.read_csv(R / "validation_drives.csv")
    lines += ["", "Drive replay: real drives restarted in the simulator from their first snap.", "",
              "| Drives | Count | TD real | TD sim | FG real | FG sim | Plays real | Plays sim |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for _, r in drv.iterrows():
        lines.append(f"| {DRIVE_NAMES.get(r['category'], r['category'])} | {int(r['drives']):,} | {r['real_td']:.1%} | "
                     f"{r['sim_td']:.1%} | {r['real_fg']:.1%} | {r['sim_fg']:.1%} | {r['real_plays']:.1f} | {r['sim_plays']:.1f} |")
    bk = R / "backtests.json"
    if bk.exists():
        b = json.loads(bk.read_text())
        oos = b.get("out_of_sample")
        if oos:
            lines += ["", f"**True holdout, {oos['season']} season** (every model was fit through 2025):", "",
                      "| Model | Log loss | Brier | Snaps |", "|---|---:|---:|---:|"]
            for k, name in NAMES.items():
                if k in oos:
                    lines.append(f"| {name} | {oos[k]['logloss']:.4f} | {oos[k]['brier']:.4f} | {oos[k]['n']:,} |")
        rows = b.get("decision_outcome", {}).get("by_choice", [])
        if rows:
            lines += ["", "**Calibrated on what coaches chose.** The simulator's win probability for the option a coach "
                      "actually took, against how often that team won (2023–2025). A bias against punting, spiking "
                      "or kicking would show up as teams winning more often than predicted.", "",
                      "| Decision: option chosen | Decisions | Predicted | Actual | z |", "|---|---:|---:|---:|---:|"]
            for r in sorted(rows, key=lambda r: (r["family"], -r["n"])):
                label = f"{report.FAMILY_LABEL.get(r['family'], r['family'])}: {report.OPTION_LABEL.get(r['choice'], r['choice'])}"
                lines.append(f"| {label} | {r['n']:,} | {r['mean_predicted']:.1%} | {r['actual_win_rate']:.1%} | {r['z']:+.1f} |")
    return "\n".join(lines)


def playbook_block() -> str:
    """A few concrete findings from the precomputed decision charts (league-average teams)."""
    ch_p = R / "decision_charts.json"
    if not ch_p.exists():
        return ""
    ch = json.loads(ch_p.read_text())
    clock = lambda t: f"{int(t) // 60}:{int(t) % 60:02d}"
    out = ["", "Playbook findings from the simulator (league-average teams; full charts in the report):", ""]
    ld = [r for r in ch.get("leading_defense_timeouts", []) if r["def_lead"] == 1 and r["kick_yards"] == 42]
    if ld:
        r = max(ld, key=lambda r: r["edge"])
        out.append(f"- **Ahead by 1 on defense, opponent lined up for a 42-yard try with {clock(r['t'])} left:** "
                   f"letting the clock run wins {r['wp_run']:.0%} of the time; spending timeouts after each play so "
                   f"you get the ball back wins {r['wp_save']:.0%}.")
    dt = [r for r in ch.get("defensive_timeouts", []) if r["opp_lead"] == 3 and r["def_to"] == 3]
    if dt:
        r = max(dt, key=lambda r: r["edge"])
        out.append(f"- **Down 3 on defense with three timeouts:** calling one right after a 1st-down run is worth "
                   f"{r['edge'] * 100:+.1f} win-probability points at {clock(r['t'])} (largest in the chart).")
    tp = {(r["t"], r["margin"]): r for r in ch.get("two_point", [])}
    if (180, -2) in tp and (180, 1) in tp:
        a, b = tp[(180, -2)], tp[(180, 1)]
        out.append(f"- **Two-point tries at 3:00:** down 2 after the touchdown, going for two is worth "
                   f"{a['edge'] * 100:+.1f} points; up 1, {b['edge'] * 100:+.1f}.")
    return "\n".join(out)


def summary_block() -> str:
    graded = report.load_graded()
    out = report.summarize(graded)
    lines = [report.markdown_summary(out), ""]
    conf_p = R / "confirmations.csv"
    top = out["top"].head(8).copy()
    if conf_p.exists():
        conf = pd.read_csv(conf_p).drop_duplicates(["key", "decision"])
        top = top.merge(conf[["key", "decision", "confirmed", "confirm_gain"]], on=["key", "decision"], how="left")
    lines += ["Costliest clear mistakes (each re-simulated with fresh seeds and 4,000 games per option):", "",
              "| Game | Coach | Situation | Chose | Better | Cost (WP pts) | Confirmed |", "|---|---|---|---|---|---:|---|"]
    for _, r in top.iterrows():
        ok = "yes" if r.get("confirmed") is True or r.get("confirmed") == 1 else ("no" if r.get("confirmed") is False or r.get("confirmed") == 0 else "—")
        lines.append(f"| {r['matchup']} | {r['coach']} | {r['situation']} | {r['choice']} | {r['better']} | "
                     f"{r['gain'] * 100:.1f} | {ok} |")
    wk = R / "worst_decisions_2026_wk05.json"
    if wk.exists():
        cards = json.loads(wk.read_text())[:6]
        lines += ["", "Worst calls of 2026 week 5 (full cards in `reports/worst_decisions_2026_wk05.md`):", ""]
        for c in cards:
            conf = " (confirmed)" if c.get("confirmed") else ""
            lines.append(f"- **{c['team']}** ({c['coach']}), {c['matchup']}: {c['situation']}. Chose {c['chose']}, "
                         f"better {c['better']}: {c['grade']}, +{c['cost'] * 100:.1f} WP points{conf}.")
    prof = config.ARTIFACT_DIR / "coach_profiles.json"
    if prof.exists():
        p = json.loads(prof.read_text())
        coaches = p.get("coaches", p)
        pick = {k: v for k, v in coaches.items() if k in ("Sean McDermott", "Sean McVay")} if isinstance(coaches, dict) else {}
        if pick:
            lines += ["", "Tonight's head coaches:", ""]
            for name, v in pick.items():
                ag = v.get("aggressiveness_pct")
                cq = v.get("clock_quality_pct")
                lines.append(f"- **{name}**: 4th-down aggressiveness {ag:.0%} percentile"
                             + (f", clock management {cq:.0%} percentile" if cq is not None else "") + ".")
    return "\n".join(lines)


def example_block() -> str:
    cmd = [sys.executable, "-I", "-m", "nflclock.cli", "decide", "--qtr", "4", "--clock", "2:31", "--score", "20-24",
           "--ball", "us", "--down", "2", "--ytg", "7", "--yardline", "opp 41", "--timeouts", "2-3", "--running",
           "--us", "BUF", "--them", "LA", "--away", "--indoor"]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=config.ROOT, timeout=900)
    return res.stdout.strip() or res.stderr.strip()[-2000:]


if __name__ == "__main__":
    text = README.read_text()
    text = put(text, "RESULTS_VALIDATION", validation_block())
    text = put(text, "RESULTS_SUMMARY", summary_block() + "\n" + playbook_block())
    text = put(text, "EXAMPLE_DECIDE", "```\n" + example_block() + "\n```")
    README.write_text(text)
    print("README updated")
