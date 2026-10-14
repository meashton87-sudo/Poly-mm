import pytest

from nflclock import config
from nflclock.console import LiveState, parse, pick_best

LIVE_GAME = config.ARTIFACT_DIR / "live" / "2026_05_BUF_LA.json"
needs_live = pytest.mark.skipif(not (config.ARTIFACT_DIR / "bundle.pkl").exists() or not LIVE_GAME.exists(),
                                reason="run `nflclock build` and `nflclock sync` first")


def test_team_spot_is_read_after_possession_in_any_order():
    before = LiveState(pos="LA")
    a = parse("q4 2:31 BUF 20 LA 24 ball BUF 2&7 LA41 to 2-3 run", before, "BUF", "LA")
    b = parse("q4 2:31 BUF 20 LA 24 LA41 ball BUF 2&7 to 2-3 run", before, "BUF", "LA")
    c = parse("at LA 41 ball BUF", before, "BUF", "LA")
    assert a.yl == b.yl == c.yl == 41.0
    assert parse("LA41 ball BUF own25", before, "BUF", "LA").yl == 75.0   # the last spot written wins


def test_ties_go_to_the_call_that_gives_the_opponent_nothing():
    assert pick_best({"timeout": 1.0, "kneel": 1.0, "milk": 0.999}) == "kneel"
    assert pick_best({"timeout": 0.0, "no_timeout": 0.0}) == "no_timeout"
    assert pick_best({"timeout": 0.40, "no_timeout": 0.38}) == "timeout"   # a real edge still wins


@needs_live
def test_last_seconds_offer_a_field_goal_on_early_downs():
    from nflclock.console import LiveConsole
    c = LiveConsole("2026_05_BUF_LA", sims=1500)
    c.st = parse("q4 0:03 22-24 ball BUF 2&5 LA10 to 0-0 stop", c.st, c.away, c.home)
    results, _ = c.evaluate()
    df = results[(1, "")]
    assert df.iloc[0]["option"] == "fg" and df.iloc[0]["wp"] > 0.9
    c.st = parse("q4 1:10 27-24 ball BUF 1&10 LA40 to 3-1 run", c.st, c.away, c.home)
    results, _ = c.evaluate()
    assert results[(1, "")].iloc[0]["option"] != "timeout"     # leading: never a timeout on a tie
    assert results[(0, "")].iloc[0]["option"] == "no_timeout"  # LA cannot win: no timeout on a tie
