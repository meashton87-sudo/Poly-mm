"""Pro's scenarios: the rosters' export (nflclock.scenario) and the scenario format and its checks (web/scenario.js, run
in node): the overtime of each era the same as pro.py's, a code that reads back as the same scenario, and every
impossible state refused."""
import json
import shutil
import subprocess

import numpy as np
import pandas as pd
import pytest

from nflclock import dailygame as DG
from nflclock import history as HI
from nflclock import pro
from nflclock import scenario as S

WEB = DG.WEB
NODE = shutil.which("node")


def js(expr: str):
    """Evaluate expr in node with web/scenario.js as SC (JSON in, JSON out)."""
    if not NODE:
        pytest.skip("no node")
    src = f"const SC = require({json.dumps(str(WEB / 'scenario.js'))}); process.stdout.write(JSON.stringify((() => {{ {expr} }})()));"
    r = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


# ---- the export
def test_era_names_and_records():
    # every team by its city, never a nickname: the city of the time where the franchise played somewhere else
    assert S.era_name("LA", 2015) == {"name": "St. Louis"} and S.era_name("LA", 2016) is None
    assert S.era_name("LAC", 2016) == {"name": "San Diego"} and S.era_name("LAC", 2017) is None
    assert S.era_name("LV", 2019) == {"name": "Oakland"} and S.era_name("LV", 2020) is None and S.era_name("KC", 2001) is None
    assert S.era_name("WAS", 2001) is None and S.era_name("WAS", 2021) is None          # Washington, every season
    # the page's copy (web/scenario.js ERA: the historic drives' and the playoff runs' cities) is the same table
    assert js("return SC.ERA") == {k: [list(x) for x in v] for k, v in S.ERA_NAME.items()}
    assert js("return [[1999, 2001, 2015, 2016].map((y) => SC.eraName('LA', y)), SC.eraName('LAC', 2016), SC.eraName('LV', 2020)]") == \
        [["St. Louis", "St. Louis", "St. Louis", None], "San Diego", None]
    g = pd.DataFrame({"home_code": ["NE", "MIA", "NE"], "away_code": ["MIA", "NE", "NYJ"], "home_score": [20, 10, 17], "away_score": [10, 10, 24]})
    assert S.record(g, "NE") == "1-1-1" and S.record(g, "NYJ") == "1-0"


def test_pick_game_takes_the_usual_quarterback_and_kicker_before_the_last_week():
    weeks = list(range(1, 19))
    g = pd.DataFrame({"game_id": [f"g{w}" for w in weeks], "week": weeks, "home_code": ["KC"] * 18, "away_code": ["X"] * 18,
                      "home_qb_id": ["qb1"] * 15 + ["qb2", "qb1", "qb3"], "away_qb_id": ["o"] * 18})
    kick = {f"g{w}": ("k1" if w != 17 else "punter") for w in weeks}
    # week 18 (the last: starters rest) is out, week 17 had the punter kicking, week 16 the backup quarterback
    assert S.pick_game(g, "KC", False, kick)["week"] == 15
    assert S.pick_game(g, "KC", False, {})["week"] == 17          # no kicks known: the usual quarterback's latest
    assert S.pick_game(g, "KC", True, kick)["week"] == 15         # this season: the latest, the last week included
    assert S.pick_game(g.head(2), "KC", False, kick)["week"] == 2


def test_an_ordinary_snap():
    off = lambda *pos: {"lineup": {"off": [{"pos": p} for p in pos], "def": [{}] * 11}}       # noqa: E731
    assert S.ordinary(off("QB", "LT", "LG", "C", "RG", "RT", "WR", "WR", "WR", "TE", "RB"))
    assert not S.ordinary(off("QB", "LT", "LG", "C", "RG", "RT", "WR", "WR", "TE", "RB", "QB"))      # a wildcat snap
    assert not S.ordinary(off("QB", "LG", "C", "RG", "WR", "WR", "WR", "TE", "WR", "RB", "WR"))      # four linemen
    t = off("QB", "LT", "LG", "C", "RG", "RT", "WR", "WR", "WR", "TE", "RB")
    t["lineup"]["off"][0]["name"] = "Patrick Mahomes II"
    assert S.ordinary(t, "Patrick Mahomes") and not S.ordinary(t, "Taysom Hill")          # the game's starter


