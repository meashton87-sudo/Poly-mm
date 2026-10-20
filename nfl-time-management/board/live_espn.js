// The live feed for Live Drills (board/live.js): ESPN's public scoreboard and game summary (site.api.espn.com), and the
// one module that knows their shape. Unofficial and undocumented, so everything read here is checked and anything not
// as expected is rejected, with its reason, never guessed at: live.js counts and logs each rejection (a change of
// schema shows up in the worker's logs and in GET /live/admin, not as drills that quietly stop opening) and opens no
// drill on a game it could not read. To change the source (a licensed feed, say), write another module with the same
// three exports and the same plain output, and import it in live.js in place of this one: live.js never reads a
// feed's own fields.
//   BOARD                -> the address of the week's games (one request a minute while any game is on: live.js)
//   gameUrl(id)          -> the address of one game's plays (one request a minute for each game in a two-minute spot)
//   board(doc)           -> { games: [Game], bad: [reason] }       the scoreboard's games
//   game(doc, g)         -> { plays: [Play], bad: [{ why, period }] }   one game's plays, in order (g: its Game; a bad
//                           play's period, when it has one: live.js fails closed only on the half being played)
// A Game: { id, state: 'pre'|'in'|'post', at (kickoff, ms), home, away (team codes, nflverse's: LA, WAS), season, week,
//   type ('REG', 'WC', 'DIV', 'CON', 'SB'), indoor, spread (points the home team is favored by, as nflverse's
//   spread_line), period, clock (seconds left in it), score: [away, home], to: [away, home] timeouts left (or null),
//   sit: { pos, down, ytg, yl } the next snap (or null), ids: { feed team id: code } }
// A Play: { id, seq, kind, text, period, clock, score: [away, home] after it, team (the offense, a code), down, ytg,
//   yl (yards to the goal, before the snap), next: { team, down, ytg, yl } (after it) or null, yards, td, turnover,
//   nullified (a foul wiped it out), ob, incomplete, pass: { deep, side } or null, run: { gap, side } or null, by (the
//   passer or ball carrier, as the feed names him: 'J.Flacco'), toBy (a timeout's team), wall (when it happened, ms) }
// kind: pass, run, sack, kneel, spike, fg, punt (a snap); penalty (a foul before any play), timeout, warning (the
// two-minute warning), end (of a quarter, half or game), kickoff, pat, other.

