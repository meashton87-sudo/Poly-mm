// Versus: two players, college overtime, each calling their own side. One Durable Object per room (its code), one
// named 'lobby' (matchmaking) and one named 'ladder' (the ranked ratings).
//
// The room plays the football. Both phones send their half of each decision (the offense's call, the defense's
// call, the coin-toss choice, the try); a half stays sealed until every half the decision needs is in, then the room
// plays the snap with the engine (web/engine.js, the same one the phones have) and the college-overtime rules
// (web/vs_core.js), and sends the result and the new state to both. Nothing a phone says can change the score: it
// only ever sends a call, and the room checks that call against the playbook.
//
// The room keeps the play clock: each player has decideMs to call (the defense DEF_MS, the offense OFF_MS, a pick or
// a try DECIDE_MS), from the moment the call comes up on the phone
// ({t:'ready'}), and never past PLAY_MS after the last snap (WATCH_MS to watch it, then the clock); a half not in by
// its seat's deadline is played as the default (null: the engine's own call). A player who misses AFK_LIMIT
// decisions in a row, or whose phone is gone for FORFEIT_MS, forfeits. A ranked match is rated by the room when it ends (the ladder object), never by a phone.
//
//   GET  /vs/ws?room=CODE&key=DEVICEKEY&mode=M&since=N (WebSocket)  the room: seat by device, the calls, the plays
//   GET  /vs/queue?key=DEVICEKEY&mode=ranked|casual|cpu&team=T&name=X (WebSocket)  matchmaking: a room when paired
//        (mode cpu: the computer at once, never in the queue)
//   GET  /vs/ladder                                                    the ranked ladder (the top 50)
//   POST /vs/me {key}                                                  your rating, record and rank
//
// Client -> room: {t:'team', team, name}  this seat's team (once; {t:'taken'} if the other seat has it)
//                 {t:'ready', n}  decision n is up on the phone: its play clock starts ({t:'clock'} back)
//                 {t:'half', n, half}  its half of decision n    {t:'rematch'}  {t:'ping'}
// Room -> client: {t:'hello', seat, mode, teams, names, full, online, off, phase, n, ms, decisions, deadline, dl, now,
//                   result, rated}   on connecting (decisions: the last ones from `since`, to catch up)
//                 {t:'start', ms, deadline, now}  {t:'step', n, halves, kind, res, notes, ms, deadline, now, result}
//                 {t:'clock', n, deadline, now}  this seat's deadline for decision n (dl: both seats')
//                 {t:'locked', n, seat}  {t:'peer', online, off, now}  {t:'teams', teams, names}  {t:'taken', team}
//                 {t:'over', result}  {t:'rated', rated}  {t:'rematch-ask', seat}  {t:'rematch', room}
// The draft (mode 'draft', or ?draft=1 on a friend's or the computer's room; VSCore.DRAFT): hello.draft is null, {pending:true}
// (the other side not in yet) or the view (draftView: i, n, card {k, team, pos, name, sticker}, budget, need, picks, bid {seat, amount},
// max, floor (the least each side may open at), pass, steal (each side's one Steal still unused), canSteal (on this card), left, last, done); {t:'draft', d} a new card up, the last one with teams and draftTeams; {t:'bid', i, seat, amount,
// left} a bid in; {t:'pass', i, seat} a pass; {t:'stillhere', by} to a side DRAFT_IDLE_CARDS cards without a bid (answered by
// any message of its own within STILL_MS, else it forfeits: {t:'over', result {by:'forfeit', why:'away'}}). Client -> room:
// {t:'bid', i, amount} (the floor or more to open, over the bid in after, within max[seat]; on a kind the side has filled, its
// Steal), {t:'pass', i} (out of this card: settled at once when the other side holds the bid, has passed too or cannot bid),
// {t:'here'} (still here).
// Lobby -> client: {t:'queued', mode, size, wait, rating, cpu}  {t:'match', room, mode}
// Client -> lobby: {t:'cpu'}  play the computer now (offered once a ticket has waited CPU_AFTER_S)
//
// The computer (mode 'cpu', never rated): seat CPU_SEAT is no phone. Its half of every decision is the default, the
// engine's own call: what NFL play-callers call in that spot, as often as they call it (the toss: defense, the try:
// the kick), so it plays like an average NFL staff. It is in at once, never late, never away, never a forfeit.
import NFLClockEngine from '../web/engine.js';
import VSCore from '../web/vs_core.js';
import { lazySimulator } from './lazy_sim.js';

// each seat's deadline for the decision in play (a room from before the per-seat clock: the decision's)
// a seat on defense in the decision in play (its call, or its call against a kick): a missed one is its default, never a
// forfeit count (15 seconds is short, and the default is a real call)
const onDefense = (ms, seat) => { const r = VSCore.role(ms, seat); return r === 'defense' || r === 'kickdef'; };
const dls = (R) => (Array.isArray(R.dl) && R.dl.length === 2 ? R.dl.slice() : [R.deadline, R.deadline]);

