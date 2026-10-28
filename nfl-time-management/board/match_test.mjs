// Tests for versus (match.js): rooms, the lobby and the ladder, run in memory (vs_world.mjs) with a small stand-in
// engine, so they run anywhere in a second:  node board/match_test.mjs
// (vs_stress.mjs plays thousands of whole matches with the real engine.)
import assert from 'node:assert';
import { World, FakeClient } from './vs_world.mjs';
import { OPEN_MS, RAISE_MS, CLOSE_MS, DRAFT_IDLE_CARDS, STILL_MS, ROOM_RE, PLAY_MS, WATCH_MS, DECIDE_MS, OFF_MS, DEF_MS, decideMs, FIRST_MS, FORFEIT_MS, AFK_LIMIT, NOSHOW_MS, ELO, MM, CPU_AFTER_S, CPU_SEAT, CPU_TURN_MS } from './match.js';

// the play clock by role: the defense 15 seconds, the offense 20 (from the defense's call in), a pick or a try 30 (the owner, Oct 23)
{
  const snap = { over: false, root: { phase: 0, pos: 0 }, cot: { pick: null } }, pat = { over: false, root: { phase: 1, pos: 1 }, cot: { pick: null } };
  assert.deepStrictEqual([decideMs(snap, 0), decideMs(snap, 1), decideMs(pat, 1), decideMs({ over: false, root: { phase: 0, pos: 0 }, cot: { pick: { team: 1 } } }, 1)],
    [OFF_MS, DEF_MS, DECIDE_MS, DECIDE_MS], 'offense 20 s, defense 15 s, a try or a pick 30 s');
  assert.deepStrictEqual([OFF_MS, DEF_MS], [20000, 15000]);
}
import VSCore from '../web/vs_core.js';

// the decisions 4th down brings (vs_core.js): go for it, the kick and not a fake, staying home against it
const nh = (role, ms) => (role === 'intent' ? { intent: 'go' } : role === 'kick' ? { kick: true } : role === 'kickdef' ? { st: VSCore.KICK_DEF[ms.cot.k4][1] } : null);

