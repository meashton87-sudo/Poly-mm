// The website's service worker (registered by game.js on the real site only): what makes Two-Minute Drill installable
// (Add to Home Screen) and lets the installed app open with no signal. The game deploys often, so it never answers from
// its cache while the network answers: every page, script and data file goes to the network first (through the
// browser's own HTTP cache, as without a worker) and the copy kept here is used only when that fetch fails (offline).
// A copy is a pair: the page names each script and data file with its own stamp (?v=..., named by what is in it:
// site.py), so an offline page only ever finds the files it names. site.py writes the build's stamp and every file's
// below: each build is a new worker (the browser checks sw.js on every visit: game.js registers it with updateViaCache
// 'none') that takes over at once and drops the last build's cache (keeping the files this build names as they were:
// activate below). Only this site's own GETs are touched (its fonts too, web/fonts): the board API, analytics and ads
// are other origins (the browser handles them as if there were no worker), and ad frames, the admin page and
// version.json are skipped.
// A file named with this build's stamp for it is that file, whatever the build: answered from here first (no network).
// To turn it off: ship a sw.js that unregisters itself (self.registration.unregister()) and deletes its caches.
const VERSION = '__BUILD__';
const STAMPS = '__STAMPS__';          // { path: stamp }, the spots' one under "spots/" (site.py stamps_of)
const CACHE = `tmd-${VERSION}`;
const KEEP = /\.(?:js|json|pack|png|svg|ico|webmanifest|woff2)$/;          // what a page loads; anything else passes through
const SKIP = /^\/(?:ad-|admin|sw\.js|version\.json|remind-)/;

self.addEventListener('install', () => self.skipWaiting());
// what of the last build's cache this build's pages can use moves over before it is dropped: the visit that brings a
// new worker is answered by the old one (into its own cache), and the new one takes over only after it, so without
// this the first visit after every deploy left nothing for the app to open with offline. A file stamped otherwise than
// this build stamps it is not this build's; nor is a page naming another build (a deploy between the page and the
// worker's check)
const stampOf = (path) => (typeof STAMPS === 'object' && (STAMPS[path] || STAMPS[path.replace(/\/.*/, '/')])) || null;     // (a folder's one: spots/)
// every stamp in the address is this build's for its file (the worker's carries its scripts' and data's: game.js workerUrl)
const current = (url) => {
  const q = [...url.searchParams];
  return q.length > 0 && q.every(([k, s]) => stampOf(k === 'v' ? url.pathname.slice(1) : k) === s);
};
const ours = async (req, res) => {
  const url = new URL(req.url);
  // (an address with a query is a stamped one: an older build's ?d= packs are not this build's, else they were carried
  // from build to build for good)
  if (url.search) return current(url);
  if (!/html/.test(res.headers.get('content-type') || '')) return true;
  const m = (await res.clone().text()).match(/<meta name="build" content="([^"]*)"/);
  return !m || m[1] === VERSION;
};
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const cur = await caches.open(CACHE);
  for (const k of await caches.keys()) {
    if (!k.startsWith('tmd-') || k === CACHE) continue;
    try {
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        const res = await old.match(req);
        if (res && !(await cur.match(req)) && await ours(req, res)) await cur.put(req, res);
      }
    } catch (err) { /* storage full or off: dropped, as before */ }
    await caches.delete(k);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || SKIP.test(url.pathname) || req.headers.has('range')) return;
  const page = req.mode === 'navigate';
  if (!page && !KEEP.test(url.pathname)) return;
  // a page is kept by its path (the same page opened from the home screen, ?utm_source=..., or with a #mode)
  const key = page ? url.origin + url.pathname : req;
  // a file as this build stamps it: the same bytes whatever the build, so a copy kept here needs no network at all
  const fixed = !page && url.searchParams.has('v') && current(url);
  e.respondWith((async () => {
    if (fixed) {
      try { const hit = await (await caches.open(CACHE)).match(req); if (hit) return hit; } catch (err) { /* storage off: the network */ }
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        // a stamped file never changes within a build: kept once, not rewritten on every load
        const stamped = url.searchParams.has('v');
        e.waitUntil(caches.open(CACHE).then(async (c) => { if (!(stamped && await c.match(key))) await c.put(key, copy); })
          .catch(() => { /* storage full or off: online play is the same */ }));
      }
      return res;                        // the network's answer, whatever it is (a 404 stays a 404)
    } catch (err) {
      const c = await caches.open(CACHE);
      // the game is at / and /index.html alike: either copy opens it
      const root = page && /^\/(?:index\.html)?$/.test(url.pathname);
      const hit = (await c.match(key)) || (root ? (await c.match(url.origin + '/')) || (await c.match(url.origin + '/index.html')) : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});
