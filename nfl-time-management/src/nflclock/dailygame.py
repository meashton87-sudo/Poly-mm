"""Two-Minute Drill, the daily play-calling game: real late-game spots, three a day.

Every scenario is the first snap of a real drive late in a real game (2023-26): a two-minute drill
while trailing, a lead to protect, or a tied game / end of the first half. The player calls every play
for one team until the game ends; the browser engine (web/engine.js) plays the rest with real clock
rules. This module writes the data the browser game needs:

  web/playbook.json   -- call outcome libraries, NFL call frequencies, out-of-bounds odds (playbook.py)
  web/game.json       -- the index: calls (grouped Run / Pass / RPO), models, and a deterministic
                         three-a-day schedule over the scenario pool
  web/spots/NN.json   -- the scenarios, CHUNK per file (only today's three are fetched): as-of team
                         ratings, both teams' lineups with each player's percentile (players.py), the
                         real call and result
"""
from __future__ import annotations

import json
from datetime import date

import numpy as np
import pandas as pd

from . import config, data
from . import playbook as P
from . import players as PL
from .analyze import kicker_unavailable
from .context import GameContextFactory
from .models import Bundle

WEB = config.ROOT / "web"
LAUNCH = date(2026, 10, 12)
DAYS = 365
CHUNK = 16
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


def _team(info, card, k_pct=50, p_pct=50) -> dict:
    return {"team": info.team,
            "base": {k: round(float(getattr(info, k)), 5) for k in ("off_pass", "off_rush", "def_pass", "def_rush", "proe")},
            "qb": {"adjustment": 0.0}, "injury_adjustment": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0},
            "kicker": {"name": info.kicker, "rating": round(float(info.kicker_rating), 4), "pct": k_pct},
            "punter": {"name": info.punter, "rating": round(float(info.punter_rating), 3), "pct": p_pct},
            # the matchup tilt the engine applies per call (EPA per play over league average); never shown
            "calls": {c: {"off": v["off"], "def": v["def"]} for c, v in card.items()}}


def _window(season: int, week: int) -> str:
    if week <= 1:
        return f"{season - 1} season"
    last = f"week {week - 1}" if week <= 19 else "the regular season and playoffs so far"
    return f"{season - 1} season (counted less) and {season} through {last}"


def _names(raw: pd.DataFrame) -> pd.DataFrame:
    """Each team's main QB and running back in each game (for play-call labels)."""
    qb = raw[raw["qb_dropback"] == 1].groupby(["game_id", "posteam"])["passer_player_name"].agg(
        lambda x: x.mode().iat[0] if x.notna().any() else None)
    qbs = set(qb.dropna())
    rb = raw[(raw["play_type"] == "run") & ~raw["rusher_player_name"].isin(qbs)].groupby(
        ["game_id", "posteam"])["rusher_player_name"].agg(lambda x: x.mode().iat[0] if x.notna().any() else None)
    return pd.concat([qb.rename("qb"), rb.rename("rb")], axis=1)


