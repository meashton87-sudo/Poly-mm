// Tests for the versus rooms (match.js), the Durable Object run in memory with fake sockets:  node board/match_test.mjs
import assert from 'node:assert';
import { Match, HALF_MS, ROOM_RE } from './match.js';

class FakeWS {
  constructor() { this.sent = []; this.closed = false; this.att = null; this.tags = []; }
  send(s) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  serializeAttachment(a) { this.att = a; }
  deserializeAttachment() { return this.att; }
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}
globalThis.WebSocketPair = class { constructor() { const c = new FakeWS(), s = new FakeWS(); this[0] = c; this[1] = s; } };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init = {}) { super(body, init.status === 101 ? { status: 200 } : init); this.webSocket = init.webSocket; this.realStatus = init.status; }
};
function room(env = {}) {
  const store = new Map(), sockets = [];
  let alarm = null, now = 1_000_000;
  const ctx = {
    storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); },
      delete: async (k) => store.delete(k), deleteAll: async () => store.clear(), getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; } },
    acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
    getWebSockets: (tag) => sockets.filter((w) => !w.closed && (!tag || w.tags.includes(tag))),
  };
  const m = new Match(ctx, env);
  const realNow = Date.now;
  return { m, store, sockets, clock: (t) => { now = t; Date.now = () => now; }, alarmAt: () => alarm, restore: () => { Date.now = realNow; } };
}
const connect = async (R, key, code = 'ABC234', mode = '') => {
  const res = await R.m.fetch(new Request(`https://w/vs/ws?room=${code}&key=${key}${mode ? `&mode=${mode}` : ''}`, { headers: { Upgrade: 'websocket' } }));
  return { res, ws: R.sockets[R.sockets.length - 1] };
};
const say = (R, ws, msg) => R.m.webSocketMessage(ws, JSON.stringify(msg));
const K1 = 'device-key-one-0000000001', K2 = 'device-key-two-0000000002', K3 = 'device-key-three-00000003';

assert.ok(ROOM_RE.test('ABC234') && !ROOM_RE.test('ABCD10') && !ROOM_RE.test('abc234') && !ROOM_RE.test('ABCDEFG'), 'room codes');
const R = room();
R.clock(1_000_000);
let { res, ws: a } = await connect(R, K1);
assert.strictEqual(res.realStatus, 101);
assert.deepStrictEqual([a.last('hello').seat, a.last('hello').full], [0, false], 'first in: seat 0, waiting');
assert.strictEqual((await R.m.fetch(new Request('https://w/vs/ws?room=ABC234&key=short', { headers: { Upgrade: 'websocket' } }))).status, 400, 'a key is needed');
const { ws: b } = await connect(R, K2);
assert.strictEqual(b.last('hello').seat, 1);
assert.strictEqual(b.last('hello').seed, a.last('hello').seed, 'one seed for the room');
assert.deepStrictEqual(a.last('peer'), { t: 'peer', online: [true, true], full: true }, 'both told the room is full');
assert.strictEqual((await connect(R, K3)).res.status, 409, 'a third device is refused');

// the spot: seat 0 picks it, once
await say(R, b, { t: 'setup', spot: 'X' });
assert.strictEqual(b.last('setup'), undefined, 'seat 1 cannot pick');
await say(R, a, { t: 'setup', spot: '2024_09_NE_TEN#4015' });
await say(R, a, { t: 'setup', spot: 'other' });
assert.deepStrictEqual(b.sent.filter((m) => m.t === 'setup'), [{ t: 'setup', spot: '2024_09_NE_TEN#4015' }], 'set once');

