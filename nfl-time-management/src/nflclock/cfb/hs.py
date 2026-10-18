"""The high-school level (engine_data_hs.json, coach_hs.json, drills/hs_c<k>.json): no public high-school play-by-play
exists, so the level is built from the lowest-talent college games in the data and moved one explicit step further.

Method (every number below is either MEASURED in the college data or an ASSUMPTION, listed in level_card()):
  * Source: games with no FBS team (FCS vs FCS, FCS vs Division II), clock-good, 2022 on (the release covers FCS
    fully from 2022). Their plays are the outcome library's raw material.
  * Execution: per play, lower-division games look like FBS games (completions 63% against 63%: a division plays
    itself, so per-play rates measure parity, not level; the extrapolation r_lower + HS_STEP x (r_lower - r_fbs) is
    reported and is ~0). High-school execution is therefore an explicit assumption (HS_ADJUST: fewer completions,
    more turnovers and penalties), applied by resampling the lower-division plays within each situation with weights
    that hit those rates (yardage shapes stay the plays' own).
  * Bigger mismatches: high-school talent gaps are far wider than FBS (the average 2020s margin is near 26 points,
    a quarter of games reach a mercy-rule margin). Team strength is a team setting (TALENT tiers, in standard
    deviations of the lower-division team ratings x GAP_SCALE); GAP_SCALE is fit so simulated games hit the
    blowout share, then scoring is checked against the published anchors (validate()).
  * Kicking is a team setting (KICKER tiers): many high-school teams have no reliable kicker. A tier is a PAT make
    rate and a field-goal range; its logit shift on the college kick model is solved from the PAT rate.
  * Tempo: a 25-second play clock (most states) from the ready signal, about 3 s after the whistle: a huddle or a
    milked clock runs at most ~28 s, not 40; plays run 0.5 s longer (5.6 s vs 5.1 s, PubMed 16503692).
  * Kickoffs from the 40 with a touchback at the 20 (NFHS); tries from the 3.
"""
from __future__ import annotations

import json
from dataclasses import replace

import numpy as np
import pandas as pd

from .. import library as L
from .. import ratings as R
from .. import wp as W
from ..models import Bundle
from ..sim import KICKOFF, GameContext, RootState, Simulator
from . import config as K
from . import drills as DR
from . import export as EX
from . import models as M

SOURCE_SEASONS = [2022, 2023, 2024, 2025, 2026]
HS_STEP = 1.0              # the extrapolation measured (lower division minus FBS, once more): ~0, games within a division are at parity
# ASSUMED (no published high-school rates): execution below college, applied to the lower-division plays by reweighting
HS_ADJUST = {"completion": -0.05,   # completion rate, absolute (fewer accurate passers and sure-handed receivers)
             "turnover": 1.5,       # lost fumbles and interceptions, times (ball security, younger players)
             "penalty": 1.2}        # penalty snaps, times
HS_PLAY_CLOCK = 25.0       # NFHS default (state option 40/25); runoff after the whistle tops out near clock + ready delay
READY_DELAY = 3.0          # ASSUMED: seconds from the whistle to the ready-for-play signal
HS_PLAY_EXTRA = 0.5        # high-school plays last ~0.5 s longer than college (5.6 +- 2.0 s; PubMed 16503692)
HS_KO_TOUCHBACK_YL = 80.0  # NFHS: touchback at the 20
HS_QUARTER = 720.0         # 12-minute quarters
# ASSUMED (no published high-school rates: team settings with these defaults). PAT = a 20-yard kick's make rate.
KICKER = {
    "none": {"label": "No kicker", "pat": 0.0, "fg_max": 0, "default": False},
    "unreliable": {"label": "Unreliable", "pat": 0.70, "fg_max": 30, "default": False},
    "average": {"label": "Average", "pat": 0.85, "fg_max": 38, "default": True},
    "good": {"label": "Good", "pat": 0.93, "fg_max": 45, "default": False},
    "prospect": {"label": "College prospect", "pat": 0.97, "fg_max": 55, "default": False},
}
TALENT = {"overmatched": -2.0, "weak": -1.0, "average": 0.0, "strong": 1.0, "elite": 2.0}   # team setting, in SDs
GAP_SCALES = (1.0, 2.0, 3.0, 4.0, 5.0)    # candidate widenings of the lower-division rating spread
# Published anchors (search-summary quality: research notes): MaxPreps/McKnight 2020s average winning score ~39,
# average margin ~26 (unconfirmed), combined ~52; ~25-30% of games reach a mercy-rule margin (Ohio week 1 2014:
# 114/375 hit 30+ in the 2nd half; one Indiana county 2018: 26% won by 35+).
ANCHORS = {"winner_points": 39.0, "margin": 26.0, "combined": 52.0, "share_35plus": 0.26}


