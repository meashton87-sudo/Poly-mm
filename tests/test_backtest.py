"""The backtest must find a real edge, find nothing in a fair market, and report
the loss when a past edge disappears (no look-ahead)."""

import pytest

pytest.importorskip("duckdb")

from polymm.scan.backtest import BacktestConfig, Store, kalshi_fee, make_synthetic_dataset, run_backtest  # noqa: E402
from polymm.scan.calibration import iter_dir  # noqa: E402

QUIET = lambda m: None  # noqa: E731


def _run(tmp_path, cfg=None, **world):
    make_synthetic_dataset(tmp_path / "data", months=18, markets_per_month=1200, trades_per_market=20, **world)
    store = Store()
    store.load(iter_dir(tmp_path / "data"), QUIET)
    return run_backtest(store.con, cfg or BacktestConfig(min_train_positions=20_000), QUIET)


def test_finds_and_profits_from_a_real_bias(tmp_path):
    r = _run(tmp_path, bias=0.05)
    f = r["flat"]
    assert f["bets"] > 500
    assert f["roi"] > 0.01 and f["roi_ci95"][0] > 0  # profitable, and not by luck
    assert f["roi"] > r["benchmark"]["roi"] + 0.03  # far better than buying everything
    assert abs(f["win_rate"] - f["predicted_win_rate"]) < 0.03  # estimates are honest
    assert r["bankroll"]["final"] > r["bankroll"]["start"]


def test_fair_market_shows_no_edge(tmp_path):
    r = _run(tmp_path, bias=0.0)
    f = r["flat"]
    # Nothing real to find: few bets, and no claimed profit beyond noise.
    assert f["bets"] < 300
    assert f["roi"] < 0.01
    assert f["roi_ci95"] is None or f["roi_ci95"][0] < 0
    assert r["benchmark"]["roi"] < 0  # fees: buying everything loses


def test_vanished_edge_is_reported_as_a_loss(tmp_path):
    # Biased for the first 12 months, perfectly fair afterwards; test from month 12.
    r = _run(tmp_path, BacktestConfig(start="2024-01"), bias=0.05, bias_months=(0, 12))
    f = r["flat"]
    assert f["bets"] > 100  # history said "buy"...
    assert f["roi"] < 0  # ...and it lost, because the past didn't carry forward
    assert f["win_rate"] < f["predicted_win_rate"]


def test_fee_matches_kalshi_rounding():
    assert kalshi_fee(100, 0.5) == pytest.approx(1.75)
    assert kalshi_fee(1, 0.5) == pytest.approx(0.02)  # 1.75c rounds up per order
    assert kalshi_fee(10, 0.92) == pytest.approx(0.06)
