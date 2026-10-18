// The engine's simulator for the match server, built lazily. engine.js's Simulator tilts every play pool of the
// library and the playbook toward the two teams up front: about 50 MB of tables for one match, too much for a Worker
// (128 MB for everything). Each pool's tables depend on that pool alone, so here they are made the first time a pool
// is drawn from, with the same arithmetic in the same order (lazy_sim_test.mjs checks every value against the
// engine's own). A match draws from a few dozen pools.
//
//   const sim = lazySimulator(eng, eng.makeContext(game, {receive2h}));   // in place of eng.simulator(ctx)
const RUN = 0, PASS = 1;                                     // engine.js
const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// an array of `length` read by index, made pool by pool (offsets: each pool's first index) on the first read
function lazyArray(offsets, length, make) {
  const cache = new Map(), nP = offsets.length - 1;
  let lastLo = 0, lastHi = 0, lastArr = null;
  const at = (i) => {
    if (i >= lastLo && i < lastHi) return lastArr[i - lastLo];
    let lo = 0, hi = nP - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= i) lo = mid; else hi = mid - 1; }
    let arr = cache.get(lo);
    if (!arr) { arr = make(lo); cache.set(lo, arr); }
    lastLo = offsets[lo]; lastHi = offsets[lo + 1]; lastArr = arr;
    return arr[i - lastLo];
  };
  return new Proxy({}, {
    get(t, k) {
      if (typeof k === 'string') {
        const c = k.charCodeAt(0);
        if (c >= 48 && c <= 57) { const i = +k; return i >= 0 && i < length ? at(i) : undefined; }
        if (k === 'length') return length;
      }
      return undefined;
    },
    has(t, k) { return typeof k === 'string' && +k >= 0 && +k < length; },
  });
}

