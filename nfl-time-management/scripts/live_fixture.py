"""The recorded game the live drills' replay test plays (board/live_replay.json, committed: worker_test.mjs and
browser_test.py run without the nflverse data): a real game's fourth quarter from nflverse play-by-play, recast in the
live feed's shape (board/live_espn.js reads it as it reads ESPN's game summary), each play with the moment it happened
and, as _sb, what the scoreboard said after it. board/live_replay.mjs plays it back through the real watcher.

    python scripts/live_fixture.py [game_id, default 2025_07_PIT_CIN]

Pittsburgh at Cincinnati, Oct 16, 2025: four two-minute drills in the last 4:26 (Cincinnati protecting a lead and
punting, Pittsburgh's touchdown after a holding flag, Cincinnati kneeling Pittsburgh out of its timeouts for the
winning field goal, Pittsburgh's last 7 seconds).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "board" / "live_replay.json"
ESPN_ID = {"CIN": "4", "PIT": "23"}          # the feed's team ids (any id works: the feed's own map is in each game)
COLS = ["game_id", "play_id", "order_sequence", "qtr", "quarter_seconds_remaining", "down", "ydstogo", "yardline_100", "posteam", "defteam",
        "home_team", "away_team", "play_type", "play_type_nfl", "desc", "yards_gained", "complete_pass", "interception", "touchdown", "field_goal_result",
        "total_home_score", "total_away_score", "home_timeouts_remaining", "away_timeouts_remaining", "end_clock_time", "time_of_day", "spread_line",
        "season", "week", "game_date", "fumble_lost"]


def clock(s: float) -> str:
    s = int(round(s))
    return f"{s // 60}:{s % 60:02d}"


def kind(r) -> str:
    """The feed's play type for an nflverse row (live_espn.js reads the type and the text)."""
    t = r.play_type_nfl
    if t == "PASS":
        return "Passing Touchdown" if r.touchdown == 1 else "Pass Interception Return" if r.interception == 1 else \
            "Pass Reception" if r.complete_pass == 1 else "Pass Incompletion"
    return {"RUSH": "Rushing Touchdown" if r.touchdown == 1 else "Rush", "SACK": "Sack", "PENALTY": "Penalty", "TIMEOUT": "Timeout", "PUNT": "Punt",
            "FIELD_GOAL": "Field Goal Good" if r.field_goal_result == "made" else "Field Goal Missed", "KICK_OFF": "Kickoff",
            "XP_KICK": "Extra Point Good", "END_GAME": "End of Game", "END_QUARTER": "End Period", "PAT2": "Two-Point Conversion"}.get(t, "Play")


def spot_text(r) -> str:
    yl = int(r.yardline_100)
    side = "50" if yl == 50 else f"{r.posteam} {100 - yl}" if yl > 50 else f"{r.defteam} {yl}"
    dn = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}[int(r.down)]
    return f"{dn} & {'Goal' if r.ydstogo >= yl else int(r.ydstogo)} at {side}"


def main(gid: str = "2025_07_PIT_CIN") -> dict:
    season = int(gid[:4])
    df = pd.read_parquet(RAW / f"play_by_play_{season}.parquet", columns=COLS)
    g = df[df.game_id == gid].sort_values("order_sequence").reset_index(drop=True)
    home, away = g.home_team.iloc[0], g.away_team.iloc[0]
    ko = g[(g.play_type == "kickoff") & (g.qtr == 1)].head(1)
    rows = pd.concat([ko, g[g.qtr >= 4]])
    rows = rows[rows.play_type_nfl.notna() & (rows.play_type_nfl != "GAME_START")].reset_index(drop=True)
    # when each play happened (its end; else the snap's time and a few seconds), and when the game began
    wall = []
    for _, r in rows.iterrows():
        t = pd.to_datetime(r.end_clock_time, utc=True) if isinstance(r.end_clock_time, str) else \
            pd.to_datetime(r.time_of_day, utc=True) + pd.Timedelta(seconds=6) if isinstance(r.time_of_day, str) else None
        wall.append(t)
    for i, t in enumerate(wall):            # (the game's last line has neither: just after the play before it)
        if t is None:
            wall[i] = wall[i - 1] + pd.Timedelta(seconds=5)
    snaps = rows[rows.down.notna() & rows.posteam.notna()]
    plays = []
    for i, r in rows.iterrows():
        nxt = snaps[snaps.index > i].head(1)
        p = {"id": str(int(r.play_id)), "sequenceNumber": str(int(r.order_sequence)), "type": {"text": kind(r)}, "text": r.desc,
             "period": {"number": int(r.qtr)}, "clock": {"displayValue": clock(r.quarter_seconds_remaining)},
             "homeScore": int(r.total_home_score), "awayScore": int(r.total_away_score), "statYardage": int(r.yards_gained) if pd.notna(r.yards_gained) else 0,
             "scoringPlay": bool(r.touchdown == 1 or r.field_goal_result == "made"), "wallclock": wall[i].isoformat().replace("+00:00", "Z")}
        if r.play_type_nfl == "KICK_OFF":
            p["start"] = {"team": {"id": ESPN_ID[r.defteam]}}          # (the kicking team)
        elif pd.notna(r.down) and pd.notna(r.posteam):
            p["start"] = {"down": int(r.down), "distance": int(r.ydstogo), "yardLine": int(r.yardline_100), "yardsToEndzone": int(r.yardline_100),
                          "team": {"id": ESPN_ID[r.posteam]}, "downDistanceText": spot_text(r)}
        if len(nxt):
            n = nxt.iloc[0]
            p["end"] = {"down": int(n.down), "distance": int(n.ydstogo), "yardsToEndzone": int(n.yardline_100), "team": {"id": ESPN_ID[n.posteam]},
                        "downDistanceText": spot_text(n)}
        # the scoreboard after it: the clock as it reads (the next line's), the timeouts left, the next snap
        after = rows.iloc[i + 1] if i + 1 < len(rows) else r
        sb = {"period": int(after.qtr), "clock": float(after.quarter_seconds_remaining), "state": "post" if r.play_type_nfl == "END_GAME" else "in",
              "homeTimeouts": int(r.home_timeouts_remaining), "awayTimeouts": int(r.away_timeouts_remaining)}     # (a row's own: left once it is over)
        if len(nxt) and r.play_type_nfl != "END_GAME":
            n = nxt.iloc[0]
            sb.update(possession=ESPN_ID[n.posteam], down=int(n.down), distance=int(n.ydstogo), downDistanceText=spot_text(n))
        p["_sb"] = sb
        plays.append(p)
    spread = float(g.spread_line.iloc[0])
    fav, by = (home, spread) if spread >= 0 else (away, -spread)
    out = {"source": f"nflverse play-by-play {season}, {gid}: the opening kickoff and the fourth quarter, recast in the live feed's shape",
           "event": {"id": "2025101600", "date": "2025-10-17T00:15:00Z", "season": {"year": season, "type": 2}, "week": {"number": int(g.week.iloc[0])},
                     "venue": {"indoor": False}, "odds": f"{fav} -{by:g}",
                     "home": {"id": ESPN_ID[home], "abbreviation": home}, "away": {"id": ESPN_ID[away], "abbreviation": away}},
           "plays": plays}
    OUT.write_text(json.dumps(out, indent=0, separators=(",", ":")) + "\n")
    return {"plays": len(plays), "file": str(OUT), "bytes": OUT.stat().st_size}


if __name__ == "__main__":
    print(main(*sys.argv[1:]))
