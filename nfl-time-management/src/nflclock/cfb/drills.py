"""Coach mode's drill library (design 3.5): real late-game college situations, each the start of a drill.

A drill is the snap a category is about (the first snap of a drive for most; the 4th-down snap, the try after a
touchdown, the kickoff after a score), from a clock-good FBS-vs-FBS game. Each carries the spot (dailygame's spot
format, plus college, rules and side), both teams as they were that week (team ratings, kicker, punter, the players
the play-by-play names), and what really happened: the staff's key decisions from then on (timeouts, spikes,
kneels, 4th downs, kicks, tries), the drive's result and the final score.
"""
from __future__ import annotations

import json
import multiprocessing as mp
from dataclasses import fields, replace

import numpy as np
import pandas as pd

from .. import tendency as T
from ..context import GameContextFactory
from ..sim import KICKOFF, PAT, SNAP, GameContext, RootState, Simulator
from . import config as K

CATEGORIES = {
    "two_min_o": {"label": "Two-minute offense", "desc": "Fourth quarter, 0:30-2:30 left, down 1-8, first down: go win it."},
    "four_min_o": {"label": "Four-minute offense", "desc": "Fourth quarter, 2:00-5:30 left, up 1-8, your ball: close it out."},
    "end_half": {"label": "End of the half", "desc": "0:20-2:00 before halftime, your 20 to their 45, within 14: attack or run it out."},
    "fourth": {"label": "Fourth down", "desc": "4th and 5 or less, late in a half, between the 30s, within 16: go, kick or punt."},
    "two_pt": {"label": "Kick or go for two", "desc": "A fourth-quarter touchdown at a score where the try matters."},
    "backed_up": {"label": "Backed up", "desc": "Inside your own 10 in the last 8:00, within 8."},
    "red_zone": {"label": "Red zone, late", "desc": "First down at their 20 or closer in the last 5:00, from down 8 to up 3."},
    "two_min_d": {"label": "Two-minute defense", "desc": "They have the ball in the last 2:30, down 1-8: stop them, and the clock."},
    "kick_to_win": {"label": "Kick to win", "desc": "Down 1-2 or tied, inside their 35, the last 1:30: set up the kick."},
    "onside": {"label": "Onside or deep", "desc": "You just scored, still behind, the last 3:00: kick it deep or onside."},
}
TWO_PT_MARGINS = [-2, -5, -1, 1, -8, -9, -10, -12, -13, 5]   # the scoring team's margin after the touchdown, before the try
CAP = 300                 # drills per category
MIN_DRILLS = 150          # the acceptance floor per category
DRILL_CHUNK = 20          # drills per web/drills file (one is loaded per drill)
GAME_MAX = 4              # categories one game can give drills to (a close game has a two-minute drive, a try...)
RECENT = 2023             # seasons from here on get the cap's preference (the current clock rules)
DIFF_N = 500              # games per policy for a drill's difficulty (common dice: the two policies share every draw)
DRIVE_WORDS = {"Touchdown": "touchdown", "Field goal": "field goal", "Punt": "punt", "Turnover": "turnover",
               "Turnover on downs": "turnover on downs", "End of half": "ran out the clock", "Missed field goal": "missed field goal",
               "Opp touchdown": "defensive touchdown", "Safety": "safety"}


def _yl_text(yl: float) -> str:
    yl = int(round(yl))
    return "the 50" if yl == 50 else (f"the opp {yl}" if yl < 50 else f"own {100 - yl}")


def clock_text(qsr: float) -> str:
    qsr = int(round(qsr))
    return f"{qsr // 60}:{qsr % 60:02d}"


# ---------------------------------------------------------------- candidates ---
def _snaps(e: pd.DataFrame) -> pd.DataFrame:
    s = e[e["is_snap"] & e["posteam_timeouts_remaining"].notna() & e["defteam_timeouts_remaining"].notna()].copy()
    s = s.sort_values(["game_id", "row_order"])
    new = (s["posteam"] != s.groupby("game_id")["posteam"].shift(1)) | (s["half"] != s.groupby("game_id")["half"].shift(1))
    s["drive"] = new.groupby(s["game_id"]).cumsum()
    return s


