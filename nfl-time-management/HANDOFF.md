# Handoff: Two-Minute Drill (2mindrills.com), Oct 22, 2026

The owner is Max. The repo is meashton87-sudo/Poly-mm; the game lives in `nfl-time-management/`. Read `CLAUDE.md` in
that folder first. It holds the project's rules and how every part works.

## Standing rules (from the owner)

- Never paste or echo Stripe keys or secrets, and never ask the owner to paste keys.
- Customer PII is never shared further. The owner pastes only `cs_live_` IDs; answer with
  `https://2mindrills.com/?claim=<id>&r=1`.
- Legal changes are on hold. Coach mode is paused.
- No model names in code, PRs or commits.
- Never commit generated data (see CLAUDE.md for the list).
- Teams are named by city only, never by nickname.
- Bots and tests must never reach ads, analytics, the real board or polymarket. Polymarket stays off.
- Every PR that changes the game adds its notes at the top of `web/patch_notes.json`. Game changes only, never ads or
  tooling. `tests/test_patch_notes.py` checks it.
- Changes ship by PR to `main`. The `site.yml` deploy takes about 80 minutes, with the browser test as its gate.
  - Don't merge while a deploy is running: it can cancel or delay the one in flight.
  - Batch changes into one PR.
- Before merging, run `scripts/browser_test.py` locally. One check, "Who plays: no spot with another quarterback",
  always fails locally because the local data is stale. Ignore it.
- Rare cosmetic checks report instead of blocking.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013B7agMisSsirUrdiKtbxa2`. PR bodies end with the Claude Code line
  and the session URL.

## What is live

- **#212:** sacks, accept or decline penalties, hitch spam, run-blocking schemes, motion, formations, and the stats
  tally.
- **#213:** honest per-snap pass odds, pass protection (Standard / RB in / Max protect), the 📋 Plays concepts picker
  (routes stay editable), the no-scroll phone layout, the tackler always on camera, and no defender running past the
  ball carrier.
- **#214, the patch notes page (`/patch-notes`):** merged at about 03:37 UTC. Its deploy should finish around 05:00
  UTC. A scheduled check fires at 05:03 UTC (trigger `trig_012PybTGe4yCCVunG9wyVmaq`) and also reports the load test.

## In progress: Versus launch (branch `claude/versus-launch`, no PR yet)

**Done and committed:**
- **Computer opponent** (`board/match.js`, mode `cpu`, seat 1):
  - its call is always the engine's default, the same calls an average NFL staff would make;
  - never ranked, never late, never a forfeit;
  - offered after 20 s in the queue, or at once from the lobby's **Computer** button;
  - a rematch needs only the player.
- **Tests:**
  - `board/match_test.mjs` covers the computer;
  - `board/vs_cpu_test.mjs` plays 60 real-engine matches: all end on the score, none are rated, and a random caller
    wins 42%;
  - `board/vs_stress.mjs 300` passes.
- **Client:**
  - a Versus card on Home;
  - the lobby leads with Play now (casual), then Ranked, Computer and Friend;
  - your team shows on one line with a Change button (it defaults to your fanbase team);
  - an ad on the match-over card only, never during a match (`ezDrive`);
  - "Share the result";
  - against the computer the status says "Snapping…", not "Waiting for your opponent";
  - the score never wraps, and the match's call sheet is taller so the calls fit.
- **Analytics events:** `vs_queue`, `vs_matched`, `vs_cpu_offer`, `vs_cpu`, `vs_queue_cancel`, `vs_start`,
  `vs_finish`.
- **Patch notes:** a Versus entry dated 2026-10-22.
- **Load test:**
  - `.github/workflows/versus-load.yml` deploys the board as its own worker (`two-minute-drill-loadtest`, see
    `board/wrangler.loadtest.toml`), runs `board/vs_load.mjs` (60 bot pairs and 40 matches against the computer),
    then deletes that worker.
  - Locally against `wrangler dev`: 40 matches, 0 errors, 95% of answers within about 1.4 s.
  - Run 1 failed for lack of `web/teams.json` (fixed).
  - Run 2 (id 39717865513) was in progress at handoff. Check it, and if it failed, read its job log.
- **Browser test:** a full match against the computer was played in a real browser against a local `wrangler dev`.
  It ended on the score with no script errors (before the last round of fixes).

**Left to do:**
1. **Owner approval needed: turn Versus on.** In `.github/workflows/site.yml`, set `VS_ON: "off"` to `"on"`. The
   permission system blocked this edit, so ask the owner first.
2. Re-run the full browser test on this branch. The last run was killed by a container restart.
3. Re-run the match-against-the-computer browser check after the latest fixes:
   - build the site with `python scripts/site.py <dir> --vs --board-api http://127.0.0.1:8787 --no-ads`;
   - serve the board with `cd board && npx wrangler@4.144.0 dev --config wrangler.loadtest.toml --port 8787`, after
     copying `board/assets/vs/*` into `board/assets-loadtest/vs/`;
   - play it from Playwright: click `#intro .btn`, then prefer `#dock .key.big`;
   - confirm `#dock` never scrolls (scrollHeight minus clientHeight should be 0).
4. Open the PR (base `main`). The branch already has `origin/main` merged in.

## Multiplayer issues still open (from the hater review)

| Issue | Status |
|---|---|
| The computer has one difficulty and always chooses defense at the toss | Open. Idea: "Easy / Pro" levels by blending a worse or better call into its default. |
| Ranked at launch will have few players | Open. The computer covers casual only; consider showing "players online" in the lobby. |
| iOS locking the phone or switching apps for 60 s forfeits the match | `FORFEIT_MS` is 60 s. Consider 90 s, plus a reconnect banner. |
| No in-match emotes | Low priority. |
| The match intro is long ("Kick it off" with three paragraphs) | Shorten after the first match. |
| The ladder is only at the bottom of the lobby | Open. |
| Ranked asking for a name | Already fixed: it falls back to the account username (`myName`). |

## Other open tasks

- Defense analytics calibration (task 73).
- No catches in "triple coverage" (74).
- An Alabama at Tennessee Saturday daily (75).
- The NBA prototype ("Final Possession"): the latest artifact is https://claude.ai/artifact/KVK8jcY73XuuA5fZhhoDr4.
  - Its source is `final-possession.html` in the old session's scratchpad (not in the repo).
  - Owner feedback was to make it broadcast quality: players moving in their real team systems, animated free throws,
    the tempo choice, and visible passes. Version 3 was rebuilt for that.

## Business context the owner shared

- About 100k players a day, with about 10k active in any 30 minutes.
- Daily drives all-time: 601,923 by Oct 21; Survivor and Pro were only counted from Oct 22.
- Ads run on Ezoic, pending Google approval. Kyle at Ezoic asked whether we're still waiting on AdSense approval.
- The earnings estimate given was about $900 a day before Google approval, roughly $25–35k over 30 days if approval
  comes in about two weeks. The owner should send Ezoic dashboard screenshots so it can be calibrated.
