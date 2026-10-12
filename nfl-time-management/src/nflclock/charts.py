"""Precomputed decision charts (league-average teams unless stated) for the report and playbooks."""
from __future__ import annotations

import json

import numpy as np

from . import config
from .context import TeamInfo, make_context
from .models import Bundle
from .sim import RootState, Simulator

N = 3000


def _sim(bundle, home=None, away=None, **kw):
    return Simulator(bundle, make_context(bundle, home or TeamInfo("HOME"), away or TeamInfo("AWAY"), **kw))


def _edge(sim, root, a, b, persp, n=N, seed=11):
    va = sim.run(root, n=n, action=a, perspective=persp, seed=seed)
    vb = sim.run(root, n=n, action=b, perspective=persp, seed=seed)
    d = va - vb
    return float(d.mean()), float(d.std(ddof=1) / np.sqrt(n)), float(va.mean()), float(vb.mean())


def defensive_timeout_chart(bundle):
    """Trailing defense, opponent just ran for 3 yds on 1st down near midfield, clock running."""
    sim = _sim(bundle)
    rows = []
    for lead in (3, 7):
        for t in (300, 270, 240, 210, 180, 150, 130):
            for to in (3, 2, 1):
                root = RootState(t=t, pos=0, score=(20 + lead, 20), down=2, ytg=7, yl=52, to=(3, to),
                                 clock_running=True)
                e, se, a, b = _edge(sim, root, {"to_def": True}, {"to_def": False}, persp=1)
                rows.append({"opp_lead": lead, "t": t, "def_to": to, "edge": e, "se": se, "wp_to": a, "wp_no": b})
    return rows


def end_of_half_chart(bundle):
    """Tied game, 1st & 10: attack vs. run out the first half."""
    sim = _sim(bundle)
    rows = []
    for t_half in (20, 35, 50, 65, 80, 100, 120):
        for own in (5, 15, 25, 35, 45):
            for to in (0, 1, 2, 3):
                root = RootState(t=1800 + t_half, pos=0, score=(10, 10), down=1, ytg=10, yl=100 - own, to=(to, 3))
                e, se, a, b = _edge(sim, root, {"h1": "attack"}, {"h1": "runout"}, persp=0, n=2000)
                rows.append({"t_half": t_half, "own_yl": own, "off_to": to, "edge": e, "se": se})
    return rows


def kicker_fourth_down_chart(bundle):
    """Q4, 1:50 left, trailing by 1, 4th & 4: go vs. FG by distance for bad/average/elite kickers."""
    rows = []
    for label, k in (("bad kicker (-0.4)", -0.4), ("average", 0.0), ("elite kicker (+0.4)", 0.4)):
        sim = _sim(bundle, home=TeamInfo("HOME", kicker_rating=k))
        for yl in (20, 25, 30, 35, 38, 41):
            root = RootState(t=110, pos=0, score=(19, 20), down=4, ytg=4, yl=yl, to=(2, 2))
            e, se, a, b = _edge(sim, root, {"play": "go"}, {"play": "fg"}, persp=0)
            p = float(sim.fg_prob(np.array([yl + 17.0]), np.array([0]))[0])
            rows.append({"kicker": label, "fg_distance": yl + 17, "p_make": p, "go_minus_fg": e, "se": se,
                         "wp_go": a, "wp_fg": b})
    return rows


def punter_fourth_down_chart(bundle):
    """Q4, 4:30 left, leading by 3, 4th & 2 at various spots: go vs. punt for bad/average/elite punters."""
    rows = []
    for label, pr in (("bad punter (-3 yds)", -3.0), ("average", 0.0), ("elite punter (+3 yds)", 3.0)):
        sim = _sim(bundle, home=TeamInfo("HOME", punter_rating=pr))
        for yl in (65, 58, 52, 46, 40):
            root = RootState(t=270, pos=0, score=(23, 20), down=4, ytg=2, yl=yl, to=(3, 3))
            e, se, a, b = _edge(sim, root, {"play": "go"}, {"play": "punt"}, persp=0)
            rows.append({"punter": label, "own_yl": 100 - yl, "go_minus_punt": e, "se": se, "wp_go": a, "wp_punt": b})
    return rows


def matchup_run_pass_chart(bundle):
    """Leading by 4, 3:10 left, 2nd & 6 at own 45, opponent 2 timeouts: run vs. pass by matchup."""
    profiles = {
        "elite run O vs weak run D": (TeamInfo("HOME", off_rush=0.08, off_pass=-0.05), TeamInfo("AWAY", def_rush=0.06)),
        "average vs average": (TeamInfo("HOME"), TeamInfo("AWAY")),
        "elite pass O vs weak pass D": (TeamInfo("HOME", off_pass=0.15, off_rush=-0.03), TeamInfo("AWAY", def_pass=0.1)),
        "weak pass O vs elite pass D": (TeamInfo("HOME", off_pass=-0.12), TeamInfo("AWAY", def_pass=-0.1)),
        "elite pass O vs elite run D": (TeamInfo("HOME", off_pass=0.15), TeamInfo("AWAY", def_rush=-0.08)),
    }
    rows = []
    for label, (h, a) in profiles.items():
        sim = _sim(bundle, home=h, away=a)
        root = RootState(t=190, pos=0, score=(24, 20), down=2, ytg=6, yl=55, to=(3, 2))
        e, se, wr, wpp = _edge(sim, root, {"play": "run"}, {"play": "pass"}, persp=0, n=6000)
        rows.append({"matchup": label, "run_minus_pass": e, "se": se, "wp_run": wr, "wp_pass": wpp})
    return rows


def kneel_table(bundle) -> list:
    """Most game clock a leading offense can kneel away (after the two-minute warning)."""
    sim = _sim(bundle)
    rows = []
    for down in (1, 2, 3):
        for running in (True, False):
            rec = {"situation": f"{['1st', '2nd', '3rd'][down - 1]} down, clock {'running' if running else 'stopped'}"}
            for to in range(4):
                lo, hi = 0.0, 200.0
                while hi - lo > 0.5:  # largest t_half that is still a guaranteed kneel-out
                    mid = (lo + hi) / 2
                    ok = sim.kneel_out_possible(np.array([mid]), np.array([down]), np.array([to]),
                                                np.array([running]), np.array([False]))[0]
                    lo, hi = (mid, hi) if ok else (lo, mid)
                rec[f"opp_to_{to}"] = int(lo)
            rows.append(rec)
    return rows


def build_all(bundle=None) -> dict:
    bundle = bundle or Bundle.load()
    out = {
        "defensive_timeouts": defensive_timeout_chart(bundle),
        "end_of_half": end_of_half_chart(bundle),
        "kicker_fourth_down": kicker_fourth_down_chart(bundle),
        "punter_fourth_down": punter_fourth_down_chart(bundle),
        "matchup_run_pass": matchup_run_pass_chart(bundle),
        "kneel": kneel_table(bundle),
    }
    config.REPORT_DIR.mkdir(exist_ok=True)
    (config.REPORT_DIR / "decision_charts.json").write_text(json.dumps(out, indent=1))
    return out