export const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TEAM_RE = /^[A-Z]{2,3}$/;
const MODES = ['ranked', 'casual', 'friend', 'cpu', 'cup', 'draft'];    // (draft: Versus Draft, two players who bid for their lineups first; never rated)
export const CPU_SEAT = 1, CPU_KEY = 'cpu', CPU_NAME = 'Computer';
export const CPU_AFTER_S = 20;             // waiting this long in the queue: the computer is offered (casual or ranked)
// against the computer nobody waits on you: no 30-second play clock (a call has this long, the room's clock only to
// close a match left open), and a phone locked or away this long, not a minute, before it counts as leaving
export const CPU_DECIDE_MS = 10 * 60_000;
// the computer's own call: in at once (cpuTurn); if that ever fails (the engine still loading), the room's alarm puts it
// in this soon after, never at the player's deadline (a load test's matches sat 10 minutes on the computer's toss)
export const CPU_TURN_MS = 3000;
// the computer's level: 'pro' calls as NFL play-callers do (the engine's own call); 'rookie' makes a rookie's calls (deep
// shots on any down, field goals early, a soft defense with a light rush). vs_cpu_test.mjs measures both: the calls move
// a match only a few points either way, so the rookie is only a little easier
export const CPU_LEVELS = ['rookie', 'pro'];
// (what a rookie play-caller does: throws deep on any down, settles for field goals, sits back soft with three or four
// rushing)
const ROOKIE_CALLS = ['deep_strong', 'deep_weak', 'deep_middle', 'pa_deep', 'deep_middle'];
const ROOKIE_DEF = [{ pers: 'dime', front: 'light', cover: 'prevent', rush: 3 }, { pers: 'dime', front: 'light', cover: 'c4', rush: 3 }, { pers: 'nickel', front: 'light', cover: 'prevent', rush: 4 }];
export const WATCH_MS = 15_000;            // after a snap: the play to watch (at most) before the play clock runs anyway
export const DECIDE_MS = 30_000;           // the play clock: 30 seconds to call, from the moment the call comes up (a pick, a try)
export const DEF_MS = 15_000;              // ... at a snap the defense has 15 seconds to commit (the owner, Oct 23)
export const OFF_MS = 20_000;              // ... then the offense 20 to call its play, from the moment the defense is in
export const INTENT_MS = 15_000;           // ... and on 4th down, 15 to say go for it or kick, before either
// a seat's play clock for the decision in play: by its role (the defense or its call on a kick, the offense or its
// kick, 4th down's question, the pick or the try)
export const decideMs = (ms, seat) => {
  const r = VSCore.role(ms, seat);
  return r === 'defense' || r === 'kickdef' ? DEF_MS : r === 'offense' || r === 'kick' ? OFF_MS : r === 'intent' ? INTENT_MS : DECIDE_MS;
};
// the offense's clock waits on the defense: at a snap (and at a kick) the defense calls first, the offense's 20
// seconds start when the defense's call is in (or its clock ran out)
const ON_DEF = (ms) => VSCore.need(ms).length === 2 && !ms.cot.pick;
export const PLAY_MS = WATCH_MS + DEF_MS + OFF_MS + 5000;    // a decision's last moment after the last snap
export const FIRST_MS = 75_000;            // the first decision (the coin toss): the intro too, then the clock
export const FORFEIT_MS = 20_000;          // a phone gone this long in a live match or a draft: that side forfeits (the owner, Oct 27: 20 seconds)
export const AFK_LIMIT = 2;                // decisions in a row left to the play clock: that side forfeits
export const DRAFT_IDLE_CARDS = 3;         // the draft: cards in a row a side could have bid on and did not (passed, or let the clock run): "still here?"
export const STILL_MS = 20_000;            // ... answered (a tap, a bid, a pass) within this, or that side is out and the draft is over (the owner, Oct 27)
export const NOSHOW_MS = 60_000;           // a matched room nobody filled (or no team picked) in this long: called off
const ROOM_TTL_MS = 6 * 3600_000;          // a room is cleared this long after it was made
const MAX_MSG = 4096, MAX_N = 2000, CATCHUP = 40;
// the ladder: Elo. A new player's rating moves faster (K_NEW for the first PROVISIONAL games); no rating below FLOOR;
// the same two players count for the ladder at most PAIR_CAP times a day (no farming a friend's second phone)
export const ELO = { START: 1000, K_NEW: 40, K: 24, PROVISIONAL: 10, FLOOR: 100, PAIR_CAP: 3, TOP: 50 };
// matchmaking (ranked): two players are paired when their ratings are within WIN_BASE + WIN_PER_S for each second
// the longer of them has waited; after WIN_OPEN_S anyone
export const MM = { WIN_BASE: 100, WIN_PER_S: 20, WIN_OPEN_S: 45, TICK_MS: 2000 };
// The Cup (the owner, Oct 22): the top `size` on the ranked ladder at `qualifyAt` (with their placement games played:
// `minGames`) play a single-elimination bracket from `startAt`, seeded by rating (1 v 16, 8 v 9, ...; fewer than 16: the
// top seeds get byes). Each match's room is made with both seats taken as soon as both its players are known; a player
// not in (and on a team) `showMs` after it opens loses it, neither: the higher seed goes on. Results come from the rooms,
// never a phone. The worker vars CUP_ID, CUP_QUALIFY_AT, CUP_START_AT and CUP_PRIZE set another one
// (the first, Oct 25, was The Invitational ($50); its champion stays on as cupPast, shown atop the lobby)
export const CUP = { id: 's1', name: 'Season 1 Championship', qualifyAt: '2026-11-01T17:00:00Z', startAt: '2026-11-01T23:00:00Z', size: 16, minGames: 5, showMs: 10 * 60_000, prize: '' };
export const cupConfig = (env = {}) => {
  const size = [2, 4, 8, 16, 32].includes(Number(env.CUP_SIZE)) ? Number(env.CUP_SIZE) : CUP.size;
  const c = { ...CUP, id: env.CUP_ID || CUP.id, name: env.CUP_NAME || CUP.name, qualifyAt: env.CUP_QUALIFY_AT || CUP.qualifyAt, startAt: env.CUP_START_AT || CUP.startAt, prize: env.CUP_PRIZE ?? CUP.prize,
    size, minGames: Number.isInteger(Number(env.CUP_MIN_GAMES)) && env.CUP_MIN_GAMES !== undefined && env.CUP_MIN_GAMES !== '' ? Number(env.CUP_MIN_GAMES) : CUP.minGames };
  return { ...c, qAt: Date.parse(c.qualifyAt), sAt: Date.parse(c.startAt) };
};
// The season (the owner, Oct 25): ranked games count from startAt to endAt, everyone from ELO.START (the beta's ratings
// kept in the table past, never shown); the season's Championship (CUP) takes its top 16 as the season ends. The worker
// vars SEASON_ID, SEASON_NAME, SEASON_START_AT and SEASON_END_AT set another one
export const SEASON = { id: 's1', name: 'Season 1', startAt: '2026-10-26T14:00:00Z', endAt: '2026-11-01T17:00:00Z' };
export const seasonConfig = (env = {}) => {
  const c = { id: env.SEASON_ID || SEASON.id, name: env.SEASON_NAME || SEASON.name, startAt: env.SEASON_START_AT || SEASON.startAt, endAt: env.SEASON_END_AT || SEASON.endAt };
  return { ...c, sAt: Date.parse(c.startAt), eAt: Date.parse(c.endAt) };
};
// the bracket's first round by seed (0 the top seed), the standard order: 1 v 16, 8 v 9, 4 v 13, 5 v 12 | 2 v 15, 7 v 10,
// 3 v 14, 6 v 11 (the top two can only meet in the final)
const seedOrder = (n) => { let o = [0]; while (o.length < n) { const m = o.length * 2; o = o.flatMap((x) => [x, m - 1 - x]); } return o; };
export function cupBracket(nSeeds, size = 16) {
  const ms = [], so = seedOrder(size);
  for (let i = 0; i < size / 2; i++) ms.push({ id: `1-${i}`, round: 1, i, p: [so[2 * i], so[2 * i + 1]].map((x) => (x < nSeeds ? x : null)), room: null, w: null, by: null, at: null });
  for (let r = 2, n = size / 4; n >= 1; r++, n /= 2) for (let i = 0; i < n; i++) ms.push({ id: `${r}-${i}`, round: r, i, p: [null, null], room: null, w: null, by: null, at: null });
  return ms;
}
// the bracket played on as far as it goes: winners into the next round, byes and empty slots through. Returns the
// matches that now have both players and no room yet (to open once the Cup has started)
export function cupSettle(c) {
  const byId = new Map(c.matches.map((m) => [m.id, m])), rounds = Math.max(...c.matches.map((m) => m.round));
  const winnerOf = (m) => (m.w === 0 || m.w === 1 ? m.p[m.w] : null);
  for (let r = 1; r <= rounds; r++) {
    for (const m of c.matches.filter((x) => x.round === r)) {
      if (r > 1) {
        const f = [byId.get(`${r - 1}-${2 * m.i}`), byId.get(`${r - 1}-${2 * m.i + 1}`)];
        if (!f.every((x) => x.w !== null)) continue;                // a feeder still to play
        if (m.w === null && !m.room) { m.p = f.map(winnerOf); if (m.p[0] !== null && m.p[1] !== null && m.p[1] < m.p[0]) m.p.reverse(); }   // (the higher seed in seat 0)
      }
      if (m.w !== null || m.room) continue;
      if (m.p[0] === null && m.p[1] === null) { m.w = -1; m.by = 'empty'; }
      else if (m.p[0] === null || m.p[1] === null) { m.w = m.p[0] === null ? 1 : 0; m.by = 'bye'; }
    }
  }
  const fin = c.matches.find((m) => m.round === rounds);
  c.champ = fin && (fin.w === 0 || fin.w === 1) ? fin.p[fin.w] : null;
  return c.matches.filter((m) => m.w === null && !m.room && m.p[0] !== null && m.p[1] !== null);
}

