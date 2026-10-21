// SPDX-License-Identifier: Apache-2.0
import { writeFile as writeFileFs } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { host, openSandbox, run } from './sandbox.ts';

const ITERATIONS = Number(process.env['BENCH_ITERATIONS'] ?? 10_000);
const SPAWN_SAMPLES = 20;

/**
 * Measures sync-syscall latency for both kernel wake mechanisms plus process
 * spawn and kernel boot, and writes bench-results.json at the repo root.
 */
test('syscall latency and spawn benchmarks', async ({ page, browser }) => {
  const kernelBootMs = await openSandbox(page);

  const syscalls: Record<string, unknown> = {};
  for (const mode of ['waitAsync', 'postMessage'] as const) {
    const result = await run(page, ['clientvm-bench', String(ITERATIONS)], mode);
    expect(result.code, result.stderr).toBe(0);
    syscalls[mode] = JSON.parse(result.stdout);
  }

  const spawn: Record<string, unknown> = {};
  for (const mode of ['waitAsync', 'postMessage'] as const) {
    const toReady: number[] = [];
    const total: number[] = [];
    // First spawn pays for fetching and compiling the worker bundle; report it separately.
    const cold = await run(page, ['node', '-e', '0'], mode);
    for (let i = 0; i < SPAWN_SAMPLES; i++) {
      const r = await run(page, ['node', '-e', '0'], mode);
      expect(r.code).toBe(0);
      if (r.spawnToReadyMs !== null) toReady.push(r.spawnToReadyMs);
      total.push(r.totalMs);
    }
    spawn[mode] = {
      coldTotalMs: round(cold.totalMs),
      spawnToReadyMs: summarize(toReady),
      nodeEvalZeroTotalMs: summarize(total),
    };
  }

  // Persistence: flush cost for a node_modules-sized tree, restore time, and
  // syscall latency while a flush is running in the same kernel worker.
  const persistence: Record<string, unknown> = {};
  {
    const id = await host(page, 'createInstance', { id: 'benchpersist', fs: { persist: true } });
    const populate = String.raw`
      const fs = require('fs');
      for (let d = 0; d < 100; d++) {
        fs.mkdirSync('/home/user/node_modules/pkg' + d + '/lib', { recursive: true });
        for (let f = 0; f < 50; f++) {
          const body = new Uint8Array(2048 + ((d * 50 + f) % 7) * 512);
          body.fill((d * 50 + f) & 0xff);
          fs.writeFileSync('/home/user/node_modules/pkg' + d + '/lib/f' + f + '.js', body);
        }
      }`;
    await host(page, 'run', id, { argv: ['node', '-e', populate] });
    const t0 = Date.now();
    await host(page, 'flush', id);
    persistence['fullFlushMs_5000files'] = Date.now() - t0;

    // Change one file per package (100 new blobs), then measure syscalls during that flush.
    const touch =
      "const fs = require('fs'); for (let d = 0; d < 100; d++) fs.writeFileSync('/home/user/node_modules/pkg' + d + '/lib/f0.js', 'changed' + d)";
    await host(page, 'run', id, { argv: ['node', '-e', touch] });
    const [during] = await Promise.all([
      host(page, 'run', id, { argv: ['clientvm-bench', '3000'] }),
      host(page, 'flush', id),
    ]);
    const duringReport = JSON.parse(during.stdout) as Record<
      string,
      { batchMeanUs: object; perCallUs: object }
    >;
    persistence['syscallsDuringFlush'] = { noop: duringReport['noop'], stat: duringReport['stat'] };

    await host(page, 'destroy', id);
    const r0 = Date.now();
    const restored = await host(page, 'createInstance', {
      id: 'benchpersist',
      fs: { persist: true },
    });
    persistence['restoreBootMs_5000files'] = Date.now() - r0;
    await host(page, 'destroy', restored, true);
  }

  const report = {
    date: new Date().toISOString(),
    browser: `${browser.browserType().name()} ${browser.version()}`,
    iterations: ITERATIONS,
    kernelBootMs: round(kernelBootMs),
    syscalls,
    spawn,
    persistence,
  };
  await writeFileFs('bench-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { p50: round(at(50)), p95: round(at(95)), max: round(sorted[sorted.length - 1] ?? 0) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
