// Live Drills (game.js #live): when a real NFL game reaches a two-minute spot (one score apart, under 2:00 of a half,
// under 5:00 of the fourth quarter, or overtime), players call the next play before they see the real one, and the
// page shows both calls graded side by side, snap by snap, as the real drive goes on. This is the worker's half: it
// watches the live feed (board/live_espn.js, the one module that reads it), turns a game's plays into drills (the real
// situation before each snap, the call the real play maps to in the game's playbook, what happened) and keeps them in
// a Durable Object of their own (Live), so the leaderboard's object never waits on the feed.
//   GET  /live                 -> { on, now, poll, again, drills: [{ id, home, away, player, now, n, polled, ... }] }
//                                 the drills open now; off (the switch below): { on: false, drills: [] }
//   GET  /live/drill?id=X      -> { now, drill }   one drill, open or over: every snap so far (the archive's too)
//   GET  /live/archive         -> { drills: [...] }   finished drills, newest first (ARCH_KEEP kept): Pro replays them
//   GET  /live/admin           (Authorization: Bearer <ADMIN_TOKEN>) -> the switch, the feed's rejections, the games
//   POST /live/admin { on }    (the same) -> pause (on: false) or resume (on: true) at once, no deploy
// The switch: nothing happens unless the worker variable LIVE_ON is "on" (set in the Cloudflare dashboard: Workers &
// Pages, two-minute-drill-board, Settings, Variables; keep_vars keeps it through deploys; never in wrangler.toml, or a
// deploy would reset it). Off, the cron does no work at all (not even a read of the object), and GET /live answers
// { on: false } without asking it, so pages stop asking. On, POST /live/admin pauses and resumes it instantly. The
// site's <meta name="live"> (site.py --live) only decides whether the page asks GET /live at all.
// Latency budget: the feed runs 20 to 60 s behind the TV picture; the watcher looks at it once a minute (the cron); the
// page asks for its drill every POLL_S (12 s) while one is open. A real play reaches the page about 20 to 130 s after it
// happens, a minute and a half on average (the replay test in worker_test.mjs measures it). The page never shows a
// drill as live when the worker's last good look at its game is older than STALE_MS (3 minutes): it says it is waiting
// on the next play, and gives up after 10 minutes without one.
// Being gentle with the feed: the scoreboard once an hour between games and once a minute while a game is on or about
// to start (one request for every game); one request a minute for each game in or near a two-minute spot; after an
// error, that request waits 1, 2, 4 ... up to 30 minutes. Everything read is checked (live_espn.js); a payload that is not
// as expected is rejected, counted (GET /live/admin: rej) and logged, and no drill is opened or changed on it: no drill
// rather than a wrong one.
// Auto-post to X when a drill opens (xPost): only when all four secrets are set, X_API_KEY, X_API_SECRET (the app's
// consumer key and secret), X_ACCESS_TOKEN and X_ACCESS_SECRET (the posting account's, read and write), each with
// `npx wrangler secret put <NAME>` from board/ (never in the repository). Without them nothing is posted. At most
// X_DAY_MAX posts a day, one a drill.
import * as FEED from './live_espn.js';

export const LIVE_CRON = '* * * * *';          // wrangler.toml [triggers]: the watcher's minute (the other cron is the daily email's)
export const LIVE_PATHS = ['/live', '/live/drill', '/live/archive', '/live/admin'];
const CRON_PATH = '/_cron/live';               // (only the cron reaches it: the worker routes LIVE_PATHS here, nothing else)
const POLL_S = 12;                             // the page asks for its drill this often while one is open (game.js LIVE_POLL)
const STALE_MS = 3 * 60e3;                     // a drill not read from the feed this long is not shown as live (the page: liveStale)
const IDLE_MS = 20 * 60e3;                     // an open drill not read from the feed this long is closed: the feed lost it
const TICK_MS = 55e3;                          // a minute, less the cron's jitter: one read of each thing a minute at most
const BOARD_IDLE_MS = 60 * 60e3;               // the scoreboard between games: once an hour
const SOON_MS = 15 * 60e3;                     // a kickoff this close counts as a game on
const ARCH_KEEP = 60, X_DAY_MAX = 8, REJ_KEEP = 20, MEMO_MS = 4000;
const ONE_SCORE = 8;
// the replay test's clock (worker_test.mjs sets it to the recorded game's time); nothing else touches it
export const LIVE_CLOCK = { now: null };
const nowMs = () => (LIVE_CLOCK.now != null ? LIVE_CLOCK.now : Date.now());
export const liveOn = (env) => String((env && env.LIVE_ON) || '').trim().toLowerCase() === 'on';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
// every team by its city, never its nickname (game.js TEAMS); the two shared markets say which
const CITY = { ARI: 'Arizona', ATL: 'Atlanta', BAL: 'Baltimore', BUF: 'Buffalo', CAR: 'Carolina', CHI: 'Chicago', CIN: 'Cincinnati', CLE: 'Cleveland',
  DAL: 'Dallas', DEN: 'Denver', DET: 'Detroit', GB: 'Green Bay', HOU: 'Houston', IND: 'Indianapolis', JAX: 'Jacksonville', KC: 'Kansas City',
  LV: 'Las Vegas', LAC: 'Los Angeles (AFC)', LA: 'Los Angeles (NFC)', MIA: 'Miami', MIN: 'Minnesota', NE: 'New England', NO: 'New Orleans',
  NYG: 'New York (NFC)', NYJ: 'New York (AFC)', PHI: 'Philadelphia', PIT: 'Pittsburgh', SF: 'San Francisco', SEA: 'Seattle', TB: 'Tampa Bay',
  TEN: 'Tennessee', WAS: 'Washington' };
