from __future__ import annotations

import pytest

from rh_meme_bot.chain import PoolCreated, PoolPrice, TokenInfo

MEME = "0x1111111111111111111111111111111111111111"
WETH = "0x9999999999999999999999999999999999999999"
POOL = "0x5555555555555555555555555555555555555555"


class FakeReader:
    """Stands in for ChainReader without any network access."""

    expected_chain_id = 4663

    def __init__(self, events=None, price=0.002, liquidity=10**18, quote_reserve=5.0,
                 owner_status="renounced", head=100):
        self.events = list(events or [])
        self.price = price
        self.liquidity = liquidity
        self.quote_reserve = quote_reserve
        self.owner_status = owner_status
        self.head = head

    def check_connection(self):
        return 4663

    def latest_block(self):
        return self.head

    def get_pool_created_events(self, from_block, to_block):
        out = [e for e in self.events if from_block <= e.block_number <= to_block]
        return out

    def get_token_info(self, address):
        sym = "MEME" if address == MEME else "WETH"
        return TokenInfo(address=address, has_bytecode=True, bytecode_size=1000,
                         name=sym, symbol=sym, decimals=18, total_supply_raw=10**27,
                         owner=None, owner_status=self.owner_status)

    def get_pool_price(self, pool, token0=None, token1=None):
        # token0 = MEME (lower address); price of token0 in token1 = self.price
        p = self.price
        return PoolPrice(pool=pool, sqrt_price_x96=1 if p else 0, tick=0,
                         liquidity=self.liquidity,
                         price_token0_in_token1=p, price_token1_in_token0=(1 / p) if p else 0)

    def get_balance(self, token, holder):
        return self.quote_reserve if token == WETH else 1_000_000.0


def make_event(block=50):
    return PoolCreated(token0=MEME, token1=WETH, fee=10000, tick_spacing=200,
                       pool=POOL, block_number=block, tx_hash="0xabc")


@pytest.fixture
def event():
    return make_event()
