# nflclock code review (before Bills at Rams, 2026-10-13)

Scope: `web/engine.js` vs `src/nflclock/sim.py`, the sim's rules and policy, `analyze.py` decision extraction and
root states, and the `worker.js` / `live.html` state conversion. I ran every finding below before reporting it.

## Summary

| # | Finding | Where | Severity | Status |
|---|---------|-------|----------|--------|
| 1 | A forced field goal with the clock running is always a rushed "fire drill" kick, at any time left | `sim.py:402`, `engine.js:579` | **High for the live tool** | Fixed + test |
| 2 | The out-of-bounds window (2:00 / 5:00) is judged at the snap, not where the play ends | `sim.py:657`, `engine.js:755` | Low-medium | Fixed + test |
| 3 | Kick-to-win from 0:43-0:45 kicks at 0:03, which needs a 42-second play clock | `sim.py:49,369`, `engine.js:554` | Low | Reported |
| 4 | Overtime in the live tool is simulated as a longer 4th quarter; a tie is worth `ot_wp_home`, not 0.5 | `worker.js:23`, `engine.js:813` | Low (OT only) | Reported |
| 5 | Browser export rounds play, punt, kickoff and tempo durations to 0.1 s | `webexport.py:74,82,87,91` | Negligible | Reported |

Fixes 1 and 2 are in both engines. `pytest` (21 tests), `parity_expected.py 8000` + `parity_test.js 8000`, and the
new exact-parity check all pass after the fixes.

## 1. JS vs Python parity: exact, apart from duration rounding

The existing parity test compares means within about 3.5 SE. To check every branch I added an **exact, per-rollout**
check:

- `scripts/parity_exact.py` patches `Simulator._uniforms` to return the browser engine's counter RNG
  (`uni(seed, r, step, c)`). It applies the browser's 0.1 s rounding of durations and tempo, and the float32 EPA.
- It then runs random roots across halves, phases (SNAP/PAT/KICKOFF), downs, timeouts and running clocks, with
  every forced action (`to_def`, `to_off`, tempo, spike, go, fg, punt, kneel, run, pass, runoff, h1, pat, kick).
- `web/parity_exact_test.js` must reproduce every rollout value exactly.

Result: **0 mismatches across about 4,800 cases × 100-200 rollouts**, sound and coach modes, before and after the fixes.
`_snap`, `_scrimmage`, `_fourth_down`, `_coach_choice`, `_pat`, `_kickoff`, `_field_goal`, `_punt`, `_value`, and the
random-number columns (0 runoff, 1 run/pass, 2 library draw, 3 make/onside, 4 kickoff/punt draw, 5 coach, 6/7
clock-aware swap) all match.

The check is sensitive. Changing one JS constant (`CLOSE_SNAP_FLOOR` 12 to 13, onside 125 s to 126 s) failed it.
Before I matched the rounding, it flagged rollouts that diverged only through 0.1 s duration differences.

Run it with:

```bash
python scripts/parity_exact.py 300 200 && node web/parity_exact_test.js          # sound coaching
python scripts/parity_exact.py 300 200 coach 4 && node web/parity_exact_test.js  # coach tendencies
```

### Finding 5: duration rounding in the export (negligible)

`webexport.py` ships durations as `round(x*10)` integers, so the browser plays 5.24 s as 5.2 s. Tempo values have
finer resolution in the bundle. The rounding is unbiased. Paired runs of quantized vs. raw Python moved WP by
+0.00 to +0.04 points on four late-game scenarios (40k rollouts). No action needed.

## 2. Bugs fixed

### Finding 1: forced FG with a running clock is always a fire drill (High for tonight)

`sim.py:400-402` (and `engine.js:578-579`) overrode the fire-drill rule whenever a play was forced:

```python
if forced is not None:
    fire = run_c & (forced == "fg")
```

So any forced `fg` with the clock running got two things, at any time left:

- the fire-drill runoff (7-12 s) in place of the policy tempo;
- `FIRE_DRILL_LOGIT = -0.3` on the make probability.

The policy itself only fire-drills with 25 s or less left. Graded decisions are not affected, because analyze.py's
4th-down roots are snap roots with the clock stopped. **The live tool is affected:** after an in-bounds 3rd-down
play the clock is running, and the worker offers `fg: {play: 'fg'}`.

Repro: Q4 8:00, tied, 4th-and-5 at the opponent's 27, a 44-yard kick (p = 0.86).

| Clock | FG | Go |
|-------|----|----|
| Stopped | 0.5839 | 0.5848 |
| Running | 0.5784 (−0.55 pts) | 0.5869 |

The −0.3 logit alone drops the 44-yard make chance from 86% to 82%, purely because the clock was running at 8:00.

Fix: the forced kick is rushed only inside the same 25 s window the policy uses. That window is now the named
constant `FIRE_WINDOW = 25.0`, so the policy's own behavior does not change.

