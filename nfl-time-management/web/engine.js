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
  const FIRE_WINDOW = 25.0;            // seconds left in the half below which a kick with the clock running is a fire drill
  // Clock-aware play calls when the offense needs the clock stopped and has no timeouts (2020-25 data):
  // a pass that would end in bounds with a gain is kept with this probability, otherwise redrawn from the
  // same pool's incompletions / catches out of bounds; and the pass rate rises from ~81% to ~95%.
  const CLOCK_AWARE = [[20.0, 0.53], [35.0, 0.79]];  // [seconds left in the half at the snap, keep probability]
  const CLOCK_PASS_SHIFT = 1.5, CLOCK_PASS_WINDOW = 60.0;
  const LIVE_MASK = 1 | 4 | 8 | 16 | 32 | 64 | 128;  // penalty, incomplete, oob, td, td_def, turnover, safety
  // Kick-to-win endgame: trailing by 1-2 or tied, a makeable kick in hand and a timeout to stop the clock
  // for it. The offense runs the clock down (clock-killing plays, timeouts kept), takes a timeout with
  // ~3 s left and kicks. The defense spends its timeouts to save time for a reply.
  const CLOSE_FG_P = 0.5, CLOSE_WINDOW = 180.0, CLOSE_END = 45.0, CLOSE_KICK_AT = 3.0;
  const CLOSE_SNAP_FLOOR = 12.0, CLOSE_DEF_WINDOW = 120.0;
  const KO_TOUCHBACK = 65;             // daily game: a kickoff through the end zone starts the receivers at their 35 (2025 rule)
  const PB_TD_SHARE = 0.6;            // daily game: a playbook touchdown drawn farther out scores only if it covered 60% of the way
  // daily game: matchups. Every call against the defense's call (a blitz, a loaded box, or playing soft / a light box):
  // +1 when the call beats it, -1 when it loses to it, by football logic (and the sign of the real EPA gaps: deep
  // shots fare worse against a blitz and better against a loaded box, runs worse into a loaded box, screens and
  // RPOs better against a blitz). The play is still a real one; its odds tilt toward better or worse outcomes by
  // exp(MATCH_TILT * s * EPA), so a call into the teeth of the defense gets blown up far more often than the
  // ~0.05-point real gaps would make it (a game choice: the real gaps are too small to feel play by play). The tilt is
  // scaled to each pool's own spread of EPA: a winning matchup is a fifth of a standard deviation better, so a run into
  // a light box gains about 6 yards a carry instead of the real 4.8, not a big play every time (a flat 0.45 points made
  // it 11.5), and a deep shot's swing stays a deep shot's
  const MATCH_SD = 0.2;              // a full matchup (s = +-1) moves a call's mean EPA by this share of its own spread
  const MATCH_EPA_CAP = 3;
  const MATCH_AUDIBLE = 0.9;          // when you call their defense, the offense checks into calls that beat it
  const RUN_M = { blitz: 0, load: -1, soft: 1 }, DEEP_M = { blitz: -1, load: 1, soft: -1 };
  const MATCH = {
    rb_out_strong: RUN_M, rb_out_weak: RUN_M, rb_tackle_strong: RUN_M, rb_tackle_weak: RUN_M, rb_inside_strong: RUN_M,
    rb_inside_weak: RUN_M, rb_middle: RUN_M, qb_sneak: { blitz: 0, load: -0.5, soft: 0.5 }, qb_run: { blitz: 0.5, load: -1, soft: 1 },
    rpo_strong: { blitz: 0.5, load: 1, soft: -0.5 }, rpo_weak: { blitz: 0.5, load: 1, soft: -0.5 },
    quick_strong: { blitz: 1, load: 0.5, soft: -0.5 }, quick_weak: { blitz: 1, load: 0.5, soft: -0.5 },
    quick_middle: { blitz: 1, load: 0.5, soft: -0.5 }, screen: { blitz: 1, load: 0.5, soft: -0.5 },
    deep_strong: DEEP_M, deep_weak: DEEP_M, deep_middle: DEEP_M, pa_deep: DEEP_M, pa_short: { blitz: -0.5, load: 1, soft: 0 },
    roll_strong: { blitz: -0.5, load: 0.5, soft: 0 }, roll_weak: { blitz: -0.5, load: 0.5, soft: 0 },
    hail_mary: { blitz: 0, load: 0, soft: 0 },
    // trick plays: the flea-flicker and the receiver pass sell the run (a loaded box bites; a blitz gets home before
    // the slow throw; soft safeties stay deep); the end-around beats a blitz flowing to the run and loses to a loaded,
    // disciplined front; the direct snap is a run with an extra blocker
    trick_flea: { blitz: -1, load: 1, soft: -1 }, trick_pass: { blitz: -1, load: 1, soft: -1 },
    trick_reverse: { blitz: 1, load: -1, soft: 0 }, trick_direct: { blitz: 0, load: -1, soft: 1 },
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
  const DROPBACK_EV = new Set(['sack', 'strip_sack', 'sack_fumble', 'scramble', 'throwaway', 'interception', 'pick_six', 'near_pick', 'drop']);
  // daily game: your special-teams defense (act.st) when they kick. 'block' (field goal) or 'rush' (punt) sends
  // everyone: more blocks, but now and then a roughing flag (15 yards and a first down, an untimed down if time ran
  // out), and on a punt no return set up (a fair catch: no return yards, no return touchdown). 'safe' / 'return' is
  // the usual kick (the engine's plain model). NFL rates: about 1.5% of field goals and 1% of punts are blocked;
  // an all-out rush roughly triples that; blocked kicks are run back for touchdowns about one time in ten.
  const ST_BLOCK = { fg: 0.045, punt: 0.035 }, ST_FOUL = 0.02, ST_BLOCK_TD = 0.1, ST_FAIR_GAIN = 4;
  const WHO_CODE = { RB: 2, WR: 3, TE: 4 };            // the target's position in the playbook's carry codes
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

  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
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
        touchback: new Uint8Array(n), dur: new Float64Array(n) };
      order.forEach((j, i) => {
        this.punt.yl[i] = yl[j]; this.punt.net[i] = net[j]; this.punt.retTd[i] = fl[j] & 1;
        this.punt.blocked[i] = (fl[j] >> 1) & 1; this.punt.touchback[i] = (fl[j] >> 2) & 1; this.punt.dur[i] = d10[j] / 10;
      });
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
      // daily game: kicks into the landing zone, everything but a touchback at the 35 (returned, short, or bounced in)
      this.ko.ret = Int32Array.from(Array.from(this.ko.start.keys()).filter((i) => !(this.ko.start[i] === KO_TOUCHBACK && this.ko.dur10[i] === 0)));
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
        // what happened on each real play (narration only): event, penalty called, pre-snap look
        event: R.event ? decode(R.event) : null, pen: R.pen ? decode(R.pen) : null, look: R.look ? decode(R.look) : null,
        air: R.air ? decode(R.air) : null, carry: R.carry ? decode(R.carry) : null,    // the animation: air yards, carrier, broken tackle
        // the animation: NGS route, coverage, pass rush, time to throw (playbook.py _charting)
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
      P.itemEpa = new Float64Array(P.items.length);
      for (let i = 0; i < P.items.length; i++) P.itemEpa[i] = P.epa[P.items[i]];
      this.pb = P;
      return P;
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
        let sw = 0, swo = 0, swi = 0;
        const odds = P.oobOdds[c], stay = P.stayOdds ? P.stayOdds[c] : 1;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * e[i] - mx), out = P.flags[P.items[i]] & 8;
          sw += w; swo += out ? w * odds : w; swi += out ? w * stay : w;
        }
        let cum = 0, cumo = 0, cumi = 0;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * e[i] - mx), out = P.flags[P.items[i]] & 8;
          cum += w / sw; cumo += (out ? w * odds : w) / swo; cumi += (out ? w * stay : w) / swi;
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
      const home = NFLClockEngine.effective(game.home, manual[game.home.team]);
      const away = NFLClockEngine.effective(game.away, manual[game.away.team]);
      const lg = game.league;
      const eraPass = lg.mu_pass - this.meanEpa[1], eraRun = lg.mu_rush - this.meanEpa[0];
      const delta = [[0, 0], [0, 0]];
      [[home, away, 0.5], [away, home, -0.5]].forEach(([o, d, sgn], i) => {
        delta[i][PASS] = eraPass + o.off_pass + d.def_pass + sgn * lg.home_pass;
        delta[i][RUN] = eraRun + o.off_rush + d.def_rush + sgn * lg.home_rush;
      });
      const two = [0, 1].map((i) => clip(0.47 + 0.3 * (0.6 * delta[i][PASS] + 0.4 * delta[i][RUN]), 0.35, 0.6));
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
        twoPt: two, otWpHome: 0.5 + 0.5 * (normCdf(spread / 13.5) - 0.5),
        teams: [home, away],
      };
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
    }

    fgProb(dist, team) {
      if (dist > 68) return 0;
      const long = -FG_LONG[1] * Math.max(0, dist - FG_LONG[0]) - FG_LONG[3] * Math.max(0, dist - FG_LONG[2]);
      return sigmoid(this.e.fgLogit(dist, this.ctx) + this.ctx.kickerShift[team] + long);
    }

    wpFull(team, margin, t, down, ytg, yl, offTo, defTo) {
      const ctx = this.ctx;
      const spread = team === 0 ? ctx.homeSpread : -ctx.homeSpread;
      this.e.wpFeatures(margin, Math.max(t, 1), down, clip(ytg, 1, 99), clip(yl, 1, 99), offTo, defTo, spread,
        team === 0 ? 1 : 0, team === ctx.receive2h ? 1 : 0, this.x);
      return sigmoid(this.e.wpRaw(this.x));
    }

    kneelOutPossible(tHalf, down, defTo, running, tmwPending) {
      const k = clip(4 - down, 0, 3);
      const gaps = k + (running ? 1 : 0);
      const stops = defTo + (tmwPending ? 1 : 0);
      const gap = 0.5 * (KNEEL_RUNOFF[0] + KNEEL_RUNOFF[1]);   // the average kneel runoff
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
      const o = root.pos, half = root.t > 1800 ? 1 : 2, tHalf = root.t - (half === 1 ? 1800 : 0);
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
      const o = root.pos, half = root.t > 1800 ? 1 : 2, tHalf = root.t - (half === 1 ? 1800 : 0);
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
    // pers (daily game): the offense's personnel (11, 12, 21, 13): only real plays run with it, against the look,
    // from the situation's pool then the call's coarser pools; without the look; else as if none was picked
    samplePlaybook(team, callIdx, fk, u, oob, looks, s, route, who, pers) {
      const P = this.e.pb, cdf = this._cdfOf(team, oob);
      const pool = P.poolOf[callIdx * P.nFine + fk];
      if (route && P.ngs) {
        const r = this._pickT(this.routeSet(team, callIdx, fk, oob, looks, s, route, who), u);
        if (r >= 0) return r;
      }
      if (pers && P.ngs && P.ngs.pers) {
        const pools = [pool];
        if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (!pools.includes(lp)) pools.push(lp); }
        // (enough plays with it first; then any at all, before the grouping is dropped)
        for (const need of [true, false]) {
          for (const lk of looks && P.lookB ? [looks, 0] : [0]) {
            for (const pl of pools) {
              const r = this._sampleLook(cdf, pl, u, lk, s, 0, 0, need, pers);
              if (r >= 0) return r;
            }
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
      if (s) return this._sampleLook(cdf, pool, u, 0, s);
      let lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      const target = pool + u;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < target) lo = mid + 1; else hi = mid; }
      return P.items[lo];
    }

    // the real plays a pick (a receiver's route) draws from, with their weights: the route always; then the position,
    // then the look the defense showed, before the situation: the situation's pool, the call's coarser pools, every
    // situation of this call, then of every call of its kind (a dropback, play action, a rollout). null: none
    routeSet(team, callIdx, fk, oob, looks, s, route, who) {
      const P = this.e.pb, cdf = this._cdfOf(team, oob);
      const ri = P.ngs ? P.routeNames.indexOf(route) : -1;
      if (!(ri > 0)) return null;
      const pool = P.poolOf[callIdx * P.nFine + fk], coarse = [];
      if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (lp !== pool && !coarse.includes(lp)) coarse.push(lp); }
      const sets = [this._callRows(callIdx), this._groupRows(callIdx)];
      for (const w of who ? [who, 0] : [0]) for (const lk of looks ? [looks, 0] : [0]) {
        for (const pl of [pool, ...coarse]) { const T = this._lookT(cdf, pl, lk, s, ri, w, true); if (T) return T; }
        for (const set of sets) { const T = this._setT(set, lk, s, ri, w); if (T) return T; }
      }
      return null;
    }
    // what a pick tends to do here: the share of throws caught, yards a throw, interceptions (weighted real plays)
    routeOdds(team, callIdx, fk, looks, route, who, toGoal) {
      const P = this.e.pb, s = this.matchOf(callIdx, this.defOfLooks(looks));
      const T = this.routeSet(team, callIdx, fk, false, looks, s, route, WHO_CODE[who] || 0);
      if (!T) return null;
      let w0 = 0, caught = 0, yds = 0, picks = 0;
      T.items.forEach((r, i) => {
        const w = T.cum[i] - (i ? T.cum[i - 1] : 0), f = P.flags[r], ev = P.eventNames[P.event[r]] || '';
        if (f & 1) return;                                             // penalties aside
        w0 += w; yds += w * (toGoal > 0 ? Math.min(P.yards[r], toGoal) : P.yards[r]);   // a throw gains at most the goal line
        if (!(f & 4) && !(f & 64) && !/sack|scramble|throwaway/.test(ev)) caught += w;
        if ((f & 64) && /interception|pick_six/.test(ev)) picks += w;
      });
      return w0 > 0 ? { caught: caught / w0, yds: yds / w0, picks: picks / w0, n: T.items.length } : null;
    }

    // daily game: a call of this kind ('run' or 'pass'), as often as NFL play-callers make each in situation fk; against
    // your defensive call (def, or the whole call dc) the offense checks into the calls that beat it (MATCH_AUDIBLE)
    pickCall(kind, fk, u, def, dc) {
      const P = this.e.pb, nC = P.calls.length;
      const tilt = (c) => (def ? Math.exp(MATCH_AUDIBLE * P.match[c][def]) : dc ? Math.exp(DC_READ * dcEffect(P.dcEff, P.calls[c].id, dc).s) : 1);
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
    dcLean(fk, dc) {
      const P = this.e.pb, nC = P.calls.length, m = { run: [0, 0], pass: [0, 0] };
      for (let c = 0; c < nC; c++) {
        const f = P.freq[fk * nC + c], k = P.calls[c].kind;
        if (f > 0 && m[k]) { m[k][0] += f * dcEffect(P.dcEff, P.calls[c].id, dc).s; m[k][1] += f; }
      }
      const avg = (x) => (x[1] > 0 ? x[0] / x[1] : 0);
      return DC_READ * (avg(m.pass) - avg(m.run));
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
    _sampleLook(cdf, pool, u, looks, s, ri, who, need, pers) {
      return this._pickT(this._lookT(cdf, pool, looks, s, ri, who, need, pers), u);
    }
    _pickT(T, u) {
      if (!T) return -1;
      const target = u * T.tot, c = T.cum;
      let a = 0, b = c.length - 1;
      while (a < b) { const m = (a + b) >> 1; if (c[m] < target) a = m + 1; else b = m; }
      return T.items[a];
    }
    _lookT(cdf, pool, looks, s, ri, who, need, pers) {
      const key = `${pool}|${looks}|${s || 0}|${ri || 0}|${who || 0}|${pers || 0}|${need ? 1 : 0}`;
      this._pick = this._pick || new WeakMap();
      let byKey = this._pick.get(cdf);
      if (!byKey) { byKey = new Map(); this._pick.set(cdf, byKey); }
      let T = byKey.get(key);
      if (T === undefined) {
        const P = this.e.pb, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1, k = s ? (MATCH_SD * s) / Math.sqrt(this._poolVar(cdf, pool)) : 0;
        const items = [], cum = [];
        let tot = 0;
        for (let i = lo; i <= hi; i++) {
          const r = P.items[i];
          if (looks) { const b = P.lookB[r]; if (!(b < 8 && (looks >> b) & 1)) continue; }
          if (ri && P.ngs.route[r] !== ri) continue;
          if (who && (P.carry[r] & 7) !== who) continue;
          if (pers && P.ngs.pers[r] !== pers) continue;
          let w = cdf[i] - (i > lo ? cdf[i - 1] : pool);
          if (k) { const e = P.epa[r]; if (Number.isFinite(e)) w *= Math.exp(k * clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP)); }
          tot += w; items.push(r); cum.push(tot);
        }
        T = ((looks || need) && items.length < PB_LOOK_MIN) || !(tot > 0) ? null : { items, cum, tot };
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
    sampleVsDefense(team, callIdx, fk, u, oob, dc, s, route, who, pers) {
      const P = this.e.pb;
      if (P.ngs && P.ngs.dpers && dcValid(dc)) {
        const cdf = this._cdfOf(team, oob), pool = P.poolOf[callIdx * P.nFine + fk], pools = [pool];
        if (P.lookPool) for (let b = 0; b < 4; b++) { const lp = P.lookPool[(callIdx * P.nFine + fk) * 4 + b]; if (!pools.includes(lp)) pools.push(lp); }
        const ri = route ? P.routeNames.indexOf(route) : 0;
        if (!(route && !(ri > 0))) {
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
                const r = this._pickT(this._dcT(cdf, pl, null, dc, L, s, ri, who || 0, pers || 0, pass, ref), u);
                if (r >= 0) return r;
              }
            }
            if (where === 'pool') continue;
            for (const set of where === 'near' ? near : wide) {
              const r = this._pickT(this._dcT(null, -1, set(), dc, L, s, ri, who || 0, pers || 0, pass, ref), u);
              if (r >= 0) return r;
            }
          }
        }
      }
      return this.samplePlaybook(team, callIdx, fk, u, oob, 0, 0, route, who, pers);
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
      if (!cache) { cache = new Map(); this._dcRefs.set(cdf, cache); }
      let R = cache.get(key);
      if (R) return R;
      const P = this.e.pb, N = P.ngs, lo = P.offsets[pool], hi = P.offsets[pool + 1] - 1;
      let wA = 0, mA = 0, nA = 0, wB = 0;
      const items = [], cum = [];
      for (let i = lo; i <= hi; i++) {
        const r = P.items[i];
        if (ri && N.route[r] !== ri) continue;
        if (who && (P.carry[r] & 7) !== who) continue;
        if (pers && N.pers[r] && N.pers[r] !== pers) continue;
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
      R = { edge: nA >= PB_LOOK_MIN && wA > 0 ? mA / wA - pm : null, shareB: wA + wB > 0 ? wB / (wA + wB) : 0, items, cum, tot: wB };
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
    _dcT(cdf, pool, set, dc, L, s, ri, who, pers, pass, ref) {
      const key = `dc|${set ? set.id : pool}|${dc.pers}|${dc.front}|${dc.cover}|${dc.rush}|${L.join('.')}|${s || 0}|${ri}|${who}|${pers}|${pass ? 1 : 0}|${ref.edge == null ? '' : ref.edge.toFixed(5)}|${ref.shareB.toFixed(5)}|${ref.tot}`;
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
        if (ri && N.route[r] !== ri) return 0;
        if (who && (P.carry[r] & 7) !== who) return 0;
        if (byPers && N.pers[r] && N.pers[r] !== pers) return 0;
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
      if (set) for (const r of set.rows) take(r, 1);
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
      const id = `w${grp ? 'g' + kind(P.calls[c].id) : c}|${zone}|${short ? 1 : 0}`;
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
    _setT(set, looks, s, ri, who) {
      const key = `${set.id}|${looks}|${s || 0}|${ri || 0}|${who || 0}`;
      this._setPick = this._setPick || new Map();
      let T = this._setPick.get(key);
      if (T === undefined) {
        const P = this.e.pb, rows = [];
        for (const r of set.rows) {
          if (looks) { const b = P.lookB[r]; if (!(b < 8 && (looks >> b) & 1)) continue; }
          if (ri && P.ngs.route[r] !== ri) continue;
          if (who && (P.carry[r] & 7) !== who) continue;
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
        rows.forEach((r) => { const e = P.epa[r]; tot += k && Number.isFinite(e) ? Math.exp(k * clip(e, -MATCH_EPA_CAP, MATCH_EPA_CAP)) : 1; cum.push(tot); });
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
      // 0:00 of Q2 is t = 1800, otherwise the start of the second half; a try at that moment (a touchdown on the last
      // play of the first half) still belongs to the first half, which ends after it (sim.py the same)
      const halfEnd = root.t > 1800 || (root.t === 1800 && root.phase === PAT) ? 1800 : 0;
      const g = { halfEnd, half: halfEnd > 0 ? 1 : 2, qEnd: halfEnd + 900, tmw: halfEnd + 120,
        oobWindow: halfEnd > 0 ? 120 : 300 };
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
        S.credit = 0; S.phase = root.phase || SNAP; S.freeKick = false; S.stratActive = !!action.h1; S.plays = 0;
        S.ot = root.ot ? { c: [root.ot.c[0], root.ot.c[1]], po: !!root.ot.po, n: root.ot.n || 1 } : null;
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
      // 0:00 of Q2 is t = 1800, otherwise the start of the second half; a try at that moment (a touchdown on the last
      // play of the first half) still belongs to the first half, which ends after it (sim.py the same)
      const halfEnd = root.t > 1800 || (root.t === 1800 && root.phase === PAT) ? 1800 : 0;
      const g = { halfEnd, half: halfEnd > 0 ? 1 : 2, qEnd: halfEnd + 900, tmw: halfEnd + 120,
        oobWindow: halfEnd > 0 ? 120 : 300 };
      const S = { t: root.t, pos: root.pos, s: [root.score[0], root.score[1]], down: root.down, ytg: root.ytg, yl: root.yl,
        to: [root.to[0], root.to[1]], running: !!root.clock_running, credit: root.credit || 0, phase: root.phase || SNAP,
        freeKick: !!root.free_kick, stratActive: false, plays: 0, log: [],
        ot: root.ot ? { c: [root.ot.c[0], root.ot.c[1]], po: !!root.ot.po, n: root.ot.n || 1 } : null };
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
      if (S.ot) out.ot = { c: [S.ot.c[0], S.ot.c[1]], po: S.ot.po, n: S.ot.n };
      return {
        root: out,
        log: S.log, done: S.phase === DONE,
      };
    }

    // ------------------------------------------------------------------ PAT ---
    _pat(S, g, u, act) {
      const o = S.pos, margin = S.s[o] - S.s[1 - o], tHalf = S.t - g.halfEnd;
      let go2 = g.half === 2 && tHalf <= 900 && TWO_PT_SET.has(margin);
      if (act && act.pat) go2 = act.pat === 'two';
      const pk = clip(this.fgProb(33.0, o), 1e-9, 1 - 1e-9);
      const p = go2 ? this.ctx.twoPt[o] : sigmoid(Math.log(pk / (1 - pk)) + XP_LOGIT);
      let good = u[3] < p, callIdx = -1, row = -1, why = null;
      // daily game: a two-point try you called is a real play of that call from the 2 (a must-score snap), against
      // the look the defense showed: good if it gets 2 yards without a turnover (a flag: the league rate decides)
      if (go2 && act && act.call !== undefined && this.pbCdf && this.e.pb.callIndex[act.call] !== undefined) {
        const P = this.e.pb;
        callIdx = P.callIndex[act.call];
        const who = act.route ? (WHO_CODE[act.who] || 0) : undefined;
        if (dcValid(act.dc)) {
          const m = dcEffect(this.e.pb.dcEff, act.call, act.dc, act.pers, act.seen);
          why = m.why.slice(0, 3);
          row = this.sampleVsDefense(o, callIdx, fineKey(MODE_NORMAL, 3, 2, 2), u[2], false, act.dc, m.s, act.route, who, act.pers);
        } else {
          const match = this.matchOf(callIdx, this.defOfLooks(act.looks));
          row = this.samplePlaybook(o, callIdx, fineKey(MODE_NORMAL, 3, 2, 2), u[2], false, act.looks, match, act.route, who, act.pers);
        }
        if (row >= 0) {
          const f = P.flags[row];
          if (!(f & 1)) good = !(f & 64) && !(f & 4) && ((f & 16) !== 0 || P.yards[row] >= 2);
        }
      }
      if (good) S.s[o] += go2 ? 2 : 1;
      if (S.log) S.log.push({ ev: 'pat', team: o, two: go2, good, call: callIdx, row, ...(why ? { why } : {}) });
      S.phase = S.t <= g.halfEnd ? DONE : KICKOFF;
      S.freeKick = false;
    }

    // -------------------------------------------------------------- KICKOFF ---
    _kickoff(S, g, u, act) {
      const kt = S.pos, rt = 1 - kt, marginK = S.s[kt] - S.s[rt], tHalf = S.t - g.halfEnd;
      let onside = g.half === 2 && marginK < 0 &&
        ((tHalf <= 125 && S.to[kt] <= 1) || tHalf <= 65 || (tHalf <= 160 && marginK <= -9));
      onside = onside && !S.freeKick;
      if (act && act.kick) onside = act.kick === 'onside';
      const K = this.e.ko;
      let j = Math.floor(u[4] * K.start.length);
      // daily game: kicked to the returner (a real landing-zone kick) or through the end zone (a touchback)
      if (act && act.kick === 'return' && K.ret.length) j = K.ret[Math.floor(u[4] * K.ret.length)];
      let start = K.start[j];
      let dur = K.dur10[j] / 10;
      let retTd = K.retTd[j] && !onside;
      if (act && act.kick === 'touchback' && !S.freeKick) { start = KO_TOUCHBACK; dur = 0; retTd = false; }
      if (S.freeKick) start = clip(start - 8, 40, 75);
      const rec = onside && u[3] < this.onsideP;
      S.pos = rec ? kt : rt;
      S.yl = onside ? (rec ? 54 : 46) : start;
      S.t = Math.max(S.t - (onside ? 3 : dur), g.halfEnd);
      S.down = 1; S.ytg = Math.min(10, S.yl); S.running = false; S.credit = 0; S.freeKick = false; S.phase = SNAP;
      if (retTd) { S.s[S.pos] += 6; S.phase = PAT; }
      if (S.log) S.log.push({ ev: 'kickoff', team: kt, onside, recovered: rec, retTd, yl: S.yl, tb: !onside && dur === 0, kick: act && act.kick || null });
      if (S.t <= g.halfEnd && S.phase === SNAP) S.phase = DONE;
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
        // the defense saves time for a reply when a field goal would beat it, whatever timeouts the offense has left
        // (players saw a defense let the clock run out on them with the offense in range and out of timeouts)
        const defSaves = margin >= -2 && margin <= 0 && tHalf <= CLOSE_DEF_WINDOW && this.fgProb(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P;
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
      // (a timeout called before the two-minute warning never carries the clock past it: the warning still comes)
      if (called) S.t = Math.max(S.t - this.toReact, halfEnd, S.t > g.tmw ? Math.min(S.t, g.tmw + 0.01) : halfEnd);
      runC = runC && !called;
      // kick to win: with the clock running and little left, let it run down, then timeout and kick
      const free = !(act && (act.tempo !== undefined || act.play !== undefined || act.runoff !== undefined));
      const endkick = closing && runC && tHalf <= CLOSE_END && S.to[o] > 0 && free;
      if (endkick) { S.t = halfEnd + Math.min(tHalf, CLOSE_KICK_AT); S.to[o] -= 1; runC = false; }
      if (S.log) {
        if (defCall) S.log.push({ ev: 'timeout', team: d, t: S.t });
        if (offCall) S.log.push({ ev: 'timeout', team: o, t: S.t });
        if (endkick) S.log.push({ ev: 'timeout', team: o, t: S.t, why: 'kick' });
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
      if (tempo === T_KNEEL) runoff = KNEEL_RUNOFF[0] + (KNEEL_RUNOFF[1] - KNEEL_RUNOFF[0]) * u[0];
      else if (tempo === T_FIRE) runoff = FIRE_DRILL[0] + (FIRE_DRILL[1] - FIRE_DRILL[0]) * u[0];
      else { const arr = this.e.tempo[tempo]; runoff = arr[Math.floor(u[0] * arr.length)]; }
      runoff = runC ? Math.max(runoff - S.credit, 0) : 0;
      // running it down: never past the point where the kick is still safe (daily game: a milk call does the same)
      const runDown = free || (!!this.pbCdf && !!act && act.tempo === 'milk');
      if (runDown && closing && runC && tempo === MILK) runoff = Math.min(runoff, Math.max(S.t - halfEnd - CLOSE_SNAP_FLOOR, 0));
      if (act && act.runoff !== undefined) runoff = runC ? act.runoff : 0;
      const t0 = S.t;
      let t1 = t0 - runoff;
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
        if (act && act.read && dcValid(act.dc) && this.pbCdf) lg += this.dcLean(fk, act.dc);
        kind = u[1] < sigmoid(lg) ? PASS : RUN;
      }
      S.plays += 1;
      // (4) execute
      if (kind === FG) this._fieldGoal(S, g, u, o, fire, act && act.st);
      else if (kind === PUNT) this._punt(S, g, u, o, act && act.st);
      else {
        let pbRow = -1, callIdx = -1, match = 0, why = null;
        const oobWant = half === 2 && tHalf <= 300 && margin > 0 ? -1 : 0;
        if (act && act.call !== undefined && this.pbCdf && (kind === RUN || kind === PASS)) {
          // your call, against the look the defense showed (Versus: the defense's whole call): the matchup tilts the draw
          callIdx = this.e.pb.callIndex[act.call];
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl), who = act.route ? (WHO_CODE[act.who] || 0) : undefined;
          if (dcValid(act.dc)) {
            const m = dcEffect(this.e.pb.dcEff, act.call, act.dc, act.pers, act.seen);
            match = m.s; why = m.why.slice(0, 3);
            pbRow = this.sampleVsDefense(o, callIdx, fk, u[2], act.oob ? 1 : oobWant, act.dc, match, act.route, who, act.pers);
          } else {
            match = this.matchOf(callIdx, this.defOfLooks(act.looks));
            pbRow = this.samplePlaybook(o, callIdx, fk, u[2], act.oob ? 1 : oobWant, act.looks, match, act.route, who, act.pers);
          }
        } else if (act && dcValid(act.dc) && this.pbCdf && (kind === RUN || kind === PASS)) {
          // no call from the offense: a call of the kind it chose, as often as play-callers make it here, against the
          // defense's call. Versus: no check into a better one (the other phone never sees the defense's call); the
          // daily game (act.read: the computer's offense reads your defense) checks into calls that beat it
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl);
          callIdx = this.pickCall(kind === PASS ? 'pass' : 'run', fk, u[4], null, act.read ? act.dc : null);
          if (callIdx >= 0) {
            const m = dcEffect(this.e.pb.dcEff, this.e.pb.calls[callIdx].id, act.dc);
            match = m.s; why = m.why.slice(0, 3);
            pbRow = this.sampleVsDefense(o, callIdx, fk, u[2], oobWant, act.dc, match);
          }
        } else if (act && act.def && DEF_LOOKS[act.def] && this.pbCdf && (kind === RUN || kind === PASS)) {
          // daily game: you called the defense; the offense runs a play of the kind it chose, a call as often as
          // play-callers make it here (more often one that beats your call: it checks into it), drawn from real plays
          // of that call against the look you called, tilted by the matchup
          const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl);
          callIdx = this.pickCall(kind === PASS ? 'pass' : 'run', fk, u[4], act.def);
          match = this.matchOf(callIdx, act.def);
          if (callIdx >= 0) pbRow = this.samplePlaybook(o, callIdx, fk, u[2], half === 2 && tHalf <= 300 && margin > 0 ? -1 : 0, DEF_LOOKS[act.def], match);
        }
        this._scrimmage(S, g, u, o, kind, margin, aware, closing, pbRow, callIdx, match, why);
      }
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
      if (tdConv) wpConv = 1 - this.wpFull(d, -(margin + 7), t6, 1, 10, KICKOFF_START_YL, defTo, offTo);
      else wpConv = this.wpFull(o, margin, t6, 1, Math.min(10, newYl), newYl, offTo, defTo);
      const fail = 1 - this.wpFull(d, -margin, t6, 1, Math.min(10, 100 - yl), 100 - yl, defTo, offTo);
      const wpGo = pConv * wpConv + (1 - pConv) * fail;
      let wpFg = -1;
      if (pFg > 0.02) {
        const made = 1 - this.wpFull(d, -(margin + 3), t5, 1, 10, KICKOFF_START_YL, defTo, offTo);
        const missYl = 100 - Math.max(yl + 8, 20);
        const miss = 1 - this.wpFull(d, -margin, t5, 1, Math.min(10, missYl), missYl, defTo, offTo);
        wpFg = pFg * made + (1 - pFg) * miss;
      }
      let wpPunt = -1;
      if (yl >= 35) {
        const ry = this.puntReceiveYl(yl, o);
        wpPunt = 1 - this.wpFull(d, -margin, t9, 1, Math.min(10, ry), ry, defTo, offTo);
      }
      let choice = (wpGo >= wpFg && wpGo >= wpPunt) ? -1 : (wpFg >= wpPunt ? FG : PUNT);
      const cm = this.ctx.coach4th && this.ctx.coach4th[o];
      if (cm && u5 !== undefined) choice = this._coachChoice(S, g, o, margin, tHalf, pFg, u5, cm);
      if (half === 2) {
        const late = tHalf <= 40;
        if (late && margin < -3) choice = -1;
        if (late && margin >= -3 && margin <= 0 && pFg >= 0.3) choice = FG;
        if (late && margin >= -3 && margin < 0 && pFg < 0.3) choice = -1;  // trailing: must go
        // Tied and out of range: punt and play for overtime (the WP model overrates late possession here).
        if (margin === 0 && pFg < 0.3 && yl >= 35 && (late || (tHalf <= 120 && yl >= 50))) choice = PUNT;
      } else {
        if (tHalf <= 20 && pFg >= 0.2) choice = FG;
        if (tHalf <= 20 && pFg < 0.2 && choice === PUNT && yl < 60) choice = -1;
      }
      // overtime, once the other team has had its possession: this one decides it. Down 4 or more, only a
      // touchdown keeps the game going; down 1-3 a field goal ties or wins; tied, a field goal wins.
      if (S.ot && S.ot.c[d] >= 1) {
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
      S.t = Math.max(t1, g.halfEnd);
      S.running = !(stopFlag || crossTmw || crossQ);
      S.credit = S.running ? credit : 0;
    }

    _scrimmage(S, g, u, o, kind, margin, aware, closing, pbRow, callIdx, match, why) {
      const d = 1 - o, L = this.e.lib;
      const yl0 = S.yl, ytg0 = S.ytg, down0 = S.down;
      let yards = 0, penalty = false, autoFd = false, incomplete = false, oob = false, tdOff = false, tdDef = false,
        turnover = false, toRel = 0, safety = false, dur = 0;
      if (pbRow >= 0) {   // a specific call from the playbook (daily game)
        const P = this.e.pb, f = P.flags[pbRow];
        yards = P.yards[pbRow]; penalty = !!(f & 1); autoFd = !!(f & 2); incomplete = !!(f & 4); oob = !!(f & 8);
        // a real play drawn away from its own spot keeps only what still fits here: a touchdown if it covered most
        // of the way (PB_TD_SHARE), a safety only if the loss reaches the end zone (from the spot, below)
        tdOff = !!(f & 16) && yards >= PB_TD_SHARE * yl0; tdDef = !!(f & 32); turnover = !!(f & 64);
        toRel = P.toRel[pbRow]; dur = P.dur10[pbRow] / 10;
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
      const stop = incomplete || (oob && inWin) || (penalty && inWin) || change || scorePlay;
      const credit = oob ? this.oobCredit : (penalty ? this.penCredit : 0);
      this._clockAfterPlay(S, g, dur, stop, credit);
      if (!change && !scorePlay) { S.yl = clip(newYl, 1, 99); S.down = newDown; S.ytg = Math.max(newYtg, 1); }
      if (turnover && !tdDef) this._flip(S, toYl);
      if (onDowns) this._flip(S, 100 - clip(newYl, 1, 99));
      if (tdOff) { S.s[o] += 6; S.phase = PAT; }
      if (tdDef && !tdOff) { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      if (safety && !tdOff && !tdDef) { S.s[d] += 2; S.phase = KICKOFF; S.freeKick = true; }
      if (S.log) {
        S.log.push({ ev: 'play', team: o, kind, call: callIdx === undefined ? -1 : callIdx, yards, down: down0, ytg: ytg0,
          yl: yl0, oob: oob && !penalty, incomplete, penalty, td: tdOff, tdDef, turnover, safety, fd: fd && !change,
          onDowns, dur, t: S.t, running: S.running, row: pbRow === undefined ? -1 : pbRow, match: match || 0, ...(why ? { why } : {}) });
      }
      this._endHalfCheck(S, g);
    }

    _fieldGoal(S, g, u, o, fire, st) {
      const yl0 = S.yl;
      let p = this.fgProb(yl0 + FG_SNAP_YARDS, o);
      if (fire && p > 0) {
        const z = Math.log(clip(p, 1e-9, 1 - 1e-9) / clip(1 - p, 1e-9, 1)) + FIRE_DRILL_LOGIT;
        p = sigmoid(z);
      }
      if (st === 'block' && this._stRush(S, g, u, o, 'fg', yl0 + FG_SNAP_YARDS, p)) return;
      const made = u[3] < p;
      if (S.log) S.log.push({ ev: 'fg', team: o, dist: yl0 + FG_SNAP_YARDS, made, p, fire: !!fire });
      this._clockAfterPlay(S, g, 5.0, true, 0);
      if (made) { S.s[o] += 3; S.phase = KICKOFF; } else this._flip(S, 100 - Math.max(yl0 + 8, 20));
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
        if (S.t <= g.halfEnd) S.t = Math.min(t0, g.halfEnd + 0.5);   // a half cannot end on a defensive foul: an untimed down
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
      if (normal) net += this.ctx.punterShift[o];
      if (normal && st === 'rush') net += ST_FAIR_GAIN;                 // a fair catch: no return yards
      const spot = yl0 - net;
      const recvYl = (P.touchback[j] || spot <= 0) ? 80 : clip(100 - spot, 1, 99);
      this._clockAfterPlay(S, g, P.dur[j], true, 0);
      if (S.log) S.log.push({ ev: 'punt', team: o, net: P.retTd[j] ? null : yl0 + recvYl - 100, retTd: !!P.retTd[j],
        blocked: !!P.blocked[j], touchback: !!P.touchback[j] || spot <= 0, recvYl });
      if (!P.retTd[j]) this._flip(S, recvYl);
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
      if (S.phase === PAT) { const o = S.pos; if (S.s[o] > S.s[1 - o] && c[1 - o] >= 1) S.phase = DONE; return; }
      if (c[0] >= 1 && c[1] >= 1 && S.s[0] !== S.s[1]) S.phase = DONE;
    }

    _endHalfCheck(S, g) {
      if (S.t <= g.halfEnd && (S.phase === SNAP || S.phase === KICKOFF)) S.phase = DONE;
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
        const w = this.wpFull(r, r === 0 ? hm : -hm, 1800, 1, 10, KICKOFF_START_YL, 3, 3);
        vHome = r === 0 ? w : 1 - w;
      }
      return persp === 0 ? vHome : 1 - vHome;
    }
  }

  NFLClockEngine.Simulator = Simulator;
  NFLClockEngine.PHASE = { SNAP, PAT, KICKOFF, DONE };
  NFLClockEngine.helpers = { fineKey, gameMode, zoneOf, ytgBucket, uni, dcEffect, dcGroup, dcValid, DC, DC_MIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = NFLClockEngine;
  else global.NFLClockEngine = NFLClockEngine;
})(typeof self !== 'undefined' ? self : this);
