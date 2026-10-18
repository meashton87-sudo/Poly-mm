"""College play-by-play: download, prune, normalize to the nflverse schema, enrich, clock quality, out-of-bounds.

Sources (sportsdataverse releases): cfbfastR play-by-play (every division, 2016 on) and ESPN's (2021 on: final
scores, try results, kneels). Each season file is downloaded once and pruned at once to the columns below (all
divisions are kept: FCS and lower games feed the high-school level, cfb/hs.py); the full file is then deleted.

normalize() maps a pruned cfbfastR season onto the nflverse columns that library.py, ratings.py, wp.py, analyze.py
and tendency.py read, so those run unchanged; enrich() is data.enrich (next snap, timeouts between snaps, clock
deltas) plus the college clock: a per-game quality flag and out-of-bounds inferred from the clock (college text
almost never says "out of bounds").
"""
from __future__ import annotations

import re
import shutil
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

from .. import data as D
from .. import library as L
from . import config as K

VERSION = 9               # of normalize/enrich: a change here rebuilds the enriched cache
CFB_COLS = [
    "year", "week", "season_type", "game_id", "id_play", "game_play_number", "drive_number", "drive_play_number",
    "pos_team", "def_pos_team", "home", "away", "home_team_division", "away_team_division", "neutral_site",
    "period", "clock_minutes", "clock_seconds", "play_type", "play_text", "down", "distance", "yards_to_goal",
    "yards_gained", "EPA", "wp_before", "spread", "penalty_flag", "penalty_declined", "penalty_no_play",
    "penalty_offset", "yds_penalty", "penalty_1st_conv", "penalty_text", "pos_team_score", "def_pos_team_score",
    "pos_team_timeouts_rem_before", "def_pos_team_timeouts_rem_before", "off_timeout_called", "def_timeout_called",
    "rush", "pass", "completion", "pass_attempt", "sack", "int", "int_td", "touchdown", "td_play", "safety",
    "fumble_vec", "punt_blocked", "kickoff_onside", "kickoff_tb", "kickoff_fair_catch", "fg_kicker_player_name",
    "yds_fg", "punter_player_name", "yds_punted", "kickoff_player_name", "passer_player_name", "rusher_player_name",
    "receiver_player_name", "sack_player_name", "interception_player_name", "fumble_forced_player_name",
    "pass_breakup_player_name", "drive_result", "start_date", "change_of_pos_team", "home_team_conference",
    "away_team_conference",
]
ESPN_COLS = [
    "season", "week", "seasonType", "game_id", "id", "sequenceNumber", "game_play_number", "period", "clock.minutes",
    "clock.seconds", "type.text", "text", "homeTeamAbbrev", "awayTeamAbbrev", "homeTeamName", "awayTeamName",
    "homeTeamMascot", "awayTeamMascot", "homeFinalScore", "awayFinalScore", "homeTimeoutCalled", "awayTimeoutCalled",
    "kneel_down", "extra_point_result", "two_point_conv_result", "field_goal_result",
]


# ------------------------------------------------------------------ download ---
def _fetch(url: str, dest: Path, tries: int = 5) -> None:
    for k in range(tries):
        try:
            urllib.request.urlretrieve(url, dest)
            return
        except Exception:           # network errors: back off 2, 4, 8, 16 s
            if k == tries - 1:
                raise
            time.sleep(2 ** (k + 1))


def pruned_path(source: str, season: int) -> Path:
    return K.CACHE / f"{source}_{season}.parquet"


def download(seasons=None, force_current: bool = False, force: bool = False, log=print) -> list:
    """Fetch and prune every missing season (the current one again with force_current, all with force)."""
    K.CACHE.mkdir(parents=True, exist_ok=True)
    done = []
    jobs = [("cfb", K.TAG_CFBFASTR, s, CFB_COLS) for s in (seasons or K.SEASONS)] + \
           [("espn", K.TAG_ESPN, s, ESPN_COLS) for s in (seasons or K.SEASONS) if s in K.ESPN_SEASONS]
    for source, tag, season, cols in jobs:
        dest = pruned_path(source, season)
        if dest.exists() and not force and not (force_current and season == K.CURRENT):
            continue
        tmpdir = Path(tempfile.mkdtemp(prefix=f"dl_{source}_{season}_", dir=K.CACHE))   # its own empty folder
        try:
            raw = tmpdir / f"play_by_play_{season}.parquet"
            log(f"downloading {source} {season} ...")
            _fetch(K.RELEASE.format(tag=tag, season=season), raw)
            prune(raw, dest, cols, source)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)    # the full file never stays on disk
        done.append(dest)
    return done


def prune(raw: Path, dest: Path, cols: list, source: str) -> None:
    import pyarrow.parquet as pq
    have = set(pq.ParquetFile(raw).schema_arrow.names)
    df = pd.read_parquet(raw, columns=[c for c in cols if c in have])
    if source == "cfb":
        df = df[df["play_type"].notna()]
    tmp = dest.with_suffix(".part")
    df.to_parquet(tmp, index=False)
    tmp.replace(dest)


def load_pruned(source: str, seasons) -> pd.DataFrame:
    frames = []
    for s in seasons:
        p = pruned_path(source, s)
        if not p.exists():
            download([s])
        if p.exists():
            frames.append(pd.read_parquet(p))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


# ----------------------------------------------------------------- normalize ---
RUN_TYPES = {"Rush", "Rushing Touchdown"}
PASS_TYPES = {"Pass Reception", "Pass Incompletion", "Passing Touchdown", "Sack", "Interception Return",
              "Interception Return Touchdown", "Pass Interception Return", "Interception"}
FUMBLE_TYPES = {"Fumble Recovery (Own)", "Fumble Recovery (Opponent)", "Fumble Return Touchdown",
                "Fumble Recovery (Opponent) Touchdown", "Fumble Recovery (Own) Touchdown", "Safety"}
PUNT_TYPES = {"Punt", "Blocked Punt", "Punt Return Touchdown", "Blocked Punt Touchdown", "Punt Team Fumble Recovery",
              "Punt Team Fumble Recovery Touchdown", "Punt (Safety)", "Blocked Punt (Safety)"}
FG_TYPES = {"Field Goal Good", "Field Goal Missed", "Blocked Field Goal", "Blocked Field Goal Touchdown",
            "Missed Field Goal Return", "Missed Field Goal Return Touchdown"}
KO_TYPES = {"Kickoff", "Kickoff Return (Offense)", "Kickoff Return Touchdown", "Kickoff Team Fumble Recovery",
            "Kickoff Team Fumble Recovery Touchdown"}
