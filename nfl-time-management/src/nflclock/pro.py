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


def build(bundle=None, lib=None) -> dict:
    bundle = bundle or Bundle.load()
    lib = lib if lib is not None else P.labeled_plays()
    drives = json.loads(DRIVES.read_text(encoding="utf-8"))
    runs = json.loads(RUNS.read_text(encoding="utf-8"))
    games = pd.read_csv(config.RAW_DIR / "games.csv").set_index("game_id")
    seasons = sorted({int(d["id"][:4]) for d in drives} | {r["season"] for r in runs})
    spots: dict = {}            # spot id -> (spot, teams)
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
        want = {d["id"] for d in drives if int(d["id"][:4]) == season} | {x["id"] for r in runs if r["season"] == season for x in r["games"]}
        cand = DG.candidates(pbp, lib, keep={i: "drill" for i in want}).drop_duplicates("spot_id").set_index("spot_id", drop=False)
        missing = sorted(want - set(cand.index))
        if missing:
            raise RuntimeError(f"spots missing from the {season} data: {missing}")
        receive2h = DG.receive2h_of(pbp)
        hist = HI.History(bundle, lib, seasons=(season,), pbp=pbp)
        ids = sorted(want)
        season_spots = [DG.spot_record(cand.loc[i], games.loc[i.split("#")[0]], receive2h) for i in ids]
        teams = DG.team_chunks(hist, season_spots, games, chunk=10 ** 6)[0]
        for k, i in enumerate(ids):
            spots[i] = (season_spots[k], teams[str(k)])

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