// the draft as a phone sees it: the card up (the man, his team and the slot; his rating never, nor the picks' until
// the draft is over), the money, the slots, the bid in and what each side may bid, the clock, the last card's fate;
// never the cards still to come, nor what the computer would pay
function draftView(R, now = Date.now()) {
  const d = R.draft, done = VSCore.draftDone(d), card = d.pool[d.i] || null;
  const mask = (p) => (done ? p : { k: p.k, team: p.team, pos: p.pos, name: p.name, paid: p.paid });
  return { i: d.i, n: d.pool.length, card: VSCore.draftMask(card), budget: d.budget, need: d.need, picks: d.picks.map((ps) => ps.map(mask)), bid: d.bid,
    max: [0, 1].map((s) => VSCore.draftMax(d, s, card)), floor: [0, 1].map((s) => VSCore.draftFloor(d, s, card)), pass: d.pass || [false, false], steal: d.steal || [true, true],
    canSteal: [0, 1].map((s) => VSCore.draftCanSteal(d, s, card)), ask: d.ask || [0, 0], left: Math.max(0, d.deadline - now), last: d.last ? { ...d.last, card: VSCore.draftMask(d.last.card) } : null, done };
}
const clean = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0];       // the server's coin: the toss, each snap's seed
const rndf = () => rand() / 4294967296;
export const { openMs: OPEN_MS, raiseMs: RAISE_MS, closeMs: CLOSE_MS } = VSCore.DRAFT;   // the draft's clocks: a card up, after a bid, when the other side cannot top it
const CPU_BID_MS = 1200;                         // the draft: the computer bids this long (plus up to as much again) after the card or the other bid
export const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
async function hashKey(k) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`)));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

// the engine and the teams, once per isolate: the worker's own assets (board/assets/vs, put there by the site workflow).
// The loaded engine is shared by every room in the isolate; a load still under way is waited on only ENGINE_WAIT_MS.
// On Cloudflare a promise started by another room's request can never settle for this one (its continuations are
// cancelled when that request ends): a load test's computer matches hung on it for good, the alarm's retry with them.
// Past the wait, a room loads it itself.
export const ENGINE_WAIT_MS = 10_000;
let ENGINE = null, ENGINE_P = null;
function buildEngine(env) {
  const p = (async () => {
    const get = async (f) => {
      const r = await env.ASSETS.fetch(new Request(`https://assets.local/vs/${f}`));
      if (!r.ok) throw new Error(`vs/${f} ${r.status}`);
      return r;
    };
    const unz = async (r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const [eb, pbb, pool] = await Promise.all([get('engine_data.pack').then(unz), get('playbook.pack').then(unz), get('teams.json').then((r) => r.json())]);
    const d = VSCore.unpack(eb), pb = VSCore.unpack(pbb, d);         // (the playbook's pack refers to the engine's)
    const eng = new NFLClockEngine(d);
    eng.loadPlaybook(pb);
    return (ENGINE = ENGINE || { eng, pool });
  })();
  ENGINE_P = p;
  p.catch(() => { if (ENGINE_P === p) ENGINE_P = null; });
  return p;
}
export async function loadEngine(env) {
  if (env.VS_ENGINE) return typeof env.VS_ENGINE === 'function' ? env.VS_ENGINE() : env.VS_ENGINE;    // the tests' own
  if (ENGINE) return ENGINE;
  if (ENGINE_P) {
    const v = await Promise.race([ENGINE_P.catch(() => null), new Promise((r) => setTimeout(() => r(null), ENGINE_WAIT_MS))]);
    if (v) return v;
  }
  return buildEngine(env);
}
// (the tests: a fresh isolate, or one whose load in flight never settles)
export function resetEngine(pending = null) { ENGINE = null; ENGINE_P = pending; }

export class Match {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.steppers = new Map();
    // a ping is answered without waking the object
    if (ctx.setWebSocketAutoResponse && typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/vs/queue') return this.queue(req, url);
    if (url.pathname === '/vs/ladder' || url.pathname === '/vs/me' || url.pathname === '/vs/report' || url.pathname === '/vs/rating' || url.pathname === '/vs/standings') return this.ladder(req, url);
    if (url.pathname.startsWith('/vs/cup')) return this.cup(req, url);
    if (url.pathname === '/vs/init') return this.init(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', room = url.searchParams.get('room') || '';
    if (!KEY_RE.test(key) || !ROOM_RE.test(room)) return new Response('bad room or key', { status: 400 });
    const kh = await hashKey(key), now = Date.now();
    const mode = MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'friend';
    let R = await this.room();
    if (!R) {
      R = this.fresh(room, mode === 'ranked' || mode === 'cpu' || mode === 'cup' ? 'casual' : mode, now);    // a ranked room (the computer's, the Cup's) is only ever made by the lobby (the Cup)
      if (url.searchParams.get('draft') === '1') R.draft = { pool: null };          // (a friend's draft: the pool is drawn when both are in)
    }
    let seat = R.seats.indexOf(kh);
    if (seat < 0 && !R.pre) seat = R.seats.indexOf(null);
    if (seat < 0) return new Response('the room is full', { status: 409 });
    R.seats[seat] = kh;
    R.seen[seat] = true;
    R.off[seat] = 0;
    if (R.phase === 'wait' && R.seen[0] && R.seen[1]) {
      if (R.draft) R.phase = 'draft';                                // (the draft first, its pool drawn by the alarm at once: the engine may take a moment to load; the toss once both sides are made)
      else if (R.teams[0] && R.teams[1]) this.begin(R, now);
    }
    await this.save(R);
    // the computer's call now (a toss it won plays at once): the phone's hello is the room after it, with that step in
    // its decisions (the step's own message went out before this socket was open; a hello from before it left the
    // phone waiting on the computer while the room waited on the phone: the load test's stuck matches)
    if (R.cpu != null && R.phase === 'live') { await this.cpuTurn(); R = (await this.room()) || R; }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.ctx.getWebSockets(`s${seat}`)) { try { old.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    this.ctx.acceptWebSocket(server, [`s${seat}`]);
    server.serializeAttachment({ seat });
    const since = Math.max(0, Math.min(R.n, Number.parseInt(url.searchParams.get('since'), 10) || 0, R.n), R.n - CATCHUP);
    const decisions = [];
    for (let i = since; i < R.n; i++) { const d = await this.ctx.storage.get(`d:${i}`); delete d.seed; decisions.push(d); }
    server.send(JSON.stringify({ t: 'hello', seat, mode: R.mode, room: R.room, teams: R.teams, names: R.names, full: R.seen[0] && R.seen[1],
      online: this.online(), off: R.off, phase: R.phase, n: R.n, ms: R.ms, ms0: since === 0 ? R.ms0 || null : null, decisions, deadline: R.deadline, dl: dls(R), now,
      result: R.result, rated: R.rated, level: R.cpuLevel || null, draft: R.draft && R.draft.pool ? draftView(R) : R.draft ? { pending: true } : null, draftTeams: R.draftTeams || null }));
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
    if (R) this.cpuSeat = R.cpu;
    return R || null;
  }
  save(R) { return this.ctx.storage.put('room', R); }
  online() { const c = this.cpuSeat; return [0, 1].map((s) => s === c || this.ctx.getWebSockets(`s${s}`).length > 0); }
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
    if (R.mode === 'cpu') { R.cpu = CPU_SEAT; R.seats[CPU_SEAT] = CPU_KEY; R.seen[CPU_SEAT] = true; this.cpuSeat = CPU_SEAT; R.cpuLevel = CPU_LEVELS.includes(b.level) ? b.level : 'pro'; }
    R.teams = [TEAM_RE.test(b.teams && b.teams[0]) ? b.teams[0] : null, TEAM_RE.test(b.teams && b.teams[1]) ? b.teams[1] : null];
    if (R.teams[0] && R.teams[0] === R.teams[1]) R.teams[1] = null;
    R.names = [clean(b.names && b.names[0]), clean(b.names && b.names[1])];
    if (R.mode === 'cup') { R.cup = String(b.cup || ''); R.cupId = String(b.cupId || ''); R.showBy = Number(b.showBy) || now + CUP.showMs; }
    if (b.draft) { R.draft = { pool: null }; R.teams = [null, null]; }        // (the sides are drafted, not brought)
    await this.save(R);
    await this.schedule(R);
    return reply({ ok: true });
  }

  begin(R, now) {
    R.ms = R.ms0 = VSCore.start(rand() & 1);
    R.phase = 'live';
    R.n = 0;
    R.deadline = now + (R.cpu != null ? CPU_DECIDE_MS : FIRST_MS);
    R.dl = [R.deadline, R.deadline];
    if (R.cpu != null) R.dl[R.cpu] = now + CPU_TURN_MS;
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
      for (const s of [0, 1]) if (R.off[s]) t.push(R.off[s] + (R.cpu != null ? CPU_DECIDE_MS : FORFEIT_MS));
    }
    if (R.phase === 'draft') for (const s of [0, 1]) if (R.off[s] && s !== R.cpu) t.push(R.off[s] + FORFEIT_MS);
    if (R.phase === 'wait' && R.pre) t.push(R.mode === 'cup' ? R.showBy : R.created + NOSHOW_MS);
    if (R.phase === 'draft' && R.draft) { t.push(R.draft.pool ? R.draft.deadline : R.draft.retryAt || Date.now() + 50); if (R.draft.cpuAt) t.push(R.draft.cpuAt); (R.draft.ask || []).forEach((a) => { if (a) t.push(a); }); }
    if (R.phase === 'over' && R.mode === 'ranked' && R.result && R.result.winner >= 0 && !R.rated) t.push(Date.now() + 5000);
    if (R.phase === 'over' && R.mode === 'cup' && !R.reported) t.push(Date.now() + 5000);
    await this.ctx.storage.setAlarm(Math.min(...t));
  }

