"""As-of team, kicker and punter ratings (no look-ahead).

Team ratings are opponent-adjusted EPA/play from a weighted ridge regression
(offense + defense + home-field), fitted separately for dropbacks and designed
runs. Every rating for (season, week) uses only games played *before* that week,
with exponential time decay and an extra discount across the off-season, so a
decision made in Week 10 is judged with what a staff could have known in Week 10.

Kicker ratings are empirical-Bayes logit shifts on a field-goal make model;
punter ratings are shrunken net-yards-over-expected.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

HALF_LIFE_SLATES = 12.0
OFFSEASON_GAP_SLATES = 8.0
# Ridge penalties in "plays" (noise variance / prior variance of team effects).
RIDGE = {
    "pass": {"off": 160.0, "def": 300.0},
    "rush": {"off": 300.0, "def": 420.0},
}
# Prior strengths from method-of-moments on 2016-25 careers (>= 60 FGs / 100 punts):
# true kicker skill SD ~0.19 logits; true punter skill SD ~1.0 net yard (per-punt SD ~9.5).
KICKER_PRIOR_PRECISION = 28.0
PUNTER_PRIOR_PUNTS = 95.0


def slate_index(df: pd.DataFrame) -> pd.Series:
    """Global ordinal for (season, week) with an off-season gap between seasons."""
    keys = df[["season", "week"]].drop_duplicates().sort_values(["season", "week"])
    keys["slate"] = np.arange(len(keys), dtype=float)
    keys["slate"] += (keys["season"] - keys["season"].min()) * OFFSEASON_GAP_SLATES
    return df.merge(keys, on=["season", "week"], how="left")["slate"].to_numpy()


def _target_slates(pbp: pd.DataFrame, target_seasons, current: bool) -> pd.DataFrame:
    """(season, week, slate) rows to rate; ``current`` adds one slate after the latest data."""
    slates = pbp[["season", "week"]].drop_duplicates()
    slates["slate"] = slate_index(slates)
    slates = slates.sort_values("slate")
    if current:
        last = slates.iloc[-1]
        slates = pd.concat([slates, pd.DataFrame([{"season": last["season"], "week": last["week"] + 1,
                                                   "slate": last["slate"] + 1}])], ignore_index=True)
    return slates[slates["season"].isin(target_seasons)]


def _decay(age: np.ndarray) -> np.ndarray:
    return 0.5 ** (age / HALF_LIFE_SLATES)


def _ridge_team_effects(epa, w, off_idx, def_idx, home, n_teams, lam_off, lam_def):
    """Solve weighted ridge: epa ~ mu + off[o] + def[d] + h*home."""
    p = 2 + 2 * n_teams
    A = np.zeros((p, p))
    b = np.zeros(p)
    # Build normal equations without a dense design matrix.
    idx_off = 2 + off_idx
    idx_def = 2 + n_teams + def_idx
    cols = [np.zeros(len(epa), dtype=int), np.ones(len(epa), dtype=int), idx_off, idx_def]
    vals = [np.ones(len(epa)), home, np.ones(len(epa)), np.ones(len(epa))]
    for ci, vi in zip(cols, vals):
        np.add.at(b, ci, w * vi * epa)
        for cj, vj in zip(cols, vals):
            np.add.at(A, (ci, cj), w * vi * vj)
    pen = np.zeros(p)
    pen[2:2 + n_teams] = lam_off
    pen[2 + n_teams:] = lam_def
    A[np.diag_indices(p)] += pen
    beta = np.linalg.solve(A, b)
    return beta[0], beta[1], beta[2:2 + n_teams], beta[2 + n_teams:]


MIN_PAST_PLAYS = 2000     # about a week of games: fewer and the ridge fit has nothing to pin the teams to


def team_ratings(pbp: pd.DataFrame, target_seasons, current: bool = True) -> pd.DataFrame:
    """As-of offense/defense EPA ratings for every (season, week, team)."""
    plays = pbp[pbp["play_type"].isin(["run", "pass"]) & pbp["epa"].notna()
                & pbp["two_point_attempt"].fillna(0).eq(0)].copy()
    plays["kind"] = np.where(plays["qb_dropback"].fillna(0).eq(1), "pass", "rush")
    plays["slate"] = slate_index(plays)
    wp = plays["wp"].fillna(0.5)
    plays["w_base"] = np.where(wp.between(0.05, 0.95), 1.0, 0.3)
    # Tendencies: pass rate over expected in neutral situations.
    neutral = (plays["down"].isin([1, 2]) & wp.between(0.2, 0.8)
               & (plays["half_seconds_remaining"] > 120) & plays["pass_oe"].notna())
    plays["neutral"] = neutral
    teams = sorted(set(plays["posteam"].dropna()) | set(plays["defteam"].dropna()))
    tix = {t: i for i, t in enumerate(teams)}
    plays["o"] = plays["posteam"].map(tix)
    plays["d"] = plays["defteam"].map(tix)
    plays["home"] = (plays["posteam"] == plays["home_team"]).astype(float) - 0.5

    out = []
    for _, row in _target_slates(plays, target_seasons, current).iterrows():
        past = plays[plays["slate"] < row["slate"]]
        past = past[past["slate"] >= row["slate"] - 60]
        if len(past) < MIN_PAST_PLAYS:        # the first weeks of the earliest season there is (1999): nothing to rate on yet
            continue
        age = row["slate"] - past["slate"].to_numpy()
        w_all = past["w_base"].to_numpy() * _decay(age)
        rec = {"team": teams}
        for kind in ("pass", "rush"):
            m = (past["kind"] == kind).to_numpy()
            mu, h, off, de = _ridge_team_effects(
                past["epa"].to_numpy()[m], w_all[m], past["o"].to_numpy()[m],
                past["d"].to_numpy()[m], past["home"].to_numpy()[m], len(teams),
                RIDGE[kind]["off"], RIDGE[kind]["def"],
            )
            rec[f"off_{kind}"] = off
            rec[f"def_{kind}"] = de
            rec[f"mu_{kind}"] = np.full(len(teams), mu)
            rec[f"home_{kind}"] = np.full(len(teams), h)
        # Pass rate over expected (shrunk toward 0 with 150 pseudo-plays).
        nm = past["neutral"].to_numpy()
        g = pd.DataFrame({"t": past["posteam"].to_numpy()[nm], "x": past["pass_oe"].to_numpy()[nm] / 100.0,
                          "w": w_all[nm]})
        agg = g.assign(xw=g.x * g.w).groupby("t")[["xw", "w"]].sum()
        proe = (agg["xw"] / (agg["w"] + 150.0)).reindex(teams).fillna(0.0)
        rec["proe"] = proe.to_numpy()
        df = pd.DataFrame(rec)
        df["season"] = int(row["season"])
        df["week"] = int(row["week"])
        out.append(df)
    res = pd.concat(out, ignore_index=True)
    return res


# ----------------------------------------------------------------- kicking ---
def _fg_features(dist, indoor, wind, temp, season):
    d = (np.atleast_1d(np.asarray(dist, float)) - 40.0) / 10.0
    shape = d.shape
    outdoor = np.broadcast_to(1.0 - np.asarray(indoor, float), shape)
    wind = np.broadcast_to(np.nan_to_num(np.asarray(wind, float), nan=0.0), shape) * outdoor
    temp = np.broadcast_to(np.nan_to_num(np.asarray(temp, float), nan=65.0), shape)
    cold = np.clip(50.0 - temp, 0, None) / 10.0 * outdoor
    yr = np.broadcast_to((np.asarray(season, float) - 2020.0) / 5.0, shape)
    return np.column_stack([d, d ** 2, d ** 3, outdoor, wind / 10.0, wind / 10.0 * d, cold, cold * d,
                            yr, yr * d])


def fit_fg_model(pbp: pd.DataFrame):
    """Logistic FG make model on distance and weather. Returns fitted model."""
    fg = pbp[pbp["field_goal_attempt"].fillna(0).eq(1) & pbp["kick_distance"].notna()].copy()
    fg = fg[fg["play_type"] == "field_goal"]
    y = (fg["field_goal_result"] == "made").astype(int).to_numpy()
    indoor = fg["roof"].isin(["dome", "closed"]).to_numpy()
    X = _fg_features(fg["kick_distance"], indoor, fg["wind"], fg["temp"], fg["season"])
    model = LogisticRegression(C=10.0, max_iter=2000).fit(X, y)
    return model


def fg_logit(model, dist, indoor, wind, temp, season):
    X = _fg_features(dist, indoor, wind, temp, season)
    return X @ model.coef_[0] + model.intercept_[0]


def kicker_ratings(pbp: pd.DataFrame, fg_model, target_seasons, current: bool = True) -> pd.DataFrame:
    """As-of empirical-Bayes logit shift per kicker for every (season, week)."""
    fg = pbp[(pbp["play_type"] == "field_goal") & pbp["kick_distance"].notna()
             & pbp["kicker_player_id"].notna()].copy()
    fg["slate"] = slate_index(fg)
    indoor = fg["roof"].isin(["dome", "closed"]).to_numpy()
    z = fg_logit(fg_model, fg["kick_distance"], indoor, fg["wind"], fg["temp"], fg["season"])
    p = 1 / (1 + np.exp(-z))
    fg["resid"] = (fg["field_goal_result"] == "made").astype(float) - p
    fg["info"] = p * (1 - p)
    out = []
    for _, row in _target_slates(pbp, target_seasons, current).iterrows():
        past = fg[fg["slate"] < row["slate"]]
        w = 0.5 ** ((row["slate"] - past["slate"]) / 60.0)  # kicker skill is stable: ~2-season half-life
        g = past.assign(r=past.resid * w, i=past["info"] * w).groupby("kicker_player_id")[["r", "i"]].sum()
        g["rating"] = g["r"] / (g["i"] + KICKER_PRIOR_PRECISION)
        g["eff_att"] = g["i"] / 0.12
        g = g.reset_index()[["kicker_player_id", "rating", "eff_att"]]
        g["season"], g["week"] = int(row["season"]), int(row["week"])
        out.append(g)
    return pd.concat(out, ignore_index=True)


# ----------------------------------------------------------------- punting ---
def punt_table(pbp: pd.DataFrame) -> pd.DataFrame:
    """Every non-blocked punt with net yards and expected net yards by field position."""
    pu = pbp[(pbp["play_type"] == "punt") & pbp["punter_player_id"].notna()].copy()
    pu = pu[pu["next_posteam"].notna() & (pu["next_posteam"] != pu["posteam"])]
    spot_after = 100 - pu["next_yardline_100"]  # in kicking-team frame (yards to opp goal)
    pu["net"] = pu["yardline_100"] - spot_after
    pu = pu[pu["net"].between(-30, 85)]
    pu["yl_bin"] = (pu["yardline_100"] // 5) * 5
    exp = pu[pu["punt_blocked"].fillna(0).eq(0)].groupby("yl_bin")["net"].mean()
    pu["exp_net"] = pu["yl_bin"].map(exp)
    pu["nyoe"] = pu["net"] - pu["exp_net"]
    return pu


def punter_ratings(pbp: pd.DataFrame, target_seasons, current: bool = True) -> pd.DataFrame:
    pu = punt_table(pbp)
    pu = pu[pu["punt_blocked"].fillna(0).eq(0) & pu["return_touchdown"].fillna(0).eq(0)]
    pu["slate"] = slate_index(pu)
    out = []
    for _, row in _target_slates(pbp, target_seasons, current).iterrows():
        past = pu[pu["slate"] < row["slate"]]
        w = 0.5 ** ((row["slate"] - past["slate"]) / 40.0)
        g = past.assign(x=past.nyoe * w, w=w).groupby("punter_player_id")[["x", "w"]].sum()
        g["rating"] = g["x"] / (g["w"] + PUNTER_PRIOR_PUNTS)
        g = g.reset_index()[["punter_player_id", "rating"]]
        g["season"], g["week"] = int(row["season"]), int(row["week"])
        out.append(g)
    return pd.concat(out, ignore_index=True)
