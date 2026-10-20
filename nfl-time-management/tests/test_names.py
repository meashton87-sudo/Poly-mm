"""Teams go by their city or region, never a nickname, everywhere a player can see them: the page's table (game.js
TEAMS), the stats page's (stats.html SIDE_NAME), and the committed notes and titles the site shows (the daily
schedule's featured days, the historic drives, the playoff runs, the hand-built college spot)."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB, PKG = ROOT / "web", ROOT / "src" / "nflclock"

CITY = {"ARI": "Arizona", "ATL": "Atlanta", "BAL": "Baltimore", "BUF": "Buffalo", "CAR": "Carolina", "CHI": "Chicago",
        "CIN": "Cincinnati", "CLE": "Cleveland", "DAL": "Dallas", "DEN": "Denver", "DET": "Detroit", "GB": "Green Bay",
        "HOU": "Houston", "IND": "Indianapolis", "JAX": "Jacksonville", "KC": "Kansas City", "LV": "Las Vegas",
        "LAC": "Los Angeles (AFC)", "LA": "Los Angeles (NFC)", "MIA": "Miami", "MIN": "Minnesota", "NE": "New England",
        "NO": "New Orleans", "NYG": "New York (NFC)", "NYJ": "New York (AFC)", "PHI": "Philadelphia", "PIT": "Pittsburgh",
        "SF": "San Francisco", "SEA": "Seattle", "TB": "Tampa Bay", "TEN": "Tennessee", "WAS": "Washington"}
COLLEGE = {"OSU": "Ohio State", "IU": "Indiana", "ALA": "Alabama", "TENN": "Tennessee"}
# every nickname, the plural (as a team is called) and the usual short ones; the college games' too
NICK = re.compile(r"\b(Cardinals|Falcons|Ravens|Bills|Panthers|Bears|Bengals?|Browns|Cowboys|Broncos|Lions|Packers|Texans|"
                  r"Colts|Jaguars|Chiefs|Raiders|Chargers|Rams|Dolphins|Vikings|Patriots|Saints|Giants|Jets|Eagles|Steelers|"
                  r"49ers?|Niners?|Seahawks?|Buccaneers?|Titans|Commanders|Redskins?|Football Team|Bucs|Jags|Pats|Commies|Bolts|"
                  r"Phins|Buckeyes|Hoosiers|Vols|Volunteers|Crimson Tide|Tide)\b")


def table(src: str, name: str) -> dict:
    """A JS table of code -> ['name', '#color'] (game.js TEAMS, stats.html SIDE_NAME)."""
    body = re.search(rf"const {name} = \{{(.*?)\}};", src, re.S).group(1)
    return {c: (n, col) for c, n, col in re.findall(r"(\w+): \['([^']+)', '(#[0-9A-Fa-f]{6})'\]", body)}


def test_every_team_by_its_city():
    teams = table((WEB / "game.js").read_text(), "TEAMS")
    assert {c: n for c, (n, _) in teams.items()} == {**CITY, **COLLEGE}
    side = table((WEB / "stats.html").read_text(), "SIDE_NAME")
    assert side == {c: teams[c] for c in CITY}          # the stats page names (and colors) a side as the game does


def test_no_nickname_in_what_the_site_shows():
    pages = ["game.js", "game.html", "scenario.js", "stats.html", "about.html", "how-it-works.html", "privacy.html", "og_card.html"]
    for f in pages:
        hits = [(i + 1, m.group(0)) for i, ln in enumerate((WEB / f).read_text().splitlines()) for m in NICK.finditer(ln)]
        assert not hits, (f, hits)
    for f in [ROOT / "board" / "worker.js", ROOT / "scripts" / "site.py"]:
        assert not NICK.search(f.read_text()), f
    # the committed text the site shows: every featured day (notes, titles, the sides' stories), the historic drives,
    # the playoff runs, the college spot
    texts = []
    sched = json.loads((PKG / "daily_schedule.json").read_text())
    for d, ft in sched["featured"].items():
        texts += [(f"day {d}", ft.get(k, "")) for k in ("title", "note")]
        texts += [(f"day {d} side", s.get(k, "")) for s in ft.get("sides", []) for k in ("note", "summary")]
    texts += [(d["id"], d[k]) for d in json.loads((PKG / "pro_drives.json").read_text()) for k in ("title", "note")]
    texts += [(f"run {r['season']} {r['team']}", r["title"]) for r in json.loads((PKG / "pro_runs.json").read_text())]
    for gid, g in json.loads((PKG / "custom_spots.json").read_text()).items():
        if isinstance(g, dict):
            texts += [(gid, g["spot"].get("site", "")), (gid, g["spot"].get("real", {}).get("summary", ""))]
    bad = [(where, NICK.search(t).group(0)) for where, t in texts if NICK.search(t)]
    assert not bad, bad
    runs = {(r["season"], r["team"]): r["title"] for r in json.loads((PKG / "pro_runs.json").read_text())}
    assert runs[(2021, "LA")] == "2021 Los Angeles (NFC)" and runs[(2007, "NYG")] == "2007 New York (NFC)"
