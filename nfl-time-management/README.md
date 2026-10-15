# nflclock: a simulation engine for NFL clock and game management

`nflclock` answers the question a head coach and a game-management coordinator face on every late-game snap:
**which option wins the most games from here?** It covers timeouts, tempo, spikes, kneels, end-of-half
attack-or-kneel, late 4th downs, onside kicks and two-point tries. It then grades every one of those decisions
from the 2023, 2024 and 2025 seasons, all 855 games including playoffs.

It is built from public nflverse play-by-play (2016–2026) and it accounts for:

| Variable | How it enters |
|---|---|
| Home vs. away | WP-model feature; home-field term in the team-rating regression |
| Strong / weak **pass offense**, **run offense** | Opponent-adjusted EPA/play (ridge regression), as of the week of the game |
| Strong / weak **pass defense**, **run defense** | Same regression, defensive side |
| Pass-happy vs. run-heavy tendency | Pass rate over expected (neutral situations) shifts the run/pass mix |
| **Kicker** quality | Empirical-Bayes make-probability shift on a FG model (distance, wind, temperature, roof, era) |
| **Punter** quality | Shrunken net-yards-over-expected by field position |
| Market strength | Closing spread (WP model and halftime/OT value) |
| Weather | Wind, temperature and roof in the kicking model |
| Clock state | Game clock, play clock usage, timeouts each side, two-minute warning, OOB rules, quarter ends |
| Situation | Score, down, distance, field position, possession, who gets the 2nd-half kickoff |
| Rule era | 2024–25 kickoff outcomes (touchback to the 35), recent onside recovery rates |

All ratings are **as-of**: a decision in Week 10 is judged only with data a staff had before Week 10.

## How it works

```
nflverse PBP ──► clock model (play durations, tempo runoff by situation)
            ├──► play library (224k plays, 271 situation pools)  ──► exponential tilting by matchup EPA
            ├──► team / kicker / punter ratings (as-of, shrunk)
            ├──► win-probability model (LightGBM, monotone)       ──► halftime value, 4th-down look-ahead
            └──► special teams (FG make, punt net, kickoffs, onside, PAT/2pt)
                                   │
                    vectorised Monte-Carlo game simulator (explicit NFL clock rules)
                                   │
         decision engine: force each option on the first snap, play the rest out with a
         competent policy for both teams, compare win probability under common random numbers
```

* **Simulator** (`sim.py`): thousands of rollouts advance in lock-step as numpy arrays. Clock rules are
  modelled explicitly. The clock stops on incompletions, scores, changes of possession, timeouts, the
  two-minute warning and quarter ends. Out-of-bounds stops it only inside 2:00 of the first half and 5:00 of
  the second. Runoff between snaps is drawn from measured tempo distributions (medians): no-huddle
  two-minute drill ~15.6 s, hurry-up ~17 s, normal ~34 s, milking the play clock ~38 s, spike ~8.4 s,
  rushing the field-goal unit on 7–12 s. A half can end on a play (the untimed PAT still happens) or
  between snaps (kneel-outs).
* **Matchups**: each play is drawn from real plays in the same situation pool, reweighted by
  `w ∝ exp(θ·EPA)` with θ solved so the pool's mean EPA moves by the offense-vs-defense gap. This is the
  minimum-KL change that hits the target, so a strong pass offense against a weak pass defense keeps the
  real shape of outcomes (sacks, explosives, interceptions) while playing to its level.
* **Policy**: in every rollout both teams play situationally sound football. They use timeouts when
  trailing, milk the clock when leading, spike with no timeouts, kneel when the game can be iced, rush the
  field-goal unit on with the clock running, and kick before time runs out. A leading offense with
  seconds left plays the snap out to zero. Fourth downs use a WP-model look-ahead, except that late in a
  tied game a team out of field-goal range punts and plays for overtime. The decision being evaluated is
  forced on the first snap, and everything after it follows that policy.
* **Kick-to-win endgame**: down 1–2 or tied with a 50%+ field goal in hand, a timeout to spare and under
  3:00 left, the offense runs the clock down with clock-killing plays, keeps its timeouts, and with 45
  seconds or less on a running clock lets it run to 0:03, calls timeout and kicks. The defense spends its
  timeouts to save time for a reply (worth 5–16 win-probability points from 0:50–1:50 in the simulator).
  An offense without a timeout keeps hurrying and spikes for the kick instead.
* **Clock-aware play calls**: with no timeouts and the clock needing to stop, real offenses complete
  passes in bounds 47% less often in the final 20 seconds (21% less at 20–35 s) and pass 95% of the time
  (2020–25 data). The simulator redraws that share of in-bounds gains from the same pool's incompletions
  and catches out of bounds, and shifts the run/pass mix to match.
* **Variance control**: common random numbers and Latin-hypercube uniforms. Grading is cross-fitted, so the
  recommended option is chosen on one seed set and its edge is measured on an independent one, which
  removes the "max of noisy estimates" bias.

## What gets graded

Every decision is rebuilt from play-by-play at the moment it was made. All legal options are simulated
from that state, and the actual choice is compared with the best one.

| Family | Situation | Options compared |
|---|---|---|
| Defensive timeouts | Clock running after an in-bounds play; defense trailing or tied in the final 5:00, or any score in the final 2:00 of the 1st half | Timeout now vs. let it run |
| Offense stopping the clock | Clock running; offense trailing or tied in the final 2:00, or driving in the final 1:00 of the 1st half | Timeout vs. spike vs. hurry to the line |
| Leading offense tempo | Leading in the final 5:00 and snapped with ≥ 10 s on the play clock | As snapped vs. milking to ~3 s |
| Kneel-downs | Leading in the final 2:40 and the game can be iced with kneels | Kneel vs. run a play |
| End of 1st half | Ball in own territory with 0:20–2:00 left | Attack vs. run out the half |
| Late 4th downs | Final 10:00 of the game or final 2:00 of the half, within 16 points | Go vs. field goal vs. punt |
| Onside kicks | Trailing kicking team in the final 7:00 | Onside vs. deep |
| Late PATs | 4th quarter | Kick vs. go for two |
| Clock-critical run/pass | Final 5:00, non-tied, downs 1–3 | Run vs. pass |

