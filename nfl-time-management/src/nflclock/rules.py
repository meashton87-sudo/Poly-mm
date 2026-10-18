"""Rulebooks the simulator can play: the clock, the spots and the tries, by level and era.

The single source of truth. web/engine.js carries a JSON copy between `// RULES:start` and `// RULES:end`
(tests/test_rules.py checks they match). `nfl` is today's literals exactly, so NFL results are bit for bit what they
were. Rules are the rulebook; outcome distributions are level data (engine_data*.json, bundle consts); the competent-
coach policy constants stay shared (sim.py).

Sources: NCAA = 2026 NCAA Football Rules and Interpretations (May 2026) and the 2023-26 rules-committee reports
(ncaaorg.s3.amazonaws.com); NFHS = 2026 NFHS General Instructions for Game and Play Clock Operators and the NFHS
2022-26 rules-change lists (NSAA copies, nsaa-static.s3.amazonaws.com); state items from state-association documents
(see research_notes/Coordinator needs for Coach mode/college_and_hs_rules.md and nfhs_rules.md). "unverified" marks a
value no primary text confirmed.

Fields (seconds are left in the half unless said):
  level            the outcome data it is meant for ('nfl', 'fbs', 'hs': engine_data level)
  quarter          seconds in a quarter
  tmw              the two-minute stoppage (NFL warning, NCAA/UIL Two-Minute Timeout) at this many seconds left in
                   Q2/Q4; None: none (stored as +inf, so no clock ever crosses it)
  oob              [1st half, 2nd half]: inside this many seconds a play out of bounds stops the clock until the
                   snap; outside, it restarts on the ready-for-play (the oob credit)
  fdStop           a first down (in bounds, not a change of possession or score) inside `window` stops the clock until
                   the ready-for-play / the spot: the clock keeps running for the next snap with `credit` seconds back
                   (None: the level data's fd_restart_credit, else its oob_restart_credit); None: never stops
  untimed          'def': a half cannot end on an accepted defensive foul; 'any': nor on any accepted live-ball foul
  runoff10         {window}: a foul that stops a running clock (the library's pre-snap fouls) inside `window` takes 10
                   seconds off at the offended team's option; the fouling team may spend a timeout to avoid it
  penStop          {window}: inside `window` the offended team may start the clock on the snap after a foul (else on
                   the ready-for-play); None: NFL (a penalty stops it inside the oob window)
  koTouchback      the receivers' yards to go after a kickoff touchback; koFairCatch: a fair catch short of it there
  onsideBehindOnly only a team behind may kick onside (the NFL's 2024+ declaration rule)
  patKick          the kick try's distance; twoYl the two-point try's yard line
  fgMissBack       a missed field goal: the receivers' ball at the kick's yard line + this (floor: their 20);
  fgMissTb         ... or, when not None, always at this many yards to go (a touchback at the 20)
  tryForego        a team ahead by 1-2 after a touchdown at 0:00 of Q4 does not try (it cannot gain; NFL: it must)
  kneelRunoff      seconds between kneels (the play clock run down); maxGap: the longest gap between snaps (None:
                   the tempo draws as measured)
  playClock        [after a dead ball, after an administrative stoppage]
  hash             yards from each sideline to the hash marks (display); posts: goal-post width in feet (display: the
                   kick model is the level's data)
  waterBreak       a state's uncharged one-minute timeout at the first stoppage after this many seconds left in each
                   quarter (display: it comes at a stoppage, so the game clock is not changed)
  fieldYards, firstDownYards, fgPoints, tryPoints ([kick, run or pass])
                   the 11-player game's (100, 10, 3, [1, 2]); the engine refuses any other (8- and 6-player: 80 yards,
                   kickoff from the 30, touchback at the 15; 6-player also 15 yards to gain, 10:00 periods, a field goal
                   4, a kicked try 2 and a run or pass 1: not in this version)
  ot               overtime format (OT below; 'nfl2025' is engine.js _otAfter)
  toPerHalf        team timeouts each half
  runClock         a state's running clock: {margin, from (quarters left: 2 = the 2nd half, 1 = the 4th quarter),
                   sticky (stays on when the margin drops), stops: 'min' (scores, timeouts, period ends only) | 'wide'
                   (also penalty enforcement, restarting on the ready)}; None: none
"""
from __future__ import annotations

