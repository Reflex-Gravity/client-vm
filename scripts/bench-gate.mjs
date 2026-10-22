// SPDX-License-Identifier: Apache-2.0
// Compares bench-results.json (written by `pnpm bench`) against
// bench/baseline.json and fails when a tracked metric regresses by more than
// its allowed factor. Shared CI runners are noisy, so factors are wide; the
// gate catches order-of-magnitude regressions, the report shows the trend.
//   node scripts/bench-gate.mjs            check
//   node scripts/bench-gate.mjs --update   rewrite the baseline from the latest results
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const RESULTS = `${ROOT}bench-results.json`;
const BASELINE = `${ROOT}bench/baseline.json`;

/** Tracked metrics: a path into the results, and how much worse (×) is tolerated. All are lower-is-better. */
const METRICS = [
  ['kernelBootMs', 3],
  ['instanceCreateMs.p50', 3],
  ['syscalls.waitAsync.noop.perCallUs.p50', 3],
  ['syscalls.waitAsync.stat.perCallUs.p50', 3],
  ['spawn.waitAsync.spawnToReadyMs.p50', 3],
  ['spawn.waitAsync.nodeEvalZeroTotalMs.p50', 3],
  ['shellLoop10kMs', 3],
  ['persistence.fullFlushMs_5000files', 3],
  ['persistence.restoreBootMs_5000files', 3],
  ['memory.instanceMB', 2],
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
if (process.argv.includes('--update')) {
  const baseline = {
    note: 'Regenerate with: pnpm bench && node scripts/bench-gate.mjs --update',
    from: results.date,
    browser: results.browser,
    metrics: {},
  };
  for (const [path] of METRICS) {
    const v = get(results, path);
    if (typeof v === 'number') baseline.metrics[path] = v;
  }
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`baseline updated from ${results.date}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).metrics;
const rows = [];
let failed = false;
for (const [path, factor] of METRICS) {
  const now = get(results, path);
  const base = baseline[path];
  if (typeof now !== 'number' || typeof base !== 'number') {
    rows.push(`  ?  ${path}: ${now ?? 'missing'} (baseline ${base ?? 'missing'})`);
    continue;
  }
  // Tiny values (sub-microsecond, sub-millisecond) get an absolute floor so noise can't fail them.
  const limit = Math.max(base * factor, base + 1);
  const bad = now > limit;
  failed ||= bad;
  rows.push(
    `${bad ? 'FAIL' : ' ok '} ${path}: ${now} (baseline ${base}, limit ${limit.toFixed(2)})`,
  );
}
console.log(rows.join('\n'));
if (failed) {
  console.error(
    '\nPerformance regression beyond the allowed factor. See docs/phase5-plan.md (5d).',
  );
  process.exit(1);
}
