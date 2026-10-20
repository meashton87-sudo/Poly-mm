"""The address move's switch (scripts/site.py move_js, --old-domain): nothing at all until the site moves; then the
handover script with the two addresses in it. The handover itself runs in a browser: scripts/move_test.py."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("site_build", Path(__file__).resolve().parents[1] / "scripts" / "site.py")
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


def test_no_move_no_script():
    assert site.move_js(None, []) == ""
    assert site.move_js("", ["nfl2mindrill.com"]) == ""
    assert site.move_js("2mindrills.com", []) == ""
    assert site.move_js("2mindrills.com", [" ", ""]) == ""
    assert site.move_js("2mindrills.com", ["2mindrills.com", "www.2mindrills.com"]) == ""      # (the site itself is no old address)


def test_move_script_names_both_addresses():
    js = site.move_js("2mindrills.com", ["https://www.NFL2mindrill.com/", "old.example"])
    assert js.startswith("<script>") and js.endswith("</script>") and js.count("</script>") == 1
    assert '(["nfl2mindrill.com","old.example"],"2mindrills.com")' in js.replace(", ", ",")
    assert "OLD_HOSTS" not in js and "NEW_HOST" not in js
    with pytest.raises(SystemExit):
        site.move_js("2mindrills.com", ["bad host/<script>"])


def test_default_domain_in_one_place():
    src = (Path(__file__).resolve().parents[1] / "scripts" / "site.py").read_text()
    assert src.count('"nfl2mindrill.com"') == 1 and site.DEFAULT_DOMAIN == "nfl2mindrill.com"
    assert site.bare_host("https://www.2MinDrills.com/") == "2mindrills.com"
