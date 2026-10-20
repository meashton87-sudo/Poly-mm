// The live drills' replay: a recorded game (live_replay.json, made by scripts/live_fixture.py from nflverse
// play-by-play) played back through the real watcher (live.js tick) as the feed would have sent it: each play shows up
// in the feed LAG after it happened (the middle of the 20-60 s the feed runs behind TV), the cron looks once a minute,
// and after each minute this records what a page would read then (GET /live and each drill). worker_test.mjs checks
// the drills it makes; browser_test.py serves its minutes to the page (its stub board) and plays them.
//   node board/live_replay.mjs [lag seconds, default 30]  -> { lag, steps: [{ now, live, drills }], delays }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as FEED from './live_espn.js';
import { tick, Live, LIVE_CLOCK } from './live.js';

export const FIXTURE = JSON.parse(readFileSync(new URL('./live_replay.json', import.meta.url), 'utf8'));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const wallOf = (p) => Date.parse(p.wallclock);

// the feed at time T: the scoreboard and the game's summary as they were, with the plays it had by then
export function feedAt(fx, T, lag = 30e3) {
  const vis = fx.plays.filter((p) => wallOf(p) + lag <= T), last = vis[vis.length - 1], ev = fx.event;
  const sb = last ? last._sb : { period: 1, clock: 900, state: 'pre', homeTimeouts: 3, awayTimeouts: 3 };
  const state = last ? sb.state : 'pre';
  const team = (x) => ({ id: x.id, abbreviation: x.abbreviation });
  const comp = { venue: ev.venue, odds: [{ details: ev.odds }],
    competitors: [{ homeAway: 'home', team: team(ev.home), score: String(last ? last.homeScore : 0) }, { homeAway: 'away', team: team(ev.away), score: String(last ? last.awayScore : 0) }],
    status: { period: sb.period, clock: sb.clock, displayClock: mmss(sb.clock), type: { state } } };
  if (state === 'in') {
    comp.situation = { homeTimeouts: sb.homeTimeouts, awayTimeouts: sb.awayTimeouts,
      ...(sb.possession ? { possession: sb.possession, down: sb.down, distance: sb.distance, downDistanceText: sb.downDistanceText } : { down: -1 }) };
  }
  const board = { events: [{ id: ev.id, date: ev.date, season: ev.season, week: ev.week, competitions: [comp] }] };
  const summary = { header: { id: ev.id }, drives: { previous: [{ plays: vis.map(({ _sb, ...p }) => p) }] } };
  return { board, summary, n: vis.length };
}
// a Durable Object's storage, in memory (as worker_test.mjs keeps the board's)
export function memStorage(store = new Map()) {
  return { store, get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k),
    list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) };
}
// the replay: one step a cron minute from `from` to `to` (default: the fourth quarter's last 6 minutes and the end)
export async function replay(fx = FIXTURE, { lag = 30e3, from, to, env = { LIVE_ON: 'on' }, feed = feedAt } = {}) {
  const storage = memStorage(), obj = new Live({ storage }, env), asked = [];
  const q4 = fx.plays.filter((p) => p.period.number >= 4), T0 = Math.floor((from ?? wallOf(q4[0]) - 120e3) / 60e3) * 60e3, T1 = to ?? wallOf(fx.plays[fx.plays.length - 1]) + lag + 180e3;
  const get = async (url) => {
    asked.push({ at: LIVE_CLOCK.now, url });
    const f = feed(fx, LIVE_CLOCK.now, lag);
    if (url === FEED.BOARD) return f.board;
    if (url === FEED.gameUrl(fx.event.id)) return f.summary;
    throw new Error(`404 ${url}`);
  };
  const read = async (path) => (await obj.fetch(new Request(`https://w.example${path}`))).json();
  const steps = [];
  try {
    for (let T = T0; T <= T1; T += 60e3) {
      LIVE_CLOCK.now = T;
      const res = await tick(env, storage, T, get);
      const live = await read('/live'), drills = {};
      for (const k of [...storage.store.keys()].filter((x) => x.startsWith('d:'))) drills[k.slice(2)] = (await read(`/live/drill?id=${k.slice(2)}`)).drill;
      steps.push({ now: T, tick: res, live, drills });
    }
  } finally { LIVE_CLOCK.now = null; }
  // the delay from a real play to the worker having it (the page's poll adds 0 to 12 s on top)
  const last = steps[steps.length - 1].drills, d = Object.values(last).flatMap((x) => x.snaps.map((s) => s.at - s.wall)).filter(Number.isFinite);
  const delays = d.length ? { n: d.length, min: Math.min(...d) / 1e3, mean: d.reduce((a, x) => a + x, 0) / d.length / 1e3, max: Math.max(...d) / 1e3, page_poll: [0, 12] } : null;
  return { lag: lag / 1e3, steps, delays, asked, storage };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lag = Number(process.argv[2] || 30) * 1e3;
  replay(FIXTURE, { lag }).then(({ steps, delays, asked }) => {
    process.stdout.write(JSON.stringify({ lag: lag / 1e3, steps: steps.map(({ now, live, drills }) => ({ now, live, drills })), delays, requests: asked.length }));
  }).catch((e) => { console.error(e); process.exit(1); });
}
