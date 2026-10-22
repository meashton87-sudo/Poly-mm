/* Two-Minute Drill: the daily NFL play-calling game.
 *
 * One real spot a day (most a late-game drive from a recent NFL season, playoffs included), played by the two teams
 * of that game: the 22 who were on the field, rated as of that week. Each spot opens on a scenario card;
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
  const N_REFINE = 3000, REFINE_TOP = 4;   // the second round of grading (evaluateGraded)
  const NOISE_Z = 1;            // a cost inside this many standard errors of the simulation counts as nothing (decisionFrom)
  const COST_MIN = 0.005;       // and so does one under half a point of win chance, a green call's (markOf)
  const QUIET_Z = 3;            // and every cost on a decision where no option is this many standard errors off the best
  // each worker holds its own parsed copy of the engine and play data (about 11.5 MB of JSON): two on phones
  const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const POOL = Math.max(1, Math.min(TOUCH ? 2 : 3, (navigator.hardwareConcurrency || 2) - 1));
  const STORE = 'tmd:v3';
  // the website stamps each build (<meta name="build">, scripts/site.py) and each file the page loads with what is in it
  // (<meta name="stamps">; the spots share one, spots/): a phone never mixes two builds' files, and a deploy that leaves
  // a file as it was leaves its address too, so a phone keeps its copy (they are cached for good: site.py _headers)
  const BUILD = (document.querySelector('meta[name="build"]') || {}).content || '';
  const STAMPS = (() => { try { return JSON.parse((document.querySelector('meta[name="stamps"]') || {}).content || '{}'); } catch (e) { return {}; } })();
  const stampOf = (u) => STAMPS[u] || STAMPS[u.replace(/\/.*/, '/')] || '';         // (a folder's one: spots/)
  const asset = (u) => (stampOf(u) ? `${u}?v=${encodeURIComponent(stampOf(u))}` : u);
  // Analytics events (the website's Google tag, scripts/site.py --ga; nothing anywhere else): what players do, so the
  // next changes follow the data. Event names and fields are listed in the README.
  const track = (name, params) => { try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) { /* never in the way */ } };
  // an error the page didn't catch: counted (js_error: the message, where, the build) and, when it is one of the page's
  // own, said on screen with a Reload, not left as a field that never draws (a Pro buyer's iPhone, Oct 19: no way to
  // tell what broke). Once a message; a browser's "Script error." from elsewhere and ResizeObserver's noise are left be.
  const errSeen = new Set();
  function pageError(msg, file, line, col, stack) {
    msg = String(msg || '').slice(0, 200);
    if (!msg || /^Script error\.?$|ResizeObserver/.test(msg) || errSeen.has(msg)) return;
    errSeen.add(msg);
    const where = `${String(file || '').split('/').pop().split('?')[0]}:${line || 0}:${col || 0}`;
    track('js_error', { msg, where, stack: String(stack || '').slice(0, 300), build: (document.querySelector('meta[name="build"]') || {}).content || '' });
    // shown only for the game's own scripts (a browser's own add-ons throw on every page too: Brave's wallet,
    // window.ethereum, Oct 20, its bar over the Snap key); offline the page says so itself. Every one is counted above
    const own = /^[^?#]+\.js$/.test(String(file || '').split(/[?#]/)[0]) && String(file).startsWith(location.origin + '/');
    if (!own || /^(Load failed|Failed to fetch|NetworkError)/.test(msg)) return;
    if (document.getElementById('errBar')) return;
    // (at the top, with a close: never over the Snap key at the bottom)
    const bar = document.createElement('div'), p = document.createElement('p'), b = document.createElement('button'), x = document.createElement('button');
    bar.id = 'errBar'; bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));z-index:9999;background:#7a1f1f;color:#fff;border-radius:12px;padding:12px 14px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center';
    p.style.cssText = 'margin:0;flex:1;min-width:0;overflow-wrap:anywhere';
    p.textContent = `Something broke on this page (${msg} · ${where}). Reload to try again; a screenshot of this helps us fix it.`;
    b.type = 'button'; b.textContent = 'Reload';
    b.style.cssText = 'flex:none;background:#fff;color:#7a1f1f;border:0;border-radius:8px;padding:8px 12px;font:600 14px system-ui,sans-serif';
    b.addEventListener('click', () => location.reload());
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
    x.style.cssText = 'flex:none;background:none;color:#fff;border:0;padding:4px 6px;font:700 20px/1 system-ui,sans-serif';
    x.addEventListener('click', () => bar.remove());
    bar.append(p, b, x);
    (document.body || document.documentElement).append(bar);
  }
  window.addEventListener('error', (e) => { if (e && e.message) pageError(e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (r instanceof Error) pageError(r.message, ((r.stack || '').match(/(https?:[^\s)]+?):(\d+):(\d+)/) || [])[1] || '', 0, 0, r.stack);
  });
  const modeName = () => (VS ? 'versus' : SURV ? 'survivor' : PRACTICE ? 'practice' : DRIVE ? 'drive' : RUN_N ? 'run' : CUSTOM ? 'custom' : ARCH_DAY ? 'archive' : 'daily');
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
  const HOME = (document.querySelector('meta[name="home"]') || {}).content || 'nfl2mindrill.com';      // (site.py --domain)
  const SITE = BUILD && location.host ? location.host.replace(/^www\./, '') : HOME;
  // while the site moves (site.py --old-domain): the old address, whose /move hands a player's progress over (web/move.js)
  const OLD_HOME = ((document.querySelector('meta[name="old-home"]') || {}).content || '').trim();
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

  // every team by its city or region, never its nickname; the two markets with two teams say which (LA, New York)
  const TEAMS = {
    ARI: ['Arizona', '#97233F'], ATL: ['Atlanta', '#A71930'], BAL: ['Baltimore', '#241773'], BUF: ['Buffalo', '#00338D'],
    CAR: ['Carolina', '#0085CA'], CHI: ['Chicago', '#0B162A'], CIN: ['Cincinnati', '#FB4F14'], CLE: ['Cleveland', '#FF3C00'],
    DAL: ['Dallas', '#003594'], DEN: ['Denver', '#FB4F14'], DET: ['Detroit', '#0076B6'], GB: ['Green Bay', '#203731'],
    HOU: ['Houston', '#03202F'], IND: ['Indianapolis', '#002C5F'], JAX: ['Jacksonville', '#006778'], KC: ['Kansas City', '#E31837'],
    LV: ['Las Vegas', '#A5ACAF'], LAC: ['Los Angeles (AFC)', '#0080C6'], LA: ['Los Angeles (NFC)', '#003594'], MIA: ['Miami', '#008E97'],
    MIN: ['Minnesota', '#4F2683'], NE: ['New England', '#002244'], NO: ['New Orleans', '#D3BC8D'], NYG: ['New York (NFC)', '#0B2265'],
    NYJ: ['New York (AFC)', '#125740'], PHI: ['Philadelphia', '#004C54'], PIT: ['Pittsburgh', '#FFB612'], SF: ['San Francisco', '#AA0000'],
    SEA: ['Seattle', '#69BE28'], TB: ['Tampa Bay', '#D50A0A'], TEN: ['Tennessee', '#4B92DB'], WAS: ['Washington', '#5A1414'],
    // college teams, for a featured college game (src/nflclock/custom_spots.json); never in Versus
    OSU: ['Ohio State', '#BB0000'], IU: ['Indiana', '#990000'], ALA: ['Alabama', '#9E1B32'], TENN: ['Tennessee', '#FF8200'],
  };
  const COLLEGE = new Set(['OSU', 'IU', 'ALA', 'TENN']);
  const FAM = { run: 'Run', pass: 'Pass', rpo: 'RPO', trick: 'Trick' };
  // the trick plays (playbook.py): what each one is, on its key
  const TRICK_SUB = { trick_flea: 'Hand off, pitch it back, go deep', trick_reverse: 'Fake one way, a receiver comes back the other',
    trick_pass: 'A back or receiver throws it', trick_direct: 'Snap it straight to the back' };
  const TRICK_SAY = { trick_flea: 'runs the flea-flicker', trick_reverse: 'runs the end-around', trick_pass: 'lets a receiver throw it',
    trick_direct: 'snaps it direct to the back' };
  const TEMPOS = ['nohuddle', 'huddle', 'milk'];
  // your defense on their snaps: the looks it shows (the engine draws their play from real plays against it)
  const DEFS = ['blitz', 'load', 'soft'];
  const DEF = { blitz: { label: 'Blitz', sub: 'Send extra rushers' }, load: { label: 'Load the box', sub: 'Stop the run' },
    soft: { label: 'Play it soft', sub: 'Drop seven into coverage' } };
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
  const POS_NAME = { XOL: 'Extra lineman (lined up as a tight end)', QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end', LT: 'Left tackle',
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
  const ROUTE_NAME = { go: 'Go', post: 'Post', corner: 'Corner', out: 'Quick out', deep_out: 'Deep out', in: 'Dig', slant: 'Slant', cross: 'Crosser',
    hitch: 'Hitch', screen: 'Screen', flat: 'Flat', wheel: 'Wheel', angle: 'Angle' };
  const ROUTE_SAY = { go: 'a go route', post: 'a post', corner: 'a corner route', out: 'a quick out', deep_out: 'a deep out', in: 'a dig', slant: 'a slant',
    cross: 'a crosser', hitch: 'a hitch', screen: 'a screen', flat: 'a route to the flat', wheel: 'a wheel route', angle: 'an angle route' };
  const routeName = (lab, rt) => (lab === 'TE' && rt === 'go' ? 'Seam' : ROUTE_NAME[rt]);
  const routeSay = (lab, rt) => (lab === 'TE' && rt === 'go' ? 'a seam route' : ROUTE_SAY[rt]);
  // Run blocking (the Blocking chips under Run): how the line blocks a back's run, drawn on the field (lineplay: the
  // pullers, the down blocks, the double teams) and a small edge against the look the defense shows (engine.js
  // SCHEME_M: football logic, as the trick plays' matchups: no charting says which scheme a real run used)
  const SCHEMES = [['zone', 'Zone', 'Everyone steps the way of the run and the back picks his hole.'],
    ['power', 'Power', 'The backside guard pulls and leads through the hole: an extra blocker for a loaded box. A blitz can get in before him.'],
    ['counter', 'Counter', 'The back steps the other way, then the guard and tackle pull back across: misdirection that works on a light box, slow against a blitz.'],
    ['duo', 'Duo', 'Double teams driving straight ahead, downhill: built for a loaded box, less to gain against a light one.'],
    ['trap', 'Trap', 'A defensive lineman is let in, then a pulling guard traps him: punishes a blitz, struggles against a loaded box.']];
  // pass protection (engine.js PROT_N): who stays in to block. Each blocker more counts as a pass rusher fewer against
  // the real plays' pressure; the men who stay in run no route and can't be thrown to
  const PROTS = [['std', 'Standard', 'Five linemen; the back checks the blitz and releases.'],
    ['back', 'Back stays in', 'Six block: the back stays in. Less pressure, one receiver fewer.'],
    ['max', 'Max protect', 'Seven block: the back and a tight end stay in. The least pressure, only the rest go out.']];
  const PROT_SHORT = { std: 'Standard', back: 'RB in', max: 'Max protect' };
  const protOn = () => (!VS && G.prot && G.prot !== 'std' ? G.prot : null);
  // the men a protection keeps in: the back, then the tight end nearest the ball (none on the roster: nobody more)
  function protMen(sc, prot) {
    const E = eligibles(sc), rb = E.find((a) => a.label === 'RB'), bx = sc.bx ?? 0;
    const te = E.filter((a) => a.label === 'TE').sort((a, b) => Math.abs(a.x0 - bx) - Math.abs(b.x0 - bx))[0];
    return (prot === 'max' ? [rb, te] : prot === 'back' ? [rb] : []).filter(Boolean);
  }
  const schemeOn = () => !VS && G.scheme && G.scheme !== 'zone' ? G.scheme : null;
  const DEEP_ROUTES = new Set(['go', 'post', 'corner', 'wheel']);
  const YAC_IN = new Set(['slant', 'in', 'cross', 'post', 'angle', 'drag']), YAC_OUT = new Set(['out', 'deep_out', 'corner', 'flat', 'wheel']);
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
  // practice (#practice, the daily end card's "Keep playing"): one random real drive, graded like the day's, that
  // counts for nothing (no stats day, streak, tendencies or daily list); only once the day's drive is done (boot)
  let PRACTICE = location.hash === '#practice';
  const PRACTICE_KEY = `${STORE}:practice`;
  // the home screen (#home: the title, the Home tab, the menu on the field, the end cards): today's drive, survivor,
  // Pro and your stats. A bare address opens it too (the owner's call: the site's front door is Home, the day's drive
  // one tap away on it). A friend's challenge (?ch=, ?c=: challengeOpen) opens the day's card
  let HOME_PG = location.hash === '#home';
  const CH_LINK = new URLSearchParams(location.search).has('ch') || new URLSearchParams(location.search).has('c');
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
  // a scenario of your own (Pro, web/scenario.js): #custom builds one, #custom-<code> plays it (its own saved state and,
  // like a historic drive, each try its own draws); the rosters it plays with are the site's (rosters/: scenario.py)
  // (hidden, link and all, until its launch: scripts/site.py --scn-at puts the time in a meta; a reload after shows it)
  const SCN_AT = Date.parse((document.querySelector('meta[name="scn-at"]') || {}).content || '') || 0;
  const SCN = typeof TMDScenario !== 'undefined' && Date.now() >= SCN_AT ? TMDScenario : null;
  const CUSTOM_BUILD = PRO_ON && !!SCN && location.hash === '#custom';
  // (a title rides after the code: #custom-<code>~<title>, scenario.js link; the scenario is its code, whatever its title)
  // (its code: web/scenario.js CODE_RE, the 22 parts and any lineup picks after them)
  const CUSTOM = PRO_ON && SCN ? ((m) => (m && SCN.CODE_RE.test(m[1]) ? m[1] : ''))(/^#custom-([^~]*)(?:~.*)?$/.exec(location.hash)) : '';
  const CUSTOM_TITLE = CUSTOM ? SCN.parseLink(location.hash.slice('#custom-'.length)).title : '';
  // the scenarios players have posted (Pro screen; board/worker.js /scen/*): #community lists them, a tap plays one by its link
  const COMMUNITY = PRO_ON && !!SCN && location.hash === '#community';
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
  // a player can keep the defense to the three simple calls (asked for: the full one is a lot to take in)
  const simpleDef = () => !VS && !!load(`${STORE}:simpledef`, false);
  const VS_DECIDE_MS = 30000;      // the play clock in Versus: 30 seconds a call (board/match.js DECIDE_MS)
  // spots whose data was corrected, and when the fix went live: a drive's try saved before it starts over
  // (the two overtime drives were played as a fourth quarter until their start carried the overtime: startRoot otOf)
  const SPOT_FIXED = { '2018_14_NE_MIA#4172': Date.parse('2026-10-16T22:50:00Z'), '2023_22_SF_KC#4561': Date.parse('2026-10-18T13:00:00Z'),
    '2015_19_GB_ARI#4454': Date.parse('2026-10-18T13:00:00Z') };
  const stateKey = () => (VS ? `${STORE}:vs:${VS_ROOM}` : SURV ? `${STORE}:surv` : PRACTICE ? PRACTICE_KEY : DRIVE ? `${STORE}:drive:${DRIVE}` : RUN_N ? `${STORE}:run:${RUN_N}` : CUSTOM ? `${STORE}:custom:${CUSTOM}` : `${STORE}:day:${dayN}`);
  // (not once a restart is under way: a grading still running for the old try must not save it back over the new one)
  let restarting = false;
  const saveState = () => { if (!restarting) save(stateKey(), state); };
  // what the engine's draws are seeded by. A Pro drive or playoff run by its try too (state.tryAt: a try again is a new
  // state, a reload keeps it): each try a fresh challenge, where the same calls once played out the same way again.
  // The daily (and a past day's, from the archive) stays the day's: the same draws for everyone that day
  const tryOf = () => (state && state.tryAt ? `:${state.tryAt}` : '');
  const seedKey = () => (VS ? `vs${vs.seed}` : SURV ? `s${state.run}:${state.games.length}` : PRACTICE ? `p${state.run}` : DRIVE ? `drive${DRIVE}${tryOf()}` : RUN_N ? `run${RUN_N}${tryOf()}` : CUSTOM ? `custom${CUSTOM}${tryOf()}` : dayN);
  let G = null;                   // the spot being played
  let ui = { step: null, fam: null, oob: false };
  let busy = false, lastFocus = null, deepFocus = null, tick = null, lastBall = null;
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
  // where room is tight (the stands' wall): "LA (NFC)", "NY (AFC)"
  const teamShort = (c) => teamName(c).replace(/^Los Angeles/, 'LA').replace(/^New York/, 'NY');
  // a team in a season it played in another city (Los Angeles (NFC) in 1999 and 2001: St. Louis; web/scenario.js eraName), else today's
  const eraOf = (c, y) => (y && typeof TMDScenario !== 'undefined' ? TMDScenario.eraName(c, y) : null);
  const cityIn = (c, y) => eraOf(c, y) || teamName(c);
  // a historic game's two teams by their cities of the time, for the page that plays it (the page is that one game)
  const eraTeams = (sc) => [sc.home, sc.away].forEach((c) => { const n = eraOf(c, sc.real && sc.real.season); if (n && TEAMS[c]) TEAMS[c] = [n, TEAMS[c][1]]; });
  const color = (c) => (TEAMS[c] ? TEAMS[c][1] : '#556');
  const code = (i) => (i === 0 ? G.scen.home : G.scen.away);
  // a team as the spot has it, and as it plays: yours with the quarterback you put in (Who plays: G.qb, a name from its
  // lineup.qbs; web/scenario.js withQb: his adjustment for the starter's and his level on the passes he throws), kept
  // one object a pick so its lineup is cached once (lineup) and the simulator once (simScen). Never in Versus: the
  // room has the teams
  const teamBase = (i) => (i === 0 ? G.scen.game.home : G.scen.game.away);
  const QB_TEAM = new WeakMap();
  function teamOf(i, qb = G.qb) {
    const t = teamBase(i);
    if (!qb || i !== G.me || VS || typeof TMDScenario === 'undefined') return t;
    const m = QB_TEAM.get(t) || new Map();
    QB_TEAM.set(t, m);
    if (!m.has(qb)) {
      let s = t;
      try { s = TMDScenario.withQb(t, qb); } catch (e) { s = t; }        // (one no longer on the roster: the team as it is)
      m.set(qb, s);
    }
    return m.get(qb);
  }
  const qbOn = (qb = G.qb) => !!(qb && teamOf(G.me, qb) !== teamBase(G.me));      // a quarterback of yours put in, playing
  // the punter kicking the field goals (the kicker hurt: Los Angeles' Ethan Evans, Oct 18, 2026): said with the kick
  const punterKicks = (i) => { const t = teamOf(i); return !!(t.kicker && t.punter && t.kicker.name && t.kicker.name === t.punter.name); };
  const PUNT_EZ_YL = 70;      // their punt from their own 30 or nearer midfield can reach the end zone (2-23% of real ones do)
  const markOf = (cost) => (cost < 0.005 ? 'g' : cost < 0.02 ? 'y' : cost < 0.05 ? 'o' : 'r');
  function rate(o, dl = 0) {          // an overall rating as a color: red (below a starter) -> yellow (typical, 77) -> green (elite)
    const v = clip(o, 55, 95);
    const h = v < 77 ? 2 + ((v - 55) / 22) * 43 : 45 + ((v - 77) / 18) * 90;
    const l = (v < 77 ? 52 : 50 - ((v - 77) / 18) * 4) - dl;          // (dl: a shade darker, rateChip)
    return `hsl(${h.toFixed(0)} ${v > 72 && v < 82 ? 88 : 80}% ${l.toFixed(0)}%)`;
  }
  // big text on a team's color (its badge on the intro, its end zone): white, or the ink where white reads under 3 to 1
  // (Pittsburgh's gold, New Orleans', Las Vegas' silver)
  const darkOn = (c) => 1.05 / (lum(c) + 0.05) < 3;
  // a rating's chip, its number in it (the ratings list, a player's card): the ink on the yellows and greens, white on
  // the reds and oranges a shade darker (on the oranges neither read at 4.5 to 1)
  function rateChip(ch, o) {
    const ink = (lum(rate(o)) + 0.05) / 0.059 >= 4.5;
    ch.classList.toggle('dk', ink);
    ch.style.background = ink ? rate(o) : rate(o, 6);
  }
  // a color's relative luminance (WCAG): '#rrggbb' or rate()'s hsl; 0.059 with 0.05 is the ink's (#121a15)
  function lum(c) {
    const h = /^hsl\((\S+) (\S+)% (\S+)%\)$/.exec(c), x = /^#(..)(..)(..)$/.exec(c);
    let rgb = [0, 0, 0];
    if (x) rgb = x.slice(1).map((v) => parseInt(v, 16) / 255);
    else if (h) {
      const [hh, ss, ll] = h.slice(1).map(Number), a = (ss / 100) * Math.min(ll / 100, 1 - ll / 100);
      rgb = [0, 8, 4].map((n) => { const k = (n + hh / 30) % 12; return ll / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
    }
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
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
    const st = sc.start, kick = st.phase === 'kick';        // (a scenario can open on a kickoff: pos is the kicking team)
    return { t: st.qtr <= 4 ? (4 - st.qtr) * 900 + st.clock : st.clock, pos: st.pos === sc.home ? 0 : 1,
      score: [st.score[1], st.score[0]], down: kick ? 1 : st.down, ytg: kick ? 10 : Math.min(st.ytg, st.yl), yl: kick ? 65 : st.yl,
      to: [st.to[1], st.to[0]], clock_running: !!st.running, phase: kick ? KICKOFF : SNAP, credit: 0, free_kick: false, ...otOf(sc) };
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
    if (st.otc) { c[0] = st.otc[0]; c[1] = st.otc[1]; }       // (a scenario says who has had the ball: web/scenario.js)
    return { ot: { c, po, n: st.qtr - 4, ...(rules === 'sd' || rules === 'msd' ? { r: rules } : {}) } };
  }
  // a spot's matchup: its two teams as they were in that game (web/spots), the real point spread, that
  // season's league averages
  function buildScen(sp, T) {
    const H = T.home, A = T.away;
    const game = { home: H, away: A, home_spread: sp.spread ?? 0, indoor: sp.indoor, wind: sp.wind, temp: sp.temp,
      league: sp.league || idx.league, home_coach: H.coach, away_coach: A.coach, season: sp.real ? sp.real.season : idx.asof.season };
    return { ...sp, game, first: T.first || null };        // (first: the first call's facts, the website's spot files: firstInfo)
  }
  const sideFor = (seq) => (hash('side', seedKey(), G.si, seq) % 2 ? 1 : -1);   // +1: strong side on the offense's right
  // A jumbo snap: a sixth lineman reported as eligible sits in a tight end's slot (history.py _ol_slots). The drive
  // isn't all goal-line snaps, so the team's own tight end from that game's backups takes the slot; with none, the
  // lineman stays, called what he is (an extra lineman). Linemen wear 50-79; tight ends can't.
  const OL_NUM = (p) => p && p.num >= 50 && p.num <= 79;
  const LINEUP_FIX = new WeakMap();
  const lineup = (i) => {
    const L = teamOf(i).lineup || { off: [], def: [] };
    if (LINEUP_FIX.has(L)) return LINEUP_FIX.get(L);
    const bench = (L.bench || []).filter((p) => !(p.pos === 'TE' && OL_NUM(p)));
    const spare = bench.filter((p) => p.pos === 'TE' && !L.off.some((q) => q.name === p.name)).sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
    const off = L.off.map((p) => {
      if (p.pos !== 'TE' || !OL_NUM(p)) return p;
      return spare.length ? spare.shift() : { ...p, xol: true };
    });
    const tidy = (p) => (p && /\s{2,}|^\s|\s$/.test(p.name || '') ? { ...p, name: p.name.replace(/\s+/g, ' ').trim() } : p);   // (some names in the data carry a double space)
    const out = { ...L, off: off.map(tidy), def: (L.def || []).map(tidy), bench: bench.filter((p) => !off.includes(p)).map(tidy) };
    LINEUP_FIX.set(L, out);
    return out;
  };
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
  const pool = [], queue = [], low = [], pending = new Map();
  // (low: a snap's grading redone after a reload, behind everything else: regradeBg)
  const lowRoots = new WeakSet();
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
  async function fetchPacked(url, size) {
    // gunzipped as it comes in (the bytes counted on the way), not all at the end: the last chunk is the only wait
    const name = url.split('?')[0];
    // the first visit (no service worker when it was asked for, so nothing kept it): a copy goes into this build's
    // worker's cache, so the next visit doesn't download it again (whether the worker took over by the time the answer
    // came is beside the point: it never saw the request)
    const uncached = swOn() && !navigator.serviceWorker.controller;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    dl.total += +r.headers.get('content-length') || size;
    const keep = /[?&]v=/.test(url) && uncached && typeof caches !== 'undefined' && r.type === 'basic' ? r.clone() : null;
    let body = r.body;
    if (body && typeof TransformStream === 'function') body = body.pipeThrough(new TransformStream({ transform(c, ctl) { dl.got += c.length; ctl.enqueue(c); } }));
    else { const b = await r.arrayBuffer(); dl.got += b.byteLength; body = new Blob([b]).stream(); }
    const out = await new Response(body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const h = new Uint8Array(out, 0, 4);
    if (String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'NFCP') throw new Error('not a data pack');
    if (keep) caches.open(`tmd-${BUILD}`).then((c) => c.put(new URL(url, location.href).href, keep)).catch(() => { /* storage full or off */ });
    return out;
  }
  // the download starts as soon as the page knows it will play (boot, before game.json): it is most of what the first
  // snap waits on, and the intro's few small files go alongside it. (Both packs at once: the engine's first, then the
  // playbook's, to set the engine up while the playbook's came in, was no faster: the second request's round trip ate
  // what it saved)
  let fetched = false, hides = 0, shown = true, cutShort = false;
  function fetchData() {
    if (fetched) return;
    fetched = true;
    const gen = hides, left = () => hides !== gen;        // the page was left (hidden) since this download began
    const json = () => Promise.all([fetchBytes(asset('engine_data.json'), 'engine data', 5.5e6), fetchBytes(asset('playbook.json'), 'playbook', 6.1e6)]);
    const pk = BUILD && typeof DecompressionStream === 'function'
      ? Promise.all([fetchPacked(asset('engine_data.pack'), 1.8e6), fetchPacked(asset('playbook.pack'), 1.3e6)]).then((b) => { packed = true; return b; })
      : Promise.reject(new Error('no pack'));
    // (not when the page is going away: a reload or a mode switch cuts the download short, and the call shows before
    // it is done, so that is often now. Kept in the back-forward cache instead, the page comes back to it: refetch)
    dataBytes = pk.catch((e) => { if (left()) throw e; dl.got = 0; dl.total = 0; packed = false; return json(); });
    dataBytes.catch((e) => {
      if (!left()) fatal('The simulator could not load (' + e.message + '). Check your connection and reload.');
      else if (shown) refetch(); else cutShort = true;
    });
  }
  // back from the back-forward cache (a link followed, then Back) with the download cut short by leaving: it starts
  // again, and the workers still waiting on it get the new one (the huddle's percentage starts over with it)
  function refetch() {
    cutShort = false;
    if (readyCount) return;
    fetched = false; dl.got = 0; dl.total = 0;
    fetchData();
    pool.forEach(initWorker);
  }
  addEventListener('pagehide', () => { hides++; shown = false; });
  addEventListener('pageshow', (ev) => { shown = true; if (ev.persisted && cutShort) refetch(); });
  function startWorkers() {
    fetchData();
    startWorker();
  }
  // the worker's own files' stamps ride in its address, one parameter a file (game_worker.js reads them)
  function workerUrl() {
    const arg = (u) => { const v = /\?v=([^&]*)/.exec(u); return v ? `&${u.split('?')[0]}=${v[1]}` : ''; };
    const w = asset('game_worker.js'), q = arg(asset('engine.js')) + arg(asset('vs_core.js')) + arg(asset('engine_data.json')) + arg(asset('playbook.json'));
    return !q ? w : w.includes('?') ? w + q : `${w}?${q.slice(1)}`;
  }
  function startWorker() {
    const w = new Worker(workerUrl());
    const slot = { w, ready: false, busy: false };
    w.onmessage = (ev) => onMsg(slot, ev.data);
    w.onerror = (e) => fatal('The simulator could not start: ' + (e.message || 'worker error'));
    pool.push(slot);
    initWorker(slot);
  }
  function initWorker(slot) {
    const got = dataBytes;
    got.then(([eng, pb]) => {
      if (slot.init || dataBytes !== got) return;          // (once: a refetch, pageshow, sends its own)
      slot.init = true;
      const engine = eng.slice(0), playbook = pb.slice(0);      // a copy each, moved into the worker
      slot.w.postMessage({ type: 'init', engine, playbook, packed }, [engine, playbook]);
    }, () => {});
  }
  function pump() {
    for (const s of pool) {
      if (!s.ready || s.busy) continue;
      const m = queue.shift() || low.shift();
      if (!m) return;
      s.busy = true;
      s.w.postMessage(m);
    }
  }
  function onMsg(slot, m) {
    if (m.type === 'ready') {
      slot.ready = true; readyCount++;
      if (readyCount === 1) {              // how long the simulator took, and how long a player sat waiting on it
        simUp();
        const now = performance.now();
        track('sim_ready', { mode: modeName(), packed, ms: Math.round(now), waited_ms: huddleT0 ? Math.round(now - huddleT0) : 0 });
      }
      if (readyCount === POOL) dataBytes = null;               // every worker has its copy: let the bytes go
      pump();
      if (!slot.busy) morePool();
      return;
    }
    if (m.type === 'error' && m.id == null) { fatal('The simulator could not load (' + m.message + '). Check your connection and reload.'); return; }
    slot.busy = false;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) { if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m); }
    morePool();
    pump();
  }
  // the rest of the pool starts once the first worker has answered what was waiting on it (the first call's facts):
  // their setting up would otherwise share a slow phone's CPU with it
  function morePool() {
    if (readyCount && pool.length < POOL) for (let i = pool.length; i < POOL; i++) startWorker();
  }
  // urgent: the snap itself and the facts for a call go ahead of any grading still queued
  function send(msg, urgent) {
    return new Promise((resolve, reject) => {
      msg.id = ++reqId; pending.set(msg.id, { resolve, reject });
      if (urgent) queue.unshift(msg); else if (msg.root && lowRoots.has(msg.root)) low.push(msg); else queue.push(msg);
      pump();
    });
  }
  // (with a quarterback of yours put in, the teams as they play and a simulator of their own: the same id would be the
  // worker's simulator of the real lineup; spot_info.js has the spot's own, the real lineup's, the first call's facts)
  // (qb: the one a snap was graded with, its grading redone after a reload: gradeSpecs)
  const simScen = (qb = G.qb) => (qbOn(qb) ? { id: `${G.scen.id}|qb:${qb}`, game: { ...G.scen.game, [G.me === 0 ? 'home' : 'away']: teamOf(G.me, qb) }, start: { receive2h: G.scen.start.receive2h } }
    : { id: G.scen.id, game: G.scen.game, start: { receive2h: G.scen.start.receive2h } });
  // The facts for a call (the worker's 'info'): on the website a spot's file carries them for its opening snap, worked
  // out when the site was built by the same worker on the same data (web/spot_info.js), so the first call shows without
  // waiting on the simulator's data (only the snap does: simWait). Used only for the very question they answer (infoKey:
  // a fingerprint of it, cyrb53, the same as spot_info.js), else null: asked. The simulator is asked anyway once it is
  // in and must answer the same (a difference is reported: the console and analytics). The same to within float
  // rounding: Safari's JavaScript engine works some of the odds out a hair apart from the one that built them
  // (Math.exp and the like: 1e-13 apart, in 23 of the first 30 spots), which no screen shows
  function infoKey(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const sameInfo = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameInfo(a[k], b[k]));
  };
  function firstInfo(r) {
    const q = { scen: simScen(), root: r }, f = G.scen.first;
    if (!f || f.key !== infoKey(JSON.stringify(q))) return null;
    const txt = JSON.stringify(f.info), ref = JSON.parse(txt);
    try { performance.mark('tmd:first-info'); } catch (e) { /* no marks */ }
    send({ type: 'info', ...q }).then((m) => {
      if (sameInfo(m.info, ref)) return;
      console.error(`the first call's facts for ${q.scen.id} differ from the simulator's`);
      track('info_mismatch', { spot: q.scen.id });
    }, () => {});
    return JSON.parse(txt);          // (a copy: the page's own, as the worker's answers are)
  }
  // a call made before the simulator's data is in (the first call showed on the spot's own facts): say so, with how
  // far along the download is, until it is
  let simUp = null;
  const simReady = new Promise((res) => { simUp = res; });
  async function simWait() {
    if (readyCount || VS) return;
    huddle('Getting the playbook ready…');
    await simReady;
  }
  // (se, when given, gets each option's standard error: the simulation's own noise in that win chance)
  async function evaluate(root, options, seed, n = N_EVAL, se = null, sc = simScen()) {
    const W = Math.max(1, readyCount), out = {};
    const opts = options.map((o) => ({ key: o.key, action: o.action }));
    if (options.length < 2 * W && W > 1) {
      // few options: every worker plays all of them, each on its own share of the games (its own seed)
      const m = Math.ceil(n / W);
      const res = await Promise.all(Array.from({ length: W }, (_, j) => send({ type: 'eval', scen: sc, root, options: opts, n: m, persp: G.me, seed: (seed + j * 7919) >>> 0 })));
      opts.forEach((o) => {
        const xs = res.map((r) => r.out.find((x) => x.key === o.key));
        out[o.key] = xs.reduce((a, x) => a + x.mean, 0) / W;
        if (se) se[o.key] = Math.sqrt(xs.reduce((a, x) => a + (x.se || 0) ** 2, 0)) / W;
      });
      return out;
    }
    const k = Math.min(W * 3, options.length);          // small jobs: a worker is soon free for the snap
    const chunks = Array.from({ length: k }, () => []);
    opts.forEach((o, i) => chunks[i % k].push(o));
    const res = await Promise.all(chunks.map((c) => send({ type: 'eval', scen: sc, root, options: c, n, persp: G.me, seed })));
    res.forEach((r) => r.out.forEach((o) => { out[o.key] = o.mean; if (se) se[o.key] = o.se || 0; }));
    return out;
  }
  // grading a decision: every option N_EVAL times, then the top REFINE_TOP again N_REFINE times on fresh games. Valued
  // on the same games that picked it, the best of many noisy options is lucky, and every other call looks worse than it
  // is (at 600 games, 15% of the calls shown red were really green or yellow); valued again, it is not. An option left
  // out of the second round never counts as better than the best one valued in it. Which options go again never
  // depends on your call: yours is valued exactly as it would be if a simulated NFL play-caller had made it (your call
  // valued finely and the rest roughly scored random calls 99 on a day when nothing mattered: the rough values the
  // simulated callers paid for were noise that never landed on you). Each value keeps its standard error and games.
  async function evaluateGraded(root, options, seed, sc = simScen()) {
    const se1 = {}, v = await evaluate(root, options, seed, N_EVAL, se1, sc);
    const keys = new Set(options.slice().sort((a, b) => v[b.key] - v[a.key]).slice(0, REFINE_TOP).map((o) => o.key));
    const se2 = {}, v2 = await evaluate(root, options.filter((o) => keys.has(o.key)), (seed ^ 0x5bd1e995) >>> 0, N_REFINE, se2, sc);
    const top = Math.max(...Object.values(v2)), out = {};
    options.forEach((o) => { out[o.key] = keys.has(o.key) ? { wp: v2[o.key], se: se2[o.key], n: N_REFINE } : { wp: Math.min(v[o.key], top), se: se1[o.key], n: N_EVAL }; });
    return out;
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
  const PLAUSIBLE = 0.02;
  function normalize(q, keys) {
    const out = {};
    let s = 0;
    keys.forEach((k) => { out[k] = Math.max(q[k] || 0, 0); s += out[k]; });
    if (s <= 0) keys.forEach((k) => { out[k] = 1 / keys.length; });
    else keys.forEach((k) => { out[k] /= s; });
    return out;
  }
  // A decision as graded (g: 2). The best call is one a real play-caller would make here (2% of the time or more):
  // never a flea-flicker, a 66-yard kick or a spike nobody makes, however the numbers come out (players saw them
  // suggested), and never yours just for being yours (it made the bar every simulated caller was measured against).
  // Each option's cost (wps[].c) is what it gives up against the best, and the same numbers count for you and for
  // every simulated play-caller (scoreVsNFL), so luck in the simulation favors nobody. A cost counts as nothing:
  // - inside the simulation's noise: NOISE_Z standard errors of the difference, each side's games with the larger of
  //   the two per-game spreads (an option that won 3 of 600 games at 1% shows a spread too small to trust);
  // - under COST_MIN, a green call's (protecting a 99% lead, tenths of a point decided the score: a sharp reader 9,
  //   random calls 56);
  // - on a decision where no option is QUIET_Z standard errors worse than the best (with 20 options, one is 2 off by
  //   chance alone): nothing was at stake there for anyone (down 25 in the third quarter, random calls scored 3 to 94
  //   on such noise; now about 50, the result's alone).
  // gap is the raw difference, for the words; typical: what a typical NFL play-caller gives up here (the league's call
  // mix); wpa: how much less yours did.
  function decisionFrom(kind, family, options, vals, chosen, q, situation, snap = G.snapN) {
    const wps = options.map((o) => ({ key: o.key, label: o.label, wp: vals[o.key].wp, call: (o.action && o.action.call) || null, ...(o.action && o.action.dc ? { dc: o.action.dc } : {}) }));
    const n = (w) => vals[w.key].n || N_EVAL, sd2 = (w) => (vals[w.key].se || 0) ** 2 * n(w);
    const mine = wps.find((w) => w.key === chosen);
    const qq = normalize(q, wps.map((w) => w.key));
    const real = wps.filter((w) => qq[w.key] >= PLAUSIBLE);
    const best = (real.length ? real : wps).reduce((a, b) => (b.wp > a.wp ? b : a));
    let stake = false;
    wps.forEach((w) => {
      const gap = Math.max(0, best.wp - w.wp), noise = w === best ? 0 : Math.sqrt(Math.max(sd2(w), sd2(best)) * (1 / n(w) + 1 / n(best)));
      w.c = gap > NOISE_Z * noise && gap >= COST_MIN ? gap : 0;
      if (w.c && gap >= QUIET_Z * noise) stake = true;
    });
    if (!stake) wps.forEach((w) => { w.c = 0; });
    const typical = wps.reduce((a, w) => a + qq[w.key] * w.c, 0);
    return { kind, family, situation, wps, chosen, chosenCall: mine.call, chosenLabel: mine.label, best: best.key, bestLabel: best.label,
      bestWp: best.wp, wp: mine.wp, cost: mine.c, gap: Math.max(0, best.wp - mine.wp), q: qq, typical, wpa: typical - mine.c, snap, g: 2 };
  }

  // ---------------------------------------------------------- formations ---
  // x in the offense's own frame (its right is +), depth in yards behind (offense) or off (defense) the ball
  const SX0 = 8, SX1 = 352, XYD = (SX1 - SX0) / 53.333;
  const HASH_L = SX0 + 23.58 * XYD, HASH_R = SX1 - 23.58 * XYD;
  const clampX = (x) => clip(x, SX0 + 12, SX1 - 12);
  // form (your offense: G.form): how it lines up. qb: 'gun' (the default), 'under' center (the back seven deep behind
  // him, a fullback between: the I), 'pistol' (the quarterback four deep, the back behind him) or 'empty' (the backs
  // split out, nobody in the backfield); look: where the receivers go, 'trips' (three to the strong side, the default),
  // 'spread' (two and two), 'bunch' (three in a cluster off the tackle) or 'tight' (everyone in close). Where they
  // stand only: the engine draws its plays by the quarterback's formation (FORM_CODE), never by the look
  function formation(offL, defL, s, bx, form) {
    const by = {};
    offL.forEach((p) => { (by[p.pos] = by[p.pos] || []).push(p); });
    const take = (pos) => (by[pos] && by[pos].length ? by[pos].shift() : null);
    const off = [], def = [];
    const put = (arr, p, x, d, label) => { if (p) arr.push({ p, x: clampX(x), d, label: label || p.pos }); };
    const olX = { LT: -52, LG: -26, C: 0, RG: 26, RT: 52 };
    OL.forEach((lab) => put(off, take(lab), bx + olX[lab], 1.0, lab));
    ['T', 'G'].forEach((lab) => { let p; while ((p = take(lab))) put(off, p, bx, 1.0, lab); });
    const fq = (form && form.qb) || 'gun', fl = (form && form.look) || 'trips';
    const teX = bx + s * 78;
    const xX = s > 0 ? SX0 + 22 : SX1 - 22, zX = s > 0 ? SX1 - 26 : SX0 + 26, slotX = (teX + zX) / 2, wslotX = (xX + bx - s * 52) / 2;
    // the receivers' spots by the look, in the order the men are taken: the tight end, then X, Z and the slot
    const W = { trips: [[teX, 1.15], [xX, 1.0], [zX, 1.5], [slotX, 1.7]],
      spread: [[teX, 1.15], [xX, 1.0], [zX, 1.5], [wslotX, 1.7]],
      bunch: [[teX, 1.15], [xX, 1.0], [teX + s * 24, 1.0], [teX + s * 12, 1.9]],
      tight: [[teX, 1.15], [bx - s * 68, 1.0], [bx + s * 108, 1.0], [bx + s * 93, 1.8]] }[fl] || [[teX, 1.15], [xX, 1.0], [zX, 1.5], [slotX, 1.7]];
    put(off, take('TE'), W[0][0], W[0][1], 'TE');
    put(off, take('WR'), W[1][0], W[1][1], 'WR');
    put(off, take('WR'), W[2][0], W[2][1], 'WR');
    put(off, take('WR'), W[3][0], W[3][1], 'WR');
    const B = { gun: { qb: [bx, 5.0], rb: [bx - s * 25, 5.2], fb: [bx, 3.0] }, under: { qb: [bx, 1.6], rb: [bx, 7.0], fb: [bx, 4.3] },
      pistol: { qb: [bx, 4.0], rb: [bx, 7.0], fb: [bx - s * 25, 4.6] }, empty: { qb: [bx, 5.0], rb: [wslotX, 1.5], fb: [slotX - s * 10, 1.9] } }[fq];
    put(off, take('QB'), B.qb[0], B.qb[1], 'QB');
    put(off, take('RB'), B.rb[0], B.rb[1], 'RB');
    put(off, take('FB'), B.fb[0], B.fb[1], 'FB');
    const spare = [[bx - s * 78, 1.15], [bx + s * 25, 5.2], [wslotX, 1.7]];
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
    // (the first corner over the first receiver out wide: with one, a corner on the empty side left him uncovered)
    const cbs = [[clampX(xX), 6.5], [clampX(zX), 6.5], [clampX(slotX), 5.5], [bx + s * 34, 9.0]];
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
  // your defense as you call it, before the snap (players asked to see it): the safeties as deep as the coverage has
  // them, the linebackers as the front has them, the extra rushers walked up to the line
  const DEEP_OF = { c0: 0, c1: 1, c3: 1, c2: 2, c4: 2, '2man': 2, c6: 2, prevent: 3 };
  function showDc(def, dc, s, bx) {
    const lbs = def.filter((o) => o.label === 'LB'), sf = def.filter((o) => o.label === 'S'), cbs = def.filter((o) => o.label === 'CB');
    const deep = DEEP_OF[dc.cover] ?? 1;
    const spots = deep === 1 ? [[bx + s * 8, 14]] : deep === 2 ? [[bx - s * 62, 13.5], [bx + s * 62, 13.5]] : deep === 3 ? [[bx - s * 85, 16], [bx, 19], [bx + s * 85, 16]] : [];
    const backs = sf.concat(cbs.slice(3));                      // (the deep men: safeties, then any extra DB)
    backs.forEach((o, i) => {
      if (i < spots.length) { o.x = clampX(spots[i][0]); o.d = spots[i][1]; }
      else { o.d = dc.cover === 'c0' ? 5 : 7.5; o.x = clampX(bx + (o.x - bx) * 0.7); }       // down low: in the box or on a man
    });
    cbs.slice(0, 2).forEach((o) => { o.d = dc.cover === 'c3' || dc.cover === 'c4' || dc.cover === 'prevent' ? 8.5 : dc.cover === 'c2' ? 4.5 : 6.5; });
    lbs.forEach((o) => {
      if (dc.front === 'loaded') { o.d = 3.8; o.x = clampX(bx + (o.x - bx) * 0.8); }
      else if (dc.front === 'light') { o.d = 6.5; o.x = clampX(bx + (o.x - bx) * 1.25); }
      if (dc.cover === 'prevent') o.d += 4;
    });
    // the rush: the line, then linebackers walked up to make the count
    const line = def.filter((o) => o.label === 'DL' || o.label === 'EDGE').length;
    const up = lbs.concat(sf.slice(spots.length)).slice(0, Math.max(0, (+dc.rush || 4) - line));
    up.forEach((o, i) => { o.d = 1.9; o.x = clampX(bx + (i % 2 ? -1 : 1) * s * (60 + 18 * Math.floor(i / 2))); });
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
  // px over the field during a play in the broadcast view: the scoreboard at the top, the skip note at the bottom
  const PLAY_COVER = { top: 72, bot: 52 };
  const BCAST_YARDS = 42;          // yards of field the broadcast view shows before the snap, between scoreboard and calls
  // a phone playing (game.html): the field is the whole screen, under the scoreboard and the calls' sheet
  const bcast = () => document.body.classList.contains('bcast') && !(window.matchMedia && window.matchMedia('(min-width: 1000px)').matches);
  // the timeout a button on the field (a phone's broadcast view), unless the page is zoomed so narrow that the chips on
  // the field run under the calls' sheet (game.html, max-width 299px): then a key with the calls, as on a computer
  const toOnField = () => bcast() && !window.matchMedia('(max-width: 299px)').matches;
  // what covers the field in the broadcast view, in px: the scoreboard and the chips under it at the top, the calls'
  // sheet (or its bar, when it is down) at the bottom
  function covers() {
    if (!bcast()) return { top: 0, bot: 0 };
    const play = $('play'), sh = $('sheet'), vh = play.clientHeight || window.innerHeight;
    const bot = sh.classList.contains('down') ? 66 : clip(sh.offsetHeight || vh * 0.45, 66, vh * 0.6);      // (a pass's sheet: up to 58%, game.html)
    return { top: 104, bot };
  }
  function fieldHeight() {
    const svg = $('field');
    const wpx = svg.parentElement.clientWidth || 360;
    if (bcast()) return Math.round((360 * ($('play').clientHeight || window.innerHeight)) / wpx);
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
  // In the broadcast view (cover: px of field under the scoreboard and under the calls, k: px per field unit) the
  // play is framed in the part that shows, between them, and the field runs on past its ends if it must
  function preCam(H, L, dir, mode, cover, k) {
    if (mode !== 'snap' && mode !== 'pat') return { ...FULL };
    if (cover && cover.bot) {
      // (zoomed in to about BCAST_YARDS of field in what shows, like a broadcast, never wider than true to scale)
      const band = H - 6 - (cover.bot + cover.top) * k, K = Math.max(360 / 53.333, band / BCAST_YARDS);
      const span = (H - 6) / K, cb = (cover.bot * k) / K, ct = (cover.top * k) / K;
      const back = clip((span - cb - ct) * 0.22, 8, 20);
      const lo = dir > 0 ? L - back - cb : L + back + ct - span;
      return { lo, hi: lo + span };
    }
    const span = clip((H - 6) / (360 / 53.333), 50, 120), back = clip(span * 0.22, 12, 20);
    let lo = dir > 0 ? L - back : L + back - span, hi = lo + span;
    const elo = FULL.lo - EDGE, ehi = FULL.hi + EDGE;
    if (lo < elo) { hi += elo - lo; lo = elo; }
    if (hi > ehi) { lo -= hi - ehi; hi = ehi; }
    return { lo: Math.max(lo, elo), hi: Math.min(hi, ehi) };
  }
  // Behind each end line, as on TV: a few yards of turf, that team's cheerleaders and its mascot, the padded wall and
  // the stands packed in its colors (they show when the camera is near a goal line). TRIM: each team's second color
  const TRIM = { ARI: '#111111', ATL: '#111111', BAL: '#9E7C0C', BUF: '#C60C30', CAR: '#101820', CHI: '#C83803', CIN: '#111111',
    CLE: '#311D00', DAL: '#869397', DEN: '#002244', DET: '#B0B7BC', GB: '#FFB612', HOU: '#A71930', IND: '#A2AAAD', JAX: '#D7A22A',
    KC: '#FFB81C', LV: '#111111', LAC: '#FFC20E', LA: '#FFA300', MIA: '#FC4C02', MIN: '#FFC62F', NE: '#C60C30', NO: '#101820',
    NYG: '#A71930', NYJ: '#FFFFFF', PHI: '#A5ACAF', PIT: '#101820', SF: '#B3995D', SEA: '#002244', TB: '#34302B', TEN: '#0C2340',
    WAS: '#FFB612', OSU: '#666666', IU: '#EEEDEB', ALA: '#828A8F', TENN: '#FFFFFF' };
  const trim = (c) => TRIM[c] || '#ffffff';
  const EDGE = 6;            // yards a snap's camera may show past the end line: the cheerleaders and the wall
  const SKIN = ['#f3d0b4', '#e3b48c', '#c98e5f', '#a26a3f', '#7a4b2b', '#5a3620'];
  const HAIR = ['#24160d', '#5a3825', '#d9b45e', '#121212', '#8a4b2a', '#3b2416'];
  const CHEER_X = [24, 52, 80, 110, 250, 280, 308, 336];
  let crowdN = 0;
  function cheerleader(c, i) {
    const tc = color(c), tr = trim(c), sk = SKIN[(i * 5 + 1) % SKIN.length], hr = HAIR[(i * 7 + 2) % HAIR.length];
    const pom = i % 2 ? tr : '#ffffff', pom2 = i % 2 ? '#ffffff' : tr;
    return `<g class="bod"><path d="M-2 -9L-2.5 -.6M2 -9L2.5 -.6" stroke="${sk}" stroke-width="1.7" stroke-linecap="round"/>`
      + `<path d="M-2.6 -2.1V0M2.6 -2.1V0" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`
      + `<path d="M-3.3 -12.2H3.3L5 -8.2H-5Z" fill="${tc}"/><path d="M-4.8 -8.9H4.8" stroke="${tr}" stroke-width=".9"/>`
      + `<path d="M-3.1 -17.6H3.1L2.8 -13.4H-2.8Z" fill="${tc}"/><path d="M-2.8 -13.4H2.8V-12.2H-2.8Z" fill="${sk}"/>`
      + `<path d="M-3 -17.4L0 -14.9L3 -17.4" fill="none" stroke="${tr}" stroke-width=".8"/>`
      + `<path d="M-.7 -18.4H.7V-17.4H-.7Z" fill="${sk}"/><circle cy="-20.4" r="2.5" fill="${sk}"/>`
      + `<path d="M-2.7 -20.2A2.7 2.7 0 0 1 2.7 -20.2Q1 -22 -2.7 -20.2Z" fill="${hr}"/>`
      + `<path d="M2.2 -22.2Q5 -21.6 4.4 -17.6" fill="none" stroke="${hr}" stroke-width="1.5" stroke-linecap="round"/></g>`
      + [[-1, pom], [1, pom2]].map(([s, pc]) => `<g class="arm ${s < 0 ? 'l' : 'r'}" style="transform-origin:${2.9 * s}px -17px">`
        + `<path d="M${2.9 * s} -17L${6.4 * s} -22.4" stroke="${sk}" stroke-width="1.4" stroke-linecap="round"/>`
        + `<circle class="pom" cx="${6.8 * s}" cy="-23.1" r="2.6" fill="${pc}" stroke="${pc}"/></g>`).join('');
  }
  function mascot(c) {
    const tc = color(c), tr = trim(c);
    return `<g class="bod"><path d="M-2.6 -10V-2M2.6 -10V-2" stroke="${tc}" stroke-width="3.6" stroke-linecap="round"/>`
      + `<ellipse cx="-3.2" cy="-1.3" rx="3" ry="1.5" fill="#fff" stroke="${tr}" stroke-width=".7"/>`
      + `<ellipse cx="3.2" cy="-1.3" rx="3" ry="1.5" fill="#fff" stroke="${tr}" stroke-width=".7"/>`
      + `<rect x="-6" y="-20" width="12" height="11" rx="3.5" fill="${tr}"/>`
      + `<text y="-13.4" text-anchor="middle" dominant-baseline="central" class="mjn" fill="${tc}">${c}</text>`
      + `<path d="M-5.5 -18L-8.6 -12.5" stroke="${tc}" stroke-width="3.2" stroke-linecap="round"/></g>`
      + `<g class="arm wave" style="transform-origin:5.5px -18px"><path d="M5.5 -18L9.6 -24.5" stroke="${tc}" stroke-width="3.2" stroke-linecap="round"/>`
      + `<circle cx="9.9" cy="-25.2" r="1.9" fill="#fff"/></g>`
      + `<g class="head"><path d="M-5.6 -27.6L-6.4 -33.4L-2.4 -30.6ZM5.6 -27.6L6.4 -33.4L2.4 -30.6Z" fill="${tc}" stroke="${tr}" stroke-width=".6"/>`
      + `<circle cy="-25.6" r="6.6" fill="${tc}" stroke="${tr}" stroke-width=".8"/>`
      + `<ellipse cy="-23.2" rx="4" ry="2.8" fill="#fff" opacity=".9"/>`
      + `<circle cx="-2.4" cy="-27" r="1.7" fill="#fff"/><circle cx="2.4" cy="-27" r="1.7" fill="#fff"/>`
      + `<circle cx="-2.1" cy="-26.8" r=".85" fill="#111"/><circle cx="2.1" cy="-26.8" r=".85" fill="#111"/>`
      + `<ellipse cy="-24.2" rx="1.2" ry=".8" fill="#222"/><path d="M-1.8 -22.5Q0 -21 1.8 -22.5" fill="none" stroke="#222" stroke-width=".6" stroke-linecap="round"/></g>`;
  }
  // the stands: rows of fans seen from the field, most in the home colors, no two alike (a pattern wide enough not to
  // look tiled, shifted with the camera)
  function crowdPattern(svg, c) {
    const id = `crowd${++crowdN}`, cols = [color(c), color(c), color(c), trim(c), trim(c), '#f2f2f2', '#3a4150', '#6b7380'];
    let seed = [...c].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let dots = '';
    for (let row = 0; row < 6; row++) {
      const y = row * 5 + 2.4;
      for (let x = 1.5 + (row % 2) * 2; x < 180; x += 3.6 + rnd() * 1.6) {
        if (rnd() < 0.06) continue;          // an empty seat
        const xx = x + (rnd() - 0.5) * 0.8, yy = y + (rnd() - 0.5) * 0.7, up = rnd() < 0.12;
        dots += `<path d="M${(xx - 1.8).toFixed(2)} ${(yy + 3.3).toFixed(2)}q0 -2.2 1.8 -2.2t1.8 2.2z" fill="${cols[Math.floor(rnd() * cols.length)]}"/>`
          + `<circle cx="${xx.toFixed(2)}" cy="${yy.toFixed(2)}" r="1.15" fill="${SKIN[Math.floor(rnd() * SKIN.length)]}"/>`
          + (up ? `<path d="M${(xx - 1.4).toFixed(2)} ${(yy + 1.2).toFixed(2)}l-.6 -2.6M${(xx + 1.4).toFixed(2)} ${(yy + 1.2).toFixed(2)}l.6 -2.6" stroke="${SKIN[Math.floor(rnd() * SKIN.length)]}" stroke-width=".7" stroke-linecap="round"/>` : '');
      }
    }
    const defs = S('defs', {});
    defs.innerHTML = `<pattern id="${id}" patternUnits="userSpaceOnUse" width="180" height="30">`
      + `<rect width="180" height="30" fill="#1b2029"/><path d="M0 4.9H180M0 9.9H180M0 14.9H180M0 19.9H180M0 24.9H180M0 29.9H180" stroke="#2f3541" stroke-width="1.1"/>${dots}</pattern>`
      + `<linearGradient id="${id}s" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient>`;
    svg.append(defs);
    return id;
  }
  function drawEnds(svg, put, c, far) {
    const base = far ? 110 : -10, Lo = (o) => base + (far ? o : -o);
    const band = (o1, o2, attrs) => {
      const e = put(S('rect', { x: 0, width: 360, ...attrs }), (Y) => {
        const a = Y(Lo(o1)), b = Y(Lo(o2));
        e.setAttribute('y', Math.min(a, b).toFixed(1)); e.setAttribute('height', Math.abs(a - b).toFixed(1));
      });
      return e;
    };
    band(0, 4.2, { fill: 'rgba(0,0,0,.14)', class: 'apron' });
    band(0, 0.65, { fill: 'rgba(255,255,255,.82)' });        // the white border past the end line
    const id = crowdPattern(svg, c), pat = svg.querySelector(`#${id}`);
    const st = put(S('rect', { x: 0, width: 360, fill: `url(#${id})` }), (Y) => {
      const a = Y(Lo(5.6)), b = Y(Lo(90));
      st.setAttribute('y', Math.min(a, b).toFixed(1)); st.setAttribute('height', Math.abs(a - b).toFixed(1));
      pat.setAttribute('patternTransform', `translate(0 ${a.toFixed(1)})`);     // the rows ride with the camera
    });
    // (deeper in the stands, the upper rows in the shade of the deck above)
    const sh = put(S('rect', { x: 0, width: 360, fill: `url(#${id}s)` }), (Y) => {
      const a = Y(Lo(5.6)), b = Y(Lo(30));
      sh.setAttribute('y', Math.min(a, b).toFixed(1)); sh.setAttribute('height', Math.abs(a - b).toFixed(1));
      sh.setAttribute('transform', far ? `rotate(180 180 ${((a + b) / 2).toFixed(1)})` : '');
    });
    const deck = put(S('rect', { x: 0, width: 360, fill: 'rgba(0,0,0,.55)' }), (Y) => {
      const a = Y(Lo(30)), b = Y(Lo(90));
      deck.setAttribute('y', Math.min(a, b).toFixed(1)); deck.setAttribute('height', Math.abs(a - b).toFixed(1));
    });
    band(4.2, 5.6, { fill: color(c), class: 'wall' });
    const lip = put(S('line', { x1: 0, x2: 360, stroke: trim(c), 'stroke-width': 1.2 }), (Y) => { const y = Y(Lo(far ? 5.6 : 4.2)); lip.setAttribute('y1', y); lip.setAttribute('y2', y); });
    [60, 180, 300].forEach((x) => {
      const t = put(S('text', { x, class: 'wallname', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, teamShort(c).toUpperCase()),
        (Y) => { const a = Y(Lo(4.2)), b = Y(Lo(5.6)); t.setAttribute('y', ((a + b) / 2).toFixed(1)); t.style.fontSize = `${clip(Math.abs(a - b) * 0.62, 3.5, 7).toFixed(1)}px`; });
    });
    // the squad on the turf in front of the wall, the mascot between them behind the goalpost
    const feet = far ? 1.6 : 3.9;
    const fig = (x, html, cls, big, i) => {
      const g = put(S('g', { class: cls }), (Y) => {
        const k = Math.abs(Y(0) - Y(1)), s = (clip(k * 2.5, 13, 30) / 24) * big;
        g.setAttribute('transform', `translate(${x} ${Y(Lo(feet)).toFixed(1)}) scale(${s.toFixed(3)})`);
      });
      g.innerHTML = `<ellipse class="shadow" cx="1.5" cy="0" rx="${big > 1 ? 7 : 5.2}" ry="1.4" fill="rgba(0,0,0,.28)"/>${html}`;
      g.style.setProperty('--d', `${((i * 0.37) % 0.9).toFixed(2)}s`);
      return g;
    };
    CHEER_X.forEach((x, i) => fig(far ? x : 360 - x, cheerleader(c, i + (far ? 0 : 3)), 'cheer', 1, i));
    fig(far ? 214 : 146, mascot(c), 'cheer mascot', 1.25, 2);
  }
  // end zones painted their own way (team code: the second color of its checkerboard over the team's own)
  const EZ_CHECKER = { TENN: '#ffffff' };
  const camY = (sc) => { const { lo, hi } = sc.cam, k = (sc.H - 6) / (hi - lo); return (L) => sc.H - 3 - (L - lo) * k; };

  // the field and the 22 for state r (side: the strong side of this snap); place() draws them for the camera
  function makeScene(r, side, look = r.pos === G.me ? G.look : null, mo) {
    const svg = $('field'), H = fieldHeight();
    svg.setAttribute('viewBox', `0 0 360 ${H}`);
    svg.textContent = '';
    svg.classList.remove('playing');
    // (passing: the field takes the finger, so a drag from a receiver draws instead of scrolling)
    svg.classList.toggle('drawing', !!(passing() && ui.pass));
    const sc = { svg, H, r, cam: { ...FULL }, parts: [], actors: [], calls: [] };
    const put = (el, upd) => { svg.append(el); if (upd) sc.parts.push(upd); return el; };
    put(S('rect', { x: 0, y: 0, width: 360, height: H, fill: 'var(--turf)' }));
    for (let L = 0; L < 100; L += 10) {
      const e = put(S('rect', { x: 0, width: 360, fill: 'var(--turf-2)' }), (Y) => { e.setAttribute('y', Y(L + 5)); e.setAttribute('height', Math.max(0, Y(L) - Y(L + 5))); });
    }
    [[100, 110, code(1 - G.me)], [-10, 0, code(G.me)]].forEach(([a, b, c]) => {
      // (a checkerboard end zone is painted inside its lines only: the turf past the sidelines stays green)
      const ex = EZ_CHECKER[c] ? { x: SX0, width: SX1 - SX0 } : { x: 0, width: 360 };
      const e = put(S('rect', { ...ex, fill: color(c), opacity: EZ_CHECKER[c] ? 1 : 0.92 }), (Y) => { e.setAttribute('y', Y(b)); e.setAttribute('height', Math.max(0, Y(a) - Y(b))); });
      // (a home end zone painted its own way, as at the stadium: Tennessee's orange and white checkerboard, Neyland)
      if (EZ_CHECKER[c]) {
        const id = `ck-${c}-${a}`, pat = S('pattern', { id, patternUnits: 'userSpaceOnUse' }), w1 = S('rect', { fill: EZ_CHECKER[c] }), w2 = S('rect', { fill: EZ_CHECKER[c] });
        pat.append(w1, w2);
        const defs = S('defs', {});
        defs.append(pat);
        put(defs);
        // (inside the end zone only: sideline to sideline and goal line to end line, four rows of whole squares and as
        // many whole columns as fit the width, so none is cut at an edge)
        const ck = put(S('rect', { x: SX0, width: SX1 - SX0, fill: `url(#${id})` }), (Y) => {
          const y0 = Math.min(Y(a), Y(b)), h = Math.abs(Y(a) - Y(b)), rh = Math.max(h / 4, 1);
          const cols = Math.max(2, Math.round((SX1 - SX0) / rh)), cw = (SX1 - SX0) / cols;
          ck.setAttribute('y', y0); ck.setAttribute('height', h);
          pat.setAttribute('x', SX0); pat.setAttribute('y', y0);
          pat.setAttribute('width', 2 * cw); pat.setAttribute('height', 2 * rh);
          [w1, w2].forEach((x) => { x.setAttribute('width', cw); x.setAttribute('height', rh); });
          w2.setAttribute('x', cw); w2.setAttribute('y', rh);
        });
      }
      // (dy: nudged along its end zone, clear of the buttons over the field: ezClear)
      const t = put(S('text', { x: 180, class: `ez${darkOn(color(c)) ? ' dk' : ''}`, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, teamName(c).toUpperCase()), (Y) => {
        const lo = Math.min(Y(a), Y(b)), hi = Math.max(Y(a), Y(b)), dy = +t.dataset.dy || 0;
        t.setAttribute('y', (dy ? clip((lo + hi) / 2 + dy, lo + 10, Math.max(lo + 10, hi - 10)) : (lo + hi) / 2).toFixed(1));
      });
      t.upd = sc.parts[sc.parts.length - 1];
    });
    drawEnds(svg, put, code(1 - G.me), true);
    drawEnds(svg, put, code(G.me), false);
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
    [SX0, SX1].forEach((x) => {      // the sidelines, end line to end line
      const e = put(S('line', { x1: x, x2: x, stroke: 'var(--chalk)', 'stroke-width': 1.6 }), (Y) => { e.setAttribute('y1', Y(110)); e.setAttribute('y2', Y(-10)); });
    });
    for (let L = 10; L <= 90; L += 10) {
      const n = String(L <= 50 ? L : 100 - L);
      [[SX0 + 9, -90], [SX1 - 9, 90]].forEach(([x, rot]) => {
        const e = put(S('text', { x, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, n),
          (Y) => { const y = Y(L); e.setAttribute('y', y); e.setAttribute('transform', `rotate(${rot} ${x} ${y})`); });
      });
    }
    const { L, dir, mode } = spotGeom(r);
    Object.assign(sc, { losL: L, dir, mode });
    sc.cover = covers();
    sc.cam = preCam(H, L, dir, mode, sc.cover, 360 / (svg.parentElement.clientWidth || 360));
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
      const offI = r.pos, f = formation(offLineup(offI).slice(), lineup(1 - offI).def.slice(), s, fxBall, offI === G.me ? G.form : null);
      if (mode === 'snap' && look != null) showLook(f.def, LOOKS[look], s, fxBall);
      else if (mode === 'snap' && r.pos !== G.me && ui.step === 'vdef' && ui.dc) showDc(f.def, ui.dc, s, fxBall);
      // a short field: the defense lines up inside its end zone, the offense inside its own (the dots are drawn a step
      // off the ball, GAP, as well)
      const gapYd = GAP / ((H - 6) / (sc.cam.hi - sc.cam.lo));
      [[f.def, dir > 0 ? FULL.hi - L : L - FULL.lo], [f.off, dir > 0 ? L - FULL.lo : FULL.hi - L]].forEach(([list, room]) => {
        const deepest = Math.max(...list.map((o) => o.d));
        list.forEach((o) => { o.d = Motion.squeeze(o.d, deepest, room - gapYd); });
      });
      const add = (o, teamI, off) => {
        const team = code(teamI), mine = teamI === G.me;
        const num = o.p.num != null ? String(o.p.num) : '';
        const g = S('g', { class: `dot ${mine ? 'me' : 'them'}`, tabindex: 0, role: 'button',
          'aria-label': `${teamName(team)} ${POS_NAME[o.label] || o.label} ${num ? `#${num} ` : ''}${o.p.name}, rated ${o.p.ovr}` });
        g.append(S('circle', { class: 'hit', r: 11 }), S('circle', { class: 'c', r: 7.2, fill: rate(o.p.ovr) }));
        if (num) { const t = S('text', { class: 'jn', y: 2.6 }); t.textContent = num; g.append(t); }
        const open = (ev) => { if (!dotTap(ev) || (passing() && off && (o.label === 'WR' || o.label === 'TE' || o.label === 'RB'))) return; playerInfo(o.p, o.label, team); };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (!passTap(a)) open(); } });
        sc.layer.append(g);
        const a = { g, p: o.p, label: o.label, team, teamI, off, x0: sx(o.x), L0: L + (off ? -dir : dir) * o.d, side: off ? dir : -dir };
        Object.assign(a, { x: a.x0, L: a.L0, w: 1, xf: a.x0 });
        sc.actors.push(a);
      };
      f.def.forEach((o) => add(o, 1 - offI, false));
      f.off.forEach((o) => add(o, offI, true));
      sc.named = true;
      if (mode === 'snap') applyMotion(sc, mo === undefined ? curMotion(r) : mo);
    }
    if (mode === 'kick') kickoffUnits(sc, r, L, dir);
    const ball = S('g', {}), inner = S('g', { class: 'ballmove' }), lift = S('g', {});
    const shadow = S('ellipse', { cx: 0, cy: 0, rx: 3.6, ry: 2.6, fill: '#000', opacity: 0 });
    lift.append(S('ellipse', { cx: 0, cy: 0, rx: 3.4, ry: 5.2, fill: 'var(--ball)', stroke: 'rgba(255,255,255,.75)', 'stroke-width': 0.8 }));
    inner.append(shadow, lift);
    ball.append(inner);
    svg.append(ball);
    sc.ball = { g: ball, inner, lift, shadow, x: sc.bx, L, z: 0, up: 0, show: true };
    sc.callLayer = put(S('g', {}));
    if (mode === 'kick') showCall(sc, { text: r.free_kick ? 'Free kick' : 'Kickoff', kind: 'info', slot: 0, x: 180, L: L + dir * 7 });
    // (a motion's read, over the man in motion until the snap)
    if (sc.mo) showCall(sc, { text: sc.mo.cov === 'man' ? `Man: ${sc.mo.d && sc.mo.d.p ? shortName(sc.mo.d.p.name) : 'he'} follows` : 'Zone: nobody follows', kind: 'info', slot: 0, follow: sc.mo.a });
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

  // Pre-snap motion you call: swipe a receiver, tight end or back sideways behind the line (readMotion) and he goes in
  // motion to that spot; the play runs from there. The defense shows its hand: in man, the man on him goes with him
  // across the formation; in zone, nobody follows and the linebackers and safeties slide a step or two over. The
  // coverage is decided right then (the snap's own draw, at the man share real defenses play against the look shown:
  // MAN_SHARE, NGS charting) and the snap is a real play run in it (act.cov: engine.js _covOk), so the read is real
  const MAN_SHARE = [0.31, 0.54, 0.32, 0.55];     // light box, light + blitz, loaded, loaded + blitz (charted passes)
  const MOTION_MIN = 2.5;                          // yards across it takes to be a motion
  const rootKey = (r) => `${r.t}|${r.yl}|${r.down}|${r.pos}|${r.score}`;
  const actorKey = (a) => `${a.label}:${Math.round(a.xf ?? a.x0)}`;
  const curMotion = (r) => (G && G.mo && !VS && G.mo.rk === rootKey(r) ? G.mo : null);
  function motionMoves(sc, mo) {
    const a = mo && sc.actors.find((x) => x.off && actorKey(x) === mo.key);
    if (!a) return [];
    const dx = mo.x - a.xf, out = [[a, mo.x]];
    if (mo.cov === 'man') {
      const d = sc.actors.find((x) => !x.off && actorKey(x) === mo.dk);
      if (d) out.push([d, clampX(d.xf + dx)]);
    } else {
      const sl = clip(dx * 0.3, -2 * XYD, 2 * XYD);
      sc.actors.filter((x) => !x.off && (x.label === 'S' || x.label === 'LB')).forEach((d) => out.push([d, clampX(d.xf + sl)]));
    }
    return out;
  }
  function applyMotion(sc, mo) {
    const mv = motionMoves(sc, mo);
    if (!mv.length) return;
    mv.forEach(([a, x]) => { a.x0 = a.x = x; });
    // (the man in motion: a yard off the line, as the rules have him, clear of his own men)
    const a = mv[0][0];
    if (Math.abs(a.L0 - sc.losL) < 1.6) a.L0 = a.L = sc.losL - sc.dir * 1.6;
    sc.mo = { a, d: mo.cov === 'man' && mv[1] ? mv[1][0] : null, cov: mo.cov };
  }
  // a line from a receiver, tight end or back that stays behind the line and goes across: the spot he motions to
  // ([across] yards), or null (a route, a run, a tap)
  function readMotion(sc, a, field) {
    if (!['WR', 'TE', 'RB', 'FB'].includes(a.label)) return null;
    const { pts, run } = lineOf(sc, a, field);
    if (run < MOTION_MIN) return null;
    const p0 = pts[0], end = pts[pts.length - 1], across = Math.abs(end[0] - p0[0]);
    if (Math.max(...pts.map((p) => p[1])) > Math.max(0.4, p0[1] + 0.6)) return null;      // (past the line: a route or a run)
    if (Math.max(...pts.map((p) => Math.abs(p[1] - p0[1]))) > 2.2 || across < MOTION_MIN || across < run * 0.75) return null;
    return { x: end[0] };
  }
  function setMotion(a, xYd) {
    const sc = scene, r = G.root;
    let x = clampX(SX0 + xYd * XYD);
    // (never on top of another man of his: stopped a step short, the side he came from)
    const back = Math.sign(a.xf - x) || 1;
    for (let k = 0; k < 8 && sc.actors.some((o) => o.off && o !== a && Math.abs(o.xf - x) < 1.4 * XYD && Math.abs(o.L0 - sc.losL) < 2.4); k++) x = clampX(x + back * 0.7 * XYD);
    if (Math.abs(x - a.xf) < MOTION_MIN * XYD * 0.8) return;
    const pMan = G.look != null ? MAN_SHARE[G.look] : 0.35;
    const cov = (hash('cov', seedKey(), G.si, G.seq) % 1000) / 1000 < pMan ? 'man' : 'zone';
    // (in man, his man: the defensive back or linebacker nearest where he lined up)
    const d = cov === 'man' ? sc.actors.filter((o) => !o.off && ['CB', 'S', 'LB'].includes(o.label))
      .sort((p, q) => Math.hypot(p.xf - a.xf, (p.L0 - a.L0) * XYD) - Math.hypot(q.xf - a.xf, (q.L0 - a.L0) * XYD))[0] : null;
    G.mo = { rk: rootKey(r), key: actorKey(a), x, cov, dk: d ? actorKey(d) : null };
    track('motion', { mode: modeName(), cov, pos: a.label });
    const who = a.p ? shortName(a.p.name) : a.label, dn = d && d.p ? shortName(d.p.name) : 'a defender';
    const text = cov === 'man' ? `Man: ${dn} goes with him` : 'Zone: nobody follows';
    // (he jogs over, the defense with him; then the field is drawn again with everyone there)
    const moves = motionMoves(sc, G.mo).map(([m, x1]) => [m, m.x, x1]), T = reduced() ? 0 : 900;
    let t0 = null;
    const step = (now) => {
      if (scene !== sc) return;
      if (t0 === null) t0 = now;
      const u = T ? EASE.io(clip((now - t0) / T, 0, 1)) : 1;
      moves.forEach(([m, xa, xb]) => { m.x = xa + (xb - xa) * u; });
      place(sc);
      if (u < 1) requestAnimationFrame(step);
      else { drawField(); drawDock(); toast(`${who} in motion. ${text}.`, true); }
    };
    requestAnimationFrame(step);
  }
  function place(sc) {
    const Y = camY(sc);
    sc.parts.forEach((f) => f(Y));
    // (on the field, inside both end lines: never drawn over the stands behind them)
    const yIn = [Y(FULL.hi - 0.5), Y(FULL.lo + 0.5)];
    sc.actors.forEach((a) => a.g.setAttribute('transform', `translate(${a.x.toFixed(1)},${clip(Y(a.L) + a.side * GAP * a.w, yIn[0], yIn[1]).toFixed(1)})`));
    const b = sc.ball;
    if (b) {
      // (on the ground where it is; in the air, the ball over its shadow by its height, and bigger as it comes up)
      const up = b.up || 0;
      b.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${Y(b.L).toFixed(1)})`);
      b.lift.setAttribute('transform', `translate(0,${(-up).toFixed(1)}) scale(${(1 + 0.35 * b.z).toFixed(2)})`);
      b.shadow.setAttribute('opacity', up > 0.4 ? clip(0.45 - up * 0.012, 0.25, 0.45).toFixed(2) : 0);
      b.g.style.opacity = b.show ? 1 : 0;
    }
    // (a call-out stays clear of the scoreboard over the field's top on a phone: under the man it follows, if need be)
    const top = 18 + (bcast() ? PLAY_COVER.top * (360 / (sc.svg.parentElement.clientWidth || 360)) : 0);
    sc.calls.forEach((c) => {
      const at_ = c.follow ? { x: c.follow.x, L: c.follow.L } : c;
      let y = c.below ? Y(at_.L) + 32 + c.slot * 30 : Y(at_.L) - 26 - c.slot * 30;
      if (y < top && (c.follow || c.below === false)) y = Y(at_.L) + 26 + c.slot * 30;
      let x = clip(at_.x, c.w / 2 + 6, 354 - c.w / 2);
      // (beside the spot instead, on its side: a miss's call clear of the man and the ball; the other side at the edge)
      if (c.side) {
        y = Y(at_.L) - c.slot * 30;
        x = at_.x + c.side * (c.w / 2 + 16);
        if (x - c.w / 2 < 6 || x + c.w / 2 > 354) x = at_.x - c.side * (c.w / 2 + 16);
        x = clip(x, c.w / 2 + 6, 354 - c.w / 2);
      }
      y = clip(y, top, sc.H - 18);
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
  // Pass concepts: a playbook's names for routes run together, one tap for every receiver's route by where he lines up
  // (the widest receiver on each side first, then the slots inside him, the tight end, the back). A player said the
  // passes all felt like one concept and drawing your own was beyond most players. The throw plays as always: the real
  // throws on the route of the man it goes to; the line under each is what the concept is built to beat (its men's
  // routes are the reason, nothing is added to the odds)
  const CONCEPTS = [
    { k: 'verts', tag: 'vs Cover 3', name: 'Four Verticals', beats: 'Cover 3: four deep threats for three deep defenders',
      r: (o) => (o.pos === 'RB' ? 'flat' : 'go') },
    { k: 'smash', tag: 'vs Cover 2', name: 'Smash', beats: 'Cover 2: a hitch under a corner route, the cornerback can take one',
      r: (o) => (o.pos === 'RB' ? 'flat' : o.pos === 'TE' ? 'corner' : o.rank === 0 ? 'hitch' : 'corner') },
    { k: 'flood', tag: 'vs Cover 3', name: 'Flood', beats: 'Cover 3: deep, middle and flat to one sideline, three men against two',
      r: (o) => (o.pos === 'RB' ? 'flat' : !o.strong ? (o.pos === 'TE' ? 'cross' : 'in') : o.pos === 'TE' ? 'out' : o.rank === 0 ? 'go' : 'deep_out') },
    { k: 'mesh', tag: 'vs man', name: 'Mesh', beats: 'Man coverage: two shallow crossers rub their defenders off each other',
      r: (o) => (o.pos === 'RB' ? 'angle' : o.pos === 'TE' || o.rank > 0 || o.crosser ? 'cross' : 'go') },
    { k: 'slants', tag: 'vs blitz', name: 'Slants', beats: 'Press and the blitz: out quick, inside the cornerback',
      r: (o) => (o.pos === 'RB' ? 'flat' : o.pos === 'TE' ? 'hitch' : 'slant') },
    { k: 'stick', tag: 'short yardage', name: 'Stick', beats: 'Zone, short yardage: a quick stop at 5 with the flat beside it',
      r: (o) => (o.pos === 'RB' ? 'flat' : o.pos === 'TE' || o.rank > 0 ? 'hitch' : 'go') },
    { k: 'dagger', tag: 'vs Cover 2/3', name: 'Dagger', beats: 'Cover 3 and 2: the seam clears the middle, the dig comes in under it',
      r: (o) => (o.pos === 'RB' ? 'angle' : o.pos === 'TE' ? 'cross' : !o.strong ? 'hitch' : o.rank === 0 ? 'in' : 'go') },
    { k: 'shot', tag: 'vs one safety', name: 'Post-Wheel', beats: 'One deep safety: a post down the middle, the back wheels up the sideline',
      r: (o) => (o.pos === 'RB' ? 'wheel' : o.pos === 'TE' ? 'in' : o.rank === 0 && o.strong ? 'post' : o.rank === 0 ? 'go' : 'in') },
    { k: 'outs', tag: 'stops the clock', name: 'Sideline', beats: 'The clock: every route ends at the sideline, out of bounds after the catch',
      r: (o) => (o.pos === 'RB' ? 'flat' : o.pos === 'TE' ? 'out' : o.rank === 0 ? 'out' : 'corner') },
  ];
  // the concept that fits the spot (spotKind), first in the list
  const CONCEPT_FIT = { goal: 'slants', sideline: 'outs', short: 'stick', long: 'dagger' };
  function conceptRoutes(sc, c) {
    const E = eligibles(sc), st = sc.s * sc.dir;
    const wr = E.filter((a) => a.label === 'WR');
    const roleOf = (a) => {
      const sd = Math.sign(a.x0 - sc.bx) || st, same = wr.filter((w) => (Math.sign(w.x0 - sc.bx) || st) === sd).sort((x, y) => Math.abs(y.x0 - sc.bx) - Math.abs(x.x0 - sc.bx));
      return { pos: a.label, strong: sd === st, rank: Math.max(0, same.indexOf(a)), inside: same.length > 1 };
    };
    const roles = E.map(roleOf);
    // (Mesh: two crossers; a set with one man inside sends the backside's widest across too)
    if (c.k === 'mesh' && roles.filter((o) => o.pos === 'TE' || (o.pos === 'WR' && o.rank > 0)).length < 2) {
      const w = roles.find((o) => o.pos === 'WR' && o.rank === 0 && !o.strong) || roles.find((o) => o.pos === 'WR' && o.rank === 0);
      if (w) w.crosser = true;
    }
    return roles.map((o) => c.r(o));
  }
  // the concept set, and whether you have changed a route of it since (a tap on a man, or one drawn: your edit stands)
  const conceptNow = (sc) => {
    const P = ui.pass, c = CONCEPTS.find((x) => P.concept === x.k);
    return c ? { c, edited: !conceptRoutes(sc, c).every((r, i) => P.routes[i] === r && !(P.drawn && P.drawn[i])) } : null;
  };
  function applyConcept(c) {
    const sc = scene, P = ui.pass;
    if (busy || !passing() || !sc) return;
    const rs = conceptRoutes(sc, c);
    (P.hist = P.hist || []).push(...rs.map((_, i) => [i, P.routes[i], (P.drawn && P.drawn[i]) || null]).filter((h, i) => h[1] !== rs[i] || h[2]));
    P.routes = rs; P.drawn = []; P.concept = c.k; P.draw = false;
    track('pass_concept', { concept: c.k });
    closeModal();
    redrawPass();
  }
  // each concept drawn small from where your receivers line up now
  function conceptCard(sc, c, fit) {
    const b = el('button', `concept${fit ? ' fit' : ''}`);
    b.type = 'button'; b.dataset.concept = c.k;
    const W = 150, H = 92, L0 = sc.losL, top = 26, xs = (x) => ((x - SX0) / XYD / 53.333) * W;
    const ys = (L) => H - 14 - (sc.dir * (L - L0) / top) * (H - 20);
    const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'cdiag' });
    svg.append(S('line', { x1: 0, x2: W, y1: ys(L0), y2: ys(L0), class: 'los' }));
    const rs = conceptRoutes(sc, c), stay = protOn() ? protMen(sc, G.prot) : [];
    eligibles(sc).forEach((a, i) => {
      const x0 = xs(a.x0), y0 = ys(a.L0);
      svg.append(S('circle', { cx: x0.toFixed(1), cy: y0.toFixed(1), r: 3.2, class: a.label === 'WR' ? 'wr' : 'oth' }));
      if (stay.includes(a)) return;
      const r = Motion.routeOnField(rs[i], ROUTE_DEPTH[rs[i]], (a.x0 - SX0) / XYD, outOf(sc, a), sc.dir, L0, Math.abs(a.L0 - L0), 0.5);
      const pts = [[x0, y0]].concat(r.pts.map((q) => [clip((q[0] / 53.333) * W, 2, W - 2), clip(ys(q[1]), 2, H - 2)]));
      svg.append(S('path', { d: pts.map((q, k) => `${k ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(''), class: 'rt' }));
    });
    b.append(svg, el('b', '', c.name), el('small', 'long', c.beats), el('small', 'tag', c.tag));
    b.title = c.beats;
    if (fit) b.append(el('span', 'fitTag', 'Fits now'));
    b.setAttribute('aria-label', `${c.name}: ${rs.map((r, i) => `${eligibles(sc)[i].label} ${routeName(eligibles(sc)[i].label, r)}`).join(', ')}. Beats ${c.beats}`);
    b.addEventListener('click', () => applyConcept(c));
    return b;
  }
  function openConcepts() {
    const sc = scene;
    if (busy || !passing() || !sc) return;
    const fitK = CONCEPT_FIT[spotKind(G.root)], list = CONCEPTS.slice().sort((a, b) => (b.k === fitK) - (a.k === fitK));
    const grid = el('div', 'concepts');
    list.forEach((c) => grid.append(conceptCard(sc, c, c.k === fitK)));
    const own = el('button', 'concept own');
    own.type = 'button';
    own.append(el('b', '', '✏️ Draw your own'), el('small', 'long', 'Drag a receiver on the field where he should go'), el('small', 'tag', 'on the field'));
    own.addEventListener('click', () => { closeModal(); setDraw(true); });
    grid.append(own);
    track('concepts_open', {});
    openModal('Pass plays', [el('p', 'note', 'One tap sets every route. Then throw to the open man, or pick who gets it.'), grid]);
  }
  // toward his own sideline; the same on the field and in the animation
  const outOf = (sc, a) => Math.sign(a.x0 - sc.bx) || sc.s * sc.dir || 1;
  // ... but the back's route on a rollout goes the way the quarterback rolls (players saw the flat run away from him,
  // the throw back across the field): the side drawn for him, else the back's own
  const routeOut = (sc, a) => (a.label === 'RB' && ui.pass && ui.pass.roll && ui.pass.rollSide ? (ui.pass.rollSide === 'strong' ? 1 : -1) * sc.s * sc.dir : outOf(sc, a));
  function drawRoutes(sc) {
    const P = ui.pass, E = eligibles(sc), Y = camY(sc), g = S('g', { class: 'routes' });
    sc.routePts = [];
    const st = protOn() ? protMen(sc, G.prot) : [];
    E.forEach((a, i) => {
      const rt = P.routes[i], dr = P.drawn && P.drawn[i];
      if (st.includes(a)) {                // (kept in to block: a short T toward the line, no route)
        const x = a.x0, y0 = Y(a.L0), y1 = Y(a.L0 + sc.dir * 1.6);
        sc.routePts[i] = [[x, y0], [x, y1]];
        g.append(S('path', { class: 'route block', d: `M${x.toFixed(1)} ${y0.toFixed(1)}L${x.toFixed(1)} ${y1.toFixed(1)}M${(x - 6).toFixed(1)} ${y1.toFixed(1)}L${(x + 6).toFixed(1)} ${y1.toFixed(1)}` }));
        a.g.setAttribute('aria-label', `${a.g.getAttribute('aria-label')}: blocking`);
        return;
      }
      const r = Motion.routeOnField(dr || rt, ROUTE_DEPTH[rt], (a.x0 - SX0) / XYD, routeOut(sc, a), sc.dir, sc.losL, Math.abs(a.L0 - sc.losL), 0.5);
      const pts = r.pts.map((q) => [clip(SX0 + q[0] * XYD, SX0 + 2, SX1 - 2), Y(clip(q[1], -9, 109))]);
      sc.routePts[i] = [[a.x0, Y(a.L0)], ...pts];
      const tgt = P.target === i, d = pts.map((q, k) => `${k ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
      if (tgt || dr) g.append(S('path', { class: 'route halo', d }));
      g.append(S('path', { class: `route${tgt ? ' tgt' : ''}${dr ? ' drawn' : ''}`, d }));
      if (P.draw && P.sel === i) { a.g.classList.add('sel'); g.append(S('circle', { class: 'selring', cx: a.x0, cy: Y(a.L0), r: 13 })); }
      const e = pts[pts.length - 1], q = pts[pts.length - 2], ang = Math.atan2(e[1] - q[1], e[0] - q[0]);
      const head = [[e[0], e[1]], [e[0] - 6 * Math.cos(ang - 0.5), e[1] - 6 * Math.sin(ang - 0.5)], [e[0] - 6 * Math.cos(ang + 0.5), e[1] - 6 * Math.sin(ang + 0.5)]];
      g.append(S('path', { class: `route-head${tgt ? ' tgt' : ''}${dr ? ' drawn' : ''}`, d: `M${head.map((h) => h.map((v) => v.toFixed(1)).join(' ')).join('L')}Z` }));
      if (tgt) a.g.classList.add('target');
      a.g.setAttribute('aria-label', `${a.g.getAttribute('aria-label')}: ${dr ? `a drawn ${routeName(a.label, rt)}` : routeName(a.label, rt)}${tgt ? ', the target' : ''}${P.draw ? '' : '. Enter: his next route'}`);
    });
    sc.svg.insertBefore(g, sc.layer);
  }
  // a tap on a receiver while you pick a pass: throw to him, or (already him) his next route
  // a tap on a receiver on the field: his next route (any receiver: set them all up, then pick who gets the ball).
  // The page stays where it is, so the field and every route stay in view while you tap
  function passTap(a) {
    if (busy || !passing() || !scene || !a.off) return false;
    const i = eligibles(scene).indexOf(a);
    if (i < 0 || blocks(scene, i)) return false;
    const list = ROUTES[a.label], P = ui.pass;
    if (P.draw) { P.sel = P.sel === i ? null : i; redrawPass(); return true; }
    P.drawn = P.drawn || [];
    (P.hist = P.hist || []).push([i, P.routes[i], P.drawn[i] || null]);
    const was = P.drawn[i] ? -1 : list.indexOf(P.routes[i]);          // from a drawn route: the first on the list
    P.drawn[i] = null;
    P.routes[i] = list[(was + 1) % list.length];
    redrawPass();
    return true;
  }
  function undoRoute() {
    if (busy || !passing()) return;
    const P = ui.pass, h = P && P.hist && P.hist.pop();
    if (!h) return;
    if (h[0] === 'qb') { P.qb = h[1]; P.roll = h[2]; P.rollSide = h[3]; redrawPass(); return; }      // (his drop or rollout)
    P.routes[h[0]] = h[1];
    (P.drawn = P.drawn || [])[h[0]] = h[2] || null;
    redrawPass();
  }
  // each receiver's odds on his current route, from the real plays it would draw (worker 'odds'), cached per snap
  const routeAt = (a) => (Number.isFinite(a.depth) ? `${a.route}@${a.depth}` : a.route);     // (engine.js routeOfAct)
  // (with what else the snap draws by: the repeats, personnel, formation, backs and motion read, engine.js routeOdds)
  function pickKey(a) { return `${a.call}|${routeAt(a)}|${a.who}|${a.looks}|${a.rep || 0}|${a.pers || 0}|${a.form || ''}|${a.bf ?? ''}|${a.cov || ''}|${a.oob ? 1 : 0}|${a.prot || ''}`; }
  async function fetchOdds() {
    if (!passing() || !scene) return;
    G.odds = G.odds || {};
    const picks = eligibles(scene).map((_, i) => (blocks(scene, i) ? null : passOption(scene, i, false).action)).filter((a) => a && !(pickKey(a) in G.odds));
    if (!picks.length) return;
    picks.forEach((a) => { G.odds[pickKey(a)] = null; });
    try {
      const res = await send({ type: 'odds', scen: simScen(), root: G.root, picks: picks.map((a) => ({ call: a.call, route: routeAt(a), who: a.who, looks: a.looks, rep: a.rep, pers: a.pers, form: a.form, bf: a.bf, cov: a.cov, oob: a.oob, prot: a.prot })) }, true);
      picks.forEach((a, k) => { G.odds[pickKey(a)] = res.out[k]; });
    } catch (e) { picks.forEach((a) => { delete G.odds[pickKey(a)]; }); return; }      // asked again on the next redraw
    // into the cards already up, not a redrawn dock: a redraw between a finger's down and up would eat the throw
    if (passing() && !busy) {
      $('dock').querySelectorAll('button.rcv').forEach((b) => {
        const od = G.odds[b.dataset.k];
        if (!od || b.querySelector('.od')) return;
        b.append(oddsEl(od));
      });
      snapLine();
    }
  }
  // (per snap, as the snap draws it: the sacks, scrambles and throwaways count, engine.js routeOdds)
  const oddsText = (o) => (o ? `${Math.round(o.caught * 100)}% caught · ${o.yds.toFixed(1)} yds a play${o.picks >= 0.03 ? ` · ${Math.round(o.picks * 100)}% picked` : ''}${o.nt >= 0.05 ? ` · ${Math.round(o.nt * 100)}% sacked, scrambles or thrown away` : ''}` : '');
  // on a receiver's row: in full, or on a phone the numbers only ("58% · 9.1 yds", game.html), the words in its title
  function oddsEl(o) {
    const s = el('span', 'od');
    s.title = oddsText(o);
    s.append(el('b', '', `${Math.round(o.caught * 100)}%`), el('i', '', ' caught'), ` · ${o.yds.toFixed(1)} yds`, el('i', '', ' a play'));
    if (o.picks >= 0.03) s.append(el('span', 'pk', ` · ${Math.round(o.picks * 100)}% picked`));
    return s;
  }
  // the field takes the tap itself (phones do not always send taps on small SVG shapes): a quick touch, not a scroll,
  // anywhere near a receiver's dot or along his route changes that route
  let routeTapAt = 0;                 // when the field last used a tap for a route (the dot under it then stays shut)
  // A tap meant for the play (tapping it to its end, or the second tap of a double tap as it ends) lands on whatever
  // the screen shows once it is over: a player's dot, the scoreboard, the buttons on the field, the calls' sheet's grip
  // as the sheet slides back up. For a moment after a play none of those take a tap (a player's card or the game's
  // details came up over the result, the sheet went down with the next call's keys on it); the calls themselves always
  // do (a call cuts a replay short), and so does a keyboard
  const AFTER_PLAY_MS = 500;
  let playEnd = -1e9;                 // when the last play's animation ended (performance.now)
  let fieldPress = null;              // the last press on the field: where it went down, how far it went (px)
  // a player's card from his dot: a tap of its own, not the end of a drag or a drawing, not during a play
  const dotTap = (ev) => !(Date.now() - routeTapAt < 600 || $('field').classList.contains('playing') || (ev && ev.detail && fieldPress && fieldPress.far > 10));
  // a phone: the call's keys (Run, Pass, RPO, Trick, or the defense's) in sight under the thumbs, no scrolling. When the
  // last result, the stop note, the defense's look and the tempo push them past the sheet's edge, those fold a step at
  // a time (game.html .fit1-3; a tap on the result shows it all); past that the sheet scrolls to them. The sheet's
  // height, and so the field's framing (covers), follows as before.
  let fitKeys = null;
  function fitDock(k) {
    fitKeys = k;
    if (!k || !k.isConnected) return;
    k.classList.remove('fit1', 'fit2', 'fit3');
    if (!bcast()) return;
    const d = $('dock'), over = () => k.getBoundingClientRect().bottom - d.getBoundingClientRect().bottom;
    for (let i = 1; i <= 3 && over() > 0.5; i++) k.classList.add(`fit${i}`);
    if (over() > 0.5) d.scrollTop += Math.ceil(over());
  }
  // the calls' sheet (broadcast view): drag its grip down to a bar to see the whole field, up (or tap it) for the calls;
  // the field frames the play again in what then shows
  function sheetDown(on) {
    const sh = $('sheet');
    if (!sh || on === sh.classList.contains('down')) return;
    sh.classList.toggle('down', on);
    $('grip').setAttribute('aria-expanded', String(!on));
    track('sheet', { down: on });
  }
  function sheetSetup() {
    const sh = $('sheet'), grip = $('grip');
    let drag = null, moved = false;
    // (not while a play runs: the sheet is on its way off the screen and a tap on its grip was meant for the play. A
    // slow phone's first moments of a play left it in place, the tap sent it down, and the next call came up with its
    // keys under the screen's edge)
    const playing = () => $('field').classList.contains('playing');
    grip.addEventListener('pointerdown', (ev) => { if (playing()) return; drag = { y0: ev.clientY, dy: 0 }; moved = false; sh.classList.add('dragging'); try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* the drag still works */ } });
    grip.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const down = sh.classList.contains('down'), dy = ev.clientY - drag.y0;
      if (Math.abs(dy) > 5) moved = true;
      drag.dy = down ? clip(dy, -sh.offsetHeight, 0) : Math.max(0, dy);
      sh.style.transform = down ? `translateY(calc(100% - 66px - env(safe-area-inset-bottom, 0px) + ${drag.dy}px))` : `translateY(${drag.dy}px)`;
    });
    const end = () => {
      if (!drag) return;
      const down = sh.classList.contains('down'), dy = drag.dy;
      drag = null;
      sh.classList.remove('dragging'); sh.style.transform = '';
      if (moved) sheetDown(down ? dy > -40 : dy > 60);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('click', () => { if (moved) { moved = false; return; } if (!playing()) sheetDown(!sh.classList.contains('down')); });
    // down, a tap anywhere on its bar brings it back up (not a call made by accident)
    sh.addEventListener('click', (ev) => { if (sh.classList.contains('down') && !grip.contains(ev.target)) { ev.preventDefault(); ev.stopPropagation(); sheetDown(false); } }, true);
    // a new size (another step's calls, up or down): the play framed again in what shows, between plays
    let h0 = 0, rz = 0;
    const again = () => {
      const h = sh.classList.contains('down') ? 66 : sh.offsetHeight;
      if (Math.abs(h - h0) < 24 || !bcast()) return;
      h0 = h;
      if (G && !$('play').hidden && !busy && !$('field').classList.contains('playing') && scene && scene.cover && Math.abs(covers().bot - scene.cover.bot) >= 24) drawField();
    };
    if (window.ResizeObserver) new ResizeObserver(() => { placeToast(); clearTimeout(rz); rz = setTimeout(again, 90); }).observe(sh);
    sh.addEventListener('transitionend', again);
    // the menu: what the page's header has, on the field
    const mb = $('menuBtn'), menu = $('bmenu');
    const close = () => { menu.hidden = true; mb.setAttribute('aria-expanded', 'false'); };
    mb.addEventListener('click', () => {
      menu.hidden = !menu.hidden; mb.setAttribute('aria-expanded', String(!menu.hidden));
      menu.querySelector('[data-acct]').hidden = $('acctBtn').hidden;       // (Account only where the site has sign-in)
      menu.querySelector('[data-restart]').hidden = $('restartBtn').hidden;     // (Start over only where it is offered: restartSync)
    });
    menu.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { close(); const t = $(b.dataset.go); if (t) t.click(); }));
    menu.querySelectorAll('[data-mode]').forEach((a) => a.addEventListener('click', close));
    document.addEventListener('pointerdown', (ev) => { if (!menu.hidden && !menu.contains(ev.target) && !mb.contains(ev.target)) close(); });
  }
  function fieldTaps() {
    const svg = $('field');
    let down = null;
    // (each press on the field, for the dot it may end on: dotTap)
    svg.addEventListener('pointerdown', (ev) => { fieldPress = { x: ev.clientX, y: ev.clientY, far: 0 }; }, true);
    svg.addEventListener('pointermove', (ev) => { if (fieldPress && ev.buttons) fieldPress.far = Math.max(fieldPress.far, Math.hypot(ev.clientX - fieldPress.x, ev.clientY - fieldPress.y)); }, true);
    // (the moment after a play: AFTER_PLAY_MS from its end to when the tap was made, a tap made before it too, waiting
    // on a busy phone; not once the next play runs, their drive's next snap: a tap then is that play's. A click from
    // the keyboard, or one the page makes, has no detail)
    $('play').addEventListener('click', (ev) => {
      if (ev.detail && ev.timeStamp - playEnd < AFTER_PLAY_MS && !svg.classList.contains('playing') && !$('dock').contains(ev.target)) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
    svg.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: Date.now() }; });
    svg.addEventListener('pointerup', (ev) => {
      const d0 = down; down = null;
      if (!d0 || !passing() || !scene || !scene.routePts || ui.pass.draw) return;
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
  // ---- drawing a route (✏️ Draw routes on the pass picker): tap a receiver, then drag where he goes. The line is
  // tidied into a route's legs (a stem and a break or two) and read as the real route it is closest to and the depth
  // it is run at: the throws to him are real throws on that route that went about that deep (engine.js _ri), and on
  // the snap he runs the line as drawn. The depth a drawing is read at stays within what real throws on the route
  // reach (air yards on throws to it, 10th to 90th percentile):
  const DRAWN_RANGE = { go: [11, 40], post: [8, 41], corner: [7, 33], wheel: [3, 26], out: [-1, 8], deep_out: [7, 19], in: [5, 20],
    slant: [3, 10], cross: [-1, 14], hitch: [2, 13], screen: [-6, -1], flat: [-6, 3], angle: [0, 6] };
  // how far along the break the ball meets him (yards across), as on the routes he is given (motion.js route)
  const DRAWN_ALONG = { out: 5.5, deep_out: 7, in: 8, cross: 12, flat: 7.5, angle: 3 };
  const DRAW_MIN = 1.5, DRAW_MAX = 60, DRAW_TOL = 0.9;     // yards: shorter is a tap, longer is cut off; tidied to within
  const DRAW_KEY = `${STORE}:draw`;                        // the picker opens drawing when you drew last time
  // the fewest points that keep a line within tol yards of it (Douglas-Peucker)
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const a = pts[0], b = pts[pts.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    let k = -1, far = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], d = L ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > far) { far = d; k = i; }
    }
    return far <= tol ? [a, b] : simplify(pts.slice(0, k + 1), tol).concat(simplify(pts.slice(k), tol).slice(1));
  }
  // a drawn line ([x across, L along the field] in yards, as the finger went) as a route for receiver a: its legs in
  // his (out, up) yards from where he lines up (motion.js route), the route it is read as, its depth, where the catch
  // is made on it and where across the field that is (cx); null for a line too short to be one
  // the line in his (out, up) yards from where he lines up, as the finger went (past the sideline too: a corner from
  // a man near the sideline is still a corner), cut at DRAW_MAX yards; run: its length
  function rawDrawn(sc, a, field) {
    const ox = (a.x0 - SX0) / XYD, out = outOf(sc, a), d0 = Math.abs(a.L0 - sc.losL);
    // (kept to the field's ends: a back lined up five deep who runs ten more back is read as that, then refused)
    const loc = (q) => [out * (q[0] - ox), sc.dir * (clip(q[1], -9.5, 109.5) - sc.losL)];
    const raw = [[0, -d0]];
    let run = 0;
    for (const q of field.map(loc)) {
      const p = raw[raw.length - 1], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 0.25) continue;
      if (run + l > DRAW_MAX) { const w = (DRAW_MAX - run) / l; raw.push([p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w]); run = DRAW_MAX; break; }
      raw.push(q); run += l;
    }
    return { raw, run, d0 };
  }
  // What a drawn line may not be. A real route is a stem and at most two cuts, so a line may not cross itself or
  // curl round (turn more than DRAW_TURN degrees in all), have more than two cuts, double back on itself (a comeback
  // at the end, back toward the ball by DRAW_BACK yards or less, is a route), or run back more than DRAW_BACK yards
  // from where he lines up (a screen sits a few yards behind the line). The finger's wobble (under a yard) is not
  // a cut or a turn. null: a route
  const DRAW_TURN = 300, DRAW_BACK = 4;
  const DRAW_FAULT = {
    loop: 'No loops: draw one line, with up to two cuts',
    cuts: 'Too many cuts: a real route has two at most',
    back: 'He can’t double back on his route',
    behind: 'Too far backward: routes go downfield (a screen sits a few yards behind the line)',
  };
  const turnOf = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]], lu = Math.hypot(...u), lv = Math.hypot(...v);
    return lu && lv ? (Math.acos(clip((u[0] * v[0] + u[1] * v[1]) / (lu * lv), -1, 1)) * 180) / Math.PI : 0;
  };
  // a line that crosses itself, or turns one way all along (winds into a loop): 'loop'; one that zigzags, turning back
  // and forth more than DRAW_TURN degrees in all (its turns cancel): 'cuts'. Every drawing (a route, a run, a drop)
  function windOf(raw) {
    const fine = simplify(raw, 0.8), main = simplify(raw, DRAW_TOL);
    const crosses = (p, q, r, t) => {
      const d = (q[0] - p[0]) * (t[1] - r[1]) - (q[1] - p[1]) * (t[0] - r[0]);
      if (Math.abs(d) < 1e-9) return false;
      const a = ((r[0] - p[0]) * (t[1] - r[1]) - (r[1] - p[1]) * (t[0] - r[0])) / d, b = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
      return a > 0 && a < 1 && b > 0 && b < 1;
    };
    for (let i = 0; i < fine.length - 1; i++) for (let j = i + 2; j < fine.length - 1; j++) if (crosses(fine[i], fine[i + 1], fine[j], fine[j + 1])) return 'loop';
    let turn = 0, net = 0;
    for (let k = 1; k < main.length - 1; k++) {
      const a = main[k - 1], b = main[k], c = main[k + 1], t = turnOf(a, b, c);
      turn += t;
      net += Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * t;
    }
    return Math.abs(net) > DRAW_TURN ? 'loop' : turn > DRAW_TURN ? 'cuts' : null;
  }
  function drawFault(raw, d0) {
    const legs = simplify(raw, 1.8), w = windOf(raw);
    if (w === 'loop') return 'loop';
    if ((legs.length > 4 && simplify(raw, 2.6).length > 4) || w === 'cuts') return 'cuts';
    for (let k = 1; k < legs.length - 1; k++) {
      const last = k === legs.length - 2, len = Math.hypot(legs[k + 1][0] - legs[k][0], legs[k + 1][1] - legs[k][1]);
      if (turnOf(legs[k - 1], legs[k], legs[k + 1]) > 150 && !(last && len <= DRAW_BACK + 1)) return 'back';
    }
    let top = -Infinity, low = Infinity;
    raw.forEach((p) => { top = Math.max(top, p[1]); low = Math.min(low, p[1]); });
    if (top >= 1 && top - raw[raw.length - 1][1] > DRAW_BACK + 1) return 'back';
    if (low < -d0 - DRAW_BACK) return 'behind';
    return null;
  }
  function shapeDrawn(sc, a, field) {
    const ox = (a.x0 - SX0) / XYD, out = outOf(sc, a), { raw, run, d0 } = rawDrawn(sc, a, field);
    if (run < DRAW_MIN) return null;
    const fault = drawFault(raw, d0);
    if (fault) return { fault };
    // a comeback (back toward the ball at the end, a yard and a half or more): the top of it kept, where he turns
    let ti = 0;
    raw.forEach((p, k) => { if (p[1] > raw[ti][1]) ti = k; });
    const back = raw[ti][1] >= 3 && raw[ti][1] - raw[raw.length - 1][1] >= 1.5;
    const tidy = (tol) => (back ? simplify(raw.slice(0, ti + 1), tol).concat(simplify(raw.slice(ti), tol).slice(1)) : simplify(raw, tol));
    let pts = tidy(DRAW_TOL);
    for (let tol = DRAW_TOL * 1.5; pts.length > 6; tol *= 1.5) pts = tidy(tol);       // a scribble: its main legs
    // a leg under a yard and a half (a wobble as the finger lands, turns or lifts) folds away: of its two ends, the
    // one he turns less at goes (the top of a comeback stays)
    for (let k = pts.length - 2; k >= 1; k--) {
      if (k >= pts.length - 1 || Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) >= 1.5) continue;
      pts.splice(k > 1 && turnOf(pts[k - 2], pts[k - 1], pts[k]) < turnOf(pts[k - 1], pts[k], pts[k + 1]) ? k - 1 : k, 1);
    }
    if (pts.length > 2 && Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) < 1.5) pts.splice(pts.length - 2, 1);
    let rd = readDrawn(pts, a.label), deeper = false;
    // a break route drawn deeper than real ones are run (a dig at 45 yards): brought up to the deepest real one
    const top = DRAWN_RANGE[rd.name][1] + 1, at = rd.atDepth;
    if (!DEEP_ROUTES.has(rd.name) && rd.name !== 'slant' && at > top) {
      const f = top / at;
      pts = pts.map((p) => [p[0], p[1] > 0 ? p[1] * f : p[1]]);
      rd = readDrawn(pts, a.label); deeper = true;
    }
    // what he runs: the line, kept on the field
    const inField = (p) => [out * (clip(ox + out * p[0], 0.7, 52.6) - ox), clip(p[1], -8, 70)];
    const run_ = pts.map(inField).filter((p, k, A) => !k || Math.hypot(p[0] - A[k - 1][0], p[1] - A[k - 1][1]) > 0.3);
    if (run_.length < 2) return null;
    const d = { pts: run_.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]), name: rd.name, depth: rd.depth, at: rd.at, minD: rd.minD, deeper };
    if (typeof d.at === 'number') d.at = Math.round(d.at * 10) / 10;
    if (d.minD != null) d.minD = Math.round(d.minD * 10) / 10; else delete d.minD;
    d.cx = Math.round(clip(Motion.routeOnField(d, d.depth, ox, out, sc.dir, sc.losL, d0, 0.5).catchAt[0], 0, 53.3) * 10) / 10;
    return d;
  }
  // which real route a drawn one is (by its last leg: up the field, back to the ball, on a slant, or across, and
  // which way) and the depth it is thrown at: where it ends on a vertical route, slant or screen; the depth it
  // breaks across at; the top of a hitch or comeback
  function readDrawn(pts, label) {
    const n = pts.length, a = pts[n - 2], b = pts[n - 1], dx = b[0] - a[0], dy = b[1] - a[1];
    const th = (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI, brk = n > 2 ? a[1] : 0, legD = (a[1] + b[1]) / 2;
    const maxD = Math.max(...pts.map((p) => p[1])), wide = Math.max(...pts.slice(0, -1).map((p) => p[0]));
    let name;
    if (maxD < 0.5) name = b[0] - pts[0][0] > 2.5 ? 'flat' : 'screen';
    else if (th > 58) name = n === 2 && b[1] < 8 ? 'hitch' : n > 2 && wide >= 3.5 && brk <= 3 ? 'wheel' : 'go';
    else if (th < -20) name = 'hitch';
    else if (th >= 20) name = dx < 0 ? (brk <= 3.5 ? 'slant' : 'post') : b[1] <= 4 ? 'flat' : brk <= 3.5 ? 'go' : 'corner';
    else if (dx >= 0) name = legD <= 1 ? 'flat' : legD < 8 ? 'out' : 'deep_out';
    else name = label === 'RB' && wide >= 2 && legD < 5 ? 'angle' : legD < 5 ? 'cross' : 'in';
    const at = name === 'hitch' ? maxD : DEEP_ROUTES.has(name) || name === 'slant' || name === 'screen' ? b[1] : legD;
    const [lo, hi] = DRAWN_RANGE[name];
    const r = { name, depth: Math.round(clip(at, lo, hi)), atDepth: at };
    if (name === 'hitch' || name === 'screen') r.at = 'end';
    else if (DRAWN_ALONG[name]) r.at = Math.sign(dx || 1) * Math.min(DRAWN_ALONG[name], Math.abs(dx) * 0.9);
    else {
      r.at = 'depth';
      if (n > 2 && (name === 'post' || name === 'corner')) r.minD = brk + 1.5;
      else if (name === 'slant') r.minD = 3;
      else if (name === 'wheel') r.minD = 4;
    }
    return r;
  }
  const depthSay = (d) => (d > 0 ? `${d} yard${d === 1 ? '' : 's'} downfield` : d < 0 ? `${-d} behind the line` : 'at the line');
  // the finger on the field while drawing: down on a receiver (or anywhere, with one picked), drag, lift
  let drawing = null;
  const dotOff = (a) => a.side * GAP * a.w;               // where his dot is drawn before the snap, from where he is
  function drawTaps() {
    const svg = $('field');
    const at = (ev) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()) : null; };
    const near = (q, list) => {
      const Y = camY(scene);
      let best = null, bd = 24;
      list.forEach((a) => { const d = Math.hypot(q.x - a.x0, q.y - Y(a.L0) - dotOff(a)); if (d < bd) { bd = d; best = a; } });
      return best;
    };
    svg.addEventListener('pointerdown', (ev) => {
      if (busy || !scene || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      const ctx = drawCtx(), q = ctx && at(ev);
      if (!q) return;
      let hit = near(q, drawFrom(scene, ctx));
      if (ctx === 'st' && ST_DRAW[ui.st] === 'kick') hit = hit || drawFrom(scene, ctx)[0];      // (a kick: from anywhere, the kicker's)
      if (ctx === 'pass' && !(hit && hit.label === 'QB')) {
        // a route: without drawing on, a drag that starts on a receiver draws his route all the same (players dragged
        // him and nothing happened); a tap is still a tap (his next route)
        const E = eligibles(scene), direct = !ui.pass.draw, k = hit ? E.indexOf(hit) : -1;
        if (direct && k < 0) return;
        const i = k >= 0 ? k : ui.pass.sel;
        ev.preventDefault();
        drawing = { ctx, i: i == null ? -1 : i, hit: k, direct, x: ev.clientX, y: ev.clientY, pts: [[q.x, q.y]], el: null, id: ev.pointerId };
      } else {
        if (!hit) return;
        ev.preventDefault();
        drawing = { ctx, a: hit, x: ev.clientX, y: ev.clientY, pts: [[q.x, q.y]], el: null, id: ev.pointerId };
      }
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* the line still follows inside the field */ }
    });
    svg.addEventListener('pointermove', (ev) => {
      const D = drawing;
      if (!D || ev.pointerId !== D.id || !scene || (!D.a && D.i < 0)) return;
      const q = at(ev), p = D.pts[D.pts.length - 1];
      if (!q || Math.hypot(q.x - p[0], q.y - p[1]) < 2.5) return;
      D.pts.push([q.x, q.y]);
      const a = D.a || eligibles(scene)[D.i], Y = camY(scene);
      if (!D.el) { D.el = S('path', { class: 'route drawing' }); svg.append(D.el); }
      // a line that can't be what it is drawn for turns red as it goes wrong
      const f = lineYards(scene, a, D.pts);
      const runner = D.ctx === 'run' || ((D.ctx === 'rpo' || D.ctx === 'play') && ['RB', 'FB', 'QB'].includes(a.label));
      let bad;
      if (runner) { const rd = readRun(scene, a, f, D.ctx === 'rpo'); bad = !!(rd && rd.fault && rd.fault !== 'line'); }
      else if (!D.a || ((D.ctx === 'rpo' || D.ctx === 'play') && eligibles(scene).includes(a))) { const { raw, d0 } = rawDrawn(scene, a, f); bad = !!drawFault(raw, d0); }
      else bad = windOf(lineOf(scene, a, f).pts) === 'loop';
      D.el.classList.toggle('bad', bad);
      D.el.setAttribute('d', `M${a.x0.toFixed(1)} ${(Y(a.L0) + dotOff(a)).toFixed(1)}${D.pts.map((v) => `L${v[0].toFixed(1)} ${v[1].toFixed(1)}`).join('')}`);
    });
    const end = (ev, cancel) => {
      const D = drawing;
      if (!D || ev.pointerId !== D.id) return;
      drawing = null;
      if (D.el) D.el.remove();
      const tap = Math.hypot(ev.clientX - D.x, ev.clientY - D.y) <= 10 && D.pts.length <= 3;
      if (!tap || D.ctx === 'pass') routeTapAt = Date.now();                // (the dot under the finger stays shut)
      if (cancel || busy || !scene || drawCtx() !== D.ctx) return;
      if (D.a) { if (!tap) commitSketch(D.ctx, D.a, D.pts); return; }
      const P = ui.pass;
      if (D.direct && tap) return;     // (a tap: his next route)
      if (tap) {
        // a tap: pick that receiver (him again: let him go); off them all, let go of whoever was picked
        P.sel = D.hit >= 0 && P.sel !== D.hit ? D.hit : null;
        redrawPass();
        return;
      }
      if (D.i < 0) { toast('Tap a receiver first, then draw his route'); return; }
      commitDraw(D.i, D.pts);
    };
    svg.addEventListener('pointerup', (ev) => end(ev, false));
    svg.addEventListener('pointercancel', (ev) => end(ev, true));
  }
  // a line on the field (SVG units) in field yards, from his dot as drawn (a step off the line of scrimmage before the
  // snap, GAP)
  function lineYards(sc, a, line) {
    const k = (sc.H - 6) / (sc.cam.hi - sc.cam.lo);
    return line.map(([x, y]) => [(x - SX0) / XYD, sc.cam.lo + (sc.H - 3 - y + dotOff(a)) / k]);
  }
  // (field: the line already in field yards, drawn on another step's framing)
  function commitDraw(i, line, field) {
    const sc = scene, a = eligibles(sc)[i], P = ui.pass;
    const d = shapeDrawn(sc, a, field || lineYards(sc, a, line));
    if (!d || d.fault) {
      P.sel = i; redrawPass();                // he stays picked: draw it again
      if (d) { toast(`${DRAW_FAULT[d.fault]}. Try again.`); track('route_refused', { why: d.fault }); }
      return;
    }
    P.drawn = P.drawn || [];
    (P.hist = P.hist || []).push([i, P.routes[i], P.drawn[i] || null]);
    P.drawn[i] = d;
    P.routes[i] = d.name;
    P.sel = null;
    P.target = i;                          // (the route you drew is the one you throw: the Snap key says so)
    redrawPass();
    toast(`${shortName(a.p ? a.p.name : '') || a.label}: ${routeSay(a.label, d.name)}, ${depthSay(d.depth)}${d.deeper ? ' (as deep as real ones go)' : ''}`);
    track('route_drawn', { route: d.name, depth: d.depth, legs: d.pts.length - 1 });
    if (window.__sepLog) (window.__drawLog = window.__drawLog || []).push({ i, label: a.label, ...d });      // (browser tests)
  }
  // drawing plays: every mode (Versus included: only the call it reads as goes to the room, vsSealed)
  const drawPref = () => !!load(DRAW_KEY, false);
  function setDraw(on) {
    save(DRAW_KEY, on);
    if (passing()) { const P = ui.pass; P.draw = on; P.sel = null; redrawPass(); } else sketchRedraw();
    track('draw_mode', { on });
  }

  // ---- drawing the rest of the play: the ball carrier's path on a run or an RPO, the quarterback's drop, your defense
  // (rushers through the line, men up into the box, drops deep) and the kicks. A drawing is read as a call the playbook
  // has, the one the keys would make: the snap is a real play of that call, graded exactly as that call (the drawing
  // only goes with it to the field, where the players run it as drawn as far as the play allows). One that can't be
  // read says why, in place; the keys stay for a tap and the keyboard.
  // Where a run crosses the line picks it, in yards from the ball as the field draws the line (guards 4 yards out,
  // tackles 8, the tight end 12): over the center, up the middle; the guard and tackle gaps, inside; outside the tackle
  // to the tight end's edge, off tackle; wider, outside
  const RUN_GAPS = [[1.4, 'middle'], [6.8, 'inside'], [12.7, 'tackle']];
  const RUN_LEAD = 2;           // yards one way behind the line before crossing on the other side of the ball: a counter
  const RUN_SWEEP = 8;          // yards out from the ball behind the line before turning up outside: a sweep or a toss
  const RUN_NEAR = 6, RUN_BOUNCE = 4.5;     // this far outside within RUN_NEAR yards past the line: bounced outside
  const RUN_CUT = 4;            // this far back across within RUN_NEAR yards past the line: a cutback (the gap he hit)
  const RUN_BACK = 3;           // yards back toward his own goal once through the line: not a run
  const SNEAK_W = 2.2;          // a quarterback straight ahead within this of the ball: a sneak (3 yards or less to go)
  const ROLL_W = 4;             // a quarterback this far to one side behind the line: a rollout that way
  const RE_WR = 12;             // yards across behind the line a receiver goes on an end-around (or past the ball)
  // the defense: the box is within BOX_D yards of the line and BOX_W of the ball (as the field draws it: the line's
  // ends 8-9 yards out, the linebackers 8, a light box's wide man 11); a drop this deep (DEEP_AT, or most of the room
  // to the end line on a short field) is a deep zone
  const BOX_D = 8, BOX_W = 10, DEEP_AT = 10;
  const KICK_ONSIDE = 22, KICK_MIN = 10;   // yards: an onside kick goes 10 and is short (22 at most); shorter is no kick
  const KICK_MAX = 90;          // yards a kick may be drawn (a touchback from the 35 is 65 past the ball and more)
  const SKETCH_FAULT = {
    loop: 'No loops: draw one line',
    rcuts: 'Too many cuts: a run has a cut or two',
    line: 'Draw from the back through a gap in the line',
    rback: 'He can’t run back the way he came once he’s through the line',
    deep: 'Too deep: draw him toward the line, not away from it',
    wr: 'A receiver carries it only on an end-around: draw him back across behind the line',
    rpoqb: 'On an RPO the back carries it: draw his path (or a receiver’s route)',
    none: 'That run isn’t on here: draw another, or tap one below',
    qbline: 'On a pass he stays behind the line: draw his drop or a rollout (a QB run is under Run)',
    def: 'Draw a rusher through the line to blitz, men up into the box to load it, or drops deep to play soft',
    kdir: 'Kick it downfield, toward their end zone',
    kshort: 'A kick has to go 10 yards',
    onside: 'Onside only when you’re behind: kick it deep or to the returner',
  };
  const SHAPE_SAY = { counter: 'a counter', sweep: 'a sweep', bounce: 'bounced outside', cutback: 'a cutback', keep: 'a keeper', sneak: 'a sneak', reverse: 'an end-around' };
  // what a drag on the field draws now (null: nothing), and the men a drawing starts from there: receivers (a route),
  // the backs and the quarterback (a run, an RPO's run, his drop), your defenders, the kicker
  const ST_DRAW = { kick: 'kick', freekick: 'kick', fgdef: 'rush', puntdef: 'rush' };
  function drawCtx() {
    if (!G || !ui || !scene || !G.root || (VS && vs.ui !== 'prompt')) return null;
    const r = G.root, mine = r.pos === G.me;
    if (passing()) return 'pass';
    if (ui.step === 'st' && ST_DRAW[ui.st] && scene.r === r) return 'st';
    if (r.phase !== SNAP || scene.r !== r) return null;
    if (mine && ui.step === 'family') return 'play';
    if (mine && ui.step === 'detail' && (ui.fam === 'run' || ui.fam === 'rpo')) return ui.fam;
    if (!mine && (ui.step === 'defense' || ui.step === 'vdef')) return 'def';
    return null;
  }
  function drawFrom(sc, ctx) {
    const off = sc.actors.filter((a) => a.off && a.teamI === G.me), def = sc.actors.filter((a) => !a.off && a.teamI === G.me);
    const has = (...l) => (a) => l.includes(a.label);
    if (ctx === 'pass') return eligibles(sc).concat(off.filter(has('QB')));
    if (ctx === 'play') return off.filter(has('QB', 'RB', 'FB', 'WR', 'TE'));
    if (ctx === 'run') return off.filter(has('QB', 'RB', 'FB', 'WR'));
    if (ctx === 'rpo') return off.filter(has('RB', 'FB', 'WR', 'TE'));
    if (ctx === 'st') return ST_DRAW[ui.st] === 'kick' ? sc.actors.filter((a) => a.label === 'K' && a.teamI === G.me) : def;
    return ctx === 'def' ? def : [];
  }
  // a line from man a ([x across, L] field yards, as drawn) in [x across, d past the line of scrimmage the offense's
  // way], from where he lines up, kept on the field and inside both end lines (a short field: it clips at the end line),
  // cut at DRAW_MAX yards; run: its length
  function lineOf(sc, a, field, max = DRAW_MAX) {
    const fwd = sc.dir > 0 ? FULL.hi - 0.5 - sc.losL : sc.losL - FULL.lo - 0.5, back = sc.dir > 0 ? sc.losL - FULL.lo - 0.5 : FULL.hi - 0.5 - sc.losL;
    const loc = (q) => [clip(q[0], 0.7, 52.6), clip(sc.dir * (q[1] - sc.losL), -back, fwd)];
    const pts = [loc([(a.x0 - SX0) / XYD, a.L0])];
    let run = 0;
    for (const q of field.map(loc)) {
      const p = pts[pts.length - 1], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 0.25) continue;
      if (run + l > max) { const w = (max - run) / l; pts.push([p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w]); run = max; break; }
      pts.push(q); run += l;
    }
    return { pts, run, room: fwd };
  }
  const r1 = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  const strongOf = (sc) => sc.s * sc.dir || 1;               // the strong side, on screen: +1 right, -1 left
  const sideAt = (sc, x) => ((Math.sign(x - (sc.bx - SX0) / XYD) || strongOf(sc)) === strongOf(sc) ? 'strong' : 'weak');
  // a ball carrier's line read as a run: the call (one callOptions offers here), its shape, and the path he runs
  // ([across, past the line] yards); rpo: the RPO to that side. { fault } when it can't be one, null for a tap
  function readRun(sc, a, field, rpo) {
    const { pts, run } = lineOf(sc, a, field);
    if (run < DRAW_MIN) return null;
    const d0 = -pts[0][1], bx = (sc.bx - SX0) / XYD, ax = pts[0][0], w = windOf(pts);
    if (w) return { fault: w === 'loop' ? 'loop' : 'rcuts' };
    if (simplify(pts, 1.8).length > 6 && simplify(pts, 2.6).length > 5) return { fault: 'rcuts' };
    const ci = pts.findIndex((p) => p[1] >= 0);
    if (ci < 1 || Math.max(...pts.map((p) => p[1])) < 1) return { fault: 'line' };
    if (Math.min(...pts.map((p) => p[1])) < -Math.max(d0, 0) - 4) return { fault: 'deep' };
    let top = -Infinity;
    for (const p of pts.slice(ci)) { if (p[1] < top - RUN_BACK || p[1] < -1) return { fault: 'rback' }; top = Math.max(top, p[1]); }
    const p0 = pts[ci - 1], p1 = pts[ci], u = p1[1] > p0[1] ? -p0[1] / (p1[1] - p0[1]) : 0, xc = p0[0] + (p1[0] - p0[0]) * u;
    // (where he is RUN_NEAR yards on, or where the line ends)
    const xAt = (d) => {
      for (let k = ci; k < pts.length; k++) if (pts[k][1] >= d) { const q = pts[k - 1], s = pts[k]; return q[0] + (s[0] - q[0]) * (s[1] > q[1] ? (d - q[1]) / (s[1] - q[1]) : 0); }
      return pts[pts.length - 1][0];
    };
    const off = xc - bx, xn = xAt(Math.min(RUN_NEAR, top)), drift = xn - xc;
    const behind = pts.slice(1, ci), first = behind.find((p) => Math.abs(p[0] - ax) >= RUN_LEAD);
    const wide = Math.max(0, ...behind.map((p) => (Math.sign(off) || 1) * (p[0] - bx)));
    const gapOf = (x) => (RUN_GAPS.find(([g]) => Math.abs(x - bx) < g) || [0, 'out'])[1];
    const avail = callOptions(sc.r).calls;
    let call, shape = 'downhill', side = sideAt(sc, xc), gap = gapOf(xc);
    if (a.label === 'QB') {
      if (rpo) return { fault: 'rpoqb' };
      call = Math.abs(off) <= SNEAK_W && Math.abs(drift) < RUN_BOUNCE && avail.includes('qb_sneak') ? 'qb_sneak' : 'qb_run';
      shape = call === 'qb_sneak' ? 'sneak' : 'keep';
    } else if (a.label === 'WR' || a.label === 'TE') {
      if (rpo || a.label === 'TE' || !(Math.sign(xc - bx) !== Math.sign(ax - bx) || Math.abs(xc - ax) >= RE_WR)) return { fault: 'wr' };
      call = 'trick_reverse'; shape = 'reverse';
    } else {
      if (first && Math.sign(first[0] - ax) !== Math.sign(off) && gap !== 'middle') shape = 'counter';
      else if (wide >= RUN_SWEEP && gap !== 'middle' && gap !== 'inside') { shape = 'sweep'; gap = 'out'; }
      else if (Math.abs(drift) >= RUN_BOUNCE && (Math.sign(drift) === Math.sign(off) || gap === 'middle') && gapOf(xn) === 'out') { shape = 'bounce'; gap = 'out'; side = sideAt(sc, xn); }
      else if (Math.abs(drift) >= RUN_CUT && Math.sign(drift) === -Math.sign(off)) shape = 'cutback';
      call = rpo ? `rpo_${gap === 'middle' ? sideAt(sc, xn) : side}` : gap === 'middle' ? 'rb_middle' : `rb_${gap}_${side}`;
    }
    if (!avail.includes(call)) return { fault: 'none' };
    return { call, shape, side, gap, carrier: a.label, path: simplify(pts, 0.3).map(r1) };
  }
  // the quarterback's line on a pass: his drop, or a rollout (ROLL_W yards or more to one side) to that side
  function readQb(sc, a, field) {
    const { pts, run } = lineOf(sc, a, field);
    if (run < DRAW_MIN) return null;
    if (windOf(pts)) return { fault: 'loop' };
    if (Math.max(...pts.map((p) => p[1])) > 0.5) return { fault: 'qbline' };
    const ax = pts[0][0], far = pts.reduce((b, p) => (Math.abs(p[0] - ax) > Math.abs(b - ax) ? p[0] : b), ax);
    const roll = Math.abs(far - ax) >= ROLL_W;
    return { roll, side: roll ? sideAt(sc, far) : null, path: simplify(pts, 0.3).map(r1) };
  }
  // a defender's line: through the line (a rusher) or a drop, and where it ends ([across, depth on the defense's side])
  function readDefLine(sc, a, field) {
    const { pts, run } = lineOf(sc, a, field);
    if (run < DRAW_MIN) return null;
    if (windOf(pts) === 'loop') return { fault: 'loop' };
    const e = pts[pts.length - 1], k = pts.findIndex((p) => p[1] <= -0.5);       // (the defense lines up at a positive d)
    return { through: k >= 0, cross: k >= 0 ? pts[k] : null, start: pts[0], end: e, path: simplify(pts, 0.3).map(r1) };
  }
  // your defense as drawn: who rushes (the line, or as many as the call has, nearest the line, unless drawn
  // otherwise), how many end up in the box and how many deep. Simple: blitz (five or more rushing), load the box (seven
  // or more in it, men brought up), play soft (three rushing, or more men deep); full: the call's rush, front and
  // coverage each moved by what was drawn (personnel as called), the rest as called
  const FRONTS = ['light', 'even', 'loaded'];
  function readDef(sc, lines, base) {
    const D = sc.actors.filter((a) => !a.off), bx = (sc.bx - SX0) / XYD;
    const at = (a) => lineOf(sc, a, []).pts[0];
    const n0 = base ? +base.rush : D.filter((a) => a.label === 'DL' || a.label === 'EDGE').length;
    const byLine = D.slice().sort((a, b) => at(a)[1] - at(b)[1] || Math.abs(at(a)[0] - bx) - Math.abs(at(b)[0] - bx));
    const dflt = new Set(byLine.slice(0, n0));
    const room = sc.dir > 0 ? FULL.hi - 0.5 - sc.losL : sc.losL - FULL.lo - 0.5, deepAt = Math.min(DEEP_AT, room * 0.7);
    const inBox = (p) => p[1] <= BOX_D && Math.abs(p[0] - bx) <= BOX_W;
    let rushers = 0, extra = 0, boxB = 0, boxA = 0, deepB = 0, deepA = 0, coverT = false;
    D.forEach((a) => {
      const l = lines.get(a), s = at(a), rush = l ? l.through : dflt.has(a), end = l ? (l.through ? l.cross : l.end) : s;
      if (rush) rushers++;
      if (rush && !dflt.has(a)) extra++;
      if (inBox(s)) boxB++;
      if (inBox(end)) boxA++;
      if (!dflt.has(a) && s[1] >= deepAt) deepB++;
      if (!rush && end[1] >= deepAt) deepA++;
      if (l && !l.through && (l.end[1] >= deepAt || s[1] >= deepAt)) coverT = true;
    });
    const out = { rushers, box: boxA, deep: deepA };
    if (!base) {
      // (a man sent who doesn't rush on the call: a blitz, with a three-man line too)
      const call = rushers >= 5 || (extra && rushers >= 4) ? 'blitz' : boxA >= 7 && boxA > boxB ? 'load' : rushers <= 3 || (coverT && (deepA > deepB || deepA >= 3)) ? 'soft' : null;
      return call ? { ...out, call } : { fault: 'def' };
    }
    const man = ['c0', 'c1', '2man'].includes(base.cover);
    const coverOf = (n) => (n <= 0 ? 'c0' : n === 1 ? (man ? 'c1' : 'c3') : n === 2 ? (man ? '2man' : ['c4', 'c6'].includes(base.cover) ? base.cover : 'c2')
      : n === 3 ? (base.cover === 'c6' ? 'c6' : 'c3') : n === 4 ? 'c4' : 'prevent');
    const dc = { ...base, rush: rushers !== n0 ? clip(rushers, 3, 6) : +base.rush,
      front: boxA !== boxB ? FRONTS[clip(FRONTS.indexOf(base.front) + boxA - boxB, 0, 2)] : base.front, cover: coverT ? coverOf(deepA) : base.cover };
    return { ...out, dc };
  }
  // the kick drawn from the kicker: through the end zone (a touchback), short (onside, when behind) or to the returner;
  // a free kick deep or onside
  function readKick(sc, a, field, kind) {
    const { pts, run } = lineOf(sc, a, field, KICK_MAX);
    if (run < DRAW_MIN) return null;
    const e = pts[pts.length - 1], dist = e[1], goal = sc.dir > 0 ? 100 - sc.losL : sc.losL;      // (yards past the ball, and to their goal line)
    if (dist < -1) return { fault: 'kdir' };
    if (dist < KICK_MIN) return { fault: 'kshort' };
    const behind = sc.r.score[G.me] < sc.r.score[1 - G.me];
    if (kind === 'freekick') return { key: dist <= KICK_ONSIDE ? 'onside' : 'deep', path: [pts[0], e].map(r1) };
    if (dist <= KICK_ONSIDE) return behind ? { key: 'onside', path: [pts[0], e].map(r1) } : { fault: 'onside' };
    return { key: e[1] >= goal ? 'touchback' : 'return', path: [pts[0], e].map(r1) };
  }
  // what the drawing on the field reads as, for the dock: { label, kind, call or key or dc, draw (what goes with the
  // snap) } or null
  function sketchRead(ctx) {
    const sk = ui.sk, sc = scene;
    if (!sk || !sc) return null;
    const line = (kind) => sk.lines.find((l) => l.kind === kind);
    if (ctx === 'run' || ctx === 'rpo') {
      const l = line('run'), rt = ctx === 'rpo' ? line('route') : null;
      if (!l || (ctx === 'rpo') !== l.read.call.startsWith('rpo')) return null;
      const rd = l.read, a = sc.actors[rt ? rt.i : -1], ei = a ? eligibles(sc).indexOf(a) : -1;
      const draw = { path: rd.path, carrier: rd.carrier, shape: rd.shape };
      if (ei >= 0) { draw.target = ei; draw.drawn = eligibles(sc).map((_, k) => (k === ei ? { pts: rt.read.pts, at: rt.read.at, minD: rt.read.minD } : null)); draw.routes = eligibles(sc).map((_, k) => (k === ei ? rt.read.name : null)); }
      const say = SHAPE_SAY[rd.shape] ? ` · ${SHAPE_SAY[rd.shape]}` : '';
      return { kind: ctx, call: rd.call, draw, label: `${CALL[rd.call].label}${say}${ei >= 0 ? ` · ${routeName(a.label, rt.read.name)} to ${shortName(a.p ? a.p.name : '') || a.label}` : ''}` };
    }
    if (ctx === 'def') {
      const ls = sk.lines.filter((l) => l.kind === 'def');
      if (!ls.length) return null;
      const m = new Map(ls.map((l) => [sc.actors[l.i], l.read])), full = ui.step === 'vdef';
      const rd = readDef(sc, m, full ? ui.dc : null);
      if (rd.fault) return { kind: 'def', fault: rd.fault };
      const ddraw = ls.map((l) => ({ k: sc.actors.filter((a) => !a.off).indexOf(sc.actors[l.i]), pts: l.read.path }));
      return { kind: 'def', ...(full ? { dc: rd.dc } : { call: rd.call }), draw: { ddraw },
        label: full ? vdefText(rd.dc) : `${DEF[rd.call].label} · ${rd.rushers} rushing, ${rd.box} in the box, ${rd.deep} deep` };
    }
    if (ctx === 'st') {
      if (ST_DRAW[ui.st] === 'kick') { const l = line('kick'); return l ? { kind: 'st', key: l.read.key } : null; }
      const ls = sk.lines.filter((l) => l.kind === 'def');
      if (!ls.length) return null;
      const thru = ls.some((l) => l.read.through);
      return { kind: 'st', key: ui.st === 'fgdef' ? (thru ? 'block' : 'safe') : thru ? 'rush' : 'return' };
    }
    return null;
  }
  // a line drawn on the field (SVG units, from man a) taken in: read, kept (one line a man; Undo takes it back), or
  // refused with why
  function commitSketch(ctx, a, line) {
    const sc = scene, field = lineYards(sc, a, line), i = sc.actors.indexOf(a), lab = a.label, ei = eligibles(sc).indexOf(a);
    const sk = ui.sk = ui.sk || { lines: [], hist: [] };
    const keep = (kind, read) => {
      sk.hist.push(sk.lines.slice());
      const solo = kind === 'run' || kind === 'route' || kind === 'kick';
      sk.lines = sk.lines.filter((l) => l.i !== i && !(solo && l.kind === kind)).concat([{ i, kind, field, at: [(a.x0 - SX0) / XYD, a.L0], read }]);
      sk.bad = null;
    };
    const refuse = (kind, why, text) => { sk.bad = text || SKETCH_FAULT[why]; toast(`${sk.bad}. Try again.`); track('draw_refused', { kind, why }); sketchRedraw(); };
    const toPass = (fn) => { openPass(); fn(); };
    const at = [(a.x0 - SX0) / XYD, a.L0];
    // (sideways behind the line: a man in motion, whatever the call: setMotion)
    if (['pass', 'play', 'run', 'rpo'].includes(ctx) && a.off && !VS) {
      const mv = readMotion(sc, a, field);
      if (mv) { setMotion(a, mv.x); return; }
    }
    if (ctx === 'pass' || ctx === 'play') {
      // (the first call: a back or the quarterback through the line is a run, a receiver back across it the end-around;
      // a receiver, a back's route that never gets there, or the quarterback's drop, a pass)
      const rd = ctx === 'play' && lab !== 'TE' ? readRun(sc, a, field, false) : null;
      if (rd && !rd.fault) { ui.step = 'detail'; ui.fam = 'run'; keep('run', rd); sketchSaid(); sketchRedraw(); return; }
      if (ctx === 'play' && rd && rd.fault !== 'line' && rd.fault !== 'wr') return refuse('run', rd.fault);
      if (lab === 'QB') {
        const q = readQb(sc, a, field);
        if (!q) return;
        if (q.fault) return refuse('qb', q.fault);
        return ctx === 'play' ? toPass(() => qbDrawn(q, field, at)) : qbDrawn(q, field, at);
      }
      if (ei < 0) return rd ? refuse('run', rd.fault) : undefined;
      if (ctx === 'play') return toPass(() => commitDraw(ei, null, field));
      return commitDraw(ei, line);
    }
    if (ctx === 'run' || ctx === 'rpo') {
      if (ctx === 'rpo' && (lab === 'WR' || lab === 'TE')) {
        const d = shapeDrawn(sc, a, field);
        if (!d) return;
        if (d.fault) return refuse('route', d.fault, DRAW_FAULT[d.fault]);
        keep('route', d);
      } else {
        const rd = readRun(sc, a, field, ctx === 'rpo');
        if (!rd) return;
        if (rd.fault) return refuse(ctx, rd.fault);
        keep('run', rd);
      }
      sketchSaid(); sketchRedraw();
      return;
    }
    const kickNow = ctx === 'st' && ST_DRAW[ui.st] === 'kick';
    const rd = kickNow ? readKick(sc, a, field, ui.st) : readDefLine(sc, a, field);
    if (!rd) return;
    if (rd.fault) return refuse(ctx, rd.fault);
    keep(kickNow ? 'kick' : 'def', rd);
    const s = sketchRead(ctx);
    if (s && s.fault) { sk.bad = SKETCH_FAULT[s.fault]; track('draw_refused', { kind: ctx, why: s.fault }); }
    sketchSaid(); sketchRedraw();
  }
  // what the drawing reads as now, said (a toast; the dock shows it too)
  function sketchSaid() {
    const s = sketchRead(drawCtx());
    if (s && !s.fault) toast(`✏️ ${s.label || stLabel(s.key)}`, true);
  }
  function undoSketch() {
    const sk = ui.sk, h = sk && sk.hist.pop();
    if (!h || busy) return;
    sk.lines = h; sk.bad = null;
    sketchRedraw();
  }
  function clearSketch() {
    const sk = ui.sk;
    if (!sk || busy || !sk.lines.length) return;
    sk.hist.push(sk.lines.slice()); sk.lines = []; sk.bad = null;
    sketchRedraw();
  }
  // the field and the calls again, the page where it is (a phone's sheet keeps its scroll)
  function sketchRedraw() {
    const y = window.scrollY;
    lastBall = null;
    drawField();
    if (ui.step === 'vdef') drawFullDefDock(); else if (ui.step === 'defense') drawDefDock(); else if (ui.step === 'st') promptChoice(ui.st); else drawDock();
    window.scrollTo(0, y);
    if ($('drawGo')) $('dock').scrollTop = 0;          // (a phone's sheet: up top, where the drawing's call is)
  }
  // the pass picker, from a drawing on the first call
  function openPass() {
    save(`${STORE}:usedpass`, true);
    ui.fam = 'pass'; ui.step = 'pass';
    ui.pass = { target: null, routes: null, drawn: [], draw: drawPref(), sel: null, pa: false, roll: false, fresh: true };
    drawField(); drawDock();
  }
  // the quarterback's line on a pass: a rollout to its side (or his drop: no rollout), Undo takes it back
  function qbDrawn(q, field, at) {
    const P = ui.pass;
    (P.hist = P.hist || []).push(['qb', P.qb || null, P.roll, P.rollSide || null]);
    P.qb = { field, path: q.path, at };
    P.roll = q.roll; P.rollSide = q.side;
    if (q.roll) P.pa = false;
    redrawPass();
    toast(q.roll ? `QB: rolls out to the ${q.side} side` : 'QB: drops back', true);
    track('draw_qb', { roll: q.roll ? q.side : 'drop' });
  }
  // the drawing over the field: each man's line from where he lines up now, an arrow at its end; the men a drawing
  // starts from marked (drawing on) and told so (screen readers: the keys make the same calls)
  function drawSketch(sc) {
    const ctx = drawCtx(), sk = ui.sk;
    if (!ctx) return;
    sc.svg.classList.toggle('drawing', ctx !== 'play' || bcast() || !TOUCH);
    const Y = camY(sc), g = S('g', { class: 'routes sketch' });
    const show = { pass: ['qb'], run: ['run'], rpo: ['run', 'route'], def: ['def'], st: ['kick', 'def'] }[ctx] || [];
    const lines = (sk ? sk.lines : []).filter((l) => show.includes(l.kind)).concat(ctx === 'pass' && ui.pass.qb ? [{ ...ui.pass.qb, kind: 'qb', i: sc.actors.findIndex((a) => a.off && a.label === 'QB') }] : []);
    lines.forEach((l) => {
      const a = sc.actors[l.i];
      if (!a) return;
      if (l.kind === 'run' && (ctx === 'rpo') !== l.read.call.startsWith('rpo')) return;      // (a run drawn for the other key)
      const ox = (a.x0 - SX0) / XYD - l.at[0], oL = a.L0 - l.at[1];
      const pts = [[a.x0, Y(a.L0) + dotOff(a)]].concat(l.field.map((p) => [clip(SX0 + (p[0] + ox) * XYD, SX0 + 1, SX1 - 1), Y(clip(p[1] + oL, FULL.lo + 0.5, FULL.hi - 0.5))]));
      if (pts.length < 2) return;
      const d = pts.map((q, k) => `${k ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');
      const cls = l.kind === 'def' ? (l.read.through ? ' rush' : ' drop') : l.kind === 'kick' ? ' kick' : '';
      g.append(S('path', { class: 'route halo', d }), S('path', { class: `route drawn${cls}`, d }));
      const e = pts[pts.length - 1], q = pts[pts.length - 2], ang = Math.atan2(e[1] - q[1], e[0] - q[0]);
      const head = [[e[0], e[1]], [e[0] - 6 * Math.cos(ang - 0.5), e[1] - 6 * Math.sin(ang - 0.5)], [e[0] - 6 * Math.cos(ang + 0.5), e[1] - 6 * Math.sin(ang + 0.5)]];
      g.append(S('path', { class: `route-head drawn${cls}`, d: `M${head.map((h) => h.map((v) => v.toFixed(1)).join(' ')).join('L')}Z` }));
    });
    const what = { pass: 'his drop or a rollout', play: 'a run through the line, or a route', run: 'his run', rpo: 'the run or a route', def: 'his rush or his drop', st: ST_DRAW[ui.st] === 'kick' ? 'the kick' : 'a rush' }[ctx];
    drawFrom(sc, ctx).forEach((a) => {
      if (ctx === 'pass' && a.label !== 'QB') return;
      if (drawPref() && ctx !== 'play' && ctx !== 'pass' && !lines.some((l) => sc.actors[l.i] === a)) g.append(S('circle', { class: 'selring soft', cx: a.x0, cy: Y(a.L0) + dotOff(a), r: 12 }));
      if (a.g.hasAttribute('aria-label')) a.g.setAttribute('aria-label', `${a.g.getAttribute('aria-label')}. Drag on the field to draw ${what}; the keys make the same calls`);
    });
    sc.svg.insertBefore(g, sc.layer);
  }
  // the drawing's part of the dock: what it reads as (or why it can't be read) and its key, Undo and Clear; a line
  // saying it can be drawn
  const SKETCH_HINT = {
    play: 'Or draw it: drag the back through the line for a run, a receiver for a pass.',
    run: 'Draw it: drag the back (or the quarterback) through the line. Where he crosses picks the run.',
    rpo: 'Draw it: drag the back through the line (the side), and a receiver’s route if you like.',
    def: 'Draw it: drag defenders through the line to rush, up into the box, or back into deep zones.',
    kick: 'Draw it: drag from the kicker where the ball goes.',
    rush: 'Draw it: drag defenders through the line to rush the kick.',
  };
  function sketchChips(head, ctx) {
    const sk = ui.sk;
    if (sk && sk.hist.length) {
      const u = el('button', 'chip', '↶ Undo');
      u.type = 'button';
      u.setAttribute('aria-label', 'Undo the last line drawn');
      u.addEventListener('click', undoSketch);
      head.append(u);
    }
    const on = drawPref(), pen = el('button', `chip pen${on ? ' on' : ''}`, on ? '✓ Drawing' : '✏️ Draw');
    pen.type = 'button'; pen.id = 'drawBtn';
    pen.setAttribute('aria-label', on ? 'Drawing on: turn it off' : 'Draw the play');
    pen.setAttribute('aria-pressed', String(on));
    pen.dataset.ctx = ctx;
    pen.addEventListener('click', () => { if (!busy) setDraw(!on); });
    head.append(pen);
  }
  function sketchPanel(d, ctx, go) {
    const sk = ui.sk, s = sketchRead(ctx), kind = ctx === 'st' ? ST_DRAW[ui.st] : ctx;
    const p = el('p', `hint${drawPref() || s || (sk && sk.bad) ? ' draw' : ''}${sk && sk.bad ? ' bad' : ''}`, sk && sk.bad ? `${sk.bad}. Try again.` : s && !s.fault ? `✏️ Drawn: ${s.label || stLabel(s.key)}` : SKETCH_HINT[kind]);
    p.setAttribute('role', 'status');
    if (sk && sk.lines.length) {
      const c = el('button', 'linkbtn', 'Clear');
      c.type = 'button';
      c.addEventListener('click', clearSketch);
      p.append(' ', c);
    }
    d.append(p);
    if (!s || s.fault || !go) return null;
    // (its key the snap at the foot of the sheet, game.html .snapbar: the call's other keys scroll above it)
    const keys = el('div', 'keys snapbar');
    keys.style.setProperty('--cols', 1);
    const b = key(ctx === 'run' ? 'Run it' : ctx === 'rpo' ? 'Run the RPO' : ctx === 'st' ? stLabel(s.key) : 'Call it', `Drawn: ${s.label || stLabel(s.key)}`, 'big drawn', 0);
    b.id = 'drawGo';
    b.addEventListener('click', () => { if (!busy) go(s); });
    keys.append(b);
    d.append(keys);
    return keys;
  }
  const stLabel = (k) => ({ return: 'To the returner', touchback: 'Through the end zone', onside: 'Onside', deep: 'Kick deep', block: 'Go for the block', safe: 'Stay home', rush: 'Rush the punt' }[k] || k);
  // (browser tests only, window.__sepLog: the drawing and the play, for bots that draw thousands of lines and plays)
  if (window.__sepLog) {
    window.__draw = { eligibles, rawDrawn, drawFault, shapeDrawn, passOption, passCallOf, makeScene, choreograph, send, simScen, outOf, drawField,
      DRAWN_RANGE, CALL, ROUTES, routeName, ROUTE_DEPTH, SX0, XYD, Motion, at, ballAt, place, animatePlay, offField, goalCheck, speedLog, get: () => ({ G, ui, scene, busy }),
      readRun, readQb, readDefLine, readDef, readKick, lineOf, drawFrom, drawCtx, callOptions, sketchRead, SKETCH_FAULT, DEFS, PRESET, vsSealed, camY, dotOff, lineYards,
      promptDefense: () => promptDefense(), drawAll: () => drawAll(), promptChoice: (k) => promptChoice(k),
      drawFullDefDock: () => drawFullDefDock(), drawDefDock: () => drawDefDock(), crowdKey: (r, k) => crowdKey(r, k) };
  }
  // who gets the ball, by his place in the list (the field may be redrawn under the buttons: a resize, the phone's
  // address bar)
  // (his row tapped again: back to the open man)
  function passPick(i) {
    if (busy || !passing() || !scene || !eligibles(scene)[i] || blocks(scene, i)) return;
    ui.pass.target = ui.pass.target === i ? null : i;
    redrawPass();
  }
  // No receiver picked: the throw goes to the open man. The engine plays exactly what the Snap key always sent before
  // a pick (the first receiver's call, route and position: openI, the first who goes out: not one your protection keeps
  // in), graded the same; only the field reads act.open and draws the ball to whoever is open there among the men whose
  // routes make that same call (choreograph openPick)
  const openI = (sc) => { const st = protOn() && sc ? protMen(sc, G.prot) : []; return Math.max(0, sc ? eligibles(sc).findIndex((a) => !st.includes(a)) : 0); };
  const blocks = (sc, i) => !!(protOn() && sc && protMen(sc, G.prot).includes(eligibles(sc)[i]));
  function openOption(sc, oob) {
    const o = passOption(sc, openI(sc), oob), P = ui.pass;
    o.label = `Pass to the open man${P.pa ? ', play action' : P.roll ? ', rollout' : ''}${oob ? ', get out of bounds' : ''}`;
    o.action.open = true;
    return o;
  }
  function redrawPass() {
    const y = window.scrollY, fi = scene ? eligibles(scene).findIndex((a) => a.g === document.activeElement) : -1, dy = $('dock').scrollTop;
    lastBall = null;                  // the same snap: no fade-in, no ball move
    drawField();
    drawDock();
    window.scrollTo(0, y);
    $('dock').scrollTop = dy;         // (a phone's sheet: the receiver just picked stays under the finger)
    // (his route changed from the keyboard: the focus stays on him, on the field drawn again)
    const a = fi >= 0 && scene && eligibles(scene)[fi];
    if (a) a.g.focus({ preventScroll: true });
  }
  // the engine call a pick stands for (its pools hold the real plays): a screen, play action, a rollout, a deep shot
  // (the post down the middle), a throw over the middle (dig, crosser, angle) or a quick throw, to the receiver's side
  // A drawn route: deep (15 yards or more, as the play-by-play splits it) or short by its depth, over the middle
  // (within 9 yards of the middle of the field) or to the side it is caught on
  // A rollout drawn (the quarterback's line, rollSide) goes to the side he rolls to
  function passCallOf(sc, a, rt, pa, roll, dr, rollSide) {
    if (dr && rt !== 'screen') {
      const deep = dr.depth >= 15, mid = Math.abs(dr.cx - 53.333 / 2) < 9;
      const side = (Math.sign(dr.cx - (sc.bx - SX0) / XYD) || outOf(sc, a)) === sc.s * sc.dir ? 'strong' : 'weak';
      if (pa) return deep ? 'pa_deep' : 'pa_short';
      if (roll) return `roll_${rollSide || side}`;
      return mid ? (deep ? 'deep_middle' : 'quick_middle') : `${deep ? 'deep' : 'quick'}_${side}`;
    }
    const side = outOf(sc, a) === sc.s * sc.dir ? 'strong' : 'weak';
    if (rt === 'screen') return 'screen';
    if (pa) return DEEP_ROUTES.has(rt) ? 'pa_deep' : 'pa_short';
    if (roll) return `roll_${rollSide || side}`;
    if (DEEP_ROUTES.has(rt)) return rt === 'post' ? 'deep_middle' : `deep_${side}`;
    if (rt === 'in' || rt === 'cross' || rt === 'angle') return 'quick_middle';
    return `quick_${side}`;
  }
  // the option your pick is graded as, and the action the engine plays it with
  function passOption(sc, i, oob) {
    const P = ui.pass, a = eligibles(sc)[i], rt = P.routes[i], dr = P.drawn && P.drawn[i], call = passCallOf(sc, a, rt, P.pa, P.roll, dr, P.roll && P.rollSide);
    const name = a.p ? a.p.name : a.label;
    // what you drew goes with the call: the target's depth (the real throws it draws from) and every drawn line
    const drawn = P.drawn && P.drawn.some(Boolean) ? { drawn: eligibles(sc).map((_, k) => { const d = P.drawn[k]; return d ? { pts: d.pts, at: d.at, minD: d.minD, depth: d.depth, cx: d.cx } : null; }) } : {};
    const qbp = P.qb ? { qbPath: P.qb.path } : {};
    return { key: `pass:${i}:${rt}${dr ? `@${dr.depth}` : ''}${P.pa ? ':pa' : P.roll ? `:roll${P.rollSide ? `-${P.rollSide}` : ''}` : ''}${oob ? '+oob' : ''}`,
      label: `${routeName(a.label, rt)}${dr ? ` (drawn, ${dr.depth} yds)` : ''} to ${shortName(name) || a.label}${P.pa ? ', play action' : P.roll ? ', rollout' : ''}${oob ? ', get out of bounds' : ''}`,
      action: withTempo({ to_off: false, play: 'pass', call, oob: !!oob, looks: G.look != null ? 1 << G.look : 0, route: rt, who: a.label,
        target: i, routes: P.routes.slice(), targetName: name, targetPos: a.label, pa: !!P.pa, roll: !!P.roll, ...(dr ? { depth: dr.depth } : {}), ...drawn, ...qbp }) };
  }
  function drawField() {
    const sc = makeScene(G.root, G.side);
    scene = sc;
    // the chips over the field go to the open grass: the half of the screen away from the line of scrimmage
    sc.svg.parentElement.classList.toggle('chipsdown', camY(sc)(spotGeom(G.root).L) < sc.H / 2);
    if (passing()) {
      if (!ui.pass.routes || ui.pass.routes.length !== eligibles(sc).length) { ui.pass.routes = defaultRoutes(sc); ui.pass.drawn = []; ui.pass.sel = null; ui.pass.target = null; }
      // (no target picked: the Snap key throws to the open man, openI's call for the engine: openOption)
      drawRoutes(sc);
    }
    drawSketch(sc);
    if (fadeNext || lastBall) sc.layer && sc.layer.classList.add('movefade');
    fadeNext = false;
    // (a finished half or game: no snap to come, so no play speed or personnel chip on it)
    if (speedOn) $('speedBtn').hidden = sc.mode === 'done';
    if (sc.mode === 'done') persChip();
    if ($('toBtn') && !$('toBtn').hidden) placeTo(); else ezClear(sc);
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
  const ROLL_FLAT = 2.6;       // seconds: a sprint-out's throw to the flat, on the run (pass: the charted time is held to it)
  // The ball's average speed over its flight, yards a second, by how far downfield it goes: a quarterback lets it go
  // at 50 to 60 mph (24 to 29 yards a second) and drag slows it. Short and intermediate throws are on a line (25-26
  // yd/s on average), deep balls are lofted and hang (a 50-yard throw is in the air about 2.7 s, 19 yd/s), and a
  // screen or a dump-off behind the line is a soft toss (about 18). arm: the passer's (0.93 to 1.07, by his rating)
  const ballSpeed = (air, arm) => (air <= 0 ? 18 + (clip(air, -5, 0) + 5) * 1.6 : 26 - 0.17 * clip(air, 0, 45)) * (arm || 1);
  const armOf = (p) => clip(0.93 + (0.14 * ((p && p.ovr) || 75) - 0.14 * 50) / 45, 0.93, 1.07);
  // how far through its flight the ball is at u (0 to 1) of the time: it slows as it goes (drag; d: how much, a deep
  // ball's more), leaving the hand d above its average speed and getting there d below
  const dragU = (u, d) => u * (1 + d) - d * u * u;
  // a pass in the air is drawn this many points above its shadow for each unit of its height (z: a deep ball's arc
  // tops out near 2.4), the way a camera behind the play sees it go up and come down: over a man's head, or short of him
  const BALL_LIFT = 7;
  const flight = (air, arm) => (Math.abs(air) + 7) / ballSpeed(air, arm);              // seconds the ball is in the air
  const PLAY_SPEED = 1;        // real time, your snaps and theirs
  // the player's own speed-up (1x, 1.5x, 2x: the button on the field), kept on the device; a tap on the field skips
  // 0: plays off (the result straight away), the player's own choice on the same button. A device set to reduce
  // motion still sees the plays (players on a computer with it on saw none and asked why), with the camera held
  // still instead of zooming in and out
  const SPEEDS = [1, 1.5, 2, 0], SPEED_KEY = `${STORE}:speed`;
  const playSpeed = () => { const v = Number(load(SPEED_KEY, 1)); return SPEEDS.includes(v) ? v : 1; };
  const playsOn = () => playSpeed() > 0;
  let speedOn = false;
  function speedBtn() {
    const b = $('speedBtn');
    if (!b) return;
    speedOn = true;
    const show = () => {
      const v = playSpeed();
      b.textContent = v ? `${v}\u00d7` : 'Off';
      b.setAttribute('aria-label', v ? `Play speed ${v} times. Tap to change` : 'Plays off: results only. Tap to turn them on');
    };
    show();
    b.hidden = false;
    b.addEventListener('click', () => {
      const v = SPEEDS[(SPEEDS.indexOf(playSpeed()) + 1) % SPEEDS.length];
      save(SPEED_KEY, v); show();
      toast(v === 1 ? 'Plays at real speed' : v ? `Plays at ${v}\u00d7 speed. Tap the field to skip one` : 'Plays off: you see each result straight away');
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
  const GROUP = { XOL: 'OL', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', LT: 'OL', LG: 'OL', C: 'OL', RG: 'OL', RT: 'OL', T: 'OL', G: 'OL',
    EDGE: 'DL', DL: 'DL', LB: 'LB', CB: 'CB', S: 'S', K: 'QB', KC: 'LB', SZ: 'LB', KR: 'RB' };
  // seconds after the snap before the first step: the offense knows the count, the defense reacts to the ball
  // (tracking: receivers are still within half a yard of their stance half a second after the snap)
  const REACT_OFF = 0.18, REACT_DEF = 0.3;
  const DDRAW_T = 1.1;          // seconds a defender you drew runs your line before the play takes him (choreograph)

  // where actor a is at play time t: on its simulated track, or (kickoff alignment, before a play) where it stands
  function at(a, t) {
    const k = a.trk;
    if (!k) return { x: a.x0, L: a.L0, w: a.w0 ?? 1 };
    const i = clip(t / k.dt, 0, k.n - 1), j = Math.floor(i), j2 = Math.min(j + 1, k.n - 1), u = i - j;
    const w = k.hold ? k.w0 : k.w0 * clip(1 - (t - k.wt) / 0.3, 0, 1);
    return { x: k.x[j] + (k.x[j2] - k.x[j]) * u, L: k.L[j] + (k.L[j2] - k.L[j]) * u, w };
  }
  // (browser tests) every man off the ground at any moment of a play, before the snap as drawn (a step off the ball,
  // GAP) and on his track every 0.1 s, and the ball when it is not a kick through the uprights: inside both end lines,
  // at most a step past a sideline (the drawn turf)
  function offField(sc, P, kick) {
    const bad = [], k = (sc.H - 6) / (sc.cam0.hi - sc.cam0.lo), x0 = SX0 - XYD, x1 = SX1 + XYD;
    const out = (x, L) => x < x0 || x > x1 || L < FULL.lo || L > FULL.hi;
    sc.actors.forEach((a) => {
      const L = a.L0 - (a.side * GAP * (a.w0 ?? 1)) / k;
      if (out(a.x0, L)) bad.push({ who: a.label, off: a.off, t: -1, x: +a.x0.toFixed(1), L: +L.toFixed(2) });
    });
    for (let t = 0; P && t <= P.T + 1e-9; t += 0.1) {
      sc.actors.forEach((a) => { const p = at(a, t); if (out(p.x, p.L)) bad.push({ who: a.label, off: a.off, t: +t.toFixed(1), x: +p.x.toFixed(1), L: +p.L.toFixed(2) }); });
      const b = ballAt(sc, P, t);
      if (!kick && b.show && out(b.x, b.L)) bad.push({ who: 'ball', t: +t.toFixed(1), x: +b.x.toFixed(1), L: +b.L.toFixed(2) });
    }
    return bad;
  }
  // (browser tests) how fast anyone runs on a play as drawn: every man's track frame by frame (1/20 s) to the play's
  // end, in yards: his top speed from one frame to the next (v1) and over a fifth of a second (v4: what the eye sees),
  // and his longest jump between two frames (a teleport). The fastest man of the play and the worst jump
  function speedCheck(sc, P) {
    const top1 = { v: 0, who: '', t: 0 }, top4 = { v: 0, who: '', t: 0 }, jump = { v: 0, who: '', t: 0 };
    const up = (m, v, a, t) => { if (v > m.v) { m.v = v; m.who = a.label + (a.off ? '' : ' (D)'); m.t = t; } };
    sc.actors.forEach((a) => {
      const k = a.trk;
      if (!k || k.hold) return;
      const n = Math.min(k.n, Math.ceil(P.T / k.dt) + 1), X = (j) => k.x[j] / XYD, Y = (j) => k.L[j];
      for (let j = 1; j < n; j++) {
        const d = Math.hypot(X(j) - X(j - 1), Y(j) - Y(j - 1));
        up(jump, d, a, j * k.dt); up(top1, d / k.dt, a, j * k.dt);
        if (j >= 4) up(top4, Math.hypot(X(j) - X(j - 4), Y(j) - Y(j - 4)) / (4 * k.dt), a, j * k.dt);
      }
    });
    const r = (x) => +x.toFixed(2);
    return { v1: r(top1.v), who1: top1.who, t1: r(top1.t), v4: r(top4.v), who4: top4.who, t4: r(top4.t), jump: r(jump.v), jwho: jump.who, jt: r(jump.t) };
  }
  // (browser tests) a defender who goes by the man with the ball within arm's reach and lets him go: not the tackler,
  // not the broken tackle's man, not a man in a block (one of the offense on him). Every 0.05 s of each hold, from 0.3 s
  // after he has it to 0.3 s before it ends (players saw men run right by a back with no missed tackle called)
  function passCheck(sc, P, e) {
    const segs = P.segs.slice().sort((a, b) => a.t0 - b.t0), keys = new Set((P.keys || []).map((k) => k.a).concat(P.misses || []));
    const out = [];
    segs.forEach((s, i) => {
      if (s.kind !== 'hold' || !s.a) return;
      // (the passer in his pocket, the ball thrown after: the rush on him is pressure, not a man going by)
      if (s.a.label === 'QB' && segs[i + 1] && segs[i + 1].kind === 'fly') return;
      const car = s.a, t1 = (i + 1 < segs.length ? segs[i + 1].t0 : P.T) - 0.3, seen = new Set();
      const yd = (p, q) => Math.hypot((p.x - q.x) / XYD, p.L - q.L);
      for (let t = s.t0 + 0.3; t < t1; t += 0.05) {
        const c = at(car, t);
        sc.actors.forEach((d) => {
          if (!d.trk || d.off === car.off || keys.has(d) || seen.has(d)) return;
          const p = at(d, t), r = yd(p, c);
          if (r >= 1 || (P.sackAt != null && t >= P.sackAt - 0.6)) return;
          if (sc.actors.some((m) => m.off === car.off && m !== car && yd(at(m, t), p) < 1.2)) return;      // in a block
          seen.add(d);
          out.push({ who: d.label, car: car.label, r: +r.toFixed(2), t: +t.toFixed(2), ev: e.ev, evt: e.evt || '', call: e.call, yds: e.yards });
        });
      }
    });
    return out;
  }
  function speedLog(sc, P, e, x) {
    (window.__speedLog = window.__speedLog || []).push({ ev: e.ev, call: e.call, evt: e.evt || '', yards: e.yards, td: !!(e.td || e.tdDef || e.retTd), air: e.air,
      ...(x || {}), ...speedCheck(sc, P) });
  }
  // (browser tests) where the man with the ball was against the goal lines and the sidelines while he had it (P's
  // holds, every 0.05 s to the end of the play): a touchdown is the ball carried (or caught) over the scoring team's
  // goal line inside the sidelines before he is ever out of bounds with it; on any other play nobody carries it over
  // the goal line he scores at; a play out of bounds goes out level with its spot, not before it; a safety is a man
  // down with it in his own end zone, and only a safety, a touchback (a kick, a pick in the end zone) ends with the
  // ball held in the holder's own end zone. Returns the row with its faults (bad: [] when it is drawn right)
  function goalCheck(sc, P, e, two) {
    const dir = sc.dir, gOf = (a) => (a.off === (dir > 0) ? 100 : 0), sgn = (a) => (a.off ? dir : -dir);
    const segs = P.segs.slice().sort((a, b) => a.t0 - b.t0);
    const holds = segs.map((s, i) => ({ s, t1: i + 1 < segs.length ? segs[i + 1].t0 : P.T })).filter((h) => h.s.kind === 'hold' && h.s.a);
    const scoring = !!(e.td || e.tdDef || e.retTd), offScores = !!e.td, bad = [];
    let crossed = null, outFirst = null, deepest = -99, outAt = null, last = null;
    holds.forEach(({ s, t1 }) => {
      for (let t = s.t0; t <= Math.min(t1, P.T) + 1e-9; t += 0.05) {
        const a = s.a, p = at(a, t), past = sgn(a) * (p.L - gOf(a)), inb = p.x >= SX0 && p.x <= SX1;
        const q = { a, past, own: -sgn(a) * (p.L - (100 - gOf(a))), inb, L: p.L, x: p.x, t };
        if (!inb && !outAt) outAt = q;
        if (scoring) {
          if (!crossed && (offScores ? a.off : !a.off) && past > 0) crossed = q;
          if (!crossed && !inb && !outFirst) outFirst = q;
        } else if (!(e.incomplete || e.evt === 'drop')) deepest = Math.max(deepest, past);    // (a ball dropped in the end zone was never carried)
        last = q;
      }
    });
    // (held at the end: the play's last ball is in someone's arms)
    const heldEnd = segs.length && segs[segs.length - 1].kind === 'hold' ? last : null;
    if (scoring) {
      if (!crossed) bad.push('td never carried over the goal line');
      else if (!crossed.inb) bad.push('td crossed out of bounds');
      if (outFirst) bad.push('out of bounds with the ball before the touchdown');
    } else {
      if (deepest > 0) bad.push('carried over the goal line on a play that did not score');
      const b = ballAt(sc, P, P.T), ownOff = -dir * (b.L - (dir > 0 ? 0 : 100));
      if (e.safety && !(ownOff > 0.3)) bad.push('safety not down in his own end zone');
      const tb = e.ev !== 'play' || e.turnover || e.evt === 'interception' || e.touchback;
      if (!e.safety && !tb && heldEnd && heldEnd.own > 0) bad.push('down in his own end zone on a play that was no safety');
      if (e.oob && e.ev === 'play' && !e.turnover && outAt && Math.abs(outAt.L - (sc.losL + dir * (e.yards || 0))) > 1.5) bad.push('out of bounds away from the spot');
    }
    return { ev: e.ev, evt: e.evt || '', td: !!e.td, tdDef: !!e.tdDef, safety: !!e.safety, oob: !!e.oob, two: !!two, call: e.call, yards: e.yards,
      deepest: +deepest.toFixed(2), cross: crossed ? { L: +crossed.L.toFixed(1), x: +crossed.x.toFixed(1), inb: crossed.inb } : null,
      out: outAt ? { L: +outAt.L.toFixed(1), x: +outAt.x.toFixed(1) } : null, bad };
  }
  function ballAt(sc, P, t) {
    let seg = null;
    for (const s of P.segs) if (s.t0 <= t + 1e-9) seg = s;
    if (!seg) return { x: sc.bx, L: sc.losL, z: 0, up: 0, show: true };
    // (in his arms: at his side, on the drawn turf when he is out of bounds)
    if (seg.kind === 'hold') { const p = at(seg.a, t); return { x: Math.min(p.x + 5, SX1 + XYD), L: p.L, z: 0, up: 0, show: true }; }
    if (seg.kind === 'fly') {
      const u = clip((t - seg.t0) / Math.max(seg.t1 - seg.t0, 1e-6), 0, 1);
      const w = seg.d ? dragU(u, seg.d) : u, z = seg.h * 4 * u * (1 - u);
      return { x: lerp(seg.x0, seg.x1, w), L: lerp(seg.L0, seg.L1, w), z, up: seg.lift ? z * BALL_LIFT : 0, show: true };
    }
    return { x: seg.x, L: seg.L, z: 0, up: 0, show: !seg.hide };
  }
  function cast(sc) {
    const off = sc.actors.filter((a) => a.off), def = sc.actors.filter((a) => !a.off);
    const is = (lab) => (a) => a.label === lab;
    return { off, def, qb: off.find(is('QB')), rb: off.find(is('RB')), fb: off.find(is('FB')), recv: off.filter((a) => a.label === 'WR' || a.label === 'TE'),
      ol: off.filter((a) => OL.includes(a.label) || a.label === 'T' || a.label === 'G'),
      rush: def.filter((a) => a.label === 'EDGE' || a.label === 'DL'), cover: def.filter((a) => a.label === 'CB' || a.label === 'S' || a.label === 'LB') };
  }

  // The open man (act.open: no receiver picked). The play is drawn with the ball to the first receiver, what the engine
  // was sent; if another man whose route makes the same call (passCallOf: the side, deep or short, the middle) is more
  // open at the throw in that world, it is drawn again to him (openPick). Presentation only: the result is the
  // engine's either way, and the engine never knew who was drawn
  function choreograph(sc, e, res, two) {
    const act = res && res.action;
    if (two || !act || !act.open || e.team !== G.me || e.ev !== 'play' || e.kind !== PASS || act.target == null || !Array.isArray(act.routes)) return choreo(sc, e, res, two, null);
    const logs = ['__sepLog', '__tackleLog', '__fpLog'], kept = logs.map((k) => (window[k] || []).length);
    const P0 = choreo(sc, e, res, two, act.target);
    const i = P0.openAt ? openPick(sc, e, act, P0.openAt) : act.target;
    if (i === act.target) return P0;
    logs.forEach((k, j) => { if (window[k]) window[k].length = kept[j]; });     // (the tests' logs keep the play drawn)
    return choreo(sc, e, res, two, i);
  }
  // who is open: of the men whose route (as set up, or drawn) makes the call that was played, the one furthest from
  // any defender as the ball is thrown and on its way, his route's depth near the throw's (the real play's air yards)
  function openPick(sc, e, act, o) {
    const E = eligibles(sc), air = e.air ?? AIR[act.call] ?? 7, side = act.roll ? String(act.call).replace(/^roll_/, '') : null;
    const def = sc.actors.filter((a) => !a.off), yd = (a, t) => { const p = at(a, t); return [(p.x - SX0) / XYD, p.L]; };
    const sep = (a, t) => { const q = yd(a, t); return Math.min(...def.map((d) => { const r = yd(d, t); return Math.hypot(r[0] - q[0], r[1] - q[1]); })); };
    const t2 = o.tThrow + Math.min(0.8, o.flight);
    let best = act.target, bs = -Infinity;
    E.forEach((a, i) => {
      const rt = act.routes[i], dr = act.drawn && act.drawn[i] && Number.isFinite(act.drawn[i].depth) ? act.drawn[i] : null;
      if (!rt || a.label === 'QB' || !a.trk || (i !== act.target && act.prot && protMen(sc, act.prot).includes(a))) return;
      if (i !== act.target && passCallOf(sc, a, rt, act.pa, act.roll, dr, side) !== act.call) return;
      const depth = dr ? dr.depth : ROUTE_DEPTH[rt] ?? 6;
      const s = Math.min(6, (sep(a, o.tThrow) + sep(a, t2)) / 2) - 0.2 * Math.abs(depth - air);
      if (s > bs + 1e-9) { bs = s; best = i; }
    });
    return best;
  }
  function choreo(sc, e, res, two, openTo) {
    // a touchdown is the score wherever the real play went out: he crosses the goal line in bounds (the charted run out
    // of bounds drawn nearer the goal is a run into the end zone; players saw a man go to the sideline, then the score)
    if ((e.td || e.tdDef) && e.oob) e = { ...e, oob: false };
    const P = { T: 1, hold: 0.6, segs: [], calls: [], fx: [] };
    const act = res && res.action, mine = e.team === G.me;
    const dir = sc.dir, L0 = sc.losL, bx = sc.bx;
    const fwd = (L, y) => L + dir * y;
    const R = rng(hash('anim', e.row, e.t, e.yards, e.ev));
    const jit = (n) => (R() * 2 - 1) * n;
    const pickOf = (arr) => arr[Math.min(arr.length - 1, Math.floor(R() * arr.length))];
    const say = (t, text, kind, o) => P.calls.push({ t, text, kind, slot: 0, x: bx, L: L0, ...(o || {}) });
    // (lift: a pass, drawn above its shadow by its height)
    const fly = (t0, t1, x0, La, x1, Lb, h, d, lift) => P.segs.push({ t0, t1, kind: 'fly', x0, L0: La, x1, L1: Lb, h: h || 0, d: d || 0, lift: !!lift });
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
    // (the ground: inside the end lines, and no more than a step out of bounds, on the drawn sideline; onTurf, a spot
    // across the field kept on it)
    const SIDES = [-0.8, FW + 0.8], onTurf = (x) => clip(x, SIDES[0], SIDES[1]);
    // a field goal or an extra point: the kicking unit is on the field before the snap (players saw the offense's
    // lineup jog over and the quarterback's dot kick it). The long snapper over the ball, three either side of him
    // shoulder to shoulder, a wing a step outside and back at each end; the holder kneeling 7 yards deep, the kicker
    // two steps behind him and off to the side; the defense's front across the line, one man deep. The dots read LS, H, K
    const kickUnit = e.ev === 'fg' || (e.ev === 'pat' && !two);
    if (kickUnit) {
      const holder = qb || K.off[0], kicker = K.rb || K.off.find((a) => a !== holder);
      const rest_ = K.off.filter((a) => a !== holder && a !== kicker);
      const snapper = K.ol[Math.floor(K.ol.length / 2)] || rest_[0], others = rest_.filter((a) => a !== snapper);
      // (inside the end lines the world keeps everyone in: a kick from the 1 has its deep man short of the end line)
      const at_ = (a, xy, Ly) => { a.x0 = clampX(bx + xy * XYD); a.L0 = clip(Ly, FULL.lo + 1, FULL.hi - 1); a.x = a.x0; a.L = a.L0; };
      const tag = (a, t) => { if (!a) return; let j = a.g.querySelector('text.jn'); if (!j) { j = S('text', { class: 'jn', y: 2.6 }); a.g.append(j); } j.textContent = t; a.g.querySelectorAll('text.nm').forEach((n) => n.remove()); };
      if (snapper) { at_(snapper, 0, fwd(L0, -0.4)); tag(snapper, 'LS'); }
      const slots = [-1.1, 1.1, -2.2, 2.2, -3.3, 3.3];
      others.forEach((a, i) => { if (i < slots.length) at_(a, slots[i], fwd(L0, -0.4)); else at_(a, (i % 2 ? 1 : -1) * 4.3, fwd(L0, -1.2)); });
      at_(holder, 0, fwd(L0, -7)); tag(holder, 'H');
      if (kicker) { at_(kicker, -2.2, fwd(L0, -9.6)); tag(kicker, 'K'); }
      const deep = K.def.filter((a) => a.label === 'S').slice(0, 1), front = K.def.filter((a) => !deep.includes(a));
      front.forEach((a, i) => at_(a, (i - (front.length - 1) / 2) * 1.35, fwd(L0, 0.6)));
      deep.forEach((a) => at_(a, 0, fwd(L0, 13)));
      place(sc);
    }
    const Wd = new Motion.World({ field: [0, FW], ends: [FULL.lo + 0.5, FULL.hi - 0.5], sides: SIDES });
    sc.actors.forEach((a) => { a.trk = null; a.endAt = null; a.b = Wd.add({ id: a.label + (a.p && a.p.num), g: GROUP[a.label] || 'LB', x: yx(a.x0), y: a.L0, spd: 1 + jit(0.035), team: a.off ? 1 : 0 }); });
    const BX = yx(bx);
    let snapAt = 0, frozen = false;            // frozen: the play never started (a flag before the snap)
    const busy = new Set();                    // players with a part in the outcome
    // your defense drawn (act.ddraw): each man you drew runs your line from the snap for up to DDRAW_T seconds (as
    // fast as he can, within his envelope); what the play gives him to do waits for that (drawnT), except a set path
    // (the man the outcome needs: the tackler, the sacker) or a block
    const drawnT = new Map();
    const leg = (a, t, kind, o) => {
      if (!a) return;
      const te = drawnT.get(a);
      Wd.leg(a.b, te && t < te && kind !== 'path' && kind !== 'stick' ? te : t, kind, o);
    };
    const plan = (a, pts, o) => Motion.planPath(pts, a.b.g, { spd: a.b.spd, ...(o || {}) });
    const follow = (a, t, pl) => { leg(a, t, 'path', { plan: pl }); return pl; };
    if (!mine && e.ev === 'play' && act && Array.isArray(act.ddraw)) {
      const D = sc.actors.filter((a) => !a.off);
      act.ddraw.forEach((l) => {
        const a = D[l.k];
        if (!a || !Array.isArray(l.pts) || l.pts.length < 2) return;
        const p0 = l.pts[0], pts = [[a.b.x, a.b.y]].concat(l.pts.slice(1).map((p) => [inX(a.b.x + p[0] - p0[0]), inL(a.b.y + dir * (p[1] - p0[1]))]));
        const pl = plan(a, pts, { eff: 0.92 });
        Wd.leg(a.b, REACT_DEF, 'path', { plan: pl });
        drawnT.set(a, REACT_DEF + Math.min(pl.T, DDRAW_T));
      });
    }
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
        let k = Math.min(4, Math.max(1, s * 0.45)) / s, ux = b.vx, uy = b.vy;
        // (a ball carrier bends his first steps toward where he is going: carried straight on, then turned at a corner,
        // he all but stopped there for a second with nobody near; players saw backs and receivers slow for no reason)
        if (o && o.lim && pts.length) {
          const [tx, ty] = unit(pts[0][0] - b.x, pts[0][1] - b.y), [vx, vy] = unit(b.vx, b.vy), [hx, hy] = unit(vx + tx, vy + ty);
          if (vx * tx + vy * ty > -0.85 && hx * hx + hy * hy > 0.5) { ux = hx * s; uy = hy * s; k *= 0.7; }
        }
        const m = [b.x + ux * k, b.y + uy * k];
        st.push(o && o.lim ? o.lim(m) : m);          // (lim: a ball carrier's momentum never takes him past the spot)
      }
      return follow(a, t, plan(a, st.concat(pts.map((p) => [o && o.past ? p[0] : inX(p[0]), p[1]])), { v0: s, ...(o || {}) }));     // (past: he may run out)
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
    // ball runs it back to the end zone behind the offense, the offense chasing and his teammates trailing him (they
    // stood frozen at the spot); the call-out his as he picks it up ("Fumble!" stayed up the whole return), the
    // touchdown when he gets there, and the camera stays on him there (P.stay: it went back up under the scoreboard)
    function returnTd(rec, t, from, call) {
      const pl = runFrom(rec, t, [[inX(from[0] + jit(8)), defTdL()]], { eff: 0.95 });
      foes(rec).forEach((d) => { if (d !== rec) leg(d, t + 0.3, 'chase', { who: rec.b, gap: 2, eff: 0.9 }); });
      (rec.off ? K.off : K.def).forEach((m) => { if (m !== rec && !busy.has(m)) leg(m, t + 0.25 + R() * 0.3, 'chase', { who: rec.b, gap: 4 + R() * 8, eff: 0.7 + R() * 0.2 }); });
      say(t, call, 'hit', { follow: rec });
      say(t + pl.T, 'Touchdown!', 'hit', { follow: rec });
      P.stay = true;
      return t + pl.T;
    }
    const sidelineX = (x) => (x > FW / 2 ? FW + 0.6 : -0.6);
    // the carrier going for the sideline: he got out (the result), or you called for it and he was stopped short:
    // run down on his way there, as far over as his run took him (a short gain, a few yards toward it)
    const outTry = !e.td && (!!e.oob || !!(act && act.oob && mine));
    const outShort = (x, sx, yds) => inX(x + Math.sign(sx - x) * clip(Math.abs(sx - x) - 1.5 - R() * 1.5, 0, 3 + Math.abs(yds) * 0.8));
    const lastEnd = (t) => { P.T = Math.max(P.T, t); };
    // where the offense's play ends, along the field: a touchdown in the end zone; a safety down in his own end zone,
    // a yard in at least; anything else short of the goal line it was stopped at, and out of his own end zone
    const GOAL = dir > 0 ? 100 : 0, OWN = 100 - GOAL;
    const spotL = (yards) => {
      if (e.td) return tdL();
      const L = inL(fwd(L0, yards));
      if (e.safety) return dir > 0 ? Math.min(L, OWN - 1.2) : Math.max(L, OWN + 1.2);
      return e.turnover ? L : clip(L, Math.min(GOAL, OWN) + 0.6, Math.max(GOAL, OWN) - 0.6);
    };

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
      o = o || {};
      const ol = K.ol.slice(), sch = kind === 'run' ? o.scheme || 'zone' : 'zone', sg = side || 1;
      // a run's blocking: zone, everyone stepping the way of the play; power, counter and trap pull the backside guard
      // (counter the backside tackle too) behind the line to the hole and up through it, the rest blocking down
      // (toward the backside); duo, double teams driving straight ahead. The rushers take the men who stay
      const back = ol.slice().sort((a, b) => sg * (a.b.x - b.b.x));          // from the backside across to the play side
      const pullers = ol.length >= 5 ? (sch === 'counter' ? [back[1], back[0]] : sch === 'power' || sch === 'trap' ? [back[1]] : []) : [];
      const hx = o.hole ? o.hole[0] : BX + sg * 3;
      pullers.forEach((a, k) => {
        const p0 = here(a), hxk = sch === 'trap' ? BX + sg * 1.6 : hx;
        // (the first puller kicks out at the hole; the second wraps up through it, a step behind)
        const pts = [p0, [p0[0] - sg * 0.2, fwd(L0, -1.4)], [hxk - sg * (k ? 1.4 : 0.6), fwd(L0, -1.2)], [hxk + sg * (k ? 0 : 0.7), fwd(L0, k ? 2.4 : 1.2)]];
        follow(a, REACT_OFF, plan(a, pts, { eff: 0.82, v1: 1.2 }));
      });
      ol.forEach((a) => {
        if (pullers.includes(a)) return;
        const x0 = a.b.x, y0 = a.b.y, tackle = a.label === 'LT' || a.label === 'RT';
        const lat = kind !== 'run' ? (tackle ? Math.sign(x0 - BX) * 0.9 : jit(0.3))
          : sch === 'zone' ? side * (1.1 + jit(0.3)) : sch === 'duo' ? jit(0.2) : -sg * (0.8 + jit(0.2));
        const push = sch === 'duo' ? 1.35 : sch === 'zone' ? 1 : 1.15;
        leg(a, REACT_OFF, 'track', { gain: 3, eff: 0.9, fn: (t) => {
          const u = clip((t - REACT_OFF) / 1.6, 0, 1);
          return [x0 + lat * u, y0 + dir * Motion.curveShift(kind, 'OL', t) * push];
        } });
      });
      const stay = ol.filter((a) => !pullers.includes(a));
      rushers.forEach((d) => {
        const blk = nearest(stay, here(d)) || nearest(K.off.filter((a) => a !== qb), here(d));
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
      const free = foes(car).filter((d) => !busy.has(d) || (o.also && o.also.includes(d)));
      const start = here(car), defs = free.length ? free : foes(car);
      const tackled = !o.td && !o.oob && !o.free;
      // going out (o.out: the sideline he goes for, -1 or 1): the spot is never back toward the middle from where he
      // is, or where his momentum takes him
      if (o.out) {
        const sp = vel(car), mx = start[0] + (sp > 1.2 ? (car.b.vx / sp) * Math.min(4, Math.max(1, sp * 0.45)) : 0);
        const far = o.out > 0 ? Math.max(start[0], mx) : Math.min(start[0], mx);
        // (out of bounds: where it takes him, on the drawn turf. Past it, the official's toss to the spot after the
        // whistle, finish, went there: the ball two yards past the sideline after a catch run out of bounds)
        if (o.out * (far - endPt[0]) > 0) endPt[0] = o.oob ? onTurf(far) : inX(far);
      }
      const after0 = tackled ? (o.after ?? (car.label === 'RB' || car.label === 'QB' ? 1.5 + R() : 0.6 + R() * 0.8)) : 0;
      // a short run after the catch with nobody close: he works sideways toward the nearest man, who comes up to
      // make the tackle at the same yard line (never a carrier going down alone in the open; players saw it)
      if (tackled && !o.out && defs.length && dist(start, endPt) < 4) {
        const near_ = defs.slice().sort((a, b) => dist(here(a), endPt) - dist(here(b), endPt))[0], q = here(near_);
        if (dist(q, endPt) > 3) endPt[0] = inX(endPt[0] + clip((q[0] - endPt[0]) * 0.3, -2, 2));   // (a step his way; the man closes the rest, below)
      }
      // to daylight: the middle of the run bends away from where the defense is headed
      const pts = [];
      const span = dist(start, endPt);
      // (forward progress: nothing in his run goes past the spot)
      const fd = car.off ? dir : -dir;          // his forward (a return goes the other way)
      const short = (y) => (o.td ? y : fd > 0 ? Math.min(y, endPt[1]) : Math.max(y, endPt[1]));
      if (o.via) {
        // (a drawn run: on along its line, short of the spot)
        o.via.forEach((p) => { if (fd * (p[1] - start[1]) > 0.5 && fd * (endPt[1] - p[1]) > 0.5) pts.push([inX(p[0]), short(p[1])]); });
      } else if (span > 7 && !o.straight) {
        const tm = Math.min(1.2, span / 14), mid = [start[0] + (endPt[0] - start[0]) * 0.55, start[1] + (endPt[1] - start[1]) * 0.55];
        const [ux, uy] = unit(endPt[0] - start[0], endPt[1] - start[1]);
        let best = mid, bs = -1;
        [-3, -1.5, 0, 1.5, 3].forEach((off) => {
          const c = [inX(mid[0] - uy * off), short(mid[1] + ux * off * 0.2)];
          if (o.out && o.out * (c[0] - mid[0]) < -0.1) return;            // (going out: never back toward the middle)
          const m = Math.min(99, ...defs.map((d) => dist(c, [d.b.x + d.b.vx * tm, d.b.y + d.b.vy * tm])));
          const s = Math.min(m, 6) - Math.abs(off) * 0.4;
          if (s > bs) { bs = s; best = c; }
        });
        pts.push(best);
      }
      const ref = pts.length ? pts[pts.length - 1] : start;
      let [ex, ey] = unit(endPt[0] - ref[0], endPt[1] - ref[1]);
      // forward progress: once he is hit he is driven forward to the spot or goes down sideways at it, never back
      // (the ball is spotted where his forward progress stopped), and he is never met behind where he already got to
      let after = after0;
      if (tackled) {
        const room = fd * (endPt[1] - ref[1]) - 0.2;
        if (fd * ey > 0.25) after = Math.min(after, Math.max(0, room) / (fd * ey));
        if (fd * ey <= 0.25 || after < 0.5) { ex = o.out || Math.sign(endPt[0] - ref[0]) || (endPt[0] < FW / 2 ? 1 : -1); ey = 0; after = Math.min(after0, 0.6 + R() * 0.4); }
      }
      // (inside the sideline, as every run is: the pile below starts where his run ended)
      let contact = tackled ? [inX(endPt[0] - ex * after), endPt[1] - ey * after] : endPt;
      if (tackled && o.out) contact[0] = o.out > 0 ? Math.max(contact[0], start[0]) : Math.min(contact[0], start[0]);     // (going out: met where he is or nearer it)
      let route = dist(start, contact) > 0.6 ? pts.concat([contact]) : [contact];
      // out of bounds: he goes out where the play ends, not before. Up the field inside the sideline, then over it level
      // with the spot (a diagonal to the spot took him over the line yards short of it, then on along the sideline)
      const ahead = fd * (endPt[1] - start[1]);
      if (o.oob && ahead > 1.2) {
        const wx = endPt[0] > FW / 2 ? Math.max(start[0], FW - 0.9) : Math.min(start[0], 0.9), back = Math.min(1.1, ahead * 0.45);
        route = route.slice(0, -1).filter((p) => fd * (endPt[1] - p[1]) > back + 0.8).map((p) => [inX(p[0]), p[1]]).concat([[wx, endPt[1] - fd * back], endPt]);
      }
      // forward progress: his momentum carries him to where he is met at most (the spot, when nobody meets him)
      // (nor over the sideline unless he goes out, nor, going out, back toward the middle: he turns for it at once)
      const lim = o.td ? (p) => [inX(p[0]), p[1]] : (p) => {
        const yy = tackled ? contact[1] : endPt[1], x = o.oob && fd * (endPt[1] - p[1]) < 1 ? p[0] : inX(p[0]);
        return [o.out ? (o.out > 0 ? Math.max(x, start[0]) : Math.min(x, start[0])) : x, fd > 0 ? Math.min(p[1], yy) : Math.max(p[1], yy)];
      };
      // (not tackled and short of the goal line he would score at: slowing as he gets there, so his run out of bounds
      // at the 1 never carries the ball over it)
      const room = fd * ((car.off ? GOAL : OWN) - endPt[1]);
      // he is met still running and the hit stops him (the pile below drives him to the spot); easing
      // up to a jog before anyone got to him read as slowing for no reason, then the defense swarming (a player saw it)
      const V_HIT = 5.5;
      const runO = { eff: o.eff ?? 0.97, v1: tackled ? V_HIT : !o.td && room < 6 ? Math.max(1, room * 1.2) : undefined, lim, past: !!o.oob };
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
      // The same on a short catch-and-run with nobody near (players saw backs at the sideline turn back to the hash to
      // find a tackler): the nearest man breaks on the ball before it arrives and meets him where he is
      // A breakaway run or catch nobody could reach from where the pursuit is now (players saw the carrier ease up in
      // the open for a tackler to arrive): the man with the best angle commits from the moment the carrier got the
      // ball, so he is there when the run ends; the carrier never waits for him
      const stuff = fd * (contact[1] - L0) < 1.5 && o.from < t0 - 0.1, closeIn = !stuff && dist(start, contact) < 8;
      const far = !stuff && !closeIn && reach.length && reach[0].T > tC - t0 + 0.4;
      // (a short catch with the nearest man still 3+ yards off: he broke on the ball, not after it; met late, the
      // receiver stood with the ball waiting for him, players saw it)
      const loose = closeIn && reach.length && dist(here(reach[0].d), contact) > 3;
      if (tackled && o.from != null && (stuff || closeIn || far) && reach.length && (reach[0].T > tC - t0 + 0.1 || loose)) {
        const tf = stuff || far ? Math.max(o.from, REACT_DEF + 0.2) : Math.max(REACT_DEF + 0.2, t0 - 0.8);
        Wd.rewind(tf);
        const pick0 = defs.filter((d) => !stuff || d.b.g !== 'CB').map((d) => ({ d, T: Motion.minTime([here(d), contact], d.b.g, { v0: vel(d), spd: d.b.spd }) }))
          .sort((x, y) => x.T - y.T)[0];
        // (only for a loose man: one who can't be there by the hit stays as he was, the old tackler, in time)
        const pick = pick0 && (reach[0].T > tC - t0 + 0.1 || pick0.T <= tC - tf - 0.15) ? pick0 : null;
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
      // A man who is there a beat late is not open space: he gathers himself and takes the hit (players saw a catch at
      // the sideline with a defender on him turn into a run across the field to no gain)
      if (tackled && reach.length && reach[0].T > tC - t0 + 0.5 && !o.straight && !o.via) {
        const lean = Math.sign(contact[0] - start[0]) || (contact[0] < FW / 2 ? -1 : 1);
        let done = false;
        for (const side of o.out ? [o.out] : [lean, -lean]) {   // (his own side first, all the way out: a cutback is the last resort)
          for (const sh of [3, 6, 9, 12, 16]) {
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
      let tackler = null, tEnd = tC, tGo = t0, B = null, slowed = 0;
      // a man whose way in runs with the carrier, at his side within reach long before he is down, reads as one who
      // could have made the tackle then: he keeps a couple of yards off instead (one in front gives ground and turns
      // as the carrier goes by on the other side), and closes at the end, to `off` from him at tA
      const carAt = (t) => (t < tC || !B ? A.at(Math.min(t, tC) - t0) : B.at(Math.min(t - tC, B.T)));
      const trail = (d, t1, pl, tA, off) => {
        const p = here(d), c = carAt(t1), u0 = unit(p[0] - c[0], p[1] - c[1]), [rx, ry] = unit(contact[0] - start[0], contact[1] - start[1]);
        let close = false;
        for (let t = t1 + 0.3; t < tA - 0.3 && !close; t += 0.1) close = dist(pl.at(t - t1), carAt(t)) < 1.4;
        if (!close) return;
        const d0 = dist(p, c), L1 = Math.max(d0, 2.2), lE = Math.hypot(off[0], off[1]), a0 = Math.atan2(u0[1], u0[0]);
        let da = Math.atan2(Math.sin(Math.atan2(off[1], off[0]) - a0), Math.cos(Math.atan2(off[1], off[0]) - a0));
        const sd = rx * u0[1] - ry * u0[0];                     // (round on his own side of the carrier's line)
        if (sd * da < 0 && Math.abs(sd) > 0.1) da += Math.sign(sd) * 2 * Math.PI;
        leg(d, t1, 'track', { eff: 1, gain: 3, fn: (t) => {
          const u = clip((t - t1) / (tA - t1), 0, 1), q = carAt(t), a = a0 + da * u;
          const l = u < 0.3 ? d0 + (L1 - d0) * (u / 0.3) : L1 + (lE - L1) * ((u - 0.3) / 0.7);
          return [q[0] + Math.cos(a) * l, q[1] + Math.sin(a) * l];
        } });
      };
      if (tackled && reach.length) {
        tackler = reach[0].d;
        (P.keys = P.keys || []).push({ a: tackler, t0 });
        if (reach[0].T > tC - t0 + 0.1) {            // still nobody (the field ran out): he slows in traffic
          slowed = reach[0].T - (tC - t0);
          A = runFrom(car, t0, route, { T: reach[0].T + 0.1, v1: V_HIT, lim });
          tC = t0 + A.T;
        }
        busy.add(tackler);
        // the pile: driven from the contact point to the spot
        B = plan(car, [contact, endPt], { v0: V_HIT, v1: 0, eff: 0.32 });
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
          (P.misses = P.misses || []).push(two_.d);        // (in on the tackle: passCheck)
          const q = here(two_.d), [qx, qy] = unit(endPt[0] - q[0], endPt[1] - q[1]);
          const T2 = Math.max(0.4, tEnd - t0 + 0.12);
          trail(two_.d, t0, runFrom(two_.d, t0, [[endPt[0] - qx * 1.0, endPt[1] - qy * 1.0]], { T: T2 }), t0 + T2, [-qx, -qy]);
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
          (P.misses = P.misses || []).push(miss);
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
        const t1 = Wd.t;
        trail(tackler, t1, runFrom(tackler, t1, [[contact[0] - cx * 0.7, contact[1] - cy * 0.7]], { T: Math.max(0.2, tC - t1) }), tC, [-cx * 0.7, -cy * 0.7]);
        leg(tackler, tC, 'stick', { who: car.b, dx: -cx * 0.75, dy: -cy * 0.75, ease: 0.2 });
        leg(tackler, tEnd + 0.05, 'stand');
      }
      // nobody he goes by gets to him and lets him go (only the broken tackle does): a chaser who would come within
      // arm's reach before the tackle takes a deeper angle, held off further (players saw men run into the coverage)
      // (the man who covered him too, chasing after the catch: only the tackler, the second man in and the broken
      // tackle's man get to him. A man in a block, one of the carrier's own on him, is held where he is)
      const tHit = (tackler ? tC : tEnd) - 0.3, own = (car.off ? K.off : K.def).filter((m) => m !== car), mayHit = new Set([tackler, ...(P.misses || [])]);
      const near = (d) => {
        for (let t = t0 + 0.3; t < tHit; t += 0.1) {
          const q = Wd.posAt(d.b, t);
          if (dist(q, Wd.posAt(car.b, t)) < 1.4 && !own.some((m) => dist(Wd.posAt(m.b, t), q) < 1.2)) return true;
        }
        return false;
      };
      for (let k = 0; k < 3; k++) {
        Wd.run(tHit);
        const close = foes(car).filter((d) => !mayHit.has(d) && near(d));
        if (!close.length) break;
        Wd.rewind(t0);
        close.forEach((d) => leg(d, t0 + 0.15, 'chase', { who: car.b, gap: 3.5 + k * 1.5, eff: 0.8, lead: 0.5 }));
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
      // (tests: standing in the open. How long he moves under 2 yd/s with nobody within 3 yards, before the hit)
      // (and jogging in space: under 60% of his sprint with nobody within 5 yards, after his first step; players saw a
      // carrier slow for no reason in the open, then the defense swarm him. `jog` is how long, in seconds)
      let stall = 0, jog = 0;
      if (tackled && window.__sepLog) {
        const top = (Motion.ENV[car.b.g] || Motion.ENV.RB).top;
        for (let t = t0 + 0.05; t < tC - 0.25; t += 0.05) {
          const a = Wd.posAt(car.b, t - 0.05), b = Wd.posAt(car.b, t), v = dist(a, b) / 0.05, nd = Math.min(...foes(car).map((d) => dist(Wd.posAt(d.b, t), b)));
          if (v < 2 && nd > 3) stall += 0.05;
          if (t > t0 + 0.6 && v < 0.6 * top && nd > 5) jog += 0.05;
        }
      }
      if (tackled && window.__sepLog) (window.__tackleLog = window.__tackleLog || []).push({ stall: +stall.toFixed(2), jog: +jog.toFixed(2), nd: Math.min(...foes(car).map((d) => dist(here(d), here(car)))), free: free.length, tackler: !!tackler, slowed: +slowed.toFixed(2), ev: e.evt || '', yds: e.yards, call: e.call, from: o.from,
        td: dist(tackler ? here(tackler) : [0, 0], here(car)), car: car.label, mine: !!car.off === !!(car.off && G.root.pos === G.me), span: dist(start, endPt), tC: tC - t0, reach: reach.length ? reach[0].T : null });
      if (tackled) leg(car, tEnd, 'stand');
      // (past the whistle: into the end zone on a touchdown; out of bounds, along the sideline no further than the spot)
      else leg(car, tEnd, 'go', { x: endPt[0] + (o.oob ? Math.sign(endPt[0] - FW / 2) * 1.5 : 0), y: endPt[1] + fd * (o.td ? 1.5 : o.oob ? -1.5 : 1), eff: 0.4 });
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
        // (one that went out of bounds, as the engine has it, rolls out over the nearer sideline: the offense keeps it there)
        const outB = !lost && e.oob, f = outB ? [xyEnd[0] < FW / 2 ? -0.6 : FW + 0.6, xyEnd[1] + dir * 1.2] : [inX(xyEnd[0] + jit(2.5)), xyEnd[1] + dir * 1.2];
        fly(tEnd, tEnd + 0.55, px(xyEnd[0]), xyEnd[1], px(f[0]), f[1], 0.3);
        rest(tEnd + 0.55, px(f[0]), f[1]);
        Wd.run(tEnd);
        const rec = lost ? nearest(foes(car), f) : nearest((car.off ? K.off : K.def).filter((m) => m !== car), f) || car;
        if (rec) {
          busy.add(rec);
          // he has it when he gets to it, and never before it is down (a man there first: the ball lay on the turf
          // while he ran the return without it)
          // (out of bounds: he goes out to it, over the sideline: kept on the turf he picked it up short of it, in bounds)
          t = Math.max(tEnd + 0.6, tEnd + 0.12 + runFrom(rec, tEnd + 0.1, [f], { T: 0.6, v1: 0, past: outB }).T);
          hold(t, rec);
          if (lost && e.tdDef) t = returnTd(rec, t, f, 'Scoop and score!');
          else {
            leg(rec, t, 'stand');
            say(t, lost ? `${defName} ball` : outB ? 'Out of bounds' : 'Recovered', lost ? 'hit' : 'info', { slot: 1, follow: rec });
          }
        }
        t += 0.2;
      } else if (e.oob) {
        say(tEnd, 'Out of bounds', 'info', { follow: car });
        // he pulls up past the sideline; the ball goes back to where he went out (an official's toss to the spot). Out
        // just short of the goal line his run carries him on over it: he gives the ball up at once, before he gets there
        const fd = car.off ? dir : -dir, nearG = fd * ((car.off ? GOAL : OWN) - xyEnd[1]) < 4, tT = tEnd + (nearG ? 0.12 : 0.5);
        Wd.run(tT);
        const q = here(car);
        if (nearG || dist(q, xyEnd) > 0.8) { fly(tT, tT + 0.4, px(q[0]), q[1], px(xyEnd[0]), xyEnd[1], 0.12); rest(tT + 0.4, px(xyEnd[0]), xyEnd[1]); t = tEnd + 0.2; }
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
      const side = (a) => (sign ? sign * (a.x0 - bx) > 0 : true);
      // a screen goes to whoever caught the real one: a back, a receiver (bubble or tunnel) or a tight end
      if (id === 'screen') {
        const w = K.recv.filter((a) => a.label === 'WR' && side(a)), t = K.recv.find((a) => a.label === 'TE');
        if (e.who === 'WR' && (w.length || K.recv.some((a) => a.label === 'WR'))) return pickOf(w.length ? w : K.recv.filter((a) => a.label === 'WR'));
        if (e.who === 'TE' && t) return t;
        return K.rb || K.recv[0];
      }
      if (e.who === 'RB') return K.rb || K.recv[0];
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
    // a field landmark ([x from the offense's left, depth]) on the drawn field; on a short field the shell squeezed
    // into the room to the end line (Motion.squeeze: the deep men at the back of the end zone, the rest in proportion)
    const room = dir > 0 ? FULL.hi - L0 : L0 - FULL.lo;
    const markIn = (S_) => {
      const deepest = Math.max(0, ...S_.deep.concat(S_.under).map((m) => m[1]));
      return (m) => [dir > 0 ? m[0] : FW - m[0], fwd(L0, Motion.squeeze(m[1], deepest, room))];
    };
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
      // (a second back you gave a route runs it too)
      const backs = mine && act && act.routes ? eligibles(sc).filter((a) => a.label === 'RB' && a !== K.rb) : [];
      // your protection (act.prot, PROTS): the men it keeps in block and run no route
      const stays = new Set(mine && act && act.prot ? protMen(sc, act.prot) : []), stayIn = (a) => stays.has(a);
      const others = K.recv.concat(backs).filter((a) => a !== tgt && a !== o.passer);
      const runners = [];                     // [actor, route plan] for coverage to read
      const drewFor = (a) => { const k = mine && act && act.drawn ? eligibles(sc).indexOf(a) : -1; return k >= 0 ? act.drawn[k] : null; };
      others.forEach((a, i) => {
        const yours = mine && act && act.routes && eligibles(sc).indexOf(a) >= 0;    // you gave him a route: he runs it
        // a tight end stays in to block against six or more (and now and then otherwise); one you drew a route for runs it
        if (a.label === 'TE' && (stayIn(a) || (!drewFor(a) && (rushers.length >= 6 || (!yours && R() < 0.3))))) {
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
        const out = ei >= 0 ? (act.roll && a === K.rb ? side : outOf(sc, a)) : Math.sign(a.b.x - BX) || side || 1, dr = ei >= 0 && act.drawn ? act.drawn[ei] : null;
        const r = Motion.routeOnField(dr || name, D, a.b.x, out, dir, L0, Math.abs(a.b.y - L0), R());
        const rp = r.pts.map((p) => [inX(p[0]), inL(p[1])]);
        const pl = follow(a, REACT_OFF, plan(a, rp, { eff: 0.86 + R() * 0.1, ...edgeStop(rp) }));
        runners.push([a, pl]);
        leg(a, Math.max(tCatch, tThrow + 0.5) + 0.3 + R() * 0.4, 'stand');
      });
      // the back: blocks when they send five or more (unless you drew him a route), else checks out into the flat
      if (K.rb && K.rb !== tgt && kind !== 'pa' && kind !== 'flea' && !(kind === 'tpass' && (o.passer === K.rb || e.philly))) {
        if ((rushers.length >= 5 && !drewFor(K.rb)) || stayIn(K.rb)) {
          const blitzer = rushers[rushers.length - 1];
          leg(K.rb, REACT_OFF, 'track', { gain: 2.6, eff: 0.85, fn: (t) => {
            const q = Wd.posAt(blitzer.b, t), Q = qbSpot(t);
            return [Q[0] + (q[0] - Q[0]) * 0.5, Q[1] + (q[1] - Q[1]) * 0.5];
          } });
        } else {
          const ei = mine && act && act.routes ? eligibles(sc).indexOf(K.rb) : -1;
          const rbRoute = ei >= 0 && act.routes[ei] ? act.routes[ei] : 'flat';
          const out = ei >= 0 ? outOf(sc, K.rb) : Math.sign(K.rb.b.x - BX) || side, dr = ei >= 0 && act.drawn ? act.drawn[ei] : null;
          const r = Motion.routeOnField(dr || rbRoute, ROUTE_DEPTH[rbRoute] ?? 0, K.rb.b.x, out, dir, L0, Math.abs(K.rb.b.y - L0), R());
          const rp = r.pts.map((p) => [inX(p[0]), inL(p[1])]);
          follow(K.rb, 1.3, plan(K.rb, rp, { eff: 0.75, ...edgeStop(rp) }));
        }
      }
      // coverage: man (trail him a beat behind, a cushion deep) or zone (drop to the landmark), then break on the ball
      const cover = K.def.filter((d) => !rushers.includes(d));
      const rbOut = K.rb && K.rb !== tgt && !stayIn(K.rb) && (rushers.length < 5 || drewFor(K.rb));
      const recvs = K.recv.concat(rbOut ? [K.rb] : []).concat(K.rb === tgt ? [K.rb] : []).concat(backs.filter((a) => a !== o.passer));
      const S_ = Motion.SHELLS[shell] || Motion.SHELLS.cover3, mark = markIn(S_);
      const assigned = new Map(), carry = new Map();         // carry: a deep man running with a vertical
      // the deep men and the verticals: each vertical to the deep man whose lane it runs in, by where it is across the
      // field at his depth, all of them matched at once (one at a time, by straight distance, sent a safety across the
      // field past the corner who had the man, or took the corner's lane for the man inside and left the outside one
      // running free). One left unmatched costs the more the deeper he goes (an underneath man sinks with him instead:
      // fine on a seam at 15, not on a post or a go)
      const laneOf = new Map();
      const xDeep = (pl, D) => { for (let s = 0; s <= pl.T; s += 0.1) { const q = pl.at(s); if (Math.abs(q[1] - L0) >= D) return q[0]; } return pl.at(pl.T)[0]; };
      const laneMatch = (verts, deep) => {
        const xs = verts.map((v) => xDeep(v.pl, 14)), lane = deep.map((d) => (laneOf.get(d) || here(d))[0]);
        const none = verts.map((v) => (v.help ? 0.5 : 1) * (10 + Math.min(40, Math.abs(v.end[1] - L0))));
        let best = null, bc = Infinity;
        const go = (i, used, c, pick) => {
          if (c >= bc) return;
          if (i === verts.length) { bc = c; best = pick.slice(); return; }
          deep.forEach((d, j) => { if (!used.has(j)) { used.add(j); pick.push(j); go(i + 1, used, c + Math.abs(lane[j] - xs[i]), pick); pick.pop(); used.delete(j); } });
          pick.push(-1); go(i + 1, used, c + none[i], pick); pick.pop();
        };
        go(0, new Set(), 0, []);
        return new Map(verts.map((v, i) => [v.a, best && best[i] >= 0 ? deep[best[i]] : null]));
      };
      // a deep man on a vertical: he keeps his depth (a step or two of backpedal) until the man gets to him, then runs
      // with him a cushion over the top, sliding over from his spot (chasing him from the snap brought the safety
      // downhill to meet him, and the receiver ran by him)
      const carryOn = (d, a, t, cush) => {
        const m = laneOf.get(d);
        if (!m) { leg(d, t, 'chase', { who: a.b, gap: cush, eff: 0.92, lead: 0.5 }); return; }
        const room = clip(dir > 0 ? 108 - m[1] : m[1] + 8, 0, 2);
        leg(d, t, 'mirror', { who: a.b, lag: 0.2, dir, los: L0, floor: 0.8, tau: 0.8, y0: m[1], pedal: 0.8, pedalMax: room, cush,
          dx0: m[0] - a.b.x, dx: (Math.sign(BX - a.b.x) || 1) * 0.6, eff: 0.95 });
      };
      if (man) {
        const deepN = S_.deep.length, safeties = cover.filter((d) => d.label === 'S');
        const deepers = safeties.slice(0, deepN);
        deepers.forEach((d, i) => { assigned.set(d, null); laneOf.set(d, mark(S_.deep[i])); leg(d, REACT_DEF, 'go', { ...xy(mark(S_.deep[i])), eff: 0.8 }); });
        const pool = cover.filter((d) => !deepers.includes(d));
        const order = recvs.slice().sort((a, b) => Math.abs(b.b.x - BX) - Math.abs(a.b.x - BX));
        order.forEach((r) => {
          const pref = r.label === 'WR' ? ['CB', 'S', 'LB'] : r.label === 'TE' ? ['S', 'LB', 'CB'] : ['LB', 'S', 'CB'];
          // the best fit by position, but never a man from across the field when one of the next kind is over him (a
          // corner sent 40 yards across to a lone receiver never got there: he ran free)
          let d = null, bc = Infinity;
          pool.forEach((x) => {
            const k = pref.indexOf(x.label);
            if (k < 0 || assigned.has(x)) return;
            const c = dist(here(x), here(r)) + k * 8;
            if (c < bc) { bc = c; d = x; }
          });
          if (!d) return;
          assigned.set(d, r);
          // off coverage: he holds the depth he lined up at, backpedalling (corners and safeties bail at the snap:
          // tracking has corners 1 yard deeper after a second), until the receiver gets to him, then runs with him
          // a beat behind and a cushion over the top, inside leverage; he never comes across the line
          const inside = Math.sign(BX - r.b.x) || 1, db = d.label === 'CB' || d.label === 'S';
          leg(d, REACT_DEF, 'mirror', { who: r.b, lag: 0.28 + R() * 0.12, dir, los: L0, floor: 0.8, tau: 1.0, y0: d.b.y,
            pedal: db ? 1.5 : 0.4, pedalMax: db ? 3 : 1.5, cush: r.label === 'WR' ? 1.4 : 0.9, dx0: d.b.x - r.b.x, dx: inside * 0.7, eff: 0.97 });
        });
        // a receiver with no man on him (more of them than cover men: a blitz) who goes deep: the deep safety comes off
        // his spot and runs with him, the spare man sinks with him if there is no safety (players saw men running free
        // deep while the ball went short). A safety with nobody free in his half helps over the top of the deepest man
        // there, his corner trailing underneath
        const manned = new Set(assigned.values()), freeD = new Set();
        const verts = runners.filter(([a]) => a !== tgt).map(([a, pl]) => ({ a, pl, end: pl.at(pl.T), help: manned.has(a) })).filter((x) => Math.abs(x.end[1] - L0) > 12);
        const lanes = laneMatch(verts, deepers);
        verts.forEach(({ a, help }) => {
          const d = lanes.get(a) || (help ? null
            : nearest(pool.filter((x) => !assigned.has(x) && !freeD.has(x) && x.label !== 'DL' && x.label !== 'EDGE'), here(a)));
          if (!d) return;
          freeD.add(d); if (!help) assigned.set(d, a); carry.set(d, a);
          carryOn(d, a, REACT_DEF + (deepers.includes(d) ? 0.7 : 0.2), help ? 3.5 : Math.abs(catchPt[1] - L0) <= 6 ? 1.3 : 2.2);
        });
        pool.filter((d) => !assigned.has(d)).forEach((d) => {       // the spare: a robber in the middle; a lineman sits short
          if (d.label === 'DL' || d.label === 'EDGE') { leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: fwd(L0, 3.5), eff: 0.6 }); return; }
          const m = S_.under[0] ? mark(S_.under[0]) : [BX, fwd(L0, 7)];
          leg(d, REACT_DEF, 'go', { x: m[0] + jit(2), y: m[1], eff: 0.6 });
        });
      } else {
        const deepPool = cover.filter((d) => d.label === 'S').concat(cover.filter((d) => d.label === 'CB'));
        const deepMarks = S_.deep.map(mark), underMarks = S_.under.map(mark);
        const routesAt = runners.map(([, pl]) => (t) => pl.at(clip(t - REACT_OFF, 0, pl.T)));
        const used = new Set();
        deepMarks.forEach((m) => {
          const d = nearest(deepPool.filter((x) => !used.has(x)), m);
          if (d) { used.add(d); laneOf.set(d, m); leg(d, REACT_DEF, 'go', { x: m[0], y: m[1], eff: 0.85 }); }
        });
        underMarks.forEach((m) => {
          const d = nearest(cover.filter((x) => !used.has(x)), m);
          if (!d) return;
          used.add(d);
          const m0 = [m[0] + jit(1.5), m[1] + jit(1)];
          leg(d, REACT_DEF, 'go', { x: m0[0], y: m0[1], eff: 0.75 });
          // then he works to the routes coming into his area (the nearer the more), a few yards off his spot at most:
          // a zone defender standing on his landmark while a man runs past him reads as nobody covering (players saw
          // men wide open underneath)
          if (routesAt.length) leg(d, REACT_DEF + 1.1, 'track', { gain: 2, eff: 0.8, fn: (t) => {
            let wx = 0, wy = 0, ws = 0;
            routesAt.forEach((f) => {
              const q = f(t), dx = q[0] - m0[0], dy = q[1] - m0[1], w = Math.exp(-(dx * dx + dy * dy) / 72);
              wx += w * dx; wy += w * dy; ws += w;
            });
            const ox = wx / (ws + 0.3), oy = wy / (ws + 0.3), k = Math.min(0.7, 3.5 / (Math.hypot(ox, oy) || 1));
            const y = m0[1] + oy * k;
            return [inX(m0[0] + ox * k), dir > 0 ? Math.max(y, L0 + 3) : Math.min(y, L0 - 3)];
          } });
        });
        cover.filter((d) => !used.has(d)).forEach((d) => leg(d, REACT_DEF, 'go', { x: d.b.x + (BX - d.b.x) * 0.3, y: d.label === 'DL' || d.label === 'EDGE' ? fwd(L0, 3.5) : fwd(d.b.y, 3), eff: 0.6 }));
        // a deep defender carries the vertical in his area: after his drop he runs with the deepest route near him,
        // a cushion over the top (never deep men running free while the ball goes short; players saw it). Tighter
        // when the throw is short: the coverage downfield is why the ball went underneath
        const shortThrow = Math.abs(catchPt[1] - L0) <= 6;
        const deepers = deepMarks.length ? [...used].filter((d) => deepPool.includes(d)).slice(0, deepMarks.length) : [];
        const taken = new Set();
        const verts = runners.map(([a, pl]) => ({ a, pl, end: pl.at(pl.T) })).filter((x) => Math.abs(x.end[1] - L0) > 12)
          .sort((x, y) => Math.abs(y.end[1] - L0) - Math.abs(x.end[1] - L0));
        const lanes = laneMatch(verts, deepers), matched = new Set(lanes.values());
        verts.forEach(({ a }) => {
          // (more verticals than deep men: the nearest underneath defender sinks with the extra one)
          const d = lanes.get(a) || nearest(cover.filter((x) => !taken.has(x) && !matched.has(x) && x.label !== 'DL' && x.label !== 'EDGE'), here(a));
          if (!d) return;
          taken.add(d); carry.set(d, a);
          carryOn(d, a, REACT_DEF + 0.9, shortThrow ? 1.3 : 2.2);
        });
      }
      return { cover, man, assigned, shell, carry };
    }
    const xy = (p) => ({ x: p[0], y: p[1] });
    // How open the target is when the ball gets there (yards to the nearest defender), drawn to fit what really
    // happened. Completion rates climb steeply with separation (NFL Next Gen Stats: tight windows under a yard are
    // completed well under half the time, wide-open throws almost always), so given the outcome: a catch with a
    // long run after it was a man who got loose, an incompletion was mostly a covered man, and the rare open man
    // who didn't catch it got a bad ball (which the play then shows). Buckets in yards, how often throws find each,
    // and the completion rate in each (approximate, after NGS).
    const SEP = [[0.4, 1], [1, 2], [2, 3], [3, 5], [5, 8]], SEP_P = [0.2, 0.27, 0.2, 0.2, 0.13], SEP_C = [0.42, 0.58, 0.7, 0.79, 0.87];
    // How an incompletion misses (missOf). Of 2022-2025's (FTN charting, the play-by-play's passes defensed), 41% were a
    // bad ball nobody got a hand on (not catchable, no pass defensed), 27% broken up (a defender credited with defending
    // it, or a catchable ball contested), 12% thrown away, 11% dropped, 6% nearly intercepted and 4% catchable,
    // uncontested and not caught (off his fingertips). A play the charting missed (and the game's own two-point tries) is
    // drawn at the rates at its depth: [air yards up to, [bad ball, broken up, off his fingertips]], the drops and near
    // picks aside (those are the real play's events)
    const MISS_P = [[0, [0.434, 0.518, 0.048]], [5, [0.521, 0.414, 0.065]], [10, [0.548, 0.399, 0.053]], [15, [0.563, 0.376, 0.061]],
      [20, [0.639, 0.318, 0.043]], [30, [0.693, 0.274, 0.033]], [Infinity, [0.687, 0.284, 0.029]]];
    // which way a bad ball misses, by how he is moving as it comes: no public charting has it (FTN marks a ball
    // uncatchable, not where it went), so the split is ours. Down the field (running along the throw, deep: 15 air yards
    // or more) mostly long, then short; crossing the field mostly behind him or out ahead; standing still (a hitch, a
    // screen) high or low, or wide of him
    const BAD_DIR = { deep: [['over', 0.55], ['under', 0.3], ['wide', 0.15]], vert: [['over', 0.45], ['under', 0.35], ['wide', 0.2]],
      side: [['behind', 0.35], ['ahead', 0.3], ['over', 0.2], ['under', 0.15]], still: [['under', 0.4], ['over', 0.35], ['wide', 0.25]] };
    // (a catcher's hands: where the ball rides with him, at his side; ballAt's hold)
    const handsOf = (p) => [Math.min(p[0] + 5 / XYD, FW + 1), p[1]];
    const hands = (a, t) => handsOf(Wd.posAt(a.b, t));
    // (tests, window.__sepLog: the pass as drawn, once baked, in yards: the ball against the man it went to. A catch or a
    // pick: how far the ball is from his hands as it gets there and just after (gap). A miss: whether it was ever in his
    // hands (held, seconds), how near it came to him while low enough to catch, out of the pocket (low; lowV as the camera
    // draws it, in yards across the field), how far past him it came down
    // along the throw (past), how far ahead of him along his run (lead) or to his side (side) it went by as he got
    // there, how high (zc) and how far from him (reach), the nearest defender to it then (defAt) and to him (defNear),
    // and where it ends up against him (rest))
    function passCheck(row, o) {
      const yd = (x) => (x - SX0) / XYD, d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), r2 = (v) => Math.round(v * 100) / 100;
      const ball = (t) => { const b = ballAt(sc, P, t); return [yd(b.x), b.L, b.z || 0]; };
      const body = (a, t) => { const p = at(a, t); return [yd(p.x), p.L]; };
      const handsAt = (a, t) => { const p = at(a, t); return [yd(Math.min(p.x + 5, SX1 + XYD)), p.L]; };
      const { tgt, by, B0, tThrow, tCatch, M } = o;
      Object.assign(row, { tThrow: r2(tThrow), tCatch: r2(tCatch), t1: M ? r2(M.t1) : null, tEnd: M ? r2(M.tEnd) : null, fit: M ? r2(M.fit) : 0 });
      if (!M) {
        row.gap = r2(Math.max(d2(ball(tCatch - 0.004), handsAt(by, tCatch)), d2(ball(tCatch + 0.06), handsAt(by, tCatch + 0.06))));
        return;
      }
      const Rc = body(tgt, tCatch), w = unit(Rc[0] - B0[0], Rc[1] - B0[1]), n = [-w[1], w[0]];
      const a0 = body(tgt, tCatch - 0.6), a1 = body(tgt, tCatch - 0.3), u = unit(a1[0] - a0[0], a1[1] - a0[1]);
      const t1 = M.t1, Lp = ball(t1 - 0.004), Rl = body(tgt, t1), C = ball(tCatch), segs = P.segs;
      let held = 0, low = 99, lowV = 99;
      const rh = (sc.H - 6) / (P.cam.hi - P.cam.lo) / XYD;          // (the camera's yards along the field to one across)
      segs.forEach((s, i) => { if (s.kind === 'hold' && s.a === tgt && s.t0 > tThrow) held += (i + 1 < segs.length ? segs[i + 1].t0 : P.T) - s.t0; });
      for (let t = tThrow + 0.15; t <= t1; t += 0.02) {
        const q = ball(t), b = body(tgt, t);
        if (q[2] < 0.5 && d2(q, B0) >= 4) { low = Math.min(low, d2(q, b)); lowV = Math.min(lowV, Math.hypot(q[0] - b[0], (q[1] - b[1]) * rh)); }
      }
      Object.assign(row, { held: r2(held), low: r2(low), lowV: r2(lowV), past: r2((Lp[0] - Rl[0]) * w[0] + (Lp[1] - Rl[1]) * w[1]),
        lead: r2((C[0] - Rc[0]) * u[0] + (C[1] - Rc[1]) * u[1]), side: r2(Math.abs((C[0] - Rc[0]) * n[0] + (C[1] - Rc[1]) * n[1])),
        zc: r2(C[2]), reach: r2(d2(C, Rc)), defAt: r2(Math.min(...K.def.map((d) => d2(C, body(d, tCatch))))),
        defNear: r2(Math.min(...K.def.map((d) => d2(body(d, tCatch), Rc)))),
        gap: r2(d2(ball(tCatch - 0.004), handsAt(tgt, tCatch))), rest: r2(d2(ball(P.T), body(tgt, P.T))) });
    }
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
      // (a catch is never made with the man right on him: the tightest window is a contested catch, most of a yard)
      return { sep: caught ? Math.max(0.8, yac < 3 ? Math.min(sep, 1.7 + yac * 0.5) : sep) : Math.min(sep, air >= 15 ? 3 : 3.5), bucket: i };
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
      // his drop or rollout as you drew it (act.qbPath), at least three yards behind the line
      if (mine && act && Array.isArray(act.qbPath) && act.qbPath.length > 1 && kind !== 'tpass' && kind !== 'flea') qpts = [q0].concat(act.qbPath.slice(1).map((p) => [inX(p[0]), fwd(L0, Math.min(p[1], -3))]));
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
      // (the open man: openTo, choreograph's pick; on his own route)
      const ti = mine && act && act.target != null ? (act.open && openTo != null ? openTo : act.target) : null;
      const pick = ti != null ? eligibles(sc)[ti] : null;
      let tgt = philly && passer !== qb ? qb : pick || pickTarget(id, sign) || K.rb;
      if (tgt === passer) tgt = K.recv.filter((a) => a !== passer && a.label !== 'TE').sort((a, b) => Math.abs(b.b.x - BX) - Math.abs(a.b.x - BX))[0] || K.recv.find((a) => a !== passer);
      if (!tgt) return;
      busy.add(tgt);
      const routeName = thrownAway ? 'out' : tgt === qb ? 'flat' : pick && act.route ? (ti === act.target ? act.route : (act.routes && act.routes[ti]) || act.route) : (e.route && Motion.route(e.route, air, 1, 0.5) ? e.route
        : tgt === K.rb ? (kind === 'screen' ? 'screen' : pickOf(['flat', 'angle', 'flat'])) : pickOf(CALL_ROUTE[id === 'quick_middle' ? 'quick_middle' : id === 'deep_middle' ? 'deep_middle' : kind] || ['hitch']));
      const out = pick ? (act.roll && tgt === K.rb ? side : outOf(sc, tgt)) : tgt === K.rb || tgt === qb ? side : (Math.sign(tgt.b.x - BX) || side);
      // a rollout to the flat (the back, or a route to the flat) is thrown on the run, as a sprint-out is designed: the
      // charted time to throw on the real rollout (a median of 4.1 s on a flat: the pool is mostly broken plays, the
      // passer flushed and dumping it off) had him jogging in the flat for seconds (players asked for the flat in time)
      if (kind === 'roll' && !thrownAway && (tgt === K.rb || routeName === 'flat') && tThrow > ROLL_FLAT + 0.3) tThrow = ROLL_FLAT + jit(0.25);
      // forward progress: a completion is caught no deeper than where it is spotted (he is not carried back after it)
      const held = !e.incomplete && e.evt !== 'interception' && e.evt !== 'pick_six' && !e.td;
      const deep = held ? Math.min(air, e.yards ?? air) : air;
      const drew = pick && !thrownAway && tgt !== qb && act.drawn ? act.drawn[ti] : null;      // he runs the line you drew
      const back = Math.abs(tgt.b.y - L0), ru = R(), onField = (nm) => Motion.routeOnField(nm, deep, tgt.b.x, out, dir, L0, back, ru);
      let r = onField(drew || routeName), wide = null;
      // a catch that ends out of bounds was made near that sideline (real ones mostly are, outside the numbers): a
      // route that would leave him too far in for the run after it (a back's, a tight end's, one breaking inside) is
      // drawn breaking out (a short one, or a back's from the backfield: to the flat), caught a few yards from the
      // sideline (the ball thrown when he gets there, below)
      const yacO = (e.yards || 0) - deep, cx0 = inX(r.catchAt[0]);
      if (e.oob && held && !pick && !thrownAway && tgt !== qb && Math.min(cx0, FW - cx0) > yacO + 5) {
        const cx = Math.max(0.5, (out > 0 ? FW - tgt.b.x : tgt.b.x) - clip(2.5 + yacO * 0.4, 2.5, 6)), s = Math.max(deep, 2) + 1.2;
        r = onField(wide = deep <= 2 || (back > 3 && deep <= 8) ? { pts: [[0, -back], [2.2, 1.6 - back], [cx + 2, Math.max(deep, -1) + 0.6]], at: cx - 2.2 }
          : { pts: [[0, -back], [0, s], [cx + 2, s - 1]], at: cx });
      }
      let catchPt = [inX(r.catchAt[0]), inL(fwd(L0, deep))];
      let rpts = r.toCatch.slice(0, -1).map((p) => [inX(p[0]), inL(p[1])]).concat([catchPt]);
      const tStart = tgt === qb ? T_SNAP + 0.6 : tgt === K.rb && kind !== 'screen' ? 0.5 : REACT_OFF;
      // the ball's flight: the length of the throw, from where the quarterback lets it go (on his drop), at the
      // ball's speed for a throw that deep from his arm (ballSpeed)
      const qRel = passer === qb && !philly && kind !== 'flea' ? qPlan.at(Math.max(0, tThrow - T_SNAP)) : null;
      const arm = armOf(passer.p);
      const flightTo = (c) => (qRel ? Math.hypot(c[0] - qRel[0], c[1] - qRel[1]) / ballSpeed(deep, arm) : flight(deep, arm));
      if (wide) tThrow = Math.max(tThrow, tStart + plan(tgt, rpts).T - flightTo(catchPt));
      let tCatch = tThrow + flightTo(catchPt), v1 = !wide && (routeName === 'hitch' || routeName === 'screen') ? 0 : undefined, timed = true;
      // a timing route (a hitch, an out, a dig, a deep out): the throw (when it was charted) is thrown on time, before
      // he turns, and the ball meets him coming out of his break: caught where he is, running flat out, when it gets
      // there, a step or two past the break (never at the end of the route with the ball hanging in the air while
      // he gets there). Thrown late, he is further along the break (a hitch sits down facing the passer and waits).
      const cutK = drew || wide ? null : BREAK_OUT[routeName];
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
        // (he gets to the end of his break after the ball would: the passer holds it until he is there, and it flies
        // at its own speed; the flight stretched to meet him hung the ball in the air for seconds on a deep hitch)
        if (tCatch > tThrow + flightTo(catchPt) + 0.05) tThrow = tCatch - flightTo(catchPt);
        // a hitch on time comes back to the ball; early, he settles facing the passer, and it comes to him
        if (routeName === 'hitch') {
          const sit = plan(tgt, rpts, { v1: 0 });
          v1 = tStart + sit.T <= tCatch ? 0 : undefined;
          timed = v1 === undefined;
        }
      }
      const tp = plan(tgt, rpts, { T: timed ? tCatch - tStart : undefined, v1 });
      // he can't be there when the ball would be (a route drawn deeper than the call's release allows: a hitch drawn
      // on an RPO, thrown at 1.3 s): the quarterback holds it until he can, and the ball flies at its own speed. Before,
      // the flight stretched to wait for him: the ball hung in the air at the line ("it just gets floated")
      if (tp.late > 0.02) { tThrow += tp.late; tCatch += tp.late; }
      follow(tgt, tStart, tp);
      if (act && act.open && mine && !thrownAway && tgt === pick) P.openAt = { tThrow, flight: tCatch - tThrow };
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
      // a man with a receiver of his own: running with a vertical, or on his man
      const onMan = (d) => cov.carry.has(d) || !!(cov.man && cov.assigned.get(d) && cov.assigned.get(d) !== tgt);
      // the coverage on the target fits the outcome: one defender (his man, or the zone defender nearest where the
      // ball is going) closes to the separation drawn above by the time the ball arrives
      const intc = e.evt === 'interception' || e.evt === 'pick_six';
      const caught = !intc && (!e.incomplete || e.evt === 'drop');
      const graded = !thrownAway && kind !== 'hail' && e.evt !== 'throwaway';
      // how it falls incomplete (missOf: the real play's charting), and the coverage to fit: a ball broken up or
      // contested (FTN) had a man right there, one nobody contested a man a step or two off
      let miss = !intc && (e.incomplete || thrownAway) ? missOf() : null;
      const yacD = Math.max(0, (e.yards || 0) - air);
      const sepd = !graded ? null : intc ? { sep: 0.4 + R() * 0.5, bucket: 0 } : miss === 'pick' ? { sep: 0.4 + R() * 0.6, bucket: 0 }
        : miss === 'break' ? { sep: 0.4 + R() * 1, bucket: 1 } : miss && e.contested ? { sep: 0.5 + R() * 1.3, bucket: 1 }
        // (a contested catch, FTN, with little after it: the man on him arrives with the ball)
        : caught && !e.incomplete && e.contested && yacD < 5 ? { sep: 0.8 + R() * 0.9, bucket: 1 }
        : separationFor(caught, yacD, R, air);
      if (sepd && miss && miss !== 'break' && miss !== 'pick' && e.contested === false) sepd.sep = Math.max(1.6, sepd.sep);
      // an off-target ball from a clean pocket went into a tight window: the nearest man a step or two off him as it
      // comes (an open man missed from a clean pocket is not how real misses go: players read it as the game missing
      // open receivers). Pressured (charted), the rush is on the passer as he lets it go (wP, below), and that is why
      if (sepd && miss === 'bad' && !e.pressure) sepd.sep = Math.min(sepd.sep, 1.5 + R() * 0.7);
      let shadow = null;
      if (sepd) {
        // (a man who will be right on him at the ball, contested as charted, broken up, picked: on him from early in the
        // route and as the ball is thrown, never closing from wide open in its flight; one a step or two off closes as
        // it comes)
        const tight = sepd.sep < 2 && (intc || miss === 'break' || miss === 'pick' || !!e.contested);
        const tS = tight ? REACT_DEF + 0.3 : Math.max(REACT_DEF + 0.3, tThrow - 1.6);
        Wd.run(tS);
        const rAt = (t) => tp.at(Math.max(0, t - tStart));
        const end = rAt(tCatch);
        let manOf = null;
        if (cov.man && cov.assigned) for (const [d, r] of cov.assigned) if (r === tgt) manOf = d;
        const near = cov.cover.filter((d) => d.label !== 'DL' && d.label !== 'EDGE').sort((a, b) => dist(here(a), end) - dist(here(b), end));
        // (a deep man running with another vertical stays on him unless he is clearly the one there: taking him off
        // left that receiver running free downfield; when he is, the next man takes the vertical over)
        const loose = near.find((d) => !cov.carry.has(d));
        shadow = manOf || (near[0] && cov.carry.has(near[0]) && loose && dist(here(loose), end) < dist(here(near[0]), end) + 4 ? loose : near[0]) || null;
        const runOn = caught && !e.incomplete && (e.td || (e.yards || 0) - air >= 5);
        const ins = Math.sign(BX - end[0]) || 1, toBreak = (e.incomplete || e.evt === 'near_pick') && e.evt !== 'drop' && !thrownAway && kind !== 'hail' && sepd.sep < 2;
        const span = Math.max(0.3, tCatch - tS), t0 = Wd.t;
        const spanS = tight ? Math.max(0.3, Math.min(tCatch, tThrow + 0.3) - tS) : span;
        const shadowOn = (d) => {
          const r0 = rAt(tS), d0 = here(d);
          const rel0 = [d0[0] - r0[0], d0[1] - r0[1]];
          // where he ends up: trailing (between the receiver and the line) and to the inside in man; in zone, from
          // where he came, closing; at the drawn distance
          // (a ball he will break up: at the receiver's hip rather than trailing, so the step he takes to the ball as
          // it comes is across, not a chase from behind he cannot finish on a ball thrown downfield)
          // (a catch he runs on from: in zone a step late, level with him and on the side away from where his run goes,
          // never in front of him: players saw receivers run straight through the man on them)
          const z = unit(rel0[0], rel0[1]), away = YAC_IN.has(routeName) ? out : YAC_OUT.has(routeName) ? -out : Math.sign(z[0]) || ins;
          const u = cov.man ? (toBreak ? [ins * 0.89, -dir * 0.45] : [ins * 0.55, -dir * 0.83]) : toBreak ? unit((Math.sign(z[0]) || ins) * 0.9, z[1] * 0.5)
            : runOn && dir * z[1] > -0.3 ? unit(away, -dir * 0.3) : z;
          leg(d, tS, 'track', { gain: 3, eff: 1, fn: (t) => {
            const k = clip((t - tS) / spanS, 0, 1), q = rAt(Math.min(t, tCatch));
            return [q[0] + rel0[0] * (1 - k) + u[0] * sepd.sep * k, q[1] + rel0[1] * (1 - k) + u[1] * sepd.sep * k];
          } });
        };
        // the world run on to the catch and back: where everyone would be as the ball gets there
        const probe = (tracks) => {
          Wd.run(tCatch);
          const at = new Map(sc.actors.map((d) => [d, tracks ? { p: here(d), hx: d.b.hx.slice(), hy: d.b.hy.slice() } : here(d)]));
          Wd.rewind(t0);
          return at;
        };
        if (shadow) {
          // the man who closes is one who can get there: when the first choice cannot (he started too far off), the
          // next nearest who can (the separation on the field then is the separation drawn for the outcome)
          const cands = [shadow].concat(near.filter((d) => d !== shadow && !onMan(d)).slice(0, 3));
          const saved = new Map(cands.map((d) => [d, d.b.legs.slice()]));
          let best = null, bErr = Infinity, bD = 0;
          for (const c of cands) {
            shadowOn(c);
            const dc = dist(probe().get(c), end), err = Math.abs(dc - sepd.sep);
            c.b.legs = saved.get(c).slice();
            if (err < bErr - 0.3) { bErr = err; best = c; bD = dc; }
            if (err < 0.6) break;
          }
          shadow = best;
          // (a catch nobody could get near in time, a quick throw out wide: as close as the nearest could get)
          if (caught && !e.incomplete && bD > sepd.sep + 0.6) sepd.sep = bD;
          // (one behind the line with a rusher already on him, a screen that goes nowhere much: the rusher is the man
          // there, and the cover man stays off; a screen he breaks for 8 or more had the rush go past: moved off too)
          if (caught && !e.incomplete && (e.yards || 0) - air < 8) {
            const at = probe(), rs = K.def.filter((d) => !cov.cover.includes(d)), rd = rs.map((d) => dist(at.get(d), end));
            const k = rd.indexOf(Math.min(...rd));
            if (k >= 0 && rd[k] < sepd.sep - 0.4) { sepd.sep = Math.max(0.8, rd[k]); shadow = rs[k]; }
          }
          if (cov.cover.includes(shadow)) shadowOn(shadow);
          busy.add(shadow);
          const left = cov.carry.get(shadow);
          if (left && left !== tgt) {
            const by = near.filter((d) => d !== shadow && !onMan(d))
              .sort((a, b) => dist(here(a), here(left)) - dist(here(b), here(left)))[0];
            if (by) { cov.carry.set(by, left); leg(by, tS, 'chase', { who: left.b, gap: 2.2, eff: 0.95, lead: 0.5 }); }
          }
          // a completion: the man on him is the nearest; anyone else who would be on top of him as the ball comes
          // (a zone defender in the lane, a man on a crossing route, a rusher on a screen behind the line) runs his
          // own way a few yards off instead (players saw catches "in triple coverage" with a long run after them, and
          // screens caught between a rusher and the man on him)
          if (caught && !e.incomplete) {
            const R_ = sepd.sep + 1.2, at = probe(true);
            K.def.forEach((d) => {
              const { p: pe, hx, hy } = at.get(d), dd = dist(pe, end);
              // (a man on another receiver, deep or in man, stays on him unless he is right on top of this one: taken
              // off, his own man ran free. The man on him, when he would close tighter than drawn, eases out to it)
              if (d === shadow ? dd >= sepd.sep - 0.4 : dd >= sepd.sep + 0.5 || (onMan(d) && dd >= 2.5)) return;
              const f = (t) => { const i = clip(Math.round(t / Wd.dt), 0, hx.length - 1); return [hx[i], hy[i]]; };
              const [ux, uy] = dd > 0.2 ? unit(pe[0] - end[0], pe[1] - end[1]) : unit(here(d)[0] - end[0], here(d)[1] - end[1]);
              const push = (d === shadow ? sepd.sep : R_) - dd;
              leg(d, tS, 'track', { gain: 3, eff: 1, fn: (t) => {
                const k = clip((t - tS) / span, 0, 1), q = f(Math.min(t, tCatch)), w = k * k * (3 - 2 * k);
                return [inX(q[0] + ux * push * w), q[1] + uy * push * w];
              } });
            });
          }
          // and nobody left running free downfield as the ball arrives: a man 12 yards out with nobody within 4.5 has his
          // own man (his deep man, his man in man, or the nearest one free of the play) drawn in to a few yards off him
          // (players saw short throws with a receiver all alone deep: the quarterback missed him, or the defense forgot him)
          const at = probe(true), took = new Set([shadow]);
          K.recv.concat(K.rb ? [K.rb] : []).forEach((r) => {
            if (r === tgt || r === passer) return;
            const rp = at.get(r).p;
            if (Math.abs(rp[1] - L0) <= 12 || Math.min(...K.def.map((d) => dist(at.get(d).p, rp))) <= 4.5) return;
            let d = [...cov.carry].find(([, w]) => w === r)?.[0] || (cov.man ? [...cov.assigned].find(([, w]) => w === r)?.[0] : null);
            if (!d || took.has(d)) d = cov.cover.filter((x) => !took.has(x) && !onMan(x) && dist(at.get(x).p, end) > sepd.sep + 2)
              .sort((a, b) => dist(at.get(a).p, rp) - dist(at.get(b).p, rp))[0];
            if (!d || dist(at.get(d).p, rp) > 20) return;
            took.add(d);
            const { p: pd, hx, hy } = at.get(d), dd = dist(pd, rp), [ux, uy] = unit(rp[0] - pd[0], rp[1] - pd[1]), pull = dd - 3;
            const f = (t) => { const i = clip(Math.round(t / Wd.dt), 0, hx.length - 1); return [hx[i], hy[i]]; };
            leg(d, tS, 'track', { gain: 3, eff: 1, fn: (t) => {
              const k = clip((t - tS) / span, 0, 1), q = f(Math.min(t, tCatch)), w = k * k * (3 - 2 * k);
              return [inX(q[0] + ux * pull * w), q[1] + uy * pull * w];
            } });
          });
        }
      }
      // how this throw falls incomplete: as the real play went where it was charted (game_worker.js describe: FTN
      // charting and the play-by-play's passes defensed), else at those plays' rates at its depth (MISS_P)
      function missOf() {
        if (thrownAway) return 'away';
        if (e.evt === 'drop') return 'drop';
        if (e.evt === 'near_pick') return 'pick';
        if (kind === 'hail') return 'hail';
        if (e.catchable !== undefined) return e.defended || (e.contested && e.catchable) ? 'break' : e.catchable ? 'tip' : 'bad';
        const p = MISS_P.find(([a]) => air <= a)[1], u = R();
        return u < p[0] ? 'bad' : u < p[0] + p[1] ? 'break' : 'tip';
      }
      // ---- the miss, made to look like what it was. A bad ball: over him (still above his reach as it gets to him,
      // landing well past), short (it dies in front of him as he pulls up and comes back for it), behind a man on the
      // move (he twists back for it) or out ahead of him (he goes for it), or wide of a man standing still. Broken up:
      // the ball meets the defender's hand between them and is knocked away; nearly picked, it bounces off the
      // defender's hands; off his fingertips, at the end of his dive; dropped, in his hands and out of them. He reacts
      // as the ball comes (his envelope's turns and stops), then its path is fitted to where he really is: out of his
      // reach (and the defenders') until it is down, unless it is one of those it reaches. Worked out on the world run
      // on and back (look); a kind that cannot be drawn there (a man in the way, the sideline) gives way to the next
      // likeliest. Returns the ball's segments to send, the call-out, when and where.
      function missPlan() {
        const t0 = Wd.t, rv = tgt, legs0 = rv.b.legs.slice();
        const look = (t1) => {
          Wd.run(t1);
          const m = new Map(sc.actors.map((a) => [a, [a.b.hx.slice(), a.b.hy.slice()]]));
          Wd.rewind(t0);
          return (a, t) => {
            const [hx, hy] = m.get(a), i = clip(t / Wd.dt, 0, hx.length - 1), j = Math.floor(i), j2 = Math.min(j + 1, hx.length - 1), u = i - j;
            return [hx[j] + (hx[j2] - hx[j]) * u, hy[j] + (hy[j2] - hy[j]) * u];
          };
        };
        const pos0 = look(tCatch + 0.1);
        const R0 = pos0(rv, tCatch), Rb = pos0(rv, tCatch - 0.25), V0 = [(R0[0] - Rb[0]) / 0.25, (R0[1] - Rb[1]) / 0.25], s0 = Math.hypot(V0[0], V0[1]);
        const w = unit(R0[0] - B0[0], R0[1] - B0[1]), nrm = [-w[1], w[0]];
        const u0 = s0 > 0.3 ? [V0[0] / s0, V0[1] / s0] : w;
        const moving = s0 >= 2.5, along = Math.abs(u0[0] * w[0] + u0[1] * w[1]) >= 0.7;
        const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
        const ground = (p) => [clip(p[0], -0.95, FW + 0.95), clip(p[1], FULL.lo + 0.6, FULL.hi - 0.6)];    // (the drawn turf)
        const onGround = (p) => dist(p, ground(p)) < 1e-6;
        let kind0 = miss, late = false;
        // "Broken up" only with a defender really at the ball: when the cover man could not get there in time (he
        // started too far off), it was a bad ball, and it shows (players saw "Broken up" with nobody near)
        // (and at the catch point: within a step and a half of him as it gets there, never a ball knocked away from a man
        // in the open; and never one who was wide open as it was thrown, a defender closing more than 4 yards a second of
        // its flight: players saw "Broken up" with receivers wide open)
        if (miss === 'break' || miss === 'pick') {
          const bd = Math.min(...K.def.map((d) => dist(pos0(d, tCatch), catchPt)));
          if (broke && (bd > 2.5 || dist(pos0(broke, tCatch), R0) > 1.5
            || dist(pos0(broke, tThrow), pos0(rv, tThrow)) > 2.5 + 4 * (tCatch - tThrow))) late = true;
          if (!broke || late) kind0 = 'bad';
        }
        // (the first man there, when nobody broke it up, arrives just after it, on the man it went to)
        const brk = kind0 === 'break' || kind0 === 'pick' ? null : breakers[0];
        if (brk && !thrownAway && miss !== 'drop') leg(brk, Math.max(t0, tCatch - 0.1), 'go', { x: R0[0] + out * 0.5, y: R0[1] + dir * 0.4, eff: 0.7 });
        // the bad ball's way, drawn by how he is moving (BAD_DIR), then the others, likeliest first
        const cls = !moving ? 'still' : along ? (air >= 15 ? 'deep' : 'vert') : 'side';
        const odds = BAD_DIR[cls].slice(), order = [];
        while (odds.length) {
          const tot = odds.reduce((a, x) => a + x[1], 0);
          let u = R() * tot, i = 0;
          while (i < odds.length - 1 && u > odds[i][1]) { u -= odds[i][1]; i++; }
          order.push(odds[i][0]); odds.splice(i, 1);
          if (order.length === 1) odds.sort((a, b) => b[1] - a[1]);      // (after the first, the likeliest)
        }
        const ways = order.flatMap((k) => (k === 'wide' ? ['wide+', 'wide-'] : [k]));
        const kinds = kind0 === 'bad' ? ways : kind0 === 'tip' ? ['tip', ...ways] : kind0 === 'drop' ? ['drop+', 'drop-'] : [kind0];
        const sg = R() < 0.5 ? 1 : -1;             // (wide of him: this side first)
        const jx = jit(0.3), r1 = R(), r2 = R();
        // a flight from his hand to p, landing at t1 (h, d: its arc and drag): where it is, and how high, at time t
        const flightOf = (p, t1, h, d) => (t) => {
          const u = clip((t - tThrow) / Math.max(t1 - tThrow, 1e-3), 0, 1), f = dragU(u, d);
          return [B0[0] + (p[0] - B0[0]) * f, B0[1] + (p[1] - B0[1]) * f, h * 4 * u * (1 - u)];
        };
        // through C as he gets there (tCatch) and on, `ext` yards past it: where it comes down, and when
        const through = (C, ext, d) => {
          const L = Math.max(dist(B0, C), 0.5), k = (L + ext) / L, f = L / (L + ext);
          const uc = d > 1e-6 ? ((1 + d) - Math.sqrt((1 + d) ** 2 - 4 * d * f)) / (2 * d) : f;
          return { p: [B0[0] + (C[0] - B0[0]) * k, B0[1] + (C[1] - B0[1]) * k], t1: tThrow + (tCatch - tThrow) / Math.max(uc, 0.05), uc };
        };
        const ZR = 0.5, REACH = 1.6;               // (out of his reach: above his hands, or more than an arm and a step off)
        // (and out of it as it looks: on a phone a yard across the field is drawn much smaller than a yard along it, the
        // camera's yards along it to one across, rho, about what the play's camera will be; distances `vis` in yards across)
        const rho = clip((sc.H - 6) / clip(Math.abs(catchPt[1] - L0) + 42, 36, 120) / XYD, 1, 3.2);
        // how far the ball, low enough to be caught, comes within reach of who (r yards, and vis as it looks), over its flight
        // once out of the pocket: [in reach, in reach as it looks]
        const inReach = (pos, f, t1, who, r, vis) => {
          let p = 0, v = 0;
          for (let t = tThrow + 0.15; t <= t1 + 1e-9; t += 0.02) {
            const b = f(t);
            if (b[2] >= ZR || dist(b, B0) < 4) continue;
            for (const a of who) {
              const q = pos(a, t), dd = Math.hypot(b[0] - q[0], b[1] - q[1]), dv = Math.hypot(b[0] - q[0], (b[1] - q[1]) * rho);
              p = Math.max(p, r - dd); v = Math.max(v, (vis - dv) * 0.5);
            }
          }
          return [p, v];
        };
        // what he does as it comes, from when he can tell where it is going, and after it (he pulls up: no faster than
        // his envelope stops him)
        const react = (k) => {
          rv.b.legs = legs0.slice();
          const tR = (x) => Math.max(t0, x), wd = k === 'wide+' ? sg : -sg;
          if (k === 'over') { leg(rv, tR(tCatch - 0.25), 'go', { ...xy(add(R0, w, 9)), eff: 1 }); leg(rv, tCatch + 0.3, 'stand'); }       // after it, flat out
          else if (k === 'under') leg(rv, tR(Math.max(tThrow + 0.5 * (tCatch - tThrow), tCatch - 0.9)), 'go', { ...xy(add(R0, w, air >= 15 ? -1.2 : 0.3)), eff: 0.95 });   // pulls up, comes back
          else if (k === 'behind') { leg(rv, tR(tCatch - 0.3), 'go', { ...xy(add(R0, u0, -2.2)), eff: 0.8 }); leg(rv, tCatch + 0.35, 'stand'); }   // twists back for it
          else if (k === 'ahead') { leg(rv, tR(tCatch - 0.3), 'go', { ...xy(add(R0, u0, 5)), eff: 1 }); leg(rv, tCatch + 0.45, 'stand'); }        // goes for it
          else if (k === 'wide+' || k === 'wide-') { leg(rv, tR(tCatch - 0.3), 'go', { x: R0[0] + wd * 1.1, y: R0[1], eff: 0.6 }); leg(rv, tCatch + 0.3, 'stand'); }
          else if (k === 'tip') { leg(rv, tR(tCatch - 0.35), 'go', { ...xy(add(R0, moving ? u0 : nrm, (moving ? 1 : sg) * 2.4)), eff: 1 }); leg(rv, tCatch + 0.3, 'stand'); }   // lays out
          else leg(rv, tCatch + (k === 'drop+' || k === 'drop-' ? 0.2 : 0.1), 'stand');
        };
        const LABEL = { over: air >= 10 ? 'Overthrown' : 'Over his head', under: air >= 10 ? 'Underthrown' : 'In the dirt', behind: 'Behind him',
          ahead: 'Led too far', 'wide+': 'Wide of him', 'wide-': 'Wide of him', tip: 'Off his fingertips', break: 'Broken up', pick: 'Almost picked!',
          'drop+': 'Dropped!', 'drop-': 'Dropped!', away: 'Thrown away', hail: 'Knocked down' };
        // the ball's path for kind k with him (and everyone) where pos has them; s: a little farther off each try.
        // Returns its segments, where the call goes and when, and how far it is from working: hard, what makes it read as
        // k (out of his reach, where k says, on the ground); soft, how it looks (clear of the others, roomy). 0: it does
        const shape = (k, pos, s) => {
          const Rc = pos(rv, tCatch), out_ = { k, segs: [], hard: 0, soft: 0, tSay: tCatch, at: Rc };
          const sum = (a) => a[0] + a[1];
          // (its flight, never past the drawn turf: one that would have to be is all but never the one drawn)
          const main = (p0, t1, h, d) => {
            const p = ground(p0);
            if (dist(p, p0) > 1e-6) out_.hard += 50;
            const [t0, a] = launch(t1, p);            // (at a pass's speed: launch)
            out_.segs.push(['fly', t0, t1, a, p, h, d, true]); out_.f = flightOf(p, t1, h, d); out_.t1 = t1; out_.land = p;
          };
          // (a bounce on from where it really is: off the ground, from where its flight came down, never the spot it was
          // aimed at past the sideline)
          const hop = (t, p0, v, len, h, T) => { const p = ground(p0), q = ground(add(p, v, len)); out_.segs.push(['fly', t, t + T, p, q, h, 0]); return q; };
          const restAt = (t, p) => { out_.segs.push(['rest', t, p]); out_.rest = p; out_.tEnd = t; };
          // (him: out of his reach, and as it looks; everyone else, the defense and his teammates, who it must not look
          // thrown to either)
          const others = sc.actors.filter((a) => a !== rv && a !== passer);
          const clearOfHim = (f, t1, r, vis) => { const [p, v] = inReach(pos, f, t1, [rv], r, vis); out_.hard += p; out_.soft += v; };
          const clearOfAll = (f, t1, r, vis) => { out_.soft += sum(inReach(pos, f, t1, others, r, vis)); };
          // (his way just before he could react: what behind and ahead of him mean)
          const ua = pos(rv, tCatch - 0.6), ub = pos(rv, tCatch - 0.3), ut = unit(ub[0] - ua[0], ub[1] - ua[1]);
          if (k === 'over' || k === 'behind' || k === 'ahead' || k === 'wide+' || k === 'wide-') {
            // (over him: just past him, up where he cannot get a hand to it, as he runs under it)
            const C = k === 'over' ? add(add(Rc, moving ? u0 : w, 1.2), nrm, jx) : k === 'behind' ? add(Rc, u0, -(2.6 + r1 * 0.8 + s * 0.7)) : k === 'ahead' ? add(Rc, u0, 3 + r1 * 0.8 + s * 0.8)
              : [Rc[0] + (k === 'wide+' ? sg : -sg) * (2.6 + r1 * 0.6 + s * 0.7), Rc[1]];             // (wide: to his side, across the field)
            let ext = k === 'over' ? (air >= 15 ? 5 : 3.5) + r2 * 2 + s * 1.5 : k === 'wide+' || k === 'wide-' ? 1.2 + r2 : 2 + r2 * 1.5;
            let T = through(C, ext, arcD);
            for (let i = 0; i < 6 && !onGround(T.p); i++) { ext *= 0.6; T = through(C, ext, arcD); }
            // (over him: above his hands as it gets to him, a short one thrown high enough to be)
            const h = k === 'over' ? Math.max(arcH, 1.15, 1.25 / Math.max(4 * T.uc * (1 - T.uc), 0.05)) : arcH;
            main(T.p, T.t1, h, arcD);
            const v = unit(T.p[0] - B0[0], T.p[1] - B0[1]), q = hop(T.t1, T.p, v, k === 'over' && air >= 15 ? 3 : 1.5, 0.2, 0.35);
            restAt(T.t1 + 0.35, q);
            out_.at = C;
            clearOfHim(out_.f, T.t1, REACH, 2.6);
            clearOfAll(out_.f, T.t1, 1.2, 2);
            const lead = (C[0] - Rc[0]) * ut[0] + (C[1] - Rc[1]) * ut[1];
            if (k === 'behind') out_.hard += Math.max(0, lead + 1.6);
            else if (k === 'ahead') out_.hard += Math.max(0, 1.6 - lead);
            else if (k !== 'over') out_.hard += Math.max(0, 1.9 - dist(C, Rc));
            else {
              const R1 = pos(rv, T.t1), past = (T.p[0] - R1[0]) * w[0] + (T.p[1] - R1[1]) * w[1];
              out_.hard += Math.max(0, 1.6 - past);
              out_.soft += Math.max(0, 2.2 - dist(T.p, R1));
              out_.tSay = Math.min(T.t1, tCatch + 0.15);
            }
            if (k === 'ahead' && Math.min(...[0, 0.1, 0.2, 0.3].map((x) => dist(pos(rv, T.t1 + x), T.p))) < 3.2) out_.dive = T.t1;
          } else if (k === 'under') {
            const tL = tCatch - 0.12, Rl = pos(rv, tL), us = (air >= 15 ? 4.2 + r1 * 1.2 : 1.9 + r1) + s * 0.7;
            const p = add(Rl, w, -us);
            main(p, tL, arcH * 1.15, arcD);
            const q = hop(tL, p, unit(w[0] + nrm[0] * sg * 0.8, w[1] + nrm[1] * sg * 0.8), 0.45, 0.1, 0.3);
            restAt(tL + 0.3, q);
            out_.at = p; out_.tSay = tL;
            // (into the ground in front of him: it may come down at his feet, a step short of his hands)
            const ahead_ = (Rl[0] - p[0]) * w[0] + (Rl[1] - p[1]) * w[1];
            clearOfHim(out_.f, tL, 1.1, 1.8);
            clearOfAll(out_.f, tL, 1.2, 2);
            out_.hard += Math.max(0, 1.5 - ahead_);
          } else if (k === 'tip') {
            // (at the end of his reach the way he is going; each try a little to one side of it, then the other)
            const a0 = [0, 0.6, -0.6, 1, -1, 0.3][s] || 0, d0 = moving ? u0 : [nrm[0] * sg, nrm[1] * sg];
            const dv = [d0[0] * Math.cos(a0) - d0[1] * Math.sin(a0), d0[0] * Math.sin(a0) + d0[1] * Math.cos(a0)], C = add(Rc, dv, 1.3);
            main(C, tCatch, arcH, arcD);
            // (it glances off across his dive, not on along it where he lands; each try the other way, then farther)
            const v = unit(C[0] - B0[0], C[1] - B0[1]), along = v[0] * dv[0] + v[1] * dv[1], pv = [v[0] - dv[0] * along, v[1] - dv[1] * along];
            const off_ = Math.hypot(pv[0], pv[1]) > 0.3 ? unit(pv[0], pv[1]) : [-dv[1], dv[0]], sd = r1 < 0.5 ? 1 : -1;
            const gv = unit(off_[0] * sd + dv[0] * 0.3, off_[1] * sd + dv[1] * 0.3);
            const q1 = hop(tCatch, C, gv, 1.6 + r2 * 0.8 + (s >= 3 ? 0.8 : 0), 0.32, 0.35);
            const q = hop(tCatch + 0.35, q1, gv, 0.7, 0.08, 0.22);
            restAt(tCatch + 0.57, q);
            out_.at = C; out_.dive = tCatch + 0.12;
            clearOfAll(out_.f, tCatch - 0.15, 1, 1.4);
          } else if (k === 'break' || k === 'pick') {
            const D = pos(broke, tCatch), Hh = handsOf(Rc), g = Math.min(k === 'pick' ? 0.25 : 0.55, 0.5 * dist(Hh, D)), Kp = add(D, unit(Hh[0] - D[0], Hh[1] - D[1]), g);
            main(Kp, tCatch, arcH, arcD);
            // (knocked away to one side of its line, or off his hands and up: each try the other side, then farther)
            const v = unit(Kp[0] - B0[0], Kp[1] - B0[1]), sd = (s % 2 ? -1 : 1) * (r1 < 0.5 ? 1 : -1), far = Math.floor(s / 2) * 1.2;
            const rot = (a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
            const q1 = k === 'pick' ? hop(tCatch, Kp, rot(sd * 0.35), 1.4 + r2 + far, 0.6, 0.5) : hop(tCatch, Kp, rot(sd * 0.95), 2.4 + r2 * 1.5 + far, 0.45, 0.45);
            const tq = tCatch + (k === 'pick' ? 0.5 : 0.45), q = hop(tq, q1, v, 0.8, 0.08, 0.25);
            restAt(tq + 0.25, q);
            out_.at = Kp;
          } else if (k === 'drop+' || k === 'drop-') {
            const Hh = handsOf(Rc), tOut = tCatch + 0.16, H2 = handsOf(pos(rv, tOut)), sd = k === 'drop+' ? sg : -sg;
            main(Hh, tCatch, arcH, arcD);
            out_.segs.push(['hold', tCatch]);
            // (it pops off his hands to one side and drops behind him as he runs on)
            const pv = unit(-u0[0] * 0.35 - u0[1] * sd, -u0[1] * 0.35 + u0[0] * sd);
            const q1 = hop(tOut, H2, pv, 1.3 + r2 * 0.5, 0.28, 0.4);
            const q = hop(tOut + 0.4, q1, pv, 0.5, 0.06, 0.2);
            restAt(tOut + 0.6, q);
            out_.at = Hh; out_.tSay = tCatch + 0.1;
          } else if (k === 'hail') {
            main(catchPt, tCatch, arcH, arcD);
            const q = hop(tCatch, catchPt, unit(jit(1), dir), 1.4 + r2, 0.35, 0.4);
            restAt(tCatch + 0.4, q);
            out_.at = catchPt;
          } else {           // thrown away: out of bounds, past the sideline
            main(catchPt, tCatch, arcH, arcD);
            restAt(tCatch, out_.land);
            out_.at = catchPt;
          }
          // (and it lies on the ground clear of him to the end of the play: never ending up in his hands)
          if (out_.rest && k !== 'away') {
            for (let t = out_.tEnd; t <= out_.tEnd + 1.3; t += 0.1) out_.soft += Math.max(0, 1.5 - dist(out_.rest, pos(rv, t))) * 0.2;
            out_.hard += Math.max(0, 1.1 - dist(out_.rest, pos(rv, out_.tEnd + 1.2)));
          }
          out_.bad = out_.hard * 100 + out_.soft;
          return out_;
        };
        // (a near miss of its own kind before a wider one; a wider one of its own kind before the next kind)
        let best = null;
        const seen = new Map();
        for (const ss of [[0, 1, 2], [3, 4, 5]]) {
          for (const k of kinds) {
            if (!seen.has(k)) { react(k); seen.set(k, look(tCatch + 3.2)); }
            for (const s of ss) {
              const o = shape(k, seen.get(k), s);
              if (!best || o.bad < best.bad - 1e-9) best = o;
              if (o.bad <= 1e-9) break;
            }
            if (best.bad <= 1e-9) break;
          }
          if (best.bad <= 1e-9) break;
        }
        react(best.k);
        const k = best.k;
        if (best.dive) down(best.dive, rv);           // (a dive: down where he lands)
        return { kind: k.replace(/[+-]$/, ''), late, text: LABEL[k], tSay: best.tSay, at: best.at, tEnd: best.tEnd, land: best.land, t1: best.t1, rest: best.rest, fit: best.bad,
          send: () => best.segs.forEach((g) => {
            if (g[0] === 'fly') fly(g[1], g[2], px(g[3][0]), g[3][1], px(g[4][0]), g[4][1], g[5], g[6], g[7]);
            else if (g[0] === 'hold') hold(g[1], rv);
            else { rest(g[1], px(g[2][0]), g[2][1]); rest(g[1] + 1.0, px(g[2][0]), g[2][1], true); }
          }) };
      }
      // pressure (charted): the man who beat his block is on the passer as he lets it go, a timed run to his side (the
      // rusher nearest him then: the one who can be there); k yards off him, on him (stick) or closing. The world is
      // left where it was
      const rushHome = (k, stick) => {
        const t0 = Wd.t, tP = Math.max(REACT_DEF + 0.3, tThrow - 1.8);
        if (Wd.t < tThrow) Wd.run(tThrow);
        const q = Wd.posAt(passer.b, tThrow);                // (where he throws from)
        Wd.rewind(tP);                                        // (the world may have been run on past it: back to then)
        const pool = stick ? rushers : K.def.filter((d) => d !== tgt);
        const hr = (pool.map((d) => ({ d, T: Motion.minTime([here(d), q], d.b.g, { v0: vel(d), spd: d.b.spd }) })).sort((x, y) => x.T - y.T)[0] || {}).d || wP;
        if (!hr) { Wd.run(t0); return; }
        const w = here(hr), [ux, uy] = unit(w[0] - q[0], w[1] - q[1]);
        runFrom(hr, tP, [[q[0] + ux * k, q[1] + uy * k]], { T: tThrow + 0.05 - tP, v1: stick ? undefined : 0 });
        if (stick) leg(hr, tThrow + 0.1, 'stick', { who: passer.b, dx: ux * k, dy: uy * k, ease: 0.2 });
        else leg(hr, tThrow + 0.3, 'stand');
        busy.add(hr);
        Wd.run(t0);
      };
      const pocketD = () => { Wd.run(Math.max(Wd.t, tThrow)); return Math.min(...K.def.map((d) => dist(Wd.posAt(d.b, tThrow), Wd.posAt(passer.b, tThrow)))); };
      if (wP && !thrownAway) rushHome(0.9, true);
      // the throw
      Wd.run(tThrow);
      const qT = here(passer);
      // (a throwaway sails out past the sideline it is thrown to: 2.5 yards beyond it, never landing in bounds)
      // (over the sideline, on the drawn turf: never into the stands)
      // (toward the man you picked: thrown away on his side, never looking like a throw to someone else)
      if (thrownAway) { const aw = pick && pick !== passer ? Math.sign(here(pick)[0] - qT[0]) || side : side, sx = sidelineX(qT[0] + aw * 10); catchPt = [sx + Math.sign(sx - FW / 2) * 0.3, inL(fwd(L0, Math.max(3, air)))]; }
      // the ball's flight: from his hand (where he carries it, a step to his side) on a straight line over the ground,
      // in an arc above its shadow (a lofted ball higher and slowing more; a line drive, flatter). It goes out once
      // where it ends is known: in the catcher's hands as he gets there, the picker's, or where the miss takes it
      const B0 = [qT[0] + 4 / XYD, qT[1]];
      const arcH = Math.min(2.4, 0.3 + Math.max(0, air) * 0.055), arcD = air >= 20 ? 0.22 : air > 0 ? 0.14 : 0.08;
      // (always at a pass's speed: where it ends up nearer the passer than the man it was timed for, a pick in front of
      // him, he holds it a moment longer and it flies its own time; stretched to the catch, it hung in the air)
      const launch = (t1, p) => {
        const nat = Math.max(0.3, Math.hypot(p[0] - B0[0], p[1] - B0[1]) / ballSpeed(Math.abs(p[1] - B0[1]), arm));
        if (t1 - tThrow <= Math.max(0.45, nat + 0.15)) return [tThrow, B0];
        const q = Wd.posAt(passer.b, t1 - nat);
        return [t1 - nat, [q[0] + 4 / XYD, q[1]]];
      };
      const throwTo = (t1, p, h, d) => { const [t0, a] = launch(t1, p); fly(t0, t1, px(a[0]), a[1], px(p[0]), p[1], h ?? arcH, d ?? arcD, true); };
      ring(tThrow, passer, false);
      leg(passer, tThrow + 0.15, 'go', { x: qT[0] + jit(1), y: qT[1] + dir * 1.2, eff: 0.25 });
      // the defense breaks on the ball a beat after it is out: the nearest two to where it is going
      // (not a man running with another receiver, deep or in man, unless he is right there: pulled off to the ball,
      // his own man ran free downfield as it arrived)
      const breakers = cov.cover.filter((d) => d === shadow || !onMan(d) || dist(here(d), catchPt) < 4).sort((a, b) => dist(here(a), catchPt) - dist(here(b), catchPt)).slice(0, 2);
      let picker = null;
      if (intc) {
        picker = shadow || breakers[0] || nearest(K.def, catchPt);
        busy.add(picker);
        const pl = runFrom(picker, tThrow + 0.2, [[catchPt[0] - out * 0.4, catchPt[1] - dir * 0.6]], { T: tCatch - tThrow - 0.2 });
        // (late to the spot: the ball waits for him only as long as a real throw that far could take, 10.5 yards a
        // second at the slowest; past that it gets to him where he is, a step short. The flight stretched any longer hung
        // the ball in the air over the line)
        if (pl.late > 0.05) {
          const t0 = tCatch;
          tCatch += pl.late;
          for (let i = 0; i < 3; i++) tCatch = Math.min(tCatch, Math.max(t0, tThrow + Math.max(0.45, dist(B0, hands(picker, tCatch)) / 10.5)));
        }
      }
      // an incompletion has to read as what it was (missOf): broken up, the cover man gets to the ball and gets a hand
      // on it; a bad ball misses where you can see it. Never a dead-open man and a ball that just falls (players called
      // that the game cheating)
      let broke = null;
      if ((miss === 'break' || miss === 'pick') && shadow && sepd && sepd.sep < 2) broke = shadow;            // (he goes for the ball below)
      breakers.forEach((d, i) => {
        if (d === picker || d === broke || d === shadow) return;
        const near_ = dist(here(d), catchPt);
        const yac = Math.abs((e.yards || 0) - air);
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
        const tB = Math.max(Wd.t, tCatch - 1), to = [catchPt[0] - out * 0.25, catchPt[1] + dir * 0.3];
        Wd.run(tB);
        // (already running his way, as a man trailing a receiver is: straight there; runFrom's step along his
        // momentum would carry him past the ball and back)
        const p = here(broke), [ux, uy] = unit(to[0] - p[0], to[1] - p[1]), s = vel(broke);
        // (at speed to the ball as it gets there: a man easing up to it there falls a step behind a receiver in full stride)
        if (s < 1 || (broke.b.vx * ux + broke.b.vy * uy) / s > 0.85) follow(broke, Wd.t, plan(broke, [p, to], { v0: s, T: tCatch - Wd.t + 0.02 }));
        else runFrom(broke, tB, [to], { T: tCatch - tB + 0.02 });
      }
      // the miss: what he does as the ball comes and where it goes (missPlan, worked out on the world run on and back)
      const legsT = tgt.b.legs.slice();
      let M = miss ? missPlan() : null;
      if (M && M.late) broke = null;
      // an off-target ball from a clean pocket: a defender is in the window as it comes (the nearest one who can get
      // there, to a step or two off him as he goes for it), never a man left wide open with the ball sailing past him
      let offT = M && ['over', 'under', 'behind', 'ahead', 'wide'].includes(M.kind);
      if (offT && (!e.pressure || pocketD() > 2.4)) {
        const t0 = Wd.t, sent = new Set();
        // (the nearest who can get there in time, from a moment before the throw; then sooner, another man)
        for (const tW of [tThrow - 0.8, tThrow - 1.6, REACT_DEF + 0.3].map((t) => Math.max(REACT_DEF + 0.3, t))) {
          Wd.run(tCatch);
          // (a ball to a man behind the line, a screen: a rusher who reads it peels off to him; the coverage is too far)
          const Rc = here(tgt), near = K.def.filter((d) => d !== wP && (air <= 2 || !rushers.includes(d))).sort((a, b) => dist(here(a), Rc) - dist(here(b), Rc));
          const far = near.length && dist(here(near[0]), Rc) > 2.2;
          Wd.rewind(t0);
          if (!far) break;
          if (Wd.t > tW) Wd.rewind(tW); else Wd.run(tW);
          const d = near.filter((x) => !sent.has(x)).slice(0, 4).map((x) => ({ x, T: Motion.minTime([here(x), Rc], x.b.g, { v0: vel(x), spd: x.b.spd }) })).sort((a, b) => a.T - b.T)[0];
          if (!d) break;
          const p = here(d.x), [ux, uy] = unit(p[0] - Rc[0], p[1] - Rc[1]), k = 1.5 + R() * 0.6;
          runFrom(d.x, tW, [[inX(Rc[0] + ux * k), Rc[1] + uy * k]], { T: Math.max(0.3, tCatch - tW) });
          busy.add(d.x); sent.add(d.x);
          Wd.rewind(Math.min(Wd.t, t0));
        }
        if (Wd.t < t0) Wd.run(t0);
        // (no defender could get there: the rush closing on the passer as he throws is why it was off)
        const t1 = Wd.t;
        Wd.run(tCatch);
        const clear = Math.min(...K.def.map((d) => dist(here(d), here(tgt))));
        Wd.rewind(t1);
        if (clear > 2.8 && pocketD() > 2.4) rushHome(1.2, false);
        if (Wd.t > t1) Wd.rewind(t1);
        // (a quick throw: nobody could get to either in time. A ball to a man that open, thrown from a clean pocket,
        // got there: he dropped it. The test holds the drawing to it: never an off-target ball to a man 3 yards clear
        // with nobody within 3 of the passer)
        if (clear > 2.8 && pocketD() > 2.9) {
          tgt.b.legs = legsT.slice();
          miss = 'drop'; M = missPlan(); offT = false;
        }
      }
      // (an off-target ball says why: under pressure, or into a tight window)
      // (as drawn: the rush on him, charted or closing as he throws; else the man on the receiver)
      if (offT) {
        const t1 = Wd.t, pd = pocketD();
        Wd.run(Math.max(Wd.t, tCatch));
        const near = Math.min(...K.def.map((d) => dist(Wd.posAt(d.b, tCatch), Wd.posAt(tgt.b, tCatch))));
        if (Wd.t > t1) Wd.rewind(t1);
        const why = e.pressure ? 'Pressured' : pd <= 2.6 ? 'Hurried' : near <= 2.6 ? 'Tight window' : 'Off target';
        M.text = `${why}, ${M.text[0].toLowerCase()}${M.text.slice(1)}`;
      }
      Wd.run(tCatch);
      const ballD = Math.min(...K.def.map((d) => dist(here(d), catchPt)));
      const late = !!(M && M.late);
      // (tests: how open the target really was on the field when the ball got there, against the outcome)
      const sepRow = window.__sepLog ? { evt: e.evt || '', inc: !!e.incomplete, caught, intc, yac: Math.max(0, (e.yards || 0) - air), air,
        late, drawn: sepd && sepd.sep, actual: Math.min(...K.def.map((d) => dist(here(d), here(tgt)))), ballD, kind,
        atThrow: Math.min(...K.def.map((d) => dist(Wd.posAt(d.b, tThrow), Wd.posAt(tgt.b, tThrow)))),
        openDeep: K.recv.filter((a) => a !== tgt && a !== passer && Math.abs(here(a)[1] - L0) > 12 && Math.min(...K.def.map((d) => dist(here(d), here(a)))) > 5).length,
        deep: K.recv.filter((a) => a !== tgt && a !== passer && Math.abs(here(a)[1] - L0) > 12).map((a) => [a.label, +Math.abs(here(a)[1] - L0).toFixed(0), +Math.min(...K.def.map((d) => dist(here(d), here(a)))).toFixed(1)]),
        man: !!cov.man, shell: cov.shell, miss: M ? M.kind : intc ? 'pick6' : 'catch', who: sc.actors.indexOf(tgt), data: e.catchable === undefined ? '' : `${e.catchable ? 'c' : ''}${e.contested ? 'x' : ''}${e.defended ? 'd' : ''}`,
        crowd: K.def.filter((d) => dist(here(d), here(tgt)) < Math.max(2.5, (sepd ? sepd.sep : 0) + 1.5)).length,
        // (an off-target ball, and the rush on the passer as he throws: the nearest defender to him then, in yards)
        bad: !!(M && ['over', 'under', 'behind', 'ahead', 'wide'].includes(M.kind)), press: !!e.pressure,
        pressD: +Math.min(...K.def.map((d) => dist(Wd.posAt(d.b, tThrow), Wd.posAt(passer.b, tThrow)))).toFixed(2) } : null;
      if (sepRow) window.__sepLog.push(sepRow);
      // (tests: where the ball really is, as drawn, against the man it goes to: passCheck, once the play is baked)
      if (sepRow) P.chk = () => passCheck(sepRow, { tgt, by: intc ? picker : tgt, B0, tThrow, tCatch, M });
      // what happened at the catch point
      if (intc) {
        throwTo(tCatch, hands(picker, tCatch));
        hold(tCatch, picker);
        ring(tCatch, picker);
        say(tCatch, 'Intercepted!', 'hit', { follow: picker });
        // picked off in the end zone and the ball comes out at the 20: a touchback. He goes down with it where he is
        if (!e.tdDef && dir * (catchPt[1] - GOAL) > 0.3 && Math.abs(losOf(res.root) - (GOAL - dir * 20)) < 0.5) {
          busy.add(picker);
          Wd.run(tCatch + 0.05);
          const q = here(picker), y = dir > 0 ? clip(q[1] + dir * 0.8, GOAL + 0.6, FULL.hi - 1) : clip(q[1] + dir * 0.8, FULL.lo + 1, GOAL - 0.6);
          leg(picker, tCatch + 0.05, 'go', { x: inX(q[0]), y, eff: 0.35 });
          leg(picker, tCatch + 0.9, 'stand');
          down(tCatch + 0.9, picker);
          say(tCatch + 0.9, 'Touchback', 'info', { slot: 1, follow: picker });
          whistle(tCatch + 0.8, [inX(q[0]), y]);
          lastEnd(tCatch + 2.0);
          return;
        }
        const end = e.tdDef ? [inX(catchPt[0] + jit(10)), defTdL()] : [inX(catchPt[0] + jit(8)), inL(losOf(res.root))];
        // he runs it back the other way: the offense becomes the chasers (the man it was thrown to first of all: he is
        // right there, and makes the tackle on a short return as real receivers do; the picker never waits in the
        // open for a lineman to jog over)
        const tEnd = runDown(picker, tCatch + 0.05, end, { td: e.tdDef, after: 0.6, from: tCatch + 0.05, also: [tgt] });
        if (e.tdDef) say(tEnd, 'Pick-six!', 'hit', { follow: picker });
        else down(tEnd + 0.05, picker);
        lastEnd(tEnd + 1.0);
        return;
      }
      if (M) {
        M.send();
        if (sepRow) sepRow.label = M.text;
        // (the call by him, clear of his way and the ball's: above him, below, or to a side, whichever he is not running
        // toward and the ball did not go; a side that runs off the field the least)
        const Rs = here(tgt), v = [tgt.b.vx, tgt.b.vy], mid = M.rest ? [(M.at[0] + M.rest[0]) / 2, (M.at[1] + M.rest[1]) / 2] : M.at;
        const lw = (M.text.length * 8.5 + 20) / XYD + 2.5, lay = [[{ below: false }, [0, 1]], [{ below: true }, [0, -1]], [{ side: 1 }, [1, 0]], [{ side: -1 }, [-1, 0]]]
          .map(([o, d]) => [o, Math.max(0, v[0] * d[0] + v[1] * d[1]) + 4 * Math.max(0, (mid[0] - Rs[0]) * d[0] + (mid[1] - Rs[1]) * d[1])
            + (d[0] && (Rs[0] + d[0] * lw < 0 || Rs[0] + d[0] * lw > FW) ? 3 : 0) + (d[0] ? 0.3 : 0)])
          .reduce((a, b) => (b[1] < a[1] ? b : a))[0];
        say(M.tSay, two ? `${M.text.replace(/!$/, '')}: no good` : M.text, M.kind === 'pick' ? 'boom' : 'info', { x: px(inX(Rs[0])), L: Rs[1], ...lay });
        whistle(M.tEnd + 0.2, here(tgt));
        lastEnd(M.tEnd + 1.2);
        return;
      }
      // a catch: the ball gets to his hands as he does, and stays in them
      throwTo(tCatch, hands(tgt, tCatch));
      hold(tCatch, tgt);
      ring(tCatch, tgt);
      const yac = e.td ? 99 : fwd(0, fwd(L0, e.yards) - catchPt[1]);
      const endY = spotL(e.yards);
      // after the catch he keeps going the way the route took him: a slant or a dig inside, an out or a flat outside
      const lat = YAC_IN.has(routeName) ? -out : YAC_OUT.has(routeName) ? out : 0;
      const sx = sidelineX(catchPt[0] + out * 2);              // (the nearer sideline; in the middle, his outside one)
      const x0 = inX(catchPt[0] + clip(jit(lat ? 2.5 : 5) + lat * Math.min(Math.abs(yac), 12) * 0.35, -9, 9));
      // a run after the catch goes into the open grass that way: of the lanes to the spot, the one clearest of the
      // defenders (where they are headed), a lane off his line costing a little (players saw a man wide open turn
      // into the coverage)
      const lane = (x) => {
        const s = here(tgt), [ux, uy] = unit(x - s[0], endY - s[1]), len = dist(s, [x, endY]);
        return K.def.reduce((c, d) => {
          const p = [d.b.x + d.b.vx * 0.4, d.b.y + d.b.vy * 0.4], u = clip((p[0] - s[0]) * ux + (p[1] - s[1]) * uy, Math.min(2, len), len);
          return c + Math.max(0, 4 - dist(p, [s[0] + ux * u, s[1] + uy * u])) ** 2;
        }, Math.abs(x - x0));
      };
      const endX = e.oob ? sx : outTry ? outShort(catchPt[0], sx, yac) : Math.abs(yac) < 4 ? x0
        : [-8, -6, -4, -2, 0, 2, 4, 6, 8].map((k) => inX(x0 + k)).reduce((b, x) => (lane(x) < lane(b) ? x : b), x0);
      if (Math.abs(yac) > 4 && !e.bt) say(tCatch, 'Caught', 'boom', { follow: tgt });
      if (shadow) busy.delete(shadow);       // the man on him at the catch is the first who can tackle him
      const ep = [endX, endY], tEnd = runDown(tgt, tCatch, ep, { td: e.td, oob: e.oob, bt: e.bt, from: tCatch, out: outTry ? Math.sign(sx - FW / 2) : 0 });
      finish(tgt, tEnd, ep);
    }

    // ---- the run
    function run(c, id, sign) {
      const carrier = (id === 'qb_sneak' || id === 'qb_run' || e.who === 'QB') ? qb
        : id === 'trick_reverse' ? (K.recv.filter((a) => a.label === 'WR').sort((a, b) => Math.abs(a.x0 - (bx - (sign || 1) * 120)) - Math.abs(b.x0 - (bx - (sign || 1) * 120)))[0] || K.rb || qb)
        : (K.rb || qb);
      const direct = id === 'trick_direct' && carrier !== qb, reverse = id === 'trick_reverse' && carrier !== K.rb;
      if (!carrier) return;
      // your blocking (act.scheme: the Blocking chips), a back's run only
      const scheme = mine && act && act.scheme && /^rb_/.test(id || '') && carrier === K.rb ? act.scheme : 'zone';
      const gap = RUN_GAP[c ? c.base : ''] ?? 26;
      const sg = sign || (id === 'qb_run' ? sc.s * dir : 0) || 0;
      // forward progress: he never has the ball past where it is spotted; on a loss he is met in the backfield
      const cap = e.td ? 99 : (e.yards || 0) - ((e.yards || 0) < 3 ? 1.6 : 0.8), md = Math.min(-4.3, cap - 0.3);
      // going out: an outside or off-tackle run keeps to its side; one inside, with the other sideline the nearer (the
      // short side), is cut back at the line toward it (the line still flows the way it was called)
      const hs = outTry && gap < 40 && sg === (BX < FW / 2 ? 1 : -1) ? -sg : sg;
      let hole = [inX(BX + (hs * gap) / XYD), fwd(L0, Math.min(0.6, cap))];
      // your run as drawn (act.path: [across, past the line] yards, from where he lined up): the hole where it crosses the
      // line, his way there (a counter's step, a sweep's width) and on along it as far as the play went
      const dp = mine && act && Array.isArray(act.path) && act.path.length > 1 ? act.path.slice(1).map((p) => [inX(p[0]), p[1]]) : null;
      const dk = dp ? dp.findIndex((p) => p[1] >= 0) : -1;
      let dBehind = [], dVia = [], dEndX = null;
      if (dk >= 0) {
        const q = dk ? dp[dk - 1] : [here(carrier)[0], -5], p = dp[dk], u = p[1] > q[1] ? -q[1] / (p[1] - q[1]) : 0;
        hole = [inX(q[0] + (p[0] - q[0]) * u), hole[1]];
        // (behind the line no nearer it than where he is met: a loss drawn through a spot ahead of it would have him
        // carry the ball past where it is spotted and be driven back to it)
        dBehind = dp.slice(0, dk).filter((x) => x[1] < -0.3).map((x) => [x[0], fwd(L0, Math.min(Math.max(x[1], -9), cap))]);
        const reach = e.td ? Infinity : (e.yards || 0) - 0.8;
        dVia = dp.slice(dk).filter((x) => x[1] > 1 && x[1] < reach - 0.5).map((x) => [x[0], inL(fwd(L0, x[1]))]);
        for (let k = dk; k < dp.length; k++) {
          if (k && dp[k][1] >= (e.yards || 0) && dp[k - 1][1] < (e.yards || 0)) { const a = dp[k - 1], b = dp[k]; dEndX = a[0] + (b[0] - a[0]) * ((e.yards - a[1]) / (b[1] - a[1] || 1)); break; }
        }
        if (dEndX == null && (e.yards || 0) > 0) dEndX = dp[dp.length - 1][0];
      }
      if (direct) { fly(0, T_SNAP, bx, L0, carrier.x0, carrier.L0, 0.15); hold(T_SNAP, carrier); } else snapToQb();
      busy.add(carrier);
      // one continuous run from his stance through the mesh to the hole, flat out: across the QB's face when the
      // play goes away from his side, downhill when it goes his way; the handoff is when he gets to the mesh
      // (tracking: backs reach the line about 2.5 s after the snap)
      const c0 = here(carrier), q0 = qb ? here(qb) : c0;
      let tMesh = T_SNAP + 0.05, tLos;
      if (direct) {
        // the direct snap: he takes it himself and goes; the quarterback slides out as a decoy
        const pl = follow(carrier, T_SNAP + 0.05, plan(carrier, [c0, ...dBehind, hole], { eff: 0.92 }));
        tLos = T_SNAP + 0.05 + pl.T;
        if (qb) leg(qb, T_SNAP, 'go', { x: inX(q0[0] - (sg || 1) * 6), y: fwd(L0, -2.5), eff: 0.6 });
        say(T_SNAP + 0.2, 'Direct snap', 'info', { follow: carrier });
      } else if (carrier === qb) {
        const pl = follow(qb, T_SNAP + 0.05, plan(qb, [q0, ...dBehind, id === 'qb_sneak' && dk < 0 ? [BX, fwd(L0, Math.min(0.4, cap))] : hole], { eff: 0.92 }));
        tLos = T_SNAP + 0.05 + pl.T;
      } else {
        const across = sg === 0 || Math.sign(hole[0] - q0[0]) !== Math.sign(c0[0] - q0[0]);
        // (drawn: the handoff where his line passes nearest the quarterback)
        const meshPt = dBehind.length ? dBehind.reduce((b, x) => (dist(x, q0) < dist(b, q0) ? x : b))
          : carrier.label === 'WR' ? [q0[0] + (c0[0] > q0[0] ? 1.2 : -1.2), fwd(L0, md + 0.1)]
            : across ? [q0[0] + (c0[0] - q0[0]) * 0.3, fwd(L0, md)] : [c0[0] + (hole[0] - c0[0]) * 0.15, fwd(L0, md)];
        const start = carrier.label === 'WR' ? 0.35 : REACT_OFF;
        // (at speed into the hole whatever the result: the contact, if it comes there, is runDown's; slowing into it
        // left a back jogging at the edge with nobody there)
        // (a counter: a jab step away from the play first, then back across)
        const jab = scheme === 'counter' && !dBehind.length && carrier.label !== 'WR' ? [[c0[0] - (sg || 1) * 1.1, fwd(L0, md - 0.2)]] : [];
        const pl = follow(carrier, start, plan(carrier, [c0, ...jab, ...(dBehind.length ? dBehind : [meshPt]), hole], { eff: carrier.label === 'WR' ? 0.95 : 0.9 }));
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
      lineplay('run', sg, K.rush, { scheme, hole });
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
      const Lend = spotL(e.yards);
      const sx = sidelineX(hs ? (hs > 0 ? FW : 0) : hole[0]);
      const xEnd = e.oob ? sx : outTry ? outShort(hole[0], sx, e.yards) : dEndX != null ? inX(dEndX) : inX(hole[0] + sg * Math.min(9, Math.abs(e.yards) * 0.5) + jit(3));
      const tEnd = runDown(carrier, Math.max(tLos - 0.15, tMesh + 0.2), [xEnd, Lend], { td: e.td, oob: e.oob, bt: e.bt, eff: 0.95, after: e.yards < 2 ? 0.8 + R() : undefined, from: tMesh,
        out: outTry ? Math.sign(sx - FW / 2) : 0, via: dVia.length && !e.oob ? dVia : null });
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
      const Lend = spotL(e.yards), spot = [inX(drop[0] + jit(1.5)), Lend];
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
      // (he gets to where he goes down before he is down: a long way up from the back of his end zone takes longer)
      tS += runFrom(qb, tMove, [spot], { T: tS - tMove, v1: 0 }).late || 0;
      busy.add(rusher);
      (P.misses = P.misses || []).push(rusher); P.sackAt = tS;          // (passCheck: the sack's pile is no pass-by)
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
        if (rec) { busy.add(rec); tRec = Math.max(tS + 0.6, tS + 0.12 + runFrom(rec, tS + 0.1, [f], { T: 0.6, v1: 0 }).T); hold(tRec, rec); }
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
      const coin = R() < 0.5 ? -1 : 1, side = outTry ? (BX > FW / 2 ? 1 : -1) : coin, tE = 2.3 + R() * 0.8;     // (going out: the nearer sideline)
      const q0 = here(qb);
      follow(qb, T_SNAP, plan(qb, [q0, [q0[0], fwd(L0, -7.2)]], { eff: 0.5, v1: 0 }));
      const rushers = rushersOf(e.rushers || 4), front = rushers.filter((d) => K.rush.includes(d));
      // the pocket breaks on the other side: that rusher wins and flushes him out the way he runs
      const flusher = front.slice().sort((a, b) => side * (a.b.x - b.b.x))[0];
      lineplay('pass', side, front, { q: [q0[0], fwd(L0, -7.2)], win: flusher ? new Map([[flusher, tE - 0.45]]) : null });
      passShape({ kind: 'deep', tgt: null, catchPt: [BX, fwd(L0, 10)], tThrow: tE + 1.5, tCatch: tE + 2.5, rushers, shell: shellOf(), side, qbSpot: (t) => Wd.posAt(qb.b, Math.min(t, Wd.t)) });
      Wd.run(tE);
      const Lend = spotL(e.yards);
      const esc = [inX(here(qb)[0] + side * 6), fwd(L0, -6)];
      runFrom(qb, tE, [esc], { eff: 0.9, v1: 5 });
      say(tE, 'Scramble!', 'boom', { follow: qb });
      const sx = sidelineX(esc[0] + side * 10);
      const xEnd = e.oob ? sx : outTry ? outShort(esc[0], sx, e.yards) : inX(esc[0] + side * (4 + R() * 6));
      const tOut = tE + Motion.minTime([here(qb), esc], 'QB', { v0: vel(qb) }) * 1.05;
      // nobody gets a hand on him as he breaks out (only the man who brings him down does): a rusher whose way takes
      // him within reach of the passer as he gets away turns and chases him, a couple of yards off (players saw a
      // scrambler run through the rush)
      for (let k = 0; k < 2; k++) {
        Wd.run(tOut + 0.4);
        const close = K.def.filter((d) => { for (let t = tE + 0.2; t < tOut + 0.4; t += 0.1) if (dist(Wd.posAt(d.b, t), Wd.posAt(qb.b, t)) < 1.5) return true; return false; });
        Wd.rewind(tE);
        if (!close.length) break;
        close.forEach((d) => leg(d, tE + 0.1, 'chase', { who: qb.b, gap: 2.6 + k * 1.2, eff: 0.85, lead: 0.3 }));
      }
      const tEnd = runDown(qb, tOut, [xEnd, Lend], { td: e.td, oob: e.oob, eff: 0.9, after: e.slide ? 0 : undefined, from: tE, out: outTry ? Math.sign(sx - FW / 2) : 0 });
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
      // a foul during the play that the other team turned down: the flag flies, the play stands
      if (e.penOpt && e.penOpt.declined) flag(clip(P.T * 0.45, 0.8, 2.2), `Flag: ${e.penOpt.pen}, declined`);
      bake(P.T + 0.2);
    } else if (e.ev === 'fg' || (e.ev === 'pat' && !two)) {
      specialKick();
    } else if (e.ev === 'punt') {
      punt();
    } else if (e.ev === 'kickoff') {
      kickoff();
    } else return null;
    finishCamera();
    if (P.chk) P.chk();
    return P;

    // ---- special teams
    function specialKick() {
      // field-goal formation: holder 7 yards deep, kicker behind him, nine shoulder to shoulder; the snap at T0
      const T0 = 0.8, hL = fwd(L0, -7), Ly = dir > 0 ? 110 : -10;
      const holder = qb || K.off[0], kicker = K.rb || K.off.find((a) => a !== holder);
      const line = K.off.filter((a) => a !== holder && a !== kicker);
      const deepD = K.def.filter((a) => a.label === 'S').slice(0, 1), front = K.def.filter((a) => !deepD.includes(a));
      // (everyone set where the unit lines up, above; the holder takes the snap kneeling, the kicker steps into it)
      fly(T0, T0 + 0.4, bx, L0, bx, hL, 0.1);
      rest(T0 + 0.4, bx, hL);
      if (kicker) leg(kicker, T0 + 0.45, 'go', { x: yx(bx) - 0.5, y: fwd(L0, -7.7), eff: 0.5 });
      const good = e.ev === 'fg' ? e.made : e.good;
      const miss = good ? 0 : (R() < 0.5 ? -1 : 1);
      const tK = T0 + 1.3, t1 = tK + 0.25 + Math.abs(Ly - hL) / 24;
      // a block (any kick now and then, an extra point too; more often against your all-out rush: picked up, and now
      // and then run back), or a roughing flag
      if ((e.ev === 'fg' || e.ev === 'pat') && (e.blocked || e.foul)) {
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
      // punt formation: seven on the line, gunners split wide, an up-back, the punter 14 yards deep (backed up, at
      // the back of his end zone); the return team: two jammers on the gunners, a returner deep, the rest at the line
      const back = dir > 0 ? L0 - FULL.lo : FULL.hi - L0;
      const T0 = 0.8, pL = fwd(L0, -Math.min(14, back - 1.2)), Lnew = clip(losOf(res.root), -9, 109);
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
      // where it comes down, as the real punt did (engine.js _punt: e.how, e.land): a return from where he fielded it, a
      // fair catch, a punt downed or out of bounds at the spot (one that ends at the 3 was downed there: players saw it
      // caught in the end zone and run back to the 3, and asked to take a knee)
      const how = e.touchback ? 4 : e.how || 0, goalR = dir > 0 ? 100 : 0;
      const land = e.touchback ? (dir > 0 ? 104 : -4) : e.retTd ? fwd(pL, 52) : how === 1 || how === 2 || how === 3 ? Lnew
        : clip(e.land != null && how === 0 ? goalR - dir * e.land : Lnew + dir * 6, -8, 108);
      const lx = how === 3 ? (R() < 0.5 ? SX0 - 0.6 * XYD : SX1 + 0.6 * XYD) : clampX(bx + jit(40));
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
        const bp = [inX(yx(bx) + jit(3)), inL(fwd(pL, -4))];
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
      // (the return men bail right after the snap, ahead of the cover men: going late, they trailed them down the field)
      box.forEach((a) => { leg(a, T0 + 0.2, 'go', { x: a.b.x, y: fwd(L0, -0.4), eff: 0.6 }); leg(a, T0 + 0.8, 'go', { x: a.b.x * 0.5 + LX * 0.5, y: lerp(L0, land, 0.7), eff: 0.85 }); });
      // as the cover men come down on them, the return men turn and each takes one (a wall standing still while the
      // coverage ran through it to the returner read as nobody blocking)
      const taken = new Set();
      box.forEach((a, i) => {
        const tb = tL - 1.6 + i * 0.08, at = lerp(L0, land, 0.7);
        const c = line.filter((b) => !taken.has(b)).sort((u, v) => Math.abs(u.b.x - a.b.x * 0.5 - LX * 0.5) - Math.abs(v.b.x - a.b.x * 0.5 - LX * 0.5))[0];
        if (!c || Math.abs(at - L0) < 15) return;
        taken.add(c);
        leg(a, tb, 'chase', { who: c.b, gap: 0.9, eff: 0.85, lead: 0.4 });
      });
      leg(punter, tK + 0.3, 'go', { x: yx(bx), y: fwd(pL, 6), eff: 0.4 });
      const retSpot = [LX, land];
      // (a punt he lets go: he backs off it, the coverage gets to it where it stops; out of bounds, it goes out)
      const letGo = how === 2 || how === 3;
      runFrom(ret, tL - 1.6, [letGo ? [inX(LX + jit(4)), land + dir * 4] : retSpot], { T: 1.5, v1: 0, eff: 0.6 });
      let t = tL;
      if (letGo) {
        rest(tL, lx, land);
        const g = nearest(gunners, retSpot);
        if (how === 2 && g) { busy.add(g); runFrom(g, tL - 0.3, [[inX(LX + 0.6), fwd(land, -0.6)]], { T: 0.9, v1: 0 }); }
        whistle(tL + 0.5, retSpot);
        t = tL + 0.5;
      } else if (how === 1) {           // a fair catch: he waves, catches it, and that is the spot
        hold(tL, ret);
        ring(tL, ret);
        leg(ret, tL + 0.05, 'stand');
        whistle(tL + 0.2, retSpot);
        t = tL + 0.3;
      } else if (!e.touchback) {
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
      say(t, e.retTd ? 'Punt return touchdown!' : e.touchback ? 'Touchback' : `${['Punt', 'Fair catch', 'Downed', 'Out of bounds'][how] || 'Punt'} · net ${Math.round(e.net || 0)}`, e.retTd ? 'hit' : 'info',
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
      const elo = FULL.lo - EDGE, ehi = FULL.hi + EDGE;
      const frame = (Ls) => {
        let lo = Math.min(...Ls) - 5, hi = Math.max(...Ls) + 5;
        const span = clip(hi - lo, 36, 120), mid = (lo + hi) / 2;
        lo = mid - span / 2; hi = mid + span / 2;
        if (lo < elo) { hi += elo - lo; lo = elo; }
        if (hi > ehi) { lo -= hi - ehi; hi = ehi; }
        return [Math.max(lo, elo), Math.min(hi, ehi)];
      };
      // the man who makes the tackle in the frame from the moment he goes for the carrier (Shane on X: a runner in the
      // open field "stopped" by someone off the screen)
      const keyLs = [];
      (P.keys || []).forEach(({ a, t0 }) => {
        const k = a.trk;
        if (!k) return;
        for (let j = Math.floor(t0 / k.dt); j < Math.min(k.n, Math.ceil(P.T / k.dt) + 1); j += 2) keyLs.push(k.L[j]);
      });
      const old = frame(Ls);
      let [lo, hi] = frame(Ls.concat(keyLs));
      if (window.__sepLog && keyLs.length) {
        const outOf = ([a, b]) => keyLs.filter((L) => L < a || L > b).length / keyLs.length;
        (window.__camLog = window.__camLog || []).push({ before: +outOf(old).toFixed(2), after: +outOf([lo, hi]).toFixed(2), span0: +(old[1] - old[0]).toFixed(1), span: +(hi - lo).toFixed(1) });
      }
      // (the broadcast view: the calls' sheet is away for the play, so the whole play is framed in what shows,
      // under the scoreboard and above the skip note: the quarterback's drop and throw included)
      if (bcast()) {
        const u = 360 / (sc.svg.parentElement.clientWidth || 360), ct = PLAY_COVER.top * u, cb = PLAY_COVER.bot * u;
        const K = (sc.H - 6 - ct - cb) / (hi - lo);
        lo -= cb / K; hi += ct / K;
      }
      P.cam = { lo, hi };
      P.segs.sort((a, b) => a.t0 - b.t0);
      return P;
    }
  }

  // clk: the game clock before the step (t0), at the snap and after the play; the time that runs off before
  // the snap ticks away first (fast, while the players set), then the play's own time as it is run
  // Pre-snap motion (presentation only, like the rest of the drawing): on about four snaps in ten an NFL offense has a
  // man in motion. Here the outside receiver jogs in toward the ball and back out (return motion), the snap coming as he
  // gets back to his spot, so the play runs from where it was charted; the man across from him slides along. Not when a
  // team hurries to the line with the clock running, nor on a kneel, a spike or a flag before the snap. The same play
  // (its row) has the same motion, on a replay too
  function motionOf(sc, e, before, runoff) {
    if (e.ev !== 'play' || (e.kind !== RUN && e.kind !== PASS) || !(e.row >= 0) || (e.penalty && !(e.dur > 0))) return null;
    if (before.clock_running && runoff < 12) return null;
    if ((e.row * 0.6180339887) % 1 >= 0.4) return null;
    const wr = sc.actors.filter((a) => a.off && a.label === 'WR').sort((a, b) => Math.abs(b.x0 - sc.bx) - Math.abs(a.x0 - sc.bx))[0];
    if (!wr) return null;
    const room = Math.abs(wr.x0 - sc.bx) / XYD - 3;
    if (room < 2) return null;
    const dx = Math.sign(sc.bx - wr.x0) * Math.min(5, room) * XYD;
    const cb = sc.actors.filter((a) => !a.off).sort((a, b) => Math.hypot(a.x0 - wr.x0, (a.L0 - wr.L0) * XYD) - Math.hypot(b.x0 - wr.x0, (b.L0 - wr.L0) * XYD))[0];
    return { a: wr, d: cb && Math.abs(cb.x0 - wr.x0) < 6 * XYD ? cb : null, dx };
  }
  function runPlan(sc, P, speed, clk) {
    const runoff = clk ? Math.max(0, clk.t0 - clk.snap) : 0;
    const PRE = Math.max(runoff >= 1 ? clip(0.4 + runoff / 30, 0.55, 1.5) : 0, P.motion ? 1.2 : 0);
    const ZI = 0.6, ZO = 0.5, total = PRE + ZI + P.T + P.hold + ZO, still = reduced();
    // (college overtime in Versus has no clock: the scoreboard keeps its possession, never a clock run over it)
    const ck = clk && !G.cot ? document.querySelector('#bar .clk') : null;
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
        // (reduced motion: the play's frame from the start, held still; no zoom in or out)
        const k = still ? 1 : EASE.io(clip(tt / ZI, 0, 1)) * (P.stay ? 1 : 1 - EASE.io(clip((tt - ZI - P.T - P.hold) / ZO, 0, 1)));
        const c0 = sc.cam0 || FULL;            // from the pre-snap frame into the play's, and back
        sc.cam = { lo: lerp(c0.lo, P.cam.lo, k), hi: lerp(c0.hi, P.cam.hi, k) };
        const tp = clip(tt - ZI, 0, P.T);
        if (ck) {
          const gt = t < PRE ? lerp(clk.t0, clk.snap, EASE.io(t / PRE)) : lerp(clk.snap, clk.end, clip((tt - ZI) / (P.T + P.hold), 0, 1));
          ck.textContent = clockOf(Math.max(gt, clk.end)).text;
          ck.classList.toggle('tick', t < PRE);
        }
        sc.actors.forEach((a) => { const p = at(a, tp); a.x = p.x; a.L = p.L; a.w = p.w; });
        if (P.motion && t < PRE + ZI) {                 // (in and back out before the snap: motionOf)
          const m = P.motion, u = Math.sin(Math.PI * EASE.io(clip(t / (PRE + ZI), 0, 1)));
          m.a.x += m.dx * u;
          if (m.d) m.d.x += m.dx * 0.6 * u;
        }
        Object.assign(sc.ball, ballAt(sc, P, tp));
        P.calls.forEach((c) => { if (!c.shown && tp >= c.t) { c.shown = true; showCall(sc, c); } });
        P.fx.forEach((f) => { if (!f.done && tp >= f.t) { f.done = true; f.f(); } });
        place(sc);
        if (t >= total) {
          if (cutAnim === onTap) cutAnim = null;
          sc.svg.removeEventListener('click', onTap);
          sc.svg.classList.remove('playing');
          playEnd = performance.now();         // (the taps meant for the play, a moment longer: AFTER_PLAY_MS)
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
    if ((!playsOn() && !replay) || (G.fast && !replay) || $('play').hidden) return false;
    const e = res.log.find((x) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(x.ev));
    if (!e) return false;
    const two = e.ev === 'pat' && e.two;
    let sc, P = null, drawnE = e;
    try {
      if (two) {           // a two-point try is a snap from the 2: a pass that scores or does not
        sc = makeScene({ ...before, phase: SNAP, yl: 2, ytg: 2, down: 1 }, side);
        const ci = e.call >= 0 ? e.call : idx.calls.findIndex((c) => c.id === 'quick_strong');
        const run = idx.calls[ci] && idx.calls[ci].kind === 'run';
        const q = run ? { ev: 'play', team: e.team, kind: RUN, call: ci, yards: e.good ? 3 : 0, td: e.good, row: -1, t: before.t }
          : { ev: 'play', team: e.team, kind: PASS, call: ci, yards: e.good ? 4 : 0, air: 4, incomplete: !e.good, td: e.good, row: -1, t: before.t, philly: !!e.philly };
        P = choreograph(sc, q, res, true);
        drawnE = q;
      } else {
        sc = makeScene(before, side, look);
        P = choreograph(sc, e, res, false);
      }
    } catch (err) { console.warn('animation skipped:', err); P = null; }
    if (window.__sepLog && P) {
      const bad = offField(sc, P, (e.ev === 'fg' || (e.ev === 'pat' && !two)) && !e.blocked);
      if (bad.length) (window.__offLog = window.__offLog || []).push({ ev: e.ev, call: e.call, yl: before.yl, mine: e.team === G.me, bad: bad.slice(0, 5) });
      // (the ball against the goal line and the sidelines: goalCheck)
      (window.__goalLog = window.__goalLog || []).push({ ...goalCheck(sc, P, drawnE, two), yl: two ? 2 : before.yl, mine: e.team === G.me });
      (window.__passLog = window.__passLog || []).push(...passCheck(sc, P, drawnE).slice(0, 3));
      // (and the man with the ball goes past the sideline with it on the field just when the engine has the play out of
      // bounds, for its clock: a player saw the other team run out and the clock run on. After the whistle he may walk
      // back on)
      const hold = !two && e.ev === 'play' && !e.incomplete && !e.td && !e.tdDef && !e.turnover && !e.penalty && !e.safety
        ? P.segs.filter((s) => s.kind === 'hold').sort((a, b) => a.t0 - b.t0).pop() : null;
      if (hold) {
        let x = SX0 + 1;
        for (let t = hold.t0; t <= P.T + 1e-9; t += 0.05) { const q = at(hold.a, t).x; if (Math.abs(q - (SX0 + SX1) / 2) > Math.abs(x - (SX0 + SX1) / 2)) x = q; }
        (window.__oobLog = window.__oobLog || []).push({ oob: !!e.oob, shown: x < SX0 || x > SX1, mine: e.team === G.me, call: e.call, evt: e.evt || '', yards: e.yards, x: +x.toFixed(1), running: !!res.root.clock_running });
      }
    }
    // (and nobody on the field runs faster than an NFL player: every man's top speed over the play, frame to frame and
    // over a fifth of a second, and his longest single-frame jump; speedCheck)
    if (window.__sepLog && P) speedLog(sc, P, drawnE, { yl: two ? 2 : before.yl, mine: e.team === G.me, two: !!two });
    // (and every pass in the air flies at a pass's speed: one that hangs, slower than a soft toss, is drawn wrong)
    if (window.__sepLog && P) {
      const pass = P.segs.find((s) => s.kind === 'fly' && s.lift);
      if (pass) {
        const yd = Math.hypot((pass.x1 - pass.x0) / XYD, pass.L1 - pass.L0), dur = pass.t1 - pass.t0;
        if (dur > 0.45 && yd / dur < 10) (window.__floatLog = window.__floatLog || []).push({ call: e.call, yl: before.yl, yd: +yd.toFixed(1), s: +dur.toFixed(2), route: e.route || null });
      }
    }
    scene = sc;
    if (!P) return false;
    sc.svg.querySelectorAll('.nm').forEach((t) => t.classList.add('gone'));     // the names drop at the snap
    // the clock at the snap: after the runoff, or after a timeout called before it (a kick to win), else as it was
    const k0 = res.log.findIndex((x) => x.ev !== 'runoff' && x.ev !== 'timeout');
    const pre = k0 < 0 ? res.log : res.log.slice(0, k0), ro = pre.find((x) => x.ev === 'runoff');
    const tos = pre.filter((x) => x.ev === 'timeout'), snapT = ro ? ro.t : tos.length ? tos[tos.length - 1].t : before.t;
    const clk = { t0: before.t, snap: snapT, end: Math.min(res.root.t, snapT) };
    P.motion = two || curMotion(before) ? null : motionOf(sc, e, before, before.t - snapT);
    await runPlan(sc, P, PLAY_SPEED * (playSpeed() || 1), clk);
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
    const f = formation(offLineup(offI).slice(), lineup(1 - offI).def.slice(), s, bx, offI === G.me ? G.form : null);
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
        const ch = el('span', 'chipn', String(p.ovr)); rateChip(ch, p.ovr);
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
    deepFocus = document.activeElement;           // (its own: a player's sheet opened over it keeps lastFocus)
    $('deep').hidden = false;
    $('deepClose').focus();
  }
  function closeDeep() { $('deep').hidden = true; if (deepFocus && deepFocus.focus) deepFocus.focus(); }

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
    restartSync();
    const r = G.root, b = $('bar');
    b.textContent = '';
    const side = (i, right) => {
      const c = code(i), d = el('span', `tm${right ? ' r' : ''}`);
      const sw = el('span', 'tsw'); sw.style.background = color(c);
      const meta = el('span');
      const tos = el('span', 'tos');
      // (the one just called flashes while the clock is stopped for it)
      for (let k = 0; k < 3; k++) tos.append(el('i', k < r.to[i] ? '' : r.timeout && r.timeout.team === i && k === r.to[i] ? 'used just' : 'used'));
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
      // (an overtime decided with time left: FINAL/OT, no clock, not a 0:00 that never ran)
      el('span', `clk${r.clock_running && !over ? ' run' : ''}`, over && r.ot ? '' : over || r.untimed ? '0:00' : ck.text));
    b.append(side(1, false), mid, side(0, true));
    b.setAttribute('aria-label', `${code(1)} ${r.score[1]}, ${code(0)} ${r.score[0]}, ${ck.text} left in ${r.ot ? 'overtime' : `the ${ordinal(ck.q)} quarter`}. Game details`);
    const dd = $('dd');
    dd.textContent = '';
    if (r.phase === SNAP) {
      dd.append(el('b', '', r.try2 ? 'Two-point try' : ddText(r)), ' · ', el('span', 'sp', spotText(r)));
      // (the clock its own piece: on a phone it takes a line of its own, never cut to "clock sto…", game.html)
      // (why it is stopped, when a timeout stopped it or no time is left)
      if (!VS) { const ck = el('span', 'ck'); ck.append(el('span', 'sep', ' · '), r.untimed ? 'untimed down' : r.timeout ? 'stopped (timeout)' : `clock ${r.clock_running ? 'running' : 'stopped'}`); dd.append(ck); }
    }
    else dd.textContent = r.phase === PAT ? `Try after the touchdown${ck.text === '0:00' ? ' (untimed)' : ''}` : r.phase === KICKOFF ? 'Kickoff' : r.t >= 1800 ? 'Halftime' : 'Final';
  }
  function drawAll() { drawTiles(); drawBar(); drawField(); }
  function show(which) {
    // (a phone playing: the broadcast view, game.html; the page under it starts from the top again after)
    const bc = which === 'play';
    if (bc !== document.body.classList.contains('bcast')) { document.body.classList.toggle('bcast', bc); window.scrollTo(0, 0); if (!bc) sheetDown(false); placeToast(); }
    $('arch').hidden = which !== 'arch';
    $('homeview').hidden = which !== 'home';
    $('intro').hidden = which !== 'intro';
    $('play').hidden = which !== 'play';
    $('done').hidden = which !== 'done';
    $('boot').hidden = which !== 'boot';
    restartSync();
    ezDrive(which === 'play');
  }

  function addLog(text, t, mine) {
    const li = el('li');
    li.append(el('span', 't', t == null || G.cot ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
    $('pbp').prepend(li);
    G.log.push([text, t, !!mine]);
    return li;
  }
  // any play of the drive again, from its line in the play-by-play (this visit only: the plays are not saved)
  function reelKey(li, lp) {
    const b = el('button', 'reel', '↻');
    b.type = 'button';
    b.setAttribute('aria-label', 'Watch this play again');
    b.addEventListener('click', () => replay(lp));
    li.lastChild.append(' ', b);
  }
  function restoreLog() {
    $('pbp').textContent = '';
    G.log.forEach(([text, t, mine]) => {
      const li = el('li');
      li.append(el('span', 't', t == null || G.cot ? '' : clockOf(t).text), el('span', mine ? 'me' : '', text));
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
    // their drive: skip ahead to your next call. On a phone the sheet is away while a play runs, so a second button sits
    // on the field beside "Tap to skip" (the one in the sheet was out of reach); it cuts the play running too
    const fb = $('skipBtn');
    if (fb) fb.hidden = !skip;
    if (skip) {
      const c = el('button', 'chip', 'Skip ahead');
      c.type = 'button';
      const go = () => { G.fast = true; c.disabled = true; if (fb) fb.hidden = true; };
      c.addEventListener('click', go);
      if (fb) fb.onclick = () => { go(); if (cutAnim) cutAnim(); };
      d.append(c);
    }
  }
  function fatal(msg) {
    show('play');
    const d = $('dock');
    d.textContent = '';
    d.append(el('p', 'err', msg));
    say(msg);
  }
  // what a screen reader hears (game.html #say, the one live region): a play's result, a warning, a toast. Said once:
  // a key (the warning drawn again with the dock, the same spot) says it only the first time
  function say(text, key) {
    const s = $('say');
    if (!s || !text || (key && key === say.key)) return;
    say.key = key || null;
    s.textContent = '';
    setTimeout(() => { s.textContent = text; }, 50);           // (emptied first: the same words again are news again)
  }
  // Played from a keyboard: the dock redraws under the key just pressed (a call, Next play), and focus fell back to the
  // top of the page, the 22 players on the field between it and the next call. It goes on to the dock's next step
  // instead: the final card's button or Next play, else a pass's Snap key, the receivers or the first call; the day's
  // score, its top.
  // And the first row of big keys gets its numbers (1 to 4 make those calls: boot's keydown)
  let kbd = false;
  function dockKeys() {
    addEventListener('keydown', (e) => {
      if (!(e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || /^[1-9]$/.test(e.key))) return;
      kbd = true;
      // (a first Tab from nowhere, after a tap or a click that went away: to the calls, not the top of the page)
      if (e.key === 'Tab' && !e.shiftKey && document.activeElement === document.body && !$('play').hidden && $('modal').hidden && $('deep').hidden) {
        refocus.at = null; refocus();
        if (document.activeElement !== document.body) e.preventDefault();
      }
    }, true);
    addEventListener('pointerdown', () => { kbd = false; }, true);
    const d = $('dock');
    let q = 0;
    const soon = () => { if (!q) q = requestAnimationFrame(() => { q = 0; refocus(); }); };
    new MutationObserver(() => {
      const row = [...d.querySelectorAll('.keys')].find((k) => k.querySelector('.key.big'));
      if (row) row.querySelectorAll('.key.big').forEach((b, i) => { if (i < 9) { b.dataset.n = String(i + 1); b.setAttribute('aria-keyshortcuts', String(i + 1)); } });
      soon();
    }).observe(d, { childList: true });
    new MutationObserver(soon).observe($('done'), { attributes: true, attributeFilter: ['hidden'] });
  }
  function refocus() {
    const a = document.activeElement;
    // (where it put focus itself, untouched since, is picked again: a result card's Replay while the next calls load)
    if (!kbd || !$('modal').hidden || !$('deep').hidden || (a && a !== document.body && a !== refocus.at && a.isConnected && a.getClientRects().length)) return;
    if (!$('done').hidden) {
      const h = $('done').firstElementChild;
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
      return;
    }
    if ($('play').hidden) return;
    const d = $('dock'), to = d.querySelector('.endcard > .btn, .result > .btn') || d.querySelector('#snapGo') || d.querySelector('.rcv') || d.querySelector('.key')
      || [...d.querySelectorAll('button')].find((x) => !x.closest('.result'));
    if (to && to !== a) { to.focus({ preventScroll: true }); refocus.at = to; }
  }
  // low: at the foot of the screen, out of the way (a new badge, while the end card is read)
  function toast(msg, low) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    say(msg);
    t.removeAttribute('style');
    t.classList.toggle('low', !!low);
    if (bcast() && !low) requestAnimationFrame(placeToast);          // (once what called it has drawn the sheet)
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, Math.max(1800, msg.length * 45));
  }
  // a phone playing: over the field, under its buttons and above the calls' sheet, never on a control; with no room
  // there, as under the final card, over the scoreboard (again when the sheet changes size under it, or the page
  // leaves the broadcast view)
  function placeToast() {
    const t = $('toast');
    if (t.hidden || t.classList.contains('low')) return;
    t.removeAttribute('style');
    if (!bcast()) return;
    // (the sheet as it settles, not mid-slide: during a play, away but for the skip note; down, its bar)
    const sh = $('sheet'), bar = $('bar').getBoundingClientRect();
    const sheetTop = window.innerHeight - ($('field').classList.contains('playing') ? 52 : sh.classList.contains('down') ? 66 : sh.offsetHeight);
    const under = [document.querySelector('.fieldbox .fov'), $('toBtn')].filter((e) => e && !e.hidden && e.getClientRects().length)
      .reduce((y, e) => Math.max(y, e.getBoundingClientRect().bottom), bar.bottom);
    if (under + 8 + t.offsetHeight + 8 <= sheetTop) t.style.top = `${Math.round(under + 8)}px`;
    else Object.assign(t.style, { top: `${bar.top}px`, left: `${bar.left}px`, width: `${bar.width}px`, minHeight: `${bar.height}px`, transform: 'none', borderRadius: '14px' });
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
    if (e.kind === SPIKE) return `${who} spikes it, clock stopped`;
    if (e.kind === KNEEL) return `${who} kneels, clock ${e.running ? 'running' : 'stopped'}`;
    let what;
    if (mine && act && act.targetName && act.route && e.call >= 0) {       // your pass: to the receiver you picked, on his route
      const to = shortName(act.targetName) || act.targetPos;
      const on = act.open ? 'the open man' : `${to} on ${act.drawn && act.drawn[act.target] ? `the route you drew (${routeSay(act.targetPos, act.route)})` : routeSay(act.targetPos, act.route)}`;
      what = `${nm.qb || who} ${act.pa ? 'fakes the handoff, then looks for' : act.roll ? 'rolls out and looks for' : 'looks for'} ${on}${e.row >= 0 ? lookText(e.look, e) : ''}`;
    } else if (e.call >= 0) {
      const c = idx.calls[e.call];
      const actor = c.id.startsWith('rb_') ? nm.rb : nm.qb;
      what = `${TRICK_SAY[c.id] ? `${who} ${TRICK_SAY[c.id]}` : `${actor || who} ${c.say}`}${e.row >= 0 ? lookText(e.look, e) : ''}`;
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
      // (your pick, and the rush got there first: said in so many words. A player read a throwaway as the
      // quarterback going "off book" to someone else)
      if (res && mine && act && act.targetName && !act.open && /^(sack|strip_sack|sack_fumble|scramble|throwaway)$/.test(e.evt || ''))
        res = `${res} (never got it to ${shortName(act.targetName) || act.targetPos})`;
    }
    // a fumble he made only after crossing the goal line is just the touchdown (engine.js scores it that way)
    if (e.td && !e.turnover && /fumble|scoop|strip/.test(e.evt || '')) res = null;
    if (!res) {
      if (e.turnover) res = e.tdDef ? 'turnover, returned for a touchdown' : e.kind === PASS ? 'intercepted' : 'fumble, lost';
      else if (e.td) res = `${y}-yard touchdown`;
      // (why, when the charting knows: the rush on him, a defender's hand on it)
      else if (e.incomplete) res = `${e.pressure ? 'pressured, ' : ''}${e.defended ? 'broken up, ' : ''}incomplete`;
      else res = gain;
    } else if (e.td && !/touchdown/.test(res)) res += `, ${y}-yard touchdown`;
    // the engine decides the score: a turnover it returned for a touchdown says so, whatever the real play's label
    if (e.tdDef && !/touchdown/.test(res)) res = e.kind === PASS && !/fumble|bad snap|strip/.test(res) ? 'intercepted and returned for a touchdown' : `${res.split(',')[0]}, returned for a touchdown`;
    const extra = [];
    // (a touchdown is the score, wherever he ended up; after a turnover it is the return that went out: "intercepted,
    // out of bounds" read as if the pass had been)
    if (e.oob && !e.incomplete && !e.td && !e.tdDef) extra.push(e.turnover ? 'returned out of bounds' : 'out of bounds');
    else if (act && act.oob && mine && !e.incomplete && !e.penalty && !e.turnover && !e.onDowns && !e.td && !e.safety) extra.push('could not get out of bounds');
    // (a foul's first down is automatic only when its yards fall short of the line to gain: a 5-yard offside on 3rd
    // and 2 is a first down by the yardage, as any gain is)
    if (e.fd && !e.td) extra.push(e.penalty && e.yards < e.ytg ? 'automatic first down' : 'first down');
    if (e.onDowns) extra.push('turnover on downs');
    // a foul during the play: taken or turned down by the team it was against (yours to pick: penaltyAsk)
    if (e.penOpt) extra.unshift(e.penOpt.declined ? `flag, ${e.penOpt.pen}: declined` : 'penalty accepted');
    if (e.safety) extra.push('safety');
    if (e.runoff10) extra.push('10-second runoff (a foul stopped the clock inside the last minute)');
    if (e.untimed) extra.push('no time left, but a half cannot end on a defensive foul: an untimed down');
    // out of bounds early in a half: the clock starts again once the ball is spotted (a player saw the clock run on
    // after a man went out, and read it as the game ignoring the sideline)
    else if (!e.td && !e.turnover && !e.onDowns && !e.safety) {
      extra.push(!e.running ? 'clock stopped' : e.oob && !e.incomplete && !e.penalty
        ? 'the clock restarts once the ball is spotted (out of bounds stops it until the snap only late in a half)' : 'clock running');
    }
    return `${what}: ${res}${extra.length ? ', ' + extra.join(', ') : ''}`;
  }
  function narrate(log, act) {
    const out = [];
    for (const e of log) {
      let text = null, t = e.t;
      switch (e.ev) {
        case 'timeout': text = `Timeout, ${teamName(code(e.team))}${e.left != null ? ` (${e.left} left)` : ''}${e.why === 'kick' ? ', to set up the kick' : e.why === 'runoff' ? ', to save the 10-second runoff' : ''}`; break;
        case 'runoff':
          if (e.stop === '2mw') text = 'Two-minute warning';
          else if (e.stop === 'quarter') text = 'End of the quarter';
          else if (e.secs >= 3 && !e.kneel && !e.spike) text = `Clock runs ${Math.ceil(e.t + e.secs - 1e-6) - Math.ceil(e.t - 1e-6)} seconds`;   // as the scoreboard reads
          break;
        case 'play': text = playLine(e, act); break;
        case 'fg': text = e.foul ? `Roughing the kicker on ${teamName(code(1 - e.team))}: 15 yards and a first down`
          : `${shortName(teamOf(e.team).kicker.name) || teamName(code(e.team))} ${Math.round(e.dist)}-yard field goal: ${e.made ? 'good' : e.blocked ? `blocked${e.retTd ? ', returned for a touchdown' : ''}` : 'no good'}`; t = null; break;
        case 'punt': text = e.foul ? `Roughing the punter on ${teamName(code(1 - e.team))}: 15 yards and a first down` : e.blocked ? `${teamName(code(e.team))} punt blocked${e.retTd ? ', returned for a touchdown' : ''}` : e.retTd ? `${teamName(code(e.team))} punt returned for a touchdown` :
          `${teamName(code(e.team))} punt${e.touchback ? ', touchback' : `, net ${Math.round(e.net)} yards`}`; t = null; break;
        case 'pat': text = e.two ? `Two-point try${e.philly ? ' (Philly Special)' : e.call >= 0 && idx.calls[e.call] ? ` (${idx.calls[e.call].label})` : ''} ${e.good ? 'good' : 'fails'}`
          : `Extra point ${e.good ? 'good' : e.blocked ? 'blocked' : 'no good'}`; break;
        // a touchdown on the last play that decides it: no try (NFL since 2018)
        case 'notry': text = 'No try: time has run out and it cannot change the result'; break;
        case 'kickoff': text = e.onside ? `Onside kick, recovered by ${teamName(code(e.recovered ? e.team : 1 - e.team))}` :
          e.retTd ? 'Kickoff returned for a touchdown' : `Kickoff${e.tb ? (Math.round(e.yl) === 60 ? ', short of the landing zone' : ', touchback') : ''}: ${teamName(code(1 - e.team))} starts at its own ${Math.round(100 - e.yl)}`; break;
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
    if (e.ev === 'pat') return e.two ? (e.good ? 'Two-point try good' : 'Two-point try fails') : (e.good ? 'Extra point good' : e.blocked ? 'Extra point blocked' : 'Extra point missed');
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
      result: G.result, started: G.started, pending: G.pending || null, regrade: G.regrade && G.regrade.length ? G.regrade : null,
      pers: G.pers || null, persWho: G.persWho || null, form: G.form || null, qb: G.qb || null, vsN: G.vsN || 0, cot: G.cot || null };
    saveState();
  }
  function resumeSpot(i) {
    G = newSpot(i);
    let s = state.spots[i];
    if (s && s.id && s.id !== G.scen.id) s = state.spots[i] = null;   // saved on another game (a changed schedule): start fresh
    if (s) Object.assign(G, { root: s.root, decisions: s.decisions || [], log: s.log || [], seq: s.seq || 0, snapN: s.snapN || 0,
      over: s.over, result: s.result, started: !!s.started, pers: s.pers || null, persWho: s.persWho || null, form: (!VS && s.form) || null, qb: (!VS && s.qb) || null, vsN: s.vsN || 0, cot: s.cot || G.cot || null,
      // a snap left mid-play by a reload: its grading is redone in the background (regradeBg), with any still waiting
      regrade: (s.regrade || []).concat(s.pending ? [s.pending] : []), pending: null });
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
  // "2024 · Week 8"; a playoff game by its month, as people know it ("Super Bowl LII · Feb 2018", not the season's 2017)
  const roman = (n) => [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']].reduce((a, [v, r]) => { while (n >= v) { a += r; n -= v; } return a; }, '');
  function gameTag(sc) {
    const rl = sc.real || {};
    if (sc.custom) return SCN.TYPES[rl.type] || 'Regular season';
    if (!ROUND[rl.type]) return `${rl.season} · ${COLLEGE_ROUND[rl.type] || `Week ${rl.week}`}`;
    // (the game's date where the data has it; else January after the season, a Super Bowl February from the 2003 season's)
    const d = rl.date ? new Date(`${rl.date}T12:00:00`) : new Date(rl.season + 1, rl.type === 'SB' && rl.season >= 2003 ? 1 : 0, 15);
    const when = `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()}`;
    return `${rl.type === 'SB' ? `Super Bowl ${roman(rl.season - 1965)}` : ROUND[rl.type]} · ${when}`;
  }
  // (a scenario's two teams each have their season: "2007 New England at 2023 Kansas City")
  const yrName = (sc, c) => (sc.seasons ? `${sc.seasons[c]} ${teamName(c)}` : teamName(c));
  const matchLine = (sc) => (sc.neutral ? `${yrName(sc, sc.away)} vs ${yrName(sc, sc.home)}${sc.site ? ` · ${sc.site}` : ''}` : `${yrName(sc, sc.away)} at ${yrName(sc, sc.home)}`);
  // the kind of spot, as this one is: "Tied, or end of the half" says which ("End of the half" above "Down by 4")
  const catLabel = (sc) => (sc.category !== 'tight' ? idx.categories[sc.category] : sc.start.qtr <= 2 ? 'End of the half' : 'Tied game');
  // a featured day's title ("28–3 · Super Bowl LI", src/nflclock/daily_schedule.json), or ''; playTitle: the one of the
  // drive being played, only on a daily (today's or an archive day's) and only on that day's featured spot
  const dayTitle = (n) => { const f = idx.featured && idx.featured[n]; return (f && f.title) || ''; };
  const playTitle = (sc) => { const f = !SURV && !PRACTICE && !DRIVE && !RUN_N && !CUSTOM && !VS && idx.featured && featOf(dayN);
    return f && f.title && idx.spots[f.spot] && idx.spots[f.spot].id === (sc || G.scen || {}).id ? f.title : ''; };
  function renderIntro() {
    const sc = G.scen, r = G.root, box = $('intro');
    box.textContent = '';
    show('intro');
    drawTiles();
    const me = code(G.me), op = code(1 - G.me);
    const lead = r.score[G.me] - r.score[1 - G.me], ck = clockOf(r.t);
    const left = `${ck.text} left in ${r.ot ? (r.ot.n > 1 ? `overtime (period ${r.ot.n})` : 'overtime') : ck.q === 4 ? 'the game' : ck.q === 2 ? 'the half' : ck.q === 3 ? 'the third quarter' : 'the first quarter'}`;
    const state_ = lead > 0 ? `Up by ${lead}` : lead < 0 ? `Down by ${-lead}` : 'Tied';
    const big = el('div', 'big', state_);
    big.append(el('span', 'left', left));
    if (VS) return renderVsIntro();
    box.append(el('div', 'cat', SURV ? `Survivor · Game ${state.games.length + 1}` : PRACTICE ? `Practice drive · ${catLabel(sc)}` : DRIVE ? 'Historic drive' : CUSTOM ? 'Your scenario'
      : RUN_N ? `${PRO_RUNS.runs[RUN_N - 1].title} · Game ${G.si + 1} of ${today.length} · ${PRO_RUNS.runs[RUN_N - 1].games[G.si].round}`
        : (today.length > 1 ? `Spot ${G.si + 1} of ${today.length} · ` : ARCH_DAY ? `No. ${dayN}, from the archive · ` : 'Today’s drive · ') + (sideTaken() ? `${teamName(sc.player)} side · ` : '') + catLabel(sc)),
      ...(playTitle(sc) ? [el('h2', 'title', playTitle(sc))] : []),
      el('div', 'game', `${gameTag(sc)} · ${matchLine(sc)}`), big);
    const mu = el('div', 'matchup');
    const t = (c, i) => {
      const d = el('div', 't');
      const sw = el('span', `sw${darkOn(color(c)) ? ' dk' : ''}`, c); sw.style.background = color(c);
      d.append(sw, el('span', 'nm', teamName(c)));
      if (i === G.me) d.append(el('span', 'you', 'YOU'));
      return d;
    };
    mu.append(t(code(1), 1), el('div', 'sc', `${r.score[1]}–${r.score[0]}`), t(code(0), 0));
    box.append(mu);
    const facts = el('div', 'chips');
    const tos = (n) => (n ? `${n} timeout${n === 1 ? '' : 's'}` : 'no timeouts');
    [r.phase === KICKOFF ? (r.pos === G.me ? `You kick off to ${teamName(op)}` : `${teamName(op)} kicks off to you`) : `${r.pos === G.me ? 'Your' : `${teamName(op)}`} ball, ${ddText(r)} ${onSpot(r)}`, `You: ${tos(r.to[G.me])}`,
      `${teamName(op)}: ${tos(r.to[1 - G.me])}`].forEach((f) => facts.append(el('span', '', f)));
    // an overtime spot: its rules (a historic drive's are of its time)
    if (r.ot) facts.append(el('span', '', r.ot.r === 'sd' ? 'Sudden death: the first score wins' : r.ot.r === 'msd' ? `${sc.real.season} overtime rules: a touchdown wins it`
      : 'Overtime: each team gets the ball, then the next score wins'));
    if (sc.custom && !r.ot && clockOf(r.t).q <= 2) facts.append(el('span', '', sc.end === 'half' ? 'It ends at halftime' : 'Played to the final gun'));
    box.append(facts);
    // Play right under the spot, on the first screen without scrolling (players asked); the story and the rest below
    const go = el('button', 'btn play', G.started ? 'Back to the drive' : 'Play');
    go.type = 'button';
    go.addEventListener('click', () => {
      if (!G.started) {
        track('drive_start', { mode: modeName(), kind: sc.category, day: dayN });
        Object.assign(liveDrive, { on: true, calls: 0, t0: performance.now(), kind: sc.category });
      }
      G.started = true; persist(); enterField();
    });
    box.append(go);
    // a day of two sides, before the first snap: the other side is still one tap away (nothing has been played)
    const ss = sideTaken() && !G.started && !state.done && !(state.spots || []).some((x) => x && x.decisions && x.decisions.length) ? sidesOf(dayN) : null;
    if (ss) {
      const k = (sideOf(dayN) ?? 0) === 0 ? 1 : 0, osp = idx.spots[ss[k].spot], sw = el('button', 'btn ghostbtn sideswap', `Take over as ${teamName(osp.player)} instead`);
      sw.type = 'button';
      sw.addEventListener('click', () => {
        save(SIDE_KEY(dayN), k);
        save(stateKey(), { spots: [], current: 0, done: false, tryAt: Date.now(), side: k, ...(state.restarts ? { restarts: state.restarts } : {}) });
        track('side_pick', { day: dayN, side: osp.player, swap: true });
        restarting = true;            // (nothing saves the old side's state after this)
        location.reload();
      });
      box.append(sw);
    }
    const rc = (sc.real || {}).coach, feat = !SURV && idx.featured && featOf(dayN);
    const tale = feat && feat.note && idx.spots[feat.spot] && idx.spots[feat.spot].id === sc.id ? feat.note : sc.story;
    if (tale) {
      // a long story folds to a few lines (a tap opens it)
      const st = el('p', `story${tale.length > 240 ? ' fold' : ''}`, tale);
      box.append(st);
      if (tale.length > 240) {
        const more = el('button', 'more-story', 'Read more');
        more.type = 'button';
        more.addEventListener('click', () => { st.classList.remove('fold'); more.remove(); });
        box.append(more);
      }
    }
    box.append(el('div', 'who', VS ? `You're ${teamName(me)}. Your opponent has ${teamName(op)}: they call their side, you call yours.`
      : `You're calling it for ${teamName(me)}.${rc ? ` Can you do better than ${rc} did?` : ''}`));
    if (SURV) box.append(el('div', 'who surv', 'Win to stay alive. Lose and your run is over. Tied at the end: overtime.'));
    if (todayDaily() && state.restarts) box.append(el('div', 'who prac', 'Started over: this drive counts for your streak and stats, not on today’s leaderboard.'));
    if (PRACTICE) box.append(el('div', 'who prac', 'Practice: graded like the daily, but it doesn’t count toward your stats, streak or the leaderboard.'));
    const chl = challengeLine();
    if (chl) box.append(chl);
    box.append(todaySoFar());
    const rl = sc.real || {};
    box.append(el('div', 'from', sc.custom ? `Your situation, with each team as it lined up that season and every player rated as of the end of its regular season.`
      : `The real score, clock, ball and timeouts from that game, with the players who were on the field and how good they were that week.`));
    box.append(el('div', 'from legal', 'Fan-made. Not affiliated with or endorsed by the NFL or its teams.'));
    go.focus({ preventScroll: true });
    // the first call's facts, asked for while the intro is read: the worker keeps the answer (game_worker.js), so Play
    // finds the call ready instead of waiting on the simulator setting up this game (with the spot's own facts,
    // firstInfo, it is set up for the first snap)
    if (!G.started) send({ type: 'info', scen: simScen(), root: G.root }).catch(() => { /* asked again on Play */ });
  }
  async function enterField() {
    show('play');
    restoreLog();
    if (!G.log.length) addLog(`${teamName(code(G.root.pos))} ball, ${ddText(G.root)} ${onSpot(G.root)}`, G.root.t, G.root.pos === G.me);
    drawAll();
    // back after a reload in the middle of a snap: the drive goes on at once, the call's grading in the background
    regradeBg();
    if (G.over) finishSpot(); else advance();
  }

  async function advance() {
    while (true) {
      const r = G.root;
      $('skipBtn').hidden = true;             // (their plays' status shows it again: status)
      G.side = sideFor(G.seq);
      drawAll();
      if (r.phase === DONE) return finishSpot();
      if (VS) { if ((await vsAdvance(r)) === 'stop') return; continue; }
      if (G.cot) { if ((await cotAdvance(r)) === 'stop') return; continue; }
      if (r.pos === G.me) G.autoDef = false;
      if (r.phase === SNAP && r.clock_running && (await theirTimeout(r))) continue;
      // no time left for a snap: under a second with the clock running (every tempo takes a second or more, engine.js),
      // unless your timeout stops it in time and you need it (players were asked for a play the clock had run out on)
      const th = halfLeft(r.t), lead = r.score[G.me] - r.score[1 - G.me];
      if (r.phase === SNAP && (r.clock_running ? th < 1 && !(r.pos === G.me && r.to[G.me] > 0 && (r.t > 1800 || lead <= 0)) : th <= 1e-6)) {
        status('Time runs out', G.log.length ? G.log[G.log.length - 1][0] : '');
        await stepWith({ to_off: false, to_def: false, tempo: 'normal' });
        continue;
      }
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
        const go = async () => { if (went) return; went = true; await cutReplay(); if (!busy) advance(); else went = false; };
        btn.addEventListener('click', go);
        b.append(btn, autoNext(btn, go));
        d.textContent = '';
        d.append(b);
        return;
      }
      const action = r.phase === SNAP ? { to_def: false } : (r.phase === KICKOFF && r.pos === G.me ? { kick: 'deep' } : {});
      const label = r.phase === KICKOFF ? (r.pos === G.me ? 'You kick off' : `${teamName(code(r.pos))} kicks off`) :
        r.phase === PAT ? `${teamName(code(r.pos))} tries the extra point` : `${teamName(code(r.pos))} has the ball`;
      const last = G.log.length ? G.log[G.log.length - 1][0] : '';
      status(label, last, !G.fast);
      const res = await stepWith(action);
      await sleep(G.fast ? 60 : res.animated ? 300 : 1000);
    }
  }
  // the other team's timeout, right after the whistle: the engine takes it at the start of the next snap, after your call
  // (players called a play on a running clock the other team then stopped, and never saw the timeout). Played here
  // first, as the engine would (a look at that snap, as decideTimeout does yours), it is on the scoreboard and above
  // your call. Not their run-down-then-timeout for the kick: you can still stop the clock before it
  async function theirTimeout(r) {
    const them = 1 - G.me;
    if (!(r.to[them] > 0)) return false;
    await simWait();              // (back after a reload with the data still coming: the huddle, with how far along it is)
    const action = r.pos === G.me ? { to_off: false, tempo: 'normal' } : { to_def: false };
    const peek = (await send({ type: 'step', scen: simScen(), root: r, action, seed: hash('step', seedKey(), G.si, G.seq) }, true)).res;
    const e = peek.log[0];
    if (G.root !== r || !e || e.ev !== 'timeout' || e.team !== them || e.why) return false;
    G.root = { ...r, t: e.t, to: r.to.map((x, i) => (i === them ? x - 1 : x)), clock_running: false, credit: 0, timeout: { team: them, left: r.to[them] - 1 } };
    narrate([e]).forEach(([text, t, mine]) => addLog(text, t, mine));
    persist();
    return true;
  }
  // "Next play" before the other team's snaps: optional, kept per player, it goes on by itself after a few seconds
  // (a tap anywhere on the result first holds it, to read the grade)
  const AUTO_KEY = `${STORE}:autonext`;
  function autoNext(btn, go) {
    const on = !!load(AUTO_KEY, false), sw = el('button', `chip auto${on ? ' on' : ''}`, on ? 'Auto-continue: on' : 'Auto-continue: off');
    sw.type = 'button';
    sw.setAttribute('aria-pressed', String(on));
    let left = 3, tick = null;
    const stop = () => { if (tick) { clearInterval(tick); tick = null; btn.textContent = 'Next play'; } };
    const start = () => {
      if (reduced() || tick) return;
      left = 3; btn.textContent = `Next play in ${left}`;
      tick = setInterval(() => {
        if (!btn.isConnected) return stop();
        if (document.hidden || !$('modal').hidden || !$('deep').hidden) return;
        left -= 1;
        if (left > 0) btn.textContent = `Next play in ${left}`; else { stop(); go(); }
      }, 1000);
    };
    sw.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const now = !load(AUTO_KEY, false);
      save(AUTO_KEY, now);
      track('autonext', { on: now });
      sw.classList.toggle('on', now); sw.setAttribute('aria-pressed', String(now));
      sw.textContent = now ? 'Auto-continue: on' : 'Auto-continue: off';
      if (now) start(); else stop();
    });
    if (on) setTimeout(() => { if (btn.isConnected) { start(); btn.parentNode.addEventListener('click', (ev) => { if (ev.target !== btn && ev.target !== sw) stop(); }, true); } }, 0);
    return sw;
  }
  function kickChoice(r) { return r.t <= 300 && r.score[G.me] < r.score[1 - G.me]; }
  // late in a half: the last 5:00 of the second, the last 2:00 of the first
  const lateHalf = (r) => halfLeft(r.t) <= (r.t <= 1800 ? 300 : 120);
  // where a timeout on their snap is the question (asked when the coordinator has the drive, and graded): behind or
  // level, or a field goal from losing the lead
  function defChoice(r) {
    const lead = r.score[G.me] - r.score[1 - G.me];
    return lateHalf(r) && (lead <= 0 || (lead <= 3 && r.yl <= 45));
  }
  // no timeout left just where one would be offered: said, not just missing (a player looked for the option on a day
  // that starts his side with none)
  const noTimeouts = (d) => { const n = el('p', 'hint noto', '⏱ No timeouts left'); d.append(n); return n; };
  async function stepWith(action) {
    if ($('toBtn')) $('toBtn').hidden = true;          // (no timeout button while a snap plays)
    await cutReplay();                // a replay's last redraw must not show this play's result before it animates
    const seed = hash('step', seedKey(), G.si, G.seq++);
    const before = G.root, side = G.side;
    // a two-point try you call is shown as a snap from the 2 (root.try2 holds the real try the engine plays)
    let res = (await send({ type: 'step', scen: simScen(), root: G.root.try2 || G.root, action, seed }, true)).res;
    // a flag on them during the play: yours to accept or decline (the same snap again, the same draws, with your pick)
    const fl = !VS && res.log.find((x) => x.ev === 'play' && x.penOpt && x.penOpt.offended === G.me);
    if (fl) {
      const pick = await penaltyAsk(fl, G.root.try2 || G.root);
      if ((pick === 'decline') !== fl.penOpt.declined) {
        action = { ...action, penAs: pick };
        res = (await send({ type: 'step', scen: simScen(), root: G.root.try2 || G.root, action, seed }, true)).res;
      }
      track('penalty_choice', { mode: modeName(), pick, auto: fl.penOpt.declined ? 'decline' : 'accept' });
    }
    res.action = action;
    if (action && action.philly) res.log.forEach((x) => { if (x.ev === 'pat') x.philly = true; });
    const pe0 = res.log.find((x) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(x.ev));
    let reelLi = null;
    narrate(res.log, action).forEach(([text, t, mine]) => { const li = addLog(text, t, mine); if (!reelLi && pe0 && t === pe0.t) reelLi = li; });
    G.root = res.root;
    if (res.done) G.root.phase = DONE;
    // a half that ends on the play itself (a kneel, a last snap, a kick) says so, as one run out between snaps does
    if (G.root.phase === DONE && !G.root.ot && !res.log.some((x) => x.ev === 'end')) addLog(G.root.t >= 1800 ? 'Halftime' : 'End of regulation', G.root.t, false);
    if (res.log.some((x) => x.untimed)) G.root.untimed = true;        // a defensive foul as time ran out: one more snap at 0:00
    persist();
    const pe = res.log.find((x) => x.ev === 'play');
    const look = before.pos === G.me ? G.look : action && (action.def || action.dc) && pe && pe.look && pe.look.box ? (pe.look.box >= 7 ? 2 : 0) + (pe.look.blitz ? 1 : 0) : null;
    G.lastPlay = { before, res, side, look };
    res.animated = await animatePlay(before, res, side, false, look);
    if (res.animated && reelLi && reelLi.isConnected) reelKey(reelLi, G.lastPlay);
    G.look = null;
    return res;
  }
  // A flag on the other team during the play: accept the yards or decline and keep the play (engine.js _scrimmage
  // draws the play under the foul). Each option says where it leaves the ball; the better one for you is listed first
  // and is what Enter or closing the sheet takes
  function penaltyAsk(e, r) {
    const o = e.penOpt, mineBall = r.pos === G.me;
    const at = (y) => Math.min(99, Math.max(1, r.yl - y));
    const spot = (y) => onSpot({ pos: r.pos, yl: at(y) });
    const downTxt = (fd, y, sameDown) => {
      const d = fd ? 1 : sameDown ? r.down : r.down + 1;
      return d > 4 ? 'turnover on downs' : ddText({ down: d, ytg: fd ? Math.min(10, at(y)) : r.ytg - y, yl: at(y) });
    };
    const ay = Math.round(o.accept.yards), dy = Math.round(o.decline.yards);
    const accTxt = `${Math.abs(ay)} yards ${ay > 0 ? 'for the offense' : 'back'}: ${downTxt(o.accept.fd, ay, true)}${o.accept.fd && ay < r.ytg ? ' (automatic first down)' : ''}, ${spot(ay)}`;
    const d = o.decline, gain = dy > 0 ? `a gain of ${dy}` : dy < 0 ? `a loss of ${-dy}` : 'no gain';
    const playTxt = d.td ? 'a touchdown' : d.to ? 'a turnover' : d.inc ? 'an incomplete pass' : /sack/.test(d.evt) ? `a sack, ${gain}` : gain;
    const decTxt = `The play stands, ${playTxt}${d.td || d.to ? '' : `: ${downTxt(d.fd, dy, false)}, ${spot(dy)}`}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; onModalClose = null; if (!$('modal').hidden) closeModal(); resolve(v); };
      const best = o.declined ? 'decline' : 'accept';
      const btn = (k, title, txt) => {
        const b = el('button', `btn penpick${k === best ? '' : ' ghostbtn'}`);
        b.type = 'button';
        b.append(el('b', '', title), el('span', 'note', txt));
        b.addEventListener('click', () => finish(k));
        return b;
      };
      const opts = [btn('accept', 'Accept', accTxt), btn('decline', 'Decline', decTxt)];
      if (best === 'decline') opts.reverse();
      const row = el('div', 'penacts');
      row.append(...opts);
      openModal(`Flag: ${o.pen}`, [el('p', 'note', `On ${mineBall ? 'the defense' : 'the offense'}. Your call:`), row]);
      onModalClose = () => finish(best);
    });
  }
  // a replay never holds up the game: a call, Next play or Next game tapped during it cuts it short (cutReplay)
  let replaying = null, cutAnim = null;
  function replay(lp = G.lastPlay) {
    track('replay');
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
        : `Getting the playbook ready… ${dl.total ? Math.min(99, Math.round((100 * dl.got) / dl.total)) : 0}%`;
      setTimeout(tick, 200);
    };
    tick();
  }
  // your ball: Run / Pass / RPO, plus a timeout, spike, kneel or kick when it matters
  async function promptOffense() {
    const r = G.root;
    G.info = firstInfo(r);
    if (!G.info) {
      huddle('Breaking the huddle…');
      G.info = (await send({ type: 'info', scen: simScen(), root: r }, true)).info;
    }
    if (VS && (G.root !== r || vs.ui !== 'prompt')) return;          // the room moved on while the odds came in
    G.fast = false;
    G.odds = {};
    const ad = adaptLooks(G.info.looks);
    G.look = VS ? null : pickLook(ad.p, hash('look', seedKey(), G.si, G.seq));
    G.lookNote = (G.look != null ? ad.note : null) || repNote();
    // late and trailing (or ending the first half): getting out stops the clock, so it starts on (players didn't find
    // the switch); once turned off it stays off for the drive
    const oobOn = oobMatters(r) && (r.t > 1800 || r.score[G.me] < r.score[1 - G.me]) && !G.oobOff;      // (tied: shown, left to you)
    const t0 = tempoKeyOf(G.info.tempo), tFit = TEMPOS.find((k) => !runsOut(k, r));      // (the usual tempo, or one that snaps in time)
    ui = { step: 'family', fam: null, oob: oobOn, tempo: runsOut(t0, r) && tFit && wantsTime(r) ? tFit : t0 };
    if (!VS) save(`${STORE}:ncalls`, load(`${STORE}:ncalls`, 0) + 1);
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
  // a timeout is featured (the gold key, the button on the field) late in a half, when the time is worth saving; before
  // that it is a plain key (a gold TIMEOUT in the middle of the third quarter, down 25, had first-timers spending them)
  const toHot = (r) => halfLeft(r.t) <= (r.t > 1800 ? 120 : 300);
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
    // (never as the game's last snap when it cannot win or tie it: a gold FIELD GOAL on an untimed down at 0:00, down 4)
    const lastKick = r.t <= 1800 && !r.ot && r.score[G.me] - r.score[1 - G.me] <= -4 && (r.untimed || th <= 5);
    if (kickable && !lastKick && ((r.down === 4 && p >= 0.05) || (th <= 20 && p >= 0.2) || (r.down === 3 && th <= 40 && p >= 0.4) || (late && p >= 0.3))) specials.push('fg');
    // a punt hands the ball over for good when behind in the game's last 40 s (NFL 2016-25: no team trailing in the
    // last 0:40 punted; engine.js _fourthDown makes the computer go), and it never gets off when the clock runs out
    // before any snap (a gold PUNT at 0:02, down 4, beside the timeout)
    const behind = r.score[G.me] < r.score[1 - G.me];
    const puntHelps = !(r.t <= 1800 && behind && th <= 40) && !(r.clock_running && allRunOut(r));
    if (r.down === 4 && r.yl >= 30 && puntHelps) specials.push('punt');
    if (!r.clock_running && canKneel(r)) specials.push('kneel');
    return { calls, specials };
  }
  // a field goal that can't change the result in your favour is a plain key, not the gold one (still there to call):
  // down 4 or more with no time after it to get the ball back (a gold FIELD GOAL, rushed at 0:10, down 5), or ahead
  // with none after it for them (up 7 at 0:03, where all a kick can add is a miss returned)
  function fgIdle(r) {
    if (r.t > 1800 || r.ot) return false;
    const lead = r.score[G.me] - r.score[1 - G.me];
    const after = r.untimed ? 0 : halfLeft(r.t) - (r.clock_running ? 10 : 4);      // (the kick: 7-12 s rushed on, engine.js FIRE_DRILL; about 4 s)
    return (lead <= -4 && after < 10) || (lead > 0 && after < 2);
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
      if (crowdOn()) crowdCounts();          // (the crowd's counts, in before this call's result card: crowdLine)
      head.append(el('h2', '', 'Your call'), el('span', 'sub', `${ddText(r)} · ${spotText(r)}`));
      sketchChips(head, 'play');
      if (G.look != null) d.append(readLine(G.look));
      if (r.clock_running) d.append(tempoPicker(r));
      const fam = el('div', 'keys fam');          // (fam: what the first drive's tour points at)
      fam.style.setProperty('--cols', 4);
      Object.entries(FAM).forEach(([f, label], i) => {
        const b = key(label, null, 'big', i);
        b.addEventListener('click', () => {
          if (busy) return;
          ui.fam = f;
          if (f === 'pass') { save(`${STORE}:usedpass`, true); ui.step = 'pass'; ui.pass = { target: null, routes: null, drawn: [], draw: drawPref(), sel: null, pa: false, roll: false, fresh: true }; drawField(); }
          else { ui.step = 'detail'; drawField(); }
          drawDock();
        });
        fam.append(b);
      });
      d.append(fam);
      // (drawing on, or a few calls in: drawing is there to find, under the keys)
      if (drawPref() || load(`${STORE}:ncalls`, 0) <= 3) sketchPanel(d, 'play', null);
      if (oobMatters(r)) d.append(oobToggle());
      const nCalls = load(`${STORE}:ncalls`, 0);
      if (nCalls >= 2 && !load(`${STORE}:usedpass`, false)) {
        const h = hintOnce('pass', 'Tap Pass to pick who gets the ball: tap a receiver on the field to change his route, or call a quick pass in one tap.');
        if (h) d.append(h);
      }
      const extra = [];
      let fitTo = fam;
      if (r.clock_running) {
        // (a phone: the timeout is the button on the field, toButton, not a key here too)
        clockOptions(r).filter((k) => !TEMPOS.includes(k) && !(k === 'timeout' && toOnField())).forEach((k) => extra.push([k, k === 'rundown' ? 'Run it down' : CLOCK[k].label,
          k === 'timeout' ? `${r.to[me]} left` : k === 'rundown' ? `timeout at 0:0${RUNDOWN_AT}, then kick` : null]));
      }
      const { specials, calls: avail2 } = callOptions(r);
      // the Philly Special (Super Bowl LII): on a two-point try, run as the receiver pass it is
      if (r.try2 && avail2.includes('trick_pass')) extra.push(['philly', 'Philly Special', 'Direct snap, reverse, throw to the QB']);
      // the kick's real odds on the button (this kicker, this distance, the weather; a rushed kick a little less), so
      // a miss reads as the 1-in-5 it was, not a rigged game
      const rush = r.clock_running && halfLeft(r.t) <= 25;          // engine.js FIRE_WINDOW: the unit runs on, a rushed kick
      const pFg = G.info.pFg == null ? null : rush ? 1 / (1 + Math.exp(-(Math.log(G.info.pFg / Math.max(1e-9, 1 - G.info.pFg)) - 0.3))) : G.info.pFg;
      specials.forEach((k) => extra.push([k, specialLabel(k), k === 'fg' ? `${Math.round(G.info.fgDist)} yards${pFg != null ? ` · ${Math.round(pFg * 100)}% to make` : ''}${punterKicks(me) ? ` · punter ${shortName(teamOf(me).kicker.name) || teamOf(me).kicker.name} kicking` : ''}${rush ? (r.to[me] > 0 ? ' · rushed (a timeout first sets it up)' : ' · rushed') : ''}` : null]));
      if (extra.length) {
        const row = el('div', 'keys');
        row.style.setProperty('--cols', Math.min(extra.length, 4));
        extra.forEach(([k, label, sub], i) => {
          const b = key(label, sub, (k === 'timeout' && !toHot(r)) || (k === 'fg' && fgIdle(r)) ? '' : 'alt', 3 + i);
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
        // (no tempo snaps in time: the timeout first.) Else right under the calls, above the out-of-bounds switch and
        // the tips, and on a phone in sight with them: a SPIKE at 0:53, down 5, sat below the fold under the switch
        if (r.clock_running && allRunOut(r)) d.insertBefore(row, fam);
        else { d.insertBefore(row, fam.nextSibling); fitTo = row; }
      }
      // (the clock running and time wanted, the timeout's place: none left)
      if (r.clock_running && !(r.to[me] > 0) && (r.t > 1800 || r.score[me] <= r.score[1 - me])) noTimeouts(d);
      fitDock(fitTo);
      return;
    }
    if (ui.step === 'pass') return drawPassDock(head);
    // the plays in the chosen family: one row per play, a key per side (arrows match the field)
    head.append(el('h2', '', FAM[ui.fam]));
    if (r.clock_running) head.append(el('span', 'sub', CLOCK[ui.tempo].short));
    const back = el('button', 'chip', '◀ Back');
    back.type = 'button';
    back.addEventListener('click', () => { ui.step = 'family'; drawField(); drawDock(); });
    head.append(back);
    const drawable = ui.fam === 'run' || ui.fam === 'rpo';
    if (ui.fam === 'run' && !VS) {
      // the blocking (SCHEMES): one tap, kept for the drive's next runs
      const cur = G.scheme || 'zone', row = el('div', 'opts-row schemes');
      row.append(el('span', 'lab', bcast() ? 'Block' : 'Blocking'));
      SCHEMES.forEach(([k, label, tip]) => {
        const b = el('button', `chip opt${cur === k ? ' on' : ''}`, label);
        b.type = 'button'; b.title = tip; b.dataset.scheme = k;
        b.setAttribute('aria-pressed', String(cur === k));
        b.addEventListener('click', () => { if (busy) return; G.scheme = k; track('run_scheme', { scheme: k }); drawDock(); });
        row.append(b);
      });
      d.append(row, el('p', 'phint schemehint', SCHEMES.find(([k]) => k === cur)[2]));
    }
    if (drawable) {
      sketchChips(head, ui.fam);
      // the drawn call: graded and played exactly as the key for it (decideCall), the drawing going with it to the field
      sketchPanel(d, ui.fam, (sk) => decideCall({ call: sk.call, draw: sk.draw, drawKind: ui.fam }));
    }
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
    const tg = oobMatters(r) ? oobToggle() : null, last = tg || list.lastElementChild;
    if (tg) d.append(tg);
    // (a drawing read: the page stays on it and its key, the rest of the keys below)
    if (last && !$('drawGo')) requestAnimationFrame(() => last.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
  }

  // a pass: your receivers and their routes (tap one on the field or here), play action or a rollout, then throw
  // A tip shown once ever, the first time it would have helped (players asked for things the game already does: pick
  // the receiver, a quick pass, a replay). Never while the first drive's tour is talking; a tap on × or anywhere in it
  // closes it
  function hintOnce(key, text) {
    if ((tour && !tour.done) || load(`${STORE}:hint:${key}`, false)) return null;
    save(`${STORE}:hint:${key}`, true);
    track('hint', { key });
    const h = el('div', 'hintonce');
    h.dataset.hint = key;
    h.append(el('span', 'k', 'Tip'), el('span', 't', text));
    const x = el('button', 'x', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Close the tip');
    h.append(x);
    h.addEventListener('click', () => h.remove());
    return h;
  }
  // going out of bounds keeps the clock stopped inside the last 2:00 of the first half and the last 5:00 of the game
  // (and in overtime): it matters to you then when you're behind or tied, or the half is ending. The switch shows only
  // then (it said "tries to stop the clock" when going out stops nothing, and was offered to a team ahead late)
  const oobMatters = (r) => r.pos === G.me && !r.untimed && halfLeft(r.t) <= (r.t > 1800 ? 120 : 300) && (r.t > 1800 || r.score[G.me] - r.score[1 - G.me] <= 0);
  const setOob = (v) => { ui.oob = v; G.oobOff = !v; };
  function oobToggle() {
    const tg = el('div', 'toggle urgent');
    const lab = el('div', 'lab', '⏱ Get out of bounds');
    // (what the switch does from where it is: off by default when tied, it said "Turn it off")
    const how = () => `Going out stops the clock now. ${ui.oob ? 'Turn it off to stay in bounds and keep the clock running.' : 'Turn it on to get out of bounds when you can.'}`;
    const note = el('small', '', how());
    lab.append(note);
    const sw = el('button', 'sw2');
    sw.type = 'button'; sw.id = 'oobSwitch';
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.oob)); sw.setAttribute('aria-label', 'Get out of bounds');
    sw.addEventListener('click', () => { setOob(!ui.oob); sw.setAttribute('aria-checked', String(ui.oob)); note.textContent = how(); });
    tg.append(lab, sw);
    return tg;
  }
  const PASS_MORE_KEY = `${STORE}:passmore`, passMore = () => load(PASS_MORE_KEY, false) === true;
  function drawPassDock(head) {
    const r = G.root, d = $('dock'), P = ui.pass, sc = scene;
    head.append(el('h2', '', 'Pass'));
    if (r.clock_running) head.append(el('span', 'sub', CLOCK[ui.tempo].short));
    const back = el('button', 'chip', bcast() ? '◀' : '◀ Back');       // (a phone: the head's one line, as Undo and Draw)
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', () => { if (busy) return; ui.step = 'family'; drawField(); drawDock(); });
    head.append(back);
    if (P.hist && P.hist.length) {
      const undo = el('button', 'chip', bcast() ? '↶' : '↶ Undo');
      undo.type = 'button';
      undo.setAttribute('aria-label', 'Undo the last route change');
      undo.addEventListener('click', undoRoute);
      head.append(undo);
    }
    const cn = !P.draw && sc ? conceptNow(sc) : null, plays = el('button', `chip plays${cn ? ' on' : ''}`, `📋 ${cn ? `${cn.c.name}${cn.edited ? ' ✎' : ''}` : 'Plays'}`);
    plays.type = 'button'; plays.id = 'playsBtn';
    plays.setAttribute('aria-label', cn ? `Pass plays: ${cn.c.name} set${cn.edited ? ', with your route changes' : ''}` : 'Pass plays: pick a concept');
    plays.addEventListener('click', openConcepts);
    if (!P.draw) head.append(plays);
    const pen = el('button', `chip pen${P.draw ? ' on' : ''}`, P.draw ? '✓ Done' : bcast() ? '✏️' : '✏️ Draw');
    pen.type = 'button'; pen.id = 'drawBtn';
    pen.setAttribute('aria-label', P.draw ? 'Done drawing routes' : 'Draw routes');
    pen.setAttribute('aria-pressed', String(!!P.draw));
    pen.addEventListener('click', () => { if (!busy) setDraw(!P.draw); });
    head.append(pen);
    // the simple pass screen by default (a player: "getting way too complicated, can barely see the defense"): the
    // receivers, the quick throws and Snap; the protection and the play action and rollout toggles behind More (kept
    // per device), and shown anyway while one of them is on
    const full = passMore() || (G.prot && G.prot !== 'std') || P.pa || P.roll;
    if (!VS && !P.draw) {
      const mo = el('button', `chip more${passMore() ? ' on' : ''}`, bcast() ? '⋯' : passMore() ? 'Less' : 'More');     // (a phone: the head's one line)
      mo.type = 'button'; mo.id = 'passMore';
      mo.setAttribute('aria-pressed', String(passMore()));
      mo.setAttribute('aria-label', passMore() ? 'Fewer pass options' : 'More pass options: protection, play action, rollout');
      mo.addEventListener('click', () => { if (busy) return; save(PASS_MORE_KEY, !passMore()); track('pass_more', { on: passMore() }); redrawPass(); });
      head.append(mo);
    }
    // (the broadcast view on a phone: the defense's look in the head's line, the receivers' room below it)
    if (G.look != null && bcast()) { const L = LOOKS[G.look], rc = el('span', `readchip${L.blitz ? ' blitz' : ''}`, `${L.loaded ? 'Loaded box' : 'Light box'}${L.blitz ? ' · blitz' : ''}`); rc.title = L.loaded ? '7 or more near the line' : '6 or fewer near the line'; head.insertBefore(rc, head.querySelector('#playsBtn') || pen); }
    else if (G.look != null) d.append(readLine(G.look));
    if (!VS && full) {
      // the protection (PROTS): one tap, kept for the drive's next passes
      const cur = G.prot || 'std', row = el('div', 'opts-row prots');
      row.append(el('span', 'lab', 'Protection'));
      PROTS.forEach(([k, label, tip]) => {
        const b = el('button', `chip opt${cur === k ? ' on' : ''}`, bcast() ? PROT_SHORT[k] : label);
        b.type = 'button'; b.title = tip; b.dataset.prot = k;
        b.setAttribute('aria-pressed', String(cur === k));
        b.addEventListener('click', () => {
          if (busy || !sc) return;
          G.prot = k;
          if (P.target != null && blocks(sc, P.target)) P.target = null;
          track('pass_prot', { prot: k });
          redrawPass();
        });
        row.append(b);
      });
      d.append(row);
    }
    const E = eligibles(sc), selA = P.draw && P.sel != null ? E[P.sel] : null;
    // (the whole of it the first few times; after that one line, so the receivers and the Snap key fit under the field)
    if (!P.draw) {
      const h = load(`${STORE}:passhint`, 0) < 3 && !bcast() ? el('p', 'hint', 'Snap throws to the open man, or tap a name to pick who gets the ball. Tap a man on the field for his next route, or drag him to draw one.')
        : el('p', 'hint one', 'Snap: the open man, or pick one. Tap a dot: his route.');
      h.title = 'Snap throws to whoever gets open, or tap a name to pick who gets the ball (tap it again for the open man). Tap a receiver on the field to change his route, or drag him to draw your own (drag the quarterback for his drop or a rollout).';
      d.append(h);
    } else {
      const h = el('p', 'hint draw', selA ? `Now drag from ${shortName(selA.p ? selA.p.name : '') || selA.label} to where he should go.`
        : 'Tap a receiver, then drag on the field where you want him to go. Each line plays as the real route it is closest to; drag the quarterback to the side to roll out.');
      if (P.drawn && P.drawn.some(Boolean)) {
        const clr = el('button', 'linkbtn', 'Clear drawings');
        clr.type = 'button';
        clr.addEventListener('click', () => {
          if (busy) return;
          const def = defaultRoutes(sc);
          P.drawn.forEach((x, k) => { if (x) { (P.hist = P.hist || []).push([k, P.routes[k], x]); P.routes[k] = def[k]; P.drawn[k] = null; } });
          redrawPass();
        });
        h.append(' ', clr);
      }
      d.append(h);
    }
    // the receivers, a row each: a tap picks who gets the ball (the Snap key at the foot throws it)
    const list = el('div', 'rcvs');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Who gets the ball');
    E.forEach((a, i) => {
      if (blocks(sc, i)) {                    // (kept in by your protection: no route, no ball)
        const b = el('button', 'rcv blk');
        b.type = 'button'; b.disabled = true;
        b.append(el('span', 'pos', a.label), el('span', 'nm', shortName(a.p ? a.p.name : '') || a.label), el('span', 'rt', 'Blocking'));
        b.setAttribute('aria-label', `${a.p ? a.p.name : a.label}: staying in to block`);
        list.append(b);
        return;
      }
      const b = el('button', `rcv${P.target === i ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(P.target === i));
      const pk = pickKey(passOption(sc, i, false).action), od = G.odds && G.odds[pk];
      b.dataset.k = pk;
      const dr = P.drawn && P.drawn[i];
      b.append(el('span', 'pos', a.label), el('span', 'nm', shortName(a.p ? a.p.name : '') || a.label),
        el('span', 'rt', `${dr ? '✏️ ' : ''}${routeName(a.label, P.routes[i])}${dr ? ` · ${dr.depth} yds` : ''}`));
      if (od) b.append(oddsEl(od));
      b.setAttribute('aria-label', `${P.target === i ? 'The target (tap again for the open man)' : 'Throw to'}: ${a.p ? a.p.name : a.label}, ${routeName(a.label, P.routes[i])}`);
      b.addEventListener('click', () => { if (!busy) passPick(i); });
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
    // (a toggle tapped takes back a rollout drawn: the quarterback's line goes with it)
    if (full || VS) opts.append(opt('Play action', 'Fake the handoff first: it freezes a loaded box.', P.pa, (v) => { P.pa = v; if (v) { P.roll = false; P.qb = null; P.rollSide = null; } }),
      opt(P.roll && P.rollSide ? `Roll out ${P.rollSide === 'strong' ? 'strong' : 'weak'}` : 'Roll out', 'Move the pocket toward your receiver’s side (or drag the quarterback the way to go).', P.roll, (v) => { P.roll = v; P.qb = null; P.rollSide = null; if (v) P.pa = false; }));
    if (oobMatters(r)) opts.append(opt('⏱ Out of bounds', 'Going out stops the clock now.', ui.oob, setOob, 'oobSwitch'));
    if (opts.childElementCount) d.append(opts);
    d.append(list);
    const avail = callOptions(r).calls, more = ['hail_mary'].filter((id) => avail.includes(id));
    // the screen in one tap: the back's route set to the screen and the ball to him (it was only a route on the
    // picker, which players didn't find, while the grade could still name the screen as the best call)
    const extra = (avail.includes('quick_strong') ? ['quick_strong'] : []).concat(avail.includes('screen') ? ['screen'] : [], more);
    if (extra.length) {
      const row = el('div', 'keys pmore');
      row.style.setProperty('--cols', extra.length);
      extra.forEach((id, i) => {
        const b = key(id === 'screen' ? 'Screen' : id === 'quick_strong' ? 'Quick pass' : CALL[id].label.replace(/ \(.*\)$/, ''),
          id === 'screen' ? 'Back, receiver or tight end, blockers in front' : id === 'quick_strong' ? 'Out fast: the QB takes the first man open' : null, 'alt', i);
        b.addEventListener('click', () => { if (!busy) decideCall({ call: id }); });
        row.append(b);
      });
      d.append(row);
    }
    // the snap: one key, always in sight at the foot of the sheet (the dock beside the field), the throw to the target
    // as his row would have made it (decideCall: snap first, graded while the play runs)
    // (no one picked: to the open man)
    const t = E[P.target] ? P.target : null, ta = E[t], foot = el('div', 'keys snapbar');
    foot.style.setProperty('--cols', 1);
    const go = key('', ' ', 'big snap', 0), line = el('span', 'go');
    line.append(el('span', 'sn', 'Snap · '), el('b', '', ta ? shortName(ta.p ? ta.p.name : '') || ta.label : 'open man'));
    go.firstChild.replaceWith(line);
    go.id = 'snapGo';
    go.setAttribute('aria-label', ta ? `Snap: throw it to ${ta.p ? ta.p.name : ta.label}, ${routeName(ta.label, P.routes[t])}` : 'Snap: throw it to the open man');
    go.addEventListener('click', () => { if (!busy && passing()) decideCall(t == null ? { pass: openI(scene), open: true } : { pass: t }); });
    foot.append(go);
    d.append(foot);
    snapLine();
    snapFit();
    if (document.fonts && document.fonts.status === 'loading') document.fonts.ready.then(snapFit, () => {});     // (fitted in its own type)
    fetchOdds();
    // only on the way in: after that the page stays put while you change routes
    if (P.fresh) {
      P.fresh = false;
      save(`${STORE}:passhint`, load(`${STORE}:passhint`, 0) + 1);
      if (!bcast()) requestAnimationFrame(() => foot.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }));
    }
  }
  // the Snap key's second line: the target's route and his odds on it (when they are in)
  function snapLine() {
    const g = $('snapGo'), P = ui.pass;
    if (!g || !passing() || !scene) return;
    const a = eligibles(scene)[P.target];
    if (!a) {             // the open man: the throw's odds as the engine plays it
      const op = passOption(scene, openI(scene), false), od = G.odds && G.odds[pickKey(op.action)];
      g.querySelector('small').textContent = `whoever gets open${od ? ` · ${oddsText(od)}` : ''}`;
      return;
    }
    const od = G.odds && G.odds[pickKey(passOption(scene, P.target, false).action)];
    g.querySelector('small').textContent = `${P.drawn && P.drawn[P.target] ? '✏️ ' : ''}${routeName(a.label, P.routes[P.target])}${od ? ` · ${oddsText(od)}` : ''}`;
  }
  // The Snap key's first line stays one line with the name whole (a long name wrapped it, the key growing at the foot
  // of the sheet: in the wider type a phone shows before the game's own comes in, on a page zoomed narrow): the type a
  // step smaller first, then "Snap ·" goes and the name stands alone (game.html .snap.tight, .bare), and past that
  // the name in type as small as it takes. Its second line, the route and the odds, is cut at its end instead
  function snapFit() {
    const g = $('snapGo'), line = g && g.querySelector('.go');
    if (!line) return;
    g.classList.remove('tight', 'bare');
    line.style.fontSize = '';
    if (!line.clientWidth) return;                      // (not shown: a resize, or the fonts coming in, fits it again)
    const over = () => line.scrollWidth > line.clientWidth + 0.5;
    for (const c of ['tight', 'bare']) {
      if (!over()) return;
      g.classList.add(c);
    }
    // (in steps: the letter spacing, set on the key, stays as it is)
    for (let k = 0; k < 4 && over(); k++) {
      const cs = getComputedStyle(line), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      line.style.fontSize = `${Math.floor(parseFloat(cs.fontSize) * ((line.clientWidth - pad) / (line.scrollWidth - pad)) * 10) / 10}px`;
    }
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
  // A defense that sits on what you keep throwing (players spammed the hitch and it kept working): the same route (a
  // receiver's pick, whoever runs it) or pass call as in your last REP_N snaps; from the third time in them on, its real
  // plays are drawn toward the worse ones (engine.js REPEAT_S), and it is graded that way too (every option carries its
  // own count). Said before the snap once you have run it twice
  const REP_N = 4;
  const repKey = (a) => (a && a.play === 'pass' && a.call && a.call !== 'hail_mary' ? (a.route ? `r:${a.route}` : `c:${a.call}`) : null);
  function repOf(a) {
    const k = !VS && repKey(a);
    return k ? ((state && state.rep) || []).slice(-REP_N).filter((x) => x === k).length : 0;
  }
  function rememberRep(a) {
    if (!state || VS) return;
    state.rep = ((state.rep || []).concat([repKey(a) || '-'])).slice(-REP_N);
  }
  function repNote() {
    const L = (state && state.rep) || [], k = L[L.length - 1];
    if (VS || !k || k === '-' || L.slice(-REP_N).filter((x) => x === k).length < 2) return null;
    const what = k.startsWith('r:') ? (ROUTE_SAY[k.slice(2)] || 'that route') : `${(CALL[k.slice(2)] || { label: 'that call' }).label.toLowerCase()}`;
    const n = L.slice(-REP_N).filter((x) => x === k).length;
    return `They have seen ${what} ${n === 2 ? 'twice' : `${n} times`} in your last ${Math.min(L.length, REP_N)} plays: they are sitting on it.`;
  }
  // ---- personnel: optional; a button under the field opens the sheet (who is on the field, and why it matters)
  const PERS_INFO = {
    11: ['1 RB · 1 TE · 3 WR', 'Spread it out: the NFL’s base set, about 6 snaps in 10.'],
    12: ['1 RB · 2 TE · 2 WR', 'Balanced: run or play action out of the same look. About 2 in 10.'],
    21: ['2 RB (a fullback) · 1 TE · 2 WR', 'Power: a lead blocker for the run, and play action off it.'],
    13: ['1 RB · 3 TE · 1 WR', 'Heavy: short yardage and the goal line.'],
  };
  // the timeout on the field, by the other buttons there (players asked): yours to call with the clock running, or,
  // on defense, the "timeout first" before their snap. A phone's broadcast view only, where it is always in sight
  // (the sheet scrolls, or is down); a wide screen has it with the calls beside the field (one or the other, never both)
  function placeTo() {
    const b = $('toBtn'), fov = document.querySelector('.fieldbox .fov');
    if (!b || !fov) return;
    b.style.left = ''; b.style.right = '';
    if (!bcast()) { b.style.top = ''; ezClear(scene); return; }
    const fb = fov.parentElement.getBoundingClientRect(), last = [...fov.querySelectorAll('.btns > :not([hidden])')].pop();
    const bottom = (last || fov).getBoundingClientRect().bottom, top0 = Math.round(bottom - fb.top + 8);
    b.style.top = `${top0}px`;
    // clear of the players' dots (it sat on a safety's): there, or beside the last row of chips, or further
    // down the right side or on the left under the down and distance, the first place clear (and above the calls'
    // sheet); else where it was
    const dots = b.hidden ? [] : actorRects(scene), w = b.offsetWidth, h = b.offsetHeight;
    if (dots.length && w) {
      const fl = fov.querySelector('.fovl'), chips = [...fov.querySelectorAll('.fovl > *, .btns > *')].filter((e) => !e.hidden && e.getClientRects().length)
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width);
      const sheet = $('sheet'), floor = sheet && !sheet.classList.contains('down') ? sheet.getBoundingClientRect().top - 6 : window.innerHeight - 72;
      const topL = Math.round(Math.max(bottom, fl ? fl.getBoundingClientRect().bottom : 0) - fb.top + 8);
      // (an end zone's name too, if it can be: ezClear moves it only as far as its end zone goes)
      const names = [...(scene ? scene.svg.querySelectorAll('text.ez') : [])].map((t) => t.getBoundingClientRect()).filter((r) => r.width);
      const free = (x, y, rs) => !rs.some((r) => r.left < x + w + 3 && r.right > x - 3 && r.top < y + h + 3 && r.bottom > y - 3);
      const clear = (x, y) => y + h <= floor && x >= fb.left && free(x, y, dots.concat(chips));
      const xr = fb.right - 8 - w, xl = fb.left + 8, lr = last && last.getBoundingClientRect();
      const spots = [[xr, fb.top + top0]];
      if (lr) spots.push([lr.left - 6 - w, lr.top]);
      for (let i = 0; i <= 12; i++) spots.push([xr, fb.top + top0 + 8 * (i + 1)], [xl, fb.top + topL + 8 * i]);
      const at = spots.find(([x, y]) => clear(x, y) && free(x, y, names)) || spots.find(([x, y]) => clear(x, y));
      if (at) Object.assign(b.style, { top: `${Math.round(at[1] - fb.top)}px`, left: `${Math.round(at[0] - fb.left)}px`, right: 'auto' });
    }
    ezClear(scene);
  }
  // the players' dots on the screen (where the scene puts them: not mid-way through a move)
  function actorRects(sc) {
    if (!sc || !sc.svg.isConnected || $('field').classList.contains('playing')) return [];
    const m = sc.svg.getScreenCTM(), Y = camY(sc);
    if (!m) return [];
    return sc.actors.map((a) => {
      let bb;
      try { bb = a.g.getBBox(); } catch (e) { return null; }
      const x = a.x, y = Y(a.L) + a.side * GAP * a.w;
      return { left: m.a * (x + bb.x) + m.e, right: m.a * (x + bb.x + bb.width) + m.e, top: m.d * (y + bb.y) + m.f, bottom: m.d * (y + bb.y + bb.height) + m.f };
    }).filter(Boolean);
  }
  // the end zones' names clear of the buttons over the field (the 1× chip sat on the S of BROWNS): nudged along the
  // end zone, away from them, as far as it goes
  function ezClear(sc) {
    if (!sc || !sc.svg.isConnected || $('field').classList.contains('playing')) return;
    const sr = sc.svg.getBoundingClientRect();
    if (!sr.height) return;
    const k = sc.H / sr.height, Y = camY(sc);
    const chips = [...document.querySelectorAll('.fieldbox .fov .dd, .fieldbox .fov .ramp, .fieldbox .fov .btns > *, #toBtn')]
      .filter((e) => !e.hidden && e.getClientRects().length).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    sc.svg.querySelectorAll('text.ez').forEach((t) => {
      if (!t.upd) return;
      t.dataset.dy = 0; t.upd(Y);
      const r = t.getBoundingClientRect();
      let need = 0;
      chips.forEach((c) => {
        if (c.left >= r.right || c.right <= r.left || c.top >= r.bottom || c.bottom <= r.top) return;
        const n = c.top + c.height / 2 < r.top + r.height / 2 ? c.bottom + 4 - r.top : c.top - 4 - r.bottom;
        if (Math.abs(n) > Math.abs(need)) need = n;
      });
      if (need) { t.dataset.dy = need * k; t.upd(Y); }
    });
  }
  function toButton() {
    const b = $('toBtn'), r = G && G.root;
    if (!b) return;
    // (on a phone it is the only timeout control, so it shows whenever a timeout can be called, late or not, on every
    // step of your call: players looked for it after picking Pass. When it can't be called, it says why, greyed out:
    // "I don't see the timeout option always")
    const mine = !!(r && toOnField() && ['family', 'pass', 'detail'].includes(ui.step) && r.phase === SNAP && r.pos === G.me && !G.over);
    const off = mine && r.clock_running && clockOptions(r).includes('timeout');
    // (none left: no button; the dock's own note says so, as before)
    const why = mine && !off && r.to[G.me] > 0 ? (!r.clock_running ? 'clock stopped' : 'you lead: let it run') : null;
    const def = !!(r && toOnField() && !VS && (ui.step === 'vdef' || ui.step === 'defense') && defTimeoutOk(r));
    b.hidden = !(off || def || why) || busy;
    if (b.hidden) return;
    b.disabled = !!why;
    b.classList.toggle('on', def && !!ui.to);
    b.textContent = off || why ? '⏱ Timeout' : `⏱ Timeout first${ui.to ? ' ✓' : ''}`;
    b.append(el('small', '', why || `${r.to[G.me]} left`));
    b.setAttribute('aria-pressed', String(def && !!ui.to));
    // (the broadcast view: just under the chips on the field, however many rows they wrap to; again once the sheet
    // and the field have settled, where the players end up)
    placeTo();
    clearTimeout(toButton.h); toButton.h = setTimeout(placeTo, 450);
    b.onclick = () => {
      if (busy || b.disabled) return;
      if (off) { b.hidden = true; decideTimeout(); return; }
      ui.to = !ui.to;
      const sw = $('toSwitch');
      if (sw) sw.setAttribute('aria-checked', String(ui.to));
      toButton();
    };
  }
  // (the chips first, then the timeout under them: placed before the personnel chip showed, it sat over Ratings when
  // the chips wrapped to a second row on a 375-wide phone)
  function persButton() { persChip(); toButton(); ezClear(scene); }
  // the formation (game.js formation): the quarterback's spot, charted by FTN and what the plays are drawn by (engine.js
  // FORM_CODE), and the receivers' look, drawn only (no charting tells a bunch from a spread; the plays are the same)
  const FORM_QB = [['gun', 'Shotgun', 'The quarterback five yards back, the back beside him. About 6 snaps in 10.'],
    ['under', 'Under center', 'The back seven deep (a fullback in front of him: the I). About 3 in 10.'],
    ['pistol', 'Pistol', 'The quarterback four back, the back behind him. About 1 in 20.'],
    ['empty', 'Empty', 'Nobody in the backfield: the back split out. The play is drawn from real plays run from an empty set.']];
  const FORM_LOOK = [['trips', 'Trips', 'Three receivers to the strong side.'], ['spread', 'Spread', 'Two and two.'],
    ['bunch', 'Bunch', 'Three in a cluster off the tackle.'], ['tight', 'Tight', 'Everyone in close to the line.']];
  const FORM_ENGINE = { gun: 1, under: 2, pistol: 3 };         // (engine.js FORM_CODE: the formations the plays are drawn by)
  const formName = (f) => (!f || (!f.qb && !f.look) ? 'as lined up' : [f.qb && f.qb !== 'gun' ? FORM_QB.find((x) => x[0] === f.qb)[1] : '', f.look && f.look !== 'trips' ? FORM_LOOK.find((x) => x[0] === f.look)[1] : ''].filter(Boolean).join(' · ') || 'Shotgun trips');
  function formChip() {
    const b = $('formBtn'), r = G && G.root;
    if (!b) return;
    const show = !!(r && r.phase === SNAP && r.pos === G.me && !r.try2 && !G.over);
    b.hidden = !show;
    if (!show) return;
    b.textContent = '';
    b.append(document.createTextNode(`Formation · ${formName(G.form)}`));
    const pen = S('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
    pen.append(S('path', { d: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4' }));
    b.append(pen);
  }
  function openForm() {
    if (busy || !G || G.root.pos !== G.me) return;
    const before = persSnap();
    let dirty = false;
    const MARK = { gun: 'SG', under: 'UC', pistol: 'P', empty: '0', trips: '3×1', spread: '2×2', bunch: 'B', tight: 'T' };
    const set = (key, k) => {
      const nf = { ...(G.form || {}), [key]: k };
      G.form = (!nf.qb || nf.qb === 'gun') && (!nf.look || nf.look === 'trips') ? null : nf;
      track('formation', { qb: nf.qb || 'gun', look: nf.look || 'trips' });
      persist(); dirty = true; persButton(); render();
    };
    const group = (list, key, cur) => {
      const g = el('div', 'pgroups');
      list.forEach(([k, t, sub]) => {
        const on = cur === k, b = el('button', `pgroup${on ? ' on' : ''}`);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(on));
        const txt = el('div');
        txt.append(el('div', 't', t), el('div', 's', sub));
        b.append(el('b', '', MARK[k]), txt);
        b.addEventListener('click', () => set(key, k));
        g.append(b);
      });
      return g;
    };
    const render = () => {
      const f = G.form || {};
      const hint = el('p', 'phint', 'Optional. Where the quarterback stands and how many backs are behind him are charted on the real plays: pick the shotgun, under center, the pistol or an empty set (with two backs in your personnel, two-back sets) and the play is drawn from real plays run from it (never from a handful: too few, and every play counts). The receivers’ look is the lineup on the field only.');
      const done = el('button', 'btn pdone', 'Done');
      done.type = 'button';
      done.addEventListener('click', closeModal);
      const reset = el('button', 'ghost', 'Back to the real lineup');
      reset.type = 'button';
      reset.addEventListener('click', () => { G.form = null; persist(); dirty = true; persButton(); render(); });
      const b = $('mBody'); b.textContent = '';
      [hint, group(FORM_QB, 'qb', f.qb || 'gun'), el('h3', '', 'Receivers'), group(FORM_LOOK, 'look', f.look || 'trips'), reset, done].forEach((n) => b.append(n));
    };
    onModalClose = () => { if (dirty) { drawField(); persMove(before); if (passing()) drawDock(); } };
    openModal('Formation', []);
    render();
  }
  function persChip() {
    formChip();
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
    placeTo();                // (where they end up: actorRects)
  }
  function openPers() {
    if (busy || !G || G.root.pos !== G.me) return;
    const real = persOf(lineup(G.me).off);
    const nodes = [];
    // the quarterback: the one who lined up (the spot's own, or the one a scenario put in) and that game's others on the
    // roster (lineup.qbs: history.py qb_room, each with what he brings, adj). Not in Versus: the room plays its own teams
    const base = teamBase(G.me), bq = ((base.lineup || {}).off || []).find((p) => p.pos === 'QB');
    const qbs = bq && !VS ? [bq, ...((base.lineup || {}).qbs || []).filter((q) => q.name !== bq.name && typeof q.adj === 'number')] : [];
    const render = () => {
      const cur = G.pers || real, L = lineup(G.me);
      const hint = el('p', 'phint', `Optional. The play is drawn from real NFL plays run with the grouping you pick; the players you pick are the ones on the field and the ones you can throw to${qbs.length > 1 ? ', and the quarterback’s passes go as his had before this game' : ''}.`);
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
      if (qbs.length) {
        // first, the quarterback: J.J. McCarthy · 71 (backup); under it how his passing compares with the starter's
        const row = el('label', 'pslot'), sel = el('select'), now = qbOn() ? G.qb : bq.name;
        sel.setAttribute('aria-label', 'QB');
        qbs.forEach((c) => {
          const o = el('option', '', `${c.name}${c.ovr ? ` · ${c.ovr}` : ''}${c === bq ? '' : ' (backup)'}`);
          o.value = c.name;
          if (c.name === now) o.selected = true;
          sel.append(o);
        });
        sel.disabled = qbs.length < 2;
        sel.addEventListener('change', () => { G.qb = sel.value === bq.name ? null : sel.value; qbChanged(); changed(); });
        row.append(el('span', '', 'QB'), sel);
        slots.append(row);
        const who = qbs.find((c) => c.name === now), d = who && who !== bq ? who.adj - ((base.qb && base.qb.adjustment) || 0) : 0;
        const vs = who === bq ? '' : Math.abs(d) < 0.005 ? ` Throws about as well as ${shortName(bq.name)}.`
          : ` Throws ${Math.abs(d).toFixed(2)} EPA a dropback ${d < 0 ? 'worse' : 'better'} than ${shortName(bq.name)}.`;
        if (who) slots.append(el('p', 'pqb', `${who.stat || 'Little NFL playing time yet'}.${vs}`));
      }
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
      reset.addEventListener('click', () => { const q = G.qb; G.pers = null; G.persWho = null; G.qb = null; if (q) qbChanged(); changed(); });
      nodes.length = 0;
      nodes.push(hint, groups, el('h3', '', 'Who plays'), slots, reset, done);
      const b = $('mBody'); b.textContent = ''; nodes.forEach((n) => b.append(n));
    };
    // another quarterback: the call's facts and each receiver's odds asked again of his simulator (simScen); the snap's
    // grading always is (every call valued with him: the same lineup for all)
    const qbChanged = () => {
      G.odds = {};
      const r = G.root;
      send({ type: 'info', scen: simScen(), root: r }, true).then((m) => { if (G && G.root === r) G.info = m.info; }).catch(() => { /* asked again at the next snap */ });
    };
    const changed = () => {
      track('personnel', { pers: G.pers || real, custom: !!G.persWho, qb: !!G.qb });
      persist();
      dirty = true;          // the field redraws, players moving, when the sheet closes (it covers the field on phones)
      persButton(); render();
    };
    let dirty = false;
    const before = persSnap();
    // (a pass being drawn: its receivers' cards and odds too)
    onModalClose = () => { if (dirty) { drawField(); persMove(before); if (passing()) drawDock(); } };
    openModal('Personnel', []);
    render();
  }
  // a tempo whose usual run-off before the snap is the time left in the half: the clock runs out on it (a player at 0:02,
  // No-huddle "about 16 s" picked for him, lost to the clock with two timeouts left)
  const runsOut = (k, r) => r.clock_running && (tempoSecs(k, r) || 0) >= halfLeft(r.t);
  const allRunOut = (r) => TEMPOS.every((k) => runsOut(k, r));
  // ... which is a loss of time only to a team that needs it: ahead in the second half, the clock running out is the win
  // (up 7 at 0:26, their timeouts gone, No-huddle was picked for him and Huddle / Milk it shown in red)
  const wantsTime = (r) => r.t > 1800 || r.score[G.me] <= r.score[1 - G.me];
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
      b.append(el('b', '', CLOCK[k].short), el('small', runsOut(k, r) && wantsTime(r) ? 'out' : '', runsOut(k, r) ? 'clock runs out' : secs ? `about ${Math.round(secs)} s` : ''));
      const mark = () => seg.querySelectorAll('.segb').forEach((x, i) => {
        x.classList.toggle('on', TEMPOS[i] === ui.tempo); x.setAttribute('aria-checked', String(TEMPOS[i] === ui.tempo));
      });
      b.addEventListener('click', () => { if (!busy) { ui.tempo = k; mark(); } });
      seg.append(b);
      if (k === TEMPOS[TEMPOS.length - 1]) requestAnimationFrame(mark);
    });
    w.append(seg);
    if (allRunOut(r) && wantsTime(r)) {
      const o = clockOptions(r), to = o.includes('timeout'), sp = o.includes('spike');
      const warn = `⏱ The clock runs out before the snap${to || sp ? `: use ${[to && 'a timeout', sp && 'a spike'].filter(Boolean).join(' or ')}` : ''}.`;
      w.append(el('p', 'warn', warn));
      say(warn.slice(2), `warn${r.t}`);
    }
    return w;
  }

  function situation(r) { return `${G.cot ? `${G.cot.round > 1 ? G.cot.round : ''}OT` : `${clockOf(r.t).text} ${qLabel(r)}`}, ${ddText(r)} ${onSpot(r)}`; }
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
      const vals = await evaluateGraded(sp.r, sp.opts, sp.seed, simScen('qb' in pend ? pend.qb : G.qb));      // (with the quarterback of its snap)
      // (ctx: the score and the clock it was made at, for its tip: whyLine)
      const ctx = { lead: sp.r.score[G.me] - sp.r.score[1 - G.me], left: Math.round(halfLeft(sp.r.t)), h2: sp.r.t <= 1800 };
      out.push({ ...decisionFrom(sp.kind, sp.family, sp.opts, vals, sp.chosen, sp.q, sp.situation, pend.snap), ctx, ...(sp.extra || {}),
        ...(crowdOn() ? { ck: crowdKey(sp.r, sp.kind) } : {}) });      // (ck: the situation, for the crowd's calls)
    }
    return out;
  }
  async function snapThenGrade(specs, action) {
    if (ui) ui.step = 'snapped';           // (the call is made: nothing more is drawn on this snap)
    if (cotDaily()) { const res = await cotPlay(action); cotShowResult(res); return; }
    if (VS) {
      const r = G.root;
      vsSubmit(r.phase === SNAP && r.pos !== G.me ? { def: action.def, to_def: !!action.to_def } : { action });
      return;
    }
    await simWait();
    const pend = { snap: G.snapN, specs, qb: G.qb || null };
    G.snapN += 1;
    G.pending = pend;
    const graded = gradeSpecs(pend);
    graded.catch(() => {});
    if (crowdOn()) crowdCounts();          // (the crowd's counts on their way while the play runs: crowdLine, under the result)
    status('Snap…', reduced() ? null : TOUCH ? 'Tap the field to skip' : 'Click the field or press Space to skip');
    const res = await stepWith(action);                // saves the spot, the grading job with it
    let done = false;
    graded.then(() => { done = true; }, () => { done = true; });
    await Promise.resolve();
    if (!done) status('Grading your call…');
    let decisions = await graded;
    // the clock ran out before the snap: the play never ran, so its call is not graded (the tempo, before it, is)
    if (!res.log.some((e) => ['play', 'fg', 'punt', 'pat', 'kickoff'].includes(e.ev)) && decisions.some((x) => x.kind !== 'call')) decisions = decisions.filter((x) => x.kind !== 'call');
    decisions.forEach((x) => G.decisions.push(x));
    G.pending = null;
    persist();
    showResult(decisions, res);
  }
  // back after a reload in the middle of a snap (its grading jobs saved with the spot: G.regrade): the next call shows
  // at once and the grading runs behind it, after anything the next call needs (lowRoots: send), its grades joining
  // the drive's in the order they were made. A grade that can't be redone (an error, a call from an older build) is
  // dropped, not retried on every reload: the drive goes on without that one call's grade. The end of the drive waits
  // for it (regradeWait)
  function regradeBg() {
    const g = G;
    if (!g || g.regrading || !(g.regrade || []).length) return g && g.regrading;
    g.regrading = (async () => {
      while (g.regrade.length) {
        const pend = g.regrade[0];
        pend.specs.forEach((sp) => lowRoots.add(sp.r));
        let ds = [];
        try { ds = await gradeSpecs(pend); } catch (e) { /* dropped (above) */ }
        if (G !== g) return;
        g.regrade.shift();
        ds.forEach((x) => { const i = g.decisions.findIndex((y) => (y.snap ?? -1) > x.snap); if (i < 0) g.decisions.push(x); else g.decisions.splice(i, 0, x); });
        persist();
        const x = ds.find((y) => y.kind === 'call') || ds[0];
        if (x && !g.over && g.root.phase !== DONE && !$('play').hidden) { const m = markOf(x.cost); toast(`Your call before the reload: ${GLYPH[m]} ${m === 'g' ? ((x.gap ?? x.cost) < 0.0005 || x.best === x.chosen ? 'the best one' : 'as good as any') : GRADE_WORD[m]}`); }
      }
    })().finally(() => { g.regrading = null; });
    return g.regrading;
  }
  // the end of a drive: every call graded first (saying so, and how far along the simulator's data is if it is not in)
  async function regradeWait() {
    if (!G.regrading && !(G.regrade || []).length) return;
    huddle('Grading your last call…');
    await regradeBg();
  }
  // a timeout now, or (rundown) after letting the clock run down to 0:03 for the kick
  async function decideTimeout(rundown) {
    if (busy) return;
    if (VS) { vsSubmit({ timeout: true, rundown: !!rundown }); return; }
    busy = true;
    if (ui) ui.step = 'snapped';
    const r = G.root;
    try {
      await simWait();
      const x = (await gradeSpecs({ snap: G.snapN, specs: [clockSpec(r, rundown ? 'rundown' : 'timeout', G.seq)] }))[0];
      G.decisions.push(x);
      G.snapN += 1;
      const halfEnd = r.t > 1800 ? 1800 : 0;
      // the second it takes to stop the clock never carries it past the two-minute warning (which still comes) or
      // out of the half: a timeout called at 0:01 keeps the snap (engine.js the same at the warning)
      const floor = Math.min(r.t, r.t > halfEnd + 120 ? halfEnd + 120.01 : halfEnd + 0.5);
      const t = rundown ? Math.min(r.t - 1, halfEnd + RUNDOWN_AT) : r.t - 1;
      G.root = { ...r, to: r.to.slice(), clock_running: false, t: Math.max(floor, t), timeout: { team: G.me, left: r.to[G.me] - 1 } };
      G.root.to[G.me] -= 1;
      if (rundown) addLog(`Ran the clock down to ${clockOf(G.root.t).text}`, G.root.t, true);
      addLog(`Timeout, ${teamName(code(G.me))} (${G.root.to[G.me]} left)${rundown ? ', to set up the kick' : ''}`, G.root.t, true);
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
  // (the grouping goes with the call only when it is not the one the team lined up in: a man swapped for another of
  // his position in Who plays keeps the real grouping, and the plays are drawn as for everyone, not from just those
  // run with it there: a player who swapped one receiver had every snap drawn from a handful of real plays, the same
  // loss of 2 or 3 on run after run)
  const withTempo = (a) => {
    const b0 = G.pers && G.root.pos === G.me && G.pers !== persOf(lineup(G.me).off) ? { ...a, pers: G.pers } : a;
    // (the formation too, when it is one the plays are charted by: the quarterback in the shotgun, under center or in
    // the pistol; an empty set and the receivers' look are the lineup drawn only)
    // (an empty set and two backs too: the backs in the backfield are charted, FTN; engine.js persForm)
    const fq = G.form && G.root.pos === G.me ? G.form.qb : null;
    const backs = (lineup(G.me).off || []).filter((p) => p.pos === 'RB' || p.pos === 'FB').length;
    const b = fq && (FORM_ENGINE[fq] || fq === 'empty') ? { ...b0, form: FORM_ENGINE[fq] ? fq : 'gun', bf: fq === 'empty' ? 0 : Math.min(backs, 3) } : b0;
    const rp = repOf(b), c0 = rp ? { ...b, rep: rp } : b;
    const cp = protOn() && G.root.pos === G.me && c0.play === 'pass' && c0.call !== 'hail_mary' && c0.call !== 'screen' ? { ...c0, prot: G.prot } : c0;
    const c1 = schemeOn() && G.root.pos === G.me && cp.play === 'run' && /^rb_/.test(cp.call || '') ? { ...cp, scheme: G.scheme } : cp;
    const mo = G.root.pos === G.me ? curMotion(G.root) : null, c = mo && c1.play === 'pass' ? { ...c1, cov: mo.cov } : c1;
    return G.root.clock_running && ui && ui.tempo ? { ...c, tempo: engineTempo(ui.tempo, G.root) } : c;
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
      const passPick = pick.pass != null ? (pick.open ? openOption(scene, ui.oob) : passOption(scene, pick.pass, ui.oob)) : null;
      if (passPick) opts.push(passPick);
      if (ui.step === 'pass') ui.step = 'snapped';     // the routes and the picker are done with this snap
      specials.forEach((k) => opts.push({ key: k, label: specialLabel(k), action: withTempo({ to_off: false, play: k }) }));
      const chosen = passPick ? passPick.key : pick.call ? (ui.oob ? `${pick.call}+oob` : pick.call) : pick.special;
      remember(opts.find((o) => o.key === chosen).action.call);
      rememberRep(opts.find((o) => o.key === chosen).action);
      const cid = passPick ? passPick.action.call : pick.call;
      liveDrive.calls++;
      // a drawn run or RPO: the same call, the same grading; its path (and route) only go to the field
      if (pick.draw) track(`draw_${pick.drawKind}`, { mode: modeName(), call: cid, shape: pick.draw.shape || '', route: !!pick.draw.drawn });
      if (pick.draw && window.__sepLog) (window.__drawSnaps = window.__drawSnaps || []).push({ kind: pick.drawKind, call: cid });      // (browser tests)
      else if (passPick && (passPick.action.drawn || passPick.action.qbPath)) track('draw_pass', { mode: modeName(), call: cid });
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
      // a two-point try: the same call, played as the try. All of it: the receiver you picked, his route and the rest
      // (a player's pass on a try went to someone else: the target was dropped here), and the personnel
      if (r.try2) opts.forEach((o) => { o.action = { ...o.action, pat: 'two' }; });
      if (r.clock_running) specs.push(clockSpec(r, tempo, seq));
      specs.push({ kind: 'call', family: r.down === 4 ? 'fourth_down' : 'play_select', r: r.try2 || r, opts, chosen, q, situation: situation(r),
        seed: hash('call', seedKey(), G.si, seq) });
      const act = opts.find((o) => o.key === chosen).action;
      await snapThenGrade(specs, pick.draw ? { ...act, ...pick.draw } : act);
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // their ball: you call the defense (a timeout first, when it matters); the coordinator can take the drive
  // a timeout on their snap: whenever the clock runs late in a half and you have one, whatever the score (a player
  // leading by one looked for it, to save time for after their field goal); graded where it is the question
  // (defChoice) or when you take it
  const defTimeoutOk = (r) => r.clock_running && r.to[G.me] > 0 && lateHalf(r);
  const defTimeoutNone = (r) => !VS && r.clock_running && !(r.to[G.me] > 0) && lateHalf(r);
  async function promptDefense() {
    const r = G.root;
    huddle('Their huddle…');
    G.dinfo = firstInfo(r) || (await send({ type: 'info', scen: simScen(), root: r }, true)).info;
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
    if (!FULLDEF || simpleDef()) { ui = { step: 'defense', to: false }; drawDefDock(); toField(); return; }
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
    sketchChips(head, 'def');
    d.append(head);
    // drawn: the call it reads as (the parts as called, moved by what was drawn), graded as that call
    sketchPanel(d, 'def', (sk) => {
      if (busy || ui.step !== 'vdef') return;
      track('draw_def', { mode: modeName(), call: `${sk.dc.pers}/${sk.dc.front}/${sk.dc.cover}/${sk.dc.rush}` });
      if (window.__sepLog) (window.__drawSnaps = window.__drawSnaps || []).push({ kind: 'def', call: sk.dc.cover });
      track('defense_call', { mode: modeName(), call: `${sk.dc.pers}/${sk.dc.front}/${sk.dc.cover}/${sk.dc.rush}` });
      ui.step = 'sent';
      if (VS) vsSubmit({ dc: { ...sk.dc } }, sk.draw);
      else decideDefense({ ...sk.dc }, sk.draw);
    });
    const presets = el('div', 'vpresets');
    presets.setAttribute('aria-label', 'Quick calls');
    const box = el('div', 'vdef');
    const tip = el('p', 'vdeftip');
    const sum = el('div', 'vdefsum');
    const share = G.dinfo && G.dinfo.dshare;
    const mark = () => {
      box.querySelectorAll('.segb').forEach((b) => { const on = ui.dc[b.dataset.part] === (b.dataset.part === 'rush' ? +b.dataset.k : b.dataset.k); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      presets.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(sameDc(PRESET[b.dataset.k].dc, ui.dc))));
      const pk = presetsFor(G.root).find((k) => sameDc(PRESET[k].dc, ui.dc));
      sum.textContent = vdefText(ui.dc);
      tip.textContent = `${pk && PRESET[pk].sub ? `${PRESET[pk].sub}. ` : ''}${COVER_TIP[ui.dc.cover] || ''}`;
      drawField();                          // (the field lines up the defense as called)
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
    if (!VS && defTimeoutOk(r) && !toOnField()) {          // (a phone: the button on the field, toButton)
      const tg = el('div', 'toggle');
      const lab = el('div', 'lab', 'Timeout first');
      lab.append(el('small', '', `Stop the clock before their snap · ${r.to[G.me]} left`));
      const sw = el('button', 'sw2');
      sw.type = 'button'; sw.id = 'toSwitch';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!ui.to)); sw.setAttribute('aria-label', 'Timeout first');
      sw.addEventListener('click', () => { ui.to = !ui.to; sw.setAttribute('aria-checked', String(ui.to)); toButton(); });
      tg.append(lab, sw);
      d.append(tg);
    } else if (defTimeoutNone(r)) noTimeouts(d);
    persButton();         // (the offense's personnel chip off the field: it stayed up on defense)
    const keys = el('div', `keys${$('drawGo') ? '' : ' snapbar'}`);      // (the snap at the sheet's foot, or the drawing's)
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
    fitDock(keys);
    if (!VS) d.append(defModeChip(true));
    if (!VS) {
      const auto = el('button', 'chip', 'Let the coordinator call this drive');
      auto.type = 'button';
      auto.addEventListener('click', () => { if (busy) return; G.autoDef = true; advance(); });
      d.append(auto);
    }
    mark();
  }
  // the three-button defense (blitz, load the box, play it soft): the main site's until the full call is approved
  // between the full defense and the three simple calls, kept for the next visit
  function defModeChip(full) {
    const b = el('button', 'chip', full ? 'Simpler: just 3 defensive calls' : 'Full defense: personnel, front, coverage, rush');
    b.type = 'button';
    b.addEventListener('click', () => {
      if (busy) return;
      save(`${STORE}:simpledef`, full);
      track('defense_mode', { simple: full });
      if (full) { ui = { step: 'defense', to: !!ui.to }; drawDefDock(); }
      else { const r = G.root; ui = { step: 'vdef', dc: nflDefault(r, G.dinfo && G.dinfo.dshare), to: !!ui.to }; drawFullDefDock(); }
    });
    return b;
  }
  // (FULLDEF off, or the player asked for the simple calls)
  function drawDefDock() {
    const r = G.root, d = $('dock');
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', 'Your defense'), el('span', 'sub', `${teamName(code(r.pos))} ball · ${ddText(r)} · ${spotText(r)}`));
    sketchChips(head, 'def');
    d.append(head);
    sketchPanel(d, 'def', (sk) => { if (!busy) decideDefenseLooks(sk.call, sk.draw); });
    const keys = el('div', `keys fam def${$('drawGo') ? '' : ' snapbar'}`);
    keys.style.setProperty('--cols', 3);
    DEFS.forEach((k, i) => {
      const b = key(DEF[k].label, DEF[k].sub, 'big def', i);
      b.addEventListener('click', () => { if (!busy) decideDefenseLooks(k); });
      keys.append(b);
    });
    d.append(keys);
    fitDock(keys);
    if (defTimeoutOk(r) && (VS || !toOnField())) {          // (a phone: the button on the field, toButton)
      const tg = el('div', 'toggle');
      const lab = el('div', 'lab', 'Timeout first');
      lab.append(el('small', '', `Stop the clock before their snap · ${r.to[G.me]} left`));
      const sw = el('button', 'sw2');
      sw.type = 'button'; sw.id = 'toSwitch';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(ui.to)); sw.setAttribute('aria-label', 'Timeout first');
      sw.addEventListener('click', () => { ui.to = !ui.to; sw.setAttribute('aria-checked', String(ui.to)); toButton(); });
      tg.append(lab, sw);
      d.append(tg);
    } else if (defTimeoutNone(r)) noTimeouts(d);
    persButton();
    if (VS) return;
    if (FULLDEF) d.append(defModeChip(false));
    const auto = el('button', 'chip', 'Let the coordinator call this drive');
    auto.type = 'button';
    auto.addEventListener('click', () => { if (busy) return; G.autoDef = true; advance(); });
    d.append(auto);
  }
  async function decideDefenseLooks(k, draw) {
    if (busy) return;
    busy = true;
    liveDrive.calls++;
    track('defense_call', { mode: modeName(), call: k });
    if (draw) track('draw_def', { mode: modeName(), call: k });
    if (draw && window.__sepLog) (window.__drawSnaps = window.__drawSnaps || []).push({ kind: 'def', call: k });
    const r = G.root, me = G.me;
    try {
      const useTo = !!(ui.to && defTimeoutOk(r)), askTo = defTimeoutOk(r) && (useTo || defChoice(r)), seq = G.seq;
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
      await snapThenGrade(specs, { ...opts.find((o) => o.key === k).action, ...(draw || {}) });
    } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
    busy = false;
  }

  // your defense, graded: against the quick calls that fit the spot (and yours, when it is none of them), every one
  // played out from this snap (the offense reads your call and checks into what beats it); how often NFL defenses
  // line up like each, from the charting of the real plays here
  async function decideDefense(dc, draw) {
    if (busy) return;
    busy = true;
    liveDrive.calls++;
    const r = G.root, me = G.me;
    try {
      const useTo = !!(ui.to && defTimeoutOk(r)), askTo = defTimeoutOk(r) && (useTo || defChoice(r)), seq = G.seq;
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
      await snapThenGrade(specs, { ...act(dc), ...(draw || {}) });
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
      fgdef: { ask: 'They’re kicking a field goal', sub: `${teamName(code(r.pos))}: about a ${Math.round(r.yl + 17)}-yarder${punterKicks(r.pos) ? ` · their punter ${teamOf(r.pos).kicker.name} is kicking` : ''}`, family: 'fg_def',
        opts: [{ key: 'block', label: 'Go for the block', sub: 'All-out rush. A roughing flag gives them a first down', action: { to_def: false, st: 'block' } },
          { key: 'safe', label: 'Stay home', sub: 'Normal rush, no risk', action: { to_def: false, st: 'safe' } },
          ...(r.clock_running && r.to[me] > 0 ? [{ key: 'ice', label: 'Ice the kicker', sub: `Timeout first (${r.to[me]} left)`, action: { to_def: true, st: 'safe' } }] : [])],
        q: () => ({ block: 0.2, safe: 0.7, ...(r.clock_running && r.to[me] > 0 ? { ice: 0.1 } : {}) }) },
      // a punt that reaches the end zone (from their own 30 or nearer midfield: 2-23% of real punts do, 2020-25): set up
      // the return and he takes a knee there for the touchback (939 of the 945 that got there were), or he runs it out
      // (engine.js _punt 'ezret'); a timeout first stops the clock before it, as icing a kicker does
      puntdef: { ask: 'They’re punting', sub: `${teamName(code(r.pos))} from ${spotText(r)}`, family: 'punt_def',
        opts: [{ key: 'return', label: 'Set up the return', sub: r.yl <= PUNT_EZ_YL ? 'In the end zone he takes a knee: touchback' : 'Your returner gets a shot at it', action: { to_def: false, st: 'return' } },
          ...(r.yl <= PUNT_EZ_YL ? [{ key: 'ezret', label: 'Run it out', sub: 'Field it in the end zone and bring it out', action: { to_def: false, st: 'ezret' } }] : []),
          { key: 'rush', label: 'Rush the punt', sub: 'More blocks, a roughing risk, no return', action: { to_def: false, st: 'rush' } },
          ...(r.clock_running && r.to[me] > 0 ? [{ key: 'timeout', label: 'Timeout first', sub: `Stop the clock, then the return (${r.to[me]} left)`, action: { to_def: true, st: 'return' } }] : [])],
        q: () => {
          const to = r.clock_running && r.to[me] > 0 ? 0.1 : 0, ez = r.yl <= PUNT_EZ_YL ? 0.006 : 0;
          return { return: (1 - to) * (0.85 - ez), rush: (1 - to) * 0.15, ...(ez ? { ezret: (1 - to) * ez } : {}), ...(to ? { timeout: to } : {}) };
        } },
      freekick: { ask: 'Free kick', sub: 'After the safety: deep or onside?', family: 'onside',
        opts: [{ key: 'deep', label: 'Kick deep', action: { kick: 'deep' } }, { key: 'onside', label: 'Onside', action: { kick: 'onside' } }],
        q: () => coachProbs('onside', r, me) || { deep: 0.85, onside: 0.15 } },
    }[kind];
    persChip();
    // the kicks and the rush on theirs can be drawn (ST_DRAW): the field shows the kick or their kick formation
    const drawn = !!ST_DRAW[kind];
    if (drawn && !(ui.step === 'st' && ui.st === kind)) { ui = { step: 'st', st: kind, sk: null }; drawField(); }
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', spec.ask), el('span', 'sub', spec.sub));
    if (drawn) sketchChips(head, 'st');
    d.append(head);
    const keys = el('div', 'keys');
    keys.style.setProperty('--cols', spec.opts.length === 4 ? 2 : spec.opts.length);      // (four: two by two, room for the words)
    // a drawing reads as one of the same choices (an option the spot does not have is no choice: Onside only behind)
    const choose = async (o, draw) => {
      if (busy) return;
      busy = true;
      if (drawn) ui.step = 'sent';
      if (draw) track('draw_st', { mode: modeName(), kind, call: o.key });
      if (draw && window.__sepLog) (window.__drawSnaps = window.__drawSnaps || []).push({ kind: 'st', call: o.key });
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
        await snapThenGrade([sp], draw ? { ...o.action, ...draw } : o.action);
      } catch (e) { fatal('The simulation hit an error: ' + e.message + '. Reload the page to pick up where you left off.'); }
      busy = false;
    };
    if (drawn) sketchPanel(d, 'st', (sk) => { const o = spec.opts.find((x) => x.key === sk.key); if (o) choose(o, {}); else toast(SKETCH_FAULT.onside); });
    if (!$('drawGo')) keys.classList.add('snapbar');          // (the choices are the snap: at the sheet's foot)
    spec.opts.forEach((o, i) => {
      const b = key(o.label, o.sub || null, spec.opts.length > 2 || spec.opts.some((x) => x.label.length > 10) ? 'big def' : 'big', i);
      b.addEventListener('click', () => choose(o, null));
      keys.append(b);
    });
    d.append(keys);
    if ((kind === 'fgdef' || kind === 'puntdef') && defTimeoutNone(r)) noTimeouts(d);
  }

  // ------------------------------------------------------- after the snap ---
  // why the better call was better, in one line: what it does for you in this kind of decision, and how often NFL
  // play-callers make it here (the grade itself is the simulation's: thousands of games from this spot each way). The
  // score and the clock pick the words (x.ctx; a call graded before it was kept: the plain words): "Behind with the
  // clock running" after a kneel with the lead read as a bug
  function whyLine(x) {
    if (!x || x.cost < 0.0005 || x.best === x.chosen) return '';
    const b = x.best, c = x.chosen, nfl = Math.round(((x.q && x.q[b]) || 0) * 100);
    // (a call graded before ctx was kept: the old words, which took ahead for a kneel or a milk and behind otherwise)
    const k = x.ctx, lead = k ? k.lead : null, left = k ? k.left : 0, h1 = !!k && !k.h2;
    const up = !k || lead > 0, mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    let why = '';
    if (x.kind === 'clock') {          // (always with the clock running)
      why = { timeout: 'Stopping the clock now keeps the seconds you need for more snaps.',
        spike: 'A spike stops the clock and saves your timeout for when you need it more.',
        kneel: up ? 'Ahead with the ball: a kneel runs the clock with no chance of a turnover.' : 'A kneel ends the half with no chance of a turnover.',
        rundown: 'In range: run it down to 0:03, then kick. They never get the ball back.',
        milk: up ? 'Ahead: every second you take off the clock is one they don\u2019t get.' : 'Take your time: the less clock they get back after your drive, the better.',
        nohuddle: k && c === 'kneel' ? `${mmss} is ${h1 ? 'time to score before the half' : 'too long to kneel out'}: keep playing, and the no-huddle gets the next snap off sooner.`
          : k && lead > 0 ? (h1 ? 'Ahead, with time to add points before the half: the no-huddle gets the next snap off sooner.' : 'Snap it sooner: more points put the game away.')
          : `${k && lead === 0 ? 'Tied' : 'Behind'} with the clock running: the no-huddle gets the next snap off sooner.`,
        huddle: k && lead > 0 && !h1 ? 'Ahead: the huddle runs clock they won\u2019t get back.' : 'No need to rush here: the huddle uses clock you can afford.' }[b] || '';
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
      else if (kick(BL)) why = `Take the points: the kick is a good bet from here${!k || left <= 300 ? ', and the clock is short' : ''}.`;
      else if (punt(BL)) why = 'Punt it: pinning them deep is worth more than the chance of converting here.';
      else if (dn === 4 && (punt(CL) || kick(CL))) why = `Go for it: with ${sec < 180 ? 'this little time' : 'this much at stake'}, keeping the ball is worth the risk.`;
      else if (pass(BL) && run(CL) && sec < 150 && !(k && lead > 0)) why = 'With the clock running down, a pass can stop the clock and gain more than a run.';
      else if (run(BL) && pass(CL)) why = sec < 150 && k && lead > 0 ? 'Ahead late: a run keeps the clock moving, with fewer ways to lose the ball.'
        : sec < 150 ? 'A run keeps it simple: fewer ways to lose the ball, and the yards come.' : 'A run fits this down and distance better than a throw.';
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
  // a state's win chance, kept: one card's "after" is the next card's "before", the same number (players saw the
  // two differ by a point: the before was the value of the call made, not of where the drive stood)
  const WC = new Map();
  const wcKey = (r, done) => [G.si, r.t, r.yl, r.down, r.ytg, r.pos, r.score, r.to, r.phase, r.clock_running, !!done].join('|');
  async function winChanceAfter(root, done) {
    const k = wcKey(root, done);
    if (WC.has(k)) return WC.get(k);
    const r = done && root.t >= 1800 ? { ...root, t: 1800.01 } : root;
    const v = await evaluate(r, [{ key: 'now', action: {} }], hash('after', seedKey(), G.si, G.seq));
    if (WC.size > 400) WC.clear();
    WC.set(k, v.now);
    return v.now;
  }
  // the matchup behind a snap (engine.js MATCH): your call against their look, or their call against your defense
  const LOOK_NAME = ['the light box (six or fewer up front)', 'the blitz', 'the loaded box', 'the blitz'];
  // a light box with nobody blitzing, against a pass: what it means is seven in coverage
  const lookName = (b, kind) => (b === 0 && kind === 'pass' ? 'seven in coverage (no blitz, a light box)' : LOOK_NAME[b]);
  const DEF_NAME = { blitz: 'blitz', load: 'loaded box', soft: 'coverage' };
  // a call's name inside a sentence: lower case, but RPO, QB, RB and the Hail Mary keep their capitals
  const callLower = (l) => (/^([A-Z]{2,}\b|Hail Mary)/.test(l) ? l : l[0].toLowerCase() + l.slice(1));
  function matchupLine(e, action) {
    if (e && e.dc) return defenseLine(e, e.team !== G.me);
    if (!e || e.ev !== 'play' || !e.match || Math.abs(e.match) < 0.5 || e.call < 0 || !idx.calls[e.call]) return null;
    const call = e.team === G.me && action && action.route && action.targetName && !action.open
      ? `${routeSay(action.targetPos, action.route)} to ${shortName(action.targetName) || action.targetPos}` : callLower(idx.calls[e.call].label);
    // how it went for the offense: a big play, or nothing (no gain, an incompletion, a turnover)
    const big = !e.turnover && (e.td || e.yards >= 10), none = e.turnover || e.incomplete || e.yards <= 0;
    if (e.team === G.me) {
      const b = action && action.looks ? Math.round(Math.log2(action.looks)) : -1;
      if (!(b >= 0 && b < 4)) return null;
      const look = lookName(b, idx.calls[e.call].kind), Look = `${look[0].toUpperCase()}${look.slice(1)}`;
      if (e.match > 0) return { good: true, text: none ? `Good read: ${call} against ${look}. It just didn't work this time.` : `Good read: ${call} against ${look}.` };
      return { good: false, text: big ? `${Look} was set up to stop ${call}, but you made the play anyway.` : `${Look} was set up to stop ${call}.` };
    }
    const d = action && DEF_NAME[action.def];
    if (!d) return null;
    if (e.match < 0) return { good: true, text: big ? `Your ${d} was the right call against ${call}, but they made the play anyway.` : `Your ${d} won the matchup: they ran ${call} into it.` };
    return { good: false, text: none ? `They checked into ${call} against your ${d}, and you still stopped it.` : `They checked into ${call} against your ${d}.` };
  }
  function showResult(decisions, res, head) {
    adsSoon(ADS_AFTER);
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
    txt.append(el('span', 'yd', head || headline(main, res.log)), el('span', 'pl', lines.length ? lines[0][0] : `You stop the clock with ${clockOf(G.root.t).text} left.`));
    const wc = el('span', 'wc');
    if (played) txt.append(wc);
    top.append(sq, txt);
    wrap.append(top);
    const mu = matchupLine(main, res.action);
    if (mu) wrap.append(el('div', `mline ${mu.good ? 'won' : 'lost'}`, mu.text));
    if (played) {
      const b0 = G.lastPlay && G.lastPlay.res === res && !G.lastPlay.before.try2 ? G.lastPlay.before : null;
      Promise.all([b0 ? winChanceAfter(b0) : decisions[decisions.length - 1].wp, winChanceAfter(res.root, res.done)]).then(([before, after]) => {
        const dw = after - before, om = outcomeMark(dw);
        const shown = Math.round(after * 100) - Math.round(before * 100);     // what the two percentages say
        sq.className = `sq swing ${om}`;
        sq.textContent = `${shown >= 0 ? '+' : '−'}${Math.abs(shown)}`;
        sq.setAttribute('aria-label', `Your win chance ${shown >= 0 ? 'up' : 'down'} ${Math.abs(shown)} point${Math.abs(shown) === 1 ? '' : 's'}`);
        wc.textContent = `Win chance ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`;
        fitDock(fitKeys);          // (the line it adds, on top of the next call already shown)
        sayResult(`Win chance ${Math.round(before * 100)} to ${Math.round(after * 100)} percent`);
      }).catch(() => { sq.className = `sq ${m}`; sq.textContent = GLYPH[m]; sayResult(''); });
    }
    // the call, graded apart from how the play turned out: a small chip, and the better call when there was one
    const v = el('div', 'verdict');
    decisions.forEach((x, i) => {
      if (i) v.append(el('br'));
      const xm = markOf(x.cost);
      const chip = el('span', `chip-g sq ${xm}`, GLYPH[xm]);
      chip.setAttribute('aria-hidden', 'true');
      v.append(chip, document.createTextNode(decisions.length > 1 ? `${KIND_NAME[x.kind]}: ` : 'Your call: '));
      // (a gap inside the simulation's noise costs nothing: as good as any, with the raw gap shown)
      const gap = x.gap ?? x.cost;
      if (gap < 0.0005 || x.best === x.chosen) v.append(el('b', '', 'the best one.'));
      else if (xm === 'g') v.append(el('b', '', 'as good as any'), document.createTextNode(` (${x.bestLabel} ${pts(gap)}%${x.cost < gap && gap >= COST_MIN ? ', inside the simulation’s margin' : ''}).`));
      else v.append(document.createTextNode(`${GRADE_WORD[xm]}; `), el('b', '', x.bestLabel), document.createTextNode(` was better (${pts(x.cost)}% win chance).`));
      if (xm !== 'g' && whyLine(x)) v.append(el('span', 'why', ` ${whyLine(x)}`));
    });
    wrap.append(v);
    crowdLine(v, decisions);            // (the day's players' share of this call here, when their counts come)
    // said once, with the win chance when it is in (the card itself stays on as the next call's banner)
    const sayResult = (wcs) => say([txt.querySelector('.yd').textContent, txt.querySelector('.pl').textContent, wcs,
      [...v.childNodes].filter((n) => !(n.classList && n.classList.contains('chip-g'))).map((n) => (n.nodeName === 'BR' ? ' ' : n.textContent)).join('')].filter(Boolean).join('. '));
    if (!played) sayResult('');
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
      again.addEventListener('click', () => replay());
      acts.append(again);
    }
    acts.append(det);
    wrap.append(acts);
    if (G.lastPlay && res.animated) { const h = hintOnce('replay', 'Missed it? ↻ Replay shows the play again.'); if (h) wrap.append(h); }
    // no extra tap: the result stays on top of your next call (or the final card); only when their plays come
    // next does it wait for "Next play" (advance)
    d.append(wrap);
    G.banner = wrap;
    advance();
  }
  function takeBanner(d) {
    adsSoon(ADS_WAIT);                 // (a call on screen: the ads' script once the game is up)
    stopNote(d);
    if (!G.banner) return;
    G.banner.classList.add('banner');
    // (a tip in it points at what the compact banner folds away, the Replay: it waits for a full result card)
    G.banner.querySelectorAll('.hintonce').forEach((h) => { h.remove(); save(`${STORE}:hint:${h.dataset.hint}`, false); });
    // (on a phone its reason is cut to two lines, and more of it folds when the keys need the room, game.html, fitDock:
    // a tap shows it all)
    const b = G.banner;
    b.addEventListener('click', () => b.classList.toggle('open'));
    d.append(G.banner);
    G.banner = null;
    const n = d.querySelector('.stopnote');
    if (n) d.append(n);         // after your last result: in the order it happened
  }
  // above your call, until the next snap: the other team's timeout (on a phone the play-by-play is out of sight), or a
  // snap with no time left that is still played, and why
  function stopNote(d) {
    const r = G.root;
    if (VS || !r || r.phase === DONE) return;
    let text = null, c = null;
    if (r.untimed && r.phase === SNAP) text = 'Untimed down: defensive penalty. A half cannot end on a defensive foul, so the offense gets one more snap at 0:00.';
    else if (r.phase === SNAP && r.timeout && r.timeout.team !== G.me) {
      c = code(r.timeout.team);
      text = `Timeout, ${teamName(c)} (${r.timeout.left} left). ${G.cot ? '' : `The clock is stopped at ${clockOf(r.t).text}.`}`;
    } else if (r.phase === SNAP && r.clock_running && r.pos === G.me && halfLeft(r.t) < 1) text = 'Under a second left with the clock running: only a timeout stops it before it runs out.';
    if (!text) return;
    const n = el('div', 'stopnote');
    if (c) { const sw = el('span', 'tsw'); sw.style.background = color(c); n.append(sw); }
    n.append(el('span', '', text));
    d.append(n);
    say(text, `stop${r.t}${text}`);
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
  // the nearest of a list of coaches (each with z per measure, scaled by C.spread) to your calls in decs, on the
  // measures given: per trait [sum of (you - play-callers), snaps, what you did, what play-callers would have done]
  function nearestCoach(C, list, keys, decs) {
    if (!C || !list || !list.length) return null;
    const acc = {};
    keys.forEach((k) => { acc[k] = [0, 0, 0, 0]; });
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
    list.forEach((c) => {
      let dist = 0;
      Object.keys(w).forEach((k) => { if (w[k]) dist += w[k] * (zu[k] - (c.z[k] || 0)) ** 2; });
      if (dist < bd) { bd = dist; best = c; }
    });
    // the reasons quote your own calls, against what play-callers do in the same spots, and only when the counts
    // show it (a "lean on the run" to someone who threw on most snaps read as wrong)
    const why = Object.keys(w).filter((k) => w[k] && Math.abs(zu[k]) >= 0.35 && Math.sign(zu[k]) === Math.sign(best.z[k] || 0))
      .sort((a, b) => w[b] * Math.abs(zu[b]) - w[a] * Math.abs(zu[a]))
      .map((k) => whyText(k, zu[k] > 0, acc[k])).filter(Boolean).slice(0, 2)
      .map((x, i) => (i ? x : x.replace('(most: ', '(most play-callers: ')));     // (the first names who "most" are)
    return { coach: best, why };
  }
  function coachMatch(decs) {
    const C = idx.coaches;
    return C ? nearestCoach(C, C.coaches, ['pass', 'deep', 'go', 'two'], decs) : null;
  }
  // the play-caller you called it like (coaches.py play_caller_fingerprints: who really called the plays, by team and
  // week): side 'oc' on your offensive calls, 'dc' on the full defense you called (blitz, box, deep zone)
  function callerMatch(decs, side) {
    const C = idx.coaches && idx.coaches[side];
    if (!C) return null;
    const mine = side === 'dc' ? decs.filter((x) => x.kind === 'defcall' && x.dc && x.nfl) : decs;
    return nearestCoach(C, C.callers, C.measures || [], mine);
  }
  function whyText(k, more, [, n, mine, theirs]) {
    const a = Math.round(mine), e = Math.round(theirs), na = n - a, ne = n - e;
    if (more ? a <= e : a >= e) return null;               // rounded, the counts don't show it: say nothing
    const of = (x, what) => `${x} of ${n} ${what}`;
    return {
      pass: more ? `threw on ${of(a, 'plays')} (most: ${e})` : `ran on ${of(na, 'plays')} (most: ${ne})`,
      deep: more ? `went deep on ${of(a, 'throws')} (most: ${e})` : `kept it short on ${of(na, 'throws')} (most: ${ne})`,
      go: more ? `went for it on ${of(a, 'fourth downs')} (most: ${e})` : `kicked on ${of(na, 'fourth downs')} (most: ${ne})`,
      two: more ? `went for two ${a} of ${n} times (most: ${e})` : `kicked the extra point ${na} of ${n} times (most: ${ne})`,
      blitz: more ? `sent five or more on ${of(a, 'snaps')} (most: ${e})` : `rushed four or fewer on ${of(na, 'snaps')} (most: ${ne})`,
      load: more ? `loaded the box on ${of(a, 'snaps')} (most: ${e})` : `kept the box light on ${of(na, 'snaps')} (most: ${ne})`,
      soft: more ? `sat back in a deep zone on ${of(a, 'snaps')} (most: ${e})` : `played man on ${of(na, 'snaps')} (most: ${ne})`,
    }[k];
  }
  // where and when a play-caller called them, by the city of the time: "Kansas City 2013–2026", his last two stints
  const stintText = (st) => (st || []).slice(-2).map(([t, a, b]) => `${cityIn(t, a)} ${a === b ? a : `${a}–${b}`}`).join(', ');
  function callerLine(m, label) {
    const c = m.coach, row = el('div', 'caller');
    row.append(el('div', 'k', label), el('div', 'cname', c.name));
    if (m.why.length) row.append(el('div', 'why', `Like him, you ${m.why.join(', and ')}.`));
    row.append(el('div', 'meta', `${stintText(c.stints)} · from ${c.plays.toLocaleString()} late-game snaps he called`));
    return row;
  }
  function coachCard(decs, label) {
    const m = coachMatch(decs), oc = callerMatch(decs, 'oc'), dc = callerMatch(decs, 'dc');
    if (!m && !oc && !dc) return null;
    const box = el('div', 'coach');
    if (m) {
      const c = m.coach;
      box.append(el('div', 'k', label), el('div', 'name', c.name));
      const reason = m.why.length ? `Like him, you ${m.why.join(', and ')}.` : 'Your calls sit close to his across the board.';
      box.append(el('div', 'why', reason));
      const teams = (c.teams || []).map(teamName).join(', ');
      box.append(el('div', 'meta', `${teams} · ${c.from === c.to ? c.from : `${c.from}–${c.to}`} · from ${c.plays.toLocaleString()} late-game snaps`));
    }
    if (oc) box.append(callerLine(oc, 'Called it like'));
    if (dc) box.append(callerLine(dc, 'Defended like'));
    box.title = 'Matched on how often you throw, go deep, go for it on fourth down and go for two (and on defense how often you ' +
      'blitz, load the box and sit back in a deep zone), each against what NFL play-callers do in the same spots. The ' +
      'play-callers are the coaches who really called the plays, team by team and week by week.';
    return { el: box, name: m ? m.coach.name : null, oc: oc ? oc.coach.name : null, dc: dc ? dc.coach.name : null };
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

  let onRank = null;

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
      if (x.k === 'pick') addLog(`${tn(x.team)} chooses ${x.choice}${x.auto ? ' (out of time)' : ''}: ${tn(x.first)} ball first`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'end') addLog(`${tn(x.team)} takes the end of the field: ${tn(1 - x.team)} chooses offense or defense`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'timeout') addLog(`Timeout, ${tn(x.team)}`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'two') addLog('Going for two', VSCore.COT_T, mine(x.team));
      else if (x.k === 'must2') addLog('Second overtime on: a touchdown has to go for two', VSCore.COT_T, mine(x.team));
      else if (x.k === 'poss') addLog(`${tn(x.team)} ball${x.round >= 3 ? ': a two-point play' : ' at the 25'}`, VSCore.COT_T, mine(x.team));
      else if (x.k === 'round') addLog(`${ordinal(x.round)} overtime, tied ${x.score[G.me]}–${x.score[1 - G.me]}${x.round === 2 ? ': a touchdown has to go for two' : x.round >= 3 ? ': a two-point play each' : ''}. ${tn(x.chooser)} chooses`, VSCore.COT_T, mine(x.chooser));
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
    addLog(`Tied ${r.score[G.me]}–${r.score[1 - G.me]}: college overtime. ${toss === G.me ? 'You won the coin toss' : `${them} won the coin toss`}`, VSCore.COT_T, true);
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
    say(`${txt.firstChild.textContent}. ${lines.length ? lines[0][0] : ''}`);          // (said once: showResult)
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
    status(`${teamName(code(r.pos))} lines up for the try`, G.log.length ? G.log[G.log.length - 1][0] : '', !G.fast);
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
    // a historic drive's overtime is its time's (pro.py overtime_rules); the daily game's, today's
    const OT = G.scen.overtime || {}, rules = OT.rules === 'sd' || OT.rules === 'msd' ? OT.rules : null, len = OT.len || (po ? 900 : 600);
    const how = rules === 'sd' ? `Sudden death (the rules of ${G.scen.real.season}): the first score wins.`
      : rules === 'msd' ? `The rules of ${G.scen.real.season}: a touchdown on the first possession wins it; a field goal gives the other team the ball. Then the next score wins.`
        : 'Both teams get the ball, then the next score wins.';
    drawAll();
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', `Tied ${r.score[G.me]}–${r.score[1 - G.me]}: overtime`),
      el('span', 'sub', `${len / 60} minutes, ${po ? 3 : 2} timeouts each. ${how}${
        po ? ' Playoffs: it goes on until someone wins.' : ' Still tied after that, it’s a tie: you stay alive, without a win.'}`));
    d.append(head);
    d.append(el('p', 'note toss', won ? 'You won the coin toss.' : `${them} won the coin toss and will receive.`));
    const start = (kicker) => {
      if (busy) return;
      G.root = { t: len, pos: kicker, score: [r.score[0], r.score[1]], down: 1, ytg: 10, yl: 65, to: po ? [3, 3] : [2, 2],
        clock_running: false, phase: KICKOFF, credit: 0, free_kick: false, ot: { c: [0, 0], po, n: 1, ...(rules ? { r: rules } : {}) } };
      G.over = false; G.result = null;
      addLog(kicker === G.me ? `Overtime: you kick off to ${them}` : `Overtime: ${them} kicks off to you`, G.root.t, true);
      persist();
      advance();
    };
    const keys = el('div', 'keys');
    const opts = won ? [['Receive', 'Get the ball first', 1 - G.me], ['Kick off', rules === 'sd' ? 'Defend first' : 'Know what you need', G.me]] : [['Kick off', null, G.me]];
    keys.style.setProperty('--cols', opts.length);
    opts.forEach(([label, sub, kicker], i) => {
      const b = key(label, sub, 'big', i);
      b.addEventListener('click', () => start(kicker));
      keys.append(b);
    });
    d.append(keys);
  }

  // a scenario from the first half played to the final gun (web/scenario.js end: 'game'): at halftime the second half
  // kicks off to the team the scenario gave it to, three timeouts each (the first half's calls were graded on the
  // half, as every first-half spot's are)
  const halfToPlay = (r) => !!(G.scen.custom && G.scen.end === 'game' && r.phase === DONE && r.t >= 1800 && !r.ot);
  function secondHalf() {
    const r = G.root, d = $('dock'), recv = G.scen.start.receive2h === G.scen.home ? 0 : 1;
    drawAll();
    d.textContent = '';
    takeBanner(d);
    const head = el('div', 'ask');
    head.append(el('h2', '', `Halftime: ${r.score[G.me]}\u2060–\u2060${r.score[1 - G.me]}`),
      el('span', 'sub', `${recv === G.me ? 'You get' : `${teamName(code(recv))} gets`} the ball to start the second half. Three timeouts each.`));
    const b = key(recv === G.me ? 'Receive the kickoff' : 'Kick off', null, 'big', 0), keys = el('div', 'keys');
    keys.style.setProperty('--cols', 1);
    b.addEventListener('click', () => {
      if (busy) return;
      // (a hair under 30:00 left: the engine plays the second half from it, and the clock reads 15:00 of the third)
      G.root = { t: 1800 - 1e-6, pos: 1 - recv, score: [r.score[0], r.score[1]], down: 1, ytg: 10, yl: 65, to: [3, 3], clock_running: false,
        phase: KICKOFF, credit: 0, free_kick: false };
      addLog(recv === G.me ? `The second half: ${teamName(code(1 - recv))} kicks off to you` : `The second half: you kick off to ${teamName(code(recv))}`, G.root.t, true);
      persist();
      advance();
    });
    keys.append(b);
    d.append(head, keys);
  }
  async function finishSpot() {
    if (VS) return vsEndCard();
    if (!G.result && halfToPlay(G.root)) return secondHalf();
    if (!G.result && needsOvertime(G.root)) return G.scen.college ? collegeOvertime() : overtime();
    await regradeWait();
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
    persChip();                  // (the personnel chip off the field over the final card)
    const res = G.result, sc = G.scen, d = $('dock');
    // (res.ot: a result from before overtime was played, settled with the win chance)
    const inOT = !!G.root.ot || cotDaily(), tie = res.mine === res.theirs;
    let newBadge = false;
    if (SURV && res.ot == null && !res.counted) {   // survivor: a win counts, a loss ends the run, a tie after overtime neither
      res.counted = true;
      const w = res.mine > res.theirs;
      state.games.push({ id: sc.id, tag: gameTag(sc), me: sc.player, op: sc.player === sc.home ? sc.away : sc.home,
        mine: res.mine, theirs: res.theirs, ot: inOT, w, tie });
      if (w) state.won += 1; else if (!tie) state.out = true;
      tendFold(G.decisions, `s${state.run}:${G.si}`);
      const ev = [{ sc, r: res, decs: G.decisions, hh: headToHead(G.si, res) }], stt = load(`${STORE}:stats`, { days: {} });
      achCount(ev);
      res.badges = badgeAward(stt, ev);
      if (res.badges.length) { save(`${STORE}:stats`, stt); statsSync(true); newBadge = true; }
      liveDrive.on = false;
      tally('survivor');
    track('survivor_game', { result: w ? 'win' : tie ? 'tie' : 'loss', overtime: inOT, streak: state.won });
      persist();
    }
    if (RUN_N && res.half !== 1 && !res.tallied) { res.tallied = true; persist(); tally('run'); }   // (each game of a run, once: a reload draws the card again)
    d.textContent = '';
    takeBanner(d);
    const card = el('div', 'endcard');
    const ot = inOT ? ' in overtime' : '';
    const head = res.half === 1 ? `Halftime: ${res.mine}–${res.theirs}` :
      res.mine > res.theirs ? `You win ${res.mine}–${res.theirs}${ot}` : res.mine < res.theirs ? `You lose ${res.mine}–${res.theirs}${ot}` :
      inOT ? `Tie ${res.mine}–${res.theirs} after overtime` :
      SURV && res.ot ? `Tied ${res.mine}–${res.theirs}: you ${res.ot > 0 ? 'win' : 'lose'} in overtime` : `Tied ${res.mine}–${res.theirs}: overtime`;
    if (playTitle(sc)) card.append(el('div', 'kick', playTitle(sc)));      // a featured day's title over the result
    card.append(el('h2', '', head.replace(/(\d)–(\d)/g, '$1\u2060–\u2060$2')));      // (the score never splits at its dash)
    say(head, `end${G.si}${head}`);
    if (SURV && res.ot) card.append(el('p', 'note', `Your overtime win chance was ${wpTxt(res.wp)}.`));
    else if (inOT && tie) card.append(el('p', 'note', 'Nobody won it. A tie keeps your run alive, but it doesn’t count as a win.'));
    else if (res.half === 1 || (tie && !inOT)) card.append(el('p', 'note', `Your win chance from here: ${wpTxt(res.wp)}.`));
    if (SURV) card.append(el('p', `alive ${state.out ? 'out' : 'in'}`, state.out ? `Eliminated after ${state.won} win${state.won === 1 ? '' : 's'}.` :
      inOT && tie ? `Still alive: ${state.won} win${state.won === 1 ? '' : 's'}.` : `${state.won} straight. You're still alive.`));
    // a playoff run, like a real one, ends with a loss: the games after it are not played (the run can be played again)
    const runOut = !!RUN_N && res.half !== 1 && res.mine < res.theirs && G.si < today.length - 1;
    if (runOut) {
      const rg = PRO_RUNS.runs[RUN_N - 1].games[G.si];
      card.append(el('p', 'alive out', `Season over: ${teamName(sc.player)} is out in ${roundIn(rg.round)}.`));
    }
    card.append(squaresOf(G.decisions));
    const bc = SURV && badgeCard(res.badges || []);
    if (bc) card.append(bc);
    const hh = headToHead(G.si, res);
    if (hh) card.append(hhCard(hh));
    const rl = sc.real || {};
    // (the first call is known only where the snap was charted: most historic drives have none, and say how it ended)
    const realCall = rl.call && CALL[rl.call] ? CALL[rl.call].label : null;
    const lead0 = sc.start.score[sc.player === sc.home ? 1 : 0] - sc.start.score[sc.player === sc.home ? 0 : 1];
    const drive = !rl.drive ? '' : rl.drive === 'ran out the clock' ? (lead0 > 0 ? 'they ran out the clock' : 'time ran out on them') : `the drive ended in a ${rl.drive}`;
    const realLine = realCall ? `${rl.coach || 'the coach'} called "${realCall}" here${drive ? `; ${drive}` : ''}` : drive ? `with ${rl.coach || 'their coach'} calling it, ${drive}` : '';
    if (sc.custom) card.append(el('p', 'real', `Your scenario: ${matchLine(sc)}, ${typeSay(rl.type)}.`));
    else card.append(el('p', 'real', rl.live ? `Straight from ${rl.date ? new Date(rl.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'this week'} (${gameTag(sc)}): see how ${rl.coach || 'the coach'} actually called it.`
      : rl.summary ? `In the real game (${gameTag(sc)}): ${rl.summary}.` : realLine ? `In the real game (${gameTag(sc)}), ${realLine}.` : `From the real game (${gameTag(sc)}).`));
    const cc = coachCard(G.decisions, 'You called this one like');
    if (cc) card.append(cc.el);
    card.append(el('p', 'verdict', callsLine(G.decisions)));
    const btn = el('button', 'btn', SURV ? (state.out ? 'Your run' : 'Next game') : PRACTICE ? 'Your score' : runOut ? 'Your run' : G.si < today.length - 1 ? (RUN_N ? 'Next game' : 'Next spot')
      : DRIVE || CUSTOM ? 'Your grade' : RUN_N ? 'Your run' : ARCH_DAY ? 'Your score' : "Today's score");
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
      if (runOut) { state.out = G.si; saveState(); return renderSummary(); }
      state.current = G.si + 1;
      saveState();
      if (G.si < today.length - 1) openSpot(G.si + 1);
      else renderSummary();
    });
    card.append(btn);
    // survivor: an ad after each finished game, below the button (never between the player and it)
    if (SURV) { const ad = adBox('surv'); if (ad) card.append(ad); }
    d.append(card);
    drawTiles();
    if (newBadge) badgeToast(res.badges, bc);
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
    // (v, what the record counts, is the result: won, lost or tied. Both won or both lost by different margins is the
    // same result but not the same game, and the line says so: "Both lost: you by 7, Taylor by 1", never "Same as")
    const mm = result.mine - result.theirs, hmm = hm - ht, v = Math.sign(Math.sign(mm) - Math.sign(hmm));
    const both = v || mm === hmm ? null : `Both ${mm > 0 ? 'won' : 'lost'}: you by ${Math.abs(mm)}, ${who} by ${Math.abs(hmm)}`;
    return { coach: rl.coach, who, v, both, like: both ? `${mm > 0 ? 'Won' : 'Lost'}, as ${rl.coach} did` : null,
      you: `${wl(result.mine, result.theirs)} ${result.mine}–${result.theirs}${G.root && G.root.ot ? ' (OT)' : ''}`, him: `${wl(hm, ht)} ${hm}–${ht}` };
  }
  function hhCard(h) {
    const box = el('div', `h2h ${h.v > 0 ? 'beat' : h.v < 0 ? 'lost' : 'tie'}`);
    box.append(el('div', 'k', `You vs ${h.coach}`), el('div', `res${h.both ? ' both' : ''}`, h.v > 0 ? `You beat ${h.who}` : h.v < 0 ? `${h.who} did better` : h.both || `Same as ${h.who}`));
    const row = el('div', 'rows');
    [['You', h.you], [h.who, h.him]].forEach(([a, b]) => { const r = el('div', 'r'); r.append(el('span', 'a', a), el('span', 'b', b)); row.append(r); });
    box.append(row);
    return box;
  }
  // a drive's snaps (a snap's calls together: the tempo and the play, say), each with its mark, how it did against a
  // typical NFL play-caller (wpa) and whether anything was at stake: a typical caller gives up at least MATTERS of
  // win chance there (down 25 in the third quarter, nothing anyone calls moves it). A day graded before g: 2 counts
  // every snap as one that mattered (its typical was a win chance, not a cost)
  const MATTERS = 0.005;
  function snapStats(decs) {
    const by = new Map();
    decs.forEach((x) => {
      const k = x.snap ?? by.size, s = by.get(k) || { cost: 0, wpa: 0, stake: 0, old: false };
      s.cost += x.cost; s.wpa += x.wpa || 0;
      if (x.g === 2) s.stake += x.typical || 0; else s.old = true;
      by.set(k, s);
    });
    return [...by.values()].map((s) => ({ m: markOf(s.cost), cost: s.cost, wpa: s.wpa, matters: s.old || s.stake >= MATTERS }));
  }
  const snapsOf = (decs) => snapStats(decs).map((s) => s.m);
  // a spot's snaps in at most SHARE_SQ squares for sharing (one a snap, as the end card shows them): longer drives are
  // grouped, each group graded by its average, and the share says how many snaps they stand for
  const SHARE_SQ = 12;
  function squeeze(decs) {
    const c = snapStats(decs).map((s) => s.cost);
    if (c.length <= SHARE_SQ) return c.map(markOf);
    return Array.from({ length: SHARE_SQ }, (_, j) => {
      const g = c.slice(Math.floor((j * c.length) / SHARE_SQ), Math.floor(((j + 1) * c.length) / SHARE_SQ));
      return markOf(g.reduce((a, x) => a + x, 0) / g.length);
    });
  }
  const squeezeNote = (decs) => { const n = snapStats(decs).length; return n > SHARE_SQ ? ` (${n} snaps)` : ''; };
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
  // (the kept session, as myName goes by: not signedIn(), which waits on /auth/me. A post made before that answers, or
  // when it never does, was the username without the session: the board called the player's own name taken)
  const withSession = () => (authSession() ? { session: authSession() } : {});
  const slugOf = (name) => `p-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'player'}`;
  const redrawBoards = () => document.querySelectorAll('.board').forEach(fillBoard);
  // posts go as text/plain, a "simple" cross-origin request: no OPTIONS preflight, half the backend requests (the
  // backend reads the body as JSON whatever its type)
  const POST_JSON = (body) => ({ method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
  // a finished Survivor game, historic drive, run game or scenario: one count for the stats page's all-time total
  // (worker.js /tally: the kind only); the caller's own flag on the saved state makes it once a game, fire and forget
  const tally = (kind) => { (BOARD.ready || Promise.resolve()).then(() => { if (BOARD.mode === 'api') return fetch(`${BOARD.api}/tally`, POST_JSON({ kind })); }).catch(() => {}); };
  async function apiBoard(method, body) {
    const r = await fetch(`${BOARD.api}/board`, method === 'POST' ? POST_JSON(body) : {});
    if (r.status === 409) return { taken: true, ...(await r.json()) };
    if (!r.ok) throw new Error(`board ${r.status}`);
    return r.json();
  }
  async function apiRefresh() {
    try { const r = await apiBoard('GET'); BOARD.rows = r.rows || []; BOARD.week = r.week || null; redrawBoards(); } catch (e) { /* keep what we have */ }
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
  // (run: the run just ended, for the week's board; a name's best run of the week goes there)
  async function boardPost(name, best, life, run) {
    name = String(name || '').trim().slice(0, 24);
    best = Math.round(Number(best));
    if (!BOARD.mode || !BOARD.canWrite || !name || !(best >= 0 && best < 1000)) return false;
    if (BOARD.mode === 'api') {
      try {
        const res = await apiBoard('POST', { name, best, key: deviceKey(), ...(life ? { life: true } : {}), ...(Number.isInteger(run) && run >= 0 && run <= best ? { run } : {}), ...withSession() });
        BOARD.rows = res.rows || BOARD.rows;
        if (res.week) BOARD.week = res.week;
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
    // this week's board first (Monday to Sunday, a new one every Monday), then the best runs of all time
    const wk = BOARD.mode === 'api' && BOARD.week;
    if (wk) {
      const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
      b.append(el('div', 'k', `This week · ${day(wk.from)} to ${day(wk.to)}`));
      if (!wk.rows.length) b.append(el('p', 'note', 'No runs this week yet. The first one tops the board.'));
      else {
        const ol = el('ol', 'brows'), me = myName().toLowerCase();
        wk.rows.slice(0, 10).forEach((r, i) => {
          const li = el('li', String(r.name).toLowerCase() === me ? 'me' : '');
          li.append(el('span', 'n', String(i + 1)), el('span', 'nm', `${String(r.name)}${r.life ? ' ❤️' : ''}`), el('b', '', String(r.best)));
          ol.append(li);
        });
        b.append(ol);
      }
    }
    b.append(el('div', 'k', wk ? 'All time' : 'Survivor leaderboard'));
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
  const featuredSpots = () => new Set(Object.values(idx.featured || {}).flatMap((f) => (f.sides || [f]).map((x) => x.spot)));   // a day's story (both sides), not survivor's
  const survPool = () => { const f = featuredSpots(); return idx.spots.map((sp, i) => (sp.start.qtr >= 4 && !f.has(i) ? i : -1)).filter((i) => i >= 0); };
  function newRun() {
    return { run: Math.floor(Math.random() * 2 ** 31), spots: [], current: 0, pick: null, won: 0, games: [], played: [], out: false };
  }
  function survStats() { return load(`${STORE}:survstats`, { runs: 0, best: 0, last: null }); }
  function survLabel() {
    const b = Math.max(survStats().best, state.won);
    return `Survivor · ${state.won} win${state.won === 1 ? '' : 's'}${b ? ` · best ${b}` : ''}`;
  }
  // the website also has each spot in a file of its own (site.py, <meta name="spot1">): the day's drive downloads its
  // one spot, not the 20 of its chunk; elsewhere (the claude.ai artifact, a local copy) the chunks
  const SPOT1 = !!document.querySelector('meta[name="spot1"]');
  async function loadTeams(ids) {
    const per = idx.spot_chunk || 20, teams = {};
    const files = SPOT1 ? [...new Set(ids)].map((i) => `p${i}`) : [...new Set(ids.map((i) => Math.floor(i / per)))].map((k) => `s${k}`);
    await Promise.all(files.map((f) => fetch(asset(`spots/${f}.json`))
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
    const st = survStats(), was = JSON.stringify(st);
    // (a run that took its extra life comes back here when it ends again: its wins count then too)
    if (st.last !== state.run) { st.runs += 1; st.last = state.run; }
    if (state.won > st.best || (state.won === st.best && st.bestLife && !state.life)) st.bestLife = !!state.life;
    st.best = Math.max(st.best, state.won);
    save(`${STORE}:survstats`, st);
    if (JSON.stringify(st) !== was) statsSync(true);          // signed in: the best run follows the account (another phone sees it)
    // the board keeps your best (when you can write it and have a name on it), marked when it used the extra life
    if (BOARD.ready && myName()) BOARD.ready.then(() => boardPost(myName(), st.best, !!st.bestLife, state.won));
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
    box.append(...lifeOffer(), nameInput(), pre, share, again, homeBtn(), boardEl());
    const ad = adBox('survend');
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
  // a percentile shows 1 to 99: a 0 beside a win read as broken, a 100 beside a loss as perfect
  const pctShown = (p) => clip(p, 0.01, 0.99);
  const resultScored = () => !!(DRIVE || RUN_N || CUSTOM || PRACTICE || dayN >= RESULT_FROM || allDecisions().every((x) => x.g === 2));
  // The score (decisions graded as g: 2, decisionFrom): the share of simulated NFL play-callers who did worse than you
  // on the same drive, the calls and the result, as above (RESULT_W a win). Every one of them is measured with your
  // numbers: the costs decisionFrom gave each option (noise counted as nothing), so a call costs a simulated caller
  // exactly what it would have cost you. They call like the league (NFL frequencies q), each reading the spot with
  // his own skill, from a misread to a sharp read, and as many read it worse than the league's habits as better: a
  // skill s from -1 to 1, an option's weight q x e^(-s.c/tau) for its cost c, tau from SKILL_LOOSE at s = 0 (the
  // league's own mix) to SKILL_SHARP at 1 (the best call nearly always) and SKILL_MISREAD at -1 (leaning to the
  // costly calls). So the league's own mix scores about 50, better calls more, worse less: replayed on real daily spots
  // (web/score_sweep.js) the medians are random calls 11, the league's mix 46, a sharp read 79 and a greedy one 90
  // (before, against callers who all read at least as well as the league: 3, 26, 72 and 80). On a spot where nothing
  // anyone calls changes the win chance every call costs nothing for anyone, and the result decides.
  const SKILL_SHARP = 0.003, SKILL_LOOSE = 0.3, SKILL_MISREAD = 0.03;
  function scoreVsNFL(decs) {
    if (decs.some((x) => x.g !== 2)) return scoreVsNFLv1(decs);
    let groups = spotGroups();
    if (!groups.length) groups = [{ decs, res: 0, start: decs[0].bestWp }];
    const my = groups.reduce((a, g) => a + RESULT_W * g.res - g.decs.reduce((b, x) => b + x.cost, 0), 0);
    const R = rng(hash('pct3', dayN, DRIVE, RUN_N, ...(CUSTOM ? [CUSTOM] : []))), N = 6000;
    const lnL = Math.log(SKILL_LOOSE), lnS = Math.log(SKILL_SHARP) - lnL, lnM = Math.log(SKILL_MISREAD) - lnL;
    const D = groups.map((g) => g.decs.map((x) => ({ q: x.wps.map((o) => x.q[o.key] || 0), c: x.wps.map((o) => o.c), top: Math.max(...x.wps.map((o) => o.c)) })));
    let better = 0;
    for (let s = 0; s < N; s++) {
      const sk = 2 * R() - 1, inv = sk >= 0 ? -1 / Math.exp(lnL + sk * lnS) : 1 / Math.exp(lnL - sk * lnM);
      let m = 0;
      groups.forEach((g, gi) => {
        let tot = 0;
        for (const x of D[gi]) {
          // (weights relative to the costliest option's: a misread's e^(c/tau) stays finite)
          let t = 0;
          const w = x.q.map((q, j) => { const v = q * Math.exp(inv * (x.c[j] - (inv > 0 ? x.top : 0))); t += v; return v; });
          let u = R() * t, j = 0;
          for (; j < w.length - 1; j++) { u -= w[j]; if (u <= 0) break; }
          tot += x.c[j];
        }
        const win = R() < clip(g.start - tot, 0.002, 0.998) ? 1 : 0;
        m += RESULT_W * win - tot;
      });
      if (m < my - 1e-9) better += 1; else if (Math.abs(m - my) <= 1e-9) better += 0.5;
    }
    if (mustWin() && groups.some((g) => g.res < 1)) return pctShown(Math.min(better / N, (PASS_AT - 1) / 100));
    return pctShown(better / N);
  }
  // a historic drive is a mission, and so is a scenario played to the final gun: an A (a pass) takes winning the game
  const mustWin = () => !!DRIVE || (!!CUSTOM && !!today[0] && today[0].end !== 'half');
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
  // (the score of a day graded before g: 2, kept as it was recorded: scoreVsNFL)
  function scoreVsNFLv1(decs) {
    if (!resultScored()) return percentileVsNFL(decs);
    const groups = spotGroups();
    if (!groups.length) return percentileVsNFL(decs);
    const my = groups.reduce((a, g) => a + RESULT_W * g.res - g.decs.reduce((b, x) => b + x.cost, 0), 0);
    const R = rng(hash('pct2', dayN, DRIVE, RUN_N, ...(CUSTOM ? [CUSTOM] : []))), N = 6000;
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
    // a historic drive is a mission: an A (a pass) takes winning the game
    if (mustWin() && groups.some((g) => g.res < 1)) return pctShown(Math.min(better / N, (PASS_AT - 1) / 100));
    return pctShown(better / N);
  }
  // the score against the result, when they disagree (a win scored low, a loss high): one line on why
  function scoreWhy(p) {
    const rs = today.map((_, i) => state.spots[i] && state.spots[i].result).filter((r) => r && r.half !== 1);
    const w = rs.filter((r) => r.mine > r.theirs).length, l = rs.filter((r) => r.mine < r.theirs).length;
    // nothing at stake on most snaps (a deep hole, a game already won): the calls weigh little, the result decides
    const S = snapStats(allDecisions()), quiet = S.filter((x) => !x.matters).length;
    if (S.length >= 4 && quiet >= 0.75 * S.length) return quiet === S.length ? 'On every snap nothing you could call changed your win chance much: the result decides the score.'
      : `On ${quiet} of your ${S.length} snaps nothing you could call changed your win chance much: the score is the other ${S.length - quiet} and the result.`;
    if (w && !l && p < 0.4) return 'You won, but your calls gave up win chance: the bounces bailed you out.';
    if (l && !w && p >= 0.6) return 'You lost, but your calls were sound: the bounces went the other way.';
    return null;
  }
  // the calls in a line, snap by snap as the squares show them: how many were the best (or close), how many had
  // nothing at stake, and the average snap against a typical NFL play-caller's (their sum over a long drive read like
  // a score: "-46.5 points of win chance" beside a win)
  function callsLine(decs) {
    const S = snapStats(decs), n = S.length;
    if (!n) return '';
    const g = S.filter((s) => s.m === 'g').length, quiet = S.filter((s) => !s.matters).length, avg = S.reduce((a, s) => a + s.wpa, 0) / n;
    if (quiet === n) return `Your calls: nothing you could call on your ${n} snap${n === 1 ? '' : 's'} changed your win chance much, so none of them counted for or against you.`;
    return `Your calls: ${g} of ${n} snaps the best or close to it${quiet ? ` (on ${quiet} of them no call changed much)` : ''} · ${Math.abs(avg * 100).toFixed(1)} points of win chance a snap ${avg >= 0 ? 'better' : 'worse'} than a typical NFL play-caller’s.`;
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
    return pctShown(better / N);
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
    if (scoreWhy(p)) lines.push(scoreWhy(p));
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
  // ---- Start over: a drive gone wrong played again from its first snap, asked for on the field (the ☰ menu's last item
  // on a phone, the button under the field elsewhere; game.html), confirmed first, never while a play runs. Never in
  // survivor (one life is the game), practice or Versus. What it keeps fair:
  // - a Pro drive or playoff run: a fresh try (a new tryAt, so new draws: seedKey), and the try left counts for nothing
  //   (a drive's or run's record is written at its finish only; the best grade stays). A run starts at its first game.
  // - a past day (the archive, Pro): from the top, freely (it posts nowhere).
  // - today's daily: its draws are everyone's, so a restart could learn them and farm the day's list. It may restart,
  //   and the result counts for the player as any day does (the score, the stats day, the streak), but the day's state
  //   remembers it (restarts) and the /daily post says so (restarted): board/worker.js keeps it off the day's and the
  //   week's lists, the histogram and the averages.
  // The new try is saved before the page reloads into it (a reload after it goes on with it); the reload takes the
  // workers and any grading still running for the old try with it, and nothing saves the old one after (restarting).
  const RESTART_OK = !(SURV || PRACTICE || VS);
  const todayDaily = () => !(SURV || PRACTICE || VS || DRIVE || RUN_N || CUSTOM || ARCH_DAY);
  const sideTaken = () => !(SURV || PRACTICE || VS || DRIVE || RUN_N || CUSTOM) && !!idx && !!sidesOf(dayN) && today.length === 1;    // the day's drive is a side of two
  const canRestart = () => RESTART_OK && !restarting && !!G && !!state && !state.done && !G.over && !$('play').hidden;
  function restartSync() { const b = $('restartBtn'); if (b) b.hidden = !canRestart(); }
  const playRunning = () => busy || $('field').classList.contains('playing');
  function restartAsk() {
    if (!canRestart()) return;
    if (playRunning()) { toast('Wait for this play to finish'); return; }
    const what = DRIVE ? 'this drive' : RUN_N ? 'this run' : CUSTOM ? 'this scenario' : ARCH_DAY ? 'this day' : 'today’s drive';
    const note = DRIVE || CUSTOM ? 'This try won’t count. The new try gets fresh luck on every snap; your best grade here stays.'
      : RUN_N ? 'This try won’t count. The run starts again from its first game, with fresh luck on every snap.'
        : ARCH_DAY ? 'It starts again from the first snap. Archive days don’t go on any leaderboard.'
          : 'Your streak still counts, but a restarted drive’s score doesn’t go on today’s leaderboard.';
    const go = el('button', 'btn', 'Start over'), keep = el('button', 'btn ghostbtn', 'Keep playing');
    go.type = 'button'; keep.type = 'button';
    go.dataset.restartGo = '';
    go.addEventListener('click', () => {
      closeModal();
      if (!canRestart() || playRunning()) return;
      restartGo();
    });
    keep.addEventListener('click', closeModal);
    const row = el('div', 'row restartacts');
    row.append(go, keep);
    openModal(`Start ${what} over?`, [el('p', 'note', note), row]);
    track('restart_ask', { mode: modeName() });
  }
  function restartGo() {
    const n = (state.restarts || 0) + 1;
    track('restart', { mode: modeName(), calls: allDecisions().length, restarts: n, ...(DRIVE ? { drive: DRIVE } : RUN_N ? { run: RUN_N } : CUSTOM ? { custom: 1 } : { day: dayN }) });
    restarting = true;
    pool.forEach((sl) => { try { sl.w.terminate(); } catch (e) { /* gone already */ } });
    save(stateKey(), { spots: [], current: 0, done: false, tryAt: Date.now(), restarts: n, ...(state.side != null ? { side: state.side } : {}) });
    location.reload();
  }
  // a drive played again from the snap: its saved state cleared (its best grade stays)
  // "the Divisional round", "the Super Bowl": a playoff round in a sentence
  const roundIn = (r) => (/Championship|Super Bowl/.test(r) ? `the ${r}` : `the ${r} round`);
  function retryDrive() {
    try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ }
    track('drive_retry', { drive: DRIVE });
    location.reload();
  }
  function driveActions(rec) {
    const row = el('div', 'row pacts');
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
    if (PRACTICE) return renderPractice();
    if (!G) resumeSpot(RUN_N && state.out != null ? state.out : today.length - 1);
    show('done');
    const decs = allDecisions();
    const p = decs.length ? scoreVsNFL(decs) : 0;
    const wpa = decs.reduce((a, x) => a + x.wpa, 0);
    const st = load(`${STORE}:stats`, { days: {} });
    const cc = coachCard(decs, DRIVE || RUN_N ? 'You coached like' : 'Today you coached like');
    const hhs = today.map((_, i) => (state.spots[i] ? headToHead(i, state.spots[i].result) : null)), hhN = hhs.filter(Boolean);
    const runRec = RUN_N ? today.map((_, i) => { const r = state.spots[i] && state.spots[i].result; return !r ? 0 : r.mine > r.theirs ? 1 : r.mine < r.theirs ? -1 : 0; }) : [];
    let driveRec = null, drivePrev = null, scenRec = null, scenPrev = null;
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
    } else if (CUSTOM) {              // a scenario: My scenarios' record of it (the best try kept), nothing else
      scenPrev = scenList()[CUSTOM] || null;
      scenRec = scenFinish(p);
    } else {
      // (vs: against the real coach, so a badge for beating him counts the days on any phone)
      // (the card drawn again, on a reload: a record already here stays, which may be another phone's, synced in)
      if (!state.done || !st.days[dayN]) st.days[dayN] = { p, wpa, coach: cc ? cc.name : null, ...(hhN.length ? { vs: Math.sign(hhN.reduce((a, h) => a + h.v, 0)) } : {}),
        ...(sidesOf(dayN) ? { side: today[0].player } : {}) };          // (a day of two sides: the one taken)
      // a missed day the streak's freezes now cover (this day played after it): kept, told about on this card
      const fz = st.frozen || (st.frozen = {}), sk0 = streakOf(st, ARCH_DAY ? dayOf(new Date()) : dayN);
      const newly = [...sk0.frozen].filter((k) => !fz[k]);
      if (newly.length) {
        newly.forEach((k) => { fz[k] = Date.now(); });
        state.froze = [...(state.froze || []), ...newly];
        track('freeze_used', { day: dayN, days: newly.length, streak: sk0.n });
      }
      save(`${STORE}:stats`, st);
    }
    tendFold(decs, DRIVE ? `drive${DRIVE}` : RUN_N ? `run${RUN_N}` : CUSTOM ? `custom${CUSTOM}` : `d${dayN}`);
    const firstFinish = !state.done;
    state.done = true;
    if (firstFinish) {                 // the badges this finish earned (shown on this card, again if it is drawn again)
      const ev = today.map((sc, i) => ({ sc, r: state.spots[i] && state.spots[i].result, decs: (state.spots[i] && state.spots[i].decisions) || [], hh: hhs[i] }));
      if (DRIVE || RUN_N) achCount(ev);
      state.badges = CUSTOM ? [] : badgeAward(st, ev);          // (scenarios earn no badges: anyone can build an easy one)
      save(`${STORE}:stats`, st);
    }
    saveState();
    if (firstFinish) statsSync(true);              // signed in: the record goes to the account (another phone sees it)
    if (firstFinish && (DRIVE || CUSTOM)) tally(DRIVE ? 'drive' : 'scenario');     // (a run's games each counted at their end: finishSpot)
    drawTiles();
    const box = $('done');
    box.textContent = '';
    // the daily streak: days in a row finished, today included, a day a freeze covered too (what brings players back tomorrow)
    const sk = streakOf(st, DRIVE || RUN_N || CUSTOM || ARCH_DAY ? dayOf(new Date()) : dayN), streak = sk.n;
    dayLabelSet();
    if (DRIVE) {
      box.append(driveCard(p, driveRec, drivePrev), driveActions(driveRec));
    } else if (CUSTOM) box.append(scenCard(p, scenRec, scenPrev), scenActions(scenRec));
    else {
      box.append(el('div', 'note', RUN_N ? `${PRO_RUNS.runs[RUN_N - 1].title} · your run` : (dayTitle(dayN) && !SURV ? `Day ${dayN} · ${dayTitle(dayN)}` : `Day ${dayN} · your score`)), el('div', 'big-pct', `${Math.round(p * 100)}`),
        el('div', 'pct-lab', `Better than ${Math.round(p * 100)}% of NFL play\u2011callers${resultScored() ? ', the calls and the result' : ''}`),
        ...(scoreWhy(p) ? [el('p', 'pct-why', scoreWhy(p))] : []),
        Object.assign(el('div', 'pct-lab brag'), { hidden: true }),
        RUN_N || ARCH_DAY ? el('div', 'streak', RUN_N ? 'Playoff run' : 'From the archive') : endStreakEl(sk));
      if (todayDaily() && state.restarts) box.append(el('p', 'note rsnote', 'Restarted: this counts for your streak and stats, not on today’s leaderboard.'));
      if (sideTaken()) {            // a day of two sides: the one taken, and what that team really did from there
        const sp = today[0], sb = el('div', 'sidetook');
        sb.style.setProperty('--tc', color(sp.player));
        sb.append(el('b', '', `You played as ${teamName(sp.player)}`), el('span', '', `${sideLine(sp)} · ${sideLead(sp)}`));
        if (sp.real && sp.real.summary) sb.append(el('p', 'real', `What ${teamName(sp.player)} really did: ${sp.real.summary}.`));
        box.append(sb);
      }
      if (!RUN_N && state.froze && state.froze.length) box.append(el('div', 'frz', `❄️ Streak saved by a freeze${state.froze.length > 1 ? ` (${state.froze.length} days)` : ''}: ${state.froze.length > 1 ? 'the days you missed count' : 'the day you missed counts'}`));
    }
    if (RUN_N) {                      // the run's record against the real one; a loss ended it (state.out: that game)
      const run = PRO_RUNS.runs[RUN_N - 1], w = runRec.filter((x) => x > 0).length, l = runRec.filter((x) => x < 0).length;
      const played = today.filter((_, i) => state.spots[i] && state.spots[i].result).length, t = played - w - l;
      const rw = run.games.filter((g) => g.won).length, rl = run.games.length - rw, out = state.out != null ? run.games[state.out] : null;
      const realOut = run.games.find((g) => !g.won);
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', out ? 'Season over' : 'Your run'), el('b', '', `${w}-${l}${t ? `-${t}` : ''}`),
        el('span', 'sub', w === today.length ? 'Every game won. Champions.'
          : `${out ? `Out in ${roundIn(out.round)}, against ${teamName(out.opp)}. ` : ''}The real ${run.title} team went ${rw}-${rl}${realOut ? `, out in ${roundIn(realOut.round)}` : ''}.`));
      box.append(v);
      const again = el('button', 'btn', out ? 'Play the run again' : 'Play it again');
      again.type = 'button';
      again.addEventListener('click', () => { try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ } track('run_retry', { run: RUN_N }); location.reload(); });
      box.append(again);
    }
    if (cc) box.append(cc.el);
    box.append(el('p', 'verdict', callsLine(decs)));
    // a day finished before the fair score came in keeps the score it was given; on the day the old way ran high, it says so
    if (!DRIVE && !RUN_N && !PRACTICE && !ARCH_DAY && OLD_WAY_DAYS.includes(dayN) && decs.some((x) => x.g !== 2)) {
      box.append(el('p', 'note old-way', 'Scored before the fair-score fix. On this drive almost nothing anyone called changed the win chance, and the old way let the simulation’s noise count, so scores ran high; scored the fair way, it would come down mostly to the result.'));
    }
    const dbox = dailyBox(p, today.map((_, i) => (state.spots[i] && state.spots[i].decisions || []).reduce((a, x) => a + x.wpa, 0)));
    box.append(dbox);
    if (!DRIVE && !RUN_N && !CUSTOM && !ARCH_DAY) box.append(practiceNodes());
    if (ARCH_DAY || RUN_N) { const a = el('a', 'btn', RUN_N ? 'More runs' : 'Back to the archive'); a.href = '#archive'; box.append(a); }
    box.append(homeBtn());                     // (everything else there is to play)
    if (!ARCH_DAY && !RUN_N && PRO_ON && !isPro() && BOARD.api) box.append(proValueCard());       // the website: what Pro adds, after the free drive
    const rec = [0, 0, 0];             // against the real coaches: better, worse, the same (a W-L-T record)
    const rows = today.map((_, i) => {
      const s = state.spots[i]; if (!s) return '';
      const r = s.result ? (s.result.half === 1 ? 'HT' : s.result.mine > s.result.theirs ? 'W' : s.result.mine < s.result.theirs ? 'L' : 'OT') : '';
      const hh = headToHead(i, s.result);
      if (hh) rec[hh.v > 0 ? 0 : hh.v < 0 ? 1 : 2]++;
      return `${today[i].player} ${r} ${squeeze(s.decisions || []).map((m) => SQ[m]).join('')}${squeezeNote(s.decisions || [])}`;
    });
    const k3 = box.querySelector('.pct-why') ? 4 : 3;          // (the cards below go in under the score, and its why line)
    const met = rec[0] + rec[1] + rec[2], recTxt = `${rec[0]}-${rec[1]}${rec[2] ? `-${rec[2]}` : ''}`;
    liveDrive.on = false;
    if (firstFinish) track('daily_finish', { day: dayN, kind: today[0] && today[0].category, score: Math.round(p * 100),
      vs_coach: rec[0] ? 'better' : rec[1] ? 'worse' : met ? 'same' : 'none', snaps: decs.length });
    // one drive: a sentence, not a record
    const hh0 = today.length === 1 && state.spots[0] ? headToHead(0, state.spots[0].result) : null;
    const one = today.length === 1 ? (hh0 ? (rec[0] ? `Beat ${hh0.coach}` : rec[1] ? `${hh0.coach} did better` : hh0.like || `Matched ${hh0.coach}`)
      : rec[0] ? 'Beat the real coach' : rec[1] ? 'Lost to the real coach' : 'Matched the real coach') : null;
    const vs = met ? (one ? `\n${one}` : `\nVs the real coaches: ${recTxt}`) : '';
    if (met && one && hh0) box.insertBefore(hhCard(hh0), box.children[k3] || null);      // beating the real coach is the hook: say who
    else if (met && one) {
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Vs the real coach'), el('b', '', rec[0] ? 'Better' : rec[1] ? 'Worse' : 'Same'));
      box.insertBefore(v, box.children[k3] || null);
    } else if (met) {
      const v = el('div', 'h2h-day');
      v.append(el('span', 'k', 'Vs the real coaches'), el('b', '', recTxt),
        el('span', 'sub', `${rec[0]} better, ${rec[1]} worse${rec[2] ? `, ${rec[2]} the same` : ''}`));
      box.insertBefore(v, box.children[k3] || null);
    }
    const took = sideTaken() ? `As ${teamName(today[0].player)}: ${sideLine(today[0])}` : '';
    const text = `${DRIVE ? `Two-Minute Drill · ${PRO.drives[DRIVE - 1].title}\nGrade ${gradeOf(Math.round(p * 100)).L}${p * 100 >= PASS_AT - 0.5 ? ' ✅ passed' : ''}`
      : CUSTOM ? `Two-Minute Drill · my scenario: ${matchLine(today[0])}\n${gameTag(today[0])}\nGrade ${gradeOf(Math.round(p * 100)).L}` : RUN_N ? `Two-Minute Drill · the ${PRO_RUNS.runs[RUN_N - 1].title} run` : `Two-Minute Drill #${dayN}${dayTitle(dayN) ? ` · ${dayTitle(dayN)}` : ''}${took ? `\n${took}` : ''}`}\nBetter than ${Math.round(p * 100)}% of NFL play-callers${cc && cc.name ? `\nCoached like ${cc.name}` : ''}${vs}` +
      `${streak >= 2 && !CUSTOM ? `\n🔥 ${streak}-day streak` : ''}\n${rows.join('\n')}\nCan you beat me? ${CUSTOM ? scenLink(CUSTOM) : !DRIVE && !RUN_N && !ARCH_DAY ? chLink(p) : SITE}`;
    // sharing is how new players find the game: the button sits right under the result, not below the standings
    const chc = challengeCard(p);
    if (chc) box.insertBefore(chc, box.children[k3] || null);
    const share = { text };
    const pre = el('div', 'grid-share', text);
    const btn = el('button', 'btn sharebtn', 'Share your score');
    btn.type = 'button';
    btn.addEventListener('click', () => shareText(share.text, pre, 'daily'));
    box.insertBefore(pre, dbox);
    // today's players, once their results are in: the brag under the big number, in the share text and the picture
    onRank = (beat, n) => {
      const line = `Outcalled ${beat}% of today’s players`, b = box.querySelector('.pct-lab.brag');
      if (b) { b.textContent = `You outcalled ${beat}% of today’s ${n.toLocaleString()} players`; b.hidden = false; }
      if (!share.brag) { share.text = share.text.replace(/(Better than \d+% of NFL play-callers)/, `$1\n${line}`); pre.textContent = share.text; }
      share.brag = line;
    };
    box.insertBefore(btn, dbox);
    if (todayDaily()) {                 // a challenge of your own: the link to send (and the share text's, once made)
      const legacy = chLink(p), chb = el('button', 'btn ghostbtn chbtn', 'Challenge a friend');
      chb.type = 'button';
      const chText = (link) => `\ud83c\udfaf I scored ${Math.round(p * 100)} on today’s Two-Minute Drill (#${dayN}). Beat that: ${link}`;
      chb.addEventListener('click', async () => { const id = await chMine(p); track('challenge_share', { day: dayN, real: !!id }); shareText(chText(id ? cLink(id) : legacy), pre, 'challenge'); });
      btn.after(chb);
      chMine(p).then((id) => { if (id && share.text.includes(legacy)) { share.text = share.text.replace(legacy, cLink(id)); pre.textContent = share.text; } });
    }
    chEnd(box, p, (box.querySelector(':scope > .chbtn') || btn).nextSibling);
    const img = el('button', 'btn ghostbtn xshare', 'Share as a picture');
    img.type = 'button';
    img.addEventListener('click', () => shareImage({
      title: DRIVE ? PRO.drives[DRIVE - 1].title : CUSTOM ? `My scenario · ${matchLine(today[0])}` : RUN_N ? `The ${PRO_RUNS.runs[RUN_N - 1].title} run` : `Daily #${dayN}${dayTitle(dayN) ? ` · ${dayTitle(dayN)}` : ''}${took ? ` · ${teamName(today[0].player)} side` : ''}`,
      score: Math.round(p * 100), grade: DRIVE || CUSTOM ? gradeOf(Math.round(p * 100)).L : null,
      line: `Better than ${Math.round(p * 100)}% of NFL play-callers`, brag: share.brag || null,
      coach: () => (share.text.match(/Coached like ([^\n]+)/) || [])[1] || null,
      vs: met ? (one || `Vs the real coaches: ${recTxt}`) : null, beat: rec[0] > rec[1] ? 1 : rec[1] > rec[0] ? -1 : 0,
      streak: !DRIVE && !RUN_N && !CUSTOM && !ARCH_DAY ? streak : 0,
      rows: today.map((sp, i) => ({ team: sp.player, res: (rows[i] || '').split(' ')[1] || '', marks: squeeze((state.spots[i] && state.spots[i].decisions) || []) })) }));
    box.insertBefore(img, dbox);
    if (!DRIVE && !RUN_N && !CUSTOM && !ARCH_DAY && weekDays(st, dayN).filter((w) => w.d).length >= 3) {
      const wk = el('button', 'btn ghostbtn xshare', 'Share my week');
      wk.type = 'button';
      wk.addEventListener('click', () => weekImage(load(`${STORE}:stats`, { days: {} }), dayN, streak));
      box.insertBefore(wk, dbox);
    }
    box.insertBefore(callsExplained(decs), dbox);
    if (!DRIVE && !RUN_N && !CUSTOM && !ARCH_DAY) { const lg = el('p', 'lglink'); lg.hidden = true; box.insertBefore(lg, dbox); leagueNudge(); }
    badgeShow(box, state.badges || [], firstFinish);
    if (!DRIVE && !RUN_N && !CUSTOM) endSimplify(box);
    if (todayDaily()) {
      const inn = box.querySelector(':scope > .endmore > .in');
      if (inn) inn.append(fanLink());
      if (load(FAN_KEY, null) == null) dbox.after(fanAsk());     // (asked once: a pick or Not now)
    }
    const rEnd = today.length === 1 && state.spots[0] ? state.spots[0].result : null;
    crowdEnd(box, decs, share, pre, !!(rEnd && rEnd.half !== 1 && rEnd.mine > rEnd.theirs));
    box.append(countdown(streak >= 1 ? 'Keep the streak: next drive in ' : null));
    if (!DRIVE && !RUN_N && !CUSTOM && !ARCH_DAY) box.append(a2hsSlotEl(), reminderNodes());     // the habit: an icon on the phone, a reminder
    const ad = adBox('done');
    if (ad) box.append(ad);
    box.append(disclaimer());
  }
  // ---- Practice (#practice): after the day's drive, one more real drive at a time. The spot: survivor's pool (every
  // fourth-quarter spot, played to the final gun; never a featured one) less today's, none twice until the pool is
  // used up. Its own saved state (PRACTICE_KEY), so a refresh picks the drive up where it was and the finished card
  // stays until the next one is asked for (stale: the next visit draws a new drive)
  const dayDone = (n) => !!((load(`${STORE}:day:${n}`, null) || {}).done || (load(`${STORE}:stats`, { days: {} }).days || {})[n]);
  function practiceState() {
    const st = load(PRACTICE_KEY, null);
    if (st && !st.stale && st.pickId && idx.spots[st.pick] && idx.spots[st.pick].id === st.pickId) return st;   // the drive in progress, or its card
    const todays = new Set(dayIds(dayN)), all = survPool().filter((i) => !todays.has(i));
    const played = ((st && st.played) || []).filter((i) => all.includes(i)), left = all.filter((i) => !played.includes(i)), from = left.length ? left : all;
    const pick = from[Math.floor(Math.random() * from.length)];
    const nx = { run: Math.floor(Math.random() * 2 ** 31), pick, pickId: idx.spots[pick].id, played: [...(left.length ? played : []), pick],
      n: ((st && st.n) || 0) + 1, spots: [], current: 0, done: false, tryAt: Date.now() };
    save(PRACTICE_KEY, nx);
    return nx;
  }
  // a new practice drive on the next visit (the finished one's card is kept until then)
  const practiceNext = () => { const st = load(PRACTICE_KEY, null); if (st && st.done) save(PRACTICE_KEY, { ...st, stale: true }); };
  function practiceNodes() {
    const w = el('div', 'keepplay');
    const a = el('button', 'btn', 'Keep playing: practice drive');
    a.type = 'button';
    // (the hash change reloads the page into practice; scrolled up first, as the reload keeps the scroll)
    a.addEventListener('click', () => { practiceNext(); track('practice_start', { from: 'daily' }); scrollTo(0, 0); location.hash = '#practice'; });
    w.append(a, el('p', 'note', 'A random real drive, graded the same way. It doesn’t touch today’s score, your streak or the leaderboard.'));
    return w;
  }
  function renderPractice() {
    if (!G) resumeSpot(0);
    show('done');
    const decs = allDecisions(), p = decs.length ? scoreVsNFL(decs) : 0, score = Math.round(p * 100);
    if (!state.done) track('practice_finish', { n: state.n, kind: today[0] && today[0].category, score, snaps: decs.length });
    state.done = true;
    saveState();
    liveDrive.on = false;
    drawTiles();
    const box = $('done'), r = state.spots[0] && state.spots[0].result;
    box.textContent = '';
    box.append(el('div', 'note', `Practice drive ${state.n} · ${gameTag(today[0])}`), el('div', 'big-pct', String(score)),
      el('div', 'pct-lab', `Better than ${score}% of NFL play\u2011callers, the calls and the result`),
      el('div', 'streak', 'Practice: not in your stats, streak or the leaderboard'));
    const hh = r ? headToHead(0, r) : null;
    if (hh) box.append(hhCard(hh));
    if (scoreWhy(p)) box.append(el('p', 'pct-why', scoreWhy(p)));
    box.append(el('p', 'verdict', callsLine(decs)), callsExplained(decs));
    const row = el('div', 'row pacts');
    const again = el('button', 'btn', 'Another practice drive');
    again.type = 'button';
    again.addEventListener('click', () => { practiceNext(); track('practice_start', { from: 'practice' }); scrollTo(0, 0); location.reload(); });
    const back = el('button', 'btn ghostbtn', 'Back to today');
    back.type = 'button';
    back.addEventListener('click', () => { scrollTo(0, 0); location.hash = '#daily'; });     // (the hash change reloads the page into the day)
    row.append(again, back, homeBtn());
    box.append(row, disclaimer());
  }
  // ---- the daily habit: the streak in the top bar, and a reminder in the player's own calendar (a daily event at the
  // hour they pick: Google Calendar's own page, or a .ics file site.py writes for Apple and Outlook calendars)
  // The streak has a safety net: every FREEZE_EVERY days in a row earn a streak freeze (FREEZE_MAX held at most), and a
  // missed day (two, with two held) is covered by them once the next day is played, so one busy day doesn't end a long
  // streak. It is worked out from the days played alone (the same answer on every phone; a missed day played later from
  // the archive gives its freeze back); a day a freeze covered is kept in the stats (frozen: { day: when }, synced) so
  // it shows as ❄️, is told about once and counts on a league board. Until the next day is played, the freezes a gap
  // would take are pending: the streak is still alive, and the top bar says so. A league board works it out the same
  // way from the synced days (board/worker.js streakOf: change both together).
  const FREEZE_EVERY = 7, FREEZE_MAX = 2;
  function streakOf(st, d) {
    const fz = st.frozen || {}, ks = Object.keys(st.days || {}).map(Number).filter((k) => k > 0 && k <= d).sort((a, b) => a - b);
    const frozen = new Set();
    let run = 0, best = 0, held = 0, last = 0;
    // the missed days after the last one played and before day b, covered (frozen) or the streak over
    const bridge = (b) => {
      const gap = Array.from({ length: Math.max(0, b - last - 1) }, (_, j) => last + 1 + j);
      if (!gap.length) return [];
      if (run > 0 && (gap.length <= held || gap.every((j) => fz[j]))) { held = Math.max(0, held - gap.length); run += gap.length; return gap; }
      run = 0;
      return null;
    };
    for (const k of ks) {
      const from = last ? run : 0, gap = last ? bridge(k) : [];
      (gap || []).forEach((j) => frozen.add(j));
      run += 1;
      held = Math.min(FREEZE_MAX, held + Math.floor(run / FREEZE_EVERY) - Math.floor((gap ? from : 0) / FREEZE_EVERY));
      best = Math.max(best, run);
      last = k;
    }
    const pending = last && last < d ? bridge(d) : [];      // (today not played yet: not missed yet)
    return { n: last && pending ? run : 0, best, held, frozen, pending: pending || [] };
  }
  // the daily's top bar: the day, and the streak (❄️: a missed day a freeze covers once today is played); drawn again
  // when a finish or a sync changes the streak (never over practice's own label: a sync landing mid-drive put the day's
  // number and streak up there, as if it were the daily)
  function dayLabelSet() {
    if (SURV || PRACTICE || DRIVE || RUN_N || CUSTOM || VS || ARCH || !idx || !today.length) return;
    const sk = ARCH_DAY ? null : streakOf(load(`${STORE}:stats`, { days: {} }), dayOf(new Date())), stk = sk ? sk.n : 0;
    $('dayLabel').textContent = `No. ${dayN} · ${dayDate(dayN).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${ARCH_DAY ? ' · archive' : ''}${stk >= 2 ? ` · \ud83d\udd25${stk}${sk.pending.length ? '\u2744\ufe0f' : ''}` : ''}`;
  }
  const freezeTxt = (n) => `❄️ ${n} streak freeze${n === 1 ? '' : 's'}`;
  // the end card's streak line (and the freezes held beside it)
  // the end card's streak: its flame and the line
  function endStreakEl(sk) {
    const d = el('div', 'streak endstk');
    d.append(flameEl(sk.n), el('span', '', streakLine(sk).replace(/^🔥 /, '')));
    return d;
  }
  // The end card kept short: the score, the streak, two chips (you against the real coach, who you coached like),
  // Share, and what to play next. Everything else (those cards in full, the calls line, your calls explained, the
  // share text, the picture) is one tap away under "See the breakdown"; a chip opens it at its card
  function endSimplify(box) {
    const kid = (q) => box.querySelector(`:scope > ${q}`);
    const vs = kid('.h2h') || kid('.h2h-day'), coach = kid('.coach');
    const more = el('details', 'endmore'), inn = el('div', 'in');
    more.append(el('summary', '', 'See the breakdown'), inn);
    [vs, coach, kid('.pct-why'), kid('.verdict'), kid('.old-way'), kid('.explain'), kid('.grid-share'), ...box.querySelectorAll(':scope > .xshare')]
      .forEach((n) => { if (n) inn.append(n); });
    const chips = el('div', 'endchips');
    const chip = (k, v, at) => {
      const b = el('button', 'echip');
      b.type = 'button';
      b.append(el('span', 'k', k), el('b', '', v));
      b.addEventListener('click', () => { more.open = true; at.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); });
      chips.append(b);
    };
    if (vs) {
      const k = vs.querySelector('.k'), v = vs.querySelector('.res') || vs.querySelector('b');
      chip(k ? k.textContent : 'Vs the real coach', v ? v.textContent : '', vs);
    }
    if (coach) { const nm = coach.querySelector('.name'); if (nm) chip('Coached like', nm.textContent, coach); }
    const top = kid('.streak') || kid('.pct-lab');
    if (chips.childNodes.length && top) top.after(chips);
    const share = kid('.chslot') || kid('.chbtn') || kid('.sharebtn');
    if (share) share.after(more); else box.append(more);
  }
  function streakLine(sk) {
    if (sk.n < 2) return sk.held ? `Day 1 of your streak · ${freezeTxt(sk.held)}` : 'Day 1 of your streak · come back tomorrow';
    return `🔥 ${sk.n}-day streak${sk.held ? ` · ${freezeTxt(sk.held)}` : ` · a freeze at ${Math.ceil((sk.n + 1) / FREEZE_EVERY) * FREEZE_EVERY}`}`;
  }

  // ---- badges: milestones with a football name, earned once and kept with the time (stats.badges: { id: when }; on
  // the account the earliest time of each, worker.js statsMerge). Most are tests on the record (the stats days, the
  // drives, the runs, survivor's best, the streak: a new phone signed in earns the same ones); a few on the games just
  // finished (a perfect drive, a comeback: seen only then). Pro's show only with Pro on. A finish celebrates the new
  // ones on its end card (kept in the saved state: the card drawn again shows them again).
  const ACH_KEY = `${STORE}:ach`;      // this browser's counts outside the days: { beat, wins } in survivor, drives, runs
  const lead0 = (sc) => sc.start.score[sc.player === sc.home ? 1 : 0] - sc.start.score[sc.player === sc.home ? 0 : 1];
  const gWon = (g) => !!(g.r && g.r.half !== 1 && g.r.mine > g.r.theirs);
  const gLost = (g) => !!(g.r && g.r.half !== 1 && g.r.mine < g.r.theirs);
  const anyG = (ev, f) => !!ev && ev.some(f);
  const fullWeek = (days) => Object.keys(days).map(Number).some((k) => dayDate(k).getDay() === 1 && [1, 2, 3, 4, 5, 6].every((j) => days[k + j]));
  const BADGES = [
    ['first', '🏈', 'Opening drive', 'Finish your first game.', (R, ev) => !!(ev && ev.length) || R.nDays + R.drives.length + R.runs.length + R.survRuns > 0],
    ['win', '✅', 'In the win column', 'Win a game.', (R, ev) => anyG(ev, gWon) || R.wins > 0 || R.surv > 0 || R.drives.some((d) => d.won) || R.runs.some((r) => r.w > 0)],
    ['coach', '🧠', 'Outcoached', 'Beat the real coach: a better result than he got.', (R) => R.beat >= 1],
    ['coach10', '🎓', 'Coaching tree', 'Beat the real coach 10 times.', (R) => R.beat >= 10],
    // (not on the finish of a game lost: a star day beside a loss read as a mistake)
    ['day90', '⭐', 'Pro Bowl day', 'Score 90 or more on a daily you don’t lose.', (R, ev) => !anyG(ev, gLost) && Object.values(R.days).some((x) => Math.round(x.p * 100) >= 90)],
    // (snaps where something was at stake: down 25 in the third quarter every call is green, random ones too)
    ['perfect', '💎', 'Perfect drive', 'Make every call green on a drive with 3 or more snaps that mattered.', (R, ev) => anyG(ev, (g) => { const s = snapStats(g.decs); return s.filter((x) => x.matters).length >= 3 && s.every((x) => x.m === 'g'); })],
    ['comeback', '🔄', 'Comeback kid', 'Win a game you took over down 7 or more.', (R, ev) => anyG(ev, (g) => gWon(g) && lead0(g.sc) <= -7)],
    ['twomin', '⏱️', 'Two-minute warrior', 'Win a game you took over with under 1:00 to play.', (R, ev) => anyG(ev, (g) => gWon(g) && g.sc.start.qtr === 4 && g.sc.start.clock < 60)],
    ['streak3', '🔥', 'Three-peat', 'Play the daily 3 days in a row.', (R) => R.sk.best >= 3],
    ['streak7', '🏋️', 'Training camp', `Play the daily ${FREEZE_EVERY} days in a row (it earns a streak freeze).`, (R) => R.sk.best >= 7],
    ['streak30', '🦾', 'Ironman', 'Play the daily 30 days in a row.', (R) => R.sk.best >= 30],
    ['week', '📅', 'Perfect attendance', 'Play every day of a week, Monday to Sunday.', (R) => fullWeek(R.days)],
    ['season', '🗓️', 'Full season', 'Play 17 dailies: a whole regular season.', (R) => R.nDays >= 17],
    ['ice', '❄️', 'Ice in the veins', 'Have a streak freeze save your streak.', (R) => R.sk.frozen.size > 0],
    ['surv5', '🛡️', 'Still standing', 'Win 5 straight in Survivor.', (R) => R.surv >= 5],
    ['surv10', '👑', 'Dynasty', 'Win 10 straight in Survivor.', (R) => R.surv >= 10],
    ['history', '📜', 'Rewrite history', 'Pass a historic drive (Pro): an A, and the game won.', (R) => R.drives.some((d) => d.p * 100 >= PASS_AT - 0.5), true],
    ['ring', '💍', 'Ring ceremony', 'Win every game of a playoff run (Pro).', (R) => R.runs.some((r) => r.n > 0 && r.w === r.n), true],
  ].map(([id, icon, name, how, test, pro]) => ({ id, icon, name, how, test, pro: !!pro }));
  const badgesShown = () => BADGES.filter((b) => !b.pro || PRO_ON);
  function badgeRecord(st) {
    const days = st.days || {}, sv = survStats(), ach = load(ACH_KEY, {});
    return { days, nDays: Object.keys(days).length, sk: streakOf(st, dayOf(new Date())), drives: Object.values(load(`${STORE}:drives`, {})),
      runs: Object.values(load(`${STORE}:runs`, {})), survRuns: sv.runs || 0, surv: Math.max(sv.best || 0, SURV && state ? state.won || 0 : 0),
      beat: Object.values(days).filter((x) => x.vs > 0).length + (ach.beat || 0), wins: ach.wins || 0 };
  }
  // the badges the record (and ev: the games just finished, [{ sc, r, decs }]) has earned and st does not have yet:
  // added to st (the caller saves it) and their ids returned
  function badgeAward(st, ev) {
    const R = badgeRecord(st), have = st.badges || (st.badges = {}), now = Date.now();
    const got = badgesShown().filter((b) => !have[b.id] && b.test(R, ev)).map((b) => b.id);
    got.forEach((id) => { have[id] = now; track('badge_unlocked', { badge: id, mode: SURV ? 'survivor' : DRIVE ? 'drive' : RUN_N ? 'run' : ARCH_DAY ? 'archive' : 'daily' }); });
    return got;
  }
  // a finish outside the daily days (survivor, a drive, a run): its wins and real coaches beaten, counted once
  function achCount(ev) {
    const ach = load(ACH_KEY, {});
    ev.forEach((g) => { if (gWon(g)) ach.wins = (ach.wins || 0) + 1; if (g.hh && g.hh.v > 0) ach.beat = (ach.beat || 0) + 1; });
    save(ACH_KEY, ach);
  }
  // the new badges on an end card: one card, the last of them (the list runs from the first steps to the rare ones)
  // named big, the rest in a row
  function badgeCard(ids) {
    const bs = ids.map((id) => BADGES.find((b) => b.id === id)).filter(Boolean).reverse();
    if (!bs.length) return null;
    const box = el('div', 'newbadge');
    box.setAttribute('role', 'status');
    const ic = el('div', 'bic', bs[0].icon);
    ic.setAttribute('aria-hidden', 'true');
    const t = el('div', 'bt');
    t.append(el('div', 'k', bs.length > 1 ? `🏅 ${bs.length} new badges` : '🏅 New badge'), el('b', '', bs[0].name), el('span', '', bs[0].how.replace(/\.$/, '')));
    box.append(ic, t);
    if (bs.length > 1) { const m = el('div', 'more'); bs.slice(1).reverse().forEach((b) => m.append(el('span', '', `${b.icon} ${b.name}`))); box.append(m); }
    const all = el('button', 'linkbtn', 'All your badges');
    all.type = 'button';
    all.addEventListener('click', () => openStats('badges'));
    box.append(all);
    return box;
  }
  // the end card's badge card, before the coach (or the verdict); a toast too when they are new
  function badgeShow(box, ids, fresh) {
    const c = badgeCard(ids), old = box.querySelector('.newbadge');
    if (old) old.remove();
    if (!c) return;
    // (before the breakdown on the short end card: endSimplify; else before the coach, the verdict or the share text)
    const ref = box.querySelector(':scope > .endmore') || box.querySelector(':scope > .coach, :scope > .verdict, :scope > .grid-share');
    box.insertBefore(c, ref);
    if (fresh) badgeToast(ids, c);
  }
  // a new badge: its card says so; the toast too only when the card is out of sight, and then at the foot of the
  // screen (at the top it covered the end card's score and squares)
  function badgeToast(ids, card) {
    requestAnimationFrame(() => {
      if (card && card.isConnected) {
        let r = card.getBoundingClientRect(), top = Math.max(r.top, 0), bot = Math.min(r.bottom, window.innerHeight);
        for (let e = card.parentElement; e && e !== document.body; e = e.parentElement) {
          if (getComputedStyle(e).overflowY === 'visible') continue;
          r = e.getBoundingClientRect(); top = Math.max(top, r.top); bot = Math.min(bot, r.bottom);
        }
        if (bot - top >= 24) return;                     // (in sight)
      }
      toast(`🏅 New badge: ${BADGES.find((b) => b.id === ids[ids.length - 1]).name}`, true);
    });
  }
  // the stats sheet's badges: earned first (with the day), then the ones to get (greyed, with how)
  function badgesEl(st) {
    const have = st.badges || {}, list = badgesShown(), n = list.filter((b) => have[b.id]).length;
    const sec = el('div', 'badges');
    sec.id = 'badges';
    sec.append(el('h3', '', `Badges · ${n} of ${list.length}`));
    const grid = el('div', 'bgrid');
    [...list.filter((b) => have[b.id]).sort((a, b) => have[a.id] - have[b.id]), ...list.filter((b) => !have[b.id])].forEach((b) => {
      const on = !!have[b.id], c = el('div', `bdg${on ? ' on' : ''}`), ic = el('span', 'bic', b.icon);
      ic.setAttribute('aria-hidden', 'true');
      const t = el('div', 'bt');
      t.append(el('b', '', b.name), el('span', '', on ? new Date(have[b.id]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : b.how));
      c.setAttribute('aria-label', `${b.name}: ${on ? `earned ${t.lastChild.textContent}` : `locked. ${b.how}`}`);
      c.append(ic, t);
      grid.append(c);
    });
    sec.append(grid);
    return sec;
  }
  // the last four weeks of the daily, a week a row: played (the score's color), covered by a freeze (❄️), missed
  function streakCal(st, sk) {
    const d = dayOf(new Date()), cal = el('div', 'scal'), from = Math.max(1, d - 27);
    const lab = el('div', 'scalh');
    lab.append(el('span', '', 'The last 4 weeks'), el('span', '', sk.held ? freezeTxt(sk.held) : `A freeze every ${FREEZE_EVERY} days in a row`));
    const grid = el('div', 'scalg');
    for (let k = from - ((dayDate(from).getDay() + 6) % 7); k <= d; k++) {       // from a Monday
      const x = st.days[k], fz = sk.frozen.has(k) || sk.pending.includes(k);
      const c = el('span', k < from ? 'pad' : x ? 'on' : fz ? 'fz' : k === d ? 'td' : '', fz && !x ? '❄️' : String(dayDate(k).getDate()));
      if (k >= from) c.title = `${dayDate(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${x ? Math.round(x.p * 100) : fz ? (sk.pending.includes(k) ? 'missed: a freeze covers it if you play today' : 'missed: a streak freeze covered it') : k === d ? 'today' : 'missed'}`;
      grid.append(c);
    }
    cal.append(lab, grid);
    return cal;
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
  // ---- Add to Home Screen: the game as an icon on the phone (site.webmanifest, sw.js), offered on the day's end card to a
  // player who has come back (two days played or more), never on a first visit and never inside the installed app.
  // Chrome and Android hand the page an install prompt (beforeinstallprompt: held until the card's button); Safari on
  // iOS has none, so the card says where the two taps are. Asked at most three times, a week apart at least.
  const A2HS_KEY = `${STORE}:a2hs`;
  const STANDALONE = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const UA = navigator.userAgent || '';
  const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari itself (the other iOS browsers and the apps' own browsers put Add to Home Screen elsewhere, or nowhere)
  const IOS_SAFARI = IOS && /Safari\//.test(UA) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|Snapchat|Twitter/.test(UA);
  let a2hsEvt = null, a2hsSlot = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                  // not Chrome's own bar on a first visit: the end card asks, when it is time
    a2hsEvt = e;
    if (a2hsSlot && a2hsSlot.isConnected && !a2hsSlot.firstChild) a2hsFill(a2hsSlot);      // came after the card was drawn
  });
  addEventListener('appinstalled', () => { a2hsEvt = null; const s = load(A2HS_KEY, {}); if (!s.done) { s.done = true; save(A2HS_KEY, s); } });
  // opened from the home screen: installed (on iOS the only sign there is; counted once)
  if (STANDALONE && BUILD) { const s = load(A2HS_KEY, {}); if (!s.done) { s.done = true; save(A2HS_KEY, s); track('install_accepted', { platform: IOS ? 'ios' : 'prompt', via: 'launch' }); } }
  function a2hsSlotEl() { a2hsSlot = el('div', 'a2hsslot'); a2hsFill(a2hsSlot); return a2hsSlot; }
  // The site moved to a new address (web/move.js handed this player over, progress and all, and left tmd:v3:movedin):
  // said once. Handed over from a home-screen icon of the old address (it hands over every time, and keeps working), the
  // steps to put the new one there; that icon keeps its own storage, so signed out, the sign-in that carries the record.
  function movedNote() {
    const m = load(`${STORE}:movedin`, null), want = m && m.s ? 2 : 1;
    if (!m || !BUILD || load(`${STORE}:movenote`, 0) >= want || (want === 2 && !$('modal').hidden)) return;
    save(`${STORE}:movenote`, want);
    track('moved_in', { from: String(m.from || ''), keys: m.n || 0, icon: want === 2 ? 1 : 0 });
    if (want === 1) { toast(`Two-Minute Drill has a new address: ${SITE}. Your progress came along.`); return; }
    const ol = el('ol', 'movesteps');
    ol.append(el('li', '', IOS ? `Open ${SITE} in Safari` : `Open ${SITE} in your browser`),
      el('li', '', IOS ? 'Tap Share, then Add to Home Screen' : 'Its menu (⋮): Add to Home screen, or Install app'),
      el('li', '', 'Remove the old icon (press and hold it)'));
    const go = el('button', 'btn', 'Got it');
    go.type = 'button';
    go.addEventListener('click', closeModal);
    openModal('The game has a new address', [el('p', 'lead', `Two-Minute Drill is now at ${SITE}. Your streak, stats and Pro came along.`),
      el('p', '', 'Your home-screen icon still opens the old address (and brings you here). To put the new one on your home screen:'), ol,
      el('p', 'note', signedIn() || authSession() ? 'You are signed in, so your record follows you to the new icon.'
        : 'Log in first (top of the page): your record then follows you to the new icon. Pro comes back there with your code.'), go]);
  }
  function a2hsFill(slot) {
    const plat = a2hsEvt ? 'prompt' : IOS_SAFARI ? 'ios' : null;
    if (!BUILD || STANDALONE || !plat || DRIVE || RUN_N || CUSTOM || ARCH_DAY || SURV) return;
    if (Object.keys(load(`${STORE}:stats`, { days: {} }).days).length < 2) return;
    const s = load(A2HS_KEY, {}), now = Date.now();
    if (s.done || s.offDay === dayN) return;                        // installed, or closed today
    if (s.day !== dayN) {                                           // a new offer: the third is the last, a week after the one before
      if ((s.n || 0) >= 3 || (s.at && now - s.at < 7 * 864e5)) return;
      Object.assign(s, { n: (s.n || 0) + 1, day: dayN, at: now });
      save(A2HS_KEY, s);
      track('install_prompt_shown', { platform: plat, n: s.n });
    }
    slot.textContent = '';
    const card = el('div', 'a2hs');
    card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Add to Home Screen');
    const img = el('img'); img.src = 'icon-180.png'; img.alt = ''; img.width = img.height = 52;
    const phone = TOUCH || IOS;
    card.append(img, el('b', '', phone ? 'Add Two-Minute Drill to your home screen' : 'Install Two-Minute Drill'),
      el('span', 'sub', phone ? 'Today’s drive in one tap, full screen, like an app.' : 'Its own window and an icon: today’s drive in one click.'));
    const x = el('button', 'x', '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Not now');
    x.addEventListener('click', () => {
      const t = load(A2HS_KEY, {}); t.offDay = dayN; save(A2HS_KEY, t);
      track('install_dismissed', { platform: plat, n: t.n || 0, how: 'close' });
      slot.textContent = '';
    });
    if (plat === 'prompt') {
      const go = el('button', 'btn alt go', phone ? 'Add to Home Screen' : 'Install');
      go.type = 'button';
      go.addEventListener('click', async () => {
        const ev = a2hsEvt;
        if (!ev) { slot.textContent = ''; return; }
        a2hsEvt = null;                                             // a prompt can be shown once
        try {
          ev.prompt();
          const { outcome } = await ev.userChoice;
          const t = load(A2HS_KEY, {});
          if (outcome === 'accepted') { t.done = true; track('install_accepted', { platform: plat, n: t.n || 0 }); }
          else { t.offDay = dayN; track('install_dismissed', { platform: plat, n: t.n || 0, how: 'prompt' }); }
          save(A2HS_KEY, t);
          slot.textContent = '';
          if (outcome === 'accepted') toast('Added. Find Two-Minute Drill on your home screen.');
        } catch (e) { slot.textContent = ''; }
      });
      card.append(go);
    } else {
      // Safari's Share button (the square with the arrow) and its Add to Home Screen (the square with the plus)
      const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
      const ol = el('ol');
      const a = el('li'), b = el('li');
      a.innerHTML = `Tap Share ${ic('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/>')} in Safari’s toolbar`;
      b.innerHTML = `Then Add to Home Screen ${ic('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>')}`;
      ol.append(a, b);
      card.append(ol);
    }
    card.append(x);
    slot.append(card);
  }
  // the service worker (sw.js, the installable app's offline copy): on the website only, never on a local server (the
  // browser test reloads mid-drive, and a worker kept from an older build would only get in the way there) unless a
  // test asks for it (tmd:v3:sw_local); the worker itself goes to the network first, so a deploy is seen on the next load
  function swOn() {
    return !!BUILD && 'serviceWorker' in navigator && (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || load(`${STORE}:sw_local`, false));
  }
  if (swOn()) {
    const reg = () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* no worker: the site works the same */ });
    if (document.readyState === 'complete') reg(); else addEventListener('load', reg);
    // the first visit: the page, its scripts, fonts and the spot's data came before the worker took over, so it kept
    // none of them and the app could not open with no signal until a second visit. Copies go into its cache once it is
    // in charge (the browser's own cache answers: the stamped files are cached for good). The packs are kept by
    // fetchPacked (a pack still coming in would download twice)
    if (!navigator.serviceWorker.controller && typeof caches !== 'undefined') {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        const mine = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin && /\.(?:js|json|png|svg|ico|webmanifest|woff2)$/.test(x.pathname) && !/^\/(?:ad-|admin|sw\.js|version\.json|remind-)/.test(x.pathname); } catch (e) { return false; } };
        const urls = [location.pathname].concat(performance.getEntriesByType('resource').map((e) => e.name).filter(mine));
        caches.open(`tmd-${BUILD}`).then((c) => Promise.all([...new Set(urls)].map((u) => c.match(u).then((hit) => hit || c.add(u)).catch(() => { /* not kept: online play is the same */ }))))
          .catch(() => { /* storage full or off */ });
      }, { once: true });
    }
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
    x.font = `700 34px ${BODY}`; x.fillStyle = 'rgba(255,255,255,.75)'; x.fillText(o.title.toUpperCase(), W / 2, 185, W - 80);
    x.fillStyle = '#fff'; x.font = `900 300px ${DISP}`; x.fillText(o.grade || String(o.score), W / 2, 470);
    x.font = `600 38px ${BODY}`; x.fillText(o.grade ? `${o.score} \u00b7 ${o.line}` : o.line, W / 2, 545);
    if (o.brag) { x.font = `800 36px ${BODY}`; x.fillStyle = '#ffb547'; x.fillText(o.brag, W / 2, 595, W - 80); x.fillStyle = '#fff'; }
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
    const GAP = 14;
    o.rows.slice(0, 4).forEach((r) => {
      // (up to SHARE_SQ squares: smaller past 8, so the row and its label stay inside the picture)
      const n = Math.max(1, r.marks.length), SQ = Math.min(74, Math.floor((W - 340 - (n - 1) * GAP) / n)), w = n * SQ + (n - 1) * GAP, lab = `${r.team} ${r.res}`.trim();
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
    await sharePng(cv, o.title, 'image');
  }
  // the picture to the phone's share sheet, else a download
  async function sharePng(cv, title, what) {
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) { toast('Could not make the picture'); return; }
    const file = new File([blob], `two-minute-drill-${title.replace(/\W+/g, '-').toLowerCase()}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `Can you beat me? https://${SITE}` });
        track('share', { what, method: 'sheet' });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Picture saved');
    track('share', { what, method: 'download' });
  }
  // The week on one picture: the last seven dailies up to `end` (a bar each, its score; a gap for a day missed), the
  // average of the days played, the best one and the streak. Offered once three of the seven are played.
  const weekDays = (st, end) => Array.from({ length: 7 }, (_, i) => end - 6 + i).map((n) => ({ n, d: n >= 1 && st.days[n] ? st.days[n] : null }));
  async function weekImage(st, end, streak) {
    const W = 1080, H = 1350, cv = document.createElement('canvas'), x = cv.getContext('2d');
    cv.width = W; cv.height = H;
    try { await document.fonts.ready; } catch (e) { /* no font API */ }
    const css = getComputedStyle(document.documentElement), col = (v, d) => (css.getPropertyValue(v) || '').trim() || d;
    const DISP = '"Big Shoulders Display", "Arial Narrow", sans-serif', BODY = '"Libre Franklin", Arial, sans-serif';
    const MK = { g: col('--sq-g', '#3d9a56'), y: col('--sq-y', '#d2ad2e'), o: col('--sq-o', '#e27c37'), r: col('--sq-r', '#d0463f') };
    const days = weekDays(st, end), played = days.filter((w) => w.d), sc = (w) => Math.round(w.d.p * 100);
    const avg = Math.round(played.reduce((a, w) => a + sc(w), 0) / played.length), best = played.reduce((a, w) => (sc(w) > sc(a) ? w : a));
    const dateOf = (n) => { const d = new Date(idx.launch + 'T12:00:00'); d.setDate(d.getDate() + n - 1); return d; };
    const bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0f2a18'); bg.addColorStop(1, '#173d24');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 3;
    for (let y = 90; y < H; y += 110) { x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
    x.textAlign = 'center'; x.fillStyle = '#fff';
    x.font = `900 64px ${DISP}`; x.fillText('TWO-MINUTE DRILL', W / 2, 130);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    x.font = `700 34px ${BODY}`; x.fillStyle = 'rgba(255,255,255,.75)';
    x.fillText(`MY WEEK \u00b7 ${fmt(dateOf(Math.max(1, end - 6)))} \u2013 ${fmt(dateOf(end))}`.toUpperCase(), W / 2, 185);
    x.fillStyle = '#fff'; x.font = `900 260px ${DISP}`; x.fillText(String(avg), W / 2, 430);
    x.font = `600 38px ${BODY}`; x.fillText(`Average of ${played.length} drive${played.length === 1 ? '' : 's'} vs NFL play-callers`, W / 2, 500, W - 80);
    // the bars: one a day, as tall as its score, colored like the call squares
    const top = 580, base = 1000, bw = 104, gap = 30, x0 = (W - (7 * bw + 6 * gap)) / 2;
    x.strokeStyle = 'rgba(255,255,255,.25)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(x0 - 10, base + 1); x.lineTo(W - x0 + 10, base + 1); x.stroke();
    days.forEach((w, i) => {
      const xx = x0 + i * (bw + gap);
      x.font = `800 34px ${DISP}`; x.fillStyle = 'rgba(255,255,255,.75)';
      x.fillText(w.n >= 1 ? dateOf(w.n).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase() : '', xx + bw / 2, base + 52);
      if (!w.d) { x.fillStyle = 'rgba(255,255,255,.18)'; x.fillRect(xx + bw / 2 - 18, base - 8, 36, 6); return; }
      const v = sc(w), h = Math.max(14, ((base - top - 60) * v) / 100);
      x.fillStyle = v >= 80 ? MK.g : v >= 60 ? MK.y : v >= 40 ? MK.o : MK.r;
      x.beginPath(); x.roundRect ? x.roundRect(xx, base - h, bw, h, [12, 12, 0, 0]) : x.rect(xx, base - h, bw, h); x.fill();
      x.font = `900 44px ${DISP}`; x.fillStyle = '#fff'; x.fillText(String(v), xx + bw / 2, base - h - 14);
    });
    x.font = `600 36px ${BODY}`; x.fillStyle = 'rgba(255,255,255,.85)';
    x.fillText(`Best: ${sc(best)} on ${dateOf(best.n).toLocaleDateString(undefined, { weekday: 'long' })}${best.d.coach ? `, coached like ${best.d.coach}` : ''}`, W / 2, 1120, W - 80);
    if (streak >= 2) { x.font = `900 56px ${DISP}`; x.fillStyle = '#ffb547'; x.fillText(`\ud83d\udd25 ${streak}-DAY STREAK`, W / 2, 1195); }
    x.font = `700 40px ${BODY}`; x.fillStyle = '#fff'; x.fillText(`Can you beat my week? ${SITE}`, W / 2, H - 70);
    await sharePng(cv, `week-${end}`, 'week');
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
    ['The historic drives: Mahomes\u2019 13 seconds, the Minneapolis Miracle, the Helmet Catch, 28\u20133 and more, from their real spots',
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
  // Survivor: one extra life a run. Pro: free (Pro has no ads). Else a rewarded ad the player opts into (Ezoic's
  // rewarded ads, site.py EZOIC_HEAD's ezRewardedAds stub: the life only once the ad's timer is done; none to show, or
  // closed early, and the run stays over), or where the site runs other networks, the old short ad break
  const LIFE_ON = true, LIFE_WAIT = 8000;
  function reviveRun(how) {
    state.out = false; state.life = true; state.pick = null;
    saveState();
    track('extra_life', { streak: state.won, how });
    survOpen();
  }
  function lifeOffer() {
    if (!LIFE_ON || !state.out || state.life) return [];
    const note = el('p', 'note', 'Once a run. Your loss stays on your record, and the board marks the run with \u2764\ufe0f.');
    if (isPro()) {
      const b = el('button', 'btn gold', '\u2764\ufe0f Extra life (Pro)');
      b.type = 'button';
      b.addEventListener('click', () => reviveRun('pro'));
      return [b, note];
    }
    if (noAds()) return [];
    const rw = window.ezRewardedAds;
    if (EZ && rw && rw.cmd) {
      const b = el('button', 'btn gold', '\u2764\ufe0f Extra life: watch an ad');
      b.type = 'button';
      b.addEventListener('click', () => rewardedLife(b));
      return [b, note];
    }
    if (EZ || !adCodes().length) return [];
    const life = el('button', 'btn gold', '\u2764\ufe0f Extra life: watch a 15-second ad');
    life.type = 'button';
    life.addEventListener('click', () => adBreak(() => reviveRun('break')));
    return [life, note];
  }
  function rewardedLife(b) {
    const rw = window.ezRewardedAds, label = b.textContent;
    let done = false, granted = false;
    const back = (why) => { if (done) return; done = true; clearTimeout(t); b.disabled = false; b.textContent = label; if (why) toast(why); };
    const grant = () => { if (granted) return; granted = true; done = true; clearTimeout(t); reviveRun('ad'); };
    b.disabled = true; b.textContent = 'Loading the ad\u2026';
    track('extra_life_offer_taken');
    const t = setTimeout(() => back('No ad to show right now. Try again in a minute.'), LIFE_WAIT);
    rw.cmd.push(() => {
      try {
        const onDone = (e) => { if (e && e.rewardName === 'extra_life') { rw.removeEventListener('adCompleted', onDone); grant(); } };
        rw.addEventListener('adCompleted', onDone);
        rw.request((q) => {
          if (done) return;
          clearTimeout(t);
          if (!q || !q.status) { back('No ad to show right now. Try again in a minute.'); return; }
          rw.show((r) => {
            if (r && r.status && r.reward) grant();
            else back(r && r.status ? 'Watch the ad to the end for the extra life.' : 'The ad could not play. Try again in a minute.');
          }, { rewardName: 'extra_life', alwaysCallback: true });
        }, { rewardName: 'extra_life' });
      } catch (e) { back('The ad could not play. Try again in a minute.'); }
    });
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
  // Google AdSense's script on the game's page (site.py ADSENSE_LATER: its address in a meta): not during start-up,
  // where it competed with the game's own files for the network and the phone's CPU, but once the game is up: on idle
  // after the first play (a result on screen), or ADS_WAIT after the first call if no play is made, and only once the
  // game's data is in and no snap is on its way or playing; at once for a unit between games (adBox); a page that
  // shows neither (the intro left open, the Pro tab) gets it ADS_LATE after it loads. Auto ads come with the script
  const ADS_AFTER = 1000, ADS_WAIT = 15000, ADS_LATE = 30000;
  let adsIn = false, adsDue = Infinity, adsT = 0;
  function adsLoad() {
    const m = document.querySelector('meta[name="ads-src"]');
    if (adsIn || !m || noAds()) return;
    adsIn = true;
    clearTimeout(adsT);
    const sc = document.createElement('script');
    sc.async = true; sc.crossOrigin = 'anonymous'; sc.src = m.content;
    document.head.append(sc);
  }
  function adsSoon(ms) {
    if (adsIn || !document.querySelector('meta[name="ads-src"]')) return;
    const due = performance.now() + ms;
    if (due >= adsDue) return;
    adsDue = due;
    clearTimeout(adsT);
    adsT = setTimeout(() => Promise.resolve(fetched ? dataBytes : null).catch(() => null).then(() => {
      // (never while a snap is on its way or playing: a little after it)
      if (busy || document.querySelector('#field.playing')) { adsDue = Infinity; adsSoon(3 * ADS_AFTER); return; }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(adsLoad, { timeout: 3000 }); else adsLoad();
    }), ms);
  }
  addEventListener('load', () => adsSoon(ADS_LATE));
  // Ezoic (site.py --ezoic-head: <meta name="ezoic">, and the game's own spots' placeholder ids from Ezoic's dashboard in
  // <meta name="ezoic-ids">: the day's end card, survivor's card after a game, survivor's run over). The cards are made
  // here, after the page loads, so each spot is called with showAds(id) once it is on the page, destroyed before its id
  // is used again (Ezoic: dynamic content), and while a drive is on screen no interstitial or floating video comes over it
  const EZ = !!document.querySelector('meta[name="ezoic"]');
  const EZ_IDS = ((document.querySelector('meta[name="ezoic-ids"]') || {}).content || '').split(',').map(Number).filter((n) => n > 0);
  const EZ_KINDS = ['done', 'surv', 'survend'];
  const ezShown = new Set();
  let ezPlay = null;
  function ezq(fn) {
    if (!EZ) return;
    try {
      const z = window.ezstandalone = window.ezstandalone || {};
      (z.cmd = z.cmd || []).push(() => { try { fn(window.ezstandalone); } catch (e) { /* never in the way */ } });
    } catch (e) { /* no Ezoic */ }
  }
  // A full-screen ad (interstitial) only at a break: never as the site opens or on the menus (players met a blank or
  // look-alike "Continue" page over the game), only once a drive or a Survivor game is over (its card, ezBreak), for a
  // minute and a half or until the next drive, never in a visit's first EZ_FIRST, and at most once in EZ_GAP (players:
  // "giant ads popping up every 15 seconds")
  const EZ_GAP = 10 * 60e3, EZ_OPEN = 90e3, EZ_FIRST = 5 * 60e3, EZ_T0 = Date.now();
  let ezLastBreak = -Infinity, ezShut = 0;
  const ezNoFull = (why) => ezq((z) => z.setInterstitialAllowed(false, { reason: why }));
  ezNoFull('page-open');
  function ezBreak() {
    if (!EZ || Date.now() - ezLastBreak < EZ_GAP || Date.now() - EZ_T0 < EZ_FIRST) return;
    ezLastBreak = Date.now();
    ezq((z) => z.setInterstitialAllowed(true, { reason: 'drive-over' }));
    clearTimeout(ezShut);
    ezShut = setTimeout(() => ezNoFull('break-over'), EZ_OPEN);
  }
  function ezDrive(on) {
    if (!EZ || ezPlay === on) return;
    ezPlay = on;
    const ids = on ? [...ezShown] : [];
    ids.forEach((i) => ezShown.delete(i));
    if (on) { clearTimeout(ezShut); ezNoFull('drive-on'); }
    ezq((z) => {
      if (ids.length) z.destroyPlaceholders(...ids);       // (the cards' spots went with the cards)
      z.setOutstreamAllowed(!on, { reason: on ? 'drive-on' : 'between-drives' });
    });
  }
  function ezBox(kind) {
    const id = EZ_IDS[EZ_KINDS.indexOf(kind)];
    if (!id) return null;
    const old = document.getElementById(`ezoic-pub-ad-placeholder-${id}`);
    if (old) old.remove();                                  // (one of each id on the page)
    const box = el('div', 'adbox'), ph = el('div');
    ph.id = `ezoic-pub-ad-placeholder-${id}`;
    box.append(ph);
    const again = ezShown.has(id);
    ezShown.add(id);
    // (after the caller puts the card on the page)
    setTimeout(() => ezq((z) => { if (!ph.isConnected) return; if (again) z.destroyPlaceholders(id); z.showAds(id); }), 0);
    return box;
  }
  // An ad bar pinned to the bottom (or the top) of the screen (an anchor ad, any network's: it comes outside the game)
  // never covers the calls or the scoreboard: its height is measured and the playing screen ends short of it (--adb and
  // --adt, game.html). Players saw the anchor over the play buttons ("I can't call a play without an ad blocking the
  // options"): an ad nested in a wrapper, lifted off the edge (the home bar), or expanded taller than the old limit got
  // past the first version. Checked as the page changes (an ad arriving), on a resize, and every second and a half
  const AD_FLOOR_MAX = 340, AD_EDGE = 80;
  const adOurs = (el) => !!el.closest('#app, #play, header.top, .modal, .deep, .toast, #modal, .sheet');
  function adFloor() {
    let b = 0, t = 0;
    if (!noAds()) {
      const vh = innerHeight, vw = innerWidth;
      for (const el of document.querySelectorAll('body > *, body > * > *, body > * > * > *')) {
        if (adOurs(el)) continue;
        const cs = getComputedStyle(el);
        if ((cs.position !== 'fixed' && cs.position !== 'sticky') || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 20 || r.height > AD_FLOOR_MAX || r.width < vw * 0.5) continue;
        if (r.bottom >= vh - AD_EDGE && r.top > vh * 0.4) b = Math.max(b, Math.ceil(vh - r.top));          // (to its top: a gap under it too)
        else if (r.top <= AD_EDGE && r.bottom < vh * 0.4) t = Math.max(t, Math.ceil(r.bottom));
      }
    }
    const root = document.documentElement.style;
    if (root.getPropertyValue('--adb') !== `${b}px`) root.setProperty('--adb', `${b}px`);
    if (root.getPropertyValue('--adt') !== `${t}px`) root.setProperty('--adt', `${t}px`);
  }
  setInterval(adFloor, 1500);
  addEventListener('resize', adFloor);
  if (window.visualViewport) visualViewport.addEventListener('resize', adFloor);
  // (an ad network adds its bar to the page's top level: checked then, and again as it renders and slides in; the
  // field's own frames are never watched)
  new MutationObserver(() => [0, 300, 1000, 2500].forEach((ms) => setTimeout(adFloor, ms))).observe(document.body, { childList: true });
  function adBox(kind) {
    if (noAds()) return null;
    if (EZ && EZ_KINDS.includes(kind)) ezBreak();
    if (EZ) return ezBox(kind);
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
    adsLoad();
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
  // the day's daily, before its first snap: how many have played it so far, the typical score and the one to beat
  // (a target to chase; nothing until a few have finished, and nothing off the website or in the other modes)
  function todaySoFar() {
    const line = el('div', 'who sofar');
    line.hidden = true;
    if (SURV || PRACTICE || VS || DRIVE || RUN_N || CUSTOM || ARCH_DAY || G.si || G.started || state.done) return line;
    (BOARD.ready || Promise.resolve()).then(async () => {
      if (BOARD.mode !== 'api') return;
      const d0 = await (await fetch(`${BOARD.api}/daily?date=${driveDate()}`)).json(), d = d0 && dayFor(d0, true);    // (yours will be fair-scored)
      if (!d || !(d.n >= 3) || !Array.isArray(d.hist)) return;
      let run = 0, med = 0, hi = 0;
      d.hist.forEach((c, k) => { if (c > 0) hi = k; });
      for (let k = 0; k < d.hist.length; k++) { run += d.hist[k]; if (run >= d.n / 2) { med = k; break; } }
      const top = (d.top || [])[0], named = top && Math.round(top.p * 100) === hi;
      line.textContent = `${d.n.toLocaleString()} have played today. Typical score ${med}; the one to beat is ${hi}${named ? ` (${top.name})` : ''}.`;
      line.hidden = false;
    }).catch(() => { /* offline or the stats are down: no line */ });
    return line;
  }
  // Every call of the day graded the fair way (g: 2, decisionFrom): the post says so, and the board also counts it in
  // the day's fair set (worker.js: day.f). On the day the fair score came in (Oct 18, 2026) the scores posted before it
  // were worked out the old way and ran high; where a day has both, the fair set is the one you are compared with
  // (dayFor), with a line saying why. A result scored the old way is compared with the day's whole set, as it was, and
  // counts in no week (worker.js OLD_WAY_DAYS, the same day: the week's old says so, leaders).
  const OLD_WAY_DAYS = [7];              // (Oct 18, 2026: Super Bowl LI, down 25, where the old way paid noise)
  const fairDay = () => { const ds = allDecisions(); return ds.length > 0 && ds.every((x) => x.g === 2); };
  const mixedDay = (d) => !!(d && d.fair && d.fair.n < d.n);
  const dayFor = (d, fair) => (d.fair && d.fair.n && fair ? { ...d, n: d.fair.n, hist: d.fair.hist, spots: d.fair.spots, top: d.fair.top } : d);
  const OLD_WAY_NOTE = 'Scores posted today before the fair-score fix were worked out the old way, which let the simulation’s noise count and ran them high on this drive.';
  function dailyBox(p, spotW) {
    const box = el('div', 'board daily');
    box.hidden = true;
    if (ARCH_DAY || DRIVE || RUN_N || CUSTOM) return box;        // the archive, a historic drive, a run, a scenario: nothing to post
    const post = async () => {
      const res = await fetch(`${BOARD.api}/daily`, POST_JSON({ date: driveDate(), key: deviceKey(), p: clip(p, 0, 1), spots: spotW.map((w) => clip(w, -1, 1)),
        ...(fairDay() ? { g: 2 } : {}), ...(state.restarts ? { restarted: true } : {}),       // (restarted: off the lists, restartAsk)
        ...(sidesOf(dayN) ? { side: today[0].player } : {}),          // (a day of two sides: which, for the side's own numbers)
        ...fanPost(), ...crowdPost(),                                 // (your team: fanbases; the drive's calls: the crowd's)
        ...(myName() ? { name: myName(), ...withSession() } : {}) }));
      if (!res.ok) throw new Error(`daily ${res.status}`);
      return res.json();
    };
    let retried = false;
    const refresh = async (force) => {
      try { const d = await post(); fillDaily(box, d, p, spotW, () => refresh(true)); } catch (e) {
        if (force) toast('Could not reach today’s stats');
        else if (!retried) { retried = true; setTimeout(() => { if (box.isConnected) refresh(false); }, 5000); }   // once: a busy moment
      }
    };
    (BOARD.ready || Promise.resolve()).then(() => { if (BOARD.mode === 'api') refresh(false); });
    box.again = () => refresh(true);          // (a team picked on the end card: posted again, counted for its fans: fanAsk)
    return box;
  }
  function fillDaily(box, d0, p, spotW, again) {
    box.textContent = '';
    box.hidden = false;
    // (your first result's own set: fair-scored, the day's fair set; the old way, the whole day as it was)
    const youFair = d0.you ? d0.you.g === 2 : fairDay(), d = dayFor(d0, youFair);
    // one big number on the screen (your score against NFL play-callers); here, where you rank among today's players
    // (a restarted drive's result is off the day's numbers, worker.js: where it would rank among them, not counted in)
    const rs = !!(d.you && d.you.restarted);
    const you = d.you ? d.you.p : p, pt = Math.round(you * 100), others = d.n - (rs ? 0 : 1);
    let above = 0, ties = rs ? 0 : -1;
    d.hist.forEach((c, k) => { if (k > pt) above += c; else if (k === pt) ties += c; });
    box.append(el('div', 'k', mixedDay(d0) && youFair ? 'Everyone today, scored the fair way' : 'Everyone today'));
    // the brag: how many of today's other players you outcalled (the rank's own number, so the card has one)
    const beat = others > 0 ? Math.round((100 * Math.max(0, others - above - Math.max(ties, 0))) / others) : null;
    const fairSet = mixedDay(d0) && youFair, setW = fairSet ? 'fair-scored ' : '';
    if (rs) box.append(el('p', 'daily-head', others <= 0 ? `Restarted drive: not on today’s leaderboard. Nobody else has finished yet${fairSet ? ' scored the fair way' : ''}.`
      : `Restarted drive: not on today’s leaderboard. It would have outcalled ${beat}% of today’s ${others.toLocaleString()} ${setW}player${others === 1 ? '' : 's'}.`));
    else box.append(el('p', 'daily-head', others <= 0 ? `You’re the first to finish today${fairSet ? ' scored the fair way' : ''}. Check back later to see how you stack up.`
      : `You outcalled ${beat}% of today’s ${setW}players · #${(above + 1).toLocaleString()} of ${d.n.toLocaleString()}${ties > 0 ? ` (tied with ${ties.toLocaleString()})` : ''}`));
    if (!rs && beat != null && others >= 4 && onRank) onRank(beat, d.n);
    if (d.counted === false && d.you && Math.abs(d.you.p - p) > 0.005) box.append(el('p', 'note', `Your first finish today counts: ${Math.round(d.you.p * 100)}.`));
    if (mixedDay(d0)) box.append(el('p', 'note', `${OLD_WAY_NOTE} ${youFair ? `You’re compared with the ${d0.fair.n.toLocaleString()} scored the fair way since.` : 'Yours was too, so it’s compared with everyone who played today.'}`));
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
    box.append(leaders(d, { rank: rs ? 0 : above + 1, n: d.n, pt }));       // (restarted: no line of yours on the list)
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
  // The day's top 10 and the week's, by name (worker.js /daily: a name's first result of a day; the week, its best
  // WEEK_BEST days of the last 7 added up), two tabs; you highlighted on either, and your own rank under the list
  // when you are not on it (the day's among everyone who played, named or not; the week's among the names in it)
  const LB_TAB = `${STORE}:lbtab`;
  function leaders(d, day) {
    const wrap = el('div', 'lb'), me = myName().toLowerCase(), wk = d.week;
    const tabs = el('div', 'lbtabs'), panel = el('div', 'lbpanel');
    tabs.setAttribute('role', 'tablist');
    panel.setAttribute('role', 'tabpanel');
    const md = (iso, o) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, o || { month: 'short', day: 'numeric' });
    const span = (a, b) => `${md(a)}–${a.slice(0, 7) === b.slice(0, 7) ? md(b, { day: 'numeric' }) : md(b)}`;      // Oct 11–17, Oct 28–Nov 3
    const youRow = (rank, n, score, sub) => {
      const li = el('li', 'me you');
      li.append(el('span', 'n', ''), el('span', 'nm', `You: #${rank.toLocaleString()} of ${n.toLocaleString()}`));
      if (sub) li.append(el('small', 'd', sub));
      li.append(el('b', '', score));
      return li;
    };
    const list = (rows, mine) => {
      const ol = el('ol', 'brows');
      let onIt = false;
      rows.forEach((r, i) => {
        const it = !!me && String(r.name).toLowerCase() === me;
        onIt = onIt || it;
        const li = el('li', it ? 'me' : '');
        li.append(el('span', 'n', String(i + 1)), el('span', 'nm', String(r.name)));
        if (r.sub) li.append(el('small', 'd', r.sub));
        li.append(el('b', '', r.score));
        ol.append(li);
      });
      if (mine && !onIt) ol.append(youRow(...mine));
      return ol;
    };
    const views = {
      day: () => {
        const ol = list((d.top || []).map((r) => ({ name: r.name, score: String(Math.round(r.p * 100)) })), d.n > 0 && day.rank ? [day.rank, day.n, String(day.pt)] : null);
        if (!(d.top || []).length) panel.append(el('p', 'note', 'Nobody with a name on today’s list yet.'));
        panel.append(ol);
      },
      week: () => {
        if (!wk) { panel.append(el('p', 'note', 'The week’s list did not load. Refresh to try again.')); return; }
        panel.append(el('p', 'note lbrule', `${span(wk.from, wk.to)}: each player’s best ${wk.best} daily scores of the 7 days, added up (${wk.best * 100} is perfect). Play ${wk.best} days to max it out; a bad day never counts against you.`));
        const y = wk.you;
        panel.append(list(wk.top.map((r) => ({ name: r.name, score: String(r.pts), sub: `${r.days}d` })), y ? [y.rank, wk.n, String(y.pts), `${y.days}d`] : null));
        if (!wk.top.length) panel.append(el('p', 'note', 'Nobody on this week’s list yet.'));
        // (old: your days in the week scored the old way, on OLD_WAY_DAYS: on that day's list, in no week; worker.js listed)
        if (Array.isArray(wk.old) && wk.old.length) panel.append(el('p', 'note', `Your ${wk.old.map((x) => md(x)).join(' and ')} score was worked out the old way, before the fair-score fix, so it doesn’t count toward the week.`));
        else if (!y) panel.append(el('p', 'note', myName() ? 'Your days this week count once your name is on today’s list.' : 'Put a name on today’s list to be on the week’s.'));
      },
    };
    const tab = (k, label) => {
      const b = el('button', 'chip opt', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.k = k;
      b.addEventListener('click', () => pick(k, true));
      tabs.append(b);
      return b;
    };
    tab('day', 'Today’s top 10'); tab('week', 'This week');
    const pick = (k, user) => {
      tabs.querySelectorAll('button').forEach((b) => { const on = b.dataset.k === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      panel.textContent = '';
      views[k]();
      if (user) { save(LB_TAB, k); track('leaderboard_tab', { tab: k }); }
    };
    tabs.addEventListener('keydown', (e) => {                // arrows move between the two tabs (the tablist pattern)
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const nx = tabs.querySelector('[aria-selected="false"]');
      if (nx) { pick(nx.dataset.k, true); nx.focus(); }
    });
    pick(load(LB_TAB, 'day') === 'week' ? 'week' : 'day', false);
    wrap.append(tabs, panel);
    return wrap;
  }
  function countdown(label) {
    const w = el('div', 'countdown');
    const b = el('b', '', '');
    // (a historic drive or a playoff run stays as it is: what comes at midnight is the next daily)
    w.append(document.createTextNode(label || (DRIVE || RUN_N || CUSTOM ? 'Next daily drive in ' : today.length > 1 ? 'New spots in ' : 'Next drive in ')), b);
    const upd = () => {
      if (dayOf(new Date()) > dayN) {           // past midnight on yesterday's screen: the new drive is out
        clearInterval(tick);
        if (w.querySelector('button')) return;     // drawn once: a redraw under the finger would eat the tap
        w.textContent = '';
        const go = el('button', 'btn', 'Play today’s drive');
        // (from a past day of the archive the page is that day's: the daily is another address, its hash change reloads)
        go.addEventListener('click', () => { if (ARCH_DAY) location.hash = '#daily'; else location.reload(); });
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
    if (p.xol) { label = 'XOL'; p = { ...p, pct: null, kind: null }; }      // a jumbo snap's extra lineman: rated as a lineman isn't known here
    const ol = OL.includes(label) || label === 'T' || label === 'G';
    const top = el('div', 'pinfo');
    const ch = el('div', 'chip-big', String(p.ovr)); rateChip(ch, p.ovr);
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
    const sc = G.scen, H = teamOf(0), A = teamOf(1);        // (your quarterback as put in: Who plays)
    const dl = el('dl', 'facts');
    const add = (k, v) => dl.append(el('dt', '', k), el('dd', '', v));
    const line = sc.game.home_spread;
    add('Game', sc.custom ? matchLine(sc) : `${teamName(sc.away)} at ${teamName(sc.home)}`);
    add('Point spread', Math.abs(line) < 0.5 ? 'Pick’em' : `${teamName(line > 0 ? sc.home : sc.away)} by ${Math.abs(line).toFixed(1)}`);
    [A, H].forEach((t) => {
      add(`${teamName(t.team)}`, `${t.coach || ''}${t.qb && t.qb.name ? ` · QB ${t.qb.name}` : ''}`);
      add('Kicker', `${t.kicker.name || '—'} · rated ${t.kicker.ovr ?? '—'}`);
      add('Punter', `${t.punter.name || '—'} · rated ${t.punter.ovr ?? '—'}`);
    });
    openModal('This game', [dl, el('p', 'note', sc.custom ? `${matchLine(sc)}: each team as it lined up in a game of its season, every player rated against his position as of the end of that regular season. The point spread comes from the two teams’ strengths, as real lines do.`
      : `The players who were on the field in that game (${gameTag(sc)}), each rated against his position as of that week, and the real point spread.`)]);
  }
  // ---- the first drive's tour: a few tips that point at the real screen as it comes up (the spot, the scoreboard, the
  // call, the clock, the graded result), each once, in place of a manual up front. Never a wall: no backdrop, and a tap
  // anywhere else moves on (a tap on what a later tip points at counts that one as seen too), so a player who just
  // plays never waits on it. Daily and Survivor only (a Pro drive or Versus is no first visit); kept in storage, so a
  // reload picks up where it was and a finished or skipped tour never comes back. The full help stays on the ?.
  const TOUR_KEY = `${STORE}:tour`;
  const TOUR_OK = !(VS || VS_LOBBY || DRIVE || RUN_N || CUSTOM || CUSTOM_BUILD || COMMUNITY || ARCH || ARCH_DAY);
  const qs = (s) => document.querySelector(s);
  const TOUR = [
    // (past: below, it goes under Play, not over it; keep: what it never covers, the score and the clock it talks about)
    { id: 'spot', at: () => qs('#intro .chips'), side: 'below', past: () => qs('#intro .btn'), keep: '#intro .big, #intro .matchup', title: 'Your spot',
      text: () => `A real game situation: the real score, clock, ball and timeouts. ${SURV ? 'Win it to stay alive.' : 'Tap Play to take over.'}` },
    { id: 'bar', at: () => $('bar'), side: 'below', title: 'The scoreboard',
      text: () => 'Score, quarter and clock. The dashes under each team are its timeouts left. Tap it for the game details.' },
    { id: 'call', at: () => qs('#dock .keys.fam'), side: 'below', title: 'Your call',
      text: (a) => (a.classList.contains('def') ? 'Their ball: you call the defense. A blitz beats deep shots but loses to quick throws; a loaded box stuffs the run.'
        : 'Pick Run, Pass, RPO or Trick, then the play. Every snap is a real NFL play run against your call.') },
    { id: 'result', at: () => qs('#dock .result'), side: 'above', title: 'How it went',
      text: () => 'The big number is how the play moved your win chance. The small square grades your call, whatever happened: green is the best one, red a big miss, and a miss says what was better and why.' },
    { id: 'clock', at: () => qs('#dock .tempo'), side: 'below', title: 'The clock is running',
      text: () => 'Tempo is how much clock runs before the snap: hurry up to save it, huddle to burn it. Timeouts and spikes show up when they matter.' },
  ];
  let tour = null;              // { seen: [step ids], shown: [step ids], done } while a tour runs
  let tip = null;               // the tip on screen: { step, anchor, box, ring, back }
  let tourRaf = 0;
  function tourStart(fresh) {
    if (!TOUR_OK) return;
    const t = fresh ? { seen: [], shown: [], done: false } : load(TOUR_KEY, null);
    if (!t || t.done) return;
    tour = { seen: t.seen || [], shown: t.shown || [], done: false };
    tourSave();
    // what moves the tour along: the screens it points at changing (the dock's calls and results, the intro, a sheet
    // opening over them, a play's animation), a click, a scroll (the scoreboard sticks to the top) and the window's size
    tour.mo = new MutationObserver(tourSoon);
    ['dock', 'intro'].forEach((id) => tour.mo.observe($(id), { childList: true }));
    ['intro', 'play', 'done', 'modal', 'deep'].forEach((id) => tour.mo.observe($(id), { attributes: true, attributeFilter: ['hidden'] }));
    tour.mo.observe($('field'), { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', tourTap, true);
    addEventListener('scroll', tourSoon, { passive: true });
    addEventListener('resize', tourSoon);
    // and what moves under a tip without any of those: the intro settling as its fonts load (the first tip was left
    // over the spot's facts it pointed at, its ring over Play)
    if (window.ResizeObserver) { tour.ro = new ResizeObserver(tourSoon); ['intro', 'dock'].forEach((id) => tour.ro.observe($(id))); }
    tourSoon();
  }
  function tourSoon() { if (tour && !tourRaf) tourRaf = requestAnimationFrame(() => { tourRaf = 0; tourTick(); }); }
  function tourSave() { save(TOUR_KEY, { seen: tour.seen, shown: tour.shown, done: tour.done }); }
  const shownEl = (a) => !!a && a.isConnected && a.getClientRects().length > 0;
  function tourTick() {
    if (!tour) return;
    if (!$('done').hidden) return tourEnd('onboard_done');       // the drive is over: whatever it never came to stays unsaid
    // a sheet over the game or a play running: the tip waits, unseen
    const away = !$('modal').hidden || !$('deep').hidden || $('field').classList.contains('playing');
    if (tip) {
      const a = tip.step.at();
      if (!away && shownEl(a)) { tip.anchor = a; return tipPlace(); }
      tipHide();                                                  // its screen redrew or went: back when it is up again
    }
    if (away) return;
    const step = TOUR.find((s) => !tour.seen.includes(s.id) && shownEl(s.at()));
    if (step) tipShow(step);
  }
  function tipShow(step) {
    const a = step.at(), n = (tour.shown.includes(step.id) ? tour.shown.indexOf(step.id) : tour.shown.length) + 1;     // in the order they come up
    const box = el('div', 'tip'), ring = el('div', 'tipring');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-labelledby', 'tipT'); box.setAttribute('aria-describedby', 'tipX');
    const h = el('div', 'tiph'), t = el('b', '', step.title);
    t.id = 'tipT';
    h.append(t, el('span', 'n', `${n} of ${TOUR.length}`));
    const p = el('p', '', step.text(a)); p.id = 'tipX';
    const acts = el('div', 'tipacts');
    const skip = el('button', 'tipskip', 'Skip tour'), ok = el('button', 'tipok', 'Got it');
    skip.type = ok.type = 'button';
    skip.addEventListener('click', () => { track('onboard_skip', { step: step.id, n }); tourEnd(null); });
    ok.addEventListener('click', tipDone);
    acts.append(skip, ok);
    box.append(el('i', 'tiparrow'), h, p, acts);
    ring.setAttribute('aria-hidden', 'true');
    document.body.append(ring, box);
    const back = document.activeElement;
    tip = { step, anchor: a, box, ring, back: back && back !== document.body ? back : null };
    // the first time it is up (a tip back after a sheet closed, or after a reload, is not a new step)
    if (!tour.shown.includes(step.id)) { tour.shown.push(step.id); tourSave(); track('onboard_step', { step: step.id, n }); }
    tipPlace();
    tipReveal();
    ok.focus({ preventScroll: true });               // a screen reader hears the tip; Got it or Escape closes it
  }
  // where a tip goes: beside what it points at (below or above, as the step prefers, else to its left or right on a wide
  // screen), never over a button the player may want next (the dock's, the intro's Next, the scoreboard) and never
  // under the top bar; of the places that cover none, one already on screen; else the one that covers least. In the
  // page's own coordinates, so a scroll carries it along; it keeps its side while that side stays clear.
  const visTop = (anchor) => Math.max((qs('.top') || { offsetHeight: 0 }).offsetHeight,
    !$('play').hidden && anchor !== $('bar') ? $('bar').getBoundingClientRect().bottom : 0);
  function tipPlace() {
    const { box, ring, anchor, step } = tip, r = anchor.getBoundingClientRect(), sx = scrollX, sy = scrollY;
    const vw = document.documentElement.clientWidth, w = Math.min(320, vw - 24), gap = 12;
    box.style.width = `${w}px`;
    const h = box.offsetHeight, topH = (qs('.top') || { offsetHeight: 0 }).offsetHeight, vt = visTop(anchor);
    const cx = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - 12 - w), cy = Math.max(vt + 8, r.top);
    const pb = step.past && step.past(), below = pb && pb.getClientRects().length ? Math.max(r.bottom, pb.getBoundingClientRect().bottom) : r.bottom;
    const at = { below: [cx, below + gap], above: [cx, r.top - gap - h], left: [r.left - gap - w, cy], right: [r.right + gap, cy] };
    const clear = [...document.querySelectorAll(`#dock button, #intro .btn, #bar${step.keep ? `, ${step.keep}` : ''}`)].filter((b) => b !== anchor && !anchor.contains(b))
      .map((b) => b.getBoundingClientRect()).filter((b) => b.width);
    const cost = ([x, y]) => clear.reduce((a, b) => a + Math.max(0, Math.min(x + w, b.right) - Math.max(x, b.left)) * Math.max(0, Math.min(y + h, b.bottom) - Math.max(y, b.top)), 0);
    const ok = ([x, y]) => x >= 8 && x + w <= vw - 8 && y + sy >= topH;
    const off = ([, y]) => y < vt || y + h > innerHeight;
    let side = tip.side && ok(at[tip.side]) && !cost(at[tip.side]) ? tip.side : null;
    if (!side) {
      const order = [step.side, step.side === 'below' ? 'above' : 'below', 'left', 'right'].filter((k) => ok(at[k]));
      const score = (k) => { const c = cost(at[k]); return c ? 1e9 + c : off(at[k]) ? 1 : 0; };
      side = order.reduce((a, k) => (a == null || score(k) < score(a) ? k : a), null) || step.side;
    }
    tip.side = side;
    const [x, y] = at[side];
    box.style.left = `${x + sx}px`;
    box.style.top = `${y + sy}px`;
    box.dataset.side = side;
    box.style.setProperty('--ax', `${Math.min(Math.max(18, r.left + r.width / 2 - x), w - 18)}px`);
    box.style.setProperty('--ay', `${Math.min(Math.max(18, r.top + Math.min(r.height / 2, 28) - y), h - 18)}px`);
    Object.assign(ring.style, { left: `${r.left + sx - 4}px`, top: `${r.top + sy - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  }
  // a new tip and what it points at, both in view (the least scroll that does it; the top stays in view first)
  function tipReveal() {
    const a = tip.anchor.getBoundingClientRect(), b = tip.box.getBoundingClientRect(), vt = visTop(tip.anchor);
    const top = Math.min(a.top, b.top), bot = Math.max(a.bottom, b.bottom);
    const dy = top < vt + 8 ? top - vt - 8 : bot > innerHeight - 8 ? Math.min(bot - innerHeight + 16, top - vt - 8) : 0;
    if (Math.abs(dy) > 2) scrollBy({ top: dy, behavior: reduced() ? 'auto' : 'smooth' });
  }
  function tipHide() {
    if (!tip) return;
    const { box, ring, back, anchor } = tip, had = box.contains(document.activeElement);
    tip = null;
    box.remove(); ring.remove();
    // focus back where it was, or on what the tip pointed at (not lost to the top of the page)
    const to = had && ((back && back.isConnected && back) || (anchor.matches('button') ? anchor : anchor.querySelector('button')));
    if (to && to.isConnected) to.focus({ preventScroll: true });
  }
  function tipDone() {
    if (!tip || !tour) return;
    if (!tour.seen.includes(tip.step.id)) tour.seen.push(tip.step.id);
    tipHide();
    if (TOUR.every((s) => tour.seen.includes(s.id))) return tourEnd('onboard_done');
    tourSave();
    tourSoon();
  }
  // a tap (or a key's click) anywhere but the tip: the player has moved on, so the tip has been seen; a tap on what a
  // later tip points at (a call tapped while the scoreboard's tip is up) is that one seen too. A click, not a touch: a
  // finger scrolling the page leaves the tip up
  function tourTap(e) {
    if (!tour || (tip && tip.box.contains(e.target))) return;
    TOUR.forEach((s) => { const a = s.at(); if (!tour.seen.includes(s.id) && shownEl(a) && a.contains(e.target)) tour.seen.push(s.id); });
    if (tip) tipDone(); else tourSave();
  }
  function tourEnd(event) {
    if (!tour) return;
    tipHide();
    if (event) track(event, { seen: tour.seen.length });
    tour.done = true;
    tourSave();
    tour.mo.disconnect();
    if (tour.ro) tour.ro.disconnect();
    document.removeEventListener('click', tourTap, true);
    removeEventListener('scroll', tourSoon);
    removeEventListener('resize', tourSoon);
    tour = null;
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
      'Pick Run, Pass, RPO or Trick. On a pass, tap a receiver on the field to change his route, then pick who gets the ball and tap Snap.',
      'Every snap is a real NFL play. Read the defense: a blitz loses to quick throws, a loaded box to play action.',
      SURV ? 'Survivor: win each real game to keep going. One loss ends your run; put your name on the board.'
        : 'Beat the real coach, and see how you rank against everyone who played today.',
      ...(TOUCH ? [] : ['On a keyboard: 1 to 4 make the big calls, Tab and Enter the rest, Space skips a play.']),
    ].forEach((t) => ul.append(el('li', '', t)));
    const more = el('details', 'more');
    more.append(el('summary', '', 'More about the game'));
    const ul2 = el('ul');
    [
      'You\'re the head coach for the last minutes of a real NFL game. A new drive every day.',
      'Call Run, Pass or RPO. On a pass, every receiver shows his route: tap any of them on the field to change it, then pick who gets the ball, with play action or a rollout if you like. Timeouts, spikes, kicks and tempo pop up when they matter. On their ball, you call the defense, and when they line up to kick, you choose to go for the block or play it safe.',
      'Every snap is a real NFL play run against your call. Tap the field to skip, or a player to see who he is.',
      'Matchups matter, as measured on the real plays: a blitz beats deep shots but loses to quick passes and screens; a loaded box stuffs runs but gets beaten by screens and play action; playing soft (no blitz, seven in coverage) takes away quick passes and screens but gives up runs. Read their look before you call, and when you call the defense, they will check into what beats it.',
      'Beat the real coach\'s result, and find out which NFL coach you call it like.',
      'Survivor: random real fourth quarters back to back. Win to keep going; lose once and your run is over. Tied at the end, you play overtime: both teams get the ball, then the next score wins.',
      `Your streak: every ${FREEZE_EVERY} days in a row earn a streak freeze (you can hold ${FREEZE_MAX}). Miss a day and a freeze covers it when you play the next one. Badges for the milestones are in your stats.`,
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
  function openStats(focus) {
    track('stats_open');
    const st = load(`${STORE}:stats`, { days: {} });
    // (the day numbers need game.json: tapped while it loads, or after it failed, the record without the streak's
    // calendar and the badges' check, not an exception and no sheet)
    if (idx && badgeAward(st, null).length) { save(`${STORE}:stats`, st); statsSync(true); }      // (a record from before the badges: earned now)
    const days = Object.keys(st.days).map(Number).sort((a, b) => a - b);
    const sk = idx ? streakOf(st, dayOf(new Date())) : null, streak = sk ? sk.n : 0;
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
    const nodes = [row, ...(sk ? [streakCal(st, sk)] : []), el('p', 'note', 'Daily percentile against NFL play-callers'), dist];
    const coaches = days.map((k) => st.days[k].coach).filter(Boolean);
    if (coaches.length) {
      const top = Object.entries(coaches.reduce((a, c) => ({ ...a, [c]: (a[c] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
      nodes.push(el('p', '', `You coach most like ${top[0]} (${top[1]} day${top[1] === 1 ? '' : 's'}).`));
    }
    const bd = badgesEl(st);
    nodes.push(bd);
    const te = tendEl();
    if (te) nodes.push(te);
    const sv = survStats();
    if (sv.runs) nodes.push(el('p', '', `Survivor: best run ${sv.best} win${sv.best === 1 ? '' : 's'} (${sv.runs} run${sv.runs === 1 ? '' : 's'}).`));
    const fe = fansEl();
    nodes.push(fe, boardEl());
    openModal('Your stats', nodes);
    if (focus === 'badges') bd.scrollIntoView({ block: 'start' });
    if (focus === 'fans') fe.scrollIntoView({ block: 'start' });
  }

  // one drive a day: the schedule holds three spots a day (a two-minute drill, protecting a lead, a tied game or
  // the end of a half); the day's drive is one of them, the kind rotating from day to day; a featured day plays a
  // famous spot (with its story on the intro) instead of the scheduled one
  function dayIds(n) {
    const row = idx.schedule[(n - 1) % idx.schedule.length], kinds = Object.keys(idx.categories);
    const want = kinds[(n - 1) % kinds.length], feat = featOf(n);
    return feat ? [feat.spot] : [row.find((i) => idx.spots[i].category === want) ?? row[(n - 1) % row.length]];
  }
  // Pick your side: a featured day can offer two takeovers of one real game (daily_schedule.json sides, each a spot):
  // the player takes one, and it is the day's drive (one result a day as ever, scored the same). The pick is kept on
  // the device (SIDE_KEY), in the day's state and its stats day (side: the team, synced), so a reload, a restart or
  // another phone signed in keeps it. featOf: the day's featured entry as played (the side taken; before a pick, the first)
  const sidesOf = (n) => { const f = idx.featured && idx.featured[n]; return f && Array.isArray(f.sides) && f.sides.length > 1 ? f.sides : null; };
  const SIDE_KEY = (n) => `${STORE}:side:${n}`;
  function sideOf(n) {
    const ss = sidesOf(n);
    if (!ss) return null;
    const ok = (k) => Number.isInteger(k) && k >= 0 && k < ss.length;
    const k = load(SIDE_KEY(n), null), st = load(`${STORE}:day:${n}`, null), rec = (load(`${STORE}:stats`, { days: {} }).days || {})[n];
    if (ok(k)) return k;
    if (st && ok(st.side)) return st.side;
    const j = rec && rec.side ? ss.findIndex((x) => idx.spots[x.spot].player === rec.side) : -1;
    return j >= 0 ? j : null;
  }
  function featOf(n) {
    const f = idx.featured && idx.featured[n], ss = sidesOf(n);
    if (!ss) return f || null;
    const k = sideOf(n) ?? 0;
    return { ...f, spot: ss[k].spot, note: ss[k].note || f.note, side: k };
  }
  // a side's takeover in a line: "2:48, own 14, 2 timeouts each" / "0:47, own 35, no timeouts (they have 2)"
  function sideLine(sp) {
    const s0 = sp.start, me = sp.player === sp.home ? 1 : 0, c = Math.ceil(s0.clock);
    const yl = Math.round(s0.yl), at = yl === 50 ? 'midfield' : yl > 50 ? `own ${100 - yl}` : `opp ${yl}`;
    const a = s0.to[me], b = s0.to[1 - me], tos = (x) => (x ? `${x} timeout${x === 1 ? '' : 's'}` : 'no timeouts');
    return `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}, ${at}, ${a === b ? `${a || 'no'} timeout${a === 1 ? '' : 's'} each` : `${tos(a)} (they have ${b})`}`;
  }
  const sideLead = (sp) => { const me = sp.player === sp.home ? 1 : 0, d = sp.start.score[me] - sp.start.score[1 - me]; return d > 0 ? `Up by ${d}` : d < 0 ? `Down by ${-d}` : 'Tied'; };
  // a side's button: the team's colors, the takeover, the score; tapped, the pick is kept and go(k) runs
  function sideBtn(n, k, go, tag = 'button') {
    const sp = idx.spots[sidesOf(n)[k].spot], b = el(tag, `sidepick${darkOn(color(sp.player)) ? ' dk' : ''}`);
    if (tag === 'button') b.type = 'button'; else b.href = '#daily';
    b.style.setProperty('--tc', color(sp.player));
    b.dataset.side = String(k);
    b.append(el('b', '', `Take over as ${teamName(sp.player)}`), el('span', '', sideLine(sp)), el('small', '', `${sideLead(sp)} · ${sp.start.qtr === 4 ? '4th quarter' : `Q${sp.start.qtr}`}`));
    b.addEventListener('click', (e) => { save(SIDE_KEY(n), k); track('side_pick', { day: n, side: sp.player }); go(k, e); });
    return b;
  }
  // the day's intro before the pick: the game, its story and the two takeovers (resolves with the side taken)
  function renderSidePick(n) {
    return new Promise((done) => {
      const ss = sidesOf(n), sp = idx.spots[ss[0].spot], f = idx.featured[n], box = $('intro');
      box.textContent = '';
      show('intro');
      box.append(el('div', 'cat', `${ARCH_DAY ? `No. ${n}, from the archive` : 'Today’s drive'} · Pick your side`),
        ...(f.title ? [el('h2', 'title', f.title)] : []), el('div', 'game', `${gameTag(sp)} · ${matchLine(sp)}`));
      const row = el('div', 'sidepicks');
      ss.forEach((_, k) => row.append(sideBtn(n, k, (j) => done(j))));
      box.append(row, el('div', 'who', 'One drive today: pick a side and call it to the final gun. Your pick is your day’s drive.'));
      if (f.note) box.append(el('p', 'story', f.note));
    });
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
  // Pro is ad-free: confirmed Pro marks the phone (NOADS_KEY: the page's head then never loads the ad script, site.py
  // EZOIC_HEAD) and takes this page's ads away now; Pro confirmed gone clears the mark (offline: left as it was)
  const NOADS_KEY = `${STORE}:noads`;
  const noAds = () => isPro() || document.documentElement.classList.contains('noads');
  function noAdsSync() {
    if (PRO_LIVE === null) return;
    const on = PRO_LIVE === true;
    try { if (on) localStorage.setItem(NOADS_KEY, '1'); else localStorage.removeItem(NOADS_KEY); } catch (e) { /* no storage */ }
    if (!on) return;
    document.documentElement.classList.add('noads');
    ezq((z) => { z.setInterstitialAllowed(false, { reason: 'pro' }); z.setOutstreamAllowed(false, { reason: 'pro' }); });
  }
  async function proVerify() { await proCheck(); noAdsSync(); }
  async function proCheck() {
    if (!PRO_ON) { PRO_LIVE = false; return; }
    if (authSession() && BOARD.api) {
      try {
        const r = await fetch(`${BOARD.api}/auth/me`, POST_JSON({ session: authSession() }));
        if (r.ok) {
          ACCT.me = acctOf(await r.json());
          if (ACCT.me.pro) { PRO_LIVE = true; return; }
        } else if (r.status === 401 || r.status === 503) authLost();
        else if (!proCode()) { PRO_LIVE = null; return; }
      } catch (e) { if (!proCode()) { PRO_LIVE = null; return; } }
    }
    const code = proCode();
    if (!code) { PRO_LIVE = false; return; }
    if (!BOARD.api) { PRO_LIVE = null; return; }
    try {
      const r = await fetch(`${BOARD.api}/restore`, POST_JSON({ code, key: deviceKey() }));
      if (r.ok) { PRO_LIVE = true; return; }
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
    const q = new URLSearchParams(location.search), s = q.get('claim'), again = q.get('r') === '1';     // r=1: the link in a lost-code email (/recover), not a new purchase
    if (!s && !q.has('pro')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (!s || !PRO_BUILT) return;                // (a purchase is claimed whenever it comes back, launched or not)
    try {
      const d = await proApi('/claim', { s, key: deviceKey() });
      save(PRO_KEY, { code: d.code, at: Date.now() });
      PRO_LIVE = true;
      if (again) { track('pro_recovered'); toast('Pro restored'); if (location.hash === '#archive') location.reload(); else location.hash = '#archive'; return; }
      track('pro_unlocked');
      track('purchase', { currency: 'USD', value: 4.99, transaction_id: d.code, items: [{ item_id: 'pro', item_name: 'Two-Minute Drill Pro', price: 4.99, quantity: 1 }] });
      toast('Pro unlocked');
      // (Stripe sends the buyer back to the front page, the day's drive under this card: the way on to Pro is on it)
      const go = el('a', 'btn', 'Open Pro');
      go.href = '#archive';
      go.addEventListener('click', () => { if (ARCH) closeModal(); });
      openModal('Pro unlocked', [proCodeCard(true), go]);
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
  // A friend's challenge: the daily's share link carries the day, the score and the sharer's name (?ch=7-72-Mike). Kept
  // here for that day: its intro says the score to beat, its end card who won. Nothing is checked: it's between friends.
  const CH_RE = /^(\d{1,4})-(\d{1,3})(?:-(.{1,24}))?$/;
  const chLink = (p) => `${SITE}/?ch=${encodeURIComponent(`${dayN}-${Math.round(p * 100)}${myName() ? `-${myName()}` : ''}`)}`;
  const chFor = (n) => { const c = load(`${STORE}:ch:${n}`, null); return c && c.s >= 0 && c.s <= 100 ? c : null; };
  function challengeFromUrl() {
    const q = new URLSearchParams(location.search), raw = q.get('ch');
    if (raw == null) return;
    q.delete('ch');
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    const m = CH_RE.exec(raw.trim());
    if (!m || +m[2] > 100) return;
    const name = String(m[3] || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    save(`${STORE}:ch:${+m[1]}`, { s: +m[2], name });
    track('challenge_open', { day: +m[1] });
  }
  const chName = (c) => c.name || 'Your friend';
  function challengeLine() {
    const c = !SURV && !PRACTICE && !VS && !DRIVE && !RUN_N && !CUSTOM && !G.si && !state.done ? chFor(dayN) : null;
    return c ? el('div', 'who chal', `\ud83c\udfaf ${chName(c)} scored ${c.s} on ${todayDaily() ? 'today’s drive' : 'this drive'} \u2014 beat that`) : null;
  }
  function challengeCard(p) {
    const c = chFor(dayN);
    if (!c || DRIVE || RUN_N || CUSTOM || cFor(dayN)) return null;          // (a real challenge's card is its board: chEnd)
    const me = Math.round(p * 100), v = el('div', 'h2h-day chal');
    v.append(el('span', 'k', `You vs ${chName(c)}`), el('b', '', me > c.s ? 'You win' : me < c.s ? `${chName(c)} wins` : 'Tied'),
      el('span', 'sub', `${me}\u2013${c.s}. Send it back: your share link challenges them.`));
    return v;
  }
  // A real challenge (?c=<id>, board/worker.js /challenge): the daily's end card makes one ("Challenge a friend", and
  // the share text's link, once made: chMine, mych:<day> { id, s }, one a day reused), and its board holds the
  // challenger and everyone who played from the link (names and scores only). Opened (challengeOpen), it is kept for
  // its day (c:<day> { id, name, s }, and ch:<day> as the old link's: the intro's score to beat): today's daily plays as
  // ever; a past day plays from the archive with Pro (#day-N), and without Pro the link shows the challenger's result
  // and the Pro pitch (renderChallengePitch). The day's finish goes to the challenge once a device (cplay:<id>; a
  // restarted try says so and is not counted) and the end card shows its board (chEnd); your own challenge's board
  // shows there once someone has played it. The old ?ch= link (above) keeps working; nothing about it is checked.
  const C_RE = /^[a-hjkmnp-z2-9]{7}$/, cLink = (id) => `${SITE}/?c=${id}`;
  const cFor = (n) => { const c = load(`${STORE}:c:${n}`, null); return c && C_RE.test(c.id || '') ? c : null; };
  async function challengeOpen(now) {
    const q = new URLSearchParams(location.search), id = String(q.get('c') || '').trim().toLowerCase();
    if (!q.has('c')) return null;
    q.delete('c');
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    if (!C_RE.test(id)) { toast('That challenge link doesn’t work.'); return null; }
    await BOARD.ready;
    if (BOARD.mode !== 'api') return null;
    let d;
    try {
      const r = await fetch(`${BOARD.api}/challenge/${id}`, { cache: 'no-store' });
      d = await r.json();
      if (!r.ok) throw new Error(d.error || `challenge ${r.status}`);
    } catch (e) { toast(e.message || 'That challenge did not load'); return null; }
    const today = dayOf(now);
    if (!(Number.isInteger(d.day) && d.day >= 1 && d.day <= today)) return null;      // (a day not out yet: a clock far off)
    track('challenge_open', { day: d.day, link: 'c', past: d.day < today });
    const mine = load(`${STORE}:mych:${d.day}`, null);
    if (!(mine && mine.id === id)) {          // (your own link: no score of yours to beat)
      save(`${STORE}:c:${d.day}`, { id, name: d.name || '', s: d.score });
      save(`${STORE}:ch:${d.day}`, { s: d.score, name: d.name || '' });
    }
    if (d.day === today) return 'today';
    if (isPro()) { location.hash = `#day-${d.day}`; return 'stop'; }          // (the hash change reloads into the archive's day)
    renderChallengePitch(d);
    return 'stop';
  }
  // a past day's challenge without Pro: who scored what, the board so far, and the Pro pitch (today's drive is free)
  function renderChallengePitch(d) {
    show('arch');
    track('challenge_pitch', { day: d.day });
    const box = $('arch');
    box.textContent = '';
    const when = dayDate(d.day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const go = el('a', 'btn', 'Play today’s drive');
    go.href = '#daily';
    box.append(el('h2', '', 'A challenge'), el('p', 'lead chlead', `🎯 ${chName({ name: d.name })} scored ${d.score} on the drive of ${when} — beat that.`),
      chBoardEl(d), el('p', 'note', 'That drive is in the archive: every past daily, part of Pro. Today’s drive is free.'), go, ...proNodes(), authNodes());
  }
  // a challenge's board: the challenger (🎯) and everyone who played from the link, best first, names only; you
  // ({ s, name } your result, or { ch: true }: your own challenge) marked
  function chBoardEl(d, you) {
    const w = el('div', 'chboard');
    w.append(el('div', 'k', `${chName({ name: d.name })}’s challenge · ${d.n ? `${d.n.toLocaleString()} played from the link` : 'nobody else yet'}`));
    const ol = el('ol', 'brows');
    let marked = false;
    (d.rows || []).forEach((r, i) => {
      const it = !marked && !!you && (you.ch ? !!r.ch : !r.ch && r.score === you.s && (r.name || '') === (you.name || ''));
      marked = marked || it;
      const li = el('li', it ? 'me' : '');
      li.append(el('span', 'n', String(i + 1)), el('span', 'nm', `${r.ch ? '🎯 ' : ''}${r.name || (r.ch ? 'Your friend' : 'Someone')}${it ? ' (you)' : ''}`), el('b', '', String(r.score)));
      ol.append(li);
    });
    w.append(ol);
    return w;
  }
  let chMineQ = null;
  function chMine(p) {
    const have = load(`${STORE}:mych:${dayN}`, null);
    if (have && C_RE.test(have.id || '')) return Promise.resolve(have.id);
    if (!chMineQ) {
      chMineQ = (async () => {
        await BOARD.ready;
        if (BOARD.mode !== 'api') return null;
        const s = Math.round(p * 100), r = await fetch(`${BOARD.api}/challenge`, POST_JSON({ day: dayN, score: s, key: deviceKey(), ...(myName() ? { name: myName(), ...withSession() } : {}) }));
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !C_RE.test(d.id || '')) return null;           // (a name refused, a busy minute: the old link)
        save(`${STORE}:mych:${dayN}`, { id: d.id, s });
        track('challenge_create', { day: dayN });
        return d.id;
      })().catch(() => null).finally(() => { chMineQ = null; });
    }
    return chMineQ;
  }
  // the end card's challenge (before `at`): a link's gets this finish and shows its board and who won; else your own,
  // once someone has played it
  function chEnd(box, p, at) {
    if (DRIVE || RUN_N || CUSTOM || PRACTICE || SURV) return;
    const c = cFor(dayN), mine = load(`${STORE}:mych:${dayN}`, null), me = Math.round(p * 100), slot = el('div', 'chslot');
    if (!c && !mine) return;
    slot.hidden = true;
    box.insertBefore(slot, at || null);
    (BOARD.ready || Promise.resolve()).then(async () => {
      if (BOARD.mode !== 'api') return;
      if (c && !(mine && mine.id === c.id)) {
        const done = load(`${STORE}:cplay:${c.id}`, null);
        const r = done ? await fetch(`${BOARD.api}/challenge/${c.id}`, { cache: 'no-store' })
          : await fetch(`${BOARD.api}/challenge/${c.id}/play`, POST_JSON({ score: me, key: deviceKey(), ...(myName() ? { name: myName(), ...withSession() } : {}), ...(state.restarts ? { restarted: true } : {}) }));
        const d = await r.json();
        if (!r.ok) return;
        if (!done) save(`${STORE}:cplay:${c.id}`, { s: me, at: Date.now(), ...(d.counted ? {} : { out: true }) });
        const s = done ? done.s : me, v = el('div', 'h2h-day chal');
        v.append(el('span', 'k', `You vs ${chName(c)}`), el('b', '', s > d.score ? 'You win' : s < d.score ? `${chName(c)} wins` : 'Tied'), el('span', 'sub', `${s}–${d.score}`));
        slot.append(v, chBoardEl(d, (done ? done.out : !d.counted) ? null : { s, name: d.taken ? '' : myName() }));
        if (done ? done.out : !d.counted) slot.append(el('p', 'note', state.restarts ? 'Restarted: this try isn’t on the challenge’s board.' : 'Your first try from this link is the one on its board.'));
      } else if (mine) {
        const r = await fetch(`${BOARD.api}/challenge/${mine.id}`, { cache: 'no-store' }), d = await r.json();
        if (!r.ok || !d.n) return;
        slot.append(chBoardEl(d, { ch: true }));
      } else return;
      slot.hidden = false;
    }).catch(() => { /* offline: no board */ });
  }

  // ---- The crowd's calls (board/worker.js /calls): after each call, the share of the day's players who made the same
  // call in the same situation, once at least CROWD_MIN of them got there (else nothing). A situation is the day and a
  // coarse key of the spot (crowdKey, kept with each graded decision as ck), its buckets wide so that players meet:
  //   the kind of decision (the call, the tempo before the snap, the defense, a timeout, the try, a kick: x.kind)
  //   the down (0 on a two-point try); the distance: 1, 2-3, 4-6, 7-10, 11+ (a-e)
  //   the yard line, yards to the goal: 1-5, 6-20, 21-40, 41-60, 61-80, 81-99 (a-f)
  //   the clock: the half (a the first, b the second, o overtime) and the time left in it: up to 0:30, 1:00, 2:00, 4:00,
  //   8:00, more (0-5)
  //   the margin, your lead: -9 or worse, -8 to -4, -3 to -1, tied, 1 to 3, 4 to 8, 9 or more (a-g)
  // e.g. call.3.d.c.b2.c: a call on 3rd & 7-10 from the 21-40, 1:00-2:00 left in the second half, down 1 to 3. Every
  // drive of the day starts at the same snap, so the first calls always meet; the buckets keep the later ones meeting.
  // The day's /daily post carries the drive's [ck, call] (crowdPost; worker.js counts a situation once a device, its
  // first call there, and never a restarted try). The counts (GET /calls, at most every CROWD_MS) are asked for as a
  // call comes up and as it is snapped, so they are in by its result card, and never waited on: a call goes as ever (a
  // card already gone when they land gets no line). The finished drive's
  // Uniqueness (crowdSum): 100 less the average share of your calls that had counts, a line in the breakdown; in the
  // share text only when one of them was rare (CROWD_RARE or under: "Won it with a 4% call on 3rd & 7").
  const CROWD_MIN = 20, CROWD_MS = 3 * 60e3, CROWD_RARE = 0.1;
  const crowdOn = () => !(SURV || PRACTICE || VS || DRIVE || RUN_N || CUSTOM);
  const bucketOf = (x, cuts) => 'abcdefg'[cuts.filter((c) => x > c).length];
  function crowdKey(r, kind) {
    const th = halfLeft(r.t), lead = r.score[G.me] - r.score[1 - G.me];
    const clk = r.ot ? 'o0' : `${r.t > 1800 ? 'a' : 'b'}${[30, 60, 120, 240, 480].filter((c) => th > c).length}`;
    return [String(kind).replace(/[^a-z]/g, '').slice(0, 8).padEnd(2, 'x'), r.try2 ? 0 : clip(Math.round(r.down) || 0, 0, 4), bucketOf(Math.round(r.ytg), [1, 3, 6, 10]),
      bucketOf(Math.round(r.yl), [5, 20, 40, 60, 80]), clk, bucketOf(lead, [-9, -4, -1, 0, 3, 8])].join('.');
  }
  // the call as the crowd counts it: the play called (a pass to any receiver, out of bounds or not: the same call)
  const crowdCall = (x) => String(x.chosenCall || x.chosen).replace('+oob', '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  const crowdLabel = (x) => (x.chosenCall && CALL[x.chosenCall] ? CALL[x.chosenCall].label : x.chosenLabel);
  const crowdPost = () => {
    const cs = state.restarts ? [] : allDecisions().filter((x) => x.ck).map((x) => [x.ck, crowdCall(x)]);
    return cs.length ? { calls: cs.slice(0, 80) } : {};
  };
  let crowdQ = null;
  function crowdCounts() {
    if (!crowdQ || Date.now() - crowdQ.at > CROWD_MS) {
      const q = { at: Date.now() };
      q.p = (BOARD.ready || Promise.resolve()).then(async () => {
        if (BOARD.mode !== 'api') return null;
        const r = await fetch(`${BOARD.api}/calls?date=${driveDate()}`, { cache: 'no-store' });
        return r.ok ? (await r.json()).s || {} : null;
      }).catch(() => { if (crowdQ === q) crowdQ = null; return null; });
      crowdQ = q;
    }
    return crowdQ.p;
  }
  // the share of the day's players (s: the counts) who made x's call where x was made, or null (too few got there)
  function crowdOf(s, x) {
    const c = x && x.ck && s ? s[x.ck] : null;
    return c && c.n >= CROWD_MIN && c.c ? { share: (c.c[crowdCall(x)] || 0) / c.n, n: c.n } : null;
  }
  const crowdPct = (f) => (f > 0 && f < 0.005 ? '<1' : String(Math.round(f * 100)));
  const crowdWho = () => (ARCH_DAY ? 'that day’s' : 'today’s');
  // the result card's line, under the grade (v), when the counts are in
  function crowdLine(v, decisions) {
    if (!crowdOn() || !decisions.some((x) => x.ck)) return;
    crowdCounts().then((s) => {          // (in by the result card, mostly: asked for as the play was snapped)
      const x = decisions.find((y) => y.kind === 'call' && crowdOf(s, y)) || decisions.find((y) => crowdOf(s, y)), c = x && crowdOf(s, x);
      if (!c || !v.parentNode) return;          // (a card between docks, a moment off the page: the line goes on it all the same)
      v.after(el('div', 'crowd', c.share > 0 ? `👥 ${crowdPct(c.share)}% of ${crowdWho()} ${c.n.toLocaleString()} players here called ${crowdLabel(x)}`
        : `👥 None of ${crowdWho()} ${c.n.toLocaleString()} players here called ${crowdLabel(x)}`));
      if (v.isConnected) fitDock(fitKeys);
    });
  }
  // the drive's Uniqueness: 100 less the average share of your calls that had counts, and the rarest of them
  function crowdSum(s, decs) {
    const had = decs.map((x) => ({ x, c: crowdOf(s, x) })).filter((y) => y.c);
    if (!had.length) return null;
    const avg = had.reduce((a, y) => a + y.c.share, 0) / had.length;
    return { u: Math.round(100 * (1 - avg)), n: had.length, avg, rare: had.reduce((a, y) => (y.c.share < a.c.share ? y : a)) };
  }
  function crowdEnd(box, decs, share, pre, won) {
    if (!crowdOn() || !decs.some((x) => x.ck)) return;
    crowdCounts().then((s) => {
      const u = crowdSum(s, decs), inn = box.querySelector(':scope > .endmore > .in');
      if (!u || !box.isConnected) return;
      const line = el('p', 'crowdsum');
      line.append(el('b', '', `👥 Uniqueness ${u.u}`), document.createTextNode(` · ${crowdPct(u.avg)}% of ${crowdWho()} players made your call, on average (${u.n} call${u.n === 1 ? '' : 's'} with ${CROWD_MIN}+ players to compare)`));
      if (inn) inn.prepend(line); else box.append(line);
      if (u.rare.c.share > CROWD_RARE || share.crowd) return;
      const dd = ((u.rare.x.situation || '').match(/\b[1-4](?:st|nd|rd|th) & (?:Goal|\d+)/) || [])[0];
      share.crowd = `${won ? 'Won it with' : 'Made'} a ${crowdPct(u.rare.c.share)}% call${dd ? ` on ${dd}` : ''}`;
      share.text = share.text.replace(/\nCan you beat me\?/, `\n${share.crowd}\nCan you beat me?`);
      pre.textContent = share.text;
    });
  }

  // ---- Fanbases (board/worker.js /fans): "Your team" (optional, an NFL team by its city: FAN_KEY { code, at }, code ''
  // for none, synced with the account like the stats: worker.js stats team, the newest pick standing) rides with the
  // day's /daily post (team; own when the day's drive is that team's: fanPost), and the board ranks the day's fanbases
  // by their average score (FAN_MIN players to show) and the week's. Asked once on the end card (fanAsk: a pick or Not
  // now), changed in Your stats, where the Fanbases view is (fansEl; the end card's breakdown links to it). On a day
  // featuring a team (the day's drive's, both on a day of two sides) its fans on their own team's drive are called out.
  const FAN_KEY = `${STORE}:team`, FAN_MIN = 5;
  const fanTeams = () => Object.keys(TEAMS).filter((c) => !COLLEGE.has(c)).sort((a, b) => teamName(a).localeCompare(teamName(b)));
  const fanTeam = () => { const t = load(FAN_KEY, null); return t && fanTeams().includes(t.code) ? t.code : ''; };
  const fanPost = () => { const t = fanTeam(); return t ? { team: t, ...(today[0] && today[0].player === t ? { own: true } : {}) } : {}; };
  const fanSync = () => { const t = load(FAN_KEY, null); return t && typeof t.at === 'number' && (t.code === '' || fanTeams().includes(t.code)) ? { team: { code: t.code, at: t.at } } : {}; };
  function fanTake(t) {
    if (!t || typeof t.at !== 'number' || !(t.code === '' || fanTeams().includes(t.code))) return false;
    const mine = load(FAN_KEY, null);
    if (mine && !(t.at > mine.at)) return false;
    save(FAN_KEY, { code: t.code, at: t.at });
    return true;
  }
  function fanSet(code) {
    save(FAN_KEY, { code, at: Date.now() });
    track('team_set', { team: code || 'none' });
    statsSync(true);
  }
  function fanPicker(onSet) {
    const w = el('label', 'myname fanpick');
    w.append(el('span', '', 'Your team'));
    const sel = el('select');
    sel.append(new Option('No team', ''));
    fanTeams().forEach((c) => sel.append(new Option(teamName(c), c)));
    sel.value = fanTeam();
    sel.addEventListener('change', () => { fanSet(sel.value); if (onSet) onSet(sel.value); });
    w.append(sel);
    return w;
  }
  // the end card's one ask: your team, and today's result counts for its fans (posted again: the board takes the team
  // of a result it already has, once)
  function fanAsk() {
    const box = el('div', 'fanask');
    const no = el('button', 'linkbtn', 'Not now');
    no.type = 'button';
    no.addEventListener('click', () => { fanSet(''); box.remove(); });
    box.append(el('p', '', 'Who do you root for? Your score counts for your team’s fans on the Fanbases board.'), fanPicker((code) => {
      box.replaceChildren(el('p', 'note', code ? `Counted for ${teamName(code)}’s fans. Change your team in Your stats.` : 'No team. You can pick one in Your stats.'), fanLink());
      const db = document.querySelector('#done .board.daily');
      if (code && db && db.again) db.again();
    }), no);
    return box;
  }
  function fanLink() {
    const b = el('button', 'linkbtn fanlink', 'Fanbases: today’s fans, ranked ›');
    b.type = 'button';
    b.addEventListener('click', () => { track('fans_open', { from: 'end' }); openStats('fans'); });
    return b;
  }
  // the date of day n (game.js's day numbers; the board's dates)
  const dateOfDay = (n) => ymd(dayDate(n));
  // Your stats' Fanbases: your team, the day's fanbases by average and the week's (two tabs), the day's own team's fans
  function fansEl() {
    const sec = el('div', 'fans');
    sec.id = 'fans';
    const body = el('div', 'fbody');
    sec.append(el('h3', '', 'Fanbases'), fanPicker(() => draw()), body);
    let data = null, tab = 'day';
    const n = idx ? dayOf(new Date()) : 0;
    const draw = () => {
      body.textContent = '';
      if (!data) { body.append(el('p', 'note', BOARD.mode === 'api' ? 'Loading today’s fanbases…' : 'The Fanbases board is on the website.')); return; }
      if (data.error) { body.append(el('p', 'note', 'The Fanbases board did not load. Try again in a moment.')); return; }
      const tabs = el('div', 'lbtabs');
      [['day', 'Today'], ['week', 'This week']].forEach(([k, label]) => {
        const b = el('button', 'chip opt', label);
        b.type = 'button';
        b.setAttribute('aria-selected', String(k === tab));
        b.addEventListener('click', () => { tab = k; draw(); });
        tabs.append(b);
      });
      const rows = tab === 'day' ? data.day : data.week.rows, mine = fanTeam();
      body.append(tabs, el('p', 'note', `${tab === 'day' ? 'Today’s' : 'The last 7 days’'} average score by the fans of each team, ${data.min}+ players to be ranked. Pick your team above to count for it.`));
      const ol = el('ol', 'brows');
      rows.forEach((r, i) => {
        const li = el('li', r.team === mine ? 'me' : '');
        li.append(el('span', 'n', String(i + 1)), el('span', 'nm', teamName(r.team)), el('small', 'd', `${r.n.toLocaleString()} fan${r.n === 1 ? '' : 's'}`), el('b', '', String(Math.round(r.avg))));
        ol.append(li);
      });
      if (rows.length) body.append(ol);
      else body.append(el('p', 'note', tab === 'day' ? `No fanbase has ${data.min} players yet today.` : `No fanbase has ${data.min} players yet this week.`));
      if (mine && !rows.some((r) => r.team === mine)) body.append(el('p', 'note', `${teamName(mine)}’s fans aren’t ranked yet: ${data.min} need to play.`));
      // the day's own team(s): its fans on their team's drive
      const feat = !idx || tab !== 'day' ? [] : [...new Set([...dayIds(n).map((i) => idx.spots[i] && idx.spots[i].player), ...(sidesOf(n) || []).map((x) => idx.spots[x.spot] && idx.spots[x.spot].player)].filter((c) => c && !COLLEGE.has(c)))];
      feat.forEach((t) => {
        const r = data.day.find((x) => x.team === t), own = r && r.own;
        body.append(el('p', 'fanown', own ? `Fans of ${teamName(t)} on their own team’s drive: ${Math.round(own.avg)} on average (${own.n.toLocaleString()} fans)`
          : `Fans of ${teamName(t)} on their own team’s drive: not ${data.min} of them yet today`));
      });
    };
    draw();
    if (BOARD.mode === 'api' && n) {
      fetch(`${BOARD.api}/fans?date=${dateOfDay(n)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { error: r.status }))
        .then((d) => { data = d && Array.isArray(d.day) ? d : { error: 1 }; draw(); }).catch(() => { data = { error: 1 }; draw(); });
    }
    return sec;
  }
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
    // asked, not done on load: mail scanners open every link in an email, and would unsubscribe everyone
    const go = el('button', 'btn', 'Unsubscribe');
    go.type = 'button';
    go.addEventListener('click', async () => {
      if (go.disabled) return;
      go.disabled = true;
      try {
        await proApi('/auth/unsub', { r, t });
        if (ACCT.me) ACCT.me.remind = false;
        track('remind_unsub');
        closeModal();
        toast('Unsubscribed: no more daily emails');
      } catch (e) { closeModal(); toast(`That unsubscribe link did not work (${e.message}). Turn the email off in your account instead.`); }
    });
    openModal('Daily email', [el('p', 'note', 'Stop the daily “new drive is up” email? You can turn it back on in your account.'), go]);
  }

  // ---- Stats that follow the account (board /auth/stats): signed in, this browser's record (the stats days, the
  // historic drives, the playoff runs, survivor's best run) and the account's are merged, the best of each kept on
  // both sides, so a streak, the drives passed and the best run come along to a new phone. On sign-in, on a page load
  // (at most every SYNC_MS: switching modes reloads the page) and after each finished daily, drive, run or survivor
  // run. Drives only from the Gauntlet's start on (gauntletFresh moved the ones before aside).
  const SYNC_KEY = `${STORE}:synced`, SYNC_MS = 10 * 60e3, SYNC_CAP = { days: 2000, drives: 500, runs: 500, frozen: 500 };
  // the better of this browser's record of a day, drive or run and the account's (the board's rules, worker.js
  // statBetter); a drive keeps this browser's own try stamp and last result (renderSummary's: the try counted once)
  function statBest(kind, mine, theirs) {
    if (!mine || !theirs) return mine || theirs;
    const w = theirs.p > mine.p ? theirs : mine;
    if (kind === 'drives') return { ...w, tries: Math.max(mine.tries || 0, theirs.tries || 0), won: !!(mine.won || theirs.won), ...(mine.at ? { at: mine.at } : {}), ...(mine.prev ? { prev: mine.prev } : {}) };
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
    // the badges and the days a freeze covered: a union, the earliest time of each (worker.js statsMerge)
    for (const kind of ['badges', 'frozen']) {
      const m = st[kind] || (st[kind] = {});
      for (const [k, t] of Object.entries(acc[kind] || {})) if (typeof t === 'number' && !(m[k] <= t)) { m[k] = t; changed = true; }
    }
    // survivor's best run: a high-water mark, never down (the higher best and the higher count of runs stand; the
    // extra-life mark follows the best, and on a tie stays only when both used it: worker.js survMerge). A board
    // from before it carried the best run answers none: this browser's stands
    const sv = acc.surv, mine = survStats();
    if (sv && typeof sv === 'object' && typeof sv.best === 'number') {
      const best = Math.max(mine.best || 0, sv.best), runs = Math.max(mine.runs || 0, sv.runs || 0);
      const life = (mine.best || 0) === sv.best ? !!(mine.bestLife && sv.life) : (mine.best || 0) > sv.best ? !!mine.bestLife : !!sv.life;
      if (best !== mine.best || runs !== mine.runs || life !== !!mine.bestLife) { save(`${STORE}:survstats`, { ...mine, best, runs, bestLife: life }); changed = true; }
    }
    // My scenarios: the newest touch of each, with the best score, the most tries, won if either (worker.js scenMerge)
    const L = scenList();
    let lc = false;
    for (const [c, v] of Object.entries(acc.scen || {})) {
      const u = L[c];
      if (!v || typeof v.at !== 'number') continue;
      const best = [u && u.p, v.p].filter((q) => typeof q === 'number');
      const m = !u ? { ...v } : { ...(v.at > u.at ? { ...u, ...v, gone: !!v.gone } : u), ...(best.length ? { p: Math.max(...best) } : {}), tries: Math.max(u.tries || 0, v.tries || 0), won: !!(u.won || v.won) };
      if (!m.gone) delete m.gone;
      if (JSON.stringify(m) !== JSON.stringify(u)) { L[c] = m; lc = true; }
    }
    if (lc) scenSave(L);
    if (fanTake(acc.team)) changed = true;            // (your team: the newest pick, worker.js statsMerge)
    if (changed) { save(`${STORE}:stats`, st); save(`${STORE}:drives`, here.drives); save(`${STORE}:runs`, here.runs); }
    return changed || lc;
  }
  let syncQ = Promise.resolve(false);        // one sync at a time, in order (a finish while one is out goes after it)
  function statsSync(force) {
    syncQ = syncQ.catch(() => false).then(async () => {
      if (!signedIn() || !BOARD.api) return false;
      if (!force && Date.now() - Number(load(SYNC_KEY, 0) || 0) < SYNC_MS) return false;
      const st = load(`${STORE}:stats`, { days: {} }), sv = survStats();
      const stats = { days: newest(st.days, SYNC_CAP.days), drives: newest(gauntletDrives(load(`${STORE}:drives`, {})), SYNC_CAP.drives), runs: newest(load(`${STORE}:runs`, {}), SYNC_CAP.runs),
        badges: st.badges || {}, frozen: newest(st.frozen, SYNC_CAP.frozen),
        surv: { best: sv.best || 0, runs: sv.runs || 0, ...(sv.bestLife ? { life: true } : {}) }, ...fanSync(),
        scen: Object.fromEntries(Object.entries(scenList()).filter(([c, e]) => SCN && SCN.parse(c) && e && typeof e.at === 'number')
          .map(([c, e]) => [c, { at: e.at, ...(typeof e.p === 'number' ? { p: e.p } : {}), tries: e.tries || 0, won: !!e.won, ...(e.gone ? { gone: true } : {}), ...(e.title ? { title: e.title } : {}) }])) };
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
  // a day finished on another phone: the top bar's streak, and the end card's streak line if it is up, count it (and
  // in survivor, a best run from another phone: the label's best)
  function streakRedraw() {
    if (homeUp) { renderHome(false, true); return; }
    if (SURV) { if (state) $('dayLabel').textContent = survLabel(); return; }
    dayLabelSet();
    const line = document.querySelector('#done .streak');
    if (!line || !state || !state.done || SURV || PRACTICE || DRIVE || RUN_N || CUSTOM || ARCH_DAY) return;
    line.replaceWith(endStreakEl(streakOf(load(`${STORE}:stats`, { days: {} }), dayN)));
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
      'The historic drives. Mahomes’ 13 seconds, the Minneapolis Miracle, the Helmet Catch, 28–3 and more, each from its real spot',
      'The playoff runs. A team’s whole postseason, every late-game spot in order. Win them all',
      ...(SCN ? ['Build a scenario. Any two teams of any season from 2001 on, as they lined up then, in any situation: 2007 New England against 2023 Kansas City, down 4 with two minutes left'] : [])].forEach((t) => ul.append(el('li', '', t)));
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
      if (!inp.value.trim()) { toast('Paste your Pro code first: it looks like TMD-XXXX-XXXX-XXXX'); inp.focus(); return; }
      try {
        const d = await proApi('/restore', { code: inp.value, key: deviceKey() });
        save(PRO_KEY, { code: d.code, at: Date.now() });
        PRO_LIVE = true;
        track('pro_restored');
        toast('Pro restored');
        if (location.hash === '#archive') location.reload(); else location.hash = '#archive';
      } catch (e) {        // (the board's reasons, said for a player: "unknown code", "a code looks like ...")
        toast(/unknown code/.test(e.message) ? 'That is not a Pro code: check it and try again'
          : /looks like/.test(e.message) ? 'A Pro code looks like TMD-XXXX-XXXX-XXXX: check it and try again' : e.message);
      }
    });
    rs.append(inp, go);
    box.append(el('p', 'note', 'Already have Pro? Enter your code.'), rs, recoverNodes());
    if (!BOARD.api) { buy.disabled = true; go.disabled = true; }
    return [box];
  }
  // "Lost your code?": the email the purchase was paid with, and the board emails the code(s) bought with it (POST
  // /recover; the same answer whoever the address is). Shown only where the board can send email (GET /auth: email).
  function recoverNodes() {
    const wrap = el('div', 'recover'), open = el('button', 'linkbtn', 'Lost your code?');
    const form = el('form', 'rcform'), lab = el('label', 'note', 'Enter the email you paid with and we’ll email your code.');
    const rowEl = el('div', 'row'), inp = el('input'), go = el('button', 'btn', 'Email my code'), err = el('p', 'err');
    wrap.hidden = true; form.hidden = true; err.hidden = true; form.noValidate = true;     // (our own message, read out: role=alert)
    const id = `rc${Math.random().toString(36).slice(2, 8)}`;
    inp.id = `${id}e`; lab.htmlFor = inp.id; form.id = `${id}f`;
    inp.type = 'email'; inp.placeholder = 'you@example.com'; inp.autocomplete = 'email'; inp.required = true; inp.spellcheck = false; inp.setAttribute('inputmode', 'email');
    err.setAttribute('role', 'alert');
    open.type = 'button'; go.type = 'submit';
    open.setAttribute('aria-expanded', 'false'); open.setAttribute('aria-controls', form.id);
    open.addEventListener('click', () => {
      form.hidden = !form.hidden;
      open.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) inp.focus();
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const addr = inp.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { err.textContent = 'Enter the email address you paid with.'; err.hidden = false; inp.focus(); return; }
      go.disabled = true; err.hidden = true; go.textContent = 'Sending…';
      try {
        await proApi('/recover', { email: addr });
        track('recover_request');
        const done = el('p', 'sent', 'If that email bought Pro, your code is on its way. Check your inbox (and spam) in a minute: the email has a link that turns Pro on here in one tap.');
        done.setAttribute('role', 'status');
        form.replaceWith(done);
        open.hidden = true;
      } catch (e) {
        err.textContent = /not set up/.test(e.message) ? 'Code recovery is not available right now. Try again later.'
          : /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Could not reach the server. Check your connection and try again.' : e.message;
        err.hidden = false; go.disabled = false; go.textContent = 'Email my code';
      }
    });
    rowEl.append(inp, go);
    form.append(lab, rowEl, err);
    wrap.append(open, form);
    authCfg().then((c) => { wrap.hidden = !(c && c.email); }).catch(() => { /* no board: hidden */ });
    return wrap;
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
  // the Pro screen: the historic drives and every past day, newest first, with your score where you played; the
  // pitch when Pro is not on
  // ---- the home screen (#home): today's drive first (what it is, or how you did and when the next one comes), then
  // survivor and Pro, then your stats, the help, the account and your leagues. Big cards, one tap each; every mode keeps
  // its own address (a tap is a hash change, which reloads the page into it)
  let homeUp = false;
  function homeBtn() {
    const a = el('a', 'btn ghostbtn homebtn', 'Home');
    a.href = '#home';
    a.addEventListener('click', () => scrollTo(0, 0));       // (the reload keeps the scroll: Home opens at the top)
    return a;
  }
  const HOME_ICON = {
    stats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V12M10 20V5M15 20v-9M20 20v-5"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4.1"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/></svg>',
  };
  function renderHome(auto, redraw) {
    HOME_PG = true; homeUp = true;
    show('home');
    ['modeDaily', 'modeSurv', 'modeArch', 'modeVs'].forEach((id) => $(id).removeAttribute('aria-current'));
    $('modeHome').setAttribute('aria-current', 'page');
    const n = dayOf(new Date()), st = load(`${STORE}:stats`, { days: {} }), sk = streakOf(st, n);
    $('dayLabel').textContent = `No. ${n} · ${dayDate(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${sk.n >= 2 ? ` · 🔥${sk.n}${sk.pending.length ? '❄️' : ''}` : ''}`;
    const box = $('homeview');
    box.textContent = '';
    const h = el('h2', 'vh', 'Home');
    h.id = 'homeH';
    const day = homeDaily(n, st, sk);
    const modes = el('div', `hmodes${PRO_ON ? '' : ' one'}`);
    modes.append(homeSurv());
    if (PRO_ON) modes.append(homePro(n));
    if (VS_ON) modes.append(homeVs());
    box.append(h, day.el, modes, homeTools());
    const ls = myLeagues();
    if (ls.length) {
      const sec = el('div', 'hsec'), list = el('div', 'llist');
      sec.append(el('h3', '', ls.length === 1 ? 'Your league' : 'Your leagues'));
      ls.forEach((l) => {
        const b = el('button', 'lrow');
        b.type = 'button';
        b.append(el('span', 'nm', l.name), el('span', 'n', `${l.n} player${l.n === 1 ? '' : 's'}`), el('span', 'go', '›'));
        b.addEventListener('click', () => { track('home_tap', { to: 'league' }); leagueBoard(l.code); });
        list.append(b);
      });
      sec.append(list);
      box.append(sec);
    }
    const links = el('nav', 'hlinks');
    links.setAttribute('aria-label', 'About the game');
    [['patch-notes', 'Patch notes'], ['about', 'About'], ['how-it-works', 'How it works'], ['privacy', 'Privacy']].forEach(([href, t]) => { const a = el('a', '', t); a.href = href; links.append(a); });
    box.append(links);
    // the site moved: a browser with nothing saved here (no day played, never handed over) can still bring its progress
    // from the old address, whose /move page hands it over as every old page does (its redirect rule leaves /move alone)
    if (OLD_HOME && BUILD && !Object.keys(st.days || {}).length && !load(`${STORE}:movedin`, null)) {
      const p = el('p', 'note hmove'), a = el('a', '', 'Bring your streak and stats over');
      a.href = `${location.protocol}//${OLD_HOME}/move#back=${encodeURIComponent('/')}`;
      a.addEventListener('click', () => track('home_tap', { to: 'move' }));
      p.append(`Played on ${OLD_HOME} before? `, a);
      box.append(p);
    }
    // where each tap goes, for the analytics (one event a tap; the next page's own events follow)
    box.querySelectorAll('a[data-to]').forEach((a) => a.addEventListener('click', () => { track('home_tap', { to: a.dataset.to }); scrollTo(0, 0); }));
    if (!redraw) track('home_open', { daily: day.status, auto: !!auto, pro: isPro(), streak: sk.n });
  }
  // the card for today's drive: the spot (its kind, the score and clock, the game) and Play; mid-drive, Continue; done,
  // your score, your result one tap away and the countdown to the next one. The streak under it either way
  function homeDaily(n, st, sk) {
    const sp = idx.spots[dayIds(n)[0]], feat = idx.featured && idx.featured[n], s0 = sp.start, pick = sidesOf(n) && sideOf(n) == null;
    const meH = sp.player === sp.home, lead = s0.score[meH ? 1 : 0] - s0.score[meH ? 0 : 1];
    const ck = `${Math.floor(s0.clock / 60)}:${String(Math.ceil(s0.clock) % 60).padStart(2, '0')}`;
    const left = s0.qtr > 4 ? `${ck} left in overtime` : `${ck} left in the ${s0.qtr === 4 ? 'game' : s0.qtr === 2 ? 'half' : s0.qtr === 3 ? 'third quarter' : 'first quarter'}`;
    const saved = load(`${STORE}:day:${n}`, null), rec = st.days[n];
    const done = !!rec || !!(saved && saved.done);
    const going = !done && !!(saved && saved.spots && saved.spots.some((s) => s && (s.started || (s.decisions && s.decisions.length))));
    const status = done ? 'done' : going ? 'progress' : 'new';
    const card = el('section', `hhero ${status}`);
    card.setAttribute('aria-label', 'Today’s drive');
    const top = el('div', 'hk');
    top.append(el('span', '', `Today’s drive · No. ${n}`), el('span', 'tag', done ? 'Done ✓' : going ? 'In progress' : pick ? 'Pick a side' : feat ? 'Featured' : catLabel(sp)));
    card.append(top);
    if (dayTitle(n)) card.append(el('div', 'httl', dayTitle(n)));
    if (pick && !done) {            // a day of two sides, none taken yet: the game, and a button for each takeover
      card.append(el('div', 'hm', `${matchLine(sp)} · ${gameTag(sp)}`));
      const row = el('div', 'sidepicks');
      sidesOf(n).forEach((_, k) => row.append(sideBtn(n, k, () => { track('home_tap', { to: 'daily_side' }); scrollTo(0, 0); }, 'a')));
      card.append(row);
    } else if (done && rec) {
      const p = Math.round(rec.p * 100), sc = el('div', 'hscore');
      sc.append(el('b', '', String(p)), el('span', '', `Better than ${p}% of NFL play‑callers`));
      card.append(sc, el('div', 'hm', `${lead > 0 ? `Up by ${lead}` : lead < 0 ? `Down by ${-lead}` : 'Tied'}, ${left} · ${matchLine(sp)}`));
    } else {
      const big = el('div', 'hbig', lead > 0 ? `Up by ${lead}` : lead < 0 ? `Down by ${-lead}` : 'Tied');
      big.append(el('span', 'left', left));
      const opp = sp.player === sp.home ? sp.away : sp.home, at = sp.neutral ? 'vs' : sp.player === sp.home ? 'hosting' : 'at';
      card.append(big, el('div', 'hm', `You’re ${teamName(sp.player)}, ${at} ${teamName(opp)} · ${gameTag(sp)}`));
    }
    const go = el('a', `btn${done ? ' ghostbtn' : ''}`, done ? 'See your result' : going ? 'Continue the drive' : 'Play today’s drive');
    go.href = '#daily';
    go.dataset.to = `daily_${status}`;
    if (!(pick && !done)) card.append(go);
    const foot = el('div', 'hfoot');
    const streak = sk.n >= 1 ? `${sk.n}-day streak` : '';
    if (sk.n >= 1) foot.append(flameEl(sk.n));
    if (done) {
      foot.append(countdown(streak ? `${streak} · next drive in ` : 'Next drive in '));
    } else {
      foot.append(el('span', '', streak ? `${streak}${sk.pending.length ? ' ❄️' : ''}: play today to keep it` : 'One real drive a day, the same for everyone'));
    }
    card.append(foot);
    return { el: card, status };
  }
  function homeSurv() {
    const sv = survStats(), run = load(`${STORE}:surv`, null);
    const alive = !!(run && !run.out && (run.won > 0 || (run.spots && run.spots.some((s) => s && s.started))));
    const a = el('a', 'hcard hsurv');
    a.href = '#survivor';
    a.dataset.to = 'survivor';
    const num = el('div', 'hnum');
    num.append(el('b', '', sv.best ? String(sv.best) : '–'), el('span', '', sv.best ? `win${sv.best === 1 ? '' : 's'}, your best run` : 'no runs yet'));
    a.append(el('div', 'hk', 'Survivor'), num,
      el('p', '', alive ? `Your run is alive: ${run.won} win${run.won === 1 ? '' : 's'} so far.` : 'Real fourth quarters back to back. One loss ends it.'),
      el('span', 'cta', alive ? 'Continue' : 'Play'));
    return a;
  }
  // Versus: someone live (or the computer when nobody is on), college overtime
  function homeVs() {
    const a = el('a', 'hcard hvs');
    a.href = '#vs';
    a.dataset.to = 'versus';
    a.append(el('div', 'hk', 'Versus · live'), el('div', 'hpitch', 'Play someone'),
      el('p', '', 'College overtime against another player: you call your offense and your defense. Nobody on? Play the computer.'),
      el('span', 'cta', 'Play'));
    return a;
  }
  // Pro: your record (drives passed and the rank, the runs, the archive), else what it is and its price
  function homePro(n) {
    const a = el('a', `hcard hpro${isPro() ? ' on' : ''}`);
    a.href = '#archive';
    a.dataset.to = isPro() ? 'pro' : 'pro_pitch';
    if (!isPro()) {
      a.append(el('div', 'hk', 'Pro · $4.99 once'), el('div', 'hpitch', 'Historic drives'),
        el('p', '', `The Helmet Catch, 28\u2060–\u20603 and more, playoff runs, every past daily.`),
        el('span', 'cta', 'Take a look'));
      return a;
    }
    const ds = load(`${STORE}:drives`, {}), rs = load(`${STORE}:runs`, {});
    const passed = Object.values(ds).filter((r) => r && Math.round(r.p * 100) >= PASS_AT).length;
    const num = el('div', 'hnum'), nb = el('b', '', String(passed)), nr = Object.keys(rs).length;
    num.append(nb, el('span', '', `drive${passed === 1 ? '' : 's'} passed`));
    const more = `${nr ? `${nr} playoff run${nr === 1 ? '' : 's'} played` : 'Playoff runs'}, ${n > 1 ? `${n - 1} past dailies` : 'the archive'}.`;
    const line = el('p', '', `Historic drives. ${more}`);
    a.append(el('div', 'hk', 'Pro'), num, line, el('span', 'cta', 'Open'));
    // the drives' count and your rank, once the list is in (the Pro screen loads the same file)
    loadPro().then((pro) => {
      if (!pro || !pro.drives.length || !a.isConnected) return;
      const k = pro.drives.filter((_, i) => ds[i + 1] && Math.round(ds[i + 1].p * 100) >= PASS_AT).length;
      nb.textContent = `${k}/${pro.drives.length}`;
      line.textContent = `${proRank(k, pro.drives.length).title}. ${more}`;
    }).catch(() => { /* the record from this device stays */ });
    return a;
  }
  // the smaller things, one row: your stats, how to play, the account (when the site has sign-in)
  function homeTools() {
    const row = el('div', 'htools');
    const tool = (icon, label, fn, to) => {
      const b = el('button', 'htool');
      b.type = 'button';
      if (icon) b.innerHTML = icon;
      b.append(el('span', '', label));
      b.addEventListener('click', () => { track('home_tap', { to }); fn(); });
      row.append(b);
      return b;
    };
    tool(HOME_ICON.stats, 'Your stats', () => openStats(), 'stats');
    tool(HOME_ICON.help, 'How to play', () => openHelp(), 'help');
    if (!$('acctBtn').hidden) tool(PERSON, signedIn() ? (ACCT.me.name || 'Account') : 'Log in', openAccount, 'account');
    row.classList.toggle('two', row.children.length === 2);
    return row;
  }
  // a #drive-N / #run-N link naming none: the Pro screen (#archive) says so at its top, once
  function badProLink() {
    const m = /^#(drive|run)-(\d+)$/.exec(location.hash) || [];
    try { sessionStorage.setItem(`${STORE}:badlink`, `${m[1] === 'run' ? 'playoff run' : 'historic drive'} ${m[2]}`); } catch (e) { /* storage off */ }
    location.replace(location.pathname + location.search + '#archive');
  }
  // the streak's flame: bigger and hotter as the streak grows (game.html .flame.t0-t5): out, orange (1), red (3), blue
  // (7: a week, a freeze earned), purple (14), and at 30 days a gold flame that shifts colour
  const FLAME_TIERS = [[30, 5], [14, 4], [7, 3], [3, 2], [1, 1], [0, 0]];
  const flameTier = (n) => FLAME_TIERS.find(([k]) => n >= k)[1];
  function flameEl(n) {
    const w = el('span', `flame t${flameTier(n)}`), svg = S('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.append(S('path', { class: 'fo', d: 'M12 1.5c.8 3.6 5.6 6.2 5.6 11.6a5.6 5.6 0 0 1-11.2 0c0-2.6 1.3-4.4 2.6-5.6 0 2.1.9 3.3 2.1 3.6-.9-3.6.2-6.9.9-9.6z' }),
      S('path', { class: 'fi', d: 'M12 11.2c.4 1.8 2.8 3 2.8 5.4a2.8 2.8 0 0 1-5.6 0c0-1.3.6-2.2 1.3-2.8.1 1 .5 1.6 1 1.7-.3-1.6 0-3 .5-4.3z' }));
    w.append(svg);
    return w;
  }
  // your streak, big: the flame, the days, and how far to the next flame
  function streakEl(sk) {
    const row = el('div', `streak t${flameTier(sk.n)}`), next = FLAME_TIERS.slice().reverse().find(([k]) => k > sk.n);
    const txt = el('div', 'stx');
    txt.append(el('b', '', sk.n ? `${sk.n}-day streak` : 'No streak yet'),
      el('span', '', sk.pending.length ? 'Play today’s drive to keep it (a freeze ❄️ covers the day you missed)'
        : next ? `${next[0] - sk.n} more day${next[0] - sk.n === 1 ? '' : 's'} of the daily for a hotter flame` : 'The hottest flame there is'));
    row.append(flameEl(sk.n), txt);
    return row;
  }
  // a mode's card on the Pro hub: its icon, name, a line about you in it, a bar when it has one
  const PICON = {
    comm: ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16.5 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.5 19c0-3.2 2.5-5.4 5.5-5.4s5.5 2.2 5.5 5.4M14 14.2c3.4-.6 7 1.2 7 4.8'],
    drives: ['M6 3.5h12v5a6 6 0 0 1-12 0zM6 5H3.5v1.5A3.5 3.5 0 0 0 6.3 10M18 5h2.5v1.5a3.5 3.5 0 0 1-2.8 3.5M9 20.5h6M12 14.5v6'],
    runs: ['M3.5 4.5h5v5h5v5h5M3.5 19.5h5v-5M20.5 14.5h-2'],
    build: ['M4 20l1.2-4.4L16 4.8a2.1 2.1 0 0 1 3 3L8.2 18.6zM14.5 6.3l3 3'],
    dailies: ['M4 6.5h16v14H4zM4 10.5h16M8.5 3.5v4M15.5 3.5v4M8 14h2M14 14h2M8 17h2'],
  };
  function proCard(kind, title, sub, go, o = {}) {
    const a = el(typeof go === 'string' ? 'a' : 'button', `pcard ${kind}${o.big ? ' big' : ''}`);
    if (typeof go === 'string') a.href = go; else { a.type = 'button'; a.addEventListener('click', go); }
    const ic = el('span', 'pico'), svg = S('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    PICON[kind].forEach((d) => svg.append(S('path', { d })));
    ic.append(svg);
    const tx = el('span', 'ptx');
    if (o.k) tx.append(el('span', 'pk', o.k));
    tx.append(el('b', '', title), el('span', 'ps', sub));
    if (o.bar != null) { const bar = el('span', 'pbar'), f = el('i'); f.style.width = `${Math.round(o.bar * 100)}%`; bar.append(f); tx.append(bar); }
    a.append(ic, tx);
    return a;
  }
  async function proHub(box, now, todayN) {
    gauntletFresh();
    const [pro, runs] = await Promise.all([loadPro(), loadRuns()]);
    const ds = load(`${STORE}:drives`, {}), rs = load(`${STORE}:runs`, {}), n = pro && pro.drives ? pro.drives.length : 0;
    const passed = n ? pro.drives.filter((_, k) => ds[k + 1] && Math.round(ds[k + 1].p * 100) >= PASS_AT).length : 0;
    const sk = streakOf(load(`${STORE}:stats`, { days: {} }), todayN);
    const head = el('section', 'phub');
    if (n) {
      const rk = proRank(passed, n), rt = el('div', 'prank'), bar = el('span', 'pbar'), f = el('i');
      f.style.width = `${Math.round((100 * passed) / n)}%`;
      bar.append(f);
      rt.append(el('span', 'pk', 'Your rank'), el('b', '', rk.title),
        el('span', 'ps', `${passed} of ${n} drives passed${rk.next ? ` · ${rk.next.at - passed} more to ${rk.next.title}` : ' · every one'}`), bar);
      head.append(rt);
    }
    head.append(streakEl(sk));
    box.append(head);
    const open = (sec) => () => { track('pro_tap', { to: sec }); renderArchive(now, sec); scrollTo(0, 0); };
    // option A, a grid of square tiles: Build a scenario the big one (two rows tall), Community beside it, then the
    // drives under Community, the runs and the past dailies
    const tiles = el('div', 'ptiles');
    if (SCN) {
      const mine = Object.values(scenList()).filter((e) => e && !e.gone).length;
      tiles.append(proCard('build', 'Build a scenario', `Any two teams from 2001 on, any situation${mine ? ` · ${mine} played` : ''}`, '#custom', { k: 'Your game', big: true }),
        proCard('comm', 'Community', 'What others built', '#community', { k: 'New' }));
    }
    if (n) tiles.append(proCard('drives', 'Historic drives', `${passed} of ${n} passed`, open('drives'), { bar: passed / n }));
    const nr = runs && runs.runs ? runs.runs.length : 0, played = Object.keys(rs).length, titles = Object.values(rs).filter((r) => r && r.w === r.n).length;
    if (nr) tiles.append(proCard('runs', 'Playoff runs', played ? `${played} of ${nr} played${titles ? ` · ${titles} 🏆` : ''}` : 'Every game of a real run', open('runs')));
    if (todayN > 1) tiles.append(proCard('dailies', 'Past dailies', `${todayN - 1} so far`, open('dailies')));
    box.append(tiles);
    box.append(proCodeCard(false), authNodes());
  }
  // the Pro screen: with Pro, a hub of cards (your rank and streak, then Community, Historic drives, Playoff runs, Build
  // and Past dailies); a card opens its section here (sec), with a way back
  async function renderArchive(now, sec) {
    if (!sec) track('archive_open', { pro: isPro() });
    show('arch');
    const box = $('arch'), todayN = dayOf(now);
    box.textContent = '';
    box.append(el('h2', '', 'Pro'));
    let bad = null;
    try { bad = sessionStorage.getItem(`${STORE}:badlink`); sessionStorage.removeItem(`${STORE}:badlink`); } catch (e) { /* storage off */ }
    if (bad) box.append(el('p', 'note badlink', `There is no ${bad}${isPro() ? ': here are the ones there are.' : '.'}`));
    if (SCN && !isPro()) box.append(scenEntry(), commEntry());        // Build a scenario first on the Pro screen, with Pro or without (building is free to try), then what others built
    if (!isPro()) {
      box.append(el('p', 'lead', `Every daily since launch${todayN > 1 ? `, ${todayN - 1} so far` : ''}, the historic drives and the playoff runs: play any of them, graded like the day it ran.`));
      if (PRO_LIVE === null && (proCode() || authSession())) {     // a code (or a session) is kept here but the board could not confirm it
        const again = el('button', 'btn', 'Try again');
        again.type = 'button'; again.addEventListener('click', () => location.reload());
        box.append(el('p', '', 'Your Pro code could not be checked (no connection to the board). Try again in a moment.'), again);
      } else box.append(...proNodes(), authNodes());
      return;
    }
    if (!sec) { await proHub(box, now, todayN); return; }
    const back = el('button', 'chip pback', '‹ Pro');
    back.type = 'button';
    back.addEventListener('click', () => { renderArchive(now); scrollTo(0, 0); });
    box.firstChild.before(back);
    gauntletFresh();
    const pro = await loadPro(), ds = load(`${STORE}:drives`, {});
    if (sec === 'drives') {
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
        // (the year it was played, as on its intro: Super Bowl LII is 2018, not the 2017 season)
        const yr = sp.real.date ? Number(sp.real.date.slice(0, 4)) : sp.real.season + (ROUND[sp.real.type] ? 1 : 0);
        a.append(tb, el('span', 'd', String(yr)), el('span', 'm', `${cityIn(sp.player, sp.real.season)} vs ${cityIn(opp, sp.real.season)}`), right);
        dl.append(a);
      });
      box.append(dl);
    } else box.append(el('h3', '', 'Historic drives'), el('p', 'note', 'The historic drives land here with the next build.'));
    }
    if (sec === 'runs') {
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
      box.append(rl, el('p', 'note', 'Every game of the run in order, each from its spot with the most at stake, the game still in doubt. Lose one and the season is over, as it was for real; win them all.'));
    } else box.append(el('p', 'note', 'The playoff runs land here with the next build.'));
    }
    if (sec !== 'dailies') return;
    box.append(el('h3', '', 'Past dailies'));
    if (todayN <= 1) { box.append(el('p', '', 'The archive fills from tomorrow: today’s drive is on the Daily tab.')); return; }
    const st = load(`${STORE}:stats`, { days: {} }), list = el('div', 'days');
    for (let n = todayN - 1; n >= 1; n--) {
      const sp = idx.spots[dayIds(n)[0]], feat = idx.featured && idx.featured[n], opp = sp.player === sp.home ? sp.away : sp.home;
      const a = el('a', 'day');
      a.href = `#day-${n}`;
      a.append(el('b', '', `No. ${n}`), el('span', 'd', dayDate(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
        el('span', 'm', feat && feat.title ? `${feat.title} · ${teamName(sp.player)} vs ${teamName(opp)}` : `${teamName(sp.player)} vs ${teamName(opp)}${feat ? ' · featured' : ''}`),
        st.days[n] ? (() => { const g = el('span', 'gr'); g.append(gradeBadge(Math.round(st.days[n].p * 100)), el('small', '', String(Math.round(st.days[n].p * 100)))); return g; })() : el('span', 'sc', 'Play'));
      list.append(a);
    }
    box.append(list, el('p', 'note', acctPro() ? `Pro is on your account · ${ACCT.me.email}` : `Pro is on this device · code ${proCode()}`));
  }

  // ------------------------------------------------------- build a scenario ---
  // Pro (#custom): any two teams of any season the site has rosters for (rosters/index.json, rosters/<season>.json:
  // src/nflclock/scenario.py), any kind of game and any situation (web/scenario.js: the format, the presets, the checks).
  // The builder saves its draft as you go (SCN_DRAFT); Kick off plays it at #custom-<code>, a link anyone can open
  // (Pro plays it; anyone else sees what it is and the Pro pitch). A scenario plays like a historic drive (each try its
  // own draws, Start over, graded the same way, an A takes winning it) and posts nowhere: My scenarios (SCN_LIST,
  // synced with the account like the drives: statsSync) keeps each one's best grade and tries.
  const SCN_DRAFT = `${STORE}:custom:draft`, SCN_LIST = `${STORE}:scen`, SCN_KEEP = 200;
  let SCN_IDX = null;
  const SCN_ROS = {}, SCN_ROSV = {};          // (a season's rosters: its fetch, and once in, the rosters themselves)
  async function scnIndex() {
    if (!SCN_IDX) SCN_IDX = fetch(asset('rosters/index.json')).then((r) => { if (!r.ok) throw new Error(`rosters ${r.status}`); return r.json(); });
    try { return await SCN_IDX; } catch (e) { SCN_IDX = null; throw e; }
  }
  // a season's teams, fetched when one of its teams is picked (and kept: the builder asks again as you change it)
  function scnRoster(y) {
    if (!SCN_ROS[y]) SCN_ROS[y] = fetch(asset(`rosters/${y}.json`)).then((r) => { if (!r.ok) throw new Error(`rosters ${y}: ${r.status}`); return r.json(); })
      .then((d) => { SCN_ROSV[y] = d; return d; });
    SCN_ROS[y].catch(() => { delete SCN_ROS[y]; });
    return SCN_ROS[y];
  }
  const scnSeason = (ix, y) => (ix.seasons || []).find((s) => s.season === y);
  const scnTeam = (ix, c, y) => { const s = ix && scnSeason(ix, y); return s ? s.teams.find((t) => t.team === c) : null; };
  // the franchise's city that season where it is not today's (St. Louis before Los Angeles), else today's
  const scnNick = (ix, c, y) => { const t = scnTeam(ix, c, y); return t && t.era ? t.era.name : teamName(c); };
  const scnName = (ix, c, y) => `${y} ${scnNick(ix, c, y)}`;
  const scenList = () => { const o = load(SCN_LIST, {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  function scenSave(L) {
    const keep = Object.entries(L).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, SCN_KEEP);
    save(SCN_LIST, Object.fromEntries(keep));
  }
  // played (kicked off): on the list, on top (under its title, when the link has one)
  function scenTouch(c, title) {
    const L = scenList(), e = L[c] || { tries: 0, won: false };
    L[c] = { ...e, at: Date.now(), ...(title ? { title } : {}) };
    delete L[c].gone;
    scenSave(L);
  }
  // a finished try: the best grade kept, the tries counted once a try (a reload of the end card counts nothing)
  function scenFinish(p) {
    const L = scenList(), prev = L[CUSTOM] || null, r0 = state.spots[0] && state.spots[0].result, won = !!(r0 && r0.mine > r0.theirs);
    const counted = !!prev && prev.try === state.tryAt;
    const best = prev && typeof prev.p === 'number' ? prev.p : null;
    const rec = { at: Date.now(), p: Math.max(p, best ?? 0), last: p, tries: ((prev && prev.tries) || 0) + (counted ? 0 : 1), won: won || !!(prev && prev.won),
      try: state.tryAt, pb: counted ? prev.pb ?? null : best, ...((CUSTOM_TITLE || (prev && prev.title)) ? { title: CUSTOM_TITLE || prev.title } : {}) };
    L[CUSTOM] = rec;
    scenSave(L);
    if (!counted) commPlay({ done: true, won, p });
    return rec;
  }
  // the kind of game in a sentence: "a regular-season game", "the Divisional round", "the Super Bowl"
  const typeSay = (t) => (t === 'REG' ? 'a regular-season game' : t === 'WC' ? 'the Wild Card round' : `the ${SCN.TYPES[t]}`);
  const scenLink = (c) => `${location.origin}${location.pathname}${location.search}#custom-${c}`;
  // a scenario as a line: "2007 New England vs 2023 Kansas City", and its situation in a few words
  function scenLines(sc, ix) {
    const S = SCN.summary(sc, (c, y) => scnName(ix, c, y));
    return { title: S.title, name: S.name, sub: `${SCN.TYPES[sc.type]} · ${sc.qtr === 5 ? 'OT' : `Q${sc.qtr}`} ${SCN.clockText(sc.clock)} · ${S.score.toLowerCase()}`, S };
  }
  // the summary card (the builder's, a shared link's, the end card's)
  function scenSummaryEl(sc, ix) {
    const { S } = scenLines(sc, ix), box = el('div', 'scnsum');
    const tY = scnTeam(ix, sc.you, sc.ys), tO = scnTeam(ix, sc.opp, sc.os);
    const head = el('div', 'sh');
    const sw = (c) => { const x = el('span', `sw${darkOn(color(c)) ? ' dk' : ''}`, c); x.style.background = color(c); return x; };
    head.append(sw(sc.you), el('b', '', S.title), sw(sc.opp));
    if (S.name) box.append(el('div', 'stl', S.name));         // (its title, above the two teams)
    box.append(head);
    const fit = ix.spread || { hfa: 2.4, k: 46 };
    // (a team with lineup picks, its rosters in: its quarterback and strength with them, as the game plays it)
    const picked = (side, c, y, m) => {
      const t = SCN_ROSV[y] && SCN_ROSV[y].teams[c], p = sc.lu && sc.lu[side];
      if (!m || !t || !p) return m;
      try { const w = SCN.withLineup(t, p); return { ...m, qb: w.qb.name, net: SCN.strength(w) }; } catch (e) { return m; }
    };
    const pY = picked('you', sc.you, sc.ys, tY), pO = picked('opp', sc.opp, sc.os, tO);
    if (pY && pO) {
      const homeYou = sc.site !== 'away', h = homeYou ? pY : pO, a = homeYou ? pO : pY;
      const sp = Math.round(((sc.site === 'neutral' ? 0 : fit.hfa) + fit.k * (h.net - a.net)) * 2) / 2, fav = sp >= 0 ? h : a;
      box.append(el('p', 'rec', `${scnNick(ix, sc.you, sc.ys)} ${pY.record}${pY.qb ? `, ${pY.qb}` : ''} · ${scnNick(ix, sc.opp, sc.os)} ${pO.record}${pO.qb ? `, ${pO.qb}` : ''} · ${Math.abs(sp) < 0.5 ? 'a pick’em' : `${scnNick(ix, fav.team, fav === pY ? sc.ys : sc.os)} by ${Math.abs(sp).toFixed(1)}`}`));
    }
    const ul = el('ul');
    const lu = sc.lu ? SCN.lineupSay(sc, SCN_ROSV[sc.ys], SCN_ROSV[sc.os], (c, y) => scnNick(ix, c, y)) : [];
    if (sc.lu && !lu.length) lu.push('Lineups of the builder’s picking');      // (the rosters not in: a shared link's pitch)
    [S.game, `${S.when} · ${S.score}`, S.ball, S.to, S.half, ...lu, S.ot].filter(Boolean).forEach((t) => ul.append(el('li', '', t)));
    box.append(ul);
    return box;
  }
  // the Pro screen's way in: Build a scenario, and how many you have played
  function scenEntry() {
    const a = el('a', 'scnentry'), n = Object.values(scenList()).filter((e) => e && !e.gone).length;
    a.href = '#custom';
    a.append(el('span', 'k', isPro() ? 'New · Build a scenario' : 'New in Pro · Build a scenario'), el('b', '', 'Your teams, your situation'),
      el('span', 'm', `Any two teams from 2001 on, as they lined up that season. Set the game, the clock, the score and the ball, then call it.${n ? ` ${n} played.` : ''}`),
      el('span', 'cta', 'Build one'));
    return a;
  }
  // a link to a scenario that can't be played (a typo, a season the site no longer has)
  function scenBad(why) {
    show('arch');
    const box = $('arch');
    box.textContent = '';
    const a = el('a', 'btn', 'Build a scenario');
    a.href = '#custom';
    box.append(el('h2', '', 'Scenario'), el('p', 'lead', 'That scenario link doesn’t work.'), el('p', 'note', why.join(' · ')), a);
  }
  // #custom-<code> without Pro: what the scenario is, and the Pro pitch
  async function renderScenPitch(sc, ix) {
    show('arch');
    track('scenario_pitch', {});
    const box = $('arch');
    box.textContent = '';
    box.append(el('h2', '', 'Pro'), el('p', 'lead', 'Someone built this scenario for you to play. Building and playing scenarios is part of Pro.'), scenSummaryEl(sc, ix));
    box.append(...proNodes(), authNodes());
  }
  // the builder's draft: the last one, else today's season's two teams
  function scenDraft(ix) {
    const d = load(SCN_DRAFT, null), last = ix.seasons[ix.seasons.length - 1];
    if (d && typeof d === 'object' && d.you) return { ...SCN.defaults(last.season), ...d };
    const t = last.teams.map((x) => x.team);
    return SCN.defaults(last.season, t.includes('KC') ? 'KC' : t[0], t.includes('BUF') ? 'BUF' : t[1]);
  }
  async function renderBuilder() {
    show('arch');
    track('scenario_builder', { pro: isPro() });
    const box = $('arch');
    box.textContent = '';
    box.append(el('h2', '', 'Build a scenario'));
    let ix;
    try { ix = await scnIndex(); } catch (e) {
      box.append(el('p', 'note', `The rosters did not load (${e.message}). Check your connection and reload.`));
      return;
    }
    const seasons = ix.seasons.map((s) => s.season), first = seasons[0], last = seasons[seasons.length - 1];
    box.append(el('p', 'lead', `Any two teams from ${first} to ${last}, each as it lined up that season, in any situation you set.`));
    if (!isPro()) box.append(el('p', 'note scnpro', 'Building is free to try; playing a scenario is part of Pro.'));
    const seeC = el('a', 'linkbtn', 'See what others built: Community scenarios');
    seeC.href = '#community';
    box.append(seeC);
    let sc = scenDraft(ix);
    const form = el('form', 'scn');
    form.noValidate = true;
    form.addEventListener('submit', (e) => e.preventDefault());
    const uid = (k) => `scn-${k}`;
    const row = (label, ...kids) => { const r = el('div', 'srow'), l = el('label', 'sl', label); r.append(l, ...kids); if (kids[0] && kids[0].id) l.htmlFor = kids[0].id; return r; };
    const fieldset = (legend) => { const f = el('fieldset', 'sgrp'); f.append(el('legend', '', legend)); return f; };
    // a row of buttons, one of them on (aria-pressed): the quarter, the down, the timeouts ...
    const seg = (name, opts, get, set, label) => {
      const g = el('div', 'seg');
      g.setAttribute('role', 'group');
      if (label) g.setAttribute('aria-label', label);
      g.dataset.f = name;
      opts.forEach(([v, t]) => {
        const b = el('button', '', t);
        b.type = 'button';
        b.dataset.v = String(v);
        b.addEventListener('click', () => { set(v); changed(); });
        g.append(b);
      });
      g.sync = () => g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(get()))));
      return g;
    };
    const num = (name, lo, hi, get, set, label) => {
      const i = el('input');
      i.type = 'number'; i.inputMode = 'numeric'; i.min = lo; i.max = hi; i.id = uid(name); i.setAttribute('aria-label', label);
      i.dataset.f = name;
      i.addEventListener('input', () => { set(i.value === '' ? NaN : Number(i.value)); changed(false); });
      i.sync = () => { if (document.activeElement !== i) i.value = Number.isFinite(get()) ? get() : ''; };
      return i;
    };
    const teamSel = (side) => {
      const t = el('select'), y = el('select');
      t.id = uid(`${side}team`); y.id = uid(`${side}yr`); t.dataset.f = side;
      t.setAttribute('aria-label', side === 'you' ? 'Your team' : 'The other team'); y.setAttribute('aria-label', side === 'you' ? 'Your team’s season' : 'Their season');
      [...seasons].reverse().forEach((s) => y.append(new Option(String(s), String(s))));
      const key = side === 'you' ? ['you', 'ys'] : ['opp', 'os'];
      const fill = () => {
        const teams = (scnSeason(ix, sc[key[1]]) || { teams: [] }).teams.slice().sort((a, b) => scnNick(ix, a.team, sc[key[1]]).localeCompare(scnNick(ix, b.team, sc[key[1]])));
        t.textContent = '';
        teams.forEach((x) => t.append(new Option(`${scnNick(ix, x.team, sc[key[1]])} · ${x.record}`, x.team)));
        if (!teams.some((x) => x.team === sc[key[0]]) && teams.length) sc[key[0]] = teams.find((x) => x.team !== sc[side === 'you' ? 'opp' : 'you']).team;
      };
      t.addEventListener('change', () => { sc[key[0]] = t.value; changed(); });
      y.addEventListener('change', () => {
        const was = sc[key[1]], same = sc.ys === sc.os;
        sc[key[1]] = Number(y.value);
        if (side === 'you' && same) sc.os = sc.ys;          // the same season for both, until you pick theirs on its own
        if (was !== sc[key[1]]) { scnRoster(sc[key[1]]).catch(() => {}); }
        changed();
      });
      const info = el('p', 'tinfo');
      t.sync = () => { fill(); t.value = sc[key[0]]; y.value = String(sc[key[1]]); const x = scnTeam(ix, sc[key[0]], sc[key[1]]);
        info.textContent = x ? `${x.coach || ''}${x.qb ? ` · QB ${x.qb}` : ''}` : ''; };
      const wrap = el('div', 'tpick');
      wrap.append(y, t);
      return { el: wrap, sync: t.sync, info, t, y };
    };
    // presets
    const pre = el('div', 'spre');
    pre.setAttribute('role', 'group'); pre.setAttribute('aria-label', 'Start from');
    Object.entries(SCN.PRESETS).forEach(([k, p]) => {
      const b = key(p.label, p.sub, 'chipkey');
      b.addEventListener('click', () => { sc = SCN.applyPreset(sc, k); track('scenario_preset', { preset: k }); changed(); });
      pre.append(b);
    });
    // its title (optional; posting it to Community takes one): shown on the card, in the link and on the list
    const ttl = el('input');
    ttl.id = uid('title'); ttl.dataset.f = 'title'; ttl.maxLength = SCN.TITLE_MAX; ttl.autocomplete = 'off'; ttl.spellcheck = true;
    ttl.placeholder = 'e.g. Brady’s last stand'; ttl.setAttribute('aria-label', `Title (optional, ${SCN.TITLE_MAX} characters at most)`);
    ttl.addEventListener('input', () => { sc.title = ttl.value; changed(false); });
    ttl.sync = () => { if (document.activeElement !== ttl) ttl.value = sc.title || ''; };
    const gN = fieldset('Title');
    gN.append(row('Name it', ttl));
    const you = teamSel('you'), opp = teamSel('opp');
    const gT = fieldset('Teams');
    gT.append(row('You coach', you.el), you.info, row('Against', opp.el), opp.info);
    // each team's lineup (optional): its quarterback, backs, receivers, tight ends and kicker from the season's roster
    // (rosters/<season>.json, loaded when the team is picked: SCN.slots), as it lined up unless you pick another. The
    // picks are part of the scenario (its code: SCN.code); another team or season starts from its own lineup again
    const gL = fieldset('Lineups');
    const luKey = (side) => (side === 'you' ? `${sc.you}|${sc.ys}` : `${sc.opp}|${sc.os}`);
    const luWas = { you: luKey('you'), opp: luKey('opp') };
    const SLOT_LAB = { q: 'QB', w: 'WR', t: 'TE', k: 'K' };
    const lineupBox = (side) => {
      const d = el('details', 'slu'), head = el('summary'), body = el('div', 'slrows');
      d.dataset.f = `lu-${side}`;
      d.append(head, body);
      d.sync = () => {
        const [c, y] = side === 'you' ? [sc.you, sc.ys] : [sc.opp, sc.os], ros = SCN_ROSV[y], team = ros && ros.teams && ros.teams[c];
        const picks = (sc.lu && sc.lu[side]) || {}, n = Object.keys(picks).length;
        const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
        head.textContent = '';
        head.append(el('b', '', `${side === 'you' ? 'Your' : 'Their'} lineup`), el('small', '', n ? `${n} change${n === 1 ? '' : 's'}` : 'as it lined up'));
        body.textContent = '';
        if (!team) {
          body.append(el('p', 'lnote', 'Getting the roster…'));
          if (Number.isFinite(y)) scnRoster(y).then(() => { if (luKey(side) === `${c}|${y}`) d.sync(); }, () => { body.textContent = ''; body.append(el('p', 'lnote', 'The roster did not load.')); });
          return;
        }
        const S = SCN.slots(team), on = SCN.lineupOf(team, picks), start = new Set(team.lineup.off.map((p) => p.name).concat(team.kicker ? [team.kicker.name] : []));
        S.forEach((s) => {
          const sel = el('select');
          sel.id = uid(`lu-${side}-${s.slot}`);
          const lab = SLOT_LAB[s.k] || s.real.pos;
          sel.setAttribute('aria-label', `${side === 'you' ? 'Your' : 'Their'} ${lab}${S.filter((x) => x.k === s.k).length > 1 ? ` ${s.slot.slice(1)}` : ''}`);
          s.cands.forEach((p) => { const o = new Option(`${p.name}${p.ovr ? ` · ${p.ovr}` : ''}${start.has(p.name) ? '' : ' (backup)'}`, p.name); sel.append(o); });
          sel.value = (on[s.slot] || s.real).name;
          sel.addEventListener('change', () => {
            const P = { ...((sc.lu && sc.lu[side]) || {}) }, now = SCN.lineupOf(team, P), prev = now[s.slot] || s.real;
            const put = (slot, p) => { const x = S.find((q) => q.slot === slot); if (p.name === x.real.name) delete P[slot]; else P[slot] = SCN.pid(p.name); };
            const p = s.cands.find((q) => q.name === sel.value);
            // already in another slot of his: the two swap places
            const other = s.k === 'q' || s.k === 'k' ? null : Object.keys(now).find((k) => k !== s.slot && k[0] !== 'q' && k[0] !== 'k' && now[k] && now[k].name === p.name);
            put(s.slot, p);
            if (other) put(other, prev);
            sc.lu = { ...(sc.lu || {}), [side]: P };
            track('scenario_lineup', { slot: s.slot, side });
            changed();
          });
          body.append(row(lab, sel));
        });
        body.append(el('p', 'lnote', 'Anyone of that season’s team: the quarterback’s passes go as his had, the kicker kicks as he did; the others are who is on the field and whom you can throw to.'));
        if (focused) { const x = document.getElementById(focused); if (x) x.focus(); }      // (the pick just made keeps the focus)
      };
      return d;
    };
    const luY = lineupBox('you'), luO = lineupBox('opp');
    gL.append(luY, luO);
    // the picks of a team no longer in the scenario go (they are its players)
    const luKeep = () => ['you', 'opp'].forEach((side) => {
      if (luWas[side] === luKey(side)) return;
      luWas[side] = luKey(side);
      if (sc.lu && sc.lu[side]) { const { [side]: gone, ...rest } = sc.lu; sc.lu = Object.keys(rest).length ? rest : undefined; }
    });
    const typeSel = el('select');
    typeSel.id = uid('type'); typeSel.dataset.f = 'type';
    Object.entries(SCN.TYPES).forEach(([k, t]) => typeSel.append(new Option(t, k)));
    typeSel.addEventListener('change', () => { const was = sc.type; sc.type = typeSel.value; if (sc.type === 'SB' && was !== 'SB') sc.site = 'neutral'; else if (was === 'SB' && sc.site === 'neutral') sc.site = 'home';
      if (sc.qtr === 5) { sc.clock = Math.min(sc.clock, SCN.otLen(sc)); sc.to = sc.to.map((x) => Math.min(x, SCN.otTo(sc))); } changed(); });
    typeSel.sync = () => { typeSel.value = sc.type; };
    const site = seg('site', [['home', 'Home'], ['away', 'Away'], ['neutral', 'Neutral']], () => sc.site, (v) => { sc.site = v; }, 'Where');
    const rules = seg('rules', [['you', ''], ['opp', '']], () => sc.rules, (v) => { sc.rules = v; }, 'Whose season’s rules');
    const rulesRow = row('Rules of', rules);
    const gG = fieldset('Game');
    gG.append(row('Game', typeSel), row('Where', site), rulesRow);
    // the situation
    const qtr = seg('qtr', [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, 'OT']], () => sc.qtr, (v) => {
      const wasOt = sc.qtr === 5;
      sc.qtr = v;
      if (v === 5) { sc.clock = SCN.otLen(sc); sc.to = [SCN.otTo(sc), SCN.otTo(sc)]; } else if (wasOt) sc.clock = Math.min(sc.clock, 900);
    }, 'Quarter');
    const clk = el('input');
    clk.id = uid('clock'); clk.inputMode = 'numeric'; clk.placeholder = '2:00'; clk.setAttribute('aria-label', 'Time left in the quarter (minutes:seconds)'); clk.dataset.f = 'clock';
    clk.addEventListener('input', () => {
      const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(clk.value) || /^\s*(\d{1,2})(\d{2})\s*$/.exec(clk.value);
      sc.clock = m ? Number(m[1]) * 60 + Number(m[2] || 0) : NaN;
      if (m && m[2] && Number(m[2]) > 59) sc.clock = NaN;
      changed(false);
    });
    clk.addEventListener('blur', () => { if (Number.isFinite(sc.clock)) clk.value = SCN.clockText(sc.clock); });
    clk.sync = () => { if (document.activeElement !== clk) clk.value = Number.isFinite(sc.clock) ? SCN.clockText(sc.clock) : ''; };
    const sY = num('scoreY', 0, 99, () => sc.score[0], (v) => { sc.score[0] = v; }, 'Your score'), sO = num('scoreO', 0, 99, () => sc.score[1], (v) => { sc.score[1] = v; }, 'Their score');
    const scoreRow = el('div', 'pair');
    const lab = (t, i) => { const l = el('label', 'mini', t); l.htmlFor = i.id; const w = el('span', 'pi'); w.append(l, i); return w; };
    scoreRow.append(lab('You', sY), lab('Them', sO));
    const start = seg('start', [['snap', 'A snap'], ['kick', 'A kickoff']], () => sc.start, (v) => { sc.start = v; }, 'It starts with');
    const ball = seg('ball', [['you', 'You'], ['opp', 'Them']], () => sc.ball, (v) => { sc.ball = v; }, 'Who has the ball');
    const ballRow = row('Ball', ball);
    // the ball's spot, for the team that has it: its own 25 is 75 yards to go
    let own = !(sc.yl <= 50);           // (which half the ball is in, kept while the yard line is being typed)
    const side = seg('side', [['own', 'Own'], ['opp', 'Their']], () => (own ? 'own' : 'opp'), (v) => {
      own = v === 'own';
      const n = sc.yl > 50 ? 100 - sc.yl : sc.yl;
      if (Number.isFinite(n)) sc.yl = own && n < 50 ? 100 - n : n;
    }, 'Side of the field');
    const ylIn = num('yl', 1, 50, () => (sc.yl > 50 ? 100 - sc.yl : sc.yl), (v) => { sc.yl = !Number.isFinite(v) ? NaN : own && v < 50 ? 100 - v : v; }, 'Yard line');
    const spotRow = row('On the', side, ylIn);
    const down = seg('down', [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th']], () => sc.down, (v) => { sc.down = v; }, 'Down');
    const ytg = num('ytg', 1, 40, () => sc.ytg, (v) => { sc.ytg = v; }, 'Yards to go');
    const ddRow = row('Down', down), ytgRow = row('To go', ytg);
    const toY = seg('toY', [[0, '0'], [1, '1'], [2, '2'], [3, '3']], () => sc.to[0], (v) => { sc.to[0] = v; }, 'Your timeouts');
    const toO = seg('toO', [[0, '0'], [1, '1'], [2, '2'], [3, '3']], () => sc.to[1], (v) => { sc.to[1] = v; }, 'Their timeouts');
    const otp = seg('otp', [[0, 'First possession'], [1, 'They’ve had it'], [2, 'Both have']], () => sc.otp, (v) => { sc.otp = v; }, 'Overtime possessions');
    const otRow = row('Overtime', otp);
    const end = seg('end', [['half', 'Ends at the half'], ['game', 'Whole game']], () => sc.end, (v) => { sc.end = v; }, 'Play to');
    const r2h = seg('r2h', [['you', 'You'], ['opp', 'Them']], () => sc.r2h, (v) => { sc.r2h = v; }, 'Ball after halftime');
    const endRow = row('Play to', end), r2hRow = row('After half', r2h);
    const gS = fieldset('Situation');
    gS.append(row('Quarter', qtr), row('Clock', clk), row('Score', scoreRow), row('Starts with', start), ballRow, spotRow, ddRow, ytgRow,
      row('Your TOs', toY), row('Their TOs', toO), otRow, endRow, r2hRow);
    const errs = el('ul', 'serr');
    errs.setAttribute('aria-live', 'polite');
    const sum = el('div', 'ssum');
    const go = el('button', 'btn alt', isPro() ? 'Kick off' : 'Kick off (Pro)'), link = el('button', 'btn ghostbtn', 'Copy the link'), reset = el('button', 'linkbtn', 'Start from scratch');
    const post = el('button', 'btn ghostbtn', 'Post to Community'), posted = el('p', 'note spost');
    go.type = 'button'; link.type = 'button'; reset.type = 'button'; post.type = 'button';
    posted.setAttribute('aria-live', 'polite');
    go.addEventListener('click', () => {
      if (!SCN.ok(sc, ix)) return;
      const t = SCN.tidy(sc), c = SCN.code(t);
      if (isPro()) scenTouch(c, t.title);
      track('scenario_start', { type: sc.type, qtr: sc.qtr, kick: sc.start === 'kick', eras: `${sc.ys}-${sc.os}`, pro: isPro(), titled: !!t.title });
      location.hash = `#custom-${SCN.link(t)}`;
    });
    link.addEventListener('click', () => { if (SCN.ok(sc, ix)) shareText(scenLink(SCN.link(SCN.tidy(sc))), sum, 'scenario'); });
    post.addEventListener('click', () => commPost(() => SCN.ok(sc, ix) && SCN.tidy(sc), post, posted, ttl));
    reset.addEventListener('click', () => { try { localStorage.removeItem(SCN_DRAFT); } catch (e) { /* storage off */ } sc = scenDraft(ix); changed(); });
    const acts = el('div', 'row sacts');
    acts.append(go, link, post);
    const syncs = [ttl.sync, you.sync, opp.sync, typeSel.sync, site.sync, rules.sync, qtr.sync, clk.sync, sY.sync, sO.sync, start.sync, ball.sync, side.sync, ylIn.sync,
      down.sync, ytg.sync, toY.sync, toO.sync, otp.sync, end.sync, r2h.sync, luY.sync, luO.sync];
    function changed(full = true) {
      if (full && Number.isFinite(sc.yl) && sc.yl !== 50) own = sc.yl > 50;
      if (full) { you.sync(); opp.sync(); luKeep(); }          // (a team the season has not got moves to one it has: its picks go)
      if (full) syncs.forEach((f) => f());
      rulesRow.hidden = sc.ys === sc.os;
      const bs = rules.querySelectorAll('button');
      bs[0].textContent = `Yours (${sc.ys})`; bs[1].textContent = `Theirs (${sc.os})`;
      const kick = sc.start === 'kick';
      ballRow.querySelector('.sl').textContent = kick ? 'Receiving' : 'Ball';
      spotRow.hidden = kick; ddRow.hidden = kick; ytgRow.hidden = kick;
      otRow.hidden = sc.qtr !== 5;
      endRow.hidden = sc.qtr > 2; r2hRow.hidden = sc.qtr > 2 || sc.end === 'half';
      [toY, toO].forEach((g) => g.querySelectorAll('button').forEach((b) => { b.hidden = sc.qtr === 5 && Number(b.dataset.v) > SCN.otTo(sc); }));
      // (the lineups on the seasons' rosters once both are in; a pick waits for its roster to be checked)
      const rY = SCN_ROSV[sc.ys], rO = SCN_ROSV[sc.os];
      const bad = SCN.check(sc, ix).concat(rY && rO ? SCN.checkLineup(sc, rY, rO) : sc.lu ? [['lu', 'Getting the rosters…']] : []);
      errs.textContent = '';
      bad.forEach(([, m]) => errs.append(el('li', '', m)));
      form.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('bad', bad.some(([f]) => f === x.dataset.f || (f === 'score' && /^score/.test(x.dataset.f)) || (f === 'to' && /^to/.test(x.dataset.f)))));
      go.disabled = link.disabled = post.disabled = !!bad.length;
      sum.textContent = '';
      if (!bad.length) sum.append(scenSummaryEl(SCN.tidy(sc), ix));
      save(SCN_DRAFT, sc);
      if (sc.lu && !(rY && rO)) Promise.all([scnRoster(sc.ys), scnRoster(sc.os)]).then(() => changed(false), () => {});
    }
    form.append(gN, gT, gL, gG, gS);
    box.append(el('h3', '', 'Start from'), pre, form, errs, sum, acts, posted, reset);
    box.append(el('p', 'note', `Seasons ${first}–${last}: each team as it lined up in a game late in its regular season (the latest for this season, ${last}, through week ${ix.seasons[ix.seasons.length - 1].thru}), with every player rated as of then, its quarterback, kicker and punter, and its strength. Before ${first} nothing names who started on the line, so those seasons are left out. The overtime is the one of its time; the playoffs never end tied. Scenarios post to no leaderboard: they aren’t the same for everyone. Posted to Community, a scenario shows how many have played it and how many won.`));
    // My scenarios
    box.append(el('h3', '', 'My scenarios'));
    const mine = el('div', 'days');
    const list = Object.entries(scenList()).filter(([c, e]) => e && !e.gone && SCN.parse(c)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    if (!list.length) mine.append(el('p', 'note', isPro() ? 'The scenarios you play show here, with your best grade on each. Signed in, they follow you to any device.' : 'Your scenarios show here once you play them.'));
    list.forEach(([c, e]) => {
      const s0 = SCN.parse(c), L = scenLines(s0, ix), a = el('a', 'day drive scn'), x = el('button', 'scnx', '×');
      const tt = e.title ? SCN.cleanTitle(e.title) : '';
      a.href = `#custom-${SCN.link({ ...s0, title: tt })}`;
      const right = typeof e.p === 'number' ? el('span', 'gr') : el('span', 'sc', 'Play');
      if (typeof e.p === 'number') right.append(gradeBadge(Math.round(e.p * 100)), el('small', '', String(Math.round(e.p * 100))));
      a.append(el('b', '', tt || L.title), el('span', 'm', tt ? `${L.title} · ${L.sub}` : L.sub), right);
      x.type = 'button'; x.setAttribute('aria-label', `Remove ${L.title}`);
      x.addEventListener('click', () => {
        const all = scenList();
        all[c] = { ...(all[c] || {}), at: Date.now(), gone: true };
        scenSave(all); statsSync(true);
        wrap.remove();
      });
      const wrap = el('div', 'scnrow');
      wrap.append(a, x);
      mine.append(wrap);
    });
    box.append(mine);
    changed();
    scnRoster(sc.ys).catch(() => {});          // (the files the Kick off will want, while the builder is read)
    if (sc.os !== sc.ys) scnRoster(sc.os).catch(() => {});
  }
  // the end of a scenario: its grade (an A, the game won, passes it, as a historic drive), your best and tries
  function scenCard(p, rec) {
    const score = Math.round(p * 100), g = gradeOf(score), sc = today[0], hard = mustWin();
    const r0 = state.spots[0] && state.spots[0].result, won = !!(r0 && r0.mine > r0.theirs);
    const box = el('div', `gradecard ${g.c}`), top = el('div', 'gtop'), txt = el('div', 'gtxt');
    txt.append(el('div', 'gk', `Your scenario · ${CUSTOM_TITLE || matchLine(sc)}`), el('div', 'gres', g.pass ? 'Passed' : hard && !won ? 'Win it to pass' : score >= PASS_AT - 10 ? 'So close' : 'Not yet'),
      el('div', 'gsc', `${score} · better than ${score}% of NFL play‑callers, the calls and the result`));
    top.append(el('div', 'gbig', g.L), txt);
    box.append(top);
    const bar = el('div', 'gbar'), fill = el('i');
    fill.style.width = `${Math.min(100, score)}%`;
    bar.append(fill, el('b', 'gmark'));
    bar.setAttribute('aria-hidden', 'true');
    box.append(bar);
    const lines = [];
    if (scoreWhy(p)) lines.push(scoreWhy(p));
    if (!g.pass) lines.push(hard && !won ? `A pass takes winning the game: a loss or a tie tops out at ${PASS_AT - 1}.` : `${PASS_AT} passes: ${PASS_AT - score} more ${PASS_AT - score === 1 ? 'point' : 'points'}.`);
    const pb = rec && rec.pb;
    if (typeof pb === 'number' && pb * 100 >= score + 0.5) lines.push(`Your best here: ${Math.round(pb * 100)} (${gradeOf(Math.round(pb * 100)).L}).`);
    else if (typeof pb === 'number' && score > Math.round(pb * 100)) lines.push(`New best: up from ${Math.round(pb * 100)}.`);
    if (rec && rec.tries > 1) lines.push(`Try ${rec.tries}.`);
    if (lines.length) box.append(el('p', 'gnote', lines.join(' ')));
    if (SCN_IDX && sc.scn) {
      const d = el('details', 'greal');
      d.append(el('summary', '', 'The scenario'));
      SCN_IDX.then((ix) => d.append(scenSummaryEl(sc.scn, ix))).catch(() => {});
      box.append(d);
    }
    return box;
  }
  function scenActions(rec) {
    const row = el('div', 'row pacts');
    const again = el('button', 'btn', rec && rec.p * 100 >= PASS_AT - 0.5 ? 'Play it again' : 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => { try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ } track('scenario_retry', {}); location.reload(); });
    const edit = el('a', 'btn ghostbtn', 'Change the scenario');
    edit.href = '#custom';
    edit.addEventListener('click', () => { save(SCN_DRAFT, today[0].scn); });
    const share = el('button', 'btn ghostbtn', 'Send it to a friend');
    share.type = 'button';
    share.addEventListener('click', () => shareText(`Can you win this one?${CUSTOM_TITLE ? ` “${CUSTOM_TITLE}”:` : ''} ${matchLine(today[0])}, ${typeSay(today[0].real.type)}. Two-Minute Drill Pro:\n${scenLink(SCN.link({ ...today[0].scn, title: CUSTOM_TITLE }))}`, share, 'scenario'));
    const all = el('a', 'btn ghostbtn', 'My scenarios');
    all.href = '#custom';
    row.append(again, edit, share, all);
    return row;
  }

  // ------------------------------------------------------ community scenarios ---
  // #community (board/worker.js /scen/*): scenarios players built and posted under a title, by their username. Anyone
  // can read the list (most played, hot, new; COMM_PAGE a page); a tap opens the scenario's link (#custom-<code>~<title>),
  // which plays it with Pro and is the Pro pitch without. Posting (the builder's Post to Community) takes an account with a
  // username and a title; the board refuses a title or name blocked() and more than a few posts a day, and keeps a post
  // of the same scenario (its code) once. A try of a posted scenario counts a play when it starts and a finish (won or
  // not, its score) when it ends, once a day a device or account (commPlay: every scenario played asks; one not posted
  // counts nothing).
  const COMM_SORT_KEY = `${STORE}:commsort`, COMM_SORTS = { top: 'Most played', hot: 'Hot', new: 'New' };
  function commPlay(extra) {
    if (!CUSTOM) return;
    (async () => {
      await BOARD.ready;
      if (!BOARD.api) return;
      const r = await fetch(`${BOARD.api}/scen/play`, POST_JSON({ code: CUSTOM, key: deviceKey(), ...withSession(), ...(extra || {}) }));
      const d = r.ok ? await r.json() : {};
      if (d.counted) track(extra && extra.done ? 'scen_comm_finish' : 'scen_comm_play', extra && extra.done ? { won: !!extra.won } : {});
    })().catch(() => { /* never in the way of the game */ });
  }
  // the Pro screen's way in, under Build a scenario
  function commEntry() {
    const a = el('a', 'scnentry comm');
    a.href = '#community';
    a.append(el('span', 'k', 'Community'), el('b', '', 'Scenarios players built'),
      el('span', 'm', 'Play what other players set up and see how many have played each one and how many won. Post yours from the builder.'),
      el('span', 'cta', 'Browse'));
    return a;
  }
  // the builder's Post to Community: a title, an account and a username first (each asked for in turn), then the board
  async function commPost(get, btn, out, ttl) {
    const sc = get();
    if (!sc) return;
    const say = (t, bad) => { out.textContent = t; out.classList.toggle('bad', !!bad); };
    if ((sc.title || '').length < 3) {
      say('Give it a title first (3 to 40 characters): it is what people see on the list.', true);
      ttl.classList.add('bad'); ttl.focus();
      return;
    }
    if (SCN.blocked(sc.title)) { say('That title is not allowed: pick another.', true); ttl.focus(); return; }
    await BOARD.ready;
    if (!BOARD.api || !(await authCfg())) { say(`Posting needs the website’s backend: try again on ${HOME}.`, true); return; }
    if (!signedIn()) {
      if (!authSession()) { signInSheet(el('p', 'lead', 'Your scenario goes on the list under your username: log in or sign up to post it.')); return; }
      await proVerify();
      if (!signedIn()) { signInSheet(el('p', 'lead', 'Log in again to post it.')); return; }
    }
    if (!ACCT.me.name) { nameSheet(true, () => commPost(get, btn, out, ttl)); return; }
    btn.disabled = true;
    say('Posting…');
    try {
      const d = await proApi('/scen/post', { session: authSession(), code: SCN.code(sc), title: sc.title });
      track('scen_post', { existing: !!d.existing, type: sc.type, qtr: sc.qtr });
      out.textContent = '';
      out.classList.remove('bad');
      const see = el('a', '', 'See it on Community');
      see.href = '#community';
      out.append(d.existing ? `Already posted${d.row.title !== sc.title ? ` as “${d.row.title}”` : ''} by ${d.row.name}. ` : `Posted as “${d.row.title}”. `, see);
    } catch (e) {
      if (/signed out/i.test(e.message)) { authLost(); acctBar(); signInSheet(el('p', 'lead', 'Log in again to post it.')); say(''); }
      else say(e.message, true);
    }
    btn.disabled = false;
  }
  async function renderCommunity() {
    show('arch');
    track('scen_comm_open', { pro: isPro() });
    const box = $('arch');
    box.textContent = '';
    const back = el('a', 'linkbtn', '← Pro');
    back.href = '#archive';
    box.append(back, el('h2', '', 'Community scenarios'), el('p', 'lead', `Scenarios other players built: their teams, their situation. Tap one to play it${isPro() ? '' : ' (playing is part of Pro)'}.`));
    const build = el('a', 'linkbtn', 'Build and post your own');
    build.href = '#custom';
    box.append(build);
    let sort = load(COMM_SORT_KEY, 'top');
    if (!COMM_SORTS[sort]) sort = 'top';
    const tabs = el('div', 'seg csort');
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Sort by');
    const list = el('div', 'days clist'), more = el('button', 'btn ghostbtn', 'Load more'), note = el('p', 'note');
    list.setAttribute('aria-live', 'polite');
    more.type = 'button'; more.hidden = true;
    Object.entries(COMM_SORTS).forEach(([k, t]) => {
      const b = el('button', '', t);
      b.type = 'button'; b.dataset.v = k;
      b.addEventListener('click', () => { if (sort === k) return; sort = k; save(COMM_SORT_KEY, k); track('scen_comm_sort', { sort: k }); fill(0); });
      tabs.append(b);
    });
    box.append(tabs, list, more, note);
    await BOARD.ready;
    let ix;
    try { ix = await scnIndex(); } catch (e) { list.append(el('p', 'note', `The rosters did not load (${e.message}). Check your connection and reload.`)); return; }
    if (!BOARD.api) { list.append(el('p', 'note', 'The community list needs the website’s backend.')); return; }
    let page = 0, ask = 0;
    const row = (x) => {
      const sc = SCN.parse(x.code);
      if (!sc || !SCN.ok(sc, ix)) return null;          // (a season the site no longer has)
      const L = scenLines(sc, ix), a = el('a', 'day drive scn comm');
      a.href = `#custom-${SCN.link({ ...sc, title: x.title })}`;
      a.addEventListener('click', () => track('scen_comm_tap', { sort, n: x.n, pro: isPro() }));
      const won = x.f ? Math.round((100 * x.w) / x.f) : null;
      const stats = `by ${x.name} · ${x.n} ${x.n === 1 ? 'play' : 'plays'}${won !== null ? ` · ${won}% won` : ''}${typeof x.best === 'number' ? ` · top grade ${gradeOf(Math.round(x.best * 100)).L}` : ''}`;
      const mine = (scenList()[x.code] || {});
      const right = typeof mine.p === 'number' ? el('span', 'gr') : el('span', 'sc', isPro() ? 'Play' : 'Pro');
      if (typeof mine.p === 'number') right.append(gradeBadge(Math.round(mine.p * 100)), el('small', '', String(Math.round(mine.p * 100))));
      a.append(el('b', '', x.title), el('span', 'm', `${L.title} · ${L.sub}`), el('span', 'm cst', stats), right);
      if (!x.mine) return a;
      const wrap = el('div', 'scnrow'), del = el('button', 'scnx', '×');
      del.type = 'button'; del.setAttribute('aria-label', `Take down ${x.title}`);
      del.addEventListener('click', async () => {
        if (!confirm(`Take “${x.title}” off Community? Its plays go with it.`)) return;
        try { await proApi('/scen/delete', { session: authSession(), id: x.id }); track('scen_comm_delete'); wrap.remove(); toast('Taken down'); } catch (e) { toast(e.message); }
      });
      wrap.append(a, del);
      return wrap;
    };
    async function fill(p) {
      const n = ++ask;
      tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === sort)));
      if (!p) { list.textContent = ''; list.append(el('p', 'note', 'Loading…')); }
      more.disabled = true;
      let d;
      try {
        const r = await fetch(`${BOARD.api}/scen/list`, POST_JSON({ sort, page: p, ...withSession() }));
        if (!r.ok) throw new Error(`list ${r.status}`);
        d = await r.json();
      } catch (e) {
        if (n !== ask) return;
        if (!p) list.textContent = '';
        list.append(el('p', 'note', `The list did not load (${e.message}). Check your connection and try again.`));
        more.disabled = false;
        return;
      }
      if (n !== ask) return;            // (a newer sort asked since)
      if (!p) list.textContent = '';
      d.rows.map(row).filter(Boolean).forEach((x) => list.append(x));
      if (!p && !list.children.length) list.append(el('p', 'note', 'Nothing posted yet. Build one and be the first: tap Post to Community in the builder.'));
      page = p; more.hidden = d.next == null; more.disabled = false;
      note.textContent = d.total ? `${d.total} ${d.total === 1 ? 'scenario' : 'scenarios'} posted. A play counts once a day a player; “won” is the share of finished tries that won the game.` : '';
    }
    more.addEventListener('click', () => fill(page + 1));
    await fill(0);
  }

  // -------------------------------------------------------------- versus ---
  // Two players, college overtime (web/vs_core.js: the toss choice, the ball at the 25, a touchdown going for two from
  // the 2nd overtime, two-point plays from the 3rd). Each brings a team; the team with the ball calls the offense, the
  // other the defense, each on their own phone. The room (board/match.js) plays the football: this phone sends its
  // half of each decision, sealed until every half is in; the room plays the snap with the engine and sends the
  // result to both phones, which animate it. The room keeps the play clock and the score, calls forfeits and rates
  // ranked matches; a phone only ever sends a call. Modes: ranked (the ladder: matched by rating), casual, a friend.
  const VS_TEAM_KEY = `${STORE}:vsteam`;
  const VS_MODES = { ranked: 'Ranked', casual: 'Casual', friend: 'Friend match', cpu: 'Versus the computer' };
  const VS_CPU_KEY = `${STORE}:vscpu`, VS_CPU_LEVELS = { rookie: 'Rookie', pro: 'Pro' };
  const vsCpuLevel = () => (VS_CPU_LEVELS[load(VS_CPU_KEY, 'pro')] ? load(VS_CPU_KEY, 'pro') : 'pro');
  const VS_CPU_DECIDE_MS = 10 * 60e3;       // against the computer: no play clock to speak of (match.js CPU_DECIDE_MS)
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
        if (vs.ui === 'prompt' && G && G.vsN === m.n) { clearInterval(vs.timer); vs.ui = 'idle'; status(vs.mode === 'cpu' ? 'Locked in. Snapping…' : 'Locked in. Waiting for your opponent…'); vsDrawBar(); }
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
    // (the match over: their leaving ends the rematch, said on its key, not left waiting for nobody)
    const rk = $('vsAgain');
    if (rk && vs.phase === 'over' && vs.mode !== 'cpu' && vs.online && !vs.online[1 - vs.seat]) { rk.disabled = true; rk.textContent = 'They left'; rk.classList.remove('ask'); }
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
    ezDrive(true);                      // (a match on: no full-screen ad or floating video over it, like a drive)
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
    const seen = load(`${STORE}:vsintro`, 0);
    save(`${STORE}:vsintro`, seen + 1);
    if (seen >= 2) {          // (you know the rules: who chooses, and go)
      box.append(el('p', 'story', first === G.me ? 'You won the toss: offense, defense or the end of the field.' : `${teamName(op)} won the toss and chooses first.`));
    } else box.append(el('p', 'story', `Each team gets the ball at the other’s 25, no clock. From the second overtime, a touchdown has to go for two; from the third, it’s a two-point play each. Ahead after both teams have had it, you win. ${first === G.me ? 'You won the toss: you choose offense, defense or the end of the field.' : `${teamName(op)} won the toss and chooses first.`} The choice alternates every overtime.`));
    if (seen < 2) box.append(el('div', 'who', vs.mode === 'cpu' ? 'You call your side: the offense when you have it, the defense when they do. No play clock against the computer: take your time.'
      : 'You call your side: the offense when you have it, the defense when they do. Both calls lock in before the snap. You get 30 seconds a call; miss two in a row and you forfeit.'));
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
      const lead = vs.taken ? `Your opponent already has ${teamName(vs.taken)}. Pick another team.` : 'Pick your team for this match: its real lineup this week.';
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
    // nobody to play after a while (match.js CPU_AFTER_S): the computer, one tap (never rated), or keep waiting
    const cpu = el('button', 'btn', 'Play the computer now');
    cpu.type = 'button'; cpu.hidden = true;
    cpu.append(el('small', '', 'Unranked · starts right away'));
    cpu.addEventListener('click', () => {
      if (!ws || ws.readyState !== 1) return;          // (ws: the queue's socket, below)
      cpu.disabled = true;
      track('vs_cpu', { mode, secs: Math.round((Date.now() - t0) / 1000) });
      try { ws.send(JSON.stringify({ t: 'cpu', level: vsCpuLevel() })); } catch (e) { cpu.disabled = false; }
    });
    box.append(el('h2', '', VS_MODES[mode]), el('p', 'note', `Your team: ${teamName(vsMyTeam())}`), line, info, cpu, cancel);
    let ws, closed = false, tries = 0, size = 0, rating = 0;
    const done = () => { closed = true; clearInterval(tk); try { ws && ws.close(); } catch (e) { /* gone */ } };
    const draw = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      info.textContent = `${size > 1 ? `${size} players searching` : 'Searching'} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${mode === 'ranked' && rating ? ` · your rating ${rating}` : ''}`;
      if (mode === 'ranked' && s > 25) line.textContent = 'Widening the search…';
      if (s > 90 && cpu.hidden) line.textContent = 'Not many players on right now. Keep waiting, or play a friend.';
    };
    const tk = setInterval(draw, 1000);
    cancel.addEventListener('click', () => { done(); track('vs_queue_cancel', { mode, secs: Math.round((Date.now() - t0) / 1000) }); renderVsLobby(); });
    const open = () => {
      if (closed) return;
      const q = new URLSearchParams({ key: deviceKey(), mode, team: vsMyTeam(), name: myName(), ...(mode === 'cpu' ? { level: vsCpuLevel() } : {}) });
      try { ws = new WebSocket(`${BOARD.api.replace(/^http/, 'ws')}/vs/queue?${q}`); } catch (e) { return setTimeout(open, 2000); }
      vs.q = ws;
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'queued') {
          size = m.size; rating = m.rating; tries = 0; draw();
          if (m.cpu && cpu.hidden) { cpu.hidden = false; line.textContent = 'Nobody free right now. Keep waiting, or play the computer.'; track('vs_cpu_offer', { mode }); }
        }
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
    box.append(el('h2', '', 'Versus'), el('p', 'lead', 'College overtime against another player, or the computer: each team gets the ball at the other’s 25, no clock. You call your offense and your defense; both calls lock in before the snap.'));
    const pick = el('div', 'vspick');
    // (your team in one line with Change, the 32 only when you pick: the Play keys were under them on a phone. A
    // fanbase pick, Your team, is your Versus team until you choose another)
    const fan = load(FAN_KEY, null);
    if (!vsMyTeam() && fan && TEAMS[fan] && !COLLEGE.has(fan)) save(VS_TEAM_KEY, fan);
    let open = !vsMyTeam();
    const drawPick = () => {
      pick.textContent = '';
      const t = vsMyTeam();
      if (t && !open) {
        const row = el('div', 'vsteamrow'), sw = el('span', 'sw'), ch = el('button', 'chip', 'Change');
        sw.style.background = color(t);
        ch.type = 'button';
        ch.addEventListener('click', () => { open = true; drawPick(); });
        row.append(sw, el('b', '', `Your team: ${teamName(t)}`), ch);
        pick.append(row);
        return;
      }
      pick.append(el('h3', '', t ? `Your team: ${teamName(t)}` : 'Pick your team'), vsTeamPicker(() => { open = false; drawPick(); }));
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
    // (casual first: a quick match, no rating; ranked's first 10 games are placement, a rating that moves faster)
    [['casual', 'Play now', 'Quick match, no rating'], ['ranked', 'Ranked', 'Win to climb the ladder'], ['cpu', 'Computer', 'Starts right away, no rating'],
      ['friend', 'Friend', 'Send a link']].forEach(([m, label, sub]) => {
      const b = el('button', `btn${m === 'friend' || m === 'cpu' ? ' ghostbtn' : ''}`);
      b.type = 'button';
      b.append(document.createTextNode(label), el('small', '', sub));
      b.disabled = !BOARD.api;
      b.addEventListener('click', () => go(m));
      modes.append(b);
    });
    drawPick();
    const meLine = el('p', 'note vsme', '');
    const lv = el('div', 'opts-row vslevel');
    lv.append(el('span', 'lab', 'Computer'));
    const drawLv = () => {
      [...lv.querySelectorAll('button')].forEach((b) => b.remove());
      Object.entries(VS_CPU_LEVELS).forEach(([k, label]) => {
        const b = el('button', `chip opt${vsCpuLevel() === k ? ' on' : ''}`, label);
        b.type = 'button'; b.setAttribute('aria-pressed', String(vsCpuLevel() === k));
        b.title = k === 'rookie' ? 'Deep shots on any down, early field goals and a soft defense' : 'Calls plays the way NFL play-callers do';
        b.addEventListener('click', () => { save(VS_CPU_KEY, k); track('vs_cpu_level', { level: k }); drawLv(); });
        lv.append(b);
      });
    };
    drawLv();
    box.append(pick, meLine, modes, lv);
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
      const you = me.games ? `You: ${me.rating}${me.rank ? ` · #${me.rank}` : ''} · ${me.w}–${me.l}${streak}${me.provisional ? ` · placement (${me.games} of 10)` : ''}` : 'You: 1000 · no ranked games yet';
      lad.append(el('p', 'note', you));
      meLine.textContent = `Ranked: ${you.replace(/^You: /, '')}`;      // (up top too: the ladder is at the foot)
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
    if (vs.ui === 'prompt' && vsMyDl() && vs.mode !== 'cpu') {          // (the computer: take your time)
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
      vs.dl[vs.seat] = Math.min(vs.dl[vs.seat], vsNow() + (vs.mode === 'cpu' ? VS_CPU_DECIDE_MS : VS_DECIDE_MS));
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
  // what goes to the room: the call only (what the room's cleanAction keeps, vs_core.js), never a drawing. The drawing
  // stays on this phone, for the animation of its own play when the room plays that call (vsApply)
  const VS_SEALED = ['to_off', 'to_def', 'play', 'call', 'oob', 'pers', 'route', 'who', 'philly', 'pat', 'tempo', 'looks'];
  const DRAW_ONLY = ['path', 'carrier', 'shape', 'drawn', 'routes', 'target', 'targetName', 'targetPos', 'pa', 'roll', 'qbPath', 'ddraw', 'open'];
  function vsSealed(half) {
    if (!half || !half.action) return half;
    const a = {};
    VS_SEALED.forEach((k) => { if (half.action[k] !== undefined) a[k] = half.action[k]; });
    return { ...half, action: a };
  }
  // your half of the decision: once, sealed until the other side's is in
  function vsSubmit(half, local) {
    const n = G.vsN;
    if (vs.waiting === n || vs.n !== n || vs.phase !== 'live') return;
    clearInterval(vs.timer);
    vs.waiting = n;
    const src = { ...(half.action || {}), ...(local || {}) }, draw = {};
    DRAW_ONLY.forEach((k) => { if (src[k] !== undefined) draw[k] = src[k]; });
    vs.drawn = Object.keys(draw).length ? { n, draw, call: half.action && half.action.call, dc: half.dc } : null;
    vs.last = { t: 'half', n, half: vsSealed(half) };
    vsSend(vs.last);
    vs.ui = 'idle';
    status(vs.mode === 'cpu' ? 'Locked in. Snapping…' : 'Locked in. Waiting for your opponent…');
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
      const res = d.res, side = G.side, dw = vs.drawn;
      // your own drawing, on the call the room played (not the default, when the call came in too late)
      if (dw && dw.n === d.n && res.action && (dw.call ? res.action.call === dw.call : !!dw.dc && sameDc(res.action.dc, dw.dc))) res.action = { ...dw.draw, ...res.action };
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
    say(`${txt.firstChild.textContent}. ${lines.length ? lines[0][0] : ''}`);          // (said once: showResult)
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
    // (the computer: no clock behind the card, so it gives way after a moment, as a play's card does)
    vs.cardTimer = setTimeout(go, vs.result ? 8000 : vs.mode === 'cpu' ? 9000 : Math.max(4000, vs.deadline - VS_DECIDE_MS - vsNow()));     // the last play: then the final
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
      else status(r.phase === PAT ? `${teamName(code(r.pos))} lines up for the try…` : 'Waiting for your opponent…');
      vsDrawBar();
      return 'stop';
    }
    if (vs.waiting === G.vsN) { vs.ui = 'idle'; status(vs.mode === 'cpu' ? 'Locked in. Snapping…' : 'Locked in. Waiting for your opponent…'); vsDrawBar(); return 'stop'; }
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
    head.append(el('h2', '', c.pick.end ? 'You took the end of the field' : c.round === 1 ? `${nm} won the toss` : `${ordinal(c.round)} overtime`),
      el('span', 'sub', `${nm} chooses ${c.pick.end ? 'offense or defense' : 'offense, defense or the end of the field'}…`));
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
    const sc = `${mine}\u2060–\u2060${theirs}`;          // (the score on one line: "0–" and "3" wrapped apart)
    const head = res.by === 'score' ? (won ? `You win ${sc}${ot}` : `You lose ${sc}${ot}`)
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
      again.addEventListener('click', () => { again.disabled = true; again.textContent = vs.mode === 'cpu' ? 'Setting up…' : 'Waiting for your opponent…'; vsSend({ t: 'rematch' }); });
      if (vs.mode !== 'cpu' && vs.online && !vs.online[1 - vs.seat]) { again.disabled = true; again.textContent = 'They left'; }
      row.append(again);
    }
    const next = el('a', 'btn ghostbtn', 'New match');
    next.href = '#vs';
    row.append(next);
    card.append(row);
    // the result to a group chat (how a two-player game gets its next player): the score, who, and the way in
    if (res.by === 'score') {
      const opp = vs.mode === 'cpu' ? 'the computer' : vs.names[1 - vs.seat] || 'my opponent';
      const text = `${won ? `I beat ${opp}` : `${opp === 'the computer' ? 'The computer' : opp} beat me`} ${won ? `${mine}–${theirs}` : `${theirs}–${mine}`}${ot} on Two-Minute Drill Versus (${teamName(code(G.me))} vs ${teamName(code(1 - G.me))}). ${won ? 'Think you can beat me?' : 'Get me a rematch.'} https://${SITE}/#vs`;
      const pre = el('p', 'note sharetext', text), sh = el('button', 'btn ghostbtn', 'Share the result');
      sh.type = 'button';
      sh.addEventListener('click', () => shareText(text, pre, 'vs_result'));
      card.append(sh);
    }
    // between matches: the card's ad (and a full-screen one at most every 10 minutes, ezBreak), never during one
    ezDrive(false);
    const ad = adBox('done');
    if (ad) card.append(ad);
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
  // the rare-coach find is gone: a day kept from it keeps its score, without the coach, the code or the badge
  function rareGone() {
    try {
      const st = load(`${STORE}:stats`, null);
      if (st && st.days && Object.values(st.days).some((d) => d && d.madden)) {
        for (const d of Object.values(st.days)) if (d && d.madden) { delete d.madden; d.coach = null; }
        if (st.badges) delete st.badges.madden;
        save(`${STORE}:stats`, st);
      }
    } catch (e) { /* storage off: nothing kept */ }
  }
  async function boot() {
    gauntletFresh();
    rareGone();
    const topH = () => document.documentElement.style.setProperty('--top-h', `${document.querySelector('.top').offsetHeight}px`);
    topH(); addEventListener('resize', topH);
    $('helpBtn').addEventListener('click', openHelp);
    fieldTaps();
    drawTaps();
    sheetSetup();
    boardInit();
    addEventListener('hashchange', () => location.reload());       // Daily <-> Survivor
    $(SURV ? 'modeSurv' : ARCH || ARCH_DAY || DRIVE || CUSTOM || CUSTOM_BUILD || COMMUNITY ? 'modeArch' : 'modeDaily').setAttribute('aria-current', 'page');
    $('modeArch').hidden = !PRO_ON;
    if (PRO_BUILT && !PRO_ON) {
      const at = () => { if (!PRO_ON && Date.now() >= PRO_AT) proLaunch(); };
      if (PRO_AT - Date.now() < 864e5) setTimeout(at, PRO_AT - Date.now() + 50);
      document.addEventListener('visibilitychange', at);      // (a background tab's timer runs late)
      setInterval(at, 15000);
    }
    $('modeVs').hidden = !VS_ON;
    if (VS || VS_LOBBY) { $('modeDaily').removeAttribute('aria-current'); $('modeVs').setAttribute('aria-current', 'page'); }
    $('statsBtn').addEventListener('click', openStats);
    // (a tap on the scoreboard where it sits over the field while a play runs is a tap on the play: a phone's, or one
    // stuck to the top of a page scrolled down; it skips it as a tap anywhere there does. The game's details came up
    // over the play)
    $('bar').addEventListener('click', (ev) => {
      if (!G) return;
      const f = $('field').getBoundingClientRect();
      if (ev.detail && cutAnim && $('field').classList.contains('playing') && ev.clientY >= f.top && ev.clientY <= f.bottom) { cutAnim(); return; }
      spotInfo();
    });
    $('restartBtn').addEventListener('click', restartAsk);
    $('deepBtn').addEventListener('click', () => { if (G) openDeep(); });
    $('persBtn').addEventListener('click', openPers);
    $('formBtn').addEventListener('click', openForm);
    speedBtn();
    $('deepClose').addEventListener('click', closeDeep);
    $('mClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', (e) => {
      // a sheet over the game keeps Tab inside it, last to first and back
      const box = !$('modal').hidden ? qs('#modal .box') : !$('deep').hidden ? $('deep') : null;
      if (e.key === 'Tab' && box) {
        const fs = [...box.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.getClientRects().length);
        const a = fs[0], z = fs[fs.length - 1], on = document.activeElement;
        if (a && (!box.contains(on) || (e.shiftKey ? on === a : on === z))) { e.preventDefault(); (e.shiftKey ? z : a).focus(); }
        return;
      }
      if (e.key === 'Escape') {
        if (!$('modal').hidden) closeModal();
        else if (!$('deep').hidden) closeDeep();
        else if (!$('bmenu').hidden) { $('menuBtn').click(); $('menuBtn').focus(); }
        else if (tip) tipDone();               // the tour's tip: Escape is Got it
        return;
      }
      if (box || e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, textarea, select'))) return;
      if ($('play').hidden) return;
      // a play running: Space or Enter cuts to its end, as a tap on the field does
      if ($('field').classList.contains('playing') && cutAnim && (e.key === ' ' || e.key === 'Enter') && !(e.target.closest && e.target.closest('button, a'))) {
        e.preventDefault(); cutAnim(); return;
      }
      // a keyboard: 1 to 4 make the big calls (the number on each key, game.html)
      const big = /^[1-9]$/.test(e.key) && [...$('dock').querySelectorAll('.key[data-n]')].find((b) => b.dataset.n === e.key);
      if (big && !big.disabled) { e.preventDefault(); big.focus({ preventScroll: true }); big.click(); }
    });
    dockKeys();
    let rz = null;
    // (not while a play runs: the redraw would wipe the animation; the next draw picks up the new size)
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (G && !$('play').hidden && !busy && !$('field').classList.contains('playing')) { lastBall = null; drawField(); } placeTo(); fitDock(fitKeys); snapFit(); }, 150); });
    show('boot');
    if (!(VS || VS_LOBBY || ARCH || ARCH_DAY || DRIVE || RUN_N || CUSTOM || CUSTOM_BUILD || COMMUNITY || HOME_PG)) fetchData();      // the daily, survivor, practice
    try {
      idx = await fetch(asset('game.json')).then((r) => { if (!r.ok) throw new Error('game data ' + r.status); return r.json(); });
      idx.calls.forEach((c) => { CALL[c.id] = c; });
      const now = new Date();
      dayN = ARCH_DAY || dayOf(now);
      await authLoginFromUrl();
      await unsubFromUrl();
      challengeFromUrl();
      await proClaimFromUrl();
      await proVerify();
      if (await challengeOpen(now) === 'stop') return;          // (a past day's: the archive for Pro, else its pitch)
      movedNote();
      const acct = acctInit();
      // home: asked for (#home), or a bare address (the front door); drawn again when the account is in (its button,
      // your leagues)
      if (HOME_PG || (!location.hash && !CH_LINK)) {
        renderHome(!HOME_PG);
        acct.then(() => { if (homeUp) renderHome(false, true); }).catch(() => {});
        return;
      }
      if (VS_LOBBY) { renderVsLobby(); return; }
      if (VS) {
        await BOARD.ready;
        if (!BOARD.api) { vsNote('Versus needs the website’s backend.'); return; }
        renderVsWaiting();
        vsConnect();
        return;
      }
      // a link to a drive or run there is none of (#run-0, #drive-99): to the Pro screen, which says so
      if (PRO_ON && /^#(drive|run)-\d+$/.test(location.hash) && !DRIVE && !RUN_N) { badProLink(); return; }
      // a scenario: the builder, or one to play (checked first; without Pro, what it is and the Pro pitch)
      // (from the builder's foot, a reload would land halfway down the page: a scenario opens at the top)
      if (CUSTOM || CUSTOM_BUILD || COMMUNITY) { try { history.scrollRestoration = 'manual'; } catch (e) { /* older browsers */ } scrollTo(0, 0); }
      if (CUSTOM_BUILD) { await renderBuilder(); return; }
      if (COMMUNITY) { await renderCommunity(); return; }
      if (PRO_ON && SCN && /^#custom-/.test(location.hash) && !CUSTOM) { scenBad(['A scenario’s code has 22 parts: this one is cut short or mistyped']); return; }
      let scnIx = null, scnSc = null;
      if (CUSTOM) {
        scnSc = SCN.parse(CUSTOM);
        if (scnSc && CUSTOM_TITLE) scnSc.title = CUSTOM_TITLE;
        try { scnIx = await scnIndex(); } catch (e) { scenBad([`The rosters did not load (${e.message}). Check your connection and reload`]); return; }
        const bad = !scnSc ? ['That is not a scenario’s code'] : SCN.check(scnSc, scnIx).map(([, m]) => m);
        if (bad.length) { scenBad(bad); return; }
        if (!isPro()) { await renderScenPitch(scnSc, scnIx); return; }
      }
      if (ARCH || (ARCH_DAY && (!isPro() || ARCH_DAY >= dayOf(now))) || ((DRIVE || RUN_N) && !isPro())) { await renderArchive(now); return; }
      if (SURV) {
        state = load(stateKey(), null) || newRun();
        if (!$('modal').hidden) { /* a question already up (the unsubscribe link's): the welcome waits for the next visit */ }
        else if (!load(`${STORE}:seen`, false)) { if (TOUR_OK) tourStart(true); else openHelp(true); save(`${STORE}:seen`, true); } else tourStart(false);
        startWorkers();
        if (state.out) renderSurvSummary(); else await survOpen();
        return;
      }
      // practice comes after the day's drive: before it, #practice is the day's drive (no reload: replaceState fires no hashchange)
      if (PRACTICE && !dayDone(dayN)) { PRACTICE = false; history.replaceState(null, '', location.pathname + location.search); }
      if (PRACTICE) {
        // (coming from the long end card, a reload would land halfway down the page: practice opens at the top)
        try { history.scrollRestoration = 'manual'; } catch (e) { /* older browsers: the click handlers scroll up */ }
        const top = () => scrollTo(0, 0);       // (and after the load, when a browser restores the old position)
        if (document.readyState === 'complete') top(); else addEventListener('load', () => setTimeout(top, 0), { once: true });
        state = practiceState();
        const teams = await loadTeams([state.pick]);
        today = [buildScen(idx.spots[state.pick], teams[state.pick])];
        $('dayLabel').textContent = `Practice · drive ${state.n}`;
      } else if (RUN_N) {
        PRO_RUNS = await loadRuns();
        const run = PRO_RUNS && PRO_RUNS.runs[RUN_N - 1];
        if (!run) { badProLink(); return; }
        const teams = await loadChunks('r', PRO_RUNS.spot_chunk, run.games.map((g) => g.spot));
        today = run.games.map((g) => {
          const sc = buildScen(PRO_RUNS.spots[g.spot], teams[g.spot]);
          eraTeams(sc);
          sc.story = `${g.round}, ${g.home || g.round === 'Super Bowl' ? 'vs' : 'at'} ${teamName(g.opp)}. That day ${teamName(run.team)} ${g.won ? 'won' : 'lost'} ${g.score}.`;
          return sc;
        });
        $('dayLabel').textContent = `Run · ${run.title}`;
      } else if (CUSTOM) {
        const [ry, ro] = await Promise.all([scnRoster(scnSc.ys), scnRoster(scnSc.os)]);
        // (its lineup picks on the seasons' rosters: a player no longer on one, the link says so)
        const lb = SCN.checkLineup(scnSc, ry, ro);
        if (lb.length) { scenBad(lb.map(([, m]) => m)); return; }
        const { spot, teams } = SCN.spotOf(scnSc, ry, ro, scnIx.spread);
        // (the franchise's city of the time: St. Louis before Los Angeles)
        for (const [c, y] of [[scnSc.you, scnSc.ys], [scnSc.opp, scnSc.os]]) { const t = scnTeam(scnIx, c, y); if (t && t.era && TEAMS[c]) TEAMS[c] = [t.era.name, TEAMS[c][1]]; }
        today = [buildScen(spot, teams)];
        today[0].scn = scnSc;
        const S = scenLines(scnSc, scnIx).S;
        today[0].story = `${S.game[0].toUpperCase()}${S.game.slice(1)}. ${scnName(scnIx, scnSc.you, scnSc.ys)} (${scnTeam(scnIx, scnSc.you, scnSc.ys).record}) against ${scnName(scnIx, scnSc.opp, scnSc.os)} (${scnTeam(scnIx, scnSc.opp, scnSc.os).record}). ${S.ot}.`;
        const luSay = SCN.lineupSay(scnSc, ry, ro, (c, y) => scnNick(scnIx, c, y));
        if (luSay.length) today[0].story += ` ${luSay.join('. ')}.`;
        if (S.name) today[0].story = `“${S.name}”. ${today[0].story}`;
        $('dayLabel').textContent = `Scenario · ${S.name || S.title}`;
        scenTouch(CUSTOM, CUSTOM_TITLE);
        commPlay();
      } else if (DRIVE) {
        PRO = await loadPro();
        const d = PRO && PRO.drives[DRIVE - 1];
        if (!d) { badProLink(); return; }
        const teams = await loadProTeams(d.spot);
        today = [buildScen(PRO.spots[d.spot], teams[d.spot])];
        eraTeams(today[0]);
        today[0].story = d.note;
        $('dayLabel').textContent = `Drive · ${d.title}`;
      } else {
        if (sidesOf(dayN) && sideOf(dayN) == null) await renderSidePick(dayN);       // a day of two sides: the pick first
        const ids = dayIds(dayN);
        const teams = await loadTeams(ids);
        today = ids.map((i) => buildScen(idx.spots[i], teams[i]));
        dayLabelSet();
      }
    } catch (e) { $('boot').textContent = 'Today\'s spots did not load (' + e.message + '). Check your connection and reload.'; return; }
    // a try saved on a spot's data since corrected (the Miami Miracle began with the touchdown on the board until the fix
    // went out): thrown away, so it starts over from the right spot
    const stale = (st) => DRIVE && st && today[0] && SPOT_FIXED[today[0].id] && !(st.tryAt >= SPOT_FIXED[today[0].id]);
    if (stale(load(stateKey(), null))) { try { localStorage.removeItem(stateKey()); } catch (e) { /* storage off */ } }
    const fresh = !load(stateKey(), null);
    state = load(stateKey(), null) || { spots: [], current: 0, done: false, tryAt: Date.now() };     // tryAt: this try (a drive's record)
    if (!(PRACTICE || DRIVE || RUN_N) && sidesOf(dayN) && state.side == null) state.side = sideOf(dayN);     // (the side taken, kept with the day)
    if (!$('modal').hidden) { /* a question already up (the unsubscribe link's): the welcome waits for the next visit */ }
    else if (!load(`${STORE}:seen`, false)) { if (TOUR_OK) tourStart(true); else openHelp(true); save(`${STORE}:seen`, true); } else tourStart(false);
    drawTiles();
    startWorkers();
    if (state.done) renderSummary();
    else openSpot(Math.min(state.current || 0, today.length - 1));
  }
  boot();
})();
