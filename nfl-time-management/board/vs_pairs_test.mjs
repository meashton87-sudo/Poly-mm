// Every matchup: all 32 x 31 ordered pairs of teams (home and away both ways) play a whole college-overtime match on
// the room's simulator (lazy_sim.js) with the real engine, calls of every kind, and every snap checked against the
// rules.   node board/vs_pairs_test.mjs [seed]   (needs board/assets/vs)
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
