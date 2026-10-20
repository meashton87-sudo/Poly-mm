"""The daily bot check of the live site (.github/workflows/daily-check.yml): bots play the game where players do, at its
real address, in Chromium (a desktop and an Android phone) and in WebKit as an iPhone (Oct 19: an outage on iPhones
only, a cache handing an older game.js to a newer page), and the engine plays thousands of whole drives on the data the
site serves today. What they find goes in a report for the daily review (daily_check_report.json, and a short .md):
bots finding something is not a failure of the check, only the harness breaking is (exit 1).

    python scripts/daily_check.py browsers --live https://nfl2mindrill.com --browser webkit [--minutes 40] [--jobs 3]
    python scripts/daily_check.py engine --live https://nfl2mindrill.com [--procs 3]
    python scripts/daily_check.py report          # what the others left in --out (default daily_check_out), merged

browsers plays browser_test.py's episodes (its driver, pointed at the live address: the day's drive, both sides of a
two-sided day, the coming week's drives, survivor, practice, a Pro scenario, reloads mid-drive, rapid taps, an older
Safari, private browsing) for --minutes, and the Pro screen, the scenario builder and the community list once; it
times the first paint and the first call and counts what a player has to work around (friction). engine checks every
file the page names against its stamp (what is in it: site.py stamps_of; the Oct 19 outage was a file served under
another build's stamp) and runs web/game_smoke.js and web/game_sweep.js on those very files.

The bots never touch what is real behind the site. Every request the page makes to a host other than the site's own
is cut off before it leaves the browser: every ad and analytics request (a bot's ad impressions would get the site's ad
accounts banned), Google sign-in, Stripe. The page is told its board (board/worker.js) is at STUB, a host that exists
nowhere, which browser_test.py's stub answers; a request for the real board (the address in the page's
<meta name="board-api">, and --block) is cut off and reported. No purchase, no sign-in, no email: the Pro screen is
opened, never bought from; a scenario is played with Pro faked by the stub. Each browser first checks all this on
itself (selftest: a request of every kind, to hosts that don't exist) and stops, failing, if one got past.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # nfl-time-management
STUB = "https://board.stub.invalid"     # the board the live pages are told about (.invalid: no such host, anywhere)
TZ = "America/New_York"                 # the bots' clock (most players' day: the daily turns over at local midnight)
UA = "two-minute-drill-daily-check (GitHub Actions; the site's own test bots)"
# ad networks and analytics, by host (everything off the site is cut off anyway: this only names what was cut)
AD = re.compile(r"googlesyndication|doubleclick|google-analytics|googletagmanager|gtag|adservice|adsystem|adtrafficquality|"
                r"googleads|ezojs|ezoic|gatekeeperconsent|adstxtmanager|adsterra|criteo|taboola|outbrain|pubmatic|rubicon|"
                r"scorecardresearch|quantserve", re.I)
AD_PATH = re.compile(r"^/(?:ad-[^/]*\.html|ads\.txt)$", re.I)      # the site's own ad frames (site.py ad-<slot>.html)
BOARD_META = re.compile(r'<meta name="board-api"[^>]*>')
# what plays the phone in each browser, and how many of every 5 episodes are on the phone (WebKit: mostly the iPhone)
PROFILES = {"chromium": {"phone": "Pixel 7", "phone_name": "android", "desktop_name": "desktop", "phones": 2},
            "webkit": {"phone": "iPhone 13", "phone_name": "iphone", "desktop_name": "mac", "phones": 4}}
# each browser's episodes in turn, for as long as it has (job_of says what each is); the first one is browser_test.py's
# drawing sweep instead (short fields and thousands of drawn plays on the page), and a site without Pro plays no scenario
KINDS = ["daily", "side", "survivor", "rapid", "practice", "reload", "future", "side", "scenario", "daily", "rapid",
         "nopack", "survivor", "future", "nostore", "reload", "practice"]


EPISODE_CAP = {"draw": 1800}            # s an episode may take, at most (browser_test.py stops its own at 900 s of play)


def kind_of(i: int, pro: bool, kinds: list[str] | None = None) -> str:
    k = kinds[i % len(kinds)] if kinds else "draw" if i == 0 else KINDS[(i - 1) % len(KINDS)]
    return "daily" if k == "scenario" and not pro else k


class Harness(Exception):
    """The check itself is broken (not something it found): exit 1."""


# ---- the live site's files (urllib: no browser, nothing but GETs of the site's own static files)
def get(url: str, tries: int = 3, timeout: int = 60) -> tuple[int, dict, bytes]:
    """A GET, tried again on a network error (an HTTP status is an answer): status, headers, body."""
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, {h.lower(): v for h, v in r.headers.items()}, r.read()
        except urllib.error.HTTPError as e:
            return e.code, {h.lower(): v for h, v in e.headers.items()}, e.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if k == tries - 1:
                raise
            print(f"  {url}: {e}; again", flush=True)
            time.sleep(3 + 5 * k)
    raise AssertionError


def meta(page: str, name: str) -> str | None:
    m = re.search(r'<meta name="%s" content=(?:"([^"]*)"|\'([^\']*)\')' % re.escape(name), page)
    return None if not m else html.unescape(m.group(1) if m.group(1) is not None else m.group(2))


stamp_of = lambda b: hashlib.sha256(b).hexdigest()[:12]       # site.py _stamp


def parsed(b: bytes):
    """JSON, or None (Pages answers a file that is gone with the front page)."""
    try:
        return json.loads(b)
    except ValueError:
        return None


def site_facts(base: str) -> dict:
    """What the live front page says about itself: its build, every file's stamp, the board's address, what is on."""
    st, hd, body = get(base + "/")
    if st != 200:
        raise Harness(f"{base}/ answered {st}")
    page = body.decode("utf-8", "replace")
    try:
        stamps = json.loads(meta(page, "stamps") or "")
    except ValueError:
        raise Harness(f'{base}/ has no <meta name="stamps"> daily_check.py can read (site.py changed?)') from None
    script = re.search(r'<script src="/?(game\.([0-9a-f]{12})\.js)"', page)
    f = {"base": base, "build": meta(page, "build"), "board": meta(page, "board-api"), "stamps": stamps,
         "script": script.group(1) if script else None, "script_stamp": script.group(2) if script else None,
         "on": {n: meta(page, n) for n in ("pro", "pro-at", "scn-at", "fulldef", "vs", "ezoic", "ads-src", "ad-slot", "ad-frame",
                                           "google-client-id") if meta(page, n) is not None},
         "page_kb": round(len(body) / 1024), "page_cache": hd.get("cache-control")}
    st, _, v = get(base + "/version.json")
    try:
        f["version"] = json.loads(v) if st == 200 else None
    except ValueError:
        f["version"] = None
    st, _, sw = get(base + "/sw.js")
    sw = sw.decode("utf-8", "replace") if st == 200 else ""
    m, b = re.search(r"const STAMPS = (\{.*?\});", sw), re.search(r"const VERSION = '([^']*)'", sw)
    f["sw_stamps"], f["sw_build"] = ((parsed(m.group(1).encode()) or {}) if m else {}), (b.group(1) if b else None)
    return f


def immutable_patterns() -> list[str]:
    """site.py's IMMUTABLE (the addresses cached for good), read from its source: no numpy here."""
    for n in ast.parse((ROOT / "scripts" / "site.py").read_text()).body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "IMMUTABLE" for t in n.targets):
            return ast.literal_eval(n.value)
    raise Harness("site.py has no IMMUTABLE list")


