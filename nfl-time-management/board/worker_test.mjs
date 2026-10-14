// Tests for the leaderboard Worker, its Durable Object run in memory:   node board/worker_test.mjs
import assert from 'node:assert';
import worker, { Board } from './worker.js';

const store = new Map();
const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); } };
const env = { ALLOWED_ORIGINS: 'https://nfl2mindrill.com', ADMIN_TOKEN: 'commish-secret-123' };
let board = new Board({ storage }, env);
env.BOARD = { idFromName: (n) => n, get: () => ({ fetch: (req) => board.fetch(req) }) };
let ip = 1;
const KEY = { eli: 'eli-device-key-0000000001', matt: 'matt-device-key-000000002', spam: 'spam-device-key-000000003' };
const call = (method, body, o = {}) => worker.fetch(new Request(`https://w.example${o.path || '/board'}`, { method, body: body && JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: o.origin || 'https://nfl2mindrill.com', 'CF-Connecting-IP': o.ip || `10.0.0.${ip++}`,
    ...(o.auth ? { Authorization: o.auth } : {}) } }), env);
const names = async (r) => (await r.json()).rows.map((x) => [x.name, x.best]);

let r = await call('GET');
assert.deepStrictEqual((await r.json()).rows, [], 'empty board');
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://nfl2mindrill.com');
await call('POST', { name: 'Eli', best: 7, key: KEY.eli });
await call('POST', { name: 'Matt', best: 3, key: KEY.matt });
r = await call('POST', { name: 'eli', best: 2, key: KEY.eli });          // a worse run, any case: kept
let b = await r.json();
assert.strictEqual(b.kept, 7);
assert.deepStrictEqual(b.rows.map((x) => [x.name, x.best]), [['Eli', 7], ['Matt', 3]]);
assert.ok(b.rows.every((x) => Object.keys(x).sort().join() === 'at,best,name'), 'rows never carry the key hash');
r = await call('POST', { name: 'Matt', best: 9, key: KEY.matt });       // a better run replaces it
assert.deepStrictEqual(await names(r), [['Matt', 9], ['Eli', 7]]);

// names are claimed: another device can't overwrite Eli, even with a better score or other case
r = await call('POST', { name: 'ELI', best: 999, key: KEY.matt });
assert.strictEqual(r.status, 409, 'name taken');
assert.deepStrictEqual(await names(r), [['Matt', 9], ['Eli', 7]]);
assert.ok(!JSON.stringify(store.get('runs')).includes(KEY.eli), 'only the hash is stored');
// a row from before claims is claimed by the next post under its name
store.set('runs', [...store.get('runs'), { name: 'Old', best: 4, at: '2026-10-01' }]);
assert.strictEqual((await call('POST', { name: 'old', best: 1, key: KEY.spam })).status, 200);
assert.strictEqual((await call('POST', { name: 'Old', best: 50, key: KEY.eli })).status, 409, 'claimed by the first post');

for (const bad of [{ name: '', best: 3 }, { name: 'X', best: -1 }, { name: 'X', best: 1000 }, { name: 'X', best: 2.5 }, { name: '\u0000​', best: 3 }]) {
  assert.strictEqual((await call('POST', { ...bad, key: KEY.spam })).status, 400, JSON.stringify(bad));
}
for (const key of [undefined, 'short', 'has spaces in it 1234', 'x'.repeat(129)]) {
  assert.strictEqual((await call('POST', { name: 'Keyless', best: 1, key })).status, 400, `key ${key}`);
}
r = await call('POST', { name: '  Long  name with   spaces and more than twenty four  ', best: 1, key: KEY.spam });
assert.ok((await r.json()).rows.some((x) => x.name === 'Long name with spaces an'), 'names trimmed and cut to 24');

const same = { ip: '9.9.9.9' };
for (let i = 0; i < 10; i++) assert.strictEqual((await call('POST', { name: 'Spam', best: i, key: KEY.spam }, same)).status, 200);
assert.strictEqual((await call('POST', { name: 'Spam', best: 50, key: KEY.spam }, same)).status, 429, 'rate limited');

