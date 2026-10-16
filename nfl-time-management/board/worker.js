// Survivor leaderboard for the Two-Minute Drill website: a Cloudflare Worker in front of one Durable Object (Board),
// which keeps the board in its own storage. One object handles every post in turn, so two runs posted together
// can't overwrite each other, and its per-IP limit is the same everywhere (KV took up to a minute to sync).
//   GET    /board                       -> { rows: [{ name, best, at }] }   the top 25 best runs
//   POST   /board  { name, best, key }  -> { rows, kept? }                  a player's best (only a better run replaces it)
//   DELETE /board?name=Eli  (Authorization: Bearer <ADMIN_TOKEN>)          remove a row (no ADMIN_TOKEN secret: off)
//   GET    /daily?date=2026-10-14                         -> that day's players: { n, hist, spots, top }
//   GET    /days                                           -> every day played: { days: [{ date, n, avg, best }] }
//   GET    /madden                                         -> every John Madden found: { odds, finds: [{ date, at, code }] }
//   POST   /daily  { date, key, p, spots: [w, ...], name? }  -> the same, after counting your result (1-3 spots: the
//                                                             day's drive, or the three spots days had before)
// The daily game: every device's first result of a day counts once (a replay of the day changes nothing). p is the
// day's score (0-1, better than that share of NFL play-callers), spots each spot's win chance against a typical
// play-caller (-1 to 1). The day keeps a histogram of scores in whole points (hist[0..100]), each spot's histogram
// in points of win chance (-50..50, clipped) and its average, and the top 10 named players (name optional; a name
// is claimed the same way as on the survivor board, one claim across both). date is the player's local date, so
// one within a day of the server's.
// Players are identified by name (a game among friends): trimmed, control characters dropped, 1-24 characters,
// matched case-insensitively. The first post under a name claims it for that device's key (a random string the page
// keeps; only its SHA-256 is stored), so nobody else can overwrite your score. Signed in ({ session } with the post:
// Accounts below), the account's own username is the account's: claimed for it whatever device posts (a username is
// one account's), so a new phone plays under it. Scores are not checked against the runs that made them. Posts are limited per IP (RATE_PER_MIN a minute). The page may be served from another host,
// so responses carry CORS headers for ALLOWED_ORIGINS (comma-separated; "*" = any).
// Pro (a one-time purchase on Stripe Checkout: Apple Pay, Google Pay, Link and cards on Stripe's own page; needs the
// secret STRIPE_SECRET (a restricted key: Checkout Sessions read and write) and the vars STRIPE_PRICE (a one-time
// price id, price_...; or the product id, prod_..., charged PRO_CENTS) and SITE; without them /pay answers 503):
//   GET    /pro                      -> { on, price }        whether payments are set up, and the price shown
//   POST   /pay   { session? }       -> { url }              a Checkout session: send the player to url; Stripe sends
//                                                            him back to SITE/?claim=<session id>
//   POST   /claim   { s }            -> { code }             after paying: the session's Pro code (the same code
//                                                            every time for one session; TMD-XXXX-XXXX-XXXX)
//   POST   /restore { code }         -> { ok, code }         the code on another device (404 for one never issued);
//                                                            or { session }: the signed-in account's code (Accounts)
//   POST   /pro/data { code, name }  -> the file               the Pro data (board/assets/pro: drives.json, d0.json,
//                                                            runs.json, r0.json, ...) to a valid code only; the files
//                                                            are never served as plain assets (403 without a code)
//   POST   /stripe-webhook           -> { received }         Stripe's events (STRIPE_WEBHOOK_SECRET signs them): a
//                                                            completed, paid session gets its code here too, so a
//                                                            buyer who never lands back on the site (closed the tab,
//                                                            a bank payment that cleared later) still has one to claim
// A code is 12 letters and digits (no 0/O, 1/I/L) drawn at random: about 60 bits, posted at RATE_PER_MIN an IP.
// Nothing about the buyer is kept here (Stripe has the receipt); only the session id behind each code (and, for a
// purchase made signed in, the account it belongs to: see Accounts below).
const TOP = 25, KEEP = 500, RATE_PER_MIN = 30, DAY_TOP = 10;
const RACE_PATHS = ['/race', '/race/me', '/race/join', '/race/start', '/race/pass'];
const PRO_PATHS = ['/pro', '/pay', '/claim', '/restore', '/stripe-webhook', '/pro/data', '/pro/reset', '/pro/gift'];
const PRO_FILE_RE = /^(drives|runs|d\d{1,3}|r\d{1,3})\.json$/;
const STRIPE_VERSION = '2026-08-26.dahlia', WEBHOOK_TOLERANCE = 300;   // the API version pinned; a signature older than this is refused
const PRO_PRICE = '$4.99', PRO_CENTS = 499, PRO_TAX_CODE = 'txcd_10201001',    // video games, downloaded, non-subscription: the product's category; Managed Payments refuses a line without one
  PRO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (name, n = 24) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DEV_MAX = 3, DEV_DAYS = 30;        // a Pro code works on this many devices at once; a device unseen this long frees its place
// Names are shown publicly (the stats page, the survivor board): slurs and obscenities are refused, spelled any way
// (case, spaces, punctuation, digits for letters, repeated letters). SUB: refused anywhere in a name; WORD: refused as
// a whole word (they occur inside ordinary names: "Cassel", "Dickerson", "Hancock"). Stored rows with such a name are
// left out of every list too (rows from before the check).
const SUB = ['nigg', 'niga', 'nigr', 'faggot', 'retard', 'kike', 'chink', 'wetback', 'tranny', 'beaner', 'raghead',
  'towelhead', 'fuck', 'fck', 'shit', 'cunt', 'pussy', 'whore', 'slut', 'bitch', 'hitler', 'kkk', 'cocksuck', 'motherf',
  'dildo', 'blowjob', 'handjob', 'jizz', 'porn', 'penis', 'vagina', 'molest', 'incest', 'boob', 'titties', 'onlyfans',
  'siegheil', 'heilhit', 'gasthe', 'killall', 'nazi'];
const WORD = ['ass', 'asses', 'asshole', 'dick', 'dicks', 'cock', 'cocks', 'fag', 'fags', 'twat', 'wank', 'piss', 'hoe',
  'hoes', 'nig', 'dyke', 'homo', 'tit', 'tits', 'cum', 'anal', 'sex', 'sexy', 'spic', 'coon', 'gook', 'rape', 'raped',
  'rapist', 'pedo', 'fuk', 'nude', 'naked', 'jihad', 'terrorist'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };
function blocked(name) {
  const low = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const mapped = [...low].map((c) => LEET[c] ?? c).join('');
  const squash = (x) => x.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
  const whole = squash(mapped), joined = mapped.replace(/[^a-z]/g, '');
  if (SUB.some((w) => { const sw = squash(w); return (sw.length >= 4 && whole.includes(sw)) || joined.includes(w); })) return true;
  const words = mapped.split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => WORD.includes(w) || WORD.includes(squash(w)));
}
const shown = (rows) => rows.filter((r) => !blocked(r.name));
// The rare one (the #HuntForMadden): a device's first counted daily result is John Madden one time in MADDEN_ODDS, by a
// draw from a secret the pages never see (env.MADDEN_SECRET, else one made at random on first use and kept in
// storage), so it can't be faked on the page or worked out in advance. Each find gets a claim code (shown on the card)
// and goes on the public list with the time, earliest first: the first code on the list is the first find.
const MADDEN_ODDS = 50000, MADDEN_KEEP = 2000;
async function maddenSecret(env, storage) {
  if (env.MADDEN_SECRET) return String(env.MADDEN_SECRET);
  let s = await storage.get('madden:secret');
  if (!s) { s = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''); await storage.put('madden:secret', s); }
  return s;
}
async function maddenDraw(env, storage, kh, date) {
  const sec = await maddenSecret(env, storage), d = await sha256(`${sec}:draw:${kh}:${date}`);
  if (parseInt(d.slice(0, 12), 16) / 2 ** 48 >= 1 / MADDEN_ODDS) return null;
  return (await sha256(`${sec}:code:${kh}:${date}`)).slice(0, 8).toUpperCase();
}

