/* Static contract check between index.html and js/plugin.js.
 *
 * A typo'd element id is invisible to `node --check` and only shows up as a
 * runtime crash inside Eagle, so the two files are cross-checked here:
 *   1. every id plugin.js looks up must exist in index.html
 *   2. every script src in index.html must exist on disk
 *   3. matcher.js must be loaded before plugin.js (plugin.js reads
 *      window.ShapeMatcher at module scope, not inside a callback)
 *   4. manifest.json must be valid and point at an existing entry file
 *
 * Run with:  node test/ui-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html');
const pluginSrc = read('js/plugin.js');

function htmlIds(source) {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

function lookedUpIds(source) {
  const ids = [];
  for (const m of source.matchAll(/\$\('([^']+)'\)/g)) ids.push(m[1]);
  for (const m of source.matchAll(/getElementById\('([^']+)'\)/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

test('every element id plugin.js looks up exists in index.html', () => {
  const declared = htmlIds(html);
  const missing = lookedUpIds(pluginSrc).filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `ids referenced but not defined in index.html: ${missing.join(', ')}`);
});

test('plugin.js actually looks up the controls it is expected to drive', () => {
  const used = new Set(lookedUpIds(pluginSrc));
  for (const id of ['btnRescan', 'btnClear', 'presets', 'grid', 'summary', 'status',
                    'modeSeg', 'tolNum', 'tol', 'tolReadout', 'histo', 'results',
                    'btnSelect', 'btnTag', 'btnCopy', 'btnExport', 'tagName']) {
    assert.ok(used.has(id), `expected plugin.js to reference #${id}`);
  }
});

test('every script referenced by index.html exists', () => {
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, 'expected at least matcher.js and plugin.js');
  for (const src of scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, src)), `missing script file: ${src}`);
  }
});

test('matcher.js and indexer.js both load before plugin.js', () => {
  const order = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  // plugin.js reads window.ShapeMatcher and window.EagleIndex at load time,
  // not inside a callback, so both must already be evaluated.
  assert.ok(order.indexOf('js/matcher.js') < order.indexOf('js/plugin.js'),
    'matcher.js must load before plugin.js');
  assert.ok(order.indexOf('js/indexer.js') < order.indexOf('js/plugin.js'),
    'indexer.js must load before plugin.js');
});

test('the indexer exposes the API plugin.js consumes', () => {
  const IX = require('../js/indexer.js');
  for (const fn of ['loadIndex', 'scanLibrary', 'parseMetadata', 'mapWithConcurrency',
                    'libraryRootFromItemPath', 'CACHE_VERSION']) {
    assert.ok(IX[fn] !== undefined, `indexer.js is missing ${fn}`);
  }
  const used = [...new Set([...pluginSrc.matchAll(/\bIX\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  assert.ok(used.length > 0, 'expected plugin.js to call into EagleIndex');
  const missing = used.filter((k) => IX[k] === undefined);
  assert.deepEqual(missing, [], `plugin.js uses missing EagleIndex members: ${missing.join(', ')}`);
});

test('renderGrid is always called with an explicit append flag', () => {
  // A bare renderGrid() rebuilds the grid, which resets the scroll position
  // during infinite scrolling. Requiring the flag keeps that regression out.
  const bare = [...pluginSrc.matchAll(/renderGrid\(\s*\)/g)];
  assert.equal(bare.length, 0, 'call renderGrid(true) to append or renderGrid(false) to reset');
  assert.ok(/renderGrid\(false\)/.test(pluginSrc), 'a resetting call should exist');
  assert.ok(/renderGrid\(true\)/.test(pluginSrc), 'an appending call should exist');
});

test('the bundles publish their globals even when a CommonJS module exists', () => {
  // This reproduces Eagle's plugin renderer exactly: nodeIntegration is on, so
  // a <script src> executes with BOTH `window` and a CommonJS `module` in
  // scope. A conventional UMD (`if (module) exports=... else root.X=...`)
  // takes the CommonJS branch and never sets the global, so the page reads
  // `window.ShapeMatcher` as undefined and dies on the first M.PRESETS access.
  const bundles = [['js/matcher.js', 'ShapeMatcher'], ['js/indexer.js', 'EagleIndex']];
  for (const [file, globalName] of bundles) {
    const sandbox = { console: console, module: { exports: {} }, exports: {} };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read(file), sandbox, { filename: file });

    assert.ok(sandbox[globalName],
      `${file} must set window.${globalName} in Eagle's renderer (got ${typeof sandbox[globalName]})`);
    assert.ok(sandbox.module.exports && Object.keys(sandbox.module.exports).length > 0,
      `${file} must still export through CommonJS for the Node unit tests`);
  }
});

test('the plugin refuses to run quietly when a core bundle is missing', () => {
  // A hung "scanning forever" window is the worst failure mode; the plugin
  // must detect the missing global and say so.
  assert.match(pluginSrc, /window\.ShapeMatcher=/, 'should report which globals were missing');
  assert.match(pluginSrc, /核心脚本未能加载/);
  assert.match(pluginSrc, /插件初始化失败/);
});

/** Drop comments so prose about a forbidden pattern cannot satisfy a check on it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Extract a function body by brace matching (good enough for these simple ones). */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

