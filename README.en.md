# Eagle Shape Range

An [Eagle](https://eagle.cool) plugin that filters assets by **approximate aspect ratio**,
by **ratio ranges**, and by **file type** — three things Eagle's built-in shape filter
cannot do.

**[中文说明](README.md)**

Eagle's native shape filter only matches exactly: `square` means `width === height`,
and the `4:3` / `16:9` presets compare ratios for bit-for-bit float equality.
There is no tolerance and no ratio range anywhere in its data model.
This plugin fills that gap without touching Eagle itself.

---

## 1. The problem

The native predicate is hard-coded in Eagle's own bundle
(`app/js/rule-match.js` → `isMatchShapeRule`):

- **square** requires `width === height` — one pixel off drops it into landscape/portrait
- **landscape / portrait / panoramic-\*** are four buckets split at a hard ratio of **2.5**
- **4:3 / 3:4 / 16:9 / 9:16 / custom** all require **exact float equality** —
  `1025×768` does not match `4:3`

Measured on a real ~60k-item library (58,445 items with pixel dimensions):

| Condition | Native filter finds | This plugin (±5%) | Gain |
|---|---|---|---|
| Square (1:1) | **815** | **1,175** | +360 (1.44×) |
| 16:9 | **1,772** | **3,466** | +1,694 (**1.96×**) |

Real assets that Eagle buckets as portrait/landscape while a human would call them square:

| Size | Ratio | Native bucket |
|---|---|---|
| 3413 × 3430 | 0.9950 | portrait |
| 2024 × 2040 | 0.9922 | portrait |
| 2003 × 2048 | 0.9780 | portrait |
| 3000 × 2933 | 1.0228 | landscape |
| 2640 × 2615 | 1.0096 | landscape |

**Why not just add it to the native filter?** The plugin API cannot extend Eagle's filter
panel, and patching `app.asar` is rejected by Eagle's own tamper check at startup
(it verifies `app.bundle.js`). The evidence for both, plus how to recover if you already
tried the patch, is in [`docs/native-filter-findings.md`](docs/native-filter-findings.md).

---

## 2. Features

**Conditions**

| | |
|---|---|
| Approximate ratio | target ratio (1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16 / 2:1 / 1:2 / custom W:H) ± a tolerance percentage |
| Ratio range | explicit min / max ratio, e.g. `1.2 – 1.4` |
| Orientation | any / landscape only / portrait only. With "any", ratios are compared both ways, so a `16:9` condition also finds `9:16` |
| File type | multi-select by extension (`jpg` / `png` / `webp` …), ANDed with the ratio condition |
| Scope | whole library / current selection / a chosen folder |

Tolerance is **relative** to the target: `16:9 ±5%` means `1.778 ±0.089`, and `1:1 ±5%`
means `0.95 – 1.05`. **A tolerance of 0 reproduces Eagle's exact matching exactly** —
locked down by both unit tests and real-library data.

**Interface**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ Shape Range      library Design · 58,445 filterable   [Rescan]         │
├──────────────────────────────────────────────────────────────────────────┤
│ Conditions                                  Orientation [any ▾]          │
│ [Approx ratio│Ratio range]  (1:1)(4:3)(3:4)(16:9)…   Target 1 : 1         │
│ Tolerance ├──────●───────────┤  ±5.0%                                     │
│ Type (all 58,445)(jpg 48,845)(png 3,588)(webp 5,404)…                    │
├──────────────────────────────────────────────────────────────────────────┤
│ Ratio distribution                             58,445 items · peak 1.00:1│
│    ▁▂▃▅▇█▇▅▃▂▁▁▂▃▅▇█▇▅▃▂▁      highlighted band = the current condition     │
│    1:4        1:2      1:1      2:1        4:1                           │
├──────────────────────────────────────────────────────────────────────────┤
│ 1,175 matched / 58,445   at tolerance 0: 815   [+360 recovered by tolerance]│
├──────────────────────────────────────────────────────────────────────────┤
│ [Select in Eagle][Tag][tag name…] [Copy paths][Export]  target: all 1,175 │
│                                        [Select all][Invert]  [Reset]      │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐   per tile: ☑ pick / native✓|native miss│
│ │    │ │    │ │    │ │    │ │    │   click → reveal in Eagle             │
│ └────┘ └────┘ └────┘ └────┘ └────┘   Ctrl-click → add, Shift-click → range│
├──────────────────────────────────────────────────────────────────────────┤
│ cache hit · 58,445 items · 0.08s                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

The **ratio-distribution histogram** bins the current candidate set by `log2(w/h)` into
72 buckets and highlights the band your condition covers, so you can pick a tolerance by
looking at the data instead of guessing. The theme follows Eagle (dark / light).

**Multi-select and batch actions**

Every tile has a checkbox; **Ctrl-click** adds, **Shift-click** selects a range, and the
action bar has **Select all / Invert / Clear**. All four batch actions act on the
**current selection**; with nothing selected they fall back to every match (the bar always
shows whether the target is "N selected" or "all N"). Changing a condition drops selections
that no longer match.

- **Select in Eagle** — hand the batch to Eagle's own selection, then use anything Eagle can do
- **Tag** — append a tag in bulk (idempotent, see below)
- **Copy paths** / **Export list** (JSON with `ratio`, `nativeShape`, and the exact condition used)

### Tagging semantics

One line of logic, so **the same tag name is never applied twice**:

```js
var tags = Array.isArray(it.tags) ? it.tags.slice() : [];
if (tags.indexOf(tag) === -1) tags.push(tag);   // already tagged → leave it alone
it.tags = tags;
await it.save();
```

| Case | Result |
|---|---|
| Same tag name, asset matched by several filtering runs | one tag, **no duplicates** |
| **Different** tag names (e.g. `square5%` then `square1%`) | both remain — they are different condition sets by design |
| Asset already had other tags | **appended, never overwritten** |

Each item is re-read in batches of 200 with `getByIds()` before saving, because only a full
item carries `tags` — saving from the lightweight index would wipe the asset's existing
tags. Up to 3000 items per run.

---

## 3. Install

**Option A (recommended)** — drop the whole `eagle-shape-range` folder into Eagle's plugin
directory:

```
%APPDATA%\Eagle\Plugins\eagle-shape-range
```

`manifest.json` must sit at that level. **Restart Eagle** and press `P` to find
"形状范围筛选" in the plugin panel.

**Option B** — download the packaged `.eagleplugin` from
[Releases](../../releases), or build it with `pwsh -File tools/pack.ps1`
(add `-ExecutionPolicy Bypass` if PowerShell refuses the unsigned script).

| Requirement | |
|---|---|
| Eagle | 4.0 build12+ (uses `item.select`); developed and verified against 4.0.0.42 / build 22.3.7 |
| Node / Python | not needed at runtime — the plugin only uses the injected `eagle` object and `require`. `test/` and `tools/` are development-only |

The first open indexes the whole library and writes a cache into the plugin folder;
after that it opens in milliseconds.

---

## 4. Performance: why it does not use `eagle.item.get()`

| | Plugin API over the whole library | This plugin (v2) |
|---|---|---|
| How data is fetched | every **full Item object** serialised over IPC | reads `images/<id>.info/metadata.json` directly |
| Whole library | minutes | **cold ~1.4 s** |
| Second open | repeats the work | **cache hit ~80 ms** |
| Thumbnails | shipped with the bulk payload | lazily `getByIds()` for the visible page only |

Measured on a real ~60k library (58,445 items with dimensions):

```
-- cold scan (direct metadata reads) --
  items with dimensions : 58,445 / 59,928 folders
  skipped (no raster)   : 1,483
  elapsed               : 1.43s
  throughput            : 41,908 files/s
  cache written         : 5.6 MB
-- warm start (cache hit) --
  source                : cache
  elapsed               : 38 ms
```

Reproduce with `node tools/bench-index.js "<your library path>"`.

The cache lives in the plugin folder as `index-cache.json` and is only invalidated when the
set of item ids changes; "Rescan" forces a rebuild. If `require('fs')` is unavailable the
plugin falls back to the plugin API and says so in the status bar.

---

## 5. How it works

- **`js/indexer.js`** — reads library metadata directly. 48-way concurrency, progress
  callbacks, a disk cache validated against the item-id set, and graceful degradation when
  the cache is corrupt or unwritable. The library path is resolved through several
  fallbacks (`eagle.library.path` → deriving it from any item's `filePath` → a previously
  chosen path → a short retry loop) before ever asking you to point at it manually.
- **`js/matcher.js`** — the matching logic as pure functions, dependency-free and shared
  between the browser and Node so it can be unit-tested outside Eagle. It also reproduces
  Eagle's own bucketing and exact-ratio rule, which is what makes the
  "native✓ / native miss" labels trustworthy.
- **`js/plugin.js`** — UI and actions. Thumbnails are fetched in batches for the visible
  page; selecting a tile toggles a class instead of re-rendering, which would lose both the
  scroll position and the already-loaded thumbnails.

---

## 6. Development

```bash
node test/run-all.js                              # 49 tests
node --check js/indexer.js
node tools/bench-index.js "<your library path>"
```

What the tests cover:

1. **Parity with Eagle** — `nativeShape()` / `nativeCustomMatches()` must reproduce Eagle's
   rules (the 2.5 threshold, `width === height`, exact float ratio), otherwise the labels in
   the UI would be lying.
2. **Tolerance 0 degrades to native exact matching**; widening the tolerance is monotonically
   inclusive.
3. **Real-library regression** — `test/fixtures/library-sample.json` (3,908 real
   width/height pairs, item ids replaced with synthetic ones) asserts that fuzzy matching is
   strictly larger than exact matching, and pins the `3413×3430` counter-example.
4. **The indexer** — driven against a temporary fake library: dimension parsing and skipping
   of unusable items, concurrency ceiling, monotonic progress, cache hit/invalidation on
   add/remove, corrupt-cache fallback, unwritable cache, and deriving the library root from
   an item path.
5. **UI contract** — every `$('...')` id exists; dependent modules load before use; all four
   batch actions read the selection; the file-type condition really participates in
   filtering; `renderGrid` always gets an explicit append flag; thumbnails are located by
   class; and the plugin never falls back to a whole-library `item.get()`.

> `test/` deliberately avoids `node --test`: it spawns one child process per test file with
> piped stdio, which fails with `spawn EPERM` in some restricted environments.
> `run-all.js` requires the test files in a single process and runs the same `node:test`
> assertions.

### One gotcha worth calling out (now a regression test)

Eagle's plugin renderer has Node integration enabled, so a `<script src>` executes with
**both `window` and a CommonJS `module` in scope**. The conventional UMD shape:

```js
if (typeof module === 'object' && module.exports) module.exports = factory();
else root.ShapeMatcher = factory();     // ← never reached
```

takes the CommonJS branch and **never publishes the global**. The page then reads
`window.ShapeMatcher` as `undefined`, throws on the first `M.PRESETS` access, and the window
sits on its initial text — which looks exactly like "it is still scanning", and is very easy
to misdiagnose as a performance problem. `test/ui-contract.test.js` reproduces that
environment with Node's `vm` and pins the behaviour down.

---

## 7. Known limitations

- **Tagging is a one-off snapshot**: assets imported later are not tagged automatically.
  Re-run the filter and tag again — the same tag name still will not duplicate.
- **No orientation swapping**: consistent with Eagle's own convention (it keeps `4:3` and
  `3:4` as separate options). Enter `9:16` for portrait.
- **The cache is validated only by the set of item ids**: if an asset is replaced in place
  without changing its id, a dimension change goes unnoticed — press "Rescan".
- No combined "ratio + pixel size" condition yet (e.g. "square-ish and ≥2000px"); that would
  be one more predicate in `js/matcher.js`.
- The UI text is currently Chinese.

---

## 8. License

[MIT](LICENSE) © KUMOAllice

Eagle is a product of OGDESIGN.INC. This project is not affiliated with it.
