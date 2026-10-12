"""Pregame game-management card for a specific matchup (the sideline sheet), computed by simulation.

For each team on offense against this opponent, with these kickers and punters:
  * 4th-down calls by field position x distance in three game states
  * a 4th-quarter two-point chart
Saved into the live game file so the browser tool can show it.
"""
from __future__ import annotations

import json
import multiprocessing as mp

import numpy as np

from . import config, live
from .models import Bundle
from .sim import PAT, RootState, Simulator

SPOTS = [80, 70, 60, 50, 40, 35, 30, 25, 20, 15, 10, 5, 2]          # yards to the opponent's goal
DISTANCES = [1, 2, 3, 4, 5, 7, 10]
STATES = {
    "Q2 10:00, tied": dict(t=2400.0, lead=0),
    "Q4 6:00, down 3": dict(t=360.0, lead=-3),
    "Q4 6:00, up 3": dict(t=360.0, lead=3),
}
TWO_PT_TIMES = [720, 480, 300, 120]
TWO_PT_MARGINS = list(range(-15, 9))
_G = {}


def _init(game_id):
    _G["bundle"] = Bundle.load()
    _G["rec"] = live.load_game(game_id)


def _sim():
    if "sim" not in _G:
        rec = _G["rec"]
        ctx, _, _ = live.context_from_game(_G["bundle"], rec, receive_2h=rec["home"]["team"])
        _G["sim"] = Simulator(_G["bundle"], ctx)
    return _G["sim"]


def _fourth_cell(args):
    team, state, yl, ytg, n = args
    sim = _sim()
    st = STATES[state]
    score = [20, 20]
    score[team] += max(st["lead"], 0)
    score[1 - team] += max(-st["lead"], 0)
    ytg = min(ytg, yl)
    root = RootState(t=st["t"], pos=team, score=tuple(score), down=4, ytg=ytg, yl=yl, to=(3, 3))
    opts = {"go": {"play": "go"}}
    if sim.fg_prob(np.array([yl + 17.0]), np.array([team]))[0] >= 0.05:
        opts["fg"] = {"play": "fg"}
    if yl >= 30:
        opts["punt"] = {"play": "punt"}
    vals = {k: sim.run(root, n=n, action=a, perspective=team, seed=1000 + yl * 31 + ytg) for k, a in opts.items()}
    means = {k: float(v.mean()) for k, v in vals.items()}
    best = max(means, key=means.get)
    rest = [m for k, m in means.items() if k != best]
    edge = means[best] - max(rest) if rest else 0.0
    se = 0.0
    if rest:
        second = max((k for k in means if k != best), key=means.get)
        d = vals[best] - vals[second]
        se = float(d.std(ddof=1) / np.sqrt(n))
    return {"team": team, "state": state, "yl": yl, "ytg": ytg, "best": best, "edge": edge, "se": se,
            **{f"wp_{k}": v for k, v in means.items()}}


def _two_cell(args):
    team, t, m, n = args
    sim = _sim()
    score = [20, 20]
    if m >= 0:
        score[team] += m
    else:
        score[1 - team] += -m
    root = RootState(t=t, pos=team, score=tuple(score), to=(2, 2), phase=PAT)
    a = sim.run(root, n=n, action={"pat": "two"}, perspective=team, seed=77 + t + m)
    b = sim.run(root, n=n, action={"pat": "xp"}, perspective=team, seed=77 + t + m)
    d = a - b
    return {"team": team, "t": t, "margin": m, "edge": float(d.mean()), "se": float(d.std(ddof=1) / np.sqrt(n))}


def build(game_id: str, n: int = 1500, workers: int = 4) -> dict:
    rec = live.load_game(game_id)
    fourth_tasks = [(team, state, yl, ytg, n) for team in (0, 1) for state in STATES for yl in SPOTS
                    for ytg in DISTANCES if ytg <= max(yl, 1) or ytg == 1]
    two_tasks = [(team, t, m, 3000) for team in (0, 1) for t in TWO_PT_TIMES for m in TWO_PT_MARGINS]
    with mp.get_context("fork").Pool(workers, initializer=_init, initargs=(game_id,)) as pool:
        fourth = pool.map(_fourth_cell, fourth_tasks, chunksize=4)
        two = pool.map(_two_cell, two_tasks, chunksize=4)
    teams = [rec["home"]["team"], rec["away"]["team"]]
    card = {"teams": teams, "states": list(STATES), "spots": SPOTS, "distances": DISTANCES,
            "fourth": [{**c, "team": teams[c["team"]]} for c in fourth],
            "two_point": [{**c, "team": teams[c["team"]]} for c in two], "sims_per_option": n}
    (config.ARTIFACT_DIR / f"gamecard_{game_id}.json").write_text(json.dumps(card))
    return card