DROP_TYPES = {"End Period", "End of Half", "End of Game", "End of Regulation", "placeholder", "Uncategorized",
              "Two Point Pass", "Two Point Rush", "Defensive 2pt Conversion", "Extra Point Good", "Extra Point Missed",
              "Penalty Touchdown"}
TWO_RE = r"two[- ]?point|2[- ]?pt|2 point"
XP_RE = r"\bkick\b|\bpat\b|extra point|\bxp\b"
NO_RECEIVER = r"pass incomplete\s*\.?\s*$|pass incomplete\s*(?:,|\(|clock)"
KNEEL_RE = r"kneel|takes a knee|knee down"
SPIKE_FEED_MAX = 0.15   # a game whose feed leaves more incompletions than this without a receiver cannot show spikes
DRIVE_RESULT = {"TD": "Touchdown", "PASSING TD": "Touchdown", "RUSHING TD": "Touchdown", "FG": "Field goal",
                "FG GOOD": "Field goal", "PUNT": "Punt", "DOWNS": "Turnover on downs", "INT": "Turnover",
                "FUMBLE": "Turnover", "MISSED FG": "Missed field goal", "END OF HALF": "End of half",
                "END OF GAME": "End of half", "SF": "Safety", "INT TD": "Opp touchdown", "FUMBLE TD": "Opp touchdown",
                "PUNT RETURN TD": "Opp touchdown", "BLOCKED PUNT TD": "Opp touchdown", "BLOCKED FG": "Missed field goal"}


def _truthy(s: pd.Series) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").fillna(0).to_numpy() > 0 if s.dtype != bool else s.fillna(False).to_numpy()


def _col(df, c, default=np.nan):
    return df[c] if c in df else pd.Series(default, index=df.index)


def finals(raw: pd.DataFrame, espn: pd.DataFrame | None) -> pd.DataFrame:
    """game_id -> final home/away score: ESPN's where it has the game, else the last score in the play-by-play."""
    r = raw.sort_values(["game_id", "id_play", "drive_number", "drive_play_number"])
    home_off = (r["pos_team"] == r["home"]).to_numpy()
    h = np.where(home_off, r["pos_team_score"], r["def_pos_team_score"])
    a = np.where(home_off, r["def_pos_team_score"], r["pos_team_score"])
    pb = pd.DataFrame({"game_id": r["game_id"].to_numpy(), "h": h, "a": a}).groupby("game_id")[["h", "a"]].max()
    out = pb.rename(columns={"h": "home_score", "a": "away_score"}).astype(float)
    if espn is not None and len(espn):
        e = espn.dropna(subset=["homeFinalScore", "awayFinalScore"]).drop_duplicates("game_id").set_index("game_id")
        idx = out.index.intersection(e.index)
        out.loc[idx, "home_score"] = e.loc[idx, "homeFinalScore"].to_numpy()
        out.loc[idx, "away_score"] = e.loc[idx, "awayFinalScore"].to_numpy()
    return out


def _espn_kneels(espn: pd.DataFrame | None) -> set:
    if espn is None or not len(espn) or "kneel_down" not in espn:
        return set()
    k = espn[espn["kneel_down"].fillna(False).astype(bool)]
    return set(zip(k["game_id"].astype(int), k["period"].astype(int), k["clock.minutes"].astype(int),
                   k["clock.seconds"].astype(int)))


def snap_clock(raw: pd.DataFrame, play_type: np.ndarray, is_to: np.ndarray, keep: np.ndarray, yds: np.ndarray,
               text: pd.Series) -> np.ndarray:
    """Quarter seconds left at each snap. The feeds' clock is the time when the play ended (2026's text stamps say so:
    "clock 07:38" at a play's end is the clock field, and after an incompletion the gap to the next snap is the next
    play's own length: 5 s before another incompletion, 7-12 s before a run or a catch, every season), so the snap is
    that time plus the play's length (library._duration, the engine's own), never earlier than the previous play's
    end in the quarter."""
    t_end = np.clip(raw["clock_minutes"].fillna(0).to_numpy() * 60 + raw["clock_seconds"].fillna(0).to_numpy(), 0, 900)
    inc = (raw["play_type"] == "Pass Incompletion").to_numpy().astype(float)
    sack = (raw["play_type"] == "Sack").to_numpy().astype(float)
    tov = raw["play_type"].astype(str).str.contains("Interception|Fumble Recovery \\(Opponent|Fumble Return", regex=True).to_numpy()
    pen = play_type == "no_play"
    presnap = pen & ~text.str.contains(r"\brush|\brun\b|\bpass|sacked", case=False, regex=True).to_numpy()
    dur = L._duration(np.where(play_type == "run", "run", "pass"), yds, inc, sack, presnap, tov.astype(float))
    ko_tb = text.str.contains("touchback|fair catch", case=False).to_numpy()
    dur = np.select([play_type == "kickoff", play_type == "punt", play_type == "field_goal", play_type == "qb_kneel",
                     play_type == "qb_spike", is_to | ~keep],
                    [np.where(ko_tb, 0.0, 6.0), 9.0, 4.0, 1.5, 1.0, 0.0], dur)
    g = pd.DataFrame({"g": raw["game_id"].to_numpy(), "q": raw["period"].to_numpy(), "t": t_end})
    prev = g.groupby(["g", "q"])["t"].shift(1).fillna(900.0).to_numpy()
    return np.clip(np.minimum(t_end + dur, np.maximum(prev, t_end)), 0, 900)