def today_n(game: dict) -> int:
    """Today's day number on the bots' clock (game.js dayOf: day 1 is the launch)."""
    try:
        from zoneinfo import ZoneInfo
        d = datetime.now(ZoneInfo(TZ)).date()
    except Exception:            # (no time zone data: the runner's UTC date, the same day at 10:00 UTC)
        d = datetime.now(timezone.utc).date()
    return (d - date.fromisoformat(game["launch"])).days + 1


# ---- what every live page's requests go through
class Guard:
    """Every request a live-site context makes, sorted: the site's own files pass (its page told the board is STUB);
    the stub's are answered by browser_test.py's stub; everything else is cut off before it leaves the browser and
    counted (ads and analytics by name; a request for the real board is a leak stopped, and reported)."""

    def __init__(self, base: str, board: list[str]):
        u = urllib.parse.urlsplit(base)
        self.base, self.host = base, u.netloc
        self.hosts = {u.netloc, "www." + u.netloc}
        self.board = [b.rstrip("/") for b in board if b]
        self.counts: dict = {}           # kind -> requests
        self.cut: dict = {}              # host -> requests cut off
        self.stubbed: dict = {}          # "POST /daily" -> requests the stub answered
        self.leaks: list[str] = []       # requests for the real board (cut off)
        self.slow: list[list] = []       # the site's own files that took over 3 s
        self.canary: set = set()         # selftest's requests the routes saw
        self.ws: list[str] = []          # WebSockets (cut off)
        self.rewritten = 0               # pages told the board is the stub

    def kind(self, url: str) -> str:
        u = urllib.parse.urlsplit(url)
        bare = re.sub(r"^ws(s?)://", r"http\1://", url.split("?")[0].split("#")[0].rstrip("/"))     # (a WebSocket to the board too)
        if u.netloc == urllib.parse.urlsplit(STUB).netloc:
            return "stub"
        if any(bare == b or bare.startswith(b + "/") for b in self.board):
            return "board"
        if u.netloc in self.hosts:
            if u.path.startswith("/__board/"):          # (browser_test.py's Pro stub, on the page's own address)
                return "stub"
            return "adframe" if AD_PATH.match(u.path) else "site"
        return "ad" if AD.search(u.netloc) else "other"

    def cut_off(self, url: str) -> bool:
        """Whether the guard cuts this address off (a console error or a failed request for it is the guard's doing)."""
        return url.startswith(("http://", "https://", "ws://", "wss://")) and self.kind(url) not in ("site", "stub")

    async def attach(self, ctx) -> None:
        ctx.on("request", self.saw)
        ctx.on("requestfinished", self.done)
        await ctx.route("**/*", self.route)
        if hasattr(ctx, "route_web_socket"):         # (Playwright 1.48 on: else the selftest's WebSocket gets past it)
            await ctx.route_web_socket(re.compile(".*"), self.socket)
        # a beacon goes as a fetch (the routes see every fetch; a browser may send a beacon past them)
        await ctx.add_init_script("""try { const f = window.fetch.bind(window); Object.defineProperty(navigator, 'sendBeacon', {
          configurable: true, value: (u, d) => { f(u, { method: 'POST', body: d }).catch(() => {}); return true; } }); } catch (e) { /* none */ }""")

    def saw(self, req) -> None:
        k, u = self.kind(req.url), urllib.parse.urlsplit(req.url)
        self.counts[k] = self.counts.get(k, 0) + 1
        if k in ("ad", "other", "adframe"):
            self.cut[u.netloc] = self.cut.get(u.netloc, 0) + 1
        elif k == "board":
            self.leaks.append(f"{req.method} {req.url[:160]}")
        elif k == "stub":
            p = f"{req.method} {u.path.removeprefix('/__board')}"
            self.stubbed[p] = self.stubbed.get(p, 0) + 1

    def done(self, req) -> None:
        try:
            t = req.timing
            if self.kind(req.url) == "site" and t.get("responseEnd", -1) > 3000 and len(self.slow) < 20:
                self.slow.append([urllib.parse.urlsplit(req.url).path, round(t["responseEnd"])])
        except Exception:
            pass

    async def route(self, route) -> None:
        req = route.request
        if "canary=" in req.url:
            self.canary.add(urllib.parse.parse_qs(urllib.parse.urlsplit(req.url).query).get("canary", ["?"])[0])
        k = self.kind(req.url)
        if k == "site":
            if req.resource_type != "document":
                return await route.continue_()
            # the page itself: its board's address goes, the stub's in its place (a page with none is left so)
            import browser_test as BT
            r = await route.fetch()
            body = await r.text() if "html" in r.headers.get("content-type", "") else None
            if body is None or not BOARD_META.search(body):
                return await route.fulfill(status=r.status, headers=BT.rewritten(r), body=await r.body())
            self.rewritten += 1
            return await route.fulfill(status=r.status, headers=BT.rewritten(r),
                                       body=BOARD_META.sub("", body).replace("<head>", f'<head><meta name="board-api" content="{STUB}">', 1))
        if k == "stub":
            import browser_test as BT
            # (the stub is another host than the page's: it answers the browser's CORS check as the board does)
            cors = {"access-control-allow-origin": req.headers.get("origin") or "*", "access-control-allow-credentials": "true",
                    "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": req.headers.get("access-control-request-headers") or "content-type"}
            if req.method == "OPTIONS":
                return await route.fulfill(status=204, headers=cors)
            return await BT.board_stub(route, urllib.parse.urlsplit(req.url).path.removeprefix("/__board"), headers=cors)
        await route.abort("blockedbyclient")

    async def socket(self, ws) -> None:
        self.ws.append(ws.url[:160])
        if "canary=" in ws.url:
            self.canary.add(urllib.parse.parse_qs(urllib.parse.urlsplit(ws.url).query).get("canary", ["?"])[0])
        await ws.close()

    def summary(self) -> dict:
        return {"requests": dict(self.counts), "cut": dict(self.cut), "stubbed": dict(self.stubbed), "leaks": self.leaks[:20],
                "websockets": self.ws[:10], "slow": self.slow, "pages_rewritten": self.rewritten}


def merge_guards(gs: list[dict]) -> dict:
    out = {"requests": {}, "cut": {}, "stubbed": {}, "leaks": [], "websockets": [], "slow": [], "pages_rewritten": 0}
    for g in gs:
        for f in ("requests", "cut", "stubbed"):
            for k, v in g.get(f, {}).items():
                out[f][k] = out[f].get(k, 0) + v
        for f in ("leaks", "websockets", "slow"):
            out[f] = (out[f] + g.get(f, []))[:40]
        out["pages_rewritten"] += g.get("pages_rewritten", 0)
    return out


