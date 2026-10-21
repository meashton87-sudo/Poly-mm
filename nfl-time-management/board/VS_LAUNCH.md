# Versus launch runbook

Versus is built and switched off on the live site (`VS_ON: "off"` in `.github/workflows/site.yml`; the Pro preview at
nfl2mindrill-pro-preview.pages.dev always has it). The worker always answers `/vs/*`, so the preview plays against the
real lobby, rooms and ladder: what is on the preview is what launches.

## What it is

Two players, two phones, each calling their own side. The **Five-Minute Drill** (the default): tied 0–0, 5:00 left in
the fourth quarter, NFL rules and clock, three timeouts each; a coin toss (seat 0 calls it in the air; the winner picks
receive, kick or the end of the field), a kickoff, every call the daily has; ahead at 0:00 wins; tied, a fresh toss and
college overtime (the rules of the **Overtime shootout**, the second game). Calls are sealed: the room (board/match.js)
plays the football with the engine; phones only send calls and never see a seed. 30 s a call; out of time, the coach
calls it; three in a row, a forfeit; 90 s gone, a forfeit. Modes: ranked (even teams, the Elo ladder, tiers), casual,
a friend (a six-letter code, a link for a group chat) and the computer (unrated). A match: 23 snaps on average, about
14 minutes at a human pace (p90 22 minutes); the shootout about half that.

## Flip it on

1. `.github/workflows/site.yml`: `VS_ON: "on"`. Merge. The site ships with `--vs` (the Versus tab).
2. Nothing in Cloudflare has to change. Optional worker variables (dashboard, no deploy; `keep_vars` keeps them):

