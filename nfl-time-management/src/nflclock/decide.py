"""Decision engine: rank every clock / game-management option for a live situation."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import config
from .context import TeamInfo, make_context
from .models import Bundle
from .sim import KICKOFF, PAT, SNAP, RootState, Simulator

PERSONNEL_PATH = config.ARTIFACT_DIR / "personnel.json"


@dataclass
class Situation:
    """A game situation from the deciding team's ("us") point of view."""
    qtr: int
    clock: float                  # seconds left in the quarter
    score_us: int
    score_them: int
    possession: str = "us"        # "us" | "them"; for a kickoff, the kicking team; for a PAT, the scoring team
    down: int = 1
    ytg: float = 10
    yardline: float = 75          # yards from the offense to the goal line it attacks
    to_us: int = 3
    to_them: int = 3
    clock_running: bool = False
    us_home: bool = True
    phase: str = "snap"           # "snap" | "pat" | "kickoff"
    us: str | None = None         # team codes for ratings (latest available)
    them: str | None = None
    spread_us: float | None = None  # pregame spread from our view (+ = we are favoured)
    receive_2h: str = "them"      # who receives the 2nd-half kickoff
    indoor: bool = False
    wind: float = 0.0
    temp: float = 65.0
    overrides: dict = field(default_factory=dict)  # e.g. {"us": {"kicker_rating": -0.3}}

    @property
    def game_seconds(self) -> float:
        return float(max(0, 4 - self.qtr) * 900 + self.clock) if self.qtr <= 4 else float(self.clock)


def parse_clock(s: str) -> float:
    if ":" in str(s):
        m, sec = str(s).split(":")
        return int(m) * 60 + float(sec)
    return float(s)


def parse_yardline(s, offense_is_us: bool = True) -> float:
    """'own 25' -> 75, 'opp 30' -> 30, '50' -> 50, or a plain yards-to-goal number."""
    s = str(s).strip().lower()
    if s.startswith("own"):
        return 100.0 - float(s.split()[1])
    if s.startswith("opp"):
        return float(s.split()[1])
    return float(s)


def build_personnel(bundle: Bundle, pbp: pd.DataFrame) -> dict:
    """Latest kicker / punter per team with their latest ratings (saved for the CLI)."""
    season = int(pbp["season"].max())
    p = pbp[pbp["season"] >= season - 1].sort_values(["season", "week"])
    out = {}
    kr = bundle.kicker_ratings
    pr = bundle.punter_ratings
    kr_last = kr[kr["season"] == kr["season"].max()]
    kr_last = kr_last[kr_last["week"] == kr_last["week"].max()].set_index("kicker_player_id")["rating"]
    pr_last = pr[pr["season"] == pr["season"].max()]
    pr_last = pr_last[pr_last["week"] == pr_last["week"].max()].set_index("punter_player_id")["rating"]
    for team, g in p.groupby("posteam"):
        k = g[g["play_type"].isin(["field_goal", "extra_point"]) & g["kicker_player_id"].notna()].tail(1)
        u = g[(g["play_type"] == "punt") & g["punter_player_id"].notna()].tail(1)
        rec = {}
        if len(k):
            kid = k["kicker_player_id"].iat[0]
            rec.update(kicker=k["kicker_player_name"].iat[0], kicker_rating=float(kr_last.get(kid, 0.0)))
        if len(u):
            pid = u["punter_player_id"].iat[0]
            rec.update(punter=u["punter_player_name"].iat[0], punter_rating=float(pr_last.get(pid, 0.0)))
        out[team] = rec
    return out


