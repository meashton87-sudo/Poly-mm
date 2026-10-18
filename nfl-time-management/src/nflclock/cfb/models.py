"""The college bundle (artifacts/bundle_cfb.pkl): the NFL fits (models.py, ratings.py, wp.py, library.py) run on the
normalized college frame (cfb/data.py), plus the level constants the engine reads (design 2.3).

Everything is fit on FBS-vs-FBS games; anything that reads the clock (tempo, WP, the library's situations) only on
games whose clock is good (data.clock_quality).
"""
from __future__ import annotations

import multiprocessing as mp
import os
from contextlib import contextmanager

import numpy as np
import pandas as pd

from .. import library as L
from .. import ratings as R
from .. import wp as W
from ..models import Bundle
from ..sim import KICKOFF_START_YL
from . import config as K
from . import data as D

# College rosters turn over faster than the NFL's and talent gaps are wider: a season's plays fade faster across
# the off-season, and team effects are allowed to be larger (ridge penalties at half the NFL's, in plays).
CFB_RIDGE = {"pass": {"off": 80.0, "def": 150.0}, "rush": {"off": 150.0, "def": 210.0}}
CFB_OFFSEASON_GAP = 14.0     # slates of decay over the off-season (NFL 8): last season counts ~45%, not ~63%
CFB_HALF_LIFE = 12.0         # slates (as the NFL)
FG_TAPER_GRID = (np.arange(44, 57, 2), np.arange(0.0, 0.16, 0.015), np.arange(54, 65, 2), np.arange(0.0, 0.21, 0.04))


@contextmanager
def _college_ratings():
    """ratings.py's module constants set to college values for the duration (an adapter: ratings.py is unchanged)."""
    old = (R.RIDGE, R.OFFSEASON_GAP_SLATES, R.HALF_LIFE_SLATES)
    R.RIDGE, R.OFFSEASON_GAP_SLATES, R.HALF_LIFE_SLATES = CFB_RIDGE, CFB_OFFSEASON_GAP, CFB_HALF_LIFE
    try:
        yield
    finally:
        R.RIDGE, R.OFFSEASON_GAP_SLATES, R.HALF_LIFE_SLATES = old


def fbs(e: pd.DataFrame, good: bool = False) -> pd.DataFrame:
    m = e["fbs"]
    if good:
        m &= ~e["clock_bad"]
    return e[m]


# ------------------------------------------------------------------------ WP ---
@contextmanager
def _lgb_threads():
    """CFB_LGB_THREADS caps LightGBM's threads (a shared machine: oversubscribed OpenMP threads spin)."""
    n = os.environ.get("CFB_LGB_THREADS")
    old = W.PARAMS.get("num_threads")
    if n:
        W.PARAMS["num_threads"] = int(n)
    try:
        yield
    finally:
        W.PARAMS["num_threads"] = old


def fit_wp(e: pd.DataFrame, log=print) -> tuple[W.WPModel, dict]:
    """Same 13 features and trees as the NFL model. Two training sets (2021-25, 2023-25: the 2023 clock rule) picked
    by log loss on the 2026 holdout, scored against cfbfastR's own wp_before on the same snaps."""
    g = fbs(e, good=True)
    hold = W.training_frame(g[g["season"].isin(K.WP_HOLDOUT)])
    hold = hold[hold["wp"].notna()]
    rep, best = {"holdout_snaps": int(len(hold)), "holdout_games": int(hold["game_id"].nunique())}, None
    y = hold["y"].to_numpy()
    rep["cfbfastR"] = W.evaluate(hold["wp"].to_numpy(), y)
    for name, seasons in (("2021-2025", K.WP_SEASONS), ("2023-2025", [s for s in K.WP_SEASONS if s >= 2023])):
        tf = W.training_frame(g[g["season"].isin(seasons)])
        with _lgb_threads():
            m = W.WPModel().fit(tf)
        ev = W.evaluate(m.predict_X(W.frame_features(hold)), y)
        ev["train_snaps"] = int(len(tf))
        rep[name] = ev
        log(f"  WP {name}: holdout log loss {ev['logloss']:.4f} (cfbfastR {rep['cfbfastR']['logloss']:.4f}), ECE {ev['ece']:.4f}")
        if best is None or ev["logloss"] < rep[best[0]]["logloss"]:
            best = (name, m)
    rep["chosen"] = best[0]
    late = (hold["qtr"] == 4) & (hold["game_seconds_remaining"] <= 600) & (hold["margin"].abs() <= 8)
    if late.any():
        rep["late_close"] = {"snaps": int(late.sum()),
                             "model": W.evaluate(best[1].predict_X(W.frame_features(hold[late])), y[late.to_numpy()]),
                             "cfbfastR": W.evaluate(hold.loc[late, "wp"].to_numpy(), y[late.to_numpy()])}
    return best[1], rep


