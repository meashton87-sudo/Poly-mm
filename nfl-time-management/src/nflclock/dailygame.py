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


# The schedule as it went live, frozen: every spot's id and kind in order, and each day's three spots (indices into
# that list). A build drawn fresh from the data would reshuffle every day as soon as a new week of games arrived
# (more candidates, a different permutation), changing today's drive mid-day and resuming saved drives on the
# wrong game. With the file, a build keeps the same spots in the same order on the same days. Extend it only by
# adding days at the end.
FROZEN = config.ROOT / "src" / "nflclock" / "daily_schedule.json"
# spots built by hand (a game the play-by-play does not have: college), with both teams' records: a featured day can
# name one by id. They go after every other spot, so no frozen index moves.
CUSTOM = config.ROOT / "src" / "nflclock" / "custom_spots.json"


def custom_spots() -> dict:
    return {k: v for k, v in json.loads(CUSTOM.read_text()).items() if not k.startswith("_")} if CUSTOM.exists() else {}


def freeze(game_json=WEB / "game.json", out=FROZEN) -> dict:
    """Write the schedule of a built game.json (the live one) to the frozen file."""
    g = json.loads(game_json.read_text())
    feat = {k for f in g.get("featured", {}).values() for k in [f["spot"]]}
    frozen = {"launch": g["launch"], "spots": [[sp["id"], sp["category"]] for k, sp in enumerate(g["spots"]) if k not in feat],
              "schedule": g["schedule"],
              "featured": {d: {"id": g["spots"][f["spot"]]["id"], "category": g["spots"][f["spot"]]["category"], "note": f["note"],
                               **({"title": f["title"]} if f.get("title") else {})}
                           for d, f in g.get("featured", {}).items()}}
    out.write_text(json.dumps(frozen, separators=(",", ":")) + "\n")
    return {"spots": len(frozen["spots"]), "days": len(frozen["schedule"])}


def candidates(pbp: pd.DataFrame, lib: pd.DataFrame, keep: dict | None = None) -> pd.DataFrame:
    seasons = set(SCENARIO_SEASONS) | {int(k[:4]) for k in (keep or {})}     # a featured spot can be from any season
    s = pbp[pbp["is_snap"] & pbp["season"].isin(seasons) & pbp["play_type"].isin(["run", "pass"])
            & pbp["posteam_timeouts_remaining"].notna() & pbp["defteam_timeouts_remaining"].notna()]
    s = s.sort_values(["game_id", "row_order"])
    first = s.groupby(["game_id", "fixed_drive"]).head(1)
    first = first[first["down"] == 1]
    if keep:          # a featured spot may start mid-drive (the snap the story is about): any first-down snap
        sid = s["game_id"] + "#" + s["play_id"].astype(int).astype(str)
        extra = s[sid.isin(keep) & (s["down"] == 1) & ~s.index.isin(first.index)]
        first = pd.concat([first, extra])
    q, gsr, hs = first["qtr"], first["game_seconds_remaining"], first["half_seconds_remaining"]
    m, yl, wp = first["margin"], first["yardline_100"], first["wp"]
    cat = np.select(
        [(q == 4) & gsr.between(45, 150) & m.between(-8, -1) & (yl >= 45),
         (q == 4) & gsr.between(120, 300) & m.between(1, 8),
         ((q == 4) & gsr.between(60, 240) & (m == 0)) | ((q == 2) & hs.between(40, 120) & yl.between(50, 80)
                                                        & (m.abs() <= 10))],
        ["drill", "protect", "tight"], default="")
    first = first.assign(category=cat)
    ids = first["game_id"] + "#" + first["play_id"].astype(int).astype(str)
    bad = kicker_unavailable(pbp)
    ok = (first["category"] != "") & wp.between(0.08, 0.92) \
        & ~pd.Series(list(zip(first["game_id"], first["posteam"])), index=first.index).isin(bad)
    if keep:          # the frozen spots stay, with their frozen kind, whatever a data revision did to wp or the filters
        frozen = ids.isin(keep)
        first.loc[frozen, "category"] = ids[frozen].map(keep)
        ok = ok | frozen
    first = first.assign(spot_id=ids)[ok]
    real_call = lib.set_index(["game_id", "play_id"])["call"]
    first["real_call"] = [P.CALL_IDS[int(real_call.get((g, p), -1))] if (g, p) in real_call.index else None
                          for g, p in zip(first["game_id"], first["play_id"])]
    return first


