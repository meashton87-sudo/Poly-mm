"""Play the built website in a real browser like an impatient, curious player, and fail on anything a player would
hit: a script error, a screen that stops moving, a drive or game that never ends, broken text.

    python scripts/browser_test.py _site [--daily 6] [--survivor 6] [--seed 1] [--jobs 3] [--out browser_test_out]

Each daily episode plays one day's drive (the date shifted forward, so every kind of spot comes up); each survivor
episode plays games back to back, starting a new run when one ends, until it has finished that many games. Calls
are random among every button the dock offers (timeouts, spikes, kicks, tempo and routes included), and now and
then the bot opens the help, the stats, the game details or the player ratings mid-play, replays a snap, waits out
an animation instead of skipping it, or reloads the page mid-drive (the drive must pick up where it was). Every
other daily episode starts its drive over (Start over: the ☰ menu on a phone, the button under the field elsewhere)
after its first call: never mid-play, asked first, the day's state a new try marked restarted that a reload keeps, and the
end card saying it is off the leaderboard. Survivor never offers it. Every play shown keeps everyone and the ball on
the ground (inside the end lines, at most a step past a sideline), and the first episode draws a sweep of short fields
(the red zone, the goal line, backed up on its own 1 to 5) against every coverage and shell to the same test, then
600 passes of every kind of result, each measured as drawn against what happened (PASS_LOOK: a catch in his hands, a
miss where its kind says and never in them; every real pass of the run too), then every call near both goal lines
with every result (GOAL_LINE, game.js goalCheck: a touchdown over the goal line in bounds before anything else, nothing
else over it with the ball, out of bounds at the spot, a safety in his own end zone; every real play too), then thousands of drawn runs, RPOs,
defenses, kicks and kick rushes (DRAW_FUZZ). The bots also draw plays as they go (a run,
an RPO, the defense, a kick), mostly calling what the drawing reads as.
Needs Playwright with Chromium (pip install playwright; python -m playwright install chromium).
scripts/daily_check.py plays the same episodes against the live site (its --live mode: ads, analytics and the real
board cut off), in Chromium and in WebKit as an iPhone.
"""
from __future__ import annotations

import argparse
import asyncio
import fnmatch
import functools
import json
import math
import http.server
import random
import re
import sys
import threading
import time
import urllib.parse
from pathlib import Path

from playwright.async_api import TimeoutError as PWTimeout, async_playwright

STATE = """() => {
  const vis = (id) => { const e = document.getElementById(id); return e && !e.hidden; };
  if (document.getElementById('errBar')) return 'errbar';      // (game.js pageError: the red bar, Something broke)
  if (vis('modal')) return 'modal';
  if (vis('deep')) return 'deep';
  if (vis('done') && document.querySelector('#done .big-pct, #done .gradecard')) return 'summary';
  if (vis('intro') && document.querySelector('#intro .sidepick')) return 'pick';
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
# Pro, for the scenario episodes (game.js #custom): the page as the site ships it, told Pro is on (the pro meta) and
# where its backend is (a stub on the test server's own address: /restore says the stored code is good; accounts off;
# anything else answered empty), with a Pro code stored, so any site build can play a scenario
PRO_CODE = "TMD-TEST-TEST-TEST"
STUB_ASKED: set = set()
# the community stub (comm=True: board/worker.js /scen/*, an account signed in as "Tester" with a username): what was
# posted and played, the list read back from it
COMM: dict = {"rows": [], "plays": [], "posts": []}
SESSION = "ab" * 32
# the account's record on the stub (board/worker.js /auth/stats, roughly: a union of each kind; survivor's best run and
# its count of runs the higher of each, never down), what a page signed in posts and reads back
ACCT: dict = {"stats": None}
# the social stub (board/worker.js /challenge*, /calls, /fans, /daily): the challenges by id (each { day, name, score,
# rows }), what the page made and played, its /daily posts, the crowd's counts (a situation key -> { n, c }) and the
# day's fanbases it answers with, and the /tally posts' kinds (a finished Survivor game, Pro drive, run game or scenario)
SOCIAL: dict = {"chal": {}, "made": [], "plays": [], "daily": [], "calls": {}, "fans": None, "tally": []}
TRACE_HALF = False          # what else the pages asked the stub (printed at the end)
# the game's page under the base address (daily_check.py --live: "", the site's front door, as players open it)
PAGE = "index.html"
# what the test itself cut off (daily_check.py --live: ads, analytics, the real board): not the page's own failures
CUT = lambda url: False


def page_route(base: str) -> re.Pattern:
    """The game's page itself (any #mode or ?query), for a route that rewrites it."""
    return re.compile("^" + re.escape(f"{base}/") + r"(?:index\.html)?(?:[?#].*)?$")


async def board_stub(route, path: str, comm: bool = False, headers: dict | None = None) -> None:
    """The board's answers (board/worker.js), from the test: /restore says the stored code is good; with comm the
    community endpoints (an account signed in as "Tester"); anything else is answered empty. daily_check.py answers the
    live pages' board requests with it too (headers: its CORS, the stub being another host than the page's)."""
    body = json.loads(route.request.post_data or "{}") if route.request.method == "POST" else {}
    ok = lambda d: route.fulfill(status=200, content_type="application/json", body=json.dumps(d), headers=headers)
    if path == "/restore":
        await ok({"ok": True, "code": PRO_CODE})
    elif comm and path == "/auth":
        await ok({"google": False, "email": True})
    elif comm and path == "/auth/me":
        await ok({"email": "tester@example.com", "name": "Tester", "pro": False})
    elif comm and path == "/auth/stats":
        acc = ACCT["stats"] or {"days": {}, "drives": {}, "runs": {}, "badges": {}, "frozen": {}, "scen": {}, "surv": {"best": 0, "runs": 0}}
        inc = body.get("stats")
        if isinstance(inc, dict):
            for k in ("days", "drives", "runs", "badges", "frozen", "scen"):
                if isinstance(inc.get(k), dict):
                    acc[k].update(inc[k])
            if isinstance(inc.get("surv"), dict):
                acc["surv"] = {"best": max(acc["surv"]["best"], int(inc["surv"].get("best") or 0)), "runs": max(acc["surv"]["runs"], int(inc["surv"].get("runs") or 0))}
        ACCT["stats"] = acc
        await ok({"stats": acc})
    elif comm and path == "/scen/list":
        await ok({"sort": body.get("sort", "top"), "page": 0, "rows": COMM["rows"], "total": len(COMM["rows"]), "next": None})
    elif comm and path == "/scen/post":
        COMM["posts"].append(body)
        row = {"id": f"TEST{len(COMM['rows']):04d}", "code": body.get("code"), "title": body.get("title"), "name": "Tester", "at": "2026-10-19T17:00:00Z",
               "n": 12, "f": 10, "w": 4, "best": 0.93, "mine": True}
        COMM["rows"].append(row)
        await ok({"row": row})
    elif comm and path == "/scen/play":
        COMM["plays"].append(body)
        await ok({"counted": True})
    elif path == "/challenge" and route.request.method == "POST":
        SOCIAL["made"].append(body)
        cid = "made" + "abcdefghjk"[len(SOCIAL["made"]) % 10] * 3
        SOCIAL["chal"][cid] = {"day": body.get("day"), "name": body.get("name") or "", "score": body.get("score"), "rows": []}
        await ok({"id": cid})
    elif path.startswith("/challenge/"):
        parts = path.split("/")
        c = SOCIAL["chal"].get(parts[2])
        if not c:
            await route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "That challenge link doesn’t work."}), headers=headers)
            return
        counted = False
        if len(parts) == 4 and route.request.method == "POST":
            SOCIAL["plays"].append({"id": parts[2], **body})
            counted = not body.get("restarted")
            if counted:
                c["rows"].append({"name": body.get("name") or "", "score": body.get("score")})
        rows = sorted([{"name": c["name"], "score": c["score"], "ch": True}] + c["rows"], key=lambda r: -r["score"])[:20]
        await ok({"id": parts[2], "day": c["day"], "name": c["name"], "score": c["score"], "n": len(c["rows"]), "rows": rows, "counted": counted})
    elif path == "/calls":
        await ok({"date": "", "min": 20, "s": SOCIAL["calls"]})
    elif path == "/fans" and SOCIAL["fans"] is not None:
        await ok(SOCIAL["fans"])
    elif path == "/daily" and route.request.method == "POST" and SOCIAL["fans"] is not None:
        SOCIAL["daily"].append(body)
        pt = round(float(body.get("p") or 0) * 100)
        hist = [0] * 101
        hist[pt] = 1
        await ok({"n": 1, "hist": hist, "nr": 0, "spots": [{"n": 1, "avg": w, "hist": [0] * 101} for w in body.get("spots") or [0]], "top": [],
                  "counted": len(SOCIAL["daily"]) == 1, "you": {"p": body.get("p"), "spots": body.get("spots")},
                  "week": {"from": "2026-10-15", "to": "2026-10-21", "best": 5, "n": 0, "top": []}})
    elif path == "/tally" and route.request.method == "POST":
        SOCIAL["tally"].append(body.get("kind"))
        await ok({"ok": True})
    else:                     # (accounts off: no way to sign in; nothing else is asked of it on these pages)
        STUB_ASKED.add(path)
        await ok({})


