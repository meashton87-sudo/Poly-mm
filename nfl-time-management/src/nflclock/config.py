"""Project-wide paths, season ranges, and NFL rule constants."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("NFLCLOCK_ROOT", Path(__file__).resolve().parents[2]))
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
CACHE_DIR = DATA_DIR / "cache"
ARTIFACT_DIR = ROOT / "artifacts"
REPORT_DIR = ROOT / "reports"

NFLVERSE_PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.parquet"
NFLVERSE_GAMES_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"

# Seasons used to fit models (WP model, clock model, play library) vs. seasons analysed.
MODEL_SEASONS = list(range(2016, 2026))
LIBRARY_SEASONS = list(range(2020, 2026))  # recent passing-era outcome distributions
ANALYSIS_SEASONS = [2023, 2024, 2025]
# Kickoff outcome distributions change with the rules: 2024 introduced the dynamic
# kickoff (touchback to the 30); 2025 moved the touchback to the 35.
KICKOFF_SEASONS = [2025]

# ---- Clock rules -------------------------------------------------------------
HALF_SECONDS = 1800
QUARTER_SECONDS = 900
TWO_MINUTE_WARNING = 120
# Out-of-bounds stops the clock until the snap only inside the last 2:00 of the
# first half and the last 5:00 of the second half; elsewhere it restarts on the
# referee's ready-for-play signal.
OOB_STOP_WINDOW_H1 = 120
OOB_STOP_WINDOW_H2 = 300
PLAY_CLOCK = 40
TIMEOUTS_PER_HALF = 3
