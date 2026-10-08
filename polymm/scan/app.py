"""Desktop dashboard for the scanner.

    python -m polymm.scan.app              # live scan, opens your browser
    python -m polymm.scan.app --offline    # demo on the bundled sample data

Runs a tiny web server on 127.0.0.1 (this computer only), rescans on a timer
in the background, and serves a page that explains every opportunity in
plain English. Stdlib only; no API keys ever reach the page.
"""

from __future__ import annotations

import json
import threading
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import sources
from .__main__ import build_parser, run_once
from .scanner import post_webhook, to_json

PAGE = Path(__file__).with_name("app.html")


class App:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.state = {
            "opportunities": [], "updated": None, "scanning": False, "log": [],
            "error": None, "counts": {}, "interval": args.interval,
            "mode": "sample data" if args.offline else "live",
        }
        self.seen: set[str] = set()

    def log(self, msg: str) -> None:
        print(msg, flush=True)
        with self.lock:
            self.state["log"] = (self.state["log"] + [f"{datetime.now():%H:%M:%S}  {msg.strip()}"])[-12:]

    def scan_once(self) -> None:
        with self.lock:
            self.state["scanning"], self.state["error"] = True, None
        try:
            snap, opps = run_once(self.args, log=self.log)
            n_pm = sum(c.venue == "polymarket" for c in snap.contracts)
            rows = [to_json(o) for o in opps]
            for r in rows:
                r["new"] = r["key"] not in self.seen
            new = [o for o in opps if o.key not in self.seen]
            self.seen |= {o.key for o in opps}
            with self.lock:
                self.state.update(opportunities=rows, updated=datetime.now().isoformat(timespec="seconds"),
                                  counts={"polymarket": n_pm, "kalshi": len(snap.contracts) - n_pm,
                                          "sportsbook_events": len(snap.odds_events), **snap.stats})
            self.log(f"done: {len(rows)} opportunities")
            if self.args.webhook and new:
                post_webhook(self.args.webhook, new)
        except Exception as e:
            traceback.print_exc()
            with self.lock:
                self.state["error"] = f"{type(e).__name__}: {e}"
        finally:
            with self.lock:
                self.state["scanning"] = False

    def loop(self) -> None:
        while True:
            self.scan_once()
            self.wake.wait(self.args.interval)
            self.wake.clear()

    def snapshot(self) -> bytes:
        with self.lock:
            return json.dumps(self.state, default=str).encode()


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            elif self.path == "/api/state":
                self._send(200, app.snapshot(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self):
            # Same-origin only: a random website can't trigger scans via your browser.
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                return self._send(403, b"forbidden", "text/plain")
            if self.path == "/api/scan":
                if not app.state["scanning"]:
                    app.wake.set()
                return self._send(202, b"{}", "application/json")
            self._send(404, b"not found", "text/plain")

        def log_message(self, *a):  # keep the console for scan progress
            pass

    return Handler


def main() -> None:
    ap = build_parser(__doc__)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--interval", type=float, default=300, help="seconds between automatic rescans")
    ap.add_argument("--no-browser", action="store_true")
    ap.set_defaults(top=200)
    args = ap.parse_args()

    app = App(args)
    sources.progress = app.log
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(app))
    url = f"http://127.0.0.1:{args.port}/"
    threading.Thread(target=app.loop, daemon=True).start()
    print(f"\n  Scanner running at {url}\n  (keep this window open; close it or press Ctrl+C to stop)\n", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
