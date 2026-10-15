"""The daily schedule is frozen (src/nflclock/daily_schedule.json): a build with a new week of games must keep every
day's drive where it was, so the file has to stay a complete, consistent schedule."""
import json
from collections import Counter

from nflclock import dailygame as G


def test_frozen_schedule_is_complete():
    f = json.loads(G.FROZEN.read_text())
    assert f["launch"] == G.LAUNCH.isoformat()
    spots, schedule = f["spots"], f["schedule"]
    ids = [i for i, _ in spots]
    assert len(ids) == len(set(ids)), "a spot twice"
    cats = [c for _, c in spots]
    assert set(cats) == set(G.CATEGORIES)
    # grouped by kind in CATEGORIES order, as the build lays the spots out
    assert cats == sorted(cats, key=list(G.CATEGORIES).index)
    assert len(schedule) >= G.DAYS
    for day in schedule:
        assert len(day) == len(G.CATEGORIES) and all(0 <= k < len(spots) for k in day)
        assert Counter(cats[k] for k in day) == Counter(list(G.CATEGORIES)), "one spot of each kind a day"
