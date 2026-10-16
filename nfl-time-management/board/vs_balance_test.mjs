// Versus defense balance: in common overtime situations, the game every offensive call against every defensive call
// (personnel x front x coverage x rush) makes, as engine.js plays it: each call's mean EPA there (its pool, recentered
// as sampleVsDefense does) plus the matchup's tilt (dcMatch). Solved by multiplicative weights for both sides:
//   - no defense is safe against everything (the best fixed one does worse than mixing), and no call either
//   - every option of every part (each personnel group, front, coverage, rush) is close to the best in some situation
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
const sim = eng.simulator(eng.makeContext(VSCore.buildGame(pool, 'KC', 'BUF'), { receive2h: 'KC' }));
const cdf = sim.pbCdf[0].cdf;
const DCS = [];
for (const pers of VSCore.DC.pers) for (const front of VSCore.DC.front) for (const cover of VSCore.DC.cover) for (const rush of VSCore.DC.rush) DCS.push({ pers, front, cover, rush });
const SIT = [['1st & 10', 1, 10, 25], ['2nd & 6', 2, 6, 21], ['2nd & 4', 2, 4, 30], ['2nd & 2', 2, 2, 17], ['3rd & 2', 3, 2, 17], ['3rd & 8', 3, 8, 23],
  ['3rd & 15', 3, 15, 30], ['goal at 5', 1, 5, 5], ['goal at 2', 3, 2, 2]];
const CALLS = P.calls.map((c, i) => [c.id, i]).filter(([id]) => id !== 'hail_mary');

// the zero-sum game (the offense maximizes): both sides' average strategies by multiplicative weights
function solve(M) {
  const m = M.length, n = M[0].length, eta = 0.05, T = 10000;
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
for (const [name, down, ytg, yl] of SIT) {
  const fk = H.fineKey(0, down, ytg, yl);
  const calls = CALLS.filter(([id]) => id !== 'qb_sneak' || ytg <= 3);
  const M = calls.map(([id, ci]) => {
    const pl = P.poolOf[ci * P.nFine + fk], lo = P.offsets[pl], hi = P.offsets[pl + 1] - 1;
    let w0 = 0, m1 = 0, m2 = 0;
    for (let i = lo; i <= hi; i++) {
      const w = cdf[i] - (i > lo ? cdf[i - 1] : pl), e = P.epa[P.items[i]];
      if (!Number.isFinite(e)) continue;
      const x = Math.max(-3, Math.min(e, 3)); w0 += w; m1 += w * x; m2 += w * x * x;
    }
    const m = m1 / w0, sd = Math.sqrt(Math.max(m2 / w0 - m * m, 0.3));
    return DCS.map((dc) => m + 0.2 * H.dcMatch(id, dc).s * sd);
  });
  const g = solve(M), v = (g.lo + g.hi) / 2;
  assert.ok(g.hi - g.lo < 0.03, `${name}: solved (${g.lo.toFixed(3)} .. ${g.hi.toFixed(3)})`);
  const bestDef = Math.min(...DCS.map((_, j) => Math.max(...M.map((row) => row[j]))));
  const bestCall = Math.max(...M.map((row) => Math.min(...row)));
  assert.ok(bestDef > v + 0.015, `${name}: a defense that is safe against every call (${bestDef.toFixed(3)} vs ${v.toFixed(3)})`);
  assert.ok(bestCall < v - 0.05, `${name}: a call that is safe against every defense (${bestCall.toFixed(3)} vs ${v.toFixed(3)})`);
  // each option: the best defense with it, against the offense's mix, less the value
  const pay = DCS.map((_, j) => M.reduce((a, row, i) => a + row[j] * g.x[i], 0));
  for (const part of ['pers', 'front', 'cover', 'rush']) {
    for (const k of VSCore.DC[part]) {
      const r = Math.min(...DCS.map((dc, j) => (dc[part] === k ? pay[j] : Infinity))) - v;
      (regret[`${part} ${k}`] = regret[`${part} ${k}`] || []).push(r);
    }
  }
  console.log(`${name.padEnd(9)} value ${v.toFixed(3)}  best fixed defense ${bestDef.toFixed(3)}  best fixed call ${bestCall.toFixed(3)}`);
}
for (const [k, rs] of Object.entries(regret)) {
  const best = Math.min(...rs);
  assert.ok(best < (k === 'cover prevent' ? 0.08 : 0.04), `${k}: never close to the best call (${best.toFixed(3)} EPA off at best)`);
}
console.log('every option:', Object.entries(regret).map(([k, rs]) => `${k} ${Math.min(...rs).toFixed(3)}`).join(' | '));
console.log('versus balance ok');
