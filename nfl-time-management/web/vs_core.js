/* Versus core: college overtime, shared by the page (game.js) and the match server (board/match.js), which plays it.
 *
 * The match is one state, ms = {root, cot, seq, over, winner}: root is the engine's state (engine.js step), cot the
 * overtime around it. The server holds the only real copy: each decision's halves (the two phones' calls) go in,
 * apply() plays the snap with the engine and the rules below, and the new state goes out to both phones. Each snap's
 * seed is the server's, new and random every time and never sent before the snap, so no phone can know what a call
 * will do before it is made.
 *
 * College overtime (the NCAA rule, as EA Sports College Football has it):
 *   - a coin toss: the winner chooses offense, defense or the end of the field (then the other team picks offense or
 *     defense) for the 1st overtime; from then on the order flips each period: the team with the ball second in one
 *     overtime has it first in the next (offense, defense | defense, offense | ...; the owner's call, Oct 22: a second
 *     pick each period let a team have the ball second every time)
 *   - each team gets the ball at the opponent's 25 (1st and 2nd overtime), no game clock
 *   - from the 2nd overtime a touchdown must go for two
 *   - from the 3rd overtime, alternating two-point plays
 *   - ahead after both teams have had the ball wins; a defense that scores on the first possession wins at once; a
 *     touchdown that puts the second team ahead ends it (no try)
 * Teams are seats: team 0 (the home side) is seat 0's team, team 1 seat 1's.
 *
 * opt (start, apply, after, possRoot; Coach mode): opt.twoYl, the yard line a two-point try is snapped from (the rules'
 * twoYl: the 3 in college and high school), and opt.ot, an overtime format (engine.js RULE_BOOK.OT, rules.py OT: the
 * NCAA's, the NFHS "Kansas plan" from the 10, a state's), with opt.regTo the timeouts left in regulation for a format
 * that carries them. Without opt, Versus plays as it always has.
 */
