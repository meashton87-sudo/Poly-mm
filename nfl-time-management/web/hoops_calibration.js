// Hoops calibration: the engine's win chance from every real spot (both benches typical) against how the real game
// ended, by tenths, with the Brier score. Run after changing the engine (APPROACH, DEFENSE, possession, the typical
// benches): node web/hoops_calibration.js [games a spot, 300] [spots|playoffs]. Needs web/hoops/hoops_data.json (built).
// Oct 29, 2026: 967 spots, predicted 63.8% against 64.6% won, Brier 0.140; a confidence scale fitted on top came out
// at 0.95 (no change made).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'hoops.js'), 'utf8');
const a = src.indexOf('  const SVG_NS'), b = src.indexOf('  const N_EVAL');
if (a < 0 || b < 0) throw new Error('hoops.js: the engine markers (SVG_NS, N_EVAL) moved');
const engine = src.slice(a, b).replace(/const svgEl = .*?\n/, '\n').replace(/const REDUCED = .*?\n/, 'const REDUCED = false;\n');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'hoops', 'hoops_data.json'), 'utf8'));
const run = new Function('D', 'N', 'which', `const localStorage = { getItem() { return null; }, setItem() {} };
${engine}
L = D.league; T = D.teams;
const rows = [];
for (const sp of D[which] || []) {
  FIVE = { home: (sp.players.home || []).slice(0, 5), away: (sp.players.away || []).slice(0, 5) };
  let w = 0;
  for (let i = 0; i < N; i++) w += playOut(newState(sp), rng(hash('cal', sp.id, i)), null);
  const m = sp.me === sp.home ? sp.final[0] - sp.final[1] : sp.final[1] - sp.final[0];
  rows.push([w / N, m > 0 ? 1 : 0]);
}
return rows;`);
const N = +process.argv[2] || 300, which = process.argv[3] || 'spots', rows = run(D, N, which);
const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
console.log(`${which}: ${rows.length} spots, ${N} games each; predicted ${(100 * mean((r) => r[0])).toFixed(1)}%, won ${(100 * mean((r) => r[1])).toFixed(1)}%, Brier ${mean(([p, y]) => (p - y) ** 2).toFixed(4)}`);
const bins = {};
for (const [p, y] of rows) { const k = Math.min(9, Math.floor(p * 10)); const x = bins[k] || (bins[k] = [0, 0, 0]); x[0]++; x[1] += p; x[2] += y; }
for (const k of Object.keys(bins).sort((x, y) => x - y)) { const [n, ps, ys] = bins[k]; console.log(`  ${k * 10}-${k * 10 + 10}%: ${n} spots, predicted ${(100 * ps / n).toFixed(1)}%, won ${(100 * ys / n).toFixed(1)}%`); }
