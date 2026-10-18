"""NFL golden: the Python simulator's results under NFL rules stay bit for bit what they were on a base commit.

Capture once on the base (generated, never committed), then the test compares after any change:
    python tests/test_rules_golden.py capture       # -> artifacts/golden_py.pkl
    python -m pytest -q tests/test_rules_golden.py
Every rollout's value and end state, production random numbers (sim.py's own), from random roots x every root action,
for a neutral context, the live game's context and its coach-mode 4th downs.
"""
import pickle
import sys

import numpy as np
import pytest

from nflclock import config

GOLDEN = config.ARTIFACT_DIR / "golden_py.pkl"
ACTS = [{}, {"to_def": True}, {"to_off": True}, {"tempo": "urgent", "to_off": False}, {"play": "spike"}, {"play": "go"},
        {"play": "fg"}, {"play": "punt"}, {"play": "kneel"}, {"play": "run"}, {"play": "pass"}, {"runoff": 20.0},
        {"h1": "attack"}, {"h1": "runout"}, {"tempo": "milk"}, {"tempo": "hurry", "to_def": True}]


def _cases(k=300, seed=2026):
    rng = np.random.default_rng(seed)
    out = []
    for i in range(k):
        late = i % 3 == 0
        if late:   # late and close: first downs inside 2:00, the last seconds, tries and kickoffs
            t = float((1800.0 if rng.random() < 0.3 else 0.0) + rng.choice([rng.uniform(0, 130), rng.uniform(0, 12), rng.uniform(115, 130)]))
        else:
            t = float(rng.choice([rng.uniform(1, 200), rng.uniform(1, 900)])) if rng.random() < 0.75 else 1800 + float(rng.uniform(1, 200))
        phase = int(rng.choice([0] * 8 + [1, 2]))
        yl = float(rng.integers(1, 100))
        a = int(rng.integers(0, 35))
        root = dict(t=round(t, 1), pos=int(rng.integers(0, 2)), score=(max(a + int(rng.integers(-10, 11)), 0), a),
                    down=int(rng.integers(1, 5)), ytg=float(min(yl, rng.integers(1, 16))), yl=yl,
                    to=(int(rng.integers(0, 4)), int(rng.integers(0, 4))), clock_running=bool(rng.random() < 0.6), phase=phase)
        acts = [{"pat": "xp"}, {"pat": "two"}, {}] if phase == 1 else [{}, {"kick": "onside"}, {"kick": "deep"}] if phase == 2 else ACTS
        for j, act in enumerate(acts):
            out.append({"k": f"{i}.{j}", "ctx": ["neutral", "live", "coach"][i % 3], "root": root, "action": act,
                        "perspective": (i + j) % 2, "n": 64, "seed": 3 + i})
    return out


def _sims():
    from nflclock import live
    from nflclock.models import Bundle
    from nflclock.sim import GameContext, Simulator
    b = Bundle.load()
    rec = live.load_game("2026_05_BUF_LA")
    ctx_live, _, _ = live.context_from_game(b, rec, receive_2h=rec["home"]["team"])
    ctx_coach, _, _ = live.context_from_game(b, rec, receive_2h=rec["home"]["team"], coach_mode={"BUF": "coach", "LA": "typical"})
    return {"neutral": Simulator(b, GameContext()), "live": Simulator(b, ctx_live), "coach": Simulator(b, ctx_coach)}


def _run(sims, c):
    from nflclock.sim import RootState
    r = c["root"]
    root = RootState(t=r["t"], pos=r["pos"], score=tuple(r["score"]), down=r["down"], ytg=r["ytg"], yl=r["yl"],
                     to=tuple(r["to"]), clock_running=r["clock_running"], phase=r["phase"])
    v, S = sims[c["ctx"]].run(root, n=c["n"], action=dict(c["action"]), perspective=c["perspective"], seed=c["seed"], return_state=True)
    return {"v": v, "t": S.t.copy(), "score": S.score.copy(), "phase": S.phase.copy(), "pos": S.pos.copy(), "yl": S.yl.copy()}


def capture():
    sims, cases = _sims(), _cases()
    out = {c["k"]: _run(sims, c) for c in cases}
    config.ARTIFACT_DIR.mkdir(exist_ok=True)
    with open(GOLDEN, "wb") as f:
        pickle.dump({"cases": cases, "res": out}, f)
    print(f"captured {len(cases)} runs -> {GOLDEN}")


@pytest.mark.skipif(not GOLDEN.exists(), reason="capture on the base first: python tests/test_rules_golden.py capture")
def test_nfl_golden_bitwise():
    with open(GOLDEN, "rb") as f:
        base = pickle.load(f)
    sims = _sims()
    bad = []
    for c in base["cases"]:
        got, want = _run(sims, c), base["res"][c["k"]]
        if not all(np.array_equal(got[k], want[k]) for k in want):
            bad.append(c["k"])
    assert not bad, f"{len(bad)} of {len(base['cases'])} golden runs changed: {bad[:10]}"


if __name__ == "__main__" and sys.argv[1:] == ["capture"]:
    capture()
