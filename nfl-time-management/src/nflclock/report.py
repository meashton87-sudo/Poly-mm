"""Turn graded decisions into report tables (CSV/JSON in reports/) and a markdown summary."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config

FAMILY_LABEL = {
    "def_timeout": "Defensive timeouts (trailing late / before half)",
    "off_clock_stop": "Offense stopping the clock (timeout / spike / hurry)",
    "lead_tempo": "Leading offense burning play clock",
    "kneel": "Kneel-down when the game can be iced",
    "h1_end": "End of 1st half: attack vs. run it out",
    "fourth_down": "Late 4th downs: go / FG / punt",
    "onside": "Onside vs. deep kick (trailing late)",
    "pat": "Late PAT: kick vs. two",
    "play_select": "Clock-critical run vs. pass",
}
CLOCK_FAMILIES = [k for k in FAMILY_LABEL if k != "play_select"]
OPTION_LABEL = {
    "timeout": "timeout", "no_timeout": "let clock run", "hurry": "hurry to the line", "spike": "spike",
    "as_played": "snapped early", "milk": "milk play clock", "kneel": "kneel", "run_play": "run a play",
    "attack": "attack", "runout": "run out the half", "go": "go for it", "fg": "field goal", "punt": "punt",
    "onside": "onside kick", "deep": "deep kick", "xp": "kick PAT", "two": "go for two", "run": "run",
    "pass": "pass",
}


def load_graded(path=None, include_current: bool = True) -> pd.DataFrame:
    """Graded decisions for the analysis seasons, plus the current season to date if it was graded."""
    df = pd.read_parquet(path or config.CACHE_DIR / "decisions.parquet")
    current = sorted(config.CACHE_DIR.glob("decisions_20[2-9][0-9].parquet"))
    if include_current and path is None and current:
        df = pd.concat([df] + [pd.read_parquet(c) for c in current], ignore_index=True)
        df = df.drop_duplicates(["game_id", "play_id", "decision"])
    df["is_rec"] = df["recommended"] == df["actual"]
    df["sig_error"] = (~df["is_rec"]) & (df["gain"] > 2 * df["gain_se"]) & (df["gain"] > 0.005)
    df["wp_cost"] = np.where(df["is_rec"], 0.0, df["gain"])  # cross-fit estimate, signed
    df["opp"] = np.where(df["team"] == df["home_team"], df["away_team"], df["home_team"])
    return df


def _clock_str(sec_in_qtr) -> str:
    sec_in_qtr = max(0, int(round(sec_in_qtr)))
    return f"{sec_in_qtr // 60}:{sec_in_qtr % 60:02d}"


def _situation(r) -> str:
    q = int(r["qtr"])
    sec_q = r["game_seconds_remaining"] - (4 - q) * 900 if q <= 4 else r["game_seconds_remaining"]
    margin = r["margin_off"] if r["team"] == r["posteam"] else -r["margin_off"]
    if r["decision"] == "onside":
        margin = -r["margin_off"]
    score = "tied" if margin == 0 else (f"up {int(margin)}" if margin > 0 else f"down {int(-margin)}")
    s = f"Q{q} {_clock_str(sec_q)}, {score}"
    if r["decision"] in ("pat", "onside"):
        return s
    if not np.isnan(r["down"]):
        yl = r["yardline_100"]
        spot = f"own {int(100 - yl)}" if yl > 50 else ("midfield" if yl == 50 else f"opp {int(yl)}")
        side = "" if r["team"] == r["posteam"] else " (opponent ball)"
        s += f", {int(r['down'])}&{int(r['ydstogo'])} at {spot}{side}"
    return s


def summarize(df_all: pd.DataFrame) -> dict:
    """League tables use the complete analysis seasons; the team table also lists the current season."""
    df = df_all[df_all["season"].isin(config.ANALYSIS_SEASONS)]
    fam = df.groupby("decision").agg(
        decisions=("gain", "size"), agree=("is_rec", "mean"), sig_errors=("sig_error", "sum"),
        wins_lost=("wp_cost", "sum"),
    )
    fam["cost_per_sig_error"] = df[df["sig_error"]].groupby("decision")["gain"].mean()
    fam["label"] = fam.index.map(FAMILY_LABEL)
    fam = fam.reset_index().sort_values("wins_lost", ascending=False)
    # what the most common mistake is, per family
    common = (df[df["sig_error"]].groupby(["decision", "actual", "recommended"]).size()
              .rename("n").reset_index().sort_values("n", ascending=False).drop_duplicates("decision"))
    common["pattern"] = common.apply(
        lambda r: f"{OPTION_LABEL[r['actual']]} instead of {OPTION_LABEL[r['recommended']]}", axis=1)
    fam = fam.merge(common[["decision", "pattern", "n"]].rename(columns={"n": "pattern_n"}), on="decision", how="left")

    clock = df[df["decision"].isin(CLOCK_FAMILIES)]
    games = df["game_id"].nunique()
    team_games = df.groupby("season")["game_id"].nunique().sum() * 2
    clock_all = df_all[df_all["decision"].isin(CLOCK_FAMILIES)]
    by_team = clock_all.groupby(["season", "team"]).agg(
        coach=("coach", lambda x: x.mode().iat[0]), decisions=("gain", "size"), sig_errors=("sig_error", "sum"),
        wins_lost=("wp_cost", "sum")).reset_index()
    by_team["error_rate"] = by_team["sig_errors"] / by_team["decisions"]
    by_coach = clock.groupby("coach").agg(
        teams=("team", lambda x: "/".join(sorted(set(x)))), seasons=("season", "nunique"),
        games=("game_id", "nunique"), decisions=("gain", "size"), sig_errors=("sig_error", "sum"),
        wins_lost=("wp_cost", "sum")).reset_index()
    by_coach = by_coach[by_coach["games"] >= 17]
    by_coach["wins_lost_per_17"] = by_coach["wins_lost"] / by_coach["games"] * 17
    by_coach["error_rate"] = by_coach["sig_errors"] / by_coach["decisions"]

    top = df[df["sig_error"]].sort_values("gain", ascending=False).head(40).copy()
    top["situation"] = top.apply(_situation, axis=1)
    top["matchup"] = top.apply(lambda r: f"{r['season']} wk {int(r['week'])}: {r['team']} vs {r['opp']}", axis=1)
    top["choice"] = top["actual"].map(OPTION_LABEL)
    top["better"] = top["recommended"].map(OPTION_LABEL)
    top["key"] = top["game_id"] + "#" + top["play_id"].astype(int).astype(str)
    top = top[["key", "matchup", "coach", "decision", "situation", "choice", "better", "gain", "gain_se",
               "wp_actual", "desc"]]

    headline = {
        "games": int(games), "team_games": int(team_games), "decisions": int(len(df)),
        "clock_decisions": int(len(clock)),
        "agree_rate_clock": float(clock["is_rec"].mean()),
        "sig_errors_clock": int(clock["sig_error"].sum()),
        "wins_lost_clock": float(clock["wp_cost"].sum()),
        "wins_lost_clock_per_team_season": float(
            clock["wp_cost"].sum() / max(1, clock.groupby(["season", "team"]).ngroups)),
        "wins_lost_play_select": float(df.loc[df["decision"] == "play_select", "wp_cost"].sum()),
    }
    return {"families": fam, "by_team": by_team, "by_coach": by_coach, "top": top, "headline": headline}


def write_tables(df: pd.DataFrame, sens: pd.DataFrame | None = None) -> dict:
    out = summarize(df)
    config.REPORT_DIR.mkdir(exist_ok=True)
    out["families"].to_csv(config.REPORT_DIR / "decision_families.csv", index=False)
    out["by_team"].sort_values(["season", "wins_lost"]).to_csv(config.REPORT_DIR / "team_seasons.csv", index=False)
    out["by_coach"].sort_values("wins_lost_per_17").to_csv(config.REPORT_DIR / "coaches.csv", index=False)
    out["top"].to_csv(config.REPORT_DIR / "costliest_decisions.csv", index=False)
    cols = ["game_id", "play_id", "season", "week", "team", "opp", "coach", "decision", "actual", "recommended",
            "gain", "gain_se", "sig_error", "wp_actual", "qtr", "game_seconds_remaining", "posteam", "margin_off",
            "down", "ydstogo", "yardline_100", "desc"]
    df[cols].to_csv(config.REPORT_DIR / "all_graded_decisions.csv.gz", index=False, compression="gzip")
    if sens is not None and len(sens):
        s = sens.groupby("decision").agg(decisions=("flipped", "size"), flipped=("flipped", "mean"),
                                         value=("value_of_team_info", "sum")).reset_index()
        s.to_csv(config.REPORT_DIR / "team_variable_sensitivity.csv", index=False)
        out["sensitivity"] = s
        fd = sens[sens["decision"] == "fourth_down"].copy()
        if len(fd):
            fd["kicker_tier"] = pd.cut(fd["kicker_rating"], [-9, -0.1, 0.1, 9], labels=["below avg", "average", "above avg"])
            k = fd.groupby("kicker_tier", observed=True).apply(
                lambda g: pd.Series({"n": len(g), "fg_rec": (g["recommended"] == "fg").mean(),
                                     "fg_rec_neutral": (g["rec_neutral"] == "fg").mean()}), include_groups=False)
            k.reset_index().to_csv(config.REPORT_DIR / "kicker_tier_effect.csv", index=False)
            out["kicker_tier"] = k
    (config.REPORT_DIR / "headline.json").write_text(json.dumps(out["headline"], indent=1))
    return out


def markdown_summary(out: dict) -> str:
    h = out["headline"]
    lines = [
        f"- **{h['decisions']:,} decisions graded** across {h['games']} games (2023-2025, regular season + playoffs); "
        f"{h['clock_decisions']:,} are clock / game-management decisions, the rest clock-critical run-vs-pass calls.",
        f"- Coaches picked the simulator's best option **{h['agree_rate_clock']:.0%}** of the time on clock decisions; "
        f"**{h['sig_errors_clock']:,}** choices were clear mistakes (edge > 2 SE and > 0.5% WP).",
        f"- Clock and game-management choices cost the league **{h['wins_lost_clock']:.1f} expected wins** over three "
        f"seasons (~{h['wins_lost_clock_per_team_season']:.2f} per team-season).",
        "",
        "| Decision | Graded | Agree w/ model | Clear mistakes | Exp. wins lost | Most common mistake |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for _, r in out["families"].iterrows():
        lines.append(f"| {r['label']} | {r['decisions']:,} | {r['agree']:.0%} | {int(r['sig_errors'])} | "
                     f"{r['wins_lost']:.2f} | {r['pattern'] if isinstance(r['pattern'], str) else '—'} |")
    return "\n".join(lines)


def export_dashboard_files(out: dict, dest=None):
    """Write the CSV/JSON datasets the published report page reads."""
    dest = dest or config.REPORT_DIR / "dashboard_data"
    dest.mkdir(parents=True, exist_ok=True)
    fam = out["families"].copy()
    top = fam.iloc[0]
    h = dict(out["headline"])
    h.update(top_family=top["label"], top_family_wins=float(top["wins_lost"]))
    (dest / "headline.json").write_text(json.dumps([h], indent=1))
    fam.round(5).to_csv(dest / "families.csv", index=False)
    out["by_team"].round(5).to_csv(dest / "team_seasons.csv", index=False)
    out["by_coach"].round(5).to_csv(dest / "coaches.csv", index=False)
    top_dec = out["top"].head(25).copy()
    top_dec["decision"] = top_dec["decision"].map(FAMILY_LABEL)
    top_dec.round(5).to_csv(dest / "costliest.csv", index=False)
    if "sensitivity" in out:
        s = out["sensitivity"].copy()
        s["label"] = s["decision"].map(FAMILY_LABEL)
        s.round(5).to_csv(dest / "sensitivity.csv", index=False)
    if "kicker_tier" in out:
        out["kicker_tier"].reset_index().round(5).to_csv(dest / "kicker_tiers.csv", index=False)
    charts_path = config.REPORT_DIR / "decision_charts.json"
    if charts_path.exists():
        ch = json.loads(charts_path.read_text())
        for name, rows in ch.items():
            pd.DataFrame(rows).round(5).to_csv(dest / f"chart_{name}.csv", index=False)
    cal = config.REPORT_DIR / "validation_calibration.json"
    if cal.exists():
        m = json.loads(cal.read_text())
        names = {"sim_wp_home": "nflclock simulator", "model_wp_home": "nflclock WP model",
                 "nflfastr_wp_home": "nflfastR (public)"}
        pd.DataFrame([{"model": names[k], **v} for k, v in m.items()]).round(5).to_csv(
            dest / "validation_calibration.csv", index=False)
    drv = config.REPORT_DIR / "validation_drives.csv"
    if drv.exists():
        d = pd.read_csv(drv)
        d["category"] = d["category"].map({"end_of_1st_half": "End of 1st half drives",
                                           "trailing_4q_final5": "Trailing, 4th qtr final 5:00",
                                           "leading_4q_final6": "Leading, 4th qtr final 6:00"})
        d.round(5).to_csv(dest / "validation_drives.csv", index=False)
    return dest