class LiveBrowser:
    """What browser_test.py's episodes take as their browser: every context they open plays as this profile's phone
    (a phone asked for) or a desktop (as asked), with no service worker (the routes see every request), on the bots'
    clock, through a guard."""

    def __init__(self, browser, guard: Guard, phone: dict):
        self.browser, self.guard, self.phone = browser, guard, phone
        self.contexts: list = []

    async def new_context(self, **kw):
        opts = dict(self.phone) if kw.get("is_mobile") else dict(kw)
        opts.update(service_workers="block", timezone_id=TZ, locale="en-US")
        ctx = await self.browser.new_context(**opts)
        self.contexts.append(ctx)
        await self.guard.attach(ctx)
        return ctx

    async def close(self, shot: Path | None = None) -> str | None:
        """Close what an episode left open (one that stopped on an exception), its page shot first."""
        saved = None
        for ctx in self.contexts:
            try:
                if shot and not saved and ctx.pages:
                    await ctx.pages[-1].screenshot(path=str(shot), full_page=True)
                    saved = shot.name
            except Exception:
                pass
            try:
                await ctx.close()
            except Exception:
                pass
        return saved


# a request of every kind a page can make, to hosts that don't exist (an ad's name in some: the guard names them), the
# site's own ad frame, and the stub; the guard has to see each (else it could get past it: the check stops)
CANARY = """async ([stub, site]) => {
  const ad = 'https://googlesyndication.canary.invalid', other = 'https://canary.invalid', ran = [];
  const q = (k) => `?canary=${k}`, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const go = async (k, f) => { try { await Promise.race([f(), wait(4000)]); } catch (e) { /* cut off: as it should be */ } ran.push(k); };
  const tag = (name, attr, url) => new Promise((res) => { const e = document.createElement(name); e.onload = e.onerror = res;
    if (name === 'link') e.rel = 'stylesheet'; e[attr] = url; document.body.append(e); });
  await go('fetch', () => fetch(`${other}/f${q('fetch')}`));
  await go('post', () => fetch(`${ad}/p${q('post')}`, { method: 'POST', body: '{}' }));
  await go('xhr', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('POST', `${other}/x${q('xhr')}`); x.onloadend = res; x.send('{}'); }));
  await go('beacon', () => navigator.sendBeacon(`${ad}/b${q('beacon')}`, '{}'));
  await go('img', () => tag('img', 'src', `${ad}/i.gif${q('img')}`));
  await go('script', () => tag('script', 'src', `${ad}/s.js${q('script')}`));
  await go('css', () => tag('link', 'href', `${other}/c.css${q('css')}`));
  await go('frame', () => tag('iframe', 'src', `${other}/fr.html${q('frame')}`));
  await go('adframe', () => tag('iframe', 'src', `${site}/ad-canary.html${q('adframe')}`));
  await go('ws', () => new Promise((res) => { const w = new WebSocket(`wss://canary.invalid/ws${q('ws')}`); w.onclose = w.onerror = res; }));
  const stubbed = await fetch(`${stub}/daily${q('stub')}`, { method: 'POST', body: '{}' }).then((r) => r.status).catch((e) => String(e));
  return { ran, stubbed, board: (document.querySelector('meta[name="board-api"]') || {}).content || null, html: document.documentElement.outerHTML };
}"""
CANARIES = {"fetch", "post", "xhr", "beacon", "img", "script", "css", "frame", "adframe", "ws", "stub"}


async def selftest(browser, base: str, facts: dict, phone: dict, block: list[str]) -> dict:
    """The guard on this browser, before any episode: the live page loaded as a phone and a desktop (what it asked for
    that was cut off), then the canaries. Any request the guard did not see, a page that still names the real board, or
    a stub that did not answer stops the check."""
    out = {"ok": True, "problems": [], "page": {}}
    for mobile in (True, False):
        g = Guard(base, block)
        lb = LiveBrowser(browser, g, phone)
        try:
            ctx = await lb.new_context(viewport={"width": 1280, "height": 900}, is_mobile=mobile, has_touch=mobile)
            page = await ctx.new_page()
            await page.goto(f"{base}/", timeout=60000)
            await page.wait_for_timeout(6000)             # (the page's own late requests: analytics, ads on idle)
            got = await page.evaluate(CANARY, [STUB, base])
            await page.wait_for_timeout(1500)
            missed = sorted(CANARIES - g.canary - ({"stub"} if got["stubbed"] == 200 else set()))
            if missed:
                out["problems"].append(f"{'phone' if mobile else 'desktop'}: requests the guard never saw (they could get past it): {missed}")
            if got["stubbed"] != 200:
                out["problems"].append(f"{'phone' if mobile else 'desktop'}: the stub did not answer ({got['stubbed']})")
            if facts.get("board") and got["board"] != STUB:
                out["problems"].append(f"the page's board is {got['board']!r}, not the stub")
            for b in block:
                if b.rstrip("/") in got["html"]:
                    out["problems"].append(f"the page still names the real board ({b})")
            if g.leaks:
                out["problems"].append(f"requests for the real board: {g.leaks[:3]}")
            out["page"]["phone" if mobile else "desktop"] = g.summary()
        except Exception as e:
            out["problems"].append(f"{'phone' if mobile else 'desktop'}: {type(e).__name__}: {str(e).splitlines()[0][:200]}")
        finally:
            await lb.close()
    out["ok"] = not out["problems"]
    return out


async def pro_screen(lb: LiveBrowser, base: str) -> list[str]:
    """Pro without Pro, never bought from: the Pro screen (#archive: what it is, Unlock, Restore, Build a scenario and the
    community first) and the scenario builder (#custom: browser_test.py's BUILDER checks)."""
    import browser_test as BT
    out: list[str] = []
    ctx = await lb.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/#archive", timeout=60000)
        await page.wait_for_selector("#arch .pro .btn", timeout=30000)
        got = await page.evaluate("""() => { const a = document.getElementById('arch'), b = a.querySelector('.pro .btn');
          return { text: a.innerText, buy: b ? b.textContent : '', off: b ? b.disabled : true,
            scn: !!a.querySelector("a.scnentry[href='#custom']"), comm: !!a.querySelector("a.scnentry.comm[href='#community']") }; }""")
        if not got["buy"].startswith("Unlock") or got["off"]:
            out.append(f"the Pro screen's Unlock: {got['buy']!r}{' (disabled)' if got['off'] else ''}")
        if not got["scn"] or not got["comm"]:
            out.append("the Pro screen has no Build a scenario or no community entry")
        if BT.BAD_TEXT.search(got["text"]):
            out.append(f"broken text on the Pro screen: {BT.BAD_TEXT.search(got['text']).group(0)!r}")
        async with page.expect_event("load"):
            await page.goto(f"{base}/#custom")
        await page.wait_for_selector("#arch .sacts .btn", timeout=30000)
        b = await page.evaluate(BT.BUILDER)
        out.extend(b["out"] if isinstance(b, dict) else b)
    except Exception as e:
        out.append(f"the Pro screen: {str(e).splitlines()[0][:200]}")
    finally:
        out.extend(errs)
        await ctx.close()
    return out


