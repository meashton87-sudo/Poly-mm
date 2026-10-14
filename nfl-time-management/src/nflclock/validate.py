"""Out-of-sample validation of the simulator against what actually happened.

1. Late-game calibration: start the simulator from real 4th-quarter snaps and
   score its win probability against real results (vs. our WP model and the
   public nflfastR model on the same snaps).
2. Drive replay: start the simulator from real drive starts in clock-critical
   situations and compare touchdown / field-goal rates and clock usage.
"""
from __future__ import annotations

import multiprocessing as mp

import numpy as np
import pandas as pd

from . import wp as wpmod
from .context import GameContextFactory
from .models import Bundle
from .sim import RootState, Simulator

_G = {}


def root_from_snap(row, home_team) -> RootState:
    home_off = row["posteam"] == home_team
    pos = 0 if home_off else 1
    if home_off:
        to = (row["posteam_timeouts_remaining"], row["defteam_timeouts_remaining"])
        score = (row["posteam_score"], row["defteam_score"])
    else:
        to = (row["defteam_timeouts_remaining"], row["posteam_timeouts_remaining"])
        score = (row["defteam_score"], row["posteam_score"])
    return RootState(t=float(row["game_seconds_remaining"]), pos=pos, score=tuple(int(x) for x in score),
                     down=int(row["down"]), ytg=float(row["ydstogo"]), yl=float(row["yardline_100"]),
                     to=tuple(int(x) for x in to), clock_running=False)


def _init(pbp_games):
    _G["bundle"] = Bundle.load()
    _G["factory"] = GameContextFactory(_G["bundle"], pbp_games)


def _sim_game(args):
    game_id, rows, n, drive_only = args
    ctx, _, _ = _G["factory"].for_game(game_id)
    sim = Simulator(_G["bundle"], ctx)
    out = []
    for r in rows:
        root = root_from_snap(r, ctx.home)
        if drive_only:
            S = sim.run(root, n=n, seed=int(r["play_id"]), drive_only=True)
            o = root.pos
            pts = S.score[:, o] - root.score[o]
            out.append({"play_id": r["play_id"], "game_id": game_id, "sim_td": float(np.mean(pts >= 6)),
                        "sim_fg": float(np.mean(pts == 3)), "sim_time": float(np.mean(root.t - S.t)),
                        "sim_plays": float(np.mean(S.plays))})
        else:
            v = sim.run(root, n=n, perspective=0, seed=int(r["play_id"]))
            out.append({"play_id": r["play_id"], "game_id": game_id, "sim_wp_home": float(v.mean())})
    return out


def _run(pbp, states, n, drive_only, workers):
    tasks = [(gid, g.to_dict("records"), n, drive_only) for gid, g in states.groupby("game_id")]
    games = pbp[pbp["game_id"].isin(states["game_id"].unique())]
    with mp.get_context("fork").Pool(workers, initializer=_init, initargs=(games,)) as pool:
        res = pool.map(_sim_game, tasks, chunksize=2)
    return pd.DataFrame([x for r in res for x in r])


def late_game_calibration(pbp, seasons, n_states=3000, n_sims=600, workers=4, seed=0):
    s = pbp[pbp["is_snap"] & pbp["season"].isin(seasons) & (pbp["qtr"] == 4)
            & (pbp["game_seconds_remaining"] <= 600) & pbp["down"].notna() & pbp["result"].notna()
            & pbp["posteam_timeouts_remaining"].notna()]
    s = s.sample(min(n_states, len(s)), random_state=seed)
    sim = _run(pbp, s, n_sims, False, workers)
    df = s.merge(sim, on=["game_id", "play_id"])
    y_home = np.where(df["result"] > 0, 1.0, np.where(df["result"] < 0, 0.0, 0.5))
    df["y_home"] = y_home
    bundle = Bundle.load()
    fr = wpmod.training_frame(df)
    p_off = bundle.wp.predict_X(wpmod.frame_features(fr))
    home_off = (fr["posteam"] == fr["home_team"]).to_numpy()
    df["model_wp_home"] = np.where(home_off, p_off, 1 - p_off)
    df["nflfastr_wp_home"] = np.where(home_off, df["vegas_wp"], 1 - df["vegas_wp"])
    keep = df["y_home"] != 0.5
    out = {}
    for col in ("sim_wp_home", "model_wp_home", "nflfastr_wp_home"):
        m = keep & df[col].notna()
        out[col] = wpmod.evaluate(df.loc[m, col].to_numpy(), df.loc[m, "y_home"].to_numpy())
    return df, out


def drive_replay(pbp, seasons, n_sims=800, workers=4, max_drives=1500, seed=0):
    s = pbp[pbp["is_snap"] & pbp["season"].isin(seasons) & pbp["down"].notna()
            & pbp["posteam_timeouts_remaining"].notna()]
    first = s.groupby(["game_id", "fixed_drive"]).head(1)
    last = s.groupby(["game_id", "fixed_drive"]).tail(1).set_index(["game_id", "fixed_drive"])
    first = first.join(last[["game_seconds_remaining"]].rename(columns={"game_seconds_remaining": "t_last"}),
                       on=["game_id", "fixed_drive"])
    nplays = s.groupby(["game_id", "fixed_drive"]).size().rename("real_plays")
    first = first.join(nplays, on=["game_id", "fixed_drive"])
    hs = first["half_seconds_remaining"]
    cats = {
        "end_of_1st_half": (first["qtr"] == 2) & (hs <= 120) & (hs >= 20),
        "trailing_4q_final5": (first["qtr"] == 4) & (hs <= 300) & (first["margin"].between(-8, -1)),
        "leading_4q_final6": (first["qtr"] == 4) & (hs <= 360) & (first["margin"].between(1, 8)),
    }
    out_rows, frames = [], []
    for name, m in cats.items():
        st = first[m]
        st = st.sample(min(max_drives, len(st)), random_state=seed)
        sim = _run(pbp, st, n_sims, True, workers)
        d = st.merge(sim, on=["game_id", "play_id"])
        d["category"] = name
        d["real_td"] = (d["fixed_drive_result"] == "Touchdown").astype(float)
        d["real_fg"] = (d["fixed_drive_result"] == "Field goal").astype(float)
        d["real_time"] = d["game_seconds_remaining"] - d["t_last"]
        frames.append(d)
        out_rows.append({
            "category": name, "drives": len(d),
            "real_td": d["real_td"].mean(), "sim_td": d["sim_td"].mean(),
            "real_fg": d["real_fg"].mean(), "sim_fg": d["sim_fg"].mean(),
            "real_plays": d["real_plays"].mean(), "sim_plays": d["sim_plays"].mean(),
        })
    return pd.concat(frames, ignore_index=True), pd.DataFrame(out_rows)
