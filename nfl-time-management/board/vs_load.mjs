// Versus load test against a deployed worker (never the real board: .github/workflows/versus-load.yml deploys its own,
// two-minute-drill-loadtest, with its own Durable Objects, then deletes it). Real WebSockets through Cloudflare:
// PAIRS matches between two bots from the casual queue and CPU matches against the computer (the lobby's Computer
// button, mode cpu), all at once. Every bot answers its decisions as a phone would (a moment to think),
// and the room's answer time is measured: from the last half of a decision sent to its snap back.
//   node board/vs_load.mjs https://two-minute-drill-loadtest.<account>.workers.dev [pairs 60] [cpu 40] [think ms 400]
// Fails when a match doesn't end, a socket errors more than ERR_MAX times, or the answer time's 95th percentile is
// over P95_MAX ms. Prints a JSON report.
import VSCore from '../web/vs_core.js';

const BASE = (process.argv[2] || '').replace(/\/$/, '');
const PAIRS = +(process.argv[3] || 60), CPU = +(process.argv[4] || 40), THINK = +(process.argv[5] || 400);
const P95_MAX = 2500, ERR_MAX = Math.ceil((PAIRS * 2 + CPU) * 0.02), DEADLINE_MS = 12 * 60_000;
if (!/^https?:\/\//.test(BASE)) { console.error('usage: node board/vs_load.mjs https://<the load-test worker>'); process.exit(2); }
const WS = BASE.replace(/^http/, 'ws');
const CALLS = ['rb_middle', 'rb_inside_strong', 'rb_out_weak', 'quick_strong', 'quick_middle', 'deep_strong', 'screen', 'pa_short', 'rpo_strong'];
const TEAMS = ['KC', 'BUF', 'PHI', 'DAL', 'SF', 'DET', 'BAL', 'GB', 'MIA', 'CIN', 'LA', 'SEA', 'MIN', 'PIT', 'HOU', 'NYJ'];
const R = VSCore.rng(Date.now() % 1e9);
const pick = (a) => a[Math.floor(R() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rep = { matches: 0, ended: 0, by: {}, cpu: 0, decisions: 0, lat: [], errors: [], queueMs: [], firstStepMs: [] };

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`socket ${url.split('?')[0]}: ${e.message || 'error'}`));
  });
}
function halfFor(ms, seat) {
  const role = VSCore.role(ms, seat);
  if (role === 'pick') return { pick: R() < 0.5 ? 'offense' : 'defense' };
  if (role === 'pat') return { action: { pat: 'xp' } };
  if (role === 'defense') return { dc: { pers: pick(VSCore.DC.pers), front: pick(VSCore.DC.front), cover: pick(VSCore.DC.cover), rush: pick(VSCore.DC.rush) } };
  const c = pick(CALLS);
  return { action: { call: c, play: c.startsWith('rb_') ? 'run' : 'pass' } };
}

// one bot: the queue, then its room to the end
async function bot(i, wantCpu) {
  const key = `loadtest-${Date.now().toString(36)}-${String(i).padStart(8, '0')}`, team = pick(TEAMS);
  const t0 = Date.now();
  const q = await open(`${WS}/vs/queue?key=${key}&mode=${wantCpu ? 'cpu' : 'casual'}&team=${team}&name=Load${i}`);
  const room = await new Promise((resolve, reject) => {
    q.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'match') resolve(m);
    };
    q.onclose = () => reject(new Error('the queue closed before a match'));
    setTimeout(() => reject(new Error('no match in 3 minutes')), 180_000);
  });
  q.onclose = null;
  rep.queueMs.push(Date.now() - t0);
  if (room.mode === 'cpu') rep.cpu++;
  const ws = await open(`${WS}/vs/ws?room=${room.room}&key=${key}&mode=${room.mode}`);
  let ms = null, n = 0, seat = -1, sent = -1, sentAt = 0, firstAt = 0;
  return new Promise((resolve, reject) => {
    const act = async () => {
      if (!ms || ms.over || seat < 0 || sent === n || !VSCore.need(ms).includes(seat)) return;
      sent = n;
      const mine = n;
      if (!firstAt) firstAt = Date.now();
      ws.send(JSON.stringify({ t: 'ready', n: mine }));
      await sleep(THINK * (0.5 + R()));
      if (mine !== n) return;
      sentAt = Date.now();
      ws.send(JSON.stringify({ t: 'half', n: mine, half: halfFor(ms, seat) }));
      rep.decisions++;
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') { seat = m.seat; ms = m.ms; n = m.n; if (m.phase === 'over') { finish(m.result); return; } act(); }
      if (m.t === 'start') { ms = m.ms; n = 0; act(); }
      if (m.t === 'step') {
        if (sentAt) rep.lat.push(Date.now() - sentAt);
        if (m.n === 0 && firstAt) rep.firstStepMs.push(Date.now() - firstAt);
        sentAt = 0; ms = m.ms; n = m.n + 1;
        if (m.result) finish(m.result); else act();
      }
      if (m.t === 'over') finish(m.result);
    };
    const finish = (res) => { rep.ended++; rep.by[res.by] = (rep.by[res.by] || 0) + 1; try { ws.close(1000); } catch (e) { /* gone */ } resolve(); };
    ws.onerror = () => reject(new Error(`room ${room.room}: socket error`));
    setTimeout(() => reject(new Error(`room ${room.room}: not over in ${DEADLINE_MS / 60000} minutes`)), DEADLINE_MS);
  });
}

const t0 = Date.now();
const jobs = [];
for (let i = 0; i < PAIRS * 2; i++) jobs.push(bot(i, false).catch((e) => { rep.errors.push(e.message); }));
for (let i = 0; i < CPU; i++) jobs.push(sleep(500).then(() => bot(PAIRS * 2 + i, true)).catch((e) => { rep.errors.push(e.message); }));
rep.matches = PAIRS + CPU;
await Promise.all(jobs);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const out = {
  bots: PAIRS * 2 + CPU, matches: rep.matches, ended: rep.ended, by: rep.by, cpuMatches: rep.cpu, decisions: rep.decisions,
  answerMs: { p50: q(rep.lat, 0.5), p95: q(rep.lat, 0.95), p99: q(rep.lat, 0.99), max: q(rep.lat, 1) },
  firstSnapMs: { p50: q(rep.firstStepMs, 0.5), max: q(rep.firstStepMs, 1) },
  queueMs: { p50: q(rep.queueMs, 0.5), max: q(rep.queueMs, 1) },
  errors: rep.errors.length, errorSamples: rep.errors.slice(0, 8), minutes: +((Date.now() - t0) / 60000).toFixed(1),
};
console.log(JSON.stringify(out, null, 1));
const bad = [];
if (rep.errors.length > ERR_MAX) bad.push(`${rep.errors.length} errors (at most ${ERR_MAX})`);
if (out.answerMs.p95 > P95_MAX) bad.push(`the room's answer time p95 ${out.answerMs.p95} ms (at most ${P95_MAX})`);
if (rep.cpu < CPU * 0.9) bad.push(`only ${rep.cpu} of ${CPU} computer matches started`);
if (bad.length) { console.error(`versus load: FAIL: ${bad.join('; ')}`); process.exit(1); }
console.log('versus load ok');
