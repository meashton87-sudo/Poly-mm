// Versus load test against a real worker: N fake players join the matchmaking queue over a minute (the real
// WebSocket endpoints, /vs/queue then /vs/ws), play every match out with random legal calls at a human pace, and
// measure what players would feel: the time to be paired, each call's round trip (sent -> the room's lock or the
// snap), how far apart the two phones get each snap, errors and dropped connections, and the lobby and ladder
// under the rush. Prints a table (and the GitHub step summary when there is one); exits 1 on more than 1% of
// players hitting an error, or a median time to pair over 10 seconds.
//
//   node board/vs_load.mjs --url https://<worker> [--players 300] [--ramp 60] [--mode casual|ranked|mix] [--game five|ot|mix]
//                          [--origin https://<an allowed site origin>] [--fast] [--minutes 25] [--json out.json] [--bars none]
// (--json keeps every sample too, for vs_load_sum.mjs to add runners up; --bars none: no verdict of its own)
//
// The calls are the room's own rules (web/vs_core.js: whose decision it is, the defense's parts, the toss); the
// players' device keys start loadtest- and their names zz-loadtest-N, so they are obvious anywhere they show up.
// It never names a board itself: --url is required (.github/workflows/vs_load.yml deploys a throwaway worker for it).
import VSCore from '../web/vs_core.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const URL0 = String(arg('url', '') || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(URL0)) { console.error('--url https://<the worker> is required'); process.exit(2); }
const N = Math.min(1000, Math.max(2, +arg('players', 300) || 300));
const RAMP = Math.max(1, +arg('ramp', 60) || 60) * 1000;
const MODE = String(arg('mode', 'casual'));
const ORIGIN = String(arg('origin', '') || '');
const FAST = !!arg('fast', false);
const LIMIT = Math.max(1, +arg('minutes', 25) || 25) * 60_000;
const JSON_OUT = arg('json', '');
const GAME = String(arg('game', 'five')), BARS = String(arg('bars', 'solo'));
const RUN = String(Date.now().toString(36));
const WS0 = URL0.replace(/^http/, 'ws');
const HDR = ORIGIN ? { headers: { Origin: ORIGIN } } : undefined;

// the 32 teams and the calls a phone offers in overtime (no Hail Mary; a sneak only short: vs_core.js cleanHalf)
const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LV', 'LAC', 'LA', 'MIA',
  'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS'];
