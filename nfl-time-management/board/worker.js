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
// keeps; only its SHA-256 is stored), so nobody else can overwrite your score. Scores are not checked against the
// runs that made them. Posts are limited per IP (RATE_PER_MIN a minute). The page may be served from another host,
// so responses carry CORS headers for ALLOWED_ORIGINS (comma-separated; "*" = any).
const TOP = 25, KEEP = 500, RATE_PER_MIN = 30, DAY_TOP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
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
  const mine = `dk:${date}:${kh}`;
  const day = (await storage.get(`day:${date}`)) || emptyDay();
  const prev = await storage.get(mine);
  let taken = false, unclaimed = false;
  if (name && !(prev && prev.name)) {
    const owner = await ownerOf(storage, name.toLowerCase());
    taken = !!(owner && owner !== kh);
    unclaimed = !owner;
  }
  if (prev) {           // the day's first result stands; a name given afterwards puts that result on the list
    if (name && !prev.name && !taken) {
      prev.name = name;
      day.top.push({ name, p: prev.p, kh });
      day.top.sort((a, b) => b.p - a.p);
      day.top = day.top.slice(0, DAY_TOP);
      await storage.put(mine, prev);
      await storage.put(`day:${date}`, day);
      if (unclaimed) await claim(storage, name.toLowerCase(), kh);
    }
    return json({ ...dayView(day), counted: false, you: { p: prev.p, spots: prev.spots }, ...(taken ? { taken: true } : {}), ...(refused ? { refused: true } : {}),
      ...(prev.madden ? { madden: prev.madden } : {}) }, 200, h);
  }
  const pt = Math.round(p * 100);
  day.n += 1;
  day.hist[pt] += 1;
  spots.forEach((w, i) => { const x = day.spots[i]; x.n += 1; x.sum += w; x.hist[Math.max(0, Math.min(100, Math.round(w * 100) + 50))] += 1; });
  if (name && !taken) {
    day.top.push({ name, p, kh });
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
  if (unclaimed && name) await claim(storage, name.toLowerCase(), kh);
  return json({ ...dayView(day), counted: true, you, ...(taken ? { taken: true } : {}), ...(refused ? { refused: true } : {}), ...(madden ? { madden } : {}) }, 200, h);
}

// The board itself: `storage` is the Durable Object's (get/put), `hits` its in-memory per-IP counts.
export async function handle(req, env, storage, hits) {
  const h = cors(req, env), url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
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
  const kh = await sha256(devKey);                 // before the read: from here to the write is storage only
  const all = await readAll(), lower = name.toLowerCase(), i = all.findIndex((r) => String(r.name).toLowerCase() === lower);
  const owner = await ownerOf(storage, lower);
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

export class Board {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.hits = new Map(); }
  fetch(req) { return handle(req, this.env, this.ctx.storage, this.hits); }
}

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS' || !['/board', '/daily', '/days', '/madden'].includes(url.pathname)) return handle(req, env, null, null);
    return env.BOARD.get(env.BOARD.idFromName('board')).fetch(req);
  },
};