// the commissioner removes a row; without the token (or with no ADMIN_TOKEN set) nobody can
assert.strictEqual((await call('DELETE', null, { path: '/board?name=spam' })).status, 403);
assert.strictEqual((await call('DELETE', null, { path: '/board?name=spam', auth: 'Bearer wrong-token-xxxxxxxx' })).status, 403);
r = await call('DELETE', null, { path: '/board?name=spam', auth: `Bearer ${env.ADMIN_TOKEN}` });
assert.strictEqual((await r.json()).removed, 1);
assert.ok(!(await names(await call('GET'))).some(([n]) => n === 'Spam'));
const tokenless = { ...env, ADMIN_TOKEN: undefined };
board = new Board({ storage }, tokenless);
assert.strictEqual((await worker.fetch(new Request('https://w.example/board?name=eli', { method: 'DELETE', headers: { Authorization: 'Bearer ' } }), tokenless)).status, 403, 'off without a token');

assert.strictEqual((await call('OPTIONS')).status, 204);
r = await call('GET', null, { origin: 'https://evil.example' });
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://nfl2mindrill.com', 'other origins not echoed');
assert.strictEqual((await worker.fetch(new Request('https://w.example/other'), env)).status, 404);
// the daily game: one result per device per day, the day's histograms, the named top list
const today = new Date().toISOString().slice(0, 10);
const day = (body, o) => call('POST', body, { path: '/daily', ...(o || {}) });
r = await day({ date: today, key: KEY.eli, p: 0.82, spots: [0.1, -0.05, 0.2], name: 'Eli' });
b = await r.json();
assert.strictEqual(r.status, 200); assert.strictEqual(b.counted, true); assert.strictEqual(b.n, 1);
assert.strictEqual(b.hist[82], 1); assert.ok(Math.abs(b.spots[2].avg - 0.2) < 1e-9); assert.strictEqual(b.spots[0].hist[60], 1);
assert.deepStrictEqual(b.top, [{ name: 'Eli', p: 0.82 }]);
r = await day({ date: today, key: KEY.eli, p: 0.99, spots: [0.3, 0.3, 0.3] });        // a replay of the day: not counted
b = await r.json();
assert.strictEqual(b.counted, false); assert.strictEqual(b.n, 1); assert.strictEqual(b.you.p, 0.82);
r = await day({ date: today, key: KEY.matt, p: 0.4, spots: [-0.6, 0, 0.6], name: 'eli' });   // Eli's name is Eli's
b = await r.json();
assert.strictEqual(b.taken, true); assert.strictEqual(b.n, 2); assert.strictEqual(b.top.length, 1);
assert.strictEqual(b.spots[0].hist[0], 1, 'clipped at -50'); assert.strictEqual(b.spots[2].hist[100], 1, 'clipped at +50');
r = await day({ date: today, key: 'anon-device-key-0000001', p: 0.5, spots: [0, 0, 0] });      // no name: counted, not listed
b = await r.json();
assert.strictEqual(b.n, 3); assert.strictEqual(b.top.length, 1);
for (const bad of [{ date: '2001-01-01' }, { date: 'today' }, { p: 1.5 }, { p: -0.1 }, { spots: [] }, { spots: [0, 0, 0, 0] }, { spots: [0, 2, 0] }, { key: 'short' }]) {
  r = await day({ date: today, key: 'other-device-key-000001', p: 0.5, spots: [0, 0, 0], ...bad });
  assert.strictEqual(r.status, 400, JSON.stringify(bad));
}
b = await (await day({ date: today, key: 'one-drive-device-key-01', p: 0.6, spots: [0.05] })).json();      // a one-drive day
assert.strictEqual(b.counted, true); assert.strictEqual(b.spots[0].n, 4); assert.strictEqual(b.spots[1].n, 3);
b = await (await day({ date: today, key: 'anon-device-key-0000001', p: 0.9, spots: [0, 0, 0], name: 'Pat' })).json();   // named afterwards
assert.strictEqual(b.counted, false); assert.strictEqual(b.n, 4); assert.deepStrictEqual(b.top.map((x) => [x.name, x.p]), [['Eli', 0.82], ['Pat', 0.5]]);
r = await call('GET', null, { path: `/daily?date=${today}` });
b = await r.json();
assert.strictEqual(b.n, 4); assert.ok(!JSON.stringify(b).includes('kh'), 'no key hashes out');
assert.strictEqual((await (await call('GET', null, { path: '/daily?date=2001-01-01' })).json()).n, 0, 'a day nobody played');
// a name claimed on the daily list is claimed on the survivor board too
await day({ date: today, key: 'nate-device-key-0000001', p: 0.7, spots: [0, 0, 0], name: 'Nate' });
assert.strictEqual((await call('POST', { name: 'nate', best: 5, key: KEY.spam })).status, 409);
assert.strictEqual((await call('POST', { name: 'Nate', best: 5, key: 'nate-device-key-0000001' })).status, 200);
console.log('board worker ok');
