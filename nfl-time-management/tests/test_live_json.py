import json
import math

from nflclock import live


def test_blank_games_csv_fields_become_null():
    # nflverse leaves surface/stadium blank for some venues (SoFi, 2026 wk 5); NaN is not valid JSON
    assert live._opt(math.nan) is None
    assert live._opt(float("nan")) is None
    assert live._opt("grass") == "grass"
    assert json.loads(json.dumps({"surface": live._opt(math.nan)}, allow_nan=False)) == {"surface": None}

