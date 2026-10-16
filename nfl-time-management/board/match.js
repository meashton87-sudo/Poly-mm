// Versus: two players, one late-game spot, each calling their own side. One Durable Object per room (its code), plus
// one named 'lobby' that pairs quick-match players.
//
// The server never plays football. Both phones run the same simulator with the same seed, so the same two calls give
// the same snap on both. The room only seals the calls: each player's half of a decision is held until every half
// the decision needs is in (both at a snap, the team with the ball at a try or a kickoff), then both go out together,
// so neither side ever sees the other's call first. A half missing after HALF_MS is filled with null (the phone plays
// its default: the simulator's own call), so a player who walks away cannot stall the game.
//
//   GET  /vs/ws?room=CODE&key=DEVICEKEY&mode=M (WebSocket)  the room: seat by device, the calls, the presence
//   POST /vs/quick {key, mode}                               a room code: an open room of that mode, or a new one
//   GET  /vs/ladder                                          the ranked ladder (the top 50)
//   POST /vs/me {key}                                        your ranked rating
// Modes: ranked (rated, Elo), casual, friend. Each player brings a team ({t:'team'}); the room starts when both have.
// Ranked: both phones report the winner ({t:'result'}); when they agree (or the other side has left), the ladder
// object ('ladder') moves both ratings.
//
// Client -> room: {t:'team', team, name}  this seat's team (once; refused with {t:'taken'} if the other seat has it)  {t:'result', winner}  ranked: who won (a seat)
//                 {t:'setup', spot}  seat 0 picks the spot (once)
//                 {t:'half', n, need:[seats], half}  its call for decision n (null: its default)
//                 {t:'rematch'}  {t:'ping'}
// Room -> client: {t:'hello', seat, seed, spot, decisions, online}  on connecting (decisions: every one so far, for a
//                   reconnect to catch up)
//                 {t:'peer', online:[bool, bool]}  {t:'setup', spot}  {t:'locked', n, seat}
//                 {t:'step', n, halves}  {t:'rematch', room}  {t:'teams', teams, names}  {t:'rated', ratings}
export const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const HALF_MS = 40_000;              // a call not in by then is played as the default
const ROOM_TTL_MS = 6 * 3600_000;           // a room is cleared this long after it was made
const QUICK_WAIT_MS = 90_000;               // a quick-match room older than this is not offered any more
const MAX_MSG = 4096, MAX_N = 600;
const MODES = ['ranked', 'casual', 'friend'];
const TEAM_RE = /^[A-Z]{2,3}$/;
const ELO_K = 32, ELO_START = 1000, TOP = 50;
const clean = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
async function hashKey(k) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`)));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Match {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/vs/quick') return this.quick(req);
    if (url.pathname === '/vs/ladder' || url.pathname === '/vs/me' || url.pathname === '/vs/report') return this.ladder(req, url);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', room = url.searchParams.get('room') || '';
    if (!KEY_RE.test(key) || !ROOM_RE.test(room)) return new Response('bad room or key', { status: 400 });
    const kh = await hashKey(key);
    const mode = MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'friend';
    const R = (await this.ctx.storage.get('room')) || { room, mode, seats: [null, null], seed: crypto.getRandomValues(new Uint32Array(1))[0],
      spot: null, n: 0, created: Date.now(), teams: [null, null], names: ['', ''], results: {} };
    let seat = R.seats.indexOf(kh);
    if (seat < 0) seat = R.seats.indexOf(null);
    if (seat < 0) return new Response('the room is full', { status: 409 });
    R.seats[seat] = kh;
    await this.ctx.storage.put('room', R);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(R.created + ROOM_TTL_MS);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    for (const old of this.ctx.getWebSockets(`s${seat}`)) { try { old.close(4000, 'replaced'); } catch (e) { /* gone */ } }
    this.ctx.acceptWebSocket(server, [`s${seat}`]);
    server.serializeAttachment({ seat });
    const decisions = [];
    for (let i = 0; i < R.n; i++) decisions.push(await this.ctx.storage.get(`d:${i}`));
    server.send(JSON.stringify({ t: 'hello', seat, seed: R.seed, spot: R.spot, decisions, online: this.online(), full: R.seats.every(Boolean),
      mode: R.mode, teams: R.teams, names: R.names, rated: R.rated || null }));
    this.broadcast({ t: 'peer', online: this.online(), full: R.seats.every(Boolean) });
    const pend = await this.ctx.storage.get('pend');
    if (pend && pend.n === R.n) for (const s of Object.keys(pend.halves)) server.send(JSON.stringify({ t: 'locked', n: pend.n, seat: Number(s) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  online() { return [0, 1].map((s) => this.ctx.getWebSockets(`s${s}`).length > 0); }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) { /* closing */ } }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const { seat } = ws.deserializeAttachment() || {};
    if (seat !== 0 && seat !== 1) return;
    const R = await this.ctx.storage.get('room');
    if (!R) return;
    if (m.t === 'ping') { ws.send('{"t":"pong"}'); return; }
    if (m.t === 'team') {
      if (R.teams[seat] || !TEAM_RE.test(String(m.team || ''))) return;
      if (R.teams[1 - seat] === m.team) { ws.send(JSON.stringify({ t: 'taken', team: m.team })); return; }   // never the same team on both sides
      R.teams[seat] = m.team;
      R.names[seat] = clean(m.name);
      await this.ctx.storage.put('room', R);
      this.broadcast({ t: 'teams', teams: R.teams, names: R.names });
      return;
    }
    if (m.t === 'result') {
      if (R.mode !== 'ranked' || R.rated || !R.seats.every(Boolean) || (m.winner !== 0 && m.winner !== 1 && m.winner !== -1)) return;
      R.results = { ...(R.results || {}), [seat]: m.winner };
      const other = 1 - seat, agree = other in R.results ? R.results[other] === m.winner : !this.online()[other];
      if (other in R.results && !agree) { R.rated = { void: true }; await this.ctx.storage.put('room', R); this.broadcast({ t: 'rated', ratings: null }); return; }
      if (!agree) { await this.ctx.storage.put('room', R); return; }
      const res = await this.env.MATCH.get(this.env.MATCH.idFromName('ladder')).fetch(new Request('https://ladder/vs/report', {
        method: 'POST', body: JSON.stringify({ seats: R.seats, names: R.names, winner: m.winner }) }));
      R.rated = { ratings: (await res.json()).ratings };
      await this.ctx.storage.put('room', R);
      this.broadcast({ t: 'rated', ratings: R.rated.ratings });
      return;
    }
    if (m.t === 'setup') {
      if (R.spot || seat !== 0 || typeof m.spot !== 'string' || m.spot.length > 64) return;
      R.spot = m.spot;
      await this.ctx.storage.put('room', R);
      this.broadcast({ t: 'setup', spot: R.spot });
      return;
    }
    if (m.t === 'rematch') {                 // both have to ask: then one new room for both
      R.again = [...new Set([...(R.again || []), seat])];
      if (!R.next) R.next = roomCode();
      await this.ctx.storage.put('room', R);
      this.broadcast(R.again.length === 2 ? { t: 'rematch', room: R.next } : { t: 'rematch-ask', seat });
      return;
    }
    if (m.t !== 'half' || m.n !== R.n || R.n >= MAX_N) return;
    const need = Array.isArray(m.need) ? [...new Set(m.need.filter((x) => x === 0 || x === 1))].sort() : [];
    if (!need.length || !need.includes(seat)) return;
    let pend = await this.ctx.storage.get('pend');
    if (!pend || pend.n !== R.n) pend = { n: R.n, need, halves: {}, at: Date.now() };
    if (seat in pend.halves) return;                                   // a call, once locked, stays
    pend.halves[seat] = m.half === undefined ? null : m.half;
    if (need.length > pend.need.length) pend.need = need;              // both phones say the same; take the wider one
    if (pend.need.every((s) => s in pend.halves)) return this.commit(R, pend);
    await this.ctx.storage.put('pend', pend);
    this.broadcast({ t: 'locked', n: pend.n, seat });
    await this.ctx.storage.setAlarm(pend.at + HALF_MS);
  }

  async commit(R, pend) {
    const d = { n: pend.n, halves: pend.halves };
    await this.ctx.storage.put(`d:${pend.n}`, d);
    R.n = pend.n + 1;
    await this.ctx.storage.put('room', R);
    await this.ctx.storage.delete('pend');
    await this.ctx.storage.setAlarm(R.created + ROOM_TTL_MS);
    this.broadcast({ t: 'step', ...d });
  }

  async alarm() {
    const R = await this.ctx.storage.get('room');
    if (!R) return;
    const pend = await this.ctx.storage.get('pend');
    if (pend && pend.n === R.n && Date.now() >= pend.at + HALF_MS - 50) {
      for (const s of pend.need) if (!(s in pend.halves)) pend.halves[s] = null;    // the missing call: the default
      return this.commit(R, pend);
    }
    if (Date.now() >= R.created + ROOM_TTL_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'expired'); } catch (e) { /* gone */ } }
      await this.ctx.storage.deleteAll();
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* closed */ }
    this.broadcast({ t: 'peer', online: this.online().map((on, s) => on && !this.ctx.getWebSockets(`s${s}`).every((x) => x === ws)) });
  }
  webSocketError(ws) { return this.webSocketClose(ws); }

  // the lobby (the object named 'lobby'): one open room at a time; the next player in gets it
  async quick(req) {
    let body = {};
    try { body = await req.json(); } catch (e) { /* none */ }
    if (!KEY_RE.test(String(body.key || ''))) return new Response(JSON.stringify({ error: 'key wanted' }), { status: 400 });
    const kh = await hashKey(body.key), now = Date.now(), mode = body.mode === 'ranked' ? 'ranked' : 'casual', slot = `waiting:${mode}`;
    const w = await this.ctx.storage.get(slot);
    if (w && now - w.at < QUICK_WAIT_MS && w.kh !== kh) {
      await this.ctx.storage.delete(slot);
      return reply({ room: w.room, host: false, mode });
    }
    if (w && w.kh === kh && now - w.at < QUICK_WAIT_MS) return reply({ room: w.room, host: true, mode });
    const room = roomCode();
    await this.ctx.storage.put(slot, { room, kh, at: now });
    return reply({ room, host: true, mode });
  }

  // the ladder (the object named 'ladder'): ratings by device, the top of the table
  async ladder(req, url) {
    const S = this.ctx.storage;
    if (url.pathname === '/vs/ladder') return reply({ top: (await S.get('top')) || [] });
    let body = {};
    try { body = await req.json(); } catch (e) { /* none */ }
    if (url.pathname === '/vs/me') {
      if (!KEY_RE.test(String(body.key || ''))) return reply({ error: 'key wanted' }, 400);
      const me = await S.get(`r:${await hashKey(body.key)}`);
      return reply(me ? { rating: Math.round(me.rating), w: me.w, l: me.l, t: me.t || 0 } : { rating: ELO_START, w: 0, l: 0, t: 0 });
    }
    // /vs/report: only from a room object (it is not routed from outside: the worker sends /vs/* paths by name)
    const [k0, k1] = body.seats || [];
    if (!k0 || !k1) return reply({ error: 'seats' }, 400);
    const get = async (k, name) => ({ name: '', rating: ELO_START, w: 0, l: 0, t: 0, ...((await S.get(`r:${k}`)) || {}), ...(name ? { name } : {}) });
    const a = await get(k0, clean(body.names && body.names[0])), b = await get(k1, clean(body.names && body.names[1]));
    const sa = body.winner === 0 ? 1 : body.winner === 1 ? 0 : 0.5, ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const before = [a.rating, b.rating];
    a.rating += ELO_K * (sa - ea); b.rating += ELO_K * ((1 - sa) - (1 - ea));
    if (sa === 1) { a.w++; b.l++; } else if (sa === 0) { a.l++; b.w++; } else { a.t++; b.t++; }
    await S.put(`r:${k0}`, a); await S.put(`r:${k1}`, b);
    let top = ((await S.get('top')) || []).filter((x) => x.k !== k0 && x.k !== k1);
    for (const [k, x] of [[k0, a], [k1, b]]) if (x.name) top.push({ k, name: x.name, rating: Math.round(x.rating), w: x.w, l: x.l });
    top = top.sort((x, y) => y.rating - x.rating).slice(0, TOP);
    await S.put('top', top);
    return reply({ ratings: [{ before: Math.round(before[0]), after: Math.round(a.rating) }, { before: Math.round(before[1]), after: Math.round(b.rating) }] });
  }
}
