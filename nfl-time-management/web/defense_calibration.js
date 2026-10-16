// The full defense, checked against real NFL plays (a posterior predictive check): thousands of real plays, drawn as
// they happened (every charted play alike: as many third-and-longs and goal-line snaps as the NFL has), each with its
// twin from the game: a play of the same call, in the same situation, against the defense the
// real one met (its pass rush, coverage, box, defensive backs; engine.js sampleVsDefense), gaining at most the goal
// line from the real play's yard line. The two sets must agree, level by level, within what chance allows (a few
// standard errors of the gap, never tighter than a small practical floor): pressure, sacks, time to throw,
// completions, yards, big plays, picks and worth by pass rushers and by coverage; yards a carry, stuffs, long runs and
// worth by men in the box and by defensive backs; the flags as often as in the situation. And the draws must honor the call: a 6-man rush
// is a play against six rushers, and more rushers mean more pressure, more sacks and the ball out sooner.
//   node web/defense_calibration.js [N] [seed]
const fs = require('fs'), path = require('path'), assert = require('assert');
const E = require('./engine.js'), V = require('./vs_core.js');
const W = __dirname, N = +(process.argv[2] || 30000), SEED = +(process.argv[3] || 5);
const eng = new E(JSON.parse(fs.readFileSync(path.join(W, 'engine_data.json'))));
eng.loadPlaybook(JSON.parse(fs.readFileSync(path.join(W, 'playbook.json'))));
const pool = JSON.parse(fs.readFileSync(path.join(W, 'teams.json')));
const sim = eng.simulator(eng.makeContext(V.buildGame(pool, 'KC', 'BUF'), { receive2h: 'KC' }));
const H = E.helpers, P = eng.pb, Ng = P.ngs, R = V.rng(SEED);
assert.ok(P.dcEff, 'the playbook carries the defense effects (playbook.py dc_effects)');
// each real play's call, situation and yard line (playbook.py writes them for the checks)
const T = JSON.parse(fs.readFileSync(path.join(W, 'playbook_test.json')));
const arr = (k, A) => new A(new Uint8Array(Buffer.from(T[k].b64, 'base64')).buffer);
const YL = arr('yl', Uint8Array), CALL = arr('call', Uint8Array), FINE = arr('fine', Uint16Array);
assert.strictEqual(YL.length, P.yards.length, 'playbook_test.json matches playbook.json');
// the plays as they were: the game's draws weighed as the real plays are (no team, no call-intent tilt), so a gap
// is the defense's handling alone
const shift = P.shift;
P.shift = null;
sim.pbCdf[0] = eng.pbTilt(null);
P.shift = shift;
const DB_EV = new Set(['sack', 'strip_sack', 'sack_fumble', 'scramble', 'throwaway', 'interception', 'pick_six', 'near_pick', 'drop']);
const evOf = (r) => P.eventNames[P.event[r]] || '';
const isDrop = (r) => P.air[r] !== -128 || (P.flags[r] & 4) !== 0 || DB_EV.has(evOf(r));
const SHELL = { 1: 'c0', 2: 'c1', 3: 'c2', 4: '2man', 5: 'c3', 6: 'c4', 7: 'c6', 8: 'c3', 9: 'prevent' };
const lvl = (x, L) => Object.keys(L).find((k) => x >= L[k][0] && x <= L[k][1]);
// a real play's defense, as a call (null: not fully charted)
function dcOf(r) {
  const box = P.look[r] >> 4, db = Ng.dpers[r], n = Ng.rush[r] & 15, sh = Ng.cover[r] & 15;
  if (!box || !db || !lvl(db, H.DC.pers) || !lvl(box, H.DC.front)) return null;
  const dc = { pers: lvl(db, H.DC.pers), front: lvl(box, H.DC.front), cover: SHELL[sh] || 'c3', rush: 4 };
  // a dropback's pass rush and coverage from the seasons charted in full (playbook.py _charted_in_full)
  if (isDrop(r)) { if (!(Ng.rush[r] & 64) || !lvl(n, H.DC.rush) || !SHELL[sh]) return null; dc.rush = +lvl(n, H.DC.rush); }
  else dc.rush = ((P.look[r] >> 3) & 1) ? 5 : 4;
  return dc;
}
// the real plays to check: every play without a flag whose defense was charted (a dropback's rush and coverage in
// the seasons charted in full, a run's box and defensive backs in every season: the plays the game draws from), of a
// call the defense is called against, in a situation the game has a pool for
const cand = [];
for (let r = 0; r < P.yards.length; r++) {
  const id = P.calls[CALL[r]].id;
  if (id === 'hail_mary' || (P.flags[r] & 1) || !dcOf(r)) continue;
  const pl = P.poolOf[CALL[r] * P.nFine + FINE[r]];
  if (P.offsets[pl + 1] - P.offsets[pl] >= 20) cand.push(r);
}
// stats of a play run from yl yards out (its yards at most the goal line); val: its EPA over its own situation's
// (engine.js _dcResid), what the game's draws are leveled on
const X = sim._dcResid();
function stat(r, yl) {
  const ev = evOf(r), f = P.flags[r], sack = /sack/.test(ev), scr = ev === 'scramble', att = !sack && !scr;
  return { sack, att, cmp: att && !(f & 4) && !/interception|pick_six/.test(ev), int: /interception|pick_six/.test(ev),
    press: !!(Ng.rush[r] & 16), ttt: Ng.ttt[r] / 10, yards: Math.min(P.yards[r], yl), val: X[r] };
}
const acc = {};
const add = (key, sr, sg) => {
  const a = (acc[key] = acc[key] || { real: [], game: [] });
  a.real.push(sr); a.game.push(sg);
};
const honor = { rush: [0, 0], cov: [0, 0], mz: [0, 0], box: [0, 0] }, flags = { pool: 0, game: 0, n: 0 };
// the share of a situation's plays (by the pool's weights) that are flags: what the game draws without the defense
const cdf = sim.pbCdf[0].cdf, flagShare = new Map();
const poolFlags = (pl) => {
  if (!flagShare.has(pl)) {
    let w = 0, f = 0;
    for (let i = P.offsets[pl]; i < P.offsets[pl + 1]; i++) { const x = cdf[i] - (i > P.offsets[pl] ? cdf[i - 1] : pl); w += x; if (P.flags[P.items[i]] & 1) f += x; }
    flagShare.set(pl, f / w);
  }
  return flagShare.get(pl);
};
// the share of a pass call's plays without a flag that are dropbacks, by the pool's weights
const dropShare = new Map(), drops = { pool: 0, game: 0, n: 0 };
const poolDrops = (pl) => {
  if (!dropShare.has(pl)) {
    let w = 0, d = 0;
    for (let i = P.offsets[pl]; i < P.offsets[pl + 1]; i++) {
      const r = P.items[i], x = cdf[i] - (i > P.offsets[pl] ? cdf[i - 1] : pl);
      if (P.flags[r] & 1) continue;
      w += x; if (isDrop(r)) d += x;
    }
    dropShare.set(pl, d / w);
  }
  return dropShare.get(pl);
};
const ok = (h, yes) => { h[1]++; if (yes) h[0]++; };
let draws = 0;
for (let k = 0; k < N * 6 && draws < N; k++) {
  const r = cand[Math.floor(R() * cand.length)], c = CALL[r], fk = FINE[r], id = P.calls[c].id, dc = dcOf(r);
  const eff = H.dcEffect(P.dcEff, id, dc);
  const g = sim.sampleVsDefense(0, c, fk, R(), 0, dc, eff.s);
  if (g < 0) continue;
  flags.n++; flags.pool += poolFlags(P.poolOf[c * P.nFine + fk]); flags.game += P.flags[g] & 1;
  if (P.flags[g] & 1) continue;
  draws++;
  const sr = stat(r, YL[r]), sg = stat(g, YL[r]);
  if (isDrop(r) && P.calls[c].kind === 'pass' && !id.startsWith('rpo') && !id.startsWith('trick') && id !== 'screen') {
    // a pass call's plays that are not dropbacks (a handoff, a botched snap) come at the situation's rate (below);
    // the rush and the coverage are about the dropbacks, real and drawn
    drops.n++; drops.pool += poolDrops(P.poolOf[c * P.nFine + fk]); drops.game += isDrop(g) ? 1 : 0;
    if (isDrop(g)) {
      add(`rush ${dc.rush}`, sr, sg);
      add(`cover ${dc.cover}`, sr, sg);
      const n = Ng.rush[g] & 15;
      ok(honor.rush, n >= H.DC.rush[dc.rush][0] && n <= H.DC.rush[dc.rush][1]);
      ok(honor.cov, H.DC.cover[dc.cover].includes(Ng.cover[g] & 15));
      ok(honor.mz, ((Ng.cover[g] >> 4) & 3) === (['c0', 'c1', '2man'].includes(dc.cover) ? 1 : 2));
    }
  }
  if (!isDrop(r) && id.startsWith('rb_')) {
    add(`box ${dc.front}`, sr, sg);
    add(`dbs ${dc.pers}`, sr, sg);
    const b = P.look[g] >> 4;
    ok(honor.box, b >= H.DC.front[dc.front][0] && b <= H.DC.front[dc.front][1]);
  }
}
// a measure: its value on a set of plays and the variance of one play's contribution (for the standard error)
const M = {
  press: [(x) => x.press, null], sack: [(x) => x.sack, null], ttt: [(x) => x.ttt, (x) => x.ttt > 0], cmp: [(x) => x.cmp, (x) => x.att],
  ypa: [(x) => x.yards, (x) => x.att], expl: [(x) => x.yards >= 20, null], int: [(x) => x.int, null], val: [(x) => x.val, null],
  ypc: [(x) => x.yards, null], stuff: [(x) => x.yards <= 0, null], long: [(x) => x.yards >= 10, null],
};
const PASS = ['press', 'sack', 'ttt', 'cmp', 'ypa', 'expl', 'int', 'val'], RUN = ['ypc', 'stuff', 'long', 'val'];
const SCALE = { press: 100, sack: 100, cmp: 100, expl: 100, int: 100, stuff: 100, long: 100 };
function measure(xs, k) {
  const [f, keep] = M[k], ys = (keep ? xs.filter(keep) : xs).map((x) => +f(x));
  const n = ys.length, m = ys.reduce((a, y) => a + y, 0) / Math.max(n, 1);
  const v = ys.reduce((a, y) => a + (y - m) * (y - m), 0) / Math.max(n - 1, 1);
  return { n, m: m * (SCALE[k] || 1), se2: (v / Math.max(n, 1)) * (SCALE[k] || 1) ** 2 };
}
// the gap allowed: Z standard errors of the difference (real and game each a sample), never under the floor (a gap
// that small would not change how the game plays)
const Z = 3.5;
const FLOOR = { press: [1.5, 'pts'], sack: [0.8, 'pts'], ttt: [0.05, 's'], cmp: [1.5, 'pts'], ypa: [0.25, 'yds'], expl: [0.8, 'pts'], int: [0.5, 'pts'], val: [0.02, 'EPA'], ypc: [0.15, 'yds'], stuff: [1.5, 'pts'], long: [1, 'pts'] };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(Math.abs(x) >= 10 ? 1 : Math.abs(x) < 1 ? 3 : 2) : '-');
const report = {}, problems = [];
for (const key of Object.keys(acc).sort()) {
  const a = acc[key], ks = key.startsWith('box') || key.startsWith('dbs') ? RUN : PASS;
  report[key] = {};
  const cols = [];
  for (const k of ks) {
    const re = measure(a.real, k), ga = measure(a.game, k);
    report[key][k] = { real: re.m, game: ga.m };
    const tol = Math.max(FLOOR[k][0], Z * Math.sqrt(re.se2 + ga.se2)), d = ga.m - re.m;
    const bad = re.n >= 100 && Math.abs(d) > tol;
    cols.push(`${k} ${f1(re.m)}/${f1(ga.m)}${bad ? '!' : ''}`);
    if (bad) problems.push(`${key} ${k}: real ${f1(re.m)}, game ${f1(ga.m)} (off by ${f1(Math.abs(d))} ${FLOOR[k][1]}, allowed ${f1(tol)})`);
  }
  console.log(key.padEnd(13), `n ${String(a.real.length).padStart(5)}  ${cols.join('  ')}`);
}
const pct = (h) => (100 * h[0] / Math.max(h[1], 1));
console.log(`draws ${draws}; the call honored: pass rush ${pct(honor.rush).toFixed(1)}%, man or zone ${pct(honor.mz).toFixed(1)}%, ` +
  `shell ${pct(honor.cov).toFixed(1)}%, box ${pct(honor.box).toFixed(1)}%`);
