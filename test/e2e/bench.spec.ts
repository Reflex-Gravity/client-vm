// SPDX-License-Identifier: Apache-2.0
import { writeFile as writeFileFs } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openSandbox, run } from './sandbox.ts';

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

  const report = {
    date: new Date().toISOString(),
    browser: `${browser.browserType().name()} ${browser.version()}`,
    iterations: ITERATIONS,
    kernelBootMs: round(kernelBootMs),
    syscalls,
    spawn,
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
