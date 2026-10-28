"""Build the daily game as a static website (GitHub Pages): web/game.html wrapped in a full HTML document as
index.html, with the scripts and the generated data next to it. The data must be built first (see CLAUDE.md:
cli build, webexport.export_engine, dailygame.build).

    python scripts/site.py [out_dir, default _site] [--domain example.com] [--old-domain old.example] [--board-api https://...]

--domain is the site's address (the CNAME file, canonical links, sitemap, shares; DEFAULT_DOMAIN without it), --old-domain
the one(s) it is moving from (web/move.js hands their visitors over, saved progress and all); --board-api points the survivor leaderboard at its backend
(board/worker.js); without it the site has no leaderboard. --ga adds Google Analytics (gtag.js) to the page. version.json says when the site was built and from which
commit (an uptime check can alert when "built" gets old: a failing build leaves the last site up).
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import html
import struct
import zlib
import re
import json
import shutil
import subprocess
import tempfile
from fnmatch import fnmatchcase
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

WEB = Path(__file__).resolve().parents[1] / "web"
FILES = ["game.js", "motion.js", "engine.js", "game_worker.js", "vs_core.js", "scenario.js", "game.json", "playbook.json", "engine_data.json",
         "og.png", "icon.svg", "icon-180.png", "icon-48.png", "icon-192.png", "icon-512.png", "midlogo.png", "favicon.ico",
         "icon-maskable-192.png", "icon-maskable-512.png"]      # the link preview card (og_card.html, drawn at 1200x630) and the icons
# (the maskable icons: the logo inside the middle 72%, so a phone's round or squircle mask never cuts it)
# the same skeleton the claude.ai artifact host wraps the page in: charset, a viewport that reaches the phone's
# edges, the safe-area padding and a small reset
HEAD = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        "{extra}"
        "<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}"
        "body{{margin:0;font:14px system-ui,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style></head><body>")

# The typefaces from the site itself (web/fonts: Google's own files and @font-face rules), in place of each page's
# Google Fonts stylesheet: that stylesheet held up the first paint behind two more hosts (DNS, TLS, then the CSS)
GFONTS = re.compile(r'(?:<link rel="preconnect" href="https://fonts\.(?:googleapis|gstatic)\.com"(?: crossorigin)?>\s*)*'
                    r'<link rel="stylesheet" href="https://fonts\.googleapis\.com/css2\?[^"]*">')


def own_fonts(page: str, stamps: dict) -> str:
    css = re.sub(r"/\*.*?\*/\s*", "", (WEB / "fonts" / "fonts.css").read_text(), flags=re.S).replace("\n", "")
    css = re.sub(r"url\(/(fonts/[^)?]+)\)", lambda m: f"url(/{m.group(1)}?v={stamps[m.group(1)]})", css)     # (cached for good: _headers)
    return GFONTS.sub(lambda m: f"<style>{css}</style>", page, count=1)


# Cloudflare Pages' headers (_headers). Every address below carries its file's stamp (?v=, named by what is in it), so
# it never changes what it holds: a phone keeps it and asks again only for a new address: a reload (every mode switch
# is one) and the simulator's extra workers no longer wait on a round trip a file. Each file has its own stamp (the
# spots one for all of them), so a deploy that changes one file leaves the others' addresses, and the phone's copies,
# as they were. Everything else keeps Pages' default (asked again every time). An address here without its stamp would
# keep a phone on old bytes for a year: check_stamps fails the build on one.
IMMUTABLE = ["/game.js", "/motion.js", "/engine.js", "/game_worker.js", "/vs_core.js", "/scenario.js", "/game.json", "/playbook.json",
             "/engine_data.json", "/teams.json", "/midlogo.png", "/engine_data.pack", "/playbook.pack", "/spots/*", "/fonts/*", "/rosters/*"]
HEADERS = "".join(f"{p}\n  Cache-Control: public, max-age=31536000, immutable\n" for p in IMMUTABLE)
_stamp = lambda b: hashlib.sha256(b).hexdigest()[:12]


def stamps_of(out: Path) -> dict:
    """Each file's stamp (what is in it), by its path in the site; the spots share one ("spots/": a day's drive reads one
    of them, and they change together, with the data)."""
    st = {p.relative_to(out).as_posix(): _stamp(p.read_bytes()) for p in sorted(out.rglob("*"))
          if p.is_file() and not p.relative_to(out).as_posix().startswith("spots/") and immutable(p.relative_to(out).as_posix())}
    st["spots/"] = _stamp(b"".join(p.name.encode() + b"\0" + p.read_bytes() for p in sorted((out / "spots").iterdir())))
    return st


def immutable(path: str) -> bool:
    return any(fnmatchcase("/" + path.lstrip("/"), p) for p in IMMUTABLE)


def stamp_of(stamps: dict, path: str) -> str | None:
    return stamps.get(path) or (stamps["spots/"] if path.startswith("spots/") else None)


def check_stamps(out: Path, stamps: dict) -> None:
    """Fail the build on any address cached for good (_headers) named without its stamp: in a page (src, href, url())
    the stamp itself; in a shipped script, a name only as asset('...') (game.js) or at('...') (game_worker.js), the
    two that stamp it."""
    bad = []
    for p in sorted(out.rglob("*.html")):
        for u in re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']|url\(\s*["\']?([^)"\']+)', p.read_text()):
            u = u[0] or u[1]
            if re.match(r"[a-z]+:|//|#", u):
                continue
            path, _, q = u.partition("?")
            path = path.removeprefix("./").lstrip("/")
            m = re.fullmatch(r"(.+)\.([0-9a-f]{12})(\.\w+)", path)
            if m and stamps.get(m.group(1) + m.group(3)) == m.group(2):
                continue                     # (the stamp in the name itself: game.<stamp>.js)
            if immutable(path) and (not stamp_of(stamps, path) or f"v={stamp_of(stamps, path)}" not in q.split("&")):
                bad.append(f"{p.name}: {u}")
    alts = [re.escape(p.lstrip("/")[:-1]) if p.endswith("*") else re.escape(p.lstrip("/")) + r"(?=[?'\"`])" for p in IMMUTABLE]
    named = re.compile(r"""['"`](?:\./|/)?(?:""" + "|".join(alts) + ")")
    for f in SCRIPTS:
        js = (out / f).read_text()
        for m in named.finditer(js):
            # (a name may also be one side of a choice inside the call: at(cfb ? 'a.json' : 'b.json'))
            if not re.search(r"\b(?:asset|at)\(\s*(?:[\w$.]+\s*\?\s*(?:(['\"`])[^'\"`]*\1\s*:\s*)?)?$", js[max(0, m.start() - 80):m.start()]):
                bad.append(f"{f}: ...{js[max(0, m.start() - 40):m.end() + 20]}...")
    if bad:
        raise SystemExit("site.py: addresses cached for good (_headers) named without their stamp:\n  " + "\n  ".join(bad[:20]))

# The scripts shipped without their comments and indentation (esbuild, whitespace and syntax only: every name kept, so
# an error still names its function): a third less to download and parse before the intro and the first call. The
# files in web/ stay as written (the claude.ai artifact, the Node checks); without npx (an offline build) so does the site.
SCRIPTS = ["game.js", "motion.js", "engine.js", "game_worker.js", "vs_core.js", "scenario.js"]
# what the page loads ahead of game.js, shipped inside it (build: one file, one stamp): motion.js the players' movement,
# vs_core.js college overtime's rules (Versus, a college game), scenario.js Pro's scenarios
PAGE_BUNDLE = ["motion.js", "vs_core.js", "scenario.js"]
ESBUILD = "esbuild@0.24.0"


def minify_scripts(out: Path) -> None:
    try:
        r = subprocess.run(["npx", "--yes", ESBUILD, *SCRIPTS, "--minify-whitespace", "--minify-syntax", "--log-level=warning",
                            "--outdir=.", "--allow-overwrite"], cwd=out, capture_output=True, text=True, timeout=600)
        ok = r.returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        r, ok = e, False
    if not ok:
        print(f"site.py: scripts not minified ({getattr(r, 'stderr', r)!s:.300}); shipping them as written")


# The first call's facts of every spot (web/spot_info.js: the site's own worker, scripts and packs, in node), shipped
# in each spot's file so the first call shows before the simulator's data is in (game.js firstInfo). About half a
# minute on 4 cores; kept (the temp folder) under a stamp of everything it reads, so the next build of the same files
# (CI builds the site three times) takes it as it is. A spot whose facts differ between the two ways spot_info.js
# works them out fails the build
def spot_info(out: Path) -> dict:
    reads = [out / f for f in (*SCRIPTS, *PACKED.values(), "game.json")] + sorted((out / "spots").glob("s*.json")) + [
        WEB / "spot_info.js", WEB / "engine_data.json", WEB / "playbook.json", *(WEB / f for f in SCRIPTS)]
    try:
        node = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=60).stdout.encode()
    except (OSError, subprocess.SubprocessError) as e:
        print(f"site.py: no node ({e}); the first call waits on the simulator")      # (the page asks the worker)
        return {}
    key = _stamp(node + b"".join(p.name.encode() + b"\0" + p.read_bytes() for p in reads))
    keep = Path(tempfile.gettempdir()) / f"nflclock-spot-info-{key}.json"
    if keep.exists():
        return json.loads(keep.read_text())
    r = subprocess.run(["node", str(WEB / "spot_info.js"), str(out)], capture_output=True, text=True, timeout=1800)
    if r.returncode:
        raise SystemExit(f"site.py: the spots' first calls could not be worked out:\n{r.stderr[-2000:]}")
    keep.with_suffix(".tmp").write_text(r.stdout)
    keep.with_suffix(".tmp").replace(keep)
    return json.loads(r.stdout)


