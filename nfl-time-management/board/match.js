// Versus: two players, each calling their own side. One Durable Object per room (its code), lobby objects for
// matchmaking ('lobby:<game>:<mode>:<shard>') and one named 'ladder' (the ranked ratings).
//
// Two games (vs_core.js): the Five-Minute Drill ('five': 5:00 of the fourth quarter tied 0-0 under the NFL clock, a
// coin toss, college overtime from a tie) and the overtime shootout ('ot': college overtime only).
//
// The room plays the football. Both phones send their half of each decision (the offense's call, the defense's
// call, the toss, the kickoff, the try); a half stays sealed until every half the decision needs is in, then the room
// plays the snap with the engine (web/engine.js, the same one the phones have) and the rules (web/vs_core.js), and
// sends the result and the new state to both. Nothing a phone says can change the score: it only ever sends a call,
// and the room checks that call against the playbook. Each snap's seed is drawn by the room and never sent to a phone.
//
// The room keeps the play clock: each player has DECIDE_MS to call, from the moment the call comes up on the phone
// ({t:'ready'}), and never past PLAY_MS after the last snap (WATCH_MS to watch it, then the clock); a half not in by
// its seat's deadline is played as the engine's own call (a typical coach's). A player who misses AFK_LIMIT decisions
// in a row, or whose phone is gone for FORFEIT_MS, forfeits. A ranked match is rated by the room when it ends (the
// ladder object), never by a phone; the room tells both phones its own reckoning at once (est), the ladder confirms.
// Ranked plays both teams at the league's average strength (vs_core.js evenPool); casual and friend matches as they are.
// A computer opponent (mode 'cpu', unrated): seat 1 is the engine, its every call the engine's own.
//
//   GET  /vs/ws?room=CODE&key=DEVICEKEY&mode=M&game=G&since=N (WebSocket)  the room: seat by device, the calls, the plays
//   GET  /vs/queue?key=DEVICEKEY&mode=ranked|casual&game=G&team=T&name=X (WebSocket)  matchmaking: a room when paired
//   GET  /vs/ladder                                                    the ranked ladder (the top 50, this week's wins)
//   POST /vs/me {key}                                                  your rating, record and rank
//   GET  /vs/status                                                    on or off, how many are looking (worker.js)
//
// Client -> room: {t:'team', team, name}  this seat's team (once; {t:'taken'} if the other seat has it)
//                 {t:'ready', n}  decision n is up on the phone: its play clock starts ({t:'clock'} back)
//                 {t:'half', n, half}  its half of decision n    {t:'rematch'}  {t:'emote', e}  {t:'ping'}
// Room -> client: {t:'hello', seat, mode, game, teams, names, full, online, off, phase, n, ms, decisions, deadline, dl,
//                   now, result, rated}   on connecting (decisions: the last ones from `since`, to catch up)
//                 {t:'start', ms, deadline, now}  {t:'step', n, halves, kind, res, notes, ms, deadline, now, result}
//                 {t:'clock', n, deadline, now}  this seat's deadline for decision n (dl: both seats')
//                 {t:'oclock', n, seat, deadline, now}  the other seat's call is up: its deadline (whose turn it is)
//                 {t:'locked', n, seat}  {t:'peer', online, off, now}  {t:'teams', teams, names}  {t:'taken', team}
//                 {t:'over', result}  {t:'rated', rated}  {t:'rematch-ask', seat}  {t:'rematch', room}  {t:'emote', seat, e}
// Lobby -> client: {t:'queued', mode, size, wait, rating}  {t:'match', room, mode, game}  {t:'busy'}
import NFLClockEngine from '../web/engine.js';
import VSCore from '../web/vs_core.js';
import { lazySimulator } from './lazy_sim.js';
import TMDScenario from '../web/scenario.js';

// a name nobody should see on the ladder or across the field (worker.js blocked(): the same lists, scenario.js's copy)
const { blocked } = TMDScenario;

// each seat's deadline for the decision in play (a room from before the per-seat clock: the decision's)
const dls = (R) => (Array.isArray(R.dl) && R.dl.length === 2 ? R.dl.slice() : [R.deadline, R.deadline]);