def lower(e: pd.DataFrame, good: bool = True) -> pd.DataFrame:
    m = (e["home_div"] != "fbs") & (e["away_div"] != "fbs") & (e["home_div"] != "") & e["season"].isin(SOURCE_SEASONS)
    if good:
        m &= ~e["clock_bad"]
    return e[m]


# ----------------------------------------------------------------- the step ---
def rates(lib: pd.DataFrame) -> dict:
    """Per-play rates of the library rows (non-penalty plays, except the penalty rate)."""
    np_ = lib[~lib["penalty"]]
    pas = np_[np_["kind"] == L.KIND_PASS]
    thrown = pas[pas["incomplete"] | (pas["yards"] != 0) | pas["td_off"]]
    return {"completion": float(1 - thrown["incomplete"].mean()), "turnover": float(np_["turnover"].mean()),
            "penalty": float(lib["penalty"].mean()), "ypp_run": float(np_.loc[np_["kind"] == 0, "yards"].mean()),
            "ypp_pass": float(pas["yards"].mean()), "td": float(np_["td_off"].mean())}


def stepped(fbs: dict, low: dict, step: float = HS_STEP) -> dict:
    """The measured extrapolation (lower division + step x (lower - FBS)): reported; ~0 per play, because a division
    plays itself."""
    return {k: float(np.clip(low[k] + step * (low[k] - fbs[k]), 0.001, 0.999)) if k not in ("ypp_run", "ypp_pass")
            else low[k] + step * (low[k] - fbs[k]) for k in low}


def hs_target(low: dict, adj: dict = HS_ADJUST) -> dict:
    """The high-school rates the library is reweighted to: the lower-division rates with the assumed execution."""
    return {**low, "completion": float(np.clip(low["completion"] + adj["completion"], 0.3, 0.9)),
            "turnover": float(np.clip(low["turnover"] * adj["turnover"], 0.001, 0.2)),
            "penalty": float(np.clip(low["penalty"] * adj["penalty"], 0.001, 0.3))}


def hs_library(low_lib: pd.DataFrame, target: dict, seed: int = 41) -> pd.DataFrame:
    """Resample the lower-division rows within each fine situation, weighted to the high-school completion, turnover
    and penalty rates (yardage and situation shapes stay the real plays')."""
    lib = low_lib.copy()
    cur = rates(lib)
    w = np.ones(len(lib))
    pen = lib["penalty"].to_numpy()
    w[pen] *= target["penalty"] / cur["penalty"]
    w[~pen] *= (1 - target["penalty"]) / (1 - cur["penalty"])
    tov = lib["turnover"].to_numpy() & ~pen
    w[tov] *= target["turnover"] / cur["turnover"]
    w[~tov & ~pen] *= (1 - target["turnover"]) / (1 - cur["turnover"])
    pas = (lib["kind"] == L.KIND_PASS).to_numpy() & ~pen & ~tov
    inc = lib["incomplete"].to_numpy() & pas
    comp = pas & ~inc & (lib["yards"].to_numpy() != 0)
    w[inc] *= (1 - target["completion"]) / (1 - cur["completion"])
    w[comp] *= target["completion"] / cur["completion"]
    rng = np.random.default_rng(seed)
    picks = []
    for fk, idx in lib.groupby("fine").indices.items():
        p = w[idx] / w[idx].sum()
        picks.append(rng.choice(idx, size=len(idx), replace=True, p=p))
    out = lib.iloc[np.concatenate(picks)].reset_index(drop=True)
    out["duration"] = np.where(out["penalty"] & (out["duration"] == 0), 0.0, np.clip(out["duration"] + HS_PLAY_EXTRA, 0, 14))
    return out