An offense's clock options hold the defense to what it did at that whistle (no timeout); the defense's
timeout decisions are graded separately.

When an offense hurried or spiked, the option it chose is played at the pace it actually achieved (the
seconds from the whistle to its next snap), because hurry versus spike turns on that pace: about 10
seconds is the break-even in a typical no-timeout finish. The alternatives use league pace.

"Expected wins lost" is the summed, cross-fitted win-probability gap between the chosen and the best
option. A "clear mistake" is a choice that loses by more than 2 standard errors and more than 0.5 WP
points. Decisions by a team playing without a healthy kicker are excluded.

## Validation (out of sample, 2023–2025)

Run `python scripts/validate_sim.py`. Results live in `reports/validation_*.{csv,json}`.

<!-- RESULTS_VALIDATION:start -->
Late-game win probability on real 4th-quarter snaps (final 10:00, one-score games), 2023–2025:

| Model | Log loss | Brier | Calibration error | Snaps |
|---|---:|---:|---:|---:|
| nflclock simulator | 0.2832 | 0.0907 | 0.015 | 2,997 |
| nflclock WP model | 0.2802 | 0.0903 | 0.016 | 2,997 |
| nflfastR (public) | 0.2846 | 0.0918 | 0.019 | 2,997 |

Drive replay: real drives restarted in the simulator from their first snap.

| Drives | Count | TD real | TD sim | FG real | FG sim | Plays real | Plays sim |
|---|---:|---:|---:|---:|---:|---:|---:|
| End of 1st half | 1,000 | 11.6% | 10.2% | 21.7% | 21.7% | 5.3 | 4.8 |
| Trailing, final 5:00 | 498 | 20.3% | 18.4% | 14.9% | 13.0% | 6.6 | 6.1 |
| leading_4q_final6 | 536 | 4.9% | 6.2% | 6.5% | 8.5% | 4.3 | 4.4 |

**True holdout, 2026 season** (every model was fit through 2025):

| Model | Log loss | Brier | Snaps |
|---|---:|---:|---:|
| nflclock simulator | 0.2780 | 0.0908 | 1,482 |
| nflclock WP model | 0.2894 | 0.0933 | 1,482 |
| nflfastR (public) | 0.2806 | 0.0907 | 1,482 |

**Calibrated on what coaches chose.** The simulator's win probability for the option a coach actually took, against how often that team won (2023–2025). A bias against punting, spiking or kicking would show up as teams winning more often than predicted.

| Decision: option chosen | Decisions | Predicted | Actual | z |
|---|---:|---:|---:|---:|
| Defensive timeouts (trailing late / before half): let clock run | 2,815 | 38.8% | 37.9% | -1.2 |
| Defensive timeouts (trailing late / before half): timeout | 1,492 | 25.7% | 25.9% | +0.3 |
| Late 4th downs: go / FG / punt: punt | 1,139 | 53.7% | 54.1% | +0.3 |
| Late 4th downs: go / FG / punt: field goal | 803 | 57.6% | 57.4% | -0.1 |
| Late 4th downs: go / FG / punt: go for it | 685 | 28.8% | 27.6% | -0.9 |
| End of 1st half: attack vs. run it out: attack | 964 | 48.2% | 49.4% | +1.0 |
| End of 1st half: attack vs. run it out: run out the half | 82 | 50.0% | 48.8% | -0.3 |
| Offense stopping the clock (timeout / spike / hurry): hurry to the line | 924 | 40.2% | 39.9% | -0.2 |
| Offense stopping the clock (timeout / spike / hurry): timeout | 877 | 49.6% | 52.1% | +1.9 |
| Offense stopping the clock (timeout / spike / hurry): spike | 201 | 40.4% | 41.8% | +0.5 |
| Onside vs. deep kick (trailing late): deep kick | 161 | 11.7% | 10.6% | -0.5 |
| Onside vs. deep kick (trailing late): onside kick | 113 | 1.2% | 0.9% | -0.3 |
| Late PAT: kick vs. two: kick PAT | 717 | 59.0% | 57.3% | -1.3 |
| Late PAT: kick vs. two: go for two | 205 | 40.8% | 43.9% | +1.3 |
| Clock-critical run vs. pass: pass | 4,499 | 29.4% | 29.6% | +0.5 |
| Clock-critical run vs. pass: run | 2,069 | 74.9% | 73.1% | -2.5 |
<!-- RESULTS_VALIDATION:end -->

## What the 2023–2025 grading found

<!-- RESULTS_SUMMARY:start -->
- **18,134 decisions graded** across 855 games (2023-2025, regular season + playoffs); 11,545 are clock / game-management decisions, the rest clock-critical run-vs-pass calls.
- Coaches picked the simulator's best option **71%** of the time on clock decisions; **605** choices were clear mistakes (edge > 2 SE and > 0.5% WP).
- Clock and game-management choices cost the league **19.1 expected wins** over three seasons (~0.20 per team-season).

