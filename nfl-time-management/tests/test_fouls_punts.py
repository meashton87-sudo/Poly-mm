"""Rules from player reports: which fouls are an automatic first down, and how a punt ended (the end zone)."""
import numpy as np
import pandas as pd

from nflclock.library import auto_first_down
from nflclock.models import PUNT_HOW, punt_how


def _fouls(rows):
    """Accepted fouls as nflverse has them: (type, on the defense, yards, distance to go, first_down_penalty)."""
    return pd.DataFrame([{"penalty_type": t, "penalty_team": "DEF" if on_d else "OFF", "posteam": "OFF", "defteam": "DEF",
                          "penalty_yards": y, "ydstogo": togo, "first_down_penalty": fd} for t, on_d, y, togo, fd in rows])


def test_only_the_rulebook_fouls_are_an_automatic_first_down():
    s = _fouls([
        # 5-yard fouls: a first down only when the yardage reaches the line to gain (nflverse marks those)
        ("Defensive Offside", True, 5, 2, 1), ("Defensive Offside", True, 5, 10, 0), ("Defensive Offside", True, 5, 7, 0),
        ("Neutral Zone Infraction", True, 5, 4, 1), ("Neutral Zone Infraction", True, 5, 10, 0),
        ("Encroachment", True, 5, 15, 0), ("Encroachment", True, 5, 3, 1),
        # automatic: a first down whatever the distance
        ("Defensive Holding", True, 5, 9, 1), ("Defensive Holding", True, 5, 20, 1), ("Defensive Holding", True, 5, 3, 1),
        ("Defensive Pass Interference", True, 12, 15, 1), ("Defensive Pass Interference", True, 30, 10, 1),
        ("Illegal Contact", True, 5, 8, 1),
        # a kind never seen short of the line to gain keeps its own mark
        ("Unnecessary Roughness", True, 15, 3, 1),
        # the offense's fouls are never a first down for it
        ("Offensive Holding", False, 10, 10, 0), ("False Start", False, 5, 10, 0),
    ])
    pen = np.ones(len(s), bool)
    got = auto_first_down(s, pen).tolist()
    assert got == [False, False, False, False, False, False, False,
                   True, True, True, True, True, True, True, False, False]
    # not a foul snap: never
    assert not auto_first_down(s, np.zeros(len(s), bool)).any()


def test_an_offside_drawn_short_of_the_line_to_gain_is_no_first_down():
    # the engines' rule (sim.py / engine.js _scrimmage): fd = yards >= ytg or auto_fd. The offside that got its first
    # down on 3rd and 2 keeps 5 yards and no automatic first down: on 1st and 10 it is 1st and 5, on 3rd and 4 a first
    # down by the yardage; holding stays a first down on 2nd and 20
    s = _fouls([("Defensive Offside", True, 5, 2, 1), ("Defensive Offside", True, 5, 10, 0),
                ("Defensive Holding", True, 5, 9, 1), ("Defensive Holding", True, 5, 12, 1)])
    auto = auto_first_down(s, np.ones(len(s), bool))
    fd = lambda row, ytg: 5 >= ytg or bool(auto[row])
    assert not fd(0, 10) and fd(0, 4) and fd(0, 5)
    assert fd(2, 20) and fd(2, 10)


def test_how_a_punt_ended_and_where_it_came_down():
    pu = pd.DataFrame([
        {"desc": "X punts 45 yards to NYJ 10, Center-Y. Z to NYJ 22 for 12 yards (W).", "touchback": 0, "return_yards": 12,
         "yardline_100": 55, "kick_distance": 45, "net": 33},
        {"desc": "X punts 50 yards to NYJ 8, Center-Y, fair catch by Z.", "touchback": 0, "return_yards": 0,
         "yardline_100": 58, "kick_distance": 50, "net": 50},
        {"desc": "X punts 47 yards to NYJ 3, Center-Y, downed by KC-W.", "touchback": 0, "return_yards": 0,
         "yardline_100": 50, "kick_distance": 47, "net": 47},
        {"desc": "X punts 40 yards to NYJ 6, Center-Y, out of bounds.", "touchback": 0, "return_yards": 0,
         "yardline_100": 46, "kick_distance": 40, "net": 40},
        {"desc": "X punts 52 yards to end zone, Center-Y, Touchback.", "touchback": 1, "return_yards": 0,
         "yardline_100": 52, "kick_distance": 52, "net": 32},
        {"desc": "X punts 51 yards to KC -1, Center-Y. Z ran ob at KC 9 for 10 yards (W).", "touchback": 0, "return_yards": 10,
         "yardline_100": 50, "kick_distance": 51, "net": 41},
        {"desc": "X punts 45 yards to NE 21, Center-Y. Z MUFFS catch, recovered by NE-W at NE 20.", "touchback": 0,
         "return_yards": 0, "yardline_100": 66, "kick_distance": 45, "net": 46},
    ])
    how, land = punt_how(pu)
    assert [PUNT_HOW[h] for h in how] == ["returned", "fair_catch", "downed", "out_of_bounds", "touchback", "returned", "muffed"]
    # where it came down, from the receiving team's goal line: a return's catch, the spot, the end zone (0 or less)
    assert land.tolist() == [10, 8, 3, 6, 0, -1, 21]
