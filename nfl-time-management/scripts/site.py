"""Build the daily game as a static website (GitHub Pages): web/game.html wrapped in a full HTML document as
index.html, with the scripts and the generated data next to it. The data must be built first (see CLAUDE.md:
cli build, webexport.export_engine, dailygame.build).

    python scripts/site.py [out_dir, default _site] [--domain 2mindrill.bashton.xyz] [--board-api https://...]

--domain writes the CNAME file for a custom domain; --board-api points the survivor leaderboard at its backend
(board/worker.js); without it the site has no leaderboard.
"""
from __future__ import annotations

import argparse
import html
import shutil
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
FILES = ["game.js", "motion.js", "engine.js", "game_worker.js", "game.json", "playbook.json", "engine_data.json"]
# the same skeleton the claude.ai artifact host wraps the page in: charset, a viewport that reaches the phone's
# edges, the safe-area padding and a small reset
HEAD = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        "{extra}"
        "<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}"
        "body{{margin:0;font:14px system-ui,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style></head><body>")


def build(out: Path, domain: str | None = None, board_api: str | None = None) -> Path:
    missing = [f for f in FILES if not (WEB / f).exists()] + ([] if (WEB / "spots").is_dir() else ["spots/"])
    if missing:
        raise SystemExit(f"build the game data first; missing in web/: {', '.join(missing)}")
    if out.exists():
        shutil.rmtree(out)
    (out / "spots").mkdir(parents=True)
    extra = "<meta name=\"description\" content=\"Call the plays in real late-game NFL spots.\">"
    if board_api:
        extra += f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">"
    page = (WEB / "game.html").read_text()
    (out / "index.html").write_text(HEAD.format(extra=extra) + page + "</body></html>\n")
    for f in FILES:
        shutil.copy2(WEB / f, out / f)
    for f in sorted((WEB / "spots").glob("s*.json")):
        shutil.copy2(f, out / "spots" / f.name)
    if domain:
        (out / "CNAME").write_text(domain.strip() + "\n")
    (out / ".nojekyll").write_text("")          # serve the files as they are
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="_site")
    ap.add_argument("--domain")
    ap.add_argument("--board-api")
    a = ap.parse_args()
    o = build(Path(a.out), a.domain, a.board_api)
    n = sum(1 for _ in o.rglob("*") if _.is_file())
    size = sum(p.stat().st_size for p in o.rglob("*") if p.is_file()) / 1e6
    print(f"site in {o}: {n} files, {size:.1f} MB")
