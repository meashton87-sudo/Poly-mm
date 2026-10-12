import numpy as np

from nflclock.playbook import CALLS, EVENTS, strong_side


def test_strong_side_is_the_wide_side_of_the_field():
    # offense's view: from the left hash the right side is wide (strong); from the right hash the left side is
    d = np.array(["left", "right", "left", "right"], dtype=object)
    h = np.array(["L", "L", "R", "R"], dtype=object)
    assert strong_side(d, h, np.random.default_rng(0)).tolist() == [False, True, True, False]
    # middle of the field or not charted: either side, about half the time
    mid = strong_side(np.array(["left"] * 2000, dtype=object), np.array(["M"] * 2000, dtype=object),
                      np.random.default_rng(1))
    assert 0.45 < mid.mean() < 0.55


def test_every_call_has_a_label_kind_and_narration():
    assert len({c[0] for c in CALLS}) == len(CALLS)
    assert all(kind in ("run", "pass") and label and say for _, label, kind, say in CALLS)
    assert EVENTS[0] == "" and len(set(EVENTS)) == len(EVENTS) and len(EVENTS) < 256
