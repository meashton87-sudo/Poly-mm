// The daily score against simulated players: real daily spots played to the end (your offense, your defense, your
// tries and kickoffs, as game.js asks for them) by four kinds of player, then graded and scored by game.js's own code
// (decisionFrom, scoreVsNFL, snapStats, callsLine, pulled out of web/game.js by name) and, for comparison, by the rules
// before g: 2 (your call valued finely and the rest roughly; scoreVsNFLv1).
//   random   any key on the call sheet, tricks included
//   typical  the league's own mix here (the q every decision carries: the engine's NFL call frequencies)
//   sharp    the league's mix sharpened by its own read of the spot (600 games of its own a decision, tau 0.01)
//   greedy   the best of its own read, among the calls a real play-caller makes here
// The player's own read is never the grading's games. Checks: on spots with something at stake random << typical ~ 50
// << greedy; on a spot where nothing is (days 20 and 23 protect a 99% lead) random calls never score 90 or earn a
// Perfect drive; the calls line and the score agree (better than typical per snap and under 40, or worse and over 60).
//   node web/score_sweep.js [games per spot and player, default 2] [days, default 1,2,3,8,10,13,20,23] [jobs, default 4]
// (about 15 minutes on 4 cores; day 7, Super Bowl LI from the third quarter, takes about 20 minutes a game)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const W = __dirname + path.sep;
const NOSTAKES = new Set([7, 20, 23]);
const POLS = ['random', 'typical', 'sharp', 'greedy'];

if (process.argv[2] === '--play') play(+process.argv[3], process.argv[4], +process.argv[5], +process.argv[6]);
else main();

