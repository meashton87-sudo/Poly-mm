"""College (and high school) pipeline: paths, seasons, sources and level constants."""
from __future__ import annotations

import os
from pathlib import Path

from .. import config as C

# Pruned season files (shared cache; CI caches this folder): CFB_DATA_DIR, else data/raw/cfb.
CACHE = Path(os.environ.get("CFB_DATA_DIR", C.RAW_DIR / "cfb"))
PKG = Path(__file__).resolve().parent
WEB = C.ROOT / "web"
BUNDLE = C.ARTIFACT_DIR / "bundle_cfb.pkl"
BUNDLE_HS = C.ARTIFACT_DIR / "bundle_hs.pkl"

RELEASE = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/{tag}/play_by_play_{season}.parquet"
TAG_CFBFASTR, TAG_ESPN = "cfbfastR_cfb_pbp", "espn_cfb_pbp"
TEAMS_URL = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/teams/teams_colors_logos.csv"

SEASONS = list(range(2016, 2027))          # cfbfastR seasons downloaded (the drills' seasons)
ESPN_SEASONS = list(range(2021, 2027))     # ESPN: PAT / two-point results, kneels, names, final scores
CURRENT = 2026                             # the season still being played: re-downloaded each week
# 2023: the clock no longer stops on a first down outside the last 2:00 of a half, so a clock that keeps
# running after a gain says the runner stayed in bounds: out-of-bounds can be inferred from 2023 on only
LIB_SEASONS = [2023, 2024, 2025, 2026]     # play library, tempo, first-down credit (inferred out-of-bounds)
WP_SEASONS = [2021, 2022, 2023, 2024, 2025]  # WP training (2026 is the holdout)
WP_HOLDOUT = [2026]
FG_SEASONS = list(range(2016, 2026))
KICKOFF_SEASONS = [2023, 2024, 2025]       # touchback at the 25 and fair catch inside the 25 (2018 on)
PUNT_SEASONS = [2021, 2022, 2023, 2024, 2025]
RATING_SEASONS = list(range(2016, 2027))

# ---- clock quality (design 3.3) ----
CLOCK_ZERO_SHARE = 0.05    # a game whose consecutive run/pass snaps show no clock change more than this often froze
CLOCK_NEG_MAX = 1          # negative gaps tolerated in a game (one is a scorer's fix-up; more is a broken feed)
# ---- inferred out-of-bounds (design 3.3) ----
OOB_GAP = 3.0              # at most this many seconds past the play's own length before the next snap: stopped clock
INB_GAP = 8.0              # at least this many: the clock ran, in bounds (between: in bounds, flagged ambiguous)
OOB_TEXT = r"out of bounds|pushed out|ran out|runs out|forced out|ob at|steps out"

# ---- level constants (written into engine_data_cfb.json; NFL defaults in engine.js / sim.py) ----
KO_TOUCHBACK_YL = 75.0     # NCAA: kickoff touchback (and fair catch inside the 25) at the 25 = 75 yards to go
PAT_KICK_YARDS = 20.0      # NCAA try from the 3: a 20-yard kick
