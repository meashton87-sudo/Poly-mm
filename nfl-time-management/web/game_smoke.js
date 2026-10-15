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
// a touchdown on the last play of the first half: the try comes at t = 1800 (0:00 of Q2) and the half ends after it,
// whatever the try does (no kickoff, no second half); the same in the value of the try
for (const pat of ['xp', 'two']) for (let k = 0; k < 40; k++) {
  const end = { ...root, t: 1800, phase: 1, score: [14, 10], pos: 0, down: 1, ytg: 2, yl: 2, clock_running: false };
  const r = sim.step(end, { action: { pat }, seed: 900 + k });
  assert.ok(r.done && r.root.phase === 3 && r.root.t === 1800, `try at the end of the first half ends it (${pat}): ${JSON.stringify(r.root)}`);
  assert.ok(!r.log.some((e) => e.ev === 'kickoff'), 'no kickoff after a try that ends the first half');
}
{
  const v = sim.run({ ...root, t: 1800, phase: 1, score: [14, 10], pos: 0, down: 1, ytg: 2, yl: 2, clock_running: false }, { n: 400, action: { pat: 'xp' }, perspective: 0, seed: 3 });
  assert.ok(v.mean >= 0 && v.mean <= 1);
}
// a fumble only after crossing the goal line is a touchdown (a real fumble drawn closer to the goal than it
// happened): from inside the 10, no lost fumble may follow a gain that reached the end zone
{
  let fum = 0, scored = 0;
  for (let k = 0; k < 6000; k++) {
    const id = ['quick_strong', 'deep_middle', 'screen', 'rb_inside_strong', 'pa_short'][k % 5];
    const at = { ...root, t: 600, phase: 0, score: [10, 14], pos: 0, down: 1, ytg: 8, yl: 8, clock_running: false };
    const r = sim.step(at, { action: { to_off: false, play: eng.pb.calls.find((c) => c.id === id).kind, call: id }, seed: 5000 + k });
    r.log.filter((e) => e.ev === 'play').forEach((e) => {
      assert.ok(!(e.turnover && !e.penalty && e.yards >= e.yl), `a lost fumble after reaching the end zone: ${JSON.stringify(e)}`);
      if (e.turnover) fum++; if (e.td) scored++;
    });
  }
  console.log(`inside the 10: ${scored} touchdowns, ${fum} turnovers, none past the goal line`);
}
// "Run it down" (game.js rundown) is graded as played: the clock runs to 0:03 with no timeout from the defense in
// between, and the kick after the timeout is set up, not rushed
for (let k = 0; k < 200; k++) {
  const at = { ...root, t: 40, phase: 0, score: [17, 17], pos: 0, down: 2, ytg: 6, yl: 20, to: [2, 3], clock_running: true };
  const r = sim.step(at, { action: { to_off: false, to_def: false, runoff: 37, play: 'fg' }, seed: 7000 + k });
  const fg = r.log.find((e) => e.ev === 'fg');
  assert.ok(fg && !fg.fire && Math.abs(fg.dist - 37) < 1e-9, `rundown kick set up: ${JSON.stringify(fg)}`);
  assert.ok(!r.log.some((e) => e.ev === 'timeout' && e.team === 1), 'no defensive timeout in a rundown');
  const ro = r.log.find((e) => e.ev === 'runoff');
  assert.ok(ro && Math.abs(ro.t - 3) < 1e-9, `rundown to 0:03: ${JSON.stringify(ro)}`);
}
// a timeout called just before 2:00 never carries the clock past it: the two-minute warning still comes
for (let k = 0; k < 100; k++) {
  const at = { ...root, t: 120.6, phase: 0, score: [17, 20], pos: 0, down: 2, ytg: 6, yl: 40, to: [2, 3], clock_running: true };
  const r = sim.step(at, { action: { to_def: true }, seed: 8000 + k });
  const to = r.log.find((e) => e.ev === 'timeout');
  assert.ok(to && to.t >= 120, `a timeout before the warning stays before it: ${JSON.stringify(to)}`);
}
// yards a throw (game.js pass odds) never past the goal line
{
  const fk9 = 3 * 7 * 4 + 0;   // any situation bucket
  for (const id of ['deep_strong', 'deep_middle', 'pa_deep', 'quick_strong']) {
    const o = sim.routeOdds(0, eng.pb.callIndex[id], fk9, 0, null, null, 9);
    assert.ok(!o || o.yds <= 9 + 1e-9, `yards a throw from the 9: ${id} ${o && o.yds}`);
  }
}
// a two-point try you call (game.js try2): a real play of that call from the 2; over the calls about the league's rate
{
  const at = { ...root, t: 300, phase: 1, score: [20, 14], pos: 0, down: 1, ytg: 10, yl: 15, clock_running: false };
  let good = 0, n = 0;
  for (const c of eng.pb.calls) for (let k = 0; k < 300; k++) {
    const e = sim.step(at, { action: { pat: 'two', call: c.id }, seed: 9000 + k }).log.find((x) => x.ev === 'pat');
    assert.ok(e && e.two && e.call === eng.pb.callIndex[c.id], `called try logged: ${JSON.stringify(e)}`);
    n++; if (e.good) good++;
  }
  assert.ok(good / n > 0.38 && good / n < 0.6, `called two-point tries convert like the league: ${(good / n).toFixed(3)}`);
  console.log(`called two-point tries: ${(100 * good / n).toFixed(1)}% good`);
}
// in field goal range late, tied, the defense calls timeout to save time for a reply even when the offense has none left
{
  let calls = 0;
  for (let k = 0; k < 60; k++) {
    const at = { ...root, t: 55, phase: 0, score: [17, 17], pos: 0, down: 2, ytg: 6, yl: 18, to: [0, 2], clock_running: true };
    const r = sim.step(at, { action: { to_off: false, play: 0 }, seed: 9500 + k });
    if (r.log.some((e) => e.ev === 'timeout' && e.team === 1)) calls++;
  }
  assert.ok(calls > 50, `the defense saves time when a field goal would beat it: ${calls}/60`);
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
    assert.ok(lo < mid - 0.08 && hi > mid + 0.08, `matchup tilt ${id}: ${lo.toFixed(2)} / ${mid.toFixed(2)} / ${hi.toFixed(2)}`);
    console.log(`matchup ${id.padEnd(17)} losing ${lo.toFixed(2)}  real ${mid.toFixed(2)}  winning ${hi.toFixed(2)} EPA`);
  });
}
console.log('smoke ok');