def test_qb_room_the_other_quarterbacks():
    """history.py _qb_room: a game's other quarterbacks are the ones on its roster that week (active, inactive or on a
    reserve list, never the practice squad or one cut) or throwing in it, not the one on the field; a team-season's, the
    season's (any regular-season week, any throw); most dropbacks first."""
    h = object.__new__(HI.History)
    weekly = pd.DataFrame({
        "week": [4, 4, 4, 4, 4, 3, 9, 19], "team": ["MIN"] * 7 + ["MIN"], "position": ["QB"] * 8,
        "status": ["ACT", "INA", "RES", "DEV", "CUT", "ACT", "ACT", "ACT"], "game_type": ["REG"] * 7 + ["WC"],
        "gsis_id": ["wentz", "mccarthy", "ir", "ps", "cut", "early", "late", "playoff"]})
    h.jerseys = {("weekly_qb", 2025): weekly}
    names = {i: i.title() for i in ["wentz", "mccarthy", "ir", "ps", "cut", "early", "late", "playoff", "trick"]}
    h.names, h.pos_now = names, {**{i: "QB" for i in names}, "trick": "WR"}
    h.pbp = pd.DataFrame({"game_id": ["2025_04_MIN_PIT"] * 3 + ["2025_09_MIN_DET"] * 2, "season": [2025] * 5, "posteam": ["MIN"] * 5,
                          "qb_dropback": [1] * 5, "passer_player_id": ["wentz", "wentz", "trick", "late", "mccarthy"]})
    R = type("R", (), {"gsis_to_pfr": {"mccarthy": "McCaJJ00"}})()
    # the game's (week 4): its active, inactive and injured-reserve quarterbacks, the one throwing first; a receiver's
    # throw makes no quarterback
    assert h._qb_room(R, 2025, 4, "MIN", "2025_04_MIN_PIT", {"wentz"}) == ["mccarthy", "ir"]
    assert h._qb_room(R, 2025, 4, "MIN", "2025_04_MIN_PIT", {"pfr:McCaJJ00", "wentz"}) == ["ir"]     # (on the field by his pfr id)
    assert h._qb_room(R, 2025, 6, "MIN", "2025_06_MIN_X", {"wentz"}) == ["mccarthy", "ir"]          # no week 6 roster: week 4's
    # the team-season's: any regular-season week (not the playoffs'), most dropbacks first
    assert h._qb_room(R, 2025, 19, "MIN", "2025_04_MIN_PIT", {"wentz"}, whole_season=True) == ["late", "mccarthy", "early", "ir"]


def test_strength_and_spread_fit():
    t = lambda op, qb, dp, orr, dr: {"base": {"off_pass": op, "def_pass": dp, "off_rush": orr, "def_rush": dr, "proe": 0}, "qb": {"adjustment": qb}}  # noqa: E731
    assert S.strength(t(0.1, 0.02, -0.05, 0.03, 0.01)) == pytest.approx(0.6 * 0.17 + 0.4 * 0.02)
    assert S.strength(t(0, 0, 0, 0, 0)) == 0
    # spreads made from known strengths come back as the fit: 2.5 points at home and 40 a point of net EPA
    rng = np.random.default_rng(1)
    nets = {(2010, c): float(v) for c, v in zip("ABCDEFGH", rng.normal(0, 0.08, 8))}
    rows = []
    for k in range(200):
        h, a = rng.choice(list("ABCDEFGH"), 2, replace=False)
        neutral = k % 10 == 0
        rows.append({"season": 2010, "game_type": "REG", "home_team": h, "away_team": a, "location": "Neutral" if neutral else "Home",
                     "spread_line": (0 if neutral else 2.5) + 40 * (nets[(2010, h)] - nets[(2010, a)])})
    fit = S.spread_fit(pd.DataFrame(rows), nets)
    assert fit["hfa"] == pytest.approx(2.5, abs=0.01) and fit["k"] == pytest.approx(40, abs=0.1) and fit["n"] == 200