import copy

_NFL = dict(
    level="nfl",
    quarter=900,             # 15:00 quarters
    tmw=120,                 # two-minute warning, Q2 and Q4
    oob=[120, 300],          # out of bounds stops it till the snap inside 2:00 of the 1st half, 5:00 of the 2nd
    fdStop=None,             # first downs never stop the clock
    untimed="def",           # a half cannot end on an accepted defensive foul
    runoff10=None,           # the NFL's 10-second runoff (offensive fouls in the last minute) is not modelled
    penStop=None,            # a penalty stops the clock till the snap inside the oob window
    koTouchback=65,          # 2025 rule: touchback to the 35
    koFairCatch=None,
    onsideBehindOnly=True,   # 2024+: only a team behind may declare an onside kick
    patKick=33,              # the try from the 15: a 33-yard kick
    twoYl=2,                 # two-point try from the 2
    fgMissBack=8,            # a miss: the ball at the spot of the kick (7-8 yards behind the line), or the 20
    fgMissTb=None,
    tryForego=False,         # the try is played unless it cannot change the result (a lead or deficit of 3+)
    kneelRunoff=[38, 40],    # 40-second play clock run down, snapped with 0-2 s left
    maxGap=None,
    playClock=[40, 25],
    hash=23.58,              # 70 ft 9 in from each sideline (unverified)
    posts=18.5,              # 18 ft 6 in (unverified)
    ot="nfl2025",
    toPerHalf=3,
    runClock=None,
    waterBreak=None,
    fieldYards=100, firstDownYards=10, fgPoints=3, tryPoints=[1, 2],
)

_NCAA2026 = dict(
    _NFL,
    level="fbs",
    tmw=120,                 # Two-Minute Timeout at 2:00 of Q2/Q4 since 2024 (3-3-5); the clock then starts on the snap
    oob=[120, 120],          # before the Two-Minute Timeout the clock restarts on the ready (3-3-2-e-3), after it on the snap (3-3-2-d-2)
    fdStop={"window": 120, "credit": None},   # 2023+: a Team A first down stops it only after the Two-Minute Timeout, ready-for-play restart (3-3-2-e-1)
    untimed="any",           # Q2/Q4 extended for an accepted live-ball foul by either team (3-2-3-a; loss-of-down option not modelled)
    runoff10={"window": 120},  # after the Two-Minute Timeout, a foul that stops a running clock: 10 s at the offended team's option, avoidable by the fouler's timeout (3-4-4)
    penStop={"window": 120},   # after the Two-Minute Timeout, a foul by the team ahead (or either, tied): snap start at the offended team's option (3-4-3-b)
    koTouchback=75,          # free-kick touchback at B's 25 (6-1-7-b, 8-6-2)
    koFairCatch=75,          # a fair catch of a free kick inside the 25 comes out to the 25 (6-5-1-a)
    onsideBehindOnly=False,  # no declaration rule: any team may kick onside
    patKick=20,              # snapped at the 3 (8-3-2): 3 + 10 (end zone) + 7 (the hold)
    twoYl=3,                 # two-point try from the 3 (8-3-2)
    fgMissBack=0,            # B's ball at the previous spot, or its 20 if the spot was inside it (8-4-2-b-1)
    tryForego=True,          # 0:00 of Q4: no try unless it affects the outcome; ahead by 1-2 may forego it (8-3-2-a)
    hash=20.0,               # 60 ft from each sideline (1-2-1-j)
    posts=18.5,              # 18 ft 6 in inside to inside (1-2-5)
    ot="ncaa",
)

