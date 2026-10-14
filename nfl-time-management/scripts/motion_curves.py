# Where each position group is over time on pass and run plays (depth past the line of scrimmage in the
# offense's direction, and lateral spread from the ball), event timings after the snap, and how ball carriers
# and tacklers move, from the 2017 Big Data Bowl sample game and NGS highlight plays.
# Usage: python3 -I curves.py <bdb dir> <highlights dir> <out json>
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
TS = np.round(np.arange(0, 6.01, 0.5), 2)
EVENTS = ["handoff", "pass_forward", "pass_arrived", "pass_outcome_caught", "pass_outcome_incomplete", "first_contact",
          "tackle", "out_of_bounds", "touchdown", "qb_sack", "run", "punt", "punt_received", "kickoff",
          "kick_received", "fair_catch", "field_goal", "extra_point", "play_action", "pass_shovel"]

plays = []      # one dict per play: kind, events (s after snap), tracks {group: [(t, depth, lateral, speed, offense)]}


def add_play(kind, frames, ev_of_frame, pos_of, off_of, ball=None):
    """frames: DataFrame with columns id, f, x, y, s; ev_of_frame: {frame: event}; pos_of/off_of: id -> group / offense."""
    snapf = [f for f, e in ev_of_frame.items() if e == "ball_snap"]
    if not snapf:
        return
    f0 = min(snapf)
    at0 = frames[frames["f"] == f0]
    qb = [i for i in at0["id"] if pos_of.get(i) == "QB" and off_of.get(i)]
    if ball is not None and len(ball[ball["f"] == f0]):
        bx, by = float(ball.loc[ball["f"] == f0, "x"].iloc[0]), float(ball.loc[ball["f"] == f0, "y"].iloc[0])
    else:
        c = at0[[pos_of.get(i) == "OL" for i in at0["id"]]]
        if not len(c):
            return
        bx, by = float(c["x"].mean()), float(c["y"].mean())
    if not qb:
        return
    qx = float(at0.loc[at0["id"] == qb[0], "x"].iloc[0])
    sgn = 1.0 if bx > qx else -1.0           # the offense moves toward +x when its QB is at lower x
    ev = {}
    for f, e in ev_of_frame.items():
        if f >= f0 and e not in ev:
            ev[e] = round((f - f0) / 10, 1)
    d = frames[frames["f"] >= f0].copy()
    d["t"] = (d["f"] - f0) / 10
    d["depth"] = (d["x"] - bx) * sgn
    d["lat"] = (d["y"] - by)
    d["g"] = [pos_of.get(i) for i in d["id"]]
    d["off"] = [off_of.get(i) for i in d["id"]]
    plays.append({"kind": kind, "ev": ev, "d": d[["id", "t", "depth", "lat", "s", "g", "off"]]})


# --- the Big Data Bowl sample game
pl = pd.read_csv(f"{BDB}/players.csv")
posmap = {k: GROUP.get(v) for k, v in zip(pl["nflId"], pl["PositionAbbr"])}
games = pd.read_csv(f"{BDB}/games.csv")
pinfo = pd.read_csv(f"{BDB}/plays.csv")
tr = pd.read_csv(glob.glob(f"{BDB}/tracking_gameId_*.csv")[0])
gid = int(tr["gameId"].iloc[0])
home = games.loc[games["gameId"] == gid, "homeTeamAbbr"].iloc[0]
pinfo = pinfo[pinfo["gameId"] == gid].set_index("playId")
for pid, d in tr.groupby("playId"):
    if pid not in pinfo.index:
        continue
    p = pinfo.loc[pid]
    if p["isSTPlay"]:
        kind = str(p["SpecialTeamsPlayType"]).lower()
    elif pd.notna(p["PassResult"]):
        kind = "pass"
    else:
        kind = "run"
    offense_home = p["possessionTeam"] == home
    d = d.rename(columns={"nflId": "id", "frame.id": "f"})
    ball = d[d["displayName"] == "football"]
    d = d[d["displayName"] != "football"]
    off = {i: ((t == "home") == offense_home) for i, t in zip(d["id"], d["team"])}
    evf = {int(f): e for f, e in zip(d["f"], d["event"]) if isinstance(e, str)}
    add_play(kind, d[["id", "f", "x", "y", "s"]], evf, posmap, off, ball[["f", "x", "y"]])
n_bdb = len(plays)

# --- NGS highlights
for fn in sorted(glob.glob(f"{HL}/*.tsv")):
    try:
        t = pd.read_csv(fn, sep="\t", usecols=["playType", "frame", "nflId", "position", "possessionFlag", "x", "y", "s",
                                                 "event", "displayName"])
    except Exception:
        continue
    kind = str(t["playType"].iloc[0]).replace("play_type_", "")
    ball = t[t["displayName"].astype(str).str.lower() == "football"].rename(columns={"frame": "f"})
    t = t[t["nflId"].notna()].rename(columns={"nflId": "id", "frame": "f"})
    pos = {i: GROUP.get(str(p)) for i, p in zip(t["id"], t["position"])}
    off = {i: bool(f == 1) for i, f in zip(t["id"], t["possessionFlag"])}
    evf = {int(f): e for f, e in zip(t["f"], t["event"]) if isinstance(e, str)}
    add_play(kind, t[["id", "f", "x", "y", "s"]], evf, pos, off, ball[["f", "x", "y"]] if len(ball) else None)

out = {"source": {"bdb_plays": n_bdb, "highlight_plays": len(plays) - n_bdb}, "kinds": {}, "events": {}, "curves": {}}
kinds = pd.Series([p["kind"] for p in plays]).value_counts()
out["kinds"] = kinds.to_dict()
# event timing after the snap, by play kind
for kind in ("pass", "run", "punt", "kickoff", "field_goal"):
    evs = {}
    for p in plays:
        if p["kind"] != kind:
            continue
        for e, t in p["ev"].items():
            evs.setdefault(e, []).append(t)
    out["events"][kind] = {e: {"n": len(v), "q25_50_75": np.round(np.quantile(v, [0.25, 0.5, 0.75]), 2).tolist()}
                           for e, v in evs.items() if e in EVENTS and len(v) >= 5}
# depth and lateral spread over time by group (median, quartiles), pass and run separately; BDB only (highlights
# are big plays, so their depth curves run long)
for kind in ("pass", "run"):
    rows = pd.concat([p["d"] for p in plays[:n_bdb] if p["kind"] == kind], ignore_index=True)
    rows = rows[rows["g"].notna()]
    rows["tb"] = (rows["t"] * 2).round() / 2
    cur = {}
    for g, dg in rows.groupby("g"):
        cur[g] = {}
        for tb in TS:
            x = dg[dg["tb"] == tb]
            if len(x) < 20:
                continue
            cur[g][str(tb)] = {"depth": np.round(x["depth"].quantile([0.25, 0.5, 0.75]).to_numpy(), 1).tolist(),
                               "abs_lat": round(float(x["lat"].abs().median()), 1),
                               "speed": np.round(x["s"].quantile([0.25, 0.5, 0.75]).to_numpy(), 1).tolist()}
    out["curves"][kind] = cur
json.dump(out, open(OUT, "w"), indent=1)
print(json.dumps(out["source"]), out["kinds"])
for k, v in out["events"].items():
    print(k, {e: (x["n"], x["q25_50_75"]) for e, x in v.items()})
for kind, cur in out["curves"].items():
    print("==", kind)
    for g, c in cur.items():
        print(f"  {g:3}", "  ".join(f"{t}:{c[t]['depth'][1]:+.1f}/{c[t]['speed'][1]:.1f}" for t in list(c)[:11]))
