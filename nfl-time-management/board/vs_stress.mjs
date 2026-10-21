// Versus under load: a crowd of bots plays whole matches against each other through the real lobby, rooms and ladder
// (match.js, in memory: vs_world.mjs) with the real engine (board/assets/vs, as the site workflow puts it there), and
// misbehaves the way phones do: slow calls, no calls, junk, double taps, dropped connections, reloads, players who
// never come back, players who never show up, rematches. Then it checks everything:
//   - every match ends (on the field, or a forfeit, a no-show): no room left hanging, no decision past its deadline
//   - every match replays to the same result from its decisions (the room's state is never corrupted)
//   - the college-overtime rules on every snap; the winner is the side with more points
//   - each phone ends with the room's state
//   - the ladder: every ranked match rated once, the ratings exactly what Elo says in order, the pair cap, the records
//   node board/vs_stress.mjs [matches, default 2000] [seed, default 1] [players, default 40]
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, FakeClient } from './vs_world.mjs';
import { PLAY_MS, WATCH_MS, DECIDE_MS, FIRST_MS, FORFEIT_MS, NOSHOW_MS, ELO, loadEngine } from './match.js';
import VSCore from '../web/vs_core.js';
import { lazySimulator } from './lazy_sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = process.env.VS_ASSETS || path.join(HERE, 'assets');
const N = +(process.argv[2] || 2000), SEED = +(process.argv[3] || 1), PLAYERS = +(process.argv[4] || 40);
if (!fs.existsSync(path.join(ASSETS, 'vs', 'engine_data.pack'))) { console.error(`no engine data in ${ASSETS}/vs (build the site first)`); process.exit(1); }

const R = VSCore.rng(SEED * 7919 + 13);
const pick = (a) => a[Math.floor(R() * a.length)];
const chance = (p) => R() < p;
const between = (lo, hi) => lo + R() * (hi - lo);
const w = new World({ assetsDir: ASSETS });
const E = await loadEngine(w.env);
const TEAMS = Object.keys(E.pool.teams), CALLS = E.eng.pb.calls;
const stats = { started: 0, finished: 0, by: {}, rounds: {}, modes: {}, decisions: 0, defaults: 0, junk: 0, drops: 0, reloads: 0, quits: 0, noshows: 0, rematches: 0, taken: 0, maxRound: 0, games: {} };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
let done = 0;

