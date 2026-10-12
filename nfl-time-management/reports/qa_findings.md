# nflclock QA findings: pre-game pass for BUF at LA (2026_05_BUF_LA)

Independent QA, 12 Oct 2026, about 75 minutes. The setup followed CLAUDE.md (build, sync, export).

- `pytest`: 19/19 passed before the fixes and 22/22 after (3 new tests in `tests/test_console.py`).
- Parity: `parity_expected.py 8000` and `parity_test.js 8000` printed ALL PARITY CHECKS PASSED. `sim.py` and
  `engine.js` were not changed.
- Browser: I tested `live.html` wrapped in a doctype in headless Chromium at 390 px, using the quick-entry box,
  the scoreboard buttons, clock entry, OT, PAT, kickoff, coach mode, backup QB, the kicker override, the
  history list and the game card. There were no JS errors and no horizontal overflow at 390 px. The only
  console error is a 404 for `/favicon.ico`, which the hosting's head handles. Every situation produced results.
- Stability: I ran the same running-clock spot 4 times at 6k sims. Hurry was always first (34.9 to 35.8%).
  The other options moved by up to 1.4 pts, which is Monte Carlo noise (SE about 0.6 per option).

Win probabilities below are for the team making the call. Lines use console/quick-entry syntax, with the
score and timeouts in away-home order.

---

## FIXED on this branch (`claude/nfl-qa-findings`)

### 1. CRITICAL: no field-goal option on 1st-3rd down in the final seconds, so the tool recommends a pass
`q4 0:03 22-24 ball BUF 2&5 LA10 to 0-0 stop`

- **Before:** BUF options were only `pass 18.2%` and `run 15.9%`, and the recommendation was **PASS**. The
  web page said the same, and its own header read "BUF 98.2% before the decision", which contradicts it.
- **Expected:** a 27-yard field goal to win, worth about 98%.
- Same bug:
  - `q4 0:04 21-24 ball BUF 1&10 LA25 to 0-0 stop`: recommended "pass 5.6%" instead of the tying 42-yard kick.
  - `q4 0:01 24-24 ball BUF 1&10 LA20 to 0-0 stop`: recommended "pass 52.3%".
  - `q2 0:03 10-7 ball BUF 2&5 LA25 to 0-0 stop`: recommended "pass 49.5%", while the "rest of the half" box
    showed 55.3%.
- **Cause:** the option list only offers `fg` on 4th down. Forcing `run` or `pass` also overrides the policy's
  last-play kick, because `kind[:] = PLAY_NAMES[forced]` in `sim.py`.
  - `src/nflclock/console.py:214` (`elif not st.running`)
  - `web/worker.js:54`
- **Fix:** offer `fg` on 1st-3rd down when 30 s or less is left in the half and the kick has at least a 2%
  chance. With the clock running, this is the fire-drill kick. I also mapped the family of an early-down `fg`
  to `play_select`, so the page doesn't quote a 4th-down coach share outside its domain.
- **After:** `field goal 98.3%` (+79.8 over pass) in the browser, and `fg` comes first in the console.
- **Not fixed:** `src/nflclock/decide.py:153-176` has the same gap. It feeds the `nflclock decide` CLI, not
  the live tools. Also fixing it in the grading path would change how decisions are graded, so I left it for
  the integrator.

### 2. HIGH: tied options are recommended in dict order, so a leading team is told to CALL TIMEOUT
`q4 1:10 27-24 ball BUF 1&10 LA40 to 3-1 run`

- **Before:** `call timeout now 100.0%` and `kneel 100.0%`, and the recommendation was **"BUF: CALL TIMEOUT
  NOW"**. LA, which cannot win, got **"LA: CALL TIMEOUT NOW"** at `0.0%` vs `0.0%`. The web page showed the
  same thing.
- More cases:
  - `q4 0:50 21-24 ball LA 1&10 own25 to 0-3 run`: "LA: CALL TIMEOUT NOW" while LA leads with BUF out of
    timeouts.
  - `q4 4:00 45-10 ball BUF 2&5 LA40 to 3-3 run`: "BUF: CALL TIMEOUT NOW" while up 35.
  - `q4 0:05 20-24 ball LA 1&10 own30 to 0-0 run`: "HURRY TO THE LINE".
  - `q4 0:15 20-20 ball LA 1&10 own20 to 2-2 run`: BUF defense "CALL TIMEOUT NOW" at 44.9% vs 44.9%.
