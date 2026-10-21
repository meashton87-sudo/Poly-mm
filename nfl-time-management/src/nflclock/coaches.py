"""Coach fingerprints for the daily game's "You coached like ..." line.

Every head coach since 1999 (nflverse play-by-play) is described by how his offense played late in close
games and halves, each measure compared with what the league did in the same situations in his own era
(so a two-minute drill full of passes doesn't make anyone look pass-happy, and a 2003 coach who went for
it on fourth down reads as aggressive for his time, not timid by today's standards):

  pass   dropbacks over expected, by game mode, down, distance and field zone
  deep   throws 20+ yards downfield over expected, among targeted passes in those same spots
  go     fourth-down go-for-it rate over expected, by distance, field zone and score
  two    two-point tries over expected after fourth-quarter touchdowns, by score

The window is the final 5:00 of a one-score fourth quarter and the final 2:00 of the first half. Each
measure is shrunk toward the league (coaches with few plays sit near average), then scaled by its spread
across coaches so the four count alike. The game measures the player the same way from their calls
(against what NFL play-callers do in the same spot) and names the nearest coach.

The play-callers (play_callers.json: who called the offense and who called the defense, team by team and week by
week, 2022 on; a head coach who called his own side is its play-caller) are fit the same way from the snaps they
called: the offense's four measures, and the defense's three from the charting the game's full defense uses, each
against what defenses did in the same spots in the same era:

  blitz  five or more pass rushers, on dropbacks (NGS pass rushers, 2016 on; FTN's where NGS has none yet: the current season)
  load   eight or more men in the box, every snap (FTN, 2022 on; NGS before)
  soft   a deep zone shell (Cover 2, 3, 4, 6, 9 or prevent: engine.js DC.cover c2/c3/c4/c6/prevent), where charted (NGS,
         2018 on: a 2016-2017 defense is measured on the first two only, the third shrunk to the league's)
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, data
from .library import fine_key, game_mode

SEASONS = tuple(range(1999, 2027))
ERA = 3            # seasons pooled for "what the league did then" (the league passes and gambles more every year)
SHRINK = {"pass": 120, "deep": 60, "go": 25, "two": 6}
MIN_PLAYS = 150     # late-game snaps; fewer plays sit nearer the league average (SHRINK), so small samples stay modest
COACH_FIX = {"Klint Kubliak": "Klint Kubiak"}
CALLERS = Path(__file__).with_name("play_callers.json")
CALLER_MIN = 100   # late-game snaps called, about a season's worth (a team has 100-180 a year): fill-ins of a few games are left out
DEF_SHRINK = {"blitz": 80, "load": 80, "soft": 80}   # league-average snaps added to each play-caller's (as SHRINK)
SOFT_SHELLS = {"COVER_2", "COVER_3", "COVER_4", "COVER_6", "COVER_9", "PREVENT"}
SHELLS = SOFT_SHELLS | {"COVER_0", "COVER_1", "2_MAN"}   # the shells the game knows (playbook.py SHELL_CODE): not COMBO, BLOWN
# Head coaches the nflverse schedule still has wrong for a season (it carried last year's coach forward), by
# (season, team): the coach who actually ran the team that year.
COACH_SEASON = {(2026, "ARI"): "Mike LaFleur", (2026, "ATL"): "Kevin Stefanski", (2026, "BUF"): "Joe Brady"}


def coach_name(name, team, season):
    """The head coach to show: the season override for the team, else the schedule's name with spelling fixed."""
    try:
        fixed = COACH_SEASON.get((int(season), str(team)))
    except (TypeError, ValueError):
        fixed = None
    return fixed or COACH_FIX.get(name, name)


def _load() -> pd.DataFrame:
    cols = ["season", "week", "game_id", "play_id", "posteam", "defteam", "home_team", "home_coach", "away_coach", "qtr", "down", "ydstogo",
            "yardline_100", "game_seconds_remaining", "half_seconds_remaining", "posteam_score", "defteam_score",
            "play_type", "qb_dropback", "air_yards", "two_point_attempt", "touchdown", "td_team", "extra_point_attempt",
            "score_differential"]
    missing = [s for s in SEASONS if s < min(config.MODEL_SEASONS) and not (config.RAW_DIR / f"play_by_play_{s}.parquet").exists()]
    if missing:                                   # the older seasons only feed the coaches: fetch them here
        data.download(missing)
    frames = []
    for s in SEASONS:
        p = config.RAW_DIR / f"play_by_play_{s}.parquet"
        if p.exists():
            frames.append(pd.read_parquet(p, columns=cols))
    d = pd.concat(frames, ignore_index=True)
    d["coach"] = np.where(d["posteam"] == d["home_team"], d["home_coach"], d["away_coach"])
    d["coach"] = d["coach"].replace(COACH_FIX)
    for (season, team), name in COACH_SEASON.items():
        d.loc[(d["season"] == season) & (d["posteam"] == team), "coach"] = name
    d["margin"] = d["posteam_score"] - d["defteam_score"]
    return d[d["coach"].notna() & d["posteam"].notna()].reset_index(drop=True)