def candidates(e: pd.DataFrame, cats=None) -> pd.DataFrame:
    """One row per (category, game, drive): the snap (or try, or kickoff) the drill starts at."""
    s = _snaps(e)
    q, qs, m, yl, dn, ytg = s["qtr"], s["quarter_seconds_remaining"], s["margin"], s["yardline_100"], s["down"], s["ydstogo"]
    play = s["play_type"].isin(["run", "pass", "no_play", "qb_kneel", "qb_spike", "punt", "field_goal"])
    rows = {
        "two_min_o": play & (q == 4) & qs.between(30, 150) & m.between(-8, -1) & (dn == 1),
        "four_min_o": play & (q == 4) & qs.between(120, 330) & m.between(1, 8) & (dn == 1),
        "end_half": play & (q == 2) & qs.between(20, 120) & yl.between(45, 80) & (m.abs() <= 14) & (dn == 1),
        "fourth": s["play_type"].isin(["run", "pass", "punt", "field_goal"]) & (dn == 4) & (ytg <= 5)
                  & (((q == 4) & (qs <= 600)) | ((q == 2) & (qs <= 120))) & (m.abs() <= 16) & yl.between(30, 70),
        "backed_up": play & (q == 4) & (qs <= 480) & (yl >= 90) & (m.abs() <= 8) & (dn == 1),
        "red_zone": play & (q == 4) & (qs <= 300) & (yl <= 20) & m.between(-8, 3) & (dn == 1),
        "two_min_d": play & (q == 4) & (qs <= 150) & m.between(-8, -1) & (dn == 1),
        "kick_to_win": play & (q == 4) & (qs <= 90) & (yl <= 35) & m.between(-2, 0),
    }
    out = []
    for cat, mask in rows.items():
        if cats and cat not in cats:
            continue
        x = s[mask]
        x = x.groupby(["game_id", "drive"]).head(1) if cat != "fourth" else x
        x = x.assign(category=cat, side="def" if cat == "two_min_d" else "off", phase="snap",
                     player=np.where(cat == "two_min_d", x["defteam"], x["posteam"]))
        out.append(x)
    # the try after a fourth-quarter touchdown
    if not cats or "two_pt" in cats:
        t = e[((e["extra_point_attempt"] == 1) | (e["two_point_attempt"] == 1)) & (e["qtr"] == 4)
              & e["posteam_timeouts_remaining"].notna()]
        t = t[(t["posteam_score"] - t["defteam_score"]).isin(TWO_PT_MARGINS)]
        out.append(t.assign(category="two_pt", side="off", phase="pat", player=t["posteam"], drive=-1))
    # the kickoff after a score by a team still behind
    if not cats or "onside" in cats:
        k = e[(e["play_type"] == "kickoff") & (e["qtr"] == 4) & (e["quarter_seconds_remaining"] <= 180)
              & e["posteam_timeouts_remaining"].notna() & (e["defteam_score"] < e["posteam_score"])]
        k = k[(k["posteam_score"] - k["defteam_score"]) <= 16]
        out.append(k.assign(category="onside", side="off", phase="kickoff", player=k["defteam"], drive=-1))
    c = pd.concat(out, ignore_index=True)
    c["spot_id"] = c["game_id"] + "#" + c["play_id"].astype(int).astype(str)
    return c


def select(c: pd.DataFrame, cap: int = CAP, seed: int = 2026) -> pd.DataFrame:
    """At most `cap` a category: recent seasons first, then games that were close (the real win probability nearest
    a coin flip), spread over teams (a team's next drill in a category waits behind every team's first), one drill
    per game per category, and a game in at most GAME_MAX categories."""
    rng = np.random.default_rng(seed)
    c = c.assign(close=-np.abs(c["wp"].fillna(0.5) - 0.5), recent=(c["season"] >= RECENT).astype(int), r=rng.random(len(c)))
    c = c.sort_values(["category", "recent", "close", "r"], ascending=[True, False, False, True])
    c = c.drop_duplicates(["category", "game_id"])
    c["team_rank"] = c.groupby(["category", "player"]).cumcount()
    c = c.sort_values(["category", "team_rank", "recent", "close", "r"], ascending=[True, True, False, False, True])
    # a game in at most GAME_MAX categories, the scarcest categories choosing first
    scarce = c["category"].map(c["category"].value_counts())
    c = c.assign(scarce=scarce).sort_values(["scarce", "category", "team_rank", "recent", "close", "r"],
                                            ascending=[True, True, True, False, False, True])
    c = c[c.groupby("game_id").cumcount() < GAME_MAX]
    c = c.sort_values(["category", "team_rank", "recent", "close", "r"], ascending=[True, True, False, False, True])
    return c.groupby("category", group_keys=False).head(cap).drop(columns=["scarce"]).reset_index(drop=True)