def rewritten(r) -> dict:
    """A fetched response's headers for a body rewritten from it (what was fetched comes decoded: no content-encoding,
    its own length)."""
    return {k: v for k, v in r.headers.items() if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")}


async def pro_context(ctx, base: str, pro: bool = True, comm: bool = False) -> None:
    async def page_(route):
        r = await route.fetch()
        # (the page's own board address, if it has one, goes: only the stub's is left)
        body = re.sub(r'<meta name="(?:scn-at|board-api)"[^>]*>', '', await r.text()).replace("<head>", f'<head><meta name="pro" content="on"><meta name="board-api" content="{base}/__board">', 1)
        await route.fulfill(status=r.status, headers=rewritten(r), body=body)

    async def board(route):
        await board_stub(route, urllib.parse.urlsplit(route.request.url).path.removeprefix("/__board"), comm)
    await ctx.route(page_route(base), page_)
    await ctx.route(f"{base}/__board/**", board)
    if pro:
        await ctx.add_init_script(f"try {{ localStorage.setItem('tmd:v3:pro', JSON.stringify({{ code: '{PRO_CODE}', at: Date.now() }})); }} catch (e) {{}}")
    if comm:
        await ctx.add_init_script(f"try {{ localStorage.setItem('tmd:v3:session', JSON.stringify('{SESSION}')); localStorage.setItem('tmd:v3:seen', 'true'); }} catch (e) {{}}")


# a random scenario that passes its checks (web/scenario.js random, on the rosters' index the page itself loads), the
# kind pinned by the episode: overtime in the playoffs, a fourth quarter, the end of the first half, any (a first half
# played on through the second is scenario_half's: a whole half is more than an episode's steps)
SCEN_PICK = """async ([seed, kind]) => {
  const st = JSON.parse(document.querySelector('meta[name="stamps"]').content), u = `rosters/index.json?v=${st['rosters/index.json']}`;
  const ix = await fetch(u).then((r) => r.json());
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const opt = [{ qtr: 5, type: ['WC', 'DIV', 'CON', 'SB'][seed % 4] }, { qtr: 4 }, { qtr: 2, end: 'half' }, { end: 'half' }, { qtr: 2, end: 'game', type: 'REG' }][kind];
  const sc = TMDScenario.random(R, ix, opt);
  if (sc && kind === 4) Object.assign(sc, { clock: 2, ball: 'opp', start: 'snap', yl: 75, down: 1, ytg: 10, r2h: 'you' });
  return sc && TMDScenario.ok(sc, ix) ? { code: TMDScenario.code(sc), sc, first: ix.seasons[0].season, last: ix.seasons[ix.seasons.length - 1].season } : null;
}"""
# the builder (#custom): a preset gives a scenario it can kick off; a distance past the goal line is refused, said
# where it is and Kick off off; a fixed one is good again
BUILDER = """async () => {
  const q = (s) => document.querySelector(s), out = [];
  const pre = [...document.querySelectorAll('#arch .spre .key')];
  if (pre.length < 4) return ['the builder has no presets'];
  pre[0].click();
  await new Promise((r) => setTimeout(r, 50));
  if (q('#arch .sacts .btn').disabled || !q('#arch .ssum .scnsum')) out.push('a preset does not give a scenario to kick off');
  const yl = q('#scn-yl'), ytg = q('#scn-ytg');
  const set = (i, v) => { i.value = String(v); i.dispatchEvent(new Event('input', { bubbles: true })); };
  [...document.querySelectorAll('#arch .seg[data-f="side"] button')].find((b) => b.dataset.v === 'opp').click();
  set(yl, 5); set(ytg, 8);
  await new Promise((r) => setTimeout(r, 50));
  if (!q('#arch .serr li') || !q('#arch .sacts .btn').disabled || !ytg.classList.contains('bad')) out.push('a distance past the goal line is not refused');
  set(ytg, 5);
  await new Promise((r) => setTimeout(r, 50));
  if (q('#arch .serr li') || q('#arch .sacts .btn').disabled) out.push('a goal-to-go fixed is still refused');
  const sel = q('#scn-youyr'), years = [...sel.options].map((o) => +o.value);
  return { out, years: [Math.min(...years), Math.max(...years)], seasons: years.length };
}"""
# the scenario's saved try (game.js stateKey: :custom:<code>): its restarts and the calls made so far
SCENSTATE = """() => { const k = Object.keys(localStorage).find((x) => /:custom:1-/.test(x)), st = k && JSON.parse(localStorage.getItem(k));
  return st ? { restarts: st.restarts || 0, calls: st.spots.reduce((a, x) => a + ((x && x.decisions) || []).length, 0), done: !!st.done } : null; }"""
# the day's saved drive (the daily's own state): its restarts and the calls made so far
DAYSTATE = """() => { const k = Object.keys(localStorage).find((x) => /:day:\\d+$/.test(x)), st = k && JSON.parse(localStorage.getItem(k));
  return st ? { restarts: st.restarts || 0, calls: st.spots.reduce((a, x) => a + ((x && x.decisions) || []).length, 0), done: !!st.done } : null; }"""
# the men a drawing starts from now (game.js drawFrom), on the page, and the line of scrimmage: where a bot draws a
# run, an RPO, the defense or a kick
SKETCH = """() => {
  const D = window.__draw;
  if (!D) return null;
  const ctx = D.drawCtx(), { scene: sc } = D.get();
  if (!ctx || ctx === 'pass') return null;
  const M = document.getElementById('field').getScreenCTM(), Y = D.camY(sc);
  const q = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(M); return [p.x, p.y]; };
  const men = D.drawFrom(sc, ctx).map((a) => [...q(a.x0, Y(a.L0) + D.dotOff(a)), a.label]);
  const los = q(sc.bx, Y(sc.losL)), ahead = q(sc.bx, Y(sc.losL + sc.dir * 5));
  return { ctx, men, los, up: Math.sign(ahead[1] - los[1]) || -1, ppy: Math.abs(ahead[1] - los[1]) / 5 };
}"""
SNAP = "() => [document.getElementById('dock').innerText, document.getElementById('bar').innerText].join('|')"
# the timeout where the page offers it (game.js clockOptions, defTimeoutOk, promptChoice fgdef/puntdef): with the clock
# running, on your call (wanting time: the first half, or not ahead), on your defense late in a half, and on their kick
# late; a timeout key, switch or field button when you have one, "No timeouts left" (.noto) when you have none (a
# player missed the option on a day whose side starts with none, and on their punt it was not there at all)
TIMEOUT_UI = """() => {
  const D = window.__draw; if (!D || !D.get) return null;
  const { G, busy } = D.get(), r = G && G.root;
  if (busy || !r || r.phase !== 0 || G.over || !r.clock_running || r.try2) return null;      // (busy: a call on its way)
  const dock = document.getElementById('dock'), h = dock.querySelector('.ask h2'), head = h ? h.textContent : '';
  const me = G.me, left = r.t > 1800 ? r.t - 1800 : r.t, late = left <= (r.t <= 1800 ? 300 : 120);
  let where = null, want = false;
  if (r.pos === me && head === 'Your call') { where = 'offense'; want = r.t > 1800 || r.score[me] <= r.score[1 - me]; }
  else if (r.pos !== me && head === 'Your defense') { where = 'defense'; want = late; }
  else if (r.pos !== me && /punting|field goal/.test(head)) { where = /punting/.test(head) ? 'punt' : 'field goal'; want = late; }
  if (!where) return null;
  const btn = document.getElementById('toBtn');
  const keys = [...dock.querySelectorAll('button')].map((b) => b.textContent.trim());      // (not innerText: the keys are set in capitals)
  const shown = keys.some((k) => /^(Timeout|Ice the kicker)/.test(k)) || !!document.getElementById('toSwitch') || !!(btn && !btn.hidden);
  return { where, t: r.t, to: r.to[me], want, shown, note: !!dock.querySelector('.noto') };
}"""
# short fields (game.js offField): from the 20 in to the 1, and backed up on its own 5 to 1, for both teams, every
# coverage you can call (as it lines up) and every shell the plays are drawn against (a run, quick, screen, deep,
# play-action, rollout and Hail Mary pass, and a field goal or a punt), nobody is ever off the ground (past an end line
# into the stands, off the drawn sideline), before the snap or at any moment of the play, and neither is the ball
SHORT_FIELD = """(yl) => {
  const D = window.__draw, { G, ui } = D.get(), calls = Object.values(D.CALL);     // (in the order of the play log's call)
  // (the logs the plays write for the rest of the test keep only the real plays)
  const logs = ['__sepLog', '__tackleLog', '__fpLog'], kept = logs.map((k) => (window[k] || []).length);
  const ids = ['rb_middle', 'qb_sneak', 'quick_strong', 'screen', 'deep_strong', 'pa_deep', 'roll_strong', 'hail_mary', 'trick_flea'];
  const shells = Object.keys(D.Motion.SHELLS), covers = ['c0', 'c1', 'c2', 'c3', 'c4', 'c6', '2man', 'prevent'];
  const step0 = ui.step, dc0 = ui.dc, look0 = G.look, bad = [];
  let plays = 0;
  for (const mine of [true, false]) {
    const r = { ...G.root, phase: 0, down: 4, ytg: Math.min(yl, 10), yl, pos: mine ? G.me : 1 - G.me, try2: false };
    for (const side of [1, -1]) {
      // before the snap: your defense as you call it, theirs in each look it shows you
      ui.step = mine ? 'x' : 'vdef';
      for (const v of mine ? [0, 1, 2, 3] : covers) {
        if (mine) G.look = v; else ui.dc = { pers: 'nickel', front: 'even', cover: v, rush: v === 'c0' ? 6 : 4 };
        D.offField(D.makeScene(r, side), null).forEach((b) => bad.push({ yl, mine, side, pre: v, ...b }));
      }
      ui.step = 'x';
      if (side < 0) continue;
      for (const shell of shells) {
        ids.forEach((id, i) => {
          const ci = calls.findIndex((c) => c.id === id), run = calls[ci].kind === 'run', far = Math.min(yl, 40);
          const es = run ? [{ yards: 2 }, { yards: yl, td: true }, { yards: -3 }]
            : [{ air: far, yards: far, td: yl <= 40 }, { air: Math.min(yl, 12), incomplete: true }, { air: 5, yards: 8 },
              { air: far, incomplete: true, evt: 'interception', yards: 0 }];
          if (!i) es.push(...(yl >= 90 ? [{ ev: 'punt', net: 42 }, { ev: 'punt', blocked: true }] : yl <= 10 ? [{ ev: 'fg', made: true, dist: yl + 17 }, { ev: 'fg', blocked: true, retTd: true, dist: yl + 17 }] : []));
          es.forEach((o) => {
            const e = { ev: 'play', team: r.pos, call: ci, row: -1, t: r.t, shell, kind: run ? 0 : 1, ...o };
            const sc = D.makeScene(r, side), P = D.choreograph(sc, e, { action: null, log: [e], root: { ...r, yl: Math.max(1, yl - (o.yards || 0)) } }, false);
            if (!P) return;
            plays++;
            D.speedLog(sc, P, e, { sweep: 'short', yl, mine, side, shell, id });
            D.offField(sc, P, e.ev === 'fg' && !e.blocked).slice(0, 2).forEach((b) => bad.push({ yl, mine, side, shell, id, ev: e.ev, ...o, ...b }));
          });
        });
      }
    }
  }
  ui.step = step0; ui.dc = dc0; G.look = look0;
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return { plays, bad: bad.slice(0, 12), n: bad.length };
}"""
# The goal line (game.js goalCheck): runs, passes, scrambles, sacks and turnovers of every result near either goal
# line, for both teams and both strong sides, every call: a touchdown is the ball carried (or caught) over the goal line
# inside the sidelines before he is ever out of bounds with it (a run the engine has out of bounds and in the end zone
# too: the touchdown first); a play stopped at the 1 never has the ball over the line; a play out of bounds goes out at
# its spot; a safety is down in his own end zone; a pick in the end zone, a fumble return, a pick-six as they went
GOAL_LINE = """([yl, full]) => {
  const D = window.__draw, { G } = D.get(), calls = Object.values(D.CALL);
  const logs = ['__sepLog', '__tackleLog', '__fpLog', '__offLog', '__goalLog'], kept = logs.map((k) => (window[k] || []).length);
  const bad = [], tally = {};
  let plays = 0;
  for (const mine of [true, false]) {
    const r = { ...G.root, phase: 0, down: 3, ytg: Math.min(yl, 10), yl, pos: mine ? G.me : 1 - G.me, try2: false };
    const dir = mine ? 1 : -1, L0 = mine ? 100 - yl : yl;
    const rootAt = (absL, pos) => ({ ...r, pos, yl: Math.max(1, Math.min(99, pos === G.me ? 100 - absL : absL)) });
    for (const side of [1, -1]) {
      calls.forEach((c, ci) => {
        if (!full && (ci + (side > 0 ? 0 : 1)) % 2) return;          // (each call from one strong side, alternately)
        const loss = Math.min(3, 99 - yl), sackL = Math.min(6, 99 - yl);
        const run = c.kind === 'run', es = [];
        const sf = yl >= 95 ? [{ yards: yl - 101, safety: true }, { yards: yl - 100, safety: true }] : [];
        if (run) {
          es.push({ yards: yl, td: true }, { yards: yl + 4, td: true }, { yards: yl + 3, td: true, oob: true }, { yards: yl, td: true, oob: true },
            { yards: -loss }, { yards: Math.min(2, yl - 1), evt: 'fumble_lost', turnover: true }, { yards: Math.min(2, yl - 1), evt: 'scoop_score', turnover: true, tdDef: true }, ...sf);
          if (yl > 1) es.push({ yards: yl - 1 }, { yards: yl - 1, oob: true }, { yards: yl - 1, evt: 'fumble_lost', turnover: true });
          es.push({ yards: yl - 0.5 });
        } else {
          const ez = Math.min(yl + 3, yl + 9);
          es.push({ air: ez, yards: yl, td: true }, { air: Math.max(-2, yl - 8), yards: yl, td: true }, { air: Math.max(-2, yl - 5), yards: yl + 2, td: true, oob: true },
            { air: Math.min(yl + 4, yl + 9), yards: 0, evt: 'interception', turnover: true }, { air: Math.min(yl + 2, 15), yards: 0, evt: 'pick_six', turnover: true, tdDef: true },
            { yards: -sackL, evt: 'sack' }, { yards: yl, evt: 'scramble', td: true }, { yards: yl + 2, evt: 'scramble', td: true, oob: true },
            { yards: -Math.min(5, sackL), evt: 'strip_sack', turnover: true, tdDef: true }, { air: ez, yards: 0, incomplete: true },
            ...sf.map((o) => ({ ...o, evt: 'sack' })));
          if (yl > 1) es.push({ air: Math.max(-2, yl - 4), yards: yl - 1 }, { air: yl - 1, yards: yl - 1 }, { air: Math.max(-2, yl - 3), yards: yl - 1, oob: true },
            { yards: yl - 1, evt: 'scramble' }, { yards: yl - 1, evt: 'scramble', oob: true });
        }
        es.forEach((o, k) => {
          // (each its own draw of the field: the animation's randomness is seeded by the play, its time among it)
          const e = { ev: 'play', team: r.pos, call: ci, row: -1, t: 1790 - ((ci * 31 + k * 7 + yl * 3 + (mine ? 0 : 5)) % 1700), kind: run ? 0 : 1, ...o };
          const end = L0 + dir * (o.yards || 0);
          const root = o.turnover ? rootAt(o.evt === 'interception' && o.air >= yl ? (mine ? 80 : 20) : end + dir * (o.air || 0) - dir * 4, 1 - r.pos) : rootAt(end, r.pos);
          const sc = D.makeScene(r, side), P = D.choreograph(sc, e, { action: null, log: [e], root }, false);
          if (!P) return;
          plays++;
          D.speedLog(sc, P, e, { sweep: 'goal', yl, mine, side, id: c.id });
          const g = D.goalCheck(sc, P, e, false);
          g.bad.forEach((b) => { tally[b] = (tally[b] || 0) + 1; if (tally[b] <= 8) bad.push({ yl, mine, side, id: c.id, ...o, why: b, cross: g.cross, out: g.out, deepest: g.deepest }); });
        });
      });
    }
  }
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return { plays, bad, tally };
}"""
# The pass looks like what happened (game.js missPlan, passCheck): pass plays of every kind of result, on spots from the
# goal line to backed up, both teams, every pass call and charted route, drawn on the field and measured as drawn: a
# catch (or a pick) is in the catcher's hands as the ball gets to him and just after; an incompletion never is, and
# goes where its kind says (pass_look_problems). Every third one is yours, to the man split out by the left sideline,
# then the right, on a route along it or out to it, and some catches are run out of bounds: at both sidelines the
# ball stays on the drawn turf (offField; edge counts the passes whose ball ends up within 2 yards of each)
PASS_LOOK = """([n, seed]) => {
  const D = window.__draw, { G } = D.get(), calls = Object.values(D.CALL);
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(R() * a.length)];
  const logs = ['__sepLog', '__tackleLog', '__fpLog', '__offLog'], kept = logs.map((k) => (window[k] || []).length);
  const ids = ['quick_strong', 'quick_weak', 'quick_middle', 'screen', 'deep_strong', 'deep_weak', 'deep_middle', 'pa_short', 'pa_deep', 'roll_strong', 'roll_weak'];
  const routes = ['go', 'post', 'corner', 'out', 'deep_out', 'in', 'slant', 'cross', 'hitch', 'screen', 'flat', 'wheel', 'angle'];
  const kinds = ['catch', 'catch', 'int', 'bad', 'bad', 'bad', 'break', 'break', 'tip', 'drop', 'pick', 'away', 'plain', 'oob'];
  const outside = ['out', 'deep_out', 'corner', 'go', 'hitch', 'flat', 'wheel'];
  const rows = [], off = [], edge = [0, 0];
  for (let i = 0; i < n; i++) {
    const id = pick(ids), ci = calls.findIndex((c) => c.id === id), yl = pick([3, 8, 15, 25, 40, 55, 70, 85, 95, 99]);
    const deep = /deep/.test(id), air = Math.round(Math.max(-3, Math.min(yl + 8, deep ? 14 + R() * 32 : -3 + R() * 15)));
    const k = pick(kinds), ch = (c, x, d) => ({ catchable: c, contested: x, defended: d });
    const yards = Math.min(yl, Math.max(air, air + Math.floor(R() * 9)));
    const o = { catch: { air, yards, td: yards >= yl, ...ch(true, R() < 0.2, false) }, int: { air, yards: 0, evt: 'interception', turnover: true },
      bad: { air, yards: 0, incomplete: true, ...ch(false, R() < 0.25, false), ...(R() < 0.33 ? { pressure: true } : {}) }, break: { air, yards: 0, incomplete: true, ...ch(R() < 0.3, R() < 0.6, true) },
      tip: { air, yards: 0, incomplete: true, ...ch(true, false, false) }, drop: { air, yards: 0, incomplete: true, evt: 'drop', ...ch(true, R() < 0.2, false) },
      pick: { air, yards: 0, incomplete: true, evt: 'near_pick', ...ch(false, true, true) }, away: { yards: 0, incomplete: true, evt: 'throwaway' },
      plain: { air, yards: 0, incomplete: true }, oob: { air, yards, oob: yards < yl, td: yards >= yl, ...ch(true, R() < 0.2, false) } }[k];
    const wide = i % 3 === 0 && k !== 'away';
    const r = { ...G.root, phase: 0, down: 1 + Math.floor(R() * 4), ytg: Math.min(yl, 10), yl, pos: wide || R() < 0.5 ? G.me : 1 - G.me, try2: false, t: 1700 - i };
    const e = { ev: 'play', team: r.pos, call: ci, row: -1, t: r.t, kind: 1, ...o };
    if (R() < 0.75 && k !== 'away') e.route = pick(routes);
    const n0 = window.__sepLog.length, side = R() < 0.5 ? 1 : -1;
    const sc = D.makeScene(r, side);
    // (yours, to the receiver split out widest on the left, then on the right, on a route by the sideline)
    let action = null;
    if (wide) {
      const el = D.eligibles(sc), wr = el.filter((a) => a.label === 'WR').sort((a, b) => a.x0 - b.x0), a = (i / 3) % 2 ? wr[wr.length - 1] : wr[0];
      if (a) action = { target: el.indexOf(a), route: pick(outside) };
    }
    const P = D.choreograph(sc, e, { action, log: [e], root: { ...r, yl: Math.max(1, yl - (e.yards || 0)) } }, false);
    if (!P) continue;
    D.speedLog(sc, P, e, { sweep: 'pass', yl, id, k, route: e.route || '', to: action ? action.route : '' });
    D.offField(sc, P, false).slice(0, 2).forEach((b) => { if (off.length < 10) off.push({ id, k, yl, to: action ? action.route : '', ...b }); });
    const xe = (D.ballAt(sc, P, P.T).x - D.SX0) / D.XYD;
    if (xe < 2) edge[0]++; else if (xe > 160 / 3 - 2) edge[1]++;
    if (window.__sepLog.length > n0) rows.push({ ...window.__sepLog[window.__sepLog.length - 1], id, want: k, yl });
  }
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return { rows, off, edge };
}"""


# Real plays, as the game draws them (game.js speedCheck): n snaps from spots all over the field, every kind of call (a
# run, a quick pass, a deep shot, a screen, play action, a rollout, an RPO, a Hail Mary), run by the simulator and
# drawn with everything the real play's charting gives the animation (the route, the time to throw, the rush, the
# pressure, the yards, where it ended); nobody on the field ever runs faster than an NFL player or jumps across it
REAL_PLAYS = """async ([n, seed]) => {
  const D = window.__draw, { G, ui } = D.get(), calls = Object.values(D.CALL);
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(R() * a.length)];
  const logs = ['__sepLog', '__tackleLog', '__fpLog', '__offLog', '__goalLog'], kept = logs.map((k) => (window[k] || []).length);
  const ids = ['rb_out_strong', 'rb_inside_weak', 'rb_middle', 'qb_run', 'rpo_strong', 'quick_strong', 'quick_weak', 'quick_middle', 'screen', 'deep_strong', 'deep_weak',
    'deep_middle', 'pa_short', 'pa_deep', 'roll_strong', 'roll_weak', 'hail_mary'];
  const look0 = G.look, step0 = ui.step;
  const out = { plays: 0, errs: [] };
  for (let i = 0; i < n; i++) {
    const id = pick(ids), ci = calls.findIndex((c) => c.id === id), yl = pick([1, 3, 8, 15, 25, 40, 55, 70, 85, 95, 99]), mine = R() < 0.7;
    const r = { ...G.root, phase: 0, down: 1 + Math.floor(R() * 3), ytg: Math.min(yl, pick([1, 3, 7, 10, 15])), yl, pos: mine ? G.me : 1 - G.me, try2: false,
      clock_running: false, t: id === 'hail_mary' ? 6 : pick([3500, 1830, 600, 90, 25]) };
    G.look = mine && R() < 0.5 ? Math.floor(R() * 4) : null;
    ui.step = 'x';
    const act = { to_off: false, play: calls[ci].kind, call: id, oob: R() < 0.2, looks: G.look != null ? 1 << G.look : 0 };
    let res;
    try { res = (await D.send({ type: 'step', scen: D.simScen(), root: r, action: act, seed: (seed * 7919 + i) >>> 0 }, true)).res; } catch (err) { out.errs.push(String(err)); continue; }
    const e = res && res.log && res.log.find((y) => y.ev === 'play');
    if (!e) continue;
    const side = R() < 0.5 ? 1 : -1, sc = D.makeScene(r, side), P = D.choreograph(sc, e, res, false);
    if (!P) continue;
    out.plays++;
    D.speedLog(sc, P, e, { sweep: 'real', yl, mine, side, id, row: e.row, route: e.route || '', ttt: e.ttt });
  }
  G.look = look0; ui.step = step0;
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return out;
}"""


def pass_look_problems(rows: list) -> list:
    """What a pass shows against what happened (game.js passCheck's measures, in yards): a catch or a pick in his hands
    as the ball gets there and just after; a miss never in the receiver's hands (a drop: a moment, then out), never
    ending at his feet, out of his reach while low enough to catch, and gone where its kind says."""
    bad = []
    for x in rows:
        k, why = x.get("miss"), []
        if k in ("catch", "pick6"):
            if x.get("gap", 0) > 1.0:
                why.append(f"the ball {x.get('gap')} yd from his hands at the catch")
        elif k:
            if "rest" not in x:
                continue
            if k == "drop":
                if not (0 < x["held"] <= 0.3 and x["gap"] <= 0.5):
                    why.append(f"a drop not in his hands, then out (held {x['held']} s, {x['gap']} yd off)")
            elif x["held"] > 0:
                why.append("in his hands")
            if k != "away" and x["rest"] < 1.0:
                why.append(f"ends {x['rest']} yd from him")
            if k in ("over", "behind", "ahead", "wide") and x["low"] < 1.5:
                why.append(f"within his reach ({x['low']} yd) low enough to catch")
            if k == "under" and x["low"] < 1.0:
                why.append(f"within his reach ({x['low']} yd) low enough to catch")
            if k == "over" and (x["past"] < 1.5 or x["zc"] < 0.5):
                why.append(f"not over him (lands {x['past']} yd past him, {x['zc']} high as it gets to him)")
            if k == "under" and x["past"] > -1.2:
                why.append(f"not short of him ({x['past']} yd)")
            if k == "behind" and x["lead"] > -1.5:
                why.append(f"not behind him ({x['lead']} yd)")
            if k == "ahead" and x["lead"] < 1.5:
                why.append(f"not ahead of him ({x['lead']} yd)")
            if k == "wide" and x["reach"] < 1.8:
                why.append(f"not wide of him ({x['reach']} yd)")
            if k in ("break", "pick") and x["defAt"] > 1.3:
                why.append(f"no defender at the ball ({x['defAt']} yd)")
            # (broken up, or nearly picked, only with a defender at the catch point: never a man in the open, nor one wide
            # open as the ball was thrown, the defender closing more than 4 yards a second of its flight)
            if k in ("break", "pick") and x.get("defNear", 99) > 1.5:
                why.append(f"no defender within 1.5 yd of him at the catch ({x.get('defNear')} yd)")
            if k in ("break", "pick") and x.get("atThrow", 0) > 2.5 + 4 * (x["tCatch"] - x["tThrow"]):
                why.append(f"wide open as it was thrown ({x.get('atThrow'):.1f} yd, {x['tCatch'] - x['tThrow']:.1f} s in the air)")
            if k == "tip" and not 0.9 <= x["reach"] <= 1.9:
                why.append(f"not at his fingertips ({x['reach']} yd)")
            # an off-target ball is never thrown at a man wide open, more than 3 yards from every defender, from a clean
            # pocket (nobody within 3 yards of the passer as he throws): players saw it as missed throws to open men
            if x.get("bad") and x.get("actual", 0) > 3 and x.get("pressD", 0) > 3:
                why.append(f"off target to a man {x.get('actual'):.1f} yd clear, nobody on the passer ({x.get('pressD')} yd)")
        if why:
            bad.append({"miss": k, "label": x.get("label"), "air": x.get("air"), "kind": x.get("kind"), "fit": x.get("fit"), "why": why})
    return bad


# Drawing every kind of call (game.js readRun, readQb, readDef, readKick): thousands of random lines from the men a
# drawing starts from, on spots from the goal line to backed up on the 1, against every look and full call. Every
# drawing is read as a call the keys make here (a run or an RPO callOptions offers, a defensive look or a full call
# whose parts are all real, a kick the spot allows: onside only when behind) or refused with a message; every one read
# is played out on the field with the drawing (a drawn run, an RPO's route, your defenders' lines) and nobody leaves the
# ground (offField); and a sample of them goes to the simulator, where the call drawn is the call run
DRAW_FUZZ = """async ([kind, n, seed]) => {
  const D = window.__draw, { G, ui } = D.get(), calls = Object.values(D.CALL);
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(R() * a.length)];
  const logs = ['__sepLog', '__tackleLog', '__fpLog', '__drawLog'], kept = logs.map((k) => (window[k] || []).length);
  const ui0 = { ...ui }, look0 = G.look;
  const out = { n: 0, taps: 0, mapped: {}, faults: {}, bad: [], off: [], plays: 0, real: 0, realBad: [] };
  const FAULTS = new Set(Object.keys(D.SKETCH_FAULT)), PERS = ['heavy', 'base', 'nickel', 'dime'], FR = ['light', 'even', 'loaded'];
  const COV = ['c0', 'c1', '2man', 'c2', 'c3', 'c4', 'c6', 'prevent'];
  const bad = (o) => { if (out.bad.length < 8) out.bad.push(o); };
  // a finger's line from man a: one to four legs, wobbles, the offense's way (fw 1) or either way
  const line = (a, sc, fw, reach) => {
    let x = (a.x0 - D.SX0) / D.XYD, L = a.L0;
    const pts = [], legs = 1 + Math.floor(R() * 4);
    for (let k = 0; k < legs; k++) {
      x += (R() * 2 - 1) * (reach || 9); L += sc.dir * (fw ? fw * (R() * 15 - 3) : (R() * 2 - 1) * 14);
      pts.push([x, L]);
      if (R() < 0.3) pts.push([x + R() - 0.5, L + R() - 0.5]);
    }
    return pts;
  };
  const real = [];
  for (let it = 0; it < n; it++) {
    const yl = pick([1, 2, 3, 4, 5, 8, 12, 20, 35, 50, 65, 80, 90, 95, 97, 99]), side = R() < 0.5 ? 1 : -1, off = kind === 'run' || kind === 'rpo';
    const lead = pick([-9, -3, 0, 3, 9]), sc0 = [21, 21 + lead], kick = kind === 'kick', free = kick && R() < 0.25;
    const r = { ...G.root, phase: kick ? 2 : 0, down: 1 + Math.floor(R() * 4), ytg: Math.min(yl, 1 + Math.floor(R() * 12)), yl, pos: off || kick ? G.me : 1 - G.me,
      try2: false, free_kick: free, clock_running: false, untimed: false, score: G.me ? [sc0[1], sc0[0]] : sc0, t: pick([3500, 1830, 600, 90, 25]) };
    if (kick) r.yl = free ? 80 : 65;
    G.look = off && R() < 0.7 ? Math.floor(R() * 4) : null;
    const full = kind === 'def' && R() < 0.6;
    ui.step = kind === 'def' ? (full ? 'vdef' : 'defense') : kind === 'stdef' ? 'st' : 'x';
    ui.dc = full ? { ...pick(Object.values(D.PRESET)).dc } : null;
    ui.st = kind === 'stdef' ? pick(['fgdef', 'puntdef']) : kick ? (free ? 'freekick' : 'kick') : null;
    const sc = D.makeScene(r, side), me = sc.actors.filter((a) => a.teamI === G.me);
    let res, act = null, what = null;
    if (off) {
      const a = pick(me.filter((a) => a.off && (kind === 'run' ? ['QB', 'RB', 'FB', 'WR'] : ['RB', 'FB']).includes(a.label)));
      if (!a) continue;
      res = D.readRun(sc, a, line(a, sc, 1), kind === 'rpo');
      if (res && !res.fault) {
        const ok = D.callOptions(r).calls.includes(res.call) && (kind === 'rpo') === res.call.startsWith('rpo') && (kind === 'rpo' || /^(rb_|qb_|trick_reverse)/.test(res.call));
        if (!ok) bad({ kind, call: res.call, yl });
        what = res.call; act = { to_off: false, play: D.CALL[res.call].kind, call: res.call, oob: R() < 0.2, looks: G.look != null ? 1 << G.look : 0, path: res.path, carrier: res.carrier, shape: res.shape };
        // Versus: the room gets the call only, never the drawing
        const sealed = D.vsSealed({ action: act }).action;
        if (sealed.call !== act.call || ['path', 'carrier', 'shape', 'drawn', 'ddraw', 'qbPath'].some((k) => k in sealed)) bad({ kind, sealed });
        if (kind === 'rpo' && R() < 0.5) {
          const E = D.eligibles(sc), k = Math.floor(R() * E.length), d = D.shapeDrawn(sc, E[k], line(E[k], sc, 1));
          if (d && !d.fault) { act.target = k; act.drawn = E.map((_, j) => (j === k ? { pts: d.pts, at: d.at, minD: d.minD } : null)); act.routes = E.map((_, j) => (j === k ? d.name : null)); }
        }
      }
    } else if (kind === 'def' || kind === 'stdef') {
      const defs = me.filter((a) => !a.off), m = new Map();
      for (let k = 1 + Math.floor(R() * 4); k > 0; k--) {
        const a = pick(defs), l = D.readDefLine(sc, a, line(a, sc, 0, 7));
        if (l && l.fault) { if (!FAULTS.has(l.fault)) bad({ kind, fault: l.fault }); out.faults[l.fault] = (out.faults[l.fault] || 0) + 1; }
        else if (l) m.set(a, l);
      }
      if (!m.size) { out.taps++; continue; }
      if (kind === 'stdef') { const thru = [...m.values()].some((l) => l.through); res = { key: ui.st === 'fgdef' ? (thru ? 'block' : 'safe') : thru ? 'rush' : 'return' }; what = res.key; }
      else {
        res = D.readDef(sc, m, full ? ui.dc : null);
        if (!res.fault) {
          const dc = res.dc;
          if (full && !(PERS.includes(dc.pers) && FR.includes(dc.front) && COV.includes(dc.cover) && [3, 4, 5, 6].includes(dc.rush))) bad({ kind, dc });
          if (!full && !D.DEFS.includes(res.call)) bad({ kind, call: res.call });
          what = full ? `${dc.front}/${dc.cover}/${dc.rush}` : res.call;
          const all = sc.actors.filter((a) => !a.off);
          act = { to_def: false, ...(full ? { dc, read: true } : { def: res.call }), ddraw: [...m.entries()].map(([a, l]) => ({ k: all.indexOf(a), pts: l.path })) };
        }
      }
    } else {
      const K = me.find((a) => a.label === 'K');
      if (!K) continue;
      res = D.readKick(sc, K, line(K, sc, 1, 12).map((p, k, A) => (k === A.length - 1 ? [p[0], p[1] + sc.dir * R() * 60] : p)), ui.st);
      if (res && !res.fault) {
        what = res.key;
        if (res.key === 'onside' && !(free || r.score[G.me] < r.score[1 - G.me])) bad({ kind, onside: 'not behind' });
        act = { kick: res.key };
      }
    }
    out.n++;
    if (!res) { out.taps++; continue; }
    if (res.fault) { if (!FAULTS.has(res.fault)) bad({ kind, fault: res.fault }); out.faults[res.fault] = (out.faults[res.fault] || 0) + 1; continue; }
    out.mapped[what] = (out.mapped[what] || 0) + 1;
    if (!act) continue;
    // on the field: the drawn call's outcomes (a stop behind the line, short, a first down, a touchdown; an RPO thrown)
    const id = off ? act.call : pick(['rb_inside_strong', 'quick_weak', 'deep_strong', 'rpo_weak']), team = off ? G.me : 1 - G.me, ci = calls.findIndex((c) => c.id === id);
    const isRun = calls[ci].kind === 'run' || (calls[ci].id.startsWith('rpo') && R() < 0.5);
    if (!kick && !(kind === 'stdef')) for (const o of isRun ? [{ yards: -2 }, { yards: Math.min(3, yl) }, { yards: yl, td: true }, { yards: Math.min(yl, 12), oob: R() < 0.3 }] : [{ air: Math.min(yl, 9), yards: Math.min(yl, 11) }, { air: Math.min(yl, 20), incomplete: true }]) {
      const e = { ev: 'play', team, call: ci, row: -1, t: r.t, kind: isRun ? 0 : 1, ...o, td: !!o.td || (o.yards || 0) >= yl };
      const sc2 = D.makeScene(r, side), P = D.choreograph(sc2, e, { action: act, log: [e], root: { ...r, yl: Math.max(1, yl - (o.yards || 0)) } }, false);
      if (!P) continue;
      out.plays++;
      D.offField(sc2, P, false).slice(0, 2).forEach((b) => { if (out.off.length < 10) out.off.push({ kind, what, yl, side, ...o, ...b }); });
    }
    if (real.length < 30 && !(kind === 'stdef')) real.push({ r, act, what, ci });
  }
  // the simulator: the drawn call is the call run, a real play
  const off = kind === 'run' || kind === 'rpo', kick = kind === 'kick';
  for (const x of real) {
    try {
      const res = (await D.send({ type: 'step', scen: D.simScen(), root: x.r, action: x.act, seed: (seed * 7919 + out.real) >>> 0 }, true)).res;
      out.real++;
      const e = res.log.find((y) => ['play', 'kickoff'].includes(y.ev));
      if (kind === 'kick') { if (!e || e.ev !== 'kickoff') out.realBad.push({ kind, what: x.what, log: res.log.map((y) => y.ev) }); }
      else if (off && e && e.ev === 'play' && !e.penalty && e.call !== x.ci) out.realBad.push({ kind, what: x.what, ran: (calls[e.call] || {}).id });
    } catch (err) { out.realBad.push({ kind, what: x.what, err: String(err) }); }
  }
  Object.keys(ui).forEach((k) => { if (!(k in ui0)) delete ui[k]; });
  Object.assign(ui, ui0); G.look = look0;
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return out;
}"""
# the snap in reach: a call's go key (a pass's Snap, a drawn call's, Call it, the kicks) wholly on the screen, nothing over
# it, with nobody having scrolled; on a tall phone every receiver's row too, clear of the Snap key. The Snap key's first
# line one line, the name in it whole (a long name wrapped it, the key growing at the foot of the screen). Said with it:
# the calls' sheet down (a phone: dragged or tapped down, the keys under the screen's edge till it comes back up)
# the field's options (game.js fieldOpts: speed, Personnel, Formation, Ratings) open, as a player who opened them once has them
OPEN_OPTS = "try { localStorage.setItem('tmd:v3:fieldopts', 'true'); } catch (e) {}"
REACH = """(sel) => {
  const es = [...document.querySelectorAll(sel)];
  if (!es.length) return [`${sel}: not on the screen`];
  const down = document.querySelector('#sheet.down') ? " (the calls' sheet down)" : '';
  const oneLine = (k) => {
    const n = k.firstChild, rg = document.createRange();
    if (!n) return 'no label';
    rg.selectNodeContents(n);
    const tops = new Set([...rg.getClientRects()].filter((q) => q.width > 0.5).map((q) => Math.round(q.top)));
    if (tops.size > 1) return `its label on ${tops.size} lines`;
    if (n.nodeType === 1 && n.scrollWidth > n.clientWidth + 0.5) return `its label cut short (${n.scrollWidth} px in ${n.clientWidth})`;
    return k.scrollWidth > k.clientWidth + 0.5 ? 'its label wider than the key' : '';
  };
  return es.map((e) => {
    const r = e.getBoundingClientRect(), what = `${sel} (${e.innerText.replace(/\\s+/g, ' ').slice(0, 40)})`;
    if (!r.height || r.top < -0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5)
      return `${what}: out of view at ${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight}${down}`;
    const snap = document.getElementById('snapGo'), s = snap && snap !== e && !snap.contains(e) && snap.getBoundingClientRect();
    if (s && r.bottom > s.top - 6 + 0.5) return `${what}: under the Snap key`;
    const line = e.id === 'snapGo' ? oneLine(e) : '';
    if (line) return `${what}: ${line}`;
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return h && e.contains(h) ? '' : `${sel}: covered by ${h ? h.outerHTML.slice(0, 80) : 'nothing'}`;
  }).filter(Boolean);
}"""
# ... and from the first frame it is up (its pop): watched every frame for a moment from just before the tap that brings
# it, the furthest past the screen's edges it went (a key popping up from below at the foot of the screen started out
# under its edge: the daily check, measuring it as it came, found it there)
REACH_WATCH = """(sel) => {
  const t0 = performance.now(), W = window.__reachWatch = { worst: 0, at: '' };
  const f = () => {
    document.querySelectorAll(sel).forEach((e) => {
      const r = e.getBoundingClientRect(), o = Math.max(r.bottom - innerHeight, -r.top, r.right - innerWidth, -r.left);
      if (r.height && o > W.worst) Object.assign(W, { worst: o, at: `${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight}, ${Math.round(performance.now() - t0)} ms in` });
    });
    if (performance.now() - t0 < 1500 && window.__reachWatch === W) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}"""
# a receiver given a long name (the longest the rosters have, as the Snap key shortens them: "J. Michael Sturdivant",
# "M. Valdes-Scantling") and the longest-named route his position runs (game.js ROUTES); the pick odds on (the Snap
# key's longest second line). He is picked after, by a tap on his row
LONG_NAMES = ["J. Michael Sturdivant", "Marquez Valdes-Scantling", "Nick Westbrook-Ikhine", "Austin Seferian-Jenkins", "T.J. Houshmandzadeh"]
LONG = """([i, name]) => {
  const D = window.__draw, { G, ui, scene } = D.get(), E = D.eligibles(scene), a = E[i];
  if (!a) return null;
  if (a.p) a.p.name = name;
  const rs = D.ROUTES && D.routeName && (D.ROUTES[a.label] || D.ROUTES.WR);      // (a build from before they were here: his route)
  if (rs) ui.pass.routes[i] = rs.reduce((x, y) => (D.routeName(a.label, y).length > D.routeName(a.label, x).length ? y : x));
  if (G.odds) Object.values(G.odds).forEach((o) => { if (o) o.picks = Math.max(o.picks || 0, 0.12); });
  return { n: E.length, target: ui.pass.target };
}"""
# a receiver's dot on the screen (by his place among the eligibles); every receiver's route as named
DOT_AT = """(i) => { const D = window.__draw, { scene } = D.get(), a = D.eligibles(scene)[i]; if (!a) return null; const r = a.g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"""
ROUTES_NOW = "(() => { const D = window.__draw, { ui, scene } = D.get(); return D.eligibles(scene).map((a, i) => D.routeName(a.label, ui.pass.routes[i])); })()"
# a spot of open grass on the field in view: on the field (nothing over it there), 40 units from any route or dot
GRASS_AT = """() => {
  const D = window.__draw, { scene } = D.get(), svg = scene && scene.svg, m = svg && svg.getScreenCTM();
  if (!m || !scene.routePts) return null;
  const r = svg.getBoundingClientRect(), inv = m.inverse();
  for (let fy = 0.15; fy < 0.9; fy += 0.07) for (let fx = 0.06; fx < 0.95; fx += 0.08) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy, e = document.elementFromPoint(x, y);
    if (!e || e.closest('svg') !== svg || e.closest('g.dot')) continue;
    const q = new DOMPoint(x, y).matrixTransform(inv);
    const seg = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((q.x - a[0]) * dx + (q.y - a[1]) * dy) / L)) : 0; return Math.hypot(q.x - a[0] - u * dx, q.y - a[1] - u * dy); };
    if (scene.routePts.every((pts) => pts.every((p, k) => Math.hypot(q.x - p[0], q.y - p[1]) > 40 && (!k || seg(pts[k - 1], p) > 40)))) return [x, y];
  }
  return null;
}"""
# the defense's screens and the kicks, put up in place on a phone's first call (the test page is thrown away after)
SHOW = """async (what) => {
  const D = window.__draw, { G, ui } = D.get();
  Object.keys(ui).forEach((k) => delete ui[k]);
  if (what === 'vdef') { Object.assign(ui, { step: 'vdef', dc: { ...Object.values(D.PRESET)[0].dc }, to: false }); D.drawField(); D.drawFullDefDock(); }
  else if (what === 'defense') { Object.assign(ui, { step: 'defense', to: false }); D.drawField(); D.drawDefDock(); }
  else D.promptChoice(what);
}"""
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


# The site's addresses cached for good (its _headers) and every file's stamp (its sw.js, site.py stamps_of): a request
# for one of those addresses without its file's stamp would keep a phone on old bytes for a year
def stamps_of(root: Path) -> tuple[list[str], dict]:
    hdr = root / "_headers"
    pats = [ln.strip() for ln in hdr.read_text().splitlines() if ln.startswith("/")] if hdr.exists() else []
    m = re.search(r"const STAMPS = (\{.*?\});", (root / "sw.js").read_text()) if (root / "sw.js").exists() else None
    return pats, json.loads(m.group(1)) if m else {}


def unstamped(url: str, base: str, pats: list[str], stamps: dict) -> bool:
    u = urllib.parse.urlsplit(url)
    if not url.startswith(base) or not any(fnmatch.fnmatchcase(u.path, p) for p in pats):
        return False
    want = lambda f: stamps.get(f) or stamps.get(f.split("/")[0] + "/")
    q = urllib.parse.parse_qsl(u.query)
    return "v" not in dict(q) or any(want(u.path[1:] if k == "v" else k) != v for k, v in q)


HOME = """() => {
  const h = document.getElementById('homeview');
  if (!h || h.hidden) return null;
  return { text: h.innerText, hero: !!h.querySelector('.hhero'), cls: (h.querySelector('.hhero') || {}).className || '',
    surv: !!h.querySelector('a.hcard[href="#survivor"]'), cur: (document.querySelector('.modes [aria-current="page"]') || {}).id || '' };
}"""


async def look(page, js: str, default=None):
    """page.evaluate, or default while the page is reloading itself (for the timings: never worth failing on)."""
    try:
        return await page.evaluate(js)
    except Exception:
        return default


async def home_now(page) -> dict | None:
    """The home screen as it is (HOME), or None while the page is still reloading itself into it (a tap on Home is a
    hash change: the page reloads, and a look in the middle of that finds no page to look at)."""
    try:
        return await page.evaluate(HOME)
    except Exception:
        return None


async def visit_home(page, base: str, stored: bool) -> list[str]:
    """After a finished daily: Home from the end card, then the bare address (Home, today's drive done). Without
    storage (the nostore quirk) nothing says the day is done: Home only, as a new day."""
    out: list[str] = []
    first = await page.evaluate("() => { const a = document.querySelector('#bmenu > *'); return a ? a.getAttribute('href') : null; }")
    if first != "#home":
        out.append(f"the menu's first item is not Home ({first!r})")
    btn = page.locator("#done a.homebtn[href='#home']")
    if not await btn.count():
        return out + ["the daily end card has no Home button"]
    await btn.first.click(timeout=3000)
    for where in ("the end card's Home", "the bare address")[:2 if stored else 1]:
        h = None
        for _ in range(100):
            await page.wait_for_timeout(100)
            h = await home_now(page)
            if h:
                break
        if not h:
            out.append(f"{where} did not open the home screen")
        elif not h["hero"] or (stored and ("done" not in h["cls"] or "see your result" not in h["text"].lower())) or not h["surv"] or h["cur"] != "modeHome":
            out.append(f"{where}: the home screen is missing today's finished drive, survivor or the Home tab: {h['text'][:200]!r}")
        elif BAD_TEXT.search(h["text"]):
            out.append(f"broken text on the home screen: {BAD_TEXT.search(h['text']).group(0)!r}")
        if where == "the end card's Home" and stored:
            await page.goto(f"{base}/{PAGE}")
    return out


# how the page loaded (ms from its navigation): first byte, first paint, DOM ready, loaded, and what came over the wire
LOADED = """() => { const n = performance.getEntriesByType('navigation')[0] || {}, p = performance.getEntriesByName('first-contentful-paint')[0];
  const r = (x) => (x > 0 ? Math.round(x) : null);
  return { ttfb: r(n.responseStart), fcp: p ? r(p.startTime) : null, dcl: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd),
    kb: n.transferSize ? Math.round(n.transferSize / 1024) : null }; }"""
# frames the page took too long to draw (a gap between two animation frames over 200 ms while in view) and, where the
# browser reports them (not Safari), tasks that held the main thread over 50 ms; added up over the tab's pages (its
# sessionStorage: the drive reloads into itself)
# the bot's own tap on a key that opens a screen (Pass plays, the Home tools, help, stats): that screen was asked for
TAP_OPENS = """(() => { document.addEventListener('click', (e) => { const t = e.target && e.target.closest && e.target.closest('#playsBtn, .htool, #helpBtn, #statsBtn, #deepBtn');
  if (t) window.__opensAt = performance.now(); }, true); })();"""
JANK = """(() => { if (window.top !== window) return;
  let J = null; try { J = JSON.parse(sessionStorage.getItem('__jank') || 'null'); } catch (e) { /* no storage */ }
  J = window.__jank = J || { frames: 0, slow: 0, worst: 0, long: 0, longWorst: 0 };
  const keep = () => { try { sessionStorage.setItem('__jank', JSON.stringify(J)); } catch (e) { /* no storage */ } };
  addEventListener('pagehide', keep); setInterval(keep, 2000);
  let last = 0;
  const tick = (t) => { if (last && document.visibilityState === 'visible') { const g = t - last; J.frames++; if (g > 200) J.slow++; if (g > J.worst) J.worst = Math.round(g); }
    last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { J.long++; J.longWorst = Math.max(J.longWorst, Math.round(e.duration)); })).observe({ type: 'longtask', buffered: true }); } catch (e) { /* no long tasks here */ }
})();"""


# daily_check.py's live episodes pin the day (days from today) and the side taken, go on into a practice drive after
# the day's (practice), tap like a player in a hurry (rapid: no pauses, double taps, taps on the field, the phone turned
# sideways and back) and reload more (reloads_max). Every episode measures what a player waits on and works around
# (timing, friction: daily_check.py's report)
async def episode(browser, base: str, name: str, mode: str, seed: int, target: int, out: Path, mobile: bool, quirk: str = "",
                  stamped: tuple = ([], {}), first: bool = False, sweep: bool = False, day: int | None = None, side: int | None = None,
                  practice: bool = False, rapid: bool = False, reloads_max: int = 2) -> dict:
    rnd = random.Random(seed)
    vp = {"width": 390, "height": 844} if mobile else {"width": 1280, "height": 900}
    # (every other phone episode in the classic view, the phone's default: the field, the calls under it)
    # (only where main() wrapped new_context: the daily bot check, daily_check.py, opens its own and leaves every page as a
    # player gets it, the classic view on a phone)
    view = {"classic": mobile and seed % 2 == 1} if getattr(browser, "full_field", False) else {}
    ctx = await browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, **view)
    if day is None:
        day = seed % 9 if mode == "daily" else 0
    # a shifted date (each day's drive), and a seeded Math.random so a failing survivor run can be replayed
    await ctx.add_init_script(f"""(() => {{ const off = {day} * 864e5, _D = Date;
      class D extends _D {{ constructor(...a) {{ super(...(a.length ? a : [_D.now() + off])); }} static now() {{ return _D.now() + off; }} }}
      window.Date = D; window.__sepLog = [];
      let s = {seed} >>> 0; Math.random = () => {{ s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }}; }})();""")
    if quirk:
        await ctx.add_init_script(QUIRK[quirk])
    await ctx.add_init_script(JANK)
    await ctx.add_init_script(TAP_OPENS)
    if mode == "scenario":
        await pro_context(ctx, base)
    page = await ctx.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda e: problems.append(f"script error: {e}"))
    page.on("console", lambda m: m.type == "error" and "googletagmanager" not in m.text and "ERR_" not in m.text
            and not any(CUT(u) for u in [(m.location or {}).get("url") or "", *re.findall(r"https?://[^\s'\"]+", m.text)])
            and problems.append(f"console error: {m.text[:300]}"))
    # (a reload cuts short what is still downloading: the first call shows before the simulator's data is in; Safari
    # calls that cancelled. WebKit under Playwright fails the page's own blob: addresses "Blocked by Web Inspector",
    # the automation's doing: Safari itself loads them)
    page.on("requestfailed", lambda r: base in r.url and not CUT(r.url) and not re.search(r"ERR_ABORTED|cancell?ed", r.failure or "", re.I)
            and not (r.url.startswith("blob:") and "Web Inspector" in (r.failure or ""))
            and problems.append(f"request failed: {r.url} {r.failure}"))
    page.on("request", lambda r: unstamped(r.url, base, *stamped) and problems.append(f"an address cached for good, without its stamp: {r.url}"))
    url = f"{base}/{PAGE}" + ("#survivor" if mode == "survivor" else "#daily")
    scen, b = None, {"years": [0, 0]}
    if mode == "scenario":
        # the builder first (its checks), then a random scenario of the episode's kind, kicked off by its link
        await page.goto(f"{base}/{PAGE}#custom")
        try:
            await page.wait_for_selector("#arch .sacts .btn", timeout=30000)
            b = await page.evaluate(BUILDER)
            problems.extend(b["out"] if isinstance(b, dict) else b)
            scen = await page.evaluate(SCEN_PICK, [seed, seed % 4])
        except Exception as e:
            problems.append(f"the builder did not come up: {e}")
        if not scen:
            problems.append("no random scenario passed its checks")
        else:
            print(f"{name}: {scen['code']} (seasons {scen['first']}-{scen['last']}; builder offers {b['years'][0]}-{b['years'][1]})", flush=True)
            if b["years"] != [scen["first"], scen["last"]]:
                problems.append(f"the builder offers {b['years']}, the rosters {scen['first']}-{scen['last']}")
        url = f"{base}/{PAGE}#custom-{scen['code'] if scen else 'x'}"
        first = False                     # (a scenario's file carries no first-call facts: the simulator answers)
    timing: dict = {}                # ms: the front door, the drive's page, its intro and first call, a reload's way back
    friction = {"taps_to_first_call": 0, "modals": [], "snap": 0, "snap_out": 0, "snap_why": [], "covered": 0, "covered_by": [],
                "races": 0, "wait_s": 0.0, "wait_max_s": 0.0, "loading_s": 0.0, "loading_max_s": 0.0, "turned": 0, "timeouts": {}, "sheet_down": 0}
    if mode not in ("survivor", "scenario"):
        # the bare address is the front door: Home, with today's drive on it
        await page.goto(f"{base}/{PAGE}")
        h = None
        for _ in range(100):
            await page.wait_for_timeout(100)
            h = await home_now(page)
            if h:
                break
        if not h or not h["hero"]:
            problems.append("the bare address did not open the home screen")
        timing["home"] = await look(page, LOADED)
    t_drive = time.time()
    if mode != "survivor":
        async with page.expect_event("load"):  # (a hash-only move: the page reloads itself into the drive)
            await page.goto(url)
    else:
        await page.goto(url)
    finished = reloads = steps = rundowns = drawn = sketched = 0
    last_key, since, chaos_done = None, time.time(), set()
    trail: list[str] = []            # the last screens and actions, printed with a failure
    first_q = None                   # the quarter a daily drive starts in: a first-half drive ends at halftime
    restart_ep = mode in ("daily", "scenario") and seed % 2 == 1 and quirk != "nostore"     # (no storage: a reload is a new try already)
    rstate = SCENSTATE if mode == "scenario" else DAYSTATE
    restarted = False
    picked = None                    # a day of two sides: the one taken (asked once: a reload or a restart keeps it)
    pick_gone = False                # ... and the pick screen gone since (it takes the side's own file first: a moment)
    first_call = first               # the first call shows on the spot's own facts (game.js firstInfo), not the simulator's
    speeds_kept: list = []           # the sweeps' plays timed (game.js speedLog), taken off the page before it reloads

    async def keep_speeds():
        try:
            speeds_kept.extend(await page.evaluate("() => { const l = window.__speedLog || []; window.__speedLog = []; return l; }"))
        except Exception:
            pass
    asked = False                    # the bot opened the modal on screen itself (else it came up in the way)
    welcomed = False                 # the first visit's welcome seen (a second one, storage on, is in the way)
    t_reload = None                  # when the bot reloaded mid-drive (to time the way back to a call)
    turned = False                   # (rapid, on a phone: held sideways)

    def act(what):
        trail.append(f"  > {what}")
        if "first_call" not in timing:
            friction["taps_to_first_call"] += 1
    t_start = time.time()
    status = "ok"
    try:
        while time.time() - t_start < 900 and steps < 5000:
            steps += 1
            if problems:
                status = "error"
                break
            try:
                st = await page.evaluate(STATE)
                key = (st, await page.evaluate(SNAP) if st not in ("loading", "modal", "deep", "errbar") else "")
            except Exception:            # (the page reloading itself just then: no page to look at; one that never comes back is frozen)
                st, key = "loading", ("loading", "")
            if key != last_key:
                if last_key and last_key[0] in ("wait", "loading"):       # (the simulator thinking; a page loading)
                    w = time.time() - since
                    friction[f"{last_key[0]}_s"] += w
                    friction[f"{last_key[0]}_max_s"] = max(friction[f"{last_key[0]}_max_s"], w)
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
            if picked is not None and st not in ("pick", "loading"):
                pick_gone = True
            if st in ("intro", "pick") and "intro" not in timing:
                timing["intro"] = round(await look(page, "() => performance.now()", 0))
            if st == "choose" and "first_call" not in timing:
                timing.update(first_call=round(await look(page, "() => performance.now()", 0)), first_call_wall=round((time.time() - t_drive) * 1000),
                              drive=await look(page, LOADED))
            if st == "choose" and t_reload:
                timing.setdefault("reload", []).append(round((time.time() - t_reload) * 1000))
                t_reload = None
            try:
                if st in ("choose", "result", "end") and await page.locator("#sheet.down").count():
                    # the calls' sheet down (a phone: a drag on its grip, or a tap there, put it down to see the whole
                    # field): a player taps its bar to bring the calls back; the bot too (else it taps keys under the
                    # screen's edge for good). Counted: the bot's own drags and taps put it there
                    friction["sheet_down"] += 1
                    act("bring the calls back up"); await page.click("#grip", timeout=3000)
                elif st == "errbar":
                    problems.append("the page's error bar: " + await page.evaluate("() => document.getElementById('errBar').innerText.slice(0, 300)"))
                elif st == "error":
                    problems.append(f"error shown to the player: {key[1][:300]!r}")
                elif st == "modal" and await page.evaluate("() => !!document.querySelector('#modal .penacts')"):
                    # a flag on the other team during the play: accept or decline, either one (game.js penaltyAsk),
                    # or close it (the better one for the player)
                    k = rnd.choice(["accept", "decline", "close"])
                    friction.setdefault("penalties", []).append(k)
                    act("penalty " + k)
                    if k == "close":
                        await page.click("#mClose", timeout=3000)
                    else:
                        await page.locator("#modal .penpick").nth(0 if (k == "accept") == await page.evaluate("() => /^Accept/.test(document.querySelector('#modal .penpick b').textContent)") else 1).click(timeout=3000)
                elif st in ("modal", "deep"):
                    # (something came up over the game that the bot never asked for. Not the first visit's welcome
                    # (game.js openHelp, where the first drive's tour is not: a scenario, a Pro drive): a new player
                    # gets it once, and every time with storage off, private browsing)
                    welcome = st == "modal" and await page.evaluate("() => !!document.querySelector('#modal ol.quick')")
                    tapped = await page.evaluate("() => window.__opensAt != null && performance.now() - window.__opensAt < 3000")
                    if not asked and not tapped and not (welcome and (not welcomed or quirk == "nostore")):
                        friction["modals"].append(await page.evaluate("() => document.getElementById('modal').innerText.replace(/\\s+/g, ' ').slice(0, 80)")
                                                  if st == "modal" else "deep")
                    welcomed = welcomed or welcome
                    asked = False
                    await page.wait_for_timeout(rnd.choice([100, 400]))
                    act("close " + st); await page.click("#mClose" if st == "modal" else "#deepClose", timeout=3000)
                elif st == "pick":
                    if picked is not None and pick_gone:
                        problems.append(f"asked to pick a side again, after taking side {picked} (a reload or a restart must keep it)")
                        continue
                    if picked is not None:   # (the tap is still on its way: a pick screen that never goes is frozen)
                        await page.wait_for_timeout(100)
                        continue
                    picked = (seed // 2) % 2 if side is None else side      # (both sides over a few episodes, each with and without a restart)
                    act(f"pick side {picked}"); await page.click(f"#intro .sidepick[data-side='{picked}']", timeout=3000)
                elif st == "intro":
                    if picked is not None:
                        want = await page.evaluate(f"() => {{ const sp = document.querySelector('#intro .sidepick'); return !sp && /side ·/.test(document.querySelector('#intro .cat').textContent); }}")
                        if not want:
                            problems.append("a day of two sides: the drive's intro does not say the side taken")
                            continue
                    act("intro Next"); await page.click("#intro .btn", timeout=3000)
                elif st == "animating":
                    if restart_ep and "restart_mid" not in chaos_done:
                        # never mid-play: Start over during a play's animation asks nothing
                        chaos_done.add("restart_mid")
                        await page.evaluate("() => document.getElementById('restartBtn').click()")
                        if await page.evaluate("() => !document.getElementById('modal').hidden"):
                            problems.append("Start over asked in the middle of a play"); continue
                    if rapid:                    # (impatient: taps all over the field while it plays)
                        # (where it shows: a finger never lands past the screen's edge, where the bot's taps found the
                        # calls' sheet slid away for the play, its grip, and sent it down)
                        box, v = await page.locator("#field").bounding_box(), page.viewport_size
                        x0, y0 = max(box["x"], 0), max(box["y"], 0)
                        x1, y1 = min(box["x"] + box["width"], v["width"]), min(box["y"] + box["height"], v["height"])
                        for _ in range(rnd.randint(1, 3) if x1 > x0 and y1 > y0 else 0):
                            await page.mouse.click(x0 + rnd.random() * (x1 - x0), y0 + rnd.random() * (y1 - y0))
                    elif rnd.random() < 0.6:
                        await page.click("#field", timeout=1500)
                elif st == "result":
                    if rnd.random() < 0.08 and await page.locator("#dock .replay").count():
                        await page.click("#dock .replay", timeout=3000)
                    else:
                        await page.click("#dock .result .btn", timeout=3000)
                elif st == "end":
                    finished += 1
                    if mode == "daily" or finished >= target:
                        if mode in ("daily", "practice", "scenario"):
                            await page.click("#dock .endcard .btn", timeout=3000)
                            continue
                        break
                    await page.click("#dock .endcard .btn", timeout=3000)
                elif st == "summary":
                    if mode == "practice":
                        # practice's own card: graded, and saying it counts for nothing
                        t = await page.evaluate("() => document.getElementById('done').innerText")
                        if not await page.locator("#done .big-pct").count() or "Practice" not in t:
                            problems.append(f"the practice drive's end card: {t[:200]!r}")
                        else:
                            print(f"{name}: practice drive done")
                        break
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
                    if mode == "scenario":
                        # the grade card, the scenario on My scenarios with its grade, and the ways on: again, change it, send it
                        finished = max(finished, 1)
                        got = await page.evaluate("""(c) => { const L = JSON.parse(localStorage.getItem('tmd:v3:scen') || '{}');
                          return { card: !!document.querySelector('#done .gradecard .gbig'), rec: L[c] || null, acts: [...document.querySelectorAll('#done .pacts .btn')].map((b) => b.textContent),
                            board: !!document.querySelector('#done .dailybox, #done .leaders') }; }""", scen["code"])
                        if not got["card"] or not got["rec"] or not isinstance(got["rec"].get("p"), (int, float)) or got["rec"].get("tries") != 1:
                            problems.append(f"the scenario's end card or its My scenarios record is missing: {got}")
                        elif len(got["acts"]) < 4 or got["board"]:
                            problems.append(f"the scenario's end card: {got}")
                        else:
                            print(f"{name}: graded {round(got['rec']['p'] * 100)}, {got['acts']}")
                        break
                    if mode == "daily":
                        finished = max(finished, 1)
                        if picked is not None:        # a day of two sides: the end card and the share text name the side taken
                            side = await page.evaluate("() => { const b = document.querySelector('#done .sidetook b'), g = document.querySelector('#done .grid-share'); return [b ? b.textContent : '', g ? g.textContent : '']; }")
                            took = side[0][len("You played as "):] if side[0].startswith("You played as ") else ""     # (its city)
                            if not took or f"\nAs {took}: " not in side[1]:
                                problems.append(f"a day of two sides: the end card or the share text does not name the side taken: {side!r}")
                                continue
                        if restarted and not await page.locator("#done .rsnote").count():
                            problems.append("a restarted daily's end card does not say it is off the leaderboard")
                        if restart_ep and not restarted:
                            print(f"{name}: the drive ended before a second call, no Start over exercise")
                        # home: the end card's Home, the ☰ menu's first item, and the bare address (the day done)
                        try:
                            problems.extend(await visit_home(page, base, quirk != "nostore"))
                        except Exception as e:       # (said as itself, not as the home screen left to freeze)
                            problems.append(f"going home from the end card: {str(e).splitlines()[0][:200]}")
                        if practice and quirk != "nostore" and not problems:
                            # on into practice (the end card's Keep playing): one more real drive that counts for nothing
                            mode, first_call, restart_ep, picked, pick_gone = "practice", False, False, None, False
                            act("practice drive")
                            async with page.expect_event("load"):
                                await page.goto(f"{base}/{PAGE}#practice")
                            continue
                        break
                    if "home" not in chaos_done:
                        chaos_done.add("home")
                        if not await page.locator("#done a.homebtn[href='#home']").count():
                            problems.append("the survivor end card has no Home button")
                    if finished >= target:
                        break
                    await page.get_by_role("button", name="New run").click(timeout=3000)
                elif st == "choose" and mode == "survivor" and "norestart" not in chaos_done:
                    chaos_done.add("norestart")
                    if not await page.evaluate("() => document.getElementById('restartBtn').hidden"):
                        problems.append("survivor offers Start over (one life: it never should)")
                elif st == "choose" and restart_ep and "restart" not in chaos_done and (await page.evaluate(rstate) or {}).get("calls", 0) >= 1:
                    # Start over, a call in: asked first (the leaderboard note), then a new try the page reloads into
                    chaos_done.add("restart"); act("START OVER")
                    # (a deliberate tap, past the moment after a play when nothing on the field takes one: game.js
                    # AFTER_PLAY_MS)
                    # (while a play runs, theirs between your calls included, the page says to wait for it: game.js
                    # restartAsk. The tap is tried again once it is over)
                    txt, missing = "", False

                    async def ended():
                        # (a call in, the drive can still be over: a turnover the other side kneels out. No Start
                        # over then: canRestart. The end card comes instead)
                        for _ in range(40):
                            if (await page.evaluate(rstate) or {}).get("done") or await page.evaluate("() => !document.getElementById('done').hidden"):
                                print(f"{name}: the drive ended on the first call, no Start over exercise")
                                return True
                            await page.wait_for_timeout(500)
                        return False
                    for _ in range(6):
                        await page.wait_for_timeout(600)
                        for _ in range(40):
                            if not await page.evaluate("() => document.getElementById('field').classList.contains('playing')"):
                                break
                            await page.wait_for_timeout(250)
                        if await page.evaluate("() => document.body.classList.contains('bcast')"):
                            await page.click("#menuBtn", timeout=3000)
                            item = page.locator("#bmenu [data-restart]")
                            if not await item.is_visible():
                                await page.click("#menuBtn", timeout=3000)       # (closed again)
                                if not await ended():
                                    problems.append("the ☰ menu has no Start over during the daily")
                                missing = True; break
                            await item.click(timeout=3000)
                        else:
                            if not await page.locator("#restartBtn").is_visible():
                                if not await ended():
                                    problems.append("no Start over under the field during the daily")
                                missing = True; break
                            await page.click("#restartBtn", timeout=3000)
                        await page.wait_for_timeout(200)
                        txt = await page.evaluate("() => document.getElementById('modal').hidden ? '' : document.getElementById('modal').innerText")
                        if txt:
                            break
                    if missing:
                        continue
                    if ("fresh luck" if mode == "scenario" else "leaderboard") not in txt.lower():
                        problems.append(f"Start over did not ask first with the {'new try' if mode == 'scenario' else 'leaderboard'} note: {txt[:160]!r}"); continue
                    async with page.expect_event("load"):
                        await page.click("#modal [data-restart-go]", timeout=3000)
                    await page.wait_for_timeout(800)
                    ds = await page.evaluate(rstate)
                    if not ds or ds["restarts"] != 1 or ds["calls"] or ds["done"]:
                        problems.append(f"after Start over the {'scenario' if mode == 'scenario' else 'day'}'s state is not a new, marked try: {ds}")
                    restarted = True
                    print(f"{name}: started over (asked first, a new try marked restarted)")
                elif st == "choose" and sweep and "short_field" not in chaos_done:
                    chaos_done.add("short_field"); act("short-field sweep")
                    plays, off = 0, []
                    for yl in (20, 10, 5, 3, 1, 95, 97, 99):     # (one spot at a time: a page drawing them all at once ran out of memory)
                        sf = await page.evaluate(SHORT_FIELD, yl)
                        plays += sf["plays"]; off += sf["bad"] if sf["n"] else []
                    await keep_speeds()
                    since = time.time()
                    print(f"{name}: short fields, {plays} plays drawn, {len(off)} off the ground")
                    if off:
                        problems.append(f"off the field on a short field: {off[:4]}")
                elif st == "choose" and sweep and "pass_look" not in chaos_done:
                    chaos_done.add("pass_look"); act("pass-look sweep")
                    rows, off, edge, t_pl = [], [], [0, 0], time.time()
                    for k in range(4):                    # (in batches: a page drawing them all at once ran out of memory)
                        pl = await page.evaluate(PASS_LOOK, [150, seed * 17 + k])
                        rows += pl["rows"]; off += pl["off"]; edge = [a + b for a, b in zip(edge, pl["edge"])]
                    await keep_speeds()
                    since = time.time()
                    t_start += since - t_pl
                    mix = {}
                    for x in rows:
                        mix[x.get("label") or x.get("miss")] = mix.get(x.get("label") or x.get("miss"), 0) + 1
                    wrong = pass_look_problems(rows)
                    print(f"{name}: pass looks, {len(rows)} passes drawn {dict(sorted(mix.items(), key=lambda kv: -kv[1]))}, {len(wrong)} not as they went, "
                          f"{len(off)} off the ground, ending by the left and right sidelines {edge}")
                    if not all(edge):
                        problems.append(f"the pass sweep never ended a pass by both sidelines (left, right: {edge})")
                    if wrong:
                        problems.append(f"a pass not drawn as it went: {wrong[:4]}")
                    if off:
                        problems.append(f"off the field on a pass: {off[:4]}")
                elif st == "choose" and sweep and "real_plays" not in chaos_done:
                    chaos_done.add("real_plays"); act("real plays sweep")
                    t_rp, n_rp, errs_rp = time.time(), 0, []
                    for k in range(3):
                        rp = await page.evaluate(REAL_PLAYS, [100, seed * 13 + k])
                        n_rp += rp["plays"]; errs_rp += rp["errs"]
                    await keep_speeds()
                    since = time.time()
                    t_start += since - t_rp
                    print(f"{name}: real plays, {n_rp} run by the simulator and drawn" + (f", {len(errs_rp)} not run: {errs_rp[:2]}" if errs_rp else ""))
                    if errs_rp:
                        problems.append(f"real plays not run: {errs_rp[:3]}")
                elif st == "choose" and sweep and "goal_line" not in chaos_done:
                    chaos_done.add("goal_line"); act("goal-line sweep")
                    t_gl, n_gl, tally, wrong = time.time(), 0, {}, []
                    for yl in (1, 2, 5, 20, 97, 99):          # (one spot at a time, as the short fields)
                        gl = await page.evaluate(GOAL_LINE, [yl, False])
                        n_gl += gl["plays"]; wrong += gl["bad"]
                        for k, v in gl["tally"].items():
                            tally[k] = tally.get(k, 0) + v
                    await keep_speeds()
                    since = time.time()
                    t_start += since - t_gl
                    print(f"{name}: goal line, {n_gl} plays drawn, {sum(tally.values())} not as they went {tally or ''}")
                    if wrong:
                        problems.append(f"the ball against the goal line not as the play went: {wrong[:4]}")
                elif st == "choose" and sweep and "draw_fuzz" not in chaos_done:
                    # thousands of drawings of every kind (runs, RPOs, the defense, kicks, the rush on theirs)
                    chaos_done.add("draw_fuzz"); act("drawing fuzz")
                    t_fz = time.time()
                    tot = {"n": 0, "taps": 0, "plays": 0, "real": 0}
                    for k, kind in enumerate(("run", "rpo", "def", "kick", "stdef")):
                        fz = await page.evaluate(DRAW_FUZZ, [kind, 700, seed * 31 + k])
                        for f in tot:
                            tot[f] += fz[f]
                        top = sorted(fz["mapped"].items(), key=lambda kv: -kv[1])[:6]
                        print(f"{name}: drawn {kind}: {fz['n']} lines, {sum(fz['mapped'].values())} read as calls {dict(top)}, refused {fz['faults']}, "
                              f"{fz['plays']} plays shown, {fz['real']} run by the simulator")
                        if fz["bad"]:
                            problems.append(f"a {kind} drawing read as a call that isn't one: {fz['bad'][:3]}")
                        if fz["off"]:
                            problems.append(f"off the field on a drawn {kind}: {fz['off'][:3]}")
                        if fz["realBad"]:
                            problems.append(f"a drawn {kind} ran another call in the simulator: {fz['realBad'][:3]}")
                        since = time.time()
                    since = time.time()
                    t_start += since - t_fz          # (the fuzz's minutes don't count against the episode's 900 s)
                    print(f"{name}: drawing fuzz, {tot['n']} drawings, {tot['plays']} plays on the field, {tot['real']} simulated")
                elif st == "choose":
                    tu = await look(page, TIMEOUT_UI)
                    if tu and tu["want"]:
                        tk = f"{tu['where']}, " + (f"{tu['to']} left" if tu["to"] else "none left")
                        friction["timeouts"][tk] = friction["timeouts"].get(tk, 0) + 1
                        wrong = (tu["to"] > 0 and not tu["shown"]) or (tu["to"] == 0 and (tu["shown"] or not tu["note"]))
                        if wrong:          # (looked at again a moment later: a dock still being drawn is not a missing key)
                            await page.wait_for_timeout(400)
                            tu2 = await look(page, TIMEOUT_UI)
                            if tu2 and tu2["want"] and tu2["t"] == tu["t"] and tu2["where"] == tu["where"] and \
                                    ((tu2["to"] > 0 and not tu2["shown"]) or (tu2["to"] == 0 and (tu2["shown"] or not tu2["note"]))):
                                problems.append(f"the timeout on {tu2['where']}: {tu2['to']} left, " + ("no timeout to call" if tu2["to"] > 0 else
                                                ("a timeout offered" if tu2["shown"] else "nothing says there are none")) + f" ({tu2})")
                                continue
                    if first_call:
                        first_call = False
                        if not await page.evaluate("() => performance.getEntriesByName('tmd:first-info').length"):
                            problems.append("the first call waited on the simulator: the spot's file has its facts (site.py spot_info), unused")
                            continue
                    if not turned and await page.locator("#snapGo:visible").count():
                        # the Snap key in reach as it comes up, nobody having scrolled (snap_reach's test, on every pass)
                        friction["snap"] += 1
                        far = await page.evaluate(REACH, "#snapGo")
                        if far:
                            friction["snap_out"] += 1
                            if len(friction["snap_why"]) < 3:
                                friction["snap_why"].append(far[0][:160])
                    asked = False
                    r = rnd.random()
                    if rapid and mobile and rnd.random() < 0.04 and friction["turned"] < 4:
                        # the phone turned sideways (and back, the next time)
                        v = page.viewport_size
                        act("turn the phone"); turned = not turned; friction["turned"] += 1
                        await page.set_viewport_size({"width": v["height"], "height": v["width"]})
                    elif r < 0.03 and "help" not in chaos_done:
                        chaos_done.add("help"); act("help"); asked = True; await page.click("#helpBtn", timeout=3000)
                    elif r < 0.06 and "stats" not in chaos_done:
                        chaos_done.add("stats"); act("stats"); asked = True; await page.click("#statsBtn", timeout=3000)
                    elif r < 0.09 and "deep" not in chaos_done and await page.locator("#deepBtn").is_visible():
                        chaos_done.add("deep"); act("player ratings"); asked = True; await page.click("#deepBtn", timeout=3000)
                    elif r < 0.12 and "bar" not in chaos_done:
                        chaos_done.add("bar"); act("game details"); asked = True; await page.click("#bar", timeout=3000)
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
                    elif rnd.random() < 0.5 and (sk := await page.evaluate(SKETCH)) and sk["men"]:
                        # draw the play: a run or an RPO through the line, the defense (a rush or a drop), a kick; then
                        # mostly call what it reads as
                        x, y = rnd.choice(sk["men"])[:2]
                        up, ppy, ly = sk["up"], sk["ppy"], sk["los"][1]
                        if sk["ctx"] in ("play", "run", "rpo"):
                            pts = [(x + rnd.uniform(-8, 8) * ppy, ly - up * rnd.uniform(0, 3) * ppy), (x + rnd.uniform(-12, 12) * ppy, ly + up * rnd.uniform(1, 12) * ppy)]
                            if rnd.random() < 0.3:
                                pts.append((pts[-1][0] + rnd.uniform(-6, 6) * ppy, pts[-1][1] + up * rnd.uniform(0, 8) * ppy))
                        elif sk["ctx"] == "st" and len(sk["men"]) == 1:
                            pts = [(x + rnd.uniform(-10, 10) * ppy, y + up * rnd.uniform(8, 75) * ppy)]
                        else:
                            pts = [(x + rnd.uniform(-6, 6) * ppy, y + rnd.choice([-1, 1]) * rnd.uniform(2, 14) * ppy)]
                        act(f"draw ({sk['ctx']})")
                        await page.mouse.move(x, y); await page.mouse.down()
                        for nx, ny in pts:
                            for t in range(1, 7):
                                await page.mouse.move(x + (nx - x) * t / 6, y + (ny - y) * t / 6)
                            x, y = nx, ny
                        await page.mouse.up()
                        sketched += 1
                        await page.wait_for_timeout(120)
                        if rnd.random() < 0.85 and await page.locator("#drawGo:visible").count():
                            act("call it as drawn"); await page.click("#drawGo", timeout=3000)
                    elif await page.locator("#drawBtn:visible").count() and await page.evaluate("() => !!(window.__draw && window.__draw.drawCtx() === 'pass')") and rnd.random() < 0.45:
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
                    elif r < (0.14 if reloads_max <= 2 else 0.3) and reloads < reloads_max:
                        reloads += 1
                        act("RELOAD")
                        t_reload = time.time()
                        if quirk == "nostore":       # (nothing kept: the side is asked again, as a new try)
                            picked, pick_gone = None, False
                        await page.reload()
                        await page.wait_for_timeout(800)
                    else:
                        # (on a phone the timeout is the button on the field, not one in the dock)
                        btns = page.locator("#dock button:visible:not([disabled]), #toBtn:visible")
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
                            for _ in range(rnd.randint(0, 2) if rapid else 0):      # (a double or triple tap: the key may be gone)
                                await b.click(timeout=600, no_wait_after=True)
                        else:
                            rcv = page.locator("#field .rcv, #field [data-rcv]")
                            if await rcv.count():
                                await rcv.nth(rnd.randrange(await rcv.count())).click(timeout=3000)
            except Exception as e:
                # a button that moved or vanished between looking and clicking: look again (counted: a tap that something
                # else on the page took is friction, what took it said; a rapid episode's extra taps miss by design)
                over = re.search(r"(<[^>]{1,100}>)(?: from <[^>]+> subtree)? intercepts pointer events", str(e))
                if over and not rapid:
                    friction["covered"] += 1
                    if len(friction["covered_by"]) < 3:
                        friction["covered_by"].append(over.group(1))
                else:
                    friction["races"] += 1
            # (rapid: no pause between taps; while the page thinks or loads there is nothing to tap, and it looks as
            # often as any player. Looking every few ms there, two whole survivor games ran past the steps allowed)
            await page.wait_for_timeout(rnd.choice([0, 10, 20] if rapid and st not in ("wait", "loading") else [30, 60, 120]))
        else:
            problems.append(f"never finished: {finished} of {target} games after {steps} steps")
        if not problems and finished < (1 if mode == "daily" else target):
            problems.append(f"stopped after {finished} of {target} games")
        # every pass in the air at a pass's speed: none hanging over the line waiting for its receiver (game.js logs
        # one slower than 10 yards a second over more than 0.45 s)
        floats = await page.evaluate("() => window.__floatLog || []")
        if floats:
            problems.append(f"{len(floats)} passes hung in the air: {floats[:3]}")
    finally:
        try:
            seps = await page.evaluate("() => window.__sepLog || []")
            tackles = await page.evaluate("() => window.__tackleLog || []")
            fps = await page.evaluate("() => window.__fpLog || []")
            offs = await page.evaluate("() => window.__offLog || []")
            oobs = await page.evaluate("() => window.__oobLog || []")
            speeds = speeds_kept + await page.evaluate("() => window.__speedLog || []")
            goals = await page.evaluate("() => window.__goalLog || []")
            cams = await page.evaluate("() => window.__camLog || []")
            passes = await page.evaluate("() => window.__passLog || []")
            qbs = await page.evaluate("() => window.__qbLog || []")
            kept = await page.evaluate("() => (window.__drawLog || []).length")
            snaps = await page.evaluate("() => window.__drawSnaps || []")
            jank = await page.evaluate("() => window.__jank || null")
        except Exception:
            seps, tackles, fps, offs, oobs, speeds, goals, kept, snaps, jank = [], [], [], [], [], [], [], 0, [], None
            cams, passes, qbs = [], [], []
        shot = None
        if problems:
            status = "fail"
            shot = out / f"{name}.png"
            try:
                await page.screenshot(path=str(shot), full_page=True)
            except Exception:
                shot = None
        await ctx.close()
    return {"name": name, "status": status, "finished": finished, "reloads": reloads, "steps": steps,
            "secs": round(time.time() - t_start), "rundowns": rundowns, "drawn": drawn, "kept": kept, "sketched": sketched, "snaps": snaps, "problems": problems[:5], "seps": seps, "tackles": tackles, "fps": fps, "offs": offs, "oobs": oobs, "speeds": speeds, "goals": goals, "cams": cams, "passes": passes, "qbs": qbs, "trail": trail if problems else [],
            "day": day, "side": picked, "timing": timing, "friction": friction, "jank": jank, "shot": shot.name if shot else None}


# the dock's words and its first key that can be pressed (marked for the click), at one moment
HALF_LOOK = """() => {
  const d = document.getElementById('dock');
  d.querySelectorAll('[data-bt-pick]').forEach((b) => b.removeAttribute('data-bt-pick'));
  const k = [...d.querySelectorAll('.key:not([disabled])')].find((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden');
  if (k) k.setAttribute('data-bt-pick', '');
  return { txt: d.innerText, key: !!k };
}"""


async def scenario_half(browser, base: str) -> list[str]:
    """A first-half scenario played to the final gun: at halftime the card says who gets the ball, and the second half
    kicks off from 15:00 of the third quarter."""
    out: list[str] = []
    ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
    await pro_context(ctx, base)
    await ctx.add_init_script("try { localStorage.setItem('tmd:v3:seen', 'true'); } catch (e) {}")      # (no first-visit help over Play)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}#custom")
        await page.wait_for_selector("#arch .sacts .btn", timeout=30000)
        sc = await page.evaluate(SCEN_PICK, [11, 4])
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#custom-{sc['code']}")
        await page.click("#intro .btn", timeout=30000)
        for _ in range(600):           # their snap with 0:02 left in the half (your defense: any call; anything after), then halftime
            await page.wait_for_timeout(150)
            # (what the dock says and the key to press, read at one moment: the halftime card can come up between a read
            # of the dock and a look for a key, and its one key, Receive the kickoff, pressed unseen took the test into
            # the third quarter)
            look = await page.evaluate(HALF_LOOK)
            txt = look["txt"]
            if TRACE_HALF:
                print(repr(txt[:120]), await page.evaluate("() => document.getElementById('bar').innerText.replace(/\\n/g, ' ')"))
            if "halftime" in txt.lower():
                break
            if await page.locator("#field.playing").count():
                await page.click("#field", timeout=2000)
            elif look["key"]:
                try:                   # (that key, or none: gone, the dock has moved on, read it again)
                    await page.locator("#dock [data-bt-pick]").click(timeout=2000)
                except PWTimeout:
                    pass
            elif await page.locator("#dock .result .btn:visible").count():
                await page.locator("#dock .result .btn").first.click(timeout=2000)
        else:
            return out + [f"no halftime card: {txt[:160]!r}"]
        if "You get the ball" not in txt:
            out.append(f"the halftime card does not say who gets the ball: {txt[:160]!r}")
        await page.locator("#dock .key.big", has_text="Receive").click(timeout=3000)
        for _ in range(200):
            await page.wait_for_timeout(150)
            bar = await page.evaluate("() => document.getElementById('bar').innerText")
            if "Q3" in bar:
                break
        else:
            out.append(f"the second half did not start: {bar!r}")
    except Exception as e:
        out.append(f"scenario halftime: {e}")
    finally:
        out.extend(errs)
        await ctx.close()
    return out


async def scenario_pitch(browser, base: str) -> list[str]:
    """A scenario's link opened without Pro: what it is (its summary) and the Pro pitch, never the game; a link with a
    broken code says so."""
    out: list[str] = []
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base, pro=False)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}#custom")
        await page.wait_for_selector("#arch .sacts .btn", timeout=30000)
        sc = await page.evaluate(SCEN_PICK, [7, 1])
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#custom-{sc['code']}")
        await page.wait_for_selector("#arch .scnsum", timeout=30000)
        got = await page.evaluate("() => ({ pro: !!document.querySelector('#arch .pro .btn'), play: !document.getElementById('play').hidden || !document.getElementById('intro').hidden, text: document.getElementById('arch').innerText })")
        if not got["pro"] or got["play"] or "Pro" not in got["text"]:
            out.append(f"without Pro a scenario's link is not the pitch: {got['text'][:200]!r}")
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#custom-1-KC-2026")
        await page.wait_for_timeout(1500)
        t = await page.evaluate("() => document.getElementById('arch').innerText")
        if "doesn’t work" not in t:
            out.append(f"a broken scenario link does not say so: {t[:160]!r}")
    except Exception as e:
        out.append(f"scenario pitch: {e}")
    finally:
        out.extend(errs)
        await ctx.close()
    return out