# The simulator's data (engine_data.json, playbook.json: typed arrays as base64 in JSON) re-packed for phones: the
# same arrays as raw bytes, the integer index arrays as differences and every multi-byte array byte-plane shuffled
# (both lossless, both gzip much better), gzipped. Half the download before the first snap. The page gunzips it
# (DecompressionStream) and vs_core.js unpacks it in the worker; browsers without one, and the claude.ai artifact, still load the JSON.
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


# The playbook's plays are nearly all the engine library's plays, in nearly the same order: its EPA, yards, clock and
# flags are stored as the bytes that differ from the library's row (XOR: zeros where they match, which gzip all but
# drops), with the row each play matches (src, -1 for none). A fifth of the download; unpacked bit for bit the same.
REFS = {("rows", k): ("lib", k) for k in ("epa", "yards", "dur10", "to_rel", "flags")}


def _arr(spec: dict) -> np.ndarray:
    return np.frombuffer(base64.b64decode(spec["b64"]), dtype=spec["dtype"])[: spec["n"]]


def _align(lib_epa: np.ndarray, epa: np.ndarray) -> np.ndarray:
    """For each play, the library row with the same EPA bits: the row after the last match when it is one (the order
    is nearly the same, so the differences of src are nearly all 1), else the first such row, else -1."""
    first: dict[int, int] = {}
    for i, b in enumerate(lib_epa.view(np.uint32).tolist()):
        first.setdefault(b, i)
    lb, out, prev = lib_epa.view(np.uint32), np.full(len(epa), -1, np.int32), -1
    for i, b in enumerate(epa.view(np.uint32).tolist()):
        j = prev + 1 if prev + 1 < len(lb) and lb[prev + 1] == b else first.get(b, -1)
        out[i] = j
        if j >= 0:
            prev = j
    return out