// one bot: a phone with a temperament
class Bot {
  constructor(i) {
    this.i = i; this.key = `stress-device-${SEED}-${String(i).padStart(6, '0')}`; this.name = `Bot${i}`;
    this.team = pick(TEAMS); this.c = null; this.room = null; this.ms = null; this.n = 0; this.seat = -1; this.answered = -1; this.busy = false; this.game = 'five';
    this.mood = { slow: R() * 0.15, junk: R() * 0.06, drop: R() * 0.03, quit: R() * 0.01, noshow: 0.01, rematch: R() * 0.5 };
  }
  live() { return !!(this.c && this.c.ws && !this.c.ws.closed); }
  log(...a) { if (process.env.VS_DEBUG) console.log(`[${((w.now - T0) / 1000).toFixed(1)}] bot${this.i}`, ...a); }
  async next() {                          // after a match (or at the start): queue again, or a friend match
    if (done >= N) return;
    this.room = null; this.ms = null; this.n = 0; this.seat = -1; this.answered = -1; this.over = false;
    this.game = chance(0.6) ? 'five' : 'ot';             // (the Five-Minute Drill, the shootout)
    if (chance(0.15)) return friends.push(this);
    if (chance(0.08)) { stats.cpu = (stats.cpu || 0) + 1; ++cpuRooms; return this.join(Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(R() * 31)]).join(''), 'cpu'); }    // the computer
    const mode = chance(0.55) ? 'ranked' : 'casual';
    this.c = new FakeClient(w, this.key);
    this.c.handlers.push((m) => this.lobby(m));
    if (chance(0.3)) this.team = pick(TEAMS);
    await this.c.queue({ mode, team: this.team, name: this.name, game: this.game });
  }
  lobby(m) {
    if (m.t !== 'match') return;
    if (chance(this.mood.noshow)) { this.log('no-show', m.room); stats.noshows++; w.later(NOSHOW_MS + 5000, () => this.next()); return; }
    w.later(between(200, 3000), () => this.join(m.room, m.mode));
  }
  async join(room, mode) {
    this.room = room; this.mode = mode;
    this.c = new FakeClient(w, this.key);
    this.c.handlers.push((m) => this.on(m));
    const st = await this.c.open(room, { mode, since: this.n, game: this.game });
    if (st !== 101) { this.log('refused', room, st); return this.next(); }
  }
  on(m) {
    if (JSON.stringify(m).includes('"seed"')) leaks.push(`${m.t} to bot${this.i}`);      // a phone must never learn a seed
    if (m.t === 'hello') {
      this.seat = m.seat; this.mode = m.mode;
      if (m.ms) this.ms = m.ms;
      if (m.decisions && m.decisions.length) { const d = m.decisions[m.decisions.length - 1]; this.ms = d.ms; }
      this.n = m.n;
      if (m.phase === 'over') return this.finish(m.result);
      if (m.phase === 'wait' && !m.teams[m.seat]) w.later(between(100, 4000), () => this.chooseTeam(m.teams[1 - m.seat]));
      if (m.phase === 'live') this.think();
    } else if (m.t === 'taken') {
      stats.taken++;
      this.team = pick(TEAMS.filter((t) => t !== m.team));
      w.later(between(500, 3000), () => this.c.send({ t: 'team', team: this.team, name: this.name }));
    } else if (m.t === 'start') {
      this.ms = m.ms; this.n = 0; this.think();
    } else if (m.t === 'step') {
      this.ms = m.ms; this.n = m.n + 1;
      if (m.result) return this.finish(m.result);
      this.think();
    } else if (m.t === 'clock') {
      clocks.set(`${this.room}:${m.n}:${this.seat}`, m.deadline);     // the room's word on this seat's 30 seconds
    } else if (m.t === 'over') {
      this.finish(m.result);
    } else if (m.t === 'rematch') {
      stats.rematches++;
      w.later(between(300, 2000), () => { if (this.live()) this.c.drop(); this.over = false; this.answered = -1; this.ms = null; this.n = 0; this.join(m.room, 'casual'); });
    }
  }
  chooseTeam(theirs) {
    if (this.over || !this.c) return;
    if (chance(0.2) && theirs) this.team = theirs;               // the same team as the other side: refused, pick again
    this.c.send({ t: 'team', team: this.team, name: this.name });
  }
  finish(result) {
    if (this.over) return;
    this.over = true;
    if (result && this.room) results.set(this.room, result);
    if (result && result.by === 'score' && this.room) phoneFinal.push({ room: this.room, bot: this.i, ms: this.ms, result });
    if (chance(this.mood.rematch) && this.mode !== 'ranked') { this.c.send({ t: 'rematch' }); w.later(20000, () => { if (this.over && this.live() && this.room) { this.c.drop(); this.next(); } }); return; }
    w.later(between(1000, 8000), () => { if (this.c && this.c.ws && !this.c.ws.closed) this.c.drop(); this.next(); });
  }
  // my decision? answer it, on my own time (sometimes past the deadline, sometimes junk, sometimes twice)
  think() {
    if (!this.ms || this.ms.over || this.over) return;
    const need = VSCore.need(this.ms);
    if (!need.includes(this.seat) || this.answered === this.n) return;
    const n = this.n;
    this.answered = n;
    // the call comes up after the play is watched (a phone that never says so: the decision's last moment rules)
    const up = between(800, WATCH_MS), late = chance(this.mood.slow);
    const delay = up + (late ? between(DECIDE_MS - 5000, DECIDE_MS + 15000) : between(300, 20000));
    if (!chance(0.1)) w.later(up, () => { if (!this.over && this.live() && this.n === n) this.c.send({ t: 'ready', n }); });
    if (chance(0.03)) w.later(up + 2000, () => { if (this.live()) this.c.send({ t: 'ready', n: n + 1 }); });   // a confused one
    w.later(delay, () => this.answer(n));
    // the phone drops sometimes while thinking: back after a while (or never: a quitter)
    if (chance(this.mood.drop)) {
      w.later(between(100, delay + 1000), () => {
        if (this.over || !this.live()) return;
        stats.drops++;
        this.c.drop();
        if (chance(this.mood.quit * 20)) { stats.quits++; this.log('quit', this.room); this.quitAt = w.now; w.later(FORFEIT_MS + 20000, () => this.next()); return; }
        w.later(chance(0.85) ? between(500, 30000) : between(40000, 90000), () => { if (!this.over) { stats.reloads++; this.join(this.room, this.mode); } });
      });
    }
  }
  answer(n) {
    if (this.over || !this.live() || this.n !== n || !this.ms) return;
    const role = VSCore.role(this.ms, this.seat);
    if (!role) return;
    let half;
    if (chance(this.mood.junk)) { stats.junk++; half = pick([null, 'x', 42, { pick: 'sideways' }, { def: 'prevent' }, { dc: { pers: 'nickel', front: 'even', cover: 'c9', rush: 4 } }, { dc: { pers: 'x', rush: 5 } }, { dc: 'blitz' },
      { action: { call: 'nope', play: 'teleport', looks: -5, pers: 999 } }, { two: 'yes' }, { action: [] }]); }
    else if (role === 'toss') half = { call: pick(VSCore.COIN) };
    else if (role === 'pick' && !this.ms.cot) half = { pick: pick(this.ms.reg.pick.end ? ['receive', 'kick'] : VSCore.REG_PICKS) };
    else if (role === 'pick') half = { pick: pick(this.ms.cot.pick.end ? ['offense', 'defense'] : VSCore.PICKS) };
    else if (role === 'kick') half = { action: { kick: pick(['deep', 'return', 'touchback', 'onside']) } };
    else if (role === 'defense') half = { dc: { pers: pick(VSCore.DC.pers), front: pick(VSCore.DC.front), cover: pick(VSCore.DC.cover), rush: pick(VSCore.DC.rush) }, ...(chance(0.03) ? { to_def: true } : {}) };
    else if (role === 'pat') half = chance(0.45) ? { two: true } : { action: { pat: 'xp' } };
    else if (chance(0.04)) half = { timeout: true, ...(chance(0.2) ? { rundown: true } : {}) };
    else if (chance(0.06)) half = { action: { play: pick(['fg', 'punt', 'kneel', 'spike']), to_off: false } };
    else {
      const c = pick(CALLS);
      half = { action: { to_off: false, play: c.kind, call: c.id, oob: chance(0.1), looks: 0, ...(chance(0.3) ? { pers: pick([11, 12, 21, 13]) } : {}),
        ...(chance(0.5) ? { tempo: pick(['hurry', 'normal', 'milk', 'urgent']) } : {}), ...(this.ms.root.try2 ? { pat: 'two' } : {}) } };
    }
    this.c.send({ t: 'half', n, half });
    if (chance(0.05)) this.c.send({ t: 'half', n, half: { action: { call: CALLS[0].id } } });    // a double tap
    if (chance(0.02)) this.c.send({ t: 'half', n: n + 3, half: {} });                            // a confused phone
  }
}
const friends = [], results = new Map(), phoneFinal = [], leaks = [], clocks = new Map();
let cpuRooms = 0;
const T0 = w.now;
const bots = Array.from({ length: PLAYERS }, (_, i) => new Bot(i));
// friend matches: two bots waiting for a friend get a room code
async function pairFriends() {
  while (friends.length >= 2 && done < N) {
    const a = friends.shift(), b = friends.shift(), code = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(R() * 31)]).join('');
    b.game = a.game;
    a.join(code, 'friend');
    w.later(between(500, 10000), () => b.join(code, 'friend'));
    // a friend who never comes (their join refused): the one waiting gives up after a while
    for (const x of [a, b]) w.later(180000, () => { if (x.room === code && !x.over && x.ms === null && x.live()) { x.log('gave up waiting', code); x.c.drop(); x.next(); } });
  }
}
for (const b of bots) w.later(between(0, 20000), () => b.next());