async def scenario_community(browser, base: str, shots: str = "") -> list[str]:
    """Community scenarios (#community, game.js renderCommunity; board/worker.js /scen/*, the stub): the builder's title
    on the summary card and in the link, Post to Community (signed in, a username) sending the code and the title, the
    list showing it (title, creator, plays, won), its tap opening the scenario's link (without Pro: the pitch, titled);
    with Pro the link plays it and asks the board to count the play. shots: a folder for 390x844 screenshots."""
    out: list[str] = []
    COMM.update(rows=[], plays=[], posts=[])
    errs: list[str] = []
    title = "Brady's last stand"
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base, pro=False, comm=True)
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}#archive")
        await page.wait_for_selector("#arch a.scnentry.comm[href='#community']", timeout=30000)
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#custom")
        await page.wait_for_selector("#scn-title", timeout=30000)
        await page.locator("#arch .spre .key").first.click()
        await page.fill("#scn-title", title)
        got = await page.evaluate("() => (document.querySelector('#arch .ssum .scnsum .stl') || {}).textContent || ''")
        if got != title:
            out.append(f"the summary card does not show the title: {got!r}")
        if shots:
            await page.locator("#scn-title").scroll_into_view_if_needed()
            await page.evaluate("() => scrollBy(0, -120)")
            await page.screenshot(path=f"{shots}/builder-title.png")
        await page.locator("#arch .sacts button", has_text="Post to Community").click()
        await page.wait_for_selector("#arch .spost a[href='#community']", timeout=10000)
        if not COMM["posts"] or COMM["posts"][-1].get("title") != title or not re.match(r"^1(?:-[0-9A-Za-z]{1,4}){21}$", COMM["posts"][-1].get("code", "")) \
                or COMM["posts"][-1].get("session") != SESSION:
            out.append(f"Post to Community sent {COMM['posts'][-1:]!r}")
        # a second scenario on the list, posted by someone else and not played yet
        code0 = COMM["rows"][0]["code"] if COMM["rows"] else ""
        sc = await page.evaluate(SCEN_PICK, [5, 1])
        COMM["rows"].append({"id": "OTHER001", "code": sc["code"], "title": "Fourth and forever", "name": "Someone", "at": "2026-10-19T16:00:00Z", "n": 0, "f": 0, "w": 0, "best": None})
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#community")
        await page.wait_for_selector("#arch .clist a.day.comm", timeout=30000)
        rows = await page.evaluate("() => [...document.querySelectorAll('#arch .clist a.day.comm')].map((a) => ({ text: a.innerText, href: a.getAttribute('href'), del: a.parentElement.classList.contains('scnrow') && !!a.parentElement.querySelector('.scnx') }))")
        if len(rows) != 2:
            out.append(f"the list shows {len(rows)} scenarios, not 2: {rows!r}")
        else:
            t0 = rows[0]["text"]
            if title not in t0 or "by Tester" not in t0 or "12 plays" not in t0 or "40% won" not in t0 or "Pro" not in t0 or not rows[0]["del"]:
                out.append(f"the posted scenario's row: {t0!r}")
            if "0 plays" not in rows[1]["text"] or "won" in rows[1]["text"] or rows[1]["del"]:
                out.append(f"an unplayed scenario's row: {rows[1]['text']!r}")
            if not rows[0]["href"].startswith(f"#custom-{code0}~"):
                out.append(f"the row's link: {rows[0]['href']!r}")
        if BAD_TEXT.search(await page.evaluate("() => document.getElementById('arch').innerText")):
            out.append("broken text on the community list")
        if shots:
            await page.screenshot(path=f"{shots}/community.png")
            await page.screenshot(path=f"{shots}/community-full.png", full_page=True)
        async with page.expect_event("load"):
            await page.locator("#arch .clist a.day.comm").first.click()
        await page.wait_for_selector("#arch .scnsum", timeout=30000)
        got = await page.evaluate("() => ({ stl: (document.querySelector('#arch .scnsum .stl') || {}).textContent || '', pro: !!document.querySelector('#arch .pro .btn') })")
        if got["stl"] != title or not got["pro"]:
            out.append(f"without Pro the community scenario is not the titled pitch: {got!r}")
        if COMM["plays"]:
            out.append("a pitch counted a play")
    except Exception as e:
        out.append(f"community: {e}")
    finally:
        await ctx.close()
    # with Pro: the link plays it, under its title, and the board is asked to count the play
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base, pro=True, comm=True)
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        href = COMM["rows"][0]["code"] + "~" + urllib.parse.quote(title) if COMM["rows"] else "x"
        await page.goto(f"{base}/{PAGE}#custom-{href}")
        await page.wait_for_selector("#intro .btn", timeout=30000)
        lab = await page.evaluate("() => document.getElementById('dayLabel').textContent")
        if title not in lab:
            out.append(f"the scenario plays without its title: {lab!r}")
        for _ in range(50):
            if COMM["plays"]:
                break
            await page.wait_for_timeout(100)
        if not COMM["plays"] or COMM["plays"][0].get("code") != COMM["rows"][0]["code"] or COMM["plays"][0].get("done"):
            out.append(f"the play was not reported: {COMM['plays']!r}")
    except Exception as e:
        out.append(f"community play: {e}")
    finally:
        out.extend(errs)
        await ctx.close()
    return out