def hs_tempo(tempo: dict) -> dict:
    cap = HS_PLAY_CLOCK + READY_DELAY
    out = {}
    for k, v in tempo.items():
        v = np.asarray(v, float)
        if k in ("normal", "milk"):
            v = v * cap / 40.0          # the play clock's share of the gap shrinks with the clock
        out[k] = np.clip(v, 1.0, cap)
    return out


def hs_punts(fbs_p: dict, low_p: dict, step: float = HS_STEP, seed: int = 43) -> dict:
    """Lower-division punts, net yards scaled one more step (net_hs/net_low = net_low/net_fbs), blocks reweighted."""
    ratio = (np.mean(low_p["net"]) / np.mean(fbs_p["net"])) ** step
    out = {k: np.asarray(v).copy() for k, v in low_p.items()}
    out["net"] = np.round(out["net"] * ratio)
    b_low, b_fbs = float(np.mean(low_p["blocked"])), float(np.mean(fbs_p["blocked"]))
    b_hs = min(max(b_low + step * (b_low - b_fbs), 0.0), 0.2)
    w = np.where(out["blocked"], b_hs / max(b_low, 1e-6), (1 - b_hs) / (1 - b_low))
    j = np.random.default_rng(seed).choice(len(w), size=len(w), p=w / w.sum())
    return {k: v[j] for k, v in out.items()}


def hs_kickoffs(low_k: dict) -> dict:
    """NFHS kickoffs: from the 40, touchback at the 20. Lower-division kicks, a touchback moved to the 20 (yl 80)."""
    st = np.asarray(low_k["start_yl"], float).copy()
    tb = (st == K.KO_TOUCHBACK_YL) & (np.asarray(low_k["duration"]) == 0)
    st[tb] = HS_KO_TOUCHBACK_YL
    return {"start_yl": st, "duration": np.asarray(low_k["duration"], float), "ret_td": np.asarray(low_k["ret_td"], bool)}


def kicker_tiers(fg_model, taper, xp_logit: float) -> dict:
    """Each tier's logit shift: the PAT (20-yard kick + xp_logit) makes at the tier's rate; its field-goal make
    probability by distance for the card."""
    base = float(M.fg_long_prob(fg_model, [K.PAT_KICK_YARDS], 2025, taper)[0])
    z0 = np.log(base / (1 - base)) + xp_logit
    out = {}
    for k, t in KICKER.items():
        p = min(max(t["pat"], 1e-3), 0.999)
        shift = float(np.log(p / (1 - p)) - z0) if t["pat"] > 0 else -12.0
        d = np.array([20, 25, 30, 35, 40, 45, 50])
        zz = np.log(M.fg_long_prob(fg_model, d, 2025, taper) / (1 - M.fg_long_prob(fg_model, d, 2025, taper))) + shift
        fgp = np.where(d > t["fg_max"], 0.0, 1 / (1 + np.exp(-zz)))
        out[k] = {**t, "rating": round(shift, 3), "fg_make": {int(a): round(float(b), 3) for a, b in zip(d, fgp)}}
    return out


# -------------------------------------------------------------------- talent ---
def talent_sd(tr: pd.DataFrame) -> dict:
    last = tr[tr["week"] == tr.groupby("season")["week"].transform("max")]
    return {k: float(last[k].std()) for k in ("off_pass", "off_rush", "def_pass", "def_rush")}


def _ctx(bundle, home: dict, away: dict, rng) -> GameContext:
    from ..context import TeamInfo, make_context
    h = TeamInfo(team="HOME", **home)
    a = TeamInfo(team="AWAY", **away)
    return make_context(bundle, h, a, home_spread=0.0, receive_2h=int(rng.random() < 0.5), season=2025)


