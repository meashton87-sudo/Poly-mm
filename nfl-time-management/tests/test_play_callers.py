"""play_callers.json: who really called the plays, team by team and week by week (coaches.py fits each play-caller
from the snaps he called). Every team and side is covered from 2022 on, the week ranges never overlap, and the fit
gives each play-caller a vector."""
import json
from collections import defaultdict

import numpy as np
import pandas as pd
import pytest

from nflclock import coaches as CO
from nflclock import config

from test_names import CITY

CALLERS = json.loads(CO.CALLERS.read_text())["callers"]
FULL_FROM = 2022          # every team, both sides, from this season on (before: the defenses 2016-2021, famous offenses)


def _groups():
    g = defaultdict(list)
    for r in CALLERS:
        g[(r["season"], r["team"], r["side"])].append(r)
    return g


def test_rows_are_well_formed():
    keys = {"season", "team", "side", "name", "from_week", "to_week", "source"}
    for r in CALLERS:
        assert keys <= set(r), r
        assert r["team"] in CITY, r
        assert r["side"] in ("off", "def"), r
        assert 2006 <= r["season"] <= 2026, r
        assert r["name"].strip() and r["source"].strip(), r
        last = int(CO.last_week(r["season"]))
        assert 1 <= r["from_week"] <= r["to_week"] <= last, r
        if r.get("unverified"):
            assert r.get("note"), r        # why it is left out of the matching
        if r["side"] == "def":
            assert r["season"] >= 2016, r  # no rusher or box counts before NGS charting


def test_week_ranges_never_overlap():
    for k, rows in _groups().items():
        rows = sorted(rows, key=lambda r: r["from_week"])
        for a, b in zip(rows, rows[1:]):
            assert a["to_week"] < b["from_week"], (k, a["name"], b["name"])


def test_every_team_season_side_covered_from_2022():
    g = _groups()
    for season in range(FULL_FROM, 2027):
        for team in CITY:
            for side in ("off", "def"):
                rows = sorted(g.get((season, team, side), []), key=lambda r: r["from_week"])
                assert rows, (season, team, side)
                assert rows[0]["from_week"] == 1 and rows[-1]["to_week"] == CO.last_week(season), (season, team, side)
                for a, b in zip(rows, rows[1:]):     # a gap is a bye at most
                    assert b["from_week"] - a["to_week"] <= 2, (season, team, side)


def test_caller_of_maps_weeks_and_playoffs():
    d = pd.DataFrame({"season": [2023, 2023, 2023, 2011, 2016], "week": [1, 16, 21, 20, 5],
                      "posteam": ["LAC", "LAC", "LAC", "NO", "BUF"], "defteam": ["LAC", "LAC", "LAC", "NO", "BUF"]})
    assert list(CO.caller_of(d, "def")[:3]) == ["Brandon Staley", "Derrick Ansley", "Derrick Ansley"]
    assert CO.caller_of(d, "off").iloc[3] == "Pete Carmichael"       # the 2011 playoffs: the caller of week 17
    assert pd.isna(CO.caller_of(d, "def").iloc[4])                  # unverified (2016 Buffalo): left out
    assert CO.caller_of(d.iloc[:1], "off").iloc[0] == "Kellen Moore"


@pytest.mark.skipif(not (config.RAW_DIR / "play_by_play_2024.parquet").exists()
                    or not (config.RAW_DIR / "ftn_charting_2024.parquet").exists(), reason="needs the raw play-by-play and charting")
def test_fit_gives_every_caller_a_vector():
    out = CO.play_caller_fingerprints()
    for block, measures in (("oc", ["pass", "deep", "go", "two"]), ("dc", ["blitz", "load", "soft"])):
        b = out[block]
        assert b["measures"] == measures and len(b["callers"]) >= 40, block
        assert all(b["spread"][k] > 0 for k in measures)
        for c in b["callers"]:
            assert c["plays"] >= CO.CALLER_MIN and c["stints"]
            assert set(c["z"]) == set(measures) and all(np.isfinite(v) for v in c["z"].values())
    names = {c["name"] for c in out["dc"]["callers"]}
    assert {"Dick LeBeau", "Wade Phillips", "Vic Fangio", "Steve Spagnuolo", "Brian Flores"} <= names
    assert {"Andy Reid", "Kyle Shanahan", "Sean McVay", "Kevin O'Connell"} <= {c["name"] for c in out["oc"]["callers"]}