# every question the page asks its simulator, by the scenario it names (game.js simScen: a quarterback put in has a
# simulator of his own, its id ending |qb:<his name>), and every call snapped with the grouping it carries (withTempo)
WORKER_SPY = """(() => {
  const pm = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    try { if (m && m.scen && m.type !== 'init') (window.__scenIds = window.__scenIds || []).push(`${m.type}|${m.scen.id}`); } catch (e) { /* not the game's */ }
    try { if (m && m.type === 'step' && m.action && m.action.call != null) (window.__stepActs = window.__stepActs || []).push({ call: m.action.call, pers: m.action.pers ?? null, form: m.action.form ?? null, bf: m.action.bf ?? null }); } catch (e) { /* not the game's */ }
    return pm.call(this, m, t);
  };
})();"""
# the sheet's rows (Who plays): each row's label and its choices, the one picked
PERS_ROWS = """() => [...document.querySelectorAll('#mBody .pslot')].map((r) => { const s = r.querySelector('select');
  return { lab: r.querySelector('span').textContent, opts: [...s.options].map((o) => o.textContent), val: s.value, dis: s.disabled }; })"""
# your quarterback on the field (his dot), and what the simulator is asked with
QB_NOW = """() => { const D = window.__draw, { G } = D.get(), sc = D.simScen(), t = sc.game[G.me === 0 ? 'home' : 'away'];
  const dot = [...document.querySelectorAll('#field g.dot.me')].map((g) => g.getAttribute('aria-label') || '').find((x) => /Quarterback/.test(x)) || '';
  return { qb: G.qb || null, id: sc.id, name: t.qb.name, adj: t.qb.adjustment, dot, decisions: G.decisions.length, ids: window.__scenIds || [] }; }"""


