"""The whole college build (python -m nflclock.cfb build), stage by stage, with the numbers each stage is checked on."""
from __future__ import annotations

import gzip
import json
import time
from dataclasses import fields

import numpy as np
import pandas as pd

from ..dailygame import receive2h_of
from ..models import Bundle
from ..sim import GameContext
from . import config as K
from . import data as D
from . import drills as DR
from . import export as EX
from . import models as M
from . import overlay as OV
from . import tendency as TD


def _log(t0):
    return lambda *a: print(f"[{time.time() - t0:6.0f}s]", *a, flush=True)


def has_rules() -> bool:
    """WS1's GameContext(rules=...) is in the simulator."""
    return "rules" in {f.name for f in fields(GameContext)}


def gz_size(path) -> int:
    return len(gzip.compress(path.read_bytes(), 9))


def _title(sp: dict, names: dict) -> tuple[str, str]:
    st, me = sp["start"], sp["player"]
    home = sp["home"] == me
    my, op = (st["score"][1], st["score"][0]) if home else (st["score"][0], st["score"][1])
    lead = "Tied" if my == op else (f"Up {my - op}" if my > op else f"Down {op - my}")
    clock = DR.clock_text(st["clock"])
    q = "Q4" if st["qtr"] == 4 else f"Q{st['qtr']}"
    if st["phase"] == "pat":
        what = "after a touchdown"
    elif st["phase"] == "kickoff":
        what = "kicking off"
    elif sp["side"] == "def":
        yl = int(round(st["yl"]))
        what = "on defense, ball at the 50" if yl == 50 else f"on defense, ball at {'their' if yl > 50 else 'your'} {yl if yl < 50 else 100 - yl}"
    else:
        what = DR._down_text(st["down"], st["ytg"], st["yl"])
    sub = f"{DR.season_line(sp)} · {names.get(sp['away'], sp['away'])} at {names.get(sp['home'], sp['home'])}"
    return f"{lead}, {q} {clock}, {what}", sub


def assemble(rows: pd.DataFrame, e: pd.DataFrame, bundle, teams: pd.DataFrame, rules: str, classic_meta=None) -> list:
    """Spot, teams and the real story for each selected row."""
    receive2h = receive2h_of(e[e["game_id"].isin(rows["game_id"].unique())])
    names = {str(r["abbreviation"]): school for school, r in teams.iterrows()}
    by_game = {g: x for g, x in e[e["game_id"].isin(rows["game_id"].unique())].groupby("game_id")}
    tr = bundle.team_ratings
    out, small, recs = [], {}, {}
    for _, r in rows.iterrows():
        g = by_game[r["game_id"]]
        sp = DR.spot_record(r, teams, receive2h, rules)
        lg = tr[(tr["season"] == sp["real"]["season"]) & (tr["week"] == sp["real"]["week"])]
        if not len(lg):
            lg = tr[tr["season"] == sp["real"]["season"]]
        sp["league"] = {k: round(float(lg.iloc[0][k]), 5) for k in ("mu_pass", "mu_rush", "home_pass", "home_rush")} if len(lg) else {}
        season, week = int(r["season"]), int(r["week"])
        gs = small.get(r["game_id"])
        if gs is None:
            gs = small[r["game_id"]] = g[[c for c in DR.TEAM_COLS if c in g]].astype(object)
        tm = {}
        for side in ("home", "away"):
            key = (r["game_id"], r[f"{side}_team"], season, week)
            if key not in recs:
                recs[key] = DR.team_record(bundle, gs, r[f"{side}_team"], season, week, teams)
            tm[side] = recs[key]
        start_idx = g.index[g["row_order"] == r["row_order"]][0]
        acts, _ = DR.real_actions(g, start_idx, r["player"], teams)
        f = sp["real"]["final"]
        me_home = sp["player"] == sp["home"]
        won = (f["home"] > f["away"]) if me_home else (f["away"] > f["home"])
        result = {"drive": sp["real"]["drive"], "final": f, "won": bool(won)}
        meta_c = (classic_meta or {}).get(r["spot_id"])
        real = {"coach": None, "story": meta_c["story"] if meta_c else DR.story(sp, teams, names, result),
                "actions": acts, "result": result}
        title, sub = _title(sp, names)
        tags = (["recent"] if season >= DR.RECENT else ["rules2022"]) + (["postseason"] if sp["real"]["type"] == "POST" else [])
        meta = {"id": sp["id"], "cat": r["category"], "title": meta_c["title"] if meta_c else title, "sub": sub,
                "season": season, "week": week, "home": sp["home"], "away": sp["away"], "player": sp["player"],
                "side": sp["side"], "diff": 3, "lev": 0.0, "wp0": round(float(np.nan_to_num(r.get("wp", 0.5), nan=0.5)), 4),
                "classic": bool(meta_c), "tags": tags + (["classic"] if meta_c else [])}
        out.append({"meta": meta, "spot": sp, "teams": tm, "real": real, "row": r})
    return out