Test: `test_forced_kick_with_time_to_spare_is_not_a_fire_drill`. It fails before the fix and passes after.

### Finding 2: out-of-bounds window judged at the snap (Low-medium)

`_scrimmage` decided whether an out-of-bounds or penalty play stops the clock from the time at the snap
(`_in_window` before `_clock_after_play`). Under the rule it is the time when the play ends.

- First half: a play crossing 2:00 is already stopped by the two-minute warning, so no effect.
- Second half: snaps in the ~5-15 s before 5:00 of Q4 are affected.

Repro: snap at 5:03, Q4, pass forced. 3,408 of 20,000 rollouts ended out of bounds inside 5:00 and still restarted the
clock (`credit = 4`, running).

Fix: `in_win = (S.t[ix] - dur - half_end) <= oob_window`, mirrored in JS. The now-unused `_in_window` is removed.
Penalties use the same end-of-play time.

Test: `test_out_of_bounds_window_judged_at_the_end_of_the_play`. It fails before the fix and passes after.

## 3. Reported, not fixed (policy or scope calls for the coordinator)

### Finding 3: kick-to-win needs a 42-second play clock (Low)

`endkick` fires with `t_half <= CLOSE_END = 45` on a running clock and sets the clock to
`min(t_half, CLOSE_KICK_AT = 3)`. The play clock starts at the whistle, so from 0:45 the offense must snap or call
timeout by about 0:05. Reaching 0:03 legally requires 43 s or less.

Repro: from `t=45`, down 1, opponent's 22, 1 timeout, clock running, every rollout kicks at 0:03.

The opponent loses about 2 s it would really have. Suggested fix: kick at
`max(CLOSE_KICK_AT, t_half - 40 + to_react)`, or set `CLOSE_END = 43`. This is a policy change, so I left it.

### Finding 4: overtime in the live tool (Low, OT only)

`worker.js:23` maps `qtr 5` to `t = clock`, so OT runs as a 10-minute "second half" under regulation rules: no
first-possession rule, and `_value` scores an OT tie as `ot_wp_home` (0.551 for this game) instead of 0.5.

Repro: OT 0:02, tied, home ball at its own 25 gives home 0.551.

If the tool might be used in OT tonight, treat OT numbers as approximate, or add an OT mode.

Minor, related: kickoffs (`sim.py:292`) are not clamped at the end of Q1/Q3, so a kickoff spanning the quarter end
loses up to ~12 s of the next quarter. Effect is negligible.

## 4. Checked and found correct

- **Clock rules**:
  - Incompletions, scores, change of possession, timeouts (+1 s reaction), the two-minute warning both on plays and
    between snaps, and quarter ends (clamped on plays) are all handled.
  - Kneels: 1.5 s, then 38-40 s runoff. Spikes: 1 s, counted as an incompletion.
  - The 40-second play clock bounds all tempo draws.
  - BURN applies only to a leading offense.
- **Kneel-out feasibility** (`kneel_out_possible`): it counts gaps and stops, including the pending two-minute
  warning, correctly.
- **4th downs**:
  - All six WP queries in the batched look-ahead have the right team, margin sign, timeouts (swapped for the
    opponent), field position (`100 - yl`, missed FG at `100 - max(yl+8, 20)`, punt receive spot) and time offsets.
  - The end-of-half overrides and the coach-tendency features match `tendency.features_from_raw`.
- **Home/away and signs**:
  - `spread_line > 0` means home favored, matching `home_spread` and `off_spread`.
  - `home_opening_kickoff == 1` means home received the opening kickoff (99.3% match against first kickoffs), so
    `receive_2h` is correct in both training and context.
  - Perspective handling in `_value` and the worker (`perspective: g.team`, baseline from home) is correct.
- **analyze.py**:
  - The `def_timeout` decider is the defense, with offense margin 0..16; `onside` uses the receiving team as
    nflverse `posteam`, and the kicking team is `defteam`, the decider and the KICKOFF-phase `pos`.
  - PAT rows' `posteam_score` already includes the TD.
  - `_root_post_play` adds back an attached timeout for the team that called it.
  - Re-deriving the h1_end labels from only the plays at or after the root snap changes 0 of 1,047.
  - Cross-fitting picks `rec` on seed set A and measures the edge on seed + 1.
  - Known approximation: if both teams call a timeout between two snaps, only the first is attached and added back.
- **worker.js / live.html**:
  - `rootFrom` swaps away-home to home-away for score and timeouts and converts quarter + clock to game seconds.
  - Yard lines are yards to the opponent's goal (own 25 is 75).
  - `inDomain` and `tendencyFeatures` use the decider's margin and timeouts.
  - Option gating (spike only on downs 1-3, fg at p ≥ 0.02, punt at yl ≥ 30, timeout only with timeouts left) and
    best-option edges and SEs are correct.
