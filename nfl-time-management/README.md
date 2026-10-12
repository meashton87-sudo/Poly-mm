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

RESULTS_VALIDATION

## What the 2023–2025 grading found

RESULTS_SUMMARY

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

`web/game.html` is a Wordle-style daily game built on the same engine. Every day it serves three real
late-game spots from 2023-26 (a two-minute drill, protecting a lead, a tied game or the end of a half),
and the player calls every play for one team until the game ends: tempo, timeouts, spikes, kneels,
field goals, punts, two-point tries and onside kicks, plus 23 play calls:

* runs: outside, off-tackle and inside, each to the strong or weak side; up the middle; QB sneak; QB
  designed run; RPO
* passes: quick and deep to the strong side, weak side or middle; screen; play-action short and deep;
  rollouts to either side; trick plays; the Hail Mary (as a half runs out)
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

Every call shows both teams' league percentile on that play, and every decision is graded in win
probability against all the alternatives and against what a typical NFL play-caller does there. The
day's score is a percentile against NFL play-callers in the same three spots.

```bash
python -c "from nflclock import dailygame as G; print(G.build())"   # writes web/playbook.json and web/scenarios.json
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

```
EXAMPLE_DECIDE
```

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

## Limitations

* Play calling inside a play type is modelled only where the data are clear (clock-stopping throws with
  no timeouts late). Otherwise "pass" means the situational pass distribution, not a specific concept.
* Penalties are sampled from real penalty plays. The 10-second runoff and untimed downs after defensive
  fouls are not modelled.
* Overtime is valued as a strength-adjusted coin flip rather than simulated.
* A "mistake" can reflect information the model lacks, such as an injured kicker, a specific scheme
  or weather inside the stadium. Team-games with an emergency kicker are excluded automatically.
* Rollout policy is a strong heuristic, not a solved game; the opponent does not adapt beyond it.
