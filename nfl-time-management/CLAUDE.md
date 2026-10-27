# nflclock: notes for agents working on this project

Simulation engine for NFL clock and game management. Python package in `src/nflclock`; the browser
version lives in `web/` (`engine.js` is a line-for-line port of `sim.py`, run in Web Workers by
`live.html`).

## Setup (data and models are not in git)

```bash
cd nfl-time-management
pip install -e ".[dev]"
python -m nflclock.cli build          # downloads nflverse play-by-play to data/raw, fits artifacts/bundle.pkl (~3-5 min)
python -m nflclock.cli sync --no-refresh --games 2026_05_BUF_LA        # live game file (Buffalo at Los Angeles)
python -c "from nflclock import webexport as w; w.export_engine(); w.export_game('2026_05_BUF_LA')"
python -c "from nflclock import dailygame as G; print(G.build())"   # daily game data (web/playbook.json, web/game.json)
python -c "from nflclock import scenario; print(scenario.build())"  # Pro's scenario rosters (web/rosters, ~12 min)
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
node board/vs_draft_test.mjs 12       # Versus Draft: the blind auction against the computer with the real engine (board/assets/vs), the drafted sides, the match to the end
node board/lazy_sim_test.mjs          # Versus: the room's lazily built simulator equals the engine's, table by table and play by play
node board/cup_test.mjs               # Versus: the Invitational (the standings at the qualifying time, the bracket, its rooms, no-shows, the claim code)
node board/vs_pairs_test.mjs          # Versus: every one of the 992 matchups (32 teams, home and away) played to the end, the rules on every snap
node board/vs_balance_test.mjs        # Versus: the defense's effects as the game plays them; every defensive option is the answer to something
node web/defense_calibration.js       # the full defense against real NFL plays: pressure, sacks, time to throw, yards... by rush, coverage, box
node board/vs_stress.mjs 2000         # Versus: thousands of whole matches, real engine, misbehaving phones; every match replayed and checked
python scripts/daily_check.py browsers --live http://127.0.0.1:8000 --browser chromium --minutes 5   # the daily bot check (daily-check.yml) on a build you serve; engine, report likewise
```

## Rules

- **Parity**: any change to `src/nflclock/sim.py` (or to library sampling in `library.py`) must be made
  identically in `web/engine.js`, and the parity check above must pass. The browser tool is what
  coaches use during a game.
