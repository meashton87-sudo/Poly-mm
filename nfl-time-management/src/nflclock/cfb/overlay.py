"""NFL -> college call overlay (web/cfb_overlay.json): one EPA shift per NFL playbook pool that re-levels the NFL
call pools to college outcomes.

College play-by-play has no charting (no pass direction or depth, no run gap: design 0), so the 26 call concepts
stay NFL-shaped (their spread of outcomes, explosive-play rates, sacks: disclosed). Only the level moves: for each
pool p (a call in a situation, and the look pools), pool_shift_cfb[p] = shift_nfl[p] + d_p, with d_p found by
bisection on the browser's own tilt (engine.js pbTilt: 4 Newton steps on theta, clipped to +-1.5) so that the tilted
pool's mean yards equals the NFL pool's mean yards x (college mean yards / NFL mean yards) for the call's kind in
the pool's situations. Yards, not EPA: the two EP models' scales differ. A pool shared by several situations takes
the ratio of the situations it serves, weighted by how often college offenses are in each and how often NFL
callers make the call there.
"""
from __future__ import annotations

import base64
import hashlib
import json

import numpy as np
import pandas as pd

from .. import library as L

TILT_CLIP = 1.5           # engine.js pbTilt's theta clip
MIN_CELL = 100            # college plays of a kind in a situation before its own mean yards are used (else coarser)
BISECT_STEPS = 20
GRID_MAX, GRID_STEP = 3.0, 0.05   # EPA: the extra shift searched, and the grid's step


def _dec(d: dict) -> np.ndarray:
    return np.frombuffer(base64.b64decode(d["b64"]), dtype=np.dtype(d["dtype"])).copy()


def _b64(arr: np.ndarray) -> dict:
    arr = np.ascontiguousarray(arr)
    return {"dtype": arr.dtype.name, "n": int(arr.size), "b64": base64.b64encode(arr.tobytes()).decode("ascii")}


class Pools:
    """The browser's call pools (web/playbook.json) as flat arrays."""

    def __init__(self, pb: dict):
        self.calls = pb["calls"]
        self.n_fine = pb["n_fine"]
        R = pb["rows"]
        self.yards = _dec(R["yards"]).astype(float)
        self.epa = _dec(R["epa"]).astype(np.float32).astype(float)
        self.items = _dec(pb["items"]).astype(np.int64)
        self.offsets = _dec(pb["offsets"]).astype(np.int64)
        self.pool_of = _dec(pb["pool_of"]).astype(np.int64).reshape(len(self.calls), self.n_fine)
        lp = pb.get("look_pool")
        self.look_pool = _dec(lp).astype(np.int64).reshape(len(self.calls), self.n_fine, 4) if lp else None
        self.shift = _dec(pb["pool_shift"]).astype(np.float32).astype(float) if pb.get("pool_shift") else None
        self.freq = _dec(pb["freq"]).astype(np.float32).astype(float).reshape(self.n_fine, len(self.calls))
        self.n_pools = len(self.offsets) - 1
        self.pool_id = np.repeat(np.arange(self.n_pools), np.diff(self.offsets))
        self.e = self.epa[self.items]
        self.y = self.yards[self.items]
        self.kind_of_call = np.array([1 if c["kind"] == "pass" else 0 for c in self.calls])
        base_shift = self.shift if self.shift is not None else np.zeros(self.n_pools)
        self.base_shift = base_shift
        n = np.maximum(np.diff(self.offsets), 1)
        self.base = np.add.reduceat(self.e, self.offsets[:-1]) / n

    def theta(self, target: np.ndarray) -> np.ndarray:
        """pbTilt's theta for each pool's target mean EPA (vectorised; same steps, same clip)."""
        th = np.zeros(self.n_pools)
        st = self.offsets[:-1]
        for _ in range(4):
            z = th[self.pool_id] * self.e
            w = np.exp(z - np.maximum.reduceat(z, st)[self.pool_id])
            sw = np.add.reduceat(w, st)
            m1 = np.add.reduceat(w * self.e, st) / sw
            m2 = np.add.reduceat(w * self.e * self.e, st) / sw
            th = np.clip(th + (target - m1) / np.maximum(m2 - m1 * m1, 1e-6), -TILT_CLIP, TILT_CLIP)
        return th

    def tilted(self, th: np.ndarray, values: np.ndarray) -> np.ndarray:
        st = self.offsets[:-1]
        z = th[self.pool_id] * self.e
        w = np.exp(z - np.maximum.reduceat(z, st)[self.pool_id])
        return np.add.reduceat(w * values, st) / np.add.reduceat(w, st)

    def mean_yards(self, shift: np.ndarray) -> np.ndarray:
        return self.tilted(self.theta(self.base + shift), self.y)

    def refs(self):
        """(pool, call, fine) for every way the browser reaches a pool: the situation pool and its four look pools."""
        c, f = np.meshgrid(np.arange(len(self.calls)), np.arange(self.n_fine), indexing="ij")
        p = [self.pool_of.ravel()]
        cc, ff = [c.ravel()], [f.ravel()]
        if self.look_pool is not None:
            for b in range(4):
                p.append(self.look_pool[:, :, b].ravel())
                cc.append(c.ravel())
                ff.append(f.ravel())
        return np.concatenate(p), np.concatenate(cc), np.concatenate(ff)


