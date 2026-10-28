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

  // ---- the court: a half court, the basket at the bottom, ten men and the ball ----------------------------------------
  // Feet. x across the court (0 to 50), y down it (0 the half-court line, 47 the baseline). The rim 5.25 from the baseline.
  const W = 50, H = 47, RIM = { x: 25, y: H - 5.25 }, R3 = 23.75;
  const SPOTS = [[25, 13], [9, 22], [41, 22], [7, 38], [43, 38]];          // the offense's set: the point, two wings, two corners
  const court = { svg: null, off: null, dots: { home: [], away: [] }, ball: null, shadow: null, pos: { home: [], away: [] }, bpos: [25, 13, 0], badge: null, cap: null, net: null };
  function drawCourt() {
    const s = $('court'); s.textContent = '';
    s.setAttribute('viewBox', `0 -2 ${W} ${H + 2}`);
    s.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'wood' }));
    const line = (a) => s.append(svgEl('path', { d: a, class: 'ln' }));
    line(`M0 0 H${W}`);                                                   // the half-court line
    s.append(svgEl('path', { d: `M19 0 A6 6 0 0 0 31 0`, class: 'ln' }));   // the center circle's half
    line(`M17 ${H} V${H - 19} H33 V${H}`);                               // the lane
    s.append(svgEl('path', { d: `M19 ${H - 19} A6 6 0 0 0 31 ${H - 19}`, class: 'ln' }));   // the free-throw circle
    // the three-point line: straight from the baseline 14 feet, then the arc
    const yc = H - 14, dx = Math.sqrt(R3 * R3 - (RIM.y - yc) * (RIM.y - yc));
    line(`M3 ${H} V${yc} A${R3} ${R3} 0 0 0 ${W - 3} ${yc} V${H}`);
    line(`M22 ${H - 4} H28`);                                           // the backboard
    s.append(svgEl('circle', { cx: RIM.x, cy: RIM.y, r: 0.75, class: 'rim' }));
    court.net = svgEl('path', { d: `M${RIM.x - 0.7} ${RIM.y} L${RIM.x - 0.45} ${RIM.y + 1.3} L${RIM.x + 0.45} ${RIM.y + 1.3} L${RIM.x + 0.7} ${RIM.y}`, class: 'net' });
    s.append(court.net);
    for (const side of ['home', 'away']) {
      court.dots[side] = [];
      for (let i = 0; i < 5; i++) {
        const g = svgEl('g', { class: `man ${side === S.me ? 'me' : 'them'}` });
        g.append(svgEl('circle', { r: 1.35 }), svgEl('text', { y: -1.9, 'text-anchor': 'middle' }));
        g.querySelector('text').textContent = lastName(FIVE[side][i] || '');
        s.append(g); court.dots[side].push(g);
      }
    }
    court.shadow = svgEl('ellipse', { rx: 0.7, ry: 0.35, class: 'shadow' }); s.append(court.shadow);
    court.ball = svgEl('circle', { r: 0.6, class: 'ball' }); s.append(court.ball);
    court.badge = svgEl('text', { x: 25, y: 22, 'text-anchor': 'middle', class: 'badge' }); s.append(court.badge);
    court.svg = s;
    setPositions(S.poss, false);
    place();
  }
  // the offense in its set (or above the half-court line, to bring it up), the defense between each man and the rim
  function setPositions(off, topOfCourt) {
    const def = other(off);
    for (let i = 0; i < 5; i++) {
      const [x, y] = SPOTS[i];
      court.pos[off][i] = topOfCourt ? [x, -6 - i * 1.5] : [x, y];
      court.pos[def][i] = guard([x, topOfCourt ? -6 - i * 1.5 : y]);
    }
    court.bpos = [court.pos[off][0][0], court.pos[off][0][1], 0];
    court.off = off;
  }
  const guard = ([x, y]) => { const dx = RIM.x - x, dy = RIM.y - y, d = Math.hypot(dx, dy) || 1; return [x + dx / d * 4, y + dy / d * 4]; };
  function place() {
    for (const side of ['home', 'away']) court.dots[side].forEach((g, i) => { const [x, y] = court.pos[side][i]; g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`); g.lastChild.setAttribute('y', side === court.off ? -1.9 : 3.4); });
    const [bx, by, bz] = court.bpos;
    court.ball.setAttribute('cx', bx.toFixed(2)); court.ball.setAttribute('cy', (by - bz).toFixed(2)); court.ball.setAttribute('r', (0.6 + bz * 0.04).toFixed(2));
    court.shadow.setAttribute('cx', bx.toFixed(2)); court.shadow.setAttribute('cy', by.toFixed(2));
  }
  // a timeline: segments, each moving actors (men by side+index, the ball by a path) over a duration; a tap skips to the end
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2);
  let skipNow = false;
  function tween(seg) {
    return new Promise((resolve) => {
      const from = { home: court.pos.home.map((p) => p.slice()), away: court.pos.away.map((p) => p.slice()) }, b0 = court.bpos.slice();
      const ms = REDUCED || skipNow ? 0 : seg.ms;
      const t0 = performance.now();
      const frame = (now) => {
        const k = ms ? Math.min(1, (now - t0) / ms) : 1, e = ease(k);
        for (const m of seg.moves || []) { const [fx, fy] = from[m.side][m.i]; court.pos[m.side][m.i] = [fx + (m.to[0] - fx) * e, fy + (m.to[1] - fy) * e]; }
        if (seg.ball) {
          const b = seg.ball;
          if (b.with) { const [x, y] = court.pos[b.with.side][b.with.i]; court.bpos = [x + 0.9, y + 0.3, b.dribble ? Math.abs(Math.sin(k * Math.PI * 6)) * 1.2 : 0]; }
          else if (b.to) { const z = (b.arc || 0) * 4 * k * (1 - k); court.bpos = [b0[0] + (b.to[0] - b0[0]) * k, b0[1] + (b.to[1] - b0[1]) * k, z]; }
        } else if (seg.hold) { const [x, y] = court.pos[seg.hold.side][seg.hold.i]; court.bpos = [x + 0.9, y + 0.3, 0]; }
        if (seg.clock) { const c = seg.clock; $('bclock').textContent = clockText(c.from + (c.to - c.from) * k); }
        place();
        if (k < 1 && !skipNow) requestAnimationFrame(frame); else { if (k < 1) { for (const m of seg.moves || []) court.pos[m.side][m.i] = m.to.slice(); if (seg.ball && seg.ball.to) court.bpos = [seg.ball.to[0], seg.ball.to[1], 0]; if (seg.clock) $('bclock').textContent = clockText(seg.clock.to); place(); } if (seg.then) seg.then(); resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED || skipNow ? 0 : ms));
  function badge(text, cls) { court.badge.textContent = text || ''; court.badge.setAttribute('class', `badge${cls ? ` ${cls}` : ''}`); }
  function caption(text) { $('cap').textContent = text || ''; }
  // play a possession's steps on the court: the men to their spots, the passes, the drive, the shot's arc, the bounce
  async function animate(ev, off, lines) {
    skipNow = false;
    const def = other(off), five = FIVE[off], dname = (i) => lastName(five[i] || '');
    const endEv = ev.find((e) => e.k === 'end') || { clock0: S.clock, clock1: S.clock }, totalSecs = Math.max(0.5, endEv.clock0 - endEv.clock1);
    const clockAt = (frac0, frac1) => ({ from: endEv.clock0 - totalSecs * frac0, to: endEv.clock0 - totalSecs * frac1 });
    let used = 0;
    const seg = async (s, secsFrac) => { const c = clockAt(used, used + (secsFrac || 0)); used += secsFrac || 0; await tween({ ...s, clock: c }); };
    const man = (i) => ({ side: off, i }), toSpots = (extra) => [...Array(5)].flatMap((_, i) => [{ side: off, i, to: SPOTS[i] }, { side: def, i, to: guard(SPOTS[i]) }]).concat(extra || []);
    for (const e of ev) {
      if (e.k === 'timeout') { badge('TIMEOUT', 'to'); caption(`${teamCity(teamOf(S, off))} calls timeout`); await wait(900); badge(''); }
      if (e.k === 'bring') {
        setPositions(off, !e.advanced); place();
        caption(e.advanced ? 'The ball comes in at the frontcourt' : `${dname(0)} brings it up`);
        await seg({ ms: e.advanced ? 500 : 1100, moves: toSpots(), ball: { with: man(0), dribble: true } }, e.advanced ? 0.1 : 0.25);
      }
      if (e.k === 'live') {
        if (court.off !== off) { setPositions(off, true); place(); caption(`${dname(0)} pushes it up`); await seg({ ms: 900, moves: toSpots(), ball: { with: man(0), dribble: true } }, 0.2); }
        else await seg({ ms: 400, moves: toSpots(), ball: { with: man(0), dribble: true } }, 0.05);
      }
      if (e.k === 'foul' && e.early) {
        const d0 = guard(court.pos[off][0]);
        await seg({ ms: 500, moves: [{ side: def, i: 0, to: [court.pos[off][0][0] + 1.5, court.pos[off][0][1] + 1] }], hold: man(0) }, 0.1);
        badge('FOUL', 'foul'); caption(`${teamCity(teamOf(S, def))} fouls on purpose`); await wait(800); badge('');
        if (e.inbound) { caption('Not in the bonus: the ball comes back in'); await seg({ ms: 500, moves: [{ side: def, i: 0, to: d0 }], hold: man(0) }, 0.05); }
      }
      if (e.k === 'turnover') {
        const who = e.who, from = court.pos[off][who];
        if (e.steal) { await seg({ ms: 450, moves: [{ side: def, i: who, to: [from[0] + 1.2, from[1] + 0.6] }], hold: man(who) }, 0.3); badge('STEAL', 'foul'); caption(lines[lines.length - 1]); await seg({ ms: 700, moves: [{ side: def, i: who, to: [from[0], -4] }], ball: { with: { side: def, i: who }, dribble: true } }, 0.2); }
        else { badge('TURNOVER', 'foul'); caption(lines[lines.length - 1]); await seg({ ms: 500, ball: { to: [Math.min(W - 1, Math.max(1, from[0] + 9)), from[1] - 6], arc: 0.5 } }, 0.3); await seg({ ms: 500, moves: [{ side: def, i: who, to: [Math.min(W - 1, Math.max(1, from[0] + 9)), from[1] - 6] }] }, 0.1); }
        badge('');
      }
      if (e.k === 'shot') {
        const who = e.who, passes = Math.max(0, e.passes || 0);
        let holder = 0;
        const passFrac = Math.min(0.6, 0.5 * (e.secs || 6) / Math.max(6, totalSecs)) / Math.max(1, passes + 1);
        for (let p = 0; p < passes; p++) {
          const to = p === passes - 1 ? who : [1, 2, 0, 3, 4].find((j) => j !== holder && j !== who) ?? who;
          if (to === holder) continue;
          caption(`${dname(holder)} to ${dname(to)}`);
          await seg({ ms: 380, ball: { to: [court.pos[off][to][0] + 0.9, court.pos[off][to][1] + 0.3], arc: 0.25 } }, passFrac);
          holder = to;
        }
        if (holder !== who) { await seg({ ms: 380, ball: { to: [court.pos[off][who][0] + 0.9, court.pos[off][who][1] + 0.3], arc: 0.25 } }, passFrac); holder = who; }
        if (e.drive) {
          const dest = [RIM.x + (court.pos[off][who][0] < 25 ? -3.5 : 3.5), RIM.y - 2.5];
          caption(`${dname(who)} drives`);
          await seg({ ms: 750, moves: [{ side: off, i: who, to: dest }, { side: def, i: who, to: guard(dest) }], ball: { with: man(who), dribble: true } }, 0.25);
        } else if (passes === 0 && who === 0) { await seg({ ms: 500, moves: [{ side: off, i: 0, to: [25, 20] }, { side: def, i: 0, to: guard([25, 20]) }], ball: { with: man(0), dribble: true } }, 0.2); }
        // the shot
        const from = court.pos[off][who], flight = e.three ? 900 : e.drive ? 500 : 700;
        caption(`${dname(who)} ${e.three ? 'from three' : e.drive ? 'at the rim' : 'pulls up'}…`);
        await seg({ ms: flight, ball: { to: [RIM.x, RIM.y], arc: e.three ? 2.2 : e.drive ? 0.8 : 1.6 } }, 0.15);
        if (e.made) {
          court.net.classList.add('swish'); setTimeout(() => court.net.classList.remove('swish'), 600);
          badge(e.three ? '+3' : '+2', 'score'); caption(lines[lines.length - 1]); drawBoard();
          await seg({ ms: 350, ball: { to: [RIM.x, RIM.y + 1.5], arc: 0 } }, 0);
          if (e.and1) { badge('AND ONE', 'score'); await wait(600); }
          else { await wait(500); badge(''); }
        } else if (e.fouled) {
          badge('FOUL', 'foul'); caption(`${dname(who)} is fouled`); await wait(700); badge('');
        } else {
          const rx = RIM.x + (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4), ry = RIM.y - 2 - Math.random() * 4;
          badge(e.horn ? 'HORN' : 'MISS', 'miss'); caption(lines[lines.length - 1]);
          await seg({ ms: 400, ball: { to: [rx, ry], arc: 0.6 } }, 0.05);
          if (!e.horn) {
            const side = e.reb === 'off' ? off : def, i = e.reb === 'off' ? e.rebBy : Math.floor(Math.random() * 5);
            await seg({ ms: 450, moves: [{ side, i, to: [rx, ry] }], ball: { to: [rx, ry], arc: 0 } }, 0.05);
            if (e.reb === 'def') { badge('REBOUND', 'to'); await seg({ ms: 600, moves: [{ side, i, to: [rx, ry - 8] }], ball: { with: { side, i }, dribble: true } }, 0.05); }
            else badge('OFFENSIVE REBOUND', 'score');
            await wait(350);
          } else await wait(600);
          badge('');
        }
      }
      if (e.k === 'ft') {
        const who = e.who;
        // the line: the shooter at the stripe, two a side on the lane, the rest at the top
        const lane = [[18, 42], [32, 42], [18, 36], [32, 36]], top = [[14, 24], [36, 24], [25, 20]];
        const moves = [{ side: off, i: who, to: [25, H - 19 - 0.5] }];
        let li = 0, ti = 0;
        [0, 1, 2, 3, 4].filter((i) => i !== who).forEach((i, n) => moves.push({ side: off, i, to: n < 2 ? lane[2 + n] : top[ti++] }));
        [0, 1, 2, 3, 4].forEach((i, n) => moves.push({ side: def, i, to: n < 2 ? lane[n] : top[Math.min(2, n - 2)] && [top[Math.min(2, n - 2)][0] + 4, top[Math.min(2, n - 2)][1] - 3] }));
        caption(`${dname(who)} at the line`);
        await seg({ ms: 700, moves, hold: man(who) }, 0);
        for (let k = 0; k < e.made.length; k++) {
          await wait(250);
          await seg({ ms: 800, ball: { to: [RIM.x, RIM.y], arc: 1.3 } }, 0);
          if (e.made[k]) { court.net.classList.add('swish'); setTimeout(() => court.net.classList.remove('swish'), 600); badge('+1', 'score'); drawBoard(); await seg({ ms: 300, ball: { to: [RIM.x, RIM.y + 1.5], arc: 0 } }, 0); }
          else { badge('MISS', 'miss'); await seg({ ms: 300, ball: { to: [RIM.x + 2.5, RIM.y - 3], arc: 0.4 } }, 0); }
          await wait(300); badge('');
          if (k < e.made.length - 1) await seg({ ms: 350, ball: { to: [25 + 0.9, H - 19 - 0.2], arc: 0.3 } }, 0);
        }
        caption(lines[lines.length - 1]);
        if (e.reb) { const side = e.reb === 'off' ? off : def, i = e.reb === 'off' ? [0, 1, 2, 3, 4].filter((j) => j !== who)[0] : 0; await seg({ ms: 450, moves: [{ side, i, to: [RIM.x + 2.5, RIM.y - 3] }], ball: { to: [RIM.x + 2.5, RIM.y - 3], arc: 0 } }, 0); }
        await wait(300);
      }
    }
    $('bclock').textContent = clockText(S.clock);
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
    if (live) { const dock = $('dock'); dock.textContent = ''; dock.append(el('div', 'sit', `${(mine ? APPROACH : DEFENSE)[k].label}… tap the court to skip`)); }
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
