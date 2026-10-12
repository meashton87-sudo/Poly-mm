/* Web Worker for the daily game: hosts the nflclock engine plus the call-level playbook.
 *   init  -> loads engine_data.json and playbook.json
 *   info  -> per-call facts for the current spot (NFL call mix, out-of-bounds rates, FG / conversion odds)
 *   eval  -> win probability of a list of options (same seed for all: common random numbers)
 *   step  -> plays one real snap / try / kickoff and returns the new state and a play-by-play log */
importScripts('engine.js');

let eng = null;
const sims = new Map();

function simFor(scen) {
  let s = sims.get(scen.id);
  if (!s) {
    s = eng.simulator(eng.makeContext(scen.game, { receive2h: scen.start.receive2h }));
    sims.set(scen.id, s);
    if (sims.size > 4) sims.delete(sims.keys().next().value);
  }
  return s;
}

const MODE_KILL = 2;
function gameMode(half, ht, m) {
  const hurry = (half === 1 && ht <= 120) || (half === 2 && ht <= 300 && m < 0) ||
    (half === 2 && ht <= 120 && m === 0) || (half === 2 && ht <= 600 && m <= -9);
  return hurry ? 1 : (half === 2 && ht <= 360 && m > 0) ? MODE_KILL : 0;
}
const countBelow = (edges, v) => { let i = 0; while (i < edges.length && edges[i] < v) i++; return i; };
const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function fineKey(mode, down, ytg, yl) {
  const zone = countBelow([3, 9, 20, 39, 59, 79, 99], clip(yl, 1, 99));
  const yb = countBelow([2, 5, 10, 99], clip(ytg, 1, 99));
  const db = clip(Math.trunc(down), 1, 3) - 1;
  return ((mode * 3 + db) * 4 + yb) * 7 + zone;
}

function info(sim, root) {
  const P = eng.pb, o = root.pos, half = root.t > 1800 ? 1 : 2, tHalf = root.t - (half === 1 ? 1800 : 0);
  const margin = root.score[o] - root.score[1 - o];
  const fk = fineKey(gameMode(half, tHalf, margin), root.down, root.ytg, root.yl);
  // per-call odds for this offense against this defense: the same tilted weights the plays are drawn with
  const cdf = sim.pbCdf[o].cdf;
  const calls = P.calls.map((c, ci) => {
    const pool = P.poolOf[ci * P.nFine + fk], lo = P.offsets[pool], hi = P.offsets[pool + 1];
    let n = 0, w = 0, yds = 0, oob = 0, conv = 0, inc = 0, prev = pool;
    for (let i = lo; i < hi; i++) {
      const r = P.items[i], f = P.flags[r], wi = cdf[i] - prev;
      prev = cdf[i];
      if (f & 1) continue;   // penalties
      n++; w += wi; yds += wi * P.yards[r]; if (f & 8) oob += wi; if (f & 4) inc += wi;
      if (P.yards[r] >= root.ytg || (f & 16)) conv += wi;
    }
    const pOob = w ? oob / w : 0, odds = P.oobOdds[ci];
    const pTry = pOob > 0 ? (pOob * odds) / (pOob * odds + 1 - pOob) : 0;
    return { id: c.id, freq: P.freq[fk * P.calls.length + ci], avg: w ? yds / w : 0, oob: pOob, oobTry: pTry,
      conv: w ? conv / w : 0, inc: w ? inc / w : 0, n };
  });
  const fi = sim.fourthInfo(root);
  return { calls, fgDist: fi.fgDist, pFg: fi.pFg, pConv: fi.pConv };
}

// what happened on the real play behind an outcome: event, penalty called, and the pre-snap look
function describe(row) {
  const P = eng.pb, out = {};
  if (P.event) out.evt = P.eventNames[P.event[row]] || '';
  if (P.pen && P.pen[row]) out.pen = P.penNames[P.pen[row]];
  if (P.look) {
    const k = P.look[row];
    out.look = { form: ['', 'shotgun', 'under center', 'pistol'][k & 3], motion: !!(k & 4), blitz: !!(k & 8), box: k >> 4 };
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const [d, pb] = await Promise.all([
        fetch('engine_data.json').then((r) => { if (!r.ok) throw new Error('engine data ' + r.status); return r.json(); }),
        fetch('playbook.json').then((r) => { if (!r.ok) throw new Error('playbook ' + r.status); return r.json(); }),
      ]);
      eng = new NFLClockEngine(d);
      eng.loadPlaybook(pb);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'info') {
      self.postMessage({ type: 'info', id: m.id, info: info(simFor(m.scen), m.root) });
    } else if (m.type === 'eval') {
      const sim = simFor(m.scen);
      const out = m.options.map((o) => {
        const r = sim.run(m.root, { n: m.n, action: o.action, perspective: m.persp, seed: m.seed });
        return { key: o.key, mean: r.mean, values: r.values };
      });
      self.postMessage({ type: 'eval', id: m.id, out }, out.map((o) => o.values.buffer));
    } else if (m.type === 'step') {
      const r = simFor(m.scen).step(m.root, { action: m.action, seed: m.seed });
      r.log.forEach((e) => { if (e.ev === 'play' && e.row >= 0) Object.assign(e, describe(e.row)); });
      self.postMessage({ type: 'step', id: m.id, res: r });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
};