- **Expected:** kneel, and "let the clock run" for the defense. An NFL staffer would read the headline as
  plainly wrong.
- **Cause:**
  - `console.py:237`: `best = max(vals, ...)` picks the first-inserted option, and "timeout" is inserted first.
  - `web/live.html:564`: `reduce(... >= ...)` behaves the same way.
- **Fix:** I added `pick_best` in `console.py` and `pickBest` in `live.html`.
  - Options within 0.05 WP points of the top count as a tie. That threshold is the same one the "best option"
    grade uses.
  - Ties go to the call that gives the opponent nothing: kneel, no timeout, milk, normal, … , spike, timeout.
  - The chosen option is always listed first.
  - A real edge still wins.
- **After:** "Kneel · +0.0 over call timeout now".

### 3. MEDIUM: console spots depend on token order (the README says "any order")
`q4 2:31 BUF 20 LA 24 LA41 ball BUF 2&7 to 2-3 run`, typed after an LA possession

- **Before:** the ball is put at **BUF 41** (59 to go). The same tokens in README order put it at LA 41.
- **Cause:** `console.py:123,127` resolves `LA41` / `at LA 41` against the possession *at that point in the
  line*.
- **Fix:** resolve the spot after the loop. That is what `live.html` `parseLine` already does. The last spot
  written still wins.

---

## OPEN: not fixed (need an engine/parity change or a design call)

### 4. MEDIUM: kneel-out check uses 38 s per gap, but simulated kneel runoff is 38-40 s
`q4 1:59 24-21 ball BUF 2&8 own35 to 3-0 run`

- **Actual:** `kneel 98.6%`. The expected value is 100%: two kneels at 1:59 against a defense with no
  timeouts end the game.
- Closer to 1:20, `q4 1:20 24-21 ball BUF 3&9 own34 to 3-0 run` gives `kneel 99.8%`.
- **Cause:**
  - `sim.py:184` (`kneel_out_possible`) assumes `38.0` s per running gap.
  - Kneel runoff is drawn as `38 + 2u` at `sim.py:409`.
  - A real offense takes about 40 s.
- **Effect:** on 3rd down with about 78.5-81.5 s left, the policy decides it cannot kneel out. It then runs
  a real play and takes the fumble risk. I traced one such rollout: a fumble at 1:18 gave LA a tying FG.
- The shortfall also pulls down every option whose rollouts pass through that window.
- **Suggested fix:** make the bound and the runoff agree. Either use 39-40 s in both, or use the mean (39) in
  the bound. Mirror the change in `engine.js:389/580` and re-run parity.

### 5. MEDIUM: overtime (q5/ot) is simulated as a second regulation half
`q5 4:00 20-20 ball BUF 4&3 LA30 to 2-2 stop` gives `go 56.1%`, `FG 54.9%`, `punt 39.8%`.

- **Problems:**
  - When OT ends tied, the result is valued at `ot_wp_home`, as if another OT followed (`sim.py:750`). A
    regular-season OT tie should count about 0.5.
  - There is no sudden death after both teams have had the ball. A FG that wins on the spot is treated as a
    3-point lead with time left.
  - OT clock and timeouts work. Use `to 2-2`.
- In the web page, OT can only be entered by typing `ot` or `q5`. There is no OT quarter button. After
  `ot 10:00 …` none of Q1-Q4 is highlighted, and clicking one leaves OT.
- **Suggestion:** for tonight, treat OT outputs as rough. Either add an OT flag (sudden death after the first
  two possessions, tie = 0.5) or show a warning.

### 6. MEDIUM: shipped web game file has no `gamecard`; setup overwrites the committed file
- **The game card is never shown.** The committed `web/2026_05_BUF_LA.json` has no `gamecard` key, so the
  "Pregame game card" card stays `hidden`. I built a 500-sim card into a scratch copy. It renders correctly at
  390 px: the table scrolls inside `.cardgrid` (441 px), and the page itself doesn't overflow. To ship it,
  run `gamecard.build(...)` (n=1500 takes about 10+ min on 4 cores), then `export_game`.
