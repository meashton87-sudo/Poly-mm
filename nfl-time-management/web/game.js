/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * Three real late-game spots a day. The player calls every play for one team until the game ends: the
 * tempo when the clock is running, then Run / Pass / RPO, then the play. The nflclock engine (engine.js,
 * in Web Workers) plays each snap from real NFL plays of that call and values every option by simulating
 * the rest of the game. Nothing says which call is best until the ball is snapped. The score compares
 * each call with the best one and with what a typical NFL play-caller does in the same spot. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RUN = 0, PASS = 1, KNEEL = 2, SPIKE = 3;
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const N_EVAL = 600;
  const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const STORE = 'tmd:v2';
  const SVGNS = 'http://www.w3.org/2000/svg';

  const TEAMS = {
    ARI: ['Cardinals', '#97233F'], ATL: ['Falcons', '#A71930'], BAL: ['Ravens', '#241773'], BUF: ['Bills', '#00338D'],
    CAR: ['Panthers', '#0085CA'], CHI: ['Bears', '#0B162A'], CIN: ['Bengals', '#FB4F14'], CLE: ['Browns', '#FF3C00'],
    DAL: ['Cowboys', '#003594'], DEN: ['Broncos', '#FB4F14'], DET: ['Lions', '#0076B6'], GB: ['Packers', '#203731'],
    HOU: ['Texans', '#03202F'], IND: ['Colts', '#002C5F'], JAX: ['Jaguars', '#006778'], KC: ['Chiefs', '#E31837'],
    LV: ['Raiders', '#A5ACAF'], LAC: ['Chargers', '#0080C6'], LA: ['Rams', '#003594'], MIA: ['Dolphins', '#008E97'],
    MIN: ['Vikings', '#4F2683'], NE: ['Patriots', '#002244'], NO: ['Saints', '#D3BC8D'], NYG: ['Giants', '#0B2265'],
    NYJ: ['Jets', '#125740'], PHI: ['Eagles', '#004C54'], PIT: ['Steelers', '#FFB612'], SF: ['49ers', '#AA0000'],
    SEA: ['Seahawks', '#69BE28'], TB: ['Buccaneers', '#D50A0A'], TEN: ['Titans', '#4B92DB'], WAS: ['Commanders', '#5A1414'],
  };
  const FAM = { run: 'Run', pass: 'Pass', rpo: 'RPO' };
  const TEMPO = {
    hurry: { label: 'Hurry up', act: { to_off: false, tempo: 'urgent' } },
    huddle: { label: 'Huddle', act: { to_off: false, tempo: 'normal' } },
    milk: { label: 'Milk it', act: { to_off: false, tempo: 'milk' } },
    timeout: { label: 'Timeout', act: { to_off: true } },
    spike: { label: 'Spike', act: { to_off: false, play: 'spike' }, terminal: true },
    kneel: { label: 'Kneel', act: { to_off: false, play: 'kneel' }, terminal: true },
    rundown: { label: 'Run it down', sub: 'timeout at 0:03, kick', act: { to_off: false }, terminal: true },
  };
  const POS_NAME = { QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end', T: 'Offensive tackle',
    G: 'Guard', C: 'Center', EDGE: 'Edge rusher', DL: 'Defensive tackle', LB: 'Linebacker', CB: 'Cornerback', S: 'Safety' };
  const POS_METHOD = {
    QB: 'Ranked among quarterbacks on EPA per dropback.',
    RB: 'Ranked among running backs on yards after contact per carry.',
    WR: 'Ranked among wide receivers on EPA per target.',
    TE: 'Ranked among tight ends on EPA per target.',
    OL: 'No public stat grades linemen one at a time, so all five share their line\'s grade: pressure allowed and yards before contact, ranked among the 32 lines.',
    EDGE: 'Ranked among edge rushers on pressures per snap.',
    DL: 'Ranked among interior linemen on pressures per snap.',
    LB: 'Ranked among off-ball linebackers on tackles per snap, missed tackles and passer rating allowed in coverage.',
    CB: 'Ranked among cornerbacks on passer rating allowed when targeted.',
    S: 'Ranked among safeties on passer rating allowed and missed tackles.',
  };
  const SQ = { g: '🟩', y: '🟨', o: '🟧', r: '🟥' };
  const GLYPH = { g: '✓', y: '≈', o: '!', r: '✗' };

  let idx = null;                 // game.json
  let dayN = 1, today = [];
  let state = null;               // saved progress for today
  let G = null;                   // the spot being played
  let ui = { step: null, tempo: null, fam: null, oob: false };
  let busy = false, lastFocus = null, tick = null;
  const CALL = {};                // id -> call metadata

  // ------------------------------------------------------------- helpers ---
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const wpTxt = (p) => `${(p * 100).toFixed(1)}%`;
  const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function hash(...parts) {
    let h = 2166136261 >>> 0;
    for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % 1000003;
  }
  function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function load(key, dflt) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage off: play on */ } }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function key(label, sub, cls) {
    const b = el('button', `key${cls ? ' ' + cls : ''}`);
    b.type = 'button';
    b.append(document.createTextNode(label));
    if (sub) b.append(el('small', '', sub));
    return b;
  }
  const code = (i) => (i === 0 ? G.scen.game.home.team : G.scen.game.away.team);
  const teamName = (c) => (TEAMS[c] ? TEAMS[c][0] : c);
  const color = (c) => (TEAMS[c] ? TEAMS[c][1] : '#556');
  const tierOf = (p) => (p >= 80 ? 'e' : p >= 60 ? 'g' : p >= 40 ? 'a' : p >= 20 ? 'b' : 'p');
  const markOf = (cost) => (cost < 0.005 ? 'g' : cost < 0.02 ? 'y' : cost < 0.05 ? 'o' : 'r');
  function clockOf(t) {
    const q = t > 2700 ? 1 : t > 1800 ? 2 : t > 900 ? 3 : 4;
    const s = Math.max(0, t - (4 - q) * 900);
    return { q, s, text: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` };
  }
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  function spotText(r) {
    if (Math.round(r.yl) === 50) return 'midfield';
    return r.yl > 50 ? `${code(r.pos)} ${Math.round(100 - r.yl)}` : `${code(1 - r.pos)} ${Math.round(r.yl)}`;
  }
  function ddText(r) {
    const goal = r.ytg >= r.yl;
    return `${ordinal(r.down)} & ${goal ? 'Goal' : Math.max(1, Math.round(r.ytg))}`;
  }
  function startRoot(sc) {
    const st = sc.start, home = sc.game.home.team;
    return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === home ? 0 : 1,
      score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl,
      to: [st.to[1], st.to[0]], clock_running: !!st.running, phase: SNAP, credit: 0, free_kick: false };
  }
  const sideFor = (seq) => (hash('side', dayN, G.si, seq) % 2 ? 1 : -1);   // +1: strong side on the right

  // -------------------------------------------------------- worker pool ---
  const pool = [], queue = [], pending = new Map();
  let reqId = 0, readyCount = 0, onReady = null;
  function startWorkers() {
    for (let i = 0; i < POOL; i++) {
      const w = new Worker('game_worker.js');
      const slot = { w, ready: false, busy: false };
      w.onmessage = (ev) => onMsg(slot, ev.data);
      w.onerror = (e) => fatal('The simulator could not start: ' + (e.message || 'worker error'));
      w.postMessage({ type: 'init' });
      pool.push(slot);
    }
  }
  function pump() {
    for (const s of pool) {
      if (!s.ready || s.busy) continue;
      const m = queue.shift();
      if (!m) return;
      s.busy = true;
      s.w.postMessage(m);
    }
  }
  function onMsg(slot, m) {
    if (m.type === 'ready') { slot.ready = true; readyCount++; if (readyCount === 1 && onReady) onReady(); pump(); return; }
    slot.busy = false;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) { if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m); }
    pump();
  }
  function send(msg) {
    return new Promise((resolve, reject) => { msg.id = ++reqId; pending.set(msg.id, { resolve, reject }); queue.push(msg); pump(); });
  }
  async function evaluate(root, options, seed) {
    const k = Math.min(Math.max(1, readyCount), options.length);
    const chunks = Array.from({ length: k }, () => []);
    options.forEach((o, i) => chunks[i % k].push({ key: o.key, action: o.action }));
    const res = await Promise.all(chunks.map((c) => send({ type: 'eval', scen: G.scen, root, options: c, n: N_EVAL, persp: G.me, seed })));
    const out = {};
    res.forEach((r) => r.out.forEach((o) => { out[o.key] = o.mean; }));
    return out;
  }

  // ------------------------------------------------- what coaches do (q) ---
  function tendFeatures(r, decider) {
    const margin = r.score[decider] - r.score[1 - decider];
    const th = halfLeft(r.t), half2 = r.t <= 1800 ? 1 : 0;
    const special = r.phase !== SNAP;
    const yl = special ? 75 : r.yl, ytg = special ? 10 : Math.min(r.ytg, r.yl), down = special ? 1 : r.down;
    return [th / 60, Math.log1p(th), half2, margin, Math.abs(margin), margin < 0 ? 1 : 0, margin > 0 ? 1 : 0,
      down, ytg, Math.log(Math.max(ytg, 1)), yl / 10, (yl / 10) ** 2, r.to[decider], r.to[1 - decider], th <= 120 ? 1 : 0,
      (th <= 300 && half2) ? 1 : 0, r.clock_running ? 1 : 0, yl <= 40 ? 1 : 0, Math.max(yl - 40, 0) / 10];
  }
  function inDomain(family, r, decider) {
    const margin = r.score[decider] - r.score[1 - decider];
    const q = clockOf(r.t).q, th = halfLeft(r.t);
    switch (family) {
      case 'def_timeout': return (q === 4 && th <= 300 && margin <= 0 && margin >= -16) || (q === 2 && th <= 120);
      case 'off_clock_stop': return (q === 4 && th <= 120 && margin <= 0 && margin >= -16) || (q === 2 && th <= 60);
      case 'fourth_down': return ((q === 4 && th <= 600) || (q === 2 && th <= 120)) && Math.abs(margin) <= 16;
      case 'pat': return q === 4;
      case 'onside': return q === 4 && th <= 420 && margin < 0 && margin >= -16;
      case 'kneel': return q === 4 && th <= 160 && margin > 0;
      default: return false;
    }
  }
  function coachProbs(family, r, decider) {
    const T = idx.models && idx.models.tendency;
    if (!T || !T.families[family] || !inDomain(family, r, decider)) return null;
    const m = T.families[family], x = tendFeatures(r, decider);
    const z = m.coef.map((row, c) => m.intercept[c] + row.reduce((a, w, j) => a + w * (x[j] - m.mean[j]) / m.scale[j], 0));
    let p;
    if (m.classes.length === 2 && m.coef.length === 1) { const s = 1 / (1 + Math.exp(-z[0])); p = [1 - s, s]; }
    else { const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); p = e.map((v) => v / s); }
    const out = {};
    m.classes.forEach((c, i) => { out[c] = p[i]; });
    return out;
  }
  function normalize(q, keys) {
    const out = {};
    let s = 0;
    keys.forEach((k) => { out[k] = Math.max(q[k] || 0, 0); s += out[k]; });
    if (s <= 0) keys.forEach((k) => { out[k] = 1 / keys.length; });
    else keys.forEach((k) => { out[k] /= s; });
    return out;
  }
  function decisionFrom(kind, family, options, vals, chosen, q, situation) {
    const wps = options.map((o) => ({ key: o.key, label: o.label, wp: vals[o.key] }));
    const best = wps.reduce((a, b) => (b.wp > a.wp ? b : a));
    const mine = wps.find((w) => w.key === chosen);
    const qq = normalize(q, wps.map((w) => w.key));
    const typical = wps.reduce((a, w) => a + qq[w.key] * w.wp, 0);
    const cost = Math.max(0, best.wp - mine.wp);
    return { kind, family, situation, wps, chosen, chosenLabel: mine.label, best: best.key, bestLabel: best.label,
      bestWp: best.wp, wp: mine.wp, cost, q: qq, typical, wpa: mine.wp - typical, snap: G.snapN };
  }

  // ------------------------------------------------------------ the field ---
  // A portrait window around the line of scrimmage: the offense drives up the screen.
  const FW = 360, FH = 336, SX0 = 10, SX1 = 350, PPY = 12.2, LOS_Y = 212, PR = 11.5;
  const XYD = (SX1 - SX0) / 53.333;                         // px per yard across the field
  const HASH_L = SX0 + 23.58 * XYD, HASH_R = SX1 - 23.58 * XYD;   // NFL hashes: 70'9" from each sideline
  const clampX = (x) => clip(x, SX0 + 14, SX1 - 14);

  function offenseSpots(list, s, bx) {
    const by = {};
    list.forEach((p) => { (by[p.pos] = by[p.pos] || []).push(p); });
    const take = (pos) => (by[pos] && by[pos].length ? by[pos].shift() : null);
    const out = [];
    const put = (p, x, d, label) => { if (p) out.push({ p, x: clampX(x), d, label: label || p.pos }); };
    const ol = [['C', bx], ['G', bx - s * 26], ['G', bx + s * 26], ['T', bx - s * 52], ['T', bx + s * 52]];
    ol.forEach(([lab, x]) => put(take(lab) || take('G') || take('T') || take('C'), x, 1.0, lab));
    const teX = bx + s * 78;
    const xX = s > 0 ? SX0 + 24 : SX1 - 24, zX = s > 0 ? SX1 - 28 : SX0 + 28;
    const slotX = (teX + zX) / 2;
    put(take('TE'), teX, 1.15, 'TE');
    put(take('WR'), xX, 1.0, 'WR');
    put(take('WR'), zX, 1.5, 'WR');
    put(take('WR'), slotX, 1.7, 'WR');
    put(take('QB'), bx, 5.0, 'QB');
    put(take('RB'), bx - s * 25, 5.2, 'RB');
    const spare = [[bx - s * 78, 1.15], [bx + s * 25, 5.2], [(xX + bx - s * 52) / 2, 1.7]];
    Object.values(by).flat().forEach((p, i) => { const sp = spare[i % spare.length]; put(p, sp[0], sp[1]); });
    return { pts: out, xX: clampX(xX), zX: clampX(zX), slotX: clampX(slotX), teX: clampX(teX) };
  }
  function defenseSpots(list, s, bx, o) {
    const g = { EDGE: [], DL: [], LB: [], CB: [], S: [], X: [] };
    list.forEach((p) => (g[p.pos] || g.X).push(p));
    const out = [];
    const put = (p, x, d) => out.push({ p, x: clampX(x), d, label: p.pos });
    const edges = g.EDGE.slice();
    const line = [];
    if (edges.length) line.push(edges.shift());     // weak-side end first, strong-side end last
    line.push(...g.DL, ...edges);
    const n = line.length, sp = n <= 4 ? 34 : n === 5 ? 29 : 25;
    line.forEach((p, i) => put(p, bx + s * (i - (n - 1) / 2) * sp, 1.0));
    const nl = g.LB.length, lsp = nl >= 3 ? 40 : 46;
    g.LB.forEach((p, i) => put(p, bx + s * 8 + (i - (nl - 1) / 2) * lsp, 5.0));
    const cbSpots = [[o.zX, 6.5], [o.xX, 6.5], [o.slotX, 5.5], [bx + s * 34, 9.0]];
    g.CB.forEach((p, i) => { const c = cbSpots[Math.min(i, 3)]; put(p, c[0] + (i > 3 ? (i - 3) * 30 : 0), c[1]); });
    const ns = g.S.length;
    const third = g.CB.length < 3 ? [o.slotX, 5.6] : [o.teX, 7.6];       // two corners: the third safety covers the slot
    const sSpots = ns === 1 ? [[bx + s * 12, 13]] : [[bx - s * 62, 12.5], [bx + s * 62, 12.5], third, [bx, 10]];
    g.S.forEach((p, i) => { const c = sSpots[Math.min(i, sSpots.length - 1)]; put(p, c[0], c[1]); });
    g.X.forEach((p, i) => put(p, bx + (i - (g.X.length - 1) / 2) * 40, 8));
    return out;
  }

  function drawField() {
    const svg = $('field'), r = G.root;
    svg.textContent = '';
    const offI = r.pos, offC = code(offI), defC = code(1 - offI);
    let own = 100 - r.yl, mode = 'snap';
    if (r.phase === KICKOFF) { mode = 'kick'; own = r.free_kick ? 20 : 35; }
    else if (r.phase === PAT) { mode = 'pat'; own = 85; }
    else if (r.phase === DONE) mode = 'done';
    const yOf = (L) => LOS_Y - (L - own) * PPY;
    svg.append(S('rect', { x: 0, y: 0, width: FW, height: FH, fill: 'var(--turf)' }));
    for (let L = 0; L < 100; L += 10) {                  // mowing bands, 5 yards each
      const y1 = yOf(L + 5), y2 = yOf(L);
      if (y2 < 0 || y1 > FH) continue;
      svg.append(S('rect', { x: 0, y: y1, width: FW, height: y2 - y1, fill: 'var(--turf-2)' }));
    }
    const endZone = (L0, L1, team) => {
      const y1 = Math.max(yOf(L1), -2), y2 = Math.min(yOf(L0), FH + 2);
      if (y2 <= 0 || y1 >= FH) return;
      svg.append(S('rect', { x: 0, y: y1, width: FW, height: y2 - y1, fill: color(team), opacity: 0.9 }));
      const yc = (yOf(L1) + yOf(L0)) / 2;
      if (yc > 14 && yc < FH - 14) {
        svg.append(S('text', { x: FW / 2, y: yc, class: 'ez', 'text-anchor': 'middle', 'dominant-baseline': 'central' },
          teamName(team).toUpperCase()));
      }
    };
    endZone(100, 110, mode === 'kick' ? code(1 - offI) : defC);
    endZone(-10, 0, offC);
    svg.append(S('line', { x1: SX0, y1: 0, x2: SX0, y2: FH, stroke: 'var(--chalk)', 'stroke-width': 2 }),
      S('line', { x1: SX1, y1: 0, x2: SX1, y2: FH, stroke: 'var(--chalk)', 'stroke-width': 2 }));
    for (let L = 0; L <= 100; L++) {
      const y = yOf(L);
      if (y < -2 || y > FH + 2) continue;
      if (L % 5 === 0) {
        svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chalk)', 'stroke-width': L === 0 || L === 100 ? 3 : 1.3 }));
      } else {
        [[SX0, SX0 + 6], [SX1 - 6, SX1], [HASH_L - 3.5, HASH_L + 3.5], [HASH_R - 3.5, HASH_R + 3.5]].forEach(([a, b]) =>
          svg.append(S('line', { x1: a, y1: y, x2: b, y2: y, stroke: 'var(--chalk-soft)', 'stroke-width': 1 })));
      }
      if (L % 10 === 0 && L > 0 && L < 100 && y > 12 && y < FH - 12) {
        const n = String(L <= 50 ? L : 100 - L), xl = SX0 + 8.5 * XYD, xr = SX1 - 8.5 * XYD;
        svg.append(S('text', { x: xl, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(-90 ${xl} ${y})` }, n));
        svg.append(S('text', { x: xr, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(90 ${xr} ${y})` }, n));
      }
    }
    const s = mode === 'pat' ? 1 : G.side;
    const bx = mode === 'pat' ? (HASH_L + HASH_R) / 2 : (s > 0 ? HASH_L : HASH_R);   // strong side is the wide side
    if (mode === 'kick' || mode === 'done') {
      if (mode === 'kick') svg.append(S('ellipse', { cx: FW / 2, cy: LOS_Y, rx: 4.2, ry: 6.5, fill: '#8a4b24' }));
      svg.append(S('text', { x: FW / 2, y: mode === 'kick' ? LOS_Y - 40 : FH / 2, class: 'big', 'text-anchor': 'middle', 'dominant-baseline': 'central' },
        mode === 'kick' ? (r.free_kick ? 'FREE KICK' : 'KICKOFF') : 'FINAL'));
      return;
    }
    svg.append(S('line', { x1: SX0, y1: LOS_Y, x2: SX1, y2: LOS_Y, stroke: 'var(--los)', 'stroke-width': 3, opacity: 0.95 }));
    if (mode === 'snap' && r.ytg < r.yl - 0.01) {
      const y = yOf(own + r.ytg);
      if (y >= 6) svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chain)', 'stroke-width': 3 }));
      else {
        const t = S('g', { transform: `translate(${FW / 2},12)` });
        t.append(S('rect', { x: -58, y: -9, width: 116, height: 18, rx: 9, fill: 'var(--chain)' }),
          S('text', { class: 'tag', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: 'var(--chain-ink)' }, `1ST DOWN ↑ ${Math.round(r.ytg)} YDS`));
        svg.append(t);
      }
    }
    svg.append(S('ellipse', { cx: bx, cy: LOS_Y, rx: 4.2, ry: 6.5, fill: '#8a4b24', stroke: 'rgba(255,255,255,.6)', 'stroke-width': 0.8 }));
    const L = G.scen.lineups || {};
    const offL = (L[offI === 0 ? 'home' : 'away'] || {}).off || [];
    const defL = (L[offI === 0 ? 'away' : 'home'] || {}).def || [];
    const o = offenseSpots(offL, s, bx);
    const d = defenseSpots(defL, s, bx, o);
    const drawP = ({ p, x, d: depth, label }, isOff, team) => {
      const y = isOff ? LOS_Y + depth * PPY : LOS_Y - depth * PPY;
      const tIdx = isOff ? offI : 1 - offI;
      const gEl = S('g', { class: `pl t-${tierOf(p.pct)}${tIdx === G.me ? ' me' : ''}`, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`,
        tabindex: 0, role: 'button', 'aria-label': `${team} ${POS_NAME[label] || label} ${p.name}, ${ordinal(p.pct)} percentile` });
      gEl.append(S('circle', { r: PR }), S('text', { class: 'n', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(p.pct)),
        S('text', { class: 'pos', 'text-anchor': 'middle', y: isOff ? PR + 9 : -PR - 4 }, label));
      const open = () => playerInfo(p, label, team);
      gEl.addEventListener('click', open);
      gEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      svg.append(gEl);
    };
    d.forEach((x) => drawP(x, false, defC));
    o.pts.forEach((x) => drawP(x, true, offC));
  }

  // ------------------------------------------------------------ chrome ---
  function drawTiles() {
    const t = $('tiles');
    t.textContent = '';
    for (let i = 0; i < 3; i++) {
      const s = state.spots[i];
      const b = el('button', '', String(i + 1));
      b.type = 'button';
      b.tabIndex = -1;
      if (s && s.over) {
        const w = (s.decisions || []).reduce((a, x) => a + x.wpa, 0);
        b.className = `done sq ${spotMark(s)}`;
        b.title = `Spot ${i + 1}: ${pts(w)} win % against a typical NFL play-caller`;
        b.setAttribute('aria-label', b.title);
      }
      else if (G && G.si === i && !state.done) { b.className = 'on'; b.setAttribute('aria-label', `Spot ${i + 1}: playing`); }
      else b.setAttribute('aria-label', `Spot ${i + 1}`);
      t.append(b);
    }
  }
  function spotMark(s) {
    const w = (s.decisions || []).reduce((a, x) => a + x.wpa, 0);
    return w >= 0.01 ? 'g' : w >= -0.01 ? 'y' : w >= -0.04 ? 'o' : 'r';
  }
  function drawHead() {
    const h = $('spothead'), sc = G.scen, r = G.root;
    h.textContent = '';
    const lead = r.score[G.me] - r.score[1 - G.me];
    const opp = code(1 - G.me);
    h.append(el('div', 'cat', `Spot ${G.si + 1} of 3 · ${idx.categories[sc.category]}`),
      el('div', 'who', `You're the ${teamName(code(G.me))}, ${lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'tied'} with the ${teamName(opp)} · ${sc.season} week ${sc.week}`));
  }
  function drawBoard() {
    const r = G.root, b = $('board');
    b.textContent = '';
    const row = el('span', 'row');
    const side = (i, right) => {
      const c = code(i), d = el('span', `tm${right ? ' r' : ''}`);
      const sw = el('span', 'sw'); sw.style.background = color(c);
      const meta = el('span', 'meta');
      const tos = el('span', 'tos');
      for (let k = 0; k < 3; k++) tos.append(el('i', k < r.to[i] ? '' : 'used'));
      tos.setAttribute('aria-label', `${r.to[i]} timeouts`);
      meta.append(el('span', 'ab', c), tos);
      if (i === G.me) meta.append(el('span', 'you', 'YOU'));
      d.append(sw, meta);
      if (r.pos === i && r.phase !== DONE) { const p = el('span', 'poss'); p.title = 'Has the ball'; d.append(p); }
      d.append(el('span', 'sc', String(r.score[i])));
      return d;
    };
    const ck = clockOf(r.t);
    const clk = el('span', 'clk');
    clk.append(el('span', 'q', ck.q <= 4 ? `Q${ck.q}` : 'OT'), el('span', `t${r.clock_running ? ' run' : ''}`, ck.text));
    row.append(side(1, false), clk, side(0, true));
    const dd = el('span', 'dd');
    if (r.phase === SNAP) {
      dd.append(el('b', '', ddText(r)), document.createTextNode(` · ${spotText(r)} · clock ${r.clock_running ? 'running' : 'stopped'}`));
    } else dd.textContent = r.phase === PAT ? 'Try after the touchdown' : r.phase === KICKOFF ? 'Kickoff' : 'Final';
    b.append(row, dd);
  }
  function drawAll() { drawTiles(); drawHead(); drawBoard(); drawField(); }
  function setPlaying(on) {
    ['spothead', 'board'].forEach((id) => { $(id).hidden = !on; });
    document.querySelector('.fieldwrap').hidden = !on;
    document.querySelector('.legend').hidden = !on;
    $('pbpBox').hidden = !on;
  }

  function addLog(text, t, mine) {
    const li = el('li');
    li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
    $('pbp').prepend(li);
    G.log.push([text, t, !!mine]);
  }
  function restoreLog() {
    $('pbp').textContent = '';
    G.log.forEach(([text, t, mine]) => {
      const li = el('li');
      li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
      $('pbp').prepend(li);
    });
  }
  function statusPanel(text, lines, skip) {
    const d = $('call');
    d.textContent = '';
    const s = el('div', 'status');
    s.append(el('span', 'spin'), el('span', '', text));
    d.append(s);
    (lines || []).forEach((l) => d.append(el('div', 'res-play', l)));
    if (skip) {
      const c = el('button', 'chip', 'Skip ahead');
      c.type = 'button';
      c.addEventListener('click', () => { G.fast = true; c.disabled = true; });
      const row = el('div', 'chips'); row.append(c); d.append(row);
    }
  }
  function fatal(msg) {
    const d = $('call');
    d.textContent = '';
    d.append(el('p', 'err', msg));
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ------------------------------------------------------------ narration ---
  function lookText(k) {
    if (!k || (!k.form && !k.box)) return '';
    const bits = [];
    if (k.form) bits.push(k.form);
    if (k.motion) bits.push('motion');
    if (k.box) bits.push(`${k.box} in the box`);
    if (k.blitz) bits.push('blitz');
    return ` (${bits.join(', ')})`;
  }
  function actorOf(id, nm) { return id === 'trick' ? null : id.startsWith('rb_') ? nm.rb : nm.qb; }
  function playLine(e, act) {
    const mine = e.team === G.me, nm = G.scen.names || {};
    const who = code(e.team);
    if (e.kind === SPIKE) return `${who} spikes the ball, clock stopped`;
    if (e.kind === KNEEL) return `${who} kneels, ${e.running ? 'clock running' : 'clock stopped'}`;
    let what;
    if (e.call >= 0) {
      const c = idx.calls[e.call], actor = mine ? actorOf(c.id, nm) : null;
      what = `${actor || who} ${c.say || c.label.toLowerCase()}${lookText(e.look)}`;
    } else what = `${who} ${e.kind === RUN ? 'run' : 'pass'}`;
    const y = Math.round(e.yards);
    const gain = y > 0 ? `${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `loss of ${-y}` : 'no gain';
    let res;
    if (e.penalty) res = `flag, ${e.pen || 'penalty'}: ${y >= 0 ? `+${y}` : y} yards`;
    else {
      switch (e.evt) {
        case 'bad_snap': res = e.turnover ? 'bad snap, the defense recovers' : `bad snap, the offense falls on it: ${gain}`; break;
        case 'strip_sack': res = e.tdDef ? 'strip-sack, returned for a touchdown' : 'strip-sack, fumble lost'; break;
        case 'sack_fumble': res = `sacked and fumbles, but the offense recovers: ${gain}`; break;
        case 'sack': res = `sacked, ${gain}`; break;
        case 'pick_six': res = 'intercepted and returned for a touchdown'; break;
        case 'interception': res = 'intercepted'; break;
        case 'scoop_score': res = 'fumble, scooped and returned for a touchdown'; break;
        case 'fumble_lost': res = 'fumble, lost'; break;
        case 'fumble_kept': res = `fumbles, but the offense recovers: ${gain}`; break;
        case 'scramble': res = e.td ? `scrambles ${y} yards for a touchdown` : `pressure, scrambles: ${gain}`; break;
        case 'throwaway': res = 'pressure, throws it away'; break;
        case 'drop': res = 'dropped, incomplete'; break;
        case 'near_pick': res = 'nearly intercepted, incomplete'; break;
        default: break;
      }
    }
    if (!res) {
      if (e.turnover) res = e.tdDef ? 'turnover, returned for a touchdown' : e.kind === PASS ? 'intercepted' : 'fumble, lost';
      else if (e.td) res = `${y}-yard touchdown`;
      else if (e.incomplete) res = 'incomplete';
      else res = gain;
    } else if (e.td && !/touchdown/.test(res)) res += `, ${y}-yard touchdown`;
    const extra = [];
    if (e.oob && !e.incomplete) extra.push('out of bounds');
    else if (act && act.oob && mine && !e.incomplete && !e.penalty && !e.turnover && !e.td && !e.safety) extra.push('could not get out of bounds');
    if (e.fd && !e.td) extra.push(e.penalty ? 'automatic first down' : 'first down');
    if (e.onDowns) extra.push('turnover on downs');
    if (e.safety) extra.push('safety');
    if (!e.td && !e.turnover && !e.onDowns && !e.safety) extra.push(e.running ? 'clock running' : 'clock stopped');
    return `${what}: ${res}${extra.length ? ', ' + extra.join(', ') : ''}`;
  }
  function narrate(log, act) {
    const out = [];
    for (const e of log) {
      let text = null, t = e.t;
      switch (e.ev) {
        case 'timeout': text = `Timeout, ${code(e.team)}${e.why === 'kick' ? ' (to set up the kick)' : ''}`; break;
        case 'runoff':
          if (e.stop === '2mw') text = 'Two-minute warning';
          else if (e.stop === 'quarter') text = 'End of the quarter';
          else if (e.secs >= 3 && !e.kneel && !e.spike) text = `Clock runs ${Math.round(e.secs)} seconds`;
          break;
        case 'play': text = playLine(e, act); break;
        case 'fg': {
          const k = (e.team === 0 ? G.scen.game.home : G.scen.game.away).kicker.name || code(e.team);
          text = `${k} ${Math.round(e.dist)}-yard field goal: ${e.made ? 'good' : 'no good'}`; t = null; break;
        }
        case 'punt': text = e.blocked ? `${code(e.team)} punt blocked` : e.retTd ? `${code(e.team)} punt returned for a touchdown` :
          `${code(e.team)} punts${e.touchback ? ', touchback' : `, net ${Math.round(e.net)} yards`}`; t = null; break;
        case 'pat': text = e.two ? `${code(e.team)} two-point try ${e.good ? 'good' : 'fails'}` : `${code(e.team)} extra point ${e.good ? 'good' : 'no good'}`; break;
        case 'kickoff': text = e.onside ? `${code(e.team)} onside kick, recovered by ${code(e.recovered ? e.team : 1 - e.team)}` :
          e.retTd ? 'Kickoff returned for a touchdown' : `Kickoff, ${code(1 - e.team)} starts at its own ${Math.round(100 - e.yl)}`; break;
        case 'end': text = G.root.t > 1800 ? 'Halftime' : 'End of regulation'; break;
        default: break;
      }
      if (text) out.push([text, t, e.team === G.me]);
    }
    return out;
  }
  // the big words over a result: what a broadcast would put on screen
  function headline(e, log) {
    if (!e) return (log || []).some((x) => x.ev === 'end') ? 'Time ran out' : 'No snap';
    if (e.ev === 'fg') return e.made ? `${Math.round(e.dist)}-yard field goal is good` : 'Field goal: no good';
    if (e.ev === 'punt') return e.retTd ? 'Punt return touchdown' : e.blocked ? 'Punt blocked' : `Punt, net ${Math.round(e.net || 0)}`;
    if (e.ev === 'pat') return e.two ? (e.good ? 'Two-point try good' : 'Two-point try fails') : (e.good ? 'Extra point good' : 'Extra point missed');
    if (e.ev === 'kickoff') return e.onside ? (e.recovered ? 'Onside kick recovered' : 'Onside kick: they recover') : e.retTd ? 'Returned for a touchdown' : 'Kickoff';
    if (e.ev !== 'play') return 'Snap';
    if (e.kind === SPIKE) return 'Spiked';
    if (e.kind === KNEEL) return 'Kneel';
    const y = Math.round(e.yards);
    if (e.penalty) return 'Flag';
    if (e.tdDef) return 'Defensive touchdown';
    if (e.turnover) return { strip_sack: 'Strip-sack', fumble_lost: 'Fumble', bad_snap: 'Bad snap' }[e.evt] || (e.kind === PASS ? 'Intercepted' : 'Fumble');
    if (e.td) return 'Touchdown';
    if (e.safety) return 'Safety';
    if (e.evt === 'sack' || e.evt === 'sack_fumble') return `Sacked, −${Math.abs(y)}`;
    if (e.incomplete) return e.evt === 'drop' ? 'Dropped' : e.evt === 'throwaway' ? 'Thrown away' : 'Incomplete';
    const yd = y > 0 ? `+${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `−${-y} yard${y === -1 ? '' : 's'}` : 'No gain';
    return e.onDowns ? `${yd}, turnover on downs` : e.fd ? `${yd}, first down` : yd;
  }

  // ------------------------------------------------------------- the spot ---
  function newSpot(i) {
    const sc = today[i];
    return { si: i, scen: sc, me: sc.player === sc.game.home.team ? 0 : 1, root: startRoot(sc), decisions: [], log: [],
      seq: 0, snapN: 0, over: false, result: null, side: 1, fast: false };
  }
  function persist() {
    state.spots[G.si] = { root: G.root, decisions: G.decisions, log: G.log, seq: G.seq, snapN: G.snapN, over: G.over, result: G.result };
    save(`${STORE}:day:${dayN}`, state);
  }
  function resumeSpot(i) {
    G = newSpot(i);
    const s = state.spots[i];
    if (s) Object.assign(G, { root: s.root, decisions: s.decisions || [], log: s.log || [], seq: s.seq || 0, snapN: s.snapN || 0, over: s.over, result: s.result });
    G.side = sideFor(G.seq);
    return G;
  }
  function startSpot(i) {
    resumeSpot(i);
    setPlaying(true);
    restoreLog();
    if (!G.log.length) addLog(`${teamName(code(G.root.pos))} ball, ${ddText(G.root)} at the ${spotText(G.root)}`, G.root.t, G.root.pos === G.me);
    drawAll();
    if (G.over) finishSpot(); else advance();
  }

  async function advance() {
    while (true) {
      const r = G.root;
      G.side = sideFor(G.seq);
      drawAll();
      if (r.phase === DONE) return finishSpot();
      if (r.phase === SNAP && r.pos === G.me) return promptOffense();
      if (r.phase === PAT && r.pos === G.me) return promptChoice('pat');
      if (r.phase === KICKOFF && r.pos === G.me && !r.free_kick && kickChoice(r)) return promptChoice('kick');
      if (r.phase === SNAP && r.pos !== G.me && r.clock_running && r.to[G.me] > 0 && defChoice(r)) return promptChoice('deftime');
      const action = r.phase === SNAP ? { to_def: false } : (r.phase === KICKOFF && r.pos === G.me ? { kick: 'deep' } : {});
      const label = r.phase === KICKOFF ? (r.pos === G.me ? 'You kick off' : `${teamName(code(r.pos))} kick off`) :
        r.phase === PAT ? `${teamName(code(r.pos))} try the extra point` : `${teamName(code(r.pos))} have the ball`;
      const lastLines = G.log.slice(-2).map((l) => l[0]).reverse();
      statusPanel(label, lastLines, !G.fast);
      await stepWith(action);
      await sleep(G.fast ? 60 : 950);
    }
  }
  function kickChoice(r) { return r.t <= 300 && r.score[G.me] < r.score[1 - G.me]; }
  function defChoice(r) {
    const th = halfLeft(r.t), lead = r.score[G.me] - r.score[1 - G.me];
    const late = r.t <= 1800 ? th <= 300 : th <= 120;
    return late && (lead <= 0 || (lead <= 3 && r.yl <= 45));
  }
  async function stepWith(action) {
    const seed = hash('step', dayN, G.si, G.seq++);
    const res = (await send({ type: 'step', scen: G.scen, root: G.root, action, seed })).res;
    res.action = action;
    narrate(res.log, action).forEach(([text, t, mine]) => addLog(text, t, mine));
    G.root = res.root;
    if (res.done) G.root.phase = DONE;
    persist();
    return res;
  }

  // offense: tempo (if the clock is running), then Run / Pass / RPO, then the play
  async function promptOffense() {
    const r = G.root;
    statusPanel('Breaking the huddle…');
    G.info = (await send({ type: 'info', scen: G.scen, root: r })).info;
    G.fast = false;
    ui = { step: r.clock_running ? 'tempo' : 'family', tempo: r.clock_running ? null : 'stopped', fam: null, oob: false };
    drawCall();
  }
  function tempoOptions(r) {
    const me = G.me, lead = r.score[me] - r.score[1 - me], th = halfLeft(r.t);
    const keys = ['hurry', 'huddle', 'milk'];
    if (r.to[me] > 0) keys.push('timeout');
    if (r.down <= 3) keys.push('spike');
    if (r.down <= 3 && lead > 0) keys.push('kneel');
    if (r.t <= 1800 && lead >= -2 && lead <= 0 && th <= 180 && r.to[me] > 0 && r.yl <= 40) keys.push('rundown');
    return keys;
  }
  function callOptions(r) {
    const me = G.me, lead = r.score[me] - r.score[1 - me], th = halfLeft(r.t);
    const calls = idx.calls.map((c) => c.id).filter((id) => {
      if (id === 'qb_sneak' && r.ytg > 3) return false;
      if (id === 'hail_mary' && !(th <= 30 && r.yl >= 30)) return false;   // only as a half runs out
      return true;
    });
    const specials = [];
    if (G.info.pFg >= 0.05 && (r.down === 4 || th <= 40)) specials.push('fg');
    if (r.down === 4 && r.yl >= 30) specials.push('punt');
    if (!r.clock_running && r.down <= 3 && (lead > 0 || r.t > 1800)) specials.push('kneel');
    return { calls, specials };
  }
  const specialLabel = (k) => (k === 'fg' ? 'Field goal' : k === 'punt' ? 'Punt' : 'Kneel');

  function drawCall() {
    const r = G.root, d = $('call'), me = G.me;
    d.textContent = '';
    const head = el('div', 'ask');
    d.append(head);
    if (ui.step === 'tempo') {
      head.append(el('h2', '', 'Clock is running'), el('span', 'sub', 'Pick a tempo'));
      const ks = tempoOptions(r);
      const keys = el('div', 'keys');
      keys.style.setProperty('--cols', ks.length === 4 ? 2 : 3);
      ks.forEach((k) => {
        const b = key(TEMPO[k].label, k === 'timeout' ? `${r.to[me]} left` : TEMPO[k].sub || null);
        b.addEventListener('click', () => {
          if (busy) return;
          if (TEMPO[k].terminal) { decideOffense({ tempo: k }); return; }
          ui.tempo = k; ui.step = 'family'; drawCall();
        });
        keys.append(b);
      });
      d.append(keys);
      return;
    }
    if (ui.step === 'family') {
      head.append(el('h2', '', 'Your call'), el('span', 'sub', `${ddText(r)} · ${spotText(r)}`));
      if (r.clock_running && ui.tempo) {
        const c = el('button', 'chip', `◀ ${TEMPO[ui.tempo].label}`);
        c.type = 'button';
        c.setAttribute('aria-label', `Change tempo (now ${TEMPO[ui.tempo].label})`);
        c.addEventListener('click', () => { ui.step = 'tempo'; ui.tempo = null; drawCall(); });
        const row = el('div', 'chips'); row.append(c); d.append(row);
      }
      const fam = el('div', 'keys');
      fam.style.setProperty('--cols', 3);
      Object.entries(FAM).forEach(([f, label]) => {
        const b = key(label, null, 'big');
        b.addEventListener('click', () => { if (busy) return; ui.fam = f; ui.step = 'detail'; drawCall(); });
        fam.append(b);
      });
      d.append(fam);
      const { specials } = callOptions(r);
      if (specials.length) {
        const sp = el('div', 'keys');
        sp.style.setProperty('--cols', specials.length);
        specials.forEach((k) => {
          const b = key(specialLabel(k), k === 'fg' ? `${Math.round(G.info.fgDist)} yards` : null);
          b.addEventListener('click', () => { if (!busy) decideOffense({ special: k }); });
          sp.append(b);
        });
        d.append(sp);
      }
      return;
    }
    // the plays in the chosen family, one row per play, a key per side (arrows match the field)
    head.append(el('h2', '', FAM[ui.fam]));
    const back = el('button', 'chip', '◀ Back');
    back.type = 'button';
    back.addEventListener('click', () => { ui.step = 'family'; drawCall(); });
    head.append(back);
    const avail = callOptions(r).calls;
    const s = G.side;
    const rows = [];
    idx.calls.filter((c) => c.family === ui.fam && avail.includes(c.id)).forEach((c) => {
      let row = rows.find((x) => x.base === c.base);
      if (!row) { row = { base: c.base, calls: [] }; rows.push(row); }
      row.calls.push(c);
    });
    const order = (c) => ({ weak: s > 0 ? 0 : 2, middle: 1, strong: s > 0 ? 2 : 0 }[c.side] ?? 1);
    const sideText = (c) => (c.side === 'strong' ? (s > 0 ? 'Strong →' : '← Strong') : c.side === 'weak' ? (s > 0 ? '← Weak' : 'Weak →') :
      c.side === 'middle' ? 'Middle' : 'Call it');
    const list = el('div', 'plays');
    rows.forEach((row) => {
      const pr = el('div', 'prow');
      pr.append(el('div', 'lab', row.base));
      const sides = el('div', 'sides');
      row.calls.slice().sort((a, b) => order(a) - order(b)).forEach((c) => {
        const b = key(sideText(c));
        b.setAttribute('aria-label', c.label);
        b.addEventListener('click', () => { if (!busy) decideOffense({ call: c.id }); });
        sides.append(b);
      });
      pr.append(sides);
      list.append(pr);
    });
    d.append(list);
    const tg = el('div', 'toggle');
    const lab = el('div', 'lab', 'Get out of bounds');
    lab.append(el('small', '', 'The ball carrier tries to stop the clock. No guarantee.'));
    const sw = el('button', 'sw2');
    sw.type = 'button'; sw.id = 'oobSwitch';
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.oob)); sw.setAttribute('aria-label', 'Get out of bounds');
    sw.addEventListener('click', () => { ui.oob = !ui.oob; sw.setAttribute('aria-checked', String(ui.oob)); });
    tg.append(lab, sw);
    d.append(tg);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => tg.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }));
  }

  function callAction(tempoAct, id, oob) { return { ...tempoAct, play: CALL[id].kind, call: id, oob: !!oob }; }
  function specialAction(tempoAct, k) { return { ...tempoAct, play: k }; }

  async function decideOffense(pick) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    const situation = `${clockOf(r.t).text} Q${clockOf(r.t).q}, ${ddText(r)} at the ${spotText(r)}`;
    try {
      const tempoKey = pick.tempo || ui.tempo;
      const decisions = [];
      if (r.clock_running) {
        statusPanel('Simulating every tempo 600 times…');
        const keys = tempoOptions(r);
        const opts = keys.map((k) => ({ key: k, label: TEMPO[k].label, action: TEMPO[k].act }));
        const vals = await evaluate(r, opts, hash('clock', dayN, G.si, G.seq));
        const lead = r.score[me] - r.score[1 - me];
        let q = coachProbs('off_clock_stop', r, me);
        if (lead > 0) q = { milk: 0.72, huddle: 0.2, timeout: 0.02, hurry: 0.03, kneel: 0.03 };
        else if (!q) q = { hurry: 0.4, huddle: 0.38, timeout: 0.12, spike: 0.05, milk: 0.05 };
        decisions.push(decisionFrom('clock', 'off_clock_stop', opts, vals, tempoKey, q, situation));
      }
      let action;
      if (pick.tempo && TEMPO[pick.tempo].terminal) {
        action = TEMPO[pick.tempo].act;
      } else {
        const tempoAct = r.clock_running ? TEMPO[tempoKey].act : { to_off: false };
        const { calls, specials } = callOptions(r);
        const opts = calls.map((id) => ({ key: id, label: CALL[id].label, action: callAction(tempoAct, id, false) }));
        if (pick.call && ui.oob) opts.push({ key: `${pick.call}+oob`, label: `${CALL[pick.call].label}, get out of bounds`, action: callAction(tempoAct, pick.call, true) });
        specials.forEach((k) => opts.push({ key: k, label: specialLabel(k), action: specialAction(tempoAct, k) }));
        statusPanel(`Simulating all ${opts.length} calls 600 times each…`);
        const vals = await evaluate(r, opts, hash('call', dayN, G.si, G.seq));
        // what NFL play-callers do here: the real call mix, and on 4th down the go / kick / punt split
        const q = {};
        const freq = {}; G.info.calls.forEach((c) => { freq[c.id] = c.freq; });
        let goShare = 1;
        if (r.down === 4) {
          const f4 = coachProbs('fourth_down', r, me) || { go: r.yl <= 40 ? 0.35 : 0.15, fg: r.yl <= 40 ? 0.55 : 0.05, punt: r.yl <= 40 ? 0.1 : 0.8 };
          goShare = f4.go; if (specials.includes('fg')) q.fg = f4.fg; if (specials.includes('punt')) q.punt = f4.punt;
        } else if (specials.includes('fg')) { q.fg = halfLeft(r.t) <= 10 ? 0.6 : 0.2; goShare = 1 - q.fg; }
        if (specials.includes('kneel')) { const qk = r.score[me] > r.score[1 - me] ? 0.5 : 0.1; q.kneel = qk; goShare *= 1 - qk; }
        const fs = calls.reduce((a, id) => a + (freq[id] || 0), 0) || 1;
        calls.forEach((id) => { q[id] = goShare * (freq[id] || 0) / fs; });
        const chosen = pick.call ? (ui.oob ? `${pick.call}+oob` : pick.call) : pick.special;
        decisions.push(decisionFrom('call', r.down === 4 ? 'fourth_down' : 'play_select', opts, vals, chosen, q, situation));
        action = opts.find((o) => o.key === chosen).action;
      }
      decisions.forEach((x) => G.decisions.push(x));
      G.snapN += 1;
      statusPanel('Snap…');
      const res = await stepWith(action);
      showResult(decisions, res);
    } catch (e) {
      fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.');
    }
    busy = false;
  }

  // defensive timeout, extra point or two, onside or deep
  function promptChoice(kind) {
    const r = G.root, me = G.me, d = $('call');
    const spec = {
      deftime: { ask: 'Clock is running', sub: `${teamName(code(r.pos))} ball, ${ddText(r)} at the ${spotText(r)}`, family: 'def_timeout',
        opts: [{ key: 'timeout', label: 'Timeout', sub: `${r.to[me]} left`, action: { to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false } }],
        q: () => coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 } },
      pat: { ask: 'Touchdown', sub: 'Kick it or go for two?', family: 'pat',
        opts: [{ key: 'xp', label: 'Extra point', action: { pat: 'xp' } }, { key: 'two', label: 'Go for two', action: { pat: 'two' } }],
        q: () => coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 } },
      kick: { ask: 'Kickoff', sub: 'Kick it deep or try an onside kick?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside kick', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    d.textContent = '';
    const head = el('div', 'ask');
    head.append(el('h2', '', spec.ask), el('span', 'sub', spec.sub));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', 2);
    spec.opts.forEach((o) => {
      const b = key(o.label, o.sub || null, 'big');
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          statusPanel('Simulating both options…');
          const vals = await evaluate(r, spec.opts, hash(kind, dayN, G.si, G.seq));
          const x = decisionFrom(kind, spec.family, spec.opts, vals, o.key, spec.q(), `${clockOf(r.t).text} Q${clockOf(r.t).q}`);
          G.decisions.push(x);
          G.snapN += 1;
          const res = await stepWith(o.action);
          showResult([x], res);
        } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
        busy = false;
      });
      keys.append(b);
    });
    d.append(keys);
  }

  // ------------------------------------------------------- after the snap ---
  const KIND_NAME = { clock: 'Tempo', call: 'Play call', deftime: 'Timeout', pat: 'Try', kick: 'Kickoff' };
  function optionTable(x) {
    const t = el('table', 'opts');
    t.append(el('caption', '', KIND_NAME[x.kind] || 'Call'));
    x.wps.slice().sort((a, b) => b.wp - a.wp).forEach((w) => {
      const tr = el('tr', `${w.key === x.chosen ? 'mine' : ''}${w.key === x.best ? ' best' : ''}`);
      const share = x.q[w.key] || 0;
      tr.append(el('td', '', w.label + (w.key === x.chosen ? ' (you)' : '')),
        el('td', 'n', share >= 0.005 ? `NFL ${Math.round(share * 100)}%` : ''), el('td', 'n', wpTxt(w.wp)));
      t.append(tr);
    });
    return t;
  }
  function showResult(decisions, res) {
    ui.step = 'result';
    drawAll();
    const d = $('call');
    d.textContent = '';
    const cost = decisions.reduce((a, x) => a + x.cost, 0), m = markOf(cost);
    const main = res.log.find((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev));
    const lines = main ? narrate([main], res.action) : narrate(res.log, res.action).reverse();
    const wrap = el('div', 'result');
    const top = el('div', 'res-top');
    const sq = el('div', `sq ${m} flip`, GLYPH[m]);
    sq.setAttribute('aria-label', { g: 'Best call or close to it', y: 'A little worse than the best call', o: 'Costly', r: 'A big mistake' }[m]);
    const txt = el('div', 'res-play');
    txt.append(el('span', 'yd', headline(main, res.log)), document.createTextNode(lines.length ? lines[0][0] : ''));
    top.append(sq, txt);
    wrap.append(top);
    const v = el('div', 'verdict');
    decisions.forEach((x, i) => {
      if (i) v.append(el('br'));
      const what = decisions.length > 1 ? `${KIND_NAME[x.kind]}: ` : '';
      if (x.cost < 0.0005 || x.best === x.chosen) { v.append(document.createTextNode(what)); v.append(el('b', '', 'Best call.')); }
      else {
        v.append(document.createTextNode(`${what}best was `), el('b', '', x.bestLabel));
        v.append(document.createTextNode(` (${pts(x.cost)} win %).`));
      }
    });
    wrap.append(v);
    const det = el('details', 'more');
    det.append(el('summary', '', 'How every option scored'));
    const inn = el('div', 'in');
    decisions.forEach((x) => inn.append(optionTable(x)));
    const wpa = decisions.reduce((a, x) => a + x.wpa, 0);
    inn.append(el('p', 'note', `Win chance after your call: ${wpTxt(decisions[decisions.length - 1].wp)} before the snap. Against a typical NFL play-caller here: ${pts(wpa)} points. "NFL" is how often play-callers make that call in this spot.`));
    det.append(inn);
    wrap.append(det);
    const btn = el('button', 'btn', G.root.phase === DONE ? 'See how it ended' : 'Next play');
    btn.type = 'button';
    btn.addEventListener('click', () => { if (!busy) advance(); });
    wrap.append(btn);
    d.append(wrap);
  }

  async function finishSpot() {
    if (!G.result) {
      statusPanel('Final whistle…');
      const r = G.root;
      const v = await evaluate(r, [{ key: 'end', action: {} }], 1);
      G.result = { wp: v.end, mine: r.score[G.me], theirs: r.score[1 - G.me], half: r.t > 1800 ? 1 : 2 };
      G.over = true;
      persist();
    }
    drawAll();
    const res = G.result, sc = G.scen, d = $('call');
    d.textContent = '';
    const card = el('div', 'endcard');
    const head = res.half === 1 ? `Halftime: ${res.mine}–${res.theirs}` :
      res.mine > res.theirs ? `You win ${res.mine}–${res.theirs}` : res.mine < res.theirs ? `You lose ${res.mine}–${res.theirs}` : `Tied ${res.mine}–${res.theirs}: overtime`;
    card.append(el('h2', '', head));
    if (res.half === 1 || res.mine === res.theirs) card.append(el('p', 'note', `Your win chance from here: ${wpTxt(res.wp)}.`));
    card.append(squaresOf(G.decisions));
    const wpa = G.decisions.reduce((a, x) => a + x.wpa, 0), lost = G.decisions.reduce((a, x) => a + x.cost, 0);
    card.append(el('p', 'verdict', `${pts(wpa)} win % against a typical NFL play-caller. ${(lost * 100).toFixed(1)} points left on the table against the best call each time.`));
    const real = sc.real || {};
    const realCall = real.call && CALL[real.call] ? CALL[real.call].label : 'a play';
    const fin = real.final ? `final score ${sc.game.away.team} ${real.final.away}, ${sc.game.home.team} ${real.final.home}` : '';
    const drive = real.drive ? `the drive ended in ${/^[aeiou]/.test(real.drive) ? 'an' : 'a'} ${real.drive}` : '';
    card.append(el('p', 'real', `What really happened: ${sc.coach || code(G.me)} called "${realCall}" on that first snap${drive ? '; ' + drive : ''}${fin ? '; ' + fin : ''}.`));
    const btn = el('button', 'btn', G.si < 2 ? 'Next spot' : "Today's score");
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.current = G.si + 1;
      save(`${STORE}:day:${dayN}`, state);
      if (G.si < 2) startSpot(G.si + 1);
      else renderSummary();
    });
    card.append(btn);
    d.append(card);
    drawTiles();
  }
  function snapsOf(decs) {
    const by = new Map();
    decs.forEach((x) => { const k = x.snap ?? by.size; by.set(k, (by.get(k) || 0) + x.cost); });
    return [...by.values()].map(markOf);
  }
  function squaresOf(decs) {
    const w = el('div', 'squares');
    snapsOf(decs).forEach((m) => w.append(el('span', `sq ${m}`, GLYPH[m])));
    return w;
  }

  // ------------------------------------------------------------- the day ---
  function allDecisions() {
    const out = [];
    for (let i = 0; i < 3; i++) { const s = state.spots[i]; if (s && s.decisions) out.push(...s.decisions); }
    return out;
  }
  function percentileVsNFL(decs) {
    const my = decs.reduce((a, x) => a + x.cost, 0);
    const R = rng(hash('pct', dayN)), N = 4000;
    let better = 0;
    for (let s = 0; s < N; s++) {
      let tot = 0;
      for (const x of decs) {
        const u = R();
        let acc = 0, pick = x.wps[x.wps.length - 1];
        for (const w of x.wps) { acc += x.q[w.key] || 0; if (u <= acc) { pick = w; break; } }
        tot += Math.max(0, x.bestWp - pick.wp);
      }
      if (tot > my + 1e-9) better += 1; else if (Math.abs(tot - my) <= 1e-9) better += 0.5;
    }
    return better / N;
  }
  function shareText(p) {
    const rows = [0, 1, 2].map((i) => {
      const s = state.spots[i]; if (!s) return '';
      const sc = today[i];
      const r = s.result ? (s.result.half === 1 ? 'HT' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      return `${sc.player} ${r} ${snapsOf(s.decisions || []).map((m) => SQ[m]).join('')}`;
    });
    return `Two-Minute Drill #${dayN}\nBetter than ${Math.round(p * 100)}% of NFL play-callers\n${rows.join('\n')}`;
  }
  function renderSummary() {
    G = G || resumeSpot(2);
    setPlaying(false);
    const decs = allDecisions();
    const p = decs.length ? percentileVsNFL(decs) : 0;
    const wpa = decs.reduce((a, x) => a + x.wpa, 0);
    const st = load(`${STORE}:stats`, { days: {} });
    st.days[dayN] = { p, wpa };
    save(`${STORE}:stats`, st);
    state.done = true;
    save(`${STORE}:day:${dayN}`, state);
    drawTiles();
    const d = $('call');
    d.textContent = '';
    const card = el('div', 'endcard');
    card.append(el('div', 'note', `Day ${dayN} · your score`), el('div', 'big-pct', `${Math.round(p * 100)}`),
      el('h2', '', `Better than ${Math.round(p * 100)}% of NFL play-callers`),
      el('p', 'verdict', `${pts(wpa)} win % against a typical NFL play-caller across today's three spots.`));
    const text = shareText(p);
    const pre = el('div', 'grid-share', text);
    card.append(pre);
    const btn = el('button', 'btn alt', 'Share');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
      catch (e) { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); toast('Selected: copy it'); }
    });
    card.append(btn);
    card.append(countdown());
    const again = el('button', 'chip', 'Look back at your calls');
    again.type = 'button';
    again.addEventListener('click', () => openStats());
    const row = el('div', 'chips'); row.style.justifyContent = 'center'; row.append(again);
    card.append(row);
    d.append(card);
  }
  function countdown() {
    const w = el('div', 'countdown');
    const b = el('b', '', '');
    w.append(document.createTextNode('New spots in '), b);
    const upd = () => {
      const now = new Date(), next = new Date(now); next.setHours(24, 0, 0, 0);
      let s = Math.max(0, Math.floor((next - now) / 1000));
      const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
      b.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    upd();
    clearInterval(tick); tick = setInterval(upd, 1000);
    return w;
  }

  // ------------------------------------------------------- boxes to tap ---
  function openModal(title, nodes) {
    $('mTitle').textContent = title;
    const b = $('mBody'); b.textContent = '';
    nodes.forEach((n) => b.append(n));
    lastFocus = document.activeElement;
    $('modal').hidden = false;
    $('mClose').focus();
  }
  function closeModal() { $('modal').hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function playerInfo(p, label, team) {
    const ol = ['T', 'G', 'C'].includes(label);
    const top = el('div', 'pinfo');
    top.append(el('div', `chip-big tier-${tierOf(p.pct)}`, String(p.pct)));
    const nm = el('div');
    nm.append(el('div', 'nm', p.name), el('div', 'ps', `${teamName(team)} · ${POS_NAME[label] || label} · ${ordinal(p.pct)} percentile`));
    top.append(nm);
    openModal(POS_NAME[label] || label, [top, el('p', 'lead', p.stat || ''), el('p', 'note', `${POS_METHOD[ol ? 'OL' : label] || ''} Stats from the ${G.scen.window}; small samples are pulled toward average.`)]);
  }
  function spotInfo() {
    const sc = G.scen, home = sc.game.home, away = sc.game.away;
    const dl = el('dl', 'facts');
    const add = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
    add('Game', `${sc.season} week ${sc.week}: ${teamName(away.team)} at ${teamName(home.team)}`);
    add('You', `${teamName(sc.player)}, calling it for ${sc.coach || 'the head coach'}`);
    add('Spot', idx.categories[sc.category]);
    [away, home].forEach((t) => {
      add(`${t.team} kicker`, `${t.kicker.name || '—'} · ${ordinal(t.kicker.pct ?? 50)} percentile`);
      add(`${t.team} punter`, `${t.punter.name || '—'} · ${ordinal(t.punter.pct ?? 50)} percentile`);
    });
    openModal('This game', [dl, el('p', 'note', `Kickers and punters are ranked on field goals and net punting over expected. Player percentiles use the ${sc.window}.`)]);
  }
  function openHelp() {
    const ex = el('div', 'ex');
    ['g', 'y', 'o', 'r'].forEach((m) => ex.append(el('span', `sq ${m}`, GLYPH[m])));
    const ul = el('ul');
    [
      'If the clock is running, pick a tempo first: hurry up, huddle, milk it, timeout, spike or kneel.',
      'Then pick Run, Pass or RPO, then the play. Strong side is the wide side of the field, where the tight end lines up; weak side is the short side. The arrows match the field.',
      'Every circle is a real player from that game with his league percentile at his position, as of that week. Tap one for his numbers.',
      'Every snap is a real NFL play of that call from 2022–26: sacks, picks, fumbles, bad snaps and flags all happen.',
      'Nothing tells you which call is best until the ball is snapped.',
    ].forEach((t) => ul.append(el('li', '', t)));
    openModal('How to play', [
      el('p', 'lead', 'Three real late-game spots a day. You call every play for one team until the game ends.'),
      ul,
      el('p', '', 'After each snap you see how your call ranked against every other call, simulated 600 times each:'),
      ex,
      el('p', 'note', 'Green: the best call or within half a point of win chance. Yellow: up to 2 points worse. Orange: up to 5. Red: more than 5.'),
      el('p', '', 'Your daily score is how your calls compare with NFL play-callers in the same three spots. New spots every day at midnight.'),
    ]);
  }
  function openStats() {
    const st = load(`${STORE}:stats`, { days: {} });
    const days = Object.keys(st.days).map(Number).sort((a, b) => a - b);
    let streak = 0; for (let k = dayN; st.days[k]; k--) streak++;
    const avg = days.length ? days.reduce((a, k) => a + st.days[k].p, 0) / days.length : 0;
    const best = days.length ? Math.max(...days.map((k) => st.days[k].p)) : 0;
    const row = el('div', 'stats');
    [[days.length, 'Played'], [days.length ? Math.round(avg * 100) : '–', 'Average percentile'], [streak, 'Day streak'], [days.length ? Math.round(best * 100) : '–', 'Best day']]
      .forEach(([v, l]) => { const c = el('div'); c.append(el('b', '', String(v)), el('span', '', l)); row.append(c); });
    const dist = el('div', 'dist');
    const buckets = [[80, 101, '80–100'], [60, 80, '60–79'], [40, 60, '40–59'], [20, 40, '20–39'], [0, 20, '0–19']];
    const counts = buckets.map(([lo, hi]) => days.filter((k) => st.days[k].p * 100 >= lo && st.days[k].p * 100 < hi).length);
    const mx = Math.max(1, ...counts);
    const todayP = st.days[dayN] ? st.days[dayN].p * 100 : null;
    buckets.forEach(([lo, hi, lab], i) => {
      const r = el('div', 'r');
      const bar = el('div', `bar${todayP != null && todayP >= lo && todayP < hi ? ' hi' : ''}`, String(counts[i]));
      bar.style.width = `${Math.max(8, (counts[i] / mx) * 100)}%`;
      r.append(el('span', '', lab), bar);
      dist.append(r);
    });
    const nodes = [row, el('p', 'note', 'Daily percentile against NFL play-callers'), dist];
    if (state && state.done) {
      const decs = allDecisions();
      const tbl = el('table', 'opts');
      tbl.append(el('caption', '', 'Today, call by call'));
      decs.forEach((x) => {
        const tr = el('tr');
        tr.append(el('td', '', `${GLYPH[markOf(x.cost)]} ${x.situation}`), el('td', '', x.chosenLabel), el('td', 'n', x.best === x.chosen ? 'best' : pts(-x.cost)));
        tbl.append(tr);
      });
      nodes.push(tbl);
    }
    openModal('Your stats', nodes);
  }

  // ----------------------------------------------------------------- boot ---
  async function boot() {
    $('helpBtn').addEventListener('click', openHelp);
    $('statsBtn').addEventListener('click', openStats);
    $('board').addEventListener('click', () => { if (G) spotInfo(); });
    $('mClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
    setPlaying(false);
    statusPanel('Loading 160,000 real plays…');
    try {
      idx = await fetch('game.json').then((r) => { if (!r.ok) throw new Error('game data ' + r.status); return r.json(); });
      idx.calls.forEach((c) => { CALL[c.id] = c; });
      const launch = new Date(idx.launch + 'T00:00:00');
      const now = new Date(); now.setHours(0, 0, 0, 0);
      dayN = Math.max(1, Math.floor((now - launch) / 864e5) + 1);
      const ids = idx.schedule[(dayN - 1) % idx.schedule.length];
      const chunks = [...new Set(ids.map((i) => Math.floor(i / idx.chunk)))];
      const got = {};
      await Promise.all(chunks.map((c) => fetch(`spots/${String(c).padStart(2, '0')}.json`)
        .then((r) => { if (!r.ok) throw new Error('spots ' + r.status); return r.json(); }).then((j) => { got[c] = j; })));
      today = ids.map((i) => got[Math.floor(i / idx.chunk)][i % idx.chunk]);
      $('dayLabel').textContent = `No. ${dayN} · ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    } catch (e) { fatal('Today\'s spots did not load (' + e.message + '). Check your connection and reload.'); return; }
    state = load(`${STORE}:day:${dayN}`, null) || { spots: [], current: 0, done: false };
    if (!load(`${STORE}:seen`, false)) { openHelp(); save(`${STORE}:seen`, true); }
    drawTiles();
    onReady = () => {
      if (state.done) { renderSummary(); return; }
      startSpot(Math.min(state.current || 0, 2));
    };
    startWorkers();
  }
  boot();
})();
