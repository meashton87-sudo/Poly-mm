"""Grade every clock-critical decision from real games.

For each decision point the actual choice is read from play-by-play, every
legal alternative is simulated from the same state, and the win-probability
gap is recorded. Selection bias is removed by cross-fitting: the recommended
option is chosen with one set of random seeds and its edge over the actual
choice is measured on an independent set.

Decision families
  def_timeout     trailing/tied defense (or any defense before halftime): timeout now vs. let it run
  off_clock_stop  offense needing time, clock running: timeout vs. spike vs. hurry to the line
  lead_tempo      leading offense, clock running: how much play clock it burned vs. milking it
  play_select     clock-critical run vs. pass (leading late / trailing late)
  kneel           leading offense that could kneel out the clock: kneel vs. run a play
  h1_end          ball before halftime: attack vs. run out the half
  fourth_down     late 4th downs: go vs. FG vs. punt (with this kicker, punter, offense, defense)
  onside          trailing kicking team late: onside vs. deep kick
  pat             late PAT: kick vs. two
"""
from __future__ import annotations

import multiprocessing as mp
import time

import numpy as np
import pandas as pd

from . import config, data
from .context import GameContextFactory
from .library import _duration
from .models import Bundle
from .sim import KICKOFF, PAT, SNAP, RootState, Simulator

OPTIONS = {
    "def_timeout": {"timeout": {"to_def": True}, "no_timeout": {"to_def": False}},
    "off_clock_stop": {"timeout": {"to_off": True}, "hurry": {"to_off": False, "tempo": "urgent"},
                       "spike": {"to_off": False, "play": "spike"}},
    "lead_tempo": {},  # built per decision (exact runoff)
    "play_select": {"run": {"play": "run"}, "pass": {"play": "pass"}},
    "kneel": {"kneel": {"play": "kneel"}, "run_play": {"play": "run"}},
    "h1_end": {"attack": {"h1": "attack"}, "runout": {"h1": "runout"}},
    "fourth_down": {"go": {"play": "go"}, "fg": {"play": "fg"}, "punt": {"play": "punt"}},
    "onside": {"onside": {"kick": "onside"}, "deep": {"kick": "deep"}},
    "pat": {"xp": {"pat": "xp"}, "two": {"pat": "two"}},
}
MILK_RUNOFF = 37.0


# ------------------------------------------------------------- extraction ---
def _snaps_with_next(pbp: pd.DataFrame) -> pd.DataFrame:
    s = pbp[pbp["is_snap"]].copy()
    g = s.groupby(["game_id", "half"], sort=False)
    for c in ["down", "ydstogo", "posteam_score", "defteam_score", "posteam_timeouts_remaining",
              "defteam_timeouts_remaining", "play_id", "desc"]:
        s[f"n_{c}"] = g[c].shift(-1)
    return s


def kicker_unavailable(pbp: pd.DataFrame) -> set:
    """(game_id, team) pairs that played without a healthy kicker.

    Flags a punter (or other emergency kicker) attempting PATs/FGs, or a team
    with no PAT/FG attempts that went for two before the 4th quarter.
    """
    p = pbp[pbp["posteam"].notna()]
    punters = p[p["play_type"] == "punt"].groupby(["game_id", "posteam"])["punter_player_id"].agg(set)
    kicks = p[p["kicker_player_id"].notna() & p["play_type"].isin(["extra_point", "field_goal"])]
    kickers = kicks.groupby(["game_id", "posteam"])["kicker_player_id"].agg(set)
    # a player who mostly punts but kicked PATs/FGs this game = emergency kicker
    n_punts = p[p["play_type"] == "punt"].groupby("punter_player_id").size()
    n_kicks = kicks.groupby("kicker_player_id").size()
    is_punter = {pid for pid in n_punts.index if n_punts[pid] > n_kicks.get(pid, 0)}
    bad = {k for k, ks in kickers.items() if ks & punters.get(k, set()) & is_punter}
    g = p.groupby(["game_id", "posteam"]).agg(
        xp=("extra_point_attempt", "sum"), fg=("field_goal_attempt", "sum"),
        early_two=("two_point_attempt", lambda x: int(((x == 1) & (p.loc[x.index, "qtr"] <= 2)).sum())))
    bad |= set(g[(g["xp"] == 0) & (g["fg"] == 0) & (g["early_two"] >= 1)].index)
    return bad


