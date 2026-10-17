// Tests for the leaderboard Worker, its Durable Object run in memory:   node board/worker_test.mjs
import assert from 'node:assert';
import worker, { Board } from './worker.js';
import { createHash } from 'node:crypto';
const sha256hex = async (x) => createHash('sha256').update(x).digest('hex');

const store = new Map();
const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k),
  list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) };
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
// the #HuntForMadden: the draw is the server's (a secret the page never sees). With a known secret, find a device that
// draws him: its first result of the day gets a claim code, the public list has it with the time, a replay of the day
// returns the same code, and anyone else's result doesn't get one
{
  const { createHash } = await import('node:crypto');
  const hex = (x) => createHash('sha256').update(x).digest('hex');
  board.env.MADDEN_SECRET = 'test-madden-secret';
  let lucky = null;
  for (let i = 0; i < 2e6 && !lucky; i++) {
    const k = `madden-device-key-${i}`, d = hex(`test-madden-secret:draw:${hex(k)}:${today}`);
    if (parseInt(d.slice(0, 12), 16) / 2 ** 48 < 1 / 50000) lucky = k;
  }
  assert.ok(lucky, 'a device that draws him');
  const plain = await (await day({ date: today, key: 'unlucky-device-key-00001', p: 0.5, spots: [0, 0, 0] })).json();
  assert.strictEqual(plain.madden, undefined, 'an ordinary result: no Madden');
  const got = await (await day({ date: today, key: lucky, p: 0.3, spots: [0, 0, 0] })).json();
  assert.ok(/^[0-9A-F]{8}$/.test(got.madden), 'a claim code: ' + JSON.stringify(got).slice(0, 200));
  const again = await (await day({ date: today, key: lucky, p: 0.9, spots: [0, 0, 0] })).json();
  assert.strictEqual(again.madden, got.madden, 'a replay shows the same code');
  const list = await (await call('GET', null, { path: '/madden' })).json();
  assert.strictEqual(list.odds, 50000);
  assert.deepStrictEqual(list.finds.map((f) => [f.date, f.code]), [[today, got.madden]], 'on the public list, once');
  assert.ok(!JSON.stringify(list).includes(hex(lucky)) && !JSON.stringify(list).includes('test-madden-secret'), 'no key or secret shown');
  delete board.env.MADDEN_SECRET;
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
  const g = await (await call('POST', { note: 'found Madden' }, { path: '/pro/gift', auth: 'Bearer commish-secret-123' })).json();
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
  assert.deepStrictEqual(await ok(await au('/auth/stats', { session: sa }), 'read'), { stats: { days: {}, drives: {}, runs: {}, badges: {}, frozen: {} } }, 'nothing yet');
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
    drives: { 3: { p: 0.7, wpa: 0.05, tries: 2, won: false, last: 0.6, at: 1790000000000 } }, runs: { 2: { p: 0.66, wpa: 0.3, w: 3, l: 1, n: 4 } }, badges: {}, frozen: {} }, 'cleaned: junk entries and fields dropped');
  d = await ok(await au('/auth/stats', { session: sa, stats: { days: { 5: { p: 0.4, wpa: 0.9, coach: 'Other' }, 6: { p: 0.9, wpa: 0.3, coach: 'Sean McVay', madden: 'zz' }, 10: { p: 0.3, wpa: 0, coach: 'John Madden', madden: 'ABCD1234' } },
    drives: { 3: { p: 0.6, wpa: 0, tries: 5, won: true }, 4: { p: 0.95, wpa: 0.2, tries: 1, won: true } }, runs: { 2: { p: 0.5, wpa: 0, w: 1, l: 3, n: 4 } } } }), 'second phone');
  assert.deepStrictEqual(d.stats.days, { 5: { p: 0.5, wpa: 0.1, coach: 'Andy Reid' }, 6: { p: 0.9, wpa: 0.3, coach: 'Sean McVay' }, 10: { p: 0.3, wpa: 0, coach: 'John Madden', madden: 'ABCD1234' } }, 'days: the higher score of each, a bad Madden code dropped');
  assert.deepStrictEqual(d.stats.drives, { 3: { p: 0.7, wpa: 0.05, tries: 5, won: true, last: 0.6, at: 1790000000000 }, 4: { p: 0.95, wpa: 0.2, tries: 1, won: true } }, 'drives: best score, most tries, won if either');
  assert.strictEqual(d.stats.runs[2].p, 0.66, 'runs: the best');
  d = await ok(await au('/auth/stats', { session: sa, stats: { days: { 10: { p: 0.6, wpa: 0, coach: 'Bill Belichick' } } } }), 'a better score on a Madden day');
  assert.deepStrictEqual(d.stats.days[10], { p: 0.6, wpa: 0, coach: 'John Madden', madden: 'ABCD1234' }, 'the Madden find kept');
  assert.deepStrictEqual((await ok(await au('/auth/stats', { session: sb }), 'other')).stats, { days: {}, drives: {}, runs: {}, badges: {}, frozen: {} }, 'never another account\'s');
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
  d = await ok(await au('/auth/stats', { session: sc, stats: { days: { 3: { p: 0.5, vs: 1 }, 4: { p: 0.5, vs: 5 }, 5: { p: 0.5, vs: -0.4 } },
    badges: { first: 1790000002000, coach: 1790000001500, 'Bad-Id': 1, '1st': 1, ['x'.repeat(17)]: 1, win: 'soon', day90: -5 },
    frozen: { 7: 1790000000100, 0: 1, abc: 1, 100000: 1, 8: null } } }), 'badges and frozen days');
  assert.deepStrictEqual([d.stats.days[3].vs, 'vs' in d.stats.days[4], d.stats.days[5].vs], [1, false, -1], 'vs: better, the same or worse; anything else dropped');
  assert.deepStrictEqual([d.stats.badges, d.stats.frozen], [{ coach: 1790000001500, first: 1790000002000 }, { 7: 1790000000100 }], 'cleaned');
  assert.deepStrictEqual(store.get('stats:m:g:700003'), { badges: d.stats.badges, frozen: d.stats.frozen }, 'kept on their own key');
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

  // a username on the boards: the account's own name from any phone (the survivor board and the day's list); anyone
  // else, or the account under another name, as before
  const kA = 'amy-phone-key-0000000001', kB = 'amy-other-phone-key-0002', kX = 'stranger-key-000000000003';
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 4, key: kA, session: sa })).status, 200, 'first phone');
  assert.strictEqual((await call('POST', { name: 'amy hawk', best: 6, key: kB, session: sa })).status, 200, 'a new phone, signed in: her name');
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 9, key: kX })).status, 409, 'a stranger: taken');
  assert.strictEqual((await call('POST', { name: 'Amy Hawk', best: 9, key: kX, session: sb })).status, 409, 'another account: taken');
  assert.ok((await (await call('GET')).json()).rows.some((x) => x.name.toLowerCase() === 'amy hawk' && x.best === 6), 'her best, from either phone');
  store.set('claim:ben bolt', 'f'.repeat(64));                         // a device took "Ben Bolt" before the account did
  assert.strictEqual((await call('POST', { name: 'Ben Bolt', best: 2, key: kX, session: sb })).status, 200, 'the account\'s username is the account\'s');
  r = await call('POST', { name: 'Not Amy', best: 1, key: kB, session: sa });
  assert.strictEqual(r.status, 200, 'another name: claimed by the device, as ever');
  assert.strictEqual(store.get('claim:not amy'), await sha256hex(kB));
  b = await (await day({ date: today, key: kB, p: 0.77, spots: [0.1], name: 'Amy Hawk', session: sa })).json();
  assert.ok(!b.taken && b.top.some((x) => x.name === 'Amy Hawk'), 'the day\'s list: her name from the new phone');
  b = await (await day({ date: today, key: 'stranger-key-000000000004', p: 0.9, spots: [0.1], name: 'Amy Hawk' })).json();
  assert.strictEqual(b.taken, true, 'and nobody else\'s');

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
  unset('RESEND_KEY', 'MAIL_FROM');
  await cron('2026-10-22T08:05:00Z');
  assert.strictEqual(batches.length, 14, 'Resend off: nothing sent');
  console.error = realErr; console.log = realLog;
  unset('GOOGLE_CLIENT_ID', 'SITE', 'API_URL');
  globalThis.fetch = realFetch;
}
console.log('board worker ok');
