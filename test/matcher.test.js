/* ShapeMatcher unit tests — run with:  node --test test/
 *
 * Two things are being proven here:
 *  1. shape-capture: the native-shape helpers reproduce Eagle's own
 *     classification exactly (app/js/rule-match.js isMatchShapeRule), so
 *     the plugin's "native says X" column can be trusted.
 *  2. gap-closing: the fuzzy matchers accept the real-world near-miss
 *     cases the native filter rejects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/matcher.js');

/* ---------- 1. parity with Eagle's native classifier ---------- */

test('nativeShape reproduces Eagle buckets, including the 2.5 split', () => {
  assert.equal(M.nativeShape(100, 100), 'square');
  assert.equal(M.nativeShape(1, 1), 'square');
  // One pixel off is no longer square in Eagle — the whole complaint.
  assert.equal(M.nativeShape(100, 101), 'portrait');
  assert.equal(M.nativeShape(101, 100), 'landscape');
  // Exactly 2.5 is panoramic (>=), just under is not.
  assert.equal(M.nativeShape(250, 100), 'panoramic-landscape');
  assert.equal(M.nativeShape(249, 100), 'landscape');
  assert.equal(M.nativeShape(100, 250), 'panoramic-portrait');
  assert.equal(M.nativeShape(100, 249), 'portrait');
  assert.equal(M.nativeShape(0, 100), null);
});

test('native custom ratio match is exact float equality', () => {
  // Common true crops of the same ratio do match.
  assert.equal(M.nativeCustomMatches(1024, 768, 4, 3), true);
  assert.equal(M.nativeCustomMatches(1000, 750, 4, 3), true);
  assert.equal(M.nativeCustomMatches(1920, 1080, 16, 9), true);
  // But a 1-pixel crop difference already fails.
  assert.equal(M.nativeCustomMatches(1025, 768, 4, 3), false);
  assert.equal(M.nativeCustomMatches(1921, 1080, 16, 9), false);
});

/* ---------- 2. approximate-square matching ---------- */

test('near 1:1 finds the near-square assets Eagle hides', () => {
  const spec = { mode: 'near', target: 1, tolerancePct: 5 };
  const m = M.createMatcher(spec);
  // Real examples sampled from a 60k-item library.
  assert.equal(m({ width: 3413, height: 3430 }), true);  // native: portrait
  assert.equal(m({ width: 2003, height: 2048 }), true);  // native: portrait
  assert.equal(m({ width: 2640, height: 2615 }), true);  // native: landscape
  assert.equal(m({ width: 400, height: 406 }), true);    // native: portrait
  // Exactly on the boundary is included (<=).
  assert.equal(m({ width: 100, height: 105 }), true);
  // Outside the boundary is not.
  assert.equal(m({ width: 100, height: 106 }), false);
  assert.equal(m({ width: 100, height: 95 }), true);
  assert.equal(m({ width: 100, height: 94 }), false);
});

test('tolerance 0 reproduces native exact-square exactly', () => {
  const m = M.createMatcher({ mode: 'near', target: 1, tolerancePct: 0 });
  assert.equal(m({ width: 512, height: 512 }), true);
  assert.equal(m({ width: 512, height: 513 }), false);
});

test('widening tolerance is monotonically inclusive', () => {
  const rows = [
    { width: 100, height: 100 },
    { width: 100, height: 102 },
    { width: 100, height: 105 },
    { width: 100, height: 110 },
    { width: 100, height: 130 }
  ];
  let prev = -1;
  for (const tol of [0, 1, 2, 5, 10, 25]) {
    const m = M.createMatcher({ mode: 'near', target: 1, tolerancePct: tol });
    const n = rows.filter(m).length;
    assert.ok(n >= prev, `tolerance ${tol} matched fewer than the previous step`);
    prev = n;
  }
  assert.equal(prev, rows.length);
});

/* ---------- 3. non-square targets and the reciprocal ---------- */

test('16:9 within 5% also finds 9:16 unless orientation is pinned', () => {
  const any = M.createMatcher({ mode: 'near', target: 16 / 9, tolerancePct: 5 });
  assert.equal(any({ width: 1920, height: 1080 }), true);
  assert.equal(any({ width: 1080, height: 1920 }), true, 'reciprocal should match when orientation is any');
  assert.equal(any({ width: 2000, height: 1000 }), false, '2.0 is outside 16:9 ±5%');

  const landscapeOnly = M.createMatcher({ mode: 'near', target: 16 / 9, tolerancePct: 5, orientation: 'landscape' });
  assert.equal(landscapeOnly({ width: 1920, height: 1080 }), true);
  assert.equal(landscapeOnly({ width: 1080, height: 1920 }), false);
});