_NCAA2022 = dict(
    _NCAA2026,
    tmw=None,                # no Two-Minute Timeout before 2024 (Feb 2024 committee report)
    oob=[120, 120],          # before 2024 the late-half switch was "under two minutes" (Feb 2024 report; unverified exact text)
    fdStop={"window": 1800, "credit": None},  # before 2023 every first down stopped the clock (Feb 2023 report: "Currently, the clock stops to award a first down")
    runoff10={"window": 60},   # before 2024 the 10-second runoff was the last minute of each half (unverified exact text)
    penStop={"window": 120},   # the team-ahead snap option in the last two minutes (unverified exact text)
    ot="ncaa2022",
)

_NFHS = dict(
    _NFL,
    level="hs",
    quarter=720,             # 12:00 quarters, 3 timeouts a half (rules-book text not read: provisional; every source agrees)
    tmw=None,                # no two-minute warning (NFHS clock instructions list no 2:00 stoppage)
    oob=[1440, 1440],        # out of bounds: the clock starts on the snap, all game (NFHS 2026 clock table)
    fdStop={"window": 1440, "credit": 4.0},   # every first down in bounds: stopped, restarted when the ball is spotted ("silent wind", usually 3-5 s)
    untimed="any",           # any period is extended for an accepted foul by either team (3-3-3; 3-3-4b exceptions not modelled)
    runoff10=None,           # no NFHS runoff found
    penStop={"window": 120},   # under 2:00 of either half the offended team may start the clock on the snap after a foul (3-4-7)
    koTouchback=80,          # kickoff from K's 40; every touchback at the 20
    onsideBehindOnly=False,
    patKick=20,              # snapped at the 3 (no option farther back): 3 + 10 + 7
    twoYl=3,
    fgMissBack=None,
    fgMissTb=80,             # a miss is a scrimmage kick: into the end zone a touchback at the 20 (a short miss dead in the field is not modelled)
    tryForego=True,          # the defense cannot score on a try: a team ahead by 1-2 at 0:00 has nothing to gain
    kneelRunoff=[38, 40],    # the 40/25 play clock is the NFHS rule since 2019 (3-6-1a)
    playClock=[40, 25],
    hash=17.78,              # 53 ft 4 in from each sideline (2026 NFHS field diagram)
    posts=23.33,             # 23 ft 4 in (2026 NFHS field diagram)
    ot="kansas10",
)

RULES = {
    "nfl": _NFL,
    "ncaa2026": _NCAA2026,
    "ncaa2022": _NCAA2022,
    "nfhs": _NFHS,
    # a 25-second count from the ready (NFHS before 2019; no state confirmed on it now): snaps at most ~30 s apart
    "nfhs25": dict(_NFHS, kneelRunoff=[27, 30], maxGap=30.0, playClock=[25, 25]),
    # Texas UIL: the NCAA book with UIL exceptions: 12:00 quarters, the 2025 Two-Minute Timeout, NCAA overtime, no
    # running clock (the 2026 UIL Exceptions document was not read: kick spots and runoffs as NCAA, unverified)
    "uil2026": dict(_NCAA2026, level="hs", quarter=720),
}

