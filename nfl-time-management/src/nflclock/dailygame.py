"""Two-Minute Drill, the daily play-calling game: real late-game spots, three a day, played with today's rosters.

Every spot is the first snap of a real drive late in a real game (2023-26): a two-minute drill while
trailing, a lead to protect, or a tied game / end of the first half. The situation (score, clock, ball,
timeouts) is real; the two teams take the field as they stand now (current rosters, starters, injuries
and ratings, see current.py). The player calls every play for one team until the game ends; the browser
engine (web/engine.js) plays the rest with real clock rules. This module writes what the browser needs:

  web/playbook.json   -- call outcome libraries, NFL call frequencies, out-of-bounds odds (playbook.py)
  web/game.json       -- the calls (grouped Run / Pass / RPO), the 32 teams today (lineups with every
                         player's percentile, ratings, kicker, punter, coach), the spots, a three-a-day
                         schedule, the decision models and the coach fingerprints (coaches.py)
"""
from __future__ import annotations

import json
from datetime import date

import numpy as np
import pandas as pd

from . import coaches as CO
from . import config, data
from . import current as C
from . import playbook as P
from .analyze import kicker_unavailable
from .models import Bundle

WEB = config.ROOT / "web"
LAUNCH = date(2026, 10, 12)
DAYS = 365
SEASON = 2026
SCENARIO_SEASONS = (2023, 2024, 2025, 2026)
CATEGORIES = {"drill": "Two-minute drill", "protect": "Protect the lead", "tight": "Tied, or end of the half"}
DRIVE_RESULT = {"Touchdown": "touchdown", "Field goal": "field goal", "Punt": "punt", "Turnover": "turnover",
                "Turnover on downs": "turnover on downs", "End of half": "ran out the clock",
                "Missed field goal": "missed field goal", "Opp touchdown": "defensive touchdown", "Safety": "safety"}


def candidates(pbp: pd.DataFrame, lib: pd.DataFrame) -> pd.DataFrame:
    s = pbp[pbp["is_snap"] & pbp["season"].isin(SCENARIO_SEASONS) & pbp["play_type"].isin(["run", "pass"])
            & pbp["posteam_timeouts_remaining"].notna() & pbp["defteam_timeouts_remaining"].notna()]
    s = s.sort_values(["game_id", "row_order"])
    first = s.groupby(["game_id", "fixed_drive"]).head(1)
    first = first[first["down"] == 1]
    q, gsr, hs = first["qtr"], first["game_seconds_remaining"], first["half_seconds_remaining"]
    m, yl, wp = first["margin"], first["yardline_100"], first["wp"]
    cat = np.select(
        [(q == 4) & gsr.between(45, 150) & m.between(-8, -1) & (yl >= 45),
         (q == 4) & gsr.between(120, 300) & m.between(1, 8),
         ((q == 4) & gsr.between(60, 240) & (m == 0)) | ((q == 2) & hs.between(40, 120) & yl.between(50, 80)
                                                        & (m.abs() <= 10))],
        ["drill", "protect", "tight"], default="")
    first = first.assign(category=cat)
    first = first[(first["category"] != "") & wp.between(0.08, 0.92)]
    bad = kicker_unavailable(pbp)
    first = first[~pd.Series(list(zip(first["game_id"], first["posteam"])), index=first.index).isin(bad)]
    first = first[first["season_type"] == "REG"] if (first["season_type"] == "REG").sum() > 500 else first
    real_call = lib.set_index(["game_id", "play_id"])["call"]
    first["real_call"] = [P.CALL_IDS[int(real_call.get((g, p), -1))] if (g, p) in real_call.index else None
                          for g, p in zip(first["game_id"], first["play_id"])]
    return first


