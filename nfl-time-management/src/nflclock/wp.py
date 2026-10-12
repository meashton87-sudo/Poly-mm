"""Win-probability model (LightGBM with monotone constraints).

Used (a) as the value function at halftime / truncation points of the game
simulator, and (b) inside simulator rollouts for fourth-down policy. All
features are from the offense's perspective.
"""
from __future__ import annotations

import pickle

import lightgbm as lgb
import numpy as np
import pandas as pd

from . import config

FEATURES = [
    "margin", "t", "half_t", "half", "diff_time_ratio", "spread_time", "is_home",
    "down", "ydstogo", "yardline_100", "off_to", "def_to", "receive_2h",
]
MONOTONE = {
    "margin": 1, "diff_time_ratio": 1, "spread_time": 1, "yardline_100": -1,
    "off_to": 1, "def_to": -1, "ydstogo": -1,
}
PARAMS = dict(
    objective="binary", learning_rate=0.03, num_leaves=31, min_data_in_leaf=1000,
    feature_fraction=0.9, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
    verbose=-1, num_threads=4,
)
N_ROUNDS = 400


def make_features(margin, t, down, ydstogo, yardline_100, off_to, def_to, off_spread,
                  is_home, receive_2h) -> np.ndarray:
    """Vectorised feature builder shared by training and simulation."""
    margin = np.asarray(margin, float)
    t = np.asarray(t, float)
    half = np.where(t > config.HALF_SECONDS, 1.0, 2.0)
    half_t = np.where(half == 1, t - config.HALF_SECONDS, t)
    elapsed = (3600.0 - t) / 3600.0
    dtr = margin / np.exp(-4.0 * elapsed)
    spread_time = np.asarray(off_spread, float) * np.exp(-4.0 * elapsed)
    r2h = np.where(half == 1, np.asarray(receive_2h, float), 0.0)
    cols = [margin, t, half_t, half, dtr, spread_time, np.asarray(is_home, float),
            np.asarray(down, float), np.asarray(ydstogo, float), np.asarray(yardline_100, float),
            np.asarray(off_to, float), np.asarray(def_to, float), r2h]
    n = max(np.size(c) for c in cols)
    return np.column_stack([np.broadcast_to(c, (n,)) for c in cols])


def training_frame(pbp: pd.DataFrame) -> pd.DataFrame:
    s = pbp[pbp["is_snap"] & pbp["down"].notna() & (pbp["qtr"] <= 4) & pbp["result"].notna()
            & pbp["posteam_timeouts_remaining"].notna()].copy()
    home_off = s["posteam"] == s["home_team"]
    s["receive_2h"] = np.where(home_off, s["home_opening_kickoff"] == 0, s["home_opening_kickoff"] == 1).astype(float)
    res = np.where(home_off, s["result"], -s["result"])
    s["y"] = np.where(res > 0, 1.0, np.where(res < 0, 0.0, 0.5))
    s["off_spread"] = s["off_spread"].fillna(0.0)
    return s


def frame_features(s: pd.DataFrame) -> np.ndarray:
    return make_features(
        s["margin"], s["game_seconds_remaining"], s["down"], s["ydstogo"], s["yardline_100"],
        s["posteam_timeouts_remaining"], s["defteam_timeouts_remaining"], s["off_spread"],
        s["is_home_off"], s["receive_2h"],
    )


def _expand_ties(X, y):
    tie = y == 0.5
    X2 = np.vstack([X[~tie], X[tie], X[tie]])
    y2 = np.concatenate([y[~tie], np.ones(tie.sum()), np.zeros(tie.sum())])
    w2 = np.concatenate([np.ones((~tie).sum()), np.full(tie.sum(), 0.5), np.full(tie.sum(), 0.5)])
    return X2, y2, w2


class WPModel:
    def __init__(self, booster: lgb.Booster | None = None):
        self.booster = booster

    def fit(self, frame: pd.DataFrame, rounds: int = N_ROUNDS) -> "WPModel":
        X = frame_features(frame)
        X, y, w = _expand_ties(X, frame["y"].to_numpy())
        params = dict(PARAMS)
        params["monotone_constraints"] = [MONOTONE.get(f, 0) for f in FEATURES]
        ds = lgb.Dataset(X, y, weight=w, feature_name=FEATURES, free_raw_data=True)
        self.booster = lgb.train(params, ds, num_boost_round=rounds)
        return self

    def predict_X(self, X: np.ndarray) -> np.ndarray:
        if len(X) == 0:
            return np.zeros(0)
        return self.booster.predict(X, num_threads=1)

    def predict(self, **kw) -> np.ndarray:
        return self.predict_X(make_features(**kw))

    def save(self, path):
        with open(path, "wb") as f:
            pickle.dump(self.booster.model_to_string(), f)

    @classmethod
    def load(cls, path) -> "WPModel":
        with open(path, "rb") as f:
            return cls(lgb.Booster(model_str=pickle.load(f)))


def evaluate(pred, y) -> dict:
    pred = np.clip(pred, 1e-6, 1 - 1e-6)
    ll = -np.mean(y * np.log(pred) + (1 - y) * np.log(1 - pred))
    brier = np.mean((pred - y) ** 2)
    bins = np.clip((pred * 10).astype(int), 0, 9)
    cal = pd.DataFrame({"bin": bins, "p": pred, "y": y}).groupby("bin").agg(p=("p", "mean"), y=("y", "mean"), n=("y", "size"))
    ece = float((cal["n"] * (cal["p"] - cal["y"]).abs()).sum() / cal["n"].sum())
    return {"logloss": float(ll), "brier": float(brier), "ece": ece, "n": int(len(y))}