| Decision | Graded | Agree w/ model | Clear mistakes | Exp. wins lost | Most common mistake |
|---|---:|---:|---:|---:|---|
| Late 4th downs: go / FG / punt | 2,628 | 73% | 245 | 12.01 | punt instead of go for it |
| Offense stopping the clock (timeout / spike / hurry) | 2,006 | 68% | 118 | 2.95 | timeout instead of hurry to the line |
| Defensive timeouts (trailing late / before half) | 4,310 | 68% | 116 | 1.47 | timeout instead of let clock run |
| End of 1st half: attack vs. run it out | 1,047 | 82% | 84 | 1.30 | attack instead of run out the half |
| Late PAT: kick vs. two | 926 | 66% | 23 | 1.20 | kick PAT instead of go for two |
| Clock-critical run vs. pass | 6,589 | 64% | 72 | 0.69 | pass instead of run |
| Leading offense burning play clock | 33 | 12% | 16 | 0.49 | snapped early instead of milk play clock |
| Kneel-down when the game can be iced | 321 | 99% | 3 | 0.07 | run a play instead of kneel |
| Onside vs. deep kick (trailing late) | 274 | 77% | 0 | -0.37 | — |

Costliest clear mistakes (each re-simulated with fresh seeds and 4,000 games per option):

| Game | Coach | Situation | Chose | Better | Cost (WP pts) | Confirmed |
|---|---|---|---|---|---:|---|
| 2024 wk 10: ATL vs NO | Raheem Morris | Q4 0:07, down 3, 4&4 at opp 43 | go for it | field goal | 23.1 | yes |
| 2023 wk 7: ATL vs TB | Arthur Smith | Q4 2:42, up 3, 4&1 at own 24 | punt | go for it | 15.0 | yes |
| 2023 wk 1: KC vs DET | Andy Reid | Q4 5:16, down 1, 4&4 at own 31 | punt | go for it | 14.2 | yes |
| 2024 wk 18: BUF vs NE | Sean McDermott | Q4 3:26, down 4, 4&7 at own 18 | punt | go for it | 13.5 | yes |
| 2024 wk 18: GB vs CHI | Matt LaFleur | Q4 0:59, down 2, 4&4 at opp 37 | timeout | hurry to the line | 13.3 | yes |
| 2024 wk 17: CHI vs SEA | Matt Eberflus | Q4 0:20, down 3, 4&10 at opp 40 | go for it | field goal | 12.4 | yes |
| 2023 wk 18: SEA vs ARI | Pete Carroll | Q4 1:54, down 1 | go for two | kick PAT | 12.0 | yes |
| 2025 wk 17: CHI vs SF | Ben Johnson | Q4 0:04, down 4, 2&2 at opp 2 | pass | run | 11.7 | yes |

Worst calls of 2026 week 5 (full cards in `reports/worst_decisions_2026_wk05.md`):

- **JAX** (Liam Coen), PHI at JAX: Q4 1:52, up 2, 3&8 at own 25. Chose run, better pass: F, +8.6 WP points (confirmed).
- **SEA** (Mike Macdonald), SF at SEA: Q4 6:59, down 3, 4&10 at opp 22. Chose field goal, better go for it: D, +6.6 WP points.
- **JAX** (Liam Coen), PHI at JAX: Q4 1:46, up 2, 4&2 at own 31. Chose punt, better go for it: D, +6.6 WP points (confirmed).
- **DEN** (Sean Payton), DEN at LAC: Q4 5:10, tied, 4&1 at opp 1. Chose field goal, better go for it: D, +6.0 WP points (confirmed).
- **SF** (Kyle Shanahan), SF at SEA: Q4 2:00, tied, 4&2 at opp 25. Chose field goal, better go for it: D, +4.8 WP points (confirmed).
- **NYJ** (Aaron Glenn), CLE at NYJ: Q4 1:54, up 5, 3&6 at own 28. Chose run, better pass: F, +4.6 WP points.

Tonight's head coaches:

- **Sean McDermott**: 4th-down aggressiveness 96% percentile, clock management 83% percentile.
- **Sean McVay**: 4th-down aggressiveness 45% percentile, clock management 10% percentile.

Playbook findings from the simulator (league-average teams; full charts in the report):

- **Ahead by 1 on defense, opponent lined up for a 42-yard try with 1:00 left:** letting the clock run wins 12% of the time; spending timeouts after each play so you get the ball back wins 32%.
- **Down 3 on defense with three timeouts:** calling one right after a 1st-down run is worth +1.6 win-probability points at 2:30 (largest in the chart).
- **Two-point tries at 3:00:** down 2 after the touchdown, going for two is worth +8.2 points; up 1, +6.4.
<!-- RESULTS_SUMMARY:end -->

Full tables are in `reports/`: `decision_families.csv`, `team_seasons.csv`, `coaches.csv`,
`costliest_decisions.csv`, `all_graded_decisions.csv.gz`, `team_variable_sensitivity.csv` and
`decision_charts.json`.

## Live games

### 1. Sync rosters for the next games

```bash
nflclock sync                          # all of the next unplayed week
nflclock sync --games 2026_05_BUF_LA   # one game
```

`sync` refreshes the season's play-by-play, schedule, **daily depth-chart snapshots**, injury reports
and weekly rosters, and rebuilds every rating with the latest games. For each team it picks the current
**starting QB, kicker and punter**, skipping anyone ruled Out or Doubtful, and rates each one: QB
opponent-adjusted EPA per dropback, kicker make-probability shift, punter net yards over expected. It then
adjusts the team's pass offense when a different QB starts than the ones whose plays built the rating.
Small, transparent adjustments are applied for other starters ruled out, and everything is written to
`artifacts/live/<game_id>.json`.

### 2. Type situations during the game

```bash
nflclock live 2026_05_BUF_LA
nflclock> r2h LA                                   # who gets the 2nd-half kickoff
nflclock> q4 2:31 BUF 20 LA 24 ball BUF 2&7 LA41 to 2-3 run
nflclock> q4 1:12 24-27 ball BUF 4&3 LA38 to 0-1 stop
nflclock> q4 5:02 24-21 try BUF                    # PAT decision
nflclock> coach LA coach                           # play LA's future 4th downs like McVay
nflclock> qb BUF backup                            # in-game QB change
```

