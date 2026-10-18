// NFL golden: every rollout's value (sim.run, as Float64 bytes) and every snap's state and log (sim.step) from a fixed
// set of cases, captured once on a base commit and checked after a change: NFL results must stay bit for bit the same.
//   node web/golden_capture.js                    capture -> artifacts/golden_js.json (generated, never committed)
//   node web/golden_capture.js --check [--rules nfl]   the same cases again (with rules: 'nfl' named outright); any
//                                                 difference fails
// Covers the clock-management engine (scripts/parity_exact.py's roots x every root action, coach-mode 4th downs), the
// daily game's run paths (calls, looks, the full defensive call, special teams, kicks, tries) and whole games, overtimes
// and end-of-half spots played snap by snap with the playbook loaded.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const W = __dirname, E = require(path.join(W, 'engine.js'));
const OUT = path.join(W, '..', 'artifacts', 'golden_js.json');
const CHECK = process.argv.includes('--check');
const ri = process.argv.indexOf('--rules'), RULES = ri > 0 ? process.argv[ri + 1] : null;
const ctxOpts = (o) => (RULES ? { ...o, rules: RULES } : o);
const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(path.join(W, 'engine_data.json'), 'utf8'));
const pbData = JSON.parse(fs.readFileSync(path.join(W, 'playbook.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(W, 'game.json'), 'utf8'));
const game = JSON.parse(fs.readFileSync(path.join(W, '2026_05_BUF_LA.json'), 'utf8'));
const TEAMS = {};
fs.readdirSync(path.join(W, 'spots')).forEach((f) => Object.assign(TEAMS, JSON.parse(fs.readFileSync(path.join(W, 'spots', f), 'utf8'))));
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// exact numbers: -0, NaN and the infinities kept apart from 0 and null
const exact = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? `#${Object.is(v, -0) ? '-0' : v}` : v));
const hex = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// scripts/parity_exact.py rand_roots: the same spread of roots (its own generator), and the same actions
const ACTS = [{}, { to_def: true }, { to_off: true }, { tempo: 'urgent', to_off: false }, { play: 'spike' }, { play: 'go' },
  { play: 'fg' }, { play: 'punt' }, { play: 'kneel' }, { play: 'run' }, { play: 'pass' }, { runoff: 20.0 }, { h1: 'attack' }, { h1: 'runout' }];
function randRoot(R) {
  const h2 = R() < 0.75, int = (a, b) => a + Math.floor(R() * (b - a));
  const t = h2 ? (R() < 0.5 ? 1 + R() * 199 : 1 + R() * 899) : 1800 + 1 + R() * 199;
  const r8 = int(0, 10), phase = r8 < 8 ? 0 : r8 === 8 ? 1 : 2;
  const down = int(1, 5), yl = int(1, 100), ytg = Math.min(yl, int(1, 16)), a = int(0, 35), h = Math.max(a + int(-10, 11), 0);
  return { t: Math.round(t * 10) / 10, pos: int(0, 2), score: [h, a], down, ytg, yl, to: [int(0, 4), int(0, 4)], clock_running: R() < 0.6, phase };
}
// late, close states the rules differ on: a first down inside 2:00, a play at the sideline, the last seconds (a foul
// at 0:00), a field goal from far out, a try, a kickoff
function lateRoot(R) {
  const int = (a, b) => a + Math.floor(R() * (b - a)), h1 = R() < 0.3;
  const t = (h1 ? 1800 : 0) + [R() * 130, R() * 12, R() * 65, 115 + R() * 15][int(0, 4)];
  const yl = int(1, 100), down = int(1, 5), a = int(10, 30);
  return { t: Math.round(t * 10) / 10, pos: int(0, 2), score: [a + int(-8, 9), a], down, ytg: Math.min(yl, [1, 2, 3, 5, 10][int(0, 5)]), yl,
    to: [int(0, 4), int(0, 4)], clock_running: R() < 0.7, phase: R() < 0.1 ? 1 : R() < 0.1 ? 2 : 0 };
}
const DC_FULL = (k) => ({ pers: ['heavy', 'base', 'nickel', 'dime'][k % 4], front: ['light', 'even', 'loaded'][(k >> 2) % 3],
  cover: ['c0', 'c1', '2man', 'c2', 'c3', 'c4', 'c6', 'prevent'][(k >> 1) % 8], rush: [3, 4, 5, 6][(k >> 3) % 4] });
const PICKS = [['WR', 'slant', 'quick_strong'], ['WR', 'go', 'deep_weak'], ['TE', 'flat', 'quick_strong'], ['RB', 'screen', 'screen'], ['WR', 'out', 'pa_short']];
// a daily-game action for a phase (the shapes game.js sends: calls with a look or a route, clock calls, the defense's
// call, special teams, kicks and tries)
function dailyAct(R, calls, phase, mine) {
  const int = (a, b) => a + Math.floor(R() * (b - a));
  if (phase === 1) return { pat: R() < 0.5 ? 'xp' : 'two', ...(R() < 0.5 ? { call: calls[int(0, calls.length)].id } : {}) };
  if (phase === 2) return { kick: ['return', 'touchback', 'onside', 'deep'][int(0, 4)] };
  if (!mine) {
    const k = int(0, 4);
    return k === 0 ? { to_def: R() < 0.3, def: ['blitz', 'load', 'soft'][int(0, 3)] } : k === 1 ? { to_def: R() < 0.3, dc: DC_FULL(int(0, 64)), read: R() < 0.5 }
      : k === 2 ? { to_def: false, st: ['block', 'safe', 'rush', 'return'][int(0, 4)] } : { to_def: R() < 0.5 };
  }
  const k = int(0, 10), c = calls[int(0, calls.length)];
  const tempo = R() < 0.5 ? ['urgent', 'hurry', 'normal', 'milk'][int(0, 4)] : undefined;
  if (k <= 4) return { to_off: false, play: c.kind, call: c.id, oob: R() < 0.4, looks: R() < 0.5 ? 1 << int(0, 4) : 0, ...(tempo ? { tempo } : {}), ...(R() < 0.3 ? { pers: [11, 12, 21, 13][int(0, 4)] } : {}) };
  if (k === 5) { const [who, route, call] = PICKS[int(0, PICKS.length)]; return { to_off: false, play: 'pass', call, route, who, looks: 0 }; }
  if (k === 6) return { to_off: false, play: c.kind, call: c.id, dc: DC_FULL(int(0, 64)), ...(c.id.startsWith('trick') ? { seen: int(0, 3) } : {}) };
  if (k === 7) return { to_off: true };
  return { to_off: false, play: ['spike', 'kneel', 'fg', 'punt', 'go'][int(0, 5)], ...(tempo ? { tempo } : {}), ...(R() < 0.2 ? { runoff: Math.round(R() * 400) / 10 } : {}) };
}
const scenOf = (sp) => {
  const T = TEAMS[idx.spots.indexOf(sp)], H = T.home, A = T.away;
  return { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
    league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real.season };
};
const rootOf = (sp) => {
  const st = sp.start;
  return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sp.home ? 0 : 1, score: [st.score[1], st.score[0]],
    down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]], clock_running: st.running, phase: 0, credit: 0, free_kick: false };
};