def _nfhs() -> bool:
    """The simulator has rulebooks (WS1): whole games play under nfhs, 12-minute quarters."""
    from dataclasses import fields
    return "rules" in {f.name for f in fields(GameContext)}


def simulate_games(bundle, sd: dict, scale: float, mu: float = 0.0, n_matchups: int = 30, per: int = 30, seed: int = 9) -> dict:
    """Whole high-school games: two 24-minute halves (12-minute quarters) from kickoffs. Each team has one strength
    z ~ N(0, scale^2) (a good team is good on both sides of the ball), its units z x the lower-division rating spread
    (offense up, defense down: lower EPA allowed). Until the nfhs ruleset is in the simulator the halves run under its
    NFL clock rules (a two-minute warning, out-of-bounds windows): an approximation for the scoring level; with it,
    the nfhs rulebook and its 12-minute quarters."""
    rng = np.random.default_rng(seed)
    scores = []
    for m in range(n_matchups):
        def team():
            z = float(rng.normal(0, scale))
            return {"off_pass": z * sd["off_pass"] + mu, "off_rush": z * sd["off_rush"] + mu,
                    "def_pass": -z * sd["def_pass"], "def_rush": -z * sd["def_rush"]}
        ctx = _ctx(bundle, team(), team(), rng)
        if _nfhs():
            ctx = replace(ctx, rules="nfhs")
        sim = Simulator(bundle, ctx)
        first = int(rng.random() < 0.5)
        tot = np.zeros((per, 2))
        halves = ((0, 4 * HS_QUARTER), (1, 2 * HS_QUARTER)) if _nfhs() else ((0, 1800.0 + 2 * HS_QUARTER), (1, 2 * HS_QUARTER))
        for half, t0 in halves:
            kick = first if half == 0 else 1 - first
            root = RootState(t=t0, pos=kick, score=(0, 0), phase=KICKOFF, to=(3, 3))
            _, S = sim.run(root, n=per, perspective=0, seed=seed * 1000 + m * 2 + half, return_state=True)
            tot += S.score
        scores.append(tot)
    s = np.vstack(scores)
    win, lose = s.max(1), s.min(1)
    margin = win - lose
    return {"games": int(len(s)), "scale": scale, "mu": mu, "winner_points": round(float(win.mean()), 1),
            "loser_points": round(float(lose.mean()), 1), "combined": round(float(s.sum(1).mean()), 1),
            "margin": round(float(margin.mean()), 1), "margin_sd": round(float(margin.std()), 1),
            "share_35plus": round(float(np.mean(margin >= 35)), 3), "share_30plus": round(float(np.mean(margin >= 30)), 3)}


MU_GRID = (0.0, -0.06, -0.12, -0.18, -0.24)    # league-wide EPA/play shift for every offense (execution), searched
SCALE_GRID = (2.0, 2.5, 3.0, 3.5, 4.0)


def validate(bundle, sd: dict, log=print) -> dict:
    """Two level parameters fit to two anchors, the rest checked: the efficiency shift mu to combined points (at a
    3x spread), then the talent spread to the share of 35+ margins; winner and loser points and the mean margin are
    the check."""
    runs = []
    for mu in MU_GRID:
        runs.append(simulate_games(bundle, sd, 3.0, mu))
    mu = min(runs, key=lambda r: abs(r["combined"] - ANCHORS["combined"]))["mu"]
    for sc in SCALE_GRID:
        runs.append(simulate_games(bundle, sd, sc, mu))
    for r in runs:
        log(f"  hs games mu {r['mu']:+.2f} x{r['scale']}: winner {r['winner_points']}, loser {r['loser_points']}, "
            f"margin {r['margin']}, 35+ {r['share_35plus']:.0%}")
    best = min([r for r in runs if r["mu"] == mu], key=lambda r: abs(r["share_35plus"] - ANCHORS["share_35plus"]))
    return {"anchors": ANCHORS, "runs": runs, "chosen_scale": best["scale"], "chosen_mu": mu, "chosen": best,
            "fit_on": "combined points (mu) and the 35+ margin share (talent spread); winner, loser and mean margin are the check"}


