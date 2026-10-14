// Engine sweep for the daily game: every spot x every call x tempo x seeds, then whole games from every spot,
// checking the football on every step (clock, scores, downs, distances, yard lines, touchdowns, safeties), that every
// point goes to the team that scored it (the log against the scoreboard), and that the play called is the play run
// (a spike is a spike, a kneel a kneel, a call that call) even when the clock stops before the snap.
//   node web/game_sweep.js [seeds per call, default 4] [games per spot, default 2]     (about 3 minutes)
const fs = require('fs');
const path = require('path');
const W = __dirname + path.sep;
const E = require(W + 'engine.js');
const eng = new E(JSON.parse(fs.readFileSync(W + 'engine_data.json', 'utf8')));
eng.loadPlaybook(JSON.parse(fs.readFileSync(W + 'playbook.json', 'utf8')));
const idx = JSON.parse(fs.readFileSync(W + 'game.json', 'utf8'));
const P = eng.pb, calls = P.calls.map((c) => c.id);
const SEEDS = +(process.argv[2] || 4), GAMES = +(process.argv[3] || 2);
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
  if (!(b.t <= a.t + 1e-9)) flag('clock went up', `${tag} ${a.t} -> ${b.t}`);
  if (b.t < halfEnd - 1e-9) flag('clock past the half', `${tag} ${b.t}`);
  if (b.phase === 0 && !r.done) {
    if (!(b.down >= 1 && b.down <= 4)) flag('bad down', `${tag} ${b.down}`);
    if (!(b.yl >= 1 && b.yl <= 99)) flag('bad yard line', `${tag} ${b.yl}`);
    if (!(b.ytg >= 1 && b.ytg <= 99)) flag('bad distance', `${tag} ${b.ytg}`);
    if (b.ytg > b.yl + 1e-9) flag('distance beyond goal', `${tag} ytg ${b.ytg} yl ${b.yl}`);
  }
  b.to.forEach((x) => { if (!(x >= 0 && x <= 3)) flag('bad timeouts', `${tag} ${b.to}`); });
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
      if (burn) count('clock-burn runs backward'); else flag('run lost 15+', `${tag} ${y} ${calls[e.call] || 'core'} ${ev}`);
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
  if (before.phase !== 0 || r.log.some((e) => e.ev === 'end')) return;
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
  if (e && e.ev === 'play' && e.team !== o) flag('the wrong team ran the play', `${tag}`);
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
        const r = sim.step(rt, { action: { to_off: false, play: P.calls[ci].kind, call: id, oob: s % 3 === 0, tempo: rt.clock_running ? tempo : undefined, looks }, seed: si * 1000 + ci * 37 + s * 7919 + vi });
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
  [3500, 1890, 1830, 1805, 500, 125, 115, 60, 25, 8].forEach((t, k) => {
    [true, false].forEach((running) => {
      const rt = { ...root, t, clock_running: running, down: 1 + (k % 3), yl: [80, 50, 20, 70, 35][k % 5], ytg: 10, to: [k % 4, (k + 1) % 4] };
      rt.ytg = Math.min(rt.ytg, rt.yl);
      ['spike', 'kneel', 'fg', 'punt', 'timeout'].forEach((p, j) => {
        for (let s = 0; s < 3; s++) {
          const before = JSON.parse(JSON.stringify(rt)), tag = `spot ${si} t${t} ${running ? 'running' : 'stopped'} ${p} s${s}`;
          const action = p === 'timeout' ? { to_off: true } : { to_off: false, play: p };
          if (s === 1 && running && p !== 'timeout') action.to_def = true;        // their timeout first
          const r = sim.step(rt, { action, seed: si * 7 + k * 131 + j * 17 + s });
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
          : { to_off: false, play: P.calls[ci].kind, call: calls[ci], oob: n % 2 === 0, tempo: cur.clock_running ? ['urgent', 'hurry', 'normal', 'milk'][n % 4] : undefined };
      } else if (cur.phase === 0) action = { to_def: n % 5 === 0, def: n % 4 ? ['blitz', 'load', 'soft'][n % 3] : undefined };
      else if (cur.phase === 1 && cur.pos === me) action = { pat: n % 3 ? 'xp' : 'two' };
      else if (cur.phase === 2 && cur.pos === me) action = { kick: ['return', 'touchback', 'onside', 'deep'][(n + g) % 4] };
      const before = JSON.parse(JSON.stringify(cur));
      const r = sim.step(cur, { action, seed: 77 + si * 31 + g * 101 + n });
      steps++;
      check(before, r, `game ${si}.${g} step ${n}`);
      attrib(before, r, `game ${si}.${g} step ${n}`);
      if (cur.pos === me) honored(before, action, r, `game ${si}.${g} step ${n}`);
      if (action.kick) kickCheck(r, action.kick, `game ${si}.${g} step ${n}`, before.free_kick);
      if (action.def) lookHit(r, { blitz: 10, load: 4, soft: 1 }[action.def]);
      cur = r.root;
      if (r.done) break;
    }
    if (n >= 400) stuck++;
    games++;
  }
});
console.log(`${steps} steps, ${games} games (${stuck} never ended) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log('seen:', JSON.stringify(seen));
const keys = Object.keys(bad);
if (!keys.length) console.log('NO VIOLATIONS');
keys.forEach((k) => { console.log(`VIOLATION ${k}: ${bad[k].n}`); bad[k].forEach((m) => console.log('   ', m)); });
if (keys.length) process.exit(1);
