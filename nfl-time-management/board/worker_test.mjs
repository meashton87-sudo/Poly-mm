// Tests for the leaderboard Worker, its Durable Object run in memory:   node board/worker_test.mjs
import assert from 'node:assert';
import worker, { Board } from './worker.js';

const store = new Map();
const storage = { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); },
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
console.log('board worker ok');
