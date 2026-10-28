/* Two-Minute Drill: Hoops. The last two minutes of a real basketball game: you coach one team, possession by possession,
   against the clock, the bonus and the other bench. Every call is graded on win chance (simulating the rest of the game
   for every option, hoops_data.json: rates fit from two seasons of play-by-play), placed among typical coaches, and the
   real game's ending is shown beside yours. One spot a day (the schedule in the data), the same for everyone. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const STORE = 'tmd:hoops';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  const pad = (n) => String(n).padStart(2, '0');
  const clockText = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}` : s.toFixed(1));
  const periodText = (p) => (p <= 4 ? `${p}${['st', 'nd', 'rd', 'th'][Math.min(p, 4) - 1]} quarter` : p === 5 ? 'Overtime' : `${p - 4}nd overtime`.replace('2nd', '2nd').replace('3nd', '3rd'));
  // the day: local midnight, as the football daily (everyone on the same date gets the same spot)
  const dayISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function hash(...parts) { let h = 2166136261 >>> 0; for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---- the engine: a late-game possession, the way the data says they go ----------------------------------------------
  // The offense picks an approach (what the player calls on offense), the defense an answer (what the player calls on
  // defense); the rest is the data's rates with small, football-logic modifiers for each approach (set once here, the
  // same for the grading and the game).
  const APPROACH = {
    quick: { label: 'Go now', sub: 'Push it, take the first good look', t: [2, 7], three: 0.3, p2: -0.03, p3: -0.02, to: 0.9, foul: 1.0 },
    work: { label: 'Work for a good shot', sub: 'Run the offense, use most of the shot clock', t: [12, 22], three: null, p2: 0.02, p3: 0.01, to: 1.0, foul: 1.0 },
    three: { label: 'Hunt a three', sub: 'Everything for the three-point look', t: [4, 12], three: 0.88, p2: 0, p3: -0.04, to: 0.9, foul: 0.7 },
    rim: { label: 'Attack the rim', sub: 'Drive it, draw the foul', t: [4, 11], three: 0.06, p2: 0.04, p3: 0, to: 1.1, foul: 2.0 },
    last: { label: 'Hold for the last shot', sub: 'Shoot with two or three seconds left', t: null, three: null, p2: 0.01, p3: 0, to: 1.0, foul: 0.8 },
    tquick: { label: 'Timeout, then attack', sub: 'Advance the ball, set a play, go', t: [3, 8], three: 0.35, p2: 0.02, p3: 0.02, to: 0.85, foul: 1.1, timeout: true },
    tthree: { label: 'Timeout, set up a three', sub: 'Advance the ball, draw it up for a three', t: [3, 8], three: 0.9, p2: 0, p3: -0.01, to: 0.85, foul: 0.7, timeout: true },
  };
  const DEFENSE = {
    straight: { label: 'Play it straight', sub: 'Defend the possession' },
    foul: { label: 'Foul right away', sub: 'Stop the clock, send them to the line' },
    press: { label: 'Press and trap', sub: 'Go for the turnover, risk the easy basket' },
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
      home: spot.home, away: spot.away, me: spot.me === spot.home ? 'home' : 'away', dead: true, over: false, log: [] };
  }
  const lead = (S, side) => S.score[side] - S.score[other(side)];
  const teamOf = (S, side) => (side === 'home' ? S.home : S.away);
  // one free-throw trip: n shots; the last one missed is live
  function freeThrows(S, r, side, n, shooter) {
    const p = rate(teamOf(S, side), 'ft'), made = [];
    for (let i = 0; i < n; i++) made.push(r() < p);
    const m = made.filter(Boolean).length;
    S.score[side] += m;
    if (made[n - 1]) { S.poss = other(side); S.shot = SHOT; S.dead = true; return { text: `${shooter} makes ${m} of ${n} free throw${n > 1 ? 's' : ''}`, m, n, live: false }; }
    if (r() < L.oreb_ft) { S.poss = side; S.shot = SHOT_OREB; S.dead = false; return { text: `${shooter} ${m ? `makes ${m} of ${n}, ` : ''}misses the last free throw, the offense gets the rebound`, m, n, live: true }; }
    S.poss = other(side); S.shot = SHOT; S.dead = false; S.clock = Math.max(0, S.clock - 1.5);
    return { text: `${shooter} ${m ? `makes ${m} of ${n}, ` : ''}misses the last free throw, rebound ${teamCity(teamOf(S, other(side)))}`, m, n, live: true };
  }
  // the men who take the shots and the free throws, by their shares (the spot's names when the data has them)
  function shooter(S, side, kind, r) {
    const t = T[teamOf(S, side)], ps = (t && t.players) || [];
    if (!ps.length) return teamCity(teamOf(S, side));
    const key = kind === 3 ? 'att3' : kind === 'ft' ? 'fta' : 'att2';
    let x = r() * ps.reduce((a, p) => a + (p[key] || 0), 0);
    for (const p of ps) { x -= p[key] || 0; if (x <= 0) return p.name; }
    return ps[0].name;
  }
  const teamCity = (abbr) => (T[abbr] && T[abbr].city) || abbr;
  // one possession of side S.poss with the offense's approach a and the defense's answer d; returns the lines it made
  function possession(S, r, a, d) {
    const off = S.poss, def = other(off), A = APPROACH[a], lines = [];
    if (A.timeout) { if (S.to[off] > 0) { S.to[off]--; lines.push(`${teamCity(teamOf(S, off))} calls timeout, the ball comes to the frontcourt`); } }
    // a foul before the shot: the defense stopping the clock (in the bonus: two free throws; else the ball inbounded with a second gone)
    if (d === 'foul') {
      const t = u(r, 0.5, 2.5); S.clock = Math.max(0, S.clock - t); S.fouls[def]++; S.fouls2[def]++;
      if (inBonus(S, def)) { const ft = freeThrows(S, r, off, 2, shooter(S, off, 'ft', r)); lines.push(`${teamCity(teamOf(S, def))} fouls on purpose: ${ft.text}`); return lines; }
      lines.push(`${teamCity(teamOf(S, def))} fouls on purpose, not in the bonus yet: ${teamCity(teamOf(S, off))} inbounds again`); S.dead = true; return lines;
    }
    // when the shot goes up
    let t;
    if (a === 'last') t = Math.max(1, S.clock - u(r, 1.5, 4));
    else t = u(r, A.t[0], A.t[1]);
    const press = d === 'press';
    if (press) t = Math.max(1, t - 1);
    t = Math.min(t, S.shot, S.clock);
    const toP = L.to * A.to * (press ? 1.6 : 1);
    if (r() < toP) { S.clock = Math.max(0, S.clock - u(r, 1, t)); lines.push(`${teamCity(teamOf(S, off))} turns it over${press ? ' against the press' : ''}`); S.poss = def; S.shot = SHOT; S.dead = false; return lines; }
    S.clock = Math.max(0, S.clock - t);
    const need = lead(S, off);                                 // (a team down three with no time hunts the three whatever was called)
    let three = A.three == null ? rate(teamOf(S, off), 'share3') : A.three;
    if (S.clock <= 0 && need < 0 && need >= -3 && a !== 'three') three = need === -3 ? 0.95 : three;
    const isThree = r() < three, kind = isThree ? 3 : 2, who = shooter(S, off, kind, r);
    const foulP = (isThree ? L.foul3 : L.foul2) * A.foul;
    if (r() < foulP) {
      S.fouls[def]++; S.fouls2[def]++;
      if (!isThree && r() < L.and1) { S.score[off] += 2; const ft = freeThrows(S, r, off, 1, who); lines.push(`${who} scores through the foul, and one: ${ft.m ? 'makes' : 'misses'} the free throw`); return lines; }
      const ft = freeThrows(S, r, off, isThree ? 3 : 2, who); lines.push(`${who} is fouled ${isThree ? 'on a three' : 'going up'}: ${ft.text}`); return lines;
    }
    let p = rate(teamOf(S, off), isThree ? 'p3' : 'p2') + (isThree ? A.p3 : A.p2) + (press ? 0.03 : 0);
    if (r() < p) { S.score[off] += kind; lines.push(`${who} ${isThree ? 'hits the three' : kind === 2 && r() < 0.5 ? 'scores at the rim' : 'hits the jumper'}`); S.poss = def; S.shot = SHOT; S.dead = true; return lines; }
    if (S.clock <= 0) { lines.push(`${who} misses ${isThree ? 'the three' : 'the shot'} at the horn`); return lines; }
    if (r() < rate(teamOf(S, off), 'oreb')) { S.shot = SHOT_OREB; S.dead = false; S.clock = Math.max(0, S.clock - u(r, 1, 2.5)); lines.push(`${who} misses ${isThree ? 'the three' : ''}, offensive rebound`); return lines; }
    S.poss = def; S.shot = SHOT; S.dead = false; S.clock = Math.max(0, S.clock - u(r, 0.5, 1.5));
    lines.push(`${who} misses ${isThree ? 'the three' : 'the shot'}, ${teamCity(teamOf(S, def))} rebounds`);
    return lines;
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
      possession(S, r, a, d);
      if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) break; }
    }
    if (!S.over) S.over = true;
    return lead(S, S.me) > 0 ? 1 : 0;
  }
  const clone = (S) => ({ ...S, score: { ...S.score }, to: { ...S.to }, fouls: { ...S.fouls }, fouls2: { ...S.fouls2 }, log: [] });
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

  // ---- the game on the page -------------------------------------------------------------------------------------------
  let D = null, spot = null, S = null, G = null;            // the data, today's spot, the state, the game record
  const dayKey = () => `${STORE}:day:${dayISO()}`;
  const dayN = () => { const a = new Date(2026, 9, 29), b = new Date(); b.setHours(12, 0, 0, 0); a.setHours(12, 0, 0, 0); return Math.max(1, Math.round((b - a) / 864e5) + 1); };
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
      const row = el('div', `tm${side === S.me ? ' me' : ''}`);
      row.append(el('span', 'nm', teamCity(teamOf(S, side)) + (side === S.me ? ' (you)' : '')), el('b', 'sc', String(S.score[side])),
        el('span', 'to', `${'●'.repeat(S.to[side])}${'○'.repeat(Math.max(0, 2 - S.to[side]))}`), el('span', 'fl', inBonus(S, other(side)) ? 'bonus' : `${S.fouls[other(side)]} fouls on them`));
      if (S.poss === side && !S.over) row.classList.add('ball');
      b.append(row);
    }
    const c = el('div', 'clk'); c.append(el('b', '', clockText(S.clock)), el('span', '', `${periodText(S.period)}${S.clock < SHOT && S.poss ? '' : ` · shot clock ${S.shot}`}`));
    b.append(c);
  }
  function renderIntro(practice) {
    const box = $('card'); box.textContent = '';
    box.append(el('div', 'eyebrow', practice ? 'Practice game' : `Day ${dayN()} · today's game`),
      el('h2', '', `${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('p', 'lead', `${spot.season}–${String(spot.season + 1).slice(2)} season. ${situation(S)}. You coach ${teamCity(teamOf(S, S.me))}.`),
      el('p', 'note', `Timeouts: you ${S.to[S.me]}, they ${S.to[other(S.me)]}. ${inBonus(S, other(S.me)) ? 'They are in the bonus: any foul on you is two free throws. ' : ''}${inBonus(S, S.me) ? 'You are in the bonus: any foul on them is two free throws.' : ''}`));
    if (spot.lead) box.append(el('p', 'note', `How it got here: ${spot.lead}.`));
    const go = el('button', 'btn big', 'Take over'); go.type = 'button';
    go.addEventListener('click', () => { G.started = true; saveGame(); step(); });
    box.append(go);
    if (!practice) {
      const st = load(`${STORE}:stats`, { days: {} }), n = Object.keys(st.days).length;
      if (n) box.append(el('p', 'note', `You have played ${n} day${n === 1 ? '' : 's'}. Streak: ${streakOf(st)}.`));
    }
    drawBoard();
  }
  // one decision: the options with the situation, the evaluation done when the call is in (never shown before: the grade is the player's to earn)
  function step() {
    if (S.over) return renderEnd();
    if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) return renderEnd(); note(t); }
    drawBoard();
    const mine = S.poss === S.me, box = $('card'); box.textContent = '';
    box.append(el('div', 'eyebrow', mine ? 'Your ball' : 'Their ball'), el('h2', '', situation(S)));
    const opts = mine ? offenseOptions(S) : Object.keys(DEFENSE), src = mine ? APPROACH : DEFENSE;
    const list = el('div', 'opts');
    for (const k of opts) {
      const b = el('button', 'opt'); b.type = 'button';
      b.append(el('b', '', src[k].label), el('span', '', src[k].sub));
      b.addEventListener('click', () => call(k, opts, mine));
      list.append(b);
    }
    box.append(list);
    if (G.lines.length) { const last = el('p', 'last', G.lines[G.lines.length - 1]); box.append(last); }
  }
  function note(t) { G.lines.push(t); }
  function call(k, opts, mine) {
    const i = G.decs.length, seed = hash(G.seed, 'd', i);
    // the grade: every option's win chance from here, the same bounces each
    const wp = evaluate(S, mine ? 'off' : 'def', opts, seed, N_EVAL), best = opts.reduce((a, b) => (wp[b] > wp[a] ? b : a));
    const typ = mine ? typicalOffense(S, rng(1)).weights : typicalDefense(S, rng(1)).weights;
    const dec = { i, side: mine ? 'off' : 'def', situation: situation(S), chosen: k, best, wp: wp[k], bestWp: wp[best], cost: Math.max(0, wp[best] - wp[k]), opts: opts.map((o) => ({ k, label: (mine ? APPROACH : DEFENSE)[o].label, wp: wp[o], q: typ[o] || 0 })).map((o, j) => ({ ...o, k: opts[j] })) };
    G.decs.push(dec);
    // the possession, with the other bench typical, on the day's own bounces
    const r = rng(hash(G.seed, 'p', i));
    const a = mine ? k : typicalOffense(S, r).pick, d = mine ? typicalDefense(S, r).pick : k;
    const lines = possession(S, r, a, d);
    if (!mine && d !== 'foul') { /* the other bench's approach is theirs to know */ }
    for (const t of lines) G.lines.push(t);
    saveGame();
    step();
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
    drawBoard();
    const box = $('card'); box.textContent = '';
    const won = lead(S, S.me) > 0, margin = Math.abs(lead(S, S.me)), decs = G.decs;
    if (G.score == null) {
      G.score = Math.round(percentile(decs) * 100); G.won = won; G.margin = margin; G.done = true; saveGame();
      if (!G.practice) { const st = load(`${STORE}:stats`, { days: {} }); if (!st.days[dayISO()]) { st.days[dayISO()] = { score: G.score, won }; save(`${STORE}:stats`, st); } }
    }
    const realMine = spot.me === spot.home ? spot.final[0] - spot.final[1] : spot.final[1] - spot.final[0];
    box.append(el('div', 'eyebrow', G.practice ? 'Practice game' : `Day ${dayN()} · ${teamCity(spot.away)} at ${teamCity(spot.home)}`),
      el('div', 'big', String(G.score)), el('div', 'pct-lab', `Better than ${G.score}% of coaches`),
      el('h2', '', `${won ? 'You won' : margin === 0 ? 'Tied' : 'You lost'} ${S.score[S.me]}–${S.score[other(S.me)]}${S.period > 4 ? ' in overtime' : ''}`),
      el('p', 'note', `The real game: ${teamCity(teamOf(S, S.me))} ${realMine > 0 ? 'won' : realMine < 0 ? 'lost' : 'tied'} ${Math.abs(realMine) ? `by ${Math.abs(realMine)}` : ''} (${spot.final[1]}–${spot.final[0]} ${teamCity(spot.away)} at ${teamCity(spot.home)}).`));
    // the calls
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
    // how it went, then how it really went
    const mine = el('div', 'real'); mine.append(el('h3', '', 'How your game went'));
    const ul = el('ul', ''); for (const t of G.lines) ul.append(el('li', '', t)); mine.append(ul); box.append(mine);
    const real = el('div', 'real'); real.append(el('h3', '', 'What really happened'));
    const rl = el('ul', '');
    for (const e of (spot.real || []).slice(0, 40)) rl.append(el('li', '', `${clockText(e.t)}${e.p > 4 ? ' OT' : ''} · ${e.text}${e.score ? ` · ${e.score[1]}–${e.score[0]}` : ''}`));
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
  }
  function saveGame() { if (!G.practice) save(dayKey(), { seed: G.seed, spotId: spot.id, decs: G.decs.map((x) => x.chosen), done: G.done, score: G.score, lines: G.lines, started: G.started }); }
  // today's game, or a practice one; a day's saved game is replayed from its calls (the same seed: the same bounces)
  function start(practice) {
    spot = pickSpot(practice); S = newState(spot);
    G = { seed: practice ? (Math.random() * 1e9) >>> 0 : hash('hoops', dayISO(), spot.id), decs: [], lines: [], practice: !!practice, done: false, score: null, started: false };
    const saved = practice ? null : load(dayKey(), null);
    if (saved && saved.spotId === spot.id) {
      G.seed = saved.seed; G.started = saved.started;
      for (const k of saved.decs) {               // (replay: the same calls, the same draws)
        if (S.over) break;
        if (S.clock <= 0) { const t = endOfPeriod(S); if (!t) break; note(t); }
        const mine = S.poss === S.me, opts = mine ? offenseOptions(S) : Object.keys(DEFENSE);
        if (!opts.includes(k)) break;
        call(k, opts, mine);
      }
      if (saved.done || S.over) { G.done = true; return renderEnd(); }
      if (G.started) return step();
    }
    renderIntro(practice);
  }
  async function boot() {
    const src = document.querySelector('meta[name="hoops-data"]');
    try {
      const r = await fetch((src && src.content) || 'hoops/hoops_data.json');
      D = await r.json(); L = D.league; T = D.teams;
    } catch (e) { $('card').textContent = 'The game could not load its data. Try again in a minute.'; return; }
    start(false);
  }
  // (the step() after a saved replay calls call() which re-evaluates; a replayed day's grades come from the same seeds, so the same numbers)
  boot();
})();