# ---- the browsers
def job_of(kind: str, i: int, plan: dict) -> dict:
    """One episode's settings: what it plays (browser_test.py episode()), on which day, as a phone or not."""
    j = {"kind": kind, "mode": "daily", "day": 0, "side": None, "target": 1, "practice": False, "rapid": False,
         "reloads_max": 2, "quirk": "", "sweep": False, "mobile": i % 5 < plan["phones"]}
    if kind == "draw":
        j.update(sweep=True, mobile=True)
    elif kind == "side":
        if plan["side_day"] is None:
            j["kind"] = "daily"
        else:                                         # (each side in turn)
            plan["sides"] += 1
            j.update(day=plan["side_day"], side=plan["sides"] % 2)
    elif kind == "survivor":
        j.update(mode="survivor", target=2)
    elif kind == "rapid":
        plan["rapids"] += 1
        j.update(rapid=True, mode="survivor" if plan["rapids"] % 2 else "daily")
    elif kind == "practice":
        j.update(practice=True)
    elif kind == "reload":
        j.update(reloads_max=6)
    elif kind == "future":                            # the coming week's drives, tomorrow's first
        plan["futures"] += 1
        j.update(day=1 + (plan["futures"] - 1) % 7)
    elif kind == "scenario":
        j.update(mode="scenario")
    elif kind in ("nopack", "nostore"):
        j.update(quirk=kind)
    return j


def compact(r: dict) -> dict:
    """An episode's result for the report (the play-by-play logs stay out: field_checks reads them)."""
    keep = ("name", "kind", "profile", "status", "problems", "shot", "finished", "reloads", "steps", "secs", "day", "side",
            "timing", "friction", "jank", "drawn", "sketched", "rundowns", "guard")
    out = {k: r.get(k) for k in keep if k in r}
    if r.get("status") != "ok":
        out["trail"] = r.get("trail", [])[-20:]
    return out


async def browsers(a) -> int:
    import browser_test as BT
    from playwright.async_api import Error as PWError, async_playwright
    out, shots = Path(a.out), Path(a.out) / "shots" / a.browser
    shots.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rep = {"part": "browsers", "browser": a.browser, "site": a.live, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "minutes": a.minutes, "jobs": a.jobs, "harness": [], "episodes": []}
    part = out / f"browsers-{a.browser}.json"

    def save():
        rep["secs"] = round(time.time() - t0)
        part.write_text(json.dumps(rep, indent=1))
    try:
        facts = site_facts(a.live)
        block = sorted({x for x in [facts.get("board"), *a.block] if x})
        game_url = f"{a.live}/game.json?v={facts['stamps'].get('game.json', '')}"
        st, _, gb = get(game_url)
        if st != 200:
            raise Harness(f"{game_url} answered {st}")
        game = json.loads(gb)
        n0 = today_n(game)
        sides = sorted(int(d) for d, f in (game.get("featured") or {}).items() if f.get("sides"))
        ahead = [d for d in sides if d >= n0]
        side_day = (ahead[0] if ahead else sides[-1]) - n0 if sides else None
        st, _, p0 = get(f"{a.live}/spots/p0.json?v={facts['stamps'].get('spots/', '')}")
        first = st == 200 and b'"first":' in p0
        rep.update(build=facts["build"], version=facts.get("version"), on=facts["on"], today=n0, side_day=side_day, board_cut=block)
        print(f"{a.live}: build {facts['build']} (commit {(facts.get('version') or {}).get('commit')}), day {n0}, "
              f"two-sided day {'none' if side_day is None else f'{side_day:+d}'}; the board {block or 'none named'} cut off", flush=True)
    except Harness as e:
        rep["harness"].append(str(e)); save()
        print(f"HARNESS: {e}")
        return 1
    except (urllib.error.URLError, OSError) as e:
        # the site did not answer at all: that is what the report says (the bots have nothing to play)
        rep["unreachable"] = f"{type(e).__name__}: {e}"; save()
        print(f"the site did not answer: {e}")
        return 0
    BT.PAGE = ""                                    # the front door, as players open it (Pages serves / for index.html)
    stamped = (immutable_patterns(), facts["sw_stamps"])
    prof = PROFILES[a.browser]
    plan = {"side_day": side_day, "sides": 0, "rapids": 0, "futures": 0, "phones": prof["phones"]}
    seed0 = date.today().toordinal() % 10000 * 1000
    async with async_playwright() as p:
        kw = {"executable_path": a.executable} if a.executable else {}
        browser = await getattr(p, a.browser).launch(**kw)
        phone = {k: v for k, v in p.devices[prof["phone"]].items() if k != "default_browser_type"}
        rep["version_browser"], rep["phone"] = browser.version, prof["phone"]
        print(f"{a.browser} {browser.version}: phone {prof['phone']} ({phone['viewport']['width']}x{phone['viewport']['height']}), desktop 1280x900", flush=True)
        st = await selftest(browser, a.live, facts, phone, block)
        rep["selftest"] = st
        print("selftest (every kind of request cut off, the page told the board is the stub): " + ("ok" if st["ok"] else "FAIL")
              + "".join(f"\n      {x}" for x in st["problems"]), flush=True)
        if not st["ok"]:
            rep["harness"].append("selftest failed: no episode was played")
            save()
            await browser.close()
            return 1
        BT.CUT = Guard(a.live, block).cut_off           # (what the guard cuts off is not the page's own failure)
        guards: list[dict] = []
        # once: the snap in reach (the phone, a desktop) and, with Pro on the site: Pro without Pro, a scenario's link,
        # the community, a first half played to halftime
        checks, pro_on = {}, "pro" in facts["on"]
        once = [("snap_reach", lambda lb: BT.snap_reach(lb, a.live, ((phone["viewport"]["width"], phone["viewport"]["height"], True), (1280, 900, False))))]
        if pro_on:
            once += [("pro_screen", lambda lb: pro_screen(lb, a.live)), ("scenario_pitch", lambda lb: BT.scenario_pitch(lb, a.live)),
                     ("community", lambda lb: BT.scenario_community(lb, a.live)), ("scenario_half", lambda lb: BT.scenario_half(lb, a.live))]
        for name, fn in once if a.checks else []:
            g = Guard(a.live, block)
            lb = LiveBrowser(browser, g, phone)
            t1 = time.time()
            try:
                res = await asyncio.wait_for(fn(lb), timeout=600)
            except Exception as e:
                res = [f"{type(e).__name__}: {str(e).splitlines()[0][:200] if str(e) else ''}"]
            finally:
                await lb.close()
            checks[name] = {"ok": not res, "problems": res[:8], "secs": round(time.time() - t1), "guard": g.summary()}
            guards.append(g.summary())
            print(f"{name}: " + ("ok" if not res else "FAIL") + "".join(f"\n      {x}" for x in res[:8]), flush=True)
        rep["checks"] = checks
        deadline = t0 + a.minutes * 60
        raw: list[dict] = []
        counter = iter(range(10 ** 6))

        async def run(i: int, j: dict) -> dict:
            mobile = j.pop("mobile")
            pname = prof["phone_name"] if mobile else prof["desktop_name"]
            seed = seed0 + i * 7 + 1
            name = f"{pname}-{j['kind']}-{seed}" + (f"-d{j['day']:+d}" if j["day"] else "")
            g = Guard(a.live, block)
            lb = LiveBrowser(browser, g, phone)
            kind = j.pop("kind")
            t1 = time.time()
            try:
                r = await asyncio.wait_for(BT.episode(lb, a.live, name, seed=seed, out=shots, mobile=mobile, stamped=stamped,
                                                      first=first and j["mode"] == "daily", **j), timeout=EPISODE_CAP.get(kind, 1000))
            except asyncio.TimeoutError:
                r = {"name": name, "status": "fail", "problems": [f"the episode was still going after {EPISODE_CAP.get(kind, 1000)} s"]}
            except PWError as e:          # (a page that never loaded, a browser that crashed: the site's or the browser's)
                r = {"name": name, "status": "fail", "problems": [f"the browser: {str(e).splitlines()[0][:300]}"]}
            except Exception as e:        # (the harness's own bug)
                r = {"name": name, "status": "crash", "problems": [f"{type(e).__name__}: {e}"[:300]]}
                rep["harness"].append(f"{name}: " + traceback.format_exc()[-1500:])
            finally:
                shot = await lb.close(shots / f"{name}.png")
            if r.get("status") != "ok" and not r.get("shot"):
                r["shot"] = shot
            r.update(kind=kind, profile=pname, guard=g.summary(), secs=r.get("secs", round(time.time() - t1)))
            guards.append(r["guard"])
            print(f"{r['status']:5s} {name:34s} {r.get('finished', 0)} games  {r.get('reloads', 0)} reloads  {r['secs']} s"
                  + (f"  first call {r['timing'].get('first_call')} ms" if r.get("timing", {}).get("first_call") else "")
                  + "".join(f"\n      {x}" for x in r.get("problems", [])), flush=True)
            return r

        async def worker():
            while time.time() < deadline - 120 and (not a.episodes or len(raw) + busy[0] < a.episodes):
                i = next(counter)
                busy[0] += 1
                try:
                    raw.append(await run(i, job_of(kind_of(i, pro_on, a.kinds), i, plan)))
                finally:
                    busy[0] -= 1
                save_partial()

        busy = [0]

        def save_partial():
            rep["episodes"] = [compact(r) for r in raw]
            save()
        await asyncio.gather(*(worker() for _ in range(a.jobs)))
        await browser.close()
    # what the plays on the field showed (browser_test.py's checks over every episode), and the guard's totals
    lines, failed = BT.field_checks(raw)
    rep["field"] = {"lines": lines, "failed": failed}
    rep["episodes"] = [compact(r) for r in raw]
    rep["guard"] = merge_guards(guards)
    save()
    bad = [r for r in raw if r["status"] != "ok"]
    print("\n".join(lines))
    print(f"{len(raw) - len(bad)} of {len(raw)} episodes clean in {round((time.time() - t0) / 60)} min; cut off "
          f"{sum(rep['guard']['cut'].values())} requests ({len(rep['guard']['cut'])} hosts), the stub answered "
          f"{sum(rep['guard']['stubbed'].values())}, requests for the real board: {len(rep['guard']['leaks'])}")
    # (an episode the harness itself threw on is its bug, whatever the site did: red, the report says where)
    crashed = sum(1 for r in raw if r["status"] == "crash")
    if not raw or crashed:
        rep["harness"].append(f"{crashed} of {len(raw)} episodes crashed in the harness" if raw else "no episode was played")
        save()
        return 1
    return 0


