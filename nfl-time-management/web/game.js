/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * Three real late-game spots a day, played with today's rosters. Each spot opens on a scenario card;
 * Next shows the whole field (their end zone at the top, yours at the bottom) with every player as a dot
 * from red to green by his overall rating. Call Run, Pass or RPO (or a timeout, spike, kneel or kick when it
 * matters), then the play. The nflclock engine (engine.js, in Web Workers) plays the snap from real NFL
 * plays of that call and values every option by simulating the rest of the game. Nothing says which call
 * is best until after the snap. The day ends with a percentile against NFL play-callers and the head
 * coach whose late-game calls look most like yours. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RUN = 0, PASS = 1, KNEEL = 2, SPIKE = 3;
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const N_EVAL = 600;
  const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const STORE = 'tmd:v3';
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
  const CLOCK = {
    play: { label: 'Run a play', act: { to_off: false } },
    timeout: { label: 'Timeout', act: { to_off: true } },
    spike: { label: 'Spike', act: { to_off: false, play: 'spike' } },
    kneel: { label: 'Kneel', act: { to_off: false, play: 'kneel' } },
  };
  const POS_NAME = { QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end', LT: 'Left tackle',
    LG: 'Left guard', C: 'Center', RG: 'Right guard', RT: 'Right tackle', EDGE: 'Edge rusher', DL: 'Defensive tackle',
    LB: 'Linebacker', CB: 'Cornerback', S: 'Safety', K: 'Kicker', P: 'Punter' };
  // our overall rating (40-99) is how he has played, on these measures, blended with how the league values him
  const POS_METHOD = {
    QB: 'EPA per play and completion % over expected',
    RB: 'rush yards over expected, rushing EPA, scrimmage yards per game and receiving EPA',
    WR: 'receiving yards per game, target and air-yards share, EPA per target and yards after the catch over expected',
    TE: 'receiving yards per game, target and air-yards share, EPA per target and yards after the catch over expected',
    OL: 'his line\'s pressure rate allowed and yards before contact, since no public stat grades linemen one at a time',
    EDGE: 'pressure rate, sacks, tackles for loss and QB hits',
    DL: 'pressure rate, sacks, tackles for loss and QB hits',
    LB: 'tackling, tackles for loss, missed-tackle rate, coverage and pressures',
    CB: 'passer rating allowed, interceptions and passes defended per target, yards per target and missed tackles',
    S: 'passer rating allowed, passes defended, missed-tackle rate, tackles and tackles for loss',
  };
  const POS_PLURAL = { QB: 'quarterbacks', RB: 'running backs', WR: 'wide receivers', TE: 'tight ends', OL: 'offensive linemen',
    EDGE: 'edge rushers', DL: 'interior linemen', LB: 'linebackers', CB: 'cornerbacks', S: 'safeties', K: 'kickers', P: 'punters' };
  const OL = ['LT', 'LG', 'C', 'RG', 'RT'];
  const DEEP = new Set(['deep_strong', 'deep_weak', 'deep_middle', 'pa_deep', 'hail_mary']);
  const SQ = { g: '🟩', y: '🟨', o: '🟧', r: '🟥' };
  const GLYPH = { g: '✓', y: '≈', o: '!', r: '✗' };
  const WHY = {
    pass: ['throw it more than most in these spots', 'lean on the run late'],
    deep: ['take your deep shots', 'keep the ball short'],
    go: ['go for it on fourth down', 'kick it away on fourth down'],
    two: ['go for two', 'take the extra point'],
  };

  let idx = null;                 // game.json
  let dayN = 1, today = [];
  let state = null;               // saved progress for today
  let G = null;                   // the spot being played
  let ui = { step: null, fam: null, oob: false };
  let busy = false, lastFocus = null, tick = null, lastBall = null;
  const CALL = {};

  // ------------------------------------------------------------- helpers ---
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const wpTxt = (p) => `${(p * 100).toFixed(1)}%`;
  const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  function key(label, sub, cls, i) {
    const b = el('button', `key${cls ? ' ' + cls : ''}`);
    b.type = 'button';
    b.append(document.createTextNode(label));
    if (sub) b.append(el('small', '', sub));
    if (i != null) { b.classList.add('pop'); b.style.setProperty('--i', i); }
    return b;
  }
  const teamName = (c) => (TEAMS[c] ? TEAMS[c][0] : c);
  const color = (c) => (TEAMS[c] ? TEAMS[c][1] : '#556');
  const code = (i) => (i === 0 ? G.scen.home : G.scen.away);
  const teamOf = (i) => (i === 0 ? G.scen.game.home : G.scen.game.away);
  const markOf = (cost) => (cost < 0.005 ? 'g' : cost < 0.02 ? 'y' : cost < 0.05 ? 'o' : 'r');
  function rate(o) {          // an overall rating as a color: red (below a starter) -> yellow (typical, 77) -> green (elite)
    const v = clip(o, 55, 95);
    const h = v < 77 ? 2 + ((v - 55) / 22) * 43 : 45 + ((v - 77) / 18) * 90;
    const l = v < 77 ? 52 : 50 - ((v - 77) / 18) * 4;
    return `hsl(${h.toFixed(0)} ${v > 72 && v < 82 ? 88 : 80}% ${l.toFixed(0)}%)`;
  }
  const groupOf = (label) => (OL.includes(label) || label === 'T' || label === 'G' ? 'OL' : label);
  function rankOf(p, label) {  // where his rating sits among the league's starters at his position
    const g = groupOf(label), all = [];
    Object.values(idx.teams).forEach((t) => {
      if (g === 'K' || g === 'P') all.push((g === 'K' ? t.kicker : t.punter).ovr);
      else [...t.lineup.off, ...t.lineup.def].forEach((q) => { if (groupOf(q.pos) === g) all.push(q.ovr); });
    });
    return { rank: all.filter((v) => v > p.ovr).length + 1, of: all.length, g };
  }
  function shortName(n) {
    const parts = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/, '').split(/\s+/);
    return parts.length > 1 ? `${parts[0][0]}.${parts.slice(1).join(' ')}` : (n || '');
  }
  function clockOf(t) {
    const q = t > 2700 ? 1 : t > 1800 ? 2 : t > 900 ? 3 : 4;
    const s = Math.max(0, t - (4 - q) * 900);
    return { q, s, text: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` };
  }
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  function spotText(r) {
    if (Math.round(r.yl) === 50) return 'midfield';
    const own = r.pos === G.me;
    if (r.yl > 50) return own ? `your ${Math.round(100 - r.yl)}` : `their ${Math.round(100 - r.yl)}`;
    return own ? `their ${Math.round(r.yl)}` : `your ${Math.round(r.yl)}`;
  }
  const onSpot = (r) => { const t = spotText(r); return t === 'midfield' ? 'at midfield' : `on ${t}`; };
  function ddText(r) {
    const goal = r.ytg >= r.yl;
    return `${ordinal(r.down)} & ${goal ? 'Goal' : Math.max(1, Math.round(r.ytg))}`;
  }
  function startRoot(sc) {
    const st = sc.start;
    return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sc.home ? 0 : 1,
      score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl,
      to: [st.to[1], st.to[0]], clock_running: !!st.running, phase: SNAP, credit: 0, free_kick: false };
  }
  function buildScen(sp) {
    const H = idx.teams[sp.home], A = idx.teams[sp.away];
    const game = { home: H, away: A, home_spread: (idx.hfa || 1.5) + (H.power || 0) - (A.power || 0), indoor: sp.indoor,
      wind: sp.wind, temp: sp.temp, league: idx.league, home_coach: H.coach, away_coach: A.coach, season: idx.asof.season };
    return { ...sp, game };
  }
  const sideFor = (seq) => (hash('side', dayN, G.si, seq) % 2 ? 1 : -1);   // +1: strong side on the offense's right
  const lineup = (i) => (teamOf(i).lineup || { off: [], def: [] });
  function names(i) {
    const off = lineup(i).off;
    const qb = off.find((p) => p.pos === 'QB'), rb = off.find((p) => p.pos === 'RB');
    return { qb: qb ? shortName(qb.name) : null, rb: rb ? shortName(rb.name) : null };
  }

  // -------------------------------------------------------- worker pool ---
  const pool = [], queue = [], pending = new Map();
  let reqId = 0, readyCount = 0;
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
    if (m.type === 'ready') { slot.ready = true; readyCount++; pump(); return; }
    if (m.type === 'error' && m.id == null) { fatal('The simulator could not load (' + m.message + '). Check your connection and reload.'); return; }
    slot.busy = false;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) { if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m); }
    pump();
  }
  function send(msg) {
    return new Promise((resolve, reject) => { msg.id = ++reqId; pending.set(msg.id, { resolve, reject }); queue.push(msg); pump(); });
  }
  const simScen = () => ({ id: G.scen.id, game: G.scen.game, start: { receive2h: G.scen.start.receive2h } });
  async function evaluate(root, options, seed) {
    const k = Math.min(Math.max(1, readyCount), options.length);
    const chunks = Array.from({ length: k }, () => []);
    options.forEach((o, i) => chunks[i % k].push({ key: o.key, action: o.action }));
    const sc = simScen();
    const res = await Promise.all(chunks.map((c) => send({ type: 'eval', scen: sc, root, options: c, n: N_EVAL, persp: G.me, seed })));
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

  // ---------------------------------------------------------- formations ---
  // x in the offense's own frame (its right is +), depth in yards behind (offense) or off (defense) the ball
  const SX0 = 8, SX1 = 352, XYD = (SX1 - SX0) / 53.333;
  const HASH_L = SX0 + 23.58 * XYD, HASH_R = SX1 - 23.58 * XYD;
  const clampX = (x) => clip(x, SX0 + 12, SX1 - 12);
  function formation(offL, defL, s, bx) {
    const by = {};
    offL.forEach((p) => { (by[p.pos] = by[p.pos] || []).push(p); });
    const take = (pos) => (by[pos] && by[pos].length ? by[pos].shift() : null);
    const off = [], def = [];
    const put = (arr, p, x, d, label) => { if (p) arr.push({ p, x: clampX(x), d, label: label || p.pos }); };
    const olX = { LT: -52, LG: -26, C: 0, RG: 26, RT: 52 };
    OL.forEach((lab) => put(off, take(lab), bx + olX[lab], 1.0, lab));
    ['T', 'G'].forEach((lab) => { let p; while ((p = take(lab))) put(off, p, bx, 1.0, lab); });
    const teX = bx + s * 78;
    const xX = s > 0 ? SX0 + 22 : SX1 - 22, zX = s > 0 ? SX1 - 26 : SX0 + 26, slotX = (teX + zX) / 2;
    put(off, take('TE'), teX, 1.15, 'TE');
    put(off, take('WR'), xX, 1.0, 'WR');
    put(off, take('WR'), zX, 1.5, 'WR');
    put(off, take('WR'), slotX, 1.7, 'WR');
    put(off, take('QB'), bx, 5.0, 'QB');
    put(off, take('RB'), bx - s * 25, 5.2, 'RB');
    const spare = [[bx - s * 78, 1.15], [bx + s * 25, 5.2], [(xX + bx - s * 52) / 2, 1.7]];
    Object.values(by).flat().forEach((p, i) => { const sp = spare[i % spare.length]; put(off, p, sp[0], sp[1]); });
    const g = { EDGE: [], DL: [], LB: [], CB: [], S: [], X: [] };
    defL.forEach((p) => (g[p.pos] || g.X).push(p));
    const edges = g.EDGE.slice(), line = [];
    if (edges.length) line.push(edges.shift());
    line.push(...g.DL, ...edges);
    const n = line.length, sp = n <= 4 ? 34 : n === 5 ? 29 : 25;
    line.forEach((p, i) => put(def, p, bx + s * (i - (n - 1) / 2) * sp, 1.0));
    const nl = g.LB.length, lsp = nl >= 3 ? 40 : 46;
    g.LB.forEach((p, i) => put(def, p, bx + s * 8 + (i - (nl - 1) / 2) * lsp, 5.0));
    const cbs = [[clampX(zX), 6.5], [clampX(xX), 6.5], [clampX(slotX), 5.5], [bx + s * 34, 9.0]];
    g.CB.forEach((p, i) => { const c = cbs[Math.min(i, 3)]; put(def, p, c[0] + (i > 3 ? (i - 3) * 30 : 0), c[1]); });
    const ns = g.S.length, third = g.CB.length < 3 ? [clampX(slotX), 5.6] : [teX, 7.6];
    const ss = ns === 1 ? [[bx + s * 12, 13]] : [[bx - s * 62, 12.5], [bx + s * 62, 12.5], third, [bx, 10]];
    g.S.forEach((p, i) => { const c = ss[Math.min(i, ss.length - 1)]; put(def, p, c[0], c[1]); });
    g.X.forEach((p, i) => put(def, p, bx + (i - (g.X.length - 1) / 2) * 40, 8));
    return { off, def };
  }
  // ------------------------------------------------------------ the field ---
  // The whole field, your end zone at the bottom of the screen. L counts yards from your goal line (0) to
  // theirs (100); a camera shows yards lo..hi: the whole field, or close up while a play runs.
  const FULL = { lo: -10, hi: 110 };
  const GAP = 6;            // drawn gap (units) between each side and the line of scrimmage before the snap
  let scene = null, fadeNext = false;
  const lerp = (a, b, u) => a + (b - a) * u;
  const EASE = { lin: (u) => u, io: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
    in: (u) => u * u, out: (u) => 1 - (1 - u) * (1 - u) };

  function spotGeom(r) {
    const mine = r.pos === G.me;
    let L, dir = mine ? 1 : -1, mode = 'snap';
    if (r.phase === KICKOFF) { mode = 'kick'; const own = r.free_kick ? 20 : 35; L = mine ? own : 100 - own; }
    else if (r.phase === PAT) { mode = 'pat'; L = mine ? 85 : 15; }
    else if (r.phase === DONE) { mode = 'done'; L = mine ? 100 - r.yl : r.yl; }
    else L = mine ? 100 - r.yl : r.yl;
    return { L, dir, mode };
  }
  // where the next snap is, in L, after a play (whoever has the ball)
  const losOf = (r) => (r.pos === G.me ? 100 - r.yl : r.yl);
  function fieldHeight() {
    const svg = $('field');
    const wpx = svg.parentElement.clientWidth || 360;
    return Math.round((360 * clip(window.innerHeight - 380, 360, 720)) / wpx);
  }
  const camY = (sc) => { const { lo, hi } = sc.cam, k = (sc.H - 6) / (hi - lo); return (L) => sc.H - 3 - (L - lo) * k; };

  // the field and the 22 for state r (side: the strong side of this snap); place() draws them for the camera
  function makeScene(r, side) {
    const svg = $('field'), H = fieldHeight();
    svg.setAttribute('viewBox', `0 0 360 ${H}`);
    svg.textContent = '';
    svg.classList.remove('playing');
    const sc = { svg, H, r, cam: { ...FULL }, parts: [], actors: [], calls: [] };
    const put = (el, upd) => { svg.append(el); if (upd) sc.parts.push(upd); return el; };
    put(S('rect', { x: 0, y: 0, width: 360, height: H, fill: 'var(--turf)' }));
    for (let L = 0; L < 100; L += 10) {
      const e = put(S('rect', { x: 0, width: 360, fill: 'var(--turf-2)' }), (Y) => { e.setAttribute('y', Y(L + 5)); e.setAttribute('height', Math.max(0, Y(L) - Y(L + 5))); });
    }
    [[100, 110, code(1 - G.me)], [-10, 0, code(G.me)]].forEach(([a, b, c]) => {
      const e = put(S('rect', { x: 0, width: 360, fill: color(c), opacity: 0.92 }), (Y) => { e.setAttribute('y', Y(b)); e.setAttribute('height', Math.max(0, Y(a) - Y(b))); });
      const t = put(S('text', { x: 180, class: 'ez', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, teamName(c).toUpperCase()), (Y) => t.setAttribute('y', (Y(a) + Y(b)) / 2));
    });
    const hline = (L, attrs) => {
      const e = put(S('line', { x1: SX0, x2: SX1, ...attrs }), (Y) => { const y = Y(L); e.setAttribute('y1', y); e.setAttribute('y2', y); });
      return e;
    };
    for (let L = 5; L <= 95; L += 5) hline(L, { stroke: 'var(--chalk)', 'stroke-width': L % 10 ? 0.6 : 1.1, opacity: L % 10 ? 0.6 : 1 });
    [0, 100].forEach((L) => hline(L, { stroke: 'var(--chalk)', 'stroke-width': 2.4 }));
    [-10, 110].forEach((L) => {     // the goalposts on each end line, seen from above
      const e = put(S('path', { class: 'posts' }), (Y) => { const y = Y(L), k = L < 0 ? -1 : 1; e.setAttribute('d', `M160 ${y + k * 5}V${y}H200V${y + k * 5}`); });
    });
    put(S('line', { x1: SX0, y1: 0, x2: SX0, y2: H, stroke: 'var(--chalk)', 'stroke-width': 1.6 }));
    put(S('line', { x1: SX1, y1: 0, x2: SX1, y2: H, stroke: 'var(--chalk)', 'stroke-width': 1.6 }));
    for (let L = 10; L <= 90; L += 10) {
      const n = String(L <= 50 ? L : 100 - L);
      [[SX0 + 9, -90], [SX1 - 9, 90]].forEach(([x, rot]) => {
        const e = put(S('text', { x, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, n),
          (Y) => { const y = Y(L); e.setAttribute('y', y); e.setAttribute('transform', `rotate(${rot} ${x} ${y})`); });
      });
    }
    const { L, dir, mode } = spotGeom(r);
    Object.assign(sc, { losL: L, dir, mode });
    if (mode === 'done') { place(sc); return sc; }
    hline(L, { stroke: 'var(--los)', 'stroke-width': 2.4 });
    if (mode === 'snap' && r.ytg < r.yl - 0.01) hline(L + dir * r.ytg, { stroke: 'var(--chain)', 'stroke-width': 2.4 });
    const s = mode === 'snap' ? side : 1;
    const fxBall = mode === 'snap' ? (s > 0 ? HASH_L : HASH_R) : 180;     // strong side is the wide side
    const sx = (fx) => (dir > 0 ? fx : 360 - fx);
    Object.assign(sc, { s, bx: sx(fxBall) });
    sc.layer = put(S('g', {}));
    if (mode === 'snap' || mode === 'pat') {
      const offI = r.pos, f = formation(lineup(offI).off.slice(), lineup(1 - offI).def.slice(), s, fxBall);
      const add = (o, teamI, off) => {
        const team = code(teamI), mine = teamI === G.me;
        const g = S('g', { class: `dot ${mine ? 'me' : 'them'}`, tabindex: 0, role: 'button',
          'aria-label': `${teamName(team)} ${POS_NAME[o.label] || o.label} ${o.p.name}, rated ${o.p.ovr}` });
        g.append(S('circle', { class: 'hit', r: 11 }), S('circle', { class: 'c', r: 6.2, fill: rate(o.p.ovr) }));
        const open = () => playerInfo(o.p, o.label, team);
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
        sc.layer.append(g);
        const a = { g, p: o.p, label: o.label, team, teamI, off, x0: sx(o.x), L0: L + (off ? -dir : dir) * o.d, side: off ? dir : -dir };
        Object.assign(a, { x: a.x0, L: a.L0, w: 1 });
        sc.actors.push(a);
      };
      f.def.forEach((o) => add(o, 1 - offI, false));
      f.off.forEach((o) => add(o, offI, true));
    }
    const ball = S('g', {}), inner = S('g', { class: 'ballmove' });
    inner.append(S('ellipse', { cx: 0, cy: 0, rx: 3.4, ry: 5.2, fill: 'var(--ball)', stroke: 'rgba(255,255,255,.75)', 'stroke-width': 0.8 }));
    ball.append(inner);
    svg.append(ball);
    sc.ball = { g: ball, inner, x: sc.bx, L, z: 0, show: true };
    sc.callLayer = put(S('g', {}));
    if (mode === 'kick') showCall(sc, { text: r.free_kick ? 'Free kick' : 'Kickoff', kind: 'info', slot: 0, x: 180, L: L + dir * 7 });
    place(sc);
    return sc;
  }
  function place(sc) {
    const Y = camY(sc);
    sc.parts.forEach((f) => f(Y));
    sc.actors.forEach((a) => a.g.setAttribute('transform', `translate(${a.x.toFixed(1)},${(Y(a.L) + a.side * GAP * a.w).toFixed(1)})`));
    const b = sc.ball;
    if (b) {
      b.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${Y(b.L).toFixed(1)}) scale(${(1 + b.z).toFixed(2)})`);
      b.g.style.opacity = b.show ? 1 : 0;
    }
    sc.calls.forEach((c) => {
      const at_ = c.follow ? { x: c.follow.x, L: c.follow.L } : c;
      const x = clip(at_.x, c.w / 2 + 6, 354 - c.w / 2), y = clip(Y(at_.L) - 26 - c.slot * 30, 18, sc.H - 18);
      c.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    });
  }
  // a call-out on the field: "SACKED!", "TOUCHDOWN!", "FLAG: HOLDING"...; one per slot
  function showCall(sc, c) {
    sc.calls.filter((o) => o.slot === c.slot).forEach((o) => o.g.remove());
    sc.calls = sc.calls.filter((o) => o.slot !== c.slot);
    const big = c.kind === 'hit' || c.kind === 'good';
    const g = S('g', { class: `call ${c.kind}` }), inn = S('g', { class: 'in' });
    const t = S('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: big ? 'big' : '' }, c.text);
    const rect = S('rect', { rx: 7 });
    inn.append(rect, t);
    g.append(inn);
    sc.callLayer.append(g);
    let w = c.text.length * (big ? 11 : 8.5);
    try { w = t.getComputedTextLength() || w; } catch (err) { /* not rendered yet */ }
    w += 20;
    const h = big ? 32 : 25;
    Object.entries({ x: -w / 2, y: -h / 2, width: w, height: h }).forEach(([k, v]) => rect.setAttribute(k, v));
    c.shown = true;
    sc.calls.push({ ...c, g, w });
  }

  function drawField() {
    const sc = makeScene(G.root, G.side);
    scene = sc;
    if (fadeNext || lastBall) sc.layer && sc.layer.classList.add('movefade');
    fadeNext = false;
    const b = sc.ball;
    if (!b || sc.mode === 'done') { lastBall = null; return; }
    const y = camY(sc)(b.L);
    if (lastBall && !reduced() && (Math.abs(lastBall.x - b.x) > 0.5 || Math.abs(lastBall.y - y) > 0.5)) {
      b.inner.style.transform = `translate(${lastBall.x - b.x}px, ${lastBall.y - y}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { b.inner.style.transform = 'translate(0px, 0px)'; }));
    }
    lastBall = { x: b.x, y };
  }

  // ------------------------------------------------------ the play, animated ---
  // After the snap the camera zooms in and the 22 run the real NFL play the engine drew: the snap, the
  // handoff or the drop, the routes, the rush, the throw, the run after the catch and the tackle, with
  // what happened called out on the field. Tap the field to skip; with reduced motion the result just shows.
  const PRE_SNAP = new Set(['False Start', 'Offside', 'Defensive Offside', 'Encroachment', 'Neutral Zone Infraction', 'Delay of Game',
    'Illegal Formation', 'Illegal Shift', 'Illegal Motion', 'Defensive Delay of Game', 'Defensive Too Many Men on Field',
    'Offensive Too Many Men on Field', 'Illegal Substitution']);
  const RUN_GAP = { 'Outside run': 92, 'Off-tackle run': 58, 'Inside run': 26, 'Up the middle': 0, 'QB sneak': 0, 'QB keeper': 60, RPO: 30 };
  const AIR = { quick_strong: 5, quick_weak: 5, quick_middle: 7, screen: -2, deep_strong: 24, deep_weak: 24, deep_middle: 22,
    pa_short: 9, pa_deep: 27, roll_strong: 8, roll_weak: 8, hail_mary: 48, rpo_strong: 4, rpo_weak: 4, trick: 30 };
  const RELEASE = { quick: 0.8, screen: 0.75, deep: 1.3, pa: 1.4, roll: 1.25, hail: 1.6, rpo: 0.7, trick: 1.75 };
  const PLAY_SPEED = 0.85;     // playback speed (1 = the pace the plays are drawn at); your snaps, theirs 1.25x this

  function kf(a, t, x, L, w, e) {
    if (!a) return;
    if (!a.kf) a.kf = [[0, a.x0, a.L0, 1, 'io']];
    const last = a.kf[a.kf.length - 1];
    a.kf.push([Math.max(t, last[0]), x, L, w === undefined ? 0 : w, e || 'io']);
  }
  function at(a, t) {       // where actor a is at play time t
    const k = a.kf;
    if (!k) return { x: a.x0, L: a.L0, w: 1 };
    let i = 1;
    while (i < k.length && k[i][0] < t) i++;
    if (i >= k.length) { const z = k[k.length - 1]; return { x: z[1], L: z[2], w: z[3] }; }
    const [t0, x0, L0, w0] = k[i - 1], [t1, x1, L1, w1, e] = k[i];
    const u = EASE[e](clip((t - t0) / Math.max(t1 - t0, 1e-6), 0, 1));
    return { x: lerp(x0, x1, u), L: lerp(L0, L1, u), w: lerp(w0, w1, u) };
  }
  const lastKf = (a) => (a.kf ? a.kf[a.kf.length - 1] : [0, a.x0, a.L0, 1]);
  function ballAt(sc, P, t) {
    let seg = null;
    for (const s of P.segs) if (s.t0 <= t + 1e-9) seg = s;
    if (!seg) return { x: sc.bx, L: sc.losL, z: 0, show: true };
    if (seg.kind === 'hold') { const p = at(seg.a, t); return { x: p.x + 5, L: p.L, z: 0, show: true }; }
    if (seg.kind === 'fly') {
      const u = clip((t - seg.t0) / Math.max(seg.t1 - seg.t0, 1e-6), 0, 1);
      return { x: lerp(seg.x0, seg.x1, u), L: lerp(seg.L0, seg.L1, u), z: seg.h * 4 * u * (1 - u), show: true };
    }
    return { x: seg.x, L: seg.L, z: 0, show: !seg.hide };
  }
  function cast(sc) {
    const off = sc.actors.filter((a) => a.off), def = sc.actors.filter((a) => !a.off);
    const is = (lab) => (a) => a.label === lab;
    return { off, def, qb: off.find(is('QB')), rb: off.find(is('RB')), recv: off.filter((a) => a.label === 'WR' || a.label === 'TE'),
      ol: off.filter((a) => OL.includes(a.label) || a.label === 'T' || a.label === 'G'),
      rush: def.filter((a) => a.label === 'EDGE' || a.label === 'DL'), cover: def.filter((a) => a.label === 'CB' || a.label === 'S' || a.label === 'LB') };
  }
  const near = (list, x, L, skip) => {
    let best = null, bd = Infinity;
    (list || []).forEach((a) => {
      if (!a || (skip && skip.has(a))) return;
      const p = lastKf(a), d = (p[1] - x) ** 2 + ((p[2] - L) * XYD) ** 2;
      if (d < bd) { bd = d; best = a; }
    });
    return best;
  };

  function choreograph(sc, e, res, two) {
    const P = { T: 1, hold: 0.95, segs: [], calls: [], fx: [] };
    const dir = sc.dir, L0 = sc.losL, bx = sc.bx;
    const fwd = (L, y) => L + dir * y;
    const R = rng(hash('anim', e.row, e.t, e.yards, e.ev));
    const jit = (n) => (R() * 2 - 1) * n;
    const say = (t, text, kind, o) => P.calls.push({ t, text, kind, slot: 0, x: bx, L: L0, ...(o || {}) });
    const fly = (t0, t1, x0, La, x1, Lb, h) => P.segs.push({ t0, t1, kind: 'fly', x0, L0: La, x1, L1: Lb, h: h || 0 });
    const hold = (t0, a) => { if (a) P.segs.push({ t0, kind: 'hold', a }); };
    const rest = (t0, x, L, hide) => P.segs.push({ t0, kind: 'rest', x, L, hide });
    const fxAt = (t, f) => P.fx.push({ t, f });
    const down = (t, a) => { if (a) fxAt(t, () => a.g.classList.add('down')); };
    const ring = (t, a, on) => { if (a) fxAt(t, () => a.g.classList.toggle('carrier', on !== false)); };
    const K = cast(sc), qb = K.qb;
    const defName = teamName(code(1 - e.team));
    const used = new Set();
    const endL = (yards, td) => (td ? (dir > 0 ? 103 : -3) : clip(fwd(L0, yards), -9.5, 109.5));
    const sideline = (x) => (x > 180 ? SX1 + 4 : SX0 - 4);

    // everyone not scripted: linemen engage, receivers release, the defense flows to the ball
    function ambient(t1, x, L) {
      sc.actors.forEach((a) => {
        if (used.has(a)) return;
        const p = lastKf(a);
        if (p[0] >= t1) return;
        if (a.off) {
          if (K.ol.includes(a)) { if (!a.kf) kf(a, 0.5, a.x0, fwd(L0, -0.5), 0); kf(a, t1, p[1], fwd(L0, 0.6), 0, 'out'); }
          else kf(a, t1, p[1] + (x - p[1]) * 0.15, p[2] + (L - p[2]) * 0.3 + dir * 2, 0, 'io');
        } else {
          if (!a.kf) kf(a, 0.45, a.x0, a.L0 - dir * 0.6, 0);
          kf(a, t1, lerp(p[1], x, 0.4), lerp(p[2], L, 0.45), 0, 'io');
        }
      });
    }
    // the ball carrier's last stretch: a missed tackle, the tackle, the score, the fumble
    function finish(car, t0, t1, xEnd, Lend) {
      used.add(car);
      if (e.bt && t1 - t0 > 0.3) {
        const tb = t0 + (t1 - t0) * 0.4, p = at(car, tb), d = near(K.def, p.x, p.L, used);
        if (d) { used.add(d); kf(d, tb, p.x + 6, p.L + dir * 0.5, 0, 'io'); kf(d, tb + 0.4, p.x + 12, p.L - dir * 1.5, 0, 'out'); down(tb + 0.06, d); }
        say(tb, 'Broken tackle!', 'boom', { follow: car });
      }
      const fumble = ['fumble_lost', 'fumble_kept', 'scoop_score'].includes(e.evt);
      for (let i = 0; i < (e.td ? 1 : e.oob ? 1 : 2); i++) {
        const d = near(K.def, xEnd, Lend, used);
        if (!d) break;
        used.add(d);
        if (e.td) kf(d, t1, xEnd + 16, Lend - dir * 3, 0, 'io');
        else kf(d, t1, clampX(xEnd) + (i ? -7 : 7), Lend + dir * (i ? 0.2 : 0.9), 0, 'io');
      }
      ambient(t1, xEnd, Lend);
      let t = t1;
      if (e.td) say(t1, two ? 'Two-point try good!' : 'Touchdown!', 'good', { follow: car });
      else if (e.safety) say(t1, 'Safety!', 'hit', { follow: car });
      else if (fumble) {
        const lost = e.evt !== 'fumble_kept';
        say(t1, 'Fumble!', 'hit', { follow: car });
        const fx = clampX(xEnd + jit(14)), fL = Lend + dir * 1.2;
        fly(t1, t1 + 0.35, xEnd, Lend, fx, fL, 0.3);
        const rec = lost ? near(K.def, fx, fL) : car;
        if (rec && rec !== car) kf(rec, t1 + 0.4, fx, fL, 0, 'io');
        hold(t1 + 0.42, rec);
        t = t1 + 0.42;
        if (e.evt === 'scoop_score' && rec) {
          const Lz = dir > 0 ? -3 : 103;
          t = t + 0.25 + Math.abs(Lz - fL) * 0.035;
          kf(rec, t, clampX(fx + jit(30)), Lz, 0, 'lin');
          say(t, 'Scoop and score!', 'hit', { follow: rec });
        } else say(t, lost ? `${defName} ball` : 'Recovered', lost ? 'hit' : 'info', { slot: 1, follow: rec || car });
        t += 0.2;
      } else if (e.oob) say(t1, 'Out of bounds', 'info', { follow: car });
      else {
        say(t1, fwd(0, Lend - L0) < -0.5 ? 'Stopped for a loss' : two ? 'Stopped short' : 'Tackled', 'info', { follow: car });
        down(t1 + 0.08, car);
      }
      if (e.fd && !e.td) say(t1 + 0.35, 'First down', 'good', { slot: 1, follow: car });
      if (e.onDowns) say(t1 + 0.35, 'Turnover on downs', 'hit', { slot: 1, follow: car });
      P.T = Math.max(P.T, t + 0.4);
    }
    function snapToQb() {
      if (!qb) return;
      fly(0, 0.22, bx, L0, qb.x0, qb.L0, 0.15);
      hold(0.22, qb);
    }
    function pickTarget(id, sign) {
      if (e.who === 'RB' || id === 'screen') return K.rb || K.recv[0];
      const side = (a) => (sign ? sign * (a.x0 - bx) > 0 : true);
      if (e.who === 'TE') return near(K.recv.filter((a) => a.label === 'TE' && side(a)), bx, L0) || K.recv.find((a) => a.label === 'TE') || K.recv[0];
      const wr = K.recv.filter((a) => a.label === 'WR');
      const pool = (wr.length ? wr : K.recv).filter(side);
      const all = pool.length ? pool : (wr.length ? wr : K.recv);
      if (!all.length) return K.rb;
      const out = all.slice().sort((a, b) => Math.abs(b.x0 - bx) - Math.abs(a.x0 - bx));
      return id.startsWith('deep') || id === 'pa_deep' || id === 'hail_mary' ? out[0] : out[out.length - 1];
    }

    function run(c, id, sign) {
      const carrier = (id === 'qb_sneak' || id === 'qb_run' || e.who === 'QB') ? qb
        : (id === 'trick' && e.who === 'WR') ? near(K.recv.filter((a) => a.label === 'WR'), bx - (sign || 1) * 120, L0) : (K.rb || qb);
      if (!carrier) return;
      const gap = RUN_GAP[c ? c.base : ''] ?? 26;
      const sg = sign || (id === 'qb_run' ? sc.s * dir : 0);
      const holeX = clampX(bx + sg * gap);
      const Lend = endL(e.yards, e.td);
      const tH = carrier === qb ? 0.3 : 0.5, tHole = tH + 0.3;
      const t1 = tHole + clip(0.3 + Math.abs(Lend - L0) * 0.05, 0.35, 2.8);
      const xEnd = e.oob ? sideline(sg ? (sg > 0 ? 300 : 60) : holeX) : clampX(holeX + sg * Math.min(26, Math.abs(e.yards) * 1.6) + jit(10));
      snapToQb();
      if (carrier !== qb) {
        if (carrier.label === 'WR') kf(carrier, tH, bx + sg * 8, fwd(L0, -4.5), 0, 'in');
        else kf(carrier, tH, bx + sg * 10, fwd(L0, -4.3), 0, 'io');
        kf(qb, tH, bx + sg * 5, fwd(L0, -5), 0, 'io');
        kf(qb, t1, clampX(bx - (sg || 1) * 22), fwd(L0, -6.5), 0, 'out');      // carries out the fake
        hold(tH, carrier);
      }
      ring(tH, carrier);
      kf(carrier, tHole, holeX, fwd(L0, 0.4), 0, 'in');
      kf(carrier, t1, xEnd, Lend, 0, 'out');
      used.add(qb);
      K.ol.forEach((a) => { kf(a, 0.55, a.x0 + sg * 4, fwd(L0, -0.3), 0); kf(a, t1, a.x0 + sg * 9, fwd(L0, 1.4), 0, 'out'); used.add(a); });
      K.rush.forEach((a) => kf(a, 0.55, a.x0 + sg * 3, fwd(L0, 0.5), 0));
      finish(carrier, tHole, t1, xEnd, Lend);
    }

    function pass(c, id, sign) {
      if (!qb) return;
      const kind = id.startsWith('quick') ? 'quick' : id === 'screen' ? 'screen' : id.startsWith('deep') ? 'deep'
        : id.startsWith('pa_') ? 'pa' : id.startsWith('roll') ? 'roll' : id === 'hail_mary' ? 'hail' : id.startsWith('rpo') ? 'rpo'
          : id === 'trick' ? 'trick' : 'quick';
      const tRel = RELEASE[kind];
      const air = e.air !== undefined ? e.air : (AIR[id] ?? 7);
      let qx = qb.x0, qL = fwd(L0, kind === 'hail' ? -8 : -6.5);
      if (kind === 'roll') { qx = clampX(bx + (sign || sc.s * dir) * 60); qL = fwd(L0, -6); }
      snapToQb();
      used.add(qb);
      if ((kind === 'pa' || kind === 'trick') && K.rb) {
        kf(K.rb, 0.55, bx + 9, fwd(L0, -4.6), 0);
        if (kind === 'trick') { hold(0.55, K.rb); fly(1.0, 1.25, bx + 14, fwd(L0, -3), qx, qL, 0.4); hold(1.25, qb); kf(K.rb, 1.0, bx + 14, fwd(L0, -3), 0); }
        kf(K.rb, tRel, bx + 26, fwd(L0, 1.5), 0, 'io');
      }
      kf(qb, kind === 'quick' || kind === 'rpo' || kind === 'screen' ? 0.55 : 0.85, qx, qL, 0, 'io');
      const tgt = pickTarget(id, sign) || K.rb;
      const tArr = tRel + 0.22 + Math.abs(air) * 0.017;
      let cL = fwd(L0, air), cx;
      if (!tgt) return;
      if (kind === 'screen' || tgt === K.rb) cx = clampX(bx + (sign || (tgt.x0 > bx ? 1 : -1)) * 62);
      else if (id.endsWith('middle')) cx = lerp(tgt.x0, bx, 0.6);
      else if (kind === 'deep' || kind === 'hail') cx = clampX(tgt.x0 + (tgt.x0 > 180 ? 10 : -10));
      else cx = clampX(tgt.x0 + (tgt.x0 > bx ? -14 : 14));
      if (e.evt === 'throwaway') { cx = sideline(qx) + (qx > 180 ? 12 : -12); cL = fwd(L0, Math.max(3, air)); }
      used.add(tgt);
      if (e.evt !== 'throwaway') {
        kf(tgt, tRel, lerp(tgt.x0, cx, 0.4), fwd(L0, Math.min(air * 0.6, Math.max(air - 5, 0))), 0, 'in');
        kf(tgt, tArr, cx, cL, 0, 'lin');
      }
      K.recv.forEach((a) => {
        if (a === tgt) return;
        used.add(a);
        kf(a, tArr + 0.25, clampX(a.x0 + (a.x0 > bx ? -12 : 12) + jit(8)), fwd(L0, kind === 'hail' ? 40 + jit(5) : 9 + Math.abs(jit(7))), 0, 'io');
      });
      if (K.rb && K.rb !== tgt && kind !== 'pa' && kind !== 'trick') { kf(K.rb, 0.6, bx + (qx > bx ? 14 : -14), fwd(L0, -4.2), 0); used.add(K.rb); }
      K.ol.forEach((a) => { kf(a, 0.6, a.x0, fwd(L0, -1.5), 0, 'out'); used.add(a); });
      K.rush.forEach((a) => { kf(a, tArr, lerp(a.x0, qx, 0.25), fwd(L0, -2.4), 0, 'io'); used.add(a); });
      K.cover.forEach((d) => {
        used.add(d);
        if (d.label === 'LB') { kf(d, tArr, d.x0 + jit(10), fwd(L0, 6.5), 0, 'io'); return; }
        const r = near(K.recv, d.x0, d.L0);
        const p = r ? at(r, tArr) : { x: d.x0, L: fwd(d.L0, 3) };
        kf(d, tArr, p.x + (d.x0 < p.x ? -6 : 6), p.L + dir * 1.6, 0, 'io');
      });
      if (kind !== 'trick') hold(0.22, qb);
      ring(0.22, qb);
      fly(tRel, tArr, qx + 4, qL, cx, cL, Math.min(2.2, 0.35 + Math.abs(air) * 0.05));
      ring(tRel, qb, false);
      if (e.evt === 'interception' || e.evt === 'pick_six') {
        const pick = near(K.cover.filter((d) => d.label !== 'LB').concat(K.cover), cx, cL) || K.def[0];
        kf(pick, tArr - 0.02, cx + 3, cL + dir * 0.6, 0, 'io');
        hold(tArr, pick);
        ring(tArr, pick);
        say(tArr, 'Intercepted!', 'hit', { follow: pick });
        const Lret = e.evt === 'pick_six' ? (dir > 0 ? -3 : 103) : clip(losOf(res.root), -9, 109);
        const t1 = tArr + 0.3 + Math.abs(Lret - cL) * 0.045;
        kf(pick, t1, clampX(cx + jit(40)), Lret, 0, 'out');
        const ch = near(K.recv.concat([qb]), cx, cL, new Set([tgt]));
        if (ch) kf(ch, t1, clampX(cx + jit(40)), Lret + dir * 1.5, 0, 'io');
        if (e.evt === 'pick_six') say(t1, 'Pick-six!', 'hit', { follow: pick });
        else down(t1 + 0.05, pick);
        used.add(pick);
        ambient(t1, cx, Lret);
        P.T = t1 + 0.4;
        return;
      }
      if (e.incomplete || ['throwaway', 'drop', 'near_pick'].includes(e.evt)) {
        const brk = near(K.cover, cx, cL);
        if (brk && e.evt !== 'throwaway') kf(brk, tArr, cx + (lastKf(brk)[1] < cx ? -6 : 6), cL + dir * 0.8, 0, 'io');
        const gx = e.evt === 'throwaway' ? cx : clampX(cx + jit(8)), gL = cL + dir * 1.6;
        fly(tArr, tArr + 0.18, cx, cL, gx, gL, 0.15);
        rest(tArr + 0.18, gx, gL);
        rest(tArr + 0.9, gx, gL, true);
        const text = e.evt === 'drop' ? 'Dropped!' : e.evt === 'near_pick' ? 'Almost picked!' : e.evt === 'throwaway' ? 'Thrown away'
          : kind === 'hail' ? 'Knocked down' : two ? 'Incomplete: no good' : 'Incomplete';
        say(tArr, text, e.evt === 'near_pick' ? 'boom' : 'info', { x: clampX(cx), L: cL });
        if (e.evt === 'drop') down(tArr + 0.1, tgt);
        ambient(tArr + 0.35, cx, cL);
        P.T = tArr + 0.8;
        return;
      }
      hold(tArr, tgt);
      ring(tArr, tgt);
      const Lend = endL(e.yards, e.td);
      const t1 = tArr + 0.2 + Math.abs(Lend - cL) * 0.05;
      const xEnd = e.oob ? sideline(cx) : clampX(cx + jit(12));
      kf(tgt, t1, xEnd, Lend, 0, 'out');
      if (Math.abs(Lend - cL) > 4 && !e.bt) say(tArr, 'Caught', 'boom', { follow: tgt });
      finish(tgt, tArr, t1, xEnd, Lend);
    }

    function sack() {
      if (!qb) return;
      snapToQb();
      const qL = fwd(L0, -7), tS = 1.15 + R() * 0.35;
      kf(qb, 0.7, qb.x0, qL, 0, 'io');
      const pool = e.look && e.look.blitz ? K.rush.concat(K.cover.filter((d) => d.label === 'LB')) : K.rush;
      const rusher = near(pool, qb.x0, qL) || K.def[0];
      kf(rusher, tS, qb.x0 + (rusher.x0 < qb.x0 ? -6 : 6), fwd(L0, -6.4), 0, 'in');
      const Lend = clip(fwd(L0, e.yards), -9.5, 109.5);
      kf(qb, tS, qb.x0 + jit(5), qL, 0);
      kf(qb, tS + 0.3, qb.x0 + jit(8), Lend, 0, 'out');
      kf(rusher, tS + 0.3, qb.x0 + jit(8) + 5, Lend + dir * 0.4, 0, 'out');
      [qb, rusher].forEach((a) => used.add(a));
      K.recv.forEach((a) => { kf(a, tS, clampX(a.x0 + jit(10)), fwd(L0, 8 + Math.abs(jit(8))), 0, 'io'); used.add(a); });
      K.ol.forEach((a) => { kf(a, 0.6, a.x0, fwd(L0, -1.6), 0, 'out'); used.add(a); });
      hold(0.22, qb);
      ring(0.22, qb);
      say(tS, e.evt === 'strip_sack' ? 'Strip-sack!' : 'Sacked!', 'hit', { follow: qb });
      down(tS + 0.3, qb);
      let t = tS + 0.3;
      if (e.evt === 'strip_sack' || e.evt === 'sack_fumble') {
        const fx = clampX(qb.x0 + jit(14)), fL = Lend - dir * 1.4;
        fly(tS, tS + 0.35, qb.x0, qL, fx, fL, 0.2);
        const rec = e.evt === 'strip_sack' ? near(K.rush, fx, fL, new Set([rusher])) || rusher : near(K.ol, fx, fL);
        if (rec) { kf(rec, tS + 0.45, fx, fL, 0, 'io'); hold(tS + 0.47, rec); }
        say(tS + 0.45, e.evt === 'strip_sack' ? `${defName} ball` : 'Fumble: recovered', e.evt === 'strip_sack' ? 'hit' : 'info', { slot: 1, follow: rec || qb });
        t = tS + 0.55;
      }
      if (e.safety) say(tS + 0.35, 'Safety!', 'hit', { slot: 1, follow: qb });
      ambient(t, qb.x0, Lend);
      P.T = t + 0.45;
    }

    function scramble() {
      if (!qb) return;
      snapToQb();
      const qL = fwd(L0, -7), tE = 1.15;
      const sg = R() < 0.5 ? -1 : 1;
      kf(qb, 0.7, qb.x0, qL, 0, 'io');
      kf(qb, tE, clampX(qb.x0 + sg * 30), fwd(L0, -6), 0, 'io');
      const Lend = endL(e.yards, e.td);
      const t1 = tE + 0.2 + Math.abs(Lend - fwd(L0, -6)) * 0.05;
      const xEnd = e.oob ? sideline(qb.x0 + sg * 60) : clampX(qb.x0 + sg * 60 + jit(20));
      kf(qb, t1, xEnd, Lend, 0, 'out');
      K.recv.forEach((a) => { kf(a, t1, clampX(a.x0 + jit(14)), fwd(L0, 9 + Math.abs(jit(9))), 0, 'io'); used.add(a); });
      K.ol.forEach((a) => { kf(a, 0.6, a.x0, fwd(L0, -1.5), 0, 'out'); used.add(a); });
      K.rush.forEach((a) => { kf(a, tE, lerp(a.x0, qb.x0, 0.3), fwd(L0, -3.5), 0, 'io'); });
      ring(0.22, qb);
      say(tE, 'Scramble!', 'boom', { follow: qb });
      finish(qb, tE, t1, xEnd, Lend);
    }

    function flag(tFlag, text) {       // the yellow flag lands near the line, then stays with the camera
      const g = S('g', { class: 'flagmark' }), fx = clampX(bx + jit(30)), fL = fwd(L0, 1 + Math.abs(jit(3)));
      g.append(S('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5, transform: 'rotate(18)' }));
      fxAt(tFlag, () => {
        sc.callLayer.before(g);
        sc.parts.push((Y) => g.setAttribute('transform', `translate(${fx.toFixed(1)},${Y(fL).toFixed(1)})`));
      });
      say(tFlag, text, 'flag');
    }

    if (e.ev === 'play') {
      const c = e.call >= 0 ? idx.calls[e.call] : null;
      const id = c ? c.id : '';
      const sign = !c || !c.side || c.side === 'middle' ? 0 : (c.side === 'strong' ? 1 : -1) * sc.s * dir;
      if (e.penalty && (PRE_SNAP.has(e.pen) || !(e.dur > 0))) {     // a flag before the snap: nobody moves far
        const jumper = /Offside|Encroachment|Neutral Zone/.test(e.pen || '') ? near(K.rush, bx, L0) : near(K.ol, bx, L0);
        if (jumper) { kf(jumper, 0.2, jumper.x0, fwd(jumper.L0, jumper.off ? 1 : -1), 0.3); kf(jumper, 0.6, jumper.x0, jumper.L0, 1); }
        flag(0.3, `Flag: ${e.pen || 'penalty'}`);
        P.T = 0.9;
      } else if (e.evt === 'bad_snap') {
        const lx = bx + 9, lL = fwd(L0, -9);
        fly(0, 0.4, bx, L0, lx, lL, 0.05);
        rest(0.4, lx, lL);
        say(0.35, 'Bad snap!', 'hit', { x: lx, L: lL });
        const rec = e.turnover ? near(K.rush, lx, lL) : qb;
        if (rec) { kf(rec, 0.7, lx, lL + (rec.off ? 0 : dir * 0.5), 0, 'io'); hold(0.72, rec); used.add(rec); }
        if (rec === qb && qb) kf(qb, 1.3, lx + jit(10), endL(e.yards, false), 0, 'out');
        say(0.8, e.turnover ? `${defName} ball` : 'Recovered', e.turnover ? 'hit' : 'info', { slot: 1, follow: rec || qb });
        ambient(1.2, lx, lL);
        P.T = 1.5;
      } else if (e.kind === SPIKE) {
        snapToQb();
        if (qb) {
          fly(0.45, 0.58, qb.x0 + 4, qb.L0, qb.x0 + 4, fwd(qb.L0, 1.3), 0.05);
          rest(0.58, qb.x0 + 4, fwd(qb.L0, 1.3));
          say(0.5, 'Spike', 'info', { follow: qb });
        }
        P.T = 0.95;
      } else if (e.kind === KNEEL) {
        snapToQb();
        if (qb) { kf(qb, 0.55, qb.x0, fwd(qb.L0, -1), 0, 'out'); down(0.55, qb); say(0.55, 'Kneel', 'info', { follow: qb }); }
        P.T = 0.95;
      } else if (e.penalty) {                                    // a flag during the play: it is called back
        snapToQb();
        if (qb) { kf(qb, 0.7, qb.x0, fwd(L0, -6.5), 0, 'io'); used.add(qb); }
        ambient(1.0, bx, fwd(L0, 3));
        flag(0.85, `Flag: ${e.pen || 'penalty'}`);
        P.T = 1.45;
      } else if (['sack', 'strip_sack', 'sack_fumble'].includes(e.evt)) sack();
      else if (e.evt === 'scramble') scramble();
      else {
        const thrown = e.air !== undefined || e.incomplete || ['interception', 'pick_six', 'drop', 'near_pick', 'throwaway'].includes(e.evt);
        if (e.kind === PASS && (thrown || !['rpo_strong', 'rpo_weak', 'trick'].includes(id))) pass(c, id, sign);
        else run(c, id, sign);
      }
    } else if (e.ev === 'fg' || (e.ev === 'pat' && !two)) {
      const hL = fwd(L0, -7), Ly = dir > 0 ? 110 : -10;
      fly(0, 0.3, bx, L0, bx, hL, 0.1);
      rest(0.3, bx, hL);
      const good = e.ev === 'fg' ? e.made : e.good;
      const miss = good ? 0 : (R() < 0.5 ? -1 : 1);
      const t1 = 0.6 + 0.35 + Math.abs(Ly - hL) * 0.011;
      fly(0.6, t1, bx, hL, 180 + miss * 34, Ly, 2.4);
      rest(t1, 180 + miss * 38, Ly + dir * 1.5);
      K.rush.forEach((a) => kf(a, 0.65, a.x0, fwd(L0, 0.2), 0));
      K.ol.forEach((a) => kf(a, 0.65, a.x0, fwd(L0, -0.6), 0));
      say(t1, good ? "It's good!" : 'No good', good ? 'good' : 'hit', { x: 180, L: Ly - dir * 6 });
      P.T = t1 + 0.35;
    } else if (e.ev === 'punt') {
      const pL = fwd(L0, -14);
      fly(0, 0.35, bx, L0, bx, pL, 0.1);
      rest(0.35, bx, pL);
      const Lnew = clip(losOf(res.root), -9, 109);
      if (e.blocked) {
        fly(0.6, 0.95, bx, pL, bx + jit(20), fwd(pL, -4), 0.2);
        rest(0.95, bx + jit(20), fwd(pL, -4));
        say(0.7, 'Blocked!', 'hit', { x: bx, L: pL });
        P.T = 1.4;
      } else {
        const land = e.touchback ? (dir > 0 ? 104 : -4) : e.retTd ? fwd(pL, 52) : Lnew + dir * 6;
        const lx = clampX(bx + jit(40));
        fly(0.6, 1.75, bx, pL, lx, land, 2.8);
        let t = 1.75;
        if (!e.touchback) {
          const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew;
          const t2 = t + 0.2 + Math.abs(land - Lr) * 0.03;
          fly(t, t2, lx, land, clampX(lx + jit(30)), Lr, 0.05);
          t = t2;
        }
        say(t, e.retTd ? 'Punt return touchdown!' : e.touchback ? 'Touchback' : `Punt · net ${Math.round(e.net || 0)}`, e.retTd ? 'hit' : 'info',
          { x: 180, L: e.retTd ? (dir > 0 ? 4 : 96) : Lnew });
        P.T = t + 0.4;
      }
    } else if (e.ev === 'kickoff') {
      const Lnew = clip(losOf(res.root), -9, 109);
      if (e.onside) {
        const lx = clampX(bx + jit(30)), lL = fwd(L0, 11);
        fly(0.3, 0.95, bx, L0, lx, lL, 0.25);
        rest(0.95, lx, lL);
        say(0.95, e.recovered ? 'Onside kick recovered!' : 'Onside kick: they recover', e.recovered === (e.team === G.me) ? 'good' : 'hit', { x: lx, L: lL });
        P.T = 1.4;
      } else {
        const land = dir > 0 ? 97 : 3, lx = clampX(180 + jit(40));
        fly(0.3, 1.55, bx, L0, lx, land, 3);
        const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew;
        const t2 = 1.55 + 0.25 + Math.abs(land - Lr) * 0.025;
        fly(1.55, t2, lx, land, clampX(lx + jit(40)), Lr, 0.05);
        rest(t2, clampX(lx + jit(40)), Lr);
        say(t2, e.retTd ? 'Kick return touchdown!' : `${teamName(code(res.root.pos))} ball at ${spotText(res.root)}`,
          e.retTd ? (e.team === G.me ? 'hit' : 'good') : 'info', { x: 180, L: Lr });
        P.T = t2 + 0.4;
      }
    } else return null;

    // the camera: everything that moves, with room around it
    const Ls = [L0];
    sc.actors.forEach((a) => (a.kf || []).forEach((k) => Ls.push(k[2])));
    P.segs.forEach((s) => { if (s.kind === 'fly') Ls.push(s.L0, s.L1); else if (s.kind === 'rest') Ls.push(s.L); });
    let lo = Math.min(...Ls) - 5, hi = Math.max(...Ls) + 5;
    const span = clip(hi - lo, 36, 120), mid = (lo + hi) / 2;
    lo = mid - span / 2; hi = mid + span / 2;
    if (lo < -10) { hi += -10 - lo; lo = -10; }
    if (hi > 110) { lo -= hi - 110; hi = 110; }
    P.cam = { lo: Math.max(lo, -10), hi: Math.min(hi, 110) };
    P.segs.sort((a, b) => a.t0 - b.t0);
    return P;
  }

  function runPlan(sc, P, speed) {
    const ZI = 0.45, ZO = 0.4, total = ZI + P.T + P.hold + ZO;
    return new Promise((resolve) => {
      let start = null, skip = false;
      const onTap = () => { skip = true; };
      sc.svg.classList.add('playing');
      sc.svg.addEventListener('click', onTap);
      const frame = (now) => {
        if (start === null) start = now;
        const t = skip ? total : ((now - start) / 1000) * speed;
        const k = EASE.io(clip(t / ZI, 0, 1)) * (1 - EASE.io(clip((t - ZI - P.T - P.hold) / ZO, 0, 1)));
        sc.cam = { lo: lerp(FULL.lo, P.cam.lo, k), hi: lerp(FULL.hi, P.cam.hi, k) };
        const tp = clip(t - ZI, 0, P.T);
        sc.actors.forEach((a) => { const p = at(a, tp); a.x = p.x; a.L = p.L; a.w = p.w; });
        Object.assign(sc.ball, ballAt(sc, P, tp));
        P.calls.forEach((c) => { if (!c.shown && tp >= c.t) { c.shown = true; showCall(sc, c); } });
        P.fx.forEach((f) => { if (!f.done && tp >= f.t) { f.done = true; f.f(); } });
        place(sc);
        if (t >= total) {
          sc.svg.removeEventListener('click', onTap);
          sc.svg.classList.remove('playing');
          resolve();
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  // play one snap on the field: `before` is the state it was snapped from, `side` its strong side
  async function animatePlay(before, res, side, replay) {
    if (reduced() || (G.fast && !replay) || $('play').hidden) return false;
    const e = res.log.find((x) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(x.ev));
    if (!e) return false;
    const two = e.ev === 'pat' && e.two;
    let sc, P = null;
    try {
      if (two) {           // a two-point try is a snap from the 2: a pass that scores or does not
        sc = makeScene({ ...before, phase: SNAP, yl: 2, ytg: 2, down: 1 }, side);
        const q = { ev: 'play', team: e.team, kind: PASS, call: idx.calls.findIndex((c) => c.id === 'quick_strong'), yards: e.good ? 4 : 0,
          air: 4, incomplete: !e.good, td: e.good, row: -1, t: before.t };
        P = choreograph(sc, q, res, true);
      } else {
        sc = makeScene(before, side);
        P = choreograph(sc, e, res, false);
      }
    } catch (err) { console.warn('animation skipped:', err); P = null; }
    scene = sc;
    if (!P) return false;
    await runPlan(sc, P, PLAY_SPEED * (e.team === G.me ? 1 : 1.25));
    fadeNext = true;
    lastBall = null;
    return true;
  }

  // the in-depth view: the 22 up close with every rating, and every player listed
  function drawZoom(svg) {
    const r = G.root;
    svg.textContent = '';
    const FH = 336, PPY = 12.2, LOS_Y = 212, PR = 11.5;
    const offI = offenseOf(r);
    const s = r.phase === SNAP ? G.side : 1;
    const bx = r.phase === SNAP ? (s > 0 ? HASH_L : HASH_R) : 180;
    svg.append(S('rect', { x: 0, y: 0, width: 360, height: FH, fill: 'var(--turf)' }));
    const own = r.phase === KICKOFF ? 25 : r.phase === PAT ? 85 : 100 - r.yl;
    for (let L = 0; L <= 100; L += 5) {
      const y = LOS_Y - (L - own) * PPY;
      if (y < -2 || y > FH + 2) continue;
      svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chalk)', 'stroke-width': L % 50 === 0 ? 2.4 : 1.2 }));
      if (L % 10 === 0 && L > 0 && L < 100 && y > 12 && y < FH - 12) {
        const n = String(L <= 50 ? L : 100 - L);
        svg.append(S('text', { x: SX0 + 50, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(-90 ${SX0 + 50} ${y})` }, n));
        svg.append(S('text', { x: SX1 - 50, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(90 ${SX1 - 50} ${y})` }, n));
      }
    }
    svg.append(S('line', { x1: SX0, y1: LOS_Y, x2: SX1, y2: LOS_Y, stroke: 'var(--los)', 'stroke-width': 3 }));
    if (r.phase === SNAP && r.ytg < r.yl - 0.01) {
      const y = LOS_Y - r.ytg * PPY;
      if (y > 4) svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chain)', 'stroke-width': 3 }));
    }
    const f = formation(lineup(offI).off.slice(), lineup(1 - offI).def.slice(), s, bx);
    const put = (o, isOff, team, mine) => {
      const y = isOff ? LOS_Y + o.d * PPY : LOS_Y - o.d * PPY;
      const g = S('g', { class: `pl${mine ? ' me' : ''}`, transform: `translate(${o.x.toFixed(1)},${y.toFixed(1)})`, tabindex: 0, role: 'button',
        'aria-label': `${teamName(team)} ${POS_NAME[o.label] || o.label} ${o.p.name}, rated ${o.p.ovr}` });
      g.append(S('circle', { r: PR, fill: rate(o.p.ovr) }),
        S('text', { class: 'n', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', style: 'paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px' }, String(o.p.ovr)),
        S('text', { class: 'pos', 'text-anchor': 'middle', y: isOff ? PR + 9 : -PR - 4 }, o.label));
      const open = () => playerInfo(o.p, o.label, team);
      g.addEventListener('click', open);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      svg.append(g);
    };
    f.def.forEach((o) => put(o, false, code(1 - offI), 1 - offI === G.me));
    f.off.forEach((o) => put(o, true, code(offI), offI === G.me));
  }
  const offenseOf = (r) => (r.phase === KICKOFF ? 1 - r.pos : r.pos);     // at a kickoff, the team about to get the ball
  function openDeep() {
    const r = G.root, offI = offenseOf(r);
    $('deepNote').textContent = `${teamName(code(offI))} ball${r.phase === KICKOFF ? ' after the kickoff' : ''}. Every player's overall rating, 40 to 99 (a typical starter is 77), and his type. Tap anyone for more.`;
    drawZoom($('zoom'));
    const u = $('units');
    u.textContent = '';
    const unit = (title, list, team) => {
      const d = el('div', 'unit');
      d.append(el('h3', '', title));
      const ul = el('ul');
      list.forEach((p) => {
        const li = el('li'), b = el('button');
        b.type = 'button';
        const ch = el('span', 'chipn', String(p.ovr)); ch.style.background = rate(p.ovr);
        const nm = el('span', 'nm', p.name);
        if (p.kind) nm.append(el('small', '', p.kind));
        b.append(ch, el('span', 'ps', p.pos), nm);
        b.addEventListener('click', () => playerInfo(p, p.pos, team));
        li.append(b); ul.append(li);
      });
      d.append(ul);
      return d;
    };
    const t = (i) => teamOf(i);
    const spec = (i) => [{ ...t(i).kicker, pos: 'K', ovr: t(i).kicker.ovr ?? 77, stat: 'Rated on field goals made over expected' },
      { ...t(i).punter, pos: 'P', ovr: t(i).punter.ovr ?? 77, stat: 'Rated on net punting over expected' }];
    u.append(unit(`${teamName(code(offI))} offense`, lineup(offI).off, code(offI)),
      unit(`${teamName(code(1 - offI))} defense`, lineup(1 - offI).def, code(1 - offI)),
      unit('Kickers and punters', [...spec(G.me).map((p) => ({ ...p, name: `${p.name} (${code(G.me)})` })),
        ...spec(1 - G.me).map((p) => ({ ...p, name: `${p.name} (${code(1 - G.me)})` }))], null));
    lastFocus = document.activeElement;
    $('deep').hidden = false;
    $('deepClose').focus();
  }
  function closeDeep() { $('deep').hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }

  // ------------------------------------------------------------ chrome ---
  function drawTiles() {
    const t = $('tiles');
    t.textContent = '';
    for (let i = 0; i < 3; i++) {
      const s = state.spots[i];
      const b = el('span', '', String(i + 1));
      if (s && s.over) { b.className = `done sq ${spotMark(s)}`; b.title = `Spot ${i + 1}: done`; }
      else if (G && G.si === i && !state.done) { b.className = 'on'; b.title = `Spot ${i + 1}: playing`; }
      t.append(b);
    }
  }
  function spotMark(s) {
    const w = (s.decisions || []).reduce((a, x) => a + x.wpa, 0);
    return w >= 0.01 ? 'g' : w >= -0.01 ? 'y' : w >= -0.04 ? 'o' : 'r';
  }
  function drawBar() {
    const r = G.root, b = $('bar');
    b.textContent = '';
    const side = (i, right) => {
      const c = code(i), d = el('span', `tm${right ? ' r' : ''}`);
      const sw = el('span', 'tsw'); sw.style.background = color(c);
      const meta = el('span');
      const tos = el('span', 'tos');
      for (let k = 0; k < 3; k++) tos.append(el('i', k < r.to[i] ? '' : 'used'));
      const ab = el('span', 'ab', c);
      if (i === G.me) ab.append(el('small', '', 'YOU'));
      meta.append(ab, tos);
      d.append(sw, meta);
      if (r.pos === i && r.phase !== DONE) d.append(el('span', 'poss'));
      d.append(el('span', 'sc', String(r.score[i])));
      return d;
    };
    const ck = clockOf(r.t), over = r.phase === DONE;
    const mid = el('span', 'mid');
    mid.append(el('span', 'q', over ? (r.t >= 1800 ? 'HALF' : 'FINAL') : `Q${ck.q}`),
      el('span', `clk${r.clock_running && !over ? ' run' : ''}`, over ? '0:00' : ck.text));
    b.append(side(1, false), mid, side(0, true));
    b.setAttribute('aria-label', `${code(1)} ${r.score[1]}, ${code(0)} ${r.score[0]}, ${ck.text} left in the ${ordinal(ck.q)} quarter. Game details`);
    const dd = $('dd');
    dd.textContent = '';
    if (r.phase === SNAP) dd.append(el('b', '', ddText(r)), document.createTextNode(` · ball ${onSpot(r)} · clock ${r.clock_running ? 'running' : 'stopped'}`));
    else dd.textContent = r.phase === PAT ? 'Try after the touchdown' : r.phase === KICKOFF ? 'Kickoff' : r.t >= 1800 ? 'Halftime' : 'Final';
  }
  function drawAll() { drawTiles(); drawBar(); drawField(); }
  function show(which) {
    $('intro').hidden = which !== 'intro';
    $('play').hidden = which !== 'play';
    $('done').hidden = which !== 'done';
    $('boot').hidden = which !== 'boot';
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
  function status(text, line, skip) {
    const d = $('dock');
    d.textContent = '';
    const s = el('div', 'status');
    s.append(el('span', 'spin'), el('span', '', text));
    d.append(s);
    if (line) d.append(el('div', 'feedline', line));
    if (skip) {
      const c = el('button', 'chip', 'Skip ahead');
      c.type = 'button';
      c.addEventListener('click', () => { G.fast = true; c.disabled = true; });
      d.append(c);
    }
  }
  function fatal(msg) {
    show('play');
    const d = $('dock');
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
    if (k.box) bits.push(`${k.box} in the box`);
    if (k.blitz) bits.push('blitz');
    return ` (${bits.join(', ')})`;
  }
  function playLine(e, act) {
    const mine = e.team === G.me, nm = names(e.team);
    const who = teamName(code(e.team));
    if (e.kind === SPIKE) return `${who} spike it, clock stopped`;
    if (e.kind === KNEEL) return `${who} kneel, clock ${e.running ? 'running' : 'stopped'}`;
    let what;
    if (e.call >= 0) {
      const c = idx.calls[e.call];
      const actor = c.id.startsWith('rb_') ? nm.rb : nm.qb;
      what = `${c.id === 'trick' ? `The ${who} run a trick play` : `${actor || `The ${who}`} ${c.say}`}${mine ? lookText(e.look) : ''}`;
    } else what = `${nm.qb || who} ${e.kind === RUN ? 'hands off' : 'drops back'}`;
    const y = Math.round(e.yards);
    const gain = y > 0 ? `${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `loss of ${-y}` : 'no gain';
    let res;
    if (e.penalty) res = `flag, ${e.pen || 'penalty'}: ${y >= 0 ? `+${y}` : y} yards`;
    else {
      res = { bad_snap: e.turnover ? 'bad snap, the defense recovers' : `bad snap, the offense falls on it: ${gain}`,
        strip_sack: e.tdDef ? 'strip-sack, returned for a touchdown' : 'strip-sack, fumble lost',
        sack_fumble: `sacked and fumbles, but the offense recovers: ${gain}`, sack: `sacked, ${gain}`,
        pick_six: 'intercepted and returned for a touchdown', interception: 'intercepted',
        scoop_score: 'fumble, scooped and returned for a touchdown', fumble_lost: 'fumble, lost',
        fumble_kept: `fumbles, but the offense recovers: ${gain}`,
        scramble: e.td ? `scrambles ${y} yards for a touchdown` : `pressure, scrambles: ${gain}`,
        throwaway: 'pressure, throws it away', drop: 'dropped, incomplete', near_pick: 'nearly intercepted, incomplete' }[e.evt];
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
        case 'timeout': text = `Timeout, ${teamName(code(e.team))}${e.why === 'kick' ? ' (to set up the kick)' : ''}`; break;
        case 'runoff':
          if (e.stop === '2mw') text = 'Two-minute warning';
          else if (e.stop === 'quarter') text = 'End of the quarter';
          else if (e.secs >= 3 && !e.kneel && !e.spike) text = `Clock runs ${Math.round(e.secs)} seconds`;
          break;
        case 'play': text = playLine(e, act); break;
        case 'fg': text = `${shortName(teamOf(e.team).kicker.name) || teamName(code(e.team))} ${Math.round(e.dist)}-yard field goal: ${e.made ? 'good' : 'no good'}`; t = null; break;
        case 'punt': text = e.blocked ? `${teamName(code(e.team))} punt blocked` : e.retTd ? `${teamName(code(e.team))} punt returned for a touchdown` :
          `${teamName(code(e.team))} punt${e.touchback ? ', touchback' : `, net ${Math.round(e.net)} yards`}`; t = null; break;
        case 'pat': text = e.two ? `Two-point try ${e.good ? 'good' : 'fails'}` : `Extra point ${e.good ? 'good' : 'no good'}`; break;
        case 'kickoff': text = e.onside ? `Onside kick, recovered by the ${teamName(code(e.recovered ? e.team : 1 - e.team))}` :
          e.retTd ? 'Kickoff returned for a touchdown' : `Kickoff, ${teamName(code(1 - e.team))} start at their own ${Math.round(100 - e.yl)}`; break;
        case 'end': text = (e.t ?? G.root.t) >= 1800 ? 'Halftime' : 'End of regulation'; break;
        default: break;
      }
      if (text) out.push([text, t, e.team === G.me]);
    }
    return out;
  }
  function headline(e, log) {
    if (!e) return (log || []).some((x) => x.ev === 'end') ? 'Time ran out' : 'Timeout';
    if (e.ev === 'fg') return e.made ? `${Math.round(e.dist)}-yard field goal is good` : 'Field goal: no good';
    if (e.ev === 'punt') return e.retTd ? 'Punt return touchdown' : e.blocked ? 'Punt blocked' : `Punt, net ${Math.round(e.net || 0)}`;
    if (e.ev === 'pat') return e.two ? (e.good ? 'Two-point try good' : 'Two-point try fails') : (e.good ? 'Extra point good' : 'Extra point missed');
    if (e.ev === 'kickoff') return e.onside ? (e.recovered ? 'Onside kick recovered' : 'Onside kick: they recover') : e.retTd ? 'Returned for a touchdown' : 'Kickoff';
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
    return { si: i, scen: sc, me: sc.player === sc.home ? 0 : 1, root: startRoot(sc), decisions: [], log: [],
      seq: 0, snapN: 0, over: false, result: null, side: 1, fast: false, started: false };
  }
  function persist() {
    state.spots[G.si] = { root: G.root, decisions: G.decisions, log: G.log, seq: G.seq, snapN: G.snapN, over: G.over,
      result: G.result, started: G.started };
    save(`${STORE}:day:${dayN}`, state);
  }
  function resumeSpot(i) {
    G = newSpot(i);
    const s = state.spots[i];
    if (s) Object.assign(G, { root: s.root, decisions: s.decisions || [], log: s.log || [], seq: s.seq || 0, snapN: s.snapN || 0,
      over: s.over, result: s.result, started: !!s.started });
    G.side = sideFor(G.seq);
    return G;
  }
  function openSpot(i) {
    resumeSpot(i);
    lastBall = null;
    if (G.started || G.over) return enterField();
    renderIntro();
  }
  function renderIntro() {
    const sc = G.scen, r = G.root, box = $('intro');
    box.textContent = '';
    show('intro');
    drawTiles();
    const me = code(G.me), op = code(1 - G.me);
    const lead = r.score[G.me] - r.score[1 - G.me], ck = clockOf(r.t);
    const left = r.t > 1800 ? `${ck.text} left in the half` : `${ck.text} left in the game`;
    const state_ = lead > 0 ? `Up by ${lead}` : lead < 0 ? `Down by ${-lead}` : 'Tied';
    const big = el('div', 'big', state_);
    big.append(el('span', 'left', left));
    box.append(el('div', 'cat', `Spot ${G.si + 1} of 3 · ${idx.categories[sc.category]}`), big);
    const mu = el('div', 'matchup');
    const t = (c, i) => {
      const d = el('div', 't');
      const sw = el('span', 'sw', c); sw.style.background = color(c);
      d.append(sw, el('span', 'nm', teamName(c)));
      if (i === G.me) d.append(el('span', 'you', 'YOU'));
      return d;
    };
    mu.append(t(code(1), 1), el('div', 'sc', `${r.score[1]}–${r.score[0]}`), t(code(0), 0));
    box.append(mu);
    const facts = el('div', 'chips');
    const tos = (n) => (n ? `${n} timeout${n === 1 ? '' : 's'}` : 'no timeouts');
    [`${r.pos === G.me ? 'Your' : `${teamName(op)}`} ball, ${ddText(r)} ${onSpot(r)}`, `You: ${tos(r.to[G.me])}`,
      `${teamName(op)}: ${tos(r.to[1 - G.me])}`].forEach((f) => facts.append(el('span', '', f)));
    box.append(facts);
    const coach = teamOf(G.me).coach;
    box.append(el('div', 'who', `You're calling it for the ${teamName(me)}${coach ? ` (${coach})` : ''}.`));
    const go = el('button', 'btn', 'Next');
    go.type = 'button';
    go.addEventListener('click', () => { G.started = true; persist(); enterField(); });
    box.append(go);
    const rl = sc.real || {};
    box.append(el('div', 'from', `A real situation from ${rl.season} week ${rl.week} (${teamName(sc.away)} at ${teamName(sc.home)}), played with today's rosters.`));
    go.focus({ preventScroll: true });
  }
  function enterField() {
    show('play');
    restoreLog();
    if (!G.log.length) addLog(`${teamName(code(G.root.pos))} ball, ${ddText(G.root)} ${onSpot(G.root)}`, G.root.t, G.root.pos === G.me);
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
      const label = r.phase === KICKOFF ? (r.pos === G.me ? 'You kick off' : `The ${teamName(code(r.pos))} kick off`) :
        r.phase === PAT ? `The ${teamName(code(r.pos))} try the extra point` : `The ${teamName(code(r.pos))} have the ball`;
      const last = G.log.length ? G.log[G.log.length - 1][0] : '';
      status(label, last, !G.fast);
      const res = await stepWith(action);
      await sleep(G.fast ? 60 : res.animated ? 300 : 1000);
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
    const before = G.root, side = G.side;
    const res = (await send({ type: 'step', scen: simScen(), root: G.root, action, seed })).res;
    res.action = action;
    narrate(res.log, action).forEach(([text, t, mine]) => addLog(text, t, mine));
    G.root = res.root;
    if (res.done) G.root.phase = DONE;
    persist();
    G.lastPlay = { before, res, side };
    res.animated = await animatePlay(before, res, side, false);
    return res;
  }
  async function replay() {
    const lp = G.lastPlay;
    if (busy || !lp) return;
    busy = true;
    try { await animatePlay(lp.before, lp.res, lp.side, true); } finally { busy = false; drawField(); }
  }

  // your ball: Run / Pass / RPO, plus a timeout, spike, kneel or kick when it matters
  async function promptOffense() {
    const r = G.root;
    status('Breaking the huddle…');
    G.info = (await send({ type: 'info', scen: simScen(), root: r })).info;
    G.fast = false;
    ui = { step: 'family', fam: null, oob: false };
    drawDock();
  }
  // kneel: ahead late, or ending the first half; timeout and spike: when you need the time
  function canKneel(r) {
    const lead = r.score[G.me] - r.score[1 - G.me], th = halfLeft(r.t);
    if (r.down > 3) return false;
    if (r.t > 1800) return lead >= 0 && th <= 120;
    // about 40 seconds a kneel, one fewer kneel's worth per timeout they have left
    const kneels = 5 - r.down - r.to[1 - G.me] - (r.clock_running ? 0 : 1);
    return lead > 0 && th <= 40 * Math.max(kneels, 0) + 30;
  }
  function clockOptions(r) {      // with the clock running
    const me = G.me, lead = r.score[me] - r.score[1 - me];
    const needTime = r.t > 1800 || lead <= 0;
    const keys = ['play'];
    if (r.to[me] > 0 && needTime) keys.push('timeout');
    if (r.down <= 3 && needTime && halfLeft(r.t) <= 180) keys.push('spike');
    if (canKneel(r)) keys.push('kneel');
    return keys;
  }
  function callOptions(r) {
    const th = halfLeft(r.t);
    const calls = idx.calls.map((c) => c.id).filter((id) => {
      if (id === 'qb_sneak' && r.ytg > 3) return false;
      if (id === 'hail_mary' && !(th <= 30 && r.yl >= 30)) return false;
      return true;
    });
    const specials = [];
    if (G.info.pFg >= 0.05 && (r.down === 4 || th <= 40)) specials.push('fg');
    if (r.down === 4 && r.yl >= 30) specials.push('punt');
    if (!r.clock_running && canKneel(r)) specials.push('kneel');
    return { calls, specials };
  }
  const specialLabel = (k) => (k === 'fg' ? 'Field goal' : k === 'punt' ? 'Punt' : 'Kneel');

  function drawDock() {
    const r = G.root, d = $('dock'), me = G.me;
    d.textContent = '';
    const head = el('div', 'ask');
    d.append(head);
    if (ui.step === 'family') {
      head.append(el('h2', '', 'Your call'), el('span', 'sub', `${ddText(r)} · ${spotText(r)}`));
      const fam = el('div', 'keys');
      fam.style.setProperty('--cols', 3);
      Object.entries(FAM).forEach(([f, label], i) => {
        const b = key(label, null, 'big', i);
        b.addEventListener('click', () => { if (busy) return; ui.fam = f; ui.step = 'detail'; drawDock(); });
        fam.append(b);
      });
      d.append(fam);
      const extra = [];
      if (r.clock_running) {
        clockOptions(r).filter((k) => k !== 'play').forEach((k) => extra.push([k, CLOCK[k].label, k === 'timeout' ? `${r.to[me]} left` : null]));
      }
      const { specials } = callOptions(r);
      specials.forEach((k) => extra.push([k, specialLabel(k), k === 'fg' ? `${Math.round(G.info.fgDist)} yards` : null]));
      if (extra.length) {
        const row = el('div', 'keys');
        row.style.setProperty('--cols', Math.min(extra.length, 4));
        extra.forEach(([k, label, sub], i) => {
          const b = key(label, sub, 'alt', 3 + i);
          b.addEventListener('click', () => {
            if (busy) return;
            if (k === 'timeout') decideTimeout();
            else if ((k === 'spike' || k === 'kneel') && r.clock_running) decideClock(k);
            else decideCall({ special: k });
          });
          row.append(b);
        });
        d.append(row);
      }
      return;
    }
    // the plays in the chosen family: one row per play, a key per side (arrows match the field)
    head.append(el('h2', '', FAM[ui.fam]));
    const back = el('button', 'chip', '◀ Back');
    back.type = 'button';
    back.addEventListener('click', () => { ui.step = 'family'; drawDock(); });
    head.append(back);
    const avail = callOptions(r).calls;
    const dir = r.pos === G.me ? 1 : -1;
    const s = G.side * dir;                       // strong side on screen: +1 right, -1 left
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
    let i = 0;
    rows.forEach((row) => {
      const pr = el('div', 'prow pop');
      pr.style.setProperty('--i', i++);
      pr.append(el('div', 'lab', row.base));
      const sides = el('div', 'sides');
      row.calls.slice().sort((a, b) => order(a) - order(b)).forEach((c) => {
        const b = key(sideText(c));
        b.setAttribute('aria-label', c.label);
        b.addEventListener('click', () => { if (!busy) decideCall({ call: c.id }); });
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
    requestAnimationFrame(() => tg.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
  }

  function situation(r) { return `${clockOf(r.t).text} Q${clockOf(r.t).q}, ${ddText(r)} ${onSpot(r)}`; }
  async function clockDecision(r, chosen) {
    const me = G.me, lead = r.score[me] - r.score[1 - me];
    const opts = clockOptions(r).map((k) => ({ key: k, label: CLOCK[k].label, action: CLOCK[k].act }));
    status('Simulating every clock option 600 times…');
    const vals = await evaluate(r, opts, hash('clock', dayN, G.si, G.seq));
    let q = coachProbs('off_clock_stop', r, me);
    if (lead > 0 && r.t <= 1800) q = { play: 0.9, timeout: 0.03, kneel: 0.07 };
    else if (q) q = { play: (q.hurry || 0) + (q.normal || 0) + (q.milk || 0) + (q.huddle || 0) + (q.rundown || 0), timeout: q.timeout || 0, spike: q.spike || 0 };
    else q = { play: 0.8, timeout: 0.14, spike: 0.06 };
    return decisionFrom('clock', 'off_clock_stop', opts, vals, chosen, q, situation(r));
  }
  async function decideTimeout() {
    if (busy) return;
    busy = true;
    const r = G.root;
    try {
      const x = await clockDecision(r, 'timeout');
      G.decisions.push(x);
      G.snapN += 1;
      const halfEnd = r.t > 1800 ? 1800 : 0;
      G.root = { ...r, to: r.to.slice(), clock_running: false, t: Math.max(halfEnd, r.t - 1) };
      G.root.to[G.me] -= 1;
      addLog(`Timeout, ${teamName(code(G.me))}`, G.root.t, true);
      persist();
      showResult([x], { log: [], action: { to_off: true } }, 'Timeout');
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }
  async function decideClock(k) {
    if (busy) return;
    busy = true;
    const r = G.root;
    try {
      const x = await clockDecision(r, k);
      G.decisions.push(x);
      G.snapN += 1;
      status('Snap…', reduced() ? null : 'Tap the field to skip');
      const res = await stepWith(CLOCK[k].act);
      showResult([x], res);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }
  function callAction(id, oob) { return { to_off: false, play: CALL[id].kind, call: id, oob: !!oob }; }
  async function decideCall(pick) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    try {
      const decisions = [];
      if (r.clock_running) decisions.push(await clockDecision(r, 'play'));
      const { calls, specials } = callOptions(r);
      const opts = calls.map((id) => ({ key: id, label: CALL[id].label, action: callAction(id, false) }));
      if (pick.call && ui.oob) opts.push({ key: `${pick.call}+oob`, label: `${CALL[pick.call].label}, get out of bounds`, action: callAction(pick.call, true) });
      specials.forEach((k) => opts.push({ key: k, label: specialLabel(k), action: { to_off: false, play: k } }));
      status(`Simulating all ${opts.length} calls 600 times each…`);
      const vals = await evaluate(r, opts, hash('call', dayN, G.si, G.seq));
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
      decisions.push(decisionFrom('call', r.down === 4 ? 'fourth_down' : 'play_select', opts, vals, chosen, q, situation(r)));
      decisions.forEach((x) => G.decisions.push(x));
      G.snapN += 1;
      status('Snap…', reduced() ? null : 'Tap the field to skip');
      const res = await stepWith(opts.find((o) => o.key === chosen).action);
      showResult(decisions, res);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // their ball late, your touchdown, your kickoff
  function promptChoice(kind) {
    const r = G.root, me = G.me, d = $('dock');
    const spec = {
      deftime: { ask: 'Clock is running', sub: `${teamName(code(r.pos))} ball, ${ddText(r)}`, family: 'def_timeout',
        opts: [{ key: 'timeout', label: 'Timeout', sub: `${r.to[me]} left`, action: { to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false } }],
        q: () => coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 } },
      pat: { ask: 'Touchdown!', sub: 'Kick it or go for two?', family: 'pat',
        opts: [{ key: 'xp', label: 'Kick it', action: { pat: 'xp' } }, { key: 'two', label: 'Go for two', action: { pat: 'two' } }],
        q: () => coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 } },
      kick: { ask: 'Kickoff', sub: 'Deep or onside?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    d.textContent = '';
    const head = el('div', 'ask');
    head.append(el('h2', '', spec.ask), el('span', 'sub', spec.sub));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', 2);
    spec.opts.forEach((o, i) => {
      const b = key(o.label, o.sub || null, 'big', i);
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          status('Simulating both options 600 times…');
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
  const KIND_NAME = { clock: 'Clock', call: 'Play call', deftime: 'Timeout', pat: 'Try', kick: 'Kickoff' };
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
  function showResult(decisions, res, head) {
    drawAll();
    const d = $('dock');
    d.textContent = '';
    const cost = decisions.reduce((a, x) => a + x.cost, 0), m = markOf(cost);
    const main = res.log.find((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev));
    const lines = main ? narrate([main], res.action) : narrate(res.log, res.action).reverse();
    const wrap = el('div', 'result');
    const top = el('div', 'res-top');
    const sq = el('div', `sq ${m} flip`, GLYPH[m]);
    sq.setAttribute('aria-label', { g: 'Best call or close to it', y: 'A little worse than the best call', o: 'Costly', r: 'A big mistake' }[m]);
    const txt = el('div', 'res-play');
    txt.append(el('span', 'yd', head || headline(main, res.log)), document.createTextNode(lines.length ? lines[0][0] : `You stop the clock with ${clockOf(G.root.t).text} left.`));
    top.append(sq, txt);
    wrap.append(top);
    const v = el('div', 'verdict');
    decisions.forEach((x, i) => {
      if (i) v.append(el('br'));
      const what = decisions.length > 1 ? `${KIND_NAME[x.kind]}: ` : '';
      if (x.cost < 0.0005 || x.best === x.chosen) { v.append(document.createTextNode(what)); v.append(el('b', '', 'Best call.')); }
      else { v.append(document.createTextNode(`${what}${what ? 'best' : 'Best'} was `), el('b', '', x.bestLabel), document.createTextNode(` (${pts(x.cost)}% win chance).`)); }
    });
    wrap.append(v);
    const det = el('details', 'more');
    det.append(el('summary', '', 'How every option scored'));
    const inn = el('div', 'in');
    decisions.forEach((x) => inn.append(optionTable(x)));
    const wpa = decisions.reduce((a, x) => a + x.wpa, 0);
    inn.append(el('p', 'note', `Against a typical NFL play-caller here: ${pts(wpa)}% win chance. "NFL" is how often play-callers make that call in this spot.`));
    det.append(inn);
    wrap.append(det);
    const btn = el('button', 'btn', G.root.phase === DONE ? 'See how it ended' : 'Next play');
    btn.type = 'button';
    btn.addEventListener('click', () => { if (!busy) advance(); });
    if (G.lastPlay && res.animated) {
      const again = el('button', 'chip replay', '↻ Replay the play');
      again.type = 'button';
      again.addEventListener('click', replay);
      wrap.append(again);
    }
    wrap.append(btn);
    d.append(wrap);
  }

  // ------------------------------------------------- who you coached like ---
  function coachMatch(decs) {
    const C = idx.coaches;
    if (!C || !C.coaches || !C.coaches.length) return null;
    const acc = { pass: [0, 0], deep: [0, 0], go: [0, 0], two: [0, 0] };
    decs.forEach((x) => {
      if (x.kind === 'call') {
        let qPlay = 0, qPass = 0, qPassOnly = 0, qDeep = 0, qAll = 0;
        x.wps.forEach((w) => {
          const q = x.q[w.key] || 0;
          qAll += q;
          const c = CALL[w.key.replace('+oob', '')];
          if (!c || w.key.endsWith('+oob')) return;
          qPlay += q;
          qPass += q * (c.family === 'pass' ? 1 : c.family === 'rpo' ? 0.5 : 0);
          if (c.family === 'pass') { qPassOnly += q; if (DEEP.has(c.id)) qDeep += q; }
        });
        const c = CALL[String(x.chosen).replace('+oob', '')];
        if (c && qPlay > 0) {
          acc.pass[0] += (c.family === 'pass' ? 1 : c.family === 'rpo' ? 0.5 : 0) - qPass / qPlay; acc.pass[1] += 1;
          if (c.family === 'pass' && qPassOnly > 0) { acc.deep[0] += (DEEP.has(c.id) ? 1 : 0) - qDeep / qPassOnly; acc.deep[1] += 1; }
        }
        if (x.family === 'fourth_down' && qAll > 0) { acc.go[0] += (c ? 1 : 0) - qPlay / qAll; acc.go[1] += 1; }
      } else if (x.kind === 'pat') { acc.two[0] += (x.chosen === 'two' ? 1 : 0) - (x.q.two || 0); acc.two[1] += 1; }
    });
    const zu = {}, w = {};
    Object.keys(acc).forEach((k) => {
      const [sum, n] = acc[k];
      zu[k] = n ? (sum / (n + 1)) / (C.spread[k] || 1) : 0;
      w[k] = n ? n / (n + 1) : 0;
    });
    if (!Object.values(w).some((v) => v > 0)) return null;
    let best = null, bd = Infinity;
    C.coaches.forEach((c) => {
      let dist = 0;
      Object.keys(w).forEach((k) => { if (w[k]) dist += w[k] * (zu[k] - (c.z[k] || 0)) ** 2; });
      if (dist < bd) { bd = dist; best = c; }
    });
    const why = Object.keys(w).filter((k) => w[k] && Math.abs(zu[k]) >= 0.35 && Math.sign(zu[k]) === Math.sign(best.z[k] || 0))
      .sort((a, b) => w[b] * Math.abs(zu[b]) - w[a] * Math.abs(zu[a])).slice(0, 2).map((k) => WHY[k][zu[k] > 0 ? 0 : 1]);
    return { coach: best, why };
  }
  function coachCard(decs, label) {
    const m = coachMatch(decs);
    if (!m) return null;
    const c = m.coach, box = el('div', 'coach');
    box.append(el('div', 'k', label), el('div', 'name', c.name));
    const reason = m.why.length ? `Like him, you ${m.why.join(' and ')}.` : 'Your calls sit close to his across the board.';
    box.append(el('div', 'why', reason));
    const teams = (c.teams || []).map(teamName).join(', ');
    box.append(el('div', 'meta', `${teams} · ${c.from === c.to ? c.from : `${c.from}–${c.to}`} · from ${c.plays.toLocaleString()} late-game snaps`));
    box.title = 'Matched on how often you throw, go deep, go for it on fourth down and go for two, each against what NFL play-callers do in the same spots.';
    return { el: box, name: c.name };
  }

  async function finishSpot() {
    if (!G.result) {
      status('Final whistle…');
      const r = G.root;
      const v = await evaluate(r, [{ key: 'end', action: {} }], 1);
      G.result = { wp: v.end, mine: r.score[G.me], theirs: r.score[1 - G.me], half: r.t >= 1800 ? 1 : 2 };
      G.over = true;
      persist();
    }
    drawAll();
    const res = G.result, sc = G.scen, d = $('dock');
    d.textContent = '';
    const card = el('div', 'endcard');
    const head = res.half === 1 ? `Halftime: ${res.mine}–${res.theirs}` :
      res.mine > res.theirs ? `You win ${res.mine}–${res.theirs}` : res.mine < res.theirs ? `You lose ${res.mine}–${res.theirs}` : `Tied ${res.mine}–${res.theirs}: overtime`;
    card.append(el('h2', '', head));
    if (res.half === 1 || res.mine === res.theirs) card.append(el('p', 'note', `Your win chance from here: ${wpTxt(res.wp)}.`));
    card.append(squaresOf(G.decisions));
    const wpa = G.decisions.reduce((a, x) => a + x.wpa, 0);
    card.append(el('p', 'verdict', `${pts(wpa)}% win chance against a typical NFL play-caller in this spot.`));
    const cc = coachCard(G.decisions, 'You called this one like');
    if (cc) card.append(cc.el);
    const rl = sc.real || {};
    const realCall = rl.call && CALL[rl.call] ? CALL[rl.call].label : 'a play';
    const fin = rl.final ? `final ${sc.away} ${rl.final.away}, ${sc.home} ${rl.final.home}` : '';
    const drive = !rl.drive ? '' : rl.drive === 'ran out the clock' ? 'they ran out the clock' : `the drive ended in a ${rl.drive}`;
    card.append(el('p', 'real', `In the real ${rl.season} game, ${rl.coach || 'the coach'} called "${realCall}" here; ${drive}${fin ? '; ' + fin : ''}.`));
    const btn = el('button', 'btn', G.si < 2 ? 'Next spot' : "Today's score");
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.current = G.si + 1;
      save(`${STORE}:day:${dayN}`, state);
      if (G.si < 2) openSpot(G.si + 1);
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
  function renderSummary() {
    if (!G) resumeSpot(2);
    show('done');
    const decs = allDecisions();
    const p = decs.length ? percentileVsNFL(decs) : 0;
    const wpa = decs.reduce((a, x) => a + x.wpa, 0);
    const st = load(`${STORE}:stats`, { days: {} });
    const cc = coachCard(decs, 'Today you coached like');
    st.days[dayN] = { p, wpa, coach: cc ? cc.name : null };
    save(`${STORE}:stats`, st);
    state.done = true;
    save(`${STORE}:day:${dayN}`, state);
    drawTiles();
    const box = $('done');
    box.textContent = '';
    box.append(el('div', 'note', `Day ${dayN} · your score`), el('div', 'big-pct', `${Math.round(p * 100)}`),
      el('div', 'pct-lab', `Better than ${Math.round(p * 100)}% of NFL play\u2011callers`));
    if (cc) box.append(cc.el);
    box.append(el('p', 'verdict', `${pts(wpa)}% win chance against a typical NFL play-caller across today's three spots.`));
    const rows = [0, 1, 2].map((i) => {
      const s = state.spots[i]; if (!s) return '';
      const r = s.result ? (s.result.half === 1 ? 'HT' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      return `${today[i].player} ${r} ${snapsOf(s.decisions || []).map((m) => SQ[m]).join('')}`;
    });
    const text = `Two-Minute Drill #${dayN}\nBetter than ${Math.round(p * 100)}% of NFL play-callers${cc ? `\nCoached like ${cc.name}` : ''}\n${rows.join('\n')}`;
    const pre = el('div', 'grid-share', text);
    box.append(pre);
    const btn = el('button', 'btn alt', 'Share');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
      catch (e) { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); toast('Selected: copy it'); }
    });
    box.append(btn, countdown());
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
    const ol = OL.includes(label) || label === 'T' || label === 'G';
    const top = el('div', 'pinfo');
    const ch = el('div', 'chip-big', String(p.ovr)); ch.style.background = rate(p.ovr);
    top.append(ch);
    const nm = el('div'), rk = rankOf(p, label);
    nm.append(el('div', 'nm', p.name), el('div', 'ps', `${team ? teamName(team) + ' · ' : ''}${POS_NAME[label] || label}`),
      el('div', 'ps', `${ordinal(rk.rank)} of ${rk.of} starting ${POS_PLURAL[rk.g] || 'players'}`));
    top.append(nm);
    const nodes = [top];
    if (p.kind) {
      const a = el('div', 'arch');
      a.append(el('span', 'tag', p.kind));
      nodes.push(a, el('p', 'lead', p.why));
    }
    const how = POS_METHOD[groupOf(label)];
    nodes.push(el('p', p.kind ? '' : 'lead', p.stat || ''),
      el('p', 'note', how ? `Our rating, 40 to 99: how he has played (${how}) over the last five seasons, the latest counting most, blended with how the league values him: his contract, Pro Bowls and All-Pros, draft slot and playing time. A typical starter is 77.`
        : 'Our rating, 40 to 99, from his kicking over the last seasons. A typical starter is 77.'));
    openModal(POS_NAME[label] || label, nodes);
  }
  function spotInfo() {
    const sc = G.scen, H = sc.game.home, A = sc.game.away;
    const dl = el('dl', 'facts');
    const add = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
    const line = sc.game.home_spread;
    add('Game', `${teamName(sc.away)} at ${teamName(sc.home)}`);
    add('Line today', Math.abs(line) < 0.5 ? 'Pick’em' : `${teamName(line > 0 ? sc.home : sc.away)} by ${Math.abs(line).toFixed(1)}`);
    [A, H].forEach((t) => {
      add(`${teamName(t.team)}`, `${t.coach || ''}${t.qb && t.qb.name ? ` · QB ${t.qb.name}` : ''}`);
      add('Kicker', `${t.kicker.name || '—'} · rated ${t.kicker.ovr ?? '—'}`);
      add('Punter', `${t.punter.name || '—'} · rated ${t.punter.ovr ?? '—'}`);
    });
    openModal('This game', [dl, el('p', 'note', `Today's rosters with everyone healthy, and our player ratings through ${idx.asof.season} week ${idx.asof.through_week}. The situation is from a real ${sc.real.season} game.`)]);
  }
  function openHelp() {
    const ex = el('div', 'ex');
    ['g', 'y', 'o', 'r'].forEach((m) => ex.append(el('span', `sq ${m}`, GLYPH[m])));
    const ul = el('ul');
    [
      'Read the situation, tap Next, and the field opens: their end zone at the top, yours at the bottom.',
      'Every dot is a player on today\'s roster, everyone healthy: green is good, red is not. Tap one to see what kind of player he is (mobile QB, blocking tight end…) and his numbers.',
      'Call Run, Pass or RPO, then the play. Timeout, spike, kneel and kicks pop up when they matter.',
      'Every snap is a real NFL play, run out on the field: broken tackles, sacks, picks, fumbles and flags all happen. Tap the field to skip ahead.',
    ].forEach((t) => ul.append(el('li', '', t)));
    openModal('How to play', [
      el('p', 'lead', 'Three real late-game spots a day. You call every play.'),
      ul,
      el('p', '', 'After the snap, see how your call ranked:'),
      ex,
      el('p', 'note', 'Green: the best call (within 0.5% win chance). Yellow: within 2%. Orange: within 5%. Red: worse.'),
      el('p', '', 'At the end: your percentile against NFL play-callers, and the coach you called it like.'),
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
      const bar = el('div', `bar2${todayP != null && todayP >= lo && todayP < hi ? ' hi' : ''}`, String(counts[i]));
      bar.style.width = `${Math.max(8, (counts[i] / mx) * 100)}%`;
      r.append(el('span', '', lab), bar);
      dist.append(r);
    });
    const nodes = [row, el('p', 'note', 'Daily percentile against NFL play-callers'), dist];
    const coaches = days.map((k) => st.days[k].coach).filter(Boolean);
    if (coaches.length) {
      const top = Object.entries(coaches.reduce((a, c) => ({ ...a, [c]: (a[c] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
      nodes.push(el('p', '', `You coach most like ${top[0]} (${top[1]} day${top[1] === 1 ? '' : 's'}).`));
    }
    openModal('Your stats', nodes);
  }

  // ----------------------------------------------------------------- boot ---
  async function boot() {
    $('helpBtn').addEventListener('click', openHelp);
    $('statsBtn').addEventListener('click', openStats);
    $('bar').addEventListener('click', () => { if (G) spotInfo(); });
    $('deepBtn').addEventListener('click', () => { if (G) openDeep(); });
    $('deepClose').addEventListener('click', closeDeep);
    $('mClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('modal').hidden) closeModal();
      else if (!$('deep').hidden) closeDeep();
    });
    let rz = null;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (G && !$('play').hidden) { lastBall = null; drawField(); } }, 150); });
    show('boot');
    try {
      idx = await fetch('game.json').then((r) => { if (!r.ok) throw new Error('game data ' + r.status); return r.json(); });
      idx.calls.forEach((c) => { CALL[c.id] = c; });
      const launch = new Date(idx.launch + 'T00:00:00');
      const now = new Date(); now.setHours(0, 0, 0, 0);
      dayN = Math.max(1, Math.floor((now - launch) / 864e5) + 1);
      today = idx.schedule[(dayN - 1) % idx.schedule.length].map((i) => buildScen(idx.spots[i]));
      $('dayLabel').textContent = `No. ${dayN} · ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    } catch (e) { $('boot').textContent = 'Today\'s spots did not load (' + e.message + '). Check your connection and reload.'; return; }
    state = load(`${STORE}:day:${dayN}`, null) || { spots: [], current: 0, done: false };
    if (!load(`${STORE}:seen`, false)) { openHelp(); save(`${STORE}:seen`, true); }
    drawTiles();
    startWorkers();
    if (state.done) renderSummary();
    else openSpot(Math.min(state.current || 0, 2));
  }
  boot();
})();
