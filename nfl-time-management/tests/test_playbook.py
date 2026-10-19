import numpy as np
import pandas as pd

from nflclock.playbook import (CALL_INDEX, CALLS, EVENTS, ROUTE_CODE, ROUTES, SHELL_CODE, SHELLS, _charting,
                               look_bucket, oob_odds, oob_route_odds, strong_side)


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


def test_look_buckets_match_the_browser():
    # box count in bits 4-7, blitz in bit 3 (engine.js lookBucket): light 0, light + blitz 1, loaded 2, loaded + blitz 3
    looks = [(6 << 4), (6 << 4) | 8, (7 << 4), (8 << 4) | 8 | 1, 0, 8]
    assert look_bucket(np.array(looks)).tolist() == [0, 1, 2, 3, 255, 255]


def test_ngs_charting_is_packed_for_the_browser():
    # 2022 and 2023-on route labels land on the same codes; a run (nothing charted) is all zeros
    assert ROUTE_CODE["HITCH"] == ROUTE_CODE["HITCH/CURL"] and ROUTE_CODE["IN"] == ROUTE_CODE["IN/DIG"]
    assert max(ROUTE_CODE.values()) < len(ROUTES) and max(SHELL_CODE.values()) < len(SHELLS) < 16
    s = pd.DataFrame({"route": ["SLANT", "", None], "defense_man_zone_type": ["MAN_COVERAGE", "ZONE_COVERAGE", None],
                      "defense_coverage_type": ["COVER_1", "COVER_3", None], "number_of_pass_rushers": [5, 4, None],
                      "was_pressure": [True, False, None], "time_to_throw": [2.34, 3.0, None]})
    c = _charting(s)
    assert ROUTES[c["route"][0]] == "slant" and c["route"][1] == 0 and c["route"][2] == 0
    assert SHELLS[c["cover"][0] & 15] == "cover1" and c["cover"][0] >> 4 == 1 and c["cover"][1] >> 4 == 2
    assert c["rush"][0] == 5 | 16 | 32 and c["rush"][1] == 4 | 32 and c["rush"][2] == 0
    assert c["ttt"].tolist() == [23, 30, 0]


def _oob_lib(rows):
    """Library rows for the out-of-bounds fit: (call, route, motive, n, n out of bounds)."""
    out = []
    for call, route, motive, n, k in rows:
        for i in range(n):
            out.append({"call": CALL_INDEX[call], "ngs_route": ROUTES.index(route), "oob": i < k, "penalty": False,
                        "incomplete": False, "yards": 5.0, "want_oob": motive == "want", "stay_in": motive == "stay",
                        "need_oob": motive == "need"})
    return pd.DataFrame(out)


def test_get_out_of_bounds_odds_follow_the_route():
    # an out goes out of bounds 40% of the time with no motive and 70% needing out; a slant 2% either way (a touch over
    # 1x: shrunk toward its family); a wheel is
    # too thin to fit (its family's odds); a trailing-by-20 snap (want_oob) is neither the motive nor the base
    lib = _oob_lib([("quick_strong", "out", None, 1000, 400), ("quick_strong", "out", "need", 200, 140),
                    ("quick_strong", "slant", None, 1000, 20), ("quick_strong", "slant", "need", 200, 4),
                    ("quick_strong", "wheel", None, 100, 30), ("quick_strong", "wheel", "need", 10, 9),
                    ("quick_strong", "out", "want", 500, 200)])
    fam, by_route = oob_route_odds(lib)
    c = CALL_INDEX["quick_strong"]
    assert np.array_equal(fam, oob_odds(lib))
    assert fam[c] == by_route[c, 0] == by_route[CALL_INDEX["quick_weak"], 0]          # the family's, its calls alike
    out, slant, wheel = (by_route[c, ROUTES.index(r)] for r in ("out", "slant", "wheel"))
    assert 3.0 < out < 3.5 and 1.0 <= slant < 1.1 and wheel == fam[c] and out > fam[c] > 1.0
    assert by_route[CALL_INDEX["deep_strong"]].tolist() == [1.0] * len(ROUTES)         # no plays: no effect
    # staying in bounds: below 1, never under 0.2
    lib = _oob_lib([("quick_strong", "out", None, 1000, 400), ("quick_strong", "out", "stay", 200, 20),
                    ("quick_strong", "hitch", None, 1000, 80), ("quick_strong", "hitch", "stay", 100, 8)])
    fam, by_route = oob_route_odds(lib, "stay_in")
    assert 0.2 <= by_route[c, ROUTES.index("out")] < fam[c] < 0.9 < by_route[c, ROUTES.index("hitch")] <= 1.0
