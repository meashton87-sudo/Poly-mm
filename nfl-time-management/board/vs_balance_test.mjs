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
const eng = new NFLClockEngine(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'engine_data.pack'))))));
eng.loadPlaybook(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'playbook.pack'))))));
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
