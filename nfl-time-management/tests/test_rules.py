"""The rulebooks: web/engine.js's JSON copy equals src/nflclock/rules.py, both resolve every ruleset and state alike, and
the NFL's are today's literals."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from nflclock import rules, sim
from nflclock.rules import OT, RULES, STATES, rules_of, rules_table

ENGINE = Path(__file__).resolve().parents[1] / "web" / "engine.js"


def _block():
    m = re.search(r"// RULES:start[^\n]*\n\s*const RULE_BOOK = (\{.*?\n  \});\n\s*// RULES:end", ENGINE.read_text(), re.S)
    assert m, "engine.js has no RULES:start / RULES:end block"
    return json.loads(m.group(1))


def test_engine_copy_matches():
    assert _block() == json.loads(json.dumps(rules_table()))


def test_every_ruleset_complete():
    keys = set(RULES["nfl"])
    for name, R in RULES.items():
        assert set(R) == keys, name
        assert R["ot"] in OT, name
    for st, o in STATES.items():
        assert set(o) <= keys, st
        assert o.get("ot", "kansas10") in OT, st


def test_nfl_is_todays_literals():
    R = rules_of("nfl")
    assert (R["quarter"], R["tmw"], R["oob"]) == (900, 120, [120, 300])
    assert tuple(R["kneelRunoff"]) == sim.KNEEL_RUNOFF and R["patKick"] == 33 and R["twoYl"] == 2
    assert R["fgMissBack"] == 8 and R["koTouchback"] == 65 and R["onsideBehindOnly"] and R["untimed"] == "def"
    assert R["fdStop"] is None and R["runoff10"] is None and R["penStop"] is None and R["runClock"] is None


def test_rules_of():
    assert rules_of("nfhs:GA")["ot"] == "ga15" and rules_of("nfhs:GA")["quarter"] == 720
    assert rules_of({"base": "ncaa2026", "twoYl": 2})["twoYl"] == 2
    assert rules_of(rules_of("ncaa2022")) == rules_of("ncaa2022")     # a whole ruleset passes through
    r = rules_of("nfl"); r["oob"][0] = 1
    assert RULES["nfl"]["oob"][0] == 120                              # a copy, never the table
    with pytest.raises(ValueError):
        rules_of("ncaa1999")
    with pytest.raises(ValueError):
        rules_of("nfhs:ZZ")
    assert set(rules.LEVEL_OK) == {"nfl", "fbs", "hs"}


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_js_rules_of_matches():
    names = list(RULES) + [f"nfhs:{s}" for s in STATES]
    js = f"""const E = require({json.dumps(str(ENGINE))});
const out = {{}}; for (const n of {json.dumps(names)}) out[n] = E.rulesOf(n);
out.over = E.rulesOf({{ base: 'ncaa2026', twoYl: 2 }});
const g = (r, root) => {{ const x = E.geom(r, root); return {{ ...x, tmw: Number.isFinite(x.tmw) ? x.tmw : 'inf', R: undefined }}; }};
out.geom = [g('nfl', {{ t: 1800, phase: 1 }}), g('nfl', {{ t: 1801, phase: 0 }}), g('nfhs', {{ t: 1440, phase: 1 }}), g('nfhs', {{ t: 300, phase: 0 }})];
console.log(JSON.stringify(out));"""
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    for n in names:
        assert out[n] == json.loads(json.dumps(rules_of(n))), n
    assert out["over"] == json.loads(json.dumps(rules_of({"base": "ncaa2026", "twoYl": 2})))
    assert [(x["halfEnd"], x["half"], x["qEnd"], x["tmw"], x["oobWindow"]) for x in out["geom"]] == [
        (1800, 1, 2700, 1920, 120), (1800, 1, 2700, 1920, 120), (1440, 1, 2160, "inf", 1440), (0, 2, 720, "inf", 1440)]
