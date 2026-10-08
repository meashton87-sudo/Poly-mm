"""Rich terminal dashboard: launch feed, decisions, positions and action log."""

from __future__ import annotations

import time
from datetime import datetime

from rich.console import Group
from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .bot import BotState, LaunchRow
from .config import Config
from .executor import PaperExecutor

ACTION_STYLES = {"buy": "bold green", "hold": "yellow", "skip": "red"}
LEVEL_STYLES = {"info": "cyan", "decision": "magenta", "trade": "bold green", "error": "bold red"}


def _ts(t: float) -> str:
    return datetime.fromtimestamp(t).strftime("%H:%M:%S")


def _num(v: float | None, fmt: str = ".6g") -> str:
    return "-" if v is None else format(v, fmt)


def _short(addr: str) -> str:
    return f"{addr[:6]}…{addr[-4:]}"


def _header(state: BotState, config: Config) -> Panel:
    with state.lock:
        status = (
            "[bold red]ERROR[/] " + state.last_error if state.last_error
            else "[bold green]OK[/]" if state.last_poll else "[yellow]connecting…[/]"
        )
        line = (
            f"chain [bold]{state.chain_id or '?'}[/]  head [bold]{state.head_block or '?'}[/]  "
            f"pools seen [bold]{state.pools_seen}[/]  "
            f"last poll {_ts(state.last_poll) if state.last_poll else '-'}  status {status}"
        )
    r = config.risk
    gates = (f"gates: confidence ≥ {r.min_confidence:g} · risk ≤ {r.max_risk_score:g} · "
             f"liquidity ≥ {r.min_liquidity:g} quote · paper size {config.paper_trade_size:g}")
    return Panel(Group(Text.from_markup(line), Text(gates, style="dim")),
                 title="Robinhood Chain memecoin monitor [dim](paper trading)[/]",
                 border_style="blue")


def _launches(rows: list[LaunchRow], limit: int) -> Panel:
    table = Table(expand=True, show_edge=False, header_style="bold")
    table.add_column("seen", width=8)
    table.add_column("block", justify="right")
    table.add_column("pool")
    table.add_column("token")
    table.add_column("fee", justify="right")
    table.add_column("price", justify="right")
    table.add_column("liq (quote)", justify="right")
    table.add_column("b/s", justify="right")
    table.add_column("risk", justify="right")
    table.add_column("engine")
    table.add_column("final")
    table.add_column("notes", overflow="fold", ratio=2)
    for row in rows[:limit]:
        dec = row.decision
        engine = (Text(f"{dec['action']} {dec['confidence']:.2f}",
                       style=ACTION_STYLES.get(dec["action"], ""))
                  if dec else Text("pending", style="dim"))
        final = Text(row.final_action or "-", style=ACTION_STYLES.get(row.final_action or "", ""))
        eff = row.risk_score
        if row.engine_risk is not None and eff is not None:
            eff = max(eff, row.engine_risk)
        risk = Text(_num(eff, ".2f") + ("*" if row.engine_risk is not None else ""),
                    style="red" if (eff or 0) > 0.5 else "green")
        flow = "-" if row.buys is None else f"{row.buys}/{row.sells}"
        notes = row.error or "; ".join(row.gate_reasons) or ", ".join(row.risk_flags)
        table.add_row(
            _ts(row.seen_at), str(row.event.block_number), _short(row.event.pool),
            row.symbol or "?", str(row.event.fee), _num(row.price),
            _num(row.quote_reserve, ".4g"), flow, risk, engine, final, notes,
        )
    if not rows:
        table.add_row(*(["-"] * 2), Text("waiting for PoolCreated events…", style="dim"),
                      *([""] * 9))
    return Panel(table, title="New pool launches  [dim](b/s = buys/sells · risk* = includes engine score)[/]",
                 border_style="cyan")


def _positions(executor: PaperExecutor) -> Panel:
    table = Table(expand=True, show_edge=False, header_style="bold")
    for col in ("id", "opened", "token", "entry", "last", "qty", "size", "PnL %", "conf"):
        table.add_column(col, justify="right" if col not in ("id", "token") else "left",
                         no_wrap=True, min_width=8 if col in ("id", "opened") else None)
    for p in sorted(executor.open_positions(), key=lambda p: p.opened_at, reverse=True):
        pnl = p.pnl_pct
        table.add_row(
            p.id, _ts(p.opened_at), p.symbol or _short(p.token), _num(p.entry_price),
            _num(p.last_price), _num(p.quantity), _num(p.size_quote, "g"),
            Text(_num(pnl, "+.2f"), style="green" if (pnl or 0) >= 0 else "red"),
            f"{p.confidence:.2f}",
        )
    return Panel(table, title="Paper positions", border_style="green")


def _actions(state: BotState, limit: int) -> Panel:
    with state.lock:
        entries = list(state.actions)[-limit:]
    text = Text()
    for ts, level, msg in reversed(entries):
        text.append(f"{_ts(ts)} ", style="dim")
        text.append(f"{level:<8} ", style=LEVEL_STYLES.get(level, ""))
        text.append(msg + "\n")
    return Panel(text, title="Action log", border_style="magenta")


def render(state: BotState, executor: PaperExecutor, config: Config,
           height: int | None = None) -> Layout:
    """Build the full-screen layout from a consistent snapshot of state."""
    with state.lock:
        rows = list(state.launches)
    h = height or 40
    feed_rows = max(5, (h - 12) // 2)

    layout = Layout()
    layout.split_column(
        Layout(_header(state, config), name="header", size=4),
        Layout(_launches(rows, feed_rows), name="feed", ratio=3),
        Layout(name="bottom", ratio=2),
    )
    layout["bottom"].split_row(
        Layout(_positions(executor), name="positions"),
        Layout(_actions(state, max(5, h // 3)), name="log"),
    )
    return layout


def run_dashboard(state: BotState, executor: PaperExecutor, config: Config,
                  stop, refresh_per_second: float = 4.0) -> None:
    """Render until ``stop`` is set or Ctrl-C is pressed."""
    from rich.console import Console
    from rich.live import Live

    console = Console()
    with Live(render(state, executor, config, console.height), console=console,
              screen=True, refresh_per_second=refresh_per_second) as live:
        try:
            while not stop.is_set():
                live.update(render(state, executor, config, console.height))
                time.sleep(1.0 / refresh_per_second)
        except KeyboardInterrupt:
            stop.set()