export const cityOf = (c) => CITY[c] || c;

// ---- a game's plays -> its drills
const halfOf = (period) => (period <= 2 ? 1 : period <= 4 ? 2 : period);          // (each overtime period its own)
const sideOf = (g, c) => (c === g.home ? 1 : 0);                                     // index in [away, home]
const twoMin = (s) => (s.qtr === 2 && s.clock <= 120) || (s.qtr === 4 && s.clock <= 300) || s.qtr >= 5;
// ahead, and a kneel on each down left runs out the clock whatever the defense does (game.js kneelsOut): nothing to call
function kneelsOut(g, s) {
  const me = sideOf(g, s.pos), lead = s.score[me] - s.score[1 - me], n = 5 - s.down;
  return s.qtr >= 4 && lead > 0 && s.clock <= 2 * n + 38 * Math.max(n - 1 - s.to[1 - me], 0);
}
// the clock before a snap: stopped after anything that stops it (an incompletion, out of bounds in the last minutes, a
// score, a change of possession, a timeout, the two-minute warning, a foul, a spike, a quarter's end), else running
function stoppedAfter(p, next) {
  if (!p) return true;
  // the two-minute warning came between them (the feed may have no line for it): the clock crossed 2:00 of a half
  if (next && next.period === p.period && [2, 4].includes(p.period) && p.clock > 120 && next.clock <= 120) return true;
  if (['timeout', 'warning', 'end', 'kickoff', 'pat', 'fg', 'punt', 'penalty', 'spike', 'other'].includes(p.kind)) return true;
  return p.incomplete || p.ob || p.td || p.turnover || p.nullified || (!!next && !!next.team && p.team !== next.team);
}
// a play as a call in the game's playbook (playbook.py CALLS). The feed says left, middle or right, not strong or weak
// side: the right is taken as the strong side (where most offenses line up their tight end). A rushing quarterback (the
// one who threw for his team in this game) is a quarterback run, a sneak on short yardage; a scramble or a sack was a
// pass call the feed does not name: null (that snap's real call is not graded)
function callOf(p, qbs) {
  if (['kneel', 'spike', 'fg', 'punt'].includes(p.kind)) return p.kind;
  if (p.kind === 'pass' && p.pass) return `${p.pass.deep ? 'deep' : 'quick'}_${p.pass.side === 'middle' ? 'middle' : p.pass.side === 'right' ? 'strong' : 'weak'}`;
  if (p.kind === 'run' && p.run) {
    if (p.by && qbs.has(p.by)) return p.run.gap === 'middle' && p.ytg <= 2 ? 'qb_sneak' : 'qb_run';
    if (p.run.gap === 'middle') return 'rb_middle';
    return `rb_${{ end: 'out', tackle: 'tackle', guard: 'inside' }[p.run.gap]}_${p.run.side === 'right' ? 'strong' : 'weak'}`;
  }
  return null;
}
// the feed's words, without the clock, the formation and the jersey numbers
const clean = (t) => String(t || '').replace(/^\s*\(\d*:\d+\)\s*/, '').replace(/^(\((Shotgun|No Huddle|No Huddle, Shotgun|Punt formation|Field Goal formation)\)\s*)+/i, '')
  .replace(/\b\d{1,2}-(?=[A-Z])/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
// what a snap did, in a few words
function resultOf(p) {
  const t = p.text, y = Math.round(p.yards);
  if (p.kind === 'timeout') return 'Timeout';
  if (p.nullified) { const m = /PENALTY on [A-Z]{2,4}-?[^,]*, ([^,]+), (\d+) yards?/i.exec(t); return m ? `Flag: ${m[1].toLowerCase()}, ${m[2]} yards (no play)` : 'Flag (no play)'; }
  if (p.kind === 'kneel') return 'Kneel';
  if (p.kind === 'spike') return 'Spiked';
  if (p.kind === 'fg') { const d = /(\d+) yard field goal/i.exec(t); return /is good/i.test(t) ? `${d ? `${d[1]}-yard f` : 'F'}ield goal is good` : /blocked/i.test(t) ? 'Field goal blocked' : 'Field goal: no good'; }
  if (p.kind === 'punt') return /blocked/i.test(t) ? 'Punt blocked' : 'Punt';
  if (p.turnover) return /intercept/i.test(t) ? 'Intercepted' : 'Fumble, lost';
  if (p.td) return 'Touchdown';
  if (p.kind === 'sack') return `Sacked, −${Math.abs(y)}`;
  if (p.incomplete) return 'Incomplete';
  const yd = y > 0 ? `+${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `−${-y} yard${y === -1 ? '' : 's'}` : 'No gain';
  return p.next && p.next.team === p.team && p.next.down === 1 && p.down !== 1 ? `${yd}, first down` : yd;
}
// how a possession ended, from the play that ended it
function endOf(p, after) {
  if (p.kind === 'fg') return /is good/i.test(p.text) ? 'field goal' : 'missed field goal';
  if (p.kind === 'punt') return 'punt';
  if (/\bsafety\b/i.test(p.text)) return 'safety';
  if (p.turnover) return 'turnover';
  if (p.td) return 'touchdown';
  if (after && after.kind === 'end') return after.period === 2 ? 'end of half' : 'end of game';
  return p.down === 4 ? 'downs' : 'turnover';
}

// Every drill a game's plays hold in the half being played (an earlier half's are settled: the timeouts are known only
// for this one). anchor: { to: [away, home], id }, the timeouts the scoreboard said were left after the play with that
// id: every other play's count works out from it (each timeout taken after it one fewer, before it one more)
export function drillsOf(g, plays, anchor) {
  if (!plays.length) return [];
  const last = plays[plays.length - 1], H = halfOf(last.period);
  // who gets the ball after halftime: the team that kicked off the game
  const ko = plays.find((p) => p.kind === 'kickoff' && p.period === 1 && p.team);
  const r2h = ko ? ko.team : null;
  const toBefore = plays.map(() => null), a = anchor ? plays.findIndex((p) => p.id === anchor.id) : -1;
  if (a >= 0 && halfOf(plays[a].period) === H) {
    const ok = (t) => (t[0] >= 0 && t[1] >= 0 && t[0] <= 3 && t[1] <= 3 ? t.slice() : null);
    const t = anchor.to.slice();
    for (let i = a; i >= 0 && halfOf(plays[i].period) === H; i--) {        // (before the anchor's play and every one back)
      if (plays[i].kind === 'timeout' && plays[i].toBy) t[sideOf(g, plays[i].toBy)] += 1;
      toBefore[i] = ok(t);
    }
    const u = anchor.to.slice();
    for (let i = a + 1; i < plays.length; i++) {
      toBefore[i] = ok(u);
      if (plays[i].kind === 'timeout' && plays[i].toBy) u[sideOf(g, plays[i].toBy)] -= 1;
    }
  }
  // the passers of each team (a rushing passer is a quarterback run)
  const qbs = {};
  plays.forEach((p) => { if ((p.kind === 'pass' || p.kind === 'sack') && p.by && p.team) (qbs[p.team] = qbs[p.team] || new Set()).add(p.by); });
  // the possessions: [{ team, items: [play index], end: index of the play that ended it, how }]
  const poss = [];
  let cur = null;
  const close = (how, end) => { if (cur) { cur.how = how; cur.end = end; poss.push(cur); cur = null; } };
  plays.forEach((p, i) => {
    if (FEED.isSnap(p.kind)) {
      if (cur && cur.team !== p.team) { const lp = plays[cur.lastSnap]; close(lp && lp.down === 4 && !lp.turnover ? 'downs' : 'turnover', cur.lastSnap); }
      if (!cur) cur = { team: p.team, items: [], lastSnap: -1 };
      cur.items.push(i);
      cur.lastSnap = i;
      if (!p.nullified && (p.td || p.turnover || p.kind === 'fg' || p.kind === 'punt' || /\bsafety\b/i.test(p.text))) close(endOf(p), i);
    } else if (p.kind === 'timeout' || p.kind === 'warning' || p.kind === 'penalty') { if (cur) cur.items.push(i); }
    else if (p.kind === 'end') {
      // the end of the first or third quarter: the drive goes on; of a half, regulation or overtime: it ends
      if ([1, 3].includes(p.period)) { if (cur) cur.items.push(i); }
      else close(p.period === 2 ? 'end of half' : p.period === 4 && p.score[0] === p.score[1] ? 'end of regulation' : 'end of game', i);
    } else if (p.kind === 'kickoff' || p.kind === 'pat') close('turnover', i);       // (a possession already ended: nothing to close)
  });
  if (cur && g.state === 'post') close('end of game', plays.length - 1);
  const open = cur;
  if (open) { open.how = null; open.end = null; poss.push(open); }
  // overtime: who has had the ball before each possession of it ([home, away], game.js otOf start.otc)
  const otHad = {}, otcOf = new Map();
  poss.forEach((q) => {
    const p0 = plays[q.items[0]];
    if (p0 && p0.period >= 5) { otcOf.set(q, [otHad[g.home] ? 1 : 0, otHad[g.away] ? 1 : 0]); if (q.how) otHad[q.team] = 1; }
  });
  const out = [];
  for (const q of poss) {
    const decisions = [];
    let pre = [];
    const scoreBefore = (i) => (i > 0 ? plays[i - 1].score : plays[i].score);
    const sitAt = (i, spot) => {
      const p = plays[i], tb = toBefore[i];
      if (!spot || !tb || halfOf(p.period) !== H) return null;
      return { qtr: p.period, clock: p.clock, score: scoreBefore(i).slice(), pos: q.team, down: spot.down, ytg: spot.ytg, yl: spot.yl, to: tb,
        running: !stoppedAfter(plays[i - 1], p), ...(otcOf.has(q) ? { otc: otcOf.get(q) } : {}) };
    };
    q.items.forEach((i, k) => {
      const p = plays[i];
      if (FEED.isSnap(p.kind)) {
        decisions.push({ i, p, before: sitAt(i, p), pre });
        pre = [];
      } else if (p.kind === 'timeout' && p.toBy === q.team) {
        // the offense's own timeout is a call of its own (the spot: the next snap's, else the last one's after)
        const nx = q.items.slice(k + 1).map((j) => plays[j]).find((x) => FEED.isSnap(x.kind));
        const lastSnap = decisions.length ? decisions[decisions.length - 1].p : null;
        const spot = nx || (lastSnap && lastSnap.next && lastSnap.next.team === q.team ? lastSnap.next : null);
        decisions.push({ i, p, before: sitAt(i, spot), pre });
        pre = [];
      } else pre.push(p.kind === 'timeout' ? (p.toBy ? `Timeout, ${cityOf(p.toBy)}` : 'Timeout') : p.kind === 'warning' ? 'Two-minute warning'
        : p.kind === 'end' ? `End of the ${['first', 'second', 'third', 'fourth'][p.period - 1] || ''} quarter` : clean(p.text));
    });
    // the drill: from the first call in a two-minute spot of a one-score game (not a kneel-out) to the end of the possession
    const k0 = decisions.findIndex((d) => d.before && twoMin(d.before) && Math.abs(d.before.score[0] - d.before.score[1]) <= ONE_SCORE && !kneelsOut(g, d.before));
    if (k0 < 0) continue;
    const ds = decisions.slice(k0);
    if (ds.some((d) => !d.before)) continue;             // (anything unknown inside it: no drill rather than a wrong one)
    const snaps = ds.map((d, n) => ({ n, id: d.p.id, before: d.before, what: d.p.kind, call: d.p.kind === 'timeout' ? 'timeout' : callOf(d.p, qbs[q.team] || new Set()),
      side: d.p.pass ? `${d.p.pass.deep ? 'deep' : 'short'} ${d.p.pass.side}` : d.p.run ? (d.p.run.gap === 'middle' ? 'up the middle' : `${d.p.run.side} ${d.p.run.gap}`) : null,
      who: d.p.by, raw: clean(d.p.text), yards: Math.round(d.p.yards || 0), res: resultOf(d.p), pre: d.pre, wall: d.p.wall }));
    snaps.forEach((s, n) => { s.after = n + 1 < snaps.length ? snaps[n + 1].before : null; });
    const opp = q.team === g.home ? g.away : g.home;
    const d = { id: `${g.id}-${snaps[0].id}`, game: g.id, season: g.season, week: g.week, type: g.type, date: g.at ? new Date(g.at).toISOString() : null,
      home: g.home, away: g.away, player: q.team, opp, indoor: !!g.indoor, spread: g.spread || 0, r2h, start: snaps[0].before, snaps, status: q.how ? 'over' : 'open',
      now: null, end: null };
    if (q.how) {
      const e = plays[q.end];
      const said = { 'end of half': 'The end of the half', 'end of game': 'The final gun', 'end of regulation': 'The end of regulation: overtime' }[q.how];
      d.end = { how: q.how, text: e && FEED.isSnap(e.kind) ? resultOf(e) : said || (e ? clean(e.text) : ''), score: (e ? e.score : last.score).slice() };
    } else d.now = nowOf(g, plays, q, snaps, toBefore);
    out.push(d);
  }
  return out;
}
// the open drill's next call: the spot after its last play (the scoreboard's when the plays have none), the score and
// timeouts now, the clock as the scoreboard has it when nothing has happened since (else the last play's)
function nowOf(g, plays, q, snaps, toBefore) {
  const last = plays[plays.length - 1], ls = snaps[snaps.length - 1], lp = plays.find((p) => p.id === ls.id);
  let spot = lp && lp.next && lp.next.team === q.team ? lp.next : null;
  const sb = g.sit && g.sit.pos === q.team ? g.sit : null;
  if (last !== lp && last.kind === 'penalty' && sb) spot = sb;           // (a foul before the snap moved the ball: the scoreboard's)
  if (!spot && sb) spot = sb;
  const to = toAfter(g, plays, toBefore);
  if (!spot || !to || !g.score) return null;
  const same = sb && sb.down === spot.down && sb.yl === spot.yl && g.period === last.period;
  const clock = same && g.clock != null && g.clock <= last.clock ? g.clock : last.clock;
  const nx = { period: last.period, clock };
  return { qtr: last.period, clock, score: g.score.slice(), pos: q.team, down: spot.down, ytg: Math.min(spot.ytg, spot.yl), yl: spot.yl, to,
    running: !stoppedAfter(last, nx) && !(lp && lp.next && lp.next.team !== q.team), ...(ls.before.otc ? { otc: ls.before.otc } : {}) };
}
// the timeouts left after the last play: the count before it, less its own
function toAfter(g, plays, toBefore) {
  const i = plays.length - 1, t = toBefore[i];
  if (!t) return null;
  const u = t.slice();
  if (plays[i].kind === 'timeout' && plays[i].toBy) u[sideOf(g, plays[i].toBy)] -= 1;
  return u[0] >= 0 && u[1] >= 0 ? u : null;
}

// ---- the watcher (the cron, once a minute: Live.fetch CRON_PATH)
const gameOn = (games, now) => (games || []).some((g) => g.state === 'in' || (g.state === 'pre' && g.at && g.at - now <= SOON_MS && now - g.at <= 6 * 3600e3));
// a game in or near a two-minute spot: worth reading its plays this minute
const near = (g) => g.state === 'in' && g.score && Math.abs(g.score[0] - g.score[1]) <= ONE_SCORE
  && ((g.period === 2 && g.clock <= 150) || (g.period === 4 && g.clock <= 330) || g.period >= 5);
const backoff = (err) => Math.min(30, 2 ** Math.max(0, err - 1)) * 60e3;     // 1, 2, 4 ... 30 minutes
// a rejected payload: counted, the last few reasons kept, logged (the owner sees a schema change at GET /live/admin)
async function reject(s, why, now) {
  const r = (await s.get('rej')) || { n: 0, last: [] };
  r.n += why.length;
  r.last = [...why.slice(0, 5).map((w) => ({ at: new Date(now).toISOString(), why: String(w).slice(0, 200) })), ...r.last].slice(0, REJ_KEEP);
  await s.put('rej', r);
  console.error('live feed: rejected', why.length, JSON.stringify(why.slice(0, 3)));
}
// the polite fetch: a timeout, JSON, nothing retried
async function getJson(url) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'TwoMinuteDrill-LiveDrills/1.0' }, ...(ctl ? { signal: ctl.signal } : {}) });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally { if (t) clearTimeout(t); }
}
export async function tick(env, s, now, get = getJson) {
  if (!liveOn(env) || (await s.get('sw')) === 'off') return { off: true };
  const out = { board: false, read: [], opened: [], closed: [] };
  let sched = (await s.get('sched')) || { at: 0, games: [], err: 0, until: 0 };
  if (now >= (sched.until || 0) && now - (sched.at || 0) >= (gameOn(sched.games, now) ? TICK_MS : BOARD_IDLE_MS)) {
    try {
      const { games, bad } = FEED.board(await get(FEED.BOARD));
      if (bad.length) await reject(s, bad, now);
      sched = { at: now, games, err: 0, until: 0 };
      out.board = true;
    } catch (e) {
      const err = (sched.err || 0) + 1;
      sched = { ...sched, err, until: now + backoff(err) };
      console.error('live feed: the scoreboard failed', e && e.message, `(${err} in a row)`);
    }
    await s.put('sched', sched);
  }
  let open = (await s.get('open')) || [];
  for (const g of sched.games) {
    const mine = open.filter((id) => id.startsWith(`${g.id}-`)), gk = `g:${g.id}`;
    // (a game being watched that went final since: read once more, for the plays of its last minute)
    const gs = near(g) || mine.length || g.state === 'post' ? (await s.get(gk)) || { at: 0, err: 0, until: 0 } : null;
    if (!gs || (!near(g) && !mine.length && !(g.state === 'post' && gs.state === 'in'))) continue;
    if (now < (gs.until || 0) || now - (gs.at || 0) < TICK_MS) continue;
    gs.state = g.state;
    let doc;
    try { doc = await get(FEED.gameUrl(g.id)); } catch (e) {
      gs.err = (gs.err || 0) + 1; gs.until = now + backoff(gs.err);
      await s.put(gk, gs);
      console.error('live feed: a game failed', g.id, e && e.message, `(${gs.err} in a row)`);
      continue;
    }
    gs.at = now;
    const { plays, bad } = FEED.game(doc, g);
    const H = plays.length ? halfOf(plays[plays.length - 1].period) : 0;
    if (bad.length) await reject(s, bad.map((b) => b.why), now);
    // a play of the half being played not as expected: this game's drills stay as they were (no drill rather than a wrong one)
    if (!plays.length || bad.some((b) => b.period == null || halfOf(b.period) >= H)) { await s.put(gk, gs); continue; }
    gs.err = 0; gs.until = 0;
    // the timeouts' anchor: what the scoreboard said was left, after the last play then (kept: at the final gun the
    // scoreboard says nothing)
    if (g.to && g.state === 'in') gs.anchor = { to: g.to.slice(), id: plays[plays.length - 1].id };
    await s.put(gk, gs);
    out.read.push(g.id);
    for (const d of drillsOf(g, plays, gs.anchor)) {
      const k = `d:${d.id}`, was = await s.get(k);
      if (was && was.status === 'over') continue;          // a finished drill stays as it was
      const atOf = new Map((was ? was.snaps : []).map((x) => [x.id, x.at]));
      d.snaps.forEach((x) => { x.at = atOf.get(x.id) || now; });
      const sig = (x) => JSON.stringify([x.snaps.map(({ at, ...y }) => y), x.now, x.status, x.end]);
      d.opened = was ? was.opened : now;
      d.upd = !was || sig(was) !== sig(d) ? now : was.upd;
      d.polled = now;
      if (d.status === 'over') d.closed = now;
      d.coach = (await coachOf(env, d.player)) || null;
      await s.put(k, d);
      if (!was && d.status === 'open') { open.push(d.id); out.opened.push(d.id); await xHook(env, s, d, now); }
      if (d.status === 'over') { if (open.includes(d.id)) out.closed.push(d.id); open = open.filter((x) => x !== d.id); await archive(s, d); }
    }
    // this game's other open drills read now too (the feed reread): they are as fresh
    for (const id of open.filter((x) => x.startsWith(`${g.id}-`))) {
      const d = await s.get(`d:${id}`);
      if (d && d.polled !== now) { d.polled = now; await s.put(`d:${id}`, d); }
    }
  }
  // an open drill the feed has lost (no good read of its game for IDLE_MS): closed, kept in the archive as far as it went
  for (const id of open.slice()) {
    const d = await s.get(`d:${id}`);
    if (d && d.status === 'open' && now - d.polled <= IDLE_MS) continue;
    open = open.filter((x) => x !== id);
    if (!d) continue;
    Object.assign(d, { status: 'over', closed: now, now: null, end: { how: 'feed', text: 'The live feed stopped sending plays', score: d.snaps.length ? (d.snaps[d.snaps.length - 1].after || d.snaps[d.snaps.length - 1].before).score : d.start.score } });
    await s.put(`d:${id}`, d);
    await archive(s, d);
    out.closed.push(id);
  }
  await s.put('open', open);
  return out;
}
// a finished drill on the archive's list (the newest ARCH_KEEP; an older one's snaps go with it)
async function archive(s, d) {
  const list = ((await s.get('arch')) || []).filter((x) => x.id !== d.id);
  list.unshift({ id: d.id, home: d.home, away: d.away, player: d.player, coach: d.coach || null, date: d.date, start: d.start, n: d.snaps.length, how: d.end ? d.end.how : null,
    score: d.end ? d.end.score : null, closed: d.closed });
  for (const x of list.slice(ARCH_KEEP)) await s.delete(`d:${x.id}`);
  await s.put('arch', list.slice(0, ARCH_KEEP));
}
// the head coach of a team now: the Versus teams file the worker carries (assets/vs/teams.json, site.yml), kept a while
let COACHES = { at: 0, map: null };
async function coachOf(env, code) {
  if (!env.ASSETS) return null;
  if (!COACHES.map || Date.now() - COACHES.at > 6 * 3600e3) {
    COACHES.at = Date.now();
    try {
      const r = await env.ASSETS.fetch(new Request('https://assets.local/vs/teams.json'));
      const t = r.ok ? await r.json() : null;
      COACHES.map = t && t.teams ? Object.fromEntries(Object.entries(t.teams).map(([c, x]) => [c, x && x.coach ? String(x.coach) : null])) : COACHES.map;
    } catch (e) { /* the drill goes without */ }
  }
  return (COACHES.map && COACHES.map[code]) || null;
}

// ---- the post to X when a drill opens ("Live now: Kansas City ball at the Buffalo 38, down 3, 1:47 left. Call it
// before Reid does -> https://2mindrills.com/#live")
const X_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
export const xOn = (env) => X_KEYS.every((k) => !!(env && env[k]));
export function xText(env, d) {
  const s = d.now || d.start, me = sideOf(d, s.pos), lead = s.score[me] - s.score[1 - me];
  const at = s.yl === 50 ? 'at midfield' : s.yl > 50 ? `at its own ${100 - s.yl}` : `at the ${cityOf(d.opp)} ${s.yl}`;
  const ck = `${Math.floor(s.clock / 60)}:${String(Math.ceil(s.clock) % 60).padStart(2, '0')}`;
  const left = s.qtr >= 5 ? `${ck} left in overtime` : s.qtr === 2 ? `${ck} left in the half` : `${ck} left`;
  const who = d.coach ? String(d.coach).split(' ').slice(-1)[0] : 'the coach';
  const site = String(env.SITE || 'https://nfl2mindrill.com').replace(/\/+$/, '');
  return `Live now: ${cityOf(s.pos)} ball ${at}, ${lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'tied'}, ${left}. Call it before ${who} does → ${site}/#live`;
}
const pct = (x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
// OAuth 1.0a's signature (HMAC-SHA1 over the method, the address and every parameter, sorted; worker_test.mjs checks it
// against X's own worked example)
export async function oauthSign(method, url, params, consumerSecret, tokenSecret) {
  const base = [method, pct(url), pct(Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&'))].join('&');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${pct(consumerSecret)}&${pct(tokenSecret)}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)))));
}
// the Authorization header for X's API v2 (a JSON body is not part of what is signed)
export async function xAuth(env, method, url, now, nonce = randHex(16)) {
  const o = { oauth_consumer_key: env.X_API_KEY, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(now / 1000)),
    oauth_token: env.X_ACCESS_TOKEN, oauth_version: '1.0' };
  const sig = await oauthSign(method, url, o, env.X_API_SECRET, env.X_ACCESS_SECRET);
  return 'OAuth ' + Object.entries({ ...o, oauth_signature: sig }).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}
export const X_URL = 'https://api.x.com/2/tweets';
async function xHook(env, s, d, now) {
  if (!xOn(env)) return;
  const day = new Date(now).toISOString().slice(0, 10), x = (await s.get('x')) || { day, n: 0 };
  if (x.day !== day) { x.day = day; x.n = 0; }
  if (x.n >= X_DAY_MAX) return;
  x.n += 1;
  await s.put('x', x);                       // (counted before it goes: a post that failed is not tried again)
  try {
    const r = await fetch(X_URL, { method: 'POST', body: JSON.stringify({ text: xText(env, d) }),
      headers: { Authorization: await xAuth(env, 'POST', X_URL, now), 'Content-Type': 'application/json' } });
    if (!r.ok) console.error('live: X refused the post', r.status);
  } catch (e) { console.error('live: X unreachable', e && e.message); }
}

// ---- what the page reads
const summary = (d) => ({ id: d.id, home: d.home, away: d.away, player: d.player, opp: d.opp, coach: d.coach || null, date: d.date, now: d.now, start: d.start,
  n: d.snaps.length, opened: d.opened, upd: d.upd, polled: d.polled });
const isAdmin = (req, env) => {
  const a = req.headers.get('Authorization') || '', want = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
  return !!want && a.length === want.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0;
};
const DRILL_RE = /^\d{4,14}-\d{1,24}$/;
async function route(req, env, s, url) {
  const now = nowMs(), p = url.pathname;
  if (p === '/live/admin') {
    if (!isAdmin(req, env)) return json({ error: 'forbidden' }, 403);
    if (req.method === 'POST') {
      let b = {};
      try { b = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (b.on === false) await s.put('sw', 'off'); else if (b.on === true) await s.delete('sw'); else return json({ error: 'on: true or false wanted' }, 400);
    } else if (req.method !== 'GET') return json({ error: 'method' }, 405);
    const sw = await s.get('sw'), sched = (await s.get('sched')) || {};
    return json({ on: liveOn(env) && sw !== 'off', var: liveOn(env), paused: sw === 'off', rej: (await s.get('rej')) || { n: 0, last: [] },
      board: { at: sched.at ? new Date(sched.at).toISOString() : null, err: sched.err || 0, games: (sched.games || []).map((g) => ({ id: g.id, state: g.state, home: g.home, away: g.away, period: g.period, clock: g.clock, score: g.score })) },
      open: (await s.get('open')) || [], x: xOn(env) });
  }
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  if (p === '/live') {
    const on = liveOn(env) && (await s.get('sw')) !== 'off';
    if (!on) return json({ on: false, drills: [] });
    const drills = [];
    for (const id of (await s.get('open')) || []) { const d = await s.get(`d:${id}`); if (d && d.status === 'open') drills.push(summary(d)); }
    const sched = (await s.get('sched')) || {};
    // again: when it is worth asking again (a page on Home during a game, waiting for one to open)
    return json({ on: true, now, poll: POLL_S, stale: STALE_MS, again: drills.length ? POLL_S : gameOn(sched.games, now) ? 60 : 900, drills });
  }
  if (p === '/live/drill') {
    const id = String(url.searchParams.get('id') || '');
    const d = DRILL_RE.test(id) ? await s.get(`d:${id}`) : null;
    return d ? json({ now, poll: POLL_S, stale: STALE_MS, drill: d }) : json({ error: 'no such drill' }, 404);
  }
  if (p === '/live/archive') return json({ now, drills: (await s.get('arch')) || [] });
  return json({ error: 'not found' }, 404);
}

export class Live {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === CRON_PATH) {
      let b = {};
      try { b = await req.json(); } catch (e) { /* the time now */ }
      return json(await tick(this.env, this.ctx.storage, Number(b.now) || nowMs()));
    }
    return route(req, this.env, this.ctx.storage, url);
  }
}
// The worker's front door for /live*: off (LIVE_ON not "on"), GET /live is answered here without waking the object;
// the page's polls are kept a few seconds in this isolate (many phones asking together cost the object one read)
const MEMO = new Map();
export async function live(req, env, url, h) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!LIVE_PATHS.includes(url.pathname)) return json({ error: 'not found' }, 404, h);
  if (url.pathname === '/live' && req.method === 'GET' && !liveOn(env)) return json({ on: false, drills: [] }, 200, h);
  if (!env.LIVE) return json({ error: 'live drills are not set up' }, 503, h);
  const memo = req.method === 'GET' && url.pathname !== '/live/admin' && LIVE_CLOCK.now == null, mk = url.pathname + url.search, hit = memo && MEMO.get(mk);
  if (hit && Date.now() - hit.at < MEMO_MS) return new Response(hit.body, { status: hit.status, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method === 'POST') MEMO.clear();            // (the switch flipped: this isolate's copies go; another's last MEMO_MS at most)
  const r = await env.LIVE.get(env.LIVE.idFromName('live')).fetch(new Request(req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined }));
  const body = await r.text();
  if (memo) { if (MEMO.size > 200) MEMO.clear(); MEMO.set(mk, { at: Date.now(), status: r.status, body }); }
  return new Response(body, { status: r.status, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
// the cron's minute: the watcher's look at the feed (nothing at all while LIVE_ON is off)
export function liveScheduled(ev, env, ctx) {
  if (!liveOn(env) || !env.LIVE) return Promise.resolve({ off: true });
  const now = ev && ev.scheduledTime ? ev.scheduledTime : Date.now();
  const run = env.LIVE.get(env.LIVE.idFromName('live')).fetch(new Request(`https://live${CRON_PATH}`, { method: 'POST', body: JSON.stringify({ now }) }))
    .then((r) => r.json()).then((d) => { if (d && ((d.opened || []).length || (d.closed || []).length)) console.log('live drills', JSON.stringify(d)); return d; })
    .catch((e) => { console.error('live watcher failed', e && e.message); return null; });
  if (ctx && ctx.waitUntil) ctx.waitUntil(run);
  return run;
}
