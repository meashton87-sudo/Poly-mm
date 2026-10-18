// Rules sweep: the college and high-school rulebooks (engine.js RULE_BOOK) played on the NFL data, snap by snap, from
// every spot's two teams and from late states built to hit each rule, checking the rule on every snap it applies to:
//   - a first down (in bounds, no flag) inside the rules' window keeps the clock running with the first-down credit
//   - out of bounds inside the window stops the clock till the snap (high school: all game)
//   - no two-minute stoppage without one (tmw null), and never a crossing of it
//   - a touchback starts the receivers at the rules' spot (the 25, the 20)
//   - a missed field goal: the previous spot (college, the 20 at most), a touchback at the 20 (high school)
//   - a kicked try is fgProb(patKick) and the extra-point shift; a two-point call needs twoYl yards
//   - no half ends on an accepted foul by either team (an untimed down), unless a 10-second runoff ran it out
//   - a 10-second runoff only after the Two-Minute Timeout, on a foul before the snap with the clock running, for an
//     offended team ahead (or the defense, tied), never when the fouler had a timeout to spend
//   - a state's running clock: only a score stops it
//   - overtime (web/vs_core.js opt): each format's spot, two-point yard lines and timeouts, always a winner
// Each check must have been met a fair number of times.   node web/rules_sweep.js [games per spot, default 1]
const fs = require('fs'), path = require('path');
const W = __dirname, E = require(path.join(W, 'engine.js'));
const eng = new E(JSON.parse(fs.readFileSync(path.join(W, 'engine_data.json'), 'utf8')));
eng.loadPlaybook(JSON.parse(fs.readFileSync(path.join(W, 'playbook.json'), 'utf8')));
const idx = JSON.parse(fs.readFileSync(path.join(W, 'game.json'), 'utf8'));
const TEAMS = {};
fs.readdirSync(path.join(W, 'spots')).forEach((f) => Object.assign(TEAMS, JSON.parse(fs.readFileSync(path.join(W, 'spots', f), 'utf8'))));
const GAMES = +(process.argv[2] || 1);
const P = eng.pb, calls = P.calls, { uni } = E.helpers;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const bad = {}, seen = {};
const flag = (k, msg) => { bad[k] = bad[k] || []; if (bad[k].length < 5) bad[k].push(msg); bad[k].n = (bad[k].n || 0) + 1; };
const count = (k) => { seen[k] = (seen[k] || 0) + 1; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const scenOf = (sp) => {
  const T = TEAMS[idx.spots.indexOf(sp)], H = T.home, A = T.away;
  return { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp, league: sp.league || idx.league,
    home_coach: H.coach, away_coach: A.coach, season: sp.real.season };
};

function act(R, cur, mine, k) {
  const c = calls[k % calls.length];
  if (cur.phase === 1) return k % 2 ? { pat: 'xp' } : { pat: 'two', ...(k % 4 ? { call: c.kind === 'pass' ? c.id : 'quick_strong' } : {}) };
  if (cur.phase === 2) return { kick: ['return', 'touchback', 'onside', 'deep'][k % 4] };
  if (!mine) return k % 3 ? { to_def: k % 7 === 0 } : { to_def: false, dc: { pers: 'nickel', front: 'even', cover: ['c1', 'c3', 'c2'][k % 3], rush: 4 } };
  const j = k % 9;
  if (j === 0 && cur.down === 4) return { to_off: false, play: 'fg' };
  if (j === 1 && cur.clock_running) return { to_off: true };
  if (j === 2 && cur.down <= 3) return { to_off: false, play: 'spike' };
  if (j === 3) return {};
  return { to_off: false, play: c.kind, call: c.id, oob: k % 3 === 0, ...(cur.clock_running ? { tempo: ['urgent', 'hurry', 'normal', 'milk'][k % 4] } : {}) };
}

// a state's running clock on for this snap (engine.js _rc, read without changing anything)
const rcOn = (R, st, g) => !!R.runClock && ((R.runClock.sticky && !!st.running_clock) ||
  (Math.abs(st.score[0] - st.score[1]) >= R.runClock.margin && st.t <= R.runClock.from * R.quarter && st.t > g.halfEnd));
function check(name, sim, before, action, r, seed) {
  const R = sim.R, g = sim._geom(before), b = r.root, half0 = g.halfEnd, tag = `${name} ${JSON.stringify(before)} ${JSON.stringify(action)}`;
  const rc = rcOn(R, before, g);
  if (!(b.t <= before.t + 1e-9)) flag('clock went up', tag);
  const ro = r.log.find((e) => e.ev === 'runoff');
  if (ro && ro.stop === '2mw') { if (R.tmw == null) flag('a two-minute stoppage without one', tag); else count('two-minute stoppage'); }
  if (R.tmw != null && before.t > g.tmw && b.t < g.tmw - 1e-9 && !r.log.some((e) => e.ev === 'runoff' && e.stop === '2mw') &&
    !r.log.some((e) => e.ev === 'play' || e.ev === 'fg' || e.ev === 'punt' || e.ev === 'kickoff')) flag('ran through the two-minute stoppage', tag);
  for (const e of r.log) {
    // a touchback (the data's, or one kicked through on purpose) starts where the rules say; none at the data's spot
    if (e.ev === 'kickoff' && !e.onside && !before.free_kick && (action.kick === 'touchback' || (e.tb && e.yl === R.koTouchback))) {
      count('touchback'); if (e.yl !== R.koTouchback) flag('touchback not at the rules\' spot', `${tag} ${e.yl}`);
    }
    if (e.ev === 'kickoff' && e.tb && !before.free_kick && R.koTouchback !== eng.koTb && e.yl === eng.koTb) flag('a touchback at the data\'s spot', tag);
    if (e.ev === 'fg' && !e.made && !e.blocked && !e.foul) {
      count('missed field goal');
      const want = R.fgMissTb != null ? R.fgMissTb : 100 - Math.max(before.yl + R.fgMissBack, 20);
      if (!r.done && b.phase === 0 && b.yl !== want) flag('missed field goal spot', `${tag} yl ${b.yl} want ${want}`);
    }
    if (e.ev === 'pat' && !e.two) {
      count('kicked try');
      const pk = Math.min(Math.max(sim.fgProb(R.patKick, e.team), 1e-9), 1 - 1e-9), p = sigmoid(Math.log(pk / (1 - pk)) + eng.xpLogit);
      if (e.good !== (uni(seed >>> 0, 0, 0, 3) < p)) flag('kicked try not fgProb(patKick)', tag);
    }
    if (e.ev === 'pat' && e.two && e.row >= 0) {
      count('two-point call');
      const f = P.flags[e.row];
      if (!(f & 1) && e.good !== (!(f & 64) && !(f & 4) && ((f & 16) !== 0 || P.yards[e.row] >= R.twoYl))) flag('two-point call not to the rules\' yard line', tag);
    }
    if (e.ev !== 'play') continue;
    const change = e.turnover || e.onDowns, score = e.td || e.tdDef || e.safety, left = e.t - half0;
    const crossQ = before.t > g.qEnd && e.t <= g.qEnd, crossT = before.t > g.tmw && e.t <= g.tmw, over = b.t <= half0 || r.done;
    // first downs
    const fdWant = !!R.fdStop && e.fd && !e.oob && !e.penalty && !change && !score && left <= R.fdStop.window && !rc;
    if (fdWant !== !!e.fdStop) flag('first-down stop where the rules say otherwise', `${tag} ${JSON.stringify(e)}`);
    if (e.fdStop && !over && !crossQ && !crossT && !e.runoff10) {
      count('first-down stop');
      if (!(b.clock_running && b.credit === sim.fdCredit)) flag('first down did not leave the clock running with the credit', `${tag} ${JSON.stringify(b)}`);
    }
    // out of bounds
    if (e.oob && !change && !score && !over && !rc) {
      if (left <= g.oobWindow) { count('out of bounds, stopped'); if (b.clock_running) flag('out of bounds did not stop the clock', tag); }
      else if (!crossQ && !crossT && !e.penalty) { count('out of bounds, ready-for-play'); if (!b.clock_running) flag('out of bounds outside the window stopped the clock', tag); }
    }
    // the last play of a half: an accepted foul never ends it (an untimed down), unless a runoff ran the clock out
    if (e.penalty && !change && !score && !e.runoff10 && (R.untimed === 'any' || e.yards > 0) && before.t - e.dur <= half0 + 1e-9 && before.t > half0) {
      count('untimed down');
      if (r.done || b.t <= half0) flag('a half ended on an accepted foul', tag);
    }
    // the 10-second runoff
    if (e.runoff10) {
      count('10-second runoff');
      if (!R.runoff10) flag('a runoff without the rule', tag);
      else if (!(e.penalty && e.dur === 0 && before.clock_running && before.t - half0 <= R.runoff10.window)) flag('a runoff outside the rule', `${tag} ${JSON.stringify(e)}`);
      const fouler = e.yards < 0 ? e.team : 1 - e.team, offM = before.score[1 - fouler] - before.score[fouler];
      if (before.to[fouler] > 0) flag('a runoff the fouler had a timeout for', tag);
      if (!(offM > 0 || (offM === 0 && fouler === e.team))) flag('a runoff the offended team would not take', tag);
      const snapT = (r.log.find((x) => x.ev === 'runoff') || { t: before.t }).t;     // the play's own clock: none (a foul before the snap)
      if (Math.abs(b.t - Math.max(snapT - 10, half0)) > 1e-9) flag('a runoff not of 10 seconds', `${tag} ${snapT} -> ${b.t}`);
      if (b.t > half0 && !b.clock_running) flag('after a runoff the clock did not start on the ready', tag);
    } else if (R.runoff10 && e.penalty && e.dur === 0 && !change && !score && before.clock_running && !over && e.t - half0 <= R.runoff10.window &&
      !r.log.some((x) => x.ev === 'timeout' && x.why !== 'runoff') && !(before.t > g.tmw && e.t <= g.tmw) && !(before.t > g.qEnd && e.t <= g.qEnd)) {
      count('runoff declined or kept'); if (b.clock_running) flag('no runoff, yet the clock did not start on the snap', `${tag} ${JSON.stringify(e)}`);
    }
    if (r.log.some((x) => x.ev === 'timeout' && x.why === 'runoff')) count('timeout to stop a runoff');
    // a state's running clock: nothing but a score stops it
    if (R.runClock && (b.running_clock || Math.abs(b.score[0] - b.score[1]) >= R.runClock.margin) && b.t <= R.runClock.from * R.quarter && !score && !over && !crossQ && b.phase === 0) {
      count('running clock'); if (!b.clock_running) flag('the running clock stopped', `${tag} ${JSON.stringify(e)}`);
    }
  }
}

const RULESETS = ['ncaa2026', 'nfhs', 'ncaa2022', 'uil2026', 'nfhs:PA', 'nfhs:GA', 'nfhs:OH', 'nfhs25'];
const t0 = Date.now();
let steps = 0;
for (const name of RULESETS) {
  const R = E.rulesOf(name), scale = R.quarter / 900, R2 = rng(name.length * 7919 + 13);
  const sims = new Map();
  const simOf = (si) => {
    if (!sims.has(si)) { const sp = idx.spots[si]; sims.set(si, eng.simulator(eng.makeContext(scenOf(sp), { receive2h: sp.start.receive2h, rules: name }))); }
    if (sims.size > 8) sims.delete(sims.keys().next().value);
    return sims.get(si);
  };
  const stepOne = (si, cur, action) => {
    const sim = simOf(si), seed = Math.floor(R2() * 4294967296) >>> 0, before = JSON.parse(JSON.stringify(cur));
    const r = sim.step(cur, { action, seed });
    steps++; check(name, sim, before, action, r, seed);
    return r;
  };
  const full = name === 'ncaa2026' || name === 'nfhs';
  // (1) whole drives from the spots (every one for the two main rulebooks), the clock in the rules' quarters
  idx.spots.forEach((sp, si) => {
    if (si % (full ? 3 : 12)) return;
    for (let gm = 0; gm < GAMES; gm++) {
      const st = sp.start;
      let cur = { t: Math.round(((st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock) * scale) * 10) / 10, pos: st.pos === sp.home ? 0 : 1,
        score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]],
        clock_running: st.running, phase: 0, credit: 0, free_kick: false };
      if (R.runClock && si % 3 === 0) { cur.score = [cur.score[0] + R.runClock.margin + 1, cur.score[1]]; cur.t = Math.min(cur.t, R.quarter * R.runClock.from); }
      const me = cur.pos;
      for (let n = 0; n < 200; n++) {
        const r = stepOne(si, cur, act(R, cur, cur.pos === me, si * 31 + gm * 7 + n));
        if (r.done) break;
        cur = r.root;
      }
    }
  });
  // (2) late states: the last two minutes, the last seconds, long kicks, tries at 0:00, kickoffs, blowouts
  for (let i = 0; i < (full ? 6000 : 1500); i++) {
    const si = [0, 101, 202, 303][i % 4], H = 2 * R.quarter, h1 = i % 3 === 0, k = i % 6;
    const th = [R2() * 130, R2() * 8, R2() * 70, 30 + R2() * 300, R2() * 2, R2() * R.quarter][k];
    const yl = k === 3 ? 18 + Math.floor(R2() * 30) : 1 + Math.floor(R2() * 98), a = 7 + Math.floor(R2() * 25), m = Math.floor(R2() * 17) - 8;
    const phase = k === 4 ? 1 : i % 11 === 0 ? 2 : 0, pos = i % 2;
    const root = { t: Math.round(((h1 ? H : 0) + th) * 10) / 10, pos, score: pos ? [a, a + m] : [a + m, a], down: k === 3 ? 4 : 1 + (i % 3),
      ytg: Math.min(yl, 1 + (i % 4)), yl, to: [i % 4, (i >> 2) % 4], clock_running: i % 4 !== 0, phase, credit: 0, free_kick: false };
    if (R.runClock && k === 5) { root.score[0] += R.runClock.margin + 2; root.running_clock = R.runClock.sticky && i % 2 === 0; }
    stepOne(si, root, k === 3 ? { to_off: false, play: 'fg' } : act(R, root, i % 5 !== 0, i));
  }
  // (3) the 10-second runoff: the clock running after the Two-Minute Timeout, every score, timeouts or none
  if (R.runoff10) {
    for (let i = 0; i < 6000; i++) {
      const si = [0, 101, 202, 303][i % 4], h1 = i % 2 === 0, a = 10 + (i % 17), m = (i % 15) - 7, pos = (i >> 1) % 2, yl = 20 + (i * 37) % 60;
      const root = { t: Math.round(((h1 ? 2 * R.quarter : 0) + 3 + R2() * (R.runoff10.window - 3)) * 10) / 10, pos, score: pos ? [a, a + m] : [a + m, a],
        down: 1 + (i % 3), ytg: Math.min(yl, 10), yl, to: [(i >> 2) % 3, (i >> 3) % 3], clock_running: true, phase: 0, credit: 0, free_kick: false };
      stepOne(si, root, i % 3 ? {} : { to_off: false, play: i % 2 ? 'run' : 'pass' });
    }
  }
}
// (4) overtime formats (web/vs_core.js opt: the rules' two-point yard line and the format, engine.js RULE_BOOK.OT): every
// possession starts at the format's spot, a forced two-point try at the rules' yard line, the alternating periods' plays
// from theirs, each period's timeouts as the format gives them, and every match ends with a winner
const VSCore = require(path.join(W, 'vs_core.js'));
const OTS = [['nfhs', 'kansas10'], ['ncaa2026', 'ncaa'], ['nfhs:GA', 'ga15'], ['nfhs:OR', 'or25'], ['nfhs:LA', 'kansas10carry'], ['ncaa2022', 'ncaa2022']];
let otMatches = 0;
for (const [name, otName] of OTS) {
  const R = E.rulesOf(name), F = E.RULE_BOOK.OT[otName], R3 = rng(otMatches + 99);
  if (R.ot !== otName) flag('a ruleset without its overtime', name);
  const sp = idx.spots[7], sim = eng.simulator(eng.makeContext(scenOf(sp), { receive2h: sp.start.receive2h, rules: name }));
  const opt = { twoYl: R.twoYl, ot: F, regTo: [1, 2] };
  const step = (root, a, seed) => sim.step(root, { action: a, seed });
  for (let m = 0; m < 150; m++) {
    let ms = VSCore.start(m % 2, opt), n = 0, round = 1;
    const tag = `${otName} match ${m}`;
    if (JSON.stringify(ms.root.to) !== JSON.stringify(F.toCarry ? [F.to + 1, F.to + 2] : [F.to, F.to])) flag('overtime timeouts at the start', `${tag} ${ms.root.to}`);
    while (!ms.over && n++ < 200) {
      const r0 = ms.root, alt = F.alt2From != null && ms.cot.round >= F.alt2From;
      if (!ms.cot.pick && r0.phase === 0 && !r0.try2) {
        const want = ms.cot.round >= 3 && F.yl3 != null ? F.yl3 : F.yl;
        if (r0.down === 1 && r0.ytg === Math.min(10, want) && r0.yl !== want && n === 1) flag('a possession not at the format\'s spot', `${tag} ${r0.yl}`);
      }
      if (r0.try2) count(alt ? 'overtime: alternating two-point play' : 'overtime: forced or chosen two');
      if (r0.try2 && alt && r0.yl !== F.altYl) flag('an alternating play not from its yard line', `${tag} ${r0.yl}`);
      const halves = [0, 1].map((s) => {
        const role = VSCore.role(ms, s);
        if (role === 'pick') return { pick: ['offense', 'defense'][R3() < 0.5 ? 0 : 1] };
        if (role === 'pat') return R3() < 0.3 ? { two: true } : { action: { pat: 'xp' } };
        if (role === 'offense') { const c = calls[Math.floor(R3() * calls.length)]; return { action: { call: c.id, play: c.kind } }; }
        return null;
      });
      const prev = ms;
      ms = VSCore.apply(ms, halves, step, Math.floor(R3() * 4294967296), opt).ms;
      if (ms.cot.round > round) {
        round = ms.cot.round;
        const k = F.to, want = round < 3 ? [k, k] : F.toFrom3 === 'none' ? [0, 0] : F.toFrom3 === 'carry' ? (round === 3 ? [k, k] : null) : [k, k];
        if (want && JSON.stringify(ms.root.to) !== JSON.stringify(want)) flag('overtime timeouts for a period', `${tag} round ${round} ${ms.root.to}`);
      }
      // a two chosen at the try, or forced by the format straight from the touchdown: from the rules' yard line
      const p0 = prev.root, td = p0.phase === 0 && ms.root.score[p0.pos] === p0.score[p0.pos] + 6;
      if (!prev.cot.pick && ms.root.try2 && !p0.try2 && (p0.phase === 1 || td)) {
        if (ms.root.yl !== R.twoYl) flag('a two-point try not from the rules\' yard line', `${tag} ${ms.root.yl}`);
        if (td) { count('overtime: forced two'); if (!(F.must2From != null && prev.cot.round >= F.must2From)) flag('a two forced outside the format', tag); }
      }
      if (td && !ms.over && !ms.root.try2 && ms.root.phase !== 1 && F.must2From != null && prev.cot.round >= F.must2From && ms.cot.round === prev.cot.round &&
        !(F.alt2From != null && prev.cot.round >= F.alt2From)) flag('a touchdown the format forces to two went without one', tag);
    }
    if (!ms.over) flag('an overtime that never ended', tag);
    else if (ms.root.score[0] === ms.root.score[1]) flag('an overtime ended tied', tag);
    else count(`overtime ${otName}`);
    otMatches++;
  }
}
// Versus, with no options, as it always was: from the 25, the 3rd overtime's plays from the 3, a forced two from the 2
{
  const v = VSCore.possRoot(0, 1, [0, 0], [1, 1]), v3 = VSCore.possRoot(0, 3, [7, 7], [0, 0]), st = VSCore.start(1);
  if (v.yl !== 25 || v.ytg !== 10 || v3.yl !== 3 || !v3.try2 || JSON.stringify(st.root.to) !== '[1,1]') flag('Versus overtime changed', JSON.stringify([v, v3, st.root]));
}
console.log(`${otMatches} overtimes; ${steps} steps over ${RULESETS.length} rulebooks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log('seen:', JSON.stringify(seen));
const NEED = ['first-down stop', 'out of bounds, stopped', 'out of bounds, ready-for-play', 'touchback', 'missed field goal', 'kicked try',
  'two-point call', 'untimed down', '10-second runoff', 'timeout to stop a runoff', 'runoff declined or kept', 'running clock', 'two-minute stoppage', 'overtime: forced two', 'overtime: alternating two-point play'];
NEED.forEach((k) => { if (!(seen[k] >= 20)) flag('a rule hardly met', `${k}: ${seen[k] || 0}`); });
const keys = Object.keys(bad);
if (!keys.length) console.log('NO VIOLATIONS');
keys.forEach((k) => { console.log(`VIOLATION ${k}: ${bad[k].n}`); bad[k].forEach((x) => console.log('   ', x)); });
if (keys.length) process.exit(1);
