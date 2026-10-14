"""Percentile grades and coach-tendency models, learned from every graded 2023-25 decision.

* Grade scale: for each decision family, the distribution of win probability given away by real NFL
  choices. Any option's cost is placed in that distribution ("worse than 93% of NFL calls") and
  mapped to a letter grade.
* Tendency models: multinomial logistic regressions of what coaches actually chose, given the
  situation from the deciding team's point of view. They answer "how often do NFL coaches do this
  here?" and can stand in for a typical coach inside simulations.

The feature vector is mirrored exactly in web/live.html (tendencyFeatures).
"""
from __future__ import annotations

import json
import pickle

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from . import config

LETTERS = [[0.80, "A"], [0.90, "B"], [0.95, "C"], [0.99, "D"], [1.01, "F"]]
A_FLOOR = 0.0025  # anything costing under a quarter of a WP point is an A
FAMILIES = ["def_timeout", "off_clock_stop", "fourth_down", "pat", "onside", "h1_end", "kneel", "play_select"]
POST = {"def_timeout", "off_clock_stop", "lead_tempo"}
FEATURES = ["t_half_min", "log_t_half", "half2", "margin", "abs_margin", "trailing", "leading", "down", "ytg",
            "log_ytg", "yl10", "yl10_sq", "my_to", "op_to", "under_2min", "q4_under_5", "running",
            "fg_range", "beyond_fg10"]


def features_from_raw(t_half, half2, margin, down, ytg, yl, my_to, op_to, running) -> np.ndarray:
    t_half = np.asarray(t_half, float)
    margin = np.asarray(margin, float)
    ytg = np.asarray(ytg, float)
    yl = np.asarray(yl, float)
    half2 = np.asarray(half2, float)
    cols = [t_half / 60, np.log1p(t_half), half2, margin, np.abs(margin), (margin < 0) * 1.0, (margin > 0) * 1.0,
            np.asarray(down, float), ytg, np.log(np.maximum(ytg, 1)), yl / 10, (yl / 10) ** 2,
            np.asarray(my_to, float), np.asarray(op_to, float), (t_half <= 120) * 1.0,
            ((t_half <= 300) & (half2 == 1)) * 1.0, np.asarray(running, float),
            (yl <= 40) * 1.0, np.maximum(yl - 40, 0) / 10]
    n = max(np.size(c) for c in cols)
    return np.column_stack([np.broadcast_to(c, (n,)) for c in cols])


def decision_features(df: pd.DataFrame) -> np.ndarray:
    """Feature matrix for graded decisions (deciding team's perspective)."""
    post = df["decision"].isin(POST).to_numpy()
    special = df["decision"].isin(["pat", "onside"]).to_numpy()
    t = np.where(post, df["t_end"].fillna(df["game_seconds_remaining"]), df["game_seconds_remaining"]).astype(float)
    half2 = (df["qtr"] >= 3).to_numpy()
    t_half = np.where(half2, t, t - 1800)
    offense = (df["team"] == df["posteam"]).to_numpy()
    margin = np.where(offense, df["margin_off"], -df["margin_off"]).astype(float)
    down = np.where(post, df["n_down"], df["down"])
    ytg = np.where(post, df["n_ydstogo"], df["ydstogo"])
    yl = np.where(post, df["next_yardline_100"], df["yardline_100"])
    down = np.where(special, 1, np.nan_to_num(down, nan=1))
    ytg = np.where(special, 10, np.nan_to_num(ytg, nan=10))
    yl = np.where(special, 75, np.nan_to_num(yl, nan=75))
    # timeouts held at the moment of the decision
    off_to_post = df["n_posteam_timeouts_remaining"] + (df["to_after_team"] == df["posteam"]).astype(int)
    def_to_post = df["n_defteam_timeouts_remaining"] + (df["to_after_team"] == df["defteam"]).astype(int)
    off_to = np.where(post, off_to_post, df["posteam_timeouts_remaining"]).astype(float)
    def_to = np.where(post, def_to_post, df["defteam_timeouts_remaining"]).astype(float)
    my_to = np.where(offense, off_to, def_to)
    op_to = np.where(offense, def_to, off_to)
    return features_from_raw(t_half, half2.astype(float), margin, down, ytg, yl, np.nan_to_num(my_to, nan=3),
                             np.nan_to_num(op_to, nan=3), post.astype(float))


