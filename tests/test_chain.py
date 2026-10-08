from decimal import Decimal

import pytest
from web3 import Web3

from rh_meme_bot.chain import (POOL_CREATED_TOPIC, ChainReader, FactoryWatcher,
                               decode_pool_created, sqrt_price_x96_to_price)

from .conftest import FakeReader, make_event


def test_topic_matches_uniswap_v3():
    assert POOL_CREATED_TOPIC == (
        "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
    )


def test_sqrt_price_identity():
    # sqrtPriceX96 == 2**96 means price 1 with equal decimals.
    assert sqrt_price_x96_to_price(2**96, 18, 18) == Decimal(1)


def test_sqrt_price_decimals_adjust():
    # token0 = WETH (18), token1 = USDC (6), 1 WETH = 2000 USDC
    # raw ratio = 2000 * 1e6 / 1e18 = 2e-9
    raw = Decimal(2000) * Decimal(10) ** 6 / Decimal(10) ** 18
    sqrtp = int((raw.sqrt()) * (Decimal(2) ** 96))
    price = sqrt_price_x96_to_price(sqrtp, 18, 6)
    assert price == pytest.approx(Decimal(2000), rel=Decimal("1e-9"))


def test_decode_pool_created():
    t0 = "0x" + "11" * 20
    t1 = "0x" + "22" * 20
    pool = "0x" + "33" * 20
    log = {
        "topics": [
            bytes.fromhex(POOL_CREATED_TOPIC[2:]),
            bytes(12) + bytes.fromhex(t0[2:]),
            bytes(12) + bytes.fromhex(t1[2:]),
            (3000).to_bytes(32, "big"),
        ],
        "data": (-60).to_bytes(32, "big", signed=True) + bytes(12) + bytes.fromhex(pool[2:]),
        "blockNumber": 123,
        "transactionHash": bytes.fromhex("ab" * 32),
    }
    ev = decode_pool_created(log)
    assert ev.token0 == Web3.to_checksum_address(t0)
    assert ev.token1 == Web3.to_checksum_address(t1)
    assert ev.pool == Web3.to_checksum_address(pool)
    assert ev.fee == 3000
    assert ev.tick_spacing == -60
    assert ev.block_number == 123
    assert ev.tx_hash == "0x" + "ab" * 32


def test_factory_watcher_advances_cursor():
    reader = FakeReader(events=[make_event(10), make_event(60)], head=50)
    w = FactoryWatcher(reader, start_block=0)
    assert [e.block_number for e in w.poll()] == [10]
    assert w.next_block == 51
    assert w.poll() == []  # head unchanged
    reader.head = 70
    assert [e.block_number for e in w.poll()] == [60]


class _FakeEth:
    def __init__(self):
        self.calls = []

    def get_logs(self, params):
        self.calls.append((params["fromBlock"], params["toBlock"]))
        return []


class _FakeW3:
    def __init__(self):
        self.eth = _FakeEth()


def test_get_logs_is_chunked():
    w3 = _FakeW3()
    reader = ChainReader("http://unused", "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
                         max_block_range=100, w3=w3)
    reader.get_pool_created_events(0, 250)
    assert w3.eth.calls == [(0, 99), (100, 199), (200, 250)]