def test_built_rosters():
    """The export as the site ships it (skipped where it has not been built: scenario.build)."""
    idx_p = WEB / "rosters" / "index.json"
    if not idx_p.exists():
        pytest.skip("web/rosters not built")
    idx = json.loads(idx_p.read_text())
    seasons = [s["season"] for s in idx["seasons"]]
    assert seasons == list(range(S.FIRST, DG.SEASON + 1))
    assert 1.5 < idx["spread"]["hfa"] < 3.5 and 25 < idx["spread"]["k"] < 70
    for s in idx["seasons"]:
        d = json.loads((WEB / "rosters" / f"{s['season']}.json").read_text())
        assert sorted(d["teams"]) == sorted(t["team"] for t in s["teams"])
        assert len(d["teams"]) == (31 if s["season"] < 2002 else 32)            # Houston from 2002
        assert {"mu_pass", "mu_rush", "home_pass", "home_rush"} <= set(d["league"])
        for code, t in d["teams"].items():
            L = t["lineup"]
            assert len(L["off"]) == 11 and len(L["def"]) == 11, (s["season"], code)
            assert sum(p["pos"] == "QB" for p in L["off"]) == 1 and [p["pos"] for p in L["off"][1:6]] == ["LT", "LG", "C", "RG", "RT"]
            assert all(40 <= p["ovr"] <= 99 for p in L["off"] + L["def"]), (s["season"], code)
            assert t["kicker"]["name"] and t["punter"]["name"] and t["qb"]["name"], (s["season"], code)
            # the lineup's other choices (the builder's Lineup): the season's other quarterbacks, each with what he would
            # bring (adj), never the one lined up; its other kickers
            qbs = L["qbs"]
            assert all(q["pos"] == "QB" and isinstance(q["adj"], float) and -0.3 < q["adj"] < 0.3 and 40 <= q["ovr"] <= 99 for q in qbs), (s["season"], code)
            assert L["off"][0]["name"] not in {q["name"] for q in qbs} and len({q["name"] for q in qbs}) == len(qbs), (s["season"], code)
            assert all(k["name"] and k["name"] != t["kicker"]["name"] and 40 <= k["ovr"] <= 99 for k in t["kickers"]), (s["season"], code)
            m = next(x for x in s["teams"] if x["team"] == code)
            assert m["net"] == S.strength(t) and m["qb"] == t["qb"]["name"]
    nets = {(s["season"], t["team"]): t["net"] for s in idx["seasons"] for t in s["teams"]}
    assert nets[(2007, "NE")] == max(v for (y, _), v in nets.items() if y == 2007)       # 2007 New England, 16-0


# ---- the format and its checks (web/scenario.js)
def test_overtime_rules_are_pro_pys():
    got = js("const o = {}; for (let y = 1999; y <= 2027; y++) for (const t of ['REG', 'WC', 'SB']) o[`${y}${t}`] = SC.overtime(y, t); return o;")
    for y in range(1999, 2028):
        for t in ("REG", "WC", "SB"):
            assert got[f"{y}{t}"] == pro.overtime_rules(y, t), (y, t)


def test_code_round_trip_and_bad_codes():
    out = js("""
      const a = SC.defaults(2026, 'KC', 'BUF'), b = { ...SC.defaults(2007, 'NE', 'NYG'), os: 2011, type: 'SB', site: 'neutral', qtr: 5, clock: 900, score: [17, 20],
        ball: 'you', start: 'kick', otp: 1, rules: 'opp' };
      const back = [a, b].map((x) => SC.parse(SC.code(x)));
      const bad = ['', '1-KC', `2${SC.code(a).slice(1)}`, SC.code(a) + '-x', SC.code(a).replace('-h-', '-z-'), SC.code(a).replace('-y-s-', '-q-s-'), 'x'.repeat(60)].map((c) => SC.parse(c));
      return { a, b, back, code: SC.code(b), bad };""")
    assert out["back"] == [out["a"], out["b"]]
    assert out["code"] == "1-NE-2007-NYG-2011-SB-n-5-900-17-20-y-k-75-1-10-2-3-1-o-o-g"
    assert out["bad"] == [None] * 7