def build_grade_scale(graded: pd.DataFrame) -> dict:
    out = {"letters": LETTERS, "a_floor": A_FLOOR, "families": {}}
    for fam, g in graded.groupby("decision"):
        cost = np.where(g["recommended"] == g["actual"], 0.0, g["gain"].clip(lower=0)).astype(float)
        q = np.quantile(cost, np.linspace(0, 1, 201))
        out["families"][fam] = {"q": [round(float(x), 6) for x in q], "n": int(len(g)),
                                "share_optimal": float(np.mean(cost <= 0.0005))}
    return out


def letter_for(scale: dict, family: str, cost: float) -> tuple[str, float]:
    if family not in scale["families"]:
        return ("?", float("nan"))
    q = np.array(scale["families"][family]["q"])
    pct = float(np.searchsorted(q, cost, side="left") / len(q))
    if cost <= scale.get("a_floor", A_FLOOR):
        return ("A", pct)
    return (next(lbl for thr, lbl in scale["letters"] if pct <= thr), pct)


def fit_tendencies(graded: pd.DataFrame) -> dict:
    models = {}
    X_all = decision_features(graded)
    for fam in FAMILIES:
        m = (graded["decision"] == fam).to_numpy()
        y = graded.loc[m, "actual"].to_numpy()
        classes = sorted(set(y))
        if len(classes) < 2 or m.sum() < 40:
            continue
        X = X_all[m]
        mean = X.mean(axis=0)
        scale = X.std(axis=0)
        scale[scale < 1e-9] = 1.0
        Z = (X - mean) / scale
        clf = LogisticRegression(C=0.5, max_iter=3000).fit(Z, y)
        models[fam] = {"classes": [str(c) for c in clf.classes_], "mean": mean.tolist(), "scale": scale.tolist(),
                       "coef": clf.coef_.tolist(), "intercept": clf.intercept_.tolist(), "n": int(m.sum()),
                       "share": {str(c): float(np.mean(y == c)) for c in classes}}
    return {"features": FEATURES, "families": models}


def predict_proba(model: dict, X: np.ndarray) -> np.ndarray:
    Z = (np.atleast_2d(X) - np.array(model["mean"])) / np.array(model["scale"])
    z = Z @ np.array(model["coef"]).T + np.array(model["intercept"])
    if z.shape[1] == 1:
        p = 1 / (1 + np.exp(-z[:, 0]))
        return np.column_stack([1 - p, p])
    z -= z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def predict_share(tend: dict, family: str, option: str, st, root, team_idx: int):
    """Share of NFL coaches choosing ``option`` in this live state (console helper)."""
    model = tend["families"].get(family)
    if model is None or option not in model["classes"]:
        return None
    o = root.pos
    me = team_idx
    margin = root.score[me] - root.score[1 - me]
    half2 = 1.0 if root.t <= 1800 else 0.0
    t_half = root.t if half2 else root.t - 1800
    special = st.phase in ("pat", "kickoff")
    x = features_from_raw(t_half, half2, margin, 1 if special else st.down, 10 if special else st.ytg,
                          75 if special else st.yl, root.to[me], root.to[1 - me], 1.0 if st.running else 0.0)
    p = predict_proba(model, x)[0]
    return float(p[model["classes"].index(option)])


def build_all(graded: pd.DataFrame | None = None) -> tuple[dict, dict]:
    if graded is None:
        from .report import load_graded
        graded = load_graded()
        graded = graded[graded["season"].isin(config.ANALYSIS_SEASONS)]
    scale = build_grade_scale(graded)
    tend = fit_tendencies(graded)
    config.ARTIFACT_DIR.mkdir(exist_ok=True)
    (config.ARTIFACT_DIR / "grade_scale.json").write_text(json.dumps(scale))
    (config.ARTIFACT_DIR / "tendency_web.json").write_text(json.dumps(tend))
    with open(config.ARTIFACT_DIR / "tendency.pkl", "wb") as f:
        pickle.dump(tend, f)
    return scale, tend


