"""Play the built website in a real browser like an impatient, curious player, and fail on anything a player would
hit: a script error, a screen that stops moving, a drive or game that never ends, broken text.

    python scripts/browser_test.py _site [--daily 6] [--survivor 6] [--seed 1] [--jobs 3] [--out browser_test_out]

Each daily episode plays one day's drive (the date shifted forward, so every kind of spot comes up); each survivor
episode plays games back to back, starting a new run when one ends, until it has finished that many games. Calls
are random among every button the dock offers (timeouts, spikes, kicks, tempo and routes included), and now and
then the bot opens the help, the stats, the game details or the player ratings mid-play, replays a snap, waits out
an animation instead of skipping it, or reloads the page mid-drive (the drive must pick up where it was).
Needs Playwright with Chromium (pip install playwright; python -m playwright install chromium).
"""
from __future__ import annotations

import argparse
import asyncio
import functools
import math
import http.server
import random
import re
import sys
import threading
import time
from pathlib import Path

from playwright.async_api import async_playwright

STATE = """() => {
  const vis = (id) => { const e = document.getElementById(id); return e && !e.hidden; };
  if (vis('modal')) return 'modal';
  if (vis('deep')) return 'deep';
  if (vis('done') && document.querySelector('#done .big-pct')) return 'summary';
  if (vis('intro') && document.querySelector('#intro .btn')) return 'intro';
  if (!vis('play')) return 'loading';
  if (document.querySelector('#field.playing')) return 'animating';
  const d = document.getElementById('dock');
  if (d.querySelector('.err')) return 'error';
  if (d.querySelector('.endcard')) return 'end';
  if (d.querySelector('.result .btn')) return 'result';
  if (d.querySelector('button')) return 'choose';
  return 'wait';
}"""
# the receivers' dots on the field (page coordinates) and which way is downfield on the screen (+1 down, -1 up)
DOTS = """() => {
  const svg = document.getElementById('field'), M = svg.getScreenCTM();
  const tr = (g) => { const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || ''); return m ? [+m[1], +m[2]] : null; };
  const pt = (q) => { const p = new DOMPoint(q[0], q[1]).matrixTransform(M); return [p.x, p.y]; };
  const me = [...svg.querySelectorAll('g.dot.me')], qb = me.find((g) => /Quarterback/.test(g.getAttribute('aria-label') || ''));
  const rec = me.filter((g) => /Wide receiver|Tight end|Running back/.test(g.getAttribute('aria-label') || '')).map((g) => pt(tr(g)));
  const ball = [...svg.children].find((g) => g.tagName === 'g' && g.querySelector('ellipse'));
  const up = qb && ball ? Math.sign(pt(tr(ball))[1] - pt(tr(qb))[1]) || -1 : -1;
  return { rec, up };
}"""
SNAP = "() => [document.getElementById('dock').innerText, document.getElementById('bar').innerText].join('|')"
BAD_TEXT = re.compile(r"undefined|NaN|\[object|Infinity")
# how long a screen may sit unchanged before it counts as frozen (s); a play's animation runs ~5-15 s
LIMIT = {"animating": 60, "wait": 45, "loading": 60}
STILL = 30


