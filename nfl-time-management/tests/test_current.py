import pandas as pd

from nflclock.archetypes import assign, describe
from nflclock.current import _fix_ids, _line, _promote
from nflclock.overall import scale, specialist_ovr


def test_overall_scale_runs_40_to_99_and_bends_at_the_top():
    assert list(scale([77, 86, 30, 200])) == [77, 86, 40, 99]
    top = scale([88, 95, 105, 115])
    assert top[0] == 88 and all(b > a for a, b in zip(top, top[1:])) and top[-1] <= 99     # the best stay apart
    assert specialist_ovr(0.5) == 77 and specialist_ovr(0.99) >= 95 and specialist_ovr(0.01) < 60


def test_quarterback_types_follow_rushing_and_depth_of_throw():
    assert assign("QB", {"rush_ypg": 53.0, "adot": 8.0}, 74, 210) == "Scrambler"
    assert assign("QB", {"rush_ypg": 24.0, "adot": 7.7}, 74, 225) == "Improviser"
    assert assign("QB", {"rush_ypg": 3.0, "adot": 9.3}, 75, 220) == "Strong Arm"
    assert assign("QB", {"rush_ypg": 3.0, "adot": 7.0}, 76, 220) == "Field General"
    assert describe("QB", "Improviser")["kind"] == "Mobile QB"
    assert describe("QB", "Field General")["kind"] == "Pocket passer"


def test_tight_end_types_follow_targets_per_snap():
    blocker = {"off_snaps": 600, "targets": 30, "adot_tgt": 5.0}
    seam = {"off_snaps": 600, "targets": 100, "adot_tgt": 8.0}
    short = {"off_snaps": 600, "targets": 100, "adot_tgt": 5.5}
    assert [assign("TE", m, 78, 255) for m in (blocker, seam, short)] == ["Blocking", "Vertical Threat", "Possession"]
    assert assign("TE", {"off_snaps": 40, "targets": 5}, 78, 255) is None      # too little to say


def test_slot_corner_and_linemen():
    assert assign("CB", {"def_snaps": 600, "def_targets": 60}, 70, 185, slot=True) == "Slot"
    assert assign("LT", {}, 78, 320) is None and describe("LT", None) == {}


def test_promote_puts_the_pick_first_and_adds_missing_players():
    dc = pd.DataFrame({"team": ["NYG"] * 2, "dt": ["2026-10-12"] * 2, "gsis_id": ["a", "b"], "pos_abb": ["QB", "QB"],
                       "pos_rank": [1, 2], "player_name": ["Backup", "Starter"], "pos_grp": ["Offense"] * 2})
    out = _promote(dc, {"QB": "b", "PK": "k"}, {"k": "Kicker"})
    assert out.sort_values("pos_rank").iloc[0]["gsis_id"] == "b"
    added = out[out["gsis_id"] == "k"].iloc[0]
    assert (added["pos_abb"], added["pos_rank"], added["player_name"], added["team"]) == ("PK", 0, "Kicker", "NYG")


def test_depth_chart_ids_pointing_at_a_namesake_are_matched_by_name_on_the_roster():
    rows = pd.DataFrame({"team": ["DET", "DET", "MIA", "MIA"], "gsis_id": ["new", "x", "j1", "j2"],
                         "full_name": ["Blake Miller", "Penei Sewell", "Jordan Phillips", "Jordan Phillips"]})
    dc = pd.DataFrame({"team": ["DET", "DET", "MIA", "DET"], "gsis_id": ["old", "x", "vet", None],
                       "player_name": ["Blake Miller", "Penei Sewell", "Jordan Phillips", "Nobody"]})
    out = _fix_ids(dc, rows)["gsis_id"].tolist()
    assert out[:3] == ["new", "x", "vet"] and pd.isna(out[3])      # two namesakes on the roster: left alone


def test_line_has_one_man_per_slot_when_a_hurt_starter_and_his_fill_in_both_rate_high():
    ol = pd.DataFrame({"pos": ["T", "C", "T", "T", "G", "G"], "sc": [1.3, 1.29, 1.28, 1.16, 1.10, 1.09]},
                      index=["lt", "c", "rt_hurt", "rt_fill", "rg", "lg"])
    dc = pd.DataFrame({"gsis_id": ["lt", "c", "rt_fill", "rt_hurt", "rg", "lg"], "pos_abb": ["LT", "C", "RT", "RT", "RG", "LG"],
                       "pos_rank": [1, 1, 1, 3, 1, 1]})
    since = pd.DataFrame({"gsis_id": ["rt_hurt"], "pos_abb": ["RT"], "pos_rank": [1]})
    assert _line(ol, dc, since) == [("lt", "LT"), ("lg", "LG"), ("c", "C"), ("rg", "RG"), ("rt_hurt", "RT")]
    healthy = ol.drop(index="rt_hurt")                                  # no clash: the five best, at their slots
    assert _line(healthy, dc, since) == [("lt", "LT"), ("lg", "LG"), ("c", "C"), ("rg", "RG"), ("rt_fill", "RT")]