def _root_post_play(r, home) -> RootState:
    """State right after play r ends (clock running), before the next snap."""
    off_home = r["posteam"] == home
    off_to = r["n_posteam_timeouts_remaining"] + (1 if r["to_after_team"] == r["posteam"] else 0)
    def_to = r["n_defteam_timeouts_remaining"] + (1 if r["to_after_team"] == r["defteam"] else 0)
    sc = (r["n_posteam_score"], r["n_defteam_score"])
    return RootState(
        t=float(r["t_end"]), pos=0 if off_home else 1,
        score=tuple(int(x) for x in (sc if off_home else sc[::-1])),
        down=int(r["n_down"]), ytg=float(r["n_ydstogo"]), yl=float(r["next_yardline_100"]),
        to=tuple(int(min(3, x)) for x in ((off_to, def_to) if off_home else (def_to, off_to))),
        clock_running=True,
    )


def _root_snap(r, home, phase=SNAP, pos_team=None) -> RootState:
    pos_team = pos_team or r["posteam"]
    off_home = r["posteam"] == home
    to = (r["posteam_timeouts_remaining"], r["defteam_timeouts_remaining"])
    sc = (r["posteam_score"], r["defteam_score"])
    return RootState(
        t=float(r["game_seconds_remaining"]), pos=0 if pos_team == home else 1,
        score=tuple(int(x) for x in (sc if off_home else sc[::-1])),
        down=int(r["down"]) if not np.isnan(r["down"]) else 1,
        ytg=float(r["ydstogo"]) if not np.isnan(r["ydstogo"]) else 10.0,
        yl=float(r["yardline_100"]) if not np.isnan(r["yardline_100"]) else 75.0,
        to=tuple(int(x) for x in (to if off_home else to[::-1])), clock_running=False, phase=phase,
    )