# ---------------------------------------------------------------- field goals ---
def fg_long_prob(model, dist, season, taper):
    """FG make probability with the long-range taper (sim.py fg_prob's shape: two linear logit cuts)."""
    a, s1, b, s2 = taper
    dist = np.asarray(dist, float)
    z = R.fg_logit(model, np.minimum(dist, 70.0), False, 0.0, 65.0, season)
    z = z - s1 * np.maximum(0.0, dist - a) - s2 * np.maximum(0.0, dist - b)
    return 1 / (1 + np.exp(-z))


def fit_fg(e: pd.DataFrame) -> tuple[object, tuple, float, dict]:
    """ratings.fit_fg_model on college kicks (no weather in the data: those terms come out ~0), then the long-range
    taper (fg_long) refit to college long kicks by likelihood, and fg_max = the longest make plus a yard."""
    fg = fbs(e)
    fg = fg[fg["season"].isin(K.FG_SEASONS) & (fg["play_type"] == "field_goal") & fg["kick_distance"].between(15, 75)]
    model = R.fit_fg_model(fg)
    d = fg["kick_distance"].to_numpy(float)
    y = (fg["field_goal_result"] == "made").to_numpy()
    se = fg["season"].to_numpy()
    long_ = d >= 40
    z0 = R.fg_logit(model, np.minimum(d[long_], 70.0), False, 0.0, 65.0, se[long_])
    dl, yl = d[long_], y[long_]
    best, best_ll = (52.0, 0.045, 60.0, 0.05), np.inf
    A, S1, B, S2 = FG_TAPER_GRID
    for a in A:
        ca = np.maximum(0.0, dl - a)
        for b in B:
            if b <= a:
                continue
            cb = np.maximum(0.0, dl - b)
            for s1 in S1:
                for s2 in S2:
                    p = np.clip(1 / (1 + np.exp(-(z0 - s1 * ca - s2 * cb))), 1e-9, 1 - 1e-9)
                    ll = -np.sum(yl * np.log(p) + (1 - yl) * np.log(1 - p))
                    if ll < best_ll:
                        best, best_ll = (float(a), float(s1), float(b), float(s2)), ll
    fg_max = float(d[y].max() + 1) if y.any() else 68.0
    p = fg_long_prob(model, d, se, best)
    bins = (d // 5 * 5).astype(int)
    tab = pd.DataFrame({"bin": bins, "y": y, "p": p}).groupby("bin").agg(n=("y", "size"), raw=("y", "mean"), model=("p", "mean"))
    tab["se"] = np.sqrt(tab["raw"].clip(0.02, 0.98) * (1 - tab["raw"].clip(0.02, 0.98)) / tab["n"])
    tab["z"] = (tab["model"] - tab["raw"]) / tab["se"]
    rep = {"kicks": int(len(fg)), "fg_long": list(best), "fg_max": fg_max,
           "by_5yd": {int(k): {"n": int(r["n"]), "raw": round(float(r["raw"]), 4), "model": round(float(r["model"]), 4),
                                "z": round(float(r["z"]), 2)} for k, r in tab.iterrows()},
           "bins_within_2se": int((tab.loc[tab["n"] >= 20, "z"].abs() <= 2).sum()),
           "bins_n20": int((tab["n"] >= 20).sum()),
           "coef": [round(float(c), 4) for c in model.coef_[0]]}
    return model, best, fg_max, rep


# ------------------------------------------------------------ special teams ---
def kickoff_samples(e: pd.DataFrame) -> tuple[dict, dict]:
    """2023-25 kickoffs (touchback and fair catch inside the 25 at the 25), onside kicks left out: where the
    receiving team's first snap is, how long the kick took (the clock runs only from the catch), return scores."""
    g = fbs(e)
    g = g[g["season"].isin(K.KICKOFF_SEASONS)]
    prev_end = g.groupby(["game_id", "qtr"])["t_end"].shift(1)
    ko = g[(g["play_type"] == "kickoff") & (g["onside"] == 0)].assign(prev_end=prev_end)
    snaps = g[g["is_snap"]][["game_id", "row_order", "yardline_100", "posteam"]]
    m = pd.merge_asof(ko.sort_values("row_order")[["game_id", "row_order", "t_end", "prev_end", "return_touchdown", "posteam"]],
                      snaps.sort_values("row_order"), on="row_order", by="game_id", direction="forward", suffixes=("", "_n"))
    m = m[m["yardline_100"].notna() & (m["posteam_n"] == m["posteam"])]
    dur = (m["prev_end"] - m["t_end"]).where(m["prev_end"].notna(), 0.0).clip(0, 12)
    out = {"start_yl": m["yardline_100"].clip(1, 99).to_numpy(float), "duration": dur.to_numpy(float),
           "ret_td": (m["return_touchdown"].fillna(0) == 1).to_numpy()}
    st = out["start_yl"]
    rep = {"kicks": int(len(st)), "mean_start_yl": round(float(st.mean()), 2),
           "touchback_share": round(float(np.mean((st == K.KO_TOUCHBACK_YL) & (out["duration"] == 0))), 4),
           "at_25_share": round(float(np.mean(st == K.KO_TOUCHBACK_YL)), 4),
           "ret_td_rate": round(float(out["ret_td"].mean()), 4), "median_duration": float(np.median(out["duration"]))}
    return out, rep


def punt_samples(e: pd.DataFrame) -> tuple[dict, dict]:
    pu = R.punt_table(fbs(e)[lambda x: x["season"].isin(K.PUNT_SEASONS)])
    dur = pu["delta_t"].where(pu["delta_t"].between(3, 20), 9.0)
    out = {"yl": pu["yardline_100"].to_numpy(float), "net": pu["net"].to_numpy(float),
           "ret_td": (pu["return_touchdown"].fillna(0) == 1).to_numpy(),
           "blocked": (pu["punt_blocked"].fillna(0) == 1).to_numpy(),
           "touchback": (pu["touchback"].fillna(0) == 1).to_numpy(), "duration": dur.to_numpy(float)}
    return out, {"punts": int(len(pu)), "mean_net": round(float(pu["net"].mean()), 2),
                 "blocked_rate": round(float(out["blocked"].mean()), 4), "ret_td_rate": round(float(out["ret_td"].mean()), 4)}


def tempo_samples(e: pd.DataFrame) -> tuple[dict, dict]:
    """Seconds from the whistle to the next snap with the clock running (models._tempo_samples' logic; the feeds
    have no no-huddle flag, so hurry is the situation): hurry = trailing in the last 5:00 or any score before the
    half inside 2:00; urgent = Q2 inside 1:00, or Q4 inside 2:00 trailing; milk = leading in the last 6:00;
    normal = the rest outside the fourth quarter; spike = the next snap is a spike. 2023 on (a first down stops the
    clock only inside 2:00), clock-good FBS games; first downs inside 2:00 left out (their stop is
    fd_restart_credit), and gaps that cross 2:00 (the two-minute timeout)."""
    s = fbs(e, good=True)
    s = s[s["is_snap"] & s["season"].isin(K.LIB_SEASONS)]
    ok = ((s["qtr"] == s["next_qtr"]) & s["to_after_team"].isna() & (s["next_posteam"] == s["posteam"])
          & s["delta_t"].between(0, 80) & s["play_type"].isin(["run", "pass"])
          & (s["incomplete_pass"] == 0) & (s["out_of_bounds"] == 0) & (s["penalty"].fillna(0) == 0)
          & (s["turnover"] == 0) & (s["touchdown"] == 0))
    hs = s["half_seconds_remaining"]
    ok &= ~((hs > 120) & (hs - s["delta_t"] <= 120))
    ok &= ~((hs <= 120) & (s["yards_gained"] >= s["ydstogo"]))
    yd = s["yards_gained"].clip(lower=0)
    s = s.assign(runoff=s["delta_t"] - np.where(s["play_type"] == "run", 5 + 0.12 * yd, 5 + 0.08 * yd))
    x = s[ok]
    q, qs, m, nxt = x["qtr"], x["quarter_seconds_remaining"], x["margin"], x["next_play_type"]
    late = ((q == 4) & (qs <= 300)) | ((q == 2) & (qs <= 120))
    plays = nxt.isin(["run", "pass"])
    samples = {
        "hurry": x[late & ((m < 0) | (q == 2)) & plays]["runoff"],
        "urgent": x[plays & (((q == 2) & (qs <= 60)) | ((q == 4) & (qs <= 120) & (m < 0)))]["runoff"],
        "normal": x[~late & (q != 4) & plays]["runoff"],
        "milk": x[(q == 4) & (qs <= 360) & (m > 0) & nxt.isin(["run", "pass", "qb_kneel", "punt", "field_goal"])]["runoff"],
        "spike": x[nxt == "qb_spike"]["runoff"],
    }
    out = {k: np.clip(v.to_numpy(), 1.0, 40.0) for k, v in samples.items()}
    return out, {k: {"n": int(len(v)), "median": round(float(np.median(v)), 2) if len(v) else None} for k, v in out.items()}


def consts(e: pd.DataFrame, fg_model, taper, fg_max, kickoffs, clock: dict) -> tuple[dict, dict]:
    """The level constants (design 2.3) and the simulator's constants, measured where the data allows."""
    g = fbs(e)
    p = g[g["season"].isin(range(2021, 2026))]
    xp = float((p.loc[p["extra_point_attempt"] == 1, "extra_point_result"] == "good").mean())
    two = float((p.loc[p["two_point_attempt"] == 1, "two_point_conv_result"] == "success").mean())
    pk = float(fg_long_prob(fg_model, [K.PAT_KICK_YARDS], 2025, taper)[0])
    xp_logit = float(np.log(xp / (1 - xp)) - np.log(pk / (1 - pk)))
    ko = g[(g["play_type"] == "kickoff") & (g["onside"] == 1) & g["season"].isin(range(2016, 2026))]
    rec = ko["own_kickoff_recovery"].fillna(0) == 1
    snaps = g[g["is_snap"]][["game_id", "row_order", "yardline_100"]]
    m = pd.merge_asof(ko.sort_values("row_order")[["game_id", "row_order", "own_kickoff_recovery"]], snaps.sort_values("row_order"),
                      on="row_order", by="game_id", direction="forward").dropna(subset=["yardline_100"])
    yl_k = float(m.loc[m["own_kickoff_recovery"] == 1, "yardline_100"].median()) if (m["own_kickoff_recovery"] == 1).any() else 54.0
    yl_r = float(m.loc[m["own_kickoff_recovery"] != 1, "yardline_100"].median()) if (m["own_kickoff_recovery"] != 1).any() else 46.0
    games = g.drop_duplicates("game_id")
    games = games[games["result"].notna() & games["spread_line"].notna() & games["season"].isin(range(2016, 2026))]
    ot_sd = float((games["result"] - games["spread_line"]).std())
    c = {"level": "fbs", "xp": xp, "two_pt": two, "onside": float(rec.mean()) if len(ko) else 0.1,
         "kneel_duration": 1.5, "spike_duration": 1.0, "timeout_reaction": 1.0,
         "oob_restart_credit": float(clock["oob"]["runoff_after_text_oob"].get("oob_restart_credit", 4.0)),
         "penalty_restart_credit": 20.0,
         "kickoff_start_yl": round(float(np.mean(kickoffs["start_yl"])), 2), "ko_touchback_yl": K.KO_TOUCHBACK_YL,
         "xp_logit": round(xp_logit, 4), "two_pt_base": round(two, 4),
         "fd_restart_credit": float(clock["fd_restart_credit"]["credit"]),
         "onside_yl": [yl_k, yl_r], "ot_margin_sd": round(ot_sd, 2),
         "fg_long": [round(x, 4) for x in taper], "fg_max": fg_max}
    rep = {"pat_attempts": int((p["extra_point_attempt"] == 1).sum()), "two_attempts": int((p["two_point_attempt"] == 1).sum()),
           "onside_kicks": int(len(ko)), "nfl_kickoff_start_yl": KICKOFF_START_YL,
           "measured": ["xp", "two_pt", "onside", "onside_yl", "ot_margin_sd", "kickoff_start_yl", "fd_restart_credit",
                        "oob_restart_credit", "fg_long", "fg_max", "xp_logit"],
           "assumed_nfl": ["kneel_duration", "spike_duration", "timeout_reaction", "penalty_restart_credit"]}
    return c, rep


# ------------------------------------------------------------------ ratings ---
def _rate_seasons(args):
    from threadpoolctl import threadpool_limits
    plays, seasons, kind = args
    with _college_ratings(), threadpool_limits(1):       # one BLAS thread a worker: the workers are the parallelism
        return R.team_ratings(plays, seasons, current=kind)


def team_ratings(e: pd.DataFrame, seasons, workers: int = 4) -> pd.DataFrame:
    """ratings.team_ratings (as of each week, ridge, decaying) on every game with an FBS team, with the college
    constants, one season per worker (each season's ratings read only the two before it and itself)."""
    m = (e["home_div"] == "fbs") | (e["away_div"] == "fbs")
    cols = ["season", "week", "play_type", "epa", "two_point_attempt", "qb_dropback", "wp", "down",
            "half_seconds_remaining", "pass_oe", "posteam", "defteam", "home_team"]
    plays = e.loc[m & e["play_type"].isin(["run", "pass"]), cols]
    tasks = [(plays[plays["season"].between(s - 3, s)], [s], s == max(seasons)) for s in seasons]
    with mp.get_context("fork").Pool(workers) as pool:
        out = pool.map(_rate_seasons, tasks)
    return pd.concat(out, ignore_index=True)


def tilt_check(lib: L.PlayLibrary, tr: pd.DataFrame) -> dict:
    """Design 3.4: at college-sized matchup gaps, the share of pools whose tilt (clip +-1.5) reaches its target mean
    within 0.02 EPA. Gaps: offense + defense ratings of real matchups (50th / 90th / 95th / 99th percentile)."""
    gaps = {}
    for kind in ("pass", "rush"):
        off = tr[f"off_{kind}"].to_numpy()
        de = tr[f"def_{kind}"].to_numpy()
        rng = np.random.default_rng(5)
        g = off[rng.integers(0, len(off), 20000)] + de[rng.integers(0, len(de), 20000)]
        gaps[kind] = g
    out = {}
    starts = lib.offsets[:-1]
    e_ = lib.item_epa
    n = np.diff(lib.offsets)
    base = np.add.reduceat(e_, starts) / n
    for q in (50, 90, 95, 99):
        res = {}
        for sign in (1, -1):
            dp = sign * float(np.percentile(np.abs(gaps["pass"]), q))
            dr = sign * float(np.percentile(np.abs(gaps["rush"]), q))
            _, prob = lib.tilt(dr, dp)
            mean = np.add.reduceat(prob * e_, starts)
            target = base + np.where(lib._kind_of_pool() == L.KIND_PASS, dp, dr)
            ok = np.abs(mean - target) <= 0.02
            res["up" if sign > 0 else "down"] = round(float(ok.mean()), 4)
            res["gap_pass"], res["gap_rush"] = round(abs(dp), 4), round(abs(dr), 4)
        out[f"p{q}"] = res
    return out


# -------------------------------------------------------------------- build ---
def build(e: pd.DataFrame | None = None, log=print, workers: int = 4) -> tuple[Bundle, dict]:
    e = D.load(K.SEASONS) if e is None else e
    rep = {"clock": D.clock_report(e)}
    log(f"clock: {rep['clock']['excluded_share_fbs']:.1%} of FBS games excluded; OOB rate {rep['clock']['oob']['rate']:.1%}")
    log("fitting win-probability model ...")
    wp, rep["wp"] = fit_wp(e, log)
    log("fitting field-goal model ...")
    fg, taper, fg_max, rep["fg"] = fit_fg(e)
    kickoffs, rep["kickoffs"] = kickoff_samples(e)
    punts, rep["punts"] = punt_samples(e)
    tempo, rep["tempo"] = tempo_samples(e)
    c, rep["consts"] = consts(e, fg, taper, fg_max, kickoffs, rep["clock"])
    log("play library ...")
    g = fbs(e, good=True)
    lib = L.PlayLibrary(L.build_library(g, seasons=K.LIB_SEASONS))
    rep["library"] = {"rows": int(len(lib.lib)), "pools": int(lib.n_pools),
                      "oob_rate": round(float(lib.lib.loc[~lib.lib["penalty"], "oob"].mean()), 4),
                      "mean_epa": {str(k): round(v, 4) for k, v in lib.mean_epa.items()}}
    log("as-of team ratings ...")
    tr = team_ratings(e, K.RATING_SEASONS, workers=workers)
    log("kicker / punter ratings ...")
    kick = e[(e["home_div"] == "fbs") | (e["away_div"] == "fbs")]
    kr = R.kicker_ratings(kick, fg, K.RATING_SEASONS)
    pr = R.punter_ratings(kick, K.RATING_SEASONS)
    rep["tilt"] = tilt_check(lib, tr)
    bundle = Bundle(wp=wp, fg_model=fg, lib=lib, punts=punts, kickoffs=kickoffs, tempo=tempo, team_ratings=tr,
                    kicker_ratings=kr, punter_ratings=pr, consts=c)
    return bundle, rep
