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
  const FIRE_DRILL_LOGIT = -0.3;       // rushed kicks are a little less accurate
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
      return {
        coach4th,
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
      this.cdf = []; this.conv = [];
      for (let team = 0; team < 2; team++) {
        const { cdf, prob } = eng.tilt(ctx.delta[team][RUN], ctx.delta[team][PASS]);
        this.cdf.push(cdf);
        this.conv.push(eng.conversionTable(prob, ctx.proe[team] / 0.24));
      }
      const c = eng.consts;
      this.kneelDur = c.kneel_duration; this.spikeDur = c.spike_duration; this.toReact = c.timeout_reaction;
      this.oobCredit = c.oob_restart_credit; this.penCredit = c.penalty_restart_credit;
      this.onsideP = Math.max(c.onside, 0.05);
      this.x = new Float64Array(13);
    }

    fgProb(dist, team) {
      if (dist > 68) return 0;
      return sigmoid(this.e.fgLogit(dist, this.ctx) + this.ctx.kickerShift[team]);
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
      const burn = k * this.kneelDur + Math.max(gaps - stops, 0) * 38 + Math.min(gaps, stops) * 1;
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
      const halfEnd = root.t > 1800 ? 1800 : 0;
      const g = { halfEnd, half: halfEnd > 0 ? 1 : 2, qEnd: halfEnd + 900, tmw: halfEnd + 120,
        oobWindow: halfEnd > 0 ? 120 : 300 };
      const values = new Float64Array(n);
      const S = { t: 0, pos: 0, s: [0, 0], down: 1, ytg: 10, yl: 75, to: [3, 3], running: false, credit: 0,
        phase: SNAP, freeKick: false, stratActive: false, plays: 0 };
      const u = new Float64Array(8);
      let sum = 0;
      for (let r = 0; r < n; r++) {
        S.t = root.t; S.pos = root.pos; S.s[0] = root.score[0]; S.s[1] = root.score[1]; S.down = root.down;
        S.ytg = root.ytg; S.yl = root.yl; S.to[0] = root.to[0]; S.to[1] = root.to[1]; S.running = !!root.clock_running;
        S.credit = 0; S.phase = root.phase || SNAP; S.freeKick = false; S.stratActive = !!action.h1; S.plays = 0;
        for (let step = 0; step < maxSteps && S.phase !== DONE; step++) {
          for (let c = 0; c < 8; c++) u[c] = uni(seed, r, step, c);
          const act = step === 0 ? action : null;
          if (S.phase === PAT) this._pat(S, g, u, act);
          if (S.phase === KICKOFF) this._kickoff(S, g, u, act);
          if (S.phase === SNAP) this._snap(S, g, u, act, action, root.pos);
        }
        const v = this._value(S, g, persp);
        values[r] = v; sum += v;
      }
      let ss = 0;
      const mean = sum / n;
      for (let r = 0; r < n; r++) ss += (values[r] - mean) * (values[r] - mean);
      return { mean, se: Math.sqrt(ss / (n - 1) / n), values };
    }

    // ------------------------------------------------------------------ PAT ---
    _pat(S, g, u, act) {
      const o = S.pos, margin = S.s[o] - S.s[1 - o], tHalf = S.t - g.halfEnd;
      let go2 = g.half === 2 && tHalf <= 900 && TWO_PT_SET.has(margin);
      if (act && act.pat) go2 = act.pat === 'two';
      const p = go2 ? this.ctx.twoPt[o] : this.fgProb(33.0, o);
      if (u[3] < p) S.s[o] += go2 ? 2 : 1;
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
      const j = Math.floor(u[4] * K.start.length);
      let start = K.start[j];
      const dur = K.dur10[j] / 10;
      const retTd = K.retTd[j] && !onside;
      if (S.freeKick) start = clip(start - 8, 40, 75);
      const rec = onside && u[3] < this.onsideP;
      S.pos = rec ? kt : rt;
      S.yl = onside ? (rec ? 54 : 46) : start;
      S.t = Math.max(S.t - (onside ? 3 : dur), g.halfEnd);
      S.down = 1; S.ytg = Math.min(10, S.yl); S.running = false; S.credit = 0; S.freeKick = false; S.phase = SNAP;
      if (retTd) { S.s[S.pos] += 6; S.phase = PAT; }
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
      let kneelOk, defWants, offWants, attempt = true, runOut = false;
      if (half === 2) {
        kneelOk = (margin > 0 || (margin === 0 && yl >= 70 && tHalf <= 40)) &&
          this.kneelOutPossible(tHalf, down, defTo, runC, tmwPending);
        defWants = margin > 0 && (tHalf <= 240 || (margin >= 9 && tHalf <= 420));
        offWants = margin <= 0 && (tHalf <= 60 || (margin <= -9 && tHalf <= 120));
        offWants = offWants || (fgRange && fgHelps && tHalf <= 25);
      } else {
        attempt = (yl - 35.0) <= 0.6 * (tHalf + 20.0 * offTo);
        if (S.stratActive && S.pos !== rootPos) S.stratActive = false;
        if (S.stratActive) attempt = rootAction.h1 === 'attack';
        runOut = !attempt && tHalf <= 120;
        kneelOk = runOut && this.kneelOutPossible(tHalf, down, defTo, runC, tmwPending);
        defWants = runOut && !kneelOk && tHalf <= 100 && down >= 2;
        offWants = attempt && tHalf <= 30.0 + 15.0 * offTo && tHalf <= 75;
      }
      let defCall = runC && defWants && defTo > 0;
      let offCall = runC && !defCall && offWants && offTo > 0 && !kneelOk;
      if (act && act.to_def !== undefined) defCall = runC && defTo > 0 && !!act.to_def;
      if (act && act.to_off !== undefined) offCall = runC && !defCall && offTo > 0 && !!act.to_off;
      if (defCall) S.to[d] -= 1;
      if (offCall) S.to[o] -= 1;
      const called = defCall || offCall;
      if (called) S.t = Math.max(S.t - this.toReact, halfEnd);
      runC = runC && !called;

      // (2) tempo and between-snap runoff
      let hurry, urgent, milk;
      if (half === 2) {
        hurry = (margin < 0 && tHalf <= 300) || (margin <= -9 && tHalf <= 600) || (margin === 0 && yl <= 80 && tHalf <= 75);
        urgent = hurry && tHalf <= 120;
        milk = (margin > 0 && tHalf <= 600) || (margin === 0 && tHalf <= 240 && !hurry);
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
      if (forced !== undefined) { kneelNow = forced === 'kneel'; spikeNow = forced === 'spike' && runC; }
      // 4th down with the clock running and a kick that ties or wins: rush the field-goal unit on
      const fgUseful0 = half === 1 || (margin >= -3 && margin <= 0);
      let fire = runC && down === 4 && fgUseful0 && this.fgProb(yl + FG_SNAP_YARDS, o) >= 0.3 && tHalf <= 25;
      fire = fire && !kneelNow && !spikeNow;
      if (forced !== undefined) fire = runC && forced === 'fg';
      tempo = kneelNow ? T_KNEEL : spikeNow ? T_SPIKE : fire ? T_FIRE : tempo;
      let runoff;
      if (tempo === T_KNEEL) runoff = 38.0 + 2.0 * u[0];
      else if (tempo === T_FIRE) runoff = FIRE_DRILL[0] + (FIRE_DRILL[1] - FIRE_DRILL[0]) * u[0];
      else { const arr = this.e.tempo[tempo]; runoff = arr[Math.floor(u[0] * arr.length)]; }
      runoff = runC ? Math.max(runoff - S.credit, 0) : 0;
      if (act && act.runoff !== undefined) runoff = runC ? act.runoff : 0;
      const t0 = S.t;
      let t1 = t0 - runoff;
      const stop = t0 > g.tmw && t1 <= g.tmw;
      if (stop) t1 = g.tmw;
      const stopQ = t0 > g.qEnd && t1 <= g.qEnd;
      if (stopQ) t1 = g.qEnd;
      const runningAtSnap = runC && !stop && !stopQ;
      const ended = t1 <= halfEnd;
      S.t = Math.max(t1, halfEnd);
      S.credit = 0;
      if (ended) { S.phase = DONE; return; }
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
      if (kind === SPIKE && fgLast) kind = FG;
      if (fire) kind = FG;
      if (kind < 0 && down === 4) kind = this._fourthDown(S, g, o, margin, tHalf, pFg, u[5]);
      if (kind < 0 && runOut && down < 4) kind = RUN;
      if (forced !== undefined && forced !== 'kneel' && forced !== 'spike') kind = forced === 'go' ? -1 : PLAY[forced];
      if (kind < 0) {
        const fk = fineKey(gameMode(half, tHalf, margin), down, S.ytg, yl);
        const pr = this.e.lib.passRate[fk];
        const lg = Math.log(pr / (1 - pr)) + ctx.proe[o] / Math.max(pr * (1 - pr), 0.1);
        kind = u[1] < sigmoid(lg) ? PASS : RUN;
      }
      S.plays += 1;
      // (4) execute
      if (kind === FG) this._fieldGoal(S, g, u, o, fire);
      else if (kind === PUNT) this._punt(S, g, u, o);
      else this._scrimmage(S, g, u, o, kind, margin);
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
        if (late && margin >= -3 && margin <= 0 && pFg < 0.3) choice = -1;
      } else {
        if (tHalf <= 20 && pFg >= 0.2) choice = FG;
        if (tHalf <= 20 && pFg < 0.2 && choice === PUNT && yl < 60) choice = -1;
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

    _scrimmage(S, g, u, o, kind, margin) {
      const d = 1 - o, L = this.e.lib;
      const yl0 = S.yl, ytg0 = S.ytg, down0 = S.down;
      let yards = 0, penalty = false, autoFd = false, incomplete = false, oob = false, tdOff = false, tdDef = false,
        turnover = false, toRel = 0, safety = false, dur = 0;
      if (kind === RUN || kind === PASS) {
        const fk = fineKey(gameMode(g.half, S.t - g.halfEnd, margin), down0, ytg0, yl0);
        const row = this.sampleLib(o, kind === PASS ? 1 : 0, fk, u[2]);
        const f = L.flags[row];
        yards = L.yards[row]; penalty = !!(f & 1); autoFd = !!(f & 2); incomplete = !!(f & 4); oob = !!(f & 8);
        tdOff = !!(f & 16); tdDef = !!(f & 32); turnover = !!(f & 64); safety = !!(f & 128);
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
      tdOff = tdOff || (!turnover && !penalty && newYl <= 0);
      safety = safety || (!turnover && !tdOff && newYl >= 100);
      let toYl = 100 - (yl0 - toRel);
      tdDef = tdDef || (turnover && toYl <= 0);
      toYl = toYl >= 100 ? 80 : clip(toYl, 1, 99);
      const fd = yards >= ytg0 || autoFd;
      const newDown = fd ? 1 : (penalty ? down0 : down0 + 1);
      const newYtg = fd ? Math.min(10, Math.max(newYl, 1)) : ytg0 - yards;
      const onDowns = !fd && newDown > 4 && !turnover && !tdOff && !safety && !tdDef;
      const change = turnover || onDowns;
      const scorePlay = tdOff || tdDef || safety;
      const inWin = (S.t - g.halfEnd) <= g.oobWindow;
      const stop = incomplete || (oob && inWin) || (penalty && inWin) || change || scorePlay;
      const credit = oob ? this.oobCredit : (penalty ? this.penCredit : 0);
      this._clockAfterPlay(S, g, dur, stop, credit);
      if (!change && !scorePlay) { S.yl = clip(newYl, 1, 99); S.down = newDown; S.ytg = Math.max(newYtg, 1); }
      if (turnover && !tdDef) this._flip(S, toYl);
      if (onDowns) this._flip(S, 100 - clip(newYl, 1, 99));
      if (tdOff) { S.s[o] += 6; S.phase = PAT; }
      if (tdDef && !tdOff) { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      if (safety && !tdOff && !tdDef) { S.s[d] += 2; S.phase = KICKOFF; S.freeKick = true; }
      this._endHalfCheck(S, g);
    }

    _fieldGoal(S, g, u, o, fire) {
      const yl0 = S.yl;
      let p = this.fgProb(yl0 + FG_SNAP_YARDS, o);
      if (fire && p > 0) {
        const z = Math.log(clip(p, 1e-9, 1 - 1e-9) / clip(1 - p, 1e-9, 1)) + FIRE_DRILL_LOGIT;
        p = sigmoid(z);
      }
      const made = u[3] < p;
      this._clockAfterPlay(S, g, 5.0, true, 0);
      if (made) { S.s[o] += 3; S.phase = KICKOFF; } else this._flip(S, 100 - Math.max(yl0 + 8, 20));
      this._endHalfCheck(S, g);
    }

    _punt(S, g, u, o) {
      const d = 1 - o, P = this.e.punt, yl0 = S.yl;
      const yi = clip(Math.trunc(yl0), 0, 100);
      const lo = this.e.puntLo[yi], hi = this.e.puntHi[yi];
      const j = Math.min(lo + Math.floor(u[4] * (hi - lo)), hi - 1);
      let net = P.net[j];
      const normal = !P.blocked[j] && !P.retTd[j] && !P.touchback[j];
      if (normal) net += this.ctx.punterShift[o];
      const spot = yl0 - net;
      const recvYl = (P.touchback[j] || spot <= 0) ? 80 : clip(100 - spot, 1, 99);
      this._clockAfterPlay(S, g, P.dur[j], true, 0);
      if (!P.retTd[j]) this._flip(S, recvYl);
      else { S.s[d] += 6; S.pos = d; S.phase = PAT; }
      this._endHalfCheck(S, g);
    }

    _flip(S, newYl) {
      S.pos = 1 - S.pos; S.yl = newYl; S.down = 1; S.ytg = Math.min(10, newYl); S.running = false; S.credit = 0;
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
        vHome = hm > 0 ? 1 : hm < 0 ? 0 : this.ctx.otWpHome;
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
  NFLClockEngine.helpers = { fineKey, gameMode, zoneOf, ytgBucket, uni };
  if (typeof module !== 'undefined' && module.exports) module.exports = NFLClockEngine;
  else global.NFLClockEngine = NFLClockEngine;
})(typeof self !== 'undefined' ? self : this);
