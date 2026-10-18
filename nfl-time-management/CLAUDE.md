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
node web/score_sweep.js               # daily score: real spots played out by random, league-mix, sharp and greedy players, scored by game.js's own code (~15 min on 4 cores)
node web/motion_test.js               # daily game animation: player motion stays in the tracking envelope, routes, coverage
node board/worker_test.mjs            # the website's survivor leaderboard (Cloudflare Worker + Durable Object), storage in memory
node board/match_test.mjs             # Versus: rooms, lobby, ladder in memory (board/vs_world.mjs), a stand-in engine (a second)
node board/lazy_sim_test.mjs          # Versus: the room's lazily built simulator equals the engine's, table by table and play by play
node board/vs_pairs_test.mjs          # Versus: every one of the 992 matchups (32 teams, home and away) played to the end, the rules on every snap
node board/vs_balance_test.mjs        # Versus: the defense's effects as the game plays them; every defensive option is the answer to something
node web/defense_calibration.js       # the full defense against real NFL plays: pressure, sacks, time to throw, yards... by rush, coverage, box
node board/vs_stress.mjs 2000         # Versus: thousands of whole matches, real engine, misbehaving phones; every match replayed and checked
```

## Rules

- **Parity**: any change to `src/nflclock/sim.py` (or to library sampling in `library.py`) must be made
  identically in `web/engine.js`, and the parity check above must pass. The browser tool is what
  coaches use during a game.
- First call on the website: each spot's file carries its opening snap's facts (scripts/site.py spot_info runs
  web/spot_info.js, the site's own worker on its packs). spot_info.js copies game.js startRoot, buildScen, simScen and
  infoKey: change them together (a mismatch only makes the first call wait on the simulator, and the browser test fails).
  Every file the site loads is stamped with its own content (`?v=`; site.py check_stamps fails the build otherwise).
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
- The defense (every mode): the defense calls personnel, front, coverage and rush (engine.js DC). The offense's play is a
  real NFL play run against that defense, as charted (sampleVsDefense: the pass rush, then the shell, then man or zone;
  a run's box, then the blitz), widening the situation before letting a filter go, never across the goal line, the
  20 or short yardage and never from nearer the goal (_nearRows, dcRegion, dcShort). Its mean EPA (over where each play
  was run: _dcResid) is the offense's own there plus the defense's effect (dcEffect: playbook.py dc_effects, ridge per
  kind of play, each part's strength chosen on held-out seasons). The flags and a pass call's non-dropbacks come from
  the situation's own pool at its rate. 2022's charting left the coverage and pressure off sacks and scrambles, so the
  rush and coverage filters use the seasons charted in full (playbook.py _charted_in_full, rush bit 6). In the daily
  game the computer's offense reads the call (act.read: dcLean, pickCall) and the call is graded against the quick
  calls that fit the spot (game.js PRESET). After changing any of it, run web/defense_calibration.js (every rush level,
  coverage, box and defensive-back count against the real plays, within a few standard errors; try a few seeds) and
  board/vs_balance_test.mjs.
- Pro data (src/nflclock/pro.py build: pro_drives.json, pro_runs.json -> web/pro/drives.json, runs.json, d*.json, r*.json;
  generated, never committed; the site workflow builds it and deploys it to the worker's assets). Each spot's teams come
  from history.History.teams with drive=True: the lineup of the real drive from the spot on, everyone who touched the
  ball on it (offense) or made a play (defense) on the field at his position (_drive_lineup), the line in its depth
  chart's slots (nflverse depth charts, 2001 on). Who is on the field: the snap's participation (2016 on), the game's
  snap counts (2013-2015), the depth chart's starters (2001-2012), the box score and the season roster before that; a
  line no data names (1999-2000) is the drive's "line" in pro_drives.json. Each spot carries its time's overtime
  (pro.py overtime_rules: sudden death, the 2010-2024 touchdown-wins rule, or both teams get the ball; engine.js
  _otAfter S.ot.r). A run's game spot always has something at stake (RUN_WP); a run ends at the first loss (game.js
  runOut), as a real one does, and can be played again.
- The Gauntlet (board/worker.js /race*): the contest on the historic drives, over (RACE_TO, Oct 16 2026). Its game code
  (game.js racePanel, the race bar, #gauntlet) was removed in #125; the worker endpoints and web/admin.html remain, so
  what follows describes them. game.js keeps only GAUNTLET_FROM / gauntletFresh (the drive records from its start). A Pro code enters once under
  a public name (blocked() names refused); a drive counts the first time it is passed (an A, 90+, and the game won) after entering and after
  RACE_FROM (4 pm Eastern, Oct 16 2026 by default); each pass keeps its calls (race:audit) for the check before a prize.
  The first to pass all RACE_N (24) wins. `DELETE /race?id=` (or `?name=`) with the admin token takes a run off the board.
  The check before a prize: web/admin.html (site.py copies it to /admin.html with only the board-api meta: noindex, not
  linked, no analytics; the token is pasted and kept in sessionStorage) reads GET /race/admin (every entry, each pass's
  grade, try length and a hash of its calls; 50 entries a page, ?after= the page's next, the page's Load more) and
  /race/admin?id= (the calls), flags short tries, The Miami Miracle before
  its fix (MIAMI_FIX in the page) and the same calls from two entries, and voids one pass (POST /race/admin/void: n, nAt
  and the winner worked out again, the audit kept under race:void:) or takes a run off. Optional worker vars: RACE_TO (an
  end time: no try or pass after it) and NEXT_CONTEST (a line shown with the results, GET /race).
- Accounts (board/worker.js /auth*, game.js authNodes/proVerify): Pro can belong to an account (Sign in with Google: the
  ID token is verified in the worker; or a one-use emailed link via Resend). Off (503, hidden on the page) without
  GOOGLE_CLIENT_ID (wrangler.toml var; site.py --google-client-id puts the same id in the page) or RESEND_KEY + MAIL_FROM.
  Sessions and link tokens are stored only as SHA-256 hashes. A code belongs to one account (pro:code:X.acct). Signed
  in, /restore, /pro/data and /race/* take { session } (the account's code, no device limit; the same Gauntlet entry as
  the code); the code path and its 3-device limit are unchanged. Never return another account's data. The top bar's
  account button (game.js acctBar) is Log in, then the account's username (/auth/name: 3-20 characters, one account each,
  never blocked()).
- Signed in, more follows the account (worker.js, the tests in worker_test.mjs): the page's record (stats days, historic
  drives from the Gauntlet's start, playoff runs, badges and the days a streak freeze covered: a union, the earliest
  time of each) merges both ways with /auth/stats (the best of each kept; game.js
  statsSync on sign-in, on load at most every 10 minutes, after each finish); the account's username is its name on the
  survivor board and the day's list from any phone (a { session } with the post: acctNameKey; a name set on the device
  still wins on the page, myName); friend leagues (/league/*, #league-<code> join links: 50 members, 10 leagues an
  account; a board shows usernames and daily numbers only, to members only); the daily email (/auth/remind, the cron in
  wrangler.toml [triggers], `scheduled` -> the Board's reminders: one a day an account, REMIND_CAP a run (an optional
  worker var, 1000 by default; a capped run keeps where it stopped, remind:from, and the next run goes on from there,
  round to the first), an HMAC unsubscribe link; only with RESEND_KEY + MAIL_FROM). Never put an address or account id
  in anything another account can read.
- Lost Pro codes (board/worker.js /recover, game.js recoverNodes): the email paid with in, the code(s) out by email only
  (Resend, MAIL_FROM), each with a ?claim=<session>&r=1 link (r=1: no purchase event). Always the same { ok } answer, at least
  RECOVER_MIN_MS, whether or not the address bought anything; RECOVER_MAX an hour an address, RECOVER_IP_MAX an IP. The
  webhook and /claim keep pro:buyer:<HMAC(mailSecret, address)> -> session ids; Stripe's Checkout Sessions list
  (customer_details[email], complete, paid, tagged tmd_pro_) finds purchases from before. Never log or return an address
  or a code.
- Streaks and badges (game.js streakOf, BADGES): the streak is worked out from the days played (the same on every phone); every 7 days in a
  row earn a freeze (2 held at most), spent on a missed day once the next day is played (stats.frozen keeps the day: the
  ❄️, the one note and event). A league board's streak is worked out the same way (worker.js streakOf, the same
  constants: change both together), pending freezes included. A badge is earned once (stats.badges: { id: time }); most are
  tests on the record so a new phone signed in earns the same ones. A new badge needs no worker change (its id is only
  checked for shape there).
- The day's and week's lists (board/worker.js /daily, /week; game.js leaders): a name's first result of a day goes on the
  day's list (25 kept, 10 shown) and into its weeks (wk:<end date>: each name's best WEEK_BEST of 7 days added up, a
  histogram for ranks, 100 kept); kept as results come (a result touches 7 week values), never rebuilt by scanning.
  A restarted daily (game.js restartAsk: Start over, the ☰ menu on a phone, under the field elsewhere; the day's state
  keeps restarts, the post says restarted: true) is the device's first result all the same but stays out of the day's
  n, histogram, averages and both lists (the day counts them as nr): the day's draws are everyone's, so a restart could
  learn them. It counts for the player (score, stats day, streak). Pro drives and runs restart as a new try (new tryAt,
  new draws), archive days freely; never survivor, practice or Versus.
  Never a blocked() name; `DELETE /week?name=` (admin token) takes a name off for good. Practice (#practice, game.js
  practiceState/renderPractice): only after the day's drive is done; its own saved state; it must never write a stats
  day, the streak, tendencies or post to /daily.
- The fair set (worker.js day.f; game.js fairDay/dayFor, stats.html show): a /daily post with g: 2 (every call graded
  g: 2) also counts there; old-way results are never replaced or moved (first result per device stands). Where a day
  has both (Oct 18, 2026), the stats page and a fair result's day card use the fair set only, with a note.

## Moving the site to a new address
The site moves with two GitHub variables; nothing else in the code names the address.
1. Add the new domain to the Cloudflare Pages project `nfl2mindrill` (Custom domains) and keep the old one on it too:
   the same build answers on both.
2. Set `SITE_DOMAIN` to the new domain and `OLD_DOMAIN` to the old one (comma-separated if several), then deploy.
   On the old address every page hands the visitor over (scripts/site.py MOVE_JS): their saved progress (stats, Pro
   code, name, device key, sign-in, settings, today's drive) goes along in the link's # and is unpacked on the new
   address before the game starts. The worker's SITE (email links) and ALLOWED_ORIGINS follow the two variables.
3. Outside the code: the Google OAuth client's authorized origins (add the new one), Resend's sending domain if the
   emails should come from the new one (MAIL_FROM), Stripe's business website, Search Console (add the new property;
   the change-of-address tool once the old address redirects with a 301), the X bio, and og.png (the link preview
   image prints the address: redraw web/og_card.html).
4. After a few weeks, when the regulars have been handed over, the old domain can switch to a plain 301 redirect
   (a Cloudflare redirect rule): keep the domain registered for at least a year.
