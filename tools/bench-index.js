/* Benchmark the real indexer against a real library.
 *
 * Usage:  node tools/bench-index.js "D:\\Design.library" [cachePath]
 *
 * Runs js/indexer.js (the same module the plugin loads) twice: once cold so
 * you can see the direct-read cost, once warm to show the cache hit.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const IX = require('../js/indexer.js');

const libraryPath = process.argv[2];
if (!libraryPath) {
  console.error('usage: node tools/bench-index.js <library path> [cachePath]');
  process.exit(2);
}
const cachePath = process.argv[3] || path.join(os.tmpdir(), 'eagle-shape-range-bench-cache.json');
try { fs.unlinkSync(cachePath); } catch (e) { /* first run has no cache */ }

function fmt(n) { return Number(n).toLocaleString('en-US'); }

(async () => {
  console.log(`library : ${libraryPath}`);
  console.log(`cache   : ${cachePath}\n`);

  let lastReport = 0;
  const cold = await IX.loadIndex({
    fs, path, libraryPath, cachePath,
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastReport + 20) {
        lastReport = pct - (pct % 20);
        process.stdout.write(`  ... ${pct}% (${fmt(done)}/${fmt(total)})\n`);
      }
    }
  });

  const warm = await IX.loadIndex({ fs, path, libraryPath, cachePath });

  const ratios = cold.rows.map((r) => r.w / r.h);
  const squares = cold.rows.filter((r) => r.w === r.h).length;
  const near1 = cold.rows.filter((r) => Math.abs(r.w / r.h - 1) <= 0.05).length;
  const near169 = cold.rows.filter((r) => Math.abs(r.w / r.h - 16 / 9) <= (16 / 9) * 0.05).length;
  const ex169 = cold.rows.filter((r) => r.w / r.h === 16 / 9).length;
  const cacheBytes = fs.existsSync(cachePath) ? fs.statSync(cachePath).size : 0;

  console.log('\n-- cold scan (direct metadata reads) --');
  console.log(`  items with dimensions : ${fmt(cold.rows.length)} / ${fmt(cold.total)} folders`);
  console.log(`  skipped (no raster)   : ${fmt(cold.skipped)}`);
  console.log(`  elapsed               : ${(cold.ms / 1000).toFixed(2)}s`);
  console.log(`  throughput            : ${fmt(Math.round(cold.total / (cold.ms / 1000)))} files/s`);
  console.log(`  cache written         : ${cold.cacheSaved ? (cacheBytes / 1024 / 1024).toFixed(1) + ' MB' : 'no'}`);

  console.log('\n-- warm start (cache hit) --');
  console.log(`  source                : ${warm.source}`);
  console.log(`  elapsed               : ${warm.ms} ms`);
  console.log(`  rows identical        : ${warm.rows.length === cold.rows.length}`);

  console.log('\n-- what the fuzzy filter can find --');
  console.log(`  exact square (w === h): ${fmt(squares)}`);
  console.log(`  square within 5%      : ${fmt(near1)}`);
  console.log(`  16:9 exact            : ${fmt(ex169)}`);
  console.log(`  16:9 within 5%        : ${fmt(near169)}`);
  console.log(`  ratio spread          : ${Math.min(...ratios).toFixed(3)} .. ${Math.max(...ratios).toFixed(3)}`);

  console.log(`\nRESULT: indexed ${fmt(cold.rows.length)} items in ${(cold.ms / 1000).toFixed(2)}s cold, ` +
    `${warm.ms}ms warm`);
})().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
