# Handoff: Two-Minute Drill (2mindrills.com), Oct 26 2026

Repo: `meashton87-sudo/Poly-mm`, project in `nfl-time-management/`. Read `nfl-time-management/CLAUDE.md` first; it has
the project rules (patch notes in every game PR, never commit generated data, teams by city only, bots and tests never
reach ads/analytics/the real board, no model names in commits/PRs, commit trailer, etc.).

## Standing rules (from the owner)
- Changes ship by PR to `main`, batched into one PR. The `site.yml` deploy takes 50-90 minutes and restarts the Versus
  match server: never merge while a deploy is running, and not during the Season 1 Championship (Sun Nov 1, 6 PM ET).
- Before merging, run `scripts/browser_test.py` locally. With stale local data one check, "Who plays: the quarterback",
  can fail; with data built the same day it passes.
- Legal changes are on hold (a stash on `claude/legal`, local only). Coach mode is paused.
- Never paste or echo keys or secrets. Customer PII is never shared further.

## State right now
- **Versus Season 1 is live** (#248, deployed 06:36Z Oct 26). Versus is free for everyone from 10 AM ET Oct 26
  (VS_FREE_AT in site.yml). Season 1 runs to Sun Nov 1 noon ET; ratings start at 1000 (beta ratings archived in the
  ladder's `past` table); the Season 1 Championship takes the top 16 (5+ games) at season end, bracket Sun Nov 1 6 PM
  ET, no prize. Lobby: Invitational champion banner on top, one Play button, Season 1 ladder.
- **Cup race fix is live** (#249): cup events run one at a time (blockConcurrencyWhile); cup_test covers it.
- **Unknown:** whether the Invitational (Oct 25) finished with a champion before #248 deployed. If not, the lobby's
  champion banner is empty: the champion can be set with POST `/vs/cup/admin`, or the banner data (`cupPast` in the
  'cup' Durable Object) needs a small admin addition. Ask the owner who won.

## In review: `claude/bot-findings-oct26` (the Oct 26 bot check's top 3, plus the pass screen)
1. **Faster first call on phones.** The page's head (site.py, the inline script after the stamps meta) starts the
   simulator's first worker at once (`self.TMD_W0`); game.js `startWorker` adopts it when its address matches
   `workerUrl()` (else terminates it; a load error is kept and reported). Not on `#vs` pages. A `<link rel=preload>` was
   tried and dropped (workers don't use page preloads; Chrome warns).
2. **Lighter stands.** game.js `crowdPattern` draws the crowd tile as one `<image>` (an SVG data URI) inside the
   pattern instead of ~900 shapes redrawn every camera frame (WebKit). Chromium at 6x CPU: mean frame 41 -> 31 ms,
   frames over 50 ms 37-39 -> 2-7 of 240. Checked pixel-identical to the old drawing at 3x DPR in Chromium (native
   scale and 4x zoom); Safari itself was not available locally.
3. **`/midlogo.png` stamped and cached for good** (site.py IMMUTABLE, game.js `asset('midlogo.png')`).
4. **Play action and Roll out on the pass screen itself** (the owner: players lost them behind More); only the
   protection row stays behind More.
Checks run on the branch: eslint, pytest, `site.py` (check_stamps), `browser_test.py --daily 6 --survivor 3 --games 2`
(9 of 9 clean before item 4; re-run after it). Patch notes added ("Faster on phones").
After the deploy: the next daily bot check (daily-check.yml, Chromium + WebKit) should show engine.js and the first call
much sooner on the iPhone episodes and fewer frames over 200 ms; `/midlogo.png` no longer among the slow files.

## Local setup notes (a fresh container)
- `pip install -e ".[dev]" && pip install playwright`; Chromium is pre-installed at `/opt/pw-browsers/chromium`
  (pass it as `--chromium`); never `playwright install`. No WebKit locally.
- Data: `python -m nflclock.cli build`, then `webexport.export_engine()` and `dailygame.build()` (about 10 minutes, the
  nflverse downloads allowed). Then `python scripts/site.py _site_a --board-api http://board.example --no-ads` and the
  browser test as in CLAUDE.md.
- GitHub's artifact store (blob.core.windows.net) and the board worker's address were blocked from the container.

## Other open items
- Daily bot check: the scheduled 10:23 UTC run fires late, after the review routine (11:25 UTC) already dispatched one
  by hand; the gate job skips the later scheduled run. Moving the review later or the cron earlier would avoid it.
- Not started, awaiting the owner: push notifications / daily reminder toggle.
