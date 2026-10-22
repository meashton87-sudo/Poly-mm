"""Download, load and enrich nflverse play-by-play data.

The enrichment step links every snap to the next snap of the same half so the
clock model can measure how much game clock elapsed between them, whether the
clock was stopped, and whether a timeout was called in between.
"""
from __future__ import annotations

import re
import urllib.request
from functools import lru_cache

import numpy as np
import pandas as pd

from . import config

PBP_COLUMNS = [
    "play_id", "game_id", "season", "season_type", "week", "game_date",
    "home_team", "away_team", "posteam", "defteam", "posteam_type",
    "yardline_100", "quarter_seconds_remaining", "half_seconds_remaining",
    "game_seconds_remaining", "game_half", "qtr", "down", "ydstogo", "goal_to_go",
    "desc", "time", "play_type", "yards_gained", "shotgun", "no_huddle", "qb_dropback",
    "qb_kneel", "qb_spike", "qb_scramble", "air_yards", "pass_length", "pass_location",
    "field_goal_result", "kick_distance", "extra_point_result", "two_point_conv_result",
    "home_timeouts_remaining", "away_timeouts_remaining", "timeout", "timeout_team",
    "td_team", "posteam_timeouts_remaining", "defteam_timeouts_remaining",
    "total_home_score", "total_away_score", "posteam_score", "defteam_score",
    "score_differential", "posteam_score_post", "defteam_score_post",
    "ep", "epa", "wp", "vegas_wp", "punt_blocked", "first_down_penalty",
    "incomplete_pass", "touchback", "interception", "fumble", "fumble_lost", "safety",
    "penalty", "penalty_yards", "penalty_team", "penalty_type", "sack",
    "touchdown", "return_touchdown", "pass_touchdown", "rush_touchdown",
    "complete_pass", "pass", "rush", "out_of_bounds", "return_yards",
    "kicker_player_id", "kicker_player_name", "punter_player_id", "punter_player_name",
    "own_kickoff_recovery", "kickoff_attempt", "punt_attempt", "field_goal_attempt",
    "extra_point_attempt", "two_point_attempt", "roof", "surface", "temp", "wind",
    "home_coach", "away_coach", "spread_line", "total_line", "result",
    "home_score", "away_score", "success", "xpass", "pass_oe", "cpoe",
    "fixed_drive", "fixed_drive_result", "aborted_play", "home_opening_kickoff", "first_down",
]

SNAP_TYPES = {"run", "pass", "punt", "field_goal", "qb_kneel", "qb_spike", "no_play"}


def download(seasons=None, force: bool = False) -> None:
    """Fetch nflverse play-by-play parquet files into ``data/raw``."""
    seasons = seasons or sorted(set(config.MODEL_SEASONS) | set(config.ANALYSIS_SEASONS))
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    for season in seasons:
        dest = config.RAW_DIR / f"play_by_play_{season}.parquet"
        if dest.exists() and not force:
            continue
        print(f"downloading {season} play-by-play ...")
        urllib.request.urlretrieve(config.NFLVERSE_PBP_URL.format(season=season), dest)
    games = config.RAW_DIR / "games.csv"
    if force or not games.exists():
        urllib.request.urlretrieve(config.NFLVERSE_GAMES_URL, games)


def load_raw(seasons) -> pd.DataFrame:
    frames = []
    for season in seasons:
        path = config.RAW_DIR / f"play_by_play_{season}.parquet"
        if not path.exists():
            download([season])
        df = pd.read_parquet(path)
        cols = [c for c in PBP_COLUMNS if c in df.columns]
        df = df[cols].copy()
        df["row_order"] = np.arange(len(df))
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    return df


_TO_TIME = re.compile(r"at (\d{1,2}):(\d{2})")


