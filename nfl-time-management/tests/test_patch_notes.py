"""The patch notes (web/patch_notes.json -> /patch-notes, scripts/site.py patch_notes_html): newest first, every update a
date, a title and its items, and only changes to the game: no ads, analytics, payments or what isn't live (Coach
mode, the full defense). Every update to the game adds its notes at the top (CLAUDE.md)."""
import importlib.util
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTES = json.loads((ROOT / "web" / "patch_notes.json").read_text())["notes"]
OFF = re.compile(r"\b(ads?|advert\w*|AdSense|Ezoic|Adsterra|banner|analytics|Google Analytics|tracking|Stripe|checkout|"
                 r"payments?|price|\$\d|Coach mode|ads\.txt|domain|deploy\w*|CI|browser test|bots?)\b", re.I)


def test_newest_first_and_whole():
    days = [date.fromisoformat(n["date"]) for n in NOTES]
    assert days == sorted(days, reverse=True)
    for n in NOTES:
        assert n["title"].strip() and n["items"] and all(x.strip() for x in n["items"]), n["date"]


def test_only_the_game():
    for n in NOTES:
        for x in [n["title"], *n["items"]]:
            assert not OFF.search(x), f"{n['date']}: {x!r} names something that is not the game ({OFF.search(x).group(0)})"


def test_the_page_is_built():
    spec = importlib.util.spec_from_file_location("site_build", ROOT / "scripts" / "site.py")
    s = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(s)
    out = s.patch_notes_html({"notes": NOTES})
    assert out.count('<section class="pn">') == len(NOTES) and out.count("class=new") == 1
    assert NOTES[0]["title"].replace("&", "&amp;") in out