# -------------------------------------------------------------------- drills ---
def hs_spots(drills: list, league: dict | None = None) -> list:
    """Lower-division situations as high-school drills: the clock scaled to 12-minute quarters (the same share of
    the quarter left), generic teams (yours and the opponent: talent and kicker are settings), nfhs rules."""
    out = []
    for d in drills:
        sp = json.loads(json.dumps(d["spot"]))
        st = sp["start"]
        st["clock"] = round(st["clock"] * HS_QUARTER / 900.0)
        src = f"{sp['away']} at {sp['home']}, {sp['real']['season']}"
        me_home = sp["player"] == sp["home"]
        sp["home"], sp["away"] = ("YOU", "OPP") if me_home else ("OPP", "YOU")
        sp["player"] = "YOU"
        st["pos"] = "YOU" if st["pos"] == (d["spot"]["player"]) else "OPP"
        st["receive2h"] = "YOU" if st["receive2h"] == d["spot"]["player"] else "OPP"
        sp["rules"] = "nfhs"
        sp["college"] = False
        sp["level"] = "hs"
        sp["spread"] = 0.0
        sp["source"] = src
        if league:
            sp["league"] = dict(league)
        real = {"coach": None, "story": f"From a real lower-division college game ({src}), the clock scaled to 12-minute quarters. "
                + d["real"]["story"].split(": ", 1)[-1], "actions": d["real"]["actions"], "result": d["real"]["result"]}
        teams = {side: {"team": code, "coach": None, "base": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0, "proe": 0.0},
                        "qb": {"name": None, "adjustment": 0.0}, "talent": "average", "kicker_tier": "average",
                        "injury_adjustment": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0},
                        "kicker": {"name": None, "rating": 0.0}, "punter": {"name": None, "rating": 0.0},
                        "lineup": {"off": [], "def": []}}
                 for side, code in (("home", sp["home"]), ("away", sp["away"]))}
        meta = {**d["meta"], "id": "hs:" + d["meta"]["id"], "home": sp["home"], "away": sp["away"], "player": "YOU",
                "sub": f"Lower-division college game, {sp['real']['season']}", "classic": False}
        out.append({"meta": meta, "spot": sp, "teams": teams, "real": real})
    return out


def level_card(meas: dict, tiers: dict, val: dict, sd: dict) -> dict:
    """What the coach's settings mean and how the level was made: measured vs assumed (for /coach-model)."""
    return {
        "level": "hs", "rules": "nfhs", "source": "cfbfastR play-by-play (sportsdataverse), games with no FBS team, 2022-26",
        "step": HS_STEP, "measured": meas,
        "assumed": {"HS_ADJUST": HS_ADJUST, "READY_DELAY": READY_DELAY, "kicker_tiers": "PAT rates and FG ranges per tier",
                    "talent_tiers": TALENT, "play_extra_seconds": HS_PLAY_EXTRA},
        "cited": {"play_duration": "5.6 +- 2.0 s in high school (PubMed 16503692, 2006)",
                  "scoring": "MaxPreps / David McKnight: 2020s average winning score ~39; margin ~26 (unconfirmed)",
                  "blowouts": "Ohio 2014 week 1: 114 of 375 games hit the 30-point rule; Johnson County IN 2018: 26% won by 35+",
                  "onside": "Pulaski Academy (self-reported) 18-28% recoveries a season: a ceiling for a team that practices it"},
        "kicker_tiers": tiers, "talent": {"tiers": TALENT, "sd_per_unit": {k: round(v * val["chosen_scale"], 4) for k, v in sd.items()},
                                          "gap_scale": val["chosen_scale"], "mu": val["chosen_mu"]},
        "validation": val,
    }


