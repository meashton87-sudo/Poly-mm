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
import base64
import gzip
import html
import struct
import zlib
import re
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

WEB = Path(__file__).resolve().parents[1] / "web"
FILES = ["game.js", "motion.js", "engine.js", "game_worker.js", "game.json", "playbook.json", "engine_data.json",
         "og.png", "icon.svg", "icon-180.png", "icon-48.png", "icon-192.png", "icon-512.png", "midlogo.png", "favicon.ico"]      # the link preview card (og_card.html, drawn at 1200x630) and the icons
# the same skeleton the claude.ai artifact host wraps the page in: charset, a viewport that reaches the phone's
# edges, the safe-area padding and a small reset
HEAD = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        "{extra}"
        "<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}"
        "body{{margin:0;font:14px system-ui,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style></head><body>")


# The simulator's data (engine_data.json, playbook.json: typed arrays as base64 in JSON) re-packed for phones: the
# same arrays as raw bytes, the integer index arrays as differences and every multi-byte array byte-plane shuffled
# (both lossless, both gzip much better), gzipped. Half the download before the first snap. game_worker.js unpacks
# it (DecompressionStream); browsers without one, and the claude.ai artifact, still load the JSON.
PACKED = {"engine_data.json": "engine_data.pack", "playbook.json": "playbook.pack"}


def _encode(spec: dict) -> tuple[dict, bytes]:
    a = np.frombuffer(base64.b64decode(spec["b64"]), dtype=spec["dtype"])[: spec["n"]]
    shuffle = lambda x: x.view(np.uint8).reshape(-1, x.itemsize).T.tobytes() if x.itemsize > 1 else x.tobytes()
    cands = {"": a.tobytes()}
    if a.itemsize > 1:
        cands["s"] = shuffle(a)
    if a.dtype.kind in "iu" and a.size:
        d = np.diff(a.astype(np.int64), prepend=0).astype(a.dtype)       # wraps like the typed array does
        cands["d"] = d.tobytes()
        if a.itemsize > 1:
            cands["ds"] = shuffle(d)
    enc = min(cands, key=lambda k: (len(zlib.compress(cands[k], 6)), len(k)))
    return {"dtype": spec["dtype"], "n": int(spec["n"]), "enc": enc}, cands[enc]


def pack(src: Path, dst: Path) -> int:
    """src JSON -> dst: gzip("NFCP", uint32 header length, header JSON, blob); each base64 array in the JSON becomes
    {dtype, n, enc, off, len} pointing into the blob."""
    blob = bytearray()

    def walk(x):
        if isinstance(x, dict):
            if "b64" in x and "dtype" in x:
                head, raw = _encode(x)
                head.update(off=len(blob), len=len(raw))
                blob.extend(raw)
                return head
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    header = json.dumps(walk(json.loads(src.read_text())), separators=(",", ":"), allow_nan=False).encode()
    data = b"NFCP" + struct.pack("<I", len(header)) + header + bytes(blob)
    dst.write_bytes(gzip.compress(data, 9, mtime=0))
    return dst.stat().st_size


# Google AdSense: the site verification meta and the ad script (in every page's head), and with an ad unit's slot id
# the pages show that unit on the screens between games (game.js / stats.html read the two metas). Off unless given.
ADSENSE_TAG = ("<meta name=\"google-adsense-account\" content=\"{id}\">"
               "<script async src=\"https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={id}\" crossorigin=\"anonymous\"></script>")


# Another ad network's banner (Adsterra and the like, whose approval is quicker than AdSense's): its ad code, as the
# network gives it, in web/ads/banner.html (a first line "<!-- size: 300x250 -->" gives the unit's size). The site
# serves it as its own page (ad-banner.html) that the game and the stats page show in a sandboxed frame, between games
# only. Lines in web/ads/ads.txt go into ads.txt after Google's.
BANNER = WEB / "ads" / "banner.html"


def banner_meta() -> str:
    if not BANNER.exists() or not BANNER.read_text().strip():
        return ""
    m = re.search(r"size:\s*(\d+)x(\d+)", BANNER.read_text())
    size = f"{m.group(1)}x{m.group(2)}" if m else "300x250"
    return f'<meta name="ad-frame" content="ad-banner.html" data-size="{size}">'