def test_checks_refuse_impossible_states():
    cases = js("""
      const ix = { seasons: [2001, 2002, 2007, 2015, 2023, 2026].map((s) => ({ season: s, teams: ['NE', 'KC', 'NYG', 'BUF', ...(s >= 2002 ? ['HOU'] : [])].map((team) => ({ team })) })) };
      const d = SC.defaults(2026, 'KC', 'BUF'), f = (x) => SC.check({ ...d, ...x }, ix).map(([k]) => k);
      return {
        ok: f({}), same: f({ opp: 'KC' }), noTeam: f({ you: 'HOU', ys: 2001 }), noSeason: f({ ys: 1999 }),
        ytgPastGoal: f({ yl: 5, ytg: 6 }), goalOk: f({ yl: 5, ytg: 5 }), ytg0: f({ ytg: 0 }), down5: f({ down: 5 }), yl100: f({ yl: 100 }),
        clock0: f({ clock: 0 }), clockOver: f({ clock: 901 }), clockQ: f({ qtr: 1, clock: 900, score: [0, 0] }), q1Scored: f({ qtr: 1, clock: 900, score: [3, 0] }),
        q1Many: f({ qtr: 1, clock: 600, score: [56, 0] }), scoreOne: f({ score: [1, 7] }), score100: f({ score: [100, 7] }),
        to4: f({ to: [4, 3] }), otTo3reg: f({ qtr: 5, clock: 600, score: [20, 20], to: [3, 2] }), otTo3po: f({ qtr: 5, clock: 900, type: 'DIV', score: [20, 20], to: [3, 3] }),
        otClock: f({ qtr: 5, clock: 700, score: [20, 20], to: [2, 2] }), otClock16: f({ qtr: 5, clock: 900, ys: 2015, os: 2015, you: 'NE', opp: 'NYG', score: [20, 20], to: [2, 2] }),
        otLead: f({ qtr: 5, clock: 300, score: [23, 20], to: [2, 2] }),
        otSdBehind: f({ qtr: 5, clock: 500, score: [20, 23], ys: 2007, os: 2007, you: 'NE', opp: 'NYG', to: [2, 2], otp: 1 }),
        otMsdDown3: f({ qtr: 5, clock: 500, score: [20, 23], ys: 2015, os: 2015, you: 'NE', opp: 'NYG', to: [2, 2], otp: 1 }),
        otMsdDown7: f({ qtr: 5, clock: 500, score: [20, 27], ys: 2015, os: 2015, you: 'NE', opp: 'NYG', to: [2, 2], otp: 1 }),
        otBothDown7: f({ qtr: 5, clock: 300, score: [20, 27], to: [2, 2], otp: 1 }), otBothDown2: f({ qtr: 5, clock: 300, score: [20, 22], to: [2, 2], otp: 1 }),
        otBehindFirst: f({ qtr: 5, clock: 300, score: [20, 23], to: [2, 2], otp: 0 }),
        otKickAfterNone: f({ qtr: 5, clock: 300, score: [20, 20], to: [2, 2], otp: 1, start: 'kick' }),
        otKickBoth: f({ qtr: 5, clock: 200, score: [23, 23], to: [2, 2], otp: 2, start: 'kick' }),
        otKickBothSd: f({ qtr: 5, clock: 200, score: [23, 23], ys: 2007, os: 2007, you: 'NE', opp: 'NYG', to: [2, 2], otp: 2, start: 'kick' }),
        rulesTwoYears: f({ os: 2007, opp: 'NYG', rules: 'x' }), kickNoYl: f({ start: 'kick', yl: 0, ytg: 0, down: 0 }),
        half: f({ qtr: 2, r2h: 'x' }), type: f({ type: 'PRE' }), site: f({ site: 'moon' }),
      };""")
    assert cases.pop("ok") == [] and cases.pop("goalOk") == [] and cases.pop("otTo3po") == [] and cases.pop("otClock16") == []
    assert cases.pop("otMsdDown3") == [] and cases.pop("otBothDown7") == [] and cases.pop("otKickBoth") == [] and cases.pop("kickNoYl") == []
    assert cases.pop("clockQ") == []                            # the opening kickoff's clock, nobody has scored
    want = {"same": "opp", "noTeam": "you", "noSeason": "you", "ytgPastGoal": "ytg", "ytg0": "ytg", "down5": "down", "yl100": "yl",
            "clock0": "clock", "clockOver": "clock", "q1Scored": "score", "q1Many": "score", "scoreOne": "score", "score100": "score",
            "to4": "to", "otTo3reg": "to", "otClock": "clock", "otLead": "score", "otSdBehind": "score", "otMsdDown7": "score",
            "otBothDown2": "score", "otBehindFirst": "otp", "otKickAfterNone": "otp", "otKickBothSd": "otp", "rulesTwoYears": "rules",
            "half": "r2h", "type": "type", "site": "site"}
    for k, field in want.items():
        assert field in cases[k], (k, cases[k])