async def to_offense(page, base: str) -> bool:
    """A survivor run's first snap, your ball (snap_reach's way in)."""
    await page.goto(f"{base}/{PAGE}#survivor")
    for _ in range(300):
        await page.wait_for_timeout(100)
        if await page.locator("#intro .btn:visible").count():
            await page.click("#intro .btn", timeout=3000)
        elif await page.locator("#modal:not([hidden]) #mClose").count():
            await page.click("#mClose", timeout=3000)
        elif await page.locator(".tipskip:visible").count():
            await page.click(".tipskip", timeout=3000)
        elif await page.locator("#dock .key.big:visible", has_text="Pass").count() and await page.locator("#persBtn:visible").count():
            return True
    return False


async def qb_swap(browser, base: str, shots: str = "") -> list[str]:
    """Who plays, the quarterback (game.js openPers, teamOf, simScen; web/scenario.js withQb), on a phone: the sheet's
    first row is QB, the one who lined up and that game's others ("Name · 71", the others "(backup)"), with a line on
    the one picked; a backup picked is the one on the field and the one the simulator plays (his adjustment the team's,
    every question asked of his simulator), a pass snapped with him is graded and played there, and Back to the real
    lineup brings the starter back. shots: a folder for the sheet's 390x844 screenshot."""
    out: list[str] = []
    for attempt in range(5):                 # (a run's first spot is drawn at random: one whose team has another quarterback)
        ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        await ctx.add_init_script(OPEN_OPTS)            # (the field's options open: Personnel, Formation)
        await ctx.add_init_script("window.__sepLog = []; try { localStorage.setItem('tmd:v3:seen', 'true'); } catch (e) {}")
        await ctx.add_init_script(WORKER_SPY)
        page = await ctx.new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
        try:
            if not await to_offense(page, base):
                out.append("Who plays: the first snap never came up")
                return out
            before = await page.evaluate(QB_NOW)
            # (the moment after a play takes no tap on the field's buttons: game.js AFTER_PLAY_MS; the kickoff's or
            # their drive's last play may just have ended)
            await page.wait_for_timeout(700)
            await page.click("#persBtn", timeout=3000)
            await page.wait_for_selector("#mBody .pslot select", timeout=5000)
            rows = await page.evaluate(PERS_ROWS)
            if not rows or rows[0]["lab"] != "QB":
                out.append(f"Who plays: the first row is not the quarterback's: {rows[:1]!r}")
                return out
            q = rows[0]
            if len(q["opts"]) < 2:
                if attempt < 4:
                    continue
                out.append("Who plays: no spot with another quarterback in five tries")
                return out
            want = q["opts"][1].split(" · ")[0]
            if not re.match(r"^.+ · \d{2}$", q["opts"][0]) or not q["opts"][1].endswith("(backup)") or q["opts"][0].split(" · ")[0] != before["name"]:
                out.append(f"Who plays: the quarterbacks' labels {q['opts']!r} (lined up: {before['name']!r})")
            await page.locator("#mBody .pslot select").first.select_option(label=q["opts"][1])
            await page.wait_for_timeout(300)
            note = await page.evaluate("() => (document.querySelector('#mBody .pqb') || {}).textContent || ''")
            if "dropback" not in note and "playing time" not in note:
                out.append(f"Who plays: no line on the quarterback picked: {note!r}")
            if shots:
                await page.screenshot(path=f"{shots}/who-plays-qb.png")
            await page.click("#mBody .pdone", timeout=3000)
            await page.wait_for_timeout(600)
            now = await page.evaluate(QB_NOW)
            if now["qb"] != want or now["name"] != want or not now["id"].endswith(f"|qb:{want}") or want not in now["dot"]:
                out.append(f"Who plays: {want} picked, but {now!r}")
            if abs(now["adj"] - before["adj"]) < 1e-9 and want != before["name"]:
                out.append(f"Who plays: {want} plays with the starter's adjustment ({now['adj']})")
            # a pass snapped with him: graded and played on his simulator (every question from his pick on)
            n0 = len(now["ids"])
            await page.locator("#dock .key.big:visible", has_text="Pass").first.click(timeout=3000)
            await page.wait_for_selector("#snapGo", timeout=10000)
            await page.click("#snapGo", timeout=5000)
            for _ in range(300):
                await page.wait_for_timeout(100)
                st = await page.evaluate(QB_NOW)
                if st["decisions"] >= 1:
                    break
            else:
                out.append("Who plays: the pass with the backup was never graded")
            asked = [x for x in st["ids"][n0:] if x.startswith(("eval|", "step|"))]
            if not any(x.startswith("eval|") for x in asked) or not any(x.startswith("step|") for x in asked) or not all(x.endswith(f"|qb:{want}") for x in asked):
                out.append(f"Who plays: the snap was not asked of his simulator: {asked[-6:]!r}")
            # and back to the real lineup
            for _ in range(200):
                await page.wait_for_timeout(100)
                if await page.locator("#field.playing").count():
                    await page.click("#field", timeout=2000)
                elif await page.locator("#dock .result .btn:visible").count():
                    await page.locator("#dock .result .btn").first.click(timeout=2000)
                elif await page.locator("#persBtn:visible").count() and await page.locator("#dock .key.big:visible", has_text="Pass").count():
                    break
            else:
                return out + errs        # (the drive moved on to their ball: the swap back is checked elsewhere)
            await page.wait_for_timeout(700)         # (AFTER_PLAY_MS: the play just ended)
            await page.click("#persBtn", timeout=3000)
            await page.wait_for_selector("#mBody .pslot select", timeout=5000)
            rows = await page.evaluate(PERS_ROWS)
            if rows[0]["val"] != want:
                out.append(f"Who plays: the sheet forgot the backup: {rows[0]!r}")
            await page.locator("#mBody button.ghost", has_text="Back to the real lineup").click(timeout=3000)
            await page.click("#mBody .pdone", timeout=3000)
            await page.wait_for_timeout(400)
            back = await page.evaluate(QB_NOW)
            if back["qb"] or back["name"] != before["name"] or back["id"] != before["id"]:
                out.append(f"Who plays: back to the real lineup, but {back!r}")
            return out + errs
        except Exception as e:
            out.append(f"Who plays: {e}")
            return out + errs
        finally:
            await ctx.close()
    return out


# your grouping as the page has it, the men swapped in, and the calls snapped so far (WORKER_SPY)
PERS_NOW = """() => { const { G } = window.__draw.get(); return { pers: G.pers || null, who: G.persWho || null, acts: window.__stepActs || [] }; }"""


# the formation as the page has it, and your quarterback's and your back's dots on the field (page x, y: down the screen)
FORM_NOW = """() => { const { G } = window.__draw.get(), M = document.getElementById('field').getScreenCTM();
  const at = (re) => { const g = [...document.querySelectorAll('#field g.dot.me')].find((x) => re.test(x.getAttribute('aria-label') || '')); if (!g) return null;
    const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || ''); const p = new DOMPoint(+m[1], +m[2]).matrixTransform(M); return [p.x, p.y]; };
  return { form: G.form || null, qb: at(/Quarterback/), rb: at(/Running back/), chip: (document.getElementById('formBtn') || {}).textContent || '', acts: window.__stepActs || [] }; }"""


async def formation_pick(browser, base: str, shots: str = "") -> list[str]:
    """The formation (game.js openForm, formation; engine.js FORM_CODE), on a phone: the chip beside Personnel opens a
    sheet of the quarterback's spots and the receivers' looks; Pistol moves the quarterback up and the back behind him,
    the chip says so, and the pass snapped goes to the simulator with form 'pistol'; Empty takes the back out of the
    backfield and goes to the simulator with no formation (the lineup only); Back to the real lineup clears it."""
    out: list[str] = []
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await ctx.add_init_script(OPEN_OPTS)            # (the field's options open: Personnel, Formation)
    await ctx.add_init_script("window.__sepLog = []; try { localStorage.setItem('tmd:v3:seen', 'true'); } catch (e) {}")
    await ctx.add_init_script(WORKER_SPY)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))

    async def pick(label):
        await page.click("#formBtn", timeout=3000)
        await page.wait_for_selector("#mBody .pgroup", timeout=5000)
        if shots:
            await page.screenshot(path=str(Path(shots) / f"formation-sheet-{label.lower()}.png"))
        await page.locator("#mBody .pgroup", has_text=label).first.click(timeout=3000)
        await page.wait_for_timeout(200)
        await page.click("#mBody .pdone", timeout=3000)
        await page.wait_for_timeout(1500)        # (the men jog to their new spots)
        return await page.evaluate(FORM_NOW)

    async def snap_pass():
        n0 = len((await page.evaluate(FORM_NOW))["acts"])
        await page.locator("#dock .key.big:visible", has_text="Pass").first.click(timeout=3000)
        await page.wait_for_selector("#snapGo", timeout=10000)
        await page.click("#snapGo", timeout=5000)
        for _ in range(100):
            await page.wait_for_timeout(100)
            acts = (await page.evaluate(FORM_NOW))["acts"]
            if len(acts) > n0:
                return acts[n0]
        return None

    async def next_snap():
        for _ in range(300):
            await page.wait_for_timeout(100)
            if await page.locator("#field.playing").count():
                await page.click("#field", timeout=2000)
            elif await page.locator("#dock .result .btn:visible").count():
                await page.locator("#dock .result .btn").first.click(timeout=2000)
            elif await page.locator("#formBtn:visible").count() and await page.locator("#dock .key.big:visible", has_text="Pass").count():
                return True
        return False
    try:
        if not await to_offense(page, base):
            return ["the formation: the first snap never came up"]
        if not await page.locator("#formBtn:visible").count():
            return ["the formation: no Formation chip beside Personnel"]
        before = await page.evaluate(FORM_NOW)
        if "as lined up" not in before["chip"]:
            out.append(f"the formation: the chip does not say as lined up at first: {before['chip']!r}")
        now = await pick("Pistol")
        if not now["form"] or now["form"].get("qb") != "pistol":
            out.append(f"the formation: Pistol picked, but the page has {now['form']!r}")
        if "Pistol" not in now["chip"]:
            out.append(f"the formation: Pistol picked, but the chip says {now['chip']!r}")
        # (the quarterback a yard nearer the line than in the shotgun, the back behind him: the same column, deeper)
        if before["qb"] and now["qb"] and now["rb"] and not (abs(now["qb"][1] - before["qb"][1]) > 2 and abs(now["rb"][0] - now["qb"][0]) < 6):
            out.append(f"the formation: Pistol picked, but the dots did not line up in it: qb {before['qb']} -> {now['qb']}, rb {now['rb']}")
        if shots:
            await page.screenshot(path=str(Path(shots) / "formation-pistol.png"))
        a = await snap_pass()
        if a is None or a["form"] != "pistol":
            out.append(f"the formation: Pistol picked, but the snap went with {a and a['form']!r}")
        if not await next_snap():
            return out + errs
        now = await pick("Empty")
        if not now["form"] or now["form"].get("qb") != "empty":
            out.append(f"the formation: Empty picked, but the page has {now['form']!r}")
        if now["qb"] and now["rb"] and not (abs(now["rb"][0] - now["qb"][0]) > 40):
            out.append(f"the formation: Empty picked, but the back is still in the backfield: qb {now['qb']}, rb {now['rb']}")
        if shots:
            await page.screenshot(path=str(Path(shots) / "formation-empty.png"))
        a = await snap_pass()
        # (an empty set is charted: the shotgun with nobody in the backfield, engine.js persForm)
        if a is None or a["form"] != "gun" or a.get("bf") != 0:
            out.append(f"the formation: Empty picked, but the snap went with {a and a['form']!r}, backs {a and a.get('bf')!r}")
        if not await next_snap():
            return out + errs
        now = await pick("Bunch")
        if not now["form"] or now["form"].get("look") != "bunch":
            out.append(f"the formation: Bunch picked, but the page has {now['form']!r}")
        if shots:
            await page.screenshot(path=str(Path(shots) / "formation-bunch.png"))
        await page.click("#formBtn", timeout=3000)
        await page.wait_for_selector("#mBody .pgroup", timeout=5000)
        await page.locator("#mBody .ghost", has_text="Back to the real lineup").first.click(timeout=3000)
        await page.wait_for_timeout(200)
        await page.click("#mBody .pdone", timeout=3000)
        await page.wait_for_timeout(400)
        now = await page.evaluate(FORM_NOW)
        if now["form"] or "as lined up" not in now["chip"]:
            out.append(f"the formation: Back to the real lineup, but the page has {now['form']!r}, the chip {now['chip']!r}")
    except Exception as e:
        out.append(f"the formation: {e}")
    finally:
        await ctx.close()
    return out + errs


async def pers_group(browser, base: str) -> list[str]:
    """Who plays, the grouping (game.js openPers, withTempo; engine.js samplePlaybook), on a phone: one receiver swapped
    for another keeps the grouping the team lined up in, and the pass snapped goes without one (its plays drawn as for
    everyone, not from just the few run with that grouping there: every snap the same loss of 2 or 3); another grouping
    picked goes with the next snap of yours."""
    out: list[str] = []
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await ctx.add_init_script(OPEN_OPTS)            # (the field's options open: Personnel, Formation)
    await ctx.add_init_script("window.__sepLog = []; try { localStorage.setItem('tmd:v3:seen', 'true'); } catch (e) {}")
    await ctx.add_init_script(WORKER_SPY)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))

    async def snap_pass():           # (a pass snapped: the call that went to the simulator)
        n0 = len((await page.evaluate(PERS_NOW))["acts"])
        await page.locator("#dock .key.big:visible", has_text="Pass").first.click(timeout=3000)
        await page.wait_for_selector("#snapGo", timeout=10000)
        await page.click("#snapGo", timeout=5000)
        for _ in range(100):
            await page.wait_for_timeout(100)
            acts = (await page.evaluate(PERS_NOW))["acts"]
            if len(acts) > n0:
                return acts[n0]
        return None
    try:
        if not await to_offense(page, base):
            return ["Who plays, the grouping: the first snap never came up"]
        await page.click("#persBtn", timeout=3000)
        await page.wait_for_selector("#mBody .pslot select", timeout=5000)
        rows = await page.evaluate(PERS_ROWS)
        i = next((k for k, r in enumerate(rows) if r["lab"] == "WR" and len(r["opts"]) > 1), None)
        if i is None:
            return ["Who plays, the grouping: no receiver to swap"]
        sel = page.locator("#mBody .pslot select").nth(i)
        other = next(v for v in await sel.evaluate("(s) => [...s.options].map((o) => o.value)") if v != rows[i]["val"])
        await sel.select_option(value=other)
        await page.wait_for_timeout(200)
        await page.click("#mBody .pdone", timeout=3000)
        await page.wait_for_timeout(400)
        now = await page.evaluate(PERS_NOW)
        if not now["who"] or not now["pers"]:
            out.append(f"Who plays, the grouping: a receiver swapped, but the page has {now['pers']!r}, {now['who']!r}")
        a = await snap_pass()
        if a is None:
            out.append("Who plays, the grouping: the pass with the receiver swapped was never snapped")
        elif a["pers"] is not None:
            out.append(f"Who plays, the grouping: one receiver swapped for another, and the snap went with grouping {a['pers']}, the one "
                       "lined up in (its plays drawn from just those run with it there)")
        # the play run, back to your next snap (the drive gone to their ball: the grouping picked is checked another time)
        for _ in range(300):
            await page.wait_for_timeout(100)
            if await page.locator("#field.playing").count():
                await page.click("#field", timeout=2000)
            elif await page.locator("#dock .result .btn:visible").count():
                await page.locator("#dock .result .btn").first.click(timeout=2000)
            elif await page.locator("#persBtn:visible").count() and await page.locator("#dock .key.big:visible", has_text="Pass").count():
                break
        else:
            return out + errs
        await page.click("#persBtn", timeout=3000)
        await page.wait_for_selector("#mBody .pgroup", timeout=5000)
        g = page.locator("#mBody .pgroup:not(.on)").first
        want = int((await g.locator("b").text_content()).strip())
        await g.click(timeout=3000)
        await page.click("#mBody .pdone", timeout=3000)
        await page.wait_for_timeout(400)
        a = await snap_pass()
        if a is None or a["pers"] != want:
            out.append(f"Who plays, the grouping: {want} picked, but the snap went with {a and a['pers']!r}")
    except Exception as e:
        out.append(f"Who plays, the grouping: {e}")
    finally:
        await ctx.close()
    return out + errs


