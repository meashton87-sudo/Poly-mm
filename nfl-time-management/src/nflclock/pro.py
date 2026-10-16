"""Pro: the historic drives (pro_drives.json), in the daily game's spot format, from any season since 1999.

Each drive is a first-down snap of a famous late drive with its story. The build goes season by season (each
season's play-by-play with the two before it, for its team ratings, and its own History), and writes
web/pro/drives.json (the drives, each pointing at its spot, and the spots) and web/pro/d{k}.json (the two teams
of each spot, chunked like web/spots). The website serves them to Pro players (the Drives screen)."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from . import config, data
from . import dailygame as DG
from . import history as HI
from . import playbook as P
from . import players as PL
from .models import Bundle

DRIVES = Path(__file__).with_name("pro_drives.json")
RUNS = Path(__file__).with_name("pro_runs.json")
OUT = DG.WEB / "pro"
ROUND = {"WC": "Wild Card", "DIV": "Divisional", "CON": "Conference Championship", "SB": "Super Bowl"}
TEAM_NOW = {"STL": "LA", "SD": "LAC", "OAK": "LV"}        # games.csv keeps the code of the time; play-by-play today's


def playoff_games(games: pd.DataFrame, season: int, team: str) -> pd.DataFrame:
    """The team's playoff games that season, in order (games.csv)."""
    g = games[(games["season"] == season) & (games["game_type"] != "REG")]
    mine = g["home_team"].map(lambda t: TEAM_NOW.get(t, t)).eq(team) | g["away_team"].map(lambda t: TEAM_NOW.get(t, t)).eq(team)
    return g[mine].sort_values("week")


def run_spot(pbp: pd.DataFrame, game_id: str, team: str) -> str:
    """The game's spot for the team's run: of its fourth-quarter (or overtime) drive starts with the game within
    reach (down by 16 or less, up by 8 or less, half a minute or more left), the one it was least likely to win from
    (the deepest hole, or the tightest moment); a game never that close gives its first fourth-quarter drive, and a
    game with none its last drive."""
    s = pbp[(pbp["game_id"] == game_id) & (pbp["posteam"] == team) & pbp["is_snap"] & pbp["play_type"].isin(["run", "pass"])
            & pbp["posteam_timeouts_remaining"].notna() & pbp["defteam_timeouts_remaining"].notna()]
    starts = s.sort_values("row_order").groupby("fixed_drive").head(1)
    starts = starts[starts["down"] == 1]
    if not len(starts):
        raise RuntimeError(f"no drive start for {team} in {game_id}")
    late = starts[(starts["qtr"] >= 4) & ((starts["qtr"] >= 5) | (starts["game_seconds_remaining"] >= 30)) & starts["margin"].between(-16, 8)]
    if len(late):
        pick = late.sort_values(["wp", "game_seconds_remaining"]).iloc[0]
    else:
        q4 = starts[starts["qtr"] >= 4]
        pick = q4.iloc[0] if len(q4) else starts.iloc[-1]
    return f"{game_id}#{int(pick['play_id'])}"


