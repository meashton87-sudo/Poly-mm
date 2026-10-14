"""Two-Minute Drill, the daily play-calling game: real late-game spots, three a day, played with the real lineups.

Every spot is the first snap of a real drive late in a real game (2023-26, playoffs included; the game's season,
week or playoff round is shown with it): a two-minute drill while
trailing, a lead to protect, or a tied game / end of the first half. The situation (score, clock, ball,
timeouts) is real, and so are the teams: the players on the field in that game and everyone's strength as
of that week (history.py). The player calls every play for one team until the game ends; the browser
engine (web/engine.js) plays the rest with real clock rules. This module writes what the browser needs:

  web/playbook.json   -- call outcome libraries, NFL call frequencies, out-of-bounds odds (playbook.py)
  web/game.json       -- the calls (grouped Run / Pass / RPO), the spots (with the real spread), a three-a-day
                         schedule, the decision models and the coach fingerprints (coaches.py)
  web/spots/s<k>.json -- the two teams of spots 60k..60k+59 as they were in that game: lineups with every
                         player's rating as of that week, ratings, QB, kicker, punter, coach, call ratings
"""
from __future__ import annotations

import json
from datetime import date

import numpy as np
import pandas as pd

from . import coaches as CO
from . import config, data
from . import history as HI
from . import playbook as P
from .analyze import kicker_unavailable
from .models import Bundle

WEB = config.ROOT / "web"
LAUNCH = date(2026, 10, 12)
DAYS = 365
SEASON = 2026
SCENARIO_SEASONS = (2023, 2024, 2025, 2026)   # the last four seasons, playoffs included
SPOT_CHUNK = 20                               # spots per web/spots file (a day loads at most three files)
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

    hist = HI.History(bundle, lib)
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
                "spread": float(np.nan_to_num(g["spread_line"])),
                "real": {"season": int(g["season"]), "week": int(g["week"]), "type": str(g["game_type"]),
                         "coach": CO.COACH_FIX.get(c := g["home_coach"] if home_off else g["away_coach"], c), "call": r["real_call"],
                         "drive": DRIVE_RESULT.get(res, res), "final": {"away": int(r["away_score"]), "home": int(r["home_score"])}},
            })
    # the two teams as they were in each spot's game, in chunks the browser loads a day at a time
    chunks: dict = {}
    for i, sp in enumerate(spots):
        gid, pid = sp["id"].split("#")
        g = games.loc[gid]
        t = hist.teams(gid, int(g["season"]), int(g["week"]), float(pid), sp["home"], sp["away"],
                       {"home": g["home_coach"], "away": g["away_coach"]})
        sp["league"] = t["league"]
        chunks.setdefault(i // SPOT_CHUNK, {})[str(i)] = t["teams"]
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
           "schedule": schedule, "spots": spots, "spot_chunk": SPOT_CHUNK, "league": league,
           "coaches": CO.fingerprints(),
           "asof": {"season": season, "ratings": "our own, 40-99: each player's percentile at his position as of the week of the game"},
           "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
    (WEB / "game.json").write_text(json.dumps(out, separators=(",", ":"), default=float, allow_nan=False))
    (WEB / "spots").mkdir(exist_ok=True)
    for stale in (WEB / "spots").glob("*.json"):
        stale.unlink()
    for k, ch in chunks.items():
        (WEB / "spots" / f"s{k}.json").write_text(json.dumps(ch, separators=(",", ":"), default=float, allow_nan=False))
    (WEB / "scenarios.json").unlink(missing_ok=True)
    return {"spots": len(spots), "by_category": n, "days": days, "chunks": len(chunks), "coaches": len(out["coaches"]["coaches"])}