def extract_decisions(pbp: pd.DataFrame, seasons) -> pd.DataFrame:
    pbp = pbp[pbp["season"].isin(seasons)]
    s = _snaps_with_next(pbp)
    s = s[s["posteam_timeouts_remaining"].notna()]
    hs = s["half_seconds_remaining"]
    q4 = s["qtr"] == 4
    q2 = s["qtr"] == 2
    wp = s["wp"].fillna(0.5)
    live = wp.between(0.01, 0.99)
    out = []

    def add(df, decision, decider, actual, root_kind, extra=None):
        if df.empty:
            return
        d = pd.DataFrame({
            "game_id": df["game_id"], "play_id": df["play_id"], "season": df["season"], "week": df["week"],
            "season_type": df["season_type"], "qtr": df["qtr"], "clock": df["time"] if "time" in df else "",
            "game_seconds_remaining": df["game_seconds_remaining"],
            "decision": decision, "team": decider, "actual": actual, "root_kind": root_kind,
            "desc": df["desc"], "posteam": df["posteam"], "defteam": df["defteam"],
            "home_team": df["home_team"], "away_team": df["away_team"],
            "margin_off": df["margin"], "down": df["down"], "ydstogo": df["ydstogo"],
            "yardline_100": df["yardline_100"],
            "off_to": df["posteam_timeouts_remaining"], "def_to": df["defteam_timeouts_remaining"],
        })
        for k, v in (extra or {}).items():
            d[k] = v
        out.append(d)

    # ----- post-play states (clock running after an in-bounds play) ---------
    inb = (s["play_type"].isin(["run", "pass"]) & (s["incomplete_pass"] == 0) & (s["out_of_bounds"] == 0)
           & (s["penalty"].fillna(0) == 0) & (s["turnover"] == 0) & (s["touchdown"] == 0)
           & (s["two_point_attempt"].fillna(0) == 0)
           & (s["next_posteam"] == s["posteam"]) & (s["next_qtr"] == s["qtr"]) & s["n_down"].notna())
    yd = s["yards_gained"].fillna(0).to_numpy()
    dur = _duration(s["play_type"].to_numpy(), yd, s["incomplete_pass"].fillna(0).to_numpy(),
                    s["sack"].fillna(0).to_numpy(), np.zeros(len(s), bool), s["turnover"].to_numpy())
    t_end = s["game_seconds_remaining"] - dur
    # A timeout only counts as the decision we grade when it was called right after the whistle;
    # one called later (e.g. icing the kicker at 0:05) means the clock was first allowed to run.
    s["to_immediate"] = s["to_after_team"].notna() & (s["to_after_t"] >= t_end - 4.0)
    to_t = s["to_after_t"] + 1.0
    s["t_end"] = np.where(s["to_immediate"], np.minimum(np.maximum(to_t, s["next_game_seconds_remaining"]),
                                                        s["game_seconds_remaining"]), t_end)
    s["t_end"] = np.maximum(s["t_end"], s["next_game_seconds_remaining"])
    s["runoff_actual"] = s["t_end"] - s["next_game_seconds_remaining"]
    two_min_cross = ((s["half"] == 2) & (s["t_end"] > 120) & (s["next_game_seconds_remaining"] <= 120)) | (
        (s["half"] == 1) & (s["t_end"] > 1920) & (s["next_game_seconds_remaining"] <= 1920))
    post = s[inb & live & ~two_min_cross & (s["t_end"] > s["next_game_seconds_remaining"] - 0.01)]
    p_hs = post["half_seconds_remaining"]
    def_to_called = post["to_immediate"] & (post["to_after_team"] == post["defteam"])
    off_to_called = post["to_immediate"] & (post["to_after_team"] == post["posteam"])
    off_to_delayed = ~post["to_immediate"] & (post["to_after_team"] == post["posteam"])
    def_to_avail = post["n_defteam_timeouts_remaining"] + (post["to_after_team"] == post["defteam"]).astype(int) > 0

    # def_timeout: 4Q final 5:00 with the defense trailing or tied; or final 2:00 of the first half
    m = def_to_avail & ~off_to_called & (
        ((post["qtr"] == 4) & (p_hs <= 300) & (post["margin"] >= 0) & (post["margin"] <= 16))
        | ((post["qtr"] == 2) & (p_hs <= 120)))
    d = post[m]
    add(d, "def_timeout", d["defteam"], np.where(def_to_called[m], "timeout", "no_timeout"), "post")

    # off_clock_stop: 4Q final 2:00 offense trailing (by <= 16) or tied; 1st-half final 1:00
    off_to_avail = post["n_posteam_timeouts_remaining"] + (post["to_after_team"] == post["posteam"]).astype(int)
    nxt_spike = (post["next_play_type"] == "qb_spike") | post["n_desc"].str.contains("spiked the ball", na=False)
    m = ~def_to_called & ~off_to_delayed & (
        ((post["qtr"] == 4) & (p_hs <= 120) & (post["margin"] <= 0) & (post["margin"] >= -16))
        | ((post["qtr"] == 2) & (p_hs <= 60) & (post["next_yardline_100"] <= 60)))
    d = post[m]
    act = np.where(off_to_called[m], "timeout", np.where(nxt_spike[m], "spike", "hurry"))
    # the pace the offense actually achieved (only measurable when no timeout came before the snap)
    paced = d["to_after_team"].isna() & d["runoff_actual"].between(2.0, 40.0)
    add(d, "off_clock_stop", d["posteam"], act, "post", {"off_to_avail": off_to_avail[m].to_numpy(),
                                                          "runoff_actual": d["runoff_actual"].where(paced).to_numpy()})

    # lead_tempo: leading offense in the final 5:00, defense did not stop the clock
    m = ((post["qtr"] == 4) & (p_hs <= 300) & (post["margin"].between(1, 16)) & post["to_after_team"].isna()
         & (post["runoff_actual"] < 30) & (post["runoff_actual"] >= 0)
         & ~post["next_play_type"].isin(["qb_kneel", "punt", "field_goal"]))
    d = post[m]
    add(d, "lead_tempo", d["posteam"], "as_played", "post", {"runoff_actual": d["runoff_actual"].to_numpy()})

    # ----- snap-moment decisions --------------------------------------------
    snap_live = live & s["down"].notna() & (s["two_point_attempt"].fillna(0) == 0)
    is_run = (s["play_type"] == "run") & (s["qb_scramble"].fillna(0) == 0)
    is_pass = s["qb_dropback"].fillna(0) == 1
    # play_select: leading late (clock killing) or trailing late (clock saving); not 4th down
    m = snap_live & (is_run | is_pass) & (s["down"] < 4) & q4 & (hs <= 300) & s["margin"].between(-16, 16) \
        & (s["margin"] != 0)
    d = s[m]
    add(d, "play_select", d["posteam"], np.where(is_run[m], "run", "pass"), "snap")

    # kneel: leading offense, kneel-out feasible (checked in the worker with exact rules)
    m = snap_live & q4 & (hs <= 160) & (s["margin"] > 0) & (s["down"] < 4) & (is_run | (s["play_type"] == "qb_kneel"))
    d = s[m]
    add(d, "kneel", d["posteam"], np.where(d["play_type"] == "qb_kneel", "kneel", "run_play"), "snap")

    # fourth_down: final 10:00 of the game or final 2:00 of the first half
    fd = snap_live & (s["down"] == 4) & s["play_type"].isin(["run", "pass", "punt", "field_goal"]) & (
        (q4 & (hs <= 600)) | (q2 & (hs <= 120))) & (s["margin"].abs() <= 16)
    d = s[fd]
    act = np.where(d["play_type"] == "punt", "punt", np.where(d["play_type"] == "field_goal", "fg", "go"))
    add(d, "fourth_down", d["posteam"], act, "snap")

    # h1_end: first snap of a possession with 0:20-2:00 left in the first half, outside FG range
    first = s[q2 & (hs <= 120) & (hs >= 20) & (s["yardline_100"] >= 50) & s["down"].eq(1)]
    first = first.groupby(["game_id", "fixed_drive"]).head(1)
    drv = s[q2].groupby(["game_id", "fixed_drive"]).agg(
        kneels=("qb_kneel", "sum"), passes=("qb_dropback", "sum"), n=("play_id", "size"))
    first = first.join(drv, on=["game_id", "fixed_drive"])
    first = first[(first["play_type"] != "no_play")]
    act = np.where((first["kneels"] > 0) | (first["passes"] == 0), "runout", "attack")
    add(first, "h1_end", first["posteam"], act, "snap")

    # ----- special phases --------------------------------------------------------
    allp = pbp[pbp["season"].isin(seasons)]
    pat = allp[((allp["extra_point_attempt"] == 1) | (allp["two_point_attempt"] == 1)) & (allp["qtr"] == 4)
               & allp["posteam_timeouts_remaining"].notna() & allp["wp"].between(0.01, 0.99)]
    add(pat, "pat", pat["posteam"], np.where(pat["two_point_attempt"] == 1, "two", "xp"), "pat")

    ko = allp[(allp["play_type"] == "kickoff") & (allp["qtr"] == 4) & (allp["game_seconds_remaining"] <= 420)
              & allp["posteam"].notna() & allp["posteam_timeouts_remaining"].notna()]
    ko = ko[(ko["defteam_score"] < ko["posteam_score"]) & ((ko["posteam_score"] - ko["defteam_score"]) <= 16)]
    onside = ko["desc"].str.contains("onside", case=False, na=False)
    add(ko, "onside", ko["defteam"], np.where(onside, "onside", "deep"), "kickoff")

    dec = pd.concat(out, ignore_index=True)
    no_k = kicker_unavailable(pbp)
    dec = dec[~pd.Series(list(zip(dec["game_id"], dec["team"])), index=dec.index).isin(no_k)]
    # attach the raw rows needed to rebuild the root state
    cols = ["game_id", "play_id", "posteam", "defteam", "game_seconds_remaining", "down", "ydstogo",
            "yardline_100", "posteam_score", "defteam_score", "posteam_timeouts_remaining",
            "defteam_timeouts_remaining", "to_after_team", "t_end", "next_yardline_100", "n_down", "n_ydstogo",
            "n_posteam_score", "n_defteam_score", "n_posteam_timeouts_remaining", "n_defteam_timeouts_remaining"]
    raw = s[cols]
    extra_raw = pd.concat([pat, ko])[[c for c in cols if c in pat.columns]]
    raw = pd.concat([raw, extra_raw[~extra_raw.set_index(["game_id", "play_id"]).index.isin(
        raw.set_index(["game_id", "play_id"]).index)]], ignore_index=True)
    raw = raw.drop_duplicates(["game_id", "play_id"])
    dec = dec.merge(raw, on=["game_id", "play_id"], how="left", suffixes=("", "_raw"))
    dec["coach"] = np.where(dec["team"] == dec["home_team"],
                            dec["game_id"].map(pbp.groupby("game_id")["home_coach"].first()),
                            dec["game_id"].map(pbp.groupby("game_id")["away_coach"].first()))
    return dec


