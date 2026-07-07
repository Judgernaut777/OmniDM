/**
 * Smoke test (node:test runner) — the SAME cases as the legacy `npm run smoke`
 * runner, executed as real `node:test` tests: one `test()` per section, with
 * TAP output, per-test pass/fail, and a real process exit code (0 all-green, 1
 * on any failure). Run with `npm test` (→ `tsx src/smoke/node-test.ts`).
 *
 * Run IN-PROCESS on purpose (plain `tsx <file>`, NOT `tsx --test`): the `--test`
 * CLI runner ships results back over a worker/IPC channel, and structured-clone
 * of the heavy web-adapter socket section's diagnostics intermittently throws
 * "Unable to deserialize cloned data" under tsx, aborting the run mid-suite. In
 * process, node:test still auto-runs every registered test(), prints TAP, and
 * sets the exit code — deterministically — with no cross-worker serialization.
 *
 * Each section runs against a fresh {@link CollectingReporter}; any failed
 * `check` (or a thrown section) fails that node:test test, naming the checks
 * that failed. Sections run in registration order (node:test runs top-level
 * tests sequentially) so the handful that reuse an earlier section's fixture
 * still see it — the same ordering the counted runner relies on.
 */
import { after, before, test } from 'node:test';
import { CollectingReporter, setReporter, Suite } from './harness.js';
import { registerAll } from './sections.js';

const suite = new Suite();
registerAll(suite);

before(() => suite.runSetup());
after(() => suite.runTeardown());

for (const { name, fn } of suite.specs) {
  test(name, async () => {
    const reporter = new CollectingReporter();
    setReporter(reporter);
    await fn(); // a throw fails the test naturally (section isolation is the runner's job here)
    if (reporter.failures > 0) {
      throw new Error(`${reporter.failures}/${reporter.total} checks failed:\n - ${reporter.failedLabels.join('\n - ')}`);
    }
  });
}
