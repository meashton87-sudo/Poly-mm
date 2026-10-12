"""Fit, persist and load every model the simulator needs (the "bundle")."""
from __future__ import annotations

import pickle
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config, data, library, ratings
from .wp import WPModel, training_frame


@dataclass
class Bundle:
    wp: WPModel
    fg_model: object
    lib: library.PlayLibrary
    punts: dict            # arrays: yl, net, ret_td, blocked, duration
    kickoffs: dict         # arrays: start_yl, duration, ret_td
    tempo: dict            # mode -> array of between-snap runoff seconds
    team_ratings: pd.DataFrame
    kicker_ratings: pd.DataFrame
    punter_ratings: pd.DataFrame
    consts: dict = field(default_factory=dict)

    def save(self, path=None):
        path = path or config.ARTIFACT_DIR / "bundle.pkl"
        path.parent.mkdir(parents=True, exist_ok=True)
        wp_str = self.wp.booster.model_to_string()
        state = dict(self.__dict__)
        state["wp"] = wp_str
        with open(path, "wb") as f:
            pickle.dump(state, f)

    @classmethod
    def load(cls, path=None) -> "Bundle":
        import lightgbm as lgb
        path = path or config.ARTIFACT_DIR / "bundle.pkl"
        with open(path, "rb") as f:
            state = pickle.load(f)
        state["wp"] = WPModel(lgb.Booster(model_str=state["wp"]))
        return cls(**state)


def _tempo_samples(pbp: pd.DataFrame) -> dict:
    """Between-snap runoff (seconds after the whistle) when the clock keeps running."""
    s = pbp[pbp["is_snap"] & pbp["season"].isin(config.LIBRARY_SEASONS)].copy()
    ok = ((s["qtr"] == s["next_qtr"]) & s["to_after_team"].isna() & (s["next_posteam"] == s["posteam"])
          & s["delta_t"].between(0, 80) & s["play_type"].isin(["run", "pass"])
          & (s["incomplete_pass"] == 0) & (s["out_of_bounds"] == 0) & (s["penalty"].fillna(0) == 0)
          & (s["turnover"] == 0) & (s["touchdown"] == 0))
    hs = s["half_seconds_remaining"]
    ok &= ~((hs > 120) & (hs - s["delta_t"] <= 120))
    yd = s["yards_gained"].clip(lower=0)
    s["runoff"] = s["delta_t"] - np.where(s["play_type"] == "run", 5 + 0.12 * yd, 5 + 0.08 * yd)
    late = (((s["qtr"] == 4) & (s["quarter_seconds_remaining"] <= 300))
            | ((s["qtr"] == 2) & (s["quarter_seconds_remaining"] <= 120)))
    x = s[ok]
    late = late[ok]
    nxt = x["next_play_type"]
    hurry = x[late & (x["margin"] < 0) & nxt.isin(["run", "pass"])]["runoff"]
    milk = x[(x["qtr"] == 4) & (x["quarter_seconds_remaining"] <= 360) & (x["margin"] > 0)
             & nxt.isin(["run", "pass", "qb_kneel", "punt", "field_goal"])]["runoff"]
    normal = x[~late & (x["qtr"] != 4) & nxt.isin(["run", "pass"])]["runoff"]
    spike = x[nxt == "qb_spike"]["runoff"]
    urgent = x[nxt.isin(["run", "pass"]) & (
        ((x["qtr"] == 2) & (x["quarter_seconds_remaining"] <= 60))
        | ((x["qtr"] == 4) & (x["quarter_seconds_remaining"] <= 120) & (x["margin"] < 0)))]["runoff"]
    clip = lambda a: np.clip(a.to_numpy(), 1.0, 40.0)
    return {"hurry": clip(hurry), "urgent": clip(urgent), "normal": clip(normal), "milk": clip(milk),
            "spike": clip(spike)}


