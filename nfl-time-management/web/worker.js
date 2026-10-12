/* Web Worker hosting the nflclock engine. Several run in parallel: one plans the options for a
 * situation, then each option (and the baseline) is simulated as a separate job on whichever worker
 * is free. Every job uses the same seed, so options share common random numbers across workers. */
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

function rootFrom(st) {
  const pos = st.pos === game.home.team ? 0 : 1;
  const qsec = st.qtr <= 4 ? Math.max(0, 4 - st.qtr) * 900 + st.clock : st.clock;
  return {
    t: qsec, pos, score: [st.score[1], st.score[0]], down: st.down, ytg: st.ytg, yl: st.yl,
    to: [st.to[1], st.to[0]], clock_running: st.running, phase: PHASE[st.phase],
  };
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
      self.postMessage({ type: 'ready', game: msg.wantGame ? game : null });
      return;
    }
    if (msg.type === 'plan') {
      const { sim } = getSim(msg.settings);
      const root = rootFrom(msg.st);
      const groups = optionsFor(msg.st, root, sim).map((g) => ({
        team: g.team, teamCode: g.team === 0 ? game.home.team : game.away.team, side: g.side,
        options: Object.entries(g.opts).map(([name, action]) => ({ name, action, family: familyOf(name, g) })),
      }));
      const info = msg.st.phase === 'snap' && msg.st.down === 4 ? sim.fourthInfo(root) : null;
      self.postMessage({ type: 'plan', id: msg.id, groups, root, info });
      return;
    }
    if (msg.type === 'job') {
      const { sim } = getSim(msg.settings);
      const root = rootFrom(msg.st);
      const t0 = Date.now();
      const res = sim.run(root, { n: msg.n, action: msg.action || {}, perspective: msg.perspective, seed: msg.seed });
      const values = res.values;
      self.postMessage({ type: 'job', id: msg.id, jobId: msg.jobId, mean: res.mean, values, drive: res.drive,
        ms: Date.now() - t0 }, [values.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