async def scenario_lineup(browser, base: str, shots: str = "") -> list[str]:
    """The builder's lineups (game.js renderBuilder, web/scenario.js slots, code): your lineup opened, another of the
    season's quarterbacks picked; the summary card names him and the link's code carries the pick (an old code's 22
    parts, then it); kicked off, he is the one who plays (on the field, in the simulator) and the story says so."""
    out: list[str] = []
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base)
    await ctx.add_init_script("window.__sepLog = []; try { localStorage.setItem('tmd:v3:seen', 'true'); } catch (e) {}")
    await ctx.add_init_script(WORKER_SPY)
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}#custom")
        await page.wait_for_selector("#arch .sacts .btn", timeout=30000)
        await page.locator("#arch .spre .key").first.click()          # (the two-minute drill: your ball)
        await page.locator("#arch details.slu").first.locator("summary").click()
        await page.wait_for_selector("#scn-lu-you-q1", timeout=15000)
        opts = await page.evaluate("() => [...document.querySelectorAll('#scn-lu-you-q1 option')].map((o) => o.textContent)")
        labs = await page.evaluate("() => [...document.querySelectorAll('#arch details.slu')[0].querySelectorAll('.srow .sl')].map((x) => x.textContent)")
        if not labs or labs[0] != "QB" or "K" not in labs or "WR" not in labs:
            out.append(f"the lineup's rows: {labs!r}")
        if len(opts) < 2:
            return out + [f"the lineup offers one quarterback: {opts!r}"]
        want = opts[1].split(" · ")[0]
        await page.select_option("#scn-lu-you-q1", label=opts[1])
        await page.wait_for_timeout(300)
        got = await page.evaluate("""() => ({ sum: (document.querySelector('#arch .ssum') || {}).innerText || '', head: document.querySelector('#arch details.slu summary').innerText,
          errs: [...document.querySelectorAll('#arch .serr li')].map((x) => x.textContent), go: document.querySelector('#arch .sacts .btn').disabled })""")
        if f"{want} at quarterback" not in got["sum"] or "1 change" not in got["head"] or got["errs"] or got["go"]:
            out.append(f"the builder with {want} at quarterback: {got!r}")
        if shots:
            await page.locator("#arch details.slu").first.scroll_into_view_if_needed()
            await page.evaluate("() => scrollBy(0, -60)")
            await page.screenshot(path=f"{shots}/builder-lineup.png")
            await page.locator("#arch .ssum").scroll_into_view_if_needed()
            await page.screenshot(path=f"{shots}/builder-lineup-card.png")
        async with page.expect_event("load"):
            await page.locator("#arch .sacts .btn", has_text="Kick off").click()
        code = urllib.parse.unquote(page.url.split("#custom-", 1)[1]).split("~")[0]
        if not re.match(r"^1(?:-[0-9A-Za-z]{1,4}){21}-yq1[0-9a-z]{4}$", code):
            out.append(f"the scenario's code does not carry the pick: {code!r}")
        await page.wait_for_selector("#intro .btn", timeout=30000)
        story = await page.evaluate("() => document.getElementById('intro').innerText")
        if f"{want} at quarterback" not in story:
            out.append(f"the scenario's story does not name him: {story[:300]!r}")
        await page.click("#intro .btn", timeout=5000)
        for _ in range(300):
            await page.wait_for_timeout(100)
            if await page.locator(".tipskip:visible").count():
                await page.click(".tipskip", timeout=3000)
            if await page.locator("#dock .key.big:visible", has_text="Pass").count():
                break
        now = await page.evaluate(QB_NOW)
        if now["name"] != want or want not in now["dot"] or now["qb"] or not now["id"].endswith(code):
            out.append(f"kicked off with {want} at quarterback, but {now!r}")
    except Exception as e:
        out.append(f"scenario lineup: {e}")
    finally:
        out.extend(errs)
        await ctx.close()
    return out


# the phones: a tall one, the smallest in use, and the daily check's (its Pixel 7, 412x839, and iPhone 13, 390x664: the
# screen under the browser's bars); a desktop
SIZES = ((390, 844, True), (375, 667, True), (412, 839, True), (390, 664, True), (1280, 900, False))


# an ad network's bar pinned to the screen (an anchor ad: Ezoic's, Google's) never covers the calls or the scoreboard
# (game.js adFloor, --adb/--adt): a player saw one over the play buttons. Each kind the first guard missed: nested in a
# wrapper, lifted off the edge (the home bar), expanded tall, pinned to the top. Each is put on the page as the calls are
# up; the Snap key and the scoreboard must be clear of it within the guard's check (an ad arriving: at once)
AD_KINDS = {
    "nested at the bottom": "const w = document.createElement('div'); w.className = 'fakead'; const a = document.createElement('div'); a.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:52px;background:#c00;z-index:2147483000'; w.append(a); document.body.append(w); return a;",
    "lifted off the bottom": "const a = document.createElement('div'); a.className = 'fakead'; a.style.cssText = 'position:fixed;left:0;right:0;bottom:34px;height:60px;background:#c00;z-index:2147483000'; document.body.append(a); return a;",
    "expanded tall": "const a = document.createElement('div'); a.className = 'fakead'; a.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:280px;background:#c00;z-index:2147483000'; document.body.append(a); return a;",
    "at the top": "const a = document.createElement('div'); a.className = 'fakead'; a.style.cssText = 'position:fixed;left:0;right:0;top:0;height:56px;background:#c00;z-index:2147483000'; document.body.append(a); return a;",
}
AD_CLEAR = """(make) => {
  const a = new Function(make)();
  return new Promise((done) => setTimeout(() => {
    const r = a.getBoundingClientRect(), hit = (sel) => { const e = document.querySelector(sel); if (!e) return null; const q = e.getBoundingClientRect();
      return q.height > 0 && q.bottom > r.top + 0.5 && q.top < r.bottom - 0.5 ? `${sel} under it (${Math.round(q.top)}-${Math.round(q.bottom)}, the ad ${Math.round(r.top)}-${Math.round(r.bottom)})` : null; };
    const out = ['#snapGo', '#bar'].map(hit).filter(Boolean);
    document.querySelectorAll('.fakead').forEach((x) => x.remove());
    done(out);
  }, 700));
}"""


async def ad_anchor(browser, base: str) -> list[str]:
    out: list[str] = []
    for w, h in ((390, 844), (375, 667)):
        ctx = await browser.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True)
        page = await ctx.new_page()
        try:
            await page.goto(f"{base}/{PAGE}#survivor")
            for _ in range(300):
                await page.wait_for_timeout(100)
                if await page.locator("#intro .btn:visible").count():
                    await page.click("#intro .btn", timeout=3000)
                elif await page.locator("#modal:not([hidden]) #mClose").count():
                    await page.click("#mClose", timeout=3000)
                elif await page.locator("#dock .key.big:visible", has_text="Pass").count():
                    break
            else:
                out.append(f"{w}x{h}: the first call never came up")
                continue
            if await page.locator(".tipskip:visible").count():
                await page.click(".tipskip", timeout=3000)
            await page.locator("#dock .key.big:visible", has_text="Pass").first.click(timeout=3000)
            await page.wait_for_timeout(1700)
            # (no ad on the page: nothing kept clear for one, the game's own bars never taken for an ad)
            held = await page.evaluate("() => ['--adb', '--adt'].map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim())")
            if any(x not in ("", "0px") for x in held):
                out.append(f"{w}x{h}: room kept for an ad with none on the page (--adb {held[0]}, --adt {held[1]})")
            for kind, make in AD_KINDS.items():
                out.extend(f"{w}x{h}, an ad {kind}: {x}" for x in await page.evaluate(AD_CLEAR, make))
                await page.wait_for_timeout(400)
        except Exception as e:  # noqa: BLE001
            out.append(f"{w}x{h}: {str(e).splitlines()[0]}")
        finally:
            await ctx.close()
    return out


async def snap_reach(browser, base: str, sizes: tuple = SIZES) -> list[str]:
    """The snap needs no scrolling: on a phone (every size in SIZES) and a desktop, a pass's Snap key, the run keys and a
    drawn run's Run it, the defense's Call it (the full call and the three keys) and the kicks' keys are all on the screen
    as each comes up. On a phone the go keys from their first frame (REACH_WATCH: their pop), and the Snap key for every
    receiver with the longest names the rosters have, and with drawing on, its first line one line with the name whole.
    (daily_check.py: the phone it plays as, and a desktop)"""
    out: list[str] = []
    for w, h, mob in sizes:
        ctx = await browser.new_context(viewport={"width": w, "height": h}, is_mobile=mob, has_touch=mob)
        await ctx.add_init_script("window.__sepLog = [];")
        page = await ctx.new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
        at = f"{w}x{h}"

        async def watch(sel):
            if mob:
                await page.evaluate(REACH_WATCH, sel)

        async def check(screen, sel, wait=900):
            await page.wait_for_timeout(wait)          # (the keys' pop and the sheet's slide)
            if await page.locator(".tipskip:visible").count():      # (the first drive's tour: its tips are not calls)
                await page.click(".tipskip", timeout=3000)
                await page.wait_for_timeout(300)
            found = [f"{at} {screen}: {x}" for x in await page.evaluate(REACH, sel)]
            seen = await page.evaluate("() => { const W = window.__reachWatch; window.__reachWatch = null; return W; }")
            if seen and seen["worst"] > 0.5:
                found.append(f"{at} {screen}: {sel} past the screen's edge as it came up, at {seen['at']}")
            out.extend(found)
            return found

        async def tap(label):
            big = page.locator("#dock .key.big:visible")
            for i in range(await big.count()):
                if (await big.nth(i).inner_text()).upper().startswith(label):
                    await big.nth(i).click(timeout=3000)
                    return True
            return False
        try:
            await page.goto(f"{base}/{PAGE}#survivor")
            for _ in range(300):
                await page.wait_for_timeout(100)
                if await page.locator("#intro .btn:visible").count():
                    await page.click("#intro .btn", timeout=3000)
                elif await page.locator("#modal:not([hidden]) #mClose").count():
                    await page.click("#mClose", timeout=3000)
                elif await page.locator("#dock .key.big:visible", has_text="Pass").count():
                    break
            else:
                out.append(f"{at}: the first call never came up")
                continue
            await watch("#snapGo")
            if await tap("PASS"):
                await check("pass", "#snapGo")
                if mob:
                    # everything on the sheet in view with no scrolling (game.html: phones, the calls' sheet), every
                    # phone size: each receiver's row, the protection, the options, Back
                    # (the simple screen first, the default: the receivers, More, no protection or option rows; then
                    # More: every row in view too)
                    for sel in ("#snapGo", "#passMore", "#dock .ask .chip"):
                        await check("pass", sel, 300)
                    if await page.locator("#dock .prots").count():
                        out.append(f"{at}: the pass screen opened with the protection row (it is behind More)")
                    await page.click("#passMore", timeout=3000)
                    await page.wait_for_timeout(300)
                    for sel in ("#snapGo", "#dock .prots .chip", "#dock .opts-row:not(.prots) .chip", "#dock .ask .chip"):
                        await check("pass, More", sel, 300)
                    # the pass plays (game.js CONCEPTS): the picker whole on the screen with no scrolling in it, a tap sets
                    # every route (Mesh: crossers) and the Plays chip names it
                    if await page.locator("#playsBtn").count():
                        await page.click("#playsBtn", timeout=3000)
                        await page.wait_for_timeout(400)
                        fit = await page.evaluate("() => { const b = document.querySelector('#modal .box'), r = b.getBoundingClientRect(); return [b.scrollHeight - b.clientHeight, Math.round(r.top), Math.round(r.bottom), innerHeight, document.querySelectorAll('#modal .concept').length]; }")
                        if fit[0] > 1 or fit[1] < 0 or fit[2] > fit[3] or fit[4] < 9:
                            out.append(f"{at}: the pass plays picker does not fit: {fit!r}")
                        await page.click(".concept[data-concept='mesh']", timeout=3000)
                        await page.wait_for_timeout(400)
                        got = await page.evaluate(f"() => [document.getElementById('playsBtn').textContent, {ROUTES_NOW}]")
                        if "Mesh" not in got[0] or sum(1 for x in got[1] if "Crosser" in x) < 2:
                            out.append(f"{at}: Mesh picked, the dock reads {got!r}")
                        await check("pass, a concept set", "#snapGo", 300)
                        await check("pass, a concept set", "#dock .ask .chip", 300)
                        # its routes still yours to change: a tap on a man on the field picks him, a second his next
                        # route, the concept kept and marked changed (✎); the throw goes with the route as changed
                        dot = await page.evaluate("() => { const D = window.__draw, { scene } = D.get(), a = D.eligibles(scene).find((x) => !x.g.closest('.blk')); if (!a) return null; const r = a.g.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, D.eligibles(scene).indexOf(a)]; }")
                        if dot:
                            before = await page.evaluate(f"(i) => {ROUTES_NOW}[i]", dot[2])
                            for _ in range(2):
                                if await page.evaluate("(i) => window.__draw.get().ui.pass.target === i", dot[2]):
                                    break
                                xy = await page.evaluate(DOT_AT, dot[2])
                                await page.mouse.click(xy[0], xy[1])
                                await page.wait_for_timeout(400)
                            else:
                                out.append(f"{at}: a receiver tapped on the field is not the target")
                            xy = await page.evaluate(DOT_AT, dot[2])
                            await page.mouse.click(xy[0], xy[1])
                            await page.wait_for_timeout(400)
                            after = await page.evaluate(f"(i) => [{ROUTES_NOW}[i], document.getElementById('playsBtn').textContent, window.__draw.get().ui.pass.routes[i]]", dot[2])
                            if after[0] == before or "✎" not in after[1] or "Mesh" not in after[1]:
                                out.append(f"{at}: a route changed on a concept: {before!r} -> {after!r}")
                            # (he is the target now: back to the open man, the grass tapped, for the checks after)
                            grass = await page.evaluate(GRASS_AT)
                            if grass:
                                await page.mouse.click(grass[0], grass[1])
                                await page.wait_for_timeout(300)
                            elif await page.locator("#dock .rcv.on").count():
                                # (no open grass in sight: a short phone with the receivers' list open. His row tapped
                                # again is the open man too)
                                await page.locator("#dock .rcv.on").first.click(timeout=3000)
                                await page.wait_for_timeout(300)
                            if await page.evaluate("() => window.__draw.get().ui.pass.target != null"):
                                out.append(f"{at}: the grass tapped after a pick, the target is still set")
                    # max protect: the back and a tight end kept in (their rows Blocking, no route on the field for
                    # them), the open man still one who goes out; back to standard after
                    mx = page.locator("#dock .prots .chip[data-prot='max']")
                    if await mx.count():
                        await mx.click(timeout=3000)
                        await page.wait_for_timeout(300)
                        blk = await page.evaluate("() => { const D = window.__draw, { scene } = D.get(); return D.eligibles(scene).filter((a, i) => D.blocks(scene, i)).map((a) => a.label); }")
                        if not blk or any(x not in ("RB", "TE") for x in blk):
                            out.append(f"{at}: max protect kept in {blk!r}")
                        await check("pass, max protect", "#snapGo", 300)
                        await page.click("#dock .prots .chip[data-prot='std']", timeout=3000)
                        await page.wait_for_timeout(300)
                # nobody picked: the open man (the Snap key and what it says aloud); a receiver tapped on the field:
                # him; the grass tapped: the open man again
                snap_txt = "() => { const g = document.getElementById('snapGo'); return g ? [g.querySelector('.go').textContent, g.getAttribute('aria-label')] : null; }"
                st0 = await page.evaluate(snap_txt)
                if not st0 or "open man" not in st0[0] or "open man" not in st0[1]:
                    out.append(f"{at}: the Snap key does not throw to the open man before a pick: {st0!r}")
                xy0 = await page.evaluate(DOT_AT, 0)
                if xy0:
                    await page.mouse.click(xy0[0], xy0[1])
                    await page.wait_for_timeout(300)
                    st1 = await page.evaluate(snap_txt)
                    if not st1 or "open man" in st1[0]:
                        out.append(f"{at}: a receiver tapped on the field, the Snap key still reads {st1!r}")
                    grass = await page.evaluate(GRASS_AT)
                    if grass:
                        await page.mouse.click(grass[0], grass[1])
                        await page.wait_for_timeout(300)
                        st2 = await page.evaluate(snap_txt)
                        if not st2 or "open man" not in st2[0]:
                            out.append(f"{at}: the grass tapped, the Snap key is not back to the open man: {st2!r}")
                # every receiver with a long name, on the longest-named route he runs: picked (the test's hook, as a tap
                # on him would), the Snap key drawn again for him (another picked first when he already is)
                for i in range(6):
                    got = await page.evaluate(LONG, [i, LONG_NAMES[i % len(LONG_NAMES)]])
                    if not got:
                        break
                    await watch("#snapGo")
                    picked = await page.evaluate("(i) => { const D = window.__draw, { ui, scene } = D.get(), a = D.eligibles(scene)[i]; if (D.blocks(scene, i)) return false; ui.pass.target = null; return D.passTap(a); }", i)
                    if picked:
                        await check(f"pass, receiver {i + 1} (a long name)", "#snapGo", 600)
                # drawing the routes: its own hint over the receivers
                await watch("#snapGo")
                await page.click("#drawBtn", timeout=3000)
                await check("pass, drawing routes", "#snapGo", 600)
                await page.click("#drawBtn", timeout=3000)
                await page.click("#dock .ask .chip", timeout=3000)          # Back
                await page.wait_for_timeout(400)
            if await tap("RUN"):
                await check("run", "#dock .prow .key")
                if mob:
                    for sel in ("#dock .schemes .chip", "#dock .ask .chip") + (("#oobSwitch",) if await page.locator("#oobSwitch").count() else ()):
                        await check("run", sel, 200)
                sk = await page.evaluate(SKETCH)
                rb = [m for m in (sk or {}).get("men", []) if m[2] in ("RB", "FB")]
                # (four lanes 8 yards past the line, then the same lanes 4 yards past it: on a small phone the
                # longer line can run off the field the sheet leaves showing)
                for k in range(8 if rb else 0):
                    x, y = rb[0][:2]
                    ly, up, ppy = sk["los"][1], sk["up"], sk["ppy"]
                    lane, deep = k % 4, (8 if k < 4 else 4)
                    pts = [(x + (lane - 1.5) * 3 * ppy, ly), (x + (lane - 1.5) * 4 * ppy, ly + up * deep * ppy)]
                    await watch("#drawGo")
                    await page.mouse.move(x, y); await page.mouse.down()
                    for nx, ny in pts:
                        for t in range(1, 7):
                            await page.mouse.move(x + (nx - x) * t / 6, y + (ny - y) * t / 6)
                        x, y = nx, ny
                    await page.mouse.up()
                    await page.wait_for_timeout(200)
                    if await page.locator("#drawGo").count():
                        await check("drawn run", "#drawGo")
                        break
                else:
                    out.append(f"{at}: no run drawn to check its key")
            for what in ("vdef", "defense", "kick", "fgdef", "puntdef", "pat"):
                await watch("#dock .snapbar .key")
                await page.evaluate(SHOW, what)
                await check(what, "#dock .snapbar .key")
        except Exception as e:
            out.append(f"{at}: {e}")
        finally:
            out.extend(f"{at}: {x}" for x in errs)
            await ctx.close()
    return out


# the play's taps (game.js AFTER_PLAY_MS, dotTap, sheetSetup, the scoreboard's tap): the play's start and end, where the
# sheet's grip was as it started (a phone's sheet slides away from where it is then; a slow phone leaves it there a
# while), what the first tap after that landed on, and how long after the play's end the last tap was made
PLAY_TAPS = """() => {
  const W = window.__playTaps = { start: false, grip: null, ended: false, endT: 0, hit: null, after: null };
  const mo = new MutationObserver(() => {
    const on = document.getElementById('field').classList.contains('playing');
    if (on && !W.start) {
      const g = document.getElementById('grip').getBoundingClientRect();
      Object.assign(W, { start: true, grip: g.height ? [g.left + g.width / 2, g.top + g.height / 2] : null });
    }
    if (!on && W.start && !W.ended) { Object.assign(W, { ended: true, endT: performance.now() }); mo.disconnect(); }
  });
  mo.observe(document.getElementById('field'), { attributes: true, attributeFilter: ['class'] });
  addEventListener('pointerdown', (ev) => { if (W.start && !W.hit) W.hit = ev.target.closest('#grip') ? 'the grip' : ev.target.tagName; }, true);
  addEventListener('click', (ev) => { if (W.ended) W.after = ev.timeStamp - W.endT; }, true);
}"""
# a player's dot on the screen (one of theirs first; not one of your receivers, whose tap on a pass is his next route),
# clear of everything over the field and of the other dots (a tap on it is a tap on him), above where the calls' sheet
# comes back up on a phone
CLEAR_DOT = """() => {
  const why = [], rcv = /Wide receiver|Tight end|Running back/;
  for (const g of [...document.querySelectorAll('#field g.dot.them'), ...[...document.querySelectorAll('#field g.dot.me')].filter((e) => !rcv.test(e.getAttribute('aria-label') || ''))]) {
    const r = g.querySelector('circle.c').getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2, h = document.elementFromPoint(x, y);
    const d = h && h.closest('g.dot');      // (him, or him again in the field as drawn anew over it)
    // (the broadcast layout, a phone's (game.html, 999px and narrower): the dot above the calls' sheet)
    const same = d && d.getAttribute('aria-label') === g.getAttribute('aria-label'), high = y < innerHeight * 0.4 || !document.body.classList.contains('bcast') || innerWidth > 999;
    if (same && high) return { dot: [x, y], who: g.getAttribute('aria-label') };
    why.push(`${Math.round(x)},${Math.round(y)} ${same ? 'under the sheet' : h ? (h.closest('g.dot') ? 'another dot' : h.id || h.tagName) : 'off the screen'}`);
  }
  return { dot: null, why: why.length ? why.slice(0, 4).join('; ') : 'none on the field' };
}"""
# the play's end, waited on: then at once where a player's dot and the scoreboard are
AT_END = """async () => {
  while (!window.__playTaps.ended) await new Promise((r) => requestAnimationFrame(r));
  const b = document.getElementById('bar').getBoundingClientRect();
  return { dot: (CLEAR_DOT_FN)(), bar: [b.left + b.width / 2, b.top + b.height / 2], t: performance.now() };
}""".replace("CLEAR_DOT_FN", CLEAR_DOT)
# the sheet's grip back on the screen after a play (a phone): where it is, and how long after the play's end
GRIP_BACK = """async (t0) => {
  for (;;) {
    const r = document.getElementById('grip').getBoundingClientRect();
    if (r.height && r.bottom <= innerHeight) return { at: [r.left + r.width / 2, r.top + r.height / 2], after: performance.now() - t0 };
    if (performance.now() - t0 > 1500) return null;
    await new Promise((res) => requestAnimationFrame(res));
  }
}"""
OVER = """() => [!document.getElementById('modal').hidden && document.getElementById('modal').innerText.replace(/\\s+/g, ' ').slice(0, 60),
  !document.getElementById('deep').hidden && 'the ratings', !!document.querySelector('#sheet.down') && "the calls' sheet down"].filter(Boolean)"""
