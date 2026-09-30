/* EagleIndex unit tests — run with:  node test/run-all.js
 *
 * The indexer reads `images/<id>.info/metadata.json` directly instead of
 * going through eagle.item.get(), so it can be tested against a temporary
 * fake library with no Eagle running at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Index = require('../js/indexer.js');

/* ---------- helpers ---------- */

/** Build a throwaway library. `items` maps id -> metadata object (or a raw string). */
function makeLibrary(items) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleidx-'));
  const images = path.join(root, 'images');
  fs.mkdirSync(images, { recursive: true });
  for (const [id, meta] of Object.entries(items)) {
    const dir = path.join(images, `${id}.info`);
    fs.mkdirSync(dir, { recursive: true });
    const body = typeof meta === 'string' ? meta : JSON.stringify(meta);
    fs.writeFileSync(path.join(dir, 'metadata.json'), body, 'utf8');
  }
  return root;
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

/* ---------- pure helpers ---------- */

test('itemIdFromDirName strips the .info suffix', () => {
  assert.equal(Index.itemIdFromDirName('MNVPK0J506YNO.info'), 'MNVPK0J506YNO');
  assert.equal(Index.itemIdFromDirName('weird-name'), 'weird-name');
});

test('parseMetadata accepts real metadata and rejects everything unusable', () => {
  assert.deepEqual(
    Index.parseMetadata('{"id":"a","name":"豊川祥子 (1)","width":1920,"height":1080,"ext":"jpg","palettes":[{"ratio":73}]}'),
    { w: 1920, h: 1080, ext: 'jpg', name: '豊川祥子 (1)' }
  );
  // Rounded to integers, since Eagle always stores whole pixels.
  assert.deepEqual(Index.parseMetadata('{"width":100.4,"height":50.6}'),
    { w: 100, h: 51, ext: '', name: '' });
  // Everything below must be skipped rather than treated as 0x0.
  assert.equal(Index.parseMetadata('{"id":"a"}'), null, 'no dimensions');
  assert.equal(Index.parseMetadata('{"width":0,"height":100}'), null, 'zero width');
  assert.equal(Index.parseMetadata('{"width":-5,"height":100}'), null, 'negative');
  assert.equal(Index.parseMetadata('{"width":"1920","height":1080}'), null, 'string dimensions');
  assert.equal(Index.parseMetadata('{"width":null,"height":null}'), null, 'null dimensions');
  assert.equal(Index.parseMetadata('not json at all'), null, 'invalid JSON');
  assert.equal(Index.parseMetadata(''), null, 'empty file');
});

test('sameIdSet ignores order but not membership', () => {
  assert.equal(Index.sameIdSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(Index.sameIdSet(['a'], ['a', 'b']), false);
  assert.equal(Index.sameIdSet(['a', 'b'], ['a', 'c']), false);
  assert.equal(Index.sameIdSet(null, []), false);
});

test('libraryRootFromItemPath recovers the library root from an item path', () => {
  // The real layout, on Windows and on POSIX separators.
  assert.equal(
    Index.libraryRootFromItemPath(path, 'D:\\Design.library\\images\\ABC123.info\\photo.png'),
    'D:\\Design.library');
  assert.equal(
    Index.libraryRootFromItemPath(path, '/home/u/Pictures/Design.library/images/ABC.info/a.png'),
    '/home/u/Pictures/Design.library');
  // Eagle normalises injected paths to forward slashes, so mixed input happens.
  assert.equal(
    Index.libraryRootFromItemPath(path, 'D:/Design.library/images/ABC.info/a.jpg'),
    'D:/Design.library');
  // Anything that is not an Eagle item path must be rejected outright.
  assert.equal(Index.libraryRootFromItemPath(path, 'D:\\Design.library\\a.jpg'), null);
  assert.equal(Index.libraryRootFromItemPath(path, 'D:\\somewhere\\else\\file.jpg'), null);
  assert.equal(Index.libraryRootFromItemPath(path, 'a.jpg'), null);
  assert.equal(Index.libraryRootFromItemPath(path, ''), null);
  assert.equal(Index.libraryRootFromItemPath(path, null), null);
  assert.equal(Index.libraryRootFromItemPath(null, 'D:\\x\\images\\a.info\\b.jpg'), null);
});

test('mapWithConcurrency runs every item and never exceeds the limit', async () => {
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 200 }, (_, i) => i);

  await Index.mapWithConcurrency(items, 8, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(n);
    inFlight--;
  });

  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, items.length);
  assert.ok(peak <= 8, `expected at most 8 in flight, peaked at ${peak}`);
  assert.ok(peak > 1, 'expected real concurrency, not serial execution');
});

test('mapWithConcurrency tolerates an empty list', async () => {
  let called = 0;
  await Index.mapWithConcurrency([], 8, async () => { called++; });
  assert.equal(called, 0);
});

/* ---------- scanning a library ---------- */

