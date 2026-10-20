// Tests for the leaderboard Worker, its Durable Object run in memory:   node board/worker_test.mjs
import assert from 'node:assert';
import worker, { Board } from './worker.js';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { siteVars } from './site_vars.mjs';
const sha256hex = async (x) => createHash('sha256').update(x).digest('hex');

const store = new Map();
const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k),
  list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)])) };   // (in key order, as the storage lists)
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

// claims are one key per name, never one shared value (it would outgrow storage's 2 MB a value); a claim kept in
// the old shared value still holds
assert.strictEqual(store.get('claim:eli'), store.get('runs').find((x) => x.name === 'Eli').kh, 'claimed under its own key');
assert.ok(!store.has('claims'), 'no shared claims value');
store.set('claims', { legacy: 'f'.repeat(64) });
assert.strictEqual((await call('POST', { name: 'Legacy', best: 5, key: KEY.matt })).status, 409, 'an old shared claim holds');
store.delete('claims');

for (const bad of [{ name: '', best: 3 }, { name: 'X', best: -1 }, { name: 'X', best: 1000 }, { name: 'X', best: 2.5 }, { name: '\u0000​', best: 3 }]) {
  assert.strictEqual((await call('POST', { ...bad, key: KEY.spam })).status, 400, JSON.stringify(bad));
}
for (const key of [undefined, 'short', 'has spaces in it 1234', 'x'.repeat(129)]) {
  assert.strictEqual((await call('POST', { name: 'Keyless', best: 1, key })).status, 400, `key ${key}`);
}
r = await call('POST', { name: '  Long  name with   spaces and more than twenty four  ', best: 1, key: KEY.spam });
assert.ok((await r.json()).rows.some((x) => x.name === 'Long name with spaces an'), 'names trimmed and cut to 24');