# the scoreboard's middle, and whether the field is under it there
BAR_AT = """() => {
  const b = document.getElementById('bar').getBoundingClientRect(), f = document.getElementById('field').getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  return { at: [x, y], over: y >= f.top && y <= f.bottom && x >= f.left && x <= f.right };
}"""


async def play_taps(browser, base: str) -> list[str]:
    """Taps meant for the play take nothing else (players tap a play to its end, often twice): on a phone a tap on the
    calls' sheet's grip as the play starts (a slow phone leaves the sheet in place a moment) does not send the sheet
    down, the next call's keys with it; a tap on the scoreboard where it sits over the field during a play (a phone's,
    a desktop page scrolled down) skips the play, and opens nothing over it; and in the moment after a play a tap on a
    player's dot, the scoreboard or the sheet's grip opens nothing and sends nothing down (the double tap's second). A
    moment later a tap on a dot opens his card, but a drag that ends on it does not; a tap on the scoreboard away from
    the field opens the game's details, play or no play. (A phone, 390x664, and a desktop.)"""
    out: list[str] = []
    for w, h, mob in ((390, 664, True), (1280, 900, False)):
        ctx = await browser.new_context(viewport={"width": w, "height": h}, is_mobile=mob, has_touch=mob)
        # (a player back for more: no welcome, no first drive's tour with its tips over the field)
        await ctx.add_init_script("""try { localStorage.setItem('tmd:v3:seen', 'true');
          localStorage.setItem('tmd:v3:tour', JSON.stringify({ seen: [], shown: [], done: true })); } catch (e) {}""")
        page = await ctx.new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
        at = f"{w}x{h}"

        async def to_call():
            # (your next pass call; their ball after a turnover: the defense's first call, their plays skipped, till
            # the ball is back; a game over: the next game)
            for _ in range(600):
                await page.wait_for_timeout(100)
                if await page.locator(".tipskip:visible").count():
                    await page.click(".tipskip", timeout=3000)
                elif await page.locator("#intro .btn:visible").count():
                    await page.click("#intro .btn", timeout=3000)
                elif await page.locator("#modal:not([hidden]) #mClose").count():
                    await page.click("#mClose", timeout=3000)
                elif await page.locator("#dock .result .btn:visible").count():
                    await page.click("#dock .result .btn", timeout=3000)
                elif await page.locator("#dock .endcard .btn:visible").count():      # (a game over: the next one)
                    await page.click("#dock .endcard .btn", timeout=3000)
                elif await page.locator("#done:not([hidden])").count():                # (the run over: a new one)
                    await page.get_by_role("button", name="New run").click(timeout=3000)
                elif await page.locator("#dock .key.big:visible", has_text="Pass").count():
                    return True
                elif await page.locator("#field.playing").count():
                    await page.click("#field", timeout=3000)
                elif await page.locator("#dock .ask .chip:visible", has_text="◀").count():
                    # (a tap on the first key while the Pass key was still popping up opened another call's sheet,
                    # Run: back to the calls, where Pass is)
                    await page.locator("#dock .ask .chip:visible", has_text="◀").first.click(timeout=3000)
                elif await page.locator("#dock .key.big:visible").count():
                    await page.locator("#dock .key.big:visible").first.click(timeout=3000)
            out.append(f"{at}: no call to make came up ({(await page.evaluate(STATE))}: "
                       + repr((await page.evaluate("() => document.getElementById('dock').innerText"))[:120]) + ")")
            return False

        async def snap(slow=False):
            await page.locator("#dock .key.big:visible", has_text="Pass").first.click(timeout=3000)
            await page.wait_for_timeout(900)
            await page.evaluate(PLAY_TAPS)
            if slow:                     # (a slow phone: the sheet in place a moment as the play starts)
                await page.evaluate("() => { document.getElementById('sheet').style.transition = 'transform 3s ease'; }")
            await page.click("#snapGo", timeout=3000)
            await page.wait_for_function("() => window.__playTaps.start", timeout=30000)

        async def ended(wait=600):
            await page.wait_for_timeout(wait)
            return await page.evaluate("() => window.__playTaps.ended")
        try:
            await page.goto(f"{base}/{PAGE}#survivor")
            if not await to_call():
                continue
            await snap(slow=mob)
            if mob:
                # a tap on the grip, where it was as the play started
                grip = await page.evaluate("() => window.__playTaps.grip")
                if grip:
                    await page.mouse.click(*grip)
                await page.evaluate("() => { document.getElementById('sheet').style.transition = ''; }")
                hit = await page.evaluate("() => window.__playTaps.hit")
                if hit != "the grip":
                    out.append(f"{at}: the tap on the sheet's grip as the play started landed on {hit} (the test's slow sheet was not there)")
                await page.wait_for_timeout(300)          # (the sheet away: the next tap is on the field)
            # tapped to its end, and at once again on what is there then: a dot, the scoreboard, the grip coming back
            box = await page.locator("#field").bounding_box()
            await page.mouse.click(box["x"] + box["width"] / 2, (max(box["y"], 0) + min(box["y"] + box["height"], h)) / 2)
            end = await page.evaluate(AT_END)
            if mob and await page.locator("#sheet.down").count():
                out.append(f"{at}: a tap on the calls' sheet's grip as the play started sent it down (the next call's keys under the screen's edge)")
            taps = [("a dot", (end["dot"] or {}).get("dot")), ("the scoreboard", end["bar"])] + ([("the sheet's grip", None)] if mob else [])
            for what, xy in taps:
                if what == "the sheet's grip":
                    back = await page.evaluate(GRIP_BACK, end["t"])
                    if not back or back["after"] > 400:       # (too late to tell: the moment after a play has gone)
                        continue
                    xy = back["at"]
                if xy is None:
                    continue
                await page.mouse.click(*xy)
                over, after = await page.evaluate(OVER), await page.evaluate("() => window.__playTaps.after")
                if over and after is not None and after < 450:
                    out.append(f"{at}: a tap on {what} {round(after)} ms after the play ended (a double tap's second) brought up {over}")
                if over or after is None or after >= 450:       # (a busy page: the moment after the play had gone)
                    break
            # at the next call (the players set, apart): his card from a tap on his dot, not from a drag that ends on it
            await page.wait_for_timeout(800)
            if await page.evaluate(OVER):
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(300)
            if not await to_call():
                continue
            await page.wait_for_timeout(600)          # (the field framed again for the sheet as it now is)
            for _ in range(6):                        # (the next call's players fading in over the last play's: a moment)
                dot = await page.evaluate(CLEAR_DOT)
                if dot["dot"]:
                    break
                await page.wait_for_timeout(400)
            if dot["dot"]:
                x, y = dot["dot"]
                await page.mouse.move(x, y); await page.mouse.down()
                for t in [*range(1, 7), *range(5, -1, -1)]:
                    await page.mouse.move(x + t * 6, y)
                await page.mouse.up()
                await page.wait_for_timeout(200)
                if await page.evaluate("() => !document.getElementById('modal').hidden"):
                    out.append(f"{at}: a drag on {dot['who']}'s dot, back to it, opened his card")
                    await page.keyboard.press("Escape")
                await page.wait_for_timeout(700)          # (a drawing's end keeps the dot under it shut a moment)
                await page.mouse.click(x, y)
                await page.wait_for_timeout(200)
                if await page.evaluate("() => document.getElementById('modal').hidden"):
                    out.append(f"{at}: a tap on {dot['who']}'s dot did not open his card")
                else:
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(300)
            else:
                out.append(f"{at}: no player's dot clear to tap at a call ({dot['why']})")
            # the scoreboard during a play: over the field it skips the play (a desktop page scrolled down, the
            # scoreboard stuck over the field's top); away from it (a desktop page at its top) it opens the details
            for scrolled in ([False] if mob else [False, True]):
                if not await to_call():
                    break
                if not mob:
                    await page.evaluate("""(down) => { scrollTo(0, 0); if (!down) return;
                      const b = document.getElementById('bar').getBoundingClientRect(), f = document.getElementById('field').getBoundingClientRect();
                      scrollBy(0, f.top - b.bottom + 60); }""", scrolled)
                    await page.wait_for_timeout(200)
                await snap()
                bar = await page.evaluate(BAR_AT)
                await page.mouse.click(*bar["at"])
                await page.wait_for_timeout(150)
                over = await page.evaluate(OVER)
                if bar["over"]:
                    if over:
                        out.append(f"{at}: a tap on the scoreboard over the field during a play brought up {over}")
                    elif not await ended():
                        out.append(f"{at}: a tap on the scoreboard over the field during a play did not skip it")
                elif not over:
                    out.append(f"{at}: a tap on the scoreboard away from the field during a play did not open the game's details")
                if over:
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(300)
        except Exception as e:
            out.append(f"{at}: {str(e).splitlines()[0][:200]}")
        finally:
            out.extend(f"{at}: {x}" for x in errs)
            await ctx.close()
    return out


def binom_tail(n: int, k: int, p: float) -> float:
    """The chance of k or more of n at rate p (in logs: a day of live episodes logs thousands of plays, too many for
    math.comb times a float)."""
    if k <= 0:
        return 1.0
    lp, lq = math.log(p), math.log1p(-p)
    return min(1.0, sum(math.exp(math.lgamma(n + 1) - math.lgamma(j + 1) - math.lgamma(n - j + 1) + j * lp + (n - j) * lq) for j in range(k, n + 1)))


SPEED_MAX = 11.5        # yd/s: the fastest NFL ball carriers top out near 23 mph (11.2 yd/s)
JUMP_MAX = 1.5          # yards between two frames (1/20 s): 30 yd/s, a teleport


def field_checks(results: list[dict]) -> tuple[list[str], dict]:
    """What the plays on the field showed over every episode's logs (seps, tackles, fps, offs): the lines to print, in
    order, and the checks that failed, each with its line (daily_check.py reports them from the live site)."""
    lines: list[str] = []
    failed: dict = {}
    say = lambda x: lines.append(x)

    def fail(name, x):
        failed[name] = x
        lines.append(x)
    inc = [x for r in results for x in r.get("seps", []) if not x.get("caught") and not x.get("intc") and x.get("kind") != "hail" and x.get("evt") != "throwaway"]
    open_inc = sum(1 for x in inc if x.get("actual", 0) >= 4)
    say(f"passes logged: {sum(len(r.get('seps', [])) for r in results)}, incomplete: {len(inc)}")
    # "Broken up" needs a defender at the ball (players saw it with nobody near)
    say(f"run it down, timeout at 0:03: tapped {sum(r.get('rundowns', 0) for r in results)} times")
    # a tackled carrier goes down with a defender on him, never alone in the open
    tk = [x for r in results for x in r.get("tackles", [])]
    alone = [x for x in tk if x.get("nd", 0) > 3]
    say(f"tackles: {len(tk)}, nobody within 3 yards: {len(alone)}")
    # (a rare one is tolerated: fail only when this many would be unlikely, p < 0.01, at a 2% rate (7 of 113, as before the fixes, fails); it was 6%
    # before the tackler fixes. A fixed cut on a short CI run fails by chance)
    n_tk = len(tk)
    tail_tk = binom_tail(n_tk, len(alone), 0.02)
    if alone and tail_tk < 0.01:
        fail("tackles", f"FAIL: tackled with nobody near {alone[:5]}")
    # a breakaway is drawn as one: a carrier never eases up in the open waiting for a tackler to arrive (game.js runDown
    # sends the man with the angle from the moment he got the ball; on a short interception return the receiver it was
    # thrown to makes the tackle). `slowed` is how long the carrier had to wait at the spot, in seconds
    waited = [x for x in tk if x.get("slowed", 0) > 0.6]
    say(f"carriers slowed for the tackler: {sum(1 for x in tk if x.get('slowed', 0) > 0)} (over 0.6 s: {len(waited)})")
    # a carrier never stands in the open: under 2 yd/s with nobody within 3 yards, before the hit (players saw a
    # receiver catch it and wait for the tackler). `stall` is how long, in seconds
    stood = [x for x in tk if x.get("stall", 0) >= 0.5]
    say(f"carriers standing in the open (0.5 s+): {len(stood)} of {len(tk)}" + (f" {sorted(stood, key=lambda x: -x['stall'])[:8]}" if stood else ""))
    # (a rare one passes, as the tackles' check above: about one play in ten thousand still has the field run out on the
    # pursuit, a beat of jog before the hit; fail only when this many would be unlikely, p < 0.01, at a 2% rate)
    if len(waited) > 1 and binom_tail(len(tk), len(waited), 0.02) < 0.01:
        fail("breakaway", f"FAIL: a carrier waited in the open for his tackler {waited[:5]}")
    # nor jogs in space: under 60% of his sprint with nobody within 5 yards for half a second, after his first step
    # (a player saw a carrier slow for no reason, then the defense swarm him; 4.8% of tackles before the fix, 2.9% after:
    # fail only when this many would be unlikely at 5%, p < 0.01). `jog` is how long, in seconds
    jogged = [x for x in tk if x.get("jog", 0) >= 0.5]
    say(f"carriers jogging in space (0.5 s+): {len(jogged)} of {len(tk)}")
    if jogged and binom_tail(len(tk), len(jogged), 0.05) < 0.01:
        fail("jogging", f"FAIL: carriers jogging in the open {sorted(jogged, key=lambda x: -x['jog'])[:5]}")
    # forward progress: a carrier never has the ball past where it is spotted (beyond where he got it), so he is
    # never shown driven back from it
    fp = [x for r in results for x in r.get("fps", [])]
    past = [x for x in fp if x.get("over", 0) > 0.5]
    say(f"carries: {len(fp)}, ball carried 0.5+ yards past the spot: {len(past)}" + (f" (worst {max(x['over'] for x in past):.1f})" if past else ""))
    if past:
        fail("forward-progress", f"FAIL: forward progress {past[:5]}")
    # every play shown on the field keeps everyone on the ground (game.js offField): inside the end lines, at most a
    # step past a sideline
    offs = [x for r in results for x in r.get("offs", [])]
    say(f"plays with a man or the ball off the field: {len(offs)}")
    if offs:
        fail("off-field", f"FAIL: off the field {offs[:5]}")
    # out of bounds on the field just when the engine has the play out of bounds (its clock stops on it late in a half):
    # the man with the ball at the whistle past the sideline, or in
    ob = [x for r in results for x in r.get("oobs", [])]
    odd = [x for x in ob if x.get("oob") != x.get("shown")]
    say(f"carries to the whistle: {len(ob)}, out of bounds {sum(1 for x in ob if x.get('oob'))} (theirs {sum(1 for x in ob if x.get('oob') and not x.get('mine'))}), "
        f"shown otherwise than played: {len(odd)}")
    if odd:
        fail("out-of-bounds", f"FAIL: out of bounds on the field but not in the play, or the other way: {odd[:5]}")
    # nobody runs faster than an NFL player on any play shown (game.js speedCheck): about 23 mph, 11.2 yards a second, at
    # the very top (a breakaway is drawn as one: the man who catches him had the angle), and nobody jumps across the
    # field between two frames
    sp = [x for r in results for x in r.get("speeds", [])]
    fast = [x for x in sp if x.get("v1", 0) > SPEED_MAX]
    jumps = [x for x in sp if x.get("jump", 0) > JUMP_MAX]
    say(f"plays timed: {len(sp)}, anyone over {SPEED_MAX} yd/s: {len(fast)} (over a fifth of a second: "
        f"{sum(1 for x in sp if x.get('v4', 0) > SPEED_MAX)}), a jump over {JUMP_MAX} yd between frames: {len(jumps)}"
        + (f"; fastest {max(x['v1'] for x in sp):.1f} yd/s" if sp else ""))
    if fast or jumps:
        fail("speed", f"FAIL: faster than an NFL player, or a jump across the field {sorted(fast + jumps, key=lambda x: -x.get('v1', 0))[:5]}")
    # the ball against the goal line and the sidelines on every play shown (game.js goalCheck): a touchdown carried or
    # caught over the goal line in bounds, before he is ever out of bounds with it; nothing else over that line with the
    # ball; out of bounds at the spot; a safety down in his own end zone
    gl = [x for r in results for x in r.get("goals", [])]
    gbad = [x for x in gl if x.get("bad")]
    say(f"plays against the goal line: {len(gl)}, touchdowns {sum(1 for x in gl if x.get('td') or x.get('tdDef'))} (crossing in bounds: "
        f"{sum(1 for x in gl if (x.get('td') or x.get('tdDef')) and (x.get('cross') or {}).get('inb'))}), safeties {sum(1 for x in gl if x.get('safety'))}, "
        f"not as they went: {len(gbad)}")
    if gbad:
        fail("goal-line", f"FAIL: the ball against the goal line or the sideline not as the play went {gbad[:5]}")
    # the tackler in the camera's frame from the moment he goes for the carrier (game.js finishCamera: a runner in the
    # open field was stopped by a man off the screen). `before`: the share of his way in the old frame left out
    cm = [x for r in results for x in r.get("cams", [])]
    cm_out = [x for x in cm if x.get("after", 0) > 0.02]
    say(f"tackles framed: {len(cm)}, the tackler off the screen on his way in: {len(cm_out)} (the old frame: "
        f"{sum(1 for x in cm if x.get('before', 0) > 0.02)})")
    if cm_out:
        fail("tackler-framed", f"FAIL: the tackler off the screen on his way in {cm_out[:5]}")
    # nobody goes by the man with the ball within arm's reach and lets him go (game.js passCheck): only the tackler and
    # the broken tackle's man get to him (players saw defenders run right by a back)
    pb = [x for r in results for x in r.get("passes", [])]
    say(f"defenders by the man with the ball within a yard, no tackle: {len(pb)} in {len(gl)} plays" + (f" {pb[:6]}" if pb else ""))
    # the passer after the throw: a man on him (within a yard) for 0.4 s or more reads as a sack that never came (the
    # owner saw it, Oct 22); never on a pass that was not a sack (game.js qbCheck)
    qb = [x for r in results for x in r.get("qbs", [])]
    qb_on = [x for x in qb if x.get("on", 0) >= 0.4]
    say(f"passes thrown: {len(qb)}, a defender on the passer 0.4 s+ after the throw: {len(qb_on)} (pressured {sum(1 for x in qb if x.get('press'))})" + (f" {qb_on[:5]}" if qb_on else ""))
    if qb_on:
        fail("qb-after-throw", f"FAIL: a defender on the passer after the throw (it looks like a sack) {qb_on[:5]}")
    tos = {}
    for r in results:
        for k, v in ((r.get("friction") or {}).get("timeouts") or {}).items():
            tos[k] = tos.get(k, 0) + v
    say(f"the timeout checked where it is offered (the clock running, time wanted): {tos or 'none came up'}")
    # a short throw with a man running free deep reads as a QB who missed him (players saw it): report how often
    sh = [x for r in results for x in r.get("seps", []) if x.get("caught") and x.get("air", 99) <= 6]
    say(f"short completions: {len(sh)}, with a deep man 5+ yards clear: {sum(1 for x in sh if x.get('openDeep', 0) > 0)}")
    say(f"routes drawn: {sum(r.get('drawn', 0) for r in results)} drags, {sum(r.get('kept', 0) for r in results)} kept as routes (since the last reload)")
    by = {}
    for r in results:
        for x in r.get("snaps", []):
            by[x["kind"]] = by.get(x["kind"], 0) + 1
    say(f"plays drawn: {sum(r.get('sketched', 0) for r in results)} drags (runs, RPOs, defense, kicks), snapped as drawn: {by} (since the last reload)")
    late = sum(1 for r in results for x in r.get("seps", []) if x.get("late"))
    say(f"cover man too far to break it up (shown as a bad ball instead): {late} of {len(inc)} incompletions")
    # the pass looks like what happened, on every real pass of the run (pass_look_problems): a catch in his hands, a
    # miss gone where its kind says and never into his hands
    # a clean catch (charted uncontested) is not made in "triple coverage": three or more men in reach of him as the ball
    # gets there (players saw it; 5.4% of such catches before the fix, 3.4% after: fail only when this many would be
    # unlikely at 6%, p < 0.01)
    cl = [x for r in results for x in r.get("seps", []) if x.get("caught") and not x.get("intc") and "x" not in (x.get("data") or "")]
    crowded = [x for x in cl if x.get("crowd", 0) >= 3]
    say(f"clean catches with 3+ men on the receiver: {len(crowded)} of {len(cl)}")
    if crowded and binom_tail(len(cl), len(crowded), 0.06) < 0.01:
        fail("crowded", f"FAIL: clean catches made in a crowd {crowded[:4]}")
    allseps = [x for r in results for x in r.get("seps", [])]
    kinds = {}
    for x in allseps:
        kinds[x.get("label") or x.get("miss") or "?"] = kinds.get(x.get("label") or x.get("miss") or "?", 0) + 1
    looks = pass_look_problems(allseps)
    # "Broken up" (or "Almost picked!") with no defender within a step and a half of him at the catch point: a ball knocked
    # away from a man in the open (players saw it)
    open_bu = [x for x in allseps if x.get("miss") in ("break", "pick") and x.get("defNear", 99) > 1.5]
    say(f"broken up or nearly picked: {sum(1 for x in allseps if x.get('miss') in ('break', 'pick'))}, with no defender within 1.5 yards of him at the catch: {len(open_bu)}")
    say(f"passes as drawn: {dict(sorted(kinds.items(), key=lambda kv: -kv[1]))}; not as they went: {len(looks)}")
    offt = [x for x in allseps if x.get("bad")]
    say(f"off-target balls: {len(offt)}, charted pressure {sum(1 for x in offt if x.get('press'))}, to a man 3+ yd clear from a clean pocket: "
        f"{sum(1 for x in offt if x.get('actual', 0) > 3 and x.get('pressD', 0) > 3)}")
    if looks:
        fail("pass-look", f"FAIL: a pass not drawn as it went {looks[:5]}")
    lonely = [x for r in results for x in r.get("seps", []) if x.get("label") == "Broken up" and x.get("ballD", 0) > 3]
    if lonely:
        fail("broken-up", f"FAIL: {len(lonely)} passes called 'Broken up' with no defender within 3 yards of the ball")
    if len(inc) >= 8:
        n = len(inc)
        tail = binom_tail(n, open_inc, 0.10)
        say(f"incomplete passes with nobody within 4 yards: {open_inc} of {n} (chance of this many at 10%: {tail:.4f})")
        if tail < 0.001:
            fail("separation", "FAIL: too many incompletions look wide open")
    return lines, failed


# survivor's record in this browser (game.js survStats: the runs, the best, whether the best used the extra life), the
# run under way (its wins), and the home card's survivor number ("4 wins, your best run", "– no runs yet")
SURV_REC = "() => JSON.parse(localStorage.getItem('tmd:v3:survstats') || 'null')"
SURV_RUN = "() => { const s = JSON.parse(localStorage.getItem('tmd:v3:surv') || 'null'); return s ? { won: s.won, out: !!s.out, games: s.games.length } : null; }"
SURV_CARD = "() => { const n = document.querySelector('#homeview a.hcard.hsurv .hnum'); return n ? [...n.children].map((c) => c.textContent).join(' ') : null; }"