# ------------------------------------------------------------------ records ---
def _abbr(teams: pd.DataFrame, school: str) -> str:
    return str(teams.loc[school, "abbreviation"]) if school in teams.index else school


def spot_record(r, teams: pd.DataFrame, receive2h: dict, rules: str) -> dict:
    """dailygame.spot_record's format: [away, home] scores and timeouts, codes, the real game; plus college, rules, side."""
    home, away = r["home_team"], r["away_team"]
    pos = r["posteam"] if r["phase"] != "kickoff" else r["defteam"]       # a kickoff's spot belongs to the kicking team
    home_pos = pos == home
    off_to, def_to = int(r["posteam_timeouts_remaining"]), int(r["defteam_timeouts_remaining"])
    if r["phase"] == "kickoff":
        off_to, def_to = def_to, off_to
    ps, ds = int(r["posteam_score"]), int(r["defteam_score"])
    if r["phase"] == "kickoff":
        ps, ds = ds, ps
    score = [ds, ps] if home_pos else [ps, ds]
    to = [def_to, off_to] if home_pos else [off_to, def_to]
    phase = r["phase"]
    start = {"qtr": int(r["qtr"]), "clock": float(r["quarter_seconds_remaining"]), "score": score, "pos": _abbr(teams, pos),
             "down": int(r["down"]) if phase == "snap" else 1,
             "ytg": float(r["ydstogo"]) if phase == "snap" else (3.0 if phase == "pat" else 10.0),
             "yl": float(r["yardline_100"]) if phase == "snap" else (3.0 if phase == "pat" else 65.0),
             "to": to, "running": False, "phase": phase, "receive2h": _abbr(teams, receive2h.get(r["game_id"], away))}
    res = r.get("fixed_drive_result")
    return {
        "id": r["spot_id"], "category": r["category"], "home": _abbr(teams, home), "away": _abbr(teams, away),
        "player": _abbr(teams, r["player"]), "side": r["side"], "college": True, "rules": rules,
        "indoor": False, "wind": 0.0, "temp": None, "start": start,
        "spread": float(np.nan_to_num(r["spread_line"])),
        "real": {"season": int(r["season"]), "week": int(r["week"]), "type": str(r["season_type"]), "date": str(r["game_date"]),
                 "coach": None, "call": None,
                 "drive": DRIVE_WORDS.get(res, None) if isinstance(res, str) else None,
                 "final": {"away": int(r["away_score"]), "home": int(r["home_score"])}},
    }


def _down_text(down, ytg, yl) -> str:
    d = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}.get(int(down) if down == down else 1, "1st")
    ytg = "goal" if ytg >= yl else int(round(ytg))
    return f"{d} & {ytg} at {_yl_text(yl)}"