# Overtime formats (played outside the engine: web/vs_core.js). yl: first-and-10 (or goal) at this many yards to go,
# yl3 from the 3rd period on (None: the same); must2From: from this period a touchdown must go for two; alt2From: from
# this period each possession is one two-point play from altYl; to: each team's timeouts per period (toFrom3: from the
# 3rd period 'carry' one for the rest of the game, 'none' or 'reset')
OT = {
    "nfl2025": None,
    "ncaa": {"yl": 25, "yl3": None, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "carry"},   # 3-1-3 (2026; OT timeouts 2025: one for OT3 on)
    "ncaa2022": {"yl": 25, "yl3": None, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},  # 2021-24 format, one timeout a period
    "kansas10": {"yl": 10, "yl3": None, "must2From": None, "alt2From": None, "altYl": 3, "to": 1, "toFrom3": "reset"},  # NFHS model: first and goal at the 10, one timeout a period
    "ga15": {"yl": 15, "yl3": None, "must2From": 2, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},   # GHSA 2025-26
    "ut25": {"yl": 25, "yl3": None, "must2From": None, "alt2From": 3, "altYl": 3, "to": 1, "toFrom3": "reset"},  # UHSAA 2023
    "or25": {"yl": 25, "yl3": 10, "must2From": None, "alt2From": None, "altYl": 3, "to": 1, "toFrom3": "reset"},  # OSAA 2026
    "at25": {"yl": 25, "yl3": None, "must2From": None, "alt2From": None, "altYl": 3, "to": 1, "toFrom3": "reset"},  # MO, WI (the 25)
    # Louisiana: a clock-operator guide says unused regulation timeouts carry into overtime (search summary, unverified)
    "kansas10carry": {"yl": 10, "yl3": None, "must2From": None, "alt2From": None, "altYl": 3, "to": 1, "toFrom3": "reset", "toCarry": True},
}

# NFHS states: overtime and running clock (search summaries of state documents unless noted; NE primary). TX plays
# 'uil2026'. A state not listed plays the NFHS model with no running clock.
STATES = {
    "GA": {"ot": "ga15", "runClock": {"margin": 30, "from": 1, "sticky": True, "stops": "wide"}},
    "OH": {"runClock": {"margin": 30, "from": 2, "sticky": False, "stops": "min"}},
    "PA": {"runClock": {"margin": 35, "from": 2, "sticky": True, "stops": "min"}},
    "NE": {"runClock": {"margin": 35, "from": 2, "sticky": False, "stops": "wide"}},
    "IN": {"runClock": {"margin": 35, "from": 2, "sticky": True, "stops": "wide"}},   # IHSAA 2019: "may not revert" (a second summary says it reverts: uncertain)
    "CA": {"runClock": {"margin": 35, "from": 1, "sticky": True, "stops": "min"}},   # CIF Southern Section
    # FHSAA (2022-23 manual, primary): checked at halftime only (from 0: the game sets running_clock on its root),
    # then stopped only for timeouts, injuries, unsporting fouls and between quarters; water breaks after 6:30
    "FL": {"runClock": {"margin": 35, "from": 0, "sticky": True, "stops": "min"}, "waterBreak": 390},
    "UT": {"ot": "ut25"},
    "OR": {"ot": "or25"},
    "MO": {"ot": "at25"},
    "WI": {"ot": "at25"},
    "IA": {},
    "MA": {},
    "LA": {"ot": "kansas10carry"},
}


# the outcome data a ruleset may be played on (by the data's level): NFL data plays any (the test bed: rules_sweep.js,
# parity_exact --rules), college data plays college and high-school rules (there is no high-school data yet)
LEVEL_OK = {"nfl": None, "fbs": ["fbs", "hs"], "hs": ["hs"]}


def rules_of(spec="nfl") -> dict:
    """A ruleset by name ('nfl', 'ncaa2026', 'nfhs', 'nfhs:GA', ...) or {'base': name, **overrides}; a fresh copy."""
    if isinstance(spec, dict):
        base = rules_of(spec.get("base", "nfl"))
        base.update({k: copy.deepcopy(v) for k, v in spec.items() if k != "base"})
        return base
    name, _, state = str(spec).partition(":")
    if name not in RULES:
        raise ValueError(f"unknown rules {spec!r}")
    R = copy.deepcopy(RULES[name])
    if state:
        if state not in STATES:
            raise ValueError(f"unknown state {state!r}")
        R.update(copy.deepcopy(STATES[state]))
    return R


def rules_table() -> dict:
    """What engine.js carries between // RULES:start and // RULES:end."""
    return {"RULES": RULES, "OT": OT, "STATES": STATES}
