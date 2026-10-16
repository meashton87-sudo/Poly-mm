# nflclock: notes for agents working on this project

Simulation engine for NFL clock and game management. Python package in `src/nflclock`; the browser
version lives in `web/` (`engine.js` is a line-for-line port of `sim.py`, run in Web Workers by
`live.html`).

## Setup (data and models are not in git)

```bash
cd nfl-time-management
pip install -e ".[dev]"
python -m nflclock.cli build          # downloads nflverse play-by-play to data/raw, fits artifacts/bundle.pkl (~3-5 min)
python -m nflclock.cli sync --no-refresh --games 2026_05_BUF_LA        # live game file (Bills at Rams)
python -c "from nflclock import webexport as w; w.export_engine(); w.export_game('2026_05_BUF_LA')"
python -c "from nflclock import dailygame as G; print(G.build())"   # daily game data (web/playbook.json, web/game.json)
python scripts/site.py _site --domain nfl2mindrill.com --board-api https://... --ga G-4QQ8N62SMB   # the game as a static website
```

## Checks

```bash
python -m pytest -q
python scripts/parity_expected.py 2026_05_BUF_LA 8000 && node web/parity_test.js 8000
node web/game_smoke.js                # daily game: every spot's two real teams, playbook sampling, call ranking, play-by-play log
node web/game_sweep.js                # daily game: every spot x call x tempo, whole games, football invariants, points to the right team, the called play is the play run (~3 min)
node web/motion_test.js               # daily game animation: player motion stays in the tracking envelope, routes, coverage
node board/worker_test.mjs            # the website's survivor leaderboard (Cloudflare Worker + Durable Object), storage in memory
node board/match_test.mjs             # Versus: rooms, lobby, ladder in memory (board/vs_world.mjs), a stand-in engine (a second)
node board/lazy_sim_test.mjs          # Versus: the room's lazily built simulator equals the engine's, table by table and play by play
node board/vs_pairs_test.mjs          # Versus: every one of the 992 matchups (32 teams, home and away) played to the end, the rules on every snap
node board/vs_balance_test.mjs        # Versus: no defense or call is safe against everything; every defensive option has a use
node board/vs_stress.mjs 2000         # Versus: thousands of whole matches, real engine, misbehaving phones; every match replayed and checked
```

## Rules

- **Parity**: any change to `src/nflclock/sim.py` (or to library sampling in `library.py`) must be made
  identically in `web/engine.js`, and the parity check above must pass. The browser tool is what
  coaches use during a game.
- NFL rules are encoded explicitly (clock stops, two-minute warning, out-of-bounds windows, play clock,
  timeouts). Keep a one-line rationale next to every policy constant at the top of `sim.py`.
- The full grading pipeline (`scripts/run_analysis.py`, `validate_sim.py`, `make_report.py`,
  `finalize.py`) takes about 1.5 hours on 4 cores. Do not run it casually.
- `data/`, `artifacts/`, `web/engine_data.json`, `web/parity_expected.json`, `web/playbook.json`,
  `web/game.json`, `web/spots/` and `_site/` are generated; never commit them (the website workflow,
  `.github/workflows/site.yml`, builds them in CI and ships them only to GitHub Pages).
- The daily schedule is frozen in `src/nflclock/daily_schedule.json` (committed: every spot id in order and each
  day's three spots, as it went live). Never regenerate it with `dailygame.freeze()` from a fresh build: that moves
  days people have played or are playing. Extend it only by adding days at the end; never reorder it. Its
  `featured` map puts a famous spot (any first-down snap, with a story shown on the intro) on a future day.
- Decisions are graded "as of" the week of the game: no ratings may use later games.
- Versus (board/match.js): the room plays the football (web/vs_core.js holds the college-overtime rules, shared with the
  page); phones only send calls. Each snap's seed is drawn fresh by the room and never sent to a phone (a phone that
  knew it could see what a call does before making it). lazy_sim_test.mjs and vs_stress.mjs need board/assets/vs (the
  engine packs and teams.json; the site workflow copies them there before deploying the worker).
- The defense (every mode): the defense calls personnel, front, coverage and rush (engine.js DC, dcMatch); in the daily
  game the computer's offense reads it (act.read: dcLean for run or pass, pickCall checks into a better call) and the
  call is graded against the quick calls that fit the spot (game.js PRESET). The real play is drawn
  against that defense (sampleVsDefense) but its mean EPA is recentered on the offense's own plus the matchup tilt, so
  balance lives in dcMatch alone: after changing it, run vs_balance_test.mjs (it solves the call-by-defense game per
  situation: no fixed call or defense may be safe, and every option must be near the best somewhere).
- The Gauntlet (board/worker.js /race*, game.js racePanel): the contest on the historic drives. A Pro code enters once under
  a public name (blocked() names refused); a drive counts the first time it is passed (an A, 90+) after entering and after
  RACE_FROM (2 pm Eastern, Oct 16 2026 by default); each pass keeps its calls (race:audit) for the check before a prize.
  The first to pass all RACE_N (24) wins. `DELETE /race?id=` with the admin token takes a run off the board.
