/* ============================================================
 * ShapeMatcher — aspect-ratio matching logic for Eagle
 *
 * Eagle's native shape filter (app/js/rule-match.js -> isMatchShapeRule)
 * is exact-match only:
 *   - square   requires width === height
 *   - custom   requires (rule.width / rule.height) === (width / height),
 *              i.e. bit-for-bit float equality of the ratio
 *   - landscape / portrait / panoramic-* are coarse buckets split at 2.5
 *
 * This module adds the missing fuzzy dimension: "approximately square",
 * "ratio within a range", "16:9 within N%". It is dependency-free and
 * runs unchanged in the browser (window.ShapeMatcher) and in Node
 * (module.exports) so the logic can be unit-tested outside Eagle.
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  // Eagle's plugin renderer has Node integration, so `window` AND a CommonJS
  // `module` both exist. A conventional UMD (`if (module) exports = ... else
  // root.X = ...`) therefore takes the CommonJS branch and never publishes the
  // global — the plugin page then reads window.ShapeMatcher and gets undefined.
  // Publish to both instead.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShapeMatcher = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  /** Eagle's own panoramic threshold, mirrored for parity checks. */
  var PANORAMIC_THRESHOLD = 2.5;

  /** Named ratios offered as one-click chips in the UI. */
  var PRESETS = [
    { id: '1:1', label: '1:1 方形', w: 1, h: 1 },
    { id: '4:3', label: '4:3', w: 4, h: 3 },
    { id: '3:4', label: '3:4', w: 3, h: 4 },
    { id: '3:2', label: '3:2', w: 3, h: 2 },
    { id: '2:3', label: '2:3', w: 2, h: 3 },
    { id: '16:9', label: '16:9', w: 16, h: 9 },
    { id: '9:16', label: '9:16', w: 9, h: 16 },
    { id: '2:1', label: '2:1 宽幅', w: 2, h: 1 },
    { id: '1:2', label: '1:2 长幅', w: 1, h: 2 }
  ];

  /**
   * Reproduce Eagle's native shape bucket for an item.
   * Mirrors rule-match.js:674 so the UI can show
   * "native said X, fuzzy filter says Y".
   * @returns {string} landscape|portrait|square|panoramic-landscape|panoramic-portrait
   */
  function nativeShape(width, height) {
    if (!width || !height) return null;
    if (width > height) {
      return width / height >= PANORAMIC_THRESHOLD ? 'panoramic-landscape' : 'landscape';
    }
    if (width < height) {
      return height / width >= PANORAMIC_THRESHOLD ? 'panoramic-portrait' : 'portrait';
    }
    return 'square';
  }

  /**
   * Reproduce Eagle's native `custom` match: exact ratio equality.
   * Float equality is intentional — it is what Eagle itself does.
   */
  function nativeCustomMatches(width, height, ruleWidth, ruleHeight) {
    if (!ruleWidth || !ruleHeight) return false;
    return ruleWidth / ruleHeight === width / height;
  }

  /**
   * The ratios a filter should be tested against.
   *
   * Eagle stores width/height as shot, so a 9:16 photo has w/h = 0.5625.
   * Users think in "shape names", so for orientation 'any' we accept a
   * match against either w/h or its reciprocal h/w. That is what makes
   * "16:9 ±5%" also find 9:16 assets unless the user pins an orientation.
   *
   * @param {number} width
   * @param {number} height
   * @param {'any'|'landscape'|'portrait'} orientation
   * @returns {number[]} for 'any': [w/h, h/w]; for a pinned orientation:
   *                     the single ratio in that orientation's terms
   */
  function candidateRatios(width, height, orientation) {
    if (!width || !height) return [];
    var r = width / height;
    if (orientation === 'portrait') return [1 / r];
    if (orientation === 'landscape') return [r];
    return [r, 1 / r];
  }

  /**
   * Does a single ratio satisfy a tolerance window around a target?
   * Tolerance is relative to the target (5% of 16:9 = ±0.0889).
   */
  function ratioWithinTolerance(ratio, target, tolerancePct) {
    if (!target || target <= 0) return false;
    var tol = (tolerancePct || 0) / 100;
    return Math.abs(ratio - target) <= target * tol;
  }

  /**
   * Turn a UI spec into a matcher function.
   *
   * @param {object} spec
   * @param {'near'|'range'} spec.mode
   *   near  -> ratio inside target ± tolerancePct
   *   range -> minRatio <= ratio <= maxRatio (absolute bounds)
   * @param {number} [spec.target]      target ratio W/H for mode 'near'
   * @param {number} [spec.tolerancePct] relative tolerance, 5 == ±5%
   * @param {number} [spec.minRatio]    lower bound for mode 'range'
   * @param {number} [spec.maxRatio]    upper bound for mode 'range'
   * @param {'any'|'landscape'|'portrait'} [spec.orientation='any']
   * @returns {(item: {width:number,height:number}) => boolean}
   */
  function createMatcher(spec) {
    spec = spec || {};
    var orientation = spec.orientation || 'any';

    return function matches(item) {
      if (!item) return false;
      var w = item.width;
      var h = item.height;
      if (!w || !h) return false;

      // Orientation is a hard constraint when the user pins it.
      if (orientation === 'landscape' && w <= h) return false;
      if (orientation === 'portrait' && w >= h) return false;

      var ratios = candidateRatios(w, h, orientation);

      if (spec.mode === 'range') {
        var lo = Number(spec.minRatio);
        var hi = Number(spec.maxRatio);
        if (!isFinite(lo) || !isFinite(hi)) return false;
        if (lo > hi) { var t = lo; lo = hi; hi = t; }
        for (var i = 0; i < ratios.length; i++) {
          if (ratios[i] >= lo && ratios[i] <= hi) return true;
        }
        return false;
      }

      // mode 'near'
      var target = Number(spec.target);
      if (!isFinite(target) || target <= 0) return false;
      // A target below 1 is just the reciprocal; normalising keeps the
      // tolerance window symmetric for things like 9:16 vs 16:9.
      if (target < 1) target = 1 / target;
      for (var j = 0; j < ratios.length; j++) {
        if (ratioWithinTolerance(ratios[j], target, spec.tolerancePct)) return true;
      }
      return false;
    };
  }

  /** Human-readable summary of a spec, shown above the results. */
  function describe(spec) {
    spec = spec || {};
    var dir = spec.orientation === 'landscape' ? '仅横图'
      : spec.orientation === 'portrait' ? '仅竖图' : '横竖均可';
    if (spec.mode === 'range') {
      return '长宽比 ' + fmt(spec.minRatio) + ' – ' + fmt(spec.maxRatio) + '（' + dir + '）';
    }
    var target = Number(spec.target);
    var label = target < 1 ? fmt(1 / target) : fmt(target);
    var pct = Number(spec.tolerancePct) || 0;
    return label + ' ±' + fmt(pct) + '%（' + dir + '）';
  }

  function fmt(n) {
    n = Number(n);
    if (!isFinite(n)) return '—';
    return String(Math.round(n * 1000) / 1000);
  }

  /**
   * Filter a list plus the numbers the UI needs to make the point that
   * fuzzy matching finds more than the native filter does.
   *
   * @param {Array} items
   * @param {object} spec
   * @returns {{matches:Array, total:number, matched:number,
   *            nativeBuckets:Object, nativeSameBucket:number}}
   */
  function filterItems(items, spec) {
    var matcher = createMatcher(spec);
    var matches = [];
    var buckets = {};
    var nativeSameBucket = 0;

    // The native bucket the fuzzy filter is standing in for, so the UI can
    // say "native square: 102, fuzzy square ±5%: 126".
    var nearTarget = spec.mode === 'near' ? Number(spec.target) : null;
    if (nearTarget !== null && nearTarget < 1) nearTarget = 1 / nearTarget;
    var nativeEquivalent = nearTarget === 1 ? 'square'
      : nearTarget === 16 / 9 ? null
      : null;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var bucket = nativeShape(it.width, it.height);
      if (bucket) buckets[bucket] = (buckets[bucket] || 0) + 1;
      if (matcher(it)) {
        matches.push(it);
        if (nativeEquivalent && bucket === nativeEquivalent) nativeSameBucket++;
      }
    }

    return {
      matches: matches,
      total: items.length,
      matched: matches.length,
      nativeBuckets: buckets,
      nativeSameBucket: nativeSameBucket
    };
  }

  /**
   * Would Eagle's own exact filter have found this item under the same spec?
   *
   * Used to mark results as "native would miss this". It deliberately tests
   * the *exact* ratio rather than the coarse shape bucket: Eagle's 4:3 / 16:9
   * presets go through the `custom` branch of isMatchShapeRule, which demands
   * float equality, and `square` is the w === h special case. A range spec has
   * no native counterpart at all, so it can never be a native hit.
   *
   * @param {object} item - {width, height}
   * @param {object} spec - same shape as createMatcher()
   * @returns {boolean}
   */
  function nativeWouldFind(item, spec) {
    if (!item || !spec || spec.mode !== 'near') return false;
    var target = Number(spec.target);
    if (!isFinite(target) || target <= 0) return false;
    // Either the target or its reciprocal, matching how candidateRatios
    // treats orientation-agnostic searches.
    return nativeCustomMatches(item.width, item.height, target, 1) ||
      nativeCustomMatches(item.width, item.height, 1, target);
  }

  return {
    PANORAMIC_THRESHOLD: PANORAMIC_THRESHOLD,
    PRESETS: PRESETS,
    nativeShape: nativeShape,
    nativeCustomMatches: nativeCustomMatches,
    nativeWouldFind: nativeWouldFind,
    candidateRatios: candidateRatios,
    ratioWithinTolerance: ratioWithinTolerance,
    createMatcher: createMatcher,
    describe: describe,
    filterItems: filterItems
  };
});
