// Tests for the leaderboard Worker, its Durable Object run in memory:   node board/worker_test.mjs
import assert from 'node:assert';
import worker, { Board } from './worker.js';

const store = new Map();
const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); } };
const env = { ALLOWED_ORIGINS: 'https://2mindrill.bashton.xyz', ADMIN_TOKEN: 'commish-secret-123' };
let board = new Board({ storage }, env);
env.BOARD = { idFromName: (n) => n, get: () => ({ fetch: (req) => board.fetch(req) }) };
let ip = 1;
const KEY = { eli: 'eli-device-key-0000000001', matt: 'matt-device-key-000000002', spam: 'spam-device-key-000000003' };
const call = (method, body, o = {}) => worker.fetch(new Request(`https://w.example${o.path || '/board'}`, { method, body: body && JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: o.origin || 'https://2mindrill.bashton.xyz', 'CF-Connecting-IP': o.ip || `10.0.0.${ip++}`,
    ...(o.auth ? { Authorization: o.auth } : {}) } }), env);
const names = async (r) => (await r.json()).rows.map((x) => [x.name, x.best]);

let r = await call('GET');
assert.deepStrictEqual((await r.json()).rows, [], 'empty board');
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://2mindrill.bashton.xyz');
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
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://2mindrill.bashton.xyz', 'other origins not echoed');
assert.strictEqual((await worker.fetch(new Request('https://w.example/other'), env)).status, 404);
console.log('board worker ok');