def pack(src: Path, dst: Path, ref: dict | None = None) -> int:
    """src JSON -> dst: gzip("NFCP", uint32 header length, header JSON, blob); each base64 array in the JSON becomes
    {dtype, n, enc, off, len} pointing into the blob. With ref (the engine data's JSON), the arrays in REFS may be
    enc x (xs: shuffled too): XOR with ref's array (a path, "ref") at the rows in "src" (an int32 array, its own spec)."""
    blob = bytearray()
    doc = json.loads(src.read_text())
    srcs: dict = {}
    if ref is not None:
        lib = ref["lib"]
        rows = doc.get("rows", {})
        if "epa" in rows and "epa" in lib:
            s = _align(_arr(lib["epa"]), _arr(rows["epa"]))
            sh, sraw = _encode({"dtype": "int32", "n": len(s), "b64": base64.b64encode(s.tobytes()).decode()})
            sh.update(off=len(blob), len=len(sraw))
            blob.extend(sraw)
            srcs = {"head": sh, "idx": s}

    def xor(spec: dict, path: tuple) -> tuple[dict, bytes] | None:
        rp = REFS.get(path)
        r = ref and rp and ref.get(rp[0], {}).get(rp[1])
        if not srcs or not r or r["dtype"] != spec["dtype"] or spec["n"] != len(srcs["idx"]):
            return None
        a, b = _arr(spec), _arr(r)
        s = srcs["idx"]
        got = np.zeros_like(a)
        got[s >= 0] = b[s[s >= 0]]
        x = (a.view(np.uint8) ^ got.view(np.uint8)).view(a.dtype)
        cands = {"x": x.tobytes()}
        if x.itemsize > 1:
            cands["xs"] = x.view(np.uint8).reshape(-1, x.itemsize).T.tobytes()
        enc = min(cands, key=lambda k: (len(zlib.compress(cands[k], 6)), len(k)))
        return {"dtype": spec["dtype"], "n": int(spec["n"]), "enc": enc, "ref": list(rp), "src": srcs["head"]}, cands[enc]

    def walk(x, path=()):
        if isinstance(x, dict):
            if "b64" in x and "dtype" in x:
                head, raw = _encode(x)
                alt = xor(x, path)
                if alt and len(zlib.compress(alt[1], 6)) < len(zlib.compress(raw, 6)):
                    head, raw = alt
                head.update(off=len(blob), len=len(raw))
                blob.extend(raw)
                return head
            return {k: walk(v, path + (k,)) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    header = json.dumps(walk(doc), separators=(",", ":"), allow_nan=False).encode()
    data = b"NFCP" + struct.pack("<I", len(header)) + header + bytes(blob)
    dst.write_bytes(gzip.compress(data, 9, mtime=0))
    return dst.stat().st_size


# Google AdSense: the site verification meta and the ad script (in every page's head), and with an ad unit's slot id
# the pages show that unit on the screens between games (game.js / stats.html read the two metas). Off unless given.
# The game's page has the script's address in a meta instead (ADSENSE_LATER): game.js loads it once the game is up
# (adsSoon: on idle after the first play, its data in), not during start-up, where it competed with the game's files
ADSENSE_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={id}"
ADSENSE_TAG = ("<meta name=\"google-adsense-account\" content=\"{id}\">"
               "<script async src=\"" + ADSENSE_SRC + "\" crossorigin=\"anonymous\"></script>")
ADSENSE_LATER = "<meta name=\"google-adsense-account\" content=\"{id}\"><meta name=\"ads-src\" content=\"" + ADSENSE_SRC + "\">"


# Another ad network's units (Adsterra and the like, whose approval is quicker than AdSense's): each unit's code, as
# the network gives it, in web/ads/<slot>.html (a first line "<!-- size: WxH -->" gives its size). Each is served as its
# own page (ad-<slot>.html) shown in a sandboxed frame (its script can't touch the page or send it elsewhere; a tap on
# the ad opens it in a new tab), labeled, never where a play is called or run:
#   banner  300x250: the results screen between games (game.js, stats.html), and mid-page on How it works and About
#   native  native cards: above the footer of every page but the privacy policy
#   leader  728x90: above the footer, desktops; mobile 320x50: above the footer, phones
#   side    160x600 or 300x600: pinned in the empty margins beside the page, wide desktop screens only
# Lines in web/ads/ads.txt go into ads.txt after Google's.
ADS = WEB / "ads"
SLOT_SIZE = {"banner": "300x250", "native": "100%x300", "leader": "728x90", "mobile": "320x50", "side": "160x600"}
BANNER = ADS / "banner.html"


# In the sandboxed frame (no allow-same-origin: the ad can't reach the game) the browser refuses storage and cookies, and
# a network script that touches them throws before it shows anything: give it working in-memory stand-ins
STORAGE_SHIM = ("<script>(function(){function M(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},"
                "removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}"
                "['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:M(),configurable:true})}catch(e2){}}});"
                "try{document.cookie}catch(e){var c='';try{Object.defineProperty(document,'cookie',{get:function(){return c},set:function(v){var p=String(v).split(';')[0];"
                "c=c?c+'; '+p:p},configurable:true})}catch(e2){}}})();</script>")


NO_ADS = False          # --no-ads: no ad anywhere (no unit, no AdSense, no ads.txt), whatever web/ads holds
EZOIC = False           # --ezoic-head: Ezoic serves the page's ads (its slots in place of every other network's units)
# an Ezoic spot (EzoicAds step 3, as Ezoic gives it): the ad shows where the snippet is, Ezoic picks its size
EZOIC_SLOT = ('<div class="adslot ezslot"><script>ezstandalone.cmd.push(function () { ezstandalone.showAds({}); });</script></div>')


def slot_code(slot: str) -> str:
    if NO_ADS:
        return ""
    f = ADS / f"{slot}.html"
    return f.read_text() if f.exists() and f.read_text().strip() else ""


def slot_size(slot: str) -> tuple[str, str]:
    m = re.search(r"size:\s*(\d+%?)x(\d+)", slot_code(slot))
    w, h = (m.group(1), m.group(2)) if m else SLOT_SIZE[slot].split("x")
    return w, h


def ad_frame(slot: str) -> str:
    """A unit's sandboxed frame, labeled (empty when the unit has no code)."""
    if EZOIC and not NO_ADS:
        return EZOIC_SLOT if slot in ("banner", "native") else ""     # (one spot each: mid-page, above the footer)
    if not slot_code(slot):
        return ""
    w, h = slot_size(slot)
    css_w = w if w.endswith("%") else f"{w}px"
    return (f'<div class="adslot ad-{slot}"><div class="adlab">Advertisement</div><iframe src="/ad-{slot}.html" title="Advertisement" '
            f'loading="lazy" scrolling="no" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" '
            f'style="display:block;margin:0 auto;border:0;max-width:100%;width:{css_w};height:{h}px"></iframe></div>')


AD_CSS = ("<style>.adslot{margin:22px auto 0;max-width:100%;text-align:center}.adslot .adlab{font:600 10.5px/1 system-ui,sans-serif;"
          "letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#5a675e);margin-bottom:4px}"
          ".ad-native{max-width:680px;padding:0 16px}.ad-leader{display:none}"
          "@media (min-width:800px){.ad-leader{display:block}.ad-mobile{display:none}}"
          ".adrail{display:none}@media (min-width:1500px){.adrail{display:block;position:fixed;top:110px;z-index:1}"
          ".adrail.l{left:12px}.adrail.r{right:12px}.adrail .adslot{margin:0}}</style>")


def foot_ads() -> str:
    """Above the footer (native, leader or mobile) and the side rails; nothing when no unit has code."""
    out = ad_frame("native") + ad_frame("leader") + ad_frame("mobile")
    side = ad_frame("side")
    if side:
        out += f'<div class="adrail l">{side}</div><div class="adrail r">{side}</div>'
    return out


def banner_meta() -> str:
    if not slot_code("banner"):
        return ""
    w, h = slot_size("banner")
    return f'<meta name="ad-frame" content="/ad-banner.html" data-size="{w}x{h}">'


# EzoicAds step 2 (docs.ezoic.com, site integration), as Ezoic gives it: the consent (CMP) scripts first, with
# data-cfasync="false" ahead of src so Cloudflare leaves their order alone, then sa.min.js, its command queue and analytics
EZOIC_HEAD = ('<script data-cfasync="false" src="https://cmp.gatekeeperconsent.com/min.js"></script>'
              '<script data-cfasync="false" src="https://the.gatekeeperconsent.com/cmp.min.js"></script>'
              # (Pro is ad-free: a phone marked Pro, game.js NOADS_KEY, never loads the ad script)
              '<script>(function(){var n;try{n=localStorage.getItem("tmd:v3:noads")}catch(e){}'
              'if(n){document.documentElement.classList.add("noads");var t=document.createElement("style");'
              't.textContent=".adslot,.adbox,.ad-native,#ezmobfooter,[id^=ezoic-pub-ad-placeholder]{display:none!important}";'
              'document.head.appendChild(t);return}'
              'var s=document.createElement("script");s.async=true;s.src="//www.ezojs.com/ezoic/sa.min.js";'
              'document.head.appendChild(s)})()</script>'
              '<script>window.ezstandalone = window.ezstandalone || {}; ezstandalone.cmd = ezstandalone.cmd || [];'
              # (Ezoic's rewarded ads: the Survivor extra life, game.js rewardedLife)
              'window.ezRewardedAds = window.ezRewardedAds || {}; ezRewardedAds.cmd = ezRewardedAds.cmd || [];</script>'
              '<script src="//ezoicanalytics.com/analytics.js"></script>')
EZOIC_ADSTXT = "https://srv.adstxtmanager.com/19390/{domain}"     # Ezoic's ads.txt manager (docs.ezoic.com, ads.txt setup)


def ads_head(adsense: str | None, ad_slot: str | None, later: bool = False) -> str:
    out = banner_meta()
    # (Ezoic serving the ads: no AdSense script, but the account's ownership tag on every page all the same: Google's
    # site review looks for it, and the Oct 24 review of the old address found nothing and refused the site)
    if EZOIC:
        return (f"<meta name=\"google-adsense-account\" content=\"{adsense}\">" if adsense else "") + out
    if not adsense:
        return out
    return (ADSENSE_LATER if later else ADSENSE_TAG).format(id=adsense) + (f"<meta name=\"ad-slot\" content=\"{ad_slot}\">" if ad_slot and not out else "") + out


GA_TAG = ("<script async src=\"https://www.googletagmanager.com/gtag/js?id={id}\"></script>"
          "<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}"
          "gtag('js',new Date());"
          # the page GA records: the path plus the game's mode from the address (#survivor, #archive, #drive-3 -> /drive),
          # no query string (Stripe's ?claim=, ad click ids), so the modes are their own rows and nothing lands in (other)
          "var h=location.hash.replace(/^#/,'').replace(/-\\d+$/,'');"
          "gtag('config','{id}',{{page_location:location.origin+location.pathname+(h&&/^[a-z]+$/.test(h)?(location.pathname.slice(-1)==='/'?'':'/')+h:'')}});</script>")


# Moving to a new address (--old-domain): the same build answers on both. web/move.js goes first in every page's head:
# on the old address it hands the player over (their saved progress, which a browser keeps one per address, packed into
# the new address's # and the same page there); on the new one it unpacks it, once, into what is empty, before the
# game starts. move.html (/move, on the old address) is the same handover back to a page named after #back=. Nothing at
# all without --old-domain. (Tested by scripts/move_test.py: two local addresses in Chromium.)
DEFAULT_DOMAIN = "nfl2mindrill.com"          # the site's address when --domain names none (SITE_DOMAIN unset)
HOST_RE = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


def bare_host(h: str) -> str:
    return h.strip().lower().rstrip(".").removeprefix("https://").removeprefix("http://").rstrip("/").removeprefix("www.")


def move_js(new: str | None, old: list[str]) -> str:
    """The handover from the old address(es) to the new one (web/move.js, minified when esbuild is there); nothing when
    there is no move."""
    new = bare_host(new or "")
    old = list(dict.fromkeys(o for o in (bare_host(x) for x in old) if o and o != new))
    if not new or not old:
        return ""
    for h in [new, *old]:
        if not HOST_RE.fullmatch(h):
            raise SystemExit(f"--domain / --old-domain want host names like example.com, not {h!r}")
    js = (WEB / "move.js").read_text()
    try:
        r = subprocess.run(["npx", "--yes", ESBUILD, "--minify", "--loader=js", "--target=es5", "--log-level=warning"], input=js,
                           capture_output=True, text=True, timeout=300)
        js = r.stdout if r.returncode == 0 and r.stdout.strip() else js
    except (OSError, subprocess.SubprocessError):
        pass                                 # (offline: as written)
    js, n = re.subn(r"\(\s*OLD_HOSTS\s*,\s*NEW_HOST\s*\)", lambda m: f"({json.dumps(old)},{json.dumps(new)})", js)
    if n != 1:
        raise SystemExit("site.py: web/move.js must end with (OLD_HOSTS, NEW_HOST)")
    return f"<script>{js.strip()}</script>"


def move_page(script: str, new: str) -> str:
    """/move on the old address: only the handover (nothing to show); on any other address, the front page."""
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">' + script + '<title>Two-Minute Drill</title></head>'
            '<body><script>if(!window.__tmdMoving)location.replace("/")</script>'
            f'<p><a href="https://{html.escape(new, quote=True)}/">Two-Minute Drill</a></p></body></html>\n')