def normalize(raw: pd.DataFrame, espn: pd.DataFrame | None = None) -> pd.DataFrame:
    """A pruned cfbfastR frame (one or more seasons) as nflverse columns, ready for data.enrich."""
    raw = raw[raw["play_type"].notna() & raw["game_id"].notna()].copy()
    for c in CFB_COLS:            # older seasons (and tests) lack a few columns
        if c not in raw:
            raw[c] = np.nan
    raw["game_id"] = raw["game_id"].astype(np.int64)
    fin = finals(raw, espn)
    kneels = _espn_kneels(espn)
    raw = raw.sort_values(["game_id", "id_play", "drive_number", "drive_play_number"], kind="stable").reset_index(drop=True)
    pt = raw["play_type"].astype(str)
    text = raw["play_text"].fillna("").astype(str)
    gid = raw["game_id"]
    # scores after each play (cfbfastR's pos_team_score is the score once the play and its try are over)
    home_off = (raw["pos_team"] == raw["home"]).to_numpy()
    h_after = pd.Series(np.where(home_off, raw["pos_team_score"], raw["def_pos_team_score"]), index=raw.index).fillna(0)
    a_after = pd.Series(np.where(home_off, raw["def_pos_team_score"], raw["pos_team_score"]), index=raw.index).fillna(0)
    h_after = h_after.groupby(gid).cummax()
    a_after = a_after.groupby(gid).cummax()
    h_before = h_after.groupby(gid).shift(1).fillna(0)
    a_before = a_after.groupby(gid).shift(1).fillna(0)
    dh, da = (h_after - h_before).to_numpy(), (a_after - a_before).to_numpy()

    keep = ~pt.isin(DROP_TYPES).to_numpy() & (raw["period"].fillna(9).to_numpy() <= 4)
    is_to = (pt == "Timeout").to_numpy()
    passish = pt.isin(PASS_TYPES).to_numpy() | (pt.isin(FUMBLE_TYPES).to_numpy() & (
        _truthy(_col(raw, "pass", 0)) | text.str.contains(r"\bpass|sacked", case=False, regex=True).to_numpy()))
    runish = pt.isin(RUN_TYPES).to_numpy() | (pt.isin(FUMBLE_TYPES).to_numpy() & ~passish)
    play_type = np.select(
        [runish, passish, (pt == "Penalty").to_numpy(), pt.isin(PUNT_TYPES).to_numpy(), pt.isin(FG_TYPES).to_numpy(),
         pt.isin(KO_TYPES).to_numpy()],
        ["run", "pass", "no_play", "punt", "field_goal", "kickoff"], default="")
    keep &= (play_type != "") | is_to
    qtr = raw["period"].to_numpy()
    yds = raw["yards_gained"].fillna(0).to_numpy()
    # kneels and spikes are told on the feed's (end-of-play) clock; the snap clock waits for their play types
    qsr = np.clip(raw["clock_minutes"].fillna(0).to_numpy() * 60 + raw["clock_seconds"].fillna(0).to_numpy(), 0, 900)
    gsr = (4 - np.clip(qtr, 1, 4)) * 900 + qsr
    hsr = np.where(np.isin(qtr, [1, 3]), qsr + 900, qsr)
    # kneels: ESPN's flag (2021 on), the text, or a quarterback (or TEAM) losing 0-6 yards on a late lead
    key = list(zip(gid, qtr.astype(int), raw["clock_minutes"].fillna(-1).astype(int), raw["clock_seconds"].fillna(-1).astype(int)))
    espn_kneel = np.array([k in kneels for k in key]) if kneels else np.zeros(len(raw), bool)
    margin_b = np.where(home_off, h_before - a_before, a_before - h_before)
    passers = set(zip(gid, raw["pos_team"], raw["passer_player_name"].fillna("")))
    qb_run = np.array([(g, t, r) in passers and r != "" for g, t, r in zip(gid, raw["pos_team"], raw["rusher_player_name"].fillna(""))])
    team_run = text.str.contains(r"^TEAM run|^Team run|kneel", case=False, regex=True).to_numpy()
    heur = (runish & (qb_run | team_run) & (yds <= 0) & (yds >= -6) & (hsr <= 150) & (margin_b > 0)
            & np.isin(qtr, [2, 4]) & ~(dh != 0) & ~(da != 0))
    kneel = runish & (espn_kneel | text.str.contains(KNEEL_RE, case=False, regex=True).to_numpy() | heur)
    # spikes: said so in the text (2025 on: "pass incomplete, Spike"), or an incompletion with no receiver in the
    # last 2:00 of a half right after a gain kept the clock running, snapped within 25 s of that play's end
    half = np.where(qtr <= 2, 1, 2)
    no_rec = (pt == "Pass Incompletion").to_numpy() & text.str.contains(NO_RECEIVER, case=False, regex=True).to_numpy()
    said = (pt == "Pass Incompletion").to_numpy() & text.str.contains(r"\bspike", case=False, regex=True).to_numpy()
    snapish = np.isin(play_type, ["run", "pass", "no_play"]) & keep
    t_end = raw["clock_minutes"].fillna(0).to_numpy() * 60 + raw["clock_seconds"].fillna(0).to_numpy() + (4 - np.clip(qtr, 1, 4)) * 900
    sn = pd.DataFrame({"g": gid, "h": half, "t": t_end, "gain": ((pt.isin(["Rush", "Pass Reception"]).to_numpy()) & (yds > 0)
                                                                   & (np.maximum(dh, da) == 0)),
                       "pos": raw["pos_team"].to_numpy(object)})[snapish]
    grp = sn.groupby(["g", "h"])
    prev_gain = pd.Series(False, index=raw.index)
    prev_gain[sn.index] = (grp["gain"].shift(1).fillna(False).astype(bool) & (grp["pos"].shift(1) == sn["pos"])
                           & ((grp["t"].shift(1) - sn["t"]) <= 25.0)).to_numpy()
    need = (qtr == 2) | ((qtr == 4) & (margin_b <= 0))      # an offense that needs the clock stopped
    # only where the game's feed names the receiver of nearly every incompletion (some providers name none)
    inc_rows = (pt == "Pass Incompletion").to_numpy()
    named = pd.Series(no_rec[inc_rows]).groupby(gid[inc_rows].to_numpy()).mean()
    need &= gid.map(named).fillna(1.0).to_numpy() <= SPIKE_FEED_MAX
    spike = said | (no_rec & need & (hsr <= 120) & prev_gain.to_numpy())
    raw["_spike_said"] = said
    play_type = np.where(kneel, "qb_kneel", np.where(spike, "qb_spike", play_type))
    qsr = snap_clock(raw, play_type, is_to, keep, yds, text)
    gsr = (4 - np.clip(qtr, 1, 4)) * 900 + qsr
    hsr = np.where(np.isin(qtr, [1, 3]), qsr + 900, qsr)

    posteam = raw["pos_team"].to_numpy(object)
    defteam = raw["def_pos_team"].to_numpy(object)
    to_team = np.where(_truthy(_col(raw, "off_timeout_called", 0)), posteam,
                       np.where(_truthy(_col(raw, "def_timeout_called", 0)), defteam, None))
    parsed = text.str.extract(r"[Tt]imeout\s+([^,]+?)\s*,")[0].to_numpy(object)
    to_team = np.where(is_to & pd.isna(to_team), parsed, to_team)
    # who scored: the team whose score went up on the play
    td = (np.maximum(dh, da) >= 6) & ~is_to
    td_team = np.where(dh >= 6, raw["home"].to_numpy(object), np.where(da >= 6, raw["away"].to_numpy(object), None))
    td_team = np.where(td, td_team, None)
    pen_row = play_type == "no_play"
    pen_yds = np.where(pen_row, yds, pd.to_numeric(_col(raw, "yds_penalty"), errors="coerce").fillna(0).to_numpy())
    penalty = _truthy(_col(raw, "penalty_flag", 0)) | pen_row
    declined = _truthy(_col(raw, "penalty_declined", 0))
    kick_team = np.where(play_type == "kickoff", defteam, posteam)
    fg = play_type == "field_goal"
    fg_res = np.where(pt.isin({"Field Goal Good"}).to_numpy(), "made",
                      np.where(pt.str.contains("Blocked").to_numpy(), "blocked", "missed"))
    punt = play_type == "punt"
    ret_td = (punt | (play_type == "kickoff")) & td & (td_team != kick_team)
    inter = _truthy(_col(raw, "int", 0)) | pt.str.contains("Interception").to_numpy()
    fum_lost = pt.isin({"Fumble Recovery (Opponent)", "Fumble Return Touchdown", "Fumble Recovery (Opponent) Touchdown"}).to_numpy()
    safety = ((dh == 2) | (da == 2)) & ~td & ~fg
    yds_fg = pd.to_numeric(_col(raw, "yds_fg"), errors="coerce").to_numpy()
    kick_dist = np.where(fg, np.where(np.isfinite(yds_fg) & (yds_fg > 0), yds_fg, raw["yards_to_goal"].fillna(0).to_numpy() + 17), np.nan)
    home_ok = raw.groupby("game_id").apply(lambda g: g.loc[g["play_type"].isin(KO_TYPES)].head(1)["pos_team"].eq(g["home"]).any(),
                                           include_groups=False)
    season_type = np.where(raw["season_type"].astype(str).str.startswith("post"), "POST", "REG")
    week = raw["week"].fillna(0).astype(int).to_numpy() + np.where(season_type == "POST", 16, 0)
    hs, as_ = fin.reindex(gid)["home_score"].to_numpy(), fin.reindex(gid)["away_score"].to_numpy()
    out = pd.DataFrame({
        "game_id": gid.astype(str).to_numpy(), "play_id": raw["game_play_number"].fillna(0).to_numpy() * 0 + np.arange(len(raw)),
        "season": raw["year"].astype(int).to_numpy(), "season_type": season_type, "week": week,
        "game_date": _col(raw, "start_date", "").astype(str).str[:10].to_numpy(),
        "home_team": raw["home"].to_numpy(object), "away_team": raw["away"].to_numpy(object),
        "home_div": _col(raw, "home_team_division", "").fillna("").to_numpy(object),
        "away_div": _col(raw, "away_team_division", "").fillna("").to_numpy(object),
        "posteam": np.where(is_to, None, posteam), "defteam": np.where(is_to, None, defteam),
        "posteam_type": np.where(home_off, "home", "away"),
        "yardline_100": raw["yards_to_goal"].to_numpy(float),
        "quarter_seconds_remaining": qsr, "half_seconds_remaining": hsr, "game_seconds_remaining": gsr,
        "game_half": np.where(qtr <= 2, "Half1", "Half2"), "qtr": qtr,
        "down": raw["down"].where(raw["down"].between(1, 4)).to_numpy(float),
        "ydstogo": raw["distance"].to_numpy(float),
        "desc": text.to_numpy(object), "time": [f"{int(m):02d}:{int(s):02d}" for m, s in zip(qsr // 60, qsr % 60)],
        "play_type": np.where(is_to, None, play_type), "yards_gained": np.where(pen_row, 0.0, yds),
        "shotgun": 0.0, "qb_dropback": np.isin(play_type, ["pass", "qb_spike"]).astype(float),
        "qb_kneel": (play_type == "qb_kneel").astype(float), "qb_spike": (play_type == "qb_spike").astype(float),
        "qb_scramble": 0.0, "air_yards": np.nan, "pass_length": None, "pass_location": None,
        "field_goal_result": np.where(fg, fg_res, None), "kick_distance": kick_dist,
        "extra_point_result": None, "two_point_conv_result": None,
        "timeout": is_to.astype(float), "timeout_team": np.where(is_to, to_team, None), "td_team": td_team,
        "posteam_timeouts_remaining": raw["pos_team_timeouts_rem_before"].to_numpy(float),
        "defteam_timeouts_remaining": raw["def_pos_team_timeouts_rem_before"].to_numpy(float),
        "total_home_score": h_after.to_numpy(), "total_away_score": a_after.to_numpy(),
        "posteam_score": np.where(home_off, h_before, a_before), "defteam_score": np.where(home_off, a_before, h_before),
        "posteam_score_post": np.where(home_off, h_after, a_after), "defteam_score_post": np.where(home_off, a_after, h_after),
        "epa": raw["EPA"].to_numpy(float), "wp": raw["wp_before"].to_numpy(float), "vegas_wp": np.nan,
        "punt_blocked": (punt & (_truthy(_col(raw, "punt_blocked", 0)) | pt.str.contains("Blocked").to_numpy())).astype(float),
        "first_down_penalty": _truthy(_col(raw, "penalty_1st_conv", 0)).astype(float),
        "incomplete_pass": np.isin(pt, ["Pass Incompletion"]).astype(float),
        "touchback": ((punt | (play_type == "kickoff")) & text.str.contains("touchback", case=False).to_numpy()).astype(float),
        "interception": inter.astype(float), "fumble_lost": fum_lost.astype(float), "safety": safety.astype(float),
        "penalty": (penalty & ~declined).astype(float), "penalty_yards": np.abs(pen_yds),
        "penalty_team": np.where(pen_yds < 0, posteam, defteam), "penalty_type": np.where(penalty, "Penalty", None),
        "sack": ((pt == "Sack").to_numpy() | _truthy(_col(raw, "sack", 0))).astype(float),
        "touchdown": td.astype(float), "return_touchdown": ret_td.astype(float),
        "pass_touchdown": (td & passish & (td_team == posteam)).astype(float),
        "rush_touchdown": (td & runish & (td_team == posteam)).astype(float),
        "complete_pass": _truthy(_col(raw, "completion", 0)).astype(float),
        "pass": np.where(pen_row, text.str.contains(r"\bpass", case=False, regex=True).to_numpy(), passish).astype(float),
        "rush": np.where(pen_row, text.str.contains(r"\brush|\brun\b", case=False, regex=True).to_numpy(), runish).astype(float),
        "out_of_bounds": 0.0, "return_yards": 0.0,
        "kicker_player_id": np.where(fg, raw["fg_kicker_player_name"].fillna("?").astype(str) + "|" + raw["pos_team"].astype(str), None),
        "kicker_player_name": np.where(fg, raw["fg_kicker_player_name"], None),
        "punter_player_id": np.where(punt & raw["punter_player_name"].notna(),
                                     raw["punter_player_name"].astype(str) + "|" + raw["pos_team"].astype(str), None),
        "punter_player_name": np.where(punt, raw["punter_player_name"], None),
        "own_kickoff_recovery": 0.0, "kickoff_attempt": (play_type == "kickoff").astype(float),
        "punt_attempt": punt.astype(float), "field_goal_attempt": fg.astype(float),
        "extra_point_attempt": 0.0, "two_point_attempt": 0.0, "onside": (_truthy(_col(raw, "kickoff_onside", 0))
                                                                       | text.str.contains("onside", case=False).to_numpy()).astype(float),
        "roof": "outdoors", "surface": None, "temp": 65.0, "wind": 0.0,
        "home_coach": None, "away_coach": None,
        "spread_line": -pd.to_numeric(raw["spread"], errors="coerce").to_numpy(),   # cfbfastR: < 0 = home favored
        "total_line": np.nan, "result": hs - as_, "home_score": hs, "away_score": as_,
        "success": np.nan, "xpass": np.nan, "pass_oe": 0.0, "cpoe": np.nan,
        "fixed_drive": raw["drive_number"].to_numpy(float),
        "fixed_drive_result": raw["drive_result"].astype(str).str.upper().map(DRIVE_RESULT).to_numpy(object),
        "aborted_play": 0.0, "home_opening_kickoff": gid.map(home_ok).fillna(False).astype(float).to_numpy(),
        "first_down": np.nan, "dh": dh, "da": da,
        "passer": _col(raw, "passer_player_name", None).to_numpy(object), "rusher": _col(raw, "rusher_player_name", None).to_numpy(object),
        "receiver": _col(raw, "receiver_player_name", None).to_numpy(object),
        "def_player": _col(raw, "sack_player_name", None).fillna(_col(raw, "interception_player_name", None))
                      .fillna(_col(raw, "fumble_forced_player_name", None)).fillna(_col(raw, "pass_breakup_player_name", None)).to_numpy(object),
        "def_event": np.where(_col(raw, "sack_player_name", None).notna(), "sack",
                              np.where(_col(raw, "interception_player_name", None).notna(), "interception",
                                       np.where(_col(raw, "fumble_forced_player_name", None).notna(), "forced fumble",
                                                np.where(_col(raw, "pass_breakup_player_name", None).notna(), "pass breakup", None)))),
        "t_end": (4 - np.clip(qtr, 1, 4)) * 900 + np.clip(raw["clock_minutes"].fillna(0).to_numpy() * 60
                                                          + raw["clock_seconds"].fillna(0).to_numpy(), 0, 900),
    })
    out = out[keep].reset_index(drop=True)
    out = _add_tries(out)
    out["row_order"] = np.arange(len(out))
    out["play_id"] = out.groupby("game_id").cumcount() + 1.0
    return out.drop(columns=["dh", "da"])


def _add_tries(df: pd.DataFrame) -> pd.DataFrame:
    """A try row after every touchdown (nflverse has them; cfbfastR folds the try into the touchdown's text)."""
    td = df[(df["touchdown"] == 1) & df["td_team"].notna()]
    if td.empty:
        return df
    pts = np.maximum(td["dh"], td["da"]).to_numpy()
    text = td["desc"].str.lower()
    two = text.str.contains(TWO_RE, regex=True).to_numpy() | (pts == 8)
    xp = ~two & (text.str.contains(XP_RE, regex=True).to_numpy() | (pts == 7))
    known = two | xp
    td = td[known]
    two, pts = two[known], pts[known]
    scorer = td["td_team"].to_numpy(object)
    home_sc = scorer == td["home_team"].to_numpy(object)
    h6 = np.where(home_sc, td["total_home_score"] - (pts - 6), td["total_home_score"])
    a6 = np.where(home_sc, td["total_away_score"], td["total_away_score"] - (pts - 6))
    other = np.where(home_sc, td["away_team"], td["home_team"])
    sc_to = np.where(scorer == td["posteam"], td["posteam_timeouts_remaining"], td["defteam_timeouts_remaining"])
    op_to = np.where(scorer == td["posteam"], td["defteam_timeouts_remaining"], td["posteam_timeouts_remaining"])
    kicker = td["desc"].str.extract(r"\(([^()]+?)\s+(?:kick|pat)", flags=re.I)[0]
    tr = td.copy()
    tr["row_key"] = td.index + 0.5
    tr = tr.assign(
        posteam=scorer, defteam=other, posteam_type=np.where(home_sc, "home", "away"),
        play_type=np.where(two, "pass", "extra_point"), down=np.nan, ydstogo=3.0, yardline_100=3.0,
        yards_gained=0.0, touchdown=0.0, td_team=None, return_touchdown=0.0, pass_touchdown=0.0, rush_touchdown=0.0,
        extra_point_attempt=(~two).astype(float), two_point_attempt=two.astype(float),
        extra_point_result=np.where(~two, np.where(pts == 7, "good", "failed"), None),
        two_point_conv_result=np.where(two, np.where(pts == 8, "success", "failure"), None),
        posteam_score=np.where(home_sc, h6, a6), defteam_score=np.where(home_sc, a6, h6),
        posteam_timeouts_remaining=sc_to, defteam_timeouts_remaining=op_to,
        kicker_player_id=np.where(~two & kicker.notna(), kicker.fillna("") + "|" + pd.Series(scorer, index=td.index).astype(str), None),
        kicker_player_name=np.where(~two, kicker, None), field_goal_attempt=0.0, punt_attempt=0.0, kickoff_attempt=0.0,
        interception=0.0, fumble_lost=0.0, safety=0.0, penalty=0.0, sack=0.0, incomplete_pass=0.0, complete_pass=0.0,
        qb_dropback=two.astype(float), qb_kneel=0.0, qb_spike=0.0, punt_blocked=0.0, kick_distance=np.nan,
        field_goal_result=None, timeout=0.0, timeout_team=None, desc=np.where(two, "two-point try", "extra point try"),
        epa=np.nan,
    )
    df = df.assign(row_key=df.index.astype(float))
    return pd.concat([df, tr]).sort_values("row_key", kind="stable").drop(columns="row_key").reset_index(drop=True)


# -------------------------------------------------------------------- enrich ---
def clock_quality(e: pd.DataFrame) -> pd.DataFrame:
    """Per game: the share of consecutive same-quarter run/pass snaps with no clock change, and negative gaps."""
    s = e[e["is_snap"]]
    # the same offense snapping again in the same quarter after a play that was no score: the clock must have moved
    rp = s["play_type"].isin(["run", "pass"]) & s["next_play_type"].isin(["run", "pass"]) & (s["next_qtr"] == s["qtr"]) \
        & (s["next_posteam"] == s["posteam"]) & (s["touchdown"] == 0) & (s["turnover"] == 0)
    pairs = s[rp]
    zero = pairs.groupby("game_id")["delta_t"].apply(lambda x: float((x == 0).mean()))
    same_half = s[s["next_game_seconds_remaining"].notna()]
    neg = same_half.groupby("game_id")["delta_t"].apply(lambda x: int((x < 0).sum()))
    q = pd.DataFrame({"zero_share": zero, "neg_gaps": neg}).fillna({"zero_share": 1.0, "neg_gaps": 0})
    q["clock_bad"] = (q["zero_share"] > K.CLOCK_ZERO_SHARE) | (q["neg_gaps"] > K.CLOCK_NEG_MAX)
    return q


OOB_YARDS = [-99, 0, 4, 9, 19, 99]     # gain buckets of the out-of-bounds rate table


def _oob_candidates(e: pd.DataFrame) -> np.ndarray:
    pt = e["play_type"].to_numpy(object)
    comp = (pt == "pass") & (e["complete_pass"].to_numpy() == 1) & (e["sack"].to_numpy() == 0)
    return ((pt == "run") | comp) & (e["touchdown"].to_numpy() == 0) & (e["turnover"].to_numpy() == 0) \
        & (e["penalty"].fillna(0).to_numpy() == 0) & e["is_snap"].to_numpy()


def oob_cells(e: pd.DataFrame) -> np.ndarray:
    """Rate-table cell of each play: kind (run / catch) x gain bucket x motive (trailing late, leading late, else)."""
    kind = (e["play_type"].to_numpy(object) == "pass").astype(int)
    yb = np.clip(np.searchsorted(OOB_YARDS, e["yards_gained"].fillna(0).to_numpy(), side="left") - 1, 0, len(OOB_YARDS) - 2)
    late = (e["half"].to_numpy() == 2) & (e["half_seconds_remaining"].to_numpy() <= 300)
    motive = np.where(late & (e["margin"].to_numpy() < 0), 1, np.where(late & (e["margin"].to_numpy() > 0), 2, 0))
    return (kind * (len(OOB_YARDS) - 1) + yb) * 3 + motive


N_CELLS = 2 * (len(OOB_YARDS) - 1) * 3


def oob_rates(cells: np.ndarray, explicit: np.ndarray, text: np.ndarray) -> np.ndarray:
    """Out-of-bounds rate per cell on the explicit plays, 20 pseudo-plays at the overall rate."""
    n = np.bincount(cells[explicit], minlength=N_CELLS).astype(float)
    k = np.bincount(cells[explicit], weights=text[explicit].astype(float), minlength=N_CELLS)
    base = k.sum() / n.sum() if n.sum() else 0.07
    return (k + 20 * base) / (n + 20)


def redraw_oob(e: pd.DataFrame, seed: int = 23) -> pd.DataFrame:
    """Draw the "drawn" plays again at the rates of every explicit game in the frame (seasons are enriched one at a
    time, and only 2025-26 feeds are explicit)."""
    ex = (e["oob_src"] == "text").to_numpy() & ~e["clock_bad"].to_numpy()
    cells = oob_cells(e)
    rate = oob_rates(cells, ex, e["oob_text"].fillna(False).to_numpy().astype(bool))
    drawn = (e["oob_src"] == "drawn").to_numpy()
    text = e["oob_text"].fillna(False).to_numpy().astype(bool)
    u = np.random.default_rng(seed).random(len(e))
    e.loc[drawn, "out_of_bounds"] = ((u < rate[cells]) | text)[drawn].astype(float)
    # inside 2:00 the clock tells, but not alone (on the explicit games a stopped clock was out of bounds a quarter of
    # the time: unrecorded timeouts, injuries, reviews): each play is drawn at the explicit games' rate given what
    # its clock did, by kind of play and motive
    gap = e["oob_gap"].to_numpy()
    stop = gap <= K.OOB_GAP
    km = (cells // 3 // (len(OOB_YARDS) - 1)) * 3 + cells % 3            # kind x motive
    inside = ex & (e["half_seconds_remaining"].to_numpy() <= 120) & (e["yards_gained"].to_numpy() < e["ydstogo"].to_numpy()) \
        & np.isfinite(gap) & (gap >= -K.OOB_GAP)
    clk = (e["oob_src"] == "clock").to_numpy()
    for flag in (True, False):
        m = inside & (stop == flag)
        n = np.bincount(km[m], minlength=6).astype(float)
        k = np.bincount(km[m], weights=text[m].astype(float), minlength=6)
        r = (k + 10 * (k.sum() / max(n.sum(), 1))) / (n + 10)
        sel = clk & (stop == flag)
        e.loc[sel, "out_of_bounds"] = ((u < r[km]) | text)[sel].astype(float)
    return e


def infer_oob(e: pd.DataFrame, seed: int = 23, rates=None) -> pd.DataFrame:
    """Out of bounds for every run and catch (design 3.3, as the data turned out).

    The data's clock rule: after a runner goes out, the clock stops until the snap only in the last 2:00 of a half
    (2025-26 plays the text calls out of bounds: median 0 s off the clock before the next snap inside 2:00, 26 s
    outside it against 29 s for plays in bounds; every season 2016-26: 1.5-3% of non-first-down plays outside 2:00
    stop the clock, 21-43% inside it). So:
      * explicit: a game whose feed writes the snap time and says "out of bounds" (most of 2026, a third of 2025):
        the text;
      * inside 2:00, a play short of the line to gain: the clock. The seconds past the play's own length
        (library._duration) before the next snap, with no timeout (a row, or one team's timeouts fewer at the
        next snap), the same quarter and offense: OOB_GAP or less is out of bounds, INB_GAP or more in bounds,
        between in bounds and flagged ambiguous; below -OOB_GAP the clock is wrong (not inferable). A gap that
        crosses 2:00 (the two-minute timeout, 2024 on) says nothing;
      * everything else (first downs inside 2:00 stop the clock anyway; outside 2:00 the clock never tells):
        drawn at the explicit games' rate for the play's cell (oob_cells), so the library's rates are right.
    Text that says so always wins."""
    cand = _oob_candidates(e)
    pt = e["play_type"].to_numpy(object)
    yd = e["yards_gained"].fillna(0).to_numpy()
    dur = L._duration(pt, yd, e["incomplete_pass"].fillna(0).to_numpy(), e["sack"].fillna(0).to_numpy(),
                      np.zeros(len(e), bool), e["turnover"].to_numpy())
    gap = e["delta_t"].to_numpy() - dur
    hs = e["half_seconds_remaining"].to_numpy()
    nxt_hs = hs - e["delta_t"].to_numpy()
    fd = yd >= e["ydstogo"].fillna(99).to_numpy()
    # a timeout the feed has no row for still shows: a team's timeouts are fewer at the next snap
    sn = e[e["is_snap"]]
    grp = sn.groupby(["game_id", "half"])
    to_drop = pd.Series(False, index=e.index)
    to_drop[sn.index] = ((grp["posteam_timeouts_remaining"].shift(-1) < sn["posteam_timeouts_remaining"])
                         | (grp["defteam_timeouts_remaining"].shift(-1) < sn["defteam_timeouts_remaining"])).to_numpy()
    measurable = cand & e["to_after_team"].isna().to_numpy() & ~to_drop.to_numpy() \
        & (e["next_qtr"].to_numpy() == e["qtr"].to_numpy()) \
        & (e["next_posteam"].to_numpy(object) == e["posteam"].to_numpy(object)) & np.isfinite(gap) \
        & ~((hs > 120) & (nxt_hs <= 120) & (e["season"].to_numpy() >= 2024)) & (gap >= -K.OOB_GAP)
    clock = measurable & (hs <= 120) & ~fd
    text = e["desc"].fillna("").str.contains(K.OOB_TEXT, case=False, regex=True).to_numpy() & cand
    stamped = e["desc"].fillna("").str.match(r"^\(\d{1,2}:\d{2}\)").to_numpy()
    share = pd.Series(stamped[cand]).groupby(e["game_id"].to_numpy()[cand]).mean()
    explicit = cand & (e["game_id"].map(share).fillna(0).to_numpy() >= 0.5)
    cells = oob_cells(e)
    rate = oob_rates(cells, explicit, text) if rates is None else rates
    drawn = np.random.default_rng(seed).random(len(e)) < rate[cells]
    oob = np.where(explicit, text, np.where(clock, gap <= K.OOB_GAP, drawn)) | text
    oob &= cand
    src = np.where(~cand, "", np.where(explicit, "text", np.where(clock, "clock", "drawn")))
    amb = clock & (gap > K.OOB_GAP) & (gap < K.INB_GAP) & ~text
    return pd.DataFrame({"oob": oob, "oob_ambiguous": amb, "oob_inferable": clock | explicit, "oob_src": src,
                         "oob_gap": np.where(cand, gap, np.nan), "oob_text": text}, index=e.index)


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """data.enrich (the NFL sequencing, unchanged) plus the college clock: clock_bad per game and inferred
    out-of-bounds in out_of_bounds (with oob_ambiguous / oob_inferable); fbs: both teams FBS."""
    e = D.enrich(df)
    q = clock_quality(e)
    e["clock_bad"] = e["game_id"].map(q["clock_bad"]).fillna(True).astype(bool)
    o = infer_oob(e)
    e["out_of_bounds"] = o["oob"].astype(float)
    for c in ("oob_ambiguous", "oob_inferable", "oob_gap", "oob_src", "oob_text"):
        e[c] = o[c]
    e["fbs"] = (e["home_div"] == "fbs") & (e["away_div"] == "fbs")
    # onside kicks the kicking team kept (nflverse own_kickoff_recovery): the next snap is the kicker's
    ko = (e["play_type"] == "kickoff").to_numpy()
    nxt = e[e["is_snap"]][["game_id", "row_order", "posteam"]].rename(columns={"posteam": "nxt_pos"})
    m = pd.merge_asof(e.loc[ko, ["game_id", "row_order", "defteam"]].sort_values("row_order"), nxt.sort_values("row_order"),
                      on="row_order", by="game_id", direction="forward")
    e.loc[m.set_index(e.index[ko][np.argsort(e.loc[ko, "row_order"].to_numpy(), kind="stable")]).index, "own_kickoff_recovery"] = \
        (m["nxt_pos"] == m["defteam"]).astype(float).to_numpy()
    return e


def load(seasons, cache: bool = True) -> pd.DataFrame:
    """Normalized and enriched college play-by-play for ``seasons`` (cached next to the pruned files)."""
    seasons = sorted(seasons)
    path = K.CACHE / f"enriched_v{VERSION}_{min(seasons)}_{max(seasons)}_{len(seasons)}.parquet"
    stamp = max((pruned_path(s_, y).stat().st_mtime for y in seasons for s_ in ("cfb", "espn") if pruned_path(s_, y).exists()),
                default=0)
    if cache and path.exists() and path.stat().st_mtime >= stamp:
        return redraw_oob(pd.read_parquet(path))
    for stale in K.CACHE.glob("enriched_*.parquet"):     # older versions, other season sets: rebuilt on demand
        if stale != path:
            stale.unlink()
    frames = []
    for y in seasons:     # one season at a time keeps memory down; games never cross seasons
        raw = load_pruned("cfb", [y])
        espn = load_pruned("espn", [y]) if y in K.ESPN_SEASONS else None
        frames.append(enrich(normalize(raw, espn)))
    e = pd.concat(frames, ignore_index=True)
    e["row_order"] = np.arange(len(e))
    if cache:
        e.to_parquet(path)
    return redraw_oob(e)


# -------------------------------------------------------------------- report ---
def clock_report(e: pd.DataFrame) -> dict:
    """What the clock filter and the out-of-bounds inference found (design 3.3 acceptance numbers)."""
    g = e.drop_duplicates("game_id")
    fbs = g[g["fbs"]]
    out = {"excluded_share_fbs": round(float(fbs["clock_bad"].mean()), 4),
           "excluded_share_fbs_by_season": {int(k): round(float(v), 3) for k, v in fbs.groupby("season")["clock_bad"].mean().items()},
           "games_fbs_by_season": {int(k): int(v) for k, v in fbs.groupby("season").size().items()},
           "excluded_share_all": round(float(g["clock_bad"].mean()), 4)}
    s = e[e["is_snap"] & ~e["clock_bad"]]
    lib = s[s["season"].isin(K.LIB_SEASONS) & s["fbs"]]
    c = lib[_oob_candidates(lib)]
    late = (c["half"] == 2) & (c["half_seconds_remaining"] <= 300)
    rate = lambda m: round(float(c.loc[m, "out_of_bounds"].mean()), 4)
    ex = c["oob_src"] == "text"
    clk = c["oob_src"] == "clock"
    t, k = c["oob_text"].astype(bool), c["out_of_bounds"].astype(bool)
    # the clock rule checked on the explicit games: what the clock alone says inside 2:00 against the text
    exc = ex & (c["half_seconds_remaining"] <= 120) & (c["yards_gained"] < c["ydstogo"]) & c["oob_gap"].between(-3, 1e9)
    by_clock = c["oob_gap"] <= K.OOB_GAP
    out["oob"] = {"runs_completions": int(len(c)), "rate": rate(c.index == c.index),
                  "rate_run": rate(c["play_type"] == "run"), "rate_completion": rate(c["play_type"] == "pass"),
                  "rate_trailing_late": rate(late & (c["margin"] < 0)), "rate_leading_late": rate(late & (c["margin"] > 0)),
                  "source_share": {k_: round(float(v), 4) for k_, v in c["oob_src"].value_counts(normalize=True).items()},
                  "explicit_rate": round(float(t[ex].mean()), 4),
                  "explicit_rate_trailing_late": round(float(t[ex & late & (c["margin"] < 0)].mean()), 4),
                  "clock_inferred_rate_inside_2min": round(float(k[clk].mean()), 4),
                  "ambiguous_share_inside_2min": round(float(c.loc[clk, "oob_ambiguous"].mean()), 4),
                  "clock_vs_text_inside_2min": {
                      "n": int(exc.sum()),
                      "precision": round(float((by_clock & t)[exc].sum() / max(by_clock[exc].sum(), 1)), 3),
                      "recall": round(float((by_clock & t)[exc].sum() / max(t[exc].sum(), 1)), 3)},
                  "runoff_after_text_oob": oob_window(e)}
    # after an incompletion the clock is stopped until the next snap: the gap is the next play's own length
    inc = s[(s["play_type"] == "pass") & (s["incomplete_pass"] == 1) & s["next_play_type"].isin(["run", "pass"])
            & (s["next_posteam"] == s["posteam"]) & s["to_after_team"].isna() & (s["next_qtr"] == s["qtr"]) & s["fbs"]]
    gap = inc["delta_t"] - 5.0      # the incompletion's own modelled length (library._duration)
    out["incompletion_gap"] = {"n": int(len(inc)), "median_delta_t": float(inc["delta_t"].median()),
                               "share_delta_4_7": round(float(inc["delta_t"].between(4, 7).mean()), 4),
                               "median_runoff": float(gap.median())}
    out["fd_restart_credit"] = fd_restart_credit(e)
    return out


def fd_restart_credit(e: pd.DataFrame) -> dict:
    """Seconds the 2023 first-down stop inside 2:00 keeps off the clock: the hurry-up runoff after an in-bounds
    non-first down minus the runoff after an in-bounds first down (both inside 2:00, the offense trailing late or
    any score before the half), 2023 on."""
    s = e[e["is_snap"] & ~e["clock_bad"] & e["season"].isin(K.LIB_SEASONS) & e["fbs"]]
    ok = (s["play_type"].isin(["run", "pass"]) & (s["incomplete_pass"] == 0) & (s["out_of_bounds"] == 0)
          & (s["penalty"].fillna(0) == 0) & (s["turnover"] == 0) & (s["touchdown"] == 0) & s["to_after_team"].isna()
          & (s["next_posteam"] == s["posteam"]) & (s["next_qtr"] == s["qtr"]) & s["next_play_type"].isin(["run", "pass"])
          & (s["half_seconds_remaining"] <= 120) & ((s["qtr"] == 2) | (s["margin"] < 0)))
    x = s[ok]
    runoff = x["delta_t"] - L._duration(x["play_type"].to_numpy(), x["yards_gained"].fillna(0).to_numpy(),
                                        np.zeros(len(x)), x["sack"].fillna(0).to_numpy(), np.zeros(len(x), bool),
                                        np.zeros(len(x)))
    fd = (x["yards_gained"] >= x["ydstogo"]).to_numpy()
    a, b = runoff[~fd & (runoff >= 0)], runoff[fd & (runoff >= 0)]
    return {"credit": round(float(a.median() - b.median()), 2), "median_runoff_no_fd": float(a.median()),
            "median_runoff_fd": float(b.median()), "n_no_fd": int(len(a)), "n_fd": int(len(b))}


def oob_window(e: pd.DataFrame) -> dict:
    """Median seconds off the clock between the whistle and the next snap after a play the text calls out of bounds,
    and after one in bounds, inside and outside the last 2:00 of a half (explicit games, short of the line to gain):
    the rule the data plays by, and the out-of-bounds restart credit outside the window."""
    s = e[e["is_snap"] & ~e["clock_bad"] & (e["oob_src"] == "text") & e["oob_gap"].notna() & (e["oob_gap"] >= -3)
          & (e["yards_gained"] < e["ydstogo"]) & e["to_after_team"].isna() & (e["next_posteam"] == e["posteam"])
          & (e["next_qtr"] == e["qtr"])]
    inside = s["half_seconds_remaining"] <= 120
    t = s["oob_text"].astype(bool)
    med = lambda m: float(s.loc[m, "oob_gap"].median()) if m.any() else None
    out = {"oob_inside_2min": med(t & inside), "inbounds_inside_2min": med(~t & inside),
           "oob_outside_2min": med(t & ~inside), "inbounds_outside_2min": med(~t & ~inside),
           "n_oob": int(t.sum()), "stopped_share_oob_inside": round(float((s.loc[t & inside, "oob_gap"] <= 3).mean()), 3),
           "stopped_share_oob_outside": round(float((s.loc[t & ~inside, "oob_gap"] <= 3).mean()), 3)}
    if out["inbounds_outside_2min"] is not None and out["oob_outside_2min"] is not None:
        out["oob_restart_credit"] = round(out["inbounds_outside_2min"] - out["oob_outside_2min"], 2)
    return out


def teams(e: pd.DataFrame | None = None) -> pd.DataFrame:
    """school -> abbreviation, mascot (cfbfastR-data teams file; ESPN's abbreviations where it has the game). Codes
    are unique: a clash keeps the code for the school with more games and gives the other its name."""
    path = K.CACHE / "teams.csv"
    if not path.exists():
        K.CACHE.mkdir(parents=True, exist_ok=True)
        _fetch(K.TEAMS_URL, path)
    t = pd.read_csv(path, encoding="latin-1")[["school", "mascot", "abbreviation"]].dropna(subset=["school"])
    t = t.drop_duplicates("school").set_index("school")
    if e is not None:
        n = pd.concat([e["home_team"], e["away_team"]]).value_counts()
        t = t.reindex(t.index.union(n.index))
        t["games"] = n.reindex(t.index).fillna(0)
        t["abbreviation"] = t["abbreviation"].fillna(pd.Series(t.index, index=t.index).str.upper().str.replace(r"[^A-Z]", "", regex=True).str[:6])
        t = t.sort_values("games", ascending=False)
        dup = t["abbreviation"].duplicated()
        t.loc[dup, "abbreviation"] = [s.upper().replace(" ", "")[:8] for s in t.index[dup]]
        dup = t["abbreviation"].duplicated()
        t.loc[dup, "abbreviation"] = [f"{a}{i}" for i, a in enumerate(t.loc[dup, "abbreviation"])]
    return t