def _live_team(hist, games: pd.DataFrame, pbp: pd.DataFrame, team: str, season: int, week: int, out: list, start: dict) -> tuple:
    """A team for a game still being played (no play-by-play yet): the lineup it fielded in its last game, with
    tonight's inactives swapped for whoever played their position most this season, and any named starters put in.
    Returns (team, league)."""
    played = games[(games["season"] == season) & games["home_score"].notna()
                   & ((games["home_team"] == team) | (games["away_team"] == team))].sort_values("week")
    if not len(played):
        raise RuntimeError(f"no {season} game for {team} yet")
    seen: dict = {}                       # (unit, pos) -> {name: games}
    last = None
    for _, g in played.iterrows():
        gid = g["game_id"]
        snaps = pbp[(pbp["game_id"] == gid) & (pbp["posteam"] == team)]
        if not len(snaps):
            continue
        side = "home" if g["home_team"] == team else "away"
        t = hist.teams(gid, season, week, float(snaps["play_id"].iloc[len(snaps) // 2]), g["home_team"], g["away_team"],
                       {"home": g["home_coach"], "away": g["away_coach"]})
        for unit in ("off", "def", "bench"):
            for x in t["teams"][side]["lineup"][unit]:
                k = ("def" if unit == "def" else "off", x["pos"])
                seen.setdefault(k, {}).setdefault(x["name"], [0, x])[0] += 1
        last = (t["teams"][side], t["league"])
    T, league = json.loads(json.dumps(last[0])), last[1]
    gone = set(out)
    for unit in ("off", "def"):
        names = {x["name"] for u in ("off", "def", "bench") for x in T["lineup"][u]}
        for i, x in enumerate(T["lineup"][unit]):
            want = start.get(x["pos"]) if unit == "off" else None
            if want and want != x["name"] and not any(y["name"] == want for y in T["lineup"][unit]):
                pool = seen.get((unit, x["pos"]), {})
                if want in pool:
                    T["lineup"]["bench"] = [y for y in T["lineup"]["bench"] if y["name"] != want] + [x]
                    T["lineup"][unit][i] = pool[want][1]
                    continue
            if x["name"] in gone:
                near = {"S": ["CB"], "CB": ["S"], "LB": ["EDGE", "S"], "EDGE": ["DL", "LB"], "DL": ["EDGE"], "RB": ["FB"],
                        "WR": ["TE"], "TE": ["WR", "FB"]}.get(x["pos"], [])
                pool = []
                for pos in [x["pos"]] + near:              # the same position first, then the nearest one
                    pool = sorted(((n, v) for n, v in seen.get((unit, pos), {}).items() if n not in gone and n not in names),
                                  key=lambda kv: -kv[1][0])
                    if pool:
                        pool = [(n, (c, {**v, "pos": x["pos"]})) for n, (c, v) in pool]
                        break
                if not pool:
                    raise RuntimeError(f"no stand-in for {x['name']} ({team} {x['pos']})")
                T["lineup"][unit][i] = pool[0][1][1]
                names.add(pool[0][0])
        T["lineup"]["bench"] = [y for y in T["lineup"]["bench"] if y["name"] not in gone]
    return T, league


def live_spot(hist, games: pd.DataFrame, pbp: pd.DataFrame, d: dict) -> tuple:
    """(spot, teams) for a game going on now, from the drive's "live" description."""
    L = d["live"]
    g = games.loc[L["game"]]
    teams, league = {}, None
    for side in ("home", "away"):
        team = L[side]
        teams[side], league = _live_team(hist, games.reset_index(), pbp, team, L["season"], L["week"],
                                         L.get("out", {}).get(team, []), L.get("start", {}).get(team, {}))
    from . import coaches as CO
    spot = {"id": d["id"], "category": "drill", "home": L["home"], "away": L["away"], "player": L["player"],
            "indoor": g["roof"] in ("dome", "closed"), "wind": float(pd.to_numeric(g["wind"], errors="coerce") or 0) if pd.notna(g["wind"]) else 0.0,
            "start": {"qtr": L["qtr"], "clock": float(L["clock"]), "score": list(L["score"]), "pos": L["player"], "down": L["down"],
                      "ytg": float(L["ytg"]), "yl": float(L["yl"]), "to": list(L["to"]), "running": False, "phase": "snap",
                      "receive2h": L["receive2h"]},
            "spread": float(pd.to_numeric(g["spread_line"], errors="coerce") or 0.0),
            "real": {"season": L["season"], "week": L["week"], "type": str(g["game_type"]), "live": True, "date": L.get("date") or str(g["gameday"]),
                     "coach": CO.coach_name(g["home_coach"] if L["player"] == L["home"] else g["away_coach"], L["player"], L["season"]),
                     "call": None, "drive": None, "final": None},
            "league": league}
    return spot, teams


def versus_teams(hist, games: pd.DataFrame, pbp: pd.DataFrame, season: int) -> dict:
    """Versus: every team as it lines up now, its lineup from its last game this season (history.History.teams), for
    web/teams.json: {season, week, league, teams: {code: team}}. A team with no game yet is left out."""
    played = games[(games["season"] == season) & games["home_score"].notna()].sort_values("week")
    week = int(played["week"].max()) + 1 if len(played) else 1
    out, league = {}, None
    for team in sorted(set(played["home_team"]) | set(played["away_team"])):
        last = played[(played["home_team"] == team) | (played["away_team"] == team)].iloc[-1]
        gid = last["game_id"] if "game_id" in last.index else last.name
        snaps = pbp[(pbp["game_id"] == gid) & (pbp["posteam"] == team)]
        if not len(snaps):
            continue
        side = "home" if last["home_team"] == team else "away"
        t = hist.teams(gid, season, week, float(snaps["play_id"].iloc[len(snaps) // 2]), last["home_team"], last["away_team"],
                       {"home": last["home_coach"], "away": last["away_coach"]})
        out[team], league = t["teams"][side], t["league"]
    return {"season": season, "week": week, "league": league, "teams": out}


def build(bundle=None, lib=None) -> dict:
    bundle = bundle or Bundle.load()
    lib = lib if lib is not None else P.labeled_plays()
    drives = json.loads(DRIVES.read_text(encoding="utf-8"))
    runs = json.loads(RUNS.read_text(encoding="utf-8"))
    games = pd.read_csv(config.RAW_DIR / "games.csv").set_index("game_id")
    seasons = sorted({int(d["id"][:4]) for d in drives} | {r["season"] for r in runs})
    live = [d for d in drives if d.get("live")]
    spots: dict = {}            # spot id -> (spot, teams)
    if DG.SEASON not in seasons:
        seasons.append(DG.SEASON)
    for season in seasons:
        pbp = data.load(tuple(PL.pbp_seasons(range(season - 2, season + 1))))
        for r in runs:
            if r["season"] == season:
                r["games"] = []
                for gid, g in playoff_games(games.reset_index(), season, r["team"]).set_index("game_id").iterrows():
                    home = TEAM_NOW.get(g["home_team"], g["home_team"]) == r["team"]
                    mine, theirs = (g["home_score"], g["away_score"]) if home else (g["away_score"], g["home_score"])
                    r["games"].append({"id": run_spot(pbp, gid, r["team"]), "round": ROUND.get(g["game_type"], g["game_type"]),
                                       "opp": TEAM_NOW.get(g["away_team"] if home else g["home_team"], g["away_team"] if home else g["home_team"]),
                                       "home": home, "won": bool(mine > theirs), "score": f"{int(mine)}\u2013{int(theirs)}"})
        want = {d["id"] for d in drives if int(d["id"][:4]) == season and not d.get("live")} | {x["id"] for r in runs if r["season"] == season for x in r["games"]}
        cand = DG.candidates(pbp, lib, keep={i: "drill" for i in want}).drop_duplicates("spot_id").set_index("spot_id", drop=False)
        missing = sorted(want - set(cand.index))
        if missing:
            raise RuntimeError(f"spots missing from the {season} data: {missing}")
        receive2h = DG.receive2h_of(pbp)
        hist = HI.History(bundle, lib, seasons=(season,), pbp=pbp)
        ids = sorted(want)
        season_spots = [DG.spot_record(cand.loc[i], games.loc[i.split("#")[0]], receive2h) for i in ids]
        teams = DG.team_chunks(hist, season_spots, games, chunk=10 ** 6)[0] if season_spots else {}
        for k, i in enumerate(ids):
            spots[i] = (season_spots[k], teams[str(k)])
        for d in live:
            if d["live"]["season"] == season:
                spots[d["id"]] = live_spot(hist, games, pbp, d)
        if season == DG.SEASON:          # Versus: the teams as they line up now (public, web/teams.json)
            vt = versus_teams(hist, games.reset_index(), pbp, season)
            (DG.WEB / "teams.json").write_text(json.dumps(vt, separators=(",", ":"), default=float, allow_nan=False))

    def export(name: str, prefix: str, head: dict, order: list) -> int:
        out = {**head, "spots": [spots[i][0] for i in order], "spot_chunk": DG.SPOT_CHUNK,
               "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
        chunks: dict = {}
        for k, i in enumerate(order):
            chunks.setdefault(k // DG.SPOT_CHUNK, {})[str(k)] = spots[i][1]
        for bad in DG._nan_paths(out) + [f"{prefix}{k}:{q}" for k, ch in chunks.items() for q in DG._nan_paths(ch)]:
            raise ValueError(f"not a number in the export: {bad}")
        (OUT / name).write_text(json.dumps(out, separators=(",", ":"), default=float, allow_nan=False))
        for k, ch in chunks.items():
            (OUT / f"{prefix}{k}.json").write_text(json.dumps(ch, separators=(",", ":"), default=float, allow_nan=False))
        return len(chunks)

    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):
        stale.unlink()
    d_order = [d["id"] for d in drives]
    nd = export("drives.json", "d", {"drives": [{"title": d["title"], "note": d["note"], "spot": i} for i, d in enumerate(drives)]}, d_order)
    r_order, r_out = [], []
    for r in runs:
        gs = []
        for x in r["games"]:
            r_order.append(x["id"])
            gs.append({**{k: v for k, v in x.items() if k != "id"}, "spot": len(r_order) - 1})
        r_out.append({"title": r["title"], "season": r["season"], "team": r["team"], "games": gs})
    nr = export("runs.json", "r", {"runs": r_out}, r_order)
    return {"drives": len(drives), "drive_chunks": nd, "runs": len(runs), "run_games": len(r_order), "run_chunks": nr}
