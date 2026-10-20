// Engine sweep for the daily game: every spot x every call x tempo x seeds, then whole games from every spot,
// checking the football on every step (clock, scores, downs, distances, yard lines, touchdowns, safeties), that every
// point goes to the team that scored it (the log against the scoreboard), and that the play called is the play run
// (a spike is a spike, a kneel a kneel, a call that call) even when the clock stops before the snap.
//   node web/game_sweep.js [seeds per call, default 4] [games per spot, default 2] [salt, default 0]     (about 3 minutes)
// (a salt other than 0 moves every seed: the same checks on other draws; scripts/daily_check.py runs a few at once on the
// live site's data, a new salt each day)
const fs = require('fs');
const path = require('path');
const W = __dirname + path.sep;
const E = require(W + 'engine.js');
const eng = new E(JSON.parse(fs.readFileSync(W + 'engine_data.json', 'utf8')));
eng.loadPlaybook(JSON.parse(fs.readFileSync(W + 'playbook.json', 'utf8')));
const idx = JSON.parse(fs.readFileSync(W + 'game.json', 'utf8'));
const P = eng.pb, calls = P.calls.map((c) => c.id);
const SEEDS = +(process.argv[2] || 4), GAMES = +(process.argv[3] || 2), SALT = (+(process.argv[4] || 0) * 1000003) >>> 0;
const bad = {}, seen = {};
const flag = (k, msg) => { bad[k] = bad[k] || []; if (bad[k].length < 6) bad[k].push(msg); bad[k].n = (bad[k].n || 0) + 1; };
const count = (k) => { seen[k] = (seen[k] || 0) + 1; };
// every spot's two teams as they were in that game (web/spots)
const TEAMS = {};
fs.readdirSync(W + 'spots').forEach((f) => Object.assign(TEAMS, JSON.parse(fs.readFileSync(W + 'spots' + path.sep + f, 'utf8'))));
function scen(sp) {
  const T = TEAMS[idx.spots.indexOf(sp)], H = T.home, A = T.away;
  return { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
    league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real.season };
}
function rootOf(sp) {
  const st = sp.start;
  return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sp.home ? 0 : 1,
    score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]],
    clock_running: st.running, phase: 0, credit: 0, free_kick: false };
}
const halfLeftOf = (t) => t - (t > 1800 ? 1800 : 0);
function check(before, r, tag) {
  const a = before, b = r.root, halfEnd = a.t > 1800 ? 1800 : 0;
  if (!(b.t <= a.t + 1e-9) && !r.log.some((e) => e.ev === 'period')) flag('clock went up', `${tag} ${a.t} -> ${b.t}`);
  if (b.t < halfEnd - 1e-9) flag('clock past the half', `${tag} ${b.t}`);
  if (b.phase === 0 && !r.done) {
    if (!(b.down >= 1 && b.down <= 4)) flag('bad down', `${tag} ${b.down}`);
    if (!(b.yl >= 1 && b.yl <= 99)) flag('bad yard line', `${tag} ${b.yl}`);
    if (!(b.ytg >= 1 && b.ytg <= 99)) flag('bad distance', `${tag} ${b.ytg}`);
    if (b.ytg > b.yl + 1e-9) flag('distance beyond goal', `${tag} ytg ${b.ytg} yl ${b.yl}`);
  }
  b.to.forEach((x) => { if (!(x >= 0 && x <= 3)) flag('bad timeouts', `${tag} ${b.to}`); });
  // no call is asked for with the scoreboard at 0:00 (game.js clockOf: the seconds left, rounded up), unless it is an
  // untimed down (a defensive foul as time ran out): the clock's tenths once summed to 1e-14 s left, a snap at 0:00
  if (b.phase === 0 && !r.done && Math.ceil(b.t - halfEnd - 1e-6) <= 0 && !r.log.some((e) => e.untimed)) flag('a snap to call at 0:00', `${tag} t ${b.t} ${JSON.stringify(r.log.map((e) => e.ev))}`);
  // the clock rules: a timeout is spent only when one is logged for that team, with the clock running, and it
  // never ends the half or skips the two-minute warning; incompletions, scores, changes of possession and kicks stop it
  const tmw = halfEnd + 120, tos = r.log.filter((e) => e.ev === 'timeout');
  if (!r.log.some((e) => e.ev === 'period')) [0, 1].forEach((k) => { if (a.to[k] - b.to[k] !== tos.filter((e) => e.team === k).length) flag('timeouts gone without a timeout', `${tag} ${a.to} -> ${b.to} ${JSON.stringify(r.log)}`); });
  if (tos.length && !a.clock_running) flag('a timeout with the clock stopped', tag);
  tos.forEach((e) => {
    if (e.why !== 'kick' && !(e.t > halfEnd)) flag('a timeout ran out the half', `${tag} ${a.t} -> ${e.t}`);
    if (a.t > tmw && e.t < tmw - 1e-9 && e.why !== 'kick') flag('a timeout skipped the two-minute warning', `${tag} ${a.t} -> ${e.t}`);
  });
  const k0 = r.log.find((e) => e.ev === 'play' || e.ev === 'fg' || e.ev === 'punt');
  if (k0 && b.phase === 0 && !r.done && b.clock_running && (k0.ev !== 'play' || k0.incomplete || k0.td || k0.tdDef || k0.safety || k0.turnover || k0.onDowns))
    flag('the clock ran on after a play that stops it', `${tag} ${JSON.stringify(k0)}`);
  // a half never ends on an accepted defensive foul (an untimed down); no try after a touchdown as the fourth quarter
  // runs out when it cannot change the result (a margin of 3 or more); only a team behind declares an onside kick
  const k1 = r.log.find((e) => e.ev === 'play');
  if (k1 && k1.penalty && k1.yards > 0 && !k1.td && !k1.tdDef && !k1.turnover && !k1.safety && !k1.onDowns && (r.done || b.t <= halfEnd)) flag('a half ended on a defensive foul', `${tag} ${JSON.stringify(k1)}`);
  if (k1 && k1.untimed) count('untimed downs');
  if (b.phase === 1 && !r.done && !b.ot && halfEnd === 0 && b.t <= 0 && Math.abs(b.score[b.pos] - b.score[1 - b.pos]) >= 3) flag('a try that cannot change the result', `${tag} ${b.score}`);
  if (r.log.some((e) => e.ev === 'notry')) count('no try after the last play');
  r.log.forEach((e) => { if (e.ev === 'kickoff' && e.onside && !a.free_kick && !(a.score[e.team] < a.score[1 - e.team])) flag('an onside kick by a team not behind', `${tag} ${a.score}`); });
  const ds = [b.score[0] - a.score[0], b.score[1] - a.score[1]];
  ds.forEach((d) => { if (![0, 1, 2, 3, 6, 7, 8].includes(d)) flag('odd score change', `${tag} ${a.score} -> ${b.score}`); });
  for (const e of r.log) {
    if (e.ev !== 'play') continue;
    count('plays');
    const pb = e.row >= 0, y = e.yards;
    if (!Number.isFinite(y)) flag('yards not finite', `${tag} ${JSON.stringify(e)}`);
    if (!(e.dur >= 0 && e.dur <= 60)) flag('odd duration', `${tag} dur ${e.dur}`);
    if (e.safety) { count('safeties'); if (!(e.yl - y >= 100 - 1e-9) && !e.penalty) flag('safety from too far out', `${tag} yl ${e.yl} yards ${y} ${pb ? 'playbook' : 'core'} ${pb ? P.eventNames[P.event[e.row]] : ''}`); }
    if (e.td) { count('TDs'); if (y < 0.6 * e.yl - 1e-9 && pb) flag('playbook TD that did not cover the way', `${tag} yl ${e.yl} yards ${y}`);
      if (y < 0.6 * e.yl - 1e-9 && !pb) count('core TD short of the goal (zone pools)'); }
    if (!e.td && !e.turnover && !e.penalty && !e.safety && !e.onDowns && e.yl - y <= 0) flag('crossed the goal line without a TD', `${tag} yl ${e.yl} yards ${y}`);
    const ev = pb && P.event ? P.eventNames[P.event[e.row]] : '';
    // a leading team late, deep in its own end, may run backward to burn the clock (even into a safety): real plays
    const burn = a.score[e.team] > a.score[1 - e.team] && halfLeftOf(a.t) <= 150 && e.yl >= 60;
    if (e.kind === 0 && !e.penalty && !/fumble|bad_snap/.test(ev) && y < -15) {
      // a blown-up end-around can lose that much: 2 of the 1,910 real ones (2022-26) did
      if (burn) count('clock-burn runs backward'); else if (calls[e.call] === 'trick_reverse') count('end-around lost 15+');
      else flag('run lost 15+', `${tag} ${y} ${calls[e.call] || 'core'} ${ev}`);
    }
    if (e.kind === 1 && /sack/.test(ev) && (y > 0 || y < -30)) flag('odd sack', `${tag} ${y}`);
    if (e.incomplete && y !== 0 && !e.penalty) flag('incomplete with yards', `${tag} ${y}`);
  }
}
// every point to the team that scored it: the scoreboard change must be what the log says happened, and the
// team that scored kicks the try (or, after a field goal or a safety, the right team kicks off)
function attrib(before, r, tag) {
  const want = [0, 0];
  let last = null;
  for (const e of r.log) {
    if (e.ev === 'play') {
      if (e.td) { want[e.team] += 6; last = { phase: 1, pos: e.team, why: 'TD' }; }
      else if (e.tdDef) { want[1 - e.team] += 6; last = { phase: 1, pos: 1 - e.team, why: 'defensive TD' }; count('defensive TDs'); }
      else if (e.safety) { want[1 - e.team] += 2; last = { phase: 2, pos: e.team, why: 'safety' }; }
      if (e.td && e.tdDef) flag('TD for both teams', `${tag} ${JSON.stringify(e)}`);
      if (e.tdDef && !e.turnover) flag('defensive TD without a turnover', `${tag} ${JSON.stringify(e)}`);
    } else if (e.ev === 'fg' && e.made) { want[e.team] += 3; last = { phase: 2, pos: e.team, why: 'FG' }; }
    else if (e.ev === 'fg' && e.retTd) { want[1 - e.team] += 6; last = { phase: 1, pos: 1 - e.team, why: 'blocked FG TD' }; count('blocked FG TDs'); }
    else if (e.ev === 'pat' && e.good) want[e.team] += e.two ? 2 : 1;
    else if (e.ev === 'punt' && e.retTd) { want[1 - e.team] += 6; last = { phase: 1, pos: 1 - e.team, why: 'punt return TD' }; }
    else if (e.ev === 'kickoff' && e.retTd) { want[1 - e.team] += 6; last = { phase: 1, pos: 1 - e.team, why: 'kick return TD' }; }
  }
  const got = [r.root.score[0] - before.score[0], r.root.score[1] - before.score[1]];
  if (got[0] !== want[0] || got[1] !== want[1]) flag('points to the wrong team', `${tag} log says ${want}, scoreboard ${got}: ${JSON.stringify(r.log)}`);
  if (last && !r.done && (r.root.phase !== last.phase || r.root.pos !== last.pos))
    flag('wrong team kicks after a score', `${tag} ${last.why}: phase ${r.root.phase} pos ${r.root.pos}, wanted ${last.phase}/${last.pos}`);
  if (before.phase === 1 && !r.done && r.root.phase !== 2) flag('no kickoff after the try', `${tag} phase ${r.root.phase}`);
  if (before.phase === 1 && r.root.pos !== before.pos) flag('the wrong team kicks off after the try', `${tag}`);
}
// the play called is the play run: unless the half ran out first, a spike is a spike, a kneel a kneel, a field goal a
// field goal, a punt a punt, a call that call, and a timeout is taken when the clock is running and one is left
function honored(before, action, r, tag) {
  // a kick you called always gets off, whatever the tempo and however little time is left
  if (before.phase === 0 && action.play === 'fg' && !r.log.some((e) => e.ev === 'fg')) flag('called fg, never kicked', `${tag} ${JSON.stringify(before)} ${JSON.stringify(action)} -> ${JSON.stringify(r.log)}`);
  if (before.phase !== 0 || r.log.some((e) => e.ev === 'end' || e.ev === 'period')) return;     // the clock ran out first
  const o = before.pos, e = r.log.find((x) => x.ev === 'play' || x.ev === 'fg' || x.ev === 'punt');
  if (action.to_off && before.clock_running && before.to[o] > 0 && !r.log.some((x) => x.ev === 'timeout'))
    flag('timeout not taken', `${tag}`);
  if (action.to_off) return;
  const p = action.play;
  if (!p && action.call === undefined) return;
  count(`called ${p}`);
  const what = !e ? 'nothing' : e.ev !== 'play' ? e.ev : ['run', 'pass', 'kneel', 'spike'][e.kind] || `kind ${e.kind}`;
  const wantWhat = p === 'fg' ? 'fg' : p === 'punt' ? 'punt' : p;
  if (what !== wantWhat) flag(`called ${p}, got ${what}`, `${tag} ${JSON.stringify(before)} -> ${JSON.stringify(r.log)}`);
  else if (p === 'spike' && (e.yards !== 0 || !e.incomplete || e.td || e.turnover)) flag('spike with a result', `${tag} ${JSON.stringify(e)}`);
  else if (action.call !== undefined && e.call !== P.callIndex[action.call]) flag('a different call was run', `${tag} called ${action.call}, ran ${calls[e.call]}`);
  else if (action.route && !e.penalty) {      // the route you picked, by a receiver at the position you picked
    const ran = P.routeNames[P.ngs.route[e.row]], pos = ['', 'QB', 'RB', 'WR', 'TE'][P.carry[e.row] & 7];
    if (ran !== action.route) flag('picked route not run', `${tag} picked ${action.route}, ran ${ran}`); else count('picked route run');
    if (pos === action.who) count('picked position run'); else count('picked position: another (incomplete, uncharted)');
  }
  if (e && e.ev === 'play' && e.team !== o) flag('the wrong team ran the play', `${tag}`);
}
// a pass to a receiver you picked, on a route you picked (game.js passCallOf maps it to the call whose plays it draws)
const PICKS = [['WR', 'slant', 'quick_strong'], ['WR', 'go', 'deep_weak'], ['WR', 'post', 'deep_middle'], ['WR', 'in', 'quick_middle'],
  ['TE', 'flat', 'quick_strong'], ['TE', 'go', 'deep_strong'], ['RB', 'wheel', 'deep_weak'], ['RB', 'screen', 'screen'], ['WR', 'out', 'pa_short'], ['WR', 'corner', 'roll_weak']];
