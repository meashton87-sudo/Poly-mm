// Tests for the leaderboard Worker with an in-memory KV:   node board/worker_test.mjs
import assert from 'node:assert';
import { handle } from './worker.js';

const kv = new Map();
const env = { ALLOWED_ORIGINS: 'https://2mindrill.bashton.xyz', BOARD: {
  get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => { kv.set(k, v); } } };
let ip = 1;
const call = (method, body, o = {}) => handle(new Request('https://w.example/board', { method, body: body && JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: o.origin || 'https://2mindrill.bashton.xyz', 'CF-Connecting-IP': o.ip || `10.0.0.${ip++}` } }), env);

let r = await call('GET');
assert.deepStrictEqual((await r.json()).rows, [], 'empty board');
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://2mindrill.bashton.xyz');
await call('POST', { name: 'Eli', best: 7 });
await call('POST', { name: 'Matt', best: 3 });
r = await call('POST', { name: 'eli', best: 2 });                       // a worse run, any case: kept
let b = await r.json();
assert.strictEqual(b.kept, 7);
assert.deepStrictEqual(b.rows.map((x) => [x.name, x.best]), [['Eli', 7], ['Matt', 3]]);
r = await call('POST', { name: 'Matt', best: 9 });                      // a better run replaces it
assert.deepStrictEqual((await r.json()).rows.map((x) => [x.name, x.best]), [['Matt', 9], ['Eli', 7]]);
for (const bad of [{ name: '', best: 3 }, { name: 'X', best: -1 }, { name: 'X', best: 1000 }, { name: 'X', best: 2.5 }, { name: '\u0000​', best: 3 }]) {
  assert.strictEqual((await call('POST', bad)).status, 400, JSON.stringify(bad));
}
r = await call('POST', { name: '  Long  name with   spaces and more than twenty four  ', best: 1 });
assert.ok((await r.json()).rows.some((x) => x.name === 'Long name with spaces an'), 'names trimmed and cut to 24');
const same = { ip: '9.9.9.9' };
for (let i = 0; i < 10; i++) assert.strictEqual((await call('POST', { name: 'Spam', best: i }, same)).status, 200);
assert.strictEqual((await call('POST', { name: 'Spam', best: 50 }, same)).status, 429, 'rate limited');
assert.strictEqual((await call('OPTIONS')).status, 204);
r = await call('GET', null, { origin: 'https://evil.example' });
assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://2mindrill.bashton.xyz', 'other origins not echoed');
assert.strictEqual((await handle(new Request('https://w.example/other'), env)).status, 404);
console.log('board worker ok');
