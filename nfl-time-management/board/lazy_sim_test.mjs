// lazy_sim.js against the engine's own Simulator: every table value the same, every play the same, and how much
// smaller it is.   node board/lazy_sim_test.mjs   (needs board/assets/vs: the site workflow puts it there)
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import NFLClockEngine from '../web/engine.js';
import VSCore from '../web/vs_core.js';
import { lazySimulator } from './lazy_sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(process.env.VS_ASSETS || path.join(HERE, 'assets'), 'vs');
if (!fs.existsSync(path.join(A, 'engine_data.pack'))) { console.log('lazy sim: no engine data (board/assets/vs), skipped'); process.exit(0); }
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const eng = new NFLClockEngine(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'engine_data.pack'))))));
eng.loadPlaybook(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'playbook.pack'))))));
const pool = JSON.parse(fs.readFileSync(path.join(A, 'teams.json'), 'utf8')), T = Object.keys(pool.teams).sort();
const R = VSCore.rng(99);
// how much smaller: a match's worth of plays
globalThis.gc && globalThis.gc();
const m0 = process.memoryUsage();
const keep = [];
for (let i = 0; i < 10; i++) {
  const ctx = eng.makeContext(VSCore.buildGame(pool, T[i], T[i + 10]), { receive2h: T[i] });
  const step = (() => { const sim = lazySimulator(eng, ctx); return (root, action, seed) => sim.step(root, { action, seed }); })();
  let ms = VSCore.start(i % 2);
  for (let k = 0; k < 60 && !ms.over; k++) {
    const halves = {};
    for (const s of VSCore.need(ms)) halves[s] = VSCore.role(ms, s) === 'defense' ? { def: 'blitz' } : VSCore.role(ms, s) === 'offense' ? { action: { call: eng.pb.calls[k % eng.pb.calls.length].id } } : null;
    ms = VSCore.apply(ms, halves, step, (i * 7919 + k * 104729) >>> 0).ms;
  }
  keep.push(step);
}
globalThis.gc && globalThis.gc();
const m1 = process.memoryUsage();
const per = (m1.heapUsed + m1.arrayBuffers - m0.heapUsed - m0.arrayBuffers) / 10 / 1e6;
console.log(`a match's simulator: ${per.toFixed(2)} MB (the engine's own: about 54 MB)`);
assert.ok(per < 8, 'a few MB a match');
const pairs = [[T[0], T[1]], [T[5], T[20]], [T[31], T[12]]];
for (const [h, a] of pairs) {
  const ctx = eng.makeContext(VSCore.buildGame(pool, h, a), { receive2h: h });
  const E = eng.simulator(ctx), Lz = lazySimulator(eng, ctx);
  for (let team = 0; team < 2; team++) {
    const n = E.cdf[team].length;
    assert.strictEqual(Lz.cdf[team].length, n);
    for (let i = 0; i < n; i++) if (E.cdf[team][i] !== Lz.cdf[team][i]) assert.fail(`${h}-${a} library cdf ${team} ${i}: ${E.cdf[team][i]} vs ${Lz.cdf[team][i]}`);
    for (let i = 0; i < E.stopCdf[team].length; i++) if (E.stopCdf[team][i] !== Lz.stopCdf[team][i]) assert.fail(`stop cdf ${team} ${i}`);
    for (let i = 0; i < E.conv[team].length; i++) if (E.conv[team][i] !== Lz.conv[team][i] && !(Number.isNaN(E.conv[team][i]) && Number.isNaN(Lz.conv[team][i]))) assert.fail(`conv ${team} ${i}: ${E.conv[team][i]} vs ${Lz.conv[team][i]}`);
    for (const k of ['cdf', 'cdfOob', 'cdfIn']) {
      const x = E.pbCdf[team][k], y = Lz.pbCdf[team][k];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) assert.fail(`${h}-${a} playbook ${k} ${team} ${i}: ${x[i]} vs ${y[i]}`);
    }
  }
  // the same plays: every kind of call, from every kind of spot, many seeds
  const calls = eng.pb.calls;
  let plays = 0;
  for (let k = 0; k < 4000; k++) {
    const root = { t: 900, pos: R() < 0.5 ? 0 : 1, score: [Math.floor(R() * 20), Math.floor(R() * 20)], down: 1 + Math.floor(R() * 4), ytg: 1 + Math.floor(R() * 15), yl: 1 + Math.floor(R() * 60),
      to: [1, 1], clock_running: false, phase: R() < 0.1 ? 1 : 0, credit: 0, free_kick: false };
    root.ytg = Math.min(root.ytg, root.yl);
    const c = calls[Math.floor(R() * calls.length)], x = R();
    const action = x < 0.15 ? {} : x < 0.3 ? { def: ['blitz', 'load', 'soft'][k % 3] } : x < 0.35 ? { play: ['fg', 'punt', 'kneel', 'spike'][k % 4] } : x < 0.4 ? { pat: k % 2 ? 'two' : 'xp', call: c.id, looks: k % 16 }
      : { call: c.id, play: c.kind, looks: [0, 1, 4, 10][k % 4], oob: R() < 0.1, ...(R() < 0.3 ? { pers: [11, 12, 21, 13][k % 4] } : {}), ...(R() < 0.2 ? { route: eng.pb.routeNames[1 + (k % (eng.pb.routeNames.length - 1))], who: ['RB', 'WR', 'TE'][k % 3] } : {}) };
    const seed = (k * 2654435761) >>> 0;
    assert.deepStrictEqual(Lz.step(root, { action, seed }), E.step(root, { action, seed }), `${h}-${a} play ${k} ${JSON.stringify(action)}`);
    plays++;
  }
  console.log(`${h}-${a}: every table value and ${plays} plays the same`);
}
console.log('lazy sim ok');