def _score_before(r, home_off: bool) -> list:
    """[away, home] as the snap is taken: posteam_score / defteam_score are the score before the play; the total_*
    columns are after it (a spot whose first play scores, the Miami Miracle, would start with the points on the board)."""
    pos, dfn = r.get("posteam_score"), r.get("defteam_score")
    if pd.isna(pos) or pd.isna(dfn):
        return [int(r["total_away_score"]), int(r["total_home_score"])]
    pos, dfn = int(pos), int(dfn)
    return [dfn, pos] if home_off else [pos, dfn]


def spot_record(r, g, receive2h: dict) -> dict:
    """A spot in the game's format: the candidate row r (dailygame.candidates) and its game's row g (games.csv)."""
    gid = r["game_id"]
    home, away = r["home_team"], r["away_team"]       # the play-by-play's codes (LA, not STL): the engine's and the teams'
    off = r["posteam"]
    home_off = off == home
    res = r.get("fixed_drive_result")
    call = r.get("real_call")
    return {
        "id": f"{gid}#{int(r['play_id'])}", "category": r["category"], "home": home, "away": away, "player": off,
        "indoor": g["roof"] in ("dome", "closed"), "wind": float(np.nan_to_num(g["wind"])),
        "temp": None if pd.isna(g["temp"]) else float(g["temp"]),
        "start": {"qtr": int(r["qtr"]), "clock": float(r["quarter_seconds_remaining"]),
                  "score": _score_before(r, home_off),
                  "pos": off, "down": 1, "ytg": float(r["ydstogo"]), "yl": float(r["yardline_100"]),
                  "to": [int(r["posteam_timeouts_remaining"] if not home_off else r["defteam_timeouts_remaining"]),
                         int(r["posteam_timeouts_remaining"] if home_off else r["defteam_timeouts_remaining"])],
                  "running": False, "phase": "snap", "receive2h": receive2h.get(gid, away)},
        "spread": float(np.nan_to_num(g["spread_line"])),
        "real": {"season": int(g["season"]), "week": int(g["week"]), "type": str(g["game_type"]), "date": str(g["gameday"]),
                 "coach": CO.coach_name(g["home_coach"] if home_off else g["away_coach"], off, g["season"]),
                 "call": call if isinstance(call, str) else None,          # the library's label for the real play (2022 on)
                 "drive": None if res is None or (isinstance(res, float) and np.isnan(res)) else DRIVE_RESULT.get(res, res),
                 "final": {"away": int(r["away_score"]), "home": int(r["home_score"])}},
    }


