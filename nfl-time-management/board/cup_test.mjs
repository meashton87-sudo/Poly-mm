// The Cup (match.js CUP, cupBracket, cupSettle, the 'cup' object): the ladder as it stood at the qualifying time, the
// bracket seeded from it, the rooms opened at the start with both seats taken, no-shows, a match played to the end,
// results from the rooms only, the admin's hand, the champion's claim code. In memory (vs_world.mjs), a stand-in engine.
import assert from 'node:assert';
import { World, FakeClient } from './vs_world.mjs';
import { cupBracket, cupSettle, CUP, ROOM_RE } from './match.js';

// ---- the bracket on its own: seeds 1 v 16 ... ; byes for missing seeds; empty slots through
{
  const ms = cupBracket(16);
  assert.deepStrictEqual(ms.filter((m) => m.round === 1).map((m) => m.p.map((x) => x + 1)), [[1, 16], [8, 9], [4, 13], [5, 12], [2, 15], [7, 10], [3, 14], [6, 11]], 'seeded 1 v 16, 8 v 9, ...');
  assert.deepStrictEqual(cupBracket(2, 2).map((m) => m.p), [[0, 1]], 'a Cup of two: the final');
  assert.strictEqual(ms.length, 15, 'eight, four, two, one');
  const c = { matches: cupBracket(13) };
  const open = cupSettle(c);
  assert.deepStrictEqual(c.matches.filter((m) => m.by === 'bye').map((m) => m.id), ['1-0', '1-4', '1-6'], 'seeds 1, 2 and 3 get byes with 13 in');
  assert.strictEqual(open.length, 5, 'the other five first-round matches to play');
  const c2 = { matches: cupBracket(1) };
  cupSettle(c2);
  assert.strictEqual(c2.champ, 0, 'one qualifier: the champion by byes');
  const c0 = { matches: cupBracket(0) };
  cupSettle(c0);
  assert.strictEqual(c0.champ, null, 'nobody: no champion');
}

