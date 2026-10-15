"""Pro: the historic drives (pro_drives.json), in the daily game's spot format, from any season since 1999.

Each drive is a first-down snap of a famous late drive with its story. The build goes season by season (each
season's play-by-play with the two before it, for its team ratings, and its own History), and writes
web/pro/drives.json (the drives, each pointing at its spot, and the spots) and web/pro/d{k}.json (the two teams
of each spot, chunked like web/spots). The website serves them to Pro players (the Drives screen)."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from . import config, data
from . import dailygame as DG
from . import history as HI
from . import playbook as P
from . import players as PL
from .models import Bundle

DRIVES = Path(__file__).with_name("pro_drives.json")
OUT = DG.WEB / "pro"


def build(bundle=None, lib=None) -> dict:
    bundle = bundle or Bundle.load()
    lib = lib if lib is not None else P.labeled_plays()
    drives = json.loads(DRIVES.read_text(encoding="utf-8"))
    games = pd.read_csv(config.RAW_DIR / "games.csv").set_index("game_id")
    spots: dict = {}
    for season in sorted({int(d["id"][:4]) for d in drives}):
        mine = [d for d in drives if int(d["id"][:4]) == season]
        pbp = data.load(tuple(PL.pbp_seasons(range(season - 2, season + 1))))
        keep = {d["id"]: "drill" for d in mine}
        cand = DG.candidates(pbp, lib, keep=keep).drop_duplicates("spot_id").set_index("spot_id", drop=False)
        missing = [d["id"] for d in mine if d["id"] not in cand.index]
        if missing:
            raise RuntimeError(f"drives missing from the {season} data: {missing}")
        receive2h = DG.receive2h_of(pbp)
        hist = HI.History(bundle, lib, seasons=(season,), pbp=pbp)
        season_spots = [DG.spot_record(cand.loc[d["id"]], games.loc[d["id"].split("#")[0]], receive2h) for d in mine]
        teams = DG.team_chunks(hist, season_spots, games, chunk=10 ** 6)[0]
        for d, sp, k in zip(mine, season_spots, sorted(teams, key=int)):
            spots[d["id"]] = (sp, teams[k])
    order = [d["id"] for d in drives]
    out = {"drives": [{"title": d["title"], "note": d["note"], "spot": i} for i, d in enumerate(drives)],
           "spots": [spots[i][0] for i in order], "spot_chunk": DG.SPOT_CHUNK,
           "built": pd.Timestamp.now(tz="UTC").isoformat(timespec="seconds")}
    chunks: dict = {}
    for i, sid in enumerate(order):
        chunks.setdefault(i // DG.SPOT_CHUNK, {})[str(i)] = spots[sid][1]
    for bad in DG._nan_paths(out) + [f"d{k}:{q}" for k, ch in chunks.items() for q in DG._nan_paths(ch)]:
        raise ValueError(f"not a number in the export: {bad}")
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):
        stale.unlink()
    (OUT / "drives.json").write_text(json.dumps(out, separators=(",", ":"), default=float, allow_nan=False))
    for k, ch in chunks.items():
        (OUT / f"d{k}.json").write_text(json.dumps(ch, separators=(",", ":"), default=float, allow_nan=False))
    return {"drives": len(drives), "chunks": len(chunks)}
