"""The daily game's matchup table (engine.js MATCH) as measured on the real plays the game draws from.

    python scripts/matchup_table.py [web dir]       # needs playbook.json and playbook_test.json (dailygame.build)

For each play: its EPA (clipped at +-3, as the engine tilts) minus the mean of its call's plays in the same situation
(engine fine key: game mode, down, distance, field zone), so a look's gap is not its situation's (loaded boxes come on
short yardage and at the goal line). Then by family of calls and the defense's look (engine.js lookBucket / LOOK_DEF:
soft = a light box with nobody blitzing, blitz = any box with a blitz, load = a loaded box without one), double-centered
with the plays as weights: what a matchup adds is the interaction (which calls do better or worse against a look than
calls do against it in general); the real plays a look draws already carry its own effect on every call.

The table: the data's sign at +-1 where it is clear (|z| >= 2), +-0.5 where it leans (1.5 <= |z| < 2); elsewhere
football logic (FOOTBALL) at +-0.5, or 0 where the data points the other way (|z| >= 0.5). Penalties (no call) and
plays without a box count are left out.
"""
from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

LOOKS = ("blitz", "load", "soft")
FAMILIES = {"run": ("rb_out_strong", "rb_out_weak", "rb_tackle_strong", "rb_tackle_weak", "rb_inside_strong",
                    "rb_inside_weak", "rb_middle"),
            "qb_sneak": ("qb_sneak",), "qb_run": ("qb_run",), "rpo": ("rpo_strong", "rpo_weak"),
            "quick": ("quick_strong", "quick_weak", "quick_middle"), "screen": ("screen",),
            "deep": ("deep_strong", "deep_weak", "deep_middle"), "pa_short": ("pa_short",), "pa_deep": ("pa_deep",),
            "roll": ("roll_strong", "roll_weak"), "hail_mary": ("hail_mary",), "trick_flea": ("trick_flea",),
            "trick_reverse": ("trick_reverse",), "trick_pass": ("trick_pass",), "trick_direct": ("trick_direct",)}
# the sign football logic gives each matchup (blitz, load, soft), used only where the data cannot tell
FOOTBALL = {"run": (0, -1, 1), "qb_sneak": (0, -1, 1), "qb_run": (1, -1, 1), "rpo": (1, 1, 1), "quick": (1, 1, 1),
            "screen": (1, 1, 1), "deep": (-1, 1, -1), "pa_short": (-1, 1, 0), "pa_deep": (-1, 1, -1),
            "roll": (-1, 1, 0), "hail_mary": (0, 0, 0), "trick_flea": (-1, 1, -1), "trick_pass": (-1, 1, -1),
            "trick_reverse": (1, -1, 0), "trick_direct": (0, -1, 1)}


def _arr(x):
    return np.frombuffer(base64.b64decode(x["b64"]), dtype=x["dtype"])[: x["n"]]


def plays(web: Path) -> pd.DataFrame:
    pb = json.loads((web / "playbook.json").read_text())
    t = json.loads((web / "playbook_test.json").read_text())
    R = {k: _arr(v) for k, v in pb["rows"].items()}
    ids = [c["id"] for c in pb["calls"]]
    fam = {c: f for f, cs in FAMILIES.items() for c in cs}
    look = R["look"].astype(int)
    box, blitz = look >> 4, (look >> 3) & 1
    d = pd.DataFrame({"fam": [fam[ids[c]] for c in _arr(t["call"])], "call": _arr(t["call"]).astype(int),
                      "fine": _arr(t["fine"]).astype(int), "epa": np.clip(R["epa"].astype(float), -3, 3),
                      "pen": (R["flags"].astype(int) & 1) == 1, "box": box,
                      "look": np.where(blitz == 1, "blitz", np.where(box >= 7, "load", "soft"))})
    d = d[~d["pen"] & (d["box"] > 0) & np.isfinite(d["epa"])].copy()
    d["r"] = d["epa"] - d.groupby(["call", "fine"])["epa"].transform("mean")
    return d


def interaction(d: pd.DataFrame):
    g = d.groupby(["fam", "look"])["r"]
    fams = list(FAMILIES)
    N = g.size().unstack().reindex(index=fams, columns=LOOKS).fillna(0)
    M = g.mean().unstack().reindex(index=fams, columns=LOOKS).where(N >= 10)
    SE = (g.std().unstack().reindex(index=fams, columns=LOOKS) / np.sqrt(N)).where(N >= 10)
    X = M.copy()
    for _ in range(100):
        X = X - (X.fillna(0) * N).sum() / N.where(X.notna(), 0).sum()
        X = X.sub((X.fillna(0) * N).sum(axis=1) / N.where(X.notna(), 0).sum(axis=1), axis=0)
    return X, X / SE, N


def table(X: pd.DataFrame, Z: pd.DataFrame) -> dict:
    out = {}
    for f, foot in FOOTBALL.items():
        row = {}
        for k, fb in zip(LOOKS, foot):
            z = Z.loc[f, k]
            z = None if pd.isna(z) else float(z)
            if z is not None and abs(z) >= 2:
                s = math.copysign(1, z)
            elif z is not None and abs(z) >= 1.5:
                s = math.copysign(0.5, z)
            elif z is not None and abs(z) >= 0.5 and fb and (z > 0) != (fb > 0):
                s = 0.0
            else:
                s = 0.5 * fb
            row[k] = s + 0.0
        out[f] = row
    return out


def main(web: Path) -> None:
    d = plays(web)
    X, Z, N = interaction(d)
    T = table(X, Z)
    print(f"{len(d)} real plays with a box count; the interaction in EPA [z], and the table")
    for f in FAMILIES:
        cells = "  ".join(f"{k} {X.loc[f, k]:+.3f} [{Z.loc[f, k]:+.1f}] n {int(N.loc[f, k]):5d}" if pd.notna(X.loc[f, k])
                          else f"{k}   n/a" + " " * 21 for k in LOOKS)
        print(f"{f:14s} {cells}  ->  " + ", ".join(f"{k}: {T[f][k]:g}" for k in LOOKS))


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "web"))