def build(e: pd.DataFrame, cfb: Bundle, tend: dict, workers: int = 4, difficulty: bool = True, log=print) -> dict:
    low = lower(e)
    log(f"  lower-division source: {low['game_id'].nunique()} clock-good games, {len(low):,} rows")
    low_lib = L.build_library(low, seasons=SOURCE_SEASONS)
    fbs_lib = cfb.lib.lib
    r_fbs, r_low = rates(fbs_lib), rates(low_lib)
    step = stepped(r_fbs, r_low)
    target = hs_target(r_low)
    lib = L.PlayLibrary(hs_library(low_lib, target))
    r_hs = rates(lib.lib)
    # special teams, tempo, kicking
    low_all = e[(e["home_div"] != "fbs") & (e["away_div"] != "fbs") & e["season"].isin(SOURCE_SEASONS)].assign(fbs=True)
    low_p, rp = M.punt_samples(low_all.assign(season=low_all["season"].clip(upper=2025)))
    low_k, rk = M.kickoff_samples(low_all.assign(season=low_all["season"].clip(lower=2023, upper=2025)))
    punts = hs_punts(cfb.punts, low_p)
    kickoffs = hs_kickoffs(low_k)
    tempo = hs_tempo(cfb.tempo)
    fg = low_all[(low_all["play_type"] == "field_goal") & low_all["kick_distance"].between(15, 75)]
    fg_model = R.fit_fg_model(fg) if len(fg) > 500 else cfb.fg_model
    c = dict(cfb.consts)
    taper = tuple(c["fg_long"])
    tiers = kicker_tiers(fg_model, taper, c["xp_logit"])
    pa = low_all[low_all["extra_point_attempt"] == 1]
    tw = low_all[low_all["two_point_attempt"] == 1]
    two_low = float((tw["two_point_conv_result"] == "success").mean())
    two_hs = float(np.clip(two_low - 0.05, 0.25, 0.6))      # ASSUMED: tries execute like the rest, 5 points below
    c.update({"level": "hs", "ko_touchback_yl": HS_KO_TOUCHBACK_YL, "kickoff_start_yl": round(float(np.mean(kickoffs["start_yl"])), 2),
              "two_pt": two_hs, "two_pt_base": round(two_hs, 4), "xp": KICKER["average"]["pat"],
              "fg_max": float(max(t["fg_max"] for t in KICKER.values())), "quarter": HS_QUARTER,
              "play_clock": HS_PLAY_CLOCK})
    # WP: lower-division games (bigger gaps, more variance); the engine maps a 12-minute quarter's clock onto it
    g = low
    tf = W.training_frame(g[g["season"].isin([2022, 2023, 2024, 2025])])
    with M._lgb_threads():
        wp = W.WPModel().fit(tf)
    hold = W.training_frame(g[g["season"] == 2026])
    hold = hold[hold["wp"].notna()]
    wp_rep = {"train_snaps": int(len(tf)), "holdout_snaps": int(len(hold)),
              "model": W.evaluate(wp.predict_X(W.frame_features(hold)), hold["y"].to_numpy()) if len(hold) else None,
              "cfbfastR": W.evaluate(hold["wp"].to_numpy(), hold["y"].to_numpy()) if len(hold) else None}
    # the lower-division team ratings (their own games only): their spread is the talent unit
    plays = low_all[low_all["play_type"].isin(["run", "pass"])]
    with M._college_ratings():
        tr = R.team_ratings(plays[plays["season"].between(2022, 2025)], [2024, 2025], current=False)
    sd = talent_sd(tr)
    bundle = Bundle(wp=wp, fg_model=fg_model, lib=lib, punts=punts, kickoffs=kickoffs, tempo=tempo,
                    team_ratings=cfb.team_ratings.iloc[:0], kicker_ratings=cfb.kicker_ratings.iloc[:0],
                    punter_ratings=cfb.punter_ratings.iloc[:0], consts=c)
    log("  validating whole high-school games ...")
    val = validate(bundle, sd, log)
    c["ot_margin_sd"] = val["chosen"]["margin_sd"]
    bundle.save(K.BUNDLE_HS)
    EX.engine(bundle, K.WEB / "engine_data_hs.json")
    def comp(f):
        p = f[(f["play_type"] == "pass") & ((f["complete_pass"] == 1) | (f["incomplete_pass"] == 1))]
        return round(float(p["complete_pass"].mean()), 4)
    c_fbs, c_low = comp(e[e["fbs"] & e["season"].isin(K.LIB_SEASONS)]), comp(low)
    # the size of one division's talent gap, measured: FBS against FCS
    x = e[e["is_snap"] & e["play_type"].isin(["run", "pass"]) & (((e["home_div"] == "fbs") & (e["away_div"] == "fcs"))
                                                                  | ((e["home_div"] == "fcs") & (e["away_div"] == "fbs")))]
    fo = np.where(x["posteam"] == x["home_team"], x["home_div"], x["away_div"]) == "fbs"
    gm = x.drop_duplicates("game_id")
    res = np.where(gm["home_div"] == "fbs", gm["result"], -gm["result"])
    mismatch = {"games": int(len(gm)), "fbs_off_epa": round(float(x.loc[fo, "epa"].mean()), 4),
                "fcs_off_epa": round(float(x.loc[~fo, "epa"].mean()), 4), "fbs_margin": round(float(np.nanmean(res)), 1),
                "share_35plus": round(float(np.nanmean(np.abs(res) >= 35)), 3)}
    meas = {"fbs_vs_fcs": mismatch, "step_measured": step,
            "completion_pct": {"fbs": c_fbs, "lower": c_low, "hs": round(c_low + HS_ADJUST["completion"], 4)},
            "fbs_rates": r_fbs, "lower_rates": r_low, "hs_target": target, "hs_library": r_hs,
            "lower_punts": rp, "lower_kickoffs": rk, "two_pt_lower": round(two_low, 4), "two_pt_hs": round(two_hs, 4),
            "pat_lower": round(float((pa["extra_point_result"] == "good").mean()), 4) if len(pa) else None,
            "punt_net_hs": round(float(np.mean(punts["net"])), 2), "kickoff_start_hs": c["kickoff_start_yl"],
            "tempo_median_hs": {k: round(float(np.median(v)), 1) for k, v in tempo.items() if len(v)}, "wp": wp_rep}
    card = level_card(meas, tiers, val, sd)
    # drills: lower-division situations, the clock scaled
    from .build import make_drills
    gl = e[(e["home_div"] != "fbs") & (e["away_div"] != "fbs")]
    drills, drep = make_drills(gl.assign(fbs=True), cfb, "nfhs", "nfl", False, workers, log)
    drills = [d for d in drills if not d["meta"]["classic"]]
    lg = {"mu_pass": round(lib.mean_epa[L.KIND_PASS] + val["chosen_mu"], 5),
          "mu_rush": round(lib.mean_epa[L.KIND_RUN] + val["chosen_mu"], 5), "home_pass": 0.0, "home_rush": 0.0}
    hsd = hs_spots(drills, lg)
    from .build import has_rules
    diff_rules = "nfhs" if has_rules() else "nfl"
    if difficulty:
        log(f"  high-school difficulty (under {diff_rules} rules) ...")
        res = DR.difficulty([d["spot"] for d in hsd], None, K.BUNDLE_HS, DR.fourth_model(e),
                            None if diff_rules == "nfl" else diff_rules, workers=workers, log=log)
        for i, d in enumerate(hsd):
            if i in res:
                d["meta"]["wp0"], d["meta"]["lev"] = round(res[i][0], 4), round(res[i][1], 4)
        idx = pd.DataFrame([{"cat": d["meta"]["cat"], "lev": d["meta"]["lev"], "wp0": d["meta"]["wp0"]} for d in hsd])
        for d, v in zip(hsd, DR.grade(idx)):
            d["meta"]["diff"] = int(v)
    ex = EX.write(hsd, {"tendency": tend}, pd.DataFrame(columns=["abbreviation", "mascot"]),
                  cfb.team_ratings, "nfhs", ("nfhs" if diff_rules == "nfhs" else "nfl-provisional") if difficulty else "none", extra={"level_card": card,
                                                             "teams": {"YOU": {"name": "Your team", "mascot": None},
                                                                       "OPP": {"name": "Opponent", "mascot": None}}},
                  prefix="hs_", level="hs")
    return {"card": card, "drills": drep, "export": ex}