function cors(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return { 'Access-Control-Allow-Origin': ok, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const ranked = (all) => shown(all).slice().sort((a, b) => b.best - a.best || String(a.at).localeCompare(String(b.at))).slice(0, TOP)
  .map(({ name, best, at, life }) => ({ name, best, at, ...(life ? { life: true } : {}) }));   // never the key hash
async function sha256(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
// constant-time enough for a bearer token compared once per request
const same = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

const limited = (req, hits) => {
  const ip = req.headers.get('CF-Connecting-IP') || 'local', min = Math.floor(Date.now() / 60000);
  for (const [k, v] of hits) if (v.min !== min) hits.delete(k);
  const hit = hits.get(ip) || { min, n: 0 };
  if (hit.n >= RATE_PER_MIN) return true;
  hits.set(ip, { min, n: hit.n + 1 });
  return false;
};
// who owns a name: its claim (one key per name: claim:<name>), a claim in the one shared value claims were first
// kept in (no longer written: a single value would outgrow storage's 2 MB a value), or the survivor row that holds
// it from before claims were kept
async function ownerOf(storage, lower) {
  const mine = await storage.get(`claim:${lower}`);
  if (mine) return mine;
  const claims = (await storage.get('claims')) || {};
  if (claims[lower]) return claims[lower];
  const runs = (await storage.get('runs')) || [];
  const row = runs.find((r) => String(r.name).toLowerCase() === lower);
  return row && row.kh ? row.kh : null;
}
const claim = (storage, lower, kh) => storage.put(`claim:${lower}`, kh);
const emptyDay = () => ({ n: 0, hist: new Array(101).fill(0), spots: [0, 1, 2].map(() => ({ n: 0, sum: 0, hist: new Array(101).fill(0) })), top: [] });
const dayView = (d) => ({ n: d.n, hist: d.hist, spots: d.spots.map((x) => ({ n: x.n, avg: x.n ? x.sum / x.n : 0, hist: x.hist })),
  top: shown(d.top).map(({ name, p }) => ({ name, p })) });
function dateOk(date, now = Date.now()) {
  if (!DATE_RE.test(date)) return false;
  const t = Date.parse(date + 'T12:00:00Z');
  return Number.isFinite(t) && Math.abs(t - now) <= 36 * 3600e3;        // any time zone's today
}

// every day anyone played, oldest first: players, average score (0-1) and the best score, from the day's histogram
async function days(storage, h) {
  const all = await storage.list({ prefix: 'day:' });
  const out = [];
  for (const [k, d] of all) {
    if (!d || !d.n) continue;
    let sum = 0, best = 0;
    d.hist.forEach((c, pt) => { sum += c * pt; if (c) best = pt; });
    out.push({ date: k.slice(4), n: d.n, avg: sum / d.n / 100, best: best / 100 });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return json({ days: out }, 200, h);
}

async function daily(req, env, storage, hits, h, url) {
  if (req.method === 'GET') {
    const date = String(url.searchParams.get('date') || '');
    if (!DATE_RE.test(date)) return json({ error: 'date (YYYY-MM-DD) wanted' }, 400, h);
    return json(dayView((await storage.get(`day:${date}`)) || emptyDay()), 200, h);
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  if (limited(req, hits)) return json({ error: 'slow down' }, 429, h);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  const date = String((body && body.date) || ''), p = body && body.p, devKey = String((body && body.key) || '');
  const spots = Array.isArray(body && body.spots) ? body.spots : null, raw = clean(body && body.name);
  const refused = !!raw && blocked(raw), name = refused ? '' : raw;   // a refused name: the result counts, unnamed
  if (!dateOk(date)) return json({ error: 'date (YYYY-MM-DD, today) wanted' }, 400, h);
  if (!(typeof p === 'number' && p >= 0 && p <= 1)) return json({ error: 'p (0-1) wanted' }, 400, h);
  if (!spots || spots.length < 1 || spots.length > 3 || !spots.every((w) => typeof w === 'number' && w >= -1 && w <= 1)) return json({ error: 'spots (1-3, each -1 to 1) wanted' }, 400, h);
  if (!KEY_RE.test(devKey)) return json({ error: 'key (16-128 letters, digits, - or _) wanted' }, 400, h);
  const kh = await sha256(devKey);                 // before the reads: from here to the writes is storage only
  const ak = name ? await acctNameKey(storage, env, body.session, name.toLowerCase()) : null, nk = ak || kh;    // who owns the name: the account (its username), else this device
  const mine = `dk:${date}:${kh}`;
  const day = (await storage.get(`day:${date}`)) || emptyDay();
  const prev = await storage.get(mine);
  let taken = false, unclaimed = false;
  if (name && !(prev && prev.name)) {
    let owner = await ownerOf(storage, name.toLowerCase());
    if (ak && owner !== ak) { await claim(storage, name.toLowerCase(), ak); owner = ak; }
    taken = !!(owner && owner !== nk);
    unclaimed = !owner;
  }
  if (prev) {           // the day's first result stands; a name given afterwards puts that result on the list
    if (name && !prev.name && !taken) {
      prev.name = name;
      day.top.push({ name, p: prev.p, kh: nk });
      day.top.sort((a, b) => b.p - a.p);
      day.top = day.top.slice(0, DAY_TOP);
      await storage.put(mine, prev);
      await storage.put(`day:${date}`, day);
      if (unclaimed) await claim(storage, name.toLowerCase(), nk);
    }
    return json({ ...dayView(day), counted: false, you: { p: prev.p, spots: prev.spots }, ...(taken ? { taken: true } : {}), ...(refused ? { refused: true } : {}),
      ...(prev.madden ? { madden: prev.madden } : {}) }, 200, h);
  }
  const pt = Math.round(p * 100);
  day.n += 1;
  day.hist[pt] += 1;
  spots.forEach((w, i) => { const x = day.spots[i]; x.n += 1; x.sum += w; x.hist[Math.max(0, Math.min(100, Math.round(w * 100) + 50))] += 1; });
  if (name && !taken) {
    day.top.push({ name, p, kh: nk });
    day.top.sort((a, b) => b.p - a.p);
    day.top = day.top.slice(0, DAY_TOP);
  }
  const you = { p, spots };
  const madden = await maddenDraw(env, storage, kh, date);
  if (madden) {
    const list = (await storage.get('madden:list')) || [];
    list.push({ date, at: new Date().toISOString(), code: madden });
    await storage.put('madden:list', list.slice(-MADDEN_KEEP));
  }
  await storage.put(mine, { ...you, ...(name && !taken ? { name } : {}), ...(madden ? { madden } : {}) });
  await storage.put(`day:${date}`, day);
  if (unclaimed && name) await claim(storage, name.toLowerCase(), nk);
  return json({ ...dayView(day), counted: true, you, ...(taken ? { taken: true } : {}), ...(refused ? { refused: true } : {}), ...(madden ? { madden } : {}) }, 200, h);
}

// ---- Pro
const proOn = (env) => !!env.STRIPE_SECRET;
// a test-mode key (sk_test_/rk_test_) only ever pays from somewhere other than the site itself (the Pro preview):
// the site with a test key would send real buyers to a page that takes no real card
const testKey = (env) => /^(sk|rk)_test_/.test(String(env.STRIPE_SECRET || ''));
const isSite = (env, origin) => { const s = String(env.SITE || 'https://nfl2mindrill.com').replace(/\/+$/, ''); return origin === s || origin === s.replace('://', '://www.'); };
function proCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b, (x) => PRO_ALPHABET[x % PRO_ALPHABET.length]).join('');     // 256 % 31 = 8: a slight lean, fine for a code
  return `TMD-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
// a code as typed (any case, with or without dashes or the TMD) in its stored form, or null
function normCode(c) {
  let s = String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('TMD')) s = s.slice(3);
  s = s.replace(/[0O]/g, 'O').replace(/O/g, '0').replace(/[1IL]/g, 'I');     // 0/O and 1/I/L are never in a code: a typo of either
  s = s.replace(/0/g, '').replace(/I/g, '');
  return /^[A-Z2-9]{12}$/.test(s) && [...s].every((ch) => PRO_ALPHABET.includes(ch)) ? `TMD-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : null;
}
const stripe = (env, path, form) => fetch(`https://api.stripe.com/v1/${path}`, {
  method: form ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${env.STRIPE_SECRET}`, 'Stripe-Version': STRIPE_VERSION,
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
  body: form ? new URLSearchParams(form) : undefined,
});
const tag = () => 'tmd_pro_' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
// the code for a paid session: the one it already has, else a new one (one code per session, whoever asks first).
// acct: the session's client_reference_id (acctRef: the account the purchase was made from): the new code joins it (unless the
// account has Pro already: then the code stays a plain code, the buyer's to use or give)
async function codeFor(storage, s, acct) {
  const have = await storage.get(`pro:sess:${s}`);
  if (have) return have;
  const code = proCode();
  await storage.put(`pro:code:${code}`, { s, at: new Date().toISOString() });
  await storage.put(`pro:sess:${s}`, code);
  const a = await refAcct(storage, acct);
  if (a) await attachCode(storage, a, code);
  return code;
}
// what Stripe is told about the buyer's account: an opaque reference (never the email address), stored here -> account
async function acctRef(storage, acct) {
  const ref = 'a_' + (await sha256(`ref:${acct}`)).slice(0, 40);
  await storage.put(`auth:ref:${ref}`, acct);
  return ref;
}
async function refAcct(storage, ref) {
  if (typeof ref !== 'string' || !/^a_[0-9a-f]{40}$/.test(ref)) return null;
  const a = await storage.get(`auth:ref:${ref}`);
  return typeof a === 'string' && /^[eg]:/.test(a) ? a : null;
}
// The device (the hash of the site's anonymous device key) joins the code's devices, or is refused when the code is
// already on DEV_MAX others: a shared code stops working for the fourth friend. Seen-at times are kept, written at
// most hourly per device, so a device unseen for DEV_DAYS frees its place (a new phone replaces a lost one).
async function bindDevice(storage, code, devKey) {
  const row = await storage.get(`pro:code:${code}`);
  if (!row) return 'unknown';
  if (!KEY_RE.test(devKey)) return 'key';
  const kh = (await sha256(devKey)).slice(0, 24), now = Date.now(), keep = now - DEV_DAYS * 864e5;
  const dev = Object.fromEntries(Object.entries(row.dev || {}).filter(([, t]) => t >= keep));
  if (!(kh in dev) && Object.keys(dev).length >= DEV_MAX) return 'full';
  if (!(kh in dev) || now - dev[kh] > 36e5) { dev[kh] = now; await storage.put(`pro:code:${code}`, { ...row, dev }); }
  return 'ok';
}
// Until this moment a /restore without a device key (a page from before the cap, cached) is still answered, unbound;
// after it the key is wanted. (KEY_REQUIRED_FROM in the env overrides it, for the tests.)
const keyRequired = (env) => Date.now() >= Date.parse(env.KEY_REQUIRED_FROM || '2026-10-18T06:00:00Z');
const DEV_FULL = `This code is already in use on ${DEV_MAX} devices. Pro works on up to ${DEV_MAX} at once; a device unused for ${DEV_DAYS} days frees its place.`;
// Stripe's signature on a webhook: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>"> with the endpoint's signing secret
async function signedByStripe(req, body, secret) {
  const sig = req.headers.get('Stripe-Signature') || '';
  const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=')).filter((kv) => kv.length === 2));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > WEBHOOK_TOLERANCE || !parts.v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))), (b) => b.toString(16).padStart(2, '0')).join('');
  return sig.split(',').some((kv) => kv.startsWith('v1=') && same(kv.slice(3), mac));
}

// ---- Accounts: Pro on an account (Sign in with Google, or a sign-in link by email), so it works on any device signed
// in, and a lost code is no loss. Codes keep working as before for anyone who never signs in.
//   GET  /auth                          -> { google, email }      which ways to sign in are set up
//   POST /auth/google  { credential }   -> { session, email, pro, code? }   a Google Identity Services ID token, checked
//                                          here (RS256 against Google's keys, aud = GOOGLE_CLIENT_ID, iss, exp,
//                                          email_verified); the account is g:<sub>. Off (503) without GOOGLE_CLIENT_ID.
//   POST /auth/email   { email }        -> { ok }                 a one-use sign-in link (15 minutes) mailed by Resend to
//                                          SITE/?login=<token> (the same answer whoever the address is); at most
//                                          MAIL_MAX a MAIL_WINDOW per address and per IP. Off (503) without RESEND_KEY
//                                          and MAIL_FROM. The account is e:<the address, lowercased>.
//   POST /auth/email/verify { token }   -> { session, email, pro, code? }   the link's token, used up
//   POST /auth/me      { session }      -> { email, name, pro, code? }  (401: signed out)
//   POST /auth/name    { session, name } -> { email, name, pro, code? }  the account's username, shown in the page's top
//                                          bar: 3-20 letters, digits, spaces, _ - . or ', one account each (any case),
//                                          never a blocked() one
//   POST /auth/logout  { session }      -> { ok }
//   POST /auth/link    { session, code, key } -> { email, pro, code }   a valid Pro code (on this device: the device
//                                          limit applies) joins the account; a code belongs to one account only
//   POST /auth/stats   { session, stats? } -> { stats: { days, drives, runs } }   the page's record (its stats days, the
//                                          historic drives, the playoff runs) merged into the account's, the best of
//                                          each kept (statsMerge), and the merged record back; without stats, a read
//   POST /auth/remind  { session, on }  -> the account, { remind }   the daily email (Resend; off: 503 without it)
//   POST /auth/unsub?r=&t=  (or { r, t }) -> { ok }               the email's unsubscribe link (one click, no sign-in):
//                                          r the account's opaque reference, t its HMAC (mailSecret); a mail app's
//                                          one-click (RFC 8058, List-Unsubscribe-Post) lands here too
// The account (acctView) also carries its leagues ([{ code, name, n }], when in any) and remind (when on).
// Sessions are 32 random bytes (hex) the page keeps; only their SHA-256 is stored (auth:sess:<hash> -> { acct, at }),
// for SESS_DAYS. An account is acct:<id> -> { email, code?, at }; its code's row carries acct. /pay with a session
// sends an opaque reference to the account to Stripe (client_reference_id, acctRef: never the address), and the code
// minted for that purchase joins the account. /restore,
// /pro/data and /race/* take { session } in place of { code, key }: the account's code, without the device limit (the
// account is its own protection; the code is the same, so the Gauntlet entry is the same).
const AUTH_PATHS = ['/auth', '/auth/google', '/auth/email', '/auth/email/verify', '/auth/me', '/auth/logout', '/auth/link', '/auth/name',
  '/auth/stats', '/auth/remind', '/auth/unsub'];
const UNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.'-]{1,18})[A-Za-z0-9.]$/;
// a session lasts SESS_DAYS; a link LOGIN_MS; an address is at most 198 characters (e:<address> fits Stripe's
// 200-character client_reference_id)
const SESS_DAYS = 180, LOGIN_MS = 15 * 60e3, MAIL_MAX = 3, MAIL_WINDOW = 15 * 60e3;
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs', GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const TOKEN_RE = /^[0-9a-f]{64}$/, EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const googleOn = (env) => !!env.GOOGLE_CLIENT_ID;
const emailOn = (env) => !!(env.RESEND_KEY && env.MAIL_FROM);
const authOn = (env) => googleOn(env) || emailOn(env);
const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
// Google's signing keys, by kid, kept as long as Google's Cache-Control says (an unknown kid asks again, once a minute at most)
const GKEYS = { at: 0, until: 0, keys: new Map() };
async function googleKey(kid) {
  const now = Date.now();
  if ((now > GKEYS.until || !GKEYS.keys.has(kid)) && now - GKEYS.at > 60e3) {
    GKEYS.at = now;
    const r = await fetch(GOOGLE_CERTS);
    if (r.ok) {
      const d = await r.json(), keys = new Map();
      for (const k of (d && d.keys) || []) {
        if (k.kty !== 'RSA' || !k.kid || !k.n || !k.e) continue;
        try { keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])); } catch (e) { /* a key we can't use */ }
      }
      const age = Number(((r.headers.get('Cache-Control') || '').match(/max-age=(\d+)/) || [])[1] || 3600);
      if (keys.size) { GKEYS.keys = keys; GKEYS.until = now + Math.min(age, 86400) * 1000; }
    }
  }
  return GKEYS.keys.get(kid) || null;
}
// a Google ID token's claims when it is genuine, for this site, current and of a verified address; else null
async function verifyGoogle(cred, env) {
  const jwt = String(cred || ''), parts = jwt.split('.');
  if (parts.length !== 3 || jwt.length > 4096) return null;
  let head, claims;
  try { head = b64json(parts[0]); claims = b64json(parts[1]); } catch (e) { return null; }
  if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
  const key = await googleKey(head.kid);
  if (!key) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)); } catch (e) { ok = false; }
  if (!ok || !claims) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !GOOGLE_ISS.includes(claims.iss)) return null;
  if (!(Number(claims.exp) * 1000 > Date.now())) return null;
  if (!(claims.email_verified === true || claims.email_verified === 'true')) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') return null;
  return claims;
}
// a session's account id, or null (an unknown, expired or malformed session; any while accounts are off)
async function sessionAcct(storage, env, session) {
  const tok = String(session || '');
  if (!authOn(env) || !TOKEN_RE.test(tok)) return null;
  const k = `auth:sess:${await sha256(tok)}`, s = await storage.get(k);
  if (!s) return null;
  if (Date.now() - s.at > SESS_DAYS * 864e5) { await storage.delete(k); return null; }
  return s.acct;
}
// the claim key of a name that is the signed-in account's own username, else null: one key an account (never a
// device's), so the account's posts own the name on any phone
async function acctNameKey(storage, env, session, lower) {
  if (!session) return null;
  const acct = await sessionAcct(storage, env, session), a = acct && await storage.get(`acct:${acct}`);
  return a && a.name && a.name.toLowerCase() === lower ? sha256(`acct:${acct}`) : null;
}
async function newSession(storage, acct, email) {
  const a = (await storage.get(`acct:${acct}`)) || { at: new Date().toISOString() };
  if (a.email !== email) { a.email = email; await storage.put(`acct:${acct}`, a); }
  const tok = randHex(32);
  await storage.put(`auth:sess:${await sha256(tok)}`, { acct, at: Date.now() });
  return { session: tok, ...(await acctView(storage, acct)) };
}
// what the page is told about its own account (never anyone else's)
async function acctView(storage, acct) {
  const a = (await storage.get(`acct:${acct}`)) || {};
  const pro = !!(a.code && await storage.get(`pro:code:${a.code}`)), leagues = await leaguesOf(storage, a), rm = await storage.get(`rmd:${acct}`);
  return { email: a.email || '', name: a.name || '', pro, ...(pro ? { code: a.code } : {}), ...(leagues.length ? { leagues } : {}), ...(rm && rm.on ? { remind: true } : {}) };
}
// a code joins an account: refused when it belongs to another account, or the account has another code
async function attachCode(storage, acct, code) {
  const row = await storage.get(`pro:code:${code}`), a = await storage.get(`acct:${acct}`);
  if (!row || !a) return 'unknown';
  if (row.acct && row.acct !== acct) return 'taken';
  if (a.code && a.code !== code && await storage.get(`pro:code:${a.code}`)) return 'has';
  if (row.acct !== acct) await storage.put(`pro:code:${code}`, { ...row, acct });
  if (a.code !== code) await storage.put(`acct:${acct}`, { ...a, code });
  return 'ok';
}
// at most MAIL_MAX in MAIL_WINDOW for one key (kept in storage, so the limit holds across restarts)
async function mailLimited(storage, key) {
  const now = Date.now(), k = `auth:rl:${key}`, hitsAt = ((await storage.get(k)) || []).filter((t) => now - t < MAIL_WINDOW);
  if (hitsAt.length >= MAIL_MAX) return true;
  hitsAt.push(now);
  await storage.put(k, hitsAt);
  return false;
}
const siteFor = (req, env) => {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean), origin = req.headers.get('Origin') || '';
  return String(allowed.includes(origin) && origin !== '*' ? origin : env.SITE || 'https://nfl2mindrill.com').replace(/\/+$/, '');
};
async function auth(req, env, storage, hits, h, url) {
  if (url.pathname === '/auth') return req.method === 'GET' ? json({ google: googleOn(env), email: emailOn(env) }, 200, h) : json({ error: 'method' }, 405, h);
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  const p = url.pathname;
  if (p === '/auth/unsub') return unsub(req, env, storage, h, url);       // from an email: no session, no rate limit (an HMAC)
  if (p === '/auth/google' ? !googleOn(env) : p.startsWith('/auth/email') || p === '/auth/remind' ? !emailOn(env) : !authOn(env)) return json({ error: 'sign-in is not set up' }, 503, h);
  if (p !== '/auth/me' && limited(req, hits)) return json({ error: 'slow down' }, 429, h);
  const body = await readBody(req);
  if (body === null) return json({ error: 'bad json' }, 400, h);
  if (body === false) return json({ error: 'too big' }, 413, h);
  if (p === '/auth/google') {
    const c = await verifyGoogle(body.credential, env);
    if (!c) return json({ error: 'that Google sign-in could not be checked' }, 401, h);
    return json(await newSession(storage, `g:${c.sub}`, String(c.email).toLowerCase()), 200, h);
  }
  if (p === '/auth/email') {
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 198 || !EMAIL_RE.test(email)) return json({ error: 'that does not look like an email address' }, 400, h);
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    if (await mailLimited(storage, `ip:${await sha256(ip)}`) || await mailLimited(storage, `em:${await sha256(email)}`)) return json({ error: 'Too many sign-in emails. Try again in 15 minutes.' }, 429, h);
    const tok = randHex(32), link = `${siteFor(req, env)}/?login=${tok}`;
    await storage.put(`auth:login:${await sha256(tok)}`, { email, exp: Date.now() + LOGIN_MS });
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Your Two-Minute Drill sign-in link',
          text: `Sign in to Two-Minute Drill:\n\n${link}\n\nThe link works once, for 15 minutes. If you didn't ask for it, ignore this email.`,
          html: `<p>Sign in to Two-Minute Drill:</p><p><a href="${link}">Sign in</a></p><p>The link works once, for 15 minutes. If you didn't ask for it, ignore this email.</p>` }) });
    } catch (e) { r = null; }
    if (!r || !r.ok) { console.error('resend refused the email', r ? r.status : 'unreachable'); return json({ error: 'the email could not be sent; try again' }, 502, h); }
    return json({ ok: true }, 200, h);
  }
  if (p === '/auth/email/verify') {
    const tok = String(body.token || '');
    if (!TOKEN_RE.test(tok)) return json({ error: 'that sign-in link is not valid' }, 400, h);
    const k = `auth:login:${await sha256(tok)}`, row = await storage.get(k);
    if (row) await storage.delete(k);                           // one use, whatever happens next
    if (!row || Date.now() > row.exp) return json({ error: 'that sign-in link has expired or was used already: ask for a new one' }, 401, h);
    return json(await newSession(storage, `e:${row.email}`, row.email), 200, h);
  }
  const acct = await sessionAcct(storage, env, body.session);
  if (p === '/auth/logout') {
    if (TOKEN_RE.test(String(body.session || ''))) await storage.delete(`auth:sess:${await sha256(String(body.session))}`);
    return json({ ok: true }, 200, h);
  }
  if (!acct) return json({ error: 'signed out', signedOut: true }, 401, h);
  if (p === '/auth/me') return json(await acctView(storage, acct), 200, h);
  if (p === '/auth/name') {
    const name = clean(body.name);
    if (!UNAME_RE.test(name)) return json({ error: 'A username is 3-20 letters or digits (spaces, _ - . and \' inside are fine).' }, 400, h);
    if (blocked(name)) return json({ error: 'That username is not allowed. Pick another.', refused: true }, 409, h);
    const a = await storage.get(`acct:${acct}`);
    if (!a) return json({ error: 'signed out', signedOut: true }, 401, h);
    const lower = name.toLowerCase(), old = a.name ? a.name.toLowerCase() : '';
    if (lower !== old) {
      const owner = await storage.get(`auth:name:${lower}`);
      if (owner && owner !== acct) return json({ error: 'That username is taken. Pick another.', taken: true }, 409, h);
      await storage.put(`auth:name:${lower}`, acct);
      if (old) await storage.delete(`auth:name:${old}`);
    }
    await storage.put(`acct:${acct}`, { ...a, name });
    return json(await acctView(storage, acct), 200, h);
  }
  if (p === '/auth/stats') {
    const have = await statsOf(storage, acct);
    if (body.stats === undefined) return json({ stats: have }, 200, h);
    const inc = cleanStats(body.stats);
    if (typeof inc === 'string') return json({ error: inc }, 400, h);
    const merged = statsMerge(have, inc);
    if (JSON.stringify(merged.days) !== JSON.stringify(have.days)) await storage.put(`stats:d:${acct}`, merged.days);
    if (JSON.stringify([merged.drives, merged.runs]) !== JSON.stringify([have.drives, have.runs])) await storage.put(`stats:x:${acct}`, { drives: merged.drives, runs: merged.runs });
    return json({ stats: merged }, 200, h);
  }
  if (p === '/auth/remind') {
    const k = `rmd:${acct}`, was = (await storage.get(k)) || {};
    await storage.put(k, { ...was, on: body.on === true, at: Date.now() });     // (off keeps the day last sent: on again that day sends nothing more)
    return json(await acctView(storage, acct), 200, h);
  }
  if (p === '/auth/link') {
    const code = normCode(body.code);
    if (!code) return json({ error: 'a code looks like TMD-XXXX-XXXX-XXXX' }, 400, h);
    const owner = ((await storage.get(`pro:code:${code}`)) || {}).acct;          // (before it takes a device's place)
    if (owner && owner !== acct) return json({ error: 'This Pro code belongs to another account.' }, 409, h);
    const st = await bindDevice(storage, code, String(body.key || ''));
    if (st === 'key') return json({ error: 'key (16-128 letters, digits, - or _) wanted' }, 400, h);
    if (st === 'unknown') return json({ error: 'unknown code' }, 404, h);
    if (st === 'full') return json({ error: DEV_FULL }, 409, h);
    const at = await attachCode(storage, acct, code);
    if (at === 'taken') return json({ error: 'This Pro code belongs to another account.' }, 409, h);
    if (at === 'has') return json({ error: 'This account already has Pro.' }, 409, h);
    if (at !== 'ok') return json({ error: 'unknown code' }, 404, h);
    return json(await acctView(storage, acct), 200, h);
  }
  return json({ error: 'not found' }, 404, h);
}
// Pro by a session (the account's code; no device limit) or by a code on a device (the device limit, as ever):
// { code } or { status, error }
async function proAccess(storage, env, body, needCode = 'a valid Pro code is needed') {
  if (body && body.session) {
    const acct = await sessionAcct(storage, env, body.session);
    if (!acct) return { status: 401, error: 'signed out', signedOut: true };
    const a = await storage.get(`acct:${acct}`);
    if (!(a && a.code && await storage.get(`pro:code:${a.code}`))) return { status: 403, error: 'this account has no Pro', noPro: true };
    return { code: a.code };
  }
  const code = normCode(body && body.code);
  if (!code) return { status: 403, error: needCode };
  const st = await bindDevice(storage, code, String((body && body.key) || ''));
  if (st === 'key') return { status: 400, error: 'key (16-128 letters, digits, - or _) wanted' };
  if (st === 'unknown') return { status: 403, error: needCode };
  if (st === 'full') return { status: 409, error: DEV_FULL };
  return { code };
}
const refusal = (x, h) => json({ error: x.error, ...(x.signedOut ? { signedOut: true } : {}), ...(x.noPro ? { noPro: true } : {}) }, x.status, h);

