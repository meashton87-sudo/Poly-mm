/* Web Worker hosting the nflclock engine so the page stays responsive while it simulates. */
importScripts('engine.js');

let eng = null;
let game = null;
let simCache = { key: null, sim: null, ctx: null };

const PHASE = { snap: 0, pat: 1, kickoff: 2 };

function getSim(settings) {
  const key = JSON.stringify([settings.receive2h, settings.manual || {}, settings.coachMode || {}]);
  if (simCache.key !== key) {
    const ctx = eng.makeContext(game, { receive2h: settings.receive2h, manual: settings.manual, coachMode: settings.coachMode });
    simCache = { key, sim: eng.simulator(ctx), ctx };
  }
  return simCache;
}

// Options per deciding team, mirroring src/nflclock/console.py
function optionsFor(st, root, sim) {
  const o = root.pos, d = 1 - o, out = [];
  if (st.phase === 'pat') return [{ team: o, side: 'offense', family: 'pat', opts: { xp: { pat: 'xp' }, two: { pat: 'two' } } }];
  if (st.phase === 'kickoff') return [{ team: o, side: 'kicking', family: 'onside', opts: { deep: { kick: 'deep' }, onside: { kick: 'onside' } } }];
  const firstHalf = st.qtr <= 2;
  const lead = root.score[o] - root.score[d];
  const off = {};
  if (st.running) {
    if (root.to[o] > 0) off.timeout = { to_off: true };
    off.hurry = { to_off: false, tempo: 'urgent' };
    off.normal = { to_off: false, tempo: 'normal' };
    off.milk = { to_off: false, tempo: 'milk' };
    if (st.down <= 3) off.spike = { to_off: false, play: 'spike' };
  }
  if (st.down === 4) {
    off.go = { play: 'go', to_off: false };
    if (sim.fgProb(root.yl + 17, o) >= 0.02) off.fg = { play: 'fg', to_off: false };
    if (root.yl >= 30) off.punt = { play: 'punt', to_off: false };
  } else if (!st.running) {
    off.run = { play: 'run' };
    off.pass = { play: 'pass' };
  }
  if (st.down < 4 && (lead > 0 || (firstHalf && root.yl >= 50))) off.kneel = { play: 'kneel', to_off: false };
  if (firstHalf && root.t - 1800 <= 150) { off.attack = { h1: 'attack' }; off.runout = { h1: 'runout' }; }
  if (Object.keys(off).length >= 2) out.push({ team: o, side: 'offense', family: null, opts: off });
  if (st.running && root.to[d] > 0) {
    out.push({ team: d, side: 'defense', family: 'def_timeout', opts: { timeout: { to_def: true }, no_timeout: { to_def: false } } });
  }
  return out;
}

function familyOf(option, group) {
  if (group.family) return group.family;
  if (['timeout', 'hurry', 'spike', 'normal', 'milk'].includes(option)) return 'off_clock_stop';
  if (['go', 'fg', 'punt'].includes(option)) return 'fourth_down';
  if (['attack', 'runout'].includes(option)) return 'h1_end';
  if (option === 'kneel') return 'kneel';
  return 'play_select';
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const [data, g] = await Promise.all([
        fetch(msg.engineUrl).then((r) => { if (!r.ok) throw new Error('engine data ' + r.status); return r.json(); }),
        fetch(msg.gameUrl).then((r) => { if (!r.ok) throw new Error('game file ' + r.status); return r.json(); }),
      ]);
      eng = new NFLClockEngine(data);
      game = g;
      self.postMessage({ type: 'ready', game });
      return;
    }
    if (msg.type === 'simulate') {
      const { st, settings, id } = msg;
      const t0 = Date.now();
      const { sim, ctx } = getSim(settings);
      const homeTeam = game.home.team;
      const pos = st.pos === homeTeam ? 0 : 1;
      const qsec = st.qtr <= 4 ? Math.max(0, 4 - st.qtr) * 900 + st.clock : st.clock;
      const root = {
        t: qsec, pos, score: [st.score[1], st.score[0]], down: st.down, ytg: st.ytg, yl: st.yl,
        to: [st.to[1], st.to[0]], clock_running: st.running, phase: PHASE[st.phase],
      };
      const groups = optionsFor(st, root, sim);
      const n = settings.sims;
      const seed = (Date.now() % 1000003) >>> 0;
      const total = groups.reduce((a, g) => a + Object.keys(g.opts).length, 0) + 1;
      let done = 0;
      const base = sim.run(root, { n: Math.max(2000, Math.round(n / 2)), perspective: 0, seed });
      done++;
      self.postMessage({ type: 'progress', id, done, total });
      const results = [];
      for (const g of groups) {
        const vals = {};
        for (const [name, act] of Object.entries(g.opts)) {
          vals[name] = sim.run(root, { n, action: act, perspective: g.team, seed });
          done++;
          self.postMessage({ type: 'progress', id, done, total });
        }
        const best = Object.keys(vals).reduce((a, b) => (vals[a].mean >= vals[b].mean ? a : b));
        const rows = Object.keys(vals).map((k) => {
          const a = vals[k].values, b = vals[best].values;
          let m = 0;
          for (let i = 0; i < a.length; i++) m += a[i] - b[i];
          m /= a.length;
          let ss = 0;
          for (let i = 0; i < a.length; i++) { const x = a[i] - b[i] - m; ss += x * x; }
          const se = k === best ? 0 : Math.sqrt(ss / (a.length - 1) / a.length);
          return { option: k, family: familyOf(k, g), wp: vals[k].mean, edge: m, se };
        }).sort((x, y) => y.wp - x.wp);
        results.push({ team: g.team === 0 ? game.home.team : game.away.team, side: g.side, rows });
      }
      self.postMessage({
        type: 'result', id, results, baseHomeWp: base.mean, ms: Date.now() - t0,
        pFg: sim.fgProb(root.yl + 17, pos), ctxTeams: ctx.teams,
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