const CALLS = ['rb_out_strong', 'rb_out_weak', 'rb_tackle_strong', 'rb_tackle_weak', 'rb_inside_strong', 'rb_inside_weak', 'rb_middle', 'qb_run',
  'rpo_strong', 'rpo_weak', 'quick_strong', 'quick_weak', 'quick_middle', 'screen', 'deep_strong', 'deep_weak', 'deep_middle', 'pa_short', 'pa_deep',
  'roll_strong', 'roll_weak', 'trick_flea', 'trick_reverse', 'trick_pass', 'trick_direct'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const t = () => ((Date.now() - T0) / 1000).toFixed(1);

const M = { pair: [], firstAck: [], rtt: [], skew: [], ladder: [], me: [], queueMax: 0, errors: [], reconnects: 0, by: {}, rounds: {}, snaps: 0, matches: new Set(), finished: new Set(), cf: {} };
const cfNote = (k) => { M.cf[k] = (M.cf[k] || 0) + 1; };
const stepAt = new Map();           // room:n -> [seat0 time, seat1 time]
const fail = (bot, what) => { if (!bot.err) { bot.err = what; M.errors.push(`${bot.name}: ${what}`); } };

class Bot {
  constructor(i) {
    this.i = i; this.key = `loadtest-${RUN}-${String(i).padStart(5, '0')}`; this.name = `zz-loadtest-${i}`;
    this.team = pick(TEAMS); this.mode = MODE === 'mix' ? (i % 2 ? 'ranked' : 'casual') : MODE;
    this.game = GAME === 'mix' ? (i % 3 ? 'five' : 'ot') : GAME;
    this.ms = null; this.n = 0; this.seat = -1; this.done = false; this.err = null; this.sent = new Map(); this.answered = -1;
  }
  queue() {
    return new Promise((resolve) => {
      const q = new URLSearchParams({ key: this.key, mode: this.mode, game: this.game, team: this.team, name: this.name });
      const t0 = Date.now();
      let ws, acked = false;
      try { ws = new WebSocket(`${WS0}/vs/queue?${q}`, HDR); } catch (e) { fail(this, `queue: ${e.message}`); return resolve(null); }
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'queued') { if (!acked) { acked = true; M.firstAck.push(Date.now() - t0); } M.queueMax = Math.max(M.queueMax, m.size || 0); }
        if (m.t === 'busy') { fail(this, 'the lobby said busy'); try { ws.close(); } catch (e) { /* gone */ } resolve(null); }
        if (m.t === 'match') { M.pair.push(Date.now() - t0); this.matched = true; resolve(m); }
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => { if ([1006, 1011, 1012, 1013].includes(ev.code)) cfNote(`queue ${ev.code}`); if (!this.matched && !this.err) { fail(this, `queue closed ${ev.code} before a match`); resolve(null); } };
      setTimeout(() => { if (!this.matched) { fail(this, 'no match in 5 minutes'); try { ws.close(); } catch (e) { /* gone */ } resolve(null); } }, 300_000);
    });
  }
  open(room, mode, since = 0) {
    return new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(`${WS0}/vs/ws?room=${room}&key=${this.key}&mode=${mode}&game=${this.game}&since=${since}`, HDR); } catch (e) { fail(this, `room: ${e.message}`); return resolve(false); }
      this.ws = ws; this.room = room; this.roomMode = mode;
      let opened = false;
      ws.onopen = () => { opened = true; resolve(true); };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.on(m); };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        if ([1006, 1011, 1012, 1013].includes(ev.code)) cfNote(`room ${ev.code}`);
        if (!opened) { resolve(false); return; }
        if (this.done || this.ws !== ws) return;
        // a dropped line: back in, as a phone does (counted; an error only if that fails too)
        M.reconnects += 1;
        sleep(between(300, 2000)).then(async () => { if (!this.done && !(await this.open(room, mode, this.n))) fail(this, `room closed ${ev.code}, no way back in`); });
      };
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch (e) { /* reconnects */ } }
  on(m) {
    if (JSON.stringify(m).includes('"seed"')) fail(this, `a seed reached a phone (${m.t})`);
    if (m.t === 'busy') { fail(this, 'the room said busy'); return; }
    if (m.t === 'hello') {
      this.seat = m.seat;
      if (m.phase === 'over') return this.finish(m.result);
      if (m.decisions && m.decisions.length) this.ms = m.decisions[m.decisions.length - 1].ms; else if (m.ms) this.ms = m.ms;
      this.n = m.n;
      if (m.phase === 'wait' && !m.teams[m.seat]) this.send({ t: 'team', team: pick(TEAMS.filter((x) => x !== m.teams[1 - m.seat])), name: this.name });
      if (m.phase === 'live') this.think();
    } else if (m.t === 'taken') {
      this.send({ t: 'team', team: pick(TEAMS.filter((x) => x !== m.team)), name: this.name });
    } else if (m.t === 'start') {
      M.matches.add(this.room);
      this.ms = m.ms; this.n = 0; this.think();
    } else if (m.t === 'locked' && m.seat === this.seat) {
      this.ack(m.n);
    } else if (m.t === 'step') {
      this.ack(m.n);
      const k = `${this.room}:${m.n}`, at = stepAt.get(k) || [0, 0];
      at[this.seat] = Date.now();
      stepAt.set(k, at);
      if (at[0] && at[1]) { M.skew.push(Math.abs(at[0] - at[1])); stepAt.delete(k); }
      if (this.seat === 0) M.snaps += 1;
      this.ms = m.ms; this.n = m.n + 1;
      if (m.result) return this.finish(m.result);
      this.think();
    } else if (m.t === 'over') {
      this.finish(m.result);
    }
  }
  ack(n) { const s = this.sent.get(n); if (s) { M.rtt.push(Date.now() - s); this.sent.delete(n); } }
  // my decision: watch the play, the call comes up (ready), think, call
  async think() {
    if (!this.ms || this.ms.over || this.done) return;
    if (!VSCore.need(this.ms).includes(this.seat) || this.answered === this.n) return;
    const n = this.n;
    this.answered = n;
    await sleep(FAST ? between(200, 800) : between(2500, 7000));
    if (this.done || this.n !== n) return;
    this.send({ t: 'ready', n });
    await sleep(FAST ? between(200, 1500) : between(1500, 9000));
    if (this.done || this.n !== n || !this.ms) return;
    const ms = this.ms, role = VSCore.role(ms, this.seat);
    let half;
    if (role === 'toss') half = { call: pick(VSCore.COIN) };
    else if (role === 'pick' && !ms.cot) half = { pick: pick(ms.reg.pick.end ? ['receive', 'kick'] : VSCore.REG_PICKS) };
    else if (role === 'pick') half = { pick: pick(ms.cot.pick.end ? ['offense', 'defense'] : VSCore.PICKS) };
    else if (role === 'kick') half = { action: { kick: pick(['deep', 'return', 'touchback']) } };
    else if (role === 'defense') half = { dc: { pers: pick(VSCore.DC.pers), front: pick(VSCore.DC.front), cover: pick(VSCore.DC.cover), rush: pick(VSCore.DC.rush) } };
    else if (role === 'pat') half = Math.random() < 0.4 ? { two: true } : { action: { pat: 'xp' } };
    else if (role === 'offense') {
      const c = pick(CALLS), r = ms.root;
      if (!ms.cot && r.clock_running && r.to[this.seat] > 0 && Math.random() < 0.05) half = { timeout: true };
      else if (r.down === 4 && Math.random() < 0.4) half = { action: { play: r.yl <= 40 ? 'fg' : 'punt' } };
      else half = { action: { call: c, ...(ms.cot ? {} : { tempo: pick(['hurry', 'normal', 'milk']) }), ...(ms.root.try2 ? { pat: 'two' } : {}) } };
    } else return;
    this.sent.set(n, Date.now());
    this.send({ t: 'half', n, half });
  }
  finish(result) {
    if (this.done) return;
    this.done = true;
    M.finished.add(this.room);
    if (this.seat === 0 || !M.by[`${this.room}`]) {
      M.by[this.room] = result ? result.by : 'none';
      if (result && result.round) M.rounds[this.room] = result.round;
    }
    if (!result || result.by === 'error') fail(this, `the match ended in an error (${this.room})`);
    else if (result.by === 'forfeit' && result.why === 'afk') fail(this, `a forfeit for calls left to the clock: the room's clock or the phone's line (${this.room})`);
    else if (result.by === 'forfeit' || result.by === 'noshow' || result.by === 'abandoned') fail(this, `the match ended ${result.by}${result.why ? ` (${result.why})` : ''} (${this.room})`);
    try { this.ws.close(1000); } catch (e) { /* gone */ }
    this.after();
  }
  // the ladder after a match, as the page reads it (the Versus screen)
  async after() {
    for (const [path, init, into] of [['/vs/ladder', undefined, M.ladder], ['/vs/me', { method: 'POST', body: JSON.stringify({ key: this.key }) }, M.me]]) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${URL0}${path}`, { ...(init || {}), headers: { 'Content-Type': 'application/json', ...(ORIGIN ? { Origin: ORIGIN } : {}) } });
        if (r.status >= 500) cfNote(`http ${r.status}`);
        if (!r.ok) throw new Error(`${r.status}`);
        await r.json();
        into.push(Date.now() - t0);
      } catch (e) { fail(this, `${path}: ${e.message}`); }
    }
  }
  async run() {
    const m = await this.queue();
    if (!m) return;
    if (!(await this.open(m.room, m.mode))) fail(this, `could not open room ${m.room}`);
  }
}

const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ms = (v) => (v == null ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

console.log(`versus load: ${N} players over ${RAMP / 1000} s against ${URL0} (${MODE}, ${GAME}${FAST ? ', fast' : ''})`);
const bots = Array.from({ length: N }, (_, i) => new Bot(i));
const runs = bots.map((b) => sleep(Math.random() * RAMP).then(() => b.run()));
const tick = setInterval(() => console.log(`… ${t()} s: ${M.pair.length} paired, ${M.matches.size} matches started, ${M.finished.size} over, ${M.snaps} snaps, ${M.errors.length} errors, ${M.reconnects} reconnects, the queue at most ${M.queueMax}`), 15_000);
await Promise.all(runs);
while (Date.now() - T0 < LIMIT && bots.some((b) => b.matched && !b.done && !b.err)) await sleep(1000);
for (const b of bots) if (b.matched && !b.done && !b.err) fail(b, `the match was still going after ${LIMIT / 60000} minutes`);
await sleep(3000);         // (the last ladder reads)
clearInterval(tick);
for (const b of bots) { try { b.ws && b.ws.close(1000); } catch (e) { /* gone */ } }

const byCount = {}; Object.values(M.by).forEach((k) => { byCount[k] = (byCount[k] || 0) + 1; });
const roundCount = {}; Object.values(M.rounds).forEach((k) => { roundCount[k] = (roundCount[k] || 0) + 1; });
const bad = bots.filter((b) => b.err).length, errRate = bad / N, medPair = q(M.pair, 0.5);
const rows = [
  ['players', N], ['paired', `${M.pair.length} (${(100 * M.pair.length / N).toFixed(1)}%)`],
  ['time to pair: median / p95 / max', `${ms(medPair)} / ${ms(q(M.pair, 0.95))} / ${ms(q(M.pair, 1))}`],
  ['lobby: first answer median / p95', `${ms(q(M.firstAck, 0.5))} / ${ms(q(M.firstAck, 0.95))}`],
  ['lobby: most waiting at once', M.queueMax],
  ['matches started / over', `${M.matches.size} / ${M.finished.size}`], ['how they ended', JSON.stringify(byCount)], ['overtimes', JSON.stringify(roundCount)],
  ['snaps', M.snaps], ['call round trip: median / p95 / max', `${ms(q(M.rtt, 0.5))} / ${ms(q(M.rtt, 0.95))} / ${ms(q(M.rtt, 1))}`],
  ['the two phones apart each snap: median / p95 / max', `${ms(q(M.skew, 0.5))} / ${ms(q(M.skew, 0.95))} / ${ms(q(M.skew, 1))}`],
  ['/vs/ladder: median / p95 (n)', `${ms(q(M.ladder, 0.5))} / ${ms(q(M.ladder, 0.95))} (${M.ladder.length})`],
  ['/vs/me: median / p95 (n)', `${ms(q(M.me, 0.5))} / ${ms(q(M.me, 0.95))} (${M.me.length})`],
  ['dropped connections (back in)', M.reconnects], ['Cloudflare errors (1006/1011/1012/1013, 5xx)', JSON.stringify(M.cf)], ['players with an error', `${bad} (${(100 * errRate).toFixed(2)}%)`], ['seconds', t()],
];
const w0 = Math.max(...rows.map((r) => r[0].length));
console.log('\n' + rows.map(([k, v]) => `${k.padEnd(w0)}  ${v}`).join('\n'));
if (M.errors.length) console.log('\nfirst errors:\n  ' + M.errors.slice(0, 15).join('\n  '));
const verdict = [];
if (BARS !== 'none') {
  if (errRate > 0.01) verdict.push(`${(100 * errRate).toFixed(2)}% of players hit an error (more than 1%)`);
  if (medPair == null || medPair > 10_000) verdict.push(`the median time to pair was ${ms(medPair)} (more than 10 s)`);
}
console.log(verdict.length ? `\nFAIL: ${verdict.join('; ')}` : '\nversus load ok');
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Versus load: ${N} players\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '/')} |`).join('\n')}\n\n${verdict.length ? `**FAIL**: ${verdict.join('; ')}` : '**ok**'}\n${M.errors.length ? `\n<details><summary>first errors</summary>\n\n${M.errors.slice(0, 30).map((e) => `- ${e}`).join('\n')}\n</details>\n` : ''}`);
}
if (JSON_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(JSON_OUT, JSON.stringify({ rows, errors: M.errors, verdict, raw: { players: N, errorPlayers: bad, pair: M.pair, rtt: M.rtt, skew: M.skew, ladder: M.ladder, me: M.me,
    matches: M.matches.size, finished: M.finished.size, snaps: M.snaps, reconnects: M.reconnects, queueMax: M.queueMax, by: byCount, cf: M.cf } }));
}
process.exit(verdict.length ? 1 : 0);
