"""Exact parity: drive the Python simulator with the browser engine's counter RNG and its 0.1 s rounding of
durations, so every rollout must match web/engine.js exactly (checked by web/parity_exact_test.js).

    python scripts/parity_exact.py [cases] [rollouts] [coach] [seed] [--rules NAME] [--level nfl|fbs]
    node web/parity_exact_test.js [NAME] [--level fbs]

--rules plays another rulebook (src/nflclock/rules.py: ncaa2026, nfhs, nfhs:PA, ...) on the same data, with roots
where the rules differ (first downs inside 2:00, sideline throws, kickoffs, long field goals, tries at 0:00, fouls in
the last seconds and the last minute, blowouts for a running clock) added after the usual ones; --level fbs plays the
college data (artifacts/bundle_cfb.pkl, web/engine_data_cfb.json). NFL rules on NFL data write
artifacts/parity_exact.json, anything else artifacts/parity_exact_<rules>[_<level>].json.
"""
import json, sys, subprocess
import numpy as np
from nflclock import config, live
from nflclock.models import Bundle
from nflclock.rules import rules_of
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

def build(coach=None, rules="nfl", level="nfl"):
    b = Bundle.load(None if level == "nfl" else config.ARTIFACT_DIR / f"bundle_{'cfb' if level == 'fbs' else level}.pkl")
    # the synced game (artifacts/live), else the same record the browser test reads (web/, committed: CI has no sync)
    lp = live.LIVE_OUT / "2026_05_BUF_LA.json"
    rec = live.load_game("2026_05_BUF_LA") if lp.exists() else json.load(open(config.ROOT / "web" / "2026_05_BUF_LA.json"))
    kw = {"coach_mode": coach} if coach else {}
    ctx, _, _ = live.context_from_game(b, rec, receive_2h=rec["home"]["team"], rules=rules, **kw)
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

def rules_roots(k, rng, R):
    """Roots where the rulebooks part ways, in this ruleset's own clock (quarters of R['quarter'] seconds)."""
    out, H = [], 2 * R["quarter"]
    rc = R.get("runClock")
    for i in range(k):
        kind = i % 8
        h1 = rng.random() < 0.3
        th = [rng.uniform(5, 130), rng.uniform(1, 60), rng.uniform(1, 400), rng.uniform(5, 300), rng.uniform(0, 3),
              rng.uniform(0.5, 7), rng.uniform(1, 75), rng.uniform(1, H)][kind]
        t = round((H if h1 else 0) + th, 1)
        a = int(rng.integers(7, 35)); m = int(rng.integers(-8, 9))
        if kind == 7 and rc:
            m = int(rng.choice([-1, 1]) * rng.integers(rc["margin"] - 3, rc["margin"] + 12))
        h = max(a + m, 0)
        yl = float(rng.integers(1, 100)); down = int(rng.integers(1, 4)); ytg = float(min(yl, rng.integers(1, 4)))
        phase = SNAP
        act = [{}, {"play": "pass"}, {}, {}, {}, {"play": ["run", "pass"][i % 2]}, {}, {}][kind]
        if kind == 1:                            # a sideline throw: behind, no timeouts, the clock running
            m = -int(rng.integers(1, 9)); h = max(a + m, 0)
        if kind == 2:                            # a kickoff, every kind, ahead or behind (anyone may kick onside in college)
            phase = KICKOFF; act = [{}, {"kick": "onside"}, {"kick": "deep"}][i % 3]
        if kind == 3:                            # a long field goal (a miss: where the ball goes)
            yl = float(rng.integers(20, 50)); down = 4; act = {"play": "fg"}
        if kind == 4:                            # a try at (or near) 0:00, every margin a try can matter at
            phase = PAT; t = round((H if h1 else 0) + th, 1); act = {"pat": ["xp", "two"][i % 2]}
            m = int(rng.integers(-3, 4)); h = max(a + m, 0)
        if kind == 6:                            # the last minute: hurry, timeouts, fouls before the snap
            act = [{}, {"tempo": "hurry"}, {"to_off": False}, {"play": "run"}][i % 4]
        root = dict(t=t, pos=int(rng.integers(0, 2)), score=[h, a] if rng.random() < 0.5 else [a, h], down=down, ytg=ytg, yl=yl,
                    to=[0, 0] if kind == 1 else [int(rng.integers(0, 4)), int(rng.integers(0, 4))],
                    clock_running=bool(kind in (0, 1, 6) or rng.random() < 0.5), phase=phase)
        if kind == 1:
            root["score"] = [h, a] if root["pos"] == 0 else [a, h]
        if rc and rng.random() < 0.3:
            root["running_clock"] = True
        out.append({"root": root, "action": act, "perspective": int(rng.integers(0, 2))})
    return out

if __name__ == "__main__":
    args, rules, level = [], "nfl", "nfl"
    it = iter(sys.argv[1:])
    for x in it:
        if x == "--rules": rules = next(it)
        elif x == "--level": level = next(it)
        else: args.append(x)
    k = int(args[0]) if len(args) > 0 else 300; n = int(args[1]) if len(args) > 1 else 200
    coach = args[2] if len(args) > 2 and args[2] != "-" else ""
    cm = {"BUF": "coach", "LA": "typical"} if coach else None
    sim, rec = build(cm, rules, level)
    rng = np.random.default_rng(int(args[3]) if len(args) > 3 else 1)
    cases = rand_roots(k, rng)
    if rules != "nfl" or level != "nfl":
        cases += rules_roots(k, rng, rules_of(rules))
    for c in cases:
        r = c["root"]
        root = RootState(t=r["t"], pos=r["pos"], score=tuple(r["score"]), down=r["down"], ytg=r["ytg"], yl=r["yl"],
                         to=tuple(r["to"]), clock_running=r["clock_running"], phase=r["phase"],
                         running_clock=bool(r.get("running_clock")))
        v = sim.run(root, n=n, action=c["action"], perspective=c["perspective"], seed=5)
        c["py"] = v.tolist()
    config.ARTIFACT_DIR.mkdir(exist_ok=True)
    tag = "" if rules == "nfl" and level == "nfl" else f"_{rules.replace(':', '-')}" + ("" if level == "nfl" else f"_{level}")
    json.dump({"cases": cases, "n": n, "coach": cm, "r2h": rec["home"]["team"], "rules": rules, "level": level},
              open(config.ARTIFACT_DIR / f"parity_exact{tag}.json", "w"))
    print("wrote", len(cases), f"parity_exact{tag}.json")
