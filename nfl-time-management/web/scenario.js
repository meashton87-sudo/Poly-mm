/* Build a scenario (Pro, game.js #custom): any two teams of any season the site has rosters for (web/rosters, built by
 * src/nflclock/scenario.py), any kind of game and any situation, played in the same engine as every other mode.
 *
 * A scenario is a plain object (defaults(), PRESETS):
 *   you, ys / opp, os   your team and its season, the other team and its season (two different franchises)
 *   type                REG, WC, DIV, CON or SB (the overtime of its time: overtime(), as pro.py overtime_rules)
 *   site                home (you are), away or neutral (a Super Bowl's)
 *   qtr, clock          1-4, or 5 for overtime; seconds left in it (at most the quarter's 15:00, the overtime's period)
 *   score               [yours, theirs]
 *   ball, start         who has the ball ('you' or 'opp'); start 'snap', or 'kick': a kickoff to the team with the ball
 *   yl, down, ytg       the yards to the goal for the team with the ball (75: its own 25), the down and the distance
 *   to                  [your timeouts, theirs]
 *   otp                 overtime: 0 its first possession, 1 the other team has had the ball, 2 both have
 *   r2h, end            a first-half scenario: who receives the second-half kickoff, and whether it ends at the half
 *   rules               two seasons: whose season's rules ('you' or 'opp')
 * code() writes one as a short link-safe code (#custom-<code>), parse() reads it back; check() lists what is wrong
 * with one (an impossible state: a distance past the goal line, a clock past the quarter's length, an overtime lead
 * the rules of its time would have ended); title (optional, TITLE_MAX characters) is the scenario's name: it rides along
 * in the link (link(), parseLink(): #custom-<code>~<title>, the code alone as before) but is no part of the code, so a
 * scenario is one scenario whatever it is called; spotOf() turns one into a spot and its two teams in the daily game's
 * format (dailygame.py spot_record, history.py teams). The page (game.js), node (web/game_smoke.js) and the tests
 * (tests/test_scenario.py) share it. */