test('every batch action targets the current selection, not the whole match list', () => {
  // The point of multi-select: acting on the grid selection. If an action
  // reads state.matches directly it silently ignores the user's picks.
  for (const fn of ['onSelectInEagle', 'onTag', 'onCopyPaths', 'onExport']) {
    const body = functionBody(pluginSrc, fn);
    assert.ok(body && body.length > 80, `could not extract ${fn}`);
    assert.match(body, /targetItems\(\)/, `${fn} must act on targetItems()`);
    assert.ok(!/state\.matches\.map\(/.test(body),
      `${fn} still maps over every match instead of the target set`);
  }
});

test('refilter applies the format condition and reconciles the selection', () => {
  const body = functionBody(pluginSrc, 'refilter');
  assert.ok(body, 'refilter not found');
  assert.match(body, /state\.exts\.has\(/, 'refilter must filter by the chosen formats');
  assert.match(body, /state\.selection/, 'refilter must reconcile the selection with the new matches');
});

test('grid cells expose a selection control', () => {
  const body = functionBody(pluginSrc, 'cellHtml');
  assert.ok(body, 'cellHtml not found');
  assert.match(body, /class="pick"/, 'each cell needs a pick target');
  assert.match(body, /' selected'/, 'cells must be able to render as selected');
});

test('thumbnail hydration targets the .thumb slot, never the first child', () => {
  // Adding the pick control made it the first child of a cell. Locating the
  // image with firstChild then set `.src` on a <span> and no thumbnail ever
  // appeared — while state.thumbs still filled up, so a re-render made it look
  // like "only some images load".
  const body = functionBody(pluginSrc, 'doHydrateThumbnails');
  assert.ok(body, 'doHydrateThumbnails not found');
  const code = stripComments(body);
  assert.match(code, /querySelector\('\.thumb'\)/, 'must locate the thumbnail slot explicitly');
  assert.ok(!/firstChild|firstElementChild/.test(code),
    'firstChild is the pick control, not the image slot');
});

test('the plugin never falls back to a whole-library item.get()', () => {  // The original slowness came from serialising every Item over IPC. The
  // only permitted get() calls are the small scoped ones (ids / isSelected /
  // folders), and getByIds for the visible page.
  const calls = [...pluginSrc.matchAll(/eagle\.item\.(get|getAll|getByIds)\(/g)].map((m) => m[1]);
  assert.ok(!calls.includes('getAll'), 'must not call eagle.item.getAll()');
  const getCalls = [...pluginSrc.matchAll(/eagle\.item\.get\(([^)]*)/g)].map((m) => m[1]);
  for (const args of getCalls) {
    assert.ok(!/fields:\s*\[\s*'id',\s*'name',\s*'ext',\s*'width'/.test(args),
      `found an unscoped full-library item.get with fields: ${args.slice(0, 60)}`);
  }
  assert.ok(calls.includes('getByIds'), 'thumbnails/tagging should hydrate by id');
});

test('matcher.js exposes the API plugin.js consumes', () => {
  const M = require('../js/matcher.js');
  for (const fn of ['filterItems', 'createMatcher', 'describe', 'nativeShape', 'nativeWouldFind', 'PRESETS']) {
    assert.ok(M[fn] !== undefined, `matcher.js is missing ${fn}`);
  }
  // plugin.js reads these off the module, so a rename here must fail loudly.
  assert.ok(Array.isArray(M.PRESETS) && M.PRESETS.length > 0);
});

test('every ShapeMatcher member plugin.js uses actually exists', () => {
  const M = require('../js/matcher.js');
  const used = [...new Set(
    [...pluginSrc.matchAll(/\bM\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  )];
  assert.ok(used.length > 0, 'expected plugin.js to call into ShapeMatcher');
  const missing = used.filter((k) => M[k] === undefined);
  assert.deepEqual(missing, [], `plugin.js uses missing ShapeMatcher members: ${missing.join(', ')}`);
});

test('manifest.json is valid and its entry files exist', () => {
  const mf = JSON.parse(read('manifest.json'));
  assert.ok(mf.id, 'manifest.id is required');
  assert.match(mf.version, /^\d+\.\d+\.\d+$/, 'manifest.version should be semver-ish');
  assert.ok(mf.name, 'manifest.name is required');
  assert.ok(mf.logo, 'manifest.logo is required');
  assert.ok(fs.existsSync(path.join(ROOT, mf.logo.replace(/^\//, ''))), 'manifest.logo file is missing');
  assert.ok(mf.main && mf.main.url, 'manifest.main.url is required for a window plugin');
  assert.ok(fs.existsSync(path.join(ROOT, mf.main.url)), 'manifest.main.url file is missing');
  // Eagle reads devTools from the top level, not from inside main.
  // It must be exactly false: `true` makes Eagle pop the DevTools window every
  // time the plugin opens — a debugging leftover that must never ship.
  assert.equal(mf.devTools, false,
    'manifest.devTools must be false, otherwise Eagle opens Developer Tools on every launch');
});
