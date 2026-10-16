"""Playbook for the daily play-calling game: every real snap since 2022, labeled with the call behind it.

Calls come from nflverse play-by-play (run gap and direction, pass depth and side) and FTN charting
(ball spot on the hashes, play action, screens, RPOs, trick plays, QB out of the pocket, QB sneaks).
Strong side means the wide side of the field and weak side the short side: public charting does not
record where the tight end lines up, but FTN does chart which hash the ball starts on, and offenses
usually set their strength to the field. (Checked in the data: from the left hash, outside runs and
completions to the left go out of bounds 27% of the time against 23% to the right.)

For each call this module builds

  * an outcome library by situation (game mode x down x distance x field zone, merged when sparse),
    with the same fields the simulator uses (yards, clock flags, turnovers, duration, EPA), plus what
    happened on the real play: sacks, strip-sacks, interceptions, pick-sixes, fumbles (lost or not),
    bad snaps, scrambles, throwaways, drops, near-interceptions, the penalty called, the look
    (formation, motion, men in the box, blitz), and for the game's animation the air yards, who had
    the ball and whether he broke a tackle;
  * team ratings by call, offense and defense, as of any week (shrunk EPA per play over league
    average for that call) and their league percentiles;
  * how often NFL play-callers choose each call in each situation (the "typical play-caller");
  * how much trying to get out of bounds raises the odds of stopping the clock on that call, measured
    on snaps where the offense needed the clock stopped.

Sacks, scrambles and throwaways have no target, and penalties and bad snaps have no call; they are
spread over the matching calls in proportion to how often each call is made, so every pass call
carries real sack and interception risk and any call can be wrecked by a bad snap.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request

import numpy as np
import pandas as pd

from . import config, data
from .library import (N_DOWN, N_FINE, N_MODE, N_YTG, N_ZONE, _duration, decode_fine, down_bucket, fine_key,
                      game_mode, zone_of)

SEASONS = (2022, 2023, 2024, 2025, 2026)
CALLS = [   # id, call-sheet label, engine kind, what the play-by-play says
    ("rb_out_strong", "RB outside, strong side", "run", "runs outside to the strong side"),
    ("rb_out_weak", "RB outside, weak side", "run", "runs outside to the weak side"),
    ("rb_tackle_strong", "RB off tackle, strong side", "run", "runs off tackle to the strong side"),
    ("rb_tackle_weak", "RB off tackle, weak side", "run", "runs off tackle to the weak side"),
    ("rb_inside_strong", "RB inside, strong side", "run", "runs inside to the strong side"),
    ("rb_inside_weak", "RB inside, weak side", "run", "runs inside to the weak side"),
    ("rb_middle", "RB up the middle", "run", "runs up the middle"),
    ("qb_sneak", "QB sneak", "run", "sneaks"),
    ("qb_run", "QB designed run", "run", "keeps it on a designed run"),
    ("rpo_strong", "RPO, strong side", "pass", "runs the RPO to the strong side"),
    ("rpo_weak", "RPO, weak side", "pass", "runs the RPO to the weak side"),
    ("quick_strong", "Quick pass, strong side", "pass", "throws quick to the strong side"),
    ("quick_weak", "Quick pass, weak side", "pass", "throws quick to the weak side"),
    ("quick_middle", "Quick pass, middle", "pass", "throws quick over the middle"),
    ("screen", "Screen pass", "pass", "throws the screen"),
    ("deep_strong", "Deep shot, strong side", "pass", "goes deep to the strong side"),
    ("deep_weak", "Deep shot, weak side", "pass", "goes deep to the weak side"),
    ("deep_middle", "Deep shot, middle", "pass", "goes deep over the middle"),
    ("pa_short", "Play-action short", "pass", "fakes the handoff and throws short"),
    ("pa_deep", "Play-action deep", "pass", "fakes the handoff and goes deep"),
    ("roll_strong", "QB rollout, strong side", "pass", "rolls out to the strong side"),
    ("roll_weak", "QB rollout, weak side", "pass", "rolls out to the weak side"),
    ("hail_mary", "Hail Mary", "pass", "heaves a Hail Mary"),
    # trick plays, each its own real pool (labeled_plays): the FTN trick flag alone also marks ordinary throws
    ("trick_flea", "Flea-flicker", "pass", "runs the flea-flicker"),
    ("trick_reverse", "End-around", "run", "runs the end-around"),
    ("trick_pass", "Receiver pass", "pass", "has a non-quarterback throw it"),
    ("trick_direct", "Direct snap", "run", "snaps it direct to the back"),
]
CALL_IDS = [c[0] for c in CALLS]
# how the game's call sheet groups them: Run / Pass / RPO first, then the play and the side
FAMILY = {c: "rpo" if c.startswith("rpo") else "trick" if c.startswith("trick") else "run" if c.startswith(("rb_", "qb_"))
          else "pass" for c in CALL_IDS}
BASE = {"rb_out": "Outside run", "rb_tackle": "Off-tackle run", "rb_inside": "Inside run", "rb_middle": "Up the middle",
        "qb_sneak": "QB sneak", "qb_run": "QB keeper", "rpo": "RPO", "quick": "Quick pass", "deep": "Deep shot",
        "screen": "Screen", "pa_short": "Play-action short", "pa_deep": "Play-action deep", "roll": "Rollout",
        "hail_mary": "Hail Mary", "trick_flea": "Flea-flicker", "trick_reverse": "End-around",
        "trick_pass": "Receiver pass", "trick_direct": "Direct snap"}


def base_side(call_id: str) -> tuple[str, str | None]:
    if call_id in BASE:
        return BASE[call_id], None
    for side in ("strong", "weak", "middle"):
        if call_id.endswith("_" + side):
            return BASE[call_id[: -len(side) - 1]], side
    return BASE[call_id], None
CALL_INDEX = {c: i for i, c in enumerate(CALL_IDS)}
RUN_CALLS = [i for i, c in enumerate(CALLS) if c[2] == "run"]
PASS_CALLS = [i for i, c in enumerate(CALLS) if c[2] == "pass"]
RB_RUNS = [CALL_INDEX[c] for c in CALL_IDS if c.startswith("rb_")]
STANDARD_PASSES = [CALL_INDEX[c] for c in ("quick_strong", "quick_weak", "quick_middle",
                                           "deep_strong", "deep_weak", "deep_middle")]
GAP = {"end": "out", "tackle": "tackle", "guard": "inside"}
FTN_URL = "https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_{season}.parquet"
FTN_FLAGS = ["is_play_action", "is_screen_pass", "is_qb_out_of_pocket", "is_qb_sneak", "is_throw_away", "is_rpo",
             "is_trick_play", "is_motion", "is_drop", "is_interception_worthy"]
FTN_LOOK = ["starting_hash", "qb_location", "n_defense_box", "n_blitzers"]
# Next Gen Stats charting per play (nflverse pbp_participation): the animation runs the targeted receiver's real
# route against the real coverage, with the real number of pass rushers, pressure and time to throw
PART_URL = ("https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/"
            "pbp_participation_{season}.parquet")
PART_COLS = ["route", "defense_man_zone_type", "defense_coverage_type", "number_of_pass_rushers", "was_pressure", "offense_personnel",
             "time_to_throw", "defense_personnel"]
ROUTES = ["", "go", "post", "corner", "out", "deep_out", "in", "slant", "cross", "hitch", "screen", "flat", "wheel",
          "angle"]
ROUTE_CODE = {"GO": 1, "POST": 2, "CORNER": 3, "QUICK OUT": 4, "OUT": 4, "DEEP OUT": 5, "IN/DIG": 6, "IN": 6,
              "SLANT": 7, "SHALLOW CROSS/DRAG": 8, "CROSS": 8, "HITCH/CURL": 9, "HITCH": 9, "SCREEN": 10,
              "SWING": 11, "FLAT": 11, "WHEEL": 12, "TEXAS/ANGLE": 13, "ANGLE": 13}   # 2022 labels, then 2023 on
SHELLS = ["", "cover0", "cover1", "cover2", "2man", "cover3", "cover4", "cover6", "cover9", "prevent"]
SHELL_CODE = {"COVER_0": 1, "COVER_1": 2, "COVER_2": 3, "2_MAN": 4, "COVER_3": 5, "COVER_4": 6, "COVER_6": 7,
              "COVER_9": 8, "PREVENT": 9}
LOOK_MIN = 15                # plays of a call against one defensive look before the browser draws from them alone
                             # (engine.js PB_LOOK_MIN); coarser situations are pooled until a look has this many
MIN_POOL = 40
QB_MIN_ATTEMPTS = 30         # passers with fewer attempts in a season are trick-play throwers, not QBs
HAIL_MARY_SECONDS = 12       # a deep heave (or the sack / scramble of one) this late in a half, 38-70 yards out
INTENT_SHRINK = 0.5          # calls are labeled by where the ball went (a covered deep shot is logged as a checkdown
                             # or a sack), which flatters deep and bounced-outside calls: halve each call's EPA over
                             # a same-kind play in the same situation
RATING_PRIOR = 80.0          # plays of league-average performance added to each team's rating on a call
PRIOR_SEASON_WEIGHT = 0.35   # last season's plays count this much next to this season's
OOB_FAMILIES = {             # calls that share an out-of-bounds effect (pooled for sample size)
    "outside_run": ["rb_out_strong", "rb_out_weak", "rb_tackle_strong", "rb_tackle_weak"],
    "inside_run": ["rb_inside_strong", "rb_inside_weak", "rb_middle", "qb_sneak", "qb_run", "rpo_strong", "rpo_weak"],
    "outside_short": ["quick_strong", "quick_weak", "roll_strong", "roll_weak", "screen", "pa_short", "trick_pass"],
    "trick_run": ["trick_reverse", "trick_direct"], "trick_deep": ["trick_flea"],
    "middle_short": ["quick_middle"], "deep_outside": ["deep_strong", "deep_weak", "pa_deep"],
    "deep_middle": ["deep_middle", "hail_mary"],
}
FLAG_BITS = ["penalty", "auto_fd", "incomplete", "oob", "td_off", "td_def", "turnover", "safety"]
# what happened on the real play (first match wins; the browser game narrates these)
EVENTS = ["", "bad_snap", "strip_sack", "sack_fumble", "sack", "pick_six", "interception", "scoop_score",
          "fumble_lost", "fumble_kept", "scramble", "throwaway", "drop", "near_pick", "safety"]
N_PENALTY_NAMES = 30
FORMATIONS = {"S": 1, "U": 2, "P": 3}   # shotgun, under center, pistol (0 = not charted)


# ----------------------------------------------------------------- data ---
def _ftn(seasons=SEASONS) -> pd.DataFrame:
    frames = []
    for s in seasons:
        p = config.RAW_DIR / f"ftn_charting_{s}.parquet"
        if not p.exists():
            urllib.request.urlretrieve(FTN_URL.format(season=s), p)
        f = pd.read_parquet(p, columns=["nflverse_game_id", "nflverse_play_id"] + FTN_FLAGS + FTN_LOOK)
        frames.append(f.rename(columns={"nflverse_game_id": "game_id", "nflverse_play_id": "play_id"}))
    f = pd.concat(frames, ignore_index=True)
    f["play_id"] = pd.to_numeric(f["play_id"], errors="coerce")
    for c in FTN_FLAGS:
        f[c] = f[c].fillna(False).astype(bool)
    return f.drop_duplicates(["game_id", "play_id"])


def _participation(seasons=SEASONS) -> pd.DataFrame:
    """NGS charting per play; a season not published yet (the current one, early on) is skipped."""
    frames = []
    for s in seasons:
        p = config.RAW_DIR / f"pbp_participation_{s}.parquet"
        if not p.exists():
            tmp = p.with_suffix(".part")
            try:
                urllib.request.urlretrieve(PART_URL.format(season=s), tmp)
            except urllib.error.HTTPError:
                continue
            tmp.replace(p)
        f = pd.read_parquet(p)
        frames.append(f[["nflverse_game_id", "play_id"] + [c for c in PART_COLS if c in f]]
                      .rename(columns={"nflverse_game_id": "game_id"}))
    if not frames:
        return pd.DataFrame(columns=["game_id", "play_id"] + PART_COLS)
    f = pd.concat(frames, ignore_index=True)
    f["play_id"] = pd.to_numeric(f["play_id"], errors="coerce")
    return f.drop_duplicates(["game_id", "play_id"])


def _charting(s: pd.DataFrame) -> dict:
    """The NGS charting packed for the browser (0 = not charted): route code; coverage shell (bits 0-3) with man (1)
    or zone (2) in bits 4-5; pass rushers (bits 0-3), pressure (4) and charted (5); time to throw in tenths; the
    offense's personnel; the defense's (dpers: defensive backs on the field, defense_db_count)."""
    col = lambda c: s[c] if c in s else pd.Series(np.nan, index=s.index)
    route = col("route").map(ROUTE_CODE).fillna(0).to_numpy().astype(np.uint8)
    shell = col("defense_coverage_type").map(SHELL_CODE).fillna(0).to_numpy().astype(np.uint8)
    mz = col("defense_man_zone_type").map({"MAN_COVERAGE": 1, "ZONE_COVERAGE": 2}).fillna(0).to_numpy().astype(np.uint8)
    n = pd.to_numeric(col("number_of_pass_rushers"), errors="coerce")
    rushers = np.clip(n.fillna(0).to_numpy(), 0, 15).astype(np.uint8)
    pressure = col("was_pressure").map({True: 1, False: 0, "TRUE": 1, "FALSE": 0}).fillna(0).to_numpy().astype(np.uint8)
    charted = n.notna().to_numpy().astype(np.uint8)
    ttt = pd.to_numeric(col("time_to_throw"), errors="coerce")
    ttt = np.clip(np.round(ttt.fillna(0).to_numpy() * 10), 0, 255).astype(np.uint8)
    return {"route": route, "cover": shell | (mz << 4), "rush": rushers | (pressure << 4) | (charted << 5), "ttt": ttt,
            "pers": personnel_code(col("offense_personnel")), "dpers": defense_db_count(col("defense_personnel"))}


DB_POS = {"CB", "S", "FS", "SS", "DB", "SAF"}


def defense_db_count(p: pd.Series) -> np.ndarray:
    """Defensive backs on the field ("4 DL, 2 LB, 5 DB" or, from 2025, "3 CB, 2 DT, 1 FS, 2 ILB, 2 OLB, 1 SS": 5, a
    nickel defense), 1-7; 0 not charted or not 11 defenders."""
    def code(v):
        if not isinstance(v, str) or not v:
            return 0
        n, db = 0, 0
        for part in v.split(","):
            k = part.strip().split(" ")
            if len(k) == 2 and k[0].isdigit():
                n += int(k[0])
                db += int(k[0]) if k[1] in DB_POS else 0
        return min(max(db, 1), 7) if n == 11 else 0
    return p.map(code).fillna(0).to_numpy().astype(np.uint8)


PERSONNEL = (11, 12, 21, 13, 10, 22)   # the groupings the game offers / knows (RBs then TEs; FBs count as backs)


def personnel_code(p: pd.Series) -> np.ndarray:
    """Offensive personnel as the NFL names it (backs, then tight ends: "1 RB, 2 TE, 2 WR" is 12); 0 not charted,
    255 anything else (an extra lineman, a QB in the backfield)."""
    def code(v):
        if not isinstance(v, str) or not v:
            return 0
        n = {}
        for part in v.split(","):
            k = part.strip().split(" ")
            if len(k) == 2 and k[0].isdigit():
                n[k[1]] = n.get(k[1], 0) + int(k[0])
        ol = n.get("C", 0) + n.get("G", 0) + n.get("T", 0) + n.get("OL", 0)
        backs, te, wr = n.get("RB", 0) + n.get("FB", 0), n.get("TE", 0), n.get("WR", 0)
        c = backs * 10 + te
        return c if ol in (0, 5) and n.get("QB", 1) == 1 and backs + te + wr == 5 and c in PERSONNEL else 255
    return p.map(code).fillna(0).to_numpy().astype(np.uint8)


def _extras(seasons=SEASONS) -> pd.DataFrame:
    cols = ["game_id", "play_id", "run_location", "run_gap", "rusher_player_id", "passer_player_id", "receiver_player_id", "fumble"]
    return pd.concat([pd.read_parquet(config.RAW_DIR / f"play_by_play_{s}.parquet", columns=cols) for s in seasons],
                     ignore_index=True)


def strong_side(direction: np.ndarray, hash_: np.ndarray, rng) -> np.ndarray:
    """True where a play to `direction` (left / right, offense's view) went to the wide side of the field.
    Ball on the left hash: the right side is wide. Middle of the field or not charted: a coin flip."""
    d, h = np.asarray(direction, dtype=object), np.asarray(hash_, dtype=object)
    field = ((h == "L") & (d == "right")) | ((h == "R") & (d == "left"))
    boundary = ((h == "L") & (d == "left")) | ((h == "R") & (d == "right"))
    return field | (~field & ~boundary & (rng.random(len(d)) < 0.5))


def labeled_plays(seasons=SEASONS, seed: int = 11) -> pd.DataFrame:
    """Every run/pass snap (and penalty snap) of `seasons` as a library row with its call."""
    pbp = data.load(tuple(range(2016, max(seasons) + 1)))
    s = pbp[pbp["is_snap"] & pbp["season"].isin(seasons) & pbp["down"].notna() & pbp["epa"].notna()].copy()
    s = s[s["play_type"].isin(["run", "pass"]) | ((s["play_type"] == "no_play") & s["penalty"].fillna(0).eq(1))]
    s = s[s["two_point_attempt"].fillna(0) == 0]
    # not offensive calls: fakes and punter runs from punt or field-goal formation, intentional safeties (a
    # runner taking it out the back of the end zone to burn the clock: PHI's punter for -34 yards in 2025)
    # and lateral chains, which would otherwise be drawn as an ordinary run or pass
    desc = s["desc"].fillna("")
    special = desc.str.contains(r"\((?:Punt|Field Goal) formation\)", case=False, regex=True)
    intentional = (s["safety"].fillna(0) == 1) & (s["play_type"] == "run") & (s["yards_gained"].fillna(0) <= -8)
    s = s[~(special | desc.str.contains("Lateral", case=False) | intentional)]
    s = s.merge(_extras(seasons), on=["game_id", "play_id"], how="left")
    s = s.merge(_ftn(seasons), on=["game_id", "play_id"], how="left")
    s = s.merge(_participation(seasons), on=["game_id", "play_id"], how="left")
    for c in FTN_FLAGS:
        s[c] = s[c].fillna(False).astype(bool)
    pen = (s["play_type"] == "no_play").to_numpy()
    drop = s["qb_dropback"].fillna(0).eq(1).to_numpy()

    # quarterbacks: passers with real volume that season (not running backs who threw one trick pass)
    att = s[drop & ~pen].groupby(["season", "passer_player_id"]).size()
    qbs = set(att[att >= QB_MIN_ATTEMPTS].index)
    is_qb_rusher = np.array([(se, r) in qbs for se, r in zip(s["season"], s["rusher_player_id"])])

    rng = np.random.default_rng(seed)
    loc, length = s["pass_location"].to_numpy(), s["pass_length"].to_numpy()
    run_loc, run_gap = s["run_location"].to_numpy(), s["run_gap"].to_numpy()
    sneak, pa, screen = s["is_qb_sneak"].to_numpy(), s["is_play_action"].to_numpy(), s["is_screen_pass"].to_numpy()
    oop, rpo, trick = s["is_qb_out_of_pocket"].to_numpy(), s["is_rpo"].to_numpy(), s["is_trick_play"].to_numpy()
    kneel = s["qb_kneel"].fillna(0).eq(1).to_numpy()
    aborted = s["desc"].str.contains("Aborted", case=False, na=False).to_numpy()   # bad snaps: any call
    run = ~drop & ~pen & ~kneel & ~aborted
    drop = drop & ~aborted
    hs, yl_ = s["half_seconds_remaining"].to_numpy(), s["yardline_100"].to_numpy()
    targeted = pd.notna(loc)
    heave = (length == "deep") | ~targeted | (s["air_yards"].fillna(0).to_numpy() >= 30)
    hail = drop & ~pen & (hs <= HAIL_MARY_SECONDS) & (yl_ >= 38) & (yl_ <= 70) & heave
    strong = np.where(strong_side(np.where(targeted, loc, run_loc), s["starting_hash"].to_numpy(), rng),
                      "strong", "weak")
    call = np.full(len(s), -1)
    known = lambda m: m & (call < 0)
    C = CALL_INDEX
    call[known(run & sneak)] = C["qb_sneak"]
    # trick plays: a flea-flicker (a charted trick play the quarterback throws 15+ yards), a pass by a running back
    # or receiver, a direct snap (wildcat), an end-around (any handoff to a wide receiver)
    from . import players as PL      # players imports this module
    ppos = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "position"]).drop_duplicates("gsis_id")
    ppos = dict(zip(ppos["gsis_id"], ppos["position"]))
    passer_pos = s["passer_player_id"].map(ppos).to_numpy()
    rusher_pos = s["rusher_player_id"].map(ppos).to_numpy()
    desc_ = s["desc"].fillna("")
    direct = run & desc_.str.contains("Direct snap", case=False).to_numpy()
    deep_trick = trick & ((s["air_yards"].fillna(0).to_numpy() >= 15) | desc_.str.contains("flea", case=False).to_numpy())
    call[known(drop & ~pen & deep_trick & (passer_pos == "QB"))] = C["trick_flea"]
    call[known(drop & ~pen & np.isin(passer_pos, ["RB", "WR", "TE", "FB"]))] = C["trick_pass"]
    call[known(direct)] = C["trick_direct"]
    call[known(run & (rusher_pos == "WR"))] = C["trick_reverse"]
    call[known(hail)] = C["hail_mary"]
    for st in ("strong", "weak"):
        call[known((run | drop) & ~pen & rpo & (strong == st))] = C[f"rpo_{st}"]
    call[known(run & is_qb_rusher)] = C["qb_run"]
    side_run = run & np.isin(run_loc, ["left", "right"])
    for gap, name in GAP.items():
        for st in ("strong", "weak"):
            call[known(side_run & (run_gap == gap) & (strong == st))] = C[f"rb_{name}_{st}"]
    for st in ("strong", "weak"):   # a side but no gap charted: off tackle
        call[known(side_run & (strong == st))] = C[f"rb_tackle_{st}"]
    call[known(run & (run_loc == "middle"))] = C["rb_middle"]
    target = drop & ~pen & targeted
    call[known(target & screen)] = C["screen"]
    call[known(target & pa & (length == "deep"))] = C["pa_deep"]
    call[known(target & pa)] = C["pa_short"]
    for st in ("strong", "weak"):
        call[known(target & oop & (loc != "middle") & (strong == st))] = C[f"roll_{st}"]
    for depth, name in (("short", "quick"), ("deep", "deep")):
        call[known(target & (length == depth) & (loc == "middle"))] = C[f"{name}_middle"]
        for st in ("strong", "weak"):
            call[known(target & (length == depth) & (loc != "middle") & (strong == st))] = C[f"{name}_{st}"]

    # spread sacks / scrambles / throwaways / penalties / bad snaps over the calls they could have come from
    freq = np.bincount(call[call >= 0], minlength=len(CALLS)).astype(float)

    def spread(mask, choices):
        idx = np.flatnonzero(mask & (call < 0))
        if idx.size:
            p = freq[choices] / freq[choices].sum()
            call[idx] = rng.choice(choices, size=idx.size, p=p)

    spread(drop & ~pen & oop, [C["roll_strong"], C["roll_weak"]])
    spread(drop & ~pen & pa, [C["pa_short"], C["pa_deep"]])
    spread(drop & ~pen & screen, [C["screen"]])
    spread(drop & ~pen, STANDARD_PASSES)
    spread(run & ~kneel, RB_RUNS)
    pen_pass = pen & s["pass"].fillna(0).eq(1).to_numpy()
    pen_run = pen & s["rush"].fillna(0).eq(1).to_numpy()
    spread(pen_pass, [c for c in PASS_CALLS if c != C["hail_mary"]])
    spread(pen_run, RUN_CALLS)
    spread(pen | aborted, [c for c in range(len(CALLS)) if c != C["hail_mary"]])
    keep = call >= 0
    s, call, pen, aborted = s[keep].copy(), call[keep], pen[keep], aborted[keep]

    off_pen_sign = np.where(s["penalty_team"] == s["posteam"], -1.0, 1.0)
    yards = np.where(pen, off_pen_sign * s["penalty_yards"].fillna(0), s["yards_gained"].fillna(0))
    td_off = (s["touchdown"].fillna(0).eq(1) & (s["td_team"] == s["posteam"])).to_numpy() & ~pen
    td_def = (s["touchdown"].fillna(0).eq(1) & (s["td_team"] == s["defteam"])).to_numpy() & ~pen
    turnover = (s["turnover"].to_numpy() == 1) & ~pen
    to_rel = s["yardline_100"].to_numpy() + s["next_yardline_100"].to_numpy() - 100.0
    valid_to = turnover & ((s["next_posteam"].to_numpy() == s["defteam"].to_numpy()) | td_def)
    # interceptions as a half ends have no next possession: place them where the pass was caught and returned
    last_pick = turnover & ~valid_to & (s["interception"].fillna(0).to_numpy() == 1)
    to_rel = np.where(last_pick, s["air_yards"].fillna(0).to_numpy() - s["return_yards"].fillna(0).to_numpy(), to_rel)
    valid_to |= last_pick
    presnap = pen & s["pass"].fillna(0).eq(0).to_numpy() & s["rush"].fillna(0).eq(0).to_numpy()
    # for the animation: how far the ball was thrown, and who carried it (or was thrown to)
    thrown = ~pen & s["qb_dropback"].fillna(0).eq(1).to_numpy() & s["receiver_player_id"].notna().to_numpy()
    air = np.where(thrown & s["air_yards"].notna().to_numpy(), s["air_yards"].fillna(0).to_numpy(), np.nan)
    carrier = np.where(~pen & s["rusher_player_id"].notna().to_numpy(), s["rusher_player_id"].to_numpy(),
                       np.where(thrown, s["receiver_player_id"].to_numpy(), None))
    caught = thrown & (s["complete_pass"].fillna(0).to_numpy() == 1)
    half = s["half"].to_numpy()
    hs = s["half_seconds_remaining"].to_numpy()
    margin = s["margin"].to_numpy()
    out = pd.DataFrame({
        "game_id": s["game_id"].to_numpy(), "play_id": s["play_id"].to_numpy(),
        "call": call,
        "yards": yards.astype(float),
        "auto_fd": s["first_down_penalty"].fillna(0).to_numpy().astype(bool) & pen,
        "penalty": pen,
        "incomplete": (s["incomplete_pass"].fillna(0).to_numpy() == 1) & ~pen,
        "oob": (s["out_of_bounds"].fillna(0).to_numpy() == 1) & ~pen,
        "td_off": td_off, "td_def": td_def, "turnover": turnover,
        "to_rel": np.where(valid_to, np.nan_to_num(to_rel, nan=0.0), 0.0),
        "safety": (s["safety"].fillna(0).to_numpy() == 1) & ~pen,
        "duration": _duration(s["play_type"].to_numpy(), s["yards_gained"].fillna(0).to_numpy(),
                              s["incomplete_pass"].fillna(0).to_numpy(), s["sack"].fillna(0).to_numpy(),
                              presnap, s["turnover"].to_numpy()),
        "epa": s["epa"].to_numpy(),
        "mode": game_mode(half, hs, margin),
        "down": s["down"].to_numpy().astype(int), "ytg": s["ydstogo"].to_numpy(), "yl": s["yardline_100"].to_numpy(),
        "season": s["season"].to_numpy(), "week": s["week"].to_numpy(),
        "posteam": s["posteam"].to_numpy(), "defteam": s["defteam"].to_numpy(),
        # ball carriers trying to get out of bounds (trailing late) vs. staying in bounds (leading late)
        "want_oob": (half == 2) & (hs <= 300) & (margin < 0),
        "stay_in": (half == 2) & (hs <= 300) & (margin > 0),
        "event": _events(s, pen, aborted, td_def),
        "pen_name": np.where(pen, s["penalty_type"].fillna("Penalty").to_numpy(), ""),
        "look": _look(s),
        "air": air, "carrier": carrier, "caught": caught,
        **{f"ngs_{k}": v for k, v in _charting(s).items()},
    })
    out = out[~(turnover & ~valid_to)].reset_index(drop=True)
    out["who"], out["bt"] = _carry(out)
    out["fine"] = fine_key(out["mode"], out["down"], out["ytg"], out["yl"])
    return out


CARRIER_GROUP = {"QB": 1, "RB": 2, "FB": 2, "HB": 2, "WR": 3, "TE": 4}


def _carry(out: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Who had the ball on each play (1 QB, 2 RB, 3 WR, 4 TE; 0 none), and whether he broke a tackle.

    Play-by-play does not chart broken tackles; Pro Football Reference counts them per player per game.
    A game's count is credited to that player's longest carries (or catches) of the game, the plays
    most likely to have had one."""
    from . import players as PL      # players imports this module
    pl = pd.read_parquet(PL._get("players", "players.parquet"), columns=["gsis_id", "pfr_id", "position"])
    pos = dict(zip(pl["gsis_id"], pl["position"]))
    to_pfr = dict(zip(pl["gsis_id"], pl["pfr_id"]))
    who = out["carrier"].map(lambda g: CARRIER_GROUP.get(pos.get(g), 0) if isinstance(g, str) else 0).to_numpy().astype(np.uint8)
    seasons = sorted(out["season"].unique())
    rush = pd.concat([pd.read_parquet(PL._get("pfr_advstats", f"advstats_week_rush_{s}.parquet"),
                                      columns=["game_id", "pfr_player_id", "rushing_broken_tackles"]) for s in seasons])
    rec = pd.concat([pd.read_parquet(PL._get("pfr_advstats", f"advstats_week_rec_{s}.parquet"),
                                     columns=["game_id", "pfr_player_id", "receiving_broken_tackles"]) for s in seasons])
    k_rush = rush.groupby(["game_id", "pfr_player_id"])["rushing_broken_tackles"].sum()
    k_rec = rec.groupby(["game_id", "pfr_player_id"])["receiving_broken_tackles"].sum()
    d = out[["game_id", "carrier", "yards", "caught", "penalty", "air"]].copy()
    d["pfr"] = d["carrier"].map(lambda g: to_pfr.get(g) if isinstance(g, str) else None)
    d["kind"] = np.where(d["caught"], "rec", np.where(d["air"].isna() & ~d["penalty"], "rush", ""))
    d = d[d["pfr"].notna() & (d["kind"] != "")]
    d["rank"] = d.groupby(["game_id", "pfr", "kind"])["yards"].rank(method="first", ascending=False) - 1
    key = list(zip(d["game_id"], d["pfr"]))
    k = np.where(d["kind"] == "rush", pd.Series(k_rush.reindex(key).to_numpy()), pd.Series(k_rec.reindex(key).to_numpy()))
    bt = np.zeros(len(out), bool)
    bt[d.index[np.nan_to_num(k, nan=0.0) > d["rank"].to_numpy()]] = True
    return who, bt


def _events(s: pd.DataFrame, pen: np.ndarray, aborted: np.ndarray, td_def: np.ndarray) -> np.ndarray:
    """EVENTS index of what happened on each real play (0 = nothing special)."""
    f = lambda c: s[c].fillna(0).to_numpy() == 1
    sack, fum, lost, inter = f("sack"), f("fumble"), f("fumble_lost"), f("interception")
    conds = {
        "bad_snap": aborted, "strip_sack": sack & lost, "sack_fumble": sack & fum, "sack": sack,
        "pick_six": inter & td_def, "interception": inter, "scoop_score": lost & td_def, "fumble_lost": lost,
        "fumble_kept": fum, "scramble": f("qb_scramble"), "throwaway": s["is_throw_away"].to_numpy(),
        "drop": s["is_drop"].to_numpy(),
        "near_pick": s["is_interception_worthy"].to_numpy() & ~inter & (s["incomplete_pass"].fillna(0).to_numpy() == 1),
        "safety": f("safety"),
    }
    ev = np.zeros(len(s), np.uint8)
    for name, m in reversed(list(conds.items())):   # first match wins: assign in reverse priority
        ev[np.asarray(m, bool) & (~pen | aborted)] = EVENTS.index(name)
    return ev


def _look(s: pd.DataFrame) -> np.ndarray:
    """The pre-snap look, packed: formation (bits 0-1), motion (2), blitz (3), men in the box (4-7)."""
    form = s["qb_location"].map(FORMATIONS).fillna(0).to_numpy().astype(np.uint8)
    motion = s["is_motion"].to_numpy().astype(np.uint8)
    blitz = (pd.to_numeric(s["n_blitzers"], errors="coerce").fillna(0).to_numpy() > 0).astype(np.uint8)
    box = np.clip(pd.to_numeric(s["n_defense_box"], errors="coerce").fillna(0).to_numpy(), 0, 15).astype(np.uint8)
    return form | (motion << 2) | (blitz << 3) | (box << 4)


# ---------------------------------------------------------------- pools ---
def look_bucket(look) -> np.ndarray:
    """A pre-snap look as the browser buckets it (engine.js lookBucket): 0 light box (6 or fewer), 1 light with a
    blitz, 2 loaded box (7 or more), 3 loaded with a blitz; 255 when the box was not charted."""
    look = np.asarray(look).astype(np.int64)
    box, blitz = look >> 4, (look >> 3) & 1
    return np.where(box == 0, 255, np.where(box >= 7, 2, 0) + blitz).astype(np.uint8)


def pools(lib: pd.DataFrame):
    """Pool index for every (call, situation): fine situation, then coarser, until MIN_POOL plays. And for every
    (call, situation, look) the pool to draw that look from: the situation's own pool when the call was run against
    that look LOOK_MIN times in it, else the plays against that look in the finest coarser situation that has them."""
    mode, db, yb, zone = decode_fine(np.arange(N_FINE))
    items, offsets, pool_of, index = [], [0], np.zeros((len(CALLS), N_FINE), dtype=np.int64), {}
    look_pool = np.zeros((len(CALLS), N_FINE, 4), dtype=np.int64)
    bucket = look_bucket(lib["look"].to_numpy())

    def pool_index(k, members):
        if k not in index:
            index[k] = len(offsets) - 1
            members = members()
            items.append(members)
            offsets.append(offsets[-1] + len(members))
        return index[k]

    for c in range(len(CALLS)):
        sub = lib[lib["call"] == c]
        keys = {0: sub["fine"].to_numpy(),
                1: ((sub["mode"] * N_DOWN + down_bucket(sub["down"])) * N_ZONE + zone_of(sub["yl"])).to_numpy(),
                2: (sub["mode"] * N_ZONE + zone_of(sub["yl"])).to_numpy(),
                3: zone_of(sub["yl"]), 4: np.zeros(len(sub), dtype=np.int64)}
        counts = {lvl: pd.Series(k).value_counts() for lvl, k in keys.items()}
        sb = bucket[sub.index.to_numpy()].astype(np.int64)
        look_counts = {lvl: pd.Series(np.asarray(k, dtype=np.int64) * 256 + sb).value_counts() for lvl, k in keys.items()}
        idx = sub.index.to_numpy()
        for fk in range(N_FINE):
            cand = {0: fk, 1: (mode[fk] * N_DOWN + db[fk]) * N_ZONE + zone[fk], 2: mode[fk] * N_ZONE + zone[fk],
                    3: zone[fk], 4: 0}
            for lvl in range(5):
                if counts[lvl].get(cand[lvl], 0) >= MIN_POOL or lvl == 4:
                    break
            pool_of[c, fk] = pool_index((c, lvl, int(cand[lvl])), lambda: idx[keys[lvl] == cand[lvl]])
            for b in range(4):
                lb = lvl
                while lb < 4 and look_counts[lb].get(int(cand[lb]) * 256 + b, 0) < LOOK_MIN:
                    lb += 1
                look_pool[c, fk, b] = pool_of[c, fk] if lb == lvl else pool_index(
                    (c, lb, int(cand[lb]), b), lambda: idx[(keys[lb] == cand[lb]) & (sb == b)])
    return np.concatenate(items), np.array(offsets), pool_of, look_pool


def pool_shifts(lib: pd.DataFrame, items: np.ndarray, offsets: np.ndarray, shrink: float = INTENT_SHRINK) -> np.ndarray:
    """EPA shift per pool that removes `shrink` of the call's edge over a typical run (or pass) in the same
    situations: the browser tilts each pool's sampling weights to its mean EPA plus this shift."""
    kind = np.array([CALLS[c][2] for c in lib["call"]])
    d = pd.DataFrame({"kind": kind, "fine": lib["fine"].to_numpy(), "mode": lib["mode"].to_numpy(),
                      "epa": lib["epa"].to_numpy()})
    cell = d.groupby(["kind", "fine"])["epa"].agg(["mean", "size"])
    by_mode = d.groupby(["kind", "mode"])["epa"].mean()
    exp_cell = pd.MultiIndex.from_arrays([d["kind"], d["fine"]])
    exp = np.where(cell["size"].reindex(exp_cell).to_numpy() >= 30, cell["mean"].reindex(exp_cell).to_numpy(),
                   by_mode.reindex(pd.MultiIndex.from_arrays([d["kind"], d["mode"]])).to_numpy())
    resid = d["epa"].to_numpy() - exp
    sums = np.add.reduceat(resid[items], offsets[:-1]) if len(items) else np.zeros(0)
    n = np.diff(offsets)
    return np.where(n > 0, -shrink * sums / np.maximum(n, 1), 0.0)


def call_frequencies(lib: pd.DataFrame, prior: float = 20.0) -> np.ndarray:
    """P(call | situation) for NFL play-callers, smoothed toward the call mix of the same game mode."""
    cnt = np.zeros((N_FINE, len(CALLS)))
    np.add.at(cnt, (lib["fine"].to_numpy(), lib["call"].to_numpy()), 1.0)
    mode_of = decode_fine(np.arange(N_FINE))[0]
    by_mode = np.stack([cnt[mode_of == m].sum(0) for m in range(N_MODE)])
    by_mode /= by_mode.sum(1, keepdims=True)
    f = cnt + prior * by_mode[mode_of]
    return f / f.sum(1, keepdims=True)


def oob_odds(lib: pd.DataFrame, motive: str = "want_oob") -> np.ndarray:
    """Odds multiplier on getting out of bounds, by call, against plays with no clock motive: "want_oob", the
    ball carrier trying to (the offense trailed late, wanted the clock stopped: 1-3x); "stay_in", trying not to
    (it led late and wanted the clock running; NFL 2016-2026: outside runs 3.9% out of bounds against 10%,
    short outside throws 16% against 25%: 0.2-1x)."""
    out = np.ones(len(CALLS))
    ok = ~lib["penalty"] & (lib["yards"] >= 0)
    if motive == "stay_in":
        ok &= ~lib["incomplete"]
    lo, hi = (1.0, 3.0) if motive == "want_oob" else (0.2, 1.0)
    for fam, members in OOB_FAMILIES.items():
        m = lib["call"].isin([CALL_INDEX[c] for c in members]) & ok
        base = lib.loc[m & ~lib["want_oob"] & ~lib["stay_in"], "oob"]
        want = lib.loc[m & lib[motive], "oob"]
        if len(want) < 50 or base.mean() <= 0:
            continue
        p0, p1 = base.mean(), (want.sum() + 10 * base.mean()) / (len(want) + 10)   # light shrinkage
        out[[CALL_INDEX[c] for c in members]] = float(np.clip((p1 / (1 - p1)) / (p0 / (1 - p0)), lo, hi))
    return out


# -------------------------------------------------------------- ratings ---
def call_ratings(lib: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    """Offense and defense EPA per play over league average, by call, as of (season, week)."""
    w = np.where(lib["season"] == season, (lib["week"] < week).astype(float),
                 np.where(lib["season"] == season - 1, PRIOR_SEASON_WEIGHT, 0.0))
    d = lib.assign(w=w)
    d = d[(d["w"] > 0) & ~d["penalty"]]
    lg = (d["w"] * d["epa"]).groupby(d["call"]).sum() / d["w"].groupby(d["call"]).sum()
    d["resid"] = d["epa"] - d["call"].map(lg)
    d["wr"] = d["w"] * d["resid"]
    off = d.groupby(["posteam", "call"])[["wr", "w"]].sum()
    dfn = d.groupby(["defteam", "call"])[["wr", "w"]].sum()
    off = (off["wr"] / (off["w"] + RATING_PRIOR)).rename("off").rename_axis(["team", "call"])
    dfn = (dfn["wr"] / (dfn["w"] + RATING_PRIOR)).rename("def").rename_axis(["team", "call"])
    out = pd.concat([off, dfn], axis=1).fillna(0.0).reset_index()
    # percentiles among teams: offense higher is better, defense lower EPA allowed is better
    out["off_pct"] = out.groupby("call")["off"].rank(pct=True)
    out["def_pct"] = out.groupby("call")["def"].rank(pct=True, ascending=False)
    out["call"] = out["call"].map(lambda i: CALL_IDS[int(i)])
    return out


UNRATED = {"hail_mary", "trick_flea", "trick_reverse", "trick_pass", "trick_direct"}   # a team runs a handful a season: too few to rate teams on


def team_card(ratings: pd.DataFrame, team: str) -> dict:
    t = ratings[(ratings["team"] == team) & ~ratings["call"].isin(UNRATED)].set_index("call")
    return {c: {"off": round(float(t.loc[c, "off"]), 4), "def": round(float(t.loc[c, "def"]), 4),
                "off_pct": round(float(t.loc[c, "off_pct"]), 3), "def_pct": round(float(t.loc[c, "def_pct"]), 3)}
            for c in CALL_IDS if c in t.index}


# ---------------------------------------------------------------- export ---
def _b64(arr: np.ndarray) -> dict:
    arr = np.ascontiguousarray(arr)
    return {"dtype": arr.dtype.name, "n": int(arr.size), "b64": base64.b64encode(arr.tobytes()).decode("ascii")}


def export(lib: pd.DataFrame, path) -> dict:
    items, offsets, pool_of, look_pool = pools(lib)
    assert len(offsets) < 32767, "look pools are exported as int16"
    flags = np.zeros(len(lib), np.uint8)
    for bit, name in enumerate(FLAG_BITS):
        flags |= (lib[name].to_numpy().astype(bool).astype(np.uint8) << np.uint8(bit))
    named = lib.loc[lib["pen_name"] != "", "pen_name"].value_counts()
    pen_names = [""] + list(named.index[:N_PENALTY_NAMES]) + ["Penalty"]
    pen_code = lib["pen_name"].map({n: i for i, n in enumerate(pen_names)}).fillna(len(pen_names) - 1).to_numpy()
    out = {
        "version": 2,
        "calls": [{"id": c, "label": label, "kind": kind, "say": say} for c, label, kind, say in CALLS],
        "families": FAMILY,
        "n_fine": N_FINE,
        "rows": {
            "yards": _b64(np.clip(lib["yards"], -127, 127).astype(np.int8)),
            "flags": _b64(flags),
            "to_rel": _b64(np.clip(lib["to_rel"], -127, 127).astype(np.int8)),
            "dur10": _b64(np.clip(np.round(lib["duration"] * 10), 0, 255).astype(np.uint8)),
            "epa": _b64(lib["epa"].astype(np.float32)),
            "event": _b64(lib["event"].to_numpy().astype(np.uint8)),
            "pen": _b64(pen_code.astype(np.uint8)),
            "look": _b64(lib["look"].to_numpy().astype(np.uint8)),
            # for the animation only: air yards (-128 = not thrown), carrier group (bits 0-2) and broken tackle (bit 3)
            "air": _b64(np.where(lib["air"].isna(), -128, np.clip(lib["air"].fillna(0), -20, 100)).astype(np.int8)),
            "carry": _b64((lib["who"].to_numpy().astype(np.uint8) | (lib["bt"].to_numpy().astype(np.uint8) << np.uint8(3)))),
            # the animation: NGS route, coverage, pass rush and time to throw (_charting); Versus' defensive calls
            # draw against the real coverage, rush, box and defensive personnel
            **{k: _b64(lib[f"ngs_{k}"].to_numpy().astype(np.uint8)) for k in ("route", "cover", "rush", "ttt", "pers", "dpers")},
        },
        "routes": ROUTES, "shells": SHELLS,
        "events": EVENTS, "penalties": pen_names,
        "items": _b64(items.astype(np.int32)), "offsets": _b64(offsets.astype(np.int32)),
        "pool_of": _b64(pool_of.astype(np.int32).ravel()),
        "look_pool": _b64(look_pool.astype(np.int16).ravel()),
        "pool_shift": _b64(pool_shifts(lib, items, offsets).astype(np.float32)),
        "freq": _b64(call_frequencies(lib).astype(np.float32).ravel()),
        "oob_odds": oob_odds(lib).round(3).tolist(),
        "stay_odds": oob_odds(lib, "stay_in").round(3).tolist(),
        "seasons": list(SEASONS),
    }
    path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    return out