// a snap: sealed until both are in
await say(R, a, { t: 'half', n: 0, need: [0, 1], half: { action: { call: 'x' } } });
assert.ok(!b.sent.some((m) => m.t === 'step'), 'no step with one call in');
assert.deepStrictEqual(b.last('locked'), { t: 'locked', n: 0, seat: 0 }, 'the other side sees a lock, not the call');
assert.ok(!JSON.stringify(b.sent).includes('"call":"x"'), 'the call itself never reaches the other side early');
await say(R, a, { t: 'half', n: 0, need: [0, 1], half: { action: { call: 'changed' } } });
await say(R, b, { t: 'half', n: 0, need: [0, 1], half: { def: 'blitz' } });
assert.deepStrictEqual(a.last('step'), { t: 'step', n: 0, halves: { 0: { action: { call: 'x' } }, 1: { def: 'blitz' } } }, 'both calls, the first one locked');
assert.deepStrictEqual(b.last('step'), a.last('step'));
// a stale or future n is ignored
await say(R, a, { t: 'half', n: 0, need: [0, 1], half: {} });
await say(R, a, { t: 'half', n: 5, need: [0, 1], half: {} });
assert.ok(!a.sent.some((m) => m.t === 'locked' && m.n !== 0), 'n must be the next decision');
// one side's decision (a try, a kickoff): only that seat
await say(R, b, { t: 'half', n: 1, need: [1], half: { action: { pat: 'xp' } } });
assert.deepStrictEqual(a.last('step').halves, { 1: { action: { pat: 'xp' } } });
// a seat cannot answer for a decision that is not its own
await say(R, a, { t: 'half', n: 2, need: [1], half: {} });
assert.strictEqual(a.last('step').n, 1, 'seat 0 cannot fill seat 1');

// the clock: a missing call is played as the default after HALF_MS
await say(R, a, { t: 'half', n: 2, need: [0, 1], half: { action: {} } });
assert.strictEqual(R.alarmAt(), 1_000_000 + HALF_MS);
R.clock(1_000_000 + HALF_MS);
await R.m.alarm();
assert.deepStrictEqual(a.last('step'), { t: 'step', n: 2, halves: { 0: { action: {} }, 1: null } }, 'the walk-away side gets its default');

// reconnecting: the same device gets its seat back and every decision so far
const { ws: b2 } = await connect(R, K2);
assert.strictEqual(b.closed, true, 'the old socket is replaced');
assert.strictEqual(b2.last('hello').seat, 1);
assert.deepStrictEqual(b2.last('hello').decisions.map((d) => d.n), [0, 1, 2], 'the whole game so far');
assert.strictEqual(b2.last('hello').spot, '2024_09_NE_TEN#4015');

// presence
await R.m.webSocketClose(b2);
assert.deepStrictEqual(a.last('peer').online, [true, false], 'the opponent dropped');

// rematch: both have to ask, then one new code for both
const { ws: b3 } = await connect(R, K2);
await say(R, a, { t: 'rematch' });
assert.deepStrictEqual(b3.last('rematch-ask'), { t: 'rematch-ask', seat: 0 }, 'the other side is asked');
assert.strictEqual(b3.last('rematch'), undefined, 'nobody moves on one ask');
await say(R, b3, { t: 'rematch' });
const code1 = a.last('rematch').room;
assert.ok(ROOM_RE.test(code1) && b3.last('rematch').room === code1, 'the same new room for both');

// expiry
R.clock(1_000_000 + 7 * 3600_000);
await R.m.alarm();
assert.strictEqual(R.store.size, 0, 'an old room is cleared');
R.restore();

// the lobby: the second player gets the first player's room; a stale one is not offered
const L = room();
L.clock(5_000);
const quick = async (key, mode) => (await L.m.fetch(new Request('https://w/vs/quick', { method: 'POST', body: JSON.stringify({ key, mode }) }))).json();
const q1 = await quick(K1);
assert.ok(q1.host && ROOM_RE.test(q1.room));
assert.deepStrictEqual(await quick(K1), q1, 'asking again: the same open room');
const q2 = await quick(K2);
assert.deepStrictEqual(q2, { room: q1.room, host: false, mode: 'casual' }, 'paired');
const r1 = await quick(K2, 'ranked');
assert.ok(r1.host && r1.mode === 'ranked' && r1.room !== q1.room, 'ranked has its own queue');
const q3 = await quick(K3);
assert.ok(q3.host && q3.room !== q1.room, 'the next player opens a new room');
L.clock(5_000 + 100_000);
const q4 = await quick(K1);
assert.ok(q4.host && q4.room !== q3.room, 'a room nobody took for 90 s is dropped');
assert.strictEqual((await L.m.fetch(new Request('https://w/vs/quick', { method: 'POST', body: '{}' }))).status, 400);
L.restore();

