// Versus defense: what each defensive call does to each offensive call, as engine.js plays it (a play's worth: the
// call's own there plus the defense's effect, dcEffect, from the charted plays; web/defense_calibration.js checks the
// plays themselves against the real ones), in common overtime situations. Real football's defense moves a play's
// worth a little and its shape a lot (pressure, sacks, the ball out sooner, big plays), so this checks the game the
// two sides play is the data's, with no hole in it:
//   - no defensive call does anything absurd to a play (the effects are a few hundredths of a point, as measured)
//   - every option of every part (each personnel group, front, coverage, rush) is the best answer to some call
//     somewhere: none is a trap to leave alone
//   - reading the defense matters: the offense's best call is not the same against every defense everywhere
//   - the zero-sum game solves, and its value is what the offense's best calls are worth there
//   - ranked plays even (vs_core.js evenPool): every team's strength as the engine sees it is the same, so no team is
//     an edge; and a sample of matches with both sides on the engine's own calls splits about 50-50 for every team
//   node board/vs_balance_test.mjs   (needs board/assets/vs)
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import NFLClockEngine from '../web/engine.js';
import VSCore from '../web/vs_core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(process.env.VS_ASSETS || path.join(HERE, 'assets'), 'vs');
if (!fs.existsSync(path.join(A, 'engine_data.pack'))) { console.log('balance: no engine data (board/assets/vs), skipped'); process.exit(0); }
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const data = VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'engine_data.pack')))));
const eng = new NFLClockEngine(data);
eng.loadPlaybook(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'playbook.pack')))), data));
const pool = JSON.parse(fs.readFileSync(path.join(A, 'teams.json'), 'utf8'));
const H = NFLClockEngine.helpers, P = eng.pb;
assert.ok(P.dcEff, 'the playbook carries the defense effects (playbook.py dc_effects)');
const sim = eng.simulator(eng.makeContext(VSCore.buildGame(pool, 'KC', 'BUF'), { receive2h: 'KC' }));
const cdf = sim.pbCdf[0].cdf;
const DCS = [];
for (const pers of VSCore.DC.pers) for (const front of VSCore.DC.front) for (const cover of VSCore.DC.cover) for (const rush of VSCore.DC.rush) DCS.push({ pers, front, cover, rush });
const SIT = [['1st & 10', 1, 10, 25], ['2nd & 6', 2, 6, 21], ['2nd & 4', 2, 4, 30], ['2nd & 2', 2, 2, 17], ['3rd & 2', 3, 2, 17], ['3rd & 8', 3, 8, 23],
  ['3rd & 15', 3, 15, 30], ['goal at 5', 1, 5, 5], ['goal at 2', 3, 2, 2]];
const CALLS = P.calls.map((c, i) => [c.id, i]).filter(([id]) => id !== 'hail_mary');

// the zero-sum game (the offense maximizes): both sides' average strategies by multiplicative weights
function solve(M) {
  const m = M.length, n = M[0].length, eta = 0.5, T = 6000;
  let wx = new Float64Array(m).fill(1), wy = new Float64Array(n).fill(1);
  const ax = new Float64Array(m), ay = new Float64Array(n);
  for (let t = 0; t < T; t++) {
    const sx = wx.reduce((a, b) => a + b, 0), sy = wy.reduce((a, b) => a + b, 0);
    const x = Array.from(wx, (v) => v / sx), y = Array.from(wy, (v) => v / sy);
    x.forEach((v, i) => { ax[i] += v / T; }); y.forEach((v, j) => { ay[j] += v / T; });
    const gx = M.map((row) => row.reduce((a, v, j) => a + v * y[j], 0));
    const gy = M[0].map((_, j) => M.reduce((a, row, i) => a + row[j] * x[i], 0));
    wx = Float64Array.from(wx, (v, i) => v * Math.exp(eta * gx[i]));
    wy = Float64Array.from(wy, (v, j) => v * Math.exp(-eta * gy[j]));
    const mx = Math.max(...wx), my = Math.max(...wy);
    wx = wx.map((v) => v / mx); wy = wy.map((v) => v / my);
  }
  const vx = Math.min(...M[0].map((_, j) => M.reduce((a, row, i) => a + row[j] * ax[i], 0)));   // what the offense mix guarantees
  const vy = Math.max(...M.map((row) => row.reduce((a, v, j) => a + v * ay[j], 0)));              // what the defense mix allows
  return { x: ax, y: ay, lo: vx, hi: vy };
}