def serve(root: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


# rough browsers real players have: an older Safari with no DecompressionStream (the site falls back to the JSON),
# private browsing where storage throws (the drive plays on, a reload starts it over)
QUIRK = {
    "nopack": "delete window.DecompressionStream;",
    "nostore": """for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { get() {
      throw new DOMException('The operation is insecure.', 'SecurityError'); } });""",
}


async def episode(browser, base: str, name: str, mode: str, seed: int, target: int, out: Path, mobile: bool, quirk: str = "") -> dict:
    rnd = random.Random(seed)
    vp = {"width": 390, "height": 844} if mobile else {"width": 1280, "height": 900}
    ctx = await browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
    day = seed % 9 if mode == "daily" else 0
    # a shifted date (each day's drive), and a seeded Math.random so a failing survivor run can be replayed
    await ctx.add_init_script(f"""(() => {{ const off = {day} * 864e5, _D = Date;
      class D extends _D {{ constructor(...a) {{ super(...(a.length ? a : [_D.now() + off])); }} static now() {{ return _D.now() + off; }} }}
      window.Date = D; window.__sepLog = [];
      let s = {seed} >>> 0; Math.random = () => {{ s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }}; }})();""")
    if quirk:
        await ctx.add_init_script(QUIRK[quirk])
    page = await ctx.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda e: problems.append(f"script error: {e}"))
    page.on("console", lambda m: m.type == "error" and "googletagmanager" not in m.text and "ERR_" not in m.text
            and problems.append(f"console error: {m.text[:300]}"))
    page.on("requestfailed", lambda r: base in r.url and problems.append(f"request failed: {r.url} {r.failure}"))
    url = f"{base}/index.html" + ("#survivor" if mode == "survivor" else "")
    await page.goto(url)
    finished = reloads = steps = rundowns = drawn = 0
    last_key, since, chaos_done = None, time.time(), set()
    trail: list[str] = []            # the last screens and actions, printed with a failure
    first_q = None                   # the quarter a daily drive starts in: a first-half drive ends at halftime
    act = lambda what: trail.append(f"  > {what}")
    t_start = time.time()
    status = "ok"
    try:
        while time.time() - t_start < 900 and steps < 5000:
            steps += 1
            if problems:
                status = "error"
                break
            st = await page.evaluate(STATE)
            key = (st, await page.evaluate(SNAP) if st not in ("loading", "modal", "deep") else "")
            if key != last_key:
                last_key, since = key, time.time()
                txt = key[1]
                trail.append(f"[{st}] {txt[:160]!r}")
                del trail[:-30]
                q = re.search(r"\bQ([1-4])\b", txt.split("|")[-1])
                if mode == "daily" and q:
                    first_q = first_q or int(q.group(1))
                    if first_q <= 2 and int(q.group(1)) >= 3:
                        problems.append(f"a first-half drive went on past halftime (now Q{q.group(1)})")
                        continue
                if BAD_TEXT.search(txt):
                    problems.append(f"broken text on screen ({st}): {BAD_TEXT.search(txt).group(0)!r} in {txt[:200]!r}")
                    continue
            elif time.time() - since > LIMIT.get(st, STILL):
                problems.append(f"frozen: the '{st}' screen did not change for {int(time.time() - since)} s; dock: {key[1][:200]!r}")
                continue
            try:
                if st == "error":
                    problems.append(f"error shown to the player: {key[1][:300]!r}")
                elif st in ("modal", "deep"):
                    await page.wait_for_timeout(rnd.choice([100, 400]))
                    act("close " + st); await page.click("#mClose" if st == "modal" else "#deepClose", timeout=3000)
                elif st == "intro":
                    act("intro Next"); await page.click("#intro .btn", timeout=3000)
                elif st == "animating":
                    if rnd.random() < 0.6:
                        await page.click("#field", timeout=1500)
                elif st == "result":
                    if rnd.random() < 0.08 and await page.locator("#dock .replay").count():
                        await page.click("#dock .replay", timeout=3000)
                    else:
                        await page.click("#dock .result .btn", timeout=3000)
                elif st == "end":
                    finished += 1
                    if mode == "daily" or finished >= target:
                        if mode == "daily":
                            await page.click("#dock .endcard .btn", timeout=3000)
                            continue
                        break
                    await page.click("#dock .endcard .btn", timeout=3000)
                elif st == "summary":
                    # a site built with an ad unit shows one labeled ad on the between-games screens, below the rest
                    if await page.locator('meta[name="ad-slot"]').count() and not await page.locator("#done .adbox ins.adsbygoogle").count():
                        problems.append("ads are on but the results screen has no ad spot")
                        continue
                    # the stats modal: a finished day or run shows how you call it, counting every graded call
                    if "tend" not in chaos_done:
                        chaos_done.add("tend"); act("stats after finishing")
                        await page.click("#statsBtn", timeout=3000)
                        await page.wait_for_timeout(300)
                        calls = await page.evaluate("() => { const b = document.querySelector('#modal .tend .stats b'); return b ? Number(b.textContent) : -1; }")
                        if calls < 1:
                            problems.append(f"the stats modal shows no tendencies after a finished game (calls graded: {calls})")
                        else:
                            print(f"tendencies: {calls} calls graded, {await page.evaluate("() => document.querySelectorAll('#modal .tend .tr').length")} traits")
                        await page.click("#mClose", timeout=3000)
                        await page.wait_for_timeout(200)
                    if mode == "daily":
                        finished = max(finished, 1)
                        break
                    if finished >= target:
                        break
                    await page.get_by_role("button", name="New run").click(timeout=3000)
                elif st == "choose":
                    r = rnd.random()
                    if r < 0.03 and "help" not in chaos_done:
                        chaos_done.add("help"); act("help"); await page.click("#helpBtn", timeout=3000)
                    elif r < 0.06 and "stats" not in chaos_done:
                        chaos_done.add("stats"); act("stats"); await page.click("#statsBtn", timeout=3000)
                    elif r < 0.09 and "deep" not in chaos_done and await page.locator("#deepBtn").is_visible():
                        chaos_done.add("deep"); act("player ratings"); await page.click("#deepBtn", timeout=3000)
                    elif r < 0.12 and "bar" not in chaos_done:
                        chaos_done.add("bar"); act("game details"); await page.click("#bar", timeout=3000)
                    elif await page.locator("#dock .key:visible", has_text="Run it down").count() and rnd.random() < 0.7:
                        # burn the clock to 0:03, timeout, then the kick: the clock must read 0:03 after
                        act("RUN IT DOWN"); rundowns += 1
                        await page.locator("#dock .key:visible", has_text="Run it down").first.click(timeout=3000)
                        # (a tap while the last call was still grading is ignored: only a run-down that happened counts)
                        for _ in range(120):
                            await page.wait_for_timeout(100)
                            if "0:03" in await page.evaluate("() => document.getElementById('bar').innerText"):
                                break
                        else:
                            if "ran it down" in (await page.evaluate("() => document.getElementById('dock').innerText")).lower():
                                problems.append("ran the clock down, but the clock does not read 0:03")
                    elif r < 0.17 and "replay" not in chaos_done and await page.locator("#dock .replay:visible").count() \
                            and await page.locator("#dock .key.big:visible").count():
                        # a call tapped while a replay runs must be taken (it cuts the replay short), never dropped
                        chaos_done.add("replay"); act("replay, then a call")
                        await page.click("#dock .replay", timeout=3000)
                        await page.wait_for_timeout(300)
                        before = await page.evaluate("() => document.getElementById('dock').innerText")
                        await page.locator("#dock .key.big:visible").first.click(timeout=3000)
                        for _ in range(30):
                            await page.wait_for_timeout(100)
                            if await page.evaluate("() => document.getElementById('dock').innerText") != before:
                                break
                        else:
                            problems.append("a call tapped during a replay did nothing")
                    elif await page.locator("#drawBtn:visible").count() and rnd.random() < 0.45:
                        # draw a route: drawing on, a receiver, a line of one to three legs from him (the field takes the drag)
                        act("draw a route")
                        if await page.get_attribute("#drawBtn", "aria-pressed") != "true":
                            await page.click("#drawBtn", timeout=3000)
                        g = await page.evaluate(DOTS)
                        if g["rec"]:
                            x, y = rnd.choice(g["rec"])
                            await page.mouse.move(x, y); await page.mouse.down()
                            for _ in range(rnd.randint(1, 3)):
                                nx, ny = x + rnd.uniform(-90, 90), y + g["up"] * rnd.uniform(-25, 150)
                                for t in range(1, 7):
                                    await page.mouse.move(x + (nx - x) * t / 6, y + (ny - y) * t / 6)
                                x, y = nx, ny
                            await page.mouse.up()
                            drawn += 1
                    elif r < 0.14 and reloads < 2:
                        reloads += 1
                        act("RELOAD")
                        await page.reload()
                        await page.wait_for_timeout(800)
                    else:
                        btns = page.locator("#dock button:visible:not([disabled])")
                        n = await btns.count()
                        if n:
                            # mostly the big calls; sometimes anything (a route, a tempo, a timeout, Back)
                            big = page.locator("#dock .key.big:visible")
                            nb = await big.count()
                            labels = [(await big.nth(i).inner_text()).upper() for i in range(nb)]
                            passes = [i for i, l in enumerate(labels) if l.startswith("PASS")]
                            if passes and rnd.random() < 0.5:       # passes are the busiest plays: throw a lot of them
                                b = big.nth(passes[0]); act("tap PASS"); await b.click(timeout=3000)
                            elif nb and rnd.random() < 0.55:
                                b = big.nth(rnd.randrange(nb)); act("tap " + (await b.inner_text())[:40]); await b.click(timeout=3000)
                            else:
                                b = btns.nth(rnd.randrange(n)); act("tap " + (await b.inner_text())[:40].replace(chr(10), ' ')); await b.click(timeout=3000)
                        else:
                            rcv = page.locator("#field .rcv, #field [data-rcv]")
                            if await rcv.count():
                                await rcv.nth(rnd.randrange(await rcv.count())).click(timeout=3000)
            except Exception:
                pass                     # a button that moved or vanished between looking and clicking: look again
            await page.wait_for_timeout(rnd.choice([30, 60, 120]))
        else:
            problems.append(f"never finished: {finished} of {target} games after {steps} steps")
        if not problems and finished < (1 if mode == "daily" else target):
            problems.append(f"stopped after {finished} of {target} games")
    finally:
        try:
            seps = await page.evaluate("() => window.__sepLog || []")
            tackles = await page.evaluate("() => window.__tackleLog || []")
            fps = await page.evaluate("() => window.__fpLog || []")
            kept = await page.evaluate("() => (window.__drawLog || []).length")
        except Exception:
            seps, tackles, fps, kept = [], [], [], 0
        if problems:
            status = "fail"
            shot = out / f"{name}.png"
            try:
                await page.screenshot(path=str(shot), full_page=True)
            except Exception:
                pass
        await ctx.close()
    return {"name": name, "status": status, "finished": finished, "reloads": reloads, "steps": steps,
            "secs": round(time.time() - t_start), "rundowns": rundowns, "drawn": drawn, "kept": kept, "problems": problems[:5], "seps": seps, "tackles": tackles, "fps": fps, "trail": trail if problems else []}


