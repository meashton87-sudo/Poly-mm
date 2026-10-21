// Every matchup: all 32 x 31 ordered pairs of teams (home and away both ways) play a whole college-overtime match on
// the room's simulator (lazy_sim.js) with the real engine, calls of every kind, and every snap checked against the
// rules; then every pair again in the Five-Minute Drill (5:00 of the fourth quarter under the NFL clock: the toss, the
// kickoffs, timeouts, spikes, kneels, the two-minute warning, college overtime from a tie at 0:00), half of them at
// even strength (ranked) and half as the teams are.   node board/vs_pairs_test.mjs [seed]   (needs board/assets/vs)
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
if (!fs.existsSync(path.join(A, 'engine_data.pack'))) { console.log('pairs: no engine data (board/assets/vs), skipped'); process.exit(0); }
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const data = VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'engine_data.pack')))));
const eng = new NFLClockEngine(data);
eng.loadPlaybook(VSCore.unpack(ab(zlib.gunzipSync(fs.readFileSync(path.join(A, 'playbook.pack')))), data));
const pool = JSON.parse(fs.readFileSync(path.join(A, 'teams.json'), 'utf8')), T = Object.keys(pool.teams).sort();
assert.strictEqual(T.length, 32, 'all 32 teams');
for (const t of T) {
  const x = pool.teams[t];
  assert.ok(x.lineup && x.lineup.off && x.lineup.off.length === 11 && x.lineup.def && x.lineup.def.length === 11, `${t}: eleven on each side`);
  assert.ok(x.kicker && x.qb, `${t}: a quarterback and a kicker`);
}
const R = VSCore.rng(+(process.argv[2] || 7));
const pick = (a) => a[Math.floor(R() * a.length)];
const calls = eng.pb.calls;
const stats = { matches: 0, decisions: 0, plays: 0, dcs: 0, why: 0, tricks: 0, rounds: {}, td: 0, fg: 0, two: 0, picks: { offense: 0, defense: 0, end: 0 }, homeWins: 0 };
const t0 = Date.now();
for (const h of T) {
  for (const a of T) {
    if (h === a) continue;
    const step = VSCore.stepper(eng, pool, h, a, lazySimulator);
    let ms = VSCore.start(R() < 0.5 ? 1 : 0), n = 0;
    while (!ms.over) {
      assert.ok(++n < 1500, `${h}-${a}: ends`);
      const halves = {};
      for (const s of VSCore.need(ms)) {
        const role = VSCore.role(ms, s);
        let x = null;
        if (R() < 0.92) {
          if (role === 'pick') { x = { pick: pick(ms.cot.pick.end ? ['offense', 'defense'] : VSCore.PICKS) }; stats.picks[x.pick]++; }
          else if (role === 'defense') { x = { dc: { pers: pick(VSCore.DC.pers), front: pick(VSCore.DC.front), cover: pick(VSCore.DC.cover), rush: pick(VSCore.DC.rush) } }; stats.dcs++; }
          else if (role === 'pat') x = R() < 0.4 ? { two: true } : { action: { pat: 'xp' } };
          else if (R() < 0.05 && ms.root.down === 4) x = { action: { play: 'fg' } };
          else { const c = pick(calls); x = { action: { call: c.id, play: c.kind, looks: 0, ...(R() < 0.3 ? { pers: pick([11, 12, 21, 13]) } : {}) } }; }
        }
        halves[s] = VSCore.cleanHalf(ms, s, x, eng.pb);
      }
      const before = ms;
      const out = VSCore.apply(ms, halves, step, (R() * 4294967296) >>> 0);
      ms = out.ms;
      stats.decisions++;
      if (out.res) {
        stats.plays++;
        for (const e of out.res.log) { if (e.ev === 'pat' && e.two) stats.two++; if (e.ev === 'fg') { stats.fga = (stats.fga || 0) + 1; if (e.made) { stats.fg++; assert.strictEqual(ms.root.score[e.team] - before.root.score[e.team], 3, `${h}-${a}: a field goal is 3`); } } }
        if (out.res.log.some((e) => e.td || e.ev === 'td')) stats.td++;
        // the defense's call reaches the engine, and the play says why the matchup went as it did
        const dh = halves[1 - before.root.pos];
        if (before.root.phase === VSCore.SNAP && dh && dh.dc) {
          assert.deepStrictEqual(out.res.action.dc, dh.dc, `${h}-${a}: the defense's call is played`);
          const pe = out.res.log.find((e) => e.ev === 'play' && e.call >= 0);
          if (pe) { assert.ok(Array.isArray(pe.why), `${h}-${a}: the matchup's reasons`); stats.why++; }
        }
        if (out.res.action.seen !== undefined) stats.tricks++;
      }
      const r = ms.root;
      // the rules, every snap
      assert.ok(r.score[0] >= before.root.score[0] && r.score[1] >= before.root.score[1], `${h}-${a}: no points taken away`);
      if (!ms.over) {
        assert.strictEqual(r.t, VSCore.COT_T, `${h}-${a}: no clock`);
        assert.ok(!r.clock_running, `${h}-${a}: the clock never runs`);
        if (ms.cot.round >= 3 && !ms.cot.pick) assert.ok(r.try2 && r.phase === VSCore.SNAP, `${h}-${a}: 3rd overtime on: a two-point play`);
        if (ms.cot.round >= 2) assert.notStrictEqual(r.phase, VSCore.PAT, `${h}-${a}: 2nd overtime on: no kick`);
        if (out.kind === 'pick' && !ms.cot.pick) assert.ok(ms.cot.round >= 3 ? r.yl === 3 : r.yl === 25, `${h}-${a}: the ball where the rules put it`);
        if (ms.cot.idx === 1 && before.cot.idx === 0 && before.cot.round === ms.cot.round) assert.strictEqual(r.pos, ms.cot.order[1], `${h}-${a}: the other team's turn`);
        assert.ok([0, 1].includes(r.pos) && r.down >= 1 && r.down <= 4 && r.yl >= 1 && r.yl <= 99, `${h}-${a}: a real spot ${JSON.stringify(r)}`);
      }
      if (out.kind === 'pick' && before.cot.pick && !ms.cot.pick) {
        const P = before.cot.pick.team, ch = out.notes[0].choice;
        assert.strictEqual(ms.cot.order[0], ch === 'offense' ? P : 1 - P, `${h}-${a}: the choice decides who goes first`);
      }
      if (ms.cot.round > before.cot.round) {
        assert.strictEqual(before.root.score[0] + 0, before.root.score[0]);
        assert.strictEqual(ms.cot.pick.team, ms.cot.round % 2 ? ms.cot.toss : 1 - ms.cot.toss, `${h}-${a}: the choice alternates`);
        assert.strictEqual(ms.root.score[0], ms.root.score[1], `${h}-${a}: a new overtime only from a tie`);
      }
    }
    assert.notStrictEqual(ms.root.score[0], ms.root.score[1], `${h}-${a}: a winner`);
    assert.strictEqual(ms.winner, ms.root.score[0] > ms.root.score[1] ? 0 : 1);
    stats.rounds[ms.cot.round] = (stats.rounds[ms.cot.round] || 0) + 1;
    if (ms.winner === 0) stats.homeWins++;
    stats.matches++;
  }
}
console.log(JSON.stringify({ ...stats, secs: Math.round((Date.now() - t0) / 1000) }));
assert.strictEqual(stats.matches, 992, 'every ordered pair');
assert.ok(stats.fg > 0 && stats.two > 0, 'field goals and two-point plays happen');
console.log('every matchup ok: 992 matches, all 32 teams home and away');