// each match is checked the moment it is over (a room is cleared six hours after it was made):
//   it replays to the same football from its decisions, every decision on time, the overtime rules, the result
const verified = new Map();
let replayed = 0;
function checkRoom(code, o, room) {
  if (room.result.by === 'noshow') { bump(stats.by, 'noshow'); assert.ok(!room.ms && room.pre && room.result.winner === -1, `${code}: a no-show never started`); return; }
  if (!room.ms) {        // ranked: one side never came: a forfeit, rated
    bump(stats.by, 'noshow-forfeit');
    assert.ok(room.mode === 'ranked' && room.result.by === 'forfeit' && room.result.why === 'noshow' && room.result.winner === 1 - room.result.loser, `${code}: a ranked no-show is a forfeit`);
    assert.ok(room.rated && room.rated.ratings, `${code}: and rated`);
    return;
  }
  stats.started++;
  bump(stats.modes, room.mode); bump(stats.by, room.result.by);
  let ms = room.ms0, prevAt = null;
  assert.ok(room.ms, `${code}: a state`);
  const step = VSCore.stepper(E.eng, E.pool, room.teams[0], room.teams[1], lazySimulator, room.mode === 'ranked');
  bump(stats.games, room.game);
  for (let i = 0; i < room.n; i++) {
    const d = o.store.get(`d:${i}`);
    assert.ok(d && d.n === i, `${code}: decision ${i} kept`);
    // the decision's last moment, or sooner: each seat's own 30 seconds from its call coming up, once every seat
    // still out had one
    const cap = i === 0 ? room.started + FIRST_MS : prevAt + PLAY_MS;
    const dls = VSCore.need(ms).map((s) => Math.min(cap, clocks.get(`${code}:${i}:${s}`) ?? cap));
    const limit = Math.max(...dls);
    assert.ok(d.at <= limit + 100, `${code}: decision ${i} played ${d.at - limit} ms after its deadline`);
    for (const x of dls) assert.ok(x <= cap, `${code}: decision ${i}: a seat's clock past the decision's last moment`);
    if (dls.some((x) => x < cap)) stats.clocked = (stats.clocked || 0) + 1;
    prevAt = d.at;
    for (const s of VSCore.need(ms)) if (d.halves[s] == null) stats.defaults++;
    const before = ms;
    const out = VSCore.apply(ms, d.halves, step, d.seed);
    assert.deepStrictEqual(out.ms, d.ms, `${code}: decision ${i} replays the same`);
    ms = out.ms;
    stats.decisions++;
    const r = ms.root;
    if (!before.cot && !ms.cot) {            // the Five-Minute Drill's clock: only down, never past 0:00; timeouts only down
      assert.ok(r.t <= before.root.t + 1e-9 && r.t >= 0 && r.to.every((x, s) => x >= 0 && x <= before.root.to[s]), `${code}: decision ${i}: the clock and the timeouts`);
      stats.regSnaps = (stats.regSnaps || 0) + (d.res ? 1 : 0);
    }
    if (!before.cot && ms.cot) { bump(stats.by, 'tied at 0:00'); assert.strictEqual(ms.cot.score0[0], ms.cot.score0[1], `${code}: overtime from a tie`); }
    if (!ms.over && ms.cot) {
      assert.strictEqual(r.t, VSCore.COT_T, `${code}: no clock in overtime`);
      if (ms.cot.round >= 3 && !ms.cot.pick) assert.ok(r.try2, `${code}: 3rd overtime on: a two-point play`);
      if (ms.cot.round >= 2) assert.notStrictEqual(r.phase, VSCore.PAT, `${code}: 2nd overtime on: no kick after a touchdown`);
      if (!ms.cot.pick && ms.cot.round < 3 && d.kind === 'pick') assert.deepStrictEqual([r.yl, r.down, r.ytg], [25, 1, 10], `${code}: at the 25`);
    }
  }
  assert.deepStrictEqual(ms, room.ms, `${code}: the replay ends where the room did`);
  replayed++;
  if (room.result.by === 'score') {
    stats.finished++;
    assert.ok(ms.over, `${code}: over on the field`);
    assert.strictEqual(room.result.winner, ms.root.score[0] > ms.root.score[1] ? 0 : 1, `${code}: the winner has more points`);
    assert.notStrictEqual(ms.root.score[0], ms.root.score[1], `${code}: never a tie`);
    const rd = ms.cot ? ms.cot.round : 0;
    bump(stats.rounds, rd); stats.maxRound = Math.max(stats.maxRound, rd);
  } else {
    assert.ok(['forfeit', 'abandoned'].includes(room.result.by), `${code}: ended by ${room.result.by}`);
    if (room.result.by === 'forfeit') assert.strictEqual(room.result.winner, 1 - room.result.loser);
  }
  if (room.mode === 'ranked' && room.result.winner >= 0) {
    assert.ok(room.rated && room.rated.ratings, `${code}: a ranked match is rated`);
    // the room's own reckoning (the end card's, at once) is the ladder's
    // (when the ratings it started from are the ladder's: a player whose last match was still being rated as this one
    // was paired gets the ladder's word a moment later, on the same card)
    if (room.rated.rated) {
      const same = room.result.est.ratings.every((x, s) => x.before === room.rated.ratings[s].before);
      if (same) assert.deepStrictEqual(room.result.est.ratings.map((x) => x.after), room.rated.ratings.map((x) => x.after), `${code}: the end card's rating change is the ladder's`);
      bump(stats, same ? 'estExact' : 'estStale');
    }
  }
  if (room.mode !== 'ranked') assert.ok(!room.rated, `${code}: only ranked is rated`);
}
function checkOver() {
  for (const [n, o] of w.objects) {
    if (!n.startsWith('room:') || verified.has(n)) continue;
    const room = o.store.get('room');
    if (!room || room.phase !== 'over') continue;
    if (room.mode === 'ranked' && room.result.winner >= 0 && !room.rated && w.now - (room.deadline || 0) < 10 * 60_000) continue;   // its rating is on the way
    checkRoom(n.slice(5), o, room);
    verified.set(n, { mode: room.mode, result: room.result, ms: room.ms, rated: !!room.rated });
  }
  return verified.size;
}

