# rh-meme-bot

A Robinhood Chain memecoin launch monitor. It watches the Uniswap V3 factory for
new pools, reads on-chain facts about each new token, asks a pluggable decision
engine what to do, enforces your risk thresholds, and paper-trades the result in
a live terminal dashboard.

**No real transactions are sent.** The swap call is a stub.

```
PoolCreated event ─► build_state() ─► decide(state) ─► risk gates ─► PaperExecutor
   (chain.py)          (bot.py)       (decision.py)     (risk.py)     (executor.py)
                                   └──────────── dashboard.py (rich) ────────────┘
```

## Quick start

Requires Python 3.10+.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install -e .            # installs the src/ package + `rh-meme-bot` command

cp .env.example .env        # then edit .env (at least set QUOTE_TOKENS, see below)
rh-meme-bot                 # full-screen dashboard; Ctrl-C to quit
```

Other ways to run:

```bash
python -m rh_meme_bot                 # same as rh-meme-bot
rh-meme-bot --no-dashboard            # plain log lines to stdout (for servers/tmux)
rh-meme-bot --env-file prod.env -v    # alternate env file, debug logging
```

Logs go to `data/bot.log`; every decision and simulated trade is appended to
`data/paper_trades.jsonl`.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC endpoint |
| `CHAIN_ID` | `4663` | Bot refuses to run if the RPC reports a different chain |
| `UNISWAP_V3_FACTORY` | `0x1f7d…2EfA` | Factory emitting `PoolCreated` |
| `POLL_INTERVAL` | `3.0` | Seconds between polls (doubles up to 60s on RPC errors) |
| `START_BLOCK` | *(empty)* | First block to scan; empty = head − `LOOKBACK_BLOCKS` |
| `LOOKBACK_BLOCKS` | `5000` | How far back to scan on startup |
| `MAX_BLOCK_RANGE` | `2000` | Max span per `eth_getLogs` call |
| `QUOTE_TOKENS` | *(empty)* | Comma-separated quote token addresses (WETH, USDC, …) |
| `MIN_LIQUIDITY` | `1.0` | Min quote-token balance held by the pool, in whole tokens |
| `MIN_CONFIDENCE` | `0.7` | Min engine confidence for a buy |
| `MAX_RISK_SCORE` | `0.5` | Max heuristic risk score for a buy |
| `DECISION_ENGINE` | *(empty)* | `module:function` to use instead of the stub |
| `PAPER_TRADE_SIZE` | `0.1` | Simulated buy size, in quote-token units |
| `PAPER_LOG_PATH` | `data/paper_trades.jsonl` | Paper trade / decision log |
| `MARK_INTERVAL` | `15` | Seconds between mark-to-market price refreshes |
| `RECHECK_DELAY` / `RECHECK_ATTEMPTS` | `20` / `3` | Re-evaluate pools that had no price or liquidity yet |
| `OBSERVE_DELAY` | `0` | Seconds after pool creation to wait before the first decision |

**`OBSERVE_DELAY` and momentum.** When a pool is first detected it has no
trading history, so `state["activity"]` is empty. If your engine judges
momentum or buy pressure, set e.g. `OBSERVE_DELAY=60` so the first decision
happens a minute after creation, once some swaps exist. Pools that are already
older than that when detected (e.g. from the startup lookback scan) are
evaluated immediately.

**Set `QUOTE_TOKENS`.** It's how the bot knows which side of a pair is the new
memecoin and which is "money". Prices are reported as quote-per-token and
`MIN_LIQUIDITY` is measured in the quote token. The WETH/USDC addresses on
Robinhood Chain aren't hard-coded; look them up and put them here. If neither
side of a pool is a quote token, liquidity is unknown and the liquidity gate
blocks the buy (unless `MIN_LIQUIDITY=0`).

## Plugging in a decision engine

The contract is one function:

```python
def decide(state: dict) -> dict:
    return {"action": "buy" | "hold" | "skip", "confidence": float}  # 0..1
```

Either edit the stub in `src/rh_meme_bot/decision.py`, or point
`DECISION_ENGINE` at your own module:

```python
# my_engine.py (anywhere on PYTHONPATH)
def decide(state):
    if state["risk_score"] < 0.2 and (state["quote_reserve"] or 0) > 5:
        return {"action": "buy", "confidence": 0.8, "reason": "clean + liquid"}
    return {"action": "hold", "confidence": 0.3}
