import pandas as pd

from nflclock.archetypes import assign, describe
from nflclock.current import _promote, pctile


def test_percentiles_shown_from_1st_to_99th():
    assert [pctile(p) for p in (0.0, 0.004, 0.5, 0.996, 1.0)] == [1, 1, 50, 99, 99]


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
