// Node smoke test for the daily game path: playbook sampling, option values and single steps.
//   node web/game_smoke.js
const fs = require('fs');
const path = require('path');
const NFLClockEngine = require('./engine.js');
const dir = __dirname;
const t0 = Date.now();
const eng = new NFLClockEngine(JSON.parse(fs.readFileSync(path.join(dir, 'engine_data.json'), 'utf8')));
eng.loadPlaybook(JSON.parse(fs.readFileSync(path.join(dir, 'playbook.json'), 'utf8')));
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
const spot = (i) => JSON.parse(fs.readFileSync(path.join(dir, 'spots', `${String(Math.floor(i / idx.chunk)).padStart(2, '0')}.json`), 'utf8'))[i % idx.chunk];
console.log(`engine + playbook in ${Date.now() - t0} ms; ${idx.n} scenarios, ${idx.schedule.length} days`);
const S = spot(idx.schedule[0][0]);
const lu = S.lineups[S.player === S.game.home.team ? 'home' : 'away'];
console.log('lineup', lu.off.length, '+', lu.def.length, lu.off.map((p) => `${p.pos}:${p.pct}`).join(' '));
console.log(S.category, S.id, S.player, 'vs', S.opponent, JSON.stringify(S.start), S.names, 'real:', S.real.call, '|', S.real.drive);
const ctx = eng.makeContext(S.game, { receive2h: S.start.receive2h });
const sim = eng.simulator(ctx);
const PH = { snap: 0, pat: 1, kickoff: 2 };
const st = S.start;
const home = S.game.home.team;
const root = { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === home ? 0 : 1,
  score: [st.score[1], st.score[0]], down: st.down, ytg: st.ytg, yl: st.yl, to: [st.to[1], st.to[0]],
  clock_running: st.running, phase: PH[st.phase] };
const me = root.pos;
const t1 = Date.now();
const rows = eng.pb.calls.map((c) => {
  const r = sim.run(root, { n: 1500, action: { play: c.kind, call: c.id }, perspective: me, seed: 7 });
  return [c.id, r.mean];
});
rows.sort((a, b) => b[1] - a[1]);
console.log(`${rows.length} calls x 1500 in ${Date.now() - t1} ms`);
rows.forEach(([id, v]) => console.log('  ', id.padEnd(14), (v * 100).toFixed(1)));
const card = S.game[root.pos === 0 ? 'home' : 'away'].calls;
console.log('matchup tilt deep_strong', card.deep_strong, 'rpo_weak', card.rpo_weak);
let cur = root;
for (let i = 0; i < 6; i++) {
  const r = sim.step(cur, { action: cur.pos === me && cur.phase === 0 ? { play: 'pass', call: 'quick_weak', oob: true } : {}, seed: 100 + i });
  r.log.filter((e) => e.row >= 0).forEach((e) => console.log('   real play:', eng.pb.eventNames[eng.pb.event[e.row]] || '(plain)', 'pen', eng.pb.penNames[eng.pb.pen[e.row]] || '-', 'look', eng.pb.look[e.row]));
  console.log(i, JSON.stringify(r.log), '->', JSON.stringify({ t: r.root.t, pos: r.root.pos, sc: r.root.score, d: r.root.down, ytg: r.root.ytg, yl: r.root.yl, run: r.root.clock_running, ph: r.root.phase }));
  cur = r.root;
  if (r.done) break;
}