# Every page: the same footer (the site's pages, the contact, the disclaimer and the data credit), its style, and the
# canonical address of the page
PAGES = [("", "Play", 1.0), ("how-it-works", "How it works", 0.8), ("faq", "FAQ", 0.7), ("drives", "The drives", 0.7), ("glossary", "Glossary", 0.6),
         ("play-callers", "Play-callers", 0.5), ("about", "About", 0.6), ("stats", "Stats", 0.6), ("patch-notes", "Patch notes", 0.5), ("privacy", "Privacy", 0.3)]
SRC = WEB.parent / "src" / "nflclock"            # the committed data some pages are built from (the schedule, the drives, the play-callers)
TEAM_CITY = {"ARI": "Arizona", "ATL": "Atlanta", "BAL": "Baltimore", "BUF": "Buffalo", "CAR": "Carolina", "CHI": "Chicago", "CIN": "Cincinnati",
             "CLE": "Cleveland", "DAL": "Dallas", "DEN": "Denver", "DET": "Detroit", "GB": "Green Bay", "HOU": "Houston", "IND": "Indianapolis",
             "JAX": "Jacksonville", "KC": "Kansas City", "LA": "Los Angeles (NFC)", "LAC": "Los Angeles (AFC)", "LV": "Las Vegas", "MIA": "Miami",
             "MIN": "Minnesota", "NE": "New England", "NO": "New Orleans", "NYG": "New York (NFC)", "NYJ": "New York (AFC)", "PHI": "Philadelphia",
             "PIT": "Pittsburgh", "SEA": "Seattle", "SF": "San Francisco", "TB": "Tampa Bay", "TEN": "Tennessee", "WAS": "Washington",
             "STL": "St. Louis", "SD": "San Diego", "OAK": "Oakland"}


def drives_html() -> str:
    """The drives page (/drives): the featured dailies so far (daily_schedule.json featured: the day's title or its matchup,
    its date and its note), newest first, then Pro's historic drives (pro_drives.json) and playoff runs (pro_runs.json).
    Days still to come are left out (a featured day is a surprise until it is up)."""
    e = lambda x: html.escape(str(x), quote=False)
    sched = json.loads((SRC / "daily_schedule.json").read_text())
    launch = datetime.strptime(sched["launch"], "%Y-%m-%d").date()
    today = datetime.now(timezone.utc).date()          # (a day is up at local midnight everywhere by noon UTC the next day; close enough)
    out = []
    for n, f in sorted(((int(k), v) for k, v in sched["featured"].items()), reverse=True):
        day = launch + timedelta(days=n - 1)
        if day > today or not f.get("note"):
            continue
        title = f.get("title")
        if not title:                                  # the matchup from the spot id: season_week_away_home#...
            parts = f["id"].split("#")[0].split("_")
            away, home = TEAM_CITY.get(parts[2]), TEAM_CITY.get(parts[3]) if len(parts) > 3 else None
            title = f"{away} at {home}" if away and home else f["id"].split("#")[0].replace("_", " ")
        out.append(f'<article class="drive"><h3>{e(title)}</h3><time datetime="{day.isoformat()}">Day {n} · {day.strftime("%B")} {day.day}, {day.year}</time>'
                   f'<p>{e(f["note"])}</p></article>')
    drives = json.loads((SRC / "pro_drives.json").read_text())
    out.append('<h2>Historic drives (Pro)</h2><p class="note">The famous endings, replayable any time: you take over where the real drive started, '
               'with the real players, and the game grades you the same way as the daily.</p>')
    for d in drives:
        if d.get("note"):
            out.append(f'<article class="drive"><h3>{e(d["title"])}</h3><p>{e(d["note"])}</p></article>')
    runs = json.loads((SRC / "pro_runs.json").read_text())
    if runs:
        out.append('<h2>Playoff runs (Pro)</h2><p>A whole postseason, one game at a time, each from a spot where the game was still in the balance. '
                   'Lose one and the run is over, as a real one is. The runs: ' + ", ".join(e(r["title"]) for r in runs) + '.</p>')
    return "\n".join(out)