test('a target below 1 is normalised to its reciprocal', () => {
  const a = M.createMatcher({ mode: 'near', target: 9 / 16, tolerancePct: 2 });
  const b = M.createMatcher({ mode: 'near', target: 16 / 9, tolerancePct: 2 });
  const probe = [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1500, height: 1000 }];
  assert.deepEqual(probe.map(a), probe.map(b));
});

test('tolerance is relative to the target, not absolute', () => {
  // 5% of 16:9 is ±0.0889, so 1920x1090 (1.7615) is still inside.
  const m = M.createMatcher({ mode: 'near', target: 16 / 9, tolerancePct: 5 });
  assert.equal(m({ width: 1920, height: 1090 }), true);
  // 5% of 1:1 is ±0.05 only.
  const sq = M.createMatcher({ mode: 'near', target: 1, tolerancePct: 5 });
  assert.equal(sq({ width: 1920, height: 1090 }), false);
});

/* ---------- 4. range mode ---------- */

test('range mode honours absolute bounds and swaps inverted input', () => {
  const m = M.createMatcher({ mode: 'range', minRatio: 1.7, maxRatio: 1.8 });
  assert.equal(m({ width: 1920, height: 1080 }), true);   // 1.7778
  assert.equal(m({ width: 1700, height: 1000 }), true);   // 1.7 inclusive
  assert.equal(m({ width: 1800, height: 1000 }), true);   // 1.8 inclusive
  assert.equal(m({ width: 1810, height: 1000 }), false);
  assert.equal(m({ width: 1080, height: 1920 }), true, 'reciprocal 1.7778 is in range');

  const flipped = M.createMatcher({ mode: 'range', minRatio: 1.8, maxRatio: 1.7 });
  assert.equal(flipped({ width: 1920, height: 1080 }), true, 'min > max should be swapped, not rejected');
});

test('range mode with orientation portrait tests h/w', () => {
  const m = M.createMatcher({ mode: 'range', minRatio: 1.7, maxRatio: 1.8, orientation: 'portrait' });
  assert.equal(m({ width: 1080, height: 1920 }), true);
  assert.equal(m({ width: 1920, height: 1080 }), false);
});

/* ---------- 5. robustness ---------- */

test('items without usable dimensions never match', () => {
  const m = M.createMatcher({ mode: 'near', target: 1, tolerancePct: 10 });
  for (const bad of [null, undefined, {}, { width: 0, height: 0 }, { width: 100 }, { width: NaN, height: 100 }]) {
    assert.equal(m(bad), false, `should not match ${JSON.stringify(bad)}`);
  }
});

test('invalid specs match nothing instead of throwing', () => {
  assert.equal(M.createMatcher({ mode: 'near', target: 0, tolerancePct: 5 })({ width: 10, height: 10 }), false);
  assert.equal(M.createMatcher({ mode: 'near' })({ width: 10, height: 10 }), false);
  assert.equal(M.createMatcher({ mode: 'range' })({ width: 10, height: 10 }), false);
  assert.equal(M.createMatcher({})({ width: 10, height: 10 }), false);
});

test('candidateRatios normalises orientation for "any"', () => {
  assert.deepEqual(M.candidateRatios(1920, 1080, 'landscape'), [1920 / 1080]);
  assert.deepEqual(M.candidateRatios(1080, 1920, 'portrait'), [1920 / 1080]);
  // 'any' deliberately keeps both directions, so the caller can compare a
  // target against w/h or h/w whichever way the asset happens to be stored.
  const any = M.candidateRatios(1080, 1920, 'any');
  assert.equal(any.length, 2);
  assert.ok(any.some((r) => r >= 1), 'the >= 1 direction must be available');
  assert.ok(any.some((r) => r < 1), 'the raw w/h direction must also be available');
  assert.equal(Math.max(...any), 1920 / 1080);
});

/* ---------- 6. native-hit reporting (the "原生漏" badge) ---------- */

