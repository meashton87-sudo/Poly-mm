"""Write web/parity_expected.json: Python reference values the JS engine must reproduce."""
import json
import sys

import numpy as np

from nflclock import live, wp as wpmod
from nflclock.models import Bundle
from nflclock.sim import KICKOFF, PAT, SNAP, RootState, Simulator

GAME = sys.argv[1] if len(sys.argv) > 1 else "2026_05_BUF_LA"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20000

SCENARIOS = [
    ("trail4_2min_own25_3TO", dict(t=120, pos=1, score=(21, 17), down=1, ytg=10, yl=75, to=(3, 3)), {}, 1),
    ("lead3_def_TO_now", dict(t=150, pos=0, score=(20, 17), down=2, ytg=6, yl=60, to=(3, 3), clock_running=True), {"to_def": True}, 1),
    ("lead3_def_no_TO", dict(t=150, pos=0, score=(20, 17), down=2, ytg=6, yl=60, to=(3, 3), clock_running=True), {"to_def": False}, 1),
    ("4th3_opp38_trail3_go", dict(t=72, pos=1, score=(27, 24), down=4, ytg=3, yl=38, to=(1, 0)), {"play": "go"}, 1),
    ("4th3_opp38_trail3_fg", dict(t=72, pos=1, score=(27, 24), down=4, ytg=3, yl=38, to=(1, 0)), {"play": "fg"}, 1),
    ("tied_opp30_0_30", dict(t=30, pos=0, score=(17, 17), down=1, ytg=10, yl=30, to=(1, 1)), {}, 0),
    ("h1_1min_own25_attack", dict(t=1860, pos=0, score=(7, 7), down=1, ytg=10, yl=75, to=(2, 2)), {"h1": "attack"}, 0),
    ("h1_1min_own25_runout", dict(t=1860, pos=0, score=(7, 7), down=1, ytg=10, yl=75, to=(2, 2)), {"h1": "runout"}, 0),
    ("trail3_10min", dict(t=600, pos=1, score=(20, 17), down=1, ytg=10, yl=75, to=(3, 3)), {}, 1),
    ("pat_two_down2", dict(t=300, pos=1, score=(24, 22), to=(2, 2), phase=PAT), {"pat": "two"}, 1),
    ("pat_xp_down2", dict(t=300, pos=1, score=(24, 22), to=(2, 2), phase=PAT), {"pat": "xp"}, 1),
    ("onside_trail3_1min", dict(t=70, pos=1, score=(24, 21), to=(3, 1), phase=KICKOFF), {"kick": "onside"}, 1),
    ("deep_trail3_1min", dict(t=70, pos=1, score=(24, 21), to=(3, 1), phase=KICKOFF), {"kick": "deep"}, 1),
    ("spike_trail2_40s", dict(t=40, pos=1, score=(20, 18), down=1, ytg=10, yl=36, to=(2, 0), clock_running=True), {"play": "spike"}, 1),
    ("hurry_trail2_40s", dict(t=40, pos=1, score=(20, 18), down=1, ytg=10, yl=36, to=(2, 0), clock_running=True), {"tempo": "urgent", "to_off": False}, 1),
    ("lead7_kneel_check", dict(t=95, pos=0, score=(24, 17), down=1, ytg=10, yl=60, to=(3, 1)), {}, 0),
    ("q3_midfield_tied", dict(t=1500, pos=0, score=(14, 14), down=1, ytg=10, yl=50, to=(3, 3)), {}, 0),
    ("burn_up2_4th9_0_06_go", dict(t=6, pos=0, score=(19, 17), down=4, ytg=9, yl=73, to=(0, 0)), {"play": "go"}, 0),
    ("fire_drill_down2_4th_running", dict(t=16, pos=1, score=(20, 18), down=4, ytg=2, yl=20, to=(2, 0), clock_running=True), {}, 1),
    ("COACH q3_midfield_tied", dict(t=1500, pos=0, score=(14, 14), down=1, ytg=10, yl=50, to=(3, 3)), {}, 0),
    ("COACH 4th2_own45_q3", dict(t=1300, pos=1, score=(17, 14), down=4, ytg=2, yl=55, to=(3, 3)), {}, 1),
    ("COACH trail3_10min", dict(t=600, pos=1, score=(20, 17), down=1, ytg=10, yl=75, to=(3, 3)), {}, 1),
]
COACH_MODE = {"BUF": "coach", "LA": "typical"}

if __name__ == "__main__":
    b = Bundle.load()
    rec = live.load_game(GAME)
    ctx, home, away = live.context_from_game(b, rec, receive_2h=rec["home"]["team"])
    sim = Simulator(b, ctx)
    ctx_c, _, _ = live.context_from_game(b, rec, receive_2h=rec["home"]["team"], coach_mode=COACH_MODE)
    sim_c = Simulator(b, ctx_c)
    rng = np.random.default_rng(0)
    # WP model rows
    m = rng.integers(-21, 22, 300)
    t = rng.uniform(1, 3600, 300)
    rows = wpmod.make_features(m, t, rng.integers(1, 5, 300), rng.integers(1, 20, 300), rng.integers(1, 99, 300),
                               rng.integers(0, 4, 300), rng.integers(0, 4, 300), rng.uniform(-10, 10, 300),
                               rng.integers(0, 2, 300), rng.integers(0, 2, 300))
    wp_pred = b.wp.predict_X(rows)
    fg = {str(dd): float(sim.fg_prob(np.array([float(dd)]), np.array([0]))[0]) for dd in range(18, 72, 3)}
    scen = []
    for name, r, act, persp in SCENARIOS:
        root = RootState(**r)
        v = (sim_c if name.startswith("COACH") else sim).run(root, n=N, action=act, perspective=persp, seed=11)
        scen.append({"name": name, "root": {**r, "phase": r.get("phase", SNAP)}, "action": act, "perspective": persp,
                     "mean": float(v.mean()), "se": float(v.std() / np.sqrt(N))})
        print(f"{name:28s} {v.mean():.4f} ± {v.std() / np.sqrt(N):.4f}")
    out = {
        "game": GAME, "receive2h": rec["home"]["team"],
        "wp_rows": rows.tolist(), "wp_pred": wp_pred.tolist(), "fg": fg,
        "conv": [sim.conv[0].ravel().tolist(), sim.conv[1].ravel().tolist()],
        "cdf_probe": {str(i): [float(sim.cdf[0][i]), float(sim.cdf[1][i])] for i in range(0, len(sim.cdf[0]), 9973)},
        "delta": ctx.delta.tolist(), "two_pt": ctx.two_pt.tolist(), "ot_wp_home": ctx.ot_wp_home,
        "scenarios": scen, "coach_mode": COACH_MODE,
    }
    with open("web/parity_expected.json", "w") as f:
        json.dump(out, f)
