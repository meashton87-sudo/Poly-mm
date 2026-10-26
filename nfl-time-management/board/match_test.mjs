// Tests for versus (match.js): rooms, the lobby and the ladder, run in memory (vs_world.mjs) with a small stand-in
// engine, so they run anywhere in a second:  node board/match_test.mjs
// (vs_stress.mjs plays thousands of whole matches with the real engine.)
import assert from 'node:assert';
import { World, FakeClient } from './vs_world.mjs';
import { ROOM_RE, PLAY_MS, WATCH_MS, DECIDE_MS, OFF_MS, DEF_MS, decideMs, FIRST_MS, FORFEIT_MS, AFK_LIMIT, NOSHOW_MS, ELO, MM, CPU_AFTER_S, CPU_SEAT, CPU_TURN_MS } from './match.js';

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
  assert.deepStrictEqual([a.last('over').result.winner, a.last('over').result.by, a.last('over').result.loser], [0, 'forfeit', 1], 'gone a minute (or its calls left to the clock): a forfeit');
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
console.log('match rooms ok');
