"""Vectorised Monte-Carlo simulator for the rest of a half, with explicit NFL clock rules (or another level's:
GameContext.rules, rules.py; the NFL's are today's, bit for bit).

N rollouts advance in lock-step as numpy arrays. Every rollout carries the full
game state (clock, score, possession, down/distance/field position, timeouts,
whether the clock is running). Both teams follow a situational "competent
coach" policy; the root decision being evaluated is forced on the first step and
everything after it is played out by the policy. Comparing actions under common
random numbers isolates the value of the decision itself.

Clock rules modelled
  * the clock runs between snaps after in-bounds plays; tempo (hurry / normal /
    milk / spike / kneel) sets how much runs off, drawn from measured
    distributions;
  * it stops on incompletions, scores, changes of possession, timeouts, the
    two-minute warning and quarter ends;
  * out of bounds stops it until the snap only inside 2:00 (1st half) / 5:00
    (2nd half); elsewhere it restarts on the ready-for-play signal;
  * play durations come from the sampled play; a half can end on a play (the
    untimed PAT still happens when it can change the result; never on an
    accepted defensive foul: an untimed down) or during between-snap runoff
    (kneel-outs).
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from . import library as L
from .ratings import fg_logit
from .rules import LEVEL_OK, rules_of

RUN, PASS, KNEEL, SPIKE, FG, PUNT = range(6)
PLAY_NAMES = {"run": RUN, "pass": PASS, "kneel": KNEEL, "spike": SPIKE, "fg": FG, "punt": PUNT}
HURRY, NORMAL, MILK, T_SPIKE, T_KNEEL, URGENT, T_FIRE = range(7)
BURN_SECONDS = 8.0           # leading in the last seconds: any snap is played to run out the clock
FIRE_DRILL = (7.0, 12.0)     # seconds to rush the field-goal unit on with the clock running
KNEEL_RUNOFF = (38.0, 40.0)  # seconds run off between kneels (40 s play clock, snapped with 0-2 s left)
FIRE_DRILL_LOGIT = -0.3      # rushed kicks are a little less accurate
FG_LONG = (52.0, 0.045, 60.0, 0.05)  # taper past 52 yd to the NFL's 2016-26 makes (60-61 46%, 64-65 27%, 66+ 23%)
XP_LOGIT = 0.35              # an extra point beats a 33-yard field goal (snapped from the middle): 2023-25 ~95.7%
FIRE_WINDOW = 25.0           # seconds left in the half below which a kick with the clock running is a fire drill
CLOCK_EPS = 1e-6             # a clock left this close to the end of the half has run out (the tenths summed drift by 1e-14: a snap at 0:00)
# Clock-aware play calls when the offense needs the clock stopped and has no timeouts (2020-25 data):
# a pass that would end in bounds with a gain is kept with this probability, otherwise redrawn from the
# same pool's incompletions / catches out of bounds; and the pass rate rises from ~81% to ~95%.
CLOCK_AWARE = ((20.0, 0.53), (35.0, 0.79))   # (seconds left in the half at the snap, keep probability)
CLOCK_PASS_SHIFT = 1.5                        # pass-rate logit shift in the final CLOCK_PASS_WINDOW seconds
CLOCK_PASS_WINDOW = 60.0
# Kick-to-win endgame: trailing by 1-2 or tied, a makeable kick in hand and a timeout to stop the clock
# for it. The offense runs the clock down (clock-killing plays, timeouts kept), takes a timeout with
# ~3 s left and kicks. The defense spends its timeouts to save time for a reply. (Without a timeout the
# offense keeps hurrying and spikes for the kick: a rushed field-goal unit costs more than it saves.)
CLOSE_FG_P = 0.7          # make probability that puts the offense in kick-to-win mode: a ~52-yarder (NFL 2016-25,
                          # trailing 1-2 or tied in the last 20-75 s with a timeout: 96% clock-killing runs inside the
                          # 25, 60% at the 30-35, 38% at the 35-40: from farther out they keep moving)
CLOSE_WINDOW = 180.0      # seconds left in the game
CLOSE_END = 45.0          # clock running with this little left: run it down and kick
CLOSE_KICK_AT = 3.0       # seconds left at the final timeout
CLOSE_SNAP_FLOOR = 12.0   # latest snap while running it down, so the play ends with time to call timeout
CLOSE_DEF_WINDOW = 120.0
CLOSE_REPLY = 30.0        # the defense saves time only if, stopping the clock after every down it has a timeout for,
CLOSE_PLAY = 6.0          # (a play ~6 s, a gap run down ~39 s) it gets the ball back with this long left: a kickoff
CLOSE_GAP = 39.0          # and a few throws to a long kick
# A hurry-up from a running clock in the last minute is faster: the urgent draw scaled and capped, from x0.75 and 18 s
# at 0:00 to as drawn and 26 s at 1:00 (NFL 2016-25 no-huddle snaps after the whistle: median 15.8 s over the whole
# pool, 13.4 s inside 0:30 and 11.8 s inside 0:20; the last minute's p99 26 s, inside 0:30 22 s)
URGENT_LATE = (60.0, 0.75, 18.0, 26.0)
# 4th down, the sound choice (NFL coaches 2020-25): a go must beat the best kick by FOURTH_GO_EDGE win probability (the
# one-step look-ahead overrates keeping the ball: up 10 at 5:00 its WP is 0.76-0.92 for a team that wins ~97%); coaches
# all but never go on 4th and 2+ in their own half (2-10%) or 4th and 1 inside their 20 (6%) unless trailing in the
# last 3:00 (by 4+ in the last 5:00, by 9+ in the last 7:00: then no edge either); trailing by 9+ in the last 5:00
# nobody punts from the other half (0-2%); a field goal that ties or takes the lead in the last 5:00 is kicked on 4th
# and 2+ when it is a good one (67-100%)
FOURTH_GO_EDGE = 0.02
FOURTH_KICK_P = 0.75
# ... and a team one or two scores behind (1-16) does not punt in the last 1:30, or 9-16 behind in the last 2:30
# (NFL 2016-25: 1 punt in 751 4th downs, 2 in 365); the coaches' own model punted down 10 at 1:00 from its 40
NO_PUNT_BEHIND = (16, 90.0, 9, 150.0)
TEMPO_NAMES = {"hurry": HURRY, "normal": NORMAL, "milk": MILK, "urgent": URGENT}
SNAP, PAT, KICKOFF, DONE = range(4)
KICKOFF_START_YL = 70.0   # mean receiving-team start under 2024-25 kickoff rules
FG_SNAP_YARDS = 17.0


@dataclass
class GameContext:
    """Per-game constants. Team index 0 = home, 1 = away."""
    home: str = "HOME"
    away: str = "AWAY"
    home_spread: float = 0.0          # > 0: home favoured by that many points
    receive_2h: int = 1               # team receiving the 2nd-half kickoff
    indoor: bool = False
    wind: float = 0.0
    temp: float = 65.0
    season: int = 2025
    delta: np.ndarray = field(default_factory=lambda: np.zeros((2, 2)))  # [offense team, kind] EPA tilt
    proe: np.ndarray = field(default_factory=lambda: np.zeros(2))
    kicker_shift: np.ndarray = field(default_factory=lambda: np.zeros(2))  # FG/XP logit shift
    punter_shift: np.ndarray = field(default_factory=lambda: np.zeros(2))  # net punt yards
    two_pt: np.ndarray = field(default_factory=lambda: np.full(2, 0.47))
    ot_wp_home: float = 0.5
    # 4th-down decision style per team: None = sound (WP look-ahead), or {"model": tendency model, "shift": go logit
    # shift} to play like a typical NFL coach (shift 0) or a specific coach's measured tendencies.
    coach4th: list = field(default_factory=lambda: [None, None])
    rules: object = "nfl"             # the rulebook: a name (rules.py RULES, 'nfhs:GA') or {"base": name, **overrides}

    def spread_for(self, team):
        return np.where(np.asarray(team) == 0, self.home_spread, -self.home_spread)


@dataclass
class RootState:
    t: float                  # game seconds remaining
    pos: int                  # team with the ball (0 home / 1 away); the kicking team in KICKOFF phase
    score: tuple              # (home, away)
    down: int = 1
    ytg: float = 10
    yl: float = 75            # yards to the opponent's goal line
    to: tuple = (3, 3)        # timeouts (home, away)
    clock_running: bool = False
    phase: int = SNAP
    running_clock: bool = False   # a state's sticky running clock already on (rules runClock)

    def with_(self, **kw) -> "RootState":
        return replace(self, **kw)


class _S:
    """Mutable rollout state (struct of arrays)."""

    def __init__(self, root: RootState, n: int):
        self.t = np.full(n, float(root.t))
        self.pos = np.full(n, int(root.pos), dtype=np.int64)
        self.score = np.tile(np.array(root.score, dtype=np.int64), (n, 1))
        self.down = np.full(n, int(root.down), dtype=np.int64)
        self.ytg = np.full(n, float(root.ytg))
        self.yl = np.full(n, float(root.yl))
        self.to = np.tile(np.array(root.to, dtype=np.int64), (n, 1))
        self.running = np.full(n, bool(root.clock_running))
        self.credit = np.zeros(n)
        self.phase = np.full(n, int(root.phase), dtype=np.int64)
        self.free_kick = np.zeros(n, dtype=bool)
        self.rc = np.full(n, bool(root.running_clock))


class Simulator:
    def __init__(self, bundle, ctx: GameContext):
        self.b = bundle
        self.ctx = ctx
        self.lib = bundle.lib
        self.cdf, self.conv, self.stop_cdf = [], [], []
        self.stop_pos, self.stop_off = self.lib.clock_stop_subset()
        for team in (0, 1):
            cdf, prob = self.lib.tilt(ctx.delta[team, L.KIND_RUN], ctx.delta[team, L.KIND_PASS])
            self.cdf.append(cdf)
            self.stop_cdf.append(self.lib.subset_cdf(prob, self.stop_pos, self.stop_off))
            self.conv.append(self.lib.conversion_table(prob, ctx.proe[team] / 0.24))
        pu = bundle.punts
        order = np.argsort(pu["yl"], kind="stable")
        self.punt = {k: v[order] for k, v in pu.items()}
        ys = self.punt["yl"]
        self.punt_lo = np.zeros(101, dtype=np.int64)
        self.punt_hi = np.zeros(101, dtype=np.int64)
        for y in range(101):
            w = 2.0
            while True:
                lo, hi = np.searchsorted(ys, y - w), np.searchsorted(ys, y + w, side="right")
                if hi - lo >= 60 or w > 30:
                    break
                w += 1.0
            self.punt_lo[y], self.punt_hi[y] = lo, hi
        clean = ~self.punt["blocked"] & ~self.punt["ret_td"]
        self.exp_net = np.array([
            np.mean(self.punt["net"][self.punt_lo[y]:self.punt_hi[y]][clean[self.punt_lo[y]:self.punt_hi[y]]])
            if self.punt_hi[y] > self.punt_lo[y] else 40.0 for y in range(101)])
        tp = bundle.tempo
        # A spike is hurried by definition; the measured tail beyond ~16s is injuries and reviews.
        self.tempo = {HURRY: tp["hurry"], NORMAL: tp["normal"], MILK: tp["milk"],
                      T_SPIKE: np.clip(tp["spike"], 1.0, 16.0), URGENT: tp["urgent"]}
        c = bundle.consts
        self.kneel_dur = c["kneel_duration"]
        self.spike_dur = c["spike_duration"]
        self.to_react = c["timeout_reaction"]
        self.oob_credit = c["oob_restart_credit"]
        self.pen_credit = c["penalty_restart_credit"]
        self.onside_p = max(c["onside"], 0.05)
        # the rulebook, and the level's own constants (the NFL bundle carries none of them: today's values; the
        # first-down credit, never used under NFL rules, falls back to the ready-for-play restart on out-of-bounds plays)
        self.R = R = rules_of(ctx.rules)
        if (R["fieldYards"], R["firstDownYards"], R["fgPoints"], tuple(R["tryPoints"])) != (100, 10, 3, (1, 2)):
            raise ValueError("only 11-player football is supported")   # 8- and 6-player rules are not in this version
        level = c.get("level", "nfl")
        if LEVEL_OK[level] is not None and R["level"] not in LEVEL_OK[level]:
            raise ValueError(f"{R['level']} rules on {level} data")
        self.kickoff_start = float(c.get("kickoff_start_yl", KICKOFF_START_YL))
        self.ko_tb = c.get("ko_touchback_yl", 65)
        self.xp_logit = c.get("xp_logit", XP_LOGIT)
        self.onside_yl = c.get("onside_yl", (54.0, 46.0))
        self.fg_long = tuple(c.get("fg_long", FG_LONG))
        self.fg_max = c.get("fg_max", 68)
        self.fd_credit = (R["fdStop"]["credit"] if R["fdStop"] and R["fdStop"]["credit"] is not None
                          else c.get("fd_restart_credit", c["oob_restart_credit"]))
        self.F = self.lib.arr
        fb = lambda k: self.F[k].astype(bool)
        self.live_gain = ~(fb("incomplete") | fb("oob") | fb("penalty") | fb("td_off") | fb("td_def") | fb("turnover")
                           | fb("safety")) & (self.F["yards"] > 0)

    # ------------------------------------------------------------ helpers ---
    def fg_prob(self, dist, team):
        dist = np.asarray(dist, float)
        z = fg_logit(self.b.fg_model, np.minimum(dist, 70.0), self.ctx.indoor, self.ctx.wind,
                     self.ctx.temp, self.ctx.season) + self.ctx.kicker_shift[np.asarray(team)]
        FL = self.fg_long
        z = z - FL[1] * np.maximum(0.0, dist - FL[0]) - FL[3] * np.maximum(0.0, dist - FL[2])
        return np.where(dist > self.fg_max, 0.0, 1.0 / (1.0 + np.exp(-z)))

    def wp(self, team, margin, t, down, ytg, yl, off_to, def_to):
        """Win probability for ``team`` when it has the ball (vectorised)."""
        team = np.asarray(team)
        q = self.R["quarter"]
        if q != 900:   # shorter quarters: the model's game, scaled
            t = np.asarray(t, float) * 900 / q
        return self.b.wp.predict(
            margin=margin, t=np.maximum(t, 1.0), down=down, ydstogo=np.clip(ytg, 1, 99),
            yardline_100=np.clip(yl, 1, 99), off_to=off_to, def_to=def_to,
            off_spread=self.ctx.spread_for(team), is_home=(team == 0).astype(float),
            receive_2h=(team == self.ctx.receive_2h).astype(float),
        )

    def kneel_out_possible(self, t_half, down, def_to, clock_running, tmw_pending):
        """Can the offense run out the half with kneel-downs alone?"""
        k = np.clip(4 - np.asarray(down), 0, 3)
        gaps = k + np.asarray(clock_running).astype(int)
        stops = np.asarray(def_to) + np.asarray(tmw_pending).astype(int)
        KR = self.R["kneelRunoff"]
        gap = 0.5 * (KR[0] + KR[1])   # the average kneel runoff (QA: 38 s undercounted it)
        burn = k * self.kneel_dur + np.maximum(gaps - stops, 0) * gap + np.minimum(gaps, stops) * 1.0
        return np.asarray(t_half) <= burn + 1.0

    # --------------------------------------------------------------- run ---
    def run(self, root: RootState, n: int = 2000, action: dict | None = None, perspective: int = 0,
            seed: int = 0, max_steps: int = 300, return_state: bool = False, drive_only: bool = False):
        """Simulate ``n`` continuations; return each rollout's value for ``perspective``.

        ``action`` forces the root decision (first step only). Keys:
          to_def / to_off (bool) -- timeout right now by defense / offense
          tempo ("hurry" | "normal" | "milk")
          play ("run" | "pass" | "go" | "kneel" | "spike" | "fg" | "punt")
          pat ("xp" | "two")      -- when root.phase == PAT
          kick ("onside" | "deep") -- when root.phase == KICKOFF
          runoff (seconds)        -- exact between-snap runoff if the clock is running
          h1 ("attack" | "runout") -- persistent end-of-first-half strategy for the
                                      root offense for the rest of its possession
        """
        action = action or {}
        self._geom(root)
        S = _S(root, n)
        S.plays = np.zeros(n, dtype=np.int64)
        S.strategy = action.get("h1")
        S.strat_team = root.pos
        S.strat_active = np.full(n, S.strategy is not None)
        for step in range(max_steps):
            if not (S.phase != DONE).any():
                break
            u = self._uniforms(seed, step, n)
            act = action if step == 0 else {}
            if drive_only:
                before_pos, before_score = S.pos.copy(), S.score.sum(axis=1)
                self._snap(S, u, act)
                S.plays += S.phase != DONE
                ended = (S.pos != before_pos) | (S.score.sum(axis=1) != before_score) | (S.phase != SNAP)
                S.phase[ended] = DONE
                continue
            self._pat(S, u, act)
            self._kickoff(S, u, act)
            self._snap(S, u, act)
            if getattr(self, "trace", None) is not None:
                self.trace.append((step, S.t[:4].copy(), S.pos[:4].copy(), S.score[:4].copy(), S.down[:4].copy(),
                                   S.ytg[:4].copy(), S.yl[:4].copy(), S.to[:4].copy(), S.running[:4].copy(),
                                   S.phase[:4].copy()))
        if drive_only:
            return S
        v = self._value(S, perspective)
        return (v, S) if return_state else v

    def _geom(self, root):
        """The half's clock geometry. 0:00 of the 2nd quarter is t = H (two quarters), which otherwise reads as the start
        of the second half; a try at that moment (a touchdown on the last play of the first half) still belongs to the
        first half, which ends after it. No two-minute stoppage: tmw = +inf, which no clock ever crosses."""
        R = self.R
        H = 2.0 * R["quarter"]
        self.half_end = H if root.t > H or (root.t == H and root.phase == PAT) else 0.0
        self.half = 1 if self.half_end > 0 else 2
        self.q_end = self.half_end + float(R["quarter"])
        self.tmw = np.inf if R["tmw"] is None else self.half_end + float(R["tmw"])
        self.oob_window = float(R["oob"][0] if self.half == 1 else R["oob"][1])

    def _rc(self, S, ix):
        """A state's running clock at this score and time (rules runClock), kept on once it starts when sticky."""
        rc = self.R["runClock"]
        if not rc:
            return np.zeros(ix.size, bool)
        on = ((np.abs(S.score[ix, 0] - S.score[ix, 1]) >= rc["margin"]) & (S.t[ix] <= rc["from"] * self.R["quarter"])
              & (S.t[ix] > self.half_end))
        if rc["sticky"]:
            S.rc[ix] |= on
            return on | S.rc[ix]
        return on

    def _miss_yl(self, yl):
        """Where a missed field goal from yl leaves the other team: the spot of the kick (NFL), the previous spot
        (college), never inside its 20; or a touchback at the 20 (high school: a miss is a scrimmage kick)."""
        if self.R["fgMissTb"] is not None:
            return np.full(np.shape(yl), float(self.R["fgMissTb"]))
        return 100 - np.maximum(yl + self.R["fgMissBack"], 20)

    @staticmethod
    def _uniforms(seed, step, n, k=8):
        """Latin-hypercube uniforms: each column is stratified across rollouts.

        Same (seed, step) -> same numbers, so alternative actions share common
        random numbers; stratification removes most of the sampling noise in
        the first few plays, which is where alternatives differ.
        """
        rng = np.random.default_rng((seed, step))
        u = rng.random((n, k))
        for c in range(k):
            u[:, c] = (rng.permutation(n) + u[:, c]) / n
        return u

    # ----------------------------------------------------------------- PAT ---
    def _pat(self, S, u, act):
        self._no_try(S, np.flatnonzero(S.phase == PAT))
        ix = np.flatnonzero(S.phase == PAT)
        if not ix.size:
            return
        o = S.pos[ix]
        margin = S.score[ix, o] - S.score[ix, 1 - o]
        t_half = S.t[ix] - self.half_end
        go2 = (self.half == 2) & (t_half <= 900) & np.isin(margin, [-2, -5, -9, -10, -13, 1, 5])
        if "pat" in act:
            go2[:] = act["pat"] == "two"
        pk = np.clip(self.fg_prob(np.full(ix.size, float(self.R["patKick"])), o), 1e-9, 1 - 1e-9)
        p = np.where(go2, self.ctx.two_pt[o], 1.0 / (1.0 + np.exp(-(np.log(pk / (1 - pk)) + self.xp_logit))))
        made = u[ix, 3] < p
        S.score[ix, o] += np.where(made, np.where(go2, 2, 1), 0)
        S.phase[ix] = np.where(S.t[ix] <= self.half_end, DONE, KICKOFF)
        S.free_kick[ix] = False

    # ------------------------------------------------------------- KICKOFF ---
    def _kickoff(self, S, u, act):
        ix = np.flatnonzero(S.phase == KICKOFF)
        if not ix.size:
            return
        kt = S.pos[ix]
        rt = 1 - kt
        margin_k = S.score[ix, kt] - S.score[ix, rt]
        t_half = S.t[ix] - self.half_end
        onside = (self.half == 2) & (margin_k < 0) & (
            ((t_half <= 125) & (S.to[ix, kt] <= 1)) | (t_half <= 65) | ((t_half <= 160) & (margin_k <= -9)))
        onside &= ~S.free_kick[ix]
        if "kick" in act:   # NFL: only a team behind may declare one (2024+ rules); a free kick after a safety is no kickoff
            onside[:] = act["kick"] == "onside"
            if self.R["onsideBehindOnly"]:
                onside &= (margin_k < 0) | S.free_kick[ix]
        ko = self.b.kickoffs
        j = (u[ix, 4] * len(ko["start_yl"])).astype(int)
        start = ko["start_yl"][j]
        dur = ko["duration"][j]
        ret_td = ko["ret_td"][j] & ~onside
        if self.R["koTouchback"] != self.ko_tb:   # the data's touchbacks start where these rules put them
            start = np.where((dur == 0) & (start == self.ko_tb), float(self.R["koTouchback"]), start)
        start = np.where(S.free_kick[ix], np.clip(start - 8.0, 40.0, 75.0), start)
        rec = onside & (u[ix, 3] < self.onside_p)
        S.pos[ix] = np.where(rec, kt, rt)
        S.yl[ix] = np.where(onside, np.where(rec, float(self.onside_yl[0]), float(self.onside_yl[1])), start)
        S.t[ix] = np.maximum(S.t[ix] - np.where(onside, 3.0, dur), self.half_end)
        S.t[ix] = np.where(S.t[ix] <= self.half_end + CLOCK_EPS, self.half_end, S.t[ix])
        S.down[ix] = 1
        S.ytg[ix] = np.minimum(10.0, S.yl[ix])
        S.running[ix] = self._rc(S, ix) & (S.t[ix] > self.half_end)
        S.credit[ix] = 0.0
        S.free_kick[ix] = False
        S.phase[ix] = SNAP
        if ret_td.any():
            r = ix[ret_td]
            S.score[r, S.pos[r]] += 6
            S.phase[r] = PAT
            S.running[r] = False
        over = (S.t[ix] <= self.half_end) & (S.phase[ix] == SNAP)
        S.phase[ix[over]] = DONE
        self._no_try(S, ix)

    # ---------------------------------------------------------------- SNAP ---
    def _snap(self, S, u, act):
        ix = np.flatnonzero(S.phase == SNAP)
        if not ix.size:
            return
        half, half_end = self.half, self.half_end
        o = S.pos[ix]
        d = 1 - o
        margin = S.score[ix, o] - S.score[ix, d]
        run_c = S.running[ix].copy()
        t_half = S.t[ix] - half_end
        off_to = S.to[ix, o]
        def_to = S.to[ix, d]
        yl = S.yl[ix]
        down = S.down[ix]
        fg_range = self.fg_prob(yl + FG_SNAP_YARDS, o) >= 0.35
        fg_helps = (margin >= -3) & (margin <= 0)
        tmw_pending = S.t[ix] > self.tmw

        # (1) timeouts right after the previous whistle
        if half == 2:
            kneel_ok = ((margin > 0) | ((margin == 0) & (yl >= 70) & (t_half <= 40))) & self.kneel_out_possible(
                t_half, down, def_to, run_c, tmw_pending)
            def_wants = (margin > 0) & ((t_half <= 240) | ((margin >= 9) & (t_half <= 420)))
            off_wants = (margin <= 0) & ((t_half <= 60) | ((margin <= -9) & (t_half <= 120)))
            off_wants |= fg_range & fg_helps & (t_half <= 25)
            closing = (margin >= -2) & (margin <= 0) & (t_half <= CLOSE_WINDOW) & (off_to > 0) & (
                self.fg_prob(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P)
            off_wants &= ~closing                                 # timeouts are kept for the kick
            # the defense saves time for a reply when a field goal would beat it: only when the offense can run the
            # clock down to its kick (a timeout left: without one the running clock is the offense's problem), and only
            # if stopping the clock after every down it can still gets it the ball back with time to answer
            kick_at = t_half - (4 - down) * CLOSE_PLAY - np.maximum(5 - down - def_to, 0) * CLOSE_GAP
            def_saves = (margin >= -2) & (margin <= 0) & (t_half <= CLOSE_DEF_WINDOW) & (off_to > 0) & (
                kick_at >= CLOSE_REPLY) & (self.fg_prob(yl + FG_SNAP_YARDS, o) >= CLOSE_FG_P)
            def_wants |= def_saves
            attempt = np.ones(ix.size, bool)
            run_out = np.zeros(ix.size, bool)
        else:
            # End of first half: attack only if there is enough clock (incl. timeouts) to reach FG range.
            attempt = (yl - 35.0) <= 0.6 * (t_half + 20.0 * off_to)
            S.strat_active[ix] &= S.pos[ix] == S.strat_team
            forced_h1 = S.strat_active[ix]
            if forced_h1.any():
                attempt = np.where(forced_h1, S.strategy == "attack", attempt)
            run_out = ~attempt & (t_half <= 120)
            closing = np.zeros(ix.size, bool)
            kneel_ok = run_out & self.kneel_out_possible(t_half, down, def_to, run_c, tmw_pending)
            def_wants = run_out & ~kneel_ok & (t_half <= 100) & (down >= 2)
            off_wants = attempt & (t_half <= 30.0 + 15.0 * off_to) & (t_half <= 75)
        # offense that wants the clock stopped (for clock-aware play calls)
        aware = (((margin <= 0) & (margin >= -16)) if half == 2 else attempt.copy()) & ~closing
        def_call = run_c & def_wants & (def_to > 0)
        off_call = run_c & ~def_call & off_wants & (off_to > 0) & ~kneel_ok
        if "to_def" in act:
            def_call = run_c & (def_to > 0) & bool(act["to_def"])
        if "to_off" in act:
            off_call = run_c & ~def_call & (off_to > 0) & bool(act["to_off"])
        if def_call.any():
            S.to[ix[def_call], d[def_call]] -= 1
        if off_call.any():
            S.to[ix[off_call], o[off_call]] -= 1
        called = def_call | off_call
        # (a timeout called before the two-minute warning never carries the clock past it: the warning still comes; nor
        # out of the half: one called with time left keeps a snap)
        t_c = S.t[ix[called]]
        S.t[ix[called]] = np.maximum(np.maximum(t_c - self.to_react, np.minimum(t_c, half_end + 0.5)),
                                     np.where(t_c > self.tmw, np.minimum(t_c, self.tmw + 0.01), half_end))
        run_c &= ~called
        # kick to win: with the clock running and little left, let it run down, then timeout and kick
        free = not any(k in act for k in ("tempo", "play", "runoff"))
        endkick = closing & run_c & (t_half <= CLOSE_END) & (S.to[ix, o] > 0) & free
        if endkick.any():
            S.t[ix[endkick]] = half_end + np.minimum(t_half[endkick], CLOSE_KICK_AT)
            S.to[ix[endkick], o[endkick]] -= 1
            run_c &= ~endkick

        # (2) tempo and between-snap runoff
        if half == 2:
            hurry = ((margin < 0) & (t_half <= 300)) | ((margin <= -9) & (t_half <= 600)) | (
                (margin == 0) & (yl <= 80) & (t_half <= 75))
            hurry &= ~closing
            urgent = hurry & (t_half <= 120)
            milk = ((margin > 0) & (t_half <= 600)) | ((margin == 0) & (t_half <= 240) & ~hurry) | closing
        else:
            hurry = (t_half <= 120) & attempt
            urgent = hurry & (t_half <= 60)
            milk = (t_half <= 120) & ~attempt
        tempo = np.where(urgent, URGENT, np.where(hurry, HURRY, np.where(milk, MILK, NORMAL)))
        kneel_now = kneel_ok.copy()
        spike_now = run_c & hurry & (S.to[ix, o] == 0) & (down <= 3) & (t_half <= 35)
        spike_now |= run_c & fg_range & fg_helps & (half == 2) & (S.to[ix, o] == 0) & (down <= 3) & (t_half <= 22)
        spike_now &= ~kneel_now
        if "tempo" in act:  # a forced tempo means a real snap at that pace: no policy spike or kneel
            tempo[:] = TEMPO_NAMES[act["tempo"]]
            spike_now[:] = False
            kneel_now[:] = False
        forced = act.get("play")
        if forced is not None:
            kneel_now[:] = forced == "kneel"
            # a called spike is a spike even if the clock stopped before the snap (their timeout, the two-minute
            # warning): never a play from the library
            spike_now[:] = forced == "spike"
        # 4th down with the clock running and a kick that ties or wins: rush the field-goal unit on
        fg_useful0 = (half == 1) | ((margin >= -3) & (margin <= 0))
        fire = run_c & (down == 4) & fg_useful0 & (self.fg_prob(yl + FG_SNAP_YARDS, o) >= 0.3) & (t_half <= FIRE_WINDOW)
        fire &= ~kneel_now & ~spike_now
        if forced is not None:   # with time to spare a forced kick is set up normally, not rushed
            # (a set runoff is the clock run down to a timeout: the kick after it is set up, not rushed)
            fire = run_c & (forced == "fg") & (t_half <= FIRE_WINDOW) & ("runoff" not in act)
        tempo = np.where(kneel_now, T_KNEEL, np.where(spike_now, T_SPIKE, np.where(fire, T_FIRE, tempo)))
        runoff = np.zeros(ix.size)
        for tm, arr in self.tempo.items():
            m = tempo == tm
            if m.any():
                runoff[m] = arr[(u[ix[m], 0] * len(arr)).astype(int)]
        mk = tempo == T_KNEEL
        KR = self.R["kneelRunoff"]
        runoff[mk] = KR[0] + (KR[1] - KR[0]) * u[ix[mk], 0]
        mf = tempo == T_FIRE
        runoff[mf] = FIRE_DRILL[0] + (FIRE_DRILL[1] - FIRE_DRILL[0]) * u[ix[mf], 0]
        # the last minute's hurry-up is faster
        late = (tempo == URGENT) & (t_half <= URGENT_LATE[0])
        if late.any():
            f = np.clip(t_half / URGENT_LATE[0], 0.0, 1.0)
            runoff = np.where(late, np.minimum(runoff * (URGENT_LATE[1] + (1 - URGENT_LATE[1]) * f),
                                               URGENT_LATE[2] + (URGENT_LATE[3] - URGENT_LATE[2]) * f), runoff)
        if self.R["maxGap"] is not None:   # a short play clock: no longer gaps
            runoff = np.minimum(runoff, float(self.R["maxGap"]))
        runoff = np.where(run_c, np.maximum(runoff - S.credit[ix], 0.0), 0.0)
        if free and closing.any():   # running it down: never past the point where the kick is still safe
            cap = closing & run_c & (tempo == MILK)
            runoff = np.where(cap, np.minimum(runoff, np.maximum(S.t[ix] - half_end - CLOSE_SNAP_FLOOR, 0.0)), runoff)
        if "runoff" in act:
            runoff = np.where(run_c, float(act["runoff"]), 0.0)
        t0 = S.t[ix]
        t1 = t0 - runoff
        t1 = np.where(t1 <= half_end + CLOCK_EPS, half_end, t1)
        stop = (t0 > self.tmw) & (t1 <= self.tmw)
        t1 = np.where(stop, self.tmw, t1)
        stop_q = (t0 > self.q_end) & (t1 <= self.q_end)
        t1 = np.where(stop_q, self.q_end, t1)
        running_at_snap = run_c & ~stop & ~stop_q
        ended = t1 <= half_end
        S.t[ix] = np.maximum(t1, half_end)
        S.credit[ix] = 0.0
        S.phase[ix[ended]] = DONE
        keep = ~ended
        if not keep.any():
            return
        ix, o, d, margin = ix[keep], o[keep], d[keep], margin[keep]
        kneel_now, spike_now, run_out = kneel_now[keep], spike_now[keep], run_out[keep]
        aware = aware[keep]
        closing, endkick = closing[keep], endkick[keep]
        running_at_snap = running_at_snap[keep]
        fire = fire[keep]
        t_half = S.t[ix] - half_end
        yl, down = S.yl[ix], S.down[ix]

        # (3) play choice
        kind = np.full(ix.size, -1)
        kind[kneel_now] = KNEEL
        kind[spike_now & ~kneel_now] = SPIKE
        p_fg = self.fg_prob(yl + FG_SNAP_YARDS, o)
        last_play = t_half <= 6.0
        fg_useful = (half == 1) | ((margin >= -3) & (margin <= 0))
        fg_last = last_play & (p_fg >= 0.08) & fg_useful
        # Kick now if another snap would likely leave no time to set up the field goal.
        snap_budget = np.where(S.to[ix, o] > 0, 8.0, 15.0)
        fg_last |= (t_half <= snap_budget) & (p_fg >= 0.3) & fg_useful & ~running_at_snap
        kind[(kind < 0) & fg_last] = FG
        if forced != "spike":
            kind[(kind == SPIKE) & fg_last] = FG
        kind[fire | endkick] = FG
        fourth = (kind < 0) & (down == 4)
        if fourth.any():
            kind[fourth] = self._fourth_down(S, ix[fourth], o[fourth], margin[fourth], t_half[fourth],
                                             p_fg[fourth], u[ix[fourth], 5])
        kind[(kind < 0) & run_out & (down < 4)] = RUN
        if forced is not None and forced not in ("kneel", "spike"):
            kind[:] = -1 if forced == "go" else PLAY_NAMES[forced]
        mix = kind < 0
        if mix.any():
            mode = np.where(closing[mix], L.MODE_KILL, L.game_mode(half, t_half[mix], margin[mix]))
            fk = L.fine_key(mode, down[mix], S.ytg[ix[mix]], yl[mix])
            pr = self.lib.pass_rate[fk]
            lg = np.log(pr / (1 - pr)) + self.ctx.proe[o[mix]] / np.maximum(pr * (1 - pr), 0.1)
            crit = aware[mix] & (S.to[ix[mix], o[mix]] == 0) & (t_half[mix] <= CLOCK_PASS_WINDOW)
            lg = lg + CLOCK_PASS_SHIFT * crit
            kind[mix] = np.where(u[ix[mix], 1] < 1 / (1 + np.exp(-lg)), PASS, RUN)

        # (4) execute
        scr = np.isin(kind, [RUN, PASS, KNEEL, SPIKE])
        if scr.any():
            self._scrimmage(S, u, ix[scr], o[scr], kind[scr], margin[scr], aware[scr], closing[scr], running_at_snap[scr])
        m = kind == FG
        if m.any():
            self._field_goal(S, u, ix[m], o[m], fire[m])
        m = kind == PUNT
        if m.any():
            self._punt(S, u, ix[m], o[m])

    # ------------------------------------------------------- fourth downs ---
    def _coach_choice(self, S, ix, o, margin, t_half, p_fg, u5, choice):
        """Replace the sound choice with a draw from a typical / specific coach's 4th-down tendencies."""
        from .tendency import features_from_raw
        for team in (0, 1):
            cm = self.ctx.coach4th[team] if self.ctx.coach4th is not None else None
            m = o == team
            if cm is None or not m.any():
                continue
            mod = cm["model"]
            j = ix[m]
            X = features_from_raw(t_half[m], float(self.half == 2), margin[m], 4, S.ytg[j], S.yl[j],
                                  S.to[j, team], S.to[j, 1 - team], 0.0)
            Z = (X - np.array(mod["mean"])) / np.array(mod["scale"])
            z = Z @ np.array(mod["coef"]).T + np.array(mod["intercept"])
            cls = mod["classes"]
            z[:, cls.index("go")] += cm.get("shift", 0.0)
            z -= z.max(axis=1, keepdims=True)
            p = np.exp(z)
            p[:, cls.index("fg")] *= p_fg[m] > 0.02
            p[:, cls.index("punt")] *= S.yl[j] >= 30
            p /= p.sum(axis=1, keepdims=True)
            cum = np.cumsum(p, axis=1)
            pick = (u5[m][:, None] > cum).sum(axis=1)
            pick = np.minimum(pick, len(cls) - 1)
            code = {"go": -1, "fg": FG, "punt": PUNT}
            choice[m] = np.array([code[c] for c in cls])[pick]
        return choice

    def _fourth_down(self, S, ix, o, margin, t_half, p_fg, u5=None):
        """One-step WP look-ahead (go / FG / punt) with end-of-half overrides."""
        half = self.half
        d = 1 - o
        yl, ytg = S.yl[ix], np.clip(S.ytg[ix], 1, 20)
        t = S.t[ix]
        off_to, def_to = S.to[ix, o], S.to[ix, d]
        mode = L.game_mode(half, t_half, margin)
        zone = L.zone_of(yl)
        p_conv = np.where(o == 0, self.conv[0][mode, zone, ytg.astype(int)],
                          self.conv[1][mode, zone, ytg.astype(int)])
        gain = np.maximum(ytg, np.minimum(6.0, yl))
        td_conv = yl <= ytg
        new_yl = np.maximum(yl - gain, 1.0)
        n = ix.size
        # batch every WP query into one model call
        q_team = np.concatenate([o, d, d, d, d, d])
        q_margin = np.concatenate([margin, -margin, -(margin + 7), -(margin + 3), -margin, -margin])
        q_t = np.maximum(np.concatenate([t - 6, t - 6, t - 6, t - 5, t - 5, t - 9]), self.half_end + 1.0)
        q_yl = np.concatenate([new_yl, 100 - yl, np.full(n, self.kickoff_start), np.full(n, self.kickoff_start),
                               self._miss_yl(yl),
                               self._punt_receive_yl(yl, o)])
        q_ytg = np.minimum(10.0, q_yl)
        q_ytg[:n] = np.minimum(10.0, new_yl)
        q_off_to = np.concatenate([off_to, def_to, def_to, def_to, def_to, def_to])
        q_def_to = np.concatenate([def_to, off_to, off_to, off_to, off_to, off_to])
        w = self.wp(q_team, q_margin, q_t, np.ones(6 * n), q_ytg, q_yl, q_off_to, q_def_to)
        w = w.reshape(6, n)
        wp_conv = np.where(td_conv, 1 - w[2], w[0])
        wp_go = p_conv * wp_conv + (1 - p_conv) * (1 - w[1])
        wp_fg = p_fg * (1 - w[3]) + (1 - p_fg) * (1 - w[4])
        wp_punt = 1 - w[5]
        wp_fg = np.where(p_fg > 0.02, wp_fg, -1.0)
        wp_punt = np.where(yl >= 35, wp_punt, -1.0)
        # the sound choice, as NFL coaches make it (FOURTH_GO_EDGE, FOURTH_KICK_P)
        behind_late = (half == 2) & (margin < 0) & ((t_half <= 180) | ((margin <= -4) & (t_half <= 300))
                                                    | ((margin <= -9) & (t_half <= 420)))
        wp_punt = np.where((half == 2) & (margin <= -9) & (t_half <= 300) & (yl < 50), -1.0, wp_punt)
        kick = np.maximum(wp_fg, wp_punt)
        choice = np.where((kick < 0) | (wp_go >= kick + np.where(behind_late, 0.0, FOURTH_GO_EDGE)), -1,
                          np.where(wp_fg >= wp_punt, FG, PUNT))
        choice = np.where((choice == -1) & (wp_punt >= 0) & ~behind_late & (yl >= 50) & ((ytg >= 2) | (yl >= 80)),
                          PUNT, choice)
        choice = np.where((half == 2) & (t_half <= 300) & (margin >= -3) & (margin <= 0) & (ytg >= 2)
                          & (p_fg >= FOURTH_KICK_P), FG, choice)
        if u5 is not None and self.ctx.coach4th is not None and any(c is not None for c in self.ctx.coach4th):
            choice = self._coach_choice(S, ix, o, margin, t_half, p_fg, u5, choice)
        # Hard end-of-game logic the WP model cannot know precisely.
        if half == 2:
            late = t_half <= 40
            choice = np.where(late & (margin < -3), -1, choice)
            choice = np.where(late & (margin >= -3) & (margin <= 0) & (p_fg >= 0.3), FG, choice)
            choice = np.where(late & (margin >= -3) & (margin < 0) & (p_fg < 0.3), -1, choice)  # trailing: must go
            nb = NO_PUNT_BEHIND
            no_punt = (margin < 0) & (margin >= -nb[0]) & ((t_half <= nb[1]) | ((margin <= -nb[2]) & (t_half <= nb[3])))
            choice = np.where(no_punt & (choice == PUNT), -1, choice)
            # Tied and out of range: punt and play for overtime (the WP model overrates late possession here).
            tied_punt = (margin == 0) & (p_fg < 0.3) & (yl >= 35) & (late | ((t_half <= 120) & (yl >= 50)))
            choice = np.where(tied_punt, PUNT, choice)
        else:
            choice = np.where((t_half <= 20) & (p_fg >= 0.2), FG, choice)
            choice = np.where((t_half <= 20) & (p_fg < 0.2) & (choice == PUNT) & (yl < 60), -1, choice)
        return choice

    def _punt_receive_yl(self, yl, team):
        net = self.exp_net[np.clip(yl.astype(int), 0, 100)] + self.ctx.punter_shift[team]
        spot = yl - net
        return np.where(spot <= 0, 80.0, np.clip(100 - spot, 1, 99))

    # ---------------------------------------------------- play execution ---
    def _clock_after_play(self, S, ix, dur, stop_flags, credit):
        """Run game clock during the play; decide whether it keeps running."""
        t0 = S.t[ix]
        t1 = t0 - dur
        cross_tmw = (t0 > self.tmw) & (t1 <= self.tmw)
        cross_q = (t0 > self.q_end) & (t1 <= self.q_end)
        t1 = np.where(cross_q, np.maximum(t1, self.q_end), t1)
        S.t[ix] = np.where(t1 <= self.half_end + CLOCK_EPS, self.half_end, t1)
        S.running[ix] = ~(stop_flags | cross_tmw | cross_q)
        S.credit[ix] = np.where(S.running[ix], credit, 0.0)

    def _scrimmage(self, S, u, ix, o, kind, margin, aware=None, closing=None, running_at_snap=None):
        d = 1 - o
        R = self.R
        n = ix.size
        yl0 = S.yl[ix]
        ytg0 = S.ytg[ix]
        down0 = S.down[ix]
        F = self.F
        lib_rows = np.zeros(n, dtype=np.int64)
        lib_play = (kind == RUN) | (kind == PASS)
        if lib_play.any():
            t_half = S.t[ix] - self.half_end
            mode = L.game_mode(self.half, t_half, margin)
            if closing is not None:   # running the clock down for a kick: the clock-killing play mix
                mode = np.where(closing, L.MODE_KILL, mode)
            fk = L.fine_key(mode, down0, ytg0, yl0)
            for team in (0, 1):
                m = lib_play & (o == team)
                if m.any():
                    lib_rows[m] = self.lib.sample(self.cdf[team], np.where(kind[m] == PASS, 1, 0), fk[m],
                                                  u[ix[m], 2])
            if aware is not None:
                # no timeouts and the clock must stop: sideline throws and throw-aways replace some
                # in-bounds gains (redrawn from the same pool's clock-stopping passes)
                (t1, k1), (t2, k2) = CLOCK_AWARE
                keep_p = np.where(t_half <= t1, k1, np.where(t_half <= t2, k2, 1.0))
                swap = np.flatnonzero(lib_play & (kind == PASS) & aware & (S.to[ix, o] == 0)
                                      & self.live_gain[lib_rows] & (u[ix, 6] >= keep_p))
                if swap.size:
                    pool = self.lib.pool_of[1, fk[swap]]
                    for team in (0, 1):
                        m = o[swap] == team
                        if m.any():
                            r = self.lib.sample_subset(self.stop_cdf[team], self.stop_pos, self.stop_off, pool[m],
                                                       u[ix[swap[m]], 7])
                            lib_rows[swap[m]] = np.where(r >= 0, r, lib_rows[swap[m]])
        g = lambda f: np.where(lib_play, F[f][lib_rows], 0)
        yards = g("yards").astype(float)
        penalty = g("penalty").astype(bool)
        auto_fd = g("auto_fd").astype(bool)
        incomplete = g("incomplete").astype(bool)
        oob = g("oob").astype(bool)
        td_off = g("td_off").astype(bool)
        td_def = g("td_def").astype(bool)
        turnover = g("turnover").astype(bool)
        to_rel = g("to_rel").astype(float)
        dur = g("duration").astype(float)
        kn = kind == KNEEL
        sp = kind == SPIKE
        yards = np.where(kn, -np.minimum(1.0, 99.0 - yl0), yards)  # no kneel-down safeties
        dur = np.where(kn, self.kneel_dur, np.where(sp, self.spike_dur, dur))
        # Leading with seconds left: the QB holds the ball / runs around until the clock hits zero.
        t_half0 = S.t[ix] - self.half_end
        burn = (margin > 0) & (t_half0 <= BURN_SECONDS) & ~sp
        dur = np.where(burn, np.maximum(dur, t_half0 + 0.5), dur)
        incomplete |= sp
        # penalty yardage limits (half the distance; spot fouls to the 1)
        big = yards >= 15
        yards = np.where(penalty & (yards > 0), np.where(big, np.minimum(yards, yl0 - 1), np.minimum(yards, yl0 / 2)),
                         yards)
        yards = np.where(penalty & (yards < 0), -np.minimum(-yards, (100 - yl0) / 2), yards)

        new_yl = yl0 - yards
        # a real fumble drawn closer to the goal than it happened: he crossed the goal line with the ball before
        # losing it, a touchdown (players saw a receiver fumble standing in the end zone)
        crossed = turnover & ~penalty & (yards > 0) & (new_yl <= 0)
        turnover = turnover & ~crossed
        td_def = td_def & ~crossed
        td_off = td_off | (~turnover & ~penalty & (new_yl <= 0))
        # a safety is where the play ends: a library safety from the 1 drawn at the 11 is a loss of a yard
        safety = ~turnover & ~td_off & (new_yl >= 100)
        # turnover spots, in the new offense's frame
        to_yl = 100 - (yl0 - to_rel)
        td_def = td_def | (turnover & (to_yl <= 0))
        to_yl = np.where(to_yl >= 100, 80.0, np.clip(to_yl, 1, 99))
        fd = (yards >= ytg0) | auto_fd
        new_down = np.where(fd, 1, np.where(penalty, down0, down0 + 1))
        new_ytg = np.where(fd, np.minimum(10.0, np.maximum(new_yl, 1)), ytg0 - yards)
        on_downs = ~fd & (new_down > 4) & ~turnover & ~td_off & ~safety & ~td_def
        change = turnover | on_downs
        score_play = td_off | td_def | safety
        # the out-of-bounds window is judged where the play ends, not at the snap
        left = S.t[ix] - dur - self.half_end
        in_win = left <= self.oob_window
        # a foul: NFL, the clock stopped till the snap inside the oob window; college and high school (penStop), on the
        # ready-for-play, unless late in the half the offended team (behind or tied: it wants the clock stopped) takes
        # the snap start
        fouler = np.where(yards < 0, o, d)
        off_m = S.score[ix, 1 - fouler] - S.score[ix, fouler]
        pen_stop = penalty & ((left <= R["penStop"]["window"]) & (off_m <= 0) if R["penStop"] else in_win)
        # a first down (college late in the half, high school always): stopped for the chains, restarted on the
        # ready-for-play: the clock runs for the next snap, its seconds stopped given back (the credit)
        fd_stop = (fd & ~change & ~score_play & (left <= R["fdStop"]["window"])) if R["fdStop"] else np.zeros(n, bool)
        stop = incomplete | (oob & in_win) | pen_stop | change | score_play
        credit = np.where(oob, self.oob_credit, np.where(penalty, self.pen_credit, np.where(fd_stop, self.fd_credit, 0.0)))
        t0 = S.t[ix].copy()
        # college (3-4-4): late in the half, a foul that stops a running clock (a pre-snap foul: none of it runs) takes 10
        # seconds off at the offended team's option (ahead; tied, the defense), the clock then starting on the ready; the
        # fouling team (behind or tied) spends a timeout to keep them, and a runoff declined or kept by a timeout starts
        # the clock on the snap
        ro10 = np.zeros(n, bool)
        if R["runoff10"] and running_at_snap is not None:
            elig = (penalty & (dur == 0) & running_at_snap & ~change & ~score_play
                    & ((t0 - self.half_end) <= R["runoff10"]["window"]))
            wants = elig & ((off_m > 0) | ((off_m == 0) & (fouler == o)))
            has_to = S.to[ix, fouler] > 0
            spend = wants & has_to
            if spend.any():
                S.to[ix[spend], fouler[spend]] -= 1
            ro10 = wants & ~has_to
            stop = (stop | elig) & ~ro10
            credit = np.where(ro10, self.pen_credit, credit)
        # a state's running clock (runClock): only a score stops it; 'wide' gives penalty enforcement its ready restart
        rc = self._rc(S, ix)
        if rc.any():
            stop = np.where(rc, score_play, stop)
            credit = np.where(rc, np.where(penalty & (R["runClock"]["stops"] == "wide"), self.pen_credit, 0.0), credit)
        self._clock_after_play(S, ix, dur, stop, credit)
        run1 = S.running[ix].copy()
        # a half cannot end on an accepted foul (NFL: a defensive one): an untimed down
        untimed = (penalty & ((R["untimed"] == "any") | (yards > 0)) & ~change & ~score_play & ~ro10
                   & (S.t[ix] <= self.half_end))
        S.t[ix] = np.where(untimed, np.minimum(t0, self.half_end + 0.5), S.t[ix])
        if ro10.any():
            t10 = S.t[ix] - 10.0
            S.t[ix] = np.where(ro10, np.where(t10 <= self.half_end + CLOCK_EPS, self.half_end, t10), S.t[ix])
            S.running[ix] = np.where(ro10, S.running[ix] & (S.t[ix] > self.half_end), S.running[ix])

        # state transitions
        keep = ~change & ~score_play
        S.yl[ix[keep]] = np.clip(new_yl[keep], 1, 99)
        S.down[ix[keep]] = new_down[keep]
        S.ytg[ix[keep]] = np.maximum(new_ytg[keep], 1.0)
        m = turnover & ~td_def
        if m.any():
            self._flip(S, ix[m], to_yl[m])
        m = on_downs
        if m.any():
            self._flip(S, ix[m], 100 - np.clip(new_yl[m], 1, 99))
        m = td_off
        if m.any():
            S.score[ix[m], o[m]] += 6
            S.phase[ix[m]] = PAT
        m = td_def & ~td_off
        if m.any():
            S.score[ix[m], d[m]] += 6
            S.pos[ix[m]] = d[m]
            S.phase[ix[m]] = PAT
        m = safety & ~td_off & ~td_def
        if m.any():
            S.score[ix[m], d[m]] += 2
            S.phase[ix[m]] = KICKOFF   # pos stays with the conceding team, which free-kicks
            S.free_kick[ix[m]] = True
        m = rc & change
        if m.any():
            S.running[ix[m]] = run1[m]
        self._end_half_check(S, ix)

    def _field_goal(self, S, u, ix, o, fire=None):
        d = 1 - o
        yl0 = S.yl[ix]
        p = self.fg_prob(yl0 + FG_SNAP_YARDS, o)
        if fire is not None and fire.any():
            z = np.log(np.clip(p, 1e-9, 1 - 1e-9) / np.clip(1 - p, 1e-9, 1)) + FIRE_DRILL_LOGIT
            p = np.where(fire, np.where(p > 0, 1 / (1 + np.exp(-z)), 0.0), p)
        made = u[ix, 3] < p
        rc = self._rc(S, ix) & ~made
        self._clock_after_play(S, ix, np.full(ix.size, 5.0), ~rc, 0.0)
        run1 = S.running[ix].copy()
        if made.any():
            S.score[ix[made], o[made]] += 3
            S.phase[ix[made]] = KICKOFF
        miss = ~made
        if miss.any():
            self._flip(S, ix[miss], self._miss_yl(yl0[miss]))
        if rc.any():
            S.running[ix[rc]] = run1[rc]
        self._end_half_check(S, ix)

    def _punt(self, S, u, ix, o):
        d = 1 - o
        yl0 = S.yl[ix]
        yi = np.clip(yl0.astype(int), 0, 100)
        lo, hi = self.punt_lo[yi], self.punt_hi[yi]
        j = lo + (u[ix, 4] * (hi - lo)).astype(int)
        j = np.minimum(j, hi - 1)
        P = self.punt
        net = P["net"][j].copy()
        normal = ~P["blocked"][j] & ~P["ret_td"][j] & ~P["touchback"][j]
        # the punter's rating moves the net by a fraction of a yard: the ball still lands on a whole yard line (rounded
        # up or down by chance, so the rating keeps its mean; a spot at the 5.24 read "at the 5" and a 5-yard gain from
        # it was no touchdown)
        net = np.where(normal, np.floor(net + self.ctx.punter_shift[o] + u[ix, 3]), net)
        spot = yl0 - net
        recv_yl = np.where(P["touchback"][j] | (spot <= 0), 80.0, np.clip(100 - spot, 1, 99))
        ret = P["ret_td"][j]
        rc = self._rc(S, ix) & ~ret
        self._clock_after_play(S, ix, P["duration"][j], ~rc, 0.0)
        run1 = S.running[ix].copy()
        if (~ret).any():
            self._flip(S, ix[~ret], recv_yl[~ret])
        if rc.any():
            S.running[ix[rc]] = run1[rc]
        if ret.any():
            S.score[ix[ret], d[ret]] += 6
            S.pos[ix[ret]] = d[ret]
            S.phase[ix[ret]] = PAT
        self._end_half_check(S, ix)

    def _flip(self, S, ix, new_yl):
        S.pos[ix] = 1 - S.pos[ix]
        S.yl[ix] = new_yl
        S.down[ix] = 1
        S.ytg[ix] = np.minimum(10.0, new_yl)
        S.running[ix] = False
        S.credit[ix] = 0.0

    def _end_half_check(self, S, ix):
        over = (S.t[ix] <= self.half_end) & (S.phase[ix] == SNAP)
        S.phase[ix[over]] = DONE
        # a score as time expires still gets its (untimed) PAT, unless it cannot change the result; skip the kickoff
        ko_over = (S.t[ix] <= self.half_end) & (S.phase[ix] == KICKOFF)
        S.phase[ix[ko_over]] = DONE
        self._no_try(S, ix)

    def _no_try(self, S, ix):
        """A touchdown as the fourth quarter runs out: no try when it cannot change the result (NFL since 2018), a lead
        or a deficit of 3 or more (a try is worth 2 at most, to either team: the defense can return one for 2); college
        and high school (tryForego) nor a lead of 1-2 (college: the option to forego it; high school: the defense cannot
        score)."""
        if self.half != 2 or not ix.size:
            return
        p = S.pos[ix]
        m = S.score[ix, p] - S.score[ix, 1 - p]
        skip = (np.abs(m) >= 3) | ((m > 0) & self.R["tryForego"])
        S.phase[ix[(S.phase[ix] == PAT) & (S.t[ix] <= self.half_end) & skip]] = DONE

    # --------------------------------------------------------------- value ---
    def _value(self, S, perspective):
        home_margin = S.score[:, 0] - S.score[:, 1]
        live = S.phase != DONE
        if self.half == 2:
            v_home = np.where(home_margin > 0, 1.0, np.where(home_margin < 0, 0.0, self.ctx.ot_wp_home))
        else:
            r = self.ctx.receive_2h
            m_r = home_margin if r == 0 else -home_margin
            n = len(home_margin)
            tph = self.R["toPerHalf"]
            w = self.wp(np.full(n, r), m_r, np.full(n, 2.0 * self.R["quarter"]), np.ones(n), np.full(n, 10.0),
                        np.full(n, self.kickoff_start), np.full(n, tph), np.full(n, tph))
            v_home = w if r == 0 else 1 - w
        if live.any():  # truncated rollouts (should be rare): fall back to the WP model
            ix = np.flatnonzero(live)
            o = S.pos[ix]
            w = self.wp(o, S.score[ix, o] - S.score[ix, 1 - o], S.t[ix], S.down[ix], S.ytg[ix], S.yl[ix],
                        S.to[ix, o], S.to[ix, 1 - o])
            v_home[ix] = np.where(o == 0, w, 1 - w)
        return v_home if perspective == 0 else 1 - v_home