// ---- ranked, even: the engine sees every team the same (its deltas, kicker, punter, call ratings); only the style stays
{
  const even = VSCore.evenPool(pool), T = Object.keys(pool.teams).sort();
  const ref = eng.makeContext(VSCore.buildGame(even, T[0], T[1]), { receive2h: T[0] });
  for (const h of T) for (const a of T.slice(0, 6)) {
    if (h === a) continue;
    const c = eng.makeContext(VSCore.buildGame(even, h, a), { receive2h: h });
    assert.deepStrictEqual(c.delta, ref.delta, `${h}-${a}: the same run and pass strength both ways`);
    assert.deepStrictEqual([c.kickerShift, c.punterShift, c.twoPt], [ref.kickerShift, ref.punterShift, ref.twoPt], `${h}-${a}: the same kicker, punter and two-point odds`);
    assert.ok(!c.pbDelta || c.pbDelta.every((row) => row.every((v) => v === 0)), `${h}-${a}: no call ratings`);
  }
  // the real pool is not even (so the check means something)
  const real = eng.makeContext(VSCore.buildGame(pool, 'KC', 'CAR'), { receive2h: 'KC' });
  assert.ok(Math.abs(real.delta[0][1] - real.delta[1][1]) > 0.01, 'as the teams are, Kansas City and Carolina differ');
  // strength, as the pick shows it: 80 the league's average, the best teams in the 90s
  const s = T.map((t) => VSCore.strength(pool, t));
  assert.ok(Math.abs(s.reduce((x, y) => x + y, 0) / s.length - 80) < 1 && Math.max(...s) <= 99 && Math.min(...s) >= 60, `strengths around 80: ${s}`);
  // a sample of even matches (the Five-Minute Drill, the engine's own calls on both sides, the lazy simulator as the
  // room has it): every team about 50-50, home and away alike
  const { lazySimulator } = await import('./lazy_sim.js');
  const R = VSCore.rng(2024), wins = {}, games = {}, N = 24;
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let homeWins = 0, n = 0;
  for (let g = 0; g < N; g++) {
    const order = [...T].sort(() => R() - 0.5);
    for (let i = 0; i < order.length; i += 2) {
      const [h, a] = g % 2 ? [order[i], order[i + 1]] : [order[i + 1], order[i]];
      const step = VSCore.stepper(eng, pool, h, a, lazySimulator, true);
      let ms = VSCore.startFive(), k = 0;
      while (!ms.over && ++k < 600) ms = VSCore.apply(ms, {}, step, (R() * 4294967296) >>> 0).ms;
      assert.ok(ms.over, `${h}-${a} ends`);
      const W = ms.winner === 0 ? h : a;
      bump(wins, W); bump(games, h); bump(games, a);
      if (ms.winner === 0) homeWins++;
      n++;
    }
  }
  const rates = T.map((t) => [t, Math.round(100 * (wins[t] || 0) / games[t])]);
  const worst = rates.reduce((m, [, r]) => Math.max(m, Math.abs(r - 50)), 0);
  // no team's record says anything a coin would not: the spread of the 32 records is a coin's (chi-square about 32)
  const chi = T.reduce((s, t) => s + ((wins[t] || 0) - games[t] / 2) ** 2 / (games[t] / 4), 0);
  console.log(`even strength: ${n} matches, home wins ${Math.round(100 * homeWins / n)}%, the records' spread chi2 ${chi.toFixed(0)} (a coin's: 32 ± 8), each team's win rate ${rates.map(([t, r]) => `${t} ${r}`).join(', ')}`);
  assert.ok(chi < 64, `the records are a coin's (chi2 ${chi.toFixed(0)}, ${N} matches each)`);
  assert.ok(worst <= 35, `no team far from 50% (the worst is ${worst} off)`);
  assert.ok(Math.abs(homeWins / n - 0.5) < 0.12, `no home edge (${homeWins}/${n})`);
}