function routePick(k) {
  const [who, route, call] = PICKS[k % PICKS.length];
  return { to_off: false, play: 'pass', call, route, who, looks: k % 2 ? 1 << (k % 4) : 0 };
}
// a play drawn against a look (a mask of lookBucket values) should have been run against it, unless the call has too
// few such plays here and the engine falls back to all of them
function lookHit(r, mask) {
  if (!mask || !P.lookB) return;
  const e = r.log.find((x) => x.ev === 'play' && x.row >= 0);
  if (!e) return;
  count(`look asked`);
  if ((mask >> P.lookB[e.row]) & 1) count('look matched');
}
// kickoffs: through the end zone is a touchback at the 35; to the returner is never one
function kickCheck(r, kick, tag, free) {
  const e = r.log.find((x) => x.ev === 'kickoff');
  if (!e || e.onside) return;
  count(`kick ${kick}`);
  if (kick === 'touchback' && !free && !(e.tb && Math.round(e.yl) === 65)) flag('touchback not at the 35', `${tag} ${JSON.stringify(e)}`);
  if (kick === 'return' && e.tb && Math.round(e.yl) === 65) flag('return kick came out a touchback', `${tag} ${JSON.stringify(e)}`);
  if (e.retTd) count('kick return TDs');
}
let steps = 0, t0 = Date.now();
// 1) every spot x every call x seeds, from the spot's start (our ball spots) and from a few synthetic states
// a defensive call in full, every combination in turn
const fullDef = (k) => ({ pers: ['heavy', 'base', 'nickel', 'dime'][k % 4], front: ['light', 'even', 'loaded'][(k >> 2) % 3],
  cover: ['c0', 'c1', '2man', 'c2', 'c3', 'c4', 'c6', 'prevent'][(k >> 1) % 8], rush: [3, 4, 5, 6][(k >> 3) % 4] });