Scoreboard order is always AWAY then HOME. For every situation the console simulates every option for
the team with the ball, and the timeout decision for the defense when the clock is running. Each option
shows its win probability, its edge over the best option ± standard error, a **percentile grade** and
**how often NFL coaches make that call**. On 4th down it also prints the conversion chance and the
field-goal make chance from that spot. When the offense could either spike or hurry, it prints the
**break-even snap time**: "hurrying wins only if the next snap comes within 10 s of the whistle".

### 3. Or use the browser version on a phone

`web/live.html` runs the same simulator in the browser. `web/engine.js` is a line-for-line JavaScript
port that runs in a Web Worker, so no Python is needed during the game. `web/parity_test.js` proves the two
engines agree: the win-probability trees, field-goal model, matchup tilts and conversion tables match to
1e-9, and every full-game simulation scenario matches within Monte Carlo error.

```bash
python -c "from nflclock import webexport as w; w.export_engine(); w.export_game('2026_05_BUF_LA')"
node web/parity_test.js
```

### 4. Two-Minute Drill: the daily play-calling game

`web/game.html` is a Wordle-style daily game built on the same engine. Every day it serves one real
late-game drive from 2023-26, the kind rotating day to day (a two-minute drill, protecting a lead, a tied
game or the end of a half; the schedule holds three spots a day and the page plays the day's kind; it is
frozen in `src/nflclock/daily_schedule.json`, so a new week of games never moves a day's drive),
and the player calls every play for one team until the game ends: tempo, timeouts, spikes, kneels,
field goals, punts, two-point tries and onside kicks, plus 26 play calls:

* runs: outside, off-tackle and inside, each to the strong or weak side; up the middle; QB sneak; QB
  designed run; RPO
* passes: quick and deep to the strong side, weak side or middle; screen; play-action short and deep;
  rollouts to either side; the Hail Mary (as a half runs out)
* trick plays, each from its own real plays: the flea-flicker (a charted trick play the quarterback throws 15+
  yards: 80 plays), the end-around (any handoff to a wide receiver: 1,849), the receiver pass (thrown by a back or
  receiver: 163) and the direct snap (wildcat: 446). FTN's trick-play flag alone also marks ordinary throws, so it
  only picks the flea-flickers. Each has its own matchup (a loaded box bites on the flea-flicker and the receiver
  pass, a blitz gets home before the slow throw; the end-around beats a blitz flowing to the run) and its own
  animation (the pitch back, the toss to the receiver who throws, the fake one way, the snap straight to the back)
* a **Get out of bounds** toggle on any call, which raises the odds of stopping the clock by what NFL
  ball carriers actually achieve when they need it (it never guarantees it)

Each outcome is a real NFL snap of that call from 2022-26 (160,000 labeled from nflverse play-by-play and
FTN charting), matched on down, distance, field position and game situation, and tilted toward these
two teams' offense and defense on that call. Whatever happened on that snap happens to you: sacks,
strip-sacks, interceptions and pick-sixes, fumbles, bad snaps, drops, throwaways, scrambles, flags by
name, and runners who can't get out of bounds. Strong side is the wide side of the field and weak side
the short side, from the hash the ball starts on (public charting does not record where the tight end
lines up). Because calls are labeled by where the ball went, a covered deep shot is recorded as a
checkdown or a sack, which flatters deep calls; each call's edge over a same-kind play in the same
situation is halved to correct for it.

Each spot opens on a scenario card (score, clock, down and distance, timeouts, whose call it is);
**Next** opens the whole field top to bottom, their end zone at the top of the phone and yours at the
bottom, with all 22 players as dots from red (worse) to green (better). There are no numbers on the
field: **Player ratings** (or a tap on any dot) shows each player's overall rating (our own, 40 to 99;
see below), how much better he was than the league at his position that week, his stat line and his type (a mobile
or pocket quarterback, a blocking, possession or vertical-threat tight end, a power, elusive or receiving
back, and so on), each type assigned by a rule on the stat that defines it (`archetypes.py`).
Play-calling is a pop-up of **Run**, **Pass** and **RPO**. A run or RPO is then the play and its side; a pass is
drawn on the field: every receiver (the wide receivers, the tight end and the back) shows a route, you tap one to
change his route with a tap on the field (any receiver, as often as you like, the page staying put), then pick who gets the ball (wide receivers: slant, hitch, quick out, dig, post, corner, go,
screen; tight ends: flat, hitch, out, crosser, dig, seam; backs: flat, angle, screen, wheel), with play action or a
rollout. The snap is a real play where a receiver at that position ran that route against the look the defense
showed (NGS and FTN charting give the target's route on 75,000 passes): from the situation's plays, then coarser
situations, then that kind of pass in any situation, so the route, the position and the look always match; the
animation runs your receiver on your route and the others on the routes you saw. A timeout,
spike, kneel, field goal or punt only appears when it matters. With the clock running you also pick the
**tempo**: no-huddle (about 16 s between snaps), huddle (about 34 s) or milk it (about 38 s), the engine's
measured gaps between snaps; the usual tempo for the spot is preselected, and the tempo is graded with
the timeout, spike and kneel options. In a kick-to-win spot, milking it stops running the clock while
there is still time to kick, as the engine's own end-game policy does (before, a "milk it" field goal
from 0:36 never got off three times in four).

Before each call the defense shows its **look**: a light box (six or fewer near the line) or a loaded
one (seven or more), with or without a blitz, as often as defenses show each in that spot. The snap is
then drawn from real plays of your call run against that look. When the exact situation has fewer than
15 such plays, the pool widens to coarser situations (down and field zone, then zone) until it has
them, so a blitz look matters even on rarer calls: 95% of reads change the draw, and 61-71% of blitz
reads (28-43% without the widening).