// run: until N matches are over, in world time
const t0 = performance.now();
let lastDone = -1, lastPrint = performance.now();
for (let tick = 0; done < N; tick++) {
  await w.advance(5000);
  await pairFriends();
  if (tick % 12 === 0) {
    done = checkOver();
    if (performance.now() - lastPrint > 15000) { console.log(`… ${done}/${N} matches, ${((w.now - T0) / 3600000).toFixed(1)} h of play, ${Math.round((performance.now() - t0) / 1000)} s`); lastPrint = performance.now(); }
    if (tick % 120 === 0 && done === lastDone && tick > 2000) {
      const rs = [...w.objects.entries()].filter(([n]) => n.startsWith('room:')).map(([n, o]) => ({ n, R: o.store.get('room'), busy: o.gate.busy, q: o.gate.q.length, alarm: o.alarm }));
      const by = {}; rs.forEach((x) => bump(by, x.R ? x.R.phase : 'none'));
      const lob = [...w.objects.values()].find((o) => o.name.startsWith('lobby'));
      console.log('STALL', JSON.stringify({ rooms: by, busyObjects: [...w.objects.values()].filter((o) => o.gate.busy).map((o) => o.name), timers: w.timers.length, friends: friends.length,
        lobbyTickets: lob ? lob.ctx.getWebSockets('q').map((x) => x.deserializeAttachment()) : null, lobbyAlarm: lob && lob.alarm, now: w.now }));
      for (const b of bots) console.log('bot', b.i, JSON.stringify({ room: b.room, over: b.over, live: b.live(), n: b.n, seat: b.seat, answered: b.answered, phase: b.room && w.objects.get(`room:${b.room}`) ? (w.objects.get(`room:${b.room}`).store.get('room') || {}).phase : null }));
      for (const x of rs.filter((y) => y.R && y.R.phase === 'live')) console.log('live', x.n, JSON.stringify({ n: x.R.n, deadline: x.R.deadline, off: x.R.off, alarm: x.alarm, busy: x.busy, q: x.q }));
      throw new Error('nothing is finishing');
    }
    if (tick % 120 === 0) lastDone = done;
  }
}
// everybody stops: whatever is still going ends by the rules (the play clock, forfeits)
for (const b of bots) b.next = async () => {};
friends.length = 0;
await w.advance(30 * 60_000);
w.timers.length = 0;
await w.advance(30 * 60_000);
checkOver();