(function (global) {
  'use strict';
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;      // engine.js phases
  const COT_T = 900;           // the engine's clock in overtime: held here, never run (college overtime has none)
  // the defense's call (engine.js DC): personnel, front, coverage, pass rush
  const DC = { pers: ['heavy', 'base', 'nickel', 'dime'], front: ['light', 'even', 'loaded'],
    cover: ['c0', 'c1', '2man', 'c2', 'c3', 'c4', 'c6', 'prevent'], rush: [3, 4, 5, 6] };
  const PICKS = ['offense', 'defense', 'end'];
  const PLAYS = new Set(['run', 'pass', 'kneel', 'spike', 'fg', 'punt']);     // engine.js PLAY
  const WHO = new Set(['RB', 'WR', 'TE']);                                    // engine.js WHO_CODE

  // the page's hash and generator (game.js), so a seed means the same everywhere
  function hash(...parts) {
    let h = 2166136261 >>> 0;
    for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % 1000003;
  }
  function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const copy = (x) => JSON.parse(JSON.stringify(x));

  // a team made stronger than it is in Versus: expected points a play added to its offense and taken from what its
  // defense allows, pass and run. The owner's call (Oct 22): Denver about a third better than an average team, which
  // is 0.12 (with both sides calling as the engine would, Denver wins about 64% against the other 31 over 1,000 games;
  // overtime's luck keeps it from going much higher). Room and page both apply it (boostPool), once
  const TEAM_BOOST = { DEN: 0.12 };
  function boostPool(pool) {
    if (!pool || pool.boosted) return pool;
    const out = { ...pool, teams: { ...pool.teams }, boosted: true };
    for (const [t, b] of Object.entries(TEAM_BOOST)) {
      const x = out.teams[t];
      if (!x || !x.base) continue;
      out.teams[t] = { ...x, base: { ...x.base, off_pass: x.base.off_pass + b, off_rush: x.base.off_rush + b, def_pass: x.base.def_pass - b, def_rush: x.base.def_rush - b } };
    }
    return out;
  }
  // the engine's game record for two teams (teams.json: each team as it was in its last game, TEAM_BOOST on)
  function buildGame(pool, home, away) {
    pool = boostPool(pool);
    const H = pool.teams[home], A = pool.teams[away];
    if (!H || !A) throw new Error(`no team ${H ? away : home}`);
    return { home: H, away: A, home_spread: 0, indoor: false, wind: 0, temp: undefined, league: pool.league,
      home_coach: H.coach, away_coach: A.coach, season: pool.season };
  }

  // Versus's format (as EA Sports College Football has it): from the 25, two-point tries from the 2nd overtime, one-play
  // two-point possessions from the 3rd, a timeout each in the first two
  const VS_OT = { yl: 25, yl3: null, must2From: 2, alt2From: 3, altYl: 3, to: 1, toFrom3: 'none' };
  const fmtOf = (opt) => (opt && opt.ot) || VS_OT;
  const twoYlOf = (opt) => (opt && opt.twoYl) || 2;
  // each team's timeouts for an overtime period (to: theirs as the last one ended)
  function otTo(F, round, to, opt) {
    const k = F.to;
    if (round === 1) return F.toCarry && opt && opt.regTo ? [k + opt.regTo[0], k + opt.regTo[1]] : [k, k];
    if (round < 3) return [k, k];
    return F.toFrom3 === 'none' ? [0, 0] : F.toFrom3 === 'carry' ? (round === 3 ? [k, k] : to.slice()) : [k, k];
  }
  // a possession: at the format's spot (the other team's 25), or (from its alternating period: the 3rd overtime on) a
  // two-point play from its yard line (the 3)
  function possRoot(team, round, score, to, opt) {
    const F = fmtOf(opt), yl = round >= 3 && F.yl3 != null ? F.yl3 : F.yl;
    const base = { t: COT_T, pos: team, score: score.slice(), down: 1, ytg: Math.min(10, yl), yl, to: to.slice(), clock_running: false, phase: SNAP, credit: 0, free_kick: false };
    if (F.alt2From == null || round < F.alt2From) return base;
    const pat = { ...base, phase: PAT };
    return { ...pat, phase: SNAP, down: 1, ytg: F.altYl, yl: F.altYl, try2: pat };
  }
  // the coin toss (toss: the team that won it, 0 or 1, the server's coin); the winner chooses first
  function start(toss, opt) {
    toss = toss ? 1 : 0;
    return { root: possRoot(toss, 1, [0, 0], otTo(fmtOf(opt), 1, [0, 0], opt), opt), seq: 0, over: false, winner: -1, tricks: [0, 0],
      cot: { round: 1, idx: 0, order: [toss, 1 - toss], score0: [0, 0], toss, pick: { team: toss, end: false } } };
  }
  const chooser = (c) => (c.round % 2 ? c.toss : 1 - c.toss);

  // who has to answer this decision: the choosing team, both at a snap (offense and defense), the scoring team at a try
  function need(ms) {
    if (ms.over) return [];
    if (ms.cot.pick) return [ms.cot.pick.team];
    return ms.root.phase === SNAP ? [0, 1] : [ms.root.pos];
  }
  // what a decision is, for a seat: 'pick', 'offense', 'defense', 'pat' (null: nothing to answer)
  function role(ms, seat) {
    if (!need(ms).includes(seat)) return null;
    if (ms.cot.pick) return 'pick';
    if (ms.root.phase === PAT) return 'pat';
    return ms.root.pos === seat ? 'offense' : 'defense';
  }

  // a phone's call, as the engine may see it: known fields with known values only (anything else is dropped)
  function cleanAction(a, pb) {
    if (!a || typeof a !== 'object') return null;
    const o = {};
    if (typeof a.call === 'string' && pb && pb.callIndex && pb.callIndex[a.call] !== undefined) o.call = a.call;
    if (typeof a.play === 'string' && PLAYS.has(a.play)) o.play = a.play;
    if (a.oob === true) o.oob = true;
    if (Number.isInteger(a.pers) && a.pers >= 10 && a.pers <= 33) o.pers = a.pers;
    if (typeof a.route === 'string' && pb && pb.routeNames && pb.routeNames.includes(a.route)) o.route = a.route;
    if (typeof a.who === 'string' && WHO.has(a.who)) o.who = a.who;
    if (a.philly === true) o.philly = true;
    if (a.pat === 'two' || a.pat === 'xp') o.pat = a.pat;
    return o;
  }
  // the defense's call, cleaned: every part known, or nothing (the default)
  function cleanDef(d) {
    if (!d || typeof d !== 'object') return null;
    const o = { pers: d.pers, front: d.front, cover: d.cover, rush: +d.rush };
    return DC.pers.includes(o.pers) && DC.front.includes(o.front) && DC.cover.includes(o.cover) && DC.rush.includes(o.rush) ? o : null;
  }
  // a seat's half of a decision, cleaned for its role (null: not its decision, or nothing usable: the default)
  function cleanHalf(ms, seat, h, pb) {
    const r = role(ms, seat);
    if (!r || !h || typeof h !== 'object') return null;
    if (r === 'pick') return PICKS.includes(h.pick) && !(h.pick === 'end' && ms.cot.pick.end) ? { pick: h.pick } : null;
    if (r === 'defense') { const dc = cleanDef(h.dc); return dc ? { dc } : null; }
    if (r === 'pat') {
      if (h.two === true) return { two: true };
      const a = cleanAction(h.action, pb);
      return a && a.pat ? { action: { pat: a.pat } } : null;
    }
    if (h.timeout === true) return { timeout: true };
    const a = cleanAction(h.action, pb);
    // the calls the page offers here only (game.js callOptions): a sneak needs 3 yards or less to go; no Hail Mary
    // (overtime has no clock to beat)
    if (a && (a.call === 'hail_mary' || (a.call === 'qb_sneak' && ms.root.ytg > 3))) { delete a.call; delete a.route; delete a.who; }
    return a ? { action: a } : null;
  }

  function end(ms, notes, why) {
    ms.root = { ...ms.root, phase: DONE };
    ms.over = true;
    ms.winner = ms.root.score[0] > ms.root.score[1] ? 0 : 1;
    notes.push({ k: 'final', winner: ms.winner, score: ms.root.score.slice(), round: ms.cot.round, why });
  }
  // after each snap: the clock held; a touchdown from the 2nd overtime on goes for two; the possession over, the next
  // one, the next overtime or the end
  function after(ms, notes, opt) {
    const c = ms.cot, P = c.order[c.idx], D = 1 - P, F = fmtOf(opt), y2 = twoYlOf(opt);
    let r = ms.root;
    if (r.phase !== DONE) r = ms.root = { ...r, t: COT_T, clock_running: false };
    // a touchdown that puts the second team ahead: over, no try
    if (r.phase === PAT && r.pos === P && c.idx === 1 && r.score[P] > r.score[D]) return end(ms, notes, 'walkoff');
    if (r.phase === PAT && r.pos === P && F.must2From != null && c.round >= F.must2From) {
      ms.root = { ...r, phase: SNAP, down: 1, ytg: y2, yl: y2, clock_running: false, try2: { ...r } };
      notes.push({ k: 'must2', team: P });
      return;
    }
    const over = r.phase === KICKOFF || r.phase === DONE || (r.phase === SNAP && r.pos !== P) || (r.phase === PAT && r.pos !== P);
    if (!over) return;
    const sc = r.score.slice();
    ms.root = { ...r, score: sc };
    if (c.idx === 0 && sc[D] > c.score0[D]) return end(ms, notes, 'defense');     // the defense scored on the first possession
    if (c.idx === 0) {
      c.idx = 1;
      ms.root = possRoot(c.order[1], c.round, sc, r.to, opt);
      notes.push({ k: 'poss', team: c.order[1], round: c.round });
      return;
    }
    if (sc[0] !== sc[1]) return end(ms, notes, 'score');
    c.round += 1; c.idx = 0; c.score0 = sc.slice();
    c.order = [c.order[1], c.order[0]];          // the order flips: second last period, first this one
    ms.root = possRoot(c.order[0], c.round, sc, otTo(F, c.round, r.to, opt), opt);
    notes.push({ k: 'round', round: c.round, score: sc, first: c.order[0] });
  }

  // one decision: the halves (by seat, already cleaned; missing or null: the default), the engine's step
  // (step(root, action, seed) -> {root, log, done}) and the snap's seed (a uint32). Returns the new state (ms is not
  // changed), the engine's result (null when no play was run), what kind of decision it was and notes for the
  // play-by-play.
  function apply(ms0, halves, step, seed, opt) {
    const ms = copy(ms0), notes = [];
    if (ms.over) throw new Error('the match is over');
    const c = ms.cot, r = ms.root;
    const h = (s) => (halves && halves[s] != null ? halves[s] : null);
    if (c.pick) {
      const P = c.pick.team, x = h(P);
      const ch = x && PICKS.includes(x.pick) && !(x.pick === 'end' && c.pick.end) ? x.pick : null;
      if (ch === 'end') {
        notes.push({ k: 'end', team: P });
        c.pick = { team: 1 - P, end: true };
        ms.root = { ...r, pos: 1 - P };
        return { ms, res: null, kind: 'pick', notes };
      }
      const first = ch === 'offense' ? P : 1 - P;             // out of time: defense, the usual pick
      notes.push({ k: 'pick', team: P, choice: ch || 'defense', auto: !ch, first });
      c.pick = null; c.order = [first, 1 - first]; c.idx = 0;
      ms.root = possRoot(first, c.round, r.score, r.to, opt);
      return { ms, res: null, kind: 'pick', notes };
    }
    const off = h(r.pos), def = h(1 - r.pos);
    if (r.phase === SNAP && off && off.timeout && r.to[r.pos] > 0 && !r.try2) {
      ms.root = { ...r, to: r.to.slice() };
      ms.root.to[r.pos] -= 1;
      notes.push({ k: 'timeout', team: r.pos });
      return { ms, res: null, kind: 'timeout', notes };
    }
    if (r.phase === PAT && off && off.two) {
      ms.root = { ...r, phase: SNAP, down: 1, ytg: twoYlOf(opt), yl: twoYlOf(opt), clock_running: false, try2: { ...r } };
      notes.push({ k: 'two', team: r.pos });
      return { ms, res: null, kind: 'two', notes };
    }
    let a;
    if (r.phase === SNAP) {
      a = off && off.action ? { ...off.action } : (r.try2 ? { pat: 'two' } : {});
      if (r.try2) a.pat = 'two';
      if (def && def.dc) a.dc = { ...def.dc };
      // a trick play the defense has seen this match works less well (engine.js dcEffect 'seen_it')
      const trick = typeof a.call === 'string' && a.call.startsWith('trick');
      if (trick) a.seen = (ms.tricks || [0, 0])[r.pos];
      a.to_off = false; a.to_def = false;
    } else a = off && off.action ? { ...off.action } : { pat: 'xp' };
    ms.seq += 1;
    const res = step(r.try2 || r, a, seed >>> 0);
    res.action = a;
    if (r.phase === SNAP && typeof a.call === 'string' && a.call.startsWith('trick')) {
      ms.tricks = (ms.tricks || [0, 0]).slice();
      ms.tricks[r.pos] += 1;
    }
    if (a.philly) res.log.forEach((x) => { if (x.ev === 'pat') x.philly = true; });
    ms.root = res.root;
    if (res.done) ms.root.phase = DONE;
    after(ms, notes, opt);
    return { ms, res, kind: 'play', notes };
  }

  // what happened on the real play behind an outcome (game_worker.js describe: the same fields, for the animation)
  function describe(pb, row) {
    const P = pb, out = {};
    if (P.event) out.evt = P.eventNames[P.event[row]] || '';
    if (P.pen && P.pen[row]) out.pen = P.penNames[P.pen[row]];
    if (P.look) {
      const k = P.look[row];
      out.look = { form: ['', 'shotgun', 'under center', 'pistol'][k & 3], motion: !!(k & 4), blitz: !!(k & 8), box: k >> 4 };
    }
    if (P.air && P.air[row] !== -128) out.air = P.air[row];
    if (P.carry) { const c = P.carry[row]; out.who = ['', 'QB', 'RB', 'WR', 'TE'][c & 7] || ''; out.bt = !!(c & 8); }
    // how the ball got there (FTN charting, the play-by-play's passes defensed): game.js missOf draws the incompletion from it
    if (P.ball && (P.ball[row] & 1)) { const b = P.ball[row]; out.catchable = !!(b & 2); out.contested = !!(b & 4); out.defended = !!(b & 8); }
    if (P.ngs) {
      const g = P.ngs, rt = g.route[row], cv = g.cover[row], ru = g.rush[row], tt = g.ttt[row];
      if (rt) out.route = P.routeNames[rt];
      if (cv & 15) out.shell = P.shellNames[cv & 15];
      if (cv >> 4) out.man = (cv >> 4) === 1;
      if (ru & 32) { out.rushers = ru & 15; out.pressure = !!(ru & 16); }
      if (tt) out.ttt = tt / 10;
    }
    return out;
  }
  // a snap that has to convert (4th down, a two-point try) is never drawn as a throwaway (engine.js _noThrowaway draws
  // the play again; the few its pressure draw keeps are an incompletion like any other: the same 0 yards and the ball over)
  function noToss(e, root) {
    if (e.ev === 'play' && e.evt === 'throwaway' && root && (root.down === 4 || root.phase === PAT || root.try2)) e.evt = '';
  }
  // the snap as the defense called it, for the field and the play-by-play: its shell, its rush and its box (the real
  // play behind the outcome was run against that defense when enough of them were, engine.js sampleVsDefense)
  const SHELL = { c0: 'cover0', c1: 'cover1', '2man': '2man', c2: 'cover2', c3: 'cover3', c4: 'cover4', c6: 'cover6', prevent: 'prevent' };
  const MAN = new Set(['c0', 'c1', '2man']);
  function called(e, dc) {
    e.dc = { ...dc };
    e.shell = SHELL[dc.cover];
    e.man = MAN.has(dc.cover);
    const lo = { 3: 3, 4: 4, 5: 5, 6: 6 }[dc.rush], hi = dc.rush === 6 ? 7 : lo;
    if (e.kind === 1 && !(e.rushers >= lo && e.rushers <= hi)) e.rushers = lo;
    const box = { light: [5, 6, 6], even: [7, 7, 7], loaded: [8, 9, 8] }[dc.front];
    e.look = { ...(e.look || {}), blitz: dc.rush >= 5 };
    if (!(e.look.box >= box[0] && e.look.box <= box[1])) e.look.box = box[2];
  }
  // the engine's step for a match, as apply() wants it: one simulator for the two teams, the plays described
  // (makeSim: how to build it; the server's is board/lazy_sim.js, the same plays in a fraction of the memory)
  function stepper(eng, pool, home, away, makeSim) {
    const ctx = eng.makeContext(buildGame(pool, home, away), { receive2h: home });
    const sim = makeSim ? makeSim(eng, ctx) : eng.simulator(ctx);
    return (root, action, seed) => {
      const r = sim.step(root, { action, seed });
      r.log.forEach((e) => {
        if (e.ev === 'play' && e.row >= 0) Object.assign(e, describe(eng.pb, e.row));
        if (e.ev === 'play' && action && action.dc) called(e, action.dc);
        noToss(e, root);
      });
      return r;
    };
  }

  const CTORS = { int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, int32: Int32Array,
    uint32: Uint32Array, float32: Float32Array, float64: Float64Array };
  // The website's packed data (scripts/site.py pack, gunzipped; game_worker.js unpack, the same): "NFCP", the header's length, the
  // header (the JSON with each array as {dtype, n, enc, off, len}) and the arrays' bytes. enc: s = byte planes
  // shuffled, d = differences (summed back with the typed array's own wraparound), ds = both; x = the bytes XORed
  // with ref's array (the unpacked engine data: the playbook's plays are nearly all its library's) at the rows in src
  // (-1: none), xs = shuffled too. The playbook's pack needs the engine's: unpack(playbook, unpack(engine)).
  function unpack(buf, ref) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'NFCP') throw new Error('bad data pack');
    const hl = dv.getUint32(4, true), base = 8 + hl, srcs = new Map();
    const arrOf = (x) => {
      const C = CTORS[x.dtype], k = C.BYTES_PER_ELEMENT, n = x.n, src = u8.subarray(base + x.off, base + x.off + x.len);
      const bytes = new Uint8Array(n * k);
      if (x.enc.includes('s')) { for (let j = 0; j < k; j++) { const p = j * n; for (let i = 0; i < n; i++) bytes[i * k + j] = src[p + i]; } }
      else bytes.set(src);
      if (x.enc.includes('x')) {
        const r = x.ref.reduce((o, key) => (o ? o[key] : o), ref);
        if (!r || !r.arr || r.dtype !== x.dtype) throw new Error('data pack needs the engine data');
        if (!srcs.has(x.src.off)) srcs.set(x.src.off, arrOf(x.src));     // one row map, shared by the arrays
        const s = srcs.get(x.src.off), rb = new Uint8Array(r.arr.buffer, r.arr.byteOffset, r.arr.byteLength);
        for (let i = 0; i < n; i++) { const q = s[i] * k; if (q >= 0) for (let j = 0; j < k; j++) bytes[i * k + j] ^= rb[q + j]; }
      }
      const a = new C(bytes.buffer, 0, n);
      if (x.enc.includes('d')) for (let i = 1; i < n; i++) a[i] += a[i - 1];
      return a;
    };
    const walk = (x) => {
      if (Array.isArray(x)) return x.map(walk);
      if (!x || typeof x !== 'object') return x;
      if (x.off == null || !x.dtype) { const o = {}; for (const k in x) o[k] = walk(x[k]); return o; }
      return { dtype: x.dtype, n: x.n, arr: arrOf(x) };
    };
    return walk(JSON.parse(new TextDecoder().decode(u8.subarray(8, base))));
  }

  const VSCore = { SNAP, PAT, KICKOFF, DONE, COT_T, DC, PICKS, VS_OT, TEAM_BOOST, boostPool, hash, rng, buildGame, possRoot, start, chooser, need, role,
    cleanAction, cleanDef, cleanHalf, apply, after, describe, called, noToss, stepper, unpack };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = VSCore;
  if (global) global.VSCore = VSCore;       // (always: a page with some other script's global `module` still gets it)
})(typeof self !== 'undefined' ? self : this);