const same = { ip: '9.9.9.9' };
for (let i = 0; i < 30; i++) assert.strictEqual((await call('POST', { name: 'Spam', best: i, key: KEY.spam }, same)).status, 200);
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
for (const bad of [{ date: '2001-01-01' }, { date: 'today' }, { p: 1.5 }, { p: -0.1 }, { spots: [] }, { spots: [0, 0, 0, 0] }, { spots: [0, 2, 0] }, { key: 'short' }, { p: null }, { p: '0.5' }, { spots: [null, 0, 0] }]) {
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
// the day list for the stats page: every day played, oldest first
store.set('day:2026-01-02', { n: 2, hist: Object.assign(new Array(101).fill(0), { 40: 1, 80: 1 }), spots: [], top: [] });
b = await (await call('GET', null, { path: '/days' })).json();
assert.strictEqual(b.days[0].date, '2026-01-02'); assert.strictEqual(b.days[0].n, 2);
assert.ok(Math.abs(b.days[0].avg - 0.6) < 1e-9); assert.strictEqual(b.days[0].best, 0.8);
assert.strictEqual(b.days[b.days.length - 1].date, today); assert.strictEqual(b.days[b.days.length - 1].n, 5);
assert.strictEqual((await call('POST', {}, { path: '/days' })).status, 405);
// the fair score (g: 2): a post graded the fair way also counts in the day's fair set; posts made the old way stay as
// they were; nothing replaces a result (a device's first counts, whatever g it says later); g alone earns no trust
{
  const D = new Date(Date.now() - 864e5).toISOString().slice(0, 10), ip = { ip: '7.7.7.7' }, post = (x) => day({ date: D, spots: [0.01], ...x }, ip);
  b = await (await post({ key: 'fair-old-device-key-0001', p: 0.95, name: 'Oldie' })).json();
  assert.strictEqual(b.fair, undefined, 'no fair set before a fair post'); assert.strictEqual(b.you.g, undefined);
  await post({ key: 'fair-old-device-key-0002', p: 0.9 });
  b = await (await post({ key: 'fair-new-device-key-0001', p: 0.5, name: 'Fairy', g: 2 })).json();
  assert.strictEqual(b.counted, true); assert.strictEqual(b.you.g, 2);
  assert.deepStrictEqual([b.n, b.fair.n, b.fair.hist[50], b.fair.hist[95]], [3, 1, 1, 0], 'counted in both sets');
  assert.deepStrictEqual(b.fair.top, [{ name: 'Fairy', p: 0.5 }]);
  assert.deepStrictEqual(b.top.map((x) => x.name), ['Oldie', 'Fairy'], 'the whole list as it was');
  await post({ key: 'fair-new-device-key-0002', p: 0.3, g: 2 });
  b = await (await post({ key: 'fair-str-device-key-0001', p: 0.99, g: '2' })).json();
  assert.strictEqual(b.fair.n, 2, 'only g: 2 exactly'); assert.strictEqual(b.you.g, undefined);
  assert.strictEqual((await post({ key: 'fair-bad-device-key-0001', p: 1.5, g: 2 })).status, 400, 'the same checks as any post');
  // a device that posted the old way can't move into the fair set or replace its result
  b = await (await post({ key: 'fair-old-device-key-0001', p: 0.4, g: 2 })).json();
  assert.deepStrictEqual([b.counted, b.you.p, b.you.g, b.n, b.fair.n, b.fair.hist[40]], [false, 0.95, undefined, 5, 2, 0], 'old result stands, not in the fair set');
  b = await (await post({ key: 'fair-new-device-key-0001', p: 0.99, g: 2 })).json();
  assert.deepStrictEqual([b.counted, b.you.p, b.you.g, b.fair.n], [false, 0.5, 2, 2], 'a fair replay changes nothing');
  // a name given afterwards: on the fair list only for a fair result
  b = await (await post({ key: 'fair-new-device-key-0002', p: 0.3, g: 2, name: 'Late' })).json();
  assert.deepStrictEqual(b.fair.top.map((x) => [x.name, x.p]), [['Fairy', 0.5], ['Late', 0.3]]);
  b = await (await post({ key: 'fair-old-device-key-0002', p: 0.9, name: 'Bee' })).json();
  assert.ok(b.top.some((x) => x.name === 'Bee') && !b.fair.top.some((x) => x.name === 'Bee'), 'an old result on the whole list only');
  b = await (await call('GET', null, { path: `/daily?date=${D}` })).json();
  assert.deepStrictEqual([b.n, b.fair.n], [5, 2]); assert.ok(!JSON.stringify(b).includes('kh'), 'no key hashes out of the fair set');
  // the stats page's day list: the fair set's players, average and best beside the day's
  const dd = (await (await call('GET', null, { path: '/days' })).json()).days, x = dd.find((e) => e.date === D);
  assert.deepStrictEqual([x.n, x.n2, x.best2, x.best], [5, 2, 0.5, 0.99]); assert.ok(Math.abs(x.avg2 - 0.4) < 1e-9);
  assert.strictEqual(dd.find((e) => e.date === today).n2, undefined, 'a day without fair posts says nothing of them');
  // a name taken off the lists comes off the fair list too
  const was = board;
  board = new Board({ storage }, env);              // (the board with the commissioner's token)
  r = await call('DELETE', null, { path: '/week?name=fairy', auth: `Bearer ${env.ADMIN_TOKEN}` });
  board = was;
  assert.strictEqual(r.status, 200);
  b = await (await call('GET', null, { path: `/daily?date=${D}` })).json();
  assert.ok(!b.fair.top.some((x) => x.name === 'Fairy') && !b.top.some((x) => x.name === 'Fairy'), 'off both lists');
}
// the page posts as text/plain (a simple cross-origin request, no preflight): read as JSON all the same, with CORS
{
  const plain = (path, body) => worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://nfl2mindrill.com', 'CF-Connecting-IP': `10.0.9.${ip++}` } }), env);
  let q = await plain('/daily', { date: today, key: 'plain-device-key-0000001', p: 0.42, spots: [0.01] });
  assert.strictEqual(q.status, 200, 'text/plain daily post');
  assert.strictEqual(q.headers.get('Access-Control-Allow-Origin'), 'https://nfl2mindrill.com');
  assert.strictEqual((await q.json()).counted, true);
  q = await plain('/board', { name: 'Plain', best: 2, key: 'plain-device-key-0000001' });
  assert.strictEqual(q.status, 200, 'text/plain board post');
  assert.ok((await q.json()).rows.some((x) => x.name === 'Plain'));
}
// names shown publicly: slurs and obscenities are refused however they are spelled; ordinary names that contain the
// same letters are not; a daily result with a refused name still counts, unnamed
{
  let q = await call('POST', { name: 'sh1t h3ad', best: 3, key: 'clean-device-key-000001' });
  assert.strictEqual(q.status, 409); assert.strictEqual((await q.json()).refused, true);
  q = await call('POST', { name: 'Dickerson', best: 3, key: 'clean-device-key-000001' });
  assert.strictEqual(q.status, 200, 'an ordinary name with the same letters');
  const d = await (await day({ date: today, key: 'clean-device-key-000002', p: 0.5, spots: [0, 0, 0], name: 'F U C K' })).json();
  assert.strictEqual(d.refused, true); assert.strictEqual(d.counted, true);
  assert.ok(!d.top.some((x) => /f\s*u\s*c\s*k/i.test(x.name)), 'not on the day list');
  store.set('runs', (store.get('runs') || []).concat([{ name: 'b!tch', best: 999, at: '2026-01-01', kh: 'x' }]));
  b = await (await call('GET')).json();
  assert.ok(!b.rows.some((x) => x.name === 'b!tch'), 'a stored row with such a name is left out');
}
// a scenario's title on the page (web/scenario.js blocked: the builder's hint, a shared link's title) is refused just as
// the board refuses it: the same lists and rule
{
  const SC = createRequire(import.meta.url)('../web/scenario.js');
  const names = ['sh1t h3ad', 'Dickerson', 'F U C K', 'b!tch', 'Cassel', 'Hancock', 'Spygate revenge', 'N1663R', 'ass', 'Bass Pro', 'phuck', 'Fuuuuck yes',
    'Raped by the refs', 'Hitler', 'Kkk', 'Sexy Rexy', 'Peyton’s last ride', 'Brady 28–3', 'tits', 'Titans comeback', 'porn star', 'Cocksure', 'Dyke', 'Pedo', 'p3d0'];
  const board_ = [];
  for (const name of names) board_.push((await (await call('POST', { name, best: 1, key: 'parity-device-key-00001' })).json()).refused === true);
  assert.deepStrictEqual(names.map(SC.blocked), board_, 'the page and the board agree');
  assert.ok(names.some(SC.blocked) && !names.every(SC.blocked));
}
// a scenario's code is read the same way here as on the page (web/scenario.js CODE_RE, worker.js SCEN_RE: its 22 parts,
// then any lineup picks, a code from before lineups as it always was)
{
  const SC = createRequire(import.meta.url)('../web/scenario.js');
  const src = createRequire(import.meta.url)('node:fs').readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const m = /SCEN_RE = \/(.+?)\/;/.exec(src);
  assert.ok(m && m[1] === SC.CODE_RE.source, `the board's SCEN_RE is the page's CODE_RE: ${m && m[1]}`);
}
// the rare-coach find is retired: a result never carries a claim code, and its public list is gone
{
  const r = await (await day({ date: today, key: 'plain-device-key-000001', p: 0.5, spots: [0, 0, 0] })).json();
  assert.ok(!('madden' in r), 'no claim code on a result');
  assert.strictEqual((await call('GET', null, { path: '/madden' })).status, 404, 'no public list');
}
// a survivor best that used the extra life carries the mark on the board
{
  const q = await (await call('POST', { name: 'Hearty', best: 950, key: 'hearty-device-key-00001', life: true })).json();
  assert.ok(q.rows.some((x) => x.name === 'Hearty' && x.life === true), 'the ❤️ mark');
  assert.ok(!q.rows.some((x) => x.name !== 'Hearty' && x.life), 'only on that run');
}

// ---- Pro: Stripe Checkout behind /pay, codes from /claim, /restore on another device (Stripe answered by a stub)
{
  const realFetch = globalThis.fetch;
  const stripeCalls = [];
  let refuse = null;              // set to a message: Stripe refuses to create a session with it
  globalThis.fetch = async (u, init) => {
    stripeCalls.push([u, init]);
    if (u === 'https://api.stripe.com/v1/checkout/sessions' && refuse) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: refuse } }), { status: 400 });
    if (u === 'https://api.stripe.com/v1/checkout/sessions') return new Response(JSON.stringify({ id: 'cs_test_new1234567890', url: 'https://checkout.stripe.com/c/pay/cs_test_new1234567890' }), { status: 200 });
    if (u.endsWith('/checkout/sessions/cs_test_paid1234567890')) return new Response(JSON.stringify({ id: 'cs_test_paid1234567890', payment_status: 'paid' }), { status: 200 });
    if (u.endsWith('/checkout/sessions/cs_test_open1234567890')) return new Response(JSON.stringify({ id: 'cs_test_open1234567890', payment_status: 'unpaid' }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'No such checkout.session' } }), { status: 404 });
  };
  const RATE = 30;      // RATE_PER_MIN in the worker
  const pro = (method, path, body, o = {}) => call(method, body, { ...o, path });
  // not set up: /pro says so and /pay refuses
  assert.deepStrictEqual(await (await pro('GET', '/pro')).json(), { on: false, price: '$4.99' });
  assert.strictEqual((await pro('POST', '/pay')).status, 503, 'no Stripe keys: 503');
  for (const e of [env, board.env]) { e.STRIPE_SECRET = 'rk_live_x'; e.STRIPE_PRICE = 'price_123'; e.SITE = 'https://nfl2mindrill.com/'; }    // (board was remade above with its own env)
  assert.deepStrictEqual(await (await pro('GET', '/pro')).json(), { on: true, price: '$4.99' });
  r = await pro('POST', '/pay');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_new1234567890');
  const [u0, init0] = stripeCalls[0];
  assert.strictEqual(u0, 'https://api.stripe.com/v1/checkout/sessions');
  assert.strictEqual(init0.headers.Authorization, 'Bearer rk_live_x');
  const form = new URLSearchParams(init0.body);
  assert.strictEqual(form.get('mode'), 'payment');
  assert.strictEqual(form.get('line_items[0][price]'), 'price_123');
  assert.strictEqual(form.get('allow_promotion_codes'), 'true', 'checkout takes promotion codes');
  assert.strictEqual(form.get('success_url'), 'https://nfl2mindrill.com/?claim={CHECKOUT_SESSION_ID}', 'the site without its trailing slash');
  // from the Pro preview (an allowed origin), the buyer is sent back there; from anywhere else, to the site
  for (const e of [env, board.env]) e.ALLOWED_ORIGINS = 'https://nfl2mindrill.com,https://nfl2mindrill-pro-preview.pages.dev';
  await pro('POST', '/pay', undefined, { origin: 'https://nfl2mindrill-pro-preview.pages.dev' });
  assert.strictEqual(new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body).get('success_url'), 'https://nfl2mindrill-pro-preview.pages.dev/?claim={CHECKOUT_SESSION_ID}', 'back to the preview');
  await pro('POST', '/pay', undefined, { origin: 'https://evil.example' });
  assert.strictEqual(new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body).get('success_url'), 'https://nfl2mindrill.com/?claim={CHECKOUT_SESSION_ID}', 'an unknown origin gets the site');
  for (const e of [env, board.env]) e.ALLOWED_ORIGINS = 'https://nfl2mindrill.com';
  // a test-mode key pays only from the preview, never from the site (or an unknown origin): no real card works there
  for (const e of [env, board.env]) { e.STRIPE_SECRET = 'rk_test_x'; e.ALLOWED_ORIGINS = 'https://nfl2mindrill.com,https://nfl2mindrill-pro-preview.pages.dev'; }
  assert.strictEqual((await pro('POST', '/pay')).status, 503, 'the site with a test key');
  assert.strictEqual((await pro('POST', '/pay', undefined, { origin: 'https://www.nfl2mindrill.com' })).status, 503, 'www too');
  assert.strictEqual((await pro('POST', '/pay', undefined, { origin: 'https://evil.example' })).status, 503, 'an unknown origin with a test key');
  assert.strictEqual((await pro('POST', '/pay', undefined, { origin: 'https://nfl2mindrill-pro-preview.pages.dev' })).status, 200, 'the preview pays in test mode');
  for (const e of [env, board.env]) e.STRIPE_SECRET = 'rk_live_x';
  assert.strictEqual((await pro('POST', '/pay')).status, 200, 'a live key pays from the site');
  assert.strictEqual((await pro('POST', '/pay', undefined, { origin: 'https://nfl2mindrill-pro-preview.pages.dev' })).status, 200, 'and from the preview');
  // the site moved (board/site_vars.mjs: SITE the new address, the old one in OLD_SITES and ALLOWED_ORIGINS while its
  // visitors are handed over): the new address is answered and paid back to, the old one is still the site's own
  {
    const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
    assert.strictEqual(siteVars(toml, '', ''), toml, 'no SITE_DOMAIN: wrangler.toml as it is');
    assert.strictEqual(siteVars(toml, 'nfl2mindrill.com', ''), toml, 'today\'s address: wrangler.toml as it is');
    const moved = siteVars(toml, '2mindrills.com', 'nfl2mindrill.com'), v = (k) => moved.match(new RegExp(`^${k} = "([^"]*)"`, 'm'))[1];
    assert.strictEqual(v('SITE'), 'https://2mindrills.com');
    assert.deepStrictEqual(v('ALLOWED_ORIGINS').split(','), ['https://2mindrills.com', 'https://www.2mindrills.com', 'https://nfl2mindrill.com', 'https://www.nfl2mindrill.com',
      ...toml.match(/^ALLOWED_ORIGINS = "([^"]*)"/m)[1].split(',').filter((o) => o.endsWith('.pages.dev'))], 'the new address, the old one, the previews');
    assert.strictEqual(v('OLD_SITES'), 'https://nfl2mindrill.com,https://www.nfl2mindrill.com');
    assert.strictEqual(siteVars(moved, '2mindrills.com', 'nfl2mindrill.com'), moved, 'the same again');
    assert.strictEqual(siteVars(toml, '2mindrills.com', ''), moved, 'moved with OLD_DOMAIN unset: the first address still handed over and answered');
    assert.throws(() => siteVars(toml, 'not a host', ''), /SITE_DOMAIN/);
    for (const e of [env, board.env]) { e.STRIPE_SECRET = 'rk_live_x'; e.SITE = v('SITE'); e.OLD_SITES = v('OLD_SITES'); e.ALLOWED_ORIGINS = v('ALLOWED_ORIGINS'); }
    r = await pro('POST', '/pay', undefined, { origin: 'https://2mindrills.com' });
    assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://2mindrills.com', 'the new address may call the worker');
    assert.strictEqual(new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body).get('success_url'), 'https://2mindrills.com/?claim={CHECKOUT_SESSION_ID}', 'paid back to the new address');
    await pro('POST', '/pay', undefined, { origin: 'https://evil.example' });
    assert.strictEqual(new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body).get('success_url'), 'https://2mindrills.com/?claim={CHECKOUT_SESSION_ID}', 'an unknown origin: the new address');
    r = await pro('GET', '/pro', undefined, { origin: 'https://nfl2mindrill.com' });
    assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://nfl2mindrill.com', 'the old address still may (its visitors are handed over)');
    for (const e of [env, board.env]) e.STRIPE_SECRET = 'rk_test_x';
    for (const o of ['https://2mindrills.com', 'https://www.2mindrills.com', 'https://nfl2mindrill.com', 'https://www.nfl2mindrill.com']) {
      assert.strictEqual((await pro('POST', '/pay', undefined, { origin: o })).status, 503, `a test key never pays from the site: ${o}`);
    }
    assert.strictEqual((await pro('POST', '/pay', undefined, { origin: 'https://nfl2mindrill-pro-preview.pages.dev' })).status, 200, 'the preview still pays in test mode');
    for (const e of [env, board.env]) { e.SITE = 'https://nfl2mindrill.com/'; delete e.OLD_SITES; }
  }
  for (const e of [env, board.env]) { e.STRIPE_SECRET = 'rk_live_x'; e.ALLOWED_ORIGINS = 'https://nfl2mindrill.com'; }
  // Stripe's refusal reaches the buyer's screen with its reason
  refuse = 'Your account cannot currently make live charges.';
  r = await pro('POST', '/pay');
  assert.strictEqual(r.status, 502);
  assert.strictEqual((await r.json()).error, 'stripe refused the session: Your account cannot currently make live charges.');
  refuse = null;
  // a product id instead of a price id: the product, charged $4.99
  for (const e of [env, board.env]) e.STRIPE_PRICE = 'prod_abc123';
  await pro('POST', '/pay');
  const fp = new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body);
  assert.strictEqual(fp.get('line_items[0][price_data][product]'), 'prod_abc123');
  assert.strictEqual(fp.get('line_items[0][price_data][unit_amount]'), '499');
  assert.strictEqual(fp.get('line_items[0][price_data][currency]'), 'usd');
  assert.strictEqual(fp.get('line_items[0][price]'), null);
  // no price or product id at all: the product described in the call, charged $4.99
  for (const e of [env, board.env]) delete e.STRIPE_PRICE;
  assert.deepStrictEqual(await (await pro('GET', '/pro')).json(), { on: true, price: '$4.99' }, 'the key alone turns Pro on');
  await pro('POST', '/pay');
  const fn = new URLSearchParams(stripeCalls[stripeCalls.length - 1][1].body);
  assert.strictEqual(fn.get('line_items[0][price_data][product_data][name]'), 'Two-Minute Drill Pro');
  assert.strictEqual(fn.get('line_items[0][price_data][product_data][tax_code]'), 'txcd_10201001', 'a tax code: Managed Payments needs one');
  assert.strictEqual(fn.get('line_items[0][price_data][unit_amount]'), '499');
  assert.strictEqual(fn.get('line_items[0][price_data][product]'), null);
  assert.strictEqual(fn.get('line_items[0][price]'), null);
  for (const e of [env, board.env]) e.STRIPE_PRICE = 'price_123';
  // claiming: a paid session gets a code, the same one again; an unpaid or unknown one gets none
  for (const bad of [{}, { s: 'cs_live_' }, { s: 'nope' }]) assert.strictEqual((await pro('POST', '/claim', bad)).status, 400, JSON.stringify(bad));
  assert.strictEqual((await pro('POST', '/claim', { s: 'cs_test_open1234567890' })).status, 402, 'unpaid');
  assert.strictEqual((await pro('POST', '/claim', { s: 'cs_test_gone1234567890' })).status, 404, 'unknown session');
  r = await pro('POST', '/claim', { s: 'cs_test_paid1234567890' });
  assert.strictEqual(r.status, 200);
  const { code } = await r.json();
  assert.match(code, /^TMD-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, code);
  assert.ok(!/[01IOL]/.test(code.slice(4)), 'no look-alike letters');
  const n = stripeCalls.length;
  assert.strictEqual((await (await pro('POST', '/claim', { s: 'cs_test_paid1234567890' })).json()).code, code, 'the same code again');
  assert.strictEqual(stripeCalls.length, n, 'a known session is not asked of Stripe again');
  assert.deepStrictEqual(Object.keys(store.get(`pro:code:${code}`)).sort(), ['at', 's'], 'only the session behind the code is kept');
  // restoring: the code as typed, any case, dashes or not, with 0/1 for O/I corrected
  const typed = code.toLowerCase().replace(/-/g, ' ').replace(/^tmd/, '');
  r = await pro('POST', '/restore', { code: typed, key: KEY.eli });
  assert.deepStrictEqual(await r.json(), { ok: true, code });
  assert.strictEqual((await pro('POST', '/restore', { code: 'TMD-AAAA-AAAA-AAAA', key: KEY.eli })).status, 404, 'never issued');
  assert.strictEqual((await pro('POST', '/restore', { code: 'TMD-AAAA', key: KEY.eli })).status, 400, 'too short');
  assert.strictEqual((await pro('POST', '/restore', { key: KEY.eli })).status, 400);
  for (const e of [env, board.env]) e.KEY_REQUIRED_FROM = '2999-01-01';
  assert.strictEqual((await pro('POST', '/restore', { code })).status, 200, 'before the cutover a page without a device key is still answered');
  assert.strictEqual((await pro('POST', '/restore', { code: 'TMD-AAAA-AAAA-AAAA' })).status, 404, 'but an unknown code is still unknown');
  for (const e of [env, board.env]) e.KEY_REQUIRED_FROM = '2000-01-01';
  assert.strictEqual((await pro('POST', '/restore', { code })).status, 400, 'a device key is wanted');
  for (let i = 0; i < RATE; i++) await pro('POST', '/restore', { code: 'TMD-AAAA-AAAA-AAAB', key: KEY.eli }, { ip: '7.7.7.7' });
  assert.strictEqual((await pro('POST', '/restore', { code: 'TMD-AAAA-AAAA-AAAB', key: KEY.eli }, { ip: '7.7.7.7' })).status, 429, 'guessing codes is rate limited');
  // one code, three devices: the fourth is refused until one has been away 30 days (or support resets the code)
  const dev4 = 'fourth-device-key-000000004', dev5 = 'fifth-device-key-0000000005';
  assert.strictEqual((await pro('POST', '/restore', { code, key: KEY.matt })).status, 200, 'device 2');
  assert.strictEqual((await pro('POST', '/restore', { code, key: KEY.spam })).status, 200, 'device 3');
  r = await pro('POST', '/restore', { code, key: dev4 });
  assert.strictEqual(r.status, 409, 'device 4 refused');
  assert.match((await r.json()).error, /3 devices/);
  assert.strictEqual((await pro('POST', '/restore', { code, key: KEY.eli })).status, 200, 'a device already on it stays');
  const rowKeys = Object.keys(store.get(`pro:code:${code}`).dev);
  assert.strictEqual(rowKeys.length, 3);
  assert.ok(!JSON.stringify(store.get(`pro:code:${code}`)).includes(KEY.eli), 'only the hash of a device key is stored');
  store.get(`pro:code:${code}`).dev[rowKeys[2]] = Date.now() - 31 * 864e5;       // device 3 away 31 days
  assert.strictEqual((await pro('POST', '/restore', { code, key: dev4 })).status, 200, 'its place is free');
  assert.strictEqual((await pro('POST', '/restore', { code, key: KEY.spam })).status, 409, 'and device 3 is now the odd one out');
  for (const e of [env, board.env]) e.ADMIN_TOKEN = 'commish-secret-123';
  assert.strictEqual((await pro('POST', '/pro/reset', { code })).status, 403, 'reset needs the admin token');
  assert.strictEqual((await pro('POST', '/pro/reset', { code }, { auth: 'Bearer commish-secret-123' })).status, 200);
  assert.strictEqual((await pro('POST', '/pro/reset', { code: 'TMD-AAAA-AAAA-AAAA' }, { auth: 'Bearer commish-secret-123' })).status, 404);
  assert.strictEqual((await pro('POST', '/restore', { code, key: KEY.spam })).status, 200, 'after a reset the devices start over');
  assert.strictEqual((await pro('POST', '/restore', { code, key: dev5 })).status, 200);

  assert.strictEqual((await pro('GET', '/pay')).status, 405);
  assert.strictEqual(init0.headers['Stripe-Version'], '2026-08-26.dahlia', 'the API version is pinned');
  assert.match(form.get('integration_identifier'), /^tmd_pro_[a-z]{8}$/, 'sessions carry an integration tag');
  assert.strictEqual(form.get('payment_method_types'), null, 'payment methods come from the Dashboard, never the call');
  // the webhook: a signed, paid session gets its code before the buyer is back; the page's claim then finds it
  const whsec = 'whsec_test_secret_0001';
  for (const e of [env, board.env]) e.STRIPE_WEBHOOK_SECRET = whsec;
  const event = (type, id, status) => JSON.stringify({ id: 'evt_1', type, data: { object: { id, object: 'checkout.session', payment_status: status } } });
  const sign = async (body, t = Math.floor(Date.now() / 1000)) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(whsec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))), (b) => b.toString(16).padStart(2, '0')).join('');
    return `t=${t},v1=${mac}`;
  };
  const hook = (body, sig) => worker.fetch(new Request('https://w.example/stripe-webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig } }), env);
  let bodyW = event('checkout.session.completed', 'cs_test_hook1234567890', 'paid');
  assert.strictEqual((await hook(bodyW, 't=1,v1=00')).status, 400, 'an unsigned event is refused');
  assert.strictEqual((await hook(bodyW, await sign(bodyW, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'an old signature is refused');
  assert.strictEqual((await hook(bodyW, await sign(bodyW))).status, 200);
  const hooked = store.get('pro:sess:cs_test_hook1234567890');
  assert.match(hooked || '', /^TMD-/, 'the webhook minted the code');
  const n2 = stripeCalls.length;
  assert.strictEqual((await (await pro('POST', '/claim', { s: 'cs_test_hook1234567890' })).json()).code, hooked, 'the claim finds it without asking Stripe');
  assert.strictEqual(stripeCalls.length, n2);
  bodyW = event('checkout.session.completed', 'cs_test_late1234567890', 'unpaid');      // a bank payment still clearing
  assert.strictEqual((await hook(bodyW, await sign(bodyW))).status, 200);
  assert.ok(!store.has('pro:sess:cs_test_late1234567890'), 'an unpaid session gets no code');
  bodyW = event('checkout.session.async_payment_succeeded', 'cs_test_late1234567890', 'paid');
  await hook(bodyW, await sign(bodyW));
  assert.match(store.get('pro:sess:cs_test_late1234567890') || '', /^TMD-/, 'the code comes when the payment clears');
  for (const e of [env, board.env]) delete e.STRIPE_WEBHOOK_SECRET;
  assert.strictEqual((await hook(bodyW, await sign(bodyW))).status, 503, 'no signing secret: webhooks are off');
  // the Pro data: only to a valid code, never as a plain file
  const assets = { fetch: async (rq) => (new URL(rq.url).pathname === '/pro/d0.json'
    ? new Response('{"0":{"home":{}}}', { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('nf', { status: 404 })) };
  for (const e of [env, board.env]) e.ASSETS = assets;
  const data = (body, o = {}) => pro('POST', '/pro/data', body, o);
  assert.strictEqual((await data({ name: 'd0.json', key: KEY.eli })).status, 403, 'no code');
  assert.strictEqual((await data({ code: 'TMD-AAAA-AAAA-AAAA', name: 'd0.json', key: KEY.eli })).status, 403, 'a code never issued');
  assert.strictEqual((await data({ code, name: 'd0.json' })).status, 400, 'a device key is wanted');
  assert.strictEqual((await data({ code, name: 'd0.json', key: KEY.eli })).status, 200, 'the third device since the reset');
  assert.strictEqual((await data({ code, name: 'd0.json', key: 'sixth-device-key-0000000006' })).status, 409, 'a fourth device gets no data either');
  assert.strictEqual((await data({ code, name: '../worker.js', key: KEY.eli })).status, 404, 'only the Pro files');
  assert.strictEqual((await data({ code, name: 'd9.json', key: KEY.eli })).status, 404, 'a file not there');
  r = await data({ code, name: 'd0.json', key: KEY.eli });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('Cache-Control'), 'private, no-store');
  assert.deepStrictEqual(await r.json(), { 0: { home: {} } }, 'the file, to a valid code');
  assert.strictEqual((await call('GET', undefined, { path: '/pro/d0.json' })).status, 404, 'the plain file path is not served');
  for (const e of [env, board.env]) delete e.ASSETS;
  assert.strictEqual((await data({ code, name: 'd0.json', key: KEY.eli })).status, 503, 'no assets deployed');
  globalThis.fetch = realFetch;
  for (const e of [env, board.env]) { delete e.STRIPE_SECRET; delete e.STRIPE_PRICE; delete e.SITE; }
}
// a gift code (admin only): a working Pro code
{
  for (const e of [env, board.env]) e.STRIPE_SECRET = 'sk_live_x';
  assert.strictEqual((await call('POST', { note: 'x' }, { path: '/pro/gift' })).status, 403, 'a gift code is admin only');
  const g = await (await call('POST', { note: 'a prize' }, { path: '/pro/gift', auth: 'Bearer commish-secret-123' })).json();
  assert.ok(/^TMD-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(g.code), 'a code');
  const r = await call('POST', { code: g.code, key: 'gift-device-key-000000001' }, { path: '/restore' });
  assert.strictEqual(r.status, 200, 'the gift code unlocks Pro');
  for (const e of [env, board.env]) delete e.STRIPE_SECRET;
}
// The Gauntlet: Pro codes enter under a name; passes after the start count, each drive once; the first to all 24 wins
{
  const codes = ['TMD-AAAA-BBBB-CCCC', 'TMD-DDDD-EEEE-FFFF', 'TMD-GGGG-HHHH-JJJJ'];
  for (const c of codes) store.set(`pro:code:${c}`, { s: 'cs_test_x', at: '2026-10-16' });
  const [ca, cb, cc] = codes, ka = 'race-device-key-00000000a', kb = 'race-device-key-00000000b', kc = 'race-device-key-00000000c';
  const rc = (path, body, o = {}) => call(body ? 'POST' : 'GET', body, { path, ...o });
  const decs = [{ kind: 'call', chosen: 'pass', wps: [{ key: 'run', wp: 0.4 }, { key: 'pass', wp: 0.5 }] }];
  const WON = [[24, 21]];
  // a try of a drive, started in the Gauntlet (its token), a minute ago (a real drive's time)
  const tryOf = async (code, key, drive) => {
    const d = await (await rc('/race/start', { code, key, drive })).json();
    const id = (await sha256hex('race:' + code)).slice(0, 24), t = store.get(`race:try:${id}:${drive}`);
    if (t) store.set(`race:try:${id}:${drive}`, { ...t, at: t.at - 60e3 });
    return d.tok;
  };
  env.RACE_FROM = board.env.RACE_FROM = new Date(Date.now() + 3600e3).toISOString();        // not started yet
  let v = await (await rc('/race')).json();
  assert.deepStrictEqual([v.n, v.entrants, v.rows, v.winner], [24, 0, [], null], 'an empty race');
  assert.strictEqual((await rc('/race/join', { code: 'TMD-ZZZZ-ZZZZ-ZZZZ', key: ka, name: 'Eli' })).status, 403, 'no entry without a real Pro code');
  assert.strictEqual((await rc('/race/join', { code: ca, key: ka, name: '' })).status, 400, 'a name is needed');
  assert.strictEqual((await rc('/race/join', { code: ca, key: ka, name: 'fuck this' })).status, 409, 'no slurs or obscenities');
  r = await rc('/race/join', { code: ca, key: ka, name: 'Eli Manning' });
  v = await r.json();
  assert.deepStrictEqual([r.status, v.me.name, v.me.n, v.entrants], [200, 'Eli Manning', 0, 1], 'entered');
  assert.strictEqual((await rc('/race/join', { code: cb, key: kb, name: 'eli manning' })).status, 409, 'a name has one owner');
  v = await (await rc('/race/join', { code: ca, key: ka, name: 'Someone Else' })).json();
  assert.strictEqual(v.me.name, 'Eli Manning', 'one entry a code: entering again is the same entry');
  // before the start, a new name for the same entry (the old one free again)
  v = await (await rc('/race/join', { code: ca, key: ka, name: 'E', rename: true })).json();
  assert.deepStrictEqual([v.me.name, v.entrants], ['E', 1], 'renamed, still one entry');
  assert.strictEqual((await rc('/race/join', { code: ca, key: ka, name: 'fuck off', rename: true })).status, 409, 'a new name is checked too');
  v = await (await rc('/race/join', { code: ca, key: ka, name: 'Eli Manning', rename: true })).json();
  assert.strictEqual(v.me.name, 'Eli Manning', 'and back');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.93, decs, res: WON })).status, 409, 'nothing counts before the start');
  assert.strictEqual((await rc('/race/start', { code: ca, key: ka, drive: 3 })).status, 409, 'no try starts before the start');
  env.RACE_FROM = board.env.RACE_FROM = new Date(Date.now() - 1000).toISOString();          // started
  // a try started before the start (no token), finished after: does not count
  r = await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs, res: WON });
  assert.deepStrictEqual([r.status, (await r.json()).notry], [409, true], 'a try started before the start never counts');
  assert.strictEqual((await rc('/race/start', { code: cc, key: kc, drive: 3 })).status, 403, 'no token for a code not entered');
  assert.strictEqual((await rc('/race/start', { code: ca, key: ka, drive: 0 })).status, 400, 'no drive 0');
  let tok = (await (await rc('/race/start', { code: ca, key: ka, drive: 3 })).json()).tok;
  assert.ok(/^[0-9a-f]{24}$/.test(tok), 'a token');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs, res: WON, tok })).status, 429, 'a drive in seconds is not a drive');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs, res: WON, tok: 'f'.repeat(24) })).status, 409, 'someone else\'s token');
  tok = await tryOf(ca, ka, 3);
  const tok4 = await tryOf(ca, ka, 4);
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 4, p: 0.95, decs, res: WON, tok })).status, 409, 'a token is for its own drive');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.89, decs, res: WON, tok })).status, 400, 'an 89 is not a pass');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs, res: [[17, 21]], tok })).status, 400, 'a pass takes winning the game');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 25, p: 0.95, decs, res: WON })).status, 400, 'no drive 25');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs: [] })).status, 400, 'the calls behind it are kept');
  assert.strictEqual((await rc('/race/pass', { code: cc, key: kc, drive: 3, p: 0.95, decs, res: WON })).status, 403, 'enter first');
  v = await (await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.935, decs, tryAt: 5, res: WON, tok })).json();
  assert.deepStrictEqual([v.me.n, v.me.passes, v.me.rank], [1, [3], 1], 'a pass counted');
  assert.deepStrictEqual(store.get(`race:audit:${(await sha256hex('race:' + ca)).slice(0, 24)}:3`).decs, decs, 'its calls kept for the check');
  assert.strictEqual((await rc('/race/pass', { code: ca, key: ka, drive: 4, p: 0.95, decs, res: WON, tok: tok4 })).status, 429, 'one drive at a time');
  v = await (await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.99, decs, res: WON, tok })).json();
  assert.strictEqual(v.me.n, 1, 'a drive counts once');
  v = await (await rc('/race/join', { code: ca, key: ka, name: 'Late Change', rename: true })).json();
  assert.strictEqual(v.me.name, 'Eli Manning', 'no new name once it has started');
  // the race: B enters and finishes all 24 (the gap between passes stepped over by hand), A has one
  await rc('/race/join', { code: cb, key: kb, name: 'Tom' });
  const idb = (await sha256hex('race:' + cb)).slice(0, 24);
  for (let d = 1; d <= 24; d++) {
    const e = store.get(`race:e:${idb}`); e.last = 0; store.set(`race:e:${idb}`, e);
    r = await rc('/race/pass', { code: cb, key: kb, drive: d, p: 0.91, decs, res: WON, tok: await tryOf(cb, kb, d) });
    assert.strictEqual(r.status, 200, `Tom passes drive ${d}`);
  }
  v = await r.json();
  assert.deepStrictEqual([v.me.n, v.me.rank, !!v.me.done, v.winner.name], [24, 1, true, 'Tom'], 'the first to 24 wins');
  assert.deepStrictEqual(v.rows.map((x) => [x.name, x.n]), [['Tom', 24], ['Eli Manning', 1]], 'the board: passes, then who got there first');
  assert.ok(!JSON.stringify(v.rows).includes(idb) && !('id' in v.winner), 'no ids on the board');
  v = await (await rc('/race/me', { code: cc, key: kc })).json();
  assert.strictEqual(v.me, null, 'a code not entered');
  // the check before a prize (web/admin.html): admin only, every entrant with its passes, one entry's whole audit
  const AD = { auth: 'Bearer commish-secret-123' }, ida = (await sha256hex('race:' + ca)).slice(0, 24);
  for (const [path, method, body] of [['/race/admin', 'GET'], [`/race/admin?id=${idb}`, 'GET'], ['/race/admin/void', 'POST', { id: idb, drive: 5, note: 'x' }]]) {
    assert.strictEqual((await call(method, body, { path })).status, 403, `${path}: no token, no audit`);
    assert.strictEqual((await call(method, body, { path, auth: 'Bearer commish-secret-12X' })).status, 403, `${path}: a wrong token`);
    assert.strictEqual((await call(method, body, { path, auth: 'commish-secret-123' })).status, 403, `${path}: not a bearer`);
  }
  const offAdmin = { ...env, ADMIN_TOKEN: undefined };
  assert.strictEqual((await worker.fetch(new Request('https://w.example/race/admin', { headers: { Authorization: 'Bearer ' } }), { ...offAdmin, BOARD: { idFromName: (n) => n, get: () => ({ fetch: (req) => new Board({ storage }, offAdmin).fetch(req) }) } })).status, 403, 'off without a token');
  // the drives' titles come from the Pro data the worker serves
  const titles = Array.from({ length: 24 }, (_, i) => (i === 15 ? 'The Miami Miracle' : `Drive ${i + 1}`));
  env.ASSETS = board.env.ASSETS = { fetch: async (req) => (new URL(req.url).pathname === '/pro/drives.json' ? new Response(JSON.stringify({ drives: titles.map((title) => ({ title })) })) : new Response('', { status: 404 })) };
  let ad = await (await call('GET', undefined, { path: '/race/admin', ...AD })).json();
  delete env.ASSETS; delete board.env.ASSETS;
  assert.deepStrictEqual([ad.n, ad.drives[15], ad.entries.map((x) => [x.name, x.n, x.passes.length, x.out])], [24, 'The Miami Miracle', [['Eli Manning', 1, 1, false], ['Tom', 24, 24, false]]], 'every entrant, joined first first');
  const p3 = ad.entries[0].passes[0];
  assert.deepStrictEqual([p3.drive, p3.p, p3.calls, Object.keys(p3).sort().join()], [3, 0.935, 1, 'at,calls,drive,ms,p,sig'], 'a pass: its drive, grade, calls (counted)');
  assert.ok(p3.ms >= 60e3 && p3.ms < 70e3, 'the try\'s length by the server\'s clock');
  assert.strictEqual(ad.entries[1].passes.find((x) => x.drive === 3).sig, p3.sig, 'the same calls: the same signature');
  assert.ok(ad.entries.every((x) => /^[0-9a-f]{24}$/.test(x.id) && x.joined && !('kh' in x)), 'ids for the admin, joined');
  assert.deepStrictEqual([ad.total, ad.next], [2, null], 'one page: no next');
  // a page at a time: limit, and after (the page before's next) for the rest; the same entries either way
  let pg = await (await call('GET', undefined, { path: '/race/admin?limit=1', ...AD })).json();
  assert.deepStrictEqual([pg.total, pg.entries.map((x) => x.name), pg.next], [2, ['Eli Manning'], ida], 'the first page, its last id the next');
  pg = await (await call('GET', undefined, { path: `/race/admin?limit=1&after=${pg.next}`, ...AD })).json();
  assert.deepStrictEqual([pg.entries.map((x) => x.name), pg.next, pg.entries[0].passes.length], [['Tom'], null, 24], 'the last page');
  assert.deepStrictEqual(pg.entries[0], ad.entries[1], 'an entry the same on its page');
  assert.strictEqual((await call('GET', undefined, { path: `/race/admin?after=${'e'.repeat(24)}`, ...AD })).status, 400, 'a cursor that is no entry');
  assert.strictEqual((await call('GET', undefined, { path: `/race/admin?limit=1&after=${ida}` })).status, 403, 'paging takes the token too');
  assert.strictEqual((await (await call('GET', undefined, { path: '/race/admin?limit=x', ...AD })).json()).entries.length, 2, 'a bad limit: the default');
  const realList = store.get('race:list');
  store.set('race:list', { ...realList, ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => { const id = i.toString(16).padStart(24, 'c'); return [id, { id, name: `Fill ${i}`, joined: Date.now() + i, n: 0, nAt: 0 }]; })) });
  pg = await (await call('GET', undefined, { path: '/race/admin', ...AD })).json();
  assert.deepStrictEqual([pg.total, pg.entries.length, pg.entries[49].name], [62, 50, 'Fill 47'], '50 a page by default');
  pg = await (await call('GET', undefined, { path: `/race/admin?after=${pg.next}`, ...AD })).json();
  assert.deepStrictEqual([pg.entries.length, pg.entries[0].name, pg.next], [12, 'Fill 48', null], 'and the rest');
  store.set('race:list', realList);
  let one = await (await call('GET', undefined, { path: `/race/admin?id=${ida}`, ...AD })).json();
  assert.deepStrictEqual([one.entry.name, one.passes.length, one.passes[0].decs, one.passes[0].res, one.passes[0].tryAt, one.voids], ['Eli Manning', 1, decs, WON, new Date(5).toISOString(), []], 'one entry: every call kept');
  assert.strictEqual((await call('GET', undefined, { path: '/race/admin?id=' + 'f'.repeat(24), ...AD })).status, 404, 'no such entry');
  // a pass voided: the count and the time it got there worked out again, the winner with it; the audit kept aside
  const vd = (body) => call('POST', body, { path: '/race/admin/void', ...AD });
  assert.strictEqual((await vd({ id: idb, drive: 5 })).status, 400, 'a note (why) is needed');
  assert.strictEqual((await vd({ id: ida, drive: 5, note: 'x' })).status, 404, 'Eli never passed 5');
  assert.strictEqual((await vd({ id: 'nope', drive: 5, note: 'x' })).status, 404, 'no such entry');
  const tomAt = store.get(`race:e:${idb}`).passes;
  r = await vd({ id: idb, drive: 24, note: 'the last pass: checked, not a real drive' });
  let vo = await r.json();
  assert.deepStrictEqual([r.status, vo.entry.n, vo.entry.done, vo.entry.voids.map((x) => [x.drive, x.p, x.note])], [200, 23, null, [[24, 0.91, 'the last pass: checked, not a real drive']]], 'voided');
  assert.strictEqual(vo.entry.nAt, new Date(tomAt[23]).toISOString(), 'nAt: the last pass left');
  v = await (await rc('/race')).json();
  assert.deepStrictEqual([v.winner, v.rows.map((x) => [x.name, x.n, !!x.done])], [null, [['Tom', 23, false], ['Eli Manning', 1, false]]], 'no winner now, 23');
  assert.ok(!store.has(`race:audit:${idb}:24`) && store.get(`race:void:${idb}:24:${tomAt[24]}`).decs, 'the audit kept aside');
  assert.strictEqual((await vd({ id: idb, drive: 24, note: 'again' })).status, 404, 'voided once');
  one = await (await call('GET', undefined, { path: `/race/admin?id=${idb}`, ...AD })).json();
  assert.deepStrictEqual([one.passes.length, one.voids.length, one.voids[0].drive, one.voids[0].decs], [23, 1, 24, decs], 'the void in the audit, its calls too');
  // the old try's token no longer counts; a new try does, and Tom wins again
  { const e = store.get(`race:e:${idb}`); e.last = 0; store.set(`race:e:${idb}`, e); }
  assert.strictEqual((await rc('/race/pass', { code: cb, key: kb, drive: 24, p: 0.92, decs, res: WON, tok: 'f'.repeat(24) })).status, 409, 'a new try is needed');
  r = await rc('/race/pass', { code: cb, key: kb, drive: 24, p: 0.92, decs, res: WON, tok: await tryOf(cb, kb, 24) });
  v = await r.json();
  assert.deepStrictEqual([v.me.n, !!v.me.done, v.winner && v.winner.name], [24, true, 'Tom'], 'passed again, the winner again');
  // the end time and the next contest: shown with the view; nothing counts after the end
  assert.deepStrictEqual([v.to, v.over, 'next' in v], [null, false, false], 'no end time, no next contest');
  env.NEXT_CONTEST = board.env.NEXT_CONTEST = '  The Playoff Gauntlet: starts in January.  ';
  env.RACE_TO = board.env.RACE_TO = new Date(Date.now() - 1000).toISOString();
  v = await (await rc('/race')).json();
  assert.deepStrictEqual([v.over, v.to, v.next], [true, env.RACE_TO, 'The Playoff Gauntlet: starts in January.'], 'over, and the next one');
  assert.deepStrictEqual(Object.keys(v.rows[0]).sort(), ['at', 'done', 'n', 'name'], 'the standings: name, count, when');
  { const e = store.get(`race:e:${ida}`); e.last = 0; store.set(`race:e:${ida}`, e); }
  const late = await tryOf(ca, ka, 9);
  assert.strictEqual(late, undefined, 'no try starts after the end');
  r = await rc('/race/pass', { code: ca, key: ka, drive: 3, p: 0.95, decs, res: WON, tok });
  assert.deepStrictEqual([r.status, (await r.json()).error], [409, 'the Gauntlet is over'], 'no pass counts after the end');
  env.NEXT_CONTEST = board.env.NEXT_CONTEST = '   ';
  delete env.RACE_TO; delete board.env.RACE_TO;
  v = await (await rc('/race')).json();
  assert.deepStrictEqual([v.over, 'next' in v], [false, false], 'a blank next contest is left out');
  delete env.NEXT_CONTEST; delete board.env.NEXT_CONTEST;
  // the check finds Tom's run wrong: off the board for good, and the winner goes to the next finisher (none)
  assert.strictEqual((await call('DELETE', undefined, { path: '/race?name=tom' })).status, 403, 'admin only');
  assert.strictEqual((await call('DELETE', undefined, { path: '/race?name=tom', auth: 'Bearer commish-secret-123' })).status, 200);
  v = await (await rc('/race')).json();
  assert.deepStrictEqual([v.rows.map((x) => x.name), v.winner, v.entrants], [['Eli Manning'], null, 1], 'out, the winner with him');
  assert.strictEqual((await rc('/race/join', { code: cb, key: kb, name: 'Tom Again' })).status, 403, 'and out for good');
  ad = await (await call('GET', undefined, { path: '/race/admin', auth: 'Bearer commish-secret-123' })).json();
  assert.deepStrictEqual(ad.entries.map((x) => [x.name, x.out]), [['Eli Manning', false], ['Tom', true]], 'the admin still sees a run taken off');
  // by id too (the admin page's button); an id never entered is 404
  assert.strictEqual((await call('DELETE', undefined, { path: '/race?id=' + 'e'.repeat(24), auth: 'Bearer commish-secret-123' })).status, 404);
  assert.strictEqual((await call('DELETE', undefined, { path: `/race?id=${ida}`, auth: 'Bearer commish-secret-123' })).status, 200);
  assert.deepStrictEqual((await (await rc('/race')).json()).rows, [], 'off by id');
}
// Accounts: Sign in with Google (an ID token checked against Google's keys), or a one-use emailed link; Pro on the
// account (a linked code, or a purchase made signed in), used by session on any device; codes work as before
{
  const realFetch = globalThis.fetch;
  const envs = [env, board.env];
  const set = (o) => { for (const e of envs) Object.assign(e, o); };
  const unset = (...ks) => { for (const e of envs) for (const k of ks) delete e[k]; };
  const au = (path, body, o = {}) => call(body === undefined ? 'GET' : 'POST', body, { path, ...o });
  // off until configured: GET /auth says so, the rest answer 503
  assert.deepStrictEqual(await (await au('/auth')).json(), { google: false, email: false });
  for (const p of ['/auth/google', '/auth/email', '/auth/email/verify', '/auth/me', '/auth/link', '/auth/logout']) assert.strictEqual((await au(p, {})).status, 503, `${p} off`);
  // Google's keys (ours, for the test) and Resend, stubbed
  const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const kp = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']), other = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const mails = [], stripeForms = [];
  let buyRef = null;                    // the reference Stripe hands back with the signed-in purchase
  let certFetches = 0;
  globalThis.fetch = async (u, init) => {
    if (u === 'https://www.googleapis.com/oauth2/v3/certs') { certFetches++; return new Response(JSON.stringify({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] }), { status: 200, headers: { 'Cache-Control': 'public, max-age=20000' } }); }
    if (u === 'https://api.resend.com/emails') { mails.push([init.headers, JSON.parse(init.body)]); return new Response(JSON.stringify({ id: 'mail_1' }), { status: 200 }); }
    if (u === 'https://api.stripe.com/v1/checkout/sessions') { stripeForms.push(new URLSearchParams(init.body)); return new Response(JSON.stringify({ id: 'cs_test_acct1234567890', url: 'https://checkout.stripe.com/c/pay/cs_test_acct1234567890' }), { status: 200 }); }
    const m = String(u).match(/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/);
    if (m && m[1].startsWith('cs_test_buy')) return new Response(JSON.stringify({ id: m[1], payment_status: 'paid', client_reference_id: m[1] === 'cs_test_buyemail000001' ? buyRef : null }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const CLIENT = '1234-test.apps.googleusercontent.com';
  set({ GOOGLE_CLIENT_ID: CLIENT });
  assert.deepStrictEqual(await (await au('/auth')).json(), { google: true, email: false });
  const b64u = (x) => Buffer.from(x).toString('base64url');
  const idToken = async (claims = {}, key = kp.privateKey, kid = 'test-kid-1') => {
    const head = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1100220033', email: 'Eli@Example.com', email_verified: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64u(sig)}`;
  };
  r = await au('/auth/google', { credential: await idToken() });
  assert.strictEqual(r.status, 200, 'a valid Google token');
  const g = await r.json();
  assert.match(g.session, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual([g.email, g.pro, g.code], ['eli@example.com', false, undefined]);
  assert.ok(store.has(`auth:sess:${await sha256hex(g.session)}`) && !JSON.stringify([...store.keys()]).includes(g.session), 'only the session\'s hash is stored');
  assert.deepStrictEqual(store.get('acct:g:1100220033').email, 'eli@example.com', 'the account is g:<sub>');
  for (const [why, cred] of [['wrong aud', await idToken({ aud: 'someone-else.apps.googleusercontent.com' })], ['expired', await idToken({ exp: Math.floor(Date.now() / 1000) - 10 })],
    ['bad signature', await idToken({}, other.privateKey)], ['wrong iss', await idToken({ iss: 'https://evil.example' })], ['address not verified', await idToken({ email_verified: false })],
    ['unknown kid', await idToken({}, kp.privateKey, 'nope')], ['tampered', (await idToken()).replace(/\.([^.]+)\./, (_, b) => `.${b64u(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), sub: '999' }))}.`)],
    ['garbage', 'a.b.c'], ['none', undefined]]) {
    assert.strictEqual((await au('/auth/google', { credential: cred })).status, 401, why);
  }
  assert.strictEqual(certFetches, 1, 'Google\'s keys are cached (an unknown kid asks again at most once a minute)');
  assert.strictEqual((await au('/auth/google', { credential: await idToken({ iss: 'accounts.google.com' }) })).status, 200, 'the bare issuer too');
  // me, never another's; a bad session is signed out
  assert.deepStrictEqual(await (await au('/auth/me', { session: g.session })).json(), { email: 'eli@example.com', name: '', pro: false });
  assert.strictEqual((await au('/auth/me', { session: 'f'.repeat(64) })).status, 401);
  assert.strictEqual((await au('/auth/me', { session: 'short' })).status, 401);
  // email links: off without Resend, then one use, 15 minutes, the same answer for anyone
  assert.strictEqual((await au('/auth/email', { email: 'pat@example.com' })).status, 503, 'no RESEND_KEY: off');
  set({ RESEND_KEY: 're_test_key', MAIL_FROM: 'Two-Minute Drill <signin@nfl2mindrill.com>', SITE: 'https://nfl2mindrill.com' });
  assert.deepStrictEqual(await (await au('/auth')).json(), { google: true, email: true });
  for (const bad of ['', 'pat', 'pat@', '@example.com', 'pat@example', 'a b@example.com', `${'x'.repeat(190)}@example.com`]) assert.strictEqual((await au('/auth/email', { email: bad })).status, 400, `address ${bad}`);
  r = await au('/auth/email', { email: ' Pat@Example.com ' });
  assert.strictEqual(r.status, 200);
  const answer = await r.json();
  const [mh, mb] = mails[mails.length - 1];
  assert.strictEqual(mh.Authorization, 'Bearer re_test_key');
  assert.deepStrictEqual([mb.from, mb.to], ['Two-Minute Drill <signin@nfl2mindrill.com>', ['pat@example.com']]);
  const linkTok = (m) => (m.text.match(/https:\/\/nfl2mindrill\.com\/\?login=([0-9a-f]{64})/) || [])[1];
  const t1 = linkTok(mb);
  assert.ok(t1, 'the link: SITE/?login=<token>');
  assert.ok(!JSON.stringify([...store]).includes(t1), 'only the token\'s hash is stored');
  assert.deepStrictEqual(await (await au('/auth/email', { email: 'nobody-yet@example.com' })).json(), answer, 'the same answer for any address');
  r = await au('/auth/email/verify', { token: t1 });
  assert.strictEqual(r.status, 200);
  const e1 = await r.json();
  assert.deepStrictEqual([e1.email, e1.pro, /^[0-9a-f]{64}$/.test(e1.session)], ['pat@example.com', false, true]);
  assert.ok(store.get('acct:e:pat@example.com'), 'the account is e:<address>');
  assert.strictEqual((await au('/auth/email/verify', { token: t1 })).status, 401, 'a link works once');
  assert.strictEqual((await au('/auth/email/verify', { token: 'f'.repeat(64) })).status, 401, 'a token never sent');
  assert.strictEqual((await au('/auth/email/verify', { token: 'nope' })).status, 400);
  await au('/auth/email', { email: 'pat@example.com' });
  const t2 = linkTok(mails[mails.length - 1][1]), k2 = `auth:login:${await sha256hex(t2)}`;
  store.set(k2, { ...store.get(k2), exp: Date.now() - 1 });                // 15 minutes on
  assert.strictEqual((await au('/auth/email/verify', { token: t2 })).status, 401, 'an expired link');
  assert.ok(!store.has(k2), 'and gone');
  r = await au('/auth/email', { email: 'PAT@example.com' });
  assert.strictEqual(r.status, 200, 'a third link for the address');
  assert.strictEqual((await au('/auth/email', { email: 'pat@example.com' })).status, 429, 'a fourth in 15 minutes: refused');
  const one = { ip: '6.6.6.6' };
  for (const a of ['a1@example.com', 'a2@example.com', 'a3@example.com']) assert.strictEqual((await au('/auth/email', { email: a }, one)).status, 200);
  assert.strictEqual((await au('/auth/email', { email: 'a4@example.com' }, one)).status, 429, 'and per address (IP)');
  // Pro on an account: link a code this device holds; a code belongs to one account
  set({ STRIPE_SECRET: 'rk_live_x', KEY_REQUIRED_FROM: '2000-01-01' });
  const code = 'TMD-KKKK-MMMM-NNNN', dk = 'acct-device-key-00000001';
  store.set(`pro:code:${code}`, { s: 'cs_test_k', at: '2026-10-16' });
  assert.strictEqual((await au('/auth/link', { session: g.session, code: 'TMD-AAAA-AAAA-AAAA', key: dk })).status, 404, 'a code never issued');
  assert.strictEqual((await au('/auth/link', { session: 'f'.repeat(64), code, key: dk })).status, 401, 'signed out');
  r = await au('/auth/link', { session: g.session, code: code.toLowerCase(), key: dk });
  assert.deepStrictEqual([r.status, await r.json()], [200, { email: 'eli@example.com', name: '', pro: true, code }], 'linked');
  assert.strictEqual(store.get(`pro:code:${code}`).acct, 'g:1100220033');
  r = await au('/auth/link', { session: e1.session, code, key: 'acct-device-key-00000002' });
  assert.deepStrictEqual([r.status, (await r.json()).error], [409, 'This Pro code belongs to another account.'], 'one account a code');
  assert.strictEqual((await au('/auth/link', { session: g.session, code, key: dk })).status, 200, 'linking again: the same');
  assert.deepStrictEqual(await (await au('/auth/me', { session: e1.session })).json(), { email: 'pat@example.com', name: '', pro: false }, 'never another account\'s Pro');
  // a username: shown in the top bar; checked, one account each (any case), changed freely, the old one let go
  for (const bad of ['', 'ab', 'x'.repeat(21), ' -lead', 'trail-', 'no<tags>', 'emoji\u{1F3C8}', 'FuckFace']) {
    assert.ok([400, 409].includes((await au('/auth/name', { session: g.session, name: bad })).status), `username ${JSON.stringify(bad)}`);
  }
  assert.strictEqual((await au('/auth/name', { session: 'f'.repeat(64), name: 'Gridiron Eli' })).status, 401, 'signed out');
  r = await au('/auth/name', { session: g.session, name: '  Gridiron   Eli ' });
  assert.deepStrictEqual([r.status, await r.json()], [200, { email: 'eli@example.com', name: 'Gridiron Eli', pro: true, code }], 'set, spaces tidied');
  assert.strictEqual((await (await au('/auth/me', { session: g.session })).json()).name, 'Gridiron Eli', 'kept');
  r = await au('/auth/name', { session: e1.session, name: 'gridiron eli' });
  assert.deepStrictEqual([r.status, (await r.json()).taken], [409, true], 'one account a username, any case');
  assert.strictEqual((await au('/auth/name', { session: g.session, name: 'GRIDIRON ELI' })).status, 200, 'his own, in new case');
  assert.strictEqual((await au('/auth/name', { session: g.session, name: "O'Neil_2.0" })).status, 200, 'changed');
  assert.ok(!store.has('auth:name:gridiron eli') && store.get("auth:name:o'neil_2.0") === 'g:1100220033', 'the old one let go');
  assert.strictEqual((await au('/auth/name', { session: e1.session, name: 'Gridiron Eli' })).status, 200, 'and free for another');
  // Pro by session: /restore and /pro/data, no device limit; the code itself keeps its limit
  for (const k of ['acct-device-key-00000003', 'acct-device-key-00000004']) assert.strictEqual((await au('/restore', { code, key: k })).status, 200);
  assert.strictEqual((await au('/restore', { code, key: 'acct-device-key-00000005' })).status, 409, 'the code: 3 devices, as ever');
  assert.deepStrictEqual(await (await au('/restore', { session: g.session })).json(), { ok: true, code }, 'signed in: any device');
  r = await au('/restore', { session: e1.session });
  assert.deepStrictEqual([r.status, (await r.json()).noPro], [403, true], 'an account without Pro');
  r = await au('/restore', { session: 'f'.repeat(64) });
  assert.deepStrictEqual([r.status, (await r.json()).signedOut], [401, true], 'a session gone');
  set({ ASSETS: { fetch: async () => new Response('{"drives":[]}', { status: 200 }) } });
  r = await au('/pro/data', { session: g.session, name: 'drives.json' });
  assert.deepStrictEqual([r.status, await r.json()], [200, { drives: [] }], 'the Pro data by session');
  assert.strictEqual((await au('/pro/data', { session: e1.session, name: 'drives.json' })).status, 403);
  assert.strictEqual((await au('/pro/data', { session: 'f'.repeat(64), name: 'drives.json' })).status, 401);
  assert.strictEqual((await au('/pro/data', { code, key: 'acct-device-key-00000005', name: 'drives.json' })).status, 409, 'the code path keeps its limit');
  // the Gauntlet: an entry by session is the entry of the account's code
  r = await au('/race/join', { session: g.session, name: 'Signed In Eli' });
  const viaSess = await r.json();
  assert.strictEqual(r.status, 200);
  const viaCode = await (await au('/race/me', { code, key: dk })).json();
  assert.deepStrictEqual(viaCode.me, viaSess.me, 'the same entry by code');
  assert.ok(store.get(`race:e:${(await sha256hex('race:' + code)).slice(0, 24)}`), 'keyed by the code');
  assert.strictEqual((await au('/race/me', { session: e1.session })).status, 403, 'no Pro, no entry');
  // a purchase made signed in: the account goes to Stripe, and the code joins it (the claim, or the webhook)
  r = await au('/pay', { session: e1.session });
  assert.strictEqual(r.status, 200);
  buyRef = stripeForms[stripeForms.length - 1].get('client_reference_id');
  assert.match(buyRef, /^a_[0-9a-f]{40}$/, 'Stripe gets an opaque reference, never the address');
  assert.ok(!stripeForms[stripeForms.length - 1].toString().includes('pat%40example') && !stripeForms[stripeForms.length - 1].toString().includes('pat@example'), 'no email address goes to Stripe');
  await au('/pay', {});
  assert.strictEqual(stripeForms[stripeForms.length - 1].get('client_reference_id'), null, 'not signed in: no account');
  assert.strictEqual((await au('/pay', { session: 'f'.repeat(64) })).status, 401, 'a session gone: not bought blind');
  const bought = (await (await au('/claim', { s: 'cs_test_buyemail000001', key: 'acct-device-key-00000009' })).json()).code;
  assert.match(bought, /^TMD-/);
  assert.deepStrictEqual(await (await au('/auth/me', { session: e1.session })).json(), { email: 'pat@example.com', name: 'Gridiron Eli', pro: true, code: bought }, 'the purchase is the account\'s');
  assert.strictEqual(store.get(`pro:code:${bought}`).acct, 'e:pat@example.com');
  const plainBuy = (await (await au('/claim', { s: 'cs_test_buyplain00001' })).json()).code;
  assert.ok(!store.get(`pro:code:${plainBuy}`).acct, 'a purchase not signed in: a plain code');
  const whsec = 'whsec_test_acct_0001';
  set({ STRIPE_WEBHOOK_SECRET: whsec });
  const gs = await (await au('/auth/google', { credential: await idToken({ sub: '5550001', email: 'new@example.com' }) })).json();
  await au('/pay', { session: gs.session });
  const hookRef = stripeForms[stripeForms.length - 1].get('client_reference_id');
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_hookacct000001', payment_status: 'paid', client_reference_id: hookRef } } });
  const t = Math.floor(Date.now() / 1000), hk = await crypto.subtle.importKey('raw', new TextEncoder().encode(whsec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', hk, new TextEncoder().encode(`${t}.${body}`))).toString('hex');
  r = await worker.fetch(new Request('https://w.example/stripe-webhook', { method: 'POST', body, headers: { 'Stripe-Signature': `t=${t},v1=${mac}` } }), env);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await (await au('/auth/me', { session: gs.session })).json(), { email: 'new@example.com', name: '', pro: true, code: store.get('pro:sess:cs_test_hookacct000001') }, 'the webhook attaches it too');
  // sign out; an old session expires
  assert.strictEqual((await au('/auth/logout', { session: gs.session })).status, 200);
  assert.strictEqual((await au('/auth/me', { session: gs.session })).status, 401, 'signed out');
  const sk = `auth:sess:${await sha256hex(g.session)}`;
  store.set(sk, { ...store.get(sk), at: Date.now() - 181 * 864e5 });
  assert.strictEqual((await au('/auth/me', { session: g.session })).status, 401, 'a session lasts 180 days');
  assert.ok(!store.has(sk));
  // turned off again: sessions are not honoured, codes still are
  unset('GOOGLE_CLIENT_ID', 'RESEND_KEY', 'MAIL_FROM');
  assert.strictEqual((await au('/restore', { session: e1.session })).status, 401, 'accounts off: a session is no use');
  assert.strictEqual((await au('/restore', { code: bought, key: 'acct-device-key-00000009' })).status, 200, 'the code still works');
  unset('STRIPE_SECRET', 'STRIPE_WEBHOOK_SECRET', 'ASSETS', 'SITE');
  globalThis.fetch = realFetch;
}
// the day's top 10 and the week (POST /daily's week, GET /week, DELETE /week): a name's best 5 days of the 7 added up,
// once a name a day, the window moving day by day, your rank from the counts, blocked names, the caps, the commissioner
{
  const realNow = Date.now, at = (date) => { Date.now = () => Date.parse(date + 'T15:00:00Z'); };
  const D = (k) => new Date(Date.parse('2027-03-01T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);     // D(0) = 2027-03-01
  const wkey = (who) => `week-test-key-${who}`.padEnd(24, '0');
  const post = async (k, who, p, name) => { at(D(k)); return (await day({ date: D(k), key: wkey(`${who}-${k}`), p, spots: [0], ...(name !== null ? { name: name || who } : {}) })).json(); };
  // Wes plays 7 days running: 50 60 70 80 90 40 30 -> best 5: 90+80+70+60+50 = 350
  const wes = [0.5, 0.6, 0.7, 0.8, 0.9, 0.4, 0.3];
  // a name stays one device's: Wes posts each day from his own device (the key is his, the same one every day)
  const wesPost = async (k, p) => { at(D(k)); return (await day({ date: D(k), key: wkey('wes'), p, spots: [0], name: 'Wes' })).json(); };
  let w;
  for (let k = 0; k < 7; k++) w = await wesPost(k, wes[k]);
  assert.deepStrictEqual(w.week.you, { pts: 350, days: 7, rank: 1 }, 'his best 5 of 7, added up');
  assert.deepStrictEqual([w.week.from, w.week.to, w.week.best, w.week.n], [D(0), D(6), 5, 1]);
  // Val plays 3 days late in the week, all high: 95+95+95 = 285, behind Wes
  const valPost = async (k, p, name = 'Val') => { at(D(k)); return (await day({ date: D(k), key: wkey('val'), p, spots: [0], name })).json(); };
  for (const k of [4, 5]) await valPost(k, 0.95);
  w = await valPost(6, 0.95);
  assert.deepStrictEqual(w.week.you, { pts: 285, days: 3, rank: 2 }, 'three days: 285, second');
  assert.deepStrictEqual(w.week.top.map((x) => [x.name, x.pts, x.days]), [['Wes', 350, 7], ['Val', 285, 3]]);
  // an anonymous result counts in the day (n, histogram) but not in the week
  at(D(6));
  w = await (await day({ date: D(6), key: wkey('anon-6'), p: 1, spots: [0] })).json();
  assert.strictEqual(w.week.n, 2, 'no name: not in the week'); assert.strictEqual(w.week.you, undefined);
  assert.strictEqual(w.n, 3, 'but in the day'); assert.strictEqual(w.hist[100], 1);
  // the day's top 10 lists names only, best first
  assert.deepStrictEqual(w.top.map((x) => x.name), ['Val', 'Wes']);
  // a replay of the day changes nothing; a name given afterwards puts the day's first result on both lists
  w = await wesPost(6, 1);
  assert.strictEqual(w.counted, false); assert.deepStrictEqual(w.week.you, { pts: 350, days: 7, rank: 1 });
  at(D(6));
  w = await (await day({ date: D(6), key: wkey('anon-6'), p: 0.2, spots: [0], name: 'Late Larry' })).json();
  assert.strictEqual(w.counted, false); assert.deepStrictEqual(w.week.you, { pts: 100, days: 1, rank: 3 }, 'named afterwards: its first result, 100');
  assert.ok(w.top.some((x) => x.name === 'Late Larry' && x.p === 1));
  // the window moves: the week to D(7) drops D(0) (Wes's 50: his best 5 now 90+80+70+60+40 = 340; with D(7)'s 20 still 340)
  w = await wesPost(7, 0.2);
  assert.deepStrictEqual(w.week.you, { pts: 340, days: 7, rank: 1 }, 'D(0) out of the window, D(7) in');
  assert.strictEqual(w.week.from, D(1));
  let g = await (await call('GET', null, { path: `/week?date=${D(6)}` })).json();
  assert.deepStrictEqual(g.top.map((x) => [x.name, x.pts]), [['Wes', 350], ['Val', 285], ['Late Larry', 100]], 'a past week stands as it was');
  assert.strictEqual(g.you, undefined, 'a GET has no "you"'); assert.ok(!JSON.stringify(g).includes('kh') && !JSON.stringify(g).includes('"at"'), 'no key hashes or times out');
  // a result counts in the weeks it is in, and only those: D(6)'s in the week to D(12), not D(13)
  g = await (await call('GET', null, { path: `/week?date=${D(12)}` })).json();
  assert.deepStrictEqual(g.top.map((x) => [x.name, x.pts]), [['Late Larry', 100], ['Val', 95], ['Wes', 50]], 'the week to D(12): D(6) and D(7) only (Wes 30 + 20)');
  g = await (await call('GET', null, { path: `/week?date=${D(13)}` })).json();
  assert.deepStrictEqual(g.top.map((x) => [x.name, x.pts]), [['Wes', 20]], 'the week to D(13): D(7) only');
  assert.deepStrictEqual((await (await call('GET', null, { path: `/week?date=${D(40)}` })).json()).top, [], 'a week nobody played');
  // a name's own record keeps two weeks: older days are dropped as new ones come
  w = await wesPost(22, 0.5);
  assert.deepStrictEqual(Object.keys(store.get('wn:wes').d), [D(22)], 'days more than two weeks before dropped');
  // ties: the same points, whoever got there first
  for (const nm of ['Tie One', 'Tie Two']) { at(D(30)); await day({ date: D(30), key: wkey(nm.replace(' ', '')), p: 0.66, spots: [0], name: nm }); }
  g = await (await call('GET', null, { path: `/week?date=${D(30)}` })).json();
  assert.deepStrictEqual(g.top.map((x) => x.name), ['Tie One', 'Tie Two'], 'a tie: the first there first');
  // validation: a date wanted; only GET and the commissioner's DELETE
  for (const q of ['', '?date=today', '?date=2027-13-45']) assert.strictEqual((await call('GET', null, { path: `/week${q}` })).status, 400, q);
  assert.strictEqual((await call('POST', {}, { path: `/week?date=${D(6)}` })).status, 405);
  // blocked names: refused on the post (the result counts, unnamed), and a stored row with one is never shown
  w = await post(30, 'bad', 0.99, 'sh1t h3ad');
  assert.strictEqual(w.refused, true); assert.strictEqual(w.week.you, undefined); assert.strictEqual(w.week.n, 2);
  const wk30 = store.get(`wk:${D(30)}`);
  wk30.top.unshift({ name: 'b!tch', pts: 500, days: 5, at: 0 }); store.set(`wk:${D(30)}`, wk30);
  g = await (await call('GET', null, { path: `/week?date=${D(30)}` })).json();
  assert.deepStrictEqual(g.top.map((x) => x.name), ['Tie One', 'Tie Two'], 'a stored blocked name left out');
  // caps: 120 names in a day: the day keeps 25 and shows 10, the week keeps 100 and shows 10, and every name's rank is
  // its own (from the counts, past the lists)
  for (let i = 0; i < 120; i++) w = await post(50, `cap${i}`, (i % 100) / 100, `Cap ${i}`);
  assert.deepStrictEqual([store.get(`day:${D(50)}`).top.length, w.top.length], [25, 10], 'day: 25 kept, 10 shown');
  assert.deepStrictEqual([store.get(`wk:${D(50)}`).top.length, w.week.top.length, w.week.n], [100, 10, 120], 'week: 100 kept, 10 shown, 120 ranked');
  assert.deepStrictEqual(w.week.you, { pts: 19, days: 1, rank: 81 }, 'Cap 119 (19 points): the 80 names on 20-99 above it, past the lists');
  assert.deepStrictEqual(w.week.top.slice(0, 2).map((x) => [x.name, x.pts]), [['Cap 99', 99], ['Cap 98', 98]]);
  assert.ok(JSON.stringify(store.get(`wk:${D(50)}`)).length < 16000, 'a week stays small');
  // the commissioner takes a name off: off the day and week lists, out of the counts, and kept off
  assert.strictEqual((await call('DELETE', null, { path: '/week?name=Cap%2099' })).status, 403, 'no token');
  assert.strictEqual((await call('DELETE', null, { path: '/week?name=Cap%2099', auth: 'Bearer wrong-token-xxxxxxxx' })).status, 403);
  r = await call('DELETE', null, { path: '/week?name=cap%2099', auth: `Bearer ${env.ADMIN_TOKEN}` });
  assert.deepStrictEqual([r.status, (await r.json()).removed > 0], [200, true]);
  g = await (await call('GET', null, { path: `/week?date=${D(50)}` })).json();
  assert.deepStrictEqual([g.top[0].name, g.n], ['Cap 98', 119], 'off the week, out of its count');
  assert.ok(!(await (await call('GET', null, { path: `/daily?date=${D(50)}` })).json()).top.some((x) => x.name === 'Cap 99'), 'off the day list');
  at(D(51));
  w = await (await day({ date: D(51), key: wkey('cap99-51'), p: 1, spots: [0], name: 'Cap 99' })).json();
  assert.strictEqual(w.counted, true); assert.ok(!w.top.some((x) => x.name === 'Cap 99') && w.week.you === undefined, 'kept off');
  // posts are limited per address, like every post
  at(D(51));
  const one = { ip: '10.9.9.9' };
  for (let i = 0; i < 30; i++) assert.strictEqual((await day({ date: D(51), key: wkey(`rl${i}`), p: 0.5, spots: [0] }, one)).status, 200);
  assert.strictEqual((await day({ date: D(51), key: wkey('rl-x'), p: 0.5, spots: [0] }, one)).status, 429, 'rate limited');
  Date.now = realNow;
}
// a restarted daily (game.js restartAsk: the day's drive started over): the device's first result all the same (a later
// post changes nothing), but off the day's numbers (n, histogram, the spots' averages: n stays the histogram's total)
// and off the day's and week's lists, named or not; counted on its own (nr)
{
  const realNow = Date.now, date = new Date(Date.parse('2027-06-01T12:00:00Z')).toISOString().slice(0, 10);
  Date.now = () => Date.parse(date + 'T15:00:00Z');
  const rk = (who) => `restart-test-key-${who}`.padEnd(24, '0');
  let w = await (await day({ date, key: rk('ann'), p: 0.6, spots: [0.1], name: 'Ann' })).json();
  assert.deepStrictEqual([w.counted, w.n, w.nr, w.hist[60]], [true, 1, 0, 1], 'a plain result: counted');
  w = await (await day({ date, key: rk('rob'), p: 0.97, spots: [0.4], name: 'Rob', restarted: true })).json();
  assert.deepStrictEqual([w.counted, w.n, w.nr, w.hist[97], w.spots[0].n], [true, 1, 1, 0, 1], 'restarted: not in n, the histogram or the spot');
  assert.ok(Math.abs(w.spots[0].avg - 0.1) < 1e-9, 'nor the spot\'s average');
  assert.deepStrictEqual(w.you, { p: 0.97, spots: [0.4], restarted: true }, 'its own result, marked');
  assert.deepStrictEqual(w.top.map((x) => x.name), ['Ann'], 'not on the day\'s list');
  assert.strictEqual(w.week.n, 1, 'nor the week\'s'); assert.strictEqual(w.week.you, undefined);
  assert.ok(!store.has('wn:rob') || !(date in store.get('wn:rob').d), 'no week points kept');
  assert.strictEqual(w.hist.reduce((a, c) => a + c, 0), w.n, 'n is the histogram\'s total');
  // the first result stands: a plain post after it is still the restarted one, never counted, never listed
  w = await (await day({ date, key: rk('rob'), p: 0.99, spots: [0.5], name: 'Rob' })).json();
  assert.deepStrictEqual([w.counted, w.n, w.nr, w.you.p, w.you.restarted], [false, 1, 1, 0.97, true], 'a later plain post changes nothing');
  assert.deepStrictEqual(w.top.map((x) => x.name), ['Ann']);
  // unnamed, then named afterwards: still off the lists
  await day({ date, key: rk('kim'), p: 0.88, spots: [0], restarted: true });
  w = await (await day({ date, key: rk('kim'), p: 0.88, spots: [0], name: 'Kim' })).json();
  assert.deepStrictEqual([w.n, w.nr, w.top.map((x) => x.name).join()], [1, 2, 'Ann'], 'named afterwards: still off');
  // only a real true marks it (anything else is a plain result); GET and /days read the counted ones only
  w = await (await day({ date, key: rk('lee'), p: 0.5, spots: [0], restarted: 'yes' })).json();
  assert.deepStrictEqual([w.n, w.nr, w.you.restarted], [2, 2, undefined]);
  const g = await (await call('GET', null, { path: `/daily?date=${date}` })).json();
  assert.deepStrictEqual([g.n, g.nr, g.hist[97]], [2, 2, 0]);
  const dd = (await (await call('GET', null, { path: '/days' })).json()).days.find((x) => x.date === date);
  assert.deepStrictEqual([dd.n, dd.best], [2, 0.6], 'the stats page: counted results only');
  // fair-scored (g: 2) and restarted: off the fair set too (its n, histogram, spots, top list; /days' n2, avg2, best2),
  // still the device's one result, marked both ways; a fair, plain post goes into both sets
  w = await (await day({ date, key: rk('fay'), p: 0.7, spots: [0.2], name: 'Fay', g: 2 })).json();
  assert.deepStrictEqual([w.n, w.fair.n, w.fair.hist[70], w.fair.top.map((x) => x.name).join(), w.top.map((x) => x.name).join()], [3, 1, 1, 'Fay', 'Fay,Ann'], 'fair and plain: both sets');
  w = await (await day({ date, key: rk('gus'), p: 0.99, spots: [0.5], name: 'Gus', g: 2, restarted: true })).json();
  assert.deepStrictEqual([w.counted, w.n, w.nr, w.fair.n, w.fair.hist[99], w.hist[99], w.fair.spots[0].n], [true, 3, 3, 1, 0, 0, 1], 'fair and restarted: in neither set');
  assert.ok(Math.abs(w.fair.spots[0].avg - 0.2) < 1e-9, 'nor the fair spot\'s average');
  assert.deepStrictEqual([w.you.g, w.you.restarted], [2, true]);
  assert.deepStrictEqual([w.fair.top.map((x) => x.name).join(), w.top.map((x) => x.name).join()], ['Fay', 'Fay,Ann'], 'on neither list');
  assert.strictEqual(w.fair.hist.reduce((a, c) => a + c, 0), w.fair.n, 'the fair n is its histogram\'s total');
  w = await (await day({ date, key: rk('gus'), p: 0.99, spots: [0.5], name: 'Gus', g: 2 })).json();
  assert.deepStrictEqual([w.counted, w.n, w.fair.n, w.you.restarted, w.you.g], [false, 3, 1, true, 2], 'a later fair post: still the restarted one');
  assert.ok(!w.fair.top.some((x) => x.name === 'Gus') && !w.top.some((x) => x.name === 'Gus'), 'named afterwards: still off both lists');
  const d2 = (await (await call('GET', null, { path: '/days' })).json()).days.find((x) => x.date === date);
  assert.deepStrictEqual([d2.n, d2.n2, d2.best, d2.best2], [3, 1, 0.7, 0.7], 'the stats page\'s fair figures: counted results only');
  Date.now = realNow;
}
// a day offering two sides of one real game (game.js sidesOf): each post says the side it took (a team's code); the
// day's numbers stay both sides together, and each side keeps its own n, histogram and average (the fair set's too);
// a restarted one counts in neither; a bad side is refused like any bad field; a later post never moves a side
{
  const realNow = Date.now, date = '2027-06-03';
  Date.now = () => Date.parse(date + 'T15:00:00Z');
  const sk = (who) => `side-test-key-${who}`.padEnd(24, '0');
  let w = await (await day({ date, key: sk('a'), p: 0.8, spots: [0.1], side: 'LA', g: 2 })).json();
  assert.deepStrictEqual([w.counted, w.n, w.sides.LA.n, w.sides.LA.hist[80], w.you.side, w.fair.sides.LA.n], [true, 1, 1, 1, 'LA', 1]);
  w = await (await day({ date, key: sk('b'), p: 0.4, spots: [-0.1], side: 'LA' })).json();
  w = await (await day({ date, key: sk('c'), p: 0.3, spots: [0.2], side: 'ARI', g: 2 })).json();
  assert.deepStrictEqual([w.n, w.hist[80] + w.hist[40] + w.hist[30], w.sides.LA.n, w.sides.ARI.n, w.fair.n, w.fair.sides.LA.n, w.fair.sides.ARI.n], [3, 3, 2, 1, 2, 1, 1], 'the day both sides together; each side its own');
  assert.ok(Math.abs(w.sides.LA.avg - 0.6) < 1e-9 && Math.abs(w.sides.ARI.avg - 0.3) < 1e-9, 'each side\'s average score (0-1)');
  assert.ok(Math.abs(w.spots[0].avg - 0.2 / 3) < 1e-9, 'the drive\'s average: both sides');
  w = await (await day({ date, key: sk('d'), p: 0.99, spots: [0.5], side: 'ARI', restarted: true })).json();
  assert.deepStrictEqual([w.n, w.nr, w.sides.ARI.n, w.you.side], [3, 1, 1, 'ARI'], 'restarted: in no side either');
  w = await (await day({ date, key: sk('a'), p: 0.1, spots: [0], side: 'ARI' })).json();
  assert.deepStrictEqual([w.counted, w.you.side, w.sides.LA.n, w.sides.ARI.n], [false, 'LA', 2, 1], 'the first result and its side stand');
  for (const bad of ['la', 'LOSANGELES', 3, true, '', 'L A', ['LA']]) assert.strictEqual((await day({ date, key: sk('x'), p: 0.5, spots: [0], side: bad })).status, 400, `side ${JSON.stringify(bad)}`);
  w = await (await day({ date, key: sk('e'), p: 0.5, spots: [0], side: null })).json();
  assert.deepStrictEqual([w.counted, w.n, w.you.side, Object.keys(w.sides).join()], [true, 4, undefined, 'LA,ARI'], 'no side: counted, by no side');
  for (const [k, t] of [['f', 'NE'], ['g', 'KC'], ['h', 'SF']]) w = await (await day({ date, key: sk(k), p: 0.5, spots: [0], side: t })).json();
  assert.deepStrictEqual([w.n, Object.keys(w.sides).join()], [7, 'LA,ARI,NE,KC'], 'four sides a day at most; the fifth counts, by no side');
  const g = await (await call('GET', null, { path: `/daily?date=${date}` })).json();
  assert.deepStrictEqual([g.sides.LA.n, g.sides.ARI.n, g.fair.sides.ARI.n], [2, 1, 1], 'GET /daily: the sides');
  const plain = await (await call('GET', null, { path: '/daily?date=2027-06-01' })).json();
  assert.strictEqual(plain.sides, undefined, 'an ordinary day: no sides');
  Date.now = realNow;
}
// the weeks made fair (OLD_WAY_DAYS: Oct 18, 2026, the day the fair score came in): an old-way result of that day goes
// on the day's whole list but into no week (the name's day used all the same), a fair one counts as on any day; the
// weeks kept before the fix (old-way points in wn:<name> and wk:<D>..<D+6>) are made again once, at the board's start
{
  const realNow = Date.now, at = (date) => { Date.now = () => Date.parse(date + 'T15:00:00Z'); };
  const D = '2026-10-18', ends = [0, 1, 2, 3, 4, 5, 6].map((k) => `2026-10-${18 + k}`), fk = (who) => `fairweek-key-${who.replace(/\W/g, '')}-`.padEnd(24, 'x');
  const post = async (date, who, p, x = {}) => { at(date); return (await day({ date, key: fk(who), p, spots: [0], name: who, ...x })).json(); };
  const wk = async (e) => (await call('GET', null, { path: `/week?date=${e}` })).json(), rows = (w) => w.top.map((x) => [x.name, x.pts]);
  const total = (e) => store.get(`wk:${e}`).hist.reduce((a, c) => a + c, 0), dkOf = async (who) => `dk:${D}:${await sha256hex(fk(who))}`;
  const ours = (k) => /^(wk|day):2026-10-[12]\d$|^dk:2026-10-18:/.test(k) || (k.startsWith('wn:') && Object.keys(store.get(k).d || {}).some((x) => x >= '2026-10-12' && x <= '2026-10-24'));
  const kept = new Map([...store].filter(([k]) => ours(k)));        // (the tests above post on today, whatever it is: theirs set aside, back after)
  for (const k of kept.keys()) store.delete(k);
  // as stored before the fix: every Oct 18 result counted in the weeks (posted here as g: 2, then the old-way ones'
  // device records and the fair list made as they were: no g, not on it)
  await post('2026-10-15', 'Earl', 0.7);
  await post('2026-10-16', 'Fran', 0.4);
  await post('2026-10-17', 'Olga', 0.6);
  const old = ['Olga', 'Otto', 'Duo', ...Array.from({ length: 100 }, (_, i) => `Hi ${i}`)];
  for (const [who, p] of [['Olga', 1], ['Otto', 0.99], ['Duo', 0.9], ...old.slice(3).map((x) => [x, 0.96]), ['Fran', 0.55], ['Fern', 0.3]]) await post(D, who, p, { g: 2 });
  await post(D, 'Rex', 0.99, { g: 2, restarted: true });
  await post(D, 'Anon', 0.97, { name: undefined });
  for (const who of old) { const k = await dkOf(who), x = store.get(k); delete x.g; store.set(k, x); }
  const dd = store.get(`day:${D}`);
  dd.f.top = [{ name: 'Fran', p: 0.55, kh: await sha256hex(fk('Fran')) }];         // (Fern: a fair result past the fair list's 25)
  store.set(`day:${D}`, dd);
  store.set(`dk:${D}:${'d'.repeat(64)}`, { p: 0.4, spots: [0], g: 2, name: 'Duo' });     // (Duo's other phone, signed in: fair, but not the one listed)
  let g = await wk(D);
  assert.deepStrictEqual([g.n, g.top[0].name, g.top[0].pts, store.get(`wk:${D}`).top.some((x) => x.name === 'Fran')], [106, 'Olga', 160, false], 'the inflated week, as it was kept');
  const before17 = store.get('wk:2026-10-17');
  // the board's first start since: once, the old-way points out of the names' records and the 7 weeks made again
  store.delete(`fairweek:${D}`);
  board = new Board({ storage }, board.env);
  g = await wk(D);
  assert.deepStrictEqual([rows(g), g.n, g.old], [[['Fran', 95], ['Earl', 70], ['Olga', 60], ['Fern', 30]], 4, undefined], 'old-way points out; fair ones in, back from past the 100 kept');
  assert.ok(store.get(`fairweek:${D}`), 'done once');
  assert.deepStrictEqual(ends.map(total), ends.map((e) => store.get(`wk:${e}`).n), 'each week\'s histogram adds up to its count');
  assert.deepStrictEqual([rows(await wk('2026-10-22')), rows(await wk('2026-10-24'))], [[['Fran', 95], ['Olga', 60], ['Fern', 30]], [['Fran', 55], ['Fern', 30]]], 'all 7 weeks');
  assert.ok(ends.every((e) => !store.get(`wk:${e}`).top.some((x) => (old.includes(x.name) && x.name !== 'Olga') || x.name === 'Rex')), 'no old-way name in any');
  assert.deepStrictEqual(store.get('wk:2026-10-17'), before17, 'a week without the day: as it was');
  assert.deepStrictEqual(['olga', 'otto', 'duo', 'hi 7', 'fran', 'fern'].map((n) => store.get(`wn:${n}`).d[D]), [null, null, null, null, 55, 30], 'the names\' own records');
  assert.strictEqual(store.get('wn:olga').d['2026-10-17'], 60, 'their other days kept');
  let w = await (await call('GET', null, { path: `/daily?date=${D}` })).json();
  assert.ok(w.top.some((x) => x.name === 'Olga') && w.fair.top.some((x) => x.name === 'Fran') && !w.fair.top.some((x) => x.name === 'Olga'), 'the day\'s lists as they were');
  // a name's own week line (the end card's This week): its points without the old way, and the day it left out
  w = await post(D, 'Olga', 0.2);
  assert.deepStrictEqual([w.counted, w.week.you, w.week.old], [false, { pts: 60, days: 1, rank: 3 }, [D]], 'Olga: her Oct 17 only');
  w = await post(D, 'Otto', 0.2);
  assert.deepStrictEqual([w.week.you, w.week.old], [undefined, [D]], 'Otto: nothing in the week');
  w = await post(D, 'Duo', 0.2);
  assert.deepStrictEqual([w.week.you, w.week.old], [undefined, [D]], 'Duo: the result listed was the old way');
  w = await post(D, 'Fran', 0.2, { g: 2 });
  assert.deepStrictEqual([w.week.you, w.week.old], [{ pts: 95, days: 2, rank: 1 }, undefined], 'Fran: hers counts');
  // once only, and the same again if it ran twice
  const snap = ends.map((e) => store.get(`wk:${e}`));
  store.delete(`fairweek:${D}`);
  board = new Board({ storage }, board.env);
  await wk(D);
  assert.deepStrictEqual(ends.map((e) => store.get(`wk:${e}`)), snap, 'run again: the same');
  // from now on: an old-way post of the day on its whole list, in no week, and a fair one later never replaces it
  w = await post(D, 'Nova', 0.98);
  assert.deepStrictEqual([w.counted, w.top.some((x) => x.name === 'Nova'), w.week.you, w.week.old, w.week.n], [true, true, undefined, [D], 4], 'a fresh old-way post: listed, not in the week');
  assert.ok(ends.every((e) => !store.get(`wk:${e}`).top.some((x) => x.name === 'Nova')) && store.get('wn:nova').d[D] === null, 'in none of its weeks');
  w = await post(D, 'Nova', 0.99, { g: 2 });
  assert.deepStrictEqual([w.counted, w.you.g, w.week.you, w.week.n], [false, undefined, undefined, 4], 'nor later, fair or not');
  await post(D, 'Neil', 0.5, { name: undefined });
  w = await post(D, 'Neil', 0.5);
  assert.deepStrictEqual([w.counted, w.week.you, w.week.old, store.get('wn:neil').d[D]], [false, undefined, [D], null], 'named afterwards: the same');
  w = await post(D, 'Gina', 0.8, { g: 2 });
  assert.deepStrictEqual([w.week.you, w.week.old, w.week.n, w.fair.top.some((x) => x.name === 'Gina')], [{ pts: 80, days: 1, rank: 2 }, undefined, 5, true], 'a fair post of the day counts');
  assert.deepStrictEqual(rows(await wk('2026-10-24')), [['Gina', 80], ['Fran', 55], ['Fern', 30]], 'in all its weeks');
  w = await post(D, 'Rhea', 0.99, { g: 2, restarted: true });
  assert.deepStrictEqual([w.counted, w.you.restarted, w.week.you, w.week.old, w.week.n], [true, true, undefined, undefined, 5], 'restarted: still out');
  // every other day as ever: the old way before the day, and after it
  w = await post('2026-10-17', 'Olive', 0.5);
  assert.deepStrictEqual([w.week.you, w.week.old], [{ pts: 50, days: 1, rank: 3 }, undefined], 'Oct 17: counted');
  assert.ok((await wk(D)).top.some((x) => x.name === 'Olive' && x.pts === 50));
  w = await post('2026-10-19', 'Nova', 0.7);
  assert.deepStrictEqual([w.counted, w.week.you, w.week.old, w.week.n], [true, { pts: 70, days: 1, rank: 3 }, [D], 7], 'Oct 19: counted, Oct 18 still out');
  // the commissioner's DELETE /week as ever
  r = await call('DELETE', null, { path: '/week?name=olga', auth: `Bearer ${env.ADMIN_TOKEN}` });
  assert.deepStrictEqual([r.status, (await r.json()).removed > 0], [200, true]);
  g = await wk(D);
  assert.deepStrictEqual([g.n, g.top.some((x) => x.name === 'Olga'), (await wk('2026-10-17')).top.some((x) => x.name === 'Olga')], [5, false, false], 'off the weeks');
  assert.ok(!store.get(`day:${D}`).top.some((x) => x.name === 'Olga'), 'and off the day\'s whole list');
  r = await call('DELETE', null, { path: '/week?name=nova', auth: `Bearer ${env.ADMIN_TOKEN}` });
  assert.strictEqual(r.status, 200);
  g = await wk('2026-10-19');
  assert.deepStrictEqual([g.n, g.top.some((x) => x.name === 'Nova'), store.get(`day:${D}`).top.some((x) => x.name === 'Nova')], [5, false, false], 'Nova: off the week she counted in and the day she didn\'t');
  assert.deepStrictEqual(['2026-10-17', ...ends].map(total), ['2026-10-17', ...ends].map((e) => store.get(`wk:${e}`).n), 'the counts still add up');
  for (const k of [...store.keys()]) if (ours(k)) store.delete(k);
  for (const [k, v] of kept) store.set(k, v);
  Date.now = realNow;
}
// Accounts, continued: stats that follow the account, usernames on the boards, friend leagues, the daily email
{
  const realFetch = globalThis.fetch;
  const envs = [env, board.env];
  const set = (o) => { for (const e of envs) Object.assign(e, o); };
  const unset = (...ks) => { for (const e of envs) for (const k of ks) delete e[k]; };
  const au = (path, body, o = {}) => call(body === undefined ? 'GET' : 'POST', body, { path, ...o });
  set({ GOOGLE_CLIENT_ID: '1234-test.apps.googleusercontent.com' });
  // signed in as if by Google: a session row made here (its hash, as the worker keeps it)
  const signIn = async (acct, email, name) => {
    const tok = (await sha256hex(`tok:${acct}`)).slice(0, 64);
    store.set(`auth:sess:${await sha256hex(tok)}`, { acct, at: Date.now() });
    store.set(`acct:${acct}`, { email, at: '2026-10-16', ...(name ? { name } : {}) });
    if (name) store.set(`auth:name:${name.toLowerCase()}`, acct);
    return tok;
  };
  const sa = await signIn('g:700001', 'amy@example.com', 'Amy Hawk'), sb = await signIn('g:700002', 'ben@example.com', 'Ben Bolt'), sc = await signIn('g:700003', 'cal@example.com');
  const ok = async (r, what) => { const d = await r.json(); assert.strictEqual(r.status, 200, `${what}: ${JSON.stringify(d).slice(0, 200)}`); return d; };

  // stats: merged into the account, the best of each kept, cleaned; a read without stats; never another account's
  assert.strictEqual((await au('/auth/stats', { session: 'f'.repeat(64), stats: {} })).status, 401, 'signed out');
  assert.deepStrictEqual(await ok(await au('/auth/stats', { session: sa }), 'read'), { stats: { days: {}, drives: {}, runs: {}, badges: {}, frozen: {}, scen: {}, surv: { best: 0, runs: 0 } } }, 'nothing yet');
  for (const [why, stats] of [['an array', []], ['days an array', { days: [1, 2] }], ['a string', 'x'], ['too many days', { days: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [i + 1, { p: 0.5 }])) }],
    ['too many drives', { drives: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i + 1, { p: 0.5 }])) }]]) {
    assert.strictEqual((await au('/auth/stats', { session: sa, stats })).status, 400, why);
  }
  assert.strictEqual((await au('/auth/stats', { session: sa, stats: { days: { 1: { p: 0.5, coach: 'x'.repeat(600 * 1024) } } } })).status, 413, 'a body over 512 KB');
  let d = await ok(await au('/auth/stats', { session: sa, stats: {
    days: { 5: { p: 0.5, wpa: 0.1, coach: 'Andy Reid', junk: 'x' }, 6: { p: 0.8, wpa: 0.2, coach: null }, 7: { p: 2 }, 8: { p: '0.5' }, abc: { p: 0.5 }, 0: { p: 0.5 }, '-3': { p: 0.5 }, 9: { p: NaN } },
    drives: { 3: { p: 0.7, wpa: 0.05, tries: 2, won: false, at: 1790000000000, last: 0.6, prev: { p: 0.4, tries: 1 } }, 1000: { p: 0.5 } },
    runs: { 2: { p: 0.66, wpa: 0.3, w: 3, l: 1, n: 4, x: 'y' } } } }), 'first phone');
  assert.deepStrictEqual(d.stats, { days: { 5: { p: 0.5, wpa: 0.1, coach: 'Andy Reid' }, 6: { p: 0.8, wpa: 0.2, coach: null } },
    drives: { 3: { p: 0.7, wpa: 0.05, tries: 2, won: false, last: 0.6, at: 1790000000000 } }, runs: { 2: { p: 0.66, wpa: 0.3, w: 3, l: 1, n: 4 } }, badges: {}, frozen: {}, scen: {}, surv: { best: 0, runs: 0 } }, 'cleaned: junk entries and fields dropped');
  d = await ok(await au('/auth/stats', { session: sa, stats: { days: { 5: { p: 0.4, wpa: 0.9, coach: 'Other' }, 6: { p: 0.9, wpa: 0.3, coach: 'Sean McVay', madden: 'zz' }, 10: { p: 0.3, wpa: 0, coach: 'John Madden', madden: 'ABCD1234' } },
    drives: { 3: { p: 0.6, wpa: 0, tries: 5, won: true }, 4: { p: 0.95, wpa: 0.2, tries: 1, won: true } }, runs: { 2: { p: 0.5, wpa: 0, w: 1, l: 3, n: 4 } } } }), 'second phone');
  assert.deepStrictEqual(d.stats.days, { 5: { p: 0.5, wpa: 0.1, coach: 'Andy Reid' }, 6: { p: 0.9, wpa: 0.3, coach: 'Sean McVay' }, 10: { p: 0.3, wpa: 0, coach: null } }, 'days: the higher score of each, the retired find dropped');
  assert.deepStrictEqual(d.stats.drives, { 3: { p: 0.7, wpa: 0.05, tries: 5, won: true, last: 0.6, at: 1790000000000 }, 4: { p: 0.95, wpa: 0.2, tries: 1, won: true } }, 'drives: best score, most tries, won if either');
  assert.strictEqual(d.stats.runs[2].p, 0.66, 'runs: the best');
  d = await ok(await au('/auth/stats', { session: sa, stats: { days: { 10: { p: 0.6, wpa: 0, coach: 'Bill Belichick' } } } }), 'a better score on that day');
  assert.deepStrictEqual(d.stats.days[10], { p: 0.6, wpa: 0, coach: 'Bill Belichick' }, 'the better score stands');
  assert.deepStrictEqual((await ok(await au('/auth/stats', { session: sb }), 'other')).stats, { days: {}, drives: {}, runs: {}, badges: {}, frozen: {}, scen: {}, surv: { best: 0, runs: 0 } }, 'never another account\'s');
  // the newest 2000 days stand when a merge goes over
  store.set('stats:d:g:700003', Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i + 1, { p: 0.5, wpa: 0, coach: null }])));
  d = await ok(await au('/auth/stats', { session: sc, stats: { days: { 2001: { p: 0.7 } } } }), 'over the cap');
  assert.deepStrictEqual([Object.keys(d.stats.days).length, d.stats.days[1], d.stats.days[2001].p], [2000, undefined, 0.7], 'the oldest day goes');
  store.delete('stats:d:g:700003');
  // badges ({ id: when earned }) and the days a streak freeze covered ({ day: when }): checked, a union, the earliest
  // time of each kept; a post without them (an older page) takes nothing away; the day's vs (the real coach) kept
  for (const [why, stats] of [['badges an array', { badges: ['first'] }], ['frozen a string', { frozen: '7' }],
    ['too many badges', { badges: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`b${i}`, 1.79e12])) }],
    ['too many frozen days', { frozen: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i + 1, 1.79e12])) }]]) {
    assert.strictEqual((await au('/auth/stats', { session: sc, stats })).status, 400, why);
  }
  d = await ok(await au('/auth/stats', { session: sc, stats: { days: { 3: { p: 0.5, vs: 1 }, 4: { p: 0.5, vs: 5 }, 5: { p: 0.5, vs: -0.4 }, 11: { p: 0.5, side: 'LA' }, 12: { p: 0.5, side: 'la' } },
    badges: { first: 1790000002000, coach: 1790000001500, 'Bad-Id': 1, '1st': 1, ['x'.repeat(17)]: 1, win: 'soon', day90: -5, madden: 1790000001000 },
    frozen: { 7: 1790000000100, 0: 1, abc: 1, 100000: 1, 8: null } } }), 'badges and frozen days');
  assert.deepStrictEqual([d.stats.days[3].vs, 'vs' in d.stats.days[4], d.stats.days[5].vs], [1, false, -1], 'vs: better, the same or worse; anything else dropped');
  assert.deepStrictEqual([d.stats.days[11].side, 'side' in d.stats.days[12]], ['LA', false], 'side: a team code (a day of two sides), anything else dropped');
  assert.deepStrictEqual([d.stats.badges, d.stats.frozen], [{ coach: 1790000001500, first: 1790000002000 }, { 7: 1790000000100 }], 'cleaned');
  assert.deepStrictEqual(store.get('stats:m:g:700003'), { badges: d.stats.badges, frozen: d.stats.frozen }, 'kept on their own key');
  // kept from before the rare-coach find was retired: read back without its badge or its coach
  store.set('stats:m:g:700003', { badges: { ...d.stats.badges, madden: 1790000000500 }, frozen: d.stats.frozen });
  store.set('stats:d:g:700003', { ...store.get('stats:d:g:700003'), 9: { p: 0.4, wpa: 0, coach: 'John Madden', madden: 'ABCD1234' } });
  const old = (await ok(await au('/auth/stats', { session: sc }), 'an old record')).stats;
  assert.deepStrictEqual([old.badges, old.days[9]], [{ coach: 1790000001500, first: 1790000002000 }, { p: 0.4, wpa: 0, coach: null }], 'the retired find gone');
  d = await ok(await au('/auth/stats', { session: sc, stats: { badges: { first: 1790000001000, win: 1790000003000, coach: 1790000009000 }, frozen: { 7: 1790000000050, 9: 1790000000200 } } }), 'the other phone');
  assert.deepStrictEqual([d.stats.badges, d.stats.frozen], [{ first: 1790000001000, coach: 1790000001500, win: 1790000003000 }, { 7: 1790000000050, 9: 1790000000200 }], 'a union, the earliest of each');
  d = await ok(await au('/auth/stats', { session: sc, stats: { days: { 3: { p: 0.6 } } } }), 'an older page');
  assert.deepStrictEqual([Object.keys(d.stats.badges).length, Object.keys(d.stats.frozen).length], [3, 2], 'a post without them takes nothing away');
  assert.deepStrictEqual((await ok(await au('/auth/stats', { session: sc }), 'read')).stats.badges, d.stats.badges, 'and a read has them');
  store.set('stats:m:g:700003', { badges: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`b${i}`, 1790000000000 + i])), frozen: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [i + 1, 1])) });
  d = await ok(await au('/auth/stats', { session: sc, stats: { badges: { zz: 1 }, frozen: { 501: 2 } } }), 'over the caps');
  assert.deepStrictEqual([Object.keys(d.stats.badges).length, d.stats.badges.zz, 'b63' in d.stats.badges, Object.keys(d.stats.frozen).length, d.stats.frozen[1], d.stats.frozen[501]],
    [64, 1, false, 500, undefined, 2], 'over a cap: the earliest badges, the newest frozen days');
  store.delete('stats:m:g:700003'); store.delete('stats:d:g:700003');
  // My scenarios (web/scenario.js codes): checked; the newest touch of each stands, with the best score, the most tries
  // and won if either; a removal (gone) follows to the other phone until the scenario is played again
  const S1 = '1-NE-2007-KC-2023-SB-n-4-120-17-21-y-s-75-1-10-2-3-0-o-y-g', S2 = '1-LA-2026-SEA-2026-REG-h-4-57-11-14-y-s-54-1-10-1-3-0-o-y-g';
  const S3 = `${S2}-yq1k3d9-yw20b2z-ok1aa00`;        // (lineup picks: your quarterback and second receiver, their kicker)
  assert.strictEqual((await au('/auth/stats', { session: sc, stats: { scen: [S1] } })).status, 400, 'scen an array');
  assert.strictEqual((await au('/auth/stats', { session: sc, stats: { scen: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${S1.slice(0, -1)}${i}`, { at: 1 }])) } })).status, 400, 'too many scenarios');
  d = await ok(await au('/auth/stats', { session: sc, stats: { scen: { [S1]: { at: 1790000000000, p: 0.42, tries: 2, won: false, title: 'x' }, [S2]: { at: 1790000001000, tries: 0 },
    'not-a-code': { at: 1 }, [S1.replace('NE', 'N!')]: { at: 1 }, [`${S2}-x`]: { at: 1 }, '1-NE-2007': { at: 1 }, [`${S2}-yq1k3d`]: { at: 1 }, [`${S2}-zq1k3d9`]: { at: 1 },
    [S3]: { at: 1789999999000, tries: 1 } } } }), 'scenarios');
  assert.deepStrictEqual(d.stats.scen, { [S2]: { at: 1790000001000, tries: 0, won: false }, [S1]: { at: 1790000000000, p: 0.42, tries: 2, won: false, title: 'x' },
    [S3]: { at: 1789999999000, tries: 1, won: false } }, 'scen cleaned (its title kept, a lineup\'s code kept, a broken one not), newest first');
  d.stats.scen = Object.fromEntries(Object.entries(d.stats.scen).filter(([k]) => k !== S3));
  store.set('stats:s:g:700003', d.stats.scen);
  d = await ok(await au('/auth/stats', { session: sc, stats: { scen: { [S1]: { at: 1790000005000, p: 0.3, tries: 3, won: true }, [S2]: { at: 1790000002000, tries: 0, gone: true } } } }), 'the other phone\'s scenarios');
  assert.deepStrictEqual(d.stats.scen, { [S1]: { at: 1790000005000, p: 0.42, tries: 3, won: true }, [S2]: { at: 1790000002000, tries: 0, won: false, gone: true } }, 'the best, the most tries, won if either; a removal follows');
  d = await ok(await au('/auth/stats', { session: sc, stats: { scen: { [S2]: { at: 1790000009000, p: 0.9, tries: 1, won: true } } } }), 'played again');
  assert.deepStrictEqual(d.stats.scen[S2], { at: 1790000009000, p: 0.9, tries: 1, won: true }, 'played again: back on the list');
  assert.deepStrictEqual(store.get('stats:s:g:700003'), d.stats.scen, 'kept on its own key');
  store.delete('stats:s:g:700003');
  // survivor's best run follows the account (a player lost it on every other phone before): checked and rebuilt from
  // its numbers; a high-water mark, the higher best and count stand, never lower; the extra-life mark goes with the
  // best; a post without it (an older page) takes nothing away; never another account's
  for (const [why, stats] of [['surv an array', { surv: [3] }], ['surv a string', { surv: '3' }], ['surv null', { surv: null }]]) {
    assert.strictEqual((await au('/auth/stats', { session: sc, stats })).status, 400, why);
  }
  d = await ok(await au('/auth/stats', { session: sc, stats: { surv: { best: 4, runs: 2, life: true, junk: 'x' } } }), 'the first phone\'s best run');
  assert.deepStrictEqual(d.stats.surv, { best: 4, runs: 2, life: true }, 'kept from its numbers');
  assert.deepStrictEqual(store.get('stats:m:g:700003'), { badges: {}, frozen: {}, surv: { best: 4, runs: 2, life: true } }, 'kept beside the badges');
  d = await ok(await au('/auth/stats', { session: sc, stats: { surv: { best: 2, runs: 1 } } }), 'a phone with less');
  assert.deepStrictEqual(d.stats.surv, { best: 4, runs: 2, life: true }, 'never down');
  d = await ok(await au('/auth/stats', { session: sc, stats: { days: { 3: { p: 0.6 } } } }), 'an older page');
  assert.deepStrictEqual(d.stats.surv, { best: 4, runs: 2, life: true }, 'a post without it takes nothing away');
  assert.deepStrictEqual((await ok(await au('/auth/stats', { session: sc }), 'read')).stats.surv, { best: 4, runs: 2, life: true }, 'and a read has it');
  d = await ok(await au('/auth/stats', { session: sc, stats: { surv: { best: 4, runs: 3 } } }), 'the same best, without the extra life');
  assert.deepStrictEqual(d.stats.surv, { best: 4, runs: 3 }, 'the mark stays only when both used it; the higher count');
  d = await ok(await au('/auth/stats', { session: sc, stats: { surv: { best: 7, runs: 1, life: true } } }), 'a better run');
  assert.deepStrictEqual(d.stats.surv, { best: 7, runs: 3, life: true }, 'the mark follows the best');
  d = await ok(await au('/auth/stats', { session: sc, stats: { surv: { best: 1e9, runs: -4, life: 'yes' } } }), 'nonsense numbers');
  assert.deepStrictEqual(d.stats.surv, { best: 7, runs: 3, life: true }, 'read as nothing: nothing taken away');
  assert.deepStrictEqual((await ok(await au('/auth/stats', { session: sb }), 'other')).stats.surv, { best: 0, runs: 0 }, 'never another account\'s');
  store.delete('stats:m:g:700003'); store.delete('stats:d:g:700003');

  // a username on the boards: the account's own name from any phone (the survivor board and the day's list); anyone
  // else, or the account under another name, as before
  const kA = 'amy-phone-key-0000000001', kB = 'amy-other-phone-key-0002', kX = 'stranger-key-000000000003';
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 4, key: kA, session: sa })).status, 200, 'first phone');
  assert.strictEqual((await call('POST', { name: 'amy hawk', best: 6, key: kB, session: sa })).status, 200, 'a new phone, signed in: her name');
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 9, key: kX })).status, 409, 'a stranger: taken');
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 9, key: kX, session: sb })).status, 409, 'another account: taken');
  assert.ok((await (await call('GET')).json()).rows.some((x) => x.name.toLowerCase() === 'amy hawk' && x.best === 6), 'her best, from either phone');
  // a username is checked against other accounts' only: picking a name another phone plays under never takes it (its
  // owner locked out of his own name, his survivor row the account's); the phone that holds it hands it over
  store.set('claim:ben bolt', 'f'.repeat(64));                         // someone else's phone plays as "Ben Bolt"
  assert.strictEqual((await call('POST', { name: 'Ben Bolt', best: 2, key: kX, session: sb })).status, 409, 'another phone\'s name: taken, username or not');
  assert.strictEqual(store.get('claim:ben bolt'), 'f'.repeat(64), 'and still his');
  b = await (await day({ date: today, key: kX, p: 0.5, spots: [0], name: 'Ben Bolt', session: sb })).json();
  assert.ok(b.taken && !b.top.some((x) => x.name === 'Ben Bolt'), 'nor on the day\'s list');
  const kBen = 'ben-own-phone-key-00000001';
  store.set('claim:ben bolt', await sha256hex(kBen));                  // his own phone played as "Ben Bolt" before he signed in
  assert.strictEqual((await call('POST', { name: 'Ben Bolt', best: 2, key: kBen, session: sb })).status, 200, 'that phone, signed in: the name goes to the account');
  assert.strictEqual((await call('POST', { name: 'Ben Bolt', best: 3, key: kX, session: sb })).status, 200, 'then his on any phone');
  r = await call('POST', { name: 'Not Amy', best: 1, key: kB, session: sa });
  assert.strictEqual(r.status, 200, 'another name: claimed by the device, as ever');
  assert.strictEqual(store.get('claim:not amy'), await sha256hex(kB));
  b = await (await day({ date: today, key: kB, p: 0.77, spots: [0.1], name: 'Amy Hawk', session: sa, g: 2 })).json();    // (g: 2: in the week on any day, OLD_WAY_DAYS too)
  assert.ok(!b.taken && b.top.some((x) => x.name === 'Amy Hawk'), 'the day\'s list: her name from the new phone');
  b = await (await day({ date: today, key: 'stranger-key-000000000004', p: 0.9, spots: [0.1], name: 'Amy Hawk' })).json();
  assert.strictEqual(b.taken, true, 'and nobody else\'s');
  b = await (await day({ date: today, key: kA, p: 0.95, spots: [0.1], name: 'Amy Hawk', session: sa, g: 2 })).json();
  assert.strictEqual(b.counted, true, 'her other phone\'s result counts in the day');
  assert.deepStrictEqual([b.top.filter((x) => x.name === 'Amy Hawk').map((x) => x.p), b.week.you.pts], [[0.77], 77], 'listed once a day: her first result');

  // leagues: made and joined with a username, a board of usernames and daily numbers only, limits, leaving
  const lg = (path, body) => au(`/league/${path}`, body);
  assert.strictEqual((await lg('create', { session: 'f'.repeat(64), name: 'Sunday Crew' })).status, 401, 'signed out');
  r = await lg('create', { session: sc, name: 'Sunday Crew' });
  assert.deepStrictEqual([r.status, (await r.json()).noName], [409, true], 'a username first');
  for (const bad of ['', 'ab', 'x'.repeat(31), '   a  ']) assert.strictEqual((await lg('create', { session: sa, name: bad })).status, 400, `league name ${JSON.stringify(bad)}`);
  r = await lg('create', { session: sa, name: 'Sh1t Show' });
  assert.deepStrictEqual([r.status, (await r.json()).refused], [409, true], 'no slurs or obscenities');
  d = await ok(await lg('create', { session: sa, name: '  Sunday   Crew ' }), 'create');
  const code = d.league.code;
  assert.match(code, /^[A-HJ-KMNP-Z2-9]{8}$/, code);
  assert.deepStrictEqual([d.league.name, d.league.n, d.league.owner, d.leagues], ['Sunday Crew', 1, true, [{ code, name: 'Sunday Crew', n: 1 }]]);
  assert.deepStrictEqual((await ok(await au('/auth/me', { session: sa }), 'me')).leagues, [{ code, name: 'Sunday Crew', n: 1 }], 'the account lists it');
  assert.deepStrictEqual(await ok(await lg('peek', { code: code.toLowerCase() }), 'peek'), { code, name: 'Sunday Crew', n: 1 }, 'what a join link shows (any case)');
  assert.strictEqual((await lg('peek', { code: 'AAAAAAAA' })).status, 404);
  assert.strictEqual((await lg('peek', { code: 'nope' })).status, 400);
  assert.strictEqual((await lg('board', { session: sb, code, day: 10 })).status, 404, 'not a member: no board');
  assert.strictEqual((await lg('join', { session: sb, code: 'AAAAAAAA' })).status, 404, 'no such league');
  d = await ok(await lg('join', { session: sb, code }), 'join');
  assert.deepStrictEqual([d.league.n, d.league.owner], [2, false]);
  assert.strictEqual((await ok(await lg('join', { session: sb, code }), 'again')).league.n, 2, 'joining again: the same');
  // Ben's days 4-10 (all but 7), Amy's from her stats above (5, 6, 10)
  await ok(await au('/auth/stats', { session: sb, stats: { days: Object.fromEntries([4, 5, 6, 8, 9, 10].map((k) => [k, { p: k / 20, wpa: 0, coach: null }])) } }), 'ben');
  assert.strictEqual((await lg('board', { session: sa, code })).status, 400, 'a day wanted');
  d = await ok(await lg('board', { session: sa, code, day: 10 }), 'board');
  assert.deepStrictEqual([d.name, d.n, d.day, d.owner], ['Sunday Crew', 2, 10, true]);
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  assert.deepStrictEqual(d.rows.map((x) => [x.name, x.today, x.streak, x.n7, !!x.you]), [['Amy Hawk', 0.6, 1, 3, true], ['Ben Bolt', 0.5, 3, 6, false]], 'sorted by the day\'s score');
  assert.ok(near(d.rows[0].avg7, (0.5 + 0.9 + 0.6) / 3) && near(d.rows[1].avg7, (0.2 + 0.25 + 0.3 + 0.4 + 0.45 + 0.5) / 6), 'the last 7 days\' average');
  const txt = JSON.stringify(d);
  assert.ok(!/@|g:7000/.test(txt), 'no addresses or account ids on a league board');
  d = await ok(await lg('board', { session: sb, code, day: 11 }), 'the next day');
  assert.deepStrictEqual(d.rows.map((x) => [x.name, x.today, x.streak]), [['Ben Bolt', null, 3], ['Amy Hawk', null, 1]], 'not played yet: a streak still alive, longest first');
  // a day a streak freeze covered counts in the streak (Ben missed day 7); a frozen day with nothing played after it never starts one
  await ok(await au('/auth/stats', { session: sb, stats: { frozen: { 7: 1790000000000 } } }), 'ben\'s freeze');
  await ok(await au('/auth/stats', { session: sa, stats: { frozen: { 11: 1790000000000 } } }), 'amy\'s (not yet earned out)');
  d = await ok(await lg('board', { session: sa, code, day: 11 }), 'with freezes');
  assert.deepStrictEqual(d.rows.map((x) => [x.name, x.streak]), [['Ben Bolt', 7], ['Amy Hawk', 1]], 'the freeze keeps Ben\'s streak');
  store.delete('stats:m:g:700001'); store.delete('stats:m:g:700002');
  // a freeze held and not spent yet (game.js streakOf's pending): Ben's 7 days in a row (1-7) earned one; day 8 missed
  // and day 9 not played yet, his streak is alive on his page and the board alike; two missed days are one too many
  const benDays = store.get('stats:d:g:700002');
  store.set('stats:d:g:700002', Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((k) => [k, { p: 0.5, wpa: 0, coach: null }])));
  d = await ok(await lg('board', { session: sa, code, day: 9 }), 'a pending freeze');
  assert.strictEqual(d.rows.find((x) => x.name === 'Ben Bolt').streak, 8, 'the freeze held covers day 8');
  d = await ok(await lg('board', { session: sa, code, day: 10 }), 'two missed');
  assert.strictEqual(d.rows.find((x) => x.name === 'Ben Bolt').streak, 0, 'one freeze, two days missed: over');
  store.set('stats:d:g:700002', benDays);
  // limits: 10 leagues an account, 50 members a league
  for (let i = 0; i < 9; i++) await ok(await lg('create', { session: sa, name: `League ${i}` }), `league ${i}`);
  r = await lg('create', { session: sa, name: 'One Too Many' });
  assert.strictEqual(r.status, 409, '10 leagues an account');
  const full = store.get(`league:${code}`);
  store.set(`league:${code}`, { ...full, members: [...full.members, ...Array.from({ length: 48 }, (_, i) => `g:fill${i}`)] });
  await signIn('g:700004', 'dee@example.com', 'Dee Dash');
  const sd = (await sha256hex('tok:g:700004')).slice(0, 64);
  r = await lg('join', { session: sd, code });
  assert.deepStrictEqual([r.status, (await r.json()).full], [409, true], '50 a league');
  d = await ok(await lg('board', { session: sa, code, day: 10 }), 'a full board');
  assert.strictEqual(d.rows.length, 50);
  assert.ok(d.rows.filter((x) => x.name === 'Player').length === 48 && !JSON.stringify(d).includes('fill'), 'a member without a row: "Player", never an id');
  store.set(`league:${code}`, full);
  assert.strictEqual((await lg('join', { session: sa, code })).status, 200, 'in it already: no limit in the way');
  // leaving: the owner's place passes on; the last one out ends it
  d = await ok(await lg('leave', { session: sa, code }), 'leave');
  assert.ok(!d.leagues.some((x) => x.code === code), 'off her list');
  assert.deepStrictEqual([store.get(`league:${code}`).owner, store.get(`league:${code}`).members], ['g:700002', ['g:700002']], 'Ben owns it now');
  assert.strictEqual((await lg('board', { session: sa, code, day: 10 })).status, 404, 'no board after leaving');
  await ok(await lg('leave', { session: sb, code }), 'the last one');
  assert.ok(!store.has(`league:${code}`), 'gone');
  assert.strictEqual((await lg('join', { session: sb, code })).status, 404);
  assert.ok((await ok(await lg('create', { session: sa, name: 'Room Again' }), 'room again')).league, 'a place free again');

  // Community scenarios: posted under a title by an account with a username, a list anyone reads (most played, hot,
  // new), plays, finishes and wins counted once a day a device or account, the creator's delete, the admin's removal
  {
    const cs = (path, body, o) => au(`/scen/${path}`, body, o);
    const list = async (q = '') => (await call('GET', null, { path: `/scen/list${q}` })).json();
    const C1 = '1-NE-2007-KC-2023-SB-n-4-120-17-21-y-s-75-1-10-2-3-0-o-y-g', C2 = '1-LA-2026-SEA-2026-REG-h-4-57-11-14-y-s-54-1-10-1-3-0-o-y-g', C3 = '1-GB-2010-PIT-2010-SB-n-4-300-21-24-y-s-80-1-10-1-1-0-o-y-g';
    assert.deepStrictEqual(await list(), { sort: 'top', page: 0, rows: [], total: 0, next: null }, 'empty');
    assert.strictEqual((await cs('post', { session: 'f'.repeat(64), code: C1, title: 'Spygate revenge' })).status, 401, 'signed out');
    r = await cs('post', { session: sc, code: C1, title: 'Spygate revenge' });
    assert.deepStrictEqual([r.status, (await r.json()).noName], [409, true], 'a username first');
    for (const [code, title] of [['1-NE-2007', 'Good title'], [`${C1}-x`, 'Good title'], [C1, ''], [C1, 'ab'], [C1, 'x'.repeat(41)]]) {
      assert.strictEqual((await cs('post', { session: sa, code, title })).status, 400, `bad post ${code} ${title}`);
    }
    for (const title of ['sh1t show', 'F U C K the Pats', 'b!tch better have my 4th down']) {
      r = await cs('post', { session: sa, code: C1, title });
      assert.deepStrictEqual([r.status, (await r.json()).refused], [409, true], `title refused: ${title}`);
    }
    r = await cs('post', { session: sa, code: C1, title: '  Spygate   revenge  ' });
    assert.strictEqual(r.status, 200, 'posted');
    const p1 = (await r.json()).row;
    assert.deepStrictEqual([p1.code, p1.title, p1.name, p1.n, p1.f, p1.w, p1.best, p1.mine], [C1, 'Spygate revenge', 'Amy Hawk', 0, 0, 0, null, true]);
    assert.match(p1.id, /^[A-Z2-9]{8}$/);
    r = await cs('post', { session: sb, code: C1, title: 'Same one, another title' });
    d = await r.json();
    assert.deepStrictEqual([r.status, d.existing, d.row.id, d.row.title, d.row.mine], [200, true, p1.id, 'Spygate revenge', undefined], 'the same code: the post there is');
    const p2 = (await ok(await cs('post', { session: sb, code: C2, title: 'Rams rally' }), 'ben posts')).row;
    assert.strictEqual(p2.name, 'Ben Bolt');
    // the same situation with a lineup of its own (web/scenario.js: picks after the 22 parts) is a scenario of its own
    const C4 = `${C2}-yq1k3d9`, p4 = (await ok(await cs('post', { session: sa, code: C4, title: 'Rams rally, the backup' }), 'a lineup')).row;
    assert.deepStrictEqual([p4.code, p4.title, p4.id !== p2.id], [C4, 'Rams rally, the backup', true], 'posted under its own code');
    assert.strictEqual((await cs('post', { session: sa, code: `${C2}-yq1k3d`, title: 'Broken pick' })).status, 400, 'a broken pick');
    await ok(await cs('delete', { session: sa, id: p4.id }), 'taken down again');
    let L = await list();
    assert.deepStrictEqual([L.total, L.rows.map((x) => x.title)], [2, ['Rams rally', 'Spygate revenge']], 'no plays yet: the newest first');
    assert.ok(L.rows.every((x) => !('acct' in x) && !('mine' in x)), 'never the account');
    assert.ok(!/g:7000|@/.test(JSON.stringify(L)), 'no account ids or addresses on the list');
    d = await ok(await cs('list', { session: sa, sort: 'new' }), 'amy reads');
    assert.deepStrictEqual(d.rows.map((x) => [x.title, !!x.mine]), [['Rams rally', false], ['Spygate revenge', true]], 'her own marked');
    // plays: once a day a device (or an account), a finish and a win once a day too, the best score kept
    const kP = 'player-device-key-0000001', kQ = 'player-device-key-0000002';
    assert.strictEqual((await cs('play', { code: C1 })).status, 400, 'a key or a session');
    assert.strictEqual((await cs('play', { code: 'nope', key: kP })).status, 400, 'a code');
    assert.deepStrictEqual(await ok(await cs('play', { code: C3, key: kP }), 'not posted'), { counted: false }, 'a code not posted counts nothing');
    d = await ok(await cs('play', { code: C1, key: kP }), 'play');
    assert.deepStrictEqual([d.counted, d.row.n], [true, 1]);
    d = await ok(await cs('play', { code: C1, key: kP }), 'again');
    assert.deepStrictEqual([d.counted, d.row.n], [false, 1], 'the same device the same day: once');
    d = await ok(await cs('play', { code: C1, key: kP, done: true, won: false, p: 0.41 }), 'lost');
    assert.deepStrictEqual([d.row.n, d.row.f, d.row.w, d.row.best], [1, 1, 0, 0.41]);
    d = await ok(await cs('play', { code: C1, key: kP, done: true, won: true, p: 0.93 }), 'won');
    assert.deepStrictEqual([d.row.n, d.row.f, d.row.w, d.row.best], [1, 1, 1, 0.93], 'a win the same day counts once; the best score');
    d = await ok(await cs('play', { code: C1, key: kP, done: true, won: true, p: 0.5 }), 'won again');
    assert.deepStrictEqual([d.counted, d.row.w, d.row.best], [false, 1, 0.93], 'once');
    await ok(await cs('play', { code: C1, key: kQ, done: true, won: false, p: 2 }), 'a finish starts a play too; a score out of range is not kept');
    d = await ok(await cs('play', { code: C1, session: sb, key: kQ }), 'ben signed in');
    assert.deepStrictEqual([d.row.n, d.row.f, d.row.best], [3, 2, 0.93], 'signed in: the account counts, not the device');
    assert.strictEqual((await ok(await cs('play', { code: C1, session: sb, key: 'ben-new-phone-key-000001' }), 'ben elsewhere')).counted, false, 'the account once a day, any phone');
    await ok(await cs('play', { code: C2, key: kP }), 'rams');
    assert.ok([...store.keys()].filter((k) => k.startsWith('comm:pd:')).every((k) => !k.includes(kP) && !k.includes('g:7000')), 'only hashes kept');
    // the day after: the day before's marks cleared, the device counts again
    const realNow = Date.now;
    Date.now = () => realNow() + 864e5;
    const RD = globalThis.Date;
    globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [RD.now() + 864e5])); } static now() { return RD.now() + 864e5; } };
    d = await ok(await cs('play', { code: C1, key: kP }), 'tomorrow');
    assert.deepStrictEqual([d.counted, d.row.n], [true, 4], 'a new day: counted again');
    const tom = new Date().toISOString().slice(0, 10);
    assert.ok([...store.keys()].filter((k) => k.startsWith('comm:pd:')).every((k) => k.startsWith(`comm:pd:${tom}:`)), 'the day before\'s marks gone');
    globalThis.Date = RD; Date.now = realNow;
    L = await list();
    assert.deepStrictEqual(L.rows.map((x) => [x.title, x.n]), [['Spygate revenge', 4], ['Rams rally', 1]], 'most played first');
    assert.deepStrictEqual((await list('?sort=new')).rows.map((x) => x.title), ['Rams rally', 'Spygate revenge'], 'newest first');
    // hot: plays for their age (an old post with more plays below a new one with fewer)
    const cl = store.get('comm:list');
    cl.find((x) => x.id === p1.id).at -= 40 * 864e5;
    store.set('comm:list', cl);
    assert.deepStrictEqual((await list('?sort=hot')).rows.map((x) => x.title), ['Rams rally', 'Spygate revenge'], 'hot');
    assert.deepStrictEqual((await list('?sort=junk')).sort, 'top', 'an unknown sort: most played');
    // posting: COMM_POSTS a day an account (a post of a code there is costs nothing)
    for (let i = 0; i < 4; i++) assert.strictEqual((await cs('post', { session: sb, code: `1-LA-2026-SEA-2026-REG-h-4-${60 + i}-11-14-y-s-54-1-10-1-3-0-o-y-g`, title: `Rams rally ${i + 2}` })).status, 200, `post ${i}`);
    assert.strictEqual((await cs('post', { session: sb, code: C2, title: 'Rams rally' })).status, 200, 'his own again: the post there is');
    r = await cs('post', { session: sb, code: C3, title: 'Steel curtain' });
    assert.strictEqual(r.status, 429, 'six in a day');
    assert.match((await r.json()).error, /5 posts today/);
    L = await list();
    assert.deepStrictEqual([L.total, L.next], [6, null]);
    // pages of COMM_PAGE
    const many = Array.from({ length: 23 }, (_, i) => ({ id: `ZZZZZZ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`.slice(0, 8), c: `1-GB-2010-PIT-2010-SB-n-4-${100 + i}-21-24-y-s-80-1-10-1-1-0-o-y-g`, t: `Filler ${i}`, nm: 'Ben Bolt', at: 1, acct: 'g:700002' }));
    store.set('comm:list', [...store.get('comm:list'), ...many]);
    L = await list();
    assert.deepStrictEqual([L.total, L.rows.length, L.next], [29, 20, 1], 'a page');
    L = await list('?page=1');
    assert.deepStrictEqual([L.rows.length, L.next], [9, null], 'the last page');
    // a stored post with a blocked title or name is left out
    store.set('comm:list', [...store.get('comm:list'), { id: 'BADBADBA', c: C3, t: 'b!tch please', nm: 'Ben Bolt', at: 2, acct: 'g:700002' }]);
    assert.ok(!(await list('?sort=new&page=1')).rows.some((x) => x.id === 'BADBADBA') && (await list()).total === 29, 'not listed');
    store.set('comm:list', store.get('comm:list').filter((x) => x.id !== 'BADBADBA' && !x.id.startsWith('ZZZZZZ')));
    // full: a new post takes the least played one's place
    const full = store.get('comm:list'), base = full.length;
    store.set('comm:list', [...full, ...Array.from({ length: 300 - base }, (_, i) => ({ id: `FL${String(i).padStart(6, '0')}`, c: `1-GB-2010-PIT-2010-SB-n-4-${400 + i}-21-24-y-s-80-1-10-1-1-0-o-y-g`, t: `Filler ${i}`, nm: 'Ben Bolt', at: 10 + i, acct: 'g:700002' }))]);
    assert.ok(JSON.stringify(store.get('comm:list')).length < 100e3, 'a full list well inside a value');
    d = await ok(await cs('post', { session: sa, code: C3, title: 'Steel curtain' }), 'into a full list');
    L = store.get('comm:list');
    assert.deepStrictEqual([L.length, L.some((x) => x.t === 'Filler 0'), L.some((x) => x.t === 'Steel curtain'), L.some((x) => x.id === p1.id)], [300, false, true, true], 'the oldest unplayed went');
    store.set('comm:list', L.filter((x) => !x.t.startsWith('Filler')));
    // delete: the creator only; the admin token takes any off
    assert.strictEqual((await cs('delete', { session: sb, id: p1.id })).status, 404, 'not his');
    assert.deepStrictEqual(await ok(await cs('delete', { session: sa, id: p1.id }), 'hers'), { ok: true });
    assert.ok(!(await list()).rows.some((x) => x.id === p1.id) && !(p1.id in store.get('comm:n')), 'gone, counts too');
    assert.deepStrictEqual(await ok(await cs('play', { code: C1, key: kQ }), 'after'), { counted: false }, 'a play of it counts nothing now');
    assert.strictEqual((await call('DELETE', null, { path: `/scen?id=${p2.id}` })).status, 403, 'no token');
    d = await ok(await call('DELETE', null, { path: `/scen?id=${p2.id}`, auth: `Bearer ${env.ADMIN_TOKEN}` }), 'admin');
    assert.deepStrictEqual([d.removed, (await list()).rows.some((x) => x.id === p2.id)], [1, false], 'the admin took it off');
    assert.strictEqual((await call('GET', null, { path: '/scen/post' })).status, 405);
    store.delete('comm:list'); store.delete('comm:n');
  }

  // the daily email: opt-in (only with Resend set up), one a day by the cron, an unsubscribe link in each
  assert.strictEqual((await au('/auth/remind', { session: sa, on: true })).status, 503, 'no Resend: off');
  set({ RESEND_KEY: 're_test_key', MAIL_FROM: 'Two-Minute Drill <daily@nfl2mindrill.com>', SITE: 'https://nfl2mindrill.com' });
  assert.strictEqual((await au('/auth/remind', { session: 'f'.repeat(64), on: true })).status, 401);
  assert.strictEqual((await ok(await au('/auth/remind', { session: sa, on: true }), 'on')).remind, true, 'on');
  assert.strictEqual((await ok(await au('/auth/me', { session: sa }), 'me')).remind, true, 'kept');
  await ok(await au('/auth/remind', { session: sb, on: true }), 'ben on');
  await ok(await au('/auth/remind', { session: sb, on: false }), 'ben off');
  assert.strictEqual((await ok(await au('/auth/me', { session: sb }), 'me')).remind, undefined, 'off');
  const batches = [];
  let resendDown = false;
  globalThis.fetch = async (u, init) => {
    if (u === 'https://api.resend.com/emails/batch') {
      if (resendDown) return new Response('{"message":"down"}', { status: 500 });
      batches.push({ headers: init.headers, mails: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const cron = (iso) => worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil() {} });
  const errs = [], realErr = console.error, realLog = console.log;
  console.error = (...a) => errs.push(a.join(' ')); console.log = () => {};
  await cron('2026-10-17T08:05:00Z');
  assert.strictEqual(batches.length, 1);
  const [mail] = batches[0].mails;
  assert.deepStrictEqual([batches[0].mails.length, mail.to, mail.from], [1, ['amy@example.com'], 'Two-Minute Drill <daily@nfl2mindrill.com>'], 'only the account that asked');
  assert.strictEqual(batches[0].headers.Authorization, 'Bearer re_test_key');
  assert.match(batches[0].headers['Idempotency-Key'], /^remind-2026-10-17-[0-9a-f]{24}$/);
  assert.ok(mail.text.includes('https://nfl2mindrill.com/') && !mail.headers, 'the site; no one-click header without API_URL');
  const link = mail.text.match(/\?unsub=(a_[0-9a-f]{40})\.([0-9a-f]{32})/);
  assert.ok(link && mail.html.includes(link[0]), 'an unsubscribe link');
  await cron('2026-10-17T09:05:00Z');
  assert.strictEqual(batches.length, 1, 'once a day, however many runs');
  set({ API_URL: 'https://board.example.workers.dev/' });
  await cron('2026-10-18T08:05:00Z');
  assert.strictEqual(batches.length, 2, 'the next day');
  assert.deepStrictEqual(batches[1].mails[0].headers, { 'List-Unsubscribe': `<https://board.example.workers.dev/auth/unsub?r=${link[1]}&t=${link[2]}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, 'the one-click header');
  resendDown = true;
  await cron('2026-10-19T08:05:00Z');
  assert.ok(errs.some((x) => /resend refused the daily reminders 500/.test(x)), 'a refusal is logged');
  resendDown = false;
  await cron('2026-10-19T09:05:00Z');
  assert.strictEqual(batches.length, 3, 'and sent in the next run');
  // unsubscribing: the link's token (any other refused), and the mail app's one-click post
  assert.strictEqual((await au('/auth/unsub', { r: link[1], t: '0'.repeat(32) })).status, 403, 'a wrong token');
  assert.strictEqual((await au('/auth/unsub', { r: 'a_' + '0'.repeat(40), t: link[2] })).status, 403, 'another reference');
  assert.strictEqual((await au('/auth/unsub', { r: 'x', t: 'y' })).status, 400);
  assert.strictEqual((await au('/auth/unsub', { r: link[1], t: link[2] })).status, 200, 'the link');
  assert.strictEqual((await ok(await au('/auth/me', { session: sa }), 'me')).remind, undefined, 'off');
  await cron('2026-10-20T08:05:00Z');
  assert.strictEqual(batches.length, 3, 'no more email');
  await ok(await au('/auth/remind', { session: sa, on: true }), 'on again');
  r = await worker.fetch(new Request(`https://w.example/auth/unsub?r=${link[1]}&t=${link[2]}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env);
  assert.strictEqual(r.status, 200, 'one-click');
  assert.strictEqual((await ok(await au('/auth/me', { session: sa }), 'me')).remind, undefined, 'off by one-click');
  assert.strictEqual((await call('POST', {}, { path: '/_cron/remind' })).status, 404, 'the cron\'s path is not reachable from outside');
  // a cap a run: 1000 (in batches of 100), the rest the next run
  for (let i = 0; i < 1005; i++) { store.set(`acct:e:p${i}@example.com`, { email: `p${i}@example.com` }); store.set(`rmd:e:p${i}@example.com`, { on: true }); }
  await cron('2026-10-21T08:05:00Z');
  assert.deepStrictEqual(batches.slice(3).map((x) => x.mails.length), new Array(10).fill(100), '1000 in batches of 100');
  await cron('2026-10-21T09:05:00Z');
  assert.deepStrictEqual(batches.slice(13).map((x) => x.mails.length), [5], 'the rest the next run');
  assert.ok(batches.every((x) => x.mails.every((m) => m.to.length === 1)), 'one address an email');
  for (let i = 0; i < 1005; i++) { store.delete(`acct:e:p${i}@example.com`); store.delete(`rmd:e:p${i}@example.com`); }
  assert.ok(!store.has('remind:from'), 'a run under the cap: nothing to go on from');
  // the cap from the var REMIND_CAP; a capped run's rest go on in the next run, and past a morning's runs the ones left
  // go first the next day (never the same accounts left out every day)
  set({ REMIND_CAP: '250' });
  for (let i = 0; i < 600; i++) { store.set(`acct:e:q${i}@example.com`, { email: `q${i}@example.com` }); store.set(`rmd:e:q${i}@example.com`, { on: true }); }
  const to = (from) => batches.slice(from).flatMap((x) => x.mails.map((m) => m.to[0]));
  let b0 = batches.length;
  await cron('2026-10-22T08:05:00Z');
  assert.deepStrictEqual(batches.slice(b0).map((x) => x.mails.length), [100, 100, 50], '250 a run, in batches of 100');
  const run1 = to(b0);
  b0 = batches.length;
  await cron('2026-10-22T09:05:00Z');
  const run2 = to(b0);
  assert.ok(run2.length === 250 && !run2.some((x) => run1.includes(x)), 'the next run: the next 250');
  assert.ok(run2[0] > run1[run1.length - 1], 'from where the last stopped');
  const left = Array.from({ length: 600 }, (_, i) => `q${i}@example.com`).filter((x) => !run1.includes(x) && !run2.includes(x));
  assert.strictEqual(left.length, 100);
  b0 = batches.length;
  await cron('2026-10-23T08:05:00Z');
  const run3 = to(b0);
  assert.deepStrictEqual([run3.length, run3.slice(0, 100).sort()], [250, left.slice().sort()], 'the next day: the ones left first');
  assert.deepStrictEqual(new Set(batches.slice(b0).map((x) => x.headers['Idempotency-Key'])).size, 3, 'a key a batch');
  for (let i = 0; i < 600; i++) { store.delete(`acct:e:q${i}@example.com`); store.delete(`rmd:e:q${i}@example.com`); }
  unset('REMIND_CAP');
  store.delete('remind:from');
  b0 = batches.length;
  unset('RESEND_KEY', 'MAIL_FROM');
  await cron('2026-10-24T08:05:00Z');
  assert.strictEqual(batches.length, b0, 'Resend off: nothing sent');
  console.error = realErr; console.log = realLog;
  unset('GOOGLE_CLIENT_ID', 'SITE', 'API_URL');
  globalThis.fetch = realFetch;
}
// A lost code (/recover): the email the buyer paid with in, the code out by email only (Resend and Stripe stubbed).
// The same answer for any address; the lookup the webhook and /claim keep (a keyed hash, never the address); Stripe's
// own record for purchases from before it; only complete, paid Pro sessions; limits per address and per IP; no address
// or code in any log
{
  const realFetch = globalThis.fetch, realErr = console.error, realLog = console.log, realWarn = console.warn;
  const envs = [env, board.env];
  const set = (o) => { for (const e of envs) Object.assign(e, o); };
  const unset = (...ks) => { for (const e of envs) for (const k of ks) delete e[k]; };
  const logs = [];
  console.error = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  const mails = [], lists = [];
  let resendDown = false, stripeDown = false;
  const S = (id, email, o = {}) => ({ id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', integration_identifier: 'tmd_pro_abcdefgh',
    customer_details: { email }, client_reference_id: null, ...o });
  // Stripe's record: matched on the address exactly as typed at checkout (as Stripe may)
  const stripeSessions = [
    S('cs_live_oldbuyer000000001', 'old@example.com'),                                       // bought before the lookup was kept
    S('cs_live_oldunpaid00000001', 'unpaid@example.com', { payment_status: 'unpaid' }),     // a bank payment never cleared
    S('cs_live_oldother000000001', 'other@example.com', { integration_identifier: null }),   // something else sold on the account
    S('cs_live_oldopen0000000001', 'open@example.com', { status: 'open', payment_status: 'unpaid' }),
    S('cs_live_oldcaps0000000001', 'Caps.Buyer@Example.com'),
  ];
  globalThis.fetch = async (u, init = {}) => {
    u = String(u);
    if (u === 'https://api.resend.com/emails') {
      if (resendDown) return new Response('{"message":"down"}', { status: 500 });
      mails.push([init.headers, JSON.parse(init.body)]); return new Response(JSON.stringify({ id: 'mail_r' }), { status: 200 });
    }
    if (u.startsWith('https://api.stripe.com/v1/checkout/sessions?')) {
      assert.strictEqual(init.method || 'GET', 'GET');
      if (stripeDown) return new Response('{"error":{"message":"down"}}', { status: 500 });
      const q = new URL(u).searchParams;
      lists.push(q);
      const data = stripeSessions.filter((x) => x.customer_details.email === q.get('customer_details[email]') && (!q.get('status') || x.status === q.get('status')));
      return new Response(JSON.stringify({ object: 'list', data, has_more: false }), { status: 200 });
    }
    const m = u.match(/checkout\/sessions\/(cs_live_[A-Za-z0-9]+)$/);
    if (m && m[1] === 'cs_live_claimed000000001') return new Response(JSON.stringify(S(m[1], 'Claimer@Example.com')), { status: 200 });
    return new Response('{"error":{"message":"No such checkout.session"}}', { status: 404 });
  };
  const rc = (email, o = {}) => call('POST', email === undefined ? {} : { email }, { path: '/recover', ...o });
  // off without Resend: 503 (and the page hides the option: GET /auth says email: false)
  assert.strictEqual((await rc('a@example.com')).status, 503, 'no Resend: off');
  set({ STRIPE_SECRET: 'rk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_test_recover', RESEND_KEY: 're_test', MAIL_FROM: 'Two-Minute Drill <hello@nfl2mindrill.com>',
    SITE: 'https://nfl2mindrill.com', RECOVER_MIN_MS: '0' });
  // the webhook keeps the lookup: a keyed hash of the address -> the session, never the address
  const signW = async (body, t = Math.floor(Date.now() / 1000)) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test_recover'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `t=${t},v1=${Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };
  const hook = async (obj) => { const body = JSON.stringify({ id: 'evt_r', type: 'checkout.session.completed', data: { object: obj } });
    return worker.fetch(new Request('https://w.example/stripe-webhook', { method: 'POST', body, headers: { 'Stripe-Signature': await signW(body) } }), env); };
  const buyerKeys = () => [...store.keys()].filter((k) => k.startsWith('pro:buyer:'));
  const before = buyerKeys().length;
  assert.strictEqual((await hook(S('cs_live_newbuyer000000001', 'New.Buyer@Example.com'))).status, 200);
  const newCode = store.get('pro:sess:cs_live_newbuyer000000001');
  assert.match(newCode || '', /^TMD-/);
  assert.strictEqual(buyerKeys().length, before + 1, 'the webhook stores the lookup');
  const k1 = buyerKeys().find((k) => (store.get(k) || []).includes('cs_live_newbuyer000000001'));
  assert.match(k1, /^pro:buyer:[0-9a-f]{40}$/);
  assert.deepStrictEqual(store.get(k1), ['cs_live_newbuyer000000001']);
  const noPlain = (addr) => { const all = JSON.stringify([...store]).toLowerCase(); return !all.includes(addr.toLowerCase()); };
  assert.ok(noPlain('new.buyer@example.com'), 'the address is not stored');
  assert.ok(!k1.includes(await sha256hex('new.buyer@example.com')), 'not a bare hash of the address either (keyed)');
  await hook(S('cs_live_newbuyer000000001', 'new.buyer@example.com'));              // Stripe retries: kept once
  assert.deepStrictEqual(store.get(k1), ['cs_live_newbuyer000000001']);
  await hook(S('cs_live_newunpaid0000001', 'New.Buyer@Example.com', { payment_status: 'unpaid' }));
  assert.deepStrictEqual(store.get(k1), ['cs_live_newbuyer000000001'], 'an unpaid session is not kept for the address');
  // a known buyer (any case, spaces): one email with the right code and a one-tap link; the answer never has the code
  let r = await rc('  NEW.buyer@example.com ');
  assert.strictEqual(r.status, 200);
  const known = await r.text();
  assert.deepStrictEqual(JSON.parse(known), { ok: true });
  assert.ok(!known.includes('TMD-'), 'never the code in the answer');
  assert.strictEqual(mails.length, 1, 'one email');
  let [mh, mail] = mails[0];
  assert.deepStrictEqual(mail.to, ['new.buyer@example.com']);
  assert.strictEqual(mail.from, 'Two-Minute Drill <hello@nfl2mindrill.com>', 'the sign-in emails\' sender');
  assert.strictEqual(mh.Authorization, 'Bearer re_test');
  assert.strictEqual(mail.subject, 'Your Two-Minute Drill Pro code');
  assert.ok(mail.text.includes(newCode) && mail.html.includes(newCode), 'the code');
  assert.ok(mail.text.includes('https://nfl2mindrill.com/?claim=cs_live_newbuyer000000001&r=1') && mail.html.includes('href="https://nfl2mindrill.com/?claim=cs_live_newbuyer000000001&r=1"'), 'the one-tap link');
  assert.ok(!/<img|track|utm_/i.test(mail.html), 'no tracking');
  // an unknown address: the same answer, no email (Stripe asked all the same)
  const nl = lists.length;
  r = await rc('nobody@example.com');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), known, 'the same answer for an address that bought nothing');
  assert.strictEqual(mails.length, 1, 'no email');
  assert.ok(lists.length > nl, 'Stripe is asked for an unknown address too');
  // a purchase from before the lookup: found on Stripe (complete, paid, this site's tag), its code minted, the lookup kept
  r = await rc('old@example.com');
  assert.strictEqual(await r.text(), known);
  const oldCode = store.get('pro:sess:cs_live_oldbuyer000000001');
  assert.match(oldCode || '', /^TMD-/, 'the old purchase gets its code');
  assert.strictEqual(mails.length, 2);
  assert.ok(mails[1][1].text.includes(oldCode) && mails[1][1].to[0] === 'old@example.com');
  const q = lists[lists.length - 1];
  assert.deepStrictEqual([q.get('customer_details[email]'), q.get('status'), q.get('limit')], ['old@example.com', 'complete', '100'], 'Stripe asked by the address, complete sessions');
  assert.ok(buyerKeys().some((k) => (store.get(k) || []).includes('cs_live_oldbuyer000000001')), 'and kept for next time');
  stripeDown = true;                                  // the lookup alone finds it now
  await rc('old@example.com');
  assert.strictEqual(mails.length, 3);
  assert.ok(mails[2][1].text.includes(oldCode), 'the same code again');
  assert.ok(logs.some((x) => /stripe refused the recovery lookup 500/.test(x)), 'Stripe down is logged');
  stripeDown = false;
  // unpaid, open, or another product's sessions: no code, no email
  for (const a of ['unpaid@example.com', 'open@example.com', 'other@example.com']) {
    r = await rc(a);
    assert.strictEqual(await r.text(), known, a);
  }
  assert.strictEqual(mails.length, 3, 'no email for unpaid, open or other sessions');
  for (const s of ['cs_live_oldunpaid00000001', 'cs_live_oldopen0000000001', 'cs_live_oldother000000001']) assert.ok(!store.has(`pro:sess:${s}`), `${s}: no code minted`);
  // Stripe matched as typed: the address typed in the same capitals is found
  await rc('Caps.Buyer@Example.com');
  assert.strictEqual(mails.length, 4);
  assert.deepStrictEqual(mails[3][1].to, ['caps.buyer@example.com']);
  // /claim keeps the lookup too: found afterwards with Stripe's list knowing nothing (other capitals)
  r = await call('POST', { s: 'cs_live_claimed000000001' }, { path: '/claim' });
  const claimed = (await r.json()).code;
  assert.match(claimed, /^TMD-/);
  await rc('claimer@example.com');
  assert.strictEqual(mails.length, 5);
  assert.ok(mails[4][1].text.includes(claimed), '/claim kept the lookup');
  // two purchases on one address: both codes, one email
  await hook(S('cs_live_newbuyer000000002', 'new.buyer@example.com'));
  const code2 = store.get('pro:sess:cs_live_newbuyer000000002');
  await rc('new.buyer@example.com', { ip: '10.9.0.1' });
  assert.strictEqual(mails.length, 6);
  mail = mails[5][1];
  assert.strictEqual(mail.subject, 'Your Two-Minute Drill Pro codes');
  assert.ok(mail.text.includes(newCode) && mail.text.includes(code2) && mail.text.includes('?claim=cs_live_newbuyer000000002&r=1'));
  // a code taken off (a refund): not sent
  store.delete(`pro:code:${code2}`);
  await rc('new.buyer@example.com', { ip: '10.9.0.2' });
  assert.ok(!mails[6][1].text.includes(code2) && mails[6][1].text.includes(newCode), 'a removed code is not sent');
  // the limit per address: 3 an hour (whatever the IP; any case), then 429, and nothing sent
  r = await rc('New.Buyer@example.com', { ip: '10.9.0.3' });
  assert.strictEqual(r.status, 429, 'the 4th ask of the hour for one address');
  assert.match((await r.json()).error, /Try again in an hour/);
  assert.strictEqual(mails.length, 7, 'nothing sent over the limit');
  // the limit per IP: 10 an hour, any addresses
  const ipx = { ip: '10.8.8.8' };
  for (let i = 0; i < 10; i++) assert.strictEqual((await rc(`p${i}@example.com`, ipx)).status, 200);
  assert.strictEqual((await rc('p10@example.com', ipx)).status, 429, 'the 11th ask from one IP');
  // bad input
  for (const bad of [undefined, '', 'not-an-email', 'a@b', `${'x'.repeat(200)}@example.com`, 42]) assert.strictEqual((await rc(bad)).status, 400, String(bad));
  assert.strictEqual((await call('GET', null, { path: '/recover' })).status, 405);
  // Resend down: the same answer (logged, without the address)
  resendDown = true;
  r = await rc('old@example.com', { ip: '10.9.0.9' });
  assert.strictEqual(await r.text(), known, 'Resend down: the same answer');
  assert.ok(logs.some((x) => /resend refused the recovery email 500/.test(x)));
  resendDown = false;
  // every answer takes at least RECOVER_MIN_MS (a buyer's is no slower to tell apart)
  set({ RECOVER_MIN_MS: '120' });
  let t0 = Date.now();
  await rc('timing@example.com', { ip: '10.9.1.1' });
  assert.ok(Date.now() - t0 >= 110, 'an unknown address waits the floor');
  unset('RECOVER_MIN_MS');
  // no address and no code in any log
  const leaked = logs.filter((x) => /@|TMD-/i.test(x));
  assert.deepStrictEqual(leaked, [], 'no PII in the logs');
  console.error = realErr; console.log = realLog; console.warn = realWarn;
  unset('STRIPE_SECRET', 'STRIPE_WEBHOOK_SECRET', 'RESEND_KEY', 'MAIL_FROM', 'SITE');
  globalThis.fetch = realFetch;
}
// ---- Live Drills (live.js, live_espn.js): a recorded game (live_replay.json: Pittsburgh at Cincinnati, Oct 16, 2025, the
// fourth quarter in the live feed's shape) played back through the real watcher, the feed 30 s behind each play and the
// cron once a minute (live_replay.mjs); the drills it makes, the routes, the switch, the feed failing, the post to X
{
  const L = await import('./live.js'), FEED = await import('./live_espn.js'), R = await import('./live_replay.mjs');
  const realFetch = globalThis.fetch, realErr = console.error, realLog = console.log, logs = [];
  console.error = (...a) => logs.push(a.join(' ')); console.log = () => {};
  const xs = [];
  globalThis.fetch = async (u, init) => {
    if (u === L.X_URL) { xs.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response('{"data":{"id":"1"}}', { status: 201 }); }
    throw new Error(`no network in the test: ${u}`);
  };
  const run = await R.replay(R.FIXTURE, { lag: 30e3 });
  const drills = run.steps[run.steps.length - 1].drills, byPlay = (pid) => Object.values(drills).find((d) => d.id.endsWith(`-${pid}`));
  assert.deepStrictEqual(Object.values(drills).map((d) => [d.player, d.snaps.length, d.end.how]).sort(),
    [['CIN', 10, 'field goal'], ['CIN', 4, 'punt'], ['PIT', 2, 'end of game'], ['PIT', 3, 'touchdown']].sort(), 'the four two-minute drives of the last 4:26');
  // Pittsburgh's touchdown: the incompletion, the holding flag on a quick pass, the 68-yard touchdown
  const td = byPlay('4139');
  assert.deepStrictEqual(td.snaps.map((x) => [x.what, x.call, x.res]), [['pass', 'deep_strong', 'Incomplete'], ['pass', 'quick_middle', 'Flag: offensive holding, 10 yards (no play)'],
    ['pass', 'deep_weak', 'Touchdown']]);
  assert.deepStrictEqual(td.start, { qtr: 4, clock: 166, score: [24, 30], pos: 'PIT', down: 1, ytg: 10, yl: 58, to: [3, 2], running: false }, 'the real spot after the punt');
  assert.deepStrictEqual(td.snaps[2].before, { qtr: 4, clock: 151, score: [24, 30], pos: 'PIT', down: 2, ytg: 20, yl: 68, to: [3, 2], running: false }, 'the flag moved it back 10');
  assert.ok(/Rodgers pass deep left to P.Freiermuth for 68 yards, TOUCHDOWN/.test(td.snaps[2].raw) && !/\d-[A-Z]|\(Shotgun\)/.test(td.snaps[2].raw), 'the feed\'s words, cleaned');
  // Cincinnati's field goal: the two-minute warning stops the clock, Pittsburgh's three timeouts come before the snaps
  // (the defense's: not a call), the kneels that bled them, Cincinnati's own two timeouts (calls of their own), the kick
  const fg = byPlay('4262');
  assert.deepStrictEqual(fg.snaps.map((x) => x.call), ['quick_strong', 'quick_strong', 'rb_middle', 'deep_weak', 'kneel', 'kneel', 'timeout', 'kneel', 'timeout', 'fg']);
  assert.deepStrictEqual(fg.snaps.map((x) => x.before.to.join('')), ['32', '32', '32', '22', '12', '02', '02', '01', '01', '00'], 'the timeouts before each call');
  assert.deepStrictEqual(fg.snaps.map((x) => x.before.running), [false, false, false, false, false, false, true, false, true, false], 'the clock: the warning, out of bounds, the timeouts');
  assert.deepStrictEqual(fg.snaps.map((x) => x.pre.length), [0, 0, 0, 1, 1, 1, 0, 0, 0, 0]);
  assert.strictEqual(fg.snaps[3].pre[0], 'Timeout, Pittsburgh');
  assert.deepStrictEqual([fg.snaps[4].before.down, fg.snaps[4].before.ytg, fg.snaps[4].before.yl], [1, 7, 7], 'first and goal at the 7');
  assert.deepStrictEqual(fg.end, { how: 'field goal', text: '36-yard field goal is good', score: [31, 33] });
  assert.strictEqual(fg.r2h, 'CIN', 'Cincinnati kicked off the game: it gets the ball after halftime');
  assert.strictEqual(byPlay('4043').snaps[1].call, null, 'a sack: the call it was is not known');
  // the delay from a play to the worker: the feed's 30 s, then the next minute's look (the page's 0-12 s poll on top)
  const ds = Object.values(drills).flatMap((d) => d.snaps.map((x) => (x.at - x.wall) / 1e3));
  assert.ok(ds.length === 19 && ds.every((x) => x >= 30 && x <= 90), `every play within 30-90 s: ${ds}`);
  assert.ok(run.delays.mean > 40 && run.delays.mean < 75, `about a minute on average: ${run.delays.mean}`);
  // gentle: a request a minute at most for the scoreboard, and for the game
  const perMin = (re) => { const m = new Map(); run.asked.filter((x) => re.test(x.url)).forEach((x) => m.set(Math.floor(x.at / 60e3), (m.get(Math.floor(x.at / 60e3)) || 0) + 1)); return Math.max(...m.values()); };
  assert.strictEqual(perMin(/scoreboard/), 1); assert.strictEqual(perMin(/summary/), 1);
  assert.ok(run.asked.filter((x) => /summary/.test(x.url)).length <= 30, 'the game only while it is near a two-minute spot');
  // what a page reads mid-drive: the drill open, where the ball is now, its timeouts, never a stale spot
  const mid = run.steps.find((x) => x.live.drills.some((d) => d.id.endsWith('-4262') && d.n === 3));
  assert.ok(mid && mid.live.on && mid.live.poll === 12, 'open, asked every 12 s');
  assert.deepStrictEqual(mid.live.drills[0].now, { qtr: 4, clock: 107, score: [31, 30], pos: 'CIN', down: 2, ytg: 8, yl: 35, to: [2, 2], running: false }, 'after Pittsburgh\'s timeout');
  assert.strictEqual(mid.live.drills[0].polled, mid.now, 'read this minute');
  assert.ok(run.steps.every((x) => x.live.drills.length <= 1), 'one drill at a time in one game');
  assert.deepStrictEqual(run.storage.store.get('arch').map((x) => x.player), ['PIT', 'CIN', 'PIT', 'CIN'], 'the archive, newest first');
  assert.ok(!run.storage.store.get('rej'), 'nothing rejected from a good feed');
  assert.strictEqual(xs.length, 0, 'no post to X without its secrets');

  // the routes through the worker's front door: CORS, the object behind them, nothing past them
  const obj = new L.Live({ storage: run.storage }, { LIVE_ON: 'on', ADMIN_TOKEN: 'live-admin-token-1' });
  const lenv = { ...env, LIVE_ON: 'on', ADMIN_TOKEN: 'live-admin-token-1', LIVE: { idFromName: (n) => n, get: () => ({ fetch: (req) => obj.fetch(req) }) } };
  const lcall = (path, o = {}) => worker.fetch(new Request(`https://w.example${path}`, { method: o.method || 'GET', body: o.body && JSON.stringify(o.body),
    headers: { Origin: 'https://nfl2mindrill.com', ...(o.auth ? { Authorization: o.auth } : {}) } }), o.env || lenv);
  r = await lcall('/live');
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), 'https://nfl2mindrill.com');
  assert.deepStrictEqual(((await r.json()).drills), [], 'after the final gun: nothing open');
  b = await (await lcall(`/live/drill?id=${fg.id}`)).json();
  assert.strictEqual(b.drill.snaps.length, 10, 'a finished drill, for the archive\'s replay');
  assert.strictEqual((await lcall('/live/drill?id=../board')).status, 404);
  assert.strictEqual((await (await lcall('/live/archive')).json()).drills.length, 4);
  assert.strictEqual((await lcall('/live/other')).status, 404);
  assert.strictEqual((await lcall('/live', { method: 'OPTIONS' })).status, 204);
  assert.strictEqual((await lcall('/_cron/live', { method: 'POST', body: { now: 1 } })).status, 404, 'the watcher\'s own path is not reachable');
  assert.strictEqual((await lcall('/live/admin')).status, 403, 'the admin view takes the token');
  // the switch: off (LIVE_ON not "on"), the front door answers without the object and the cron does nothing at all
  let asked = 0;
  const offEnv = { ...lenv, LIVE_ON: 'off', LIVE: { idFromName: (n) => n, get: () => { asked++; return { fetch: (req) => obj.fetch(req) }; } } };
  assert.deepStrictEqual(await (await lcall('/live', { env: offEnv })).json(), { on: false, drills: [] });
  assert.deepStrictEqual(await worker.scheduled({ cron: L.LIVE_CRON, scheduledTime: Date.now() }, offEnv, { waitUntil() {} }), { off: true });
  assert.strictEqual(asked, 0, 'off: the object is not even asked');
  const quiet = await R.replay(R.FIXTURE, { env: { LIVE_ON: '' } });
  assert.strictEqual(quiet.asked.length, 0, 'off: no request to the feed');
  // on, the admin pauses and resumes it at once (no deploy), and says what it saw
  b = await (await lcall('/live/admin', { method: 'POST', body: { on: false }, auth: 'Bearer live-admin-token-1' })).json();
  assert.deepStrictEqual([b.on, b.var, b.paused], [false, true, true]);
  assert.deepStrictEqual(await (await lcall('/live')).json(), { on: false, drills: [] }, 'paused: pages are told it is off');
  assert.deepStrictEqual(await L.tick(lenv, run.storage, Date.now(), () => { throw new Error('asked'); }), { off: true }, 'paused: the watcher stops');
  b = await (await lcall('/live/admin', { method: 'POST', body: { on: true }, auth: 'Bearer live-admin-token-1' })).json();
  assert.deepStrictEqual([b.on, b.paused, b.rej.n], [true, false, 0]);
  assert.strictEqual((await lcall('/live/admin', { method: 'POST', body: { on: 'yes' }, auth: 'Bearer live-admin-token-1' })).status, 400);
  // on, the cron's minute goes to the object
  let ticked = null;
  const onEnv = { ...lenv, LIVE: { idFromName: (n) => n, get: () => ({ fetch: async (req) => { ticked = JSON.parse(await req.text()); return new Response('{"board":false}'); } }) } };
  await worker.scheduled({ cron: L.LIVE_CRON, scheduledTime: 1760670000000 }, onEnv, { waitUntil() {} });
  assert.deepStrictEqual(ticked, { now: 1760670000000 });

  // the post to X when a drill opens: only with all four secrets, signed (OAuth 1.0a, X's own worked example), once a
  // drill, never for one first seen already over (Pittsburgh's last 7 seconds came and went inside a minute)
  assert.strictEqual(await L.oauthSign('POST', 'https://api.twitter.com/1.1/statuses/update.json', { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog', oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', oauth_version: '1.0' }, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE'), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  const xenv = { LIVE_ON: 'on', SITE: 'https://2mindrills.com', X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
  await R.replay(R.FIXTURE, { env: { ...xenv, X_ACCESS_SECRET: '' } });
  assert.strictEqual(xs.length, 0, 'three secrets of four: nothing');
  await R.replay(R.FIXTURE, { env: xenv });
  assert.deepStrictEqual(xs.map((x) => x.body.text), [
    'Live now: Cincinnati ball at its own 22, up 6, 4:21 left. Call it before the coach does → https://2mindrills.com/#live',
    'Live now: Pittsburgh ball at its own 42, down 6, 2:39 left. Call it before the coach does → https://2mindrills.com/#live',
    'Live now: Cincinnati ball at its own 45, down 1, 2:00 left. Call it before the coach does → https://2mindrills.com/#live']);
  assert.ok(xs.every((x) => /^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0"$/.test(x.auth)));
  assert.strictEqual(L.xText(xenv, { ...fg, coach: 'Zac Taylor', now: fg.snaps[3].before }), 'Live now: Cincinnati ball at the Pittsburgh 35, down 1, 1:47 left. Call it before Taylor does → https://2mindrills.com/#live');

  // the feed failing: an error backs off (1, 2, 4 ... minutes), the open drill stops being fresh (polled stays: the
  // page then says it is waiting on the next play), and after IDLE (20 minutes) it is closed as the feed left it
  {
    const st = R.memStorage(), e2 = { LIVE_ON: 'on' }, fx = R.FIXTURE, t0 = Date.parse('2025-10-17T03:17:00Z');
    let down = false, n = 0;
    const get = async (url) => { n++; if (down) throw new Error('503'); const f = R.feedAt(fx, L.LIVE_CLOCK.now, 30e3); return url === FEED.BOARD ? f.board : f.summary; };
    for (let T = t0 - 60 * 60e3; T <= t0; T += 60e3) { L.LIVE_CLOCK.now = T; await L.tick(e2, st, T, get); }
    const id = (await st.get('open'))[0], polled = (await st.get(`d:${id}`)).polled;
    assert.ok(id.endsWith('-4262') && polled === t0, 'Cincinnati\'s drive open, read just now');
    down = true; n = 0;
    for (let T = t0 + 60e3; T <= t0 + 15 * 60e3; T += 60e3) { L.LIVE_CLOCK.now = T; await L.tick(e2, st, T, get); }
    assert.ok(n <= 10, `backing off: ${n} requests in 15 minutes`);
    assert.strictEqual((await st.get(`d:${id}`)).polled, polled, 'not read since: the page shows it stale');
    for (let T = t0 + 16 * 60e3; T <= t0 + 22 * 60e3; T += 60e3) { L.LIVE_CLOCK.now = T; await L.tick(e2, st, T, get); }
    const d = await st.get(`d:${id}`);
    assert.deepStrictEqual([d.status, d.end.how, (await st.get('open')).length], ['over', 'feed', 0], 'closed as the feed left it');
    assert.ok(logs.some((x) => /live feed: the scoreboard failed 503/.test(x)), 'the failures are logged');
    L.LIVE_CLOCK.now = null;
  }
  // a feed not as expected: rejected, counted and logged (a change of schema shows), and no drill opened or changed on it
  {
    const broken = structuredClone(R.FIXTURE);
    for (const p of broken.plays) if (p.id === '4346' && p.start) { delete p.start.yardsToEndzone; delete p.start.downDistanceText; }
    const bad = await R.replay(broken, { lag: 30e3 });
    const rej = bad.storage.store.get('rej'), fin = bad.steps[bad.steps.length - 1].drills;
    assert.ok(rej && rej.n > 0 && /play 4346: pass: no down, distance or spot/.test(rej.last[0].why), 'counted, with its reason');
    const cin = Object.values(fin).find((d) => d.id.endsWith('-4262'));
    assert.ok(cin && cin.snaps.length === 3 && cin.status === 'open', 'the drill stopped where the feed went wrong, never past it');
    assert.ok(logs.some((x) => /live feed: rejected/.test(x)));
    // the scoreboard's shape changed: nothing read, counted
    const st = R.memStorage();
    await L.tick({ LIVE_ON: 'on' }, st, Date.parse('2025-10-17T03:17:00Z'), async () => ({ games: [] }));
    assert.deepStrictEqual([(await st.get('rej')).n, (await st.get('sched')).games.length], [1, 0]);
    assert.deepStrictEqual(FEED.board({ events: [{ id: '12345', competitions: [{ competitors: [], status: { type: { state: 'in' } } }] }] }).bad, ['scoreboard 12345: teams']);
    assert.strictEqual(FEED.board({ events: [{ id: '12345', competitions: [{ status: { type: { state: 'in' }, period: 4, clock: 30 },
      competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'XYZ' }, score: '3' }, { homeAway: 'away', team: { id: '2', abbreviation: 'KC' }, score: '0' }] }] }] }).games.length, 0, 'a team it does not know: no game');
  }
  // two games at once (a second, two minutes behind, Buffalo at Kansas City): both open together
  {
    const sw = (x) => (typeof x === 'string' ? x.replace(/\bPIT\b/g, 'BUF').replace(/\bCIN\b/g, 'KC') : x);
    const fx2 = JSON.parse(JSON.stringify(R.FIXTURE, (k, v) => (k === 'id' && (v === '23' || v === '4') ? { 23: '2', 4: '12' }[v] : k === 'wallclock' ? new Date(Date.parse(v) + 120e3).toISOString() : sw(v))));
    fx2.event.id = '2025101601';
    const both = (fx, T, lag) => { const a = R.feedAt(R.FIXTURE, T, lag), c = R.feedAt(fx2, T, lag); return { board: { events: [...a.board.events, ...c.board.events] }, summary: a.summary, two: c.summary }; };
    const st = R.memStorage(), e2 = { LIVE_ON: 'on' }, obj2 = new L.Live({ storage: st }, e2);
    const get = async (url) => { const f = both(null, L.LIVE_CLOCK.now, 30e3); return url === FEED.BOARD ? f.board : url === FEED.gameUrl('2025101601') ? f.two : f.summary; };
    let most = 0;
    for (let T = Date.parse('2025-10-17T03:00:00Z'); T <= Date.parse('2025-10-17T03:32:00Z'); T += 60e3) {
      L.LIVE_CLOCK.now = T; await L.tick(e2, st, T, get);
      const lv = await (await obj2.fetch(new Request('https://w.example/live'))).json();
      if (lv.drills.length > most) most = lv.drills.length;
      if (lv.drills.length === 2) assert.deepStrictEqual(lv.drills.map((x) => x.home).sort(), ['CIN', 'KC']);
    }
    L.LIVE_CLOCK.now = null;
    assert.strictEqual(most, 2, 'two drills open at once');
    assert.strictEqual(st.store.get('arch').length, 8);
  }
  console.error = realErr; console.log = realLog;
  globalThis.fetch = realFetch;
  console.log(`live drills ok (the replay: ${run.delays.n} plays reached the worker ${run.delays.min.toFixed(0)}-${run.delays.max.toFixed(0)} s after they happened, ${run.delays.mean.toFixed(0)} s on average; the page's poll adds 0-12 s)`);
}
console.log('board worker ok');