# ---- the engine on the live data
def fetch_all(urls: list[str]) -> list[tuple[int, dict, bytes]]:
    """GETs, 16 at once (a file that never answered: status 0)."""
    def one(u):
        try:
            return get(u)
        except (urllib.error.URLError, OSError) as e:
            return 0, {"error": str(e)}, b""
    with ThreadPoolExecutor(16) as ex:
        return list(ex.map(one, urls))


def engine(a) -> int:
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rep: dict = {"part": "engine", "site": a.live, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "harness": [], "problems": []}
    part = out / "engine.json"
    save = lambda: part.write_text(json.dumps({**rep, "secs": round(time.time() - t0)}, indent=1))
    try:
        facts = site_facts(a.live)
    except Harness as e:
        rep["harness"].append(str(e)); save()
        return 1
    except (urllib.error.URLError, OSError) as e:
        rep["unreachable"] = f"{type(e).__name__}: {e}"; save()
        return 0
    stamps = facts["stamps"]
    rep.update(build=facts["build"], version=facts.get("version"), script=facts["script"])
    try:
        repo = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        repo = ""
    rep["sweep_scripts"] = repo or None             # (web/game_sweep.js as checked out; the site's own commit in version)
    # every file the page names, by its stamp: the bytes have to be the ones the stamp names (an older copy kept under
    # this build's address, Oct 19, or the front page answering for a file that is gone)
    data = Path(tempfile.mkdtemp(prefix="tmd-live-"))
    stamps = {**{p: v for p, v in facts["sw_stamps"].items() if p.startswith("fonts/")}, **stamps}     # (the fonts: sw.js has them)
    files = sorted(p for p in stamps if p != "spots/")
    got = dict(zip(files, fetch_all([f"{a.live}/{p}?v={stamps[p]}" for p in files])))
    if facts["script"]:
        files.append(facts["script"])
        got[facts["script"]] = fetch_all([f"{a.live}/{facts['script']}"])[0]
    bad, cache = [], {}
    for p in files:
        st, hd, body = got[p]
        want = facts["script_stamp"] if p == facts["script"] else stamps[p]
        cache.setdefault(hd.get("cache-control", "-"), []).append(p)
        if st != 200:
            bad.append(f"{p}: {st}")
        elif stamp_of(body) != want:
            bad.append(f"{p}: holds {stamp_of(body)}, not its stamp {want}" + (" (an HTML page)" if b"<html" in body[:2000].lower() else ""))
        elif p.endswith(".js") and "html" in hd.get("content-type", ""):
            bad.append(f"{p}: served as {hd.get('content-type')}")
    if facts["script"] and facts["script_stamp"] != stamps.get("game.js"):
        bad.append(f"the page names {facts['script']} but its stamps say game.js is {stamps.get('game.js')}")
    if not facts["script"]:
        bad.append("the page names no game.<stamp>.js")
    sw = facts["sw_stamps"]
    if sw and (facts["sw_build"] != facts["build"] or stamp_of(json.dumps(sw, sort_keys=True).encode()) != facts["build"]):
        bad.append(f"sw.js is not the page's build {facts['build']}: it says {facts['sw_build']}, its stamps make "
                   f"{stamp_of(json.dumps(sw, sort_keys=True).encode())}")
    elif sw and any(sw.get(k) != v for k, v in facts["stamps"].items()):
        bad.append("sw.js's stamps are not the page's")
    game = parsed(got["game.json"][2]) if got.get("game.json", (0,))[0] == 200 else None
    if game is None:
        rep["problems"].append("game.json did not load: no sweep")
    # the spots (one stamp for all of them, site.py stamps_of): every chunk and every spot's own file
    spots = {"checked": 0}
    if game:
        n, per = len(game["spots"]), game.get("spot_chunk", 20)
        names = [f"s{k}.json" for k in range(math.ceil(n / per))] + [f"p{i}.json" for i in range(n)]
        sp = dict(zip(names, fetch_all([f"{a.live}/spots/{x}?v={stamps.get('spots/', '')}" for x in names])))
        miss = [x for x in names if sp[x][0] != 200]
        spots.update(checked=len(names), missing=miss[:20])
        if miss:
            bad.append(f"spots: {len(miss)} of {len(names)} files did not load ({miss[:5]})")
        else:
            agg = stamp_of(b"".join(x.encode() + b"\0" + sp[x][2] for x in sorted(names)))
            spots["stamp"] = agg == stamps.get("spots/")
            if not spots["stamp"]:              # (not the same set of files as the build had: say so, check them one by one)
                rep["problems"].append(f"the spots' files together are not their stamp ({agg}, not {stamps.get('spots/')}): checked one by one")
            chunks = {}
            for x in names:
                if x.startswith("s"):
                    chunks.update(parsed(sp[x][2]) or {})
            own = lambda i: {k: v for k, v in ((parsed(sp[f"p{i}.json"][2]) or {}).get(str(i)) or {}).items() if k != "first"}
            off = [i for i in range(n) if own(i) != chunks.get(str(i))]
            spots["differ"] = off[:20]
            if off:
                bad.append(f"spots: {len(off)} spots' own files are not their chunk's (p{off[0]}.json ...)")
        (data / "spots").mkdir()
        for x in names:
            if x.startswith("s") and sp[x][0] == 200:
                (data / "spots" / x).write_bytes(sp[x][2])
    rep["stamps"] = {"checked": len(files), "bad": bad, "cache": {k: (v if len(v) <= 6 else v[:6] + [f"... {len(v) - 6} more"]) for k, v in cache.items()}}
    rep["spots"] = spots
    print(f"{len(files)} stamped files and {spots['checked']} spot files checked: " + ("all as stamped" if not bad else "PROBLEMS") + "".join(f"\n      {x}" for x in bad), flush=True)
    save()
    if not game or a.procs <= 0:                    # (--procs 0: the files only)
        shutil.rmtree(data, ignore_errors=True)
        return 0
    # the sweeps on those very files (the scripts as checked out, beside them: they read their own folder)
    for p in ["engine.js", "engine_data.json", "playbook.json", "game.json", "scenario.js", *[p for p in stamps if p.startswith("rosters/")]]:
        if p in got and got[p][0] == 200:
            (data / p).parent.mkdir(parents=True, exist_ok=True)
            (data / p).write_bytes(got[p][2])
    for s in ("game_smoke.js", "game_sweep.js"):
        shutil.copy2(ROOT / "web" / s, data / s)
    salt0 = date.today().toordinal() % 1000 * a.procs
    runs = [("smoke", ["node", "game_smoke.js"])] + [(f"sweep{k}", ["node", "game_sweep.js", str(a.seeds), str(a.games), str(salt0 + k + 1)]) for k in range(a.procs)]
    # (each writes to its own files: a pipe nobody is reading yet could fill and hold it up)
    procs = {n: (subprocess.Popen(c, cwd=data, stdout=open(data / f"{n}.out", "w"), stderr=open(data / f"{n}.err", "w")), time.time()) for n, c in runs}
    print(f"engine on {data}: {' | '.join(' '.join(c[1:]) for _, c in runs)}", flush=True)
    rep["sweeps"], rep["violations"] = [], {}
    for n, (pr, t1) in procs.items():
        try:
            pr.wait(timeout=max(60, a.minutes * 60 - (time.time() - t0)))
        except subprocess.TimeoutExpired:
            pr.kill()
            pr.wait()
            rep["problems"].append(f"{n}: still going after {a.minutes} min (stopped)")
        so, se = (data / f"{n}.out").read_text(errors="replace"), (data / f"{n}.err").read_text(errors="replace")
        secs = round(time.time() - t1)
        if n == "smoke":
            rep["smoke"] = {"ok": pr.returncode == 0, "secs": secs, "tail": (so + se).strip().splitlines()[-6:]}
            if pr.returncode:
                rep["problems"].append(f"game_smoke.js failed: {(se.strip().splitlines() or ['?'])[-1][:300]}")
            print(f"smoke: {'ok' if pr.returncode == 0 else 'FAIL'} in {secs} s", flush=True)
            continue
        m = re.search(r"(\d+) steps, (\d+) games \((\d+) never ended\), (\d+) overtimes", so)
        viol, cur = {}, None
        for ln in so.splitlines():
            v = re.match(r"VIOLATION (.+): (\d+)$", ln)
            if v:
                cur = viol[v.group(1)] = {"n": int(v.group(2)), "samples": []}
            elif cur is not None and ln.startswith("    "):
                cur["samples"].append(ln.strip()[:400])
        sw = {"name": n, "args": runs[[x for x, _ in runs].index(n)][1][2:], "secs": secs, "exit": pr.returncode, "violations": viol}
        if m:
            sw.update(steps=int(m.group(1)), games=int(m.group(2)), never_ended=int(m.group(3)), overtimes=int(m.group(4)))
        else:                     # (it stopped before its summary: the engine threw on the live data, or the script did)
            sw["crash"] = (se.strip().splitlines() or so.strip().splitlines() or ["?"])[-8:]
            rep["problems"].append(f"{n} stopped before its summary: {sw['crash'][-1][:300]}")
        for k, v in viol.items():
            w = rep["violations"].setdefault(k, {"n": 0, "samples": []})
            w["n"] += v["n"]
            w["samples"] = (w["samples"] + v["samples"])[:6]
        rep["sweeps"].append(sw)
        print(f"{n}: {sw.get('games', '?')} games, {sw.get('steps', '?')} steps in {secs} s, " + (f"{len(viol)} kinds of violation" if viol else "no violations"), flush=True)
    rep["games"] = sum(s.get("games", 0) for s in rep["sweeps"])
    rep["steps"] = sum(s.get("steps", 0) for s in rep["sweeps"])
    save()
    shutil.rmtree(data, ignore_errors=True)
    return 0


