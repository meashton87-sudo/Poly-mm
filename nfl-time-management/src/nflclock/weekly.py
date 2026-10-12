"""Scenario cards for the worst clock decisions of a given week."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config
from .report import FAMILY_LABEL, OPTION_LABEL, _clock_str, _situation
from .tendency import letter_for


def _explain(r) -> str:
    fam, act, rec = r["decision"], r["actual"], r["recommended"]
    q = int(r["qtr"])
    sec_q = r["game_seconds_remaining"] - (4 - q) * 900 if q <= 4 else r["game_seconds_remaining"]
    clock = _clock_str(sec_q)
    gain = r["gain"] * 100
    offense = r["team"] == r["posteam"]
    margin = r["margin_off"] if offense else -r["margin_off"]
    trail = f"down {int(-margin)}" if margin < 0 else ("tied" if margin == 0 else f"up {int(margin)}")
    if fam == "def_timeout" and rec == "timeout":
        return (f"{r['team']} was {trail} on defense with {clock} left and let the clock run. A timeout right "
                f"after the whistle saves roughly 35-40 seconds for its own final possession; the simulator "
                f"values that time at {gain:.1f} win-probability points more than holding the timeout.")
    if fam == "def_timeout" and rec == "no_timeout":
        return (f"{r['team']} burned a timeout with {clock} left. Here the timeout was worth more later "
                f"(the two-minute warning or a later stop does the same job), by {gain:.1f} points.")
    if fam == "off_clock_stop":
        what = {"hurry": "hurried to the line without stopping the clock", "spike": "spiked the ball",
                "timeout": "called timeout"}[act]
        better = {"hurry": "snap a real play quickly", "spike": "spike it", "timeout": "call timeout"}[rec]
        return (f"Needing points, {r['team']} {what} with {clock} left ({trail}). The better move was to {better}: "
                f"+{gain:.1f} points of win probability, mostly from the seconds and downs it preserves.")
    if fam == "fourth_down":
        dist = int(r["yardline_100"]) + 17
        kick = f" (a {dist}-yard try for {r['kicker']})" if rec == "fg" or act == "fg" else ""
        return (f"On 4th and {int(r['ydstogo'])} with {clock} left ({trail}), {r['team']} chose to "
                f"{OPTION_LABEL[act]}{kick}. Simulating the rest of the game from this exact spot, "
                f"{OPTION_LABEL[rec]} wins {gain:.1f} points more often with these offenses, defenses and specialists.")
    if fam == "kneel":
        return (f"{r['team']} could have run out the clock with kneel-downs ({trail}, {clock} left) but ran a real "
                f"play, adding fumble and clock risk for nothing: {gain:.1f} points.")
    if fam == "h1_end":
        return (f"With {clock} left before halftime, {r['team']} chose to {OPTION_LABEL[act]}; "
                f"{OPTION_LABEL[rec]} was worth {gain:.1f} points of win probability from this field position "
                f"and timeout count.")
    if fam == "pat":
        return (f"After the touchdown ({trail} before the try), {r['team']} chose to {OPTION_LABEL[act]}. "
                f"The two-point chart for this margin and time says {OPTION_LABEL[rec]}: +{gain:.1f} points.")
    if fam == "onside":
        return (f"Trailing with {clock} left, {r['team']} chose a {OPTION_LABEL[act]}; a {OPTION_LABEL[rec]} "
                f"was worth {gain:.1f} points given the timeouts and the opponent's ability to run out the clock.")
    if fam == "lead_tempo":
        return (f"Leading with {clock} left, {r['team']} snapped with time left on the play clock. Milking it "
                f"would have taken more time off for {gain:.1f} points.")
    if fam == "play_select":
        return (f"With {clock} left ({trail}), {r['team']} chose to {OPTION_LABEL[act]}. Against this defense, "
                f"{OPTION_LABEL[rec]} was worth {gain:.1f} points.")
    return f"{OPTION_LABEL.get(rec, rec)} was worth {gain:.1f} points more."


def worst_of_week(graded: pd.DataFrame, season: int, week: int, scale: dict | None, top: int = 15,
                  pbp: pd.DataFrame | None = None) -> list[dict]:
    g = graded[(graded["season"] == season) & (graded["week"] == week) & graded["sig_error"]].copy()
    g = g.sort_values("gain", ascending=False).head(top)
    cards = []
    for _, r in g.iterrows():
        letter, pct = (letter_for(scale, r["decision"], float(r["gain"])) if scale else ("?", float("nan")))
        opts = {c[3:]: float(r[c]) for c in r.index if c.startswith("wp_") and c != "wp_actual" and not pd.isna(r[c])}
        final = None
        if pbp is not None:
            gm = pbp[pbp["game_id"] == r["game_id"]]
            if len(gm):
                hs, as_ = gm["home_score"].iloc[0], gm["away_score"].iloc[0]
                final = f"{r['away_team']} {int(as_)}, {r['home_team']} {int(hs)}"
        cards.append({
            "key": f"{r['game_id']}#{int(r['play_id'])}", "game_id": r["game_id"], "decision": r["decision"],
            "matchup": f"{r['away_team']} at {r['home_team']}", "team": r["team"], "coach": r["coach"],
            "family": FAMILY_LABEL[r["decision"]], "situation": _situation(r), "chose": OPTION_LABEL[r["actual"]],
            "better": OPTION_LABEL[r["recommended"]], "cost": float(r["gain"]), "se": float(r["gain_se"]),
            "grade": letter, "percentile": pct, "options": {OPTION_LABEL.get(k, k): v for k, v in opts.items()},
            "play": r["desc"], "why": _explain(r), "final": final,
        })
    return cards


def write_week(season: int, week: int, top: int = 15) -> list[dict]:
    from .report import load_graded
    graded = load_graded()
    scale_p = config.ARTIFACT_DIR / "grade_scale.json"
    scale = json.loads(scale_p.read_text()) if scale_p.exists() else None
    from . import data
    pbp = data.load(tuple(range(2016, season + 1)))
    pbp = pbp[(pbp["season"] == season) & (pbp["week"] == week)]
    cards = worst_of_week(graded, season, week, scale, top, pbp)
    out = config.REPORT_DIR / f"worst_decisions_{season}_wk{week:02d}.json"
    out.write_text(json.dumps(cards, indent=1, default=float))
    md = [f"# Worst clock decisions, {season} week {week}", ""]
    for i, c in enumerate(cards, 1):
        md += [f"## {i}. {c['team']} ({c['coach']}), {c['matchup']}: {c['family'].lower()}",
               f"*{c['situation']}* · final: {c['final']}",
               "",
               f"- Chose **{c['chose']}**; better: **{c['better']}** (+{c['cost'] * 100:.1f} ± {c['se'] * 100:.1f} WP points)",
               f"- Grade **{c['grade']}**: worse than {c['percentile']:.0%} of 2023-25 NFL decisions of this type",
               "- Simulated win probability: " + ", ".join(f"{k} {v:.1%}" for k, v in sorted(c['options'].items(), key=lambda kv: -kv[1])),
               f"- Play: {c['play']}",
               f"- Why: {c['why']}", ""]
    (config.REPORT_DIR / f"worst_decisions_{season}_wk{week:02d}.md").write_text("\n".join(md))
    return cards