// ------------------------------------------------------------------------------------------------- the checks ---
// nothing left hanging: every room is over, or a friend room nobody joined
for (const [n, o] of w.objects) {
  if (!n.startsWith('room:')) continue;
  const room = o.store.get('room');
  if (!room) continue;
  if (room.phase === 'wait') { assert.ok(!room.pre, `${n}: a matched room never started and was never called off`); continue; }
  assert.strictEqual(room.phase, 'over', `${n}: still ${room.phase}`);
  assert.ok(verified.has(n), `${n}: checked`);
}
assert.ok(!w.errors.length, `errors:\n${w.errors.slice(0, 5).join('\n')}`);
assert.deepStrictEqual(leaks, [], 'no seed ever reaches a phone');

// the ladder, from scratch: Elo in the order the rooms were rated must give exactly the ratings it holds
const L = w.obj('ladder').m.sql();
const games = L.exec('SELECT * FROM games ORDER BY rowid').toArray(), players = L.exec('SELECT * FROM players').toArray();
const mine = new Map();
const get = (k) => { if (!mine.has(k)) mine.set(k, { rating: ELO.START, games: 0, w: 0, l: 0, peak: ELO.START, streak: 0 }); return mine.get(k); };
const pairs = new Map();
for (const g of games) {
  const a = get(g.a), b = get(g.b), key = [g.a, g.b].sort().join('|');
  const recent = (pairs.get(key) || []).filter((t) => t > g.at - 86400_000);
  const rated = recent.length < ELO.PAIR_CAP;
  assert.strictEqual(!!g.rated, rated, `pair cap (${g.room})`);
  if (rated) {
    recent.push(g.at); pairs.set(key, recent);
    const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    [[a, ea, g.winner === 0], [b, 1 - ea, g.winner === 1]].forEach(([p, e, win]) => {
      const k = p.games < ELO.PROVISIONAL ? ELO.K_NEW : ELO.K;
      p.rating = Math.max(ELO.FLOOR, p.rating + k * ((win ? 1 : 0) - e));
      p.games += 1; if (win) { p.w += 1; p.streak = p.streak > 0 ? p.streak + 1 : 1; } else { p.l += 1; p.streak = p.streak < 0 ? p.streak - 1 : -1; }
      p.peak = Math.max(p.peak, p.rating);
    });
  }
}
for (const p of players) {
  const m = get(p.kh);
  assert.ok(Math.abs(m.rating - p.rating) < 1e-6 && m.games === p.games && m.w === p.w && m.l === p.l && m.streak === p.streak && Math.abs(m.peak - p.peak) < 1e-6,
    `ladder row for ${p.name}: ${JSON.stringify(p)} vs ${JSON.stringify(m)}`);
}
const rankedRooms = [...verified.values()].filter((x) => x.mode === 'ranked' && x.result.winner >= 0);
assert.strictEqual(games.length, rankedRooms.length, 'every ranked match rated once, nothing else');
assert.strictEqual(new Set(games.map((g) => g.room)).size, games.length, 'no room rated twice');
const top = (await w.http('ladder', '/vs/ladder')).body.top;
assert.ok(top.every((x, i, a) => !i || a[i - 1].rating >= x.rating), 'the ladder is in order');
const ratedGames = games.filter((g) => g.rated).length;
assert.strictEqual(players.reduce((s, p) => s + p.w, 0), ratedGames, 'a win for every rated game');
assert.strictEqual(players.reduce((s, p) => s + p.l, 0), ratedGames, 'a loss for every rated game');
// each phone ends with the room's state
let phonesChecked = 0;
for (const f of phoneFinal) {
  const x = verified.get(`room:${f.room}`);
  assert.ok(x, `bot${f.bot}: its room ${f.room}`);
  assert.deepStrictEqual(f.ms, x.ms, `bot${f.bot} saw the room's final state (${f.room})`);
  assert.deepStrictEqual(f.result, x.result, `bot${f.bot} was told the room's result (${f.room})`);
  phonesChecked++;
}
w.close();
const secs = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ ...stats, replayed, ladderGames: games.length, ratedGames, players: players.length, phonesChecked, topRating: top[0] && top[0].rating, hoursOfPlay: +((w.now - T0) / 3600000).toFixed(1), secs: Math.round(secs) }));
console.log(`versus stress ok: ${replayed} matches (${stats.finished} to the end, the rest forfeits or no-shows), ${stats.decisions} decisions replayed, ladder exact`);