# ---- the report
def pct(xs: list, q: float):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    return None if not xs else xs[min(len(xs) - 1, max(0, math.ceil(q * len(xs)) - 1))]


def spread(xs: list) -> dict | None:
    xs = [x for x in xs if isinstance(x, (int, float))]
    return None if not xs else {"n": len(xs), "p50": pct(xs, 0.5), "p90": pct(xs, 0.9), "max": max(xs)}


TIMES = [("home ttfb", lambda t: (t.get("home") or {}).get("ttfb")), ("home fcp", lambda t: (t.get("home") or {}).get("fcp")),
         ("home load", lambda t: (t.get("home") or {}).get("load")), ("drive fcp", lambda t: (t.get("drive") or {}).get("fcp")),
         ("intro", lambda t: t.get("intro")), ("first call", lambda t: t.get("first_call")),
         ("first call (bot's clock)", lambda t: t.get("first_call_wall")), ("back after a reload", lambda t: t.get("reload") or [])]


def browser_summary(b: dict) -> dict:
    """One browser's episodes: counts by profile and kind, every failure, the timings' spread, what got in the way."""
    eps = b.get("episodes", [])
    profs: dict = {}
    for r in eps:
        c = profs.setdefault(r["profile"], {"episodes": 0, "ok": 0, "fail": 0, "crash": 0, "kinds": {}})
        c["episodes"] += 1
        c[r["status"] if r["status"] in ("ok", "crash") else "fail"] += 1
        k = c["kinds"].setdefault(r["kind"], [0, 0])
        k[0] += 1
        k[1] += r["status"] == "ok"
    timing = {}
    for p in profs:
        tt = [r.get("timing") or {} for r in eps if r["profile"] == p]
        timing[p] = {name: spread([y for t in tt for y in (f(t) if isinstance(f(t), list) else [f(t)])]) for name, f in TIMES}
    fails = [{"browser": b["browser"], "name": r["name"], "kind": r["kind"], "profile": r["profile"], "day": r.get("day"),
              "problems": r.get("problems", []), "shot": f"shots/{b['browser']}/{r['shot']}" if r.get("shot") else None}
             for r in eps if r["status"] != "ok"]
    fails += [{"browser": b["browser"], "name": n, "kind": n, "profile": "(a check)", "problems": c["problems"], "shot": None}
              for n, c in (b.get("checks") or {}).items() if not c["ok"]]
    fails += [{"browser": b["browser"], "name": f"field: {n}", "kind": "field", "profile": "(every episode's plays)", "problems": [m[:600]], "shot": None}
              for n, m in ((b.get("field") or {}).get("failed") or {}).items()]
    return {"profiles": profs, "timing": timing, "failures": fails}


