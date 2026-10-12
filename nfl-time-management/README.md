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
  the second. Runoff between snaps is drawn from measured tempo distributions: two-minute urgency ~14 s,
  hurry ~19 s, normal ~33 s, milk ~38 s, spike ~8.5 s. A half can end on a play (the untimed PAT still
  happens) or between snaps (kneel-outs).
* **Matchups**: each play is drawn from real plays in the same situation pool, reweighted by
  `w ∝ exp(θ·EPA)` with θ solved so the pool's mean EPA moves by the offense-vs-defense gap. This is the
  minimum-KL change that hits the target, so a strong pass offense against a weak pass defense keeps the
  real shape of outcomes (sacks, explosives, interceptions) while playing to its level.
* **Policy**: in every rollout both teams play situationally sound football. They use timeouts when
  trailing, milk the clock when leading, spike with no timeouts, kneel when the game can be iced, and kick
  the field goal before time runs out. Fourth downs use a WP-model look-ahead. The decision being evaluated
  is forced on the first snap, and everything after it follows that policy.
* **Variance control**: common random numbers and Latin-hypercube uniforms. Grading is cross-fitted, so the
  recommended option is chosen on one seed set and its edge is measured on an independent one, which
  removes the "max of noisy estimates" bias.

## Validation (out of sample, 2023–2025)

Run `python scripts/validate_sim.py`. Results live in `reports/validation_*.{csv,json}`.

RESULTS_VALIDATION

## What the 2023–2025 grading found

RESULTS_SUMMARY

Full tables are in `reports/`: `decision_families.csv`, `team_seasons.csv`, `coaches.csv`,
`costliest_decisions.csv`, `all_graded_decisions.csv.gz`, `team_variable_sensitivity.csv` and
`decision_charts.json`.

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

## Limitations

* Play calling inside a play type is not modelled: "pass" means the situational pass distribution, not a
  specific concept (a sideline route versus a seam).
* Penalties are sampled from real penalty plays. The 10-second runoff and untimed downs after defensive
  fouls are not modelled.
* Overtime is valued as a strength-adjusted coin flip rather than simulated.
* A "mistake" can reflect information the model lacks, such as an injured kicker, a specific scheme
  or weather inside the stadium. Team-games with an emergency kicker are excluded automatically.
* Rollout policy is a strong heuristic, not a solved game; the opponent does not adapt beyond it.
