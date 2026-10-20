"""Pro: build a scenario. Every team of every season the site supports, as it lined up and how good everyone was, for
the scenario builder (game.js #custom): web/rosters/index.json (the seasons, each team's name, record, coach and
strength, and the point-spread fit) and web/rosters/<season>.json (the 32 teams in the daily game's team format,
history.History.teams). The browser loads the index when the builder opens and a season's file only when a team of
that season is picked. Generated, never committed: the site workflow builds it and site.py ships it (stamped).

A team-season is the team in one real game (its lineup on a snap from the middle of it: the participation, snap
counts, depth chart or box score of that game, as for a historic drive) with everyone rated as of the end of its
regular season (only games before the week after its last one count), its other quarterbacks and kickers those of the
whole season (history.History.teams whole_season: the builder's Lineup picks from them, web/scenario.js lineup): the
game is the latest of the regular season,
before its last week (when starters rest), whose starting quarterback was the season's (the one who started most);
for the season being played, its latest game. The point spread of a scenario comes from the two teams' strengths
(SPREAD_FIT, fitted on the real lines of every season built)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config, data
from . import dailygame as DG
from . import history as HI
from . import playbook as P
from . import players as PL
from . import pro as PRO
from .models import Bundle

# the first season with real lineups at every position: the play-by-play starts in 1999, but nothing names who started
# on the line before the depth charts (2001); the historic drives from 1999 and 2000 name theirs by hand (pro_drives.json)
FIRST = 2001
OUT = DG.WEB / "rosters"
PASS_W = 0.6                  # a team's strength: its pass ratings count this much, its run ratings the rest
# a franchise's city in the seasons it played somewhere else (the page names every team by its city, never a
# nickname; game.js TEAMS has today's): code -> [(last season there, city)]. web/scenario.js ERA is the same table
# (the historic drives' and runs' cities): change both (tests/test_scenario.py compares them)
ERA_NAME = {"LA": [(2015, "St. Louis")], "LAC": [(2016, "San Diego")], "LV": [(2019, "Oakland")]}


def era_name(team: str, season: int) -> dict | None:
    """The franchise's name that season, its city then, where it is not today's (St. Louis before Los Angeles)."""
    for last, city in ERA_NAME.get(team, []):
        if season <= last:
            return {"name": city}
    return None


def season_games(games: pd.DataFrame, season: int) -> pd.DataFrame:
    """The season's regular-season games played, with today's team codes (the play-by-play's)."""
    g = games[(games["season"] == season) & (games["game_type"] == "REG") & games["home_score"].notna()].copy()
    for side in ("home", "away"):
        g[f"{side}_code"] = g[f"{side}_team"].map(lambda t: PRO.TEAM_NOW.get(t, t))
    return g.sort_values(["week", "game_id"])


def record(g: pd.DataFrame, team: str) -> str:
    """W-L (and ties) in those games."""
    w = l = t = 0
    for _, r in g[(g["home_code"] == team) | (g["away_code"] == team)].iterrows():
        mine, theirs = (r["home_score"], r["away_score"]) if r["home_code"] == team else (r["away_score"], r["home_score"])
        w, l, t = w + (mine > theirs), l + (mine < theirs), t + (mine == theirs)
    return f"{w}-{l}" + (f"-{t}" if t else "")


def pick_game(g: pd.DataFrame, team: str, current: bool, kickers: dict | None = None) -> pd.Series:
    """The game a team-season is taken from: the latest one (before the last week, when starters rest, in a season
    played out) whose starting quarterback started the most games that season and whose kicker kicked the most for it
    (kickers: game id -> the team's kicker in it, by kicks; a kicker hurt in a game leaves its punter kicking), else
    the latest with that quarterback, else the latest."""
    mine = g[(g["home_code"] == team) | (g["away_code"] == team)]
    if len(mine) < 3:
        return mine.iloc[-1]
    qb = np.where(mine["home_code"] == team, mine["home_qb_id"], mine["away_qb_id"])
    usual = pd.Series(qb).value_counts().index[0] if pd.notna(qb).any() else None
    k = mine["game_id"].map(kickers or {})
    main = k.value_counts().index[0] if k.notna().any() else None
    ok = (mine["week"] < g["week"].max()) if not current else pd.Series(True, index=mine.index)
    for want in ((qb == usual) & (k == main), qb == usual):
        pick = mine[ok & want]
        if usual is not None and len(pick):
            return pick.iloc[-1]
    return mine.iloc[-1] if current else mine.iloc[-2]


def _plain(name) -> str:
    return " ".join(w for w in str(name or "").lower().replace(".", "").split() if w not in ("jr", "sr", "ii", "iii", "iv"))


def ordinary(t: dict, qb: str | None = None) -> bool:
    """One quarterback (the game's starter, when named), the line in its five slots, five more and eleven on defense."""
    off = [p["pos"] for p in t["lineup"]["off"]]
    return (len(off) == 11 and off[:6] == ["QB"] + HI.OL_SLOTS and off.count("QB") == 1 and len(t["lineup"]["def"]) == 11
            and (not qb or _plain(t["lineup"]["off"][0]["name"]) == _plain(qb)))


def strength(t: dict) -> float:
    """The team's net EPA a play over an average team's, offense less defense (engine.js makeContext's delta: the
    offense's own plus what the other defense gives up), its pass ratings weighted PASS_W."""
    b = t["base"]
    return round(PASS_W * (b["off_pass"] + t["qb"]["adjustment"] - b["def_pass"]) + (1 - PASS_W) * (b["off_rush"] - b["def_rush"]), 5)


def season_teams(hist, games: pd.DataFrame, pbp: pd.DataFrame, season: int, current: bool) -> tuple[dict, dict, list]:
    """({team: its team record}, the league constants, [{team, name, record, coach, net, game}]) for the season."""
    g = season_games(games, season)
    week = int(g["week"].max()) + 1           # rated as of the week after its last (only the season's games before it count)
    out, meta, league = {}, [], None
    kicks = pbp[(pbp["season"] == season) & pbp["play_type"].isin(["field_goal", "extra_point"]) & pbp["kicker_player_id"].notna()]
    kick_of = kicks.groupby(["posteam", "game_id"])["kicker_player_id"].agg(lambda x: x.value_counts().index[0])
    for team in sorted(set(g["home_code"]) | set(g["away_code"])):
        r = pick_game(g, team, current, kick_of.loc[team].to_dict() if team in kick_of.index.get_level_values(0) else {})
        gid = r["game_id"]
        snaps = pbp[(pbp["game_id"] == gid) & (pbp["posteam"] == team) & pbp["play_type"].isin(["run", "pass"])]
        if not len(snaps):
            raise RuntimeError(f"no snaps for {team} in {gid}")
        side = "home" if r["home_code"] == team else "away"
        # its lineup on a snap from the middle of the game, an ordinary one: one quarterback and the line in its five
        # slots (not a wildcat snap with two quarterbacks on the field, not a jumbo set)
        n, rec, qb = len(snaps), None, r.get(f"{side}_qb_name")
        for at in (0.5, 0.42, 0.58, 0.34, 0.66, 0.25):
            t = hist.teams(gid, season, week, float(snaps["play_id"].iloc[int(n * at)]), r["home_code"], r["away_code"],
                           {"home": r["home_coach"], "away": r["away_coach"]}, only=side, whole_season=True)
            if rec is None or (ordinary(t["teams"][side]) and not ordinary(rec)):
                rec = t["teams"][side]
            if ordinary(t["teams"][side], qb if isinstance(qb, str) else None):
                rec = t["teams"][side]
                break
        league = t["league"]
        out[team] = rec
        meta.append({"team": team, **({"era": era_name(team, season)} if era_name(team, season) else {}), "record": record(g, team),
                     "coach": rec["coach"], "qb": rec["qb"]["name"], "net": strength(rec), "game": gid})
    return out, league, meta


def spread_fit(games: pd.DataFrame, nets: dict) -> dict:
    """The real point spread from the two teams' strengths, over every regular-season game of the seasons built:
    home_spread = hfa (not at a neutral site) + k x (home's strength less the away team's), least squares."""
    rows = []
    g = games[(games["game_type"] == "REG") & games["spread_line"].notna() & games["season"].isin({s for s, _ in nets})]
    for _, r in g.iterrows():
        h, a = PRO.TEAM_NOW.get(r["home_team"], r["home_team"]), PRO.TEAM_NOW.get(r["away_team"], r["away_team"])
        if (r["season"], h) in nets and (r["season"], a) in nets:
            rows.append((0.0 if r["location"] == "Neutral" else 1.0, nets[(r["season"], h)] - nets[(r["season"], a)], float(r["spread_line"])))
    X = np.array([[x[0], x[1]] for x in rows]), np.array([x[2] for x in rows])
    coef, *_ = np.linalg.lstsq(X[0], X[1], rcond=None)
    resid = X[1] - X[0] @ coef
    return {"hfa": round(float(coef[0]), 2), "k": round(float(coef[1]), 1), "sd": round(float(resid.std()), 2), "n": len(rows)}


def build(seasons=None, bundle=None, lib=None) -> dict:
    """Write web/rosters: index.json and a file a season."""
    bundle = bundle or Bundle.load()
    lib = lib if lib is not None else P.labeled_plays()
    games = pd.read_csv(config.RAW_DIR / "games.csv")
    every = sorted(range(FIRST, DG.SEASON + 1))
    seasons = sorted(seasons or every)
    OUT.mkdir(parents=True, exist_ok=True)
    # (some seasons only, a fix tried out: the others' files and index rows stay)
    old = json.loads((OUT / "index.json").read_text()) if seasons != every and (OUT / "index.json").exists() else {"seasons": []}
    for stale in OUT.glob("*.json"):
        if seasons == every or stale.stem in {str(s) for s in seasons}:
            stale.unlink()
    index, nets, ovr_data, sizes = [s for s in old["seasons"] if s["season"] not in seasons and s["season"] in every], {}, None, {}
    for s in index:
        for m in s["teams"]:
            nets[(s["season"], m["team"])] = m["net"]
    for season in seasons:
        pbp = data.load(tuple(PL.pbp_seasons(range(season - 2, season + 1))))
        hist = HI.History(bundle, lib, seasons=(season,), pbp=pbp)
        if ovr_data is not None:                 # (every season's ratings read the same tables: loaded once)
            hist.ovr_data = ovr_data
        current = season == DG.SEASON
        teams, league, meta = season_teams(hist, games, pbp, season, current)
        ovr_data = hist.ovr_data
        doc = {"season": season, "league": league, "teams": teams}
        for bad in DG._nan_paths(doc):
            raise ValueError(f"not a number in the {season} rosters: {bad}")
        body = json.dumps(doc, separators=(",", ":"), default=float, allow_nan=False)
        (OUT / f"{season}.json").write_text(body)
        sizes[season] = len(body)
        for m in meta:
            nets[(season, m["team"])] = m["net"]
        week = int(season_games(games, season)["week"].max())
        index.append({"season": season, "current": current, "thru": week, "teams": meta})
        print(f"rosters {season}: {len(teams)} teams, {len(body) / 1e3:.0f} kB", flush=True)
    index.sort(key=lambda s: s["season"])
    fit = spread_fit(games, nets)
    # (no build time in it: the same data, the same file and stamp, site.py)
    (OUT / "index.json").write_text(json.dumps({"seasons": index, "spread": fit, "pass_w": PASS_W},
                                               separators=(",", ":"), default=float, allow_nan=False))
    return {"seasons": len(index), "teams": sum(len(s["teams"]) for s in index), "spread": fit,
            "kB": round(sum(sizes.values()) / 1e3)}
