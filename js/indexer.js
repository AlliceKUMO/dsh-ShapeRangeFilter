/* ============================================================
 * EagleIndex — fast dimension index for an Eagle library
 *
 * Why this exists: `eagle.item.get()` serialises whole Item objects over
 * IPC, which crawls on a large library (measured: minutes on ~60k items).
 * Plugins also get Node's `fs`, and every item already stores its pixel
 * dimensions in `images/<id>.info/metadata.json`, so reading those files
 * directly is roughly two orders of magnitude faster (measured: 3.4s for
 * 59,928 items with 32-way concurrency).
 *
 * A JSON cache is written next to the plugin. On the next run the cached
 * index is reused when the set of item ids is unchanged — one `readdir`
 * instead of ~60k file reads — and the UI can force a full rescan.
 *
 * Dependency-free and injectable so it runs unchanged in the plugin and in
 * Node unit tests.
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  // See matcher.js: Eagle's renderer has both `window` and CommonJS `module`,
  // so the global must be published explicitly rather than via an else-branch.
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleIndex = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var CACHE_VERSION = 2;
  var DEFAULT_CONCURRENCY = 48;

  /** Eagle stores each item in a folder named `<id>.info`. */
  function itemIdFromDirName(name) {
    return name.slice(-5) === '.info' ? name.slice(0, -5) : name;
  }

  /**
   * Derive the library root from any item's file path.
   *
   * Eagle lays items out as `<library>/images/<id>.info/<name>.<ext>`, so the
   * root is three levels up. This is the fallback when Eagle fails to inject
   * `eagle.library.path` into the plugin window (it is injected by string
   * concatenation, so it can come through as the literal "undefined").
   *
   * @returns {string|null} null when the path does not have the expected shape
   */
  function libraryRootFromItemPath(path, filePath) {
    if (!path || typeof filePath !== 'string' || !filePath) return null;
    try {
      var imagesDir = path.dirname(path.dirname(filePath));
      if (path.basename(imagesDir).toLowerCase() !== 'images') return null;
      var root = path.dirname(imagesDir);
      return root && root !== '.' ? root : null;
    } catch (e) {
      return null;
    }
  }

  /** Yield every item folder name in the library's images directory. */
  async function listItemDirs(fs, imagesDir) {
    var entries = await fs.promises.readdir(imagesDir, { withFileTypes: true });
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isDirectory() && e.name.slice(-5) === '.info') out.push(e.name);
    }
    return out;
  }

  /**
   * Pull (width, height, ext, name) out of an item metadata blob.
   * Returns null for anything without usable raster dimensions, which is
   * how videos, fonts, PDFs and bookmarks get skipped.
   */
  function parseMetadata(text) {
    var meta;
    try {
      meta = JSON.parse(text);
    } catch (e) {
      return null;
    }
    var w = meta.width, h = meta.height;
    if (typeof w !== 'number' || typeof h !== 'number') return null;
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    return {
      w: Math.round(w),
      h: Math.round(h),
      ext: typeof meta.ext === 'string' ? meta.ext : '',
      // The display name is already in this file, so the grid can render a
      // usable tile before any thumbnail has been fetched.
      name: typeof meta.name === 'string' ? meta.name : ''
    };
  }

  async function readItem(fs, path, imagesDir, dirName) {
    var file = path.join(imagesDir, dirName, 'metadata.json');
    try {
      return parseMetadata(await fs.promises.readFile(file, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * Run `worker` over `items` with at most `limit` in flight.
   * Read errors are the worker's business; a throw aborts the whole run.
   */
  async function mapWithConcurrency(items, limit, worker) {
    var next = 0;
    var size = Math.max(1, Math.min(limit || DEFAULT_CONCURRENCY, items.length || 1));
    var runners = [];
    for (var i = 0; i < size; i++) {
      runners.push((async function () {
        while (true) {
          var index = next++;
          if (index >= items.length) return;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  function sameIdSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var x = a.slice().sort();
    var y = b.slice().sort();
    for (var i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return false;
    }
    return true;
  }

  async function readCache(fs, cachePath) {
    try {
      var parsed = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (!parsed || parsed.version !== CACHE_VERSION) return null;
      if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.ids)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  async function writeCache(fs, cachePath, payload) {
    try {
      await fs.promises.writeFile(cachePath, JSON.stringify(payload), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Scan every item folder and return the dimension rows.
   *
   * @param {object} opts
   * @param {object} opts.fs         Node fs module
   * @param {object} opts.path       Node path module
   * @param {string} opts.libraryPath  e.g. "D:\\Design.library"
   * @param {number} [opts.concurrency]
   * @param {Function} [opts.onProgress] (done, total)
   * @returns {Promise<{rows:Array, total:number, skipped:number, ms:number, dirs:string[]}>}
   */
  async function scanLibrary(opts) {
    var fs = opts.fs, path = opts.path;
    var t0 = Date.now();
    var imagesDir = path.join(opts.libraryPath, 'images');
    var dirs = await listItemDirs(fs, imagesDir);

    var rows = [];
    var done = 0;
    var skipped = 0;
    var lastReport = 0;

    await mapWithConcurrency(dirs, opts.concurrency || DEFAULT_CONCURRENCY, async function (dirName) {
      var rec = await readItem(fs, path, imagesDir, dirName);
      if (rec) {
        rows.push({ id: itemIdFromDirName(dirName), w: rec.w, h: rec.h, ext: rec.ext, name: rec.name });
      } else {
        skipped++;
      }
      done++;
      if (opts.onProgress && (done - lastReport >= 400 || done === dirs.length)) {
        lastReport = done;
        opts.onProgress(done, dirs.length);
      }
    });

    return { rows: rows, total: dirs.length, skipped: skipped, ms: Date.now() - t0, dirs: dirs };
  }

  /**
   * Load the index, preferring the cache when the library contents have not
   * changed. `force` skips the cache entirely.
   *
   * @returns {Promise<{rows, total, skipped, ms, source:'cache'|'scan', cacheSaved:boolean}>}
   */
  async function loadIndex(opts) {
    var fs = opts.fs, path = opts.path;
    var t0 = Date.now();
    var imagesDir = path.join(opts.libraryPath, 'images');

    var dirs;
    try {
      dirs = await listItemDirs(fs, imagesDir);
    } catch (e) {
      var err = new Error('无法读取资源库 images 目录:' + (e && e.message ? e.message : e));
      err.code = 'LIBRARY_UNREADABLE';
      throw err;
    }

    if (!opts.force && opts.cachePath) {
      var cached = await readCache(fs, opts.cachePath);
      if (cached && cached.libraryPath === opts.libraryPath && sameIdSet(cached.ids, dirs)) {
        return {
          rows: cached.rows, total: dirs.length, skipped: 0,
          ms: Date.now() - t0, source: 'cache', cacheSaved: true
        };
      }
    }

    var scanned = await scanLibrary({
      fs: fs, path: path, libraryPath: opts.libraryPath,
      concurrency: opts.concurrency, onProgress: opts.onProgress
    });

    var cacheSaved = false;
    if (opts.cachePath) {
      cacheSaved = await writeCache(fs, opts.cachePath, {
        version: CACHE_VERSION,
        libraryPath: opts.libraryPath,
        savedAt: Date.now(),
        ids: scanned.dirs,
        rows: scanned.rows
      });
    }

    return {
      rows: scanned.rows, total: scanned.total, skipped: scanned.skipped,
      ms: Date.now() - t0, source: 'scan', cacheSaved: cacheSaved
    };
  }

  return {
    CACHE_VERSION: CACHE_VERSION,
    DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
    itemIdFromDirName: itemIdFromDirName,
    libraryRootFromItemPath: libraryRootFromItemPath,
    listItemDirs: listItemDirs,
    parseMetadata: parseMetadata,
    mapWithConcurrency: mapWithConcurrency,
    sameIdSet: sameIdSet,
    scanLibrary: scanLibrary,
    loadIndex: loadIndex
  };
});
