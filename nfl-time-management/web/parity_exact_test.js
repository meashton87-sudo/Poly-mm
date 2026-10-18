const fs = require('fs'), path = require('path');
// Per-rollout parity against scripts/parity_exact.py (same random numbers): every value must match.
const W = __dirname;
const E = require(path.join(W, 'engine.js'));
//   node web/parity_exact_test.js [rules] [--level fbs]    (scripts/parity_exact.py --rules ... --level ..., the same)
const argv = process.argv.slice(2), li = argv.indexOf('--level'), level = li >= 0 ? argv[li + 1] : 'nfl';
const rules = argv.find((x, i) => !x.startsWith('--') && (li < 0 || i !== li + 1)) || 'nfl';
const tag = rules === 'nfl' && level === 'nfl' ? '' : `_${rules.replace(':', '-')}${level === 'nfl' ? '' : `_${level}`}`;
const data = JSON.parse(fs.readFileSync(path.join(W, level === 'nfl' ? 'engine_data.json' : `engine_data_${level === 'fbs' ? 'cfb' : level}.json`)));
const game = JSON.parse(fs.readFileSync(path.join(W, '2026_05_BUF_LA.json')));
const C = JSON.parse(fs.readFileSync(path.join(W, '..', 'artifacts', `parity_exact${tag}.json`)));
const eng = new E(data);
const sim = eng.simulator(eng.makeContext(game, { receive2h: C.r2h, coachMode: C.coach || {}, rules: C.rules || 'nfl' }));
let bad = 0, tot = 0;
C.cases.forEach((c, i) => {
  const res = sim.run(c.root, { n: C.n, action: c.action, perspective: c.perspective, seed: 5 });
  let mism = 0, first = -1;
  for (let r = 0; r < C.n; r++) if (Math.abs(res.values[r] - c.py[r]) > 1e-6) { mism++; if (first < 0) first = r; }
  tot++;
  if (mism) { bad++; console.log(`case ${i} mism ${mism}/${C.n} first r=${first} js=${res.values[first].toFixed(4)} py=${c.py[first].toFixed(4)} ${JSON.stringify(c.root)} ${JSON.stringify(c.action)}`); }
});
console.log(`${bad}/${tot} cases with per-rollout mismatches (rules ${C.rules || 'nfl'}, ${level} data)`);
process.exit(bad ? 1 : 0);
