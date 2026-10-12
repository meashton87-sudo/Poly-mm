"""Live roster sync and game contexts for upcoming games.

`sync()` pulls the latest nflverse schedule, depth charts (snapshotted daily), injury reports and
weekly rosters, then for each team in a game picks the current starting QB, kicker and punter
(skipping anyone listed Out or Doubtful), rates them, and writes a live game context to
``artifacts/live/<game_id>.json``. The Python console and the browser tool both read that file.

Team strength = as-of team ratings (all games through last week)
              + QB adjustment (starter's rating minus the QB mix behind the team rating)
              + injury adjustments for starters ruled Out/Doubtful (transparent heuristic table).
"""
from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config
from .context import TeamInfo, ot_wp

LIVE_RAW = config.RAW_DIR / "live"
LIVE_OUT = config.ARTIFACT_DIR / "live"
SOURCES = {
    "depth_charts": "depth_charts/depth_charts_{season}.parquet",
    "injuries": "injuries/injuries_{season}.parquet",
    "rosters": "weekly_rosters/roster_weekly_{season}.parquet",
}
BASE = "https://github.com/nflverse/nflverse-data/releases/download/"

# EPA/play effect of losing a starter, by depth-chart slot (offense: lower is worse; defense: higher is
# worse, matching the rating signs). Deliberately small and transparent; edit to taste.
INJURY_IMPACT = {
    # slot group: (pass, rush) shift applied to the team's offense (off_*) or defense (def_*)
    "WR": ("off", -0.012, 0.0), "TE": ("off", -0.006, -0.004), "RB": ("off", -0.002, -0.006),
    "OL": ("off", -0.006, -0.006),
    "EDGE": ("def", 0.008, 0.004), "DL": ("def", 0.004, 0.008), "LB": ("def", 0.004, 0.006),
    "CB": ("def", 0.012, 0.0), "S": ("def", 0.006, 0.003),
}
SLOT_GROUP = {
    "WR": "WR", "LWR": "WR", "RWR": "WR", "SWR": "WR", "TE": "TE", "RB": "RB",
    "LT": "OL", "LG": "OL", "C": "OL", "RG": "OL", "RT": "OL",
    "LDE": "EDGE", "RDE": "EDGE", "LOLB": "EDGE", "ROLB": "EDGE", "WLB": "LB", "SLB": "LB",
    "MLB": "LB", "LILB": "LB", "RILB": "LB", "LDT": "DL", "RDT": "DL", "NT": "DL", "DT": "DL",
    "LCB": "CB", "RCB": "CB", "NB": "CB", "SS": "S", "FS": "S",
}
QB_PRIOR_DROPBACKS = 200.0
QB_PRIOR_MEAN = -0.08     # a QB we know little about plays like a backup
QB_SHARE_OF_PASSING = 0.75


def _fetch(path_tmpl: str, season: int, force: bool) -> pd.DataFrame:
    LIVE_RAW.mkdir(parents=True, exist_ok=True)
    rel = path_tmpl.format(season=season)
    dest = LIVE_RAW / rel.split("/")[-1]
    if force or not dest.exists():
        urllib.request.urlretrieve(BASE + rel, dest)
    return pd.read_parquet(dest)


def refresh(season: int, force: bool = True) -> dict:
    """Download the current-season sources (schedule, play-by-play, depth charts, injuries, rosters)."""
    from . import data
    if force:
        data.download([season], force=True)
        for p in config.CACHE_DIR.glob("pbp_*.parquet"):
            p.unlink()
    return {k: _fetch(v, season, force) for k, v in SOURCES.items()}


def load_sources(season: int) -> dict:
    return {k: _fetch(v, season, False) for k, v in SOURCES.items()}