def _over_expected(df: pd.DataFrame, flag: pd.Series, cell: pd.Series) -> pd.DataFrame:
    """Per coach: sum of (flag - league rate in the same cell, in the same era) and the count."""
    cell = cell.astype(str) + "@" + (df["season"] // ERA).astype(str)
    exp = flag.groupby(cell).transform("mean")
    r = pd.DataFrame({"coach": df["coach"], "x": flag - exp})
    return r.groupby("coach")["x"].agg(["sum", "size"])


def _late(d: pd.DataFrame) -> pd.DataFrame:
    """The late-game run and pass snaps (the final 5:00 of a one-score fourth quarter, the final 2:00 of the first
    half), each with its situation (library.fine_key)."""
    late = (((d["qtr"] == 4) & (d["game_seconds_remaining"] <= 300) & (d["margin"].abs() <= 8))
            | ((d["qtr"] == 2) & (d["half_seconds_remaining"] <= 120)))
    snap = d["play_type"].isin(["pass", "run"]) & d["down"].notna()
    s = d[late & snap].copy()
    s["fine"] = fine_key(game_mode(np.where(s["qtr"] <= 2, 1, 2), s["half_seconds_remaining"].to_numpy(), s["margin"].to_numpy()),
                         s["down"].to_numpy(), s["ydstogo"].to_numpy(), s["yardline_100"].to_numpy())
    return s


def _offense_feats(d: pd.DataFrame, s: pd.DataFrame) -> dict:
    """The four offensive measures, per d["coach"] (a row without one counts toward the league only)."""
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
    return feats


def _shrunk_z(feats: dict, names, shrink: dict) -> tuple[dict, dict]:
    """Each measure shrunk toward the league (0) by its pseudo-count, then scaled by its spread across the names."""
    out, spread = {}, {}
    for k, f in feats.items():
        f = f.reindex(names).fillna(0.0)
        val = f["sum"] / (f["size"] + shrink[k])            # shrunk toward the league (0)
        spread[k] = float(val.std()) or 1.0
        for c in names:
            out.setdefault(c, {})[k] = round(float(val[c]) / spread[k], 3)
    return out, spread


def fingerprints() -> dict:
    d = _load()
    s = _late(d)
    feats = _offense_feats(d, s)
    plays = s.groupby("coach").size()
    seasons = d.groupby("coach")["season"].agg(["min", "max"])
    teams = d[d["posteam"].astype(str).str.len() > 0].sort_values("season", kind="stable").groupby("coach")["posteam"].agg(
        lambda x: list(dict.fromkeys(x)))
    coaches = plays[plays >= MIN_PLAYS].index
    z, spread = _shrunk_z(feats, coaches, SHRINK)
    recs = []
    for c in coaches:
        recs.append({"name": c, "from": int(seasons.loc[c, "min"]), "to": int(seasons.loc[c, "max"]),
                     "teams": teams[c][:4], "plays": int(plays[c]), "z": z[c]})
    return {"coaches": sorted(recs, key=lambda r: r["name"]), "spread": {k: round(v, 5) for k, v in spread.items()},
            "measures": list(feats), **play_caller_fingerprints(d, s)}


# ------------------------------------------------------------------------------------------ play-callers ---
def load_callers(verified: bool = True) -> pd.DataFrame:
    """play_callers.json as rows (season, team, side, name, from_week, to_week, ...); the unverified left out by default."""
    r = pd.DataFrame(json.loads(CALLERS.read_text())["callers"])
    if "unverified" not in r:
        r["unverified"] = False
    if verified:
        r = r[~r["unverified"].fillna(False).astype(bool)]
    return r.reset_index(drop=True)


def last_week(season):
    """The last regular-season week: 17 through 2020, 18 from 2021 (the 17-game season)."""
    return np.where(np.asarray(season) <= 2020, 17, 18)


def caller_of(d: pd.DataFrame, side: str, callers: pd.DataFrame | None = None) -> pd.Series:
    """Who called the plays on each row of d for its offense (side "off": posteam) or its defense ("def": defteam); a
    playoff game goes to the caller of the season's last regular week (17 to 2020, 18 from 2021). NaN where play_callers.json has no verified name."""
    c = load_callers() if callers is None else callers
    c = c[c["side"] == side]
    weeks = [(r.season, r.team, w, r.name) for r in c.itertuples() for w in range(int(r.from_week), int(r.to_week) + 1)]
    m = pd.DataFrame(weeks, columns=["season", "team", "week", "caller"]).drop_duplicates(["season", "team", "week"])
    key = pd.DataFrame({"season": d["season"].to_numpy().astype(int), "team": d["posteam" if side == "off" else "defteam"].to_numpy(),
                        "week": pd.to_numeric(d["week"], errors="coerce").fillna(0).to_numpy().astype(int)})
    key["week"] = np.minimum(key["week"], last_week(key["season"]))
    return pd.Series(key.merge(m, on=["season", "team", "week"], how="left")["caller"].to_numpy(), index=d.index)


def _charting(s: pd.DataFrame) -> pd.DataFrame:
    """The snaps' defensive charting: pass rushers (NGS, else FTN), men in the box (FTN, else NGS: before 2022),
    coverage shell (NGS, 2018 on)."""
    ngs, ftn = [], []
    for yr in sorted(int(x) for x in s["season"].unique()):
        p = config.RAW_DIR / f"pbp_participation_{yr}.parquet"
        if p.exists():
            ngs.append(pd.read_parquet(p, columns=["nflverse_game_id", "play_id", "number_of_pass_rushers", "defense_coverage_type",
                                               "defenders_in_box"])
                       .rename(columns={"nflverse_game_id": "game_id"}))
        f = config.RAW_DIR / f"ftn_charting_{yr}.parquet"
        if f.exists():
            ftn.append(pd.read_parquet(f, columns=["nflverse_game_id", "nflverse_play_id", "n_defense_box", "n_pass_rushers"])
                       .rename(columns={"nflverse_game_id": "game_id", "nflverse_play_id": "play_id"}))
    out = s[["game_id", "play_id"]].copy()
    out["play_id"] = pd.to_numeric(out["play_id"], errors="coerce")
    for frames in (ngs, ftn):
        if frames:
            x = pd.concat(frames, ignore_index=True)
            x["play_id"] = pd.to_numeric(x["play_id"], errors="coerce")
            out = out.merge(x.drop_duplicates(["game_id", "play_id"]), on=["game_id", "play_id"], how="left")
    for c in ("number_of_pass_rushers", "defense_coverage_type", "defenders_in_box", "n_defense_box", "n_pass_rushers"):
        if c not in out:
            out[c] = np.nan
    out.index = s.index
    return out


def _defense_feats(s: pd.DataFrame) -> dict:
    """The three defensive measures, per s["coach"] (here the defense's play-caller), over the charted snaps."""
    s = s[s["season"] >= 2016]                      # (no charting before the NGS participation data)
    ch = _charting(s)
    rush = pd.to_numeric(ch["number_of_pass_rushers"], errors="coerce").fillna(pd.to_numeric(ch["n_pass_rushers"], errors="coerce"))
    box = pd.to_numeric(ch["n_defense_box"], errors="coerce").fillna(pd.to_numeric(ch["defenders_in_box"], errors="coerce"))
    shell = ch["defense_coverage_type"].astype("string")
    feats = {}
    m = (s["qb_dropback"] == 1) & (rush > 0)
    feats["blitz"] = _over_expected(s[m], (rush[m] >= 5).astype(float), s.loc[m, "fine"])
    m = box > 0
    feats["load"] = _over_expected(s[m], (box[m] >= 8).astype(float), s.loc[m, "fine"])
    m = shell.isin(SHELLS).fillna(False).astype(bool)
    feats["soft"] = _over_expected(s[m], shell[m].isin(SOFT_SHELLS).astype(float), s.loc[m, "fine"])
    return feats


def _stints(rows: pd.DataFrame) -> list:
    """[team, first season, last season] for each run of seasons a play-caller called for one team, in order."""
    out = []
    from .scenario import era_name                  # (a moved franchise by its city of the time: a new stint)
    city = lambda t, y: (era_name(t, y) or {}).get("name", t)
    for season, team in sorted(set(zip(rows["season"].astype(int), rows["team"]))):
        if out and out[-1][0] == team and out[-1][2] in (season - 1, season) and city(team, season) == city(team, out[-1][2]):
            out[-1][2] = season
        else:
            out.append([team, season, season])
    return out


def play_caller_fingerprints(d: pd.DataFrame | None = None, s: pd.DataFrame | None = None) -> dict:
    """The offenses' and the defenses' play-callers (play_callers.json, its verified rows) with at least CALLER_MIN
    late-game snaps called: {"oc": {...}, "dc": {...}}, each like the head coaches' block (callers, each with his
    stints [team, from, to], his snaps and his z per measure; the spread; the measures)."""
    if d is None:
        d = _load()
    if s is None:
        s = _late(d)
    table = load_callers()
    out = {}
    for side, block in (("off", "oc"), ("def", "dc")):
        dd, ss = d.copy(), s.copy()
        dd["coach"] = caller_of(dd, side, table)
        ss["coach"] = caller_of(ss, side, table)
        feats, shrink = (_offense_feats(dd, ss), SHRINK) if side == "off" else (_defense_feats(ss), DEF_SHRINK)
        plays = ss.groupby("coach").size()
        names = plays[plays >= CALLER_MIN].index
        z, spread = _shrunk_z(feats, names, shrink)
        t = table[table["side"] == side]
        recs = [{"name": c, "stints": _stints(t[t["name"] == c])[-4:], "plays": int(plays[c]), "z": z[c]} for c in names]
        out[block] = {"callers": sorted(recs, key=lambda r: r["name"]), "spread": {k: round(v, 5) for k, v in spread.items()},
                      "measures": list(feats), "min_plays": CALLER_MIN}
    return out