# ------------------------------------------------- whole-game 4th downs ---
FOURTH_CLASSES = ["fg", "go", "punt"]
COACH_PRIOR = 25.0  # shrinkage (pseudo-decisions) for each coach's go-for-it shift


def fourth_down_frame(pbp: pd.DataFrame, seasons) -> pd.DataFrame:
    s = pbp[pbp["season"].isin(seasons) & (pbp["down"] == 4) & (pbp["qtr"] <= 4)
            & pbp["play_type"].isin(["punt", "field_goal", "run", "pass"])
            & pbp["posteam_timeouts_remaining"].notna()].copy()
    s["choice"] = np.where(s["play_type"] == "punt", "punt", np.where(s["play_type"] == "field_goal", "fg", "go"))
    s["coach"] = s["off_coach"]
    return s


def fourth_features(s: pd.DataFrame) -> np.ndarray:
    half2 = (s["qtr"] >= 3).astype(float).to_numpy()
    return features_from_raw(s["half_seconds_remaining"], half2, s["margin"], 4, s["ydstogo"], s["yardline_100"],
                             s["posteam_timeouts_remaining"], s["defteam_timeouts_remaining"], 0.0)


def fit_fourth_all(pbp: pd.DataFrame, seasons=None) -> tuple[dict, pd.DataFrame]:
    """Typical-coach 4th-down model over the whole game, plus each coach's go-for-it shift."""
    seasons = seasons or config.ANALYSIS_SEASONS
    s = fourth_down_frame(pbp, seasons)
    X = fourth_features(s)
    mean, scale = X.mean(axis=0), X.std(axis=0)
    scale[scale < 1e-9] = 1.0
    clf = LogisticRegression(C=1.0, max_iter=4000).fit((X - mean) / scale, s["choice"])
    model = {"classes": [str(c) for c in clf.classes_], "mean": mean.tolist(), "scale": scale.tolist(),
             "coef": clf.coef_.tolist(), "intercept": clf.intercept_.tolist(), "n": int(len(s))}
    p = predict_proba(model, X)
    gi = model["classes"].index("go")
    s["p_go"] = p[:, gi]
    s["is_go"] = (s["choice"] == "go").astype(float)
    # only spots where the decision is live (both going and not going happen) carry information
    live = s[s["p_go"].between(0.05, 0.95)]
    g = live.groupby("coach").agg(n=("is_go", "size"), go=("is_go", "sum"), exp_go=("p_go", "sum"),
                                  info=("p_go", lambda x: float((x * (1 - x)).sum())),
                                  teams=("posteam", lambda x: "/".join(sorted(set(x)))))
    g["go_shift"] = (g["go"] - g["exp_go"]) / (g["info"] + COACH_PRIOR)
    g = g[g["n"] >= 15].copy()
    g["aggressiveness_pct"] = g["go_shift"].rank(pct=True)
    return model, g.reset_index()


def coach_profiles(pbp: pd.DataFrame, by_coach: pd.DataFrame | None = None) -> dict:
    model, g = fit_fourth_all(pbp)
    out = {"fourth_model": model, "coaches": {}}
    quality = {}
    if by_coach is not None and len(by_coach):
        bc = by_coach.copy()
        bc["quality_pct"] = 1 - bc["wins_lost_per_17"].rank(pct=True) + 1 / len(bc)
        quality = bc.set_index("coach")[["wins_lost_per_17", "quality_pct", "games"]].to_dict("index")
    for _, r in g.iterrows():
        rec = {"teams": r["teams"], "fourth_downs": int(r["n"]), "go_rate": float(r["go"] / r["n"]),
               "expected_go_rate": float(r["exp_go"] / r["n"]), "go_shift": float(r["go_shift"]),
               "aggressiveness_pct": float(r["aggressiveness_pct"])}
        if r["coach"] in quality:
            q = quality[r["coach"]]
            rec.update(clock_wins_lost_per_17=float(q["wins_lost_per_17"]), clock_quality_pct=float(q["quality_pct"]))
        out["coaches"][r["coach"]] = rec
    (config.ARTIFACT_DIR / "coach_profiles.json").write_text(json.dumps(out))
    return out
