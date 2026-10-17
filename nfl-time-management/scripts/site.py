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
import hashlib
import html
import struct
import zlib
import re
import json
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

WEB = Path(__file__).resolve().parents[1] / "web"
FILES = ["game.js", "motion.js", "engine.js", "game_worker.js", "vs_core.js", "game.json", "playbook.json", "engine_data.json",
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
ADSENSE_TAG = ("<meta name=\"google-adsense-account\" content=\"{id}\">"
               "<script async src=\"https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={id}\" crossorigin=\"anonymous\"></script>")


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


def ads_head(adsense: str | None, ad_slot: str | None) -> str:
    out = banner_meta()
    if not adsense:
        return out
    return ADSENSE_TAG.format(id=adsense) + (f"<meta name=\"ad-slot\" content=\"{ad_slot}\">" if ad_slot and not out else "") + out


GA_TAG = ("<script async src=\"https://www.googletagmanager.com/gtag/js?id={id}\"></script>"
          "<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}"
          "gtag('js',new Date());"
          # the page GA records: the path plus the game's mode from the address (#survivor, #archive, #drive-3 -> /drive),
          # no query string (Stripe's ?claim=, ad click ids), so the modes are their own rows and nothing lands in (other)
          "var h=location.hash.replace(/^#/,'').replace(/-\\d+$/,'');"
          "gtag('config','{id}',{{page_location:location.origin+location.pathname+(h&&/^[a-z]+$/.test(h)?(location.pathname.slice(-1)==='/'?'':'/')+h:'')}});</script>")


# Moving to a new address (--old-domain): the same build answers on both. On the old one the first thing in every page
# packs the player's saved progress (local storage, which belongs to one address) into the link's # (never sent to a
# server) and goes to the same page on the new one, which unpacks it before the game starts, keeping what is already
# there (a day already in the new address's stats stays). Essentials first (stats, Pro code, name, sign-in, device key,
# settings), then today's drive in progress, then the rest while the link stays under 150 KB.
MOVE_JS = """<script>(function(){var OLD=%(old)s,NEW=%(new)s,P='tmd:',H='#tmd-move=';
function e(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function d(s){s=s.replace(/-/g,'+').replace(/_/g,'/');return decodeURIComponent(escape(atob(s)))}
var host=location.hostname.replace(/^www\\./,'');
try{if(OLD.indexOf(host)>=0&&NEW&&host!==NEW){window.__tmdMoving=1;
var ks=[],day=-1,i,k,m,o={},n=0,keep=location.hash||'';
for(i=0;i<localStorage.length;i++){k=localStorage.key(i);if(k&&k.indexOf(P)===0){ks.push(k);m=/:day:(\\d+)$/.exec(k);if(m&&+m[1]>day)day=+m[1]}}
var big=/:(day|drive|run|surv|practice)(:|$)|:tend$/,rank=function(k){return !big.test(k)?0:k.slice(-(':day:'+day).length)===':day:'+day?1:2};
ks.sort(function(a,b){return rank(a)-rank(b)});
for(i=0;i<ks.length;i++){k=ks[i];var v=localStorage.getItem(k);if(rank(k)===2&&/:day:\\d+$/.test(k))continue;if(n+k.length+v.length>110000)continue;o[k]=v;n+=k.length+v.length}
location.replace(location.protocol+'//'+NEW+location.pathname+location.search+(ks.length?H+e(JSON.stringify(o))+(keep?'&h='+encodeURIComponent(keep.slice(1)):''):keep));return}
if(location.hash.indexOf(H)===0){var raw=location.hash.slice(H.length),at=raw.indexOf('&h='),h=at>=0?decodeURIComponent(raw.slice(at+3)):'',got=JSON.parse(d(at>=0?raw.slice(0,at):raw));
for(var key in got){if(key.indexOf(P)!==0)continue;var cur=localStorage.getItem(key);
if(cur===null)localStorage.setItem(key,got[key]);
else if(/:stats$/.test(key)){var a=JSON.parse(cur),b=JSON.parse(got[key]);a.days=a.days||{};for(var dk in (b.days||{}))if(!a.days[dk])a.days[dk]=b.days[dk];localStorage.setItem(key,JSON.stringify(a))}}
history.replaceState(null,'',location.pathname+location.search+(h?'#'+h:''))}}catch(x){}})();</script>"""


def move_js(new: str | None, old: list[str]) -> str:
    """The handoff from the old address(es) to the new one; nothing when there is no move."""
    if not new or not old:
        return ""
    return MOVE_JS % {"old": json.dumps([o.strip().lower().removeprefix("www.") for o in old if o.strip()]), "new": json.dumps(new.strip().lower())}


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
          site_url: str | None = None, adsense: str | None = None, ad_slot: str | None = None, pro: bool = False, vs: bool = False, pro_at: str | None = None, no_ads: bool = False,
          fulldef: bool = False, google_client_id: str | None = None, old_domain: str | None = None) -> Path:
    global NO_ADS
    NO_ADS = no_ads
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
    missing = [f for f in FILES + ["stats.html", "privacy.html", "about.html", "how-it-works.html", "admin.html", "sw.js"] if not (WEB / f).exists()] + ([] if (WEB / "spots").is_dir() else ["spots/"])
    if missing:
        raise SystemExit(f"build the game data first; missing in web/: {', '.join(missing)}")
    if out.exists():
        shutil.rmtree(out)
    (out / "spots").mkdir(parents=True)
    site_url = site_url or f"https://{(domain or 'nfl2mindrill.com').strip()}"
    home = (domain or "").strip() or "nfl2mindrill.com"          # the site's own address, wherever the pages name it
    moving = move_js(domain, (old_domain or "").split(","))      # first in every page: the old address hands over
    desc = "Call the plays in real NFL endings. One drive a day: beat the real coach and see how you rank."
    extra = f"<meta name=\"description\" content=\"{desc}\">" + share_tags(site_url, "Two-Minute Drill: call the plays in real NFL endings", desc)
    if ga:                                   # Google Analytics (gtag.js), as Google gives it, at the top of <head>
        if not re.fullmatch(r"G-[A-Z0-9]{4,16}", ga):
            raise SystemExit(f"--ga wants a measurement id like G-XXXXXXX, not {ga!r}")
        extra = GA_TAG.format(id=ga) + extra
    extra += ads_head(adsense, ad_slot)
    if board_api:
        extra += f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">"
    if pro:                                  # the Pro tab (archive, historic drives, the purchase): off until it is turned on
        extra += "<meta name=\"pro\" content=\"on\">"
        if pro_at:                           # ... and not before this time (ISO, UTC): the page turns it on then
            extra += f"<meta name=\"pro-at\" content=\"{html.escape(pro_at, quote=True)}\">"
    if google_client_id:                     # Sign in with Google on the Pro tab (the board checks the same client id)
        extra += f"<meta name=\"google-client-id\" content=\"{html.escape(google_client_id, quote=True)}\">"
    if fulldef:                              # the full defensive call in the daily and survivor: off until it is approved
        extra += "<meta name=\"fulldef\" content=\"on\">"
    if vs:                                   # Versus (two players live, board/match.js): off until it is turned on
        extra += "<meta name=\"vs\" content=\"on\">"
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WEB, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = ""
    stamp = (commit[:12] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"))
    # every file the page loads carries the build stamp (game.js reads the meta), so phones never mix two builds
    extra += f"<meta name=\"build\" content=\"{stamp}\"><meta name=\"home\" content=\"{html.escape(home, quote=True)}\">" + canonical(site_url, "") + FOOT_CSS
    # game.json (the intro needs it) downloads alongside game.js instead of after it: the same request game.js makes
    # (fetch: cors, same-origin credentials), so the browser hands that one over
    extra = f"<link rel=\"preload\" href=\"game.json?v={stamp}\" as=\"fetch\" crossorigin>" + extra
    eng = json.loads((WEB / "engine_data.json").read_text())
    for f, p in PACKED.items():
        pack(WEB / f, out / p, ref=eng if f == "playbook.json" else None)
    # the packs are named by what is in them (?d=, not the build's ?v=): the site deploys many times a day and the
    # data seldom changes, so a phone that has them (the service worker's copy) keeps them across deploys
    data_stamp = hashlib.sha256(b"".join((out / p).read_bytes() for p in PACKED.values())).hexdigest()[:12]
    extra += f"<meta name=\"data\" content=\"{data_stamp}\">"
    extra += ('<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", "@type": "WebSite",
              "name": "Two-Minute Drill", "url": site_url.rstrip("/") + "/", "description": desc}) + "</script>")
    page = (WEB / "game.html").read_text()
    for js in ("motion.js", "vs_core.js", "game.js"):     # vs_core.js: college overtime's rules (Versus, a college game)
        page = page.replace(f'<script src="{js}"></script>', f'<script src="{js}?v={stamp}"></script>')
    (out / "index.html").write_text(HEAD.format(extra=moving + extra + AD_CSS) + page.replace("<!--SITE-FOOT-->", foot_ads() + FOOT) + "</body></html>\n")
    # the stats page (/stats): its own document; the same analytics tag and backend address
    stats_head = (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, "Two-Minute Drill stats",
        "How everyone did on the daily drive: players per day, the score spread and the top ten.", "stats") + (
        f"<meta name=\"board-api\" content=\"{html.escape(board_api, quote=True)}\">" if board_api else "")
    fill = lambda name, head, path, ads=True: (out / name).write_text((WEB / name).read_text().replace("nfl2mindrill.com", home).replace("<!--SITE-HEAD-->",
        moving + head + canonical(site_url, path) + FOOT_CSS + AD_CSS).replace("<!--AD-MID-->", ad_frame("banner") if ads else "")
        .replace("<!--SITE-FOOT-->", (foot_ads() if ads else "") + FOOT))
    fill("stats.html", stats_head, "stats")
    # the guide and the about page (content: the same analytics and ad tags as the game)
    for name, path, title, d in (("how-it-works.html", "how-it-works", "How Two-Minute Drill works",
                                  "Real NFL late-game situations, 27 play calls, real plays on every snap, and calls graded on win chance."),
                                 ("about.html", "about", "About Two-Minute Drill",
                                  "An independent, fan-made NFL play-calling game built on public nflverse data.")):
        fill(name, (GA_TAG.format(id=ga) if ga else "") + ads_head(adsense, ad_slot) + share_tags(site_url, title, d, path), path)
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
    # worker, which drops the last build's cache (all but the packs this build still uses: their stamp, __DATA__)
    (out / "sw.js").write_text((WEB / "sw.js").read_text().replace("__BUILD__", stamp).replace("__DATA__", data_stamp))
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
    if lines:
        (out / "ads.txt").write_text("\n".join(lines) + "\n")
    for slot in SLOT_SIZE:                   # each unit's own page (its frame's)
        if slot_code(slot):
            (out / f"ad-{slot}.html").write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">'
                '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;overflow:hidden;'
                'background:transparent;display:flex;justify-content:center}</style>' + STORAGE_SHIM + '</head><body>' + slot_code(slot)
                + "</body></html>\n")
    for f in FILES:
        shutil.copy2(WEB / f, out / f)
    if (WEB / "teams.json").exists():           # Versus: the 32 teams as they line up now (nflclock.pro.versus_teams)
        shutil.copy2(WEB / "teams.json", out / "teams.json")
    for f in sorted((WEB / "spots").glob("s*.json")):
        shutil.copy2(f, out / "spots" / f.name)
    # The Pro data (web/pro, nflclock.pro.build) is never copied here: the board worker serves it (POST /pro/data)
    # only to a valid Pro code, so it cannot be fetched from the site without the purchase.
    # the daily reminder (game.js reminderNodes): a calendar event every day at the hour the player picks, for Apple and
    # Outlook calendars (Google's gets its own link); a floating time, so it is that hour wherever the phone is
    start = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y%m%d")
    for h in (8, 12, 19):
        (out / f"remind-{h}.ics").write_text("\r\n".join([
            "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//nfl2mindrill//Two-Minute Drill//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
            "BEGIN:VEVENT", f"UID:tmd-daily-{h}@nfl2mindrill.com", f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            f"DTSTART:{start}T{h:02d}0000", "DURATION:PT10M", "RRULE:FREQ=DAILY", "SUMMARY:Two-Minute Drill: today's drive",
            f"DESCRIPTION:Keep your streak going: {base}", f"URL:{base}", "BEGIN:VALARM", "ACTION:DISPLAY",
            "DESCRIPTION:Two-Minute Drill: today's drive", "TRIGGER:PT0M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"]) + "\r\n", newline="")
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
    ap.add_argument("--old-domain", help="the address(es) the site is moving from, comma-separated: their visitors are handed over, saved progress and all")
    ap.add_argument("--board-api")
    ap.add_argument("--ga", help="Google Analytics measurement id (G-...)")
    ap.add_argument("--site-url", help="the site's address for link previews (default https://<domain>, else nfl2mindrill.com)")
    ap.add_argument("--adsense", help="Google AdSense publisher id (ca-pub-...); empty: no ads")
    ap.add_argument("--ad-slot", help="an AdSense display ad unit's slot id, shown between games; empty: AdSense's own placement only")
    ap.add_argument("--no-ads", action="store_true", help="no ads anywhere on the site (overrides --adsense and web/ads)")
    ap.add_argument("--pro-at", help="with --pro: the Pro tab stays hidden until this time (ISO 8601, e.g. 2026-10-16T18:00:00Z)")
    ap.add_argument("--vs", action="store_true", help="turn on Versus (two players live); off until approved")
    ap.add_argument("--fulldef", action="store_true", help="the full defensive call (personnel, front, coverage, rush) in every mode; off until approved")
    ap.add_argument("--google-client-id", help="a Google OAuth web client id (....apps.googleusercontent.com): Sign in with Google on the Pro tab; empty: off")
    ap.add_argument("--pro", action="store_true", help="turn on the Pro tab (the archive, the historic drives, the purchase); off until approved")
    a = ap.parse_args()
    o = build(Path(a.out), a.domain, a.board_api, a.ga, a.site_url, a.adsense, a.ad_slot, pro=a.pro, pro_at=a.pro_at, vs=a.vs, fulldef=a.fulldef, no_ads=a.no_ads,
              google_client_id=a.google_client_id, old_domain=a.old_domain)
    n = sum(1 for _ in o.rglob("*") if _.is_file())
    size = sum(p.stat().st_size for p in o.rglob("*") if p.is_file()) / 1e6
    print(f"site in {o}: {n} files, {size:.1f} MB")
