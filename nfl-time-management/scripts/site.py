"""Build the daily game as a static website (GitHub Pages): web/game.html wrapped in a full HTML document as
index.html, with the scripts and the generated data next to it. The data must be built first (see CLAUDE.md:
cli build, webexport.export_engine, dailygame.build).

    python scripts/site.py [out_dir, default _site] [--domain nfl2mindrill.com] [--board-api https://...]

--domain writes the CNAME file for a custom domain; --board-api points the survivor leaderboard at its backend
(board/worker.js); without it the site has no leaderboard. --ga adds Google Analytics (gtag.js) to the page. version.json says when the site was built and from which
commit (an uptime check can alert when "built" gets old: a failing build leaves the last site up).
"""
from __future__ import annotations

import argparse
import html
import re
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
FILES = ["game.js", "motion.js", "engine.js", "game_worker.js", "game.json", "playbook.json", "engine_data.json",
         "og.png", "icon.svg", "icon-180.png"]      # the link preview card (og_card.html, drawn at 1200x630) and the icons
# the same skeleton the claude.ai artifact host wraps the page in: charset, a viewport that reaches the phone's
# edges, the safe-area padding and a small reset
HEAD = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        "{extra}"
        "<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}"
        "body{{margin:0;font:14px system-ui,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style></head><body>")


GA_TAG = ("<script async src=\"https://www.googletagmanager.com/gtag/js?id={id}\"></script>"
          "<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}"
          "gtag('js',new Date());gtag('config','{id}');</script>")


def share_tags(site_url: str, title: str, desc: str, path: str = "") -> str:
    """The link preview (X, iMessage, Slack...) and the icons; the image needs the site's full address."""
    e = lambda x: html.escape(x, quote=True)
    base = site_url.rstrip("/")
    return (f'<link rel="icon" href="icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="icon-180.png">'
            f'<meta name="theme-color" content="#2c7549">'
            f'<meta property="og:type" content="website"><meta property="og:site_name" content="Two-Minute Drill">'
            f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">'
            f'<meta property="og:url" content="{e(base + "/" + path)}"><meta property="og:image" content="{e(base)}/og.png">'
            f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
            f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(title)}">'
            f'<meta name="twitter:description" content="{e(desc)}"><meta name="twitter:image" content="{e(base)}/og.png">')


def build(out: Path, domain: str | None = None, board_api: str | None = None, ga: str | None = None,
          site_url: str | None = None) -> Path:
    missing = [f for f in FILES + ["stats.html"] if not (WEB / f).exists()] + ([] if (WEB / "spots").is_dir() else ["spots/"])
    if missing:
        raise SystemExit(f"build the game data first; missing in web/: {', '.join(missing)}")
    if out.exists():
        shutil.rmtree(out)
    (out / "spots").mkdir(parents=True)
    site_url = site_url or f"https://{(domain or 'nfl2mindrill.com').strip()}"
    desc = "Call the plays in real NFL endings. One drive a day: beat the real coach and see how you rank."
    extra = f"<meta name=\"description\" content=\"{desc}\">" + share_tags(site_url, "Two-Minute Drill: call the plays in real NFL endings", desc)
    if ga:                                   # Google Analytics (gtag.js), as Google gives it, at the top of <head>
        if not re.fullmatch(r"G-[A-Z0-9]{4,16}", ga):
            raise SystemExit(f"--ga wants a measurement id like G-XXXXXXX, not {ga!r}")
        extra = GA_TAG.format(id=ga) + extra
    if board_api:
        extra += f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">"
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WEB, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = ""
    stamp = (commit[:12] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    # every file the page loads carries the build stamp (game.js reads the meta), so phones never mix two builds
    extra += f"<meta name=\"build\" content=\"{stamp}\">"
    page = (WEB / "game.html").read_text()
    for js in ("motion.js", "game.js"):
        page = page.replace(f'<script src="{js}"></script>', f'<script src="{js}?v={stamp}"></script>')
    (out / "index.html").write_text(HEAD.format(extra=extra) + page + "</body></html>\n")
    # the stats page (/stats): its own document; the same analytics tag and backend address
    stats_head = (GA_TAG.format(id=ga) if ga else "") + share_tags(site_url, "Two-Minute Drill stats",
        "How everyone did on the daily drive: players per day, the score spread and the top ten.", "stats") + (
        f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">" if board_api else "")
    (out / "stats.html").write_text((WEB / "stats.html").read_text().replace("<!--SITE-HEAD-->", stats_head))
    for f in FILES:
        shutil.copy2(WEB / f, out / f)
    for f in sorted((WEB / "spots").glob("s*.json")):
        shutil.copy2(f, out / "spots" / f.name)
    if domain:
        (out / "CNAME").write_text(domain.strip() + "\n")
    (out / ".nojekyll").write_text("")          # serve the files as they are
    game = json.loads((WEB / "game.json").read_text())
    (out / "version.json").write_text(json.dumps({
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "commit": commit or None,
        "spots": len(game.get("spots", [])) if isinstance(game, dict) else None}, indent=1) + "\n")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="_site")
    ap.add_argument("--domain")
    ap.add_argument("--board-api")
    ap.add_argument("--ga", help="Google Analytics measurement id (G-...)")
    ap.add_argument("--site-url", help="the site's address for link previews (default https://<domain>, else nfl2mindrill.com)")
    a = ap.parse_args()
    o = build(Path(a.out), a.domain, a.board_api, a.ga, a.site_url)
    n = sum(1 for _ in o.rglob("*") if _.is_file())
    size = sum(p.stat().st_size for p in o.rglob("*") if p.is_file()) / 1e6
    print(f"site in {o}: {n} files, {size:.1f} MB")
