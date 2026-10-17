/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * One real late-game drive a day (2023-26, playoffs included), played by the two teams of that game:
 * the 22 who were on the field, rated as of that week. Each spot opens on a scenario card;
 * Next shows the whole field (their end zone at the top, yours at the bottom) with every player as a dot
 * from red to green by his overall rating. Call Run, Pass or RPO (or a timeout, spike, kneel or kick when it
 * matters), then the play. The nflclock engine (engine.js, in Web Workers) plays the snap from real NFL
 * plays of that call and values every option by simulating the rest of the game. Nothing says which call
 * is best until after the snap. The day ends with a percentile against NFL play-callers and the head
 * coach whose late-game calls look most like yours. Survivor (#survivor) plays random real fourth quarters
 * back to back: win to keep going, one loss ends the run. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const RUN = 0, PASS = 1, KNEEL = 2, SPIKE = 3;
  const SNAP = 0, PAT = 1, KICKOFF = 2, DONE = 3;
  const N_EVAL = 600;
  const N_REFINE = 3000, REFINE_TOP = 3;   // the second round of grading (evaluateGraded)
  // each worker holds its own parsed copy of the engine and play data (about 11.5 MB of JSON): two on phones
  const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const POOL = Math.max(1, Math.min(TOUCH ? 2 : 3, (navigator.hardwareConcurrency || 2) - 1));
  const STORE = 'tmd:v3';
  // the website stamps each build (<meta name="build">, scripts/site.py): every file the page loads carries it, so a
  // phone that cached the last build's files fetches this build's instead of mixing old and new
  const BUILD = (document.querySelector('meta[name="build"]') || {}).content || '';
  const asset = (u) => (BUILD ? `${u}?v=${encodeURIComponent(BUILD)}` : u);
  // Analytics events (the website's Google tag, scripts/site.py --ga; nothing anywhere else): what players do, so the
  // next changes follow the data. Event names and fields are listed in the README.
  const track = (name, params) => { try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) { /* never in the way */ } };
  const modeName = () => (VS ? 'versus' : SURV ? 'survivor' : DRIVE ? 'drive' : RUN_N ? 'run' : ARCH_DAY ? 'archive' : 'daily');
  // a drive left half-played: when the page goes to the background mid-drive (closed, or switched away from), once
  // a page load, with how far in it was and whether it was still waiting on the simulator's data
  const liveDrive = { on: false, calls: 0, t0: 0, kind: null, left: false };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !liveDrive.on || liveDrive.left) return;
    liveDrive.left = true;
    track('drive_leave', { mode: modeName(), kind: liveDrive.kind, calls: liveDrive.calls, secs: Math.round((performance.now() - liveDrive.t0) / 1000),
      loading: readyCount === 0, transport_type: 'beacon' });
  });
  // every share ends with the address, so a posted score brings its readers to the game (the website's own host;
  // on claude.ai, where the page has no build stamp, the site's name)
  const SITE = BUILD && location.host ? location.host.replace(/^www\./, '') : 'nfl2mindrill.com';
  // Share: the phone's share sheet where there is one (a group chat in a tap), else the clipboard, else select it
  async function shareText(text, pre, what) {
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try { await navigator.share({ text }); track('share', { what, method: 'sheet' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); track('share', { what, method: 'copy' }); }
    catch (e) { const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); toast('Selected: copy it'); track('share', { what, method: 'select' }); }
  }
  const SVGNS = 'http://www.w3.org/2000/svg';

  const TEAMS = {
    ARI: ['Cardinals', '#97233F'], ATL: ['Falcons', '#A71930'], BAL: ['Ravens', '#241773'], BUF: ['Bills', '#00338D'],
    CAR: ['Panthers', '#0085CA'], CHI: ['Bears', '#0B162A'], CIN: ['Bengals', '#FB4F14'], CLE: ['Browns', '#FF3C00'],
    DAL: ['Cowboys', '#003594'], DEN: ['Broncos', '#FB4F14'], DET: ['Lions', '#0076B6'], GB: ['Packers', '#203731'],
    HOU: ['Texans', '#03202F'], IND: ['Colts', '#002C5F'], JAX: ['Jaguars', '#006778'], KC: ['Chiefs', '#E31837'],
    LV: ['Raiders', '#A5ACAF'], LAC: ['Chargers', '#0080C6'], LA: ['Rams', '#003594'], MIA: ['Dolphins', '#008E97'],
    MIN: ['Vikings', '#4F2683'], NE: ['Patriots', '#002244'], NO: ['Saints', '#D3BC8D'], NYG: ['Giants', '#0B2265'],
    NYJ: ['Jets', '#125740'], PHI: ['Eagles', '#004C54'], PIT: ['Steelers', '#FFB612'], SF: ['49ers', '#AA0000'],
    SEA: ['Seahawks', '#69BE28'], TB: ['Buccaneers', '#D50A0A'], TEN: ['Titans', '#4B92DB'], WAS: ['Commanders', '#5A1414'],
    // college teams, for a featured college game (src/nflclock/custom_spots.json); never in Versus
    OSU: ['Buckeyes', '#BB0000'], IU: ['Hoosiers', '#990000'], ALA: ['Crimson Tide', '#9E1B32'], TENN: ['Volunteers', '#FF8200'],
  };
  const COLLEGE = new Set(['OSU', 'IU', 'ALA', 'TENN']);
  const FAM = { run: 'Run', pass: 'Pass', rpo: 'RPO', trick: 'Trick' };
  // the trick plays (playbook.py): what each one is, on its key
  const TRICK_SUB = { trick_flea: 'Hand off, pitch it back, go deep', trick_reverse: 'Fake one way, a receiver comes back the other',
    trick_pass: 'A back or receiver throws it', trick_direct: 'Snap it straight to the back' };
  const TRICK_SAY = { trick_flea: 'run the flea-flicker', trick_reverse: 'run the end-around', trick_pass: 'let a receiver throw it',
    trick_direct: 'snap it direct to the back' };
  const TEMPOS = ['nohuddle', 'huddle', 'milk'];
  // your defense on their snaps: the looks it shows (the engine draws their play from real plays against it)
  const DEFS = ['blitz', 'load', 'soft'];
  const DEF = { blitz: { label: 'Blitz', sub: 'Send extra rushers' }, load: { label: 'Load the box', sub: 'Stop the run' },
    soft: { label: 'Play it soft', sub: 'Keep it in front' } };
  // the defense's pre-snap look, as the engine buckets real plays: a light box (6 or fewer near the line) or a loaded
  // one (7 or more), with or without a blitz
  const LOOKS = [{ loaded: false, blitz: false }, { loaded: false, blitz: true }, { loaded: true, blitz: false }, { loaded: true, blitz: true }];
  // the defense's whole call (engine.js DC): personnel, front, coverage and pass rush. The offense's play is a real one
  // run against that defense (its rush, its coverage, its box), worth what such plays are worth against it (engine.js
  // sampleVsDefense, dcEffect)
  const VDEF = [
    ['pers', 'Personnel', [['heavy', 'Goal line', '3 DBs'], ['base', 'Base', '4 DBs'], ['nickel', 'Nickel', '5 DBs'], ['dime', 'Dime', '6 DBs']]],
    ['front', 'Front', [['light', 'Light', '6 in box'], ['even', 'Even', '7 in box'], ['loaded', 'Stacked', '8 in box']]],
    ['cover', 'Coverage', [['c0', 'Cover 0', 'Man, 0 deep'], ['c1', 'Cover 1', 'Man, 1 deep'], ['2man', '2-Man', 'Man, 2 deep'], ['c2', 'Cover 2', 'Zone, 2 deep'],
      ['c3', 'Cover 3', 'Zone, 3 deep'], ['c4', 'Cover 4', 'Quarters'], ['c6', 'Cover 6', 'Split field'], ['prevent', 'Prevent', 'All deep']]],
    ['rush', 'Rush', [[3, '3', 'Drop 8'], [4, '4', 'Standard'], [5, '5', 'Blitz'], [6, '6+', 'All-out']]],
  ];
  const vdefName = (part, k) => ((VDEF.find((x) => x[0] === part)[2].find((o) => o[0] === k) || [])[1] || '');
  // what each coverage does and gives up, in a line
  const COVER_TIP = {
    c0: 'Everyone in man, nobody deep. Beat a man and it is a touchdown.',
    c1: 'Man with one safety deep. Tight on the quick game; the quarterback can run on it.',
    '2man': 'Man underneath, two safeties deep. Smothers passes, light against the run.',
    c2: 'Five underneath, two deep. Takes the short game away; the deep middle is open.',
    c3: 'Three deep, four under. Stops the deep ball, gives the quick game room.',
    c4: 'Four deep. Nothing over the top, room underneath.',
    c6: 'Quarters to one side, Cover 2 to the other: a little of both.',
    prevent: 'Everyone back. Nothing deep, anything short.',
  };
  // the call a defense would make here: goal line near the goal, dime on 2nd to 4th and long, else nickel Cover 3
  function vdefDefault(r) {
    if (r.try2 || r.yl <= 3) return { pers: 'heavy', front: 'loaded', cover: 'c1', rush: 5 };
    if (r.ytg <= 2) return { pers: 'base', front: 'loaded', cover: 'c1', rush: 4 };
    if (r.down >= 2 && r.ytg >= 7) return { pers: 'dime', front: 'light', cover: 'c4', rush: 4 };
    return { pers: 'nickel', front: 'even', cover: 'c3', rush: 4 };
  }
  // the quick calls: a whole defense in one tap, the ones a defensive coordinator reaches for (the goal-line and
  // prevent calls only where they make sense)
  const PRESET = {
    run_stop: { label: 'Run stop', sub: 'Base, 8 in the box, Cover 1', dc: { pers: 'base', front: 'loaded', cover: 'c1', rush: 4 } },
    base3: { label: 'Base Cover 3', sub: 'Base personnel, three deep', dc: { pers: 'base', front: 'even', cover: 'c3', rush: 4 } },
    nickel3: { label: 'Nickel Cover 3', sub: 'Five DBs, three deep', dc: { pers: 'nickel', front: 'even', cover: 'c3', rush: 4 } },
    quarters: { label: 'Nickel Quarters', sub: 'Five DBs, four deep', dc: { pers: 'nickel', front: 'light', cover: 'c4', rush: 4 } },
    two_deep: { label: 'Dime Cover 2', sub: 'Six DBs, two deep, five under', dc: { pers: 'dime', front: 'light', cover: 'c2', rush: 4 } },
    man: { label: '2-Man', sub: 'Man under, two safeties deep', dc: { pers: 'nickel', front: 'light', cover: '2man', rush: 4 } },
    fire: { label: 'Cover 1 blitz', sub: 'Man, one deep, five rush', dc: { pers: 'nickel', front: 'even', cover: 'c1', rush: 5 } },
    zero: { label: 'Zero blitz', sub: 'Everyone comes, nobody deep', dc: { pers: 'nickel', front: 'loaded', cover: 'c0', rush: 6 } },
    drop8: { label: 'Drop 8', sub: 'Three rush, eight in coverage', dc: { pers: 'dime', front: 'light', cover: 'c3', rush: 3 } },
    goal: { label: 'Goal line', sub: 'Big bodies, everyone up', dc: { pers: 'heavy', front: 'loaded', cover: 'c0', rush: 6 } },
    prevent: { label: 'Prevent', sub: 'Everyone deep, give up the short stuff', dc: { pers: 'dime', front: 'light', cover: 'prevent', rush: 3 } },
  };
  const sameDc = (a, b) => !!a && !!b && a.pers === b.pers && a.front === b.front && a.cover === b.cover && +a.rush === +b.rush;
  function presetsFor(r) {
    const late = !VS && halfLeft(r.t) <= 120 && r.score[G.me] > r.score[1 - G.me];
    return Object.keys(PRESET).filter((k) => (k === 'goal' ? r.try2 || r.yl <= 5 : k === 'prevent' ? late && r.yl >= 20 : k === 'run_stop' ? r.ytg <= 6 || r.yl <= 10 : true));
  }
  // how often NFL defenses line up this way here: the product of each part's share (dshare), floored so nothing is zero
  function dcShare(share, dc) {
    if (!share) return 0.1;
    return ['pers', 'front', 'cover', 'rush'].reduce((a, p) => a * Math.max((share[p] || {})[p === 'rush' ? dc.rush : dc[p]] || 0, 0.01), 1);
  }
  // the daily's starting call: what NFL defenses most often line up in here, part by part (dshare); else vdefDefault
  function nflDefault(r, share) {
    const d = vdefDefault(r);
    if (!share) return d;
    const top = (part) => { const e = Object.entries(share[part] || {}).sort((a, b) => b[1] - a[1])[0]; return e ? e[0] : null; };
    const rush = +top('rush');
    return { pers: top('pers') || d.pers, front: top('front') || d.front, cover: top('cover') || d.cover, rush: VDEF[3][2].some((o) => o[0] === rush) ? rush : d.rush };
  }
  const vdefText = (dc) => `${vdefName('pers', dc.pers)}, ${vdefName('cover', dc.cover)}, ${dc.rush >= 6 ? '6+' : dc.rush} rushing, ${({ light: 6, even: 7, loaded: 8 })[dc.front]} in the box`;
  // with the clock running: the tempo of the next snap (the engine's typical seconds between snaps), or stop it
  const CLOCK = {
    nohuddle: { label: 'No-huddle', short: 'No-huddle' },
    huddle: { label: 'Huddle', short: 'Huddle' },
    milk: { label: 'Milk the clock', short: 'Milk it' },
    timeout: { label: 'Timeout', act: { to_off: true } },
    // let it run to 0:03, then the timeout, then the kick (graded as the kick at 0:03: the engine's kick-to-win)
    rundown: { label: 'Run it down, timeout at 0:03' },
    spike: { label: 'Spike', act: { to_off: false, play: 'spike' } },
    kneel: { label: 'Kneel', act: { to_off: false, play: 'kneel' } },
  };
  const POS_NAME = { QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end', LT: 'Left tackle',
    LG: 'Left guard', C: 'Center', RG: 'Right guard', RT: 'Right tackle', EDGE: 'Edge rusher', DL: 'Defensive tackle',
    LB: 'Linebacker', CB: 'Cornerback', S: 'Safety', K: 'Kicker', P: 'Punter' };
  // our overall rating (40-99) is how he has played, on these measures, blended with how the league values him
  const POS_METHOD = {
    QB: 'EPA per play and completion % over expected',
    RB: 'rush yards over expected, rushing EPA, scrimmage yards per game and receiving EPA',
    WR: 'receiving yards per game, target and air-yards share, EPA per target and yards after the catch over expected',
    TE: 'receiving yards per game, target and air-yards share, EPA per target and yards after the catch over expected',
    OL: 'his line\'s pressure rate allowed and yards before contact, since no public stat grades linemen one at a time',
    EDGE: 'pressure rate, sacks, tackles for loss and QB hits',
    DL: 'pressure rate, sacks, tackles for loss and QB hits',
    LB: 'tackling, tackles for loss, missed-tackle rate, coverage and pressures',
    CB: 'passer rating allowed, interceptions and passes defended per target, yards per target and missed tackles',
    S: 'passer rating allowed, passes defended, missed-tackle rate, tackles and tackles for loss',
  };
  const POS_PLURAL = { QB: 'quarterbacks', RB: 'running backs', WR: 'wide receivers', TE: 'tight ends', OL: 'offensive linemen',
    EDGE: 'edge rushers', DL: 'interior linemen', LB: 'linebackers', CB: 'cornerbacks', S: 'safeties', K: 'kickers', P: 'punters' };
  const OL = ['LT', 'LG', 'C', 'RG', 'RT'];
  // passing: pick a receiver and his route. The routes each position runs (tap him again for the next), how deep each
  // is drawn (NGS median catch depths), and what it is called. The snap is a real play where a receiver at that
  // position ran that route (engine.js samplePlaybook)
  const ROUTES = { WR: ['slant', 'hitch', 'out', 'in', 'post', 'corner', 'go', 'screen'], TE: ['flat', 'hitch', 'out', 'cross', 'in', 'go'],
    RB: ['flat', 'angle', 'screen', 'wheel'] };
  const ROUTE_DEPTH = { go: 24, post: 16, corner: 19, out: 4, deep_out: 13, in: 12, slant: 6, cross: 4, hitch: 5, screen: -3, flat: -2, wheel: 16, angle: 3 };
  const ROUTE_NAME = { go: 'Go', post: 'Post', corner: 'Corner', out: 'Quick out', in: 'Dig', slant: 'Slant', cross: 'Crosser', hitch: 'Hitch',
    screen: 'Screen', flat: 'Flat', wheel: 'Wheel', angle: 'Angle' };
  const ROUTE_SAY = { go: 'a go route', post: 'a post', corner: 'a corner route', out: 'a quick out', in: 'a dig', slant: 'a slant', cross: 'a crosser',
    hitch: 'a hitch', screen: 'a screen', flat: 'a route to the flat', wheel: 'a wheel route', angle: 'an angle route' };
  const routeName = (lab, rt) => (lab === 'TE' && rt === 'go' ? 'Seam' : ROUTE_NAME[rt]);
  const routeSay = (lab, rt) => (lab === 'TE' && rt === 'go' ? 'a seam route' : ROUTE_SAY[rt]);
  const DEEP_ROUTES = new Set(['go', 'post', 'corner', 'wheel']);
  const DEEP = new Set(['deep_strong', 'deep_weak', 'deep_middle', 'pa_deep', 'hail_mary']);
  const SQ = { g: '🟩', y: '🟨', o: '🟧', r: '🟥' };
  const GLYPH = { g: '✓', y: '≈', o: '!', r: '✗' };
  const GRADE_WORD = { g: 'good', y: 'close', o: 'costly', r: 'a big miss' };

  let idx = null;                 // game.json
  let dayN = 1, today = [];
  // the day number of a date: day 1 is the launch (round: a day with a DST change is 23 or 25 hours)
  const dayOf = (d) => { const a = new Date(idx.launch + 'T00:00:00'), b = new Date(d); b.setHours(0, 0, 0, 0); return Math.max(1, Math.round((b - a) / 864e5) + 1); };
  let state = null;               // saved progress: today's drive, or the survivor run
  // two modes: the daily three spots, or survivor (#survivor): random real fourth-quarter spots back to back, win to
  // keep going, one loss and the run is over (a tie at the gun goes to overtime, played out: see overtime())
  const SURV = location.hash === '#survivor';
  // Pro is off until it is turned on in the site build (scripts/site.py --pro: <meta name="pro">): no tab, no
  // archive, no drives, no purchase
  // ... and, when the build sets a launch time (scripts/site.py --pro-at: <meta name="pro-at">), not before it: a page
  // open at that moment turns it on then (proLaunch)
  const PRO_BUILT = !!document.querySelector('meta[name="pro"]');
  const PRO_AT = Date.parse((document.querySelector('meta[name="pro-at"]') || {}).content || '') || 0;
  let PRO_ON = PRO_BUILT && Date.now() >= PRO_AT;
  // the archive (Pro): #archive lists every past day, #day-N plays one (its own saved state, like the day it was)
  const ARCH = PRO_ON && location.hash === '#archive', ARCH_DAY = PRO_ON ? Number((location.hash.match(/^#day-(\d+)$/) || [])[1] || 0) : 0;
  // a historic drive (Pro, pro/drives.json): #drive-N plays the Nth one, with its own saved state
  const DRIVE = PRO_ON ? Number((location.hash.match(/^#drive-(\d+)$/) || [])[1] || 0) : 0;
  // a playoff run (Pro, pro/runs.json): #run-N plays the Nth one, its games in order, like a day of several spots
  const RUN_N = PRO_ON ? Number((location.hash.match(/^#run-(\d+)$/) || [])[1] || 0) : 0;
  // the Gauntlet on its own (#gauntlet, or #gauntlet-results: the link the results share), for everyone, Pro or not
  const GAUNTLET = PRO_ON && /^#gauntlet(-results)?$/.test(location.hash);
  let PRO = null, PRO_RUNS = null;        // pro/drives.json and pro/runs.json, once loaded
  // Pro grades: a drive's score (better than this many % of NFL play-callers) as a letter. 90 and up is an A, green:
  // the drive is passed. The best grade on each drive is kept; the ranks count the drives passed
  const PASS_AT = 90;
  const GRADE_CUTS = [[90, 'A', 'g'], [80, 'B', 'y'], [70, 'C', 'o'], [60, 'D', 'r'], [0, 'F', 'r']];
  const gradeOf = (score) => { const [, L, c] = GRADE_CUTS.find(([m]) => score >= m); return { L, c, pass: score >= PASS_AT }; };
  const PRO_RANKS = [[0, 'Rookie play-caller'], [1, 'Position coach'], [5, 'Coordinator'], [10, 'Head coach'], [16, 'Super Bowl coach'], [Infinity, 'Hall of Fame']];
  // the rank for this many drives passed (of n): the Hall of Fame is every one of them
  function proRank(passed, n) {
    const ladder = PRO_RANKS.map(([k, t]) => [k === Infinity ? n : Math.min(k, n), t]);
    let i = 0;
    ladder.forEach(([k], j) => { if (passed >= k) i = j; });
    const next = ladder.slice(i + 1).find(([k]) => k > passed);
    return { title: ladder[i][1], next: next ? { at: next[0], title: next[1] } : null };
  }
  function gradeBadge(score, cls = '') {
    const g = gradeOf(score), b = el('span', `grade ${g.c}${cls ? ` ${cls}` : ''}`, g.L);
    b.setAttribute('aria-label', `Grade ${g.L}${g.pass ? ', passed' : ''}`);
    return b;
  }
  // versus (two players, live; the site build's --vs turns it on: <meta name="vs">): #vs the lobby, #vs-CODE a room
  const VS_ON = !!document.querySelector('meta[name="vs"]');
  const VS_LOBBY = VS_ON && location.hash === '#vs';
  const VS_ROOM = VS_ON ? ((location.hash.match(/^#vs-([A-HJ-KM-NP-Z2-9]{6})$/) || [])[1] || '') : '';
  const VS = !!VS_ROOM;
  // the full defensive call (personnel, front, coverage, rush) everywhere: Versus always; elsewhere only when the site
  // build turns it on (scripts/site.py --fulldef: <meta name="fulldef">), off on the main site until it is approved;
  // off, the defense is the three looks (blitz, load the box, play it soft)
  const FULLDEF = VS || !!document.querySelector('meta[name="fulldef"]');
  const VS_DECIDE_MS = 30000;      // the play clock in Versus: 30 seconds a call (board/match.js DECIDE_MS)
  // spots whose data was corrected, and when the fix went live: a drive's try saved before it starts over
  const SPOT_FIXED = { '2018_14_NE_MIA#4172': Date.parse('2026-10-16T22:50:00Z') };
  const stateKey = () => (VS ? `${STORE}:vs:${VS_ROOM}` : SURV ? `${STORE}:surv` : DRIVE ? `${STORE}:drive:${DRIVE}` : RUN_N ? `${STORE}:run:${RUN_N}` : `${STORE}:day:${dayN}`);
  const saveState = () => save(stateKey(), state);
  const seedKey = () => (VS ? `vs${vs.seed}` : SURV ? `s${state.run}:${state.games.length}` : DRIVE ? `drive${DRIVE}` : RUN_N ? `run${RUN_N}` : dayN);    // what the engine's draws are seeded by
  let G = null;                   // the spot being played
  let ui = { step: null, fam: null, oob: false };
  let busy = false, lastFocus = null, tick = null, lastBall = null;
  const CALL = {};

  // ------------------------------------------------------------- helpers ---
  const clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const wpTxt = (p) => `${(p * 100).toFixed(1)}%`;
  const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function hash(...parts) {
    let h = 2166136261 >>> 0;
    for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h % 1000003;
  }
  function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function load(key, dflt) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage off: play on */ } }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function key(label, sub, cls, i) {
    const b = el('button', `key${cls ? ' ' + cls : ''}`);
    b.type = 'button';
    b.append(document.createTextNode(label));
    if (sub) b.append(el('small', '', sub));
    if (i != null) { b.classList.add('pop'); b.style.setProperty('--i', i); }
    return b;
  }
  const teamName = (c) => (TEAMS[c] ? TEAMS[c][0] : c);
  const color = (c) => (TEAMS[c] ? TEAMS[c][1] : '#556');
  const code = (i) => (i === 0 ? G.scen.home : G.scen.away);
  const teamOf = (i) => (i === 0 ? G.scen.game.home : G.scen.game.away);
  const markOf = (cost) => (cost < 0.005 ? 'g' : cost < 0.02 ? 'y' : cost < 0.05 ? 'o' : 'r');
  function rate(o) {          // an overall rating as a color: red (below a starter) -> yellow (typical, 77) -> green (elite)
    const v = clip(o, 55, 95);
    const h = v < 77 ? 2 + ((v - 55) / 22) * 43 : 45 + ((v - 77) / 18) * 90;
    const l = v < 77 ? 52 : 50 - ((v - 77) / 18) * 4;
    return `hsl(${h.toFixed(0)} ${v > 72 && v < 82 ? 88 : 80}% ${l.toFixed(0)}%)`;
  }
  const groupOf = (label) => (OL.includes(label) || label === 'T' || label === 'G' ? 'OL' : label);
  function shortName(n) {
    const parts = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/, '').split(/\s+/);
    return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : (n || '');
  }
  // the end of the first half (t = 1800) reads 0:00 of the 2nd quarter: every spot is late in Q2 or Q4
  function clockOf(t) {
    const q = t > 2700 ? 1 : t >= 1800 ? 2 : t > 900 ? 3 : 4;
    const s = Math.max(0, t - (4 - q) * 900), c = Math.ceil(s - 1e-6);      // a game clock: 0:00 only when time is out
    return { q, s, text: `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}` };
  }
  const halfLeft = (t) => t - (t > 1800 ? 1800 : 0);
  const qLabel = (r) => (r.ot ? (r.ot.n > 1 ? `OT${r.ot.n}` : 'OT') : `Q${clockOf(r.t).q}`);
  // a tempo key (nohuddle, huddle, milk) as the engine's tempo; no-huddle is the engine's own hurry-up when
  // that is the usual tempo here, else 'urgent' inside two minutes of the half and 'hurry' before
  function engineTempo(k, r) {
    if (k === 'huddle') return 'normal';
    if (k === 'milk') return 'milk';
    const usual = G.info && G.info.tempo;
    return usual === 'urgent' || usual === 'hurry' ? usual : halfLeft(r.t) <= 120 ? 'urgent' : 'hurry';
  }
  const tempoKeyOf = (t) => (t === 'urgent' || t === 'hurry' ? 'nohuddle' : t === 'normal' ? 'huddle' : 'milk');
  const RUNDOWN_AT = 3;               // seconds left after the timeout (engine.js CLOSE_KICK_AT)
  const clockAct = (k, r) => (TEMPOS.includes(k) ? { to_off: false, tempo: engineTempo(k, r) }
    : k === 'rundown' ? { to_off: false, to_def: false, runoff: Math.max(0, halfLeft(r.t) - RUNDOWN_AT), play: 'fg' } : CLOCK[k].act);
  const tempoSecs = (k, r) => { const S_ = (G.info && G.info.tempoSecs) || {}; return S_[engineTempo(k, r)]; };
  function spotText(r) {
    if (Math.round(r.yl) === 50) return 'midfield';
    const own = r.pos === G.me;
    if (r.yl > 50) return own ? `your ${Math.round(100 - r.yl)}` : `their ${Math.round(100 - r.yl)}`;
    return own ? `their ${Math.round(r.yl)}` : `your ${Math.round(r.yl)}`;
  }
  const onSpot = (r) => { const t = spotText(r); return t === 'midfield' ? 'at midfield' : `on ${t}`; };
  function ddText(r) {
    if (r.try2) return 'Two-point try';
    const goal = r.ytg >= r.yl;
    return `${ordinal(r.down)} & ${goal ? 'Goal' : Math.max(1, Math.round(r.ytg))}`;
  }
  function startRoot(sc) {
    const st = sc.start;
    return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sc.home ? 0 : 1,
      score: [st.score[1], st.score[0]], down: st.down, ytg: Math.min(st.ytg, st.yl), yl: st.yl,
      to: [st.to[1], st.to[0]], clock_running: !!st.running, phase: SNAP, credit: 0, free_kick: false };
  }
  // a spot's matchup: its two teams as they were in that game (web/spots), the real point spread, that
  // season's league averages
  function buildScen(sp, T) {
    const H = T.home, A = T.away;
    const game = { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
      league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real ? sp.real.season : idx.asof.season };
    return { ...sp, game };
  }
  const sideFor = (seq) => (hash('side', seedKey(), G.si, seq) % 2 ? 1 : -1);   // +1: strong side on the offense's right
  const lineup = (i) => (teamOf(i).lineup || { off: [], def: [] });
  // personnel (backs then tight ends, as the NFL names it: 12 is one back, two tight ends): the groupings you can
  // pick on offense; the play is then drawn from real plays run with it (engine.js samplePlaybook)
  const PERS = [[11, '3 WR'], [12, '2 TE'], [21, 'FB'], [13, '3 TE']];
  const persOf = (off) => off.filter((p) => p.pos === 'RB' || p.pos === 'FB').length * 10 + off.filter((p) => p.pos === 'TE').length;
  // your offense in the personnel you picked: the snap's players, then that game's backups (bench), best first
  function offLineup(i) {
    const L = lineup(i), off = L.off;
    if (i !== G.me || ((!G.pers || G.pers === persOf(off)) && !G.persWho)) return off;
    const P0 = G.pers || persOf(off), nb = Math.floor(P0 / 10), nt = P0 % 10, nw = 5 - nb - nt, bench = L.bench || [];
    const core = off.filter((p) => !['RB', 'FB', 'TE', 'WR'].includes(p.pos));
    const who = G.persWho || {};
    const fill = (have, pool, pos, n) => {
      const all = have.concat(pool), want = (who[pos === 'RB' ? 'backs' : pos] || []).map((nm) => all.find((p) => p.name === nm)).filter(Boolean);
      const out = [...new Set(want.concat(have))].slice(0, n);
      for (const p of pool) if (out.length < n && !out.includes(p)) out.push(p);
      while (out.length < n) out.push({ pos, name: `Backup ${pos}`, ovr: 60, stat: 'A backup' });
      return out;
    };
    const byOvr = (a, b) => (b.ovr || 0) - (a.ovr || 0);
    const backs = fill(off.filter((p) => p.pos === 'RB').concat(off.filter((p) => p.pos === 'FB')), bench.filter((p) => p.pos === 'FB').concat(bench.filter((p) => p.pos === 'RB')), 'RB', nb)
      .map((p, k) => (k ? { ...p, pos: 'FB' } : { ...p, pos: 'RB' }));
    const tes = fill(off.filter((p) => p.pos === 'TE').sort(byOvr), bench.filter((p) => p.pos === 'TE'), 'TE', nt);
    const wrs = fill(off.filter((p) => p.pos === 'WR').sort(byOvr), bench.filter((p) => p.pos === 'WR'), 'WR', nw);
    return core.concat(backs, tes, wrs);
  }
  function names(i) {
    const off = offLineup(i);
    const qb = off.find((p) => p.pos === 'QB'), rb = off.find((p) => p.pos === 'RB');
    return { qb: qb ? shortName(qb.name) : null, rb: rb ? shortName(rb.name) : null };
  }

  // -------------------------------------------------------- worker pool ---
  const pool = [], queue = [], pending = new Map();
  let reqId = 0, readyCount = 0;
  // The data downloads once here; the first worker starts at once and the rest once it is ready, so the first snap
  // isn't waiting on several workers parsing at the same time.
  // On the website the data comes packed (scripts/site.py pack): half the bytes of the JSON, gunzipped here.
  // Anywhere without the packed files (the claude.ai artifact, a local copy) or without DecompressionStream: the JSON.
  let dataBytes = null, packed = false;
  const dl = { got: 0, total: 0 };                 // download progress, shown while the first snap waits on it
  async function fetchBytes(url, what, size) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${what} ${r.status}`);
    const len = +r.headers.get('content-length') || size;
    dl.total += len;
    if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); dl.got += len; return b; }
    const rd = r.body.getReader(), parts = [];
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); dl.got += value.length;
    }
    return new Blob(parts).arrayBuffer();
  }
  async function fetchPacked(name, size) {
    const zipped = await fetchBytes(asset(name), name, size);
    const out = await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const h = new Uint8Array(out, 0, 4);
    if (String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'NFCP') throw new Error('not a data pack');
    return out;
  }
  function startWorkers() {
    const json = () => Promise.all([fetchBytes(asset('engine_data.json'), 'engine data', 5.5e6), fetchBytes(asset('playbook.json'), 'playbook', 6.1e6)]);
    const pk = BUILD && typeof DecompressionStream === 'function'
      ? Promise.all([fetchPacked('engine_data.pack', 1.6e6), fetchPacked('playbook.pack', 1.7e6)]).then((b) => { packed = true; return b; })
      : Promise.reject(new Error('no pack'));
    dataBytes = pk.catch(() => { dl.got = 0; dl.total = 0; packed = false; return json(); });
    dataBytes.catch((e) => fatal('The simulator could not load (' + e.message + '). Check your connection and reload.'));
    startWorker();
  }
  function startWorker() {
    const w = new Worker(asset('game_worker.js'));
    const slot = { w, ready: false, busy: false };
    w.onmessage = (ev) => onMsg(slot, ev.data);
    w.onerror = (e) => fatal('The simulator could not start: ' + (e.message || 'worker error'));
    pool.push(slot);
    dataBytes.then(([eng, pb]) => {
      const engine = eng.slice(0), playbook = pb.slice(0);      // a copy each, moved into the worker
      w.postMessage({ type: 'init', engine, playbook, packed }, [engine, playbook]);
    }, () => {});
  }
  function pump() {
    for (const s of pool) {
      if (!s.ready || s.busy) continue;
      const m = queue.shift();
      if (!m) return;
      s.busy = true;
      s.w.postMessage(m);
    }
  }
  function onMsg(slot, m) {
    if (m.type === 'ready') {
      slot.ready = true; readyCount++;
      if (readyCount === 1) {              // how long the simulator took, and how long a player sat waiting on it
        const now = performance.now();
        track('sim_ready', { mode: modeName(), packed, ms: Math.round(now), waited_ms: huddleT0 ? Math.round(now - huddleT0) : 0 });
      }
      if (readyCount === 1) for (let i = 1; i < POOL; i++) startWorker();
      if (readyCount === POOL) dataBytes = null;               // every worker has its copy: let the bytes go
      pump(); return;
    }
    if (m.type === 'error' && m.id == null) { fatal('The simulator could not load (' + m.message + '). Check your connection and reload.'); return; }
    slot.busy = false;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) { if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m); }
    pump();
  }
  // urgent: the snap itself and the facts for a call go ahead of any grading still queued
  function send(msg, urgent) {
    return new Promise((resolve, reject) => { msg.id = ++reqId; pending.set(msg.id, { resolve, reject }); if (urgent) queue.unshift(msg); else queue.push(msg); pump(); });
  }
  const simScen = () => ({ id: G.scen.id, game: G.scen.game, start: { receive2h: G.scen.start.receive2h } });
  async function evaluate(root, options, seed, n = N_EVAL) {
    const W = Math.max(1, readyCount), sc = simScen(), out = {};
    const opts = options.map((o) => ({ key: o.key, action: o.action }));
    if (options.length < 2 * W && W > 1) {
      // few options: every worker plays all of them, each on its own share of the games (its own seed)
      const m = Math.ceil(n / W);
      const res = await Promise.all(Array.from({ length: W }, (_, j) => send({ type: 'eval', scen: sc, root, options: opts, n: m, persp: G.me, seed: (seed + j * 7919) >>> 0 })));
      opts.forEach((o) => { out[o.key] = res.reduce((a, r) => a + r.out.find((x) => x.key === o.key).mean, 0) / W; });
      return out;
    }
    const k = Math.min(W * 3, options.length);          // small jobs: a worker is soon free for the snap
    const chunks = Array.from({ length: k }, () => []);
    opts.forEach((o, i) => chunks[i % k].push(o));
    const res = await Promise.all(chunks.map((c) => send({ type: 'eval', scen: sc, root, options: c, n, persp: G.me, seed })));
    res.forEach((r) => r.out.forEach((o) => { out[o.key] = o.mean; }));
    return out;
  }
  // grading a decision: every option N_EVAL times, then the top few and your choice again N_REFINE times on fresh
  // games. Valued on the same games that picked it, the best of many noisy options is lucky, and every other call looks
  // worse than it is (at 600 games, 15% of the calls shown red were really green or yellow); valued again, it is not.
  // An option left out of the second round never counts as better than the best one valued in it.
  async function evaluateGraded(root, options, seed, chosen) {
    const v = await evaluate(root, options, seed);
    const keys = new Set(options.slice().sort((a, b) => v[b.key] - v[a.key]).slice(0, REFINE_TOP).map((o) => o.key));
    if (chosen !== undefined) keys.add(chosen);
    const v2 = await evaluate(root, options.filter((o) => keys.has(o.key)), (seed ^ 0x5bd1e995) >>> 0, N_REFINE);
    const top = Math.max(...Object.values(v2));
    options.forEach((o) => { v[o.key] = keys.has(o.key) ? v2[o.key] : Math.min(v[o.key], top); });
    return v;
  }

  // ------------------------------------------------- what coaches do (q) ---
  function tendFeatures(r, decider) {
    const margin = r.score[decider] - r.score[1 - decider];
    const th = halfLeft(r.t), half2 = r.t <= 1800 ? 1 : 0;
    const special = r.phase !== SNAP;
    const yl = special ? 75 : r.yl, ytg = special ? 10 : Math.min(r.ytg, r.yl), down = special ? 1 : r.down;
    return [th / 60, Math.log1p(th), half2, margin, Math.abs(margin), margin < 0 ? 1 : 0, margin > 0 ? 1 : 0,
      down, ytg, Math.log(Math.max(ytg, 1)), yl / 10, (yl / 10) ** 2, r.to[decider], r.to[1 - decider], th <= 120 ? 1 : 0,
      (th <= 300 && half2) ? 1 : 0, r.clock_running ? 1 : 0, yl <= 40 ? 1 : 0, Math.max(yl - 40, 0) / 10];
  }
  function inDomain(family, r, decider) {
    const margin = r.score[decider] - r.score[1 - decider];
    const q = clockOf(r.t).q, th = halfLeft(r.t);
    switch (family) {
      case 'def_timeout': return (q === 4 && th <= 300 && margin <= 0 && margin >= -16) || (q === 2 && th <= 120);
      case 'off_clock_stop': return (q === 4 && th <= 120 && margin <= 0 && margin >= -16) || (q === 2 && th <= 60);
      case 'fourth_down': return ((q === 4 && th <= 600) || (q === 2 && th <= 120)) && Math.abs(margin) <= 16;
      case 'pat': return q === 4;
      case 'onside': return q === 4 && th <= 420 && margin < 0 && margin >= -16;
      default: return false;
    }
  }
  function coachProbs(family, r, decider) {
    const T = idx.models && idx.models.tendency;
    if (!T || !T.families[family] || !inDomain(family, r, decider)) return null;
    const m = T.families[family], x = tendFeatures(r, decider);
    const z = m.coef.map((row, c) => m.intercept[c] + row.reduce((a, w, j) => a + w * (x[j] - m.mean[j]) / m.scale[j], 0));
    let p;
    if (m.classes.length === 2 && m.coef.length === 1) { const s = 1 / (1 + Math.exp(-z[0])); p = [1 - s, s]; }
    else { const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); p = e.map((v) => v / s); }
    const out = {};
    m.classes.forEach((c, i) => { out[c] = p[i]; });
    return out;
  }
  function normalize(q, keys) {
    const out = {};
    let s = 0;
    keys.forEach((k) => { out[k] = Math.max(q[k] || 0, 0); s += out[k]; });
    if (s <= 0) keys.forEach((k) => { out[k] = 1 / keys.length; });
    else keys.forEach((k) => { out[k] /= s; });
    return out;
  }
  function decisionFrom(kind, family, options, vals, chosen, q, situation, snap = G.snapN) {
    const wps = options.map((o) => ({ key: o.key, label: o.label, wp: vals[o.key], call: (o.action && o.action.call) || null, ...(o.action && o.action.dc ? { dc: o.action.dc } : {}) }));
    const best = wps.reduce((a, b) => (b.wp > a.wp ? b : a));
    const mine = wps.find((w) => w.key === chosen);
    const qq = normalize(q, wps.map((w) => w.key));
    const typical = wps.reduce((a, w) => a + qq[w.key] * w.wp, 0);
    const cost = Math.max(0, best.wp - mine.wp);
    return { kind, family, situation, wps, chosen, chosenCall: mine.call, chosenLabel: mine.label, best: best.key, bestLabel: best.label,
      bestWp: best.wp, wp: mine.wp, cost, q: qq, typical, wpa: mine.wp - typical, snap };
  }

  // ---------------------------------------------------------- formations ---
  // x in the offense's own frame (its right is +), depth in yards behind (offense) or off (defense) the ball
  const SX0 = 8, SX1 = 352, XYD = (SX1 - SX0) / 53.333;
  const HASH_L = SX0 + 23.58 * XYD, HASH_R = SX1 - 23.58 * XYD;
  const clampX = (x) => clip(x, SX0 + 12, SX1 - 12);
  function formation(offL, defL, s, bx) {
    const by = {};
    offL.forEach((p) => { (by[p.pos] = by[p.pos] || []).push(p); });
    const take = (pos) => (by[pos] && by[pos].length ? by[pos].shift() : null);
    const off = [], def = [];
    const put = (arr, p, x, d, label) => { if (p) arr.push({ p, x: clampX(x), d, label: label || p.pos }); };
    const olX = { LT: -52, LG: -26, C: 0, RG: 26, RT: 52 };
    OL.forEach((lab) => put(off, take(lab), bx + olX[lab], 1.0, lab));
    ['T', 'G'].forEach((lab) => { let p; while ((p = take(lab))) put(off, p, bx, 1.0, lab); });
    const teX = bx + s * 78;
    const xX = s > 0 ? SX0 + 22 : SX1 - 22, zX = s > 0 ? SX1 - 26 : SX0 + 26, slotX = (teX + zX) / 2;
    put(off, take('TE'), teX, 1.15, 'TE');
    put(off, take('WR'), xX, 1.0, 'WR');
    put(off, take('WR'), zX, 1.5, 'WR');
    put(off, take('WR'), slotX, 1.7, 'WR');
    put(off, take('QB'), bx, 5.0, 'QB');
    put(off, take('RB'), bx - s * 25, 5.2, 'RB');
    put(off, take('FB'), bx, 3.0, 'FB');
    const spare = [[bx - s * 78, 1.15], [bx + s * 25, 5.2], [(xX + bx - s * 52) / 2, 1.7]];
    Object.values(by).flat().forEach((p, i) => { const sp = spare[i % spare.length]; put(off, p, sp[0], sp[1]); });
    const g = { EDGE: [], DL: [], LB: [], CB: [], S: [], X: [] };
    defL.forEach((p) => (g[p.pos] || g.X).push(p));
    const edges = g.EDGE.slice(), line = [];
    if (edges.length) line.push(edges.shift());
    line.push(...g.DL, ...edges);
    const n = line.length, sp = n <= 4 ? 34 : n === 5 ? 29 : 25;
    line.forEach((p, i) => put(def, p, bx + s * (i - (n - 1) / 2) * sp, 1.0));
    const nl = g.LB.length, lsp = nl >= 3 ? 40 : 46;
    g.LB.forEach((p, i) => put(def, p, bx + s * 8 + (i - (nl - 1) / 2) * lsp, 5.0));
    const cbs = [[clampX(zX), 6.5], [clampX(xX), 6.5], [clampX(slotX), 5.5], [bx + s * 34, 9.0]];
    g.CB.forEach((p, i) => { const c = cbs[Math.min(i, 3)]; put(def, p, c[0] + (i > 3 ? (i - 3) * 30 : 0), c[1]); });
    const ns = g.S.length, third = g.CB.length < 3 ? [clampX(slotX), 5.6] : [teX, 7.6];
    const ss = ns === 1 ? [[bx + s * 12, 13]] : [[bx - s * 62, 12.5], [bx + s * 62, 12.5], third, [bx, 10]];
    g.S.forEach((p, i) => { const c = ss[Math.min(i, ss.length - 1)]; put(def, p, c[0], c[1]); });
    g.X.forEach((p, i) => put(def, p, bx + (i - (g.X.length - 1) / 2) * 40, 8));
    return { off, def };
  }
  // the defense shows its look: a safety walks down into a loaded box, a linebacker widens out of a light one,
  // and a blitz look brings two of them up to the line
  function showLook(def, L, s, bx) {
    const lbs = def.filter((o) => o.label === 'LB'), safeties = def.filter((o) => o.label === 'S');
    if (L.loaded) {
      const sd = safeties[safeties.length - 1];
      if (sd) { sd.x = clampX(bx + s * 30); sd.d = 7.5; }
      lbs.forEach((o) => { o.d = 4.5; o.x = bx + (o.x - bx) * 0.8; });
    } else if (lbs.length) {
      const wide = lbs.slice().sort((a, b) => Math.abs(b.x - bx) - Math.abs(a.x - bx))[0];
      wide.x = clampX(bx - s * 70); wide.d = 6.2;
    }
    if (L.blitz) {
      const up = lbs.length ? lbs.slice(0, 2) : safeties.slice(0, 1);
      up.forEach((o, i) => { o.d = 1.9; o.x = clampX(bx + (i ? -1 : 1) * s * (18 + 22 * i)); });
    }
  }
  // ------------------------------------------------------------ the field ---
  // The whole field, your end zone at the bottom of the screen. L counts yards from your goal line (0) to
  // theirs (100); a camera shows yards lo..hi: the whole field, or close up while a play runs.
  const FULL = { lo: -10, hi: 110 };
  const GAP = 6;            // drawn gap (units) between each side and the line of scrimmage before the snap
  let scene = null, fadeNext = false;
  const lerp = (a, b, u) => a + (b - a) * u;
  const EASE = { lin: (u) => u, io: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
    in: (u) => u * u, out: (u) => 1 - (1 - u) * (1 - u), run: trapezoid(0.2, 0.15), dash: trapezoid(0.2, 0) };
  // speed ramps up over the first `a` of the move, holds, and ramps down over the last `d` (peak 1.2x the average)
  function trapezoid(a, d) {
    const v = 1 / (1 - a / 2 - d / 2);
    return (u) => (u < a ? (v * u * u) / (2 * a) : u <= 1 - d ? v * (a / 2 + u - a) : 1 - (v * (1 - u) ** 2) / (2 * d));
  }

  function spotGeom(r) {
    const mine = r.pos === G.me;
    let L, dir = mine ? 1 : -1, mode = 'snap';
    if (r.phase === KICKOFF) { mode = 'kick'; const own = r.free_kick ? 20 : 35; L = mine ? own : 100 - own; }
    else if (r.phase === PAT) { mode = 'pat'; L = mine ? 85 : 15; }
    else if (r.phase === DONE) { mode = 'done'; L = mine ? 100 - r.yl : r.yl; }
    else L = mine ? 100 - r.yl : r.yl;
    return { L, dir, mode };
  }
  // where the next snap is, in L, after a play (whoever has the ball)
  const losOf = (r) => (r.pos === G.me ? 100 - r.yl : r.yl);
  // a new call: on a phone, back up to the field (the call is right under it) when the page was scrolled away
  function toField() {
    if (window.matchMedia && window.matchMedia('(min-width: 1000px)').matches) return;
    const f = $('play');
    if (!f || f.hidden || window.scrollY < 4) return;
    window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
  }
  const DOCK_ROOM = 205;    // px under the field on a phone: the call's heading and its first row of keys
  function fieldHeight() {
    const svg = $('field');
    const wpx = svg.parentElement.clientWidth || 360;
    // room left for the field: on wide screens the calls sit beside it (game.html); on a phone, what is above it (the
    // header, the score bar) and the call's first row below it (DOCK_ROOM) fit on the screen with no scrolling
    const side = window.matchMedia && window.matchMedia('(min-width: 1000px)').matches;
    if (side) return Math.round((360 * clip(window.innerHeight - 280, 360, 860)) / wpx);
    const top = svg.parentElement.getBoundingClientRect().top + window.scrollY;
    return Math.round((360 * clip(window.innerHeight - clip(top, 60, 260) - DOCK_ROOM, 300, 720)) / wpx);
  }
  // Before the snap the camera frames the play, true to scale (as many yards tall as the field is wide, in the
  // box's shape): a short way behind the offense and well downfield, where the routes go. Kicks and the final
  // whistle show the whole field.
  function preCam(H, L, dir, mode) {
    if (mode !== 'snap' && mode !== 'pat') return { ...FULL };
    const span = clip((H - 6) / (360 / 53.333), 50, 120), back = clip(span * 0.22, 12, 20);
    let lo = dir > 0 ? L - back : L + back - span, hi = lo + span;
    if (lo < FULL.lo) { hi += FULL.lo - lo; lo = FULL.lo; }
    if (hi > FULL.hi) { lo -= hi - FULL.hi; hi = FULL.hi; }
    return { lo: Math.max(lo, FULL.lo), hi: Math.min(hi, FULL.hi) };
  }
  const camY = (sc) => { const { lo, hi } = sc.cam, k = (sc.H - 6) / (hi - lo); return (L) => sc.H - 3 - (L - lo) * k; };

  // the field and the 22 for state r (side: the strong side of this snap); place() draws them for the camera
  function makeScene(r, side, look = r.pos === G.me ? G.look : null) {
    const svg = $('field'), H = fieldHeight();
    svg.setAttribute('viewBox', `0 0 360 ${H}`);
    svg.textContent = '';
    svg.classList.remove('playing');
    const sc = { svg, H, r, cam: { ...FULL }, parts: [], actors: [], calls: [] };
    const put = (el, upd) => { svg.append(el); if (upd) sc.parts.push(upd); return el; };
    put(S('rect', { x: 0, y: 0, width: 360, height: H, fill: 'var(--turf)' }));
    for (let L = 0; L < 100; L += 10) {
      const e = put(S('rect', { x: 0, width: 360, fill: 'var(--turf-2)' }), (Y) => { e.setAttribute('y', Y(L + 5)); e.setAttribute('height', Math.max(0, Y(L) - Y(L + 5))); });
    }
    [[100, 110, code(1 - G.me)], [-10, 0, code(G.me)]].forEach(([a, b, c]) => {
      const e = put(S('rect', { x: 0, width: 360, fill: color(c), opacity: 0.92 }), (Y) => { e.setAttribute('y', Y(b)); e.setAttribute('height', Math.max(0, Y(a) - Y(b))); });
      const t = put(S('text', { x: 180, class: 'ez', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, teamName(c).toUpperCase()), (Y) => t.setAttribute('y', (Y(a) + Y(b)) / 2));
    });
    const hline = (L, attrs) => {
      const e = put(S('line', { x1: SX0, x2: SX1, ...attrs }), (Y) => { const y = Y(L); e.setAttribute('y1', y); e.setAttribute('y2', y); });
      return e;
    };
    // the midfield logo (players asked: it shows where the ball is at a glance): sideways at the 50, as on an NFL
    // field, about 15 yards long (midlogo.png: the 2MD logo cut out of its navy)
    const logo = put(S('image', { class: 'midlogo', href: 'midlogo.png', preserveAspectRatio: 'xMidYMid meet' }), (Y) => {
      const len = clip(Math.abs(Y(42.5) - Y(57.5)), 50, 270), wid = len / 1.44, y = Y(50);
      logo.setAttribute('x', (-len / 2).toFixed(1)); logo.setAttribute('y', (-wid / 2).toFixed(1));
      logo.setAttribute('width', len.toFixed(1)); logo.setAttribute('height', wid.toFixed(1));
      logo.setAttribute('transform', `translate(180 ${y.toFixed(1)}) rotate(-90)`);
    });
    for (let L = 5; L <= 95; L += 5) hline(L, { stroke: 'var(--chalk)', 'stroke-width': L % 10 ? 0.6 : 1.1, opacity: L % 10 ? 0.6 : 1 });
    [0, 100].forEach((L) => hline(L, { stroke: 'var(--chalk)', 'stroke-width': 2.4 }));
    [-10, 110].forEach((L) => {     // the goalposts on each end line, seen from above
      const e = put(S('path', { class: 'posts' }), (Y) => { const y = Y(L), k = L < 0 ? -1 : 1; e.setAttribute('d', `M160 ${y + k * 5}V${y}H200V${y + k * 5}`); });
    });
    put(S('line', { x1: SX0, y1: 0, x2: SX0, y2: H, stroke: 'var(--chalk)', 'stroke-width': 1.6 }));
    put(S('line', { x1: SX1, y1: 0, x2: SX1, y2: H, stroke: 'var(--chalk)', 'stroke-width': 1.6 }));
    for (let L = 10; L <= 90; L += 10) {
      const n = String(L <= 50 ? L : 100 - L);
      [[SX0 + 9, -90], [SX1 - 9, 90]].forEach(([x, rot]) => {
        const e = put(S('text', { x, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, n),
          (Y) => { const y = Y(L); e.setAttribute('y', y); e.setAttribute('transform', `rotate(${rot} ${x} ${y})`); });
      });
    }
    const { L, dir, mode } = spotGeom(r);
    Object.assign(sc, { losL: L, dir, mode });
    sc.cam = preCam(H, L, dir, mode);
    sc.cam0 = { ...sc.cam };
    if (mode === 'done') { place(sc); return sc; }
    hline(L, { stroke: 'var(--los)', 'stroke-width': 2.4 });
    if (mode === 'snap' && r.ytg < r.yl - 0.01) hline(L + dir * r.ytg, { stroke: 'var(--chain)', 'stroke-width': 2.4 });
    const s = mode === 'snap' ? side : 1;
    const fxBall = mode === 'snap' ? (s > 0 ? HASH_L : HASH_R) : 180;     // strong side is the wide side
    const sx = (fx) => (dir > 0 ? fx : 360 - fx);
    Object.assign(sc, { s, bx: sx(fxBall) });
    sc.layer = put(S('g', {}));
    if (mode === 'snap' || mode === 'pat') {
      const offI = r.pos, f = formation(offLineup(offI).slice(), lineup(1 - offI).def.slice(), s, fxBall);
      if (mode === 'snap' && look != null) showLook(f.def, LOOKS[look], s, fxBall);
      const add = (o, teamI, off) => {
        const team = code(teamI), mine = teamI === G.me;
        const num = o.p.num != null ? String(o.p.num) : '';
        const g = S('g', { class: `dot ${mine ? 'me' : 'them'}`, tabindex: 0, role: 'button',
          'aria-label': `${teamName(team)} ${POS_NAME[o.label] || o.label} ${num ? `#${num} ` : ''}${o.p.name}, rated ${o.p.ovr}` });
        g.append(S('circle', { class: 'hit', r: 11 }), S('circle', { class: 'c', r: 7.2, fill: rate(o.p.ovr) }));
        if (num) { const t = S('text', { class: 'jn', y: 2.6 }); t.textContent = num; g.append(t); }
        const open = () => { if (passing() && (Date.now() - routeTapAt < 600 || (off && (o.label === 'WR' || o.label === 'TE' || o.label === 'RB')))) return; playerInfo(o.p, o.label, team); };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (!passTap(a)) open(); } });
        sc.layer.append(g);
        const a = { g, p: o.p, label: o.label, team, teamI, off, x0: sx(o.x), L0: L + (off ? -dir : dir) * o.d, side: off ? dir : -dir };
        Object.assign(a, { x: a.x0, L: a.L0, w: 1 });
        sc.actors.push(a);
      };
      f.def.forEach((o) => add(o, 1 - offI, false));
      f.off.forEach((o) => add(o, offI, true));
      sc.named = true;
    }
    if (mode === 'kick') kickoffUnits(sc, r, L, dir);
    const ball = S('g', {}), inner = S('g', { class: 'ballmove' });
    inner.append(S('ellipse', { cx: 0, cy: 0, rx: 3.4, ry: 5.2, fill: 'var(--ball)', stroke: 'rgba(255,255,255,.75)', 'stroke-width': 0.8 }));
    ball.append(inner);
    svg.append(ball);
    sc.ball = { g: ball, inner, x: sc.bx, L, z: 0, show: true };
    sc.callLayer = put(S('g', {}));
    if (mode === 'kick') showCall(sc, { text: r.free_kick ? 'Free kick' : 'Kickoff', kind: 'info', slot: 0, x: 180, L: L + dir * 7 });
    place(sc);
    if (sc.named) nameTags(sc);
    return sc;
  }
  // Pre-snap name tags ("J. Allen") on the players you track: the quarterback, backs, receivers and the back seven
  // (the linemen, five abreast, show their numbers only). Each goes on the far side from the line, or the near side
  // if that is taken, or is left off; they drop at the snap (animatePlay).
  const TAG_ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'CB', 'S', 'LB'];
  function nameTags(sc) {
    const Y = camY(sc), losY = Y(sc.losL), boxes = [];
    const free = (b, a) => b.x0 >= 2 && b.x1 <= 358 && b.y0 >= 2 && b.y1 <= sc.H - 2      // clear of the dots and tags so far
      && !boxes.some((o) => o.a !== a && b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    sc.actors.forEach((a) => boxes.push({ a, x0: a.x - 7.5, x1: a.x + 7.5, y0: Y(a.L) + a.side * GAP * a.w - 7.5, y1: Y(a.L) + a.side * GAP * a.w + 7.5 }));
    sc.actors.filter((a) => TAG_ORDER.includes(a.label) && a.p && a.p.name)
      .sort((a, b) => TAG_ORDER.indexOf(a.label) - TAG_ORDER.indexOf(b.label)).forEach((a) => {
      const text = shortName(a.p.name), w = text.length * 3.7 + 2, ay = Y(a.L) + a.side * GAP * a.w, away = ay >= losY ? 1 : -1;
      const spots = [[0, away * 13], [0, -away * 13], [-(w / 2 + 4), away * 11], [w / 2 + 4, away * 11], [0, away * 23]];
      for (const [dx, dy] of spots) {
        const b = { x0: a.x + dx - w / 2, x1: a.x + dx + w / 2, y0: ay + dy - 4.5, y1: ay + dy + 4.5 };
        if (!free(b, a)) continue;
        boxes.push(b);
        const t = S('text', { class: 'nm', x: dx.toFixed(1), y: (dy + 3).toFixed(1) });
        t.textContent = text;
        a.g.append(t);
        break;
      }
    });
  }
  // Kickoff alignment (the 2024 rules): the kicker at the ball, his ten teammates at the receiving 40 (25 yards
  // ahead of the ball), nine of the receiving team in the setup zone 30-35 yards ahead, and two returners deep.
  // Special-teams units are drawn in team colors: who covers kicks is not in the lineups.
  function kickoffUnits(sc, r, L, dir) {
    const kt = r.pos, goal = dir > 0 ? 100 : 0;
    const row = (n, pad) => Array.from({ length: n }, (_, i) => SX0 + pad + (i * (SX1 - SX0 - 2 * pad)) / (n - 1));
    const add = (teamI, x, Lp, label) => {
      const off = teamI === kt, g = S('g', { class: `dot st ${teamI === G.me ? 'me' : 'them'}`, 'aria-hidden': 'true' });
      g.append(S('circle', { class: 'c', r: 5.6, fill: color(code(teamI)) }));
      sc.layer.append(g);
      const a = { g, p: null, label, team: code(teamI), teamI, off, x0: x, L0: Lp, side: off ? -dir : dir, w0: 0 };
      Object.assign(a, { x: a.x0, L: a.L0, w: 0 });
      sc.actors.push(a);
    };
    add(kt, 180, L - dir * 6, 'K');
    row(10, 26).forEach((x) => add(kt, x, L + dir * 25, 'KC'));
    row(9, 34).forEach((x, i) => add(1 - kt, x, L + dir * (i % 2 ? 31 : 34), 'SZ'));
    add(1 - kt, 138, goal - dir * 4, 'KR');
    add(1 - kt, 222, goal - dir * 9, 'KR');
  }

  function place(sc) {
    const Y = camY(sc);
    sc.parts.forEach((f) => f(Y));
    sc.actors.forEach((a) => a.g.setAttribute('transform', `translate(${a.x.toFixed(1)},${(Y(a.L) + a.side * GAP * a.w).toFixed(1)})`));
    const b = sc.ball;
    if (b) {
      b.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${Y(b.L).toFixed(1)}) scale(${(1 + 0.35 * b.z).toFixed(2)})`);
      b.g.style.opacity = b.show ? 1 : 0;
    }
    sc.calls.forEach((c) => {
      const at_ = c.follow ? { x: c.follow.x, L: c.follow.L } : c;
      const x = clip(at_.x, c.w / 2 + 6, 354 - c.w / 2), y = clip(Y(at_.L) - 26 - c.slot * 30, 18, sc.H - 18);
      c.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    });
  }
  // a call-out on the field: "SACKED!", "TOUCHDOWN!", "FLAG: HOLDING"...; one per slot
  function showCall(sc, c) {
    sc.calls.filter((o) => o.slot === c.slot).forEach((o) => o.g.remove());
    sc.calls = sc.calls.filter((o) => o.slot !== c.slot);
    const big = c.kind === 'hit' || c.kind === 'good';
    const g = S('g', { class: `call ${c.kind}` }), inn = S('g', { class: 'in' });
    const t = S('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: big ? 'big' : '' }, c.text);
    const rect = S('rect', { rx: 7 });
    inn.append(rect, t);
    g.append(inn);
    sc.callLayer.append(g);
    let w = c.text.length * (big ? 11 : 8.5);
    try { w = t.getComputedTextLength() || w; } catch (err) { /* not rendered yet */ }
    w += 20;
    const h = big ? 32 : 25;
    Object.entries({ x: -w / 2, y: -h / 2, width: w, height: h }).forEach(([k, v]) => rect.setAttribute(k, v));
    c.shown = true;
    sc.calls.push({ ...c, g, w });
  }

  // ---- passing: the receivers you can throw to, their routes on the field, your pick
  const eligibles = (sc) => sc.actors.filter((a) => a.off && (a.label === 'WR' || a.label === 'TE' || a.label === 'RB'));
  const passing = () => ui && ui.step === 'pass' && G && G.root.pos === G.me && G.root.phase === SNAP;
  // every receiver starts on a route that fits the spot (you change them with a tap): the widest receivers first, then
  // the slot, the tight end and the back. At the goal line a fade, a slant and an out to the corner; trailing in the
  // two-minute drill, routes to the sideline to stop the clock; short yardage, quick throws; long yardage, a go, a dig
  // and a post; otherwise a go, an out, a slant, the crosser and the flat
  const SITU_ROUTES = {
    goal: { WR: ['go', 'slant', 'out', 'hitch'], TE: 'flat', RB: 'flat' },
    sideline: { WR: ['out', 'corner', 'out', 'hitch'], TE: 'out', RB: 'flat' },
    short: { WR: ['slant', 'hitch', 'out', 'slant'], TE: 'flat', RB: 'flat' },
    long: { WR: ['go', 'in', 'post', 'in'], TE: 'in', RB: 'angle' },
    base: { WR: ['go', 'out', 'slant', 'hitch'], TE: 'cross', RB: 'flat' },
  };
  function spotKind(r) {
    const lead = r.score[G.me] - r.score[1 - G.me];
    if (r.yl <= 10) return 'goal';
    if (r.clock_running && halfLeft(r.t) <= 120 && (lead <= 0 || r.t > 1800)) return 'sideline';
    if (r.ytg <= 3) return 'short';
    if (r.ytg >= 10) return 'long';
    return 'base';
  }
  function defaultRoutes(sc) {
    const E = eligibles(sc), wr = E.filter((a) => a.label === 'WR').sort((a, b) => Math.abs(b.x0 - sc.bx) - Math.abs(a.x0 - sc.bx));
    const R = SITU_ROUTES[spotKind(G.root)];
    return E.map((a) => (a.label === 'WR' ? R.WR[wr.indexOf(a)] || 'hitch' : a.label === 'TE' ? R.TE : R.RB));
  }
  // toward his own sideline; the same on the field and in the animation
  const outOf = (sc, a) => Math.sign(a.x0 - sc.bx) || sc.s * sc.dir || 1;
  function drawRoutes(sc) {
    const P = ui.pass, E = eligibles(sc), Y = camY(sc), g = S('g', { class: 'routes' });
    sc.routePts = [];
    E.forEach((a, i) => {
      const rt = P.routes[i], r = Motion.routeOnField(rt, ROUTE_DEPTH[rt], (a.x0 - SX0) / XYD, outOf(sc, a), sc.dir, sc.losL, Math.abs(a.L0 - sc.losL), 0.5);
      const pts = r.pts.map((q) => [clip(SX0 + q[0] * XYD, SX0 + 2, SX1 - 2), Y(clip(q[1], -9, 109))]);
      sc.routePts[i] = [[a.x0, Y(a.L0)], ...pts];
      const tgt = P.target === i, d = pts.map((q, k) => `${k ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
      if (tgt) g.append(S('path', { class: 'route halo', d }));
      g.append(S('path', { class: `route${tgt ? ' tgt' : ''}`, d }));
      const e = pts[pts.length - 1], q = pts[pts.length - 2], ang = Math.atan2(e[1] - q[1], e[0] - q[0]);
      const head = [[e[0], e[1]], [e[0] - 6 * Math.cos(ang - 0.5), e[1] - 6 * Math.sin(ang - 0.5)], [e[0] - 6 * Math.cos(ang + 0.5), e[1] - 6 * Math.sin(ang + 0.5)]];
      g.append(S('path', { class: `route-head${tgt ? ' tgt' : ''}`, d: `M${head.map((h) => h.map((v) => v.toFixed(1)).join(' ')).join('L')}Z` }));
      if (tgt) a.g.classList.add('target');
    });
    sc.svg.insertBefore(g, sc.layer);
  }
  // a tap on a receiver while you pick a pass: throw to him, or (already him) his next route
  // a tap on a receiver on the field: his next route (any receiver: set them all up, then pick who gets the ball).
  // The page stays where it is, so the field and every route stay in view while you tap
  function passTap(a) {
    if (busy || !passing() || !scene || !a.off) return false;
    const i = eligibles(scene).indexOf(a);
    if (i < 0) return false;
    const list = ROUTES[a.label], P = ui.pass;
    (P.hist = P.hist || []).push([i, P.routes[i]]);
    P.routes[i] = list[(list.indexOf(P.routes[i]) + 1) % list.length];
    redrawPass();
    return true;
  }
  function undoRoute() {
    if (busy || !passing()) return;
    const P = ui.pass, h = P && P.hist && P.hist.pop();
    if (!h) return;
    P.routes[h[0]] = h[1];
    redrawPass();
  }
  // each receiver's odds on his current route, from the real plays it would draw (worker 'odds'), cached per snap
  function pickKey(a) { return `${a.call}|${a.route}|${a.who}|${a.looks}`; }
  async function fetchOdds() {
    if (!passing() || !scene) return;
    G.odds = G.odds || {};
    const picks = eligibles(scene).map((_, i) => passOption(scene, i, false).action).filter((a) => !(pickKey(a) in G.odds));
    if (!picks.length) return;
    picks.forEach((a) => { G.odds[pickKey(a)] = null; });
    try {
      const res = await send({ type: 'odds', scen: simScen(), root: G.root, picks: picks.map((a) => ({ call: a.call, route: a.route, who: a.who, looks: a.looks })) }, true);
      picks.forEach((a, k) => { G.odds[pickKey(a)] = res.out[k]; });
    } catch (e) { picks.forEach((a) => { delete G.odds[pickKey(a)]; }); return; }      // asked again on the next redraw
    // into the cards already up, not a redrawn dock: a redraw between a finger's down and up would eat the throw
    if (passing() && !busy) {
      $('dock').querySelectorAll('button.rcv').forEach((b) => {
        const od = G.odds[b.dataset.k];
        if (!od || b.querySelector('.od')) return;
        b.append(el('span', 'od', oddsText(od)));
      });
    }
  }
  const oddsText = (o) => (o ? `${Math.round(o.caught * 100)}% caught · ${o.yds.toFixed(1)} yds a throw${o.picks >= 0.03 ? ` · ${Math.round(o.picks * 100)}% picked` : ''}` : '');
  // the field takes the tap itself (phones do not always send taps on small SVG shapes): a quick touch, not a scroll,
  // anywhere near a receiver's dot or along his route changes that route
  let routeTapAt = 0;                 // when the field last used a tap for a route (the dot under it then stays shut)
  function fieldTaps() {
    const svg = $('field');
    let down = null;
    svg.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: Date.now() }; });
    svg.addEventListener('pointerup', (ev) => {
      const d0 = down; down = null;
      if (!d0 || !passing() || !scene || !scene.routePts) return;
      if (Math.hypot(ev.clientX - d0.x, ev.clientY - d0.y) > 12 || Date.now() - d0.t > 700) return;
      const m = svg.getScreenCTM();
      if (!m) return;
      const q = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
      const segD = (p, a, b) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, u = L ? clip(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L, 0, 1) : 0;
        return Math.hypot(p.x - a[0] - u * dx, p.y - a[1] - u * dy);
      };
      let best = -1, bd = Infinity;
      scene.routePts.forEach((pts, i) => {
        let dd = Math.hypot(q.x - pts[0][0], q.y - pts[0][1]) - 6;             // his dot counts a little more
        for (let k = 1; k < pts.length; k++) dd = Math.min(dd, segD(q, pts[k - 1], pts[k]));
        if (dd < bd) { bd = dd; best = i; }
      });
      if (best >= 0 && bd <= 22) { ev.preventDefault(); routeTapAt = Date.now(); passTap(eligibles(scene)[best]); }
    });
  }
  // who gets the ball, by his place in the list (the field may be redrawn under the buttons: a resize, the phone's
  // address bar)
  function passPick(i) {
    if (busy || !passing() || !scene || !eligibles(scene)[i]) return;
    ui.pass.target = i;
    redrawPass();
  }
  function redrawPass() {
    const y = window.scrollY;
    lastBall = null;                  // the same snap: no fade-in, no ball move
    drawField();
    drawDock();
    window.scrollTo(0, y);
  }
  // the engine call a pick stands for (its pools hold the real plays): a screen, play action, a rollout, a deep shot
  // (the post down the middle), a throw over the middle (dig, crosser, angle) or a quick throw, to the receiver's side
  function passCallOf(sc, a, rt, pa, roll) {
    const side = outOf(sc, a) === sc.s * sc.dir ? 'strong' : 'weak';
    if (rt === 'screen') return 'screen';
    if (pa) return DEEP_ROUTES.has(rt) ? 'pa_deep' : 'pa_short';
    if (roll) return `roll_${side}`;
    if (DEEP_ROUTES.has(rt)) return rt === 'post' ? 'deep_middle' : `deep_${side}`;
    if (rt === 'in' || rt === 'cross' || rt === 'angle') return 'quick_middle';
    return `quick_${side}`;
  }
  // the option your pick is graded as, and the action the engine plays it with
  function passOption(sc, i, oob) {
    const P = ui.pass, a = eligibles(sc)[i], rt = P.routes[i], call = passCallOf(sc, a, rt, P.pa, P.roll);
    const name = a.p ? a.p.name : a.label;
    return { key: `pass:${i}:${rt}${P.pa ? ':pa' : P.roll ? ':roll' : ''}${oob ? '+oob' : ''}`,
      label: `${routeName(a.label, rt)} to ${shortName(name) || a.label}${P.pa ? ', play action' : P.roll ? ', rollout' : ''}${oob ? ', get out of bounds' : ''}`,
      action: withTempo({ to_off: false, play: 'pass', call, oob: !!oob, looks: G.look != null ? 1 << G.look : 0, route: rt, who: a.label,
        target: i, routes: P.routes.slice(), targetName: name, targetPos: a.label, pa: !!P.pa, roll: !!P.roll }) };
  }
  function drawField() {
    const sc = makeScene(G.root, G.side);
    scene = sc;
    // the chips over the field go to the open grass: the half of the screen away from the line of scrimmage
    sc.svg.parentElement.classList.toggle('chipsdown', camY(sc)(spotGeom(G.root).L) < sc.H / 2);
    if (passing()) {
      if (!ui.pass.routes || ui.pass.routes.length !== eligibles(sc).length) ui.pass.routes = defaultRoutes(sc);
      drawRoutes(sc);
    }
    if (fadeNext || lastBall) sc.layer && sc.layer.classList.add('movefade');
    fadeNext = false;
    const b = sc.ball;
    if (!b || sc.mode === 'done') { lastBall = null; return; }
    const y = camY(sc)(b.L);
    if (lastBall && !reduced() && (Math.abs(lastBall.x - b.x) > 0.5 || Math.abs(lastBall.y - y) > 0.5)) {
      b.inner.style.transform = `translate(${lastBall.x - b.x}px, ${lastBall.y - y}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { b.inner.style.transform = 'translate(0px, 0px)'; }));
    }
    lastBall = { x: b.x, y };
  }

  // ------------------------------------------------------ the play, animated ---
  // After the snap the camera zooms in and the 22 run the real NFL play the engine drew, with what happened called
  // out on the field. Every player moves the way NFL players move: motion.js limits each one's speed, acceleration,
  // braking and turning to what player tracking measures for his position. The play follows what the real play's
  // charting says: the target's route and the depth of the throw, man or zone and the coverage shell, how many
  // rushed, whether the passer was pressured and how long he held the ball. Tap the field to skip; with reduced
  // motion the result just shows.
  // (dead-ball fouls: nobody plays; illegal formation, shift or motion and the defense's twelfth man are live-ball fouls,
  // flagged after a snap that is played)
  const PRE_SNAP = new Set(['False Start', 'Offside', 'Defensive Offside', 'Encroachment', 'Neutral Zone Infraction', 'Delay of Game',
    'Defensive Delay of Game', 'Offensive Too Many Men on Field', 'Illegal Substitution']);
  const RUN_GAP = { 'Outside run': 92, 'Off-tackle run': 58, 'Inside run': 26, 'Up the middle': 0, 'QB sneak': 0, 'QB keeper': 60, RPO: 30 };
  const AIR = { quick_strong: 5, quick_weak: 5, quick_middle: 7, screen: -2, deep_strong: 24, deep_weak: 24, deep_middle: 22,
    pa_short: 9, pa_deep: 27, roll_strong: 8, roll_weak: 8, hail_mary: 48, rpo_strong: 4, rpo_weak: 4, trick_flea: 30, trick_pass: 16 };
  // Real NFL timing, in seconds after the snap: the snap reaches the QB in a quarter of a second; when the play
  // was not charted, passes come out 1.35 s (RPO) to 4.3 s (Hail Mary) after the snap (Next Gen Stats averages);
  // the ball flies about 24 yards a second (deep balls are lofted, a little slower); handoffs at 0.8-1.2 s.
  const T_SNAP = 0.25;
  const RELEASE = { quick: 2.3, screen: 1.6, deep: 2.8, pa: 3.0, roll: 3.0, hail: 4.3, rpo: 1.35, flea: 3.7, tpass: 3.3 };
  const flight = (air) => (Math.abs(air) + 7) / (25 - 0.09 * clip(air, 0, 60));              // seconds the ball is in the air
  const PLAY_SPEED = 1;        // real time, your snaps and theirs
  // the player's own speed-up (1x, 1.5x, 2x: the button on the field), kept on the device; a tap on the field skips
  const SPEEDS = [1, 1.5, 2], SPEED_KEY = `${STORE}:speed`;
  const playSpeed = () => { const v = Number(load(SPEED_KEY, 1)); return SPEEDS.includes(v) ? v : 1; };
  function speedBtn() {
    const b = $('speedBtn');
    if (!b) return;
    const show = () => { b.textContent = `${playSpeed()}\u00d7`; b.setAttribute('aria-label', `Play speed ${playSpeed()} times. Tap to change`); };
    show();
    b.hidden = false;
    b.addEventListener('click', () => {
      const v = SPEEDS[(SPEEDS.indexOf(playSpeed()) + 1) % SPEEDS.length];
      save(SPEED_KEY, v); show();
      toast(v === 1 ? 'Plays at real speed' : `Plays at ${v}\u00d7 speed. Tap the field to skip one`);
      track('play_speed', { speed: v });
    });
  }
  // the routes a call's target runs when the real play was not charted, and the routes the rest run
  const CALL_ROUTE = { quick: ['slant', 'out', 'hitch'], quick_middle: ['slant', 'cross', 'in'], screen: ['screen'],
    deep: ['go', 'post', 'corner', 'deep_out', 'in'], deep_middle: ['post', 'in', 'go'], pa: ['in', 'post', 'cross', 'deep_out'],
    roll: ['out', 'cross', 'corner'], hail: ['go'], rpo: ['slant', 'hitch', 'out'], flea: ['go', 'post'], tpass: ['go', 'post', 'corner'] };
  // the timing routes: how far past the break (yards along it) the ball meets him at the soonest (a hitch: at the end
  // of his step back to the ball)
  const BREAK_OUT = { hitch: 99, out: 2.5, deep_out: 2.5, in: 2 };
  const OTHER_ROUTES = { short: ['hitch', 'out', 'slant', 'cross', 'in'], deep: ['go', 'post', 'in', 'corner', 'deep_out', 'hitch'],
    hail: ['go'] };
  const GROUP = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL', T: 'OL', G: 'OL',
    EDGE: 'DL', DL: 'DL', LB: 'LB', CB: 'CB', S: 'S', K: 'QB', KC: 'LB', SZ: 'LB', KR: 'RB' };
  // seconds after the snap before the first step: the offense knows the count, the defense reacts to the ball
  // (tracking: receivers are still within half a yard of their stance half a second after the snap)
  const REACT_OFF = 0.18, REACT_DEF = 0.3;

  // where actor a is at play time t: on its simulated track, or (kickoff alignment, before a play) where it stands
  function at(a, t) {
    const k = a.trk;
    if (!k) return { x: a.x0, L: a.L0, w: a.w0 ?? 1 };
    const i = clip(t / k.dt, 0, k.n - 1), j = Math.floor(i), j2 = Math.min(j + 1, k.n - 1), u = i - j;
    const w = k.hold ? k.w0 : k.w0 * clip(1 - (t - k.wt) / 0.3, 0, 1);
    return { x: k.x[j] + (k.x[j2] - k.x[j]) * u, L: k.L[j] + (k.L[j2] - k.L[j]) * u, w };
  }
  function ballAt(sc, P, t) {
    let seg = null;
    for (const s of P.segs) if (s.t0 <= t + 1e-9) seg = s;
    if (!seg) return { x: sc.bx, L: sc.losL, z: 0, show: true };
    if (seg.kind === 'hold') { const p = at(seg.a, t); return { x: p.x + 5, L: p.L, z: 0, show: true }; }
    if (seg.kind === 'fly') {
      const u = clip((t - seg.t0) / Math.max(seg.t1 - seg.t0, 1e-6), 0, 1);
      return { x: lerp(seg.x0, seg.x1, u), L: lerp(seg.L0, seg.L1, u), z: seg.h * 4 * u * (1 - u), show: true };
    }
    return { x: seg.x, L: seg.L, z: 0, show: !seg.hide };
  }
  function cast(sc) {
    const off = sc.actors.filter((a) => a.off), def = sc.actors.filter((a) => !a.off);
    const is = (lab) => (a) => a.label === lab;
    return { off, def, qb: off.find(is('QB')), rb: off.find(is('RB')), fb: off.find(is('FB')), recv: off.filter((a) => a.label === 'WR' || a.label === 'TE'),
      ol: off.filter((a) => OL.includes(a.label) || a.label === 'T' || a.label === 'G'),
      rush: def.filter((a) => a.label === 'EDGE' || a.label === 'DL'), cover: def.filter((a) => a.label === 'CB' || a.label === 'S' || a.label === 'LB') };
  }

  function choreograph(sc, e, res, two) {
    const P = { T: 1, hold: 0.6, segs: [], calls: [], fx: [] };
    const act = res && res.action, mine = e.team === G.me;
    const dir = sc.dir, L0 = sc.losL, bx = sc.bx;
    const fwd = (L, y) => L + dir * y;
    const R = rng(hash('anim', e.row, e.t, e.yards, e.ev));
    const jit = (n) => (R() * 2 - 1) * n;
    const pickOf = (arr) => arr[Math.min(arr.length - 1, Math.floor(R() * arr.length))];
    const say = (t, text, kind, o) => P.calls.push({ t, text, kind, slot: 0, x: bx, L: L0, ...(o || {}) });
    const fly = (t0, t1, x0, La, x1, Lb, h) => P.segs.push({ t0, t1, kind: 'fly', x0, L0: La, x1, L1: Lb, h: h || 0 });
    const hold = (t0, a) => { if (a) P.segs.push({ t0, kind: 'hold', a }); };
    const rest = (t0, x, L, hide) => P.segs.push({ t0, kind: 'rest', x, L, hide });
    const fxAt = (t, f) => P.fx.push({ t, f });
    const down = (t, a) => { if (a) fxAt(t, () => a.g.classList.add('down')); };
    const ring = (t, a, on) => { if (a) fxAt(t, () => a.g.classList.toggle('carrier', on !== false)); };
    const K = cast(sc), qb = K.qb;
    const defName = teamName(code(1 - e.team));

    // ---- the world, in yards: x across the field as drawn (0 = the left sideline), y = L
    const FW = (SX1 - SX0) / XYD, yx = (p) => (p - SX0) / XYD, px = (x) => SX0 + x * XYD;
    const inX = (x) => clip(x, 1.4, FW - 1.4);
    const inL = (L) => clip(L, -9.4, 109.4);
    // a route that runs out at a sideline or the end line: he pulls up there (a route's end at full speed carries him on)
    // (a route not thrown to ends at a jog: the receiver settles where it ends instead of gliding on at full speed)
    const edgeStop = (pts) => { const q = pts[pts.length - 1]; return q[0] < 3 || q[0] > FW - 3 || q[1] < -7 || q[1] > 107 ? { v1: 0 } : { v1: 2.5 }; };
    const Wd = new Motion.World({ field: [0, FW] });
    sc.actors.forEach((a) => { a.trk = null; a.endAt = null; a.b = Wd.add({ id: a.label + (a.p && a.p.num), g: GROUP[a.label] || 'LB', x: yx(a.x0), y: a.L0, spd: 1 + jit(0.035), team: a.off ? 1 : 0 }); });
    const BX = yx(bx);
    let snapAt = 0, frozen = false;            // frozen: the play never started (a flag before the snap)
    const busy = new Set();                    // players with a part in the outcome
    const leg = (a, t, kind, o) => { if (a) Wd.leg(a.b, t, kind, o); };
    const plan = (a, pts, o) => Motion.planPath(pts, a.b.g, { spd: a.b.spd, ...(o || {}) });
    const follow = (a, t, pl) => { leg(a, t, 'path', { plan: pl }); return pl; };
    const here = (a) => [a.b.x, a.b.y];
    const vel = (a) => Math.hypot(a.b.vx, a.b.vy);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const toPx = (p) => ({ x: px(p[0]), L: p[1] });
    // a planned run from time t (the world is run up to it first: plans start where the player really is then),
    // carrying his momentum into the first step
    function runFrom(a, t, pts, o) {
      if (t > Wd.t + 1e-9) Wd.run(t);
      t = Math.max(t, Wd.t);
      const b = a.b, s = Math.hypot(b.vx, b.vy), st = [[b.x, b.y]];
      if (s > 1.2) {
        const k = Math.min(4, Math.max(1, s * 0.45)) / s, m = [b.x + b.vx * k, b.y + b.vy * k];
        st.push(o && o.lim ? o.lim(m) : m);          // (lim: a ball carrier's momentum never takes him past the spot)
      }
      return follow(a, t, plan(a, st.concat(pts.map((p) => [inX(p[0]), p[1]])), { v0: s, ...(o || {}) }));
    }
    const nearest = (list, p, skip) => {
      let best = null, bd = Infinity;
      (list || []).forEach((a) => { if (!a || (skip && skip.has(a))) return; const d = dist(here(a), p); if (d < bd) { bd = d; best = a; } });
      return best;
    };
    const foes = (a) => (a.off ? K.def : K.off);
    const tdL = () => (dir > 0 ? 103 : -3);                 // the end zone the offense is attacking
    const defTdL = () => (dir > 0 ? -3 : 103);              // the one behind it, where a defensive return scores
    // a turnover returned for a touchdown (the engine's outcome, whatever the real play's label): the man with the
    // ball runs it back to the end zone behind the offense, the offense chasing
    function returnTd(rec, t, from, call) {
      const pl = runFrom(rec, t, [[inX(from[0] + jit(8)), defTdL()]], { eff: 0.95 });
      foes(rec).forEach((d) => { if (d !== rec) leg(d, t + 0.3, 'chase', { who: rec.b, gap: 2, eff: 0.9 }); });
      say(t + pl.T, call, 'hit', { follow: rec });
      return t + pl.T;
    }
    const sidelineX = (x) => (x > FW / 2 ? FW + 0.6 : -0.6);
    const lastEnd = (t) => { P.T = Math.max(P.T, t); };

    // ---- the snap and the line
    // a spike or a kneel is taken under center: the quarterback lines up a yard behind the ball
    function underCenter() {
      if (!qb) return;
      qb.x0 = bx; qb.L0 = fwd(L0, -0.8);
      qb.b.x = yx(qb.x0); qb.b.y = qb.L0;
    }
    function snapToQb() {
      if (!qb) return;
      fly(0, T_SNAP, bx, L0, qb.x0, qb.L0, 0.15);
      hold(T_SNAP, qb);
    }
    // pass protection is a pocket (below); run blocking drives forward and toward the play side, pushing the
    // defensive line back
    const blockerOf = new Map();
    function lineplay(kind, side, rushers, o) {
      if (kind === 'pass' && K.ol.length) { pocket(rushers, o || {}); return; }
      const ol = K.ol.slice();
      ol.forEach((a) => {
        const x0 = a.b.x, y0 = a.b.y, tackle = a.label === 'LT' || a.label === 'RT';
        const lat = kind === 'run' ? side * (1.1 + jit(0.3)) : tackle ? Math.sign(x0 - BX) * 0.9 : jit(0.3);
        leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.9, fn: (t) => {
          const u = clip((t - REACT_OFF) / 1.6, 0, 1);
          return [x0 + lat * u, y0 + dir * Motion.curveShift(kind, 'OL', t)];
        } });
      });
      rushers.forEach((d) => {
        const blk = nearest(ol, here(d)) || nearest(K.off.filter((a) => a !== qb), here(d));
        if (!blk) return;
        blockerOf.set(d, blk);
        const sx = d.b.x, sy = d.b.y, dx = clip(sx - blk.b.x, -1.2, 1.2) * 0.5;
        leg(d, REACT_DEF, 'track', { gain: 3.2, eff: 0.95, fn: (t) => {
          const p = Wd.posAt(blk.b, t), u = clip((t - REACT_DEF) / 0.45, 0, 1);
          const ex = p[0] + dx, ey = p[1] + dir * 0.95;
          return [sx + (ex - sx) * u, sy + (ey - sy) * u];
        } });
      });
    }
    // Pass protection: a pocket round the passer's spot Q (7.2 yards deep, or o.q). Each rusher is met by the lineman
    // across from him (matched in order across the line, one each while there are enough; a spare one doubles the
    // nearest inside rusher), who stays between him and the passer a body's width off. Inside rushers push the pocket
    // in at the pace of the defensive line's depth curve from tracking (CURVES.pass.DL), each pair its own strength (a
    // doubled one held up), the pocket narrowing as it shrinks; edge rushers come upfield and bend round the tackles,
    // who kick-slide out and ride them past the passer's depth. A winner (o.win: rusher -> the time he is free: the
    // sacker, the pressure, the man who flushes a scrambler) gets to his blocker's shoulder by then (off the edge,
    // round the tackle's hip), then goes for the passer; the beaten man turns and chases. Every pair sways a little,
    // out of step with the others (hand fighting): a line moving as one block reads as a picture, not a play.
    const passRush = new Map();      // rusher -> (t) => [x, y, nx, ny]: where he is, and the way to him from the passer
    function pocket(rushers, o) {
      const ol = K.ol.slice().sort((a, b) => a.b.x - b.b.x), rs = rushers.slice().sort((a, b) => a.b.x - b.b.x);
      const Q = o.q || [BX, fwd(L0, -7.2)], win = o.win || new Map(), passer = o.passer || qb;
      const shift = (t) => Motion.curveShift('pass', 'DL', t), gDL = (t) => clip(-shift(t) / 4.5, 0, 1);
      const ease = (u) => { u = clip(u, 0, 1); return u * u * (3 - 2 * u); };
      const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
      const env = (t) => clip((t - 0.6) / 0.5, 0, 1);              // the sway starts once they are engaged
      // the matching: in order across the line, the least lateral distance in all
      const m = rs.length, n = ol.length, blk = new Array(m).fill(null);
      if (m <= n) {
        const C = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity));
        for (let j = 0; j <= n; j++) C[0][j] = 0;
        for (let i = 1; i <= m; i++) for (let j = i; j <= n; j++) C[i][j] = Math.min(C[i][j - 1], C[i - 1][j - 1] + Math.abs(rs[i - 1].b.x - ol[j - 1].b.x));
        for (let i = m, j = n; i > 0; j--) if (C[i][j] !== C[i][j - 1]) { blk[i - 1] = ol[j - 1]; i--; }
      }
      // the lineman's own set (before the rusher gets to him): tackles kick out and back, the inside men a short set
      const setOf = (a) => {
        const x0 = a.b.x, y0 = a.b.y, tackle = a === ol[0] || a === ol[n - 1], out = Math.sign(x0 - Q[0]) || 1;
        return (t) => [x0 + (tackle ? out * 0.9 * clip((t - REACT_OFF) / 0.8, 0, 1) : 0), y0 + dir * Motion.curveShift('pass', 'OL', t) * (tackle ? 1.3 : 0.8)];
      };
      // a blocker on a rusher: from his set into contact (the gap closing from where they started to a body's width),
      // on the line from the rusher to the passer turned by `turn` (a lean, a double team's side, a man beaten)
      const engage = (a, at, d0, turn) => {
        const own = setOf(a);
        return (t) => {
          const P = at(t), v = turn(t, [P[2], P[3]]), u = ease((t - 0.3) / 0.7), gap = d0 + (0.9 - d0) * ease((t - 0.25) / 0.8);
          const q = own(t), c = [P[0] - v[0] * gap, P[1] - v[1] * gap];
          return [q[0] + (c[0] - q[0]) * u, q[1] + (c[1] - q[1]) * u];
        };
      };
      const pairs = [];
      rs.forEach((d, i) => {
        const b = blk[i];
        if (!b) return;
        blockerOf.set(d, b);
        const x0 = d.b.x, s = Math.sign(x0 - Q[0]) || Math.sign(b.b.x - BX) || 1;
        pairs.push({ d, b, s, edge: (b === ol[0] || b === ol[n - 1]) && s * (x0 - b.b.x) > -0.3, tw: win.get(d), ph: R() * 6.28, w: 3.5 + R() * 2,
          k: 0.75 + R() * 0.35, sw: R() < 0.5 ? -1 : 1, help: [] });
      });
      // a spare lineman doubles the nearest inside rusher (who is held up the more for it); with nobody near, he sets
      const spare = ol.filter((a) => !pairs.some((p) => p.b === a));
      spare.forEach((a) => {
        const p = pairs.filter((q) => !q.edge && !q.help.length && Math.abs(q.d.b.x - a.b.x) < 3.4).sort((x, y) => Math.abs(x.d.b.x - a.b.x) - Math.abs(y.d.b.x - a.b.x))[0];
        if (p) { p.help.push(a); p.k *= 0.75; } else leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.9, fn: setOf(a) });
      });
      pairs.forEach((p) => {
        const { d, s, edge, tw, ph, w } = p, x0 = d.b.x, y0 = d.b.y, won = tw != null;
        let at;
        if (edge) {
          // round the corner: from the passer, his distance shrinks with the line's depth curve and his angle opens
          // (later: upfield first, then the bend) from where he lined up to level with the passer or past him
          const lat0 = s * (x0 - Q[0]), dep0 = dir * (y0 - Q[1]), R0 = Math.hypot(lat0, dep0), th0 = Math.atan2(lat0, dep0);
          const Re = won ? 3.4 : 4.8 + R(), thE = ((won ? 92 : 60 + R() * 24) * Math.PI) / 180;
          at = (t) => {
            const u = won ? ease((t - REACT_DEF) / (tw - REACT_DEF)) : gDL(Math.min(t, 3)), e_ = env(t);
            const th = th0 + (thE - th0) * Math.pow(u, 1.5) + 0.05 * Math.sin(w * t + ph) * e_, r = R0 + (Re - R0) * u + 0.2 * Math.sin(0.7 * w * t + ph * 1.7) * e_;
            const nx = s * Math.sin(th), ny = dir * Math.cos(th);
            return [Q[0] + nx * r, Q[1] + ny * r, nx, ny];
          };
        } else {
          // straight ahead: pushed back on the curve (never closer than 2.6 yards to the passer's spot unless he wins),
          // closing in toward the middle as the pocket shrinks
          const lat0 = x0 - Q[0], dep0 = dir * (y0 - L0), floor = dir * (Q[1] - L0) + (won ? 1.6 : 2.6), k = p.k * (won ? 1.2 : 1);
          at = (t) => {
            const e_ = env(t), u = gDL(t);
            const x = Q[0] + lat0 * (1 - 0.3 * u) + 0.25 * Math.sin(w * t + ph) * e_;
            const y = L0 + dir * Math.max(floor, dep0 + k * shift(t) + 0.15 * Math.sin(0.7 * w * t + ph * 1.7) * e_);
            const [nx, ny] = unit(x - Q[0], y - Q[1]);
            return [x, y, nx, ny];
          };
        }
        passRush.set(d, at);
        leg(d, REACT_DEF, 'track', { gain: 3.2, eff: 0.95, fn: at });
        // his blocker: square to him, leaning a little each way; beaten, turned (off the edge: the rusher is round his
        // hip, the blocker upfield of him; inside: the rusher at his shoulder) so the way to the passer is open
        const d0 = Math.max(0.9, dist(here(d), here(p.b)));
        const turn = (t, v) => {
          if (!won) return rot(v, 0.2 * Math.sin(0.8 * w * t + ph * 2.3) * env(t));
          const a = (edge ? 1.65 : 1.4) * ease((t - (tw - 0.75)) / 0.75);
          if (!edge) return rot(v, a * p.sw);
          const v1 = rot(v, a), v2 = rot(v, -a);
          return dir * v1[1] < dir * v2[1] ? v1 : v2;
        };
        leg(p.b, REACT_OFF, 'track', { gain: 3, eff: 0.9, fn: engage(p.b, at, d0, turn) });
        // the double team: beside the first man, on the spare's side of the rusher
        p.help.forEach((a) => {
          const sg = Math.sign(a.b.x - d.b.x) || 1, hd0 = Math.max(0.95, dist(here(d), here(a)));
          leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.85, fn: engage(a, at, hd0, (t, v) => { const r1 = rot(v, 1.05), r2 = rot(v, -1.05); return sg * r1[0] < sg * r2[0] ? r1 : r2; }) });
        });
        if (won) {
          leg(d, tw, 'chase', { who: passer.b, gap: 0.9, eff: 1, lead: 0.3 });
          leg(p.b, tw + 0.15, 'chase', { who: d.b, gap: 1.1, eff: 0.6, lead: 0 });
          p.help.forEach((a) => leg(a, tw + 0.25, 'go', { x: here(a)[0], y: fwd(here(a)[1], -0.6), eff: 0.4 }));
        }
      });
      // more rushers than linemen (a goal-line front): the extra men a yard off the nearest blocker, as he gives ground
      rs.forEach((d, i) => {
        if (blk[i]) return;
        const b = nearest(ol, here(d));
        if (!b) return;
        blockerOf.set(d, b);
        const sx = d.b.x, sy = d.b.y, dx = clip(sx - b.b.x, -1.2, 1.2) * 0.5;
        leg(d, REACT_DEF, 'track', { gain: 3.2, eff: 0.95, fn: (t) => {
          const q = Wd.posAt(b.b, t), u = clip((t - REACT_DEF) / 0.45, 0, 1);
          return [sx + (q[0] + dx - sx) * u, sy + (q[1] + dir * 0.95 - sy) * u];
        } });
      });
    }
    // after the whistle: everyone eases up; those close by drift toward the pile
    function whistle(t, pile) {
      sc.actors.forEach((a) => {
        if (busy.has(a)) return;
        const p = here(a), d = pile ? dist(p, pile) : 99;
        const t1 = t + 0.1 + R() * 0.35;
        if (pile && d < 14 && d > 2.5) {
          const k = (d - 2.2 - R() * 1.5) / d;
          leg(a, t1, 'go', { x: p[0] + (pile[0] - p[0]) * k, y: p[1] + (pile[1] - p[1]) * k, eff: 0.32 });
        } else leg(a, t1, 'stand');
      });
    }

    // ---- the run after the catch, the run, the return: the ball carrier runs to the end of the play. The
    // defender who can get to him first meets him a yard or two short of the spot, coming at a pursuit angle, and
    // drives him to it; a second one arrives just after; the rest chase, holding off until the tackle; his
    // teammates block the nearest chasers. Returns the time the play ends.
    function runDown(car, t0, endPt, o) {
      o = o || {};
      Wd.run(t0);
      t0 = Wd.t;
      busy.add(car);
      // the tackler comes from the defenders still free; when every one is busy (in coverage, on the ball), from all of
      // them: a carrier never stops in the open with nobody there (players saw it)
      const free = foes(car).filter((d) => !busy.has(d));
      const start = here(car), defs = free.length ? free : foes(car);
      const tackled = !o.td && !o.oob && !o.free;
      const after0 = tackled ? (o.after ?? (car.label === 'RB' || car.label === 'QB' ? 1.5 + R() : 0.6 + R() * 0.8)) : 0;
      // a short run after the catch with nobody close: he works sideways toward the nearest man, who comes up to
      // make the tackle at the same yard line (never a carrier going down alone in the open; players saw it)
      if (tackled && !o.oob && defs.length && dist(start, endPt) < 4) {
        const near_ = defs.slice().sort((a, b) => dist(here(a), endPt) - dist(here(b), endPt))[0], q = here(near_);
        if (dist(q, endPt) > 3) endPt[0] = inX(endPt[0] + clip((q[0] - endPt[0]) * 0.55, -7, 7));
      }
      // to daylight: the middle of the run bends away from where the defense is headed
      const pts = [];
      const span = dist(start, endPt);
      // (forward progress: nothing in his run goes past the spot)
      const fd = car.off ? dir : -dir;          // his forward (a return goes the other way)
      const short = (y) => (o.td ? y : fd > 0 ? Math.min(y, endPt[1]) : Math.max(y, endPt[1]));
      if (span > 7 && !o.straight) {
        const tm = Math.min(1.2, span / 14), mid = [start[0] + (endPt[0] - start[0]) * 0.55, start[1] + (endPt[1] - start[1]) * 0.55];
        const [ux, uy] = unit(endPt[0] - start[0], endPt[1] - start[1]);
        let best = mid, bs = -1;
        [-3, -1.5, 0, 1.5, 3].forEach((off) => {
          const c = [inX(mid[0] - uy * off), short(mid[1] + ux * off * 0.2)];
          const m = Math.min(99, ...defs.map((d) => dist(c, [d.b.x + d.b.vx * tm, d.b.y + d.b.vy * tm])));
          const s = Math.min(m, 6) - Math.abs(off) * 0.4;
          if (s > bs) { bs = s; best = c; }
        });
        pts.push(best);
      }
      const ref = pts.length ? pts[0] : start;
      let [ex, ey] = unit(endPt[0] - ref[0], endPt[1] - ref[1]);
      // forward progress: once he is hit he is driven forward to the spot or goes down sideways at it, never back
      // (the ball is spotted where his forward progress stopped), and he is never met behind where he already got to
      let after = after0;
      if (tackled) {
        const room = fd * (endPt[1] - ref[1]) - 0.2;
        if (fd * ey > 0.25) after = Math.min(after, Math.max(0, room) / (fd * ey));
        if (fd * ey <= 0.25 || after < 0.5) { ex = Math.sign(endPt[0] - ref[0]) || (endPt[0] < FW / 2 ? 1 : -1); ey = 0; after = Math.min(after0, 0.6 + R() * 0.4); }
      }
      // (inside the sideline, as every run is: the pile below starts where his run ended)
      let contact = tackled ? [inX(endPt[0] - ex * after), endPt[1] - ey * after] : endPt;
      let route = dist(start, contact) > 0.6 ? pts.concat([contact]) : [contact];
      // forward progress: his momentum carries him to where he is met at most (the spot, when nobody meets him)
      const lim = o.td ? null : (p) => { const yy = tackled ? contact[1] : endPt[1]; return [p[0], fd > 0 ? Math.min(p[1], yy) : Math.max(p[1], yy)]; };
      const runO = { eff: o.eff ?? 0.97, v1: tackled ? 3.4 : undefined, lim };
      let A = runFrom(car, t0, route, runO);
      let tC = t0 + A.T;
      // who gets there: the defender with the shortest time to the contact point, from where he is now
      // (from where he is, carrying his momentum the way runFrom does: a man going full speed the other way first
      // has to turn, so he is slower to get there than from a standing start)
      const reachTo = (pt) => defs.map((d) => {
        const p = here(d), s = vel(d), st = [p];
        if (s > 1.2) { const k = Math.min(4, Math.max(1, s * 0.45)) / s; st.push([d.b.x + d.b.vx * k, d.b.y + d.b.vy * k]); }
        return { d, T: Motion.minTime(st.concat([pt]), d.b.g, { v0: s, spd: d.b.spd }) };
      }).sort((x, y) => x.T - y.T);
      let reach = reachTo(contact);
      // stopped at or behind the line, and nobody can get there from where the defense is now: a defender beat his
      // block. Back at the handoff, the one who can best make it is sent through the line, timed to meet him there
      // (a stuff is penetration, not a back waiting in the backfield for someone to come)
      if (tackled && o.from != null && o.from < t0 - 0.1 && reach.length && reach[0].T > tC - t0 + 0.1
        && fd * (contact[1] - L0) < 1.5) {
        const tf = Math.max(o.from, REACT_DEF + 0.2);
        Wd.rewind(tf);
        const pick = defs.filter((d) => d.b.g !== 'CB').map((d) => ({ d, T: Motion.minTime([here(d), contact], d.b.g, { v0: vel(d), spd: d.b.spd }) }))
          .sort((x, y) => x.T - y.T)[0];
        if (pick) {
          runFrom(pick.d, tf, [contact], { T: Math.max(pick.T, tC - tf - 0.15) });
          leg(pick.d, tC + 0.05, 'stick', { who: car.b, dx: 0, dy: fd * 0.7 });
        }
        Wd.run(t0);
        A = runFrom(car, t0, route, runO);
        tC = t0 + A.T;
        reach = reachTo(contact);
        if (pick) {
          const me = reach.find((r) => r.d === pick.d);
          if (me) reach = [me].concat(reach.filter((r) => r !== me));                // he is the tackler
        }
      }
      // nobody can get there in time: he doesn't wait for them. He bounces wider at full speed, toward the sideline he
      // is headed for (else the other), and the pursuit runs him down at the same yard line, the spot the result gives
      // (where across the field he goes down is the animation's to choose; a back slowing in open space is not football)
      if (tackled && reach.length && reach[0].T > tC - t0 + 0.1 && !o.straight) {
        const lean = Math.sign(contact[0] - start[0]) || (contact[0] < FW / 2 ? -1 : 1);
        let done = false;
        for (const sh of [3, 6, 9, 12, 16]) {
          for (const side of [lean, -lean]) {
            const c2 = [inX(contact[0] + side * sh), contact[1]];
            if (Math.abs(c2[0] - contact[0]) < sh - 0.5) continue;             // past the sideline that way
            const r2 = (pts.length ? [[inX(pts[0][0] + side * sh * 0.4), pts[0][1]]] : []).concat([c2]);
            const A2 = runFrom(car, t0, r2, runO), re2 = reachTo(c2);
            if (re2.length && re2[0].T <= A2.T + 0.1) {
              endPt[0] = inX(endPt[0] + side * sh); contact = c2; route = r2; A = A2; tC = t0 + A2.T; reach = re2; done = true;
              break;
            }
          }
          if (done) break;
        }
        if (!done) A = runFrom(car, t0, route, runO);                              // (back to his own run)
      }
      car.endAt = endPt;
      let tackler = null, tEnd = tC, tGo = t0, B = null;
      if (tackled && reach.length) {
        tackler = reach[0].d;
        if (reach[0].T > tC - t0 + 0.1) {            // still nobody (the field ran out): he slows in traffic
          A = runFrom(car, t0, route, { T: reach[0].T + 0.1, v1: 3.4, lim });
          tC = t0 + A.T;
        }
        busy.add(tackler);
        // the pile: driven from the contact point to the spot
        B = plan(car, [contact, endPt], { v0: 3.4, v1: 0, eff: 0.32 });
        follow(car, tC, B);
        tEnd = tC + Math.max(B.T, 0.25);
        // he goes at the right moment (a lineman, slow off his block, goes at once)
        // (he commits at once on a timed path to the meeting point, which he can make: a late start left him short)
        tGo = t0;
        // until he goes, he closes on the play
        if (tGo > t0 + 0.05) leg(tackler, t0 + 0.15, 'chase', { who: car.b, gap: 4, eff: 0.6, lead: 1 });
        // a second man in, just after
        const two_ = reach.find((r) => r.d !== tackler && r.T < tEnd - t0 + 0.6);
        if (two_) {
          busy.add(two_.d);
          const q = here(two_.d), [qx, qy] = unit(endPt[0] - q[0], endPt[1] - q[1]);
          runFrom(two_.d, t0, [[endPt[0] - qx * 1.0, endPt[1] - qy * 1.0]], { T: Math.max(0.4, tEnd - t0 + 0.12) });
          leg(two_.d, tEnd + 0.3, 'stand');
        }
      } else if (o.oob && reach.length && reach[0].T < tC - t0 + 0.3) {
        // forced out: someone runs him to the sideline
        tackler = reach[0].d;
        busy.add(tackler);
        const q = here(tackler), [qx, qy] = unit(endPt[0] - q[0], endPt[1] - q[1]);
        runFrom(tackler, t0, [[endPt[0] - qx * 1.2, endPt[1] - qy * 1.2]], { T: Math.max(0.4, tC - t0 + 0.05) });
        leg(tackler, tC + 0.25, 'stand');
        tackler = null;
      }
      // the broken tackle: a defender gets a hand on him at the middle of the run and misses
      if (o.bt && tackled && tC - t0 > 0.9) {
        const tb = t0 + (tC - t0) * 0.45, pc = A.at(tb - t0), [vx, vy] = unit(pc[2], pc[3]);
        const miss = nearest(foes(car).filter((d) => !busy.has(d)), [pc[0], pc[1]]);
        if (miss) {
          busy.add(miss);
          runFrom(miss, t0, [[pc[0] + vy * 0.9, pc[1] - vx * 0.9]], { T: tb - t0 });
          leg(miss, tb + 0.05, 'go', { x: pc[0] + vy * 1.6 - vx * 1.5, y: pc[1] - vx * 1.6 - vy * 1.5, eff: 0.5 });
          leg(miss, tb + 0.6, 'stand');
          down(tb + 0.15, miss);
        }
        say(tb, 'Broken tackle!', 'boom', { follow: car });
      }
      // everyone else: chase (holding off), or block a chaser; at the end, ease up
      foes(car).forEach((d) => {
        if (busy.has(d)) return;
        leg(d, t0 + 0.15 + R() * 0.35, 'chase', { who: car.b, gap: 1.8 + R(), eff: 0.82 + R() * 0.18, lead: 1 });
      });
      const mates = (car.off ? K.off : K.def).filter((m) => m !== car && !busy.has(m));
      mates.forEach((m) => {
        const d = dist(here(m), start);
        if (m.b.g === 'OL' || m.b.g === 'DL' || m.b.g === 'QB') {      // linemen finish their blocks; the passer watches
          const p = here(m);
          leg(m, t0 + 0.3 + R() * 0.5, 'go', { x: p[0] + (endPt[0] - p[0]) * 0.1, y: p[1] + dir * (car.off ? 1.5 + R() * 2 : -(1.5 + R() * 2)), eff: 0.3 });
          return;
        }
        if (d < 14) {
          const foe = nearest(foes(car), here(m), new Set([tackler]));
          if (foe) leg(m, t0 + 0.2 + R() * 0.3, 'chase', { who: foe.b, gap: 0.9, eff: 0.7 + R() * 0.2, lead: 0.6 });
        } else leg(m, t0 + 0.3, 'go', { x: here(m)[0] + (endPt[0] - here(m)[0]) * 0.3, y: here(m)[1] + (endPt[1] - here(m)[1]) * 0.3, eff: 0.45 });
      });
      // the tackler goes at the right moment, at a pursuit angle to the meeting point, and drives him to the spot
      if (tackler && B) {
        Wd.run(tGo);
        const p = here(tackler), [cx, cy] = unit(contact[0] - p[0], contact[1] - p[1]);
        runFrom(tackler, Wd.t, [[contact[0] - cx * 0.7, contact[1] - cy * 0.7]], { T: Math.max(0.2, tC - Wd.t) });
        leg(tackler, tC, 'stick', { who: car.b, dx: -cx * 0.75, dy: -cy * 0.75, ease: 0.2 });
        leg(tackler, tEnd + 0.05, 'stand');
      }
      Wd.run(tEnd);
      // (tests: forward progress. How far past the spot he ever had the ball, beyond where he got it)
      if (window.__sepLog && !o.td) {
        const t1 = Math.min(o.from ?? t0, t0), fp = (t) => fd * (Wd.posAt(car.b, t)[1] - endPt[1]);
        let mx = -99;
        for (let t = t1; t <= tEnd + 1e-9; t += 0.05) mx = Math.max(mx, fp(t));
        (window.__fpLog = window.__fpLog || []).push({ over: +(mx - Math.max(0, fp(t1))).toFixed(2), car: car.label, off: !!car.off, oob: !!o.oob, yds: e.yards, ev: e.evt || '', call: e.call });
      }
      // (tests: how close the nearest defender is when a tackled carrier goes down)
      if (tackled && window.__sepLog) (window.__tackleLog = window.__tackleLog || []).push({ nd: Math.min(...foes(car).map((d) => dist(here(d), here(car)))), free: free.length, tackler: !!tackler,
        td: dist(tackler ? here(tackler) : [0, 0], here(car)), car: car.label, mine: !!car.off === !!(car.off && G.root.pos === G.me), span: dist(start, endPt), tC: tC - t0, reach: reach.length ? reach[0].T : null });
      if (tackled) leg(car, tEnd, 'stand');
      else leg(car, tEnd, 'go', { x: endPt[0] + (o.oob ? Math.sign(endPt[0] - FW / 2) * 1.5 : 0), y: endPt[1] + dir * (o.td ? 1.5 : 1), eff: 0.4 });
      whistle(tEnd, here(car));
      return tEnd;
    }
    // how the ball carrier's play ends: the call-outs, a fumble
    function finish(car, tEnd, xyEnd) {
      xyEnd = car.endAt || xyEnd;                  // (where runDown put the spot across the field)
      const fumble = !e.td && ['fumble_lost', 'fumble_kept', 'scoop_score'].includes(e.evt);
      let t = tEnd;
      if (e.td) say(tEnd, two ? 'Two-point try good!' : 'Touchdown!', 'good', { follow: car });
      else if (e.safety) say(tEnd, 'Safety!', 'hit', { follow: car });
      else if (fumble) {
        const lost = e.evt !== 'fumble_kept';
        say(tEnd, 'Fumble!', 'hit', { follow: car });
        const f = [inX(xyEnd[0] + jit(2.5)), xyEnd[1] + dir * 1.2];
        fly(tEnd, tEnd + 0.55, px(xyEnd[0]), xyEnd[1], px(f[0]), f[1], 0.3);
        rest(tEnd + 0.55, px(f[0]), f[1]);
        Wd.run(tEnd);
        const rec = lost ? nearest(foes(car), f) : nearest((car.off ? K.off : K.def).filter((m) => m !== car), f) || car;
        if (rec) {
          busy.add(rec);
          t = tEnd + 0.12 + runFrom(rec, tEnd + 0.1, [f], { T: 0.6, v1: 0 }).T;      // he has it when he gets to it
          hold(t, rec);
          if (lost && e.tdDef) t = returnTd(rec, t, f, 'Scoop and score!');
          else {
            leg(rec, t, 'stand');
            say(t, lost ? `${defName} ball` : 'Recovered', lost ? 'hit' : 'info', { slot: 1, follow: rec });
          }
        }
        t += 0.2;
      } else if (e.oob) {
        say(tEnd, 'Out of bounds', 'info', { follow: car });
        // he pulls up past the sideline; the ball goes back to where he went out (an official's toss to the spot)
        Wd.run(tEnd + 0.5);
        const q = here(car);
        if (dist(q, xyEnd) > 0.8) { fly(tEnd + 0.5, tEnd + 0.9, px(q[0]), q[1], px(xyEnd[0]), xyEnd[1], 0.12); rest(tEnd + 0.9, px(xyEnd[0]), xyEnd[1]); t = tEnd + 0.2; }
      }
      else {
        // the call-out from the play's own yards (as the play-by-play has it), the size of a loss said
        const lossOf = Math.round(-(e.yards || 0));
        say(tEnd, lossOf >= 1 ? `Stopped for a loss of ${lossOf}` : two ? 'Stopped short' : 'Tackled', 'info', { follow: car });
        down(tEnd + 0.08, car);
      }
      if (e.fd && !e.td) say(tEnd + 0.35, 'First down', 'good', { slot: 1, follow: car });
      if (e.onDowns) say(tEnd + 0.35, 'Turnover on downs', 'hit', { slot: 1, follow: car });
      lastEnd(t + 1.1);
      return t;
    }

    // ---- the pass
    function pickTarget(id, sign) {
      if (e.who === 'RB' || id === 'screen') return K.rb || K.recv[0];
      const side = (a) => (sign ? sign * (a.x0 - bx) > 0 : true);
      const nearBall = (list) => list.slice().sort((a, b) => Math.abs(a.x0 - bx) - Math.abs(b.x0 - bx))[0];
      if (e.who === 'TE') return nearBall(K.recv.filter((a) => a.label === 'TE' && side(a))) || K.recv.find((a) => a.label === 'TE') || K.recv[0];
      const wr = K.recv.filter((a) => a.label === 'WR');
      const pool = (wr.length ? wr : K.recv).filter(side);
      const all = pool.length ? pool : (wr.length ? wr : K.recv);
      if (!all.length) return K.rb;
      const out = all.slice().sort((a, b) => Math.abs(b.x0 - bx) - Math.abs(a.x0 - bx));
      return id.startsWith('deep') || id === 'pa_deep' || id === 'hail_mary' ? out[0] : out[out.length - 1];
    }
    const passKind = (id) => (id.startsWith('quick') ? 'quick' : id === 'screen' ? 'screen' : id.startsWith('deep') ? 'deep'
      : id.startsWith('pa_') ? 'pa' : id.startsWith('roll') ? 'roll' : id === 'hail_mary' ? 'hail' : id.startsWith('rpo') ? 'rpo'
        : id === 'trick_flea' ? 'flea' : id === 'trick_pass' ? 'tpass' : 'quick');
    // the coverage shell: as charted, or drawn as often as defenses play each
    function shellOf() {
      if (e.shell && Motion.SHELLS[e.shell]) return e.shell;
      if (e.man === true) return pickOf(['cover1', 'cover1', 'cover1', '2man', 'cover0']);
      let u = R(), acc = 0;
      for (const [s, p] of Motion.SHELL_SHARE) { acc += p; if (u <= acc) return s; }
      return 'cover3';
    }
    // a field landmark ([x from the offense's left, depth]) on the drawn field
    const mark = (m) => [dir > 0 ? m[0] : FW - m[0], fwd(L0, m[1])];
    // the rushers: as many as charted (default four; a blitz look sends five), linemen first
    function rushersOf(n) {
      const order = K.rush.concat(K.def.filter((d) => d.label === 'LB'), K.def.filter((d) => d.label === 'S'), K.def.filter((d) => d.label === 'CB'));
      const lbs = order.slice(K.rush.length).sort((a, b) => Math.abs(a.x0 - bx) - Math.abs(b.x0 - bx));
      return K.rush.concat(lbs).slice(0, clip(n, 3, 8));
    }
    // every receiver's route and every defender's job, from the snap until the ball is thrown
    function passShape(o) {
      const { kind, tgt, catchPt, tThrow, tCatch, rushers, shell, side, qbSpot } = o;
      const man = Motion.MAN[shell];
      const others = K.recv.filter((a) => a !== tgt && a !== o.passer);
      const runners = [];                     // [actor, route plan] for coverage to read
      others.forEach((a, i) => {
        const yours = mine && act && act.routes && eligibles(sc).indexOf(a) >= 0;    // you gave him a route: he runs it
        if (a.label === 'TE' && (rushers.length >= 6 || (!yours && R() < 0.3))) {        // stays in to block
          const edge = nearest(K.rush, here(a)), at = edge && passRush.get(edge);
          // (on a rusher in the pocket: beside his blocker, on the outside of him)
          if (at) {
            const out = Math.sign(a.b.x - BX) || 1, s0 = here(a), rot = (v, k) => [v[0] * 0.5 - v[1] * 0.866 * k, v[0] * 0.866 * k + v[1] * 0.5];
            leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.8, fn: (t) => {
              const P = at(t), v1 = rot([P[2], P[3]], 1), v2 = rot([P[2], P[3]], -1), v = out * v1[0] < out * v2[0] ? v1 : v2;
              const u = clip((t - REACT_OFF) / 0.8, 0, 1), q = [P[0] - v[0] * 0.95, P[1] - v[1] * 0.95];
              return [s0[0] + (q[0] - s0[0]) * u, s0[1] + (q[1] - s0[1]) * u];
            } });
          } else leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.8, fn: (t) => { const q = edge ? Wd.posAt(edge.b, t) : here(a); return [q[0], q[1] - dir * 0.95]; } });
          return;
        }
        const ei = mine && act && act.routes ? eligibles(sc).indexOf(a) : -1;
        const name = ei >= 0 && act.routes[ei] ? act.routes[ei] : kind === 'hail' ? 'go' : pickOf(kind === 'deep' || kind === 'pa' ? OTHER_ROUTES.deep : OTHER_ROUTES.short);
        const D = (ROUTE_DEPTH[name] ?? 6) + (name === 'go' ? 2 : name === 'post' || name === 'corner' ? 1 : 0) + jit(2);
        const out = ei >= 0 ? outOf(sc, a) : Math.sign(a.b.x - BX) || side || 1;
        const r = Motion.routeOnField(name, D, a.b.x, out, dir, L0, Math.abs(a.b.y - L0), R());
        const rp = r.pts.map((p) => [inX(p[0]), inL(p[1])]);
        const pl = follow(a, REACT_OFF, plan(a, rp, { eff: 0.86 + R() * 0.1, ...edgeStop(rp) }));
        runners.push([a, pl]);
        leg(a, Math.max(tCatch, tThrow + 0.5) + 0.3 + R() * 0.4, 'stand');
      });
      // the back: blocks when they send five or more, else checks out into the flat
      if (K.rb && K.rb !== tgt && kind !== 'pa' && kind !== 'flea' && !(kind === 'tpass' && (o.passer === K.rb || e.philly))) {
        if (rushers.length >= 5) {
          const blitzer = rushers[rushers.length - 1];
          leg(K.rb, REACT_OFF, 'track', { gain: 2.6, eff: 0.85, fn: (t) => {
            const q = Wd.posAt(blitzer.b, t), Q = qbSpot(t);
            return [Q[0] + (q[0] - Q[0]) * 0.5, Q[1] + (q[1] - Q[1]) * 0.5];
          } });
        } else {
          const ei = mine && act && act.routes ? eligibles(sc).indexOf(K.rb) : -1;
          const rbRoute = ei >= 0 && act.routes[ei] ? act.routes[ei] : 'flat';
          const out = ei >= 0 ? outOf(sc, K.rb) : Math.sign(K.rb.b.x - BX) || side;
          const r = Motion.routeOnField(rbRoute, ROUTE_DEPTH[rbRoute] ?? 0, K.rb.b.x, out, dir, L0, Math.abs(K.rb.b.y - L0), R());
          const rp = r.pts.map((p) => [inX(p[0]), inL(p[1])]);
          follow(K.rb, 1.3, plan(K.rb, rp, { eff: 0.75, ...edgeStop(rp) }));
        }
      }
      // coverage: man (trail him a beat behind, a cushion deep) or zone (drop to the landmark), then break on the ball
      const cover = K.def.filter((d) => !rushers.includes(d));
      const recvs = K.recv.concat(K.rb && K.rb !== tgt && rushers.length < 5 ? [K.rb] : []).concat(K.rb === tgt ? [K.rb] : []);
      const S_ = Motion.SHELLS[shell] || Motion.SHELLS.cover3;
      const assigned = new Map();
      if (man) {
        const deepN = S_.deep.length, safeties = cover.filter((d) => d.label === 'S');
        const deepers = safeties.slice(0, deepN);
        deepers.forEach((d, i) => { assigned.set(d, null); leg(d, REACT_DEF, 'go', { ...xy(mark(S_.deep[i])), eff: 0.8 }); });
        const pool = cover.filter((d) => !deepers.includes(d));
        const order = recvs.slice().sort((a, b) => Math.abs(b.b.x - BX) - Math.abs(a.b.x - BX));
        order.forEach((r) => {
          const pref = r.label === 'WR' ? ['CB', 'S', 'LB'] : r.label === 'TE' ? ['S', 'LB', 'CB'] : ['LB', 'S', 'CB'];
          let d = null;
          for (const lab of pref) { d = nearest(pool.filter((x) => x.label === lab && !assigned.has(x)), here(r)); if (d) break; }
          if (!d) return;
          assigned.set(d, r);
          // off coverage: he holds the depth he lined up at, backpedalling (corners and safeties bail at the snap:
          // tracking has corners 1 yard deeper after a second), until the receiver gets to him, then runs with him
          // a beat behind and a cushion over the top, inside leverage; he never comes across the line
          const inside = Math.sign(BX - r.b.x) || 1, db = d.label === 'CB' || d.label === 'S';
          leg(d, REACT_DEF, 'mirror', { who: r.b, lag: 0.28 + R() * 0.12, dir, los: L0, floor: 0.8, tau: 1.0, y0: d.b.y,
            pedal: db ? 1.5 : 0.4, pedalMax: db ? 3 : 1.5, cush: r.label === 'WR' ? 1.4 : 0.9, dx0: d.b.x - r.b.x, dx: inside * 0.7, eff: 0.97 });
        });
        pool.filter((d) => !assigned.has(d)).forEach((d) => {       // the spare: a robber in the middle; a lineman sits short
          if (d.label === 'DL' || d.label === 'EDGE') { leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: fwd(L0, 3.5), eff: 0.6 }); return; }
          const m = S_.under[0] ? mark(S_.under[0]) : [BX, fwd(L0, 7)];
          leg(d, REACT_DEF, 'go', { x: m[0] + jit(2), y: m[1], eff: 0.6 });
        });
      } else {
        const deepPool = cover.filter((d) => d.label === 'S').concat(cover.filter((d) => d.label === 'CB'));
        const deepMarks = S_.deep.map(mark), underMarks = S_.under.map(mark);
        const used = new Set();
        deepMarks.forEach((m) => {
          const d = nearest(deepPool.filter((x) => !used.has(x)), m);
          if (d) { used.add(d); leg(d, REACT_DEF, 'go', { x: m[0], y: m[1], eff: 0.85 }); }
        });
        underMarks.forEach((m) => {
          const d = nearest(cover.filter((x) => !used.has(x)), m);
          if (d) { used.add(d); leg(d, REACT_DEF, 'go', { x: m[0] + jit(1.5), y: m[1] + jit(1), eff: 0.75 }); }
        });
        cover.filter((d) => !used.has(d)).forEach((d) => leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: d.label === 'DL' || d.label === 'EDGE' ? fwd(L0, 3.5) : fwd(d.b.y, 3), eff: 0.6 }));
        // a deep defender carries the vertical in his area: after his drop he runs with the deepest route near him,
        // a cushion over the top (never deep men running free while the ball goes short; players saw it). Tighter
        // when the throw is short: the coverage downfield is why the ball went underneath
        const shortThrow = Math.abs(catchPt[1] - L0) <= 6;
        const deepers = deepMarks.length ? [...used].filter((d) => deepPool.includes(d)).slice(0, deepMarks.length) : [];
        const taken = new Set();
        runners.map(([a, pl]) => ({ a, end: pl.at(pl.T) })).filter((x) => Math.abs(x.end[1] - L0) > 12)
          .sort((x, y) => Math.abs(y.end[1] - L0) - Math.abs(x.end[1] - L0))
          .forEach(({ a, end }) => {
            // (more verticals than deep men: the nearest underneath defender sinks with the extra one)
            const d = nearest(deepers.filter((x) => !taken.has(x)), [end[0], end[1]])
              || nearest(cover.filter((x) => !taken.has(x) && x.label !== 'DL' && x.label !== 'EDGE'), here(a));
            if (!d) return;
            taken.add(d);
            leg(d, REACT_DEF + 0.9, 'chase', { who: a.b, gap: shortThrow ? 1.3 : 2.2, eff: 0.92, lead: 0.5 });
          });
      }
      return { cover, man, assigned, shell };
    }
    const xy = (p) => ({ x: p[0], y: p[1] });
    // How open the target is when the ball gets there (yards to the nearest defender), drawn to fit what really
    // happened. Completion rates climb steeply with separation (NFL Next Gen Stats: tight windows under a yard are
    // completed well under half the time, wide-open throws almost always), so given the outcome: a catch with a
    // long run after it was a man who got loose, an incompletion was mostly a covered man, and the rare open man
    // who didn't catch it got a bad ball (which the play then shows). Buckets in yards, how often throws find each,
    // and the completion rate in each (approximate, after NGS).
    const SEP = [[0.4, 1], [1, 2], [2, 3], [3, 5], [5, 8]], SEP_P = [0.2, 0.27, 0.2, 0.2, 0.13], SEP_C = [0.42, 0.58, 0.7, 0.79, 0.87];
    // an incompletion is drawn contested: a man at most ~3.5 yd off (3 on a deep ball), never wide open. NFL tracking has
    // some throws to open men falling incomplete, but drawn that way they read as a rigged game (players said so)
    function separationFor(caught, yac, R, air) {
      const w = SEP_P.map((p, i) => p * (caught ? SEP_C[i] : 1 - SEP_C[i]));
      if (!caught) { w[4] = 0; }
      if (caught && yac >= 8) { w[0] = 0; w[1] *= 0.4; }                  // a long run after the catch: he was loose
      if (caught && yac >= 15) { w[1] = 0; w[2] *= 0.4; }
      const tot = w.reduce((a, b) => a + b, 0);
      let u = R() * tot, i = 0;
      while (i < w.length - 1 && u > w[i]) { u -= w[i]; i++; }
      const sep = SEP[i][0] + R() * (SEP[i][1] - SEP[i][0]);
      // a catch with little after it: a man was right there to make the tackle (never one caught in space who then
      // stands waiting for a tackler; players saw it), but a step or two off, not on him (completions are mostly made
      // with a yard or more of room: Next Gen Stats has 2.5-3 yards on average at the catch)
      return { sep: caught ? (yac < 3 ? Math.min(sep, 1.7 + yac * 0.5) : sep) : Math.min(sep, air >= 15 ? 3 : 3.5), bucket: i };
    }

    function pass(c, id, sign) {
      if (!qb) return;
      const kind = passKind(id);
      const side = sign || (sc.s * dir) || 1;
      const air = e.air !== undefined ? e.air : (AIR[id] ?? 7);
      const thrownAway = e.evt === 'throwaway';
      // the Philly Special: snapped straight to the back, who pitches to the tight end coming around; he throws to
      // the quarterback, who slipped out to the flat and into the end zone
      const philly = kind === 'tpass' && e.philly && K.rb ? K.rb : null;
      if (philly) { fly(0, T_SNAP, bx, L0, philly.x0, philly.L0, 0.15); hold(T_SNAP, philly); ring(T_SNAP, philly); } else { snapToQb(); ring(T_SNAP, qb); }
      busy.add(qb);
      // when he lets it go: as charted, else the call's typical time
      let tThrow = e.ttt ? clip(e.ttt, 0.9, 7.5) : RELEASE[kind] + jit(0.25);
      if (kind === 'screen') tThrow = Math.min(tThrow, 2.2);
      // his drop: a shotgun drift to about 7.5 yards, deeper for a deep shot; play action carries out the fake;
      // a rollout moves the pocket; he climbs when he has time
      const q0 = here(qb), deepDrop = kind === 'hail' ? 8.6 : kind === 'deep' || kind === 'pa' ? 7.8 : kind === 'screen' ? 7.6 : 7.2;
      let qpts;
      if (kind === 'roll') qpts = [q0, [inX(q0[0] + side * 3), fwd(L0, -6.6)], [inX(q0[0] + side * 9.5), fwd(L0, -6.2)]];
      else if (kind === 'pa' || kind === 'flea') qpts = [q0, [q0[0] + (K.rb ? Math.sign(K.rb.b.x - q0[0]) * 1.2 : 0.5), fwd(L0, -5.6)], [q0[0], fwd(L0, -deepDrop)]];
      else if (kind === 'tpass') qpts = [q0, [q0[0] + side * 1.2, fwd(L0, -5.4)]];
      else if (kind === 'rpo') qpts = [q0, [q0[0] + jit(0.4), fwd(L0, -5.6)]];
      else qpts = [q0, [q0[0] + jit(0.3), fwd(L0, -deepDrop)]];
      const qPlan = plan(qb, qpts, { eff: kind === 'roll' ? 0.75 : 0.52, v1: kind === 'roll' ? 2.5 : 0 });
      if (!philly) follow(qb, T_SNAP, qPlan);
      const tSet = T_SNAP + qPlan.T;
      if (tThrow > tSet + 0.9 && kind !== 'roll' && !philly) {
        const e2 = qPlan.end;
        leg(qb, tSet + 0.35, 'go', { x: e2[0] + jit(0.6), y: e2[1] + dir * (0.6 + R() * 0.6), eff: 0.25 });
      }
      // trick plays: who throws it. The flea-flicker: the back takes the handoff, gets two steps from the line and
      // pitches it back to the quarterback. The receiver pass: a receiver comes back behind the line, the
      // quarterback tosses it to him and he throws.
      let passer = qb;
      if (kind === 'flea' && K.rb) {
        const rb = K.rb, r0 = here(rb), mesh = [q0[0] + Math.sign(r0[0] - q0[0] || 1) * 0.6, fwd(L0, -4.8)];
        const rp = follow(rb, REACT_OFF, plan(rb, [r0, mesh, [mesh[0] + jit(0.4), fwd(L0, -1.8)]], { eff: 0.8, v1: 0 }));
        const tH = T_SNAP + 0.6, tP = REACT_OFF + rp.T + 0.15, tBack = tP + 0.4;
        const at = rp.at(rp.T), qAt = qPlan.at(Math.min(qPlan.T, tBack - T_SNAP));
        busy.add(rb);
        hold(tH, rb); ring(tH, qb, false); ring(tH, rb);
        fly(tP, tBack, px(at[0]), at[1], px(qAt[0]), qAt[1], 0.35);
        hold(tBack, qb); ring(tBack, rb, false); ring(tBack, qb);
        say(tBack, 'Flea-flicker!', 'info', { follow: qb });
        leg(rb, tP + 0.2, 'go', { x: rb.b.x, y: fwd(L0, 0.5), eff: 0.6 });
        tThrow = Math.max(tThrow, tBack + 1.0);
      } else if (philly) {
        const rb = philly, r0 = here(rb);
        const te = K.recv.filter((a) => a !== rb && (a.label === 'TE' || a.label === 'WR')).sort((a, b) => (b.label === 'TE') - (a.label === 'TE') || Math.abs(a.b.x - (BX - side * 5)) - Math.abs(b.b.x - (BX - side * 5)))[0];
        busy.add(rb);
        say(T_SNAP + 0.2, 'Direct snap', 'info', { follow: rb });
        if (te) {
          const rp = follow(rb, T_SNAP + 0.05, plan(rb, [r0, [inX(BX - side * 3.5), fwd(L0, -4)]], { eff: 0.8 }));
          const w0 = here(te), tw = REACT_OFF - 0.1;
          const wp = follow(te, tw, plan(te, [w0, [inX(BX - side * 1.5), fwd(L0, -5.4)], [inX(BX + side * 4), fwd(L0, -5.8)]], { eff: 0.9, v1: 0 }));
          // the pitch: when he comes past the back
          let tL = T_SNAP + 0.9, best = 99;
          for (let t = T_SNAP + 0.5; t <= Math.min(tw + wp.T, T_SNAP + 2.5); t += 0.05) {
            const a = rp.at(Math.max(0, t - T_SNAP - 0.05)), b = wp.at(Math.max(0, t - tw)), dd = dist([a[0], a[1]], [b[0], b[1]]);
            if (dd < best) { best = dd; tL = t; }
          }
          const ra = rp.at(Math.max(0, tL - T_SNAP - 0.05)), wa = wp.at(Math.max(0, tL + 0.25 - tw));
          busy.add(te);
          fly(tL, tL + 0.25, px(ra[0]), ra[1], px(wa[0]), wa[1], 0.2);
          hold(tL + 0.25, te); ring(tL + 0.25, rb, false); ring(tL + 0.25, te);
          say(tL + 0.25, 'Philly Special!', 'boom', { follow: te });
          leg(rb, tL + 0.3, 'go', { x: inX(ra[0] - side * 4), y: fwd(L0, -2), eff: 0.6 });
          passer = te;
          tThrow = Math.max(tThrow, tL + 1.1);
        }
      } else if (kind === 'tpass') {
        const cands = K.recv.filter((a) => a.label === 'WR' || a.label === 'RB');
        const wr = cands.sort((a, b) => Math.abs(a.b.x - (BX + side * 6)) - Math.abs(b.b.x - (BX + side * 6)))[0] || K.rb;
        if (wr) {
          const w0 = here(wr), spot = [inX(BX + side * 4.5), fwd(L0, -4.6)];
          const wp = follow(wr, REACT_OFF - 0.1, plan(wr, [w0, spot], { eff: 0.9, v1: 0 }));
          const tL = Math.max(T_SNAP + 0.7, REACT_OFF - 0.1 + wp.T - 0.25), qAt = qPlan.at(Math.min(qPlan.T, tL - T_SNAP)), wAt = wp.at(wp.T);
          busy.add(wr);
          fly(tL, tL + 0.35, px(qAt[0]), qAt[1], px(wAt[0]), wAt[1], 0.25);
          hold(tL + 0.35, wr); ring(tL + 0.35, qb, false); ring(tL + 0.35, wr);
          say(tL + 0.35, 'Trick play!', 'info', { follow: wr });
          leg(wr, tL + 0.5, 'go', { x: wAt[0] - side * 1.5, y: fwd(L0, -6.2), eff: 0.45 });
          leg(qb, tL + 0.45, 'go', { x: inX(q0[0] - side * 5), y: fwd(L0, -2), eff: 0.6 });
          passer = wr;
          tThrow = Math.max(tThrow, tL + 1.3);
        }
      }
      const qbSpot = (t) => Wd.posAt(passer.b, Math.min(t, Wd.t));
      // the target and the catch: his route (as charted, else the call's), to the depth of the real throw, there
      // when the ball is
      // your pick (a receiver and his route): him, on that route, and the others on the routes you saw
      const pick = mine && act && act.target != null ? eligibles(sc)[act.target] : null;
      let tgt = philly && passer !== qb ? qb : pick || pickTarget(id, sign) || K.rb;
      if (tgt === passer) tgt = K.recv.filter((a) => a !== passer && a.label !== 'TE').sort((a, b) => Math.abs(b.b.x - BX) - Math.abs(a.b.x - BX))[0] || K.recv.find((a) => a !== passer);
      if (!tgt) return;
      busy.add(tgt);
      const routeName = thrownAway ? 'out' : tgt === qb ? 'flat' : pick && act.route ? act.route : (e.route && Motion.route(e.route, air, 1, 0.5) ? e.route
        : tgt === K.rb ? (kind === 'screen' ? 'screen' : pickOf(['flat', 'angle', 'flat'])) : pickOf(CALL_ROUTE[id === 'quick_middle' ? 'quick_middle' : id === 'deep_middle' ? 'deep_middle' : kind] || ['hitch']));
      const out = pick ? outOf(sc, tgt) : tgt === K.rb || tgt === qb ? side : (Math.sign(tgt.b.x - BX) || side);
      // forward progress: a completion is caught no deeper than where it is spotted (he is not carried back after it)
      const held = !e.incomplete && e.evt !== 'interception' && e.evt !== 'pick_six' && !e.td;
      const deep = held ? Math.min(air, e.yards ?? air) : air;
      const r = Motion.routeOnField(routeName, deep, tgt.b.x, out, dir, L0, Math.abs(tgt.b.y - L0), R());
      let catchPt = [inX(r.catchAt[0]), inL(fwd(L0, deep))];
      let rpts = r.toCatch.slice(0, -1).map((p) => [inX(p[0]), inL(p[1])]).concat([catchPt]);
      const tStart = tgt === qb ? T_SNAP + 0.6 : tgt === K.rb && kind !== 'screen' ? 0.5 : REACT_OFF;
      // the ball's flight: the length of the throw, from where the quarterback lets it go (on his drop), at the
      // ball's speed (flight: about 24 yards a second, deep balls lofted a little slower)
      const qRel = passer === qb && !philly && kind !== 'flea' ? qPlan.at(Math.max(0, tThrow - T_SNAP)) : null;
      const flightTo = (c) => (qRel ? Math.hypot(c[0] - qRel[0], c[1] - qRel[1]) / (25 - 0.09 * clip(deep, 0, 60)) : flight(deep));
      let tCatch = tThrow + flightTo(catchPt), v1 = routeName === 'hitch' || routeName === 'screen' ? 0 : undefined, timed = true;
      // a timing route (a hitch, an out, a dig, a deep out): the throw (when it was charted) is thrown on time, before
      // he turns, and the ball meets him coming out of his break: caught where he is, running flat out, when it gets
      // there, a step or two past the break (never at the end of the route with the ball hanging in the air while
      // he gets there). Thrown late, he is further along the break (a hitch sits down facing the passer and waits).
      const cutK = BREAK_OUT[routeName];
      if (cutK != null && !thrownAway && rpts.length >= 3) {
        const top = rpts[1], tail = [inX(r.catchAt[0]), r.catchAt[1]];
        const legL = Math.hypot(tail[0] - top[0], tail[1] - top[1]), [ux, uy] = unit(tail[0] - top[0], tail[1] - top[1]);
        const ptAt = (k) => [inX(top[0] + ux * k), catchPt[1]];
        for (let k = Math.min(cutK, legL); ; k = Math.min(legL, k + 0.5)) {
          const c = ptAt(k), arr = tStart + plan(tgt, [rpts[0], top, c]).T, ball = tThrow + flightTo(c);
          catchPt = c; tCatch = Math.max(ball, arr);
          if (arr >= ball - 0.05 || k >= legL) break;
        }
        rpts = [rpts[0], top, catchPt];
        // a hitch on time comes back to the ball; early, he settles facing the passer, and it comes to him
        if (routeName === 'hitch') {
          const sit = plan(tgt, rpts, { v1: 0 });
          v1 = tStart + sit.T <= tCatch ? 0 : undefined;
          timed = v1 === undefined;
        }
      }
      const tp = plan(tgt, rpts, { T: timed ? tCatch - tStart : undefined, v1 });
      if (tp.late > 0.02) tCatch += tp.late;
      follow(tgt, tStart, tp);
      // the rush and the line
      const nRush = e.rushers || (e.look && e.look.blitz ? 5 : 4);
      const rushers = rushersOf(nRush);
      // pressure: one rusher beats his man and is on the passer as he throws (his win is drawn from the snap on)
      const front = rushers.filter((d) => K.rush.includes(d)), wP = e.pressure ? pickOf(rushers) : null;
      const tWin = Math.max(REACT_DEF + 0.7, tThrow - 1.0);
      lineplay('pass', side, front, { passer, q: passer === qb && !philly && kind !== 'flea' ? qPlan.end : null, win: wP && front.includes(wP) ? new Map([[wP, tWin]]) : null });
      const blitzers = rushers.filter((d) => !K.rush.includes(d));
      blitzers.forEach((d, i) => leg(d, REACT_DEF + 0.1, 'chase', { who: passer.b, gap: 1.6 + i * 0.6, eff: 0.95, lead: 0.2 }));
      // the fullback stays in: he picks up the first blitzer, else sets up beside the passer
      if (K.fb && K.fb !== tgt) {
        if (blitzers.length) leg(K.fb, REACT_OFF, 'chase', { who: blitzers[0].b, gap: 0.9, eff: 0.85, lead: 0.3 });
        else leg(K.fb, REACT_OFF, 'track', { gain: 2.4, eff: 0.6, fn: (t) => { const Q = qbSpot(t); return [Q[0] + side * 1.6, Q[1] + dir * 1.4]; } });
      }
      if (wP) leg(wP, tWin, 'chase', { who: passer.b, gap: 1.1, eff: 1, lead: 0.3 });
      const cov = passShape({ kind, tgt, catchPt, tThrow, tCatch, rushers, shell: shellOf(), side, qbSpot, passer });
      // the coverage on the target fits the outcome: one defender (his man, or the zone defender nearest where the
      // ball is going) closes to the separation drawn above by the time the ball arrives
      const intc = e.evt === 'interception' || e.evt === 'pick_six';
      const caught = !intc && (!e.incomplete || e.evt === 'drop');
      const graded = !thrownAway && kind !== 'hail' && e.evt !== 'throwaway';
      const sepd = !graded ? null : intc ? { sep: 0.4 + R() * 0.5, bucket: 0 } : e.evt === 'near_pick' ? { sep: 0.4 + R() * 0.6, bucket: 0 }
        : separationFor(caught, Math.max(0, (e.yards || 0) - air), R, air);
      let shadow = null;
      if (sepd) {
        const tS = Math.max(REACT_DEF + 0.3, tThrow - 1.6);
        Wd.run(tS);
        const rAt = (t) => tp.at(Math.max(0, t - tStart));
        const end = rAt(tCatch);
        let manOf = null;
        if (cov.man && cov.assigned) for (const [d, r] of cov.assigned) if (r === tgt) manOf = d;
        shadow = manOf || cov.cover.filter((d) => d.label !== 'DL' && d.label !== 'EDGE').sort((a, b) => dist(here(a), end) - dist(here(b), end))[0] || null;
        if (shadow) {
          busy.add(shadow);
          const r0 = rAt(tS), d0 = here(shadow);
          const rel0 = [d0[0] - r0[0], d0[1] - r0[1]];
          // where he ends up: trailing (between the receiver and the line) and to the inside in man; in zone, from
          // where he came, closing; at the drawn distance
          // (a ball he will break up: at the receiver's hip rather than trailing, so the step he takes to the ball as
          // it comes is across, not a chase from behind he cannot finish on a ball thrown downfield)
          const ins = Math.sign(BX - end[0]) || 1, toBreak = (e.incomplete || e.evt === 'near_pick') && e.evt !== 'drop' && !thrownAway && kind !== 'hail' && sepd.sep < 2;
          const z = unit(rel0[0], rel0[1]);
          const u = cov.man ? (toBreak ? [ins * 0.89, -dir * 0.45] : [ins * 0.55, -dir * 0.83]) : toBreak ? unit((Math.sign(z[0]) || ins) * 0.9, z[1] * 0.5) : z;
          const span = Math.max(0.3, tCatch - tS);
          leg(shadow, tS, 'track', { gain: 3, eff: 1, fn: (t) => {
            const k = clip((t - tS) / span, 0, 1), q = rAt(Math.min(t, tCatch));
            return [q[0] + rel0[0] * (1 - k) + u[0] * sepd.sep * k, q[1] + rel0[1] * (1 - k) + u[1] * sepd.sep * k];
          } });
        }
      }
      // the throw
      Wd.run(tThrow);
      const qT = here(passer);
      if (thrownAway) catchPt = [sidelineX(qT[0] + side * 10) + Math.sign(qT[0] - FW / 2 || side) * 2.5, inL(fwd(L0, Math.max(3, air)))];
      fly(tThrow, tCatch, px(qT[0]) + 4, qT[1], px(catchPt[0]), catchPt[1], Math.min(2.4, 0.35 + Math.abs(air) * 0.05));
      ring(tThrow, passer, false);
      leg(passer, tThrow + 0.15, 'go', { x: qT[0] + jit(1), y: qT[1] + dir * 1.2, eff: 0.25 });
      // the defense breaks on the ball a beat after it is out: the nearest two to where it is going
      const breakers = cov.cover.slice().sort((a, b) => dist(here(a), catchPt) - dist(here(b), catchPt)).slice(0, 2);
      let picker = null;
      if (intc) {
        picker = shadow || breakers[0] || nearest(K.def, catchPt);
        busy.add(picker);
        const pl = runFrom(picker, tThrow + 0.2, [[catchPt[0] - out * 0.4, catchPt[1] - dir * 0.6]], { T: tCatch - tThrow - 0.2 });
        if (pl.late > 0.05) tCatch += pl.late;
      }
      // an incompletion has to read as one: the nearest defender gets to the ball and breaks it up, or, when nobody
      // can (the receiver really was open), the throw sails past him. Never a dead-open man and a ball that just
      // falls (players called that the game cheating)
      let broke = null, overthrow = false;
      const contest = !intc && !thrownAway && kind !== 'hail' && (e.incomplete || e.evt === 'near_pick') && e.evt !== 'drop';
      if (contest) {
        // a covered man: his defender gets a hand on it; an open one (the rare open incompletion): a bad ball
        if (shadow && sepd && sepd.sep < 2) broke = shadow;            // (he goes for the ball below)
        else overthrow = true;
      }
      breakers.forEach((d, i) => {
        if (d === picker || d === broke || d === shadow) return;
        const near_ = dist(here(d), catchPt);
        const yac = Math.abs(e.yards - air);
        // the closer the coverage, the shorter the run after the catch: trail by more when he got loose
        const lag = clip(yac * 0.07, 0, 1.2);
        if (caught && !e.incomplete) {
          // a catch: the man on him is the one there (at the separation drawn); the others close to a few yards off
          // as the ball arrives, from where they came, then chase (runDown makes the tackle). Never on top of him with
          // the ball (players saw catches "in triple coverage")
          const p = here(d), keep = Math.max(3, (sepd ? sepd.sep : 0) + 2) + i * 1.5 + lag;
          const [ux, uy] = unit(p[0] - catchPt[0], p[1] - catchPt[1]);
          leg(d, tThrow + 0.35, 'go', { x: inX(catchPt[0] + ux * keep), y: catchPt[1] + uy * keep, eff: near_ > keep ? (i ? 0.8 : 0.95) : 0.5 });
          return;
        }
        leg(d, tThrow + 0.35 + lag * 0.4, 'go', { x: catchPt[0] + jit(1.2), y: catchPt[1] + dir * (1.2 + lag), eff: i ? 0.8 : 0.95 });
        if (near_ > 25) leg(d, tThrow + 0.35, 'go', { x: catchPt[0], y: catchPt[1] + dir * 6, eff: 0.85 });
      });
      // the breakup: from the step or two he was off, he closes on the ball as it comes and gets a hand to it (a
      // "Broken up" with the man still a stride away reads as no play on the ball at all)
      if (broke) {
        const tB = Math.max(Wd.t, tCatch - 0.8), to = [catchPt[0] - out * 0.25, catchPt[1] + dir * 0.3];
        Wd.run(tB);
        // (already running his way, as a man trailing a receiver is: straight there; runFrom's step along his
        // momentum would carry him past the ball and back)
        const p = here(broke), [ux, uy] = unit(to[0] - p[0], to[1] - p[1]), s = vel(broke);
        if (s < 1 || (broke.b.vx * ux + broke.b.vy * uy) / s > 0.85) follow(broke, Wd.t, plan(broke, [p, to], { v0: s, T: tCatch - Wd.t + 0.02, v1: 2 }));
        else runFrom(broke, tB, [to], { T: tCatch - tB + 0.02, v1: 2 });
      }
      Wd.run(tCatch);
      // "Broken up" only with a defender really at the ball: when the cover man could not get there in time (he
      // started too far off), it was a bad ball, and it says so (players saw "Broken up" with nobody near)
      const ballD = Math.min(...K.def.map((d) => dist(here(d), catchPt)));
      const late = !!(broke && ballD > 2.5);
      if (late) { broke = null; overthrow = true; }
      // (tests: how open the target really was on the field when the ball got there, against the outcome)
      const sepRow = window.__sepLog ? { evt: e.evt || '', inc: !!e.incomplete, caught, intc, yac: Math.max(0, (e.yards || 0) - air), air,
        late, drawn: sepd && sepd.sep, actual: Math.min(...K.def.map((d) => dist(here(d), here(tgt)))), ballD, kind,
        openDeep: K.recv.filter((a) => a !== tgt && a !== passer && Math.abs(here(a)[1] - L0) > 12 && Math.min(...K.def.map((d) => dist(here(d), here(a)))) > 5).length,
        deep: K.recv.filter((a) => a !== tgt && a !== passer && Math.abs(here(a)[1] - L0) > 12).map((a) => [a.label, +Math.abs(here(a)[1] - L0).toFixed(0), +Math.min(...K.def.map((d) => dist(here(d), here(a)))).toFixed(1)]),
        man: !!cov.man, shell: cov.shell,
        crowd: K.def.filter((d) => dist(here(d), here(tgt)) < Math.max(2.5, (sepd ? sepd.sep : 0) + 1.5)).length } : null;
      if (sepRow) window.__sepLog.push(sepRow);
      // what happened at the catch point
      if (intc) {
        hold(tCatch, picker);
        ring(tCatch, picker);
        say(tCatch, 'Intercepted!', 'hit', { follow: picker });
        const end = e.tdDef ? [inX(catchPt[0] + jit(10)), defTdL()] : [inX(catchPt[0] + jit(8)), inL(losOf(res.root))];
        // he runs it back the other way: the offense becomes the chasers
        const tEnd = runDown(picker, tCatch + 0.05, end, { td: e.tdDef, after: 0.6 });
        if (e.tdDef) say(tEnd, 'Pick-six!', 'hit', { follow: picker });
        else down(tEnd + 0.05, picker);
        lastEnd(tEnd + 1.0);
        return;
      }
      if (e.incomplete || ['throwaway', 'drop', 'near_pick'].includes(e.evt)) {
        const brk = broke ? null : breakers[0];
        // a bad ball misses where you can see it: long past him on a deep throw, behind him or at his feet short
        const g = thrownAway ? catchPt : overthrow ? (air >= 15 ? [inX(catchPt[0] + out * 1.5 + jit(1)), inL(catchPt[1] + dir * 4)]
          : [inX(catchPt[0] - out * 2.2 + jit(0.8)), inL(catchPt[1] - dir * 1.5)])
          : [inX(catchPt[0] + jit(1.5)), catchPt[1] + dir * 1.4];
        fly(tCatch, tCatch + 0.2, px(catchPt[0]), catchPt[1], px(g[0]), g[1], 0.15);
        rest(tCatch + 0.2, px(g[0]), g[1]);
        rest(tCatch + 1.0, px(g[0]), g[1], true);
        if (brk && !thrownAway) leg(brk, tCatch - 0.1, 'go', { x: catchPt[0] + out * 0.5, y: catchPt[1] + dir * 0.4, eff: 0.7 });
        const text = e.evt === 'drop' ? 'Dropped!' : e.evt === 'near_pick' ? 'Almost picked!' : thrownAway ? 'Thrown away'
          : kind === 'hail' ? 'Knocked down' : two ? 'Incomplete: no good' : overthrow ? (air >= 15 ? 'Overthrown' : 'Off target') : broke ? 'Broken up' : 'Incomplete';
        if (sepRow) sepRow.label = text;
        say(tCatch, text, e.evt === 'near_pick' ? 'boom' : 'info', { x: px(inX(catchPt[0])), L: catchPt[1] });
        if (e.evt === 'drop') down(tCatch + 0.1, tgt);
        leg(tgt, tCatch + 0.1, 'stand');
        whistle(tCatch + 0.2, catchPt);
        lastEnd(tCatch + 1.4);
        return;
      }
      hold(tCatch, tgt);
      ring(tCatch, tgt);
      const yac = e.td ? 99 : fwd(0, fwd(L0, e.yards) - catchPt[1]);
      const endY = e.td ? tdL() : inL(fwd(L0, e.yards));
      const endX = e.oob ? sidelineX(catchPt[0] + out * 6) : inX(catchPt[0] + clip(jit(5) + out * Math.min(Math.abs(yac), 12) * 0.25, -9, 9));
      if (Math.abs(yac) > 4 && !e.bt) say(tCatch, 'Caught', 'boom', { follow: tgt });
      if (shadow) busy.delete(shadow);       // the man on him at the catch is the first who can tackle him
      const ep = [endX, endY], tEnd = runDown(tgt, tCatch, ep, { td: e.td, oob: e.oob, bt: e.bt, from: tCatch });
      finish(tgt, tEnd, ep);
    }

    // ---- the run
    function run(c, id, sign) {
      const carrier = (id === 'qb_sneak' || id === 'qb_run' || e.who === 'QB') ? qb
        : id === 'trick_reverse' ? (K.recv.filter((a) => a.label === 'WR').sort((a, b) => Math.abs(a.x0 - (bx - (sign || 1) * 120)) - Math.abs(b.x0 - (bx - (sign || 1) * 120)))[0] || K.rb || qb)
        : (K.rb || qb);
      const direct = id === 'trick_direct' && carrier !== qb, reverse = id === 'trick_reverse' && carrier !== K.rb;
      if (!carrier) return;
      const gap = RUN_GAP[c ? c.base : ''] ?? 26;
      const sg = sign || (id === 'qb_run' ? sc.s * dir : 0) || 0;
      // forward progress: he never has the ball past where it is spotted; on a loss he is met in the backfield
      const cap = e.td ? 99 : (e.yards || 0) - ((e.yards || 0) < 3 ? 1.6 : 0.8), md = Math.min(-4.3, cap - 0.3);
      const hole = [inX(BX + (sg * gap) / XYD), fwd(L0, Math.min(0.6, cap))];
      if (direct) { fly(0, T_SNAP, bx, L0, carrier.x0, carrier.L0, 0.15); hold(T_SNAP, carrier); } else snapToQb();
      busy.add(carrier);
      // one continuous run from his stance through the mesh to the hole, flat out: across the QB's face when the
      // play goes away from his side, downhill when it goes his way; the handoff is when he gets to the mesh
      // (tracking: backs reach the line about 2.5 s after the snap)
      const c0 = here(carrier), q0 = qb ? here(qb) : c0;
      let tMesh = T_SNAP + 0.05, tLos;
      if (direct) {
        // the direct snap: he takes it himself and goes; the quarterback slides out as a decoy
        const pl = follow(carrier, T_SNAP + 0.05, plan(carrier, [c0, hole], { eff: 0.92 }));
        tLos = T_SNAP + 0.05 + pl.T;
        if (qb) leg(qb, T_SNAP, 'go', { x: inX(q0[0] - (sg || 1) * 6), y: fwd(L0, -2.5), eff: 0.6 });
        say(T_SNAP + 0.2, 'Direct snap', 'info', { follow: carrier });
      } else if (carrier === qb) {
        const pl = follow(qb, T_SNAP + 0.05, plan(qb, [q0, id === 'qb_sneak' ? [BX, fwd(L0, Math.min(0.4, cap))] : hole], { eff: 0.92 }));
        tLos = T_SNAP + 0.05 + pl.T;
      } else {
        const across = sg === 0 || Math.sign(hole[0] - q0[0]) !== Math.sign(c0[0] - q0[0]);
        const meshPt = carrier.label === 'WR' ? [q0[0] + (c0[0] > q0[0] ? 1.2 : -1.2), fwd(L0, md + 0.1)]
          : across ? [q0[0] + (c0[0] - q0[0]) * 0.3, fwd(L0, md)] : [c0[0] + (hole[0] - c0[0]) * 0.15, fwd(L0, md)];
        const start = carrier.label === 'WR' ? 0.35 : REACT_OFF;
        // (at speed into the hole whatever the result: the contact, if it comes there, is runDown's; slowing into it
        // left a back jogging at the edge with nobody there)
        const pl = follow(carrier, start, plan(carrier, [c0, meshPt, hole], { eff: carrier.label === 'WR' ? 0.95 : 0.9 }));
        let best = 9, bt = 0.7;
        for (let s = 0; s <= pl.T; s += 0.05) { const p = pl.at(s), d = dist([p[0], p[1]], meshPt); if (d < best) { best = d; bt = s; } }
        tMesh = Math.max(T_SNAP + 0.35, start + bt);
        tLos = start + pl.T;
        if (qb) {
          // the QB meets him there, then carries out the fake away from the run
          const qm = [meshPt[0] + Math.sign(q0[0] - meshPt[0] || -(sg || 1)) * 0.8, fwd(L0, md - 0.6)];
          follow(qb, T_SNAP, plan(qb, [q0, qm], { T: tMesh - T_SNAP, v1: 0 }));
          leg(qb, tMesh + 0.15, 'go', { x: inX(qm[0] - (sg || 1) * 7), y: fwd(L0, -6.5), eff: 0.55 });
          hold(tMesh, carrier);
        }
      }
      ring(tMesh, carrier);
      if (reverse && K.rb) {         // the back fakes it the other way first; the second level bites
        leg(K.rb, REACT_OFF, 'go', { x: inX(BX - (sg || 1) * 6), y: fwd(L0, -1), eff: 0.85 });
        say(tMesh, 'End-around!', 'info', { follow: carrier });
      }
      lineplay('run', sg, K.rush);
      // the second level: linebackers read, then fill toward the hole; safeties come down; corners hold, then come up
      K.def.forEach((d) => {
        if (K.rush.includes(d)) return;
        if (reverse && d.label === 'LB') leg(d, REACT_DEF, 'go', { x: d.b.x - (sg || 1) * 3, y: fwd(L0, 3), eff: 0.7 });
        if (d.label === 'LB') leg(d, REACT_DEF + 0.25 + (reverse ? 0.7 : 0), 'go', { x: hole[0] + jit(2.5), y: fwd(L0, 3 + R() * 1.5), eff: 0.7 });
        else if (d.label === 'S') leg(d, 0.9 + R() * 0.3, 'go', { x: d.b.x + (hole[0] - d.b.x) * 0.5, y: fwd(L0, 6 + R() * 3), eff: 0.75 });
        else leg(d, 1.1 + R() * 0.3, 'go', { x: d.b.x + (hole[0] - d.b.x) * 0.3, y: fwd(L0, 5 + R() * 2), eff: 0.7 });
      });
      // receivers block the corners, the tight end the edge
      K.recv.forEach((a) => {
        if (a === carrier) return;
        const foe = nearest(K.def.filter((d) => d.label === 'CB' || d.label === 'S'), here(a));
        if (a.label === 'TE' || !foe) leg(a, REACT_OFF, 'go', { x: a.b.x + sg * 0.8, y: fwd(L0, 1), eff: 0.6 });
        else leg(a, REACT_OFF, 'chase', { who: foe.b, gap: 1.0, eff: 0.75, lead: 0.3 });
      });
      if (K.rb && K.rb !== carrier && carrier === qb) leg(K.rb, REACT_OFF, 'go', { x: hole[0] - sg * 1.5, y: fwd(L0, 0.5), eff: 0.8 });
      // the fullback leads through the hole and takes on the first man there
      if (K.fb && K.fb !== carrier) {
        const lb = nearest(K.def.filter((d) => d.label === 'LB'), hole);
        if (lb) leg(K.fb, REACT_OFF - 0.1, 'chase', { who: lb.b, gap: 0.9, eff: 0.9, lead: 0.4 });
        else leg(K.fb, REACT_OFF - 0.1, 'go', { x: hole[0], y: fwd(L0, 1.5), eff: 0.9 });
      }
      const Lend = e.td ? tdL() : inL(fwd(L0, e.yards));
      const xEnd = e.oob ? sidelineX(sg ? (sg > 0 ? FW : 0) : hole[0]) : inX(hole[0] + sg * Math.min(9, Math.abs(e.yards) * 0.5) + jit(3));
      const tEnd = runDown(carrier, Math.max(tLos - 0.15, tMesh + 0.2), [xEnd, Lend], { td: e.td, oob: e.oob, bt: e.bt, eff: 0.95, after: e.yards < 2 ? 0.8 + R() : undefined, from: tMesh });
      finish(carrier, tEnd, [xEnd, Lend]);
    }

    // ---- the sack: the rush gets home as he looks for someone
    function sack() {
      if (!qb) return;
      snapToQb();
      busy.add(qb);
      ring(T_SNAP, qb);
      let tS = clip(e.dur ? e.dur - 0.6 : 3.0, 2.2, 4.4) + jit(0.25);
      const q0 = here(qb), drop = [q0[0] + jit(0.3), fwd(L0, -7.3)];
      follow(qb, T_SNAP, plan(qb, [q0, drop], { eff: 0.5, v1: 0 }));
      const nRush = e.rushers || (e.look && e.look.blitz ? 5 : 4);
      const rushers = rushersOf(nRush), front = rushers.filter((d) => K.rush.includes(d));
      const Lend = inL(fwd(L0, e.yards)), spot = [inX(drop[0] + jit(1.5)), Lend];
      // he feels it and moves, then goes down where the play ended (a long sack: he flees sooner, and goes down
      // only once he can have got there)
      const flee = Motion.minTime([drop, spot], qb.b.g, { spd: qb.b.spd }) / 0.9;
      const tMove = Math.max(T_SNAP + 0.9, Math.min(Math.max(T_SNAP + 1.4, tS - 0.7), tS - flee));
      tS = Math.max(tS, tMove + flee);
      // who gets home: a blitzer when they bring one, else the man best placed for where he goes down (off the edge
      // when that is deep in the backfield, through the middle when the passer stepped up into it); his win shows from
      // the snap (round the tackle, or through his man's shoulder), free a second before the sack
      const blitz = rushers.filter((d) => !front.includes(d)), deepSack = fwd(0, L0 - Lend) > 6;
      const cands = e.look && e.look.blitz && blitz.length ? blitz : front.length ? front : rushers;
      const rusher = cands.map((d) => ({ d, s: dist(here(d), spot) - (deepSack && d.label === 'EDGE' ? 2.5 : 0) + R() * 2.5 })).sort((a, b) => a.s - b.s).map((x) => x.d)[0] || K.def[0];
      const tBeat = clip(tS - 1.1, REACT_DEF + 0.8, tS - 0.5);
      lineplay('pass', sc.s * dir, front, { q: drop, win: front.includes(rusher) ? new Map([[rusher, tBeat]]) : null });
      const side = sc.s * dir || 1;
      passShape({ kind: 'deep', tgt: null, catchPt: [BX, fwd(L0, 10)], tThrow: tS + 1, tCatch: tS + 2, rushers, shell: shellOf(), side, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
      blitz.forEach((d, i) => leg(d, REACT_DEF + 0.1, 'chase', { who: qb.b, gap: d === rusher ? 1.2 : 1.8 + i * 0.6, eff: 0.95 }));
      Wd.run(tMove);
      runFrom(qb, tMove, [spot], { T: tS - tMove, v1: 0 });
      busy.add(rusher);
      // he sheds his block when he has to, to get to the passer as he goes down (at 85% of flat out)
      Wd.run(Math.max(tMove, Math.min(tBeat, tS - 0.5)));
      const rp0 = here(rusher), need = Motion.minTime([rp0, spot], rusher.b.g, { spd: rusher.b.spd });
      const tGo = clip(tS - need / 0.85, Wd.t, tS - 0.3);
      Wd.run(tGo);
      const rp = here(rusher), [ux, uy] = unit(spot[0] - rp[0], spot[1] - rp[1]);
      // (late, coming round from where his win left him: the passer is down when he gets there, not before)
      const hit = runFrom(rusher, tGo, [[spot[0] - ux * 0.8, spot[1] - uy * 0.8]], { T: tS + 0.05 - tGo });
      tS += hit.late;
      // (on him until the whistle: a passer who got there late, still moving, takes the man who hit him with him)
      leg(rusher, tS + 0.05, 'stick', { who: qb.b, dx: -ux * 0.8, dy: -uy * 0.8, ease: 0.15 });
      leg(qb, tS + 0.4, 'stand');
      say(tS, e.evt === 'strip_sack' ? 'Strip-sack!' : 'Sacked!', 'hit', { follow: qb });
      down(tS + 0.35, qb);
      let t = tS + 0.35;
      Wd.run(t);
      if (e.evt === 'strip_sack' || e.evt === 'sack_fumble') {
        const f = [inX(spot[0] + jit(3)), Lend - dir * 1.4];
        fly(tS, tS + 0.55, px(spot[0]), spot[1], px(f[0]), f[1], 0.2);
        rest(tS + 0.55, px(f[0]), f[1]);
        const rec = e.evt === 'strip_sack' ? nearest(rushers.filter((d) => d !== rusher), f) || rusher : nearest(K.ol, f);
        let tRec = tS + 0.72;      // he has the ball when he gets to it
        if (rec) { busy.add(rec); tRec = tS + 0.12 + runFrom(rec, tS + 0.1, [f], { T: 0.6, v1: 0 }).T; hold(tRec, rec); }
        if (rec && e.tdDef) t = returnTd(rec, tRec + 0.03, f, 'Scoop and score!');
        else {
          if (rec) leg(rec, tRec + 0.03, 'stand');
          say(tRec, e.evt === 'strip_sack' ? `${defName} ball` : 'Fumble: recovered', e.evt === 'strip_sack' ? 'hit' : 'info', { slot: 1, follow: rec || qb });
          t = tRec + 0.13;
        }
      }
      if (e.safety) say(tS + 0.35, 'Safety!', 'hit', { slot: 1, follow: qb });
      whistle(tS + 0.3, spot);
      lastEnd(t + 1.1);
    }

    // ---- the scramble: nothing open, the pocket breaks, he takes off
    function scramble() {
      if (!qb) return;
      snapToQb();
      busy.add(qb);
      ring(T_SNAP, qb);
      const side = R() < 0.5 ? -1 : 1, tE = 2.3 + R() * 0.8;
      const q0 = here(qb);
      follow(qb, T_SNAP, plan(qb, [q0, [q0[0], fwd(L0, -7.2)]], { eff: 0.5, v1: 0 }));
      const rushers = rushersOf(e.rushers || 4), front = rushers.filter((d) => K.rush.includes(d));
      // the pocket breaks on the other side: that rusher wins and flushes him out the way he runs
      const flusher = front.slice().sort((a, b) => side * (a.b.x - b.b.x))[0];
      lineplay('pass', side, front, { q: [q0[0], fwd(L0, -7.2)], win: flusher ? new Map([[flusher, tE - 0.45]]) : null });
      passShape({ kind: 'deep', tgt: null, catchPt: [BX, fwd(L0, 10)], tThrow: tE + 1.5, tCatch: tE + 2.5, rushers, shell: shellOf(), side, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
      Wd.run(tE);
      const Lend = e.td ? tdL() : inL(fwd(L0, e.yards));
      const esc = [inX(here(qb)[0] + side * 6), fwd(L0, -6)];
      runFrom(qb, tE, [esc], { eff: 0.9, v1: 5 });
      say(tE, 'Scramble!', 'boom', { follow: qb });
      const xEnd = e.oob ? sidelineX(esc[0] + side * 10) : inX(esc[0] + side * (4 + R() * 6));
      const tOut = tE + Motion.minTime([here(qb), esc], 'QB', { v0: vel(qb) }) * 1.05;
      const tEnd = runDown(qb, tOut, [xEnd, Lend], { td: e.td, oob: e.oob, eff: 0.9, after: e.slide ? 0 : undefined, from: tE });
      finish(qb, tEnd, [xEnd, Lend]);
    }

    // ---- a flag: the yellow flag lands near the line, then stays with the camera
    function flag(tFlag, text) {
      const g = S('g', { class: 'flagmark' }), fx = clampX(bx + jit(30)), fL = fwd(L0, 1 + Math.abs(jit(3)));
      g.append(S('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5, transform: 'rotate(18)' }));
      fxAt(tFlag, () => {
        sc.callLayer.before(g);
        sc.parts.push((Y) => g.setAttribute('transform', `translate(${fx.toFixed(1)},${Y(fL).toFixed(1)})`));
      });
      say(tFlag, text, 'flag');
    }

    // ---- bake: run the world to the end and hand every actor its track
    function bake(T) {
      Wd.run(T);
      sc.actors.forEach((a) => {
        const b = a.b, n = b.hx.length;
        a.trk = { dt: Wd.dt, n, x: Float32Array.from(b.hx, px), L: Float32Array.from(b.hy), w0: a.w0 ?? 1, wt: snapAt, hold: frozen };
      });
    }

    if (e.ev === 'play') {
      const c = e.call >= 0 ? idx.calls[e.call] : null;
      const id = c ? c.id : '';
      const sign = !c || !c.side || c.side === 'middle' ? 0 : (c.side === 'strong' ? 1 : -1) * sc.s * dir;
      if (e.penalty && (PRE_SNAP.has(e.pen) || !(e.dur > 0))) {     // a flag before the snap: one man jumps, nobody else moves
        frozen = true;
        const jumper = /Offside|Encroachment|Neutral Zone/.test(e.pen || '') ? nearest(K.rush, [BX, L0]) : nearest(K.ol, [BX, L0]);
        if (jumper) {
          const j0 = here(jumper);
          leg(jumper, 0.1, 'go', { x: j0[0], y: j0[1] + (jumper.off ? dir : -dir) * 1.1, eff: 0.8 });
          leg(jumper, 0.55, 'go', { x: j0[0], y: j0[1], eff: 0.5 });
        }
        flag(0.3, `Flag: ${e.pen || 'penalty'}`);
        P.T = 1.5;
      } else if (e.evt === 'bad_snap') {
        const l = [inX(BX + 1.4), fwd(L0, -9)];
        fly(0, 0.55, bx, L0, px(l[0]), l[1], 0.05);
        rest(0.55, px(l[0]), l[1]);
        say(0.5, 'Bad snap!', 'hit', { x: px(l[0]), L: l[1] });
        lineplay('pass', 0, K.rush);
        // the rest start the play (receivers into their routes, the coverage bailing) and pull up once the ball is loose
        K.recv.concat(K.rb ? [K.rb] : []).forEach((a) => {
          const p = here(a);
          leg(a, REACT_OFF, 'go', { x: inX(p[0] + jit(1.5)), y: fwd(p[1], 3 + R() * 3), eff: 0.75 });
          leg(a, 1.0 + R() * 0.4, 'stand');
        });
        K.def.filter((d) => !K.rush.includes(d)).forEach((d) => {
          const p = here(d);
          leg(d, REACT_DEF, 'go', { x: p[0], y: fwd(p[1], 1 + R() * 1.5), eff: 0.6 });
          leg(d, 0.9, 'go', { x: inX(p[0] + (l[0] - p[0]) * 0.2), y: p[1] + (l[1] - p[1]) * 0.2, eff: 0.6 });
        });
        const rec = e.turnover ? nearest(K.rush.concat(K.def), l) : qb;
        let tRec = 1.07, tRun = 0;           // he has the ball when he gets to it
        if (rec) {
          busy.add(rec);
          tRec = 0.32 + follow(rec, 0.3, plan(rec, [here(rec), l], { T: 0.75, v1: 0 })).T;
          hold(tRec, rec);
          // (to the spot the result gives, however far: the play lasts until he gets there)
          if (rec === qb && qb) { Wd.run(tRec + 0.03); tRun = runFrom(qb, tRec + 0.03, [[inX(l[0] + jit(2)), inL(fwd(L0, e.yards))]], { eff: 0.8, v1: 0 }).T; }
        }
        if (rec && rec !== qb && e.tdDef) {
          const tEnd = returnTd(rec, tRec + 0.03, l, 'Scoop and score!');
          P.T = tEnd + 1.2;
        } else {
          say(tRec + 0.13, e.turnover ? `${defName} ball` : 'Recovered', e.turnover ? 'hit' : 'info', { slot: 1, follow: rec || qb });
          const tDown = tRec + Math.max(0.83, tRun + 0.1);
          Wd.run(tDown - 0.6);
          whistle(tDown, rec === qb && qb ? here(qb) : l);
          P.T = tDown + 1.1;
        }
      } else if (e.kind === SPIKE) {
        underCenter();
        snapToQb();
        if (qb) {
          leg(qb, T_SNAP + 0.1, 'go', { x: qb.b.x, y: fwd(qb.b.y, 0.6), eff: 0.4 });
          fly(0.7, 0.85, qb.x0 + 4, qb.L0, qb.x0 + 4, fwd(qb.L0, 1.3), 0.05);
          rest(0.85, qb.x0 + 4, fwd(qb.L0, 1.3));
          say(0.75, 'Spike', 'info', { follow: qb });
        }
        K.ol.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 0.5), eff: 0.4 }));
        K.rush.forEach((a) => leg(a, REACT_DEF, 'go', { x: a.b.x, y: fwd(a.b.y, -0.3), eff: 0.4 }));
        K.recv.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 2 + R() * 2), eff: 0.4 }));
        whistle(0.9, null);
        P.T = 1.9;
      } else if (e.kind === KNEEL) {
        underCenter();
        snapToQb();
        if (qb) { leg(qb, T_SNAP, 'go', { x: qb.b.x, y: fwd(L0, e.yards), eff: 0.35 }); down(0.85, qb); say(0.85, 'Kneel', 'info', { follow: qb }); }
        K.ol.forEach((a) => leg(a, REACT_OFF, 'go', { x: a.b.x, y: fwd(a.b.y, 0.3), eff: 0.3 }));
        K.def.forEach((a) => leg(a, REACT_DEF + R() * 0.3, 'go', { x: a.b.x, y: fwd(a.b.y, -0.6), eff: 0.25 }));
        P.T = 2.0;
      } else if (e.penalty) {                                    // a flag during the play: it is called back
        snapToQb();
        const passing = e.kind === PASS;
        if (passing && qb) {
          follow(qb, T_SNAP, plan(qb, [here(qb), [qb.b.x, fwd(L0, -7.2)]], { eff: 0.5, v1: 0 }));
          const rushers = rushersOf(4);
          lineplay('pass', sc.s * dir, rushers);
          passShape({ kind: 'quick', tgt: null, catchPt: [BX, fwd(L0, 8)], tThrow: 3, tCatch: 3.6, rushers, shell: shellOf(), side: sc.s * dir || 1, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
        } else {
          lineplay('run', sign || 0, K.rush);
          if (K.rb) follow(K.rb, REACT_OFF, plan(K.rb, [here(K.rb), [BX + (sign || 0) * 2, fwd(L0, -1)]], { eff: 0.7, v1: 2 }));
        }
        Wd.run(1.9);
        flag(1.9, `Flag: ${e.pen || 'penalty'}`);
        whistle(2.2, [BX, L0]);
        P.T = 3.4;
      } else if (['sack', 'strip_sack', 'sack_fumble'].includes(e.evt)) sack();
      else if (e.evt === 'scramble') scramble();
      else {
        const thrown = e.air !== undefined || e.incomplete || ['interception', 'pick_six', 'drop', 'near_pick', 'throwaway'].includes(e.evt);
        if (e.kind === PASS && (thrown || !['rpo_strong', 'rpo_weak'].includes(id))) pass(c, id, sign);
        else run(c, id, sign);
      }
      bake(P.T + 0.2);
    } else if (e.ev === 'fg' || (e.ev === 'pat' && !two)) {
      specialKick();
    } else if (e.ev === 'punt') {
      punt();
    } else if (e.ev === 'kickoff') {
      kickoff();
    } else return null;
    return finishCamera();

    // ---- special teams
    function specialKick() {
      // field-goal formation: holder 7 yards deep, kicker behind him, nine shoulder to shoulder; the snap at T0
      const T0 = 0.8, hL = fwd(L0, -7), Ly = dir > 0 ? 110 : -10;
      const holder = qb || K.off[0], kicker = K.rb || K.off.find((a) => a !== holder);
      const line = K.off.filter((a) => a !== holder && a !== kicker);
      const go = (a, t, x, y, eff) => leg(a, t, 'go', { x: yx(x), y, eff: eff ?? 0.8 });
      line.forEach((a, i) => go(a, 0, clampX(bx + (i - (line.length - 1) / 2) * 15), fwd(L0, -0.3), 0.6));
      go(holder, 0, bx, hL, 0.6);
      if (kicker) go(kicker, 0, bx - 10, fwd(L0, -9.5), 0.6);
      const deepD = K.def.filter((a) => a.label === 'S').slice(0, 1), front = K.def.filter((a) => !deepD.includes(a));
      front.forEach((a, i) => go(a, 0, clampX(bx + (i - (front.length - 1) / 2) * 15), fwd(L0, 0.3), 0.6));
      deepD.forEach((a) => go(a, 0, bx, fwd(L0, 12), 0.6));
      fly(T0, T0 + 0.4, bx, L0, bx, hL, 0.1);
      rest(T0 + 0.4, bx, hL);
      if (kicker) leg(kicker, T0 + 0.35, 'go', { x: yx(bx) - 0.4, y: fwd(L0, -7.6), eff: 0.55 });
      const good = e.ev === 'fg' ? e.made : e.good;
      const miss = good ? 0 : (R() < 0.5 ? -1 : 1);
      const tK = T0 + 1.3, t1 = tK + 0.25 + Math.abs(Ly - hL) / 24;
      // your all-out rush: a block (picked up, and now and then run back), or a roughing flag
      if (e.ev === 'fg' && (e.blocked || e.foul)) {
        const rusher = nearest(front, [yx(bx), hL]) || front[0];
        line.forEach((a) => leg(a, T0 + 0.1, 'go', { x: a.b.x, y: fwd(L0, -1.1), eff: 0.7 }));
        front.forEach((a) => { if (a !== rusher) leg(a, T0 + 0.15, 'go', { x: a.b.x + jit(0.6), y: fwd(L0, -0.6), eff: 0.9 }); });
        if (rusher) { busy.add(rusher); Wd.run(T0 + 0.1); runFrom(rusher, T0 + 0.1, [[yx(bx) + 0.6, fwd(hL, e.foul ? -1.5 : 1.2)]], { T: tK - T0 + (e.foul ? 0.25 : -0.1) }); }
        if (e.foul) {
          fly(tK, t1, bx, hL, 180 + (R() < 0.5 ? -1 : 1) * 30, Ly, 2.4);
          rest(t1, 180, Ly + dir * 1.5);
          flag(tK + 0.4, 'Flag: roughing the kicker');
          P.T = t1 + 0.9;
        } else {
          const bp = [inX(yx(bx) + jit(3)), fwd(hL, 3)];
          fly(tK, tK + 0.35, bx, hL, px(bp[0]), bp[1], 0.3);
          rest(tK + 0.35, px(bp[0]), bp[1]);
          say(tK + 0.1, 'Blocked!', 'hit', { x: bx, L: hL });
          const rec = nearest(front, bp) || rusher;
          if (rec && e.retTd) {
            busy.add(rec);
            Wd.run(tK + 0.4);
            const tH = tK + 0.45 + runFrom(rec, tK + 0.4, [bp], { T: 0.6, v1: 2 }).T;
            hold(tH, rec);
            P.T = returnTd(rec, tH + 0.03, bp, 'Returned for a touchdown!') + 1.0;
          } else {
            if (rec) { busy.add(rec); runFrom(rec, tK + 0.4, [bp], { T: 0.7, v1: 0 }); hold(tK + 1.1, rec); }
            whistle(tK + 1.4, bp);
            P.T = tK + 2.2;
          }
        }
        frozen = false; snapAt = T0;
        bakeSpecial(P.T + 0.2);
        return;
      }
      fly(tK, t1, bx, hL, 180 + miss * 34, Ly, 2.4);
      rest(t1, 180 + miss * 38, Ly + dir * 1.5);
      // the rush: the front pushes into the line, the line holds
      front.forEach((a) => leg(a, T0 + 0.15, 'go', { x: a.b.x + jit(0.6), y: fwd(L0, -0.6), eff: 0.9 }));
      line.forEach((a) => leg(a, T0 + 0.1, 'go', { x: a.b.x, y: fwd(L0, -0.9), eff: 0.7 }));
      if (kicker) leg(kicker, tK + 0.1, 'go', { x: yx(bx), y: fwd(L0, -5.5), eff: 0.4 });
      say(t1, good ? "It's good!" : 'No good', good ? 'good' : 'hit', { x: 180, L: Ly - dir * 6 });
      // the formation shift happens before the snap: start the clock of the play there
      P.T = t1 + 0.7;
      frozen = false; snapAt = T0;
      bakeSpecial(P.T + 0.2);
    }
    function bakeSpecial(T) {
      Wd.run(T);
      sc.actors.forEach((a) => {
        const b = a.b;
        a.trk = { dt: Wd.dt, n: b.hx.length, x: Float32Array.from(b.hx, px), L: Float32Array.from(b.hy), w0: a.w0 ?? 1, wt: snapAt, hold: false };
      });
    }

    function punt() {
      // punt formation: seven on the line, gunners split wide, an up-back, the punter 14 yards deep;
      // the return team: two jammers on the gunners, a returner deep, the rest at the line
      const T0 = 0.8, pL = fwd(L0, -14), Lnew = clip(losOf(res.root), -9, 109);
      const punter = qb || K.off[0], upback = K.rb && K.rb !== punter ? K.rb : null;
      const gunners = K.recv.filter((a) => a.label === 'WR').slice(0, 2);
      const line = K.off.filter((a) => a !== punter && a !== upback && !gunners.includes(a));
      const lineX = [0, -15, 15, -30, 30, -45, 45, -60, 60];
      const go = (a, t, x, y, eff) => leg(a, t, 'go', { x: yx(x), y, eff: eff ?? 0.7 });
      // (both lines are cover men and return blockers, the linebackers, tight ends and backs who play on the punt
      // units: they run like the bigger of those, not like the linemen whose places they take in the lineup)
      K.off.concat(K.def).forEach((a) => { if (a.b.g === 'OL' || a.b.g === 'DL') { a.b.g = 'LB'; a.b.spd *= 0.9; } });
      line.forEach((a, i) => go(a, 0, clampX(bx + lineX[i % lineX.length]), fwd(L0, -0.4)));
      gunners.forEach((a, i) => go(a, 0, i ? SX1 - 20 : SX0 + 20, fwd(L0, -0.4), 0.8));
      go(punter, 0, bx, pL, 0.8);
      if (upback) go(upback, 0, bx + 6, fwd(L0, -5));
      const land = e.touchback ? (dir > 0 ? 104 : -4) : e.retTd ? fwd(pL, 52) : clip(Lnew + dir * 6, -8, 108);
      const lx = clampX(bx + jit(40));
      const ret = K.def.find((a) => a.label === 'S') || K.def.find((a) => a.label === 'CB') || K.def[0];
      const jam = K.def.filter((a) => a.label === 'CB' && a !== ret).slice(0, 2);
      const box = K.def.filter((a) => a !== ret && !jam.includes(a));
      go(ret, 0, clampX(lx + jit(12)), clip(land + dir * 4, -8, 108), 0.9);
      jam.forEach((a, i) => go(a, 0, i ? SX1 - 22 : SX0 + 22, fwd(L0, 1.2), 0.8));
      box.forEach((a, i) => go(a, 0, clampX(bx + lineX[i % lineX.length]), fwd(L0, 0.8)));
      fly(T0, T0 + 0.75, bx, L0, bx, pL, 0.1);
      hold(T0 + 0.75, punter);
      const tK = T0 + 2.0, kL = fwd(pL, 2);       // two steps into the kick
      leg(punter, T0 + 1.1, 'go', { x: yx(bx), y: kL, eff: 0.35 });
      snapAt = T0;
      if (e.blocked || e.foul) {
        Wd.run(T0 + 0.6);
        const blocker = nearest(box, [yx(bx), pL]) || box[0];
        if (blocker) { busy.add(blocker); runFrom(blocker, T0 + 0.6, [[yx(bx) + 0.5, fwd(pL, e.foul ? -0.5 : 1)]], { T: tK - T0 - 0.6 + (e.foul ? 0.3 : 0) }); }
        line.forEach((a) => leg(a, T0 + 0.1, 'go', { x: a.b.x + jit(0.4), y: fwd(L0, -1.2), eff: 0.6 }));
        if (e.foul) {                                   // the kick goes; the rusher runs into the punter: a flag
          fly(tK, tK + 3.6, bx, kL, clampX(bx + jit(40)), fwd(pL, 48), 2.6);
          rest(tK + 3.6, clampX(bx), fwd(pL, 48));
          flag(tK + 0.4, 'Flag: roughing the punter');
          P.T = tK + 2.6;
          bakeSpecial(P.T + 0.2);
          return;
        }
        const bp = [inX(yx(bx) + jit(3)), fwd(pL, -4)];
        fly(tK, tK + 0.35, bx, kL, px(bp[0]), bp[1], 0.2);
        rest(tK + 0.35, px(bp[0]), bp[1]);
        say(tK + 0.05, 'Blocked!', 'hit', { x: bx, L: pL });
        if (e.retTd && blocker) {                       // scooped and run in
          Wd.run(tK + 0.4);
          const tH = tK + 0.45 + runFrom(blocker, tK + 0.4, [bp], { T: 0.5, v1: 2 }).T;
          hold(tH, blocker);
          P.T = returnTd(blocker, tH + 0.03, bp, 'Returned for a touchdown!') + 1.0;
        } else {
          whistle(tK + 0.6, [yx(bx), pL]);
          P.T = tK + 1.4;
        }
        bakeSpecial(P.T + 0.2);
        return;
      }
      const tL = tK + 4.3;
      fly(tK, tL, bx, kL, lx, land, 2.8);
      // coverage: the gunners release at the snap and run under it; the line blocks a beat, then releases
      const LX = yx(lx);
      gunners.forEach((a, i) => leg(a, T0 + 0.1, 'go', { x: LX + (i ? 2.5 : -2.5), y: land - dir * 5, eff: 0.97, stop: false }));
      jam.forEach((a, i) => leg(a, T0 + 0.2, 'mirror', { who: gunners[i] ? gunners[i].b : a.b, lag: 0.25, dx: 0, dy: -dir * 1.0, eff: 0.95 }));
      // (in lanes, flat out: at the catch the first of them are 10 yards or so off the returner, not jogging at midfield)
      line.forEach((a, i) => { leg(a, T0 + 0.1, 'go', { x: a.b.x, y: fwd(L0, -1), eff: 0.5 }); leg(a, T0 + 1.2, 'go', { x: LX + (i - 3) * 3.2, y: lerp(L0, land, 0.85), eff: 0.95 }); });
      box.forEach((a) => { leg(a, T0 + 0.2, 'go', { x: a.b.x, y: fwd(L0, -0.4), eff: 0.6 }); leg(a, T0 + 1.6, 'go', { x: a.b.x * 0.5 + LX * 0.5, y: lerp(L0, land, 0.7), eff: 0.75 }); });
      leg(punter, tK + 0.3, 'go', { x: yx(bx), y: fwd(pL, 6), eff: 0.4 });
      const retSpot = [LX, land];
      runFrom(ret, tL - 1.6, [retSpot], { T: 1.5, v1: 0, eff: 0.6 });
      let t = tL;
      if (!e.touchback) {
        hold(tL, ret);
        ring(tL, ret);
        const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew, xr = inX(LX + jit(5));
        Wd.run(tL);
        const tEnd = runDown(ret, tL + 0.25, [xr, Lr], { td: e.retTd, after: 0.8 });
        if (!e.retTd) down(tEnd + 0.08, ret);
        t = tEnd;
      } else {
        rest(tL, lx, land);
        whistle(tL + 0.2, retSpot);
      }
      say(t, e.retTd ? 'Punt return touchdown!' : e.touchback ? 'Touchback' : `Punt · net ${Math.round(e.net || 0)}`, e.retTd ? 'hit' : 'info',
        { x: 180, L: e.retTd ? (dir > 0 ? 4 : 96) : Lnew });
      P.T = Math.max(P.T, t + 1.0);
      bakeSpecial(P.T + 0.2);
    }

    function kickoff() {
      const Lnew = clip(losOf(res.root), -9, 109);
      const kick = sc.actors.filter((a) => a.off), recv = sc.actors.filter((a) => !a.off);
      const kicker = kick.find((a) => a.label === 'K'), cover = kick.filter((a) => a !== kicker);
      const deep = recv.filter((a) => a.label === 'KR'), front = recv.filter((a) => a.label !== 'KR');
      const goal = dir > 0 ? 100 : 0;
      if (e.onside) {
        // an onside kick: everyone bunches at the ball, the hands team 10-12 yards away
        cover.forEach((a, i) => leg(a, 0, 'go', { x: yx(clampX(bx + (i - 4.5) * 26)), y: fwd(L0, -1), eff: 0.7 }));
        recv.forEach((a, i) => leg(a, 0, 'go', { x: yx(clampX(bx + (i - 5) * 26)), y: fwd(L0, 12 + (i % 2) * 4), eff: 0.8 }));
        if (kicker) leg(kicker, 0.4, 'go', { x: BX, y: fwd(L0, -0.5), eff: 0.6 });
        const l = [inX(BX + jit(4)), fwd(L0, 11)];
        fly(1.15, 2.4, bx, L0, px(l[0]), l[1], 0.25);
        rest(2.4, px(l[0]), l[1]);
        const ours = e.recovered;
        Wd.run(1.15);
        cover.forEach((a) => leg(a, 1.2, 'go', { x: a.b.x + (l[0] - a.b.x) * 0.6, y: a.b.y + (l[1] - a.b.y) * 0.85, eff: 0.95 }));
        front.forEach((a) => leg(a, 1.3, 'go', { x: a.b.x + (l[0] - a.b.x) * 0.5, y: a.b.y + (l[1] - a.b.y) * 0.6, eff: 0.9 }));
        const rec = nearest(ours ? cover : recv, l);
        if (rec) { busy.add(rec); runFrom(rec, 1.3, [l], { T: 1.25, v1: 0 }); hold(2.6, rec); leg(rec, 2.6, 'stand'); }
        say(2.6, ours ? 'Onside kick recovered!' : 'Onside kick: they recover', ours === (e.team === G.me) ? 'good' : 'hit', { x: px(l[0]), L: l[1] });
        whistle(2.7, l);
        P.T = 3.8;
        bakeSpecial(P.T + 0.2);
        return;
      }
      // the kick hangs about four seconds; nobody but the returners moves until it lands or is caught (2024 rules)
      if (kicker) leg(kicker, 0.1, 'go', { x: BX, y: fwd(L0, -0.3), eff: 0.7 });
      const stay = (a, t) => leg(a, t, 'stand');
      cover.concat(front).forEach((a) => stay(a, 0));
      if (e.tb) {          // no return: through the end zone, bounced in from the landing zone, or short of it
        const short = Math.round(res.root.yl) === 60 && res.root.pos !== e.team;
        const through = e.kick === 'touchback' || Math.round(res.root.yl) === 65;
        const lx = clampX(180 + jit(30));
        const land = short ? goal - dir * 24 : through ? goal + dir * 7 : goal - dir * 6;
        const tL = through ? 4.2 : 4.4;
        fly(0.7, tL, bx, L0, lx, land, through ? 3.2 : 3);
        if (!through && !short) { fly(tL, tL + 1.2, lx, land, clampX(lx + jit(16)), goal + dir * 4, 0.15); }
        rest(through ? tL : tL + (short ? 0 : 1.2), lx, short ? land : goal + dir * (through ? 7 : 4));
        const ret = nearest(deep, [yx(lx), land]) || deep[0];
        if (ret) leg(ret, 1.2, 'go', { x: yx(lx) + jit(1.5), y: short ? land - dir * 1 : goal - dir * 2, eff: 0.75 });
        // once it lands the coverage runs down, then eases up
        cover.forEach((a) => { leg(a, tL + 0.1, 'go', { x: a.b.x + jit(2), y: fwd(a.b.y, 6 + R() * 4), eff: 0.6 }); leg(a, tL + 1.6, 'stand'); });
        front.forEach((a) => { leg(a, tL + 0.2, 'go', { x: a.b.x, y: fwd(a.b.y, 2), eff: 0.4 }); leg(a, tL + 1.2, 'stand'); });
        say(tL + (through || short ? 0.2 : 1.3), short ? 'Short of the landing zone' : 'Touchback', 'info', { x: 180, L: goal - dir * 10 });
        P.T = tL + (through || short ? 1.4 : 2.2);
        bakeSpecial(P.T + 0.2);
        return;
      }
      const land = dir > 0 ? 97 : 3, lx = clampX(180 + jit(40)), tL = 4.6, LX = yx(lx);
      fly(0.7, tL, bx, L0, lx, land, 3);
      const ret = nearest(deep, [LX, land]) || deep[0];
      const lead = deep.find((a) => a !== ret);
      if (ret) follow(ret, 1.0, plan(ret, [here(ret), [LX, land]], { T: tL - 1.0, v1: 0, eff: 0.7 }));
      if (lead) leg(lead, 1.6, 'go', { x: LX + 4, y: land + dir * 7, eff: 0.6 });
      // the ball comes down: the coverage sprints, the setup zone turns and blocks
      cover.forEach((a) => leg(a, tL - 0.1 + R() * 0.2, 'go', { x: a.b.x + (LX - a.b.x) * 0.55, y: lerp(a.b.y, land, 0.7), eff: 0.95, stop: false }));
      front.forEach((a, i) => {
        const foe = cover[i % Math.max(1, cover.length)];
        leg(a, tL - 0.2, 'chase', { who: foe.b, gap: 1.0, eff: 0.8, lead: 0.5 });
      });
      if (ret) {
        hold(tL, ret);
        ring(tL, ret);
        const Lr = e.retTd ? (dir > 0 ? -3 : 103) : Lnew, xr = inX(LX + jit(6));
        Wd.run(tL);
        const tEnd = runDown(ret, tL + 0.2, [xr, Lr], { td: e.retTd, after: 0.8 });
        if (!e.retTd) down(tEnd + 0.08, ret);
        say(tEnd, e.retTd ? 'Kick return touchdown!' : `${teamName(code(res.root.pos))} ball at ${spotText(res.root)}`,
          e.retTd ? (e.team === G.me ? 'hit' : 'good') : 'info', { x: 180, L: Lr });
        P.T = tEnd + 1.1;
      } else P.T = tL + 1.5;
      bakeSpecial(P.T + 0.2);
    }

    // the camera: the ball and whoever has it, and everyone within 12 yards of that, with room around it
    function finishCamera() {
      const ballLs = [L0], segs = P.segs.slice().sort((a, b) => a.t0 - b.t0);
      segs.forEach((s, i) => {
        if (s.kind === 'fly') ballLs.push(s.L0, s.L1);
        else if (s.kind === 'rest') ballLs.push(s.L);
        else if (s.kind === 'hold' && s.a.trk) {
          const k = s.a.trk, t1 = i + 1 < segs.length ? segs[i + 1].t0 : P.T;
          for (let j = Math.floor(s.t0 / k.dt); j <= Math.min(k.n - 1, Math.ceil(t1 / k.dt)); j += 2) ballLs.push(k.L[j]);
        }
      });
      const blo = Math.min(...ballLs) - 12, bhi = Math.max(...ballLs) + 12, Ls = ballLs.slice();
      sc.actors.forEach((a) => {
        const k = a.trk;
        if (!k) return;
        const n = Math.min(k.n, Math.ceil(P.T / k.dt) + 1);
        for (let i = 0; i < n; i += 4) Ls.push(clip(k.L[i], blo, bhi));
      });
      let lo = Math.min(...Ls) - 5, hi = Math.max(...Ls) + 5;
      const span = clip(hi - lo, 36, 120), mid = (lo + hi) / 2;
      lo = mid - span / 2; hi = mid + span / 2;
      if (lo < -10) { hi += -10 - lo; lo = -10; }
      if (hi > 110) { lo -= hi - 110; hi = 110; }
      P.cam = { lo: Math.max(lo, -10), hi: Math.min(hi, 110) };
      P.segs.sort((a, b) => a.t0 - b.t0);
      return P;
    }
  }

  // clk: the game clock before the step (t0), at the snap and after the play; the time that runs off before
  // the snap ticks away first (fast, while the players set), then the play's own time as it is run
  function runPlan(sc, P, speed, clk) {
    const runoff = clk ? Math.max(0, clk.t0 - clk.snap) : 0;
    const PRE = runoff >= 1 ? clip(0.4 + runoff / 30, 0.55, 1.5) : 0;
    const ZI = 0.6, ZO = 0.5, total = PRE + ZI + P.T + P.hold + ZO;
    const ck = clk ? document.querySelector('#bar .clk') : null;
    return new Promise((resolve) => {
      let start = null, skip = false;
      const onTap = () => { skip = true; };
      cutAnim = onTap;
      sc.calls.forEach((c) => c.g.remove());        // a pre-play label ("Kickoff") gives way to the play's own call-outs
      sc.calls = [];
      sc.svg.classList.add('playing');
      sc.svg.addEventListener('click', onTap);
      const frame = (now) => {
        if (start === null) start = now;
        const t = skip ? total : ((now - start) / 1000) * speed, tt = t - PRE;
        const k = EASE.io(clip(tt / ZI, 0, 1)) * (1 - EASE.io(clip((tt - ZI - P.T - P.hold) / ZO, 0, 1)));
        const c0 = sc.cam0 || FULL;            // from the pre-snap frame into the play's, and back
        sc.cam = { lo: lerp(c0.lo, P.cam.lo, k), hi: lerp(c0.hi, P.cam.hi, k) };
        const tp = clip(tt - ZI, 0, P.T);
        if (ck) {
          const gt = t < PRE ? lerp(clk.t0, clk.snap, EASE.io(t / PRE)) : lerp(clk.snap, clk.end, clip((tt - ZI) / (P.T + P.hold), 0, 1));
          ck.textContent = clockOf(Math.max(gt, clk.end)).text;
          ck.classList.toggle('tick', t < PRE);
        }
        sc.actors.forEach((a) => { const p = at(a, tp); a.x = p.x; a.L = p.L; a.w = p.w; });
        Object.assign(sc.ball, ballAt(sc, P, tp));
        P.calls.forEach((c) => { if (!c.shown && tp >= c.t) { c.shown = true; showCall(sc, c); } });
        P.fx.forEach((f) => { if (!f.done && tp >= f.t) { f.done = true; f.f(); } });
        place(sc);
        if (t >= total) {
          if (cutAnim === onTap) cutAnim = null;
          sc.svg.removeEventListener('click', onTap);
          sc.svg.classList.remove('playing');
          if (ck) ck.classList.remove('tick');
          resolve();
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  // play one snap on the field: `before` is the state it was snapped from, `side` its strong side
  async function animatePlay(before, res, side, replay, look) {
    if (!replay) await cutReplay();
    if (reduced() || (G.fast && !replay) || $('play').hidden) return false;
    const e = res.log.find((x) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(x.ev));
    if (!e) return false;
    const two = e.ev === 'pat' && e.two;
    let sc, P = null;
    try {
      if (two) {           // a two-point try is a snap from the 2: a pass that scores or does not
        sc = makeScene({ ...before, phase: SNAP, yl: 2, ytg: 2, down: 1 }, side);
        const ci = e.call >= 0 ? e.call : idx.calls.findIndex((c) => c.id === 'quick_strong');
        const run = idx.calls[ci] && idx.calls[ci].kind === 'run';
        const q = run ? { ev: 'play', team: e.team, kind: RUN, call: ci, yards: e.good ? 3 : 0, td: e.good, row: -1, t: before.t }
          : { ev: 'play', team: e.team, kind: PASS, call: ci, yards: e.good ? 4 : 0, air: 4, incomplete: !e.good, td: e.good, row: -1, t: before.t, philly: !!e.philly };
        P = choreograph(sc, q, res, true);
      } else {
        sc = makeScene(before, side, look);
        P = choreograph(sc, e, res, false);
      }
    } catch (err) { console.warn('animation skipped:', err); P = null; }
    scene = sc;
    if (!P) return false;
    sc.svg.querySelectorAll('.nm').forEach((t) => t.classList.add('gone'));     // the names drop at the snap
    // the clock at the snap: after the runoff, or after a timeout called before it (a kick to win), else as it was
    const k0 = res.log.findIndex((x) => x.ev !== 'runoff' && x.ev !== 'timeout');
    const pre = k0 < 0 ? res.log : res.log.slice(0, k0), ro = pre.find((x) => x.ev === 'runoff');
    const tos = pre.filter((x) => x.ev === 'timeout'), snapT = ro ? ro.t : tos.length ? tos[tos.length - 1].t : before.t;
    const clk = { t0: before.t, snap: snapT, end: Math.min(res.root.t, snapT) };
    await runPlan(sc, P, PLAY_SPEED * playSpeed(), clk);
    fadeNext = true;
    lastBall = null;
    return true;
  }

  // the in-depth view: the 22 up close with every rating, and every player listed
  function drawZoom(svg) {
    const r = G.root;
    svg.textContent = '';
    const FH = 336, PPY = 12.2, LOS_Y = 212, PR = 11.5;
    const offI = offenseOf(r);
    const s = r.phase === SNAP ? G.side : 1;
    const bx = r.phase === SNAP ? (s > 0 ? HASH_L : HASH_R) : 180;
    svg.append(S('rect', { x: 0, y: 0, width: 360, height: FH, fill: 'var(--turf)' }));
    const own = r.phase === KICKOFF ? 25 : r.phase === PAT ? 85 : 100 - r.yl;
    for (let L = 0; L <= 100; L += 5) {
      const y = LOS_Y - (L - own) * PPY;
      if (y < -2 || y > FH + 2) continue;
      svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chalk)', 'stroke-width': L % 50 === 0 ? 2.4 : 1.2 }));
      if (L % 10 === 0 && L > 0 && L < 100 && y > 12 && y < FH - 12) {
        const n = String(L <= 50 ? L : 100 - L);
        svg.append(S('text', { x: SX0 + 50, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(-90 ${SX0 + 50} ${y})` }, n));
        svg.append(S('text', { x: SX1 - 50, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(90 ${SX1 - 50} ${y})` }, n));
      }
    }
    svg.append(S('line', { x1: SX0, y1: LOS_Y, x2: SX1, y2: LOS_Y, stroke: 'var(--los)', 'stroke-width': 3 }));
    if (r.phase === SNAP && r.ytg < r.yl - 0.01) {
      const y = LOS_Y - r.ytg * PPY;
      if (y > 4) svg.append(S('line', { x1: SX0, y1: y, x2: SX1, y2: y, stroke: 'var(--chain)', 'stroke-width': 3 }));
    }
    const f = formation(offLineup(offI).slice(), lineup(1 - offI).def.slice(), s, bx);
    const put = (o, isOff, team, mine) => {
      const y = isOff ? LOS_Y + o.d * PPY : LOS_Y - o.d * PPY;
      const g = S('g', { class: `pl${mine ? ' me' : ''}`, transform: `translate(${o.x.toFixed(1)},${y.toFixed(1)})`, tabindex: 0, role: 'button',
        'aria-label': `${teamName(team)} ${POS_NAME[o.label] || o.label} ${o.p.name}, rated ${o.p.ovr}` });
      g.append(S('circle', { r: PR, fill: rate(o.p.ovr) }),
        S('text', { class: 'n', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', style: 'paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px' }, String(o.p.ovr)),
        S('text', { class: 'pos', 'text-anchor': 'middle', y: isOff ? PR + 9 : -PR - 4 }, o.label));
      const open = () => playerInfo(o.p, o.label, team);
      g.addEventListener('click', open);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      svg.append(g);
    };
    f.def.forEach((o) => put(o, false, code(1 - offI), 1 - offI === G.me));
    f.off.forEach((o) => put(o, true, code(offI), offI === G.me));
  }
  const offenseOf = (r) => (r.phase === KICKOFF ? 1 - r.pos : r.pos);     // at a kickoff, the team about to get the ball
  function openDeep() {
    const r = G.root, offI = offenseOf(r);
    $('deepNote').textContent = `${teamName(code(offI))} ball${r.phase === KICKOFF ? ' after the kickoff' : ''}. Every player's overall rating, 40 to 99 (a typical starter is 77), and his type. Tap anyone for more.`;
    drawZoom($('zoom'));
    const u = $('units');
    u.textContent = '';
    const unit = (title, list, team) => {
      const d = el('div', 'unit');
      d.append(el('h3', '', title));
      const ul = el('ul');
      list.forEach((p) => {
        const li = el('li'), b = el('button');
        b.type = 'button';
        const ch = el('span', 'chipn', String(p.ovr)); ch.style.background = rate(p.ovr);
        const nm = el('span', 'nm', p.name);
        if (p.kind) nm.append(el('small', '', p.kind));
        b.append(ch, el('span', 'ps', p.pos), nm);
        b.addEventListener('click', () => playerInfo(p, p.pos, team));
        li.append(b); ul.append(li);
      });
      d.append(ul);
      return d;
    };
    const t = (i) => teamOf(i);
    const spec = (i) => [{ ...t(i).kicker, pos: 'K', ovr: t(i).kicker.ovr ?? 77, stat: t(i).kicker.stat || 'Rated on field goals made over expected' },
      { ...t(i).punter, pos: 'P', ovr: t(i).punter.ovr ?? 77, stat: t(i).punter.stat || 'Rated on net punting over expected' }];
    u.append(unit(`${teamName(code(offI))} offense`, offLineup(offI), code(offI)),
      unit(`${teamName(code(1 - offI))} defense`, lineup(1 - offI).def, code(1 - offI)),
      unit('Kickers and punters', [...spec(G.me).map((p) => ({ ...p, name: `${p.name} (${code(G.me)})` })),
        ...spec(1 - G.me).map((p) => ({ ...p, name: `${p.name} (${code(1 - G.me)})` }))], null));
    lastFocus = document.activeElement;
    $('deep').hidden = false;
    $('deepClose').focus();
  }
  function closeDeep() { $('deep').hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }

  // ------------------------------------------------------------ chrome ---
  function drawTiles() {
    const t = $('tiles');
    t.textContent = '';
    if (SURV) {                 // the run so far: a square per game (the last 7), then the game being played
      const g = state.games, from = Math.max(0, g.length - 7);
      t.setAttribute('aria-label', `Survivor: ${state.won} win${state.won === 1 ? '' : 's'}`);
      if (from) t.append(el('span', 'more', `+${from}`));
      g.slice(from).forEach((x) => {
        const b = el('span', `done sq ${x.w ? 'g' : x.tie ? 'y' : 'r'}`, x.w ? 'W' : x.tie ? 'T' : 'L');
        b.title = `${x.tag}: ${x.w ? 'won' : x.tie ? 'tied' : 'lost'} ${x.mine}–${x.theirs}${x.ot ? ' in overtime' : ''}`;
        t.append(b);
      });
      if (!state.out && G) { const b = el('span', 'on', String(g.length + 1)); b.title = `Game ${g.length + 1}: playing`; t.append(b); }
      return;
    }
    t.hidden = today.length < 2;          // one drive a day: nothing to count
    for (let i = 0; i < today.length; i++) {
      const s = state.spots[i];
      const b = el('span', '', String(i + 1));
      if (s && s.over) { b.className = `done sq ${spotMark(s)}`; b.title = `Spot ${i + 1}: done`; }
      else if (G && G.si === i && !state.done) { b.className = 'on'; b.title = `Spot ${i + 1}: playing`; }
      t.append(b);
    }
  }
  function spotMark(s) {
    const w = (s.decisions || []).reduce((a, x) => a + x.wpa, 0);
    return w >= 0.01 ? 'g' : w >= -0.01 ? 'y' : w >= -0.04 ? 'o' : 'r';
  }
  function drawBar() {
    const r = G.root, b = $('bar');
    b.textContent = '';
    const side = (i, right) => {
      const c = code(i), d = el('span', `tm${right ? ' r' : ''}`);
      const sw = el('span', 'tsw'); sw.style.background = color(c);
      const meta = el('span');
      const tos = el('span', 'tos');
      for (let k = 0; k < 3; k++) tos.append(el('i', k < r.to[i] ? '' : 'used'));
      const ab = el('span', 'ab', c);
      if (i === G.me) ab.append(el('small', '', 'YOU'));
      meta.append(ab, tos);
      d.append(sw, meta);
      if (r.pos === i && r.phase !== DONE) d.append(el('span', 'poss'));
      d.append(el('span', 'sc', String(r.score[i])));
      return d;
    };
    const ck = clockOf(r.t), over = r.phase === DONE;
    const mid = el('span', 'mid');
    if (G.cot) mid.append(el('span', 'q', over ? (G.cot.round > 1 ? `FINAL/${G.cot.round}OT` : 'FINAL/OT') : `${G.cot.round > 1 ? G.cot.round : ''}OT`),
      el('span', 'clk', over ? '' : G.cot.round >= 3 ? 'Two-point' : `${G.cot.idx ? '2nd' : '1st'} poss`));
    else mid.append(el('span', 'q', over ? (r.t >= 1800 ? 'HALF' : r.ot ? 'FINAL/OT' : needsOvertime(r) ? 'END Q4' : 'FINAL') : qLabel(r)),
      el('span', `clk${r.clock_running && !over ? ' run' : ''}`, over ? '0:00' : ck.text));
    b.append(side(1, false), mid, side(0, true));
    b.setAttribute('aria-label', `${code(1)} ${r.score[1]}, ${code(0)} ${r.score[0]}, ${ck.text} left in ${r.ot ? 'overtime' : `the ${ordinal(ck.q)} quarter`}. Game details`);
    const dd = $('dd');
    dd.textContent = '';
    if (r.phase === SNAP) dd.append(el('b', '', r.try2 ? 'Two-point try' : ddText(r)), document.createTextNode(` · ${spotText(r)}${VS ? '' : ` · clock ${r.clock_running ? 'running' : 'stopped'}`}`));
    else dd.textContent = r.phase === PAT ? 'Try after the touchdown' : r.phase === KICKOFF ? 'Kickoff' : r.t >= 1800 ? 'Halftime' : 'Final';
  }
  function drawAll() { drawTiles(); drawBar(); drawField(); }
  function show(which) {
    $('arch').hidden = which !== 'arch';
    $('intro').hidden = which !== 'intro';
    $('play').hidden = which !== 'play';
    $('done').hidden = which !== 'done';
    $('boot').hidden = which !== 'boot';
  }

  function addLog(text, t, mine) {
    const li = el('li');
    li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
    $('pbp').prepend(li);
    G.log.push([text, t, !!mine]);
  }
  function restoreLog() {
    $('pbp').textContent = '';
    G.log.forEach(([text, t, mine]) => {
      const li = el('li');
      li.append(el('span', 't', t == null ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
      $('pbp').prepend(li);
    });
  }
  function status(text, line, skip) {
    const d = $('dock');
    d.textContent = '';
    const s = el('div', 'status');
    s.append(el('span', 'spin'), el('span', '', text));
    d.append(s);
    if (line) d.append(el('div', 'feedline', line));
    if (skip) {
      const c = el('button', 'chip', 'Skip ahead');
      c.type = 'button';
      c.addEventListener('click', () => { G.fast = true; c.disabled = true; });
      d.append(c);
    }
  }
  function fatal(msg) {
    show('play');
    const d = $('dock');
    d.textContent = '';
    d.append(el('p', 'err', msg));
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ------------------------------------------------------------ narration ---
  function lookText(k, e) {
    if (e && e.dc) return ` (${k && k.form ? `${k.form}, ` : ''}against ${vdefName('pers', e.dc.pers).toLowerCase()} ${vdefName('cover', e.dc.cover)}, ${e.dc.rush >= 6 ? '6+' : e.dc.rush} rushing)`;
    if (!k || (!k.form && !k.box)) return '';
    const bits = [];
    if (k.form) bits.push(k.form);
    if (k.box) bits.push(`${k.box} in the box`);
    if (k.blitz) bits.push('blitz');
    return ` (${bits.join(', ')})`;
  }
  function playLine(e, act) {
    const mine = e.team === G.me, nm = names(e.team);
    const who = teamName(code(e.team));
    if (e.kind === SPIKE) return `${who} spike it, clock stopped`;
    if (e.kind === KNEEL) return `${who} kneel, clock ${e.running ? 'running' : 'stopped'}`;
    let what;
    if (mine && act && act.targetName && act.route && e.call >= 0) {       // your pass: to the receiver you picked, on his route
      const to = shortName(act.targetName) || act.targetPos;
      what = `${nm.qb || `The ${who}`} ${act.pa ? 'fakes the handoff, then looks for' : act.roll ? 'rolls out and looks for' : 'looks for'} ${to} on ${routeSay(act.targetPos, act.route)}${e.row >= 0 ? lookText(e.look, e) : ''}`;
    } else if (e.call >= 0) {
      const c = idx.calls[e.call];
      const actor = c.id.startsWith('rb_') ? nm.rb : nm.qb;
      what = `${TRICK_SAY[c.id] ? `The ${who} ${TRICK_SAY[c.id]}` : `${actor || `The ${who}`} ${c.say}`}${e.row >= 0 ? lookText(e.look, e) : ''}`;
    } else what = `${nm.qb || who} ${e.kind === RUN ? 'hands off' : 'drops back'}`;
    const y = Math.round(e.td && !e.turnover ? e.yl : e.yards);      // a touchdown gains the distance to the goal line
    const gain = y > 0 ? `${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `loss of ${-y}` : 'no gain';
    let res;
    if (e.penalty) res = `flag, ${e.pen || 'penalty'}: ${y >= 0 ? `+${y}` : y} yards`;
    else {
      res = { bad_snap: e.turnover ? 'bad snap, the defense recovers' : `bad snap, the offense falls on it: ${gain}`,
        strip_sack: e.tdDef ? 'strip-sack, returned for a touchdown' : 'strip-sack, fumble lost',
        sack_fumble: `sacked and fumbles, but the offense recovers: ${gain}`, sack: `sacked, ${gain}`,
        pick_six: 'intercepted and returned for a touchdown', interception: 'intercepted',
        scoop_score: 'fumble, scooped and returned for a touchdown', fumble_lost: 'fumble, lost',
        fumble_kept: `fumbles, but the offense recovers: ${gain}`,
        scramble: e.td ? `scrambles ${y} yards for a touchdown` : `pressure, scrambles: ${gain}`,
        throwaway: y < 0 ? `pressure, intentional grounding: ${gain}` : 'pressure, throws it away', drop: 'dropped, incomplete', near_pick: 'nearly intercepted, incomplete' }[e.evt];
    }
    // a fumble he made only after crossing the goal line is just the touchdown (engine.js scores it that way)
    if (e.td && !e.turnover && /fumble|scoop|strip/.test(e.evt || '')) res = null;
    if (!res) {
      if (e.turnover) res = e.tdDef ? 'turnover, returned for a touchdown' : e.kind === PASS ? 'intercepted' : 'fumble, lost';
      else if (e.td) res = `${y}-yard touchdown`;
      else if (e.incomplete) res = 'incomplete';
      else res = gain;
    } else if (e.td && !/touchdown/.test(res)) res += `, ${y}-yard touchdown`;
    // the engine decides the score: a turnover it returned for a touchdown says so, whatever the real play's label
    if (e.tdDef && !/touchdown/.test(res)) res = e.kind === PASS && !/fumble|bad snap|strip/.test(res) ? 'intercepted and returned for a touchdown' : `${res.split(',')[0]}, returned for a touchdown`;
    const extra = [];
    if (e.oob && !e.incomplete) extra.push('out of bounds');
    else if (act && act.oob && mine && !e.incomplete && !e.penalty && !e.turnover && !e.td && !e.safety) extra.push('could not get out of bounds');
    if (e.fd && !e.td) extra.push(e.penalty ? 'automatic first down' : 'first down');
    if (e.onDowns) extra.push('turnover on downs');
    if (e.safety) extra.push('safety');
    if (!e.td && !e.turnover && !e.onDowns && !e.safety) extra.push(e.running ? 'clock running' : 'clock stopped');
    return `${what}: ${res}${extra.length ? ', ' + extra.join(', ') : ''}`;
  }
  function narrate(log, act) {
    const out = [];
    for (const e of log) {
      let text = null, t = e.t;
      switch (e.ev) {
        case 'timeout': text = `Timeout, ${teamName(code(e.team))}${e.why === 'kick' ? ' (to set up the kick)' : ''}`; break;
        case 'runoff':
          if (e.stop === '2mw') text = 'Two-minute warning';
          else if (e.stop === 'quarter') text = 'End of the quarter';
          else if (e.secs >= 3 && !e.kneel && !e.spike) text = `Clock runs ${Math.ceil(e.t + e.secs - 1e-6) - Math.ceil(e.t - 1e-6)} seconds`;   // as the scoreboard reads
          break;
        case 'play': text = playLine(e, act); break;
        case 'fg': text = e.foul ? `Roughing the kicker on the ${teamName(code(1 - e.team))}: 15 yards and a first down`
          : `${shortName(teamOf(e.team).kicker.name) || teamName(code(e.team))} ${Math.round(e.dist)}-yard field goal: ${e.made ? 'good' : e.blocked ? `blocked${e.retTd ? ', returned for a touchdown' : ''}` : 'no good'}`; t = null; break;
        case 'punt': text = e.foul ? `Roughing the punter on the ${teamName(code(1 - e.team))}: 15 yards and a first down` : e.blocked ? `${teamName(code(e.team))} punt blocked${e.retTd ? ', returned for a touchdown' : ''}` : e.retTd ? `${teamName(code(e.team))} punt returned for a touchdown` :
          `${teamName(code(e.team))} punt${e.touchback ? ', touchback' : `, net ${Math.round(e.net)} yards`}`; t = null; break;
        case 'pat': text = e.two ? `Two-point try${e.philly ? ' (Philly Special)' : e.call >= 0 && idx.calls[e.call] ? ` (${idx.calls[e.call].label})` : ''} ${e.good ? 'good' : 'fails'}`
          : `Extra point ${e.good ? 'good' : 'no good'}`; break;
        case 'kickoff': text = e.onside ? `Onside kick, recovered by the ${teamName(code(e.recovered ? e.team : 1 - e.team))}` :
          e.retTd ? 'Kickoff returned for a touchdown' : `Kickoff${e.tb ? (Math.round(e.yl) === 60 ? ', short of the landing zone' : ', touchback') : ''}: the ${teamName(code(1 - e.team))} start at their own ${Math.round(100 - e.yl)}`; break;
        case 'end': text = (e.t ?? G.root.t) >= 1800 ? 'Halftime' : e.ot ? 'Ballgame' : G.root.ot ? 'End of overtime' : 'End of regulation'; break;
        case 'period': text = `End of the period, still tied: on to OT${e.n}`; break;
        default: break;
      }
      if (text) out.push([text, t, e.team === G.me]);
    }
    return out;
  }
  function headline(e, log) {
    if (!e) return (log || []).some((x) => x.ev === 'end') ? 'Time ran out' : 'Timeout';
    if (e.ev === 'fg') return e.foul ? 'Roughing the kicker' : e.made ? `${Math.round(e.dist)}-yard field goal is good` : e.blocked ? (e.retTd ? 'Blocked and returned for a TD' : 'Field goal blocked') : 'Field goal: no good';
    if (e.ev === 'punt') return e.foul ? 'Roughing the punter' : e.blocked ? (e.retTd ? 'Blocked and returned for a TD' : 'Punt blocked') : e.retTd ? 'Punt return touchdown' : `Punt, net ${Math.round(e.net || 0)}`;
    if (e.ev === 'pat') return e.two ? (e.good ? 'Two-point try good' : 'Two-point try fails') : (e.good ? 'Extra point good' : 'Extra point missed');
    if (e.ev === 'kickoff') return e.onside ? (e.recovered ? 'Onside kick recovered' : 'Onside kick: they recover') : e.retTd ? 'Returned for a touchdown'
      : e.tb ? (Math.round(e.yl) === 60 ? 'Short kick: ball at the 40' : 'Touchback') : 'Kickoff';
    if (e.kind === SPIKE) return 'Spiked';
    if (e.kind === KNEEL) return 'Kneel';
    const y = Math.round(e.yards);
    if (e.penalty) return 'Flag';
    if (e.tdDef) return 'Defensive touchdown';
    if (e.turnover) return { strip_sack: 'Strip-sack', fumble_lost: 'Fumble', bad_snap: 'Bad snap' }[e.evt] || (e.kind === PASS ? 'Intercepted' : 'Fumble');
    if (e.td) return 'Touchdown';
    if (e.safety) return 'Safety';
    if (e.evt === 'sack' || e.evt === 'sack_fumble') return `Sacked, −${Math.abs(y)}`;
    if (e.incomplete) return e.evt === 'drop' ? 'Dropped' : e.evt === 'throwaway' ? 'Thrown away' : 'Incomplete';
    const yd = y > 0 ? `+${y} yard${y === 1 ? '' : 's'}` : y < 0 ? `−${-y} yard${y === -1 ? '' : 's'}` : 'No gain';
    return e.onDowns ? `${yd}, turnover on downs` : e.fd ? `${yd}, first down` : yd;
  }

  // ------------------------------------------------------------- the spot ---
  function newSpot(i) {
    const sc = today[i];
    return { si: i, scen: sc, me: VS ? vs.seat : sc.player === sc.home ? 0 : 1, root: startRoot(sc), decisions: [], log: [],
      seq: 0, snapN: 0, over: false, result: null, side: 1, fast: false, started: false, vsN: 0, ...(VS && vs.ms ? { root: vs.ms.root, cot: vs.ms.cot } : {}) };
  }
  function persist() {
    state.spots[G.si] = { id: G.scen.id, root: G.root, decisions: G.decisions, log: G.log, seq: G.seq, snapN: G.snapN, over: G.over,
      result: G.result, started: G.started, pending: G.pending || null, pers: G.pers || null, persWho: G.persWho || null, vsN: G.vsN || 0, cot: G.cot || null };
    saveState();
  }
  function resumeSpot(i) {
    G = newSpot(i);
    let s = state.spots[i];
    if (s && s.id && s.id !== G.scen.id) s = state.spots[i] = null;   // saved on another game (a changed schedule): start fresh
    if (s) Object.assign(G, { root: s.root, decisions: s.decisions || [], log: s.log || [], seq: s.seq || 0, snapN: s.snapN || 0,
      over: s.over, result: s.result, started: !!s.started, pending: s.pending || null, pers: s.pers || null, persWho: s.persWho || null, vsN: s.vsN || 0, cot: s.cot || G.cot || null });
    G.side = sideFor(G.seq);
    return G;
  }
  function openSpot(i) {
    resumeSpot(i);
    lastBall = null;
    if (G.started || G.over) return enterField();
    renderIntro();
  }
  // the real game a spot comes from: "2023 · Week 14" or "2024 · Divisional Round"
  const ROUND = { WC: 'Wild Card Round', DIV: 'Divisional Round', CON: 'Conference Championship', SB: 'Super Bowl' };
  const COLLEGE_ROUND = { B1G: 'Big Ten Championship' };
  function gameTag(sc) {
    const rl = sc.real || {};
    return `${rl.season} · ${ROUND[rl.type] || COLLEGE_ROUND[rl.type] || `Week ${rl.week}`}`;
  }
  const matchLine = (sc) => (sc.neutral ? `${teamName(sc.away)} vs ${teamName(sc.home)}${sc.site ? ` · ${sc.site}` : ''}` : `${teamName(sc.away)} at ${teamName(sc.home)}`);
  // the kind of spot, as this one is: "Tied, or end of the half" says which ("End of the half" above "Down by 4")
  const catLabel = (sc) => (sc.category !== 'tight' ? idx.categories[sc.category] : sc.start.qtr <= 2 ? 'End of the half' : 'Tied game');
  function renderIntro() {
    const sc = G.scen, r = G.root, box = $('intro');
    box.textContent = '';
    show('intro');
    drawTiles();
    const me = code(G.me), op = code(1 - G.me);
    const lead = r.score[G.me] - r.score[1 - G.me], ck = clockOf(r.t);
    const left = `${ck.text} left in ${ck.q === 4 ? 'the game' : ck.q === 2 ? 'the half' : ck.q === 3 ? 'the third quarter' : 'the first quarter'}`;
    const state_ = lead > 0 ? `Up by ${lead}` : lead < 0 ? `Down by ${-lead}` : 'Tied';
    const big = el('div', 'big', state_);
    big.append(el('span', 'left', left));
    if (VS) return renderVsIntro();
    box.append(el('div', 'cat', SURV ? `Survivor · Game ${state.games.length + 1}` : DRIVE ? 'Historic drive'
      : RUN_N ? `${PRO_RUNS.runs[RUN_N - 1].title} · Game ${G.si + 1} of ${today.length} · ${PRO_RUNS.runs[RUN_N - 1].games[G.si].round}`
        : (today.length > 1 ? `Spot ${G.si + 1} of ${today.length} · ` : ARCH_DAY ? `No. ${dayN}, from the archive · ` : 'Today’s drive · ') + catLabel(sc)),
      el('div', 'game', `${gameTag(sc)} · ${matchLine(sc)}`), big);
    const mu = el('div', 'matchup');
    const t = (c, i) => {
      const d = el('div', 't');
      const sw = el('span', 'sw', c); sw.style.background = color(c);
      d.append(sw, el('span', 'nm', teamName(c)));
      if (i === G.me) d.append(el('span', 'you', 'YOU'));
      return d;
    };
    mu.append(t(code(1), 1), el('div', 'sc', `${r.score[1]}–${r.score[0]}`), t(code(0), 0));
    box.append(mu);
    const facts = el('div', 'chips');
    const tos = (n) => (n ? `${n} timeout${n === 1 ? '' : 's'}` : 'no timeouts');
    [`${r.pos === G.me ? 'Your' : `${teamName(op)}`} ball, ${ddText(r)} ${onSpot(r)}`, `You: ${tos(r.to[G.me])}`,
      `${teamName(op)}: ${tos(r.to[1 - G.me])}`].forEach((f) => facts.append(el('span', '', f)));
    box.append(facts);
    const rc = (sc.real || {}).coach, feat = !SURV && idx.featured && idx.featured[dayN];
    if (feat && feat.note && idx.spots[feat.spot] && idx.spots[feat.spot].id === sc.id) box.append(el('p', 'story', feat.note));
    else if (sc.story) box.append(el('p', 'story', sc.story));
    box.append(el('div', 'who', VS ? `You're the ${teamName(me)}. Your opponent has the ${teamName(op)}: they call their side, you call yours.`
      : `You're calling it for the ${teamName(me)}.${rc ? ` Can you do better than ${rc} did?` : ''}`));
    if (SURV) box.append(el('div', 'who surv', 'Win to stay alive. Lose and your run is over. Tied at the end: overtime.'));
    const go = el('button', 'btn', 'Next');
    go.type = 'button';
    go.addEventListener('click', () => {
      if (!G.started) {
        track('drive_start', { mode: modeName(), kind: sc.category, day: dayN });
        Object.assign(liveDrive, { on: true, calls: 0, t0: performance.now(), kind: sc.category });
      }
      G.started = true; persist(); enterField();
    });
    box.append(go);
    const rl = sc.real || {};
    box.append(el('div', 'from', `The real score, clock, ball and timeouts from that game, with the players who were on the field and how good they were that week.`));
    box.append(el('div', 'from legal', 'Fan-made. Not affiliated with or endorsed by the NFL or its teams.'));
    go.focus({ preventScroll: true });
  }
  async function enterField() {
    show('play');
    restoreLog();
    if (!G.log.length) addLog(`${teamName(code(G.root.pos))} ball, ${ddText(G.root)} ${onSpot(G.root)}`, G.root.t, G.root.pos === G.me);
    drawAll();
    if (G.pending) {
      busy = true;
      // a saved grade that can't be redone (an error, or a call from an older build) is dropped, not retried on
      // every reload: the drive goes on without that one call's grade
      try { await finishPending(); } catch (e) { G.pending = null; persist(); }
      finally { busy = false; }
      drawTiles();
    }
    if (G.over) finishSpot(); else advance();
  }

  async function advance() {
    while (true) {
      const r = G.root;
      G.side = sideFor(G.seq);
      drawAll();
      if (r.phase === DONE) return finishSpot();
      if (VS) { if ((await vsAdvance(r)) === 'stop') return; continue; }
      if (G.cot) { if ((await cotAdvance(r)) === 'stop') return; continue; }
      if (r.pos === G.me) G.autoDef = false;
      if (r.phase === SNAP && r.pos === G.me) return promptOffense();
      if (r.phase === SNAP && !G.autoDef) return promptDefense();
      if (r.phase === PAT && r.pos === G.me) return promptChoice('pat');
      if (r.phase === KICKOFF && r.pos === G.me && !r.free_kick) return promptChoice('kick');
      if (r.phase === KICKOFF && r.pos === G.me && r.free_kick && kickChoice(r)) return promptChoice('freekick');
      if (r.phase === SNAP && r.pos !== G.me && r.clock_running && r.to[G.me] > 0 && defChoice(r)) return promptChoice('deftime');
      if (G.banner) {             // your last result, before their plays run
        const b = G.banner, d = $('dock'), btn = el('button', 'btn', 'Next play');
        G.banner = null;
        btn.type = 'button';
        let went = false;                // once: the await below leaves room for a second tap
        btn.addEventListener('click', async () => { if (went) return; went = true; await cutReplay(); if (!busy) advance(); else went = false; });
        b.append(btn);
        d.textContent = '';
        d.append(b);
        return;
      }
      const action = r.phase === SNAP ? { to_def: false } : (r.phase === KICKOFF && r.pos === G.me ? { kick: 'deep' } : {});
      const label = r.phase === KICKOFF ? (r.pos === G.me ? 'You kick off' : `The ${teamName(code(r.pos))} kick off`) :
        r.phase === PAT ? `The ${teamName(code(r.pos))} try the extra point` : `The ${teamName(code(r.pos))} have the ball`;
      const last = G.log.length ? G.log[G.log.length - 1][0] : '';
      status(label, last, !G.fast);
      const res = await stepWith(action);
      await sleep(G.fast ? 60 : res.animated ? 300 : 1000);
    }
  }
  function kickChoice(r) { return r.t <= 300 && r.score[G.me] < r.score[1 - G.me]; }
  function defChoice(r) {
    const th = halfLeft(r.t), lead = r.score[G.me] - r.score[1 - G.me];
    const late = r.t <= 1800 ? th <= 300 : th <= 120;
    return late && (lead <= 0 || (lead <= 3 && r.yl <= 45));
  }
  async function stepWith(action) {
    await cutReplay();                // a replay's last redraw must not show this play's result before it animates
    const seed = hash('step', seedKey(), G.si, G.seq++);
    const before = G.root, side = G.side;
    // a two-point try you call is shown as a snap from the 2 (root.try2 holds the real try the engine plays)
    const res = (await send({ type: 'step', scen: simScen(), root: G.root.try2 || G.root, action, seed }, true)).res;
    res.action = action;
    if (action && action.philly) res.log.forEach((x) => { if (x.ev === 'pat') x.philly = true; });
    narrate(res.log, action).forEach(([text, t, mine]) => addLog(text, t, mine));
    G.root = res.root;
    if (res.done) G.root.phase = DONE;
    persist();
    const pe = res.log.find((x) => x.ev === 'play');
    const look = before.pos === G.me ? G.look : action && (action.def || action.dc) && pe && pe.look && pe.look.box ? (pe.look.box >= 7 ? 2 : 0) + (pe.look.blitz ? 1 : 0) : null;
    G.lastPlay = { before, res, side, look };
    res.animated = await animatePlay(before, res, side, false, look);
    G.look = null;
    return res;
  }
  // a replay never holds up the game: a call, Next play or Next game tapped during it cuts it short (cutReplay)
  let replaying = null, cutAnim = null;
  function replay() {
    track('replay');
    const lp = G.lastPlay;
    if (busy || replaying || !lp) return;
    const g = G;
    replaying = (async () => {
      try { await animatePlay(lp.before, lp.res, lp.side, true, lp.look); } finally { replaying = null; if (G === g) { drawBar(); drawField(); } }
    })();
  }
  async function cutReplay() {
    if (!replaying) return;
    if (cutAnim) cutAnim();
    await replaying;
  }

  // the first huddle can wait on the simulator's data: say how far along it is, not just a spinner
  let huddleT0 = 0;
  function huddle(text) {
    status(text);
    if (readyCount) return;
    if (!huddleT0) huddleT0 = performance.now();
    const sp = $('dock').querySelector('.status span:last-child');
    const tick = () => {
      if (readyCount || !sp || !sp.isConnected) return;
      sp.textContent = dl.total && dl.got >= dl.total ? 'Setting up the simulator…'
        : `Loading the playbook… ${dl.total ? Math.min(99, Math.round((100 * dl.got) / dl.total)) : 0}%`;
      setTimeout(tick, 200);
    };
    tick();
  }
  // your ball: Run / Pass / RPO, plus a timeout, spike, kneel or kick when it matters
  async function promptOffense() {
    const r = G.root;
    huddle('Breaking the huddle…');
    G.info = (await send({ type: 'info', scen: simScen(), root: r }, true)).info;
    if (VS && (G.root !== r || vs.ui !== 'prompt')) return;          // the room moved on while the odds came in
    G.fast = false;
    G.odds = {};
    const ad = adaptLooks(G.info.looks);
    G.look = VS ? null : pickLook(ad.p, hash('look', seedKey(), G.si, G.seq));
    G.lookNote = G.look != null ? ad.note : null;
    ui = { step: 'family', fam: null, oob: false, tempo: tempoKeyOf(G.info.tempo) };
    drawField();
    drawDock();
    toField();
  }
  // kneel: ahead late, or ending the first half; timeout and spike: when you need the time
  function canKneel(r) {
    const lead = r.score[G.me] - r.score[1 - G.me], th = halfLeft(r.t);
    if (r.down > 3) return false;
    if (r.t > 1800) return lead >= 0 && th <= 120;
    // about 40 seconds a kneel, one fewer kneel's worth per timeout they have left
    const kneels = 5 - r.down - r.to[1 - G.me] - (r.clock_running ? 0 : 1);
    return lead > 0 && th <= 40 * Math.max(kneels, 0) + 30;
  }
  // the other team, ahead with the ball, can kneel out the half whatever you do: a kneel on each down left (about 2
  // seconds each) and the play clock between them (about 38), less one run-off for each timeout you have
  function kneelsOut(r) {
    const opp = 1 - G.me, n = 5 - r.down;
    if (r.pos !== opp || r.score[opp] <= r.score[G.me] || n <= 0) return false;
    return halfLeft(r.t) <= 2 * n + 38 * Math.max(n - 1 - r.to[G.me], 0);
  }
  function clockOptions(r) {      // with the clock running
    const me = G.me, lead = r.score[me] - r.score[1 - me];
    const needTime = r.t > 1800 || lead <= 0;
    const keys = TEMPOS.slice();
    if (r.to[me] > 0 && needTime) keys.push('timeout');
    if (r.down <= 3 && needTime && halfLeft(r.t) <= 180) keys.push('spike');
    if (canKneel(r)) keys.push('kneel');
    // in field goal range late: burn the clock, timeout, kick (the end-of-half/end-of-game classic)
    const th = halfLeft(r.t);
    if (r.to[me] > 0 && needTime && th > RUNDOWN_AT + 2 && th <= 60 && r.yl <= 40 && (G.info.pFg || 0) >= 0.3 && (r.t > 1800 || lead >= -3)) keys.push('rundown');
    return keys;
  }
  function callOptions(r) {
    const th = halfLeft(r.t);
    const calls = idx.calls.map((c) => c.id).filter((id) => {
      if (id === 'qb_sneak' && r.ytg > 3) return false;
      if (id === 'hail_mary' && !(th <= 30 && r.yl >= 30)) return false;
      return true;
    });
    const specials = [];
    if (r.try2) return { calls: calls.filter((id) => id !== 'hail_mary'), specials };
    // the kick: rushing the unit on takes 7-12 s with the clock running (engine.js FIRE_DRILL), so under 7 s it needs
    // a timeout first; a try on 4th down in range, in the last 20 s, or a likely make on 3rd down late
    const p = G.info.pFg, kickable = !r.clock_running || th >= 7;
    // and on any down late in a half once in decent range (down 9 with 2:00 left: take the points now, then the onside)
    const late = r.t > 1800 ? th <= 120 : th <= 300;
    if (kickable && ((r.down === 4 && p >= 0.05) || (th <= 20 && p >= 0.2) || (r.down === 3 && th <= 40 && p >= 0.4) || (late && p >= 0.3))) specials.push('fg');
    if (r.down === 4 && r.yl >= 30) specials.push('punt');
    if (!r.clock_running && canKneel(r)) specials.push('kneel');
    return { calls, specials };
  }
  const specialLabel = (k) => (k === 'fg' ? 'Field goal' : k === 'punt' ? 'Punt' : 'Kneel');

  function drawDock() {
    persButton();
    const r = G.root, d = $('dock'), me = G.me;
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    d.append(head);
    if (ui.step === 'family') {
      head.append(el('h2', '', 'Your call'), el('span', 'sub', `${ddText(r)} · ${spotText(r)}`));
      if (G.look != null) d.append(readLine(G.look));
      if (r.clock_running) d.append(tempoPicker(r));
      const fam = el('div', 'keys');
      fam.style.setProperty('--cols', 4);
      Object.entries(FAM).forEach(([f, label], i) => {
        const b = key(label, null, 'big', i);
        b.addEventListener('click', () => {
          if (busy) return;
          ui.fam = f;
          if (f === 'pass') { ui.step = 'pass'; ui.pass = { target: null, routes: null, pa: false, roll: false, fresh: true }; drawField(); }
          else ui.step = 'detail';
          drawDock();
        });
        fam.append(b);
      });
      d.append(fam);
      const extra = [];
      if (r.clock_running) {
        clockOptions(r).filter((k) => !TEMPOS.includes(k)).forEach((k) => extra.push([k, k === 'rundown' ? 'Run it down' : CLOCK[k].label,
          k === 'timeout' ? `${r.to[me]} left` : k === 'rundown' ? `timeout at 0:0${RUNDOWN_AT}, then kick` : null]));
      }
      const { specials, calls: avail2 } = callOptions(r);
      // the Philly Special (Super Bowl LII): on a two-point try, run as the receiver pass it is
      if (r.try2 && avail2.includes('trick_pass')) extra.push(['philly', 'Philly Special', 'Direct snap, reverse, throw to the QB']);
      // the kick's real odds on the button (this kicker, this distance, the weather; a rushed kick a little less), so
      // a miss reads as the 1-in-5 it was, not a rigged game
      const rush = r.clock_running && halfLeft(r.t) <= 25;          // engine.js FIRE_WINDOW: the unit runs on, a rushed kick
      const pFg = G.info.pFg == null ? null : rush ? 1 / (1 + Math.exp(-(Math.log(G.info.pFg / Math.max(1e-9, 1 - G.info.pFg)) - 0.3))) : G.info.pFg;
      specials.forEach((k) => extra.push([k, specialLabel(k), k === 'fg' ? `${Math.round(G.info.fgDist)} yards${pFg != null ? ` · ${Math.round(pFg * 100)}% to make` : ''}${rush ? (r.to[me] > 0 ? ' · rushed (a timeout first sets it up)' : ' · rushed') : ''}` : null]));
      if (extra.length) {
        const row = el('div', 'keys');
        row.style.setProperty('--cols', Math.min(extra.length, 4));
        extra.forEach(([k, label, sub], i) => {
          const b = key(label, sub, 'alt', 3 + i);
          b.addEventListener('click', () => {
            if (busy) return;
            if (k === 'timeout') decideTimeout();
            else if (k === 'rundown') decideTimeout(true);
            else if ((k === 'spike' || k === 'kneel') && r.clock_running) decideClock(k);
            else if (k === 'philly') decideCall({ call: 'trick_pass', philly: true });
            else decideCall({ special: k });
          });
          row.append(b);
        });
        d.append(row);
      }
      return;
    }
    if (ui.step === 'pass') return drawPassDock(head);
    // the plays in the chosen family: one row per play, a key per side (arrows match the field)
    head.append(el('h2', '', FAM[ui.fam]));
    if (r.clock_running) head.append(el('span', 'sub', CLOCK[ui.tempo].short));
    const back = el('button', 'chip', '◀ Back');
    back.type = 'button';
    back.addEventListener('click', () => { ui.step = 'family'; drawDock(); });
    head.append(back);
    const avail = callOptions(r).calls;
    const dir = r.pos === G.me ? 1 : -1;
    const s = G.side * dir;                       // strong side on screen: +1 right, -1 left
    const rows = [];
    idx.calls.filter((c) => c.family === ui.fam && avail.includes(c.id)).forEach((c) => {
      let row = rows.find((x) => x.base === c.base);
      if (!row) { row = { base: c.base, calls: [] }; rows.push(row); }
      row.calls.push(c);
    });
    const order = (c) => ({ weak: s > 0 ? 0 : 2, middle: 1, strong: s > 0 ? 2 : 0 }[c.side] ?? 1);
    const sideText = (c) => (c.side === 'strong' ? (s > 0 ? 'Strong →' : '← Strong') : c.side === 'weak' ? (s > 0 ? '← Weak' : 'Weak →') :
      c.side === 'middle' ? 'Middle' : 'Call it');
    if (ui.fam === 'trick') {
      const keys = el('div', 'keys');
      keys.style.setProperty('--cols', 2);
      rows.forEach((row, k) => row.calls.forEach((c) => {
        const b = key(row.base, TRICK_SUB[c.id] || null, 'big def', k);
        b.addEventListener('click', () => { if (!busy) decideCall({ call: c.id }); });
        keys.append(b);
      }));
      d.append(keys);
      return;
    }
    const list = el('div', 'plays');
    let i = 0;
    rows.forEach((row) => {
      const pr = el('div', 'prow pop');
      pr.style.setProperty('--i', i++);
      pr.append(el('div', 'lab', row.base));
      const sides = el('div', 'sides');
      row.calls.slice().sort((a, b) => order(a) - order(b)).forEach((c) => {
        const b = key(sideText(c));
        b.setAttribute('aria-label', c.label);
        b.addEventListener('click', () => { if (!busy) decideCall({ call: c.id }); });
        sides.append(b);
      });
      pr.append(sides);
      list.append(pr);
    });
    d.append(list);
    const tg = oobToggle();
    d.append(tg);
    requestAnimationFrame(() => tg.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
  }

  // a pass: your receivers and their routes (tap one on the field or here), play action or a rollout, then throw
  function oobToggle() {
    const tg = el('div', 'toggle');
    const lab = el('div', 'lab', 'Get out of bounds');
    lab.append(el('small', '', 'The ball carrier tries to stop the clock. No guarantee.'));
    const sw = el('button', 'sw2');
    sw.type = 'button'; sw.id = 'oobSwitch';
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.oob)); sw.setAttribute('aria-label', 'Get out of bounds');
    sw.addEventListener('click', () => { ui.oob = !ui.oob; sw.setAttribute('aria-checked', String(ui.oob)); });
    tg.append(lab, sw);
    return tg;
  }
  function drawPassDock(head) {
    const r = G.root, d = $('dock'), P = ui.pass, sc = scene;
    head.append(el('h2', '', 'Pass'));
    if (r.clock_running) head.append(el('span', 'sub', CLOCK[ui.tempo].short));
    const back = el('button', 'chip', '◀ Back');
    back.type = 'button';
    back.addEventListener('click', () => { if (busy) return; ui.step = 'family'; drawField(); drawDock(); });
    head.append(back);
    if (P.hist && P.hist.length) {
      const undo = el('button', 'chip', '↶ Undo route');
      undo.type = 'button';
      undo.addEventListener('click', undoRoute);
      head.append(undo);
    }
    if (G.look != null) d.append(readLine(G.look));
    d.append(el('p', 'hint', 'Tap a receiver on the field to change his route. Tap a name below to throw it to him.'));
    const list = el('div', 'rcvs');
    eligibles(sc).forEach((a, i) => {
      const b = el('button', `rcv${P.target === i ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(P.target === i));
      const pk = pickKey(passOption(sc, i, false).action), od = G.odds && G.odds[pk];
      b.dataset.k = pk;
      b.append(el('span', 'pos', a.label), el('span', 'nm', shortName(a.p ? a.p.name : '') || a.label), el('span', 'rt', `${routeName(a.label, P.routes[i])}${P.target === i ? ' · the target' : ''}`));
      if (od) b.append(el('span', 'od', oddsText(od)));
      b.setAttribute('aria-label', `Throw it to ${a.p ? a.p.name : a.label}, ${routeName(a.label, P.routes[i])}`);
      b.addEventListener('click', () => { if (busy) return; P.target = i; decideCall({ pass: i }); });
      list.append(b);
    });
    // the options first (they change the odds on the cards), as three small toggles on one line
    const opt = (label, tip, on, set, id) => {
      const b = el('button', `chip opt${on ? ' on' : ''}`, label);
      b.type = 'button';
      if (id) b.id = id;
      b.title = tip;
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => { if (busy) return; set(!on); redrawPass(); });
      return b;
    };
    const opts = el('div', 'opts-row');
    opts.append(opt('Play action', 'Fake the handoff first: it freezes a loaded box.', P.pa, (v) => { P.pa = v; if (v) P.roll = false; }),
      opt('Roll out', 'Move the pocket toward your receiver’s side.', P.roll, (v) => { P.roll = v; if (v) P.pa = false; }),
      opt('Out of bounds', 'The ball carrier tries to stop the clock. No guarantee.', ui.oob, (v) => { ui.oob = v; }, 'oobSwitch'));
    d.append(opts, list);
    const avail = callOptions(r).calls, more = ['hail_mary'].filter((id) => avail.includes(id));
    // the screen in one tap: the back's route set to the screen and the ball to him (it was only a route on the
    // picker, which players didn't find, while the grade could still name the screen as the best call)
    const rbI = eligibles(scene).findIndex((a) => a.label === 'RB');
    const extra = (rbI >= 0 && avail.includes('screen') ? ['screen'] : []).concat(more);
    if (extra.length) {
      const row = el('div', 'keys');
      row.style.setProperty('--cols', extra.length);
      extra.forEach((id, i) => {
        const b = key(id === 'screen' ? 'Screen' : CALL[id].label.replace(/ \(.*\)$/, ''), id === 'screen' ? 'To the back, blockers in front' : null, 'alt', i);
        b.addEventListener('click', () => {
          if (busy) return;
          if (id === 'screen') { P.routes[rbI] = 'screen'; P.pa = false; P.roll = false; decideCall({ pass: rbI }); } else decideCall({ call: id });
        });
        row.append(b);
      });
      d.append(row);
    }
    fetchOdds();
    // only on the way in: after that the page stays put while you change routes
    if (P.fresh) { P.fresh = false; requestAnimationFrame(() => list.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' })); }
  }

  // how fast to get to the next snap while the clock runs: no-huddle, huddle or milk it
  // the defense's look before your call: real plays of your call against this look decide the snap
  function pickLook(p, seed) {
    if (!p) return null;
    const u = rng(seed)();
    let acc = 0;
    for (let b = 0; b < p.length; b++) { acc += p[b]; if (u <= acc) return b; }
    return p.length - 1;
  }
  function readLine(b) {
    const L = LOOKS[b], w = el('div', 'read');
    w.append(el('span', 'lab', 'Defense'));
    const v = el('div', 'v');
    v.append(el('b', '', L.loaded ? 'Loaded box' : 'Light box'));
    if (L.blitz) v.append(el('b', 'blitz', 'Showing blitz'));
    v.append(el('small', '', L.loaded ? '7 or more near the line' : '6 or fewer near the line'));
    w.append(v);
    if (G.lookNote) w.append(el('div', 'keyed', G.lookNote));
    return w;
  }
  // A defense that adapts to you: the looks it shows lean toward the ones that beat your recent calls (this game's,
  // and the day's or the survivor run's before it: the last ADAPT_N, recent ones counting more), more so the more of
  // your calls it has seen. Each look's real share here is weighted by exp(ADAPT * conf * edge), edge being how well
  // that look does against your calls by the matchup chart (engine.js MATCH), -1 to +1.
  const ADAPT = 1.4, ADAPT_N = 12, ADAPT_DECAY = 0.85;
  // a spot's harder computer opponent (cpu: 'hard'): its offense reads your defensive call by more, its defense
  // leans on your habits harder and sooner
  const CPU_HARD = { read: 2, adapt: 2, seen: 2 };
  const cpuHard = () => !VS && !!(G.scen && G.scen.cpu === 'hard');
  const LOOK_DEFKEY = ['soft', 'blitz', 'load', 'blitz'];
  const HABIT = { run: 'runs', deep: 'deep shots', short: 'short passes' };
  const EXPECT = { load: 'more loaded boxes', blitz: 'more pressure', soft: 'more men in coverage' };
  const habitOf = (id) => (CALL[id] && CALL[id].kind === 'run' ? 'run' : DEEP_CALLS.has(id) ? 'deep' : 'short');
  const DEEP_CALLS = new Set(['deep_strong', 'deep_weak', 'deep_middle', 'pa_deep', 'hail_mary']);
  function adaptLooks(p) {
    const tend = (state && state.tend) || [], M = G.info && G.info.match;
    if (!p || !M || !tend.length) return { p, note: null };
    let wsum = 0;
    const edge = [0, 0, 0, 0];
    tend.forEach((id, k) => {
      const w = Math.pow(ADAPT_DECAY, tend.length - 1 - k), m = M[id];
      if (!m) return;
      wsum += w;
      LOOK_DEFKEY.forEach((d, b) => { edge[b] -= w * (m[d] || 0); });
    });
    if (!wsum) return { p, note: null };
    const hard = cpuHard(), conf = tend.length / (tend.length + (hard ? CPU_HARD.seen : 4));
    const q = p.map((x, b) => x * Math.exp(ADAPT * (hard ? CPU_HARD.adapt : 1) * conf * (edge[b] / wsum)));
    const z = q.reduce((a, x) => a + x, 0) || 1;
    const out = q.map((x) => x / z);
    // said out loud once it is a real lean on a real habit: what you keep calling, and what they show more of
    let top = -1, lift = 1.35;
    out.forEach((x, b) => { const l = x / Math.max(p[b], 1e-6); if (l > lift && x > 0.15) { lift = l; top = b; } });
    const share = { run: 0, deep: 0, short: 0 };
    tend.forEach((id, k) => { share[habitOf(id)] += Math.pow(ADAPT_DECAY, tend.length - 1 - k); });
    const habit = Object.keys(share).sort((a, b) => share[b] - share[a])[0];
    const note = top >= 0 && share[habit] / wsum > 0.5 ? `They have seen your ${HABIT[habit]}: expect ${EXPECT[LOOK_DEFKEY[top]]}.` : null;
    return { p: out, note };
  }
  // your offensive calls, for the defense to read (kept with the day's or the run's progress)
  function remember(call) {
    if (!call || !state) return;
    state.tend = ((state.tend || []).concat([call])).slice(-ADAPT_N);
  }
  // ---- personnel: optional; a button under the field opens the sheet (who is on the field, and why it matters)
  const PERS_INFO = {
    11: ['1 RB · 1 TE · 3 WR', 'Spread it out: the NFL’s base set, about 6 snaps in 10.'],
    12: ['1 RB · 2 TE · 2 WR', 'Balanced: run or play action out of the same look. About 2 in 10.'],
    21: ['2 RB (a fullback) · 1 TE · 2 WR', 'Power: a lead blocker for the run, and play action off it.'],
    13: ['1 RB · 3 TE · 1 WR', 'Heavy: short yardage and the goal line.'],
  };
  function persButton() {
    const b = $('persBtn'), r = G && G.root;
    if (!b) return;
    const show = !!(r && r.phase === SNAP && r.pos === G.me && !r.try2 && !G.over);
    b.hidden = !show;
    if (!show) return;
    const cur = G.pers || persOf(lineup(G.me).off);
    b.textContent = '';
    b.append(document.createTextNode(`Personnel · ${PERS_INFO[cur] ? cur : 'as lined up'}`));
    const pen = S('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
    pen.append(S('path', { d: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4' }));
    b.append(pen);
  }
  // the personnel change, played out: those coming off jog to the near sideline, those coming on jog in from it,
  // and everyone staying moves to his new spot
  const xyOf = (g) => { const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform') || ''); return m ? [+m[1], +m[2]] : null; };
  function persSnap() {
    const m = new Map();
    if (scene) scene.actors.filter((a) => a.off && a.p).forEach((a) => { const xy = xyOf(a.g); if (xy) m.set(a.p.name, { xy, g: a.g }); });
    return m;
  }
  let persAnim = 0;
  function persMove(before) {
    const sc = scene;
    if (!sc || !before.size || reduced()) return;
    const side = (x) => [x < 180 ? -16 : 376];
    const now = new Set(), moves = [];
    sc.actors.filter((a) => a.off && a.p).forEach((a) => {
      now.add(a.p.name);
      const end = xyOf(a.g), b = before.get(a.p.name);
      if (!end) return;
      const start = b ? b.xy : [side(end[0])[0], end[1]];
      if (Math.hypot(start[0] - end[0], start[1] - end[1]) > 0.5) moves.push({ g: a.g, start, end, d: b ? 0 : 0.25 });
    });
    before.forEach((b, name) => {
      if (now.has(name)) return;
      const g = b.g.cloneNode(true);
      sc.layer.append(g);
      moves.push({ g, start: b.xy, end: [side(b.xy[0])[0], b.xy[1]], d: 0, drop: true });
    });
    if (!moves.length) return;
    const id = ++persAnim, T = 1100, t0 = performance.now();
    const set = (m, u) => m.g.setAttribute('transform', `translate(${lerp(m.start[0], m.end[0], u).toFixed(1)},${lerp(m.start[1], m.end[1], u).toFixed(1)})`);
    moves.forEach((m) => set(m, 0));
    const step = (t) => {
      if (id !== persAnim || scene !== sc) { moves.forEach((m) => (m.drop ? m.g.remove() : set(m, 1))); return; }
      const k = (t - t0) / T;
      moves.forEach((m) => set(m, EASE.io(clip((k - m.d) / (1 - m.d), 0, 1))));
      if (k < 1) requestAnimationFrame(step);
      else moves.forEach((m) => { if (m.drop) m.g.remove(); });
    };
    requestAnimationFrame(step);
  }
  function openPers() {
    if (busy || !G || G.root.pos !== G.me) return;
    const real = persOf(lineup(G.me).off), L = lineup(G.me);
    const nodes = [];
    const render = () => {
      const cur = G.pers || real;
      const hint = el('p', 'phint', 'Optional. The play is drawn from real NFL plays run with the grouping you pick; the players you pick are the ones on the field and the ones you can throw to.');
      const groups = el('div', 'pgroups');
      PERS.forEach(([k]) => {
        const [t, sub] = PERS_INFO[k], b = el('button', `pgroup${cur === k ? ' on' : ''}`);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(cur === k));
        const txt = el('div');
        txt.append(el('div', 't', `${t}${k === real ? ' · as lined up' : ''}`), el('div', 's', sub));
        b.append(el('b', '', String(k)), txt);
        b.addEventListener('click', () => { G.pers = k === real && !G.persWho ? null : k; changed(); });
        groups.append(b);
      });
      const slots = el('div', 'pslots');
      const on = offLineup(G.me), skill = on.filter((p) => ['RB', 'FB', 'TE', 'WR'].includes(p.pos));
      const cand = (pos) => {
        const g = pos === 'FB' || pos === 'RB' ? ['RB', 'FB'] : [pos];
        const seen = new Set(), out = [];
        L.off.concat(L.bench || [], skill).forEach((p) => { if (g.includes(p.pos) && !seen.has(p.name)) { seen.add(p.name); out.push(p); } });
        return out;
      };
      skill.forEach((p, i) => {
        const row = el('label', 'pslot'), sel = el('select');
        sel.setAttribute('aria-label', `${p.pos} ${i + 1}`);
        cand(p.pos).forEach((c) => {
          const o = el('option', '', `${c.name}${c.ovr ? ` · ${c.ovr}` : ''}${L.off.includes(c) ? '' : ' (backup)'}`);
          o.value = c.name;
          if (c.name === p.name) o.selected = true;
          sel.append(o);
        });
        sel.addEventListener('change', () => {
          const key = p.pos === 'RB' || p.pos === 'FB' ? 'backs' : p.pos;
          const now = skill.filter((q) => (key === 'backs' ? q.pos === 'RB' || q.pos === 'FB' : q.pos === p.pos)).map((q) => q.name);
          const j = now.indexOf(p.name), k = now.indexOf(sel.value);
          if (k >= 0) now[k] = p.name;           // already in: the two swap places
          now[j] = sel.value;
          G.persWho = { ...(G.persWho || {}), [key]: now };
          if (!G.pers) G.pers = real;
          changed();
        });
        row.append(el('span', '', p.pos), sel);
        slots.append(row);
      });
      const done = el('button', 'btn pdone', 'Done');
      done.type = 'button';
      done.addEventListener('click', closeModal);
      const reset = el('button', 'ghost', 'Back to the real lineup');
      reset.type = 'button';
      reset.addEventListener('click', () => { G.pers = null; G.persWho = null; changed(); });
      nodes.length = 0;
      nodes.push(hint, groups, el('h3', '', 'Who plays'), slots, reset, done);
      const b = $('mBody'); b.textContent = ''; nodes.forEach((n) => b.append(n));
    };
    const changed = () => {
      track('personnel', { pers: G.pers || real, custom: !!G.persWho });
      persist();
      dirty = true;          // the field redraws, players moving, when the sheet closes (it covers the field on phones)
      persButton(); render();
    };
    let dirty = false;
    const before = persSnap();
    onModalClose = () => { if (dirty) { drawField(); persMove(before); } };
    openModal('Personnel', []);
    render();
  }
  function tempoPicker(r) {
    const w = el('div', 'tempo');
    w.append(el('span', 'lab', 'Tempo'));
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Tempo: how much clock runs before the snap');
    TEMPOS.forEach((k) => {
      const b = el('button', 'segb');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      const secs = tempoSecs(k, r);
      b.append(el('b', '', CLOCK[k].short), el('small', '', secs ? `about ${Math.round(secs)} s` : ''));
      const mark = () => seg.querySelectorAll('.segb').forEach((x, i) => {
        x.classList.toggle('on', TEMPOS[i] === ui.tempo); x.setAttribute('aria-checked', String(TEMPOS[i] === ui.tempo));
      });
      b.addEventListener('click', () => { if (!busy) { ui.tempo = k; mark(); } });
      seg.append(b);
      if (k === TEMPOS[TEMPOS.length - 1]) requestAnimationFrame(mark);
    });
    w.append(seg);
    return w;
  }

  function situation(r) { return `${clockOf(r.t).text} ${qLabel(r)}, ${ddText(r)} ${onSpot(r)}`; }
  function clockSpec(r, chosen, seq) {
    const me = G.me, lead = r.score[me] - r.score[1 - me];
    const opts = clockOptions(r).map((k) => ({ key: k, label: CLOCK[k].label, action: clockAct(k, r) }));
    let q = coachProbs('off_clock_stop', r, me);
    if (lead > 0 && r.t <= 1800) q = { play: 0.9, timeout: 0.03, kneel: 0.07 };
    else if (q) q = { play: q.hurry || 0, timeout: q.timeout || 0, spike: q.spike || 0 };
    else q = { play: 0.8, timeout: 0.14, spike: 0.06 };
    q[tempoKeyOf(G.info.tempo)] = q.play;          // snapping it, a typical play-caller goes at the usual tempo here
    delete q.play;
    if (opts.some((o) => o.key === 'rundown') && halfLeft(r.t) <= 45) {     // in range late, most run it down and kick
      Object.keys(q).forEach((k) => { q[k] *= 0.4; });
      q.rundown = 0.6;
    }
    return { kind: 'clock', family: 'off_clock_stop', r, opts, chosen, q, situation: situation(r), seed: hash('clock', seedKey(), G.si, seq) };
  }
  // a call: the snap goes at once and the grading (thousands of simulated games) runs while the play does; the result
  // card waits for it only if the play was skipped before it finished
  // A grading job (a spec) is everything a decision needs, plain data: the state, the options and their actions, your
  // choice, what play-callers do, the seed. The jobs of a snap are saved with the spot before the snap (G.pending), so
  // a reload or a closed tab during the play regrades them on return (same seeds, same grades): no call goes ungraded
  async function gradeSpecs(pend) {
    const out = [];
    for (const sp of pend.specs) {
      const vals = await evaluateGraded(sp.r, sp.opts, sp.seed, sp.chosen);
      out.push({ ...decisionFrom(sp.kind, sp.family, sp.opts, vals, sp.chosen, sp.q, sp.situation, pend.snap), ...(sp.extra || {}) });
    }
    return out;
  }
  async function snapThenGrade(specs, action) {
    if (cotDaily()) { const res = await cotPlay(action); cotShowResult(res); return; }
    if (VS) {
      const r = G.root;
      vsSubmit(r.phase === SNAP && r.pos !== G.me ? { def: action.def, to_def: !!action.to_def } : { action });
      return;
    }
    const pend = { snap: G.snapN, specs };
    G.snapN += 1;
    G.pending = pend;
    const graded = gradeSpecs(pend);
    graded.catch(() => {});
    status('Snap…', reduced() ? null : 'Tap the field to skip');
    const res = await stepWith(action);                // saves the spot, the grading job with it
    let done = false;
    graded.then(() => { done = true; }, () => { done = true; });
    await Promise.resolve();
    if (!done) status('Grading your call…');
    const decisions = await graded;
    decisions.forEach((x) => G.decisions.push(x));
    G.pending = null;
    persist();
    showResult(decisions, res);
  }
  // back after a reload in the middle of a snap: grade it now
  async function finishPending() {
    const pend = G.pending;
    if (!pend) return;
    status('Grading your last call…');
    const ds = await gradeSpecs(pend);
    if (G.pending !== pend) return;
    ds.forEach((x) => G.decisions.push(x));
    G.pending = null;
    persist();
  }
  // a timeout now, or (rundown) after letting the clock run down to 0:03 for the kick
  async function decideTimeout(rundown) {
    if (busy) return;
    if (VS) { vsSubmit({ timeout: true, rundown: !!rundown }); return; }
    busy = true;
    const r = G.root;
    try {
      const x = (await gradeSpecs({ snap: G.snapN, specs: [clockSpec(r, rundown ? 'rundown' : 'timeout', G.seq)] }))[0];
      G.decisions.push(x);
      G.snapN += 1;
      const halfEnd = r.t > 1800 ? 1800 : 0;
      const t = rundown ? Math.min(r.t - 1, halfEnd + RUNDOWN_AT) : r.t - 1;
      G.root = { ...r, to: r.to.slice(), clock_running: false, t: Math.max(halfEnd, t) };
      G.root.to[G.me] -= 1;
      if (rundown) addLog(`Ran the clock down to ${clockOf(G.root.t).text}`, G.root.t, true);
      addLog(`Timeout, ${teamName(code(G.me))}${rundown ? ' (to set up the kick)' : ''}`, G.root.t, true);
      persist();
      showResult([x], { log: [], action: { to_off: true } }, rundown ? 'Ran it down, timeout' : 'Timeout');
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }
  async function decideClock(k) {
    if (busy) return;
    busy = true;
    const r = G.root;
    try {
      await snapThenGrade([clockSpec(r, k, G.seq)], CLOCK[k].act);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }
  const withTempo = (a) => {
    const b = G.pers && G.root.pos === G.me ? { ...a, pers: G.pers } : a;
    return G.root.clock_running && ui && ui.tempo ? { ...b, tempo: engineTempo(ui.tempo, G.root) } : b;
  };
  function callAction(id, oob) {
    return withTempo({ to_off: false, play: CALL[id].kind, call: id, oob: !!oob, looks: G.look != null ? 1 << G.look : 0 });
  }
  async function decideCall(pick) {
    if (busy) return;
    busy = true;
    const r = G.root, me = G.me;
    try {
      const seq = G.seq, tempo = ui.tempo;
      // the gadget plays are graded against when you call one, never offered as the better call otherwise (their
      // real plays are the ones that were worth charting: too rosy to recommend)
      const all = callOptions(r), specials = all.specials, calls = all.calls.filter((id) => !id.startsWith('trick') || id === pick.call);
      const opts = calls.map((id) => ({ key: id, label: CALL[id].label, action: callAction(id, false) }));
      if (pick.philly) opts.filter((o) => o.key === pick.call).forEach((o) => { o.label = 'Philly Special'; o.action.philly = true; });
      if (pick.call && ui.oob) opts.push({ key: `${pick.call}+oob`, label: `${CALL[pick.call].label}, get out of bounds`, action: callAction(pick.call, true) });
      const passPick = pick.pass != null ? passOption(scene, pick.pass, ui.oob) : null;
      if (passPick) opts.push(passPick);
      if (ui.step === 'pass') ui.step = 'snapped';     // the routes and the picker are done with this snap
      specials.forEach((k) => opts.push({ key: k, label: specialLabel(k), action: withTempo({ to_off: false, play: k }) }));
      const chosen = passPick ? passPick.key : pick.call ? (ui.oob ? `${pick.call}+oob` : pick.call) : pick.special;
      remember(opts.find((o) => o.key === chosen).action.call);
      const cid = passPick ? passPick.action.call : pick.call;
      liveDrive.calls++;
      track('play_call', { mode: modeName(), family: pick.special || (passPick ? 'pass' : (CALL[cid] || {}).family || 'other'), call: cid || pick.special,
        routes_changed: passPick ? ((ui.pass && ui.pass.hist) || []).length : 0, oob: !!ui.oob });
      const q = {};
      const freq = {}, byLook = G.info.lookByCall;
      G.info.calls.forEach((c, ci) => { freq[c.id] = c.freq * (G.look != null && byLook ? byLook[ci][G.look] : 1); });
      let goShare = 1;
      if (r.down === 4) {
        const f4 = coachProbs('fourth_down', r, me) || { go: r.yl <= 40 ? 0.35 : 0.15, fg: r.yl <= 40 ? 0.55 : 0.05, punt: r.yl <= 40 ? 0.1 : 0.8 };
        goShare = f4.go; if (specials.includes('fg')) q.fg = f4.fg; if (specials.includes('punt')) q.punt = f4.punt;
      } else if (specials.includes('fg')) {
        // the old windows (last 20 s, 3rd down late): play-callers often kick; the any-down kick late is rare
        const th = halfLeft(r.t), usual = th <= 20 || (r.down === 3 && th <= 40);
        q.fg = !usual ? 0.02 : th <= 10 ? 0.6 : 0.2; goShare = 1 - q.fg;
      }
      if (specials.includes('kneel')) { const qk = r.score[me] > r.score[1 - me] ? 0.5 : 0.1; q.kneel = qk; goShare *= 1 - qk; }
      const fs = calls.reduce((a, id) => a + (freq[id] || 0), 0) || 1;
      calls.forEach((id) => { q[id] = goShare * (freq[id] || 0) / fs; });
      const specs = [];
      if (r.try2) opts.forEach((o) => { const a = o.action; o.action = { pat: 'two', call: a.call, looks: a.looks, route: a.route, who: a.who, philly: a.philly }; });
      if (r.clock_running) specs.push(clockSpec(r, tempo, seq));
      specs.push({ kind: 'call', family: r.down === 4 ? 'fourth_down' : 'play_select', r: r.try2 || r, opts, chosen, q, situation: situation(r),
        seed: hash('call', seedKey(), G.si, seq) });
      await snapThenGrade(specs, opts.find((o) => o.key === chosen).action);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // their ball: you call the defense (a timeout first, when it matters); the coordinator can take the drive
  const defTimeoutOk = (r) => r.clock_running && r.to[G.me] > 0 && defChoice(r);
  async function promptDefense() {
    const r = G.root;
    huddle('Their huddle…');
    G.dinfo = (await send({ type: 'info', scen: simScen(), root: r }, true)).info;
    if (VS && (G.root !== r || vs.ui !== 'prompt')) return;          // the room moved on while the odds came in
    // are they kicking? The snap as it will be played (the same seed stepWith will use), left alone: a field goal or a
    // punt gets your special-teams call instead of the defense
    const peek = VS ? { log: [] } : (await send({ type: 'step', scen: simScen(), root: r, action: { to_def: false }, seed: hash('step', seedKey(), G.si, G.seq) }, true)).res;
    const kick = peek.log.find((e) => e.ev === 'fg' || e.ev === 'punt');
    if (kick) { G.fast = false; return promptChoice(kick.ev === 'fg' ? 'fgdef' : 'puntdef'); }
    // they kneel it out and nothing you could call stops it: no call to make and none graded (a player was asked for a
    // defense with 5 seconds left and the other team kneeling)
    if (!VS && peek.log.some((e) => e.ev === 'play' && e.kind === KNEEL) && kneelsOut(r)) { G.autoDef = true; return advance(); }
    G.fast = false;
    if (!FULLDEF) { ui = { step: 'defense', to: false }; drawDefDock(); toField(); return; }
    ui = { step: 'vdef', dc: VS ? vdefDefault(r) : nflDefault(r, G.dinfo && G.dinfo.dshare), to: false };
    drawFullDefDock();
    toField();
  }
  // your defense in full (every mode): a quick call (a preset for the spot) or any personnel, front, coverage and rush;
  // every part starts on what a defense would call here, so one tap on Call it is enough
  function drawFullDefDock() {
    const r = G.root, d = $('dock');
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', r.try2 ? 'Stop the two-point try' : 'Your defense'), el('span', 'sub', `${teamName(code(r.pos))} ball · ${ddText(r)} · ${spotText(r)}`));
    d.append(head);
    const presets = el('div', 'vpresets');
    presets.setAttribute('aria-label', 'Quick calls');
    const box = el('div', 'vdef');
    const tip = el('p', 'vdeftip');
    const sum = el('div', 'vdefsum');
    const share = G.dinfo && G.dinfo.dshare;
    const mark = () => {
      box.querySelectorAll('.segb').forEach((b) => { const on = ui.dc[b.dataset.part] === (b.dataset.part === 'rush' ? +b.dataset.k : b.dataset.k); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      presets.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(sameDc(PRESET[b.dataset.k].dc, ui.dc))));
      sum.textContent = vdefText(ui.dc);
      tip.textContent = COVER_TIP[ui.dc.cover];
    };
    presetsFor(r).forEach((k) => {
      const b = el('button', 'chip opt', PRESET[k].label);
      b.type = 'button';
      b.dataset.k = k;
      b.title = PRESET[k].sub;
      b.addEventListener('click', () => { if (busy || ui.step !== 'vdef') return; ui.dc = { ...PRESET[k].dc }; mark(); });
      presets.append(b);
    });
    VDEF.forEach(([part, label, opts]) => {
      const row = el('div', 'tempo vrow');
      row.append(el('span', 'lab', label));
      const seg = el('div', 'seg n');
      seg.style.setProperty('--cols', Math.min(opts.length, 4));
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', label);
      opts.forEach(([k, t, sub]) => {
        const b = el('button', 'segb');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.part = part; b.dataset.k = String(k);
        // what NFL defenses do here, from the charting of the real plays in this spot (not in Versus: no clock, no
        // NFL overtime like it)
        const nfl = !VS && share && share[part] ? share[part][k] : null;
        b.append(el('b', '', t), el('small', '', sub));
        if (nfl != null) b.append(el('small', 'pct', `NFL ${Math.round(nfl * 100)}%`));
        b.addEventListener('click', () => { if (busy || ui.step !== 'vdef') return; ui.dc = { ...ui.dc, [part]: k }; mark(); });
        seg.append(b);
      });
      row.append(seg);
      box.append(row);
    });
    // the four parts fold away (a quick call is one tap); open, they stay open from snap to snap
    const custom = el('details', 'vcustom');
    custom.open = !!load(`${STORE}:defopen`, false);
    const cs = el('summary', '', 'Customize: personnel, front, coverage, rush');
    custom.addEventListener('toggle', () => save(`${STORE}:defopen`, custom.open));
    custom.append(cs, box);
    if (!VS && share) custom.append(el('p', 'vdeftip', 'NFL %: how often NFL defenses lined up each way in this spot. It starts on the most common.'));
    d.append(presets, sum, tip, custom);
    if (!VS && defTimeoutOk(r)) {
      const tg = el('div', 'toggle');
      const lab = el('div', 'lab', 'Timeout first');
      lab.append(el('small', '', `Stop the clock before their snap · ${r.to[G.me]} left`));
      const sw = el('button', 'sw2');
      sw.type = 'button'; sw.id = 'toSwitch';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!ui.to)); sw.setAttribute('aria-label', 'Timeout first');
      sw.addEventListener('click', () => { ui.to = !ui.to; sw.setAttribute('aria-checked', String(ui.to)); });
      tg.append(lab, sw);
      d.append(tg);
    }
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', 1);
    const go = key('Call it', null, 'big', 0);
    go.addEventListener('click', () => {
      if (busy || ui.step !== 'vdef') return;
      track('defense_call', { mode: modeName(), call: `${ui.dc.pers}/${ui.dc.front}/${ui.dc.cover}/${ui.dc.rush}` });
      ui.step = 'sent';
      if (VS) vsSubmit({ dc: { ...ui.dc } });
      else decideDefense({ ...ui.dc });
    });
    keys.append(go);
    d.append(keys);
    if (!VS) {
      const auto = el('button', 'chip', 'Let the coordinator call this drive');
      auto.type = 'button';
      auto.addEventListener('click', () => { if (busy) return; G.autoDef = true; advance(); });
      d.append(auto);
    }
    mark();
  }
  // the three-button defense (blitz, load the box, play it soft): the main site's until the full call is approved
  // (FULLDEF off)
  function drawDefDock() {
    const r = G.root, d = $('dock');
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', 'Your defense'), el('span', 'sub', `${teamName(code(r.pos))} ball · ${ddText(r)} · ${spotText(r)}`));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', 3);
    DEFS.forEach((k, i) => {
      const b = key(DEF[k].label, DEF[k].sub, 'big def', i);
      b.addEventListener('click', () => { if (!busy) decideDefenseLooks(k); });
      keys.append(b);
    });
    d.append(keys);
    if (defTimeoutOk(r)) {
      const tg = el('div', 'toggle');
      const lab = el('div', 'lab', 'Timeout first');
      lab.append(el('small', '', `Stop the clock before their snap · ${r.to[G.me]} left`));
      const sw = el('button', 'sw2');
      sw.type = 'button'; sw.id = 'toSwitch';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.to)); sw.setAttribute('aria-label', 'Timeout first');
      sw.addEventListener('click', () => { ui.to = !ui.to; sw.setAttribute('aria-checked', String(ui.to)); });
      tg.append(lab, sw);
      d.append(tg);
    }
    if (VS) return;
    const auto = el('button', 'chip', 'Let the coordinator call this drive');
    auto.type = 'button';
    auto.addEventListener('click', () => { if (busy) return; G.autoDef = true; advance(); });
    d.append(auto);
  }
  async function decideDefenseLooks(k) {
    if (busy) return;
    busy = true;
    liveDrive.calls++;
    track('defense_call', { mode: modeName(), call: k });
    const r = G.root, me = G.me;
    try {
      const useTo = !!(ui.to && defTimeoutOk(r)), askTo = defTimeoutOk(r), seq = G.seq;
      const opts = DEFS.map((x) => ({ key: x, label: DEF[x].label, action: { to_def: useTo, def: x } }));
      const L = (G.dinfo && G.dinfo.looks) || [0.25, 0.25, 0.25, 0.25];
      const specs = [];
      if (askTo) {
        const to = [{ key: 'timeout', label: 'Timeout', action: { to_def: true, def: k } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false, def: k } }];
        specs.push({ kind: 'deftime', family: 'def_timeout', r, opts: to, chosen: useTo ? 'timeout' : 'no_timeout',
          q: coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 }, situation: situation(r), seed: hash('deftime', seedKey(), G.si, seq) });
      }
      specs.push({ kind: 'defcall', family: 'def_call', r, opts, chosen: k, q: { blitz: L[1] + L[3], load: L[2], soft: L[0] }, situation: situation(r),
        seed: hash('def', seedKey(), G.si, seq) });
      await snapThenGrade(specs, opts.find((o) => o.key === k).action);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // your defense, graded: against the quick calls that fit the spot (and yours, when it is none of them), every one
  // played out from this snap (the offense reads your call and checks into what beats it); how often NFL defenses
  // line up like each, from the charting of the real plays here
  async function decideDefense(dc) {
    if (busy) return;
    busy = true;
    liveDrive.calls++;
    const r = G.root, me = G.me;
    try {
      const useTo = !!(ui.to && defTimeoutOk(r)), askTo = defTimeoutOk(r), seq = G.seq;
      const act = (x) => ({ to_def: useTo, dc: { ...x }, read: cpuHard() ? CPU_HARD.read : true });
      const keys = presetsFor(r), mine = keys.find((k) => sameDc(PRESET[k].dc, dc)) || 'yours';
      const opts = keys.map((k) => ({ key: k, label: PRESET[k].label, action: act(PRESET[k].dc) }));
      if (mine === 'yours') opts.push({ key: 'yours', label: vdefText(dc), action: act(dc) });
      const share = G.dinfo && G.dinfo.dshare;
      const q = {};
      opts.forEach((o) => { q[o.key] = dcShare(share, o.action.dc); });
      // your leanings, against NFL defenses here (the tendencies sheet): blitzing, a stacked box, deep zone
      const nfl = share ? { blitz: (share.rush[5] || 0) + (share.rush[6] || 0), load: share.front.loaded || 0,
        soft: ['c2', 'c3', 'c4', 'c6', 'prevent'].reduce((a, k) => a + (share.cover[k] || 0), 0) } : null;
      const specs = [];
      if (askTo) {
        const to = [{ key: 'timeout', label: 'Timeout', action: { ...act(dc), to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { ...act(dc), to_def: false } }];
        specs.push({ kind: 'deftime', family: 'def_timeout', r, opts: to, chosen: useTo ? 'timeout' : 'no_timeout',
          q: coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 }, situation: situation(r), seed: hash('deftime', seedKey(), G.si, seq) });
      }
      specs.push({ kind: 'defcall', family: 'def_call', r, opts, chosen: mine, q, situation: situation(r), seed: hash('def', seedKey(), G.si, seq),
        extra: { dc: { ...dc }, nfl } });
      await snapThenGrade(specs, act(dc));
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // their ball late, your touchdown, your kickoff
  function promptChoice(kind) {
    const r = G.root, me = G.me, d = $('dock'), behind = r.score[me] < r.score[1 - me];
    const spec = {
      deftime: { ask: 'Clock is running', sub: `${teamName(code(r.pos))} ball, ${ddText(r)}`, family: 'def_timeout',
        opts: [{ key: 'timeout', label: 'Timeout', sub: `${r.to[me]} left`, action: { to_def: true } }, { key: 'no_timeout', label: 'Let it run', action: { to_def: false } }],
        q: () => coachProbs('def_timeout', r, me) || { timeout: 0.15, no_timeout: 0.85 } },
      pat: { ask: 'Touchdown!', sub: 'Kick it or go for two?', family: 'pat',
        opts: [{ key: 'xp', label: 'Kick it', sub: 'About 19 in 20 go in', action: { pat: 'xp' } },
          { key: 'two', label: 'Go for two', sub: 'About half convert', action: { pat: 'two' } }],
        q: () => coachProbs('pat', r, me) || { xp: 0.9, two: 0.1 } },
      // 2025 rules: a touchback off a kickoff comes out to the 35, and only a team that is behind may declare an onside
      // kick; in 2025, 18% of kickoffs were kicked through for the touchback (q)
      kick: { ask: 'Kickoff', sub: behind ? 'Where do you kick it?' : 'Where do you kick it? (Onside only when behind)', family: 'onside',
        opts: [{ key: 'return', label: 'To the returner', sub: 'Make them run it back', action: { kick: 'return' } },
          { key: 'touchback', label: 'Through the end zone', sub: 'Touchback: their 35', action: { kick: 'touchback' } },
          ...(behind ? [{ key: 'onside', label: 'Onside', sub: 'Try to get it back', action: { kick: 'onside' } }] : [])],
        q: () => {
          const on = behind ? (coachProbs('onside', r, me) || { onside: 0.01 }).onside || 0.01 : 0;
          return { ...(behind ? { onside: on } : {}), return: (1 - on) * 0.82, touchback: (1 - on) * 0.18 };
        } },
      // their field goal or punt: your special teams (engine.js ST_*); icing the kicker is a timeout first (it changes
      // nothing about the kick but the clock)
      fgdef: { ask: 'They’re kicking a field goal', sub: `${teamName(code(r.pos))}: about a ${Math.round(r.yl + 17)}-yarder`, family: 'fg_def',
        opts: [{ key: 'block', label: 'Go for the block', sub: 'All-out rush. A roughing flag gives them a first down', action: { to_def: false, st: 'block' } },
          { key: 'safe', label: 'Stay home', sub: 'Normal rush, no risk', action: { to_def: false, st: 'safe' } },
          ...(r.clock_running && r.to[me] > 0 ? [{ key: 'ice', label: 'Ice the kicker', sub: `Timeout first (${r.to[me]} left)`, action: { to_def: true, st: 'safe' } }] : [])],
        q: () => ({ block: 0.2, safe: 0.7, ...(r.clock_running && r.to[me] > 0 ? { ice: 0.1 } : {}) }) },
      puntdef: { ask: 'They’re punting', sub: `${teamName(code(r.pos))} from ${spotText(r)}`, family: 'punt_def',
        opts: [{ key: 'return', label: 'Set up the return', sub: 'Your returner gets a shot at it', action: { to_def: false, st: 'return' } },
          { key: 'rush', label: 'Rush the punt', sub: 'More blocks, a roughing risk, no return', action: { to_def: false, st: 'rush' } }],
        q: () => ({ return: 0.85, rush: 0.15 }) },
      freekick: { ask: 'Free kick', sub: 'After the safety: deep or onside?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', spec.ask), el('span', 'sub', spec.sub));
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', spec.opts.length);
    spec.opts.forEach((o, i) => {
      const b = key(o.label, o.sub || null, spec.opts.length > 2 || spec.opts.some((x) => x.label.length > 10) ? 'big def' : 'big', i);
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const sp = { kind, family: spec.family, r, opts: spec.opts.map((x) => ({ key: x.key, label: x.label, action: x.action })),
          chosen: o.key, q: spec.q(), situation: `${clockOf(r.t).text} ${qLabel(r)}`, seed: hash(kind, seedKey(), G.si, G.seq) };
        // going for two: graded as a choice, then you call the play, a snap from the 2 (root.try2 is the real try)
        if (kind === 'pat' && o.key === 'two' && VS) { busy = false; vsSubmit({ two: true }); return; }
        if (kind === 'pat' && o.key === 'two' && cotDaily()) {           // overtime: not graded
          G.root = { ...r, phase: SNAP, down: 1, ytg: 2, yl: 2, clock_running: false, try2: { ...r } };
          addLog('Going for two', r.t, true);
          persist();
          busy = false;
          return advance();
        }
        if (kind === 'pat' && o.key === 'two') {
          try {
            const x = (await gradeSpecs({ snap: G.snapN, specs: [sp] }))[0];
            G.decisions.push(x);
            G.snapN += 1;
            G.root = { ...r, phase: SNAP, down: 1, ytg: 2, yl: 2, clock_running: false, try2: { ...r } };
            addLog('Going for two', r.t, true);
            persist();
          } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); busy = false; return; }
          busy = false;
          return advance();
        }
        try {
          await snapThenGrade([sp], o.action);
        } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
        busy = false;
      });
      keys.append(b);
    });
    d.append(keys);
  }

  // ------------------------------------------------------- after the snap ---
  // why the better call was better, in one line: what it does for you in this kind of decision, and how often NFL
  // play-callers make it here (the grade itself is the simulation's: thousands of games from this spot each way)
  function whyLine(x) {
    if (!x || x.cost < 0.0005 || x.best === x.chosen) return '';
    const b = x.best, c = x.chosen, nfl = Math.round(((x.q && x.q[b]) || 0) * 100);
    let why = '';
    if (x.kind === 'clock') {
      why = { timeout: 'Stopping the clock now keeps the seconds you need for more snaps.',
        spike: 'A spike stops the clock and saves your timeout for when you need it more.',
        kneel: 'Ahead with the ball: a kneel runs the clock with no chance of a turnover.',
        rundown: 'In range: run it down to 0:03, then kick. They never get the ball back.',
        milk: 'Ahead: every second you take off the clock is one they don\u2019t get.',
        nohuddle: 'Behind with the clock running: the no-huddle gets the next snap off sooner.',
        huddle: 'No need to rush here: the huddle uses clock you can afford.' }[b] || '';
      if (!why && c === 'timeout') why = 'That timeout was worth more later in the drive.';
      if (!why && c === 'spike') why = 'The spike wasted a down you could use.';
    } else if (x.kind === 'deftime') {
      why = b === 'timeout' ? 'Stop the clock now: every second they run off is one you won\u2019t have with the ball.'
        : 'Hold the timeout: it buys more later than it saves now.';
    } else if (x.kind === 'defcall') why = `${x.bestLabel} matches up better with what the offense likes to do here.`;
    else if (x.kind === 'pat') why = `${x.bestLabel} is worth more from here, given the score and the time left.`;
    else if (x.kind === 'kick' || x.kind === 'freekick') why = `${x.bestLabel} leaves them worse field position for the time left.`;
    else {
      // a play call: what the better one does that yours didn't, from the down, the clock and the kind of call
      const dn = +((x.situation || '').match(/\b([1-4])(?:st|nd|rd|th) &/) || [])[1] || 0;
      const sec = ((m) => (m ? +m[1] * 60 + +m[2] : 999))((x.situation || '').match(/^(\d+):(\d\d)/));
      const kick = (l) => /field goal|kick/i.test(l), punt = (l) => /punt/i.test(l), pass = (l) => /pass|deep|screen|quick|throw|hail|shot/i.test(l);
      const run = (l) => /run|RB |inside|outside|off tackle|sneak|keeper|draw/i.test(l) && !pass(l);
      const BL = x.bestLabel, CL = x.chosenLabel;
      if (kick(CL) && dn && dn < 4) why = `Kicking on ${['', '1st', '2nd', '3rd'][dn]} down gives up downs you could use to get closer, or score six.`;
      else if (kick(BL)) why = 'Take the points: the kick is a good bet from here, and the clock is short.';
      else if (punt(BL)) why = 'Punt it: pinning them deep is worth more than the chance of converting here.';
      else if (dn === 4 && (punt(CL) || kick(CL))) why = `Go for it: with ${sec < 180 ? 'this little time' : 'this much at stake'}, keeping the ball is worth the risk.`;
      else if (pass(BL) && run(CL) && sec < 150) why = 'With the clock running down, a pass can stop the clock and gain more than a run.';
      else if (run(BL) && pass(CL)) why = sec < 150 ? 'A run keeps it simple: fewer ways to lose the ball, and the yards come.' : 'A run fits this down and distance better than a throw.';
      else why = `${BL} wins more of the simulated games from this down, distance and clock than ${CL}.`;
    }
    return `${why}${nfl >= 1 ? ` NFL play-callers make that call ${nfl}% of the time here.` : ''}`;
  }
  // the drive's calls, explained: each one that cost something, worst first, with the better call and why
  function callsExplained(decs) {
    const bad = decs.filter((x) => markOf(x.cost) !== 'g').sort((a, b) => b.cost - a.cost);
    const det = el('details', 'explain');
    det.append(el('summary', '', bad.length ? `Your calls, explained (${bad.length} to learn from)` : 'Your calls, explained'));
    const inn = el('div', 'in');
    if (!bad.length) inn.append(el('p', 'note', `Every one of your ${decs.length} calls was the best call or close to it. Coach of the year.`));
    bad.slice(0, 8).forEach((x) => {
      const m = markOf(x.cost), row = el('div', 'xrow');
      const chip = el('span', `chip-g sq ${m}`, GLYPH[m]);
      chip.setAttribute('aria-hidden', 'true');
      const t = el('div', 'xt');
      t.append(el('div', 'xs', x.situation || KIND_NAME[x.kind] || 'Call'),
        el('div', 'xc', `${x.chosenLabel} \u2192 ${x.bestLabel} (${pts(x.cost)}% win chance)`), el('div', 'xw', whyLine(x)));
      row.append(chip, t);
      inn.append(row);
    });
    const good = decs.length - bad.length;
    if (bad.length && good) inn.append(el('p', 'note', `The other ${good} call${good === 1 ? ' was' : 's were'} the best or close to it.`));
    det.append(inn);
    return det;
  }
  const KIND_NAME = { clock: 'Before the snap', call: 'Play call', deftime: 'Timeout', defcall: 'Defense', pat: 'Try', kick: 'Kickoff', freekick: 'Free kick',
    fgdef: 'Field goal defense', puntdef: 'Punt defense' };
  function optionTable(x) {
    const t = el('table', 'opts');
    t.append(el('caption', '', KIND_NAME[x.kind] || 'Call'));
    x.wps.slice().sort((a, b) => b.wp - a.wp).forEach((w) => {
      const tr = el('tr', `${w.key === x.chosen ? 'mine' : ''}${w.key === x.best ? ' best' : ''}`);
      const share = x.q[w.key] || 0;
      tr.append(el('td', '', w.label + (w.key === x.chosen ? ' (you)' : '')),
        el('td', 'n', share >= 0.005 ? `NFL ${Math.round(share * 100)}%` : ''), el('td', 'n', wpTxt(w.wp)));
      t.append(tr);
    });
    return t;
  }
  // what a play did to your win chance: the outcome's color (green when it helped), apart from the grade of the call
  const outcomeMark = (dw) => (dw >= 0.02 ? 'g' : dw > -0.02 ? 'y' : dw > -0.08 ? 'o' : 'r');
  const signed = (dw) => `${dw >= 0 ? '+' : '−'}${Math.abs(Math.round(dw * 100))}`;
  // the win chance after a play: the end of the game is a result, the end of the half its halftime value
  async function winChanceAfter(root, done) {
    const r = done && root.t >= 1800 ? { ...root, t: 1800.01 } : root;
    const v = await evaluate(r, [{ key: 'now', action: {} }], hash('after', seedKey(), G.si, G.seq));
    return v.now;
  }
  // the matchup behind a snap (engine.js MATCH): your call against their look, or their call against your defense
  const LOOK_NAME = ['the light box (extra men back in coverage)', 'the blitz', 'the loaded box', 'the blitz'];
  const DEF_NAME = { blitz: 'blitz', load: 'loaded box', soft: 'soft coverage' };
  function matchupLine(e, action) {
    if (e && e.dc) return defenseLine(e, e.team !== G.me);
    if (!e || e.ev !== 'play' || !e.match || Math.abs(e.match) < 0.5 || e.call < 0 || !idx.calls[e.call]) return null;
    const call = e.team === G.me && action && action.route && action.targetName
      ? `${routeSay(action.targetPos, action.route)} to ${shortName(action.targetName) || action.targetPos}` : idx.calls[e.call].label.toLowerCase();
    // how it went for the offense: a big play, or nothing (no gain, an incompletion, a turnover)
    const big = !e.turnover && (e.td || e.yards >= 10), none = e.turnover || e.incomplete || e.yards <= 0;
    if (e.team === G.me) {
      const b = action && action.looks ? Math.round(Math.log2(action.looks)) : -1;
      if (!(b >= 0 && b < 4)) return null;
      const Look = `${LOOK_NAME[b][0].toUpperCase()}${LOOK_NAME[b].slice(1)}`;
      if (e.match > 0) return { good: true, text: none ? `Good read: ${call} against ${LOOK_NAME[b]}. It just didn't work this time.` : `Good read: ${call} against ${LOOK_NAME[b]}.` };
      return { good: false, text: big ? `${Look} was set up to stop ${call}, but you made the play anyway.` : `${Look} was set up to stop ${call}.` };
    }
    const d = action && DEF_NAME[action.def];
    if (!d) return null;
    if (e.match < 0) return { good: true, text: big ? `Your ${d} was the right call against ${call}, but they made the play anyway.` : `Your ${d} won the matchup: they ran ${call} into it.` };
    return { good: false, text: none ? `They checked into ${call} against your ${d}, and you still stopped it.` : `They checked into ${call} against your ${d}.` };
  }
  function showResult(decisions, res, head) {
    drawAll();
    const d = $('dock');
    d.textContent = '';
    const cost = decisions.reduce((a, x) => a + x.cost, 0), m = markOf(cost);
    const main = res.log.find((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev));
    // the formation and box count stay in the play-by-play; here the matchup line says what the defense did
    const lines = (main ? narrate([main], res.action) : narrate(res.log, res.action).reverse())
      .map(([text, ...rest]) => [text.replace(/ \([^)]*\)(?=:)/, ''), ...rest]);
    const wrap = el('div', 'result');
    const top = el('div', 'res-top');
    // the box shows what happened: the swing in your win chance (filled in when it is valued); a timeout, with no
    // play, shows the grade of the call
    const played = !!main && decisions.length > 0;
    const sq = played ? el('div', 'sq swing pending flip', '…') : el('div', `sq ${m} flip`, GLYPH[m]);
    if (!played) sq.setAttribute('aria-label', { g: 'Best call or close to it', y: 'A little worse than the best call', o: 'Costly', r: 'A big mistake' }[m]);
    const txt = el('div', 'res-play');
    txt.append(el('span', 'yd', head || headline(main, res.log)), document.createTextNode(lines.length ? lines[0][0] : `You stop the clock with ${clockOf(G.root.t).text} left.`));
    const wc = el('span', 'wc');
    if (played) txt.append(wc);
    top.append(sq, txt);
    wrap.append(top);
    const mu = matchupLine(main, res.action);
    if (mu) wrap.append(el('div', `mline ${mu.good ? 'won' : 'lost'}`, mu.text));
    if (played) {
      const before = decisions[decisions.length - 1].wp;
      winChanceAfter(res.root, res.done).then((after) => {
        const dw = after - before, om = outcomeMark(dw);
        const shown = Math.round(after * 100) - Math.round(before * 100);     // what the two percentages say
        sq.className = `sq swing ${om}`;
        sq.textContent = `${shown >= 0 ? '+' : '−'}${Math.abs(shown)}`;
        sq.setAttribute('aria-label', `Your win chance ${shown >= 0 ? 'up' : 'down'} ${Math.abs(shown)} point${Math.abs(shown) === 1 ? '' : 's'}`);
        wc.textContent = `Win chance ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`;
      }).catch(() => { sq.className = `sq ${m}`; sq.textContent = GLYPH[m]; });
    }
    // the call, graded apart from how the play turned out: a small chip, and the better call when there was one
    const v = el('div', 'verdict');
    decisions.forEach((x, i) => {
      if (i) v.append(el('br'));
      const xm = markOf(x.cost);
      const chip = el('span', `chip-g sq ${xm}`, GLYPH[xm]);
      chip.setAttribute('aria-hidden', 'true');
      v.append(chip, document.createTextNode(decisions.length > 1 ? `${KIND_NAME[x.kind]}: ` : 'Your call: '));
      if (x.cost < 0.0005 || x.best === x.chosen) v.append(el('b', '', 'the best one.'));
      else if (xm === 'g') v.append(el('b', '', 'as good as any'), document.createTextNode(` (${x.bestLabel} ${pts(x.cost)}%).`));
      else v.append(document.createTextNode(`${GRADE_WORD[xm]}; `), el('b', '', x.bestLabel), document.createTextNode(` was better (${pts(x.cost)}% win chance).`));
      if (xm !== 'g' && whyLine(x)) v.append(el('span', 'why', ` ${whyLine(x)}`));
    });
    wrap.append(v);
    const acts = el('div', 'res-acts');
    const det = el('details', 'more');
    det.append(el('summary', '', 'How every option scored'));
    const inn = el('div', 'in');
    decisions.forEach((x) => inn.append(optionTable(x)));
    const wpa = decisions.reduce((a, x) => a + x.wpa, 0);
    inn.append(el('p', 'note', `Against a typical NFL play-caller here: ${pts(wpa)}% win chance. "NFL" is how often play-callers make that call in this spot.`));
    det.append(inn);
    if (G.lastPlay && res.animated) {
      const again = el('button', 'chip replay', '↻ Replay');
      again.type = 'button';
      again.addEventListener('click', replay);
      acts.append(again);
    }
    acts.append(det);
    wrap.append(acts);
    // no extra tap: the result stays on top of your next call (or the final card); only when their plays come
    // next does it wait for "Next play" (advance)
    d.append(wrap);
    G.banner = wrap;
    advance();
  }
  function takeBanner(d) {
    if (!G.banner) return;
    G.banner.classList.add('banner');
    d.append(G.banner);
    G.banner = null;
  }

  // ------------------------------------------------- who you coached like ---
  // what a graded call says about you, trait by trait: [trait, what you did (0 or 1), what NFL play-callers do in the
  // same spot (0 to 1: the option frequencies the grading uses)]
  const chosenCallOf = (x) => CALL[x.chosenCall || String(x.chosen).replace('+oob', '')];
  function traitsOf(x) {
    const out = [];
    if (x.kind === 'call') {
      let qPlay = 0, qPass = 0, qPassOnly = 0, qDeep = 0, qAll = 0;
      x.wps.forEach((w) => {
        const q = x.q[w.key] || 0;
        qAll += q;
        // a receiver's route you picked counts as the call it is played as (w.call); the out-of-bounds twins and
        // your pick itself (it duplicates a call already in the list) are left out of what play-callers do
        if (w.key.endsWith('+oob') || w.key.startsWith('pass:')) return;
        const c = CALL[w.key];
        if (!c) return;
        qPlay += q;
        qPass += q * (c.family === 'pass' ? 1 : c.family === 'rpo' ? 0.5 : 0);
        if (c.family === 'pass') { qPassOnly += q; if (DEEP.has(c.id)) qDeep += q; }
      });
      const c = chosenCallOf(x);
      if (c && qPlay > 0) {
        out.push(['pass', c.family === 'pass' ? 1 : c.family === 'rpo' ? 0.5 : 0, qPass / qPlay]);
        if (c.family === 'pass' && qPassOnly > 0) out.push(['deep', DEEP.has(c.id) ? 1 : 0, qDeep / qPassOnly]);
      }
      if (x.family === 'fourth_down' && qAll > 0) out.push(['go', c ? 1 : 0, qPlay / qAll]);
    } else if (x.kind === 'pat') out.push(['two', x.chosen === 'two' ? 1 : 0, x.q.two || 0]);
    else if (x.kind === 'clock' && x.wps.some((w) => w.key === 'nohuddle')) out.push(['nohuddle', x.chosen === 'nohuddle' ? 1 : 0, x.q.nohuddle || 0]);
    else if (x.kind === 'defcall' && x.dc && x.nfl) {          // the full defense: blitz, stacked box, deep zone
      out.push(['blitz', +x.dc.rush >= 5 ? 1 : 0, x.nfl.blitz], ['load', x.dc.front === 'loaded' ? 1 : 0, x.nfl.load],
        ['soft', ['c2', 'c3', 'c4', 'c6', 'prevent'].includes(x.dc.cover) ? 1 : 0, x.nfl.soft]);
    } else if (x.kind === 'defcall') DEFS.forEach((k) => out.push([k, x.chosen === k ? 1 : 0, x.q[k] || 0]));
    return out;
  }
  function coachMatch(decs) {
    const C = idx.coaches;
    if (!C || !C.coaches || !C.coaches.length) return null;
    // per trait: [sum of (you - play-callers), snaps, what you did, what play-callers would have done (expected)]
    const acc = { pass: [0, 0, 0, 0], deep: [0, 0, 0, 0], go: [0, 0, 0, 0], two: [0, 0, 0, 0] };
    const add = (k, mine, theirs) => { const a = acc[k]; a[0] += mine - theirs; a[1] += 1; a[2] += mine; a[3] += theirs; };
    decs.forEach((x) => { traitsOf(x).forEach(([k, mine, theirs]) => { if (acc[k]) add(k, mine, theirs); }); });
    const zu = {}, w = {};
    Object.keys(acc).forEach((k) => {
      const [sum, n] = acc[k];
      zu[k] = n ? (sum / (n + 1)) / (C.spread[k] || 1) : 0;
      w[k] = n ? n / (n + 1) : 0;
    });
    if (!Object.values(w).some((v) => v > 0)) return null;
    let best = null, bd = Infinity;
    C.coaches.forEach((c) => {
      let dist = 0;
      Object.keys(w).forEach((k) => { if (w[k]) dist += w[k] * (zu[k] - (c.z[k] || 0)) ** 2; });
      if (dist < bd) { bd = dist; best = c; }
    });
    // the reasons quote your own calls, against what play-callers do in the same spots, and only when the counts
    // show it (a "lean on the run" to someone who threw on most snaps read as wrong)
    const why = Object.keys(w).filter((k) => w[k] && Math.abs(zu[k]) >= 0.35 && Math.sign(zu[k]) === Math.sign(best.z[k] || 0))
      .sort((a, b) => w[b] * Math.abs(zu[b]) - w[a] * Math.abs(zu[a]))
      .map((k) => whyText(k, zu[k] > 0, acc[k])).filter(Boolean).slice(0, 2);
    return { coach: best, why };
  }
  function whyText(k, more, [, n, mine, theirs]) {
    const a = Math.round(mine), e = Math.round(theirs), na = n - a, ne = n - e;
    if (more ? a <= e : a >= e) return null;               // rounded, the counts don't show it: say nothing
    const of = (x, what) => `${x} of ${n} ${what}`;
    return {
      pass: more ? `threw on ${of(a, 'plays')} (most play-callers: ${e})` : `ran on ${of(na, 'plays')} (most play-callers: ${ne})`,
      deep: more ? `went deep on ${of(a, 'throws')} (most: ${e})` : `kept it short on ${of(na, 'throws')} (most: ${ne})`,
      go: more ? `went for it on ${of(a, 'fourth downs')} (most: ${e})` : `kicked on ${of(na, 'fourth downs')} (most: ${ne})`,
      two: more ? `went for two ${a} of ${n} times (most: ${e})` : `kicked the extra point ${na} of ${n} times (most: ${ne})`,
    }[k];
  }
  function coachCard(decs, label) {
    const m = coachMatch(decs);
    if (!m) return null;
    const c = m.coach, box = el('div', 'coach');
    box.append(el('div', 'k', label), el('div', 'name', c.name));
    const reason = m.why.length ? `Like him, you ${m.why.join(', and ')}.` : 'Your calls sit close to his across the board.';
    box.append(el('div', 'why', reason));
    const teams = (c.teams || []).map(teamName).join(', ');
    box.append(el('div', 'meta', `${teams} · ${c.from === c.to ? c.from : `${c.from}–${c.to}`} · from ${c.plays.toLocaleString()} late-game snaps`));
    box.title = 'Matched on how often you throw, go deep, go for it on fourth down and go for two, each against what NFL play-callers do in the same spots.';
    return { el: box, name: c.name };
  }

  // ---- your tendencies: every call you have had graded (daily days as they finish, survivor games as they end), each
  // against what NFL play-callers do in the same spot. A running tally in storage, keyed so nothing counts twice; a
  // day or game finished before the tally existed is folded in when the stats are opened.
  const TRAIT = { pass: ['Pass', 'throw', 'plays'], deep: ['Deep shot', 'go deep', 'throws'], go: ['Go on 4th', 'go for it on fourth down', 'fourth downs'],
    two: ['Go for two', 'go for two', 'tries'], nohuddle: ['No huddle', 'hurry', 'snaps on a running clock'],
    blitz: ['Blitz', 'blitz', 'defensive snaps'], load: ['Load the box', 'load the box', 'defensive snaps'], soft: ['Coverage', 'sit back in coverage', 'defensive snaps'] };
  const TEND_LEAN = 0.08, TEND_MIN = 3;        // a lean worth saying: this many points off the NFL, on at least this many calls
  let tendMem = null;          // the tally this session (storage off: it lives here until the page is left)
  function tendStore() { return load(`${STORE}:tend`, null) || tendMem || { seen: {}, t: {}, calls: {}, grade: {}, n: 0 }; }
  function tendFold(decs, key) {
    const T = tendStore();
    if (!decs || !decs.length || T.seen[key]) return T;
    tendMem = T;
    T.seen[key] = 1;
    decs.forEach((x) => {
      const m = markOf(x.cost);
      T.n += 1;
      T.grade[m] = (T.grade[m] || 0) + 1;
      const c = x.kind === 'call' && chosenCallOf(x);
      if (c) T.calls[c.id] = (T.calls[c.id] || 0) + 1;
      traitsOf(x).forEach(([k, mine, theirs]) => { const a = T.t[k] || (T.t[k] = [0, 0, 0]); a[0] += mine; a[1] += theirs; a[2] += 1; });
    });
    save(`${STORE}:tend`, T);
    return T;
  }
  function tendAll() {
    let T = tendStore();
    let keys = [];
    try { keys = Object.keys(localStorage); } catch (e) { /* storage off */ }
    keys.filter((k) => k.startsWith(`${STORE}:day:`)).forEach((k) => {
      const n = Number(k.slice(`${STORE}:day:`.length));
      if (!(n > 0) || T.seen[`d${n}`]) return;
      const s = load(k, null);
      if (s && s.done) T = tendFold((s.spots || []).reduce((a, sp) => a.concat((sp && sp.decisions) || []), []), `d${n}`);
    });
    const sv = SURV ? state : load(`${STORE}:surv`, null);
    if (sv && sv.run) (sv.spots || []).forEach((s, i) => { if (s && s.over && s.decisions && !T.seen[`s${sv.run}:${i}`]) T = tendFold(s.decisions, `s${sv.run}:${i}`); });
    return T;
  }
  function tendEl() {
    const T = tendAll();
    if (!T.n) return null;
    const box = el('div', 'tend');
    box.append(el('h3', '', 'How you call it'));
    const row = el('div', 'stats');
    [[T.n, 'Calls graded'], [`${Math.round(100 * (T.grade.g || 0) / T.n)}%`, 'Best call or close'], [T.grade.r || 0, 'Big mistakes']]
      .forEach(([v, l]) => { const c = el('div'); c.append(el('b', '', String(v)), el('span', '', l)); row.append(c); });
    box.append(row);
    const leans = [];
    Object.keys(TRAIT).forEach((k) => {
      const a = T.t[k];
      if (!a || !a[2]) return;
      const you = a[0] / a[2], nfl = a[1] / a[2];
      const r = el('div', 'tr');
      const lab = el('div', 'lab', TRAIT[k][0]);
      lab.append(el('small', '', `${a[2]} ${TRAIT[k][2]}`));
      const bar = (cls, who, p) => { const b = el('div', `tb ${cls}`, `${who} ${Math.round(p * 100)}%`); b.style.width = `${clip(p * 100, 0, 100)}%`; return b; };
      r.append(lab, bar('you', 'You', you), bar('nfl', 'NFL', nfl));
      box.append(r);
      if (a[2] >= TEND_MIN && Math.abs(you - nfl) >= TEND_LEAN) leans.push([k, you - nfl]);
    });
    leans.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const say = leans.slice(0, 2).map(([k, d]) => `${TRAIT[k][1]} ${d > 0 ? 'more' : 'less'} (${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)} points)`);
    box.append(el('p', '', say.length ? `Against NFL play-callers in the same spots, you ${say.join(' and ')}.`
      : T.n >= TEND_MIN ? 'Your calls sit close to NFL play-callers’ across the board.' : 'Your tendencies show after a few more calls.'));
    const fav = Object.entries(T.calls).filter(([id]) => CALL[id]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (fav.length) box.append(el('p', 'note', `Go-to calls: ${fav.map(([id, n]) => `${CALL[id].label} (${n})`).join(', ')}.`));
    return box;
  }

  // The rare one: John Madden (the #HuntForMadden; no play-by-play from his years, so never a match on tendencies).
  // The draw is the leaderboard server's (board/worker.js: about one first daily finish in 50,000, from a secret the page
  // never sees, so it can't be faked here); it answers the day's result with a claim code, shown on the card and kept
  // on its public list (/madden) with the time
  let onMadden = null;
  function maddenCard(code) {
    const box = el('div', 'coach madden');
    box.append(el('div', 'rare', '★ Rare'), el('div', 'k', 'Today you coached like'), el('div', 'name', 'John Madden'),
      el('div', 'why', 'The rarest coach in the game: about 1 in 50,000 drives. Boom!'),
      el('div', 'meta', 'Raiders · 1969–1978 · 103–32–7 · Super Bowl XI champion · never a losing season'),
      el('div', 'claim', `Claim code ${code} · #HuntForMadden`));
    box.title = 'The rare one: about 1 in 50,000 finished daily drives.';
    return { el: box, name: 'John Madden', rare: true };
  }

  // Survivor overtime (NFL rules since 2025, engine.js _otAfter): tied at the end of regulation, a coin toss, then
  // 10:00 (15:00 in the playoffs, which play on until someone wins) with two timeouts each (three in the playoffs).
  // Both teams get the ball, then the next score wins; a regular-season overtime can end tied, which keeps the run
  // alive without a win. The toss is seeded, so a reload lands on the same one.
  const isPlayoff = (sc) => !!ROUND[(sc.real || {}).type];
  // tied at the end of regulation: overtime, played out (the daily drive too: a playoff game can't end tied)
  const needsOvertime = (r) => r.phase === DONE && r.t <= 0 && !r.ot && r.score[0] === r.score[1];
  // college overtime's play-by-play lines (web/vs_core.js notes): Versus and a college game's overtime
  function cotLog(notes) {
    const tn = (t) => teamName(code(t)), mine = (t) => t === G.me;
    for (const x of notes || []) {
      if (x.k === 'pick') addLog(`The ${tn(x.team)} choose ${x.choice}${x.auto ? ' (out of time)' : ''}: ${tn(x.first)} ball first`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'end') addLog(`The ${tn(x.team)} take the end of the field: the ${tn(1 - x.team)} choose offense or defense`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'timeout') addLog(`Timeout, ${tn(x.team)}`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'two') addLog('Going for two', VSCore.COT_T, mine(x.team));
      else if (x.k === 'must2') addLog('Second overtime on: a touchdown has to go for two', VSCore.COT_T, mine(x.team));
      else if (x.k === 'poss') addLog(`${tn(x.team)} ball${x.round >= 3 ? ': a two-point play' : ' at the 25'}`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'round') addLog(`${ordinal(x.round)} overtime, tied ${x.score[G.me]}–${x.score[1 - G.me]}${x.round === 2 ? ': a touchdown has to go for two' : x.round >= 3 ? ': a two-point play each' : ''}. The ${tn(x.chooser)} choose`, VSCore.COT_T, mine(x.chooser));
    }
  }
  // A college game tied at the end goes to college overtime (web/vs_core.js, the rules Versus plays by): a coin toss,
  // the winner's choice of offense, defense or the end of the field (alternating each overtime), the ball at the 25,
  // a touchdown going for two from the 2nd overtime, two-point plays from the 3rd. Their choice is defense, the usual
  // one. The engine's win model knows NFL rules only, so overtime calls are not graded: the day's grade is regulation's.
  const cotDaily = () => !VS && !!G.cot;
  function collegeOvertime() {
    track('overtime', { day: dayN, college: true });
    const r = G.root, them = teamName(code(1 - G.me));
    const toss = rng(hash('toss', seedKey(), G.si))() < 0.5 ? G.me : 1 - G.me;
    const ms = VSCore.start(toss);
    G.cot = { ...ms.cot, score0: r.score.slice() };
    G.root = { ...ms.root, score: r.score.slice() };
    G.over = false; G.result = null;
    addLog(`Tied ${r.score[G.me]}–${r.score[1 - G.me]}: college overtime. ${toss === G.me ? 'You won the coin toss' : `The ${them} won the coin toss`}`, VSCore.COT_T, true);
    persist();
    advance();
  }
  function cotPick(choice) {
    const out = VSCore.apply({ root: G.root, cot: G.cot, seq: G.seq, over: false, winner: -1 }, { [G.cot.pick.team]: { pick: choice } }, null, 0);
    G.root = out.ms.root; G.cot = out.ms.cot;
    cotLog(out.notes);
    persist();
  }
  // a snap in college overtime: the engine plays it (no clock), then the overtime's rules
  async function cotPlay(action) {
    const r = G.root;
    const a = { ...action, to_off: false, to_def: false, ...(r.try2 ? { pat: 'two' } : {}) };
    const res = await stepWith(a);
    const ms = { root: G.root, cot: G.cot, seq: G.seq, over: false, winner: -1 }, notes = [];
    VSCore.after(ms, notes);
    G.root = ms.root; G.cot = ms.cot;
    if (ms.over) G.root.phase = DONE;
    cotLog(notes);
    persist();
    return res;
  }
  function cotShowResult(res, head) {
    drawAll();
    const d = $('dock');
    d.textContent = '';
    const main = res.log.find((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev));
    const lines = (main ? narrate([main], res.action) : narrate(res.log, res.action).reverse());
    const wrap = el('div', 'result'), top = el('div', 'res-top'), txt = el('div', 'res-play');
    txt.append(el('span', 'yd', head || headline(main, res.log)), document.createTextNode(lines.length ? lines[0][0] : ''));
    top.append(txt);
    wrap.append(top);
    const mu = main ? matchupLine(main, res.action) : null;
    if (mu) wrap.append(el('div', `mline ${mu.good ? 'won' : 'lost'}`, mu.text));
    wrap.append(el('div', 'note', 'Overtime calls aren’t graded.'));
    const btn = el('button', 'btn', G.root.phase === DONE ? 'Final' : 'Next play');
    btn.type = 'button';
    let went = false;
    btn.addEventListener('click', async () => { if (went) return; went = true; await cutReplay(); if (!busy) advance(); else went = false; });
    wrap.append(btn);
    d.append(wrap);
  }
  // the next thing in college overtime: the choice (yours, or theirs: defense), your snap, their snap (your defense),
  // a try
  async function cotAdvance(r) {
    const c = G.cot;
    if (c.pick) {
      if (c.pick.team === G.me) { cotPromptPick(); return 'stop'; }
      cotPick('defense');
      return 'again';
    }
    if (r.phase === SNAP && r.pos === G.me) { promptOffense(); return 'stop'; }
    if (r.phase === SNAP) { promptDefense(); return 'stop'; }
    if (r.phase === PAT && r.pos === G.me) { promptChoice('pat'); return 'stop'; }
    status(`The ${teamName(code(r.pos))} line up for the try`, G.log.length ? G.log[G.log.length - 1][0] : '', !G.fast);
    busy = true;
    let res;
    try { res = await cotPlay({}); } catch (e) { busy = false; fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); return 'stop'; }
    busy = false;
    cotShowResult(res);
    return 'stop';
  }
  function cotPromptPick() {
    const c = G.cot, d = $('dock');
    drawAll();
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    const why = c.pick.end ? 'They took the end of the field' : c.round === 1 ? 'You won the toss' : `${ordinal(c.round)} overtime: your choice`;
    head.append(el('h2', '', why), el('span', 'sub', c.pick.end ? 'Offense or defense?' : 'Offense, defense or the end of the field?'));
    d.append(head);
    const keys = el('div', 'keys'), opts = c.pick.end ? ['offense', 'defense'] : ['offense', 'defense', 'end'];
    const label = { offense: 'Offense', defense: 'Defense', end: 'End of the field' };
    const subs = { offense: 'You have the ball first', defense: 'They go first; you know what you need', end: 'Pick the end zone; they choose offense or defense' };
    keys.style.setProperty('--cols', opts.length);
    opts.forEach((o, i) => {
      const b = key(label[o], subs[o], 'big def', i);
      b.addEventListener('click', () => { if (busy) return; track('ot_pick', { pick: o, round: c.round }); cotPick(o); advance(); });
      keys.append(b);
    });
    d.append(keys);
  }
  function overtime() {
    track('overtime', { day: dayN });
    const r = G.root, po = isPlayoff(G.scen), d = $('dock'), them = teamName(code(1 - G.me));
    const won = rng(hash('toss', seedKey(), G.si))() < 0.5;
    drawAll();
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', `Tied ${r.score[G.me]}–${r.score[1 - G.me]}: overtime`),
      el('span', 'sub', `${po ? 15 : 10} minutes, ${po ? 3 : 2} timeouts each. Both teams get the ball, then the next score wins.${
        po ? ' Playoffs: it goes on until someone wins.' : ' Still tied after that, it’s a tie: you stay alive, without a win.'}`));
    d.append(head);
    d.append(el('p', 'note toss', won ? 'You won the coin toss.' : `The ${them} won the coin toss and will receive.`));
    const start = (kicker) => {
      if (busy) return;
      G.root = { t: po ? 900 : 600, pos: kicker, score: [r.score[0], r.score[1]], down: 1, ytg: 10, yl: 65, to: po ? [3, 3] : [2, 2],
        clock_running: false, phase: KICKOFF, credit: 0, free_kick: false, ot: { c: [0, 0], po, n: 1 } };
      G.over = false; G.result = null;
      addLog(kicker === G.me ? `Overtime: you kick off to the ${them}` : `Overtime: the ${them} kick off to you`, G.root.t, true);
      persist();
      advance();
    };
    const keys = el('div', 'keys');
    const opts = won ? [['Receive', 'Get the ball first', 1 - G.me], ['Kick off', 'Know what you need', G.me]] : [['Kick off', null, G.me]];
    keys.style.setProperty('--cols', opts.length);
    opts.forEach(([label, sub, kicker], i) => {
      const b = key(label, sub, 'big', i);
      b.addEventListener('click', () => start(kicker));
      keys.append(b);
    });
    d.append(keys);
  }

  async function finishSpot() {
    if (VS) return vsEndCard();
    if (!G.result && needsOvertime(G.root)) return G.scen.college ? collegeOvertime() : overtime();
    if (!G.result || (G.result.half === 1 && G.result.v !== 2)) {      // v2: halftime valued at halftime
      status('Final whistle…');
      const r = G.root;
      // the end of the first half is t = 1800, which the engine reads as the second half (a finished game: any lead
      // a sure win); a hair earlier it values halftime with its win model: score, spread, who gets the ball
      const v = await evaluate(r.t >= 1800 ? { ...r, t: 1800.01 } : r, [{ key: 'end', action: {} }], 1);
      G.result = { wp: v.end, mine: r.score[G.me], theirs: r.score[1 - G.me], half: r.t >= 1800 ? 1 : 2, v: 2 };
      G.over = true;
      persist();
    }
    drawAll();
    const res = G.result, sc = G.scen, d = $('dock');
    // (res.ot: a result from before overtime was played, settled with the win chance)
    const inOT = !!G.root.ot || cotDaily(), tie = res.mine === res.theirs;
    if (SURV && res.ot == null && !res.counted) {   // survivor: a win counts, a loss ends the run, a tie after overtime neither
      res.counted = true;
      const w = res.mine > res.theirs;
      state.games.push({ id: sc.id, tag: gameTag(sc), me: sc.player, op: sc.player === sc.home ? sc.away : sc.home,
        mine: res.mine, theirs: res.theirs, ot: inOT, w, tie });
      if (w) state.won += 1; else if (!tie) state.out = true;
      tendFold(G.decisions, `s${state.run}:${G.si}`);
      liveDrive.on = false;
    track('survivor_game', { result: w ? 'win' : tie ? 'tie' : 'loss', overtime: inOT, streak: state.won });
      persist();
    }
    d.textContent = '';
    takeBanner(d);
    const card = el('div', 'endcard');
    const ot = inOT ? ' in overtime' : '';
    const head = res.half === 1 ? `Halftime: ${res.mine}–${res.theirs}` :
      res.mine > res.theirs ? `You win ${res.mine}–${res.theirs}${ot}` : res.mine < res.theirs ? `You lose ${res.mine}–${res.theirs}${ot}` :
      inOT ? `Tie ${res.mine}–${res.theirs} after overtime` :
      SURV && res.ot ? `Tied ${res.mine}–${res.theirs}: you ${res.ot > 0 ? 'win' : 'lose'} in overtime` : `Tied ${res.mine}–${res.theirs}: overtime`;
    card.append(el('h2', '', head));
    if (SURV && res.ot) card.append(el('p', 'note', `Your overtime win chance was ${wpTxt(res.wp)}.`));
    else if (inOT && tie) card.append(el('p', 'note', 'Nobody won it. A tie keeps your run alive, but it doesn’t count as a win.'));
    else if (res.half === 1 || (tie && !inOT)) card.append(el('p', 'note', `Your win chance from here: ${wpTxt(res.wp)}.`));
    if (SURV) card.append(el('p', `alive ${state.out ? 'out' : 'in'}`, state.out ? `Eliminated after ${state.won} win${state.won === 1 ? '' : 's'}.` :
      inOT && tie ? `Still alive: ${state.won} win${state.won === 1 ? '' : 's'}.` : `${state.won} straight. You're still alive.`));
    card.append(squaresOf(G.decisions));
    const hh = headToHead(G.si, res);
    if (hh) card.append(hhCard(hh));
    const rl = sc.real || {};
    const realCall = rl.call && CALL[rl.call] ? CALL[rl.call].label : 'a play';
    const lead0 = sc.start.score[sc.player === sc.home ? 1 : 0] - sc.start.score[sc.player === sc.home ? 0 : 1];
    const drive = !rl.drive ? '' : rl.drive === 'ran out the clock' ? (lead0 > 0 ? 'they ran out the clock' : 'time ran out on them') : `the drive ended in a ${rl.drive}`;
    card.append(el('p', 'real', rl.live ? `Straight from ${rl.date ? new Date(rl.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'this week'} (${gameTag(sc)}): see how ${rl.coach || 'the coach'} actually called it.`
      : rl.summary ? `In the real game (${gameTag(sc)}): ${rl.summary}.` : `In the real game (${gameTag(sc)}), ${rl.coach || 'the coach'} called "${realCall}" here; ${drive}.`));
    const cc = coachCard(G.decisions, 'You called this one like');
    if (cc) card.append(cc.el);
    const wpa = G.decisions.reduce((a, x) => a + x.wpa, 0);
    card.append(el('p', 'verdict', `${pts(wpa)}% win chance against a typical NFL play-caller in this spot.`));
    const btn = el('button', 'btn', SURV ? (state.out ? 'Your run' : 'Next game') : G.si < today.length - 1 ? 'Next spot' : "Today's score");
    btn.type = 'button';
    if (SURV) card.append(...lifeOffer());
    let went = false;                  // once: the await below leaves room for a second tap
    btn.addEventListener('click', async () => {
      if (went) return;
      went = true;
      await cutReplay();
      if (SURV) {
        if (state.out) return renderSurvSummary();
        state.pick = null;
        saveState();
        return survOpen();
      }
      state.current = G.si + 1;
      saveState();
      if (G.si < today.length - 1) openSpot(G.si + 1);
      else renderSummary();
    });
    card.append(btn);
    // survivor: an ad after each finished game, below the button (never between the player and it)
    if (SURV) { const ad = adBox(); if (ad) card.append(ad); }
    d.append(card);
    drawTiles();
  }
  // You against the real coach: the game result in the fourth quarter; in the second, the points the possession
  // was worth (his drive: touchdown 7, field goal 3, a defensive touchdown -7, a safety -2)
  function headToHead(si, result) {
    const sc = today[si], rl = sc.real || {}, me = sc.player === sc.home ? 0 : 1;
    if (!result || !rl.coach) return null;
    const who = rl.coach.split(' ').slice(-1)[0];
    const net = (n) => (n === 0 ? 'no points' : `${n > 0 ? '+' : ''}${n} point${Math.abs(n) === 1 ? '' : 's'}`);
    if (result.half === 1) {
      const s0 = startRoot(sc).score;
      const you = result.mine - s0[me] - (result.theirs - s0[1 - me]);
      const him = { touchdown: 7, 'field goal': 3, 'defensive touchdown': -7, safety: -2 }[rl.drive] || 0;
      return { coach: rl.coach, who, v: Math.sign(you - him), you: `${net(you)} before the half`,
        him: `${rl.drive ? rl.drive[0].toUpperCase() + rl.drive.slice(1) : 'His drive'} (${net(him)})` };
    }
    if (!rl.final) return null;
    const hm = me === 0 ? rl.final.home : rl.final.away, ht = me === 0 ? rl.final.away : rl.final.home;
    const wl = (a, b) => (a > b ? 'Won' : a < b ? 'Lost' : 'Tied');
    return { coach: rl.coach, who, v: Math.sign(Math.sign(result.mine - result.theirs) - Math.sign(hm - ht)),
      you: `${wl(result.mine, result.theirs)} ${result.mine}–${result.theirs}${G.root && G.root.ot ? ' (OT)' : ''}`, him: `${wl(hm, ht)} ${hm}–${ht}` };
  }
  function hhCard(h) {
    const box = el('div', `h2h ${h.v > 0 ? 'beat' : h.v < 0 ? 'lost' : 'tie'}`);
    box.append(el('div', 'k', `You vs ${h.coach}`), el('div', 'res', h.v > 0 ? `You beat ${h.who}` : h.v < 0 ? `${h.who} did better` : `Same as ${h.who}`));
    const row = el('div', 'rows');
    [['You', h.you], [h.who, h.him]].forEach(([a, b]) => { const r = el('div', 'r'); r.append(el('span', 'a', a), el('span', 'b', b)); row.append(r); });
    box.append(row);
    return box;
  }
  function snapsOf(decs) {
    const by = new Map();
    decs.forEach((x) => { const k = x.snap ?? by.size; by.set(k, (by.get(k) || 0) + x.cost); });
    return [...by.values()].map(markOf);
  }
  // a spot's snaps in at most 8 squares for sharing: longer drives are grouped, each group graded by its average
  function squeeze(decs) {
    const by = new Map();
    decs.forEach((x) => { const k = x.snap ?? by.size; by.set(k, (by.get(k) || 0) + x.cost); });
    const c = [...by.values()];
    if (c.length <= 8) return c.map(markOf);
    return Array.from({ length: 8 }, (_, j) => {
      const g = c.slice(Math.floor((j * c.length) / 8), Math.floor(((j + 1) * c.length) / 8));
      return markOf(g.reduce((a, x) => a + x, 0) / g.length);
    });
  }
  function squaresOf(decs) {
    const w = el('div', 'squares');
    snapsOf(decs).forEach((m) => w.append(el('span', `sq ${m}`, GLYPH[m])));
    return w;
  }

  // ----------------------------------------------------- the leaderboard ---
  // Survivor's best runs, from one of two places. On the website (index.html names a backend in
  // <meta name="board-api">: board/worker.js) every player's best posts itself under the name they set. On claude.ai
  // the artifact's shared database keeps them (capabilities db + user): everyone who opens the page reads the board,
  // but only its owner (and editors) can write it, since friends who open a public link can only read shared data;
  // so the owner's runs post themselves, and the owner adds a friend's by pasting the share text the friend sends (it
  // carries their name). One document per player there, board/<slug of the name>: { name, best, at }.
  const BOARD = { mode: null, db: null, api: null, canWrite: false, rows: [], ready: null, taken: '' };
  const NAME_KEY = `${STORE}:name`;
  // the website's board: a random key this device keeps claims your name there, so nobody else can post under it
  function deviceKey() {
    let k = load(`${STORE}:boardkey`, '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(k)) {
      const b = new Uint8Array(18);
      crypto.getRandomValues(b);
      k = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      save(`${STORE}:boardkey`, k);
    }
    return BOARD.key || (BOARD.key = k);                    // storage off: one key for this visit
  }
  // the name this device plays under: the one set here, else (signed in) the account's username (kept here as
  // UNAME_KEY, so it is there before the account is asked again); the board takes it as the account's from any phone
  const myName = () => String(load(NAME_KEY, '') || (authSession() && load(UNAME_KEY, '')) || '').slice(0, 24);
  const withSession = () => (signedIn() ? { session: authSession() } : {});
  const slugOf = (name) => `p-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'player'}`;
  const redrawBoards = () => document.querySelectorAll('.board').forEach(fillBoard);
  // posts go as text/plain, a "simple" cross-origin request: no OPTIONS preflight, half the backend requests (the
  // backend reads the body as JSON whatever its type)
  const POST_JSON = (body) => ({ method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  async function apiBoard(method, body) {
    const r = await fetch(`${BOARD.api}/board`, method === 'POST' ? POST_JSON(body) : {});
    if (r.status === 409) return { taken: true, ...(await r.json()) };
    if (!r.ok) throw new Error(`board ${r.status}`);
    return r.json();
  }
  async function apiRefresh() {
    try { BOARD.rows = (await apiBoard('GET')).rows || []; redrawBoards(); } catch (e) { /* keep what we have */ }
  }
  function boardInit() {
    BOARD.ready = (async () => {
      const meta = document.querySelector('meta[name="board-api"]');
      if (meta && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(meta.content)) {      // https, or a local test server
        // the rows load when a board is shown (boardEl), not on every page load: the daily game never shows one
        BOARD.mode = 'api'; BOARD.api = meta.content.replace(/\/+$/, ''); BOARD.canWrite = true;
        return;
      }
      if (!(window.claude && typeof window.claude.use === 'function')) return;
      try {
        const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
        if (!db) return;
        BOARD.db = db; BOARD.mode = 'db';
        BOARD.canWrite = user ? !!(await user.canEdit()) : false;
        db.collection('board').orderBy('best', 'desc').limit(25).onSnapshot((snap) => {
          BOARD.rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })).filter((r) => r.name);
          document.querySelectorAll('.board').forEach(fillBoard);
        }, () => {});
        document.querySelectorAll('.board').forEach(fillBoard);
      } catch (e) { BOARD.db = null; BOARD.mode = null; }
    })();
    return BOARD.ready;
  }
  // a player's best run: kept only when it beats what the board has
  async function boardPost(name, best, life) {
    name = String(name || '').trim().slice(0, 24);
    best = Math.round(Number(best));
    if (!BOARD.mode || !BOARD.canWrite || !name || !(best >= 0 && best < 1000)) return false;
    if (BOARD.mode === 'api') {
      try {
        const res = await apiBoard('POST', { name, best, key: deviceKey(), ...(life ? { life: true } : {}), ...withSession() });
        BOARD.rows = res.rows || BOARD.rows;
        BOARD.taken = res.taken ? name : '';
        BOARD.refused = res.refused ? name : '';
        redrawBoards();
        return res.taken ? false : res.kept != null ? { kept: res.kept } : { best };
      } catch (e) { return false; }
    }
    try {
      const ref = BOARD.db.doc(`board/${slugOf(name)}`), snap = await ref.get();
      const prev = snap.exists ? Number((snap.data() || {}).best) : -1;
      if (snap.exists && prev >= best) return { kept: prev };
      await ref.set({ name, best, at: new Date().toISOString().slice(0, 10) });
      return { best };
    } catch (e) { BOARD.canWrite = false; document.querySelectorAll('.board').forEach(fillBoard); return false; }
  }
  // "Two-Minute Drill Survivor · Eli / Survived 7 games": every such run in a pasted message
  function parseShares(text) {
    const out = [], re = /Survivor\s*·\s*([^\n]{1,24}?)\s*\n\s*Survived\s+(\d{1,3})\s+game/gi;
    let m;
    while ((m = re.exec(String(text)))) out.push({ name: m[1].trim(), best: +m[2] });
    return out;
  }
  function boardEl() { const b = el('div', 'board'); fillBoard(b); if (BOARD.mode === 'api') apiRefresh(); return b; }
  function fillBoard(b) {
    b.textContent = '';
    b.hidden = !BOARD.mode;
    if (!BOARD.mode) return;
    b.append(el('div', 'k', 'Survivor leaderboard'));
    if (!BOARD.rows.length) b.append(el('p', 'note', 'No runs on the board yet.'));
    else {
      const ol = el('ol', 'brows'), me = myName().toLowerCase();
      BOARD.rows.slice(0, 10).forEach((r, i) => {
        const li = el('li', String(r.name).toLowerCase() === me ? 'me' : '');
        li.append(el('span', 'n', String(i + 1)), el('span', 'nm', `${String(r.name)}${r.life ? ' ❤️' : ''}`), el('b', '', String(r.best)));
        if (BOARD.canWrite && BOARD.mode === 'db') {
          const x = el('button', 'x', '×');
          x.type = 'button';
          x.setAttribute('aria-label', `Remove ${r.name}`);
          x.addEventListener('click', async () => { try { await BOARD.db.doc(`board/${r.id}`).delete(); } catch (e) { toast('Could not remove it'); } });
          li.append(x);
        }
        ol.append(li);
      });
      b.append(ol);
    }
    if (BOARD.mode === 'api') {
      const n = myName();
      b.append(el('p', 'note', !n ? 'Set your name on a survivor run’s summary to get on the board.'
        : BOARD.refused && BOARD.refused.toLowerCase() === n.toLowerCase() ? 'That name isn’t allowed on the board. Pick another name.'
        : BOARD.taken && BOARD.taken.toLowerCase() === n.toLowerCase() ? `Someone else already plays as ${n} here. Pick another name to get on the board.`
          : `Your best run posts here as ${n}.`));
    } else if (BOARD.canWrite) {
      const det = el('details', 'addrun');
      det.open = !!BOARD.addOpen;                   // stays open while you add several (the board redraws on each)
      det.addEventListener('toggle', () => { BOARD.addOpen = det.open; });
      det.append(el('summary', '', 'Add a friend’s run'));
      const ta = el('textarea');
      ta.rows = 3;
      ta.placeholder = 'Paste the survivor share text they sent you';
      ta.setAttribute('aria-label', 'A friend’s survivor share text');
      const add = el('button', 'chip', 'Add to the board');
      add.type = 'button';
      add.addEventListener('click', async () => {
        const runs = parseShares(ta.value);
        if (!runs.length) { toast('No survivor run found in that text'); return; }
        const said = [];
        for (const r of runs) {
          const res = await boardPost(r.name, r.best);
          if (res) said.push(res.kept != null ? `${r.name} keeps ${res.kept}` : `${r.name}: ${r.best}`);
        }
        toast(said.length ? said.join(' · ') : 'Could not save to the board');
        if (said.length) ta.value = '';
      });
      det.append(ta, add);
      b.append(det);
    } else b.append(el('p', 'note', 'To get on the board, send your share text to whoever shared this game with you.'));
  }
  function nameInput(onSet) {
    const w = el('label', 'myname');
    w.append(el('span', '', 'Your name on the board'));
    const inp = el('input');
    inp.maxLength = 24;
    inp.value = myName();
    inp.placeholder = 'e.g. Eli';
    inp.addEventListener('change', () => { save(NAME_KEY, inp.value.trim().slice(0, 24)); track('name_set', { mode: modeName() }); if (onSet) onSet(); else renderSurvSummary(true); });
    w.append(inp);
    return w;
  }

  // ------------------------------------------------------------ survivor ---
  // the pool: every fourth-quarter spot (each one plays to the final gun), none twice in a run until all are used
  const featuredSpots = () => new Set(Object.values(idx.featured || {}).map((f) => f.spot));   // a day's story, not survivor's
  const survPool = () => { const f = featuredSpots(); return idx.spots.map((sp, i) => (sp.start.qtr >= 4 && !f.has(i) ? i : -1)).filter((i) => i >= 0); };
  function newRun() {
    return { run: Math.floor(Math.random() * 2 ** 31), spots: [], current: 0, pick: null, won: 0, games: [], played: [], out: false };
  }
  function survStats() { return load(`${STORE}:survstats`, { runs: 0, best: 0, last: null }); }
  function survLabel() {
    const b = Math.max(survStats().best, state.won);
    return `Survivor · ${state.won} win${state.won === 1 ? '' : 's'}${b ? ` · best ${b}` : ''}`;
  }
  async function loadTeams(ids) {
    const per = idx.spot_chunk || 20, teams = {};
    await Promise.all([...new Set(ids.map((i) => Math.floor(i / per)))].map((k) => fetch(asset(`spots/s${k}.json`))
      .then((r) => { if (!r.ok) throw new Error('spot data ' + r.status); return r.json(); }).then((c) => Object.assign(teams, c))));
    return teams;
  }
  async function survOpen() {
    // a game picked on an older build: find it again by id (the spot list can change between builds), else a new one
    if (state.pick != null && state.pickId && (idx.spots[state.pick] || {}).id !== state.pickId) {
      const k = idx.spots.findIndex((sp) => sp.id === state.pickId);
      if (k >= 0) state.pick = k; else { state.pick = null; state.spots = []; }
    }
    if (state.pick != null && !idx.spots[state.pick]) { state.pick = null; state.spots = []; }
    if (state.pick == null) {
      const seen = new Set(state.played), all = survPool(), left = all.filter((i) => !seen.has(i));
      const from = left.length ? left : all;
      state.pick = from[Math.floor(Math.random() * from.length)];
      state.pickId = idx.spots[state.pick].id;
      state.played.push(state.pick);
      state.spots = [];
      state.current = 0;
      saveState();
    }
    show('boot');
    $('boot').textContent = 'Loading the next game…';
    let teams;
    try { teams = await loadTeams([state.pick]); }
    catch (e) {
      $('boot').textContent = '';
      const retry = el('button', 'btn', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', survOpen);
      $('boot').append(el('p', '', `The next game did not load (${e.message}). Check your connection.`), retry);
      return;
    }
    today = [buildScen(idx.spots[state.pick], teams[state.pick])];
    G = null;
    $('dayLabel').textContent = survLabel();
    openSpot(0);
  }
  function renderSurvSummary(redraw) {
    show('done');
    const st = survStats();
    // (a run that took its extra life comes back here when it ends again: its wins count then too)
    if (st.last !== state.run) { st.runs += 1; st.last = state.run; }
    if (state.won > st.best || (state.won === st.best && st.bestLife && !state.life)) st.bestLife = !!state.life;
    st.best = Math.max(st.best, state.won);
    save(`${STORE}:survstats`, st);
    // the board keeps your best (when you can write it and have a name on it), marked when it used the extra life
    if (BOARD.ready && myName()) BOARD.ready.then(() => boardPost(myName(), st.best, !!st.bestLife));
    $('dayLabel').textContent = survLabel();
    drawTiles();
    const box = $('done');
    box.textContent = '';
    const n = state.won;
    box.append(el('div', 'note', 'Survivor · run over'), el('div', 'big-pct', String(n)),
      el('div', 'pct-lab', `${n === 1 ? 'Win' : 'Wins'} before you were knocked out`),
      el('p', 'verdict', !st.best ? 'One loss and it\'s over. Run it back.' : n >= st.best ? 'Your best run yet.' : `Your best run: ${st.best} win${st.best === 1 ? '' : 's'}.`));
    const list = el('ol', 'runlist');
    state.games.forEach((g) => {
      const li = el('li', g.w ? 'w' : g.tie ? 't' : 'l');
      li.append(el('span', 'res', `${g.w ? 'W' : g.tie ? 'T' : 'L'} ${g.mine}–${g.theirs}${g.ot ? ' OT' : ''}`),
        el('span', 'm', `${teamName(g.me)} vs ${teamName(g.op)}`), el('span', 'tag', g.tag));
      list.append(li);
    });
    box.append(list);
    // how it ended: the costliest calls of the game you lost
    const last = (state.spots[0] && state.spots[0].decisions || []).filter((x) => x.cost >= 0.005).sort((a, b) => b.cost - a.cost).slice(0, 3);
    if (last.length) {
      const how = el('div', 'howlost');
      how.append(el('div', 'k', 'How you lost'));
      last.forEach((x) => {
        const row = el('div', 'r');
        row.append(el('span', `sq ${markOf(x.cost)}`, GLYPH[markOf(x.cost)]));
        const t = el('div', 't');
        t.append(el('b', '', x.situation || ''), el('span', '', `You: ${x.chosenLabel}. Better: ${x.bestLabel} (${pts(x.cost)}% win chance).`));
        row.append(t);
        how.append(row);
      });
      box.append(how);
    }
    const nm = myName();
    const text = `Two-Minute Drill Survivor${nm ? ` · ${nm}` : ''}\nSurvived ${n} game${n === 1 ? '' : 's'}\n${state.games.map((g) => (g.w ? SQ.g : g.tie ? SQ.y : SQ.r)).join('')}\n${SITE}${SURV ? '/#survivor' : ''}`;
    const pre = el('div', 'grid-share', text);
    const share = el('button', 'btn alt', 'Share');
    share.type = 'button';
    share.addEventListener('click', () => shareText(text, pre, 'survivor'));
    const again = el('button', 'btn', 'New run');
    again.type = 'button';
    again.addEventListener('click', () => { state = newRun(); saveState(); survOpen(); });
    box.append(...lifeOffer(), nameInput(), pre, share, again, boardEl());
    const ad = adBox();
    if (ad) box.append(ad);
    box.append(disclaimer());
    if (!redraw) again.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- the day ---
  function allDecisions() {
    const out = [];
    for (let i = 0; i < today.length; i++) { const s = state.spots[i]; if (s && s.decisions) out.push(...s.decisions); }
    return out;
  }
  // The day's score: the share of simulated NFL play-callers whose drive cost more win chance than yours. Each one
  // calls like the league (NFL frequencies q), sharpened by how well he reads the spot: an option's weight drops by e
  // for every `tau` of win chance it gives up against the best. Play-callers differ, so each simulated one gets his
  // own tau (log-uniform from very sharp, 0.003, to loose, 0.3), and 15% call by league frequency alone. Against one
  // skill level (day 4 morning: every caller at 0.01) the totals over a drive bunch so tightly that a little worse
  // scores 0 and a little better 100 (half of the players scored 0); against the whole range they spread from 0 to
  // 100 and a typical player lands near the middle. Days 1-3 compared with frequency-only callers (nearly all 90+).
  const PCT_FROM = 4, PCT_TAU_LO = 0.003, PCT_TAU_HI = 0.3, PCT_FREQ = 0.15;
  // The score from day RESULT_FROM on (and every historic drive and playoff run): the calls AND the result. Each
  // simulated play-caller makes his calls as above and then plays his games out: he wins each with the win chance his
  // calls leave (the spot's best start less what they gave up). You and he are scored alike: RESULT_W for each game
  // won (half for a tie), less the win chance the calls gave up. Mostly the calls: a win is worth about as much as
  // three middling calls, so the league's calls score about 50 lost and 65-75 won; a 90 takes sharp calls (a loss
  // with near-perfect ones still gets there in a long shot) and poor calls stay poor, won or lost.
  const RESULT_W = 0.03, RESULT_FROM = 6;
  const resultScored = () => !!(DRIVE || RUN_N || dayN >= RESULT_FROM);
  function spotGroups() {
    const out = [];
    for (let i = 0; i < today.length; i++) {
      const s = state.spots[i];
      if (!s || !s.decisions || !s.decisions.length) continue;
      const r = s.result, res = !r ? 0 : r.mine > r.theirs ? 1 : r.mine === r.theirs ? 0.5 : 0;
      out.push({ decs: s.decisions, res, start: s.decisions[0].bestWp });
    }
    return out;
  }
  function scoreVsNFL(decs) {
    if (!resultScored()) return percentileVsNFL(decs);
    const groups = spotGroups();
    if (!groups.length) return percentileVsNFL(decs);
    const my = groups.reduce((a, g) => a + RESULT_W * g.res - g.decs.reduce((b, x) => b + x.cost, 0), 0);
    const R = rng(hash('pct2', dayN, DRIVE, RUN_N)), N = 6000;
    const lnLo = Math.log(PCT_TAU_LO), lnSpan = Math.log(PCT_TAU_HI) - lnLo;
    const weights = (x, tau) => {
      const w = x.wps.map((o) => (x.q[o.key] || 0) * (tau ? Math.exp((o.wp - x.bestWp) / tau) : 1));
      const t = w.reduce((a, b) => a + b, 0);
      return t > 0 ? w.map((v) => v / t) : w.map(() => 1 / w.length);
    };
    const freqW = groups.map((g) => g.decs.map((x) => weights(x, 0)));
    let better = 0;
    for (let s = 0; s < N; s++) {
      const tau = R() < PCT_FREQ ? 0 : Math.exp(lnLo + R() * lnSpan);
      let m = 0;
      groups.forEach((g, gi) => {
        let tot = 0;
        for (let i = 0; i < g.decs.length; i++) {
          const x = g.decs[i], w = tau ? weights(x, tau) : freqW[gi][i], u = R();
          let acc = 0, pick = x.wps[x.wps.length - 1];
          for (let j = 0; j < x.wps.length; j++) { acc += w[j]; if (u <= acc) { pick = x.wps[j]; break; } }
          tot += Math.max(0, x.bestWp - pick.wp);
        }
        const win = R() < clip(g.start - tot, 0.002, 0.998) ? 1 : 0;
        m += RESULT_W * win - tot;
      });
      if (m < my - 1e-9) better += 1; else if (Math.abs(m - my) <= 1e-9) better += 0.5;
    }
    // a historic drive is a mission: an A (a pass, the Gauntlet's too) takes winning the game
    if (DRIVE && groups.some((g) => g.res < 1)) return Math.min(better / N, (PASS_AT - 1) / 100);
    return better / N;
  }
  function percentileVsNFL(decs) {
    const my = decs.reduce((a, x) => a + x.cost, 0);
    const R = rng(hash('pct', dayN)), N = 4000;
    const mixed = dayN >= PCT_FROM;
    const weights = (x, tau) => {
      const w = x.wps.map((o) => (x.q[o.key] || 0) * (tau ? Math.exp((o.wp - x.bestWp) / tau) : 1));
      const t = w.reduce((a, b) => a + b, 0);
      return t > 0 ? w.map((v) => v / t) : w.map(() => 1 / w.length);
    };
    const freqW = decs.map((x) => weights(x, 0));
    const lnLo = Math.log(PCT_TAU_LO), lnSpan = Math.log(PCT_TAU_HI) - lnLo;
    let better = 0;
    for (let s = 0; s < N; s++) {
      const tau = !mixed || R() < PCT_FREQ ? 0 : Math.exp(lnLo + R() * lnSpan);
      let tot = 0;
      for (let i = 0; i < decs.length; i++) {
        const x = decs[i], w = tau ? weights(x, tau) : freqW[i], u = R();
        let acc = 0, pick = x.wps[x.wps.length - 1];
        for (let j = 0; j < x.wps.length; j++) { acc += w[j]; if (u <= acc) { pick = x.wps[j]; break; } }
        tot += Math.max(0, x.bestWp - pick.wp);
      }
      if (tot > my + 1e-9) better += 1; else if (Math.abs(tot - my) <= 1e-9) better += 0.5;
    }
    return better / N;
  }
  // Pro: the end of a historic drive. The grade (A, green, is a pass), the score behind it, what it takes to pass,
  // your best and your tries, where you stand across every drive, and what really happened
  function driveCard(p, rec, prev) {
    const score = Math.round(p * 100), g = gradeOf(score), d = PRO.drives[DRIVE - 1], n = PRO.drives.length;
    const box = el('div', `gradecard ${g.c}`);
    const top = el('div', 'gtop');
    const big = el('div', 'gbig', g.L);
    const txt = el('div', 'gtxt');
    txt.append(el('div', 'gk', d.title), el('div', 'gres', g.pass ? 'Passed' : !(state.spots[0] && state.spots[0].result && state.spots[0].result.mine > state.spots[0].result.theirs) ? 'Win it to pass' : score >= PASS_AT - 10 ? 'So close' : 'Not yet'),
      el('div', 'gsc', `${score} · better than ${score}% of NFL play\u2011callers, the calls and the result`));
    top.append(big, txt);
    box.append(top);
    const bar = el('div', 'gbar');
    const fill = el('i');
    fill.style.width = `${Math.min(100, score)}%`;
    bar.append(fill, el('b', 'gmark'));
    bar.setAttribute('aria-hidden', 'true');
    box.append(bar);
    const lines = [];
    const r0 = state.spots[0] && state.spots[0].result, won = !!(r0 && r0.mine > r0.theirs);
    if (!g.pass) lines.push(won ? `${PASS_AT} passes: ${PASS_AT - score} more ${PASS_AT - score === 1 ? 'point' : 'points'}.` : `A pass takes winning the game: a loss or a tie tops out at ${PASS_AT - 1}.`);
    if (prev && prev.p * 100 >= score + 0.5) lines.push(`Your best here: ${Math.round(prev.p * 100)} (${gradeOf(Math.round(prev.p * 100)).L}).`);
    else if (prev && score > Math.round(prev.p * 100)) lines.push(`New best: up from ${Math.round(prev.p * 100)}.`);
    if (rec && rec.tries > 1) lines.push(`Try ${rec.tries}.`);
    if (lines.length) box.append(el('p', 'gnote', lines.join(' ')));
    // across every drive: passed, the rank, the next one
    const ds = load(`${STORE}:drives`, {}), passed = PRO.drives.filter((_, k) => ds[k + 1] && ds[k + 1].p * 100 >= PASS_AT - 0.5).length;
    const rk = proRank(passed, n);
    const prog = el('div', 'gprog');
    prog.append(el('span', 'k', 'Historic drives'), el('b', '', `${passed}/${n} passed`), el('span', 'rk', rk.title));
    prog.append(driveStrip(ds));
    if (rk.next) prog.append(el('span', 'sub', `${rk.next.at - passed} more to ${rk.next.title}`));
    box.append(prog);
    if (d.note) {
      const real = el('details', 'greal');
      real.append(el('summary', '', 'What really happened'), el('p', '', d.note));
      box.append(real);
    }
    return box;
  }
  // every historic drive in a row of squares: its best grade's color, gray if not played
  function driveStrip(ds) {
    const strip = el('div', 'gstrip');
    PRO.drives.forEach((dd, k) => {
      const r = ds[k + 1], sq = el('i', r ? `on ${gradeOf(Math.round(r.p * 100)).c}` : '');
      sq.title = `${dd.title}${r ? `: ${gradeOf(Math.round(r.p * 100)).L}` : ''}`;
      strip.append(sq);
    });
    return strip;
  }
  // a drive played again from the snap: its saved state cleared (its best grade stays)
  function retryDrive() {
    try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ }
    track('drive_retry', { drive: DRIVE });
    location.reload();
  }
  function driveActions(rec) {
    const row = el('div', 'row');
    const again = el('button', 'btn', rec && rec.p * 100 >= PASS_AT - 0.5 ? 'Play it again' : 'Try again');
    again.type = 'button';
    again.addEventListener('click', retryDrive);
    row.append(again);
    const ds = load(`${STORE}:drives`, {}), n = PRO.drives.length;
    // the next drive not yet passed, after this one (then from the top)
    const order = Array.from({ length: n }, (_, j) => ((DRIVE + j) % n) + 1);
    const nx = order.find((k) => k !== DRIVE && !(ds[k] && ds[k].p * 100 >= PASS_AT - 0.5));
    if (nx) {
      const a = el('a', 'btn ghostbtn', `Next: ${PRO.drives[nx - 1].title}`);
      a.href = `#drive-${nx}`;
      a.addEventListener('click', () => setTimeout(() => location.reload(), 0));
      row.append(a);
    }
    const all = el('a', 'btn ghostbtn', 'All drives');
    all.href = '#archive';
    row.append(all);
    return row;
  }
  function renderSummary() {
    if (!G) resumeSpot(today.length - 1);
    show('done');
    const decs = allDecisions();
    const p = decs.length ? scoreVsNFL(decs) : 0;
    const wpa = decs.reduce((a, x) => a + x.wpa, 0);
    const st = load(`${STORE}:stats`, { days: {} });
    const cc = coachCard(decs, DRIVE || RUN_N ? 'You coached like' : 'Today you coached like');
    const runRec = RUN_N ? today.map((_, i) => { const r = state.spots[i] && state.spots[i].result; return !r ? 0 : r.mine > r.theirs ? 1 : r.mine < r.theirs ? -1 : 0; }) : [];
    let driveRec = null, drivePrev = null;
    if (DRIVE) {                      // a historic drive: its own record (the best try kept), not a day's
      const ds = load(`${STORE}:drives`, {});
      drivePrev = ds[DRIVE] || null;
      const r0 = state.spots[0] && state.spots[0].result, won = !!(r0 && r0.mine > r0.theirs);
      const counted = !!state.tryAt && !!drivePrev && drivePrev.at === state.tryAt;      // this try is in already (the page reopened)
      driveRec = { p: Math.max(p, drivePrev ? drivePrev.p : 0), wpa: drivePrev && drivePrev.p > p ? drivePrev.wpa : wpa, last: p,
        tries: (drivePrev && drivePrev.tries || (drivePrev ? 1 : 0)) + (counted ? 0 : 1), won: won || !!(drivePrev && drivePrev.won), at: state.tryAt };
      if (counted) drivePrev = drivePrev.prev || null;
      driveRec.prev = drivePrev ? { p: drivePrev.p, tries: drivePrev.tries } : null;
      ds[DRIVE] = driveRec;
      save(`${STORE}:drives`, ds);
    } else if (RUN_N) {               // a playoff run: its record
      const rs = load(`${STORE}:runs`, {});
      rs[RUN_N] = { p, wpa, w: runRec.filter((x) => x > 0).length, l: runRec.filter((x) => x < 0).length, n: today.length };
      save(`${STORE}:runs`, rs);
    } else {
      st.days[dayN] = { p, wpa, coach: cc ? cc.name : null };
      save(`${STORE}:stats`, st);
    }
    tendFold(decs, DRIVE ? `drive${DRIVE}` : RUN_N ? `run${RUN_N}` : `d${dayN}`);
    const firstFinish = !state.done;
    state.done = true;
    saveState();
    if (firstFinish) statsSync(true);              // signed in: the record goes to the account (another phone sees it)
    drawTiles();
    const box = $('done');
    box.textContent = '';
    // the daily streak: days in a row finished, today included (what brings players back tomorrow)
    let streak = 0; for (let k = dayN; st.days[k]; k--) streak++;
    if (DRIVE) {
      const card = driveCard(p, driveRec, drivePrev), note = el('p', 'racenote');
      note.hidden = true;
      card.append(note);
      box.append(card, driveActions(driveRec));
      // the pass goes to the Gauntlet once; one that never got an answer (the page closed while sending) goes again
      if (firstFinish || (state.raceTok && state.raceSent === false)) racePass(p, decs, note);
    }
    else {
      box.append(el('div', 'note', RUN_N ? `${PRO_RUNS.runs[RUN_N - 1].title} · your run` : `Day ${dayN} · your score`), el('div', 'big-pct', `${Math.round(p * 100)}`),
        el('div', 'pct-lab', `Better than ${Math.round(p * 100)}% of NFL play\u2011callers${resultScored() ? ', the calls and the result' : ''}`),
        el('div', 'streak', RUN_N ? 'Playoff run' : ARCH_DAY ? 'From the archive' : streak >= 2 ? `🔥 ${streak}-day streak` : 'Day 1 of your streak · come back tomorrow'));
    }
    if (RUN_N) {                      // the run's record against the real one
      const run = PRO_RUNS.runs[RUN_N - 1], w = runRec.filter((x) => x > 0).length, l = runRec.filter((x) => x < 0).length, t = today.length - w - l;
      const rw = run.games.filter((g) => g.won).length, rl = run.games.length - rw;
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Your run'), el('b', '', `${w}-${l}${t ? `-${t}` : ''}`),
        el('span', 'sub', w === today.length ? 'Every game won. Champions.' : `The real ${run.title} went ${rw}-${rl}.`));
      box.append(v);
    }
    if (cc) box.append(cc.el);
    box.append(el('p', 'verdict', `${pts(wpa)}% win chance against a typical NFL play-caller ${today.length > 1 ? 'across today’s spots' : 'on today’s drive'}.`));
    const dbox = dailyBox(p, today.map((_, i) => (state.spots[i] && state.spots[i].decisions || []).reduce((a, x) => a + x.wpa, 0)));
    box.append(dbox);
    if (ARCH_DAY || RUN_N) { const a = el('a', 'btn', RUN_N ? 'More runs' : 'Back to the archive'); a.href = '#archive'; box.append(a); }
    else if (PRO_ON && !isPro() && BOARD.api) box.append(proValueCard());       // the website: what Pro adds, after the free drive
    const rec = [0, 0, 0];             // against the real coaches: better, worse, the same (a W-L-T record)
    const rows = today.map((_, i) => {
      const s = state.spots[i]; if (!s) return '';
      const r = s.result ? (s.result.half === 1 ? 'HT' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      const hh = headToHead(i, s.result);
      if (hh) rec[hh.v > 0 ? 0 : hh.v < 0 ? 1 : 2]++;
      return `${today[i].player} ${r} ${squeeze(s.decisions || []).map((m) => SQ[m]).join('')}`;
    });
    const met = rec[0] + rec[1] + rec[2], recTxt = `${rec[0]}-${rec[1]}${rec[2] ? `-${rec[2]}` : ''}`;
    liveDrive.on = false;
    if (firstFinish) track('daily_finish', { day: dayN, kind: today[0] && today[0].category, score: Math.round(p * 100),
      vs_coach: rec[0] ? 'better' : rec[1] ? 'worse' : met ? 'same' : 'none', snaps: decs.length });
    // one drive: a sentence, not a record
    const hh0 = today.length === 1 && state.spots[0] ? headToHead(0, state.spots[0].result) : null;
    const one = today.length === 1 ? (hh0 ? (rec[0] ? `Beat ${hh0.coach}` : rec[1] ? `${hh0.coach} did better` : `Matched ${hh0.coach}`)
      : rec[0] ? 'Beat the real coach' : rec[1] ? 'Lost to the real coach' : 'Matched the real coach') : null;
    const vs = met ? (one ? `\n${one}` : `\nVs the real coaches: ${recTxt}`) : '';
    if (met && one && hh0) box.insertBefore(hhCard(hh0), box.children[3] || null);      // beating the real coach is the hook: say who
    else if (met && one) {
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Vs the real coach'), el('b', '', rec[0] ? 'Better' : rec[1] ? 'Worse' : 'Same'));
      box.insertBefore(v, box.children[3] || null);
    } else if (met) {
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Vs the real coaches'), el('b', '', recTxt),
        el('span', 'sub', `${rec[0]} better, ${rec[1]} worse${rec[2] ? `, ${rec[2]} the same` : ''}`));
      box.insertBefore(v, box.children[3] || null);
    }
    const text = `${DRIVE ? `Two-Minute Drill · ${PRO.drives[DRIVE - 1].title}\nGrade ${gradeOf(Math.round(p * 100)).L}${p * 100 >= PASS_AT - 0.5 ? ' ✅ passed' : ''}` : RUN_N ? `Two-Minute Drill · the ${PRO_RUNS.runs[RUN_N - 1].title} run` : `Two-Minute Drill #${dayN}`}\nBetter than ${Math.round(p * 100)}% of NFL play-callers${cc ? `\nCoached like ${cc.name}` : ''}${vs}` +
      `${streak >= 2 ? `\n🔥 ${streak}-day streak` : ''}\n${rows.join('\n')}\nCan you beat me? ${SITE}`;
    // sharing is how new players find the game: the button sits right under the result, not below the standings
    const share = { text };
    const pre = el('div', 'grid-share', text);
    const btn = el('button', 'btn', 'Share your score');
    btn.type = 'button';
    btn.addEventListener('click', () => shareText(share.text, pre, 'daily'));
    box.insertBefore(pre, dbox);
    // the server drew John Madden for this result: his card in place of the match, his line in the share text
    onMadden = (code) => {
      const m = maddenCard(code), old = box.querySelector('.coach');
      if (old) old.replaceWith(m.el); else box.insertBefore(m.el, pre);
      const line = `Coached like John Madden 🏆 (${code})`;
      share.text = cc ? share.text.replace(`Coached like ${cc.name}`, line) : share.text.replace(/\n/, `\n${line}\n`);
      pre.textContent = share.text;
      const stt = load(`${STORE}:stats`, { days: {} });
      if (stt.days[dayN] && stt.days[dayN].madden !== code) { stt.days[dayN].coach = 'John Madden'; stt.days[dayN].madden = code; save(`${STORE}:stats`, stt); statsSync(true); }
      if (!state.madden) { state.madden = code; saveState(); track('madden', { day: dayN }); }
    };
    box.insertBefore(btn, dbox);
    const img = el('button', 'btn ghostbtn', 'Share as a picture');
    img.type = 'button';
    img.addEventListener('click', () => shareImage({
      title: DRIVE ? PRO.drives[DRIVE - 1].title : RUN_N ? `The ${PRO_RUNS.runs[RUN_N - 1].title} run` : `Daily #${dayN}`,
      score: Math.round(p * 100), grade: DRIVE ? gradeOf(Math.round(p * 100)).L : null,
      line: `Better than ${Math.round(p * 100)}% of NFL play-callers`,
      coach: () => (share.text.match(/Coached like ([^\n]+)/) || [])[1] || null,
      vs: met ? (one || `Vs the real coaches: ${recTxt}`) : null, beat: rec[0] > rec[1] ? 1 : rec[1] > rec[0] ? -1 : 0,
      streak: !DRIVE && !RUN_N && !ARCH_DAY ? streak : 0,
      rows: today.map((sp, i) => ({ team: sp.player, res: (rows[i] || '').split(' ')[1] || '', marks: squeeze((state.spots[i] && state.spots[i].decisions) || []) })) }));
    box.insertBefore(img, dbox);
    box.insertBefore(callsExplained(decs), dbox);
    if (!DRIVE && !RUN_N && !ARCH_DAY) { const lg = el('p', 'lglink'); lg.hidden = true; box.insertBefore(lg, dbox); leagueNudge(); }
    box.append(countdown(streak >= 1 ? 'Keep the streak: next drive in ' : null));
    if (!DRIVE && !RUN_N && !ARCH_DAY) box.append(reminderNodes());
    const ad = adBox();
    if (ad) box.append(ad);
    box.append(disclaimer());
  }
  // ---- the daily habit: the streak in the top bar, and a reminder in the player's own calendar (a daily event at the
  // hour they pick: Google Calendar's own page, or a .ics file site.py writes for Apple and Outlook calendars)
  function curStreak() {
    const st = load(`${STORE}:stats`, { days: {} }), d = dayOf(new Date());
    let n = 0; for (let k = st.days[d] ? d : d - 1; st.days[k]; k--) n++;
    return n;
  }
  const REMIND_HOURS = [[8, 'Morning, 8 am'], [12, 'Lunch, noon'], [19, 'Evening, 7 pm']];
  function reminderNodes() {
    const box = el('div', 'remind');
    const open = el('button', 'btn ghostbtn', '\u23f0 Remind me every day');
    open.type = 'button';
    open.addEventListener('click', () => {
      box.textContent = '';
      box.append(el('div', 'k', 'A daily reminder in your calendar'));
      const times = el('div', 'rtimes'), links = el('div', 'rlinks');
      let h = 8;
      const draw = () => {
        times.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.h === h)));
        const t = new Date(); t.setDate(t.getDate() + 1);
        const ymd = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`, hh = String(h).padStart(2, '0');
        const g = el('a', 'btn', 'Google Calendar');
        g.href = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Two-Minute Drill: today\u2019s drive')}`
          + `&details=${encodeURIComponent(`Keep your streak going: https://${SITE}`)}&recur=${encodeURIComponent('RRULE:FREQ=DAILY')}&dates=${ymd}T${hh}0000/${ymd}T${hh}1000`;
        g.target = '_blank'; g.rel = 'noopener';
        const a = el('a', 'btn ghostbtn', 'Apple / Outlook');
        a.href = `remind-${h}.ics`;
        [g, a].forEach((x) => x.addEventListener('click', () => { track('reminder', { hour: h, cal: x === g ? 'google' : 'ics' }); save(`${STORE}:remind`, h); }));
        links.textContent = '';
        links.append(g, a);
      };
      REMIND_HOURS.forEach(([hr, lab]) => {
        const b = el('button', 'chip', lab);
        b.type = 'button'; b.dataset.h = hr;
        b.addEventListener('click', () => { h = hr; draw(); });
        times.append(b);
      });
      draw();
      box.append(times, links, el('p', 'note', 'A new drive is up every day at midnight, your time.'));
    });
    box.append(open);
    if (load(`${STORE}:remind`, null) != null) open.textContent = '\u23f0 Reminder set \u00b7 change it';
    return box;
  }
  // ---- your result as a picture (for Instagram, X, the group chat): drawn on a canvas, the phone's share sheet when it
  // takes files, else saved as a file
  async function shareImage(o) {
    const W = 1080, H = 1350, cv = document.createElement('canvas'), x = cv.getContext('2d');
    cv.width = W; cv.height = H;
    try { await document.fonts.ready; } catch (e) { /* no font API */ }
    const css = getComputedStyle(document.documentElement), col = (v, d) => (css.getPropertyValue(v) || '').trim() || d;
    const DISP = '"Big Shoulders Display", "Arial Narrow", sans-serif', BODY = '"Libre Franklin", Arial, sans-serif';
    const MK = { g: col('--sq-g', '#3d9a56'), y: col('--sq-y', '#d2ad2e'), o: col('--sq-o', '#e27c37'), r: col('--sq-r', '#d0463f') };
    // the field: dark green, yard lines
    const bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0f2a18'); bg.addColorStop(1, '#173d24');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 3;
    for (let y = 90; y < H; y += 110) { x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
    x.textAlign = 'center'; x.fillStyle = '#fff';
    x.font = `900 64px ${DISP}`; x.fillText('TWO-MINUTE DRILL', W / 2, 130);
    x.font = `700 34px ${BODY}`; x.fillStyle = 'rgba(255,255,255,.75)'; x.fillText(o.title.toUpperCase(), W / 2, 185);
    x.fillStyle = '#fff'; x.font = `900 300px ${DISP}`; x.fillText(o.grade || String(o.score), W / 2, 470);
    x.font = `600 38px ${BODY}`; x.fillText(o.grade ? `${o.score} \u00b7 ${o.line}` : o.line, W / 2, 545);
    const coach = typeof o.coach === 'function' ? o.coach() : o.coach;
    // (the lines below the score, centred in the room above the footer)
    const nRows = Math.min(4, o.rows.length), blockH = (o.vs ? 90 : 0) + (coach ? 70 : 0) + nRows * 100 + (o.streak >= 2 ? 110 : 0);
    let y = Math.max(630, 600 + (H - 160 - 600 - blockH) / 2);
    if (o.vs) {
      x.font = `900 66px ${DISP}`; x.fillStyle = o.beat > 0 ? MK.g : o.beat < 0 ? MK.r : '#fff';
      x.fillText(o.vs.toUpperCase(), W / 2, y + 10, W - 80); y += 90;
    }
    if (coach) { x.font = `600 36px ${BODY}`; x.fillStyle = 'rgba(255,255,255,.85)'; x.fillText(`Coached like ${coach}`, W / 2, y, W - 80); y += 70; }
    // the calls, one row of squares per spot
    const SQ = 74, GAP = 14;
    o.rows.slice(0, 4).forEach((r) => {
      const n = Math.max(1, r.marks.length), w = n * SQ + (n - 1) * GAP, lab = `${r.team} ${r.res}`.trim();
      x.font = `800 40px ${DISP}`; x.textAlign = 'right'; x.fillStyle = '#fff';
      const x0 = (W - w) / 2 + 60;
      x.fillText(lab, x0 - 24, y + SQ * 0.68);
      r.marks.forEach((m, i) => {
        x.fillStyle = MK[m] || '#666';
        const xx = x0 + i * (SQ + GAP);
        x.beginPath(); x.roundRect ? x.roundRect(xx, y, SQ, SQ, 12) : x.rect(xx, y, SQ, SQ); x.fill();
      });
      x.textAlign = 'center'; y += SQ + 26;
    });
    if (o.streak >= 2) { x.font = `900 60px ${DISP}`; x.fillStyle = '#ffb547'; x.fillText(`\ud83d\udd25 ${o.streak}-DAY STREAK`, W / 2, y + 60); }
    x.font = `700 40px ${BODY}`; x.fillStyle = '#fff'; x.fillText(`Can you beat me? ${SITE}`, W / 2, H - 70);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) { toast('Could not make the picture'); return; }
    const file = new File([blob], `two-minute-drill-${o.title.replace(/\W+/g, '-').toLowerCase()}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `Can you beat me? https://${SITE}` });
        track('share', { what: 'image', method: 'sheet' });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Picture saved');
    track('share', { what: 'image', method: 'download' });
  }
  // ---- what Pro adds, shown to a free player right after the free daily (the moment they want more)
  function startPurchase(buy) {
    buy.disabled = true;
    (async () => {
      try { track('pro_pay'); const d = await proApi('/pay', authSession() ? { session: authSession() } : {}); location.href = d.url; } catch (e) {
        if (/sign-in has expired/.test(e.message)) authClear();
        toast(/not set up/.test(e.message) ? 'Payments open soon' : 'Could not start the purchase: ' + e.message);
        buy.disabled = false;
      }
    })();
  }
  function proValueCard() {
    const box = el('div', 'pro provalue'), days = Math.max(0, dayOf(new Date()) - 1);
    box.append(el('div', 'k', 'Want more? Two-Minute Drill Pro'), el('div', 'price', '$4.99 \u00b7 once, yours for good'));
    const ul = el('ul');
    ['The Gauntlet: race everyone through the historic drives. $50 and the Champion title to the first to pass them all',
      'The historic drives: Mahomes\u2019 13 seconds, the Minneapolis Miracle, the Philly Special, 28\u20133 and more, from their real spots',
      'Playoff runs: coach a team through its whole postseason, every late-game spot in order',
      `The archive: every past daily${days ? ` (${days} so far)` : ''}, any day you missed`].forEach((t) => ul.append(el('li', '', t)));
    const row = el('div', 'row'), buy = el('button', 'btn', 'Unlock Pro \u00b7 $4.99'), more = el('a', 'btn ghostbtn', 'See what\u2019s inside');
    buy.type = 'button';
    buy.addEventListener('click', () => { track('pro_value_buy'); startPurchase(buy); });
    more.href = '#archive';
    row.append(buy, more);
    box.append(ul, row, el('p', 'note', 'Apple Pay, Google Pay or a card on Stripe\u2019s secure page. Signed in, it goes on your account for every device.'));
    track('pro_value_seen');
    return box;
  }
  // An ad unit (Google AdSense, the website only: site.py --adsense --ad-slot), only on screens between games, never
  // while a drive is on, labeled as an ad. Nothing without both metas (claude.ai, local copies, the test builds).
  // survivor: one extra life a run, for a short ad break (only where the site has ads to show). Off for now: no ads
  const LIFE_ON = false;
  function lifeOffer() {
    if (!LIFE_ON || !state.out || state.life || !adCodes().length) return [];
    const life = el('button', 'btn gold', '❤️ Extra life: watch a 15-second ad');
    life.type = 'button';
    life.addEventListener('click', () => adBreak(() => {
      state.out = false; state.life = true; state.pick = null;
      saveState();
      track('extra_life', { streak: state.won });
      survOpen();
    }));
    return [life, el('p', 'note', 'Once a run. Your loss stays on your record, and the board marks the run with ❤️.')];
  }
  // the ad units the site has (site.py: the banner's meta; the footer units are frames on the page)
  const adCodes = () => [document.querySelector('meta[name="ad-frame"]'), ...document.querySelectorAll('.adslot iframe')].filter(Boolean);
  // the extra life's ad break: the banner and the native unit, and a countdown that runs only while the page is in
  // view; then Continue. Closing it early keeps the run over
  const AD_BREAK_S = 15;
  function adBreak(onDone) {
    track('extra_life_offer_taken');
    const wrap = el('div', 'adbreak'), ad = adBox(), nat = document.querySelector('.ad-native iframe');
    if (ad) wrap.append(ad);
    if (nat) { const f = nat.cloneNode(); f.style.height = '300px'; const b = el('div', 'adbox'); b.append(el('div', 'adlab', 'Advertisement'), f); wrap.append(b); }
    const go = el('button', 'btn', `Continue in ${AD_BREAK_S}`);
    go.type = 'button';
    go.disabled = true;
    let left = AD_BREAK_S, done = false;
    const tick = setInterval(() => {
      if (document.hidden) return;
      left -= 1;
      if (left > 0) { go.textContent = `Continue in ${left}`; return; }
      clearInterval(tick);
      go.disabled = false; go.textContent = 'Continue your run';
    }, 1000);
    go.addEventListener('click', () => { if (go.disabled || done) return; done = true; closeModal(); onDone(); });
    openModal('Extra life', [el('p', 'note', 'Thanks for supporting the game. Your run continues when the timer ends.'), wrap, go]);
    onModalClose = () => clearInterval(tick);
  }
  function adBox() {
    // another network's banner (site.py: web/ads/banner.html, e.g. Adsterra): in a sandboxed frame of its own, so its
    // script can't touch the game or send the page elsewhere (a tap on the ad still opens it in a new tab)
    const frame = document.querySelector('meta[name="ad-frame"]');
    if (frame) {
      const [w, h] = (frame.dataset.size || '300x250').split('x').map(Number), box = el('div', 'adbox');
      const f = document.createElement('iframe');
      Object.assign(f, { src: frame.content, title: 'Advertisement', loading: 'lazy', width: w, height: h, scrolling: 'no' });
      f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      f.style.cssText = `display:block;margin:0 auto;border:0;max-width:100%;width:${w}px;height:${h}px`;
      box.append(el('div', 'adlab', 'Advertisement'), f);
      return box;
    }
    const client = document.querySelector('meta[name="google-adsense-account"]'), slot = document.querySelector('meta[name="ad-slot"]');
    if (!client || !slot) return null;
    const box = el('div', 'adbox'), ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    Object.assign(ins.dataset, { adClient: client.content, adSlot: slot.content, adFormat: 'auto', fullWidthResponsive: 'true' });
    box.append(el('div', 'adlab', 'Advertisement'), ins);
    setTimeout(() => { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { box.remove(); } }, 0);
    return box;
  }
  // Everyone who played today (the website: board/worker.js /daily). Your first result of the day counts once;
  // the box shows where it ranks among the day's players, how they spread, each spot against the average, and the
  // day's top named players. On claude.ai (no backend) there is no box.
  // the date of the drive played (not the clock's: a drive started before midnight and finished after it is still
  // that day's, and a result posted to the next day would lock out the real one)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const driveDate = () => { const d = new Date(idx.launch + 'T12:00:00'); d.setDate(d.getDate() + dayN - 1); return ymd(d); };
  function dailyBox(p, spotW) {
    const box = el('div', 'board daily');
    box.hidden = true;
    if (ARCH_DAY || DRIVE || RUN_N) return box;        // the archive, a historic drive, a run: nothing to post
    const post = async () => {
      const res = await fetch(`${BOARD.api}/daily`, POST_JSON({ date: driveDate(), key: deviceKey(), p: clip(p, 0, 1), spots: spotW.map((w) => clip(w, -1, 1)), ...(myName() ? { name: myName(), ...withSession() } : {}) }));
      if (!res.ok) throw new Error(`daily ${res.status}`);
      return res.json();
    };
    let retried = false;
    const refresh = async (force) => {
      try { const d = await post(); fillDaily(box, d, p, spotW, () => refresh(true)); if (d.madden && onMadden) onMadden(d.madden); } catch (e) {
        if (force) toast('Could not reach today’s stats');
        else if (!retried) { retried = true; setTimeout(() => { if (box.isConnected) refresh(false); }, 5000); }   // once: a busy moment
      }
    };
    (BOARD.ready || Promise.resolve()).then(() => { if (BOARD.mode === 'api') refresh(false); });
    return box;
  }
  function fillDaily(box, d, p, spotW, again) {
    box.textContent = '';
    box.hidden = false;
    // one big number on the screen (your score against NFL play-callers); here, where you rank among today's players
    const you = d.you ? d.you.p : p, pt = Math.round(you * 100), others = d.n - 1;
    let above = 0, ties = -1;
    d.hist.forEach((c, k) => { if (k > pt) above += c; else if (k === pt) ties += c; });
    box.append(el('div', 'k', 'Everyone today'));
    box.append(el('p', 'daily-head', others <= 0 ? 'You’re the first to finish today. Check back later to see how you stack up.'
      : `#${(above + 1).toLocaleString()} of ${d.n.toLocaleString()} today${ties > 0 ? ` (tied with ${ties.toLocaleString()})` : ''}`));
    if (d.counted === false && d.you && Math.abs(d.you.p - p) > 0.005) box.append(el('p', 'note', `Your first finish today counts: ${Math.round(d.you.p * 100)}.`));
    // the day's scores, in the buckets your own stats use; yours highlighted
    const dist = el('div', 'dist');
    dist.setAttribute('role', 'img');
    const buckets = [[80, 101, '80–100'], [60, 80, '60–79'], [40, 60, '40–59'], [20, 40, '20–39'], [0, 20, '0–19']];
    const counts = buckets.map(([lo, hi]) => d.hist.slice(lo, Math.min(hi, 101)).reduce((a, c) => a + c, 0));
    const mx = Math.max(1, ...counts);
    dist.setAttribute('aria-label', `Today's scores: ${buckets.map(([, , lab], i) => `${lab}: ${counts[i]}`).join(', ')}. Yours: ${pt}.`);
    buckets.forEach(([lo, hi, lab], i) => {
      const r = el('div', 'r');
      const bar = el('div', `bar2${pt >= lo && pt < hi ? ' hi' : ''}`, String(counts[i]));
      bar.style.width = `${Math.max(8, (counts[i] / mx) * 100)}%`;
      r.title = `${lab}: ${counts[i].toLocaleString()} player${counts[i] === 1 ? '' : 's'} (${Math.round((counts[i] / Math.max(1, d.n)) * 100)}%)${pt >= lo && pt < hi ? ', you' : ''}`;
      r.append(el('span', '', lab), bar);
      dist.append(r);
    });
    box.append(dist);
    // each spot: your win chance against a typical play-caller, and the day's average
    const yourW = d.you ? d.you.spots : spotW;
    const sp = el('div', 'dspots');
    d.spots.forEach((x, i) => {
      if (!today[i]) return;
      const row = el('div', 'dsp');
      row.append(el('b', '', today.length > 1 ? `Spot ${i + 1} · ${today[i].player}` : `Your drive · ${today[i].player}`),
        el('span', '', `${pts(yourW[i])}% win chance vs a typical play-caller · today’s average ${pts(x.avg)}%`));
      sp.append(row);
    });
    box.append(sp);
    if (d.top && d.top.length) {
      const ol = el('ol', 'brows'), me = myName().toLowerCase();
      d.top.forEach((r, i) => {
        const li = el('li', String(r.name).toLowerCase() === me ? 'me' : '');
        li.append(el('span', 'n', String(i + 1)), el('span', 'nm', String(r.name)), el('b', '', String(Math.round(r.p * 100))));
        ol.append(li);
      });
      box.append(el('div', 'k sub', 'Today’s best'), ol);
    }
    if (d.refused) box.append(el('p', 'note', 'That name isn’t allowed on the list. Your result still counts; pick another name to be on it.'));
    else if (d.taken) box.append(el('p', 'note', `Someone else already plays as ${myName()} here. Pick another name to get on the list.`));
    if (!myName() || d.taken || d.refused) box.append(nameInput(again));
    const btn = el('button', 'chip', 'Refresh');
    btn.type = 'button';
    btn.addEventListener('click', again);
    const all = el('a', 'chip', 'Every day’s stats ›');
    all.href = 'stats';
    all.addEventListener('click', () => track('stats_page_link'));
    const row = el('div', 'res-acts');
    row.append(btn, all);
    box.append(row);
  }
  function countdown(label) {
    const w = el('div', 'countdown');
    const b = el('b', '', '');
    w.append(document.createTextNode(label || (today.length > 1 ? 'New spots in ' : 'Next drive in ')), b);
    const upd = () => {
      if (dayOf(new Date()) > dayN) {           // past midnight on yesterday's screen: the new drive is out
        clearInterval(tick);
        if (w.querySelector('button')) return;     // drawn once: a redraw under the finger would eat the tap
        w.textContent = '';
        const go = el('button', 'btn', 'Play today’s drive');
        go.addEventListener('click', () => location.reload());
        w.append(go);
        return;
      }
      const now = new Date(), next = new Date(now); next.setHours(24, 0, 0, 0);
      let s = Math.max(0, Math.floor((next - now) / 1000));
      const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
      b.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    upd();
    clearInterval(tick); tick = setInterval(upd, 1000);
    return w;
  }

  // ------------------------------------------------------- boxes to tap ---
  // the website is a fan-made game: on every screen between games, in the help and on the intro
  const DISCLAIMER = 'Not affiliated with, endorsed by or sponsored by the National Football League, its teams or players. NFL and team names are trademarks of their respective owners, used here only to identify real games. Play-by-play from the public nflverse data.';
  const disclaimer = () => el('p', 'note legal', DISCLAIMER);
  function privacyLink() {
    const p = el('p', 'note'), a = el('a', '', 'Privacy');
    a.href = 'privacy';
    p.append(a, ' · what the site keeps, analytics and ads');
    return p;
  }
  function openModal(title, nodes) {
    $('mTitle').textContent = title;
    const b = $('mBody'); b.textContent = '';
    nodes.forEach((n) => b.append(n));
    lastFocus = document.activeElement;
    $('modal').hidden = false;
    $('mClose').focus();
  }
  let onModalClose = null;
  function closeModal() {
    $('modal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    const f = onModalClose; onModalClose = null;
    if (f) f();
  }
  function playerInfo(p, label, team) {
    const ol = OL.includes(label) || label === 'T' || label === 'G';
    const top = el('div', 'pinfo');
    const ch = el('div', 'chip-big', String(p.ovr)); ch.style.background = rate(p.ovr);
    top.append(ch);
    const nm = el('div'), g = groupOf(label);
    nm.append(el('div', 'nm', p.num != null ? `#${p.num} ${p.name}` : p.name), el('div', 'ps', `${team ? teamName(team) + ' · ' : ''}${POS_NAME[label] || label}`));
    if (p.pct != null) nm.append(el('div', 'ps', `Better than ${p.pct}% of starting ${POS_PLURAL[g] || 'players'} at the time`));
    top.append(nm);
    const nodes = [top];
    if (p.kind) {
      const a = el('div', 'arch');
      a.append(el('span', 'tag', p.kind));
      nodes.push(a, el('p', 'lead', p.why));
    }
    const how = POS_METHOD[groupOf(label)];
    nodes.push(el('p', p.kind ? '' : 'lead', p.stat || ''),
      el('p', 'note', how ? `Our rating, 40 to 99: where he stood among NFL ${POS_PLURAL[g] || 'players'} in the games before this one (${how}), the latest counting most. A typical starter is 77.`
        : 'Our rating, 40 to 99, from his kicking before this game. A typical starter is 77.'));
    openModal(POS_NAME[label] || label, nodes);
  }
  function spotInfo() {
    const sc = G.scen, H = sc.game.home, A = sc.game.away;
    const dl = el('dl', 'facts');
    const add = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
    const line = sc.game.home_spread;
    add('Game', `${teamName(sc.away)} at ${teamName(sc.home)}`);
    add('Point spread', Math.abs(line) < 0.5 ? 'Pick’em' : `${teamName(line > 0 ? sc.home : sc.away)} by ${Math.abs(line).toFixed(1)}`);
    [A, H].forEach((t) => {
      add(`${teamName(t.team)}`, `${t.coach || ''}${t.qb && t.qb.name ? ` · QB ${t.qb.name}` : ''}`);
      add('Kicker', `${t.kicker.name || '—'} · rated ${t.kicker.ovr ?? '—'}`);
      add('Punter', `${t.punter.name || '—'} · rated ${t.punter.ovr ?? '—'}`);
    });
    openModal('This game', [dl, el('p', 'note', `The players who were on the field in that game (${gameTag(sc)}), each rated against his position as of that week, and the real point spread.`)]);
  }
  function openHelp(auto) {
    track('help_open', { auto: auto === true });     // auto: shown on a first visit (not a tap on ?)
    // a first visit gets three lines and a button, not the manual: the full help is one tap away on ?
    if (auto === true) {
      const ol = el('ol', 'quick');
      [['Call the play.', 'Run, pass or a trick play, in the last minutes of a real NFL game.'],
        ['Watch it happen.', 'Every snap is a real NFL play run against your call.'],
        SURV ? ['Keep winning.', 'Every game is a different real one. How many in a row can you win?']
          : ['Beat the real coach.', 'Then see how you rank against everyone who played today.']]
        .forEach(([b, t]) => { const li = el('li'); li.append(el('b', '', b), ' ', t); ol.append(li); });
      const go = el('button', 'btn', 'Let’s go');
      go.type = 'button';
      go.addEventListener('click', closeModal);
      openModal(SURV ? 'Survivor' : 'One drive a day', [ol, ...(SURV ? [el('p', 'note', 'Win to keep going. One loss ends your run.')] : []), go,
        el('p', 'note', 'How to play in full: the ? at the top.')]);
      setTimeout(() => go.focus({ preventScroll: true }), 0);
      return;
    }
    const ex = el('div', 'ex');
    ['g', 'y', 'o', 'r'].forEach((m) => ex.append(el('span', `sq ${m}`, GLYPH[m])));
    const ul = el('ul');
    [
      'You call the plays at the end of a real NFL game. A new drive every day.',
      'Pick Run, Pass, RPO or Trick. On a pass, tap a receiver on the field to change his route, then tap his name to throw it.',
      'Every snap is a real NFL play. Read the defense: a blitz loses to quick throws, a loaded box to play action.',
      SURV ? 'Survivor: win each real game to keep going. One loss ends your run; put your name on the board.'
        : 'Beat the real coach, and see how you rank against everyone who played today.',
    ].forEach((t) => ul.append(el('li', '', t)));
    const more = el('details', 'more');
    more.append(el('summary', '', 'More about the game'));
    const ul2 = el('ul');
    [
      'You\'re the head coach for the last minutes of a real NFL game. A new drive every day.',
      'Call Run, Pass or RPO. On a pass, every receiver shows his route: tap any of them on the field to change it, then pick who gets the ball, with play action or a rollout if you like. Timeouts, spikes, kicks and tempo pop up when they matter. On their ball, you call the defense, and when they line up to kick, you choose to go for the block or play it safe.',
      'Every snap is a real NFL play run against your call. Tap the field to skip, or a player to see who he is.',
      'Matchups matter: a blitz beats deep shots but loses to quick passes and screens; a loaded box stuffs runs but gets beaten by play-action and deep shots; playing soft stops deep shots but gives up runs. Read their look before you call, and when you call the defense, they will check into what beats it.',
      'Beat the real coach\'s result, and find out which NFL coach you call it like.',
      'Survivor: random real fourth quarters back to back. Win to keep going; lose once and your run is over. Tied at the end, you play overtime: both teams get the ball, then the next score wins.',
    ].forEach((t) => ul2.append(el('li', '', t)));
    more.append(ul2);
    openModal('How to play', [
      ul,
      el('p', '', 'After each snap, the big number is how the play moved your win chance. The small square grades your call, whatever happened:'),
      ex,
      el('p', 'note', 'Calls: green, the best or as good; yellow, close; orange, costly; red, a big miss. Your score and the share grid count the calls.'),
      more,
      ...(BUILD ? [privacyLink()] : []),        // the website only (claude.ai has its own)
      disclaimer(),
    ]);
  }
  function openStats() {
    track('stats_open');
    const st = load(`${STORE}:stats`, { days: {} });
    const days = Object.keys(st.days).map(Number).sort((a, b) => a - b);
    let streak = 0; for (let k = dayN; st.days[k]; k--) streak++;
    const avg = days.length ? days.reduce((a, k) => a + st.days[k].p, 0) / days.length : 0;
    const best = days.length ? Math.max(...days.map((k) => st.days[k].p)) : 0;
    const row = el('div', 'stats');
    [[days.length, 'Played'], [days.length ? Math.round(avg * 100) : '–', 'Average percentile'], [streak, 'Day streak'], [days.length ? Math.round(best * 100) : '–', 'Best day']]
      .forEach(([v, l]) => { const c = el('div'); c.append(el('b', '', String(v)), el('span', '', l)); row.append(c); });
    const dist = el('div', 'dist');
    const buckets = [[80, 101, '80–100'], [60, 80, '60–79'], [40, 60, '40–59'], [20, 40, '20–39'], [0, 20, '0–19']];
    const counts = buckets.map(([lo, hi]) => days.filter((k) => st.days[k].p * 100 >= lo && st.days[k].p * 100 < hi).length);
    const mx = Math.max(1, ...counts);
    const todayP = st.days[dayN] ? st.days[dayN].p * 100 : null;
    buckets.forEach(([lo, hi, lab], i) => {
      const r = el('div', 'r');
      const bar = el('div', `bar2${todayP != null && todayP >= lo && todayP < hi ? ' hi' : ''}`, String(counts[i]));
      bar.style.width = `${Math.max(8, (counts[i] / mx) * 100)}%`;
      r.append(el('span', '', lab), bar);
      dist.append(r);
    });
    const nodes = [row, el('p', 'note', 'Daily percentile against NFL play-callers'), dist];
    const coaches = days.map((k) => st.days[k].coach).filter(Boolean);
    if (coaches.length) {
      const top = Object.entries(coaches.reduce((a, c) => ({ ...a, [c]: (a[c] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
      nodes.push(el('p', '', `You coach most like ${top[0]} (${top[1]} day${top[1] === 1 ? '' : 's'}).`));
    }
    const te = tendEl();
    if (te) nodes.push(te);
    const sv = survStats();
    if (sv.runs) nodes.push(el('p', '', `Survivor: best run ${sv.best} win${sv.best === 1 ? '' : 's'} (${sv.runs} run${sv.runs === 1 ? '' : 's'}).`));
    nodes.push(boardEl());
    openModal('Your stats', nodes);
  }

  // one drive a day: the schedule holds three spots a day (a two-minute drill, protecting a lead, a tied game or
  // the end of a half); the day's drive is one of them, the kind rotating from day to day; a featured day plays a
  // famous spot (with its story on the intro) instead of the scheduled one
  function dayIds(n) {
    const row = idx.schedule[(n - 1) % idx.schedule.length], kinds = Object.keys(idx.categories);
    const want = kinds[(n - 1) % kinds.length], feat = idx.featured && idx.featured[n];
    return feat ? [feat.spot] : [row.find((i) => idx.spots[i].category === want) ?? row[(n - 1) % row.length]];
  }
  const dayDate = (n) => { const d = new Date(idx.launch + 'T12:00:00'); d.setDate(d.getDate() + n - 1); return d; };

  // ---- Pro: a one-time purchase (Stripe Checkout behind the board API: /pay, /claim, /restore; board/worker.js).
  // The code the purchase gives is kept here and is all a device needs; the same code restores Pro on another.
  const PRO_KEY = `${STORE}:pro`;
  const proCode = () => String((load(PRO_KEY, null) || {}).code || '');
  // Pro is on only once the board has confirmed the code this page load (proVerify): a code typed into the browser's
  // storage opens nothing, and the Pro data itself is served by the board to a valid code only (proFile)
  let PRO_LIVE = null;                     // true: confirmed; false: no code or refused; null: could not ask (offline)
  const isPro = () => PRO_LIVE === true;
  function proOff(why) { PRO_LIVE = false; if (proCode()) { try { localStorage.removeItem(PRO_KEY); } catch (e) { /* no storage */ } if (why) toast(why); } }
  // the launch time came with the page open: the Pro tab appears, and a code bought earlier is checked
  function proLaunch() {
    PRO_ON = true;
    $('modeArch').hidden = false;
    raceBar();
    proVerify();
  }
  // ---- Accounts (board/worker.js /auth*): Pro on an account, Sign in with Google or an emailed link. The session the
  // board gives is kept here (SESS_KEY); signed in, Pro comes from the account (on any device, no device limit) and the
  // board is asked with { session } in place of { code, key }. A code on the device works as before, signed in or not.
  const SESS_KEY = `${STORE}:session`, UNAME_KEY = `${STORE}:username`;
  const GOOGLE_ID = ((document.querySelector('meta[name="google-client-id"]') || {}).content || '').trim();
  const ACCT = { cfg: null, me: null };           // cfg: { google, email } (GET /auth); me: { email, pro, code? } (signed in)
  const authSession = () => { const s = String(load(SESS_KEY, '') || ''); return /^[0-9a-f]{64}$/.test(s) ? s : ''; };
  const acctPro = () => !!(ACCT.me && ACCT.me.pro && authSession());
  function authClear() { ACCT.me = null; try { localStorage.removeItem(SESS_KEY); localStorage.removeItem(UNAME_KEY); } catch (e) { /* no storage */ } }
  // what proves Pro to the board: the session when the account has Pro, else this device's code and key
  const proCred = () => (acctPro() ? { session: authSession() } : { code: proCode(), key: deviceKey() });
  const proHave = () => acctPro() || !!proCode();
  const proShownCode = () => (acctPro() && ACCT.me.code) || proCode();
  // a session the board no longer knows (signed out elsewhere, expired, accounts off): forget it, Pro by code goes on
  function authLost() { const was = !!authSession(); authClear(); if (was) toast('You are signed out. Sign in again on the Pro tab.'); }
  async function proVerify() {
    if (!PRO_ON) { PRO_LIVE = false; return; }
    if (authSession() && BOARD.api) {
      try {
        const r = await fetch(`${BOARD.api}/auth/me`, POST_JSON({ session: authSession() }));
        if (r.ok) {
          ACCT.me = acctOf(await r.json());
          if (ACCT.me.pro) { PRO_LIVE = true; if (RACE.refresh) RACE.refresh(); return; }
        } else if (r.status === 401 || r.status === 503) authLost();
        else if (!proCode()) { PRO_LIVE = null; return; }
      } catch (e) { if (!proCode()) { PRO_LIVE = null; return; } }
    }
    const code = proCode();
    if (!code) { PRO_LIVE = false; return; }
    if (!BOARD.api) { PRO_LIVE = null; return; }
    try {
      const r = await fetch(`${BOARD.api}/restore`, POST_JSON({ code, key: deviceKey() }));
      if (r.ok) { PRO_LIVE = true; if (RACE.refresh) RACE.refresh(); return; }
      if (r.status === 409) { const d = await r.json().catch(() => ({})); proOff(d.error || 'This code is in use on too many devices'); return; }
      if (r.status === 404 || r.status === 400) { proOff('That Pro code is not valid any more'); return; }
      PRO_LIVE = null;                                                   // the board is down: neither on nor off
    } catch (e) { PRO_LIVE = null; }
  }
  async function proApi(path, body) {
    if (!BOARD.api) throw new Error('no backend here');
    const r = await fetch(`${BOARD.api}${path}`, body ? POST_JSON(body) : POST_JSON({}));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `pro ${r.status}`);
    return d;
  }
  // back from Stripe's page: ?claim=<session> (the address is tidied either way; ?pro=cancel is a cancelled purchase)
  async function proClaimFromUrl() {
    const q = new URLSearchParams(location.search), s = q.get('claim');
    if (!s && !q.has('pro')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (!s || !PRO_BUILT) return;                // (a purchase is claimed whenever it comes back, launched or not)
    try {
      const d = await proApi('/claim', { s, key: deviceKey() });
      save(PRO_KEY, { code: d.code, at: Date.now() });
      PRO_LIVE = true;
      track('pro_unlocked');
      track('purchase', { currency: 'USD', value: 4.99, transaction_id: d.code, items: [{ item_id: 'pro', item_name: 'Two-Minute Drill Pro', price: 4.99, quantity: 1 }] });
      toast('Pro unlocked');
      openModal('Pro unlocked', [proCodeCard(true)]);
    } catch (e) { toast('The purchase could not be confirmed: ' + e.message); }
  }
  // signed in (Google, or an emailed link): keep the session; on to the Pro tab, where it shows
  // signed in (Google, or an emailed link): keep the session and show who in the top bar. An account without a username
  // picks one first. On the Pro tab the page reloads after, so the tab shows the account's Pro.
  const acctOf = (d) => {
    save(UNAME_KEY, d.name || '');
    return { email: d.email, name: d.name || '', pro: !!d.pro, ...(d.code ? { code: d.code } : {}), leagues: Array.isArray(d.leagues) ? d.leagues : [], remind: !!d.remind };
  };
  function authSignedIn(d) {
    save(SESS_KEY, d.session);
    ACCT.me = acctOf(d);
    if (d.pro) PRO_LIVE = true;
    track('login');
    acctBar();
    statsSync(true);
    const then = () => { if (ARCH) location.reload(); else leaguePending(); };
    if (!ACCT.me.name) { nameSheet(true, then); return; }
    closeModal();
    toast(`Signed in as ${ACCT.me.name}`);
    then();
  }
  async function authGoogle(credential) {
    try { authSignedIn(await proApi('/auth/google', { credential })); } catch (e) { toast('Google sign-in did not work: ' + e.message); }
  }
  // back from the sign-in email: ?login=<token> (used once; the address is tidied either way)
  async function authLoginFromUrl() {
    const q = new URLSearchParams(location.search), tok = q.get('login');
    if (!tok) return;
    q.delete('login');
    const rest = q.toString();
    const tidy = (hash) => history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + hash);
    tidy(location.hash);
    try {
      const d = await proApi('/auth/email/verify', { token: tok });
      save(SESS_KEY, d.session);
      ACCT.me = acctOf(d);
      ACCT.fresh = true;                        // (acctInit asks for a username once the page is up)
      track('login');
      if (ACCT.me.name) toast(`Signed in as ${ACCT.me.name}`);
    } catch (e) { toast(e.message || 'That sign-in link did not work'); }
  }
  async function authSignOut() {
    const s = authSession();
    authClear();
    try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* no Google */ }
    if (s && BOARD.api) await fetch(`${BOARD.api}/auth/logout`, POST_JSON({ session: s })).catch(() => {});
    track('logout');
    location.reload();
  }
  // Google's own button (Google Identity Services), loaded only when the page names a client id
  let gisLoad = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (!gisLoad) {
      gisLoad = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
        s.onload = () => res(); s.onerror = () => { gisLoad = null; rej(new Error('Google sign-in did not load')); };
        document.head.append(s);
      });
    }
    return gisLoad;
  }
  // which ways to sign in the board has set up (GET /auth, once a page load); null: no board, or it could not be asked
  let cfgAsk = null;
  function authCfg() {
    if (ACCT.cfg) return Promise.resolve(ACCT.cfg);
    if (!cfgAsk) {
      cfgAsk = (async () => {
        await BOARD.ready;
        if (!BOARD.api) return null;
        try { const r = await fetch(`${BOARD.api}/auth`, { cache: 'no-store' }); ACCT.cfg = r.ok ? await r.json() : { google: false, email: false }; } catch (e) { cfgAsk = null; return null; }
        return ACCT.cfg;
      })();
    }
    return cfgAsk;
  }
  const authWays = () => ({ google: !!(ACCT.cfg && ACCT.cfg.google && GOOGLE_ID), email: !!(ACCT.cfg && ACCT.cfg.email) });
  // the ways in, as nodes: Google's own button (it signs you up the first time, in after), and an emailed link
  function signInWays() {
    const { google, email } = authWays(), nodes = [];
    if (google) {
      const g = el('div', 'gbtn');
      nodes.push(g);
      loadGis().then(() => {
        window.google.accounts.id.initialize({ client_id: GOOGLE_ID, callback: (resp) => authGoogle(resp && resp.credential), ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true });
        window.google.accounts.id.renderButton(g, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'left', width: Math.min(320, Math.max(220, g.clientWidth || 300)) });
      }).catch(() => { g.replaceWith(el('p', 'note', email ? 'Google sign-in did not load. Reload to try again, or use email.' : 'Google sign-in did not load. Reload to try again.')); });
    }
    if (google && email) nodes.push(el('div', 'or', 'or'));
    if (email) {
      const form = el('form', 'row'), inp = el('input'), go = el('button', 'btn', 'Email me a link');
      inp.type = 'email'; inp.placeholder = 'you@example.com'; inp.autocomplete = 'email'; inp.required = true; inp.setAttribute('aria-label', 'Your email');
      go.type = 'submit';
      form.append(inp, go);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const addr = inp.value.trim();
        if (!addr) { inp.focus(); return; }
        go.disabled = true;
        try {
          await proApi('/auth/email', { email: addr });
          track('login_email');
          form.replaceWith(el('p', 'sent', `Check your inbox: a sign-in link is on its way to ${addr}. It works once, for 15 minutes.`));
        } catch (e) { toast(e.message); go.disabled = false; }
      });
      nodes.push(form);
    }
    return nodes;
  }
  // the Sign in card on the Pro tab: signed in (who, Sign out, and Pro on this device's code to add to the account),
  // or the ways to sign in the board has set up (none: no card)
  function authNodes() {
    const box = el('div', 'acct');
    box.hidden = true;
    (async () => {
      if (!(await authCfg())) return;
      const { google, email } = authWays();
      if (ACCT.me && authSession()) {
        const row = el('div', 'arow'), out = el('button', 'btn ghostbtn', 'Sign out');
        out.type = 'button';
        out.addEventListener('click', authSignOut);
        row.append(el('span', 'who', `Signed in as ${ACCT.me.name || ACCT.me.email}`), out);
        box.append(el('div', 'k', 'Your account'), row);
        if (ACCT.me.pro) box.append(el('p', 'note', 'Pro is on your account: sign in on any device to play it there.'));
        else if (proCode() && isPro()) {
          const add = el('button', 'btn', 'Add Pro to this account');
          add.type = 'button';
          add.addEventListener('click', async () => {
            add.disabled = true;
            try {
              const d = await proApi('/auth/link', { session: authSession(), code: proCode(), key: deviceKey() });
              ACCT.me = acctOf(d);
              track('pro_linked');
              toast('Pro is on your account now');
              location.reload();
            } catch (e) { toast(e.message); add.disabled = false; }
          });
          box.append(el('p', 'note', 'This device has Pro by code. Add it to your account and it works on any device you sign in on, no code needed.'), add);
        } else box.append(el('p', 'note', 'No Pro on this account yet. Buy it while signed in (or add a code you have) and it stays with the account.'));
        box.hidden = false;
        return;
      }
      if (!google && !email) return;
      box.append(el('div', 'k', 'Sign in'), el('p', 'note', isPro() ? 'Keep your Pro on an account: sign in and add it, and it works on any device you sign in on, no code needed.'
        : 'Signed in, a purchase stays with your account: it works on any device you sign in on, no code to keep.'), ...signInWays());
      box.hidden = false;
    })();
    return box;
  }
  // ---- the account button, top right: Log in (a sheet with the ways in), then your username. Hidden when the board
  // has no way to sign in set up.
  const PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4.1-5.6 7.5-5.6s6.3 1.8 7.5 5.6"/></svg>';
  const signedIn = () => !!(ACCT.me && authSession());
  function acctBar() {
    const b = $('acctBtn');
    if (!b) return;
    b.textContent = '';
    b.classList.remove('on', 'noname');
    if (signedIn()) {
      const nm = ACCT.me.name;
      b.classList.add('on');
      if (!nm) b.classList.add('noname');
      b.append(el('span', 'av', (nm || ACCT.me.email || '?').slice(0, 1)), el('span', 'nm', nm || 'Pick a username'));
      b.setAttribute('aria-label', nm ? `Your account: ${nm}` : 'Your account: pick a username');
      b.hidden = false;
      return;
    }
    const { google, email } = authWays();
    b.hidden = !(google || email);
    b.innerHTML = PERSON;
    b.append(el('span', 'nm', 'Log in'));
    b.setAttribute('aria-label', 'Log in or sign up');
  }
  function openAccount() {
    if (!signedIn()) { signInSheet(); return; }
    if (!ACCT.me.name) nameSheet(false);
    else acctSheet();
  }
  function signInSheet(lead) {
    const box = el('div', 'acctsheet'), perks = el('ul', 'perks');
    ['Your username, streak and stats on any phone or computer', 'Friend leagues: a board of the daily for your group',
      'Pro on any device you sign in on, no code to keep', 'New here? The same button makes your account'].forEach((t) => perks.append(el('li', '', t)));
    box.append(...(lead ? [lead] : []), perks, ...signInWays(), el('p', 'note', 'We only keep your email address to know it is you. No posts, no spam.'));
    openModal('Log in or sign up', [box]);
  }
  // pick (first: just signed up) or change the username: 3-20 characters, one account each, shown at the top
  function nameSheet(first, then) {
    const box = el('div', 'acctsheet'), form = el('form'), inp = el('input'), go = el('button', 'btn', 'Save'), err = el('p', 'err');
    err.hidden = true;
    inp.maxLength = 20; inp.minLength = 3; inp.autocomplete = 'nickname'; inp.spellcheck = false; inp.required = true;
    inp.placeholder = 'Your username'; inp.setAttribute('aria-label', 'Your username');
    inp.value = (ACCT.me && ACCT.me.name) || (first ? String(myName() || '').slice(0, 20) : '');
    go.type = 'submit';
    form.append(inp, go);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = inp.value.replace(/\s+/g, ' ').trim();
      if (name.length < 3) { err.textContent = 'At least 3 characters.'; err.hidden = false; inp.focus(); return; }
      go.disabled = true; err.hidden = true;
      try {
        const d = await proApi('/auth/name', { session: authSession(), name });
        ACCT.me = acctOf(d);
        track(first ? 'username_set' : 'username_changed');
        acctBar();
        onModalClose = null;
        closeModal();
        toast(first ? `Welcome, ${ACCT.me.name}` : `You're ${ACCT.me.name} now`);
        if (then) then();
      } catch (e) {
        if (/signed out/i.test(e.message)) { authLost(); acctBar(); closeModal(); return; }
        err.textContent = e.message; err.hidden = false; go.disabled = false; inp.focus();
      }
    });
    box.append(el('p', '', first ? 'You’re signed in. Pick the name people see:' : 'Your new username:'), form, err,
      el('p', 'note', '3 to 20 letters or digits; spaces, _ - . and ’ are fine inside. One account each.'));
    openModal(first ? 'Pick a username' : 'Change username', [box]);
    onModalClose = then || null;
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }
  function acctSheet() {
    const m = ACCT.me, box = el('div', 'acctsheet'), who = el('div', 'who'), txt = el('div');
    txt.append(el('b', '', m.name), el('span', 'em', m.email));
    who.append(el('span', 'av', m.name.slice(0, 1)), txt);
    box.append(who);
    if (m.pro) box.append(el('p', 'note', 'Pro is on your account: sign in on any device to play it there.'));
    else if (PRO_ON) {
      const a = el('a', '', 'Get Pro');
      a.href = '#archive';
      const p = el('p', 'note', 'No Pro on this account yet. ');
      p.append(a, ' and it stays with the account.');
      box.append(p);
    }
    box.append(leaguesEl());
    if (ACCT.cfg && ACCT.cfg.email) box.append(remindToggle());
    const acts = el('div', 'acts'), ch = el('button', 'btn ghostbtn', 'Change username'), out = el('button', 'btn ghostbtn', 'Sign out');
    ch.type = 'button'; out.type = 'button';
    ch.addEventListener('click', () => nameSheet(false));
    out.addEventListener('click', authSignOut);
    acts.append(ch, out);
    box.append(acts);
    openModal('Your account', [box]);
  }
  // the daily email (board /auth/remind; only where the board can send email): one a day when the new daily is up
  function remindToggle() {
    const tg = el('div', 'toggle'), lab = el('div', 'lab', 'Email me when the new daily is up'), sw = el('button', 'sw2');
    lab.append(el('small', '', 'One short email a day. Every one has an unsubscribe link.'));
    sw.type = 'button';
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!ACCT.me.remind)); sw.setAttribute('aria-label', 'Email me when the new daily is up');
    sw.addEventListener('click', async () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      sw.setAttribute('aria-checked', String(on));
      try {
        ACCT.me = acctOf(await proApi('/auth/remind', { session: authSession(), on }));
        track(on ? 'remind_on' : 'remind_off');
        toast(ACCT.me.remind ? 'You’ll get an email when each new daily is up' : 'No more daily emails');
      } catch (e) {
        if (/signed out/i.test(e.message)) { authLost(); acctBar(); closeModal(); return; }
        toast(e.message);
      }
      sw.setAttribute('aria-checked', String(!!(ACCT.me && ACCT.me.remind)));
      sw.disabled = false;
    });
    tg.append(lab, sw);
    return tg;
  }
  // the daily email's unsubscribe link: ?unsub=<ref>.<token> (no sign-in needed; the address is tidied either way)
  async function unsubFromUrl() {
    const q = new URLSearchParams(location.search), u = q.get('unsub');
    if (!u) return;
    q.delete('unsub');
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    const [r, t] = u.split('.');
    try {
      await proApi('/auth/unsub', { r, t });
      if (ACCT.me) ACCT.me.remind = false;
      track('remind_unsub');
      toast('Unsubscribed: no more daily emails');
    } catch (e) { toast(`That unsubscribe link did not work (${e.message}). Turn the email off in your account instead.`); }
  }

  // ---- Stats that follow the account (board /auth/stats): signed in, this browser's record (the stats days, the
  // historic drives, the playoff runs) and the account's are merged, the best of each kept on both sides, so a streak
  // and the drives passed come along to a new phone. On sign-in, on a page load (at most every SYNC_MS: switching
  // modes reloads the page) and after each finished daily, drive or run. Drives only from the Gauntlet's start on
  // (gauntletFresh moved the ones before aside).
  const SYNC_KEY = `${STORE}:synced`, SYNC_MS = 10 * 60e3, SYNC_CAP = { days: 2000, drives: 500, runs: 500 };
  // the better of this browser's record of a day, drive or run and the account's (the board's rules, worker.js
  // statBetter); a drive keeps this browser's own try stamp and last result (renderSummary's: the try counted once)
  function statBest(kind, mine, theirs) {
    if (!mine || !theirs) return mine || theirs;
    const w = theirs.p > mine.p ? theirs : mine;
    if (kind === 'drives') return { ...w, tries: Math.max(mine.tries || 0, theirs.tries || 0), won: !!(mine.won || theirs.won), ...(mine.at ? { at: mine.at } : {}), ...(mine.prev ? { prev: mine.prev } : {}) };
    if (kind === 'days' && !w.madden && (mine.madden || theirs.madden)) return { ...w, coach: 'John Madden', madden: mine.madden || theirs.madden };
    return w;
  }
  const newest = (o, n) => Object.fromEntries(Object.keys(o || {}).map(Number).filter((k) => k > 0).sort((a, b) => a - b).slice(-n).map((k) => [k, o[k]]));
  const gauntletDrives = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, r]) => r && r.at >= GAUNTLET_FROM));
  // the account's record into this browser's, read fresh (a drive may have finished while the board answered); true
  // when anything here changed
  function statsTake(acc) {
    if (!acc) return false;
    const st = load(`${STORE}:stats`, { days: {} }), here = { days: st.days || (st.days = {}), drives: load(`${STORE}:drives`, {}), runs: load(`${STORE}:runs`, {}) };
    let changed = false;
    for (const kind of ['days', 'drives', 'runs']) {
      for (const [k, v] of Object.entries(kind === 'drives' ? gauntletDrives(acc.drives) : acc[kind] || {})) {
        const b = statBest(kind, here[kind][k], v);
        if (JSON.stringify(b) !== JSON.stringify(here[kind][k])) { here[kind][k] = b; changed = true; }
      }
    }
    if (changed) { save(`${STORE}:stats`, st); save(`${STORE}:drives`, here.drives); save(`${STORE}:runs`, here.runs); }
    return changed;
  }
  let syncQ = Promise.resolve(false);        // one sync at a time, in order (a finish while one is out goes after it)
  function statsSync(force) {
    syncQ = syncQ.catch(() => false).then(async () => {
      if (!signedIn() || !BOARD.api) return false;
      if (!force && Date.now() - Number(load(SYNC_KEY, 0) || 0) < SYNC_MS) return false;
      const st = load(`${STORE}:stats`, { days: {} });
      const stats = { days: newest(st.days, SYNC_CAP.days), drives: newest(gauntletDrives(load(`${STORE}:drives`, {})), SYNC_CAP.drives), runs: newest(load(`${STORE}:runs`, {}), SYNC_CAP.runs) };
      let d;
      try { d = await proApi('/auth/stats', { session: authSession(), stats }); } catch (e) {
        if (/signed out/i.test(e.message)) { authLost(); acctBar(); }
        return false;
      }
      save(SYNC_KEY, Date.now());
      const changed = statsTake(d.stats);
      if (changed) streakRedraw();
      return changed;
    });
    return syncQ;
  }
  // a day finished on another phone: the end card's streak line, if it is up, counts it
  function streakRedraw() {
    const line = document.querySelector('#done .streak');
    if (!line || !state || !state.done || SURV || DRIVE || RUN_N || ARCH_DAY) return;
    const st = load(`${STORE}:stats`, { days: {} });
    let streak = 0; for (let k = dayN; st.days[k]; k--) streak++;
    line.textContent = streak >= 2 ? `🔥 ${streak}-day streak` : 'Day 1 of your streak · come back tomorrow';
  }

  // ---- Friend leagues (board /league/*): a private board of the daily for a group of friends: each member's
  // username, the day's score, the streak and the last 7 days' average, best score first. Made in the account sheet;
  // joined by the link a member shares (#league-<code>; opened signed out, the join waits for the sign-in: LEAGUE_KEY).
  const LEAGUE_HASH = ((location.hash.match(/^#league-([A-Za-z0-9]{8})$/) || [])[1] || '').toUpperCase();
  const LEAGUE_KEY = `${STORE}:leaguejoin`, LEAGUES_MAX = 10;
  const leagueLink = (code) => `${location.origin}${location.pathname}#league-${code}`;
  const myLeagues = () => (signedIn() && ACCT.me.leagues) || [];
  const leagueApi = (path, body) => proApi(`/league/${path}`, { session: authSession(), ...body });
  const lgFail = (e) => { if (/signed out/i.test(e.message)) { authLost(); acctBar(); closeModal(); toast('You are signed out. Log in again.'); return true; } return false; };
  // the account sheet's section: your leagues (each opens its board) and a new one
  function leaguesEl() {
    const sec = el('div', 'sec'), ls = myLeagues();
    sec.append(el('div', 'k', 'Leagues'));
    if (ls.length) {
      const list = el('div', 'llist');
      ls.forEach((l) => {
        const b = el('button', 'lrow');
        b.type = 'button';
        b.append(el('span', 'nm', l.name), el('span', 'n', `${l.n} player${l.n === 1 ? '' : 's'}`), el('span', 'go', '›'));
        b.addEventListener('click', () => leagueBoard(l.code));
        list.append(b);
      });
      sec.append(list);
    } else sec.append(el('p', 'note', 'Play the daily against your friends: make a league and send them the link. Everyone’s score, streak and week, on one board.'));
    if (ls.length < LEAGUES_MAX) {
      const form = el('form'), inp = el('input'), go = el('button', 'btn', 'Create');
      inp.maxLength = 30; inp.minLength = 3; inp.required = true; inp.placeholder = ls.length ? 'Start another league' : 'League name, e.g. Sunday Crew'; inp.setAttribute('aria-label', 'League name');
      go.type = 'submit';
      form.append(inp, go);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = inp.value.replace(/\s+/g, ' ').trim();
        if (name.length < 3) { toast('A league name is at least 3 characters'); inp.focus(); return; }
        go.disabled = true;
        try {
          const d = await leagueApi('create', { name });
          ACCT.me.leagues = d.leagues;
          track('league_create');
          leagueNudge();
          leagueBoard(d.league.code, true);
        } catch (e) { if (!lgFail(e)) toast(e.message); go.disabled = false; }
      });
      sec.append(form);
    }
    return sec;
  }
  // a league's board (a modal): the day's standings, the invite link, the other leagues, leaving. fresh: just made
  async function leagueBoard(code, fresh) {
    const box = el('div', 'acctsheet lboard'), body = el('div', 'lbody');
    body.append(el('p', 'note', 'Loading the league…'));
    box.append(body);
    openModal('League', [box]);
    await syncQ.catch(() => {});                    // (today's finish goes up first)
    let d;
    try { d = await leagueApi('board', { code, day: dayOf(new Date()) }); } catch (e) {
      if (lgFail(e)) return;
      body.textContent = '';
      body.append(el('p', 'err', /no such league/i.test(e.message) ? 'You are not in that league any more.' : `The league did not load: ${e.message}`));
      return;
    }
    if (!box.isConnected) return;                    // (closed while it loaded)
    $('mTitle').textContent = d.name;
    body.textContent = '';
    const played = d.rows.filter((x) => x.today != null).length;
    body.append(el('p', 'note', `No. ${d.day} · ${played} of ${d.n} played today`));
    const ol = el('ol', 'lrows');
    d.rows.forEach((x, i) => {
      const li = el('li', x.you ? 'me' : ''), who = el('div', 'lwho'), meta = [];
      if (x.streak >= 2) meta.push(`🔥 ${x.streak}`);
      if (x.avg7 != null) meta.push(`7-day avg ${Math.round(x.avg7 * 100)}`);
      who.append(el('span', 'nm', x.you ? `${x.name} (you)` : x.name), el('small', '', meta.join(' · ') || 'No days this week'));
      li.append(el('span', 'n', x.today != null ? String(i + 1) : '–'), who, x.today != null ? el('b', '', String(Math.round(x.today * 100))) : el('span', 'not', 'not yet'));
      ol.append(li);
    });
    body.append(ol, el('p', 'note', 'Today’s score: better than that % of NFL play-callers. 🔥 days in a row.'));
    // the invite: the join link, to share (a group chat) or copy
    const inv = el('div', 'invite'), link = leagueLink(d.code), share = el('button', 'btn alt', fresh ? 'Invite your friends' : 'Invite friends'), pre = el('div', 'lnk', link);
    share.type = 'button';
    share.addEventListener('click', () => shareText(`Join my Two-Minute Drill league, ${d.name}: one real NFL drive a day, who calls it best?\n${link}`, pre, 'league'));
    inv.append(share, pre);
    body.append(inv);
    const others = myLeagues().filter((l) => l.code !== d.code);
    if (others.length) {
      const row = el('div', 'chips');
      others.forEach((l) => { const c = el('button', 'chip', l.name); c.type = 'button'; c.addEventListener('click', () => leagueBoard(l.code)); row.append(c); });
      body.append(el('div', 'k', 'Your other leagues'), row);
    }
    const leave = el('button', 'btn ghostbtn', 'Leave this league');
    leave.type = 'button';
    leave.addEventListener('click', async () => {
      if (leave.dataset.sure !== '1') { leave.dataset.sure = '1'; leave.textContent = d.n > 1 ? 'Tap again to leave' : 'Tap again: you are the last one, the league ends'; return; }
      leave.disabled = true;
      try {
        const r = await leagueApi('leave', { code: d.code });
        ACCT.me.leagues = r.leagues;
        track('league_leave');
        leagueNudge();
        closeModal();
        toast(`You left ${d.name}`);
      } catch (e) { if (!lgFail(e)) toast(e.message); leave.disabled = false; }
    });
    body.append(leave);
    track('league_board', { n: d.n });
  }
  // a join link: signed out, sign in first (the join waits); without a username, pick one; then join, and the board
  async function leagueJoin(code) {
    let peek = null;
    try { peek = await proApi('/league/peek', { code }); } catch (e) { toast(/no such league/i.test(e.message) ? 'That league link is not valid (any more).' : e.message); return; }
    if (!signedIn()) {
      save(LEAGUE_KEY, code);
      signInSheet(el('p', 'lead', `Log in to join ${peek.name} (${peek.n} player${peek.n === 1 ? '' : 's'}).`));
      return;
    }
    if (!ACCT.me.name) { save(LEAGUE_KEY, code); nameSheet(true, leaguePending); return; }
    if (myLeagues().some((l) => l.code === peek.code)) { leagueBoard(peek.code); return; }
    const box = el('div', 'acctsheet'), acts = el('div', 'acts'), yes = el('button', 'btn alt', 'Join'), no = el('button', 'btn ghostbtn', 'Not now');
    yes.type = 'button'; no.type = 'button';
    no.addEventListener('click', closeModal);
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        const d = await leagueApi('join', { code: peek.code });
        ACCT.me.leagues = d.leagues;
        track('league_join', { n: d.league.n });
        leagueNudge();
        toast(`You’re in ${d.league.name}`);
        leagueBoard(peek.code);
      } catch (e) { if (!lgFail(e)) toast(e.message); yes.disabled = false; }
    });
    acts.append(yes, no);
    box.append(el('p', 'lead', `${peek.n} player${peek.n === 1 ? ' plays' : 's play'} the daily in this league. Join, and your score, streak and week show on its board, under your username ${ACCT.me.name}.`), acts);
    openModal(`Join ${peek.name}?`, [box]);
  }
  function leaguePending() {
    const code = load(LEAGUE_KEY, '');
    if (!code || !signedIn() || !ACCT.me.name) return;
    try { localStorage.removeItem(LEAGUE_KEY); } catch (e) { /* no storage */ }
    leagueJoin(code);
  }
  // the end card's "See how your league did" (when the account is in a league; the account may be asked after the
  // card is drawn, so it is filled in then too)
  function leagueNudge() {
    document.querySelectorAll('.lglink').forEach((p) => {
      const ls = myLeagues();
      p.textContent = '';
      p.hidden = !ls.length;
      if (!ls.length) return;
      const b = el('button', 'linkbtn', ls.length === 1 ? `See how ${ls[0].name} did` : 'See how your league did');
      b.type = 'button';
      b.addEventListener('click', () => { track('league_nudge'); leagueBoard(ls[0].code); });
      p.append(b);
    });
  }
  // the top bar, once the page is up: the ways in (for Log in), who is signed in (asked when Pro did not ask already)
  async function acctInit() {
    $('acctBtn').addEventListener('click', openAccount);
    if (!(await authCfg())) return;
    if (authSession() && !ACCT.me) {
      try {
        const r = await fetch(`${BOARD.api}/auth/me`, POST_JSON({ session: authSession() }));
        if (r.ok) ACCT.me = acctOf(await r.json());
        else if (r.status === 401 || r.status === 503) authLost();
      } catch (e) { /* offline: Log in shows; the session is kept */ }
    }
    acctBar();
    const fresh = ACCT.fresh;
    ACCT.fresh = false;
    if (fresh && signedIn() && !ACCT.me.name && $('modal').hidden) nameSheet(true, leaguePending);
    if (signedIn()) { statsSync(fresh); leagueNudge(); }
    if (LEAGUE_HASH) {                          // a join link: the address tidied (no reload: replaceState fires no hashchange)
      history.replaceState(null, '', location.pathname + location.search);
      leagueJoin(LEAGUE_HASH);
    } else leaguePending();
  }
  // ---- The Gauntlet: the contest across the historic drives (board/worker.js /race). Pass all of them (an A each)
  // first and win. A Pro code enters under a public name; only passes made after entering count, each drive once; the
  // board is live (polled while it is on screen) and open to everyone, Pro or not
  const RACE_NAME = 'The Gauntlet';
  const RACE_PRIZE = '$50, the Gauntlet Champion title on the site and the pick of a future daily';                  // what the winner gets, in a few words ('' says "the prize")
  const RACE_POLL = 15000;
  const RACE = { view: null, full: false, timer: 0 };
  const racePrize = () => RACE_PRIZE || 'the prize';
  async function raceCall(path, body) {
    if (!BOARD.api) throw new Error('the leaderboard is not on this site');
    const r = await fetch(`${BOARD.api}${path}`, body ? POST_JSON(body) : { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...d };
  }
  const raceFetch = () => (isPro() ? raceCall('/race/me', proCred()) : raceCall('/race'));
  const hms = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
    return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
  // the board's clock (a phone's own can be minutes off): the countdown and the Live chip go by it
  const raceSkew = (d) => { const t = Date.parse(d && d.now); if (Number.isFinite(t)) RACE.skew = t - Date.now(); };
  const raceNow = () => Date.now() + (RACE.skew || 0);
  const raceOver = (v) => !!v && (v.over || (!!v.to && raceNow() >= Date.parse(v.to)));     // past the end (the board's clock)
  // the contest's panel: what it is, live status, your entry (or how to enter), the board, the rules
  function racePanel() {
    const box = el('div', 'race');
    box.setAttribute('aria-live', 'polite');
    const draw = () => {
      const v = RACE.view, n = (v && v.n) || (PRO ? PRO.drives.length : 24);
      box.textContent = '';
      const head = el('div', 'rhead');
      const live = v && raceNow() >= Date.parse(v.from), over = raceOver(v);
      const chip = el('span', `rchip${v && (v.winner || over) ? ' won' : live ? ' live' : ''}`, over ? 'Final' : v && v.winner ? 'Won' : live ? 'Live' : v ? `Starts in ${hms(Date.parse(v.from) - raceNow())}` : '…');
      chipEl = chip;
      head.append(el('span', 'rk', 'The contest'), chip);
      box.append(head, el('h3', 'rtitle', RACE_NAME));
      // a winner, or past the end: the results take the panel (the board stays open for 2nd and 3rd until the end)
      if (v && (v.winner || over)) { raceFinal(v, n, over); return; }
      box.append(el('p', 'rlead', `${n} historic drives. Pass every one, an A (${PASS_AT} or better) on each. The first to do it wins ${racePrize()}.`));
      if (!v) { box.append(el('p', 'note', BOARD.api ? 'Loading the leaderboard…' : 'The leaderboard is on nfl2mindrill.com.')); return; }
      const stats = el('div', 'rstats');
      stats.append(el('span', '', `${v.entrants} in the race`), el('span', '', `${v.passes} drive${v.passes === 1 ? '' : 's'} passed`));
      if (v.rows[0] && v.rows[0].n) stats.append(el('span', '', `Leader: ${v.rows[0].name}, ${v.rows[0].n}/${n}`));
      box.append(stats);
      box.append(youBox(v, n, live));
      raceBoard(v, n, RACE.full ? v.rows.length : 10);
      box.append(raceRules(n));
    };
    // you: your entry and where you stand, or how to enter
    const youBox = (v, n, live) => {
      const me = v.me, you = el('div', 'ryou');
      if (me) {
        const bar = el('div', 'rbar'), fill = el('i');
        fill.style.width = `${(100 * me.n) / n}%`;
        bar.append(fill);
        you.append(el('div', 'rme', `${me.name}`), el('div', 'rme2', `${me.n}/${n} passed${me.rank ? ` · ${ordinal(me.rank)} place` : ''}`), bar,
          el('p', 'note', me.done ? `All ${n} passed. Hall of Fame.` : me.n ? `Next: any drive you haven't passed since you entered. ${n - me.n} to go.` : 'Pass a historic drive with an A to get on the board. Drives passed before you entered don’t count, so play them again.'));
        if (!live) {                       // before the start: a new name for the same entry
          const ch = el('button', 'btn ghostbtn', 'Change name');
          ch.type = 'button';
          ch.addEventListener('click', () => {
            const form = el('form', 'rjoin'), inp = el('input'), go = el('button', 'btn', 'Save');
            inp.maxLength = 24; inp.value = me.name; inp.setAttribute('aria-label', 'Your new name for the Gauntlet'); inp.autocomplete = 'nickname';
            go.type = 'submit';
            form.append(inp, go);
            form.addEventListener('submit', async (ev) => {
              ev.preventDefault();
              const name = inp.value.trim();
              if (!name) { inp.focus(); return; }
              go.disabled = true;
              try {
                const d = await raceCall('/race/join', { ...proCred(), name, rename: true });
                if (!d.ok) { toast(d.error || 'Could not change it'); go.disabled = false; return; }
                RACE.view = d;
                toast(`You're on the board as ${d.me.name}.`);
                draw();
              } catch (e) { toast('No connection to the board. Try again.'); go.disabled = false; }
            });
            ch.replaceWith(form);
            inp.focus();
          });
          you.append(ch);
        }
      } else if (isPro()) {
        const form = el('form', 'rjoin'), inp = el('input'), go = el('button', 'btn', 'Enter');
        inp.placeholder = 'Your name on the board'; inp.maxLength = 24; inp.setAttribute('aria-label', 'Your name for the Gauntlet');
        inp.value = (signedIn() && ACCT.me.name) || myName() || ''; inp.autocomplete = 'nickname';
        go.type = 'submit';
        form.append(inp, go);
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const name = inp.value.trim();
          if (!name) { inp.focus(); return; }
          go.disabled = true;
          try {
            const d = await raceCall('/race/join', { ...proCred(), name });
            if (!d.ok) { toast(d.error || 'Could not enter'); go.disabled = false; return; }
            RACE.view = d;
            track('race_join');
            toast(`You're in. Good luck, ${d.me.name}.`);
            draw();
          } catch (e) { toast('No connection to the board. Try again.'); go.disabled = false; }
        });
        you.append(el('div', 'rme', 'Enter the race'), form, el('p', 'note', 'Your name shows on the board for everyone. Only drives you pass after entering count, so enter before you play.'));
      } else if ((proCode() || authSession()) && PRO_LIVE === null) {      // Pro on this device or account, not confirmed yet: the entry comes once it is
        you.append(el('div', 'rme', 'Checking your Pro…'), el('p', 'note', 'One moment: your entry shows here once your Pro code is confirmed.'));
      } else {
        const a = el('a', 'btn', 'Get Pro to enter');
        a.href = '#proBuy';
        a.addEventListener('click', (ev) => { ev.preventDefault(); const t = document.querySelector('.arch .pro'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); else location.hash = '#archive'; });
        you.append(el('div', 'rme', 'Want in?'), el('p', 'note', `Pro opens the ${n} historic drives and your entry. One code, one entry.`), a);
      }
      return you;
    };
    // the board: the top `top` rows (and the button for the rest)
    const raceBoard = (v, n, top) => {
      const me = v.me, rows = v.rows.slice(0, top);
      if (rows.length) {
        const ol = el('ol', 'rboard');
        rows.forEach((x, i) => {
          const li = el('li', `${me && x.name === me.name ? 'mine' : ''}${x.done ? ' done' : ''}`.trim());
          const bar = el('span', 'rb'), fill = el('i');
          fill.style.width = `${(100 * x.n) / n}%`;
          bar.append(fill);
          li.append(el('span', 'rr', String(i + 1)), el('span', 'rn', x.done ? `🏆 ${x.name}` : x.name), bar, el('span', 'rc', `${x.n}/${n}`));
          ol.append(li);
        });
        box.append(ol);
        if (v.rows.length > 10 && top < Infinity) {
          const more = el('button', 'btn ghostbtn', RACE.full ? 'Top 10' : `Full board (${v.rows.length})`);
          more.type = 'button';
          more.addEventListener('click', () => { RACE.full = !RACE.full; draw(); });
          box.append(more);
        }
      } else box.append(el('p', 'note', 'Nobody on the board yet. The first pass takes the lead.'));
    };
    const raceRules = (n) => {
      const rules = el('details', 'rrules');
      rules.append(el('summary', '', 'Rules'));
      const ul = el('ul');
      [`Open to Pro players: one entry per Pro code, under a name everyone can see (no slurs or obscenities: names like that are refused).`,
        `Pass a historic drive with an A: ${PASS_AT} or better, better than ${PASS_AT}% of NFL play-callers. You have to win the game: a loss or a tie tops out at 89. The score is mostly the calls, partly the result, so an A takes the win and sharp calls. Each drive counts once, the first time you pass it after entering.`,
        `The board ranks by drives passed, then by who got there first (the server's clock). The first to pass all ${n} wins ${racePrize()}.`,
        'Every pass keeps the calls behind it. A winning run is checked call by call before the prize goes out; a run that doesn’t hold up is taken off the board.',
        '2nd and 3rd to pass all 24: 2nd picks a future daily too, 3rd gets a shout-out on the site and our socials.',
        'One drive at a time: passes come in at most one every 30 seconds.'].forEach((t) => ul.append(el('li', '', t)));
      rules.append(ul);
      return rules;
    };
    // the results: the champion, 2nd and 3rd (the first three to pass all of them, in order; once it is over, the top
    // of the standings for a place nobody finished), what's next, the full standings, a link to share
    const raceFinal = (v, n, over) => {
      const me = v.me, fin = v.rows.filter((x) => x.done), when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const champ = v.winner || fin[0];
      box.append(el('p', 'rlead', champ ? `${champ.name} passed all ${n} historic drives first and is the Gauntlet Champion.` : `The Gauntlet is over. Nobody passed all ${n}: the standings are final.`));
      const pod = el('ol', 'rpod'), prize = [racePrize(), 'Picks a future daily', 'A shout-out on the site and our socials'];
      ['Champion', '2nd', '3rd'].forEach((label, i) => {
        const x = fin[i] || (over ? v.rows.filter((r) => !r.done)[i - fin.length] : null), li = el('li', `rp${i + 1}${x ? '' : ' open'}`);
        li.append(el('span', 'rpk', x && !x.done ? ordinal(i + 1) : label), el('b', 'rpn', x ? `${i ? '' : '🏆 '}${x.name}` : 'Open'),
          el('span', 'rps', x ? (x.done ? `All ${n} · ${when(x.done)}` : `${x.n}/${n} passed`) : `The next to pass all ${n} takes it`));
        if (x && x.done) li.append(el('span', 'rpz', prize[i]));
        pod.append(li);
      });
      box.append(pod);
      if (!over) box.append(el('p', 'note', `The board stays open for 2nd and 3rd: pass all ${n} to take a place.`));
      if (me && over) box.append(el('p', 'rmefin', `You: ${me.name}, ${me.n}/${n} passed${me.rank ? `, ${ordinal(me.rank)} place` : ''}.`));
      else if (!over && (me || isPro())) box.append(youBox(v, n, true));
      if (v.next) {                                   // the next contest (the board's NEXT_CONTEST): only when it is set
        const nx = el('div', 'rnext');
        nx.append(el('span', 'rk', 'Next contest'), el('p', '', v.next));
        box.append(nx);
      }
      box.append(el('div', 'rk', over ? 'Final standings' : 'Standings'));
      raceBoard(v, n, Infinity);
      const share = el('button', 'btn ghostbtn', 'Share the results'), txt = el('p', 'rsharetxt');
      share.type = 'button';
      txt.textContent = `${RACE_NAME} results: ${champ ? `${champ.name} is the Gauntlet Champion, all ${n} historic drives passed.` : 'the final standings.'} ${location.origin}${location.pathname}#gauntlet-results`;
      txt.hidden = true;
      share.addEventListener('click', () => { txt.hidden = false; shareText(txt.textContent, txt, 'gauntlet'); });
      box.append(share, txt, raceRules(n));
    };
    let shown = false, chipEl = null;                     // the panel is built before it is on the page: the first fetch goes anyway
    // someone typing a name: the panel is not redrawn under them (a redraw rebuilds the form and loses what was typed)
    const typing = () => { const i = box.querySelector('.rjoin input'); return !!i && (document.activeElement === i || i.value.trim() !== ''); };
    const tick = async () => {
      if (box.isConnected) shown = true;
      else if (shown) { clearInterval(RACE.timer); return; }
      if (shown && (document.visibilityState !== 'visible' || $('arch').hidden)) return;
      try { const d = await raceFetch(); if (d.rows) { RACE.view = d; raceSkew(d); if (!typing()) draw(); } } catch (e) { /* the next tick */ }
    };
    RACE.refresh = () => { if (!shown || box.isConnected) tick(); };      // Pro confirmed after the panel was drawn: ask again at once
    draw();
    clearInterval(RACE.timer);
    // the countdown: only the chip's text each second; the whole panel once, when it goes live
    RACE.timer = setInterval(() => {
      const v = RACE.view;
      if (!v || v.winner || raceOver(v)) return;
      const left = Date.parse(v.from) - raceNow();
      if (left > 0) { if (chipEl) chipEl.textContent = `Starts in ${hms(left)}`; } else if (left > -1500 && !typing()) draw();
    }, 1000);
    const poll = setInterval(() => { if (shown && !box.isConnected) clearInterval(poll); else tick(); }, RACE_POLL);
    tick();
    return box;
  }
  // a new try of a historic drive: the board's token for it (only an entrant gets one, and only once the Gauntlet has
  // started), so only a try started in the Gauntlet can count; a reloaded try keeps its own
  async function raceStart() {
    if (!PRO_ON || !BOARD.api || !proHave()) return;
    const d = await raceRetry('/race/start', () => ({ ...proCred(), drive: DRIVE }));
    if (d && d.ok && d.tok && state && !state.done) { state.raceTok = d.tok; saveState(); }
  }
  // a call to the board that must get through (a try's token, a pass): a busy board (429 slow down, 5xx) or no
  // connection is tried again, waiting longer each time (about 2 minutes in all); any other answer is final
  async function raceRetry(path, body, waits = [2, 4, 8, 15, 30, 60]) {
    for (let i = 0; ; i++) {
      let d = null;
      try { d = await raceCall(path, body()); } catch (e) { d = null; }
      const busy = !d || d.status >= 500 || (d.status === 429 && !/one drive at a time|too fast/.test(d.error || ''));
      if (!busy || i >= waits.length) return d;
      await sleep(waits[i] * 1000 * (0.75 + 0.5 * Math.random()));
    }
  }
  // a passed historic drive, for the Gauntlet (once you have entered): its calls go with it, for the check
  async function racePass(p, decs, note) {
    if (!BOARD.api || p * 100 < PASS_AT - 0.5) return;
    // Pro not confirmed yet (offline at load): keep the pass for the next time this drive opens
    if (!isPro()) { if (PRO_LIVE === null && state.raceTok) { state.raceSent = false; saveState(); } return; }
    const calls = decs.map((x) => ({ k: x.kind, f: x.family, c: x.chosen, s: x.snap, w: x.wps.map((o) => [o.key, Math.round(o.wp * 1e4) / 1e4]) }));
    state.raceSent = false; saveState();
    try {
      note.textContent = `${RACE_NAME}: sending your pass…`; note.hidden = false;
      const d = await raceRetry('/race/pass', () => ({ ...proCred(), drive: DRIVE, p: clip(p, 0, 1), decs: calls, tryAt: state.tryAt || null, tok: state.raceTok || null,
        res: state.spots.map((x) => (x && x.result ? [x.result.mine, x.result.theirs] : null)) }), [2, 4, 8, 15, 30, 35, 60]);
      if (!d) throw new Error('no connection');
      state.raceSent = true; saveState();
      if (d.rows) RACE.view = d;
      const n = d.n || 24;
      if (d.ok && d.me) {
        note.textContent = `${RACE_NAME}: ${d.me.n}/${n} passed${d.me.rank ? ` · ${ordinal(d.me.rank)} place` : ''}${d.me.done ? ' · all of them!' : ''}`;
        note.hidden = false;
        if (d.me.done) track('race_done');
      } else if (d.status === 403 && /enter/.test(d.error || '')) {
        note.textContent = '';
        const a = el('a', '', `Enter ${RACE_NAME}`);
        a.href = '#archive';
        note.append(`This pass would count in the race. `, a, ' (then pass it again).');
        note.hidden = false;
      } else if (d.error) { note.textContent = `${RACE_NAME}: ${d.error}`; note.hidden = false; }
    } catch (e) { note.textContent = `${RACE_NAME}: no connection, so this pass hasn't reached the board yet. Reopen this drive when you're back online and it is sent again.`; note.hidden = false; }
  }
  // on the Daily and Survivor tabs, once it is on: a bar to the race
  function raceBar() {
    if (!PRO_ON || !BOARD.api || ARCH || ARCH_DAY || DRIVE || RUN_N || VS || GAUNTLET || document.querySelector('.racebar')) return;
    const a = el('a', 'racebar');
    a.href = '#archive';
    a.append(el('b', '', `🏁 ${RACE_NAME}`), el('span', '', 'First to pass all 24 historic drives wins. Leaderboard →'));
    a.addEventListener('click', () => track('race_bar'));
    $('modeArch').closest('nav').after(a);
  }
  // your Pro code, where you can't miss it: the code, Copy, and how to use it on your other devices
  function proCodeCard(fresh) {
    const box = el('div', 'procode'), code = proShownCode();
    const row = el('div', 'pcrow'), c = el('code', 'pcc', code), copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; track('pro_code_copy'); }
      catch (e) { const r = document.createRange(); r.selectNodeContents(c); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); copy.textContent = 'Selected: copy it'; }
    });
    row.append(c, copy);
    box.append(el('div', 'k', fresh ? 'Pro unlocked: save your code' : 'Your Pro code'), row,
      el('p', 'note', acctPro() ? 'Pro is on your account: sign in on any device and it is there. The code also works on its own, on up to 3 devices.' : 'On your phone, computer or another browser: open the Pro tab, tap "Already have Pro?", paste this code and tap Restore. It works on up to 3 devices. Screenshot it or save it somewhere: it is not in the Stripe receipt.'));
    return box;
  }
  function proNodes() {
    const box = el('div', 'pro'), days = Math.max(0, dayOf(new Date()) - 1);
    box.append(el('div', 'k', 'Two-Minute Drill Pro'), el('div', 'price', '$4.99 · once'));
    const ul = el('ul');
    [`The archive: every past daily${days ? ` (${days} so far)` : ''}, any day you missed, with its score and stats`,
      'The historic drives. Mahomes’ 13 seconds, the Minneapolis Miracle, the Philly Special, 28–3 and more, each from its real spot',
      'The playoff runs. A team’s whole postseason, every late-game spot in order. Win them all'].forEach((t) => ul.append(el('li', '', t)));
    box.append(ul);
    if (isPro()) {
      box.append(el('p', '', acctPro() ? `Pro is on your account (${ACCT.me.email}): sign in on any device to play it there.` : `Pro is on. Your code: ${proCode()}. Keep it: it unlocks Pro on up to 3 of your devices.`));
      return [box];
    }
    const row = el('div', 'row'), buy = el('button', 'btn', 'Unlock · $4.99');
    buy.type = 'button';
    buy.addEventListener('click', () => startPurchase(buy));
    row.append(buy);
    box.append(row, el('p', 'note', acctPro() || !authSession() ? 'Apple Pay, Google Pay or a card, on Stripe’s secure page. One code, up to 3 of your devices.'
      : `Apple Pay, Google Pay or a card, on Stripe’s secure page. Signed in as ${(ACCT.me && ACCT.me.email) || 'you'}: Pro goes on your account, for any device you sign in on.`));
    const rs = el('div', 'row'), inp = el('input'), go = el('button', 'btn', 'Restore');
    inp.placeholder = 'TMD-XXXX-XXXX-XXXX'; inp.setAttribute('aria-label', 'Your Pro code'); inp.autocapitalize = 'characters'; inp.spellcheck = false;
    go.type = 'button';
    go.addEventListener('click', async () => {
      try {
        const d = await proApi('/restore', { code: inp.value, key: deviceKey() });
        save(PRO_KEY, { code: d.code, at: Date.now() });
        PRO_LIVE = true;
        track('pro_restored');
        toast('Pro restored');
        if (location.hash === '#archive') location.reload(); else location.hash = '#archive';
      } catch (e) { toast(e.message); }
    });
    rs.append(inp, go);
    box.append(el('p', 'note', 'Already have Pro? Enter your code.'), rs);
    if (!BOARD.api) { buy.disabled = true; go.disabled = true; }
    return [box];
  }
  // The Pro data (nflclock.pro: drives.json, d{k}.json, runs.json, r{k}.json) is not on the site: the board serves
  // each file to a valid Pro code (POST /pro/data). null where the board has none or refuses the code.
  async function proFile(name) {
    if (!BOARD.api || !proHave()) return null;
    let r;
    try { r = await fetch(`${BOARD.api}/pro/data`, POST_JSON({ ...proCred(), name })); } catch (e) { return null; }
    if (r.status === 401 && proCred().session) { authLost(); return proCode() ? proFile(name) : null; }      // signed out: the device's code, if any
    if (proCred().session) return r.ok ? r.json().catch(() => null) : null;
    if (r.status === 403 || r.status === 409) { const d = await r.json().catch(() => ({})); proOff(r.status === 409 ? d.error || 'This code is in use on too many devices' : 'That Pro code is not valid any more'); return null; }
    if (!r.ok) return null;
    return r.json().catch(() => null);
  }
  async function loadPro() {
    if (!PRO) PRO = await proFile('drives.json');
    return PRO;
  }
  async function loadProTeams(i) {
    const per = PRO.spot_chunk || 20, c = await proFile(`d${Math.floor(i / per)}.json`);
    if (!c) throw new Error('the drive data could not be loaded');
    return c;
  }
  async function loadRuns() {
    if (!PRO_RUNS) PRO_RUNS = await proFile('runs.json');
    return PRO_RUNS;
  }
  // the teams of spots kept in chunked files (prefix + chunk index), by spot index
  async function loadChunks(prefix, per, ids) {
    const teams = {};
    await Promise.all([...new Set(ids.map((i) => Math.floor(i / (per || 20))))].map((k) => proFile(`${prefix}${k}.json`)
      .then((c) => { if (!c) throw new Error('the run data could not be loaded'); Object.assign(teams, c); })));
    return teams;
  }
  // a drive from a game just played: "TONIGHT", "LAST NIGHT", then the weekday for the rest of the week; nothing after
  function freshTag(real) {
    if (!real || !real.live || !real.date) return '';
    const day = new Date(real.date + 'T12:00:00'), now = new Date();
    const ago = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12) - day) / 864e5);
    if (ago < 0 || ago > 6) return '';
    if (ago === 0) return 'TONIGHT';
    if (ago === 1) return 'LAST NIGHT';
    return `${day.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()} NIGHT`;
  }
  // #gauntlet: the contest's panel alone (the link the results share), then the way to the drives
  function renderGauntlet() {
    track('gauntlet_open', { pro: isPro() });
    show('arch');
    const box = $('arch');
    box.textContent = '';
    if (!BOARD.api) { box.append(el('p', 'note', 'The Gauntlet is on nfl2mindrill.com.')); return; }
    const a = el('a', 'btn ghostbtn gtodrives', isPro() ? 'Play the historic drives' : 'Pro: the historic drives');
    a.href = '#archive';
    box.append(racePanel(), a);
  }
  // the Pro screen: the historic drives and every past day, newest first, with your score where you played; the
  // pitch when Pro is not on
  async function renderArchive(now) {
    track('archive_open', { pro: isPro() });
    show('arch');
    const box = $('arch'), todayN = dayOf(now);
    box.textContent = '';
    box.append(el('h2', '', 'Pro'));
    if (BOARD.api) box.append(racePanel());
    if (!isPro()) {
      box.append(el('p', 'lead', `Every daily since launch${todayN > 1 ? `, ${todayN - 1} so far` : ''}, the historic drives and the playoff runs: play any of them, graded like the day it ran.`));
      if (PRO_LIVE === null && (proCode() || authSession())) {     // a code (or a session) is kept here but the board could not confirm it
        const again = el('button', 'btn', 'Try again');
        again.type = 'button'; again.addEventListener('click', () => location.reload());
        box.append(el('p', '', 'Your Pro code could not be checked (no connection to the board). Try again in a moment.'), again);
      } else box.append(...proNodes(), authNodes());
      return;
    }
    box.append(proCodeCard(false));
    box.append(authNodes());        // Pro by code: keep it on an account; signed in: who, and Sign out
    gauntletFresh();
    const pro = await loadPro(), ds = load(`${STORE}:drives`, {});
    if (pro && pro.drives.length) {
      // your record across them: passed (an A), the rank it earns, the next rank, every drive's best grade
      const n = pro.drives.length, rec = (k) => ds[k + 1], scoreOf = (k) => Math.round(rec(k).p * 100);
      const passed = pro.drives.filter((_, k) => rec(k) && scoreOf(k) >= PASS_AT).length, played = pro.drives.filter((_, k) => rec(k)).length;
      const rk = proRank(passed, n);
      const head = el('div', 'prohead');
      const ttl = el('div', 'phl');
      ttl.append(el('span', 'k', 'Your rank'), el('b', '', rk.title), el('span', 'sub', rk.next ? `${rk.next.at - passed} more ${rk.next.at - passed === 1 ? 'pass' : 'passes'} to ${rk.next.title}` : 'Every drive passed. The Hall of Fame.'));
      const num = el('div', 'phn');
      num.append(el('b', '', `${passed}/${n}`), el('span', 'k', 'passed'));
      head.append(ttl, num, driveStrip(ds), el('p', 'note', `Pass a drive with an A: ${PASS_AT} or better, better than ${PASS_AT}% of NFL play\u2011callers, counting the calls and the result, and you have to win the game. Replay any drive as often as you like; your best grade counts.${played ? ` Played ${played} of ${n}.` : ''}`));
      box.append(head, el('h3', '', 'Historic drives'));
      const dl = el('div', 'days');
      pro.drives.forEach((d, k) => {
        const sp = pro.spots[d.spot], opp = sp.player === sp.home ? sp.away : sp.home, a = el('a', 'day drive');
        a.href = `#drive-${k + 1}`;
        const fresh = freshTag(sp.real);
        if (fresh) a.classList.add('fresh');
        if (rec(k) && scoreOf(k) >= PASS_AT) a.classList.add('passed');
        const tb = el('b', '', fresh ? null : d.title);
        if (fresh) tb.append(el('span', 'freshtag', fresh), d.title);
        const right = rec(k) ? el('span', 'gr') : el('span', 'sc', 'Play');
        if (rec(k)) right.append(gradeBadge(scoreOf(k)), el('small', '', String(scoreOf(k))));
        a.append(tb, el('span', 'd', String(sp.real.season)), el('span', 'm', `${teamName(sp.player)} vs ${teamName(opp)}`), right);
        dl.append(a);
      });
      box.append(dl);
    } else box.append(el('h3', '', 'Historic drives'), el('p', 'note', 'The historic drives land here with the next build.'));
    box.append(el('h3', '', 'Playoff runs'));
    const runs = await loadRuns(), rs = load(`${STORE}:runs`, {});
    if (runs && runs.runs.length) {
      const rl = el('div', 'days');
      runs.runs.forEach((r, k) => {
        const a = el('a', 'day drive'), rec = rs[k + 1];
        a.href = `#run-${k + 1}`;
        a.append(el('b', '', r.title), el('span', 'd', `${r.games.length} games`), el('span', 'm', r.games.map((g) => g.round.replace('Conference Championship', 'Conf.').replace('Divisional', 'Div.').replace('Wild Card', 'WC').replace('Super Bowl', 'SB')).join(' · ')),
          el('span', `sc${rec && rec.w === rec.n ? ' champ' : ''}`, rec ? `${rec.w === rec.n ? '🏆 ' : ''}${rec.w}-${rec.l}` : 'Play'));
        rl.append(a);
      });
      box.append(rl, el('p', 'note', 'Every game of the run in order, each from the spot the team was least likely to win it from. Win them all.'));
    } else box.append(el('p', 'note', 'The playoff runs land here with the next build.'));
    box.append(el('h3', '', 'Past dailies'));
    if (todayN <= 1) { box.append(el('p', '', 'The archive fills from tomorrow: today’s drive is on the Daily tab.')); return; }
    const st = load(`${STORE}:stats`, { days: {} }), list = el('div', 'days');
    for (let n = todayN - 1; n >= 1; n--) {
      const sp = idx.spots[dayIds(n)[0]], feat = idx.featured && idx.featured[n], opp = sp.player === sp.home ? sp.away : sp.home;
      const a = el('a', 'day');
      a.href = `#day-${n}`;
      a.append(el('b', '', `No. ${n}`), el('span', 'd', dayDate(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
        el('span', 'm', `${teamName(sp.player)} vs ${teamName(opp)}${feat ? ' · featured' : ''}`),
        st.days[n] ? (() => { const g = el('span', 'gr'); g.append(gradeBadge(Math.round(st.days[n].p * 100)), el('small', '', String(Math.round(st.days[n].p * 100)))); return g; })() : el('span', 'sc', 'Play'));
      list.append(a);
    }
    box.append(list, el('p', 'note', acctPro() ? `Pro is on your account · ${ACCT.me.email}` : `Pro is on this device · code ${proCode()}`));
  }

  // -------------------------------------------------------------- versus ---
  // Two players, college overtime (web/vs_core.js: the toss choice, the ball at the 25, a touchdown going for two from
  // the 2nd overtime, two-point plays from the 3rd). Each brings a team; the team with the ball calls the offense, the
  // other the defense, each on their own phone. The room (board/match.js) plays the football: this phone sends its
  // half of each decision, sealed until every half is in; the room plays the snap with the engine and sends the
  // result to both phones, which animate it. The room keeps the play clock and the score, calls forfeits and rates
  // ranked matches; a phone only ever sends a call. Modes: ranked (the ladder: matched by rating), casual, a friend.
  const VS_TEAM_KEY = `${STORE}:vsteam`;
  const VS_MODES = { ranked: 'Ranked', casual: 'Casual', friend: 'Friend match' };
  const VS_FORFEIT = 60;             // seconds a phone can be gone before its side forfeits (match.js FORFEIT_MS)
  const vs = { ws: null, seat: -1, mode: 'friend', teams: [null, null], taken: '', names: ['', ''], full: false, online: [false, false], off: [0, 0],
    phase: 'wait', n: 0, ms: null, ms0: null, got: {}, waiting: -1, last: null, deadline: 0, skew: 0, result: null, rated: null, started: false,
    timer: null, retry: 0, closedByUs: false, pool: null, banner: '', oppLocked: -1, ui: 'none', cardTimer: null, q: null };
  const vsNow = () => Date.now() + vs.skew;                       // the room's clock
  const vsLink = (room) => `${location.origin}${location.pathname}#vs-${room}`;
  const vsMyTeam = () => { const t = load(VS_TEAM_KEY, ''); return TEAMS[t] ? t : ''; };
  async function vsLoadPool() {
    if (!vs.pool) vs.pool = await fetch(asset('teams.json')).then((r) => { if (!r.ok) throw new Error('teams ' + r.status); return r.json(); });
    return vs.pool;
  }
  // where this phone was in the match (its saved decisions), to catch up from on connecting
  function vsSince() { const st = load(stateKey(), null); const s = st && st.spots && st.spots[0]; return s && s.vsN ? s.vsN : 0; }

  function vsSend(m) { try { if (vs.ws && vs.ws.readyState === 1) { vs.ws.send(JSON.stringify(m)); return true; } } catch (e) { /* reconnects */ } return false; }
  function vsConnect() {
    let mode = 'friend';
    try { mode = sessionStorage.getItem(`tmd:vsmode:${VS_ROOM}`) || 'friend'; } catch (e) { /* none */ }
    const since = vs.started && G ? G.vsN : vsSince();
    const url = `${BOARD.api.replace(/^http/, 'ws')}/vs/ws?room=${VS_ROOM}&key=${encodeURIComponent(deviceKey())}&mode=${mode}&since=${since}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return vsRetry(); }
    vs.ws = ws;
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } vsOn(m); };
    ws.onclose = (ev) => {
      if (vs.ws !== ws || vs.closedByUs) return;
      if (ev.code === 4000) { vsNote('This match is open on another tab or device.'); return; }
      if (ev.code === 4001) { vsNote('This match has expired.'); return; }
      vsRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  function vsRetry() {
    vs.retry += 1;
    if (vs.retry > 14) { vsBanner(`Lost the connection. Reload to get back in: after ${VS_FORFEIT} seconds away the match is a forfeit.`); return; }
    vsBanner('Reconnecting…');
    setTimeout(() => { if (!vs.ws || vs.ws.readyState > 1) vsConnect(); }, Math.min(4000, 400 * 2 ** vs.retry));
  }
  // back to the app, or back online: reconnect now, not on the next retry
  const vsKick = () => { if (VS && BOARD.api && vs.ws && vs.ws.readyState > 1 && !vs.closedByUs) { vs.retry = 0; vsConnect(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) vsKick(); });
  addEventListener('online', vsKick);
  setInterval(() => vsSend({ t: 'ping' }), 25000);
  function vsSendTeam() {
    const t = vsMyTeam();
    if (t && vs.seat >= 0 && vs.phase === 'wait' && !vs.teams[vs.seat] && !vs.taken) vsSend({ t: 'team', team: t, name: myName() });
  }
  function vsOn(m) {
    if (typeof m.now === 'number') vs.skew = m.now - Date.now();
    if (m.t === 'hello') {
      vs.retry = 0;
      Object.assign(vs, { seat: m.seat, mode: m.mode || vs.mode, teams: m.teams, names: m.names, full: !!m.full, online: m.online, off: m.off || [0, 0],
        phase: m.phase, n: m.n, ms: m.ms, ms0: m.ms0 || vs.ms0, deadline: m.deadline || 0, dl: m.dl || null, result: m.result || null, rated: m.rated || vs.rated });
      (m.decisions || []).forEach((d) => { if (d) vs.got[d.n] = d; });
      if (vs.last && vs.last.n === m.n && m.phase === 'live') vsSend(vs.last);    // a call sent as the line dropped
      vsBanner('');
      vsSendTeam();
      vsPeer();
      if (vs.started) vsWake(); else vsMaybeStart();
    } else if (m.t === 'peer') {
      vs.online = m.online; vs.off = m.off || vs.off; vs.full = !!m.full;
      vsPeer();
      if (!vs.started) vsMaybeStart();
    } else if (m.t === 'teams') {
      vs.teams = m.teams; vs.names = m.names || vs.names;
      if (!vs.started) vsMaybeStart();
    } else if (m.t === 'taken') {
      vs.taken = m.team;
      renderVsWaiting();
    } else if (m.t === 'start') {
      Object.assign(vs, { phase: 'live', ms: m.ms, ms0: m.ms, n: 0, deadline: m.deadline, dl: m.dl || null });
      vsMaybeStart();
    } else if (m.t === 'clock') {                    // the room's word on your play clock for this call
      if (m.n === vs.n && vs.seat >= 0) { vs.dl = vsDls(); vs.dl[vs.seat] = m.deadline; vsDrawBar(); }
    } else if (m.t === 'locked') {
      if (m.n === vs.n && m.seat !== vs.seat) { vs.oppLocked = m.n; vsDrawBar(); }
      if (m.n === vs.n && m.seat === vs.seat && vs.waiting !== m.n) {          // back after a reload: your call is already in
        vs.waiting = m.n;
        if (vs.ui === 'prompt' && G && G.vsN === m.n) { clearInterval(vs.timer); vs.ui = 'idle'; status('Locked in. Waiting for your opponent…'); vsDrawBar(); }
      }
    } else if (m.t === 'step') {
      vs.got[m.n] = m;
      Object.assign(vs, { ms: m.ms, n: m.n + 1, deadline: m.deadline, dl: m.dl || null, oppLocked: -1 });
      if (m.result) { vs.result = m.result; vs.phase = 'over'; }
      vsWake();
    } else if (m.t === 'over') {
      vs.result = m.result; vs.phase = 'over';
      if (vs.started) vsWake(); else vsMaybeStart();
    } else if (m.t === 'rated') {
      vs.rated = m.rated;
      if (!vs.started && vs.phase === 'over') vsCalledOff(); else vsShowRating();
    } else if (m.t === 'rematch-ask') {
      const btn = $('vsAgain');
      if (btn && m.seat !== vs.seat) { btn.textContent = 'Your opponent wants a rematch: play again'; btn.classList.add('ask'); }
    } else if (m.t === 'rematch') {
      vs.closedByUs = true;
      try { sessionStorage.setItem(`tmd:vsmode:${m.room}`, vs.mode === 'friend' ? 'friend' : 'casual'); } catch (e) { /* none */ }
      location.hash = `#vs-${m.room}`;
    }
  }
  // the opponent's connection: gone, and how long until it is a forfeit
  function vsPeer() {
    clearInterval(vs.peerTimer);
    const o = 1 - vs.seat, gone = vs.seat >= 0 && vs.phase === 'live' && !vs.online[o] && vs.off[o];
    if (!gone) { if (vs.banner.startsWith('Your opponent')) vsBanner(''); return; }
    const tick = () => {
      const left = Math.max(0, Math.ceil((vs.off[o] + VS_FORFEIT * 1000 - vsNow()) / 1000));
      vsBanner(`Your opponent lost the connection: if they're not back in ${left} s, you win by forfeit.`);
      if (!left || vs.phase !== 'live') clearInterval(vs.peerTimer);
    };
    tick();
    vs.peerTimer = setInterval(tick, 1000);
  }
  async function vsMaybeStart() {
    if (vs.started || vs.seat < 0) return;
    if (vs.phase === 'over' && !vs.ms) return vsCalledOff();
    if ((!vs.teams[vs.seat] && (!vsMyTeam() || vs.taken)) || !vs.ms || !vs.teams[0] || !vs.teams[1]) return renderVsWaiting();
    vs.started = true;
    let pool;
    try { pool = await vsLoadPool(); } catch (e) { vsNote('The teams did not load (' + e.message + '). Reload to try again.'); return; }
    const H = vs.teams[0], A = vs.teams[1], TH = pool.teams[H], TA = pool.teams[A];
    if (!TH || !TA) { vsNote('A team in this match is not in this version of the game. Reload the page.'); return; }
    const sp = { id: `vs:${VS_ROOM}`, category: 'ot', home: H, away: A, player: vs.seat === 0 ? H : A, indoor: false, wind: 0, spread: 0,
      league: pool.league, start: { qtr: 4, clock: VSCore.COT_T, score: [0, 0], pos: H, down: 1, ytg: 10, yl: 25, to: [1, 1], running: false, receive2h: H },
      real: { season: pool.season, week: pool.week, type: 'REG', coach: null, call: null, drive: null, final: null } };
    today = [buildScen(sp, { home: TH, away: TA })];
    $('dayLabel').textContent = `${VS_MODES[vs.mode] || 'Versus'} · ${VS_ROOM}`;
    state = load(stateKey(), null) || { spots: [], current: 0, done: false };
    startWorkers();
    track('vs_start', { mode: vs.mode, seat: vs.seat });
    resumeSpot(0);
    // this phone against the room: catch up decision by decision from where it was, or (too far behind) jump to now
    const have = (i) => !!vs.got[i];
    if (G.vsN === 0 && vs.ms0) { G.root = vs.ms0.root; G.cot = vs.ms0.cot; G.seq = 0; }
    let ok = true;
    for (let i = G.vsN; i < vs.n; i++) if (!have(i)) ok = false;
    if (!ok) vsJump();
    lastBall = null;
    if (G.started || G.over || vs.n > 0 || vs.phase === 'over') enterField(); else renderIntro();
  }
  function vsJump() {
    G.root = vs.ms.root; G.cot = vs.ms.cot; G.seq = vs.ms.seq; G.vsN = vs.n;
    G.started = true;
    persist();
  }
  // a matched opponent who never came (or never picked a team): nothing happened, nobody's rating moved
  function vsCalledOff() {
    show('arch');
    const box = $('arch');
    box.textContent = '';
    const r = vs.result || {}, them = (r.missing || []).includes(1 - vs.seat) || (r.by === 'forfeit' && r.winner === vs.seat);
    if (r.by === 'forfeit') {       // ranked: one side never came, a loss for it
      box.append(el('h2', '', r.winner === vs.seat ? 'You win: they didn’t show' : 'You forfeited'),
        el('p', 'lead', r.winner === vs.seat ? 'Your opponent never joined the match. It counts as a win.' : 'You were matched but didn’t join in time. In ranked that counts as a loss.'));
      const p = el('p', 'vsrating', '');
      const x = vs.rated && vs.rated.ratings && vs.rated.ratings[vs.seat];
      if (x) p.textContent = `Rating ${x.before} → ${x.after} (${x.delta >= 0 ? '+' : '−'}${Math.abs(x.delta)})${x.rank ? ` · #${x.rank}` : ''}`;
      box.append(p);
    } else box.append(el('h2', '', 'Match called off'), el('p', 'lead', them ? 'Your opponent didn’t show up. Nobody’s rating changed.' : 'The match didn’t start in time. Nobody’s rating changed.'));
    const row = el('div', 'row');
    if (vs.mode === 'ranked' || vs.mode === 'casual') {
      const again = el('button', 'btn', vs.mode === 'ranked' ? 'Find another ranked match' : 'Find another match');
      again.type = 'button';
      again.addEventListener('click', () => { location.hash = '#vs'; try { sessionStorage.setItem('tmd:vsqueue', vs.mode); } catch (e) { /* none */ } });
      row.append(again);
    }
    const back = el('a', 'btn ghostbtn', 'Back to Versus');
    back.href = '#vs';
    row.append(back);
    box.append(row);
  }
  function renderVsIntro() {
    const box = $('intro'), me = code(G.me), op = code(1 - G.me), first = G.cot ? G.cot.toss : 0;
    const oppName = vs.names[1 - vs.seat];
    box.append(el('div', 'cat', `${VS_MODES[vs.mode] || 'Versus'} · College overtime`),
      el('div', 'game', `Your ${teamName(me)} vs ${oppName ? `${oppName}’s` : 'their'} ${teamName(op)}`), el('div', 'big', 'Overtime'));
    box.append(el('p', 'story', `Each team gets the ball at the other’s 25, no clock. From the second overtime, a touchdown has to go for two; from the third, it’s a two-point play each. Ahead after both teams have had it, you win. ${first === G.me ? 'You won the toss: you choose offense, defense or the end of the field.' : `The ${teamName(op)} won the toss and choose first.`} The choice alternates every overtime.`));
    box.append(el('div', 'who', 'You call your side: the offense when you have it, the defense when they do. Both calls lock in before the snap. You get 30 seconds a call; miss two in a row and you forfeit.'));
    const go = el('button', 'btn', 'Kick it off');
    go.type = 'button';
    go.addEventListener('click', () => { G.started = true; persist(); enterField(); });
    box.append(go, el('div', 'from legal', 'Fan-made. Not affiliated with or endorsed by the NFL or its teams.'));
    go.focus({ preventScroll: true });
  }
  // the team picker: your team for every versus match until you change it
  function vsTeamPicker(onPick, skip) {
    const wrap = el('div', 'vsteams'), cur = vsMyTeam();
    Object.keys(TEAMS).filter((c) => c !== skip && !COLLEGE.has(c)).sort((a, b) => teamName(a).localeCompare(teamName(b))).forEach((c) => {
      const b = el('button', `vsteam${c === cur ? ' on' : ''}`);
      b.type = 'button';
      const sw = el('span', 'sw'); sw.style.background = color(c);
      b.append(sw, el('span', 'nm', teamName(c)));
      b.setAttribute('aria-pressed', String(c === cur));
      b.addEventListener('click', () => { save(VS_TEAM_KEY, c); track('vs_team', { team: c }); onPick(c); });
      wrap.append(b);
    });
    requestAnimationFrame(() => { const on = wrap.querySelector('.on'); if (on) wrap.scrollTop = on.offsetTop - 4; });   // your team in view
    return wrap;
  }
  // before the kickoff: your team (if you came in on a link, or the other side has yours), the code to send a friend
  function renderVsWaiting() {
    if (vs.started) return;
    show('arch');
    const box = $('arch');
    box.textContent = '';
    box.append(el('h2', '', VS_MODES[vs.mode] || 'Versus'));
    if (vs.seat >= 0 && !vs.teams[vs.seat] && (!vsMyTeam() || vs.taken)) {
      const lead = vs.taken ? `Your opponent already has the ${teamName(vs.taken)}. Pick another team.` : 'Pick your team for this match: its real lineup this week.';
      box.append(el('p', 'lead', lead), vsTeamPicker(() => { vs.taken = ''; vsSendTeam(); renderVsWaiting(); }, vs.taken));
      return;
    }
    const mine = vs.teams[vs.seat] || vsMyTeam();
    if (mine) box.append(el('p', 'note', `Your team: ${teamName(mine)}`));
    if (vs.full || vs.mode !== 'friend') { box.append(el('p', 'lead', 'Opponent found. Getting the match ready…')); return; }
    box.append(el('p', 'lead', 'Send this to a friend. The match starts when they open it.'));
    box.append(el('div', 'vscode', VS_ROOM));
    const row = el('div', 'row'), copy = el('button', 'btn', 'Copy the link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(vsLink(VS_ROOM)); copy.textContent = 'Copied'; } catch (e) { copy.textContent = vsLink(VS_ROOM); }
    });
    row.append(copy);
    if (navigator.share) {
      const sh = el('button', 'btn ghostbtn', 'Share');
      sh.type = 'button';
      sh.addEventListener('click', () => { navigator.share({ title: 'Two-Minute Drill: versus', text: 'College overtime, you and me. Pick your team.', url: vsLink(VS_ROOM) }).catch(() => {}); });
      row.append(sh);
    }
    box.append(row, el('p', 'note', 'Keep this page open.'));
    const back = el('a', 'chip', '◀ Back');
    back.href = '#vs';
    box.append(back);
  }
  // matchmaking: in the lobby's queue until it finds you an opponent (ranked: someone near your rating)
  function vsQueue(mode) {
    show('arch');
    const box = $('arch');
    box.textContent = '';
    const t0 = Date.now(), line = el('p', 'lead', 'Finding you an opponent…'), info = el('p', 'note', '');
    const cancel = el('button', 'btn ghostbtn', 'Cancel');
    cancel.type = 'button';
    box.append(el('h2', '', VS_MODES[mode]), el('p', 'note', `Your team: ${teamName(vsMyTeam())}`), line, info, cancel);
    let ws, closed = false, tries = 0, size = 0, rating = 0;
    const done = () => { closed = true; clearInterval(tk); try { ws && ws.close(); } catch (e) { /* gone */ } };
    const draw = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      info.textContent = `${size > 1 ? `${size} players searching` : 'Searching'} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${mode === 'ranked' && rating ? ` · your rating ${rating}` : ''}`;
      if (mode === 'ranked' && s > 25) line.textContent = 'Widening the search…';
      if (s > 90) line.textContent = 'Not many players on right now. Keep waiting, or play a friend.';
    };
    const tk = setInterval(draw, 1000);
    cancel.addEventListener('click', () => { done(); track('vs_queue_cancel', { mode, secs: Math.round((Date.now() - t0) / 1000) }); renderVsLobby(); });
    const open = () => {
      if (closed) return;
      const q = new URLSearchParams({ key: deviceKey(), mode, team: vsMyTeam(), name: myName() });
      try { ws = new WebSocket(`${BOARD.api.replace(/^http/, 'ws')}/vs/queue?${q}`); } catch (e) { return setTimeout(open, 2000); }
      vs.q = ws;
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'queued') { size = m.size; rating = m.rating; tries = 0; draw(); }
        if (m.t === 'match') {
          done();
          try { sessionStorage.setItem(`tmd:vsmode:${m.room}`, m.mode); } catch (e) { /* none */ }
          track('vs_matched', { mode, secs: Math.round((Date.now() - t0) / 1000) });
          location.hash = `#vs-${m.room}`;
        }
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4000) { done(); line.textContent = 'You’re searching in another tab or on another device.'; return; }    // replaced: never fight it
        if (++tries < 10) setTimeout(open, Math.min(4000, 500 * tries)); else line.textContent = 'Lost the connection to matchmaking.';
      };
    };
    open();
    track('vs_queue', { mode });
  }
  // the Versus screen (#vs): your team, then ranked, casual or a friend; the ladder
  async function renderVsLobby() {
    show('arch');
    const box = $('arch');
    box.textContent = '';
    box.append(el('h2', '', 'Versus'), el('p', 'lead', 'College overtime against another player: each team gets the ball at the other’s 25, no clock. You call your offense and your defense; both calls lock in before the snap, and the same play runs on both phones.'));
    const pick = el('div', 'vspick');
    const drawPick = () => {
      pick.textContent = '';
      const t = vsMyTeam();
      pick.append(el('h3', '', t ? `Your team: ${teamName(t)}` : 'Pick your team'), vsTeamPicker(() => { drawPick(); }));
    };
    const modes = el('div', 'vsmodes');
    const go = (mode) => {
      if (!vsMyTeam()) { toast('Pick your team first'); return; }
      if (mode === 'ranked' && !myName()) { toast('Ranked needs a name: set it below'); nameIn.focus(); return; }
      if (mode === 'friend') {
        const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', room = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => a[b % a.length]).join('');
        try { sessionStorage.setItem(`tmd:vsmode:${room}`, 'friend'); } catch (e) { /* none */ }
        track('vs_friend');
        location.hash = `#vs-${room}`;
        return;
      }
      vsQueue(mode);
    };
    [['ranked', 'Ranked', 'Win to climb the ladder'], ['casual', 'Casual', 'Quick match, no rating'], ['friend', 'Friend', 'Send a link']].forEach(([m, label, sub]) => {
      const b = el('button', `btn${m === 'friend' ? ' ghostbtn' : ''}`);
      b.type = 'button';
      b.append(document.createTextNode(label), el('small', '', sub));
      b.disabled = !BOARD.api;
      b.addEventListener('click', () => go(m));
      modes.append(b);
    });
    drawPick();
    box.append(pick, modes);
    const nameRow = el('div', 'row'), nameIn = el('input');
    nameIn.placeholder = 'Your name (for ranked)'; nameIn.maxLength = 24; nameIn.value = myName(); nameIn.setAttribute('aria-label', 'Your name');
    nameIn.addEventListener('change', () => { save(NAME_KEY, nameIn.value.trim().slice(0, 24)); track('name_set', { mode: 'versus' }); });
    nameRow.append(nameIn);
    box.append(nameRow);
    const join = el('div', 'row'), inp = el('input'), jb = el('button', 'btn ghostbtn', 'Join');
    inp.placeholder = 'Friend’s code'; inp.maxLength = 6; inp.autocapitalize = 'characters'; inp.spellcheck = false; inp.setAttribute('aria-label', 'Match code');
    jb.type = 'button';
    jb.addEventListener('click', () => {
      const c = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/[1IL]/g, 'I');
      if (!/^[A-HJ-KM-NP-Z2-9]{6}$/.test(c)) { toast('A code is 6 letters and numbers'); return; }
      if (!vsMyTeam()) { toast('Pick your team first'); return; }
      location.hash = `#vs-${c}`;
    });
    join.append(inp, jb);
    box.append(join);
    if (!BOARD.api) { box.append(el('p', 'note', 'Versus needs the website’s backend.')); return; }
    // straight back into the queue (a no-show's "find another match")
    let again = null;
    try { again = sessionStorage.getItem('tmd:vsqueue'); sessionStorage.removeItem('tmd:vsqueue'); } catch (e) { /* none */ }
    if ((again === 'ranked' || again === 'casual') && vsMyTeam()) { vsQueue(again); return; }
    // the ladder, and you on it
    const lad = el('div', 'vsladder');
    box.append(el('h3', '', 'Ranked ladder'), lad);
    try {
      await BOARD.ready;
      const [top, me] = await Promise.all([fetch(`${BOARD.api}/vs/ladder`).then((r) => r.json()), fetch(`${BOARD.api}/vs/me`, POST_JSON({ key: deviceKey() })).then((r) => r.json())]);
      const streak = me.streak > 1 ? ` · ${me.streak} wins in a row` : me.streak < -1 ? ` · ${-me.streak} losses in a row` : '';
      lad.append(el('p', 'note', me.games ? `You: ${me.rating}${me.rank ? ` · #${me.rank}` : ''} · ${me.w}–${me.l}${streak}${me.provisional ? ` · placement (${me.games} of 10)` : ''}` : 'You: 1000 · no ranked games yet'));
      const ol = el('ol', 'board');
      (top.top || []).slice(0, 20).forEach((x) => { const li = el('li'); li.append(el('span', 'nm', x.name), el('span', 'n', `${x.rating}${x.provisional ? '?' : ''} · ${x.w}–${x.l}`)); ol.append(li); });
      if (!(top.top || []).length) lad.append(el('p', 'note', 'Nobody yet. Be the first.'));
      else lad.append(ol, el('p', 'note', '? : still in placement (the first 10 ranked games move a rating faster)'));
    } catch (e) { lad.append(el('p', 'note', 'The ladder did not load.')); }
  }
  function vsNote(text) {
    show('arch');
    const box = $('arch');
    box.textContent = '';
    const a = el('a', 'btn', 'Back to Versus');
    a.href = '#vs';
    box.append(el('h2', '', 'Versus'), el('p', 'lead', text), a);
  }
  // a line above the field: the play clock, the opponent's lock, a dropped connection
  function vsBanner(text) { vs.banner = text; vsDrawBar(); }
  function vsDrawBar() {
    let b = $('vsbar');
    if (!b) {
      b = el('div', 'vsbar');
      b.id = 'vsbar';
      const dock = $('dock');
      dock.parentNode.insertBefore(b, dock);
    }
    b.textContent = '';
    if (vs.banner) b.append(el('span', 'warn', vs.banner));
    if (vs.ui === 'prompt' && vsMyDl()) {
      const s = Math.max(0, Math.ceil((vsMyDl() - vsNow()) / 1000));
      b.append(el('span', `clk${s <= 10 ? ' low' : ''}`, `Play clock ${s}`));
    }
    if (G && vs.oppLocked === G.vsN && vs.n === G.vsN) b.append(el('span', 'lock', 'Opponent locked in'));
    b.hidden = !b.childNodes.length;
  }
  // your call's clock: 30 seconds from the moment the call is up (the room starts it on {t:'ready'} and says when it
  // runs out; until it answers, the same 30 seconds here), never past the decision's last moment. Out of time: the
  // room plays your default
  const vsDls = () => (vs.dl && vs.dl.length === 2 ? vs.dl.slice() : [vs.deadline, vs.deadline]);
  const vsMyDl = () => (vs.seat >= 0 ? vsDls()[vs.seat] : vs.deadline);
  function vsClockStart() {
    clearInterval(vs.timer);
    vs.ui = 'prompt';
    if (vs.n === G.vsN && vs.seat >= 0) {
      vs.dl = vsDls();
      vs.dl[vs.seat] = Math.min(vs.dl[vs.seat], vsNow() + VS_DECIDE_MS);
      vsSend({ t: 'ready', n: G.vsN });
    }
    vs.timer = setInterval(() => {
      if (vs.ui !== 'prompt') { clearInterval(vs.timer); return; }
      if (vsNow() >= vsMyDl()) {
        clearInterval(vs.timer);
        if (!busy && vs.waiting !== G.vsN) { vs.ui = 'idle'; status('Out of time: your default call is in'); }
      }
      vsDrawBar();
    }, 250);
    vsDrawBar();
  }
  // your half of the decision: once, sealed until the other side's is in
  function vsSubmit(half) {
    const n = G.vsN;
    if (vs.waiting === n || vs.n !== n || vs.phase !== 'live') return;
    clearInterval(vs.timer);
    vs.waiting = n;
    vs.last = { t: 'half', n, half };
    vsSend(vs.last);
    vs.ui = 'idle';
    status('Locked in. Waiting for your opponent…');
    vsDrawBar();
  }
  // the room sent something: play it now, unless a play is running or its result is up (Next play, or the clock)
  function vsWake() {
    if (!G || !vs.started || busy) return;
    if (vs.ui === 'prompt' || vs.ui === 'idle' || vs.ui === 'none') advance();
  }
  // a decision the room played: its play animated (unless catching up), the state the room says
  async function vsApply(d) {
    const before = G.root;
    G.vsN = d.n + 1;
    if (vs.waiting < G.vsN) vs.waiting = -1;
    let out = null;
    if (d.res) {
      await cutReplay();
      const res = d.res, side = G.side;
      narrate(res.log, res.action).forEach(([text, t, m]) => addLog(text, t, m));
      G.root = { ...res.root };
      if (res.done) G.root.phase = DONE;
      const pe = res.log.find((x) => x.ev === 'play');
      const look = pe && pe.look && pe.look.box && res.action && (res.action.dc || (before.pos !== G.me && res.action.def)) ? (pe.look.box >= 7 ? 2 : 0) + (pe.look.blitz ? 1 : 0) : null;
      G.lastPlay = { before, res, side, look };
      res.animated = await animatePlay(before, res, side, false, look);
      out = { res, d };
    } else if (d.kind === 'timeout') out = { res: { log: [], action: { to_off: true } }, head: 'Timeout', d };
    cotLog(d.notes);
    G.root = d.ms.root; G.cot = d.ms.cot; G.seq = d.ms.seq;
    persist();
    return out;
  }
  // how the defense's call showed up on the snap, from the real play behind it: on a pass, how many came, whether
  // they got there and how long the quarterback had (more rushers: more pressure, the ball out sooner); on a run, the
  // box it ran into. good: it went the way of the user's side (onDefense: the user called the defense)
  function defenseLine(e, onDefense) {
    if (!e || e.ev !== 'play' || !e.dc || !(e.row >= 0)) return null;
    const cover = vdefName('cover', e.dc.cover), sack = /sack/.test(e.evt || ''), scr = e.evt === 'scramble';
    if (e.kind === 1) {
      if (!e.rushers) return null;
      const got = sack || e.pressure || scr;
      const what = sack ? 'they got home' : scr ? 'pressure, the quarterback ran' : e.pressure
        ? `pressure, the ball out in ${e.ttt ? e.ttt.toFixed(1) : '?'} s` : `a clean pocket, ${e.ttt ? `${e.ttt.toFixed(1)} s to throw` : 'time to throw'}`;
      return { good: got === onDefense, text: `${e.rushers} rushing against ${cover}: ${what}.` };
    }
    const box = e.look && e.look.box;
    if (!box) return null;
    const stuffed = e.turnover || e.yards <= 0;
    return { good: stuffed === onDefense, text: `A run into ${box} in the box: ${stuffed ? 'stopped' : e.td ? 'in for the score' : `${e.yards} yards`}.` };
  }
  // what each side called, shown once the snap is in
  function vsCalls(d, root) {
    const off = d.halves[root.pos], def = d.halves[1 - root.pos];
    const a = off && off.action;
    const offTxt = !off ? 'no call in time (the default)' : off.timeout ? 'a timeout' : off.two ? 'going for two' : a && a.call ? (CALL[a.call] || {}).label || 'a play'
      : a && a.play ? specialLabel(a.play) : a && a.pat ? (a.pat === 'two' ? 'going for two' : 'the extra point') : 'a play';
    const defTxt = root.phase !== SNAP ? null : !def ? 'no call in time (the default)' : def.dc ? vdefText(def.dc) : 'a defense';
    const me = root.pos === G.me;
    return `${me ? 'You' : 'They'}: ${offTxt}${defTxt ? ` · ${me ? 'They' : 'You'}: ${defTxt}` : ''}`;
  }
  function vsShowResult(x, before) {
    drawAll();
    const d = $('dock');
    d.textContent = '';
    const res = x.res, main = res.log.find((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev));
    const lines = (main ? narrate([main], res.action) : narrate(res.log, res.action).reverse());
    const wrap = el('div', 'result'), top = el('div', 'res-top'), txt = el('div', 'res-play');
    txt.append(el('span', 'yd', x.head || headline(main, res.log)), document.createTextNode(lines.length ? lines[0][0] : ''));
    top.append(txt);
    wrap.append(top, el('div', 'vscalls', vsCalls(x.d, before)));
    const mu = main ? defenseLine(main, before.pos !== G.me) : null;
    if (mu) wrap.append(el('div', `mline ${mu.good ? 'won' : 'lost'}`, mu.text));
    const btn = el('button', 'btn', G.root.phase === DONE || vs.result ? 'Final' : 'Next play');
    btn.type = 'button';
    let went = false;
    const go = async () => { if (went) return; went = true; clearTimeout(vs.cardTimer); vs.ui = 'none'; await cutReplay(); if (!busy) advance(); else went = false; };
    btn.addEventListener('click', go);
    wrap.append(btn);
    d.append(wrap);
    vs.ui = 'card';
    // the play clock runs whether or not Next is tapped: the card gives way when the clock would start anyway (WATCH_MS after the snap)
    clearTimeout(vs.cardTimer);
    vs.cardTimer = setTimeout(go, vs.result ? 8000 : Math.max(4000, vs.deadline - VS_DECIDE_MS - vsNow()));     // the last play: then the final
  }
  // the next decision of the match: one the room already played, yours (a prompt, on the play clock) or theirs (wait)
  async function vsAdvance(r) {
    const d = vs.got[G.vsN];
    if (d) {
      const catchUp = !!vs.got[G.vsN + 1];
      G.fast = catchUp;
      busy = true;
      const before = G.root;
      let x;
      try { x = await vsApply(d); } catch (e) { busy = false; fatal('The match hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); return 'stop'; }
      busy = false;
      if (x && !catchUp) { vsShowResult(x, before); return 'stop'; }
      return 'again';
    }
    G.fast = false;
    if (G.vsN < vs.n) { vsJump(); return 'again'; }                  // decisions this phone never got: the room's state now
    if (vs.result || (vs.ms && vs.ms.over) || r.phase === DONE) { vs.ui = 'end'; await finishSpot(); return 'stop'; }
    const role = VSCore.role(vs.ms, vs.seat);
    if (!role) {
      vs.ui = 'idle';
      if (G.cot && G.cot.pick) vsWaitPick();
      else status(r.phase === PAT ? `The ${teamName(code(r.pos))} line up for the try…` : 'Waiting for your opponent…');
      vsDrawBar();
      return 'stop';
    }
    if (vs.waiting === G.vsN) { vs.ui = 'idle'; status('Locked in. Waiting for your opponent…'); vsDrawBar(); return 'stop'; }
    if (vsNow() >= vsMyDl()) { vs.ui = 'idle'; status('Out of time: your default call is in'); return 'stop'; }
    vsClockStart();
    if (role === 'pick') vsPromptPick();
    else if (role === 'offense') promptOffense();
    else if (role === 'defense') promptDefense();
    else promptChoice('pat');
    return 'stop';
  }
  // the overtime choice: offense, defense or the end of the field (the end: they pick offense or defense)
  function vsPromptPick() {
    const c = G.cot, d = $('dock');
    drawAll();
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    const why = c.pick.end ? 'They took the end of the field' : c.round === 1 ? 'You won the toss' : `${ordinal(c.round)} overtime: your choice`;
    head.append(el('h2', '', why), el('span', 'sub', c.pick.end ? 'Offense or defense?' : 'Offense, defense or the end of the field?'));
    d.append(head);
    const keys = el('div', 'keys'), opts = c.pick.end ? ['offense', 'defense'] : ['offense', 'defense', 'end'];
    const label = { offense: 'Offense', defense: 'Defense', end: 'End of the field' };
    const subs = { offense: 'You have the ball first', defense: 'They go first; you know what you need', end: 'Pick the end zone; they choose offense or defense' };
    keys.style.setProperty('--cols', opts.length);
    opts.forEach((o, i) => {
      const b = key(label[o], subs[o], 'big def', i);
      b.addEventListener('click', () => { if (busy) return; track('vs_pick', { pick: o, round: c.round }); vsSubmit({ pick: o }); });
      keys.append(b);
    });
    d.append(keys);
  }
  function vsWaitPick() {
    const c = G.cot, d = $('dock'), nm = teamName(code(c.pick.team));
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', c.pick.end ? 'You took the end of the field' : c.round === 1 ? `The ${nm} won the toss` : `${ordinal(c.round)} overtime`),
      el('span', 'sub', `The ${nm} choose ${c.pick.end ? 'offense or defense' : 'offense, defense or the end of the field'}…`));
    const st = el('div', 'status');
    st.append(el('span', 'spin'), el('span', '', 'Waiting for their choice'));
    d.append(head, st);
  }
  function vsEndCard() {
    clearInterval(vs.timer); clearTimeout(vs.cardTimer); clearInterval(vs.peerTimer);
    vs.ui = 'end';
    const res = vs.result || { by: 'score', winner: G.root.score[0] > G.root.score[1] ? 0 : 1 };
    const r = G.root, mine = r.score[G.me], theirs = r.score[1 - G.me], rounds = G.cot ? G.cot.round : 1, won = res.winner === vs.seat, d = $('dock');
    if (!G.result) {
      G.result = { mine, theirs, half: 2, v: 2, vs: true, by: res.by, won }; G.over = true; persist();
      track('vs_finish', { mode: vs.mode, result: res.winner < 0 ? 'none' : won ? 'win' : 'loss', by: res.by, rounds });
    }
    drawAll();
    d.textContent = '';
    vsBanner('');
    takeBanner(d);
    const card = el('div', 'endcard');
    const ot = rounds > 1 ? ` in ${ordinal(rounds)} overtime` : ' in overtime';
    const head = res.by === 'score' ? (won ? `You win ${mine}–${theirs}${ot}` : `You lose ${mine}–${theirs}${ot}`)
      : res.by === 'forfeit' ? (won ? 'You win: they forfeited' : 'You forfeited')
        : res.by === 'abandoned' ? 'No result: both sides left' : 'No result';
    card.append(el('h2', '', head));
    if (res.by === 'forfeit') card.append(el('p', 'note', won ? (res.why === 'afk' ? 'They let the play clock run out on two calls in a row.' : 'They left the match for more than a minute.')
      : (res.why === 'afk' ? 'The play clock ran out on two of your calls in a row.' : `You were away from the match for more than ${VS_FORFEIT} seconds.`)));
    if (res.by === 'error') card.append(el('p', 'note', 'Something went wrong in the match. Nobody’s rating changed.'));
    card.append(el('p', 'note', `Your ${teamName(code(G.me))} vs ${vs.names[1 - vs.seat] ? `${vs.names[1 - vs.seat]}’s` : 'their'} ${teamName(code(1 - G.me))} · ${VS_MODES[vs.mode] || 'Versus'}`));
    card.append(el('p', 'vsrating', ''));
    const row = el('div', 'row');
    if (vs.mode === 'ranked') {
      const q = el('button', 'btn', 'Play ranked again');
      q.type = 'button';
      q.addEventListener('click', () => { vs.closedByUs = true; try { sessionStorage.setItem('tmd:vsqueue', 'ranked'); } catch (e) { /* none */ } location.hash = '#vs'; });
      row.append(q);
    }
    if (res.by === 'score' || res.by === 'forfeit') {
      const again = el('button', `btn${vs.mode === 'ranked' ? ' ghostbtn' : ''}`, vs.mode === 'ranked' ? 'Rematch (casual)' : 'Rematch');
      again.type = 'button'; again.id = 'vsAgain';
      again.addEventListener('click', () => { again.disabled = true; again.textContent = 'Waiting for your opponent…'; vsSend({ t: 'rematch' }); });
      row.append(again);
    }
    const next = el('a', 'btn ghostbtn', 'New match');
    next.href = '#vs';
    row.append(next);
    card.append(row);
    d.append(card);
    drawTiles();
    vsShowRating();
  }
  function vsShowRating() {
    const p = document.querySelector('.endcard .vsrating');
    if (!p || vs.mode !== 'ranked') return;
    const res = vs.result || {};
    if (res.winner < 0) { p.textContent = 'Not rated.'; return; }
    if (!vs.rated) { p.textContent = 'Ranked: updating your rating…'; return; }
    if (!vs.rated.rated) { p.textContent = 'Not rated: you’ve played each other three times today.'; return; }
    const x = vs.rated.ratings[vs.seat];
    p.textContent = `Rating ${x.before} → ${x.after} (${x.delta >= 0 ? '+' : '−'}${Math.abs(x.delta)})${x.rank ? ` · #${x.rank}` : ''}${x.provisional ? ` · placement ${x.games} of 10` : ''}`;
  }

  // ----------------------------------------------------------------- boot ---
  // The Gauntlet's start: every player's historic-drive record starts over then, like the board (the grades from before
  // move to drives_before_gauntlet, kept, not shown), and a try begun before it is dropped (it could never count)
  const GAUNTLET_FROM = Date.parse('2026-10-16T20:00:00Z');
  function gauntletFresh() {
    if (Date.now() < GAUNTLET_FROM || load(`${STORE}:gauntlet_fresh`, false)) return;
    try {
      const ds = load(`${STORE}:drives`, {}), keep = {}, old = load(`${STORE}:drives_before_gauntlet`, {});
      for (const [k, r] of Object.entries(ds)) { if (r && r.at && r.at >= GAUNTLET_FROM && !(r.prev)) keep[k] = r; else old[k] = r; }
      save(`${STORE}:drives_before_gauntlet`, old);
      save(`${STORE}:drives`, keep);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(`${STORE}:drive:`)) continue;
        const st = load(k, null);
        if (!st || !st.tryAt || st.tryAt < GAUNTLET_FROM) localStorage.removeItem(k);
      }
    } catch (e) { /* storage off: nothing to start over */ }
    save(`${STORE}:gauntlet_fresh`, true);
  }
  async function boot() {
    gauntletFresh();
    const topH = () => document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
    topH(); addEventListener('resize', topH);
    $('helpBtn').addEventListener('click', openHelp);
    fieldTaps();
    boardInit();
    addEventListener('hashchange', () => location.reload());       // Daily <-> Survivor
    $(SURV ? 'modeSurv' : ARCH || ARCH_DAY || DRIVE || GAUNTLET ? 'modeArch' : 'modeDaily').setAttribute('aria-current', 'page');
    $('modeArch').hidden = !PRO_ON;
    raceBar();
    if (PRO_BUILT && !PRO_ON) {
      const at = () => { if (!PRO_ON && Date.now() >= PRO_AT) proLaunch(); };
      if (PRO_AT - Date.now() < 864e5) setTimeout(at, PRO_AT - Date.now() + 50);
      document.addEventListener('visibilitychange', at);      // (a background tab's timer runs late)
      setInterval(at, 15000);
    }
    $('modeVs').hidden = !VS_ON;
    if (VS || VS_LOBBY) { $('modeDaily').removeAttribute('aria-current'); $('modeVs').setAttribute('aria-current', 'page'); }
    $('statsBtn').addEventListener('click', openStats);
    $('bar').addEventListener('click', () => { if (G) spotInfo(); });
    $('deepBtn').addEventListener('click', () => { if (G) openDeep(); });
    $('persBtn').addEventListener('click', openPers);
    speedBtn();
    $('deepClose').addEventListener('click', closeDeep);
    $('mClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('modal').hidden) closeModal();
      else if (!$('deep').hidden) closeDeep();
    });
    let rz = null;
    // (not while a play runs: the redraw would wipe the animation; the next draw picks up the new size)
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (G && !$('play').hidden && !busy && !$('field').classList.contains('playing')) { lastBall = null; drawField(); } }, 150); });
    show('boot');
    try {
      idx = await fetch(asset('game.json')).then((r) => { if (!r.ok) throw new Error('game data ' + r.status); return r.json(); });
      idx.calls.forEach((c) => { CALL[c.id] = c; });
      const now = new Date();
      dayN = ARCH_DAY || dayOf(now);
      await authLoginFromUrl();
      await unsubFromUrl();
      await proClaimFromUrl();
      await proVerify();
      acctInit();
      if (VS_LOBBY) { renderVsLobby(); return; }
      if (VS) {
        await BOARD.ready;
        if (!BOARD.api) { vsNote('Versus needs the website’s backend.'); return; }
        renderVsWaiting();
        vsConnect();
        return;
      }
      if (GAUNTLET) { renderGauntlet(); return; }
      if (ARCH || (ARCH_DAY && (!isPro() || ARCH_DAY >= dayOf(now))) || ((DRIVE || RUN_N) && !isPro())) { await renderArchive(now); return; }
      if (SURV) {
        state = load(stateKey(), null) || newRun();
        if (!load(`${STORE}:seen`, false)) { openHelp(true); save(`${STORE}:seen`, true); }
        startWorkers();
        if (state.out) renderSurvSummary(); else await survOpen();
        return;
      }
      if (RUN_N) {
        PRO_RUNS = await loadRuns();
        const run = PRO_RUNS && PRO_RUNS.runs[RUN_N - 1];
        if (!run) { location.replace(location.pathname + '#archive'); return; }
        const teams = await loadChunks('r', PRO_RUNS.spot_chunk, run.games.map((g) => g.spot));
        today = run.games.map((g) => {
          const sc = buildScen(PRO_RUNS.spots[g.spot], teams[g.spot]);
          sc.story = `${g.round}, ${g.home ? 'vs' : 'at'} the ${teamName(g.opp)}. That day the ${teamName(run.team)} ${g.won ? 'won' : 'lost'} ${g.score}.`;
          return sc;
        });
        $('dayLabel').textContent = `Run · ${run.title}`;
      } else if (DRIVE) {
        PRO = await loadPro();
        const d = PRO && PRO.drives[DRIVE - 1];
        if (!d) { location.replace(location.pathname + '#archive'); return; }
        const teams = await loadProTeams(d.spot);
        today = [buildScen(PRO.spots[d.spot], teams[d.spot])];
        today[0].story = d.note;
        $('dayLabel').textContent = `Drive · ${d.title}`;
      } else {
        const ids = dayIds(dayN);
        const teams = await loadTeams(ids);
        today = ids.map((i) => buildScen(idx.spots[i], teams[i]));
        const stk = ARCH_DAY ? 0 : curStreak();
        $('dayLabel').textContent = `No. ${dayN} · ${dayDate(dayN).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${ARCH_DAY ? ' · archive' : ''}${stk >= 2 ? ` · \ud83d\udd25${stk}` : ''}`;
      }
    } catch (e) { $('boot').textContent = 'Today\'s spots did not load (' + e.message + '). Check your connection and reload.'; return; }
    // a try saved on a spot's data since corrected (the Miami Miracle began with the touchdown on the board until the fix
    // went out): thrown away, so it starts over from the right spot
    const stale = (st) => DRIVE && st && today[0] && SPOT_FIXED[today[0].id] && !(st.tryAt >= SPOT_FIXED[today[0].id]);
    if (stale(load(stateKey(), null))) { try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ } }
    const fresh = !load(stateKey(), null);
    state = load(stateKey(), null) || { spots: [], current: 0, done: false, tryAt: Date.now() };     // tryAt: this try (a drive's record)
    if (fresh && DRIVE) raceStart();      // a new try of a historic drive: the Gauntlet's token for it
    if (!load(`${STORE}:seen`, false)) { openHelp(true); save(`${STORE}:seen`, true); }
    drawTiles();
    startWorkers();
    if (state.done) renderSummary();
    else openSpot(Math.min(state.current || 0, today.length - 1));
  }
  boot();
})();
