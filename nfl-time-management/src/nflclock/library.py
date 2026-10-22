"""Empirical play-outcome library.

Every run/pass snap (plus penalties) from recent seasons becomes a library row
carrying its yardage, clock-relevant flags (incomplete, out of bounds, penalty),
turnover spot, scoring flags, duration and EPA. Rows are grouped into situation
pools (game mode x down x distance x field zone, with fallback merging for
sparse pools). At simulation time a play is drawn from the pool that matches
the situation, after *exponential tilting* the pool toward the matchup: weights
w_i ~ exp(theta * epa_i) with theta solved so the pool's mean EPA moves by the
offense-vs-defense rating gap. Tilting is the minimum-KL reweighting that hits
the target mean, so it keeps the shape of real outcome distributions (sacks,
explosives, turnovers) while making good offenses and bad defenses play like
they do.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config

KIND_RUN, KIND_PASS = 0, 1
MODE_NORMAL, MODE_HURRY, MODE_KILL = 0, 1, 2
N_MODE, N_DOWN, N_YTG, N_ZONE = 3, 3, 4, 7
N_FINE = N_MODE * N_DOWN * N_YTG * N_ZONE
ZONE_EDGES = np.array([3, 9, 20, 39, 59, 79, 99])
YTG_EDGES = np.array([2, 5, 10, 99])
MIN_POOL = 150
RUN_LOSS_MAX = 15      # yards: a run losing more without a fumble was meant (an intentional safety): not drawn as a run


# ------------------------------------------------------------- situations ---
def game_mode(half, half_t, margin) -> np.ndarray:
    """Situational mode from the offense's point of view (vectorised)."""
    half = np.asarray(half)
    half_t = np.asarray(half_t, float)
    margin = np.asarray(margin, float)
    hurry = ((half == 1) & (half_t <= 120)) | ((half == 2) & (half_t <= 300) & (margin < 0)) \
        | ((half == 2) & (half_t <= 120) & (margin == 0)) | ((half == 2) & (half_t <= 600) & (margin <= -9))
    kill = (half == 2) & (half_t <= 360) & (margin > 0)
    return np.where(hurry, MODE_HURRY, np.where(kill, MODE_KILL, MODE_NORMAL)).astype(np.int64)


def zone_of(yl) -> np.ndarray:
    return np.searchsorted(ZONE_EDGES, np.clip(np.asarray(yl, float), 1, 99), side="left").astype(np.int64)


def ytg_bucket(ytg) -> np.ndarray:
    return np.searchsorted(YTG_EDGES, np.clip(np.asarray(ytg, float), 1, 99), side="left").astype(np.int64)


def down_bucket(down) -> np.ndarray:
    return np.clip(np.asarray(down, np.int64), 1, 3) - 1


def fine_key(mode, down, ytg, yl) -> np.ndarray:
    return (((np.asarray(mode) * N_DOWN + down_bucket(down)) * N_YTG + ytg_bucket(ytg)) * N_ZONE
            + zone_of(yl))


