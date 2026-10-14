"""Export everything the browser engine (web/engine.js) needs into one JSON file of base64 typed arrays.

The browser engine is a line-for-line port of sim.py; this module ships it the same data the Python
simulator uses (play library, tempo, punts, kickoffs, FG model, the LightGBM WP trees) plus the
live game record from `nflclock sync`.
"""
from __future__ import annotations

import base64
import json

import numpy as np

from . import config, library as L
from .models import Bundle

WEB_DIR = config.ROOT / "web"
FLAG_BITS = ["penalty", "auto_fd", "incomplete", "oob", "td_off", "td_def", "turnover", "safety"]


def _b64(arr: np.ndarray) -> dict:
    arr = np.ascontiguousarray(arr)
    return {"dtype": arr.dtype.name, "n": int(arr.size), "b64": base64.b64encode(arr.tobytes()).decode("ascii")}


def _trees(booster) -> dict:
    """Flatten LightGBM trees: per node feature (-1 = leaf), threshold, left, right, leaf value."""
    dump = booster.dump_model()
    feat, thr, left, right, val, roots = [], [], [], [], [], []

    def add(node) -> int:
        idx = len(feat)
        feat.append(-1)
        thr.append(0.0)
        left.append(-1)
        right.append(-1)
        val.append(0.0)
        if "split_index" in node:
            assert node["decision_type"] == "<=" and node["missing_type"] == "None"
            feat[idx] = node["split_feature"]
            thr[idx] = node["threshold"]
            left[idx] = add(node["left_child"])
            right[idx] = add(node["right_child"])
        else:
            val[idx] = node["leaf_value"]
        return idx

    for t in dump["tree_info"]:
        roots.append(add(t["tree_structure"]))
    return {
        "feature_names": dump["feature_names"],
        "feature": _b64(np.array(feat, np.int8)), "threshold": _b64(np.array(thr, np.float64)),
        "left": _b64(np.array(left, np.int32)), "right": _b64(np.array(right, np.int32)),
        "value": _b64(np.array(val, np.float64)), "roots": _b64(np.array(roots, np.int32)),
    }


def export_engine(bundle: Bundle | None = None, path=None) -> dict:
    b = bundle or Bundle.load()
    lib = b.lib
    a = lib.arr
    flags = np.zeros(len(a["yards"]), np.uint8)
    for bit, name in enumerate(FLAG_BITS):
        flags |= (a[name].astype(bool).astype(np.uint8) << bit)
    kinds = lib.lib["kind"].to_numpy()
    out = {
        "version": 1,
        "constants": {**b.consts, "n_fine": L.N_FINE, "zone_edges": L.ZONE_EDGES.tolist(),
                      "ytg_edges": L.YTG_EDGES.tolist(), "mean_epa": {str(k): v for k, v in lib.mean_epa.items()}},
        "lib": {
            "yards": _b64(a["yards"].astype(np.int8)),
            "flags": _b64(flags),
            "to_rel": _b64(a["to_rel"].astype(np.int8)),
            "dur10": _b64(np.round(a["duration"] * 10).astype(np.uint8)),
            "epa": _b64(a["epa"].astype(np.float32)),
            "items": _b64(lib.items.astype(np.int32)),
            "offsets": _b64(lib.offsets.astype(np.int32)),
            "pool_of": _b64(lib.pool_of.astype(np.int16).ravel()),
            "pool_kind": _b64(kinds[lib.items[lib.offsets[:-1]]].astype(np.uint8)),
            "pass_rate": _b64(lib.pass_rate.astype(np.float64)),
        },
        "tempo": {k: _b64(np.round(np.asarray(v) * 10).astype(np.uint16)) for k, v in b.tempo.items()},
        "punts": {
            "yl": _b64(b.punts["yl"].astype(np.uint8)), "net": _b64(b.punts["net"].astype(np.int8)),
            "flags": _b64((b.punts["ret_td"].astype(np.uint8) | (b.punts["blocked"].astype(np.uint8) << 1)
                           | (b.punts["touchback"].astype(np.uint8) << 2))),
            "dur10": _b64(np.round(b.punts["duration"] * 10).astype(np.uint8)),
        },
        "kickoffs": {
            "start_yl": _b64(b.kickoffs["start_yl"].astype(np.uint8)),
            "dur10": _b64(np.round(b.kickoffs["duration"] * 10).astype(np.uint8)),
            "ret_td": _b64(b.kickoffs["ret_td"].astype(np.uint8)),
        },
        "fg": {"coef": b.fg_model.coef_[0].tolist(), "intercept": float(b.fg_model.intercept_[0])},
        "wp": _trees(b.wp.booster),
    }
    WEB_DIR.mkdir(exist_ok=True)
    path = path or WEB_DIR / "engine_data.json"
    path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    return out


def export_game(game_id: str, extra: dict | None = None, path=None) -> dict:
    """Copy the live game record next to the engine, with grade scales / tendencies if available."""
    from . import live
    rec = live.load_game(game_id)
    for name in ("grade_scale.json", "tendency_web.json", "coach_profiles.json"):
        p = config.ARTIFACT_DIR / name
        if p.exists():
            rec[name.split(".")[0]] = json.loads(p.read_text())
    card = config.ARTIFACT_DIR / f"gamecard_{game_id}.json"
    if card.exists():
        rec["gamecard"] = json.loads(card.read_text())
    rec.update(extra or {})
    WEB_DIR.mkdir(exist_ok=True)
    path = path or WEB_DIR / f"{game_id}.json"
    path.write_text(json.dumps(rec, separators=(",", ":"), default=str, allow_nan=False))
    return rec