  stepper(R, E) {
    const k = R.draftTeams ? `draft:${R.room}` : `${R.teams[0]}|${R.teams[1]}`;
    const pool = R.draftTeams ? VSCore.draftPoolWith(E.pool, R.draftTeams) : E.pool;
    if (!this.steppers.has(k)) this.steppers.set(k, VSCore.stepper(E.eng, pool, R.teams[0], R.teams[1], E.eng.lib ? lazySimulator : undefined));
    return this.steppers.get(k);
  }

  // ---- the draft (VSCore.DRAFT, a blind auction): the pool once both are in, a card up at a time with a clock, the
  // bids open and back and forth (draftBid), the high bid takes the card when the clock runs out (draftSettle); the
  // computer bids on the alarm, a beat after each card or bid (draftCpu). Every card settled: the two sides are made
  // (draftTeam) and the toss follows
  async draftStart(R, now) {
    let E;
    try { E = await loadEngine(this.env); } catch (e) { console.error('vs engine', e && e.message); R.draft.retryAt = now + 5000; return; }    // (the alarm tries again)
    R.draft = VSCore.draftNew(VSCore.draftPool(E.pool, rndf));
    R.phase = 'draft';
    VSCore.draftAdvance(R.draft);
    this.draftPost(R, now);
    this.broadcast({ t: 'draft', d: draftView(R, now) });
  }
  draftPost(R, now) {
    const d = R.draft;
    d.deadline = now + OPEN_MS;
    d.bid = null;
    d.bidders = {};
    d.cpuV = R.cpu != null ? VSCore.draftCpuValue(d, R.cpu, rndf) : 0;
    d.cpuAt = R.cpu != null ? now + CPU_BID_MS * (1 + rndf()) : 0;
  }
  // a bid in (a seat's, or the computer's): the clock goes back to RAISE_MS, or CLOSE_MS when the other side cannot
  // top it; the computer's turn to answer a phone's bid is set
  draftBid(R, seat, amount, now) {
    const d = R.draft;
    d.bid = { seat, amount };
    (d.bidders = d.bidders || {})[seat] = true;
    d.deadline = now + (VSCore.draftCanTop(d, 1 - seat) ? RAISE_MS : CLOSE_MS);
    d.cpuAt = R.cpu != null && seat !== R.cpu && VSCore.draftCanTop(d, R.cpu) ? now + CPU_BID_MS * (1 + rndf()) : 0;
    this.broadcast({ t: 'bid', i: d.i, seat, amount, left: d.deadline - now });
  }
  draftCpu(R, now) {
    const d = R.draft;
    d.cpuAt = 0;
    const amount = VSCore.draftCpuBid(d, R.cpu, d.cpuV, rndf);
    if (amount != null) this.draftBid(R, R.cpu, amount, now);
  }
  // a side here: its idle count and any "still here?" cleared (a bid, a pass, a tap)
  draftHere(R, seat) {
    const d = R.draft;
    if (!d || !d.pool) return;
    d.idle = d.idle || [0, 0]; d.ask = d.ask || [0, 0];
    d.idle[seat] = 0; d.ask[seat] = 0;
  }
  async draftSettle(R, now) {
    const d = R.draft, card = d.pool[d.i];
    // a side that could have bid on the card and did not (passed, or let the clock run), DRAFT_IDLE_CARDS cards in a
    // row: "still here?" to its phone, STILL_MS to answer (the alarm: a forfeit)
    d.idle = d.idle || [0, 0]; d.ask = d.ask || [0, 0];
    for (const s of [0, 1]) {
      if (s === R.cpu || !card) continue;
      if ((d.bidders || {})[s]) d.idle[s] = 0;
      else if (VSCore.draftMax(d, s, card) > 0) d.idle[s] += 1;
      if (d.idle[s] >= DRAFT_IDLE_CARDS && !d.ask[s]) {
        d.ask[s] = now + STILL_MS;
        const msg = JSON.stringify({ t: 'stillhere', by: d.ask[s], now });
        for (const ws of this.ctx.getWebSockets(`s${s}`)) { try { ws.send(msg); } catch (e) { /* closing */ } }
      }
    }
    VSCore.draftResolve(d);
    if (!VSCore.draftDone(d)) {
      this.draftPost(R, now);
      await this.save(R);
      this.broadcast({ t: 'draft', d: draftView(R, now) });
      return this.schedule(R);
    }
    let E;
    try { E = await loadEngine(this.env); } catch (e) {
      console.error('vs engine', e && e.message);
      d.deadline = now + 5000;                                   // (the alarm settles again, with the engine)
      await this.save(R);
      return this.schedule(R);
    }
    VSCore.draftFill(d, E.pool, rndf);
    const [c0, c1] = VSCore.DRAFT.teams;
    R.draftTeams = { [c0]: VSCore.draftTeam(E.pool, d.picks[0], c0, R.names[0]), [c1]: VSCore.draftTeam(E.pool, d.picks[1], c1, R.names[1]) };
    R.teams = [c0, c1];
    d.bid = null; d.cpuAt = 0; d.cpuV = 0;
    this.broadcast({ t: 'draft', d: draftView(R, now), teams: R.teams, draftTeams: R.draftTeams });
    this.begin(R, now);
    await this.save(R);
    await this.schedule(R);
    if (R.cpu != null) await this.cpuTurn();
    return undefined;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const att = ws.deserializeAttachment() || {}, { seat } = att;
    if (m.t === 'ping') { try { ws.send('{"t":"pong"}'); } catch (e) { /* closing */ } return; }
    if (att.q) return m.t === 'cpu' ? this.cpuMatch(ws, att, m.level) : undefined;
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
    if (m.t === 'here') {
      if (R.phase !== 'draft' || !R.draft || !R.draft.pool) return;
      this.draftHere(R, seat);
      await this.save(R);
      return this.schedule(R);
    }
    if (m.t === 'bid') {
      const d = R.draft, amount = Number(m.amount);
      if (R.phase !== 'draft' || !d || !d.pool || m.i !== d.i || now >= d.deadline || !VSCore.draftCanBid(d, seat, amount)) return;
      this.draftHere(R, seat);
      this.draftBid(R, seat, amount, now);
      await this.save(R);
      return this.schedule(R);
    }
    if (m.t === 'pass') {
      const d = R.draft;
      if (R.phase !== 'draft' || !d || !d.pool || m.i !== d.i || now >= d.deadline || d.pass[seat]) return;
      this.draftHere(R, seat);
      const settles = VSCore.draftPass(d, seat);
      if (settles === null) return;
      this.broadcast({ t: 'pass', i: d.i, seat });
      if (settles) return this.draftSettle(R, now);
      await this.save(R);
      return this.schedule(R);
    }
    if (m.t === 'team') {
      if (R.draft) return;                                           // (the sides are drafted)
      if (R.phase !== 'wait' || R.teams[seat] || !TEAM_RE.test(String(m.team || '')) || !E.pool.teams[m.team]) return;
      if (R.teams[1 - seat] === m.team) { ws.send(JSON.stringify({ t: 'taken', team: m.team })); return; }   // never the same team on both sides
      R.teams[seat] = m.team;
      R.names[seat] = clean(m.name) || R.names[seat];
      this.broadcast({ t: 'teams', teams: R.teams, names: R.names });
      if (R.seen[0] && R.seen[1] && R.teams[0] && R.teams[1]) this.begin(R, now);
      await this.save(R);
      await this.schedule(R);
      if (R.cpu != null && R.phase === 'live') await this.cpuTurn();
      return;
    }
    if (m.t === 'rematch') return this.rematch(R, seat);
    if (m.t === 'ready') {
      // the call is up on this phone: its clock starts (decideMs: 10 seconds on defense, 20 on offense; never later than
      // the decision's last moment)
      if (R.phase !== 'live' || m.n !== R.n || !VSCore.need(R.ms).includes(seat)) return;
      R.dl = dls(R);
      // (the offense, the defense's call not in yet: its clock waits, wait: true, until it is: offStart)
      const pend = await this.ctx.storage.get('pend'), defIn = pend && pend.n === R.n && (1 - R.ms.root.pos) in pend.halves;
      const waits = R.cpu == null && ON_DEF(R.ms) && seat === R.ms.root.pos && !defIn;
      if (waits) R.offWait = R.n;
      else R.dl[seat] = Math.min(R.dl[seat], now + (R.cpu != null ? CPU_DECIDE_MS : decideMs(R.ms, seat)));
      await this.save(R);
      try { ws.send(JSON.stringify({ t: 'clock', n: R.n, seat, deadline: R.dl[seat], now, ...(waits ? { wait: true } : {}) })); } catch (e) { /* closing */ }
      await this.schedule(R);
      return;
    }
    if (m.t !== 'half' || R.phase !== 'live' || m.n !== R.n || R.n >= MAX_N) return;
    if (!VSCore.need(R.ms).includes(seat)) return;
    let pend = await this.ctx.storage.get('pend');
    if (!pend || pend.n !== R.n) pend = { n: R.n, halves: {} };
    if (seat in pend.halves) return;                                   // a call, once locked, stays
    pend.halves[seat] = VSCore.cleanHalf(R.ms, seat, m.half, E.eng.pb);
    // nothing usable (the phone's clock ran out): a default, counted toward a forfeit except on defense (10 seconds is
    // short, and the defense's default is a real call: the engine's own)
    R.defaults[seat] = pend.halves[seat] ? 0 : onDefense(R.ms, seat) ? R.defaults[seat] : R.defaults[seat] + 1;
    // (the computer's call in here too: cpuTurn's own write of it, racing this one, could be lost under it, and the
    // match then waited out CPU_DECIDE_MS)
    if (R.cpu != null && VSCore.need(R.ms).includes(R.cpu) && !(R.cpu in pend.halves)) pend.halves[R.cpu] = R.cpuLevel === 'rookie' ? this.rookieHalf(R, E) : null;
    if (VSCore.need(R.ms).every((s) => s in pend.halves)) return this.commit(R, pend, E, now);
    const started = this.offStart(R, pend, now);
    await this.ctx.storage.put('pend', pend);
    await this.save(R);
    this.broadcast({ t: 'locked', n: pend.n, seat });
    if (started) this.broadcast(started);
    await this.schedule(R);
  }
  // the defense's call in at a snap (or a kick): the offense's 20 seconds start now, if its call was up and waiting
  // (a phone not up yet starts them itself on ready). Returns the clock message to send, or null
  offStart(R, pend, now) {
    if (R.cpu != null || !ON_DEF(R.ms) || R.offWait !== R.n) return null;
    const off = R.ms.root.pos;
    if (!((1 - off) in pend.halves) || off in pend.halves) return null;
    R.dl = dls(R);
    R.dl[off] = Math.min(R.deadline, now + OFF_MS);
    R.offWait = -1;
    return { t: 'clock', n: R.n, seat: off, deadline: R.dl[off], now };
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
    R.deadline = now + (R.cpu != null ? CPU_DECIDE_MS : PLAY_MS);
    R.dl = [R.deadline, R.deadline];
    if (R.cpu != null) R.dl[R.cpu] = now + CPU_TURN_MS;
    let result = null;
    if (out.ms.over) {
      R.phase = 'over';
      result = R.result = { winner: out.ms.winner, by: 'score', score: out.ms.root.score.slice(), round: out.ms.cot.round };
    }
    await this.save(R);
    this.broadcast({ t: 'step', ...d, deadline: R.deadline, dl: R.dl, now, result });
    if (result) { this.steppers.clear(); return R.mode === 'cup' ? this.cupReport(R) : this.rate(R); }
    const afk = [0, 1].filter((s) => s !== R.cpu && R.defaults[s] >= AFK_LIMIT);
    if (afk.length === 2) return this.finish(R, { winner: -1, by: 'abandoned' });
    if (afk.length === 1) return this.finish(R, { winner: 1 - afk[0], by: 'forfeit', loser: afk[0], why: 'afk' });
    if (R.n >= MAX_N) return this.finish(R, { winner: -1, by: 'error' });
    await this.schedule(R);
    if (R.cpu != null) await this.cpuTurn();
  }

