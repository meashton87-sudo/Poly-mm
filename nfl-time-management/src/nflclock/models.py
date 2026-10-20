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
    punts: dict            # arrays: yl, net, ret_td, blocked, touchback, duration, how, land
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
    nh = pbp[["game_id", "row_order", "no_huddle"]].rename(
        columns={"row_order": "next_row_order", "no_huddle": "next_no_huddle"})
    s = s.merge(nh, on=["game_id", "next_row_order"], how="left")
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
    no_huddle = x["next_no_huddle"] == 1   # a real hurry-up: the next snap came without a huddle
    hurry = x[late & (x["margin"] < 0) & nxt.isin(["run", "pass"]) & no_huddle]["runoff"]
    milk = x[(x["qtr"] == 4) & (x["quarter_seconds_remaining"] <= 360) & (x["margin"] > 0)
             & nxt.isin(["run", "pass", "qb_kneel", "punt", "field_goal"])]["runoff"]
    normal = x[~late & (x["qtr"] != 4) & nxt.isin(["run", "pass"])]["runoff"]
    spike = x[nxt == "qb_spike"]["runoff"]
    urgent = x[nxt.isin(["run", "pass"]) & no_huddle & (
        ((x["qtr"] == 2) & (x["quarter_seconds_remaining"] <= 60))
        | ((x["qtr"] == 4) & (x["quarter_seconds_remaining"] <= 120) & (x["margin"] < 0)))]["runoff"]
    clip = lambda a: np.clip(a.to_numpy(), 1.0, 40.0)
    return {"hurry": clip(hurry), "urgent": clip(urgent), "normal": clip(normal), "milk": clip(milk),
            "spike": clip(spike)}


# how a punt ended (the daily game's field and its return team's end-zone choice, engine.js _punt; the simulators
# draw the outcome alone). 2020-25, the 11,767 punts not blocked, touchbacks or return touchdowns: returned 43%, fair
# catch 31%, downed 13%, out of bounds 11%, muffed 1.5%. Of the 661 ending inside the 5 the coverage downed 67% there,
# 16% went out of bounds, 8% were fair caught and 8% returned: a punt that ends at the 3 was mostly downed there, not
# caught in the end zone and run back
PUNT_HOW = ["returned", "fair_catch", "downed", "out_of_bounds", "touchback", "muffed"]


def punt_how(pu: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """How each punt ended (PUNT_HOW index, from the play's description) and where the ball came down or was fielded:
    the receiving team's yards from its own goal line, 0 or less in the end zone (nflverse's kick distance: to where
    it was fielded, downed or went out; a touchback to the goal line). Of the 945 real punts that reached the end zone
    (2020-25), 939 were touchbacks; 4 were run out (ending at the 9.6 on average) and 2 muffed."""
    d = pu["desc"].fillna("")
    ret = pu["return_yards"].fillna(0).to_numpy() != 0
    how = np.select([pu["touchback"].fillna(0).eq(1).to_numpy(), d.str.contains("MUFFS").to_numpy(),
                     d.str.contains("fair catch", case=False).to_numpy(), d.str.contains("downed", case=False).to_numpy(),
                     d.str.contains("out of bounds", case=False).to_numpy() & ~ret], [4, 5, 1, 2, 3], 0)
    end = pu["yardline_100"].to_numpy(float) - pu["net"].to_numpy(float)
    land = np.where(pu["kick_distance"].notna(), pu["yardline_100"] - pu["kick_distance"], end)
    return how.astype(np.uint8), np.clip(land, -10, 99)


def _punt_samples(pbp: pd.DataFrame) -> dict:
    lib = pbp[pbp["season"].isin(config.LIBRARY_SEASONS)]
    pu = ratings.punt_table(lib)
    # the touchdowns: punt_table takes the spot from the next possession, and after a return touchdown the punting team
    # has the ball next, so it dropped 58 of the 63 return touchdowns of 2020-25 (0.03% of punts left, the real rate is
    # 0.49%). Every punt the receiving team scored on is put back, its net to the punting team's goal line (an
    # engine draws a touchdown, never its spot); the 3 the punting team scored (a muff recovered in the end zone, a
    # fumble on the return) are left out: neither engine scores a touchdown for the kicking team.
    p = lib[(lib["play_type"] == "punt") & lib["punter_player_id"].notna()]
    td = p["touchdown"].fillna(0).eq(1)
    recv, kick = td & (p["td_team"] == p["defteam"]), td & (p["td_team"] == p["posteam"])
    pu = pu[~pu.index.isin(p.index[kick])]
    pu = pd.concat([pu, p[recv & ~p.index.isin(pu.index)]]).sort_index()
    ret_td = pu.index.isin(p.index[recv])
    pu["net"] = np.where(ret_td, pu["yardline_100"] - 100, pu["net"])
    dur = pu["delta_t"].where(pu["delta_t"].between(3, 20), 9.0)
    how, land = punt_how(pu)
    how = np.where(ret_td, 0, how).astype(np.uint8)
    return {
        "yl": pu["yardline_100"].to_numpy(float),
        "net": pu["net"].to_numpy(float),
        "ret_td": ret_td,
        "blocked": (pu["punt_blocked"].fillna(0) == 1).to_numpy(),
        "touchback": (pu["touchback"].fillna(0) == 1).to_numpy(),
        "duration": dur.to_numpy(float),
        "how": how, "land": land,
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