test('nativeWouldFind matches Eagle exact-ratio semantics, not the buckets', () => {
  const square = { mode: 'near', target: 1, tolerancePct: 5 };
  assert.equal(M.nativeWouldFind({ width: 512, height: 512 }, square), true);
  // One pixel off: fuzzy filter keeps it, Eagle would not have found it.
  assert.equal(M.nativeWouldFind({ width: 512, height: 513 }, square), false);

  const wide = { mode: 'near', target: 16 / 9, tolerancePct: 5 };
  assert.equal(M.nativeWouldFind({ width: 1920, height: 1080 }, wide), true);
  // Recipient orientation counts, same as the matcher itself.
  assert.equal(M.nativeWouldFind({ width: 1080, height: 1920 }, wide), true);
  // Inside the tolerance but not an exact ratio -> native would have missed it.
  assert.equal(M.nativeWouldFind({ width: 1920, height: 1090 }, wide), false);

  // A coarse bucket hit is NOT a native exact hit.
  assert.equal(M.nativeWouldFind({ width: 1000, height: 769 }, square),
    M.nativeShape(1000, 769) === 'square');
});

test('nativeWouldFind is always false for range specs', () => {
  const range = { mode: 'range', minRatio: 1.7, maxRatio: 1.8 };
  assert.equal(M.nativeWouldFind({ width: 1920, height: 1080 }, range), false);
});

test('nativeWouldFind tolerates junk input', () => {
  assert.equal(M.nativeWouldFind(null, { mode: 'near', target: 1 }), false);
  assert.equal(M.nativeWouldFind({ width: 10, height: 10 }, null), false);
  assert.equal(M.nativeWouldFind({ width: 10, height: 10 }, { mode: 'near', target: 0 }), false);
  assert.equal(M.nativeWouldFind({ width: 10, height: 10 }, { mode: 'near' }), false);
});

/* ---------- 7. filterItems reporting ---------- */test('filterItems reports native buckets and hit counts', () => {
  const items = [
    { id: 'a', width: 100, height: 100 },
    { id: 'b', width: 100, height: 102 },
    { id: 'c', width: 1000, height: 1000 },
    { id: 'd', width: 4000, height: 1000 },
    { id: 'e', width: 0, height: 0 }
  ];
  const res = M.filterItems(items, { mode: 'near', target: 1, tolerancePct: 5 });
  assert.equal(res.total, 5);
  assert.equal(res.matched, 3);
  assert.deepEqual(res.matches.map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(res.nativeBuckets.square, 2);
  assert.equal(res.nativeBuckets.panoramic_landscape, undefined);
  assert.equal(res.nativeBuckets['panoramic-landscape'], 1);
});

test('describe() is human readable for both modes', () => {
  assert.match(M.describe({ mode: 'near', target: 1, tolerancePct: 5 }), /1 ±5%/);
  assert.match(M.describe({ mode: 'range', minRatio: 1.7, maxRatio: 1.8 }), /1\.7 – 1\.8/);
  assert.match(M.describe({ mode: 'near', target: 16 / 9, tolerancePct: 5, orientation: 'landscape' }), /仅横图/);
});

/* ---------- 8. regression against the real library sample ---------- */

const fs = require('node:fs');
const path = require('node:path');
const fixture = path.join(__dirname, 'fixtures', 'library-sample.json');

test('real-library sample: fuzzy square finds assets native square misses', { skip: !fs.existsSync(fixture) && 'fixture not generated' }, () => {
  const rows = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.ok(rows.length > 100, 'fixture should hold a meaningful sample');

  const exact = M.filterItems(rows, { mode: 'near', target: 1, tolerancePct: 0 });
  const loose = M.filterItems(rows, { mode: 'near', target: 1, tolerancePct: 5 });

  // Every exact square is also a fuzzy square.
  assert.equal(loose.matched >= exact.matched, true);
  // And the fuzzy filter must find strictly more on a real library.
  assert.ok(loose.matched > exact.matched,
    `expected fuzzy > exact, got ${loose.matched} vs ${exact.matched}`);

  // The specific real-world near-miss documented in the README.
  const odd = rows.find((r) => r.width === 3413 && r.height === 3430);
  if (odd) {
    assert.equal(M.nativeShape(odd.width, odd.height), 'portrait');
    assert.equal(M.createMatcher({ mode: 'near', target: 1, tolerancePct: 1 })(odd), true);
  }
});
