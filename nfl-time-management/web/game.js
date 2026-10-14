/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * Three real late-game spots a day (2023-26, playoffs included), each played by the two teams of that game:
 * the 22 who were on the field, rated as of that week. Each spot opens on a scenario card;
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
  const TEMPOS = ['nohuddle', 'huddle', 'milk'];
  // your defense on their snaps: the looks it shows (the engine draws their play from real plays against it)
  const DEFS = ['blitz', 'load', 'soft'];
  const DEF = { blitz: { label: 'Blitz', sub: 'Send extra rushers' }, load: { label: 'Load the box', sub: 'Stop the run' },
    soft: { label: 'Play it soft', sub: 'Keep it in front' } };
  // the defense's pre-snap look, as the engine buckets real plays: a light box (6 or fewer near the line) or a loaded
  // one (7 or more), with or without a blitz
  const LOOKS = [{ loaded: false, blitz: false }, { loaded: false, blitz: true }, { loaded: true, blitz: false }, { loaded: true, blitz: true }];
  // with the clock running: the tempo of the next snap (the engine's typical seconds between snaps), or stop it
  const CLOCK = {
    nohuddle: { label: 'No-huddle', short: 'No-huddle' },
    huddle: { label: 'Huddle', short: 'Huddle' },
    milk: { label: 'Milk the clock', short: 'Milk it' },
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
  function shortName(n) {
    const parts = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/, '').split(/\s+/);
    return parts.length > 1 ? `${parts[0][0]}.${parts.slice(1).join(' ')}` : (n || '');
  }
  // the end of the first half (t = 1800) reads 0:00 of the 2nd quarter: every spot is late in Q2 or Q4
  function clockOf(t) {
    const q = t > 2700 ? 1 : t >= 1800 ? 2 : t > 900 ? 3 : 4;
    const s = Math.max(0, t - (4 - q) * 900);
    return { q, s, text: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` };
  }
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  // a tempo key (nohuddle, huddle, milk) as the engine's tempo; no-huddle is the engine's own hurry-up when
  // that is the usual tempo here, else 'urgent' inside two minutes of the half and 'hurry' before
  function engineTempo(k, r) {
    if (k === 'huddle') return 'normal';
    if (k === 'milk') return 'milk';
    const usual = G.info && G.info.tempo;
    return usual === 'urgent' || usual === 'hurry' ? usual : halfLeft(r.t) <= 120 ? 'urgent' : 'hurry';
  }
  const tempoKeyOf = (t) => (t === 'urgent' || t === 'hurry' ? 'nohuddle' : t === 'normal' ? 'huddle' : 'milk');
  const clockAct = (k, r) => (TEMPOS.includes(k) ? { to_off: false, tempo: engineTempo(k, r) } : CLOCK[k].act);
  const tempoSecs = (k, r) => { const S_ = (G.info && G.info.tempoSecs) || {}; return S_[engineTempo(k, r)]; };
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
  // a spot's matchup: its two teams as they were in that game (web/spots), the real point spread, that
  // season's league averages
  function buildScen(sp, T) {
    const H = T.home, A = T.away;
    const game = { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
      league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real ? sp.real.season : idx.asof.season };
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
  // the defense shows its look: a safety walks down into a loaded box, a linebacker widens out of a light one,
  // and a blitz look brings two of them up to the line
  function showLook(def, L, s, bx) {
    const lbs = def.filter((o) => o.label === 'LB'), safeties = def.filter((o) => o.label === 'S');
    if (L.loaded) {
      const sd = safeties[safeties.length - 1];
      if (sd) { sd.x = clampX(bx + s * 30); sd.d = 7.5; }
      lbs.forEach((o) => { o.d = 4.5; o.x = bx + (o.x - bx) * 0.8; });
    } else if (lbs.length) {
      const wide = lbs.slice().sort((a, b) => Math.abs(b.x - bx) - Math.abs(a.x - bx))[0];
      wide.x = clampX(bx - s * 70); wide.d = 6.2;
    }
    if (L.blitz) {
      const up = lbs.length ? lbs.slice(0, 2) : safeties.slice(0, 1);
      up.forEach((o, i) => { o.d = 1.9; o.x = clampX(bx + (i ? -1 : 1) * s * (18 + 22 * i)); });
    }
  }
  // ------------------------------------------------------------ the field ---
  // The whole field, your end zone at the bottom of the screen. L counts yards from your goal line (0) to
  // theirs (100); a camera shows yards lo..hi: the whole field, or close up while a play runs.
  const FULL = { lo: -10, hi: 110 };
  const GAP = 6;            // drawn gap (units) between each side and the line of scrimmage before the snap
  let scene = null, fadeNext = false;
  const lerp = (a, b, u) => a + (b - a) * u;
  const EASE = { lin: (u) => u, io: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
    in: (u) => u * u, out: (u) => 1 - (1 - u) * (1 - u), run: trapezoid(0.2, 0.15), dash: trapezoid(0.2, 0) };
  // speed ramps up over the first `a` of the move, holds, and ramps down over the last `d` (peak 1.2x the average)
  function trapezoid(a, d) {
    const v = 1 / (1 - a / 2 - d / 2);
    return (u) => (u < a ? (v * u * u) / (2 * a) : u <= 1 - d ? v * (a / 2 + u - a) : 1 - (v * (1 - u) ** 2) / (2 * d));
  }

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
  function makeScene(r, side, look = r.pos === G.me ? G.look : null) {
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
      if (mode === 'snap' && look != null) showLook(f.def, LOOKS[look], s, fxBall);
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
    if (mode === 'kick') kickoffUnits(sc, r, L, dir);
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
  // Kickoff alignment (the 2024 rules): the kicker at the ball, his ten teammates at the receiving 40 (25 yards
  // ahead of the ball), nine of the receiving team in the setup zone 30-35 yards ahead, and two returners deep.
  // Special-teams units are drawn in team colors: who covers kicks is not in the lineups.
  function kickoffUnits(sc, r, L, dir) {
    const kt = r.pos, goal = dir > 0 ? 100 : 0;
    const row = (n, pad) => Array.from({ length: n }, (_, i) => SX0 + pad + (i * (SX1 - SX0 - 2 * pad)) / (n - 1));
    const add = (teamI, x, Lp, label) => {
      const off = teamI === kt, g = S('g', { class: `dot st ${teamI === G.me ? 'me' : 'them'}`, 'aria-hidden': 'true' });
      g.append(S('circle', { class: 'c', r: 5.6, fill: color(code(teamI)) }));
      sc.layer.append(g);
      const a = { g, p: null, label, team: code(teamI), teamI, off, x0: x, L0: Lp, side: off ? -dir : dir, w0: 0 };
      Object.assign(a, { x: a.x0, L: a.L0, w: 0 });
      sc.actors.push(a);
    };
    add(kt, 180, L - dir * 6, 'K');
    row(10, 26).forEach((x) => add(kt, x, L + dir * 25, 'KC'));
    row(9, 34).forEach((x, i) => add(1 - kt, x, L + dir * (i % 2 ? 31 : 34), 'SZ'));
    add(1 - kt, 138, goal - dir * 4, 'KR');
    add(1 - kt, 222, goal - dir * 9, 'KR');
  }

  function place(sc) {
    const Y = camY(sc);
    sc.parts.forEach((f) => f(Y));
    sc.actors.forEach((a) => a.g.setAttribute('transform', `translate(${a.x.toFixed(1)},${(Y(a.L) + a.side * GAP * a.w).toFixed(1)})`));
    const b = sc.ball;
    if (b) {
      b.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${Y(b.L).toFixed(1)}) scale(${(1 + 0.35 * b.z).toFixed(2)})`);
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
  // After the snap the camera zooms in and the 22 run the real NFL play the engine drew, with what happened called
  // out on the field. Every player moves the way NFL players move: motion.js limits each one's speed, acceleration,
  // braking and turning to what player tracking measures for his position. The play follows what the real play's
  // charting says: the target's route and the depth of the throw, man or zone and the coverage shell, how many
  // rushed, whether the passer was pressured and how long he held the ball. Tap the field to skip; with reduced
  // motion the result just shows.
  const PRE_SNAP = new Set(['False Start', 'Offside', 'Defensive Offside', 'Encroachment', 'Neutral Zone Infraction', 'Delay of Game',
    'Illegal Formation', 'Illegal Shift', 'Illegal Motion', 'Defensive Delay of Game', 'Defensive Too Many Men on Field',
    'Offensive Too Many Men on Field', 'Illegal Substitution']);
  const RUN_GAP = { 'Outside run': 92, 'Off-tackle run': 58, 'Inside run': 26, 'Up the middle': 0, 'QB sneak': 0, 'QB keeper': 60, RPO: 30 };
  const AIR = { quick_strong: 5, quick_weak: 5, quick_middle: 7, screen: -2, deep_strong: 24, deep_weak: 24, deep_middle: 22,
    pa_short: 9, pa_deep: 27, roll_strong: 8, roll_weak: 8, hail_mary: 48, rpo_strong: 4, rpo_weak: 4, trick: 30 };
  // Real NFL timing, in seconds after the snap: the snap reaches the QB in a quarter of a second; when the play
  // was not charted, passes come out 1.35 s (RPO) to 4.3 s (Hail Mary) after the snap (Next Gen Stats averages);
  // the ball flies about 24 yards a second (deep balls are lofted, a little slower); handoffs at 0.8-1.2 s.
  const T_SNAP = 0.25;
  const RELEASE = { quick: 2.3, screen: 1.6, deep: 2.8, pa: 3.0, roll: 3.0, hail: 4.3, rpo: 1.35, trick: 3.6 };
  const flight = (air) => (Math.abs(air) + 7) / (25 - 0.09 * clip(air, 0, 60));              // seconds the ball is in the air
  const PLAY_SPEED = 1;        // real time, your snaps and theirs
  // the routes a call's target runs when the real play was not charted, and the routes the rest run
  const CALL_ROUTE = { quick: ['slant', 'out', 'hitch'], quick_middle: ['slant', 'cross', 'in'], screen: ['screen'],
    deep: ['go', 'post', 'corner', 'deep_out', 'in'], deep_middle: ['post', 'in', 'go'], pa: ['in', 'post', 'cross', 'deep_out'],
    roll: ['out', 'cross', 'corner'], hail: ['go'], rpo: ['slant', 'hitch', 'out'], trick: ['go', 'post'] };
  const OTHER_ROUTES = { short: ['hitch', 'out', 'slant', 'cross', 'in'], deep: ['go', 'post', 'in', 'corner', 'deep_out', 'hitch'],
    hail: ['go'] };
  const GROUP = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL', T: 'OL', G: 'OL',
    EDGE: 'DL', DL: 'DL', LB: 'LB', CB: 'CB', S: 'S', K: 'QB', KC: 'LB', SZ: 'LB', KR: 'RB' };
  // seconds after the snap before the first step: the offense knows the count, the defense reacts to the ball
  // (tracking: receivers are still within half a yard of their stance half a second after the snap)
  const REACT_OFF = 0.18, REACT_DEF = 0.3;

  // where actor a is at play time t: on its simulated track, or (kickoff alignment, before a play) where it stands
  function at(a, t) {
    const k = a.trk;
    if (!k) return { x: a.x0, L: a.L0, w: a.w0 ?? 1 };
    const i = clip(t / k.dt, 0, k.n - 1), j = Math.floor(i), j2 = Math.min(j + 1, k.n - 1), u = i - j;
    const w = k.hold ? k.w0 : k.w0 * clip(1 - (t - k.wt) / 0.3, 0, 1);
    return { x: k.x[j] + (k.x[j2] - k.x[j]) * u, L: k.L[j] + (k.L[j2] - k.L[j]) * u, w };
  }
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

  function choreograph(sc, e, res, two) {
    const P = { T: 1, hold: 0.6, segs: [], calls: [], fx: [] };
    const dir = sc.dir, L0 = sc.losL, bx = sc.bx;
    const fwd = (L, y) => L + dir * y;
    const R = rng(hash('anim', e.row, e.t, e.yards, e.ev));
    const jit = (n) => (R() * 2 - 1) * n;
    const pickOf = (arr) => arr[Math.min(arr.length - 1, Math.floor(R() * arr.length))];
    const say = (t, text, kind, o) => P.calls.push({ t, text, kind, slot: 0, x: bx, L: L0, ...(o || {}) });
    const fly = (t0, t1, x0, La, x1, Lb, h) => P.segs.push({ t0, t1, kind: 'fly', x0, L0: La, x1, L1: Lb, h: h || 0 });
    const hold = (t0, a) => { if (a) P.segs.push({ t0, kind: 'hold', a }); };
    const rest = (t0, x, L, hide) => P.segs.push({ t0, kind: 'rest', x, L, hide });
    const fxAt = (t, f) => P.fx.push({ t, f });
    const down = (t, a) => { if (a) fxAt(t, () => a.g.classList.add('down')); };
    const ring = (t, a, on) => { if (a) fxAt(t, () => a.g.classList.toggle('carrier', on !== false)); };
    const K = cast(sc), qb = K.qb;
    const defName = teamName(code(1 - e.team));

    // ---- the world, in yards: x across the field as drawn (0 = the left sideline), y = L
    const FW = (SX1 - SX0) / XYD, yx = (p) => (p - SX0) / XYD, px = (x) => SX0 + x * XYD;
    const inX = (x) => clip(x, 1.4, FW - 1.4);
    const inL = (L) => clip(L, -9.4, 109.4);
    const Wd = new Motion.World();
    sc.actors.forEach((a) => { a.trk = null; a.b = Wd.add({ g: GROUP[a.label] || 'LB', x: yx(a.x0), y: a.L0, spd: 1 + jit(0.035) }); });
    const BX = yx(bx);
    let snapAt = 0, frozen = false;            // frozen: the play never started (a flag before the snap)
    const busy = new Set();                    // players with a part in the outcome
    const leg = (a, t, kind, o) => { if (a) Wd.leg(a.b, t, kind, o); };
    const plan = (a, pts, o) => Motion.planPath(pts, a.b.g, { spd: a.b.spd, ...(o || {}) });
    const follow = (a, t, pl) => { leg(a, t, 'path', { plan: pl }); return pl; };
    const here = (a) => [a.b.x, a.b.y];
    const vel = (a) => Math.hypot(a.b.vx, a.b.vy);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const toPx = (p) => ({ x: px(p[0]), L: p[1] });
    // a planned run from time t (the world is run up to it first: plans start where the player really is then),
    // carrying his momentum into the first step
    function runFrom(a, t, pts, o) {
      if (t > Wd.t + 1e-9) Wd.run(t);
      t = Math.max(t, Wd.t);
      const b = a.b, s = Math.hypot(b.vx, b.vy), st = [[b.x, b.y]];
      if (s > 1.2) { const k = Math.min(4, Math.max(1, s * 0.45)) / s; st.push([b.x + b.vx * k, b.y + b.vy * k]); }
      return follow(a, t, plan(a, st.concat(pts.map((p) => [inX(p[0]), p[1]])), { v0: s, ...(o || {}) }));
    }
    const nearest = (list, p, skip) => {
      let best = null, bd = Infinity;
      (list || []).forEach((a) => { if (!a || (skip && skip.has(a))) return; const d = dist(here(a), p); if (d < bd) { bd = d; best = a; } });
      return best;
    };
    const foes = (a) => (a.off ? K.def : K.off);
    const tdL = () => (dir > 0 ? 103 : -3);
    const sidelineX = (x) => (x > FW / 2 ? FW + 0.6 : -0.6);
    const lastEnd = (t) => { P.T = Math.max(P.T, t); };

    // ---- the snap and the line
    function snapToQb() {
      if (!qb) return;
      fly(0, T_SNAP, bx, L0, qb.x0, qb.L0, 0.15);
      hold(T_SNAP, qb);
    }
    // pass protection gives ground the way NFL lines do (depth curves from tracking), each rusher a yard off his
    // blocker; run blocking drives forward and toward the play side, pushing the defensive line back
    const blockerOf = new Map();
    function lineplay(kind, side, rushers) {
      const ol = K.ol.slice();
      ol.forEach((a) => {
        const x0 = a.b.x, y0 = a.b.y, tackle = a.label === 'LT' || a.label === 'RT';
        const lat = kind === 'run' ? side * (1.1 + jit(0.3)) : tackle ? Math.sign(x0 - BX) * 0.9 : jit(0.3);
        leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.9, fn: (t) => {
          const u = clip((t - REACT_OFF) / 1.6, 0, 1);
          return [x0 + lat * u, y0 + dir * Motion.curveShift(kind, 'OL', t)];
        } });
      });
      rushers.forEach((d) => {
        const blk = nearest(ol, here(d)) || nearest(K.off.filter((a) => a !== qb), here(d));
        if (!blk) return;
        blockerOf.set(d, blk);
        const sx = d.b.x, sy = d.b.y, dx = clip(sx - blk.b.x, -1.2, 1.2) * 0.5;
        leg(d, REACT_DEF, 'track', { gain: 3.2, eff: 0.95, fn: (t) => {
          const p = Wd.posAt(blk.b, t), u = clip((t - REACT_DEF) / 0.45, 0, 1);
          const ex = p[0] + dx, ey = p[1] + dir * 0.95;
          return [sx + (ex - sx) * u, sy + (ey - sy) * u];
        } });
      });
    }
    // after the whistle: everyone eases up; those close by drift toward the pile
    function whistle(t, pile) {
      sc.actors.forEach((a) => {
        if (busy.has(a)) return;
        const p = here(a), d = pile ? dist(p, pile) : 99;
        const t1 = t + 0.1 + R() * 0.35;
        if (pile && d < 14 && d > 2.5) {
          const k = (d - 2.2 - R() * 1.5) / d;
          leg(a, t1, 'go', { x: p[0] + (pile[0] - p[0]) * k, y: p[1] + (pile[1] - p[1]) * k, eff: 0.32 });
        } else leg(a, t1, 'stand');
      });
    }

    // ---- the run after the catch, the run, the return: the ball carrier runs to the end of the play. The
    // defender who can get to him first meets him a yard or two short of the spot, coming at a pursuit angle, and
    // drives him to it; a second one arrives just after; the rest chase, holding off until the tackle; his
    // teammates block the nearest chasers. Returns the time the play ends.
    function runDown(car, t0, endPt, o) {
      o = o || {};
      Wd.run(t0);
      t0 = Wd.t;
      busy.add(car);
      const start = here(car), defs = foes(car).filter((d) => !busy.has(d));
      const tackled = !o.td && !o.oob && !o.free;
      const after = tackled ? (o.after ?? (car.label === 'RB' || car.label === 'QB' ? 1.5 + R() : 0.6 + R() * 0.8)) : 0;
      // to daylight: the middle of the run bends away from where the defense is headed
      const pts = [];
      const span = dist(start, endPt);
      if (span > 7 && !o.straight) {
        const tm = Math.min(1.2, span / 14), mid = [start[0] + (endPt[0] - start[0]) * 0.55, start[1] + (endPt[1] - start[1]) * 0.55];
        const [ux, uy] = unit(endPt[0] - start[0], endPt[1] - start[1]);
        let best = mid, bs = -1;
        [-3, -1.5, 0, 1.5, 3].forEach((off) => {
          const c = [inX(mid[0] - uy * off), mid[1] + ux * off * 0.2];
          const m = Math.min(99, ...defs.map((d) => dist(c, [d.b.x + d.b.vx * tm, d.b.y + d.b.vy * tm])));
          const s = Math.min(m, 6) - Math.abs(off) * 0.4;
          if (s > bs) { bs = s; best = c; }
        });
        pts.push(best);
      }
      const [ex, ey] = unit(endPt[0] - (pts.length ? pts[0][0] : start[0]), endPt[1] - (pts.length ? pts[0][1] : start[1]));
      const contact = tackled ? [endPt[0] - ex * after, endPt[1] - ey * after] : endPt;
      const route = dist(start, contact) > 0.6 ? pts.concat([contact]) : [contact];
      let A = runFrom(car, t0, route, { eff: o.eff ?? 0.97, v1: tackled ? 3.4 : undefined });
      let tC = t0 + A.T;
      // who gets there: the defender with the shortest time to the contact point, from where he is now
      const reach = defs.map((d) => {
        const p = here(d), s = vel(d), cosv = s > 0.5 ? ((contact[0] - p[0]) * d.b.vx + (contact[1] - p[1]) * d.b.vy) / (s * (dist(p, contact) || 1)) : 0;
        return { d, T: Motion.minTime([p, contact], d.b.g, { v0: Math.max(0, s * cosv), spd: d.b.spd }) };
      }).sort((x, y) => x.T - y.T);
      let tackler = null, tEnd = tC, tGo = t0, B = null;
      if (tackled && reach.length) {
        tackler = reach[0].d;
        if (reach[0].T > tC - t0 + 0.1) {            // nobody can get there in time: he slows in traffic
          A = runFrom(car, t0, route, { T: reach[0].T + 0.1, v1: 3.4 });
          tC = t0 + A.T;
        }
        busy.add(tackler);
        // the pile: driven from the contact point to the spot
        B = plan(car, [contact, endPt], { v0: 3.4, v1: 0, eff: 0.32 });
        follow(car, tC, B);
        tEnd = tC + Math.max(B.T, 0.25);
        // he goes at the right moment (a lineman, slow off his block, goes at once)
        tGo = tackler.b.g === 'DL' || tackler.b.g === 'OL' ? t0 : clip(tC - reach[0].T / 0.82, t0, tC - 0.3);
        // until he goes, he closes on the play
        if (tGo > t0 + 0.05) leg(tackler, t0 + 0.15, 'chase', { who: car.b, gap: 4, eff: 0.6, lead: 1 });
        // a second man in, just after
        const two_ = reach.find((r) => r.d !== tackler && r.T < tEnd - t0 + 0.6);
        if (two_) {
          busy.add(two_.d);
          const q = here(two_.d), [qx, qy] = unit(endPt[0] - q[0], endPt[1] - q[1]);
          runFrom(two_.d, t0, [[endPt[0] - qx * 1.0, endPt[1] - qy * 1.0]], { T: Math.max(0.4, tEnd - t0 + 0.12) });
          leg(two_.d, tEnd + 0.3, 'stand');
        }
      } else if (o.oob && reach.length && reach[0].T < tC - t0 + 0.3) {
        // forced out: someone runs him to the sideline
        tackler = reach[0].d;
        busy.add(tackler);
        const q = here(tackler), [qx, qy] = unit(endPt[0] - q[0], endPt[1] - q[1]);
        runFrom(tackler, t0, [[endPt[0] - qx * 1.2, endPt[1] - qy * 1.2]], { T: Math.max(0.4, tC - t0 + 0.05) });
        leg(tackler, tC + 0.25, 'stand');
        tackler = null;
      }
      // the broken tackle: a defender gets a hand on him at the middle of the run and misses
      if (o.bt && tackled && tC - t0 > 0.9) {
        const tb = t0 + (tC - t0) * 0.45, pc = A.at(tb - t0), [vx, vy] = unit(pc[2], pc[3]);
        const miss = nearest(foes(car).filter((d) => !busy.has(d)), [pc[0], pc[1]]);
        if (miss) {
          busy.add(miss);
          runFrom(miss, t0, [[pc[0] + vy * 0.9, pc[1] - vx * 0.9]], { T: tb - t0 });
          leg(miss, tb + 0.05, 'go', { x: pc[0] + vy * 1.6 - vx * 1.5, y: pc[1] - vx * 1.6 - vy * 1.5, eff: 0.5 });
          leg(miss, tb + 0.6, 'stand');
          down(tb + 0.15, miss);
        }
        say(tb, 'Broken tackle!', 'boom', { follow: car });
      }
      // everyone else: chase (holding off), or block a chaser; at the end, ease up
      foes(car).forEach((d) => {
        if (busy.has(d)) return;
        leg(d, t0 + 0.15 + R() * 0.35, 'chase', { who: car.b, gap: 1.8 + R(), eff: 0.82 + R() * 0.18, lead: 1 });
      });
      const mates = (car.off ? K.off : K.def).filter((m) => m !== car && !busy.has(m));
      mates.forEach((m) => {
        const d = dist(here(m), start);
        if (m.b.g === 'OL' || m.b.g === 'DL' || m.b.g === 'QB') {      // linemen finish their blocks; the passer watches
          const p = here(m);
          leg(m, t0 + 0.3 + R() * 0.5, 'go', { x: p[0] + (endPt[0] - p[0]) * 0.1, y: p[1] + dir * (car.off ? 1.5 + R() * 2 : -(1.5 + R() * 2)), eff: 0.3 });
          return;
        }
        if (d < 14) {
          const foe = nearest(foes(car), here(m), new Set([tackler]));
          if (foe) leg(m, t0 + 0.2 + R() * 0.3, 'chase', { who: foe.b, gap: 0.9, eff: 0.7 + R() * 0.2, lead: 0.6 });
        } else leg(m, t0 + 0.3, 'go', { x: here(m)[0] + (endPt[0] - here(m)[0]) * 0.3, y: here(m)[1] + (endPt[1] - here(m)[1]) * 0.3, eff: 0.45 });
      });
      // the tackler goes at the right moment, at a pursuit angle to the meeting point, and drives him to the spot
      if (tackler && B) {
        Wd.run(tGo);
        const p = here(tackler), [cx, cy] = unit(contact[0] - p[0], contact[1] - p[1]);
        runFrom(tackler, Wd.t, [[contact[0] - cx * 0.7, contact[1] - cy * 0.7]], { T: Math.max(0.2, tC - Wd.t) });
        leg(tackler, tC, 'stick', { who: car.b, dx: -cx * 0.75, dy: -cy * 0.75, ease: 0.2 });
        leg(tackler, tEnd + 0.05, 'stand');
      }
      Wd.run(tEnd);
      if (tackled) leg(car, tEnd, 'stand');
      else leg(car, tEnd, 'go', { x: endPt[0] + (o.oob ? Math.sign(endPt[0] - FW / 2) * 1.5 : 0), y: endPt[1] + dir * (o.td ? 1.5 : 1), eff: 0.4 });
      whistle(tEnd, here(car));
      return tEnd;
    }
    // how the ball carrier's play ends: the call-outs, a fumble
    function finish(car, tEnd, xyEnd) {
      const fumble = ['fumble_lost', 'fumble_kept', 'scoop_score'].includes(e.evt);
      let t = tEnd;
      if (e.td) say(tEnd, two ? 'Two-point try good!' : 'Touchdown!', 'good', { follow: car });
      else if (e.safety) say(tEnd, 'Safety!', 'hit', { follow: car });
      else if (fumble) {
        const lost = e.evt !== 'fumble_kept';
        say(tEnd, 'Fumble!', 'hit', { follow: car });
        const f = [inX(xyEnd[0] + jit(2.5)), xyEnd[1] + dir * 1.2];
        fly(tEnd, tEnd + 0.55, px(xyEnd[0]), xyEnd[1], px(f[0]), f[1], 0.3);
        rest(tEnd + 0.55, px(f[0]), f[1]);
        Wd.run(tEnd);
        const rec = lost ? nearest(foes(car), f) : nearest((car.off ? K.off : K.def).filter((m) => m !== car), f) || car;
        if (rec) {
          busy.add(rec);
          runFrom(rec, tEnd + 0.1, [f], { T: 0.6, v1: 0 });
          hold(tEnd + 0.72, rec);
          t = tEnd + 0.72;
          if (e.evt === 'scoop_score') {
            const z = [inX(f[0] + jit(8)), dir > 0 ? -3 : 103];
            const pl = runFrom(rec, t, [z], { eff: 0.95 });
            foes(rec).forEach((d) => { if (d !== rec) leg(d, t + 0.3, 'chase', { who: rec.b, gap: 2, eff: 0.9 }); });
            t += pl.T;
            say(t, 'Scoop and score!', 'hit', { follow: rec });
          } else {
            leg(rec, t, 'stand');
            say(t, lost ? `${defName} ball` : 'Recovered', lost ? 'hit' : 'info', { slot: 1, follow: rec });
          }
        }
        t += 0.2;
      } else if (e.oob) say(tEnd, 'Out of bounds', 'info', { follow: car });
      else {
        say(tEnd, fwd(0, xyEnd[1] - L0) < -0.5 ? 'Stopped for a loss' : two ? 'Stopped short' : 'Tackled', 'info', { follow: car });
        down(tEnd + 0.08, car);
      }
      if (e.fd && !e.td) say(tEnd + 0.35, 'First down', 'good', { slot: 1, follow: car });
      if (e.onDowns) say(tEnd + 0.35, 'Turnover on downs', 'hit', { slot: 1, follow: car });
      lastEnd(t + 1.1);
      return t;
    }

    // ---- the pass
    function pickTarget(id, sign) {
      if (e.who === 'RB' || id === 'screen') return K.rb || K.recv[0];
      const side = (a) => (sign ? sign * (a.x0 - bx) > 0 : true);
      const nearBall = (list) => list.slice().sort((a, b) => Math.abs(a.x0 - bx) - Math.abs(b.x0 - bx))[0];
      if (e.who === 'TE') return nearBall(K.recv.filter((a) => a.label === 'TE' && side(a))) || K.recv.find((a) => a.label === 'TE') || K.recv[0];
      const wr = K.recv.filter((a) => a.label === 'WR');
      const pool = (wr.length ? wr : K.recv).filter(side);
      const all = pool.length ? pool : (wr.length ? wr : K.recv);
      if (!all.length) return K.rb;
      const out = all.slice().sort((a, b) => Math.abs(b.x0 - bx) - Math.abs(a.x0 - bx));
      return id.startsWith('deep') || id === 'pa_deep' || id === 'hail_mary' ? out[0] : out[out.length - 1];
    }
    const passKind = (id) => (id.startsWith('quick') ? 'quick' : id === 'screen' ? 'screen' : id.startsWith('deep') ? 'deep'
      : id.startsWith('pa_') ? 'pa' : id.startsWith('roll') ? 'roll' : id === 'hail_mary' ? 'hail' : id.startsWith('rpo') ? 'rpo'
        : id === 'trick' ? 'trick' : 'quick');
    // the coverage shell: as charted, or drawn as often as defenses play each
    function shellOf() {
      if (e.shell && Motion.SHELLS[e.shell]) return e.shell;
      if (e.man === true) return pickOf(['cover1', 'cover1', 'cover1', '2man', 'cover0']);
      let u = R(), acc = 0;
      for (const [s, p] of Motion.SHELL_SHARE) { acc += p; if (u <= acc) return s; }
      return 'cover3';
    }
    // a field landmark ([x from the offense's left, depth]) on the drawn field
    const mark = (m) => [dir > 0 ? m[0] : FW - m[0], fwd(L0, m[1])];
    // the rushers: as many as charted (default four; a blitz look sends five), linemen first
    function rushersOf(n) {
      const order = K.rush.concat(K.def.filter((d) => d.label === 'LB'), K.def.filter((d) => d.label === 'S'), K.def.filter((d) => d.label === 'CB'));
      const lbs = order.slice(K.rush.length).sort((a, b) => Math.abs(a.x0 - bx) - Math.abs(b.x0 - bx));
      return K.rush.concat(lbs).slice(0, clip(n, 3, 8));
    }
    // every receiver's route and every defender's job, from the snap until the ball is thrown
    function passShape(o) {
      const { kind, tgt, catchPt, tThrow, tCatch, rushers, shell, side, qbSpot } = o;
      const man = Motion.MAN[shell];
      const others = K.recv.filter((a) => a !== tgt);
      const runners = [];                     // [actor, route plan] for coverage to read
      others.forEach((a, i) => {
        if (a.label === 'TE' && (rushers.length >= 6 || R() < 0.3)) {        // stays in to block
          const edge = nearest(K.rush, here(a));
          leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.8, fn: (t) => { const q = edge ? Wd.posAt(edge.b, t) : here(a); return [q[0], q[1] - dir * 0.95]; } });
          return;
        }
        const name = kind === 'hail' ? 'go' : pickOf(kind === 'deep' || kind === 'pa' ? OTHER_ROUTES.deep : OTHER_ROUTES.short);
        const D = { go: 26, post: 18, corner: 18, deep_out: 13, in: 11, hitch: 6, out: 4, slant: 6, cross: 5 }[name] + jit(2);
        const out = Math.sign(a.b.x - BX) || side || 1;
        const r = Motion.routeOnField(name, D, a.b.x, out, dir, L0, Math.abs(a.b.y - L0), R());
        const pl = follow(a, REACT_OFF, plan(a, r.pts.map((p) => [inX(p[0]), inL(p[1])]), { eff: 0.86 + R() * 0.1 }));
        runners.push([a, pl]);
        leg(a, Math.max(tCatch, tThrow + 0.5) + 0.3 + R() * 0.4, 'stand');
      });
      // the back: blocks when they send five or more, else checks out into the flat
      if (K.rb && K.rb !== tgt && kind !== 'pa' && kind !== 'trick') {
        if (rushers.length >= 5) {
          const blitzer = rushers[rushers.length - 1];
          leg(K.rb, REACT_OFF, 'track', { gain: 2.6, eff: 0.85, fn: (t) => {
            const q = Wd.posAt(blitzer.b, t), Q = qbSpot(t);
            return [Q[0] + (q[0] - Q[0]) * 0.5, Q[1] + (q[1] - Q[1]) * 0.5];
          } });
        } else {
          const out = Math.sign(K.rb.b.x - BX) || side;
          const r = Motion.routeOnField('flat', 0, K.rb.b.x, out, dir, L0, Math.abs(K.rb.b.y - L0), R());
          follow(K.rb, 1.3, plan(K.rb, r.pts.map((p) => [inX(p[0]), p[1]]), { eff: 0.75 }));
        }
      }
      // coverage: man (trail him a beat behind, a cushion deep) or zone (drop to the landmark), then break on the ball
      const cover = K.def.filter((d) => !rushers.includes(d));
      const recvs = K.recv.concat(K.rb && K.rb !== tgt && rushers.length < 5 ? [K.rb] : []).concat(K.rb === tgt ? [K.rb] : []);
      const S_ = Motion.SHELLS[shell] || Motion.SHELLS.cover3;
      const assigned = new Map();
      if (man) {
        const deepN = S_.deep.length, safeties = cover.filter((d) => d.label === 'S');
        const deepers = safeties.slice(0, deepN);
        deepers.forEach((d, i) => { assigned.set(d, null); leg(d, REACT_DEF, 'go', { ...xy(mark(S_.deep[i])), eff: 0.8 }); });
        const pool = cover.filter((d) => !deepers.includes(d));
        const order = recvs.slice().sort((a, b) => Math.abs(b.b.x - BX) - Math.abs(a.b.x - BX));
        order.forEach((r) => {
          const pref = r.label === 'WR' ? ['CB', 'S', 'LB'] : r.label === 'TE' ? ['S', 'LB', 'CB'] : ['LB', 'S', 'CB'];
          let d = null;
          for (const lab of pref) { d = nearest(pool.filter((x) => x.label === lab && !assigned.has(x)), here(r)); if (d) break; }
          if (!d) return;
          assigned.set(d, r);
          // off coverage: he holds the depth he lined up at, backpedalling (corners and safeties bail at the snap:
          // tracking has corners 1 yard deeper after a second), until the receiver gets to him, then runs with him
          // a beat behind and a cushion over the top, inside leverage; he never comes across the line
          const inside = Math.sign(BX - r.b.x) || 1, db = d.label === 'CB' || d.label === 'S';
          leg(d, REACT_DEF, 'mirror', { who: r.b, lag: 0.28 + R() * 0.12, dir, los: L0, floor: 0.8, tau: 1.0, y0: d.b.y,
            pedal: db ? 1.5 : 0.4, pedalMax: db ? 3 : 1.5, cush: r.label === 'WR' ? 1.4 : 0.9, dx0: d.b.x - r.b.x, dx: inside * 0.7, eff: 0.97 });
        });
        pool.filter((d) => !assigned.has(d)).forEach((d) => {       // the spare: a robber in the middle; a lineman sits short
          if (d.label === 'DL' || d.label === 'EDGE') { leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: fwd(L0, 3.5), eff: 0.6 }); return; }
          const m = S_.under[0] ? mark(S_.under[0]) : [BX, fwd(L0, 7)];
          leg(d, REACT_DEF, 'go', { x: m[0] + jit(2), y: m[1], eff: 0.6 });
        });
      } else {
        const deepPool = cover.filter((d) => d.label === 'S').concat(cover.filter((d) => d.label === 'CB'));
        const deepMarks = S_.deep.map(mark), underMarks = S_.under.map(mark);
        const used = new Set();
        deepMarks.forEach((m) => {
          const d = nearest(deepPool.filter((x) => !used.has(x)), m);
          if (d) { used.add(d); leg(d, REACT_DEF, 'go', { x: m[0], y: m[1], eff: 0.85 }); }
        });
        underMarks.forEach((m) => {
          const d = nearest(cover.filter((x) => !used.has(x)), m);
          if (d) { used.add(d); leg(d, REACT_DEF, 'go', { x: m[0] + jit(1.5), y: m[1] + jit(1), eff: 0.75 }); }
        });
        cover.filter((d) => !used.has(d)).forEach((d) => leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: d.label === 'DL' || d.label === 'EDGE' ? fwd(L0, 3.5) : fwd(d.b.y, 3), eff: 0.6 }));
      }
      return { cover, man };
    }
    const xy = (p) => ({ x: p[0], y: p[1] });

    function pass(c, id, sign) {
      if (!qb) return;
      const kind = passKind(id);
      const side = sign || (sc.s * dir) || 1;
      const air = e.air !== undefined ? e.air : (AIR[id] ?? 7);
      const thrownAway = e.evt === 'throwaway';
      snapToQb();
      busy.add(qb);
      ring(T_SNAP, qb);
      // when he lets it go: as charted, else the call's typical time
      let tThrow = e.ttt ? clip(e.ttt, 0.9, 7.5) : RELEASE[kind] + jit(0.25);
      if (kind === 'screen') tThrow = Math.min(tThrow, 2.2);
      // his drop: a shotgun drift to about 7.5 yards, deeper for a deep shot; play action carries out the fake;
      // a rollout moves the pocket; he climbs when he has time
      const q0 = here(qb), deepDrop = kind === 'hail' ? 8.6 : kind === 'deep' || kind === 'pa' ? 7.8 : kind === 'screen' ? 7.6 : 7.2;
      let qpts;
      if (kind === 'roll') qpts = [q0, [inX(q0[0] + side * 3), fwd(L0, -6.6)], [inX(q0[0] + side * 9.5), fwd(L0, -6.2)]];
      else if (kind === 'pa' || kind === 'trick') qpts = [q0, [q0[0] + (K.rb ? Math.sign(K.rb.b.x - q0[0]) * 1.2 : 0.5), fwd(L0, -5.6)], [q0[0], fwd(L0, -deepDrop)]];
      else if (kind === 'rpo') qpts = [q0, [q0[0] + jit(0.4), fwd(L0, -5.6)]];
      else qpts = [q0, [q0[0] + jit(0.3), fwd(L0, -deepDrop)]];
      const qPlan = plan(qb, qpts, { eff: kind === 'roll' ? 0.75 : 0.52, v1: kind === 'roll' ? 2.5 : 0 });
      follow(qb, T_SNAP, qPlan);
      const tSet = T_SNAP + qPlan.T;
      if (tThrow > tSet + 0.9 && kind !== 'roll') {
        const e2 = qPlan.end;
        leg(qb, tSet + 0.35, 'go', { x: e2[0] + jit(0.6), y: e2[1] + dir * (0.6 + R() * 0.6), eff: 0.25 });
      }
      const qbSpot = (t) => Wd.posAt(qb.b, Math.min(t, Wd.t));
      // the target and the catch: his route (as charted, else the call's), to the depth of the real throw, there
      // when the ball is
      const tgt = pickTarget(id, sign) || K.rb;
      if (!tgt) return;
      busy.add(tgt);
      const routeName = thrownAway ? 'out' : (e.route && Motion.route(e.route, air, 1, 0.5) ? e.route
        : tgt === K.rb ? (kind === 'screen' ? 'screen' : pickOf(['flat', 'angle', 'flat'])) : pickOf(CALL_ROUTE[id === 'quick_middle' ? 'quick_middle' : id === 'deep_middle' ? 'deep_middle' : kind] || ['hitch']));
      const out = tgt === K.rb ? side : (Math.sign(tgt.b.x - BX) || side);
      const r = Motion.routeOnField(routeName, air, tgt.b.x, out, dir, L0, Math.abs(tgt.b.y - L0), R());
      let catchPt = [inX(r.catchAt[0]), inL(fwd(L0, air))];
      let tCatch = tThrow + flight(air);
      const rpts = r.toCatch.slice(0, -1).map((p) => [inX(p[0]), inL(p[1])]).concat([catchPt]);
      const tStart = tgt === K.rb && kind !== 'screen' ? 0.5 : REACT_OFF;
      const tp = plan(tgt, rpts, { T: tCatch - tStart, v1: routeName === 'hitch' || routeName === 'screen' ? 0 : undefined });
      if (tp.late > 0.02) tCatch += tp.late;
      follow(tgt, tStart, tp);
      // the rush and the line
      const nRush = e.rushers || (e.look && e.look.blitz ? 5 : 4);
      const rushers = rushersOf(nRush);
      lineplay('pass', side, rushers.filter((d) => K.rush.includes(d)));
      const blitzers = rushers.filter((d) => !K.rush.includes(d));
      blitzers.forEach((d, i) => leg(d, REACT_DEF + 0.1, 'chase', { who: qb.b, gap: 1.6 + i * 0.6, eff: 0.95, lead: 0.2 }));
      // pressure: one rusher beats his man and is on the passer as he throws
      if (e.pressure) {
        const w = pickOf(rushers);
        leg(w, Math.max(REACT_DEF + 0.4, tThrow - 1.1), 'chase', { who: qb.b, gap: 1.1, eff: 1, lead: 0.3 });
      }
      const cov = passShape({ kind, tgt, catchPt, tThrow, tCatch, rushers, shell: shellOf(), side, qbSpot });
      // the throw
      Wd.run(tThrow);
      const qT = here(qb);
      if (thrownAway) catchPt = [sidelineX(qT[0] + side * 10) + Math.sign(qT[0] - FW / 2 || side) * 2.5, inL(fwd(L0, Math.max(3, air)))];
      fly(tThrow, tCatch, px(qT[0]) + 4, qT[1], px(catchPt[0]), catchPt[1], Math.min(2.4, 0.35 + Math.abs(air) * 0.05));
      ring(tThrow, qb, false);
      leg(qb, tThrow + 0.15, 'go', { x: qT[0] + jit(1), y: qT[1] + dir * 1.2, eff: 0.25 });
      // the defense breaks on the ball a beat after it is out: the nearest two to where it is going
      const breakers = cov.cover.slice().sort((a, b) => dist(here(a), catchPt) - dist(here(b), catchPt)).slice(0, 2);
      const intc = e.evt === 'interception' || e.evt === 'pick_six';
      let picker = null;
      if (intc) {
        picker = breakers[0] || nearest(K.def, catchPt);
        busy.add(picker);
        const pl = runFrom(picker, tThrow + 0.2, [[catchPt[0] - out * 0.4, catchPt[1] - dir * 0.6]], { T: tCatch - tThrow - 0.2 });
        if (pl.late > 0.05) tCatch += pl.late;
      }
      breakers.forEach((d, i) => {
        if (d === picker) return;
        const near_ = dist(here(d), catchPt);
        const yac = Math.abs(e.yards - air);
        // the closer the coverage, the shorter the run after the catch: trail by more when he got loose
        const lag = clip(yac * 0.07, 0, 1.2);
        leg(d, tThrow + 0.35 + lag * 0.4, 'go', { x: catchPt[0] + jit(1.2), y: catchPt[1] + dir * (1.2 + lag), eff: i ? 0.8 : 0.95 });
        if (near_ > 25) leg(d, tThrow + 0.35, 'go', { x: catchPt[0], y: catchPt[1] + dir * 6, eff: 0.85 });
      });
      Wd.run(tCatch);
      // what happened at the catch point
      if (intc) {
        hold(tCatch, picker);
        ring(tCatch, picker);
        say(tCatch, 'Intercepted!', 'hit', { follow: picker });
        const end = e.evt === 'pick_six' ? [inX(catchPt[0] + jit(10)), tdL()] : [inX(catchPt[0] + jit(8)), inL(losOf(res.root))];
        // he runs it back the other way: the offense becomes the chasers
        const tEnd = runDown(picker, tCatch + 0.05, end, { td: e.evt === 'pick_six', after: 0.6 });
        if (e.evt === 'pick_six') say(tEnd, 'Pick-six!', 'hit', { follow: picker });
        else down(tEnd + 0.05, picker);
        lastEnd(tEnd + 1.0);
        return;
      }
      if (e.incomplete || ['throwaway', 'drop', 'near_pick'].includes(e.evt)) {
        const brk = breakers[0];
        const g = thrownAway ? catchPt : [inX(catchPt[0] + jit(1.5)), catchPt[1] + dir * 1.4];
        fly(tCatch, tCatch + 0.2, px(catchPt[0]), catchPt[1], px(g[0]), g[1], 0.15);
        rest(tCatch + 0.2, px(g[0]), g[1]);
        rest(tCatch + 1.0, px(g[0]), g[1], true);
        if (brk && !thrownAway) leg(brk, tCatch - 0.1, 'go', { x: catchPt[0] + out * 0.5, y: catchPt[1] + dir * 0.4, eff: 0.7 });
        const text = e.evt === 'drop' ? 'Dropped!' : e.evt === 'near_pick' ? 'Almost picked!' : thrownAway ? 'Thrown away'
          : kind === 'hail' ? 'Knocked down' : two ? 'Incomplete: no good' : 'Incomplete';
        say(tCatch, text, e.evt === 'near_pick' ? 'boom' : 'info', { x: px(inX(catchPt[0])), L: catchPt[1] });
        if (e.evt === 'drop') down(tCatch + 0.1, tgt);
        leg(tgt, tCatch + 0.1, 'stand');
        whistle(tCatch + 0.2, catchPt);
        lastEnd(tCatch + 1.4);
        return;
      }
      hold(tCatch, tgt);
      ring(tCatch, tgt);
      const yac = e.td ? 99 : fwd(0, fwd(L0, e.yards) - catchPt[1]);
      const endY = e.td ? tdL() : inL(fwd(L0, e.yards));
      const endX = e.oob ? sidelineX(catchPt[0] + out * 6) : inX(catchPt[0] + clip(jit(5) + out * Math.min(Math.abs(yac), 12) * 0.25, -9, 9));
      if (Math.abs(yac) > 4 && !e.bt) say(tCatch, 'Caught', 'boom', { follow: tgt });
      const tEnd = runDown(tgt, tCatch + 0.05, [endX, endY], { td: e.td, oob: e.oob, bt: e.bt });
      finish(tgt, tEnd, [endX, endY]);
    }

    // ---- the run
    function run(c, id, sign) {
      const carrier = (id === 'qb_sneak' || id === 'qb_run' || e.who === 'QB') ? qb
        : (id === 'trick' && e.who === 'WR') ? K.recv.filter((a) => a.label === 'WR').sort((a, b) => Math.abs(a.x0 - (bx - (sign || 1) * 120)) - Math.abs(b.x0 - (bx - (sign || 1) * 120)))[0] : (K.rb || qb);
      if (!carrier) return;
      const gap = RUN_GAP[c ? c.base : ''] ?? 26;
      const sg = sign || (id === 'qb_run' ? sc.s * dir : 0) || 0;
      const hole = [inX(BX + (sg * gap) / XYD), fwd(L0, 0.6)];
      snapToQb();
      busy.add(carrier);
      // one continuous run from his stance through the mesh to the hole, flat out: across the QB's face when the
      // play goes away from his side, downhill when it goes his way; the handoff is when he gets to the mesh
      // (tracking: backs reach the line about 2.5 s after the snap)
      const c0 = here(carrier), q0 = qb ? here(qb) : c0;
      let tMesh = T_SNAP + 0.05, tLos;
      if (carrier === qb) {
        const pl = follow(qb, T_SNAP + 0.05, plan(qb, [q0, id === 'qb_sneak' ? [BX, fwd(L0, 0.4)] : hole], { eff: 0.92 }));
        tLos = T_SNAP + 0.05 + pl.T;
      } else {
        const across = sg === 0 || Math.sign(hole[0] - q0[0]) !== Math.sign(c0[0] - q0[0]);
        const meshPt = carrier.label === 'WR' ? [q0[0] + (c0[0] > q0[0] ? 1.2 : -1.2), fwd(L0, -4.2)]
          : across ? [q0[0] + (c0[0] - q0[0]) * 0.3, fwd(L0, -4.3)] : [c0[0] + (hole[0] - c0[0]) * 0.15, fwd(L0, -4.3)];
        const start = carrier.label === 'WR' ? 0.35 : REACT_OFF;
        const pl = follow(carrier, start, plan(carrier, [c0, meshPt, hole], { eff: carrier.label === 'WR' ? 0.95 : 0.9 }));
        let best = 9, bt = 0.7;
        for (let s = 0; s <= pl.T; s += 0.05) { const p = pl.at(s), d = dist([p[0], p[1]], meshPt); if (d < best) { best = d; bt = s; } }
        tMesh = Math.max(T_SNAP + 0.35, start + bt);
        tLos = start + pl.T;
        if (qb) {
          // the QB meets him there, then carries out the fake away from the run
          const qm = [meshPt[0] + Math.sign(q0[0] - meshPt[0] || -(sg || 1)) * 0.8, fwd(L0, -4.9)];
          follow(qb, T_SNAP, plan(qb, [q0, qm], { T: tMesh - T_SNAP, v1: 0 }));
          leg(qb, tMesh + 0.15, 'go', { x: inX(qm[0] - (sg || 1) * 7), y: fwd(L0, -6.5), eff: 0.55 });
          hold(tMesh, carrier);
        }
      }
      ring(tMesh, carrier);
      lineplay('run', sg, K.rush);
      // the second level: linebackers read, then fill toward the hole; safeties come down; corners hold, then come up
      K.def.forEach((d) => {
        if (K.rush.includes(d)) return;
        if (d.label === 'LB') leg(d, REACT_DEF + 0.25, 'go', { x: hole[0] + jit(2.5), y: fwd(L0, 3 + R() * 1.5), eff: 0.7 });
        else if (d.label === 'S') leg(d, 0.9 + R() * 0.3, 'go', { x: d.b.x + (hole[0] - d.b.x) * 0.5, y: fwd(L0, 6 + R() * 3), eff: 0.75 });
        else leg(d, 1.1 + R() * 0.3, 'go', { x: d.b.x + (hole[0] - d.b.x) * 0.3, y: fwd(L0, 5 + R() * 2), eff: 0.7 });
      });
      // receivers block the corners, the tight end the edge
      K.recv.forEach((a) => {
        if (a === carrier) return;
        const foe = nearest(K.def.filter((d) => d.label === 'CB' || d.label === 'S'), here(a));
        if (a.label === 'TE' || !foe) leg(a, REACT_OFF, 'go', { x: a.b.x + sg * 0.8, y: fwd(L0, 1), eff: 0.6 });
        else leg(a, REACT_OFF, 'chase', { who: foe.b, gap: 1.0, eff: 0.75, lead: 0.3 });
      });
      if (K.rb && K.rb !== carrier && carrier === qb) leg(K.rb, REACT_OFF, 'go', { x: hole[0] - sg * 1.5, y: fwd(L0, 0.5), eff: 0.8 });
      const Lend = e.td ? tdL() : inL(fwd(L0, e.yards));
      const xEnd = e.oob ? sidelineX(sg ? (sg > 0 ? FW : 0) : hole[0]) : inX(hole[0] + sg * Math.min(9, Math.abs(e.yards) * 0.5) + jit(3));
      const tEnd = runDown(carrier, Math.max(tLos - 0.15, tMesh + 0.2), [xEnd, Lend], { td: e.td, oob: e.oob, bt: e.bt, eff: 0.95, after: e.yards < 2 ? 0.8 + R() : undefined });
      finish(carrier, tEnd, [xEnd, Lend]);
    }

    // ---- the sack: the rush gets home as he looks for someone
    function sack() {
      if (!qb) return;
      snapToQb();
      busy.add(qb);
      ring(T_SNAP, qb);
      const tS = clip(e.dur ? e.dur - 0.6 : 3.0, 2.2, 4.4) + jit(0.25);
      const q0 = here(qb), drop = [q0[0] + jit(0.3), fwd(L0, -7.3)];
      follow(qb, T_SNAP, plan(qb, [q0, drop], { eff: 0.5, v1: 0 }));
      const nRush = e.rushers || (e.look && e.look.blitz ? 5 : 4);
      const rushers = rushersOf(nRush);
      lineplay('pass', sc.s * dir, rushers.filter((d) => K.rush.includes(d)));
      const side = sc.s * dir || 1;
      passShape({ kind: 'deep', tgt: null, catchPt: [BX, fwd(L0, 10)], tThrow: tS + 1, tCatch: tS + 2, rushers, shell: shellOf(), side, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
      rushers.filter((d) => !K.rush.includes(d)).forEach((d, i) => leg(d, REACT_DEF + 0.1, 'chase', { who: qb.b, gap: 1.8 + i * 0.6, eff: 0.95 }));
      const Lend = inL(fwd(L0, e.yards)), spot = [inX(drop[0] + jit(1.5)), Lend];
      // he feels it and moves, then goes down where the play ended
      const tMove = Math.max(T_SNAP + 1.4, tS - 0.7);
      Wd.run(tMove);
      runFrom(qb, tMove, [spot], { T: tS - tMove, v1: 0 });
      const rusher = nearest(e.look && e.look.blitz ? rushers : K.rush.length ? K.rush : rushers, here(qb)) || K.def[0];
      busy.add(rusher);
      // he sheds his block when he has to, to get to the passer as he goes down (at 85% of flat out)
      const rp0 = here(rusher), need = Motion.minTime([rp0, spot], rusher.b.g, { spd: rusher.b.spd });
      const tGo = clip(tS - need / 0.85, tMove, tS - 0.3);
      Wd.run(tGo);
      const rp = here(rusher), [ux, uy] = unit(spot[0] - rp[0], spot[1] - rp[1]);
      runFrom(rusher, tGo, [[spot[0] - ux * 0.8, spot[1] - uy * 0.8]], { T: tS + 0.05 - tGo });
      leg(rusher, tS + 0.05, 'stick', { who: qb.b, dx: -ux * 0.8, dy: -uy * 0.8, ease: 0.15 });
      leg(rusher, tS + 0.5, 'stand');
      leg(qb, tS + 0.4, 'stand');
      say(tS, e.evt === 'strip_sack' ? 'Strip-sack!' : 'Sacked!', 'hit', { follow: qb });
      down(tS + 0.35, qb);
      let t = tS + 0.35;
      Wd.run(t);
      if (e.evt === 'strip_sack' || e.evt === 'sack_fumble') {
        const f = [inX(spot[0] + jit(3)), Lend - dir * 1.4];
        fly(tS, tS + 0.55, px(spot[0]), spot[1], px(f[0]), f[1], 0.2);
        rest(tS + 0.55, px(f[0]), f[1]);
        const rec = e.evt === 'strip_sack' ? nearest(rushers.filter((d) => d !== rusher), f) || rusher : nearest(K.ol, f);
        if (rec) { busy.add(rec); runFrom(rec, tS + 0.1, [f], { T: 0.6, v1: 0 }); hold(tS + 0.72, rec); leg(rec, tS + 0.75, 'stand'); }
        say(tS + 0.7, e.evt === 'strip_sack' ? `${defName} ball` : 'Fumble: recovered', e.evt === 'strip_sack' ? 'hit' : 'info', { slot: 1, follow: rec || qb });
        t = tS + 0.85;
      }
      if (e.safety) say(tS + 0.35, 'Safety!', 'hit', { slot: 1, follow: qb });
      whistle(tS + 0.3, spot);
      lastEnd(t + 1.1);
    }

    // ---- the scramble: nothing open, the pocket breaks, he takes off
    function scramble() {
      if (!qb) return;
      snapToQb();
      busy.add(qb);
      ring(T_SNAP, qb);
      const side = R() < 0.5 ? -1 : 1, tE = 2.3 + R() * 0.8;
      const q0 = here(qb);
      follow(qb, T_SNAP, plan(qb, [q0, [q0[0], fwd(L0, -7.2)]], { eff: 0.5, v1: 0 }));
      const rushers = rushersOf(e.rushers || 4);
      lineplay('pass', side, rushers.filter((d) => K.rush.includes(d)));
      passShape({ kind: 'deep', tgt: null, catchPt: [BX, fwd(L0, 10)], tThrow: tE + 1.5, tCatch: tE + 2.5, rushers, shell: shellOf(), side, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
      Wd.run(tE);
      const Lend = e.td ? tdL() : inL(fwd(L0, e.yards));
      const esc = [inX(here(qb)[0] + side * 6), fwd(L0, -6)];
      runFrom(qb, tE, [esc], { eff: 0.9, v1: 5 });
      say(tE, 'Scramble!', 'boom', { follow: qb });
      const xEnd = e.oob ? sidelineX(esc[0] + side * 10) : inX(esc[0] + side * (4 + R() * 6));
      const tOut = tE + Motion.minTime([here(qb), esc], 'QB', { v0: vel(qb) }) * 1.05;
      const tEnd = runDown(qb, tOut, [xEnd, Lend], { td: e.td, oob: e.oob, eff: 0.9, after: e.slide ? 0 : undefined });
      finish(qb, tEnd, [xEnd, Lend]);
    }

    // ---- a flag: the yellow flag lands near the line, then stays with the camera
    function flag(tFlag, text) {
      const g = S('g', { class: 'flagmark' }), fx = clampX(bx + jit(30)), fL = fwd(L0, 1 + Math.abs(jit(3)));
      g.append(S('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5, transform: 'rotate(18)' }));
      fxAt(tFlag, () => {
        sc.callLayer.before(g);
        sc.parts.push((Y) => g.setAttribute('transform', `translate(${fx.toFixed(1)},${Y(fL).toFixed(1)})`));
      });
      say(tFlag, text, 'flag');
    }

    // ---- bake: run the world to the end and hand every actor its track
    function bake(T) {
      Wd.run(T);
      sc.actors.forEach((a) => {
        const b = a.b, n = b.hx.length;
        a.trk = { dt: Wd.dt, n, x: Float32Array.from(b.hx, px), L: Float32Array.from(b.hy), w0: a.w0 ?? 1, wt: snapAt, hold: frozen };
      });
    }

    if (e.ev === 'play') {
      const c = e.call >= 0 ? idx.calls[e.call] : null;
      const id = c ? c.id : '';
      const sign = !c || !c.side || c.side === 'middle' ? 0 : (c.side === 'strong' ? 1 : -1) * sc.s * dir;
      if (e.penalty && (PRE_SNAP.has(e.pen) || !(e.dur > 0))) {     // a flag before the snap: one man jumps, nobody else moves
        frozen = true;
        const jumper = /Offside|Encroachment|Neutral Zone/.test(e.pen || '') ? nearest(K.rush, [BX, L0]) : nearest(K.ol, [BX, L0]);
        if (jumper) {
          const j0 = here(jumper);
          leg(jumper, 0.1, 'go', { x: j0[0], y: j0[1] + (jumper.off ? dir : -dir) * 1.1, eff: 0.8 });
          leg(jumper, 0.55, 'go', { x: j0[0], y: j0[1], eff: 0.5 });
        }
        flag(0.3, `Flag: ${e.pen || 'penalty'}`);
        P.T = 1.5;
      } else if (e.evt === 'bad_snap') {
        const l = [inX(BX + 1.4), fwd(L0, -9)];
        fly(0, 0.55, bx, L0, px(l[0]), l[1], 0.05);
        rest(0.55, px(l[0]), l[1]);
        say(0.5, 'Bad snap!', 'hit', { x: px(l[0]), L: l[1] });
        lineplay('pass', 0, K.rush);
        const rec = e.turnover ? nearest(K.rush.concat(K.def), l) : qb;
        if (rec) {
          busy.add(rec);
          follow(rec, 0.3, plan(rec, [here(rec), l], { T: 0.75, v1: 0 }));
          hold(1.07, rec);
          if (rec === qb && qb) { Wd.run(1.1); runFrom(qb, 1.1, [[inX(l[0] + jit(2)), inL(fwd(L0, e.yards))]], { eff: 0.8, v1: 0 }); }
        }
        say(1.2, e.turnover ? `${defName} ball` : 'Recovered', e.turnover ? 'hit' : 'info', { slot: 1, follow: rec || qb });
        Wd.run(1.3);
        whistle(1.9, l);
        P.T = 3.0;
      } else if (e.kind === SPIKE) {
        snapToQb();
        if (qb) {
          leg(qb, T_SNAP + 0.1, 'go', { x: qb.b.x, y: fwd(qb.b.y, 0.6), eff: 0.4 });
          fly(0.7, 0.85, qb.x0 + 4, qb.L0, qb.x0 + 4, fwd(qb.L0, 1.3), 0.05);
          rest(0.85, qb.x0 + 4, fwd(qb.L0, 1.3));
          say(0.75, 'Spike', 'info', { follow: qb });
        }
        K.ol.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 0.5), eff: 0.4 }));
        K.rush.forEach((a) => leg(a, REACT_DEF, 'go', { x: a.b.x, y: fwd(a.b.y, -0.3), eff: 0.4 }));
        K.recv.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 2 + R() * 2), eff: 0.4 }));
        whistle(0.9, null);
        P.T = 1.9;
      } else if (e.kind === KNEEL) {
        snapToQb();
        if (qb) { leg(qb, T_SNAP, 'go', { x: qb.b.x, y: fwd(qb.b.y, -1), eff: 0.35 }); down(0.85, qb); say(0.85, 'Kneel', 'info', { follow: qb }); }
        K.ol.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 0.3), eff: 0.3 }));
        K.def.forEach((a) => leg(a, REACT_DEF + R() * 0.3, 'go', { x: a.b.x, y: fwd(a.b.y, -0.6), eff: 0.25 }));
        P.T = 2.0;
      } else if (e.penalty) {                                    // a flag during the play: it is called back
        snapToQb();
        const passing = e.kind === PASS;
        if (passing && qb) {
          follow(qb, T_SNAP, plan(qb, [here(qb), [qb.b.x, fwd(L0, -7.2)]], { eff: 0.5, v1: 0 }));
          const rushers = rushersOf(4);
          lineplay('pass', sc.s * dir, rushers);
          passShape({ kind: 'quick', tgt: null, catchPt: [BX, fwd(L0, 8)], tThrow: 3, tCatch: 3.6, rushers, shell: shellOf(), side: sc.s * dir || 1, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
        } else {
          lineplay('run', sign || 0, K.rush);
          if (K.rb) follow(K.rb, REACT_OFF, plan(K.rb, [here(K.rb), [BX + (sign || 0) * 2, fwd(L0, -1)]], { eff: 0.7, v1: 2 }));
        }
        Wd.run(1.9);
        flag(1.9, `Flag: ${e.pen || 'penalty'}`);
        whistle(2.2, [BX, L0]);
        P.T = 3.4;
      } else if (['sack', 'strip_sack', 'sack_fumble'].includes(e.evt)) sack();
      else if (e.evt === 'scramble') scramble();
      else {
        const thrown = e.air !== undefined || e.incomplete || ['interception', 'pick_six', 'drop', 'near_pick', 'throwaway'].includes(e.evt);
        if (e.kind === PASS && (thrown || !['rpo_strong', 'rpo_weak', 'trick'].includes(id))) pass(c, id, sign);
        else run(c, id, sign);
      }
      bake(P.T + 0.2);
    } else if (e.ev === 'fg' || (e.ev === 'pat' && !two)) {
      specialKick();
    } else if (e.ev === 'punt') {
      punt();
    } else if (e.ev === 'kickoff') {
      kickoff();
    } else return null;
    return finishCamera();

    // ---- special teams
    function specialKick() {
      // field-goal formation: holder 7 yards deep, kicker behind him, nine shoulder to shoulder; the snap at T0
      const T0 = 0.8, hL = fwd(L0, -7), Ly = dir > 0 ? 110 : -10;
      const holder = qb || K.off[0], kicker = K.rb || K.off.find((a) => a !== holder);
      const line = K.off.filter((a) => a !== holder && a !== kicker);
      const go = (a, t, x, y, eff) => leg(a, t, 'go', { x: yx(x), y, eff: eff ?? 0.8 });
      line.forEach((a, i) => go(a, 0, clampX(bx + (i - (line.length - 1) / 2) * 15), fwd(L0, -0.3), 0.6));
      go(holder, 0, bx, hL, 0.6);
      if (kicker) go(kicker, 0, bx - 10, fwd(L0, -9.5), 0.6);
      const deepD = K.def.filter((a) => a.label === 'S').slice(0, 1), front = K.def.filter((a) => !deepD.includes(a));
      front.forEach((a, i) => go(a, 0, clampX(bx + (i - (front.length - 1) / 2) * 15), fwd(L0, 0.3), 0.6));
      deepD.forEach((a) => go(a, 0, bx, fwd(L0, 12), 0.6));
      fly(T0, T0 + 0.4, bx, L0, bx, hL, 0.1);
      rest(T0 + 0.4, bx, hL);
      if (kicker) leg(kicker, T0 + 0.35, 'go', { x: yx(bx) - 0.4, y: fwd(L0, -7.6), eff: 0.55 });
      const good = e.ev === 'fg' ? e.made : e.good;
      const miss = good ? 0 : (R() < 0.5 ? -1 : 1);
      const tK = T0 + 1.3, t1 = tK + 0.25 + Math.abs(Ly - hL) / 24;
      fly(tK, t1, bx, hL, 180 + miss * 34, Ly, 2.4);
      rest(t1, 180 + miss * 38, Ly + dir * 1.5);
      // the rush: the front pushes into the line, the line holds
      front.forEach((a) => leg(a, T0 + 0.15, 'go', { x: a.b.x + jit(0.6), y: fwd(L0, -0.6), eff: 0.9 }));
      line.forEach((a) => leg(a, T0 + 0.1, 'go', { x: a.b.x, y: fwd(L0, -0.9), eff: 0.7 }));
      if (kicker) leg(kicker, tK + 0.1, 'go', { x: yx(bx), y: fwd(L0, -5.5), eff: 0.4 });
      say(t1, good ? "It's good!" : 'No good', good ? 'good' : 'hit', { x: 180, L: Ly - dir * 6 });
      // the formation shift happens before the snap: start the clock of the play there
      P.T = t1 + 0.7;
      frozen = false; snapAt = T0;
      bakeSpecial(P.T + 0.2);
    }
    function bakeSpecial(T) {
      Wd.run(T);
      sc.actors.forEach((a) => {
        const b = a.b;
        a.trk = { dt: Wd.dt, n: b.hx.length, x: Float32Array.from(b.hx, px), L: Float32Array.from(b.hy), w0: a.w0 ?? 1, wt: snapAt, hold: false };
      });
    }

    function punt() {
      // punt formation: seven on the line, gunners split wide, an up-back, the punter 14 yards deep;
      // the return team: two jammers on the gunners, a returner deep, the rest at the line
      const T0 = 0.8, pL = fwd(L0, -14), Lnew = clip(losOf(res.root), -9, 109);
      const punter = qb || K.off[0], upback = K.rb && K.rb !== punter ? K.rb : null;
      const gunners = K.recv.filter((a) => a.label === 'WR').slice(0, 2);
      const line = K.off.filter((a) => a !== punter && a !== upback && !gunners.includes(a));
      const lineX = [0, -15, 15, -30, 30, -45, 45, -60, 60];
      const go = (a, t, x, y, eff) => leg(a, t, 'go', { x: yx(x), y, eff: eff ?? 0.7 });
      line.forEach((a, i) => go(a, 0, clampX(bx + lineX[i % lineX.length]), fwd(L0, -0.4)));
      gunners.forEach((a, i) => go(a, 0, i ? SX1 - 20 : SX0 + 20, fwd(L0, -0.4), 0.8));
      go(punter, 0, bx, pL, 0.8);
      if (upback) go(upback, 0, bx + 6, fwd(L0, -5));
      const land = e.touchback ? (dir > 0 ? 104 : -4) : e.retTd ? fwd(pL, 52) : clip(Lnew + dir * 6, -8, 108);
      const lx = clampX(bx + jit(40));
      const ret = K.def.find((a) => a.label === 'S') || K.def.find((a) => a.label === 'CB') || K.def[0];
      const jam = K.def.filter((a) => a.label === 'CB' && a !== ret).slice(0, 2);
      const box = K.def.filter((a) => a !== ret && !jam.includes(a));
      go(ret, 0, clampX(lx + jit(12)), clip(land + dir * 4, -8, 108), 0.9);
      jam.forEach((a, i) => go(a, 0, i ? SX1 - 22 : SX0 + 22, fwd(L0, 1.2), 0.8));
      box.forEach((a, i) => go(a, 0, clampX(bx + lineX[i % lineX.length]), fwd(L0, 0.8)));
      fly(T0, T0 + 0.75, bx, L0, bx, pL, 0.1);
      hold(T0 + 0.75, punter);
      const tK = T0 + 2.0, kL = fwd(pL, 2);       // two steps into the kick
      leg(punter, T0 + 1.1, 'go', { x: yx(bx), y: kL, eff: 0.35 });
      snapAt = T0;
      if (e.blocked) {
        Wd.run(T0 + 0.6);
        const blocker = nearest(box, [yx(bx), pL]) || box[0];
        if (blocker) { busy.add(blocker); runFrom(blocker, T0 + 0.6, [[yx(bx) + 0.5, fwd(pL, 1)]], { T: tK - T0 - 0.6 }); }
        line.forEach((a) => leg(a, T0 + 0.1, 'go', { x: a.b.x + jit(0.4), y: fwd(L0, -1.2), eff: 0.6 }));
        fly(tK, tK + 0.35, bx, kL, bx + jit(20), fwd(pL, -4), 0.2);
        rest(tK + 0.35, bx + jit(20), fwd(pL, -4));
        say(tK + 0.05, 'Blocked!', 'hit', { x: bx, L: pL });
        whistle(tK + 0.6, [yx(bx), pL]);
        P.T = tK + 1.4;
        bakeSpecial(P.T + 0.2);
        return;
      }
      const tL = tK + 4.3;
      fly(tK, tL, bx, kL, lx, land, 2.8);
      // coverage: the gunners release at the snap and run under it; the line blocks a beat, then releases
      const LX = yx(lx);
      gunners.forEach((a, i) => leg(a, T0 + 0.1, 'go', { x: LX + (i ? 2.5 : -2.5), y: land - dir * 5, eff: 0.97, stop: false }));
      jam.forEach((a, i) => leg(a, T0 + 0.2, 'mirror', { who: gunners[i] ? gunners[i].b : a.b, lag: 0.25, dx: 0, dy: -dir * 1.0, eff: 0.95 }));
      line.forEach((a, i) => { leg(a, T0 + 0.1, 'go', { x: a.b.x, y: fwd(L0, -1), eff: 0.5 }); leg(a, T0 + 1.5, 'go', { x: LX + (i - 3) * 2.2, y: lerp(L0, land, 0.6), eff: 0.85 }); });
      box.forEach((a) => { leg(a, T0 + 0.2, 'go', { x: a.b.x, y: fwd(L0, -0.4), eff: 0.6 }); leg(a, T0 + 1.6, 'go', { x: a.b.x * 0.5 + LX * 0.5, y: lerp(L0, land, 0.7), eff: 0.75 }); });
      leg(punter, tK + 0.3, 'go', { x: yx(bx), y: fwd(pL, 6), eff: 0.4 });
      const retSpot = [LX, land];
      runFrom(ret, tL - 1.6, [retSpot], { T: 1.5, v1: 0, eff: 0.6 });
      let t = tL;
      if (!e.touchback) {
        hold(tL, ret);
        ring(tL, ret);
        const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew, xr = inX(LX + jit(5));
        Wd.run(tL);
        const tEnd = runDown(ret, tL + 0.25, [xr, Lr], { td: e.retTd, after: 0.8 });
        if (!e.retTd) down(tEnd + 0.08, ret);
        t = tEnd;
      } else {
        rest(tL, lx, land);
        whistle(tL + 0.2, retSpot);
      }
      say(t, e.retTd ? 'Punt return touchdown!' : e.touchback ? 'Touchback' : `Punt · net ${Math.round(e.net || 0)}`, e.retTd ? 'hit' : 'info',
        { x: 180, L: e.retTd ? (dir > 0 ? 4 : 96) : Lnew });
      P.T = Math.max(P.T, t + 1.0);
      bakeSpecial(P.T + 0.2);
    }

    function kickoff() {
      const Lnew = clip(losOf(res.root), -9, 109);
      const kick = sc.actors.filter((a) => a.off), recv = sc.actors.filter((a) => !a.off);
      const kicker = kick.find((a) => a.label === 'K'), cover = kick.filter((a) => a !== kicker);
      const deep = recv.filter((a) => a.label === 'KR'), front = recv.filter((a) => a.label !== 'KR');
      const goal = dir > 0 ? 100 : 0;
      if (e.onside) {
        // an onside kick: everyone bunches at the ball, the hands team 10-12 yards away
        cover.forEach((a, i) => leg(a, 0, 'go', { x: yx(clampX(bx + (i - 4.5) * 26)), y: fwd(L0, -1), eff: 0.7 }));
        recv.forEach((a, i) => leg(a, 0, 'go', { x: yx(clampX(bx + (i - 5) * 26)), y: fwd(L0, 12 + (i % 2) * 4), eff: 0.8 }));
        if (kicker) leg(kicker, 0.4, 'go', { x: BX, y: fwd(L0, -0.5), eff: 0.6 });
        const l = [inX(BX + jit(4)), fwd(L0, 11)];
        fly(1.15, 2.4, bx, L0, px(l[0]), l[1], 0.25);
        rest(2.4, px(l[0]), l[1]);
        const ours = e.recovered;
        Wd.run(1.15);
        cover.forEach((a) => leg(a, 1.2, 'go', { x: a.b.x + (l[0] - a.b.x) * 0.6, y: a.b.y + (l[1] - a.b.y) * 0.85, eff: 0.95 }));
        front.forEach((a) => leg(a, 1.3, 'go', { x: a.b.x + (l[0] - a.b.x) * 0.5, y: a.b.y + (l[1] - a.b.y) * 0.6, eff: 0.9 }));
        const rec = nearest(ours ? cover : recv, l);
        if (rec) { busy.add(rec); runFrom(rec, 1.3, [l], { T: 1.25, v1: 0 }); hold(2.6, rec); leg(rec, 2.6, 'stand'); }
        say(2.6, ours ? 'Onside kick recovered!' : 'Onside kick: they recover', ours === (e.team === G.me) ? 'good' : 'hit', { x: px(l[0]), L: l[1] });
        whistle(2.7, l);
        P.T = 3.8;
        bakeSpecial(P.T + 0.2);
        return;
      }
      // the kick hangs about four seconds; nobody but the returners moves until it lands or is caught (2024 rules)
      if (kicker) leg(kicker, 0.1, 'go', { x: BX, y: fwd(L0, -0.3), eff: 0.7 });
      const stay = (a, t) => leg(a, t, 'stand');
      cover.concat(front).forEach((a) => stay(a, 0));
      if (e.tb) {          // no return: through the end zone, bounced in from the landing zone, or short of it
        const short = Math.round(res.root.yl) === 60 && res.root.pos !== e.team;
        const through = e.kick === 'touchback' || Math.round(res.root.yl) === 65;
        const lx = clampX(180 + jit(30));
        const land = short ? goal - dir * 24 : through ? goal + dir * 7 : goal - dir * 6;
        const tL = through ? 4.2 : 4.4;
        fly(0.7, tL, bx, L0, lx, land, through ? 3.2 : 3);
        if (!through && !short) { fly(tL, tL + 1.2, lx, land, clampX(lx + jit(16)), goal + dir * 4, 0.15); }
        rest(through ? tL : tL + (short ? 0 : 1.2), lx, short ? land : goal + dir * (through ? 7 : 4));
        const ret = nearest(deep, [yx(lx), land]) || deep[0];
        if (ret) leg(ret, 1.2, 'go', { x: yx(lx) + jit(1.5), y: short ? land - dir * 1 : goal - dir * 2, eff: 0.75 });
        // once it lands the coverage runs down, then eases up
        cover.forEach((a) => { leg(a, tL + 0.1, 'go', { x: a.b.x + jit(2), y: fwd(a.b.y, 6 + R() * 4), eff: 0.6 }); leg(a, tL + 1.6, 'stand'); });
        front.forEach((a) => { leg(a, tL + 0.2, 'go', { x: a.b.x, y: fwd(a.b.y, 2), eff: 0.4 }); leg(a, tL + 1.2, 'stand'); });
        say(tL + (through || short ? 0.2 : 1.3), short ? 'Short of the landing zone' : 'Touchback', 'info', { x: 180, L: goal - dir * 10 });
        P.T = tL + (through || short ? 1.4 : 2.2);
        bakeSpecial(P.T + 0.2);
        return;
      }
      const land = dir > 0 ? 97 : 3, lx = clampX(180 + jit(40)), tL = 4.6, LX = yx(lx);
      fly(0.7, tL, bx, L0, lx, land, 3);
      const ret = nearest(deep, [LX, land]) || deep[0];
      const lead = deep.find((a) => a !== ret);
      if (ret) follow(ret, 1.0, plan(ret, [here(ret), [LX, land]], { T: tL - 1.0, v1: 0, eff: 0.7 }));
      if (lead) leg(lead, 1.6, 'go', { x: LX + 4, y: land + dir * 7, eff: 0.6 });
      // the ball comes down: the coverage sprints, the setup zone turns and blocks
      cover.forEach((a) => leg(a, tL - 0.1 + R() * 0.2, 'go', { x: a.b.x + (LX - a.b.x) * 0.55, y: lerp(a.b.y, land, 0.7), eff: 0.95, stop: false }));
      front.forEach((a, i) => {
        const foe = cover[i % Math.max(1, cover.length)];
        leg(a, tL - 0.2, 'chase', { who: foe.b, gap: 1.0, eff: 0.8, lead: 0.5 });
      });
      if (ret) {
        hold(tL, ret);
        ring(tL, ret);
        const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew, xr = inX(LX + jit(6));
        Wd.run(tL);
        const tEnd = runDown(ret, tL + 0.2, [xr, Lr], { td: e.retTd, after: 0.8 });
        if (!e.retTd) down(tEnd + 0.08, ret);
        say(tEnd, e.retTd ? 'Kick return touchdown!' : `${teamName(code(res.root.pos))} ball at ${spotText(res.root)}`,
          e.retTd ? (e.team === G.me ? 'hit' : 'good') : 'info', { x: 180, L: Lr });
        P.T = tEnd + 1.1;
      } else P.T = tL + 1.5;
      bakeSpecial(P.T + 0.2);
    }

    // the camera: the ball and whoever has it, and everyone within 12 yards of that, with room around it
    function finishCamera() {
      const ballLs = [L0], segs = P.segs.slice().sort((a, b) => a.t0 - b.t0);
      segs.forEach((s, i) => {
        if (s.kind === 'fly') ballLs.push(s.L0, s.L1);
        else if (s.kind === 'rest') ballLs.push(s.L);
        else if (s.kind === 'hold' && s.a.trk) {
          const k = s.a.trk, t1 = i + 1 < segs.length ? segs[i + 1].t0 : P.T;
          for (let j = Math.floor(s.t0 / k.dt); j <= Math.min(k.n - 1, Math.ceil(t1 / k.dt)); j += 2) ballLs.push(k.L[j]);
        }
      });
      const blo = Math.min(...ballLs) - 12, bhi = Math.max(...ballLs) + 12, Ls = ballLs.slice();
      sc.actors.forEach((a) => {
        const k = a.trk;
        if (!k) return;
        const n = Math.min(k.n, Math.ceil(P.T / k.dt) + 1);
        for (let i = 0; i < n; i += 4) Ls.push(clip(k.L[i], blo, bhi));
      });
      let lo = Math.min(...Ls) - 5, hi = Math.max(...Ls) + 5;
      const span = clip(hi - lo, 36, 120), mid = (lo + hi) / 2;
      lo = mid - span / 2; hi = mid + span / 2;
      if (lo < -10) { hi += -10 - lo; lo = -10; }
      if (hi > 110) { lo -= hi - 110; hi = 110; }
      P.cam = { lo: Math.max(lo, -10), hi: Math.min(hi, 110) };
      P.segs.sort((a, b) => a.t0 - b.t0);
      return P;
    }
  }

  // clk: the game clock before the step (t0), at the snap and after the play; the time that runs off before
  // the snap ticks away first (fast, while the players set), then the play's own time as it is run
  function runPlan(sc, P, speed, clk) {
    const runoff = clk ? Math.max(0, clk.t0 - clk.snap) : 0;
    const PRE = runoff >= 1 ? clip(0.4 + runoff / 30, 0.55, 1.5) : 0;
    const ZI = 0.6, ZO = 0.5, total = PRE + ZI + P.T + P.hold + ZO;
    const ck = clk ? document.querySelector('#bar .clk') : null;
    return new Promise((resolve) => {
      let start = null, skip = false;
      const onTap = () => { skip = true; };
      sc.calls.forEach((c) => c.g.remove());        // a pre-play label ("Kickoff") gives way to the play's own call-outs
      sc.calls = [];
      sc.svg.classList.add('playing');
      sc.svg.addEventListener('click', onTap);
      const frame = (now) => {
        if (start === null) start = now;
        const t = skip ? total : ((now - start) / 1000) * speed, tt = t - PRE;
        const k = EASE.io(clip(tt / ZI, 0, 1)) * (1 - EASE.io(clip((tt - ZI - P.T - P.hold) / ZO, 0, 1)));
        sc.cam = { lo: lerp(FULL.lo, P.cam.lo, k), hi: lerp(FULL.hi, P.cam.hi, k) };
        const tp = clip(tt - ZI, 0, P.T);
        if (ck) {
          const gt = t < PRE ? lerp(clk.t0, clk.snap, EASE.io(t / PRE)) : lerp(clk.snap, clk.end, clip((tt - ZI) / (P.T + P.hold), 0, 1));
          ck.textContent = clockOf(Math.max(gt, clk.end)).text;
          ck.classList.toggle('tick', t < PRE);
        }
        sc.actors.forEach((a) => { const p = at(a, tp); a.x = p.x; a.L = p.L; a.w = p.w; });
        Object.assign(sc.ball, ballAt(sc, P, tp));
        P.calls.forEach((c) => { if (!c.shown && tp >= c.t) { c.shown = true; showCall(sc, c); } });
        P.fx.forEach((f) => { if (!f.done && tp >= f.t) { f.done = true; f.f(); } });
        place(sc);
        if (t >= total) {
          sc.svg.removeEventListener('click', onTap);
          sc.svg.classList.remove('playing');
          if (ck) ck.classList.remove('tick');
          resolve();
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  // play one snap on the field: `before` is the state it was snapped from, `side` its strong side
  async function animatePlay(before, res, side, replay, look) {
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
        sc = makeScene(before, side, look);
        P = choreograph(sc, e, res, false);
      }
    } catch (err) { console.warn('animation skipped:', err); P = null; }
    scene = sc;
    if (!P) return false;
    // the clock at the snap: after the runoff, or after a timeout called before it (a kick to win), else as it was
    const k0 = res.log.findIndex((x) => x.ev !== 'runoff' && x.ev !== 'timeout');
    const pre = k0 < 0 ? res.log : res.log.slice(0, k0), ro = pre.find((x) => x.ev === 'runoff');
    const tos = pre.filter((x) => x.ev === 'timeout'), snapT = ro ? ro.t : tos.length ? tos[tos.length - 1].t : before.t;
    const clk = { t0: before.t, snap: snapT, end: Math.min(res.root.t, snapT) };
    await runPlan(sc, P, PLAY_SPEED, clk);
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
      what = `${c.id === 'trick' ? `The ${who} run a trick play` : `${actor || `The ${who}`} ${c.say}`}${e.row >= 0 ? lookText(e.look) : ''}`;
    } else what = `${nm.qb || who} ${e.kind === RUN ? 'hands off' : 'drops back'}`;
    const y = Math.round(e.td && !e.turnover ? e.yl : e.yards);      // a touchdown gains the distance to the goal line
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
          e.retTd ? 'Kickoff returned for a touchdown' : `Kickoff${e.tb ? (Math.round(e.yl) === 60 ? ', short of the landing zone' : ', touchback') : ''}: the ${teamName(code(1 - e.team))} start at their own ${Math.round(100 - e.yl)}`; break;
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
    if (e.ev === 'kickoff') return e.onside ? (e.recovered ? 'Onside kick recovered' : 'Onside kick: they recover') : e.retTd ? 'Returned for a touchdown'
      : e.tb ? (Math.round(e.yl) === 60 ? 'Short kick: ball at the 40' : 'Touchback') : 'Kickoff';
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
  // the real game a spot comes from: "2023 · Week 14" or "2024 · Divisional Round"
  const ROUND = { WC: 'Wild Card Round', DIV: 'Divisional Round', CON: 'Conference Championship', SB: 'Super Bowl' };
  function gameTag(sc) {
    const rl = sc.real || {};
    return `${rl.season} · ${ROUND[rl.type] || `Week ${rl.week}`}`;
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
    box.append(el('div', 'cat', `Spot ${G.si + 1} of 3 · ${idx.categories[sc.category]}`),
      el('div', 'game', `${gameTag(sc)} · ${teamName(sc.away)} at ${teamName(sc.home)}`), big);
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
    const rc = (sc.real || {}).coach;
    box.append(el('div', 'who', `You're calling it for the ${teamName(me)}.${rc ? ` Can you do better than ${rc} did?` : ''}`));
    const go = el('button', 'btn', 'Next');
    go.type = 'button';
    go.addEventListener('click', () => { G.started = true; persist(); enterField(); });
    box.append(go);
    const rl = sc.real || {};
    box.append(el('div', 'from', `The real score, clock, ball and timeouts from that game, with the players who were on the field and how good they were that week.`));
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
      if (r.pos === G.me) G.autoDef = false;
      if (r.phase === SNAP && r.pos === G.me) return promptOffense();
      if (r.phase === SNAP && !G.autoDef) return promptDefense();
      if (r.phase === PAT && r.pos === G.me) return promptChoice('pat');
      if (r.phase === KICKOFF && r.pos === G.me && !r.free_kick) return promptChoice('kick');
      if (r.phase === KICKOFF && r.pos === G.me && r.free_kick && kickChoice(r)) return promptChoice('freekick');
      if (r.phase === SNAP && r.pos !== G.me && r.clock_running && r.to[G.me] > 0 && defChoice(r)) return promptChoice('deftime');
      if (G.banner) {             // your last result, before their plays run
        const b = G.banner, d = $('dock'), btn = el('button', 'btn', 'Next play');
        G.banner = null;
        btn.type = 'button';
        btn.addEventListener('click', () => { if (!busy) advance(); });
        b.append(btn);
        d.textContent = '';
        d.append(b);
        return;
      }
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
    const pe = res.log.find((x) => x.ev === 'play');
    const look = before.pos === G.me ? G.look : action && action.def && pe && pe.look && pe.look.box ? (pe.look.box >= 7 ? 2 : 0) + (pe.look.blitz ? 1 : 0) : null;
    G.lastPlay = { before, res, side, look };
    res.animated = await animatePlay(before, res, side, false, look);
    G.look = null;
    return res;
  }
  async function replay() {
    const lp = G.lastPlay;
    if (busy || !lp) return;
    busy = true;
    try { await animatePlay(lp.before, lp.res, lp.side, true, lp.look); } finally { busy = false; drawBar(); drawField(); }
  }

  // your ball: Run / Pass / RPO, plus a timeout, spike, kneel or kick when it matters
  async function promptOffense() {
    const r = G.root;
    status('Breaking the huddle…');
    G.info = (await send({ type: 'info', scen: simScen(), root: r })).info;
    G.fast = false;
    G.look = pickLook(G.info.looks, hash('look', dayN, G.si, G.seq));
    ui = { step: 'family', fam: null, oob: false, tempo: tempoKeyOf(G.info.tempo) };
    drawField();
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
    const keys = TEMPOS.slice();
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
    takeBanner(d);
    const head = el('div', 'ask');
    d.append(head);
    if (ui.step === 'family') {
      head.append(el('h2', '', 'Your call'), el('span', 'sub', `${ddText(r)} · ${spotText(r)}`));
      if (G.look != null) d.append(readLine(G.look));
      if (r.clock_running) d.append(tempoPicker(r));
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
        clockOptions(r).filter((k) => !TEMPOS.includes(k)).forEach((k) => extra.push([k, CLOCK[k].label, k === 'timeout' ? `${r.to[me]} left` : null]));
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
    if (r.clock_running) head.append(el('span', 'sub', CLOCK[ui.tempo].short));
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

  // how fast to get to the next snap while the clock runs: no-huddle, huddle or milk it
  // the defense's look before your call: real plays of your call against this look decide the snap
  function pickLook(p, seed) {
    if (!p) return null;
    const u = rng(seed)();
    let acc = 0;
    for (let b = 0; b < p.length; b++) { acc += p[b]; if (u <= acc) return b; }
    return p.length - 1;
  }
  function readLine(b) {
    const L = LOOKS[b], w = el('div', 'read');
    w.append(el('span', 'lab', 'Defense'));
    const v = el('div', 'v');
    v.append(el('b', '', L.loaded ? 'Loaded box' : 'Light box'));
    if (L.blitz) v.append(el('b', 'blitz', 'Showing blitz'));
    v.append(el('small', '', L.loaded ? '7 or more near the line' : '6 or fewer near the line'));
    w.append(v);
    return w;
  }
  function tempoPicker(r) {
    const w = el('div', 'tempo');
    w.append(el('span', 'lab', 'Tempo'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Tempo: how much clock runs before the snap');
    TEMPOS.forEach((k) => {
      const b = el('button', 'segb');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      const secs = tempoSecs(k, r);
      b.append(el('b', '', CLOCK[k].short), el('small', '', secs ? `about ${Math.round(secs)} s` : ''));
      const mark = () => seg.querySelectorAll('.segb').forEach((x, i) => {
        x.classList.toggle('on', TEMPOS[i] === ui.tempo); x.setAttribute('aria-checked', String(TEMPOS[i] === ui.tempo));
      });
      b.addEventListener('click', () => { if (!busy) { ui.tempo = k; mark(); } });
      seg.append(b);
      if (k === TEMPOS[TEMPOS.length - 1]) requestAnimationFrame(mark);
    });
    w.append(seg);
    return w;
  }

  function situation(r) { return `${clockOf(r.t).text} Q${clockOf(r.t).q}, ${ddText(r)} ${onSpot(r)}`; }
  async function clockDecision(r, chosen) {
    const me = G.me, lead = r.score[me] - r.score[1 - me];
    const opts = clockOptions(r).map((k) => ({ key: k, label: CLOCK[k].label, action: clockAct(k, r) }));
    status('Simulating every clock option 600 times…');
    const vals = await evaluate(r, opts, hash('clock', dayN, G.si, G.seq));
    let q = coachProbs('off_clock_stop', r, me);
    if (lead > 0 && r.t <= 1800) q = { play: 0.9, timeout: 0.03, kneel: 0.07 };
    else if (q) q = { play: q.hurry || 0, timeout: q.timeout || 0, spike: q.spike || 0 };
    else q = { play: 0.8, timeout: 0.14, spike: 0.06 };
    q[tempoKeyOf(G.info.tempo)] = q.play;          // snapping it, a typical play-caller goes at the usual tempo here
    delete q.play;
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
  const withTempo = (a) => (G.root.clock_running && ui && ui.tempo ? { ...a, tempo: engineTempo(ui.tempo, G.root) } : a);
  function callAction(id, oob) {
    return withTempo({ to_off: false, play: CALL[id].kind, call: id, oob: !!oob, looks: G.look != null ? 1 << G.look : 0 });
  }
  async function decideCall(pick) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    try {
      const decisions = [];
      if (r.clock_running) decisions.push(await clockDecision(r, ui.tempo));
      const { calls, specials } = callOptions(r);
      const opts = calls.map((id) => ({ key: id, label: CALL[id].label, action: callAction(id, false) }));
      if (pick.call && ui.oob) opts.push({ key: `${pick.call}+oob`, label: `${CALL[pick.call].label}, get out of bounds`, action: callAction(pick.call, true) });
      specials.forEach((k) => opts.push({ key: k, label: specialLabel(k), action: withTempo({ to_off: false, play: k }) }));
      status(`Simulating all ${opts.length} calls 600 times each…`);
      const vals = await evaluate(r, opts, hash('call', dayN, G.si, G.seq));
      const q = {};
      const freq = {}, byLook = G.info.lookByCall;
      G.info.calls.forEach((c, ci) => { freq[c.id] = c.freq * (G.look != null && byLook ? byLook[ci][G.look] : 1); });
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

  // their ball: you call the defense (a timeout first, when it matters); the coordinator can take the drive
  const defTimeoutOk = (r) => r.clock_running && r.to[G.me] > 0 && defChoice(r);
  async function promptDefense() {
    const r = G.root;
    status('Their huddle…');
    G.dinfo = (await send({ type: 'info', scen: simScen(), root: r })).info;
    G.fast = false;
    ui = { step: 'defense', to: false };
    drawDefDock();
  }
  function drawDefDock() {
    const r = G.root, d = $('dock');
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', 'Your defense'), el('span', 'sub', `${teamName(code(r.pos))} ball · ${ddText(r)} · ${spotText(r)}`));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', 3);
    DEFS.forEach((k, i) => {
      const b = key(DEF[k].label, DEF[k].sub, 'big def', i);
      b.addEventListener('click', () => { if (!busy) decideDefense(k); });
      keys.append(b);
    });
    d.append(keys);
    if (defTimeoutOk(r)) {
      const tg = el('div', 'toggle');
      const lab = el('div', 'lab', 'Timeout first');
      lab.append(el('small', '', `Stop the clock before their snap · ${r.to[G.me]} left`));
      const sw = el('button', 'sw2');
      sw.type = 'button'; sw.id = 'toSwitch';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.to)); sw.setAttribute('aria-label', 'Timeout first');
      sw.addEventListener('click', () => { ui.to = !ui.to; sw.setAttribute('aria-checked', String(ui.to)); });
      tg.append(lab, sw);
      d.append(tg);
    }
    const auto = el('button', 'chip', 'Let the coordinator call this drive');
    auto.type = 'button';
    auto.addEventListener('click', () => { if (busy) return; G.autoDef = true; advance(); });
    d.append(auto);
  }
  async function decideDefense(k) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    try {
      const decisions = [], useTo = !!(ui.to && defTimeoutOk(r));
      if (defTimeoutOk(r)) {
        const to = [{ key: 'timeout', label: 'Timeout', action: { to_def: true, def: k } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false, def: k } }];
        status('Simulating both clock options 600 times…');
        const tv = await evaluate(r, to, hash('deftime', dayN, G.si, G.seq));
        decisions.push(decisionFrom('deftime', 'def_timeout', to, tv, useTo ? 'timeout' : 'no_timeout',
          coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 }, situation(r)));
      }
      const opts = DEFS.map((x) => ({ key: x, label: DEF[x].label, action: { to_def: useTo, def: x } }));
      status('Simulating all three defensive calls 600 times each…');
      const vals = await evaluate(r, opts, hash('def', dayN, G.si, G.seq));
      const L = (G.dinfo && G.dinfo.looks) || [0.25, 0.25, 0.25, 0.25];
      decisions.push(decisionFrom('defcall', 'def_call', opts, vals, k, { blitz: L[1] + L[3], load: L[2], soft: L[0] }, situation(r)));
      decisions.forEach((x) => G.decisions.push(x));
      G.snapN += 1;
      status('Snap…', reduced() ? null : 'Tap the field to skip');
      const res = await stepWith(opts.find((o) => o.key === k).action);
      showResult(decisions, res);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // their ball late, your touchdown, your kickoff
  function promptChoice(kind) {
    const r = G.root, me = G.me, d = $('dock'), behind = r.score[me] < r.score[1 - me];
    const spec = {
      deftime: { ask: 'Clock is running', sub: `${teamName(code(r.pos))} ball, ${ddText(r)}`, family: 'def_timeout',
        opts: [{ key: 'timeout', label: 'Timeout', sub: `${r.to[me]} left`, action: { to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false } }],
        q: () => coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 } },
      pat: { ask: 'Touchdown!', sub: 'Kick it or go for two?', family: 'pat',
        opts: [{ key: 'xp', label: 'Kick it', action: { pat: 'xp' } }, { key: 'two', label: 'Go for two', action: { pat: 'two' } }],
        q: () => coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 } },
      // 2025 rules: a touchback off a kickoff comes out to the 35, and only a team that is behind may declare an onside
      // kick; in 2025, 18% of kickoffs were kicked through for the touchback (q)
      kick: { ask: 'Kickoff', sub: behind ? 'Where do you kick it?' : 'Where do you kick it? (Onside only when behind)', family: 'onside',
        opts: [{ key: 'return', label: 'To the returner', sub: 'Make them run it back', action: { kick: 'return' } },
          { key: 'touchback', label: 'Through the end zone', sub: 'Touchback: their 35', action: { kick: 'touchback' } },
          ...(behind ? [{ key: 'onside', label: 'Onside', sub: 'Try to get it back', action: { kick: 'onside' } }] : [])],
        q: () => {
          const on = behind ? (coachProbs('onside', r, me) || { onside: 0.01 }).onside || 0.01 : 0;
          return { ...(behind ? { onside: on } : {}), return: (1 - on) * 0.82, touchback: (1 - on) * 0.18 };
        } },
      freekick: { ask: 'Free kick', sub: 'After the safety: deep or onside?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', spec.ask), el('span', 'sub', spec.sub));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', spec.opts.length);
    spec.opts.forEach((o, i) => {
      const b = key(o.label, o.sub || null, spec.opts.length > 2 || spec.opts.some((x) => x.label.length > 10) ? 'big def' : 'big', i);
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          status(`Simulating ${spec.opts.length > 2 ? 'every option' : 'both options'} 600 times…`);
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
  const KIND_NAME = { clock: 'Clock', call: 'Play call', deftime: 'Timeout', defcall: 'Defense', pat: 'Try', kick: 'Kickoff', freekick: 'Free kick' };
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
    if (G.lastPlay && res.animated) {
      const again = el('button', 'chip replay', '↻ Replay the play');
      again.type = 'button';
      again.addEventListener('click', replay);
      wrap.append(again);
    }
    // no extra tap: the result stays on top of your next call (or the final card); only when their plays come
    // next does it wait for "Next play" (advance)
    d.append(wrap);
    G.banner = wrap;
    advance();
  }
  function takeBanner(d) {
    if (!G.banner) return;
    G.banner.classList.add('banner');
    d.append(G.banner);
    G.banner = null;
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
    if (!G.result || (G.result.half === 1 && G.result.v !== 2)) {      // v2: halftime valued at halftime
      status('Final whistle…');
      const r = G.root;
      // the end of the first half is t = 1800, which the engine reads as the second half (a finished game: any lead
      // a sure win); a hair earlier it values halftime with its win model: score, spread, who gets the ball
      const v = await evaluate(r.t >= 1800 ? { ...r, t: 1800.01 } : r, [{ key: 'end', action: {} }], 1);
      G.result = { wp: v.end, mine: r.score[G.me], theirs: r.score[1 - G.me], half: r.t >= 1800 ? 1 : 2, v: 2 };
      G.over = true;
      persist();
    }
    drawAll();
    const res = G.result, sc = G.scen, d = $('dock');
    d.textContent = '';
    takeBanner(d);
    const card = el('div', 'endcard');
    const head = res.half === 1 ? `Halftime: ${res.mine}–${res.theirs}` :
      res.mine > res.theirs ? `You win ${res.mine}–${res.theirs}` : res.mine < res.theirs ? `You lose ${res.mine}–${res.theirs}` : `Tied ${res.mine}–${res.theirs}: overtime`;
    card.append(el('h2', '', head));
    if (res.half === 1 || res.mine === res.theirs) card.append(el('p', 'note', `Your win chance from here: ${wpTxt(res.wp)}.`));
    card.append(squaresOf(G.decisions));
    const hh = headToHead(G.si, res);
    if (hh) card.append(hhCard(hh));
    const rl = sc.real || {};
    const realCall = rl.call && CALL[rl.call] ? CALL[rl.call].label : 'a play';
    const drive = !rl.drive ? '' : rl.drive === 'ran out the clock' ? 'they ran out the clock' : `the drive ended in a ${rl.drive}`;
    card.append(el('p', 'real', `In the real game (${gameTag(sc)}), ${rl.coach || 'the coach'} called "${realCall}" here; ${drive}.`));
    const cc = coachCard(G.decisions, 'You called this one like');
    if (cc) card.append(cc.el);
    const wpa = G.decisions.reduce((a, x) => a + x.wpa, 0);
    card.append(el('p', 'verdict', `${pts(wpa)}% win chance against a typical NFL play-caller in this spot.`));
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
  // You against the real coach: the game result in the fourth quarter; in the second, the points the possession
  // was worth (his drive: touchdown 7, field goal 3, a defensive touchdown -7, a safety -2)
  function headToHead(si, result) {
    const sc = today[si], rl = sc.real || {}, me = sc.player === sc.home ? 0 : 1;
    if (!result || !rl.coach) return null;
    const who = rl.coach.split(' ').slice(-1)[0];
    const net = (n) => (n > 0 ? `+${n} points` : n < 0 ? `${n} points` : 'no points');
    if (result.half === 1) {
      const s0 = startRoot(sc).score;
      const you = result.mine - s0[me] - (result.theirs - s0[1 - me]);
      const him = { touchdown: 7, 'field goal': 3, 'defensive touchdown': -7, safety: -2 }[rl.drive] || 0;
      return { coach: rl.coach, who, v: Math.sign(you - him), you: `${net(you)} before the half`,
        him: `${rl.drive ? rl.drive[0].toUpperCase() + rl.drive.slice(1) : 'His drive'} (${net(him)})` };
    }
    if (!rl.final) return null;
    const hm = me === 0 ? rl.final.home : rl.final.away, ht = me === 0 ? rl.final.away : rl.final.home;
    const wl = (a, b) => (a > b ? 'Won' : a < b ? 'Lost' : 'Tied');
    return { coach: rl.coach, who, v: Math.sign(Math.sign(result.mine - result.theirs) - Math.sign(hm - ht)),
      you: `${wl(result.mine, result.theirs)} ${result.mine}–${result.theirs}`, him: `${wl(hm, ht)} ${hm}–${ht}` };
  }
  function hhCard(h) {
    const box = el('div', `h2h ${h.v > 0 ? 'beat' : h.v < 0 ? 'lost' : 'tie'}`);
    box.append(el('div', 'k', `You vs ${h.coach}`), el('div', 'res', h.v > 0 ? `You beat ${h.who}` : h.v < 0 ? `${h.who} did better` : `Same as ${h.who}`));
    const row = el('div', 'rows');
    [['You', h.you], [h.who, h.him]].forEach(([a, b]) => { const r = el('div', 'r'); r.append(el('span', 'a', a), el('span', 'b', b)); row.append(r); });
    box.append(row);
    return box;
  }
  function snapsOf(decs) {
    const by = new Map();
    decs.forEach((x) => { const k = x.snap ?? by.size; by.set(k, (by.get(k) || 0) + x.cost); });
    return [...by.values()].map(markOf);
  }
  // a spot's snaps in at most 8 squares for sharing: longer drives are grouped, each group graded by its average
  function squeeze(decs) {
    const by = new Map();
    decs.forEach((x) => { const k = x.snap ?? by.size; by.set(k, (by.get(k) || 0) + x.cost); });
    const c = [...by.values()];
    if (c.length <= 8) return c.map(markOf);
    return Array.from({ length: 8 }, (_, j) => {
      const g = c.slice(Math.floor((j * c.length) / 8), Math.floor(((j + 1) * c.length) / 8));
      return markOf(g.reduce((a, x) => a + x, 0) / g.length);
    });
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
    const rec = [0, 0, 0];             // against the real coaches: better, worse, the same (a W-L-T record)
    const rows = [0, 1, 2].map((i) => {
      const s = state.spots[i]; if (!s) return '';
      const r = s.result ? (s.result.half === 1 ? 'HT' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      const hh = headToHead(i, s.result);
      if (hh) rec[hh.v > 0 ? 0 : hh.v < 0 ? 1 : 2]++;
      return `${today[i].player} ${r} ${squeeze(s.decisions || []).map((m) => SQ[m]).join('')}`;
    });
    const met = rec[0] + rec[1] + rec[2], recTxt = `${rec[0]}-${rec[1]}${rec[2] ? `-${rec[2]}` : ''}`;
    const vs = met ? `\nVs the real coaches: ${recTxt}` : '';
    if (met) {
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Vs the real coaches'), el('b', '', recTxt),
        el('span', 'sub', `${rec[0]} better, ${rec[1]} worse${rec[2] ? `, ${rec[2]} the same` : ''}`));
      box.insertBefore(v, box.children[3] || null);
    }
    const text = `Two-Minute Drill #${dayN}\nBetter than ${Math.round(p * 100)}% of NFL play-callers${cc ? `\nCoached like ${cc.name}` : ''}${vs}\n${rows.join('\n')}`;
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
    const nm = el('div'), g = groupOf(label);
    nm.append(el('div', 'nm', p.name), el('div', 'ps', `${team ? teamName(team) + ' · ' : ''}${POS_NAME[label] || label}`));
    if (p.pct != null) nm.append(el('div', 'ps', `Better than ${p.pct}% of NFL ${POS_PLURAL[g] || 'players'} at the time`));
    top.append(nm);
    const nodes = [top];
    if (p.kind) {
      const a = el('div', 'arch');
      a.append(el('span', 'tag', p.kind));
      nodes.push(a, el('p', 'lead', p.why));
    }
    const how = POS_METHOD[groupOf(label)];
    nodes.push(el('p', p.kind ? '' : 'lead', p.stat || ''),
      el('p', 'note', how ? `Our rating, 40 to 99: where he stood among NFL ${POS_PLURAL[g] || 'players'} in the games before this one (${how}), the latest counting most. A typical starter is 77.`
        : 'Our rating, 40 to 99, from his kicking before this game. A typical starter is 77.'));
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
      'You\'re the head coach for the last minutes of a real NFL game. Three new spots every day.',
      'Call Run, Pass or RPO, then the play. Timeouts, spikes, kicks and tempo pop up when they matter. On their ball, you call the defense.',
      'Every snap is a real NFL play run against your call. Tap the field to skip, or a player to see who he is.',
      'Beat the real coach\'s result, and find out which NFL coach you call it like.',
    ].forEach((t) => ul.append(el('li', '', t)));
    openModal('How to play', [
      ul,
      el('p', '', 'After each snap, how your call ranked:'),
      ex,
      el('p', 'note', 'Green: the best call. Yellow: close. Orange: costly. Red: a big mistake.'),
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
    const topH = () => document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
    topH(); addEventListener('resize', topH);
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
      const ids = idx.schedule[(dayN - 1) % idx.schedule.length], per = idx.spot_chunk || 60, teams = {};
      await Promise.all([...new Set(ids.map((i) => Math.floor(i / per)))].map((k) => fetch(`spots/s${k}.json`)
        .then((r) => { if (!r.ok) throw new Error('spot data ' + r.status); return r.json(); }).then((c) => Object.assign(teams, c))));
      today = ids.map((i) => buildScen(idx.spots[i], teams[i]));
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
