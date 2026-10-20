"""The address move in a real browser (web/move.js, scripts/site.py --old-domain): the old address hands every player
over to the new one with what this browser keeps for the game, and nobody loses anything.

    python scripts/site.py _site_move --no-minify --domain 2mindrills.com --old-domain nfl2mindrill.com --board-api https://board.example --pro
    python scripts/move_test.py _site_move [--chromium /opt/pw-browsers/chromium]

One local server answers for both addresses (the same build on both, as on Cloudflare Pages: pretty URLs, the front page
for an unknown path); Chromium resolves the two real host names (and www., and a stranger's site) to it. The board API is
a stub that records what the page asks it (Pro's /restore: the code and the device key). Checks: the same path, query
and #hash on the new address; every key carried; the #fragment gone from the address; nothing on the old page but the
handover; the game on the new address with the streak and Pro (the old device key: the same device to the board, not a
new one of its three); what is already on the new address never overwritten (the record merged); Pro's key kept with
Pro; a made-up link (no old address behind it) imports nothing; /move#back=; a large record; the note from a home-screen
icon; the home page's link through /move; an old address with nothing saved.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import sync_playwright

API = "https://board.example"
EVIL = "evil.example"


def serve(root: Path) -> tuple[ThreadingHTTPServer, int]:
    """The site as Cloudflare Pages serves it: /x is x.html, a folder its index.html, anything else the front page."""
    class Pages(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            f = root / path.lstrip("/")
            if path.endswith("/"):
                f = f / "index.html"
            elif not f.is_file() and f.with_name(f.name + ".html").is_file():
                f = f.with_name(f.name + ".html")
            if not f.is_file() or root.resolve() not in f.resolve().parents:
                f = root / "index.html"
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass                     # (the old page left before its own bytes were in: the handover)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Pages)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def day_today(site: Path) -> int:
    """game.js dayOf: the day's number from the launch date (local time, as the browser here)."""
    launch = date.fromisoformat(json.loads((site / "game.json").read_text())["launch"])
    return max(1, (date.today() - launch).days + 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--old", default="nfl2mindrill.com")
    ap.add_argument("--new", default="2mindrills.com")
    ap.add_argument("--chromium", default="/opt/pw-browsers/chromium")
    a = ap.parse_args()
    site = Path(a.site).resolve()
    OLD, NEW = a.old, a.new
    page_html = (site / "index.html").read_text()
    if "tmd-move=" not in page_html or not (site / "move.html").exists():
        print(f"{site}: not built for a move (site.py --domain {NEW} --old-domain {OLD})")
        return 1
    srv, port = serve(site)
    N = day_today(site)
    fails: list[str] = []

    def check(ok, what):
        print(("ok    " if ok else "FAIL  ") + what, flush=True)
        if not ok:
            fails.append(what)

    K1, K2 = "a1" * 18, "b2" * 18
    CODE, CODE2, SESS = "TMD-AAAA-BBBB-CCCC", "TMD-DDDD-EEEE-FFFF", "c3" * 32
    rec = lambda p: {"p": p, "wpa": 0.1, "coach": "Andy Reid"}
    old_stats = {"days": {str(d): rec(0.7) for d in range(N - 5, N)}, "badges": {"first": 1760000000000}, "frozen": {}}
    OLD_DATA = {
        "tmd:v3:boardkey": json.dumps(K1), "tmd:v3:pro": json.dumps({"code": CODE, "at": 1760000000000}),
        "tmd:v3:session": json.dumps(SESS), "tmd:v3:username": json.dumps("mike_g"), "tmd:v3:name": json.dumps("Mike"),
        "tmd:v3:stats": json.dumps(old_stats), "tmd:v3:drives": json.dumps({"3": {"p": 0.93, "won": True, "tries": 2, "at": 1790000000000}}),
        "tmd:v3:runs": json.dumps({"1": {"p": 0.8}}), "tmd:v3:survstats": json.dumps({"runs": 4, "best": 6, "last": 9}),
        "tmd:v3:seen": "true", "tmd:v3:speed": "1.5", "tmd:v3:tour": json.dumps({"done": True}), "tmd:v3:synced": "0",
        f"tmd:v3:day:{N}": json.dumps({"day": N, "i": 1, "decisions": [{"call": "pass_short"}] * 3, "done": False}),
        f"tmd:v3:day:{N - 1}": json.dumps({"day": N - 1, "done": True, "log": ["x" * 2000]}),
        "tmd:v3:tend": json.dumps({"seen": {"a": 1}, "t": {}, "calls": {}, "grade": {}, "n": 1}),
    }
    calls: list[tuple[str, dict]] = []

    def board(route):
        req = route.request
        u = urlsplit(req.url)
        body = {}
        try:
            body = json.loads(req.post_data or "{}")
        except ValueError:
            pass
        calls.append((u.path, body))
        if u.path == "/auth" and req.method == "GET":
            out = (200, {"google": False, "email": False})
        elif u.path == "/auth/me":
            out = (200, {"email": "m@example.com", "name": "mike_g", "pro": False, "leagues": []}) if body.get("session") == SESS else (401, {"error": "signed out"})
        elif u.path == "/restore":
            out = (200, {"ok": True}) if body.get("code") in (CODE, CODE2) else (404, {"error": "no such code"})
        elif u.path == "/auth/stats":
            out = (200, {"stats": {}})
        else:
            out = (503, {"error": "stub"})
        route.fulfill(status=out[0], content_type="application/json", body=json.dumps(out[1]),
                      headers={"Access-Control-Allow-Origin": req.headers.get("origin", "*")})

    def route_all(route):
        host = urlsplit(route.request.url).hostname or ""
        if route.request.url.startswith(API):
            return board(route)
        if urlsplit(route.request.url).path == "/__seed":
            return route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>seed</title>")
        if host in (OLD, "www." + OLD, NEW, "www." + NEW, EVIL):
            return route.continue_()
        return route.abort()

    rules = ",".join(f"MAP {h} 127.0.0.1:{port}" for h in (OLD, "www." + OLD, NEW, "www." + NEW, EVIL))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=a.chromium if Path(a.chromium).exists() else None,
                                    args=[f"--host-resolver-rules={rules}", "--no-proxy-server"])

        def fresh(standalone=False):
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            if standalone:          # opened from a home-screen icon (iOS: navigator.standalone)
                ctx.add_init_script("Object.defineProperty(Navigator.prototype, 'standalone', { get() { return true; } });")
            ctx.route("**/*", route_all)
            pg = ctx.new_page()
            errs: list[str] = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            return ctx, pg, errs

        def seed(pg, host, data):
            pg.goto(f"http://{host}/__seed")
            pg.evaluate("(d) => { localStorage.clear(); for (const k in d) localStorage.setItem(k, d[k]); }", data)

        def dump(pg, host):
            pg.goto(f"http://{host}/__seed")
            return pg.evaluate("() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))")

        def land(pg, url, want):
            try:
                pg.goto(url)
            except Exception:            # (the page went on to the new address before its own load: that is the point)
                pass
            pg.wait_for_url(want, timeout=15000)
            pg.wait_for_load_state("load")
            return pg.url

        # 1. everything comes along, to the same page, query and #hash; the address keeps no #tmd-move
        ctx, pg, errs = fresh()
        seed(pg, OLD, OLD_DATA)
        seen: list[str] = []
        pg.on("request", lambda r: seen.append(r.url))
        url = land(pg, f"http://{OLD}/stats?from=x#top", f"http://{NEW}/stats?from=x#top")
        check(url == f"http://{NEW}/stats?from=x#top", f"the same page, query and #hash on {NEW} ({url})")
        check("tmd-move" not in pg.evaluate("location.href"), "the handover's #fragment is gone from the address")
        old_reqs = [u for u in seen if urlsplit(u).hostname in (OLD, "www." + OLD) and not u.endswith("/favicon.ico")]
        check(old_reqs == [f"http://{OLD}/stats?from=x"], f"nothing but the page on the old address ({old_reqs})")
        got = dump(pg, NEW)
        missing = [k for k, v in OLD_DATA.items() if got.get(k) != v]
        check(not missing, f"every key carried, as it was ({len(OLD_DATA)} keys; differ: {missing})")
        moved = json.loads(got.get("tmd:v3:movedin") or "null")
        check(bool(moved) and moved.get("from") == OLD and not moved.get("s"), f"the move is noted for the game ({moved})")
        # 2. the game on the new address: the streak, the sign-in, Pro checked with the old device key, the note
        calls.clear()
        pg.goto(f"http://{NEW}/")
        pg.wait_for_function("() => /🔥5/.test(document.getElementById('dayLabel').textContent)", timeout=30000)
        check(True, "the game on the new address shows the 5-day streak")
        pg.wait_for_function("() => !document.getElementById('toast').hidden && /new address/.test(document.getElementById('toast').textContent)", timeout=15000)
        check(True, "the game says once that it has a new address")
        rs = [b for path, b in calls if path == "/restore"]
        check(bool(rs) and all(b.get("code") == CODE and b.get("key") == K1 for b in rs),
              f"Pro checked with its code and the old address's device key: the same device, no new slot ({rs})")
        check(any(path == "/auth/me" and b.get("session") == SESS for path, b in calls), "the sign-in carried (the board asked with the session)")
        check(pg.evaluate("localStorage.getItem('tmd:v3:pro')") is not None, "Pro is still there after the board's check")
        pg.reload()
        pg.wait_for_function("() => /🔥5/.test(document.getElementById('dayLabel').textContent)", timeout=30000)
        pg.wait_for_timeout(1500)
        check(pg.evaluate("document.getElementById('toast').hidden || !/new address/.test(document.getElementById('toast').textContent)"),
              "the note is said once (not again on the next load)")
        check(not errs, f"no script errors ({errs[:3]})")
        # 3. back on the old address again (an old bookmark): what the new one changed since stays as it is
        pg.evaluate("localStorage.setItem('tmd:v3:name', JSON.stringify('Mikey')); localStorage.removeItem('tmd:v3:speed')")
        land(pg, f"http://{OLD}/about", f"http://{NEW}/about")
        got = dump(pg, NEW)
        check(got.get("tmd:v3:name") == json.dumps("Mikey"), "a second handover overwrites nothing (the name set on the new address stays)")
        check(got.get("tmd:v3:speed") == "1.5", "and fills only what is empty here")
        ctx.close()

        # 4. the new address already has its own, newer data: kept; the record merged; Pro's key goes with Pro
        ctx, pg, errs = fresh()
        new_stats = {"days": {str(N - 1): rec(0.4), str(N - 9): rec(0.5)}, "badges": {}, "frozen": {}}
        seed(pg, NEW, {"tmd:v3:stats": json.dumps(new_stats), "tmd:v3:name": json.dumps("Newbie"), "tmd:v3:boardkey": json.dumps(K2),
                       "tmd:v3:speed": "2", "tmd:v3:drives": json.dumps({"3": {"p": 0.2}, "5": {"p": 0.6}})})
        seed(pg, OLD, OLD_DATA)
        land(pg, f"http://{OLD}/privacy", f"http://{NEW}/privacy")
        got = dump(pg, NEW)
        st = json.loads(got["tmd:v3:stats"])
        check(st["days"][str(N - 1)] == rec(0.4) and st["days"][str(N - 9)] == rec(0.5), "a day already on the new address stays as it is")
        check(all(st["days"].get(str(d)) == rec(0.7) for d in range(N - 5, N - 1)) and st["badges"].get("first"), "the old address's other days and badges added")
        dr = json.loads(got["tmd:v3:drives"])
        check(dr["3"] == {"p": 0.2} and dr["5"] == {"p": 0.6} and "1" not in dr, "a drive already on the new address stays (the record merged, never replaced)")
        check(got.get("tmd:v3:name") == json.dumps("Newbie") and got.get("tmd:v3:speed") == "2", "the name and settings on the new address stay")
        check(got.get("tmd:v3:pro") == OLD_DATA["tmd:v3:pro"] and got.get("tmd:v3:boardkey") == json.dumps(K1),
              "Pro came over with its device key (no Pro here before: the old key, the same device to the board)")
        ctx.close()
        ctx, pg, errs = fresh()
        own_pro = json.dumps({"code": CODE2, "at": 1})
        seed(pg, NEW, {"tmd:v3:pro": own_pro, "tmd:v3:boardkey": json.dumps(K2)})
        seed(pg, OLD, OLD_DATA)
        land(pg, f"http://{OLD}/", f"http://{NEW}/")
        got = dump(pg, NEW)
        check(got.get("tmd:v3:pro") == own_pro and got.get("tmd:v3:boardkey") == json.dumps(K2), "Pro of the new address's own keeps its own key")
        ctx.close()

        # 5. a link someone made up (no old address behind it): nothing imported, the #fragment gone all the same
        ctx, pg, errs = fresh()
        forged = base64.urlsafe_b64encode(json.dumps({"v": 1, "f": OLD, "s": 0, "h": "survivor", "d": {
            "tmd:v3:session": json.dumps("e" * 64), "tmd:v3:pro": json.dumps({"code": CODE2}), "tmd:v3:name": json.dumps("Mallory")}}).encode()).decode().rstrip("=")
        pg.goto(f"http://{NEW}/about#tmd-move={forged}")
        check(pg.url == f"http://{NEW}/about#survivor", f"a made-up link: the #fragment taken out of the address ({pg.url})")
        check(not [k for k in dump(pg, NEW) if k.startswith("tmd:")], "a made-up link imports nothing (typed, pasted, or from a mail app)")
        pg.goto(f"http://{EVIL}/__seed")
        pg.evaluate(f"(u) => {{ const a = document.createElement('a'); a.href = u; document.body.append(a); a.click(); }}",
                    f"http://{NEW}/privacy#tmd-move={forged}")
        pg.wait_for_url(f"http://{NEW}/privacy*", timeout=15000)
        pg.wait_for_load_state("load")
        check(not [k for k in dump(pg, NEW) if k.startswith("tmd:")], "a made-up link from another site imports nothing")
        ctx.close()

        # 6. /move on the old address: the same handover, back to the page #back= names, only ever on the new address
        ctx, pg, errs = fresh()
        seed(pg, OLD, {"tmd:v3:name": json.dumps("Mike"), "tmd:v3:boardkey": json.dumps(K1)})
        url = land(pg, f"http://{OLD}/move#back=%2Fstats%3Fa%3D1%23league-ABCDEFGH", f"http://{NEW}/stats?a=1#league-ABCDEFGH")
        check(url == f"http://{NEW}/stats?a=1#league-ABCDEFGH" and dump(pg, NEW).get("tmd:v3:name") == json.dumps("Mike"),
              f"/move#back= hands over to that page ({url})")
        url = land(pg, f"http://{OLD}/move#back=%2F%2F{EVIL}%2Fx", f"http://{NEW}/")
        check(url == f"http://{NEW}/", f"/move#back= never leaves the new address ({url})")
        url = land(pg, f"http://{NEW}/move", f"http://{NEW}/")
        check(url == f"http://{NEW}/", "/move on the new address is the front page")
        ctx.close()

        # 7. a large record (old days' drives, 2 MB of them): the essentials and today's drive always come along
        ctx, pg, errs = fresh()
        bulk = dict(OLD_DATA)
        for d in range(1, N - 1):          # (older days than the ones in OLD_DATA: today's is the newest)
            bulk[f"tmd:v3:day:{d}"] = json.dumps({"done": True, "log": ["y" * 100000]})
        seed(pg, "www." + OLD, bulk)        # (www. is its own address to the browser, with its own storage: handed over the same)
        land(pg, f"http://www.{OLD}/privacy", f"http://{NEW}/privacy")       # (a page without the game: the keys as they came)
        got = dump(pg, NEW)
        ess = [k for k in OLD_DATA if not k.startswith("tmd:v3:day:") and k != "tmd:v3:tend"] + [f"tmd:v3:day:{N}"]
        check(all(got.get(k) == OLD_DATA[k] for k in ess), "a large record: the essentials and today's drive came along")
        extra = sum(len(k) + len(v) for k, v in got.items() if k.startswith("tmd:v3:day:") and int(k.rsplit(":", 1)[1]) < N - 1)
        check(0 < extra <= 300000, f"and older days while the link stays under 1 MB ({extra} characters of them)")
        ctx.close()

        # 8. from an old home-screen icon: the steps to put the new one there
        ctx, pg, errs = fresh(standalone=True)
        seed(pg, OLD, OLD_DATA)
        land(pg, f"http://{OLD}/?utm_source=homescreen&utm_medium=pwa", f"http://{NEW}/?utm_source=homescreen&utm_medium=pwa")
        pg.wait_for_function("() => !document.getElementById('modal').hidden && /new address/.test(document.getElementById('mTitle').textContent)", timeout=30000)
        check("add to home screen" in pg.inner_text("#mBody").lower(), "opened from the old home-screen icon: how to add the new one")
        ctx.close()

        # 9. after the old address 301s (its rule leaves /move alone): a player who never came back through it brings
        # their progress from the new home page's link
        ctx, pg, errs = fresh()
        seed(pg, OLD, OLD_DATA)
        pg.goto(f"http://{NEW}/")
        link = pg.get_by_text("Bring your streak and stats over")
        link.wait_for(timeout=30000)
        check(f"Played on {OLD} before?" in pg.inner_text(".hmove"), "nothing saved on the new address: the home page offers to bring it over")
        link.click()
        pg.wait_for_url(f"http://{NEW}/", timeout=15000)
        pg.wait_for_function("() => /🔥5/.test(document.getElementById('dayLabel').textContent)", timeout=30000)
        check(pg.locator(".hmove").count() == 0, "brought over through /move: the streak is here, the link gone")
        check(not errs, f"no script errors ({errs[:3]})")
        ctx.close()

        # 10. nothing saved on the old address: the same page on the new one all the same
        ctx, pg, errs = fresh()
        url = land(pg, f"http://www.{OLD}/how-it-works?x=1#calls", f"http://{NEW}/how-it-works?x=1#calls")
        check(url == f"http://{NEW}/how-it-works?x=1#calls", f"nothing saved: the same page on the new address ({url})")
        ctx.close()
        browser.close()
    srv.shutdown()
    print(f"\n{'all ok' if not fails else f'{len(fails)} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