const got = { run: [], step: [] };
// (1) the clock-management engine (no playbook): parity_exact's game and roots, every action at every snap root
const core = new E(data);
const simA = core.simulator(core.makeContext(game, ctxOpts({ receive2h: game.home.team })));
const simC = core.simulator(core.makeContext(game, ctxOpts({ receive2h: game.home.team, coachMode: { BUF: 'coach', LA: 'typical' } })));
{
  const R = rng(20261018);
  for (let i = 0; i < 400; i++) {
    const root = i < 300 ? randRoot(R) : lateRoot(R);
    const acts = root.phase === 1 ? [{ pat: 'xp' }, { pat: 'two' }, {}] : root.phase === 2 ? [{}, { kick: 'onside' }, { kick: 'deep' }] : ACTS;
    acts.forEach((action, j) => got.run.push({ k: `A${i}.${j}`, sim: i % 5 === 4 ? 'C' : 'A', root, action, perspective: (i + j) % 2, n: 40, seed: 5 + j }));
  }
}
// (2) the daily game's runs (the playbook loaded, a spot's two teams): the options game.js grades
const daily = new E(data);
daily.loadPlaybook(pbData);
const calls = daily.pb.calls;
const dailySims = new Map();
const simD = (si) => {
  if (!dailySims.has(si)) {
    const sp = idx.spots[si];
    dailySims.set(si, daily.simulator(daily.makeContext(scenOf(sp), ctxOpts({ receive2h: sp.start.receive2h }))));
    if (dailySims.size > 6) dailySims.delete(dailySims.keys().next().value);
  }
  return dailySims.get(si);
};
{
  const R = rng(7);
  for (let i = 0; i < 300; i++) {
    const si = (i * 37) % idx.spots.length, root = i % 3 ? lateRoot(R) : randRoot(R);
    const mine = R() < 0.7;
    got.run.push({ k: `D${i}`, sim: `D${si}`, root, action: dailyAct(R, calls, root.phase, mine), perspective: i % 2, n: 24, seed: 11 + i });
  }
}
// (3) snap by snap: whole games from every third spot (our calls random, theirs the engine's), overtimes, and single
// steps from random and late roots with every kind of action
function play(si, start, R, maxN, tag) {
  const sim = simD(si), me = start.pos;
  let cur = start;
  for (let n = 0; n < maxN; n++) {
    const action = dailyAct(R, calls, cur.phase, cur.phase === 0 ? cur.pos === me : cur.pos === me);
    const seed = Math.floor(R() * 4294967296) >>> 0;
    got.step.push({ k: `${tag}.${n}`, sim: `D${si}`, root: cur, action, seed });
    const r = sim.step(cur, { action, seed });
    if (r.done) break;
    cur = r.root;
  }
}
{
  const R = rng(99);
  idx.spots.forEach((sp, si) => { if (si % 3 === 0) play(si, rootOf(sp), R, 120, `G${si}`); });
  idx.spots.forEach((sp, si) => {
    if (si % 12) return;
    const po = sp.real && ['WC', 'DIV', 'CON', 'SB'].includes(sp.real.type), tie = Math.max(...sp.start.score);
    const ot = { t: po ? 900 : 600, pos: si % 24 ? 0 : 1, score: [tie, tie], down: 1, ytg: 10, yl: 65, to: po ? [3, 3] : [2, 2], clock_running: false,
      phase: 2, credit: 0, free_kick: false, ot: { c: [0, 0], po, n: 1, ...(si % 36 === 0 ? { r: 'msd' } : {}) } };
    play(si, ot, R, 120, `O${si}`);
  });
  for (let i = 0; i < 1500; i++) {
    const si = (i * 53) % idx.spots.length, root = i % 2 ? lateRoot(R) : randRoot(R);
    if (R() < 0.15) { root.credit = Math.round(R() * 80) / 10; }
    if (root.phase === 2 && R() < 0.2) root.free_kick = true;
    const action = dailyAct(R, calls, root.phase, R() < 0.6);
    got.step.push({ k: `S${i}`, sim: `D${si}`, root, action, seed: (i * 2654435761) >>> 0 });
  }
}

