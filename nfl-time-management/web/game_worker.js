/* Web Worker for the daily game: hosts the nflclock engine plus the call-level playbook.
 *   init  -> loads engine_data.json and playbook.json
 *   info  -> per-call facts for the current spot (NFL call mix, out-of-bounds rates, FG / conversion odds,
 *            the usual tempo and seconds between snaps by tempo)
 *   eval  -> win probability of a list of options (same seed for all: common random numbers), with its standard error
 *   step  -> plays one real snap / try / kickoff and returns the new state and a play-by-play log */
// each file's stamp (site.py: what is in it) rides in the worker's address, one parameter a file (game.js workerUrl):
// these addresses are cached for good, so every one carries its own
const STAMP = new URLSearchParams(self.location.search);
const at = (f) => (STAMP.get(f) ? `${f}?v=${encodeURIComponent(STAMP.get(f))}` : f);
importScripts(at('engine.js'));
importScripts(at('vs_core.js'));    // a full defensive call, shown as called (VSCore.called); the packed data's unpack

let eng = null, lastInfo = null;
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
  // the matchup chart (engine.js MATCH), for the defense that adapts to your calls (game.js adaptLooks)
  const match = {};
  P.calls.forEach((c, i) => { match[c.id] = P.match[i]; });
  return { calls, match, fgDist: fi.fgDist, pFg: fi.pFg, pConv: fi.pConv, tempo: sim.defaultTempo(root), tempoSecs: sim.tempoSeconds(),
    looks: lookByCall ? looks.map((x) => x / lt) : null, lookByCall, dshare: sim.dcShares(fk) };
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
      // the page fetches the data once and hands each worker its own copy (bytes); on its own, a worker fetches it.
      // Packed (scripts/site.py pack, gunzipped by the page): VSCore.unpack, the engine's first (the playbook's refers to it)
      const get = (buf, url, what, ref) => (buf ? Promise.resolve(m.packed ? VSCore.unpack(buf, ref) : JSON.parse(new TextDecoder().decode(buf)))
        : fetch(url).then((r) => { if (!r.ok) throw new Error(what + ' ' + r.status); return r.json(); }));
      const pbGet = m.playbook ? null : get(null, at('playbook.json'), 'playbook');        // (fetched alongside the engine's)
      const d = await get(m.engine, at('engine_data.json'), 'engine data');
      const pb = await (pbGet || get(m.playbook, at('playbook.json'), 'playbook', d));
      eng = new NFLClockEngine(d);
      eng.loadPlaybook(pb);
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'info') {
      // the last answer is kept: the page asks for the first call's facts while the intro is up (game.js renderIntro),
      // so the same question from the huddle is answered at once
      const key = m.scen.id + JSON.stringify(m.root);
      if (!lastInfo || lastInfo.key !== key) lastInfo = { key, info: info(simFor(m.scen), m.root) };
      self.postMessage({ type: 'info', id: m.id, info: lastInfo.info });
    } else if (m.type === 'eval') {
      const sim = simFor(m.scen);
      const out = m.options.map((o) => {
        const r = sim.run(m.root, { n: m.n, action: o.action, perspective: m.persp, seed: m.seed });
        return { key: o.key, mean: r.mean, se: r.se, values: r.values };
      });
      self.postMessage({ type: 'eval', id: m.id, out }, out.map((o) => o.values.buffer));
    } else if (m.type === 'odds') {         // each pick's odds here (a receiver's route): caught, yards a throw, picks
      const sim = simFor(m.scen), r = m.root, half = r.t > 1800 ? 1 : 2, ht = r.t - (half === 1 ? 1800 : 0);
      const fk = fineKey(gameMode(half, ht, r.score[r.pos] - r.score[1 - r.pos]), r.down, r.ytg, r.yl);
      const out = m.picks.map((q) => sim.routeOdds(r.pos, eng.pb.callIndex[q.call], fk, q.looks || 0, q.route, q.who, r.yl));
      self.postMessage({ type: 'odds', id: m.id, out });
    } else if (m.type === 'step') {
      const r = simFor(m.scen).step(m.root, { action: m.action, seed: m.seed });
      r.log.forEach((e) => {
        if (e.ev === 'play' && e.row >= 0) Object.assign(e, describe(e.row));
        if (e.ev === 'play' && m.action && m.action.dc) VSCore.called(e, m.action.dc);
      });
      self.postMessage({ type: 'step', id: m.id, res: r });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
};