# ------------------------------------------------------------- evaluation ---
_G = {}


def _init(pbp_games, n, neutral=False, salt=0):
    _G["bundle"] = Bundle.load()
    _G["factory"] = GameContextFactory(_G["bundle"], pbp_games)
    _G["n"] = n
    _G["neutral"] = neutral
    _G["salt"] = salt


def _options_for(r, root: RootState, sim: Simulator):
    dec = r["decision"]
    if dec == "lead_tempo":
        ra = float(r["runoff_actual"])
        return {"as_played": {"to_def": False, "runoff": ra}, "milk": {"to_def": False, "runoff": MILK_RUNOFF}}
    opts = dict(OPTIONS[dec])
    if dec == "off_clock_stop":
        # the option the offense chose is played at the pace it actually achieved; the others at league pace
        ra = r.get("runoff_actual", np.nan)
        if r["actual"] in ("hurry", "spike") and ra == ra and ra is not None:
            opts[r["actual"]] = {**opts[r["actual"]], "runoff": float(ra)}
        o = root.pos
        if root.to[o] <= 0:
            opts.pop("timeout")
        if root.down >= 4:
            opts.pop("spike")
    if dec == "fourth_down":
        o = root.pos
        p_fg = float(sim.fg_prob(np.array([root.yl + 17.0]), np.array([o]))[0])
        if p_fg < 0.05:
            opts.pop("fg")
        if root.yl < 30:
            opts.pop("punt")
    if dec == "kneel":
        o = root.pos
        t_half = root.t - (1800.0 if root.t > 1800 else 0.0)
        ok = sim.kneel_out_possible(np.array([t_half]), np.array([root.down]), np.array([root.to[1 - o]]),
                                    np.array([False]), np.array([root.t > (1920 if root.t > 1800 else 120)]))
        if not ok[0]:
            return {}
    return opts