def real_actions(g: pd.DataFrame, start_idx, player: str, teams: pd.DataFrame, limit: int = 12) -> tuple[list, dict]:
    """The staffs' key decisions from the drill's start to the end of the half (design: timeouts, spikes, kneels,
    4th downs, field goals, punts, tries, onside kicks), and the drill's first call as kind "play"."""
    rows = g.loc[start_idx:]
    rows = rows[rows["half"] == g.loc[start_idx, "half"]]
    acts = []

    def add(r, kind, family, label):
        acts.append({"t": float(r["game_seconds_remaining"]), "clock": clock_text(r["quarter_seconds_remaining"]), "q": int(r["qtr"]),
                     "kind": kind, "family": family, "label": label, "team": _abbr(teams, r["posteam"] if pd.notna(r["posteam"]) else r["timeout_team"])})

    first = rows.iloc[0]
    for idx, r in rows.iterrows():
        pt = r["play_type"]
        if r["timeout"] == 1 and isinstance(r["timeout_team"], str):
            who = r["timeout_team"]
            nm = _abbr(teams, who) if who in teams.index else who
            acts.append({"t": float(r["game_seconds_remaining"]), "clock": clock_text(r["quarter_seconds_remaining"]), "q": int(r["qtr"]),
                         "kind": "timeout", "family": "off_clock_stop" if who == first.get("posteam") else "def_timeout",
                         "label": f"Timeout {nm} with {clock_text(r['quarter_seconds_remaining'])} left", "team": nm})
        elif pt == "qb_spike":
            add(r, "spike", "off_clock_stop", f"Spiked on {_down_text(r['down'], r['ydstogo'], r['yardline_100'])}")
        elif pt == "qb_kneel":
            add(r, "kneel", "kneel", f"Knelt on {_down_text(r['down'], r['ydstogo'], r['yardline_100'])}")
        elif pt == "field_goal":
            res = {"made": "good", "missed": "missed", "blocked": "blocked"}.get(r["field_goal_result"], "")
            add(r, "fg", "fourth_down", f"{int(r['kick_distance'])}-yard field goal: {res}")
        elif pt == "punt":
            add(r, "punt", "fourth_down", f"Punted on {_down_text(r['down'], r['ydstogo'], r['yardline_100'])}")
        elif pt in ("run", "pass") and r["down"] == 4:
            conv = r["yards_gained"] >= r["ydstogo"] or r["touchdown"] == 1 or r.get("first_down_penalty") == 1
            add(r, "fourth", "fourth_down", f"Went for it on {_down_text(r['down'], r['ydstogo'], r['yardline_100'])}: "
                + ("converted" if conv else "stopped"))
        elif r["two_point_attempt"] == 1:
            add(r, "two", "pat", "Went for two: " + ("good" if r["two_point_conv_result"] == "success" else "no good"))
        elif r["extra_point_attempt"] == 1 and idx == start_idx:
            add(r, "two", "pat", "Kicked the extra point: " + ("good" if r["extra_point_result"] == "good" else "no good"))
        elif pt == "kickoff" and r["onside"] == 1:
            rec = r["own_kickoff_recovery"] == 1
            acts.append({"t": float(r["game_seconds_remaining"]), "clock": clock_text(r["quarter_seconds_remaining"]), "q": int(r["qtr"]),
                         "kind": "onside", "family": "onside", "label": "Onside kick: " + ("recovered" if rec else "lost"),
                         "team": _abbr(teams, r["defteam"])})
        elif pt == "kickoff" and idx == start_idx:
            acts.append({"t": float(r["game_seconds_remaining"]), "clock": clock_text(r["quarter_seconds_remaining"]), "q": int(r["qtr"]),
                         "kind": "kick", "family": "onside", "label": "Kicked deep", "team": _abbr(teams, r["defteam"])})
        if idx == start_idx and pt in ("run", "pass") and r["down"] in (1, 2, 3):
            add(r, "play", "play_select", ("Ran it" if pt == "run" else "Threw it") + f" on {_down_text(r['down'], r['ydstogo'], r['yardline_100'])}")
        if len(acts) >= limit:
            break
    return acts, {}


