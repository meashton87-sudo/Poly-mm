import numpy as np
import pytest

from nflclock import config
from nflclock import library as L

BUNDLE = config.ARTIFACT_DIR / "bundle.pkl"
needs_bundle = pytest.mark.skipif(not BUNDLE.exists(), reason="run `nflclock build` first")


def test_fine_key_roundtrip():
    mode = np.array([0, 1, 2, 2])
    down = np.array([1, 2, 3, 4])
    ytg = np.array([1, 4, 8, 25])
    yl = np.array([2, 15, 55, 99])
    fk = L.fine_key(mode, down, ytg, yl)
    m, db, yb, z = L.decode_fine(fk)
    assert (m == mode).all()
    assert (db == np.array([0, 1, 2, 2])).all()  # 3rd and 4th down share a bucket
    assert (yb == L.ytg_bucket(ytg)).all()
    assert (z == L.zone_of(yl)).all()
    assert fk.max() < L.N_FINE


def test_game_mode():
    # trailing late in the 4th -> hurry; leading late -> kill; first-half 2:00 drill -> hurry
    assert L.game_mode(2, 200, -3) == L.MODE_HURRY
    assert L.game_mode(2, 200, 3) == L.MODE_KILL
    assert L.game_mode(1, 90, 7) == L.MODE_HURRY
    assert L.game_mode(2, 1500, -3) == L.MODE_NORMAL


@pytest.fixture(scope="module")
def sim():
    from nflclock.models import Bundle
    from nflclock.sim import GameContext, Simulator
    return Simulator(Bundle.load(), GameContext())


@needs_bundle
def test_kneel_out_math(sim):
    f = sim.kneel_out_possible
    # 3 kneels, clock running, defense has no timeouts: ~4 x 38s can be burned
    assert f(np.array([120.0]), np.array([1]), np.array([0]), np.array([True]), np.array([False]))[0]
    # same but defense holds 3 timeouts: only ~45s can be burned
    assert not f(np.array([120.0]), np.array([1]), np.array([3]), np.array([True]), np.array([False]))[0]
    assert f(np.array([40.0]), np.array([1]), np.array([2]), np.array([False]), np.array([False]))[0]
    assert not f(np.array([40.0]), np.array([1]), np.array([3]), np.array([False]), np.array([False]))[0]


@needs_bundle
def test_victory_formation_is_certain(sim):
    from nflclock.sim import RootState
    root = RootState(t=85, pos=0, score=(24, 17), down=1, ytg=10, yl=65, to=(2, 0))
    v = sim.run(root, n=500, perspective=0, seed=1)
    assert v.mean() == pytest.approx(1.0)


@needs_bundle
def test_last_second_field_goal(sim):
    from nflclock.sim import RootState
    root = RootState(t=3, pos=0, score=(17, 19), down=4, ytg=5, yl=10, to=(0, 1))
    v = sim.run(root, n=4000, perspective=0, seed=2)
    p_make = float(sim.fg_prob(np.array([27.0]), np.array([0]))[0])
    assert v.mean() == pytest.approx(p_make, abs=0.02)


@needs_bundle
def test_invariants(sim):
    from nflclock.sim import RootState
    root = RootState(t=280, pos=1, score=(10, 13), down=2, ytg=7, yl=55, to=(2, 3), clock_running=True)
    v, S = sim.run(root, n=3000, perspective=0, seed=3, return_state=True)
    assert ((v >= 0) & (v <= 1)).all()
    assert (S.t <= root.t + 1e-9).all() and (S.t >= 0).all()
    assert (S.to >= 0).all() and (S.to <= 3).all()
    assert (S.score >= np.array(root.score)).all()


@needs_bundle
def test_forced_timeout_is_used(sim):
    from nflclock.sim import RootState
    root = RootState(t=150, pos=0, score=(20, 17), down=2, ytg=6, yl=60, to=(3, 3), clock_running=True)
    _, S = sim.run(root, n=200, perspective=1, seed=4, action={"to_def": True}, max_steps=1, return_state=True)
    assert (S.to[:, 1] == 2).all()
    _, S = sim.run(root, n=200, perspective=1, seed=4, action={"to_def": False}, max_steps=1, return_state=True)
    assert (S.to[:, 1] == 3).all()


@needs_bundle
def test_common_random_numbers_identical_actions(sim):
    from nflclock.sim import RootState
    root = RootState(t=200, pos=0, score=(14, 14), down=1, ytg=10, yl=70)
    a = sim.run(root, n=800, perspective=0, seed=9)
    b = sim.run(root, n=800, perspective=0, seed=9)
    assert np.array_equal(a, b)


