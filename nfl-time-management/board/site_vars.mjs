// The worker's addresses from the site's (the GitHub variables SITE_DOMAIN and OLD_DOMAIN, the same two site.py takes):
// wrangler.toml's SITE (where emails, sign-in links and Stripe's way back point), ALLOWED_ORIGINS (the pages that may
// call the worker: the site, its www., the old address(es) while their visitors are handed over, and the Pages
// previews already listed) and OLD_SITES (the old addresses: still the site's own, never a preview). Run by the
// workflows right before `wrangler deploy`:
//   SITE_DOMAIN=example.com OLD_DOMAIN=old.example node site_vars.mjs [wrangler.toml]
// SITE_DOMAIN unset: wrangler.toml as it is. worker_test.mjs runs siteVars().
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bare = (h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/.]+$/, '').replace(/^www\./, '');
const both = (h) => [`https://${h}`, `https://www.${h}`];

export function siteVars(toml, site, old) {
  site = bare(site);
  if (!site) return toml;
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(site)) throw new Error(`SITE_DOMAIN: not a host name: ${site}`);
  const olds = [...new Set(String(old || '').split(',').map(bare).filter((h) => h && h !== site))];
  const line = (k) => { const m = toml.match(new RegExp(`^${k} = "([^"]*)"`, 'm')); return m ? m[1] : null; };
  const had = (line('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const previews = had.filter((o) => /^https:\/\/[a-z0-9-]+\.pages\.dev$/.test(o));
  const allowed = [...new Set([...both(site), ...olds.flatMap(both), ...previews])];
  const set = (t, k, v) => (line(k) === null ? t.replace(/^\[vars\]\n/m, `[vars]\n${k} = "${v}"\n`) : t.replace(new RegExp(`^${k} = .*$`, 'm'), `${k} = "${v}"`));
  let out = set(toml, 'ALLOWED_ORIGINS', allowed.join(','));
  out = set(out, 'SITE', `https://${site}`);
  if (olds.length || line('OLD_SITES') !== null) out = set(out, 'OLD_SITES', olds.flatMap(both).join(','));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = process.argv[2] || 'wrangler.toml';
  const out = siteVars(readFileSync(f, 'utf8'), process.env.SITE_DOMAIN, process.env.OLD_DOMAIN);
  writeFileSync(f, out);
  for (const k of ['ALLOWED_ORIGINS', 'SITE', 'OLD_SITES']) console.log((out.match(new RegExp(`^${k} = .*$`, 'm')) || [`${k}: (unset)`])[0]);
}