def callers_html() -> str:
    """The play-callers page (/play-callers): who called each side, by season (newest first) and team, with the weeks and
    the source (src/nflclock/play_callers.json, the curated list the game matches your calls against)."""
    e = lambda x: html.escape(str(x), quote=False)
    callers = json.loads((SRC / "play_callers.json").read_text())["callers"]
    out = ['<div class="callers">']
    for season in sorted({c["season"] for c in callers}, reverse=True):
        rows = sorted((c for c in callers if c["season"] == season), key=lambda c: (TEAM_CITY.get(c["team"], c["team"]), c["side"], c["from_week"]))
        out.append(f'<h2>{season}</h2><table><thead><tr><th>Team</th><th>Side</th><th>Play-caller</th><th>Weeks</th><th>Source</th></tr></thead><tbody>')
        for c in rows:
            unc = ' class="unc"' if c.get("unverified") else ""
            name = e(c["name"]) + (" (unconfirmed)" if c.get("unverified") else "")
            src = e(c.get("source", "")) + (f' · {e(c["note"])}' if c.get("note") else "")
            out.append(f'<tr{unc}><td>{e(TEAM_CITY.get(c["team"], c["team"]))}</td><td>{"Offense" if c["side"] == "off" else "Defense"}</td>'
                       f'<td>{name}</td><td>{c["from_week"]}–{c["to_week"]}</td><td>{src}</td></tr>')
        out.append("</tbody></table>")
    out.append("</div>")
    return "\n".join(out)


def patch_notes_html(notes: dict) -> str:
    """The patch notes page's updates (web/patch_notes.json: newest first, each a date, a title and its items), as HTML.
    The newest is marked New. Game changes only (CLAUDE.md: every update to the game adds its notes at the top)."""
    e = lambda x: html.escape(x, quote=False)
    out = []
    for i, n in enumerate(notes["notes"]):
        d = datetime.strptime(n["date"], "%Y-%m-%d")
        out.append(f'<section class="pn"><time datetime="{n["date"]}">{d.strftime("%B")} {d.day}, {d.year}</time>'
                   f'<h2>{e(n["title"])}{"<span class=new>New</span>" if i == 0 else ""}</h2><ul>'
                   + "".join(f"<li>{e(x)}</li>" for x in n["items"]) + "</ul></section>")
    return "\n".join(out)
FOOT_CSS = ("<style>.sitefoot{max-width:680px;margin:28px auto 0;padding:14px 16px 28px;border-top:1px solid var(--line);"
            "font-size:12.5px;line-height:1.5;color:var(--muted)}.sitefoot nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px}"
            ".sitefoot nav a{color:var(--ink);font-weight:700;text-decoration:none}.sitefoot nav a:hover{text-decoration:underline}"
            ".sitefoot p{margin:0 0 6px;max-width:72ch}.sitefoot p a{color:inherit}"
            "h1 a.home{color:inherit;text-decoration:none}</style>")
FOOT = ('<footer class="sitefoot"><nav aria-label="Site">'
        + "".join(f'<a href="{p or "./"}">{label}</a>' for p, label, _ in PAGES)
        + '<a href="./#feedback">Report a bug</a>'
        '<a href="https://x.com/TwoMinuteDrill0" rel="noopener">Contact (X)</a></nav>'
        '<p>Two-Minute Drill is an independent, fan-made game. It is not affiliated with, endorsed by or sponsored by the '
        'National Football League, its teams, its players or the NFL Players Association. NFL, team names and player names '
        'are trademarks or property of their respective owners and are used only to identify real games.</p>'
        '<p>Data: play-by-play, participation and charting from <a href="https://github.com/nflverse" rel="noopener">nflverse</a>; '
        'FTN Data via nflverse (<a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener">CC BY-SA 4.0</a>).</p>'
        '<p>© 2026 Two-Minute Drill</p></footer>')