async def main(a) -> int:
    srv, port = serve(Path(a.site).resolve())
    base = f"http://127.0.0.1:{port}"
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    jobs = [("daily", a.seed + (i * a.day_step), 1) for i in range(a.daily)] + [("survivor", a.seed + 1000 + i, a.games) for i in range(a.survivor)]
    sem = asyncio.Semaphore(a.jobs)
    async with async_playwright() as p:
        kw = {"executable_path": a.chromium} if a.chromium else {}
        browser = await p.chromium.launch(**kw)

        async def run(i, job):
            mode, seed, target = job
            async with sem:
                quirk = ("", "", "nopack", "", "nostore")[i % 5]
                r = await episode(browser, base, f"{mode}-{seed}" + (f"-{quirk}" if quirk else ""), mode, seed, target, out,
                                  mobile=i % 3 != 2, quirk=quirk)
            print(f"{r['status']:5s} {r['name']:24s} games {r['finished']}  reloads {r['reloads']}  {r['secs']} s"
                  + "".join(f"\n      {x}" for x in r["problems"]) + "".join(f"\n        {x}" for x in r["trail"]), flush=True)
            return r
        results = await asyncio.gather(*(run(i, j) for i, j in enumerate(jobs)))
        await browser.close()
    srv.shutdown()
    bad = [r for r in results if r["status"] != "ok"]
    # the field has to match the outcome: an incomplete pass is a covered man or a visibly bad ball, seldom a receiver
    # with nobody near him. Incompletions are drawn contested (game.js separationFor), so about 5% have him 4+ yards
    # clear (a deep ball whose cover man is left behind); before the outcome-driven coverage, 43%. A fixed
    # cut on a CI-sized sample (~15 passes) would fail by chance, so: fail only when the count is very unlikely
    # (p < 0.001) at a 10% rate.
    try:
        import json as _json
        (out / "seps.json").write_text(_json.dumps([x for r in results for x in r.get("seps", [])]))
        (out / "tackles.json").write_text(_json.dumps([x for r in results for x in r.get("tackles", [])]))
        (out / "fps.json").write_text(_json.dumps([x for r in results for x in r.get("fps", [])]))
    except Exception:
        pass
    inc = [x for r in results for x in r.get("seps", []) if not x.get("caught") and not x.get("intc") and x.get("kind") != "hail" and x.get("evt") != "throwaway"]
    open_inc = sum(1 for x in inc if x.get("actual", 0) >= 4)
    print(f"passes logged: {sum(len(r.get('seps', [])) for r in results)}, incomplete: {len(inc)}")
    # "Broken up" needs a defender at the ball (players saw it with nobody near)
    print(f"run it down, timeout at 0:03: tapped {sum(r.get('rundowns', 0) for r in results)} times")
    # a tackled carrier goes down with a defender on him, never alone in the open
    tk = [x for r in results for x in r.get("tackles", [])]
    alone = [x for x in tk if x.get("nd", 0) > 3]
    print(f"tackles: {len(tk)}, nobody within 3 yards: {len(alone)}")
    # (a rare one is tolerated: fail only when this many would be unlikely, p < 0.01, at a 2% rate (7 of 113, as before the fixes, fails); it was 6%
    # before the tackler fixes. A fixed cut on a short CI run fails by chance)
    n_tk = len(tk)
    tail_tk = sum(math.comb(n_tk, k) * 0.02 ** k * 0.98 ** (n_tk - k) for k in range(len(alone), n_tk + 1)) if alone else 1.0
    if alone and tail_tk < 0.01:
        print("FAIL: tackled with nobody near", alone[:5])
        bad.append({"name": "tackles"})
    # forward progress: a carrier never has the ball past where it is spotted (beyond where he got it), so he is
    # never shown driven back from it
    fp = [x for r in results for x in r.get("fps", [])]
    past = [x for x in fp if x.get("over", 0) > 0.5]
    print(f"carries: {len(fp)}, ball carried 0.5+ yards past the spot: {len(past)}" + (f" (worst {max(x['over'] for x in past):.1f})" if past else ""))
    if past:
        print("FAIL: forward progress", past[:5])
        bad.append({"name": "forward-progress"})
    # a short throw with a man running free deep reads as a QB who missed him (players saw it): report how often
    sh = [x for r in results for x in r.get("seps", []) if x.get("caught") and x.get("air", 99) <= 6]
    print(f"short completions: {len(sh)}, with a deep man 5+ yards clear: {sum(1 for x in sh if x.get('openDeep', 0) > 0)}")
    print(f"routes drawn: {sum(r.get('drawn', 0) for r in results)} drags, {sum(r.get('kept', 0) for r in results)} kept as routes (since the last reload)")
    late = sum(1 for r in results for x in r.get("seps", []) if x.get("late"))
    print(f"cover man too far to break it up (shown as a bad ball instead): {late} of {len(inc)} incompletions")
    lonely = [x for r in results for x in r.get("seps", []) if x.get("label") == "Broken up" and x.get("ballD", 0) > 3]
    if lonely:
        print(f"FAIL: {len(lonely)} passes called 'Broken up' with no defender within 3 yards of the ball")
        bad.append({"name": "broken-up"})
    if len(inc) >= 8:
        n = len(inc)
        tail = sum(math.comb(n, k) * 0.10 ** k * 0.90 ** (n - k) for k in range(open_inc, n + 1))
        print(f"incomplete passes with nobody within 4 yards: {open_inc} of {n} (chance of this many at 10%: {tail:.4f})")
        if tail < 0.001:
            print("FAIL: too many incompletions look wide open")
            bad.append({"name": "separation"})
    print(f"{len(results) - len(bad)} of {len(results)} episodes clean" + (f"; screenshots in {out}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--daily", type=int, default=6, help="daily episodes (each a different day)")
    ap.add_argument("--survivor", type=int, default=4, help="survivor episodes")
    ap.add_argument("--games", type=int, default=3, help="games per survivor episode")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--day-step", type=int, default=1, help="seed step between daily episodes (9: the same day each time)")
    ap.add_argument("--jobs", type=int, default=3, help="episodes at once")
    ap.add_argument("--chromium", help="path to a Chromium binary (default: Playwright's)")
    ap.add_argument("--out", default="browser_test_out")
    sys.exit(asyncio.run(main(ap.parse_args())))
