/* The address move (scripts/site.py --old-domain, only while the site moves: nothing in a build without it). The same
 * build answers on both addresses and site.py puts this first in every page's head, before any other script, with the
 * two addresses filled in at the foot (OLD: the old ones, without www.; NEW: the new one).
 *
 * On an old address it hands the player over: everything the game keeps in this browser (localStorage is one per
 * address, so the new address starts empty) is packed into the new address's #fragment, which a browser never sends to
 * a server, and the page goes to the same path, query and #hash on the new address. Nothing else on the old page runs.
 * The essentials come first (the device's key, Pro code, sign-in, username and name, the record: stats, drives, runs,
 * scenarios, settings), then what is in progress (today's drive, a survivor run, a drive or run), then the rest (older
 * days' drives, tendencies) while the link stays short enough for every browser.
 *
 * On the new address it unpacks that once, before the game starts, and takes the fragment out of the address at once
 * (the page's own #hash is put back): only from an old address's own page (the referrer: a link someone made up is not
 * a handover), only into what is empty here (nothing newer is overwritten), the record merged (a day, drive, run or
 * scenario missing here is added; one here stays as it is). Pro and the device's key go together: when this address
 * has no Pro code of its own, the old address's device key comes along with the rest, so the board (/restore: three
 * devices a code) sees the same device, not a new one, and the names it posted under stay its own.
 * /move on an old address (move.html) is the same handover, back to the page named after #back= (a path on the new
 * address). Tested in scripts/move_test.py (two local addresses in Chromium). */
/* global OLD_HOSTS, NEW_HOST */
(function (OLD, NEW) {
  var P = 'tmd:', H = 'tmd-move=', S = 'tmd:v3:';
  var bare = function (h) { return String(h || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); };
  var host = bare(location.hostname);
  var enc = function (s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var dec = function (s) { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); };
  var ID = [S + 'boardkey', S + 'pro', S + 'session', S + 'username', S + 'name'];
  // the record: a day, drive, run or scenario missing here is added (never one replaced)
  var MERGE = { 'tmd:v3:stats': ['days', 'badges', 'frozen'], 'tmd:v3:drives': [''], 'tmd:v3:runs': [''], 'tmd:v3:scen': [''] };
  if (!NEW || !OLD.length) return;

  if (OLD.indexOf(host) >= 0 && host !== NEW) {
    window.__tmdMoving = 1;
    var path = location.pathname, search = location.search, h = location.hash.replace(/^#/, ''), data = {}, st = 0;
    if (/^\/move(\.html)?\/?$/.test(path)) {
      var to = '/';
      try { to = decodeURIComponent((/^back=(.*)$/.exec(h) || [])[1] || '/'); } catch (e) { to = '/'; }
      if (!/^\/(?![/\\])/.test(to)) to = '/';                       // a path on the new address, nothing else
      var m = /^([^?#]*)(\?[^#]*)?(?:#(.*))?$/.exec(to);
      path = m[1]; search = m[2] || ''; h = m[3] || '';
    }
    try {
      var ks = [], i, k, v, day = -1, d, n = 0;
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (k && k.indexOf(P) === 0) { ks.push(k); d = /:day:(\d+)$/.exec(k); if (d && +d[1] > day) day = +d[1]; }
      }
      var big = /:(day|drive|run|surv|practice|custom|vs)(:|$)|:tend$/;
      var rank = function (k) {
        if (ID.indexOf(k) >= 0) return 0;
        if (!big.test(k)) return 1;
        return k === S + 'day:' + day || !/:(day|vs|tend)(:|$)/.test(k) ? 2 : 3;
      };
      var num = function (k) { var x = /:(\d+)$/.exec(k); return x ? +x[1] : 0; };
      ks.sort(function (a, b) { return rank(a) - rank(b) || num(b) - num(a) || (a < b ? -1 : 1); });
      // (600 000 characters of JSON at most, 800 KB of link: Firefox takes 1 MB, Chrome 2 MB; a real record is far less)
      for (i = 0; i < ks.length; i++) {
        k = ks[i]; v = localStorage.getItem(k);
        if (v == null) continue;
        var size = k.length + JSON.stringify(v).length + 4, r = rank(k);
        if (r === 0 ? size > 20000 : n + size > (r === 1 ? 600000 : 300000)) continue;
        data[k] = v; n += size;
      }
    } catch (e) { /* storage off: the address only */ }
    try { st = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches ? 1 : 0; } catch (e) { st = 0; }
    var url = location.protocol + '//' + NEW + path + search + '#' + H + enc(JSON.stringify({ v: 1, f: host, s: st, h: h, d: data }));
    location.replace(url);
    document.write('<plaintext hidden>');               // the rest of this page is text: no script, ad or tag runs here
    return;
  }

  if (host !== NEW || location.hash.indexOf('#' + H) !== 0) return;
  var body = null, ref = '';
  try { body = JSON.parse(dec(location.hash.slice(1 + H.length))); } catch (e) { body = null; }
  var keep = body && typeof body.h === 'string' && body.h.indexOf(H) !== 0 ? body.h : '';
  try { history.replaceState(history.state, '', location.pathname + location.search + (keep ? '#' + keep : '')); } catch (e) { /* (file:) */ }
  try { ref = bare(new URL(document.referrer).hostname); } catch (e) { ref = ''; }
  if (!body || typeof body.d !== 'object' || !body.d || OLD.indexOf(ref) < 0) return;
  var got = body.d, put = 0, here = function (k) { var v = localStorage.getItem(k); return v === null || v === '' ? null : v; };
  try {
    var hadPro = here(S + 'pro') !== null;
    for (var key in got) {
      if (!Object.prototype.hasOwnProperty.call(got, key) || key.indexOf(P) !== 0 || typeof got[key] !== 'string') continue;
      var cur = here(key), val = got[key];
      if (cur === null) { localStorage.setItem(key, val); put++; continue; }
      if (cur === val || !MERGE[key]) continue;
      try {
        var a = JSON.parse(cur), b = JSON.parse(val), ch = false;
        MERGE[key].forEach(function (f) {
          var x = f ? a[f] : a, y = f ? b[f] : b;
          if (!y || typeof y !== 'object' || (x && typeof x !== 'object')) return;
          if (!x) { a[f] = x = {}; }
          for (var j in y) if (Object.prototype.hasOwnProperty.call(y, j) && !Object.prototype.hasOwnProperty.call(x, j)) { x[j] = y[j]; ch = true; }
        });
        if (ch) { localStorage.setItem(key, JSON.stringify(a)); put++; }
      } catch (e) { /* not JSON: this address's own stays */ }
    }
    // Pro and the device's key go together (above): the old one's key, unless Pro here is this address's own
    if (!hadPro && got[S + 'boardkey'] && here(S + 'boardkey') !== got[S + 'boardkey']) { localStorage.setItem(S + 'boardkey', got[S + 'boardkey']); put++; }
    // the game says so once (game.js movedNote): the new address, and from an old home-screen icon, how to add the new one
    var mk = S + 'movedin', was = null;
    try { was = JSON.parse(here(mk) || 'null'); } catch (e) { was = null; }
    if (!was || typeof was !== 'object') was = { from: ref, at: Date.now(), n: put };
    if (body.s) was.s = 1;
    localStorage.setItem(mk, JSON.stringify(was));
  } catch (e) { /* storage off: the game starts empty, as on any new address */ }
  window.__tmdMovedIn = { from: ref, s: body.s ? 1 : 0, n: put };
})(OLD_HOSTS, NEW_HOST);
