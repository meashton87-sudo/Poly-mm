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
  // 4th down (the owner: the defense should know a kick is coming): the offense says first whether it goes for it or
  // kicks (cot.k4), and the defense calls knowing it: against a kick, the block or the safe call (engine.js act.st)
  const INTENTS = ['go', 'fg', 'punt'];
  const KICK_DEF = { fg: ['block', 'safe'], punt: ['rush', 'return'] };
  // a fake (the owner): the offense, lined up to kick, runs a trick instead, a direct snap or a trick pass (the real
  // trick plays: no charting has fakes of their own), against the defense its kick call made: everyone sent after the
  // kick leaves nobody home; staying home is a normal look
  const FAKES = { run: 'trick_direct', pass: 'trick_pass' };
  // (the engine has no kick formation: a fake is drawn against an ordinary look, and the defense's kick call decides
  // whether it is a surprise. Everyone sent after the kick is caught out (no trick seen); a defense staying home is
  // waiting for it, as one that has seen the trick twice (engine.js SEEN_IT, the most it takes off))
  const KICK_DC = { pers: 'base', front: 'even', cover: 'c3', rush: 4 };
  const READY = { block: 0, rush: 0, safe: 2, return: 2 };
  // what 4th down offers from here: a field goal inside the 50 (a 67-yarder at most), a punt from 30 yards out or more
  const intentsAt = (r) => INTENTS.filter((k) => k === 'go' || (k === 'fg' ? r.yl <= 50 : r.yl >= 30));
  // the 4th-down question is up: a snap on 4th down (not a try) with no answer yet
  const at4 = (ms) => ms.root.phase === SNAP && ms.root.down === 4 && !ms.root.try2 && !ms.cot.k4;
  const kicking = (ms) => ms.root.phase === SNAP && (ms.cot.k4 === 'fg' || ms.cot.k4 === 'punt');
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
    if (at4(ms)) return [ms.root.pos];
    if (kicking(ms)) return [0, 1];
    return ms.root.phase === SNAP ? [0, 1] : [ms.root.pos];
  }
  // what a decision is, for a seat: 'pick', 'intent' (4th down: go or kick), 'kickdef' (against the kick), 'offense',
  // 'defense', 'pat' (null: nothing to answer)
  function role(ms, seat) {
    if (!need(ms).includes(seat)) return null;
    if (ms.cot.pick) return 'pick';
    if (ms.root.phase === PAT) return 'pat';
    if (at4(ms)) return 'intent';
    if (kicking(ms)) return ms.root.pos === seat ? 'kick' : 'kickdef';
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
    // (and the page's curl and comeback, which the engine reads as the throws on a hitch and a deep out: engine.js ROUTE_ALIAS)
    if (typeof a.route === 'string' && pb && pb.routeNames && (pb.routeNames.includes(a.route) || a.route === 'curl' || a.route === 'comeback')) o.route = a.route;
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
    // (a timeout: the defense's too, at the snap or against a kick, while it has one)
    const toOk = h.timeout === true && ms.root.to && ms.root.to[seat] > 0;
    if (r === 'intent') return intentsAt(ms.root).includes(h.intent) ? { intent: h.intent } : null;
    if (r === 'kickdef') return toOk ? { timeout: true } : KICK_DEF[ms.cot.k4].includes(h.st) ? { st: h.st } : null;
    if (r === 'kick') return FAKES[h.fake] ? { fake: h.fake } : h.kick === true ? { kick: true } : null;
    if (r === 'defense') { if (toOk) return { timeout: true }; const dc = cleanDef(h.dc); return dc ? { dc } : null; }
    if (r === 'pat') {
      if (h.two === true) return { two: true };
      const a = cleanAction(h.action, pb);
      return a && a.pat ? { action: { pat: a.pat } } : null;
    }
    if (h.timeout === true) return { timeout: true };
    const a = cleanAction(h.action, pb);
    // (a kick only by saying so on 4th down: the defense knows it is coming)
    if (a && (a.play === 'fg' || a.play === 'punt')) delete a.play;
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
    // 4th down: go for it or kick (out of time: the kick from 32 yards out or closer, a try of 49 at most; else go)
    if (at4(ms)) {
      const ok = intentsAt(r), ch = off && ok.includes(off.intent) ? off.intent : r.yl <= 32 && ok.includes('fg') ? 'fg' : 'go';
      c.k4 = ch;
      notes.push({ k: 'intent', team: r.pos, choice: ch, auto: !(off && off.intent) });
      return { ms, res: null, kind: 'intent', notes };
    }
    const timeout = (t) => {
      ms.root = { ...r, to: r.to.slice() };
      ms.root.to[t] -= 1;
      notes.push({ k: 'timeout', team: t });
      return { ms, res: null, kind: 'timeout', notes };
    };
    if (r.phase === SNAP && off && off.timeout && r.to[r.pos] > 0 && !r.try2 && !kicking(ms)) return timeout(r.pos);
    if (r.phase === SNAP && def && def.timeout && r.to[1 - r.pos] > 0) return timeout(1 - r.pos);
    // the kick they said was coming, against the defense's call on it
    if (kicking(ms)) {
      const k = c.k4, st = def && KICK_DEF[k].includes(def.st) ? def.st : null;
      let a = { play: k, to_off: false, to_def: false, ...(st ? { st } : {}) };
      if (off && FAKES[off.fake]) {             // the fake: the trick against the kick defense called
        a = { call: FAKES[off.fake], play: 'go', dc: { ...KICK_DC }, seen: READY[st || KICK_DEF[k][1]], to_off: false, to_def: false };
        ms.tricks = (ms.tricks || [0, 0]).slice();
        ms.tricks[r.pos] += 1;
        notes.push({ k: 'fake', team: r.pos, kick: k, fake: off.fake });
      }
      c.k4 = null;
      ms.seq += 1;
      const res = step(r, a, seed >>> 0);
      res.action = a;
      ms.root = res.root;
      if (res.done) ms.root.phase = DONE;
      after(ms, notes, opt);
      return { ms, res, kind: 'play', notes };
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
      // going for it on 4th down: no call in time is the engine's own play, never its kick (engine.js forced 'go')
      if (c.k4 === 'go' && !a.call && !a.play) a.play = 'go';
      if (def && def.dc) a.dc = { ...def.dc };
      // a trick play the defense has seen this match works less well (engine.js dcEffect 'seen_it')
      const trick = typeof a.call === 'string' && a.call.startsWith('trick');
      if (trick) a.seen = (ms.tricks || [0, 0])[r.pos];
      a.to_off = false; a.to_def = false;
    } else a = off && off.action ? { ...off.action } : { pat: 'xp' };
    ms.seq += 1;
    c.k4 = null;                    // (4th down's answer is for this snap only)
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

  // ------------------------------------------------------------------------------------------------- the draft ---
  // Versus Draft (the owner, Oct 26-27: a blind auction). Nobody brings a team. Both players get DRAFT.budget dollars;
  // cards come up one at a time, slot by slot (DRAFT.order: the quarterbacks, then the backs...), each a TEAM's man at
  // that slot (draftPool: DRAFT.pool of each kind, each from a different team). A card is blind: the phones see the
  // team and the slot, never the man (draftMask), until the draft is over. The bidding is open, back and forth: a card
  // opens with no bid and DRAFT.openMs on the clock; a side that still needs the kind (DRAFT.slots) claims it for $0 or
  // beats the bid by a dollar or more (draftCanBid), never over what leaves a dollar for each slot still open
  // (draftMax), never raising its own bid; every bid puts DRAFT.raiseMs back on the clock (DRAFT.closeMs when the
  // other side cannot top it). At the deadline the high bid takes the card at its price (draftResolve); a card nobody
  // claimed passes to nobody; a kind both sides have is skipped (draftAdvance). What a side still needs when the pool
  // is out, draftFill gives for nothing. The two sides play as DRAFT.teams, each put together by draftTeam.
  const DRAFT = { budget: 50, slots: { QB: 1, RB: 1, WR: 2, TE: 1, OL: 1, DST: 1 }, pool: { QB: 3, RB: 3, WR: 5, TE: 3, OL: 3, DST: 3 },
    order: ['QB', 'RB', 'WR', 'TE', 'OL', 'DST'], teams: ['DR1', 'DR2'], openMs: 15000, raiseMs: 7000, closeMs: 2500 };
  const OL_POS = ['LT', 'LG', 'C', 'RG', 'RT'];
  const TEAM_CODE = /^[A-Z]{2,3}$/;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const shuffled = (xs, rnd) => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ovrOf = (p) => (p && Number.isFinite(p.ovr) ? p.ovr : 70);
  const best = (ps) => ps.slice().sort((a, b) => ovrOf(b) - ovrOf(a))[0] || null;
  // one card of a kind from a team (null when the team has nobody for it)
  function draftCard(team, code, k) {
    const L = (team && team.lineup) || {}, off = L.off || [], def = L.def || [];
    const card = (p, extra) => (p ? { k, team: code, name: p.name, pos: p.pos || k, num: p.num, ovr: ovrOf(p), stat: p.stat || '', ...extra } : null);
    if (k === 'QB') return card(off.find((p) => p.pos === 'QB'), { adj: (team.qb && team.qb.adjustment) || 0 });
    if (k === 'RB') return card(best(off.filter((p) => p.pos === 'RB' || p.pos === 'FB')));
    if (k === 'WR') return card(best(off.filter((p) => p.pos === 'WR')));
    if (k === 'TE') return card(best(off.filter((p) => p.pos === 'TE')));
    if (k === 'OL') {
      const line = off.filter((p) => OL_POS.includes(p.pos));
      return line.length ? { k, team: code, name: `${code} offensive line`, pos: 'OL', ovr: Math.round(mean(line.map(ovrOf))), stat: line.map((p) => p.name).join(', ') } : null;
    }
    if (k === 'DST') {
      if (!def.length) return null;
      const kk = team.kicker && team.kicker.name ? `K ${team.kicker.name}` : '';
      return { k, team: code, name: `${code} defense & special teams`, pos: 'DST', ovr: Math.round(mean(def.map(ovrOf))), stat: [best(def) && `${best(def).pos} ${best(def).name}`, kk].filter(Boolean).join(' · ') };
    }
    return null;
  }
  // the card as a phone sees it while the draft is on: the team and the slot only
  const draftMask = (c) => (c ? { k: c.k, team: c.team, pos: c.pos } : null);
  // the pool: DRAFT.pool cards of each kind, each kind's from different teams, in DRAFT.order (shuffled within a kind)
  function draftPool(pool, rnd) {
    const codes = Object.keys(pool.teams).filter((c) => TEAM_CODE.test(c) && pool.teams[c] && pool.teams[c].lineup);
    const cards = [];
    for (const k of DRAFT.order) {
      let n = 0;
      for (const c of shuffled(codes, rnd)) {
        const card = draftCard(pool.teams[c], c, k);
        if (!card) continue;
        cards.push(card);
        if (++n >= DRAFT.pool[k]) break;
      }
    }
    return cards;
  }
  const draftNew = (cards) => ({ budget: [DRAFT.budget, DRAFT.budget], need: [{ ...DRAFT.slots }, { ...DRAFT.slots }], picks: [[], []], pool: cards, i: 0, bid: null, deadline: 0, last: null });
  const draftOpen = (d, s) => Object.values(d.need[s]).reduce((a, b) => a + b, 0);
  const draftNeeds = (d, s, k) => (d.need[s][k] || 0) > 0;
  // the most a side may bid: a dollar kept for each slot still open after this one
  function draftMax(d, s, card) {
    if (!card || !draftNeeds(d, s, card.k)) return 0;
    return Math.max(0, d.budget[s] - (draftOpen(d, s) - 1));
  }
  // may this side bid so much on the card up: it needs the kind, it is not the high bidder, the amount is a whole
  // dollar within its most and over the bid in (a $0 claim when there is none)
  function draftCanBid(d, s, amount) {
    const card = d.pool[d.i], b = d.bid;
    if (!card || !Number.isInteger(amount) || amount < 0) return false;
    if (b && b.seat === s) return false;
    if (b && amount <= b.amount) return false;
    return amount <= draftMax(d, s, card);
  }
  // can this side still top the bid in
  const draftCanTop = (d, s) => { const b = d.bid; return b ? draftCanBid(d, s, b.amount + 1) : draftCanBid(d, s, 0); };
  const draftDone = (d) => d.i >= d.pool.length || (draftOpen(d, 0) === 0 && draftOpen(d, 1) === 0);
  // past the cards nobody needs any more (a kind both sides have)
  function draftAdvance(d) {
    while (d.i < d.pool.length && !draftNeeds(d, 0, d.pool[d.i].k) && !draftNeeds(d, 1, d.pool[d.i].k)) d.i += 1;
    return d;
  }
  // the clock ran out on the card up: the high bid takes it at its price, or nobody does. Mutates d (the next card
  // wanted is up after it) and returns the outcome, or null when no card was up
  function draftResolve(d) {
    const card = d.pool[d.i];
    if (!card) return null;
    const b = d.bid && draftNeeds(d, d.bid.seat, card.k) ? d.bid : null;
    const out = { i: d.i, card, seat: b ? b.seat : -1, amount: b ? b.amount : 0 };
    if (b) {
      d.budget[b.seat] -= b.amount;
      d.need[b.seat][card.k] -= 1;
      d.picks[b.seat].push({ ...card, paid: b.amount });
    }
    d.i += 1;
    d.bid = null;
    d.last = out;
    draftAdvance(d);
    return out;
  }
  // what the pool ran out of: a player of that kind from a team not yet on the side, for nothing
  function draftFill(d, pool, rnd) {
    const codes = Object.keys(pool.teams).filter((c) => TEAM_CODE.test(c) && pool.teams[c] && pool.teams[c].lineup);
    for (const s of [0, 1]) {
      for (const k of DRAFT.order) {
        while (draftNeeds(d, s, k)) {
          const have = new Set(d.picks[s].map((p) => `${p.k}:${p.team}`));
          const c = shuffled(codes, rnd).find((x) => !have.has(`${k}:${x}`) && draftCard(pool.teams[x], x, k)) || codes[0];
          const card = draftCard(pool.teams[c], c, k) || { k, team: c, name: `${c} ${k}`, pos: k, ovr: 60, stat: '' };
          d.picks[s].push({ ...card, paid: 0, filler: true });
          d.need[s][k] -= 1;
        }
      }
    }
    return d;
  }
  // the computer: what the card up is worth to it (draftCpuValue, worked out as the card goes up: its share of its
  // money for the slot, more for a better man and a scarcer kind, a little noise; its last chance at a kind, half
  // again as much) and its move in the bidding (draftCpuBid: a $0 claim, or a dollar over the bid in, sometimes two,
  // up to that worth; null when it sits)
  const DRAFT_W = { QB: 1.8, OL: 1.1, DST: 1.3, WR: 1.0, RB: 0.8, TE: 0.7 };
  function draftCpuValue(d, s, rnd) {
    const card = d.pool[d.i], max = draftMax(d, s, card);
    if (!max) return 0;
    const per = d.budget[s] / Math.max(1, draftOpen(d, s)), q = Math.max(0.3, Math.min(1.6, (card.ovr - 55) / 25));
    const left = d.pool.slice(d.i + 1).filter((c) => c.k === card.k).length, last = left < d.need[s][card.k];
    const v = Math.round(per * (DRAFT_W[card.k] || 1) * q * (0.8 + 0.4 * rnd()) * (last ? 1.5 : 1));
    return Math.max(1, Math.min(max, v));
  }
  function draftCpuBid(d, s, value, rnd) {
    if (!draftCanTop(d, s)) return null;
    const next = d.bid ? d.bid.amount + 1 + (rnd() < 0.3 ? 1 : 0) : 0;
    const amount = Math.min(next, draftMax(d, s, d.pool[d.i]));
    return amount <= Math.max(0, value) && draftCanBid(d, s, amount) ? amount : null;
  }
  // a side's team from its picks: the ratings a blend of its players' teams' (the quarterback and the line most of the
  // passing and the running; the defense and the kickers the defense's team's), the quarterback's own adjustment, the
  // lineups made of the men picked (the line's team filling the rest of its offense), named and colored as the side
  function draftTeam(pool, picks, code, name) {
    const T = (c) => pool.teams[c] || {};
    const by = (k) => picks.filter((p) => p.k === k);
    const qb = by('QB')[0], rb = by('RB')[0], wrs = by('WR'), te = by('TE')[0], ol = by('OL')[0], dst = by('DST')[0];
    const base = (p, f) => { const t = p && T(p.team); return t && t.base && Number.isFinite(t.base[f]) ? t.base[f] : null; };
    const blend = (f, parts) => { const xs = parts.filter(([p]) => base(p, f) != null); const w = xs.reduce((a, [, k]) => a + k, 0); return w ? xs.reduce((a, [p, k]) => a + base(p, f) * k, 0) / w : 0; };
    const off_pass = blend('off_pass', [[qb, 0.35], [ol, 0.25], [wrs[0], 0.15], [wrs[1], 0.1], [te, 0.1], [rb, 0.05]]);
    const off_rush = blend('off_rush', [[ol, 0.4], [rb, 0.3], [qb, 0.1], [te, 0.1], [wrs[0], 0.05], [wrs[1], 0.05]]);
    const D = dst ? T(dst.team) : {}, Q = qb ? T(qb.team) : {}, O = ol ? T(ol.team) : Q;
    const anchor = Q.lineup ? Q : O.lineup ? O : D.lineup ? D : {};
    const player = (p) => { const t = T(p.team), x = ((t.lineup || {}).off || []).find((y) => y.name === p.name); return { ...(x || { name: p.name, ovr: p.ovr, stat: p.stat, num: p.num }), pos: p.pos }; };
    const skill = [qb, rb, ...wrs, te].filter(Boolean).map(player);
    const lineTeam = ((O.lineup || {}).off || []);
    const line = lineTeam.filter((p) => OL_POS.includes(p.pos));
    // the line's team's offense as the shape (its count at each spot): the picks take their spots first, the line's
    // team's own men fill what is left (a third receiver, a fullback)
    const shape = {};
    lineTeam.forEach((p) => { shape[p.pos] = (shape[p.pos] || 0) + 1; });
    const off = [...skill, ...line], count = (pos) => off.filter((q) => q.pos === pos).length;
    for (const p of lineTeam) if (off.length < 11 && !OL_POS.includes(p.pos) && !off.some((q) => q.name === p.name) && count(p.pos) < (shape[p.pos] || 0)) off.push(p);
    const calls = {};
    for (const c of new Set([...Object.keys(Q.calls || {}), ...Object.keys(D.calls || {})])) {
      calls[c] = { off: ((Q.calls || {})[c] || (D.calls || {})[c] || {}).off, def: ((D.calls || {})[c] || (Q.calls || {})[c] || {}).def };
    }
    return { ...anchor, team: code, coach: name || code, qb: { name: qb ? qb.name : (anchor.qb || {}).name, adjustment: qb ? qb.adj || 0 : 0 },
      base: { ...(anchor.base || {}), off_pass, off_rush, def_pass: D.base ? D.base.def_pass : (anchor.base || {}).def_pass || 0, def_rush: D.base ? D.base.def_rush : (anchor.base || {}).def_rush || 0 },
      injury_adjustment: { off_pass: 0, off_rush: 0, def_pass: 0, def_rush: 0 }, kicker: D.kicker || anchor.kicker, punter: D.punter || anchor.punter, kickers: [],
      lineup: { off: off.slice(0, 11), def: ((D.lineup || {}).def || (anchor.lineup || {}).def || []).slice(), bench: [], qbs: [] }, calls, draft: picks.map((p) => ({ k: p.k, team: p.team, name: p.name, paid: p.paid })) };
  }
  // the pool with the two drafted sides in it (buildGame reads DRAFT.teams out of it)
  const draftPoolWith = (pool, teams) => ({ ...pool, teams: { ...pool.teams, ...teams } });

  const VSCore = { SNAP, PAT, KICKOFF, DONE, COT_T, DC, PICKS, INTENTS, KICK_DEF, FAKES, intentsAt, VS_OT, TEAM_BOOST, boostPool, hash, rng, buildGame, possRoot, start, chooser, need, role,
    cleanAction, cleanDef, cleanHalf, apply, after, describe, called, noToss, stepper, unpack,
    DRAFT, draftPool, draftCard, draftMask, draftNew, draftOpen, draftNeeds, draftMax, draftCanBid, draftCanTop, draftDone, draftAdvance, draftResolve, draftFill, draftCpuValue, draftCpuBid, draftTeam, draftPoolWith };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = VSCore;
  if (global) global.VSCore = VSCore;       // (always: a page with some other script's global `module` still gets it)
})(typeof self !== 'undefined' ? self : this);