def story(sp: dict, teams: pd.DataFrame, names: dict, real: dict) -> str:
    """One factual line from the data: who, the score and clock, and how it ended."""
    st = sp["start"]
    me = sp["player"]
    home = sp["home"] == me
    my, op = (st["score"][1], st["score"][0]) if home else (st["score"][0], st["score"][1])
    opp = sp["away"] if home else sp["home"]
    mn, on = names.get(me, me), names.get(opp, opp)
    lead = "tied" if my == op else (f"up {my - op}" if my > op else f"down {op - my}")
    when = f"{clock_text(st['clock'])} left in the {'4th quarter' if st['qtr'] == 4 else '2nd quarter'}"
    f = sp["real"]["final"]
    fm, fo = (f["home"], f["away"]) if home else (f["away"], f["home"])
    end = f"{mn} {'won' if fm > fo else 'lost' if fm < fo else 'tied'} {fm}-{fo}"
    if sp["side"] == "def":
        return f"{season_line(sp)}: {mn}, {lead} with {when}, on defense against {on}. {end}."
    if st["phase"] == "pat":
        return f"{season_line(sp)}: {mn} scored to be {lead} with {when} against {on}. {end}."
    if st["phase"] == "kickoff":
        return f"{season_line(sp)}: {mn} scored to be {lead} with {when} against {on} and kicked off. {end}."
    drive = sp["real"].get("drive")
    return (f"{season_line(sp)}: {mn}, {lead} with {when}, ball at {_yl_text(st['yl'])} against {on}."
            + (f" The drive ended in a {drive}." if drive and drive not in ("ran out the clock",) else
               " They ran out the clock." if drive else "") + f" {end}.")


def season_line(sp: dict) -> str:
    r = sp["real"]
    return f"{r['season']} {'postseason' if r['type'] == 'POST' else 'week ' + str(r['week'])}"


# --------------------------------------------------------------------- teams ---
_IDX: dict = {}
TEAM_COLS = ["posteam", "defteam", "play_type", "passer", "rusher", "receiver", "complete_pass", "incomplete_pass",
             "yards_gained", "def_player", "def_event", "kicker_player_id", "punter_player_id"]


def _index(bundle) -> dict:
    """Dict lookups of the bundle's as-of ratings (team, kicker, punter by season and week), built once a bundle."""
    key = id(bundle)
    if key not in _IDX:
        tr = bundle.team_ratings
        cols = ["off_pass", "off_rush", "def_pass", "def_rush", "proe"]
        _IDX.clear()
        _IDX[key] = {
            "team": {(int(a), int(b), c): dict(zip(cols, v)) for a, b, c, *v in tr[["season", "week", "team"] + cols].itertuples(index=False)},
            "kicker": {(int(a), int(b), c): r for a, b, c, r in bundle.kicker_ratings[["season", "week", "kicker_player_id", "rating"]].itertuples(index=False)},
            "punter": {(int(a), int(b), c): r for a, b, c, r in bundle.punter_ratings[["season", "week", "punter_player_id", "rating"]].itertuples(index=False)}}
    return _IDX[key]


