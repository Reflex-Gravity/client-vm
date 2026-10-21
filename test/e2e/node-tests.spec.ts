// SPDX-License-Identifier: Apache-2.0
// Node's own tests (test/conformance/node-tests): every test in the vendored
// passing set must still pass inside an instance. Refresh the set with
// scripts/vendor-node-tests.mjs after a discovery run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const ROOT = new URL('../conformance/node-tests/', import.meta.url).pathname;
const manifest = existsSync(join(ROOT, 'manifest.json'))
  ? (JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as { passing: string[] })
  : { passing: [] };
const SHARDS = 4;
const BATCH = 40;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text when valid UTF-8, else the bytes (fixtures include binary files). */
function contents(file: string): string | Uint8Array {
  const bytes = readFileSync(file);
  try {
    return utf8.decode(bytes);
  } catch {
    return new Uint8Array(bytes);
  }
}

function tree(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    out[e.name] = e.isDirectory() ? tree(join(dir, e.name)) : contents(join(dir, e.name));
  }
  return out;
}

test.describe.configure({ mode: 'parallel' });

for (let shard = 0; shard < SHARDS; shard++) {
  test(`Node.js test/parallel subset, shard ${shard + 1}/${SHARDS}`, async ({ page }) => {
    const mine = manifest.passing.filter((_, i) => i % SHARDS === shard);
    test.setTimeout(60_000 + mine.length * 3_000);
    await openHost(page);
    const common = tree(join(ROOT, 'common'));
    const fixtures = tree(join(ROOT, 'fixtures'));
    const failures: string[] = [];
    for (let i = 0; i < mine.length; i += BATCH) {
      const batch = mine.slice(i, i + BATCH);
      const parallel: Record<string, string> = {};
      for (const f of batch) parallel[f] = readFileSync(join(ROOT, 'parallel', f), 'utf8');
      const id = await host(page, 'createInstance', {
        fs: { from: { node: { test: { common, fixtures, parallel } } } },
      });
      for (const f of batch) {
        const r = await host(page, 'run', id, {
          argv: ['node', `/node/test/parallel/${f}`],
          cwd: '/node',
          timeoutMs: 15_000,
        } as never);
        if (r.code !== 0)
          failures.push(`${f} (exit ${r.code})\n${r.stderr.split('\n').slice(0, 8).join('\n')}`);
      }
      await host(page, 'destroy', id);
    }
    expect(failures.join('\n\n')).toBe('');
  });
}
