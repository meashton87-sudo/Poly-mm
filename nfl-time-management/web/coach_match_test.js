// "You coached like", "Called it like", "Defended like" (game.js traitsOf .. coachCard, run here as the page runs them):
// offensive calls name a head coach and an offensive play-caller; a full defense called names a defensive play-caller,
// and only then.
//   node web/coach_match_test.js [coaches.json]   (coaches.py fingerprints() saved as JSON; else web/game.json's, else a
//                                                small stand-in table where it has no play-callers yet)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
const a = src.indexOf('  const chosenCallOf = '), b = src.indexOf('  // ---- your tendencies:');
assert.ok(a > 0 && b > a, 'the matcher in game.js');
let coaches = null;
try {
  coaches = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : JSON.parse(fs.readFileSync(path.join(__dirname, 'game.json'), 'utf8')).coaches;
} catch (e) { /* not built */ }
if (!coaches || !coaches.oc || !coaches.dc) {           // the shape coaches.py fingerprints() exports
  const z4 = (p, d, g, t) => ({ pass: p, deep: d, go: g, two: t });
  coaches = {
    coaches: [{ name: 'Coach A', from: 2010, to: 2020, teams: ['KC'], plays: 900, z: z4(1, 0, 0, 0) }, { name: 'Coach B', from: 2012, to: 2022, teams: ['SF'], plays: 800, z: z4(-1, 0, 0, 0) }],
    spread: z4(0.03, 0.02, 0.03, 0.03), measures: ['pass', 'deep', 'go', 'two'],
    oc: { callers: [{ name: 'Caller A', stints: [['KC', 2013, 2026]], plays: 1800, z: z4(1.2, 0, 0, 0) }, { name: 'Caller B', stints: [['LV', 2018, 2019], ['LV', 2020, 2021]], plays: 400, z: z4(-1, 0, 0, 0) }],
      spread: z4(0.03, 0.02, 0.03, 0.04), measures: ['pass', 'deep', 'go', 'two'] },
    dc: { callers: [{ name: 'Blitzer', stints: [['TEN', 2016, 2017]], plays: 300, z: { blitz: 2, load: 0, soft: 0 } }, { name: 'Sitter', stints: [['CHI', 2016, 2018]], plays: 500, z: { blitz: -1, load: 0, soft: 1 } }],
      spread: { blitz: 0.05, load: 0.02, soft: 0.06 }, measures: ['blitz', 'load', 'soft'] },
  };
}
// what the matcher reads from the page, stubbed
const CALL = { pass_a: { id: 'pass_a', family: 'pass' }, deep_a: { id: 'deep_a', family: 'pass' }, run_a: { id: 'run_a', family: 'run' } };
const el = (tag, cls, text) => ({ tag, cls, text, kids: [], append(...k) { this.kids.push(...k); } });
const page = new Function('CALL', 'DEEP', 'DEFS', 'idx', 'el', 'teamName', 'cityIn',
  `${src.slice(a, b)}\nreturn { coachMatch, callerMatch, coachCard };`)(CALL, new Set(['deep_a']), ['blitz', 'load', 'soft'],
  { coaches }, el, (c) => c, (c, y) => (c === 'LV' && y <= 2019 ? 'Oakland' : c));

// ten throws where play-callers throw half the time; then four full-defense calls, every one a 6-man blitz
const call = (k) => ({ kind: 'call', family: 'play_select', chosen: k, wps: [{ key: 'pass_a' }, { key: 'run_a' }], q: { pass_a: 0.5, run_a: 0.5 } });
const off = Array.from({ length: 10 }, () => call('pass_a'));
const dcall = { kind: 'defcall', family: 'def_call', chosen: 'yours', q: {}, dc: { rush: 6, front: 'even', cover: 'c0', pers: 'nickel' },
  nfl: { blitz: 0.25, load: 0.2, soft: 0.6 } };
const hc = page.coachMatch(off), oc = page.callerMatch(off, 'oc');
assert.ok(hc && hc.coach.name, 'a head coach');
assert.ok(oc && oc.coach.name && oc.coach.stints.length, 'an offensive play-caller');
assert.strictEqual(page.callerMatch(off, 'dc'), null, 'no defense called: no defensive play-caller');
const quick = [{ kind: 'defcall', family: 'def_call', chosen: 'blitz', q: { blitz: 0.3, load: 0.3, soft: 0.4 } }];
assert.strictEqual(page.callerMatch(quick, 'dc'), null, 'a quick defensive look (no full call) names none');
const both = [...off, dcall, dcall, dcall, dcall];
const dc = page.callerMatch(both, 'dc');
assert.ok(dc && dc.coach.name, 'a defensive play-caller');
const top = coaches.dc.callers.reduce((x, c) => (c.z.blitz > x.z.blitz ? c : x));
assert.ok(dc.coach.z.blitz > 0, `blitzing every snap: a blitzer (${dc.coach.name}; the most: ${top.name})`);
assert.ok(dc.why.some((w) => w.startsWith('sent five or more on 4 of 4 snaps')), `the reason quotes the blitzes: ${dc.why}`);
const card = page.coachCard(both, 'You coached like');
const text = JSON.stringify(card.el);
assert.ok(card.name === hc.coach.name && card.oc === oc.coach.name && card.dc === dc.coach.name, 'the card names all three');
assert.ok(text.includes('Called it like') && text.includes('Defended like'), 'the card says it');
const dOnly = page.coachCard([dcall, dcall], 'You coached like');
assert.ok(dOnly && dOnly.name === null && dOnly.dc, 'a defense-only drive still names its defensive play-caller');
console.log(`ok: coached like ${hc.coach.name}; called it like ${oc.coach.name}; defended like ${dc.coach.name} (${dc.why.join('; ')})`);
