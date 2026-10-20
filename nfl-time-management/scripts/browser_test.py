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
miss where its kind says and never in them; every real pass of the run too), then thousands of drawn runs, RPOs,
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
# The pass looks like what happened (game.js missPlan, passCheck): pass plays of every kind of result, on spots from the
# goal line to backed up, both teams, every pass call and charted route, drawn on the field and measured as drawn: a
# catch (or a pick) is in the catcher's hands as the ball gets to him and just after; an incompletion never is, and
# goes where its kind says (pass_look_problems)
PASS_LOOK = """([n, seed]) => {
  const D = window.__draw, { G } = D.get(), calls = Object.values(D.CALL);
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(R() * a.length)];
  const logs = ['__sepLog', '__tackleLog', '__fpLog', '__offLog'], kept = logs.map((k) => (window[k] || []).length);
  const ids = ['quick_strong', 'quick_weak', 'quick_middle', 'screen', 'deep_strong', 'deep_weak', 'deep_middle', 'pa_short', 'pa_deep', 'roll_strong', 'roll_weak'];
  const routes = ['go', 'post', 'corner', 'out', 'deep_out', 'in', 'slant', 'cross', 'hitch', 'screen', 'flat', 'wheel', 'angle'];
  const kinds = ['catch', 'catch', 'int', 'bad', 'bad', 'bad', 'break', 'break', 'tip', 'drop', 'pick', 'away', 'plain'];
  const rows = [], off = [];
  for (let i = 0; i < n; i++) {
    const id = pick(ids), ci = calls.findIndex((c) => c.id === id), yl = pick([3, 8, 15, 25, 40, 55, 70, 85, 95, 99]);
    const deep = /deep/.test(id), air = Math.round(Math.max(-3, Math.min(yl + 8, deep ? 14 + R() * 32 : -3 + R() * 15)));
    const k = pick(kinds), ch = (c, x, d) => ({ catchable: c, contested: x, defended: d });
    const yards = Math.min(yl, Math.max(air, air + Math.floor(R() * 9)));
    const o = { catch: { air, yards, td: yards >= yl, ...ch(true, R() < 0.2, false) }, int: { air, yards: 0, evt: 'interception', turnover: true },
      bad: { air, yards: 0, incomplete: true, ...ch(false, R() < 0.25, false) }, break: { air, yards: 0, incomplete: true, ...ch(R() < 0.3, R() < 0.6, true) },
      tip: { air, yards: 0, incomplete: true, ...ch(true, false, false) }, drop: { air, yards: 0, incomplete: true, evt: 'drop', ...ch(true, R() < 0.2, false) },
      pick: { air, yards: 0, incomplete: true, evt: 'near_pick', ...ch(false, true, true) }, away: { yards: 0, incomplete: true, evt: 'throwaway' },
      plain: { air, yards: 0, incomplete: true } }[k];
    const r = { ...G.root, phase: 0, down: 1 + Math.floor(R() * 4), ytg: Math.min(yl, 10), yl, pos: R() < 0.5 ? G.me : 1 - G.me, try2: false, t: 1700 - i };
    const e = { ev: 'play', team: r.pos, call: ci, row: -1, t: r.t, kind: 1, ...o };
    if (R() < 0.75 && k !== 'away') e.route = pick(routes);
    const n0 = window.__sepLog.length, side = R() < 0.5 ? 1 : -1;
    const sc = D.makeScene(r, side), P = D.choreograph(sc, e, { action: null, log: [e], root: { ...r, yl: Math.max(1, yl - (e.yards || 0)) } }, false);
    if (!P) continue;
    D.offField(sc, P, false).slice(0, 2).forEach((b) => { if (off.length < 10) off.push({ id, k, yl, ...b }); });
    if (window.__sepLog.length > n0) rows.push({ ...window.__sepLog[window.__sepLog.length - 1], id, want: k, yl });
  }
  logs.forEach((k, i) => { if (window[k]) window[k].length = kept[i]; });
  D.drawField();
  return { rows, off };
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
# it, with nobody having scrolled; on a tall phone every receiver's row too, clear of the Snap key
REACH = """(sel) => {
  const es = [...document.querySelectorAll(sel)];
  if (!es.length) return [`${sel}: not on the screen`];
  return es.map((e) => {
    const r = e.getBoundingClientRect();
    if (!r.height || r.top < -0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5)
      return `${sel} (${e.innerText.replace(/\\s+/g, ' ').slice(0, 40)}): out of view at ${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight}`;
    const snap = document.getElementById('snapGo'), s = snap && snap !== e && !snap.contains(e) && snap.getBoundingClientRect();
    if (s && r.bottom > s.top - 6 + 0.5) return `${sel} (${e.innerText.replace(/\\s+/g, ' ').slice(0, 40)}): under the Snap key`;
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return h && e.contains(h) ? '' : `${sel}: covered by ${h ? h.outerHTML.slice(0, 80) : 'nothing'}`;
  }).filter(Boolean);
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
    ctx = await browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
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
    if mode == "scenario":
        await pro_context(ctx, base)
    page = await ctx.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda e: problems.append(f"script error: {e}"))
    page.on("console", lambda m: m.type == "error" and "googletagmanager" not in m.text and "ERR_" not in m.text
            and not any(CUT(u) for u in [(m.location or {}).get("url") or "", *re.findall(r"https?://[^\s'\"]+", m.text)])
            and problems.append(f"console error: {m.text[:300]}"))
    # (a reload cuts short what is still downloading: the first call shows before the simulator's data is in; Safari
    # calls that cancelled)
    page.on("requestfailed", lambda r: base in r.url and not CUT(r.url) and not re.search(r"ERR_ABORTED|cancell?ed", r.failure or "", re.I)
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
                "races": 0, "wait_s": 0.0, "wait_max_s": 0.0, "loading_s": 0.0, "loading_max_s": 0.0, "turned": 0}
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
    asked = False                    # the bot opened the modal on screen itself (else it came up in the way)
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
                if st == "errbar":
                    problems.append("the page's error bar: " + await page.evaluate("() => document.getElementById('errBar').innerText.slice(0, 300)"))
                elif st == "error":
                    problems.append(f"error shown to the player: {key[1][:300]!r}")
                elif st in ("modal", "deep"):
                    if not asked:                # (something came up over the game that the bot never asked for)
                        friction["modals"].append(await page.evaluate("() => document.getElementById('modal').innerText.replace(/\\s+/g, ' ').slice(0, 80)")
                                                  if st == "modal" else "deep")
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
                        box = await page.locator("#field").bounding_box()
                        for _ in range(rnd.randint(1, 3)):
                            await page.mouse.click(box["x"] + rnd.random() * box["width"], box["y"] + rnd.random() * box["height"])
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
                    if mobile:
                        await page.click("#menuBtn", timeout=3000)
                        item = page.locator("#bmenu [data-restart]")
                        if not await item.is_visible():
                            problems.append("the ☰ menu has no Start over during the daily"); continue
                        await item.click(timeout=3000)
                    else:
                        if not await page.locator("#restartBtn").is_visible():
                            problems.append("no Start over under the field during the daily"); continue
                        await page.click("#restartBtn", timeout=3000)
                    await page.wait_for_timeout(200)
                    txt = await page.evaluate("() => document.getElementById('modal').hidden ? '' : document.getElementById('modal').innerText")
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
                    since = time.time()
                    print(f"{name}: short fields, {plays} plays drawn, {len(off)} off the ground")
                    if off:
                        problems.append(f"off the field on a short field: {off[:4]}")
                elif st == "choose" and sweep and "pass_look" not in chaos_done:
                    chaos_done.add("pass_look"); act("pass-look sweep")
                    rows, off, t_pl = [], [], time.time()
                    for k in range(4):                    # (in batches: a page drawing them all at once ran out of memory)
                        pl = await page.evaluate(PASS_LOOK, [150, seed * 17 + k])
                        rows += pl["rows"]; off += pl["off"]
                    since = time.time()
                    t_start += since - t_pl
                    mix = {}
                    for x in rows:
                        mix[x.get("label") or x.get("miss")] = mix.get(x.get("label") or x.get("miss"), 0) + 1
                    wrong = pass_look_problems(rows)
                    print(f"{name}: pass looks, {len(rows)} passes drawn {dict(sorted(mix.items(), key=lambda kv: -kv[1]))}, {len(wrong)} not as they went, {len(off)} off the ground")
                    if wrong:
                        problems.append(f"a pass not drawn as it went: {wrong[:4]}")
                    if off:
                        problems.append(f"off the field on a pass: {off[:4]}")
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
            await page.wait_for_timeout(rnd.choice([0, 10, 20] if rapid else [30, 60, 120]))
        else:
            problems.append(f"never finished: {finished} of {target} games after {steps} steps")
        if not problems and finished < (1 if mode == "daily" else target):
            problems.append(f"stopped after {finished} of {target} games")
    finally:
        try:
            seps = await page.evaluate("() => window.__sepLog || []")
            tackles = await page.evaluate("() => window.__tackleLog || []")
            fps = await page.evaluate("() => window.__fpLog || []")
            offs = await page.evaluate("() => window.__offLog || []")
            kept = await page.evaluate("() => (window.__drawLog || []).length")
            snaps = await page.evaluate("() => window.__drawSnaps || []")
            jank = await page.evaluate("() => window.__jank || null")
        except Exception:
            seps, tackles, fps, offs, kept, snaps, jank = [], [], [], [], 0, [], None
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
            "secs": round(time.time() - t_start), "rundowns": rundowns, "drawn": drawn, "kept": kept, "sketched": sketched, "snaps": snaps, "problems": problems[:5], "seps": seps, "tackles": tackles, "fps": fps, "offs": offs, "trail": trail if problems else [],
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
# simulator of his own, its id ending |qb:<his name>)
WORKER_SPY = """(() => {
  const pm = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    try { if (m && m.scen && m.type !== 'init') (window.__scenIds = window.__scenIds || []).push(`${m.type}|${m.scen.id}`); } catch (e) { /* not the game's */ }
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


SIZES = ((390, 844, True), (375, 667, True), (1280, 900, False))


async def snap_reach(browser, base: str, sizes: tuple = SIZES) -> list[str]:
    """The snap needs no scrolling: on a phone (390x844, 375x667) and a desktop, a pass's Snap key, the run keys and a
    drawn run's Run it, the defense's Call it (the full call and the three keys) and the kicks' keys are all on the screen
    as each comes up. (daily_check.py: the phone it plays as, and a desktop)"""
    out: list[str] = []
    for w, h, mob in sizes:
        ctx = await browser.new_context(viewport={"width": w, "height": h}, is_mobile=mob, has_touch=mob)
        await ctx.add_init_script("window.__sepLog = [];")
        page = await ctx.new_page()
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(f"script error: {e}"))
        at = f"{w}x{h}"

        async def check(screen, sel):
            await page.wait_for_timeout(900)          # (the keys' pop and the sheet's slide)
            if await page.locator(".tipskip:visible").count():      # (the first drive's tour: its tips are not calls)
                await page.click(".tipskip", timeout=3000)
                await page.wait_for_timeout(300)
            out.extend(f"{at} {screen}: {x}" for x in await page.evaluate(REACH, sel))

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
            if await tap("PASS"):
                await check("pass", "#snapGo")
                if mob and h >= 800:
                    await check("pass", "#dock .rcv")
                await page.click("#dock .ask .chip", timeout=3000)          # Back
                await page.wait_for_timeout(400)
            if await tap("RUN"):
                await check("run", "#dock .prow .key")
                sk = await page.evaluate(SKETCH)
                rb = [m for m in (sk or {}).get("men", []) if m[2] in ("RB", "FB")]
                for k in range(4 if rb else 0):
                    x, y = rb[0][:2]
                    ly, up, ppy = sk["los"][1], sk["up"], sk["ppy"]
                    pts = [(x + (k - 1.5) * 3 * ppy, ly), (x + (k - 1.5) * 4 * ppy, ly + up * 8 * ppy)]
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
                await page.evaluate(SHOW, what)
                await check(what, "#dock .snapbar .key")
        except Exception as e:
            out.append(f"{at}: {e}")
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
        reach = await snap_reach(browser, base)
        print("snap in reach (pass, run, defense, kicks at 390x844, 375x667, 1280x900): " + ("ok" if not reach else "FAIL")
              + "".join(f"\n      {x}" for x in reach), flush=True)
        qb = await qb_swap(browser, base, a.shots)
        print("Who plays, the quarterback (the sheet's first row, a backup put in plays and is graded on his simulator, back to the real lineup): "
              + ("ok" if not qb else "FAIL") + "".join(f"\n      {x}" for x in qb), flush=True)
        reach += qb
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