// a request's JSON body: the object ({} for anything else), null when it is not JSON, false when over BODY_MAX
const BODY_MAX = 512 * 1024;
async function readBody(req) {
  const raw = await req.text().catch(() => '');
  if (raw.length > BODY_MAX) return false;
  let b;
  try { b = JSON.parse(raw); } catch (e) { return null; }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

// ---- Stats that follow the account (/auth/stats): the page keeps its record in the browser (game.js: the stats days,
// the historic drives, the playoff runs); signed in, it is merged into the account's and back, so a streak and the
// drives passed survive a new phone. Kept as stats:d:<acct> (the days: what a league board reads) and stats:x:<acct>
// (drives and runs). Each entry is checked and rebuilt from its numbers (nothing else of a post is kept); a kind with
// more entries than its cap, or not an object, refuses the post. Merged, the higher score of each day, drive or run
// stands (a drive: the most tries, won if either was; a day: a Madden find kept from either); over a cap, the newest.
const STATS_CAP = { days: [99999, 2000], drives: [999, 500], runs: [999, 500] };      // [highest key, most entries]
const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
function statEntry(kind, v) {
  if (!v || typeof v !== 'object') return null;
  const p = num(v.p, 0, 1), wpa = num(v.wpa, -10, 10) ?? 0;
  if (p === null) return null;
  if (kind === 'days') {
    const coach = typeof v.coach === 'string' ? clean(v.coach, 40) : '', madden = typeof v.madden === 'string' && /^[0-9A-F]{8}$/.test(v.madden) ? v.madden : null;
    return { p, wpa, coach: coach || null, ...(madden ? { madden } : {}) };
  }
  if (kind === 'drives') {
    const last = num(v.last, 0, 1), at = num(v.at, 0, 1e14);
    return { p, wpa, tries: Math.round(num(v.tries, 0, 1e5) ?? 1), won: v.won === true, ...(last !== null ? { last } : {}), ...(at !== null ? { at } : {}) };
  }
  const n = (x) => Math.round(num(x, 0, 99) ?? 0);
  return { p, wpa, w: n(v.w), l: n(v.l), n: n(v.n) };
}
// a posted record, cleaned: { days, drives, runs }, or the reason it is refused
function cleanStats(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'stats: { days, drives, runs } wanted';
  const out = {};
  for (const [kind, [hi, max]] of Object.entries(STATS_CAP)) {
    const o = s[kind] ?? {};
    if (typeof o !== 'object' || Array.isArray(o)) return `stats.${kind}: an object wanted`;
    const ks = Object.keys(o);
    if (ks.length > max) return `stats.${kind}: at most ${max}`;
    out[kind] = {};
    for (const k of ks) {
      if (!/^[1-9]\d{0,4}$/.test(k) || +k > hi) continue;
      const e = statEntry(kind, o[k]);
      if (e) out[kind][k] = e;
    }
  }
  return out;
}
function statBetter(kind, a, b) {
  if (!a || !b) return a || b;
  const w = b.p > a.p ? b : a;
  if (kind === 'drives') return { ...w, tries: Math.max(a.tries || 0, b.tries || 0), won: !!(a.won || b.won) };
  if (kind === 'days' && !w.madden && (a.madden || b.madden)) return { ...w, coach: 'John Madden', madden: a.madden || b.madden };
  return w;
}
function statsMerge(a, b) {
  const out = {};
  for (const [kind, [, max]] of Object.entries(STATS_CAP)) {
    const m = { ...a[kind] };
    for (const [k, v] of Object.entries(b[kind] || {})) m[k] = statBetter(kind, m[k], v);
    const ks = Object.keys(m).map(Number).sort((x, y) => x - y).slice(-max);
    out[kind] = Object.fromEntries(ks.map((k) => [k, m[k]]));
  }
  return out;
}
async function statsOf(storage, acct) {
  const x = (await storage.get(`stats:x:${acct}`)) || {};
  return { days: (await storage.get(`stats:d:${acct}`)) || {}, drives: x.drives || {}, runs: x.runs || {} };
}

// ---- Friend leagues: a private group of accounts (a name and a join link) with its own board of the daily: each
// member's username, the day's score, the streak and the last 7 days' average (from the stats above). Only usernames
// and those numbers are shown, to members only; never an address or an account id.
//   POST /league/create { session, name }      -> { league, leagues }   3-30 characters, never a blocked() name
//   POST /league/peek   { code }               -> { code, name, n }     what a join link shows before joining
//   POST /league/join   { session, code }      -> { league, leagues }   at most LEAGUE_MAX members
//   POST /league/leave  { session, code }      -> { leagues }           the last one out ends the league
//   POST /league/board  { session, code, day } -> { code, name, n, day, owner, rows: [{ name, today, streak, avg7, n7, you? }] }
// A league is league:<code> { name, owner, members: [acct], at }; an account's leagues are on its row (acct.leagues,
// at most LEAGUES_PER). Joining (or making one) takes a username: the board shows it. day is the page's day number
// (game.js dayOf): the board is that day's.
const LEAGUE_PATHS = ['/league/create', '/league/peek', '/league/join', '/league/leave', '/league/board'];
const LEAGUE_MAX = 50, LEAGUES_PER = 10, LEAGUE_LEN = 8;     // 31^8 codes (no 0/O, 1/I/L), guessed at RATE_PER_MIN an address
const leagueCode = () => Array.from(crypto.getRandomValues(new Uint8Array(LEAGUE_LEN)), (x) => PRO_ALPHABET[x % PRO_ALPHABET.length]).join('');
const normLeague = (c) => { const s = String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === LEAGUE_LEN && [...s].every((ch) => PRO_ALPHABET.includes(ch)) ? s : null; };
async function leaguesOf(storage, a) {
  const out = [];
  for (const code of (a && Array.isArray(a.leagues) ? a.leagues : [])) {
    const lg = await storage.get(`league:${code}`);
    if (lg) out.push({ code, name: lg.name, n: lg.members.length });
  }
  return out;
}
// one member's line: the day's score (null: not played yet), the streak (days in a row to the day, or to the day
// before while the day is not played yet: a streak still alive) and the average of the days played in the last 7
function leagueLine(days, day) {
  const p = (k) => (days[k] && typeof days[k].p === 'number' ? days[k].p : null);
  let streak = 0;
  for (let k = p(day) !== null ? day : day - 1; k > 0 && p(k) !== null; k--) streak++;
  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => p(day - i)).filter((x) => x !== null);
  return { today: p(day), streak, avg7: week.length ? week.reduce((a, x) => a + x, 0) / week.length : null, n7: week.length };
}
async function league(req, env, storage, hits, h, url) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  if (!authOn(env)) return json({ error: 'sign-in is not set up' }, 503, h);
  const p = url.pathname;
  if (p !== '/league/board' && limited(req, hits)) return json({ error: 'slow down' }, 429, h);
  const body = await readBody(req);
  if (!body) return json({ error: 'bad json' }, 400, h);
  const code = p === '/league/create' ? null : normLeague(body.code);
  if (p !== '/league/create' && !code) return json({ error: 'a league code is 8 letters and digits' }, 400, h);
  const lg = code && await storage.get(`league:${code}`);
  if (p === '/league/peek') return lg ? json({ code, name: lg.name, n: lg.members.length }, 200, h) : json({ error: 'no such league' }, 404, h);
  const acct = await sessionAcct(storage, env, body.session), a = acct && await storage.get(`acct:${acct}`);
  if (!a) return json({ error: 'signed out', signedOut: true }, 401, h);
  const mine = Array.isArray(a.leagues) ? a.leagues : [];
  const done = async (lgCode) => json({ ...(lgCode ? { league: { code: lgCode, ...(({ name, members, owner }) => ({ name, n: members.length, owner: owner === acct }))(await storage.get(`league:${lgCode}`)) } } : {}),
    leagues: await leaguesOf(storage, await storage.get(`acct:${acct}`)) }, 200, h);
  if (p === '/league/create' || p === '/league/join') {
    if (p === '/league/join' && !lg) return json({ error: 'That league does not exist (any more).' }, 404, h);
    if (lg && lg.members.includes(acct)) return done(code);                       // in it already
    if (!a.name) return json({ error: 'Pick a username first: the league board shows it.', noName: true }, 409, h);
    if (mine.length >= LEAGUES_PER) return json({ error: `You are in ${LEAGUES_PER} leagues already: leave one first.` }, 409, h);
    let c = code;
    if (p === '/league/create') {
      const name = clean(body.name, 31);
      if (name.length < 3 || name.length > 30) return json({ error: 'A league name is 3 to 30 characters.' }, 400, h);
      if (blocked(name)) return json({ error: 'That league name is not allowed. Pick another.', refused: true }, 409, h);
      do c = leagueCode(); while (await storage.get(`league:${c}`));
      await storage.put(`league:${c}`, { name, owner: acct, members: [acct], at: Date.now() });
    } else {
      if (lg.members.length >= LEAGUE_MAX) return json({ error: `That league is full (${LEAGUE_MAX} players).`, full: true }, 409, h);
      await storage.put(`league:${c}`, { ...lg, members: [...lg.members, acct] });
    }
    await storage.put(`acct:${acct}`, { ...a, leagues: [...mine.filter((x) => x !== c), c] });
    return done(c);
  }
  if (p === '/league/leave') {
    if (lg && lg.members.includes(acct)) {
      const members = lg.members.filter((x) => x !== acct);
      if (members.length) await storage.put(`league:${code}`, { ...lg, members, owner: lg.owner === acct ? members[0] : lg.owner });
      else await storage.delete(`league:${code}`);
    }
    if (mine.includes(code)) await storage.put(`acct:${acct}`, { ...a, leagues: mine.filter((x) => x !== code) });
    return done(null);
  }
  if (p === '/league/board') {
    if (!lg || !lg.members.includes(acct)) return json({ error: 'no such league' }, 404, h);     // (a member's only: the same answer as none)
    const day = Number(body.day);
    if (!Number.isInteger(day) || day < 1 || day > STATS_CAP.days[0]) return json({ error: 'day (the day number) wanted' }, 400, h);
    const rows = [];
    for (const m of lg.members) {
      const ma = (await storage.get(`acct:${m}`)) || {};
      rows.push({ name: ma.name || 'Player', ...leagueLine((await storage.get(`stats:d:${m}`)) || {}, day), ...(m === acct ? { you: true } : {}) });
    }
    // the day's scores first, best first; then who has not played yet, longest streak first
    rows.sort((x, y) => (y.today ?? -1) - (x.today ?? -1) || y.streak - x.streak || x.name.localeCompare(y.name));
    return json({ code, name: lg.name, n: lg.members.length, day, owner: lg.owner === acct, rows }, 200, h);
  }
  return json({ error: 'not found' }, 404, h);
}

