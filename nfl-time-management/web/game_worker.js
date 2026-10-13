/* Web Worker for the daily game: hosts the nflclock engine plus the call-level playbook.
 *   init  -> loads engine_data.json and playbook.json
 *   info  -> per-call facts for the current spot (NFL call mix, out-of-bounds rates, FG / conversion odds,
 *            the usual tempo and seconds between snaps by tempo)
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
  // the defense's looks here (light or loaded box, blitz or not), over all calls as often as play-callers make them,
  // and each call's own mix (how often it meets each look)
  const lookByCall = !P.lookB ? null : P.calls.map((c, ci) => {
    const pool = P.poolOf[ci * P.nFine + fk], lo = P.offsets[pool], hi = P.offsets[pool + 1], d = [0, 0, 0, 0];
    let n = 0;
    for (let i = lo; i < hi; i++) { const b = P.lookB[P.items[i]]; if (b < 4) { d[b]++; n++; } }
    return d.map((x) => (n ? x / n : 0.25));
  });
  const looks = [0, 0, 0, 0];
  if (lookByCall) lookByCall.forEach((d, ci) => d.forEach((x, b) => { looks[b] += P.freq[fk * P.calls.length + ci] * x; }));
  const lt = looks.reduce((a, x) => a + x, 0) || 1;
  const fi = sim.fourthInfo(root);
  return { calls, fgDist: fi.fgDist, pFg: fi.pFg, pConv: fi.pConv, tempo: sim.defaultTempo(root), tempoSecs: sim.tempoSeconds(),
    looks: lookByCall ? looks.map((x) => x / lt) : null, lookByCall };
}

// what happened on the real play behind an outcome: event, penalty called, the pre-snap look, and for the
// animation the air yards, who had the ball and whether he broke a tackle
function describe(row) {
  const P = eng.pb, out = {};
  if (P.event) out.evt = P.eventNames[P.event[row]] || '';
  if (P.pen && P.pen[row]) out.pen = P.penNames[P.pen[row]];
  if (P.look) {
    const k = P.look[row];
    out.look = { form: ['', 'shotgun', 'under center', 'pistol'][k & 3], motion: !!(k & 4), blitz: !!(k & 8), box: k >> 4 };
  }
  if (P.air && P.air[row] !== -128) out.air = P.air[row];
  if (P.carry) { const c = P.carry[row]; out.who = ['', 'QB', 'RB', 'WR', 'TE'][c & 7] || ''; out.bt = !!(c & 8); }
  if (P.ngs) {        // Next Gen Stats charting: the target's route, the coverage, the rush, the time to throw
    const g = P.ngs, rt = g.route[row], cv = g.cover[row], ru = g.rush[row], tt = g.ttt[row];
    if (rt) out.route = P.routeNames[rt];
    if (cv & 15) out.shell = P.shellNames[cv & 15];
    if (cv >> 4) out.man = (cv >> 4) === 1;
    if (ru & 32) { out.rushers = ru & 15; out.pressure = !!(ru & 16); }
    if (tt) out.ttt = tt / 10;
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
