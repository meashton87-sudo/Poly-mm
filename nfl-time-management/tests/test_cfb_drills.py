"""College drills: the category filters, the spot format, the real actions, and the JSON (no NaN anywhere)."""
import json

import numpy as np
import pandas as pd

from nflclock.cfb import data as D
from nflclock.cfb import drills as DR
from nflclock.cfb import hs as HS
from nflclock.dailygame import _nan_paths
from test_cfb_data import game


def enriched():
    e = D.enrich(D.normalize(game()))
    e["clock_bad"] = False
    return e


def teams():
    return pd.DataFrame({"abbreviation": ["HOME", "AWAY"], "mascot": ["Hawks", "Owls"]}, index=["Home U", "Away St"])


def test_categories_match_their_filters():
    c = DR.candidates(enriched())
    two = c[c["category"] == "two_min_o"]
    assert len(two) == 1                         # Away St, down 7, first down with 1:50+ left: one drill a drive
    r = two.iloc[0]
    assert r["qtr"] == 4 and 30 <= r["quarter_seconds_remaining"] <= 150 and -8 <= r["margin"] <= -1 and r["down"] == 1
    d = c[c["category"] == "two_min_d"].iloc[0]
    assert d["player"] == "Home U" and d["side"] == "def"
    assert not (c["category"] == "four_min_o").any()          # nobody led late with the ball
    for cat, rows in c.groupby("category"):
        assert cat in DR.CATEGORIES


def test_two_pt_and_onside_filters():
    c = DR.candidates(enriched())
    # the only touchdown is in the 1st quarter: no try drill, no onside drill
    assert not (c["category"] == "two_pt").any() and not (c["category"] == "onside").any()


def test_spot_record_format_and_actions():
    e = enriched()
    c = DR.candidates(e)
    r = c[c["category"] == "two_min_o"].iloc[0]
    sp = DR.spot_record(r, teams(), {"401": "Away St"}, "ncaa2026")
    st = sp["start"]
    assert sp["player"] == "AWAY" and st["pos"] == "AWAY" and sp["college"] and sp["rules"] == "ncaa2026"
    assert st["score"] == [0, 7] and len(st["to"]) == 2 and st["phase"] == "snap"
    assert set(sp["real"]) >= {"season", "week", "final", "coach"}
    acts, _ = DR.real_actions(e[e["game_id"] == "401"], e.index[e["row_order"] == r["row_order"]][0], "Away St", teams())
    assert acts and acts[0]["kind"] == "play" and {"t", "clock", "q", "kind", "family", "label"} <= set(acts[0])
    rec = DR.team_record(type("B", (), {"team_ratings": pd.DataFrame(columns=["season", "week", "team", "off_pass", "off_rush",
                                                                             "def_pass", "def_rush", "proe"]),
                                        "kicker_ratings": pd.DataFrame(columns=["season", "week", "kicker_player_id", "rating"]),
                                        "punter_ratings": pd.DataFrame(columns=["season", "week", "punter_player_id", "rating"])})(),
                         e[e["game_id"] == "401"], "Home U", 2024, 5, teams())
    assert set(rec) >= {"team", "coach", "base", "qb", "injury_adjustment", "kicker", "punter", "lineup"} and "calls" not in rec
    blob = {"spot": sp, "teams": {"home": rec}, "real": {"actions": acts}}
    assert not _nan_paths(blob)
    json.dumps(blob, allow_nan=False)


def test_grade_buckets_one_to_five():
    d = pd.DataFrame({"cat": ["a"] * 10 + ["b"] * 5, "lev": np.linspace(0, 0.1, 15), "wp0": np.linspace(0.1, 0.9, 15)})
    g = DR.grade(d)
    assert g.min() >= 1 and g.max() <= 5 and len(set(g[:10])) >= 4


def test_hs_step_and_tempo():
    s = HS.stepped({"completion": 0.62, "turnover": 0.02, "penalty": 0.08, "ypp_run": 5.0, "ypp_pass": 7.0, "td": 0.03},
                   {"completion": 0.58, "turnover": 0.025, "penalty": 0.09, "ypp_run": 4.8, "ypp_pass": 6.5, "td": 0.03})
    assert abs(s["completion"] - 0.54) < 1e-9 and abs(s["turnover"] - 0.03) < 1e-9
    t = HS.hs_tempo({"normal": np.array([30.0, 40.0]), "hurry": np.array([15.0, 35.0])})
    assert t["normal"].max() <= HS.HS_PLAY_CLOCK + HS.READY_DELAY and t["hurry"][0] == 15.0


def test_hs_spot_scales_the_clock():
    e = enriched()
    c = DR.candidates(e)
    r = c[c["category"] == "two_min_o"].iloc[0]
    sp = DR.spot_record(r, teams(), {"401": "Away St"}, "ncaa2026")
    out = HS.hs_spots([{"meta": {"id": sp["id"], "cat": "two_min_o"}, "spot": sp,
                        "real": {"story": "2024 week 5: x", "actions": [], "result": {}}}])[0]
    assert out["spot"]["start"]["clock"] == round(sp["start"]["clock"] * 720 / 900)
    assert out["spot"]["rules"] == "nfhs" and out["spot"]["player"] == "YOU" and out["spot"]["start"]["pos"] == "YOU"
