"""Player archetypes for the daily game, named the way Madden names them.

EA's own ratings are not open data, so each archetype is assigned by a rule on the public stat that
defines it (nflverse play-by-play, PFR advanced stats, snap counts and the roster's height and weight),
last season counting half as much as this one:

  QB    Scrambler / Improviser (mobile) by rushing yards per game; Strong Arm / Field General (pocket)
        by average depth of throw
  RB    Receiving Back by share of targets in his touches; Power Back by weight or yards after contact;
        otherwise Elusive Back
  WR    Deep Threat or Slot by average depth of target; Physical by size; otherwise Route Runner
  TE    Blocking by targets per snap; Vertical Threat by depth of target; otherwise Possession
  EDGE  Run Stopper by pressure rate; Speed Rusher or Power Rusher by weight
  DL    Run Stopper by pressure rate; Speed Rusher or Power Rusher by weight
  LB    Pass Coverage by targets per snap; Thumper by tackles per snap; otherwise Field General
  CB    Slot (the lineup's third corner); Zone (ball skills) or Man to Man
  S     Run Support by tackles per snap; Zone by passes defended; otherwise Hybrid

Linemen are graded as a unit and get no archetype.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config
from . import players as PL

PRIOR_WEIGHT = 0.5      # last season's plays count half
OLD_WEIGHT = 0.3        # a defender with little recent play (back from injury or retirement) also uses the 3 seasons before
FEW_SNAPS = 150

# (archetype, plain-English type, what it means on the field)
QB = {"Scrambler": ("Mobile QB", "A threat to take off and run on any snap."),
      "Improviser": ("Mobile QB", "Extends plays with his legs and throws on the move."),
      "Strong Arm": ("Pocket passer", "Stands in the pocket and pushes the ball downfield."),
      "Field General": ("Pocket passer", "Wins from the pocket with timing and accuracy.")}
RB = {"Receiving Back": ("Receiving back", "A pass-catching threat out of the backfield."),
      "Power Back": ("Power back", "Runs through contact and grinds out tough yards."),
      "Elusive Back": ("Elusive back", "Makes defenders miss in space.")}
WR = {"Deep Threat": ("Deep threat", "Stretches the field and wins deep."),
      "Slot": ("Slot receiver", "Works underneath and over the middle."),
      "Physical": ("Physical receiver", "A big target who wins contested catches."),
      "Route Runner": ("Route runner", "Gets open with sharp routes.")}
TE = {"Blocking": ("Blocking TE", "An extra blocker first; rarely the target."),
      "Vertical Threat": ("Vertical threat TE", "Stretches the seams like a big receiver."),
      "Possession": ("Possession TE", "A reliable short-area target.")}
EDGE = {"Speed Rusher": ("Speed rusher", "Wins around the corner with speed."),
        "Power Rusher": ("Power rusher", "Collapses the pocket with strength."),
        "Run Stopper": ("Run stopper", "Sets the edge against the run.")}
DL = {"Speed Rusher": ("Penetrator", "Quick off the snap to split blockers."),
      "Power Rusher": ("Power rusher", "Bull-rushes the pocket."),
      "Run Stopper": ("Run stopper", "Eats blocks and clogs running lanes.")}
LB = {"Pass Coverage": ("Coverage linebacker", "Covers backs and tight ends."),
      "Thumper": ("Thumper", "A downhill run defender."),
      "Field General": ("Field general", "Reads the play and directs the defense.")}
CB = {"Slot": ("Slot corner", "Covers the inside receiver."),
      "Zone": ("Zone corner", "Reads the quarterback and breaks on the ball."),
      "Man to Man": ("Man corner", "Stays in the hip pocket of his receiver.")}
S = {"Run Support": ("Box safety", "Plays down near the line against the run."),
     "Zone": ("Deep safety", "A ball hawk in deep coverage."),
     "Hybrid": ("Hybrid safety", "Moves between the box and deep coverage.")}
TABLES = {"QB": QB, "RB": RB, "WR": WR, "TE": TE, "EDGE": EDGE, "DL": DL, "LB": LB, "CB": CB, "S": S}


def _w(season_col: pd.Series, season: int) -> np.ndarray:
    return np.where(season_col == season, 1.0, np.where(season_col == season - 1, PRIOR_WEIGHT, 0.0))


def _plays(season: int) -> pd.DataFrame:
    cols = ["season", "game_id", "season_type", "play_type", "passer_player_id", "rusher_player_id", "receiver_player_id",
            "qb_dropback", "qb_scramble", "air_yards", "rush_attempt", "pass_attempt", "yards_gained", "two_point_attempt"]
    p = pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols) for s in (season - 1, season)],
                  ignore_index=True)
    p = p[(p["season_type"] == "REG") & (p["two_point_attempt"].fillna(0) == 0)]
    return p.assign(w=_w(p["season"], season))


def measures(R: PL.Ratings, season: int) -> dict:
    """{gsis: {measure: value}} for everyone with enough plays."""
    p = _plays(season)
    out: dict = {}

    def put(series: pd.Series, key: str):
        for g, v in series.items():
            if pd.notna(v):
                out.setdefault(g, {})[key] = float(v)

    # passers: rushing yards per game (designed runs and scrambles) and depth of throw
    drop = p[(p["qb_dropback"] == 1)]
    qb_id = drop["passer_player_id"].fillna(drop["rusher_player_id"])
    games = drop.assign(q=qb_id).dropna(subset=["q"]).drop_duplicates(["q", "game_id"]).groupby("q")["w"].sum()
    qbs = set(games[games >= 3].index)
    runs = p[(p["rush_attempt"] == 1) & (p["play_type"] == "run") & p["rusher_player_id"].isin(qbs)]
    put((runs["yards_gained"] * runs["w"]).groupby(runs["rusher_player_id"]).sum().reindex(list(qbs)).fillna(0.0) / games[list(qbs)],
        "rush_ypg")
    att = p[(p["pass_attempt"] == 1) & p["air_yards"].notna() & p["passer_player_id"].isin(qbs)]
    put((att["air_yards"] * att["w"]).groupby(att["passer_player_id"]).sum() / att.groupby("passer_player_id")["w"].sum(), "adot")

    # ball carriers and receivers
    car = p[(p["rush_attempt"] == 1) & p["rusher_player_id"].notna()].groupby("rusher_player_id")["w"].sum()
    tgt = p[(p["pass_attempt"] == 1) & p["receiver_player_id"].notna()]
    tg = tgt.groupby("receiver_player_id")["w"].sum()
    put(tg / (tg + car.reindex(tg.index).fillna(0.0)), "target_share_of_touches")
    put(car, "carries")
    put(tg, "targets")
    ta = tgt[tgt["air_yards"].notna()]
    put((ta["air_yards"] * ta["w"]).groupby(ta["receiver_player_id"]).sum() / ta.groupby("receiver_player_id")["w"].sum(), "adot_tgt")

    # snaps, PFR rushing and defense, box-score passes defended
    pfr_to_gsis = {v: k for k, v in R.gsis_to_pfr.items()}
    sn = R.T["snaps"].assign(w=lambda d: _w(d["season"], season))
    snaps = sn.assign(o=sn["offense_snaps"] * sn["w"], d=sn["defense_snaps"] * sn["w"]).groupby("pfr_player_id")[["o", "d"]].sum()
    snaps.index = snaps.index.map(pfr_to_gsis)
    snaps = snaps[snaps.index.notna()]
    snaps = snaps.groupby(level=0).sum()
    put(snaps["o"], "off_snaps")
    ru = R.T["rush"].assign(w=lambda d: _w(d["season"], season))
    yac = (ru["rushing_yards_after_contact"].fillna(0) * ru["w"]).groupby(ru["pfr_player_id"]).sum() / \
        (ru["carries"].fillna(0) * ru["w"]).groupby(ru["pfr_player_id"]).sum().replace(0, np.nan)
    yac.index = yac.index.map(pfr_to_gsis)
    put(yac[yac.index.notna()].groupby(level=0).mean(), "yac_per_carry")
    dcols = ["def_pressures", "def_tackles_combined", "def_targets", "def_ints"]

    def dsums(de: pd.DataFrame, sn_: pd.DataFrame, w) -> pd.DataFrame:
        a = de.assign(**{c: de[c].fillna(0) * w(de) for c in dcols}).groupby("pfr_player_id")[dcols].sum()
        a["def_snaps"] = (sn_["defense_snaps"] * w(sn_)).groupby(sn_["pfr_player_id"]).sum().reindex(a.index).fillna(0.0)
        a.index = a.index.map(pfr_to_gsis)
        return a[a.index.notna()].groupby(level=0).sum()

    dsum = dsums(R.T["def"], R.T["snaps"], lambda d: _w(d["season"], season))
    few = set(dsum.index[dsum["def_snaps"] < FEW_SNAPS]) | (set(out) - set(dsum.index))
    old_seasons = range(season - 4, season - 1)
    old_def = pd.concat([pd.read_parquet(PL._get("pfr_advstats", f"advstats_week_def_{s}.parquet")) for s in old_seasons], ignore_index=True)
    old_sn = pd.concat([pd.read_parquet(PL._get("snap_counts", f"snap_counts_{s}.parquet")) for s in old_seasons], ignore_index=True)
    old = dsums(old_def, old_sn, lambda d: np.full(len(d), OLD_WEIGHT))
    add = old[old.index.isin(few)]
    dsum = dsum.add(add, fill_value=0.0)
    for c in dcols:
        put(dsum[c], c)
    put(dsum["def_snaps"], "def_snaps")
    st = pd.concat([pd.read_parquet(PL._get(*[x.format(s=s) for x in PL.NOW_FILES["stats"]]), columns=["player_id", "season", "def_pass_defended"])
                    for s in (season - 1, season)], ignore_index=True)
    st = st.assign(w=_w(st["season"], season))
    put((st["def_pass_defended"].fillna(0) * st["w"]).groupby(st["player_id"]).sum(), "pass_defended")
    return out


def assign(group: str, m: dict, height: float | None, weight: float | None, slot: bool = False) -> str | None:
    """The archetype for a player in `group` ('QB', 'RB', ..., 'S') from his measures, or None."""
    g = lambda k, d=np.nan: m.get(k, d)
    wt = weight if weight and np.isfinite(weight) else np.nan
    ht = height if height and np.isfinite(height) else np.nan
    if group == "QB":
        if np.isnan(g("rush_ypg")):
            return None
        if g("rush_ypg") >= 31:
            return "Scrambler"
        if g("rush_ypg") >= 20:
            return "Improviser"
        return "Strong Arm" if g("adot", 0.0) >= 8.3 else "Field General"
    if group == "RB":
        if g("carries", 0) + g("targets", 0) < 15:
            return None
        if g("target_share_of_touches", 0) >= 0.25:
            return "Receiving Back"
        return "Power Back" if (wt >= 225 or g("yac_per_carry", 0) >= 2.6) else "Elusive Back"
    if group == "WR":
        if g("targets", 0) < 10:
            return None
        if g("adot_tgt", 0) >= 13.5:
            return "Deep Threat"
        if g("adot_tgt", 99) <= 7.8:
            return "Slot"
        return "Physical" if (wt >= 215 or ht >= 76) else "Route Runner"
    if group == "TE":
        snaps = g("off_snaps", 0)
        if snaps < 100:
            return None
        per = g("targets", 0) / snaps
        if per < 0.08:
            return "Blocking"
        return "Vertical Threat" if (g("adot_tgt", 0) >= 7.0 and per >= 0.11) else "Possession"
    snaps = g("def_snaps", 0)
    if snaps < 100:
        return None
    pr, tk, tg = g("def_pressures", 0) / snaps, g("def_tackles_combined", 0) / snaps, g("def_targets", 0) / snaps
    if group == "EDGE":
        if pr < 0.022:
            return "Run Stopper"
        return "Speed Rusher" if wt <= 258 else "Power Rusher"
    if group == "DL":
        if pr < 0.015 or (wt >= 330 and pr < 0.02):
            return "Run Stopper"
        return "Speed Rusher" if wt < 295 else "Power Rusher"
    if group == "LB":
        if tg >= 0.07:
            return "Pass Coverage"
        return "Thumper" if tk >= 0.12 else "Field General"
    if group == "CB":
        if slot:
            return "Slot"
        tgts = g("def_targets", 0)
        if tgts < 15:
            return None
        return "Zone" if (g("pass_defended", 0) + g("def_ints", 0)) / tgts >= 0.17 else "Man to Man"
    if group == "S":
        if tk >= 0.10:
            return "Run Support"
        games = snaps / 60.0
        return "Zone" if (g("pass_defended", 0) + g("def_ints", 0)) / max(games, 1.0) >= 0.5 else "Hybrid"
    return None


def describe(group: str, arch: str | None) -> dict:
    if not arch or group not in TABLES:
        return {}
    kind, why = TABLES[group][arch]
    return {"arch": arch, "kind": kind, "why": why}
