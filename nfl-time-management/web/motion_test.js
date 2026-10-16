// Player motion checks (motion.js): every planned path and every steering behavior stays inside the envelope
// measured from tracking, timed arrivals arrive on time, catches are made at the depth of the throw, man coverage
// never crosses the line, and a go route matches the tracking (about 19 yards downfield 3.5 s after the snap).
//   node web/motion_test.js
const M = require('./motion.js');

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } };
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const groups = Object.keys(M.ENV);

// 1) planned paths: speed never above the group's sprint speed at that effort; timed arrivals hit their time
for (let n = 0; n < 400; n++) {
  const g = groups[n % groups.length], E = M.ENV[g];
  const pts = [[rnd() * 50, rnd() * 50]];
  const k = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < k; i++) pts.push([pts[i][0] + (rnd() - 0.5) * 20, pts[i][1] + (rnd() - 0.2) * 20]);
  const eff = 0.5 + rnd() * 0.5, v0 = rnd() * 4;
  const p = M.planPath(pts, g, { eff, v0 });
  let vmax = 0;
  for (let t = 0; t <= p.T; t += 0.02) { const q = p.at(t); vmax = Math.max(vmax, Math.hypot(q[2], q[3])); if (!Number.isFinite(q[0] + q[1])) check(false, `NaN on a ${g} path`); }
  check(vmax <= E.top * eff + 0.05 || vmax <= v0 + 0.05, `${g} path at effort ${eff.toFixed(2)}: ${vmax.toFixed(2)} yd/s > ${(E.top * eff).toFixed(2)}`);
  const T = p.T * (1.1 + rnd());
  const q = M.planPath(pts, g, { T, v0 });
  // (on time; or early only where he comes in too fast to slow down in the path's length: nobody brakes harder)
  const len = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const cantSlow = v0 * v0 / (2 * E.brake) > len * 0.5;
  check((Math.abs(q.T - T) < 0.06 || (cantSlow && q.T < T)) && q.late === 0, `${g} timed path: ${q.T.toFixed(2)} s for ${T.toFixed(2)} s`);
  const z = q.at(q.T + 1);
  check(Math.hypot(z[0] - pts[pts.length - 1][0], z[1] - pts[pts.length - 1][1]) < 1e-6, `${g} path does not end at its last point`);
}

// 2) routes: the catch is made at the depth of the throw, on the receiver's side of the field when he breaks out
['go', 'post', 'corner', 'slant', 'wheel'].forEach((r) => {
  [6, 12, 20, 30].forEach((D) => {
    const f = M.routeOnField(r, D, 40, 1, 1, 50, 1, 0.5), stem = { post: Math.min(Math.max(D * 0.55, 8), 13) + 1.5,
      corner: Math.min(Math.max(D * 0.55, 8), 12) + 1.5, slant: 3, wheel: 4 }[r] ?? -99;
    const want = Math.max(D, stem), got = f.catchAt[1] - 50;
    check(Math.abs(got - want) < 0.05, `${r} at ${D}: caught ${got.toFixed(1)} deep, wanted ${want.toFixed(1)}`);
  });
});
check(M.routeOnField('out', 4, 40, 1, 1, 50, 1, 0.5).catchAt[0] > 40, 'an out route breaks to the outside');
check(M.routeOnField('in', 12, 40, 1, 1, 50, 1, 0.5).catchAt[0] < 40, 'a dig breaks to the inside');

// 3) steering: chase, go, mirror, track and stick legs never exceed the envelope, nothing goes NaN
for (let n = 0; n < 60; n++) {
  const W = new M.World();
  const runner = W.add({ g: 'WR', x: 10 + rnd() * 30, y: 40 });
  W.leg(runner, 0.2, 'path', { plan: M.planPath([[runner.x, 40], [runner.x + (rnd() - 0.5) * 20, 60], [runner.x + (rnd() - 0.5) * 30, 80]], 'WR', { eff: 0.9 }) });
  const others = groups.map((g, i) => {
    const b = W.add({ g, x: rnd() * 53, y: 40 + rnd() * 20 });
    const kind = ['chase', 'go', 'mirror', 'track', 'stick'][(n + i) % 5];
    if (kind === 'chase') W.leg(b, 0.3, 'chase', { who: runner, gap: rnd() * 2, eff: 0.7 + rnd() * 0.3 });
    else if (kind === 'go') W.leg(b, 0.3, 'go', { x: rnd() * 53, y: 40 + rnd() * 40, eff: 0.6 + rnd() * 0.4 });
    else if (kind === 'mirror') W.leg(b, 0.3, 'mirror', { who: runner, lag: 0.3, dir: 1, los: 41, floor: 0.8, y0: b.y, pedal: 1.5, cush: 1.4, dx0: b.x - runner.x, dx: 0.7, tau: 1 });
    else if (kind === 'track') W.leg(b, 0.3, 'track', { fn: (t) => [20 + 5 * Math.sin(t), 45 + t], eff: 0.9 });
    else { W.leg(b, 0.3, 'chase', { who: runner, eff: 1 }); W.leg(b, 3, 'stick', { who: runner, dx: 0.7, dy: -0.7 }); }
    return { b, kind };
  });
  W.run(6);
  others.forEach(({ b, kind }) => {
    let vmax = 0;
    for (let i = 1; i < b.hx.length; i++) {
      if (!Number.isFinite(b.hx[i] + b.hy[i])) { check(false, `NaN in a ${kind} leg`); break; }
      vmax = Math.max(vmax, Math.hypot(b.hx[i] - b.hx[i - 1], b.hy[i] - b.hy[i - 1]) / W.dt);
    }
    check(vmax <= M.ENV[b.g].top * 1.04 + 0.1, `${b.g} ${kind}: ${vmax.toFixed(2)} yd/s`);
    if (kind === 'mirror') check(Math.min(...b.hy) >= 41 + 0.8 - 0.6 || b.hy[0] < 41.8, `${b.g} in man coverage crossed the line`);
  });
}

// 4) calibration: a go route at route speed after the release (tracking: 19.4 yards deep at 3.5 s)
const go = M.planPath([[0, -1], [0.7, 3], [1.1, 40]], 'WR', { eff: 0.9 });
const d35 = go.at(3.5 - 0.18)[1];
check(d35 > 17 && d35 < 23, `go route ${d35.toFixed(1)} yards deep at 3.5 s (tracking 19.4)`);
console.log(`go route: ${d35.toFixed(1)} yards past the line 3.5 s after the snap (tracking 19.4)`);

console.log(fails ? `${fails} FAILED` : 'motion ok');
process.exit(fails ? 1 : 0);
