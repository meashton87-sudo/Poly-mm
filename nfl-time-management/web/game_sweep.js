// Engine sweep for the daily game: every spot x every call x tempo x seeds, then whole games from every spot,
// checking the football on every step (clock, scores, downs, distances, yard lines, touchdowns, safeties).
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
function scen(sp) {
  const H = idx.teams[sp.home], A = idx.teams[sp.away];
  return { home: H, away: A, home_spread: (idx.hfa || 1.5) + (H.power || 0) - (A.power || 0), indoor: sp.indoor, wind: sp.wind,
    temp: sp.temp, league: idx.league, home_coach: H.coach, away_coach: A.coach, season: idx.asof.season };
}
function rootOf(sp) {
  const st = sp.start;
  return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sp.home ? 0 : 1,
    score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]],
    clock_running: st.running, phase: 0, credit: 0, free_kick: false };
}
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
    if (e.kind === 0 && !e.penalty && !/fumble|bad_snap/.test(ev) && y < -15) flag('run lost 15+', `${tag} ${y} ${calls[e.call] || 'core'} ${ev}`);
    if (e.kind === 1 && /sack/.test(ev) && (y > 0 || y < -30)) flag('odd sack', `${tag} ${y}`);
    if (e.incomplete && y !== 0 && !e.penalty) flag('incomplete with yards', `${tag} ${y}`);
  }
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
        const r = sim.step(rt, { action: { to_off: false, play: P.calls[ci].kind, call: id, oob: s % 3 === 0, tempo: rt.clock_running ? tempo : undefined }, seed: si * 1000 + ci * 37 + s * 7919 + vi });
        steps++;
        check(before, r, `spot ${si} v${vi} ${id} s${s}`);
      }
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
        action = pick === 0 && cur.clock_running ? { to_off: true } : pick === 1 ? { to_off: false, play: 'spike' } : pick === 2 && cur.down === 4 && sim.fourthInfo(cur).pFg >= 0.05 ? { to_off: false, play: 'fg' }
          : { to_off: false, play: P.calls[ci].kind, call: calls[ci], oob: n % 2 === 0, tempo: cur.clock_running ? ['urgent', 'hurry', 'normal', 'milk'][n % 4] : undefined };
      } else if (cur.phase === 0) action = { to_def: n % 5 === 0 };
      else if (cur.phase === 1 && cur.pos === me) action = { pat: n % 3 ? 'xp' : 'two' };
      else if (cur.phase === 2 && cur.pos === me) action = { kick: n % 4 ? 'deep' : 'onside' };
      const before = JSON.parse(JSON.stringify(cur));
      const r = sim.step(cur, { action, seed: 77 + si * 31 + g * 101 + n });
      steps++;
      check(before, r, `game ${si}.${g} step ${n}`);
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
