/* Two-Minute Drill: Hoops. The last two minutes of a real basketball game: you coach one team, possession by possession,
   against the clock, the bonus and the other bench, on a court where the ten men and the ball move. Every call is
   graded on win chance (simulating the rest of the game for every option, hoops_data.json: rates fit from two seasons
   of play-by-play), placed among typical coaches, and the real game's ending is shown beside yours. One spot a day
   (the schedule in the data), the same for everyone. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const STORE = 'tmd:hoops';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  const pad = (n) => String(n).padStart(2, '0');
  const clockText = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}` : Math.max(0, s).toFixed(1));
  const periodText = (p) => (p <= 4 ? `${p}${['st', 'nd', 'rd', 'th'][Math.min(p, 4) - 1]} quarter` : p === 5 ? 'Overtime' : `${p - 4}${p - 4 === 2 ? 'nd' : p - 4 === 3 ? 'rd' : 'th'} overtime`);
  const dayISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function hash(...parts) { let h = 2166136261 >>> 0; for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the engine: a late-game possession, the way the data says they go ----------------------------------------------
  // The offense picks an approach (what the player calls on offense), the defense an answer (what the player calls on
  // defense); the rest is the data's rates with small, basketball-logic modifiers for each approach (set once here, the
  // same for the grading and the game).
  const APPROACH = {
    quick: { label: 'Go now', sub: 'Push it, first good look', t: [2, 7], three: 0.3, p2: -0.03, p3: -0.02, to: 0.9, foul: 1.0 },
    work: { label: 'Work for a shot', sub: 'Run the offense, use the clock', t: [12, 22], three: null, p2: 0.02, p3: 0.01, to: 1.0, foul: 1.0 },
    three: { label: 'Hunt a three', sub: 'Everything for the three', t: [4, 12], three: 0.88, p2: 0, p3: -0.04, to: 0.9, foul: 0.7 },
    rim: { label: 'Attack the rim', sub: 'Drive it, draw the foul', t: [4, 11], three: 0.06, p2: 0.04, p3: 0, to: 1.1, foul: 2.0 },
    last: { label: 'Hold for the last shot', sub: 'Shoot with two or three left', t: null, three: null, p2: 0.01, p3: 0, to: 1.0, foul: 0.8 },
    tquick: { label: 'Timeout, then attack', sub: 'Advance the ball, set a play', t: [3, 8], three: 0.35, p2: 0.02, p3: 0.02, to: 0.85, foul: 1.1, timeout: true },
    tthree: { label: 'Timeout, set a three', sub: 'Advance it, draw up a three', t: [3, 8], three: 0.9, p2: 0, p3: -0.01, to: 0.85, foul: 0.7, timeout: true },
  };
  const DEFENSE = {
    straight: { label: 'Play it straight', sub: 'Defend the possession' },
    foul: { label: 'Foul right away', sub: 'Stop the clock, send them to the line' },
    press: { label: 'Press and trap', sub: 'Go for the steal, risk the easy one' },
  };
  const other = (s) => (s === 'home' ? 'away' : 'home');
  let L = null, T = null;                                   // the league's rates, the teams
  const rate = (team, k) => { const t = T[team]; const v = t && t[k]; return typeof v === 'number' && isFinite(v) ? 0.5 * v + 0.5 * L[k] : L[k]; };   // (a team's own rate, half-weighted to the league's)
  const u = (r, a, b) => a + r() * (b - a);
  // NBA rules kept here: the bonus (5 team fouls in a period, or the 2nd team foul in the last two minutes), overtime 5:00
  // with 2 timeouts each, at most 2 timeouts in the last two minutes, a timeout in the last two minutes advances the
  // ball to the frontcourt, 14 on the shot clock after an offensive rebound, the shot clock off under 24 seconds
  const OT_SECS = 300, SHOT = 24, SHOT_OREB = 14;
  const inBonus = (S, def) => S.fouls[def] >= 5 || S.fouls2[def] >= 2;
  function newState(spot) {
    return { clock: spot.clock, period: spot.period, score: { home: spot.score[0], away: spot.score[1] }, poss: spot.poss, shot: spot.shotclock || SHOT,
      to: { home: Math.min(2, spot.timeouts[0]), away: Math.min(2, spot.timeouts[1]) }, fouls: { home: spot.fouls[0], away: spot.fouls[1] }, fouls2: { home: 0, away: 0 },
      home: spot.home, away: spot.away, me: spot.me === spot.home ? 'home' : 'away', dead: true, over: false };
  }
  const lead = (S, side) => S.score[side] - S.score[other(side)];
  const teamOf = (S, side) => (side === 'home' ? S.home : S.away);
  const teamCity = (abbr) => (T[abbr] && T[abbr].city) || abbr;
  // the real play-by-play's team events carry the nickname ("Heat Rebound", "SUNS Timeout"): shown by city, as everywhere
  const NICK = { Hawks: 'Atlanta', Celtics: 'Boston', Nets: 'Brooklyn', Hornets: 'Charlotte', Bulls: 'Chicago', Cavaliers: 'Cleveland', Mavericks: 'Dallas', Nuggets: 'Denver', Pistons: 'Detroit', Warriors: 'Golden State', Rockets: 'Houston', Pacers: 'Indiana', Clippers: 'Los Angeles (LAC)', Lakers: 'Los Angeles (LAL)', Grizzlies: 'Memphis', Heat: 'Miami', Bucks: 'Milwaukee', Timberwolves: 'Minnesota', Pelicans: 'New Orleans', Knicks: 'New York', Thunder: 'Oklahoma City', Magic: 'Orlando', '76ers': 'Philadelphia', Suns: 'Phoenix', 'Trail Blazers': 'Portland', Kings: 'Sacramento', Spurs: 'San Antonio', Raptors: 'Toronto', Jazz: 'Utah', Wizards: 'Washington' };
  const NICK_LOW = Object.fromEntries(Object.entries(NICK).map(([k, v]) => [k.toLowerCase(), v]));
  const NICK_RE = new RegExp(`\\b(${Object.keys(NICK).join('|')})\\b`, 'gi');
  const byCity = (text) => String(text || '').replace(NICK_RE, (m) => NICK_LOW[m.toLowerCase()] || m);
  const lastName = (n) => { const p = String(n || '').replace(/ (Jr\.|Sr\.|II|III|IV)$/, '').split(' '); return p[p.length - 1]; };
  // the five on the floor a side (the spot's names), and who takes the shots and the free throws among them (the team's
  // season shares where a man is in its list; a little for the rest)
  let FIVE = { home: [], away: [] };
  function shooter(S, side, kind, r) {
    const five = FIVE[side], t = T[teamOf(S, side)], ps = (t && t.players) || [];
    const key = kind === 3 ? 'att3' : kind === 'ft' ? 'fta' : 'att2';
    const w = five.map((n) => { const p = ps.find((x) => x.name === n); return 0.04 + (p ? p[key] || 0 : 0); });
    let x = r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < five.length; i++) { x -= w[i]; if (x <= 0) return i; }
    return 0;
  }
  // one free-throw trip: n shots; the last one missed is live
  function freeThrows(S, r, side, n, who, ev) {
    const p = rate(teamOf(S, side), 'ft'), made = [];
    for (let i = 0; i < n; i++) made.push(r() < p);
    const m = made.filter(Boolean).length;
    S.score[side] += m;
    const name = FIVE[side][who] || teamCity(teamOf(S, side));
    let reb = null;
    if (made[n - 1]) { S.poss = other(side); S.shot = SHOT; S.dead = true; }
    else if (r() < L.oreb_ft) { S.poss = side; S.shot = SHOT_OREB; S.dead = false; reb = 'off'; }
    else { S.poss = other(side); S.shot = SHOT; S.dead = false; S.clock = Math.max(0, S.clock - 1.5); reb = 'def'; }
    if (ev) ev.push({ k: 'ft', who, made, reb });
    const text = made[n - 1] ? `${name} makes ${m} of ${n} free throw${n > 1 ? 's' : ''}` : `${name} ${m ? `makes ${m} of ${n}, ` : ''}misses the last free throw, ${reb === 'off' ? 'the offense gets the rebound' : `${teamCity(teamOf(S, other(side)))} rebounds`}`;
    return { text, m, n };
  }
  // one possession of side S.poss with the offense's approach a and the defense's answer d; returns its lines, and when
  // ev is given the steps the court draws
  function possession(S, r, a, d, ev) {
    const off = S.poss, def = other(off), A = APPROACH[a], lines = [], clock0 = S.clock, five = FIVE[off];
    const name = (i) => five[i] || teamCity(teamOf(S, off));
    const bring = S.dead;
    if (ev) ev.push({ k: 'start', a, d });
    if (A.timeout && S.to[off] > 0) { S.to[off]--; if (ev) ev.push({ k: 'timeout', side: off }); lines.push(`${teamCity(teamOf(S, off))} calls timeout, the ball comes to the frontcourt`); }
    if (ev) ev.push({ k: bring ? 'bring' : 'live', advanced: !!A.timeout });
    // a foul before the shot: the defense stopping the clock (in the bonus: two free throws; else the ball inbounded with a second gone)
    if (d === 'foul') {
      const t = u(r, 0.5, 2.5); S.clock = Math.max(0, S.clock - t); S.fouls[def]++; S.fouls2[def]++;
      const who = 0;
      if (inBonus(S, def)) { if (ev) ev.push({ k: 'foul', on: who, early: true }); const ft = freeThrows(S, r, off, 2, who, ev); lines.push(`${teamCity(teamOf(S, def))} fouls on purpose: ${ft.text}`); return done(); }
      if (ev) ev.push({ k: 'foul', on: who, early: true, inbound: true });
      lines.push(`${teamCity(teamOf(S, def))} fouls on purpose, not in the bonus yet: ${teamCity(teamOf(S, off))} inbounds again`); S.dead = true; return done();
    }
    // when the shot goes up
    let t;
    if (a === 'last') t = Math.max(1, S.clock - u(r, 1.5, 4));
    else t = u(r, A.t[0], A.t[1]);
    const press = d === 'press';
    if (press) t = Math.max(1, t - 1);
    t = Math.min(t, S.shot, S.clock);
    const toP = L.to * A.to * (press ? 1.6 : 1);
    if (r() < toP) {
      S.clock = Math.max(0, S.clock - u(r, 1, t));
      const who = Math.floor(r() * 5), steal = r() < 0.6;
      if (ev) ev.push({ k: 'turnover', who, steal });
      lines.push(`${name(who)} turns it over${press ? ' against the press' : steal ? ', stolen' : ''}`); S.poss = def; S.shot = SHOT; S.dead = false; return done();
    }
    S.clock = Math.max(0, S.clock - t);
    const need = lead(S, off);                                 // (a team down three with no time hunts the three whatever was called)
    let three = A.three == null ? rate(teamOf(S, off), 'share3') : A.three;
    if (S.clock <= 0 && need < 0 && need >= -3 && a !== 'three') three = need === -3 ? 0.95 : three;
    const isThree = r() < three, kind = isThree ? 3 : 2, who = shooter(S, off, kind, r);
    const passes = a === 'work' ? 2 + Math.floor(r() * 2) : a === 'quick' || a === 'rim' ? (r() < 0.5 ? 1 : 0) : a === 'last' ? 1 + Math.floor(r() * 2) : 1;
    const drive = !isThree && (a === 'rim' || a === 'quick' || r() < 0.5);
    const foulP = (isThree ? L.foul3 : L.foul2) * A.foul;
    if (r() < foulP) {
      S.fouls[def]++; S.fouls2[def]++;
      if (!isThree && r() < L.and1) {
        S.score[off] += 2;
        if (ev) ev.push({ k: 'shot', who, three: false, drive: true, passes, made: true, and1: true, secs: t });
        const ft = freeThrows(S, r, off, 1, who, ev); lines.push(`${name(who)} scores through the foul, and one: ${ft.m ? 'makes' : 'misses'} the free throw`); return done();
      }
      if (ev) ev.push({ k: 'shot', who, three: isThree, drive, passes, made: false, fouled: true, secs: t });
      const ft = freeThrows(S, r, off, isThree ? 3 : 2, who, ev); lines.push(`${name(who)} is fouled ${isThree ? 'on a three' : 'going up'}: ${ft.text}`); return done();
    }
    let p = rate(teamOf(S, off), isThree ? 'p3' : 'p2') + (isThree ? A.p3 : A.p2) + (press ? 0.03 : 0);
    if (r() < p) {
      S.score[off] += kind;
      if (ev) ev.push({ k: 'shot', who, three: isThree, drive, passes, made: true, secs: t });
      lines.push(`${name(who)} ${isThree ? 'hits the three' : drive ? 'scores at the rim' : 'hits the jumper'}`); S.poss = def; S.shot = SHOT; S.dead = true; return done();
    }
    if (S.clock <= 0) { if (ev) ev.push({ k: 'shot', who, three: isThree, drive, passes, made: false, horn: true, secs: t }); lines.push(`${name(who)} misses ${isThree ? 'the three' : 'the shot'} at the horn`); return done(); }
    const oreb = r() < rate(teamOf(S, off), 'oreb'), rebBy = Math.floor(r() * 5);
    if (ev) ev.push({ k: 'shot', who, three: isThree, drive, passes, made: false, secs: t, reb: oreb ? 'off' : 'def', rebBy });
    if (oreb) { S.shot = SHOT_OREB; S.dead = false; S.clock = Math.max(0, S.clock - u(r, 1, 2.5)); lines.push(`${name(who)} misses ${isThree ? 'the three' : 'the shot'}, ${name(rebBy)} gets the offensive rebound`); return done(); }
    S.poss = def; S.shot = SHOT; S.dead = false; S.clock = Math.max(0, S.clock - u(r, 0.5, 1.5));
    lines.push(`${name(who)} misses ${isThree ? 'the three' : 'the shot'}, ${teamCity(teamOf(S, def))} rebounds`);
    return done();
    function done() { if (ev) ev.push({ k: 'end', secs: clock0 - S.clock, clock0, clock1: S.clock }); return lines; }
  }
  // the period's end: tied, overtime; else over
  function endOfPeriod(S) {
    if (S.score.home === S.score.away) { S.period++; S.clock = OT_SECS; S.fouls = { home: 0, away: 0 }; S.fouls2 = { home: 0, away: 0 }; S.to = { home: 2, away: 2 }; S.shot = SHOT; S.dead = true; return `Tied at the end of the ${periodText(S.period - 1).toLowerCase()}: overtime`; }
    S.over = true; return null;
  }
  // what a typical coach calls (the opponent's bench, the simulations' both benches, and the mix the score is measured against)
  function typicalOffense(S, r) {
    const off = S.poss, ld = lead(S, off), c = S.clock, opts = offenseOptions(S), pick = (k) => (opts.includes(k) ? k : opts[0]);
    const w = {};
    if (ld < 0) {
      if (c <= 8) { w.three = ld <= -3 ? 0.9 : 0.35; w.quick = ld <= -3 ? 0.1 : 0.55; w.rim = ld === -1 || ld === -2 ? 0.1 : 0; }
      else if (c <= 30) { w.quick = 0.45; w.rim = 0.2; w.three = ld <= -3 ? 0.25 : 0.1; w.work = 0.1; if (S.dead && S.to[off] > 0) { w.tquick = 0.35; w.tthree = ld <= -3 ? 0.2 : 0.05; } }
      else { w.work = 0.5; w.quick = 0.25; w.rim = 0.15; w.three = 0.1; }
    } else if (ld === 0) {
      if (c <= SHOT + 4) { w.last = 0.75; w.work = 0.2; w.rim = 0.05; } else { w.work = 0.7; w.rim = 0.15; w.quick = 0.15; }
    } else {
      if (c <= SHOT + 4) { w.last = 0.8; w.work = 0.2; } else { w.work = 0.85; w.rim = 0.1; w.quick = 0.05; }
    }
    return { weights: w, pick: pick(weighted(w, r, opts)) };
  }
  function typicalDefense(S, r) {
    const def = other(S.poss), ld = lead(S, def), c = S.clock, w = {};
    if (ld < 0 && ld >= -8 && c <= 30) { const p = c <= 18 ? Math.max(0.6, L.foul_trailing) : L.foul_trailing * 0.6; w.foul = p; w.straight = 1 - p; }
    else if (ld === 3 && c <= 12) { w.foul = L.foul_up3; w.straight = 1 - L.foul_up3; }
    else if (ld < 0 && c <= 45) { w.press = 0.15; w.straight = 0.85; }
    else { w.straight = 1; }
    return { weights: w, pick: weighted(w, r, Object.keys(DEFENSE)) };
  }
  function weighted(w, r, allowed) {
    const ks = Object.keys(w).filter((k) => allowed.includes(k) && w[k] > 0), tot = ks.reduce((a, k) => a + w[k], 0);
    if (!tot) return allowed[0];
    let x = r() * tot; for (const k of ks) { x -= w[k]; if (x <= 0) return k; } return ks[ks.length - 1];
  }
  // the options the player has: on offense by the spot (a timeout only on a dead ball with one left; the last shot only
  // when the game clock is the shot clock); on defense always the three
  function offenseOptions(S) {
    const off = S.poss, out = ['quick', 'work', 'three', 'rim'];
    if (S.clock <= SHOT + 6) out.push('last');
    if (S.dead && S.to[off] > 0 && S.clock > 2) out.push('tquick', 'tthree');
    if (S.clock <= 3) return ['quick', 'three', 'rim'].concat(S.dead && S.to[off] > 0 ? ['tquick', 'tthree'] : []);
    return out;
  }
  // play the rest of the game from S with both benches typical (the simulation behind every grade); returns 1 for a win
  function playOut(S, r, first) {
    let guard = 0;
    while (!S.over && guard++ < 200) {
      if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) break; }
      let a, d;
      if (first) { a = first.a || typicalOffense(S, r).pick; d = first.d || typicalDefense(S, r).pick; first = null; }
      else { a = typicalOffense(S, r).pick; d = typicalDefense(S, r).pick; }
      possession(S, r, a, d, null);
      if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) break; }
    }
    if (!S.over) S.over = true;
    return lead(S, S.me) > 0 ? 1 : 0;
  }
  const clone = (S) => ({ ...S, score: { ...S.score }, to: { ...S.to }, fouls: { ...S.fouls }, fouls2: { ...S.fouls2 } });
  // win chance of each option from S, N games each, the same seeds for every option (the same bounces, only the call differs)
  function evaluate(S, side, options, seed, N) {
    const out = {};
    for (const k of options) {
      let w = 0;
      for (let i = 0; i < N; i++) { const r = rng(hash(seed, k, i)), C = clone(S); w += playOut(C, r, side === 'off' ? { a: k } : { d: k }); }
      out[k] = w / N;
    }
    return out;
  }
  const N_EVAL = 1200;

  // ---- the court: the full floor, sideways, a camera on the ball, ten men and the ball ----------------------------------
  // Feet. The floor is X 0 to 94 down its length (the baskets at 5.25 and 88.75) and Y 0 to 50 across. The view is a
  // camera VIEW feet wide that follows the ball. The play is written in the offense's own frame, (u, v): u across the
  // court (0 to 50), v toward the basket it attacks (47 the baseline, negative the backcourt); court.dir says which
  // basket (+1 the right one: your team attacks right all game) and world() puts it on the floor. Every live phase runs
  // at real time (MS_PER_SEC of real time a second of game clock), the clock on the board running evenly; dead-ball
  // moments (a timeout, the line, a whistle) take their own time with the clock stopped. The offense runs the late-game
  // actions real benches run (the pick-and-roll, a screen for the shooter, the push in transition, the isolation for a
  // last shot, the set out of a timeout); the defense follows on its own, each man between his man and the rim, shading
  // toward the ball, getting back in transition, trapping the ball in a press, sliding at a man's speed.
  const W = 50, H = 47, LEN = 94, RIM = { x: 25, y: H - 5.25 }, R3 = 23.75, VIEW = 62;
  const SPOTS = [[25, 13], [9, 22], [41, 22], [7, 38], [43, 38]];          // the set: the point, two wings, two corners
  const BACK = [[25, -41], [11, -33], [39, -33], [17, -45], [33, -45]];    // the backcourt after a score: the point, the wings ahead, the bigs behind
  const MS_PER_SEC = 1000, SPEED = 20, SLIDE = 14;
  const court = { svg: null, dir: 1, off: null, auto: true, press: false, trap: -1, dots: { home: [], away: [] }, pos: { home: [], away: [] }, pin: { home: [], away: [] }, spot: [0, 1, 2, 3, 4],
    bpos: [25, 13, 0], handler: null, ball: null, shadow: null, badge: null, nets: [], clock: 0, jump: null, cam: 47 };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const toward = (a, b, d) => { const l = dist(a, b) || 1; return [a[0] + (b[0] - a[0]) / l * d, a[1] + (b[1] - a[1]) / l * d]; };
  const onCourt = ([x, y]) => [Math.min(W - 1.5, Math.max(1.5, x)), Math.min(H - 1.6, Math.max(-(H - 1.6), y))];
  const hand = ([x, y]) => [x + 0.9, y + 0.3];
  const world = ([u, v]) => (court.dir > 0 ? [47 + v, u] : [47 - v, W - u]);
  const flip = ([u, v]) => [W - u, -v];
  const RIMW = () => world([RIM.x, RIM.y]);
  function drawCourt() {
    const s = $('court'); s.textContent = '';
    s.append(svgEl('rect', { x: -4, y: -4, width: LEN + 8, height: W + 8, class: 'apron' }));
    s.append(svgEl('rect', { x: 0, y: 0, width: LEN, height: W, class: 'wood' }));
    const line = (a) => s.append(svgEl('path', { d: a, class: 'ln' }));
    line(`M0 0 H${LEN} V${W} H0 Z`);
    line(`M47 0 V${W}`); s.append(svgEl('circle', { cx: 47, cy: 25, r: 6, class: 'ln' }));
    for (const end of [0, 1]) {                                            // each end: the lane, the circle, the three-point line, the board, the rim
      const X = (x) => (end ? LEN - x : x), sw = end ? 0 : 1;
      line(`M${X(0)} 17 H${X(19)} V33 H${X(0)}`);
      s.append(svgEl('circle', { cx: X(19), cy: 25, r: 6, class: 'ln' }));
      line(`M${X(0)} 3 H${X(14.2)} A${R3} ${R3} 0 0 ${sw} ${X(14.2)} 47 H${X(0)}`);
      s.append(svgEl('path', { d: `M${X(4)} 22 V28`, class: 'ln board' }));
      s.append(svgEl('circle', { cx: X(5.25), cy: 25, r: 0.75, class: 'rim' }));
      const n = svgEl('path', { d: `M${X(5.25)} 24.3 L${X(5.25) + (end ? 1.3 : -1.3)} 24.55 L${X(5.25) + (end ? 1.3 : -1.3)} 25.45 L${X(5.25)} 25.7`, class: 'net' });
      s.append(n); court.nets[end] = n;
    }
    for (const side of ['home', 'away']) {
      court.dots[side] = []; court.pin[side] = [false, false, false, false, false];
      for (let i = 0; i < 5; i++) {
        const g = svgEl('g', { class: `man ${side === S.me ? 'me' : 'them'}` });
        g.append(svgEl('circle', { r: 1.35 }), svgEl('text', { y: -1.9, 'text-anchor': 'middle' }));
        g.querySelector('text').textContent = lastName(FIVE[side][i] || '');
        s.append(g); court.dots[side].push(g);
      }
    }
    court.shadow = svgEl('ellipse', { rx: 0.7, ry: 0.35, class: 'shadow' }); s.append(court.shadow);
    court.ball = svgEl('circle', { r: 0.6, class: 'ball' }); s.append(court.ball);
    court.badge = svgEl('text', { x: 47, y: 9, 'text-anchor': 'middle', class: 'badge' }); s.append(court.badge);
    court.svg = s; court.clock = S.clock;
    setPositions(S.poss, false);
    place();
  }
  // the offense in its set (or in its backcourt, a score just against it), the handler the point; the defense on its men
  function setPositions(off, backcourt) {
    const def = other(off), at = backcourt ? BACK : SPOTS;
    court.dir = off === S.me ? 1 : -1; court.off = off; court.auto = true; court.press = false; court.spot = [0, 1, 2, 3, 4]; court.handler = { side: off, i: 0 }; court.jump = null;
    court.pin[off] = [false, false, false, false, false]; court.pin[def] = [false, false, false, false, false];
    for (let i = 0; i < 5; i++) court.pos[off][i] = at[i].slice();
    court.bpos = [...hand(court.pos[off][0]), 0];
    for (let i = 0; i < 5; i++) court.pos[def][i] = guardTarget(def, i);
    court.cam = world([court.bpos[0], court.bpos[1]])[0];
  }
  // where a defender wants to be: between his man and the rim, tight on the ball, a step toward it off the ball; ahead
  // of his man getting back while the ball is in the backcourt; in a press, on the ball the length of the floor and a
  // second man trapping it as it nears midcourt
  function guardTarget(def, i) {
    const off = other(def), man = court.pos[off][i], h = court.handler, onBall = h && h.side === off && h.i === i, ball = [court.bpos[0], court.bpos[1]];
    if (court.press) {
      if (onBall) return onCourt(toward(man, [RIM.x, RIM.y], 2.5));
      if (i === court.trap && ball[1] > -22) return onCourt([ball[0] + (ball[0] < 25 ? 2.6 : -2.6), ball[1] + 1.2]);
      return onCourt(toward(man, [RIM.x, RIM.y], 3.5));
    }
    let p = toward(man, [RIM.x, RIM.y], onBall ? 3 : 4.5);
    if (!onBall) p = toward(p, ball, 1.5);
    if (man[1] < 4) p = [p[0], Math.max(p[1], Math.min(26, man[1] + 16))];
    return onCourt(p);
  }
  // draw everyone, the camera easing after the ball; dt the milliseconds since the last frame (none: all put in place)
  function place(dt) {
    if (court.auto && court.off) {
      const def = other(court.off), step = dt == null ? 1e9 : SLIDE * dt / 1000;
      for (let i = 0; i < 5; i++) {
        if (court.pin[def][i]) continue;
        const t = guardTarget(def, i), p = court.pos[def][i], d = dist(p, t);
        court.pos[def][i] = d <= step ? t : toward(p, t, step);
      }
    }
    const bw = world([court.bpos[0], court.bpos[1]]);
    const camT = Math.min(LEN - VIEW / 2 + 3, Math.max(VIEW / 2 - 3, bw[0]));
    court.cam = dt == null ? camT : court.cam + (camT - court.cam) * Math.min(1, dt / 320);
    court.svg.setAttribute('viewBox', `${(court.cam - VIEW / 2).toFixed(2)} -3 ${VIEW} ${W + 6}`);
    court.badge.setAttribute('x', court.cam.toFixed(2));
    for (const side of ['home', 'away']) court.dots[side].forEach((g, i) => {
      const [x, y] = world(court.pos[side][i]);
      g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      g.lastChild.setAttribute('y', side === court.off ? -1.9 : 3.4);
      const j = court.jump, up = j && j.side === side && j.i === i ? Math.sin(Math.PI * Math.min(1, (performance.now() - j.t0) / j.ms)) : 0;
      g.firstChild.setAttribute('r', (1.35 * (1 + 0.3 * Math.max(0, up))).toFixed(2));
      if (j && j.side === side && j.i === i && performance.now() - j.t0 >= j.ms) court.jump = null;
    });
    const bz = court.bpos[2];
    court.ball.setAttribute('cx', bw[0].toFixed(2)); court.ball.setAttribute('cy', (bw[1] - bz).toFixed(2)); court.ball.setAttribute('r', (0.6 + Math.max(0, bz) * 0.05).toFixed(2));
    court.shadow.setAttribute('cx', bw[0].toFixed(2)); court.shadow.setAttribute('cy', bw[1].toFixed(2)); court.shadow.setAttribute('rx', (0.7 + Math.max(0, bz) * 0.08).toFixed(2));
  }
  // one segment of the timeline: men on paths (a line, or a curve through `via`, each after its `delay`), the ball with a
  // man (dribbled or held) or in flight to a point with an arc, the clock running `secs` evenly, all over `ms`; a tap
  // on the court ends it at once. Positions and paths are in the offense's frame.
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2);
  const bez = (a, v, b, t) => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * v[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * v[1] + t * t * b[1]];
  const dur = (secs, feet) => Math.max(secs * MS_PER_SEC, ((feet || 0) / SPEED) * 1000, 260);
  let skipNow = false;
  function tween(seg) {
    return new Promise((resolve) => {
      const from = { home: court.pos.home.map((p) => p.slice()), away: court.pos.away.map((p) => p.slice()) }, b0 = court.bpos.slice(), c0 = court.clock;
      const ms = skipNow ? 0 : seg.ms, t0 = performance.now();
      let last = t0;
      for (const m of seg.moves || []) if (m.side !== court.off) court.pin[m.side][m.i] = true;
      if (seg.ball && seg.ball.with) court.handler = seg.ball.with;
      if (seg.ball && seg.ball.to) court.handler = null;
      const finish = () => {
        for (const m of seg.moves || []) court.pos[m.side][m.i] = m.to.slice();
        if (seg.ball && seg.ball.to) { court.bpos = [seg.ball.to[0], seg.ball.to[1], seg.ball.rest || 0]; if (seg.ball.catch) { court.handler = seg.ball.catch; court.bpos = [...hand(court.pos[seg.ball.catch.side][seg.ball.catch.i]), 0]; } }
        else if (court.handler) court.bpos = [...hand(court.pos[court.handler.side][court.handler.i]), 0];
        if (seg.secs) court.clock = Math.max(0, c0 - seg.secs);
        $('bclock').textContent = clockText(court.clock);
        place(skipNow ? null : 16);
        resolve();
      };
      const frame = (now) => {
        if (skipNow) return finish();
        const k = ms ? Math.min(1, (now - t0) / ms) : 1, dt = now - last; last = now;
        for (const m of seg.moves || []) {
          const d = m.delay ? Math.min(0.9, m.delay / seg.ms) : 0, kk = Math.min(1, Math.max(0, (k - d) / (1 - d))), e = ease(kk), f = from[m.side][m.i];
          court.pos[m.side][m.i] = m.via ? bez(f, m.via, m.to, e) : [f[0] + (m.to[0] - f[0]) * e, f[1] + (m.to[1] - f[1]) * e];
        }
        const b = seg.ball;
        if (b && b.to) { const z = (b.arc || 0) * 4 * k * (1 - k) + (b.rest || 0) * k; court.bpos = [b0[0] + (b.to[0] - b0[0]) * k, b0[1] + (b.to[1] - b0[1]) * k, z]; }
        else if (court.handler) { const [x, y] = hand(court.pos[court.handler.side][court.handler.i]); court.bpos = [x, y, !REDUCED && ((b && b.dribble) || seg.dribble) ? Math.abs(Math.sin((now - t0) / 1000 * Math.PI * 1.7)) * 1.1 : 0]; }
        if (seg.secs) { court.clock = Math.max(0, c0 - seg.secs * k); $('bclock').textContent = clockText(court.clock); }
        place(dt);
        if (k < 1) requestAnimationFrame(frame); else finish();
      };
      requestAnimationFrame(frame);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, skipNow ? 0 : ms));
  function badge(text, cls) { court.badge.textContent = text || ''; court.badge.setAttribute('class', `badge${cls ? ` ${cls}` : ''}`); }
  function caption(text) { $('cap').textContent = text || ''; }
  const swish = () => { const n = court.nets[court.dir > 0 ? 1 : 0]; n.classList.add('swish'); setTimeout(() => n.classList.remove('swish'), 700); };
  const nearest = (side, p) => court.pos[side].reduce((best, q, i) => (dist(q, p) < dist(court.pos[side][best], p) ? i : best), 0);
  const manAt = (spot) => court.spot.indexOf(spot);
  const nm = (side, i) => lastName(FIVE[side][i] || '');
  // the men of `off` to their set from wherever they are, the wings running the lanes ahead, the bigs trailing, the
  // handler dribbling up, over `secs` of clock
  function toSet(off, secs, partial) {
    const h = court.handler && court.handler.side === off ? court.handler.i : manAt(0);
    if (court.spot[h] !== 0) { const o = manAt(0); court.spot[o] = court.spot[h]; court.spot[h] = 0; }
    const moves = [0, 1, 2, 3, 4].map((i) => {
      const sp = court.spot[i], p = court.pos[off][i], to = SPOTS[sp].slice();
      if (partial) { to[0] = p[0] + (to[0] - p[0]) * partial; to[1] = p[1] + (to[1] - p[1]) * partial; }
      const lane = sp === 1 || sp === 2, via = lane && p[1] < 0 ? [sp === 1 ? 5 : 45, (p[1] + to[1]) / 2] : null;
      return { side: off, i, to, via, delay: sp === 0 ? 150 : lane ? 0 : 420 };
    });
    const far = Math.max(...moves.map((m) => dist(court.pos[off][m.i], m.to)));
    court.handler = { side: off, i: h }; court.auto = true; court.pin[other(off)] = [false, false, false, false, false];
    return tween({ ms: dur(secs, far), secs, moves, dribble: true });
  }
  // the ball changes hands: the frame turns to `side`'s basket, `who` has the ball. Dead (after a score): he steps out
  // behind the baseline to inbound, the point waits for it, the wings start up the floor. Live (a rebound, a steal): the
  // wings run, the point comes to the outlet.
  async function otherWay(side, who, dead) {
    const prev = other(side);
    for (const s of ['home', 'away']) court.pos[s] = court.pos[s].map(flip);
    court.bpos = [...flip(court.bpos), 0]; court.dir = -court.dir;
    court.off = side; court.handler = { side, i: who }; court.auto = true; court.press = false; court.jump = null;
    court.pin[side] = [false, false, false, false, false]; court.pin[prev] = [false, false, false, false, false];
    const pg = (() => { const p = manAt(0); return p >= 0 && p !== who ? p : [0, 1, 2, 3, 4].find((i) => i !== who); })();
    const rest = [0, 1, 2, 3, 4].filter((i) => i !== who && i !== pg);
    court.spot = []; court.spot[pg] = 0; court.spot[who] = dead ? 4 : 3; rest.forEach((i, n) => { court.spot[i] = [1, 2, dead ? 3 : 4][n]; });
    const moves = [0, 1, 2, 3, 4].map((i) => {
      const sp = court.spot[i];
      if (i === who) return { side, i, to: dead ? [court.pos[side][i][0] < 25 ? 21 : 29, -49.5] : court.pos[side][i].slice() };
      if (sp === 0) return { side, i, to: dead ? BACK[0].slice() : [court.pos[side][who][0] < 25 ? 9 : 41, -31], delay: 100 };
      return { side, i, to: BACK[sp].slice(), delay: sp < 3 ? 0 : 250 };
    });
    await tween({ ms: dead ? 1700 : 1300, moves, dribble: !dead });
  }
  // the outlet or the inbound to the point, then up the floor
  async function bringUp(off, secs, partial) {
    const h = court.handler ? court.handler.i : manAt(0), pg = manAt(0);
    if (h !== pg && pg >= 0) {
      caption(`${nm(off, h)} to ${nm(off, pg)}`);
      await tween({ ms: 380 + 22 * dist(court.pos[off][h], court.pos[off][pg]), ball: { to: hand(court.pos[off][pg]), arc: 0.5, catch: { side: off, i: pg } } });
    }
    caption(`${nm(off, pg >= 0 ? pg : h)} brings it up`);
    await toSet(off, secs, partial);
  }
  // ---- the half-court actions ----------------------------------------------------------------------------------------
  const pass = async (off, from, to, secs) => {
    caption(`${nm(off, from)} to ${nm(off, to)}`);
    await tween({ ms: 380 + 22 * dist(court.pos[off][from], court.pos[off][to]), secs: secs || 0, ball: { to: hand(court.pos[off][to]), arc: 0.4, catch: { side: off, i: to } } });
  };
  // the handler probes with the dribble while the men off the ball relocate: a corner lifts, a wing drops, a cut through the lane
  async function probe(off, secs) {
    const h = court.handler.i, steps = Math.max(1, Math.min(3, Math.round(secs / 1.1)));
    for (let k = 0; k < steps; k++) {
      const hp = court.pos[off][h], dx = (k % 2 ? -1 : 1) * (2.5 + Math.random() * 2);
      const moves = [{ side: off, i: h, to: onCourt([hp[0] + dx, hp[1] + (Math.random() - 0.5) * 2]) }];
      const others = [0, 1, 2, 3, 4].filter((i) => i !== h);
      const a = others[Math.floor(Math.random() * others.length)], sa = court.spot[a];
      if (sa >= 3 && Math.random() < 0.5) { const sb = sa === 3 ? 4 : 3, b = manAt(sb); if (b >= 0 && b !== h) { court.spot[a] = sb; court.spot[b] = sa; moves.push({ side: off, i: a, to: SPOTS[sb].slice(), via: [25, 34] }, { side: off, i: b, to: SPOTS[sa].slice(), via: [25, 20], delay: 200 }); } }
      else { const [su, sv] = SPOTS[sa]; moves.push({ side: off, i: a, to: onCourt([su + (su < 25 ? 1 : -1) * (Math.random() * 4 - 1), sv + (sa <= 2 ? -2 : -5) + Math.random() * 3]) }); }
      await tween({ ms: dur(secs / steps, 0), secs: secs / steps, moves, dribble: true });
    }
  }
  // the pick-and-roll: the big sets it beside the handler's man, the handler comes off it to the elbow, the big rolls to
  // the rim, the weak side lifts; ends with the ball at the elbow (or, `who` the big, the pocket pass to the roller)
  async function pickAndRoll(off, secs, who) {
    const h = court.handler.i, b = [manAt(2), manAt(4), manAt(1), manAt(3)].find((i) => i >= 0 && i !== h && i !== who) ?? [0, 1, 2, 3, 4].find((i) => i !== h);
    const hp = court.pos[off][h], side = court.pos[off][b][0] >= 25 ? 1 : -1;
    const screen = [hp[0] + side * 3.2, hp[1] + 1.4];
    const weakCorner = manAt(side > 0 ? 3 : 4), weakWing = manAt(side > 0 ? 1 : 2);
    caption(`${nm(off, b)} comes to set the screen`);
    const lift = [];
    if (weakCorner >= 0 && weakCorner !== h) lift.push({ side: off, i: weakCorner, to: [side > 0 ? 7 : 43, 26], delay: 300 });
    if (weakWing >= 0 && weakWing !== h) lift.push({ side: off, i: weakWing, to: [side > 0 ? 12 : 38, 12], delay: 300 });
    await tween({ ms: dur(secs * 0.4, dist(court.pos[off][b], screen)), secs: secs * 0.4, moves: [{ side: off, i: b, to: screen }, { side: off, i: h, to: [hp[0] - side * 1.2, hp[1] - 0.6] }].concat(lift), dribble: true });
    caption(`${nm(off, h)} comes off the screen`);
    const elbow = [25 + side * 6.5, 27], roll = [25 - side * 1.5, 39];
    await tween({ ms: dur(secs * 0.6, 16), secs: secs * 0.6, moves: [{ side: off, i: h, to: elbow, via: [screen[0] + side * 2.6, screen[1] + 2.5] }, { side: off, i: b, to: roll, via: [screen[0] - side * 1.5, screen[1] + 7], delay: 250 }], dribble: true });
    return { h, b };
  }
  // a screen away from the ball for the shooter: he starts in the corner, the big screens his man at the wing, he comes
  // off it to the wing above the break and the pass meets him there
  async function pinDown(off, secs, who) {
    const h = court.handler.i;
    let sp = court.spot[who];
    if (sp < 3) { const c = Math.random() < 0.5 ? 3 : 4, m = manAt(c); if (m >= 0 && m !== h) { court.spot[m] = sp; court.spot[who] = c; await tween({ ms: dur(secs * 0.3, 20), secs: secs * 0.3, moves: [{ side: off, i: who, to: SPOTS[c].slice(), via: [25, 30] }, { side: off, i: m, to: SPOTS[sp].slice(), via: [25, 18], delay: 150 }], dribble: true }); secs *= 0.7; sp = c; } }
    const side = SPOTS[sp][0] < 25 ? -1 : 1, b = [manAt(side < 0 ? 1 : 2), manAt(side < 0 ? 4 : 3), manAt(side < 0 ? 2 : 1)].find((i) => i >= 0 && i !== h && i !== who);
    const screen = [25 + side * 17, 29];
    caption(`${nm(off, b)} screens for ${nm(off, who)}`);
    await tween({ ms: dur(secs * 0.45, dist(court.pos[off][b], screen)), secs: secs * 0.45, moves: [{ side: off, i: b, to: screen }], dribble: true });
    const out = [25 + side * 15, 15];
    caption(`${nm(off, who)} comes off it`);
    await tween({ ms: dur(secs * 0.55, 24), secs: secs * 0.55, moves: [{ side: off, i: who, to: out, via: [25 + side * 20, 26] }, { side: off, i: b, to: [25 + side * 4, 40], via: [25 + side * 12, 36], delay: 500 }], dribble: true });
    return { h, b };
  }
  // the isolation: everyone clears to the corners and the deep wings, the handler works his man at the top
  async function isolation(off, secs) {
    const h = court.handler.i, moves = [];
    for (const i of [0, 1, 2, 3, 4]) if (i !== h) { const sp = court.spot[i]; moves.push({ side: off, i, to: [[25, 10], [4, 31], [46, 31], [6, 43], [44, 43]][sp] || SPOTS[sp], delay: 100 * sp }); }
    caption(`${nm(off, h)} works at the top`);
    await tween({ ms: dur(Math.min(secs * 0.3, 1.5), 12), secs: Math.min(secs * 0.3, 1.5), moves, dribble: true });
    const left = secs - Math.min(secs * 0.3, 1.5), steps = Math.max(2, Math.min(4, Math.round(left / 1.2)));
    for (let k = 0; k < steps; k++) { const hp = court.pos[off][h]; await tween({ ms: dur(left / steps, 0), secs: left / steps, moves: [{ side: off, i: h, to: onCourt([hp[0] + (k % 2 ? -3.5 : 3.5), hp[1] + (k === steps - 1 ? 2.5 : 0)]) }], dribble: true }); }
  }
  // out of a timeout: the inbound from the sideline at the frontcourt into a set: a stagger screen for the shooter, or
  // the point taking it into the pick-and-roll
  async function afterTimeout(off, three, who) {
    const inb = manAt(1) >= 0 ? manAt(1) : 1, pg = manAt(0) !== inb ? manAt(0) : manAt(2), sh = who != null && who !== inb && who !== pg ? who : manAt(3) !== inb ? manAt(3) : manAt(4);
    const others = [0, 1, 2, 3, 4].filter((i) => i !== inb && i !== pg && i !== sh);
    court.handler = { side: off, i: inb }; court.auto = true;
    const moves = [{ side: off, i: inb, to: [-1.8, 19] }, { side: off, i: pg, to: [13, 13] }, { side: off, i: sh, to: [7, 40] }, { side: off, i: others[0], to: [19, 28] }, { side: off, i: others[1], to: [43, 36] }];
    court.spot = []; court.spot[inb] = 1; court.spot[pg] = 0; court.spot[sh] = 3; court.spot[others[0]] = 2; court.spot[others[1]] = 4;
    caption('The ball comes in at the sideline');
    await tween({ ms: 1500, moves });
    await wait(400);
    await pass(off, inb, pg, 0);
    if (three) {
      caption(`${nm(off, sh)} comes off the staggered screens`);
      await tween({ ms: dur(2.2, 30), secs: 2.2, moves: [{ side: off, i: sh, to: [27, 11], via: [12, 24] }, { side: off, i: others[0], to: [12, 26], delay: 200 }, { side: off, i: inb, to: [8, 24], delay: 400 }], dribble: true });
      await pass(off, pg, sh, 0.4);
    } else {
      await tween({ ms: 900, secs: 0.9, moves: [{ side: off, i: inb, to: [8, 26] }], dribble: true });
    }
  }
  // the shooter gets the ball: a kick-out or a swing to him if he does not have it
  async function ballTo(off, who, secs) { const h = court.handler ? court.handler.i : manAt(0); if (h !== who) await pass(off, h, who, secs); }
  // play a possession's steps on the court
  async function animate(ev, off, lines) {
    skipNow = false;
    const def = other(off), dname = (i) => nm(off, i);
    const endEv = ev.find((e) => e.k === 'end') || { clock0: S.clock, clock1: S.clock }, startEv = ev.find((e) => e.k === 'start') || {};
    const A = startEv.a || 'work';
    court.clock = endEv.clock0; $('bclock').textContent = clockText(court.clock);
    let left = Math.max(0, endEv.clock0 - endEv.clock1);                       // the game seconds this possession took, spent phase by phase
    const spend = (s) => { s = Math.max(0, Math.min(s, left)); left -= s; return s; };
    const last = () => lines[lines.length - 1];
    const hold = async (ms) => { await wait(ms); badge(''); };
    const nextIs = (idx, k) => ev[idx + 1] && ev[idx + 1].k === k;
    for (let idx = 0; idx < ev.length; idx++) {
      const e = ev[idx];
      if (e.k === 'start') {
        court.press = startEv.d === 'press';
        if (court.press) { const h = court.handler && court.handler.side === off ? court.handler.i : 0; court.trap = [0, 1, 2, 3, 4].filter((i) => i !== h).reduce((a, i) => (dist(court.pos[off][i], court.pos[off][h]) < dist(court.pos[off][a], court.pos[off][h]) ? i : a)); caption(`${teamCity(teamOf(S, def))} picks up full court`); }
      }
      if (e.k === 'timeout') {
        badge('TIMEOUT', 'to'); caption(`${teamCity(teamOf(S, off))} calls timeout`);
        court.auto = false;
        const ring = (v, i) => [5 + 3.4 * Math.cos(Math.PI * 2 * i / 5 - Math.PI / 2) + 3.4, v + 3.2 * Math.sin(Math.PI * 2 * i / 5 - Math.PI / 2)];
        const moves = [0, 1, 2, 3, 4].flatMap((i) => [{ side: off, i, to: ring(-7, i), delay: i * 160 }, { side: def, i, to: ring(7, i), delay: i * 160 }]);
        await tween({ ms: 1800, moves });
        await hold(2200);
      }
      if (e.k === 'bring') {
        if (e.advanced) { court.pin[def] = [false, false, false, false, false]; await afterTimeout(off, A === 'tthree', ev.find((x) => x.k === 'shot') ? ev.find((x) => x.k === 'shot').who : null); spend(1); }
        else {
          if (court.off !== off || court.pos[off][court.handler ? court.handler.i : 0][1] > -10) { setPositions(off, true); court.handler = { side: off, i: 4 }; court.pos[off][4] = [29, -49.5]; court.bpos = [...hand(court.pos[off][4]), 0]; place(); }
          const foul = nextIs(idx, 'foul');
          await bringUp(off, spend(foul ? Math.min(left, 2) : Math.min(5.5, left * 0.42)), foul ? 0.3 : 0);
        }
      }
      if (e.k === 'live') {
        if (court.off !== off) { setPositions(off, true); place(); }
        await bringUp(off, spend(Math.min(4.5, left * 0.4)), nextIs(idx, 'foul') ? 0.3 : 0);
      }
      if (e.k === 'foul' && e.early) {
        const h = court.handler ? court.handler.i : 0, secs = spend(Math.min(left, 1.5));
        const hp = court.pos[off][h];
        await tween({ ms: dur(secs, 0), secs, moves: [{ side: def, i: h, to: [hp[0] + 1.3, hp[1] + 0.9] }], dribble: true });
        badge('FOUL', 'foul'); caption(`${teamCity(teamOf(S, def))} fouls on purpose`); await hold(1600);
        if (e.inbound) { caption('Not in the bonus: the ball comes back in'); court.pin[def][h] = false; await tween({ ms: 900, moves: [{ side: off, i: h, to: [hp[0], hp[1] - 1.5] }] }); }
      }
      if (e.k === 'turnover') {
        const secs = spend(Math.max(0, left - 0.6)), who = e.who;
        if (court.press) { await tween({ ms: dur(secs, 0), secs, dribble: true }); }
        else if (secs > 2) { await probe(off, secs * 0.6); if (who !== court.handler.i && Math.random() < 0.5) await pass(off, court.handler.i, who, secs * 0.2); }
        const hi = court.handler.i, from = court.pos[off][hi];
        if (e.steal) {
          const st = court.press && court.trap >= 0 ? court.trap : hi;
          await tween({ ms: 650, moves: [{ side: def, i: st, to: [from[0] + 1.4, from[1] + 0.8] }], dribble: true });
          badge('STEAL', 'foul'); caption(last());
          await tween({ ms: 350, ball: { to: hand(court.pos[def][st]), arc: 0.2, catch: { side: def, i: st } } });
          await wait(700);
          badge('');
          await otherWay(def, st, false);
        } else {
          badge('TURNOVER', 'foul'); caption(last());
          const spot = onCourt([from[0] + (from[0] < 25 ? 10 : -10), from[1] - 7]);
          await tween({ ms: 800, ball: { to: spot, arc: 0.7 } });
          const g = nearest(def, spot);
          await tween({ ms: 700, moves: [{ side: def, i: g, to: spot.slice() }], ball: { to: spot, arc: 0, catch: { side: def, i: g } } });
          await wait(500);
          badge('');
          await otherWay(def, g, false);
        }
      }
      if (e.k === 'shot') {
        const who = e.who, h0 = court.handler && court.handler.side === off ? court.handler.i : manAt(0);
        const flightSecs = e.three ? 1.5 : e.drive ? 0.9 : 1.2, after = e.reb ? 1.2 : 0;
        let act = Math.max(0.8, left - flightSecs - after - (e.drive ? 1.2 : 0.5));
        if (e.horn) act = Math.max(0.6, left - flightSecs - (e.drive ? 1.2 : 0.5));
        act = spend(act);
        // the action by the call
        let roll = null;
        if (A === 'tthree' || A === 'tquick') { if (act > 1.5 && court.handler.i !== who) await probe(off, act * 0.5); }
        else if (A === 'quick') { if ((e.passes || 0) >= 1 && who !== h0) { await tween({ ms: dur(act * 0.5, 0), secs: act * 0.5, dribble: true }); } else await tween({ ms: dur(act * 0.5, 0), secs: act * 0.5, dribble: true }); }
        else if (A === 'last') { await isolation(off, act); }
        else if (A === 'three') { if ((e.passes || 0) >= 2 && act > 4) { const w = manAt(1) !== h0 ? manAt(1) : manAt(2); await pass(off, h0, w, act * 0.12); await pass(off, w, h0, act * 0.12); act *= 0.76; } await pinDown(off, act, who); }
        else { if ((e.passes || 0) >= 2 && act > 5) { await probe(off, act * 0.35); act *= 0.65; } else if (act > 6) { await probe(off, act - 4.5); act = 4.5; } roll = await pickAndRoll(off, act, who); }
        // the ball to the shooter: the roller's pocket pass, the kick-out, the swing
        if (court.handler.i !== who) await ballTo(off, who, 0);
        const ds = spend(e.drive ? 1.2 : 0.5), p = court.pos[off][who];
        if (e.drive) {
          const dest = [RIM.x + (p[0] < 25 ? -2.8 : 2.8), RIM.y - 2.2], via = [p[0] < 25 ? Math.min(p[0], dest[0]) - 3 : Math.max(p[0], dest[0]) + 3, (p[1] + dest[1]) / 2];
          caption(`${dname(who)} ${roll && roll.b === who ? 'rolls to the rim' : 'drives'}`);
          await tween({ ms: dur(ds, dist(p, dest)), secs: ds, moves: [{ side: off, i: who, to: dest, via: dist(p, dest) > 8 ? via : null }], dribble: true });
        } else {
          await tween({ ms: dur(ds, 0), secs: ds, moves: [{ side: off, i: who, to: toward(p, [RIM.x, RIM.y], A === 'last' && e.three ? -2.5 : 0.8) }], dribble: true });
        }
        // the shot
        const from = court.pos[off][who], far = dist(from, [RIM.x, RIM.y]);
        if (!REDUCED) court.jump = { side: off, i: who, t0: performance.now(), ms: 900 };
        caption(`${dname(who)} ${e.three ? (A === 'last' ? 'steps back for three' : 'from three') : e.drive ? 'at the rim' : 'pulls up'}…`);
        const fs = spend(e.horn ? Math.max(0.3, left) : flightSecs);
        await tween({ ms: dur(Math.max(fs, e.three ? 1.5 : e.drive ? 0.9 : 1.2), 0), secs: fs, ball: { to: [RIM.x, RIM.y], arc: 2 + far / 9 } });
        if (e.made) {
          swish(); badge(e.and1 ? 'AND ONE' : e.three ? '+3' : '+2', 'score'); caption(last()); drawBoard(); $('bclock').textContent = clockText(court.clock);
          await tween({ ms: 380, ball: { to: [RIM.x, RIM.y + 1.6], arc: 0, rest: -1.3 } });
          await tween({ ms: 520, ball: { to: [RIM.x + 1.5, RIM.y + 2.8], arc: 0.5 } });
          await hold(e.and1 ? 1600 : 1400);
          if (!e.and1) { const g = nearest(def, court.bpos); await tween({ ms: 700, moves: [{ side: def, i: g, to: [court.bpos[0] - 0.9, court.bpos[1] - 0.3] }], ball: { to: court.bpos.slice(0, 2), catch: { side: def, i: g } } }); await otherWay(def, g, true); }
        } else if (e.fouled) {
          badge('FOUL', 'foul'); caption(`${dname(who)} is fouled`);
          await tween({ ms: 600, ball: { to: [RIM.x + 2.2, RIM.y - 1.5], arc: 0.6 } });
          await hold(1500);
        } else {
          const rx = RIM.x + (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 4), ry = RIM.y - 2 - Math.random() * 4.5;
          badge(e.horn ? 'HORN' : 'MISS', 'miss'); caption(last());
          await tween({ ms: 650, ball: { to: [rx, ry], arc: 1.3 } });
          if (e.horn) { await tween({ ms: 600, ball: { to: [rx + 1, ry - 1.5], arc: 0.4 } }); await hold(1800); }
          else {
            const side = e.reb === 'off' ? off : def, i = e.reb === 'off' ? e.rebBy : nearest(def, [rx, ry]);
            await tween({ ms: dur(spend(after), dist(court.pos[side][i], [rx, ry])), secs: after, moves: [{ side, i, to: [rx - 0.9, ry - 0.3] }], ball: { to: [rx, ry], arc: 0, catch: { side, i } } });
            badge(e.reb === 'def' ? 'REBOUND' : 'OFFENSIVE REBOUND', e.reb === 'def' ? 'to' : 'score');
            await hold(1000);
            if (e.reb === 'def') await otherWay(def, i, false);
            else court.pin[def] = [false, false, false, false, false];
          }
        }
      }
      if (e.k === 'ft') {
        const who = e.who;
        // the line: the shooter at the stripe, two a side on the lane, the rest out at the arc
        const lane = [[18.5, 42], [31.5, 42], [18.5, 36.5], [31.5, 36.5]], top = [[14, 24], [36, 24], [25, 20]];
        court.auto = false;
        const moves = [{ side: off, i: who, to: [25, H - 19 - 0.6] }];
        let ti = 0;
        [0, 1, 2, 3, 4].filter((i) => i !== who).forEach((i, n) => moves.push({ side: off, i, to: n < 2 ? lane[2 + n] : top[ti++], delay: n * 160 }));
        [0, 1, 2, 3, 4].forEach((i, n) => moves.push({ side: def, i, to: n < 2 ? lane[n] : [top[n - 2][0] + (n === 4 ? 0 : n === 2 ? -4 : 4), top[n - 2][1] - 3.5], delay: n * 160 }));
        caption(`${dname(who)} at the line`);
        await tween({ ms: 1500, moves, ball: { to: hand([25, H - 19 - 0.6]), arc: 0.6, catch: { side: off, i: who } } });
        for (let k = 0; k < e.made.length; k++) {
          await tween({ ms: 1300, dribble: true });                       // the routine: the bounces at the line
          await wait(500);
          await tween({ ms: 1300, ball: { to: [RIM.x, RIM.y], arc: 2.6 } });
          if (e.made[k]) { swish(); badge('+1', 'score'); drawBoard(); $('bclock').textContent = clockText(court.clock); await tween({ ms: 380, ball: { to: [RIM.x, RIM.y + 1.6], arc: 0, rest: -1.3 } }); await tween({ ms: 520, ball: { to: [RIM.x + 1.2, RIM.y + 2.6], arc: 0.4 } }); }
          else { badge('MISS', 'miss'); await tween({ ms: 600, ball: { to: [RIM.x + (k % 2 ? -2.6 : 2.6), RIM.y - 3], arc: 0.9 } }); }
          await hold(900);
          if (k < e.made.length - 1) { await tween({ ms: 900, ball: { to: hand(court.pos[off][who]), arc: 0.4, catch: { side: off, i: who } } }); }
        }
        caption(last());
        court.pin[def] = [false, false, false, false, false];
        if (e.reb) {
          const bp = court.bpos.slice(0, 2), side = e.reb === 'off' ? off : def, i = nearest(side, bp);
          await tween({ ms: 650, moves: [{ side, i, to: [bp[0] - 0.9, bp[1] - 0.3] }], ball: { to: bp, arc: 0, catch: { side, i } } });
          await wait(500);
          if (e.reb === 'def') await otherWay(def, i, false); else court.auto = true;
        } else {
          const g = nearest(def, court.bpos);
          await tween({ ms: 650, moves: [{ side: def, i: g, to: [court.bpos[0] - 0.9, court.bpos[1] - 0.3] }], ball: { to: court.bpos.slice(0, 2), catch: { side: def, i: g } } });
          await otherWay(def, g, true);
        }
      }
    }
    court.clock = S.clock; $('bclock').textContent = clockText(S.clock);
    court.auto = true; court.press = false;
  }

  // ---- the game on the page -------------------------------------------------------------------------------------------
  let D = null, spot = null, S = null, G = null, busy = false;            // the data, today's spot, the state, the game record
  const dayKey = () => `${STORE}:day:${dayISO()}`;
  const dayN = () => { const a = new Date(2026, 9, 28), b = new Date(); b.setHours(12, 0, 0, 0); a.setHours(12, 0, 0, 0); return Math.max(1, Math.round((b - a) / 864e5) + 1); };
  function pickSpot(practice) {
    if (practice) return D.spots[Math.floor(Math.random() * D.spots.length)];
    const id = D.schedule[dayISO()];
    return D.spots.find((s) => s.id === id) || D.spots[hash('hoops', dayISO()) % D.spots.length];
  }
  function situation(S) {
    const me = S.me, ld = lead(S, me);
    return `${ld > 0 ? `Up ${ld}` : ld < 0 ? `Down ${-ld}` : 'Tied'}, ${clockText(S.clock)} left in the ${periodText(S.period).toLowerCase()}, ${S.poss === me ? 'your ball' : 'their ball'}`;
  }
  function drawBoard() {
    const b = $('board'); b.textContent = '';
    for (const side of ['away', 'home']) {
      const row = el('div', `tm${side === S.me ? ' me' : ''}${S.poss === side && !S.over ? ' ball' : ''}`);
      row.append(el('span', 'nm', teamCity(teamOf(S, side)) + (side === S.me ? ' (you)' : '')), el('b', 'sc', String(S.score[side])),
        el('span', 'to', `${'●'.repeat(S.to[side])}${'○'.repeat(Math.max(0, 2 - S.to[side]))}`), el('span', 'fl', inBonus(S, other(side)) ? 'in the bonus' : `${S.fouls[other(side)]} team fouls on them`));
      b.append(row);
    }
    const c = el('div', 'clk'); const bc = el('b', '', clockText(S.clock)); bc.id = 'bclock';
    c.append(bc, el('span', '', `${periodText(S.period)}${S.clock > SHOT ? ` · shot clock ${S.shot}` : ''}`));
    b.append(c);
  }
  function renderIntro(practice) {
    const box = $('card'); box.textContent = ''; $('dock').textContent = ''; caption('');
    box.append(el('div', 'eyebrow', practice ? 'Practice game' : `Day ${dayN()} · today's game`),
      el('h2', '', `${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('p', 'lead', `${spot.season}–${String(spot.season + 1).slice(2)} season. ${situation(S)}. You coach ${teamCity(teamOf(S, S.me))}.`),
      el('p', 'note', `Timeouts: you ${S.to[S.me]}, they ${S.to[other(S.me)]}. ${inBonus(S, other(S.me)) ? 'They are in the bonus: any foul on you is two free throws. ' : ''}${inBonus(S, S.me) ? 'You are in the bonus: any foul on them is two free throws.' : ''}`));
    if (spot.lead) box.append(el('p', 'note', `How it got here: ${byCity(spot.lead)}.`));
    const go = el('button', 'btn big', 'Take over'); go.type = 'button';
    go.addEventListener('click', () => { G.started = true; saveGame(); box.textContent = ''; step(); });
    box.append(go);
    if (!practice) { const st = load(`${STORE}:stats`, { days: {} }), n = Object.keys(st.days).length; if (n) box.append(el('p', 'note', `You have played ${n} day${n === 1 ? '' : 's'}. Streak: ${streakOf(st)}.`)); }
    drawBoard();
  }
  // one decision: the options in the dock; the evaluation is done when the call is in (never shown before)
  function step() {
    if (S.over) return renderEnd();
    if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) return renderEnd(); note(t); caption(t); setPositions(S.poss, true); place(); }
    drawBoard();
    const mine = S.poss === S.me, dock = $('dock'); dock.textContent = '';
    dock.append(el('div', 'sit', `${mine ? 'Your ball' : 'Their ball'} · ${situation(S)}`));
    const opts = mine ? offenseOptions(S) : Object.keys(DEFENSE), src = mine ? APPROACH : DEFENSE;
    const grid = el('div', `keys${opts.length > 4 ? ' many' : ''}`);
    for (const k of opts) {
      const b = el('button', `key${src[k].timeout ? ' to' : ''}`); b.type = 'button';
      b.append(el('b', '', src[k].label), el('span', '', src[k].sub));
      b.addEventListener('click', () => call(k, opts, mine, true));
      grid.append(b);
    }
    dock.append(grid);
  }
  function note(t) { G.lines.push(t); }
  async function call(k, opts, mine, live) {
    if (busy) return;
    busy = true;
    const i = G.decs.length, seed = hash(G.seed, 'd', i);
    if (live) {
      const dock = $('dock'); dock.textContent = ''; dock.append(el('div', 'sit', `${(mine ? APPROACH : DEFENSE)[k].label}… tap the court to skip`));
      const top = $('board').getBoundingClientRect().top;                 // the board and the court in view for the play
      if (top < 0 || top > 60) window.scrollTo({ top: window.scrollY + top - 8, behavior: REDUCED ? 'auto' : 'smooth' });
    }
    // the grade: every option's win chance from here, the same bounces each
    const wp = evaluate(S, mine ? 'off' : 'def', opts, seed, N_EVAL), best = opts.reduce((a, b) => (wp[b] > wp[a] ? b : a));
    const typ = mine ? typicalOffense(S, rng(1)).weights : typicalDefense(S, rng(1)).weights;
    G.decs.push({ i, side: mine ? 'off' : 'def', situation: situation(S), chosen: k, best, wp: wp[k], bestWp: wp[best], cost: Math.max(0, wp[best] - wp[k]),
      opts: opts.map((o) => ({ k: o, label: (mine ? APPROACH : DEFENSE)[o].label, wp: wp[o], q: typ[o] || 0 })) });
    // the possession, with the other bench typical, on the day's own bounces
    const r = rng(hash(G.seed, 'p', i)), off = S.poss;
    const a = mine ? k : typicalOffense(S, r).pick, d = mine ? typicalDefense(S, r).pick : k;
    const ev = [], lines = possession(S, r, a, d, ev);
    for (const t of lines) G.lines.push(t);
    saveGame();
    if (live) await animate(ev, off, lines);
    busy = false;
    if (live) step();
  }
  // ---- the end card: the grade, the calls, what really happened --------------------------------------------------------
  function percentile(decs) {
    // typical coaches making the same decisions with the mix real benches use in each spot: how many would have given up
    // more win chance than you did in total
    const mine = decs.reduce((a, x) => a + x.cost, 0), r = rng(hash(G.seed, 'pct')), N = 4000;
    let worse = 0;
    for (let s = 0; s < N; s++) {
      let tot = 0;
      for (const x of decs) {
        const ks = x.opts.filter((o) => o.q > 0), tq = ks.reduce((a, o) => a + o.q, 0);
        let pick = x.opts[0];
        if (tq > 0) { let z = r() * tq; for (const o of ks) { z -= o.q; if (z <= 0) { pick = o; break; } } }
        else pick = x.opts[Math.floor(r() * x.opts.length)];
        tot += Math.max(0, x.bestWp - pick.wp);
      }
      if (tot > mine + 1e-9) worse++; else if (Math.abs(tot - mine) <= 1e-9) worse += 0.5;
    }
    return worse / N;
  }
  const markOf = (c) => (c < 0.01 ? 'g' : c < 0.04 ? 'y' : 'r');
  function streakOf(st) {
    const days = Object.keys(st.days).sort(); if (!days.length) return 0;
    let n = 0, d = new Date(); d.setHours(12, 0, 0, 0);
    if (!st.days[dayISO(d)]) d.setDate(d.getDate() - 1);
    while (st.days[dayISO(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function renderEnd() {
    drawBoard(); $('dock').textContent = '';
    const box = $('card'); box.textContent = '';
    const won = lead(S, S.me) > 0, margin = Math.abs(lead(S, S.me)), decs = G.decs;
    badge(won ? 'YOU WIN' : 'FINAL', won ? 'score' : 'miss'); caption(`Final: ${teamCity(teamOf(S, S.me))} ${S.score[S.me]}, ${teamCity(teamOf(S, other(S.me)))} ${S.score[other(S.me)]}`);
    if (G.score == null) {
      G.score = Math.round(percentile(decs) * 100); G.won = won; G.margin = margin; G.done = true; saveGame();
      if (!G.practice) { const st = load(`${STORE}:stats`, { days: {} }); if (!st.days[dayISO()]) { st.days[dayISO()] = { score: G.score, won }; save(`${STORE}:stats`, st); } }
    }
    const realMine = spot.me === spot.home ? spot.final[0] - spot.final[1] : spot.final[1] - spot.final[0];
    box.append(el('div', 'eyebrow', G.practice ? 'Practice game' : `Day ${dayN()} · ${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('div', 'big', String(G.score)), el('div', 'pct-lab', `Better than ${G.score}% of coaches`),
      el('h2', '', `${won ? 'You won' : margin === 0 ? 'Tied' : 'You lost'} ${S.score[S.me]}–${S.score[other(S.me)]}${S.period > 4 ? ' in overtime' : ''}`),
      el('p', 'note', `The real game: ${teamCity(teamOf(S, S.me))} ${realMine > 0 ? 'won' : realMine < 0 ? 'lost' : 'tied'} ${Math.abs(realMine) ? `by ${Math.abs(realMine)}` : ''} (${spot.final[1]}–${spot.final[0]} ${teamCity(spot.away)} at ${teamCity(spot.home)}).`));
    const list = el('ol', 'calls');
    for (const x of decs) {
      const li = el('li', markOf(x.cost));
      li.append(el('span', 'sq', { g: '✓', y: '~', r: '✗' }[markOf(x.cost)]), el('span', 'sit', x.situation), el('span', 'what', `You: ${x.opts.find((o) => o.k === x.chosen).label}${x.cost >= 0.01 ? ` · best: ${x.opts.find((o) => o.k === x.best).label} (${(x.cost * 100).toFixed(1)} pts of win chance)` : ''}`));
      list.append(li);
    }
    box.append(el('h3', '', 'Your calls'), list);
    const worst = decs.filter((x) => x.cost >= 0.01).sort((a, b) => b.cost - a.cost)[0];
    if (worst) box.append(el('p', 'verdict', `What cost the most: ${worst.situation}. You called ${worst.opts.find((o) => o.k === worst.chosen).label.toLowerCase()}; ${worst.opts.find((o) => o.k === worst.best).label.toLowerCase()} was the call there, ${(worst.cost * 100).toFixed(1)} points of win chance better.`));
    else box.append(el('p', 'verdict', 'Every call the best or close to it. That is a coach.'));
    const mine = el('div', 'real'); mine.append(el('h3', '', 'How your game went'));
    const ul = el('ul', ''); for (const t of G.lines) ul.append(el('li', '', t)); mine.append(ul); box.append(mine);
    const real = el('div', 'real'); real.append(el('h3', '', 'What really happened'));
    const rl = el('ul', '');
    for (const e of (spot.real || []).slice(0, 40)) rl.append(el('li', '', `${e.t != null ? `${clockText(e.t)}${e.p > 4 ? ' OT' : ''} · ` : ''}${byCity(e.text)}${e.score ? ` · ${e.score[1]}–${e.score[0]}` : ''}`));
    real.append(rl); box.append(real);
    if (!G.practice) { const st = load(`${STORE}:stats`, { days: {} }); box.append(el('p', 'streak', `🔥 ${streakOf(st)} day${streakOf(st) === 1 ? '' : 's'} in a row · come back tomorrow for a new game`)); }
    const row = el('div', 'row');
    const share = el('button', 'btn', 'Share'); share.type = 'button';
    share.addEventListener('click', async () => {
      const text = `Two-Minute Drill: Hoops #${dayN()}\n${G.score} · better than ${G.score}% of coaches\n${decs.map((x) => ({ g: '🟩', y: '🟨', r: '🟥' }[markOf(x.cost)])).join('')}\n${won ? 'Won' : 'Lost'} ${S.score[S.me]}–${S.score[other(S.me)]}\nhttps://2mindrills.com/hoops`;
      try { await navigator.clipboard.writeText(text); share.textContent = 'Copied'; } catch (e) { share.textContent = text; }
    });
    const again = el('button', 'btn ghostbtn', 'Play another game (practice)'); again.type = 'button';
    again.addEventListener('click', () => start(true));
    const home = el('a', 'btn ghostbtn', 'Home'); home.href = './';
    row.append(share, again, home); box.append(row);
    box.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  }
  function saveGame() { if (!G.practice) save(dayKey(), { seed: G.seed, spotId: spot.id, decs: G.decs.map((x) => x.chosen), done: G.done, score: G.score, lines: G.lines, started: G.started }); }
  // today's game, or a practice one; a day's saved game is replayed from its calls (the same seed: the same bounces), no animation
  async function start(practice) {
    spot = pickSpot(practice); S = newState(spot);
    FIVE = { home: (spot.players && spot.players.home || []).slice(0, 5), away: (spot.players && spot.players.away || []).slice(0, 5) };
    while (FIVE.home.length < 5) FIVE.home.push(`${teamCity(spot.home)} ${FIVE.home.length + 1}`);
    while (FIVE.away.length < 5) FIVE.away.push(`${teamCity(spot.away)} ${FIVE.away.length + 1}`);
    G = { seed: practice ? (Math.random() * 1e9) >>> 0 : hash('hoops', dayISO(), spot.id), decs: [], lines: [], practice: !!practice, done: false, score: null, started: false };
    drawCourt(); badge(''); caption('');
    const saved = practice ? null : load(dayKey(), null);
    if (saved && saved.spotId === spot.id) {
      G.seed = saved.seed; G.started = saved.started;
      for (const k of saved.decs) {
        if (S.over) break;
        if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) break; note(t); }
        const mine = S.poss === S.me, opts = mine ? offenseOptions(S) : Object.keys(DEFENSE);
        if (!opts.includes(k)) break;
        await call(k, opts, mine, false);
      }
      if (saved.done || S.over) { G.done = true; setPositions(S.poss, false); place(); return renderEnd(); }
      if (G.started) { setPositions(S.poss, S.dead); place(); if (G.lines.length) caption(G.lines[G.lines.length - 1]); return step(); }
    }
    renderIntro(practice);
  }
  // Hoops as part of Pro (<meta name="hoops-pro">, site.py --hoops-pro): the device's Pro code, as the game keeps it, opens it
  const HOOPS_PRO = !!document.querySelector('meta[name="hoops-pro"]');
  const hasPro = () => !!String((load('tmd:v3:pro', null) || {}).code || '');
  function renderPitch() {
    const box = $('card'); box.textContent = '';
    box.append(el('div', 'eyebrow', 'Hoops · part of Pro'), el('h2', '', 'The last two minutes of a real basketball game, every day'),
      el('p', 'lead', 'One real game a day: the real score, clock, timeouts and bonus, and you coach one bench, possession by possession, on the court. Every call graded on win chance, the real ending beside yours.'),
      el('p', '', 'Hoops comes with Two-Minute Drill Pro, a one-time purchase with the historic drives, the playoff runs, the scenario builder and no ads.'));
    const a = el('a', 'btn big', 'Get Pro'); a.href = './#archive'; box.append(a);
    box.append(el('p', 'note', 'Already have Pro? Open the football game on this phone once so it knows, then come back.'));
    $('board').hidden = true; $('courtbox').hidden = true; $('dock').hidden = true;
  }
  async function boot() {
    if (HOOPS_PRO && !hasPro()) return renderPitch();
    const src = document.querySelector('meta[name="hoops-data"]');
    try {
      const r = await fetch((src && src.content) || 'hoops/hoops_data.json');
      D = await r.json(); L = D.league; T = D.teams;
    } catch (e) { $('card').textContent = 'The game could not load its data. Try again in a minute.'; return; }
    $('courtbox').addEventListener('click', () => { skipNow = true; });
    start(false);
  }
  boot();
})();