// ---- the Five-Minute Drill
const F = { matches: 0, decisions: 0, snaps: 0, tosses: { heads: 0, tails: 0 }, tossWins: [0, 0], picks: { receive: 0, kick: 0, end: 0 }, kicks: 0, onside: 0, timeouts: 0, defTimeouts: 0,
  spikes: 0, kneels: 0, twoMin: 0, ot: 0, otRounds: {}, defaults: 0, homeWins: 0, even: 0, byClock: 0, snapsHist: {}, secsMatch: [] };
const t1 = Date.now();
const TEMPO = ['hurry', 'normal', 'milk', 'urgent'];
for (const h of T) {
  for (const a of T) {
    if (h === a) continue;
    const even = F.matches % 2 === 0;
    const step = VSCore.stepper(eng, pool, h, a, lazySimulator, even);
    let ms = VSCore.startFive(), n = 0, snaps = 0, wall = 0;
    assert.deepStrictEqual([ms.root.t, ms.root.to, ms.root.score, VSCore.need(ms), VSCore.role(ms, 0)], [300, [3, 3], [0, 0], [0], 'toss'], 'the Five-Minute Drill: 5:00, three timeouts, 0-0, seat 0 calls the toss');
    while (!ms.over) {
      assert.ok(++n < 600, `${h}-${a}: ends`);
      const halves = {}, r0 = ms.root;
      for (const s of VSCore.need(ms)) {
        const role = VSCore.role(ms, s), r = ms.root;
        let x = null;
        if (R() < 0.94) {
          if (role === 'toss') x = { call: pick(VSCore.COIN) };
          else if (role === 'pick' && !ms.cot) { x = { pick: pick(ms.reg.pick.end ? ['receive', 'kick'] : VSCore.REG_PICKS) }; F.picks[x.pick]++; }
          else if (role === 'pick') x = { pick: pick(ms.cot.pick.end ? ['offense', 'defense'] : VSCore.PICKS) };
          else if (role === 'kick') { x = { action: { kick: pick(['deep', 'return', 'touchback', R() < 0.1 ? 'onside' : 'deep']) } }; F.kicks++; if (x.action.kick === 'onside') F.onside++; }
          else if (role === 'defense') x = { dc: { pers: pick(VSCore.DC.pers), front: pick(VSCore.DC.front), cover: pick(VSCore.DC.cover), rush: pick(VSCore.DC.rush) }, ...(!ms.cot && r.clock_running && R() < 0.04 ? { to_def: true } : {}) };
          else if (role === 'pat') x = R() < 0.3 ? { two: true } : { action: { pat: 'xp' } };
          else if (!ms.cot && r.clock_running && r.to[s] > 0 && R() < 0.06) x = { timeout: true, ...(R() < 0.2 ? { rundown: true } : {}) };
          else if (!ms.cot && r.clock_running && R() < 0.03) x = { action: { play: 'spike' } };
          else if (!ms.cot && R() < 0.02) x = { action: { play: 'kneel' } };
          else if (r.down === 4 && R() < 0.3) x = { action: { play: pick(['fg', 'punt']) } };
          else { const c = pick(calls); x = { action: { call: c.id, play: c.kind, looks: 0, oob: R() < 0.1, ...(ms.cot ? {} : { tempo: pick(TEMPO) }), ...(R() < 0.3 ? { pers: pick([11, 12, 21, 13]) } : {}) } }; }
        } else F.defaults++;
        halves[s] = VSCore.cleanHalf(ms, s, x, eng.pb);
      }
      const before = ms, reg0 = !before.cot;
      const out = VSCore.apply(ms, halves, step, (R() * 4294967296) >>> 0);
      ms = out.ms;
      F.decisions++;
      const r = ms.root, tag = `${h}-${a} decision ${n}`;
      assert.ok(r.score[0] >= r0.score[0] && r.score[1] >= r0.score[1], `${tag}: no points taken away`);
      if (out.kind === 'toss') { F.tosses[out.notes[0].coin]++; F.tossWins[out.notes[0].winner]++; assert.strictEqual(out.notes[0].winner === 0, out.notes[0].call === out.notes[0].coin, `${tag}: seat 0 wins the toss it calls right`); }
      if (out.kind === 'pick' && reg0 && !ms.reg.pick) {
        const x = out.notes.find((y) => y.k === 'rpick');
        assert.strictEqual(r.phase, VSCore.KICKOFF, `${tag}: the pick, then the kickoff`);
        assert.strictEqual(r.pos, x.choice === 'kick' ? x.team : 1 - x.team, `${tag}: the kicking team is the one that chose to kick (or not to receive)`);
      }
      if (out.kind === 'timeout') {
        F.timeouts++;
        assert.ok(!r.clock_running && r.to[r0.pos] === r0.to[r0.pos] - 1 && r.t <= r0.t, `${tag}: a timeout stops the clock and costs one`);
        if (r0.t > 120) assert.ok(r.t >= 120, `${tag}: never past the two-minute warning`);
      }
      if (reg0) {
        // the NFL clock: it only runs down, never past 0:00; the timeouts only go down, three at most; the warning
        assert.ok(r.t <= r0.t + 1e-9 || ms.cot, `${tag}: the clock never goes back (${r0.t} -> ${r.t})`);
        if (!ms.cot) {
          assert.ok(r.t >= 0 && r.t <= 300, `${tag}: the clock in 0:00-5:00 (${r.t})`);
          assert.ok(r.to.every((x, i) => x >= 0 && x <= 3 && x <= r0.to[i]), `${tag}: timeouts ${r0.to} -> ${r.to}`);
          if (r.phase !== VSCore.DONE) assert.ok([0, 1].includes(r.pos) && r.down >= 1 && r.down <= 4 && r.yl >= 1 && r.yl <= 99, `${tag}: a real spot ${JSON.stringify(r)} from ${JSON.stringify(r0)} ${JSON.stringify(out.res && out.res.action)} ${JSON.stringify(out.res && out.res.log)}`);
        }
        if (out.res) {
          if (r0.phase === VSCore.SNAP) snaps++;
          for (const e of out.res.log) {
            if (e.ev === 'runoff' && r0.t > 120) { assert.ok(e.t >= 120 - 1e-6, `${tag}: the clock stops at the two-minute warning (${e.t})`); if (e.stop === '2mw') F.twoMin++; }
            if (e.ev === 'timeout' && e.team === 1 - r0.pos) F.defTimeouts++;
            if (e.ev === 'play' && e.kind === 3) F.spikes++;
            if (e.ev === 'play' && e.kind === 2) F.kneels++;
          }
          if (halves[1 - r0.pos] && halves[1 - r0.pos].to_def && r0.clock_running && r0.to[1 - r0.pos] > 0 && r0.phase === VSCore.SNAP && !r0.try2) {
            assert.ok(out.res.log.some((e) => e.ev === 'timeout' && e.team === 1 - r0.pos), `${tag}: the defense's timeout is taken`);
          }
          if (r0.phase === VSCore.SNAP && !(halves[1 - r0.pos] && halves[1 - r0.pos].to_def)) { const bad = out.res.log.find((e) => e.ev === 'timeout' && e.why !== 'kick' && e.why !== 'runoff'); assert.ok(!bad, `${tag}: nobody's timeout but a called one (or one the rules take: the kick, a 10-second runoff) ${JSON.stringify(bad)} ${JSON.stringify(out.res.action)}`); }
        }
        if (ms.cot && !before.cot) {
          F.ot++;
          assert.strictEqual(r0.score[0] + 0, r0.score[0]);
          assert.ok(ms.cot.score0[0] === ms.cot.score0[1] && r.score[0] === r.score[1], `${tag}: overtime only from a tie at 0:00`);
          assert.ok(out.notes.some((x) => x.k === 'ottoss') && ms.cot.pick, `${tag}: a fresh toss before overtime`);
        }
        if (ms.over && !ms.cot) { F.byClock++; assert.ok(out.res && (out.res.done || r.phase === VSCore.DONE), `${tag}: over at 0:00`); }
        wall += out.res ? 6 + 30 : 8;                  // (a decision's time on the phones: the play watched, the call)
      } else {
        assert.strictEqual(r.t, VSCore.COT_T, `${tag}: no clock in overtime`);
        assert.ok(!r.clock_running, `${tag}: no clock in overtime`);
        if (out.res) snaps++;
        wall += out.res ? 6 + 30 : 8;
      }
    }
    assert.notStrictEqual(ms.root.score[0], ms.root.score[1], `${h}-${a}: a winner`);
    assert.strictEqual(ms.winner, ms.root.score[0] > ms.root.score[1] ? 0 : 1);
    if (ms.cot) F.otRounds[ms.cot.round] = (F.otRounds[ms.cot.round] || 0) + 1;
    if (ms.winner === 0) F.homeWins++;
    if (even) F.even++;
    F.snaps += snaps;
    F.snapsHist[Math.floor(snaps / 5) * 5] = (F.snapsHist[Math.floor(snaps / 5) * 5] || 0) + 1;
    F.secsMatch.push(wall);
    F.matches++;
  }
}
const sm = F.secsMatch.sort((x, y) => x - y);
console.log(JSON.stringify({ ...F, secsMatch: undefined, snapsPerMatch: +(F.snaps / F.matches).toFixed(1), minutesAt30sCalls: { median: +(sm[sm.length >> 1] / 60).toFixed(1), p90: +(sm[Math.floor(sm.length * 0.9)] / 60).toFixed(1) }, secs: Math.round((Date.now() - t1) / 1000) }));
assert.strictEqual(F.matches, 992, 'every ordered pair, the Five-Minute Drill');
assert.ok(F.ot > 0 && F.byClock > 0 && F.timeouts > 0 && F.twoMin > 0 && F.kicks > 0, 'overtimes, games decided at 0:00, timeouts, the two-minute warning, kickoffs all happen');
assert.ok(F.tossWins[0] > 350 && F.tossWins[1] > 350, `the toss is a coin (${F.tossWins})`);
console.log('the Five-Minute Drill ok: 992 matches under the NFL clock');