// ------------------------------------------------------------------------------------------------ one game ---
function play(SI, POL, GAME, DAY) {
  const E = require(W + 'engine.js');
  const eng = new E(JSON.parse(fs.readFileSync(W + 'engine_data.json', 'utf8')));
  eng.loadPlaybook(JSON.parse(fs.readFileSync(W + 'playbook.json', 'utf8')));
  const idx = JSON.parse(fs.readFileSync(W + 'game.json', 'utf8'));
  const TEAMS = {};
  fs.readdirSync(W + 'spots').forEach((f) => Object.assign(TEAMS, JSON.parse(fs.readFileSync(W + 'spots' + path.sep + f, 'utf8'))));
  const sp = idx.spots[SI], T = TEAMS[SI];
  const sim = eng.simulator(eng.makeContext({ home: T.home, away: T.away, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
    league: sp.league || idx.league, home_coach: T.home.coach, away_coach: T.away.coach, season: sp.real.season }, { receive2h: sp.start.receive2h }));
  const N1 = 600, N2 = 3000, R2TOP = 5;           // (round 2: the top five and the chosen, enough for both rules)
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const me = sp.player === sp.home ? 0 : 1, H = E.helpers, P = eng.pb;
  const CALL = {}; idx.calls.forEach((c) => { CALL[c.id] = c; });
  const TEMPOS = ['nohuddle', 'huddle', 'milk'];
  function hash(...parts) { let h = 2166136261 >>> 0; for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h % 1000003; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const R = rng(hash('policy', SI, POL, GAME));
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  const clockQ = (t) => (t > 2700 ? 1 : t >= 1800 ? 2 : t > 900 ? 3 : 4);
  // game.js: what coaches do (tendFeatures, inDomain, coachProbs)
  function tendFeatures(r, dd) {
    const margin = r.score[dd] - r.score[1 - dd], th = halfLeft(r.t), half2 = r.t <= 1800 ? 1 : 0, special = r.phase !== SNAP;
    const yl = special ? 75 : r.yl, ytg = special ? 10 : Math.min(r.ytg, r.yl), down = special ? 1 : r.down;
    return [th / 60, Math.log1p(th), half2, margin, Math.abs(margin), margin < 0 ? 1 : 0, margin > 0 ? 1 : 0, down, ytg, Math.log(Math.max(ytg, 1)),
      yl / 10, (yl / 10) ** 2, r.to[dd], r.to[1 - dd], th <= 120 ? 1 : 0, (th <= 300 && half2) ? 1 : 0, r.clock_running ? 1 : 0, yl <= 40 ? 1 : 0, Math.max(yl - 40, 0) / 10];
  }
  function inDomain(family, r, dd) {
    const margin = r.score[dd] - r.score[1 - dd], q = clockQ(r.t), th = halfLeft(r.t);
    switch (family) {
      case 'def_timeout': return (q === 4 && th <= 300 && margin <= 0 && margin >= -16) || (q === 2 && th <= 120);
      case 'off_clock_stop': return (q === 4 && th <= 120 && margin <= 0 && margin >= -16) || (q === 2 && th <= 60);
      case 'fourth_down': return ((q === 4 && th <= 600) || (q === 2 && th <= 120)) && Math.abs(margin) <= 16;
      case 'pat': return q === 4;
      case 'onside': return q === 4 && th <= 420 && margin < 0 && margin >= -16;
      default: return false;
    }
  }
  function coachProbs(family, r, dd) {
    const Tm = idx.models && idx.models.tendency;
    if (!Tm || !Tm.families[family] || !inDomain(family, r, dd)) return null;
    const m = Tm.families[family], x = tendFeatures(r, dd);
    const z = m.coef.map((row, c) => m.intercept[c] + row.reduce((a, w, j) => a + w * (x[j] - m.mean[j]) / m.scale[j], 0));
    let p;
    if (m.classes.length === 2 && m.coef.length === 1) { const s = 1 / (1 + Math.exp(-z[0])); p = [1 - s, s]; }
    else { const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); p = e.map((v) => v / s); }
    const out = {}; m.classes.forEach((c, i) => { out[c] = p[i]; }); return out;
  }
  // game_worker.js info: the league's call mix and the looks here, the kick odds, the usual tempo
  function info(root) {
    const o = root.pos, half = root.t > 1800 ? 1 : 2, tHalf = root.t - (half === 1 ? 1800 : 0);
    const fk = H.fineKey(H.gameMode(half, tHalf, root.score[o] - root.score[1 - o]), root.down, root.ytg, root.yl);
    const calls = P.calls.map((c, ci) => ({ id: c.id, freq: P.freq[fk * P.calls.length + ci] }));
    let looks = null;
    if (P.lookB) {
      looks = [0, 0, 0, 0];
      P.calls.forEach((c, ci) => {
        const pool = P.poolOf[ci * P.nFine + fk], d = [0, 0, 0, 0];
        let n = 0; for (let i = P.offsets[pool]; i < P.offsets[pool + 1]; i++) { const b = P.lookB[P.items[i]]; if (b < 4) { d[b]++; n++; } }
        d.forEach((x, b) => { looks[b] += P.freq[fk * P.calls.length + ci] * (n ? x / n : 0.25); });
      });
      const lt = looks.reduce((a, x) => a + x, 0) || 1; looks = looks.map((x) => x / lt);
    }
    return { calls, pFg: sim.fourthInfo(root).pFg, tempo: sim.defaultTempo(root), tempoSecs: sim.tempoSeconds(), looks };
  }
  // game.js option sets (clockOptions, callOptions, canKneel, defChoice) and their actions
  let INFO = null;
  const engineTempo = (k, r) => (k === 'huddle' ? 'normal' : k === 'milk' ? 'milk' : INFO.tempo === 'urgent' || INFO.tempo === 'hurry' ? INFO.tempo : halfLeft(r.t) <= 120 ? 'urgent' : 'hurry');
  const tempoKeyOf = (t) => (t === 'urgent' || t === 'hurry' ? 'nohuddle' : t === 'normal' ? 'huddle' : 'milk');
  const CLOCKACT = { timeout: { to_off: true }, spike: { to_off: false, play: 'spike' }, kneel: { to_off: false, play: 'kneel' } };
  const clockAct = (k, r) => (TEMPOS.includes(k) ? { to_off: false, tempo: engineTempo(k, r) }
    : k === 'rundown' ? { to_off: false, to_def: false, runoff: Math.max(0, halfLeft(r.t) - 3), play: 'fg' } : CLOCKACT[k]);
  const runsOut = (k, r) => r.clock_running && ((INFO.tempoSecs || {})[engineTempo(k, r)] || 0) >= halfLeft(r.t);
  function canKneel(r) {
    const lead = r.score[me] - r.score[1 - me], th = halfLeft(r.t);
    if (r.down > 3) return false;
    if (r.t > 1800) return lead >= 0 && th <= 120;
    return lead > 0 && th <= 40 * Math.max(5 - r.down - r.to[1 - me] - (r.clock_running ? 0 : 1), 0) + 30;
  }
  function clockOptions(r) {
    const lead = r.score[me] - r.score[1 - me], needTime = r.t > 1800 || lead <= 0, th = halfLeft(r.t), keys = TEMPOS.slice();
    if (r.to[me] > 0 && needTime) keys.push('timeout');
    if (r.down <= 3 && needTime && th <= 180) keys.push('spike');
    if (canKneel(r)) keys.push('kneel');
    if (r.to[me] > 0 && needTime && th > 5 && th <= 60 && r.yl <= 40 && (INFO.pFg || 0) >= 0.3 && (r.t > 1800 || lead >= -3)) keys.push('rundown');
    return keys;
  }
  function callOptions(r) {
    const th = halfLeft(r.t);
    const calls = idx.calls.map((c) => c.id).filter((id) => !(id === 'qb_sneak' && r.ytg > 3) && !(id === 'hail_mary' && !(th <= 30 && r.yl >= 30)));
    const specials = [], p = INFO.pFg, kickable = !r.clock_running || th >= 7, late = r.t > 1800 ? th <= 120 : th <= 300;
    if (kickable && ((r.down === 4 && p >= 0.05) || (th <= 20 && p >= 0.2) || (r.down === 3 && th <= 40 && p >= 0.4) || (late && p >= 0.3))) specials.push('fg');
    const behind = r.score[me] < r.score[1 - me];
    if (r.down === 4 && r.yl >= 30 && !(r.t <= 1800 && behind && th <= 40) && !(r.clock_running && TEMPOS.every((k) => runsOut(k, r)))) specials.push('punt');
    if (!r.clock_running && canKneel(r)) specials.push('kneel');
    return { calls, specials };
  }
  function defChoice(r) {
    const th = halfLeft(r.t), lead = r.score[me] - r.score[1 - me];
    return (r.t <= 1800 ? th <= 300 : th <= 120) && (lead <= 0 || (lead <= 3 && r.yl <= 45));
  }
  let sims = 0, seq = 0, snapN = 0;
  function evalAll(r, opts, n, seed) {
    const out = {};
    for (const o of opts) { const x = sim.run(r, { n, action: o.action, perspective: me, seed }); out[o.key] = { m: x.mean, se: x.se }; sims += n; }
    return out;
  }
  const norm = (q, keys) => { const o = {}; let s = 0; keys.forEach((k) => { o[k] = Math.max(q[k] || 0, 0); s += o[k]; }); keys.forEach((k) => { o[k] = s > 0 ? o[k] / s : 1 / keys.length; }); return o; };
  function pick(opts, q, r) {
    const keys = opts.map((o) => o.key), qq = norm(q, keys);
    if (POL === 'random') return keys[Math.floor(R() * keys.length)];
    if (POL === 'typical') { const u = R(); let a = 0; for (const k of keys) { a += qq[k]; if (u <= a) return k; } return keys[keys.length - 1]; }
    const own = evalAll(r, opts, N1, hash('own', SI, POL, GAME, seq));
    if (POL === 'greedy') { const ok = keys.filter((k) => qq[k] >= 0.02); return (ok.length ? ok : keys).reduce((a, b) => (own[b].m > own[a].m ? b : a)); }
    const mx = Math.max(...keys.map((k) => own[k].m)), w = keys.map((k) => qq[k] * Math.exp((own[k].m - mx) / 0.01));
    let u = R() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < keys.length; i++) { u -= w[i]; if (u <= 0) return keys[i]; }
    return keys[keys.length - 1];
  }
  const decisions = [];
  function graded(kind, family, r, opts, chosen, q) {
    const seed = hash(kind, 'h', SI, POL, GAME, seq), v1 = evalAll(r, opts, N1, seed);
    const set = new Set(opts.map((o) => o.key).sort((a, b) => v1[b].m - v1[a].m).slice(0, R2TOP)); set.add(chosen);
    const v2 = evalAll(r, opts.filter((o) => set.has(o.key)), N2, (seed ^ 0x5bd1e995) >>> 0);
    decisions.push({ kind, family, snap: snapN, keys: opts.map((o) => o.key), q, chosen, v1, v2 });
  }
  let root = (() => { const st = sp.start; return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sp.home ? 0 : 1, score: [st.score[1], st.score[0]],
    down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl, to: [st.to[1], st.to[0]], clock_running: st.running, phase: 0, credit: 0, free_kick: false }; })();
  const t0 = Date.now();
  for (let guard = 0; root.phase !== DONE && guard < 400; guard++) {
    const r = root, th = halfLeft(r.t), lead = r.score[me] - r.score[1 - me];
    seq++;
    const step = (action) => { root = sim.step(r, { action, seed: hash('step', SI, POL, GAME, seq) }).root; };
    if (r.phase === SNAP && (r.clock_running ? th < 1 && !(r.pos === me && r.to[me] > 0 && (r.t > 1800 || lead <= 0)) : th <= 1e-6)) { step({ to_off: false, to_def: false, tempo: 'normal' }); continue; }
    let action;
    if (r.phase === SNAP && r.pos === me) {
      INFO = info(r);
      let tempo = tempoKeyOf(INFO.tempo);
      if (runsOut(tempo, r)) tempo = TEMPOS.find((k) => !runsOut(k, r)) || tempo;
      if (r.clock_running) {
        const copts = clockOptions(r).map((k) => ({ key: k, action: clockAct(k, r) }));
        const q = coachProbs('off_clock_stop', r, me);
        let cq = lead > 0 && r.t <= 1800 ? { play: 0.9, timeout: 0.03, kneel: 0.07 } : q ? { play: q.hurry || 0, timeout: q.timeout || 0, spike: q.spike || 0 } : { play: 0.8, timeout: 0.14, spike: 0.06 };
        cq[tempoKeyOf(INFO.tempo)] = cq.play; delete cq.play;
        if (copts.some((o) => o.key === 'rundown') && th <= 45) { cq = Object.fromEntries(Object.entries(cq).map(([k, v]) => [k, v * 0.4])); cq.rundown = 0.6; }
        const c = pick(copts, cq, r);
        graded('clock', 'off_clock_stop', r, copts, c, cq);
        if (c === 'timeout') {                       // (game.js decideTimeout: the clock stops, then the call)
          snapN++;
          const halfEnd = r.t > 1800 ? 1800 : 0, floor = Math.min(r.t, r.t > halfEnd + 120 ? halfEnd + 120.01 : halfEnd + 0.5);
          root = { ...r, to: r.to.slice(), clock_running: false, t: Math.max(floor, r.t - 1) };
          root.to[me] -= 1;
          continue;
        }
        if (TEMPOS.includes(c)) tempo = c; else action = copts.find((o) => o.key === c).action;
      }
      if (!action) {
        const withTempo = (a) => (r.clock_running ? { ...a, tempo: engineTempo(tempo, r) } : a);
        const all = callOptions(r), sheet = all.calls.concat(all.specials);
        const c0 = POL === 'random' ? sheet[Math.floor(R() * sheet.length)] : null;
        const calls = all.calls.filter((id) => !id.startsWith('trick') || id === c0);     // (a trick is graded only when called)
        const opts = calls.map((id) => ({ key: id, action: withTempo({ to_off: false, play: CALL[id].kind, call: id, oob: false, looks: 0 }) }));
        all.specials.forEach((k) => opts.push({ key: k, action: withTempo({ to_off: false, play: k }) }));
        const q = {}, freq = {};
        INFO.calls.forEach((c) => { freq[c.id] = c.freq; });
        let goShare = 1;
        if (r.down === 4) {
          const f4 = coachProbs('fourth_down', r, me) || { go: r.yl <= 40 ? 0.35 : 0.15, fg: r.yl <= 40 ? 0.55 : 0.05, punt: r.yl <= 40 ? 0.1 : 0.8 };
          goShare = f4.go; if (all.specials.includes('fg')) q.fg = f4.fg; if (all.specials.includes('punt')) q.punt = f4.punt;
        } else if (all.specials.includes('fg')) { const usual = th <= 20 || (r.down === 3 && th <= 40); q.fg = !usual ? 0.02 : th <= 10 ? 0.6 : 0.2; goShare = 1 - q.fg; }
        if (all.specials.includes('kneel')) { const qk = lead > 0 ? 0.5 : 0.1; q.kneel = qk; goShare *= 1 - qk; }
        const fs_ = calls.reduce((a, id) => a + (freq[id] || 0), 0) || 1;
        calls.forEach((id) => { q[id] = goShare * (freq[id] || 0) / fs_; });
        const c = c0 || pick(opts, q, r);
        graded('call', r.down === 4 ? 'fourth_down' : 'play_select', r, opts, c, q);
        action = opts.find((o) => o.key === c).action;
      }
      snapN++;
    } else if (r.phase === SNAP) {
      // their ball: a kick or a kneel-out is not yours to call (game.js promptDefense peeks at the snap)
      const peek = sim.step(r, { action: { to_def: false }, seed: hash('step', SI, POL, GAME, seq) });
      if (peek.log.some((e) => e.ev === 'fg' || e.ev === 'punt' || (e.ev === 'play' && e.kind === 2))) action = { to_def: false };
      else {
        const L = info(r).looks || [0.25, 0.25, 0.25, 0.25], dq = { blitz: L[1] + L[3], load: L[2], soft: L[0] };
        const k = pick(['blitz', 'load', 'soft'].map((x) => ({ key: x, action: { to_def: false, def: x } })), dq, r);
        let useTo = false;
        if (r.clock_running && r.to[me] > 0 && defChoice(r)) {
          const to = [{ key: 'timeout', action: { to_def: true, def: k } }, { key: 'no_timeout', action: { to_def: false, def: k } }];
          const tq = coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 }, tc = pick(to, tq, r);
          useTo = tc === 'timeout';
          graded('deftime', 'def_timeout', r, to, tc, tq);
        }
        graded('defcall', 'def_call', r, ['blitz', 'load', 'soft'].map((x) => ({ key: x, action: { to_def: useTo, def: x } })), k, dq);
        action = { to_def: useTo, def: k };
        snapN++;
      }
    } else if (r.phase === PAT && r.pos === me) {
      const opts = [{ key: 'xp', action: { pat: 'xp' } }, { key: 'two', action: { pat: 'two' } }], q = coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 };
      const c = pick(opts, q, r);
      graded('pat', 'pat', r, opts, c, q);
      action = opts.find((o) => o.key === c).action;
      snapN++;
    } else if (r.phase === KICKOFF && r.pos === me && !r.free_kick) {
      const behind = lead < 0, on = behind ? (coachProbs('onside', r, me) || { onside: 0.01 }).onside || 0.01 : 0;
      const opts = [{ key: 'return', action: { kick: 'return' } }, { key: 'touchback', action: { kick: 'touchback' } }, ...(behind ? [{ key: 'onside', action: { kick: 'onside' } }] : [])];
      const q = { ...(behind ? { onside: on } : {}), return: (1 - on) * 0.82, touchback: (1 - on) * 0.18 }, c = pick(opts, q, r);
      graded('kick', 'onside', r, opts, c, q);
      action = opts.find((o) => o.key === c).action;
      snapN++;
    } else action = r.phase === SNAP ? { to_def: false } : (r.phase === KICKOFF && r.pos === me ? { kick: 'deep' } : {});
    step(action);
  }
  process.stdout.write(JSON.stringify({ si: SI, day: DAY, pol: POL, game: GAME, res: { mine: root.score[me], theirs: root.score[1 - me] }, decisions, sims, ms: Date.now() - t0 }) + '\n');
}