export const BOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const gameUrl = (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(id)}`;

// the feed's team abbreviations that are not nflverse's
const CODE_FIX = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX' };
export const CODES = new Set(['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LV', 'LAC', 'LA',
  'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS']);
const codeOf = (abbr) => { const a = String(abbr || '').toUpperCase(); const c = CODE_FIX[a] || a; return CODES.has(c) ? c : null; };
const PLAYOFF = { 1: 'WC', 2: 'DIV', 3: 'CON', 4: 'SB', 5: 'SB' };       // postseason week -> round (the Pro Bowl's week is not a game here)
const int = (x, lo, hi) => { const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x; return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
// "1:47", ":53", "0:53" -> seconds; anything else null
function secs(v) {
  if (typeof v === 'number') return v >= 0 && v <= 900 ? v : null;
  const m = /^(\d{1,2})?:(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const s = Number(m[1] || 0) * 60 + Number(m[2]);
  return s <= 900 ? s : null;
}
// "1st & 10 at PIT 35" (or "PIT 35", "50"): yards to the goal for the team with the ball, else null
function ydsToGoal(text, pos) {
  const t = String(text || '');
  if (/\bat\s+50\b|^50$/.test(t.trim())) return 50;
  const m = /([A-Z]{2,3})\s+(\d{1,2})\s*$/.exec(t.trim());
  const side = m && codeOf(m[1]), n = m && Number(m[2]);
  if (!side || !(n >= 1 && n <= 50)) return null;
  return side === pos ? 100 - n : n;
}

// the scoreboard: every game of the week (a game with anything unexpected is left out, with its reason)
export function board(doc) {
  const games = [], bad = [];
  const evs = doc && Array.isArray(doc.events) ? doc.events : null;
  if (!evs) return { games, bad: ['scoreboard: no events list'] };
  for (const ev of evs) {
    const why = (w) => bad.push(`scoreboard ${ev && ev.id}: ${w}`);
    const c = ev && Array.isArray(ev.competitions) && ev.competitions[0];
    if (!c || !/^\d{4,14}$/.test(String(ev.id || ''))) { why('no competition or id'); continue; }
    const st = (c.status || ev.status || {}), state = st.type && st.type.state;
    if (!['pre', 'in', 'post'].includes(state)) { why(`state ${state}`); continue; }
    const teams = Array.isArray(c.competitors) ? c.competitors : [];
    const h = teams.find((x) => x && x.homeAway === 'home'), a = teams.find((x) => x && x.homeAway === 'away');
    const home = h && h.team && codeOf(h.team.abbreviation), away = a && a.team && codeOf(a.team.abbreviation);
    if (!home || !away || home === away) { why('teams'); continue; }
    const at = Date.parse(ev.date || c.date || '');
    const ids = { [String(h.team.id)]: home, [String(a.team.id)]: away };
    const g = { id: String(ev.id), state, at: Number.isFinite(at) ? at : null, home, away, ids, season: int(ev.season && ev.season.year, 2000, 2100),
      week: int(ev.week && ev.week.number, 0, 30), indoor: !!(c.venue && c.venue.indoor), spread: 0, period: null, clock: null, score: null, to: null, sit: null };
    const stype = int(ev.season && ev.season.type, 1, 4);
    g.type = stype === 3 ? PLAYOFF[g.week] || 'WC' : 'REG';
    // the line: "CIN -5.5" (the favorite and by how much) -> points the home team is favored by
    const det = String((Array.isArray(c.odds) && c.odds[0] && c.odds[0].details) || '');
    const om = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d)?)$/.exec(det.trim());
    if (om && codeOf(om[1])) g.spread = (codeOf(om[1]) === home ? 1 : -1) * Math.abs(Number(om[2]));
    if (state !== 'pre') {
      const sh = int(h.score, 0, 200), sa = int(a.score, 0, 200), period = int(st.period, 1, 9), clock = secs(st.clock ?? st.displayClock);
      if (sh === null || sa === null || period === null || clock === null) { why('score, period or clock'); continue; }
      Object.assign(g, { period, clock: st.displayClock != null ? secs(st.displayClock) ?? clock : clock, score: [sa, sh] });
      const s = c.situation;
      if (s && state === 'in') {
        const ta = int(s.awayTimeouts, 0, 3), th = int(s.homeTimeouts, 0, 3);
        if (ta !== null && th !== null) g.to = [ta, th];
        const pos = ids[String(s.possession)] || null, down = int(s.down, 1, 4), ytg = int(s.distance, 1, 99);
        const yl = pos ? ydsToGoal(s.downDistanceText || s.possessionText, pos) : null;
        if (pos && down && ytg && yl) g.sit = { pos, down, ytg: Math.min(ytg, yl), yl };
      }
    }
    games.push(g);
  }
  return { games, bad };
}

// what a play is, from the feed's type and its text (the league's own play description, the same words nflverse has)
function kindOf(type, x) {
  const T = String(type || '').toLowerCase(), t = x.toLowerCase();
  const play = /\bpass\b|\b(left|right) (end|tackle|guard)\b|\bup the middle\b|\bscrambles\b|\bkneels\b|\bspiked?\b|\bsacked\b/.test(t);
  if (/timeout/.test(T) || /^\s*(\(\d*:\d+\)\s*)?timeout\b/.test(t)) return 'timeout';
  if (/two.minute warning/.test(T) || /two.minute warning/.test(t)) return 'warning';
  if (/^end (of )?(period|quarter|half|game|regulation)|^end period/.test(T) || /^\s*end (of )?(game|quarter|half|regulation)\b/.test(t)) return 'end';
  if (/two.point|extra point|^pat\b/.test(T) || /two-point conversion|extra point is/.test(t)) return 'pat';
  if (/kickoff/.test(T) || /\bkicks \d+ yards from\b|\bkicks onside\b/.test(t)) return 'kickoff';
  if (/field goal/.test(T) || /\bfield goal is\b|\bfield goal attempt\b/.test(t)) return 'fg';
  if (/punt/.test(T) || /\bpunts\b/.test(t)) return 'punt';
  if (/\bkneels\b/.test(t)) return 'kneel';
  if (/\bspiked?\b/.test(t)) return 'spike';
  if (/sack/.test(T) || /\bsacked\b/.test(t)) return 'sack';
  if (/penalty/.test(T) && !play) return 'penalty';
  if (/\bpass\b/.test(t) || /pass|interception|reception|incompletion/.test(T)) return 'pass';
  if (/rush/.test(T) || play) return 'run';
  return /penalty/.test(t) ? 'penalty' : 'other';
}
const SNAPS = new Set(['pass', 'run', 'sack', 'kneel', 'spike', 'fg', 'punt']);
export const isSnap = (k) => SNAPS.has(k);

// one game's plays (a game whose plays are not all as expected comes back with bad set: live.js then keeps what it had)
export function game(doc, g) {
  const bad = [], plays = [];
  if (!doc || typeof doc !== 'object') return { plays, bad: [{ why: 'summary: not an object', period: null }] };
  let raw = [];
  if (doc.drives && (Array.isArray(doc.drives.previous) || doc.drives.current)) {
    for (const d of [...(doc.drives.previous || []), doc.drives.current].filter(Boolean)) raw.push(...(Array.isArray(d.plays) ? d.plays : []));
  } else if (Array.isArray(doc.plays)) raw = doc.plays;
  else return { plays, bad: [{ why: 'summary: no drives or plays', period: null }] };
  const seen = new Set();
  raw.forEach((p, i) => {
    const why = (w) => bad.push({ why: `play ${p && p.id}: ${w}`, period: int(p && p.period && p.period.number, 1, 9) });
    if (!p || typeof p !== 'object' || !/^\d{1,24}$/.test(String(p.id || ''))) { why('no id'); return; }
    if (seen.has(String(p.id))) return;
    seen.add(String(p.id));
    const text = String(p.text || '').replace(/\s+/g, ' ').trim();
    const kind = kindOf(p.type && p.type.text, text);
    const period = int(p.period && p.period.number, 1, 9), clock = secs(p.clock && (p.clock.displayValue ?? p.clock.value));
    const sa = int(p.awayScore, 0, 200), sh = int(p.homeScore, 0, 200);
    if (period === null || clock === null || sa === null || sh === null) { why('period, clock or score'); return; }
    const seq = Number(p.sequenceNumber);
    const out = { id: String(p.id), seq: Number.isFinite(seq) ? seq : i, kind, text: text.slice(0, 300), period, clock, score: [sa, sh],
      team: null, down: null, ytg: null, yl: null, next: null, yards: 0, td: false, turnover: false, nullified: false, ob: false, incomplete: false,
      pass: null, run: null, by: null, toBy: null, wall: Number.isFinite(Date.parse(p.wallclock || '')) ? Date.parse(p.wallclock) : null };
    const t = text.toLowerCase();
    const at = (s, team) => {
      if (!s || typeof s !== 'object') return null;
      const down = int(s.down, 1, 4), ytg = int(s.distance, 0, 99);
      let yl = int(s.yardsToEndzone, 1, 99);
      const byText = team ? ydsToGoal(s.downDistanceText || s.possessionText, team) : null;
      if (yl === null) yl = byText;
      if (yl === null || down === null || ytg === null) return null;
      return { team, down, ytg: Math.max(1, Math.min(ytg, yl)), yl };
    };
    const team = p.start && p.start.team ? g.ids[String(p.start.team.id)] || null : null;
    if (kind === 'timeout') {
      const m = /timeout\s*#?\s*\d*\s*by\s+([A-Z]{2,4})\b/i.exec(text);
      out.toBy = m ? codeOf(m[1]) : null;
    } else if (kind === 'kickoff') {
      // the kicking team (the game's first says who gets the ball after halftime): "kicks 65 yards from CIN 35"
      const km = /\bkicks\b.*?\bfrom ([A-Z]{2,4}) \d{1,2}\b/.exec(text);
      out.team = (km && codeOf(km[1])) || team;
    }
    else if (isSnap(kind) || kind === 'penalty') {
      const s = at(p.start, team);
      if (!team && kind !== 'penalty') { why(`${kind}: no offense`); return; }
      if (!s && kind !== 'penalty') { why(`${kind}: no down, distance or spot`); return; }
      out.team = team;
      if (s) Object.assign(out, { down: s.down, ytg: s.ytg, yl: s.yl });
      const nt = p.end && p.end.team ? g.ids[String(p.end.team.id)] || null : null;
      out.next = at(p.end, nt);
      const y = Number(p.statYardage);
      const ym = /for (-?\d+) yards?/i.exec(text);
      out.yards = Number.isFinite(y) && Math.abs(y) <= 110 ? y : ym ? Number(ym[1]) : /no gain/i.test(text) ? 0 : 0;
      out.nullified = /no play\b/i.test(t) && !/penalty.*declined/i.test(t);
      out.td = /touchdown/.test(t) && !/touchdown nullified|nullified/.test(t) && !out.nullified;
      const rec = /recovered by ([A-Z]{2,4})-/i.exec(text), recBy = rec ? codeOf(rec[1]) : null;
      out.turnover = !out.nullified && (/\bintercepted\b/.test(t) || (/fumbles?/.test(t) && !!recBy && recBy !== team) || /recovery \(opponent\)/i.test(String(p.type && p.type.text)));
      out.ob = /\bob\b|out of bounds/.test(t);
      out.incomplete = /\bincomplete\b/.test(t);
      const pm = /\bpass(?:\s+incomplete)?\s+(short|deep)\s+(left|middle|right)\b/.exec(t);
      if (pm) out.pass = { deep: pm[1] === 'deep', side: pm[2] };
      const rm = /\b(left|right)\s+(end|tackle|guard)\b/.exec(t);
      if (kind === 'run' && rm) out.run = { gap: rm[2], side: rm[1] };
      else if (kind === 'run' && /\bup the middle\b/.test(t)) out.run = { gap: 'middle', side: null };
      if (kind === 'run' && /\bscrambles\b/.test(t)) out.run = null;          // (a pass play the quarterback ran out of: its call is not known)
      const bm = /(?:^|[\s)])(?:\d{1,2}-)?([A-Z][A-Za-z'-]*\.\s?[A-Z][A-Za-z'.-]+)\s+(?:pass|left|right|up|scrambles|kneels|spiked|sacked|to\b)/.exec(text);
      out.by = bm ? bm[1].replace(/\s/g, '') : null;
    }
    plays.push(out);
  });
  plays.sort((a, b) => a.seq - b.seq);
  return { plays, bad };
}
