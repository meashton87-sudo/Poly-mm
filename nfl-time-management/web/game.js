/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * Three real late-game spots a day. The player calls every play for one team until the game ends;
 * the nflclock engine (engine.js, in Web Workers) plays outcomes from real NFL plays of each call and
 * values every option by simulating the rest of the game. Scores are win probability added over a
 * typical NFL play-caller in the same spots. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RUN = 0, PASS = 1, KNEEL = 2, SPIKE = 3;
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const N_EVAL = 600;
  const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const STORE = 'tmd:v1';

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
  // call sheet layout: family -> calls (ids from playbook.json)
  // strong side = the wide side of the field, weak side = the short side (see src/nflclock/playbook.py)
  const SHEET = [
    ['Runs to the strong side', 'f-run', ['rb_out_strong', 'rb_tackle_strong', 'rb_inside_strong']],
    ['Runs to the weak side', 'f-run', ['rb_out_weak', 'rb_tackle_weak', 'rb_inside_weak']],
    ['Inside, QB and option runs', 'f-run', ['rb_middle', 'qb_sneak', 'qb_run', 'rpo']],
    ['Quick game', 'f-quick', ['quick_strong', 'quick_weak', 'quick_middle', 'screen']],
    ['Shots', 'f-shot', ['deep_strong', 'deep_weak', 'deep_middle', 'pa_deep', 'hail_mary']],
    ['Movement, play-action and gadgets', 'f-move', ['pa_short', 'roll_strong', 'roll_weak', 'trick']],
  ];
  const CALL_KIND = {};
  const CALL_LABEL = {};
  const CALL_SAY = {};
  const actorOf = (id, nm) => (id === 'trick' ? null : id.startsWith('rb_') ? nm.rb : nm.qb);
  const TEMPO = {
    timeout: { label: 'Timeout', act: { to_off: true } },
    hurry: { label: 'Hurry up (no huddle)', act: { to_off: false, tempo: 'urgent' } },
    huddle: { label: 'Huddle', act: { to_off: false, tempo: 'normal' } },
    milk: { label: 'Milk the play clock', act: { to_off: false, tempo: 'milk' } },
    spike: { label: 'Spike it', act: { to_off: false, play: 'spike' }, terminal: true },
    kneel: { label: 'Kneel', act: { to_off: false, play: 'kneel' }, terminal: true },
    rundown: { label: 'Run it down, timeout at 0:03, kick', act: { to_off: false }, terminal: true },
  };

  let data = null;        // scenarios.json
  let dayN = 1, dayIdx = 0, today = [];
  let state = null;       // saved progress for today
  let G = null;           // the spot being played
  let tempoSel = null, oobSel = false, busy = false;

  // ------------------------------------------------------------- helpers ---
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const pct = (p) => `${Math.round(p * 100)}`;
  const wpTxt = (p) => `${(p * 100).toFixed(1)}%`;
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

  const code = (i) => (i === 0 ? G.scen.game.home.team : G.scen.game.away.team);
  const teamName = (c) => (TEAMS[c] ? TEAMS[c][0] : c);
  const color = (c) => (TEAMS[c] ? TEAMS[c][1] : '#667');
  function clockOf(t) {
    const q = t > 2700 ? 1 : t > 1800 ? 2 : t > 900 ? 3 : 4;
    const s = Math.max(0, t - (4 - q) * 900);
    return { q, s, text: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` };
  }
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  function spotText(r) {
    if (r.yl === 50) return 'midfield';
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
    const T = data.models && data.models.tendency;
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

  // --------------------------------------------------------------- grades ---
  function letterFor(family, cost) {
    const gs = data.models && data.models.grade_scale;
    if (cost <= 0.0005) return { letter: 'A', pct: 0 };
    if (!gs || !gs.families[family]) return null;
    const q = gs.families[family].q;
    let k = 0; while (k < q.length && q[k] < cost) k++;
    const p = k / q.length;
    const letter = cost <= (gs.a_floor || 0.0025) ? 'A' : (gs.letters.find(([thr]) => p <= thr) || [1, 'F'])[1];
    return { letter, pct: p };
  }
  const mark = (cost) => (cost < 0.005 ? '🟩' : cost < 0.02 ? '🟨' : cost < 0.05 ? '🟧' : '🟥');

  function decisionFrom(kind, family, options, vals, chosen, q, situation) {
    const wps = options.map((o) => ({ key: o.key, label: o.label, wp: vals[o.key] }));
    const best = wps.reduce((a, b) => (b.wp > a.wp ? b : a));
    const mine = wps.find((w) => w.key === chosen);
    const qq = normalize(q, wps.map((w) => w.key));
    const typical = wps.reduce((a, w) => a + qq[w.key] * w.wp, 0);
    const cost = Math.max(0, best.wp - mine.wp);
    return { kind, family, situation, wps, chosen, chosenLabel: mine.label, best: best.key, bestLabel: best.label,
      bestWp: best.wp, wp: mine.wp, cost, q: qq, typical, wpa: mine.wp - typical, grade: letterFor(family, cost) };
  }

  // ------------------------------------------------------------- rendering ---
  function renderBug() {
    const r = G.root, bug = $('bug');
    bug.innerHTML = '';
    const side = (i, cls) => {
      const c = code(i), d = el('div', `tm ${cls}`);
      const stripe = el('span', 'stripe'); stripe.style.background = color(c); d.appendChild(stripe);
      const left = el('div');
      const ab = el('div', 'abbr', c);
      const tos = el('div', 'tos');
      for (let k = 0; k < 3; k++) tos.appendChild(el('i', k < r.to[i] ? '' : 'used'));
      tos.setAttribute('aria-label', `${r.to[i]} timeouts`);
      left.append(ab, tos);
      const sc = el('div', 'score', String(r.score[i]));
      d.append(left, sc);
      if (r.pos === i && r.phase === SNAP) { const b = el('span', 'ball'); b.title = 'has the ball'; d.appendChild(b); }
      if (i === G.me) left.insertBefore(el('div', 'you', 'you'), tos);
      return d;
    };
    const ck = clockOf(r.t);
    const mid = el('div', 'mid');
    mid.append(el('div', 'qtr', `${ck.q <= 4 ? 'Q' + ck.q : 'OT'}`), el('div', `clock${r.clock_running ? ' run' : ''}`, ck.text));
    const dd = r.phase === SNAP ? `${ddText(r)} · ${spotText(r)}` : r.phase === PAT ? 'Try after TD' : r.phase === KICKOFF ? 'Kickoff' : 'Final';
    mid.appendChild(el('div', 'dd', dd));
    bug.append(side(1, 'away'), mid, side(0, 'home'));
    renderField();
  }
  function renderField() {
    const r = G.root, f = $('field');
    if (!f.dataset.built) {
      f.dataset.built = '1';
      const l = el('div', 'ez l', teamName(code(G.me))); l.style.background = color(code(G.me));
      const rz = el('div', 'ez r', teamName(code(1 - G.me))); rz.style.background = color(code(1 - G.me));
      f.append(l, rz);
      for (let y = 10; y <= 90; y += 10) {
        const x = 8 + y * 0.84;
        const ln = el('div', 'yd'); ln.style.left = `${x}%`; f.appendChild(ln);
        const n = el('div', 'num', String(y <= 50 ? y : 100 - y)); n.style.left = `${x}%`; f.appendChild(n);
      }
      f.append(el('div', 'los'), el('div', 'fdl'), el('div', 'fb'));
    }
    const mine = r.pos === G.me;
    const x = mine ? 100 - r.yl : r.yl;            // you always attack to the right
    const fd = r.ytg >= r.yl ? null : (mine ? x + r.ytg : x - r.ytg);
    const px = (v) => `${8 + clip(v, 0, 100) * 0.84}%`;
    f.querySelector('.los').style.left = px(x);
    f.querySelector('.fb').style.left = px(x);
    const fdl = f.querySelector('.fdl');
    fdl.hidden = fd == null || r.phase !== SNAP;
    if (fd != null) fdl.style.left = px(fd);
  }
  function addLog(text, t, mine) {
    const li = el('li');
    li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
    $('pbp').prepend(li);
    G.log.push([text, t, !!mine]);
  }
  function restoreLog() {
    $('pbp').innerHTML = '';
    G.log.slice().forEach(([text, t, mine]) => {
      const li = el('li'); li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
      $('pbp').prepend(li);
    });
  }
  function feed(nodes) {
    const f = $('feed');
    f.innerHTML = '';
    nodes.forEach((n) => f.appendChild(n));
  }
  function busyPanel(text) {
    const d = $('decide');
    d.innerHTML = '';
    const b = el('div', 'busy'); b.append(el('span', 'spin'), el('span', '', text)); d.appendChild(b);
  }
  function fatal(msg) {
    const d = $('decide') || $('intro');
    if (d) { d.hidden = false; d.innerHTML = ''; d.appendChild(el('p', 'err', msg)); }
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
  function playLine(e, act) {
    const mine = e.team === G.me, nm = G.scen.names || {};
    const who = code(e.team);
    if (e.kind === SPIKE) return `${who} spikes the ball`;
    if (e.kind === KNEEL) return `${who} kneels`;
    let what;
    if (e.call >= 0) {
      const id = data.calls[e.call].id, actor = mine ? actorOf(id, nm) : null;
      what = `${actor || who} ${CALL_SAY[id] || CALL_LABEL[id].toLowerCase()}${lookText(e.look)}`;
    } else what = `${who} ${e.kind === RUN ? 'run' : 'pass'}`;
    const y = Math.round(e.yards);
    const gain = y > 0 ? `${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `loss of ${-y}` : 'no gain';
    let res;
    if (e.penalty) res = `FLAG, ${e.pen || 'penalty'}: ${y >= 0 ? `+${y}` : y} yards`;
    else {
      switch (e.evt) {
        case 'bad_snap': res = e.turnover ? 'BAD SNAP, the defense recovers' : `BAD SNAP, the offense falls on it: ${gain}`; break;
        case 'strip_sack': res = e.tdDef ? 'STRIP-SACK, returned for a TOUCHDOWN' : 'STRIP-SACK, fumble lost'; break;
        case 'sack_fumble': res = `sacked and fumbles, but the offense recovers: ${gain}`; break;
        case 'sack': res = `SACKED, ${gain}`; break;
        case 'pick_six': res = 'INTERCEPTED and returned for a TOUCHDOWN'; break;
        case 'interception': res = 'INTERCEPTED'; break;
        case 'scoop_score': res = 'FUMBLE, scooped and returned for a TOUCHDOWN'; break;
        case 'fumble_lost': res = 'FUMBLE, lost'; break;
        case 'fumble_kept': res = `fumbles, but the offense recovers: ${gain}`; break;
        case 'scramble': res = e.td ? `scrambles ${y} yards for a TOUCHDOWN` : `pressure, scrambles: ${gain}`; break;
        case 'throwaway': res = 'pressure, throws it away'; break;
        case 'drop': res = 'DROPPED, incomplete'; break;
        case 'near_pick': res = 'nearly intercepted, incomplete'; break;
        default: break;
      }
    }
    if (!res) {
      if (e.turnover) res = e.tdDef ? 'turnover, returned for a TOUCHDOWN' : e.kind === PASS ? 'INTERCEPTED' : 'FUMBLE, lost';
      else if (e.td) res = `${y}-yard TOUCHDOWN`;
      else if (e.incomplete) res = 'incomplete';
      else res = gain;
    } else if (e.td && !/TOUCHDOWN/.test(res)) res += `, ${y}-yard TOUCHDOWN`;
    const extra = [];
    if (e.oob && !e.incomplete) extra.push('out of bounds');
    else if (act && act.oob && mine && !e.incomplete && !e.penalty && !e.turnover && !e.td && !e.safety) {
      extra.push('could not get out of bounds');
    }
    if (e.fd && !e.td) extra.push(e.penalty ? 'automatic first down' : 'first down');
    if (e.onDowns) extra.push('turnover on downs');
    if (e.safety) extra.push('SAFETY');
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
          text = `${k} ${Math.round(e.dist)}-yard field goal: ${e.made ? 'GOOD' : 'NO GOOD'}`; t = null; break;
        }
        case 'punt': text = e.blocked ? `${code(e.team)} punt BLOCKED` : e.retTd ? `${code(e.team)} punt returned for a TOUCHDOWN` :
          `${code(e.team)} punts${e.touchback ? ', touchback' : `, net ${Math.round(e.net)} yards`}`; t = null; break;
        case 'pat': text = e.two ? `${code(e.team)} two-point try ${e.good ? 'GOOD' : 'fails'}` : `${code(e.team)} extra point ${e.good ? 'good' : 'NO GOOD'}`; break;
        case 'kickoff': text = e.onside ? `${code(e.team)} onside kick, recovered by ${code(e.recovered ? e.team : 1 - e.team)}` :
          e.retTd ? `Kickoff returned for a TOUCHDOWN` : `Kickoff, ${code(1 - e.team)} starts at its own ${Math.round(100 - e.yl)}`; break;
        case 'end': text = G.root.t > 1800 ? 'Halftime' : 'End of regulation'; break;
        default: break;
      }
      if (text) out.push([text, t, e.team === G.me]);
    }
    return out;
  }

  // ------------------------------------------------------------- the spot ---
  function newSpot(i) {
    const sc = today[i];
    const home = sc.game.home.team;
    return { si: i, scen: sc, me: sc.player === home ? 0 : 1, root: startRoot(sc), decisions: [], log: [], seq: 0,
      over: false, result: null, startWp: null };
  }
  function persist() {
    state.spots[G.si] = { root: G.root, decisions: G.decisions, log: G.log, seq: G.seq, over: G.over, result: G.result, startWp: G.startWp };
    save(`${STORE}:day:${dayN}`, state);
  }
  function resumeSpot(i) {
    G = newSpot(i);
    const s = state.spots[i];
    if (s) Object.assign(G, { root: s.root, decisions: s.decisions || [], log: s.log || [], seq: s.seq || 0, over: s.over, result: s.result, startWp: s.startWp });
    return G;
  }

  function renderIntro() {
    const sc = G.scen, r = G.root, box = $('intro');
    box.hidden = false; $('play').hidden = true; $('summary').hidden = true;
    box.innerHTML = '';
    const me = code(G.me), op = code(1 - G.me);
    const cat = data.categories[sc.category];
    box.appendChild(el('h3', '', `Spot ${G.si + 1} of 3 · ${cat}`));
    box.appendChild(el('h2', '', `You are the ${teamName(me)}`));
    const ck = clockOf(r.t);
    const lead = r.score[G.me] - r.score[1 - G.me];
    const scoreTxt = lead > 0 ? `up ${lead}` : lead < 0 ? `down ${-lead}` : 'tied';
    box.appendChild(el('p', '', `${sc.season} season, week ${sc.week}: ${teamName(me)} ${r.score[G.me]}, ${teamName(op)} ${r.score[1 - G.me]} (${scoreTxt}). ` +
      `Q${ck.q}, ${ck.text} left. ${ddText(r)} at the ${spotText(r)}. Timeouts: ${me} ${r.to[G.me]}, ${op} ${r.to[1 - G.me]}. ` +
      `You are calling it for ${sc.coach || 'the head coach'}; the game is real, and so is what happened next.`));
    // scouting report from the call percentiles
    const myCalls = sc.game[G.me === 0 ? 'home' : 'away'].calls, thCalls = sc.game[G.me === 0 ? 'away' : 'home'].calls;
    const edge = Object.keys(myCalls).map((id) => ({ id, o: myCalls[id].off_pct, d: thCalls[id] ? thCalls[id].def_pct : 0.5 }))
      .map((x) => ({ ...x, e: x.o - x.d })).sort((a, b) => b.e - a.e);
    const sc2 = el('div', 'scout');
    const mk = (title, items) => {
      const d = el('div'); d.appendChild(el('h3', '', title));
      const ul = el('ul');
      items.forEach((x) => ul.appendChild(el('li', '', `${CALL_LABEL[x.id]}: ${me} offense ${ordinal(Math.round(x.o * 100))} pct, ${op} defense ${ordinal(Math.round(x.d * 100))} pct`)));
      d.appendChild(ul); return d;
    };
    sc2.append(mk('Where you have the edge', edge.slice(0, 3)), mk('Where they have it', edge.slice(-3).reverse()));
    box.appendChild(sc2);
    const go = el('button', 'btn', G.decisions.length ? 'Back to the game' : 'Take the field');
    go.type = 'button';
    go.addEventListener('click', () => { box.hidden = true; $('play').hidden = false; feed([]); restoreLog(); renderBug(); if (!G.decisions.length && !G.log.length) addLog(`${teamName(me)} ball, ${ddText(r)} at the ${spotText(r)}`, r.t, true); advance(); });
    box.appendChild(el('div', 'row')).appendChild(go);
  }

  async function advance() {
    renderBug();
    while (true) {
      const r = G.root;
      if (r.phase === DONE) return finishSpot();
      if (r.phase === SNAP && r.pos === G.me) return promptOffense();
      if (r.phase === PAT && r.pos === G.me) return promptChoice('pat');
      if (r.phase === KICKOFF && r.pos === G.me && !r.free_kick && kickChoice(r)) return promptChoice('kick');
      if (r.phase === SNAP && r.pos !== G.me && r.clock_running && r.to[G.me] > 0 && defChoice(r)) return promptChoice('deftime');
      const action = r.phase === SNAP ? { to_def: false } : (r.phase === KICKOFF && r.pos === G.me ? { kick: 'deep' } : {});
      busyPanel(r.pos === G.me ? 'Kicking off…' : `${code(r.pos)} has the ball…`);
      await stepWith(action);
      await sleep(G.fast ? 60 : 520);
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
    renderBug();
    return res;
  }

  // offense: tempo (if the clock is running) + play call
  async function promptOffense() {
    const r = G.root;
    busyPanel('Reading the defense…');
    const inf = (await send({ type: 'info', scen: G.scen, root: r })).info;
    G.info = inf;
    tempoSel = r.clock_running ? null : 'stopped';
    oobSel = false;
    drawOffense();
  }
  function tempoOptions(r) {
    const me = G.me, lead = r.score[me] - r.score[1 - me], th = halfLeft(r.t);
    const keys = [];
    if (r.to[me] > 0) keys.push('timeout');
    keys.push('hurry', 'huddle', 'milk');
    if (r.down <= 3) keys.push('spike');
    if (r.down <= 3 && lead > 0) keys.push('kneel');
    if (r.t <= 1800 && lead >= -2 && lead <= 0 && th <= 180 && r.to[me] > 0 && G.info.pFg >= 0.5) keys.push('rundown');
    return keys;
  }
  function callOptions(r) {
    const me = G.me, lead = r.score[me] - r.score[1 - me], th = halfLeft(r.t);
    const calls = [];
    SHEET.forEach(([, , ids]) => ids.forEach((id) => {
      if (id === 'qb_sneak' && r.ytg > 3) return;
      if (id === 'hail_mary' && !(th <= 30 && r.yl >= 30)) return;   // only as a half runs out
      calls.push(id);
    }));
    const specials = [];
    if (G.info.pFg >= 0.05 && (r.down === 4 || th <= 40)) specials.push('fg');
    if (r.down === 4 && r.yl >= 30) specials.push('punt');
    if (!r.clock_running && r.down <= 3 && (lead > 0 || r.t > 1800)) specials.push('kneel');
    return { calls, specials };
  }
  function drawOffense() {
    const r = G.root, d = $('decide'), me = G.me;
    d.innerHTML = '';
    d.appendChild(el('p', 'ask', `Your call: ${ddText(r)} at the ${spotText(r)}`));
    const myCalls = G.scen.game[me === 0 ? 'home' : 'away'].calls, thCalls = G.scen.game[me === 0 ? 'away' : 'home'].calls;
    if (r.clock_running) {
      d.appendChild(el('h3', '', 'Clock is running: tempo'));
      const chips = el('div', 'chips');
      tempoOptions(r).forEach((k) => {
        const b = el('button', `chip${TEMPO[k].terminal ? ' term' : ''}`, k === 'timeout' ? `Timeout (${r.to[me]} left)` : TEMPO[k].label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(tempoSel === k));
        b.addEventListener('click', () => {
          if (busy) return;
          if (TEMPO[k].terminal) { decideOffense({ tempo: k }); return; }
          tempoSel = k; drawOffense();
        });
        chips.appendChild(b);
      });
      d.appendChild(chips);
      if (!tempoSel) d.appendChild(el('p', 'note', 'Pick a tempo, then a play. Spike, kneel and run-it-down are plays on their own.'));
    }
    const row = el('div', 'row');
    const lab = el('label', 'toggle');
    const cb = el('input'); cb.type = 'checkbox'; cb.id = 'oob'; cb.checked = oobSel;
    cb.addEventListener('change', () => { oobSel = cb.checked; drawOffense(); });
    lab.append(cb, el('span', '', 'Get out of bounds'));
    row.appendChild(lab);
    row.appendChild(el('span', 'note', 'Percentiles: your offense on this play (O) and their defense against it (D). Strong side = wide side of the field, weak side = short side.'));
    d.appendChild(row);
    const { calls, specials } = callOptions(r);
    const sheet = el('div', 'sheet');
    const stat = {};
    G.info.calls.forEach((c) => { stat[c.id] = c; });
    const canCall = !r.clock_running || (tempoSel && !TEMPO[tempoSel].terminal);
    SHEET.forEach(([fam, cls, ids]) => {
      const shown = ids.filter((id) => calls.includes(id));
      if (!shown.length) return;
      sheet.appendChild(el('div', 'fam', fam));
      shown.forEach((id) => {
        const b = el('button', `play ${cls}`);
        b.type = 'button';
        b.disabled = !canCall;
        const o = myCalls[id] || { off_pct: null }, dd = thCalls[id] || { def_pct: null };
        const nm = G.scen.names || {};
        const who = actorOf(id, nm);
        b.append(el('span', 'nm', CALL_LABEL[id]));
        if (who) b.append(el('span', 'who', who));
        const meta = el('span', 'meta');
        const rated = o.off_pct !== null && dd.def_pct !== null;   // too rare to rate by team: hail mary, trick plays
        const op = el('span', `pct ${rated && o.off_pct >= 0.67 ? 'hi' : rated && o.off_pct <= 0.33 ? 'lo' : ''}`); op.append('O '); op.appendChild(el('b', '', rated ? pct(o.off_pct) : '–'));
        const dp = el('span', `pct ${rated && dd.def_pct <= 0.33 ? 'hi' : rated && dd.def_pct >= 0.67 ? 'lo' : ''}`); dp.append('D '); dp.appendChild(el('b', '', rated ? pct(dd.def_pct) : '–'));
        const s = stat[id];
        meta.append(op, dp, el('span', '', `avg ${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(1)}`),
          el('span', '', `OOB ${Math.round((oobSel ? s.oobTry : s.oob) * 100)}%`));
        if (r.down >= 3) meta.append(el('span', '', `conv ${Math.round(s.conv * 100)}%`));
        b.appendChild(meta);
        b.addEventListener('click', () => { if (!busy) decideOffense({ call: id }); });
        sheet.appendChild(b);
      });
    });
    if (specials.length) {
      sheet.appendChild(el('div', 'fam', 'Special teams and clock'));
      specials.forEach((k) => {
        const b = el('button', 'play f-clock');
        b.type = 'button';
        b.disabled = !canCall;
        const label = k === 'fg' ? `Field goal (${Math.round(G.info.fgDist)} yds)` : k === 'punt' ? 'Punt' : 'Kneel';
        b.append(el('span', 'nm', label));
        const meta = el('span', 'meta');
        if (k === 'fg') meta.append(el('span', '', `makes ${Math.round(G.info.pFg * 100)}%`));
        if (k === 'kneel') meta.append(el('span', '', 'burns ~40 s if the clock keeps running'));
        b.appendChild(meta);
        b.addEventListener('click', () => { if (!busy) decideOffense({ special: k }); });
        sheet.appendChild(b);
      });
    }
    d.appendChild(sheet);
  }

  function callAction(tempoAct, id, oob) { return { ...tempoAct, play: CALL_KIND[id], call: id, oob: !!oob }; }
  function specialAction(tempoAct, k) { return { ...tempoAct, play: k }; }

  async function decideOffense(pick) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    const situation = `${clockOf(r.t).text} Q${clockOf(r.t).q}, ${ddText(r)} at the ${spotText(r)}`;
    try {
      const tempoKey = pick.tempo || tempoSel;
      const decisions = [];
      // 1) the clock decision, valued with a sound play call after it
      if (r.clock_running) {
        busyPanel(`Simulating every tempo option ${N_EVAL.toLocaleString()} times…`);
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
        const opts = calls.map((id) => ({ key: id, label: CALL_LABEL[id], action: callAction(tempoAct, id, false) }));
        if (pick.call && oobSel) opts.push({ key: `${pick.call}+oob`, label: `${CALL_LABEL[pick.call]}, get out of bounds`, action: callAction(tempoAct, pick.call, true) });
        specials.forEach((k) => opts.push({ key: k, label: k === 'fg' ? 'Field goal' : k === 'punt' ? 'Punt' : 'Kneel', action: specialAction(tempoAct, k) }));
        busyPanel(`Simulating ${opts.length} calls ${N_EVAL.toLocaleString()} times each…`);
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
        const chosen = pick.call ? (oobSel ? `${pick.call}+oob` : pick.call) : pick.special;
        decisions.push(decisionFrom('call', r.down === 4 ? 'fourth_down' : 'play_select', opts, vals, chosen, q, situation));
        action = opts.find((o) => o.key === chosen).action;
      }
      decisions.forEach((x) => G.decisions.push(x));
      busyPanel('Snap…');
      const res = await stepWith(action);
      showFeedback(decisions, res);
    } catch (e) {
      fatal('Something went wrong in the simulation: ' + e.message);
      busy = false;
      return;
    }
    busy = false;
    await sleep(350);
    advance();
  }

  function showFeedback(decisions, res) {
    const nodes = [];
    const lines = narrate(res.log, res.action).filter(([, , mine]) => mine);
    const plays = res.log.filter((e) => e.ev === 'play' || e.ev === 'fg' || e.ev === 'punt' || e.ev === 'pat' || e.ev === 'kickoff');
    const last = narrate(plays, res.action);
    if (last.length) nodes.push(el('div', 'result big', last[last.length - 1][0]));
    else if (lines.length) nodes.push(el('div', 'result', lines[lines.length - 1][0]));
    decisions.forEach((x) => {
      const g = el('div', 'grade');
      g.append(el('span', 'mark', mark(x.cost)));
      const what = x.kind === 'clock' ? 'Tempo' : x.kind === 'call' ? 'Call' : x.kind === 'deftime' ? 'Timeout' : x.kind === 'pat' ? 'Try' : 'Kickoff';
      g.append(el('span', '', `${what}: ${x.chosenLabel} ${wpTxt(x.wp)}`));
      if (x.best !== x.chosen) g.append(el('span', 'note', `best: ${x.bestLabel} ${wpTxt(x.bestWp)} (−${(x.cost * 100).toFixed(1)})`));
      else g.append(el('span', 'pill good', 'best call'));
      const typ = x.wpa >= 0 ? `+${(x.wpa * 100).toFixed(1)}` : (x.wpa * 100).toFixed(1);
      g.append(el('span', `pill ${x.wpa >= 0.002 ? 'good' : x.wpa <= -0.002 ? 'bad' : ''}`, `${typ} vs a typical NFL call`));
      nodes.push(g);
    });
    feed(nodes);
  }

  // defensive timeout, PAT, kickoff
  async function promptChoice(kind) {
    const r = G.root, d = $('decide'), me = G.me;
    const spec = {
      deftime: { ask: `${code(r.pos)} ball, clock running: call timeout?`, family: 'def_timeout',
        opts: [{ key: 'timeout', label: `Call timeout (${r.to[me]} left)`, action: { to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false } }],
        q: () => coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 } },
      pat: { ask: 'Touchdown! Kick the extra point or go for two?', family: 'pat',
        opts: [{ key: 'xp', label: 'Kick the extra point', action: { pat: 'xp' } }, { key: 'two', label: 'Go for two', action: { pat: 'two' } }],
        q: () => coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 } },
      kick: { ask: 'Kickoff: kick it deep or try an onside kick?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside kick', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    d.innerHTML = '';
    d.appendChild(el('p', 'ask', spec.ask));
    const chips = el('div', 'chips');
    spec.opts.forEach((o) => {
      const b = el('button', 'chip', o.label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          busyPanel('Simulating both options…');
          const vals = await evaluate(r, spec.opts, hash(kind, dayN, G.si, G.seq));
          const situation = `${clockOf(r.t).text} Q${clockOf(r.t).q}`;
          const x = decisionFrom(kind, spec.family, spec.opts, vals, o.key, spec.q(), situation);
          G.decisions.push(x);
          const res = await stepWith(o.action);
          showFeedback([x], res);
        } catch (e) { fatal('Something went wrong in the simulation: ' + e.message); busy = false; return; }
        busy = false;
        await sleep(350);
        advance();
      });
      chips.appendChild(b);
    });
    d.appendChild(chips);
  }

  async function finishSpot() {
    if (!G.result) {
      const r = G.root;
      busyPanel('Final whistle…');
      const v = await evaluate(r, [{ key: 'end', action: {} }], 1);
      const mine = r.score[G.me], theirs = r.score[1 - G.me];
      G.result = { wp: v.end, mine, theirs, half: r.t > 1800 ? 1 : 2 };
      G.over = true;
      persist();
    }
    const res = G.result, sc = G.scen, d = $('decide');
    d.innerHTML = '';
    const head = res.half === 1 ? `Halftime: ${code(G.me)} ${res.mine}, ${code(1 - G.me)} ${res.theirs}` :
      res.mine > res.theirs ? `Final: you win ${res.mine}–${res.theirs}` : res.mine < res.theirs ? `Final: you lose ${res.mine}–${res.theirs}` :
        `Tied ${res.mine}–${res.theirs}: overtime`;
    d.appendChild(el('p', 'ask', head));
    if (res.half === 1 || res.mine === res.theirs) d.appendChild(el('p', '', `Your win probability from here: ${wpTxt(res.wp)}.`));
    const wpa = G.decisions.reduce((a, x) => a + x.wpa, 0), lost = G.decisions.reduce((a, x) => a + x.cost, 0);
    d.appendChild(el('p', '', `${G.decisions.length} decisions. Win probability added over a typical NFL play-caller: ${wpa >= 0 ? '+' : ''}${(wpa * 100).toFixed(1)} points. Left on the table versus the best call each time: ${(lost * 100).toFixed(1)} points.`));
    d.appendChild(el('p', 'note', G.decisions.map((x) => mark(x.cost)).join('')));
    const real = sc.real || {};
    const me = code(G.me);
    const realCall = real.call ? CALL_LABEL[real.call] || real.call : 'a play';
    const fin = real.final ? `final ${sc.game.away.team} ${real.final.away}, ${sc.game.home.team} ${real.final.home}` : '';
    const drive = real.drive ? `the drive ended in ${/^[aeiou]/.test(real.drive) ? 'an' : 'a'} ${real.drive}` : '';
    d.appendChild(el('p', 'note', `What really happened: ${sc.coach || me} called "${realCall}" on that first snap${drive ? '; ' + drive : ''}${fin ? '; ' + fin : ''}.`));
    const wrap = el('div', 'optwrap');
    const tbl = el('table', 'opts');
    const th = el('tr'); ['When', 'You', 'Best', 'Cost'].forEach((h) => th.appendChild(el('th', '', h))); tbl.appendChild(th);
    G.decisions.forEach((x) => {
      const tr = el('tr');
      tr.append(el('td', '', x.situation), el('td', '', `${mark(x.cost)} ${x.chosenLabel}`), el('td', '', x.best === x.chosen ? '—' : x.bestLabel),
        el('td', 'n', x.cost < 0.0005 ? '0.0' : `−${(x.cost * 100).toFixed(1)}`));
      tbl.appendChild(tr);
    });
    wrap.appendChild(tbl);
    d.appendChild(wrap);
    const btn = el('button', 'btn', G.si < 2 ? 'Next spot' : "See today's score");
    btn.type = 'button';
    btn.addEventListener('click', () => {
      state.current = G.si + 1;
      save(`${STORE}:day:${dayN}`, state);
      if (G.si < 2) { resumeSpot(G.si + 1); $('field').innerHTML = ''; delete $('field').dataset.built; renderIntro(); renderPips(); }
      else renderSummary();
    });
    d.appendChild(el('div', 'row')).appendChild(btn);
    renderPips();
  }

  // ------------------------------------------------------------- summary ---
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
    $('intro').hidden = true; $('play').hidden = true;
    const box = $('summary'); box.hidden = false; box.innerHTML = '';
    const decs = allDecisions();
    const p = decs.length ? percentileVsNFL(decs) : 0;
    const wpa = decs.reduce((a, x) => a + x.wpa, 0);
    const grade = p >= 0.9 ? 'A' : p >= 0.7 ? 'B' : p >= 0.4 ? 'C' : p >= 0.15 ? 'D' : 'F';
    box.appendChild(el('h3', '', `Day ${dayN} · today's score`));
    box.appendChild(el('h2', '', `Better than ${Math.round(p * 100)}% of NFL play-callers`));
    const g = el('div', 'sumgrid');
    const tile = (big, label) => { const d = el('div'); d.append(el('div', 'big', big), el('div', 'note', label)); return d; };
    g.append(tile(`${Math.round(p * 100)}`, 'percentile vs NFL play-callers in your spots'),
      tile(`${wpa >= 0 ? '+' : ''}${(wpa * 100).toFixed(1)}`, 'win-probability points added vs a typical NFL call'), tile(grade, 'grade'));
    box.appendChild(g);
    const rows = [0, 1, 2].map((i) => {
      const s = state.spots[i]; if (!s) return '';
      const sc = today[i], me = sc.player;
      const r = s.result ? (s.result.half === 1 ? 'half' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      return `${me} ${r} ${(s.decisions || []).map((x) => mark(x.cost)).join('')}`;
    });
    const text = `Two-Minute Drill #${dayN}\nBetter than ${Math.round(p * 100)}% of NFL play-callers\n${rows.join('\n')}\n${wpa >= 0 ? '+' : ''}${(wpa * 100).toFixed(1)} win % vs a typical NFL call`;
    const pre = el('div', 'share', text);
    box.appendChild(pre);
    const btn = el('button', 'btn', 'Copy result');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
      catch (e) { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); btn.textContent = 'Selected: copy it'; }
    });
    box.appendChild(el('div', 'row')).appendChild(btn);
    // personal stats on this device
    const st = load(`${STORE}:stats`, { days: {} });
    st.days[dayN] = { p, wpa };
    save(`${STORE}:stats`, st);
    const days = Object.keys(st.days).map(Number).sort((a, b) => a - b);
    let streak = 0; for (let k = dayN; st.days[k]; k--) streak++;
    const avg = days.reduce((a, k) => a + st.days[k].p, 0) / days.length;
    box.appendChild(el('p', 'note', `Played ${days.length} day${days.length === 1 ? '' : 's'} on this device · streak ${streak} · average ${Math.round(avg * 100)}th percentile. New spots every day at midnight.`));
    state.done = true;
    save(`${STORE}:day:${dayN}`, state);
    renderPips();
  }

  function renderPips() {
    const p = $('pips'); p.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const s = state.spots[i];
      const d = el('span', `pip${s && s.over ? ' done' : (state.current === i ? ' on' : '')}`);
      d.title = `Spot ${i + 1}`;
      p.appendChild(d);
    }
  }

  // ----------------------------------------------------------------- boot ---
  async function boot() {
    $('howBtn').addEventListener('click', () => { $('how').hidden = !$('how').hidden; });
    try {
      data = await fetch('scenarios.json').then((r) => { if (!r.ok) throw new Error('scenarios ' + r.status); return r.json(); });
    } catch (e) { fatal('Could not load today\'s spots: ' + e.message); return; }
    data.calls.forEach((c) => { CALL_KIND[c.id] = c.kind; CALL_LABEL[c.id] = c.label; CALL_SAY[c.id] = c.say; });
    const launch = new Date(data.launch + 'T00:00:00');
    const now = new Date(); now.setHours(0, 0, 0, 0);
    dayN = Math.max(1, Math.floor((now - launch) / 864e5) + 1);
    dayIdx = (dayN - 1) % data.schedule.length;
    today = data.schedule[dayIdx].map((i) => data.scenarios[i]);
    $('dayLabel').textContent = `#${dayN} · ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    state = load(`${STORE}:day:${dayN}`, null) || { spots: [], current: 0, done: false };
    if (!load(`${STORE}:seen`, false)) { $('how').hidden = false; save(`${STORE}:seen`, true); }
    renderPips();
    const intro = $('intro');
    intro.hidden = false;
    intro.innerHTML = '';
    const b = el('div', 'busy'); b.append(el('span', 'spin'), el('span', '', 'Loading the simulator and 160,000 real plays…')); intro.appendChild(b);
    onReady = () => {
      if (state.done) { renderSummary(); return; }
      resumeSpot(Math.min(state.current || 0, 2));
      renderIntro();
    };
    startWorkers();
  }
  // playbook call metadata ships with scenarios.json (calls) so labels are ready before the workers
  boot();
})();