def ads_head(adsense: str | None, ad_slot: str | None) -> str:
    out = banner_meta()
    if not adsense:
        return out
    return ADSENSE_TAG.format(id=adsense) + (f"<meta name=\"ad-slot\" content=\"{ad_slot}\">" if ad_slot and not out else "") + out


GA_TAG = ("<script async src=\"https://www.googletagmanager.com/gtag/js?id={id}\"></script>"
          "<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}"
          "gtag('js',new Date());gtag('config','{id}');</script>")


# Every page: the same footer (the site's pages, the contact, the disclaimer and the data credit), its style, and the
# canonical address of the page
PAGES = [("", "Play", 1.0), ("how-it-works", "How it works", 0.8), ("about", "About", 0.6), ("stats", "Stats", 0.6),
         ("privacy", "Privacy", 0.3)]
FOOT_CSS = ("<style>.sitefoot{max-width:680px;margin:28px auto 0;padding:14px 16px 28px;border-top:1px solid var(--line);"
            "font-size:12.5px;line-height:1.5;color:var(--muted)}.sitefoot nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px}"
            ".sitefoot nav a{color:var(--ink);font-weight:700;text-decoration:none}.sitefoot nav a:hover{text-decoration:underline}"
            ".sitefoot p{margin:0 0 6px;max-width:72ch}.sitefoot p a{color:inherit}"
            "h1 a.home{color:inherit;text-decoration:none}</style>")
FOOT = ('<footer class="sitefoot"><nav aria-label="Site">'
        + "".join(f'<a href="{p or "./"}">{label}</a>' for p, label, _ in PAGES)
        + '<a href="https://x.com/TwoMinuteDrill0" rel="noopener">Contact (X)</a></nav>'
        '<p>Two-Minute Drill is an independent, fan-made game. It is not affiliated with, endorsed by or sponsored by the '
        'National Football League, its teams, its players or the NFL Players Association. NFL, team names and player names '
        'are trademarks or property of their respective owners and are used only to identify real games.</p>'
        '<p>Data: play-by-play, participation and charting from <a href="https://github.com/nflverse" rel="noopener">nflverse</a>; '
        'FTN Data via nflverse (<a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener">CC BY-SA 4.0</a>).</p>'
        '<p>© 2026 Two-Minute Drill</p></footer>')


# The site's icon (the 2MD logo): what Google shows next to the site in search results (a square of 48 px or more,
# linked from the page, /favicon.ico at the root too), the browser tab, a phone's home screen
ICONS = ('<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">'
         '<link rel="apple-touch-icon" href="/icon-180.png"><link rel="manifest" href="/site.webmanifest">')


def canonical(site_url: str, path: str) -> str:
    return f'<link rel="canonical" href="{html.escape(site_url.rstrip("/") + "/" + path, quote=True)}">'


def share_tags(site_url: str, title: str, desc: str, path: str = "") -> str:
    """The link preview (X, iMessage, Slack...) and the icons; the image needs the site's full address."""
    e = lambda x: html.escape(x, quote=True)
    base = site_url.rstrip("/")
    return (ICONS +
            f'<meta name="theme-color" content="#2c7549">'
            f'<meta property="og:type" content="website"><meta property="og:site_name" content="Two-Minute Drill">'
            f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">'
            f'<meta property="og:url" content="{e(base + "/" + path)}"><meta property="og:image" content="{e(base)}/og.png">'
            f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
            f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(title)}">'
            f'<meta name="twitter:description" content="{e(desc)}"><meta name="twitter:image" content="{e(base)}/og.png">')


