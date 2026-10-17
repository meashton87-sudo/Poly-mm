// The website's service worker (registered by game.js on the real site only): what makes Two-Minute Drill installable
// (Add to Home Screen) and lets the installed app open with no signal. The game deploys often, so it never answers from
// its cache while the network answers: every page, script and data file goes to the network first (through the
// browser's own HTTP cache, as without a worker) and the copy kept here is used only when that fetch fails (offline).
// A copy is a pair: the page names its scripts and data with the build stamp (?v=...), so an offline page only ever
// finds the files of its own build. site.py writes the build stamp below: each build is a new worker (the browser
// checks sw.js on every visit: game.js registers it with updateViaCache 'none') that takes over at once and drops the
// last build's cache (keeping what this build can use: activate below). Only this site's own GETs are touched: the
// board API, fonts, analytics and ads are other origins (the browser handles them as if there were no worker), and ad
// frames, the admin page and version.json are skipped.
// To turn it off: ship a sw.js that unregisters itself (self.registration.unregister()) and deletes its caches.
const VERSION = '__BUILD__';
const CACHE = `tmd-${VERSION}`;
const KEEP = /\.(?:js|json|pack|png|svg|ico|webmanifest)$/;          // what a page loads; anything else passes through
const SKIP = /^\/(?:ad-|admin|sw\.js|version\.json|remind-)/;

self.addEventListener('install', () => self.skipWaiting());
// what of the last build's cache this build's pages can use moves over before it is dropped: the visit that brings a
// new worker is answered by the old one (into its own cache), and the new one takes over only after it, so without
// this the first visit after every deploy left nothing for the app to open with offline. A file stamped with another
// build is not this build's; nor is a page naming another build (a deploy between the page and the worker's check)
const ours = async (req, res) => {
  const v = new URL(req.url).searchParams.get('v');
  if (v !== null) return v === VERSION;
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
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        // a stamped file never changes within a build: kept once, not rewritten on every load
        e.waitUntil(caches.open(CACHE).then(async (c) => { if (!(url.searchParams.has('v') && await c.match(key))) await c.put(key, copy); })
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
