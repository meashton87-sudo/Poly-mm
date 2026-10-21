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
  // a pass you keep calling (game.js repOf, engine.js REPEAT_S): the same hitch a third, fourth and fifth time in four
  // snaps is drawn worse each time, still from real hitches
  const hitch = (s) => {
    let t = 0, n = 0;
    for (let fk = 0; fk < P.nFine; fk += 7) for (let k = 0; k < 200; k++) {
      const r = S.samplePlaybook(0, P.callIndex.quick_strong, fk, (k + 0.5) / 200, false, 0, s, 'hitch', 0);
      t += P.epa[r]; n++;
    }
    return t / n;
  };
  const hs = [0, -0.4, -0.8, -1.2].map(hitch);
  assert.ok(hs[2] < hs[0] && hs[3] < hs[2] && hs[3] < hs[0] - 0.1, `repeated hitch: ${hs.map((x) => x.toFixed(2))}`);
  // a pass to a receiver you picked is sacked (and scrambles, throws it away) as often as the call's real plays: those
  // have no target charted, so the route filter alone left every one out (engine.js _noTarget)
  const dropOnly = (route) => {
    let n = 0, k0 = 0;
    for (const id of ['quick_strong', 'deep_strong', 'pa_deep', 'roll_strong']) for (let fk = 0; fk < P.nFine; fk += 5) for (let k = 0; k < 60; k++) {
      const r = route ? S.samplePlaybook(0, P.callIndex[id], fk, (k + 0.5) / 60, false, 0, 0, 'out', 3) : S.samplePlaybook(0, P.callIndex[id], fk, (k + 0.5) / 60, false, 0, 0);
      if (r < 0 || P.flags[r] & 1) continue;
      n++; k0 += /sack/.test(P.eventNames[P.event[r]] || '') ? 1 : 0;
    }
    return k0 / n;
  };
  const sk0 = dropOnly(false), sk1 = dropOnly(true);
  assert.ok(sk1 > sk0 * 0.75 && sk1 < sk0 * 1.25, `sacks with a receiver picked: ${sk1.toFixed(3)} against ${sk0.toFixed(3)}`);
  console.log(`sacks: ${(100 * sk0).toFixed(1)}% of the calls' real plays, ${(100 * sk1).toFixed(1)}% with a receiver and route picked`);
  // a motion's read (game.js setMotion, act.cov): the pass is a real play run in the coverage the defense showed
  {
    const N = P.ngs, inCov = (cv) => {
      let ok = 0, n = 0;
      for (let fk = 0; fk < P.nFine; fk += 5) for (let k = 0; k < 40; k++) {
        S._cov = cv;
        const r = S.samplePlaybook(0, P.callIndex.quick_strong, fk, (k + 0.5) / 40, false, 0, 0, 'slant', 3);
        S._cov = 0;
        const m = r >= 0 ? N.cover[r] >> 4 : 0;
        if (m) { n++; ok += m === cv ? 1 : 0; }
      }
      return ok / n;
    };
    const cm = inCov(1), cz = inCov(2);
    assert.ok(cm > 0.9 && cz > 0.9, `motion's read: man ${cm.toFixed(2)}, zone ${cz.toFixed(2)}`);
    console.log(`a motion's read: ${(100 * cm).toFixed(0)}% of passes after a man read run in man, ${(100 * cz).toFixed(0)}% after a zone read in zone`);
  }
  console.log(`the hitch called again and again: ${hs.map((x) => x.toFixed(2)).join(' / ')} EPA (first or second time, third, fourth, fifth)`);
}
// personnel: a call with 12 (or 21, 13) personnel draws only real plays run with it, where there are enough (PB_LOOK_MIN
// of them, by their weights: fewer, and the situation's own plays are drawn, whatever their grouping, rather than the
// same few real plays snap after snap); the heavy sets run more often against the loaded boxes they draw (the look
// bucket of the plays drawn). Across every situation 11 personnel is drawn as picked nearly always, 12 three times in
// four, 21 and 13 (rarer in real late-game football) in a third to a half
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
    assert.ok(hit / n > ({ 11: 0.85, 12: 0.6, 21: 0.3, 13: 0.25 })[pers], `personnel ${pers}: ${(100 * hit / n).toFixed(1)}% of plays drawn ran it`);
  });
  console.log('personnel: plays drawn with the grouping picked', Object.entries(share).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join('  '));
  // and through a whole snap
  const at = { ...root, t: 600, phase: 0, score: [10, 10], pos: 0, down: 1, ytg: 10, yl: 60, to: [3, 3], clock_running: false };
  // a formation picked (engine.js FORM_CODE, pfOk: the play's look bits 0-1): most plays drawn ran from it, where its
  // plays are many (the shotgun on a quick pass, under center on a run); the pistol, 5% of snaps, when there are enough
  const FORM = { gun: 1, under: 2, pistol: 3 };
  for (const [form, id, want] of [['gun', 'quick_strong', 0.9], ['under', 'rb_inside_strong', 0.85], ['pistol', 'rb_middle', 0.5]]) {
    let n = 0, hit = 0;
    for (let k = 0; k < 60; k++) {
      const e = sim.step(at, { action: { to_off: false, play: P.calls[P.callIndex[id]].kind, call: id, form }, seed: 4300 + k }).log.find((x) => x.ev === 'play');
      if (!e || !(e.row >= 0) || e.penalty) continue;
      n++; if ((P.look[e.row] & 3) === FORM[form]) hit++;
    }
    console.log(`  formation ${form} on ${id}: ${hit} of ${n} plays drawn ran from it`);
    assert.ok(n && hit / n >= want, `formation ${form}: ${hit} of ${n}`);
  }
  // the backs in the backfield (act.bf, playbook.py _backfield: an empty set, two backs): passes to a picked receiver too
  if (P.bf) for (const [label, act0, code, want] of [['empty', { form: 'gun', bf: 0 }, 1, 0.8], ['two backs (21, the I)', { pers: 21, form: 'under', bf: 2 }, 3, 0.8]]) {
    let n = 0, hit = 0;
    for (let k = 0; k < 60; k++) {
      const e = sim.step(at, { action: { to_off: false, play: 'pass', call: 'quick_strong', route: 'out', who: 'WR', ...act0 }, seed: 5300 + k }).log.find((x) => x.ev === 'play');
      if (!e || !(e.row >= 0) || e.penalty || !P.bf[e.row]) continue;
      n++; if (P.bf[e.row] === code) hit++;
    }
    console.log(`  backfield ${label}: ${hit} of ${n} passes drawn ran from it`);
    assert.ok(n && hit / n >= want, `backfield ${label}: ${hit} of ${n}`);
  }
  const r = sim.step(at, { action: { to_off: false, play: 'run', call: 'rb_inside_strong', looks: 0, pers: 21 }, seed: 777 });
  const pe = r.log.find((e) => e.ev === 'play');
  assert.ok(pe && pe.row >= 0 && P.ngs.pers[pe.row] === 21, 'a 21-personnel run is a real 21-personnel run');
}
// Who plays, the quarterback (game.js teamOf, simScen; web/scenario.js withQb): every spot's teams carry that game's
// other quarterbacks (history.py qb_room: lineup.qbs, each with adj, what he brings), never the one lined up; another one
// put in is the lineup the engine sees: the team's pass rating with his adjustment for the starter's and each call he
// throws (scenario.js QB_CALLS: the playbook's passes but the receiver's own) moved by the difference, nothing else. His
// passes then go at his level (the plays drawn: EPA, completions, sacks, picks) and so does the drive (its win chance);
// a swap back is the real lineup, value for value
{
  const SC = require('./scenario.js');
  const passes = eng.pb.calls.filter((c) => c.kind === 'pass' && c.id !== 'trick_pass').map((c) => c.id);
  assert.deepStrictEqual([...SC.QB_CALLS].sort(), passes.sort(), 'the calls a quarterback throws are the playbook’s passes');
  let n = 0, worse = 0, big = null;
  const gaps = [];
  idx.spots.forEach((sp, i) => {
    for (const side of ['home', 'away']) {
      const t = TEAMS[i][side], qb = t.lineup.off.find((p) => p.pos === 'QB');
      (t.lineup.qbs || []).forEach((q) => {
        assert.ok(q.pos === 'QB' && typeof q.adj === 'number' && Math.abs(q.adj) < 0.3 && q.name && q.name !== qb.name && q.ovr >= 40 && q.ovr <= 99, `${sp.id} ${t.team} ${q.name}`);
        const d = q.adj - t.qb.adjustment;
        n++; if (d < 0) worse++; gaps.push(Math.abs(d));
        if (side === (sp.player === sp.home ? 'home' : 'away') && (!big || d < big.d)) big = { sp, side, q, d };
      });
    }
  });
  gaps.sort((a, b) => a - b);
  console.log(`quarterbacks: ${n} others on the spots' rosters, ${worse} of them throwing worse than the one who played; the gap a dropback: median ${gaps[gaps.length >> 1].toFixed(3)} EPA, 90th percentile ${gaps[Math.floor(gaps.length * 0.9)].toFixed(3)}`);
  assert.ok(n > idx.spots.length, 'most teams have another quarterback');
  const { sp, side, q, d } = big, base = scen(sp), mine = base.game[side];
  const swapped = SC.withQb(mine, q.name), game = { ...base.game, [side]: swapped };
  assert.ok(swapped !== mine && mine.lineup.off[0].name !== q.name && swapped.lineup.off.some((p) => p.pos === 'QB' && p.name === q.name), 'he lines up');
  assert.ok(swapped.lineup.off.filter((p) => p.pos !== 'QB').every((p, k) => p === mine.lineup.off.filter((x) => x.pos !== 'QB')[k]), 'nobody else moves');
  const me = side === 'home' ? 0 : 1, c0 = eng.makeContext(base.game, { receive2h: sp.start.receive2h }), c1 = eng.makeContext(game, { receive2h: sp.start.receive2h });
  assert.ok(Math.abs(c1.delta[me][1] - c0.delta[me][1] - d) < 1e-9 && c1.delta[me][0] === c0.delta[me][0], 'his adjustment, on the pass rating only');
  assert.deepStrictEqual(c1.delta[1 - me], c0.delta[1 - me], 'their offense as it was');
  eng.pb.calls.forEach((c, k) => assert.ok(Math.abs(c1.pbDelta[me][k] - c0.pbDelta[me][k] - (SC.QB_CALLS.includes(c.id) ? d : 0)) < 2e-5, `call ${c.id}`));
  const back = SC.withQb(swapped, mine.lineup.off.find((p) => p.pos === 'QB').name);
  assert.ok(Math.abs(back.qb.adjustment - mine.qb.adjustment) < 1e-12 && SC.QB_CALLS.every((id) => Math.abs((back.calls[id] || { off: 0 }).off - ((mine.calls[id] || {}).off || 0)) < 2e-5), 'a swap back');
  const s0 = eng.simulator(c0), s1 = eng.simulator(c1), P = eng.pb;
  const draw = (S_, ids) => {
    let t = 0, k = 0, comp = 0, att = 0, sack = 0, pick = 0;
    for (const id of ids) for (let fk = 0; fk < P.nFine; fk += 3) for (let u = 0; u < 60; u++) {
      const r = S_.samplePlaybook(me, P.callIndex[id], fk, (u + 0.5) / 60, 0, 0, 0);
      const f = P.flags[r], ev = P.eventNames[P.event[r]] || '';
      if (f & 1) continue;
      t += P.epa[r]; k++;
      if (/sack/.test(ev)) sack++; else if (!/scramble/.test(ev)) { att++; if (!(f & 4) && !(f & 64)) comp++; if ((f & 64) && /interception|pick_six/.test(ev)) pick++; }
    }
    return { epa: t / k, comp: comp / att, sack: sack / k, pick: pick / att };
  };
  const ids = ['quick_strong', 'quick_middle', 'deep_strong', 'pa_short', 'roll_weak'];
  const a = draw(s0, ids), b = draw(s1, ids);
  assert.ok(Math.sign(b.epa - a.epa) === Math.sign(d) && Math.abs(b.epa - a.epa - d) < 0.5 * Math.abs(d) + 0.01, `his passes at his level: ${a.epa.toFixed(3)} -> ${b.epa.toFixed(3)} (${d.toFixed(3)})`);
  const run0 = draw(s0, ['rb_middle']), run1 = draw(s1, ['rb_middle']);
  assert.ok(Math.abs(run1.epa - run0.epa) < 1e-9, 'a handoff as it was');
  const st = sp.start, root = { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: me, score: [st.score[1], st.score[0]], down: st.down,
    ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]], clock_running: st.running, phase: 0, credit: 0, free_kick: false };
  const wp = (S_) => S_.run(root, { n: 3000, action: { to_off: false, play: 'pass', call: 'quick_strong' }, perspective: me, seed: 11 }).mean;
  const w0 = wp(s0), w1 = wp(s1);
  assert.ok(d < 0 ? w1 < w0 : w1 > w0, `the drive with him: ${w0.toFixed(3)} -> ${w1.toFixed(3)}`);
  console.log(`  ${sp.id} ${mine.team}: ${mine.qb.name} (${mine.qb.adjustment.toFixed(3)}) -> ${q.name} (${q.adj.toFixed(3)}), ${d.toFixed(3)} EPA a dropback: ` +
    `his passes ${a.epa.toFixed(3)} -> ${b.epa.toFixed(3)} EPA, caught ${(100 * a.comp).toFixed(1)}% -> ${(100 * b.comp).toFixed(1)}%, sacked ${(100 * a.sack).toFixed(1)}% -> ${(100 * b.sack).toFixed(1)}%, ` +
    `picked ${(100 * a.pick).toFixed(1)}% -> ${(100 * b.pick).toFixed(1)}%; the drive's win chance ${(100 * w0).toFixed(1)}% -> ${(100 * w1).toFixed(1)}%`);
}
// players' reports, each checked against the real rate:
// (1) "defensive offside is not an automatic first down": a real 5-yard defensive foul (offside, neutral zone,
// encroachment, too many men) is a first down only when its 5 yards reach the line to gain; holding, pass interference,
// illegal contact, roughing are a first down whatever the distance (library.py auto_first_down). The real rows, played
// on 1st and 10, 3rd and 2 and 2nd and 20 through the engine's own _scrimmage
{
  const P = eng.pb, S0 = { t: 900, pos: 0, s: [7, 7], down: 1, ytg: 10, yl: 50, to: [3, 3], running: false, credit: 0, phase: 0, freeKick: false, plays: 0 };
  const g0 = sim._geom({ ...root, t: 900 }), u = new Float64Array(8);
  const rowsOf = (names) => { const ix = names.map((n) => P.penNames.indexOf(n)); const out = []; for (let r = 0; r < P.yards.length; r++) if ((P.flags[r] & 1) && ix.includes(P.pen[r]) && P.yards[r] === 5) out.push(r); return out; };
  const after = (r, down, ytg) => { const S = { ...S0, s: [7, 7], to: [3, 3], down, ytg }; sim._scrimmage(S, g0, u, 0, 1, 0, false, false, r, -1, 0, null, false); return S; };
  const five = rowsOf(['Defensive Offside', 'Neutral Zone Infraction', 'Encroachment', 'Defensive Too Many Men on Field']);
  const auto = rowsOf(['Defensive Holding', 'Illegal Contact', 'Illegal Use of Hands']);
  assert.ok(five.length > 500 && auto.length > 300, `5-yard fouls in the playbook: ${five.length}, automatic: ${auto.length}`);
  let fd1 = 0, fd3 = 0, fdAuto = 0;
  for (const r of five) {
    const a = after(r, 1, 10), b = after(r, 3, 2);
    assert.ok(a.down === 1 && Math.abs(a.ytg - 5) < 1e-9, `a 5-yard ${P.penNames[P.pen[r]]} on 1st and 10 is 1st and 5: ${a.down} and ${a.ytg}`);
    if (a.down === 1 && a.ytg === 10) fd1++;
    if (b.down === 1 && b.ytg === 10) fd3++;
  }
  for (const r of auto) { const a = after(r, 2, 20); if (a.down === 1 && a.ytg === 10) fdAuto++; }
  assert.ok(fd1 === 0 && fd3 === five.length && fdAuto === auto.length, `fouls' first downs: 1st & 10 ${fd1}, 3rd & 2 ${fd3}/${five.length}, automatic on 2nd & 20 ${fdAuto}/${auto.length}`);
  console.log(`5-yard defensive fouls (${five.length} real rows): a first down on 1st & 10 ${fd1}, on 3rd & 2 ${fd3}; holding/illegal contact/hands (${auto.length}) on 2nd & 20: ${fdAuto}`);
}
// (2) "I keep getting fumbles on hail mary": the Hail Mary's real plays (playbook.py: a deep heave or its sack or
// scramble in the last 12 seconds of a half, 38-70 yards out; no lateral chains) fumble at the real rate or less:
// nflverse 2016-26, 504 of them, 5.0% had a fumble (mostly strip-sacks), 2.6% lost (none on a lateral: those are not
// Hail Marys). Drawn from every 5th spot's two teams, at 0:06 from midfield and from their 40, against each look
{
  let n = 0, fum = 0, lost = 0, picks = 0, tds = 0;
  idx.spots.forEach((sp, si) => {
    if (si % 5) return;
    const S = eng.simulator(eng.makeContext(scen(sp).game, { receive2h: sp.start.receive2h }));
    for (const yl of [50, 60]) for (let k = 0; k < 40; k++) {
      const at = { ...root, t: 6, phase: 0, score: [17, 20], pos: 0, down: 1, ytg: 10, yl, to: [0, 1], clock_running: false };
      const e = S.step(at, { action: { to_off: false, play: 'pass', call: 'hail_mary', looks: [0, 1, 2, 4, 8][k % 5] }, seed: 31 * si + 7 * yl + k }).log.find((x) => x.ev === 'play');
      const ev = e && e.row >= 0 ? eng.pb.eventNames[eng.pb.event[e.row]] : '';
      n++; if (/fumble|strip|scoop|bad_snap/.test(ev)) { fum++; if (e.turnover) lost++; }
      if (/interception|pick/.test(ev)) picks++; if (e && e.td) tds++;
    }
  });
  assert.ok(fum / n >= 0.01 && fum / n <= 0.08 && lost / n <= 0.04, `Hail Mary fumbles: ${(100 * fum / n).toFixed(1)}% (lost ${(100 * lost / n).toFixed(1)}%), real 5.0% (2.6%)`);
  console.log(`Hail Mary (${n}): fumbles ${(100 * fum / n).toFixed(1)}% (lost ${(100 * lost / n).toFixed(1)}%; real 5.0%, 2.6%), interceptions ${(100 * picks / n).toFixed(1)}%, touchdowns ${(100 * tds / n).toFixed(1)}%`);
}
// (3) "a returner who catches a punt in the end zone should be able to kneel it or let it go": their punt with your
// return set up (st 'return') never comes out of the end zone (a touchback at the 20: 939 of the 945 real punts that
// got there were); asked to run it out ('ezret') he brings out what reaches it, to where real returns of punts fielded
// at the 5 or deeper went (the 15 on average): worse than the 20, as the grade says
{
  const out = {};
  for (const st of [undefined, 'return', 'ezret']) {
    let n = 0, tb = 0, ran = 0, start = 0;
    for (let k = 0; k < 3000; k++) {
      const at = { ...root, t: 1500, phase: 0, score: [10, 10], pos: 0, down: 4, ytg: 10, yl: [45, 50, 55, 60][k % 4], to: [3, 3], clock_running: false };
      const r = sim.step(at, { action: { to_off: false, play: 'punt', ...(st ? { st } : {}) }, seed: 4000 + k });
      const e = r.log.find((x) => x.ev === 'punt');
      if (!e || e.blocked || e.retTd) continue;
      n++; if (e.touchback) tb++;
      start += 100 - r.root.yl;                 // (where they start: a touchback at the 20)
      if (e.land <= 0 && !e.touchback) ran++;
      assert.ok(!e.touchback || r.root.yl === 80, `a punt touchback at the 20: ${JSON.stringify(e)}`);
      if (st === 'return') assert.ok(e.land > 0 || e.touchback, `fielded in the end zone with the return set up: a touchback (${JSON.stringify(e)})`);
    }
    out[st || 'plain'] = { tb: tb / n, ran: ran / n, start: start / n };
  }
  assert.ok(out.return.tb >= out.plain.tb && out.return.ran === 0, `punts: the return set up downs it in the end zone: ${JSON.stringify(out)}`);
  // (run out, a few are still downed in the end zone: a return of no gain from the goal line)
  assert.ok(out.ezret.tb < out.return.tb * 0.35 && out.ezret.ran > 0.5 * out.return.tb && out.ezret.start < out.return.start, `punts: run it out brings them out: ${JSON.stringify(out)}`);
  console.log('their punts from 45-60 yards out:', Object.entries(out).map(([k, v]) => `${k}: touchbacks ${(100 * v.tb).toFixed(1)}%, run out of the end zone ${(100 * v.ran).toFixed(1)}%, they start at their ${v.start.toFixed(1)}`).join('; '));
}
// (4) "two straight 26-yard field goals missed": the kick's odds by distance are the real ones (nflverse 2016-26, made
// 20-29 yards: 97.8% of 2,492; 26 yards 97.6% of 253) and no kicker on any spot (the punter kicking included: Los
// Angeles' Ethan Evans, Oct 18, 2026, rated no better than the league's worst kicker) drops a 26-yarder below 95%
{
  let lo = 1, who = '', s20 = 0, n20 = 0;
  idx.spots.forEach((sp, si) => {
    const S = eng.simulator(eng.makeContext(scen(sp).game, { receive2h: sp.start.receive2h }));
    for (const t of [0, 1]) {
      const p = S.fgProb(26, t);
      if (p < lo) { lo = p; who = `${sp.id} ${(t ? TEAMS[si].away : TEAMS[si].home).kicker.name}`; }
      for (let d = 20; d <= 29; d++) { s20 += S.fgProb(d, t); n20++; }
    }
  });
  assert.ok(lo >= 0.95 && s20 / n20 > 0.965 && s20 / n20 < 0.99, `field goals: 26 yards at least ${lo.toFixed(3)} (${who}); 20-29 ${(s20 / n20).toFixed(3)}`);
  console.log(`field goals: 20-29 yards ${(100 * s20 / n20).toFixed(1)}% on average (real 97.8%), a 26-yarder at least ${(100 * lo).toFixed(1)}% (${who})`);
}
// (5) "+5 yards from the 5 and no touchdown": a punt lands the ball on a whole yard line (the punter's rating moves the
// net by a fraction of a yard: rounded up or down by chance, so it keeps its mean), so a gain the field shows reaching
// the goal line is a touchdown
{
  let n = 0, frac = 0;
  for (let k = 0; k < 4000; k++) {
    const at = { ...root, t: 1500, phase: 0, score: [10, 10], pos: k % 2, down: 4, ytg: 8, yl: 40 + (k % 45), to: [3, 3], clock_running: false };
    const r = sim.step(at, { action: { to_off: false, play: 'punt' }, seed: 20000 + k });
    if (r.root.phase !== 0) continue;
    n++; if (r.root.yl % 1) frac++;
  }
  assert.ok(n > 3500 && frac === 0, `punts land on whole yard lines: ${frac} of ${n} not`);
  console.log(`punts: ${n} played, every one on a whole yard line`);
}
// (6) blocked kicks: every field goal and extra point can be blocked, at the NFL's rate (2016-25: 0.5% under 30 yards,
// 1.6% at 30-44, 2.8% at 45-59, 10% from 60; extra points 0.9%), the make chance still the kick model's, and a blocked
// one plays out as one (the defense's ball behind the line, or a touchdown now and then)
{
  const at = (yl) => ({ ...root, t: 1500, phase: 0, score: [10, 10], pos: 0, down: 4, ytg: 5, yl, to: [3, 3], clock_running: false });
  const rows = [];
  for (const [yl, lo, hi] of [[10, 0.002, 0.009], [25, 0.011, 0.02], [36, 0.021, 0.034], [45, 0.075, 0.125]]) {
    let n = 0, made = 0, p = 0, blk = 0, td = 0;
    for (let k = 0; k < 6000; k++) {
      const r = sim.step(at(yl), { action: { to_off: false, play: 'fg' }, seed: 30000 + k }), e = r.log.find((x) => x.ev === 'fg');
      n++; p += e.p; if (e.made) made++;
      if (e.blocked) {
        blk++;
        assert.ok(!e.made && (e.retTd ? r.root.phase === 1 && r.root.pos === 1 && r.root.score[1] === 16 : r.root.pos === 1 && r.root.yl === Math.max(1, 100 - (yl + 12))), `a blocked kick plays out: ${JSON.stringify(e)} ${JSON.stringify(r.root)}`);
        if (e.retTd) td++;
      }
    }
    assert.ok(blk / n >= lo && blk / n <= hi && Math.abs(made - p) <= 4 * Math.sqrt(p), `${yl + 17}-yard field goals: ${(100 * blk / n).toFixed(2)}% blocked, made ${made} of ${n} (the model ${p.toFixed(0)})`);
    rows.push(`${yl + 17} yd ${(100 * blk / n).toFixed(1)}% (${td} run back)`);
  }
  let n = 0, blk = 0;
  for (let k = 0; k < 8000; k++) { const e = sim.step({ ...root, t: 1500, phase: 1, score: [16, 10], pos: 0, down: 1, ytg: 2, yl: 2, clock_running: false }, { action: { pat: 'xp' }, seed: 40000 + k }).log.find((x) => x.ev === 'pat'); n++; if (e.blocked) { blk++; assert.ok(!e.good, 'a blocked extra point is no good'); } }
  assert.ok(blk / n > 0.004 && blk / n < 0.014, `extra points blocked: ${(100 * blk / n).toFixed(2)}%`);
  console.log(`blocked kicks: field goals ${rows.join(', ')}; extra points ${(100 * blk / n).toFixed(2)}% (real 0.86%)`);
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
    // every third one with a lineup of its own (the builder's Lineups: a backup quarterback, a receiver or kicker of the
    // season's), its code read back, the picks on the field and the quarterback's adjustment the team's
    let want = null;
    if (g % 3 === 0) {
      const lu = {};
      for (const [side, c, y] of [['you', sc.you, sc.ys], ['opp', sc.opp, sc.os]]) {
        const p = {};
        SC.slots(roster(y).teams[c]).forEach((x) => { if ((x.k === 'q' || R() < 0.25) && x.cands.length > 1) { const pk = x.cands[1 + Math.floor(R() * (x.cands.length - 1))]; p[x.slot] = SC.pid(pk.name); } });
        if (!SC.checkLineup({ ...sc, lu: { [side]: p } }, roster(sc.ys), roster(sc.os)).length && Object.keys(p).length) lu[side] = p;
      }
      if (Object.keys(lu).length) {
        sc.lu = lu;
        assert.deepStrictEqual(SC.parse(SC.code(sc)), sc, `a lineup's code reads back: ${SC.code(sc)}`);
        want = SC.lineupOf(roster(sc.ys).teams[sc.you], lu.you);
        tally.lineups = (tally.lineups || 0) + 1;
      }
    }
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
    if (want) {
      const t = teams[spot.home === sc.you ? 'home' : 'away'], qb = t.lineup.off.find((p) => p.pos === 'QB');
      assert.ok(qb.name === want.q1.name && t.qb.name === want.q1.name && Math.abs(t.qb.adjustment - (want.q1.adj ?? roster(sc.ys).teams[sc.you].qb.adjustment)) < 1e-12, `${SC.code(sc)}: the quarterback picked plays`);
      Object.entries(want).forEach(([slot, p]) => assert.ok(slot === 'k1' ? t.kicker.name === p.name : t.lineup.off.some((x) => x.name === p.name), `${SC.code(sc)}: ${slot} ${p.name} plays`));
    }
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
    `${tally.games} random scenarios (eras ${[...tally.eras].sort().join(', ')}; ${tally.po} playoff, ${tally.kick} kickoffs, ${tally.half2} second halves, ${tally.ot} in overtime, ${tally.ties} ties, ${tally.lineups || 0} with lineups of their own), ${tally.snaps} steps`);
  assert.ok(tally.lineups >= 10, 'scenarios with lineups of their own');
} else console.log('scenarios: web/rosters not built (nflclock.scenario.build), skipped');
// a personnel group (Who plays: any swap plays the lined-up group, game.js) never narrows a call to a few real plays:
// the same result snap after snap (Oct 20: the day's 12 personnel drew a 3-yard loss on 4 of 10 runs at the Dallas
// 16, and 21 personnel the same no-gain run on every snap)
{
  const picks = [...new Set([...Object.values(idx.featured || {}).flatMap((f) => (f.sides || []).map((x) => x.spot)), ...idx.spots.map((_, i) => i).filter((i) => i % 53 === 0)])].slice(0, 18);
  const calls = eng.pb.calls.filter((c) => (c.kind === 'run' || c.kind === 'pass') && !/^trick|hail_mary|qb_sneak/.test(c.id));
  const N = 100, worst = [];
  let checked = 0;
  for (const si of picks) {
    const sp = idx.spots[si], S = scen(sp), st = sp.start;
    if (st.phase === 'kick') continue;
    const sim = eng.simulator(eng.makeContext(S.game, { receive2h: st.receive2h }));
    const at = { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sp.home ? 0 : 1, score: [st.score[1], st.score[0]],
      down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]], clock_running: st.running, phase: 0, credit: 0, free_kick: false };
    // the real plays a hundred snaps draw (rows), and the most common result (a different group's plays end
    // differently, which is the point; the same few plays every time is the bug)
    const of = (c, pers) => {
      const n = {}, rows = new Set();
      for (let k = 0; k < N; k++) {
        const e = sim.step(at, { action: { to_off: false, play: c.kind, call: c.id, ...(pers || {}) }, seed: 6100 + k }).log.find((x) => x.ev === 'play');
        if (!e) continue;
        if (e.row >= 0) rows.add(e.row);
        if (e.incomplete) continue;
        const key = `${e.yards}|${e.evt || ''}|${e.td ? 1 : 0}`;
        n[key] = (n[key] || 0) + 1;
      }
      return { top: Math.max(0, ...Object.values(n)) / N, rows: rows.size };
    };
    for (const c of calls) {
      const base = of(c, 0);
      // (and the formations the plays are charted by, engine.js FORM_CODE, alone and with a grouping: the same guard)
      for (const pick of [{ pers: 11 }, { pers: 12 }, { pers: 21 }, { pers: 13 }, { form: 'gun' }, { form: 'under' }, { form: 'pistol' }, { pers: 11, form: 'pistol' }, { pers: 12, form: 'under' }]) {
        const g = of(c, pick);
        checked += 1;
        if (g.rows < 8 || g.top > Math.max(0.35, base.top + 0.2)) worst.push(`${sp.id} ${c.id} ${JSON.stringify(pick)}: ${g.rows} real plays in ${N} snaps (${base.rows}), the most common result ${g.top} (${base.top})`);
      }
    }
  }
  console.log(`personnel and formations: ${checked} calls and picks on ${picks.length} spots, ${worst.length} narrowed to a few plays`);
  assert.ok(!worst.length, `a personnel group or a formation narrows a call to a few real plays: ${worst.slice(0, 6).join('; ')}`);
}
console.log('smoke ok');