idx.spots.forEach((sp, si) => {
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  const root = rootOf(sp);
  if (root.phase !== 0) return;
  const variants = [root, { ...root, yl: 97, ytg: 10, down: 1 }, { ...root, yl: 3, ytg: 3, down: 2 }, { ...root, yl: 52, ytg: 7, down: 3, clock_running: true }];
  variants.forEach((rt, vi) => {
    calls.forEach((id, ci) => {
      for (let s = 0; s < SEEDS; s++) {
        const before = JSON.parse(JSON.stringify(rt));
        const tempo = ['urgent', 'hurry', 'normal', 'milk'][s % 4];
        const looks = s % 2 ? 1 << ((s >> 1) % 4) : 0;     // half the snaps against one defensive look
        const r = sim.step(rt, { action: { to_off: false, play: P.calls[ci].kind, call: id, oob: s % 3 === 0, tempo: rt.clock_running ? tempo : undefined, looks, pers: [undefined, 11, 12, 21, 13][(s + vi) % 5] }, seed: si * 1000 + ci * 37 + s * 7919 + vi + SALT });
        steps++;
        check(before, r, `spot ${si} v${vi} ${id} s${s}`);
        attrib(before, r, `spot ${si} v${vi} ${id} s${s}`);
        honored(before, { play: P.calls[ci].kind, call: id }, r, `spot ${si} v${vi} ${id} s${s}`);
        lookHit(r, looks);
      }
    });
  });
  // the clock calls from late states in either half, where the defense may take a timeout before the snap (which
  // stops the clock): a spike must still be a spike
  [3500, 1890, 1830, 1805, 500, 125, 115, 60, 40, 30, 25, 8].forEach((t, k) => {
    [true, false].forEach((running) => {
      const rt = { ...root, t, clock_running: running, down: 1 + (k % 3), yl: [80, 50, 20, 70, 35][k % 5], ytg: 10, to: [k % 4, (k + 1) % 4] };
      rt.ytg = Math.min(rt.ytg, rt.yl);
      ['spike', 'kneel', 'fg', 'punt', 'timeout'].forEach((p, j) => {
        for (let s = 0; s < 3; s++) {
          const before = JSON.parse(JSON.stringify(rt)), tag = `spot ${si} t${t} ${running ? 'running' : 'stopped'} ${p} s${s}`;
          const action = p === 'timeout' ? { to_off: true } : { to_off: false, play: p };
          if (s === 1 && running && p !== 'timeout') action.to_def = true;        // their timeout first
          if (running && p === 'fg' && s !== 1) action.tempo = s ? 'milk' : 'normal';      // a kick called in the huddle
          const r = sim.step(rt, { action, seed: si * 7 + k * 131 + j * 17 + s + SALT });
          steps++;
          check(before, r, tag); attrib(before, r, tag); honored(before, action, r, tag);
        }
      });
    });
  });
});
// 2) whole games from every spot: our calls random, their plays the engine's own, until the spot ends
let games = 0, stuck = 0;
idx.spots.forEach((sp, si) => {
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  for (let g = 0; g < GAMES; g++) {
    let cur = rootOf(sp), n = 0;
    const me = cur.pos;
    while (n++ < 400) {
      let action = {};
      if (cur.phase === 0 && cur.pos === me) {
        const ci = (si * 7 + g * 13 + n * 5) % calls.length;
        const pick = (si + g + n) % 11;
        action = pick === 0 && cur.clock_running ? { to_off: true } : pick === 1 && cur.down <= 3 ? { to_off: false, play: 'spike' } : pick === 2 && cur.down === 4 && sim.fourthInfo(cur).pFg >= 0.05 ? { to_off: false, play: 'fg' }
          : pick === 3 && cur.down === 4 && cur.yl >= 35 ? { to_off: false, play: 'punt' } : pick === 4 && cur.down <= 3 && n % 3 === 0 ? { to_off: false, play: 'kneel' }
          : pick >= 5 && pick <= 7 ? routePick(n + g + si)
          : { to_off: false, play: P.calls[ci].kind, call: calls[ci], oob: n % 2 === 0, tempo: cur.clock_running ? ['urgent', 'hurry', 'normal', 'milk'][n % 4] : undefined, pers: [undefined, 12, 21, 13][n % 4] };
      } else if (cur.phase === 0) {
        action = { to_def: n % 5 === 0, st: ['block', 'safe', 'rush', 'return'][(n + g) % 4] };
        if (n % 4 === 1) action.def = ['blitz', 'load', 'soft'][n % 3];
        else if (n % 4) action.dc = fullDef(n + g + si), action.read = true;      // the full call (personnel, front, coverage, rush)
      }
      else if (cur.phase === 1 && cur.pos === me) action = { pat: n % 3 ? 'xp' : 'two' };
      else if (cur.phase === 2 && cur.pos === me) action = { kick: ['return', 'touchback', 'onside', 'deep'][(n + g) % 4] };
      const before = JSON.parse(JSON.stringify(cur));
      const r = sim.step(cur, { action, seed: 77 + si * 31 + g * 101 + n + SALT });
      steps++;
      check(before, r, `game ${si}.${g} step ${n}`);
      if (sp.start.qtr <= 2 && r.root.t < 1800) flag('a first-half spot went on into the second half', `game ${si}.${g} step ${n} t ${r.root.t}`);
      attrib(before, r, `game ${si}.${g} step ${n}`);
      if (cur.pos === me) honored(before, action, r, `game ${si}.${g} step ${n}`);
      // their defense, not behind, never gives our offense a timeout it has none of (the running clock is ours to beat)
      if (before.phase === 0 && cur.pos === me && before.t <= 1800 && before.to[me] === 0 && before.score[1 - me] >= before.score[me] && r.log.some((e) => e.ev === 'timeout' && e.team !== me))
        flag('their defense gave us a timeout', `game ${si}.${g} step ${n} ${before.score} t ${before.t}`);
      if (action.kick) kickCheck(r, action.kick, `game ${si}.${g} step ${n}`, before.free_kick);
      for (const e of r.log) if ((e.ev === 'fg' || e.ev === 'punt') && action.st) {     // your special teams on their kick
        const tag = `${e.ev} ${action.st}`;
        count(`${tag}: kicks`);
        if (e.blocked) count(`${tag}: blocked`);
        if (e.foul) {
          count(`${tag}: roughing`);
          if (r.root.pos !== e.team || r.root.down !== 1) flag('roughing did not give the kicking team a first down', `game ${si}.${g} step ${n}`);
        }
        if (e.foul && !((e.ev === 'fg' && action.st === 'block') || (e.ev === 'punt' && action.st === 'rush'))) flag('a roughing flag without the rush', `game ${si}.${g} step ${n} ${tag}`);
      }
      if (action.def) lookHit(r, { blitz: 10, load: 4, soft: 1 }[action.def]);
      if (action.dc) for (const e of r.log) if (e.ev === 'play' && e.call >= 0) {
        count('full defense: snaps');
        if (!Array.isArray(e.why)) flag('a snap against a full defensive call has no matchup reasons', `game ${si}.${g} step ${n}`);
      }
      cur = r.root;
      if (r.done) break;
    }
    if (n >= 400) stuck++;
    games++;
  }
});
// 2b) a touchdown on the last play of the first half: the try at 0:00 of Q2 (t = 1800) ends the half, from every
// first-half spot's two teams, whichever team scored and whatever the try
idx.spots.forEach((sp, si) => {
  if (sp.start.qtr > 2) return;
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  for (const pos of [0, 1]) for (const pat of ['xp', 'two']) {
    const r = sim.step({ ...rootOf(sp), t: 1800, phase: 1, pos, down: 1, ytg: 2, yl: 2, clock_running: false }, { action: { pat }, seed: si * 7 + pos + SALT });
    steps++;
    count('try at the end of the first half');
    if (!r.done || r.root.t !== 1800 || r.log.some((e) => e.ev === 'kickoff')) flag('a try at the end of the first half did not end it', `spot ${si} ${pat} ${JSON.stringify(r.root)}`);
  }
});
// 2c) the last play of the game from every spot's two teams: a pass with 0:04 left (a defensive foul gives an untimed
// down), and a touchdown at 0:00 (the try is played only when it can change the result)
idx.spots.forEach((sp, si) => {
  if (si % 3) return;
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  for (let k = 0; k < 24; k++) {
    const rt = { ...rootOf(sp), t: 4, pos: k % 2, score: [24, 20 + (k % 5)], down: 1, ytg: 10, yl: 30, to: [0, 0], clock_running: false, phase: 0 };
    const before = JSON.parse(JSON.stringify(rt)), tag = `spot ${si} last play ${k}`;
    const r = sim.step(rt, { action: { to_off: false, play: 'pass', call: ['deep_strong', 'deep_weak', 'hail_mary', 'quick_strong'][k % 4] }, seed: si * 131 + k + SALT });
    steps++;
    check(before, r, tag); attrib(before, r, tag);
  }
  for (const m of [-8, -3, -2, -1, 0, 1, 2, 3, 7]) {
    const rt = { ...rootOf(sp), t: 0, pos: si % 2, score: [0, 0], down: 1, ytg: 2, yl: 2, clock_running: false, phase: 1 };
    rt.score[rt.pos] = 20 + m; rt.score[1 - rt.pos] = 20;
    const r = sim.step(rt, { action: { pat: 'xp' }, seed: si + m + SALT });
    steps++;
    const tried = r.log.some((e) => e.ev === 'pat');
    if (tried !== (Math.abs(m) < 3) || !r.done) flag('the try after a touchdown at 0:00', `spot ${si} margin ${m} tried ${tried} done ${r.done}`);
    count('try at 0:00 checked');
  }
});
// 3) overtime (survivor) from every other spot's two teams: tied, a 10-minute period (15 in the playoffs),
// kicking off. Checked against the rules, not the engine's own bookkeeping: an early end is never a tie and comes
// only after both teams have had the ball (a snap, or taking it away: a pick-six on the first drive ends it) or on
// a safety; a team ahead never gets the ball back once the other has had it; a touchdown that wins it gets no try;
// a team that has to score does not punt (their calls, not ours).
let otGames = 0;
idx.spots.forEach((sp, si) => {
  if (si % 2) return;
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  const po = sp.real && ['WC', 'DIV', 'CON', 'SB'].includes(sp.real.type);
  const tie = Math.max(...sp.start.score);
  let cur = { t: po ? 900 : 600, pos: si % 4 ? 0 : 1, score: [tie, tie], down: 1, ytg: 10, yl: 65, to: po ? [3, 3] : [2, 2],
    clock_running: false, phase: 2, credit: 0, free_kick: false, ot: { c: [0, 0], po, n: 1 } };
  const me = (si >> 1) % 2, had = [false, false];
  let n = 0, end = null;
  while (n++ < 300) {
    let action = {};
    if (cur.phase === 0 && cur.pos === me) {
      const ci = (si * 7 + n * 5) % calls.length;
      action = n % 9 === 0 && cur.down === 4 && cur.yl >= 35 ? { to_off: false, play: 'punt' } : n % 5 === 0 ? routePick(n + si)
        : { to_off: false, play: P.calls[ci].kind, call: calls[ci], oob: n % 2 === 0, tempo: cur.clock_running ? ['urgent', 'hurry', 'normal', 'milk'][n % 4] : undefined, pers: [undefined, 12, 21, 13][n % 4] };
    } else if (cur.phase === 0) action = n % 2 ? { to_def: false, def: ['blitz', 'load', 'soft'][n % 3] } : { to_def: false, dc: fullDef(n + si), read: true };
    else if (cur.phase === 1 && cur.pos === me) action = { pat: n % 4 ? 'xp' : 'two' };
    else if (cur.phase === 2 && cur.pos === me) action = { kick: ['return', 'touchback', 'deep'][n % 3] };
    const before = JSON.parse(JSON.stringify(cur)), tag = `ot ${si} step ${n}`;
    const tiedSD = before.phase === 0 && had[0] && had[1] && before.score[0] === before.score[1];
    if (before.phase === 0) had[before.pos] = true;
    const r = sim.step(cur, { action, seed: 991 + si * 53 + n + SALT });
    steps++;
    check(before, r, tag); attrib(before, r, tag);
    if (before.pos === me) honored(before, action, r, tag);
    const b = r.root, lead = b.score[0] - b.score[1];
    if (before.phase === 0 && b.pos !== before.pos) had[b.pos] = true;      // they got the ball: a turnover, a punt, a return score
    // a kickoff returned for a touchdown is the receiving team's possession too (they score without a snap)
    if (before.phase === 2 && b.score[1 - before.pos] > before.score[1 - before.pos]) had[1 - before.pos] = true;
    if (!b.ot) flag('overtime state lost', tag);
    if (r.log.some((e) => e.ev === 'period')) {
      count('overtime: another playoff period');
      if (!(po && b.t === 900 && b.score[0] === b.score[1] && before.t - 0 <= 900)) flag('odd new overtime period', `${tag} ${JSON.stringify(b)}`);
    }
    for (const e of r.log) {
      if (e.ev !== 'punt' || e.team === me) continue;
      const m = before.score[e.team] - before.score[1 - e.team];
      if (had[1 - e.team] && m <= -4) flag('punted in overtime when only a touchdown would do', `${tag} down ${-m}`);
    }
    const safety = r.log.some((e) => e.ev === 'play' && e.safety);
    if (b.phase === 1 && !r.done && had[1 - b.pos] && b.score[b.pos] > b.score[1 - b.pos]) flag('a winning overtime touchdown went to a try', tag);
    if (r.done) {
      if (b.t > 0) {
        if (lead === 0) flag('overtime ended early in a tie', tag);
        if (!(had[0] && had[1]) && !safety) flag('overtime ended before both teams had the ball', `${tag} ${before.score} -> ${b.score} ${r.log.map((e) => e.ev + (e.td ? ':td' : '') + (e.turnover ? ':turnover' : '') + (e.retTd ? ':returnTd' : '') + (e.blocked ? ':blocked' : '')).join(',')}`);
        end = safety ? 'safety' : tiedSD ? 'sudden death' : had[0] && had[1] && Math.abs(lead) >= 1 ? 'after both possessions' : 'other';
      } else end = lead === 0 ? 'tie after the period' : 'won at the gun';
      if (po && lead === 0) flag('a playoff overtime ended in a tie', tag);
      break;
    }
    if (b.phase === 0 && had[0] && had[1] && b.score[b.pos] > b.score[1 - b.pos]) flag('overtime went on with the leader getting the ball back', `${tag} ${b.score}`);
    cur = b;
  }
  if (!end) flag('overtime never ended', `ot ${si}`);
  else count(`overtime: ${end}`);
  otGames++;
});
// 4) drawn calls (game.js readRun, readDef, readKick: a drawing is read as a call the keys make): the drawing goes with
// the call only to the field (a run's path, an RPO's route, the quarterback's drop, your defenders' lines), so every
// drawn call plays exactly as the tapped one (the same seed, the same result) and is the call run
const DRAW_X = (k) => {
  const path = [[26, -5.2], [26 + (k % 7) - 3, -2], [26 + (k % 11) - 5, 0.4], [26 + (k % 13) - 6, 6 + (k % 9)]];
  return { path, carrier: ['RB', 'QB', 'WR', 'FB'][k % 4], shape: ['downhill', 'counter', 'sweep', 'bounce', 'cutback'][k % 5], qbPath: [[26, -5], [26 + (k % 2 ? 6 : -6), -6.5]],
    target: k % 4, routes: ['go', 'out', 'slant', 'flat'], drawn: [null, { pts: [[0, -1], [0, 8], [4, 10]], at: 'depth' }, null, null], ddraw: [{ k: k % 11, pts: [[20, 6], [22, -2]] }, { k: (k + 3) % 11, pts: [[30, 12], [34, 18]] }] };
};
let drawnN = 0;
idx.spots.forEach((sp, si) => {
  if (si % 2) return;
  const sim = eng.simulator(eng.makeContext(scen(sp), { receive2h: sp.start.receive2h }));
  const root = rootOf(sp), variants = [root, { ...root, yl: 2, ytg: 2, down: 1, try2: false }, { ...root, yl: 4, ytg: 4, down: 3 }, { ...root, yl: 96, ytg: 10, down: 2 }];
  variants.forEach((rt, vi) => {
    const ids = ['rb_out_strong', 'rb_out_weak', 'rb_tackle_strong', 'rb_tackle_weak', 'rb_inside_strong', 'rb_inside_weak', 'rb_middle', 'qb_sneak', 'qb_run',
      'trick_reverse', 'rpo_strong', 'rpo_weak', 'roll_strong', 'roll_weak', 'quick_strong'];
    ids.forEach((id, k) => {
      const base = { to_off: false, play: P.calls[P.callIndex[id]].kind, call: id, oob: k % 3 === 0, looks: k % 2 ? 1 << (k % 4) : 0 };
      const seed = si * 977 + vi * 131 + k * 17 + SALT, tag = `drawn ${si} v${vi} ${id}`;
      const r0 = sim.step(JSON.parse(JSON.stringify(rt)), { action: { ...base }, seed });
      const r1 = sim.step(JSON.parse(JSON.stringify(rt)), { action: { ...base, ...DRAW_X(k + si) }, seed });
      steps += 2; drawnN++;
      if (JSON.stringify(r0.log) !== JSON.stringify(r1.log) || JSON.stringify(r0.root) !== JSON.stringify(r1.root)) flag('a drawn call played differently from the tapped one', tag);
      check(rt, r1, tag); honored(rt, base, r1, tag);
    });
    // your defense drawn: the look or the full call it reads as, the defenders' lines with it
    if (rt.yl > 2) for (let k = 0; k < 6; k++) {
      const them = { ...rt, pos: 1 - rt.pos }, d = k % 2 ? { to_def: false, def: ['blitz', 'load', 'soft'][k % 3] } : { to_def: false, dc: fullDef(k + si + vi), read: true };
      const seed = si * 331 + vi * 37 + k + SALT;
      const r0 = sim.step(JSON.parse(JSON.stringify(them)), { action: { ...d }, seed }), r1 = sim.step(JSON.parse(JSON.stringify(them)), { action: { ...d, ddraw: DRAW_X(k).ddraw }, seed });
      steps += 2; drawnN++;
      if (JSON.stringify(r0.log) !== JSON.stringify(r1.log)) flag('a drawn defense played differently from the tapped one', `drawn def ${si} v${vi} ${k}`);
    }
  });
});
seen["drawn calls checked"] = drawnN;
console.log(`${steps} steps, ${games} games (${stuck} never ended), ${otGames} overtimes in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log('seen:', JSON.stringify(seen));
const keys = Object.keys(bad);
if (!keys.length) console.log('NO VIOLATIONS');
keys.forEach((k) => { console.log(`VIOLATION ${k}: ${bad[k].n}`); bad[k].forEach((m) => console.log('   ', m)); });
if (keys.length) process.exit(1);