def test_spot_of_a_scenario():
    """The scenario as a spot (dailygame.py spot_record's fields) and its teams: who is home, the score and timeouts
    [away, home], the ball, a kickoff's kicking team, overtime's possessions [home, away], a neutral site's home field off."""
    out = js("""
      const team = (c, net) => ({ team: c, base: { off_pass: net, def_pass: 0, off_rush: 0, def_rush: 0, proe: 0 }, qb: { adjustment: 0 }, lineup: { off: [], def: [] } });
      const lg = { mu_pass: 0.05, mu_rush: -0.1, home_pass: 0.03, home_rush: 0.02 };
      const rY = { league: lg, teams: { NE: team('NE', 0.2) } }, rO = { league: { ...lg, mu_pass: 0.1 }, teams: { KC: team('KC', 0.1) } };
      const base = { ...SC.defaults(2007, 'NE', 'KC'), os: 2023 };
      const away = SC.spotOf({ ...base, site: 'away', score: [17, 21], to: [2, 3], ball: 'opp', yl: 40 }, rY, rO, { hfa: 2, k: 40 });
      const sb = SC.spotOf({ ...base, type: 'SB', site: 'neutral', qtr: 5, clock: 900, score: [20, 23], to: [3, 3], ball: 'you', start: 'kick', otp: 1, rules: 'opp' }, rY, rO, { hfa: 2, k: 40 });
      return { away, sb };""")
    a, sb = out["away"]["spot"], out["sb"]["spot"]
    assert (a["home"], a["away"], a["player"], a["start"]["pos"]) == ("KC", "NE", "NE", "KC")
    assert a["start"]["score"] == [17, 21] and a["start"]["to"] == [2, 3] and a["start"]["phase"] == "snap"
    assert a["spread"] == pytest.approx(2 + 40 * (0.1 - 0.2) * 0.6, abs=0.5) and a["league"]["home_pass"] == 0.03
    assert a["real"]["season"] == 2007 and a["overtime"] == pro.overtime_rules(2007, "REG") and a["category"] == "drill"
    assert out["away"]["teams"]["home"]["team"] == "KC"
    assert (sb["home"], sb["neutral"], sb["league"]["home_pass"], sb["league"]["mu_pass"]) == ("NE", True, 0, 0.1)
    assert sb["start"]["phase"] == "kick" and sb["start"]["pos"] == "KC" and sb["start"]["otc"] == [0, 1]     # KC scored first and kicks off
    assert sb["real"]["season"] == 2023 and sb["overtime"] == pro.overtime_rules(2023, "SB")
    assert sb["spread"] == pytest.approx(40 * 0.1 * 0.6, abs=0.5)