def neutralize(ctx):
    """Same game (spread, weather, home field, era) but league-average units, kicker and punter."""
    from dataclasses import replace
    era = ctx.delta.mean(axis=0, keepdims=True).repeat(2, axis=0)
    return replace(ctx, delta=era, proe=np.zeros(2), kicker_shift=np.zeros(2), punter_shift=np.zeros(2),
                   two_pt=np.full(2, 0.47))


def _eval_game(args):
    game_id, rows = args
    b, n = _G["bundle"], _G["n"]
    ctx, home, away = _G["factory"].for_game(game_id)
    if _G.get("neutral"):
        ctx = neutralize(ctx)
    sim = Simulator(b, ctx)
    res = []
    for r in rows:
        try:
            if r["root_kind"] == "post":
                root = _root_post_play(r, ctx.home)
            elif r["root_kind"] == "snap":
                root = _root_snap(r, ctx.home)
            elif r["root_kind"] == "pat":
                root = _root_snap(r, ctx.home, phase=PAT)
            else:  # kickoff: posteam is the receiving team in nflverse
                root = _root_snap(r, ctx.home, phase=KICKOFF, pos_team=r["defteam"])
        except (ValueError, TypeError):
            continue
        opts = _options_for(r, root, sim)
        if len(opts) < 2 or r["actual"] not in opts:
            continue
        persp = 0 if r["team"] == ctx.home else 1
        seed = int(r["play_id"]) * 7 + 13 + 1_000_003 * _G.get("salt", 0)
        vals_a, vals_b = {}, {}
        for name, act in opts.items():
            vals_a[name] = sim.run(root, n=n, action=act, perspective=persp, seed=seed)
            # the neutral-team re-grade only needs which option wins, not a cross-fitted edge
            vals_b[name] = vals_a[name] if _G.get("neutral") else sim.run(
                root, n=n, action=act, perspective=persp, seed=seed + 1)
        mean_a = {k: float(v.mean()) for k, v in vals_a.items()}
        mean_b = {k: float(v.mean()) for k, v in vals_b.items()}
        rec = max(mean_a, key=mean_a.get)
        diff = vals_b[rec] - vals_b[r["actual"]]
        out = {"game_id": game_id, "play_id": r["play_id"], "decision": r["decision"], "recommended": rec,
               "gain": float(diff.mean()), "gain_se": float(diff.std(ddof=1) / np.sqrt(n)) if rec != r["actual"] else 0.0,
               "wp_actual": float((mean_a[r["actual"]] + mean_b[r["actual"]]) / 2)}
        for k in opts:
            out[f"wp_{k}"] = (mean_a[k] + mean_b[k]) / 2
        team = home if r["team"] == ctx.home else away
        opp = away if r["team"] == ctx.home else home
        out.update({"kicker": team.kicker, "kicker_rating": team.kicker_rating, "punter": team.punter,
                    "punter_rating": team.punter_rating, "off_pass": team.off_pass, "off_rush": team.off_rush,
                    "opp_def_pass": opp.def_pass, "opp_def_rush": opp.def_rush})
        res.append(out)
    return res