# ------------------------------------------------------------------- QBs ---
def qb_ratings(pbp_raw: pd.DataFrame, team_ratings: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    """Opponent-adjusted EPA per dropback for every QB, as of (season, week), shrunk toward a backup prior."""
    d = pbp_raw[(pbp_raw["qb_dropback"] == 1) & pbp_raw["epa"].notna() & pbp_raw["passer_id"].notna()].copy()
    d = d[(d["season"] < season) | ((d["season"] == season) & (d["week"] < week))]
    tr = team_ratings[["season", "week", "team", "def_pass", "mu_pass"]]
    d = d.merge(tr.rename(columns={"team": "defteam"}), on=["season", "week", "defteam"], how="left")
    d["resid"] = d["epa"] - d["mu_pass"].fillna(d["epa"].mean()) - d["def_pass"].fillna(0.0)
    age = (season - d["season"]) * 30 + (week - d["week"])
    d["w"] = 0.5 ** (age / 30.0)
    g = d.assign(rw=d["resid"] * d["w"]).groupby("passer_id").agg(
        rw=("rw", "sum"), w=("w", "sum"), n=("epa", "size"), name=("name", "last"), team=("posteam", "last"))
    g["rating"] = (g["rw"] + QB_PRIOR_DROPBACKS * QB_PRIOR_MEAN) / (g["w"] + QB_PRIOR_DROPBACKS)
    return g.reset_index()


def team_qb_mix(pbp_raw: pd.DataFrame, team: str, season: int, week: int) -> pd.Series:
    """Dropback share by QB behind the team's current pass rating (same decay as the team ratings)."""
    d = pbp_raw[(pbp_raw["qb_dropback"] == 1) & (pbp_raw["posteam"] == team) & pbp_raw["passer_id"].notna()]
    d = d[(d["season"] < season) | ((d["season"] == season) & (d["week"] < week))]
    d = d[d["season"] >= season - 1]
    age = (season - d["season"]) * 30 + (week - d["week"])
    w = 0.5 ** (age / 12.0)
    s = w.groupby(d["passer_id"]).sum()
    return s / s.sum() if s.sum() > 0 else s


# ------------------------------------------------------------- personnel ---
def latest_depth(depth: pd.DataFrame, team: str) -> pd.DataFrame:
    t = depth[depth["team"] == team]
    return t[t["dt"] == t["dt"].max()]


def unavailable(injuries: pd.DataFrame, team: str, week: int) -> pd.DataFrame:
    i = injuries[(injuries["team"] == team) & (injuries["week"] == week)]
    return i[i["report_status"].isin(["Out", "Doubtful"])]


def pick_starter(dc: pd.DataFrame, slot: str, out_ids: set):
    c = dc[dc["pos_abb"] == slot].sort_values("pos_rank")
    for _, r in c.iterrows():
        if r["gsis_id"] not in out_ids:
            return r
    return c.iloc[0] if len(c) else None


def injury_adjustments(dc: pd.DataFrame, out: pd.DataFrame) -> tuple[dict, list]:
    adj = {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0}
    notes = []
    starters = dc[(dc["pos_rank"] == 1) & dc["pos_abb"].isin(SLOT_GROUP)]
    out_ids = set(out["gsis_id"])
    for _, r in starters.drop_duplicates("gsis_id").iterrows():
        if r["gsis_id"] not in out_ids:
            continue
        grp = SLOT_GROUP[r["pos_abb"]]
        side, dp, dr = INJURY_IMPACT[grp]
        adj[f"{side}_pass"] += dp
        adj[f"{side}_rush"] += dr
        status = out.loc[out["gsis_id"] == r["gsis_id"], "report_status"].iat[0]
        notes.append(f"{r['player_name']} ({r['pos_abb']}, {status})")
    return adj, notes


def team_live(bundle, sources, pbp_raw, team: str, season: int, week: int) -> dict:
    tr = bundle.team_ratings
    rows = tr[(tr["season"] == season) & (tr["team"] == team)]
    r = rows[rows["week"] == rows["week"].max()].iloc[0]
    dc = latest_depth(sources["depth_charts"], team)
    out = unavailable(sources["injuries"], team, week)
    out_ids = set(out["gsis_id"])
    qb, k, p = pick_starter(dc, "QB", out_ids), pick_starter(dc, "PK", out_ids), pick_starter(dc, "P", out_ids)

    kr = bundle.kicker_ratings
    kr = kr[(kr["season"] == kr["season"].max())]
    kr = kr[kr["week"] == kr["week"].max()].set_index("kicker_player_id")["rating"]
    pr = bundle.punter_ratings
    pr = pr[(pr["season"] == pr["season"].max())]
    pr = pr[pr["week"] == pr["week"].max()].set_index("punter_player_id")["rating"]

    qbr = qb_ratings(pbp_raw, tr, season, int(r["week"])).set_index("passer_id")
    mix = team_qb_mix(pbp_raw, team, season, int(r["week"]))
    mix_rating = float(sum(share * qbr["rating"].get(pid, QB_PRIOR_MEAN) for pid, share in mix.items()))
    qb_id = qb["gsis_id"] if qb is not None else None
    qb_rating = float(qbr["rating"].get(qb_id, QB_PRIOR_MEAN)) if qb_id else QB_PRIOR_MEAN
    qb_adj = QB_SHARE_OF_PASSING * (qb_rating - mix_rating)

    inj_adj, inj_notes = injury_adjustments(dc, out)
    return {
        "team": team,
        "base": {k_: float(r[k_]) for k_ in ("off_pass", "off_rush", "def_pass", "def_rush", "proe")},
        "ratings_asof_week": int(r["week"]),
        "qb": {"name": None if qb is None else qb["player_name"], "id": qb_id, "rating": qb_rating,
               "team_mix_rating": mix_rating, "adjustment": qb_adj},
        "kicker": {"name": None if k is None else k["player_name"], "id": None if k is None else k["gsis_id"],
                   "rating": float(kr.get(k["gsis_id"], 0.0)) if k is not None else 0.0},
        "punter": {"name": None if p is None else p["player_name"], "id": None if p is None else p["gsis_id"],
                   "rating": float(pr.get(p["gsis_id"], 0.0)) if p is not None else 0.0},
        "injury_adjustment": inj_adj,
        "unavailable": inj_notes,
        "injury_report": out[["full_name", "position", "report_status", "report_primary_injury"]]
        .fillna("").to_dict("records"),
    }


def effective(team_rec: dict, manual: dict | None = None) -> TeamInfo:
    """Combine base ratings, QB and injury adjustments (and manual tweaks) into a TeamInfo."""
    b = team_rec["base"]
    ia = team_rec["injury_adjustment"]
    m = manual or {}
    return TeamInfo(
        team=team_rec["team"],
        off_pass=b["off_pass"] + team_rec["qb"]["adjustment"] + ia["off_pass"] + m.get("off_pass", 0.0),
        off_rush=b["off_rush"] + ia["off_rush"] + m.get("off_rush", 0.0),
        def_pass=b["def_pass"] + ia["def_pass"] + m.get("def_pass", 0.0),
        def_rush=b["def_rush"] + ia["def_rush"] + m.get("def_rush", 0.0),
        proe=b["proe"],
        kicker_rating=m.get("kicker_rating", team_rec["kicker"]["rating"]),
        punter_rating=m.get("punter_rating", team_rec["punter"]["rating"]),
        kicker=team_rec["kicker"]["name"], punter=team_rec["punter"]["name"],
    )


def build_game(game_id: str, bundle=None, sources=None, pbp_raw=None) -> dict:
    from .models import Bundle
    bundle = bundle or Bundle.load()
    games = pd.read_csv(config.RAW_DIR / "games.csv")
    g = games[games["game_id"] == game_id].iloc[0]
    season, week = int(g["season"]), int(g["week"])
    sources = sources or load_sources(season)
    if pbp_raw is None:
        cols = ["season", "week", "posteam", "defteam", "qb_dropback", "epa", "passer_id", "name"]
        pbp_raw = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols)
                             for s in (season - 2, season - 1, season)], ignore_index=True)
    tr = bundle.team_ratings
    last = tr[tr["season"] == season]
    last = last[last["week"] == last["week"].max()].iloc[0]
    home = team_live(bundle, sources, pbp_raw, g["home_team"], season, week)
    away = team_live(bundle, sources, pbp_raw, g["away_team"], season, week)
    spread = float(np.nan_to_num(g["spread_line"]))
    rec = {
        "game_id": game_id, "season": season, "week": week, "gameday": g["gameday"], "gametime": g["gametime"],
        "home": home, "away": away, "home_spread": spread, "total": float(np.nan_to_num(g["total_line"])),
        "roof": g["roof"], "surface": g["surface"], "stadium": g["stadium"],
        "indoor": g["roof"] in ("dome", "closed"),
        "temp": None if pd.isna(g["temp"]) else float(g["temp"]),
        "wind": None if pd.isna(g["wind"]) else float(g["wind"]),
        "home_coach": g["home_coach"], "away_coach": g["away_coach"],
        "league": {"mu_pass": float(last["mu_pass"]), "mu_rush": float(last["mu_rush"]),
                   "home_pass": float(last["home_pass"]), "home_rush": float(last["home_rush"])},
        "ot_wp_home": ot_wp(spread),
        "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "depth_chart_snapshot": str(sources["depth_charts"]["dt"].max()),
    }
    LIVE_OUT.mkdir(parents=True, exist_ok=True)
    (LIVE_OUT / f"{game_id}.json").write_text(json.dumps(rec, indent=1, default=str))
    return rec


def load_game(game_id: str) -> dict:
    return json.loads((LIVE_OUT / f"{game_id}.json").read_text())


def context_from_game(bundle, rec: dict, receive_2h: str | None = None, manual: dict | None = None):
    """GameContext for the simulator from a live game record. receive_2h: team code or None (unknown)."""
    from .context import make_context
    manual = manual or {}
    home = effective(rec["home"], manual.get(rec["home"]["team"]))
    away = effective(rec["away"], manual.get(rec["away"]["team"]))
    lg = rec["league"]
    r2h = 1 if receive_2h in (None, rec["away"]["team"]) else 0
    ctx = make_context(bundle, home, away, home_spread=rec["home_spread"], receive_2h=r2h,
                       indoor=rec["indoor"], wind=rec.get("wind") or 0.0, temp=rec.get("temp") or 65.0,
                       season=rec["season"], mu_pass=lg["mu_pass"], mu_rush=lg["mu_rush"],
                       home_pass=lg["home_pass"], home_rush=lg["home_rush"])
    return ctx, home, away
