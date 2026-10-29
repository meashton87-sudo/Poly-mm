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
    two4one: { label: 'Two-for-one', sub: 'Shoot early, get the ball back for the last shot', t: [3, 7], three: 0.35, p2: -0.02, p3: -0.02, to: 0.95, foul: 1.0 },
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
  const playerOf = (S, side, i) => { const t = T[teamOf(S, side)]; return t && t.players && t.players.find((p) => p.name === FIVE[side][i]); };
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
    const pl = playerOf(S, side, who), p = pl && pl.ft ? pl.ft : rate(teamOf(S, side), 'ft'), made = [];
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
    const bring = S.dead, pick = S.pick;
    S.pick = null;                                            // (the man called for: this possession only)
    if (ev) ev.push({ k: 'start', a, d, shot: S.shot });
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
    const toP = L.to * A.to * (press ? 1.5 : 1);
    if (r() < toP) {
      S.clock = Math.max(0, S.clock - u(r, 1, t));
      // what kind: a live-ball steal, a pass thrown away, or a dead ball (out of bounds, an offensive foul, a travel), the
      // way the league's turnovers split; a trap forces more steals
      const who = Math.floor(r() * 5), z = r(), kind = press ? (z < 0.65 ? 'steal' : z < 0.9 ? 'badpass' : 'oob') : z < 0.42 ? 'steal' : z < 0.68 ? 'badpass' : z < 0.84 ? 'oob' : z < 0.94 ? 'ofoul' : 'travel';
      const dead = kind === 'oob' || kind === 'ofoul' || kind === 'travel';
      if (ev) ev.push({ k: 'turnover', who, steal: kind === 'steal', dead, kind });
      lines.push(`${name(who)} ${{ steal: press ? 'has it stolen in the trap' : 'has it stolen', badpass: press ? 'throws it away against the press' : 'throws it away', oob: 'loses it out of bounds', ofoul: 'is called for the offensive foul', travel: 'travels' }[kind]}`);
      S.poss = def; S.shot = SHOT; S.dead = dead; return done();
    }
    S.clock = Math.max(0, S.clock - t);
    const need = lead(S, off);                                 // (a team down three with no time hunts the three whatever was called)
    let three = A.three == null ? rate(teamOf(S, off), 'share3') : A.three;
    if (S.clock <= 0 && need < 0 && need >= -3 && a !== 'three') three = need === -3 ? 0.95 : three;
    const isThree = r() < three, kind = isThree ? 3 : 2;
    const who = pick != null && off === S.me && r() < 0.75 ? pick : shooter(S, off, kind, r);   // (the man you called for gets it three times in four: the defense has a say)
    const passes = a === 'work' ? 2 + Math.floor(r() * 2) : a === 'quick' || a === 'rim' ? (r() < 0.5 ? 1 : 0) : a === 'last' ? 1 + Math.floor(r() * 2) : 1;
    const drive = !isThree && (a === 'rim' || a === 'quick' || r() < 0.5);
    const foulP = (isThree ? L.foul3 : L.foul2) * A.foul * (press ? 1.6 : 1);     // (reaching in a press: more fouls)
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
    const pl = playerOf(S, off, who), tm = T[teamOf(S, off)] || {}, own = pl && pl[isThree ? 'p3' : 'p2'], base = tm[isThree ? 'p3' : 'p2'];
    let p = rate(teamOf(S, off), isThree ? 'p3' : 'p2') + (own && base ? own - base : 0) + (isThree ? A.p3 : A.p2) + (press ? (isThree ? 0.02 : 0.08) : 0)   // (a press beaten is an easy one; the shooter's own touch)
      + (a === 'quick' && !bring && !isThree ? 0.07 : 0);                                                            // (the push on a live ball: the defense not set)
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
      if (c <= SHOT + 4) { w.last = 0.75; w.work = 0.2; w.rim = 0.05; } else if (c >= 29 && c <= 46) { w.two4one = 0.45; w.work = 0.4; w.rim = 0.15; } else { w.work = 0.7; w.rim = 0.15; w.quick = 0.15; }
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
    if (S.clock >= 29 && S.clock <= 46) out.push('two4one');     // (shoot by the 24 left and the other team's shot clock runs out first)
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
  // each team's colors (primary, secondary): the dots wear them; when the two benches' primaries are too close, the
  // road team wears its second color
  const COLORS = { ATL: ['#C8102E', '#FDB927'], BOS: ['#007A33', '#BA9653'], BKN: ['#111111', '#AAAAAA'], CHA: ['#1D1160', '#00788C'], CHI: ['#CE1141', '#111111'],
    CLE: ['#860038', '#FDBB30'], DAL: ['#00538C', '#B8C4CA'], DEN: ['#0E2240', '#FEC524'], DET: ['#C8102E', '#1D42BA'], GSW: ['#1D428A', '#FFC72C'],
    HOU: ['#CE1141', '#C4CED4'], IND: ['#002D62', '#FDBB30'], LAC: ['#C8102E', '#1D428A'], LAL: ['#552583', '#FDB927'], MEM: ['#5D76A9', '#12173F'],
    MIA: ['#98002E', '#F9A01B'], MIL: ['#00471B', '#EEE1C6'], MIN: ['#0C2340', '#236192'], NOP: ['#0C2340', '#C8102E'], NYK: ['#006BB6', '#F58426'],
    OKC: ['#007AC1', '#EF3B24'], ORL: ['#0077C0', '#C4CED4'], PHI: ['#006BB6', '#ED174C'], PHX: ['#1D1160', '#E56020'], POR: ['#E03A3E', '#111111'],
    SAC: ['#5A2D81', '#63727A'], SAS: ['#111111', '#C4CED4'], TOR: ['#CE1141', '#111111'], UTA: ['#002B5C', '#F9A01B'], WAS: ['#002B5C', '#E31837'] };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const cdist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const light = (h) => { const [r, g, b] = rgb(h); return 0.299 * r + 0.587 * g + 0.114 * b > 160; };
  function teamColors() {
    const hc = (COLORS[S.home] || ['#1f5fbf'])[0], ac = COLORS[S.away] || ['#2b2f36', '#2b2f36'];
    return { home: hc, away: cdist(hc, ac[0]) < 130 ? ac[1] : ac[0] };
  }
  const W = 50, H = 47, LEN = 94, RIM = { x: 25, y: H - 5.25 }, R3 = 23.75, VIEW = window.innerWidth < 480 ? 50 : 62;
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
        const col = teamColors()[side], ci = svgEl('circle', { r: 1.35 });
        ci.style.fill = col; if (light(col)) ci.style.stroke = '#1b1b1b';
        g.append(ci, svgEl('text', { y: -1.9, 'text-anchor': 'middle' }));
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
  const FAST_KEY = `${STORE}:fast`;
  const tempo = () => (REDUCED || load(FAST_KEY, false) ? 0.5 : 1);        // (double speed: reduced motion, or the player's own choice)
  function tween(seg) {
    return new Promise((resolve) => {
      const from = { home: court.pos.home.map((p) => p.slice()), away: court.pos.away.map((p) => p.slice()) }, b0 = court.bpos.slice(), c0 = court.clock;
      const ms = skipNow ? 0 : seg.ms * tempo(), t0 = performance.now();
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
        if (seg.secs) { court.clock = Math.max(0, c0 - seg.secs * k); $('bclock').textContent = clockText(court.clock); shotShow(); }
        place(dt);
        if (k < 1) requestAnimationFrame(frame); else finish();
      };
      requestAnimationFrame(frame);
    });
  }
  // the shot clock on the board during a play: what it was when the possession started, run down with the game clock
  // (off when the game clock is under it)
  function shotShow() {
    const e = $('bshot');
    if (!e || court.shot0 == null) return;
    const left = Math.max(0, court.shot0 - (court.clock0 - court.clock));
    e.textContent = court.clock <= left ? 'shot clock off' : `shot clock ${Math.ceil(left)}`;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, skipNow ? 0 : ms * tempo()));
  const SOUND_KEY = `${STORE}:sound`;
  let AC = null;
  function sound(kind) {
    if (!load(SOUND_KEY, false) || skipNow) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      const t = AC.currentTime, g = AC.createGain(); g.connect(AC.destination);
      const tone = (type, f, d, v, f2) => { const o = AC.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d); o.connect(g); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.start(t); o.stop(t + d); };
      if (kind === 'swish') { const n = AC.createBufferSource(), b = AC.createBuffer(1, AC.sampleRate * 0.35, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length); n.buffer = b; const f = AC.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500; n.connect(f); f.connect(g); g.gain.setValueAtTime(0.25, t); n.start(t); }
      else if (kind === 'clank') tone('square', 420, 0.18, 0.12, 300);
      else if (kind === 'whistle') tone('sine', 2900, 0.45, 0.12, 2700);
      else if (kind === 'buzzer') tone('sawtooth', 110, 1.0, 0.15);
    } catch (e) { /* no audio */ }
  }
  function badge(text, cls) {
    court.badge.textContent = text || ''; court.badge.setAttribute('class', `badge${cls ? ` ${cls}` : ''}`);
    if (!text) return;
    if (/^\+|AND ONE/.test(text)) sound('swish');
    else if (/MISS/.test(text)) sound('clank');
    else if (/HORN|FINAL|WIN/.test(text)) sound('buzzer');
    else if (/FOUL|STEAL|TURNOVER|TIMEOUT|TRAVEL|OUT OF/.test(text)) sound('whistle');
  }
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
    court.clock0 = endEv.clock0; court.shot0 = startEv.shot != null ? startEv.shot : SHOT; shotShow();
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
        } else if (e.dead) {
          badge(e.kind === 'ofoul' ? 'OFFENSIVE FOUL' : e.kind === 'travel' ? 'TRAVEL' : 'OUT OF BOUNDS', 'foul'); caption(last());
          if (e.kind === 'oob') await tween({ ms: 700, ball: { to: [from[0] < 25 ? -1.5 : W + 1.5, from[1] - 3], arc: 0.5 } });
          await wait(1200);
          badge('');
          const g = nearest(def, court.bpos);
          await tween({ ms: 600, moves: [{ side: def, i: g, to: [court.bpos[0] - 0.9, court.bpos[1] - 0.3] }], ball: { to: court.bpos.slice(0, 2), catch: { side: def, i: g } } });
          await otherWay(def, g, true);
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
        await tween({ ms: 1100, moves, ball: { to: hand([25, H - 19 - 0.6]), arc: 0.6, catch: { side: off, i: who } } });
        for (let k = 0; k < e.made.length; k++) {
          await tween({ ms: 800, dribble: true });                        // the routine: the bounces at the line
          await wait(250);
          await tween({ ms: 1000, ball: { to: [RIM.x, RIM.y], arc: 2.6 } });
          if (e.made[k]) { swish(); badge('+1', 'score'); drawBoard(); $('bclock').textContent = clockText(court.clock); await tween({ ms: 380, ball: { to: [RIM.x, RIM.y + 1.6], arc: 0, rest: -1.3 } }); await tween({ ms: 520, ball: { to: [RIM.x + 1.2, RIM.y + 2.6], arc: 0.4 } }); }
          else { badge('MISS', 'miss'); await tween({ ms: 600, ball: { to: [RIM.x + (k % 2 ? -2.6 : 2.6), RIM.y - 3], arc: 0.9 } }); }
          await hold(600);
          if (k < e.made.length - 1) { await tween({ ms: 600, ball: { to: hand(court.pos[off][who]), arc: 0.4, catch: { side: off, i: who } } }); }
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

  // ---- the social layer: the real coaches, what the real bench called, the day's players (board/worker.js /hoops/*) ------
  const API = (document.querySelector('meta[name="board-api"]') || {}).content || '';
  const FB = 'tmd:v3';                                     // the football game's keys: the same device, name and account
  function deviceKey() {
    let k = load(`${FB}:boardkey`, '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(k)) { const b = new Uint8Array(18); crypto.getRandomValues(b); k = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); save(`${FB}:boardkey`, k); }
    return k;
  }
  const myName = () => String(load(`${FB}:name`, '') || load(`${FB}:username`, '') || '').slice(0, 24);
  const session = () => { const t = String(load(`${FB}:session`, '') || ''); return /^[0-9a-f]{64}$/.test(t) ? t : ''; };
  async function api(path, body) {
    if (!API) return null;
    try {
      const r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  const coachOf = (side) => (spot.coaches || [])[side === 'home' ? 0 : 1] || '';
  const lastOf = (n) => String(n || '').split(' ').slice(-1)[0];
  // what the real bench did with the ball you take over: the first thing it did (a timeout, the shot it took, a drive,
  // a turnover), read off the play-by-play as one of the calls you had
  function realCall(sp) {
    const me = sp.me, t0 = sp.clock;
    for (const e of sp.real || []) {
      if (e.team !== me) continue;
      const x = String(e.text || ''), used = t0 - (e.t == null ? t0 : e.t);
      if (/Timeout/i.test(x)) { const nx = (sp.real || []).find((f) => f.team === me && f !== e && /Shot|Layup|Dunk|3PT/i.test(f.text || '')); return nx && /3PT/.test(nx.text) ? 'tthree' : 'tquick'; }
      if (/3PT/.test(x)) return used <= 7 ? 'quick' : 'three';
      if (/Layup|Dunk|Driving|Tip|Alley/i.test(x) || /Free Throw/i.test(x)) return 'rim';
      if (/Shot|Jumper|Turnover|Foul/i.test(x)) return sp.clock <= SHOT + 6 && (e.t || 0) <= 4 ? 'last' : used <= 7 ? 'quick' : 'work';
    }
    return null;
  }
  // a coarse key of a decision's spot, so players meet in the crowd's counts: the first call is everyone's spot; later ones
  // by the margin, the clock in 15-second bands and whose ball (worker.js HSIT_RE)
  function crowdKey(i, S) {
    if (i === 0) return '0';
    const ld = lead(S, S.me), m = ld <= -4 ? 'd4' : ld < 0 ? `d${-ld}` : ld === 0 ? 't' : ld < 4 ? `u${ld}` : 'u4';
    return `${Math.min(i, 99)}.${m}.c${Math.min(9, Math.floor(S.clock / 15))}.${S.poss === S.me ? 'o' : 'x'}`;
  }
  let CROWD = null;                                         // today's crowd's calls, { <key>: { n, c } }
  function crowdLine(key, k) {
    const x = CROWD && CROWD[key];
    if (!x || !x.n) return '';
    const pct = Math.round(100 * (x.c[k] || 0) / x.n);
    return `${pct}% of ${x.n} players called this`;
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
    const sp = el('span', '', `${periodText(S.period)} · `), sh = el('span', '', S.clock > SHOT ? `shot clock ${S.shot}` : 'shot clock off'); sh.id = 'bshot'; sp.append(sh);
    c.append(bc, sp);
    b.append(c);
  }
  function renderIntro(practice) {
    const box = $('card'); box.textContent = ''; $('dock').textContent = ''; caption('');
    box.append(el('div', 'eyebrow', practice ? 'Practice game' : `Day ${dayN()} · today's game`),
      el('h2', '', `${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('p', 'lead', `${spot.season}–${String(spot.season + 1).slice(2)} season. ${situation(S)}. You coach ${teamCity(teamOf(S, S.me))}${coachOf(S.me) ? `, in ${coachOf(S.me)}'s seat, against ${coachOf(other(S.me)) || 'their bench'}` : ''}.`),
      el('p', 'note', `Timeouts: you ${S.to[S.me]}, they ${S.to[other(S.me)]}. ${inBonus(S, other(S.me)) ? 'They are in the bonus: any foul on you is two free throws. ' : ''}${inBonus(S, S.me) ? 'You are in the bonus: any foul on them is two free throws.' : ''}`));
    if (spot.lead) box.append(el('p', 'note', `How it got here: ${byCity(spot.lead)}.`));
    const q = new URLSearchParams(location.search), vs = Number(q.get('vs'));
    if (!practice && q.has('vs') && vs >= 0 && vs <= 100) box.append(el('p', 'challenge', `${String(q.get('by') || 'A friend').slice(0, 24)} scored ${Math.round(vs)} on today's game. Beat it.`));
    if (coachOf(S.me)) box.append(el('p', 'note', `Can you do better than ${coachOf(S.me)} did?`));
    const first = !Object.keys(load(`${STORE}:stats`, { days: {} }).days).length && !load(`${STORE}:guided`, false);
    const guide = el('details', 'guide'); guide.open = first;
    guide.append(el('summary', '', 'What the calls mean'));
    const gl = el('ul', '');
    [['Go now', 'Push it and take the first good shot.'], ['Work for a shot', 'Run the offense and use the clock for a better look.'], ['Hunt a three', 'Everything for a three-pointer.'],
      ['Attack the rim', 'Drive it: the best percentage, and fouls.'], ['Hold for the last shot', 'Late in a period, shoot with two or three seconds left so they never get it back.'],
      ['Two-for-one', 'With 30 to 45 seconds left, shoot early so you get the ball again.'], ['Timeout', 'Stops the clock and moves the ball to the frontcourt.'],
      ['Who gets it', 'Pick the man you want shooting, or let the play find the open man.'], ['On defense', 'Play it straight; foul to stop the clock when you trail; press to gamble for a steal.'],
      ['Grading', 'Each call is measured against the best one in that spot, by win chance. Skip any play, or run them at double speed.']]
      .forEach(([a, b]) => { const li = el('li', ''); li.append(el('b', '', `${a}: `), document.createTextNode(b)); gl.append(li); });
    guide.append(gl); box.append(guide);
    const go = el('button', 'btn big', 'Take over'); go.type = 'button';
    go.addEventListener('click', () => save(`${STORE}:guided`, true));
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
    if (mine) {                                              // who gets it: anyone (the play's own read), or a man you call for
      const who = el('div', 'who'), lab = el('span', 'wl', 'Who gets it'), chips = el('div', 'chips');
      const chip = (i, text, sub) => {
        const b = el('button', `chip${PICK === i ? ' on' : ''}`); b.type = 'button'; b.append(el('b', '', text)); if (sub) b.append(el('span', '', sub));
        b.addEventListener('click', () => { PICK = i; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); b.classList.add('on'); });
        chips.append(b);
      };
      chip(null, 'Anyone', 'the open man');
      FIVE[S.me].forEach((n, i) => { const pl = playerOf(S, S.me, i); chip(i, lastName(n), pl ? `${Math.round(100 * pl.p3)}% from 3 · ${Math.round(100 * pl.ft)}% FT` : ''); });
      who.append(lab, chips); dock.append(who);
    }
  }
  let PICK = null;                                           // the man the next call goes to (null: anyone)
  function note(t) { G.lines.push(t); }
  async function call(k, opts, mine, live) {
    if (busy) return;
    busy = true;
    const i = G.decs.length, seed = hash(G.seed, 'd', i);
    if (live) {
      const dock = $('dock'); dock.textContent = '';
      const cl = !G.practice ? crowdLine(crowdKey(G.decs.length, S), k) : '';
      const row = el('div', 'playing'); row.append(el('span', 'sit', `${(mine ? APPROACH : DEFENSE)[k].label}…${cl ? ` ${cl}` : ''}`));
      const skip = el('button', 'btn ghostbtn small', 'Skip the play ›'); skip.type = 'button'; skip.addEventListener('click', () => { skipNow = true; });
      const fast = el('button', 'btn ghostbtn small', load(FAST_KEY, false) ? 'Speed: 2×' : 'Speed: 1×'); fast.type = 'button';
      fast.addEventListener('click', () => { const v = !load(FAST_KEY, false); save(FAST_KEY, v); fast.textContent = v ? 'Speed: 2×' : 'Speed: 1×'; });
      const snd = el('button', 'btn ghostbtn small', load(SOUND_KEY, false) ? 'Sound: on' : 'Sound: off'); snd.type = 'button';
      snd.addEventListener('click', () => { const v = !load(SOUND_KEY, false); save(SOUND_KEY, v); snd.textContent = v ? 'Sound: on' : 'Sound: off'; });
      row.append(skip, fast, snd); dock.append(row);
      const top = $('board').getBoundingClientRect().top;                 // the board and the court in view for the play
      if (top < 0 || top > 60) window.scrollTo({ top: window.scrollY + top - 8, behavior: REDUCED ? 'auto' : 'smooth' });
    }
    if (mine && PICK != null) S.pick = PICK;
    const pick = mine ? PICK : null; PICK = null;
    const ctx = { ld: lead(S, S.me), clock: S.clock, bonusMe: inBonus(S, other(S.me)), bonusThem: inBonus(S, S.me), to: S.to[S.me] };
    // the grade: every option's win chance from here, the same bounces each
    const wp = evaluate(S, mine ? 'off' : 'def', opts, seed, N_EVAL), best = opts.reduce((a, b) => (wp[b] > wp[a] ? b : a));
    const typ = mine ? typicalOffense(S, rng(1)).weights : typicalDefense(S, rng(1)).weights;
    G.decs.push({ i, side: mine ? 'off' : 'def', situation: situation(S), ck: crowdKey(i, S), ctx, pick, chosen: k, best, wp: wp[k], bestWp: wp[best], cost: Math.max(0, wp[best] - wp[k]),
      opts: opts.map((o) => ({ k: o, label: (mine ? APPROACH : DEFENSE)[o].label, wp: wp[o], q: typ[o] || 0 })) });
    // the possession, with the other bench typical, on the day's own bounces
    if (pick != null) S.pick = pick;
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
    // the field of coaches making the same decisions: the mix real benches use in each spot most of the time, any of
    // the calls the rest (benches are a spread, and a grade that puts two small misses under every coach alive is not
    // a grade); how many would have given up more win chance than you did in total
    const mine = decs.reduce((a, x) => a + x.cost, 0), r = rng(hash(G.seed, 'pct')), N = 4000, ANY = 0.4;
    let worse = 0;
    for (let s = 0; s < N; s++) {
      let tot = 0;
      for (const x of decs) {
        const ks = x.opts.filter((o) => o.q > 0), tq = ks.reduce((a, o) => a + o.q, 0);
        let pick = x.opts[0];
        if (tq > 0 && r() >= ANY) { let z = r() * tq; for (const o of ks) { z -= o.q; if (z <= 0) { pick = o; break; } } }
        else pick = x.opts[Math.floor(r() * x.opts.length)];
        tot += Math.max(0, x.bestWp - pick.wp);
      }
      if (tot > mine + 1e-9) worse++; else if (Math.abs(tot - mine) <= 1e-9) worse += 0.5;
    }
    return worse / N;
  }
  // why the best call was the best, in a coach's words, from the spot's facts (the margin, the clock, the bonus)
  function explain(x) {
    const c = x.ctx || {}, ld = c.ld || 0, clk = clockText(c.clock || 0), lab = (k) => (x.opts.find((o) => o.k === k) || {}).label || k;
    const why = {
      foul: `Down ${-ld} with ${clk} left, fouling stops the clock: their free throws for your next possession.`,
      straight: ld > 0 ? `Up ${ld}, a stop without a foul lets the clock run; a foul hands them free points and the clock back.` : 'Making them earn a basket here beats gambling for the ball.',
      press: `Behind with ${clk} left, the press risks an easy basket for the chance at a turnover.`,
      rim: `A drive is the best shot here: shots at the rim go in more and draw fouls${c.bonusMe ? ', and in the bonus every foul is two free throws' : ''}.`,
      three: ld <= -3 ? `Down ${-ld}, a two doesn't tie it. The three does.` : 'The extra point is worth the lower percentage from this spot.',
      work: ld > 0 ? `Up ${ld}, a full possession burns clock and leaves them less time.` : 'A set play gets a better shot than the first look.',
      last: 'With the game clock under the shot clock, holding for the last shot means they never get the ball back.',
      quick: ld < 0 ? `Down ${-ld} with ${clk} left, you need extra possessions: shoot early.` : 'An early look beats a set defense here.',
      tquick: 'The timeout moves the ball to the frontcourt and saves seconds, worth more than keeping it.',
      tthree: 'The timeout moves the ball up and sets up a clean look from three.',
      two4one: 'Shooting early here gets you two shots to their one before the period ends.',
    }[x.best] || '';
    const yours = x.best !== x.chosen ? ` Your call kept ${(x.wp * 100).toFixed(1)}% win chance; ${lab(x.best).toLowerCase()} ${(x.bestWp * 100).toFixed(1)}%.` : '';
    return (why + yours).trim();
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
    const realMine = spot.me === spot.home ? spot.final[0] - spot.final[1] : spot.final[1] - spot.final[0];
    const myMargin = lead(S, S.me), vsCoach = Math.sign(myMargin - realMine), coach = coachOf(S.me);
    let fresh = false;
    if (G.score == null) {
      G.score = Math.round(percentile(decs) * 100); G.won = won; G.margin = margin; G.done = true; saveGame(); fresh = true;
      if (!G.practice) { const st = load(`${STORE}:stats`, { days: {} }); if (!st.days[dayISO()]) { st.days[dayISO()] = { score: G.score, won, vs: vsCoach }; save(`${STORE}:stats`, st); } }
    }
    box.append(el('div', 'eyebrow', G.practice ? 'Practice game' : `Day ${dayN()} · ${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('div', 'big', String(G.score)), el('div', 'pct-lab', `Better than ${G.score}% of coaches`),
      el('p', 'note', `The score is your calls, not the result: each one measured against the best option in that spot, the misses added up (${(decs.reduce((a, x) => a + x.cost, 0) * 100).toFixed(1)} points of win chance in all) and placed among a field of coaches making the same calls. Tap a call for every option's win chance.`),
      el('h2', '', `${won ? 'You won' : margin === 0 ? 'Tied' : 'You lost'} ${S.score[S.me]}–${S.score[other(S.me)]}${S.period > 4 ? ' in overtime' : ''}`),
      el('p', 'note', `The real game: ${teamCity(teamOf(S, S.me))} ${realMine > 0 ? 'won' : realMine < 0 ? 'lost' : 'tied'} ${Math.abs(realMine) ? `by ${Math.abs(realMine)}` : ''} (${spot.final[1]}–${spot.final[0]} ${teamCity(spot.away)} at ${teamCity(spot.home)}).`));
    if (coach) {
      const vsBox = el('div', `vs ${vsCoach > 0 ? 'better' : vsCoach < 0 ? 'worse' : 'same'}`);
      const fmt = (m) => (m > 0 ? `Won by ${m}` : m < 0 ? `Lost by ${-m}` : 'Tied');
      vsBox.append(el('div', 'vsh', `You vs ${coach}`), el('div', 'vsr', `${vsCoach > 0 ? 'You did better' : vsCoach < 0 ? `${lastOf(coach)} did better` : 'Dead even'}`),
        el('div', 'vsl', `You: ${fmt(myMargin)} · ${lastOf(coach)}: ${fmt(realMine)}`));
      box.append(vsBox);
    }
    const daybox = el('div', 'today'); box.append(daybox);
    if (!G.practice) dayNumbers(daybox, fresh, vsCoach);
    const list = el('ol', 'calls');
    for (const x of decs) {
      const li = el('li', markOf(x.cost)), det = el('details', 'call'), sm = el('summary', '');
      sm.append(el('span', 'sq', { g: '✓', y: '~', r: '✗' }[markOf(x.cost)]), el('span', 'sit', x.situation), el('span', 'what', `You: ${x.opts.find((o) => o.k === x.chosen).label}${x.cost >= 0.01 ? ` · best: ${x.opts.find((o) => o.k === x.best).label} (${(x.cost * 100).toFixed(1)} pts of win chance)` : ''}`));
      const all = el('ul', 'wps');
      const ex = explain(x); if (ex) all.append(el('li', 'why', ex));
      if (x.pick != null) all.append(el('li', '', `You called for ${lastName(FIVE[S.me][x.pick] || '')}.`));
      if (x.i === 0 && G.realCall && x.opts.some((o) => o.k === G.realCall)) all.append(el('li', 'realc', `${coach || 'The real bench'} went: ${x.opts.find((o) => o.k === G.realCall).label}`));
      const cl = !G.practice && x.ck ? crowdLine(x.ck, x.chosen) : '';
      if (cl) all.append(el('li', 'crowd', cl));
      for (const o of [...x.opts].sort((a, b) => b.wp - a.wp)) all.append(el('li', o.k === x.chosen ? 'mine' : '', `${o.label}: ${(o.wp * 100).toFixed(1)}% to win${o.k === x.chosen ? ' (yours)' : ''}${o.k === x.best ? ' · best' : ''}`));
      det.append(sm, all); li.append(det); list.append(li);
    }
    box.append(el('h3', '', 'Your calls'), list);
    const worst = decs.filter((x) => x.cost >= 0.01).sort((a, b) => b.cost - a.cost)[0];
    if (worst) box.append(el('p', 'verdict', `What cost the most: ${worst.situation}. You called ${worst.opts.find((o) => o.k === worst.chosen).label.toLowerCase()}; ${worst.opts.find((o) => o.k === worst.best).label.toLowerCase()} was the call there, ${(worst.cost * 100).toFixed(1)} points of win chance better. ${explain(worst).split(' Your call')[0]}`));
    else box.append(el('p', 'verdict', 'Every call the best or close to it. That is a coach.'));
    const mine = el('div', 'real'); mine.append(el('h3', '', 'How your game went'));
    const ul = el('ul', ''); for (const t of G.lines) ul.append(el('li', '', t)); mine.append(ul); box.append(mine);
    const real = el('div', 'real'); real.append(el('h3', '', 'What really happened'));
    const rl = el('ul', '');
    for (const e of (spot.real || []).slice(0, 40)) rl.append(el('li', '', `${e.t != null ? `${clockText(e.t)}${e.p > 4 ? ' OT' : ''} · ` : ''}${byCity(e.text)}${e.score ? ` · ${e.score[1]}–${e.score[0]}` : ''}`));
    real.append(rl); box.append(real);
    if (!G.practice) { const st = load(`${STORE}:stats`, { days: {} }); box.append(el('p', 'streak', `🔥 ${streakOf(st)} day${streakOf(st) === 1 ? '' : 's'} in a row · come back tomorrow for a new game`)); }
    const row = el('div', 'row');
    const share = el('button', 'btn', G.practice ? 'Share' : 'Share · challenge a friend'); share.type = 'button';
    share.addEventListener('click', async () => {
      const nm = myName(), link = `https://2mindrills.com/hoops?vs=${G.score}${nm ? `&by=${encodeURIComponent(nm)}` : ''}`;
      const text = `Two-Minute Drill: Hoops #${dayN()}\n${G.score} · better than ${G.score}% of coaches\n${decs.map((x) => ({ g: '🟩', y: '🟨', r: '🟥' }[markOf(x.cost)])).join('')}\n${won ? 'Won' : 'Lost'} ${S.score[S.me]}–${S.score[other(S.me)]}${coach ? ` · vs ${lastOf(coach)}: ${vsCoach > 0 ? 'better' : vsCoach < 0 ? 'worse' : 'even'}` : ''}\nCan you beat it? ${link}`;
      try { await navigator.clipboard.writeText(text); share.textContent = 'Copied'; } catch (e) { share.textContent = text; }
    });
    const again = el('button', 'btn ghostbtn', 'Play another game (practice)'); again.type = 'button';
    again.addEventListener('click', () => start(true));
    const home = el('a', 'btn ghostbtn', 'Home'); home.href = './';
    row.append(share, again, home); box.append(row);
    box.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  }
  async function dayNumbers(box, fresh, vsCoach) {
    if (!API) return;
    const body = { date: dayISO(), key: deviceKey(), score: G.score, won: !!G.won, vs: vsCoach, calls: G.decs.filter((x) => x.ck).map((x) => [x.ck, x.chosen]),
      ...(myName() ? { name: myName() } : {}), ...(session() ? { session: session() } : {}) };
    const v = await api('/hoops/day', body);
    if (!v) return;
    if (v.calls) CROWD = v.calls;
    box.textContent = '';
    const beat = v.n ? Math.round(100 * (v.vs[2] || 0) / v.n) : 0;
    box.append(el('h3', '', "Today's players"), el('p', '', `${v.n} played today · average ${v.avg ?? '–'}${v.you ? ` · you're #${v.you.rank}` : ''} · ${beat}% beat their real coach`));
    if (v.top && v.top.length) {
      const ol = el('ol', 'top');
      v.top.slice(0, 10).forEach((r) => ol.append(el('li', r.name === myName() ? 'me' : '', `${r.name} · ${r.score}`)));
      box.append(ol);
    }
    if (!myName()) {
      const f = el('form', 'nameform'), inp = el('input'), b = el('button', 'btn small', 'Put my name on the list');
      inp.id = 'hoops-name'; inp.maxLength = 24; inp.placeholder = 'Your name'; b.type = 'submit';
      f.append(inp, b);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); const n = inp.value.trim().slice(0, 24); if (!n) return;
        save(`${FB}:name`, n); dayNumbers(box, false, vsCoach);
      });
      box.append(f);
    }
    syncStats();
  }
  // signed in (the football game's account): the Hoops record follows it, both ways, the higher score of a day kept
  async function syncStats() {
    if (!session()) return;
    const st = load(`${STORE}:stats`, { days: {} }), r = await api('/hoops/stats', { session: session(), days: st.days });
    if (r && r.days) { st.days = { ...st.days, ...r.days }; save(`${STORE}:stats`, st); }
  }
  function saveGame() { if (!G.practice) save(dayKey(), { seed: G.seed, spotId: spot.id, decs: G.decs.map((x) => x.chosen), graded: G.decs, done: G.done, score: G.score, lines: G.lines, started: G.started }); }
  // a saved call replayed: the possession on the day's own bounces, the grade from the save (none: graded again)
  function replay(k, opts, mine, graded) {
    const i = G.decs.length;
    if (graded && graded.chosen === k) G.decs.push(graded);
    else {
      const wp = evaluate(S, mine ? 'off' : 'def', opts, hash(G.seed, 'd', i), N_EVAL), best = opts.reduce((a, b) => (wp[b] > wp[a] ? b : a));
      const typ = mine ? typicalOffense(S, rng(1)).weights : typicalDefense(S, rng(1)).weights;
      G.decs.push({ i, side: mine ? 'off' : 'def', situation: situation(S), chosen: k, best, wp: wp[k], bestWp: wp[best], cost: Math.max(0, wp[best] - wp[k]), opts: opts.map((o) => ({ k: o, label: (mine ? APPROACH : DEFENSE)[o].label, wp: wp[o], q: typ[o] || 0 })) });
    }
    if (graded && graded.pick != null) S.pick = graded.pick;
    const r = rng(hash(G.seed, 'p', i));
    const a = mine ? k : typicalOffense(S, r).pick, d = mine ? typicalDefense(S, r).pick : k;
    for (const t of possession(S, r, a, d, null)) G.lines.push(t);
  }
  // today's game, or a practice one; a day's saved game is replayed from its calls (the same seed: the same bounces), no animation
  async function start(practice) {
    spot = pickSpot(practice); S = newState(spot);
    FIVE = { home: (spot.players && spot.players.home || []).slice(0, 5), away: (spot.players && spot.players.away || []).slice(0, 5) };
    while (FIVE.home.length < 5) FIVE.home.push(`${teamCity(spot.home)} ${FIVE.home.length + 1}`);
    while (FIVE.away.length < 5) FIVE.away.push(`${teamCity(spot.away)} ${FIVE.away.length + 1}`);
    G = { seed: practice ? (Math.random() * 1e9) >>> 0 : hash('hoops', dayISO(), spot.id), decs: [], lines: [], practice: !!practice, done: false, score: null, started: false, realCall: realCall(spot) };
    if (!practice && !CROWD) api(`/hoops/day?date=${dayISO()}`).then((v) => { if (v && v.calls) CROWD = v.calls; });
    drawCourt(); badge(''); caption('');
    const saved = practice ? null : load(dayKey(), null);
    if (saved && saved.spotId === spot.id) {
      G.seed = saved.seed; G.started = saved.started;
      saved.decs.forEach((k, n) => {
        if (S.over) return;
        if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) return; note(t); }
        const mine = S.poss === S.me, opts = mine ? offenseOptions(S) : Object.keys(DEFENSE);
        if (!opts.includes(k)) return;
        replay(k, opts, mine, saved.graded && saved.graded[n]);
      });
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
    box.append(el('div', 'eyebrow', 'Hoops beta · part of Pro'), el('h2', '', 'The last two minutes of a real basketball game, every day'),
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
    syncStats();
    start(false);
  }
  boot();
})();