def test_lineup_codes_round_trip_and_old_codes_still_read():
    """A scenario's lineup picks ride in its code after the 22 parts (web/scenario.js luCode): they read back, in one
    order only (one scenario, one code); a code from before lineups reads as it always did, with no lineup; a broken
    pick (a slot twice, out of order, a bad mark) makes no scenario."""
    out = js("""
      const old = '1-NE-2007-NYG-2011-SB-n-5-900-17-20-y-k-75-1-10-2-3-1-o-o-g';
      const a = { ...SC.parse(old), lu: { you: { q1: SC.pid('Matt Cassel'), w2: SC.pid('Wes Welker') }, opp: { k1: SC.pid('Lawrence Tynes') } } };
      const c = SC.code(a), back = SC.parse(c);
      const bad = [`${old}-yq1abcd-yq1abce`, `${old}-yw2abcd-yq1abce`, `${old}-oq1abcd-yq1abce`, `${old}-yq1ABCD`, `${old}-yq0abcd`, `${old}-yz1abcd`, `${old}-yq1abc`]
        .map((x) => SC.parse(x));
      return { old: SC.parse(old), oldBack: SC.code(SC.parse(old)), c, back, a, bad, pid: [SC.pid('J.J. McCarthy'), SC.pid(' J.J.  McCarthy '), SC.pid('Carson Wentz')],
        re: SC.CODE_RE.source, tidyNone: 'lu' in SC.tidy({ ...SC.parse(old), lu: { you: {} } }), ok: SC.check(a).length, shape: SC.check({ ...a, lu: { you: { q1: 'nope!' } } }).map(([f]) => f) };""")
    assert out["oldBack"] == "1-NE-2007-NYG-2011-SB-n-5-900-17-20-y-k-75-1-10-2-3-1-o-o-g" and "lu" not in out["old"]
    assert out["c"] == out["oldBack"] + f"-yq1{out['a']['lu']['you']['q1']}-yw2{out['a']['lu']['you']['w2']}-ok1{out['a']['lu']['opp']['k1']}"
    assert out["back"] == out["a"]
    assert out["bad"] == [None] * 7
    assert out["pid"][0] == out["pid"][1] != out["pid"][2] and all(len(x) == 4 for x in out["pid"])
    assert out["tidyNone"] is False and out["ok"] == 0 and out["shape"] == ["lineup"]
    # the board reads codes with the same pattern (board/worker.js SCEN_RE)
    src = (WEB.parent / "board" / "worker.js").read_text()
    assert f"SCEN_RE = /{out['re']}/;" in src


