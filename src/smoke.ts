/**
 * Smoke test (legacy runner) — drives the full bot pipeline with a mock
 * provider (no network, no API key), printing ✅/❌/⏭ per assertion and a
 * counted summary, then exiting non-zero on any failure. This is the gate
 * (`npm run smoke`).
 *
 * The test kit lives in ./smoke/harness.ts and the cases in ./smoke/sections.ts;
 * the SAME cases also run under node:test via ./smoke/node-test.ts (`npm run
 * test`). This file is just the counted runner: it registers every section,
 * runs them in order (each isolated — a throw is reported as one failed check
 * and the run continues), and prints the headline the gate reads.
 *
 * Run:  npm run smoke   (or: npx tsx src/smoke.ts)
 */
import { LegacyReporter, setReporter, Suite } from './smoke/harness.js';
import { registerAll } from './smoke/sections.js';

async function main(): Promise<void> {
  const suite = new Suite();
  registerAll(suite);

  const reporter = new LegacyReporter();
  setReporter(reporter);

  await suite.runSetup();
  for (const { name, fn } of suite.specs) {
    // Per-section isolation: a throw (real regression, stale fixture, env
    // hiccup) becomes one failed check carrying the section name, and the run
    // continues — never blinding every downstream section.
    try {
      await fn();
    } catch (err) {
      reporter.sectionThrew(name, err);
    }
  }
  await suite.runTeardown();

  const passed = reporter.total - reporter.failures;
  const behavioral = reporter.total - reporter.staticTotal;
  console.log(
    `\n${reporter.failures === 0 ? '🎉 all checks passed' : `💥 ${reporter.failures} check(s) failed`} — ` +
      `${passed} passed, ${reporter.failures} failed, ${reporter.skipped} skipped ` +
      `(${reporter.total} asserted — ${behavioral} behavioral, ${reporter.staticTotal} static source/config/doc)`,
  );
  process.exit(reporter.failures === 0 ? 0 : 1);
}

main();