def evaluate(dec: pd.DataFrame, pbp: pd.DataFrame, n: int = 600, workers: int = 4, progress=True,
             neutral: bool = False, salt: int = 0) -> pd.DataFrame:
    tasks = [(gid, g.to_dict("records")) for gid, g in dec.groupby("game_id")]
    games = pbp[pbp["game_id"].isin(dec["game_id"].unique())]
    out = []
    t0 = time.time()
    with mp.get_context("fork").Pool(workers, initializer=_init, initargs=(games, n, neutral, salt)) as pool:
        for i, r in enumerate(pool.imap_unordered(_eval_game, tasks, chunksize=1)):
            out.extend(r)
            if progress and (i + 1) % 50 == 0:
                el = time.time() - t0
                print(f"  {i + 1}/{len(tasks)} games, {len(out)} decisions, {el:.0f}s elapsed, "
                      f"~{el / (i + 1) * (len(tasks) - i - 1):.0f}s left", flush=True)
    res = pd.DataFrame(out)
    return dec.merge(res, on=["game_id", "play_id", "decision"], how="inner")


def run(seasons=None, n=600, workers=4, limit_games=None, families=None):
    seasons = seasons or config.ANALYSIS_SEASONS
    pbp = data.load(tuple(range(2016, 2027)))
    pbp = pbp[pbp["season"].isin(seasons)]
    dec = extract_decisions(pbp, seasons)
    if families:
        dec = dec[dec["decision"].isin(families)]
    if limit_games:
        keep = dec["game_id"].drop_duplicates().sample(limit_games, random_state=0)
        dec = dec[dec["game_id"].isin(keep)]
    print(f"{len(dec)} candidate decisions in {dec['game_id'].nunique()} games:")
    print(dec.groupby(["decision", "actual"]).size().to_string())
    return evaluate(dec, pbp, n=n, workers=workers)


def sensitivity(graded: pd.DataFrame, decisions=("fourth_down", "play_select"), n=600, workers=4) -> pd.DataFrame:
    """Re-grade decisions with league-average teams to see when team-specific variables flip the call."""
    pbp = data.load(tuple(range(2016, 2027)))
    sub = graded[graded["decision"].isin(decisions)]
    base_cols = [c for c in sub.columns if not c.startswith("wp_") and c not in (
        "recommended", "gain", "gain_se", "kicker", "kicker_rating", "punter", "punter_rating", "off_pass",
        "off_rush", "opp_def_pass", "opp_def_rush")]
    neu = evaluate(sub[base_cols], pbp[pbp["game_id"].isin(sub["game_id"].unique())], n=n, workers=workers,
                   neutral=True)
    neu = neu[["game_id", "play_id", "decision", "recommended"]].rename(columns={"recommended": "rec_neutral"})
    out = sub.merge(neu, on=["game_id", "play_id", "decision"], how="inner")
    out["flipped"] = out["recommended"] != out["rec_neutral"]
    wp_rec = out.apply(lambda r: r[f"wp_{r['recommended']}"], axis=1)
    wp_neu = out.apply(lambda r: r[f"wp_{r['rec_neutral']}"], axis=1)
    out["value_of_team_info"] = wp_rec - wp_neu
    return out


def confirm(graded: pd.DataFrame, keys: list, n: int = 4000, workers: int = 4) -> pd.DataFrame:
    """Re-grade selected decisions with fresh seeds and many more simulations (confirmation pass)."""
    pbp = data.load(tuple(range(2016, 2027)))
    k = pd.Series([f"{g}#{int(p)}" for g, p in zip(graded["game_id"], graded["play_id"])], index=graded.index)
    sub = graded[k.isin(keys)]
    base_cols = [c for c in sub.columns if not c.startswith("wp_") and c not in (
        "recommended", "gain", "gain_se", "kicker", "kicker_rating", "punter", "punter_rating", "off_pass",
        "off_rush", "opp_def_pass", "opp_def_rush", "is_rec", "sig_error", "wp_cost", "opp")]
    res = evaluate(sub[base_cols], pbp[pbp["game_id"].isin(sub["game_id"].unique())], n=n, workers=workers,
                   progress=False, salt=7)
    res["key"] = [f"{g}#{int(p)}" for g, p in zip(res["game_id"], res["play_id"])]
    return res[["key", "decision", "actual", "recommended", "gain", "gain_se"]].rename(
        columns={"recommended": "confirm_rec", "gain": "confirm_gain", "gain_se": "confirm_se"})