// run every case: runs as Float64 bytes, steps as their exact JSON
const simOf = (s) => (s === 'A' ? simA : s === 'C' ? simC : simD(+s.slice(1)));
const res = { run: {}, step: {} };
if (!CHECK) {
  for (const c of got.run) res.run[c.k] = hex(simOf(c.sim).run(c.root, { n: c.n, action: c.action, perspective: c.perspective, seed: c.seed }).values);
  for (const c of got.step) res.step[c.k] = exact(simOf(c.sim).step(c.root, { action: c.action, seed: c.seed }));
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const nRuns = got.run.length, nSteps = got.step.length;
if (!CHECK) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ cases: got, res, digest: sha(JSON.stringify(res)) }));
  console.log(`captured ${nRuns} runs, ${nSteps} steps in ${secs} s: ${sha(JSON.stringify(res)).slice(0, 16)} -> ${OUT}`);
} else {
  const base = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  // the cases are the capture's own (a change to this file's generators never moves the base)
  const resB = { run: {}, step: {} };
  for (const c of base.cases.run) resB.run[c.k] = hex(simOf(c.sim).run(c.root, { n: c.n, action: c.action, perspective: c.perspective, seed: c.seed }).values);
  for (const c of base.cases.step) resB.step[c.k] = exact(simOf(c.sim).step(c.root, { action: c.action, seed: c.seed }));
  let bad = 0;
  for (const part of ['run', 'step']) for (const [k, v] of Object.entries(base.res[part])) {
    if (resB[part][k] === v) continue;
    bad++;
    if (bad <= 10) {
      const c = base.cases[part].find((x) => x.k === k);
      console.log(`DIFF ${part} ${k} ${JSON.stringify(c.root)} ${JSON.stringify(c.action)}`);
      if (part === 'step') console.log(`   was ${v.slice(0, 400)}\n   now ${resB[part][k].slice(0, 400)}`);
    }
  }
  const nB = Object.keys(base.res.run).length + Object.keys(base.res.step).length;
  console.log(`${bad} of ${nB} golden results differ (${Object.keys(base.res.run).length} runs, ${Object.keys(base.res.step).length} steps${RULES ? `, rules ${RULES}` : ''}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(bad ? 1 : 0);
}