  // the computer's half of the decision now up (the default: the engine's own call), in at once; the snap when it was
  // the last one wanted (a decision only the computer answers, a toss or a try, plays straight away: the phones play
  // each step in turn)
  async cpuTurn() {
    let E;
    try { E = await loadEngine(this.env); } catch (e) { console.error('vs engine', e && e.message); return; }    // the deadline retries
    const R = await this.room();
    if (!R || R.cpu == null || R.phase !== 'live' || !VSCore.need(R.ms).includes(R.cpu)) return;
    let pend = await this.ctx.storage.get('pend');
    if (!pend || pend.n !== R.n) pend = { n: R.n, halves: {} };
    if (R.cpu in pend.halves) return;
    pend.halves[R.cpu] = R.cpuLevel === 'rookie' ? this.rookieHalf(R, E) : null;
    if (VSCore.need(R.ms).every((s) => s in pend.halves)) return this.commit(R, pend, E, Date.now());
    await this.ctx.storage.put('pend', pend);
    this.broadcast({ t: 'locked', n: pend.n, seat: R.cpu });
    await this.schedule(R);
  }

  // over without the last snap: a forfeit, a no-show, both gone, an error
  async finish(R, result) {
    this.steppers.clear();
    // (a Cup match always has a winner: nobody, both gone at once or an error, is the higher seed, seat 0)
    if (R.mode === 'cup' && !(result.winner >= 0)) result = { ...result, winner: 0, by: result.by === 'noshow' ? 'noshow' : result.by || 'error', cupDefault: true };
    R.phase = 'over';
    R.result = { ...result, score: R.ms ? R.ms.root.score.slice() : [0, 0], round: R.ms ? R.ms.cot.round : 0 };
    await this.ctx.storage.delete('pend');
    await this.save(R);
    this.broadcast({ t: 'over', result: R.result });
    if (R.mode === 'cup') return this.cupReport(R);
    if (R.result.winner >= 0) return this.rate(R);
    await this.schedule(R);
  }
  // a Cup match over: its result to the Cup (once: retried by the alarm until it is in)
  async cupReport(R) {
    try {
      const res = await this.env.MATCH.get(this.env.MATCH.idFromName('cup')).fetch(new Request('https://cup/vs/cup/report', {
        method: 'POST', body: JSON.stringify({ cupId: R.cupId, match: R.cup, room: R.room, winner: R.result.winner, by: R.result.by, score: R.result.score }) }));
      if (!res.ok) throw new Error(`cup ${res.status}`);
      const R2 = (await this.room()) || R;
      R2.reported = true;
      await this.save(R2);
      await this.schedule(R2);
    } catch (e) {
      console.error('vs cup report', R.room, e && e.message);
      await this.schedule(R);
    }
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
    if (R.phase !== 'over' || !R.seats.every(Boolean) || R.mode === 'cup') return;
    R.again = [...new Set([...(R.again || []), seat, ...(R.cpu != null ? [R.cpu] : [])])];      // (the computer always says yes)
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
            method: 'POST', body: JSON.stringify({ room: code, mode: R2.mode === 'friend' || R2.mode === 'cpu' || R2.mode === 'draft' ? R2.mode : 'casual', seats: R2.seats, teams: R2.draft ? [null, null] : R2.teams, names: R2.names, level: R2.cpuLevel, draft: !!R2.draft }) }));
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
    if (await this.ctx.storage.get('cupObj')) return this.cupTick();
    const R = await this.room();
    if (!R) { if (await this.ctx.storage.get('room')) await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    if (now >= R.created + ROOM_TTL_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'expired'); } catch (e) { /* gone */ } }
      await this.ctx.storage.deleteAll();
      return;
    }
    if (R.phase === 'draft' && R.draft) {
      if (!R.draft.pool) { await this.draftStart(R, now); await this.save(R); return this.schedule(R); }
      // "still here?" unanswered: that side is out, the draft is over (unrated; the other side goes back to the lobby)
      const gone = (R.draft.ask || []).findIndex((a) => a && now >= a - 50);
      if (gone >= 0) return this.finish(R, { winner: 1 - gone, by: 'forfeit', loser: gone, why: 'away' });
      // a phone gone FORFEIT_MS during the draft: the same (the computer is never gone)
      const left = [0, 1].filter((s) => s !== R.cpu && R.off[s] && now >= R.off[s] + FORFEIT_MS);
      if (left.length === 2) return this.finish(R, { winner: -1, by: 'abandoned' });
      if (left.length === 1) return this.finish(R, { winner: 1 - left[0], by: 'forfeit', loser: left[0], why: 'left' });
      if (R.cpu != null && R.draft.cpuAt && now >= R.draft.cpuAt - 50) this.draftCpu(R, now);
      if (now >= R.draft.deadline - 50) return this.draftSettle(R, now);
      await this.save(R);
      return this.schedule(R);
    }
    if (R.phase === 'live') {
      // a phone gone too long: that side forfeits (both gone: the one who left first; at the same time: nobody wins)
      const late = [0, 1].filter((s) => R.off[s] && now >= R.off[s] + (R.cpu != null ? CPU_DECIDE_MS : FORFEIT_MS));
      if (late.length === 2) {
        const first = R.off[0] === R.off[1] ? -1 : R.off[0] < R.off[1] ? 0 : 1;
        return this.finish(R, first < 0 ? { winner: -1, by: 'abandoned' } : { winner: 1 - first, by: 'forfeit', loser: first, why: 'left' });
      }
      if (late.length === 1) return this.finish(R, { winner: 1 - late[0], by: 'forfeit', loser: late[0], why: 'left' });
      // a seat's play clock out: its call is the default; every call in: the snap
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
        for (const s of late) {
          if (s === R2.cpu) { pend.halves[s] = R2.cpuLevel === 'rookie' ? this.rookieHalf(R2, E) : null; continue; }    // (the computer's own)
          pend.halves[s] = null;
          if (!onDefense(R2.ms, s)) R2.defaults[s] += 1;      // (a missed defense: its default, no forfeit count)
        }
        if (VSCore.need(R2.ms).every((s) => s in pend.halves)) return this.commit(R2, pend, E, Date.now());
        const started = this.offStart(R2, pend, Date.now());
        await this.ctx.storage.put('pend', pend);
        await this.save(R2);
        for (const s of late) this.broadcast({ t: 'locked', n: pend.n, seat: s });
        if (started) this.broadcast(started);
        return this.schedule(R2);
      }
    }
    if (R.phase === 'wait' && R.pre && R.mode === 'cup') {
      // the Cup: in (and on a team) by showBy, or that side loses; neither in: the higher seed (seat 0) goes on
      if (now >= R.showBy) {
        const missing = [0, 1].filter((s) => !R.seen[s] || !R.teams[s]);
        if (missing.length === 1) return this.finish(R, { winner: 1 - missing[0], by: 'forfeit', loser: missing[0], why: 'noshow' });
        return this.finish(R, { winner: 0, by: 'noshow', missing });
      }
    } else if (R.phase === 'wait' && R.pre && now >= R.created + NOSHOW_MS) {
      // ranked: matched and never came (or never picked a team) is a loss, so nobody dodges an opponent; else called off
      const missing = [0, 1].filter((s) => !R.seen[s] || (!R.draft && !R.teams[s]));
      if (R.mode === 'ranked' && missing.length === 1) return this.finish(R, { winner: 1 - missing[0], by: 'forfeit', loser: missing[0], why: 'noshow' });
      return this.finish(R, { winner: -1, by: 'noshow', missing });
    }
    if (R.phase === 'over' && R.mode === 'ranked' && !R.rated && R.result && R.result.winner >= 0) return this.rate(R);
    if (R.phase === 'over' && R.mode === 'cup' && !R.reported) return this.cupReport(R);
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
    const want = url.searchParams.get('mode'), key = url.searchParams.get('key') || '', mode = want === 'ranked' ? 'ranked' : want === 'draft' ? 'draft' : 'casual';
    const draft = mode === 'draft' || url.searchParams.get('draft') === '1';        // (a draft: no team brought)
    const team = url.searchParams.get('team') || '';
    if (!KEY_RE.test(key) || !(TEAM_RE.test(team) || (draft && !team))) return new Response('bad key or team', { status: 400 });
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
    // (the computer asked for straight away: its room, no time in the queue, nobody paired with it)
    if (want === 'cpu') {
      this.ctx.acceptWebSocket(server, ['cpuq']);
      const t = { q: true, kh, mode: 'casual', team, name, rating, since: Date.now(), now: true, draft };
      server.serializeAttachment(t);
      await this.cpuMatch(server, t, url.searchParams.get('level'));
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, ['q']);
    server.serializeAttachment({ q: true, kh, mode, team, name, rating, since: Date.now(), draft });
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
      const wait = Math.round((now - t.since) / 1000);
      try { t.ws.send(JSON.stringify({ t: 'queued', mode: t.mode, size, wait, rating: Math.round(t.rating), cpu: wait >= CPU_AFTER_S })); } catch (e) { /* closing */ }
    }
    if (left.length) await this.ctx.storage.setAlarm(now + MM.TICK_MS);
  }
  async pairNow() {
    const now = Date.now();
    for (const mode of ['ranked', 'casual', 'draft']) {
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
        const room = await this.makeRoom(mode, a, best, undefined, mode === 'draft');
        if (!room) continue;
        used.add(a); used.add(best);
        for (const t of [a, best]) {
          t.ws.serializeAttachment({ q: true, kh: t.kh, mode, paired: room });
          try { t.ws.send(JSON.stringify({ t: 'match', room, mode })); t.ws.close(1000, 'matched'); } catch (e) { /* gone: the room calls it off */ }
        }
      }
    }
  }
  // the rookie: any play at random (a run or a pass the page offers, the defense's four parts each at random); the
  // toss, the try: the default
  rookieHalf(R, E) {
    const role = VSCore.role(R.ms, R.cpu), pick = (a) => a[rand() % a.length];
    let h = null;
    const r = R.ms.root;
    if (role === 'offense') {
      const id = pick(ROOKIE_CALLS), c = E.eng.pb.calls.find((x) => x.id === id);
      if (c) h = { action: { call: c.id, play: c.kind === 'run' ? 'run' : 'pass' } };
    } else if (role === 'intent') {
      // it settles: on 4th down in field-goal range it kicks, unless three points would lose it on the spot
      h = { intent: r.yl <= 35 && r.score[1 - R.cpu] - r.score[R.cpu] <= 3 ? 'fg' : 'go' };
    } else if (role === 'kick') h = { kick: true };
    else if (role === 'kickdef') h = { st: VSCore.KICK_DEF[R.ms.cot.k4][1] };
    else if (role === 'defense') h = { dc: { ...pick(ROOKIE_DEF) } };
    return h ? VSCore.cleanHalf(R.ms, R.cpu, h, E.eng.pb) : null;
  }
  // a ticket that has waited CPU_AFTER_S asks for the computer: a room of its own against a team other than its own
  // (never rated), and it leaves the queue
  async cpuMatch(ws, t, level) {
    if (!t.q || t.paired || (!t.now && Date.now() - t.since < CPU_AFTER_S * 1000 - 2000)) return;
    let E;
    try { E = await loadEngine(this.env); } catch (e) { return; }
    const teams = Object.keys(E.pool.teams).filter((c) => c !== t.team && TEAM_RE.test(c));
    if (!teams.length) return;
    const other = teams[rand() % teams.length];
    const room = await this.makeRoom('cpu', t, { kh: CPU_KEY, team: other, name: CPU_NAME }, CPU_LEVELS.includes(level) ? level : 'pro', !!t.draft);
    if (!room) return;
    ws.serializeAttachment({ ...t, paired: room });
    try { ws.send(JSON.stringify({ t: 'match', room, mode: 'cpu' })); ws.close(1000, 'matched'); } catch (e) { /* gone: the room calls it off */ }
  }
  async makeRoom(mode, a, b, level, draft) {
    for (let i = 0; i < 5; i++) {
      const room = roomCode();
      const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${room}`)).fetch(new Request('https://room/vs/init', {
        method: 'POST', body: JSON.stringify({ room, mode, seats: [a.kh, b.kh], teams: draft ? [null, null] : [a.team, b.team], names: [a.name, b.name], level, draft: !!draft }) }));
      if (r.ok) return room;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------- the Cup ---
  // the object named 'cup' (CUP): cupObj {id, snap: {at, seeds: [{kh, name, rating, games}]}, matches, champ, claim}
  // (a Cup another one replaces: its champion kept in cupPast, the newest first: name, the champion's name and key hash
  // and claim code, for his phone only)
  async cupLoad(cfg) {
    const c = await this.ctx.storage.get('cupObj');
    if (c && c.id === cfg.id) return c;
    if (c && c.snap && c.champ !== null && c.champ !== undefined) {
      const past = (await this.ctx.storage.get('cupPast')) || [], s = c.snap.seeds[c.champ];
      if (!past.some((x) => x.id === c.id)) {
        past.unshift({ id: c.id, name: c.name || 'The Invitational', champ: s.name, kh: s.kh, claim: c.claim || null, at: Date.now() });
        await this.ctx.storage.put('cupPast', past.slice(0, 10));
      }
    }
    return { id: cfg.id, name: cfg.name, snap: null, matches: null, champ: null, claim: null };
  }
  async standings(at, cfg) {
    const r = await this.env.MATCH.get(this.env.MATCH.idFromName('ladder')).fetch(new Request('https://ladder/vs/standings', {
      method: 'POST', body: JSON.stringify({ at, n: cfg.size, minGames: cfg.minGames }) }));
    if (!r.ok) throw new Error(`ladder ${r.status}`);
    return (await r.json()).top;
  }
  // the qualifiers as the ladder stood at qualifyAt (taken once, any time after it: exact all the same), the bracket
  // played on, and from startAt each match with both its players its room
  async cupRun(c, cfg, now) {
    if (!c.snap && now >= cfg.qAt) {
      const top = await this.standings(cfg.qAt, cfg);
      c.snap = { at: now, seeds: top };
      c.matches = cupBracket(top.length, cfg.size);
    }
    if (c.matches) {
      const open = cupSettle(c);
      if (now >= cfg.sAt) {
        for (const m of open) {
          const code = await this.cupRoom(c, m, cfg, now);
          if (code) { m.room = code; m.opened = now; }
        }
      }
      if (c.champ !== null && c.champ !== undefined && !c.claim) c.claim = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join('');
    }
    await this.ctx.storage.put('cupObj', c);
    const t = [];                                      // the next thing to do: qualify, start, a room not made yet
    if (!c.snap) t.push(cfg.qAt);
    else if (now < cfg.sAt) t.push(cfg.sAt);
    if (c.matches && now >= cfg.sAt && c.matches.some((m) => m.w === null && !m.room && m.p[0] !== null && m.p[1] !== null)) t.push(now + 30_000);
    if (t.length) await this.ctx.storage.setAlarm(Math.max(now + 500, Math.min(...t)));
    return c;
  }
  async cupRoom(c, m, cfg, now) {
    const s = c.snap.seeds;
    for (let i = 0; i < 5; i++) {
      const code = roomCode();
      const r = await this.env.MATCH.get(this.env.MATCH.idFromName(`room:${code}`)).fetch(new Request('https://room/vs/init', {
        method: 'POST', body: JSON.stringify({ room: code, mode: 'cup', seats: [s[m.p[0]].kh, s[m.p[1]].kh], names: [s[m.p[0]].name, s[m.p[1]].name], cup: m.id, cupId: c.id, showBy: now + cfg.showMs }) }));
      if (r.ok) return code;
    }
    return null;
  }
  // one Cup event at a time, start to finish (the alarm, every phone's look at the bracket, a room's result): cupRun
  // waits on other objects (the ladder, the rooms it makes), and another event let in then read the bracket from before
  // the rooms were put in it and made its own for the same matches (Oct 25: 48 rooms for 8 matches, the two players of
  // a match each waiting in a different one, and a result from a room the bracket no longer named refused)
  // (an error comes out after: one thrown inside blockConcurrencyWhile would reset the object)
  async cupLocked(fn) {
    const r = await this.ctx.blockConcurrencyWhile(async () => { try { return { v: await fn() }; } catch (e) { return { e }; } });
    if (r.e) throw r.e;
    return r.v;
  }
  cupTick() { return this.cupLocked(() => this.cupTickNow()); }
  async cupTickNow() {
    const cfg = cupConfig(this.env);
    try { await this.cupRun(await this.cupLoad(cfg), cfg, Date.now()); } catch (e) {
      console.error('vs cup', e && e.message);
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
  cup(req, url) { return this.cupLocked(() => this.cupNow(req, url)); }
  async cupNow(req, url) {
    const cfg = cupConfig(this.env), now = Date.now();
    if (!Number.isFinite(cfg.qAt) || !Number.isFinite(cfg.sAt)) return reply({ error: 'no cup' }, 404);
    let body = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch (e) { /* none */ } }
    let c = await this.cupLoad(cfg);
    await this.ctx.storage.put('cupObj', c);                // (this object is the Cup: its alarm is cupTick)
    if (url.pathname === '/vs/cup/report') {                // a Cup room's result (never routed from outside)
      const m = c.id === body.cupId && c.matches ? c.matches.find((x) => x.id === body.match && x.room === body.room) : null;
      if (!m) return reply({ error: 'match' }, 400);
      if (m.w === null) { m.w = body.winner === 1 ? 1 : 0; m.by = String(body.by || 'score'); m.score = Array.isArray(body.score) ? body.score.slice(0, 2) : null; m.at = now; }
      await this.cupRun(c, cfg, now);
      return reply({ ok: true });
    }
    if (url.pathname === '/vs/cup/admin') {                 // (the worker lets only the admin token through)
      if (body.match != null && c.matches) {
        const m = c.matches.find((x) => x.id === body.match);
        if (!m || !(body.winner === 0 || body.winner === 1) || m.p[body.winner] === null) return reply({ error: 'match and winner (0: the first player, 1: the second) wanted' }, 400);
        const next = c.matches.find((x) => x.round === m.round + 1 && x.i === m.i >> 1);
        if (next && (next.room || next.w !== null)) return reply({ error: 'the next match has already started from this one' }, 409);
        m.w = body.winner; m.by = 'admin'; m.at = now;
      }
      c = await this.cupRun(c, cfg, now);
      return reply({ cup: c, cfg });
    }
    // GET /vs/cup?key=: the Cup as a phone sees it (names, ratings and seeds; never anyone's key)
    try { c = await this.cupRun(c, cfg, now); } catch (e) { console.error('vs cup', e && e.message); }
    const key = url.searchParams.get('key') || '', kh = KEY_RE.test(key) ? await hashKey(key) : null;
    const seeds = c.snap ? c.snap.seeds : null;
    let proj = null;
    if (!seeds) {
      if (!this.proj || now - this.proj.at > 20_000) { try { this.proj = { at: now, top: await this.standings(now, cfg) }; } catch (e) { this.proj = this.proj || { at: now, top: [] }; } }
      proj = this.proj.top;
    }
    const list = seeds || proj, me = kh && list ? list.findIndex((x) => x.kh === kh) : -1;
    const mine = seeds && me >= 0 && c.matches ? c.matches.filter((m) => m.p.includes(me)).sort((a, b) => b.round - a.round)[0] : null;
    const you = kh ? { seed: me >= 0 ? me + 1 : null, qualified: !!seeds && me >= 0,
      match: mine ? { id: mine.id, round: mine.round, room: mine.w === null ? mine.room : null, opp: (() => { const o = mine.p[1 - mine.p.indexOf(me)]; return o === null ? null : seeds[o].name; })(),
        won: mine.w === null ? null : mine.p[mine.w] === me } : null,
      champ: c.champ === me && me >= 0, claim: c.champ === me && me >= 0 ? c.claim : null } : null;
    const past = ((await this.ctx.storage.get('cupPast')) || []).map((x) => ({ id: x.id, name: x.name, champ: x.champ,
      you: !!kh && x.kh === kh, claim: kh && x.kh === kh ? x.claim : null }));
    return reply({ id: c.id, name: cfg.name, past, qualifyAt: cfg.qualifyAt, startAt: cfg.startAt, prize: cfg.prize, size: cfg.size, minGames: cfg.minGames, now,
      seeds: seeds ? seeds.map((x, i) => ({ seed: i + 1, name: x.name, rating: x.rating })) : null,
      projection: proj ? proj.map((x, i) => ({ seed: i + 1, name: x.name, rating: x.rating, games: x.games })) : null,
      matches: c.matches ? c.matches.map((m) => ({ id: m.id, round: m.round, i: m.i, p: m.p.map((x) => (x === null ? null : x + 1)), w: m.w, by: m.by, score: m.score || null, live: !!m.room && m.w === null })) : null,
      champ: c.champ !== null && c.champ !== undefined && seeds ? seeds[c.champ].name : null, you });
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
      // the season a row's rating is of ('beta': the rows from before seasons); a row from another season's player is
      // a new one this season, the old one kept in past
      try { q.exec("ALTER TABLE players ADD COLUMN season TEXT NOT NULL DEFAULT 'beta'"); } catch (e) { /* (there already) */ }
      q.exec(`CREATE TABLE IF NOT EXISTS past (kh TEXT NOT NULL, season TEXT NOT NULL, name TEXT NOT NULL, rating REAL NOT NULL, games INTEGER NOT NULL,
        w INTEGER NOT NULL, l INTEGER NOT NULL, peak REAL NOT NULL, PRIMARY KEY (kh, season))`);
      // /vs/standings reads only the games after a time; rank() and the ladder's count only this season's players
      q.exec('CREATE INDEX IF NOT EXISTS games_at ON games (at)');
      q.exec('CREATE INDEX IF NOT EXISTS players_season ON players (season, rating)');
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }
  player(kh, season = seasonConfig(this.env).id) {
    const row = this.sql().exec('SELECT * FROM players WHERE kh = ?', kh).toArray()[0];
    if (row && row.season === season) return row;
    return { kh, name: row ? row.name : '', rating: ELO.START, games: 0, w: 0, l: 0, peak: ELO.START, streak: 0, updated: 0, season, old: row && row.games ? row : null };
  }
  rank(rating) { return this.sql().exec('SELECT COUNT(*) AS n FROM players WHERE season = ? AND games > 0 AND rating > ?', seasonConfig(this.env).id, rating).one().n + 1; }
  async ladder(req, url) {
    const q = this.sql(), se = seasonConfig(this.env);
    if (url.pathname === '/vs/ladder') {
      const top = q.exec('SELECT name, rating, games, w, l, streak FROM players WHERE season = ? AND games > 0 ORDER BY rating DESC, games DESC LIMIT ?', se.id, ELO.TOP).toArray()
        .map((x, i, a) => ({ rank: i && a[i - 1].rating === x.rating ? null : i + 1, name: x.name || 'Anonymous', rating: Math.round(x.rating), games: x.games, w: x.w, l: x.l, streak: x.streak, provisional: x.games < ELO.PROVISIONAL }));
      top.forEach((x, i) => { if (x.rank === null) x.rank = top[i - 1].rank; });     // a tie shares the rank (as /vs/me counts it)
      return reply({ top, players: q.exec('SELECT COUNT(*) AS n FROM players WHERE season = ? AND games > 0', se.id).one().n,
        season: { id: se.id, name: se.name, startAt: se.startAt, endAt: se.endAt } });
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
    // /vs/standings (the Cup object only, never routed from outside): the ladder as it stood at a moment, each rating
    // with every rated game after it taken back off (the games table keeps each one's change and time), the players with
    // minGames rated games by then, best first
    if (url.pathname === '/vs/standings') {
      const at = Number(body.at) || Date.now(), n = Math.max(1, Math.min(64, Number(body.n) || 16)), min = Number(body.minGames) || 0;
      // One pass over the games after `at` (games_at), summed per player, then joined: never a scan of the games per
      // player (the subqueries this replaced read every game once per player, billions of rows a day while the Cup's
      // projection refreshed). `at` now (the projection): no game is after it, so no game is read.
      const rows = q.exec(`WITH g AS (
            SELECT a AS kh, da AS d FROM games WHERE at > ? AND rated = 1
            UNION ALL SELECT b AS kh, db AS d FROM games WHERE at > ? AND rated = 1),
          s AS (SELECT kh, SUM(d) AS d, COUNT(*) AS n FROM g GROUP BY kh)
        SELECT p.kh AS kh, p.name AS name, p.rating - COALESCE(s.d, 0) AS r, p.games - COALESCE(s.n, 0) AS n
        FROM players p LEFT JOIN s ON s.kh = p.kh WHERE p.season = ? AND p.games > 0`, at, at, se.id).toArray()
        .filter((x) => x.n >= min).sort((a, b) => b.r - a.r || b.n - a.n || (a.kh < b.kh ? -1 : 1)).slice(0, n);
      return reply({ top: rows.map((x) => ({ kh: x.kh, name: x.name || 'Anonymous', rating: Math.round(x.r), games: x.n })) });
    }
    // /vs/report: from a room object only (never routed from outside: the worker sends /vs/* paths to objects by name)
    const [k0, k1] = body.seats || [];
    if (!k0 || !k1 || k0 === k1 || (body.winner !== 0 && body.winner !== 1) || !ROOM_RE.test(String(body.room || ''))) return reply({ error: 'report' }, 400);
    const done = q.exec('SELECT out FROM games WHERE room = ?', body.room).toArray()[0];
    if (done) return reply(JSON.parse(done.out));
    const now = Date.now(), p = [this.player(k0), this.player(k1)];
    const pairN = q.exec('SELECT COUNT(*) AS n FROM games WHERE rated = 1 AND at > ? AND ((a = ? AND b = ?) OR (a = ? AND b = ?))', Math.max(now - 86400_000, se.sAt - 1), k0, k1, k1, k0).one().n;   // (the season's games)
    const inSeason = now >= se.sAt && now < se.eAt, rated = inSeason && pairN < ELO.PAIR_CAP;
    const e0 = 1 / (1 + 10 ** ((p[1].rating - p[0].rating) / 400)), exp = [e0, 1 - e0];
    const before = p.map((x) => x.rating), d = [0, 0];
    p.forEach((x, s) => {
      const win = body.winner === s, k = x.games < ELO.PROVISIONAL ? ELO.K_NEW : ELO.K;
      if (rated) {
        x.rating = Math.max(ELO.FLOOR, x.rating + k * ((win ? 1 : 0) - exp[s]));
        d[s] = x.rating - before[s];                // (as it moved, the floor counted: /vs/standings takes them back off)
        x.games += 1;
        if (win) { x.w += 1; x.streak = x.streak > 0 ? x.streak + 1 : 1; } else { x.l += 1; x.streak = x.streak < 0 ? x.streak - 1 : -1; }
        x.peak = Math.max(x.peak, x.rating);
      }
      const nm = clean(body.names && body.names[s]);
      if (nm) x.name = nm;
      x.updated = now;
      if (!rated && x.old) return;                  // (a game the season does not count: a past season's row stays as it was)
      if (x.old) q.exec('INSERT OR IGNORE INTO past (kh, season, name, rating, games, w, l, peak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        x.kh, x.old.season, x.old.name, x.old.rating, x.old.games, x.old.w, x.old.l, x.old.peak);
      q.exec(`INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated, season) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kh) DO UPDATE SET name = excluded.name, rating = excluded.rating, games = excluded.games, w = excluded.w, l = excluded.l,
        peak = excluded.peak, streak = excluded.streak, updated = excluded.updated, season = excluded.season`, x.kh, x.name, x.rating, x.games, x.w, x.l, x.peak, x.streak, x.updated, se.id);
    });
    const out = { rated, reason: rated ? null : inSeason ? 'pair' : 'season', ratings: p.map((x, s) => ({ before: Math.round(before[s]), after: Math.round(x.rating), delta: Math.round(x.rating) - Math.round(before[s]),
      games: x.games, rank: x.games ? this.rank(x.rating) : null, provisional: x.games < ELO.PROVISIONAL })) };
    q.exec('INSERT INTO games (room, a, b, winner, by, rated, da, db, at, out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      body.room, k0, k1, body.winner, String(body.by || 'score'), rated ? 1 : 0, d[0], d[1], now, JSON.stringify(out));
    return reply(out);
  }
}
