// SPDX-License-Identifier: Apache-2.0
// Writes test/conformance/npm-top.json: the most-downloaded npm packages, for
// the full smoke run (test/e2e/smoke-full.spec.ts). The ranking comes from
// npm-high-impact (MIT, https://github.com/wooorm/npm-high-impact), fetched
// with npm into a temporary directory; it is not a dependency of the repo.
//
//   node scripts/top-npm-packages.mjs [count=1000] [npm-high-impact version]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const count = Number(process.argv[2] ?? 1000);
const version = process.argv[3] ?? '1.13.0';
const OUT = new URL('../test/conformance/npm-top.json', import.meta.url);

const dir = mkdtempSync(join(tmpdir(), 'npm-high-impact-'));
try {
  execFileSync('npm', ['pack', `npm-high-impact@${version}`, '--silent'], { cwd: dir });
  execFileSync('tar', ['xzf', `npm-high-impact-${version}.tgz`], { cwd: dir });
  const { topDownload } = await import(
    pathToFileURL(join(dir, 'package/lib/top-download.js')).href
  );
  const integrity = JSON.parse(
    execFileSync('npm', ['view', `npm-high-impact@${version}`, 'dist.integrity', '--json'], {
      encoding: 'utf8',
    }),
  );
  const packages = topDownload.slice(0, count);
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        source: `npm-high-impact@${version} (topDownload)`,
        integrity,
        license: JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8')).license,
        packages,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${packages.length} packages to ${OUT.pathname}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