def team_chunks(hist, spots: list, games: pd.DataFrame, chunk: int = SPOT_CHUNK, drive: bool = False) -> dict:
    """The two teams as they were in each spot's game (history.History.teams), in chunks the browser loads one at a
    time: {chunk index: {spot index: teams}}; each spot gets its league constants. drive: the lineups of the real drive
    from the spot on (Pro's historic drives and playoff runs)."""
    chunks: dict = {}
    for i, sp in enumerate(spots):
        gid, pid = sp["id"].split("#")
        g = games.loc[gid]
        t = hist.teams(gid, int(g["season"]), int(g["week"]), float(pid), sp["home"], sp["away"],
                       {"home": g["home_coach"], "away": g["away_coach"]}, drive=drive)
        sp["league"] = t["league"]
        chunks.setdefault(i // chunk, {})[str(i)] = t["teams"]
    return chunks


def receive2h_of(pbp: pd.DataFrame) -> dict:
    """game id -> the team that gets the ball after halftime (it kicked off to start the game)."""
    ko = pbp[pbp["play_type"] == "kickoff"].sort_values(["game_id", "row_order"]).groupby("game_id").head(1)
    return dict(zip(ko["game_id"], ko["defteam"]))


def _nan_paths(obj, path: str = "") -> list:
    """Where a NaN or infinity sits in a nested dict/list (JSON cannot carry one): 'spots.3.real.drive', ..."""
    if isinstance(obj, dict):
        return [q for k, v in obj.items() for q in _nan_paths(v, f"{path}.{k}" if path else str(k))]
    if isinstance(obj, (list, tuple)):
        return [q for i, v in enumerate(obj) for q in _nan_paths(v, f"{path}.{i}")]
    if isinstance(obj, (float, np.floating)) and not np.isfinite(obj):
        return [path]
    return []


def build(days: int = DAYS, seed: int = 2026, season: int = SEASON) -> dict:
    bundle = Bundle.load()
    lib = P.labeled_plays()
    P.export(lib, WEB / "playbook.json")
    frozen = json.loads(FROZEN.read_text()) if FROZEN.exists() else None
    featured = (frozen or {}).get("featured", {})
    custom = custom_spots()
    keep = {**dict(map(tuple, frozen["spots"])), **{f["id"]: f["category"] for f in featured.values() if f["id"] not in custom}} if frozen else None
    seasons = sorted(set(SCENARIO_SEASONS) | {int(k[:4]) for k in (keep or {})})
    pbp = data.load(tuple(range(min(2016, min(seasons) - 2), max(seasons) + 1)))    # two seasons before the earliest: its team ratings
    cand = candidates(pbp, lib, keep=keep)
    rng = np.random.default_rng(seed)
    if frozen:
        by_id = cand.drop_duplicates("spot_id").set_index("spot_id", drop=False)
        missing = [i for i, _ in frozen["spots"] if i not in by_id.index]
        if missing:       # a play renumbered upstream: the build fails rather than move a day's drive
            raise RuntimeError(f"frozen spots missing from the data: {missing[:5]} ({len(missing)})")
        missing = [f["id"] for f in featured.values() if f["id"] not in by_id.index and f["id"] not in custom]
        if missing:
            raise RuntimeError(f"featured spots missing from the data: {missing}")
        picks = {cat: by_id.loc[[i for i, c in frozen["spots"] if c == cat]] for cat in CATEGORIES}
        order = [i for i, _ in frozen["spots"]]
        if [i for cat in CATEGORIES for i in picks[cat]["spot_id"]] != order:
            raise RuntimeError("frozen spots are not grouped by kind in CATEGORIES order")
        # featured days' spots go after all the others, so no index of a frozen spot moves
        picks["_featured"] = by_id.loc[[f["id"] for f in featured.values() if f["id"] not in custom]]
    else:
        picks = {cat: cand[cand["category"] == cat].iloc[lambda d: rng.permutation(len(d))].head(days) for cat in CATEGORIES}

    hist = HI.History(bundle, lib, seasons=seasons, pbp=pbp)
    tr = bundle.team_ratings
    last = tr[tr["season"] == season]
    last = last[last["week"] == last["week"].max()].iloc[0]
    league = {k: round(float(last[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")}
    games = pd.read_csv(config.RAW_DIR / "games.csv").set_index("game_id")
    receive2h = receive2h_of(pbp)

    spots = [spot_record(r, games.loc[r["game_id"]], receive2h) for df in picks.values() for _, r in df.iterrows()]
    chunks = team_chunks(hist, spots, games)
    # the hand-built spots, last: their own teams, the league as it was at the end of their season
    for cid in sorted(custom):
        c = custom[cid]
        sp = json.loads(json.dumps(c["spot"]))
        # the league as it was then (a season before the ratings start, e.g. a college game in 2022: the nearest one)
        yr = min(tr["season"].unique(), key=lambda y: (abs(int(y) - int(sp["real"]["season"])), -int(y)))
        ls = tr[tr["season"] == yr]
        ls = ls[ls["week"] == ls["week"].max()].iloc[0]
        sp["league"] = {k: round(float(ls[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")}
        chunks.setdefault(len(spots) // SPOT_CHUNK, {})[str(len(spots))] = c["teams"]
        spots.append(sp)
    n = {cat: len(df) for cat, df in picks.items()}
    offs = {cat: sum(n[c] for c in list(CATEGORIES)[:i]) for i, cat in enumerate(CATEGORIES)}
    if frozen:
        schedule = frozen["schedule"]
    else:
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
           "schedule": schedule,
           # a day can feature one spot (a famous one) in place of its scheduled drive: day -> spot index, with its story
           # and an optional title ("28–3 · Super Bowl LI")
           "featured": {d: {"spot": next(k for k, sp in enumerate(spots) if sp["id"] == f["id"]), "note": f.get("note", ""),
                            **({"title": f["title"]} if f.get("title") else {})}
                        for d, f in featured.items()} if frozen else {},
           "spots": spots, "spot_chunk": SPOT_CHUNK, "league": league,
           "coaches": CO.fingerprints(),
           "asof": {"season": season, "ratings": "our own, 40-99: each player's percentile at his position as of the week of the game"},
           "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
    for bad in _nan_paths(out) + [f"spots/s{k}:{q}" for k, ch in chunks.items() for q in _nan_paths(ch)]:
        raise ValueError(f"not a number in the export: {bad}")
    (WEB / "game.json").write_text(json.dumps(out, separators=(",", ":"), default=float, allow_nan=False))
    (WEB / "spots").mkdir(exist_ok=True)
    for stale in (WEB / "spots").glob("*.json"):
        stale.unlink()
    for k, ch in chunks.items():
        (WEB / "spots" / f"s{k}.json").write_text(json.dumps(ch, separators=(",", ":"), default=float, allow_nan=False))
    (WEB / "scenarios.json").unlink(missing_ok=True)
    return {"spots": len(spots), "by_category": n, "days": days, "chunks": len(chunks), "coaches": len(out["coaches"]["coaches"])}
