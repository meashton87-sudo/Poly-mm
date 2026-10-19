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
// a featured day of two sides (game.js sidesOf): two spots of one real game, a side for each team, the first its spot
Object.entries(idx.featured || {}).forEach(([d, f]) => {
  if (!f.sides) return;
  const ss = f.sides.map((x) => idx.spots[x.spot]);
  assert.ok(ss.length === 2 && ss.every(Boolean), `day ${d}: two sides`);
  assert.strictEqual(f.spot, f.sides[0].spot, `day ${d}: its spot is its first side`);
  assert.strictEqual(new Set(ss.map((sp) => sp.id.split('#')[0])).size, 1, `day ${d}: one game`);
  assert.strictEqual(new Set(ss.map((sp) => sp.player)).size, 2, `day ${d}: one side each team`);
  console.log(`day ${d}: pick a side, ${ss.map((sp) => `${sp.player} ${sp.id} (${sp.category})`).join(' or ')}`);
});
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
// in field goal range late, tied, the defense calls timeout to save time for a reply when the offense can run the clock
// down to its kick (a timeout left) and stopping it after each down gets the ball back with time to answer; never for
// an offense out of timeouts (the running clock is its problem: a timeout would be a gift)
{
  let calls = 0, gifts = 0;
  for (let k = 0; k < 60; k++) {
    const at = { ...root, t: 100, phase: 0, score: [17, 17], pos: 0, down: 3, ytg: 6, yl: 18, to: [2, 2], clock_running: true };
    const r = sim.step(at, { action: { to_off: false, play: 0 }, seed: 9500 + k });
    if (r.log.some((e) => e.ev === 'timeout' && e.team === 1)) calls++;
    for (const t of [55, 19, 6]) {
      const r2 = sim.step({ ...at, t, down: 2, to: [0, 2] }, { action: { to_off: false, play: 0 }, seed: 9500 + k });
      if (r2.log.some((e) => e.ev === 'timeout' && e.team === 1)) gifts++;
    }
  }
  assert.ok(calls > 50, `the defense saves time when a field goal would beat it: ${calls}/60`);
  assert.ok(gifts === 0, `the defense gives an offense out of timeouts one: ${gifts}/180`);
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
// personnel: a call with 12 (or 21, 13) personnel draws only real plays run with it, where there are enough; the heavy
// sets run more often against the loaded boxes they draw (the look bucket of the plays drawn)
{
  const S = eng.simulator(eng.makeContext(scen(idx.spots[0]).game, { receive2h: idx.spots[0].start.receive2h }));
  const P = eng.pb;
  assert.ok(P.ngs && P.ngs.pers, 'playbook.json carries personnel');
  const share = {};
  [11, 12, 21, 13].forEach((pers) => {
    let hit = 0, n = 0;
    for (const id of ['rb_inside_strong', 'quick_strong', 'pa_short']) {
      for (let fk = 0; fk < P.nFine; fk += 5) for (let k = 0; k < 40; k++) {
        const r = S.samplePlaybook(0, P.callIndex[id], fk, (k + 0.5) / 40, 0, 0, 0, undefined, undefined, pers);
        n++; if (P.ngs.pers[r] === pers) hit++;
      }
    }
    share[pers] = hit / n;
    assert.ok(hit / n > (pers === 13 ? 0.6 : 0.85), `personnel ${pers}: ${(100 * hit / n).toFixed(1)}% of plays drawn ran it`);
  });
  console.log('personnel: plays drawn with the grouping picked', Object.entries(share).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join('  '));
  // and through a whole snap
  const at = { ...root, t: 600, phase: 0, score: [10, 10], pos: 0, down: 1, ytg: 10, yl: 60, to: [3, 3], clock_running: false };
  const r = sim.step(at, { action: { to_off: false, play: 'run', call: 'rb_inside_strong', looks: 0, pers: 21 }, seed: 777 });
  const pe = r.log.find((e) => e.ev === 'play');
  assert.ok(pe && pe.row >= 0 && P.ngs.pers[pe.row] === 21, 'a 21-personnel run is a real 21-personnel run');
}
// Build a scenario (Pro, web/scenario.js, web/rosters: nflclock.scenario): every team-season the builder offers is a
// full team; random valid scenarios of every era, regular season and playoffs, overtime and kickoffs included, play to
// the end in the engine as game.js plays them (its startRoot, a second half from a first-half one, overtime started as
// game.js overtime() does), the football in range at every step: the clock never runs up, scores move by football
// numbers, a playoff game never ends tied, an overtime by the rules of its time
if (fs.existsSync(path.join(dir, 'rosters', 'index.json'))) {
  const SC = require('./scenario.js');
  const rix = JSON.parse(fs.readFileSync(path.join(dir, 'rosters', 'index.json'), 'utf8')), ros = {};
  const roster = (y) => (ros[y] = ros[y] || JSON.parse(fs.readFileSync(path.join(dir, 'rosters', `${y}.json`), 'utf8')));
  rix.seasons.forEach((s) => {
    const d = roster(s.season);
    s.teams.forEach((m) => {
      const t = d.teams[m.team], tag = `${s.season} ${m.team}`;
      assert.ok(t && t.lineup.off.length === 11 && t.lineup.def.length === 11 && t.lineup.off.some((p) => p.pos === 'QB'), `${tag} lineup`);
      assert.ok(t.kicker.name && t.punter.name && Math.abs(SC.strength(t) - m.net) < 1e-4, `${tag} specialists, strength`);
    });
  });
  // (game.js startRoot, otOf: the copies spot_info.js keeps)
  const startRoot = (sc) => {
    const st = sc.start, kick = st.phase === 'kick', po = ['WC', 'DIV', 'CON', 'SB'].includes(sc.real.type);
    const r = { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sc.home ? 0 : 1, score: [st.score[1], st.score[0]],
      down: kick ? 1 : st.down, ytg: kick ? 10 : Math.min(st.ytg, st.yl), yl: kick ? 65 : st.yl, to: [st.to[1], st.to[0]], clock_running: false,
      phase: kick ? 2 : 0, credit: 0, free_kick: false };
    if (st.qtr > 4) r.ot = { c: st.otc.slice(), po, n: 1, ...(sc.overtime.rules !== 'both' ? { r: sc.overtime.rules } : {}) };
    return r;
  };
  const R = ((a) => () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(2026);
  const tally = { games: 0, snaps: 0, ot: 0, half2: 0, kick: 0, po: 0, eras: new Set(), ties: 0 };
  const STEPS = new Set([0, 1, 2, 3, 6, 7, 8]);
  for (let g = 0; g < 60; g++) {
    const sc = SC.random(R, rix, g % 10 === 0 ? { qtr: 2, end: 'game' } : g % 7 === 0 ? { qtr: 5 } : undefined);
    assert.ok(sc && SC.ok(sc, rix), `a random scenario ${g}`);
    assert.deepStrictEqual(SC.parse(SC.code(sc)), sc, 'its code reads back');
    if (g < 6) {
      // a title rides in the link, never in the code: the same scenario whatever it is called; an old link (no title) reads
      // the same; a broken or refused title is dropped, the scenario kept; a refused one fails check()
      const t = ['Brady’s last stand', '  28–3   again ~ part 2 ', 'x'.repeat(60), 'sh1t show', '%E0%A4%A', ''][g];
      const named = { ...sc, title: t }, ln = SC.link(SC.tidy(named)), back = SC.parseLink(ln);
      assert.strictEqual(SC.code(named), SC.code(sc), 'a title is no part of the code');
      assert.strictEqual(back.code, SC.code(sc), `the link's code ${ln}`);
      assert.strictEqual(back.title, SC.blocked(t) ? '' : SC.cleanTitle(t), `the link's title ${ln}`);
      assert.deepStrictEqual(SC.parseLink(SC.code(sc)), { code: SC.code(sc), title: '' }, 'an old link');
      assert.strictEqual(SC.ok(named, rix), !SC.titleBad(t), `a title checked: ${t}`);
      assert.strictEqual(SC.summary(SC.tidy(named), (c, y) => `${y} ${c}`).name, SC.cleanTitle(t) || null, 'the card names it');
    }
    const { spot, teams } = SC.spotOf(sc, roster(sc.ys), roster(sc.os), rix.spread);
    const game = { home: teams.home, away: teams.away, home_spread: spot.spread, indoor: false, wind: 0, temp: null, league: spot.league,
      home_coach: teams.home.coach, away_coach: teams.away.coach, season: spot.real.season };
    const S = eng.simulator(eng.makeContext(game, { receive2h: spot.start.receive2h }));
    let r = startRoot(spot), k = 0, half2 = false;
    const tag = `${SC.code(sc)}`;
    tally.games++; tally.eras.add(Math.floor(sc.ys / 5) * 5); if (sc.start === 'kick') tally.kick++; if (sc.type !== 'REG') tally.po++;
    for (; k < 600; k++) {
      if (r.phase === 3) {
        if (spot.end === 'game' && r.t >= 1800 && !r.ot) {        // game.js secondHalf
          const recv = spot.start.receive2h === spot.home ? 0 : 1;
          r = { t: 1800 - 1e-6, pos: 1 - recv, score: r.score.slice(), down: 1, ytg: 10, yl: 65, to: [3, 3], clock_running: false, phase: 2, credit: 0, free_kick: false };
          half2 = true; continue;
        }
        if (r.t <= 0 && !r.ot && r.score[0] === r.score[1]) {       // game.js overtime: the coin toss's kickoff
          const po = sc.type !== 'REG', ot = spot.overtime;
          r = { t: ot.len, pos: R() < 0.5 ? 0 : 1, score: r.score.slice(), down: 1, ytg: 10, yl: 65, to: po ? [3, 3] : [2, 2], clock_running: false, phase: 2,
            credit: 0, free_kick: false, ot: { c: [0, 0], po, n: 1, ...(ot.rules !== 'both' ? { r: ot.rules } : {}) } };
          continue;
        }
        break;
      }
      const call = eng.pb.calls[Math.floor(R() * eng.pb.calls.length)];
      const action = r.phase === 0 ? (R() < 0.85 ? { to_off: false, play: call.kind, call: call.id } : {}) : r.phase === 2 ? { kick: R() < 0.9 ? 'deep' : 'onside' } : {};
      const nx = S.step(r, { action, seed: 31 * g + k });
      const b = r;
      r = nx.root;
      tally.snaps++;
      assert.ok(r.t <= b.t + 1e-9 || (r.ot && b.ot && r.ot.n === b.ot.n + 1 && r.t === 900 && sc.type !== 'REG'), `${tag}: the clock ran up (${b.t} -> ${r.t})`);
      for (const i of [0, 1]) assert.ok(STEPS.has(r.score[i] - b.score[i]), `${tag}: a score of ${r.score[i] - b.score[i]}`);
      assert.ok(r.phase !== 0 || (r.down >= 1 && r.down <= 4 && r.yl > 0 && r.yl < 100 && r.ytg >= 1 && r.ytg <= r.yl + 1e-9), `${tag}: ${JSON.stringify(r)}`);
      assert.ok(r.to.every((t) => t >= 0 && t <= 3), `${tag}: timeouts`);
    }
    assert.ok(r.phase === 3, `${tag}: did not end in ${k} steps (${JSON.stringify(r)})`);
    if (r.ot) tally.ot++;
    if (half2) { tally.half2++; assert.ok(r.t <= 0 || r.ot, `${tag}: the second half was played to the end`); }
    if (r.score[0] === r.score[1] && (spot.end === 'game' || sc.qtr > 2)) {
      tally.ties++;
      assert.ok(sc.type === 'REG' && r.ot, `${tag}: a tie only after a regular-season overtime`);
    }
    if (r.ot && r.ot.r === 'sd' && r.score[0] !== r.score[1]) assert.ok(Math.abs(r.score[0] - r.score[1]) <= 8, `${tag}: sudden death`);
  }
  console.log(`scenarios: ${rix.seasons.length} seasons (${rix.seasons[0].season}-${rix.seasons[rix.seasons.length - 1].season}), ${rix.seasons.reduce((a, s) => a + s.teams.length, 0)} team-seasons; ` +
    `${tally.games} random scenarios (eras ${[...tally.eras].sort().join(', ')}; ${tally.po} playoff, ${tally.kick} kickoffs, ${tally.half2} second halves, ${tally.ot} in overtime, ${tally.ties} ties), ${tally.snaps} steps`);
} else console.log('scenarios: web/rosters not built (nflclock.scenario.build), skipped');
console.log('smoke ok');
