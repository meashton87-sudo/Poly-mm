/* Player motion for the Two-Minute Drill animation, calibrated from NFL player tracking.
 *
 * Every player moves inside the envelope real players move in. The constants below were measured from tracking
 * at 10 Hz: every snap of the 2017 Big Data Bowl sample game and 529 Next Gen Stats highlight plays
 * (2017-2019). They give, per position group, the sprint speed (90th percentile of a player's top speed on a
 * play), how hard players speed up at each speed (97th percentile: about a0 - k * speed), how hard they brake,
 * and how hard they can turn (lateral acceleration). A receiver at 8 yards a second cannot cut 90 degrees: he
 * has to slow to 3 or 4 first, like a real one at the top of his route.
 *
 * Two kinds of motion:
 *  - planned paths (planPath): a polyline with its corners rounded to the radius a player can hold at speed,
 *    then the fastest speed profile the envelope allows (or the one that arrives exactly at a set time, by
 *    effort). Used for whoever the outcome depends on: the passer, the target, the ball carrier, the tackler.
 *  - steering (World): everyone else chases, mirrors, drops into zones, blocks and rushes, one 1/20 s step at a
 *    time, with the same envelope limiting every change of velocity.
 * The constants regenerate with scripts/motion_envelope.py and scripts/motion_curves.py.
 * Coordinates are yards: x across the field (as drawn), y along it. Works in the browser (window.Motion) and in
 * node (module.exports) for tests.
 */