def _punt_samples(pbp: pd.DataFrame) -> dict:
    pu = ratings.punt_table(pbp[pbp["season"].isin(config.LIBRARY_SEASONS)])
    dur = pu["delta_t"].where(pu["delta_t"].between(3, 20), 9.0)
    return {
        "yl": pu["yardline_100"].to_numpy(float),
        "net": pu["net"].to_numpy(float),
        "ret_td": (pu["return_touchdown"].fillna(0) == 1).to_numpy(),
        "blocked": (pu["punt_blocked"].fillna(0) == 1).to_numpy(),
        "touchback": (pu["touchback"].fillna(0) == 1).to_numpy(),
        "duration": dur.to_numpy(float),
    }


def _kickoff_samples(pbp: pd.DataFrame) -> dict:
    ko = pbp[(pbp["play_type"] == "kickoff") & pbp["season"].isin(config.KICKOFF_SEASONS)].copy()
    ko = ko[~ko["desc"].str.contains("onside", case=False, na=False)]
    nxt = pbp[pbp["is_snap"] & pbp["season"].isin(config.KICKOFF_SEASONS)][
        ["game_id", "row_order", "yardline_100", "game_seconds_remaining"]]
    m = pd.merge_asof(
        ko.sort_values("row_order")[["game_id", "row_order", "game_seconds_remaining", "return_touchdown"]],
        nxt.sort_values("row_order"), on="row_order", by="game_id", direction="forward", suffixes=("", "_n"))
    m = m.dropna(subset=["yardline_100"])
    dur = (m["game_seconds_remaining"] - m["game_seconds_remaining_n"]).clip(0, 12)
    ret_td = (m["return_touchdown"].fillna(0) == 1).to_numpy()
    return {"start_yl": m["yardline_100"].clip(1, 99).to_numpy(float), "duration": dur.to_numpy(float),
            "ret_td": ret_td}


def _consts(pbp: pd.DataFrame) -> dict:
    p = pbp[pbp["season"].isin(config.ANALYSIS_SEASONS)]
    xp = (p.loc[p["extra_point_attempt"] == 1, "extra_point_result"] == "good").mean()
    two = (p.loc[p["two_point_attempt"] == 1, "two_point_conv_result"] == "success").mean()
    ko = p[(p["play_type"] == "kickoff") & p["desc"].str.contains("onside", case=False, na=False)]
    onside = ko["own_kickoff_recovery"].fillna(0).mean()
    return {"xp": float(xp), "two_pt": float(two), "onside": float(onside),
            "kneel_duration": 1.5, "spike_duration": 1.0, "timeout_reaction": 1.0,
            "oob_restart_credit": 4.0, "penalty_restart_credit": 20.0}


def build(seasons=None, verbose: bool = True) -> Bundle:
    seasons = seasons or tuple(sorted(set(config.MODEL_SEASONS) | set(config.ANALYSIS_SEASONS) | {2026}))
    pbp = data.load(tuple(seasons))
    model_pbp = pbp[pbp["season"].isin(config.MODEL_SEASONS)]
    log = print if verbose else (lambda *a, **k: None)
    log("fitting win-probability model ...")
    wp = WPModel().fit(training_frame(model_pbp))
    log("fitting field-goal model ...")
    fg = ratings.fit_fg_model(model_pbp)
    target = sorted(set(config.ANALYSIS_SEASONS) | {max(seasons)})
    log("as-of team ratings ...")
    tr = ratings.team_ratings(pbp[pbp["season"] >= min(target) - 2], target)
    log("kicker / punter ratings ...")
    kr = ratings.kicker_ratings(pbp, fg, target)
    pr = ratings.punter_ratings(pbp, target)
    log("play library ...")
    lib = library.PlayLibrary(library.build_library(pbp))
    bundle = Bundle(wp=wp, fg_model=fg, lib=lib, punts=_punt_samples(pbp), kickoffs=_kickoff_samples(pbp),
                    tempo=_tempo_samples(pbp), team_ratings=tr, kicker_ratings=kr, punter_ratings=pr,
                    consts=_consts(pbp))
    return bundle