- **Setup drops data from the committed file.** Running `export_game` per CLAUDE.md overwrites the committed
  file without `grade_scale`, `tendency_web` and `coach_profiles`, because those come from the 1.5 h pipeline.
  That removes letter grades, "NFL coaches choose this %", and coach mode. Anyone who re-syncs and commits the
  file before kickoff would ship a degraded page.
  - I restored the committed file and did not commit it.
  - **Suggestion:** have `export_game` keep keys already present in the existing file.

### 7. LOW-MEDIUM: stale results under a new situation header (web)
`q4 2:31 BUF 20 LA 24 xyz`

- The board and the "Recommendation" summary update to Q4 2:31. The status says "Did not understand: xyz".
  The results below are still those of the previous situation (0:40, 4th & 25).
- The same happens after any manual button or clock edit, because `render()` rewrites `#sit-text` from live
  state (`live.html:325`) but leaves `#results` alone.
- On a sideline this can be misread.
- **Suggestion:** grey out `#results` or add "not simulated yet" whenever the state differs from
  `job.snapshot`.

### 8. LOW-MEDIUM: "LA 41" with a space silently becomes a score
`ball BUF 2&7 LA 41` sets **LA's score to 41** in both parsers. The spot is left unchanged and no warning is
shown.

- This is documented: spots are `LA41` or `at LA 41`. But it is an easy typo under pressure.
- **Suggestion:** warn when a score changes by more than 8 in one line, or when a `TEAM n` pair follows a
  down&distance.

### 9. LOW: possibly over-aggressive 4th-down calls (worth a look, not clearly wrong)
At 8k sims:

| Situation | Result |
|---|---|
| `q2 10:00 20-20 ball BUF 4&5 own20 to 3-3 stop` | go 35.2 vs punt 33.6 (+1.7 ± 0.3; converts 51%) |
| `q4 6:00 20-23 ball BUF 4&7 own40 to 3-3 stop` | go 30.5 vs punt 26.8 (+3.7 ± 0.7) |

Public 4th-down models usually punt at own 20 on 4th & 5 in the 2nd quarter. Check the conversion tables for
elite offenses: BUF pass O is +0.115.

### 10. INFO: checked and looked sound
| Situation | Result |
|---|---|
| 4th & goal at 1, 0:30, down 4 | go 52.9 / FG 4.0 |
| Same, down 1 | FG 76.7 / go 59.3 |
| 4th & 25 own 30, 3:00, down 4 | punt / go within noise |
| Down 1, 4th & 8 at LA35, 0:40 | **FG** 52.2, punt 0.0 (no punt-from-35 bug) |
| Leads +1/+2/+3, 4th & 2 at LA35, 1:50 | go (74 / 75 / 81) |
| +7 / +8, same spot | FG (two-score lead) |
| +9, same spot | all within 0.1 |
| Leading defense, `q4 1:30 BUF 20 LA 24 ball BUF … run` | LA "let the clock run" |
| Two-minute warning, 2:01 vs 1:59 (up 3, LA 0 TO) | kneel −3.2 at 2:01 (cannot kneel out), kneel best at 1:59 |
| PAT, down 1 after TD with 2:00 | kick/two within noise, labelled "close call" |
| Kickoff, down 3 at 1:55 | deep/onside within noise |
| Ball at own 1, up 4, 1:00 | milk; LA timeout +17.5 (correct) |
| Ball at opp 1, down 4, 1:00, 0 TO | milk 79.3, hurry 75.6, spike 63.8 |
| `q4 0:40 20-20 ball BUF 1&10 own25 to 0-0 run`, tied with 0 timeouts | hurry |
| `q2 0:30` attack-or-run-out cases | sensible |

The opp-1 milk result is plausible: it drains time before a likely TD. It is a judgment call.

Web-only checks that passed:
- Backup QB toggles and undoes cleanly. BUF pass O goes +0.115 → −0.037 → +0.115.
- The kicker override feeds the sim. With K −0.5, the 47-yard FG dropped to 29.8% WP.
- "Typical coach" mode works.
- History lists up to 12 situations and clicking one restores the board.
- The hurry-vs-spike break-even pairing is valid in JS, because uniforms are hashed per rollout and don't
  depend on n.