**Matchups** (`engine.js` `MATCH`) make the call against the defense's call decide more than the real gaps would
(a run into a loaded box is worth about 0.05 points less than into a light box in real plays: too small to feel). A
blitz beats deep shots and loses to quick passes, screens and RPOs; a loaded box beats runs and loses to play
action, deep shots and RPOs; playing soft stops deep shots and gives up runs. The play is still a real one, but the
odds tilt toward better or worse real outcomes by a fifth of the call's own spread of outcomes (`MATCH_SD`): an
inside run averages about 6 yards against a light box and under 3 into a loaded one (4.8 in real plays overall). When you call their
defense, the offense checks into calls that beat it, so a blitz against a quick-passing offense gets burned. The
result card says who won the matchup.

**Special teams on defense**: when the other team is about to kick (the game peeks at their snap with the same
seed the play will use), you get a field-goal or punt defense instead of the usual looks. Against a field goal: go
for the block (about a 4.5% block, a tenth of them returned for a touchdown, and a 2% roughing flag that gives them
15 yards and a first down, on an untimed down at the end of a half), stay home, or ice the kicker with a timeout.
Against a punt: set up the return (about 4 more yards a punt) or rush it (a 3.5% block, the same roughing risk).

After each snap the result box shows what the play did to your win chance (green when it helped); the call's grade
is a separate chip, so a touchdown on a call that was not the very best still shows as a touchdown. Grading values
every option 600 times, then the top three and your call again 3,000 times on fresh games: the best of many noisy
options valued on the games that picked it is lucky, and at 600 games alone 15% of the calls shown red were really
green or yellow (none are now, against a 12,000-game reference). The snap goes at once and the grading runs while the play
does (the snap jumps the worker queue): about 0.3 s from tap to snap with the CPU slowed to a phone's, down from 2.3 s.

**The defense adapts to you.** The looks it shows lean toward the ones that beat your recent calls (this game's, and
the day's or the survivor run's before it: the last 12, recent ones counting more), more so the more of your calls it
has seen: after six runs a loaded box shows 87% of the time in a spot where it shows 60%. A mix of calls keeps it
honest, and the read says what they are keying on once it is a real lean on a real habit.

**Passing extras.** Each receiver starts on a route that fits the spot (a fade, a slant and an out at the goal line;
sideline routes when trailing in the two-minute drill; quick throws on short yardage; a go, a dig and a post on long
yardage). His button shows his odds on that route from the very real plays the pick draws from (share caught, yards a
throw, interceptions when they matter), and the last route tap can be undone.

**The website** (nfl2mindrill.com). `scripts/site.py` wraps `web/game.html` in a full page (the phone viewport
and safe-area rules the claude.ai host otherwise adds; serve the built folder, never the bare `game.html`) with the
scripts, the data and a `version.json` (build time and commit, for an uptime check). `.github/workflows/site.yml`
rebuilds the data from nflverse, checks the game (smoke, motion and leaderboard tests) and builds the site on changes
to the game, every Tuesday after Monday Night Football, and on demand; it publishes to GitHub Pages only when the
repository variable `PAGES_DEPLOY` is `true`, so a site served from your own server never has Pages claiming the
same hostname. Its survivor leaderboard is a Cloudflare Worker in front of one Durable Object (`board/worker.js`,
deployed by `.github/workflows/board.yml`; nothing to create first): every player's best run posts itself under the
name they set, and only a better run replaces it. One object takes every post in turn, so runs posted together are
never lost and the per-IP limit holds everywhere. The first post under a name claims it for that device (a random
key the page keeps; the board stores only its hash), so nobody else can post under your name; scores themselves are
not verified. Names are cleaned and capped at 24 characters, only the site's origin may call it, and with an
`ADMIN_TOKEN` secret `DELETE /board?name=...` removes a row.