def team_record(bundle, game: pd.DataFrame, school: str, season: int, week: int, teams: pd.DataFrame) -> dict:
    """The custom_spots team shape: ratings as of the week, kicker and punter of the game with their ratings, and the
    players the play-by-play names (generic slots for the rest). No calls."""
    ix = _index(bundle)
    r = ix["team"].get((season, week, school))
    base = {k: round(float(r[k]), 4) if r is not None else 0.0 for k in ("off_pass", "off_rush", "def_pass", "def_rush", "proe")}
    mine = game[game["posteam"] == school]
    qb = mine.loc[mine["play_type"] == "pass", "passer"].dropna()
    qb_name = qb.mode().iat[0] if len(qb) else None
    def stat_qb(n):
        p = mine[(mine["passer"] == n) & (mine["play_type"] == "pass")]
        return f"In this game: {int(p['complete_pass'].sum())} of {int(((p['complete_pass'] == 1) | (p['incomplete_pass'] == 1)).sum())}, {int(p.loc[p['complete_pass'] == 1, 'yards_gained'].sum())} yards"
    off = []
    if qb_name:
        off.append({"pos": "QB", "name": qb_name, "stat": stat_qb(qb_name)})
    ru = mine[(mine["play_type"] == "run") & mine["rusher"].notna() & (mine["rusher"] != qb_name)]
    for n, g in list(ru.groupby("rusher"))[:0] or sorted(ru.groupby("rusher"), key=lambda x: -len(x[1]))[:1]:
        off.append({"pos": "RB", "name": n, "stat": f"In this game: {len(g)} carries, {int(g['yards_gained'].sum())} yards"})
    rc = mine[(mine["complete_pass"] == 1) & mine["receiver"].notna()]
    for n, g in sorted(rc.groupby("receiver"), key=lambda x: -x[1]["yards_gained"].sum())[:3]:
        off.append({"pos": "WR", "name": n, "stat": f"In this game: {len(g)} catches, {int(g['yards_gained'].sum())} yards"})
    off += [{"pos": p, "name": None, "stat": "Offensive line"} for p in ("LT", "LG", "C", "RG", "RT")]
    theirs = game[(game["defteam"] == school) & game["def_player"].notna()]
    de = [{"pos": "DEF", "name": n, "stat": "In this game: " + ", ".join(sorted(set(g["def_event"].dropna())))}
          for n, g in sorted(theirs.groupby("def_player"), key=lambda x: -len(x[1]))[:4]]
    de += [{"pos": p, "name": None, "stat": "Defense"} for p in ("DL", "LB", "DB")]
    k = game[(game["posteam"] == school) & game["kicker_player_id"].notna()]
    kid = k["kicker_player_id"].mode().iat[0] if len(k) else None
    krat = ix["kicker"].get((season, week, kid)) if kid else None
    p = game[(game["posteam"] == school) & game["punter_player_id"].notna()]
    pid = p["punter_player_id"].mode().iat[0] if len(p) else None
    prat = ix["punter"].get((season, week, pid)) if pid else None
    return {"team": _abbr(teams, school), "coach": None, "base": base,
            "qb": {"name": qb_name, "adjustment": 0.0},
            "injury_adjustment": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0},
            "kicker": {"name": kid.split("|")[0] if kid else None, "rating": round(float(krat), 4) if krat is not None else 0.0},
            "punter": {"name": pid.split("|")[0] if pid else None, "rating": round(float(prat), 3) if prat is not None else 0.0},
            "lineup": {"off": off, "def": de}}


# --------------------------------------------------------------- difficulty ---
_G: dict = {}


def _init(bundle_path, games, fourth_model, rules):
    from threadpoolctl import threadpool_limits
    threadpool_limits(1)
    from ..models import Bundle
    _G["b"] = Bundle.load(bundle_path)
    _G["f"] = GameContextFactory(_G["b"], games) if games is not None else None
    _G["m"] = fourth_model
    _G["rules"] = rules


def _with_rules(ctx: GameContext, rules: str | None) -> GameContext:
    if rules and "rules" in {f.name for f in fields(GameContext)}:
        return replace(ctx, rules=rules)
    return ctx


def _root(sp: dict, ctx: GameContext, teams_rev: dict) -> tuple[RootState, int]:
    st = sp["start"]
    home = sp["home"]
    t = (4 - st["qtr"]) * 900 + st["clock"]
    pos = 0 if st["pos"] == home else 1
    phase = {"snap": SNAP, "pat": PAT, "kickoff": KICKOFF}[st["phase"]]
    root = RootState(t=float(t), pos=pos, score=(st["score"][1], st["score"][0]), down=int(st["down"]), ytg=float(st["ytg"]),
                     yl=float(st["yl"]), to=(int(st["to"][1]), int(st["to"][0])), clock_running=False, phase=phase)
    return root, 0 if sp["player"] == home else 1


def _diff_game(args):
    gid, items = args
    if _G["f"] is None:          # generic teams (the high-school drills): league-average units, no spread
        from ..context import TeamInfo, make_context
        ctx = make_context(_G["b"], TeamInfo(team=items[0][1]["home"]), TeamInfo(team=items[0][1]["away"]))
    else:
        ctx, _, _ = _G["f"].for_game(gid)
    ctx = _with_rules(ctx, _G["rules"])
    out = []
    sim = Simulator(_G["b"], ctx)       # one a game: the tilts and tables depend on the teams only
    for i, sp in items:
        root, me = _root(sp, ctx, {})
        seed = 7919 * (i + 1)
        sim.ctx = ctx
        sound = sim.run(root, n=DIFF_N, perspective=me, seed=seed)
        typ = list(ctx.coach4th)
        typ[me] = {"model": _G["m"], "shift": 0.0}
        sim.ctx = replace(ctx, coach4th=typ)      # the policy reads ctx.coach4th as it plays
        typical = sim.run(root, n=DIFF_N, perspective=me, seed=seed)
        out.append((i, float(sound.mean()), float(sound.mean() - typical.mean())))
    return out


