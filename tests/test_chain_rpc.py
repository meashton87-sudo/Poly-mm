"""Exercise ChainReader's real web3 call/decoding path against a fake JSON-RPC."""

from __future__ import annotations

from eth_abi import encode
from web3 import Web3
from web3.providers.base import BaseProvider

from rh_meme_bot.chain import ChainReader

TOKEN = "0x1111111111111111111111111111111111111111"
QUOTE = "0x9999999999999999999999999999999999999999"
POOL = "0x5555555555555555555555555555555555555555"
FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"


def sel(sig: str) -> str:
    return Web3.keccak(text=sig).hex().removeprefix("0x")[:8]


class FakeRPC(BaseProvider):
    def __init__(self, responses: dict[tuple[str, str], bytes | None]):
        super().__init__()
        self.responses = responses

    def make_request(self, method, params):
        if method == "eth_chainId":
            return {"jsonrpc": "2.0", "id": 1, "result": hex(4663)}
        if method == "eth_getCode":
            code = "0x6080" if params[0].lower() in (TOKEN.lower(), QUOTE.lower()) else "0x"
            return {"jsonrpc": "2.0", "id": 1, "result": code}
        if method == "eth_call":
            to = params[0]["to"].lower()
            data = params[0]["data"].removeprefix("0x")[:8]
            out = self.responses.get((to, data))
            if out is None:
                return {"jsonrpc": "2.0", "id": 1,
                        "error": {"code": 3, "message": "execution reverted", "data": "0x"}}
            return {"jsonrpc": "2.0", "id": 1, "result": "0x" + out.hex()}
        raise NotImplementedError(method)

    def is_connected(self, show_traceback: bool = False) -> bool:
        return True


def _reader(responses):
    w3 = Web3(FakeRPC(responses))
    return ChainReader("http://unused", FACTORY, expected_chain_id=4663, w3=w3)


def test_token_info_owned_and_renounced():
    t = TOKEN.lower()
    base = {
        (t, sel("name()")): encode(["string"], ["Pepe Hood"]),
        (t, sel("symbol()")): encode(["string"], ["PHOOD"]),
        (t, sel("decimals()")): encode(["uint8"], [9]),
        (t, sel("totalSupply()")): encode(["uint256"], [10**18]),
    }
    owned = _reader({**base, (t, sel("owner()")): encode(["address"], ["0x" + "ab" * 20])})
    info = owned.get_token_info(TOKEN)
    assert info.has_bytecode and info.symbol == "PHOOD" and info.decimals == 9
    assert info.total_supply == 10**9
    assert info.owner_status == "owned"

    renounced = _reader({**base, (t, sel("owner()")): encode(["address"], ["0x" + "00" * 20])})
    assert renounced.get_token_info(TOKEN).owner_status == "renounced"

    no_owner = _reader(base)  # owner() and getOwner() revert
    assert no_owner.get_token_info(TOKEN).owner_status == "no_owner_fn"


def test_token_without_bytecode():
    info = _reader({}).get_token_info("0x" + "77" * 20)
    assert not info.has_bytecode and info.symbol is None


def test_pool_price_from_slot0():
    p = POOL.lower()
    responses = {
        (p, sel("slot0()")): encode(
            ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"],
            [2**96 * 2, 6931, 0, 1, 1, 0, True],
        ),
        (p, sel("liquidity()")): encode(["uint128"], [12345]),
        (TOKEN.lower(), sel("decimals()")): encode(["uint8"], [18]),
        (QUOTE.lower(), sel("decimals()")): encode(["uint8"], [18]),
    }
    pp = _reader(responses).get_pool_price(POOL, TOKEN, QUOTE)
    assert pp.price_token0_in_token1 == 4.0
    assert pp.price_token1_in_token0 == 0.25
    assert pp.liquidity == 12345 and pp.tick == 6931


def test_check_connection():
    assert _reader({}).check_connection() == 4663
