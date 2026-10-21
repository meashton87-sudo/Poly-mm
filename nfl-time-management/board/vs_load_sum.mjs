// The Versus load test's runners added up (vs_load.yml: each runner's vs_load.mjs --json): p50/p95/p99 of the time to
// pair, the call round trip and the two phones' skew over every runner's samples, the errors, and the bars for the
// 10,000-player day: pair p95 < 15 s, snap round trip p95 < 1.5 s, errors < 0.5%.
//   node board/vs_load_sum.mjs load-1.json load-2.json ...
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.error('no runner files'); process.exit(2); }
const all = { players: 0, paired: 0, matches: 0, finished: 0, snaps: 0, errors: 0, reconnects: 0, pair: [], rtt: [], skew: [], ladder: [], me: [], queueMax: 0, by: {}, firstErrors: [], cf: {} };
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`${f}: unreadable (${e.message})`); continue; }
  const r = j.raw || {};
  all.players += r.players || 0; all.paired += (r.pair || []).length; all.matches += r.matches || 0; all.finished += r.finished || 0; all.snaps += r.snaps || 0;
  all.errors += r.errorPlayers || 0; all.reconnects += r.reconnects || 0; all.queueMax = Math.max(all.queueMax, r.queueMax || 0);
  for (const k of ['pair', 'rtt', 'skew', 'ladder', 'me']) all[k].push(...(r[k] || []));
  for (const [k, v] of Object.entries(r.by || {})) all.by[k] = (all.by[k] || 0) + v;
  for (const [k, v] of Object.entries(r.cf || {})) all.cf[k] = (all.cf[k] || 0) + v;
  all.firstErrors.push(...(j.errors || []).slice(0, 5));
}
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = (v) => (v == null ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const tri = (a) => `${ms(q(a, 0.5))} / ${ms(q(a, 0.95))} / ${ms(q(a, 0.99))}`;
const errRate = all.players ? all.errors / all.players : 1;
const rows = [
  ['runners', files.length], ['players', all.players], ['paired', `${all.paired} (${all.players ? (100 * all.paired / all.players).toFixed(1) : 0}%)`],
  ['time to pair p50 / p95 / p99', tri(all.pair)], ['the most waiting in one lobby', all.queueMax],
  ['matches started / over', `${all.matches} / ${all.finished}`], ['how they ended', JSON.stringify(all.by)], ['snaps', all.snaps],
  ['call round trip p50 / p95 / p99', tri(all.rtt)], ['the two phones apart each snap p50 / p95 / p99', tri(all.skew)],
  ['/vs/ladder p50 / p95 / p99', tri(all.ladder)], ['/vs/me p50 / p95 / p99', tri(all.me)],
  ['dropped connections (back in)', all.reconnects], ['Cloudflare errors (close codes 1006/1011/1012/1013, HTTP 5xx)', JSON.stringify(all.cf)],
  ['players with an error', `${all.errors} (${(100 * errRate).toFixed(2)}%)`],
];
const w0 = Math.max(...rows.map((r) => r[0].length));
console.log(rows.map(([k, v]) => `${k.padEnd(w0)}  ${v}`).join('\n'));
const verdict = [];
const p95 = q(all.pair, 0.95), r95 = q(all.rtt, 0.95);
if (!all.players) verdict.push('no runner reported');
if (p95 == null || p95 > 15_000) verdict.push(`pair p95 ${ms(p95)} (bar: 15 s)`);
if (r95 == null || r95 > 1500) verdict.push(`snap round trip p95 ${ms(r95)} (bar: 1.5 s)`);
if (errRate > 0.005) verdict.push(`${(100 * errRate).toFixed(2)}% of players hit an error (bar: 0.5%)`);
if (all.firstErrors.length) console.log('\nfirst errors:\n  ' + all.firstErrors.slice(0, 20).join('\n  '));
console.log(verdict.length ? `\nFAIL: ${verdict.join('; ')}` : '\nversus load ok');
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Versus load: ${all.players} players on ${files.length} runners\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '/')} |`).join('\n')}\n\n${verdict.length ? `**FAIL**: ${verdict.join('; ')}` : '**ok**: every bar met'}\n${all.firstErrors.length ? `\n<details><summary>first errors</summary>\n\n${all.firstErrors.slice(0, 40).map((e) => `- ${e}`).join('\n')}\n</details>\n` : ''}`);
}
process.exit(verdict.length ? 1 : 0);
