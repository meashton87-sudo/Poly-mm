"""Live game console: type the situation, get every option simulated.

    nflclock live 2026_05_BUF_LA

Situation lines use scoreboard order (AWAY first, then HOME) and accept tokens in any order:

    q4 2:31 BUF 20 LA 24 ball BUF 2&7 LA41 to 2-3 run
    q2 0:48 17-14 ball LA 1&10 own25 to 1-2            (score/timeouts as away-home)
    q4 1:12 24-27 ball BUF 4&3 LA38 to 0-1
    q4 5:02 24-21 try BUF                               (PAT decision for the scoring team)
    q4 1:55 21-24 kick BUF to 2-3                        (kickoff decision: onside or deep)

Commands: help | state | again | sims 8000 | r2h LA | set LA kicker -0.2 | set BUF off_pass -0.03 |
          qb BUF backup | reset | sync | quit
"""
from __future__ import annotations

import re
import shlex
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import live
from .models import Bundle
from .sim import KICKOFF, PAT, SNAP, RootState, Simulator

OPTION_HELP = {
    "timeout": "call timeout now", "no_timeout": "let the clock run", "hurry": "hurry to the line (no stop)",
    "normal": "normal tempo", "milk": "milk the play clock", "spike": "spike it", "kneel": "kneel",
    "run": "run", "pass": "pass", "go": "go for it", "fg": "field goal", "punt": "punt",
    "attack": "attack before half", "runout": "run out the half", "xp": "kick PAT", "two": "go for two",
    "onside": "onside kick", "deep": "deep kick",
}


@dataclass
class LiveState:
    qtr: int = 1
    clock: float = 900.0
    score: list = field(default_factory=lambda: [0, 0])      # away, home
    pos: str | None = None
    down: int = 1
    ytg: float = 10.0
    yl: float = 75.0                                          # yards to the goal the offense attacks
    to: list = field(default_factory=lambda: [3, 3])         # away, home
    running: bool = False
    phase: str = "snap"

    @property
    def game_seconds(self) -> float:
        return max(0, 4 - self.qtr) * 900 + self.clock if self.qtr <= 4 else self.clock


def _clock(s: float) -> str:
    s = max(0, int(round(s)))
    return f"{s // 60}:{s % 60:02d}"


def parse(line: str, st: LiveState, away: str, home: str) -> LiveState:
    """Update the state from a free-form situation line (unmentioned fields keep their value)."""
    toks = line.replace(",", " ").split()
    teams = {away.lower(): away, home.lower(): home}
    new = LiveState(**{**st.__dict__, "score": list(st.score), "to": list(st.to)})
    i = 0
    while i < len(toks):
        t = toks[i].lower()
        nxt = toks[i + 1].lower() if i + 1 < len(toks) else ""
        if re.fullmatch(r"q[1-5]|ot", t):
            new.qtr = 5 if t == "ot" else int(t[1])
        elif re.fullmatch(r"\d{1,2}:\d{2}", t):
            m, s = t.split(":")
            new.clock = int(m) * 60 + int(s)
        elif re.fullmatch(r"\d{1,2}-\d{1,2}", t) and not (i > 0 and toks[i - 1].lower() == "to"):
            a, h = t.split("-")
            new.score = [int(a), int(h)]
        elif t == "to" and re.fullmatch(r"[0-3]-[0-3]", nxt):
            a, h = nxt.split("-")
            new.to = [int(a), int(h)]
            i += 1
        elif t in ("ball", "poss", "try", "pat", "kick", "kickoff", "ko") and nxt in teams:
            new.pos = teams[nxt]
            new.phase = "pat" if t in ("try", "pat") else ("kickoff" if t in ("kick", "kickoff", "ko") else "snap")
            if new.phase == "snap" and st.phase != "snap":
                new.running = False
            i += 1
        elif t in teams and re.fullmatch(r"\d{1,2}", nxt):
            # "BUF 20" is a score; a spot is written "BUF35", "at BUF 35", "own35" or "opp35"
            if not (i > 0 and toks[i - 1].lower() in ("at", "@")):
                idx = 0 if teams[t] == away else 1
                new.score[idx] = int(nxt)
            else:
                new.yl = _spot(teams[t], int(nxt), new.pos)
            i += 1
        elif re.fullmatch(r"@?[a-z]{2,3}\d{1,2}", t) and re.sub(r"[@\d]", "", t) in teams:
            team = teams[re.sub(r"[@\d]", "", t)]
            new.yl = _spot(team, int(re.sub(r"\D", "", t)), new.pos)
        elif re.fullmatch(r"(own|opp)\d{1,2}", t) or (t in ("own", "opp") and nxt.isdigit()):
            if t in ("own", "opp"):
                t, i = t + nxt, i + 1
            n = int(re.sub(r"\D", "", t))
            new.yl = 100 - n if t.startswith("own") else n
        elif t in ("50", "midfield"):
            new.yl = 50.0
        elif re.fullmatch(r"[1-4](st|nd|rd|th)?&(\d{1,2}|g|goal)", t):
            d, y = t.split("&")
            new.down = int(d[0])
            new.ytg = -1 if y in ("g", "goal") else float(y)
        elif t in ("run", "running", "r"):
            new.running = True
        elif t in ("stop", "stopped", "s"):
            new.running = False
        i += 1
    if new.ytg == -1 or new.ytg > new.yl:
        new.ytg = new.yl
    return new


