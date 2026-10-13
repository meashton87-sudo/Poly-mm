"""Coach fingerprints for the daily game's "You coached like ..." line.

Every head coach since 2016 is described by how his offense played late in close games and halves,
each measure compared with what the league did in the same situations (so a two-minute drill full of
passes doesn't make anyone look pass-happy):

  pass   dropbacks over expected, by game mode, down, distance and field zone
  deep   throws 20+ yards downfield over expected, among targeted passes in those same spots
  go     fourth-down go-for-it rate over expected, by distance, field zone and score
  two    two-point tries over expected after fourth-quarter touchdowns, by score

The window is the final 5:00 of a one-score fourth quarter and the final 2:00 of the first half. Each
measure is shrunk toward the league (coaches with few plays sit near average), then scaled by its spread
across coaches so the four count alike. The game measures the player the same way from their calls
(against what NFL play-callers do in the same spot) and names the nearest coach.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config
from .library import fine_key, game_mode

SEASONS = tuple(range(2016, 2027))
SHRINK = {"pass": 120, "deep": 60, "go": 25, "two": 6}
MIN_PLAYS = 250
COACH_FIX = {"Klint Kubliak": "Klint Kubiak"}


def _load() -> pd.DataFrame:
    cols = ["season", "game_id", "posteam", "home_team", "home_coach", "away_coach", "qtr", "down", "ydstogo",
            "yardline_100", "game_seconds_remaining", "half_seconds_remaining", "posteam_score", "defteam_score",
            "play_type", "qb_dropback", "air_yards", "two_point_attempt", "touchdown", "td_team", "extra_point_attempt",
            "score_differential"]
    frames = []
    for s in SEASONS:
        p = config.RAW_DIR / f"play_by_play_{s}.parquet"
        if p.exists():
            frames.append(pd.read_parquet(p, columns=cols))
    d = pd.concat(frames, ignore_index=True)
    d["coach"] = np.where(d["posteam"] == d["home_team"], d["home_coach"], d["away_coach"])
    d["coach"] = d["coach"].replace(COACH_FIX)
    d["margin"] = d["posteam_score"] - d["defteam_score"]
    return d[d["coach"].notna() & d["posteam"].notna()]


def _over_expected(df: pd.DataFrame, flag: pd.Series, cell: pd.Series) -> pd.DataFrame:
    """Per coach: sum of (flag - league rate in the same cell) and the count."""
    exp = flag.groupby(cell).transform("mean")
    r = pd.DataFrame({"coach": df["coach"], "x": flag - exp})
    return r.groupby("coach")["x"].agg(["sum", "size"])


def fingerprints() -> dict:
    d = _load()
    half = np.where(d["qtr"] <= 2, 1, 2)
    late = (((d["qtr"] == 4) & (d["game_seconds_remaining"] <= 300) & (d["margin"].abs() <= 8))
            | ((d["qtr"] == 2) & (d["half_seconds_remaining"] <= 120)))
    snap = d["play_type"].isin(["pass", "run"]) & d["down"].notna()
    s = d[late & snap].copy()
    s["fine"] = fine_key(game_mode(np.where(s["qtr"] <= 2, 1, 2), s["half_seconds_remaining"].to_numpy(), s["margin"].to_numpy()),
                         s["down"].to_numpy(), s["ydstogo"].to_numpy(), s["yardline_100"].to_numpy())
    feats = {}
    feats["pass"] = _over_expected(s, (s["qb_dropback"] == 1).astype(float), s["fine"])
    t = s[(s["play_type"] == "pass") & s["air_yards"].notna()]
    feats["deep"] = _over_expected(t, (t["air_yards"] >= 20).astype(float), t["fine"])
    # fourth downs: final 10:00 of the game or 2:00 of the half, within 16
    f4 = d[(d["down"] == 4) & ((((d["qtr"] == 4) & (d["game_seconds_remaining"] <= 600)) | ((d["qtr"] == 2) & (d["half_seconds_remaining"] <= 120))))
           & (d["margin"].abs() <= 16) & d["play_type"].isin(["pass", "run", "punt", "field_goal"])]
    go = f4["play_type"].isin(["pass", "run"]).astype(float)
    cell4 = (np.clip(f4["ydstogo"], 1, 10).astype(int).astype(str) + "|" + (f4["yardline_100"] // 10).astype(int).astype(str) + "|"
             + np.sign(f4["margin"]).astype(int).astype(str) + "|" + (f4["qtr"] == 4).astype(str))
    feats["go"] = _over_expected(f4, go, cell4)
    # tries after fourth-quarter touchdowns: margin after the touchdown (before the try)
    tr = d[(d["qtr"] == 4) & ((d["two_point_attempt"] == 1) | (d["extra_point_attempt"] == 1))]
    tr = tr[tr["margin"].abs() <= 16]
    feats["two"] = _over_expected(tr, (tr["two_point_attempt"] == 1).astype(float), tr["margin"].clip(-16, 16))
    plays = s.groupby("coach").size()
    seasons = d.groupby("coach")["season"].agg(["min", "max"])
    teams = d.sort_values("season", kind="stable").groupby("coach")["posteam"].agg(lambda x: list(dict.fromkeys(x)))
    coaches = plays[plays >= MIN_PLAYS].index
    out, spread = {}, {}
    for k, f in feats.items():
        f = f.reindex(coaches).fillna(0.0)
        val = f["sum"] / (f["size"] + SHRINK[k])            # shrunk toward the league (0)
        spread[k] = float(val.std()) or 1.0
        for c in coaches:
            out.setdefault(c, {})[k] = float(val[c])
    recs = []
    for c in coaches:
        recs.append({"name": c, "from": int(seasons.loc[c, "min"]), "to": int(seasons.loc[c, "max"]),
                     "teams": teams[c][:4], "plays": int(plays[c]),
                     "z": {k: round(out[c][k] / spread[k], 3) for k in feats}})
    return {"coaches": sorted(recs, key=lambda r: r["name"]), "spread": {k: round(v, 5) for k, v in spread.items()},
            "measures": list(feats)}