- First call on the website: each spot's file carries its opening snap's facts (scripts/site.py spot_info runs
  web/spot_info.js, the site's own worker on its packs). spot_info.js copies game.js startRoot, buildScen, simScen and
  infoKey: change them together (a mismatch only makes the first call wait on the simulator, and the browser test fails).
  Every file the site loads is stamped with its own content (`?v=`; site.py check_stamps fails the build otherwise).
- Patch notes (web/patch_notes.json -> /patch-notes, site.py patch_notes_html; the game's Home links it): **every PR that
  changes the game adds its notes at the top** in the same PR (the date it merges, Eastern; a short title; one plain line
  a change, as a player would say it). Game changes only: never ads, analytics, payments, the site's address, tests or
  tooling, nor anything not live (Coach mode, the full defense) until it is. Never the league's name or marks either (NFL,
  Super Bowl, a trademarked play's name: "real plays", "real play-callers"; tests/test_patch_notes.py MARKS). tests/test_patch_notes.py checks the
  order and the wording; tests/test_names.py the team names.
- NFL rules are encoded explicitly (clock stops, two-minute warning, out-of-bounds windows, play clock,
  timeouts). Keep a one-line rationale next to every policy constant at the top of `sim.py`.
- The full grading pipeline (`scripts/run_analysis.py`, `validate_sim.py`, `make_report.py`,
  `finalize.py`) takes about 1.5 hours on 4 cores. Do not run it casually.
- `data/`, `artifacts/`, `web/engine_data.json`, `web/parity_expected.json`, `web/playbook.json`,
  `web/game.json`, `web/spots/`, `web/rosters/` and `_site/` are generated; never commit them (the website workflow,
  `.github/workflows/site.yml`, builds them in CI and ships them only to GitHub Pages).
- The daily schedule is frozen in `src/nflclock/daily_schedule.json` (committed: every spot id in order and each
  day's three spots, as it went live). Never regenerate it with `dailygame.freeze()` from a fresh build: that moves
  days people have played or are playing. Extend it only by adding days at the end; never reorder it. Its
  `featured` map puts a famous spot (any first-down snap, with a story shown on the intro) on a future day, or two sides
  of one game (`sides`: each an id, kind, note and summary, the real drive's story; the first is the day's `id`): the
  player picks one (game.js sidesOf/renderSidePick, kept per device in `:side:<day>`, the day's state and its stats day),
  it is the day's drive, and the /daily post says which (side: the team's code; worker.js keeps each side's count,
  histogram and average beside the day's, stats.html shows them).
- Decisions are graded "as of" the week of the game: no ratings may use later games.
- Teams go by their city or region, never a nickname, anywhere a player sees them (game.js TEAMS, stats.html SIDE_NAME,
  the notes and titles in daily_schedule.json, pro_drives.json, pro_runs.json, custom_spots.json): Los Angeles (NFC)
  and (AFC), New York (NFC) and (AFC) for the shared markets (game.js teamShort "LA (NFC)" where room is tight), a moved
  franchise by its city of the time (web/scenario.js ERA = scenario.py ERA_NAME: St. Louis, San Diego, Oakland). A city
  takes a singular verb and no article ("Dallas has the ball", "Take over as Dallas"). tests/test_names.py checks.
- The daily bot check (scripts/daily_check.py, .github/workflows/daily-check.yml) plays the live site: nothing it does may
  reach an ad network, analytics or the real board (bot ad impressions would get the ad accounts banned). Its Guard cuts
  off every request to another host than the site's own and hands the page a stub board in place of its
  `<meta name="board-api">`, so the page's board address must keep coming only from that meta (its selftest fails on a
  page that still names the real board). Findings go in its report; only the harness breaking turns the run red.
- Versus on the site (site.yml VS_ON): "off", "on" (everyone) or "pro" (site.py --vs --vs-pro: part of Pro; game.js VS_PRO:
  the lobby, its quick match, ranked and the computer take Pro, anyone else gets the Pro pitch; a room's link, a Pro
  player's invite, plays for whoever has it); VS_AT (--vs-at: <meta name="vs-at">) holds it until a time, a reload after
  shows it. "pro" without PRO_ON is no Versus at all. The gate is the page's (isPro): the room never asks.
- The Invitational (board/match.js CUP, the 'cup' object; shown as "Two-Minute Drill Invitational"): the top CUP.size
  (16) on the ranked ladder at CUP.qualifyAt with CUP.minGames (5) rated games play a single-elimination bracket from
  CUP.startAt, seeded by rating (cupBracket: the standard order; byes when fewer). The standings at the qualifying time
  are worked out exactly at any time after it (/vs/standings: every rated game since taken back off; the games table
  keeps each change as it moved). Each match's room (mode 'cup', both seats taken) opens when both its players are
  known; not in within CUP.showMs: the other goes on, neither: the higher seed. Results come from the rooms only
  (/vs/cup/report, never routed from outside). The admin settles a match by hand until the next one starts: POST
  /vs/cup/admin { match: '1-3', winner: 0|1 } (Authorization: Bearer <ADMIN_TOKEN>; with no body it returns the whole
  bracket, the champion's claim code included). The champion's phone shows that claim code. Another one: the worker
  vars CUP_ID, CUP_QUALIFY_AT, CUP_START_AT, CUP_PRIZE, CUP_SIZE, CUP_MIN_GAMES (or a new CUP). cup_test.mjs checks it.
- Versus (board/match.js): the room plays the football (web/vs_core.js holds the college-overtime rules, shared with the
  page); phones only send calls. Each snap's seed is drawn fresh by the room and never sent to a phone (a phone that
  knew it could see what a call does before making it). lazy_sim_test.mjs and vs_stress.mjs need board/assets/vs (the
  engine packs and teams.json; the site workflow copies them there before deploying the worker).
  4th down (vs_core.js at4, cot.k4): the offense says first, go for it, a field goal or a punt (intentsAt), and the
  defense calls knowing it; a kick is then a decision for both: the offense kicks or fakes (FAKES: a trick play against
  the kick defense called, KICK_DC), the defense goes for the block or stays home (KICK_DEF: engine.js act.st). A kick
  only that way (cleanHalf drops a kick at the snap). The clocks (match.js decideMs): the defense 15 s, then the
  offense 20 s from the moment the defense's call is in (offStart; {t:'clock', wait:true} until then); 4th down's
  question 15 s; the defense can take a timeout. vs_pairs_test.mjs checks the order of it on every snap.
  The computer (match.js CPU_SEAT, mode 'cpu', never rated): offered to a ticket after CPU_AFTER_S in the queue, or at
  once from the lobby's Computer button (/vs/queue?mode=cpu); its half of every decision is the default (the engine's
  own call), in at once (cpuTurn), never late, away or a forfeit; a rematch needs only the player. vs_cpu_test.mjs plays
  it with the real engine. The load test (.github/workflows/versus-load.yml, board/vs_load.mjs) deploys the board as
  its own worker (wrangler.loadtest.toml: its own Durable Objects), never the real one, and deletes it after.
  Versus Draft (web/vs_core.js DRAFT, match.js draftStart/draftBid/draftSettle; mode 'draft' in the queue, or draft=1 on
  the computer's or a friend's room; never rated): a blind auction before the toss. Both sides get DRAFT.budget ($50);
  cards come up slot by slot (DRAFT.order), each a team's man at the slot drawn by draftPool, blind to the phones (the
  team and the slot; draftMask, the names revealed with the last 'draft' message); the bidding is open (the first bid
  the card's floor or more, then a dollar or more over the bid in, never over draftMax: a dollar kept for each slot
  still open, never your own bid raised), each bid putting DRAFT.raiseMs back on the clock (closeMs when the other
  side cannot top it), the high bid taking the card at the deadline, a card nobody claimed to nobody, a kind both
  sides have skipped. The floor (draftFloor; the owner: the second quarterback is never a dollar after the first went
  for twenty): the man's sticker (draftCards: his place among all the teams' men at the slot, $1 to DRAFT.sticker[k]),
  or half the most the other side paid for the kind, whichever is more; a slot still open when the pool is out gets
  the worst man left at his floor or what the side has (draftFill). The sides play as DRAFT.teams (draftTeam: the ratings blended
  from the picks' teams, the lineups the men picked). The computer bids on the room's alarm a beat after each card or
  bid, up to draftCpuValue. match_test.mjs covers the rules; vs_draft_test.mjs plays it with the real engine.
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
- Drawing the play (every mode; game.js readRun, readQb, readDef, readKick, commitSketch): a drawing is only ever read
  as a call the keys make in that spot (callOptions, the three looks or the full call's parts, the kick choices) and is
  graded as that call. What is drawn rides along for the field only (act.path, qbPath, drawn/routes/target, ddraw: the
  engine never reads them; game_sweep.js checks the same seed plays the same with them). Never let a drawing reach the
  engine's sampling or the grading; in Versus vsSealed sends the room only what its cleanAction keeps. A new kind of
  drawing gets a fault message in SKETCH_FAULT and a case in browser_test.py's DRAW_FUZZ.
- How a pass looks (every mode; game.js missOf, missPlan, passCheck): presentation only, never the engine's draw or
  the grading. A catch goes to the catcher's hands; an incompletion is drawn as its real play was charted (playbook.py
  _ball: FTN catchable and contested, a pass defensed; describe() hands them to the animation), fitted to where everyone
  is (the world run on and back) and out of the receiver's reach until it is down. browser_test.py PASS_LOOK draws every
  kind of result and pass_look_problems checks each as drawn, on the real plays too: keep both passing.
- A pass to a picked receiver (route/who): sacks, scrambles and throwaways have no target charted, so they are drawn
  first, as often as in the situation's own plays (engine.js _noTarget, NO_TARGET_EV); game_smoke.js checks the rate.
  A pass you keep calling (game.js repOf, act.rep: the same route or call in the last 4 snaps) is drawn worse from the
  third time on (engine.js REPEAT_S; the open man is never a repeat). A back's run carries the Blocking chips' scheme (act.scheme: zone, power,
  counter, duo, trap; game.js SCHEMES, lineplay draws it) and a small matchup against the defense's call (engine.js
  SCHEME_M, football logic: change both). A foul during the play (not before the snap) can be declined: the engine
  draws the play under it (_livePlay) and the offended team takes the better one, or your pick (act.penAs, game.js
  penaltyAsk: the same seed stepped again). Pre-snap motion (game.js readMotion/setMotion: a receiver, tight end or
  back swiped sideways behind the line): the coverage is decided then (the snap's draw at MAN_SHARE, the man share real
  defenses play against the look shown), shown on the field (in man his man goes with him; in zone the linebackers and
  safeties slide), and a pass is a real play charted in it (act.cov, engine.js _covOk; game_smoke.js checks). The
  Formation picker's empty set and two-back sets are charted too (playbook.py _backfield, FTN n_offense_backfield:
  act.bf, engine.js persForm bits 12-14), with a picked receiver's route as well (routeSet keeps the personnel and
  formation first). Versus
  sends none of these (cleanAction).
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
- Who plays (every mode but Versus; game.js openPers): the personnel, the skill players, and the quarterback, from the
  game's roster (history.py _qb_room: lineup.qbs, each with adj, his adjustment had he played: live.py's starter rule).
  Another quarterback (G.qb; scenario.js withQb) is the team the engine sees: his adjustment for the starter's on the
  pass rating and the difference on every call he throws (QB_CALLS), its own simulator (simScen id |qb:<name>); every
  call of the snap is graded with him (the snap's qb rides with its grading job).
- Build a scenario (Pro, game.js #custom renderBuilder, #custom-<code>; web/scenario.js: the format, its code, the
  presets, check() and spotOf(), shared by the page, web/game_smoke.js and tests/test_scenario.py). Its overtime table
  is pro.py overtime_rules (change both; the test compares them). The rosters (web/rosters/index.json and
  <season>.json, nflclock/scenario.py build, 2001 on: generated, never committed) are on the site, each stamped
  (site.py IMMUTABLE /rosters/*), loaded when the builder opens and a season is picked. A scenario plays like a
  historic drive (stateKey :custom:<code>, each try its own draws: seedKey; Start over; mustWin) and posts nowhere: no
  daily list, stats day, streak or badge. A first-half one played to the final gun kicks off the second half
  (secondHalf); startRoot/otOf read a kickoff start and who has had the ball in overtime (start.otc): spot_info.js
  copies them. My scenarios (tmd:v3:scen) syncs with the account (worker.js stats:s:<acct>, scenMerge). A title (scenario.js TITLE_MAX)
  rides in the link only (#custom-<code>~<title>: link/parseLink), never in the code (state, stats and the community key
  on the code). Each team's lineup can be picked (the builder's Lineups: scenario.js slots, lu; the quarterback, backs,
  receivers, tight ends and kicker of the team-season, rosters' lineup.qbs and kickers): the picks ride in the code after
  its 22 parts (an old code reads as it always did), checkLineup() tests them on the rosters, withLineup() puts them on
  the team; scenario.js CODE_RE is worker.js SCEN_RE (change both; worker_test.mjs checks). scenario.js blocked() is a copy of worker.js blocked() (the builder's hint, a link's title): change both
  (worker_test.mjs checks they agree).
- Community scenarios (game.js renderCommunity #community, commPost, commPlay; worker.js /scen/*): comm:list (the posts:
  code, title, username, time, the account never sent out; written by a post or a removal only), comm:n (the counts: the
  one value a play rewrites), comm:pd:<UTC date>:... once-a-day marks (hashes only; the day's first play clears the day
  before's). Posting takes an account with a username; titles and names blocked() refused (and left out of the list),
  COMM_POSTS a day an account, one post a code, COMM_MAX kept. browser_test.py scenario_community (with --scenario)
  drives it against its stub.
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
- Who you coached like (game.js coachCard: the head coach, "Called it like" an offensive play-caller, "Defended like" a
  defensive one, the last only from full-defense calls). The play-callers are src/nflclock/play_callers.json (committed,
  curated): who really called each side, team by team and week by week, with a source; every team and side from 2022 on,
  the defenses 2016-2021, the best-known offenses 2006-2021. Only real play-callers (a head coach who called his own side
  is its caller); anything shared or unconfirmed is `unverified` (with a note) and left out of the fit (coaches.py
  play_caller_fingerprints, CALLER_MIN snaps). Add a season's rows as it goes (tests/test_play_callers.py checks the
  coverage and the week ranges; web/coach_match_test.js the matcher).
- Streaks and badges (game.js streakOf, BADGES): the streak is worked out from the days played (the same on every phone); every 7 days in a
  row earn a freeze (2 held at most), spent on a missed day once the next day is played (stats.frozen keeps the day: the
  ❄️, the one note and event). A league board's streak is worked out the same way (worker.js streakOf, the same
  constants: change both together), pending freezes included. A badge is earned once (stats.badges: { id: time }); most are
  tests on the record so a new phone signed in earns the same ones. A new badge needs no worker change (its id is only
  checked for shape there).
- The day's and week's lists (board/worker.js /daily, /week; game.js leaders): a name's first result of a day goes on the
  day's list (25 kept, 10 shown) and into its weeks (wk:<end date>: each name's best WEEK_BEST of 7 days added up, a
  histogram for ranks, 100 kept); kept as results come (a result touches 7 week values), never rebuilt by scanning
  (once only: fairWeeks, below).
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
  has both (Oct 18, 2026), the stats page and a fair result's day card use the fair set only, with a note. The weeks
  count no old-way result of that day (worker.js OLD_WAY_DAYS, dates; game.js OLD_WAY_DAYS, day numbers: the same day):
  it stays on the day's whole list, and wn.d keeps null for it (still the name's one result of the day; a fair one never
  replaces it). The weeks kept before that were made fair once (fairWeeks: wn nulls, wk:<D>..<D+6> rebuilt from wn,
  marked fairweek:<D>); the end card's This week says so to its player (the week's old).

- Social (board/worker.js /challenge*, /calls, /fans; game.js challengeOpen/chEnd, crowdKey/crowdLine, fansEl; the
  browser test's social check against its stub). Challenges: the daily's end card makes one (Challenge a friend; its
  /?c=<id> link replaces the share text's ?ch=, which keeps working); a link opens today's daily as ever, a past day in
  the archive with Pro, else its pitch; a finish posts once a device (cplay:<id>), never counted when restarted or the
  challenger's own; names only out (never a key hash), blocked() refused, 30 days then gone. The crowd's calls: the
  /daily post's calls ([situation, call], crowdKey's buckets) counted once a device a day, never a restarted try; a
  share is shown only at 20+ players in the situation; a few days kept. Fanbases: "Your team" (tmd:v3:team, synced as
  stats team, the newest pick) rides with the /daily post; the day's and week's averages by team, shown at 5+ players.
  Teams on all of it by city (TEAMS), never a nickname.

## Moving the site to a new address
The owner's steps, in order, are in DOMAIN_MOVE.md (nfl2mindrill.com to 2mindrills.com). In the code the address is
one setting: the GitHub variable `SITE_DOMAIN` (site.py --domain; DEFAULT_DOMAIN when unset), and while the site moves,
`OLD_DOMAIN` (site.py --old-domain). Nothing else names the address: the pages' canonical links, sitemap, robots.txt,
link previews, shares (game.js SITE/HOME), the CNAME file, the Ezoic ads.txt redirect (site.yml EZOIC_ADSTXT "site"), and
the worker's SITE, ALLOWED_ORIGINS and OLD_SITES (board/site_vars.mjs, run before every worker deploy). Without
`OLD_DOMAIN` a build has no trace of a move (no script, no move.html).
- The handover (web/move.js, first in every page's head, before any other script): on an old address it packs every
  `tmd:` key into the new address's #fragment (never the query: no server sees it) and goes to the same path, query and
  #hash there; the rest of the old page never runs (document.write plaintext). On the new address it takes the fragment
  out of the address first, then imports only when the referrer is an old address (a made-up link imports nothing),
  only into empty keys; stats days/badges/frozen, drives, runs and scen are merged entry by entry (an entry already
  there is never replaced). The device key (`tmd:v3:boardkey`) comes along with Pro unless the new address has a Pro code
  of its own: /restore counts devices by that key (3 a code). It leaves `tmd:v3:movedin`; game.js movedNote says once
  that the game moved, and from an old home-screen icon (navigator.standalone / display-mode on the old page) how to add
  the new one. /move on the old address (move.html) is the same handover back to `#back=<path>`: a redirect rule
  leaves /move alone so a player can still bring their progress after the old address 301s (the home page's link,
  game.js renderHome, for a browser with nothing saved: `<meta name="old-home">`). The link preview card for an
  address is web/og.<address>.png when there is one (og_card.html drawn with that address), else og.png.
- Tests: scripts/move_test.py (Chromium, both real host names mapped to one local server: everything carried, Pro
  checked with the old key, nothing overwritten, a forged link refused, /move, a large record, the home-screen note),
  tests/test_site_move.py, worker_test.mjs (site_vars, the old origin still the site's own). Change move.js and
  move_test.py together.