def classic_rows(e: pd.DataFrame) -> tuple[pd.DataFrame, dict, list]:
    found = DR.classic(e)
    rows, meta, missing = [], {}, []
    for c in found:
        if not c.get("found"):
            missing.append(c["key"])
            continue
        r = e.loc[c["row"]].copy()
        r["category"], r["phase"] = c["cat"], c["phase"]
        r["side"] = c.get("side", "off")
        r["player"] = c.get("player", r["posteam"] if c["phase"] != "kickoff" else r["defteam"])
        r["drive"] = -1
        r["spot_id"] = f"{r['game_id']}#{int(r['play_id'])}"
        rows.append(r)
        meta[r["spot_id"]] = {"title": c["title"], "story": c["story"]}
    return (pd.DataFrame(rows) if rows else pd.DataFrame()), meta, missing


def make_drills(e: pd.DataFrame, bundle, rules: str, diff_rules: str, difficulty: bool, workers: int, log) -> tuple[list, dict]:
    g = e[e["fbs"] & ~e["clock_bad"]]
    cand = DR.candidates(g)
    rep = {"candidates": {k: int(v) for k, v in cand["category"].value_counts().items()}}
    sel = DR.select(cand)
    teams = D.teams(e)
    cr, cmeta, missing = classic_rows(e)
    rep["classic_missing"] = missing
    order = list(DR.CATEGORIES)
    sel = sel.assign(o=sel["category"].map(order.index)).sort_values(["o", "season", "game_id"], ascending=[True, False, True])
    rows = pd.concat([sel, cr], ignore_index=True) if len(cr) else sel
    log(f"assembling {len(rows)} drills ...")
    drills = assemble(rows, e, bundle, teams, rules, cmeta)
    if difficulty:
        games = e[e["game_id"].isin(rows["game_id"].unique())]
        res = DR.difficulty([d["spot"] for d in drills], games, K.BUNDLE, DR.fourth_model(e), diff_rules if diff_rules != "nfl" else None,
                            workers=workers, log=log)
        for i, d in enumerate(drills):
            if i in res:
                d["meta"]["wp0"], d["meta"]["lev"] = round(res[i][0], 4), round(res[i][1], 4)
    idx = pd.DataFrame([{"cat": d["meta"]["cat"], "lev": d["meta"]["lev"], "wp0": d["meta"]["wp0"]} for d in drills])
    if len(idx):
        diff = DR.grade(idx) if difficulty else np.full(len(idx), 3)
        for d, v in zip(drills, diff):
            d["meta"]["diff"] = int(v)
    for d in drills:
        d.pop("row", None)
    rep["by_category"] = {k: int(v) for k, v in pd.Series([d["meta"]["cat"] for d in drills]).value_counts().items()}
    rep["classic"] = int(sum(d["meta"]["classic"] for d in drills))
    return drills, rep