class DecisionEngine:
    def __init__(self, bundle: Bundle | None = None):
        self.b = bundle or Bundle.load()
        tr = self.b.team_ratings
        last = tr[tr["season"] == tr["season"].max()]
        self.ratings = last[last["week"] == last["week"].max()].set_index("team")
        self.ratings_asof = (int(last["season"].max()), int(last["week"].max()))
        self.personnel = json.loads(PERSONNEL_PATH.read_text()) if PERSONNEL_PATH.exists() else {}

    def team_info(self, code: str | None, overrides: dict | None = None) -> TeamInfo:
        info = TeamInfo(team=code or "TEAM")
        if code and code in self.ratings.index:
            r = self.ratings.loc[code]
            info.off_pass, info.off_rush = float(r["off_pass"]), float(r["off_rush"])
            info.def_pass, info.def_rush = float(r["def_pass"]), float(r["def_rush"])
            info.proe = float(r["proe"])
        if code and code in self.personnel:
            p = self.personnel[code]
            info.kicker, info.punter = p.get("kicker"), p.get("punter")
            info.kicker_rating = p.get("kicker_rating", 0.0)
            info.punter_rating = p.get("punter_rating", 0.0)
        for k, v in (overrides or {}).items():
            setattr(info, k, v)
        return info

    def _setup(self, sit: Situation):
        us = self.team_info(sit.us, sit.overrides.get("us"))
        them = self.team_info(sit.them, sit.overrides.get("them"))
        if sit.spread_us is None:
            # Rating-implied spread: ~60 offensive plays each, 60/40 pass/run, home field ~1.5 pts.
            # Defensive ratings are EPA allowed above average (positive = worse defense).
            mix = lambda pa, ru: 0.6 * pa + 0.4 * ru
            ours = mix(us.off_pass + them.def_pass, us.off_rush + them.def_rush)
            theirs = mix(them.off_pass + us.def_pass, them.off_rush + us.def_rush)
            spread_us = 60.0 * (ours - theirs) + (1.5 if sit.us_home else -1.5)
        else:
            spread_us = sit.spread_us
        home, away = (us, them) if sit.us_home else (them, us)
        home_spread = spread_us if sit.us_home else -spread_us
        us_idx = 0 if sit.us_home else 1
        r2h = us_idx if sit.receive_2h == "us" else 1 - us_idx
        ctx = make_context(self.b, home, away, home_spread=home_spread, receive_2h=r2h, indoor=sit.indoor,
                           wind=sit.wind, temp=sit.temp, season=self.ratings_asof[0])
        pos_us = sit.possession == "us"
        pos = us_idx if pos_us else 1 - us_idx
        score = (sit.score_us, sit.score_them) if sit.us_home else (sit.score_them, sit.score_us)
        to = (sit.to_us, sit.to_them) if sit.us_home else (sit.to_them, sit.to_us)
        phase = {"snap": SNAP, "pat": PAT, "kickoff": KICKOFF}[sit.phase]
        root = RootState(t=sit.game_seconds, pos=pos, score=score, down=sit.down, ytg=sit.ytg,
                         yl=sit.yardline, to=to, clock_running=sit.clock_running, phase=phase)
        return ctx, root, us_idx, us, them

    def options(self, sit: Situation, sim: Simulator, root: RootState) -> dict:
        opts = {}
        pos_us = sit.possession == "us"
        if sit.phase == "pat":
            return {"kick PAT": {"pat": "xp"}, "go for 2": {"pat": "two"}} if pos_us else {}
        if sit.phase == "kickoff":
            return {"onside kick": {"kick": "onside"}, "deep kick": {"kick": "deep"}} if pos_us else {}
        first_half = sit.qtr <= 2
        lead = sit.score_us - sit.score_them
        if not pos_us:
            if sit.clock_running and sit.to_us > 0:
                opts["timeout now"] = {"to_def": True}
                opts["let clock run"] = {"to_def": False}
            return opts
        o = root.pos
        if sit.clock_running:
            if sit.to_us > 0:
                opts["timeout now"] = {"to_off": True}
            opts["hurry-up (no huddle)"] = {"to_off": False, "tempo": "urgent"}
            opts["normal tempo"] = {"to_off": False, "tempo": "normal"}
            opts["milk the play clock"] = {"to_off": False, "tempo": "milk"}
            if sit.down <= 3:
                opts["spike"] = {"to_off": False, "play": "spike"}
        if sit.down == 4:
            opts["go for it"] = {"play": "go", "to_off": False}
            p_fg = float(sim.fg_prob(np.array([root.yl + 17.0]), np.array([o]))[0])
            if p_fg >= 0.03:
                opts[f"field goal ({root.yl + 17:.0f} yds, {p_fg:.0%})"] = {"play": "fg", "to_off": False}
            if root.yl >= 30:
                opts["punt"] = {"play": "punt", "to_off": False}
        elif not sit.clock_running:
            opts["run"] = {"play": "run"}
            opts["pass"] = {"play": "pass"}
        if lead > 0 or (first_half and root.yl >= 50):
            if sit.down < 4:
                opts["kneel"] = {"play": "kneel", "to_off": False}
        if first_half and sit.game_seconds - 1800 <= 120:
            opts["attack: try to score before half"] = {"h1": "attack"}
            opts["run out the half"] = {"h1": "runout"}
        return opts

    def evaluate(self, sit: Situation, n: int = 4000, seed: int = 7) -> pd.DataFrame:
        ctx, root, us_idx, us, them = self._setup(sit)
        sim = Simulator(self.b, ctx)
        opts = self.options(sit, sim, root)
        if not opts:
            v = sim.run(root, n=n, perspective=us_idx, seed=seed)
            return pd.DataFrame([{"option": "(no decision for us) policy", "win_prob": v.mean(), "vs_best": 0.0,
                                  "se": v.std() / np.sqrt(n)}])
        vals = {name: sim.run(root, n=n, action=act, perspective=us_idx, seed=seed) for name, act in opts.items()}
        best = max(vals, key=lambda k: vals[k].mean())
        rows = []
        for name, v in vals.items():
            d = v - vals[best]
            rows.append({"option": name, "win_prob": float(v.mean()), "vs_best": float(d.mean()),
                         "se": float(d.std(ddof=1) / np.sqrt(n)) if name != best else 0.0})
        df = pd.DataFrame(rows).sort_values("win_prob", ascending=False).reset_index(drop=True)
        df.attrs.update(us=us, them=them, ctx=ctx, root=root)
        return df