def decode_fine(fk):
    zone = fk % N_ZONE
    yb = (fk // N_ZONE) % N_YTG
    db = (fk // (N_ZONE * N_YTG)) % N_DOWN
    mode = fk // (N_ZONE * N_YTG * N_DOWN)
    return mode, db, yb, zone


# ---------------------------------------------------------------- building ---
def _duration(play_type, yards, incomplete, sack, penalty_presnap, turnover):
    yd = np.clip(yards, 0, None)
    d = np.where(play_type == "run", 5.0 + 0.12 * yd, 5.0 + 0.08 * yd)
    d = np.where(incomplete == 1, 5.0, d)
    d = np.where(sack == 1, 6.0, d)
    d = np.where(turnover == 1, 7.0, d)
    d = np.where(penalty_presnap, 0.0, d)
    return np.clip(d, 0.0, 14.0)


AUTO_FD_SHARE = 0.5   # a kind of foul is an automatic first down when more than half of its fouls short of the line to
                      # gain still gave one (holding 99.9%, pass interference and illegal contact 100%; offside 0%)


def auto_first_down(s: pd.DataFrame, pen: np.ndarray) -> np.ndarray:
    """True where the foul itself gives the offense a first down, wherever the row is drawn (the flag the engines read).

    nflverse's first_down_penalty marks every snap whose first down came from a foul, so a 5-yard offside on 3rd and 2
    carries it as well as a defensive holding on 3rd and 9. A row is drawn in other situations than its own, and the
    offside's mark gave a first down on 1st and 10 (players saw it). In the rulebook only some defensive fouls are an
    automatic first down (holding, pass interference, illegal contact, illegal use of hands, roughing the passer, the
    personal fouls); offside, encroachment, a neutral zone infraction, delay, too many men or an illegal formation are 5
    yards, a first down only when the yardage reaches the line to gain. The data says which is which (2016-26, the
    defense's accepted fouls short of the line to gain): offside got the first down on 0 of 1,220, a neutral zone
    infraction 0 of 925, encroachment 0 of 296; holding on 1,311 of 1,312, illegal contact on 460 of 460. A kind never
    seen short of the line to gain (a 15-yard foul on 3rd and 3) keeps its own mark."""
    pen = np.asarray(pen, bool)
    fdp = s["first_down_penalty"].fillna(0).to_numpy() == 1
    kind = s["penalty_type"].fillna("").to_numpy().astype(object)
    short = (pen & (s["penalty_team"].to_numpy() == s["defteam"].to_numpy())
             & (s["penalty_yards"].fillna(0).to_numpy() < s["ydstogo"].to_numpy()))
    share = pd.Series(fdp[short]).groupby(kind[short]).mean()
    auto = np.isin(kind, list(share.index[share > AUTO_FD_SHARE])) | ~np.isin(kind, list(share.index))
    return pen & fdp & auto


def build_library(pbp: pd.DataFrame, seasons=None, seed: int = 7) -> pd.DataFrame:
    seasons = seasons or config.LIBRARY_SEASONS
    s = pbp[pbp["is_snap"] & pbp["season"].isin(seasons) & pbp["down"].notna()
            & pbp["epa"].notna()].copy()
    normal = s["play_type"].isin(["run", "pass"])
    pen = (s["play_type"] == "no_play") & s["penalty"].fillna(0).eq(1)
    s = s[normal | pen].copy()
    pen = (s["play_type"] == "no_play").to_numpy()
    rng = np.random.default_rng(seed)
    is_pass = np.where(
        pen,
        np.where(s["pass"].fillna(0).eq(1), True,
                 np.where(s["rush"].fillna(0).eq(1), False, rng.random(len(s)) < 0.57)),
        s["qb_dropback"].fillna(0).eq(1),
    )
    presnap = pen & s["pass"].fillna(0).eq(0).to_numpy() & s["rush"].fillna(0).eq(0).to_numpy()
    off_pen_sign = np.where(s["penalty_team"] == s["posteam"], -1.0, 1.0)
    yards = np.where(pen, off_pen_sign * s["penalty_yards"].fillna(0), s["yards_gained"].fillna(0))
    td_off = (s["touchdown"].fillna(0).eq(1) & (s["td_team"] == s["posteam"])).to_numpy() & ~pen
    td_def = (s["touchdown"].fillna(0).eq(1) & (s["td_team"] == s["defteam"])).to_numpy() & ~pen
    turnover = (s["turnover"].to_numpy() == 1) & ~pen
    # Turnover spot relative to the line of scrimmage (in the original offense's frame).
    nxt_yl = s["next_yardline_100"].to_numpy()
    nxt_pos = s["next_posteam"].to_numpy()
    to_rel = s["yardline_100"].to_numpy() + nxt_yl - 100.0
    valid_to = turnover & ((nxt_pos == s["defteam"].to_numpy()) | td_def)
    bad = turnover & ~valid_to
    half = s["half"].to_numpy()
    lib = pd.DataFrame({
        "kind": np.where(is_pass, KIND_PASS, KIND_RUN),
        "yards": yards.astype(float),
        "auto_fd": auto_first_down(s, pen),
        "penalty": pen,
        "incomplete": (s["incomplete_pass"].fillna(0).to_numpy() == 1) & ~pen,
        "oob": (s["out_of_bounds"].fillna(0).to_numpy() == 1) & ~pen,
        "td_off": td_off,
        "td_def": td_def,
        "turnover": turnover,
        "to_rel": np.where(valid_to, np.nan_to_num(to_rel, nan=0.0), 0.0),
        "safety": (s["safety"].fillna(0).to_numpy() == 1) & ~pen,
        "duration": _duration(s["play_type"].to_numpy(), s["yards_gained"].fillna(0).to_numpy(),
                              s["incomplete_pass"].fillna(0).to_numpy(), s["sack"].fillna(0).to_numpy(),
                              presnap, s["turnover"].to_numpy()),
        "epa": s["epa"].to_numpy(),
        "mode": game_mode(half, s["half_seconds_remaining"].to_numpy(), s["margin"].to_numpy()),
        "down": s["down"].to_numpy().astype(int),
        "ytg": s["ydstogo"].to_numpy(),
        "yl": s["yardline_100"].to_numpy(),
        "season": s["season"].to_numpy(),
    })
    # a run that loses more than RUN_LOSS_MAX with no fumble was run backward on purpose (a punter taking a safety to
    # burn the clock, 2020-25: 5 of the 7) or a trick play gone wrong: a coach's choice, never a run's random outcome
    deliberate = ((lib["kind"] == KIND_RUN) & ~lib["penalty"] & (lib["yards"] < -RUN_LOSS_MAX)
                  & s["fumble"].fillna(0).eq(0).to_numpy())
    lib = lib[~bad & ~deliberate].reset_index(drop=True)
    lib["fine"] = fine_key(lib["mode"], lib["down"], lib["ytg"], lib["yl"])
    return lib


class PlayLibrary:
    """Pooled arrays for fast vectorised sampling."""

    FIELDS = ["yards", "auto_fd", "penalty", "incomplete", "oob", "td_off", "td_def", "turnover",
              "to_rel", "safety", "duration", "epa"]

    def __init__(self, lib: pd.DataFrame):
        self.lib = lib
        self.arr = {f: lib[f].to_numpy() for f in self.FIELDS}
        self.mean_epa = {k: float(lib.loc[lib.kind == k, "epa"].mean()) for k in (KIND_RUN, KIND_PASS)}
        mode, db, yb, zone = decode_fine(np.arange(N_FINE))
        self.pool_of = np.zeros((2, N_FINE), dtype=np.int64)
        items, offsets, pool_index = [], [0], {}
        for kind in (KIND_RUN, KIND_PASS):
            sub = lib[lib.kind == kind]
            keys = {
                0: sub["fine"].to_numpy(),
                1: ((sub["mode"] * N_DOWN + down_bucket(sub["down"])) * N_ZONE + zone_of(sub["yl"])).to_numpy(),
                2: (sub["mode"] * N_ZONE + zone_of(sub["yl"])).to_numpy(),
                3: zone_of(sub["yl"]),
                4: np.zeros(len(sub), dtype=np.int64),
            }
            idx = sub.index.to_numpy()
            counts = {lvl: pd.Series(k).value_counts() for lvl, k in keys.items()}
            for fk in range(N_FINE):
                cand = {
                    0: fk,
                    1: (mode[fk] * N_DOWN + db[fk]) * N_ZONE + zone[fk],
                    2: mode[fk] * N_ZONE + zone[fk],
                    3: zone[fk],
                    4: 0,
                }
                for lvl in range(5):
                    if counts[lvl].get(cand[lvl], 0) >= MIN_POOL or lvl == 4:
                        break
                pkey = (kind, lvl, int(cand[lvl]))
                if pkey not in pool_index:
                    pool_index[pkey] = len(offsets) - 1
                    members = idx[keys[lvl] == cand[lvl]]
                    items.append(members)
                    offsets.append(offsets[-1] + len(members))
                self.pool_of[kind, fk] = pool_index[pkey]
        self.items = np.concatenate(items)
        self.offsets = np.array(offsets)
        self.n_pools = len(offsets) - 1
        self.pool_id = np.repeat(np.arange(self.n_pools), np.diff(self.offsets))
        self.item_epa = self.arr["epa"][self.items]
        # Empirical pass share by fine bucket (non-penalty plays), with fallback smoothing.
        nonpen = lib[~lib.penalty]
        g = nonpen.groupby(["fine", "kind"]).size().unstack(fill_value=0).reindex(range(N_FINE), fill_value=0)
        n = g.sum(axis=1).to_numpy()
        coarse = nonpen.assign(c=(nonpen["mode"] * N_ZONE + zone_of(nonpen["yl"])))
        gc = coarse.groupby(["c", "kind"]).size().unstack(fill_value=0)
        pc = (gc.get(KIND_PASS, 0) / gc.sum(axis=1)).reindex(range(N_MODE * N_ZONE)).fillna(0.55).to_numpy()
        prior = pc[mode * N_ZONE + zone]
        self.pass_rate = (g.get(KIND_PASS, pd.Series(0, index=g.index)).to_numpy() + 30 * prior) / (n + 30)

    # -------------------------------------------------------------- tilting ---
    def tilt(self, delta_run: float, delta_pass: float):
        """Tilt every pool's mean EPA by the matchup delta.

        Returns (cdf, prob): ``cdf`` is a global, pool-offset CDF used for
        sampling (pool p occupies (p, p+1]); ``prob`` is each item's
        within-pool probability.
        """
        delta_pool = np.where(self._kind_of_pool() == KIND_PASS, delta_pass, delta_run)
        theta = np.zeros(self.n_pools)
        e = self.item_epa
        starts = self.offsets[:-1]
        base_mean = np.add.reduceat(e, starts) / np.diff(self.offsets)
        target = base_mean + delta_pool
        for _ in range(4):  # Newton iterations on the tilt parameter
            w = self._weights(theta)
            sw = np.add.reduceat(w, starts)
            m1 = np.add.reduceat(w * e, starts) / sw
            m2 = np.add.reduceat(w * e * e, starts) / sw
            var = np.maximum(m2 - m1 ** 2, 1e-6)
            theta = np.clip(theta + (target - m1) / var, -1.5, 1.5)
        w = self._weights(theta)
        prob = w / np.add.reduceat(w, starts)[self.pool_id]
        cum = np.cumsum(prob)
        start = np.concatenate([[0.0], cum[self.offsets[1:-1] - 1]])
        cdf = self.pool_id + np.minimum(cum - start[self.pool_id], 1.0 - 1e-12)
        return cdf, prob

    def _weights(self, theta):
        z = theta[self.pool_id] * self.item_epa
        z -= np.maximum.reduceat(z, self.offsets[:-1])[self.pool_id]
        return np.exp(z)

    def _kind_of_pool(self) -> np.ndarray:
        if not hasattr(self, "_kop"):
            kinds = self.lib["kind"].to_numpy()
            self._kop = kinds[self.items[self.offsets[:-1]]]
        return self._kop

    def sample(self, cdf: np.ndarray, kind: np.ndarray, fine: np.ndarray, u: np.ndarray) -> np.ndarray:
        """Return library row indices for each (kind, fine bucket, uniform)."""
        pool = self.pool_of[kind, fine]
        pos = np.searchsorted(cdf, pool + u, side="left")
        pos = np.clip(pos, self.offsets[pool], self.offsets[pool + 1] - 1)
        return self.items[pos]

    # ------------------------------------------------ clock-aware resampling ---
    def clock_stop_subset(self):
        """Pass plays that stop the clock and nothing else: incompletions and catches out of bounds.

        Returns positions into ``items`` (grouped by pool) and per-pool offsets into that list.
        """
        if not hasattr(self, "_stop"):
            it = self.items
            f = lambda k: self.arr[k][it].astype(bool)
            ok = (f("incomplete") | f("oob")) & ~f("penalty") & ~f("turnover") & ~f("td_off") & ~f("td_def") \
                & ~f("safety") & (self._kind_of_pool() == KIND_PASS)[self.pool_id]
            pos = np.flatnonzero(ok)
            self._stop = (pos, np.searchsorted(self.pool_id[pos], np.arange(self.n_pools + 1)))
        return self._stop

    def subset_cdf(self, prob: np.ndarray, pos: np.ndarray, offsets: np.ndarray) -> np.ndarray:
        """Pool-offset CDF over a subset of item positions, weighted by the (tilted) item probabilities."""
        pool = self.pool_id[pos]
        cum = np.concatenate([[0.0], np.cumsum(prob[pos])])
        tot = cum[offsets[1:]] - cum[offsets[:-1]]
        within = (cum[1:] - cum[offsets[pool]]) / np.maximum(tot[pool], 1e-300)
        return pool + np.minimum(within, 1.0 - 1e-12)

    def sample_subset(self, cdf, pos, offsets, pool, u) -> np.ndarray:
        """Library rows drawn from the subset of each pool; -1 where a pool has no such plays."""
        lo, hi = offsets[pool], offsets[pool + 1]
        j = np.clip(np.searchsorted(cdf, pool + u, side="left"), lo, np.maximum(hi - 1, lo))
        return np.where(hi > lo, self.items[pos[np.minimum(j, len(pos) - 1)]], -1)

    def conversion_table(self, prob: np.ndarray, pass_shift: float = 0.0) -> np.ndarray:
        """P(gain >= ytg or auto first down or TD) on 4th down: [mode, zone, ytg(0..20)]."""
        conv = np.zeros((N_MODE, N_ZONE, 21))
        pw = prob
        yards = self.arr["yards"][self.items]
        ok_any = self.arr["auto_fd"][self.items] | self.arr["td_off"][self.items]
        bad = self.arr["turnover"][self.items]
        for mode in range(N_MODE):
            for zone in range(N_ZONE):
                for ytg in range(1, 21):
                    fk = ((mode * N_DOWN + 2) * N_YTG + ytg_bucket(ytg)) * N_ZONE + zone
                    p = 0.0
                    rate = self.pass_rate[fk]
                    rate = 1 / (1 + np.exp(-(np.log(rate / (1 - rate)) + pass_shift)))
                    for kind, share in ((KIND_PASS, rate), (KIND_RUN, 1 - rate)):
                        pool = self.pool_of[kind, fk]
                        sl = slice(self.offsets[pool], self.offsets[pool + 1])
                        ok = ((yards[sl] >= ytg) | ok_any[sl]) & ~bad[sl]
                        p += share * float(np.sum(pw[sl] * ok))
                    conv[mode, zone, ytg] = p
        conv[:, :, 0] = conv[:, :, 1]
        return conv