const regret = {};
let reads = 0, biggest = 0;
for (const [name, down, ytg, yl] of SIT) {
  const fk = H.fineKey(0, down, ytg, yl);
  const calls = CALLS.filter(([id]) => id !== 'qb_sneak' || ytg <= 3);
  const M = calls.map(([id, ci]) => {
    // the call's own worth here (its pool, as the draws are leveled), then what each defense does to it
    const pl = P.poolOf[ci * P.nFine + fk], lo = P.offsets[pl], hi = P.offsets[pl + 1] - 1;
    let w0 = 0, m1 = 0;
    for (let i = lo; i <= hi; i++) {
      const w = cdf[i] - (i > lo ? cdf[i - 1] : pl), e = P.epa[P.items[i]];
      if (!Number.isFinite(e)) continue;
      w0 += w; m1 += w * Math.max(-3, Math.min(e, 3));
    }
    return DCS.map((dc) => {
      const s = H.dcEffect(P.dcEff, id, dc).s;
      biggest = Math.max(biggest, Math.abs(s));
      return m1 / w0 + s;
    });
  });
  const g = solve(M), v = (g.lo + g.hi) / 2;
  assert.ok(g.hi - g.lo < 0.01, `${name}: solved (${g.lo.toFixed(3)} .. ${g.hi.toFixed(3)})`);
  // the offense's best call against each defense: reading it matters when they differ
  const best = DCS.map((_, j) => M.reduce((b, row, i) => (row[j] > M[b][j] ? i : b), 0));
  const answers = new Set(best).size;
  if (answers > 1) reads++;
  // each option against each call: the best defense with it, less the best defense of all (0: it is the answer)
  M.forEach((row) => {
    const top = Math.min(...row);
    for (const part of ['pers', 'front', 'cover', 'rush']) {
      for (const k of VSCore.DC[part]) {
        const r = Math.min(...DCS.map((dc, j) => (dc[part] === k ? row[j] : Infinity))) - top;
        (regret[`${part} ${k}`] = regret[`${part} ${k}`] || []).push(r);
      }
    }
  });
  const bestDef = Math.min(...DCS.map((_, j) => Math.max(...M.map((row) => row[j]))));
  const bestCall = Math.max(...M.map((row) => Math.min(...row)));
  console.log(`${name.padEnd(9)} value ${v.toFixed(3)}  best fixed defense ${bestDef.toFixed(3)}  best fixed call ${bestCall.toFixed(3)}  ` +
    `best calls against the ${DCS.length} defenses: ${answers}`);
}
assert.ok(biggest < 0.25, `a defense's effect on a play is a few hundredths of a point, not ${biggest.toFixed(3)}`);
assert.ok(reads >= Math.ceil(SIT.length / 2), `reading the defense changes the best call in ${reads} of ${SIT.length} situations`);
// an option is the best answer to some call somewhere (a trap otherwise); and how often it is (of every call in
// every situation)
for (const [k, rs] of Object.entries(regret)) {
  const b = Math.min(...rs);
  assert.ok(b < 0.005, `${k}: never the best answer to any call (${b.toFixed(3)} EPA off at best)`);
}
console.log(`biggest effect ${biggest.toFixed(3)} EPA; each option the best answer to:`,
  Object.entries(regret).map(([k, rs]) => `${k} ${(100 * rs.filter((r) => r < 0.005).length / rs.length).toFixed(0)}%`).join(' | '));
console.log('versus balance ok');