def build(out: Path, domain: str | None = None, board_api: str | None = None, ga: str | None = None,
          site_url: str | None = None, adsense: str | None = None, ad_slot: str | None = None) -> Path:
    adsense, ad_slot = (adsense or "").strip() or None, (ad_slot or "").strip() or None     # "" (an unset variable): off
    if adsense and not re.fullmatch(r"ca-pub-\d{16}", adsense):
        raise SystemExit(f"--adsense wants a publisher id like ca-pub-1234567890123456, not {adsense!r}")
    if ad_slot and not re.fullmatch(r"\d{6,12}", ad_slot):
        raise SystemExit(f"--ad-slot wants an ad unit's slot number, not {ad_slot!r}")
    missing = [f for f in FILES + ["stats.html", "privacy.html", "about.html", "how-it-works.html"] if not (WEB / f).exists()] + ([] if (WEB / "spots").is_dir() else ["spots/"])
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
    extra += ads_head(adsense, ad_slot)
    if board_api:
        extra += f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">"
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WEB, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = ""
    stamp = (commit[:12] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    # every file the page loads carries the build stamp (game.js reads the meta), so phones never mix two builds
    extra += f"<meta name=\"build\" content=\"{stamp}\">" + canonical(site_url, "") + FOOT_CSS
    extra += ('<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", "@type": "WebSite",
              "name": "Two-Minute Drill", "url": site_url.rstrip("/") + "/", "description": desc}) + "</script>")
    page = (WEB / "game.html").read_text()
    for js in ("motion.js", "game.js"):
        page = page.replace(f'<script src="{js}"></script>', f'<script src="{js}?v={stamp}"></script>')
    (out / "index.html").write_text(HEAD.format(extra=extra) + page.replace("<!--SITE-FOOT-->", FOOT) + "</body></html>\n")
    # the stats page (/stats): its own document; the same analytics tag and backend address
    stats_head = (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, "Two-Minute Drill stats",
        "How everyone did on the daily drive: players per day, the score spread and the top ten.", "stats") + (
        f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">" if board_api else "")
    fill = lambda name, head, path: (out / name).write_text((WEB / name).read_text().replace("<!--SITE-HEAD-->",
        head + canonical(site_url, path) + FOOT_CSS).replace("<!--SITE-FOOT-->", FOOT))
    fill("stats.html", stats_head, "stats")
    # the guide and the about page (content: the same analytics and ad tags as the game)
    for name, path, title, d in (("how-it-works.html", "how-it-works", "How Two-Minute Drill works",
                                  "Real NFL late-game situations, 27 play calls, real plays on every snap, and calls graded on win chance."),
                                 ("about.html", "about", "About Two-Minute Drill",
                                  "An independent, fan-made NFL play-calling game built on public nflverse data.")):
        fill(name, (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, title, d, path), path)
    # the privacy page (AdSense wants one): the analytics tag only, no ads on it
    fill("privacy.html", (GA_TAG.format(id=ga) if ga else "") + ICONS, "privacy")
    (out / "site.webmanifest").write_text(json.dumps({"name": "Two-Minute Drill", "short_name": "2MD", "start_url": "/",
        "display": "standalone", "background_color": "#0c1d42", "theme_color": "#0c1d42", "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}]}, indent=1) + "\n")
    # for crawlers: every page allowed, and the sitemap of the site's pages
    base = site_url.rstrip("/")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {base}/sitemap.xml\n")
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (out / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{base}/{p}</loc><lastmod>{day}</lastmod><changefreq>{'daily' if p in ('', 'stats') else 'monthly'}</changefreq>"
                  f"<priority>{pr}</priority></url>\n" for p, _, pr in PAGES) + "</urlset>\n")
    # ads.txt: who may sell this site's ad space (Google's line, with our id, then any other network's lines)
    extra = (WEB / "ads" / "ads.txt").read_text().strip() if (WEB / "ads" / "ads.txt").exists() else ""
    lines = ([f"google.com, {adsense.replace('ca-', '', 1)}, DIRECT, f08c47fec0942fa0"] if adsense else []) + ([extra] if extra else [])
    if lines:
        (out / "ads.txt").write_text("\n".join(lines) + "\n")
    if banner_meta():                        # the banner's own page (the frame's)
        (out / "ad-banner.html").write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">'
            '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;overflow:hidden;'
            'background:transparent;display:flex;justify-content:center}</style></head><body>' + BANNER.read_text() + "</body></html>\n")
    for f in FILES:
        shutil.copy2(WEB / f, out / f)
    for f, p in PACKED.items():
        pack(WEB / f, out / p)
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
    ap.add_argument("--adsense", help="Google AdSense publisher id (ca-pub-...); empty: no ads")
    ap.add_argument("--ad-slot", help="an AdSense display ad unit's slot id, shown between games; empty: AdSense's own placement only")
    a = ap.parse_args()
    o = build(Path(a.out), a.domain, a.board_api, a.ga, a.site_url, a.adsense, a.ad_slot)
    n = sum(1 for _ in o.rglob("*") if _.is_file())
    size = sum(p.stat().st_size for p in o.rglob("*") if p.is_file()) / 1e6
    print(f"site in {o}: {n} files, {size:.1f} MB")
