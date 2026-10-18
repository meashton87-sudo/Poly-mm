"""What FBS coaches choose (coach.json models.tendency, the tendency_web.json shape): analyze.extract_decisions reads
every decision of every family from the college frame, tendency.fit_tendencies fits the same multinomial models.

Nothing is simulated: the models need only the situation and the choice. Decisions that read the clock (the
post-play families, tempo) come from clock-good games only; a kneel counts only where kneeling could end the half
(sim.Simulator.kneel_out_possible's arithmetic, done here without a simulator).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import analyze as A
from .. import tendency as T
from ..sim import KNEEL_RUNOFF
from . import config as K

SEASONS = [2023, 2024, 2025, 2026]     # the 2023 clock rules on
KNEEL_DURATION = 1.5


def _kneel_ok(d: pd.DataFrame) -> np.ndarray:
    t_half = np.where(d["qtr"] >= 3, d["game_seconds_remaining"], d["game_seconds_remaining"] - 1800).astype(float)
    k = np.clip(4 - d["down"].fillna(1).to_numpy(), 0, 3)
    stops = d["def_to"].fillna(3).to_numpy() + (t_half > 120)
    gap = 0.5 * (KNEEL_RUNOFF[0] + KNEEL_RUNOFF[1])
    burn = k * KNEEL_DURATION + np.maximum(k - stops, 0) * gap + np.minimum(k, stops) * 1.0
    return t_half <= burn + 1.0


def decisions(e: pd.DataFrame, seasons=SEASONS) -> pd.DataFrame:
    g = e[e["fbs"] & e["season"].isin(seasons)]
    dec = A.extract_decisions(g, seasons)
    bad = set(g.loc[g["clock_bad"], "game_id"].unique())
    clocked = dec["root_kind"].eq("post") | dec["decision"].isin(["kneel", "h1_end"])
    dec = dec[~(clocked & dec["game_id"].isin(bad))]
    kn = dec["decision"] == "kneel"
    dec = dec[~kn | pd.Series(_kneel_ok(dec), index=dec.index)]
    return dec[dec["decision"] != "lead_tempo"]


def fit(e: pd.DataFrame, seasons=SEASONS) -> tuple[dict, dict]:
    dec = decisions(e, seasons)
    models = T.fit_tendencies(dec)
    models["level"] = "fbs"
    models["seasons"] = list(seasons)
    rep = {f: {"n": int(m["n"]), "share": {k: round(v, 3) for k, v in m["share"].items()}}
           for f, m in models["families"].items()}
    return models, rep