export const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TEAM_RE = /^[A-Z]{2,3}$/;
const MODES = ['ranked', 'casual', 'friend', 'cpu'];
export const GAMES = ['five', 'ot'];
const gameOf = (g) => (GAMES.includes(g) ? g : 'ot');      // (no game named: the shootout, as before the Five-Minute Drill)
// the lobby object for a game and mode: casual spread over `shards` objects (worker var VS_LOBBY_SHARDS, 1 by default:
// more only when one object's joins a second run high), ranked always one (its pairing wants everyone's ratings)
export function lobbyName(game, mode, shards = 1, pickShard = Math.random) {
  const n = mode === 'ranked' ? 1 : Math.max(1, Math.min(64, Math.floor(+shards) || 1));
  return `lobby:${gameOf(game)}:${mode === 'ranked' ? 'ranked' : 'casual'}:${Math.floor(pickShard() * n)}`;
}
export const WATCH_MS = 15_000;            // after a snap: the play to watch (at most) before the play clock runs anyway
export const DECIDE_MS = 30_000;           // the play clock: 30 seconds to call, from the moment the call comes up
export const PLAY_MS = WATCH_MS + DECIDE_MS;    // a decision's last moment after the last snap
export const FIRST_MS = 75_000;            // the first decision (the coin toss): the intro too, then the clock
export const FORFEIT_MS = 90_000;          // a phone gone this long in a live match: that side forfeits (a dropped line comes back well inside it)
export const AFK_LIMIT = 3;                // decisions in a row left to the play clock: that side forfeits
export const NOSHOW_MS = 60_000;           // a matched room nobody filled (or no team picked) in this long: called off
export const CPU_MS = 3_500;               // the computer's call: after the play has been watched a moment
const ROOM_TTL_MS = 6 * 3600_000;          // a room is cleared this long after it was made
const MAX_MSG = 4096, MAX_N = 2000, CATCHUP = 60;
const EMOTES = ['nice', 'choke', 'gg', 'fire', 'wow', 'rematch'], EMOTE_MS = 4000;
// the ladder: Elo. A new player's rating moves faster (K_NEW for the first PROVISIONAL games); no rating below FLOOR;
// the same two players count for the ladder at most PAIR_CAP times a day, and never two phones on one network (no
// farming a friend's second phone)
export const ELO = { START: 1000, K_NEW: 40, K: 24, PROVISIONAL: 10, FLOOR: 100, PAIR_CAP: 3, TOP: 50, CACHE_MS: 30_000 };
// the tiers (game.js VS_TIERS, the Pro ranks' names)
export const TIERS = [[0, 'Rookie play-caller'], [900, 'Position coach'], [1050, 'Coordinator'], [1200, 'Head coach'], [1350, 'Super Bowl coach'], [1500, 'Hall of Fame']];
export const tierOf = (r) => TIERS.filter(([lo]) => r >= lo).pop()[1];
// matchmaking (ranked): two players are paired when their ratings are within WIN_BASE + WIN_PER_S for each second
// the longer of them has waited; after WIN_OPEN_S anyone. A newcomer is matched at once against the band around its
// rating (NEAR on each side); the tick (TICK_MS) widens the windows and tells everyone waiting how many are
export const MM = { WIN_BASE: 100, WIN_PER_S: 20, WIN_OPEN_S: 45, TICK_MS: 3000, NET_COST: 400, NEAR: 64, MAX_QUEUE: 20000, RATING_TTL: 600_000 };