def _spot(team: str, n: int, pos: str | None) -> float:
    """'LA 41' with BUF on offense -> 41 yards to go; with LA on offense -> 59."""
    if pos is None or team != pos:
        return float(n)
    return float(100 - n)


class LiveConsole:
    def __init__(self, game_id: str, sims: int = 6000):
        self.b = Bundle.load()
        self.rec = live.load_game(game_id)
        self.away, self.home = self.rec["away"]["team"], self.rec["home"]["team"]
        self.st = LiveState()
        self.r2h = None
        self.manual: dict = {}
        self.sims = sims
        self.history = []
        self.tendency = _load_tendency()
        self.grades = _load_grade_scale()

    # ------------------------------------------------------------ engine ---
    def sim(self):
        ctx, home, away = live.context_from_game(self.b, self.rec, self.r2h, self.manual)
        return Simulator(self.b, ctx), ctx

    def root(self) -> RootState:
        st = self.st
        pos = 0 if st.pos == self.home else 1
        return RootState(t=st.game_seconds, pos=pos, score=(st.score[1], st.score[0]), down=st.down, ytg=st.ytg,
                         yl=st.yl, to=(st.to[1], st.to[0]), clock_running=st.running,
                         phase={"snap": SNAP, "pat": PAT, "kickoff": KICKOFF}[st.phase])

    def options(self, sim: Simulator, root: RootState) -> dict:
        """{deciding team index: {option: action}} for the current state."""
        st = self.st
        o = root.pos
        d = 1 - o
        out = {}
        if st.phase == "pat":
            return {o: {"xp": {"pat": "xp"}, "two": {"pat": "two"}}}
        if st.phase == "kickoff":
            return {o: {"deep": {"kick": "deep"}, "onside": {"kick": "onside"}}}
        first_half = st.qtr <= 2
        lead = root.score[o] - root.score[d]
        off = {}
        if st.running:
            if root.to[o] > 0:
                off["timeout"] = {"to_off": True}
            off["hurry"] = {"to_off": False, "tempo": "urgent"}
            off["normal"] = {"to_off": False, "tempo": "normal"}
            off["milk"] = {"to_off": False, "tempo": "milk"}
            if st.down <= 3:
                off["spike"] = {"to_off": False, "play": "spike"}
        if st.down == 4:
            off["go"] = {"play": "go", "to_off": False}
            if sim.fg_prob(np.array([root.yl + 17.0]), np.array([o]))[0] >= 0.02:
                off["fg"] = {"play": "fg", "to_off": False}
            if root.yl >= 30:
                off["punt"] = {"play": "punt", "to_off": False}
        elif not st.running:
            off["run"] = {"play": "run"}
            off["pass"] = {"play": "pass"}
        if st.down < 4 and (lead > 0 or (first_half and root.yl >= 50)):
            off["kneel"] = {"play": "kneel", "to_off": False}
        if first_half and root.t - 1800 <= 150:
            off["attack"] = {"h1": "attack"}
            off["runout"] = {"h1": "runout"}
        if len(off) >= 2:
            out[o] = off
        if st.running and root.to[d] > 0:
            out[d] = {"timeout": {"to_def": True}, "no_timeout": {"to_def": False}}
        return out

    def evaluate(self):
        sim, ctx = self.sim()
        root = self.root()
        opts = self.options(sim, root)
        seed = int(time.time()) % 100000
        results = {}
        for team_idx, team_opts in opts.items():
            vals = {k: sim.run(root, n=self.sims, action=a, perspective=team_idx, seed=seed)
                    for k, a in team_opts.items()}
            best = max(vals, key=lambda k: vals[k].mean())
            rows = []
            for k, v in vals.items():
                dlt = v - vals[best]
                cost = -float(dlt.mean())
                rows.append({"option": k, "wp": float(v.mean()), "edge": -cost,
                             "se": float(dlt.std(ddof=1) / np.sqrt(len(v))) if k != best else 0.0,
                             "grade": _grade(self.grades, _family(k, self.st, team_idx == root.pos), cost),
                             "coaches": _coach_share(self.tendency, _family(k, self.st, team_idx == root.pos), k,
                                                     self.st, root, team_idx)})
            results[team_idx] = pd.DataFrame(rows).sort_values("wp", ascending=False)
        if not opts:
            v = sim.run(root, n=self.sims, perspective=0, seed=seed)
            results[None] = float(v.mean())
        return results, ctx

    # ---------------------------------------------------------- display ---
    def describe(self) -> str:
        st = self.st
        names = {self.away: self.away, self.home: self.home}
        spot = "midfield" if st.yl == 50 else (
            f"{st.pos} {int(100 - st.yl)}" if st.yl > 50 else f"{self.home if st.pos == self.away else self.away} {int(st.yl)}")
        what = {"snap": f"{st.pos} ball, {st.down}&{'goal' if st.ytg >= st.yl else int(st.ytg)} at {spot}",
                "pat": f"{st.pos} try after TD", "kickoff": f"{st.pos} kicking off"}[st.phase]
        return (f"Q{st.qtr} {_clock(st.clock)} | {names[self.away]} {st.score[0]} - {st.score[1]} {names[self.home]} | "
                f"{what} | TO {self.away} {st.to[0]}, {self.home} {st.to[1]} | clock {'running' if st.running else 'stopped'}"
                f"{'' if self.r2h is None else f' | 2nd-half kick: {self.r2h} receives'}")

    def show(self, results):
        team_name = {0: self.home, 1: self.away}
        for team_idx, df in results.items():
            if team_idx is None:
                print(f"  No decision point. {self.home} win probability: {df:.1%}")
                continue
            print(f"\n  {team_name[team_idx]} options ({self.sims:,} simulations each, common random numbers)")
            print(f"  {'option':<30}{'win prob':>9}{'vs best':>9}{'±':>6}   {'grade if chosen':<22}{'NFL coaches':>11}")
            for _, r in df.iterrows():
                share = "" if r["coaches"] is None else f"{r['coaches']:.0%}"
                print(f"  {OPTION_HELP.get(r['option'], r['option']):<30}{r['wp']:>9.1%}{r['edge'] * 100:>+9.1f}"
                      f"{r['se'] * 100:>6.1f}   {r['grade']:<22}{share:>11}")
            best = df.iloc[0]
            print(f"  -> {team_name[team_idx]}: {OPTION_HELP.get(best['option'], best['option']).upper()}")

    def header(self):
        r = self.rec
        lines = [f"{r['away']['team']} @ {r['home']['team']}  {r['gameday']} {r['gametime']} ET  {r['stadium']} ({r['roof']})",
                 f"Spread: {r['home']['team']} {-r['home_spread']:+.1f}  total {r['total']}  | synced {r['synced_at']} "
                 f"(depth chart {r['depth_chart_snapshot']})"]
        for side in ("away", "home"):
            t = r[side]
            info = live.effective(t, self.manual.get(t["team"]))
            lines.append(
                f"  {t['team']}: QB {t['qb']['name']} ({t['qb']['rating']:+.3f} EPA/db) | K {t['kicker']['name']} "
                f"({info.kicker_rating:+.2f}) | P {t['punter']['name']} ({info.punter_rating:+.1f} yds) | pass O "
                f"{info.off_pass:+.3f} rush O {info.off_rush:+.3f} pass D {info.def_pass:+.3f} rush D {info.def_rush:+.3f}")
            if t["unavailable"]:
                lines.append(f"     out/doubtful starters: {', '.join(t['unavailable'])}")
        return "\n".join(lines)

    # ---------------------------------------------------------- commands ---
    def command(self, line: str) -> bool:
        parts = shlex.split(line)
        cmd = parts[0].lower()
        if cmd in ("quit", "exit", "q"):
            return False
        if cmd == "help":
            print(__doc__)
        elif cmd == "state":
            print(self.describe())
        elif cmd == "sims" and len(parts) > 1:
            self.sims = int(parts[1])
        elif cmd == "r2h" and len(parts) > 1:
            self.r2h = parts[1].upper()
        elif cmd == "set" and len(parts) >= 4:
            team, key, val = parts[1].upper(), parts[2].lower(), float(parts[3])
            key = {"kicker": "kicker_rating", "punter": "punter_rating"}.get(key, key)
            self.manual.setdefault(team, {})[key] = val
            print(self.header())
        elif cmd == "qb" and len(parts) >= 3:
            self._qb_override(parts[1].upper(), parts[2].lower())
            print(self.header())
        elif cmd == "reset":
            self.manual = {}
        elif cmd == "sync":
            live.build_game(self.rec["game_id"], bundle=self.b)
            self.rec = live.load_game(self.rec["game_id"])
            print(self.header())
        elif cmd in ("again", "sim"):
            self.run_once()
        else:
            self.st = parse(line, self.st, self.away, self.home)
            self.history.append(self.st)
            self.run_once()
        return True

    def _qb_override(self, team: str, which: str):
        side = "home" if self.rec["home"]["team"] == team else "away"
        t = self.rec[side]
        if which == "backup":
            # a backup plays like the prior (a QB we know little about) unless a rating exists
            adj = live.QB_SHARE_OF_PASSING * (live.QB_PRIOR_MEAN - t["qb"]["team_mix_rating"]) - t["qb"]["adjustment"]
            self.manual.setdefault(team, {})["off_pass"] = self.manual.get(team, {}).get("off_pass", 0.0) + adj
            print(f"{team}: backup QB -> pass offense {adj:+.3f} EPA/play")

    def run_once(self):
        if self.st.pos is None:
            print("Who has the ball? e.g. 'ball BUF'")
            return
        print("\n" + self.describe())
        t0 = time.time()
        results, _ = self.evaluate()
        self.show(results)
        print(f"  ({time.time() - t0:.1f}s)")

    def loop(self):
        print(self.header())
        print("Type a situation (or 'help'). Scoreboard order is AWAY then HOME.")
        while True:
            try:
                line = input("\nnflclock> ").strip()
            except EOFError:
                break
            if not line:
                continue
            try:
                if not self.command(line):
                    break
            except Exception as exc:  # keep the console alive during a game
                print(f"  could not read that ({exc}); try 'help'")