// the plays the defense's call is not about (the flags) keep the situation's rate: a rare call must not draw more
const fp = 100 * flags.pool / flags.n, fg = 100 * flags.game / flags.n, fse = Math.sqrt(fp * (100 - fp) / flags.n);
console.log(`flags: the situations' ${fp.toFixed(2)}%, against the defense's calls ${fg.toFixed(2)}%`);
if (Math.abs(fp - fg) > Math.max(0.3, Z * fse)) problems.push(`flag rate: the situations' ${fp.toFixed(2)}%, against the calls ${fg.toFixed(2)}%`);
const dp = 100 * drops.pool / drops.n, dg = 100 * drops.game / drops.n, dse = Math.sqrt(dp * (100 - dp) / drops.n);
console.log(`a pass call's dropbacks: the situations' ${dp.toFixed(2)}%, against the defense's calls ${dg.toFixed(2)}%`);
if (Math.abs(dp - dg) > Math.max(0.3, Z * dse)) problems.push(`dropback share: the situations' ${dp.toFixed(2)}%, against the calls ${dg.toFixed(2)}%`);
// the defense's call must do what it says: more rushers, more pressure and sacks, the ball out sooner
const rr = (n) => report[`rush ${n}`];
assert.ok(rr(3).press.game < rr(4).press.game && rr(4).press.game < rr(5).press.game && rr(5).press.game < rr(6).press.game, 'pressure climbs with the rush');
assert.ok(rr(3).ttt.game > rr(4).ttt.game && rr(4).ttt.game > rr(5).ttt.game && rr(5).ttt.game > rr(6).ttt.game, 'the ball comes out sooner against more rushers');
assert.ok(rr(3).sack.game < rr(6).sack.game, 'more sacks against more rushers');
assert.ok(pct(honor.rush) >= 99, `the called pass rush is the rush the play met (${pct(honor.rush).toFixed(1)}%)`);
assert.ok(pct(honor.mz) >= 97, `the called man or zone is the coverage the play met (${pct(honor.mz).toFixed(1)}%)`);
assert.ok(pct(honor.box) >= 99, `the called box is the box the run met (${pct(honor.box).toFixed(1)}%)`);
if (problems.length) { console.log(problems.join('\n')); assert.fail(`${problems.length} measures off the real plays`); }
console.log('defense calibration ok');
