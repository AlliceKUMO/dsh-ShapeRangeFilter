/* Single-process test entry point.
 *
 * `node --test` spawns one child process per test file with piped stdio,
 * which the DSH Windows sandbox blocks with EPERM. Requiring the test files
 * from one process runs the same node:test suites without spawning anything.
 *
 * Run with:  node test/run-all.js
 */
require('./matcher.test.js');
require('./indexer.test.js');
require('./ui-contract.test.js');