// ------------------------------------------------------------------------------- game.js's own scoring ---
function scorer() {
  const SRC = fs.readFileSync(W + 'game.js', 'utf8');
  const fn = (name) => {
    const at = SRC.indexOf(`  function ${name}(`);
    if (at < 0) throw new Error(`game.js: no function ${name}`);
    let i = SRC.indexOf('{', at), d = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
    return SRC.slice(at, i + 1) + '\n';
  };
  const line = (n) => { const m = SRC.match(new RegExp(`\\n[ ]*const [^\\n]*\\b${n} = [^\\n]*`)); if (!m) throw new Error(`game.js: no ${n}`); return m[0] + '\n'; };
  const consts = ['N_EVAL', 'REFINE_TOP', 'NOISE_Z', 'COST_MIN', 'QUIET_Z', 'PLAUSIBLE', 'RESULT_W', 'RESULT_FROM', 'PCT_FROM', 'SKILL_SHARP', 'MATTERS', 'markOf', 'pctShown', 'clip', 'PASS_AT'];
  const code = [...new Set(consts.map(line))].join('') + ['hash', 'rng', 'normalize', 'decisionFrom', 'scoreVsNFL', 'scoreVsNFLv1', 'percentileVsNFL', 'snapStats', 'callsLine'].map(fn).join('') +
    line('snapsOf') + '\nreturn { decisionFrom, scoreVsNFL, scoreVsNFLv1, snapStats, callsLine, markOf, PLAUSIBLE, REFINE_TOP };';
  // (one spot a day: spotGroups is that spot; resultScored as from day RESULT_FROM on)
  return (day, groups) => new Function('G', 'DRIVE', 'RUN_N', 'dayN', 'spotGroups', 'resultScored', code)({ snapN: 0 }, 0, 0, day, () => groups, () => true);
}
function scoreGame(g, mk) {
  const res = g.res.mine > g.res.theirs ? 1 : g.res.mine === g.res.theirs ? 0.5 : 0, groups = [];
  const F = mk(g.day, groups);
  // as game.js evaluateGraded: round 1 everything, round 2 the REFINE_TOP best of round 1, capped at its best
  const decs = g.decisions.map((x) => {
    const set = new Set(x.keys.slice().sort((a, b) => x.v1[b].m - x.v1[a].m).slice(0, F.REFINE_TOP));
    const top = Math.max(...[...set].map((k) => x.v2[k].m)), vals = {};
    x.keys.forEach((k) => { vals[k] = set.has(k) ? { wp: x.v2[k].m, se: x.v2[k].se, n: 3000 } : { wp: Math.min(x.v1[k].m, top), se: x.v1[k].se, n: 600 }; });
    return F.decisionFrom(x.kind, x.family, x.keys.map((k) => ({ key: k, label: k, action: {} })), vals, x.chosen, x.q, '', x.snap);
  });
  groups.push({ decs, res, start: decs[0].bestWp });
  const p = F.scoreVsNFL(decs), S = F.snapStats(decs);
  // before: the top three of round 1 and your call went again; the best could be yours; no noise floor
  const old = g.decisions.map((x) => {
    const set = new Set(x.keys.slice().sort((a, b) => x.v1[b].m - x.v1[a].m).slice(0, 3)); set.add(x.chosen);
    const top = Math.max(...[...set].map((k) => x.v2[k].m));
    const wps = x.keys.map((k) => ({ key: k, wp: set.has(k) ? x.v2[k].m : Math.min(x.v1[k].m, top) })), mine = wps.find((w) => w.key === x.chosen);
    const qq = {}; let s = 0; x.keys.forEach((k) => { qq[k] = Math.max(x.q[k] || 0, 0); s += qq[k]; }); x.keys.forEach((k) => { qq[k] = s > 0 ? qq[k] / s : 1 / x.keys.length; });
    const real = wps.filter((w) => w === mine || qq[w.key] >= F.PLAUSIBLE), best = (real.length ? real : wps).reduce((a, b) => (b.wp > a.wp ? b : a));
    return { wps, q: qq, bestWp: best.wp, wp: mine.wp, cost: Math.max(0, best.wp - mine.wp), wpa: mine.wp - wps.reduce((a, w) => a + qq[w.key] * w.wp, 0), snap: x.snap };
  });
  groups[0] = { decs: old, res, start: old[0].bestWp };
  const p0 = F.scoreVsNFLv1(old), oldSnaps = old.reduce((m, x) => m.set(x.snap, (m.get(x.snap) || 0) + x.cost), new Map());
  const oldMarks = [...oldSnaps.values()].map(F.markOf);
  return { day: g.day, pol: g.pol, res, score: Math.round(p * 100), before: Math.round(p0 * 100), snaps: S.length, green: S.filter((x) => x.m === 'g').length,
    matters: S.filter((x) => x.matters).length, wpaSnap: S.reduce((a, x) => a + x.wpa, 0) / S.length,
    perfect: S.filter((x) => x.matters).length >= 3 && S.every((x) => x.m === 'g'), perfectBefore: oldMarks.length >= 3 && oldMarks.every((m) => m === 'g'),
    line: F.callsLine(decs), sims: g.sims, ms: g.ms, calls: decs.length };
}