def college_cells(lib: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """College mean yards and play counts by (kind, fine situation), sparse cells taking their coarser level's mean
    (down x zone in the mode, then mode x zone, then zone), as library.PlayLibrary pools."""
    mode, db, yb, zone = L.decode_fine(np.arange(L.N_FINE))
    mean = np.zeros((2, L.N_FINE))
    count = np.zeros((2, L.N_FINE))
    for kind in (0, 1):
        sub = lib[lib["kind"] == kind]
        lv = {0: sub["fine"].to_numpy(), 1: ((sub["mode"] * L.N_DOWN + L.down_bucket(sub["down"])) * L.N_ZONE + L.zone_of(sub["yl"])).to_numpy(),
              2: (sub["mode"] * L.N_ZONE + L.zone_of(sub["yl"])).to_numpy(), 3: L.zone_of(sub["yl"])}
        g = {k: sub.groupby(v)["yards"].agg(["mean", "size"]) for k, v in lv.items()}
        for fk in range(L.N_FINE):
            cand = {0: fk, 1: (mode[fk] * L.N_DOWN + db[fk]) * L.N_ZONE + zone[fk], 2: mode[fk] * L.N_ZONE + zone[fk], 3: zone[fk]}
            count[kind, fk] = g[0]["size"].get(fk, 0)
            for k in range(4):
                if g[k]["size"].get(cand[k], 0) >= MIN_CELL or k == 3:
                    mean[kind, fk] = g[k]["mean"].get(cand[k], sub["yards"].mean())
                    break
    return mean, count


def solve(pools: Pools, cfb_mean: np.ndarray, cfb_count: np.ndarray, log=print) -> tuple[np.ndarray, dict]:
    nfl_shift = pools.base_shift
    my_nfl = pools.mean_yards(nfl_shift)                       # each pool as the NFL game plays it today
    kind = pools.kind_of_call
    # the NFL game's mean yards by (kind, situation): the callers' mix of its pools
    nfl_cell = np.zeros((2, pools.n_fine))
    for k in (0, 1):
        f = pools.freq[:, kind == k]
        m = my_nfl[pools.pool_of[kind == k, :]].T                 # [fine, calls of kind]
        nfl_cell[k] = (f * m).sum(1) / np.maximum(f.sum(1), 1e-12)
    ratio = cfb_mean / np.where(np.abs(nfl_cell) < 0.25, np.sign(nfl_cell + 1e-9) * 0.25, nfl_cell)
    ratio = np.clip(ratio, 0.25, 4.0)
    p, c, f = pools.refs()
    w = (cfb_count[kind[c], f] + 1.0) * pools.freq[f, c]
    num = np.bincount(p, weights=w * ratio[kind[c], f], minlength=pools.n_pools)
    den = np.bincount(p, weights=w, minlength=pools.n_pools)
    r_pool = np.where(den > 0, num / np.maximum(den, 1e-300), 1.0)
    target = my_nfl * r_pool
    # the extra shift d: pbTilt's 4 clipped Newton steps are not monotone in the target (a big one can swing theta
    # +1.5 then -1.5), so a grid first: the bracket where the tilted mean crosses the target nearest no extra
    # shift, then bisection inside it; where nothing crosses, the grid point closest to the target
    grid = np.arange(-GRID_MAX, GRID_MAX + 1e-9, GRID_STEP)
    G = np.stack([pools.mean_yards(nfl_shift + g) for g in grid]) - target          # [grid, pools]
    cross = (np.sign(G[:-1]) != np.sign(G[1:])) | (G[:-1] == 0)
    dist = np.where(cross, np.abs(grid[:-1, None] + GRID_STEP / 2), np.inf)
    k = dist.argmin(0)
    has = np.isfinite(dist.min(0))
    lo, hi = grid[k], grid[k] + GRID_STEP
    up_lo = G[k, np.arange(pools.n_pools)] < 0
    for _ in range(BISECT_STEPS):
        mid = 0.5 * (lo + hi)
        below = pools.mean_yards(nfl_shift + mid) < target
        move_lo = below == up_lo
        lo, hi = np.where(move_lo, mid, lo), np.where(move_lo, hi, mid)
    best = grid[np.abs(G).argmin(0)]
    lo = np.where(has, lo, best)
    hi = np.where(has, hi, best)
    size = np.diff(pools.offsets)
    valid = size >= 2              # an empty or one-play look pool is never drawn from as a pool: it keeps its shift
    d = np.where(valid, 0.5 * (lo + hi), 0.0)
    shift = nfl_shift + d
    got = pools.mean_yards(shift)
    err = np.where(valid, np.abs(got - target), 0.0)
    den = np.where(valid, den, 0.0)
    rep = {"n_pools": int(pools.n_pools), "pools_solved": int(valid.sum()),
           "pools_within_0.1yd": round(float(np.mean(err[valid] <= 0.1)), 4),
           "pools_within_0.3yd": round(float(np.mean(err[valid] <= 0.3)), 4),
           "pools_within_0.3yd_weighted": round(float(np.sum((err <= 0.3) * den) / den.sum()), 4),
           "mean_abs_shift_delta": round(float(np.mean(np.abs(d[valid]))), 4),
           "shift_delta_p95": round(float(np.percentile(np.abs(d[valid]), 95)), 4),
           "median_pool_ratio": round(float(np.median(r_pool[den > 0])), 4)}
    # acceptance: college mean yards by kind and situation reproduced by the overlaid NFL call mix
    res, tot, ok = [], 0.0, 0.0
    for k in (0, 1):
        fq = pools.freq[:, kind == k]
        m = got[pools.pool_of[kind == k, :]].T
        cell = (fq * m).sum(1) / np.maximum(fq.sum(1), 1e-12)
        diff = cell - cfb_mean[k]
        n = cfb_count[k]
        tot += n.sum()
        ok += n[np.abs(diff) <= 0.3].sum()
        res.append({"kind": "pass" if k else "run", "cells_n100": int((n >= 100).sum()),
                    "cells_n100_within_0.3": int(((n >= 100) & (np.abs(diff) <= 0.3)).sum()),
                    "max_abs_diff_n100": round(float(np.abs(diff[n >= 100]).max()), 3) if (n >= 100).any() else None,
                    "play_weighted_mean_abs_diff": round(float(np.sum(np.abs(diff) * n) / max(n.sum(), 1)), 3)})
    rep["reproduced"] = res
    rep["plays_in_cells_within_0.3yd"] = round(float(ok / max(tot, 1)), 4)
    rep["clip_bound_pools"] = int(np.sum(valid & (np.abs(pools.theta(pools.base + shift)) >= TILT_CLIP - 1e-9)))
    rep["pools_small"] = int(np.sum(size < 40))
    log(f"  overlay: {rep['pools_within_0.3yd']:.1%} of pools hit their target within 0.3 yd; "
        f"{rep['plays_in_cells_within_0.3yd']:.1%} of college plays in situations reproduced within 0.3 yd")
    return shift.astype(np.float32), rep


def build(playbook_path, college_lib: pd.DataFrame, out_path, log=print) -> dict:
    raw = playbook_path.read_bytes()
    pb = json.loads(raw)
    pools = Pools(pb)
    mean, count = college_cells(college_lib)
    shift, rep = solve(pools, mean, count, log)
    out = {"version": 1, "n_pools": int(pools.n_pools), "pool_shift": _b64(shift),
           "playbook_stamp": hashlib.sha256(raw).hexdigest()[:16], "level": "fbs",
           "note": "NFL call pools re-leveled to college mean yards by kind and situation; shapes stay NFL"}
    out_path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    rep["bytes"] = out_path.stat().st_size
    return rep