@needs_bundle
def test_better_kicker_helps(sim):
    """A 50-yard game-winner should be worth more with a better kicker."""
    from nflclock.sim import RootState
    root = RootState(t=2, pos=0, score=(17, 19), down=4, ytg=8, yl=33, to=(0, 0))
    base = sim.run(root, n=4000, perspective=0, seed=5).mean()
    sim.ctx.kicker_shift[0] = 0.5
    try:
        good = sim.run(root, n=4000, perspective=0, seed=5).mean()
    finally:
        sim.ctx.kicker_shift[0] = 0.0
    assert good > base + 0.03


@needs_bundle
def test_forced_tempo_runs_a_real_play(sim):
    """'Hurry to the line' must snap a real play even when the policy would spike."""
    from nflclock.sim import RootState
    root = RootState(t=30, pos=0, score=(17, 20), down=1, ytg=10, yl=40, to=(0, 2), clock_running=True)
    _, S = sim.run(root, n=1000, perspective=0, seed=6, action={"tempo": "urgent"}, max_steps=1, return_state=True)
    spike_like = (S.down == 2) & (S.yl == 40) & ~S.running
    assert spike_like.mean() < 0.6
    _, S = sim.run(root, n=1000, perspective=0, seed=6, action={"play": "spike"}, max_steps=1, return_state=True)
    assert ((S.down == 2) & (S.yl == 40) & ~S.running).all()


@needs_bundle
def test_clock_stop_subset_only_stops_the_clock(sim):
    lib = sim.lib
    pos, off = lib.clock_stop_subset()
    rows = lib.items[pos]
    a = lib.arr
    stops = a["incomplete"][rows].astype(bool) | a["oob"][rows].astype(bool)
    assert stops.all()
    assert not (a["penalty"][rows].astype(bool) | a["turnover"][rows].astype(bool) | a["td_off"][rows].astype(bool)).any()
    # every drawn row belongs to the pool it was drawn for
    pool = lib.pool_id[pos[0]]
    u = np.linspace(0.001, 0.999, 50)
    drawn = lib.sample_subset(sim.stop_cdf[0], pos, off, np.full(50, pool), u)
    members = set(lib.items[pos[off[pool]:off[pool + 1]]])
    assert set(drawn) <= members


@needs_bundle
def test_no_timeout_offense_stops_the_clock_more(sim):
    """Clock-aware calls trade in-bounds gains for stopped clocks: more snaps fit in the time left."""
    from nflclock.sim import RootState
    import nflclock.sim as S
    root = RootState(t=30, pos=0, score=(20, 22), down=1, ytg=10, yl=55, to=(0, 2), clock_running=False)
    aware = sim.run(root, n=3000, perspective=0, seed=3, drive_only=True)
    keep = S.CLOCK_AWARE
    try:
        S.CLOCK_AWARE = ((20.0, 1.0), (35.0, 1.0))
        plain = sim.run(root, n=3000, perspective=0, seed=3, drive_only=True)
    finally:
        S.CLOCK_AWARE = keep
    assert aware.plays.mean() > plain.plays.mean()
    assert aware.t.mean() > plain.t.mean()   # drives end with more time on the clock


def test_pace_break_even():
    from nflclock.console import pace_break_even
    assert pace_break_even([0.03, 0.02, 0.01, -0.01, -0.03, -0.04, -0.05, -0.06]) == ("within", 11.0)
    assert pace_break_even([-0.01] * 8)[0] == "never"
    assert pace_break_even([0.01] * 8)[0] == "always"


@needs_bundle
def test_kick_to_win_runs_the_clock_down(sim):
    """Down 1 in field-goal range with a timeout and the defense out of timeouts: kick at the end."""
    from nflclock.sim import RootState
    root = RootState(t=40, pos=0, score=(20, 21), down=2, ytg=8, yl=22, to=(1, 0), clock_running=True)
    d = sim.run(root, n=2000, perspective=0, seed=5, drive_only=True)
    scored = d.score[:, 0] - 20
    assert (scored == 3).mean() > 0.6           # the kick happens and is usually good
    assert d.t.mean() < 2.0                    # with essentially nothing left for the opponent
    assert (d.to[:, 0] == 0).mean() > 0.9      # the timeout was spent stopping the clock for it