(function (global) {
  'use strict';
  const VERSION = '1';
  const TITLE_MAX = 40;
  const TYPES = { REG: 'Regular season', WC: 'Wild Card', DIV: 'Divisional round', CON: 'Conference Championship', SB: 'Super Bowl' };
  const QUARTER = 900;
  // the regular season's overtime was 15:00 until 2017, 10:00 since; the playoffs' always 15:00
  function overtime(season, type) {
    const po = type !== 'REG';
    const rules = season >= 2025 || (po && season >= 2022) ? 'both' : season >= 2012 || (po && season >= 2010) ? 'msd' : 'sd';
    return { rules, len: po || season < 2017 ? 900 : 600 };
  }
  const OT_SAY = { sd: 'sudden death: the first score wins', msd: 'a touchdown on the first possession wins; a field goal gives the other team the ball',
    both: 'both teams get the ball, then the next score wins' };
  const rulesSeason = (sc) => (sc.rules === 'opp' ? sc.os : sc.ys);
  const otLen = (sc) => overtime(rulesSeason(sc), sc.type).len;
  const otTo = (sc) => (sc.type === 'REG' ? 2 : 3);      // timeouts in an overtime period (engine.js, game.js overtime)

  function defaults(season, you, opp) {
    return { you: you || 'KC', ys: season, opp: opp || 'BUF', os: season, type: 'REG', site: 'home', qtr: 4, clock: 120, score: [17, 21],
      ball: 'you', start: 'snap', yl: 75, down: 1, ytg: 10, to: [2, 3], otp: 0, r2h: 'opp', rules: 'you', end: 'game' };
  }
  // one tap to a classic spot (the teams and the game kept as they are)
  const PRESETS = {
    drill: { label: '2-minute drill, down 4', sub: '2:00 left, your 25', set: { qtr: 4, clock: 120, score: [17, 21], ball: 'you', start: 'snap', yl: 75, down: 1, ytg: 10, to: [2, 3] } },
    milk: { label: '4-minute offense, up 3', sub: '4:00 left, your 35', set: { qtr: 4, clock: 240, score: [24, 21], ball: 'you', start: 'snap', yl: 65, down: 1, ytg: 10, to: [3, 2] } },
    half: { label: 'End of the half', sub: '0:50 left, your 30, tied', set: { qtr: 2, clock: 50, score: [10, 10], ball: 'you', start: 'snap', yl: 70, down: 1, ytg: 10, to: [2, 3], end: 'half' } },
    short: { label: '4th and short', sub: '4th & 1 at their 38, down 3', set: { qtr: 4, clock: 400, score: [20, 23], ball: 'you', start: 'snap', yl: 38, down: 4, ytg: 1, to: [2, 2] } },
    goal: { label: 'Goal-line stand', sub: 'They have 1st & goal at your 3', set: { qtr: 4, clock: 75, score: [27, 24], ball: 'opp', start: 'snap', yl: 3, down: 1, ytg: 3, to: [1, 2] } },
    ot: { label: 'Overtime', sub: 'Tied, the opening kickoff', set: { qtr: 5, clock: 600, score: [24, 24], ball: 'you', start: 'kick', yl: 65, down: 1, ytg: 10, to: [2, 2], otp: 0 } },
  };
  // a preset on a scenario: the overtime's length and timeouts follow its rules
  function applyPreset(sc, k) {
    const out = { ...sc, ...PRESETS[k].set };
    if (out.qtr === 5) { out.clock = otLen(out); out.to = [otTo(out), otTo(out)]; }
    return out;
  }

  const TEAM_RE = /^[A-Z]{2,3}$/;
  const int = (x) => Number.isInteger(x);
  // a team-season the site has (the rosters' index: { seasons: [{ season, teams: [{ team }] }] }); without the index
  // only the shape is checked
  function hasTeam(idx, team, season) {
    if (!idx) return TEAM_RE.test(team) && int(season) && season >= 1999 && season <= 2100;
    const s = (idx.seasons || []).find((x) => x.season === season);
    return !!(s && s.teams.some((t) => t.team === team));
  }
  // the most a team can have scored with this much of the game gone: two touchdowns and two-point tries in the first
  // minute and a half, a score every minute and a half after that (nothing before the opening kickoff)
  const maxScore = (gone) => (gone <= 0 ? 0 : 16 + 8 * Math.floor(gone / 90));
  const goneOf = (sc) => (sc.qtr >= 5 ? 3600 : (sc.qtr - 1) * QUARTER + (QUARTER - sc.clock));
  // [field, message] for everything that is wrong (none: a scenario that can be played)
  function check(sc, idx) {
    const out = [];
    const bad = (f, m) => out.push([f, m]);
    if (!sc || typeof sc !== 'object') return [['all', 'Not a scenario']];
    if (sc.title && titleBad(sc.title)) bad('title', titleBad(sc.title));
    if (!hasTeam(idx, sc.you, sc.ys)) bad('you', `There are no ${sc.ys} rosters for that team`);
    if (!hasTeam(idx, sc.opp, sc.os)) bad('opp', `There are no ${sc.os} rosters for that team`);
    if (sc.you === sc.opp) bad('opp', 'Pick two different teams');
    if (!TYPES[sc.type]) bad('type', 'Pick the kind of game');
    if (!['home', 'away', 'neutral'].includes(sc.site)) bad('site', 'Pick home, away or a neutral site');
    if (!(int(sc.qtr) && sc.qtr >= 1 && sc.qtr <= 5)) { bad('qtr', 'Pick a quarter or overtime'); return out; }
    const len = sc.qtr === 5 ? otLen(sc) : QUARTER;
    if (!(int(sc.clock) && sc.clock >= 1 && sc.clock <= len)) bad('clock', `The clock runs from ${Math.floor(len / 60)}:00 down to 0:01`);
    const sy = sc.score && sc.score[0], so = sc.score && sc.score[1];
    if (!(Array.isArray(sc.score) && int(sy) && int(so) && sy >= 0 && so >= 0 && sy <= 99 && so <= 99)) bad('score', 'Scores run from 0 to 99');
    else if (sy === 1 || so === 1) bad('score', 'A score of 1 is next to impossible: 0, or 2 and up');
    else if (sc.qtr <= 4 && Math.max(sy, so) > maxScore(goneOf(sc))) bad('score', goneOf(sc) <= 0 ? 'Nobody has scored before the opening kickoff' : 'That is more points than there has been time for');
    if (!['you', 'opp'].includes(sc.ball)) bad('ball', 'Who has the ball?');
    if (!['snap', 'kick'].includes(sc.start)) bad('start', 'A snap or a kickoff?');
    if (sc.start === 'snap') {
      if (!(int(sc.yl) && sc.yl >= 1 && sc.yl <= 99)) bad('yl', 'The ball is between the 1-yard lines');
      if (!(int(sc.down) && sc.down >= 1 && sc.down <= 4)) bad('down', 'Downs run 1 to 4');
      if (!(int(sc.ytg) && sc.ytg >= 1 && sc.ytg <= 40)) bad('ytg', 'The distance runs from 1 to 40 yards');
      else if (int(sc.yl) && sc.ytg > sc.yl) bad('ytg', `The distance can't be past the goal line (${sc.yl} ${sc.yl === 1 ? 'yard' : 'yards'} to go at most)`);
    }
    const tmax = sc.qtr === 5 ? otTo(sc) : 3;
    if (!(Array.isArray(sc.to) && sc.to.every((t) => int(t) && t >= 0 && t <= tmax))) bad('to', `Timeouts run from 0 to ${tmax}${sc.qtr === 5 ? ` in a${sc.type === 'REG' ? ' regular-season' : ' playoff'} overtime` : ''}`);
    if (sc.ys !== sc.os && !['you', 'opp'].includes(sc.rules)) bad('rules', 'Whose season’s rules?');
    if (sc.qtr <= 2) {
      if (!['you', 'opp'].includes(sc.r2h)) bad('r2h', 'Who gets the ball after halftime?');
      if (!['half', 'game'].includes(sc.end)) bad('end', 'Play to the half or to the end of the game?');
    }
    if (sc.qtr === 5 && !out.some(([f]) => f === 'score')) {
      // overtime: who has had the ball, and a score the rules of its time would still be playing on
      const R = overtime(rulesSeason(sc), sc.type).rules, lead = sc.score[sc.ball === 'you' ? 1 : 0] - sc.score[sc.ball === 'you' ? 0 : 1];
      if (![0, 1, 2].includes(sc.otp)) bad('otp', 'Who has had the ball in overtime?');
      else if (lead < 0) bad('score', 'In overtime the team with the ball can’t be ahead: the game would be over');
      else if (lead > 0) {
        if (R === 'sd') bad('score', `${rulesSeason(sc)} overtime was sudden death: any score ended it, so it must be tied`);
        else if (sc.otp !== 1) bad('otp', 'Behind in overtime: the other team scored on its first possession, so it has had the ball and you have not');
        else if (R === 'msd' && lead !== 3) bad('score', `Under the ${rulesSeason(sc)} rules only a field goal on the first possession keeps it going: down 3`);
        else if (R === 'both' && ![3, 6, 7, 8].includes(lead)) bad('score', 'Down 3, 6, 7 or 8 after their first possession (a safety ends it)');
      } else if (sc.start === 'kick' && sc.otp === 1) bad('otp', 'Tied after one possession: it ended without a score, so there is no kickoff');
      else if (sc.start === 'kick' && sc.otp === 2 && R === 'sd') bad('otp', `${rulesSeason(sc)} overtime was sudden death: the only kickoff is the opening one`);
    }
    return out;
  }
  const ok = (sc, idx) => !check(sc, idx).length;

  // A title is shown to whoever opens the link (and, posted, on the Community list): slurs and obscenities are refused,
  // spelled any way. The same lists and rule as board/worker.js blocked() (the board refuses a public one; this is the
  // page's hint): change both (board/worker_test.mjs checks they agree)
  const SUB = ['nigg', 'niga', 'nigr', 'faggot', 'retard', 'kike', 'chink', 'wetback', 'tranny', 'beaner', 'raghead',
    'towelhead', 'fuck', 'fck', 'shit', 'cunt', 'pussy', 'whore', 'slut', 'bitch', 'hitler', 'kkk', 'cocksuck', 'motherf',
    'dildo', 'blowjob', 'handjob', 'jizz', 'porn', 'penis', 'vagina', 'molest', 'incest', 'boob', 'titties', 'onlyfans',
    'siegheil', 'heilhit', 'gasthe', 'killall', 'nazi'];
  const WORD = ['ass', 'asses', 'asshole', 'dick', 'dicks', 'cock', 'cocks', 'fag', 'fags', 'twat', 'wank', 'piss', 'hoe',
    'hoes', 'nig', 'dyke', 'homo', 'tit', 'tits', 'cum', 'anal', 'sex', 'sexy', 'spic', 'coon', 'gook', 'rape', 'raped',
    'rapist', 'pedo', 'fuk', 'nude', 'naked', 'jihad', 'terrorist'];
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };
  function blocked(name) {
    const low = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const mapped = [...low].map((c) => LEET[c] ?? c).join('');
    const squash = (x) => x.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
    const whole = squash(mapped), joined = mapped.replace(/[^a-z]/g, '');
    if (SUB.some((w) => { const sw = squash(w); return (sw.length >= 4 && whole.includes(sw)) || joined.includes(w); })) return true;
    const words = mapped.split(/[^a-z]+/).filter(Boolean);
    return words.some((w) => WORD.includes(w) || WORD.includes(squash(w)));
  }
  // a title as kept: control characters out, spaces as one, trimmed, TITLE_MAX at most (worker.js clean)
  const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  // what is wrong with a title ('' for none or a good one)
  function titleBad(t) {
    const raw = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length > TITLE_MAX) return `A title is ${TITLE_MAX} characters at most`;
    return raw && blocked(raw) ? 'That title is not allowed: pick another' : '';
  }

  // the code: VERSION and every field, '-' between (a team's code and the numbers never hold one)
  const LETTER = { site: { home: 'h', away: 'a', neutral: 'n' }, who: { you: 'y', opp: 'o' }, start: { snap: 's', kick: 'k' }, end: { half: 'h', game: 'g' } };
  const unletter = (m, c) => Object.keys(m).find((k) => m[k] === c);
  function code(sc) {
    return [VERSION, sc.you, sc.ys, sc.opp, sc.os, sc.type, LETTER.site[sc.site], sc.qtr, sc.clock, sc.score[0], sc.score[1], LETTER.who[sc.ball],
      LETTER.start[sc.start], sc.yl, sc.down, sc.ytg, sc.to[0], sc.to[1], sc.otp, LETTER.who[sc.r2h], LETTER.who[sc.rules], LETTER.end[sc.end]].join('-');
  }
  const CODE_RE = /^1(?:-[0-9A-Za-z]{1,4}){21}$/;
  function parse(s) {
    s = String(s || '').trim();
    if (!CODE_RE.test(s)) return null;
    const f = s.split('-');
    const n = (x) => (/^\d{1,4}$/.test(x) ? Number(x) : NaN);
    const sc = { you: f[1].toUpperCase(), ys: n(f[2]), opp: f[3].toUpperCase(), os: n(f[4]), type: f[5].toUpperCase(), site: unletter(LETTER.site, f[6]),
      qtr: n(f[7]), clock: n(f[8]), score: [n(f[9]), n(f[10])], ball: unletter(LETTER.who, f[11]), start: unletter(LETTER.start, f[12]),
      yl: n(f[13]), down: n(f[14]), ytg: n(f[15]), to: [n(f[16]), n(f[17])], otp: n(f[18]), r2h: unletter(LETTER.who, f[19]),
      rules: unletter(LETTER.who, f[20]), end: unletter(LETTER.end, f[21]) };
    return Object.values(sc).some((v) => v === undefined || (typeof v === 'number' && Number.isNaN(v))) || sc.score.concat(sc.to).some(Number.isNaN) ? null : sc;
  }
  // the link's part after #custom-: the code, then ~ and the title (URI-encoded) when it has one
  const link = (sc) => { const t = cleanTitle(sc.title); return `${code(sc)}${t ? `~${encodeURIComponent(t)}` : ''}`; };
  // { code, title } from a link's part ('' for a title that is missing, broken or not allowed: the scenario plays without it)
  function parseLink(s) {
    const str = String(s || ''), i = str.indexOf('~');
    let title = '';
    if (i >= 0) { try { title = cleanTitle(decodeURIComponent(str.slice(i + 1))); } catch (e) { title = ''; } }
    return { code: i >= 0 ? str.slice(0, i) : str, title: title && !blocked(title) ? title : '' };
  }
  // fields that don't matter for this situation take their defaults, so one scenario has one code
  function tidy(sc) {
    const out = { ...sc, score: sc.score.slice(), to: sc.to.slice() };
    if (out.start === 'kick') { out.yl = 65; out.down = 1; out.ytg = 10; }
    if (out.qtr !== 5) out.otp = 0;
    if (out.qtr > 2) { out.r2h = 'opp'; out.end = 'game'; }
    if (out.ys === out.os) out.rules = 'you';
    const t = cleanTitle(out.title);
    if (t) out.title = t; else delete out.title;
    return out;
  }

  // the kind of spot it is, as the daily game names them (dailygame.py CATEGORIES)
  function category(sc) {
    const lead = sc.score[0] - sc.score[1];
    return sc.qtr <= 2 || lead === 0 ? 'tight' : lead < 0 ? 'drill' : 'protect';
  }
  const PASS_W = 0.6;
  const strength = (t) => PASS_W * (t.base.off_pass + t.qb.adjustment - t.base.def_pass) + (1 - PASS_W) * (t.base.off_rush - t.base.def_rush);
  // the home team's point spread: the two teams' strengths (scenario.py spread_fit), the home field off at a neutral site
  function spreadOf(home, away, neutral, fit) {
    const f = fit || { hfa: 2.4, k: 46 };
    return Math.round(((neutral ? 0 : f.hfa) + f.k * (strength(home) - strength(away))) * 2) / 2;
  }
  // { spot, teams }: the scenario as a spot (dailygame.py spot_record's fields; real: the season whose rules it plays,
  // the kind of game, no real coach or drive) and its two teams (rosters/<season>.json); fit: the index's spread
  function spotOf(sc, rosYou, rosOpp, fit) {
    const tY = rosYou.teams[sc.you], tO = rosOpp.teams[sc.opp];
    if (!tY || !tO) throw new Error('the teams are not in the rosters');
    const homeYou = sc.site !== 'away', neutral = sc.site === 'neutral';
    const H = homeYou ? sc.you : sc.opp, A = homeYou ? sc.opp : sc.you;
    const mine = (x) => (homeYou ? [x[1], x[0]] : [x[0], x[1]]);          // [yours, theirs] -> [away, home]
    const withBall = sc.ball === 'you' ? sc.you : sc.opp, without = sc.ball === 'you' ? sc.opp : sc.you;
    const season = rulesSeason(sc), lg = (sc.rules === 'opp' ? rosOpp : rosYou).league;
    const start = { qtr: sc.qtr, clock: sc.clock, score: mine(sc.score), pos: sc.start === 'kick' ? without : withBall, down: sc.down, ytg: sc.ytg, yl: sc.yl,
      to: mine(sc.to), running: false, phase: sc.start === 'kick' ? 'kick' : 'snap', receive2h: sc.r2h === 'you' ? sc.you : sc.opp };
    if (sc.qtr === 5) {          // overtime: each team's finished possessions, [home, away] (engine.js S.ot.c)
      const other = sc.start === 'kick' ? start.pos : without;
      start.otc = [0, 0].map((_, i) => (sc.otp === 2 ? 1 : sc.otp === 1 && (i === 0 ? H : A) === other ? 1 : 0));
    }
    const spot = { id: `custom:${code(sc)}`, custom: true, category: category(sc), home: H, away: A, player: sc.you, neutral, indoor: false, wind: 0, temp: null,
      start, spread: spreadOf(homeYou ? tY : tO, homeYou ? tO : tY, neutral, fit),
      real: { season, week: null, type: sc.type, date: null, coach: null, call: null, drive: null, final: null },
      league: neutral ? { ...lg, home_pass: 0, home_rush: 0 } : lg, overtime: overtime(season, sc.type), end: sc.qtr <= 2 ? sc.end : 'game',
      seasons: { [sc.you]: sc.ys, [sc.opp]: sc.os } };
    return { spot, teams: { home: homeYou ? tY : tO, away: homeYou ? tO : tY } };
  }

  const clockText = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const ordinal = (n) => `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n] || 'th'}`;
  // where the ball is, said for the team that has it: "its own 25", "midfield", "the 30" (theirs)
  function spotSay(yl, mine) {
    if (yl === 50) return 'midfield';
    return yl > 50 ? `${mine ? 'your' : 'their'} own ${100 - yl}` : `${mine ? 'their' : 'your'} ${yl}`;
  }
  // the summary card's lines (name: a team code and season -> its name, as the page says it)
  function summary(sc, name) {
    const you = name(sc.you, sc.ys), opp = name(sc.opp, sc.os), s = rulesSeason(sc), ot = overtime(s, sc.type);
    const lead = sc.score[0] - sc.score[1];
    const when = sc.qtr === 5 ? `Overtime, ${clockText(sc.clock)} left` : `${clockText(sc.clock)} left in the ${['1st', '2nd', '3rd', '4th'][sc.qtr - 1]} quarter`;
    const mine = sc.ball === 'you';
    const ball = sc.start === 'kick' ? (mine ? `${opp} kick off to you` : `You kick off to ${opp}`)
      : `${mine ? 'Your' : `${opp}’`} ball, ${ordinal(sc.down)} & ${sc.ytg >= sc.yl ? 'goal' : sc.ytg} on ${mine ? spotSay(sc.yl, true).replace('your own', 'your') : spotSay(sc.yl, false).replace('their own', 'their')}`;
    return {
      title: `${you} vs ${opp}`, name: cleanTitle(sc.title) || null,
      game: `${TYPES[sc.type]}${sc.site === 'neutral' ? ', neutral site' : sc.site === 'home' ? ', at home' : ', on the road'}`,
      when, score: lead > 0 ? `Up ${sc.score[0]}–${sc.score[1]}` : lead < 0 ? `Down ${sc.score[0]}–${sc.score[1]}` : `Tied ${sc.score[0]}–${sc.score[1]}`,
      ball, to: `Timeouts: you ${sc.to[0]}, ${opp} ${sc.to[1]}`,
      ot: sc.type !== 'REG' ? `${s} playoff rules: no ties; overtime is ${OT_SAY[ot.rules]}` : `${s} overtime: ${ot.len / 60} minutes, ${OT_SAY[ot.rules]}; it can end tied`,
      half: sc.qtr <= 2 ? (sc.end === 'half' ? 'It ends at halftime' : `Played to the end of the game; ${sc.r2h === 'you' ? 'you get' : `${opp} get`} the ball after halftime`) : null,
    };
  }

  // a random scenario that passes check() (the tests' and the browser bots': web/game_smoke.js, scripts/browser_test.py):
  // R a generator of [0, 1), idx the rosters' index; opt.qtr / opt.end / opt.type to pin those
  function random(R, idx, opt) {
    const o = opt || {}, pick = (a) => a[Math.floor(R() * a.length)], int_ = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
    const ss = idx.seasons;
    for (let k = 0; k < 500; k++) {
      const sy = pick(ss), so = R() < 0.5 ? sy : pick(ss);
      const you = pick(sy.teams).team, opp = pick(so.teams.filter((t) => t.team !== you)).team;
      const type = o.type || (R() < 0.5 ? 'REG' : pick(['WC', 'DIV', 'CON', 'SB']));
      const qtr = o.qtr || pick([4, 4, 4, 4, 2, 2, 5, 5, 3, 1]);
      const sc = { you, ys: sy.season, opp, os: so.season, type, site: type === 'SB' ? 'neutral' : pick(['home', 'away', 'neutral', 'home']),
        qtr, clock: 0, score: [0, 0], ball: R() < 0.7 ? 'you' : 'opp', start: R() < 0.12 ? 'kick' : 'snap', yl: int_(15, 95), down: int_(1, 4), ytg: 10,
        to: [int_(0, 3), int_(0, 3)], otp: 0, r2h: pick(['you', 'opp']), rules: pick(['you', 'opp']), end: o.end || pick(['half', 'game']) };
      sc.ytg = int_(1, Math.min(sc.down === 1 ? 10 : 15, sc.yl));
      const base = int_(3, 30), m = int_(-8, 8);
      if (qtr === 5) {
        sc.clock = R() < 0.5 ? otLen(sc) : int_(30, otLen(sc));
        sc.to = sc.to.map((t) => Math.min(t, otTo(sc)));
        sc.otp = int_(0, 2);
        sc.score = [base + 7, base + 7];
        if (sc.otp === 1 && R() < 0.5) sc.score[sc.ball === 'you' ? 1 : 0] += pick([3, 7]);
      } else {
        sc.clock = qtr === 4 ? int_(15, 300) : qtr === 2 ? int_(15, 150) : int_(60, 900);
        const most = maxScore(goneOf(sc));
        sc.score = [Math.min(most, base + Math.max(m, 0)), Math.min(most, base + Math.max(-m, 0))].map((x) => (x === 1 ? 0 : x));
      }
      if (ok(sc, idx)) return tidy(sc);
    }
    return null;
  }

  const TMDScenario = { VERSION, TITLE_MAX, blocked, cleanTitle, titleBad, link, parseLink, TYPES, PRESETS, OT_SAY, overtime, defaults, applyPreset, check, ok, code, parse, tidy, category, strength, spreadOf,
    spotOf, summary, random, rulesSeason, otLen, otTo, maxScore, clockText };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = TMDScenario;
  if (global) global.TMDScenario = TMDScenario;       // (always: a page with some other script's global `module` still gets it)
})(typeof self !== 'undefined' ? self : this);
