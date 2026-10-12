// SPDX-License-Identifier: Apache-2.0
import { Op, encode } from '@clientvm/protocol';
import type { ProcessContext } from './context.ts';

export interface LatencySummary {
  iterations: number;
  /** Per-call latency in microseconds (quantized by the timer resolution, ~5us when cross-origin isolated). */
  perCallUs: { p50: number; p95: number; p99: number; max: number };
  /** Mean per-call latency of each batch, in microseconds; immune to timer quantization. */
  batchMeanUs: { p50: number; p95: number; p99: number };
  opsPerSec: number;
}

export type BenchReport = Record<string, LatencySummary>;

interface Case {
  name: string;
  iterations: number;
  op: number;
  request: Uint8Array;
}

const BATCH = 50;

/**
 * `clientvm-bench`: measures raw sync-syscall round trips from inside a
 * process worker and prints a JSON {@link BenchReport} on stdout.
 * Usage: clientvm-bench [iterations]
 */
export function benchRuntime(ctx: ProcessContext): number {
  const iterations = Number(ctx.argv[1] ?? 10_000);
  const { syscall } = ctx;

  const small = new Uint8Array(4 * 1024).fill(97);
  const large = new Uint8Array(1024 * 1024).fill(98);
  syscall.call(Op.WRITE_FILE, encode(['/tmp/bench-4k', small]));
  syscall.call(Op.WRITE_FILE, encode(['/tmp/bench-1m', large]));

  const cases: Case[] = [
    { name: 'noop', iterations, op: Op.NOOP, request: new Uint8Array(0) },
    { name: 'stat', iterations, op: Op.STAT, request: encode(['/home/user']) },
    { name: 'readFile-4KiB', iterations, op: Op.READ_FILE, request: encode(['/tmp/bench-4k']) },
    {
      name: 'readFile-1MiB',
      iterations: Math.max(BATCH, Math.floor(iterations / 20)),
      op: Op.READ_FILE,
      request: encode(['/tmp/bench-1m']),
    },
  ];

  const report: BenchReport = {};
  for (const c of cases) {
    // Warm up JIT and caches before measuring.
    for (let i = 0; i < Math.min(1000, c.iterations); i++) syscall.call(c.op, c.request);

    const perCall: number[] = [];
    const batchMeans: number[] = [];
    const start = performance.now();
    for (let done = 0; done < c.iterations; done += BATCH) {
      const batchStart = performance.now();
      for (let i = 0; i < BATCH; i++) {
        const t0 = performance.now();
        syscall.call(c.op, c.request);
        perCall.push((performance.now() - t0) * 1000);
      }
      batchMeans.push(((performance.now() - batchStart) * 1000) / BATCH);
    }
    const elapsedMs = performance.now() - start;
    perCall.sort((a, b) => a - b);
    batchMeans.sort((a, b) => a - b);
    report[c.name] = {
      iterations: perCall.length,
      perCallUs: {
        p50: pct(perCall, 50),
        p95: pct(perCall, 95),
        p99: pct(perCall, 99),
        max: Math.round((perCall[perCall.length - 1] ?? 0) * 10) / 10,
      },
      batchMeanUs: { p50: pct(batchMeans, 50), p95: pct(batchMeans, 95), p99: pct(batchMeans, 99) },
      opsPerSec: Math.round(perCall.length / (elapsedMs / 1000)),
    };
  }

  ctx.stdout.write(JSON.stringify(report) + '\n');
  return 0;
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, i)]! * 10) / 10;
}
