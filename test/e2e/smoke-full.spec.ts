// SPDX-License-Identifier: Apache-2.0
// The full npm smoke run (CLAUDE.md §9): the most-downloaded packages
// (test/conformance/npm-top.json, from scripts/top-npm-packages.mjs) are
// installed with real npm, 50 to an instance, and each is loaded once.
// Opt-in: it needs about an hour of registry traffic, so it runs only with
// CLIENTVM_SMOKE_FULL=1 (.github/workflows/smoke-full.yml, weekly).
//
//   CLIENTVM_SMOKE_LIMIT    how many packages from the top (default all)
//   CLIENTVM_SMOKE_MIN_PASS fail below this share of loadable packages (default 0)
//   CLIENTVM_SMOKE_REPORT   where the JSON report goes (default smoke-full-results.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const LIST = JSON.parse(
  readFileSync(new URL('../conformance/npm-top.json', import.meta.url), 'utf8'),
) as { source: string; packages: string[] };
const BATCH = 50;
const env = process.env;

/** Runs in the instance: loads each package and reports how it went. */
const LOADER = String.raw`
const fs = require('fs');
const path = require('path');
const names = JSON.parse(fs.readFileSync('names.json', 'utf8'));
(async () => {
  const out = {};
  for (const name of names) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join('node_modules', name, 'package.json'), 'utf8'));
    } catch {
      out[name] = { status: 'not-installed' };
      continue;
    }
    if (!pkg.main && !pkg.exports && !pkg.module && !fs.existsSync(path.join('node_modules', name, 'index.js'))) {
      out[name] = { status: 'skip', reason: 'no JavaScript entry (types or data only)' };
      continue;
    }
    try {
      require(name);
      out[name] = { status: 'pass' };
    } catch (e) {
      try {
        await import(name);
        out[name] = { status: 'pass', via: 'import' };
      } catch (e2) {
        // Types-only packages (type-fest) export only a "types" condition; Node cannot load them either.
        if ((pkg.types || pkg.typings) && !pkg.main) {
          out[name] = { status: 'skip', reason: 'types only' };
          continue;
        }
        // Packages that export only subpaths (@babel/runtime/helpers/...) have no main to load, in Node too.
        if (pkg.exports && /No "exports" main defined/.test(String(e2 && e2.message))) {
          out[name] = { status: 'skip', reason: 'subpath exports only' };
          continue;
        }
        out[name] = { status: 'fail', error: String((e2 && e2.message) || e2).split('\n')[0].slice(0, 300) };
      }
    }
  }
  console.log(JSON.stringify(out));
})();
`;

type Result = { status: 'pass' | 'fail' | 'skip' | 'not-installed'; error?: string };

test('npm smoke: the most-downloaded packages install and load', async ({ page }) => {
  test.skip(env['CLIENTVM_SMOKE_FULL'] !== '1', 'opt-in: set CLIENTVM_SMOKE_FULL=1');
  const limit = Number(env['CLIENTVM_SMOKE_LIMIT'] || LIST.packages.length);
  const names = LIST.packages.slice(0, limit);
  test.setTimeout(names.length * 15_000 + 120_000);
  await openHost(page);
  const results: Record<string, Result> = {};
  const install = (id: string, specs: string[]) =>
    host(page, 'exec', id, `npm install --no-fund --no-audit --no-save ${specs.join(' ')}`, {
      cwd: '/home/user/app',
      timeoutMs: 600_000,
    });

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const id = await host(page, 'createInstance', {
      fs: { from: { home: { user: { app: { 'package.json': '{"private":true}\n' } } } } },
    });
    const all = await install(id, batch);
    if (all.code !== 0) {
      // Find which packages fail to install, so the rest still count.
      for (const name of batch) {
        const one = await install(id, [name]);
        if (one.code !== 0)
          results[name] = {
            status: 'fail',
            error: `install: ${one.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`,
          };
      }
    }
    await host(page, 'writeFile', id, '/home/user/app/names.json', JSON.stringify(batch));
    await host(page, 'writeFile', id, '/home/user/app/load.cjs', LOADER);
    const r = await host(page, 'exec', id, 'node load.cjs', {
      cwd: '/home/user/app',
      timeoutMs: 300_000,
    });
    const loaded = r.code === 0 ? (JSON.parse(r.stdout) as Record<string, Result>) : {};
    for (const name of batch) {
      results[name] ??= loaded[name] ?? {
        status: 'fail',
        error: `loader exited with ${r.code}: ${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
      };
    }
    await host(page, 'destroy', id);
  }

  const counted = Object.values(results).filter((r) => r.status === 'pass' || r.status === 'fail');
  const passed = counted.filter((r) => r.status === 'pass').length;
  const rate = counted.length ? passed / counted.length : 1;
  const report = {
    source: LIST.source,
    total: names.length,
    passed,
    failed: counted.length - passed,
    skipped: names.length - counted.length,
    passRate: Number(rate.toFixed(4)),
    results,
  };
  writeFileSync(
    env['CLIENTVM_SMOKE_REPORT'] ?? 'smoke-full-results.json',
    `${JSON.stringify(report, null, 1)}\n`,
  );
  test.info().annotations.push({
    type: 'smoke',
    description: `${passed}/${counted.length} loadable packages pass (${report.skipped} skipped)`,
  });
  expect(rate).toBeGreaterThanOrEqual(Number(env['CLIENTVM_SMOKE_MIN_PASS'] ?? 0));
});