```

```bash
DECISION_ENGINE=my_engine:decide rh-meme-bot
```

Engines may also return their own risk estimate:

```python
{"action": "buy", "confidence": 0.8, "risk_score": 4, "risk_levels": 10}  # 1..10 scale
{"action": "buy", "confidence": 0.8, "risk_score": 0.33}                  # already 0..1
```

With `risk_levels: N` the score is read as 1 (safe) .. N and mapped to 0..1.
Without it, the score must already be in 0..1. A score outside 0..1 with no
`risk_levels`, or one that can't be parsed, counts as maximum risk. The risk gate
uses **the higher** of the engine's score and the built-in heuristic, so an
engine can add caution but can't override a hard red flag like "no bytecode".
On the dashboard, `risk*` means the engine's score was included.

Engine output is validated: unknown actions, non-numeric confidence, wrong
types, or exceptions all become `skip` with confidence 0, so a broken model
can't trigger a buy. Confidence is clamped to [0, 1]. Extra keys (e.g.
`reason`) are kept and logged.

A `buy` only goes through if **all** gates pass: confidence ≥ `MIN_CONFIDENCE`,
risk (higher of heuristic and engine) ≤ `MAX_RISK_SCORE`, quote reserve ≥ `MIN_LIQUIDITY`, and the pool has a
price. Vetoed buys appear as `final: skip` with the reason in the dashboard.

### The `state` dict

```python
{
  "chain_id": 4663,
  "event": {"token0", "token1", "fee", "tick_spacing", "pool", "block_number", "tx_hash"},
  "token": {                       # the new (non-quote) token
    "address", "name", "symbol", "decimals",
    "total_supply_raw", "total_supply",
    "has_bytecode", "bytecode_size",
    "owner", "owner_status",       # "renounced" | "owned" | "no_owner_fn" | "unknown"
  },
  "quote_token": "0x…",            # the other side of the pair
  "quote_token_info": {...},       # same shape as "token"
  "quote_is_known": bool,          # quote_token is in QUOTE_TOKENS
  "pool": {"sqrt_price_x96", "tick", "liquidity",
           "price_token0_in_token1", "price_token1_in_token0"}  # or {"error": ...}
  "price": float | None,           # token price in quote units
  "quote_reserve": float | None,   # quote tokens held by the pool
  "token_reserve": float | None,   # target tokens held by the pool
  "activity": {                    # pool history since creation (or {"error": ...})
    "age_seconds", "blocks_observed",
    "swap_count", "buy_count", "sell_count", "buy_ratio",
    "buy_volume_quote", "sell_volume_quote", "net_flow_quote",
    "unique_buyers", "unique_recipients", "swaps_per_minute",
    "first_swap_price", "last_swap_price", "high_price",
    "price_change_pct", "drawdown_from_high_pct",
    "mint_count", "burn_count", "quote_added", "quote_removed",
  },
  "risk_score": float,             # 0..1 heuristic, see risk.py
  "risk_flags": [str, ...],        # e.g. "owner_not_renounced", "zero_liquidity"
  "timestamp": float,
}
```

A "buy" is a swap where the pool paid out the new token. Volumes are in quote
tokens, prices are quote per token. Unique buyers/recipients count swap
recipients, which can be a router rather than the end user, so treat them as
approximate.

The risk score is a simple, transparent heuristic (no bytecode, owner not
renounced, no supply, missing metadata, zero/unknown liquidity, quote liquidity
removed). It's a
starting signal, **not** a honeypot or rug detector.

## Going live (not implemented)

`executor.py` defines a `SwapBackend` protocol:

```python
class SwapBackend(Protocol):
    def swap(self, request: SwapRequest, expected_price: float) -> SwapResult: ...
```

`StubSwapBackend` fills at the quoted price without sending anything. A live
backend would sign and send a Uniswap V3 `SwapRouter.exactInputSingle` call and
return the real fill, then be passed as `PaperExecutor(..., backend=...)`.

## Layout

```
src/rh_meme_bot/
  config.py     .env loading + validation
  chain.py      ChainReader (tokens, pools, logs) + FactoryWatcher
  decision.py   decide() stub, engine loader, output validation
  risk.py       heuristic risk score + threshold gates
  activity.py   swap/mint/burn summary: momentum, buy pressure, liquidity changes
  executor.py   PaperExecutor, Position, SwapBackend protocol + stub
  bot.py        main loop: watch → state → decide → gate → trade; re-checks; marking
  dashboard.py  rich full-screen TUI
  __main__.py   CLI entry point
tests/          pytest suite (no network needed)
decision_engine.py   Jev-backed decide() (DECISION_ENGINE=decision_engine:decide,
                     needs TYPESAFE_API_KEY)
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The tests use a fake chain reader and a fake JSON-RPC provider, so they don't
touch the network.
