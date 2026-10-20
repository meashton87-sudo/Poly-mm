"""Pro's historic drives: the overtime of their time, a lineup with the drive's players, the line in its slots."""
from collections import Counter

from nflclock import history as HI
from nflclock import pro


def test_overtime_rules_by_era():
    assert pro.overtime_rules(2001, "SB") == {"rules": "sd", "len": 900}          # Brady's first: sudden death
    assert pro.overtime_rules(2009, "CON") == {"rules": "sd", "len": 900}         # Favre's: the first field goal won it
    assert pro.overtime_rules(2011, "REG") == {"rules": "sd", "len": 900}
    assert pro.overtime_rules(2010, "WC")["rules"] == "msd"                        # the playoffs changed first
    assert pro.overtime_rules(2015, "DIV") == {"rules": "msd", "len": 900}        # Fitzgerald's
    assert pro.overtime_rules(2021, "DIV")["rules"] == "msd"                       # 13 Seconds: Buffalo never got the ball
    assert pro.overtime_rules(2022, "SB")["rules"] == "both"
    assert pro.overtime_rules(2024, "REG") == {"rules": "msd", "len": 600}
    assert pro.overtime_rules(2016, "REG")["len"] == 900
    assert pro.overtime_rules(2025, "REG")["rules"] == "both"


def test_ol_slots_keep_the_depth_charts_slots():
    got = HI._ol_slots([("a", "RT"), ("b", "LG"), ("c", "C"), ("d", "LT"), ("e", "RG")])
    assert got == [("d", "LT"), ("b", "LG"), ("c", "C"), ("e", "RG"), ("a", "RT")]
    # without sides (the participation's T, G, C) as before: centers in the middle, guards inside, tackles outside
    got = HI._ol_slots([("a", "T"), ("b", "G"), ("c", "C"), ("d", "T"), ("e", "G"), ("f", "T")])
    assert [s for _, s in got] == ["LT", "LG", "C", "RG", "RT", "TE"]


def test_drive_lineup_puts_the_drives_players_on_the_field():
    h = HI.History.__new__(HI.History)
    unit = [("qb", "QB"), ("lt", "T"), ("lg", "G"), ("c", "C"), ("rg", "G"), ("rt", "T"),
            ("wr1", "WR"), ("wr2", "WR"), ("te", "TE"), ("rb", "RB"), ("fb", "FB")]
    pos = {"wr3": "WR", "wr4": "WR", "rb2": "RB", "wr1": "WR", "rb": "RB", "qb": "QB"}
    touch = Counter({"qb": 9, "wr3": 3, "wr1": 2, "wr4": 1, "rb2": 4, "rb": 1})
    group = lambda i, p: "FB" if p == "FB" else HI.OFF_POS.get(p)      # noqa: E731
    new, moved, left = h._drive_lineup(unit, "off", touch, lambda i: (0, 0, 0), group, set(touch), pos)
    on = {i for i, _ in new}
    assert {"wr3", "wr4", "rb2", "wr1"} <= on and len(new) == 11
    # the ones who did not touch it make way first (the fullback for the second back, the tight end for a receiver)
    assert {i for i, _ in moved} == {"wr2", "te", "fb"} and "rb" in on and not left
    # every place taken by someone who touched it: the one who touched it least makes way for one who did more
    touch["wr5"], pos["wr5"] = 5, "WR"
    new, moved, left = h._drive_lineup(new, "off", touch, lambda i: (0, 0, 0), group, set(touch), pos)
    on = {i for i, _ in new}
    assert "wr5" in on and "wr4" not in on and ("wr4", "WR") in left and len(new) == 11