const tidy = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const clean = (n) => { const t = tidy(n); return t && !blocked(t) ? t : ''; };      // a blocked name: none (Anonymous)
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0];       // the server's coin: the toss, each snap's seed
export const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
// the player's network (the address, an IPv6 address's /64: one household's phones), hashed: two phones on one network
// play ranked unrated (no farming a rating off a second phone on the couch). Never kept beyond the room
async function netOf(req) {
  const ip = String(req.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return '';
  const key = ip.includes(':') ? ip.toLowerCase().split(':').slice(0, 4).join(':') : ip;
  return hashKey(`net:${key}`);
}
async function hashKey(k) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`)));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
// a WebSocket that only says {t:'busy'} and closes (a page can read that; it can't read an HTTP status on a socket)
function busySocket() {
  const [client, server] = Object.values(new WebSocketPair());
  if (server.accept) server.accept();
  server.send(JSON.stringify({ t: 'busy' }));
  server.close(4002, 'busy');
  return new Response(null, { status: 101, webSocket: client });
}
// Elo for one result (the ladder's rule; the room reckons the same at once for the end card)
export function eloOf(p, winner) {
  const e0 = 1 / (1 + 10 ** ((p[1].rating - p[0].rating) / 400)), exp = [e0, 1 - e0];
  return p.map((x, s) => {
    const k = x.games < ELO.PROVISIONAL ? ELO.K_NEW : ELO.K, d = k * ((winner === s ? 1 : 0) - exp[s]);
    return { before: x.rating, after: Math.max(ELO.FLOOR, x.rating + d) };
  });
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
      const unz = async (r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const [eb, pbb, pool] = await Promise.all([get('engine_data.pack').then(unz), get('playbook.pack').then(unz), get('teams.json').then((r) => r.json())]);
      const d = VSCore.unpack(eb), pb = VSCore.unpack(pbb, d);         // (the playbook's pack refers to the engine's)
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
    if (url.pathname === '/vs/count') return reply({ waiting: this.waiting().length });
    if (url.pathname === '/vs/rated') {          // a room's rating, just changed: the lobby's copy too (no stale rating in the next match)
      const b = await req.json().catch(() => ({}));
      this.rc = this.rc || new Map();
      for (const x of b.players || []) if (typeof x.kh === 'string') this.rc.set(x.kh, { rating: +x.rating, games: +x.games, at: Date.now() });
      return reply({ ok: true });
    }
    if (url.pathname === '/vs/ladder' || url.pathname === '/vs/me' || url.pathname === '/vs/report' || url.pathname === '/vs/rating') return this.ladder(req, url);
    if (url.pathname === '/vs/init') return this.init(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', room = url.searchParams.get('room') || '';
    if (!KEY_RE.test(key) || !ROOM_RE.test(room)) return new Response('bad room or key', { status: 400 });
    const kh = await hashKey(key), now = Date.now();
    const mode = MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'friend';
    let R = await this.room();
    if (!R && url.searchParams.get('off')) return busySocket();          // Versus off (worker VS_ON): no new match
    if (!R) R = this.fresh(room, mode === 'ranked' ? 'casual' : mode, now, gameOf(url.searchParams.get('game')));    // a ranked room is only ever made by the lobby
    let seat = R.seats.indexOf(kh);
    if (seat < 0 && !R.pre) seat = R.seats.indexOf(null);
    if (seat < 0) return new Response('the room is full', { status: 409 });
    R.seats[seat] = kh;
    R.seen[seat] = true;
    R.off[seat] = 0;
    if (R.phase === 'wait' && this.bothHere(R, seat)) this.begin(R, now);
    await this.save(R);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.ctx.getWebSockets(`s${seat}`)) { try { old.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    this.ctx.acceptWebSocket(server, [`s${seat}`]);
    server.serializeAttachment({ seat });
    const since = Math.max(0, Math.min(R.n, Number.parseInt(url.searchParams.get('since'), 10) || 0, R.n), R.n - CATCHUP);
    const decisions = [];
    for (let i = since; i < R.n; i++) { const d = await this.ctx.storage.get(`d:${i}`); if (d) { delete d.seed; decisions.push(d); } }
    server.send(JSON.stringify({ t: 'hello', seat, mode: R.mode, game: R.game, room: R.room, teams: R.teams, names: R.names, full: R.seen[0] && R.seen[1],
      online: this.online(), off: R.off, phase: R.phase, n: R.n, ms: R.ms, ms0: since === 0 ? R.ms0 || null : null, decisions, deadline: R.deadline, dl: dls(R), now,
      result: R.result, rated: R.rated, cpu: R.cpu ?? null }));
    this.broadcast({ t: 'peer', online: this.online(), off: R.off, full: R.seen[0] && R.seen[1], now });
    const pend = await this.ctx.storage.get('pend');
    if (pend && pend.n === R.n) for (const s of Object.keys(pend.halves)) server.send(JSON.stringify({ t: 'locked', n: pend.n, seat: Number(s) }));
    await this.schedule(R);
    return new Response(null, { status: 101, webSocket: client });
  }

  fresh(room, mode, now, game) {
    const R = { v: 2, room, mode, game: gameOf(game), pre: false, seats: [null, null], seen: [false, false], off: [0, 0],
      created: now, teams: [null, null], names: ['', ''], phase: 'wait', n: 0, ms: null, deadline: 0, defaults: [0, 0], result: null, rated: null };
    if (mode === 'cpu') { R.cpu = 1; R.seats[1] = 'cpu'; R.seen[1] = true; R.names[1] = 'The computer'; }
    return R;
  }
  async room() {
    const R = await this.ctx.storage.get('room');
    if (R && R.v !== 2) { await this.ctx.storage.deleteAll(); return null; }    // a room from before the server played the football
    if (R && !R.game) R.game = 'ot';
    return R || null;
  }
  save(R) { return this.ctx.storage.put('room', R); }
  online(R) {
    const on = [0, 1].map((s) => this.ctx.getWebSockets(`s${s}`).length > 0);
    if (R && R.cpu != null) on[R.cpu] = true;
    return on;
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) { /* closing */ } }
  }

  // a room the lobby (or a rematch) made: its two players, their teams; nobody else gets a seat
  async init(req) {
    const b = await req.json();
    if (await this.ctx.storage.get('room')) return reply({ error: 'taken' }, 409);
    const now = Date.now(), R = this.fresh(b.room, MODES.includes(b.mode) ? b.mode : 'casual', now, b.game);
    R.pre = true;
    R.seats = [b.seats[0], b.seats[1]];
    if (R.cpu != null) { R.seats[R.cpu] = 'cpu'; R.seen[R.cpu] = true; }
    R.teams = [TEAM_RE.test(b.teams && b.teams[0]) ? b.teams[0] : null, TEAM_RE.test(b.teams && b.teams[1]) ? b.teams[1] : null];
    if (R.teams[0] && R.teams[0] === R.teams[1]) R.teams[1] = null;
    R.names = [clean(b.names && b.names[0]), clean(b.names && b.names[1])];
    if (R.cpu != null) R.names[R.cpu] = 'The computer';
    if (Array.isArray(b.nets) && b.nets[0] && b.nets[0] === b.nets[1]) R.sameNet = true;
    if (Array.isArray(b.ratings) && b.ratings.length === 2) R.ratings = b.ratings.map((x) => ({ rating: +x.rating || ELO.START, games: +x.games || 0 }));
    await this.save(R);
    await this.schedule(R);
    return reply({ ok: true });
  }

  // the kickoff waits for both phones to be here, both teams picked: a host who went to send the link (the phone's
  // messages app: its page asleep, its socket closed) is never a forfeit the moment the friend arrives
  bothHere(R, joining) {
    const on = this.online(R);
    if (joining === 0 || joining === 1) on[joining] = true;
    return R.seen[0] && R.seen[1] && on[0] && on[1] && !!R.teams[0] && !!R.teams[1];
  }
  begin(R, now) {
    R.off = [0, 0];
    R.ms = R.ms0 = R.game === 'five' ? VSCore.startFive() : VSCore.start(rand() & 1);
    R.phase = 'live';
    R.n = 0;
    R.deadline = now + FIRST_MS;
    R.dl = [R.deadline, R.deadline];
    if (R.cpu != null) R.dl[R.cpu] = now + CPU_MS;
    R.started = now;
    R.defaults = [0, 0];
    this.broadcast({ t: 'start', ms: R.ms, deadline: R.deadline, dl: R.dl, now });
  }

  // the next time the room has to act: a deadline, a forfeit, a no-show, a rating to retry, the end of the room
  async schedule(R) {
    const t = [R.created + ROOM_TTL_MS];
    if (R.phase === 'live') {
      const pend = await this.ctx.storage.get('pend'), dl = dls(R);
      for (const s of VSCore.need(R.ms)) if (!(pend && pend.n === R.n && s in pend.halves)) t.push(dl[s]);    // the calls still out
      for (const s of [0, 1]) if (R.off[s]) t.push(R.off[s] + FORFEIT_MS);
    }
    if (R.phase === 'wait' && R.pre) t.push(R.created + NOSHOW_MS);
    if (R.phase === 'over' && R.mode === 'ranked' && R.result && R.result.winner >= 0 && !R.rated) t.push(Date.now() + 5000);
    await this.ctx.storage.setAlarm(Math.min(...t));
  }

  stepper(R, E) {
    const k = `${R.teams[0]}|${R.teams[1]}|${R.mode === 'ranked' ? 'even' : 'real'}`;
    if (!this.steppers.has(k)) this.steppers.set(k, VSCore.stepper(E.eng, E.pool, R.teams[0], R.teams[1], E.eng.lib ? lazySimulator : undefined, R.mode === 'ranked'));
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
    if (m.t === 'emote') {         // a preset only (no free text), a few seconds apart
      const now = Date.now(), last = (this.emoteAt || [0, 0])[seat];
      if (!EMOTES.includes(m.e) || now - last < EMOTE_MS) return;
      this.emoteAt = this.emoteAt || [0, 0]; this.emoteAt[seat] = now;
      this.broadcast({ t: 'emote', seat, e: m.e });
      return;
    }
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
      // the computer's team: another one, at random
      if (R.cpu != null && !R.teams[R.cpu]) { const all = Object.keys(E.pool.teams).filter((x) => x !== m.team); R.teams[R.cpu] = all[rand() % all.length]; }
      this.broadcast({ t: 'teams', teams: R.teams, names: R.names });
      if (this.bothHere(R, seat)) this.begin(R, now);
      await this.save(R);
      await this.schedule(R);
      return;
    }
    if (m.t === 'rematch') return this.rematch(R, seat);
    if (m.t === 'ready') {
      // the call is up on this phone: its 30 seconds start (never later than the decision's last moment)
      if (R.phase !== 'live' || m.n !== R.n || !VSCore.need(R.ms).includes(seat)) return;
      R.dl = dls(R);
      R.dl[seat] = Math.min(R.dl[seat], now + DECIDE_MS);
      await this.save(R);
      try { ws.send(JSON.stringify({ t: 'clock', n: R.n, deadline: R.dl[seat], now })); } catch (e) { /* closing */ }
      // the other side sees whose turn it is: this seat's play clock running (never its call)
      for (const o of this.ctx.getWebSockets(`s${1 - seat}`)) { try { o.send(JSON.stringify({ t: 'oclock', n: R.n, seat, deadline: R.dl[seat], now })); } catch (e) { /* closing */ } }
      await this.schedule(R);
      return;
    }
    if (m.t !== 'half' || R.phase !== 'live' || m.n !== R.n || R.n >= MAX_N) return;
    if (!VSCore.need(R.ms).includes(seat)) return;
    let pend = await this.ctx.storage.get('pend');
    if (!pend || pend.n !== R.n) pend = { n: R.n, halves: {} };
    if (seat in pend.halves) return;                                   // a call, once locked, stays
    pend.halves[seat] = VSCore.cleanHalf(R.ms, seat, m.half, E.eng.pb);
    R.defaults[seat] = pend.halves[seat] ? 0 : R.defaults[seat] + 1;   // nothing usable (the phone's clock ran out): a default
    // the computer answers at once once its opponent has (its call is the engine's own)
    if (R.cpu != null && VSCore.need(R.ms).includes(R.cpu) && !(R.cpu in pend.halves)) pend.halves[R.cpu] = null;
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
    R.dl = [R.deadline, R.deadline];
    if (R.cpu != null) R.dl[R.cpu] = now + (out.res ? WATCH_MS / 2 : CPU_MS);    // (after its play has been watched)
    let result = null;
    if (out.ms.over) {
      R.phase = 'over';
      result = R.result = { winner: out.ms.winner, by: 'score', score: out.ms.root.score.slice(), round: out.ms.cot ? out.ms.cot.round : 0, t: out.ms.root.t, ...this.est(R, out.ms.winner) };
    }
    await this.save(R);
    this.broadcast({ t: 'step', ...d, deadline: R.deadline, dl: R.dl, now, result });
    if (result) { this.steppers.clear(); return this.rate(R); }
    const afk = [0, 1].filter((s) => s !== R.cpu && R.defaults[s] >= AFK_LIMIT);
    if (afk.length === 2) return this.finish(R, { winner: -1, by: 'abandoned' });
    if (afk.length === 1) return this.finish(R, { winner: 1 - afk[0], by: 'forfeit', loser: afk[0], why: 'afk' });
    if (R.n >= MAX_N) return this.finish(R, { winner: -1, by: 'error' });
    await this.schedule(R);
  }
  // the room's own reckoning of a ranked result (the ladder's rule), for the end card at once: the ladder confirms
  est(R, winner) {
    if (R.mode !== 'ranked' || !(winner >= 0) || !R.ratings) return {};
    if (R.sameNet) return { est: { rated: false, reason: 'network' } };
    return { est: { rated: true, ratings: eloOf(R.ratings, winner).map((x) => ({ before: Math.round(x.before), after: Math.round(x.after), delta: Math.round(x.after) - Math.round(x.before) })) } };
  }

  // over without the last snap: a forfeit, a no-show, both gone, an error
  async finish(R, result) {
    this.steppers.clear();
    R.phase = 'over';
    R.result = { ...result, score: R.ms ? R.ms.root.score.slice() : [0, 0], round: R.ms && R.ms.cot ? R.ms.cot.round : 0, ...this.est(R, result.winner) };
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
        method: 'POST', body: JSON.stringify({ room: R.room, seats: R.seats, names: R.names, winner: R.result.winner, by: R.result.by, same: !!R.sameNet }) }));
      if (!res.ok) throw new Error(`ladder ${res.status}`);
      const rated = await res.json();
      const R2 = (await this.room()) || R;
      R2.rated = rated;
      await this.save(R2);
      this.broadcast({ t: 'rated', rated });
      if (rated.ratings) {
        const players = rated.ratings.map((x, s) => ({ kh: R2.seats[s], rating: x.exact ?? x.after, games: x.games }));
        try { await this.env.MATCH.get(this.env.MATCH.idFromName(lobbyName(R2.game, 'ranked'))).fetch(new Request('https://lobby/vs/rated', { method: 'POST', body: JSON.stringify({ players }) })); } catch (e) { /* the copy ages out */ }
      }
      await this.schedule(R2);
    } catch (e) {
      console.error('vs rate', R.room, e && e.message);
      R.rateTries = (R.rateTries || 0) + 1;
      if (R.rateTries > 20) { R.rated = { rated: false, reason: 'ladder' }; await this.save(R); this.broadcast({ t: 'rated', rated: R.rated }); return; }
      await this.save(R);
      await this.schedule(R);                                           // retried by the alarm
    }
  }

  // both have to ask (the computer always will): then one new room for both, the same teams, the other seat first
  // (so the other player calls the toss), never ranked
  async rematch(R, seat) {
    if (R.phase !== 'over' || !R.seats.every(Boolean)) return;
    R.again = [...new Set([...(R.again || []), seat, ...(R.cpu != null ? [R.cpu] : [])])];
    if (R.again.length < 2) { await this.save(R); this.broadcast({ t: 'rematch-ask', seat }); return; }
    let next = R.next;
    if (!next) {
      await this.save(R);
      // one new room, however many times they tap: nothing else gets in while it is made
      next = await this.ctx.blockConcurrencyWhile(async () => {
        const R2 = await this.room();
        if (R2.next) return R2.next;
        const flip = R2.cpu == null;
        for (let i = 0; i < 5; i++) {
          const code = roomCode();
          const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${code}`)).fetch(new Request('https://room/vs/init', {
            method: 'POST', body: JSON.stringify({ room: code, game: R2.game, mode: R2.mode === 'friend' || R2.mode === 'cpu' ? R2.mode : 'casual',
              seats: flip ? [R2.seats[1], R2.seats[0]] : R2.seats, teams: flip ? [R2.teams[1], R2.teams[0]] : R2.teams, names: flip ? [R2.names[1], R2.names[0]] : R2.names }) }));
          if (r.ok) { R2.next = code; await this.save(R2); return code; }
        }
        return null;
      });
      if (!next) return;
    }
    this.broadcast({ t: 'rematch', room: next });
  }

  async alarm() {
    if (this.lobby()) return this.pairTick();
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
      // a seat's play clock out: its call is the engine's own; every call in: the snap
      const pend0 = await this.ctx.storage.get('pend'), dl0 = dls(R);
      const out0 = (p, dl, r) => VSCore.need(r.ms).filter((s) => !(p && p.n === r.n && s in p.halves) && now >= dl[s] - 50);
      if (out0(pend0, dl0, R).length) {
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
        const late = out0(pend, dls(R2), R2);
        for (const s of late) { pend.halves[s] = null; if (s !== R2.cpu) R2.defaults[s] += 1; }
        if (VSCore.need(R2.ms).every((s) => s in pend.halves)) return this.commit(R2, pend, E, Date.now());
        await this.ctx.storage.put('pend', pend);
        await this.save(R2);
        for (const s of late) this.broadcast({ t: 'locked', n: pend.n, seat: s });
        return this.schedule(R2);
      }
    }
    if (R.phase === 'wait' && R.pre && now >= R.created + NOSHOW_MS) {
      // ranked: matched and never came (or never picked a team) is a loss, so nobody dodges an opponent; else called off
      const on = this.online(R), missing = [0, 1].filter((s) => !R.seen[s] || !R.teams[s] || !on[s]);
      if (R.mode === 'ranked' && missing.length === 1) return this.finish(R, { winner: 1 - missing[0], by: 'forfeit', loser: missing[0], why: 'noshow' });
      return this.finish(R, { winner: -1, by: 'noshow', missing });
    }
    if (R.phase === 'over' && R.mode === 'ranked' && !R.rated && R.result && R.result.winner >= 0) return this.rate(R);
    await this.schedule(R);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* closed */ }
    const a = ws.deserializeAttachment() || {};
    if (a.q) { this.unqueue(ws); return; }                             // a lobby ticket: gone from the queue
    if (a.seat !== 0 && a.seat !== 1) return;
    if (this.ctx.getWebSockets(`s${a.seat}`).some((x) => x !== ws)) return;   // still there on another tab
    const R = await this.room();
    if (!R) return;
    if (R.phase !== 'over') R.off[a.seat] = Date.now();
    await this.save(R);
    const online = this.online(R).map((on, s) => on && (s === R.cpu || !this.ctx.getWebSockets(`s${s}`).every((x) => x === ws)));
    this.broadcast({ t: 'peer', online, off: R.off, full: R.seen[0] && R.seen[1], now: Date.now() });
    await this.schedule(R);
  }
  webSocketError(ws) { return this.webSocketClose(ws); }

  // ------------------------------------------------------------------------------------------------ the lobby ---
  // A lobby object ('lobby:<game>:<mode>:<shard>', worker.js picks it) holds the players waiting for one game and
  // mode, each a WebSocket (a ticket: device, team, name, rating, network, since), and in memory: casual first come
  // (a list), ranked by rating (a list kept sorted). A newcomer is paired at once with the best fit near it (never
  // the whole queue); the tick (TICK_MS) widens the ranked windows and tells everyone waiting how many are. The room
  // is made after the pairing, outside any lock: joins never wait on another object. Ranked ratings are kept here a
  // while (RATING_TTL), so a join asks the ladder at most once in a while.
  lobby() { return this.ctx.getWebSockets('q').length > 0 || !!this.Q; }
  // the queues: one list per game and mode (casual in arrival order, ranked sorted by rating)
  queues() {
    if (!this.Q) {          // (after the object slept: the tickets from the sockets themselves)
      this.Q = new Map();
      for (const ws of this.ctx.getWebSockets('q')) { const a = ws.deserializeAttachment() || {}; if (a.q && !a.paired) this.listOf(a).push({ ...a, ws }); }
      for (const [k, L] of this.Q) L.sort((x, y) => (k.endsWith(':ranked') ? x.rating - y.rating : x.since - y.since));
    }
    return this.Q;
  }
  listOf(t) {
    const k = `${t.game}:${t.mode}`;
    if (!this.Q.has(k)) this.Q.set(k, []);
    return this.Q.get(k);
  }
  waiting() { return [...this.queues().values()].flat(); }
  unqueue(ws) {
    const a = ws.deserializeAttachment() || {};
    for (const L of this.queues().values()) { const i = L.findIndex((t) => t.ws === ws); if (i >= 0) { L.splice(i, 1); return; } }
    return a;
  }
  async queue(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', mode = url.searchParams.get('mode') === 'ranked' ? 'ranked' : 'casual';
    const team = url.searchParams.get('team') || '', game = gameOf(url.searchParams.get('game'));
    if (!KEY_RE.test(key) || !TEAM_RE.test(team)) return new Response('bad key or team', { status: 400 });
    // (VS_NET_CHECK "off": a load test's throwaway worker, its players all on one machine: vs_load.yml)
    const kh = await hashKey(key), name = clean(url.searchParams.get('name')), net = this.env.VS_NET_CHECK === 'off' ? '' : await netOf(req);
    let rating = ELO.START, games = 0;
    if (mode === 'ranked') {
      this.rc = this.rc || new Map();
      const c = this.rc.get(kh);
      if (c && Date.now() - c.at < MM.RATING_TTL) ({ rating, games } = c);
      else {
        try {
          const r = await this.env.MATCH.get(this.env.MATCH.idFromName('ladder')).fetch(new Request('https://ladder/vs/rating', { method: 'POST', body: JSON.stringify({ kh }) }));
          const x = await r.json();
          rating = x.rating || ELO.START; games = x.games || 0;
          if (this.rc.size > 50000) this.rc.clear();
          this.rc.set(kh, { rating, games, at: Date.now() });
        } catch (e) { /* the default */ }
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const max = +(this.env.VS_MAX_QUEUE || MM.MAX_QUEUE);
    if (this.waiting().length >= max) return busySocket();          // full: say so (the page offers the computer), never a hang
    for (const t of this.waiting().filter((x) => x.kh === kh)) { this.unqueue(t.ws); try { t.ws.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    this.ctx.acceptWebSocket(server, ['q']);
    const tk = { q: true, kh, mode, game, team, name, rating, games, net, since: Date.now() };
    server.serializeAttachment(tk);
    tk.ws = server;
    const best = this.fit(tk, Date.now());
    if (best) this.pairUp(tk, best);
    else this.enqueue(tk);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + MM.TICK_MS);
    if (!best) { try { server.send(JSON.stringify({ t: 'queued', mode, game, size: this.listOf(tk).length, wait: 0, rating: Math.round(rating) })); } catch (e) { /* gone */ } }
    return new Response(null, { status: 101, webSocket: client });
  }
  enqueue(tk) {
    const T = this.listOf(tk);
    if (tk.mode !== 'ranked') { T.push(tk); return; }
    let lo = 0, hi = T.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid].rating < tk.rating) lo = mid + 1; else hi = mid; }
    T.splice(lo, 0, tk);
  }
  // the best partner for a ticket now: casual, whoever has waited longest; ranked, the nearest rating within the window
  fit(a, now) {
    this.queues();
    const T = this.listOf(a);
    if (a.mode !== 'ranked') return T.find((b) => b !== a && b.kh !== a.kh) || null;
    let lo = 0, hi = T.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid].rating < a.rating) lo = mid + 1; else hi = mid; }
    let best = null, bestCost = Infinity;
    for (let i = Math.max(0, lo - MM.NEAR); i < Math.min(T.length, lo + MM.NEAR); i++) {
      const b = T[i];
      if (b === a || b.kh === a.kh) continue;
      const wait = (now - Math.min(a.since, b.since)) / 1000, gap = Math.abs(a.rating - b.rating);
      // (two phones on one network only once nobody else has come in WIN_OPEN_S, and then unrated)
      const same = !!a.net && a.net === b.net;
      if (wait < MM.WIN_OPEN_S && (same || gap > MM.WIN_BASE + MM.WIN_PER_S * wait)) continue;
      const cost = gap + (same ? MM.NET_COST : 0) + (a.team === b.team ? 50 : 0);
      if (cost < bestCost || (cost === bestCost && b.since < best.since)) { best = b; bestCost = cost; }     // (a tie: who waited longer)
    }
    return best;
  }
  // a pair: out of the queue now; the room made (another object) without holding anything up; both told. The one
  // who waited longer (b) is seat 0: the home side, who calls the toss
  pairUp(a, b) {
    this.unqueue(a.ws); this.unqueue(b.ws);
    for (const t of [a, b]) { try { t.ws.serializeAttachment({ q: true, kh: t.kh, paired: true }); } catch (e) { /* gone */ } }
    const p = this.makeRoom(a.mode, a.game, b, a).then((room) => {
      for (const t of [a, b]) {
        try {
          if (room) { t.ws.send(JSON.stringify({ t: 'match', room, mode: a.mode, game: a.game })); t.ws.close(1000, 'matched'); }
          else { t.ws.send(JSON.stringify({ t: 'busy' })); t.ws.close(4002, 'busy'); }
        } catch (e) { /* gone: the room calls it off */ }
      }
    });
    if (this.ctx.waitUntil) this.ctx.waitUntil(p);
    return p;
  }
  async pairTick() {
    const now = Date.now();
    // ranked: the windows widen while they wait (the longest waiting first)
    for (const [k, T] of this.queues()) {
      if (!k.endsWith(':ranked') || T.length < 2) continue;
      for (const a of [...T].sort((x, y) => x.since - y.since)) {
        if (!T.includes(a)) continue;
        const b = this.fit(a, now);
        if (b) this.pairUp(a, b);
      }
    }
    let left = 0;
    for (const T of this.queues().values()) {
      left += T.length;
      for (const t of T) { try { t.ws.send(JSON.stringify({ t: 'queued', mode: t.mode, game: t.game, size: T.length, wait: Math.round((now - t.since) / 1000), rating: Math.round(t.rating) })); } catch (e) { /* closing */ } }
    }
    if (left) await this.ctx.storage.setAlarm(now + MM.TICK_MS);
  }
  async makeRoom(mode, game, a, b) {
    // (the one who waited longer is seat 0: the home side, who calls the toss)
    for (let i = 0; i < 5; i++) {
      const room = roomCode();
      try {
        const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${room}`)).fetch(new Request('https://room/vs/init', {
          method: 'POST', body: JSON.stringify({ room, mode, game, seats: [a.kh, b.kh], teams: [a.team, b.team], names: [a.name, b.name], nets: [a.net || '', b.net || ''],
            ratings: [{ rating: a.rating, games: a.games }, { rating: b.rating, games: b.games }] }) }));
        if (r.ok) return room;
      } catch (e) { console.error('vs room', e && e.message); }
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
      q.exec('CREATE INDEX IF NOT EXISTS players_ranked ON players (games, rating)');
      q.exec(`CREATE TABLE IF NOT EXISTS games (room TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, winner INTEGER NOT NULL, by TEXT NOT NULL,
        rated INTEGER NOT NULL, da REAL NOT NULL, db REAL NOT NULL, at INTEGER NOT NULL, out TEXT NOT NULL)`);
      q.exec('CREATE INDEX IF NOT EXISTS games_pair ON games (a, b, at)');
      q.exec('CREATE INDEX IF NOT EXISTS games_at ON games (at)');
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
      // (kept CACHE_MS: thousands of phones reading the ladder are one query)
      if (this.top && Date.now() - this.top.at < ELO.CACHE_MS) return reply(this.top.body);
      const top = q.exec('SELECT name, rating, games, w, l, streak FROM players WHERE games > 0 ORDER BY rating DESC, games DESC LIMIT ?', ELO.TOP).toArray()
        .map((x, i, a) => ({ rank: i && a[i - 1].rating === x.rating ? null : i + 1, name: x.name || 'Anonymous', rating: Math.round(x.rating), games: x.games, w: x.w, l: x.l, streak: x.streak, provisional: x.games < ELO.PROVISIONAL, tier: tierOf(x.rating) }));
      top.forEach((x, i) => { if (x.rank === null) x.rank = top[i - 1].rank; });     // a tie shares the rank (as /vs/me counts it)
      // this week's most wins (rated games, the last 7 days)
      const week = q.exec(`SELECT p.name AS name, COUNT(*) AS wins FROM games g JOIN players p ON p.kh = CASE g.winner WHEN 0 THEN g.a ELSE g.b END
        WHERE g.rated = 1 AND g.at > ? GROUP BY p.kh ORDER BY wins DESC LIMIT 5`, Date.now() - 7 * 86400_000).toArray().map((x) => ({ name: x.name || 'Anonymous', wins: x.wins }));
      const body = { top, week, players: q.exec('SELECT COUNT(*) AS n FROM players WHERE games > 0').one().n, tiers: TIERS };
      this.top = { at: Date.now(), body };
      return reply(body);
    }
    let body = {};
    try { body = await req.json(); } catch (e) { /* none */ }
    if (url.pathname === '/vs/me') {
      if (!KEY_RE.test(String(body.key || ''))) return reply({ error: 'key wanted' }, 400);
      const p = this.player(await hashKey(body.key));
      return reply({ rating: Math.round(p.rating), games: p.games, w: p.w, l: p.l, streak: p.streak, peak: Math.round(p.peak),
        rank: p.games ? this.rank(p.rating) : null, provisional: p.games < ELO.PROVISIONAL, tier: tierOf(p.rating) });
    }
    if (url.pathname === '/vs/rating') { const p = this.player(String(body.kh || '')); return reply({ rating: p.rating, games: p.games }); }
    // /vs/report: from a room object only (never routed from outside: the worker sends /vs/* paths to objects by name)
    const [k0, k1] = body.seats || [];
    if (!k0 || !k1 || k0 === k1 || (body.winner !== 0 && body.winner !== 1) || !ROOM_RE.test(String(body.room || ''))) return reply({ error: 'report' }, 400);
    const done = q.exec('SELECT out FROM games WHERE room = ?', body.room).toArray()[0];
    if (done) return reply(JSON.parse(done.out));
    const now = Date.now(), p = [this.player(k0), this.player(k1)];
    const pairN = q.exec('SELECT COUNT(*) AS n FROM games WHERE rated = 1 AND at > ? AND ((a = ? AND b = ?) OR (a = ? AND b = ?))', now - 86400_000, k0, k1, k1, k0).one().n;
    const rated = pairN < ELO.PAIR_CAP && !body.same;
    const before = p.map((x) => x.rating), d = [0, 0], after = eloOf(p, body.winner);
    p.forEach((x, s) => {
      const win = body.winner === s;
      if (rated) {
        d[s] = after[s].after - x.rating;
        x.rating = after[s].after;
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
    const out = { rated, reason: rated ? null : body.same ? 'network' : 'pair', ratings: p.map((x, s) => ({ before: Math.round(before[s]), after: Math.round(x.rating), exact: x.rating, delta: Math.round(x.rating) - Math.round(before[s]),
      games: x.games, rank: x.games ? this.rank(x.rating) : null, provisional: x.games < ELO.PROVISIONAL, tier: tierOf(x.rating) })) };
    q.exec('INSERT INTO games (room, a, b, winner, by, rated, da, db, at, out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      body.room, k0, k1, body.winner, String(body.by || 'score'), rated ? 1 : 0, d[0], d[1], now, JSON.stringify(out));
    return reply(out);
  }
}
