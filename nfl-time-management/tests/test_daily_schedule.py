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


def test_featured_days_and_titles(tmp_path):
    f = json.loads(G.FROZEN.read_text())
    for d, ft in f.get("featured", {}).items():
        assert int(d) >= 1 and ft["id"] and ft["category"] in G.CATEGORIES and ft.get("note")
        assert isinstance(ft.get("title", ""), str)
    assert f["featured"]["7"]["title"] == "28–3 · Super Bowl LI"
    # freeze() carries a title from a built game.json back to the frozen file, and leaves it off a day without one
    game = {"launch": f["launch"], "schedule": [[0]], "spots": [{"id": "a", "category": "drill"}, {"id": "b", "category": "drill"}],
            "featured": {"7": {"spot": 0, "note": "n", "title": "T"}, "8": {"spot": 1, "note": "m"}}}
    (tmp_path / "game.json").write_text(json.dumps(game))
    G.freeze(tmp_path / "game.json", tmp_path / "frozen.json")
    out = json.loads((tmp_path / "frozen.json").read_text())["featured"]
    assert out["7"]["title"] == "T" and "title" not in out["8"]


def test_featured_sides(tmp_path):
    """A featured day can offer two sides of one game (sides: the player picks one): each side is a spot with a kind, the
    day's own id is its first side's, and freeze() carries the sides (their notes and real-drive stories) back."""
    f = json.loads(G.FROZEN.read_text())
    for d, ft in f.get("featured", {}).items():
        if "sides" not in ft:
            continue
        ss = ft["sides"]
        assert len(ss) == 2 and len({s["id"] for s in ss}) == 2, d
        assert ft["id"] == ss[0]["id"] and ft["category"] == ss[0]["category"]
        assert all(s["category"] in G.CATEGORIES for s in ss)
        assert len({s["id"].split("#")[0] for s in ss}) == 1, "two sides of one game"
        assert [i for i, _ in f["spots"] if i in {s["id"] for s in ss}] == [], "a side is not also an ordinary spot"
    game = {"launch": f["launch"], "schedule": [[0]],
            "spots": [{"id": "a", "category": "drill"}, {"id": "g#1", "category": "protect"}, {"id": "g#2", "category": "drill"}],
            "featured": {"8": {"spot": 1, "note": "n", "title": "T", "sides": [{"spot": 1, "summary": "s1"}, {"spot": 2, "note": "m"}]}}}
    (tmp_path / "game.json").write_text(json.dumps(game))
    G.freeze(tmp_path / "game.json", tmp_path / "frozen.json")
    out = json.loads((tmp_path / "frozen.json").read_text())
    assert out["spots"] == [["a", "drill"]], "the sides' spots stay off the ordinary list"
    assert out["featured"]["8"] == {"id": "g#1", "category": "protect", "note": "n", "title": "T",
                                    "sides": [{"id": "g#1", "category": "protect", "summary": "s1"}, {"id": "g#2", "category": "drill", "note": "m"}]}