| variable | default | what |
| --- | --- | --- |
| `VS_ON` | on | `off`: no new match is made; the page says Versus is busy and offers the computer. Matches in play play on |
| `VS_MAX_QUEUE` | 20000 | the most players one lobby object holds; past it, busy |
| `VS_LOBBY_SHARDS` | 1 | casual matchmaking spread over this many objects per game (ranked stays one). Raise to 4 past a few thousand online |
| `VS_JOIN_MAX` / `VS_ROOM_MAX` | 120 / 400 | queue joins / room connections an address may make a minute (a bot stops; a campus behind one address is the risk) |
| `VS_NET_CHECK` | on | `off`: two phones on one network may play rated (only ever for a load test's throwaway worker) |

## Before the flip (the checklist)

- [ ] `node board/match_test.mjs`, `lazy_sim_test.mjs`, `vs_pairs_test.mjs`, `vs_balance_test.mjs`, `vs_stress.mjs 2000` green (the site workflow runs them before every worker deploy)
- [ ] Two phones on the Pro preview: a friend match, a casual match, a ranked match, the computer; one phone backgrounded a minute mid-match and back; the end card's rating on both
- [ ] A load run (Actions → **Versus load test**, the defaults: a throwaway worker, 10 × 1000 players over 5 minutes) with every bar met: pair p95 < 15 s, snap p95 < 1.5 s, errors < 0.5%
- [ ] The ladder page (#vs-ladder) empty but rendering; a blocked name refused on the Versus screen
- [ ] The Cloudflare dashboard: Durable Objects on the paid plan or the free plan's limits understood (below)
- [ ] Analytics: `vs_start`, `vs_finish`, `vs_queue`, `vs_matched`, `vs_queue_cancel`, `vs_cpu` arriving
- [ ] Someone on call for the first evening with the dashboard open (the kill switch is `VS_ON` = off)

## The owner decides

- **The ladder is one ladder** for both games (the Five-Minute Drill and the shootout share ratings): simpler to read, and
  the skills overlap. Separate ladders would need `/vs/ladder?game=`: an hour's work if wanted.
- **Ranked plays even teams**; casual and friend matches use the real strengths (shown as a number by each team, 80 the
  average). The lobby says so.
- **Ranked names**: a name is required for ranked; blocked() names are refused on the page and dropped by the room and
  the ladder (shown as Anonymous).
- **A tie at 0:00** goes to the shootout's rules. An alternative (NFL overtime, 10 minutes) would double the longest
  matches.

## Risk register

| what could break | how likely | what the player sees | the fix or the mitigation |
| --- | --- | --- | --- |
| A rush of 10,000 joins hits one lobby object | medium on day 1 | the queue page sits on "Finding you an opponent" | Joins are O(log n) now (a sorted list, the band near the rating), the counts go out on a 3 s tick, rooms are made outside any lock. Set `VS_LOBBY_SHARDS` 4 (casual). Ranked stays one object: at 5,000 waiting it holds, past that raise `VS_MAX_QUEUE` consciously or shard ranked by rating band (not built) |
| Cloudflare evicts or restarts a room's object mid-match (a deploy does this to every object) | certain, now and then | both phones "Reconnecting…" for a few seconds, then the match goes on | State lives in storage; alarms resume; the phones reconnect and catch up from `since` (match_test: eviction and a deploy mid-match). Deploy the worker outside peak hours all the same |
| The engine fails to load in an isolate (assets missing after a bad deploy) | low | matches stall at the first snap, then end "Something went wrong" after three tries | The worker deploy refuses without `assets/vs` (site.yml); `vs engine` errors in the worker's logs. Roll back the deploy |
| Memory: several rooms share one isolate (128 MB) | low-medium | rooms die with an out-of-memory, players see "Reconnecting…" then a forfeit or an error | The engine unpacked once per isolate (about 55 MB), each room's simulator lazily built (2.5 MB a matchup, lazy_sim_test) and cleared at the match's end. 10 live matchups fit with room to spare; a warm isolate on Cloudflare typically holds far fewer objects than that |
| The ladder object gets 5,000 reports in a minute | medium on a big night | end cards show the room's own rating change at once; the ladder's word comes a little later | The end card never waits on the ladder (`est`); a report is one indexed read, two upserts, one insert; the top 50 is cached 30 s; a failed report is retried by the room's alarm, 20 times, then "the ladder is busy" |
| A player's phone goes to sleep for a minute | certain, often | "You were away for more than 90 seconds" if too long; else back where they were, their call auto-made if its clock ran out | 90 s grace, the auto-call keeps the match moving, the opponent sees "<name> reconnecting… n s until a forfeit" |
| Two players on one Wi-Fi farm the ladder | low | they pair only after 45 s with nobody else around, and the match is unrated ("same network") | the network hash (an IPv6 /64) never leaves the room; the same two players rated 3 times a day at most |
| Someone games the play clock (never sends ready) | low | nothing: the decision's last moment rules (45 s after the snap) | the room's alarm plays the coach's call |
| A browser without `navigator.vibrate` / background timers throttled | certain on iOS | no buzz; the clock catches up on return | the room's clock is the truth; the title flashes; the auto-call covers it |
| A campus or office behind one address | low | "Versus is busy" for everyone there after 120 joins a minute | raise `VS_JOIN_MAX` in the dashboard; the limit resets each minute |
| Durable Objects billing on the free plan | medium | nothing visible until the daily limit, then rooms refuse | 10,000 players a day is roughly 600k DO requests: inside the free plan's 100k/day? No: the free plan allows 100k requests a day and would cut off. Be on the Workers Paid plan ($5/month) before launch |
| A match's two phones disagree on what they saw | very low | one phone's animation differs | the room's result is the only truth; both animate the room's log; the drawing stays local (CLAUDE.md); vs_stress replays every match |
| A seed leak | very low | a phone could preview a call's outcome | no message carries a seed (match_test, vs_stress, vs_load check every message) |
| The share image fails (canvas, Safari) | low | the text share instead | `vsShareImage` falls back to `shareText` |

## The load test

`.github/workflows/vs_load.yml` (Actions → Versus load test → Run workflow). With no `url` it deploys a throwaway worker
from the branch (its own objects, the per-address limits and the network check off), loads it from `runners` × `players`
fake players (names `zz-loadtest-N`, keys `loadtest-…`) ramping in over `ramp` seconds, plays every match out at a
human pace, adds the runners up (board/vs_load_sum.mjs: p50/p95/p99 pair time, call round trip, the two phones' skew,
errors, Cloudflare close codes) and deletes the worker. One runner by hand:

```bash
node board/vs_load.mjs --url https://<worker>.workers.dev --players 300 --ramp 60 --mode mix --game mix --json out.json
```

Never point it at the real board: its players would be paired with real ones.
