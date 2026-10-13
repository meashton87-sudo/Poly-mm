// Node smoke test for the daily game path: today's teams, playbook sampling, option values and single steps.
//   node web/game_smoke.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const NFLClockEngine = require('./engine.js');
const dir = __dirname;
const t0 = Date.now();
const eng = new NFLClockEngine(JSON.parse(fs.readFileSync(path.join(dir, 'engine_data.json'), 'utf8')));
eng.loadPlaybook(JSON.parse(fs.readFileSync(path.join(dir, 'playbook.json'), 'utf8')));
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
console.log(`engine + playbook in ${Date.now() - t0} ms; ${idx.spots.length} spots, ${idx.schedule.length} days, ` +
  `${Object.keys(idx.teams).length} teams, ${idx.coaches.coaches.length} coaches; ratings: ${idx.asof.ratings}`);

// every team: a full 22 with overall ratings (40-99), a starting QB, a kicker and a punter
for (const [code, T] of Object.entries(idx.teams)) {
  assert.strictEqual(T.lineup.off.length, 11, `${code} offense`);
  assert.strictEqual(T.lineup.def.length, 11, `${code} defense`);
  assert.ok(T.lineup.off.some((p) => p.pos === 'QB'), `${code} QB`);
  assert.ok(T.kicker.name && T.punter.name && T.kicker.ovr >= 40 && T.punter.ovr >= 40, `${code} specialists`);
  [...T.lineup.off, ...T.lineup.def].forEach((p) => assert.ok(Number.isInteger(p.ovr) && p.ovr >= 40 && p.ovr <= 99 && p.name, `${code} ${p.name}`));
}
// the schedule points at real spots; every spot builds a game against today's teams (as game.js does)
idx.schedule.forEach((day) => day.forEach((i) => assert.ok(idx.spots[i], `spot ${i}`)));
const scen = (sp) => {
  const H = idx.teams[sp.home], A = idx.teams[sp.away];
  return { ...sp, game: { home: H, away: A, home_spread: (idx.hfa || 1.5) + (H.power || 0) - (A.power || 0), indoor: sp.indoor,
    wind: sp.wind, temp: sp.temp, league: idx.league, home_coach: H.coach, away_coach: A.coach, season: idx.asof.season } };
};
idx.spots.forEach((sp) => eng.makeContext(scen(sp).game, { receive2h: sp.start.receive2h }));

const S = scen(idx.spots[idx.schedule[0][0]]);
const lu = idx.teams[S.player].lineup;
console.log(S.category, S.id, 'you:', S.player, idx.teams[S.player].coach, '| line', S.game.home_spread.toFixed(1));
console.log('  offense', lu.off.map((p) => `${p.pos} ${p.name} ${p.ovr}`).join(', '));
console.log('  start', JSON.stringify(S.start), '| real:', S.real.coach, S.real.call, '->', S.real.drive);
const sim = eng.simulator(eng.makeContext(S.game, { receive2h: S.start.receive2h }));
const st = S.start;
const root = { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === S.home ? 0 : 1,
  score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]],
  clock_running: st.running, phase: 0, credit: 0, free_kick: false };
const me = root.pos;
const t1 = Date.now();
const rows = eng.pb.calls.map((c) => [c.id, sim.run(root, { n: 1500, action: { to_off: false, play: c.kind, call: c.id }, perspective: me, seed: 7 }).mean]);
rows.sort((a, b) => b[1] - a[1]);
console.log(`${rows.length} calls x 1500 in ${Date.now() - t1} ms`);
rows.forEach(([id, v]) => { assert.ok(v >= 0 && v <= 1); console.log('  ', id.padEnd(16), (v * 100).toFixed(1)); });
let cur = root;
for (let i = 0; i < 8; i++) {
  const r = sim.step(cur, { action: cur.pos === me && cur.phase === 0 ? { to_off: false, play: 'pass', call: 'quick_weak', oob: true } : {}, seed: 100 + i });
  r.log.filter((e) => e.row >= 0).forEach((e) => console.log('   real play:', eng.pb.eventNames[eng.pb.event[e.row]] || '(plain)', 'pen', eng.pb.penNames[eng.pb.pen[e.row]] || '-', 'look', eng.pb.look[e.row]));
  console.log(i, JSON.stringify(r.log), '->', JSON.stringify({ t: r.root.t, pos: r.root.pos, sc: r.root.score, d: r.root.down, ytg: r.root.ytg, yl: r.root.yl, run: r.root.clock_running, ph: r.root.phase }));
  cur = r.root;
  if (r.done) break;
}
console.log('smoke ok');