def test_a_lineup_on_a_team():
    """withQb: another of the team's quarterbacks plays, the team's pass rating taking his adjustment for the starter's
    and every call he throws moving by the difference (a swap back is the team as it was); withLineup: the picks on
    (a receiver picked from another slot swaps places, a kicker's rating is his); checkLineup refuses a pick not on the
    roster or a player in two places; spotOf plays the picks, the spread with them."""
    out = js("""
      const P = (pos, name, ovr, x) => ({ pos, name, ovr, stat: 's', ...(x || {}) });
      const team = (c) => ({ team: c, base: { off_pass: 0.05, def_pass: 0, off_rush: 0, def_rush: 0, proe: 0 }, qb: { name: 'Carson Wentz', adjustment: 0.01 },
        kicker: { name: 'Will Reichard', rating: 0.1, ovr: 80 }, kickers: [{ name: 'Backup Kicker', rating: -0.3, ovr: 55 }],
        calls: { quick_strong: { off: 0.02, def: -0.01 }, rb_middle: { off: 0.03, def: 0.01 } },
        lineup: { off: [P('QB', 'Carson Wentz', 70), P('LT', 'L1', 70), P('LG', 'L2', 70), P('C', 'L3', 70), P('RG', 'L4', 70), P('RT', 'L5', 70),
          P('RB', 'Aaron Jones', 80), P('WR', 'Justin Jefferson', 97), P('WR', 'Jordan Addison', 84), P('WR', 'Jalen Nailor', 70), P('TE', 'T.J. Hockenson', 85)],
          def: [], bench: [P('WR', 'Tim Bench', 60), P('TE', 'Josh Oliver', 72), P('TE', 'Big Lineman', 60, { num: 72 })],
          qbs: [P('QB', 'J.J. McCarthy', 80, { adj: -0.09 }), P('QB', 'Max Brosmer', 63, { adj: -0.03 })] } });
      const T = team('MIN'), q = SC.withQb(T, 'J.J. McCarthy'), back = SC.withQb(q, 'Carson Wentz');
      const slots = SC.slots(T).map((s) => [s.slot, s.real.name, s.cands.map((c) => c.name)]);
      const lu = { q1: SC.pid('J.J. McCarthy'), w1: SC.pid('Jordan Addison'), w2: SC.pid('Justin Jefferson'), w3: SC.pid('Tim Bench'), k1: SC.pid('Backup Kicker') };
      const L = SC.withLineup(T, lu);
      const ros = { league: { mu_pass: 0, mu_rush: 0, home_pass: 0, home_rush: 0 }, teams: { MIN: T, GB: { ...team('GB'), team: 'GB' } } };
      const sc = { ...SC.defaults(2025, 'MIN', 'GB'), lu: { you: { q1: lu.q1 } } };
      const bad = [{ you: { q1: 'zzzz' } }, { you: { w2: SC.pid('Justin Jefferson') } }, { you: { w9: SC.pid('Tim Bench') } }, { opp: { k1: SC.pid('Will Reichard') } }]
        .map((x) => SC.checkLineup({ ...sc, lu: x }, ros, ros).map(([f, m]) => [f, m]));
      const plain = SC.spotOf({ ...sc, lu: undefined }, ros, ros, { hfa: 2, k: 40 }), with_ = SC.spotOf(sc, ros, ros, { hfa: 2, k: 40 });
      return { q, back, T, slots, L, bad, say: SC.lineupSay(sc, ros, ros, (c, y) => `${y} ${c}`),
        spreads: [plain.spot.spread, with_.spot.spread], id: with_.spot.id, code: SC.code(sc), home: with_.teams.home.qb, calls: SC.QB_CALLS };""")
    T, q, back = out["T"], out["q"], out["back"]
    d = -0.09 - 0.01
    assert q["qb"] == {"name": "J.J. McCarthy", "adjustment": -0.09} and q["lineup"]["off"][0]["name"] == "J.J. McCarthy" and "adj" not in q["lineup"]["off"][0]
    assert q["calls"]["quick_strong"] == {"off": round(0.02 + d, 5), "def": -0.01} and q["calls"]["rb_middle"] == T["calls"]["rb_middle"]
    assert all(q["calls"][c]["off"] == pytest.approx(T["calls"].get(c, {"off": 0})["off"] + d) and q["calls"][c]["def"] == T["calls"].get(c, {"def": 0})["def"] for c in out["calls"])
    assert [x["name"] for x in q["lineup"]["qbs"]] == ["Carson Wentz", "Max Brosmer"] and q["lineup"]["qbs"][0]["adj"] == 0.01
    assert back["qb"] == T["qb"] and all(back["calls"][c]["off"] == pytest.approx(T["calls"].get(c, {"off": 0})["off"]) for c in out["calls"])
    assert out["slots"][0] == ["q1", "Carson Wentz", ["Carson Wentz", "J.J. McCarthy", "Max Brosmer"]]
    assert ["t1", "T.J. Hockenson", ["T.J. Hockenson", "Josh Oliver"]] in out["slots"] and out["slots"][-1][0] == "k1"     # (no lineman at tight end)
    L = out["L"]
    assert [p["name"] for p in L["lineup"]["off"][6:]] == ["Aaron Jones", "Jordan Addison", "Justin Jefferson", "Tim Bench", "T.J. Hockenson"]
    assert "Jalen Nailor" in [p["name"] for p in L["lineup"]["bench"]] and "Tim Bench" not in [p["name"] for p in L["lineup"]["bench"]]
    assert L["kicker"] == {"name": "Backup Kicker", "rating": -0.3, "ovr": 55} and L["qb"]["name"] == "J.J. McCarthy"
    assert [f for x in out["bad"] for f, _ in x] == ["lu-you", "lu-you", "lu-you"] and out["bad"][3] == []
    assert "not on the 2025 roster" in out["bad"][0][0][1] and "in two places" in out["bad"][1][0][1]
    assert out["say"] == ["2025 MIN: J.J. McCarthy at quarterback"]
    # the spread: McCarthy brings 0.10 EPA a dropback less, 60% of a team's strength is its passing, 40 points a point of it
    assert out["spreads"][1] == pytest.approx(out["spreads"][0] + 40 * 0.6 * d, abs=0.5) and out["home"]["name"] == "J.J. McCarthy"
    assert out["id"] == f"custom:{out['code']}" and "-yq1" in out["code"]          # (its own state, its own simulator)