def difficulty(spots: list, games: pd.DataFrame, bundle_path, fourth_model: dict, rules: str | None,
               workers: int = 4, log=print) -> dict:
    """lev = WP(sound policy) - WP(typical coach's 4th downs) for the player's team, DIFF_N games each on common dice
    (Python simulator, `rules` when the simulator has rulesets: WS1's GameContext(rules)). wp0 = the sound policy's WP."""
    by_game: dict = {}
    for i, sp in enumerate(spots):
        key = sp["id"].split("#")[0] if games is not None else f"{sp['home']}|{i // 20}"
        by_game.setdefault(key, []).append((i, sp))
    tasks = list(by_game.items())
    res = {}
    # spawn, not fork: a forked child of a process that has run LightGBM can hang on its OpenMP state
    cols = ["game_id", "season", "week", "home_team", "away_team", "spread_line", "roof", "wind", "temp", "home_opening_kickoff",
            "season_type", "home_coach", "away_coach", "result", "kicker_player_id", "kicker_player_name", "posteam",
            "play_type", "punter_player_id", "punter_player_name"]
    games = games[[c for c in cols if c in games]] if games is not None else None
    with mp.get_context("spawn").Pool(workers, initializer=_init, initargs=(bundle_path, games, fourth_model, rules)) as pool:
        for k, r in enumerate(pool.imap_unordered(_diff_game, tasks, chunksize=4)):
            for i, wp0, lev in r:
                res[i] = (wp0, lev)
            if (k + 1) % 200 == 0:
                log(f"  difficulty: {k + 1}/{len(tasks)} games")
    return res


def grade(drills: pd.DataFrame) -> np.ndarray:
    """1-5 within each category: the leverage of sound play's rank, adjusted by how far from even the start is (a long
    shot is harder), as category quantiles."""
    lev_r = drills.groupby("cat")["lev"].rank(pct=True)
    wp_r = drills.groupby("cat")["wp0"].rank(pct=True, ascending=False)
    score = 0.6 * lev_r + 0.4 * wp_r
    q = score.groupby(drills["cat"]).rank(pct=True)
    return np.clip(np.ceil(q * 5), 1, 5).astype(int)


def fourth_model(e: pd.DataFrame) -> dict:
    """The typical FBS coach's 4th-down model (tendency.fit_fourth_all on college 4th downs, 2023 on)."""
    g = e[e["fbs"]].copy()
    g["off_coach"] = g["posteam"]          # no coach names in the data: per-team shifts stand in (unused here)
    model, _ = T.fit_fourth_all(g, [s for s in K.LIB_SEASONS if s <= 2025])
    return model


def classic(e: pd.DataFrame) -> list:
    """Curated famous situations (cfb/classic_drills.json), each resolved in the data by its game, quarter, clock
    and team (never by row number): a classic missing from the data is reported, not invented."""
    path = K.PKG / "classic_drills.json"
    if not path.exists():
        return []
    items = json.loads(path.read_text())["drills"]
    out = []
    for c in items:
        g = e[e["game_id"] == str(c["game_id"])]
        m = g[(g["qtr"] == c["qtr"]) & (g["posteam"] == c["posteam"])]
        if c["phase"] == "snap":
            m = m[m["is_snap"] & (m["down"] == c.get("down", m["down"]))]
        elif c["phase"] == "pat":
            m = m[(m["extra_point_attempt"] == 1) | (m["two_point_attempt"] == 1)]
        else:
            m = g[(g["qtr"] == c["qtr"]) & (g["play_type"] == "kickoff") & (g["defteam"] == c["posteam"])]
        m = m[(m["quarter_seconds_remaining"] - c["clock"]).abs() <= c.get("tol", 12)]
        if not len(m):
            out.append({**c, "found": False})
            continue
        r = m.iloc[(m["quarter_seconds_remaining"] - c["clock"]).abs().argmin()]
        out.append({**c, "found": True, "row": r.name})
    return out