(function (root, factory) {
  const M = factory();
  // (both, always: a page with a global `module` from some other script, iPhones on Oct 19, never got window.Motion)
  if (typeof module === 'object' && module && module.exports) module.exports = M;
  if (root) root.Motion = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // top: sprint speed (yd/s); a0, k: hardest speed-up at speed v is a0 - k v (yd/s^2); brake, lat (yd/s^2)
  const ENV = {
    WR: { top: 9.66, a0: 8.11, k: 0.728, brake: 4.35, lat: 5.32 },
    CB: { top: 9.62, a0: 6.48, k: 0.528, brake: 4.23, lat: 4.95 },
    RB: { top: 9.51, a0: 6.85, k: 0.597, brake: 3.91, lat: 4.81 },
    S: { top: 9.30, a0: 6.59, k: 0.558, brake: 4.38, lat: 5.09 },
    LB: { top: 8.63, a0: 6.29, k: 0.562, brake: 3.69, lat: 4.64 },
    TE: { top: 8.56, a0: 6.51, k: 0.597, brake: 3.59, lat: 4.59 },
    QB: { top: 7.83, a0: 5.16, k: 0.430, brake: 2.45, lat: 4.65 },
    DL: { top: 6.98, a0: 4.79, k: 0.384, brake: 2.80, lat: 3.95 },
    OL: { top: 6.32, a0: 3.51, k: 0.260, brake: 2.00, lat: 2.74 },
  };
  const DT = 0.05;

  const clip = (v, a, b) => Math.max(a, Math.min(b, v));
  const hyp = Math.hypot;

  // the envelope of one player: his group's, his speed scaled by `spd` (1 = typical), all of it by effort
  function envOf(g, spd, eff) {
    const E = ENV[g] || ENV.LB, e = clip(eff == null ? 1 : eff, 0.05, 1), s = spd || 1;
    return { top: E.top * s * e, a0: E.a0 * s * Math.sqrt(e), k: E.k, brake: E.brake, lat: E.lat };
  }
  const fwdAcc = (en, v) => Math.max(0.4, en.a0 - en.k * v);

  // ------------------------------------------------------------ planned paths ---
  // Round each corner with the radius a player can hold through it. A shallow bend is run at full speed (a
  // radius of about 18 yards: top speed over the lateral acceleration players hold); a sharp cut (45 degrees or
  // more, a route break) is a plant and cut through about 2.3 yards of path either side of the corner, tight and
  // slow. Cuts sharper than 150 degrees (a hitch, a comeback) stop and turn. Waypoints closer than 0.3 yards are
  // merged.
  const R_FULL = 18;
  function smooth(raw) {
    const pts = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const q = pts[pts.length - 1];
      if (hyp(raw[i][0] - q[0], raw[i][1] - q[1]) >= 0.3 || i === raw.length - 1) pts.push(raw[i]);
    }
    if (pts.length > 2 && hyp(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) < 0.3) pts.splice(pts.length - 2, 1);
    const out = [pts[0].slice()];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const ax = p[0] - a[0], ay = p[1] - a[1], bx = b[0] - p[0], by = b[1] - p[1];
      const la = hyp(ax, ay), lb = hyp(bx, by);
      if (la < 1e-6 || lb < 1e-6) continue;
      const cos = clip((ax * bx + ay * by) / (la * lb), -1, 1), th = Math.acos(cos);
      if (th < 0.005) { out.push(p.slice()); continue; }
      if (th > 2.6) { out.push([p[0], p[1], 'stop']); continue; }
      const wide = R_FULL * Math.tan(th / 2), w = clip((0.8 - th) / 0.5, 0, 1);
      const tl = Math.min(la * 0.45, lb * 0.45, 2.3 + (Math.max(wide, 2.3) - 2.3) * w), r = tl / Math.tan(th / 2);
      const s0 = [p[0] - (ax / la) * tl, p[1] - (ay / la) * tl];
      // the arc from s0 to s1, tangent to both legs, sampled every 0.3 yards
      const cross = ax * by - ay * bx, side = cross > 0 ? 1 : -1;
      const nx = (-ay / la) * side, ny = (ax / la) * side;
      const cx = s0[0] + nx * r, cy = s0[1] + ny * r;
      const a0 = Math.atan2(s0[1] - cy, s0[0] - cx);
      const n = Math.max(2, Math.ceil((r * th) / 0.3));
      for (let j = 0; j <= n; j++) {
        const ang = a0 + side * th * (j / n);
        out.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  // Resample at ds and give each sample the fastest speed the turn there allows (sqrt(lat * radius)).
  function resample(pts, ds, en) {
    const P = [], stop = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], L = hyp(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / ds));
      for (let j = 0; j < n; j++) { P.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]); stop.push(j === 0 && a[2] === 'stop'); }
    }
    const z = pts[pts.length - 1];
    P.push([z[0], z[1]]); stop.push(false);
    const n = P.length, s = new Float64Array(n), vlim = new Float64Array(n).fill(en.top);
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    for (let i = 1; i < n - 1; i++) {
      const j0 = Math.max(0, i - 4), j1 = Math.min(n - 1, i + 4);
      const ax = P[i][0] - P[j0][0], ay = P[i][1] - P[j0][1], bx = P[j1][0] - P[i][0], by = P[j1][1] - P[i][1];
      const la = hyp(ax, ay), lb = hyp(bx, by);
      if (la > 1e-6 && lb > 1e-6) {
        const th = Math.acos(clip((ax * bx + ay * by) / (la * lb), -1, 1));
        if (th > 1e-3) vlim[i] = Math.min(vlim[i], Math.sqrt(en.lat * ((la + lb) / 2) / th));
      }
      if (stop[i]) vlim[i] = 0.4;
    }
    return { P, s, vlim };
  }

  // The fastest speed profile under the envelope (forward pass: speeding up; backward pass: braking), from speed
  // v0 at the start to at most v1 at the end; returns the samples with their times. He comes in at v0 whatever this
  // path's effort, and no faster than he can brake does he slow: a path that asks more (a stop he can't make in its
  // length, a top speed under the one he has) is run as fast as that allows (past the end, he coasts: World.step).
  // A path that must stop at its end (v1 = 0: a ball carrier at the spot, a man at the sideline) may stop harder than a
  // player brakes by choice, up to STOP_HARD: he plants, or he is driven down (a tackle is a collision), never slides past.
  const STOP_HARD = 9;
  function profile(R, en, v0, v1) {
    const n = R.P.length, v = new Float64Array(n), floorBrake = v1 === 0 ? Math.max(en.brake, STOP_HARD) : en.brake;
    v[0] = v0;
    const slowest = (i) => Math.sqrt(Math.max(0, v[i - 1] * v[i - 1] - 2 * floorBrake * (R.s[i] - R.s[i - 1])));
    for (let i = 1; i < n; i++) {
      const ds = R.s[i] - R.s[i - 1];
      v[i] = Math.min(R.vlim[i], Math.max(slowest(i), Math.min(en.top, Math.sqrt(v[i - 1] * v[i - 1] + 2 * fwdAcc(en, v[i - 1]) * ds))));
    }
    if (v1 != null) v[n - 1] = Math.min(v[n - 1], v1);
    for (let i = n - 2; i >= 1; i--) {
      const ds = R.s[i + 1] - R.s[i];
      v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * en.brake * 0.85 * ds));
    }
    for (let i = 1; i < n; i++) v[i] = Math.max(v[i], slowest(i));
    const t = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const ds = R.s[i] - R.s[i - 1], vm = (v[i] + v[i - 1]) / 2;
      t[i] = t[i - 1] + (vm > 0.05 ? ds / vm : Math.sqrt((2 * ds) / Math.max(0.5, fwdAcc(en, 0))));
    }
    return { v, t, T: t[n - 1] };
  }

  // A planned path through `pts` ([[x, y], ...]) for a player of group g. opts: v0 (speed at the start), v1 (cap at
  // the end, 0 = stop there), T (arrive at this time: the effort is lowered until he does; if he cannot make it
  // even flat out, he is late by plan.late), spd (his speed relative to his group), eff (effort cap).
  function planPath(pts, g, opts) {
    const o = opts || {};
    const sm = smooth(pts.map((p) => p.slice()));
    const build = (eff) => {
      const en = envOf(g, o.spd, eff), R = resample(sm, 0.1, en);
      return { R, pr: profile(R, en, o.v0 || 0, o.v1) };
    };
    const effMax = o.eff == null ? 1 : o.eff;
    let best = build(effMax), eff = effMax;
    if (o.T != null && best.pr.T < o.T) {
      let lo = 0.12, hi = effMax;
      for (let it = 0; it < 18; it++) {
        const mid = (lo + hi) / 2, b = build(mid);
        if (b.pr.T > o.T) lo = mid; else { hi = mid; best = b; eff = mid; }
      }
    }
    const { R, pr } = best;
    const plan = { T: pr.T, eff, stop: o.v1 === 0, late: o.T != null ? Math.max(0, pr.T - o.T) : 0, end: R.P[R.P.length - 1].slice(),
      vEnd: pr.v[pr.v.length - 1] };
    // position and velocity at time t after the start (held at the end once there)
    plan.at = (t) => {
      const tt = pr.t;
      if (t <= 0) return [R.P[0][0], R.P[0][1], 0, 0];
      if (t >= pr.T) {
        const n = R.P.length - 1, a = R.P[Math.max(0, n - 1)], b = R.P[n], L = hyp(b[0] - a[0], b[1] - a[1]) || 1;
        return [b[0], b[1], ((b[0] - a[0]) / L) * pr.v[n], ((b[1] - a[1]) / L) * pr.v[n]];
      }
      let lo = 0, hi = tt.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tt[m] <= t) lo = m; else hi = m; }
      const u = (t - tt[lo]) / Math.max(tt[hi] - tt[lo], 1e-9), a = R.P[lo], b = R.P[hi];
      const L = hyp(b[0] - a[0], b[1] - a[1]) || 1, sp = pr.v[lo] + (pr.v[hi] - pr.v[lo]) * u;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, ((b[0] - a[0]) / L) * sp, ((b[1] - a[1]) / L) * sp];
    };
    return plan;
  }
  // the shortest time to cover pts flat out
  const minTime = (pts, g, opts) => planPath(pts, g, { ...(opts || {}), T: null }).T;

  // ------------------------------------------------------------------ the world ---
  // Bodies step together at 20 Hz. Each has legs: from time t0 on, what it does. Kinds:
  //   path   {plan}                      follow a planned path exactly
  //   go     {x, y, eff, stop}           run to a point (stop: arrive and stand)
  //   chase  {who, eff, lead, gap}       run down a body, aiming where it is going; gap: hold off this far
  //   mirror {who, lag, dx, dy, eff}     man coverage: where the receiver was `lag` seconds ago, plus a cushion
  //          {..., dir, los, cush, c0, dx0, tau, floor}   (the cushion shrinking from the alignment's, see step)
  //   track  {fn, eff, gain}             stay on a moving point fn(t) -> [x, y]
  //   stick  {who, dx, dy}               engaged: locked to another body (a block, a tackle) at an offset
  //   stand  {}                          slow down and stand
  const SEP = 0.9;
  const HIT = 14;           // yd/s^2: the hardest change of velocity at contact (a block, a tackle) in one step           // yards: the closest two teammates come when neither is on a set path or in a block
  function World(opts) {
    this.dt = (opts && opts.dt) || DT;
    this.field = (opts && opts.field) || null;           // [left, right] sidelines: a run to a spot or a chase pulls up there
    // the edges of the ground: [back, front] past the end lines and [left, right] past the sidelines, where nobody
    // runs on (into the stands, off the drawn field)
    this.ends = (opts && opts.ends) || null;
    this.sides = (opts && opts.sides) || null;
    this.bodies = [];
    this.t = 0;
  }
  World.prototype.add = function (o) {
    const b = { id: o.id, g: o.g, x: o.x, y: o.y, vx: 0, vy: 0, spd: o.spd || 1, legs: [], hx: [], hy: [], ref: o.ref, team: o.team };
    this.bodies.push(b);
    return b;
  };
  World.prototype.leg = function (b, t0, kind, o) {
    if (!b) return;
    b.legs = b.legs.filter((l) => l.t0 < t0 - 1e-9);
    b.legs.push({ t0, kind, ...(o || {}) });
  };
  const legAt = (b, t) => { let L = null; for (const l of b.legs) if (l.t0 <= t + 1e-9) L = l; return L; };
  // where a body was at time t (from its recorded track; before the start: where it began)
  World.prototype.posAt = function (b, t) {
    const i = t / this.dt;
    if (!b.hx.length) return [b.x, b.y];
    if (i <= 0) return [b.hx[0], b.hy[0]];
    const n = b.hx.length - 1;
    if (i >= n) return [b.hx[n], b.hy[n]];
    const k = Math.floor(i), u = i - k;
    return [b.hx[k] + (b.hx[k + 1] - b.hx[k]) * u, b.hy[k] + (b.hy[k + 1] - b.hy[k]) * u];
  };

  // one step of one body: the velocity it wants, limited by its envelope
  function steer(b, vdx, vdy, eff, dt) {
    const en = envOf(b.g, b.spd, eff);
    const s = hyp(b.vx, b.vy), sd = hyp(vdx, vdy);
    // a sharp change of direction at speed: brake first, then cut (no swinging wide in an orbit)
    if (s > 2.5 && sd > 0.1) {
      const cos = (vdx * b.vx + vdy * b.vy) / (sd * s);
      const k = clip(0.35 + 0.65 * cos, 0.12, 1);
      vdx *= k; vdy *= k;
    }
    let dvx = vdx - b.vx, dvy = vdy - b.vy;
    if (s > 0.35) {
      const ux = b.vx / s, uy = b.vy / s;
      let tan = dvx * ux + dvy * uy, nx = dvx - tan * ux, ny = dvy - tan * uy;
      tan = clip(tan, -en.brake * dt, fwdAcc(en, s) * dt);
      const nl = hyp(nx, ny), nmax = Math.max(en.lat, 7 - s) * dt;     // slow players turn on a dime
      if (nl > nmax) { nx *= nmax / nl; ny *= nmax / nl; }
      dvx = tan * ux + nx; dvy = tan * uy + ny;
    } else {
      const l = hyp(dvx, dvy), m = Math.max(en.a0, en.brake) * dt;
      if (l > m) { dvx *= m / l; dvy *= m / l; }
    }
    b.vx += dvx; b.vy += dvy;
    // over his top speed (a lower effort than he was running at): he brakes down to it, never drops to it at once
    const s2 = hyp(b.vx, b.vy), cap = Math.max(en.top, s - en.brake * dt);
    if (s2 > cap) { b.vx *= cap / s2; b.vy *= cap / s2; }
    b.x += b.vx * dt; b.y += b.vy * dt;
  }
  // the velocity that brings a body to point (x, y) and stops it there, at most `top`
  function arrive(b, x, y, top, brake, stop) {
    const dx = x - b.x, dy = y - b.y, d = hyp(dx, dy);
    if (d < 1e-3) return [0, 0];
    const sp = stop ? Math.min(top, Math.sqrt(2 * brake * 0.7 * d), d * 4) : top;
    return [(dx / d) * sp, (dy / d) * sp];
  }

  World.prototype.step = function () {
    const dt = this.dt, t = this.t;
    for (const b of this.bodies) {
      const L = legAt(b, t);
      // a path used up while still moving (a route run through its end, a pursuit cut short): he carries his
      // momentum and pulls up within his envelope, as a player does, instead of stopping dead on the spot
      const spent = L && L.kind === 'path' && t + dt - L.t0 > L.plan.T + 1e-9;
      if (spent && L.plan.stop) { b.vx = 0; b.vy = 0; b.nx = b.x; b.ny = b.y; continue; }    // (a stop path: down where it ends)
      if (L && L.kind === 'path' && !spent) {
        const p = L.plan.at(t + dt - L.t0);
        b.vx = (p[0] - b.x) / dt; b.vy = (p[1] - b.y) / dt;
        b.nx = p[0]; b.ny = p[1];
        continue;
      }
      const eff = L && L.eff != null ? L.eff : 1, en = envOf(b.g, b.spd, eff);
      let vd = [0, 0];
      const F = this.field, inF = (x) => (F ? clip(x, F[0] - 0.5, F[1] + 0.5) : x);
      if (!L || L.kind === 'stand' || spent) vd = [0, 0];
      else if (L.kind === 'go') vd = arrive(b, inF(L.x), L.y, en.top, en.brake, L.stop !== false);
      else if (L.kind === 'chase') {
        const w = L.who, d = hyp(w.x - b.x, w.y - b.y);
        const lead = clip(d / Math.max(en.top, 1), 0, 1.4) * (L.lead == null ? 1 : L.lead);
        let ax = w.x + w.vx * lead, ay = w.y + w.vy * lead;
        if (L.gap) {             // hold off: aim at a point this far short of the target, on our side of him
          const gx = b.x - ax, gy = b.y - ay, gl = hyp(gx, gy) || 1;
          ax += (gx / gl) * L.gap; ay += (gy / gl) * L.gap;
        }
        vd = arrive(b, inF(ax), ay, en.top, en.brake, !!L.gap || (F != null && inF(ax) !== ax));
      } else if (L.kind === 'mirror' || L.kind === 'track') {
        let px, py, qx, qy;
        if (L.kind === 'mirror') {
          // where he was `lag` ago, plus the cushion over the top; the defender holds his alignment depth,
          // backpedalling (`pedal` yd/s, up to `pedalMax`), until the receiver closes on it; never on the
          // offense's side of `floor` past the line
          const aim = (tt) => {
            const [rx, ry] = this.posAt(L.who, Math.max(0, tt - (L.lag || 0)));
            if (L.dir == null) return [rx + (L.dx || 0), ry + (L.dy || 0)];
            const age = Math.max(0, tt - L.t0), k = Math.exp(-age / (L.tau || 1));
            const dx = L.dx + ((L.dx0 ?? L.dx) - L.dx) * k;
            let y = ry + L.dir * (L.cush || 0);
            if (L.y0 != null) {
              const back = L.y0 + L.dir * Math.min(L.pedalMax ?? 2.5, (L.pedal || 0) * age);
              // (only while he is still coming upfield: when the route stops short, a hitch or an out, he drives on
              // it instead of sitting at his depth with the man wide open underneath; eased in as the receiver slows)
              const ry0 = this.posAt(L.who, Math.max(0, tt - (L.lag || 0) - 0.3))[1], up = ((ry - ry0) * L.dir) / 0.3;
              const w = age < 0.8 ? 1 : clip((up - 1) / 3, 0, 1), held = L.dir > 0 ? Math.max(y, back) : Math.min(y, back);
              y += (held - y) * w;
            }
            if (L.floor != null) y = L.dir > 0 ? Math.max(y, L.los + L.floor) : Math.min(y, L.los - L.floor);
            return [rx + dx, y];
          };
          [px, py] = aim(t + dt); [qx, qy] = aim(t);
        } else {
          [px, py] = L.fn(t + dt); [qx, qy] = L.fn(t);
        }
        // keep up with the point (its own velocity), and close the gap no faster than he can stop in
        const ex = px - b.x, ey = py - b.y, el = hyp(ex, ey);
        const corr = el > 1e-4 ? Math.min(en.top, el * (L.gain || 3), Math.sqrt(2 * en.brake * 0.7 * el)) / el : 0;
        vd = [(px - qx) / dt + ex * corr, (py - qy) / dt + ey * corr];
      } else if (L.kind === 'stick') {
        const w = L.who;
        const tx = (w.nx != null ? w.nx : w.x) + (L.dx || 0), ty = (w.ny != null ? w.ny : w.y) + (L.dy || 0);
        // locked on, but never faster than the other man is moving plus a lunge
        const gx = tx - b.x, gy = ty - b.y, gl = hyp(gx, gy), mx = Math.min(hyp(w.vx, w.vy) + 3, envOf(b.g, b.spd, 1).top) * dt;
        const k = gl > mx ? mx / gl : 1;
        // (the contact: his velocity comes round to the other man's hard, as a hit does, but not in a single frame)
        let vx = (gx * k) / dt, vy = (gy * k) / dt;
        const cx = vx - b.vx, cy = vy - b.vy, cl = hyp(cx, cy), cm = HIT * dt;
        if (cl > cm) { vx = b.vx + (cx / cl) * cm; vy = b.vy + (cy / cl) * cm; }
        b.vx = vx; b.vy = vy;
        b.nx = b.x + vx * dt; b.ny = b.y + vy * dt;
        continue;
      }
      const ox = b.x, oy = b.y;
      steer(b, vd[0], vd[1], eff, dt);
      b.nx = b.x; b.ny = b.y; b.x = ox; b.y = oy;
    }
    // teammates moving on their own (running to a spot, chasing, standing, in coverage) never end up on top of each
    // other: two closer than SEP ease apart, side by side (a man on a planned path or locked in a block holds his line)
    const free = this.bodies.filter((b) => { const L = legAt(b, t); return b.team != null && b.nx != null && (!L || !(L.kind === 'path' || L.kind === 'stick')); });
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], c = free[j];
        if (a.team !== c.team) continue;
        let dx = c.nx - a.nx, dy = c.ny - a.ny, d = hyp(dx, dy);
        if (d >= SEP) continue;
        if (d < 1e-6) { dx = a.id < c.id ? 1 : -1; dy = 0; d = 1; }
        const push = Math.min((SEP - d) * 0.5, 0.035), ux = dx / d, uy = dy / d;       // at most 0.7 yd/s each
        a.nx -= ux * push; a.ny -= uy * push; c.nx += ux * push; c.ny += uy * push;
      }
    }
    const E = this.ends, X = this.sides;
    for (const b of this.bodies) {
      if (b.nx != null) { b.x = b.nx; b.y = b.ny; }
      // (at the edge he pulls up: his speed past it is gone, he runs on along it)
      if (E && (b.y < E[0] || b.y > E[1])) { b.vy = 0; b.y = clip(b.y, E[0], E[1]); }
      if (X && (b.x < X[0] || b.x > X[1])) { b.vx = 0; b.x = clip(b.x, X[0], X[1]); }
      b.hx.push(b.x); b.hy.push(b.y);
    }
    this.t = t + dt;
  };
  // run to time T, recording every body's track (index i is time i * dt; the first entry is t = 0)
  World.prototype.run = function (T) {
    if (!this.bodies.length) return;
    if (!this.bodies[0].hx.length) for (const b of this.bodies) { b.hx.push(b.x); b.hy.push(b.y); }
    while (this.t < T - 1e-9) this.step();
  };
  // back to time t (a step boundary at or before it): the tracks after it are dropped and every body is where and
  // as fast as it was then, so a job can be given from that moment on and the world run forward again
  World.prototype.rewind = function (t) {
    const k = Math.max(0, Math.min(Math.floor(t / this.dt + 1e-9), this.bodies.length ? this.bodies[0].hx.length - 1 : 0));
    for (const b of this.bodies) {
      if (!b.hx.length) continue;
      b.hx.length = k + 1; b.hy.length = k + 1;
      b.x = b.hx[k]; b.y = b.hy[k];
      b.vx = k ? (b.hx[k] - b.hx[k - 1]) / this.dt : 0; b.vy = k ? (b.hy[k] - b.hy[k - 1]) / this.dt : 0;
      b.nx = b.x; b.ny = b.y; b.pv = null;
    }
    this.t = k * this.dt;
  };
  World.prototype.state = function (b) { return { x: b.x, y: b.y, vx: b.vx, vy: b.vy, s: hyp(b.vx, b.vy) }; };

  // ------------------------------------------------------------------ football ---
  // Route shapes, in (out, up) yards from where the receiver lines up: `out` toward his sideline, `up` past the
  // line of scrimmage. D is the depth of the catch (the real play's air yards) or, for the other receivers, a
  // depth drawn for the route; d0 how far behind the line he lines up. Depths and timing follow Next Gen Stats
  // charting of 2022-2025 targets (median catch depth / time to throw): slant 6 yd / 1.9 s, quick out 3 / 2.3,
  // hitch 5 / 2.4, shallow cross 4 / 2.8, dig 12 / 2.9, deep out 13 / 2.8, post 16 / 2.7, corner 19 / 3.0,
  // go 24 / 2.6, wheel 16 / 2.7, screen -3 / 1.6, flat -2 / 2.6, angle 3 / 2.7. `at` is where on the route the
  // catch is made: 'depth' (where the route reaches depth D) or a distance out along the last leg. A hitch plants
  // just past the depth and turns back to the ball, under a yard (a longer comeback has the ball waiting on him).
  function route(name, D, d0, u) {
    const r = u == null ? 0.5 : u, s0 = -d0;
    switch (name) {
      case 'go': return { pts: [[0, s0], [0.7, 3], [1.1, Math.max(D, 10) + 14]], at: 'depth' };
      case 'post': { const s = clip(D * 0.55, 8, 13); return { pts: [[0, s0], [0, s], [-(44 - s) * 0.8, 44]], at: 'depth', minD: s + 1.5 }; }
      case 'corner': { const s = clip(D * 0.55, 8, 12); return { pts: [[0, s0], [0, s], [(44 - s) * 0.85, 44]], at: 'depth', minD: s + 1.5 }; }
      case 'out': { const s = Math.max(D, 2) + 1.2; return { pts: [[0, s0], [0, s], [14, s - 1.0]], at: 4.5 + 2 * r }; }
      case 'deep_out': { const s = Math.max(D, 9) + 1; return { pts: [[0, s0], [0, s], [15, s - 1.0]], at: 6 + 2 * r }; }
      case 'in': { const s = Math.max(D, 5); return { pts: [[0, s0], [0, s], [-20, s + 0.5]], at: -(6 + 4 * r) }; }
      case 'slant': return { pts: [[0, s0], [0, 1.6], [-26, 1.6 + 26 * 0.72]], at: 'depth', minD: 3 };
      case 'cross': return { pts: [[0, s0], [-1.5, 1.4], [-38, Math.max(D, 1) + 1.6]], at: -(9 + 7 * r) };
      case 'hitch': { const s = Math.max(D, 3) + 0.8; return { pts: [[0, s0], [0, s], [-0.4, s - 0.8]], at: 'end' }; }
      case 'screen': return { pts: [[0, s0], [0.4, s0 - 0.4], [-1.2, Math.min(D, -0.5)]], at: 'end' };
      case 'flat': return { pts: [[0, s0], [2.2, s0 + 1.6], [12, Math.max(D, -1) + 0.6]], at: 6 + 3 * r };
      case 'wheel': return { pts: [[0, s0], [5, s0 + 1.8], [9, 1.5], [10.5, Math.max(D, 8) + 16]], at: 'depth', minD: 4 };
      case 'angle': return { pts: [[0, s0], [3.2, s0 + 2.6], [-12, Math.max(D, 0) + 1.2]], at: -(1.5 + 3 * r) };
      case 'block': return { pts: [[0, s0], [0, s0 - 0.6]], at: 'end' };
      default: return route('hitch', D, d0, u);
    }
  }
  // The route's waypoints on the field, and the catch point when it is the target. ox, oy: where he lines up
  // (field yards); out: +1 or -1, the direction of his sideline across the field; dir: +1 or -1 the offense's
  // direction along it; los: the line of scrimmage. name: a route's name, or a route the player drew ({ pts, at,
  // minD }: its waypoints in the same (out, up) yards, from where he lines up, and where on it the catch is made)
  function routeOnField(name, D, ox, out, dir, los, d0, u) {
    const R = typeof name === 'object' ? { pts: name.pts.map((p) => p.slice()), at: name.at, minD: name.minD } : route(name, D, d0, u);
    const toField = (p) => [ox + out * p[0], los + dir * p[1]];
    const pts = R.pts.map(toField);
    let cat = null, legs = R.pts.length;
    const Dc = Math.max(D, R.minD || -99);
    if (R.at === 'end') cat = R.pts[R.pts.length - 1];
    else if (R.at === 'depth') {
      for (let i = 1; i < R.pts.length; i++) {
        const a = R.pts[i - 1], b = R.pts[i];
        if ((b[1] - Dc) * (a[1] - Dc) <= 0 && b[1] !== a[1]) {
          const w = (Dc - a[1]) / (b[1] - a[1]);
          cat = [a[0] + (b[0] - a[0]) * w, Dc]; legs = i; break;
        }
      }
      if (!cat) {                       // a deeper throw than the route's shape: carry its last leg on to depth D
        const a = R.pts[R.pts.length - 2], b = R.pts[R.pts.length - 1];
        const w = b[1] !== a[1] ? (Dc - a[1]) / (b[1] - a[1]) : 1;
        cat = [a[0] + (b[0] - a[0]) * w, Dc];
        R.pts[R.pts.length - 1] = cat.slice();
        legs = R.pts.length - 1;
      }
    } else {
      const a = R.pts[R.pts.length - 2], b = R.pts[R.pts.length - 1], len = b[0] - a[0];
      const w = clip(R.at / (Math.abs(len) > 1e-6 ? len : 1), 0, 1);
      cat = [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      legs = R.pts.length - 1;
    }
    const upto = R.pts.slice(0, legs).map(toField);
    return { pts, toCatch: upto.concat([toField(cat)]), catchAt: toField(cat), rest: R.pts.slice(legs).map(toField) };
  }

  // Where each group stands relative to the line of scrimmage over the first 4 s, on pass and run plays (median
  // depth in yards, positive = toward the defense's goal; 2017 Big Data Bowl sample game, every snap).
  const CURVE_T = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  const CURVES = {
    pass: { OL: [-0.9, -1.0, -1.7, -2.6, -3.3, -3.9, -4.2, -4.3, -4.1], DL: [1.0, 0.8, -0.6, -1.7, -2.5, -3.1, -3.5, -3.4, -3.0],
      QB: [-4.6, -4.9, -5.9, -6.9, -7.5, -7.5, -7.3, -7.1, -7.0] },
    run: { OL: [-0.7, -0.6, -0.3, 0.0, 0.4, 0.8, 1.3, 1.8, 2.4], DL: [1.1, 0.9, 0.5, 0.4, 0.5, 0.8, 1.2, 1.9, 2.5] },
  };
  // depth change since the snap on the curve, at time t (held after 4 s)
  function curveShift(kind, g, t) {
    const c = CURVES[kind][g], T = CURVE_T;
    if (t <= 0) return 0;
    if (t >= T[T.length - 1]) return c[c.length - 1] - c[0];
    let i = 1;
    while (T[i] < t) i++;
    const u = (t - T[i - 1]) / (T[i] - T[i - 1]);
    return c[i - 1] + (c[i] - c[i - 1]) * u - c[0];
  }

  // Zone landmarks by coverage shell: [x across the field (yards from the left sideline as the offense looks
  // downfield), depth past the line], filled in the order deep, then underneath; 2022-2025 Next Gen Stats
  // shells: Cover 1 30%, Cover 3 23%, Cover 2 18%, Cover 4 11%, Cover 6 6%, 2-Man 5%, Cover 0 4%.
  const W = 53.33;
  const SHELLS = {
    cover3: { deep: [[9, 16], [W / 2, 18], [W - 9, 16]], under: [[6, 6], [W / 2 - 8, 9], [W / 2 + 8, 9], [W - 6, 6], [W / 2, 11]] },
    cover9: { deep: [[9, 16], [W / 2, 18], [W - 9, 16]], under: [[6, 6], [W / 2 - 8, 9], [W / 2 + 8, 9], [W - 6, 6], [W / 2, 11]] },
    cover2: { deep: [[13, 17], [W - 13, 17]], under: [[6, 5.5], [W - 6, 5.5], [W / 2 - 7, 9], [W / 2 + 7, 9], [W / 2, 12]] },
    cover4: { deep: [[7, 14], [19, 14], [W - 19, 14], [W - 7, 14]], under: [[10, 6.5], [W - 10, 6.5], [W / 2 - 4, 8], [W / 2 + 4, 8]] },
    cover6: { deep: [[7, 14], [19, 14], [W - 13, 17]], under: [[W - 6, 5.5], [10, 6.5], [W / 2 - 4, 8], [W / 2 + 6, 9]] },
    prevent: { deep: [[8, 24], [20, 27], [W - 20, 27], [W - 8, 24], [W / 2, 30]], under: [[10, 12], [W - 10, 12], [W / 2, 15]] },
    // man shells: deep help, the rest in man
    cover1: { deep: [[W / 2, 16]], under: [[W / 2, 9]] },
    '2man': { deep: [[13, 17], [W - 13, 17]], under: [] },
    cover0: { deep: [], under: [] },
  };
  // A short field (the red zone, the goal line): every depth past the line of scrimmage fits in the room there is,
  // `room` yards to the end line, the deepest a yard short of it. The deep zones come up to the back of the end zone
  // and the underneath ones in proportion, as defenses play it there; nothing within 2 yards of the line moves (the
  // front, a man pressed up). deepest: the deepest depth of the shell or alignment it is part of
  function squeeze(d, deepest, room) {
    const cap = room - 1, near = 2;
    if (d <= near || deepest <= cap) return Math.min(d, Math.max(cap, near));
    return near + ((Math.min(d, deepest) - near) * Math.max(0, cap - near)) / (deepest - near);
  }
  const SHELL_SHARE = [['cover1', 0.30], ['cover3', 0.23], ['cover2', 0.18], ['cover4', 0.11], ['cover6', 0.06], ['2man', 0.05],
    ['cover0', 0.04], ['cover9', 0.03]];
  const MAN = { cover1: true, '2man': true, cover0: true };

  return { ENV, DT, planPath, minTime, World, envOf, smooth, route, routeOnField, curveShift, CURVES, SHELLS, SHELL_SHARE, MAN, squeeze };
});
