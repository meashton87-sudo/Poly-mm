// Node parity test: the browser engine must reproduce the Python simulator.
//   node web/parity_test.js [n]
const fs = require('fs');
const path = require('path');
const NFLClockEngine = require('./engine.js');

const dir = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(dir, 'engine_data.json'), 'utf8'));
const exp = JSON.parse(fs.readFileSync(path.join(dir, 'parity_expected.json'), 'utf8'));
const game = JSON.parse(fs.readFileSync(path.join(dir, `${exp.game}.json`), 'utf8'));
const N = Number(process.argv[2] || 20000);

let t0 = Date.now();
const eng = new NFLClockEngine(data);
const ctx = eng.makeContext(game, { receive2h: exp.receive2h });
const sim = eng.simulator(ctx);
console.log(`engine + simulator ready in ${Date.now() - t0} ms`);
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

// 1. WP trees
let maxd = 0;
exp.wp_rows.forEach((row, i) => { maxd = Math.max(maxd, Math.abs(1 / (1 + Math.exp(-eng.wpRaw(row))) - exp.wp_pred[i])); });
check('win-probability trees', maxd < 1e-9, `max |diff| = ${maxd.toExponential(2)} over ${exp.wp_rows.length} rows`);

// 2. FG model
maxd = 0;
for (const [d, p] of Object.entries(exp.fg)) maxd = Math.max(maxd, Math.abs(sim.fgProb(Number(d), 0) - p));
check('field-goal model', maxd < 1e-9, `max |diff| = ${maxd.toExponential(2)}`);

// 3. context, tilting and 4th-down conversion tables
maxd = 0;
for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) maxd = Math.max(maxd, Math.abs(ctx.delta[i][k] - exp.delta[i][k]));
check('matchup EPA deltas', maxd < 1e-9, `max |diff| = ${maxd.toExponential(2)}`);
check('OT value', Math.abs(ctx.otWpHome - exp.ot_wp_home) < 2e-3, `${ctx.otWpHome.toFixed(4)} vs ${exp.ot_wp_home.toFixed(4)}`);
maxd = 0;
for (const [i, v] of Object.entries(exp.cdf_probe)) for (let t = 0; t < 2; t++) maxd = Math.max(maxd, Math.abs(sim.cdf[t][Number(i)] - v[t]));
check('tilted play-library CDFs', maxd < 1e-7, `max |diff| = ${maxd.toExponential(2)}`);
maxd = 0;
for (let t = 0; t < 2; t++) exp.conv[t].forEach((v, i) => { maxd = Math.max(maxd, Math.abs(sim.conv[t][i] - v)); });
check('4th-down conversion tables', maxd < 1e-9, `max |diff| = ${maxd.toExponential(2)}`);

// 4. full simulations (Monte-Carlo: compare within 3.5 combined standard errors, floor 0.4 pts)
t0 = Date.now();
for (const sc of exp.scenarios) {
  const r = sc.root;
  const root = { t: r.t, pos: r.pos, score: r.score, down: r.down || 1, ytg: r.ytg || 10, yl: r.yl || 75, to: r.to,
    clock_running: !!r.clock_running, phase: r.phase || 0 };
  const res = sim.run(root, { n: N, action: sc.action, perspective: sc.perspective, seed: 11 });
  const tol = Math.max(3.5 * Math.hypot(res.se, sc.se), 0.004);
  const d = res.mean - sc.mean;
  check(`sim ${sc.name.padEnd(26)}`, Math.abs(d) <= tol,
    `js ${res.mean.toFixed(4)} py ${sc.mean.toFixed(4)} diff ${(d * 100).toFixed(2)} pts (tol ${(tol * 100).toFixed(2)})`);
}
console.log(`${exp.scenarios.length} scenarios x ${N} rollouts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(fails === 0 ? 'ALL PARITY CHECKS PASSED' : `${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