// ------------------------------------------------------------------------------------------------- main ---
async function main() {
  const games = +(process.argv[2] || 2), JOBS = +(process.argv[4] || 4);
  const days = (process.argv[3] || '1,2,3,8,10,13,20,23').split(',').map(Number);
  const idx = JSON.parse(fs.readFileSync(W + 'game.json', 'utf8'));
  const dayIds = (n) => {                       // game.js dayIds
    const row = idx.schedule[(n - 1) % idx.schedule.length], kinds = Object.keys(idx.categories), feat = idx.featured && idx.featured[n];
    return feat ? [feat.spot] : [row.find((i) => idx.spots[i].category === kinds[(n - 1) % kinds.length]) ?? row[(n - 1) % row.length]];
  };
  const jobs = [];
  for (let g = 0; g < games; g++) for (const d of days) for (const pol of POLS) jobs.push([dayIds(d)[0], pol, g, d]);
  const mk = scorer(), rows = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const launch = () => {
      if (next >= jobs.length) { if (done === jobs.length) resolve(); return; }
      const j = jobs[next++];
      const ch = spawn(process.execPath, [__filename, '--play', ...j.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      ch.stdout.on('data', (b) => { out += b; });
      ch.on('close', (code) => {
        if (code !== 0) { reject(new Error(`game ${j.join(' ')} failed (${code})`)); return; }
        rows.push(scoreGame(JSON.parse(out), mk));
        done++;
        process.stderr.write(`\r${done}/${jobs.length} games`);
        launch();
      });
    };
    for (let k = 0; k < Math.min(JOBS, jobs.length); k++) launch();
  });
  process.stderr.write('\n');
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const med = {};
  for (const type of ['normal', 'nostakes']) {
    const rs0 = rows.filter((r) => NOSTAKES.has(r.day) === (type === 'nostakes'));
    if (!rs0.length) continue;
    console.log(`\n${type === 'normal' ? 'Spots with something at stake' : 'Spots where nothing is at stake'} (days ${[...new Set(rs0.map((r) => r.day))].join(', ')})`);
    console.log('player     n   score: mean median p10 p90 >=90 perfect | before: mean median p10 p90 >=90 perfect | green/snap  wpa/snap');
    for (const pol of POLS) {
      const rs = rs0.filter((r) => r.pol === pol); if (!rs.length) continue;
      const s = rs.map((r) => r.score), b = rs.map((r) => r.before);
      med[`${type}:${pol}`] = q(s, 0.5);
      console.log(`${pol.padEnd(8)} ${String(rs.length).padStart(3)}   ${mean(s).toFixed(0).padStart(10)} ${String(q(s, 0.5)).padStart(6)} ${String(q(s, 0.1)).padStart(3)} ${String(q(s, 0.9)).padStart(3)} ${String(s.filter((x) => x >= 90).length).padStart(4)} ${String(rs.filter((r) => r.perfect).length).padStart(7)} | ${mean(b).toFixed(0).padStart(12)} ${String(q(b, 0.5)).padStart(6)} ${String(q(b, 0.1)).padStart(3)} ${String(q(b, 0.9)).padStart(3)} ${String(b.filter((x) => x >= 90).length).padStart(4)} ${String(rs.filter((r) => r.perfectBefore).length).padStart(7)} | ${mean(rs.map((r) => r.green / r.snaps)).toFixed(2).padStart(10)} ${(100 * mean(rs.map((r) => r.wpaSnap))).toFixed(2).padStart(9)}`);
    }
  }
  const calls = rows.reduce((a, r) => a + r.calls, 0), sims = rows.reduce((a, r) => a + r.sims, 0);
  console.log(`\n${rows.length} games, ${calls} graded calls, ${(sims / calls / 1000).toFixed(1)}k simulated games a call (the player's own reads included), ${(Date.now() - t0) / 1000 | 0} s`);
  const bad = [];
  const has = (k) => med[k] !== undefined;
  if (has('normal:random') && has('normal:typical') && !(med['normal:random'] + 15 <= med['normal:typical'])) bad.push('random calls not well below typical ones');
  if (has('normal:typical') && !(med['normal:typical'] >= 35 && med['normal:typical'] <= 65)) bad.push(`typical calls' median ${med['normal:typical']}, not near 50`);
  if (has('normal:greedy') && has('normal:typical') && !(med['normal:greedy'] >= med['normal:typical'] + 20)) bad.push('greedy calls not well above typical ones');
  rows.filter((r) => NOSTAKES.has(r.day) && r.pol === 'random').forEach((r) => {
    if (r.score >= 90) bad.push(`random calls scored ${r.score} on day ${r.day}`);
    if (r.perfect) bad.push(`random calls earned a Perfect drive on day ${r.day}`);
  });
  const disagree = rows.filter((r) => !NOSTAKES.has(r.day) && ((r.wpaSnap > 0.002 && r.score < 40) || (r.wpaSnap < -0.002 && r.score > 60)));
  if (disagree.length > Math.max(1, 0.03 * rows.length)) bad.push(`${disagree.length} games where the calls line and the score disagree`);
  console.log(bad.length ? `FAIL\n  ${bad.join('\n  ')}` : 'OK: random << typical ~ 50 << greedy; nothing at stake hands random calls no 90 or Perfect drive; the calls line agrees with the score');
  if (bad.length) process.exitCode = 1;
}
