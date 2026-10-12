"""Backtests on real games beyond the core validation.

1. True out-of-sample season: every model was fit through 2025; score the simulator on 2026 games.
2. Decision-outcome calibration: the simulated win probability of the option a coach actually chose,
   against whether that team actually won. If the engine's evaluations are right, they must be
   calibrated on the decisions coaches really made, including the mistakes.
3. Calibration by situation (trailing/leading, time left) for the late-game validation states.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config, validate
from .wp import evaluate


def _bins(p, y, edges=(0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.0001)):
    b = np.digitize(p, edges) - 1
    df = pd.DataFrame({"bin": b, "p": p, "y": y})
    return df.groupby("bin").agg(predicted=("p", "mean"), actual=("y", "mean"), n=("y", "size")).reset_index(drop=True)


def decision_outcome_calibration(graded: pd.DataFrame, pbp: pd.DataFrame) -> dict:
    res = pbp.groupby("game_id").agg(result=("result", "first"), home=("home_team", "first"))
    g = graded.join(res, on="game_id")
    g = g[g["result"].notna()]
    won = np.where(g["team"] == g["home"], g["result"] > 0, g["result"] < 0).astype(float)
    tie = g["result"] == 0
    y = np.where(tie, 0.5, won)
    keep = ~tie.to_numpy()
    p = g["wp_actual"].to_numpy()
    out = {"all": evaluate(p[keep], y[keep]), "table": _bins(p[keep], y[keep]).to_dict("records")}
    mist = (g["sig_error"].to_numpy()) & keep
    if mist.sum() > 30:
        out["clear_mistakes"] = evaluate(p[mist], y[mist])
        out["clear_mistakes"]["mean_predicted"] = float(p[mist].mean())
        out["clear_mistakes"]["actual_win_rate"] = float(y[mist].mean())
    by = {}
    for fam, idx in g[keep].groupby("decision").groups.items():
        sub = g.loc[idx]
        yy = np.where(sub["team"] == sub["home"], sub["result"] > 0, sub["result"] < 0).astype(float)
        by[fam] = {"n": int(len(sub)), "mean_predicted": float(sub["wp_actual"].mean()), "actual_win_rate": float(yy.mean())}
    out["by_family"] = by
    return out


def out_of_sample_season(pbp: pd.DataFrame, season: int, n_states: int = 1500, n_sims: int = 500) -> dict:
    df, metrics = validate.late_game_calibration(pbp, [season], n_states=n_states, n_sims=n_sims, seed=7)
    keep = df["y_home"] != 0.5
    metrics["table_sim"] = _bins(df.loc[keep, "sim_wp_home"].to_numpy(), df.loc[keep, "y_home"].to_numpy()).to_dict("records")
    return metrics


def calibration_by_situation(states_csv=None) -> list:
    df = pd.read_csv(states_csv or config.REPORT_DIR / "validation_states.csv")
    df = df[df["y_home"] != 0.5]
    df["time"] = pd.cut(df["game_seconds_remaining"], [0, 120, 300, 600], labels=["final 2:00", "2:00-5:00", "5:00-10:00"])
    rows = []
    for t, g in df.groupby("time", observed=True):
        for col in ("sim_wp_home", "model_wp_home", "nflfastr_wp_home"):
            m = evaluate(g[col].to_numpy(), g["y_home"].to_numpy())
            rows.append({"window": str(t), "model": col, **m})
    return rows


def run_all(graded: pd.DataFrame, pbp: pd.DataFrame, oos_season: int | None = 2026) -> dict:
    out = {"decision_outcome": decision_outcome_calibration(graded, pbp)}
    try:
        out["by_situation"] = calibration_by_situation()
    except FileNotFoundError:
        pass
    if oos_season:
        p = pbp[pbp["season"] == oos_season]
        if len(p):
            out["out_of_sample"] = {"season": oos_season, **out_of_sample_season(pbp[pbp["season"] == oos_season], oos_season)}
    (config.REPORT_DIR / "backtests.json").write_text(json.dumps(out, indent=1, default=float))
    return out
