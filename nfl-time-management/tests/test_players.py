import numpy as np

from nflclock.players import _allocate, _pct, ordinal, passer_rating


def test_personnel_follows_snap_shares():
    # 2.1 edges, 2.6 interior linemen, 1.9 linebackers ... on an average snap -> 2 / 3 / 2 / 2 / 2
    a = _allocate({"EDGE": 2.1, "DL": 2.6, "LB": 1.9, "CB": 2.4, "S": 2.0}, 11,
                  {"EDGE": 3, "DL": 4, "LB": 3, "CB": 4, "S": 3})
    assert a == {"EDGE": 2, "DL": 3, "LB": 2, "CB": 2, "S": 2}
    # never more players from a group than dressed
    b = _allocate({"CB": 5.0, "S": 6.0}, 11, {"CB": 4, "S": 7})
    assert b == {"CB": 4, "S": 7}


def test_passer_rating_bounds_and_percentiles():
    assert abs(passer_rating(10, 10, 200, 3, 0) - 158.33) < 0.01
    assert passer_rating(10, 0, 0, 0, 10) == 0
    pool = np.arange(100)
    assert _pct([50], pool)[0] == 0.505 and _pct([50], pool, higher_better=False)[0] == 0.495
    assert [ordinal(n) for n in (1, 2, 3, 11, 12, 13, 21, 22, 23, 100)] == \
        ["1st", "2nd", "3rd", "11th", "12th", "13th", "21st", "22nd", "23rd", "100th"]