// the stand-in engine: a snap gains (seed % 15) - 3 yards; a call 'fg' kicks a field goal (good); 'td' scores
const PAT = 1, KICKOFF = 2;
const stub = {
  pool: { season: 2026, week: 6, league: {}, teams: { KC: { coach: 'A' }, BUF: { coach: 'B' }, CHI: { coach: 'C' }, GB: { coach: 'D' } } },
  eng: {
    pb: { callIndex: { inside: 0, slant: 1, td: 2 }, routeNames: ['', 'go'] },
    makeContext: () => ({}),
    simulator: () => ({
      step(root, { action, seed }) {
        const r = { ...root, score: root.score.slice(), to: root.to.slice() }, log = [];
        if (r.phase === PAT) {
          const two = action.pat === 'two', good = two ? seed % 2 === 0 : true;
          if (good) r.score[r.pos] += two ? 2 : 1;
          log.push({ ev: 'pat', team: r.pos, two, good, row: -1 });
          r.phase = KICKOFF;
          return { root: r, log, done: false };
        }
        if (action.play === 'fg') { r.score[r.pos] += 3; r.phase = KICKOFF; log.push({ ev: 'fg', good: true }); return { root: r, log, done: false }; }
        const y = action.call === 'td' ? 99 : (seed % 15) - 3;
        log.push({ ev: 'play', yards: y, row: -1 });
        if (r.yl - y <= 0) { r.score[r.pos] += 6; r.phase = PAT; return { root: r, log, done: false }; }
        r.yl -= y;
        if (y >= r.ytg) { r.down = 1; r.ytg = Math.min(10, r.yl); } else if (r.down === 4) { r.pos = 1 - r.pos; r.yl = 100 - r.yl; r.down = 1; r.ytg = 10; } else { r.down += 1; r.ytg -= y; }
        return { root: r, log, done: false };
      },
    }),
  },
};
const K = (i) => `device-key-${String(i).padStart(14, '0')}`;
const state = async (w, code) => w.objects.get(`room:${code}`).store.get('room');
const kh = async (k) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vs:${k}`))); return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join(''); };
const addPlayer = (w, k, name, rating, games) => w.obj('ladder').m.sql().exec(
  'INSERT INTO players (kh, name, rating, games, w, l, peak, streak, updated, season) VALUES (?, ?, ?, ?, 0, 0, ?, 0, 0, \'s1\')', k, name, rating, games, rating);

assert.ok(ROOM_RE.test('ABC234') && !ROOM_RE.test('ABCD10') && !ROOM_RE.test('abc234') && !ROOM_RE.test('ABCDEFG'), 'room codes');

// ---- a friend room: seats, teams, the toss, sealed calls, the server plays the snap
{
  const w = new World({ engine: stub });
  const a = new FakeClient(w, K(1)), b = new FakeClient(w, K(2)), c = new FakeClient(w, K(3));
  assert.strictEqual(await a.open('ABC234', { mode: 'friend' }), 101);
  assert.deepStrictEqual([a.last('hello').seat, a.last('hello').full, a.last('hello').phase], [0, false, 'wait'], 'first in: seat 0, waiting');
  assert.strictEqual(await new FakeClient(w, 'short').open('ABC234'), 400, 'a key is needed');
  assert.strictEqual(await b.open('ABC234'), 101);
  assert.strictEqual(b.last('hello').seat, 1);
  assert.strictEqual(b.last('hello').mode, 'friend', 'the mode is the room\'s');
  assert.strictEqual(await c.open('ABC234'), 409, 'a third device is refused');
  a.send({ t: 'team', team: 'KC', name: 'Ann' });
  await w.settle();
  b.send({ t: 'team', team: 'KC', name: 'Bo' });
  await w.settle();
  assert.deepStrictEqual(b.last('taken'), { t: 'taken', team: 'KC' }, 'never the same team on both sides');
  b.send({ t: 'team', team: 'XYZ' });
  b.send({ t: 'team', team: 'kc!' });
  await w.settle();
  assert.strictEqual(b.last('start'), undefined, 'a team not in the game is refused');
  b.send({ t: 'team', team: 'BUF', name: 'Bo' });
  await w.settle();
  const st = a.last('start');
  assert.ok(st && st.ms.cot.pick && st.deadline === w.now + FIRST_MS, 'both teams in: the match starts, the toss first');
  assert.deepStrictEqual(a.last('teams').teams, ['KC', 'BUF']);
  b.send({ t: 'team', team: 'CHI' });
  await w.settle();
  assert.deepStrictEqual((await state(w, 'ABC234')).teams, ['KC', 'BUF'], 'a team once');
  // the toss: only the winner answers, and only offense / defense / end
  const ms = st.ms, P = ms.cot.pick.team, chooser = P === 0 ? a : b, other = P === 0 ? b : a;
  other.send({ t: 'half', n: 0, half: { pick: 'offense' } });
  await w.settle();
  assert.strictEqual(chooser.last('step'), undefined, 'the other team cannot choose');
  chooser.send({ t: 'half', n: 0, half: { pick: 'end' } });
  await w.settle();
  const s0 = a.last('step');
  assert.deepStrictEqual([s0.n, s0.kind, s0.ms.cot.pick.team, s0.ms.cot.pick.end], [0, 'pick', 1 - P, true], 'the end of the field: the other team picks');
  other.send({ t: 'half', n: 1, half: { pick: 'end' } });           // not twice
  await w.settle();
  const s1 = a.last('step');
  assert.deepStrictEqual([s1.n, s1.notes[0].choice, s1.notes[0].auto], [1, 'defense', true], 'end again is not an answer: the default, defense');
  const first = s1.ms.root.pos;
  assert.strictEqual(first, P, 'they took defense: the toss winner has it first');
  assert.deepStrictEqual([s1.ms.root.yl, s1.ms.root.down, s1.ms.root.ytg], [25, 1, 10], 'the ball at the 25');
  // a snap: sealed until both are in; the server plays it
  const off = first === 0 ? a : b, def = first === 0 ? b : a;
  off.send({ t: 'half', n: 2, half: { action: { call: 'inside', play: 'run', evil: 1, looks: 99 } } });
  await w.settle();
  assert.deepStrictEqual(def.last('locked'), { t: 'locked', n: 2, seat: first }, 'the other side sees a lock');
  assert.ok(!JSON.stringify(def.inbox).includes('inside'), 'the call never reaches the other side early');
  off.send({ t: 'half', n: 2, half: { action: { call: 'td' } } });  // locked: no change
  const DCALL = { pers: 'nickel', front: 'even', cover: 'c3', rush: 5 };
  def.send({ t: 'half', n: 2, half: { dc: { ...DCALL, rush: '5', evil: 1 }, score: [99, 99] } });
  await w.settle();
  const s2 = a.last('step');
  assert.deepStrictEqual(s2.halves[first], { action: { call: 'inside', play: 'run' } }, 'the first call stays, cleaned (no look of its own)');
  assert.deepStrictEqual(s2.halves[1 - first], { dc: DCALL }, 'only the defense call, cleaned');
  assert.deepStrictEqual(s2.res.action.dc, DCALL, 'the defense call is what the play is drawn against');
  assert.deepStrictEqual(b.last('step'), s2, 'both phones get the same');
  assert.strictEqual(s2.deadline, w.now + PLAY_MS);
  assert.deepStrictEqual(s2.dl, [w.now + PLAY_MS, w.now + PLAY_MS], 'each seat: the decision\'s last moment until its call is up');
  for (const bad of [{ dc: { ...DCALL, cover: 'c9' } }, { dc: { ...DCALL, rush: 7 } }, { dc: 'blitz' }, { def: 'blitz' }]) {
    assert.strictEqual(VSCore.cleanHalf(s2.ms, 1 - s2.ms.root.pos, bad, null), null, `junk defense: the default ${JSON.stringify(bad)}`);
  }
  // a stale or a future n, or junk: nothing
  off.send({ t: 'half', n: 2, half: { action: { call: 'td' } } });
  off.send({ t: 'half', n: 9, half: {} });
  off.send('not json');
  off.send(JSON.stringify({ t: 'half', n: 3, half: 'x'.repeat(5000) }));
  await w.settle();
  assert.strictEqual(a.last('step').n, 2);
  // the clock: a missing call is played as the default at the deadline (no ready: the decision's last moment)
  off.send({ t: 'half', n: 3, half: { action: { call: 'slant', play: 'pass' } } });
  await w.advance(PLAY_MS - 1000);
  assert.strictEqual(a.last('step').n, 2, 'not before the deadline');
  await w.advance(1000);
  assert.deepStrictEqual([a.last('step').n, a.last('step').halves[1 - first]], [3, null], 'the defense defaulted');
  // the play clock: the defense calls first; the offense's call up on its phone (ready) waits for it (wait: true, the
  // decision's last moment), and its 20 seconds start when the defense's call is in (the owner, Oct 23)
  const t4 = w.now;
  await w.advance(4000);
  off.send({ t: 'ready', n: 4 });
  await w.settle();
  assert.deepStrictEqual([off.last('clock').n, off.last('clock').wait, off.last('clock').deadline], [4, true, a.last('step').deadline], 'the offense waits on the defense');
  assert.strictEqual(def.last('clock'), undefined, 'the other phone is not told');
  off.send({ t: 'ready', n: 4 });                                     // again: nothing starts
  await w.advance(2000);
  assert.ok(off.last('clock').wait, 'a second ready changes nothing');
  def.send({ t: 'half', n: 4, half: { dc: DCALL } });
  await w.settle();
  const tD = w.now;
  assert.deepStrictEqual([off.last('clock').seat, off.last('clock').wait, off.last('clock').deadline], [first, undefined, tD + OFF_MS], 'the defense in: the offense\'s 20 seconds start');
  await w.advance(OFF_MS - 100);
  assert.strictEqual(a.last('step').n, 3, 'not before its 20 seconds');
  await w.advance(200);
  const s4 = a.last('step');
  assert.deepStrictEqual([s4.n, s4.halves[first], s4.halves[1 - first]], [4, null, { dc: DCALL }], '20 seconds and no call: the default, well before the decision\'s last moment');
  assert.ok(s4.at <= tD + OFF_MS + 100);
  // a ready late in the decision's time: the clock never runs past its last moment (late enough that even the
  // defense's 10 seconds would: PLAY_MS after the last snap)
  await w.advance(PLAY_MS - DEF_MS + 3000);
  // (the snaps' gains are random: snap 5 can be a try after a touchdown, or the other side's ball: ask whoever is up)
  const ms5 = a.last('step').ms, seat5 = VSCore.need(ms5)[0], up5 = seat5 === 0 ? a : b;
  up5.send({ t: 'ready', n: 5 });
  await w.settle();
  assert.strictEqual(up5.last('clock').deadline, s4.deadline, 'capped at the decision\'s last moment');
  for (const seat of VSCore.need(ms5)) {
    const half = nh(VSCore.role(ms5, seat), ms5) || (VSCore.role(ms5, seat) === 'pat' ? { action: { pat: 'xp' } } : seat === ms5.root.pos ? { action: { call: 'inside', play: 'run' } } : { dc: { pers: 'nickel', front: 'even', cover: 'c3', rush: 5 } });
    (seat === 0 ? a : b).send({ t: 'half', n: 5, half });
  }
  await w.settle();
  // a phone that drops and comes back: its own deadline in the hello
  const up = VSCore.need(a.last('step').ms)[0], upC = up === 0 ? a : b;
  upC.send({ t: 'ready', n: 6 });
  await w.settle();
  const myDl = upC.last('clock').deadline;
  assert.strictEqual(upC.last('clock').n, 6);
  // reconnect: the decisions since the phone's last, the state now
  b.drop();
  await w.settle();
  assert.deepStrictEqual(a.last('peer').online, [true, false], 'the other side sees the drop');
  assert.ok(a.last('peer').off[1] > 0);
  const b2 = new FakeClient(w, b.key);
  await b2.open('ABC234', { since: 2 });
  const h = b2.last('hello');
  assert.deepStrictEqual([h.seat, h.n, h.decisions.map((d) => d.n)], [1, 6, [2, 3, 4, 5]], 'back in its seat, caught up from where it was');
  assert.strictEqual(h.dl[up], myDl, 'the play clock, as the room keeps it');
  assert.deepStrictEqual(h.ms, a.last('step').ms, 'the same state');
  assert.strictEqual((await state(w, 'ABC234')).off[1], 0, 'back: no forfeit clock');
  assert.ok(![...a.inbox, ...b.inbox, ...b2.inbox].some((m) => JSON.stringify(m).includes('"seed"')), 'no seed ever reaches a phone');
  // a second tab of the same phone replaces the first
  const b3 = new FakeClient(w, b.key);
  await b3.open('ABC234');
  assert.strictEqual(b2.closedWith, 4000, 'the older tab is told it was replaced');
  w.close();
}

// ---- forfeits: gone too long, the play clock left to run, both gone; a reconnect in time saves it
async function live(w, mode = 'friend') {
  const a = new FakeClient(w, K(11)), b = new FakeClient(w, K(12));
  await a.open('FFF234', { mode }); await b.open('FFF234');
  a.send({ t: 'team', team: 'CHI', name: 'A' }); b.send({ t: 'team', team: 'GB', name: 'B' });
  await w.settle();
  return { a, b };
}
// seat 0 answers every call of its own while the clock runs (the other side's calls left to the clock)
async function runAnswering(w, a, ms) {
  for (let t = 0; t < ms; t += 1000) {
    const s = a.last('step') || { ...a.last('start'), n: -1 };
    if (s.ms && !a.last('over') && VSCore.need(s.ms).includes(0) && a.answered !== s.n + 1) {
      const role = VSCore.role(s.ms, 0);
      a.answered = s.n + 1;
      a.send({ t: 'half', n: s.n + 1, half: nh(role, s.ms) || (role === 'pick' ? { pick: 'offense' } : role === 'defense' ? { dc: { pers: 'base', front: 'even', cover: 'c3', rush: 4 } } : role === 'pat' ? { two: true } : { action: { call: 'inside' } }) });
    }
    await w.advance(1000);
  }
}
{
  const w = new World({ engine: stub });
  const { a, b } = await live(w);
  b.drop();
  await runAnswering(w, a, FORFEIT_MS - 5000);
  const b2 = new FakeClient(w, b.key);
  await b2.open('FFF234');
  await w.advance(5000);
  assert.strictEqual(a.last('over'), undefined, 'back in time: no forfeit');
  b2.drop();
  await runAnswering(w, a, FORFEIT_MS + 1000);
  assert.deepStrictEqual([a.last('over').result.winner, a.last('over').result.by, a.last('over').result.loser], [0, 'forfeit', 1], 'gone FORFEIT_MS (or its calls left to the clock): a forfeit');
  w.close();
}
{
  const w = new World({ engine: stub });
  const { a } = await live(w);
  // seat 1 never calls anything: the toss defaults, plays default; after AFK_LIMIT in a row it forfeits
  for (let g = 0; g < 50 && !a.last('over'); g++) {
    const s = a.last('step') || { ...a.last('start'), n: -1 };
    if (VSCore.need(s.ms).includes(0)) {
      const role = VSCore.role(s.ms, 0);
      a.send({ t: 'half', n: s.n + 1, half: nh(role, s.ms) || (role === 'pick' ? { pick: 'offense' } : role === 'defense' ? { dc: { pers: 'base', front: 'loaded', cover: 'c1', rush: 4 } } : role === 'pat' ? { two: true } : { action: { call: 'inside' } }) });
    }
    await w.advance(PLAY_MS + 10);
  }
  const o = a.last('over');
  assert.deepStrictEqual([o.result.winner, o.result.by, o.result.why], [0, 'forfeit', 'afk'], `the side that never calls forfeits (${AFK_LIMIT} in a row)`);
  w.close();
}
{
  const w = new World({ engine: stub });
  const { a, b } = await live(w);
  a.drop(); await w.advance(1000); b.drop();
  await w.advance(FORFEIT_MS + 2000);
  const R = await state(w, 'FFF234');
  assert.deepStrictEqual([R.result.winner, R.result.loser], [1, 0], 'both gone: the one who left first forfeits');
  w.close();
}

// ---- a whole match to the end, rematch (both have to ask; one new room, the same teams)
{
  const w = new World({ engine: stub });
  const { a, b } = await live(w);
  const c = [a, b];
  for (let g = 0; g < 200 && !(a.last('step') && a.last('step').result); g++) {
    const s = a.last('step') || { ...a.last('start'), n: -1 };
    for (const seat of VSCore.need(s.ms)) {
      const role = VSCore.role(s.ms, seat);
      c[seat].send({ t: 'half', n: s.n + 1, half: nh(role, s.ms) || (role === 'pick' ? { pick: 'offense' } : role === 'defense' ? { dc: { pers: 'dime', front: 'light', cover: 'c4', rush: 3 } } : role === 'pat' ? { two: true } : { action: { call: 'td' } }) });
    }
    await w.settle();
  }
  const fin = a.last('step');
  assert.ok(fin.result && fin.result.by === 'score' && fin.ms.over, 'the match ends on the field');
  assert.strictEqual(fin.result.winner, fin.ms.root.score[0] > fin.ms.root.score[1] ? 0 : 1, 'the room says who won');
  a.send({ t: 'half', n: fin.n + 1, half: {} });
  await w.settle();
  assert.strictEqual(a.last('step').n, fin.n, 'nothing after the end');
  a.send({ t: 'rematch' }); a.send({ t: 'rematch' });
  await w.settle();
  assert.deepStrictEqual(b.last('rematch-ask'), { t: 'rematch-ask', seat: 0 });
  assert.strictEqual(b.last('rematch'), undefined, 'one side asking is not a rematch');
  b.send({ t: 'rematch' }); b.send({ t: 'rematch' }); a.send({ t: 'rematch' });
  await w.settle();
  const codes = new Set([...a.all('rematch'), ...b.all('rematch')].map((m) => m.room));
  assert.strictEqual(codes.size, 1, 'one new room, however many taps');
  const nr = [...codes][0], R2 = await state(w, nr);
  assert.deepStrictEqual([R2.teams, R2.pre, R2.mode], [['CHI', 'GB'], true, 'friend'], 'the same teams, the same two players');
  assert.strictEqual(await new FakeClient(w, K(99)).open(nr), 409, 'nobody else gets in');
  w.close();
}

// ---- the lobby: ranked by rating (a window that widens), casual first come, never yourself
{
  const w = new World({ engine: stub });
  const p = [0, 1, 2, 3].map((i) => new FakeClient(w, K(20 + i)));
  for (const i of [0, 1]) addPlayer(w, await kh(p[i].key), `Pro${i}`, 1600, 30);
  assert.strictEqual(await p[0].queue({ mode: 'ranked', team: 'KC', name: 'Pro0' }), 101);
  assert.strictEqual(p[0].last('queued').rating, 1600, 'the lobby knows your rating');
  await p[2].queue({ mode: 'ranked', team: 'CHI', name: 'New2' });
  await w.advance(MM.TICK_MS);
  assert.strictEqual(p[0].last('match'), undefined, '1600 and 1000 are not paired at once');
  await p[1].queue({ mode: 'ranked', team: 'BUF', name: 'Pro1' });
  const m0 = p[0].last('match'), m1 = p[1].last('match');
  assert.ok(m0 && m1 && m0.room === m1.room && m0.mode === 'ranked', 'the two strong players are paired with each other');
  assert.strictEqual(p[2].last('match'), undefined);
  const R = await state(w, m0.room);
  assert.deepStrictEqual([R.mode, R.pre, R.teams, R.names], ['ranked', true, ['KC', 'BUF'], ['Pro0', 'Pro1']], 'a ranked room with its two players and teams');
  // the same device twice is never a match; a second ticket replaces the first
  const p2b = new FakeClient(w, p[2].key);
  await p2b.queue({ mode: 'ranked', team: 'GB', name: 'New2' });
  await w.advance(MM.WIN_OPEN_S * 1000 + 3000);
  assert.ok(!p[2].last('match') && !p2b.last('match'), 'never matched with itself');
  assert.strictEqual(w.obj('lobby').ctx.getWebSockets('q').length, 1, 'one ticket per device');
  // a long wait opens the window: anyone
  await p[3].queue({ mode: 'ranked', team: 'GB', name: 'New3' });
  assert.ok(p2b.last('match') && p2b.last('match').room === p[3].last('match').room, 'paired');
  const R3 = await state(w, p2b.last('match').room);
  assert.deepStrictEqual(R3.teams, ['GB', null], 'the same team: the second player picks another in the room');
  // casual: first come; ranked and casual never mix
  const q = [4, 5, 6].map((i) => new FakeClient(w, K(30 + i)));
  await q[0].queue({ mode: 'casual', team: 'KC' });
  await q[1].queue({ mode: 'ranked', team: 'KC', name: 'R' });
  await w.advance(MM.TICK_MS);
  assert.ok(!q[0].last('match') && !q[1].last('match'), 'ranked and casual never mix');
  await q[2].queue({ mode: 'casual', team: 'BUF' });
  assert.strictEqual(q[0].last('match').room, q[2].last('match').room);
  assert.strictEqual(await new FakeClient(w, K(40)).queue({ mode: 'ranked', team: 'zz' }), 400, 'a team is needed');
  // a ranked room only ever comes from the lobby
  const x = new FakeClient(w, K(41));
  await x.open('RNK234', { mode: 'ranked' });
  assert.strictEqual(x.last('hello').mode, 'casual', 'a ranked room made by hand is casual');
  w.close();
}

// ---- no-show: a matched player who never comes
{
  const w = new World({ engine: stub });
  const a = new FakeClient(w, K(50)), b = new FakeClient(w, K(51));
  await a.queue({ mode: 'casual', team: 'KC' }); await b.queue({ mode: 'casual', team: 'BUF' });
  const code = a.last('match').room;
  const a2 = new FakeClient(w, K(50));
  await a2.open(code);
  await w.advance(NOSHOW_MS + 1000);
  assert.deepStrictEqual([a2.last('over').result.by, a2.last('over').result.winner, a2.last('over').result.missing], ['noshow', -1, [1]], 'called off, nobody rated');
  w.close();
}

{
  const w = new World({ engine: stub });
  const a = new FakeClient(w, K(52)), b = new FakeClient(w, K(53));
  await a.queue({ mode: 'ranked', team: 'KC', name: 'Here' }); await b.queue({ mode: 'ranked', team: 'BUF', name: 'Gone' });
  const a2 = new FakeClient(w, K(52));
  await a2.open(a.last('match').room);
  await w.advance(NOSHOW_MS + 1000);
  const o = a2.last('over').result, r = a2.last('rated').rated;
  assert.deepStrictEqual([o.by, o.why, o.winner === a2.last('hello').seat], ['forfeit', 'noshow', true], 'ranked: never showing up is a loss');
  assert.ok(r.rated && r.ratings[o.loser].after < 1000, 'and rated');
  w.close();
}

// ---- the ladder: Elo (provisional K, then K), the floor, the pair cap, a room rated once, ranks
{
  const w = new World({ engine: stub });
  const rep = (room, seats, winner, names = ['', '']) => w.http('ladder', '/vs/report', { room, seats, names, winner, by: 'score' });
  let r = await rep('AAA222', ['a', 'b'], 0, ['Ann', 'Bo']);
  assert.deepStrictEqual(r.body.ratings.map((x) => [x.before, x.after, x.games, x.provisional]), [[1000, 1020, 1, true], [1000, 980, 1, true]], 'new players: K 40');
  assert.deepStrictEqual((await rep('AAA222', ['a', 'b'], 1)).body, r.body, 'a room is rated once (the same answer again)');
  await rep('AAA223', ['a', 'b'], 0);
  await rep('AAA224', ['a', 'b'], 0);
  r = await rep('AAA225', ['a', 'b'], 0);
  assert.deepStrictEqual([r.body.rated, r.body.reason, r.body.ratings[0].delta], [false, 'pair', 0], `the same two: rated ${ELO.PAIR_CAP} times a day`);
  await w.advance(86400_000 + 1);
  r = await rep('AAA226', ['a', 'b'], 1);
  assert.ok(r.body.rated, 'a day later: rated again');
  // K after the provisional games; the expected score: an upset moves more than a win over a weaker player
  addPlayer(w, 'hi', 'Hi', 1400, 50); addPlayer(w, 'lo', 'Lo', 1000, 50);
  r = await rep('BBB222', ['hi', 'lo'], 0);
  const fav = 1 / (1 + 10 ** (-400 / 400));
  assert.deepStrictEqual(r.body.ratings.map((x) => x.delta), [Math.round(1400 + ELO.K * (1 - fav)) - 1400, Math.round(1000 - ELO.K * (1 - fav)) - 1000], 'the favorite wins: a little');
  r = await rep('BBB223', ['hi', 'lo'], 1);
  assert.ok(r.body.ratings[1].delta > 15, 'the upset: a lot');
  addPlayer(w, 'floor', 'F', ELO.FLOOR + 3, 50); addPlayer(w, 'f2', 'G', ELO.FLOOR + 3, 50);
  r = await rep('CCC222', ['f2', 'floor'], 0);
  assert.strictEqual(r.body.ratings[1].after, ELO.FLOOR, 'never below the floor');
  const top = (await w.http('ladder', '/vs/ladder')).body;
  assert.deepStrictEqual(top.top.map((x) => x.rank), top.top.map((x) => 1 + top.top.filter((y) => y.rating > x.rating).length), 'ranks: a tie shares one');
  assert.ok(top.top.every((x, i, arr) => !i || arr[i - 1].rating >= x.rating), 'best first');
  assert.ok(!JSON.stringify(top).includes('"kh"'), 'no device ids on the ladder');
  assert.strictEqual((await w.http('ladder', '/vs/report', { room: 'DDD222', seats: ['a', 'a'], winner: 0 })).status, 400, 'not against yourself');
  w.close();
}

// ---- a ranked match end to end: the lobby pairs, the room plays, the room rates; a forfeit is a loss
{
  const w = new World({ engine: stub });
  const a = new FakeClient(w, K(60)), b = new FakeClient(w, K(61));
  await a.queue({ mode: 'ranked', team: 'KC', name: 'Ann' }); await b.queue({ mode: 'ranked', team: 'BUF', name: 'Bo' });
  const code = a.last('match').room;
  const A = new FakeClient(w, a.key), B = new FakeClient(w, b.key);
  await A.open(code, { mode: 'ranked' }); await B.open(code, { mode: 'ranked' });
  assert.ok(A.last('start') || A.last('hello').ms, 'both in: the match starts (teams came from the lobby)');
  A.send({ t: 'result', winner: 0 });                                // phones never say who won
  B.drop();
  await w.advance(FORFEIT_MS + 1000);
  const rated = A.last('rated').rated;
  assert.deepStrictEqual([A.last('over').result.by, rated.rated, rated.ratings[0].after > 1000, rated.ratings[1].after < 1000], ['forfeit', true, true, true], 'the quitter loses rating');
  const me = (await w.http('ladder', '/vs/me', { key: B.key })).body;
  assert.deepStrictEqual([me.games, me.l, me.streak, me.provisional], [1, 1, -1, true]);
  w.close();
}
// ---- the computer: offered after CPU_AFTER_S in the queue, its own room, every one of its calls in at once (the
// engine's own), never away or late, never rated; a rematch is another match against it
{
  const w = new World({ engine: stub });
  const a = new FakeClient(w, K(70));
  await a.queue({ mode: 'casual', team: 'KC', name: 'Solo' });
  assert.strictEqual(a.last('queued').cpu, false, 'not offered at once');
  a.send({ t: 'cpu' });
  await w.settle();
  assert.strictEqual(a.last('match'), undefined, 'asked too soon: still in the queue');
  await w.advance(CPU_AFTER_S * 1000 + 2500);
  assert.strictEqual(a.last('queued').cpu, true, 'offered after waiting');
  a.send({ t: 'cpu' });
  await w.settle();
  const m = a.last('match');
  assert.ok(m && m.mode === 'cpu', 'a room against the computer');
  const A = new FakeClient(w, a.key);
  assert.strictEqual(await A.open(m.room, { mode: 'cpu' }), 101);
  const h = A.last('hello');
  assert.deepStrictEqual([h.seat, h.mode, h.online[CPU_SEAT], h.names[CPU_SEAT]], [0, 'cpu', true, 'Computer'], 'the computer is the other seat, always there');
  assert.ok(h.teams[CPU_SEAT] && h.teams[CPU_SEAT] !== 'KC', 'the computer has a team of its own');
  // play it out: answer every decision that is ours, as late as the play clock allows now and then
  for (let i = 0; i < 400; i++) {
    const R = await state(w, m.room);
    if (R.phase !== 'live') break;
    const need = VSCore.need(R.ms);
    assert.ok(need.length, 'a live match always waits on someone');
    const pend = w.objects.get(`room:${m.room}`).store.get('pend');
    if (need.includes(CPU_SEAT)) assert.ok(pend && pend.n === R.n && CPU_SEAT in pend.halves, `the computer's call is in at once (decision ${R.n})`);
    if (!need.includes(0)) { await w.advance(1000); continue; }
    const r0 = VSCore.role(R.ms, 0), role = r0 === 'offense' ? 'off' : r0 === 'defense' ? 'def' : r0;
    const half = nh(r0, R.ms) || (role === 'pick' ? { pick: 'offense' } : role === 'pat' ? { action: { pat: 'xp' } } : role === 'off' ? { action: { call: i % 3 ? 'inside' : 'slant', play: 'run' } } : { dc: { pers: 'nickel', front: 'even', cover: 'c3', rush: 5 } });
    A.send({ t: 'half', n: R.n, half });
    await w.settle();
  }
  const end = await state(w, m.room);
  assert.strictEqual(end.phase, 'over', 'the match ends');
  assert.ok(end.result.by === 'score' && end.result.winner >= 0, `it ends on the scoreboard, not a forfeit (${JSON.stringify(end.result)})`);
  assert.strictEqual(end.rated, null, 'never rated');
  A.send({ t: 'rematch' });
  await w.settle();
  const re = A.last('rematch');
  assert.ok(re && re.room, 'a rematch needs only you');
  assert.strictEqual((await state(w, re.room)).mode, 'cpu', 'and is the computer again');
  // the Computer button: a room at once, never in the queue
  const nowC = new FakeClient(w, K(72));
  assert.strictEqual(await nowC.queue({ mode: 'cpu', team: 'GB', name: 'Now' }), 101);
  const nm = nowC.last('match');
  assert.ok(nm && nm.mode === 'cpu' && !nowC.last('queued'), 'the computer straight away');
  assert.strictEqual(w.obj('lobby').ctx.getWebSockets('q').length, 0, 'nobody left in the queue');
  // the computer won the toss: its choice plays as the phone connects, and the phone's hello is the room after it (a
  // hello from before it left the phone waiting on the computer, the room on the phone: load test runs 7-11)
  let tossSeen = 0;
  for (let tries = 0; tries < 16 && tossSeen < 3; tries++) {
    const c = new FakeClient(w, K(40 + tries));
    await c.queue({ mode: 'cpu', team: 'GB', name: `Toss${tries}` });
    const C = new FakeClient(w, c.key);
    await C.open(c.last('match').room, { mode: 'cpu' });
    const hh = C.last('hello'), R = await state(w, c.last('match').room);
    assert.deepStrictEqual([hh.n, JSON.stringify(hh.ms)], [R.n, JSON.stringify(R.ms)], 'the hello is the room as it is');
    if (R.n > 0) {
      tossSeen += 1;
      assert.strictEqual(hh.decisions.length, R.n, "the computer's toss in the hello's decisions");
      assert.ok(VSCore.need(hh.ms).includes(0), 'and the phone is told the next call is its own');
    }
  }
  assert.ok(tossSeen > 0, 'the computer won a toss in the tries');
  // the computer's own call missed (cpuTurn failing, as the engine loads under load): the room's alarm puts it in within
  // CPU_TURN_MS, never at the player's 10-minute deadline (load test run 7: matches sat on the computer's toss)
  for (let tries = 0; tries < 12; tries++) {
    const c = new FakeClient(w, K(60 + tries));
    await c.queue({ mode: 'cpu', team: 'GB', name: `Miss${tries}` });
    const cm = c.last('match'), o = w.obj(`room:${cm.room}`), real = o.m.cpuTurn;
    o.m.cpuTurn = async () => {};
    const C = new FakeClient(w, c.key);
    await C.open(cm.room, { mode: 'cpu' });
    const R0 = await state(w, cm.room);
    if (!VSCore.need(R0.ms).includes(CPU_SEAT)) { o.m.cpuTurn = real; continue; }      // (the player won the toss: try again)
    assert.strictEqual(R0.n, 0, 'nothing played yet: the computer missed its call');
    await w.advance(CPU_TURN_MS + 1500);
    const R1 = await state(w, cm.room);
    assert.ok(R1.n >= 1, `the computer's call put in by the alarm within ${CPU_TURN_MS} ms (n ${R1.n})`);
    o.m.cpuTurn = real;
    break;
  }
  // a phone can't make a room the computer's
  const F = new FakeClient(w, K(71));
  await F.open('CPU234', { mode: 'cpu' });
  assert.notStrictEqual((await state(w, 'CPU234')).mode, 'cpu', 'only the lobby makes a computer room');
  w.close();
}
// ---- Versus Draft (VSCore.DRAFT, match.js draftStart/draftBid/draftSettle: a blind auction): no team brought; $50
// each, cards up one at a time slot by slot, each a team's man at the slot and blind (the team and the slot shown, the
// man at the end); the bidding open and back and forth, a claim for $0 or a dollar over, never more than leaves a
// dollar a slot, the clock reset by each bid, the high bid takes the card when it runs out; a card nobody claims goes
// to nobody; the sides are made from the picks and the match follows. The computer bids a beat after each card or bid,
// up to what the card is worth to it. Never rated; a rematch drafts again
{
  const mkTeam = (c, q) => ({ team: c, coach: `Coach ${c}`, base: { off_pass: q, off_rush: q / 2, def_pass: -q, def_rush: -q / 2 }, qb: { name: `QB ${c}`, adjustment: q / 10 },
    kicker: { name: `K ${c}`, rating: 1, ovr: 80 }, punter: { name: `P ${c}`, ovr: 70 }, calls: { inside: { off: q, def: -q }, slant: { off: q, def: -q } },
    lineup: { off: [{ pos: 'QB', name: `QB ${c}`, ovr: 80 }, { pos: 'RB', name: `RB ${c}`, ovr: 75 }, { pos: 'WR', name: `WR1 ${c}`, ovr: 85 }, { pos: 'WR', name: `WR2 ${c}`, ovr: 72 }, { pos: 'TE', name: `TE ${c}`, ovr: 70 },
      { pos: 'LT', name: `LT ${c}`, ovr: 70 }, { pos: 'LG', name: `LG ${c}`, ovr: 70 }, { pos: 'C', name: `C ${c}`, ovr: 70 }, { pos: 'RG', name: `RG ${c}`, ovr: 70 }, { pos: 'RT', name: `RT ${c}`, ovr: 70 }, { pos: 'WR', name: `WR3 ${c}`, ovr: 60 }],
      def: [{ pos: 'EDGE', name: `E ${c}`, ovr: 80 }, { pos: 'CB', name: `CB ${c}`, ovr: 75 }], bench: [], qbs: [] } });
  const codes = ['KC', 'BUF', 'CHI', 'GB', 'DAL', 'PHI', 'DET', 'SF'];
  const stubD = { ...stub, pool: { ...stub.pool, teams: Object.fromEntries(codes.map((c, i) => [c, mkTeam(c, (i - 4) / 20)])) } };
  const w = new World({ engine: stubD });
  const SLOTS = VSCore.DRAFT.slots, open = (need) => Object.values(need).reduce((x, y) => x + y, 0);
  // the pool and the rules, on their own (vs_core.js)
  {
    const rnd = VSCore.rng(11), cards = VSCore.draftPool(stubD.pool, rnd), by = {};
    cards.forEach((c) => { by[c.k] = (by[c.k] || 0) + 1; });
    assert.deepStrictEqual(by, VSCore.DRAFT.pool, 'the pool: so many of each kind');
    assert.ok(cards.some((c, i) => i && c.k !== cards[i - 1].k && cards.slice(i + 1).some((x) => x.k === cards[i - 1].k)), 'in a random order: a kind comes back after another cut in');
    for (const k of Object.keys(by)) assert.strictEqual(new Set(cards.filter((c) => c.k === k).map((c) => c.team)).size, by[k], `${k}: each from a different team`);
    {   // the draw leans to the better men: a man's chance 1 + DRAFT.lean times his place at the slot; over many draws the best is up far more often than the worst, and the worst still comes up (the stub's quarterbacks are all alike, so made-up cards)
      const men = [...Array(8)].map((_, i) => ({ k: 'QB', team: `T${i}`, pct: i / 7 })), seen = {};
      for (let i = 0; i < 1500; i++) for (const c of VSCore.drawLeaning(men, 3, VSCore.rng(1000 + i))) seen[c.team] = (seen[c.team] || 0) + 1;
      assert.ok(seen.T7 > seen.T0 * 2 && seen.T0 > 100 && Object.keys(seen).length === 8, `the best up far more often than the worst, the worst still up: ${JSON.stringify(seen)}`);
      assert.strictEqual(VSCore.drawLeaning(men, 3, VSCore.rng(5)).length, 3, 'three drawn');
      assert.strictEqual(new Set(VSCore.drawLeaning(men, 8, VSCore.rng(6)).map((c) => c.team)).size, 8, 'drawn without replacement');
    }
    assert.deepStrictEqual(VSCore.draftMask(cards[0]), { k: cards[0].k, team: cards[0].team, pos: cards[0].pos, name: cards[0].name, sticker: cards[0].sticker }, 'a card masked: the man, the team, the slot and the sticker, no rating');
    // the stickers: a dollar for the worst at the slot, DRAFT.sticker[k] for the best (the stub league: every quarterback 80, every line 70)
    const all = VSCore.draftCards(stubD.pool, 'QB');
    assert.ok(all.every((c) => c.sticker >= 1 && c.sticker <= VSCore.DRAFT.sticker.QB) && new Set(all.map((c) => c.sticker)).size === 1, 'the same man everywhere: the same sticker');
    const d = VSCore.draftNew([{ k: 'QB', team: 'KC', name: 'a', ovr: 80, sticker: 6 }, { k: 'QB', team: 'BUF', name: 'b', ovr: 80, sticker: 2 }, { k: 'QB', team: 'DAL', name: 'c', ovr: 80, sticker: 1 }, { k: 'RB', team: 'DAL', name: 'd', ovr: 70, sticker: 3 }]);
    d.steal = [false, false];                                              // (the Steal has its own block below)
    assert.strictEqual(VSCore.draftMax(d, 0, d.pool[0]), 50 - 6, 'the most at the start: a dollar kept for each of the six other slots');
    assert.deepStrictEqual([0, 5, 6, 44, 45, 6.5, -1].map((a) => VSCore.draftCanBid(d, 0, a)), [false, false, true, true, false, false, false], 'the first bid is the floor (his sticker) or more, up to the most, whole dollars');
    d.bid = { seat: 0, amount: 20 };
    assert.deepStrictEqual([VSCore.draftCanBid(d, 0, 22), VSCore.draftCanBid(d, 1, 20), VSCore.draftCanBid(d, 1, 21), VSCore.draftCanTop(d, 1)], [false, false, true, true], 'never your own bid raised; the other side a dollar over');
    let r = VSCore.draftResolve(d);
    assert.deepStrictEqual([r.seat, r.amount, d.budget, d.need[0].QB, d.i, d.bid], [0, 20, [30, 50], 0, 1, null], 'the high bid takes the card at its price; the next card is up');
    // the owner's case: the first quarterback went for $20, so the next one is no dollar: his floor is half of that
    assert.deepStrictEqual([VSCore.draftFloor(d, 1, d.pool[1]), VSCore.draftCanBid(d, 1, 9), VSCore.draftCanBid(d, 1, 10)], [10, false, true], 'the other side opens at half the $20, not at the $2 sticker');
    d.bid = { seat: 0, amount: 1 };
    r = VSCore.draftResolve(d);
    assert.deepStrictEqual([r.seat, r.amount, d.picks[0].length], [-1, 0, 1], 'a bid from a side with its quarterback already counts for nothing: nobody takes him');
    d.bid = { seat: 1, amount: 10 };
    r = VSCore.draftResolve(d);
    assert.deepStrictEqual([r.seat, r.amount, d.budget[1], d.i], [1, 10, 40, 3], 'at the floor, he is theirs');
    const d2 = VSCore.draftNew([{ k: 'QB', team: 'KC', name: 'a', ovr: 80 }, { k: 'QB', team: 'BUF', name: 'b', ovr: 80 }, { k: 'RB', team: 'DAL', name: 'd', ovr: 70 }]);
    d2.need[0].QB = 0; d2.need[1].QB = 0;
    VSCore.draftAdvance(d2);
    assert.strictEqual(d2.i, 2, 'cards of a kind both sides have are skipped');
    r = VSCore.draftResolve(d);
    assert.ok(r.seat === -1 && VSCore.draftDone(d) && open(d.need[0]) > 0, 'nobody claimed the back; the pool is out, slots still open');
    const before = [d.budget[0], d.budget[1]];
    VSCore.draftFill(d, stubD.pool, rnd);
    assert.deepStrictEqual([open(d.need[0]), open(d.need[1]), d.picks[0].length + d.picks[1].length], [0, 0, 14], 'filled: seven a side');
    assert.ok(d.picks[0].filter((p) => p.filler).every((p) => p.paid >= 1) && d.budget[0] < before[0] && d.budget[1] < before[1] && d.budget[0] >= 0 && d.budget[1] >= 0, 'the fill is paid for, at the floor, never into debt');
    const t = VSCore.draftTeam(stubD.pool, d.picks[0], 'DR1', 'Max');
    // a replacement plays below the league's worst: the filled side's passing and defense under every real team's
    {
      const lo = Math.min(...codes.map((c) => stubD.pool.teams[c].base.off_pass)), loD = Math.min(...codes.map((c) => stubD.pool.teams[c].base.def_pass));
      const dr = VSCore.draftNew([]); VSCore.draftFill(dr, stubD.pool, rnd);
      const tr = VSCore.draftTeam(stubD.pool, dr.picks[0], 'DR1', 'Nobody');
      assert.ok(tr.base.off_pass < lo && tr.base.def_pass < loD && tr.draft.every((p) => p.filler), 'a side of replacements: rated under the league at every factor');
    }
    assert.deepStrictEqual([t.team, t.coach, t.lineup.off.length, t.lineup.off.filter((p) => p.pos === 'QB').length, typeof t.base.off_pass, !!t.kicker.name], ['DR1', 'Max', 11, 1, 'number', true], 'a side: eleven on offense, one quarterback, ratings and a kicker');
    assert.doesNotThrow(() => VSCore.buildGame(VSCore.draftPoolWith(stubD.pool, { DR1: t, DR2: VSCore.draftTeam(stubD.pool, d.picks[1], 'DR2', 'Ann') }), 'DR1', 'DR2'), 'the engine builds the game from the two sides');
    // a pass: out of the card; it settles the card when the other side holds the bid, has passed too or cannot bid
    {
      const dp = VSCore.draftNew([{ k: 'TE', team: 'KC', name: 't1', ovr: 70, sticker: 2 }, { k: 'TE', team: 'GB', name: 't2', ovr: 72, sticker: 2 }, { k: 'RB', team: 'DAL', name: 'r1', ovr: 70, sticker: 2 }]);
      assert.strictEqual(VSCore.draftPass(dp, 0), false, 'the first pass with no bid: the other side may still open it');
      assert.strictEqual(VSCore.draftCanBid(dp, 0, 5), false, 'a side that passed cannot bid');
      assert.strictEqual(VSCore.draftPass(dp, 1), true, 'the second pass settles it');
      let r = VSCore.draftResolve(dp);
      assert.deepStrictEqual([r.seat, dp.i, dp.pass], [-1, 1, [false, false]], 'to nobody; the passes cleared for the next card');
      dp.bid = { seat: 1, amount: 3 };
      assert.strictEqual(VSCore.draftPass(dp, 1), null, 'the high bidder cannot pass');
      assert.strictEqual(VSCore.draftPass(dp, 0), true, 'the other side passing on a held bid settles it');
      r = VSCore.draftResolve(dp);
      assert.deepStrictEqual([r.seat, r.amount], [1, 3], 'to the bidder at its bid');
    }
    // the Steal: a card of a kind the side has filled, bid for once; the man it had goes to the other side
    {
      const ds = VSCore.draftNew([{ k: 'QB', team: 'KC', name: 'q1', ovr: 70, sticker: 2 }, { k: 'QB', team: 'BUF', name: 'q2', ovr: 90, sticker: 8 }, { k: 'QB', team: 'DAL', name: 'q3', ovr: 60, sticker: 1 }, { k: 'RB', team: 'DAL', name: 'r1', ovr: 70, sticker: 2 }]);
      ds.bid = { seat: 0, amount: 2 }; VSCore.draftResolve(ds);                       // q1 to side 0
      assert.ok(!VSCore.draftNeeds(ds, 0, 'QB') && VSCore.draftCanSteal(ds, 0, ds.pool[ds.i]) && !VSCore.draftCanSteal(ds, 1, ds.pool[ds.i]), 'with its quarterback in, side 0 can steal; side 1 still needs one');
      assert.strictEqual(VSCore.draftMax(ds, 0, ds.pool[ds.i]), 48 - 6, 'a steal fills no slot: a dollar kept for each of the six still open');
      assert.ok(VSCore.draftCanBid(ds, 0, 8), 'the steal bid at the floor');
      ds.bid = { seat: 0, amount: 10 };
      let r = VSCore.draftResolve(ds);
      assert.deepStrictEqual([r.seat, r.amount, r.steal.out.name, r.steal.to, ds.steal, ds.budget, ds.need[1].QB], [0, 10, 'q1', 1, [false, true], [38, 50], 0], 'q2 stolen in; q1 to the other side, into its open slot; the Steal spent');
      assert.deepStrictEqual([ds.picks[0].map((p) => p.name), ds.picks[1].map((p) => [p.name, p.paid, !!p.swapped])], [['q2'], [['q1', 0, true]]], 'the rosters after it');
      assert.strictEqual(VSCore.draftCanSteal(ds, 0, ds.pool[ds.i]), false, 'once a draft');
      assert.strictEqual(ds.pool[ds.i].k, 'QB', 'the third quarterback still up: side 1 has its Steal');
      ds.steal[1] = false; VSCore.draftAdvance(ds);
      assert.strictEqual(ds.pool[ds.i].k, 'RB', 'with no Steal left on either side, a kind both have is skipped');
      // a steal when the other side has the kind too: the man goes over only if he is better than its worst
      const dt = VSCore.draftNew([{ k: 'TE', team: 'KC', name: 'a', ovr: 60, sticker: 1 }, { k: 'TE', team: 'GB', name: 'b', ovr: 80, sticker: 3 }, { k: 'TE', team: 'DAL', name: 'c', ovr: 90, sticker: 3 }, { k: 'RB', team: 'DAL', name: 'r', ovr: 70, sticker: 2 }]);
      dt.bid = { seat: 0, amount: 1 }; VSCore.draftResolve(dt);
      dt.bid = { seat: 1, amount: 3 }; VSCore.draftResolve(dt);                      // a (60) to 0, b (80) to 1
      dt.bid = { seat: 0, amount: 3 }; r = VSCore.draftResolve(dt);                  // 0 steals c (90): a (60) is no better than b (80): let go
      assert.deepStrictEqual([r.steal.out.name, r.steal.to, dt.picks[1].map((p) => p.name), dt.picks[0].map((p) => p.name)], ['a', -1, ['b'], ['c']], 'a worse man than theirs goes nowhere');
    }
    // the computer: a value within its most, a $0 claim on an open card, a dollar or two over the bid in up to its value, then it sits
    const d3 = VSCore.draftNew(cards), v = VSCore.draftCpuValue(d3, 1, rnd);
    assert.ok(v >= cards[0].sticker && v <= VSCore.draftMax(d3, 1, cards[0]), 'a value from the sticker to the most');
    assert.strictEqual(VSCore.draftCpuBid(d3, 1, v, rnd), cards[0].sticker, 'an open card: opened at the floor');
    d3.bid = { seat: 0, amount: v - 1 };
    const over = VSCore.draftCpuBid(d3, 1, v, rnd);
    assert.ok(over === v || over === null, 'a dollar over, up to its value (two over would pass it: it sits)');
    d3.bid = { seat: 0, amount: v };
    assert.strictEqual(VSCore.draftCpuBid(d3, 1, v, rnd), null, 'over its value: it sits');
  }
  // the queue: a draft ticket brings no team; a plain one still must
  const noTeam = new FakeClient(w, K(80));
  assert.strictEqual(await noTeam.queue({ mode: 'casual', team: '', name: 'X' }), 400, 'a quick match needs a team');
  // the computer's draft: a room at once, the pool drawn as the phone comes in; the computer claims each card a beat
  // after it goes up and answers a bid; the phone outbids it or lets it have the card
  const c = new FakeClient(w, K(81));
  assert.strictEqual(await c.queue({ mode: 'cpu', draft: '1', team: '', name: 'Drafter' }), 101);
  const m = c.last('match');
  assert.ok(m && m.mode === 'cpu', 'a computer room');
  const C = new FakeClient(w, c.key);
  assert.strictEqual(await C.open(m.room, { mode: 'cpu' }), 101);
  let h = C.last('hello');
  assert.deepStrictEqual([h.phase, h.teams, h.draft], ['draft', [null, null], { pending: true }], 'the draft is on, its pool a moment away');
  await w.advance(100);
  h = { ...h, draft: C.last('draft').d };
  assert.deepStrictEqual([h.phase, h.teams, !!h.draft && !h.draft.pending, h.draft.n, h.draft.i, h.draft.bid, VSCore.DRAFT.order.includes(h.draft.card.k)], ['draft', [null, null], true, 20, 0, null, true], 'the draft is on: no teams yet, 20 cards, the first up, no bid');
  assert.deepStrictEqual([Object.keys(h.draft.card).sort(), h.draft.budget, h.draft.max, h.draft.left > OPEN_MS - 1000], [['k', 'name', 'pos', 'sticker', 'team'], [50, 50], [44, 44], true], 'the card: the man, the team, the slot and the sticker, no rating; the money and the most; the clock');
  await w.advance(3000);
  assert.deepStrictEqual(C.last('bid') && [C.last('bid').seat, C.last('bid').amount, C.last('bid').i], [CPU_SEAT, h.draft.floor[CPU_SEAT], 0], 'the computer opened the first card at its floor within a beat');
  let spent = 0, got = 0, rounds = 0, outbid = 0;
  for (; rounds < 40; rounds++) {
    const R = await state(w, m.room);
    if (R.phase !== 'draft') break;
    const v = C.last('draft') ? C.last('draft').d : h.draft;
    assert.strictEqual(v.i, R.draft.i, 'the view is the room');
    assert.ok('name' in v.card && !('ovr' in v.card) && v.picks.every((ps) => ps.every((p) => 'name' in p && !('ovr' in p))), 'the men named, the ratings never, while the draft is on');
    const max = VSCore.draftMax({ budget: v.budget, need: v.need }, 0, v.card);
    if (max && rounds % 2 === 0) {
      // bid it up: a dollar over the computer each time it answers, until it sits or the most is reached
      for (let k = 0; k < 60; k++) {
        const Rk = await state(w, m.room);
        if (Rk.phase !== 'draft' || Rk.draft.i !== v.i) break;
        const b = Rk.draft.bid, want = b ? b.amount + 1 : VSCore.draftFloor(Rk.draft, 0, Rk.draft.pool[Rk.draft.i]), mx = VSCore.draftMax(Rk.draft, 0, Rk.draft.pool[Rk.draft.i]);
        if (b && b.seat === 0) { await w.advance(500); continue; }
        if (want > mx) break;
        C.send({ t: 'bid', i: v.i, amount: want });
        C.send({ t: 'bid', i: v.i, amount: want + 5 });                 // (raising your own bid: ignored)
        await w.settle();
        const Rb = await state(w, m.room);
        assert.deepStrictEqual([Rb.draft.bid.seat, Rb.draft.bid.amount], [0, want], 'the bid is in, once');
        assert.ok(Rb.draft.deadline - Date.now() <= RAISE_MS + 50 && Rb.draft.deadline - Date.now() >= CLOSE_MS - 50, 'the clock went back to answer');
        outbid += 1;
        await w.advance(500);
      }
    }
    let R2 = await state(w, m.room);
    for (let k = 0; k < 80 && R2.phase === 'draft' && R2.draft.i === v.i; k++) { if ((R2.draft.ask || [])[0]) { C.send({ t: 'here' }); await w.settle(); } await w.advance(500); R2 = await state(w, m.room); }
    const last = R2.draft.last;
    assert.ok(last && last.i === v.i, `the clock settled the card (${last && last.i} vs ${v.i})`);
    if (last.seat === 0) { spent += last.amount; got += 1; }
  }
  const R = await state(w, m.room);
  const fillers = R.draft.picks[0].filter((p) => p.filler);
  assert.deepStrictEqual([R.phase, R.teams, got + fillers.length, R.draft.budget[0]], ['live', ['DR1', 'DR2'], 7, 50 - spent - fillers.reduce((a, p) => a + p.paid, 0)], 'seven picks (the dregs for a slot left open, paid for), the money adds up, the match is on');
  assert.ok(outbid >= 5, `the phone bid against the computer (${outbid} bids)`);
  assert.ok(R.draftTeams && R.draftTeams.DR1.lineup.off.length === 11 && R.draftTeams.DR2.lineup.off.length === 11, 'two sides, eleven each');
  const dm = C.all('draft'), st = C.last('start'), fin = dm[dm.length - 1];
  assert.ok(fin.draftTeams && fin.teams[0] === 'DR1' && fin.d.done && st && st.ms, 'the sides and the toss went to the phone, in that order');
  assert.ok(fin.d.picks[0].length === 7 && fin.d.picks[0].every((p) => p.name && p.k) && fin.d.picks[1].every((p) => p.name), 'the reveal: every pick named at the end');
  assert.ok(dm.length <= rounds + 1 && dm.length >= 7, `a message a card up (${dm.length} for ${rounds} settled)`);
  // the hello after it carries the sides; the match plays out as any other
  const C2 = new FakeClient(w, c.key);
  await C2.open(m.room, { mode: 'cpu' });
  h = C2.last('hello');
  assert.ok(h.draftTeams && h.teams[0] === 'DR1' && h.phase === 'live' && h.draft.done && h.draft.picks[1][0].name, 'a reload has the sides and the picks named');
  for (let i = 0; i < 400; i++) {
    const Rl = await state(w, m.room);
    if (Rl.phase !== 'live') break;
    const need = VSCore.need(Rl.ms);
    if (!need.includes(0)) { await w.advance(1000); continue; }
    const r0 = VSCore.role(Rl.ms, 0), role = r0 === 'offense' ? 'off' : r0 === 'defense' ? 'def' : r0;
    const half = nh(r0, Rl.ms) || (role === 'pick' ? { pick: 'offense' } : role === 'pat' ? { action: { pat: 'xp' } } : role === 'off' ? { action: { call: i % 3 ? 'inside' : 'slant', play: 'run' } } : role === 'def' ? { dc: { pers: 0, front: 0, cov: 0, rush: 0 } } : null);
    C2.send({ t: 'half', n: Rl.n, half });
    await w.settle();
  }
  const end = await state(w, m.room);
  assert.deepStrictEqual([end.phase, end.result && end.result.by, end.rated], ['over', 'score', null], 'played to the end on the scoreboard, never rated');
  C2.send({ t: 'rematch' });
  await w.settle();
  const re = C2.last('rematch');
  assert.ok(re && re.room, 'a rematch');
  const Rr = await state(w, re.room);
  assert.deepStrictEqual([Rr.mode, !!Rr.draft, Rr.teams], ['cpu', true, [null, null]], 'and it drafts again');
  // two players: paired from the draft queue; the bidding back and forth, the clock, a card nobody claims
  const a = new FakeClient(w, K(82)), b = new FakeClient(w, K(83));
  await a.queue({ mode: 'draft', team: '', name: 'Ann' });
  await b.queue({ mode: 'draft', team: '', name: 'Bob' });
  const ma = a.last('match'), mb = b.last('match');
  assert.ok(ma && mb && ma.room === mb.room && ma.mode === 'draft', 'paired into one draft room');
  const A = new FakeClient(w, a.key), B = new FakeClient(w, b.key);
  await A.open(ma.room, { mode: 'draft' });
  assert.strictEqual(A.last('hello').draft.pending, true, 'alone: the pool waits for the other');
  await B.open(mb.room, { mode: 'draft' });
  assert.strictEqual(B.last('hello').draft.pending, true, 'both in: the pool is drawn at once by the alarm');
  await w.advance(100);
  let v = B.last('draft').d;
  assert.strictEqual(A.last('draft').d.i, 0, 'the first card went to both');
  assert.deepStrictEqual([v.i, v.bid, VSCore.DRAFT.order.includes(v.card.k)], [0, null, true], 'both in: the first card is up, no bid yet');
  const card0 = (await state(w, ma.room)).draft.pool[0], f0 = v.floor[0];
  assert.ok(f0 >= 1 && f0 === card0.sticker && v.card.sticker === f0, 'the floor on an open card is the sticker, shown on the card');
  A.send({ t: 'bid', i: 0, amount: f0 - 1 });                            // (under the floor: nothing)
  await w.settle();
  assert.strictEqual((await state(w, ma.room)).draft.bid, null, 'under the floor is no bid');
  A.send({ t: 'bid', i: 0, amount: 20 });
  await w.settle();
  assert.deepStrictEqual(B.last('bid') && [B.last('bid').seat, B.last('bid').amount], [0, 20], 'the other side hears the bid, and how much');
  B.send({ t: 'bid', i: 0, amount: 20 });                                // (not over it: nothing)
  B.send({ t: 'bid', i: 0, amount: 45 });                                // (over the most: nothing)
  await w.settle();
  assert.deepStrictEqual((await state(w, ma.room)).draft.bid, { seat: 0, amount: 20 }, 'a bid not over, or over the most, is nothing');
  B.send({ t: 'bid', i: 0, amount: 22 });
  await w.settle();
  const Ra = await state(w, ma.room);
  assert.deepStrictEqual([Ra.draft.bid, Ra.draft.i], [{ seat: 1, amount: 22 }, 0], 'a bid over it is in; the card is still up');
  B.send({ t: 'pass', i: 0 });                                            // (the high bidder: nothing)
  await w.settle();
  assert.strictEqual((await state(w, ma.room)).draft.i, 0, 'the high bidder cannot pass');
  A.send({ t: 'pass', i: 0 });                                            // (the other side: settled at once, no clock to wait out)
  await w.settle();
  assert.deepStrictEqual(A.last('pass') && [A.last('pass').seat, A.last('pass').i], [0, 0], 'the pass went round');
  v = A.last('draft').d;
  assert.deepStrictEqual([v.last.seat, v.last.amount, v.budget, v.picks[1][0].team, v.picks[1][0].name, v.need[1][card0.k], v.i], [1, 22, [50, 28], card0.team, card0.name, SLOTS[card0.k] - 1, 1], 'the clock ran out: the high bid took him at its price');
  // the owner's case: the first man of a kind went for $22, so the next of that kind opens at $11 for the side without one, not his sticker
  const nextSame = v.card.k === card0.k;
  if (nextSame) assert.deepStrictEqual([v.floor[0], SLOTS[card0.k] > 1 ? v.floor[1] : v.max[1]], [Math.max(11, v.card.sticker), SLOTS[card0.k] > 1 ? Math.max(11, v.card.sticker) : 0], 'the floor is half what the other side paid');
  else assert.strictEqual(v.floor[0], v.card.sticker, 'another kind: its sticker');
  // a card nobody claims passes to nobody when the clock runs out
  const Rb = await state(w, ma.room);
  await w.advance(OPEN_MS + 100);
  const Rc = await state(w, ma.room);
  assert.deepStrictEqual([Rc.draft.i, Rc.draft.last.seat, Rc.draft.last.amount, Rc.draft.picks[0].length + Rc.draft.picks[1].length], [Rb.draft.i + 1, -1, 0, 1], 'nobody claimed it: nobody has it');
  // a bid on a card that is gone counts for nothing; an opening bid at the floor stands when nobody answers
  v = A.last('draft').d;
  A.send({ t: 'bid', i: v.i - 1, amount: 30 });
  await w.settle();
  assert.strictEqual((await state(w, ma.room)).draft.bid, null, 'a stale bid is dropped');
  const kindUp = v.card.k, needBefore = v.need[0][kindUp];
  if (!v.floor[0] || v.floor[0] > v.max[0]) { /* (an unaffordable card: skip the floor check) */ } else {
    A.send({ t: 'bid', i: v.i, amount: v.floor[0] });
    await w.settle();
    assert.deepStrictEqual((await state(w, ma.room)).draft.bid, { seat: 0, amount: v.floor[0] }, 'the floor opens the card');
    await w.advance(RAISE_MS + 100);
    const Rd = await state(w, ma.room);
    assert.deepStrictEqual([Rd.draft.last.seat, Rd.draft.last.amount, Rd.draft.need[0][kindUp]], [0, v.floor[0], needBefore - 1], 'unanswered, it stands: the card at its floor');
    // the card up next is always one somebody still needs (a kind both sides have is skipped: draftAdvance)
    const up = Rd.draft.pool[Rd.draft.i];
    assert.ok(!up || Rd.draft.need[0][up.k] > 0 || Rd.draft.need[1][up.k] > 0, 'a kind both sides have is skipped');
  }
  // "still here?": a side that lets DRAFT_IDLE_CARDS cards it could have bid on go by (passing, or the clock) is asked;
  // a tap keeps its seat, no answer within STILL_MS and the draft is over, a forfeit by it (unrated)
  {
    const idle = async (who) => { for (let k = 0; k < 40; k++) { const Rk = await state(w, ma.room); if (Rk.phase !== 'draft' || (Rk.draft.idle || [])[who] >= DRAFT_IDLE_CARDS) return Rk; const o = Rk.draft.pool[Rk.draft.i]; if (!o) return Rk;
      if (VSCore.draftMax(Rk.draft, who, o) > 0 && k % 2) { (who === 1 ? B : A).send({ t: 'pass', i: Rk.draft.i }); await w.settle(); } await w.advance(OPEN_MS + RAISE_MS + 200); } return state(w, ma.room); };
    const R1 = await idle(1);
    assert.ok(R1.phase === 'draft' && R1.draft.idle[1] >= DRAFT_IDLE_CARDS && R1.draft.ask[1] > 0, `Bob asked after ${DRAFT_IDLE_CARDS} cards without a bid`);
    assert.ok(B.last('stillhere') && B.last('stillhere').by === R1.draft.ask[1] && !A.last('stillhere'), 'the question went to Bob alone');
    B.send({ t: 'here' });
    await w.settle();
    const R2 = await state(w, ma.room);
    assert.deepStrictEqual([R2.draft.ask[1], R2.draft.idle[1], R2.phase], [0, 0, 'draft'], 'a tap keeps the seat; the count starts over');
    // a fresh pair: the one asked never answers
    const c = new FakeClient(w, K(84)), e = new FakeClient(w, K(85));
    await c.queue({ mode: 'draft', team: '', name: 'Cal' });
    await e.queue({ mode: 'draft', team: '', name: 'Eve' });
    const mc = c.last('match');
    const Cc = new FakeClient(w, c.key), Ee = new FakeClient(w, e.key);
    await Cc.open(mc.room, { mode: 'draft' }); await Ee.open(mc.room, { mode: 'draft' });
    await w.advance(100);
    let R3 = await state(w, mc.room);
    for (let k = 0; k < 40 && R3.phase === 'draft' && !(R3.draft.ask || [])[1]; k++) {
      const o = R3.draft.pool[R3.draft.i];
      if (o && VSCore.draftMax(R3.draft, 0, o) > 0) { Cc.send({ t: 'bid', i: R3.draft.i, amount: VSCore.draftFloor(R3.draft, 0, o) }); await w.settle(); }
      await w.advance(OPEN_MS + RAISE_MS + 200);
      R3 = await state(w, mc.room);
    }
    assert.ok(R3.phase === 'draft' && R3.draft.ask[1] > 0 && Ee.last('stillhere'), 'Eve asked');
    await w.advance(STILL_MS + 100);
    const R4 = await state(w, mc.room);
    assert.deepStrictEqual([R4.phase, R4.result.by, R4.result.why, R4.result.loser, R4.result.winner, R4.rated], ['over', 'forfeit', 'away', 1, 0, null], 'no answer: Eve is out, the draft is over, nothing rated');
    assert.ok(Cc.last('over') && Cc.last('over').result.why === 'away' && Ee.last('over'), 'both phones told');
  }
  w.close();
}
console.log('match rooms ok');
