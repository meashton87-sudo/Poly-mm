import pytest

from rh_meme_bot.activity import summarize_activity
from rh_meme_bot.chain import (BURN_TOPIC, MINT_TOPIC, SWAP_TOPIC, PoolLog,
                               decode_pool_log)

Q96 = 2**96
E18 = 10**18


def swap(block, target_delta, quote_delta, price=1.0, who="0x" + "aa" * 20):
    # target = token0, quote = token1, both 18 decimals
    sqrtp = int((price ** 0.5) * Q96)
    return PoolLog("swap", block, 0, target_delta, quote_delta, recipient=who,
                   sqrt_price_x96=sqrtp)


def test_buy_sell_pressure_and_momentum():
    logs = [
        PoolLog("mint", 1, 0, 1000 * E18, 10 * E18),
        swap(2, -100 * E18, 1 * E18, price=1.0, who="0x" + "01" * 20),   # buy
        swap(3, -100 * E18, 2 * E18, price=2.0, who="0x" + "02" * 20),   # buy
        swap(4, 50 * E18, -1 * E18, price=1.5, who="0x" + "01" * 20),    # sell
    ]
    a = summarize_activity(logs, target_is_token0=True, decimals0=18, decimals1=18,
                           age_seconds=120, blocks_observed=4)
    assert (a["buy_count"], a["sell_count"], a["swap_count"]) == (2, 1, 3)
    assert a["buy_ratio"] == pytest.approx(2 / 3, abs=1e-4)
    assert a["buy_volume_quote"] == 3.0 and a["sell_volume_quote"] == 1.0
    assert a["net_flow_quote"] == 2.0
    assert a["unique_buyers"] == 2 and a["unique_recipients"] == 2
    assert a["swaps_per_minute"] == 1.5
    assert a["price_change_pct"] == pytest.approx(50.0, abs=1e-3)
    assert a["drawdown_from_high_pct"] == pytest.approx(-25.0, abs=1e-3)
    assert a["mint_count"] == 1 and a["quote_added"] == 10.0
    assert a["burn_count"] == 0 and a["quote_removed"] == 0.0


def test_target_as_token1_flips_direction():
    # target = token1: pool paying out token1 is a buy, quote is token0.
    logs = [PoolLog("swap", 2, 0, 3 * E18, -100 * E18, recipient="0x" + "01" * 20,
                    sqrt_price_x96=Q96)]
    a = summarize_activity(logs, target_is_token0=False, decimals0=18, decimals1=18,
                           age_seconds=None, blocks_observed=1)
    assert a["buy_count"] == 1 and a["buy_volume_quote"] == 3.0
    assert a["swaps_per_minute"] is None


def test_empty_pool():
    a = summarize_activity([], True, 18, 18, age_seconds=5, blocks_observed=1)
    assert a["swap_count"] == 0 and a["buy_ratio"] is None and a["price_change_pct"] is None


def _w(v, signed=False):
    return v.to_bytes(32, "big", signed=signed)


def test_decode_pool_logs():
    who = bytes.fromhex("bb" * 20)
    swap_log = {
        "topics": [bytes.fromhex(SWAP_TOPIC[2:]), bytes(32), bytes(12) + who],
        "data": _w(-5, True) + _w(7, True) + _w(Q96) + _w(1) + _w(0, True),
        "blockNumber": 9, "logIndex": 3,
    }
    d = decode_pool_log(swap_log)
    assert d.kind == "swap" and d.amount0 == -5 and d.amount1 == 7
    assert d.recipient.lower() == "0x" + "bb" * 20 and d.sqrt_price_x96 == Q96

    mint_log = {"topics": [bytes.fromhex(MINT_TOPIC[2:]), b"", b"", b""],
                "data": bytes(32) + _w(1) + _w(11) + _w(22), "blockNumber": 1}
    m = decode_pool_log(mint_log)
    assert (m.kind, m.amount0, m.amount1) == ("mint", 11, 22)

    burn_log = {"topics": [bytes.fromhex(BURN_TOPIC[2:]), b"", b"", b""],
                "data": _w(1) + _w(33) + _w(44), "blockNumber": 1}
    b = decode_pool_log(burn_log)
    assert (b.kind, b.amount0, b.amount1) == ("burn", 33, 44)

    assert decode_pool_log({"topics": [bytes(32)], "data": b"", "blockNumber": 1}) is None
