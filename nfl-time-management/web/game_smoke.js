// Node smoke test for the daily game path: every spot's two real teams, playbook sampling, option values and single steps.
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
// every spot's two teams as they were in that game (web/spots): a full 22 with ratings (40-99), a QB, a kicker
// and a punter, and a game built from them (as game.js does)
const TEAMS = {};
fs.readdirSync(path.join(dir, 'spots')).forEach((f) => Object.assign(TEAMS, JSON.parse(fs.readFileSync(path.join(dir, 'spots', f), 'utf8'))));
console.log(`engine + playbook in ${Date.now() - t0} ms; ${idx.spots.length} spots, ${idx.schedule.length} days, ` +
  `${idx.coaches.coaches.length} coaches; ratings: ${idx.asof.ratings}`);
idx.spots.forEach((sp, i) => {
  const T = TEAMS[i];
  assert.ok(T && T.home && T.away, `spot ${i} teams`);
  for (const t of [T.home, T.away]) {
    const tag = `${sp.id} ${t.team}`;
    assert.strictEqual(t.lineup.off.length, 11, `${tag} offense`);
    assert.strictEqual(t.lineup.def.length, 11, `${tag} defense`);
    assert.ok(t.lineup.off.some((p) => p.pos === 'QB'), `${tag} QB`);
    assert.ok(t.kicker.name && t.punter.name && t.kicker.ovr >= 40 && t.punter.ovr >= 40, `${tag} specialists`);
    [...t.lineup.off, ...t.lineup.def].forEach((p) => assert.ok(Number.isInteger(p.ovr) && p.ovr >= 40 && p.ovr <= 99 && p.name, `${tag} ${p.name}`));
  }
});
idx.schedule.forEach((day) => day.forEach((i) => assert.ok(idx.spots[i], `spot ${i}`)));
const scen = (sp) => {
  const T = TEAMS[idx.spots.indexOf(sp)], H = T.home, A = T.away;
  return { ...sp, game: { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
    league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real.season } };
};
idx.spots.forEach((sp) => eng.makeContext(scen(sp).game, { receive2h: sp.start.receive2h }));

const S = scen(idx.spots[idx.schedule[0][0]]);
const mine = S.player === S.home ? S.game.home : S.game.away, lu = mine.lineup;
console.log(S.category, S.id, 'you:', S.player, mine.coach, '| line', S.game.home_spread.toFixed(1));
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
// matchups (engine.js MATCH): a call that beats the defense's call does better than the real plays alone, one that
// loses to it worse (mean EPA of the plays drawn, over every situation)
{
  const S = eng.simulator(eng.makeContext(scen(idx.spots[0]).game, { receive2h: idx.spots[0].start.receive2h }));
  const P = eng.pb, mean = (id, look, s) => {
    let t = 0, n = 0;
    for (let fk = 0; fk < P.nFine; fk += 7) for (let k = 0; k < 400; k++) { const r = S.samplePlaybook(0, P.callIndex[id], fk, (k + 0.5) / 400, false, look, s); t += P.epa[r]; n++; }
    return t / n;
  };
  [['rb_inside_strong', 4, -1], ['deep_strong', 2, -1], ['screen', 2, 1], ['pa_deep', 4, 1]].forEach(([id, look, s]) => {
    const lo = mean(id, look, -Math.abs(s)), mid = mean(id, look, 0), hi = mean(id, look, Math.abs(s));
    assert.ok(lo < mid - 0.15 && hi > mid + 0.15, `matchup tilt ${id}: ${lo.toFixed(2)} / ${mid.toFixed(2)} / ${hi.toFixed(2)}`);
    console.log(`matchup ${id.padEnd(17)} losing ${lo.toFixed(2)}  real ${mid.toFixed(2)}  winning ${hi.toFixed(2)} EPA`);
  });
}
console.log('smoke ok');
