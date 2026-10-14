# Kinematic envelope of NFL players by position group, from player tracking at 10 Hz:
#  - the 2017 Big Data Bowl sample game (every snap of one game) and
#  - NGS highlight plays 2017-2019 (asonty/ngs_highlights).
# For each group: per-play top speed quantiles, and by speed bin the 90/97/99th percentile of forward
# acceleration, braking and lateral (turning) acceleration, from positions smoothed over 3 frames.
# Usage: python3 -I envelope.py <bdb dir> <highlights dir> <out json>
# Data (public samples, not in git; download each into its own directory):
#   Big Data Bowl 2019 sample game: https://github.com/nfl-football-ops/Big-Data-Bowl (Data/: players.csv, games.csv,
#     plays.csv, tracking_gameId_2017090700.csv)
#   NGS highlight plays 2017-2019: https://github.com/asonty/ngs_highlights (play_data/*.tsv, listed in
#     utils/data/nfl_ngs_highlights_index.tsv)
# The constants in web/motion.js (ENV, CURVES) were read off this script's output.
import glob
import json
import sys

import numpy as np
import pandas as pd

BDB, HL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
GROUP = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE",
         "T": "OL", "G": "OL", "C": "OL", "OT": "OL", "OG": "OL", "OL": "OL",
         "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL",
         "OLB": "LB", "ILB": "LB", "MLB": "LB", "LB": "LB",
         "CB": "CB", "SS": "S", "FS": "S", "S": "S", "SAF": "S"}
DT = 0.1
BINS = np.arange(0, 11, 1.0)


def kin(x, y):
    """Speed, forward and lateral acceleration along one player's track (10 Hz), smoothed over 3 frames."""
    if len(x) < 7:
        return None
    k = np.ones(3) / 3
    xs, ys = np.convolve(x, k, "valid"), np.convolve(y, k, "valid")
    vx, vy = np.gradient(xs, DT), np.gradient(ys, DT)
    ax, ay = np.gradient(vx, DT), np.gradient(vy, DT)
    s = np.hypot(vx, vy)
    ux, uy = vx / np.maximum(s, 1e-6), vy / np.maximum(s, 1e-6)
    at = ax * ux + ay * uy
    an = np.abs(ax * uy - ay * ux)
    return s[2:-2], at[2:-2], an[2:-2]


rows, tops = [], []


def take(group, x, y, sp):
    r = kin(np.asarray(x, float), np.asarray(y, float))
    if r is None:
        return
    s, at, an = r
    rows.append(pd.DataFrame({"g": group, "s": s, "at": at, "an": an}))
    tops.append((group, float(np.nanmax(sp))))


# the Big Data Bowl sample game: snap to the end of each play
pl = pd.read_csv(f"{BDB}/players.csv")
pos = dict(zip(pl["nflId"], pl["PositionAbbr"]))
tr = pd.read_csv(glob.glob(f"{BDB}/tracking_gameId_*.csv")[0])
for (pid, nid), d in tr.groupby(["playId", "nflId"]):
    g = GROUP.get(pos.get(nid))
    if not g:
        continue
    d = d.sort_values("frame.id")
    ev = d["event"].fillna("").to_numpy()
    snap = np.flatnonzero(ev == "ball_snap")
    if not len(snap):
        continue
    d = d.iloc[snap[0]:]
    take(g, d["x"], d["y"], d["s"])
n_bdb = len(tops)

# NGS highlights
for f in sorted(glob.glob(f"{HL}/*.tsv")):
    try:
        t = pd.read_csv(f, sep="\t", usecols=["frame", "nflId", "position", "x", "y", "s", "event"])
    except Exception:
        continue
    for nid, d in t.groupby("nflId"):
        g = GROUP.get(str(d["position"].iloc[0]))
        if not g:
            continue
        d = d.sort_values("frame")
        ev = d["event"].fillna("").to_numpy()
        snap = np.flatnonzero(ev == "ball_snap")
        d = d.iloc[snap[0]:] if len(snap) else d
        take(g, d["x"], d["y"], d["s"])

R = pd.concat(rows, ignore_index=True)
R = R[np.isfinite(R["s"]) & (R["s"] < 12.5)]
T = pd.DataFrame(tops, columns=["g", "top"])
out = {"source": {"bdb_player_plays": n_bdb, "highlight_player_plays": len(tops) - n_bdb}, "groups": {}}
for g, d in R.groupby("g"):
    tq = T.loc[T["g"] == g, "top"].quantile([0.5, 0.75, 0.9, 0.97, 0.99]).round(2).tolist()
    e = {"top_speed_q50_75_90_97_99": tq, "bins": []}
    d = d.assign(b=np.digitize(d["s"], BINS) - 1)
    for b, db in d.groupby("b"):
        if len(db) < 200 or b >= len(BINS) - 1:
            continue
        fwd, brk = db["at"].clip(lower=0), (-db["at"]).clip(lower=0)
        lat = db["an"] if BINS[b] >= 1 else pd.Series(dtype=float)
        e["bins"].append({"v": float(BINS[b]), "n": int(len(db)),
                          "fwd": fwd.quantile([0.9, 0.97, 0.99]).round(2).tolist(),
                          "brake": brk.quantile([0.9, 0.97, 0.99]).round(2).tolist(),
                          "lat": lat.quantile([0.9, 0.97, 0.99]).round(2).tolist() if len(lat) else None})
    out["groups"][g] = e
json.dump(out, open(OUT, "w"), indent=1)
print(json.dumps(out["source"]))
for g, e in out["groups"].items():
    print(g, "top", e["top_speed_q50_75_90_97_99"])
    for b in e["bins"]:
        print(f"   v{b['v']:>4} n{b['n']:>7}  fwd {b['fwd']}  brake {b['brake']}  lat {b['lat']}")
