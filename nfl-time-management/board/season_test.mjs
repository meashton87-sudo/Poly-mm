// The season (match.js SEASON): ranked games count only while it runs; everyone starts it at ELO.START, a beta row's
// rating kept in past and never shown; the ladder, your rank and the Cup's standings are the season's. And a Cup
// another replaces: its champion stays on (cupPast), his claim code for his phone only.
import assert from 'node:assert';
import { World } from './vs_world.mjs';
import { ELO, SEASON, CUP, seasonConfig, cupConfig } from './match.js';

const iso = (t) => new Date(t).toISOString();
const kh = async (k) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`))); return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join(''); };
const K = (i) => `season-device-key-${String(i).padStart(8, '0')}`;

// the defaults: Season 1 from Monday 10 a.m. ET to Sunday noon ET, its Championship qualifying as it ends
assert.deepStrictEqual([SEASON.id, SEASON.startAt, SEASON.endAt], ['s1', '2026-10-26T14:00:00Z', '2026-11-01T17:00:00Z']);
assert.strictEqual(CUP.qualifyAt, SEASON.endAt, 'the Championship takes the ladder as the season ends');
assert.deepStrictEqual([CUP.name, CUP.startAt, CUP.prize, CUP.size], ['Season 1 Championship', '2026-11-01T23:00:00Z', '', 16]);
assert.strictEqual(cupConfig({}).prize, '', 'no prize');
assert.strictEqual(seasonConfig({}).eAt - seasonConfig({}).sAt, (6 * 24 + 3) * 3600_000);

const w = new World();
const T0 = w.now;
Object.assign(w.env, { SEASON_ID: 's1', SEASON_START_AT: iso(T0 + 3600_000), SEASON_END_AT: iso(T0 + 7200_000) });
const q = w.obj('ladder').m.sql();
const P = [];
for (let i = 0; i < 4; i++) P.push({ k: K(i), h: await kh(K(i)) });
// the beta: two players with ratings (rows from before seasons: no season set)
q.exec('INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)', P[0].h, 'Beta Ace', 1400, 30, 25, 5, 1450);
q.exec('INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)', P[1].h, 'Beta Two', 1200, 20, 12, 8, 1250);
const rep = (room, a, b, winner) => w.http('ladder', '/vs/report', { room, seats: [P[a].h, P[b].h], names: ['', ''], winner, by: 'score' });

// before it starts: nothing on the ladder, a beta player is new, a game is not rated (and changes no row)
let r = await w.http('ladder', '/vs/ladder');
assert.deepStrictEqual([r.body.top, r.body.players, r.body.season.id, r.body.season.endAt], [[], 0, 's1', iso(T0 + 7200_000)]);
r = await w.http('ladder', '/vs/me', { key: P[0].k });
assert.deepStrictEqual([r.body.rating, r.body.games, r.body.rank], [ELO.START, 0, null], 'a beta player starts at 1000, unranked');
r = await rep('AAA222', 0, 1, 0);
assert.deepStrictEqual([r.body.rated, r.body.reason], [false, 'season'], 'before the season: not rated');
assert.deepStrictEqual(q.exec('SELECT rating, games, season FROM players WHERE kh = ?', P[0].h).one(), { rating: 1400, games: 30, season: 'beta' }, 'the beta row as it was');

// under way: the first game rates from 1000 each, the beta kept in past
await w.advance(3600_000 + 1000);
r = await rep('BBB222', 0, 1, 0);
assert.strictEqual(r.body.rated, true);
assert.deepStrictEqual(r.body.ratings.map((x) => [x.before, x.games]), [[1000, 1], [1000, 1]], 'from 1000, game 1');
assert.ok(r.body.ratings[0].after > 1000 && r.body.ratings[1].after < 1000);
assert.deepStrictEqual(q.exec('SELECT season, name, rating, games, w, l, peak FROM past WHERE kh = ?', P[0].h).one(),
  { season: 'beta', name: 'Beta Ace', rating: 1400, games: 30, w: 25, l: 5, peak: 1450 }, 'the beta rating kept');
r = await rep('CCC222', 2, 3, 1);
r = await w.http('ladder', '/vs/ladder');
assert.deepStrictEqual(r.body.top.map((x) => x.name).sort(), ['Anonymous', 'Anonymous', 'Beta Ace', 'Beta Two'], 'the season\'s players (their names kept)');
assert.strictEqual(r.body.players, 4);
assert.ok(r.body.top.every((x) => x.games === 1 && Math.abs(x.rating - 1000) <= ELO.K_NEW), 'nobody carries the beta');
r = await w.http('ladder', '/vs/me', { key: P[0].k });
assert.deepStrictEqual([r.body.games, r.body.w, r.body.rank], [1, 1, 1]);
// the Cup's standings are the season's
r = await w.http('ladder', '/vs/standings', { at: w.now, n: 16, minGames: 1 });
assert.strictEqual(r.body.top.length, 4);
assert.ok(r.body.top.every((x) => x.rating < 1100), 'no beta rating in the standings');

// over: not rated again, the ladder as it ended
await w.advance(3600_000);
const before = (await w.http('ladder', '/vs/ladder')).body.top;
r = await rep('DDD222', 0, 1, 1);
assert.deepStrictEqual([r.body.rated, r.body.reason], [false, 'season'], 'after the season: not rated');
assert.deepStrictEqual((await w.http('ladder', '/vs/ladder')).body.top, before, 'the final ladder stays');
w.close();

// ---- a Cup another replaces: its champion stays on, atop the lobby
{
  const w2 = new World();
  Object.assign(w2.env, { CUP_ID: 'inv', CUP_SIZE: '2', CUP_QUALIFY_AT: iso(w2.now - 7200_000), CUP_START_AT: iso(w2.now - 3600_000) });
  const champ = { kh: P[2].h, name: 'Champ', rating: 1300, games: 9 }, other = { kh: P[3].h, name: 'Second', rating: 1250, games: 9 };
  w2.obj('cup').store.set('cupObj', { id: 'inv', snap: { at: 0, seeds: [champ, other] }, matches: [{ id: '1-0', round: 1, i: 0, p: [0, 1], room: 'FIN222', w: 0, by: 'score', at: 0 }], champ: 0, claim: 'ABCDEFGH' });
  r = await w2.http('cup', `/vs/cup?key=${P[2].k}`);
  assert.deepStrictEqual([r.body.id, r.body.past], ['inv', []], 'still the Cup: no past yet');
  Object.assign(w2.env, { CUP_ID: 's1', CUP_NAME: 'Season 1 Championship', CUP_QUALIFY_AT: iso(w2.now + 86400_000), CUP_START_AT: iso(w2.now + 2 * 86400_000), CUP_PRIZE: '' });
  r = await w2.http('cup', `/vs/cup?key=${P[2].k}`);
  assert.deepStrictEqual([r.body.id, r.body.name, r.body.prize, r.body.champ], ['s1', 'Season 1 Championship', '', null]);
  assert.deepStrictEqual(r.body.past, [{ id: 'inv', name: 'The Invitational', champ: 'Champ', you: true, claim: 'ABCDEFGH' }], 'the champion sees his code');
  r = await w2.http('cup', `/vs/cup?key=${P[3].k}`);
  assert.deepStrictEqual(r.body.past, [{ id: 'inv', name: 'The Invitational', champ: 'Champ', you: false, claim: null }], 'nobody else does');
  assert.ok(!JSON.stringify(r.body).includes('ABCDEFGH') && !JSON.stringify(r.body).includes(P[2].h), '... anywhere, nor his key hash');
  r = await w2.http('cup', '/vs/cup');
  assert.strictEqual(r.body.past.length, 1, 'kept once');
  w2.close();
}
console.log('season ok: a fresh start at 1000, the beta kept and hidden, rated only in the season, the past champion on top');
