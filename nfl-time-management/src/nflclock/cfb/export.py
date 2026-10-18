"""Coach mode's web files: web/engine_data_cfb.json (the college bundle in the engine's format), web/coach.json (the
index) and web/drills/c<k>.json (the drills, DRILL_CHUNK a file). All generated, never committed."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .. import playbook as P
from .. import webexport as WX
from ..dailygame import _nan_paths
from . import config as K
from . import drills as DR

SKILLS = {"clock": {"label": "Clock management"}, "fourth": {"label": "Fourth downs"}, "two_min": {"label": "Two-minute"},
          "four_min": {"label": "Four-minute"}, "red_zone": {"label": "Red zone"}, "two_pt": {"label": "Tries"},
          "calls": {"label": "Play calls"}}


def _dump(obj, path) -> int:
    bad = _nan_paths(obj)
    if bad:
        raise ValueError(f"not a number in {path.name}: {bad[:5]}")
    path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False, default=float))
    return path.stat().st_size


def engine(bundle, path=None) -> int:
    path = path or K.WEB / "engine_data_cfb.json"
    WX.export_engine(bundle, path)
    return path.stat().st_size


def calls() -> list:
    out = []
    for c, label, kind, say in P.CALLS:
        b, side = P.base_side(c)
        out.append({"id": c, "label": label, "kind": kind, "say": say, "family": P.FAMILY[c], "base": b, "side": side})
    return out


def league(tr: pd.DataFrame) -> dict:
    out = {}
    for s, g in tr.groupby("season"):
        last = g[g["week"] == g["week"].max()].iloc[0]
        out[str(int(s))] = {k: round(float(last[k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")}
    return out


def checkride(index: list, spec: dict) -> dict:
    """12 drills: per spec, recent seasons, middle difficulty (3-4), distinct games."""
    picks, games = [], set()
    for cat, n in spec["per_category"].items():
        cand = sorted([d for d in index if d["cat"] == cat and not d["classic"]],
                      key=lambda d: (-(d["season"] >= DR.RECENT), abs(d["diff"] - 3.5), -abs(d["lev"]), d["id"]))
        k = 0
        for d in cand:
            if k >= n:
                break
            g = d["id"].split("#")[0]
            if g in games:
                continue
            games.add(g)
            picks.append(d["id"])
            k += 1
    return {"version": spec["version"], "drills": picks, "seed": spec["seed"], "pass": spec["pass"]}


def write(drills: list, models: dict, teams: pd.DataFrame, tr: pd.DataFrame, rules: str, diff_rules: str,
          extra: dict | None = None, web=None, prefix: str = "", level: str = "fbs") -> dict:
    """drills: [{"meta": index row, "spot":, "teams":, "real":}] in order. Writes coach.json and the chunks."""
    web = web or K.WEB
    ddir = web / "drills"
    ddir.mkdir(parents=True, exist_ok=True)
    for stale in ddir.glob(f"{prefix}c*.json"):
        if stale.name[len(prefix) + 1:-5].isdigit():
            stale.unlink()
    chunks: dict = {}
    index = []
    for i, d in enumerate(drills):
        m = dict(d["meta"])
        m["i"] = i
        index.append(m)
        chunks.setdefault(i // DR.DRILL_CHUNK, {})[str(i)] = {"spot": d["spot"], "teams": d["teams"], "real": d["real"]}
    sizes = [_dump(ch, ddir / f"{prefix}c{k}.json") for k, ch in chunks.items()]
    spec = json.loads((K.PKG / "checkride.json").read_text())
    used = {d["spot"]["home"] for d in drills} | {d["spot"]["away"] for d in drills}
    names = {str(r["abbreviation"]): {"name": school, "mascot": None if pd.isna(r["mascot"]) else str(r["mascot"])}
             for school, r in teams.iterrows() if str(r["abbreviation"]) in used}
    out = {"version": 1, "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds"), "rules": rules, "level": level,
           "diff_rules": diff_rules,
           "seasons": {"lib": [min(K.LIB_SEASONS), max(K.LIB_SEASONS)], "wp": [min(K.WP_SEASONS), max(K.WP_SEASONS)],
                       "drills": [int(min(d["season"] for d in index)), int(max(d["season"] for d in index))] if index else []},
           "calls": calls(), "categories": DR.CATEGORIES, "skills": SKILLS, "drills": index, "drill_chunk": DR.DRILL_CHUNK,
           "checkride": checkride(index, spec), "models": models, "teams": names, "league": league(tr)}
    out.update(extra or {})
    size = _dump(out, web / ("coach.json" if not prefix else f"coach_{prefix.rstrip('_')}.json"))
    return {"coach_json_bytes": size, "chunks": len(sizes), "chunk_bytes_max": max(sizes) if sizes else 0,
            "chunk_bytes_median": int(np.median(sizes)) if sizes else 0, "drills": len(index)}