# ----------------------------------------------------- grades & tendency ---
def _family(option: str, st: LiveState, offense: bool) -> str:
    if st.phase == "pat":
        return "pat"
    if st.phase == "kickoff":
        return "onside"
    if not offense:
        return "def_timeout"
    if option in ("timeout", "hurry", "spike", "normal", "milk"):
        return "off_clock_stop"
    if option in ("go", "fg", "punt"):
        return "fourth_down"
    if option in ("attack", "runout"):
        return "h1_end"
    if option == "kneel":
        return "kneel"
    return "play_select"


def _load_grade_scale():
    from . import config
    p = config.ARTIFACT_DIR / "grade_scale.json"
    if p.exists():
        import json
        return json.loads(p.read_text())
    return None


def _grade(scale, family: str, cost: float) -> str:
    """Percentile of this cost among real NFL decisions of the same family (2023-25)."""
    if cost <= 0.0005:
        return "best option"
    if not scale or family not in scale:
        return f"costs {cost * 100:.1f} WP"
    q = np.array(scale[family]["cost_quantiles"])
    pct = float(np.searchsorted(q, cost) / len(q))
    letter = next(lbl for thr, lbl in scale["letters"] if pct <= thr)
    return f"{letter}: worse than {pct:.0%}"


def _load_tendency():
    from . import config
    p = config.ARTIFACT_DIR / "tendency.pkl"
    if p.exists():
        import pickle
        with open(p, "rb") as f:
            return pickle.load(f)
    return None


def _coach_share(tend, family, option, st: LiveState, root: RootState, team_idx: int):
    if not tend or family not in tend:
        return None
    from .tendency import predict_share
    return predict_share(tend, family, option, st, root, team_idx)


def main(game_id: str, sims: int = 6000):
    LiveConsole(game_id, sims=sims).loop()
