// The first call's facts of every spot (game_worker.js 'info' on the spot's opening snap: the call mix, the odds, the
// kick, the tempo, the defense's looks), worked out when the website is built (scripts/site.py): each spot's file
// carries them, so the first call shows as soon as the spot is in, not after the simulator's 3 MB of data.
// The site's own worker, scripts and packed data, run as a phone runs them; and as a check, every tenth spot again
// from the scripts as written on the JSON: the same facts, number for number, and unchanged through JSON.
//   node web/spot_info.js SITE_DIR > info.json      -> { "<spot index>": { key, info } }
// key: a fingerprint of the question (game.js infoKey, the same): the page uses the facts only for that very question.
// Each worker runs in a process of its own (a few at once), in its main context as in a browser (a vm context's
// global lookups make the engine twenty times slower).
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { fork } = require('child_process');

const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

// a child: one worker, as the browser runs it (importScripts from its folder), answering the parent's questions
function child(dir, packed) {
  const g = globalThis;
  g.self = g;
  g.location = { search: '' };
  g.importScripts = (u) => vm.runInThisContext(fs.readFileSync(path.join(dir, u.split('?')[0]), 'utf8'), { filename: u });
  let last = null;
  g.postMessage = (m) => { last = m; };
  g.importScripts('game_worker.js');
  const ask = async (m) => {
    await g.onmessage({ data: m });
    if (last && last.type === 'error') throw new Error(`worker: ${last.message}`);
    return last;
  };
  process.on('message', async (qs) => {
    try {
      if (packed) {
        const unz = (f) => buf(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))));
        await ask({ type: 'init', engine: unz('engine_data.pack'), playbook: unz('playbook.pack'), packed: true });
      } else {
        const raw = (f) => buf(fs.readFileSync(path.join(dir, f)));
        await ask({ type: 'init', engine: raw('engine_data.json'), playbook: raw('playbook.json'), packed: false });
      }
      if (!last || last.type !== 'ready') throw new Error('worker not ready');
      const out = [];
      for (const [i, q] of qs) out.push([i, (await ask({ type: 'info', id: i, ...q })).info]);
      process.send(out, () => process.exit(0));
    } catch (e) { console.error(String((e && e.stack) || e)); process.exit(1); }
  });
}

// game.js startRoot, buildScen and simScen: the spot's opening snap and its matchup, as the page builds them
function startRoot(sc) {
  const st = sc.start;
  return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sc.home ? 0 : 1,
    score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl,
    to: [st.to[1], st.to[0]], clock_running: !!st.running, phase: 0, credit: 0, free_kick: false, ...otOf(sc) };
}
// a spot in overtime (a historic drive: Super Bowl LVIII's, Fitzgerald's): the period it is in, playoff rules or not, and
// whether the other team has had the ball (behind, or past the period's first snap: they have), so the engine plays the
// overtime rules from it (each team a possession, then the next score wins; a historic drive's of its time, the
// spot's overtime: pro.py overtime_rules) and not a fourth quarter
function otOf(sc) {
  const st = sc.start;
  if (!(st.qtr > 4)) return {};
  const pos = st.pos === sc.home ? 0 : 1, po = ['WC', 'DIV', 'CON', 'SB'].includes((sc.real || {}).type);
  const rules = (sc.overtime || {}).rules, len = (sc.overtime || {}).len || (po ? 900 : 600);
  const fresh = st.qtr === 5 && st.score[0] === st.score[1] && st.clock >= len;
  const c = [0, 0];
  if (!fresh) c[1 - pos] = 1;
  return { ot: { c, po, n: st.qtr - 4, ...(rules === 'sd' || rules === 'msd' ? { r: rules } : {}) } };
}
function buildScen(idx, sp, T) {
  const H = T.home, A = T.away;
  const game = { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
    league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real ? sp.real.season : idx.asof.season };
  return { ...sp, game };
}
const simScen = (sc) => ({ id: sc.id, game: sc.game, start: { receive2h: sc.start.receive2h } });
// cyrb53: game.js infoKey, the same
function fingerprint(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// the same value, number for number (-0 and NaN too), arrays and typed arrays told apart
function same(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b) || ArrayBuffer.isView(a) !== ArrayBuffer.isView(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

// a share of the questions to a child of its own; its answers, by spot (the advanced serialization keeps -0 and typed arrays)
function answers(dir, packed, qs) {
  return new Promise((resolve, reject) => {
    const c = fork(__filename, ['--child', dir, packed ? 'packed' : 'json'], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let got = null;
    c.on('message', (m) => { got = m; });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 && got ? resolve(new Map(got)) : reject(new Error(`spot_info: a worker failed (${code})`))));
    c.send(qs);
  });
}

async function main(site) {
  const idx = JSON.parse(fs.readFileSync(path.join(site, 'game.json'), 'utf8'));
  const teams = {};
  for (const f of fs.readdirSync(path.join(site, 'spots'))) if (/^s\d+\.json$/.test(f)) Object.assign(teams, JSON.parse(fs.readFileSync(path.join(site, 'spots', f), 'utf8')));
  const qs = idx.spots.map((sp, i) => {
    if (!teams[i]) throw new Error(`spot ${i}: no teams`);
    const sc = buildScen(idx, sp, teams[i]);
    return [i, { scen: simScen(sc), root: startRoot(sc) }];
  });
  const n = Math.max(1, Math.min(4, os.cpus().length));
  const parts = Array.from({ length: n }, (_, k) => qs.filter(([i]) => i % n === k));
  const [check, ...got] = await Promise.all([answers(__dirname, false, qs.filter(([i]) => i % 10 === 0)), ...parts.map((p) => answers(site, true, p))]);
  const all = new Map(got.flatMap((m) => [...m]));
  const out = {};
  for (const [i, q] of qs) {
    const a = all.get(i), id = q.scen.id;
    if (!a) throw new Error(`spot ${i} (${id}): no answer`);
    const back = JSON.parse(JSON.stringify(a));
    if (check.has(i) && !same(a, check.get(i))) throw new Error(`spot ${i} (${id}): the site's worker and the scripts as written disagree`);
    if (!same(a, back)) throw new Error(`spot ${i} (${id}): its facts change through JSON`);
    out[i] = { key: fingerprint(JSON.stringify(q)), info: back };
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[2] === '--child') child(process.argv[3], process.argv[4] === 'packed');
else main(process.argv[2]).catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
