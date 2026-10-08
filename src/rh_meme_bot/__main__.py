"""Entry point: ``python -m rh_meme_bot`` (or the ``rh-meme-bot`` script)."""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
from pathlib import Path

from .bot import Bot, BotState
from .chain import ChainReader
from .config import Config
from .decision import load_decision_fn
from .executor import PaperExecutor


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="rh-meme-bot", description=__doc__)
    p.add_argument("--env-file", default=None, help="path to .env (default: ./.env)")
    p.add_argument("--no-dashboard", action="store_true",
                   help="print the action log to stdout instead of the TUI")
    p.add_argument("--log-file", default="data/bot.log", help="debug log path")
    p.add_argument("-v", "--verbose", action="store_true", help="debug-level file logging")
    return p.parse_args(argv)


def setup_logging(log_file: str, verbose: bool) -> None:
    Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(log_file, encoding="utf-8")],
    )
    # web3/urllib3 are chatty at DEBUG.
    for noisy in ("web3", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.log_file, args.verbose)
    try:
        config = Config.from_env(args.env_file)
        decide_fn = load_decision_fn(config.decision_engine)
    except (ValueError, ImportError, AttributeError, TypeError) as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    reader = ChainReader(
        rpc_url=config.rpc_url,
        factory_address=config.factory_address,
        expected_chain_id=config.chain_id,
        max_block_range=config.max_block_range,
    )
    executor = PaperExecutor(config.paper_log_path, config.paper_trade_size)
    state = BotState()
    bot = Bot(config, reader, decide_fn, executor, state)

    stop = threading.Event()
    worker = threading.Thread(target=bot.run, args=(stop,), name="bot", daemon=True)
    worker.start()

    if args.no_dashboard:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        printed = 0
        try:
            while not stop.is_set():
                with state.lock:
                    new = min(state.action_count - printed, len(state.actions))
                    entries = list(state.actions)[-new:] if new > 0 else []
                    printed = state.action_count
                for _ts, level, msg in entries:
                    print(f"[{level}] {msg}", flush=True)
                stop.wait(0.5)
        except KeyboardInterrupt:
            stop.set()
    else:
        from .dashboard import run_dashboard
        run_dashboard(state, executor, config, stop)

    stop.set()
    worker.join(timeout=5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