# The site's icon (the 2MD logo): what Google shows next to the site in search results (a square of 48 px or more,
# linked from the page, /favicon.ico at the root too), the browser tab, a phone's home screen
ICONS = ('<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">'
         '<link rel="apple-touch-icon" href="/icon-180.png"><link rel="manifest" href="/site.webmanifest">'
         '<meta name="apple-mobile-web-app-title" content="2MD">')      # the home screen's label on iOS (not the page title, cut off)


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
          site_url: str | None = None, adsense: str | None = None, ad_slot: str | None = None, pro: bool = False, vs: bool = False, vs_pro: bool = False, vs_at: str | None = None, vs_free_at: str | None = None, pro_at: str | None = None, scn_at: str | None = None, no_ads: bool = False, ezoic: str | None = None, ezoic_head: bool = False, ezoic_ids: str | None = None,
          fulldef: bool = False, google_client_id: str | None = None, old_domain: str | None = None, minify: bool = True) -> Path:
    global NO_ADS, EZOIC
    NO_ADS = no_ads
    EZOIC = ezoic_head and not no_ads
    # with Ezoic on, no other network's code on the pages (Ezoic: remove leftover ad code); ads.txt keeps the AdSense line
    tags_adsense = None if EZOIC else adsense
    adsense, ad_slot = (adsense or "").strip() or None, (ad_slot or "").strip() or None     # "" (an unset variable): off
    if no_ads:
        adsense = ad_slot = None
    if adsense and not re.fullmatch(r"ca-pub-\d{16}", adsense):
        raise SystemExit(f"--adsense wants a publisher id like ca-pub-1234567890123456, not {adsense!r}")
    google_client_id = (google_client_id or "").strip() or None          # "" (an unset variable): Sign in with Google off
    if google_client_id and not re.fullmatch(r"[0-9A-Za-z_-]+\.apps\.googleusercontent\.com", google_client_id):
        raise SystemExit(f"--google-client-id wants an OAuth client id like 1234-abc.apps.googleusercontent.com, not {google_client_id!r}")
    if ad_slot and not re.fullmatch(r"\d{6,12}", ad_slot):
        raise SystemExit(f"--ad-slot wants an ad unit's slot number, not {ad_slot!r}")
    missing = [f for f in FILES + ["stats.html", "privacy.html", "about.html", "how-it-works.html", "faq.html", "glossary.html", "drives.html", "play-callers.html", "patch-notes.html", "patch_notes.json", "admin.html", "sw.js"] if not (WEB / f).exists()] + ([] if (WEB / "spots").is_dir() else ["spots/"])
    if missing:
        raise SystemExit(f"build the game data first; missing in web/: {', '.join(missing)}")
    if out.exists():
        shutil.rmtree(out)
    (out / "spots").mkdir(parents=True)
    site_url = site_url or f"https://{(domain or DEFAULT_DOMAIN).strip()}"
    home = (domain or "").strip() or DEFAULT_DOMAIN          # the site's own address, wherever the pages name it
    olds = [o for o in (old_domain or "").split(",") if o.strip()]
    moving = handover = move_js(domain, olds)                # first in every page: the old address hands over
    if ezoic == "site":                                      # (site.yml: the site's own address, whatever it is)
        ezoic = home
    if ezoic_head and not no_ads:            # Ezoic (EzoicAds step 2): its privacy scripts, then its header script, at the top
        moving += EZOIC_HEAD                 # of every page's head, right after the old address's hand-over
    desc = "Call the plays in real NFL endings. One drive a day: beat the real coach and see how you rank."
    extra = f"<meta name=\"description\" content=\"{desc}\">" + share_tags(site_url, "Two-Minute Drill: call the plays in real NFL endings", desc)
    if ga:                                   # Google Analytics (gtag.js), as Google gives it, at the top of <head>
        if not re.fullmatch(r"G-[A-Z0-9]{4,16}", ga):
            raise SystemExit(f"--ga wants a measurement id like G-XXXXXXX, not {ga!r}")
        extra = GA_TAG.format(id=ga) + extra
    extra += ads_head(adsense, ad_slot, later=True)       # (the game's page: game.js loads the script)
    if EZOIC:                                # Ezoic's spots in the game's own cards (game.js ezBox): their placeholder ids
        if ezoic_ids and not re.fullmatch(r"\d+(,\d+){0,5}", ezoic_ids):
            raise SystemExit(f"--ezoic-ids wants up to six placeholder ids like 101,102,103, not {ezoic_ids!r}")
        extra += '<meta name="ezoic" content="on">' + (f'<meta name="ezoic-ids" content="{ezoic_ids}">' if ezoic_ids else "")
    if board_api:
        extra += f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">"
    if pro:                                  # the Pro tab (archive, historic drives, the purchase): off until it is turned on
        extra += "<meta name=\"pro\" content=\"on\">"
        if pro_at:                           # ... and not before this time (ISO, UTC): the page turns it on then
            extra += f"<meta name=\"pro-at\" content=\"{html.escape(pro_at, quote=True)}\">"
        if pro and scn_at:                   # Build a scenario (#custom) stays hidden until this time (ISO, UTC)
            extra += f"<meta name=\"scn-at\" content=\"{html.escape(scn_at, quote=True)}\">"
    if handover:                             # the old address, for the home page's way to bring progress over (/move)
        extra += f"<meta name=\"old-home\" content=\"{html.escape(next(o for o in map(bare_host, olds) if o != bare_host(domain)), quote=True)}\">"
    if google_client_id:                     # Sign in with Google on the Pro tab (the board checks the same client id)
        extra += f"<meta name=\"google-client-id\" content=\"{html.escape(google_client_id, quote=True)}\">"
    if fulldef:                              # the full defensive call in the daily and survivor: off until it is approved
        extra += "<meta name=\"fulldef\" content=\"on\">"
    if vs:                                   # Versus (two players live, board/match.js): off until it is turned on
        extra += "<meta name=\"vs\" content=\"on\">"
        if vs_pro:                           # ... as part of Pro: its lobby takes Pro (a room's link plays for anyone)
            if not pro:
                raise SystemExit("--vs-pro needs --pro")
            extra += "<meta name=\"vs-pro\" content=\"on\">"
            if vs_free_at:                   # ... until this time (ISO, UTC): everyone's from then
                try:
                    datetime.fromisoformat(vs_free_at.replace("Z", "+00:00"))
                except ValueError:
                    raise SystemExit(f"--vs-free-at wants a time like 2026-10-26T14:00:00Z, not {vs_free_at!r}")
                extra += f"<meta name=\"vs-free-at\" content=\"{html.escape(vs_free_at, quote=True)}\">"
        if vs_at:                            # ... and not before this time (ISO, UTC): a reload after shows it
            try:                             # (a time the page cannot read would turn it on at once)
                datetime.fromisoformat(vs_at.replace("Z", "+00:00"))
            except ValueError:
                raise SystemExit(f"--vs-at wants a time like 2026-10-23T17:00:00Z, not {vs_at!r}")
            extra += f"<meta name=\"vs-at\" content=\"{html.escape(vs_at, quote=True)}\">"
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WEB, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = ""
    for f in FILES:
        shutil.copy2(WEB / f, out / f)
    card = WEB / f"og.{bare_host(home)}.png"      # the link preview card drawn for this address (og_card.html), if there is one
    if card.exists():
        shutil.copy2(card, out / "og.png")
    # game.json without the time it was built (version.json keeps it): the data is rebuilt on every deploy, and that
    # alone would give the file a new stamp each time
    game = json.loads((WEB / "game.json").read_text())
    built = game.pop("built", None) if isinstance(game, dict) else None
    (out / "game.json").write_text(json.dumps(game, separators=(",", ":")))
    if (WEB / "teams.json").exists():           # Versus: the 32 teams as they line up now (nflclock.pro.versus_teams)
        shutil.copy2(WEB / "teams.json", out / "teams.json")
    # Pro's scenarios (#custom): every team-season's rosters (nflclock.scenario.build), a file a season, each with its
    # own stamp, loaded only when the builder opens (the index) and a team of that season is picked
    if (WEB / "rosters" / "index.json").exists():
        shutil.copytree(WEB / "rosters", out / "rosters")
    chunks = sorted((WEB / "spots").glob("s*.json"))
    for f in chunks:
        shutil.copy2(f, out / "spots" / f.name)
    shutil.copytree(WEB / "fonts", out / "fonts", ignore=shutil.ignore_patterns("*.css"))
    if minify:
        minify_scripts(out)
    # the page's scripts go out as one file: game.js with motion.js, vs_core.js and scenario.js ahead of it (each its own
    # IIFE). A phone that got this build's game.js beside an older build's motion.js (an iPhone, Oct 19: Motion.squeeze
    # is not a function, the field never drawn) can't any more: one file, one stamp. (vs_core.js stays a file too: the
    # simulator's worker loads it.)
    (out / "game.js").write_text("".join((out / f).read_text().rstrip().rstrip(";") + ";\n" for f in PAGE_BUNDLE) + (out / "game.js").read_text())
    eng = json.loads((WEB / "engine_data.json").read_text())
    for f, p in PACKED.items():
        pack(WEB / f, out / p, ref=eng if f == "playbook.json" else None)
    # each spot also on its own (game.js loadTeams, <meta name="spot1">): a day's drive downloads its one spot, not the
    # other 19 of its chunk; with its opening snap's facts (first: web/spot_info.js, the site's own worker on its packs)
    first = spot_info(out)
    for f in chunks:
        for i, t in json.loads(f.read_text()).items():
            (out / "spots" / f"p{i}.json").write_text(json.dumps({i: {**t, **({"first": first[i]} if i in first else {})}}, separators=(",", ":")))
    # every file the page loads carries its own stamp, named by what is in it (game.js reads them from the meta; the
    # worker's ride in its address; sw.js has them all), so a stamped address always holds the same bytes and phones keep
    # it for good (_headers); the build's own stamp (the service worker's, the page's) is named by all of them
    stamps = stamps_of(out)
    stamp = _stamp(json.dumps(stamps, sort_keys=True).encode())
    page_stamps = {k: v for k, v in stamps.items() if not k.startswith("fonts/")}       # (the fonts: in the pages' CSS)
    extra += (f"<meta name=\"build\" content=\"{stamp}\"><meta name=\"stamps\" content='{html.escape(json.dumps(page_stamps, separators=(',', ':')), quote=False)}'>"
              f"<meta name=\"spot1\" content=\"on\"><meta name=\"home\" content=\"{html.escape(home, quote=True)}\">" + canonical(site_url, "") + FOOT_CSS)
    # game.json (the intro needs it) downloads alongside game.js instead of after it: the same request game.js makes
    # (fetch: cors, same-origin credentials), so the browser hands that one over
    extra = f"<link rel=\"preload\" href=\"game.json?v={stamps['game.json']}\" as=\"fetch\" crossorigin>" + extra
    # the simulator's first worker starts here, in the head (game.js startWorker takes it: TMD_W0, the same address as
    # its workerUrl): its script, engine.js and vs_core.js download alongside game.js, not one after the other once
    # game.js has run and the day's spots are in (the bot check, Oct 26: engine.js 17.6 s on an iPhone, the first call
    # 19.6 s at worst). Not on Versus's pages (the room plays the football); a load error is kept for game.js to say
    extra += ("<script>try{if(!/^#vs/.test(location.hash)&&self.Worker){const s=JSON.parse(document.querySelector('meta[name=\"stamps\"]').content),"
              "q=['engine.js','vs_core.js','engine_data.json','playbook.json'].filter((f)=>s[f]).map((f)=>`&${f}=${encodeURIComponent(s[f])}`).join(''),"
              "u=`game_worker.js?v=${encodeURIComponent(s['game_worker.js'])}${q}`,w=new Worker(u);self.TMD_W0={u,w,err:null};"
              "w.addEventListener('error',(e)=>{self.TMD_W0&&(self.TMD_W0.err=e.message||'worker error')})}}catch(e){}</script>")
    extra += ('<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", "@type": "WebSite",
              "name": "Two-Minute Drill", "url": site_url.rstrip("/") + "/", "description": desc}) + "</script>")
    page = own_fonts((WEB / "game.html").read_text(), stamps)
    for js in PAGE_BUNDLE:                   # (in game.js: above)
        page = page.replace(f'<script src="{js}"></script>', '')
    # the page's script under a name that carries its stamp (game.<stamp>.js), not only ?v=: a cache in front of the site
    # that keys on the path alone (Oct 19: iPhones kept getting an older build's game.js, and motion.js before it, under
    # this build's ?v=) can't hand an old copy for a new address
    # (Pages' default cache for it, asked again on every load: an older page's name is gone after the next deploy, and
    # Pages answers a missing address with the front page, which must not be kept for a year as the script)
    shutil.copy2(out / "game.js", out / f"game.{stamps['game.js']}.js")
    page = page.replace('<script src="game.js"></script>', f'<script src="game.{stamps["game.js"]}.js"></script>')
    (out / "index.html").write_text(HEAD.format(extra=moving + extra + AD_CSS) + page.replace("<!--SITE-FOOT-->", foot_ads() + FOOT) + "</body></html>\n")
    # the stats page (/stats): its own document; the same analytics tag and backend address
    stats_head = (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, "Two-Minute Drill stats",
        "How everyone did on the daily drive: players per day, the score spread and the top ten.", "stats") + (
        f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">" if board_api else "")
    fill = lambda name, head, path, ads=True: (out / name).write_text(own_fonts((WEB / name).read_text(), stamps).replace(DEFAULT_DOMAIN, home).replace("<!--SITE-HEAD-->",
        moving + head + canonical(site_url, path) + FOOT_CSS + AD_CSS).replace("<!--AD-MID-->", ad_frame("banner") if ads else "")
        .replace("<!--SITE-FOOT-->", (foot_ads() if ads else "") + FOOT))
    fill("stats.html", stats_head, "stats")
    # the guide and the about page (content: the same analytics and ad tags as the game)
    for name, path, title, d in (("how-it-works.html", "how-it-works", "How Two-Minute Drill works",
                                  "Real NFL late-game situations, 27 play calls, real plays on every snap, and calls graded on win chance."),
                                 ("about.html", "about", "About Two-Minute Drill",
                                  "An independent, fan-made NFL play-calling game built on public nflverse data."),
                                 ("faq.html", "faq", "Two-Minute Drill FAQ",
                                  "The grade, the daily, streaks, Survivor, Versus, the Draft, Pro and the data behind the game."),
                                 ("glossary.html", "glossary", "Two-minute football glossary",
                                  "Clock rules, the calls, the defense, how the grade works, and the game's own terms."),
                                 ("drives.html", "drives", "The drives",
                                  "The featured dailies so far and the story behind each, plus the historic drives and playoff runs."),
                                 ("play-callers.html", "play-callers", "The play-callers",
                                  "Who really called the plays, team by team and week by week: the list your calls are matched against.")):
        fill(name, (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, title, d, path), path)
    # the pages built from the committed data: the drives (the schedule's featured days, Pro's drives and runs) and the play-callers
    (out / "drives.html").write_text((out / "drives.html").read_text().replace("<!--DRIVES-->", drives_html()))
    (out / "play-callers.html").write_text((out / "play-callers.html").read_text().replace("<!--CALLERS-->", callers_html()))
    # the patch notes (/patch-notes): every update to the game, from web/patch_notes.json
    fill("patch-notes.html", (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url,
         "Two-Minute Drill patch notes", "Every change to the game, newest first.", "patch-notes"), "patch-notes")
    (out / "patch-notes.html").write_text((out / "patch-notes.html").read_text().replace("<!--NOTES-->",
        patch_notes_html(json.loads((WEB / "patch_notes.json").read_text()))))
    # the privacy page (AdSense wants one): the analytics tag only, no ads on it
    fill("privacy.html", (GA_TAG.format(id=ga) if ga else "") + ICONS, "privacy", ads=False)
    # the Gauntlet's audit (admin.html, the check before a prize): not linked anywhere, not in the sitemap, noindex; no
    # analytics, no ads, no site chrome; only the backend's address (the admin token is pasted on the page)
    (out / "admin.html").write_text((WEB / "admin.html").read_text().replace("<!--SITE-HEAD-->",
        f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">" if board_api else ""))
    # the installed app (Add to Home Screen): opened from its icon, it says so to analytics (utm_source), and id keeps
    # it the same app if start_url ever changes; the splash is the icon's navy, the bar the page's theme-color
    (out / "site.webmanifest").write_text(json.dumps({"id": "/", "name": "Two-Minute Drill", "short_name": "2MD", "description": desc,
        "start_url": "/?utm_source=homescreen&utm_medium=pwa", "scope": "/", "display": "standalone",
        "background_color": "#051d43", "theme_color": "#2c7549", "categories": ["games", "sports"], "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
            {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}, indent=1) + "\n")
    # the service worker (web/sw.js: network first, its cache only offline), stamped with this build: a new build is a new
    # worker, which drops the last build's cache (all but the files this build names as they were: __STAMPS__)
    (out / "sw.js").write_text((WEB / "sw.js").read_text().replace("__BUILD__", stamp).replace("'__STAMPS__'", json.dumps(stamps, separators=(",", ":"))))
    # for crawlers: every page allowed, and the sitemap of the site's pages
    base = site_url.rstrip("/")
    (out / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {base}/sitemap.xml\n")
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (out / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{base}/{p}</loc><lastmod>{day}</lastmod><changefreq>{'daily' if p in ('', 'stats') else 'monthly'}</changefreq>"
                  f"<priority>{pr}</priority></url>\n" for p, _, pr in PAGES) + "</urlset>\n")
    # ads.txt: who may sell this site's ad space (Google's line, with our id, then any other network's lines)
    extra = (WEB / "ads" / "ads.txt").read_text().strip() if (WEB / "ads" / "ads.txt").exists() and not no_ads else ""
    lines = ([f"google.com, {adsense.replace('ca-', '', 1)}, DIRECT, f08c47fec0942fa0"] if adsense else []) + ([extra] if extra else [])
    if ezoic and not no_ads:
        # Ezoic manages ads.txt (their ads.txt manager; Ezoic asks for this redirect before it submits the site to Google):
        # Cloudflare Pages' _redirects sends /ads.txt there, and no ads.txt of our own is written. Other lines (AdSense's)
        # go in through Ezoic's ads.txt manager
        (out / "_redirects").write_text(f"/ads.txt {EZOIC_ADSTXT.format(domain=ezoic)} 301\n")
    elif lines:
        (out / "ads.txt").write_text("\n".join(lines) + "\n")
    for slot in SLOT_SIZE:                   # each unit's own page (its frame's)
        if slot_code(slot):
            (out / f"ad-{slot}.html").write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">'
                '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;overflow:hidden;'
                'background:transparent;display:flex;justify-content:center}</style>' + STORAGE_SHIM + '</head><body>' + slot_code(slot)
                + "</body></html>\n")
    (out / "_headers").write_text(HEADERS)
    # The Pro data (web/pro, nflclock.pro.build) is never copied here: the board worker serves it (POST /pro/data)
    # only to a valid Pro code, so it cannot be fetched from the site without the purchase.
    # the daily reminder (game.js reminderNodes): a calendar event every day at the hour the player picks, for Apple and
    # Outlook calendars (Google's gets its own link); a floating time, so it is that hour wherever the phone is
    start = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y%m%d")
    for h in (8, 12, 19):
        (out / f"remind-{h}.ics").write_text("\r\n".join([
            "BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:-//{home.split('.')[0]}//Two-Minute Drill//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
            # (the event's id never moves with the address: a calendar that has it updates it, not a second one)
            "BEGIN:VEVENT", f"UID:tmd-daily-{h}@{DEFAULT_DOMAIN}", f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            f"DTSTART:{start}T{h:02d}0000", "DURATION:PT10M", "RRULE:FREQ=DAILY", "SUMMARY:Two-Minute Drill: today's drive",
            f"DESCRIPTION:Keep your streak going: {base}", f"URL:{base}", "BEGIN:VALARM", "ACTION:DISPLAY",
            "DESCRIPTION:Two-Minute Drill: today's drive", "TRIGGER:PT0M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"]) + "\r\n", newline="")
    if domain:
        (out / "CNAME").write_text(domain.strip() + "\n")
    if handover:                             # /move on the old address: the handover on its own (a redirect rule leaves it be)
        (out / "move.html").write_text(move_page(handover, bare_host(domain)))
    (out / ".nojekyll").write_text("")          # serve the files as they are
    (out / "version.json").write_text(json.dumps({
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "commit": commit or None, "data_built": built,
        "spots": len(game.get("spots", [])) if isinstance(game, dict) else None}, indent=1) + "\n")
    check_stamps(out, stamps)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="_site")
    ap.add_argument("--domain")
    ap.add_argument("--old-domain", help="the address(es) the site is moving from, comma-separated: their visitors are handed over, saved progress and all")
    ap.add_argument("--board-api")
    ap.add_argument("--ga", help="Google Analytics measurement id (G-...)")
    ap.add_argument("--site-url", help=f"the site's address for link previews (default https://<domain>, else {DEFAULT_DOMAIN})")
    ap.add_argument("--adsense", help="Google AdSense publisher id (ca-pub-...); empty: no ads")
    ap.add_argument("--ad-slot", help="an AdSense display ad unit's slot id, shown between games; empty: AdSense's own placement only")
    ap.add_argument("--ezoic", metavar="DOMAIN", help="/ads.txt redirects to Ezoic's ads.txt manager for this domain (Cloudflare Pages _redirects); site: the site's own (--domain)")
    ap.add_argument("--ezoic-head", action="store_true", help="Ezoic's privacy and header scripts at the top of every page")
    ap.add_argument("--ezoic-ids", help="Ezoic placeholder ids for the game's cards: end of the day's drive, survivor's card after a game, survivor's run over (e.g. 101,102,103)")
    ap.add_argument("--no-ads", action="store_true", help="no ads anywhere on the site (overrides --adsense and web/ads)")
    ap.add_argument("--no-minify", action="store_true", help="ship the scripts as written (no esbuild)")
    ap.add_argument("--scn-at", help="with --pro: Build a scenario stays hidden until this time (ISO 8601, UTC)")
    ap.add_argument("--pro-at", help="with --pro: the Pro tab stays hidden until this time (ISO 8601, e.g. 2026-10-16T18:00:00Z)")
    ap.add_argument("--vs", action="store_true", help="turn on Versus (two players live); off until approved")
    ap.add_argument("--vs-pro", action="store_true", help="with --vs and --pro: Versus is part of Pro (its lobby takes Pro)")
    ap.add_argument("--vs-free-at", help="with --vs-pro: Versus is everyone's from this time (ISO 8601, UTC)")
    ap.add_argument("--vs-at", help="with --vs: Versus stays hidden until this time (ISO 8601, UTC)")
    ap.add_argument("--fulldef", action="store_true", help="the full defensive call (personnel, front, coverage, rush) in every mode; off until approved")
    ap.add_argument("--google-client-id", help="a Google OAuth web client id (....apps.googleusercontent.com): Sign in with Google on the Pro tab; empty: off")
    ap.add_argument("--pro", action="store_true", help="turn on the Pro tab (the archive, the historic drives, the purchase); off until approved")
    a = ap.parse_args()
    o = build(Path(a.out), a.domain, a.board_api, a.ga, a.site_url, a.adsense, a.ad_slot, pro=a.pro, pro_at=a.pro_at, scn_at=a.scn_at, vs=a.vs, vs_pro=a.vs_pro, vs_at=a.vs_at, vs_free_at=a.vs_free_at, fulldef=a.fulldef, no_ads=a.no_ads, ezoic=a.ezoic, ezoic_head=a.ezoic_head, ezoic_ids=(a.ezoic_ids or '').strip() or None, minify=not a.no_minify,
              google_client_id=a.google_client_id, old_domain=a.old_domain)
    n = sum(1 for _ in o.rglob("*") if _.is_file())
    size = sum(p.stat().st_size for p in o.rglob("*") if p.is_file()) / 1e6
    print(f"site in {o}: {n} files, {size:.1f} MB")
