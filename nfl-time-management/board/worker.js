// Survivor leaderboard for the Two-Minute Drill website: a Cloudflare Worker with one KV namespace (BOARD).
//   GET  /board                   -> { rows: [{ name, best, at }] }   the top 25 best runs
//   POST /board  { name, best }   -> { rows, kept? }                  a player's best (only a better run replaces it)
// Players are identified by name only (a game among friends): the name is trimmed, control characters dropped,
// 1-24 characters; names match case-insensitively. Posts are limited per IP (RATE_PER_MIN a minute). The page is
// served elsewhere (GitHub Pages), so responses carry CORS headers for ALLOWED_ORIGINS (comma-separated; "*" = any).
const TOP = 25, KEEP = 500, RATE_PER_MIN = 10;

const clean = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);

function cors(req, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  const ok = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return { 'Access-Control-Allow-Origin': ok, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function readAll(env) {
  const all = await env.BOARD.get('runs', 'json');
  return Array.isArray(all) ? all : [];
}
const ranked = (all) => all.slice().sort((a, b) => b.best - a.best || String(a.at).localeCompare(String(b.at))).slice(0, TOP);

export async function handle(req, env) {
  const h = cors(req, env), url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (url.pathname !== '/board') return json({ error: 'not found' }, 404, h);
  if (req.method === 'GET') return json({ rows: ranked(await readAll(env)) }, 200, h);
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);

  const ip = req.headers.get('CF-Connecting-IP') || 'local', rk = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const used = Number(await env.BOARD.get(rk)) || 0;
  if (used >= RATE_PER_MIN) return json({ error: 'slow down' }, 429, h);
  await env.BOARD.put(rk, String(used + 1), { expirationTtl: 120 });

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400, h); }
  const name = clean(body && body.name), best = Number(body && body.best);
  if (!name || !Number.isInteger(best) || best < 0 || best > 999) return json({ error: 'name (1-24 characters) and best (0-999) wanted' }, 400, h);
  const all = await readAll(env), key = name.toLowerCase(), i = all.findIndex((r) => String(r.name).toLowerCase() === key);
  if (i >= 0 && all[i].best >= best) return json({ rows: ranked(all), kept: all[i].best }, 200, h);
  const row = { name, best, at: new Date().toISOString().slice(0, 10) };
  if (i >= 0) all[i] = row; else all.push(row);
  const kept = all.sort((a, b) => b.best - a.best).slice(0, KEEP);
  await env.BOARD.put('runs', JSON.stringify(kept));
  return json({ rows: ranked(kept) }, 200, h);
}

export default { fetch: (req, env) => handle(req, env) };