def _clock_window(half: np.ndarray, half_secs: np.ndarray) -> np.ndarray:
    """True where an out-of-bounds play stops the clock until the next snap."""
    return np.where(half == 1, half_secs <= config.OOB_STOP_WINDOW_H1,
                    half_secs <= config.OOB_STOP_WINDOW_H2)


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Add sequencing / clock columns. Returns all rows (snaps flagged)."""
    df = df.sort_values(["game_id", "row_order"]).reset_index(drop=True)
    df["half"] = np.where(df["qtr"] <= 2, 1, np.where(df["qtr"] <= 4, 2, 3))
    is_to = df["timeout"].fillna(0).eq(1) & df["posteam"].isna()
    df["is_timeout_row"] = is_to
    untimed = df["two_point_attempt"].fillna(0).eq(1) | df["extra_point_attempt"].fillna(0).eq(1)
    df["is_snap"] = (
        df["play_type"].isin(SNAP_TYPES)
        & ~is_to
        & ~untimed
        & df["posteam"].notna()
        & ~df["desc"].fillna("").str.contains("Two-Minute Warning|END QUARTER|END GAME", regex=True)
    )
    # no_play rows that are not penalties (e.g. replay-reversed placeholders) are not snaps
    df.loc[(df["play_type"] == "no_play") & df["penalty"].fillna(0).eq(0), "is_snap"] = False

    # Timeout rows: time at which they were called.
    df["to_secs_in_qtr"] = np.nan
    m = df["desc"].fillna("").str.extract(_TO_TIME)
    df.loc[is_to, "to_secs_in_qtr"] = (m[0].astype(float) * 60 + m[1].astype(float))[is_to]

    snaps = df[df["is_snap"]].copy()
    grp = snaps.groupby(["game_id", "half"], sort=False)
    for col in ["game_seconds_remaining", "posteam", "yardline_100", "down", "row_order", "qtr", "play_type"]:
        snaps[f"next_{col}"] = grp[col].shift(-1)
    snaps["prev_row_order"] = grp["row_order"].shift(1)
    df = df.merge(
        snaps[[c for c in snaps.columns if c.startswith("next_")] + ["prev_row_order", "game_id", "row_order"]],
        on=["game_id", "row_order"], how="left",
    )

    # Timeouts between consecutive snaps: attach the first one to the snap before it.
    to_rows = df[is_to][["game_id", "row_order", "timeout_team", "game_seconds_remaining", "half"]]
    snap_idx = df[df["is_snap"]][["game_id", "row_order", "half"]].rename(columns={"row_order": "snap_row"})
    to_rows = to_rows.sort_values(["game_id", "row_order"])
    snap_idx = snap_idx.sort_values(["snap_row"])
    attached = pd.merge_asof(
        to_rows.sort_values("row_order"), snap_idx.sort_values("snap_row"),
        left_on="row_order", right_on="snap_row", by=["game_id", "half"], direction="backward",
    ).dropna(subset=["snap_row"])
    attached = attached.sort_values(["game_id", "row_order"]).drop_duplicates(["game_id", "snap_row"], keep="first")
    attached = attached.drop(columns=["row_order"]).rename(columns={
        "timeout_team": "to_after_team", "game_seconds_remaining": "to_after_t", "snap_row": "row_order",
    })[["game_id", "row_order", "to_after_team", "to_after_t"]]
    df = df.merge(attached, on=["game_id", "row_order"], how="left")

    # Score / possession context in a common frame.
    df["margin"] = df["posteam_score"] - df["defteam_score"]  # offense perspective
    df["in_oob_window"] = _clock_window(df["half"].to_numpy(), df["half_seconds_remaining"].fillna(0).to_numpy())
    df["is_home_off"] = (df["posteam"] == df["home_team"]).astype(float)
    df["off_spread"] = np.where(df["posteam"] == df["home_team"], df["spread_line"], -df["spread_line"])
    df["off_coach"] = np.where(df["posteam"] == df["home_team"], df["home_coach"], df["away_coach"])
    df["def_coach"] = np.where(df["posteam"] == df["home_team"], df["away_coach"], df["home_coach"])
    df["delta_t"] = df["game_seconds_remaining"] - df["next_game_seconds_remaining"]
    df["turnover"] = (df["interception"].fillna(0) + df["fumble_lost"].fillna(0)).clip(0, 1)
    return df


@lru_cache(maxsize=4)
def load(seasons: tuple) -> pd.DataFrame:
    """Load and enrich (cached on disk as parquet)."""
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = f"pbp_{min(seasons)}_{max(seasons)}_{len(seasons)}.parquet"
    path = config.CACHE_DIR / key
    if path.exists():
        return pd.read_parquet(path)
    df = enrich(load_raw(seasons))
    df.to_parquet(path)
    return df


def load_games() -> pd.DataFrame:
    path = config.RAW_DIR / "games.csv"
    if not path.exists():
        download([])
    return pd.read_csv(path)