def friction_notes(parts: list[dict]) -> list[str]:
    """What the bots could measure of a player's way through, in a few lines."""
    notes = []
    for b in parts:
        eps, br = b.get("episodes", []), b["browser"]
        for p in sorted({r["profile"] for r in eps}):
            ee = [r for r in eps if r["profile"] == p and r.get("friction")]
            if not ee:
                continue
            F = [r["friction"] for r in ee]
            taps = spread([f["taps_to_first_call"] for f, r in zip(F, ee) if (r.get("timing") or {}).get("first_call")])
            fc = spread([(r.get("timing") or {}).get("first_call") for r in ee])
            snap, out = sum(f["snap"] for f in F), sum(f["snap_out"] for f in F)
            why = [w for f in F for w in f["snap_why"]][:2]
            modals = [m for f in F for m in f["modals"]]
            waits = spread([round(f["wait_max_s"], 1) for f in F])
            miss = sum(f["covered"] for f in F)
            jank = [r["jank"] for r in ee if r.get("jank")]
            line = f"{br} {p}: "
            bits = []
            if taps:
                bits.append(f"taps from the drive's address to the first call: median {taps['p50']}, most {taps['max']}")
            if fc:
                bits.append(f"first call on screen {fc['p50']} ms after the page started (p90 {fc['p90']}, worst {fc['max']})")
            if snap:
                bits.append(f"Snap key out of reach without scrolling {out} of {snap} times" + (f" ({'; '.join(why)})" if out else ""))
            if modals:
                top = sorted({m: modals.count(m) for m in modals}.items(), key=lambda kv: -kv[1])[:2]
                bits.append(f"{len(modals)} screens came up over the game unasked in {sum(1 for f in F if f['modals'])} of {len(F)} episodes "
                            f"({'; '.join(f'{n}x {m[:60]!r}' for m, n in top)})")
            if waits:
                bits.append(f"longest wait on the simulator in an episode: median {waits['p50']} s, worst {waits['max']} s")
            if jank:
                slow = spread([j["slow"] for j in jank])
                bits.append(f"frames over 200 ms: median {slow['p50']} an episode, worst frame {max(j['worst'] for j in jank)} ms"
                            + (f", main-thread tasks over 50 ms: median {spread([j['long'] for j in jank])['p50']}" if any(j["long"] for j in jank) else ""))
            if miss:
                over = [w for f in F for w in f["covered_by"]]
                top = sorted({w: over.count(w) for w in over}.items(), key=lambda kv: -kv[1])[:2]
                bits.append(f"{miss} taps taken by something over what was tapped, in {sum(1 for f in F if f['covered'])} episodes ("
                            + "; ".join(f"{w[:80]} {n}x" for w, n in top) + ")")
            if bits:
                notes.append(line + "; ".join(bits))
        g = b.get("guard") or {}
        if g.get("slow"):
            notes.append(f"{br}: the site's files that took over 3 s: " + ", ".join(f"{p} {ms} ms" for p, ms in g["slow"][:6]))
    return notes


