// Versus against the computer, with the real engine (board/assets/vs): matches from the lobby's offer to the end, the
// player calling a real call each snap (as often as NFL play-callers make each, or always the same one), the computer
// the engine's own. Every match ends on the scoreboard, the computer's call is in at once every time, nothing is rated;
// and how often the computer wins (an even match for a player who calls like the league).
//   node board/vs_cpu_test.mjs [matches, default 60]
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, FakeClient } from './vs_world.mjs';
import { CPU_AFTER_S, CPU_SEAT, CPU_DECIDE_MS, ENGINE_WAIT_MS, loadEngine, resetEngine } from './match.js';
import VSCore from '../web/vs_core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.VS_ASSETS || path.join(HERE, 'assets');
if (!fs.existsSync(path.join(ASSETS, 'vs', 'engine_data.pack'))) { console.error(`no engine data in ${ASSETS}/vs (build the site first)`); process.exit(1); }
const N = +(process.argv[2] || 60);
const R = VSCore.rng(4242);
const w = new World({ assetsDir: ASSETS });
// an engine load another room started that never settles (on Cloudflare, its request gone): a room waits on it only
// ENGINE_WAIT_MS, then loads the engine itself (the load test's computer matches hung on one for good)
resetEngine(new Promise(() => {}));
const t0 = performance.now();
const E = await loadEngine(w.env);
assert.ok(E && E.eng && E.pool, 'the engine loaded past a load that never settles');
assert.ok(performance.now() - t0 < ENGINE_WAIT_MS + 20_000, 'and not long after the wait');
const TEAMS = Object.keys(E.pool.teams), CALLS = E.eng.pb.calls.filter((c) => c.id !== 'hail_mary' && c.id !== 'qb_sneak');
const DC = { pers: 'nickel', front: 'even', cover: 'c3', rush: 4 };
const out = { won: 0, lost: 0, by: {}, snaps: 0 }, byLevel = { pro: [0, 0], rookie: [0, 0] };
for (let i = 0; i < N; i++) {
  const level = i % 2 ? 'rookie' : 'pro';
  const q = new FakeClient(w, `cpu-test-device-${String(i).padStart(8, '0')}`);
  await q.queue({ mode: 'casual', team: TEAMS[i % TEAMS.length], name: `P${i}` });
  await w.advance(CPU_AFTER_S * 1000 + 2500);
  q.send({ t: 'cpu', level });
  await w.settle();
  const m = q.last('match');
  assert.ok(m && m.mode === 'cpu', 'the computer, on asking');
  const A = new FakeClient(w, q.key);
  await A.open(m.room);
  const room = () => w.objects.get(`room:${m.room}`).store.get('room');
  assert.strictEqual(room().cpuLevel, level, 'the level asked for');
  assert.ok(room().deadline - w.now > CPU_DECIDE_MS - 5000, 'no 30-second clock against the computer');
  const same = i % 4 === 0 ? CALLS[Math.floor(R() * CALLS.length)].id : null;     // a quarter of them: the same call every snap
  for (let k = 0; k < 600; k++) {
    const S = room();
    if (S.phase !== 'live') break;
    const need = VSCore.need(S.ms), pend = w.objects.get(`room:${m.room}`).store.get('pend');
    if (need.includes(CPU_SEAT)) assert.ok(pend && pend.n === S.n && CPU_SEAT in pend.halves, 'the computer is never waited on');
    if (!need.includes(0)) { await w.advance(500); continue; }
    const role = VSCore.role(S.ms, 0);
    let half;
    if (role === 'pick') half = { pick: R() < 0.5 ? 'offense' : 'defense' };
    else if (role === 'pat') half = { action: { pat: 'xp' } };
    else if (role === 'defense') half = { dc: DC };
    else { const c = same || CALLS[Math.floor(R() * CALLS.length)].id; half = { action: { call: c, play: E.eng.pb.calls.find((x) => x.id === c).kind === 'run' ? 'run' : 'pass' } }; out.snaps++; }
    A.send({ t: 'half', n: S.n, half });
    await w.settle();
  }
  const S = room();
  assert.strictEqual(S.phase, 'over', 'every match ends');
  out.by[S.result.by] = (out.by[S.result.by] || 0) + 1;
  assert.strictEqual(S.result.by, 'score', `on the scoreboard: ${JSON.stringify(S.result)}`);
  assert.strictEqual(S.rated, null, 'never rated');
  if (S.result.winner === 0) out.won++; else out.lost++;
  byLevel[level][0] += S.result.winner === 0 ? 1 : 0; byLevel[level][1] += 1;
  A.drop(); q.drop();
}
const lad = (await w.http('ladder', '/vs/ladder')).body;
assert.strictEqual(lad.players, 0, 'nobody on the ladder from the computer');
const pct = (x) => Math.round((100 * x[0]) / Math.max(1, x[1]));
console.log(`the player beat the rookie ${pct(byLevel.rookie)}% of ${byLevel.rookie[1]}, the pro ${pct(byLevel.pro)}% of ${byLevel.pro[1]}`);
console.log(`vs cpu ok: ${N} matches, the player won ${out.won} (${Math.round((100 * out.won) / N)}%), ${out.snaps} snaps called, ${JSON.stringify(out.by)}`);
w.close();
