// Survivor leaderboard for the Two-Minute Drill website: a Cloudflare Worker in front of one Durable Object (Board),
// which keeps the board in its own storage. One object handles every post in turn, so two runs posted together
// can't overwrite each other, and its per-IP limit is the same everywhere (KV took up to a minute to sync).
//   GET    /board                       -> { rows: [{ name, best, at }] }   the top 25 best runs
//   POST   /board  { name, best, key }  -> { rows, kept? }                  a player's best (only a better run replaces it)
//   DELETE /board?name=Eli  (Authorization: Bearer <ADMIN_TOKEN>)          remove a row (no ADMIN_TOKEN secret: off)
// Players are identified by name (a game among friends): trimmed, control characters dropped, 1-24 characters,
// matched case-insensitively. The first post under a name claims it for that device's key (a random string the page
// keeps; only its SHA-256 is stored), so nobody else can overwrite your score. Scores are not checked against the
// runs that made them. Posts are limited per IP (RATE_PER_MIN a minute). The page may be served from another host,
// so responses carry CORS headers for ALLOWED_ORIGINS (comma-separated; "*" = any).
const TOP = 25, KEEP = 500, RATE_PER_MIN = 10;

const clean = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

function cors(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return { 'Access-Control-Allow-Origin': ok, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const ranked = (all) => all.slice().sort((a, b) => b.best - a.best || String(a.at).localeCompare(String(b.at))).slice(0, TOP)
  .map(({ name, best, at }) => ({ name, best, at }));            // never the key hash
async function sha256(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
// constant-time enough for a bearer token compared once per request
const same = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

// The board itself: `storage` is the Durable Object's (get/put), `hits` its in-memory per-IP counts.
export async function handle(req, env, storage, hits) {
  const h = cors(req, env), url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
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

  const ip = req.headers.get('CF-Connecting-IP') || 'local', min = Math.floor(Date.now() / 60000);
  for (const [k, v] of hits) if (v.min !== min) hits.delete(k);
  const hit = hits.get(ip) || { min, n: 0 };
  if (hit.n >= RATE_PER_MIN) return json({ error: 'slow down' }, 429, h);
  hits.set(ip, { min, n: hit.n + 1 });

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  const name = clean(body && body.name), best = Number(body && body.best), devKey = String((body && body.key) || '');
  if (!name || !Number.isInteger(best) || best < 0 || best > 999) return json({ error: 'name (1-24 characters) and best (0-999) wanted' }, 400, h);
  if (!KEY_RE.test(devKey)) return json({ error: 'key (16-128 letters, digits, - or _) wanted' }, 400, h);
  const kh = await sha256(devKey);                 // before the read: from here to the write is storage only
  const all = await readAll(), lower = name.toLowerCase(), i = all.findIndex((r) => String(r.name).toLowerCase() === lower);
  if (i >= 0 && all[i].kh && all[i].kh !== kh) return json({ error: 'name taken', rows: ranked(all) }, 409, h);
  if (i >= 0 && all[i].best >= best) {
    if (!all[i].kh) { all[i].kh = kh; await storage.put('runs', all); }       // a row from before names were claimed
    return json({ rows: ranked(all), kept: all[i].best }, 200, h);
  }
  const row = { name, best, at: new Date().toISOString().slice(0, 10), kh };
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
    if (req.method === 'OPTIONS' || url.pathname !== '/board') return handle(req, env, null, null);
    return env.BOARD.get(env.BOARD.idFromName('board')).fetch(req);
  },
};
