/* nflclock browser engine: a line-for-line port of src/nflclock/sim.py (and the pieces of
 * library.py, ratings.py, wp.py and context.py it needs). Runs in a page, a Web Worker, or Node.
 *
 *   const eng = new NFLClockEngine(engineData);          // engine_data.json
 *   const ctx = eng.makeContext(gameRecord, {receive2h: 'LA', manual: {}});
 *   const sim = eng.simulator(ctx);
 *   const res = sim.run(root, {n: 6000, action: {to_def: true}, perspective: 0, seed: 7});
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ decoding ---
  const CTORS = {
    int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, int32: Int32Array,
    float32: Float32Array, float64: Float64Array,
  };
  function b64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function decode(spec) {
    if (spec.arr) return spec.arr;       // already unpacked from the website's packed data (game_worker.js)
    const bytes = b64ToBytes(spec.b64);
    const C = CTORS[spec.dtype];
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new C(buf, 0, spec.n);
  }

  // ---------------------------------------------------------------- constants ---
  const RUN = 0, PASS = 1, KNEEL = 2, SPIKE = 3, FG = 4, PUNT = 5;
  const PLAY = { run: RUN, pass: PASS, kneel: KNEEL, spike: SPIKE, fg: FG, punt: PUNT };
  const HURRY = 0, NORMAL = 1, MILK = 2, T_SPIKE = 3, T_KNEEL = 4, URGENT = 5, T_FIRE = 6;
  const BURN_SECONDS = 8.0;            // leading in the last seconds: any snap is played to run out the clock
  const FIRE_DRILL = [7.0, 12.0];      // seconds to rush the field-goal unit on with the clock running
  const KNEEL_RUNOFF = [38.0, 40.0];   // seconds run off between kneels (40 s play clock)
  const FIRE_DRILL_LOGIT = -0.3;       // rushed kicks are a little less accurate
  // the fitted kick model runs long past 52 yards (few kicks there); taper it to the NFL's 2016-26 makes:
  // 60-61 yd 46%, 64-65 27%, 66+ 23% (the fit said 59/47/40% for a typical kicker indoors)
  const FG_LONG = [52.0, 0.045, 60.0, 0.05];
  const XP_LOGIT = 0.35;               // an extra point beats a 33-yard field goal (snapped from the middle): 2023-25 ~95.7%
  // blocked kicks, every kick (NFL 2016-25: 192 of 10,731 field goals, 110 of 12,818 extra points): by distance, the
  // most yards first; a block is one of the misses (the make chance is the kick model's, which counts blocks as
  // misses), returned for a touchdown 11 times in 192, otherwise the defense's ball 12 yards behind the line on average
  const FG_BLOCK = [[29, 0.005], [44, 0.0155], [59, 0.0275], [Infinity, 0.10]], XP_BLOCK = 0.0086;
  const FG_BLOCK_TD = 0.057, FG_BLOCK_BACK = 12;
  const FIRE_WINDOW = 25.0;            // seconds left in the half below which a kick with the clock running is a fire drill
  const CLOCK_EPS = 1e-6;              // a clock left this close to the end of the half has run out (the tenths summed drift by 1e-14: a snap at 0:00)
  // Clock-aware play calls when the offense needs the clock stopped and has no timeouts (2020-25 data):
  // a pass that would end in bounds with a gain is kept with this probability, otherwise redrawn from the
  // same pool's incompletions / catches out of bounds; and the pass rate rises from ~81% to ~95%.
  const CLOCK_AWARE = [[20.0, 0.53], [35.0, 0.79]];  // [seconds left in the half at the snap, keep probability]
  const CLOCK_PASS_SHIFT = 1.5, CLOCK_PASS_WINDOW = 60.0;
  const LIVE_MASK = 1 | 4 | 8 | 16 | 32 | 64 | 128;  // penalty, incomplete, oob, td, td_def, turnover, safety
  // Kick-to-win endgame: trailing by 1-2 or tied, a makeable kick in hand and a timeout to stop the clock
  // for it. The offense runs the clock down (clock-killing plays, timeouts kept), takes a timeout with
  // ~3 s left and kicks. The defense spends its timeouts to save time for a reply.
  // (CLOSE_FG_P: a ~52-yarder. NFL 2016-25, trailing by 1-2 or tied in the last 20-75 s with a timeout: 96% clock-
  // killing runs inside the 25, 60% at the 30-35, 38% at the 35-40: from farther out they keep moving.)
  const CLOSE_FG_P = 0.7, CLOSE_WINDOW = 180.0, CLOSE_END = 45.0, CLOSE_KICK_AT = 3.0;
  const CLOSE_SNAP_FLOOR = 12.0, CLOSE_DEF_WINDOW = 120.0;
  // The defense saves time only if, stopping the clock after every down it has a timeout for (a play ~6 s, a gap run
  // down ~39 s), it gets the ball back with this long left: a kickoff and a few throws to a long kick
  const CLOSE_REPLY = 30.0, CLOSE_PLAY = 6.0, CLOSE_GAP = 39.0;
  // A hurry-up from a running clock in the last minute is faster: the urgent draw is scaled and capped, from x0.75 and
  // 18 s at 0:00 to as drawn and 26 s at 1:00 (NFL 2016-25 no-huddle snaps after the whistle: median 15.8 s over the
  // whole pool, 13.4 s inside 0:30 and 11.8 s inside 0:20; the last minute's p99 26 s, inside 0:30 22 s)
  const URGENT_LATE = [60.0, 0.75, 18.0, 26.0];
  // 4th down, the sound choice (NFL coaches 2020-25): a go must beat the best kick by this much win probability (the
  // one-step look-ahead overrates keeping the ball: up 10 at 5:00 its WP is 0.76-0.92 for a team that wins ~97%)
  const FOURTH_GO_EDGE = 0.02;
  // ... and coaches all but never go for it on 4th and 2+ in their own half (2-10%), or 4th and 1 inside their 20 (6%),
  // unless trailing in the last 3:00 (by 4+ in the last 5:00, by 9+ in the last 7:00: then no edge either); trailing
  // by 9+ in the last 5:00 nobody punts from the other half (0-2%); and a field goal that ties or takes the lead in the
  // last 5:00 is kicked on 4th and 2+ when it is a good one (67-100%)
  const FOURTH_KICK_P = 0.75;
  // ... and a team one or two scores behind (1-16) does not punt in the last 1:30, or 9-16 behind in the last 2:30
  // (NFL 2016-25: 1 punt in 751 4th downs, 2 in 365); the coaches' own model punted down 10 at 1:00 from its 40
  const NO_PUNT_BEHIND = [16, 90.0, 9, 150.0];
  const KO_TOUCHBACK = 65;             // daily game: a kickoff through the end zone starts the receivers at their 35 (2025 rule)
  const PB_TD_SHARE = 0.6;            // daily game: a playbook touchdown drawn farther out scores only if it covered 60% of the way
  // daily game: matchups. Every call against the defense's call (a blitz, a loaded box, or playing soft: a light box,
  // nobody blitzing, everyone else in coverage): +1 when the call beats it, -1 when it loses to it, measured on the
  // real plays (this library, 2022-26): each play's EPA against its call's mean in its situation, by look, then
  // double-centered (what a matchup adds is the interaction: which calls do better or worse against a look than calls
  // do against it in general; the real plays a look draws already carry its own effect). The data's sign at +-1
  // where it is clear (|z| >= 2), +-0.5 where it leans (1.5 <= |z| < 2); elsewhere football logic at +-0.5, or 0 where
  // the data points the other way. The real interaction: runs gain into a light box (+0.015 EPA) and lose into a loaded
  // one (-0.014); quick passes beat the blitz (+0.032) and screens beat it and a loaded box (+0.06, +0.07); with
  // nobody blitzing and seven in coverage, quick passes (-0.013) and screens (-0.042) fare worse, deep shots no worse
  // (+0.028); deep shots lose to the blitz (-0.085), play action wins against a loaded box (+0.046).
  // The play is still a real one; its odds tilt toward better or worse outcomes by
  // exp(MATCH_TILT * s * EPA), so a call into the teeth of the defense gets blown up far more often than the
  // ~0.05-point real gaps would make it (a game choice: the real gaps are too small to feel play by play). The tilt is
  // scaled to each pool's own spread of EPA: a winning matchup is a fifth of a standard deviation better, so a run into
  // a light box gains about 6 yards a carry instead of the real 4.8, not a big play every time (a flat 0.45 points made
  // it 11.5), and a deep shot's swing stays a deep shot's
  const MATCH_SD = 0.2;              // a full matchup (s = +-1) moves a call's mean EPA by this share of its own spread
  const MATCH_EPA_CAP = 3;
  const MATCH_AUDIBLE = 0.9;
  // daily game: a pass you keep calling (act.rep: the same route or call this many times in your last 4 snaps, game.js
  // repOf) is one the defense sits on: from the third time on, each repeat moves the matchup by this much (a full
  // matchup moves the mean by MATCH_SD of the call's spread). The defense's habit, not the real plays: they stay real
  const REPEAT_S = 0.4;
  const repeatS = (act) => -REPEAT_S * Math.max(0, Math.min(act.rep | 0, 4) - 1);
  // daily game: a back's run blocked your way (act.scheme, game.js SCHEMES) against the defense's call: football logic,
  // as the trick plays' (no charting says which scheme a real run used), a few tenths of a matchup at most. Power and
  // duo bring an extra hat to a loaded box; a blitz gets in before a puller; a trap punishes the penetration;
  // counter's misdirection works on a light box
  const SCHEME_M = { power: { soft: 0, load: 0.3, blitz: -0.2 }, counter: { soft: 0.2, load: 0.1, blitz: -0.3 },
    duo: { soft: -0.2, load: 0.3, blitz: 0 }, trap: { soft: 0, load: -0.3, blitz: 0.4 } };
  const schemeS = (act, id, def) => (act.scheme && SCHEME_M[act.scheme] && def && /^rb_/.test(id || '') ? SCHEME_M[act.scheme][def] || 0 : 0);
  // daily game: your pass protection (act.prot, game.js PROTS): the back ('back') or the back and the tight end ('max')
  // stay in to block. No charting says how many blocked on a real play, but NGS charts how many rushed and whether the
  // passer was pressured: in the playbook's plays, pressure on 21% of dropbacks against 3 rushers, 27% against 4, 36%
  // against 5, 44% against 6 (about x1.3 a rusher, the sacks with it). A blocker more counts as a rusher fewer: the
  // pressured real plays (most of the sacks, scrambles and throwaways among them) drawn PROT_F as often for each, the
  // clean ones in their place. Its cost is on the field: the men who stay in run no route and can't be thrown to
  const PROT_N = { back: 1, max: 2 }, PROT_F = 0.78;
  const protOf = (act) => (act && PROT_N[act.prot]) || 0;
  const dcDef = (dc) => (dc.front === 'loaded' ? 'load' : +dc.rush >= 5 ? 'blitz' : 'soft');          // when you call their defense, the offense checks into calls that beat it
  const RUN_M = { blitz: 0, load: -1, soft: 1 }, DEEP_M = { blitz: -1, load: 0.5, soft: 0 };
  const MATCH = {
    rb_out_strong: RUN_M, rb_out_weak: RUN_M, rb_tackle_strong: RUN_M, rb_tackle_weak: RUN_M, rb_inside_strong: RUN_M,
    rb_inside_weak: RUN_M, rb_middle: RUN_M, qb_sneak: { blitz: 0, load: 0, soft: 0 }, qb_run: { blitz: 0.5, load: -0.5, soft: 0.5 },
    rpo_strong: { blitz: 0.5, load: 0.5, soft: 0 }, rpo_weak: { blitz: 0.5, load: 0.5, soft: 0 },
    quick_strong: { blitz: 1, load: 0.5, soft: -0.5 }, quick_weak: { blitz: 1, load: 0.5, soft: -0.5 },
    quick_middle: { blitz: 1, load: 0.5, soft: -0.5 }, screen: { blitz: 1, load: 1, soft: -1 },
    deep_strong: DEEP_M, deep_weak: DEEP_M, deep_middle: DEEP_M, pa_deep: { blitz: -0.5, load: 0.5, soft: 0 },
    pa_short: { blitz: -0.5, load: 1, soft: 0 }, roll_strong: { blitz: -0.5, load: 0.5, soft: 0 }, roll_weak: { blitz: -0.5, load: 0.5, soft: 0 },
    hail_mary: { blitz: 0, load: 0, soft: 0 },
    // trick plays (too few real ones to tell, football logic): the flea-flicker and the receiver pass sell the run (a
    // loaded box bites; a blitz gets home before the slow throw; seven in coverage stay deep); the end-around beats a
    // blitz flowing to the run; the direct snap is a run with an extra blocker, into a loaded box
    trick_flea: { blitz: -0.5, load: 0.5, soft: -0.5 }, trick_pass: { blitz: 0, load: 0.5, soft: -0.5 },
    trick_reverse: { blitz: 0.5, load: 0, soft: 0 }, trick_direct: { blitz: 0, load: -0.5, soft: 0 },
  };
  // the defense's call a look stands for (lookBucket: 0 light box, 1 light + blitz, 2 loaded box, 3 loaded + blitz)
  const LOOK_DEF = ['soft', 'blitz', 'load', 'blitz'];
  // The defense's whole call (act.dc): personnel, front, coverage and pass rush. The offense's play is a real NFL play
  // run against that defense, as each play was charted (NGS and FTN: pass rushers, coverage shell, men in the box,
  // defensive backs): the rush first (it decides the pressure, the sacks and the time to throw), widening the
  // situation before giving up a filter (sampleVsDefense). Its average worth is the offense's own there plus the
  // defense's effect on that kind of play, estimated from the charted plays (playbook.py dc_effects: small, a few
  // hundredths of a point a play; what a call changes is how the play goes, which the real plays carry)
  const DC_MIN = 30;                  // plays charted against the called defense before a draw keeps a filter
  const DC_ROWS_CAP = 3e6;            // plays kept in the shared sets a draw widens to (12 MB), _rowSet
  const DC_READ = 4;                  // daily game: an offense that reads your call favors what beats it, by
                                      // exp(DC_READ x its edge in EPA) (a quantal response; the edges are small)
  // how sharply it reads (act.read: true, or a number: a spot's harder computer opponent reads by more)
  const readOf = (act) => (typeof act.read === 'number' ? act.read : 1);
  const DC = {
    pers: { heavy: [1, 3], base: [4, 4], nickel: [5, 5], dime: [6, 7] },         // defensive backs on the field
    front: { light: [1, 6], even: [7, 7], loaded: [8, 15] },                      // men in the box
    rush: { 3: [1, 3], 4: [4, 4], 5: [5, 5], 6: [6, 11] },                        // pass rushers
    cover: { c0: [1], c1: [2], '2man': [4], c2: [3], c3: [5, 8], c4: [6], c6: [7], prevent: [9] },   // playbook.py SHELLS
  };
  const DC_MAN = new Set(['c0', 'c1', '2man']);
  const DC_RUNNY = new Set(['run', 'sneak', 'qbrun', 'reverse']);
  const dcValid = (dc) => !!dc && DC.pers[dc.pers] !== undefined && DC.front[dc.front] !== undefined &&
    DC.rush[dc.rush] !== undefined && DC.cover[dc.cover] !== undefined;
  const dcGroup = (id) => (id === 'qb_sneak' ? 'sneak' : id === 'qb_run' ? 'qbrun' : id === 'trick_reverse' ? 'reverse'
    : id.startsWith('rb_') || id === 'trick_direct' ? 'run' : id === 'screen' ? 'screen' : id.startsWith('quick') ? 'quick'
      : id.startsWith('deep') ? 'deep' : id.startsWith('pa_') ? id : id.startsWith('roll') ? 'roll' : id.startsWith('rpo') ? 'rpo'
        : id === 'hail_mary' ? 'hail' : id.startsWith('trick') ? 'trick' : 'trick');
  // the defense's effect on the offense's call (id, its personnel pers when picked), in EPA: the sum of what each part
  // of the call does to that kind of play (playbook.py dc_effects, the same features), and the parts, biggest first.
  // Versus: a trick play the defense has seen this match (seen) loses SEEN_IT a time (a game rule: no surprise left)
  const SEEN_IT = 0.1;
  function dcEffect(eff, id, dc, pers, seen) {
    const t = [], g = dcGroup(id), passish = !DC_RUNNY.has(g) && g !== 'rpo';
    const names = [];
    if (passish) names.push(`rush:${dc.rush}`);
    if (g !== 'run' && g !== 'sneak') names.push(`cover:${dc.cover}`);
    names.push(`front:${dc.front}`);
    if (!passish) names.push(`blitz:${+dc.rush >= 5 ? 1 : 0}`);
    names.push(`pers:${dc.pers}`);
    if (pers) names.push(`opers:${pers === 10 || pers === 11 ? 'spread' : 'heavy'}|${dc.pers}`);
    // the call as a whole, apart from the sum of its parts: the coverage with the rush, the front with the blitz
    if (passish) names.push(`cr:${dc.cover}|${dc.rush}`);
    else names.push(`fb:${dc.front}|${+dc.rush >= 5 ? 1 : 0}`);
    const beta = eff && eff.groups && eff.groups[g];
    if (beta) names.forEach((n) => { const j = eff.index[n]; if (j !== undefined && beta[j]) t.push([n, beta[j]]); });
    if (id.startsWith('trick') && seen > 0) t.push(['seen_it', -SEEN_IT * Math.min(seen, 2)]);
    t.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return { s: t.reduce((a, x) => a + x[1], 0), why: t };
  }
  // the filters a draw against the defense's call keeps, strictest first: a pass keeps its pass rush the longest (it
  // decides the pressure, the sacks, the time to throw), then the shell, then man or zone; a run its box, then
  // whether the defense blitzed. Each widens the situation first ('near': down, distance, field), then to the call
  // on its side of the 20 ('wide': a Cover 0 blitz from another down is more like one than a Cover 1 blitz from
  // this one), before letting a filter go. A filter applies to the plays the call is about (_dcAbout: on a pass call
  // its dropbacks); a play it applies to that was not charted is left out
  const DC_PASS_LV = [
    [['rush', 'cov', 'db', 'pers'], 'near'], [['rush', 'cov', 'db'], 'near'], [['rush', 'cov'], 'near'], [['rush', 'cov'], 'wide'],
    [['rush', 'mz'], 'near'], [['rush'], 'near'], [['rush', 'mz'], 'wide'], [['rush'], 'wide'], [['cov'], 'near'], [['mz'], 'near'], [[], 'pool']];
  const DC_RUN_LV = [
    [['box', 'blitz', 'db', 'pers'], 'near'], [['box', 'blitz', 'db'], 'near'], [['box', 'blitz'], 'near'], [['box', 'blitz'], 'wide'],
    [['box'], 'near'], [['box'], 'wide'], [['db'], 'near'], [[], 'pool']];
  // the situations a draw against the defense's call widens to ('near', _nearRows), nearest first: [zones farther
  // out, distance buckets away (null: any), any down]: the same down and distance a part of the field farther out,
  // then a distance bucket away, then the same part of the field at any distance, then two parts out, then anywhere
  // in this part of the field (dcRegion)
  // the parts of the field a draw against the defense's call never borrows across: the goal line (3 yards or less
  // out: the defense has no depth to cover), the rest of the red zone (20 or less), the open field
  const dcRegion = (zone) => (zone === 0 ? 0 : zone <= 2 ? 1 : 2);
  // nor across short yardage (2 yards or less to go: a 2-yard gain there is a first down, not a failed play)
  const dcShort = (f) => Math.floor(f / N_ZONE) % N_YTG === 0;
  const DC_NEAR = [[1, 0, false], [1, 1, false], [0, null, false], [2, 1, false], [null, 0, false], [1, null, true], [null, 1, false], [null, null, false]];
  // a dropback that was never thrown to anyone (a picked receiver's route says nothing about it: _noTarget)
  const NO_TARGET_EV = new Set(['sack', 'strip_sack', 'sack_fumble', 'scramble', 'throwaway']);
  // a rollout's pools hold every dropback the quarterback left the pocket on (playbook.py spreads the untargeted ones
  // over the two rollouts), broken plays mostly: 50-70% of them are scrambles, sacks and throwaways. A rollout called
  // with a receiver picked has them at most this often (a player shown "76% caught" on a rollout saw 19%, Oct 22)
  const ROLL_NT = 0.15;
  // whether a pick's snap is a sack, scramble or throwaway: its own uniform, from the snap's u and the call and route.
  // The daily's draws are everyone's (one u a snap), so a low u made every pass call on that snap a sack at once ("an
  // automatic sack on the first play even if I throw a screen", Oct 22); now each call and route has its own luck there,
  // at the same rate. The route's play is still drawn from u
  const ntU = (u, callIdx, route) => {
    let h = (callIdx + 1) * 2654435761 >>> 0;
    for (const ch of String(route || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const v = u * 9973 + (h % 100003) / 100003;
    return v - Math.floor(v);
  };
  const DROPBACK_EV = new Set(['sack', 'strip_sack', 'sack_fumble', 'scramble', 'throwaway', 'interception', 'pick_six', 'near_pick', 'drop']);
  // daily game: your special-teams defense (act.st) when they kick. 'block' (field goal) or 'rush' (punt) sends
  // everyone: more blocks, but now and then a roughing flag (15 yards and a first down, an untimed down if time ran
  // out), and on a punt no return set up (a fair catch: no return yards, no return touchdown). 'safe' / 'return' is
  // the usual kick (the engine's plain model). NFL rates: about 1.5% of field goals and 1% of punts are blocked;
  // an all-out rush roughly triples that; blocked kicks are run back for touchdowns about one time in ten.
  const ST_BLOCK = { fg: 0.045, punt: 0.035 }, ST_FOUL = 0.02, ST_BLOCK_TD = 0.1, ST_FAIR_GAIN = 4;
  // how a real punt ended (models.py PUNT_HOW), and how deep a fielded punt is for a return out of the end zone
  const PUNT_RETURNED = 0, PUNT_FAIR = 1, PUNT_TB = 4, PUNT_DEEP = 5;
  const WHO_CODE = { RB: 2, WR: 3, TE: 4 };            // the target's position in the playbook's carry codes
  // the offense's formation, as FTN charts the quarterback (playbook.py FORMATIONS, bits 0-1 of each play's look):
  // in the shotgun, under center or in the pistol. A pick rides with the personnel in one number, pf = pers | form << 8
  const FORM_CODE = { gun: 1, under: 2, pistol: 3 };
  // what an action picked: its personnel (act.pers) and formation (act.form: a FORM_CODE name or its code) as one
  // and the backs in the backfield (act.bf: 0 empty, 1, 2, 3; playbook.py _backfield's code, n + 1, in bits 12-14)
  const persForm = (act) => ((act.pers || 0) & 255) | ((typeof act.form === 'string' ? FORM_CODE[act.form] || 0 : act.form || 0) << 8)
    | (Number.isInteger(act.bf) && act.bf >= 0 ? (Math.min(act.bf, 3) + 1) << 12 : 0);
  // a real play run with the personnel and the formation picked (pf; either part 0: not picked). lenient: a play whose
  // personnel or formation was not charted passes (the defense's draws, as before); strict: it does not (a group's own
  // plays only)
  function pfOk(P, r, pf, lenient) {
    const pg = pf & 255, fm = (pf >> 8) & 15, bf = (pf >> 12) & 7;
    if (pg) { const v = P.ngs.pers[r]; if (lenient ? v && v !== pg : v !== pg) return false; }
    if (fm) { const v = P.look ? P.look[r] & 3 : 0; if (lenient ? v && v !== fm : v !== fm) return false; }
    if (bf && P.bf) { const v = P.bf[r]; if (lenient ? v && v !== bf : v !== bf) return false; }
    return true;
  }
  // the route an action asks for: the receiver's route, at the depth it was drawn to when it was drawn (act.depth)
  const oobMode = (oob) => (oob === -1 ? -1 : oob ? 1 : 0);    // _cdfOf's: 1 get out of bounds, -1 stay in, 0 neither
  // the routes the page offers that the charting folds into another: a curl is a hitch run deep (NGS HITCH/CURL), a
  // comeback a deep out caught coming back to the sideline: the throws on that route about that deep (game.js
  // ROUTE_ALIAS: change both)
  const ROUTE_ALIAS = { curl: ['hitch', 11], comeback: ['deep_out', 13] };
  const routeOfAct = (act) => {
    const al = act.route && ROUTE_ALIAS[act.route], rt = al ? al[0] : act.route, d = Number.isFinite(act.depth) ? act.depth : al ? al[1] : null;
    return rt && d != null ? `${rt}@${Math.round(d)}` : rt;
  };
  const DRAWN_WIN = 3;                // a drawn route: real throws on it within 3 yards (15% of it, deeper) of the drawn depth
  const PB_LOOK_MIN = 15;             // daily game: a call's plays against one defensive look are used when at least this many
                                      // (playbook.py LOOK_MIN)
  // daily game: a defensive look as a bucket: 0 light box (6 or fewer), 1 light with a blitz, 2 loaded box (7 or more),
  // 3 loaded with a blitz; 255 when the charting has no box count
  const lookBucket = (k) => ((k >> 4) === 0 ? 255 : ((k >> 4) >= 7 ? 2 : 0) + ((k >> 3) & 1));
  // daily game: the defense's call on its snap, as the looks it may show (lookBucket masks)
  const DEF_LOOKS = { blitz: (1 << 1) | (1 << 3), load: 1 << 2, soft: 1 << 0 };
  const TEMPO = { hurry: HURRY, normal: NORMAL, milk: MILK, urgent: URGENT };
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const MODE_NORMAL = 0, MODE_HURRY = 1, MODE_KILL = 2;
  const N_DOWN = 3, N_YTG = 4, N_ZONE = 7;
  const ZONE_EDGES = [3, 9, 20, 39, 59, 79, 99];
  const YTG_EDGES = [2, 5, 10, 99];
  const KICKOFF_START_YL = 70.0;
  const FG_SNAP_YARDS = 17.0;
  const TWO_PT_SET = new Set([-2, -5, -9, -10, -13, 1, 5]);

  // RULES:start (a JSON copy of src/nflclock/rules.py rules_table(), the source and its rationale: tests/test_rules.py keeps them equal)
  const RULE_BOOK = {
    "RULES": {
      "nfl": {"level": "nfl", "quarter": 900, "tmw": 120, "oob": [120, 300], "fdStop": null, "untimed": "def", "runoff10": {"window": 60}, "penStop": null, "koTouchback": 65, "koFairCatch": null, "onsideBehindOnly": true, "patKick": 33, "twoYl": 2, "fgMissBack": 8, "fgMissTb": null, "tryForego": false, "kneelRunoff": [38, 40], "maxGap": null, "playClock": [40, 25], "hash": 23.58, "posts": 18.5, "ot": "nfl2025", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]},
      "ncaa2026": {"level": "fbs", "quarter": 900, "tmw": 120, "oob": [120, 120], "fdStop": {"window": 120, "credit": null}, "untimed": "any", "runoff10": {"window": 120}, "penStop": {"window": 120}, "koTouchback": 75, "koFairCatch": 75, "onsideBehindOnly": false, "patKick": 20, "twoYl": 3, "fgMissBack": 0, "fgMissTb": null, "tryForego": true, "kneelRunoff": [38, 40], "maxGap": null, "playClock": [40, 25], "hash": 20.0, "posts": 18.5, "ot": "ncaa", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]},
      "ncaa2022": {"level": "fbs", "quarter": 900, "tmw": null, "oob": [120, 120], "fdStop": {"window": 1800, "credit": null}, "untimed": "any", "runoff10": {"window": 60}, "penStop": {"window": 120}, "koTouchback": 75, "koFairCatch": 75, "onsideBehindOnly": false, "patKick": 20, "twoYl": 3, "fgMissBack": 0, "fgMissTb": null, "tryForego": true, "kneelRunoff": [38, 40], "maxGap": null, "playClock": [40, 25], "hash": 20.0, "posts": 18.5, "ot": "ncaa2022", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]},
      "nfhs": {"level": "hs", "quarter": 720, "tmw": null, "oob": [1440, 1440], "fdStop": {"window": 1440, "credit": 4.0}, "untimed": "any", "runoff10": null, "penStop": {"window": 120}, "koTouchback": 80, "koFairCatch": null, "onsideBehindOnly": false, "patKick": 20, "twoYl": 3, "fgMissBack": null, "fgMissTb": 80, "tryForego": true, "kneelRunoff": [38, 40], "maxGap": null, "playClock": [40, 25], "hash": 17.78, "posts": 23.33, "ot": "kansas10", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]},
      "nfhs25": {"level": "hs", "quarter": 720, "tmw": null, "oob": [1440, 1440], "fdStop": {"window": 1440, "credit": 4.0}, "untimed": "any", "runoff10": null, "penStop": {"window": 120}, "koTouchback": 80, "koFairCatch": null, "onsideBehindOnly": false, "patKick": 20, "twoYl": 3, "fgMissBack": null, "fgMissTb": 80, "tryForego": true, "kneelRunoff": [27, 30], "maxGap": 30.0, "playClock": [25, 25], "hash": 17.78, "posts": 23.33, "ot": "kansas10", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]},
      "uil2026": {"level": "hs", "quarter": 720, "tmw": 120, "oob": [120, 120], "fdStop": {"window": 120, "credit": null}, "untimed": "any", "runoff10": {"window": 120}, "penStop": {"window": 120}, "koTouchback": 75, "koFairCatch": 75, "onsideBehindOnly": false, "patKick": 20, "twoYl": 3, "fgMissBack": 0, "fgMissTb": null, "tryForego": true, "kneelRunoff": [38, 40], "maxGap": null, "playClock": [40, 25], "hash": 20.0, "posts": 18.5, "ot": "ncaa", "toPerHalf": 3, "runClock": null, "waterBreak": null, "fieldYards": 100, "firstDownYards": 10, "fgPoints": 3, "tryPoints": [1, 2]}
    },
    "OT": {
      "nfl2025": null,
      "ncaa": {"yl": 25, "yl3": null, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "carry"},
      "ncaa2022": {"yl": 25, "yl3": null, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "kansas10": {"yl": 10, "yl3": null, "must2From": null, "alt2From": null, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "ga15": {"yl": 15, "yl3": null, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "ut25": {"yl": 25, "yl3": null, "must2From": null, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "or25": {"yl": 25, "yl3": 10, "must2From": null, "alt2From": null, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "at25": {"yl": 25, "yl3": null, "must2From": null, "alt2From": null, "altYl": 3, "to": 1, "toFrom3": "reset"},
      "kansas10carry": {"yl": 10, "yl3": null, "must2From": null, "alt2From": null, "altYl": 3, "to": 1, "toFrom3": "reset", "toCarry": true}
    },
    "STATES": {
      "GA": {"ot": "ga15", "runClock": {"margin": 30, "from": 1, "sticky": true, "stops": "wide"}},
      "OH": {"runClock": {"margin": 30, "from": 2, "sticky": false, "stops": "min"}},
      "PA": {"runClock": {"margin": 35, "from": 2, "sticky": true, "stops": "min"}},
      "NE": {"runClock": {"margin": 35, "from": 2, "sticky": false, "stops": "wide"}},
      "IN": {"runClock": {"margin": 35, "from": 2, "sticky": true, "stops": "wide"}},
      "CA": {"runClock": {"margin": 35, "from": 1, "sticky": true, "stops": "min"}},
      "FL": {"runClock": {"margin": 35, "from": 0, "sticky": true, "stops": "min"}, "waterBreak": 390},
      "UT": {"ot": "ut25"},
      "OR": {"ot": "or25"},
      "MO": {"ot": "at25"},
      "WI": {"ot": "at25"},
      "IA": {},
      "MA": {},
      "LA": {"ot": "kansas10carry"}
    }
  };
  // RULES:end
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  deepFreeze(RULE_BOOK);
  // a ruleset by name ('nfl', 'ncaa2026', 'nfhs:GA': a state's overtime and running clock) or {base, ...overrides} (a
  // whole ruleset passes through as its own overrides); rules.py rules_of, the same
  function rulesOf(spec) {
    if (spec && typeof spec === 'object') {
      const R = rulesOf(spec.base || 'nfl');
      for (const [k, v] of Object.entries(spec)) if (k !== 'base') R[k] = JSON.parse(JSON.stringify(v));
      return R;
    }
    const [name, state] = String(spec == null ? 'nfl' : spec).split(':');
    if (!RULE_BOOK.RULES[name]) throw new Error(`unknown rules ${spec}`);
    const R = JSON.parse(JSON.stringify(RULE_BOOK.RULES[name]));
    if (state !== undefined) {
      if (!RULE_BOOK.STATES[state]) throw new Error(`unknown state ${state}`);
      Object.assign(R, JSON.parse(JSON.stringify(RULE_BOOK.STATES[state])));
    }
    return R;
  }
  // the outcome data a ruleset may be played on: NFL data plays any (the test bed: rules_sweep.js, parity_exact
  // --rules), college data plays college and high school rules (no high-school data yet)
  const LEVEL_OK = { nfl: null, fbs: ['fbs', 'hs'], hs: ['hs'] };
  // the half's clock geometry for a root: 0:00 of Q2 is t = H (two quarters), otherwise the start of the second half;
  // a try at that moment (a touchdown on the last play of the first half) still belongs to the first half, which ends
  // after it (sim.py the same). No two-minute stoppage: tmw = +inf, which no clock ever crosses
  function geomOf(R, root) {
    const H = 2 * R.quarter, halfEnd = root.t > H || (root.t === H && root.phase === PAT) ? H : 0;
    return { halfEnd, half: halfEnd > 0 ? 1 : 2, qEnd: halfEnd + R.quarter, tmw: R.tmw == null ? Infinity : halfEnd + R.tmw,
      oobWindow: halfEnd > 0 ? R.oob[0] : R.oob[1], R };
  }

  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const fgBlockP = (dist) => FG_BLOCK.find(([d]) => dist <= d)[1];
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  function countBelow(edges, v) { // numpy searchsorted(edges, v, 'left')
    let i = 0;
    while (i < edges.length && edges[i] < v) i++;
    return i;
  }
  const zoneOf = (yl) => countBelow(ZONE_EDGES, clip(yl, 1, 99));
  const ytgBucket = (ytg) => countBelow(YTG_EDGES, clip(ytg, 1, 99));
  const downBucket = (down) => clip(Math.trunc(down), 1, 3) - 1;
  function gameMode(half, ht, m) {
    const hurry = (half === 1 && ht <= 120) || (half === 2 && ht <= 300 && m < 0) ||
      (half === 2 && ht <= 120 && m === 0) || (half === 2 && ht <= 600 && m <= -9);
    const kill = half === 2 && ht <= 360 && m > 0;
    return hurry ? MODE_HURRY : kill ? MODE_KILL : MODE_NORMAL;
  }
  const fineKey = (mode, down, ytg, yl) =>
    (((mode * N_DOWN + downBucket(down)) * N_YTG + ytgBucket(ytg)) * N_ZONE + zoneOf(yl));

  // normal CDF (Abramowitz-Stegun 7.1.26 via erf)
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

  // ---------------------------------------------------------- counter RNG (CRN) ---
  function lowbias32(x) {
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
    return x >>> 0;
  }
  // uniform for (seed, rollout, step, column): identical across alternative actions -> common random numbers
  function uni(seed, r, step, c) {
    let h = lowbias32((seed ^ 0x632be5ab) >>> 0);
    h = lowbias32((h ^ Math.imul(r + 1, 0x9e3779b1)) >>> 0);
    h = lowbias32((h ^ Math.imul(step * 8 + c + 1, 0x85ebca77)) >>> 0);
    return (h + 0.5) / 4294967296;
  }

  // ===================================================================== Engine ===
  class NFLClockEngine {
    constructor(data) {
      this.data = data;
      const c = data.constants;
      this.consts = c;
      // the level (engine_data constants.level: 'nfl', 'fbs') and its own constants; the NFL export carries none of
      // them: today's values (the first-down credit, never used under NFL rules, falls back to the ready-for-play
      // restart measured on out-of-bounds plays: the same official's signal)
      this.level = data.level || c.level || 'nfl';
      this.kickoffStart = c.kickoff_start_yl ?? KICKOFF_START_YL; this.koTb = c.ko_touchback_yl ?? KO_TOUCHBACK;
      this.xpLogit = c.xp_logit ?? XP_LOGIT; this.twoPtBase = c.two_pt_base ?? 0.47; this.fdCredit = c.fd_restart_credit ?? c.oob_restart_credit;
      this.onsideYl = c.onside_yl ?? [54, 46]; this.otSd = c.ot_margin_sd ?? 13.5; this.fgLong = c.fg_long ?? FG_LONG; this.fgMax = c.fg_max ?? 68;
      const L = data.lib;
      this.lib = {
        yards: decode(L.yards), flags: decode(L.flags), toRel: decode(L.to_rel), dur10: decode(L.dur10),
        epa: decode(L.epa), items: decode(L.items), offsets: decode(L.offsets), poolOf: decode(L.pool_of),
        poolKind: decode(L.pool_kind), passRate: decode(L.pass_rate),
      };
      this.nFine = c.n_fine;
      this.nPools = this.lib.offsets.length - 1;
      this.meanEpa = { 0: c.mean_epa['0'], 1: c.mean_epa['1'] };
      // per-item pool id and epa (for tilting)
      const nItems = this.lib.items.length;
      this.poolId = new Int32Array(nItems);
      this.itemEpa = new Float64Array(nItems);
      for (let p = 0; p < this.nPools; p++) {
        for (let i = this.lib.offsets[p]; i < this.lib.offsets[p + 1]; i++) {
          this.poolId[i] = p;
          this.itemEpa[i] = this.lib.epa[this.lib.items[i]];
        }
      }
      // pass plays that stop the clock and nothing else (incompletions, catches out of bounds), by pool
      const stopPos = [];
      this.stopOff = new Int32Array(this.nPools + 1);
      for (let p = 0; p < this.nPools; p++) {
        this.stopOff[p] = stopPos.length;
        if (this.lib.poolKind[p] !== PASS) continue;
        for (let i = this.lib.offsets[p]; i < this.lib.offsets[p + 1]; i++) {
          const f = this.lib.flags[this.lib.items[i]];
          if ((f & (4 | 8)) && !(f & (1 | 16 | 32 | 64 | 128))) stopPos.push(i);
        }
      }
      this.stopOff[this.nPools] = stopPos.length;
      this.stopPos = Int32Array.from(stopPos);
      this.tempo = {};
      const tmap = { hurry: HURRY, normal: NORMAL, milk: MILK, spike: T_SPIKE, urgent: URGENT };
      for (const [k, v] of Object.entries(data.tempo)) {
        const a = decode(v);
        const f = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) f[i] = a[i] / 10;
        if (k === 'spike') for (let i = 0; i < f.length; i++) f[i] = clip(f[i], 1, 16);
        this.tempo[tmap[k]] = f;
      }
      // punts sorted by yard line
      const P = data.punts;
      const yl = decode(P.yl), net = decode(P.net), fl = decode(P.flags), d10 = decode(P.dur10);
      const order = Array.from(yl.keys()).sort((a, b) => (yl[a] - yl[b]) || (a - b));
      const n = order.length;
      this.punt = { yl: new Float64Array(n), net: new Float64Array(n), retTd: new Uint8Array(n), blocked: new Uint8Array(n),
        touchback: new Uint8Array(n), dur: new Float64Array(n), how: new Uint8Array(n), ret: new Float64Array(n) };
      // how the real punt ended (flags bits 3-5, models.py PUNT_HOW: 0 returned, 1 fair catch, 2 downed, 3 out of bounds,
      // 4 touchback, 5 muffed) and where it came down or was fielded (land: the receiving team's yards from its goal
      // line, 0 or less in the end zone): a return's own yards, for the field and the end zone (_punt)
      const land = P.land ? decode(P.land) : null;
      order.forEach((j, i) => {
        this.punt.yl[i] = yl[j]; this.punt.net[i] = net[j]; this.punt.retTd[i] = fl[j] & 1;
        this.punt.blocked[i] = (fl[j] >> 1) & 1; this.punt.touchback[i] = (fl[j] >> 2) & 1; this.punt.dur[i] = d10[j] / 10;
        this.punt.how[i] = land ? (fl[j] >> 3) & 7 : PUNT_RETURNED;
        this.punt.ret[i] = land && this.punt.how[i] === PUNT_RETURNED ? Math.max(0, yl[j] - net[j] - land[j]) : 0;
      });
      // the real returns of punts fielded at the 5 or deeper (210 in 2020-25, ending at the 15 on average, four of them a
      // touchdown): a returner who runs one out of the end zone (_punt 'ezret')
      this.puntDeep = Int32Array.from(land ? [...Array(n).keys()].filter((i) => !this.punt.blocked[i] && !this.punt.touchback[i]
        && this.punt.how[i] === PUNT_RETURNED && this.punt.yl[i] - this.punt.net[i] - this.punt.ret[i] <= PUNT_DEEP) : []);
      this.puntLo = new Int32Array(101); this.puntHi = new Int32Array(101);
      const ss = (v, right) => { // searchsorted on punt.yl
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (right ? this.punt.yl[mid] <= v : this.punt.yl[mid] < v) lo = mid + 1; else hi = mid; }
        return lo;
      };
      for (let y = 0; y <= 100; y++) {
        let w = 2, lo, hi;
        for (;;) { lo = ss(y - w, false); hi = ss(y + w, true); if (hi - lo >= 60 || w > 30) break; w += 1; }
        this.puntLo[y] = lo; this.puntHi[y] = hi;
      }
      this.expNet = new Float64Array(101);
      for (let y = 0; y <= 100; y++) {
        let s = 0, k = 0;
        for (let i = this.puntLo[y]; i < this.puntHi[y]; i++) if (!this.punt.blocked[i] && !this.punt.retTd[i]) { s += this.punt.net[i]; k++; }
        this.expNet[y] = this.puntHi[y] > this.puntLo[y] ? s / k : 40.0;
      }
      const K = data.kickoffs;
      this.ko = { start: decode(K.start_yl), dur10: decode(K.dur10), retTd: decode(K.ret_td) };
      // daily game: kicks into the landing zone, everything but a touchback (returned, short, or bounced in)
      this.ko.ret = Int32Array.from(Array.from(this.ko.start.keys()).filter((i) => !(this.ko.start[i] === this.koTb && this.ko.dur10[i] === 0)));
      this.fg = data.fg;
      const W = data.wp;
      this.trees = { feature: decode(W.feature), threshold: decode(W.threshold), left: decode(W.left), right: decode(W.right),
        value: decode(W.value), roots: decode(W.roots) };
      this._x = new Float64Array(13);
    }

    // ------------------------------------------------------------- models ---
    fgLogit(dist, ctx) {
      const d = (Math.min(dist, 70) - 40) / 10;
      const outdoor = ctx.indoor ? 0 : 1;
      const wind = (ctx.wind || 0) * outdoor;
      const temp = ctx.temp == null || Number.isNaN(ctx.temp) ? 65 : ctx.temp;
      const cold = Math.max(50 - temp, 0) / 10 * outdoor;
      const yr = (ctx.season - 2020) / 5;
      const X = [d, d * d, d * d * d, outdoor, wind / 10, wind / 10 * d, cold, cold * d, yr, yr * d];
      let z = this.fg.intercept;
      for (let i = 0; i < 10; i++) z += X[i] * this.fg.coef[i];
      return z;
    }

    wpRaw(x) {
      const T = this.trees;
      let s = 0;
      for (let t = 0; t < T.roots.length; t++) {
        let node = T.roots[t];
        while (T.feature[node] >= 0) node = x[T.feature[node]] <= T.threshold[node] ? T.left[node] : T.right[node];
        s += T.value[node];
      }
      return s;
    }

    wpFeatures(margin, t, down, ytg, yl, offTo, defTo, offSpread, isHome, r2h, out) {
      const x = out || new Float64Array(13);
      const half = t > 1800 ? 1 : 2;
      const halfT = half === 1 ? t - 1800 : t;
      const elapsed = (3600 - t) / 3600;
      x[0] = margin; x[1] = t; x[2] = halfT; x[3] = half; x[4] = margin / Math.exp(-4 * elapsed);
      x[5] = offSpread * Math.exp(-4 * elapsed); x[6] = isHome; x[7] = down; x[8] = ytg; x[9] = yl;
      x[10] = offTo; x[11] = defTo; x[12] = half === 1 ? r2h : 0;
      return x;
    }

    // Daily game: call-level outcome libraries (web/playbook.json, built by src/nflclock/playbook.py)
    loadPlaybook(pb) {
      const R = pb.rows;
      const P = {
        calls: pb.calls, yards: decode(R.yards), flags: decode(R.flags), toRel: decode(R.to_rel),
        dur10: decode(R.dur10), epa: decode(R.epa), items: decode(pb.items), offsets: decode(pb.offsets),
        poolOf: decode(pb.pool_of), freq: decode(pb.freq), oobOdds: pb.oob_odds, stayOdds: pb.stay_odds, nFine: pb.n_fine,
        // the same by call and the target's route (calls x routes; route 0, not charted, the call's own)
        oobRoute: pb.oob_route || null, stayRoute: pb.stay_route || null,
        // what happened on each real play (narration only): event, penalty called, pre-snap look
        event: R.event ? decode(R.event) : null, pen: R.pen ? decode(R.pen) : null, look: R.look ? decode(R.look) : null,
        air: R.air ? decode(R.air) : null, carry: R.carry ? decode(R.carry) : null,    // the animation: air yards, carrier, broken tackle
        ball: R.ball ? decode(R.ball) : null,          // and how the ball got there (playbook.py _ball: FTN catchable, contested, defended)
        // the animation: NGS route, coverage, pass rush, time to throw (playbook.py _charting)
        bf: R.bf ? decode(R.bf) : null,               // backs in the backfield (playbook.py _backfield): an empty set, two backs
        ngs: R.route ? { route: decode(R.route), cover: decode(R.cover), rush: decode(R.rush), ttt: decode(R.ttt), pers: R.pers ? decode(R.pers) : null,
          dpers: R.dpers ? decode(R.dpers) : null } : null,
        routeNames: pb.routes || [], shellNames: pb.shells || [],
        eventNames: pb.events || [], penNames: pb.penalties || [],
        shift: pb.pool_shift ? decode(pb.pool_shift) : null,   // intent correction per pool (playbook.py pool_shifts)
        // daily game: per (call, situation, look) the pool to draw that look from (playbook.py pools)
        lookPool: pb.look_pool ? decode(pb.look_pool) : null,
        // the defense's effect on each kind of play (playbook.py dc_effects), by feature name
        dcEff: pb.dc_effects ? { ...pb.dc_effects, index: Object.fromEntries(pb.dc_effects.names.map((n, j) => [n, j])) } : null,
      };
      P.callIndex = {};
      pb.calls.forEach((c, i) => { P.callIndex[c.id] = i; });
      P.match = pb.calls.map((c) => MATCH[c.id] || { blitz: 0, load: 0, soft: 0 });
      P.lookB = P.look ? Uint8Array.from(P.look, lookBucket) : null;
      P.nPools = P.offsets.length - 1;
      P.poolCall = new Int32Array(P.nPools);
      for (let c = 0; c < pb.calls.length; c++) {
        for (let f = 0; f < P.nFine; f++) {
          P.poolCall[P.poolOf[c * P.nFine + f]] = c;
          if (P.lookPool) for (let b = 0; b < 4; b++) P.poolCall[P.lookPool[(c * P.nFine + f) * 4 + b]] = c;
        }
      }
      // calls with the same multipliers (an OOB family: playbook.py OOB_FAMILIES) share a draw's tables from a set of
      // rows (Simulator._dcT, _setT: a set of every call of a kind is not built again for each of them)
      const ok = new Map();
      P.oobKey = pb.calls.map((c, i) => {
        const k = JSON.stringify([P.oobOdds[i], P.stayOdds ? P.stayOdds[i] : 1, P.oobRoute ? P.oobRoute[i] : 0, P.stayRoute ? P.stayRoute[i] : 0]);
        if (!ok.has(k)) ok.set(k, i);
        return ok.get(k);
      });
      // the carrier's try (pbOobCls), each row
      P.oobCls = new Uint8Array(P.flags.length);
      for (let r = 0; r < P.flags.length; r++) {
        const f = P.flags[r];
        P.oobCls[r] = f & 69 ? 0 : f & 8 ? 2 : !P.carry || (P.carry[r] & 7) > 0 ? 1 : 0;   // (a pick returned out of bounds: 0)
      }
      P.itemEpa = new Float64Array(P.items.length);
      for (let i = 0; i < P.items.length; i++) P.itemEpa[i] = P.epa[P.items[i]];
      this.pb = P;
      return P;
    }

    // what the carrier's try can change on a play (P.oobCls, built by loadPlaybook): 2 he went out of bounds, 1 he had
    // the ball and stayed in (a run, a catch, a scramble: no flag, incompletion or turnover), 0 neither (a sack, a
    // throw on the ground, a pick, a penalty). And the weight of a play he went out on, of call c, when he tries to get
    // out (om 1: the multiplier for its NGS route, playbook.py oob_route_odds; uncharted, the call's) or to stay in (-1)
    pbOobMul(c, om, r) {
      const P = this.pb;
      if (!om) return 1;
      const rt = P.ngs ? P.ngs.route[r] : 0;
      const t = om < 0 ? (P.stayRoute ? P.stayRoute[c] : null) : (P.oobRoute ? P.oobRoute[c] : null);
      const fam = om < 0 ? (P.stayOdds ? P.stayOdds[c] : 1) : P.oobOdds[c];
      return (t ? t[rt] : undefined) ?? fam;
    }

    // Tilt every call pool toward one offense-vs-defense matchup (delta[c] = EPA shift for call c);
    // returns sampling CDFs without and with an out-of-bounds attempt, and staying in bounds (leading late).
    pbTilt(delta) {
      const P = this.pb, off = P.offsets, e = P.itemEpa;
      const cdf = new Float64Array(e.length), cdfOob = new Float64Array(e.length), cdfIn = new Float64Array(e.length);
      for (let p = 0; p < P.nPools; p++) {
        const c = P.poolCall[p], lo = off[p], hi = off[p + 1];
        let base = 0; for (let i = lo; i < hi; i++) base += e[i];
        base /= Math.max(hi - lo, 1);
        const target = base + (P.shift ? P.shift[p] : 0) + (delta ? delta[c] : 0);
        let th = 0;
        for (let it = 0; it < 4; it++) {
          let mx = -Infinity; for (let i = lo; i < hi; i++) mx = Math.max(mx, th * e[i]);
          let sw = 0, m1 = 0, m2 = 0;
          for (let i = lo; i < hi; i++) { const w = Math.exp(th * e[i] - mx); sw += w; m1 += w * e[i]; m2 += w * e[i] * e[i]; }
          m1 /= sw; m2 /= sw;
          th = clip(th + (target - m1) / Math.max(m2 - m1 * m1, 1e-6), -1.5, 1.5);
        }
        let mx = -Infinity; for (let i = lo; i < hi; i++) mx = Math.max(mx, th * e[i]);
        // the carrier trying to get out (or to stay in): a play he went out on weighs its call's multiplier for its route
        // (pbOobMul), and the plays he had the ball on are scaled back to their own share, so trying never makes the
        // catch, the sack or the incompletion likelier: only where he ends up
        const K = P.oobCls;
        let sw = 0, sE = 0, sEo = 0, sEi = 0;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * e[i] - mx), r = P.items[i], k = K[r];
          sw += w;
          if (k) { sE += w; sEo += k === 2 ? w * this.pbOobMul(c, 1, r) : w; sEi += k === 2 ? w * this.pbOobMul(c, -1, r) : w; }
        }
        const zo = sEo > 0 ? sE / sEo : 1, zi = sEi > 0 ? sE / sEi : 1, swo = sw - sE + zo * sEo, swi = sw - sE + zi * sEi;
        let cum = 0, cumo = 0, cumi = 0;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * e[i] - mx), r = P.items[i], k = K[r];
          cum += w / sw;
          cumo += (k ? (k === 2 ? w * this.pbOobMul(c, 1, r) : w) * zo : w) / swo;
          cumi += (k ? (k === 2 ? w * this.pbOobMul(c, -1, r) : w) * zi : w) / swi;
          cdf[i] = p + Math.min(cum, 1 - 1e-12); cdfOob[i] = p + Math.min(cumo, 1 - 1e-12); cdfIn[i] = p + Math.min(cumi, 1 - 1e-12);
        }
      }
      return { cdf, cdfOob, cdfIn };
    }

    // CDF over the clock-stopping subset of each pool, weighted by tilted item probabilities
    subsetCdf(prob) {
      const pos = this.stopPos, off = this.stopOff, cdf = new Float64Array(pos.length);
      for (let p = 0; p < this.nPools; p++) {
        let tot = 0;
        for (let j = off[p]; j < off[p + 1]; j++) tot += prob[pos[j]];
        let cum = 0;
        for (let j = off[p]; j < off[p + 1]; j++) {
          cum += prob[pos[j]];
          cdf[j] = p + Math.min(cum / Math.max(tot, 1e-300), 1 - 1e-12);
        }
      }
      return cdf;
    }

    // ----------------------------------------------------- tilting (library) ---
    tilt(deltaRun, deltaPass) {
      const L = this.lib, off = L.offsets, nP = this.nPools, e = this.itemEpa, pid = this.poolId;
      const theta = new Float64Array(nP), base = new Float64Array(nP), target = new Float64Array(nP);
      for (let p = 0; p < nP; p++) {
        let s = 0; for (let i = off[p]; i < off[p + 1]; i++) s += e[i];
        base[p] = s / (off[p + 1] - off[p]);
        target[p] = base[p] + (L.poolKind[p] === PASS ? deltaPass : deltaRun);
      }
      const w = new Float64Array(e.length);
      const weights = () => {
        for (let p = 0; p < nP; p++) {
          let mx = -Infinity;
          for (let i = off[p]; i < off[p + 1]; i++) { const z = theta[p] * e[i]; if (z > mx) mx = z; }
          for (let i = off[p]; i < off[p + 1]; i++) w[i] = Math.exp(theta[p] * e[i] - mx);
        }
      };
      for (let it = 0; it < 4; it++) {
        weights();
        for (let p = 0; p < nP; p++) {
          let sw = 0, m1 = 0, m2 = 0;
          for (let i = off[p]; i < off[p + 1]; i++) { sw += w[i]; m1 += w[i] * e[i]; m2 += w[i] * e[i] * e[i]; }
          m1 /= sw; m2 /= sw;
          const v = Math.max(m2 - m1 * m1, 1e-6);
          theta[p] = clip(theta[p] + (target[p] - m1) / v, -1.5, 1.5);
        }
      }
      weights();
      const prob = new Float64Array(e.length), cdf = new Float64Array(e.length);
      for (let p = 0; p < nP; p++) {
        let sw = 0; for (let i = off[p]; i < off[p + 1]; i++) sw += w[i];
        let cum = 0;
        for (let i = off[p]; i < off[p + 1]; i++) { prob[i] = w[i] / sw; cum += prob[i]; cdf[i] = p + Math.min(cum, 1 - 1e-12); }
      }
      return { cdf, prob };
    }

    conversionTable(prob, passShift) {
      const L = this.lib, off = L.offsets;
      const conv = new Float64Array(3 * N_ZONE * 21);
      for (let mode = 0; mode < 3; mode++) for (let zone = 0; zone < N_ZONE; zone++) {
        for (let ytg = 1; ytg <= 20; ytg++) {
          const fk = ((mode * N_DOWN + 2) * N_YTG + ytgBucket(ytg)) * N_ZONE + zone;
          let rate = L.passRate[fk];
          rate = sigmoid(Math.log(rate / (1 - rate)) + passShift);
          let p = 0;
          for (const [kind, share] of [[PASS, rate], [RUN, 1 - rate]]) {
            const pool = L.poolOf[kind * this.nFine + fk];
            let s = 0;
            for (let i = off[pool]; i < off[pool + 1]; i++) {
              const r = L.items[i], f = L.flags[r];
              const ok = (L.yards[r] >= ytg || (f & 2) || (f & 16)) && !(f & 64);
              if (ok) s += prob[i];
            }
            p += share * s;
          }
          conv[(mode * N_ZONE + zone) * 21 + ytg] = p;
        }
        conv[(mode * N_ZONE + zone) * 21] = conv[(mode * N_ZONE + zone) * 21 + 1];
      }
      return conv;
    }

    // ------------------------------------------------------------ context ---
    static effective(teamRec, manual) {
      const b = teamRec.base, ia = teamRec.injury_adjustment, m = manual || {};
      return {
        team: teamRec.team,
        off_pass: b.off_pass + teamRec.qb.adjustment + ia.off_pass + (m.off_pass || 0),
        off_rush: b.off_rush + ia.off_rush + (m.off_rush || 0),
        def_pass: b.def_pass + ia.def_pass + (m.def_pass || 0),
        def_rush: b.def_rush + ia.def_rush + (m.def_rush || 0),
        proe: b.proe,
        kicker_rating: m.kicker_rating != null ? m.kicker_rating : teamRec.kicker.rating,
        punter_rating: m.punter_rating != null ? m.punter_rating : teamRec.punter.rating,
      };
    }

    makeContext(game, opts) {
      opts = opts || {};
      const manual = opts.manual || {};
      // the rulebook (rulesOf): the option, the game's own (a college spot), else the NFL's
      const rules = rulesOf(opts.rules || game.rules || 'nfl'), ok = LEVEL_OK[this.level];
      if (ok && !ok.includes(rules.level)) throw new Error(`${rules.level} rules on ${this.level} data`);
      const home = NFLClockEngine.effective(game.home, manual[game.home.team]);
      const away = NFLClockEngine.effective(game.away, manual[game.away.team]);
      const lg = game.league;
      const eraPass = lg.mu_pass - this.meanEpa[1], eraRun = lg.mu_rush - this.meanEpa[0];
      const delta = [[0, 0], [0, 0]];
      [[home, away, 0.5], [away, home, -0.5]].forEach(([o, d, sgn], i) => {
        delta[i][PASS] = eraPass + o.off_pass + d.def_pass + sgn * lg.home_pass;
        delta[i][RUN] = eraRun + o.off_rush + d.def_rush + sgn * lg.home_rush;
      });
      const two = [0, 1].map((i) => clip(this.twoPtBase + 0.3 * (0.6 * delta[i][PASS] + 0.4 * delta[i][RUN]), 0.35, 0.6));
      const spread = opts.homeSpread != null ? opts.homeSpread : game.home_spread;
      const r2h = opts.receive2h === game.home.team ? 0 : 1;
      // 4th-down decision style per team: null = sound (WP look-ahead); else play like a typical NFL coach
      // (shift 0) or like this coach (measured go-for-it shift)
      const prof = game.coach_profiles, modes = opts.coachMode || {};
      const coach4th = [[game.home, game.home_coach], [game.away, game.away_coach]].map(([t, coach]) => {
        const m = modes[t.team] || 'sound';
        if (m === 'sound' || !prof) return null;
        const shift = m === 'coach' ? ((prof.coaches[coach] || {}).go_shift || 0) : 0;
        return { model: prof.fourth_model, shift };
      });
      // daily game: per-call EPA shift for each offense from both teams' call ratings
      let pbDelta = null;
      if (this.pb && game.home.calls && game.away.calls) {
        pbDelta = [[game.home, game.away], [game.away, game.home]].map(([o, d]) =>
          this.pb.calls.map((c) => ((o.calls[c.id] || {}).off || 0) + ((d.calls[c.id] || {}).def || 0)));
      }
      return {
        coach4th, pbDelta,
        homeSpread: spread, receive2h: r2h, indoor: !!game.indoor,
        wind: opts.wind != null ? opts.wind : (game.wind || 0), temp: opts.temp != null ? opts.temp : game.temp,
        season: game.season, delta, proe: [home.proe, away.proe],
        kickerShift: [home.kicker_rating, away.kicker_rating], punterShift: [home.punter_rating, away.punter_rating],
        twoPt: two, otWpHome: 0.5 + 0.5 * (normCdf(spread / this.otSd) - 0.5),
        teams: [home, away], rules,
      };
    }

    // college data: the NFL playbook's call pools re-leveled to college outcomes (cfb_overlay.json: each pool's intent
    // shift, replacing playbook.py's). Before simulator(): a simulator's call tables (pbTilt) read the shifts when built
    loadOverlay(ov) {
      if (!this.pb) throw new Error('loadOverlay: load the playbook first');
      if (ov.n_pools !== this.pb.nPools) throw new Error(`overlay for ${ov.n_pools} pools, the playbook has ${this.pb.nPools}`);
      this.pb.shift = decode(ov.pool_shift);
      return this;
    }

    simulator(ctx) { return new Simulator(this, ctx); }
  }

  // ================================================================== Simulator ===
  class Simulator {
    constructor(eng, ctx) {
      this.e = eng; this.ctx = ctx;
      this.cdf = []; this.conv = []; this.stopCdf = [];
      for (let team = 0; team < 2; team++) {
        const { cdf, prob } = eng.tilt(ctx.delta[team][RUN], ctx.delta[team][PASS]);
        this.cdf.push(cdf);
        this.stopCdf.push(eng.subsetCdf(prob));
        this.conv.push(eng.conversionTable(prob, ctx.proe[team] / 0.24));
      }
      if (eng.pb) this.pbCdf = [0, 1].map((team) => eng.pbTilt(ctx.pbDelta ? ctx.pbDelta[team] : null));
      const c = eng.consts;
      this.kneelDur = c.kneel_duration; this.spikeDur = c.spike_duration; this.toReact = c.timeout_reaction;
      this.oobCredit = c.oob_restart_credit; this.penCredit = c.penalty_restart_credit;
      this.onsideP = Math.max(c.onside, 0.05);
      this.x = new Float64Array(13);
      this._rules(ctx);
    }

    // the rulebook (makeContext's ctx.rules; board/lazy_sim.js builds its simulator without the constructor and calls this)
    _rules(ctx) {
      this.R = ctx.rules || rulesOf('nfl');
      const R = this.R;   // the 11-player game only (8- and 6-player rules are not in this version)
      if (R.fieldYards !== 100 || R.firstDownYards !== 10 || R.fgPoints !== 3 || R.tryPoints[0] !== 1 || R.tryPoints[1] !== 2) throw new Error('only 11-player football is supported');
      this.fdCredit = this.R.fdStop && this.R.fdStop.credit != null ? this.R.fdStop.credit : this.e.fdCredit;
    }

    _geom(root) { return geomOf(this.R, root); }

    fgProb(dist, team) {
      const L = this.e.fgLong;
      if (dist > this.e.fgMax) return 0;
      const long = -L[1] * Math.max(0, dist - L[0]) - L[3] * Math.max(0, dist - L[2]);
      return sigmoid(this.e.fgLogit(dist, this.ctx) + this.ctx.kickerShift[team] + long);
    }

    wpFull(team, margin, t, down, ytg, yl, offTo, defTo) {
      const ctx = this.ctx;
      const spread = team === 0 ? ctx.homeSpread : -ctx.homeSpread;
      if (this.R.quarter !== 900) t = t * 900 / this.R.quarter;      // shorter quarters: the model's game, scaled
      this.e.wpFeatures(margin, Math.max(t, 1), down, clip(ytg, 1, 99), clip(yl, 1, 99), offTo, defTo, spread,
        team === 0 ? 1 : 0, team === ctx.receive2h ? 1 : 0, this.x);
      return sigmoid(this.e.wpRaw(this.x));
    }

    kneelOutPossible(tHalf, down, defTo, running, tmwPending) {
      const k = clip(4 - down, 0, 3);
      const gaps = k + (running ? 1 : 0);
      const stops = defTo + (tmwPending ? 1 : 0);
      const gap = 0.5 * (this.R.kneelRunoff[0] + this.R.kneelRunoff[1]);   // the average kneel runoff
      const burn = k * this.kneelDur + Math.max(gaps - stops, 0) * gap + Math.min(gaps, stops) * 1;
      return tHalf <= burn + 1;
    }

    sampleLib(team, kind, fk, u) {
      const L = this.e.lib, cdf = this.cdf[team];
      const pool = L.poolOf[kind * this.e.nFine + fk];
      let lo = L.offsets[pool], hi = L.offsets[pool + 1] - 1;
      const target = pool + u;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < target) lo = mid + 1; else hi = mid; }
      return L.items[lo];
    }

    // Daily game: the tempo the offense would use on its next snap with the clock running ('urgent',
    // 'hurry', 'normal' or 'milk'); mirrors steps (1)-(2) of _snap without the live tool's first-half strategy
    defaultTempo(root) {
      const g = this._geom(root), o = root.pos, half = g.half, tHalf = root.t - g.halfEnd;
      const margin = root.score[o] - root.score[1 - o], yl = root.yl, offTo = root.to[o];
      let hurry, urgent, milk;
      if (half === 2) {
        const closing = margin >= -2 && margin <= 0 && tHalf <= CLOSE_WINDOW && offTo > 0 &&
          this.fgProb(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P;
        hurry = ((margin < 0 && tHalf <= 300) || (margin <= -9 && tHalf <= 600) || (margin === 0 && yl <= 80 && tHalf <= 75)) && !closing;
        urgent = hurry && tHalf <= 120;
        milk = (margin > 0 && tHalf <= 600) || (margin === 0 && tHalf <= 240 && !hurry) || closing;
      } else {
        const attempt = (yl - 35.0) <= 0.6 * (tHalf + 20.0 * offTo);
        hurry = tHalf <= 120 && attempt; urgent = hurry && tHalf <= 60; milk = tHalf <= 120 && !attempt;
      }
      return urgent ? 'urgent' : hurry ? 'hurry' : milk ? 'milk' : 'normal';
    }

    // Daily game: typical seconds between snaps with the clock running, by tempo
    tempoSeconds() {
      const med = (f) => { const a = Array.from(f).sort((x, y) => x - y); return a[a.length >> 1]; };
      return { urgent: med(this.e.tempo[URGENT]), hurry: med(this.e.tempo[HURRY]), normal: med(this.e.tempo[NORMAL]),
        milk: med(this.e.tempo[MILK]) };
    }

    // The two numbers a coach asks for on 4th down: conversion chance and field-goal make chance.
    fourthInfo(root) {
      const g = this._geom(root), o = root.pos, half = g.half, tHalf = root.t - g.halfEnd;
      const margin = root.score[o] - root.score[1 - o], yl = root.yl;
      const mode = gameMode(half, tHalf, margin), zone = zoneOf(yl);
      const dist = yl + FG_SNAP_YARDS;
      return { fgDist: dist, pFg: this.fgProb(dist, o),
        pConv: this.conv[o][(mode * N_ZONE + zone) * 21 + Math.trunc(clip(root.ytg, 1, 20))] };
    }

    // a play of the chosen call from the playbook (daily game); oob = the ball carrier tries to get out; looks = a
    // bit mask of defensive looks (lookBucket): only plays run against those, from the situation's pool when it has
    // PB_LOOK_MIN of them, else from the coarser pool built for that look; else any look
    // s: the matchup (MATCH) of the call against the defense's call, tilting the draw. route / who (daily game, a pass
    // to a receiver you picked): only plays where the target ran that route (NGS / FTN charting) and played that
    // position (2 RB, 3 WR, 4 TE), from the situation's pool, then the call's coarser pools, then any position,
    // against the look when there are PB_LOOK_MIN such plays; else the call's plays as before
    // oob: 1 (or true) the carrier tries to get out of bounds; -1 he tries to stay in (leading late); else neither
    _cdfOf(team, oob) {
      const C = this.pbCdf[team];
      return oob === -1 ? C.cdfIn : oob ? C.cdfOob : C.cdf;
    }
    // pers (daily game): the offense's personnel (11, 12, 21, 13) and, in bits 8 and up, its formation (FORM_CODE: the
    // quarterback in the shotgun, under center or in the pistol, as FTN charts it): only real plays run with both,
    // against the look, from the situation's pool then the call's coarser pools; without the look; then run with the
    // personnel alone, then the formation alone; else as if none was picked (pfOk)
    samplePlaybook(team, callIdx, fk, u, oob, looks, s, route, who, pers, preDone, prot) {
      const P = this.e.pb, cdf = this._cdfOf(team, oob);
      const pool = P.poolOf[callIdx * P.nFine + fk];
      // a foul before the snap (a false start, a delay of game, a neutral zone infraction) has no look, route or
      // target charted: the play never ran. The filters below would leave every one of them out (players' offenses
      // never false-started: 0.6% of snaps against the real 1.6%, Oct 20), so they come first, as often as in the
      // situation's own pool, whatever was picked
      // (preDone: sampleVsDefense has drawn them; either way the plays drawn below leave them out)
      let pre = !!preDone;
      if ((looks || route || pers) && P.lookB && !preDone) {
        const B = this._preSnap(cdf, pool);
        if (B && u < B.share) return this._pickT(B, u / B.share);
        if (B) { u = (u - B.share) / (1 - B.share); pre = true; }
      }
      if (route && P.ngs) {
        // a sack, a scramble, a throwaway with nobody charted as the target: no route to filter them by, so a pick left
        // every one out (a picked pass was never sacked: 0% against the real 5%). They come first, as often as in
        // the situation's own plays (against the look the defense showed, when there are enough)
        // (your protection, prot: the pressured plays drawn less often, _protMix)
        const X = this._protMix(cdf, pool, preDone === 2 ? null : this._noTarget(cdf, pool, looks, callIdx),
          this.routeSet(team, callIdx, fk, oob, looks, s, route, who, pers), prot);
        const v = ntU(u, callIdx, route);
        if (X.N && v < X.share) return this._pickT(X.N, v / X.share);
        const r = this._pickT(X.T, u);
        if (r >= 0) return r;
      }
      if (pers && P.ngs && P.ngs.pers) {
        const pools = [pool];
        if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (!pools.includes(lp)) pools.push(lp); }
        // (only with enough plays with it, PB_LOOK_MIN: fewer, and the grouping is dropped; both picked, the grouping
        // alone goes next, then the formation alone)
        // (with the backfield picked too: all of it, the grouping with the backfield, the grouping, then the formation)
        const pg = pers & 255, fm = pers >> 8, picks = [pers, pg && fm >> 4 ? pg | ((fm >> 4) << 12) : 0, pg && fm ? pg : 0, pg && fm ? fm << 8 : 0]
          .filter((x, i, a) => x && a.indexOf(x) === i);
        for (const pf of picks) for (const lk of looks && P.lookB ? [looks, 0] : [0]) {
          for (const pl of pools) {
            const r = this._sampleLook(cdf, pl, u, lk, s, 0, 0, true, pf);
            if (r >= 0) return r;
          }
        }
      }
      if (looks && P.lookB) {
        let r = this._sampleLook(cdf, pool, u, looks, s);
        for (let b = 0; r < 0 && P.lookPool && b < 4; b++) {
          const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b];
          if ((looks >> b) & 1 && lp !== pool) r = this._sampleLook(cdf, lp, u, looks, s);
        }
        if (r >= 0) return r;
      }
      if (s || pre) return this._sampleLook(cdf, pool, u, 0, s, 0, 0, false, 0, pre);
      let lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      const target = pool + u;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < target) lo = mid + 1; else hi = mid; }
      return P.items[lo];
    }

    // a route as the daily game names it, with the depth a player drew it to when he drew it ('out@12'): its index in
    // the charting, and with a depth the code ri + 16 * (depth + 32), which keeps only the throws on that route that
    // went within DRAWN_WIN of that depth (a draw with none of them falls back to the route alone)
    _ri(route) {
      const P = this.e.pb, k = typeof route === 'string' ? route.indexOf('@') : -1, ri = P.routeNames.indexOf(k < 0 ? route : route.slice(0, k));
      if (!(ri > 0) || k < 0) return ri;
      const d = Math.round(Number(route.slice(k + 1)));
      return Number.isFinite(d) ? ri + 16 * (clip(d, -20, 70) + 32) : ri;
    }
    _rOk(r, ri) {
      const P = this.e.pb;
      if (P.ngs.route[r] !== (ri & 15)) return false;
      if (ri < 16) return true;
      const a = P.air ? P.air[r] : -128, d = (ri >> 4) - 32;
      return a !== -128 && Math.abs(a - d) <= Math.max(DRAWN_WIN, Math.abs(d) * 0.15);
    }
    // the real plays a pick (a receiver's route) draws from, with their weights: the route always; then the position,
    // then the look the defense showed, before the situation: the situation's pool, the call's coarser pools, every
    // situation of this call, then of every call of its kind (a dropback, play action, a rollout). null: none
    // (pers: the personnel and formation picked, kept first where the situation's pools have enough such plays)
    routeSet(team, callIdx, fk, oob, looks, s, route, who, pers) {
      const P = this.e.pb, cdf = this._cdfOf(team, oob);
      const ri0 = P.ngs ? this._ri(route) : -1;
      if (!(ri0 > 0)) return null;
      const pool = P.poolOf[callIdx * P.nFine + fk], coarse = [];
      if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (lp !== pool && !coarse.includes(lp)) coarse.push(lp); }
      const sets = [this._callRows(callIdx), this._groupRows(callIdx)];
      if (pers) {
        for (const ri of ri0 >= 16 ? [ri0, ri0 & 15] : [ri0]) for (const lk of looks ? [looks, 0] : [0]) {
          for (const pl of [pool, ...coarse]) { const T = this._lookT(cdf, pl, lk, s, ri, 0, true, pers); if (T) return T; }
          for (const set of sets) { const T = this._setT(set, lk, s, ri, 0, callIdx, oob, pers); if (T) return T; }
        }
      }
      for (const ri of ri0 >= 16 ? [ri0, ri0 & 15] : [ri0]) for (const w of who ? [who, 0] : [0]) for (const lk of looks ? [looks, 0] : [0]) {
        for (const pl of [pool, ...coarse]) { const T = this._lookT(cdf, pl, lk, s, ri, w, true); if (T) return T; }
        for (const set of sets) { const T = this._setT(set, lk, s, ri, w, callIdx, oob); if (T) return T; }
      }
      return null;
    }
    // what a pick tends to do here: the share of snaps caught, yards a snap, interceptions (weighted real plays), drawn
    // as the snap draws them (samplePlaybook): the sacks, scrambles and throwaways first (nt, as often as the
    // situation's plays have them), then the route's plays, with the pick's own count of repeats (act.rep), personnel,
    // formation, motion read and sideline. Shown as the chance per throw, it said 76% on picks that were caught 74% of
    // the time at best, and on a hitch thrown four times running 80% for 70% (a player: "told 70% or higher and get
    // screwed every time", Oct 22)
    routeOdds(team, callIdx, fk, looks, route, who, toGoal, act = {}) {
      const P = this.e.pb, s = this.matchOf(callIdx, this.defOfLooks(looks)) + repeatS(act), oob = act.oob ? 1 : -1;
      const cov0 = this._cov;
      this._cov = act.cov === 'man' ? 1 : act.cov === 'zone' ? 2 : 0;
      let T;
      try { T = this.routeSet(team, callIdx, fk, oob, looks, s, route, WHO_CODE[who] || 0, persForm(act)); } finally { this._cov = cov0; }
      if (!T) return null;
      const gain = (r) => (toGoal > 0 ? Math.min(P.yards[r], toGoal) : P.yards[r]);   // a play gains at most the goal line
      let w0 = 0, caught = 0, yds = 0, picks = 0;
      T.items.forEach((r, i) => {
        const w = T.cum[i] - (i ? T.cum[i - 1] : 0), f = P.flags[r], ev = P.eventNames[P.event[r]] || '';
        if (f & 1) return;                                             // penalties aside
        w0 += w; yds += w * gain(r);
        if (!(f & 4) && !(f & 64) && !/sack|scramble|throwaway/.test(ev)) caught += w;
        if ((f & 64) && /interception|pick_six/.test(ev)) picks += w;
      });
      if (!(w0 > 0)) return null;
      const cdf = this._cdfOf(team, oob), pool = P.poolOf[callIdx * P.nFine + fk];
      const X = this._protMix(cdf, pool, this._noTarget(cdf, pool, looks, callIdx), T, protOf(act)), N = X.N, nt = N ? X.share : 0;
      if (X.T !== T) {           // (your protection: the route's plays reweighted too)
        T = X.T; w0 = 0; caught = 0; yds = 0; picks = 0;
        T.items.forEach((r, i) => {
          const w = T.cum[i] - (i ? T.cum[i - 1] : 0), f = P.flags[r], ev = P.eventNames[P.event[r]] || '';
          if (f & 1) return;
          w0 += w; yds += w * gain(r);
          if (!(f & 4) && !(f & 64) && !/sack|scramble|throwaway/.test(ev)) caught += w;
          if ((f & 64) && /interception|pick_six/.test(ev)) picks += w;
        });
      }
      let ntY = 0;
      if (N) N.items.forEach((r, i) => { ntY += (N.cum[i] - (i ? N.cum[i - 1] : 0)) * gain(r); });
      if (N) ntY /= N.tot;
      return { caught: (1 - nt) * caught / w0, yds: (1 - nt) * yds / w0 + nt * ntY, picks: (1 - nt) * picks / w0, nt, n: T.items.length };
    }

    // daily game: a call of this kind ('run' or 'pass'), as often as NFL play-callers make each in situation fk; against
    // your defensive call (def, or the whole call dc) the offense checks into the calls that beat it (MATCH_AUDIBLE)
    pickCall(kind, fk, u, def, dc, read = 1) {
      const P = this.e.pb, nC = P.calls.length;
      const tilt = (c) => (def ? Math.exp(MATCH_AUDIBLE * P.match[c][def]) : dc ? Math.exp(DC_READ * read * dcEffect(P.dcEff, P.calls[c].id, dc).s) : 1);
      const w = (c) => P.freq[fk * nC + c] * tilt(c);
      let tot = 0;
      for (let c = 0; c < nC; c++) if (P.calls[c].kind === kind) tot += w(c);
      if (!(tot > 0)) return -1;
      let acc = 0, last = -1;
      for (let c = 0; c < nC; c++) {
        if (P.calls[c].kind !== kind) continue;
        acc += w(c); last = c;
        if (acc >= u * tot) return c;
      }
      return last;
    }
    // daily game: an offense that reads your whole defensive call leans to the run or the pass by how each does
    // against it here: DC_READ times the gap between its pass calls' and its run calls' edges (EPA, as often as
    // play-callers make each), on the logit of passing
    dcLean(fk, dc, read = 1) {
      const P = this.e.pb, nC = P.calls.length, m = { run: [0, 0], pass: [0, 0] };
      for (let c = 0; c < nC; c++) {
        const f = P.freq[fk * nC + c], k = P.calls[c].kind;
        if (f > 0 && m[k]) { m[k][0] += f * dcEffect(P.dcEff, P.calls[c].id, dc).s; m[k][1] += f; }
      }
      const avg = (x) => (x[1] > 0 ? x[0] / x[1] : 0);
      return DC_READ * read * (avg(m.pass) - avg(m.run));
    }
    // what NFL defenses called in situation fk (the real plays of every call's pool, as often as play-callers make
    // each call): the share of each personnel group, front, coverage and rush, as charted (DC). Null without charting
    dcShares(fk) {
      const P = this.e.pb, N = P.ngs, nC = P.calls.length;
      if (!N || !N.dpers) return null;
      const acc = { pers: {}, front: {}, cover: {}, rush: {} };
      const inR = (x, [a, b]) => x >= a && x <= b;
      const bump = (part, k, w) => { if (k !== undefined) acc[part][k] = (acc[part][k] || 0) + w; };
      for (let c = 0; c < nC; c++) {
        const f = P.freq[fk * nC + c];
        if (!(f > 0)) continue;
        const pool = P.poolOf[c * P.nFine + fk], lo = P.offsets[pool], hi = P.offsets[pool + 1], w = f / Math.max(hi - lo, 1);
        for (let i = lo; i < hi; i++) {
          const r = P.items[i], box = P.look ? P.look[r] >> 4 : 0, sh = N.cover[r] & 15, ru = N.rush[r] & 15, db = N.dpers[r];
          if (db) bump('pers', Object.keys(DC.pers).find((k) => inR(db, DC.pers[k])), w);
          if (box) bump('front', Object.keys(DC.front).find((k) => inR(box, DC.front[k])), w);
          if (sh) bump('cover', Object.keys(DC.cover).find((k) => DC.cover[k].includes(sh)), w);
          if (ru && P.calls[c].kind === 'pass') bump('rush', Object.keys(DC.rush).find((k) => inR(ru, DC.rush[k])), w);
        }
      }
      for (const part of Object.keys(acc)) {
        const t = Object.values(acc[part]).reduce((a, b) => a + b, 0);
        for (const k of Object.keys(acc[part])) acc[part][k] = t ? acc[part][k] / t : 0;
      }
      return acc;
    }
    // the matchup of call c against the defense's call def ('blitz' | 'load' | 'soft'), or against a one-look mask
    matchOf(c, def) { return c >= 0 && def ? this.e.pb.match[c][def] : 0; }
    defOfLooks(looks) {
      if (!looks) return null;
      for (let b = 0; b < 4; b++) if (looks === 1 << b) return LOOK_DEF[b];
      return null;
    }

    // a play of pool `pool` run against one of the looks in mask `looks` (0: any look), with the target's route ri and
    // position who when given (0: any), by the pool's weights tilted by the matchup s; -1 when fewer than PB_LOOK_MIN
    // of its plays pass the filters (any filter set: looks or, with need, a route). The filtered, tilted weights are
    // built once per pool and filter (a simulation draws the root play once, the same way thousands of times)
    _sampleLook(cdf, pool, u, looks, s, ri, who, need, pers, noPre) {
      return this._pickT(this._lookT(cdf, pool, looks, s, ri, who, need, pers, noPre), u);
    }
    // the coverage a motion showed (this._cov, from act.cov while a play is drawn: 1 man, 2 zone): a play charted in
    // it (NGS: the cover byte's high bits), or one nothing was charted on (a flag; most sacks, scrambles)
    _covOk(r, cv) {
      const N = this.e.pb.ngs, m = N && N.cover ? N.cover[r] >> 4 : 0;
      return !m || m === cv;
    }
    // a foul before the snap, or another flag nothing was charted for (no look: what a pick filters on says nothing
    // about it); and a pool's such plays, by its weights, with their share of the pool (null: none)
    _isPreSnap(r) { const P = this.e.pb; return (P.flags[r] & 1) !== 0 && P.lookB[r] === 255; }
    _preSnap(cdf, pool) {
      this._pre = this._pre || new WeakMap();
      let byPool = this._pre.get(cdf);
      if (!byPool) { byPool = new Map(); this._pre.set(cdf, byPool); }
      let T = byPool.get(pool);
      if (T !== undefined) return T;
      const P = this.e.pb, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1, items = [], cum = [];
      let tot = 0;
      for (let i = lo; i <= hi; i++) {
        const r = P.items[i];
        if (!this._isPreSnap(r)) continue;
        tot += cdf[i] - (i > lo ? cdf[i - 1] : pool); items.push(r); cum.push(tot);
      }
      T = tot > 0 && tot < 0.5 ? { items, cum, tot, share: tot } : null;
      byPool.set(pool, T);
      return T;
    }
    // the dropbacks of a pool with no target charted (sacks, scrambles, most throwaways), against the look when
    // PB_LOOK_MIN plays of the pool were run against it, else the whole pool; share: their weight in its plays after
    // the snap
    _noTarget(cdf, pool, looks, callIdx) {
      const P = this.e.pb;
      if (!P.ngs || !P.ngs.route) return null;
      this._nt = this._nt || new WeakMap();
      let byPool = this._nt.get(cdf);
      if (!byPool) { byPool = new Map(); this._nt.set(cdf, byPool); }
      const cap = callIdx >= 0 && /^roll_/.test(P.calls[callIdx].id) ? ROLL_NT : 0.9;
      const key = `${pool}|${looks || 0}|${cap}`;
      let T = byPool.get(key);
      if (T !== undefined) return T;
      const lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      const build = (lk) => {
        const items = [], cum = [];
        let tot = 0, all = 0, n = 0;
        for (let i = lo; i <= hi; i++) {
          const r = P.items[i];
          if (this._isPreSnap(r)) continue;
          if (lk && P.lookB && !(P.lookB[r] < 4 && (lk >> P.lookB[r]) & 1)) continue;
          const w = cdf[i] - (i > lo ? cdf[i - 1] : pool);
          all += w; n++;
          if ((P.flags[r] & 1) || P.ngs.route[r] !== 0 || !NO_TARGET_EV.has(P.eventNames[P.event[r]] || '')) continue;
          tot += w; items.push(r); cum.push(tot);
        }
        return (n >= PB_LOOK_MIN || !lk) && all > 0 ? { items, cum, tot, share: tot / all } : null;
      };
      T = (looks && build(looks)) || build(0);
      if (T && !(T.tot > 0 && T.share < 0.9)) T = null;
      if (T && T.share > cap) T = { ...T, share: cap };
      byPool.set(key, T);
      return T;
    }
    // pass protection (prot: PROT_N blockers more): the pressure of a draw's sacks, scrambles and throwaways (N, drawn
    // first at its share) and of the route's plays (T; null: as the situation's pool), the pressured ones weighted m so
    // the whole is pressured PROT_F as often a blocker. Returns the sets reweighted, N's new share and m
    _protMix(cdf, pool, N, T, prot) {
      if (!prot || !this.e.pb.ngs || !this.e.pb.ngs.rush) return { N, T, share: N ? N.share : 0, m: 1 };
      const pp = this._poolPress(cdf, pool), pN = N ? this._pressOf(N) : 0, pT = T ? this._pressOf(T) : pp;
      const s0 = N ? N.share : 0, p = s0 * pN + (1 - s0) * pT;
      if (!(p > 0 && p < 1)) return { N, T, share: s0, m: 1 };
      const p1 = p * Math.pow(PROT_F, prot), m = (p1 * (1 - p)) / (p * (1 - p1));
      const a = s0 * (m * pN + 1 - pN), b = (1 - s0) * (m * pT + 1 - pT);
      return { N: this._protT(N, m), T: this._protT(T, m), share: a / (a + b), m };
    }
    _pressOf(T) {
      const R = this.e.pb.ngs.rush;
      let w = 0, pw = 0;
      T.items.forEach((r, i) => { const x = T.cum[i] - (i ? T.cum[i - 1] : 0); w += x; if ((R[r] >> 4) & 1) pw += x; });
      return w > 0 ? pw / w : 0;
    }
    _poolPress(cdf, pool) {
      const P = this.e.pb, R = P.ngs.rush, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      let w = 0, pw = 0;
      for (let i = lo; i <= hi; i++) { const x = cdf[i] - (i > lo ? cdf[i - 1] : pool), r = P.items[i]; w += x; if ((R[r] >> 4) & 1) pw += x; }
      return w > 0 ? pw / w : 0;
    }
    // a set with its pressured plays weighted m (cached on the set)
    _protT(T, m) {
      if (!T || m === 1 || !(T.items && T.items.length)) return T;
      const R = this.e.pb.ngs.rush;
      this._pt = this._pt || new WeakMap();
      let by = this._pt.get(T);
      if (!by) { by = new Map(); this._pt.set(T, by); }
      let o = by.get(m);
      if (o) return o;
      const cum = new Array(T.items.length);
      let tot = 0;
      T.items.forEach((r, i) => { const x = T.cum[i] - (i ? T.cum[i - 1] : 0); tot += (R[r] >> 4) & 1 ? x * m : x; cum[i] = tot; });
      o = { ...T, cum, tot };
      by.set(m, o);
      return o;
    }
    _pickT(T, u) {
      if (!T) return -1;
      const target = u * T.tot, c = T.cum;
      let a = 0, b = c.length - 1;
      while (a < b) { const m = (a + b) >> 1; if (c[m] < target) a = m + 1; else b = m; }
      return T.items[a];
    }
    // (noPre: without the fouls before the snap, drawn on their own: samplePlaybook)
    _lookT(cdf, pool, looks, s, ri, who, need, pers, noPre) {
      const cv = this._cov || 0;
      const key = `${pool}|${looks}|${s || 0}|${ri || 0}|${who || 0}|${pers || 0}|${need ? 1 : 0}${noPre ? '|x' : ''}${cv ? `|c${cv}` : ''}`;
      this._pick = this._pick || new WeakMap();
      let byKey = this._pick.get(cdf);
      if (!byKey) { byKey = new Map(); this._pick.set(cdf, byKey); }
      let T = byKey.get(key);
      if (T === undefined) {
        const P = this.e.pb, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1, k = s ? (MATCH_SD * s) / Math.sqrt(this._poolVar(cdf, pool)) : 0;
        const items = [], cum = [];
        let tot = 0, sq = 0;
        for (let i = lo; i <= hi; i++) {
          const r = P.items[i];
          if ((looks || ri || who || pers || noPre) && P.lookB && this._isPreSnap(r)) continue;     // (samplePlaybook draws them first)
          if (looks) { const b = P.lookB[r]; if (!(b < 8 && (looks >> b) & 1)) continue; }
          if (ri && !this._rOk(r, ri)) continue;
          if (who && (P.carry[r] & 7) !== who) continue;
          if (pers && !pfOk(P, r, pers, false)) continue;
          if (cv && !this._covOk(r, cv)) continue;
          let w = cdf[i] - (i > lo ? cdf[i - 1] : pool);
          if (k) { const e = P.epa[r]; if (Number.isFinite(e)) w *= Math.exp(k * clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP)); }
          tot += w; sq += w * w; items.push(r); cum.push(tot);
        }
        // a personnel group's plays count by their weights too (tot^2 / sum w^2, the plays they amount to): a few
        // heavy ones among many light are a few plays, the same results snap after snap (Oct 20: the day's 12
        // personnel at the Dallas 16 drew a 3-yard loss on 4 runs in 10)
        const few = items.length < PB_LOOK_MIN || (pers && tot * tot < PB_LOOK_MIN * sq);
        T = ((looks || need) && few) || !(tot > 0) ? null : { items, cum, tot };
        byKey.set(key, T);
      }
      return T;
    }

    // a real play of call callIdx against the defense's call dc: at each filter level (DC_PASS_LV / DC_RUN_LV, the
    // strictest first), from the situation's pool, the call's coarser pools, then its plays from the same down and
    // distance or part of the field ('near'), then (keeping the pass rush or the box) every situation of the call and
    // of its kind ('wide'); with a picked route (ri) and target (who), only plays of that route. The plays the
    // defense's call says nothing about (_dcAbout: the flags; on a pass call what is not a dropback, an RPO's
    // handoffs) come from the situation's own pool, as often as there. Its mean EPA:
    // the offense's own here plus the defense's effect s (dcEffect). No pool at all: samplePlaybook
    sampleVsDefense(team, callIdx, fk, u, oob, dc, s, route, who, pers, prot) {
      const P = this.e.pb;
      let preDone = false;
      if (P.ngs && P.ngs.dpers && dcValid(dc)) {
        const cdf = this._cdfOf(team, oob), pool = P.poolOf[callIdx * P.nFine + fk], pools = [pool];
        // a foul before the snap, with a route or personnel picked (samplePlaybook's): as often as in the situation's
        // pool (without a pick the situation's own plays the call is not about bring them: _dcRef)
        if ((route || pers) && P.lookB) {
          const B = this._preSnap(cdf, pool);
          if (B && u < B.share) return this._pickT(B, u / B.share);
          if (B) u = (u - B.share) / (1 - B.share);
          preDone = true;
        }
        // (and a pick's sacks, scrambles and throwaways, samplePlaybook's, as often as in the situation's plays;
        // preDone 2: samplePlaybook, if it comes to that, has them drawn)
        let pm = 1;
        if (route && P.calls[callIdx].kind !== 'run') {
          // (your protection: as samplePlaybook's, the route's plays taken as pressured as the situation's)
          const X = this._protMix(cdf, pool, this._noTarget(cdf, pool, 0, callIdx), null, prot);
          pm = X.m;
          const v = ntU(u, callIdx, route);
          if (X.N && v < X.share) return this._pickT(X.N, v / X.share);
          preDone = 2;
        }
        if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (!pools.includes(lp)) pools.push(lp); }
        const ri0 = route ? this._ri(route) : 0;
        if (!(route && !(ri0 > 0))) for (const ri of ri0 >= 16 ? [ri0, ri0 & 15] : [ri0]) {
          const pass = P.calls[callIdx].kind !== 'run';
          const ref = this._dcRef(cdf, pool, pass, ri, who || 0, pers || 0);
          // the wider sets, built only when a draw gets to them
          const near = DC_NEAR.map(([dz, dy, dd]) => () => this._nearRows(callIdx, fk, dz, dy, dd));
          const wide = [() => this._wideRows(callIdx, fk, false), () => this._wideRows(callIdx, fk, true)];
          const seen = new Set();
          for (const [l, where] of pass ? DC_PASS_LV : DC_RUN_LV) {
            const L = pers ? l : l.filter((x) => x !== 'pers');
            const key = `${L.join()}|${where}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (where !== 'wide') {
              for (const pl of where === 'pool' ? [pool] : pools) {
                const r = this._pickT(this._protT(this._dcT(cdf, pl, null, dc, L, s, ri, who || 0, pers || 0, pass, ref), pm), u);
                if (r >= 0) return r;
              }
            }
            if (where === 'pool') continue;
            for (const set of where === 'near' ? near : wide) {
              const r = this._pickT(this._protT(this._dcT(null, -1, set(), dc, L, s, ri, who || 0, pers || 0, pass, ref, callIdx, oob), pm), u);
              if (r >= 0) return r;
            }
          }
        }
      }
      return this.samplePlaybook(team, callIdx, fk, u, oob, 0, 0, route, who, pers, preDone, prot);
    }
    // each real play's EPA (capped) over the mean of its own situation's pool (the smallest pool a situation draws
    // from that holds it: its call in its situation, or the coarser one its situation was pooled into), as
    // playbook.py dc_effects measures the defense's effects: a play borrowed from another down or another part of
    // the field is judged against where it was run, not where it is drawn
    _dcResid() {
      const P = this.e.pb;
      if (P.dcResid) return P.dcResid;
      const nRows = P.yards.length, best = new Int32Array(nRows).fill(-1), size = new Int32Array(nRows), base = new Set();
      for (let i = 0; i < P.poolOf.length; i++) base.add(P.poolOf[i]);
      const mean = new Float64Array(P.nPools);
      for (const p of base) {
        const lo = P.offsets[p], hi = P.offsets[p + 1], n = hi - lo;
        let m = 0;
        for (let i = lo; i < hi; i++) { const e = P.epa[P.items[i]]; m += Number.isFinite(e) ? clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP) : 0; }
        mean[p] = n ? m / n : 0;
        for (let i = lo; i < hi; i++) { const r = P.items[i]; if (best[r] < 0 || n < size[r]) { best[r] = p; size[r] = n; } }
      }
      P.dcPoolMean = mean;
      P.dcResid = new Float32Array(nRows);
      for (let r = 0; r < nRows; r++) {
        const e = P.epa[r];
        P.dcResid[r] = (Number.isFinite(e) ? clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP) : 0) - (best[r] >= 0 ? mean[best[r]] : 0);
      }
      return P.dcResid;
    }
    // a play the defense's call is about: no flag (a flag's rate is the situation's, whatever the call; and the
    // charting of a play called back is thin), and on a pass call a dropback (thrown, incomplete, or a sack,
    // scramble, throwaway, pick or drop)
    _dcAbout(r, pass) {
      const P = this.e.pb;
      if (P.flags[r] & 1) return false;
      return !pass || (P.air && P.air[r] !== -128) || (P.flags[r] & 4) !== 0 || DROPBACK_EV.has(P.eventNames[P.event[r]] || '');
    }
    // the situation's own plays, by the pool's weights, with the offense's filters (route, target, personnel): the
    // edge of those the defense's call is about (their mean capped EPA over the pool's; null with fewer than
    // PB_LOOK_MIN of them), and the others, drawn as they are, with their share
    _dcRef(cdf, pool, pass, ri, who, pers) {
      const key = `${pool}|${pass ? 1 : 0}|${ri}|${who}|${pers}`;
      this._dcRefs = this._dcRefs || new WeakMap();
      let cache = this._dcRefs.get(cdf);
      if (!cache) { cache = new Map(); cache.uid = this._dcRefN = (this._dcRefN || 0) + 1; this._dcRefs.set(cdf, cache); }
      let R = cache.get(key);
      if (R) return R;
      const P = this.e.pb, N = P.ngs, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      let wA = 0, mA = 0, nA = 0, wB = 0;
      const items = [], cum = [];
      for (let i = lo; i <= hi; i++) {
        const r = P.items[i];
        if ((ri || who || pers) && P.lookB && this._isPreSnap(r)) continue;     // (sampleVsDefense draws them first)
        if (ri && !this._rOk(r, ri)) continue;
        if (who && (P.carry[r] & 7) !== who) continue;
        if (pers && !pfOk(P, r, pers, true)) continue;
        const w = cdf[i] - (i > lo ? cdf[i - 1] : pool);
        if (this._dcAbout(r, pass)) {
          const e = P.epa[r];
          wA += w; mA += w * (Number.isFinite(e) ? clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP) : 0); nA++;
        } else { wB += w; items.push(r); cum.push(wB); }
      }
      this._dcResid();
      // edge: what the offense's plays the call is about are worth here over the situation's pool (its own weights:
      // the team, the call's intent), the level a draw's plays are moved to before the defense's effect
      const pm = P.dcPoolMean[pool];
      // (id: the reference exactly, for the draws' caches: a table built against one is never reused for another)
      R = { id: `${cache.uid}:${key}`, edge: nA >= PB_LOOK_MIN && wA > 0 ? mA / wA - pm : null, shareB: wA + wB > 0 ? wB / (wA + wB) : 0, items, cum, tot: wB };
      cache.set(key, R);
      return R;
    }
    // the plays of a pool (by its weights) or of a set of rows (equal weights) that the defense's call is about and
    // that pass the filters L against dc (a filter it was not charted for leaves a play out: the pass rush and the
    // coverage from the seasons charted in full, playbook.py _charted_in_full); null when fewer than DC_MIN of them
    // pass (any number, with no filters). Their mean EPA over where each was run (_dcResid) is set to the offense's
    // own edge here (ref.edge; without one, that of the same plays without the defense's filters) plus the defense's
    // effect s, by the least tilt that does it:
    // the real plays against the called defense keep their shape (the sacks, the pressure, the quick throws, the big
    // plays), and a handful of them against a rare defense never decide what it is worth (their mean is noise; s is
    // the estimate). The plays it is not about (ref) are added as they are, with their share of the situation's
    // A set of rows (no pool's weights) takes the carrier's try (c, oob: _oobW) as a pool's plays do from pbTilt
    _dcT(cdf, pool, set, dc, L, s, ri, who, pers, pass, ref, c, oob) {
      const om = set ? oobMode(oob) : 0, P0 = this.e.pb;
      const key = `dc|${set ? set.id : pool}|${dc.pers}|${dc.front}|${dc.cover}|${dc.rush}|${L.join('.')}|${s || 0}|${ri}|${who}|${pers}|${pass ? 1 : 0}|${ref.id}|${om ? `${P0.oobKey[c]}:${om}` : ''}`;
      let cache;
      if (set) cache = this._dcSet = this._dcSet || new Map();
      else {
        this._dcPick = this._dcPick || new WeakMap();
        cache = this._dcPick.get(cdf);
        if (!cache) { cache = new Map(); this._dcPick.set(cdf, cache); }
      }
      let T = cache.get(key);
      if (T !== undefined) return T;
      const P = this.e.pb, N = P.ngs, cov = DC.cover[dc.cover], man = DC_MAN.has(dc.cover) ? 1 : 2;
      const [p0, p1] = DC.pers[dc.pers], [f0, f1] = DC.front[dc.front], [r0, r1] = DC.rush[dc.rush], blitz = +dc.rush >= 5 ? 1 : 0;
      const on = (d) => L.includes(d), byPers = on('pers');
      // 0: the offense's own filters drop it, or the defense's call is not about it; 1: the defense's filters do (or
      // it was not charted for one); 2: it passes
      const test = (r) => {
        if (ri && !this._rOk(r, ri)) return 0;
        if (who && (P.carry[r] & 7) !== who) return 0;
        if (byPers && !pfOk(P, r, pers, true)) return 0;
        if (!this._dcAbout(r, pass)) return 0;
        if (!L.length) return 2;
        const box = P.look ? P.look[r] >> 4 : 0, full = (N.rush[r] & 64) !== 0;
        if (on('rush')) { const n = N.rush[r] & 15; if (!full || !n || n < r0 || n > r1) return 1; }
        if (on('cov')) { const sh = N.cover[r] & 15; if (!full || !sh || !cov.includes(sh)) return 1; }
        if (on('mz')) { const m = (N.cover[r] >> 4) & 3; if (!full || m !== man) return 1; }
        if (on('db')) { const n = N.dpers[r]; if (!n || n < p0 || n > p1) return 1; }
        if (on('box')) { if (!box || box < f0 || box > f1) return 1; }
        if (on('blitz')) { if (!box || ((P.look[r] >> 3) & 1) !== blitz) return 1; }
        return 2;
      };
      const items = [], ws = [], xs = [], X = this._dcResid();
      let hits = 0, r0w = 0, r1w = 0;          // the reference (the offense's own filters only): weight, sum
      const take = (r, w) => {
        const x = test(r);
        if (!x) return;
        const e = X[r];
        r0w += w; r1w += w * e;
        if (x === 1) return;
        hits++;
        items.push(r); ws.push(w); xs.push(e);
      };
      if (set && !om) for (const r of set.rows) take(r, 1);
      else if (set) {
        // in one pass: a play he went out on at its multiplier, then the plays he had the ball on (of the reference)
        // scaled back to their share (_oobW's z), the reference's sums with them
        const K = this.e.pb.oobCls, mul = this._oobMulOf(c, om), cls = [];
        let sE = 0, sM = 0, rw0 = 0, rw1 = 0, rwC0 = 0, rwC1 = 0;
        for (const r of set.rows) {
          const x = test(r);
          if (!x) continue;
          const kc = K[r], w = kc === 2 ? mul(r) : 1, e = X[r];
          if (kc) { sE += 1; sM += w; rwC0 += w; rwC1 += w * e; } else { rw0 += w; rw1 += w * e; }
          if (x === 1) continue;
          hits++;
          items.push(r); ws.push(w); xs.push(e); cls.push(kc);
        }
        const z = sM > 0 ? sE / sM : 1;
        for (let i = 0; i < ws.length; i++) if (cls[i]) ws[i] *= z;
        r0w = rw0 + z * rwC0; r1w = rw1 + z * rwC1;
      }
      else {
        const lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
        for (let i = lo; i <= hi; i++) take(P.items[i], cdf[i] - (i > lo ? cdf[i - 1] : pool));
      }
      if ((L.length && hits < DC_MIN) || !hits || !(r0w > 0)) { cache.set(key, null); return null; }
      const k = this._tiltTo(ws, xs, (ref.edge == null ? r1w / r0w : ref.edge) + (s || 0));
      const cum = [];
      let tot = 0;
      for (let i = 0; i < items.length; i++) { tot += ws[i] * Math.exp(k * xs[i]); cum.push(tot); }
      // the plays the call is not about, as often as in the situation: scaled to their share of the whole
      const shB = ref.tot > 0 ? Math.min(ref.shareB, 0.95) : 0, scale = tot > 0 && shB > 0 ? (tot * shB / (1 - shB)) / ref.tot : 0;
      if (scale > 0) for (let j = 0; j < ref.items.length; j++) { items.push(ref.items[j]); cum.push(tot + ref.cum[j] * scale); }
      if (scale > 0) tot += ref.tot * scale;
      T = tot > 0 ? { items, cum, tot } : null;
      cache.set(key, T);
      return T;
    }
    // the exponential tilt k that moves the weighted mean of xs (weights ws) to target (as near as the plays allow)
    _tiltTo(ws, xs, target) {
      const mean = (k) => { let a = 0, b = 0; for (let i = 0; i < xs.length; i++) { const w = ws[i] * Math.exp(k * xs[i]); a += w; b += w * xs[i]; } return b / a; };
      let lo = -4, hi = 4;
      if (mean(lo) >= target) return lo;
      if (mean(hi) <= target) return hi;
      for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (mean(mid) < target) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }

    // every play of call c in the situations near fk (same game mode; the part of the field up to dz zones farther
    // from the goal, the distance within dy buckets, and the down unless dd: null for any), once. Never nearer the
    // goal (a play run there was cut short by its end zone: it would bring that short field along; one from farther
    // out gains at most the goal line here, as the game plays it), and never into another part of the field
    // (dcRegion: a goal-line play is not a red-zone one, nor that an open-field one; and a defense common at the goal
    // line would crowd out the rest), nor across short yardage (dcShort)
    _nearRows(c, fk, dz, dy, dd) {
      const P = this.e.pb, zone = fk % N_ZONE, ytg = Math.floor(fk / N_ZONE) % N_YTG, dn = Math.floor(fk / (N_YTG * N_ZONE)) % N_DOWN,
        mode = Math.floor(fk / (N_DOWN * N_YTG * N_ZONE)), region = dcRegion(zone), short = dcShort(fk);
      const id = `n${c}|${mode}|${dn}|${ytg}|${zone}|${dz}|${dy}|${dd ? 1 : 0}`;
      return this._rowSet(id, (seen) => {
        for (let f = 0; f < P.nFine; f++) {
          if (Math.floor(f / (N_DOWN * N_YTG * N_ZONE)) !== mode || dcRegion(f % N_ZONE) !== region || f % N_ZONE < zone || dcShort(f) !== short) continue;
          if (dz != null && f % N_ZONE - zone > dz) continue;
          if (dy != null && Math.abs(Math.floor(f / N_ZONE) % N_YTG - ytg) > dy) continue;
          if (!dd && Math.floor(f / (N_YTG * N_ZONE)) % N_DOWN !== dn) continue;
          const pool = P.poolOf[c * P.nFine + f];
          for (let i = P.offsets[pool]; i < P.offsets[pool + 1]; i++) seen.add(P.items[i]);
        }
      });
    }
    // a set of plays (built once by fill, kept on the playbook: every match of a server shares them), the kept ones
    // held under DC_ROWS_CAP plays in all (a long-lived server's memory): past it they are all let go, to be rebuilt
    _rowSet(id, fill) {
      const P = this.e.pb;
      if (!P.rowSets) { P.rowSets = new Map(); P.rowSetsN = 0; }
      let set = P.rowSets.get(id);
      if (!set) {
        const seen = new Set();
        fill(seen);
        set = { id, rows: Int32Array.from(seen) };
        if (P.rowSetsN + set.rows.length > DC_ROWS_CAP) { P.rowSets.clear(); P.rowSetsN = 0; }
        P.rowSets.set(id, set);
        P.rowSetsN += set.rows.length;
      }
      return set;
    }
    // every play of call c (grp: of every call of its kind) in fk's part of the field (dcRegion) and no nearer the
    // goal, in any game mode, down and distance (short yardage or not, as fk: dcShort), once
    _wideRows(c, fk, grp) {
      const P = this.e.pb, zone = fk % N_ZONE, region = dcRegion(zone), short = dcShort(fk), kind = (id) => (id.startsWith('pa_') ? 'pa' : id.startsWith('roll') ? 'roll'
        : id.startsWith('rpo') || id === 'hail_mary' || id.startsWith('trick') ? id : 'drop');
      const id = `w${grp ? `g${kind(P.calls[c].id)}${P.calls[c].kind}` : c}|${zone}|${short ? 1 : 0}`;
      return this._rowSet(id, (seen) => {
        const calls = grp ? P.calls.map((cc, j) => j).filter((j) => kind(P.calls[j].id) === kind(P.calls[c].id) &&
          (P.calls[j].kind === 'pass') === (P.calls[c].kind === 'pass')) : [c];
        for (const j of calls) {
          for (let f = 0; f < P.nFine; f++) {
            if (dcRegion(f % N_ZONE) !== region || f % N_ZONE < zone || dcShort(f) !== short) continue;
            const pool = P.poolOf[j * P.nFine + f];
            for (let i = P.offsets[pool]; i < P.offsets[pool + 1]; i++) seen.add(P.items[i]);
          }
        }
      });
    }
    // every play of call c, in any situation, once; and of every call of its kind (dropback, play action, rollout)
    _callRows(c) {
      const P = this.e.pb;
      P.callRows = P.callRows || [];
      if (!P.callRows[c]) {
        const seen = new Set();
        for (let fk = 0; fk < P.nFine; fk++) {
          const pool = P.poolOf[c * P.nFine + fk];
          for (let i = P.offsets[pool]; i < P.offsets[pool + 1]; i++) seen.add(P.items[i]);
        }
        P.callRows[c] = { id: `c${c}`, rows: Int32Array.from(seen) };
      }
      return P.callRows[c];
    }
    _groupRows(c) {
      const P = this.e.pb, id = P.calls[c].id;
      const g = id.startsWith('pa_') ? 'pa' : id.startsWith('roll') ? 'roll' : id.startsWith('rpo') || id === 'hail_mary' || id.startsWith('trick') ? id : 'drop';
      P.groupRows = P.groupRows || {};
      if (!P.groupRows[g]) {
        const seen = new Set();
        P.calls.forEach((cc, j) => {
          const gj = cc.id.startsWith('pa_') ? 'pa' : cc.id.startsWith('roll') ? 'roll' : cc.id.startsWith('rpo') || cc.id === 'hail_mary' || cc.id.startsWith('trick') ? cc.id : 'drop';
          if (gj === g && cc.kind === 'pass') this._callRows(j).rows.forEach((r) => seen.add(r));
        });
        P.groupRows[g] = { id: `g${g}`, rows: Int32Array.from(seen) };
      }
      return P.groupRows[g];
    }
    // a play from a set of rows (equal weights), with the same filters and matchup tilt as _sampleLook
    _sampleSet(set, u, looks, s, ri, who) { return this._pickT(this._setT(set, looks, s, ri, who), u); }
    // a set of rows' weights (w, one a row) with the carrier's try (om, call c) as pbTilt gives a pool's: a play he went
    // out on times its multiplier, the plays he had the ball on scaled back to their share
    _oobW(c, om, rows, w) {
      if (!om) return w;
      const K = this.e.pb.oobCls, mul = this._oobMulOf(c, om), m = rows.map((r) => (K[r] === 2 ? mul(r) : 1));
      let sE = 0, sM = 0;
      rows.forEach((r, i) => { if (K[r]) { sE += w[i]; sM += w[i] * m[i]; } });
      const z = sM > 0 ? sE / sM : 1;
      return rows.map((r, i) => (K[r] ? w[i] * m[i] * z : w[i]));
    }
    // engine pbOobMul for call c and om, as a function of the row (its tables looked up once)
    _oobMulOf(c, om) {
      const P = this.e.pb, rt = P.ngs ? P.ngs.route : null;
      const t = om < 0 ? (P.stayRoute ? P.stayRoute[c] : null) : (P.oobRoute ? P.oobRoute[c] : null);
      const fam = om < 0 ? (P.stayOdds ? P.stayOdds[c] : 1) : P.oobOdds[c];
      return t && rt ? (r) => t[rt[r]] ?? fam : () => fam;
    }
    _setT(set, looks, s, ri, who, c, oob, pers) {
      const om = c >= 0 ? oobMode(oob) : 0, P0 = this.e.pb;
      const cv = this._cov || 0;
      const key = `${set.id}|${looks}|${s || 0}|${ri || 0}|${who || 0}|${om ? `${P0.oobKey[c]}:${om}` : ''}${cv ? `|c${cv}` : ''}${pers ? `|p${pers}` : ''}`;
      this._setPick = this._setPick || new Map();
      let T = this._setPick.get(key);
      if (T === undefined) {
        const P = this.e.pb, rows = [];
        for (const r of set.rows) {
          if (looks) { const b = P.lookB[r]; if (!(b < 8 && (looks >> b) & 1)) continue; }
          if (ri && !this._rOk(r, ri)) continue;
          if (who && (P.carry[r] & 7) !== who) continue;
          if (cv && !this._covOk(r, cv)) continue;
          if (pers && !pfOk(P, r, pers, false)) continue;
          rows.push(r);
        }
        let k = 0;
        if (s && rows.length) {
          let m1 = 0, m2 = 0;
          rows.forEach((r) => { const x = clip(Number.isFinite(P.epa[r]) ? P.epa[r] : 0, -MATCH_EPA_CAP, MATCH_EPA_CAP); m1 += x; m2 += x * x; });
          k = (MATCH_SD * s) / Math.sqrt(Math.max(m2 / rows.length - (m1 / rows.length) ** 2, 0.3));
        }
        const cum = [];
        let tot = 0;
        const ws = this._oobW(c, om, rows, rows.map((r) => { const e = P.epa[r]; return k && Number.isFinite(e) ? Math.exp(k * clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP)) : 1; }));
        ws.forEach((w) => { tot += w; cum.push(tot); });
        T = rows.length < PB_LOOK_MIN ? null : { items: rows, cum, tot };
        this._setPick.set(key, T);
      }
      return T;
    }

    // the variance of a pool's (capped) EPA, by its weights: an exponential tilt k shifts the mean by about k * var
    _poolVar(cdf, pool) {
      this._var = this._var || new WeakMap();          // per weight table (team, out of bounds or not), per pool
      let byPool = this._var.get(cdf);
      if (!byPool) { byPool = new Map(); this._var.set(cdf, byPool); }
      let v = byPool.get(pool);
      if (v !== undefined) return v;
      const P = this.e.pb, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      let w0 = 0, m1 = 0, m2 = 0;
      for (let i = lo; i <= hi; i++) {
        const w = cdf[i] - (i > lo ? cdf[i - 1] : pool), e = P.epa[P.items[i]];
        if (!Number.isFinite(e)) continue;
        const x = clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP);
        w0 += w; m1 += w * x; m2 += w * x * x;
      }
      v = w0 > 0 ? Math.max(m2 / w0 - (m1 / w0) * (m1 / w0), 0.3) : 1;
      byPool.set(pool, v);
      return v;
    }

    sampleStop(team, pool, u) {
      const E = this.e, cdf = this.stopCdf[team];
      let lo = E.stopOff[pool], hi = E.stopOff[pool + 1] - 1;
      if (hi < lo) return -1;
      const target = pool + u;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < target) lo = mid + 1; else hi = mid; }
      return E.lib.items[E.stopPos[lo]];
    }

    puntReceiveYl(yl, team) {
      const net = this.e.expNet[clip(Math.trunc(yl), 0, 100)] + this.ctx.punterShift[team];
      const spot = yl - net;
      return spot <= 0 ? 80 : clip(100 - spot, 1, 99);
    }

    // ------------------------------------------------------------------ run ---
    run(root, opts) {
      opts = opts || {};
      const n = opts.n || 4000, action = opts.action || {}, persp = opts.perspective || 0, seed = (opts.seed || 0) >>> 0;
      const maxSteps = opts.maxSteps || 300;
      const g = this._geom(root);
      const values = new Float64Array(n);
      const S = { t: 0, pos: 0, s: [0, 0], down: 1, ytg: 10, yl: 75, to: [3, 3], running: false, credit: 0,
        phase: SNAP, freeKick: false, stratActive: false, plays: 0 };
      const u = new Float64Array(8);
      let sum = 0;
      // descriptive drive stats for the possession in progress (they do not affect the value)
      let driveEndT = 0, driveTd = 0, driveFg = 0, driveCount = 0;
      const startPhase = root.phase || SNAP;
      for (let r = 0; r < n; r++) {
        S.t = root.t; S.pos = root.pos; S.s[0] = root.score[0]; S.s[1] = root.score[1]; S.down = root.down;
        S.ytg = root.ytg; S.yl = root.yl; S.to[0] = root.to[0]; S.to[1] = root.to[1]; S.running = !!root.clock_running;
        S.credit = 0; S.phase = root.phase || SNAP; S.freeKick = false; S.stratActive = !!action.h1; S.plays = 0; S.rc = !!root.running_clock;
        S.ot = root.ot ? { c: [root.ot.c[0], root.ot.c[1]], po: !!root.ot.po, n: root.ot.n || 1, r: root.ot.r || null } : null;
        let driveOpen = startPhase === SNAP;
        const pos0 = root.pos, pts0 = root.score[pos0];
        for (let step = 0; step < maxSteps && S.phase !== DONE; step++) {
          for (let c = 0; c < 8; c++) u[c] = uni(seed, r, step, c);
          const act = step === 0 ? action : null;
          if (S.ot) {                      // overtime: a phase at a time, so each one's end can settle the game
            const b = { phase: S.phase, pos: S.pos, s: [S.s[0], S.s[1]] };
            if (S.phase === PAT) this._pat(S, g, u, act);
            else if (S.phase === KICKOFF) this._kickoff(S, g, u, act);
            else if (S.phase === SNAP) this._snap(S, g, u, act, action, root.pos);
            this._otAfter(S, b);
          } else {
            if (S.phase === PAT) this._pat(S, g, u, act);
            if (S.phase === KICKOFF) this._kickoff(S, g, u, act);
            if (S.phase === SNAP) this._snap(S, g, u, act, action, root.pos);
          }
          if (driveOpen && (S.pos !== pos0 || S.phase !== SNAP)) {
            const pts = S.s[pos0] - pts0;
            driveEndT += Math.max(S.t - g.halfEnd, 0); driveTd += pts >= 6 ? 1 : 0; driveFg += pts === 3 ? 1 : 0;
            driveCount++; driveOpen = false;
          }
        }
        if (driveOpen) { driveEndT += 0; driveCount++; }
        const v = this._value(S, g, persp);
        values[r] = v; sum += v;
      }
      let ss = 0;
      const mean = sum / n;
      for (let r = 0; r < n; r++) ss += (values[r] - mean) * (values[r] - mean);
      const drive = driveCount ? { endT: driveEndT / driveCount, td: driveTd / driveCount, fg: driveFg / driveCount } : null;
      return { mean, se: Math.sqrt(ss / (n - 1) / n), values, drive };
    }

    // One real play for the daily game: advance a single phase (try, kickoff or snap) from `root`
    // with `action`, and return the new state plus a log of what happened.
    step(root, opts) {
      opts = opts || {};
      const action = opts.action || {}, seed = (opts.seed || 0) >>> 0;
      const g = this._geom(root);
      const S = { t: root.t, pos: root.pos, s: [root.score[0], root.score[1]], down: root.down, ytg: root.ytg, yl: root.yl,
        to: [root.to[0], root.to[1]], running: !!root.clock_running, credit: root.credit || 0, phase: root.phase || SNAP,
        freeKick: !!root.free_kick, stratActive: false, plays: 0, log: [], rc: !!root.running_clock,
        ot: root.ot ? { c: [root.ot.c[0], root.ot.c[1]], po: !!root.ot.po, n: root.ot.n || 1, r: root.ot.r || null } : null };
      const u = new Float64Array(8);
      for (let c = 0; c < 8; c++) u[c] = uni(seed, 0, 0, c);
      const b = { phase: S.phase, pos: S.pos, s: [S.s[0], S.s[1]] };
      if (S.phase === PAT) this._pat(S, g, u, action);
      else if (S.phase === KICKOFF) this._kickoff(S, g, u, action);
      else if (S.phase === SNAP) this._snap(S, g, u, action, action, root.pos);
      if (S.ot) {
        this._otAfter(S, b);
        if (S.phase === DONE && S.t > g.halfEnd) S.log.push({ ev: 'end', t: S.t, ot: true });
      }
      const out = { t: S.t, pos: S.pos, score: [S.s[0], S.s[1]], down: S.down, ytg: S.ytg, yl: S.yl, to: [S.to[0], S.to[1]],
        clock_running: S.running, phase: S.phase, credit: S.credit, free_kick: S.freeKick };
      if (S.ot) out.ot = { c: [S.ot.c[0], S.ot.c[1]], po: S.ot.po, n: S.ot.n, ...(S.ot.r ? { r: S.ot.r } : {}) };
      if (this.R.runClock) out.running_clock = !!S.rc;
      return {
        root: out,
        log: S.log, done: S.phase === DONE,
      };
    }

    // ------------------------------------------------------------------ PAT ---
    _pat(S, g, u, act) {
      if (this._noTry(S, g)) return;
      const o = S.pos, margin = S.s[o] - S.s[1 - o], tHalf = S.t - g.halfEnd;
      let go2 = g.half === 2 && tHalf <= 900 && TWO_PT_SET.has(margin);
      if (act && act.pat) go2 = act.pat === 'two';
      const R = this.R, pk = clip(this.fgProb(R.patKick, o), 1e-9, 1 - 1e-9);
      const p = go2 ? this.ctx.twoPt[o] : sigmoid(Math.log(pk / (1 - pk)) + this.e.xpLogit);
      let good = u[3] < p, callIdx = -1, row = -1, why = null;
      // daily game: a two-point try you called is a real play of that call from the 2 (the 3 in college and high
      // school: R.twoYl; a must-score snap), against the look the defense showed: good if it gets there without a
      // turnover (a flag: the league rate decides)
      if (go2 && act && act.call !== undefined && this.pbCdf && this.e.pb.callIndex[act.call] !== undefined) {
        const P = this.e.pb;
        callIdx = P.callIndex[act.call];
        const who = act.route ? (WHO_CODE[act.who] || 0) : undefined, route = routeOfAct(act);
        if (dcValid(act.dc)) {
          const m = dcEffect(this.e.pb.dcEff, act.call, act.dc, act.pers, act.seen);
          why = m.why.slice(0, 3);
          row = this._noThrowaway((v) => this.sampleVsDefense(o, callIdx, fineKey(MODE_NORMAL, 3, R.twoYl, R.twoYl), v, false, act.dc, m.s, route, who, persForm(act), protOf(act)), u[2], true);
        } else {
          const match = this.matchOf(callIdx, this.defOfLooks(act.looks));
          row = this._noThrowaway((v) => this.samplePlaybook(o, callIdx, fineKey(MODE_NORMAL, 3, R.twoYl, R.twoYl), v, false, act.looks, match, route, who, persForm(act), undefined, protOf(act)), u[2], true);
        }
        if (row >= 0) {
          const f = P.flags[row];
          if (!(f & 1)) good = !(f & 64) && !(f & 4) && ((f & 16) !== 0 || P.yards[row] >= R.twoYl);
        }
      }
      if (good) S.s[o] += go2 ? 2 : 1;
      // an extra point blocked: the top of the misses' draw (no points either way; the defense's return of one for two
      // is not played: nflverse marks none in 2016-25)
      const blocked = !go2 && !good && u[3] >= Math.max(p, 1 - XP_BLOCK);
      if (S.log) S.log.push({ ev: 'pat', team: o, two: go2, good, call: callIdx, row, ...(why ? { why } : {}), ...(blocked ? { blocked } : {}) });
      S.phase = S.t <= g.halfEnd ? DONE : KICKOFF;
      S.freeKick = false;
    }

    // -------------------------------------------------------------- KICKOFF ---
    _kickoff(S, g, u, act) {
      const kt = S.pos, rt = 1 - kt, marginK = S.s[kt] - S.s[rt], tHalf = S.t - g.halfEnd;
      let onside = g.half === 2 && marginK < 0 &&
        ((tHalf <= 125 && S.to[kt] <= 1) || tHalf <= 65 || (tHalf <= 160 && marginK <= -9));
      onside = onside && !S.freeKick;
      // the NFL (2024+): only a team behind may declare one; college and high school: anyone
      if (act && act.kick) onside = act.kick === 'onside' && (!this.R.onsideBehindOnly || marginK < 0 || S.freeKick);
      const K = this.e.ko;
      let j = Math.floor(u[4] * K.start.length);
      // daily game: kicked to the returner (a real landing-zone kick) or through the end zone (a touchback)
      if (act && act.kick === 'return' && K.ret.length) j = K.ret[Math.floor(u[4] * K.ret.length)];
      let start = K.start[j];
      let dur = K.dur10[j] / 10;
      let retTd = K.retTd[j] && !onside;
      // the data's touchbacks start where these rules put them (NFL data under college rules: the 25, not the 35)
      if (dur === 0 && start === this.e.koTb && this.R.koTouchback !== this.e.koTb) start = this.R.koTouchback;
      if (act && act.kick === 'touchback' && !S.freeKick) { start = this.R.koTouchback; dur = 0; retTd = false; }
      if (S.freeKick) start = clip(start - 8, 40, 75);
      const rec = onside && u[3] < this.onsideP;
      S.pos = rec ? kt : rt;
      S.yl = onside ? (rec ? this.e.onsideYl[0] : this.e.onsideYl[1]) : start;
      S.t = Math.max(S.t - (onside ? 3 : dur), g.halfEnd);
      if (S.t <= g.halfEnd + CLOCK_EPS) S.t = g.halfEnd;
      S.down = 1; S.ytg = Math.min(10, S.yl); S.running = this._rc(S, g) && S.t > g.halfEnd; S.credit = 0; S.freeKick = false; S.phase = SNAP;
      if (retTd) { S.s[S.pos] += 6; S.phase = PAT; S.running = false; }
      if (S.log) S.log.push({ ev: 'kickoff', team: kt, onside, recovered: rec, retTd, yl: S.yl, tb: !onside && dur === 0, kick: act && act.kick || null });
      if (S.t <= g.halfEnd && S.phase === SNAP) S.phase = DONE;
      this._noTry(S, g);
    }

    // ----------------------------------------------------------------- SNAP ---
    _snap(S, g, u, act, rootAction, rootPos) {
      const half = g.half, halfEnd = g.halfEnd, ctx = this.ctx;
      const o = S.pos, d = 1 - o;
      const margin = S.s[o] - S.s[d];
      let runC = S.running;
      let tHalf = S.t - halfEnd;
      const offTo = S.to[o], defTo = S.to[d];
      const yl = S.yl, down = S.down;
      const fgRange = this.fgProb(yl + FG_SNAP_YARDS, o) >= 0.35;
      const fgHelps = margin >= -3 && margin <= 0;
      const tmwPending = S.t > g.tmw;

      // (1) timeouts right after the previous whistle
      let kneelOk, defWants, offWants, attempt = true, runOut = false, closing = false;
      if (half === 2) {
        kneelOk = (margin > 0 || (margin === 0 && yl >= 70 && tHalf <= 40)) &&
          this.kneelOutPossible(tHalf, down, defTo, runC, tmwPending);
        defWants = margin > 0 && (tHalf <= 240 || (margin >= 9 && tHalf <= 420));
        offWants = margin <= 0 && (tHalf <= 60 || (margin <= -9 && tHalf <= 120));
        offWants = offWants || (fgRange && fgHelps && tHalf <= 25);
        closing = margin >= -2 && margin <= 0 && tHalf <= CLOSE_WINDOW && offTo > 0 &&
          this.fgProb(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P;
        if (closing) offWants = false;                                   // timeouts are kept for the kick
        // the defense saves time for a reply when a field goal would beat it: only when the offense can run the clock
        // down to its kick (a timeout left: without one the running clock is the offense's problem, and a timeout
        // would be a gift), and only if stopping the clock after every down it can still gets it the ball back with
        // time to answer (QA saw a leading defense call them at 0:19, 0:06 and 0:01 for an offense out of timeouts)
        const kickAt = tHalf - (4 - down) * CLOSE_PLAY - Math.max(5 - down - defTo, 0) * CLOSE_GAP;
        const defSaves = margin >= -2 && margin <= 0 && tHalf <= CLOSE_DEF_WINDOW && offTo > 0 && kickAt >= CLOSE_REPLY &&
          this.fgProb(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P;
        defWants = defWants || defSaves;
      } else {
        attempt = (yl - 35.0) <= 0.6 * (tHalf + 20.0 * offTo);
        if (S.stratActive && S.pos !== rootPos) S.stratActive = false;
        if (S.stratActive) attempt = rootAction.h1 === 'attack';
        runOut = !attempt && tHalf <= 120;
        kneelOk = runOut && this.kneelOutPossible(tHalf, down, defTo, runC, tmwPending);
        defWants = runOut && !kneelOk && tHalf <= 100 && down >= 2;
        offWants = attempt && tHalf <= 30.0 + 15.0 * offTo && tHalf <= 75;
      }
      // offense that wants the clock stopped (for clock-aware play calls)
      const aware = (half === 2 ? (margin <= 0 && margin >= -16) : attempt) && !closing;
      let defCall = runC && defWants && defTo > 0;
      let offCall = runC && !defCall && offWants && offTo > 0 && !kneelOk;
      if (act && act.to_def !== undefined) defCall = runC && defTo > 0 && !!act.to_def;
      if (act && act.to_off !== undefined) offCall = runC && !defCall && offTo > 0 && !!act.to_off;
      if (defCall) S.to[d] -= 1;
      if (offCall) S.to[o] -= 1;
      const called = defCall || offCall;
      // (a timeout called before the two-minute warning never carries the clock past it: the warning still comes; nor
      // out of the half: one called with time left keeps a snap)
      if (called) S.t = Math.max(S.t - this.toReact, Math.min(S.t, halfEnd + 0.5), S.t > g.tmw ? Math.min(S.t, g.tmw + 0.01) : halfEnd);
      runC = runC && !called;
      // kick to win: with the clock running and little left, let it run down, then timeout and kick
      const free = !(act && (act.tempo !== undefined || act.play !== undefined || act.runoff !== undefined));
      const endkick = closing && runC && tHalf <= CLOSE_END && S.to[o] > 0 && free;
      if (endkick) { S.t = halfEnd + Math.min(tHalf, CLOSE_KICK_AT); S.to[o] -= 1; runC = false; }
      if (S.log) {
        if (defCall) S.log.push({ ev: 'timeout', team: d, t: S.t, left: S.to[d] });
        if (offCall) S.log.push({ ev: 'timeout', team: o, t: S.t, left: S.to[o] });
        if (endkick) S.log.push({ ev: 'timeout', team: o, t: S.t, why: 'kick', left: S.to[o] });
      }

      // (2) tempo and between-snap runoff
      let hurry, urgent, milk;
      if (half === 2) {
        hurry = (margin < 0 && tHalf <= 300) || (margin <= -9 && tHalf <= 600) || (margin === 0 && yl <= 80 && tHalf <= 75);
        hurry = hurry && !closing;
        urgent = hurry && tHalf <= 120;
        milk = (margin > 0 && tHalf <= 600) || (margin === 0 && tHalf <= 240 && !hurry) || closing;
      } else {
        hurry = tHalf <= 120 && attempt; urgent = hurry && tHalf <= 60; milk = tHalf <= 120 && !attempt;
      }
      let tempo = urgent ? URGENT : hurry ? HURRY : milk ? MILK : NORMAL;
      let kneelNow = kneelOk;
      let spikeNow = runC && hurry && S.to[o] === 0 && down <= 3 && tHalf <= 35;
      spikeNow = spikeNow || (runC && fgRange && fgHelps && half === 2 && S.to[o] === 0 && down <= 3 && tHalf <= 22);
      spikeNow = spikeNow && !kneelNow;
      if (act && act.tempo) { tempo = TEMPO[act.tempo]; spikeNow = false; kneelNow = false; }
      const forced = act ? act.play : undefined;
      // a called spike is a spike even if the clock stopped before the snap (their timeout, the two-minute
      // warning): never a play from the library
      if (forced !== undefined) { kneelNow = forced === 'kneel'; spikeNow = forced === 'spike'; }
      // 4th down with the clock running and a kick that ties or wins: rush the field-goal unit on
      const fgUseful0 = half === 1 || (margin >= -3 && margin <= 0);
      let fire = runC && down === 4 && fgUseful0 && this.fgProb(yl + FG_SNAP_YARDS, o) >= 0.3 && tHalf <= FIRE_WINDOW;
      fire = fire && !kneelNow && !spikeNow;
      // with time to spare a forced kick is set up normally, not rushed
      // (a set runoff is the clock run down to a timeout: the kick after it is set up, not rushed)
      if (forced !== undefined) fire = runC && forced === 'fg' && tHalf <= FIRE_WINDOW && act.runoff === undefined;
      tempo = kneelNow ? T_KNEEL : spikeNow ? T_SPIKE : fire ? T_FIRE : tempo;
      let runoff;
      const KR = this.R.kneelRunoff;
      if (tempo === T_KNEEL) runoff = KR[0] + (KR[1] - KR[0]) * u[0];
      else if (tempo === T_FIRE) runoff = FIRE_DRILL[0] + (FIRE_DRILL[1] - FIRE_DRILL[0]) * u[0];
      else { const arr = this.e.tempo[tempo]; runoff = arr[Math.floor(u[0] * arr.length)]; }
      if (tempo === URGENT && tHalf <= URGENT_LATE[0]) {      // the last minute's hurry-up is faster
        const f = clip(tHalf / URGENT_LATE[0], 0, 1);
        runoff = Math.min(runoff * (URGENT_LATE[1] + (1 - URGENT_LATE[1]) * f), URGENT_LATE[2] + (URGENT_LATE[3] - URGENT_LATE[2]) * f);
      }
      if (this.R.maxGap != null) runoff = Math.min(runoff, this.R.maxGap);      // a short play clock: no longer gaps
      runoff = runC ? Math.max(runoff - S.credit, 0) : 0;
      // a kick you called always gets off (players saw the clock run out on a field goal they had called): with too
      // little time for the unit to run on, your timeout first when you have one; without, the rush beats the clock
      // (the page only offers it from 0:07). Past the fire-drill window, the unit is set up in time: a tempo that would
      // run the clock out snaps it with 0:03 left instead (players saw a kick called at 0:30 in the huddle never snapped)
      if (forced === 'fg' && runC && !fire && act.runoff === undefined) runoff = Math.min(runoff, Math.max(tHalf - CLOSE_KICK_AT, 0));
      if (fire && forced === 'fg' && runC && runoff >= tHalf - 0.5) {
        if (S.to[o] > 0) {
          S.to[o] -= 1; runoff = 0; fire = false; tempo = NORMAL;
          if (S.log) S.log.push({ ev: 'timeout', team: o, t: S.t, why: 'kick', left: S.to[o] });
        } else runoff = Math.max(tHalf - 1, 0);
      }
      // running it down: never past the point where the kick is still safe (daily game: a milk call does the same)
      const runDown = free || (!!this.pbCdf && !!act && act.tempo === 'milk');
      if (runDown && closing && runC && tempo === MILK) runoff = Math.min(runoff, Math.max(S.t - halfEnd - CLOSE_SNAP_FLOOR, 0));
      if (act && act.runoff !== undefined) runoff = runC ? act.runoff : 0;
      const t0 = S.t;
      let t1 = t0 - runoff;
      if (t1 <= halfEnd + CLOCK_EPS) t1 = halfEnd;
      const stop = t0 > g.tmw && t1 <= g.tmw;
      if (stop) t1 = g.tmw;
      const stopQ = t0 > g.qEnd && t1 <= g.qEnd;
      if (stopQ) t1 = g.qEnd;
      const runningAtSnap = runC && !stop && !stopQ;
      const ended = t1 <= halfEnd;
      if (S.log && t0 > Math.max(t1, halfEnd)) {
        S.log.push({ ev: 'runoff', secs: t0 - Math.max(t1, halfEnd), t: Math.max(t1, halfEnd), stop: stop ? '2mw' : stopQ ? 'quarter' : null,
          kneel: tempo === T_KNEEL, spike: tempo === T_SPIKE });
      }
      S.t = Math.max(t1, halfEnd);
      S.credit = 0;
      if (ended) { S.phase = DONE; if (S.log) S.log.push({ ev: 'end', t: halfEnd }); return; }
      tHalf = S.t - halfEnd;

      // (3) play choice
      let kind = -1;
      if (kneelNow) kind = KNEEL; else if (spikeNow) kind = SPIKE;
      const pFg = this.fgProb(yl + FG_SNAP_YARDS, o);
      const lastPlay = tHalf <= 6.0;
      const fgUseful = half === 1 || (margin >= -3 && margin <= 0);
      let fgLast = lastPlay && pFg >= 0.08 && fgUseful;
      const snapBudget = S.to[o] > 0 ? 8.0 : 15.0;
      fgLast = fgLast || (tHalf <= snapBudget && pFg >= 0.3 && fgUseful && !runningAtSnap);
      if (kind < 0 && fgLast) kind = FG;
      if (kind === SPIKE && fgLast && forced !== 'spike') kind = FG;
      if (fire || endkick) kind = FG;
      if (kind < 0 && down === 4) kind = this._fourthDown(S, g, o, margin, tHalf, pFg, u[5]);
      if (kind < 0 && runOut && down < 4) kind = RUN;
      if (forced !== undefined && forced !== 'kneel' && forced !== 'spike') kind = forced === 'go' ? -1 : PLAY[forced];
      if (kind < 0) {
        const fk = fineKey(closing ? MODE_KILL : gameMode(half, tHalf, margin), down, S.ytg, yl);
        const pr = this.e.lib.passRate[fk];
        let lg = Math.log(pr / (1 - pr)) + ctx.proe[o] / Math.max(pr * (1 - pr), 0.1);
        if (aware && S.to[o] === 0 && tHalf <= CLOCK_PASS_WINDOW) lg += CLOCK_PASS_SHIFT;
        if (act && act.read && dcValid(act.dc) && this.pbCdf) lg += this.dcLean(fk, act.dc, readOf(act));
        kind = u[1] < sigmoid(lg) ? PASS : RUN;
      }
      S.plays += 1;
      // (4) execute
      if (kind === FG) this._fieldGoal(S, g, u, o, fire, act && act.st);
      else if (kind === PUNT) this._punt(S, g, u, o, act && act.st);
      else {
        let pbRow = -1, callIdx = -1, match = 0, why = null, fkP = -1;
        const oobWant = half === 2 && tHalf <= 300 && margin > 0 ? -1 : 0;
        // your own call without "get out of bounds": the carrier plays to stay in. Real late-game plays are full of
        // carriers stepping out on purpose; a player who didn't ask for it saw his man walk out in open field, and a
        // player tied late, running the clock down with the other team out of timeouts, saw it stop
        const mineOob = act && act.oob ? 1 : -1;
        if (act && act.call !== undefined && this.pbCdf && (kind === RUN || kind === PASS)) {
          // your call, against the look the defense showed (Versus: the defense's whole call): the matchup tilts the draw
          callIdx = this.e.pb.callIndex[act.call];
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl), who = act.route ? (WHO_CODE[act.who] || 0) : undefined, route = routeOfAct(act);
          fkP = fk;
          // a motion's read (act.cov, game.js motion): the pass is a real play run against that coverage
          this._cov = kind === PASS && (act.cov === 'man' || act.cov === 'zone') ? (act.cov === 'man' ? 1 : 2) : 0;
          if (dcValid(act.dc)) {
            const m = dcEffect(this.e.pb.dcEff, act.call, act.dc, act.pers, act.seen);
            match = m.s + repeatS(act) + schemeS(act, act.call, dcDef(act.dc)); why = m.why.slice(0, 3);
            pbRow = this._noThrowaway((v) => this.sampleVsDefense(o, callIdx, fk, v, mineOob, act.dc, match, route, who, persForm(act), protOf(act)), u[2], down === 4);
          } else {
            match = this.matchOf(callIdx, this.defOfLooks(act.looks)) + repeatS(act) + schemeS(act, act.call, this.defOfLooks(act.looks));
            pbRow = this._noThrowaway((v) => this.samplePlaybook(o, callIdx, fk, v, mineOob, act.looks, match, route, who, persForm(act), undefined, protOf(act)), u[2], down === 4);
          }
        } else if (act && dcValid(act.dc) && this.pbCdf && (kind === RUN || kind === PASS)) {
          // no call from the offense: a call of the kind it chose, as often as play-callers make it here, against the
          // defense's call. Versus: no check into a better one (the other phone never sees the defense's call); the
          // daily game (act.read: the computer's offense reads your defense) checks into calls that beat it
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl);
          callIdx = this.pickCall(kind === PASS ? 'pass' : 'run', fk, u[4], null, act.read ? act.dc : null, readOf(act));
          fkP = fk;
          if (callIdx >= 0) {
            const m = dcEffect(this.e.pb.dcEff, this.e.pb.calls[callIdx].id, act.dc);
            match = m.s; why = m.why.slice(0, 3);
            pbRow = this._noThrowaway((v) => this.sampleVsDefense(o, callIdx, fk, v, oobWant, act.dc, match), u[2], down === 4);
          }
        } else if (act && act.def && DEF_LOOKS[act.def] && this.pbCdf && (kind === RUN || kind === PASS)) {
          // daily game: you called the defense; the offense runs a play of the kind it chose, a call as often as
          // play-callers make it here (more often one that beats your call: it checks into it), drawn from real plays
          // of that call against the look you called, tilted by the matchup
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl);
          callIdx = this.pickCall(kind === PASS ? 'pass' : 'run', fk, u[4], act.def);
          fkP = fk;
          match = this.matchOf(callIdx, act.def);
          if (callIdx >= 0) pbRow = this._noThrowaway((v) => this.samplePlaybook(o, callIdx, fk, v, half === 2 && tHalf <= 300 && margin > 0 ? -1 : 0, DEF_LOOKS[act.def], match), u[2], down === 4);
        }
        this._cov = 0;
        // a foul during the play (not before the snap): the play under it, as it would have gone (a real play of the
        // same call here with no flag), for the offended team to take instead (_scrimmage: accept or decline)
        let alt = -1;
        const P = this.e.pb;
        if (pbRow >= 0 && fkP >= 0 && callIdx >= 0 && (P.flags[pbRow] & 1) && P.lookB && !this._isPreSnap(pbRow)) {
          alt = this._livePlay(o, callIdx, fkP, (u[2] * 7919.13 + 0.37) % 1);
        }
        this._scrimmage(S, g, u, o, kind, margin, aware, closing, pbRow, callIdx, match, why, runningAtSnap, alt, act && act.penAs);
      }
    }
    // a snap that has to convert (4th down, a two-point try): no quarterback throws it away there, it is the ball over
    // all the same (the owner saw one on a fourth down in Versus; the pools widen past the down to have plays enough).
    // A real play drawn as a throwaway is drawn again, a fixed step on from the snap's u (the same seed plays the same)
    _noThrowaway(draw, u, must) {
      let row = draw(u);
      if (!must) return row;
      const P = this.e.pb;
      for (let k = 1; k <= 60 && row >= 0 && (P.eventNames[P.event[row]] || '') === 'throwaway'; k++) row = draw((u + k * 0.6180339887) % 1);
      return row;
    }
    // a real play of call callIdx in situation fk with no flag (the weights as drawn: the call's pool), for a foul's
    // declined option
    _livePlay(team, callIdx, fk, u) {
      const P = this.e.pb, cdf = this._cdfOf(team, 0), pool = P.poolOf[callIdx * P.nFine + fk];
      this._live = this._live || new WeakMap();
      let byPool = this._live.get(cdf);
      if (!byPool) { byPool = new Map(); this._live.set(cdf, byPool); }
      let T = byPool.get(pool);
      if (T === undefined) {
        const lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1, items = [], cum = [];
        let tot = 0;
        for (let i = lo; i <= hi; i++) {
          const r = P.items[i];
          if (P.flags[r] & 1) continue;
          tot += cdf[i] - (i > lo ? cdf[i - 1] : pool); items.push(r); cum.push(tot);
        }
        T = tot > 0 ? { items, cum, tot } : null;
        byPool.set(pool, T);
      }
      return this._pickT(T, u);
    }

    _coachChoice(S, g, o, margin, tHalf, pFg, u5, cm) {
      const mod = cm.model, yl = S.yl, ytg = S.ytg, half2 = g.half === 2 ? 1 : 0;
      const x = [tHalf / 60, Math.log1p(tHalf), half2, margin, Math.abs(margin), margin < 0 ? 1 : 0, margin > 0 ? 1 : 0,
        4, ytg, Math.log(Math.max(ytg, 1)), yl / 10, (yl / 10) * (yl / 10), S.to[o], S.to[1 - o], tHalf <= 120 ? 1 : 0,
        (tHalf <= 300 && half2) ? 1 : 0, 0, yl <= 40 ? 1 : 0, Math.max(yl - 40, 0) / 10];
      const cls = mod.classes, z = new Array(cls.length);
      let mx = -Infinity;
      for (let c = 0; c < cls.length; c++) {
        let v = mod.intercept[c];
        for (let j = 0; j < x.length; j++) v += mod.coef[c][j] * (x[j] - mod.mean[j]) / mod.scale[j];
        if (cls[c] === 'go') v += cm.shift || 0;
        z[c] = v; if (v > mx) mx = v;
      }
      let sum = 0;
      const p = z.map((v, c) => {
        let e = Math.exp(v - mx);
        if (cls[c] === 'fg' && !(pFg > 0.02)) e = 0;
        if (cls[c] === 'punt' && !(yl >= 30)) e = 0;
        sum += e; return e;
      });
      let cum = 0, pick = cls.length - 1;
      for (let c = 0; c < cls.length; c++) { cum += p[c] / sum; if (u5 <= cum) { pick = c; break; } }
      return cls[pick] === 'go' ? -1 : cls[pick] === 'fg' ? FG : PUNT;
    }

    _fourthDown(S, g, o, margin, tHalf, pFg, u5) {
      const half = g.half, d = 1 - o;
      const yl = S.yl, ytg = clip(S.ytg, 1, 20), t = S.t, offTo = S.to[o], defTo = S.to[d];
      const mode = gameMode(half, tHalf, margin), zone = zoneOf(yl);
      const pConv = this.conv[o][(mode * N_ZONE + zone) * 21 + Math.trunc(ytg)];
      const gain = Math.max(ytg, Math.min(6.0, yl));
      const tdConv = yl <= ytg;
      const newYl = Math.max(yl - gain, 1.0);
      const lo = g.halfEnd + 1.0;
      const t6 = Math.max(t - 6, lo), t5 = Math.max(t - 5, lo), t9 = Math.max(t - 9, lo);
      let wpConv;
      if (tdConv) wpConv = 1 - this.wpFull(d, -(margin + 7), t6, 1, 10, this.e.kickoffStart, defTo, offTo);
      else wpConv = this.wpFull(o, margin, t6, 1, Math.min(10, newYl), newYl, offTo, defTo);
      const fail = 1 - this.wpFull(d, -margin, t6, 1, Math.min(10, 100 - yl), 100 - yl, defTo, offTo);
      const wpGo = pConv * wpConv + (1 - pConv) * fail;
      let wpFg = -1;
      if (pFg > 0.02) {
        const made = 1 - this.wpFull(d, -(margin + 3), t5, 1, 10, this.e.kickoffStart, defTo, offTo);
        const missYl = this._missYl(yl);
        const miss = 1 - this.wpFull(d, -margin, t5, 1, Math.min(10, missYl), missYl, defTo, offTo);
        wpFg = pFg * made + (1 - pFg) * miss;
      }
      let wpPunt = -1;
      if (yl >= 35) {
        const ry = this.puntReceiveYl(yl, o);
        wpPunt = 1 - this.wpFull(d, -margin, t9, 1, Math.min(10, ry), ry, defTo, offTo);
      }
      // the sound choice, as NFL coaches make it (FOURTH_GO_EDGE, FOURTH_KICK_P)
      const behindLate = half === 2 && margin < 0 && (tHalf <= 180 || (margin <= -4 && tHalf <= 300) || (margin <= -9 && tHalf <= 420));
      if (half === 2 && margin <= -9 && tHalf <= 300 && yl < 50) wpPunt = -1;
      const kick = Math.max(wpFg, wpPunt);
      let choice = (kick < 0 || wpGo >= kick + (behindLate ? 0 : FOURTH_GO_EDGE)) ? -1 : (wpFg >= wpPunt ? FG : PUNT);
      if (choice === -1 && wpPunt >= 0 && !behindLate && yl >= 50 && (ytg >= 2 || yl >= 80)) choice = PUNT;
      if (half === 2 && tHalf <= 300 && margin >= -3 && margin <= 0 && ytg >= 2 && pFg >= FOURTH_KICK_P) choice = FG;
      const cm = this.ctx.coach4th && this.ctx.coach4th[o];
      if (cm && u5 !== undefined) choice = this._coachChoice(S, g, o, margin, tHalf, pFg, u5, cm);
      if (half === 2) {
        const late = tHalf <= 40;
        if (late && margin < -3) choice = -1;
        if (late && margin >= -3 && margin <= 0 && pFg >= 0.3) choice = FG;
        if (late && margin >= -3 && margin < 0 && pFg < 0.3) choice = -1;  // trailing: must go
        const nb = NO_PUNT_BEHIND;
        if (choice === PUNT && margin < 0 && margin >= -nb[0] && (tHalf <= nb[1] || (margin <= -nb[2] && tHalf <= nb[3]))) choice = -1;
        // Tied and out of range: punt and play for overtime (the WP model overrates late possession here).
        if (margin === 0 && pFg < 0.3 && yl >= 35 && (late || (tHalf <= 120 && yl >= 50))) choice = PUNT;
      } else {
        if (tHalf <= 20 && pFg >= 0.2) choice = FG;
        if (tHalf <= 20 && pFg < 0.2 && choice === PUNT && yl < 60) choice = -1;
      }
      // overtime, once the other team has had its possession (sudden death: always): this one decides it. Down 4 or
      // more, only a touchdown keeps the game going; down 1-3 a field goal ties or wins; tied, a field goal wins.
      if (S.ot && (S.ot.c[d] >= 1 || S.ot.r === 'sd')) {
        if (margin <= -4) choice = -1;
        else if (margin < 0) choice = pFg >= 0.3 ? FG : -1;
        else if (margin === 0 && pFg >= 0.5) choice = FG;
      }
      return choice;
    }

    // ------------------------------------------------------------ execution ---
    _clockAfterPlay(S, g, dur, stopFlag, credit) {
      const t0 = S.t;
      let t1 = t0 - dur;
      const crossTmw = t0 > g.tmw && t1 <= g.tmw;
      const crossQ = t0 > g.qEnd && t1 <= g.qEnd;
      if (crossQ) t1 = Math.max(t1, g.qEnd);
      S.t = t1 <= g.halfEnd + CLOCK_EPS ? g.halfEnd : t1;
      S.running = !(stopFlag || crossTmw || crossQ);
      S.credit = S.running ? credit : 0;
    }

    _scrimmage(S, g, u, o, kind, margin, aware, closing, pbRow, callIdx, match, why, runningAtSnap, alt = -1, penAs) {
      const d = 1 - o, L = this.e.lib, R = this.R;
      const yl0 = S.yl, ytg0 = S.ytg, down0 = S.down;
      let yards = 0, penalty = false, autoFd = false, incomplete = false, oob = false, tdOff = false, tdDef = false,
        turnover = false, toRel = 0, safety = false, dur = 0, penOpt = null;
      if (pbRow >= 0) {   // a specific call from the playbook (daily game)
        const P = this.e.pb, f = P.flags[pbRow];
        yards = P.yards[pbRow]; penalty = !!(f & 1); autoFd = !!(f & 2); incomplete = !!(f & 4); oob = !!(f & 8);
        // a real play drawn away from its own spot keeps only what still fits here: a touchdown if it covered most
        // of the way (PB_TD_SHARE), a safety only if the loss reaches the end zone (from the spot, below)
        tdOff = !!(f & 16) && yards >= PB_TD_SHARE * yl0; tdDef = !!(f & 32); turnover = !!(f & 64);
        toRel = P.toRel[pbRow]; dur = P.dur10[pbRow] / 10;
        // a foul during the play: the offended team takes the yards or the play (alt, the play as it would have gone).
        // penAs: your choice (the daily game asks when the foul is theirs); else the better of the two for them: the
        // offense keeps a play that scores or gains more than the flag (and its first down when the flag gives none);
        // the defense keeps a turnover, a stop on third or fourth down, or a loss worse than the flag
        if (penalty && alt >= 0) {
          const fa = P.flags[alt], aY = P.yards[alt], aTo = !!(fa & 64), aInc = !!(fa & 4);
          const pY = yards > 0 ? (yards >= 15 ? Math.min(yards, yl0 - 1) : Math.min(yards, yl0 / 2)) : -Math.min(-yards, (100 - yl0) / 2);
          const aTd = !aTo && ((!!(fa & 16) && aY >= PB_TD_SHARE * yl0) || yl0 - aY <= 0), aFd = aY >= ytg0 || !!(fa & 2);
          const pFd = pY >= ytg0 || autoFd, offended = pY > 0 ? o : 1 - o;
          let dec;
          if (penAs === 'accept' || penAs === 'decline') dec = penAs === 'decline';
          else if (offended === o) dec = aTd || (!aTo && aY > pY && (aFd || !pFd));
          else dec = aTo || (!aTd && ((!aFd && down0 >= 3) || aY <= pY));
          penOpt = { offended, pen: P.pen ? P.penNames[P.pen[pbRow]] || 'Penalty' : 'Penalty', declined: dec,
            accept: { yards: pY, fd: pFd }, decline: { yards: aY, fd: aFd && !aTo, inc: aInc, to: aTo, td: aTd, evt: P.eventNames[P.event[alt]] || '' } };
          if (dec) {
            pbRow = alt;
            yards = aY; penalty = false; autoFd = !!(fa & 2); incomplete = aInc; oob = !!(fa & 8);
            tdOff = !!(fa & 16) && yards >= PB_TD_SHARE * yl0; tdDef = !!(fa & 32); turnover = aTo;
            toRel = P.toRel[alt]; dur = P.dur10[alt] / 10;
          }
        }
      } else if (kind === RUN || kind === PASS) {
        // running the clock down for a kick: the clock-killing play mix
        const fk = fineKey(closing ? MODE_KILL : gameMode(g.half, S.t - g.halfEnd, margin), down0, ytg0, yl0);
        let row = this.sampleLib(o, kind === PASS ? 1 : 0, fk, u[2]);
        if (aware && kind === PASS && S.to[o] === 0) {
          // no timeouts and the clock must stop: sideline throws and throw-aways replace some in-bounds gains
          const th = S.t - g.halfEnd;
          const keep = th <= CLOCK_AWARE[0][0] ? CLOCK_AWARE[0][1] : th <= CLOCK_AWARE[1][0] ? CLOCK_AWARE[1][1] : 1.0;
          if (u[6] >= keep && !(L.flags[row] & LIVE_MASK) && L.yards[row] > 0) {
            const r2 = this.sampleStop(o, L.poolOf[this.e.nFine + fk], u[7]);
            if (r2 >= 0) row = r2;
          }
        }
        const f = L.flags[row];
        yards = L.yards[row]; penalty = !!(f & 1); autoFd = !!(f & 2); incomplete = !!(f & 4); oob = !!(f & 8);
        tdOff = !!(f & 16); tdDef = !!(f & 32); turnover = !!(f & 64);
        toRel = L.toRel[row]; dur = L.dur10[row] / 10;
      }
      if (kind === KNEEL) { yards = -Math.min(1.0, 99.0 - yl0); dur = this.kneelDur; }
      if (kind === SPIKE) { dur = this.spikeDur; incomplete = true; }
      // Leading with seconds left: the QB holds the ball / runs around until the clock hits zero.
      const tHalf0 = S.t - g.halfEnd;
      if (margin > 0 && tHalf0 <= BURN_SECONDS && kind !== SPIKE) dur = Math.max(dur, tHalf0 + 0.5);
      if (penalty && yards > 0) yards = yards >= 15 ? Math.min(yards, yl0 - 1) : Math.min(yards, yl0 / 2);
      if (penalty && yards < 0) yards = -Math.min(-yards, (100 - yl0) / 2);
      const newYl = yl0 - yards;
      // a real fumble drawn closer to the goal than it happened: he crossed the goal line with the ball before
      // losing it, a touchdown (players saw a receiver fumble standing in the end zone)
      if (turnover && !penalty && yards > 0 && newYl <= 0) { turnover = false; tdDef = false; }
      tdOff = tdOff || (!turnover && !penalty && newYl <= 0);
      // a safety is where the play ends: a library safety from the 1 drawn at the 11 is a loss of a yard
      safety = !turnover && !tdOff && newYl >= 100;
      let toYl = 100 - (yl0 - toRel);
      tdDef = tdDef || (turnover && toYl <= 0);
      toYl = toYl >= 100 ? 80 : clip(toYl, 1, 99);
      const fd = yards >= ytg0 || autoFd;
      const newDown = fd ? 1 : (penalty ? down0 : down0 + 1);
      const newYtg = fd ? Math.min(10, Math.max(newYl, 1)) : ytg0 - yards;
      const onDowns = !fd && newDown > 4 && !turnover && !tdOff && !safety && !tdDef;
      const change = turnover || onDowns;
      const scorePlay = tdOff || tdDef || safety;
      // the out-of-bounds window is judged where the play ends, not at the snap
      const inWin = (S.t - dur - g.halfEnd) <= g.oobWindow;
      // a foul: NFL, the clock stopped till the snap inside the oob window; college and high school (R.penStop), on the
      // ready-for-play, unless late in the half the offended team (behind or tied: it wants the clock stopped) takes
      // the snap start
      const fouler = yards < 0 ? o : d, offM = S.s[1 - fouler] - S.s[fouler];
      const penStop = penalty && (R.penStop ? (S.t - dur - g.halfEnd) <= R.penStop.window && offM <= 0 : inWin);
      // a first down (college late in the half, high school always): stopped for the chains, restarted on the
      // ready-for-play: the clock runs for the next snap, its seconds stopped given back (the credit)
      const fdStop = !!R.fdStop && fd && !change && !scorePlay && (S.t - dur - g.halfEnd) <= R.fdStop.window;
      let stop = incomplete || (oob && inWin) || penStop || change || scorePlay;
      let credit = oob ? this.oobCredit : (penalty ? this.penCredit : (fdStop ? this.fdCredit : 0));
      const t0 = S.t;
      // college (3-4-4): late in the half, a foul that stops a running clock (a pre-snap foul: none of it runs) takes
      // 10 seconds off at the offended team's option (ahead; tied, the defense), the clock then starting on the ready;
      // the fouling team (behind or tied) spends a timeout to keep them, and a runoff declined or kept by a timeout
      // starts the clock on the snap
      let ro10 = false, roTo = false;
      if (R.runoff10 && penalty && dur === 0 && runningAtSnap && !change && !scorePlay && t0 - g.halfEnd <= R.runoff10.window) {
        stop = true;
        if (offM > 0 || (offM === 0 && fouler === o)) {
          if (S.to[fouler] > 0) { S.to[fouler] -= 1; roTo = true; } else { ro10 = true; stop = false; credit = this.penCredit; }
        }
      }
      // a state's running clock (R.runClock): only a score stops it; 'wide' gives penalty enforcement its ready restart
      const rc = this._rc(S, g);
      if (rc) { stop = scorePlay; credit = penalty && R.runClock.stops === 'wide' ? this.penCredit : 0; }
      this._clockAfterPlay(S, g, dur, stop, credit);
      const run1 = S.running;
      // a half cannot end on an accepted foul (NFL: a defensive one): an untimed down (as on a roughed kick, _stRush)
      const untimed = penalty && (R.untimed === 'any' || yards > 0) && !change && !scorePlay && !ro10 && S.t <= g.halfEnd;
      if (untimed) S.t = Math.min(t0, g.halfEnd + 0.5);
      if (ro10) { S.t = S.t - 10 <= g.halfEnd + CLOCK_EPS ? g.halfEnd : S.t - 10; S.running = S.running && S.t > g.halfEnd; }
      if (S.log && roTo) S.log.push({ ev: 'timeout', team: fouler, t: S.t, why: 'runoff', left: S.to[fouler] });
      if (!change && !scorePlay) { S.yl = clip(newYl, 1, 99); S.down = newDown; S.ytg = Math.max(newYtg, 1); }
      if (turnover && !tdDef) this._flip(S, toYl);
      if (onDowns) this._flip(S, 100 - clip(newYl, 1, 99));
      if (tdOff) { S.s[o] += 6; S.phase = PAT; }
      if (tdDef && !tdOff) { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      if (safety && !tdOff && !tdDef) { S.s[d] += 2; S.phase = KICKOFF; S.freeKick = true; }
      if (rc && change) S.running = run1;
      if (S.log) {
        S.log.push({ ev: 'play', team: o, kind, call: callIdx === undefined ? -1 : callIdx, yards, down: down0, ytg: ytg0,
          yl: yl0, oob: oob && !penalty, incomplete, penalty, td: tdOff, tdDef, turnover, safety, fd: fd && !change,
          onDowns, dur, t: untimed ? g.halfEnd : S.t, running: S.running, row: pbRow === undefined ? -1 : pbRow, match: match || 0, ...(why ? { why } : {}),
          ...(untimed ? { untimed } : {}), ...(fdStop && !oob && !penalty && !rc ? { fdStop: true } : {}), ...(ro10 ? { runoff10: true } : {}),
          ...(penOpt ? { penOpt } : {}) });
      }
      this._endHalfCheck(S, g);
    }

    // where a missed field goal from yl (yards to go) leaves the other team: the spot of the kick (NFL), the previous
    // spot (college), never inside its 20; or a touchback at the 20 (high school: a miss is a scrimmage kick)
    _missYl(yl) { return this.R.fgMissTb != null ? this.R.fgMissTb : 100 - Math.max(yl + this.R.fgMissBack, 20); }

    // a state's running clock at this score and time (R.runClock), kept on once it starts when sticky (S.rc)
    _rc(S, g) {
      const rc = this.R.runClock;
      if (!rc) return false;
      const on = Math.abs(S.s[0] - S.s[1]) >= rc.margin && S.t <= rc.from * this.R.quarter && S.t > g.halfEnd;
      if (on && rc.sticky) S.rc = true;
      return on || (rc.sticky && !!S.rc);
    }

    _fieldGoal(S, g, u, o, fire, st) {
      const yl0 = S.yl;
      let p = this.fgProb(yl0 + FG_SNAP_YARDS, o);
      if (fire && p > 0) {
        const z = Math.log(clip(p, 1e-9, 1 - 1e-9) / clip(1 - p, 1e-9, 1)) + FIRE_DRILL_LOGIT;
        p = sigmoid(z);
      }
      if (st === 'block' && this._stRush(S, g, u, o, 'fg', yl0 + FG_SNAP_YARDS, p)) return;
      // (blocked: the top of the misses' draw, so the make chance is untouched)
      const d = 1 - o, dist = yl0 + FG_SNAP_YARDS, made = u[3] < p, blocked = !made && u[3] >= Math.max(p, 1 - fgBlockP(dist));
      const retTd = blocked && u[6] < FG_BLOCK_TD, rc = this._rc(S, g) && !made && !retTd;
      if (S.log) S.log.push({ ev: 'fg', team: o, dist, made, p, fire: !!fire, ...(blocked ? { blocked, retTd } : {}) });
      this._clockAfterPlay(S, g, retTd ? 8.0 : 5.0, !rc, 0);
      const run1 = S.running;
      if (made) { S.s[o] += 3; S.phase = KICKOFF; }
      else if (retTd) { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      else { this._flip(S, blocked ? clip(100 - (yl0 + FG_BLOCK_BACK), 1, 99) : this._missYl(yl0)); if (rc) S.running = run1; }
      this._endHalfCheck(S, g);
    }

    // an all-out rush on a kick (act.st): a roughing flag, a block (run back for a touchdown now and then), or
    // neither (false: the kick goes on). Blocked: the defense's ball where the kick was taken from
    _stRush(S, g, u, o, kind, dist, p) {
      const d = 1 - o, yl0 = S.yl, v = u[7];
      if (v < ST_FOUL) {
        if (S.log) S.log.push({ ev: kind, team: o, dist, made: false, p, foul: true, net: 0, retTd: false, blocked: false, touchback: false });
        const t0 = S.t;
        this._clockAfterPlay(S, g, 4.0, true, 0);
        // a half cannot end on a defensive foul: an untimed down (the page shows 0:00 and says why)
        const untimed = S.t <= g.halfEnd;
        if (untimed) S.t = Math.min(t0, g.halfEnd + 0.5);
        if (untimed && S.log) S.log[S.log.length - 1].untimed = true;
        S.yl = Math.max(yl0 - 15, 1); S.down = 1; S.ytg = Math.min(10, S.yl);
        return true;
      }
      if (v < ST_FOUL + ST_BLOCK[kind]) {
        const spot = yl0 + (kind === 'punt' ? 12 : FG_SNAP_YARDS - 10);        // where the ball was kicked from
        const retTd = spot >= 100 || u[6] < ST_BLOCK_TD;
        if (S.log) S.log.push({ ev: kind, team: o, dist, made: false, p, blocked: true, retTd, net: 0, touchback: false });
        this._clockAfterPlay(S, g, retTd ? 8.0 : 4.0, true, 0);
        if (retTd) { S.s[d] += 6; S.pos = d; S.phase = PAT; }
        else this._flip(S, clip(100 - spot, 1, 99));
        this._endHalfCheck(S, g);
        return true;
      }
      return false;
    }

    _punt(S, g, u, o, st) {
      if (st === 'rush' && this._stRush(S, g, u, o, 'punt', 0, 0)) return;
      const d = 1 - o, P = this.e.punt, yl0 = S.yl;
      const yi = clip(Math.trunc(yl0), 0, 100);
      const lo = this.e.puntLo[yi], hi = this.e.puntHi[yi];
      let j = Math.min(lo + Math.floor(u[4] * (hi - lo)), hi - 1);
      // rushing it: nobody set up a return, so no return touchdown (a block was decided above): the next real punt
      if (st === 'rush') for (let k = 0; k < hi - lo && (P.retTd[j] || P.blocked[j]); k++) j = lo + ((j - lo + 1) % (hi - lo));
      let net = P.net[j];
      const normal = !P.blocked[j] && !P.retTd[j] && !P.touchback[j];
      // the punter's rating moves the net by a fraction of a yard: the ball still lands on a whole yard line (rounded
      // up or down by chance, so the rating keeps its mean; a spot at the 5.24 read "at the 5" and a 5-yard gain from
      // it was no touchdown)
      if (normal) net = Math.floor(net + this.ctx.punterShift[o] + u[3]);
      if (normal && st === 'rush') net += ST_FAIR_GAIN;                 // a fair catch: no return yards
      const spot = yl0 - net;
      let recvYl = (P.touchback[j] || spot <= 0) ? 80 : clip(100 - spot, 1, 99);
      // the daily game's return team (st): where the ball came down or was fielded, and how the punt ended
      let retTd = !!P.retTd[j], tb = !!P.touchback[j] || spot <= 0, dur = P.dur[j];
      let how = tb ? PUNT_TB : st === 'rush' && P.how[j] === PUNT_RETURNED ? PUNT_FAIR : P.how[j], land = spot - P.ret[j];
      if ((st === 'return' || st === 'ezret') && !P.blocked[j]) {
        const ez = tb || (P.how[j] === PUNT_RETURNED && land <= 0);       // the ball reached the end zone
        if (ez && st === 'return' && !tb) {
          // fielded in the end zone, the return set up: he takes a knee, a touchback (939 of the 945 real punts that got
          // there were touchbacks, 2020-25; 4 others were run out, 2 muffed)
          tb = true; retTd = false; recvYl = 80; how = PUNT_TB;
        } else if (ez && st === 'ezret' && this.e.puntDeep.length) {
          // run it out: he fields it in the end zone and brings it out, as far as a real return of a punt fielded at
          // the 5 or deeper went (nflverse charts no difference between a ball he could have caught in the end zone
          // and one that bounced in: he catches them all); downed in the end zone, still a touchback
          const k = this.e.puntDeep[Math.min(Math.floor(u[6] * this.e.puntDeep.length), this.e.puntDeep.length - 1)];
          const at = Math.min(0, land), end = at + P.ret[k];
          retTd = !!P.retTd[k]; tb = !retTd && end <= 0; how = tb ? PUNT_TB : PUNT_RETURNED; land = at; dur = P.dur[k];
          recvYl = tb ? 80 : clip(100 - end, 1, 99);
        }
      }
      const rc = this._rc(S, g) && !retTd;
      this._clockAfterPlay(S, g, dur, !rc, 0);
      const run1 = S.running;
      if (S.log) S.log.push({ ev: 'punt', team: o, net: retTd ? null : yl0 + recvYl - 100, retTd,
        blocked: !!P.blocked[j], touchback: tb, recvYl, how, land: Math.round(land) });
      if (!retTd) { this._flip(S, recvYl); if (rc) S.running = run1; }
      else { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      this._endHalfCheck(S, g);
    }

    _flip(S, newYl) {
      S.pos = 1 - S.pos; S.yl = newYl; S.down = 1; S.ytg = Math.min(10, newYl); S.running = false; S.credit = 0;
    }

    // Overtime (the daily game's survivor; NFL rules since 2025): each team gets a possession, then the next score
    // wins; a safety ends it at once. S.ot.c counts each team's finished possessions; `b` is the state before the
    // phase just played. A touchdown that wins it needs no try. A regular-season period (10:00) can end in a tie;
    // the playoffs play another 15:00 from where the ball is (a kickoff after a score), timeouts back to 3 every two.
    // A historic drive plays the rules of its time (S.ot.r): 'msd' (playoffs 2010-2021, regular season 2012-2024) a
    // touchdown wins at once, a field goal on the first possession gives the other team the ball; 'sd' (before) the
    // first score wins.
    _otAfter(S, b) {
      if (S.phase === DONE) {
        if (!S.ot.po || S.t > 0 || S.s[0] !== S.s[1]) return;
        S.ot.n += 1; S.t = 900; S.running = false; S.credit = 0;
        S.phase = b.phase === PAT || (b.phase === SNAP && S.s[b.pos] > b.s[b.pos]) ? KICKOFF : SNAP;
        if (S.ot.n % 2 === 1) S.to[0] = S.to[1] = 3;
        if (S.log) { S.log = S.log.filter((e) => e.ev !== 'end'); S.log.push({ ev: 'period', n: S.ot.n, t: 900 }); }
        return;
      }
      const c = S.ot.c;
      if (b.phase === SNAP && (S.pos !== b.pos || S.phase !== SNAP)) c[b.pos] += 1;      // the offense's possession is over
      if (S.phase === PAT && (b.phase === KICKOFF || S.pos !== b.pos)) c[S.pos] += 1;   // a return touchdown: theirs too
      if (b.phase === SNAP && S.phase === KICKOFF && S.s[1 - b.pos] > b.s[1 - b.pos]) { S.phase = DONE; return; }   // safety
      // a touchdown that puts them ahead after the other team has had the ball wins it; otherwise the try decides
      if (S.phase === PAT) { const o = S.pos; if (S.s[o] > S.s[1 - o] && (c[1 - o] >= 1 || S.ot.r)) S.phase = DONE; return; }
      if (S.s[0] !== S.s[1] && ((c[0] >= 1 && c[1] >= 1) || S.ot.r === 'sd')) S.phase = DONE;
    }

    _endHalfCheck(S, g) {
      if (S.t <= g.halfEnd && (S.phase === SNAP || S.phase === KICKOFF)) S.phase = DONE;
      this._noTry(S, g);
    }
    // a touchdown as the fourth quarter runs out: no try when it cannot change the result (NFL since 2018), a lead or a
    // deficit of 3 or more (a try is worth 2 at most, to either team: the defense can return one for 2); college and
    // high school (R.tryForego) nor a lead of 1-2 (college: the option to forego it; high school: the defense cannot score)
    _noTry(S, g) {
      const m = S.s[S.pos] - S.s[1 - S.pos];
      if (S.phase !== PAT || S.ot || g.half !== 2 || S.t > g.halfEnd || (Math.abs(m) < 3 && !(this.R.tryForego && m > 0))) return false;
      S.phase = DONE;
      if (S.log) S.log.push({ ev: 'notry', team: S.pos, t: S.t });
      return true;
    }

    _value(S, g, persp) {
      const hm = S.s[0] - S.s[1];
      let vHome;
      if (S.phase !== DONE) {
        const o = S.pos;
        const w = this.wpFull(o, S.s[o] - S.s[1 - o], S.t, S.down, S.ytg, S.yl, S.to[o], S.to[1 - o]);
        vHome = o === 0 ? w : 1 - w;
      } else if (g.half === 2) {
        // tied at the end of overtime: a regular-season tie (half a win); playoffs play on
        vHome = hm > 0 ? 1 : hm < 0 ? 0 : S.ot && !S.ot.po ? 0.5 : this.ctx.otWpHome;
      } else {
        const r = this.ctx.receive2h;
        const w = this.wpFull(r, r === 0 ? hm : -hm, 2 * this.R.quarter, 1, 10, this.e.kickoffStart, this.R.toPerHalf, this.R.toPerHalf);
        vHome = r === 0 ? w : 1 - w;
      }
      return persp === 0 ? vHome : 1 - vHome;
    }
  }

  NFLClockEngine.Simulator = Simulator;
  NFLClockEngine.PHASE = { SNAP, PAT, KICKOFF, DONE };
  // the rulebooks (RULE_BOOK: RULES, OT, STATES), a ruleset by name, and a root's clock geometry under one
  NFLClockEngine.RULE_BOOK = RULE_BOOK;
  NFLClockEngine.rulesOf = rulesOf;
  NFLClockEngine.geom = (rules, root) => geomOf(rules && typeof rules === 'object' && rules.quarter ? rules : rulesOf(rules || 'nfl'), root);
  NFLClockEngine.helpers = { fineKey, gameMode, zoneOf, ytgBucket, uni, dcEffect, dcGroup, dcValid, DC, DC_MIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = NFLClockEngine;
  else global.NFLClockEngine = NFLClockEngine;
})(typeof self !== 'undefined' ? self : this);