export function lazySimulator(eng, ctx) {
  const Sim = eng.constructor.Simulator;
  const sim = Object.create(Sim.prototype);
  sim.e = eng; sim.ctx = ctx;
  const L = eng.lib, e = eng.itemEpa, off = L.offsets;
  // the library: engine.js tilt(), one pool
  const libPools = [new Map(), new Map()];
  const libPool = (team, p) => {
    let x = libPools[team].get(p);
    if (x) return x;
    const lo = off[p], hi = off[p + 1], n = hi - lo, dRun = ctx.delta[team][RUN], dPass = ctx.delta[team][PASS];
    let s = 0; for (let i = lo; i < hi; i++) s += e[i];
    const base = s / (hi - lo), target = base + (L.poolKind[p] === PASS ? dPass : dRun);
    let theta = 0;
    const w = new Float64Array(n);
    const weights = () => {
      let mx = -Infinity;
      for (let i = lo; i < hi; i++) { const z = theta * e[i]; if (z > mx) mx = z; }
      for (let i = lo; i < hi; i++) w[i - lo] = Math.exp(theta * e[i] - mx);
    };
    for (let it = 0; it < 4; it++) {
      weights();
      let sw = 0, m1 = 0, m2 = 0;
      for (let i = lo; i < hi; i++) { const wi = w[i - lo]; sw += wi; m1 += wi * e[i]; m2 += wi * e[i] * e[i]; }
      m1 /= sw; m2 /= sw;
      const v = Math.max(m2 - m1 * m1, 1e-6);
      theta = clip(theta + (target - m1) / v, -1.5, 1.5);
    }
    weights();
    const prob = new Float64Array(n), cdf = new Float64Array(n);
    let sw = 0; for (let i = 0; i < n; i++) sw += w[i];
    let cum = 0;
    for (let i = 0; i < n; i++) { prob[i] = w[i] / sw; cum += prob[i]; cdf[i] = p + Math.min(cum, 1 - 1e-12); }
    x = { prob, cdf };
    libPools[team].set(p, x);
    return x;
  };
  const nLib = L.items.length;
  sim.cdf = [0, 1].map((team) => lazyArray(off, nLib, (p) => libPool(team, p).cdf));
  const probOf = (team) => lazyArray(off, nLib, (p) => libPool(team, p).prob);
  // the clock-stopping plays: engine.js subsetCdf(), one pool
  sim.stopCdf = [0, 1].map((team) => lazyArray(eng.stopOff, eng.stopPos.length, (p) => {
    const pos = eng.stopPos, so = eng.stopOff, prob = libPool(team, p).prob, lo = off[p];
    const cdf = new Float64Array(so[p + 1] - so[p]);
    let tot = 0;
    for (let j = so[p]; j < so[p + 1]; j++) tot += prob[pos[j] - lo];
    let cum = 0;
    for (let j = so[p]; j < so[p + 1]; j++) { cum += prob[pos[j] - lo]; cdf[j - so[p]] = p + Math.min(cum / Math.max(tot, 1e-300), 1 - 1e-12); }
    return cdf;
  }));
  // the conversion table: the engine's own, over the pools it reads
  sim.conv = [0, 1].map((team) => eng.conversionTable(probOf(team), ctx.proe[team] / 0.24));
  // the playbook: engine.js pbTilt(), one pool
  if (eng.pb) {
    const P = eng.pb, po = P.offsets, pe = P.itemEpa, nPb = pe.length;
    sim.pbCdf = [0, 1].map((team) => {
      const delta = ctx.pbDelta ? ctx.pbDelta[team] : null, pools = new Map();
      const pool = (p) => {
        let x = pools.get(p);
        if (x) return x;
        const c = P.poolCall[p], lo = po[p], hi = po[p + 1], n = hi - lo;
        let base = 0; for (let i = lo; i < hi; i++) base += pe[i];
        base /= Math.max(hi - lo, 1);
        const target = base + (P.shift ? P.shift[p] : 0) + (delta ? delta[c] : 0);
        let th = 0;
        for (let it = 0; it < 4; it++) {
          let mx = -Infinity; for (let i = lo; i < hi; i++) mx = Math.max(mx, th * pe[i]);
          let sw = 0, m1 = 0, m2 = 0;
          for (let i = lo; i < hi; i++) { const w = Math.exp(th * pe[i] - mx); sw += w; m1 += w * pe[i]; m2 += w * pe[i] * pe[i]; }
          m1 /= sw; m2 /= sw;
          th = clip(th + (target - m1) / Math.max(m2 - m1 * m1, 1e-6), -1.5, 1.5);
        }
        let mx = -Infinity; for (let i = lo; i < hi; i++) mx = Math.max(mx, th * pe[i]);
        let sw = 0, swo = 0, swi = 0;
        const odds = P.oobOdds[c], stay = P.stayOdds ? P.stayOdds[c] : 1;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * pe[i] - mx), out = P.flags[P.items[i]] & 8;
          sw += w; swo += out ? w * odds : w; swi += out ? w * stay : w;
        }
        const cdf = new Float64Array(n), cdfOob = new Float64Array(n), cdfIn = new Float64Array(n);
        let cum = 0, cumo = 0, cumi = 0;
        for (let i = lo; i < hi; i++) {
          const w = Math.exp(th * pe[i] - mx), out = P.flags[P.items[i]] & 8;
          cum += w / sw; cumo += (out ? w * odds : w) / swo; cumi += (out ? w * stay : w) / swi;
          cdf[i - lo] = p + Math.min(cum, 1 - 1e-12); cdfOob[i - lo] = p + Math.min(cumo, 1 - 1e-12); cdfIn[i - lo] = p + Math.min(cumi, 1 - 1e-12);
        }
        x = { cdf, cdfOob, cdfIn };
        pools.set(p, x);
        return x;
      };
      return { cdf: lazyArray(po, nPb, (p) => pool(p).cdf), cdfOob: lazyArray(po, nPb, (p) => pool(p).cdfOob), cdfIn: lazyArray(po, nPb, (p) => pool(p).cdfIn) };
    });
  }
  const c = eng.consts;
  sim.kneelDur = c.kneel_duration; sim.spikeDur = c.spike_duration; sim.toReact = c.timeout_reaction;
  sim.oobCredit = c.oob_restart_credit; sim.penCredit = c.penalty_restart_credit;
  sim.onsideP = Math.max(c.onside, 0.05);
  sim.x = new Float64Array(13);
  sim._rules(ctx);
  return sim;
}