def build(days: int = DAYS, seed: int = 2026, season: int = SEASON) -> dict:
    bundle = Bundle.load()
    pbp = data.load(tuple(range(2016, max(SCENARIO_SEASONS) + 1)))
    lib = P.labeled_plays()
    P.export(lib, WEB / "playbook.json")
    cand = candidates(pbp, lib)
    rng = np.random.default_rng(seed)
    picks = {cat: cand[cand["category"] == cat].iloc[lambda d: rng.permutation(len(d))].head(days) for cat in CATEGORIES}

    now = C.teams_now(bundle, season)
    card = P.call_ratings(lib, season, now["week"])
    teams = {}
    for t, x in now["teams"].items():
        x = dict(x)
        x["calls"] = {c: {"off": v["off"], "def": v["def"]} for c, v in P.team_card(card, t).items()}
        x.pop("recent_games", None)
        teams[t] = x
    tr = bundle.team_ratings
    last = tr[tr["season"] == season]
    last = last[last["week"] == last["week"].max()].iloc[0]
    league = {k: round(float(last[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")}
    games = pd.read_csv(config.RAW_DIR / "games.csv").set_index("game_id")
    ko = pbp[pbp["play_type"] == "kickoff"].sort_values(["game_id", "row_order"]).groupby("game_id").head(1)
    receive2h = dict(zip(ko["game_id"], ko["defteam"]))      # the team that kicked off first gets the ball after halftime

    spots = []
    for cat, df in picks.items():
        for _, r in df.iterrows():
            gid = r["game_id"]
            g = games.loc[gid]
            home, away = g["home_team"], g["away_team"]
            off = r["posteam"]
            home_off = off == home
            res = r.get("fixed_drive_result")
            spots.append({
                "id": f"{gid}#{int(r['play_id'])}", "category": cat, "home": home, "away": away, "player": off,
                "indoor": g["roof"] in ("dome", "closed"), "wind": float(np.nan_to_num(g["wind"])),
                "temp": None if pd.isna(g["temp"]) else float(g["temp"]),
                "start": {"qtr": int(r["qtr"]), "clock": float(r["quarter_seconds_remaining"]),
                          "score": [int(r["total_away_score"]), int(r["total_home_score"])],
                          "pos": off, "down": 1, "ytg": float(r["ydstogo"]), "yl": float(r["yardline_100"]),
                          "to": [int(r["posteam_timeouts_remaining"] if not home_off else r["defteam_timeouts_remaining"]),
                                 int(r["posteam_timeouts_remaining"] if home_off else r["defteam_timeouts_remaining"])],
                          "running": False, "phase": "snap", "receive2h": receive2h.get(gid, away)},
                "real": {"season": int(g["season"]), "week": int(g["week"]),
                         "coach": g["home_coach"] if home_off else g["away_coach"], "call": r["real_call"],
                         "drive": DRIVE_RESULT.get(res, res), "final": {"away": int(r["away_score"]), "home": int(r["home_score"])}},
            })
    n = {cat: len(df) for cat, df in picks.items()}
    offs = {cat: sum(n[c] for c in list(CATEGORIES)[:i]) for i, cat in enumerate(CATEGORIES)}
    schedule = [[offs[cat] + (d % n[cat]) for cat in CATEGORIES] for d in range(days)]
    for day in schedule:
        rng.shuffle(day)
    models = {}
    for key, name in (("tendency", "tendency_web.json"), ("grade_scale", "grade_scale.json")):
        mp = config.ARTIFACT_DIR / name
        if mp.exists():
            models[key] = json.loads(mp.read_text())
    calls = []
    for c, label, kind, say in P.CALLS:
        b, side = P.base_side(c)
        calls.append({"id": c, "label": label, "kind": kind, "say": say, "family": P.FAMILY[c], "base": b, "side": side})
    out = {"launch": LAUNCH.isoformat(), "categories": CATEGORIES, "calls": calls, "models": models,
           "schedule": schedule, "spots": spots, "teams": teams, "league": league, "hfa": now["hfa"],
           "coaches": CO.fingerprints(),
           "asof": {"season": season, "through_week": now["week"] - 1, "depth_chart": now["depth_chart"],
                    "ratings": f"our own, 40-99: {season - 4}-{season} play (the latest seasons count most) through {season} week {now['week'] - 1}"},
           "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
    (WEB / "game.json").write_text(json.dumps(out, separators=(",", ":"), default=float))
    for stale in list((WEB / "spots").glob("*.json")) if (WEB / "spots").exists() else []:
        stale.unlink()
    if (WEB / "spots").exists():
        (WEB / "spots").rmdir()
    (WEB / "scenarios.json").unlink(missing_ok=True)
    return {"spots": len(spots), "by_category": n, "days": days, "teams": len(teams), "coaches": len(out["coaches"]["coaches"]),
            "espn_check": now["espn_check"]}
