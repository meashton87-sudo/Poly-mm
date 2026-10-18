"""The NFL -> college overlay (the browser tilt's own steps) and coach.json / drills chunk schemas."""
import base64
import json

import numpy as np
import pandas as pd

from nflclock import library as L
from nflclock.cfb import export as EX
from nflclock.cfb import overlay as OV


def b64(a):
    a = np.ascontiguousarray(a)
    return {"dtype": a.dtype.name, "n": int(a.size), "b64": base64.b64encode(a.tobytes()).decode()}


def fake_playbook(seed=1):
    rng = np.random.default_rng(seed)
    n = 4000
    yards = np.clip(np.round(rng.normal(5, 7, n)), -20, 80).astype(np.int8)
    epa = (yards.astype(float) * 0.06 - 0.25 + rng.normal(0, 0.3, n)).astype(np.float32)
    items = np.arange(n, dtype=np.int32)
    offsets = np.array([0, 2000, 4000], np.int32)          # pool 0: the run call, pool 1: the pass call
    pool_of = np.zeros((2, L.N_FINE), np.int32)
    pool_of[1] = 1
    freq = np.full((L.N_FINE, 2), 0.5, np.float32)
    return {"calls": [{"id": "rb_middle", "kind": "run"}, {"id": "quick_middle", "kind": "pass"}], "n_fine": L.N_FINE,
            "rows": {"yards": b64(yards), "epa": b64(epa)}, "items": b64(items), "offsets": b64(offsets),
            "pool_of": b64(pool_of.ravel()), "pool_shift": b64(np.zeros(2, np.float32)), "freq": b64(freq.ravel())}


def test_overlay_hits_college_mean_yards():
    pools = OV.Pools(fake_playbook())
    nfl = pools.mean_yards(np.zeros(2))
    cfb_mean = np.stack([np.full(L.N_FINE, nfl[0] * 1.15), np.full(L.N_FINE, nfl[1] * 0.9)])
    shift, rep = OV.solve(pools, cfb_mean, np.full((2, L.N_FINE), 500.0), log=lambda *a: None)
    got = pools.mean_yards(shift.astype(float))
    assert np.allclose(got, [nfl[0] * 1.15, nfl[1] * 0.9], atol=0.05)
    assert shift[0] > 0 > shift[1]
    assert rep["plays_in_cells_within_0.3yd"] == 1.0


def test_overlay_theta_matches_library_tilt():
    """pbTilt's Newton steps (vectorised here) equal library.PlayLibrary.tilt's on the same pool."""
    pools = OV.Pools(fake_playbook(3))
    target = pools.base + 0.05
    th = pools.theta(target)
    got = pools.tilted(th, pools.e)
    assert np.all(np.abs(got - target) < 0.005)


def test_coach_json_schema(tmp_path):
    sp = {"id": "401#3", "home": "HOME", "away": "AWAY", "player": "AWAY", "side": "off",
          "start": {"qtr": 4, "clock": 100.0, "score": [3, 7], "pos": "AWAY", "down": 1, "ytg": 10.0, "yl": 70.0,
                    "to": [2, 1], "running": False, "phase": "snap", "receive2h": "HOME"},
          "real": {"season": 2024, "week": 5, "type": "REG", "final": {"home": 7, "away": 10}}}
    d = {"meta": {"id": "401#3", "cat": "two_min_o", "title": "Down 4", "sub": "2024 week 5", "season": 2024, "week": 5,
                  "home": "HOME", "away": "AWAY", "player": "AWAY", "side": "off", "diff": 3, "lev": 0.01, "wp0": 0.3,
                  "classic": False, "tags": ["recent"]},
         "spot": sp, "teams": {"home": {"team": "HOME"}, "away": {"team": "AWAY"}},
         "real": {"coach": None, "story": "x", "actions": [], "result": {"drive": "touchdown", "final": {"home": 7, "away": 10}, "won": True}}}
    teams = pd.DataFrame({"abbreviation": ["HOME", "AWAY"], "mascot": ["Hawks", np.nan]}, index=["Home U", "Away St"])
    tr = pd.DataFrame({"season": [2024], "week": [5], "team": ["Home U"], "mu_pass": [0.1], "mu_rush": [0.0],
                       "home_pass": [0.02], "home_rush": [0.01]})
    rep = EX.write([d], {"tendency": {"features": [], "families": {}}}, teams, tr, "ncaa2026", "nfl-provisional", web=tmp_path)
    c = json.loads((tmp_path / "coach.json").read_text())
    for k in ("version", "built", "rules", "level", "seasons", "calls", "categories", "skills", "drills", "drill_chunk",
              "checkride", "models", "teams", "league", "diff_rules"):
        assert k in c
    assert c["teams"]["AWAY"] == {"name": "Away St", "mascot": None}
    assert set(c["drills"][0]) >= {"id", "i", "cat", "title", "sub", "season", "week", "home", "away", "player", "side",
                                   "diff", "lev", "wp0", "classic", "tags"}
    assert set(c["checkride"]) == {"version", "drills", "seed", "pass"}
    ch = json.loads((tmp_path / "drills" / "c0.json").read_text())
    assert set(ch["0"]) == {"spot", "teams", "real"}
    assert rep["drills"] == 1
    json.loads((tmp_path / "coach.json").read_text(), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
