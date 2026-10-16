// Versus: two players, college overtime, each calling their own side. One Durable Object per room (its code), one
// named 'lobby' (matchmaking) and one named 'ladder' (the ranked ratings).
//
// The room plays the football. Both phones send their half of each decision (the offense's call, the defense's
// call, the coin-toss choice, the try); a half stays sealed until every half the decision needs is in, then the room
// plays the snap with the engine (web/engine.js, the same one the phones have) and the college-overtime rules
// (web/vs_core.js), and sends the result and the new state to both. Nothing a phone says can change the score: it
// only ever sends a call, and the room checks that call against the playbook.
//
// The room keeps the play clock: a decision not in by its deadline (PLAY_MS after the last snap) is played as the
// default (null: the engine's own call). A player who misses AFK_LIMIT decisions in a row, or whose phone is gone
// for FORFEIT_MS, forfeits. A ranked match is rated by the room when it ends (the ladder object), never by a phone.
//
//   GET  /vs/ws?room=CODE&key=DEVICEKEY&mode=M&since=N (WebSocket)  the room: seat by device, the calls, the plays
//   GET  /vs/queue?key=DEVICEKEY&mode=ranked|casual&team=T&name=X (WebSocket)  matchmaking: a room when paired
//   GET  /vs/ladder                                                    the ranked ladder (the top 50)
//   POST /vs/me {key}                                                  your rating, record and rank
//
// Client -> room: {t:'team', team, name}  this seat's team (once; {t:'taken'} if the other seat has it)
//                 {t:'half', n, half}  its half of decision n    {t:'rematch'}  {t:'ping'}
// Room -> client: {t:'hello', seat, mode, teams, names, full, online, off, phase, n, ms, decisions, deadline, now,
//                   result, rated}   on connecting (decisions: the last ones from `since`, to catch up)
//                 {t:'start', ms, deadline, now}  {t:'step', n, halves, kind, res, notes, ms, deadline, now, result}
//                 {t:'locked', n, seat}  {t:'peer', online, off, now}  {t:'teams', teams, names}  {t:'taken', team}
//                 {t:'over', result}  {t:'rated', rated}  {t:'rematch-ask', seat}  {t:'rematch', room}
// Lobby -> client: {t:'queued', mode, size, wait, rating}  {t:'match', room, mode}
import NFLClockEngine from '../web/engine.js';
import VSCore from '../web/vs_core.js';
import { lazySimulator } from './lazy_sim.js';

export const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TEAM_RE = /^[A-Z]{2,3}$/;
const MODES = ['ranked', 'casual', 'friend'];
export const PLAY_MS = 45_000;             // a decision's deadline after the last snap: about 15 s to watch it, 30 to call
export const FIRST_MS = 75_000;            // the first decision (the coin toss): the intro too
export const FORFEIT_MS = 60_000;          // a phone gone this long in a live match: that side forfeits
export const AFK_LIMIT = 3;                // decisions in a row left to the play clock: that side forfeits
export const NOSHOW_MS = 60_000;           // a matched room nobody filled (or no team picked) in this long: called off
const ROOM_TTL_MS = 6 * 3600_000;          // a room is cleared this long after it was made
const MAX_MSG = 4096, MAX_N = 2000, CATCHUP = 40;
// the ladder: Elo. A new player's rating moves faster (K_NEW for the first PROVISIONAL games); no rating below FLOOR;
// the same two players count for the ladder at most PAIR_CAP times a day (no farming a friend's second phone)
export const ELO = { START: 1000, K_NEW: 40, K: 24, PROVISIONAL: 10, FLOOR: 100, PAIR_CAP: 3, TOP: 50 };
// matchmaking (ranked): two players are paired when their ratings are within WIN_BASE + WIN_PER_S for each second
// the longer of them has waited; after WIN_OPEN_S anyone
export const MM = { WIN_BASE: 100, WIN_PER_S: 20, WIN_OPEN_S: 45, TICK_MS: 2000 };

