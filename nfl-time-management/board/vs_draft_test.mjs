// Versus Draft against the computer, with the real engine (board/assets/vs): the blind auction from the lobby to the
// two drafted sides, then the match to the end. The sides are checked as teams (eleven on offense, a quarterback, the
// ratings within the league's, the picked men on the field), the money adds up, nothing blind leaks while the draft
// is on. Usage: node board/vs_draft_test.mjs [matches]
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, FakeClient } from './vs_world.mjs';
import { CPU_SEAT, OPEN_MS, RAISE_MS, loadEngine } from './match.js';
import VSCore from '../web/vs_core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.VS_ASSETS || path.join(HERE, 'assets');
if (!fs.existsSync(path.join(ASSETS, 'vs', 'engine_data.pack'))) { console.error(`no engine data in ${ASSETS}/vs (build the site first)`); process.exit(1); }
const N = +(process.argv[2] || 12);
const R = VSCore.rng(777);
const w = new World({ assetsDir: ASSETS });
const E = await loadEngine(w.env);
const CALLS = E.eng.pb.calls.filter((c) => c.id !== 'hail_mary' && c.id !== 'qb_sneak');
const DC = { pers: 'nickel', front: 'even', cover: 'c3', rush: 4 };
const league = Object.values(E.pool.teams).filter((t) => t && t.base);
const range = (f) => { const xs = league.map((t) => t.base[f]); return [Math.min(...xs), Math.max(...xs)]; };
const RANGE = { off_pass: range('off_pass'), off_rush: range('off_rush'), def_pass: range('def_pass'), def_rush: range('def_rush') };
const out = { won: 0, snaps: 0, spent: [], passed: 0, cards: 0, fillers: 0 };
for (let i = 0; i < N; i++) {
  const q = new FakeClient(w, `draft-test-device-${String(i).padStart(7, '0')}`);
  assert.strictEqual(await q.queue({ mode: 'cpu', draft: '1', team: '', name: `D${i}` }), 101);
  const m = q.last('match');
  assert.ok(m && m.mode === 'cpu', 'a computer room at once');
  const A = new FakeClient(w, q.key);
  await A.open(m.room, { mode: 'cpu' });
  const room = () => w.objects.get(`room:${m.room}`).store.get('room');
  assert.strictEqual(room().phase, 'draft', 'the draft is on');
  await w.advance(100);                                              // (the alarm draws the pool)
  assert.ok(room().draft.pool, 'the pool is drawn at once');
  // the bidding: a third of the cards left to the computer, the rest bid up to a random share of the most
  for (let k = 0; k < 400 && room().phase === 'draft'; k++) {
    const S = room(), d = S.draft, card = d.pool[d.i];
    const v = A.last('draft') ? A.last('draft').d : A.last('hello').draft;
    assert.ok(v && 'name' in v.card && !('ovr' in v.card) && v.picks.every((ps) => ps.every((p) => 'name' in p && !('ovr' in p))), 'the men named, the ratings never, while it is on');
    const mx = VSCore.draftMax(d, 0, card), goal = Math.floor(mx * (0.2 + 0.8 * R()));
    const b = d.bid, want = b ? b.amount + 1 : VSCore.draftFloor(d, 0, card);
    if (mx && R() < 0.67 && !(b && b.seat === 0) && want <= goal) { A.send({ t: 'bid', i: d.i, amount: want }); await w.settle(); }
    await w.advance(700);
  }
  const S0 = room();
  assert.strictEqual(S0.phase, 'live', 'the draft ended and the match is on');
  const d = S0.draft, T = S0.draftTeams;
  assert.deepStrictEqual(S0.teams, ['DR1', 'DR2']);
  out.cards += d.i; out.spent.push(50 - d.budget[0]);
  out.passed += d.pool.slice(0, d.i).filter((c, j) => !d.picks[0].some((p) => p.name === c.name && p.team === c.team) && !d.picks[1].some((p) => p.name === c.name && p.team === c.team)).length;
  for (const s of [0, 1]) {
    const code = VSCore.DRAFT.teams[s], t = T[code], picks = d.picks[s];
    assert.strictEqual(picks.length, 7, 'seven picks a side');
    assert.strictEqual(picks.reduce((a, p) => a + p.paid, 0), 50 - d.budget[s], 'the money adds up');
    for (const p of picks.filter((x) => !x.filler)) assert.ok(p.paid >= (p.sticker || 1), `${p.name} went for his sticker or more ($${p.paid}, sticker $${p.sticker})`);
    assert.ok(d.budget[s] >= 0, 'never in debt');
    out.fillers += picks.filter((p) => p.filler).length;
    assert.strictEqual(t.lineup.off.length, 11, 'eleven on offense');
    assert.strictEqual(t.lineup.off.filter((p) => p.pos === 'QB').length, 1, 'one quarterback');
    assert.ok(t.lineup.def.length >= 11, 'a defense');
    for (const f of Object.keys(RANGE)) assert.ok(t.base[f] >= RANGE[f][0] - 1e-9 && t.base[f] <= RANGE[f][1] + 1e-9, `${f} within the league (${t.base[f]})`);
    for (const p of picks.filter((x) => ['QB', 'RB', 'WR', 'TE'].includes(x.k))) assert.ok(t.lineup.off.some((y) => y.name === p.name), `${p.name} on the field`);
    assert.ok(t.kicker && t.kicker.name, 'a kicker');
    assert.strictEqual(t.team, code);
  }
  const fin = A.all('draft').slice(-1)[0];
  assert.ok(fin && fin.d.done && fin.d.picks[0].every((p) => p.name), 'the reveal went to the phone');
  // the match
  for (let k = 0; k < 600; k++) {
    const S = room();
    if (S.phase !== 'live') break;
    const need = VSCore.need(S.ms), pend = w.objects.get(`room:${m.room}`).store.get('pend');
    if (need.includes(CPU_SEAT)) assert.ok(pend && pend.n === S.n && CPU_SEAT in pend.halves, 'the computer is never waited on');
    if (!need.includes(0)) { await w.advance(500); continue; }
    const role = VSCore.role(S.ms, 0);
    let half;
    if (role === 'pick') half = { pick: R() < 0.5 ? 'offense' : 'defense' };
    else if (role === 'pat') half = { action: { pat: 'xp' } };
    else if (role === 'defense') half = { dc: DC };
    else if (role === 'intent') half = { intent: R() < 0.5 ? 'go' : VSCore.intentsAt(S.ms.root).slice(-1)[0] };
    else if (role === 'kick') half = { kick: true };
    else { const c = CALLS[Math.floor(R() * CALLS.length)].id; half = { action: { call: c, play: E.eng.pb.calls.find((x) => x.id === c).kind === 'run' ? 'run' : 'pass' } }; out.snaps++; }
    A.send({ t: 'half', n: S.n, half });
    await w.settle();
  }
  const S = room();
  assert.strictEqual(S.phase, 'over', 'every match ends');
  assert.strictEqual(S.result.by, 'score', `on the scoreboard: ${JSON.stringify(S.result)}`);
  assert.strictEqual(S.rated, null, 'never rated');
  if (S.result.winner === 0) out.won++;
  if (i === 0) console.log('a drafted side:', d.picks[0].map((p) => `${p.k} ${p.team} ${p.name} $${p.paid}${p.filler ? ' (filled)' : ''}`).join('; '));
  A.drop(); q.drop();
}
const lad = (await w.http('ladder', '/vs/ladder')).body;
assert.strictEqual(lad.players, 0, 'nobody on the ladder from a draft');
console.log(`vs draft ok: ${N} drafts and matches, the player won ${out.won}, spent ${JSON.stringify(out.spent)} of 50, ${out.cards} cards up, ${out.passed} passed, ${out.fillers} filled from the dregs, ${out.snaps} snaps called, ${Math.round(OPEN_MS / 1000)}/${Math.round(RAISE_MS / 1000)} s clocks`);
w.close();