const PAT = 1, KICKOFF = 2;
const stub = {
  pool: { season: 2026, week: 6, league: {}, teams: { KC: { coach: 'A' }, BUF: { coach: 'B' } } },
  eng: {
    pb: { callIndex: { inside: 0, td: 2 }, routeNames: ['', 'go'] },
    makeContext: () => ({}),
    simulator: () => ({
      step(root, { action }) {
        const r = { ...root, score: root.score.slice(), to: root.to.slice() }, log = [];
        if (r.phase === PAT) { r.score[r.pos] += action.pat === 'two' ? 0 : 1; log.push({ ev: 'pat', team: r.pos, good: true, row: -1 }); r.phase = KICKOFF; return { root: r, log, done: false }; }
        if (action.call === 'td') { r.score[r.pos] += 6; r.phase = PAT; log.push({ ev: 'play', yards: r.yl, row: -1 }); return { root: r, log, done: false }; }
        log.push({ ev: 'play', yards: 0, row: -1 });                 // (anything else: no gain; four of them, the ball over)
        if (r.down === 4) { r.pos = 1 - r.pos; r.yl = 100 - r.yl; r.down = 1; r.ytg = 10; } else r.down += 1;
        return { root: r, log, done: false };
      },
    }),
  },
};
const K = (i) => `cup-device-key-${String(i).padStart(10, '0')}`;
const kh = async (k) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`))); return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join(''); };
const iso = (t) => new Date(t).toISOString();

const w = new World({ engine: stub });
const T0 = w.now, QAT = T0 + 3600_000, SAT = T0 + 7200_000;
Object.assign(w.env, { CUP_ID: 'test-cup', CUP_QUALIFY_AT: iso(QAT), CUP_START_AT: iso(SAT), CUP_PRIZE: '$50', ADMIN_TOKEN: 'x' });
const ladder = w.obj('ladder').m, q = ladder.sql();
// 20 players: ratings 1500 down by 20; two of the best still in their placement games (out); one who climbed after the
// qualifying time (in at the rating he had then)
const P = [];
for (let i = 0; i < 20; i++) {
  const k = K(i), h = await kh(k), games = i === 1 || i === 3 ? 6 : 12;
  P.push({ i, k, h, name: `P${i}`, rating: 1500 - 20 * i, games });
  q.exec('INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated) VALUES (?, ?, ?, ?, 0, 0, ?, 0, 0)', h, `P${i}`, 1500 - 20 * i, games, 1500 - 20 * i);
}
// before the qualifying time: the projection (the ladder now), your place in it
let r = await w.http('cup', `/vs/cup?key=${P[0].k}`);
assert.strictEqual(r.status, 200);
assert.ok(r.body.projection && !r.body.seeds, 'before qualifying: a projection, no seeds');
assert.strictEqual(r.body.projection[0].name, 'P0', 'the projection is the ladder now');
assert.ok(!r.body.projection.some((x) => x.name === 'P1' || x.name === 'P3'), 'placement games not played: not in');
assert.strictEqual(r.body.you.seed, 1, 'P0 first for now');
assert.ok(!JSON.stringify(r.body).includes(P[0].h), 'no key or key hash goes out');

// the qualifying time passes with the Cup's alarm lost (it is taken late, then: exact all the same), and a big climb
// comes in just after it
w.objects.get('cup').alarm = null;
await w.advance(QAT - w.now + 60_000);
// P19 (1120) won big after the qualifying time: +500 in one game then (rated at QAT + 60 s): 1620 now, 1120 at the time
q.exec('UPDATE players SET rating = 1620, games = 13 WHERE kh = ?', P[19].h);
q.exec('INSERT INTO games (room, a, b, winner, by, rated, da, db, at, out) VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?)', 'LATE22', P[19].h, P[18].h, 'score', 500, -10, QAT + 60_000, '{}');
q.exec('UPDATE players SET rating = rating - 10, games = games + 1 WHERE kh = ?', P[18].h);

// the ladder as it stood then (P19 at 1120: out; P18 at 1140 back on), seeds fixed
await w.advance(60_000);
r = await w.http('cup', `/vs/cup?key=${P[2].k}`);
const want = P.filter((p) => p.games >= 10 && p.i !== 19).map((p) => p.name).slice(0, 16);
assert.deepStrictEqual(r.body.seeds.map((x) => x.name), want, 'the top 16 as they stood at the qualifying time');
assert.ok(!r.body.seeds.some((x) => x.name === 'P18') && r.body.seeds.length === 16, 'the 17th (P18) just misses out');
assert.ok(!r.body.seeds.some((x) => x.name === 'P19'), 'a climb after the qualifying time does not count');
assert.strictEqual(r.body.you.seed, 2, 'P2: the 2nd seed (P1 out)');
assert.ok(r.body.matches.every((m) => !m.live), 'no rooms before the start');

// the start: eight rooms, both seats taken
await w.advance(SAT - w.now + 1000);
const cupObj = async () => w.objects.get('cup').store.get('cupObj');
let c = await cupObj();
const r1 = c.matches.filter((m) => m.round === 1);
assert.ok(r1.every((m) => ROOM_RE.test(m.room)), 'every first-round match has its room');
for (const m of r1) {
  const R = w.objects.get(`room:${m.room}`).store.get('room');
  assert.deepStrictEqual([R.mode, R.pre, R.seats], ['cup', true, [c.snap.seeds[m.p[0]].kh, c.snap.seeds[m.p[1]].kh]], 'a Cup room: its two players only');
}
const keyOf = (seed) => P.find((p) => p.h === c.snap.seeds[seed].kh).k;
r = await w.http('cup', `/vs/cup?key=${keyOf(0)}`);
assert.strictEqual(r.body.you.match.room, r1[0].room, 'the top seed sees his room');
assert.strictEqual(r.body.you.match.opp, c.snap.seeds[15].name, '... and his opponent');
const outsider = new FakeClient(w, K(99));
assert.strictEqual(await outsider.open(r1[0].room), 409, 'nobody else gets a seat');
const fake = await w.http('cup', '/vs/cup/report', { cupId: 'test-cup', match: '1-0', room: 'ZZZZZZ', winner: 1 });
assert.strictEqual(fake.status, 400, 'a report from no Cup room is refused');

// match 1-0: played to the end (seed 1 scores, seed 16 does not)
async function play(m, winSeat) {
  const a = new FakeClient(w, keyOf(m.p[0])), b = new FakeClient(w, keyOf(m.p[1]));
  assert.strictEqual(await a.open(m.room), 101); assert.strictEqual(await b.open(m.room), 101);
  a.send({ t: 'team', team: 'KC', name: 'x' }); await w.settle();
  b.send({ t: 'team', team: 'BUF', name: 'y' }); await w.settle();
  const cl = [a, b];
  for (let i = 0; i < 200; i++) {
    const R = w.objects.get(`room:${m.room}`).store.get('room');
    if (R.phase === 'over') return R;
    for (const s of [0, 1]) {
      const role = R.ms.cot.pick ? (R.ms.cot.pick.team === s ? 'pick' : null) : R.ms.root.phase === PAT ? (R.ms.root.pos === s ? 'pat' : null) : R.ms.root.pos === s ? 'offense' : 'defense';
      if (!role) continue;
      const half = role === 'pick' ? { pick: 'defense' } : role === 'pat' ? { action: { pat: 'xp' } } : role === 'defense' ? { dc: { pers: 'nickel', front: 'even', cover: 'c3', rush: 4 } } : { action: { call: s === winSeat ? 'td' : 'inside' } };
      cl[s].send({ t: 'half', n: R.n, half });
    }
    await w.settle();
  }
  throw new Error('the match did not end');
}
let R = await play(r1[0], 0);
assert.deepStrictEqual([R.result.winner, R.result.by, R.reported], [0, 'score', true], 'played: the winner, reported');
c = await cupObj();
assert.deepStrictEqual([c.matches[0].w, c.matches[0].by], [0, 'score'], 'the Cup has it');
// 1-1: the lower seed wins on the field
R = await play(r1[1], 1);
c = await cupObj();
assert.strictEqual(c.matches[1].w, 1, '8 v 9: the 9th seed went through');
const r2a = c.matches.find((m) => m.id === '2-0');
assert.ok(ROOM_RE.test(r2a.room), 'the next round\'s match opens as soon as both its players are known');
assert.deepStrictEqual(r2a.p, [0, 8], 'seed 1 v seed 9, the higher seed in seat 0');
// the admin cannot change a match whose next one has started
assert.strictEqual((await w.http('cup', '/vs/cup/admin', { match: '1-1', winner: 0 })).status, 409, 'not once the next match is under way');

// 1-2: only the higher seed shows (and picks a team); 1-3: only the lower; 1-4: nobody; the rest by hand
const show = async (m, seat) => { const x = new FakeClient(w, keyOf(m.p[seat])); assert.strictEqual(await x.open(m.room), 101); x.send({ t: 'team', team: 'KC', name: 'x' }); await w.settle(); };
await show(r1[2], 0);
await show(r1[3], 1);
await w.advance(CUP.showMs + 5000);
c = await cupObj();
assert.deepStrictEqual([c.matches[2].w, c.matches[2].by], [0, 'forfeit'], 'only one came: he goes on');
assert.deepStrictEqual([c.matches[3].w, c.matches[3].by], [1, 'forfeit'], 'the lower seed came, the higher did not: the lower goes on');
for (const i of [4, 5, 6, 7]) assert.deepStrictEqual([c.matches[i].w, c.matches[i].by], [0, 'noshow'], 'nobody came: the higher seed goes on');

// the rest by hand (the admin), round by round, to a champion
for (let g = 0; g < 10; g++) {
  c = await cupObj();
  const open = c.matches.filter((m) => m.w === null && m.room);
  if (!open.length) break;
  for (const m of open) assert.strictEqual((await w.http('cup', '/vs/cup/admin', { match: m.id, winner: 0 })).status, 200);
  await w.settle();
}
c = await cupObj();
assert.strictEqual(c.champ, 0, 'the top seed: champion');
assert.ok(/^[A-Z2-9]{8}$/.test(c.claim), 'a claim code');
r = await w.http('cup', `/vs/cup?key=${keyOf(0)}`);
assert.deepStrictEqual([r.body.champ, r.body.you.champ, r.body.you.claim], [c.snap.seeds[0].name, true, c.claim], 'the champion sees his claim code');
r = await w.http('cup', `/vs/cup?key=${keyOf(1)}`);
assert.strictEqual(r.body.you.claim, null, 'nobody else does');
assert.ok(!JSON.stringify(r.body).includes(c.claim), '... anywhere');
assert.deepStrictEqual(w.errors, [], 'no errors');
w.close();
console.log('cup ok: seeds as they stood, 15 matches, rooms, no-shows, a match played, the champion\'s claim');