async def survivor_play(page, rnd, limit_s: int = 600) -> str:
    """A survivor run by random calls (the episodes' way, shorter) to its end: the run-over card's verdict line."""
    t0, last, since = time.time(), None, time.time()
    while time.time() - t0 < limit_s:
        try:
            st = await page.evaluate(STATE)
        except Exception:                # (the page reloading itself)
            st = "loading"
        if st != last:
            last, since = st, time.time()
        elif time.time() - since > LIMIT.get(st, STILL) + 30:
            raise RuntimeError(f"frozen: the '{st}' screen did not change for {int(time.time() - since)} s")
        try:
            if st in ("errbar", "error"):
                raise RuntimeError(st + ": " + await page.evaluate("() => (document.getElementById('errBar') || document.getElementById('dock')).innerText.slice(0, 300)"))
            if st == "summary":
                return await page.evaluate("() => (document.querySelector('#done .verdict') || {}).textContent || ''")
            if st in ("modal", "deep"):
                await page.click("#mClose" if st == "modal" else "#deepClose", timeout=3000)
            elif st == "intro":
                await page.click("#intro .btn", timeout=3000)
            elif st == "animating":
                await page.click("#field", timeout=1500)
            elif st == "result":
                await page.click("#dock .result .btn", timeout=3000)
            elif st == "end":
                await page.click("#dock .endcard .btn", timeout=3000)
            elif st == "choose":
                big = page.locator("#dock .key.big:visible")
                n = await big.count()
                if n:
                    await big.nth(rnd.randrange(n)).click(timeout=3000)
                else:
                    btns = page.locator("#dock button:visible:not([disabled])")
                    if await btns.count():
                        await btns.nth(rnd.randrange(await btns.count())).click(timeout=3000)
            else:
                await page.wait_for_timeout(100)
        except RuntimeError:
            raise
        except Exception:                # (a key gone between the look and the tap: look again)
            await page.wait_for_timeout(100)
    raise RuntimeError("the run did not end in time")


async def survivor_best(browser, base: str, seed: int = 3) -> list[str]:
    """Signed in, survivor's best run follows the account (board/worker.js /auth/stats surv; game.js statsSync,
    statsTake): the account's record (a best of 4 from another phone) is on the home card, the stats modal and the
    survivor label of a phone with nothing saved, before any run here; a run played here goes to the account with the
    best of both kept, never down (a run of fewer wins leaves the best at 4; more wins raise it); the run-over card
    says which; a fresh phone signed in gets it all back. (A player signed in lost his best on every other phone
    before: it lived in one browser's storage only, and the sync left it out.)"""
    out: list[str] = []
    ACCT["stats"] = {"days": {}, "drives": {}, "runs": {}, "badges": {}, "frozen": {}, "scen": {}, "surv": {"best": 4, "runs": 2}}
    rnd = random.Random(seed)

    async def signed_in(k: int):
        ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        await pro_context(ctx, base, pro=False, comm=True)
        await ctx.add_init_script(f"""(() => {{ let s = {seed * 7 + k} >>> 0; Math.random = () => {{ s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }}; }})();""")
        page = await ctx.new_page()
        page.on("pageerror", lambda e: out.append(f"script error: {e}"))
        return ctx, page

    async def shown(page, js: str, want: str, where: str, what: str):
        """What the page shows once the account's record is in (the sync lands after the page is up)."""
        got = None
        for _ in range(100):
            got = await look(page, js)
            if got and want in got:
                return
            await page.wait_for_timeout(100)
        out.append(f"{where}: {what} says {got!r}, not {want!r}")

    async def home(page, want: str, where: str):
        await page.goto(f"{base}/{PAGE}")
        await shown(page, SURV_CARD, want, where, "the home card")
        await page.click("#statsBtn", timeout=3000)
        await page.wait_for_timeout(300)
        t = await page.evaluate("() => document.getElementById('modal').innerText")
        if f"Survivor: best run {want}" not in t:
            line = re.search(r"Survivor:[^\n]*", t)
            out.append(f"{where}: the stats modal says {line.group(0) if line else 'nothing of survivor'!r}, not {want!r}")
        await page.click("#mClose", timeout=3000)

    label = "() => document.getElementById('dayLabel').textContent"
    ctx, page = await signed_in(1)
    best = 4
    try:
        await home(page, "4 wins", "a phone with nothing saved, signed in")
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#survivor")
        await shown(page, label, "best 4", "that phone, in survivor", "the label")
        verdict = await survivor_play(page, rnd)
        run = await page.evaluate(SURV_RUN)
        won = run["won"] if run else 0
        best = max(4, won)
        rec = await page.evaluate(SURV_REC) or {}
        if rec.get("best") != best or rec.get("runs") != 3:
            out.append(f"after a run of {won} wins the record is {rec}, not best {best} of 3 runs")
        want = "Your best run yet." if won >= 4 else "Your best run: 4 wins."
        if verdict != want:
            out.append(f"the run-over card after {won} wins says {verdict!r}, not {want!r}")
        for _ in range(50):              # the finish goes to the account
            if (ACCT["stats"]["surv"] or {}).get("runs") == 3:
                break
            await page.wait_for_timeout(100)
        if ACCT["stats"]["surv"] != {"best": best, "runs": 3}:
            out.append(f"the account's record after a run of {won} wins: {ACCT['stats']['surv']}, not best {best} of 3 runs")
        await page.reload()
        await shown(page, label, f"best {best}", "the run-over card reloaded", "the label")
        await page.get_by_role("button", name="New run").click(timeout=3000)
        await shown(page, label, f"0 wins · best {best}", "a new run", "the label")
        await home(page, f"{best} wins", "the same phone, back home")
        print(f"survivor best: a run of {won} wins on the first phone; the account's best {best} of 3 runs", flush=True)
    except Exception as e:
        out.append(f"survivor best, the first phone: {str(e).splitlines()[0][:200]}")
    finally:
        await ctx.close()
    ctx, page = await signed_in(2)
    try:
        await home(page, f"{best} wins", "a fresh phone, signed in")
        async with page.expect_event("load"):
            await page.goto(f"{base}/{PAGE}#survivor")
        await shown(page, label, f"0 wins · best {best}", "a fresh phone, in survivor", "the label")
    except Exception as e:
        out.append(f"survivor best, a fresh phone: {str(e).splitlines()[0][:200]}")
    finally:
        await ctx.close()
    ACCT["stats"] = None
    return out


# the first call's situation (game.js crowdKey) for the call and the tempo before it, and every call there is
CROWD_KEYS = """() => { const D = window.__draw, { G } = D.get(); return { keys: ['call', 'clock', 'defcall', 'deftime'].map((k) => D.crowdKey(G.root, k)), calls: Object.keys(D.CALL), decs: G.decisions.map((x) => x.ck || '') }; }"""


async def social(browser, base: str, day: int, shots: str = "") -> list[str]:
    """Challenges, the crowd's calls and fanbases against the stub (board/worker.js /challenge*, /calls, /fans):
    a challenge link to today's drive opens it with the score to beat on the intro; a call made where the stub says 40
    players were shows its share on the result card; the end card posts the result to the challenge and shows its
    board (the challenger, you), the drive's Uniqueness in the breakdown, Challenge a friend (a challenge made, its link
    in the share text) and the one ask for your team, whose pick posts the day again with the team; the Fanbases view
    ranks the stub's fanbases and calls out the day's own team's fans; a past day's link without Pro is its pitch.
    shots: a folder for 390x844 screenshots."""
    out: list[str] = []
    SOCIAL.update(chal={"frnd234": {"day": day, "name": "Eli", "score": 87, "rows": [{"name": "Matt", "score": 64}]},
                        "past234": {"day": max(1, day - 1), "name": "Eli", "score": 71, "rows": []}},
                  made=[], plays=[], daily=[], calls={},
                  fans={"date": "", "min": 5, "day": [{"team": "DAL", "n": 12, "avg": 71.5}, {"team": "NYG", "n": 9, "avg": 64, "own": {"n": 6, "avg": 66}},
                                                      {"team": "PHI", "n": 5, "avg": 58}], "week": {"from": "", "to": "", "rows": [{"team": "PHI", "n": 40, "avg": 61}]}})
    rnd = random.Random(11)
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base, pro=False)
    await ctx.add_init_script("""window.__sepLog = []; try { localStorage.setItem('tmd:v3:seen', 'true');
      localStorage.setItem('tmd:v3:tour', JSON.stringify({ seen: [], shown: [], done: true })); localStorage.setItem('tmd:v3:name', JSON.stringify('Tess')); } catch (e) {}
      new MutationObserver(() => { const c = !window.__crowd && document.querySelector('#dock .crowd'); if (c) window.__crowd = c.textContent; })
        .observe(document, { subtree: true, childList: true });""")
    page = await ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}?c=frnd234")
        await page.wait_for_selector("#intro .who.chal", timeout=30000)
        t = await page.evaluate("() => document.querySelector('#intro .who.chal').textContent")
        if "Eli scored 87 on today’s drive — beat that" not in t:
            out.append(f"the challenge's intro says {t!r}")
        if "c=" in page.url:
            out.append(f"the challenge's id left in the address: {page.url}")
        if shots:
            await page.screenshot(path=f"{shots}/challenge-intro.png")
        crowd, keyed, t0, last, since, decs_seen = "", False, time.time(), None, time.time(), []
        while time.time() - t0 < 600:
            try:
                st = await page.evaluate(STATE)
            except Exception:
                st = "loading"
            if st != last:
                last, since = st, time.time()
            elif time.time() - since > LIMIT.get(st, STILL) + 30:
                raise RuntimeError(f"frozen: the '{st}' screen did not change for {int(time.time() - since)} s")
            if not crowd:                # (the first rarity line on a result card: the page's observer keeps it)
                crowd = await page.evaluate("() => window.__crowd || ''")
            if st == "summary":
                break
            try:
                if st in ("errbar", "error"):
                    raise RuntimeError(st)
                if st in ("modal", "deep"):
                    await page.click("#mClose" if st == "modal" else "#deepClose", timeout=3000)
                elif st == "pick":
                    await page.click("#intro .sidepick[data-side='0']", timeout=3000)
                elif st == "intro":
                    if not keyed:                # (the first call's spot: the stub's counts say 74 players made calls there)
                        k = await page.evaluate(CROWD_KEYS)
                        SOCIAL["calls"] = {key: {"n": 2 * len(k["calls"]) + 20, "c": {**{c: 2 for c in k["calls"]}, "nohuddle": 20, "huddle": 0}} for key in k["keys"]}
                        keyed = True
                    await page.click("#intro .btn", timeout=3000)
                elif st == "animating":
                    await page.click("#field", timeout=1500)
                elif st == "result":
                    await page.click("#dock .result .btn", timeout=3000)
                elif st == "end":
                    await page.click("#dock .endcard .btn", timeout=3000)
                elif st == "choose":
                    if keyed and not crowd and len(decs_seen) < 3:
                        # (a player who reads the result card: the counts land on it a moment after the grade; a bot
                        # tapping on at once has moved on by then)
                        try:
                            await page.wait_for_function("() => window.__crowd || !window.__draw.get().G.decisions.length", timeout=3000)
                        except PWTimeout:
                            pass
                        crowd = await page.evaluate("() => window.__crowd || ''")
                        decs_seen.append((await page.evaluate(CROWD_KEYS))["decs"])
                    big = page.locator("#dock .key.big:visible")
                    n = await big.count()
                    if n:
                        await big.nth(rnd.randrange(n)).click(timeout=3000)
                    else:
                        btns = page.locator("#dock button:visible:not([disabled])")
                        if await btns.count():
                            await btns.nth(rnd.randrange(await btns.count())).click(timeout=3000)
                else:
                    await page.wait_for_timeout(100)
            except RuntimeError:
                raise
            except Exception:
                await page.wait_for_timeout(100)
        else:
            raise RuntimeError("the drive did not end in time")
        if not re.search(r"^👥 (\d+|<1)% of today’s \d+ players here called .+|^👥 None of today’s \d+ players here called .+", crowd):
            out.append(f"no rarity line on the first call's result card: {crowd!r} (the stub's {sorted(SOCIAL['calls'])}, the calls' {decs_seen})")
        await page.wait_for_selector("#done .chslot:not([hidden]) .chboard", timeout=15000)
        got = await page.evaluate("""() => ({ board: document.querySelector('#done .chslot').innerText,
          crowd: (document.querySelector('#done .endmore .crowdsum') || {}).textContent || '', ask: !!document.querySelector('#done .fanask select'),
          chb: !!document.querySelector('#done > .chbtn'), share: (document.querySelector('#done .grid-share') || {}).textContent || '' })""")
        if "Eli" not in got["board"] or "Tess (you)" not in got["board"] or "Matt" not in got["board"] or "you vs eli" not in got["board"].lower():
            out.append(f"the challenge's board on the end card: {got['board']!r}")
        if len(SOCIAL["plays"]) != 1 or SOCIAL["plays"][0].get("id") != "frnd234" or SOCIAL["plays"][0].get("name") != "Tess":
            out.append(f"the result posted to the challenge: {SOCIAL['plays']!r}")
        if not re.match(r"^👥 Uniqueness \d+ · ", got["crowd"]):
            out.append(f"the breakdown's Uniqueness: {got['crowd']!r}")
        if not got["ask"] or not got["chb"]:
            out.append(f"the end card without the team's ask ({got['ask']}) or Challenge a friend ({got['chb']})")
        for _ in range(50):
            if SOCIAL["made"] and "?c=made" in await page.evaluate("() => (document.querySelector('#done .grid-share') || {}).textContent || ''"):
                break
            await page.wait_for_timeout(100)
        else:
            out.append(f"no challenge made, or its link not in the share text: {SOCIAL['made']!r}")
        if not SOCIAL["daily"] or not any(isinstance(b.get("calls"), list) and b["calls"] for b in SOCIAL["daily"]):
            out.append(f"the /daily post carries no calls: {SOCIAL['daily'][:1]!r}")
        if BAD_TEXT.search(await page.evaluate("() => document.getElementById('done').innerText")):
            out.append("broken text on the end card")
        if shots:
            await page.evaluate("() => scrollTo(0, 0)")
            await page.screenshot(path=f"{shots}/endcard.png")
            await page.screenshot(path=f"{shots}/endcard-full.png", full_page=True)
        n0 = len(SOCIAL["daily"])
        await page.select_option("#done .fanask select", "DAL")
        for _ in range(50):
            if len(SOCIAL["daily"]) > n0:
                break
            await page.wait_for_timeout(100)
        if not (len(SOCIAL["daily"]) > n0 and SOCIAL["daily"][-1].get("team") == "DAL"):
            out.append(f"a team picked on the end card was not posted: {SOCIAL['daily'][n0:]!r}")
        await page.locator("#done .fanask .fanlink").click(timeout=3000)
        await page.wait_for_selector("#mBody #fans .brows li", timeout=10000)
        t = await page.evaluate("() => document.getElementById('fans').innerText")
        if not ("Dallas" in t and "New York (NFC)" in t and "Philadelphia" in t) or "Cowboys" in t or "Giants" in t:
            out.append(f"the Fanbases view: {t[:300]!r}")
        if "on their own team’s drive" not in t:
            out.append(f"the Fanbases view does not call out the day's own team's fans: {t[:300]!r}")
        if BAD_TEXT.search(t):
            out.append("broken text on the Fanbases view")
        if shots:                        # (the view as Your stats shows it, from Home: a screenshot over the end card's
            # layers comes out see-through in headless Chromium, though the sheet is on top)
            async with page.expect_event("load"):
                await page.goto(f"{base}/{PAGE}#home")
            await page.click("#statsBtn", timeout=10000)
            await page.wait_for_selector("#mBody #fans .brows li", timeout=10000)
            await page.wait_for_timeout(600)
            await page.evaluate("() => { const b = document.querySelector('#modal .box'), f = document.getElementById('fans'); b.scrollTop += f.getBoundingClientRect().top - b.getBoundingClientRect().top - 12; }")
            await page.wait_for_timeout(200)
            await page.screenshot(path=f"{shots}/fanbases.png")
    except Exception as e:
        out.append(f"social: {str(e).splitlines()[0][:200]}")
    finally:
        await ctx.close()
    # a past day's challenge without Pro: the challenger's result and the pitch, never the game
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    await pro_context(ctx, base, pro=False)
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
    try:
        await page.goto(f"{base}/{PAGE}?c=past234")
        await page.wait_for_selector("#arch .chlead", timeout=30000)
        got = await page.evaluate("() => ({ t: document.getElementById('arch').innerText, pro: !!document.querySelector('#arch .pro .btn'), play: !document.getElementById('play').hidden || !document.getElementById('intro').hidden })")
        if "Eli scored 71" not in got["t"] or not got["pro"] or got["play"]:
            out.append(f"a past day's challenge without Pro: {got['t'][:200]!r}")
        if shots:
            await page.screenshot(path=f"{shots}/challenge-past.png")
    except Exception as e:
        out.append(f"social, a past day: {str(e).splitlines()[0][:200]}")
    finally:
        out.extend(errs)
        await ctx.close()
    SOCIAL["fans"] = None
    return out


async def main(a) -> int:
    srv, port = serve(Path(a.site).resolve())
    stamped = stamps_of(Path(a.site))
    p0 = Path(a.site) / "spots" / "p0.json"
    first = p0.exists() and '"first":' in p0.read_text()
    base = f"http://127.0.0.1:{port}"
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    jobs = [("daily", a.seed + (i * a.day_step), 1) for i in range(a.daily)] + [("survivor", a.seed + 1000 + i, a.games) for i in range(a.survivor)] \
        + [("scenario", a.seed + 2000 + i, 1) for i in range(a.scenario)]
    sem = asyncio.Semaphore(a.jobs)
    async with async_playwright() as p:
        kw = {"executable_path": a.chromium} if a.chromium else {}
        browser = await p.chromium.launch(**kw)
        # every page on the full-screen field (game.js fullField: a phone's broadcast view, which the phone checks below
        # are written for), but for the episodes asked as classic: a phone's default view since Oct 24
        new_context = browser.new_context

        async def full_context(*args, classic=False, **kwargs):
            ctx = await new_context(*args, **kwargs)
            if not classic:
                await ctx.add_init_script("try { if (localStorage.getItem('tmd:v3:fullfield') == null) localStorage.setItem('tmd:v3:fullfield', 'true'); } catch (e) {}")
            return ctx
        browser.new_context = full_context
        browser.full_field = True
        reach = await snap_reach(browser, base)
        print("snap in reach (pass, every receiver with a long name, drawing on; run, defense, kicks at " + ", ".join(f"{w}x{h}" for w, h, _ in SIZES)
              + "; the go keys from their first frame on a phone): " + ("ok" if not reach else "FAIL")
              + "".join(f"\n      {x}" for x in reach), flush=True)
        ads = await ad_anchor(browser, base)
        print("an ad pinned to the screen (nested, lifted off the bottom, expanded tall, at the top) never over the Snap key or the scoreboard: "
              + ("ok" if not ads else "FAIL") + "".join(f"\n      {x}" for x in ads), flush=True)
        reach += ads
        taps = await play_taps(browser, base)
        print("taps meant for the play (the sheet as it starts, the scoreboard during it, a double tap's second, a drag on a dot): "
              + ("ok" if not taps else "FAIL") + "".join(f"\n      {x}" for x in taps), flush=True)
        reach += taps
        qb = await qb_swap(browser, base, a.shots)
        print("Who plays, the quarterback (the sheet's first row, a backup put in plays and is graded on his simulator, back to the real lineup): "
              + ("ok" if not qb else "FAIL") + "".join(f"\n      {x}" for x in qb), flush=True)
        reach += qb
        fp = await formation_pick(browser, base, a.shots)
        print("the formation (the chip beside Personnel, Pistol lines up and snaps as pistol, Empty snaps as an empty set, a look, back to the real lineup): "
              + ("ok" if not fp else "FAIL") + "".join(f"\n      {x}" for x in fp), flush=True)
        reach += fp
        pg = await pers_group(browser, base)
        print("Who plays, the grouping (a receiver swapped: the snap goes without one, the grouping lined up in; another picked goes with it): "
              + ("ok" if not pg else "FAIL") + "".join(f"\n      {x}" for x in pg), flush=True)
        reach += pg
        sb = await survivor_best(browser, base)
        print("survivor's best run follows the account (another phone's best on a phone with nothing saved, a run played here kept on the account, a fresh phone signed in): "
              + ("ok" if not sb else "FAIL") + "".join(f"\n      {x}" for x in sb), flush=True)
        reach += sb
        launch = json.loads((Path(a.site) / "game.json").read_text())["launch"]
        import datetime as _dt
        so = await social(browser, base, (_dt.date.today() - _dt.date.fromisoformat(launch)).days + 1, a.shots)
        print("challenges, the crowd's calls, fanbases (a challenge link's intro and board, a call's share, Uniqueness, Challenge a friend, your team, the Fanbases view, a past day's pitch): "
              + ("ok" if not so else "FAIL") + "".join(f"\n      {x}" for x in so), flush=True)
        reach += so
        if a.scenario:
            pitch = await scenario_pitch(browser, base)
            print("a scenario's link without Pro (the pitch, the scenario's summary), a bad link: " + ("ok" if not pitch else "FAIL")
                  + "".join(f"\n      {x}" for x in pitch), flush=True)
            reach += pitch
            comm = await scenario_community(browser, base, a.shots)
            print("community scenarios (a title, Post to Community, the list, a tap: the pitch or the game, the play counted): " + ("ok" if not comm else "FAIL")
                  + "".join(f"\n      {x}" for x in comm), flush=True)
            reach += comm
            lu = await scenario_lineup(browser, base, a.shots)
            print("a scenario's lineup (the builder's Lineups, the pick in the code, the quarterback picked plays): " + ("ok" if not lu else "FAIL")
                  + "".join(f"\n      {x}" for x in lu), flush=True)
            reach += lu
            half = await scenario_half(browser, base)
            print("a first half played to the final gun (the halftime card, the third quarter's kickoff): " + ("ok" if not half else "FAIL")
                  + "".join(f"\n      {x}" for x in half), flush=True)
            reach += half

        async def run(i, job):
            mode, seed, target = job
            async with sem:
                quirk = ("", "", "nopack", "", "nostore")[i % 5]
                if mode == "scenario" and quirk == "nostore":       # (Pro is a code in storage)
                    quirk = ""
                r = await episode(browser, base, f"{mode}-{seed}" + (f"-{quirk}" if quirk else ""), mode, seed, target, out,
                                  mobile=i % 3 != 2, quirk=quirk, stamped=stamped, first=first, sweep=i == 0)
            print(f"{r['status']:5s} {r['name']:24s} games {r['finished']}  reloads {r['reloads']}  {r['secs']} s"
                  + "".join(f"\n      {x}" for x in r["problems"]) + "".join(f"\n        {x}" for x in r["trail"]), flush=True)
            return r
        results = await asyncio.gather(*(run(i, j) for i, j in enumerate(jobs)))
        await browser.close()
    srv.shutdown()
    bad = [r for r in results if r["status"] != "ok"] + ([{"name": "snap-reach"}] if reach else [])
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
        (out / "speeds.json").write_text(_json.dumps([x for r in results for x in r.get("speeds", [])]))
    except Exception:
        pass
    lines, failed = field_checks(results)
    print("\n".join(lines))
    bad += [{"name": k} for k in failed]
    if STUB_ASKED:
        print(f"the Pro stub was also asked: {sorted(STUB_ASKED)}")
    print(f"{len(results) - len(bad)} of {len(results)} episodes clean" + (f"; screenshots in {out}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--daily", type=int, default=6, help="daily episodes (each a different day)")
    ap.add_argument("--survivor", type=int, default=4, help="survivor episodes")
    ap.add_argument("--games", type=int, default=3, help="games per survivor episode")
    ap.add_argument("--scenario", type=int, default=0, help="Pro scenario episodes (game.js #custom: the builder, then a random scenario played out)")
    ap.add_argument("--shots", default="", help="a folder for the community test's 390x844 screenshots")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--day-step", type=int, default=1, help="seed step between daily episodes (9: the same day each time)")
    ap.add_argument("--jobs", type=int, default=3, help="episodes at once")
    ap.add_argument("--chromium", help="path to a Chromium binary (default: Playwright's)")
    ap.add_argument("--out", default="browser_test_out")
    sys.exit(asyncio.run(main(ap.parse_args())))