test('scanLibrary reads dimensions and skips non-raster items', async () => {
  const lib = makeLibrary({
    AAA: { name: 'wide', width: 1920, height: 1080, ext: 'jpg' },
    BBB: { name: 'near square', width: 3413, height: 3430, ext: 'png' },
    CCC: { width: 500, height: 500, ext: 'gif' },
    DDD: { width: 300, height: 400 },                       // missing ext/name is fine
    EEE: { name: 'a video, no dimensions' },                // must be skipped
    FFF: 'this is not json'                                 // must be skipped
  });
  try {
    const res = await Index.scanLibrary({ fs, path, libraryPath: lib, concurrency: 4 });
    assert.equal(res.total, 6);
    assert.equal(res.rows.length, 4);
    assert.equal(res.skipped, 2);
    const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));
    assert.deepEqual(byId.BBB, { id: 'BBB', w: 3413, h: 3430, ext: 'png', name: 'near square' });
    assert.equal(byId.DDD.ext, '');
    assert.equal(byId.DDD.name, '');
    assert.equal(byId.EEE, undefined);
    assert.ok(res.ms >= 0);
  } finally {
    rm(lib);
  }
});

test('scanLibrary reports progress monotonically up to the total', async () => {
  const items = {};
  for (let i = 0; i < 1200; i++) items['ID' + i] = { width: 100 + i, height: 100, ext: 'jpg' };
  const lib = makeLibrary(items);
  try {
    const seen = [];
    await Index.scanLibrary({
      fs, path, libraryPath: lib, concurrency: 16,
      onProgress: (done, total) => seen.push([done, total])
    });
    assert.ok(seen.length > 0, 'progress callback should fire');
    const last = seen[seen.length - 1];
    assert.equal(last[0], 1200, 'final progress should equal the total');
    assert.equal(last[1], 1200);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i][0] >= seen[i - 1][0], 'progress must not go backwards');
    }
  } finally {
    rm(lib);
  }
});

test('loadIndex throws a labelled error when the library is unreadable', async () => {
  await assert.rejects(
    () => Index.loadIndex({ fs, path, libraryPath: path.join(os.tmpdir(), 'eagleidx-does-not-exist') }),
    (err) => err.code === 'LIBRARY_UNREADABLE'
  );
});

/* ---------- caching behaviour ---------- */

test('loadIndex scans once, then serves the cache while ids are unchanged', async () => {
  const lib = makeLibrary({
    AAA: { width: 100, height: 100, ext: 'png' },
    BBB: { width: 200, height: 100, ext: 'jpg' }
  });
  const cachePath = path.join(lib, 'cache.json');
  try {
    const first = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(first.source, 'scan');
    assert.equal(first.cacheSaved, true);
    assert.equal(first.rows.length, 2);
    assert.ok(fs.existsSync(cachePath), 'cache file should be written');

    const second = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(second.source, 'cache', 'unchanged library should hit the cache');
    assert.deepEqual(
      second.rows.map((r) => r.id).sort(),
      first.rows.map((r) => r.id).sort()
    );
  } finally {
    rm(lib);
  }
});

test('loadIndex rescans when an item is added or removed', async () => {
  const lib = makeLibrary({ AAA: { width: 100, height: 100 } });
  const cachePath = path.join(lib, 'cache.json');
  try {
    await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });

    fs.mkdirSync(path.join(lib, 'images', 'BBB.info'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'images', 'BBB.info', 'metadata.json'),
      JSON.stringify({ width: 300, height: 300 }), 'utf8');

    const after = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(after.source, 'scan', 'a new item must invalidate the cache');
    assert.equal(after.rows.length, 2);

    fs.rmSync(path.join(lib, 'images', 'BBB.info'), { recursive: true, force: true });
    const removed = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(removed.source, 'scan', 'a removed item must invalidate the cache');
    assert.equal(removed.rows.length, 1);
  } finally {
    rm(lib);
  }
});

test('loadIndex honours force and tolerates a good cache with a foreign library path', async () => {
  const lib = makeLibrary({ AAA: { width: 10, height: 10 } });
  const cachePath = path.join(lib, 'cache.json');
  try {
    await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    const forced = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath, force: true });
    assert.equal(forced.source, 'scan', 'force must bypass the cache');

    // A cache recorded for a different library must never be reused.
    fs.writeFileSync(cachePath, JSON.stringify({
      version: Index.CACHE_VERSION, libraryPath: 'D:\\Other.library', ids: ['AAA'], rows: []
    }), 'utf8');
    const other = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(other.source, 'scan');
    assert.equal(other.rows.length, 1);
  } finally {
    rm(lib);
  }
});

test('a corrupt cache degrades to a scan instead of failing', async () => {
  const lib = makeLibrary({ AAA: { width: 10, height: 10 } });
  const cachePath = path.join(lib, 'cache.json');
  try {
    fs.writeFileSync(cachePath, '{ truncated json', 'utf8');
    const res = await Index.loadIndex({ fs, path, libraryPath: lib, cachePath });
    assert.equal(res.source, 'scan');
    assert.equal(res.rows.length, 1);
  } finally {
    rm(lib);
  }
});

test('an unwritable cache path still yields a usable index', async () => {
  const lib = makeLibrary({ AAA: { width: 10, height: 10 } });
  try {
    const res = await Index.loadIndex({
      fs, path, libraryPath: lib,
      cachePath: path.join(lib, 'no-such-dir', 'deep', 'cache.json')
    });
    assert.equal(res.rows.length, 1);
    assert.equal(res.cacheSaved, false, 'a failed cache write must be reported, not thrown');
  } finally {
    rm(lib);
  }
});