def build(days: int = DAYS, seed: int = 2026) -> dict:
    bundle = Bundle.load()
    pbp = data.load(tuple(range(2016, max(SCENARIO_SEASONS) + 1)))
    lib = P.labeled_plays()
    P.export(lib, WEB / "playbook.json")
    cand = candidates(pbp, lib)
    rng = np.random.default_rng(seed)
    picks = {}
    for cat in CATEGORIES:
        c = cand[cand["category"] == cat]
        picks[cat] = c.iloc[rng.permutation(len(c))].head(days)
    chosen = pd.concat(picks.values())
    fac = GameContextFactory(bundle, pbp[pbp["game_id"].isin(chosen["game_id"].unique())])
    R = PL.Ratings(PL.load_tables(tuple(range(min(SCENARIO_SEASONS) - 1, max(SCENARIO_SEASONS) + 1))), bundle)

    def spec(kind, gid, team, season, week):
        pid = (fac.kickers if kind == "k" else fac.punters).get((gid, team))
        return PL.specialist_pct(R, season, week, kind, pid)
    raw = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet",
                                     columns=["game_id", "posteam", "qb_dropback", "play_type", "passer_player_name",
                                              "rusher_player_name"]) for s in SCENARIO_SEASONS], ignore_index=True)
    names = _names(raw[raw["game_id"].isin(chosen["game_id"].unique())])
    cards = {}

    def card(season, week, team):
        if (season, week) not in cards:
            cards[(season, week)] = P.call_ratings(lib, season, week)
        return P.team_card(cards[(season, week)], team)

    scen, index = [], {}
    for cat, df in picks.items():
        for _, r in df.iterrows():
            gid = r["game_id"]
            g = fac.games.loc[gid]
            season, week = int(g["season"]), int(g["week"])
            ctx, home, away = fac.for_game(gid)
            try:
                lg = fac.tr.loc[(season, week, g["home"])]
                league = {k: round(float(lg[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")}
            except KeyError:
                league = {"mu_pass": 0.0, "mu_rush": 0.0, "home_pass": 0.0, "home_rush": 0.0}
            off = r["posteam"]
            home_off = off == g["home"]
            nm = names.loc[(gid, off)] if (gid, off) in names.index else {"qb": None, "rb": None}
            res = r.get("fixed_drive_result")
            index[(cat, gid, int(r["play_id"]))] = len(scen)
            scen.append({
                "id": f"{gid}#{int(r['play_id'])}", "category": cat, "game_id": gid, "season": season, "week": week,
                "player": off, "opponent": r["defteam"],
                "coach": g["home_coach"] if home_off else g["away_coach"],
                "game": {"game_id": gid, "season": season, "week": week,
                         "home": _team(home, card(season, week, g["home"]), spec("k", gid, g["home"], season, week),
                                       spec("p", gid, g["home"], season, week)),
                         "away": _team(away, card(season, week, g["away"]), spec("k", gid, g["away"], season, week),
                                       spec("p", gid, g["away"], season, week)),
                         "home_spread": float(np.nan_to_num(g["spread"])), "indoor": g["roof"] in ("dome", "closed"),
                         "wind": float(np.nan_to_num(g["wind"])), "temp": None if pd.isna(g["temp"]) else float(g["temp"]),
                         "league": league, "home_coach": g["home_coach"], "away_coach": g["away_coach"]},
                "start": {"qtr": int(r["qtr"]), "clock": float(r["quarter_seconds_remaining"]),
                          "score": [int(r["total_away_score"]), int(r["total_home_score"])],
                          "pos": off, "down": 1, "ytg": float(r["ydstogo"]), "yl": float(r["yardline_100"]),
                          "to": [int(r["posteam_timeouts_remaining"] if not home_off else r["defteam_timeouts_remaining"]),
                                 int(r["posteam_timeouts_remaining"] if home_off else r["defteam_timeouts_remaining"])],
                          "running": False, "phase": "snap", "receive2h": g["home"] if g["hok"] != 1 else g["away"]},
                "names": {"qb": nm["qb"], "rb": nm["rb"]},
                "real": {"call": r["real_call"], "desc": r["desc"], "drive": DRIVE_RESULT.get(res, res),
                         "final": {"away": int(r["away_score"]), "home": int(r["home_score"])}},
                "lineups": {"home": PL.lineup(R, gid, g["home"], season, week),
                            "away": PL.lineup(R, gid, g["away"], season, week)},
                "window": _window(season, week),
            })
    n = {cat: len(df) for cat, df in picks.items()}
    off = {cat: sum(len(picks[c]) for c in list(CATEGORIES)[:i]) for i, cat in enumerate(CATEGORIES)}
    schedule = [[off[cat] + (d % n[cat]) for cat in CATEGORIES] for d in range(days)]
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
           "schedule": schedule, "n": len(scen), "chunk": CHUNK,
           "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
    (WEB / "game.json").write_text(json.dumps(out, separators=(",", ":"), default=float))
    spots = WEB / "spots"
    spots.mkdir(exist_ok=True)
    for old_file in spots.glob("*.json"):
        old_file.unlink()
    for k in range(0, len(scen), CHUNK):
        (spots / f"{k // CHUNK:02d}.json").write_text(json.dumps(scen[k:k + CHUNK], separators=(",", ":"), default=float))
    (WEB / "scenarios.json").unlink(missing_ok=True)
    return {"scenarios": len(scen), "by_category": n, "days": days, "chunks": -(-len(scen) // CHUNK)}
