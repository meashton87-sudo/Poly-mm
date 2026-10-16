// Versus: two players, one late-game spot, each calling their own side. One Durable Object per room (its code), plus
// one named 'lobby' that pairs quick-match players.
//
// The server never plays football. Both phones run the same simulator with the same seed, so the same two calls give
// the same snap on both. The room only seals the calls: each player's half of a decision is held until every half
// the decision needs is in (both at a snap, the team with the ball at a try or a kickoff), then both go out together,
// so neither side ever sees the other's call first. A half missing after HALF_MS is filled with null (the phone plays
// its default: the simulator's own call), so a player who walks away cannot stall the game.
//
//   GET  /vs/ws?room=CODE&key=DEVICEKEY   (WebSocket)   the room: seat by device, the calls, the opponent's presence
//   POST /vs/quick {key}                                 a room code: an open quick-match room, or a new one
//
// Client -> room: {t:'setup', spot}  seat 0 picks the spot (once)
//                 {t:'half', n, need:[seats], half}  its call for decision n (null: its default)
//                 {t:'rematch'}  {t:'ping'}
// Room -> client: {t:'hello', seat, seed, spot, decisions, online}  on connecting (decisions: every one so far, for a
//                   reconnect to catch up)
//                 {t:'peer', online:[bool, bool]}  {t:'setup', spot}  {t:'locked', n, seat}
//                 {t:'step', n, halves}  {t:'rematch', room}  {t:'err', e}
export const ROOM_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const HALF_MS = 40_000;              // a call not in by then is played as the default
const ROOM_TTL_MS = 6 * 3600_000;           // a room is cleared this long after it was made
const QUICK_WAIT_MS = 90_000;               // a quick-match room older than this is not offered any more
const MAX_MSG = 4096, MAX_N = 600;

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
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket wanted', { status: 426 });
    const key = url.searchParams.get('key') || '', room = url.searchParams.get('room') || '';
    if (!KEY_RE.test(key) || !ROOM_RE.test(room)) return new Response('bad room or key', { status: 400 });
    const kh = await hashKey(key);
    const R = (await this.ctx.storage.get('room')) || { room, seats: [null, null], seed: crypto.getRandomValues(new Uint32Array(1))[0],
      spot: null, n: 0, created: Date.now() };
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
    server.send(JSON.stringify({ t: 'hello', seat, seed: R.seed, spot: R.spot, decisions, online: this.online(), full: R.seats.every(Boolean) }));
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
    const kh = await hashKey(body.key), now = Date.now();
    const w = await this.ctx.storage.get('waiting');
    if (w && now - w.at < QUICK_WAIT_MS && w.kh !== kh) {
      await this.ctx.storage.delete('waiting');
      return new Response(JSON.stringify({ room: w.room, host: false }), { status: 200 });
    }
    if (w && w.kh === kh && now - w.at < QUICK_WAIT_MS) return new Response(JSON.stringify({ room: w.room, host: true }), { status: 200 });
    const room = roomCode();
    await this.ctx.storage.put('waiting', { room, kh, at: now });
    return new Response(JSON.stringify({ room, host: true }), { status: 200 });
  }
}
