"""Exact parity: drive the Python simulator with the browser engine's counter RNG and its 0.1 s rounding of
durations, so every rollout must match web/engine.js exactly (checked by web/parity_exact_test.js).

    python scripts/parity_exact.py [cases] [rollouts] [coach] [seed] && node web/parity_exact_test.js
"""
import json, sys, subprocess
import numpy as np
from nflclock import config, live
from nflclock.models import Bundle
from nflclock.sim import RootState, Simulator, SNAP, PAT, KICKOFF

M = np.uint64(0xFFFFFFFF)
def lb(x):
    x = x.astype(np.uint64) & M
    x ^= x >> np.uint64(16); x = (x * np.uint64(0x7feb352d)) & M
    x ^= x >> np.uint64(15); x = (x * np.uint64(0x846ca68b)) & M
    x ^= x >> np.uint64(16); return x
def uni(seed, r, step, c):
    h = lb(np.array([(seed ^ 0x632be5ab) & 0xFFFFFFFF], dtype=np.uint64))
    h = lb(h ^ (((r.astype(np.uint64) + np.uint64(1)) * np.uint64(0x9e3779b1)) & M))
    h = lb(h ^ np.uint64(((step * 8 + c + 1) * 0x85ebca77) & 0xFFFFFFFF))
    return (h.astype(np.float64) + 0.5) / 4294967296.0
def uniforms(seed, step, n, k=8):
    r = np.arange(n, dtype=np.uint64)
    return np.column_stack([uni(seed, r, step, c) for c in range(k)])
Simulator._uniforms = staticmethod(uniforms)

def build(coach=None):
    b = Bundle.load(); rec = live.load_game("2026_05_BUF_LA")
    kw = {"coach_mode": coach} if coach else {}
    ctx, _, _ = live.context_from_game(b, rec, receive_2h=rec["home"]["team"], **kw)
    sim = Simulator(b, ctx)
    q = lambda a: np.round(np.asarray(a, float) * 10) / 10
    for k, v in list(sim.tempo.items()):
        sim.tempo[k] = q(b.tempo["spike"]).clip(1, 16) if k == 3 else q(v)
    sim.F = dict(sim.F); sim.F["duration"] = q(sim.F["duration"])
    sim.F["epa"] = sim.F["epa"].astype(np.float32).astype(float)
    return sim, rec

def rand_roots(k, rng):
    out = []
    for i in range(k):
        h2 = rng.random() < 0.75
        t = float(rng.choice([rng.uniform(1, 200), rng.uniform(1, 900)])) if h2 else 1800 + float(rng.uniform(1, 200))
        phase = int(rng.choice([SNAP]*8 + [PAT, KICKOFF]))
        down = int(rng.integers(1, 5)); yl = float(rng.integers(1, 100)); ytg = float(min(yl, rng.integers(1, 16)))
        a, h = int(rng.integers(0, 35)), 0
        h = a + int(rng.integers(-10, 11)); h = max(h, 0)
        root = dict(t=round(t, 1), pos=int(rng.integers(0, 2)), score=[h, a], down=down, ytg=ytg, yl=yl,
                    to=[int(rng.integers(0, 4)), int(rng.integers(0, 4))], clock_running=bool(rng.random() < 0.6), phase=phase)
        acts = [{}, {"to_def": True}, {"to_off": True}, {"tempo": "urgent", "to_off": False}, {"play": "spike"},
                {"play": "go"}, {"play": "fg"}, {"play": "punt"}, {"play": "kneel"}, {"play": "run"}, {"play": "pass"},
                {"runoff": 20.0}, {"h1": "attack"}, {"h1": "runout"}]
        act = acts[int(rng.integers(0, len(acts)))]
        if phase == PAT: act = {"pat": ["xp", "two"][i % 2]}
        if phase == KICKOFF: act = [{}, {"kick": "onside"}, {"kick": "deep"}][i % 3]
        out.append({"root": root, "action": act, "perspective": int(rng.integers(0, 2))})
    return out

if __name__ == "__main__":
    k = int(sys.argv[1]) if len(sys.argv) > 1 else 300; n = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    coach = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else ""
    cm = {"BUF": "coach", "LA": "typical"} if coach else None
    sim, rec = build(cm)
    cases = rand_roots(k, np.random.default_rng(int(sys.argv[4]) if len(sys.argv) > 4 else 1))
    for c in cases:
        r = c["root"]
        root = RootState(t=r["t"], pos=r["pos"], score=tuple(r["score"]), down=r["down"], ytg=r["ytg"], yl=r["yl"],
                         to=tuple(r["to"]), clock_running=r["clock_running"], phase=r["phase"])
        v = sim.run(root, n=n, action=c["action"], perspective=c["perspective"], seed=5)
        c["py"] = v.tolist()
    config.ARTIFACT_DIR.mkdir(exist_ok=True)
    json.dump({"cases": cases, "n": n, "coach": cm, "r2h": rec["home"]["team"]}, open(config.ARTIFACT_DIR / "parity_exact.json", "w"))
    print("wrote", len(cases))