// ---- The daily email (opt-in, /auth/remind): once a day, when the new daily is up, a short note to every account
// that asked, by Resend (only with RESEND_KEY and MAIL_FROM). The cron trigger (wrangler.toml [triggers]) wakes the
// worker; `scheduled` hands the run to the Board (its storage), at most REMIND_CAP emails a run in batches of
// REMIND_BATCH (Resend's batch call; its Idempotency-Key means a retried batch is not sent twice). Each account's last
// day sent (rmd:<acct>.last, the UTC date) keeps it to one a day: the cron runs three times a morning, so a batch Resend
// refused (logged) goes again in the next. Every email carries its unsubscribe link: the site's ?unsub=<ref>.<hmac>
// (the page posts it to /auth/unsub), and, with API_URL (this worker's own address) set, the one-click header too.
const REMIND_CAP = 1000, REMIND_BATCH = 100, CRON_PATH = '/_cron/remind';     // (no outside request reaches CRON_PATH: the default fetch never routes it here)
// the key behind the unsubscribe links: env.MAIL_SECRET, else one made at random on first use and kept in storage
async function mailSecret(env, storage) {
  if (env.MAIL_SECRET) return String(env.MAIL_SECRET);
  let s = await storage.get('mail:secret');
  if (!s) { s = randHex(32); await storage.put('mail:secret', s); }
  return s;
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, '0')).join('');
}
const unsubTok = async (env, storage, ref) => (await hmacHex(await mailSecret(env, storage), `unsub:${ref}`)).slice(0, 32);
async function unsub(req, env, storage, h, url) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  let r = url.searchParams.get('r') || '', t = url.searchParams.get('t') || '';
  if (!r) { const b = (await readBody(req)) || {}; r = String(b.r || ''); t = String(b.t || ''); }       // (one-click posts a form, the page JSON)
  if (!/^a_[0-9a-f]{40}$/.test(r) || !/^[0-9a-f]{32}$/.test(t)) return json({ error: 'that unsubscribe link is not valid' }, 400, h);
  const acct = await refAcct(storage, r);
  if (!acct || !same(t, await unsubTok(env, storage, r))) return json({ error: 'that unsubscribe link is not valid' }, 403, h);
  const k = `rmd:${acct}`, was = await storage.get(k);
  if (was && was.on) await storage.put(k, { ...was, on: false, at: Date.now() });
  return json({ ok: true }, 200, h);
}
async function reminders(env, storage, date) {
  if (!emailOn(env)) return { off: true, sent: 0 };
  if (!DATE_RE.test(date)) return { error: 'date', sent: 0 };
  const due = [];
  for (const [k, r] of await storage.list({ prefix: 'rmd:' })) {
    if (r && r.on && r.last !== date) due.push(k.slice(4));
    if (due.length >= REMIND_CAP) break;
  }
  const site = String(env.SITE || 'https://nfl2mindrill.com').replace(/\/+$/, ''), api = String(env.API_URL || '').replace(/\/+$/, '');
  let sent = 0, failed = 0;
  for (let i = 0; i < due.length; i += REMIND_BATCH) {
    const batch = [];
    for (const acct of due.slice(i, i + REMIND_BATCH)) {
      const a = await storage.get(`acct:${acct}`);
      if (!a || !EMAIL_RE.test(String(a.email || ''))) continue;
      const ref = await acctRef(storage, acct), t = await unsubTok(env, storage, ref), stop = `${site}/?unsub=${ref}.${t}`;
      batch.push({ acct, mail: { from: env.MAIL_FROM, to: [a.email], subject: 'The new Two-Minute Drill is up',
        text: `Today's drive is up: a real NFL late-game spot, your calls against the clock.\n\nPlay: ${site}/\n\nYou asked for this email on your Two-Minute Drill account. Stop it: ${stop}`,
        html: `<p>Today's drive is up: a real NFL late-game spot, your calls against the clock.</p><p><a href="${site}/">Play today's drive</a></p><p style="color:#5a675e;font-size:13px">You asked for this email on your Two-Minute Drill account. <a href="${stop}">Unsubscribe</a></p>`,
        ...(api ? { headers: { 'List-Unsubscribe': `<${api}/auth/unsub?r=${ref}&t=${t}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) } });
    }
    if (!batch.length) continue;
    let r;
    try {
      r = await fetch('https://api.resend.com/emails/batch', { method: 'POST', body: JSON.stringify(batch.map((x) => x.mail)),
        headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `remind-${date}-${(await sha256(batch.map((x) => x.acct).join('\n'))).slice(0, 24)}` } });
    } catch (e) { r = null; }
    if (!r || !r.ok) { failed += batch.length; console.error('resend refused the daily reminders', r ? r.status : 'unreachable', batch.length); continue; }
    for (const { acct } of batch) { const k = `rmd:${acct}`, cur = await storage.get(k); if (cur) await storage.put(k, { ...cur, last: date }); }   // (read again: a toggle made while sending stands)
    sent += batch.length;
  }
  return { sent, failed, due: due.length };
}


async function pro(req, env, storage, hits, h, url) {
  if (url.pathname === '/pro') return req.method === 'GET' ? json({ on: proOn(env), price: PRO_PRICE }, 200, h) : json({ error: 'method' }, 405, h);
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  if (url.pathname === '/stripe-webhook') {              // from Stripe, not the page: signed, never rate limited
    if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhooks are not set up' }, 503, h);
    const raw = await req.text();
    if (!(await signedByStripe(req, raw, env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 400, h);
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, 400, h); }
    const sess = ev && ev.data && ev.data.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev && ev.type) && sess && SESSION_RE.test(String(sess.id || ''))
        && sess.payment_status && sess.payment_status !== 'unpaid') await codeFor(storage, sess.id, sess.client_reference_id);
    return json({ received: true }, 200, h);
  }
  if (!proOn(env)) return json({ error: 'payments are not set up yet' }, 503, h);
  if (limited(req, hits)) return json({ error: 'slow down' }, 429, h);
  let body = {};
  if (url.pathname !== '/pay') {
    try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  } else body = await req.json().catch(() => ({}));
  body = body && typeof body === 'object' ? body : {};
  if (url.pathname === '/pay') {
    // signed in: the purchase is the account's (Stripe hands the account back with the paid session)
    const acct = body.session ? await sessionAcct(storage, env, body.session) : null;
    if (body.session && !acct) return json({ error: 'Your sign-in has expired: sign in again (or sign out to buy with a code).', signedOut: true }, 401, h);
    // the buyer goes back to the site he came from (an allowed origin: the site, or the Pro preview), else SITE
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean), origin = req.headers.get('Origin') || '';
    const site = String(allowed.includes(origin) ? origin : env.SITE || 'https://nfl2mindrill.com').replace(/\/+$/, '');
    if (testKey(env) && (isSite(env, origin) || !allowed.includes(origin))) return json({ error: 'payments are not set up yet (test key)' }, 503, h);
    let r;
    try {
      // the line: a price id as is; a product id, or nothing, charged PRO_CENTS (with nothing set, the product is
      // described here, so a live launch needs no product in the catalog)
      const price = String(env.STRIPE_PRICE || '').trim();
      const item = price.startsWith('price_') ? { 'line_items[0][price]': price }
        : { 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(PRO_CENTS),
          ...(price.startsWith('prod_') ? { 'line_items[0][price_data][product]': price }
            : { 'line_items[0][price_data][product_data][name]': 'Two-Minute Drill Pro', 'line_items[0][price_data][product_data][tax_code]': PRO_TAX_CODE,
              'line_items[0][price_data][product_data][description]': 'Every past daily, the historic drives and the playoff runs. One code, any device.' }) };
      r = await stripe(env, 'checkout/sessions', { mode: 'payment', ...item, 'line_items[0][quantity]': '1', allow_promotion_codes: 'true',
        success_url: `${site}/?claim={CHECKOUT_SESSION_ID}`, cancel_url: `${site}/?pro=cancel`, integration_identifier: tag(),
        ...(acct ? { client_reference_id: await acctRef(storage, acct) } : {}) });
    } catch (e) { return json({ error: 'stripe unreachable' }, 502, h); }
    const sess = await r.json().catch(() => ({}));
    if (!r.ok || !sess.url) {                               // Stripe's reason, for the buyer's screen and the worker's log
      const why = sess.error && sess.error.message ? String(sess.error.message).slice(0, 200) : '';
      console.error('stripe refused the session', r.status, sess.error ? JSON.stringify(sess.error).slice(0, 600) : '');
      return json({ error: `stripe refused the session${why ? ': ' + why : ''}` }, 502, h);
    }
    return json({ url: sess.url }, 200, h);
  }
  if (url.pathname === '/claim') {
    const s = String(body.s || '');
    if (!SESSION_RE.test(s)) return json({ error: 'session wanted' }, 400, h);
    const have = await storage.get(`pro:sess:${s}`);       // the webhook may have minted it already
    if (have) return json({ code: have }, 200, h);
    let r;
    try { r = await stripe(env, `checkout/sessions/${s}`); } catch (e) { return json({ error: 'stripe unreachable' }, 502, h); }
    const sess = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: 'no such session' }, 404, h);
    if (sess.payment_status === 'unpaid') return json({ error: 'not paid' }, 402, h);     // 'no_payment_required' counts as paid
    const minted = await codeFor(storage, s, sess.client_reference_id);
    if (KEY_RE.test(String(body.key || ''))) await bindDevice(storage, minted, String(body.key));    // the buyer's device is the first
    return json({ code: minted }, 200, h);
  }
  if (url.pathname === '/restore') {
    if (body.session) {                                     // signed in: the account's code
      const x = await proAccess(storage, env, body);
      return x.code ? json({ ok: true, code: x.code }, 200, h) : refusal(x, h);
    }
    const code = normCode(body.code);
    if (!code) return json({ error: 'a code looks like TMD-XXXX-XXXX-XXXX' }, 400, h);
    const st = await bindDevice(storage, code, String(body.key || ''));
    if (st === 'key' && !keyRequired(env)) return (await storage.get(`pro:code:${code}`)) ? json({ ok: true, code }, 200, h) : json({ error: 'unknown code' }, 404, h);
    if (st === 'key') return json({ error: 'key (16-128 letters, digits, - or _) wanted' }, 400, h);
    if (st === 'unknown') return json({ error: 'unknown code' }, 404, h);
    if (st === 'full') return json({ error: DEV_FULL }, 409, h);
    return json({ ok: true, code }, 200, h);
  }
  if (url.pathname === '/pro/gift') {                     // a free code (a prize, a thank-you): Authorization: Bearer <ADMIN_TOKEN>
    const auth = req.headers.get('Authorization') || '', want = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
    if (!want || !same(auth, want)) return json({ error: 'forbidden' }, 403, h);
    let code = proCode();
    while (await storage.get(`pro:code:${code}`)) code = proCode();
    await storage.put(`pro:code:${code}`, { s: 'gift', at: new Date().toISOString().slice(0, 10), note: String(body.note || '').slice(0, 80) });
    return json({ ok: true, code }, 200, h);
  }
  if (url.pathname === '/pro/reset') {                    // support: a code's devices start over (Authorization: Bearer <ADMIN_TOKEN>)
    const auth = req.headers.get('Authorization') || '', want = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
    if (!want || !same(auth, want)) return json({ error: 'forbidden' }, 403, h);
    const code = normCode(body.code), row = code && await storage.get(`pro:code:${code}`);
    if (!row) return json({ error: 'unknown code' }, 404, h);
    delete row.dev;
    await storage.put(`pro:code:${code}`, row);
    return json({ ok: true, code }, 200, h);
  }
  if (url.pathname === '/pro/data') {
    const name = String(body.name || '');
    if (!PRO_FILE_RE.test(name)) return json({ error: 'no such file' }, 404, h);
    const x = await proAccess(storage, env, body);
    if (!x.code) return refusal(x, h);
    if (!env.ASSETS) return json({ error: 'the Pro data is not deployed' }, 503, h);
    const file = await env.ASSETS.fetch(new Request(new URL(`/pro/${name}`, req.url), { method: 'GET' }));
    if (!file.ok) return json({ error: 'no such file' }, 404, h);
    return new Response(file.body, { status: 200, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
  }
  return json({ error: 'not found' }, 404, h);
}

// The board itself: `storage` is the Durable Object's (get/put), `hits` its in-memory per-IP counts.
export async function handle(req, env, storage, hits) {
  const h = cors(req, env), url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (PRO_PATHS.includes(url.pathname)) return pro(req, env, storage, hits, h, url);
  if (AUTH_PATHS.includes(url.pathname)) return auth(req, env, storage, hits, h, url);
  if (LEAGUE_PATHS.includes(url.pathname)) return league(req, env, storage, hits, h, url);
  if (url.pathname === '/race' || url.pathname.startsWith('/race/')) return race(req, env, storage, hits, h, url);
  if (url.pathname === '/daily') return daily(req, env, storage, hits, h, url);
  if (url.pathname === '/days') return req.method === 'GET' ? days(storage, h) : json({ error: 'method' }, 405, h);
  if (url.pathname === '/madden') return req.method === 'GET' ? json({ odds: MADDEN_ODDS, finds: (await storage.get('madden:list')) || [] }, 200, h)
    : json({ error: 'method' }, 405, h);
  if (url.pathname !== '/board') return json({ error: 'not found' }, 404, h);
  const readAll = async () => { const all = await storage.get('runs'); return Array.isArray(all) ? all : []; };
  if (req.method === 'GET') return json({ rows: ranked(await readAll()) }, 200, h);

  if (req.method === 'DELETE') {
    const auth = req.headers.get('Authorization') || '', want = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
    if (!want || !same(auth, want)) return json({ error: 'forbidden' }, 403, h);
    const key = clean(url.searchParams.get('name')).toLowerCase(), all = await readAll();
    const left = all.filter((r) => String(r.name).toLowerCase() !== key);
    if (left.length !== all.length) await storage.put('runs', left);
    return json({ rows: ranked(left), removed: all.length - left.length }, 200, h);
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);

  if (limited(req, hits)) return json({ error: 'slow down' }, 429, h);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  const name = clean(body && body.name), best = Number(body && body.best), devKey = String((body && body.key) || '');
  if (!name || !Number.isInteger(best) || best < 0 || best > 999) return json({ error: 'name (1-24 characters) and best (0-999) wanted' }, 400, h);
  if (blocked(name)) return json({ error: 'name not allowed', refused: true, rows: ranked(await readAll()) }, 409, h);
  if (!KEY_RE.test(devKey)) return json({ error: 'key (16-128 letters, digits, - or _) wanted' }, 400, h);
  const lower = name.toLowerCase(), dk = await sha256(devKey);     // before the read: from here to the write is storage only
  const ak = await acctNameKey(storage, env, body.session, lower), kh = ak || dk;   // a signed-in account's own username: its name on any device
  const all = await readAll(), i = all.findIndex((r) => String(r.name).toLowerCase() === lower);
  let owner = await ownerOf(storage, lower);
  if (ak && owner !== ak) { await claim(storage, lower, ak); owner = ak; }
  if (owner && owner !== kh) return json({ error: 'name taken', rows: ranked(all) }, 409, h);
  if (!owner) await claim(storage, lower, kh);
  if (i >= 0 && all[i].best >= best) {
    if (!all[i].kh) { all[i].kh = kh; await storage.put('runs', all); }       // a row from before names were claimed
    return json({ rows: ranked(all), kept: all[i].best }, 200, h);
  }
  // life: the run used its one extra life (an ad watched to keep it going): shown with the row
  const row = { name, best, at: new Date().toISOString().slice(0, 10), kh, ...(body.life === true ? { life: true } : {}) };
  if (i >= 0) all[i] = row; else all.push(row);
  const kept = all.sort((a, b) => b.best - a.best).slice(0, KEEP);
  await storage.put('runs', kept);
  return json({ rows: ranked(kept) }, 200, h);
}

// The Gauntlet (a contest for Pro players): pass every historic drive (an A: 90 or better) first. An entrant is a Pro
// code (one entry a code, on a device the code is bound to) under a public name (the same rules as the boards: 1-24
// characters, no slurs, one owner). Only passes made after entering and after the start (RACE_FROM) count; a drive
// counts once, at its first pass. Each pass keeps its calls (the decisions behind the grade) so a winner's run can be
// checked before a prize is given. The first entrant to RACE_N passes is the winner; the board goes on for the places.
//   GET    /race                          -> { n, from, now, entrants, winner, rows: [{ name, n, at, done? }] }   the top RACE_TOP
//   POST   /race/me   { code, key }       -> the board, and { me: { name, n, passes, rank } } (me null: not entered)
//   POST   /race/join { code, key, name } -> the same, entered (409 a name taken or not allowed; one entry a code)
//   POST   /race/start { code, key, drive } -> { ok, tok }: a try of a drive starts (only once the Gauntlet has started,
//                                         and only for an entrant): its pass counts only with this token, so a drive
//                                         started before the start (or before entering) never counts
//   POST   /race/pass { code, key, drive, p, decs, tryAt, tok, res } -> the same, the drive counted (p: the score, 0.895
//                                         and up; res: the final score, the game won)
//   DELETE /race?name=X (Authorization: Bearer <ADMIN_TOKEN>) -> an entrant off the board, for good (a run that fails
//                                                                the check)
const RACE_N = 24, RACE_TOP = 100, RACE_GAP = 30e3, RACE_DECS_MAX = 80, RACE_BYTES_MAX = 60000, RACE_MIN_TRY = 20e3;
const raceFrom = (env) => Date.parse(env.RACE_FROM || '2026-10-16T20:00:00Z');
// the leaderboard: most drives passed, then whoever got there first
const raceRows = (list) => Object.values(list).filter((x) => !x.out && !blocked(x.name))
  .sort((a, b) => b.n - a.n || a.nAt - b.nAt || a.joined - b.joined);
async function raceView(storage, env, id) {
  const list = (await storage.get('race:list')) || {}, rows = raceRows(list);
  const view = { n: RACE_N, from: new Date(raceFrom(env)).toISOString(), now: new Date().toISOString(), entrants: rows.length,
    passes: rows.reduce((a, x) => a + x.n, 0), winner: ((w) => (w ? { name: w.name, at: w.at } : null))(await storage.get('race:winner')),
    rows: rows.slice(0, RACE_TOP).map((x) => ({ name: x.name, n: x.n, at: x.n ? new Date(x.nAt).toISOString() : null, ...(x.done ? { done: new Date(x.done).toISOString() } : {}) })) };
  if (id !== undefined) {
    const e = id && await storage.get(`race:e:${id}`);
    view.me = e && !e.out ? { name: e.name, n: e.n, passes: Object.keys(e.passes).map(Number).sort((a, b) => a - b),
      rank: rows.findIndex((x) => x.id === id) + 1, done: e.done ? new Date(e.done).toISOString() : null } : null;
  }
  return view;
}
async function race(req, env, storage, hits, h, url) {
  if (url.pathname === '/race' && req.method === 'GET') return json(await raceView(storage, env), 200, { ...h, 'Cache-Control': 'no-store' });
  if (url.pathname === '/race' && req.method === 'DELETE') {
    const auth = req.headers.get('Authorization') || '', want = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : '';
    if (!want || !same(auth, want)) return json({ error: 'forbidden' }, 403, h);
    const lower = clean(url.searchParams.get('name')).toLowerCase(), id = await storage.get(`race:name:${lower}`);
    if (!id) return json({ error: 'no such entrant' }, 404, h);
    const list = (await storage.get('race:list')) || {}, e = await storage.get(`race:e:${id}`);
    if (list[id]) { list[id].out = true; await storage.put('race:list', list); }
    if (e) await storage.put(`race:e:${id}`, { ...e, out: true });
    const w = await storage.get('race:winner');
    if (w && w.id === id) {                                  // the winner taken off: the next to finish, if any
      const next = raceRows(list).find((x) => x.done);
      await storage.put('race:winner', next ? { name: next.name, at: new Date(next.done).toISOString(), id: next.id } : null);
    }
    return json({ ok: true }, 200, h);
  }
  if (req.method !== 'POST' || !['/race/me', '/race/join', '/race/start', '/race/pass'].includes(url.pathname)) return json({ error: 'not found' }, 404, h);
  // the board's own poll (/race/me, every 15 s a page) is a read: it never uses up the per-address budget, which phones
  // behind one carrier address share, so a pass is never refused for someone else's polling
  if (url.pathname !== '/race/me' && limited(req, hits)) return json({ error: 'slow down' }, 429, h);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  const x = await proAccess(storage, env, body, 'a valid Pro code is needed to enter');
  if (!x.code) return refusal(x, h);
  const code = x.code;                                     // signed in or by code: the same code, the same entry
  const id = (await sha256(`race:${code}`)).slice(0, 24), now = Date.now();
  if (url.pathname === '/race/me') return json(await raceView(storage, env, id), 200, h);
  let e = await storage.get(`race:e:${id}`);
  if (url.pathname === '/race/join') {
    if (e && e.out) return json({ error: 'this code is out of the Gauntlet' }, 403, h);
    if (e && body.rename && now < raceFrom(env)) {                                // before the start: a new name for the same entry
      const name = clean(body.name);
      if (!name) return json({ error: 'a name (1-24 characters) is needed' }, 400, h);
      if (blocked(name)) return json({ error: 'That name is not allowed. Pick another.', refused: true }, 409, h);
      const lower = name.toLowerCase(), old = e.name.toLowerCase();
      if (lower !== old && await storage.get(`race:name:${lower}`)) return json({ error: 'That name is taken. Pick another.' }, 409, h);
      if (lower !== old) { await storage.put(`race:name:${lower}`, id); await storage.delete(`race:name:${old}`); }
      e.name = name;
      await storage.put(`race:e:${id}`, e);
      const list = (await storage.get('race:list')) || {};
      if (list[id]) { list[id].name = name; await storage.put('race:list', list); }
      return json(await raceView(storage, env, id), 200, h);
    }
    if (e) return json(await raceView(storage, env, id), 200, h);              // entered already: the same entry
    const name = clean(body.name);
    if (!name) return json({ error: 'a name (1-24 characters) is needed' }, 400, h);
    if (blocked(name)) return json({ error: 'That name is not allowed. Pick another.', refused: true }, 409, h);
    const lower = name.toLowerCase();
    if (await storage.get(`race:name:${lower}`)) return json({ error: 'That name is taken. Pick another.' }, 409, h);
    e = { id, name, joined: now, passes: {}, n: 0, nAt: now };
    await storage.put(`race:name:${lower}`, id);
    await storage.put(`race:e:${id}`, e);
    const list = (await storage.get('race:list')) || {};
    list[id] = { id, name, n: 0, nAt: now, joined: now };
    await storage.put('race:list', list);
    return json(await raceView(storage, env, id), 200, h);
  }
  if (!e || e.out) return json({ error: 'enter the Gauntlet first' }, 403, h);
  const drive = Number(body.drive);
  if (!Number.isInteger(drive) || drive < 1 || drive > RACE_N) return json({ error: 'no such drive' }, 400, h);
  // a try starts: its token (a new try replaces the last one's)
  if (url.pathname === '/race/start') {
    if (now < raceFrom(env)) return json({ error: 'the Gauntlet has not started' }, 409, h);
    const tok = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    await storage.put(`race:try:${id}:${drive}`, { tok, at: now });
    return json({ ok: true, tok }, 200, h);
  }
  // a pass
  const p = Number(body.p), decs = body.decs;
  if (!(p >= 0.895 && p <= 1)) return json({ error: 'not a pass (90 or better)' }, 400, h);
  if (!Array.isArray(decs) || !decs.length || decs.length > RACE_DECS_MAX || JSON.stringify(decs).length > RACE_BYTES_MAX) return json({ error: 'the calls behind the grade are needed' }, 400, h);
  if (now < raceFrom(env)) return json({ error: 'the Gauntlet has not started', ...(await raceView(storage, env, id)) }, 409, h);
  // the try was started in the Gauntlet (after the start, after entering, this drive) and took a real drive's time
  const tr = await storage.get(`race:try:${id}:${drive}`);
  if (!tr || typeof body.tok !== 'string' || !same(body.tok, tr.tok)) return json({ error: 'this try started before you were in the Gauntlet (or before the Gauntlet started): play the drive again to count it', notry: true }, 409, h);
  if (now - tr.at < RACE_MIN_TRY) return json({ error: 'too fast for a real drive' }, 429, h);
  if (e.passes[drive]) return json(await raceView(storage, env, id), 200, h);           // passed already: its first pass counts
  if (now - (e.last || 0) < RACE_GAP) return json({ error: 'too fast: one drive at a time' }, 429, h);
  // the mission: a pass takes winning the game
  const won = Array.isArray(body.res) && Array.isArray(body.res[0]) && Number(body.res[0][0]) > Number(body.res[0][1]);
  if (!won) return json({ error: 'a pass takes winning the game' }, 400, h);
  const res = Array.isArray(body.res) ? body.res.slice(0, 4).map((r) => (Array.isArray(r) ? r.slice(0, 2).map(Number) : null)) : null;
  await storage.put(`race:audit:${id}:${drive}`, { at: now, p, tryAt: Number(body.tryAt) || null, started: tr.at, decs, res });
  await storage.put(`race:try:${id}:${drive}`, { ...tr, used: now });
  e.passes[drive] = now; e.n = Object.keys(e.passes).length; e.nAt = now; e.last = now;
  if (e.n >= RACE_N && !e.done) e.done = now;
  await storage.put(`race:e:${id}`, e);
  const list = (await storage.get('race:list')) || {};
  list[id] = { ...(list[id] || { id, name: e.name, joined: e.joined }), n: e.n, nAt: e.nAt, ...(e.done ? { done: e.done } : {}) };
  await storage.put('race:list', list);
  if (e.done && !(await storage.get('race:winner'))) await storage.put('race:winner', { name: e.name, at: new Date(e.done).toISOString(), id });
  return json(await raceView(storage, env, id), 200, h);
}

// Versus (match.js): the room for a code, or the lobby for a quick match; only from the site's own pages
async function versus(req, env, url) {
  const h = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!env.MATCH) return json({ error: 'versus is not set up' }, 503, h);
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean), origin = req.headers.get('Origin') || '';
  if (allowed.length && !allowed.includes('*') && !allowed.includes(origin)) return json({ error: 'origin' }, 403, h);
  if (url.pathname === '/vs/ladder' || url.pathname === '/vs/me') {
    if ((url.pathname === '/vs/ladder') !== (req.method === 'GET') || !['GET', 'POST'].includes(req.method)) return json({ error: 'method' }, 405, h);
    const r = await env.MATCH.get(env.MATCH.idFromName('ladder')).fetch(req);
    return new Response(r.body, { status: r.status, headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/vs/queue') return env.MATCH.get(env.MATCH.idFromName('lobby')).fetch(req);      // matchmaking (a WebSocket)
  const room = url.searchParams.get('room') || '';
  if (!ROOM_RE.test(room)) return json({ error: 'room' }, 400, h);
  return env.MATCH.get(env.MATCH.idFromName(`room:${room}`)).fetch(req);
}

export class Board {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.hits = new Map(); }
  async fetch(req) {
    if (new URL(req.url).pathname === CRON_PATH) return json(await reminders(this.env, this.ctx.storage, String(((await readBody(req)) || {}).date || '')), 200, {});
    return handle(req, this.env, this.ctx.storage, this.hits);
  }
}

export { Match } from './match.js';
import { ROOM_RE } from './match.js';

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (['/vs/ws', '/vs/queue', '/vs/ladder', '/vs/me'].includes(url.pathname)) return versus(req, env, url);
    if (req.method === 'OPTIONS' || ![...PRO_PATHS, ...RACE_PATHS, ...AUTH_PATHS, ...LEAGUE_PATHS, '/board', '/daily', '/days', '/madden'].includes(url.pathname)) return handle(req, env, null, null);
    return env.BOARD.get(env.BOARD.idFromName('board')).fetch(req);
  },
  // the cron trigger (wrangler.toml): the day's reminder emails, sent by the Board (its storage); the day is the run's
  // UTC date (each account gets one a day, however many runs)
  scheduled(ev, env, ctx) {
    const date = new Date(ev && ev.scheduledTime ? ev.scheduledTime : Date.now()).toISOString().slice(0, 10);
    const run = env.BOARD.get(env.BOARD.idFromName('board')).fetch(new Request(`https://board${CRON_PATH}`, { method: 'POST', body: JSON.stringify({ date }) }))
      .then((r) => r.json()).then((d) => console.log('daily reminders', date, JSON.stringify(d))).catch((e) => console.error('daily reminders failed', e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(run);
    return run;
  },
};
