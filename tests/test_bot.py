import json

from rh_meme_bot.bot import Bot, BotState, build_state, classify_tokens
from rh_meme_bot.config import Config, RiskThresholds
from rh_meme_bot.executor import PaperExecutor

from .conftest import MEME, POOL, WETH, FakeReader, make_event


def _cfg(tmp_path, **kw):
    base = dict(quote_tokens=(WETH,), paper_log_path=tmp_path / "trades.jsonl",
                risk=RiskThresholds(min_liquidity=1.0, min_confidence=0.7, max_risk_score=0.5),
                mark_interval=0.0, recheck_delay=0.0)
    base.update(kw)
    return Config(**base)


def test_classify_tokens(event):
    assert classify_tokens(event, {WETH.lower()}) == (MEME, WETH, True)
    assert classify_tokens(event, set()) == (MEME, WETH, False)


def test_build_state(event):
    st = build_state(FakeReader(), event, {WETH.lower()})
    assert st["token"]["symbol"] == "MEME"
    assert st["price"] == 0.002
    assert st["quote_reserve"] == 5.0
    assert st["risk_score"] == 0.0


def test_buy_flow_opens_paper_position(tmp_path):
    cfg = _cfg(tmp_path)
    reader = FakeReader(events=[make_event(50)])
    executor = PaperExecutor(cfg.paper_log_path, trade_size=0.1)
    bot = Bot(cfg, reader, lambda s: {"action": "buy", "confidence": 0.9}, executor, BotState())
    bot.start()
    bot.tick()

    positions = executor.open_positions()
    assert len(positions) == 1
    pos = positions[0]
    assert pos.pool == POOL and pos.entry_price == 0.002
    assert pos.quantity == 0.1 / 0.002
    assert bot.state.launches[0].final_action == "buy"

    records = [json.loads(l) for l in cfg.paper_log_path.read_text().splitlines()]
    assert [r["type"] for r in records] == ["decision", "open"]

    # Same pool again must not double up.
    bot.evaluate(bot.state.launches[0])
    assert len(executor.open_positions()) == 1

    # Mark to market.
    reader.price = 0.004
    bot.tick()
    assert executor.open_positions()[0].pnl_pct == 100.0


def test_risky_buy_is_vetoed(tmp_path):
    cfg = _cfg(tmp_path)
    reader = FakeReader(events=[make_event(50)], owner_status="owned", quote_reserve=0.01)
    executor = PaperExecutor(cfg.paper_log_path, trade_size=0.1)
    bot = Bot(cfg, reader, lambda s: {"action": "buy", "confidence": 0.9}, executor, BotState())
    bot.start()
    bot.tick()
    assert executor.open_positions() == []
    row = bot.state.launches[0]
    assert row.final_action == "skip"
    assert any("liquidity" in r for r in row.gate_reasons)


def test_uninitialized_pool_is_rechecked(tmp_path):
    cfg = _cfg(tmp_path, recheck_attempts=2)
    reader = FakeReader(events=[make_event(50)], price=0.0, liquidity=0)
    executor = PaperExecutor(cfg.paper_log_path, trade_size=0.1)
    bot = Bot(cfg, reader, lambda s: {"action": "buy", "confidence": 0.9}, executor, BotState())
    bot.start()
    bot.tick()
    assert executor.open_positions() == []
    # Pool gets initialized and funded before the re-check.
    reader.price, reader.liquidity = 0.002, 10**18
    bot.tick()
    assert len(executor.open_positions()) == 1
    assert bot.state.launches[0].attempts == 2


def test_dashboard_renders(tmp_path):
    from rich.console import Console

    from rh_meme_bot.dashboard import render

    cfg = _cfg(tmp_path)
    reader = FakeReader(events=[make_event(50)])
    executor = PaperExecutor(cfg.paper_log_path, trade_size=0.1)
    bot = Bot(cfg, reader, lambda s: {"action": "buy", "confidence": 0.9}, executor, BotState())
    bot.start()
    bot.tick()
    console = Console(width=160, height=40, record=True)
    console.print(render(bot.state, executor, cfg, 40))
    out = console.export_text()
    assert "MEME" in out and "PAPER BUY" in out