const clean = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0];       // the server's coin: the toss, each snap's seed
export const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
async function hashKey(k) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`)));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

// the engine and the teams, once per isolate: the worker's own assets (board/assets/vs, put there by the site workflow)
let ENGINE = null;
export function loadEngine(env) {
  if (env.VS_ENGINE) return Promise.resolve(typeof env.VS_ENGINE === 'function' ? env.VS_ENGINE() : env.VS_ENGINE);    // the tests' own
  if (!ENGINE) {
    ENGINE = (async () => {
      const get = async (p) => {
        const r = await env.ASSETS.fetch(new Request(`https://assets.local/vs/${p}`));
        if (!r.ok) throw new Error(`vs/${p} ${r.status}`);
        return r;
      };
      const unz = async (r) => VSCore.unpack(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const [d, pb, pool] = await Promise.all([get('engine_data.pack').then(unz), get('playbook.pack').then(unz), get('teams.json').then((r) => r.json())]);
      const eng = new NFLClockEngine(d);
      eng.loadPlaybook(pb);
      return { eng, pool };
    })();
    ENGINE.catch(() => { ENGINE = null; });
  }
  return ENGINE;
}
export function resetEngine() { ENGINE = null; }

export class Match {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.steppers = new Map();
    // a ping is answered without waking the object
    if (ctx.setWebSocketAutoResponse && typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/vs/queue') return this.queue(req, url);
    if (url.pathname === '/vs/ladder' || url.pathname === '/vs/me' || url.pathname === '/vs/report' || url.pathname === '/vs/rating') return this.ladder(req, url);
    if (url.pathname === '/vs/init') return this.init(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', room = url.searchParams.get('room') || '';
    if (!KEY_RE.test(key) || !ROOM_RE.test(room)) return new Response('bad room or key', { status: 400 });
    const kh = await hashKey(key), now = Date.now();
    const mode = MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'friend';
    let R = await this.room();
    if (!R) R = this.fresh(room, mode === 'ranked' ? 'casual' : mode, now);    // a ranked room is only ever made by the lobby
    let seat = R.seats.indexOf(kh);
    if (seat < 0 && !R.pre) seat = R.seats.indexOf(null);
    if (seat < 0) return new Response('the room is full', { status: 409 });
    R.seats[seat] = kh;
    R.seen[seat] = true;
    R.off[seat] = 0;
    if (R.phase === 'wait' && R.seen[0] && R.seen[1] && R.teams[0] && R.teams[1]) this.begin(R, now);
    await this.save(R);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.ctx.getWebSockets(`s${seat}`)) { try { old.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    this.ctx.acceptWebSocket(server, [`s${seat}`]);
    server.serializeAttachment({ seat });
    const since = Math.max(0, Math.min(R.n, Number.parseInt(url.searchParams.get('since'), 10) || 0, R.n), R.n - CATCHUP);
    const decisions = [];
    for (let i = since; i < R.n; i++) { const d = await this.ctx.storage.get(`d:${i}`); delete d.seed; decisions.push(d); }
    server.send(JSON.stringify({ t: 'hello', seat, mode: R.mode, room: R.room, teams: R.teams, names: R.names, full: R.seen[0] && R.seen[1],
      online: this.online(), off: R.off, phase: R.phase, n: R.n, ms: R.ms, ms0: since === 0 ? R.ms0 || null : null, decisions, deadline: R.deadline, now,
      result: R.result, rated: R.rated }));
    this.broadcast({ t: 'peer', online: this.online(), off: R.off, full: R.seen[0] && R.seen[1], now });
    const pend = await this.ctx.storage.get('pend');
    if (pend && pend.n === R.n) for (const s of Object.keys(pend.halves)) server.send(JSON.stringify({ t: 'locked', n: pend.n, seat: Number(s) }));
    await this.schedule(R);
    return new Response(null, { status: 101, webSocket: client });
  }

  fresh(room, mode, now) {
    return { v: 2, room, mode, pre: false, seats: [null, null], seen: [false, false], off: [0, 0],
      created: now, teams: [null, null], names: ['', ''], phase: 'wait', n: 0, ms: null, deadline: 0, defaults: [0, 0], result: null, rated: null };
  }
  async room() {
    const R = await this.ctx.storage.get('room');
    if (R && R.v !== 2) { await this.ctx.storage.deleteAll(); return null; }    // a room from before the server played the football
    return R || null;
  }
  save(R) { return this.ctx.storage.put('room', R); }
  online() { return [0, 1].map((s) => this.ctx.getWebSockets(`s${s}`).length > 0); }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) { /* closing */ } }
  }

  // a room the lobby (or a rematch) made: its two players, their teams; nobody else gets a seat
  async init(req) {
    const b = await req.json();
    if (await this.ctx.storage.get('room')) return reply({ error: 'taken' }, 409);
    const now = Date.now(), R = this.fresh(b.room, MODES.includes(b.mode) ? b.mode : 'casual', now);
    R.pre = true;
    R.seats = [b.seats[0], b.seats[1]];
    R.teams = [TEAM_RE.test(b.teams && b.teams[0]) ? b.teams[0] : null, TEAM_RE.test(b.teams && b.teams[1]) ? b.teams[1] : null];
    if (R.teams[0] && R.teams[0] === R.teams[1]) R.teams[1] = null;
    R.names = [clean(b.names && b.names[0]), clean(b.names && b.names[1])];
    await this.save(R);
    await this.schedule(R);
    return reply({ ok: true });
  }

  begin(R, now) {
    R.ms = R.ms0 = VSCore.start(rand() & 1);
    R.phase = 'live';
    R.n = 0;
    R.deadline = now + FIRST_MS;
    R.started = now;
    R.defaults = [0, 0];
    this.broadcast({ t: 'start', ms: R.ms, deadline: R.deadline, now });
  }

  // the next time the room has to act: a deadline, a forfeit, a no-show, a rating to retry, the end of the room
  async schedule(R) {
    const t = [R.created + ROOM_TTL_MS];
    if (R.phase === 'live') {
      t.push(R.deadline);
      for (const s of [0, 1]) if (R.off[s]) t.push(R.off[s] + FORFEIT_MS);
    }
    if (R.phase === 'wait' && R.pre) t.push(R.created + NOSHOW_MS);
    if (R.phase === 'over' && R.mode === 'ranked' && R.result && R.result.winner >= 0 && !R.rated) t.push(Date.now() + 5000);
    await this.ctx.storage.setAlarm(Math.min(...t));
  }

  stepper(R, E) {
    const k = `${R.teams[0]}|${R.teams[1]}`;
    if (!this.steppers.has(k)) this.steppers.set(k, VSCore.stepper(E.eng, E.pool, R.teams[0], R.teams[1], E.eng.lib ? lazySimulator : undefined));
    return this.steppers.get(k);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const { seat } = ws.deserializeAttachment() || {};
    if (m.t === 'ping') { try { ws.send('{"t":"pong"}'); } catch (e) { /* closing */ } return; }
    if (seat !== 0 && seat !== 1) return;
    // the engine first (a fetch the first time): everything after it is this room's storage only, so no other
    // message gets in between reading the room and saving it
    let E = null;
    if (m.t === 'half' || m.t === 'team') {
      try { E = await loadEngine(this.env); } catch (e) { console.error('vs engine', e && e.message); return; }    // the deadline retries
    }
    const R = await this.room();
    if (!R) return;
    const now = Date.now();
    if (m.t === 'team') {
      if (R.phase !== 'wait' || R.teams[seat] || !TEAM_RE.test(String(m.team || '')) || !E.pool.teams[m.team]) return;
      if (R.teams[1 - seat] === m.team) { ws.send(JSON.stringify({ t: 'taken', team: m.team })); return; }   // never the same team on both sides
      R.teams[seat] = m.team;
      R.names[seat] = clean(m.name) || R.names[seat];
      this.broadcast({ t: 'teams', teams: R.teams, names: R.names });
      if (R.seen[0] && R.seen[1] && R.teams[0] && R.teams[1]) this.begin(R, now);
      await this.save(R);
      await this.schedule(R);
      return;
    }
    if (m.t === 'rematch') return this.rematch(R, seat);
    if (m.t !== 'half' || R.phase !== 'live' || m.n !== R.n || R.n >= MAX_N) return;
    if (!VSCore.need(R.ms).includes(seat)) return;
    let pend = await this.ctx.storage.get('pend');
    if (!pend || pend.n !== R.n) pend = { n: R.n, halves: {} };
    if (seat in pend.halves) return;                                   // a call, once locked, stays
    pend.halves[seat] = VSCore.cleanHalf(R.ms, seat, m.half, E.eng.pb);
    R.defaults[seat] = pend.halves[seat] ? 0 : R.defaults[seat] + 1;   // nothing usable (the phone's clock ran out): a default
    if (VSCore.need(R.ms).every((s) => s in pend.halves)) return this.commit(R, pend, E, now);
    await this.ctx.storage.put('pend', pend);
    await this.save(R);
    this.broadcast({ t: 'locked', n: pend.n, seat });
  }

  // every half in (or the deadline): play it
  async commit(R, pend, E, now) {
    const step = this.stepper(R, E), seed = rand();
    let out;
    try { out = VSCore.apply(R.ms, pend.halves, step, seed); } catch (e) {
      console.error('vs apply', R.room, R.n, e && e.stack);
      try { out = VSCore.apply(R.ms, {}, step, seed); } catch (e2) { console.error('vs apply default', e2 && e2.stack); out = null; }
    }
    await this.ctx.storage.delete('pend');
    if (!out) return this.finish(R, { winner: -1, by: 'error' });
    const d = { n: pend.n, halves: pend.halves, kind: out.kind, res: out.res, notes: out.notes, ms: out.ms, at: now };
    await this.ctx.storage.put(`d:${pend.n}`, { ...d, seed });            // the seed stays here (a replay); no phone sees it
    R.ms = out.ms;
    R.n = pend.n + 1;
    R.deadline = now + PLAY_MS;
    let result = null;
    if (out.ms.over) {
      R.phase = 'over';
      result = R.result = { winner: out.ms.winner, by: 'score', score: out.ms.root.score.slice(), round: out.ms.cot.round };
    }
    await this.save(R);
    this.broadcast({ t: 'step', ...d, deadline: R.deadline, now, result });
    if (result) { this.steppers.clear(); return this.rate(R); }
    const afk = [0, 1].filter((s) => R.defaults[s] >= AFK_LIMIT);
    if (afk.length === 2) return this.finish(R, { winner: -1, by: 'abandoned' });
    if (afk.length === 1) return this.finish(R, { winner: 1 - afk[0], by: 'forfeit', loser: afk[0], why: 'afk' });
    if (R.n >= MAX_N) return this.finish(R, { winner: -1, by: 'error' });
    await this.schedule(R);
  }

  // over without the last snap: a forfeit, a no-show, both gone, an error
  async finish(R, result) {
    this.steppers.clear();
    R.phase = 'over';
    R.result = { ...result, score: R.ms ? R.ms.root.score.slice() : [0, 0], round: R.ms ? R.ms.cot.round : 0 };
    await this.ctx.storage.delete('pend');
    await this.save(R);
    this.broadcast({ t: 'over', result: R.result });
    if (R.result.winner >= 0) return this.rate(R);
    await this.schedule(R);
  }

  // a ranked match: the ladder moves both ratings (once: the ladder keeps every room it has rated)
  async rate(R) {
    if (R.mode !== 'ranked' || R.rated || !R.result || R.result.winner < 0) return this.schedule(R);
    try {
      const res = await this.env.MATCH.get(this.env.MATCH.idFromName('ladder')).fetch(new Request('https://ladder/vs/report', {
        method: 'POST', body: JSON.stringify({ room: R.room, seats: R.seats, names: R.names, winner: R.result.winner, by: R.result.by }) }));
      if (!res.ok) throw new Error(`ladder ${res.status}`);
      const rated = await res.json();
      const R2 = (await this.room()) || R;
      R2.rated = rated;
      await this.save(R2);
      this.broadcast({ t: 'rated', rated });
      await this.schedule(R2);
    } catch (e) {
      console.error('vs rate', R.room, e && e.message);
      await this.schedule(R);                                           // retried by the alarm
    }
  }

  async rematch(R, seat) {                 // both have to ask: then one new room for both, the same teams (never ranked)
    if (R.phase !== 'over' || !R.seats.every(Boolean)) return;
    R.again = [...new Set([...(R.again || []), seat])];
    if (R.again.length < 2) { await this.save(R); this.broadcast({ t: 'rematch-ask', seat }); return; }
    let next = R.next;
    if (!next) {
      await this.save(R);
      // one new room, however many times they tap: nothing else gets in while it is made
      next = await this.ctx.blockConcurrencyWhile(async () => {
        const R2 = await this.room();
        if (R2.next) return R2.next;
        for (let i = 0; i < 5; i++) {
          const code = roomCode();
          const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${code}`)).fetch(new Request('https://room/vs/init', {
            method: 'POST', body: JSON.stringify({ room: code, mode: R2.mode === 'friend' ? 'friend' : 'casual', seats: R2.seats, teams: R2.teams, names: R2.names }) }));
          if (r.ok) { R2.next = code; await this.save(R2); return code; }
        }
        return null;
      });
      if (!next) return;
    }
    this.broadcast({ t: 'rematch', room: next });
  }

  async alarm() {
    if (this.ctx.getWebSockets('q').length) return this.pairTick();
    const R = await this.room();
    if (!R) { if (await this.ctx.storage.get('room')) await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    if (now >= R.created + ROOM_TTL_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'expired'); } catch (e) { /* gone */ } }
      await this.ctx.storage.deleteAll();
      return;
    }
    if (R.phase === 'live') {
      // a phone gone too long: that side forfeits (both gone: the one who left first; at the same time: nobody wins)
      const late = [0, 1].filter((s) => R.off[s] && now >= R.off[s] + FORFEIT_MS);
      if (late.length === 2) {
        const first = R.off[0] === R.off[1] ? -1 : R.off[0] < R.off[1] ? 0 : 1;
        return this.finish(R, first < 0 ? { winner: -1, by: 'abandoned' } : { winner: 1 - first, by: 'forfeit', loser: first, why: 'left' });
      }
      if (late.length === 1) return this.finish(R, { winner: 1 - late[0], by: 'forfeit', loser: late[0], why: 'left' });
      if (now >= R.deadline - 50) {
        let E;
        try { E = await loadEngine(this.env); } catch (e) {
          console.error('vs engine', e && e.message);
          R.engineFail = (R.engineFail || 0) + 1;
          if (R.engineFail >= 3) return this.finish(R, { winner: -1, by: 'error' });
          await this.save(R);
          await this.ctx.storage.setAlarm(Date.now() + 5000);
          return;
        }
        const R2 = await this.room();                                   // the engine's fetch may have let a half in
        if (!R2 || R2.phase !== 'live' || R2.n !== R.n) return R2 && this.schedule(R2);
        let pend = await this.ctx.storage.get('pend');
        if (!pend || pend.n !== R2.n) pend = { n: R2.n, halves: {} };
        for (const s of VSCore.need(R2.ms)) if (!(s in pend.halves)) { pend.halves[s] = null; R2.defaults[s] += 1; }
        return this.commit(R2, pend, E, Date.now());
      }
    }
    if (R.phase === 'wait' && R.pre && now >= R.created + NOSHOW_MS) {
      // ranked: matched and never came (or never picked a team) is a loss, so nobody dodges an opponent; else called off
      const missing = [0, 1].filter((s) => !R.seen[s] || !R.teams[s]);
      if (R.mode === 'ranked' && missing.length === 1) return this.finish(R, { winner: 1 - missing[0], by: 'forfeit', loser: missing[0], why: 'noshow' });
      return this.finish(R, { winner: -1, by: 'noshow', missing });
    }
    if (R.phase === 'over' && R.mode === 'ranked' && !R.rated && R.result && R.result.winner >= 0) return this.rate(R);
    await this.schedule(R);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* closed */ }
    const a = ws.deserializeAttachment() || {};
    if (a.q) return;                                                   // a lobby ticket: gone from the queue
    if (a.seat !== 0 && a.seat !== 1) return;
    if (this.ctx.getWebSockets(`s${a.seat}`).some((x) => x !== ws)) return;   // still there on another tab
    const R = await this.room();
    if (!R) return;
    if (R.phase !== 'over') R.off[a.seat] = Date.now();
    await this.save(R);
    const online = this.online().map((on, s) => on && !this.ctx.getWebSockets(`s${s}`).every((x) => x === ws));
    this.broadcast({ t: 'peer', online, off: R.off, full: R.seen[0] && R.seen[1], now: Date.now() });
    await this.schedule(R);
  }
  webSocketError(ws) { return this.webSocketClose(ws); }

  // ------------------------------------------------------------------------------------------------ the lobby ---
  // the object named 'lobby': each player waiting is a WebSocket (a ticket: device, mode, team, name, rating, since).
  // Every tick it pairs who it can: ranked by rating (a window that widens while they wait), casual first come.
  async queue(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', mode = url.searchParams.get('mode') === 'ranked' ? 'ranked' : 'casual';
    const team = url.searchParams.get('team') || '';
    if (!KEY_RE.test(key) || !TEAM_RE.test(team)) return new Response('bad key or team', { status: 400 });
    const kh = await hashKey(key), name = clean(url.searchParams.get('name'));
    let rating = ELO.START;
    if (mode === 'ranked') {
      try {
        const r = await this.env.MATCH.get(this.env.MATCH.idFromName('ladder')).fetch(new Request('https://ladder/vs/rating', { method: 'POST', body: JSON.stringify({ kh }) }));
        rating = (await r.json()).rating || ELO.START;
      } catch (e) { /* the default */ }
    }
    for (const old of this.ctx.getWebSockets('q')) {
      const a = old.deserializeAttachment() || {};
      if (a.kh === kh) { try { old.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['q']);
    server.serializeAttachment({ q: true, kh, mode, team, name, rating, since: Date.now() });
    await this.pairTick();
    return new Response(null, { status: 101, webSocket: client });
  }
  tickets() {
    return this.ctx.getWebSockets('q').map((ws) => ({ ws, ...(ws.deserializeAttachment() || {}) })).filter((t) => t.q && !t.paired);
  }
  async pairTick() {
    await this.ctx.blockConcurrencyWhile(() => this.pairNow());
    const left = this.tickets(), now = Date.now();
    for (const t of left) {
      const size = left.filter((x) => x.mode === t.mode).length;
      try { t.ws.send(JSON.stringify({ t: 'queued', mode: t.mode, size, wait: Math.round((now - t.since) / 1000), rating: Math.round(t.rating) })); } catch (e) { /* closing */ }
    }
    if (left.length) await this.ctx.storage.setAlarm(now + MM.TICK_MS);
  }
  async pairNow() {
    const now = Date.now();
    for (const mode of ['ranked', 'casual']) {
      const list = this.tickets().filter((t) => t.mode === mode).sort((a, b) => a.since - b.since);
      const used = new Set();
      for (const a of list) {
        if (used.has(a)) continue;
        let best = null, bestCost = Infinity;
        for (const b of list) {
          if (b === a || used.has(b) || b.kh === a.kh) continue;
          const wait = (now - Math.min(a.since, b.since)) / 1000, gap = Math.abs(a.rating - b.rating);
          if (mode === 'ranked' && wait < MM.WIN_OPEN_S && gap > MM.WIN_BASE + MM.WIN_PER_S * wait) continue;
          const cost = (mode === 'ranked' ? gap : b.since - a.since) + (a.team === b.team ? 50 : 0);
          if (cost < bestCost) { best = b; bestCost = cost; }
        }
        if (!best) continue;
        const room = await this.makeRoom(mode, a, best);
        if (!room) continue;
        used.add(a); used.add(best);
        for (const t of [a, best]) {
          t.ws.serializeAttachment({ q: true, kh: t.kh, mode, paired: room });
          try { t.ws.send(JSON.stringify({ t: 'match', room, mode })); t.ws.close(1000, 'matched'); } catch (e) { /* gone: the room calls it off */ }
        }
      }
    }
  }
  async makeRoom(mode, a, b) {
    for (let i = 0; i < 5; i++) {
      const room = roomCode();
      const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${room}`)).fetch(new Request('https://room/vs/init', {
        method: 'POST', body: JSON.stringify({ room, mode, seats: [a.kh, b.kh], teams: [a.team, b.team], names: [a.name, b.name] }) }));
      if (r.ok) return room;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ the ladder ---
  // the object named 'ladder': one row per player (device), one per rated room (a room is never rated twice)
  sql() {
    if (!this.ready) {
      const q = this.ctx.storage.sql;
      q.exec(`CREATE TABLE IF NOT EXISTS players (kh TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', rating REAL NOT NULL, games INTEGER NOT NULL DEFAULT 0,
        w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, peak REAL NOT NULL, streak INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)`);
      q.exec('CREATE INDEX IF NOT EXISTS players_rating ON players (rating DESC)');
      q.exec(`CREATE TABLE IF NOT EXISTS games (room TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, winner INTEGER NOT NULL, by TEXT NOT NULL,
        rated INTEGER NOT NULL, da REAL NOT NULL, db REAL NOT NULL, at INTEGER NOT NULL, out TEXT NOT NULL)`);
      q.exec('CREATE INDEX IF NOT EXISTS games_pair ON games (a, b, at)');
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }
  player(kh) {
    const row = this.sql().exec('SELECT * FROM players WHERE kh = ?', kh).toArray()[0];
    return row || { kh, name: '', rating: ELO.START, games: 0, w: 0, l: 0, peak: ELO.START, streak: 0, updated: 0 };
  }
  rank(rating) { return this.sql().exec('SELECT COUNT(*) AS n FROM players WHERE games > 0 AND rating > ?', rating).one().n + 1; }
  async ladder(req, url) {
    const q = this.sql();
    if (url.pathname === '/vs/ladder') {
      const top = q.exec('SELECT name, rating, games, w, l, streak FROM players WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT ?', ELO.TOP).toArray()
        .map((x, i, a) => ({ rank: i && a[i - 1].rating === x.rating ? null : i + 1, name: x.name || 'Anonymous', rating: Math.round(x.rating), games: x.games, w: x.w, l: x.l, streak: x.streak, provisional: x.games < ELO.PROVISIONAL }));
      top.forEach((x, i) => { if (x.rank === null) x.rank = top[i - 1].rank; });     // a tie shares the rank (as /vs/me counts it)
      return reply({ top, players: q.exec('SELECT COUNT(*) AS n FROM players WHERE games > 0').one().n });
    }
    let body = {};
    try { body = await req.json(); } catch (e) { /* none */ }
    if (url.pathname === '/vs/me') {
      if (!KEY_RE.test(String(body.key || ''))) return reply({ error: 'key wanted' }, 400);
      const p = this.player(await hashKey(body.key));
      return reply({ rating: Math.round(p.rating), games: p.games, w: p.w, l: p.l, streak: p.streak, peak: Math.round(p.peak),
        rank: p.games ? this.rank(p.rating) : null, provisional: p.games < ELO.PROVISIONAL });
    }
    if (url.pathname === '/vs/rating') return reply({ rating: this.player(String(body.kh || '')).rating });
    // /vs/report: from a room object only (never routed from outside: the worker sends /vs/* paths to objects by name)
    const [k0, k1] = body.seats || [];
    if (!k0 || !k1 || k0 === k1 || (body.winner !== 0 && body.winner !== 1) || !ROOM_RE.test(String(body.room || ''))) return reply({ error: 'report' }, 400);
    const done = q.exec('SELECT out FROM games WHERE room = ?', body.room).toArray()[0];
    if (done) return reply(JSON.parse(done.out));
    const now = Date.now(), p = [this.player(k0), this.player(k1)];
    const pairN = q.exec('SELECT COUNT(*) AS n FROM games WHERE rated = 1 AND at > ? AND ((a = ? AND b = ?) OR (a = ? AND b = ?))', now - 86400_000, k0, k1, k1, k0).one().n;
    const rated = pairN < ELO.PAIR_CAP;
    const e0 = 1 / (1 + 10 ** ((p[1].rating - p[0].rating) / 400)), exp = [e0, 1 - e0];
    const before = p.map((x) => x.rating), d = [0, 0];
    p.forEach((x, s) => {
      const win = body.winner === s, k = x.games < ELO.PROVISIONAL ? ELO.K_NEW : ELO.K;
      if (rated) {
        d[s] = k * ((win ? 1 : 0) - exp[s]);
        x.rating = Math.max(ELO.FLOOR, x.rating + d[s]);
        x.games += 1;
        if (win) { x.w += 1; x.streak = x.streak > 0 ? x.streak + 1 : 1; } else { x.l += 1; x.streak = x.streak < 0 ? x.streak - 1 : -1; }
        x.peak = Math.max(x.peak, x.rating);
      }
      const nm = clean(body.names && body.names[s]);
      if (nm) x.name = nm;
      x.updated = now;
      q.exec(`INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kh) DO UPDATE SET name = excluded.name, rating = excluded.rating, games = excluded.games, w = excluded.w, l = excluded.l,
        peak = excluded.peak, streak = excluded.streak, updated = excluded.updated`, x.kh, x.name, x.rating, x.games, x.w, x.l, x.peak, x.streak, x.updated);
    });
    const out = { rated, reason: rated ? null : 'pair', ratings: p.map((x, s) => ({ before: Math.round(before[s]), after: Math.round(x.rating), delta: Math.round(x.rating) - Math.round(before[s]),
      games: x.games, rank: x.games ? this.rank(x.rating) : null, provisional: x.games < ELO.PROVISIONAL })) };
    q.exec('INSERT INTO games (room, a, b, winner, by, rated, da, db, at, out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      body.room, k0, k1, body.winner, String(body.by || 'score'), rated ? 1 : 0, d[0], d[1], now, JSON.stringify(out));
    return reply(out);
  }
}