// ranked: teams, both report the winner, the ladder moves both ratings
const lad = room();
const env = { MATCH: { idFromName: (n) => n, get: () => ({ fetch: (req) => lad.m.fetch(req) }) } };
const G1 = room(env);
const { ws: ra } = await connect(G1, K1, 'RNK234', 'ranked');
const { ws: rb } = await connect(G1, K2, 'RNK234');
assert.strictEqual(ra.last('hello').mode, 'ranked', 'the mode comes from the first device in');
await say(G1, ra, { t: 'team', team: 'KC', name: 'Eli' });
await say(G1, ra, { t: 'team', team: 'BUF', name: 'x' });
await say(G1, rb, { t: 'team', team: 'kc!', name: 'Matt' });
assert.deepStrictEqual(rb.last('teams').teams, ['KC', null], 'a team once, a real code only');
await say(G1, rb, { t: 'team', team: 'KC', name: 'Matt' });
assert.deepStrictEqual(rb.last('taken'), { t: 'taken', team: 'KC' }, 'never the same team on both sides');
assert.deepStrictEqual(ra.last('teams').teams, ['KC', null]);
await say(G1, rb, { t: 'team', team: 'BUF', name: 'Matt' });
assert.deepStrictEqual(ra.last('teams'), { t: 'teams', teams: ['KC', 'BUF'], names: ['Eli', 'Matt'] });
await say(G1, ra, { t: 'result', winner: 0 });
assert.strictEqual(ra.last('rated'), undefined, 'one report while the other side is here: wait');
await say(G1, rb, { t: 'result', winner: 0 });
const rated = ra.last('rated').ratings;
assert.deepStrictEqual(rated, [{ before: 1000, after: 1016 }, { before: 1000, after: 984 }], 'Elo, K 32');
await say(G1, rb, { t: 'result', winner: 1 });
assert.strictEqual(ra.sent.filter((m) => m.t === 'rated').length, 1, 'rated once');
const top = await (await lad.m.fetch(new Request('https://w/vs/ladder'))).json();
assert.deepStrictEqual(top.top.map((x) => [x.name, x.rating, x.w, x.l]), [['Eli', 1016, 1, 0], ['Matt', 984, 0, 1]]);
const me = await (await lad.m.fetch(new Request('https://w/vs/me', { method: 'POST', body: JSON.stringify({ key: K2 }) }))).json();
assert.deepStrictEqual(me, { rating: 984, w: 0, l: 1, t: 0 });
assert.ok(!JSON.stringify(top).includes(K1), 'only hashes of device keys are kept');
// disagreeing reports: nobody moves
const G2 = room(env);
const { ws: xa } = await connect(G2, K1, 'RNK235', 'ranked');
const { ws: xb } = await connect(G2, K2, 'RNK235');
await say(G2, xa, { t: 'result', winner: 0 });
await say(G2, xb, { t: 'result', winner: 1 });
assert.deepStrictEqual(xa.last('rated'), { t: 'rated', ratings: null }, 'void');
// the loser walks out: the winner's report alone counts
const G3 = room(env);
const { ws: ya } = await connect(G3, K1, 'RNK236', 'ranked');
const { ws: yb } = await connect(G3, K2, 'RNK236');
await G3.m.webSocketClose(yb); yb.close();
await say(G3, ya, { t: 'result', winner: 0 });
assert.ok(ya.last('rated').ratings[0].after > ya.last('rated').ratings[0].before, 'a walk-out still loses');
// casual and friend rooms are never rated
const G4 = room(env);
const { ws: za } = await connect(G4, K1, 'CAS234', 'casual');
await connect(G4, K2, 'CAS234');
await say(G4, za, { t: 'result', winner: 0 });
assert.strictEqual(za.last('rated'), undefined);
console.log('match rooms ok');
