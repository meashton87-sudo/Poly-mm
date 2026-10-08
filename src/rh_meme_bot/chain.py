"""Read-only access to Robinhood Chain: factory events, token and pool state."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from decimal import Decimal, getcontext
from typing import Any

from web3 import Web3
from web3.exceptions import Web3Exception

log = logging.getLogger(__name__)

getcontext().prec = 60

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD"
RENOUNCED_OWNERS = {ZERO_ADDRESS.lower(), DEAD_ADDRESS.lower()}

# PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee,
#             int24 tickSpacing, address pool)
POOL_CREATED_TOPIC = "0x" + Web3.keccak(
    text="PoolCreated(address,address,uint24,int24,address)"
).hex().removeprefix("0x")

Q96 = Decimal(2) ** 96

ERC20_ABI: list[dict[str, Any]] = [
    {"name": "name", "inputs": [], "outputs": [{"type": "string"}],
     "stateMutability": "view", "type": "function"},
    {"name": "symbol", "inputs": [], "outputs": [{"type": "string"}],
     "stateMutability": "view", "type": "function"},
    {"name": "decimals", "inputs": [], "outputs": [{"type": "uint8"}],
     "stateMutability": "view", "type": "function"},
    {"name": "totalSupply", "inputs": [], "outputs": [{"type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"name": "balanceOf", "inputs": [{"name": "a", "type": "address"}],
     "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"name": "owner", "inputs": [], "outputs": [{"type": "address"}],
     "stateMutability": "view", "type": "function"},
    {"name": "getOwner", "inputs": [], "outputs": [{"type": "address"}],
     "stateMutability": "view", "type": "function"},
]

# Some older tokens return bytes32 for name/symbol.
ERC20_BYTES32_ABI: list[dict[str, Any]] = [
    {"name": "name", "inputs": [], "outputs": [{"type": "bytes32"}],
     "stateMutability": "view", "type": "function"},
    {"name": "symbol", "inputs": [], "outputs": [{"type": "bytes32"}],
     "stateMutability": "view", "type": "function"},
]

POOL_ABI: list[dict[str, Any]] = [
    {"name": "slot0", "inputs": [], "stateMutability": "view", "type": "function",
     "outputs": [
         {"name": "sqrtPriceX96", "type": "uint160"},
         {"name": "tick", "type": "int24"},
         {"name": "observationIndex", "type": "uint16"},
         {"name": "observationCardinality", "type": "uint16"},
         {"name": "observationCardinalityNext", "type": "uint16"},
         {"name": "feeProtocol", "type": "uint8"},
         {"name": "unlocked", "type": "bool"},
     ]},
    {"name": "liquidity", "inputs": [], "outputs": [{"type": "uint128"}],
     "stateMutability": "view", "type": "function"},
    {"name": "token0", "inputs": [], "outputs": [{"type": "address"}],
     "stateMutability": "view", "type": "function"},
    {"name": "token1", "inputs": [], "outputs": [{"type": "address"}],
     "stateMutability": "view", "type": "function"},
]


@dataclass
class PoolCreated:
    token0: str
    token1: str
    fee: int
    tick_spacing: int
    pool: str
    block_number: int
    tx_hash: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TokenInfo:
    address: str
    has_bytecode: bool
    bytecode_size: int
    name: str | None = None
    symbol: str | None = None
    decimals: int | None = None
    total_supply_raw: int | None = None
    owner: str | None = None
    # "renounced" | "owned" | "no_owner_fn" | "unknown"
    owner_status: str = "unknown"

    @property
    def total_supply(self) -> float | None:
        if self.total_supply_raw is None:
            return None
        return float(Decimal(self.total_supply_raw) / Decimal(10) ** (self.decimals or 0))

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["total_supply"] = self.total_supply
        return d


@dataclass
class PoolPrice:
    pool: str
    sqrt_price_x96: int
    tick: int
    liquidity: int
    # Price of token0 denominated in token1, decimals-adjusted.
    price_token0_in_token1: float
    # Price of token1 denominated in token0, decimals-adjusted.
    price_token1_in_token0: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def sqrt_price_x96_to_price(sqrt_price_x96: int, decimals0: int, decimals1: int) -> Decimal:
    """Return the price of token0 expressed in token1 (human units).

    Uniswap V3 stores sqrt(token1_raw / token0_raw) as a Q64.96 fixed-point
    number; squaring it gives raw token1 per raw token0, and the decimals
    difference converts that to whole-token units.
    """
    if sqrt_price_x96 <= 0:
        return Decimal(0)
    ratio = (Decimal(sqrt_price_x96) / Q96) ** 2
    return ratio * (Decimal(10) ** (decimals0 - decimals1))


def decode_pool_created(log_entry: Any) -> PoolCreated:
    """Decode a raw PoolCreated log (dict-like web3 log) into a dataclass."""
    topics = log_entry["topics"]
    data = bytes(log_entry["data"])
    if len(topics) != 4 or len(data) < 64:
        raise ValueError("log is not a PoolCreated event")

    def topic_addr(t: Any) -> str:
        return Web3.to_checksum_address(bytes(t)[-20:])

    tick_spacing = int.from_bytes(data[0:32], "big", signed=True)
    pool = Web3.to_checksum_address(data[44:64])
    tx_hash = log_entry.get("transactionHash")
    return PoolCreated(
        token0=topic_addr(topics[1]),
        token1=topic_addr(topics[2]),
        fee=int.from_bytes(bytes(topics[3]), "big"),
        tick_spacing=tick_spacing,
        pool=pool,
        block_number=int(log_entry["blockNumber"]),
        tx_hash=("0x" + bytes(tx_hash).hex()) if tx_hash is not None else "",
    )


class ChainReader:
    """Thin, read-only wrapper over a web3 HTTP connection."""

    def __init__(
        self,
        rpc_url: str,
        factory_address: str,
        expected_chain_id: int | None = None,
        max_block_range: int = 2000,
        request_timeout: float = 20.0,
        w3: Web3 | None = None,
    ) -> None:
        self.w3 = w3 or Web3(
            Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": request_timeout})
        )
        self.factory_address = Web3.to_checksum_address(factory_address)
        self.expected_chain_id = expected_chain_id
        self.max_block_range = max_block_range
        self._decimals_cache: dict[str, int] = {}

    # -- connection -------------------------------------------------------

    def check_connection(self) -> int:
        """Verify the RPC is reachable and on the expected chain; return chain id."""
        chain_id = int(self.w3.eth.chain_id)
        if self.expected_chain_id is not None and chain_id != self.expected_chain_id:
            raise RuntimeError(
                f"RPC is on chain {chain_id}, expected {self.expected_chain_id}"
            )
        return chain_id

    def latest_block(self) -> int:
        return int(self.w3.eth.block_number)

    # -- factory events ---------------------------------------------------

    def get_pool_created_events(self, from_block: int, to_block: int) -> list[PoolCreated]:
        """Fetch PoolCreated events in [from_block, to_block], chunked by max_block_range."""
        events: list[PoolCreated] = []
        start = from_block
        while start <= to_block:
            end = min(start + self.max_block_range - 1, to_block)
            logs = self.w3.eth.get_logs({
                "address": self.factory_address,
                "topics": [POOL_CREATED_TOPIC],
                "fromBlock": start,
                "toBlock": end,
            })
            for entry in logs:
                try:
                    events.append(decode_pool_created(entry))
                except ValueError as exc:
                    log.warning("skipping undecodable log: %s", exc)
            start = end + 1
        return events

    # -- tokens -----------------------------------------------------------

    def _call(self, contract: Any, fn: str, *args: Any) -> Any:
        """Call a view function, returning None if it reverts or is absent."""
        try:
            return getattr(contract.functions, fn)(*args).call()
        except (Web3Exception, ValueError, OverflowError) as exc:
            log.debug("call %s.%s failed: %s", contract.address, fn, exc)
            return None

    def get_bytecode(self, address: str) -> bytes:
        return bytes(self.w3.eth.get_code(Web3.to_checksum_address(address)))

    def get_token_info(self, address: str) -> TokenInfo:
        """Read supply, metadata, owner status, and bytecode presence of an ERC-20."""
        addr = Web3.to_checksum_address(address)
        code = self.get_bytecode(addr)
        info = TokenInfo(address=addr, has_bytecode=len(code) > 0, bytecode_size=len(code))
        if not info.has_bytecode:
            info.owner_status = "unknown"
            return info

        token = self.w3.eth.contract(address=addr, abi=ERC20_ABI)
        info.name = self._call(token, "name")
        info.symbol = self._call(token, "symbol")
        if info.name is None or info.symbol is None:
            alt = self.w3.eth.contract(address=addr, abi=ERC20_BYTES32_ABI)
            if info.name is None:
                info.name = _bytes32_to_str(self._call(alt, "name"))
            if info.symbol is None:
                info.symbol = _bytes32_to_str(self._call(alt, "symbol"))
        info.decimals = self._call(token, "decimals")
        if info.decimals is not None:
            self._decimals_cache[addr] = int(info.decimals)
        info.total_supply_raw = self._call(token, "totalSupply")

        owner = self._call(token, "owner")
        if owner is None:
            owner = self._call(token, "getOwner")
        if owner is None:
            info.owner_status = "no_owner_fn"
        else:
            info.owner = Web3.to_checksum_address(owner)
            info.owner_status = "renounced" if owner.lower() in RENOUNCED_OWNERS else "owned"
        return info

    def get_decimals(self, address: str) -> int:
        addr = Web3.to_checksum_address(address)
        if addr not in self._decimals_cache:
            token = self.w3.eth.contract(address=addr, abi=ERC20_ABI)
            dec = self._call(token, "decimals")
            self._decimals_cache[addr] = int(dec) if dec is not None else 18
        return self._decimals_cache[addr]

    def get_balance(self, token_address: str, holder: str) -> float | None:
        """ERC-20 balance of ``holder`` in whole-token units."""
        token = self.w3.eth.contract(
            address=Web3.to_checksum_address(token_address), abi=ERC20_ABI
        )
        raw = self._call(token, "balanceOf", Web3.to_checksum_address(holder))
        if raw is None:
            return None
        return float(Decimal(raw) / Decimal(10) ** self.get_decimals(token_address))

    # -- pools ------------------------------------------------------------

    def get_pool_price(
        self, pool_address: str, token0: str | None = None, token1: str | None = None
    ) -> PoolPrice:
        """Read slot0 + liquidity and convert sqrtPriceX96 to human prices."""
        pool = self.w3.eth.contract(address=Web3.to_checksum_address(pool_address), abi=POOL_ABI)
        slot0 = pool.functions.slot0().call()
        liquidity = int(pool.functions.liquidity().call())
        token0 = token0 or pool.functions.token0().call()
        token1 = token1 or pool.functions.token1().call()
        sqrt_price = int(slot0[0])
        price01 = sqrt_price_x96_to_price(sqrt_price, self.get_decimals(token0),
                                          self.get_decimals(token1))
        price10 = (Decimal(1) / price01) if price01 > 0 else Decimal(0)
        return PoolPrice(
            pool=Web3.to_checksum_address(pool_address),
            sqrt_price_x96=sqrt_price,
            tick=int(slot0[1]),
            liquidity=liquidity,
            price_token0_in_token1=float(price01),
            price_token1_in_token0=float(price10),
        )


class FactoryWatcher:
    """Stateful poller that returns PoolCreated events not yet seen.

    Each :meth:`poll` scans from the last processed block to the chain head,
    so the caller controls cadence (see ``POLL_INTERVAL``).
    """

    def __init__(self, reader: ChainReader, start_block: int) -> None:
        self.reader = reader
        self.next_block = start_block

    def poll(self) -> list[PoolCreated]:
        head = self.reader.latest_block()
        if head < self.next_block:
            return []
        events = self.reader.get_pool_created_events(self.next_block, head)
        self.next_block = head + 1
        return events


def _bytes32_to_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return bytes(value).rstrip(b"\x00").decode("utf-8", errors="replace") or None
    except (TypeError, ValueError):
        return None