def build(rules="ncaa2026", diff_rules="auto", refresh_current=False, difficulty=True, hs=True, workers=4) -> dict:
    t0 = time.time()
    log = _log(t0)
    D.download(force_current=refresh_current, log=log)
    e = D.load(K.SEASONS)
    log(f"college play-by-play: {len(e):,} rows, {e['game_id'].nunique():,} games")
    bundle, rep = M.build(e, log=log, workers=workers)
    bundle.save(K.BUNDLE)
    K.WEB.mkdir(exist_ok=True)
    sizes = {}
    sizes["engine_data_cfb.json"] = EX.engine(bundle)
    pb = K.WEB / "playbook.json"
    if pb.exists():
        log("overlay ...")
        rep["overlay"] = OV.build(pb, bundle.lib.lib, K.WEB / "cfb_overlay.json", log=log)
        sizes["cfb_overlay.json"] = (K.WEB / "cfb_overlay.json").stat().st_size
    else:
        rep["overlay"] = "skipped: web/playbook.json missing (run dailygame.build first)"
    log("tendency models ...")
    tend, rep["tendency"] = TD.fit(e)
    if diff_rules == "auto":
        diff_rules = rules if has_rules() else "nfl"
    log(f"drills (difficulty under {diff_rules} rules) ...")
    drills, rep["drills"] = make_drills(e, bundle, rules, diff_rules, difficulty, workers, log)
    label = diff_rules if diff_rules != "nfl" else "nfl-provisional"
    rep["export"] = EX.write(drills, {"tendency": tend}, D.teams(e), bundle.team_ratings, rules, label if difficulty else "none")
    rep["drills_by_category"] = rep["drills"]["by_category"]
    if hs:
        from . import hs as HS
        log("high-school level ...")
        rep["hs"] = HS.build(e, bundle, tend, workers=workers, difficulty=difficulty, log=log)
    for name in ("engine_data_cfb.json", "cfb_overlay.json", "coach.json", "engine_data_hs.json", "coach_hs.json"):
        p = K.WEB / name
        if p.exists():
            sizes[name] = {"bytes": p.stat().st_size, "gzip": gz_size(p)}
    chunks = sorted((K.WEB / "drills").glob("c*.json"))
    if chunks:
        sizes["drills"] = {"files": len(chunks), "max_bytes": max(p.stat().st_size for p in chunks),
                           "median_gzip": int(np.median([gz_size(p) for p in chunks]))}
    rep["sizes"] = sizes
    log("done")
    return rep


def redo_difficulty(rules="ncaa2026", workers=4, level="cfb") -> dict:
    """Difficulty again on the built drills (once WS1's GameContext(rules) is in the simulator): rewrites the index's
    diff, lev, wp0 and diff_rules; the drill files are unchanged. level "hs": the high-school set (generic teams)."""
    t0 = time.time()
    log = _log(t0)
    hs = level == "hs"
    path = K.WEB / ("coach_hs.json" if hs else "coach.json")
    coach = json.loads(path.read_text())
    prefix = "hs_" if hs else ""
    spots, chunks = [], {}
    for d in coach["drills"]:
        k = d["i"] // coach["drill_chunk"]
        if k not in chunks:
            chunks[k] = json.loads((K.WEB / "drills" / f"{prefix}c{k}.json").read_text())
        spots.append(chunks[k][str(d["i"])]["spot"])
    e = D.load(K.SEASONS)
    games = None if hs else e[e["game_id"].isin({s["id"].split("#")[0] for s in spots})]
    diff_rules = rules if has_rules() else "nfl"
    res = DR.difficulty(spots, games, K.BUNDLE_HS if hs else K.BUNDLE, DR.fourth_model(e),
                        diff_rules if diff_rules != "nfl" else None, workers=workers, log=log)
    for i, d in enumerate(coach["drills"]):
        if i in res:
            d["wp0"], d["lev"] = round(res[i][0], 4), round(res[i][1], 4)
    idx = pd.DataFrame([{"cat": d["cat"], "lev": d["lev"], "wp0": d["wp0"]} for d in coach["drills"]])
    for d, v in zip(coach["drills"], DR.grade(idx)):
        d["diff"] = int(v)
    coach["diff_rules"] = diff_rules if diff_rules != "nfl" else "nfl-provisional"
    path.write_text(json.dumps(coach, separators=(",", ":"), allow_nan=False))
    return {"level": level, "diff_rules": coach["diff_rules"], "drills": len(coach["drills"]),
            "diff_counts": {int(k): int(v) for k, v in pd.Series([d["diff"] for d in coach["drills"]]).value_counts().items()}}