**Everyone today** (the website's daily stats, `board/worker.js` `/daily`). When you finish the day's drive,
your score and each spot's win chance post once (your first finish of the day counts; a replay changes nothing) and
the summary shows how you compare with everyone who played that day: the share of players you beat, the day's
scores in the same buckets as your own stats, each spot against the day's average, and the day's top ten named
players (a name is claimed the same way as on the survivor board). The day is the player's local date.

**Analytics events** (the website's Google tag only; `track()` in `game.js`), for deciding what to improve:
`drive_start` (mode, kind of spot, day), `play_call` (mode, family, call, routes changed, out of bounds),
`defense_call` (call), `daily_finish` (day, kind, score, better/worse/same than the real coach, snaps),
`survivor_game` (win/loss/tie, overtime, streak), `overtime`, `share` (daily or survivor; share sheet, copy or
select), `help_open` (auto: shown on a first visit), `sim_ready` (packed data or JSON, ms since load, ms a player
sat waiting on it), `drive_leave` (the page went to the background mid-drive: calls made, seconds in, still
loading), `stats_open`, `stats_page_link`, `replay`, `name_set`. Share opens the phone's share sheet
where there is one. In Google Analytics: Reports, Engagement, Events (custom fields need registering as custom
dimensions under Admin, Custom definitions, to show in reports).

**Packed data**: on the website the simulator's data ships as `engine_data.pack` and `playbook.pack`
(`scripts/site.py pack`: the same typed arrays as raw bytes, index arrays as differences, multi-byte arrays
byte-plane shuffled, gzipped; 3.7 MB instead of 5.6 MB gzipped JSON). `game.js` gunzips them with
DecompressionStream and `game_worker.js` unpacks them; without a pack (claude.ai, a local copy) or without
DecompressionStream it loads the JSON. The first snap shows the download's progress while it waits.

**The stats page** (`web/stats.html`, nfl2mindrill.com/stats; `board/worker.js` `/days`): players per day, today's
count and average, the all-time total, and any day up close (its score spread, the drive's average and the top
ten).

**Survivor leaderboard** (on claude.ai). The artifact's shared database keeps every player's best run (`board/<name>`). Everyone who
opens the page reads it; only the owner and editors write it, since visitors through a public link can only read
shared data. The owner's runs post themselves under the name set on the run summary, and the owner adds a friend's by
pasting the share text the friend sends (it carries their name). A run ends with the three costliest calls of the game
you lost. When they have the ball you **call the defense**: blitz, load the box
or play it soft (with a timeout first when it matters), and their play is drawn from real plays against
that look; or let the coordinator call the drive. Your **kickoffs** go to the returner (a real kick
into the landing zone: returned, short at the 40 or bounced in to the 20), through the end zone for a
touchback at their 35, or onside, which the 2025 rules allow only to a team that is behind.

Every snap is then run out on the field in real time: the
scoreboard clock ticks off the time before the snap, the camera zooms in like a broadcast, and the 22 move
the way NFL players move. Each player's motion (`web/motion.js`) is limited to the envelope player tracking
measures for his position: sprint speed (receivers and corners 9.6 yards a second, backs 9.5, safeties 9.3,
linebackers 8.6, tight ends 8.6, quarterbacks 7.8, defensive linemen 7.0, offensive linemen 6.3), how hard
he speeds up at each speed (a receiver about 8.1 - 0.73 x speed yards a second squared), how hard he brakes
and how sharply he can turn, so a receiver slows to 3 or 4 yards a second at the top of a 90-degree break
and nobody stops or turns on a dime. The constants come from every snap of the 2017 Big Data Bowl sample
game and 529 Next Gen Stats highlight plays (2017-2019), public samples
([Big Data Bowl](https://github.com/nfl-football-ops/Big-Data-Bowl),
[NGS highlights](https://github.com/asonty/ngs_highlights)); `scripts/motion_envelope.py` and
`scripts/motion_curves.py` regenerate them. The play itself follows its real play's Next Gen
Stats charting (2022-2025): the target runs the charted route (go, post, corner, out, deep out, dig, slant,
shallow cross, hitch, screen, flat, wheel or angle) to the depth of the real throw and is there when the
ball arrives, released at the real time to throw; the coverage plays the charted shell, man (each
receiver's defender holds his cushion, backpedals, then trails a beat behind) or zone (Cover 2, 3, 4, 6
landmarks, breaking on the ball once it is thrown); as many rush as did, the line gives ground on the
measured depth curves (pass blockers about 4 yards in 3 s), and a pressured passer has a rusher on him as
he throws. Backs reach the line about 2.5 s after the snap, as in tracking. After the catch or handoff the
ball carrier runs to daylight; the defender who can get to him first comes at a pursuit angle and meets
him a yard or two short of the spot, a second arrives just after, the rest chase, his teammates block,
and after the whistle everyone eases up. A go route is 20.5 yards deep 3.5 s after the snap (tracking:
19.4); `node web/motion_test.js` checks the envelope, the routes and the coverage. Punts, field goals and extra points shift into their formations
before the snap, and kickoffs line up the 2024 way (the kicking team at the receiving 40, nine in the
setup zone, two returners deep, nobody moving until the catch); special-teams units are drawn in team
colors. What happened is called out where it happened: broken tackle, tackled, out of bounds, sacked,
strip-sack, intercepted, pick-six, fumble, dropped, thrown away, flag, touchdown, first down, field goal
good or no good. Play-by-play does not chart broken tackles, so Pro Football Reference's per-game count
for a player is credited to his longest carries or catches of that game.

Every spot is a real late-game snap from a real game, 2023-2026 with the playoffs included (21 of the 738
spots: Wild Card, Divisional, Conference Championship and Super Bowl), and each one says which game: "2023 ·
Week 14 · Titans at Dolphins" or "2023 · Wild Card Round · Rams at Lions".

Built for NFL fans: after each snap its result stays on top of your next call (no extra tap; a "Next
play" button only before the other team's plays), and every spot ends **you vs the real coach**: the
game result in the fourth quarter, or the points the possession was worth before the half, against what
the real coach got. The day's summary and the share text carry your record against the real coaches
(W-L-T), and the share grid keeps each spot to one line (at most eight squares, longer drives grouped).

Real plays are pooled by situation, and a rare call's pool can span the field, so a play keeps only what
still fits where it is drawn: a touchdown if it covered at least 60% of the way, a safety only if the
loss reaches the end zone (in both engines: the 80-99 field zone used to turn a goal-line safety into
two points from the 20 on about 1 snap in 500). Snaps that are not offensive calls are left out of the
playbook: fakes and punter runs from punt or field-goal formation, intentional safeties (Philadelphia's
punter running 34 yards back into his end zone to burn the clock in 2025) and lateral chains. An engine
sweep over every spot, call and tempo (`node web/game_sweep.js`: about 290,000 snaps and 1,450 whole
games) checks the football on every step: the clock never runs up, scores move by 1, 2, 3, 6, 7 or 8,
no touchdown without the distance, no safety without the end zone, downs, distances and yard lines in
range. Nothing says which call is best until
after the snap; then every decision is graded in win probability against all the alternatives and
against what a typical NFL play-caller does there. Each spot and the day end with the head coach whose
late-game calls look most like yours ("You called this one like Nick Sirianni"), from 144 head
coaches' 1999-2026 fingerprints (Cowher, Dungy, Gruden, Holmgren, Shanahan and Schottenheimer through this year's
first-time coaches): passes, deep shots, fourth-down tries and two-point tries, each over what the league did in
the same spots in that coach's era (`coaches.py`; the 1999-2015 play-by-play is fetched for this alone). The day's score is a percentile against NFL play-callers
on the same drive, with a share grid of one square per snap. The simulated callers call like the league, each
sharpened by his own skill (an option's weight falls by e for each `tau` of win chance it gives up; tau drawn from
very sharp to loose, and 15% call by frequency alone), so scores spread from 0 to 100 and a typical player lands
near the middle (days 1-3 compared with frequency-only callers, and nearly everyone scored 90+; the morning of day 4,
with every caller equally sharp, half the players scored 0).

**Survivor** (the Survivor tab, or `game.html#survivor`) plays random real fourth quarters back to back from
the same pool: the 430 spots that start in the fourth quarter, so every one is played to the final gun. Win
and the next game is drawn (none twice in a run until all have been played); lose and the run is over. A tie
at the gun goes to a coin toss and an overtime you play, under the rules since 2025 (`engine.js` `_otAfter`, on
only when the starting state carries `ot`, so the clock-management engine and parity are untouched): 10 minutes
and two timeouts each (15 and three in the playoffs), both teams get the ball, then the next score wins; a safety
ends it, and a touchdown that wins it needs no try. A team that has to score on its possession goes for it on
fourth down rather than punt or kick a field goal that loses. A regular-season overtime can end tied, which keeps
the run alive without a win; the playoffs play another period from where the ball is. The sweep plays 369
overtimes and checks them against the rules. The run survives a reload, and the best run is kept.

Every spot is a real late-game drive from the last four seasons (2023-2026, playoffs included), and the
card names the game ("2024 Week 12, PHI at LA" or "2025 Divisional, HOU at KC"). The two teams are the ones
that played it (`history.py`): the 22 on the field are the players on that very snap (nflverse
participation data), and the unit not on the field then is the lineup from that team's nearest snap of the
game; for 2026, where participation is not published yet, it is the players who took the most snaps in that
game at each position. Each player's rating is his percentile at his position among the league as of the
week of the game (only games before it count), on the 40-99 scale, and the player card says so ("better
than 88% of NFL wide receivers at the time"); a lineman takes his line's rating, since public data does not
grade linemen one at a time. The simulator plays with that week's team pass and run ratings, the quarterback
who played (against the team's usual mix), the kicker and punter from that game and their ratings then,
each team's call ratings, the real head coach and the real point spread. 2023 Week 1 games take each team's
first 2023 rating, since the ratings start there. The build writes the teams in chunks (`web/spots/`), and
the page loads only the chunk for the day's drive.

For the live tools, today's teams (`current.py`) come from nflverse's weekly rosters (the NFL's own
transactions: trades, signings, releases), with injuries ignored so every team
plays its healthy lineup: the 22 are picked by each player's usual share of snaps in the weeks he was
healthy, his best depth-chart listing (ESPN) and his rating, in the personnel the team uses most. A
player who is out (on a reserve list, ruled out or doubtful, or inactive for the latest game) keeps his
role and listing from before he got hurt, and his rating counts for more, since his injury cut his role
short: PHI's Lane Johnson, inactive in October with nothing on the injury report, and DET's Kerby
Joseph, on reserve all season, both start. The five linemen each take a different slot they are listed
at, so a hurt starter and the man filling in for him are not both on the line. ESPN's id crosswalk now
and then points a listing at a namesake (DET's rookie right tackle Blake Miller at a Blake Miller from
the 2000s); such listings are matched by name on the team's roster. The build cross-checks every
starter against ESPN's depth charts (703 of 704 on ESPN's current chart for his team as of
October 12, 2026; all 704 listed since August).
Today's player ratings are our own (`overall.py`), on a 40 to 99 scale where the average starter at a position
is 77, one standard deviation better is 86, and the scale bends above 88 so the very best land between
93 and 99. Each rating blends two parts, both scored within the position group:

* **How he has played**, 2022 to 2026 with every game weighted by season (last season and this one count
  fully, 2024 0.4, 2023 0.15, 2022 0.05), each measure shrunk toward the league for small samples: EPA per
  play and completion over expected for quarterbacks; rush yards over expected, rushing EPA, scrimmage
  yards per game and receiving EPA for backs; yards per game, target and air-yards share (WOPR), EPA per
  target and yards after the catch over expected for receivers and tight ends; pressure rate, sacks,
  tackles for loss and hits for edge rushers and interior linemen (PFR charting and box scores); tackling,
  missed-tackle rate and coverage for linebackers and safeties; passer rating allowed, ball production
  and yards per target for corners. No public data grades linemen one at a time, so a lineman's play is
  his line's pressure rate allowed and yards before contact, and it counts for little.
* **How the league values him**: his contract as a share of the cap (OverTheCap), Pro Bowls and
  first-team All-Pros (fading a little past 34), his draft slot, and how much his team plays him.
  Quarterbacks lean more on honors, since a passer's numbers lean on his supporting cast.

Play counts for more the more he has played (up to 35% for linemen and 55-70% elsewhere), so a rookie
leans on his standing and a veteran on his play. As a check against an outside view, the 24 first-team
AP All-Pros for 2025 (the fullback aside) all rate 85 or better, 21 of them 90 or better, with a median
rank of 3rd at their position. The three below 90 are Matthew Stafford (86, 9th among quarterbacks: his
EPA per dropback this season is 13th after 3rd in 2025), Christian McCaffrey (87) and Kevin Byard (85).

```bash
python -c "from nflclock import overall as O; O.check()"   # best at each position, and where the 2025 All-Pros rate
```

```bash
python -c "from nflclock import dailygame as G; print(G.build())"   # writes web/playbook.json and web/game.json
node web/game_smoke.js
```

### Percentiles everywhere

* **Decision grades**: a decision's cost is ranked against every real NFL decision of the same type from
  2023–2025, for example "D · worse than 97% of NFL calls". Letters run A (under 0.25 WP points, or
  better than 80% of calls) through F (bottom 1%).
* **What coaches do**: logistic models of coaches' real choices, by situation, give "NFL coaches choose
  this 64%". They are shown only inside the situations each model was trained on.
* **Coach percentiles**: each head coach's 4th-down aggressiveness (go-for-it rate versus a typical coach
  in the same spots, shrunk for sample size) and clock-management quality are ranked against the league.
* **Coach behaviour inside the simulator**: either team's future 4th downs can be played *soundly* (WP
  look-ahead), like a *typical NFL coach*, or like *its actual coach*. The latter uses that coach's measured
  aggressiveness shift on the whole-game 4th-down tendency model, so the simulation plays the opponent
  you are actually facing.

## Use it

```bash
pip install -e .
nflclock build          # downloads nflverse data, fits every model (~1 min)
nflclock decide --qtr 4 --clock 2:31 --score 20-24 --ball us --down 2 --ytg 7 --yardline "opp 41" \
                --timeouts 2-3 --running --us KC --them BUF
```

Example output (ratings as of the latest available week):

<!-- EXAMPLE_DECIDE:start -->
```
Situation: Q4 2:31 | BUF 20 - 24 LA | ball: us | 2&7.0 at opp 41 | TO 2-3 | clock running
  BUF: pass off +0.110 rush off +0.066 | pass def -0.005 rush def +0.025 (EPA/play; defense + = worse) | K T.Bass (-0.02) P T.Doman (+0.0 yds)
  LA: pass off +0.090 rush off +0.032 | pass def -0.039 rush def -0.009
  ratings as of 2026 week 6; 4000 simulations per option

              option win_prob vs_best   se
 milk the play clock    36.0%    +0.0 ±0.0
        normal tempo    35.9%    -0.0 ±0.2
hurry-up (no huddle)    35.2%    -0.7 ±0.4
         timeout now    33.5%    -2.4 ±0.4
               spike    30.7%    -5.3 ±0.8

Recommendation: milk the play clock
```
<!-- EXAMPLE_DECIDE:end -->

The `decide` command has more options: `--ball them` to make a defensive call, `--phase pat` or
`--phase kickoff`, `--kicker-rating` and `--punter-rating` to override personnel, plus `--spread`, `--wind`,
`--temp`, `--indoor` and `--away`.

Full pipeline:

```bash
python scripts/build_models.py      # fit models -> artifacts/bundle.pkl
python scripts/validate_sim.py      # simulator vs. real outcomes
python scripts/run_analysis.py 600  # grade every 2023-25 decision (~45 min on 4 cores)
python scripts/make_report.py       # tables + charts in reports/
pytest                              # unit tests (clock rules, kneel-out math, invariants)
```

## Code map

| Module | What it does |
|---|---|
| `data.py` | Download / load nflverse PBP; link each snap to the next (clock deltas, timeouts between snaps) |
| `ratings.py` | As-of team EPA ratings (ridge), FG model + kicker ratings, punter ratings |
| `wp.py` | Win-probability model (LightGBM, monotone constraints), evaluation helpers |
| `library.py` | Play-outcome library, situation pools, exponential tilting, 4th-down conversion tables |
| `models.py` | Fits and persists the bundle (tempo distributions, punts, kickoffs, constants) |
| `sim.py` | Vectorised game simulator with NFL clock rules and the competent-coach policy |
| `context.py` | Builds per-game contexts (ratings, kicker, punter, weather, spread) |
| `analyze.py` | Extracts and grades every decision; neutral-team sensitivity |
| `decide.py`, `cli.py` | Live decision engine and command line |
| `charts.py`, `report.py` | Decision charts and report tables |
| `validate.py` | Out-of-sample calibration and drive replay |
| `backtest.py` | Current-season holdout, calibration of the chosen options against real results |
| `tendency.py` | Percentile grade scales, models of what coaches choose, coach aggressiveness and clock percentiles |
| `weekly.py` | Scenario cards for the worst decisions of a week |
| `live.py`, `console.py` | Roster/injury sync for upcoming games; the in-game terminal console |
| `gamecard.py` | Pre-game 4th-down and two-point cards for one matchup |
| `webexport.py`, `web/` | Data export and the browser engine (`engine.js`), worker pool, live page and parity test |
| `playbook.py` | The daily game's 24 play calls, labeled from play-by-play and FTN charting, and each team's call ratings |
| `players.py` | Player percentiles at every position (EPA, Next Gen Stats, PFR advanced stats), personnel allocation |
| `history.py` | The daily game's teams as they were in each real game: the 22 on the snap, ratings as of that week |
| `current.py` | Every team today: healthy lineups from weekly rosters and snaps, QB, kicker, punter, coach, power rating |
| `overall.py` | Our overall player ratings, 40 to 99: play over five seasons blended with contract, honors, draft slot and snaps; checked against the All-Pros |
| `archetypes.py` | Player types (mobile or pocket QB, blocking or vertical-threat TE, ...) from the stats |
| `coaches.py` | Head coaches' late-game fingerprints (pass, deep, fourth down, two-point) for "you coached like" |
| `dailygame.py`, `web/game.html` | Two-Minute Drill: spots, daily schedule, `web/game.json`, and the game page |

## Limitations

* Play calling inside a play type is modelled only where the data are clear (clock-stopping throws with
  no timeouts late). Otherwise "pass" means the situational pass distribution, not a specific concept.
* Penalties are sampled from real penalty plays. The 10-second runoff and untimed downs after defensive
  fouls are not modelled.
* Overtime is valued as a strength-adjusted coin flip rather than simulated (the daily game's survivor plays
  it out; the clock-management analysis does not).
* A "mistake" can reflect information the model lacks, such as an injured kicker, a specific scheme
  or weather inside the stadium. Team-games with an emergency kicker are excluded automatically.
* Rollout policy is a strong heuristic, not a solved game; the opponent does not adapt beyond it.