def report(a) -> int:
    out = Path(a.out)
    parts = [json.loads(p.read_text()) for p in sorted(out.glob("browsers-*.json"))]
    eng = json.loads((out / "engine.json").read_text()) if (out / "engine.json").exists() else None
    harness = [f"{p['browser']}: {h}" for p in parts for h in p.get("harness", [])] + [f"engine: {h}" for h in (eng or {}).get("harness", [])]
    harness += [f"{p['browser']}: stopped before its end ({len(p.get('episodes', []))} episodes reported)" for p in parts
                if "field" not in p and not p.get("harness") and not p.get("unreachable")]
    for want in a.expect:
        if want == "engine" and eng is None or want != "engine" and not any(p["browser"] == want for p in parts):
            harness.append(f"{want}: no report (its job stopped before writing one)")
    unreachable = [f"{p['browser']}: {p['unreachable']}" for p in parts if p.get("unreachable")] + ([f"engine: {eng['unreachable']}"] if eng and eng.get("unreachable") else [])
    sums = {p["browser"]: browser_summary(p) for p in parts}
    failures = [f for s in sums.values() for f in s["failures"]]
    stamps_bad = (eng or {}).get("stamps", {}).get("bad", [])
    viol = (eng or {}).get("violations", {})
    leaks = [x for p in parts for x in (p.get("guard") or {}).get("leaks", [])]
    first = next((p for p in parts if p.get("build")), eng or {})
    n_problems = len(failures) + len(stamps_bad) + len(viol) + len((eng or {}).get("problems", [])) + len(leaks) + len(unreachable)
    R = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "site": first.get("site"), "build": first.get("build"), "version": first.get("version"),
        "run": os.environ.get("GITHUB_SERVER_URL", "") and f"{os.environ['GITHUB_SERVER_URL']}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
        "verdict": "clean" if not n_problems and not harness else ("problems found" if n_problems else "harness trouble"),
        "problems": n_problems, "unreachable": unreachable, "harness": harness,
        "browsers": {p["browser"]: {"version": p.get("version_browser"), "phone": p.get("phone"), "today": p.get("today"),
                                    "side_day": p.get("side_day"), "minutes": round(p.get("secs", 0) / 60), **sums[p["browser"]],
                                    "checks": {k: {"ok": v["ok"], "problems": v["problems"]} for k, v in (p.get("checks") or {}).items()},
                                    "field": (p.get("field") or {}).get("lines", []), "selftest": (p.get("selftest") or {}).get("ok"),
                                    "safety": p.get("guard"), "episodes": p.get("episodes", [])} for p in parts},
        "failures": failures,
        "engine": None if eng is None else {k: eng.get(k) for k in ("build", "version", "sweep_scripts", "stamps", "spots", "smoke", "sweeps", "games", "steps", "violations", "problems", "secs")},
        "friction": friction_notes(parts),
    }
    (out / "daily_check_report.json").write_text(json.dumps(R, indent=1))
    md = markdown(R)
    (out / "daily_check_report.md").write_text(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(md + "\n")
    print(md)
    return 0


def markdown(R: dict) -> str:
    v = R.get("version") or {}
    L = [f"# Two-Minute Drill daily bot check, {R['generated'][:10]}", "",
         f"{R.get('site')}: build `{R.get('build')}`, commit `{(v.get('commit') or '?')[:10]}`, data built {v.get('data_built') or '?'}. "
         f"**{R['verdict'].capitalize()}**" + (f": {R['problems']} problem{'s' * (R['problems'] != 1)}." if R["problems"] else ".")
         + (f" [The run]({R['run']})." if R.get("run") else ""), ""]
    for x in R["unreachable"]:
        L.append(f"- **The site did not answer** ({x})")
    for x in R["harness"]:
        L.append(f"- **Harness:** {x[:300]}")
    if R["unreachable"] or R["harness"]:
        L.append("")
    L += ["| Browser | Episodes | Clean | Failed | Kinds (clean/played) |", "|---|---|---|---|---|"]
    for br, b in R["browsers"].items():
        for p, c in b["profiles"].items():
            dev = b["phone"] if p in ("iphone", "android") else "desktop 1280x900"
            L.append(f"| {br} {b.get('version') or ''} {p} ({dev}) | {c['episodes']} | {c['ok']} | {c['fail'] + c['crash']} | "
                     + ", ".join(f"{k} {n[1]}/{n[0]}" for k, n in sorted(c["kinds"].items())) + " |")
    e = R.get("engine")
    if e:
        smoke = {True: "ok", False: "FAILED"}.get((e.get("smoke") or {}).get("ok"), "not run")
        L.append(f"| engine (live data) | {e.get('games') or 0:,} games, {e.get('steps') or 0:,} steps | | {len(e.get('violations') or {})} kinds of violation | smoke {smoke} |")
    L.append("")
    if R["failures"]:
        # (the same problem in many episodes once, with where it came up and one screenshot; every one in the .json)
        L += ["## Failures", ""]
        groups: dict = {}
        for f in R["failures"]:
            groups.setdefault(re.sub(r"\d+", "#", (f["problems"] or ["?"])[0])[:120], []).append(f)
        for fs in list(groups.values())[:30]:
            f, where = fs[0], sorted({f"{x['browser']} {x['profile']}" for x in fs})
            day = "" if f.get("day") in (None, 0) else f", day {f['day']:+d}"
            shot = next((x["shot"] for x in fs if x.get("shot")), None)
            L.append(f"- **{len(fs)}x** in {', '.join(where)}, e.g. {f['name']} ({f['kind']}{day}): "
                     + " / ".join(x[:240] for x in f["problems"][:3]) + (f" Screenshot: `{shot}`" if shot else ""))
        if len(groups) > 30:
            L.append(f"- ... {len(groups) - 30} more kinds in daily_check_report.json")
        L.append("")
    if e and (e.get("stamps", {}).get("bad") or e.get("violations") or e.get("problems")):
        L += ["## Live files and engine", ""]
        L += [f"- File: {x}" for x in e.get("stamps", {}).get("bad", [])[:10]]
        L += [f"- {x}" for x in e.get("problems", [])[:10]]
        L += [f"- Violation **{k}** x{w['n']}: `{(w['samples'] or [''])[0][:200]}`" for k, w in list(e.get("violations", {}).items())[:15]]
        L.append("")
    L += ["## Timing (ms: p50 / p90 / worst)", "", "| Profile | " + " | ".join(n for n, _ in TIMES) + " |", "|---" * (len(TIMES) + 1) + "|"]
    for br, b in R["browsers"].items():
        for p, t in b["timing"].items():
            L.append(f"| {br} {p} | " + " | ".join("-" if not t.get(n) else f"{t[n]['p50']} / {t[n]['p90']} / {t[n]['max']}" for n, _ in TIMES) + " |")
    L.append("")
    if R["friction"]:
        L += ["## Friction", ""] + [f"- {x}" for x in R["friction"]] + [""]
    L += ["## Safety", ""]
    for br, b in R["browsers"].items():
        s = b.get("safety") or {}
        cut = s.get("cut", {})
        ads = sum(n for h, n in cut.items() if AD.search(h))
        L.append(f"- {br}: selftest {'ok' if b.get('selftest') else 'FAILED'}; cut off {sum(cut.values()):,} requests to {len(cut)} hosts "
                 f"({ads:,} ads and analytics: " + ", ".join(f"{h} {n}" for h, n in sorted(cut.items(), key=lambda kv: -kv[1])[:5]) + "); "
                 f"the stub answered {sum(s.get('stubbed', {}).values()):,} board requests; requests for the real board: **{len(s.get('leaks', []))}**")
    if e:
        L.append(f"- Engine: {e.get('stamps', {}).get('checked', 0)} stamped files and {e.get('spots', {}).get('checked', 0)} spot files fetched and checked against their stamps; sweep scripts from `{(e.get('sweep_scripts') or '?')[:10]}`")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("browsers", help="bots in a real browser on the live site")
    b.add_argument("--live", required=True, help="the site's address (https://nfl2mindrill.com; a local build served over http to try it)")
    b.add_argument("--browser", choices=sorted(PROFILES), default="chromium")
    b.add_argument("--minutes", type=float, default=40, help="new episodes start until this long after the start (each then plays out)")
    b.add_argument("--jobs", type=int, default=3, help="episodes at once")
    b.add_argument("--episodes", type=int, default=0, help="at most this many episodes (0: as many as the minutes allow)")
    b.add_argument("--kinds", type=lambda x: x.split(","), help="only these kinds of episode, in turn (e.g. practice,rapid; default: all, the drawing sweep first)")
    b.add_argument("--no-checks", dest="checks", action="store_false", help="skip the one-off checks (the snap in reach, Pro without Pro)")
    b.add_argument("--block", action="append", default=[], help="another address of the real board to cut off (the page's own always is)")
    b.add_argument("--executable", help="the browser's binary (default: Playwright's)")
    e = sub.add_parser("engine", help="the stamped files checked, and the engine sweeps on them")
    e.add_argument("--live", required=True)
    e.add_argument("--procs", type=int, default=3, help="game_sweep.js runs at once, each on its own seeds (0: check the files only)")
    e.add_argument("--seeds", type=int, default=2, help="game_sweep.js: seeds per call")
    e.add_argument("--games", type=int, default=4, help="game_sweep.js: whole games per spot")
    e.add_argument("--minutes", type=float, default=50, help="the most the sweeps may take")
    r = sub.add_parser("report", help="the parts in --out merged into daily_check_report.json and .md")
    r.add_argument("--expect", nargs="*", default=[], help="parts that should be there (chromium webkit engine): a missing one is said")
    for x in (b, e, r):
        x.add_argument("--out", default="daily_check_out")
    a = ap.parse_args()
    if getattr(a, "live", None):
        a.live = a.live.rstrip("/")
    Path(a.out).mkdir(parents=True, exist_ok=True)
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        sys.exit(asyncio.run(browsers(a)) if a.cmd == "browsers" else engine(a) if a.cmd == "engine" else report(a))
    except Harness as x:
        print(f"HARNESS: {x}")
        sys.exit(1)
