// SPDX-License-Identifier: Apache-2.0
// Regenerates packages/node-compat/src/vendor/readable-stream.ts from the pinned
// npm tarball (Node's streams, as published by the Node.js team). Usage:
//   node scripts/vendor-readable-stream.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const VERSION = '4.8.0';
const OUT = new URL('../packages/node-compat/src/vendor/readable-stream.ts', import.meta.url)
  .pathname;

const dir = mkdtempSync(join(tmpdir(), 'vendor-rs-'));
try {
  // npm verifies the tarball against the registry's integrity hash.
  const [info] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', `readable-stream@${VERSION}`, '--json', '--pack-destination', dir],
      { encoding: 'utf8' },
    ),
  );
  execFileSync('tar', ['xzf', join(dir, info.filename), '-C', dir]);
  const pkg = join(dir, 'package');
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files[relative(pkg, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(pkg, 'lib'));
  const license = readFileSync(join(pkg, 'LICENSE'), 'utf8');
  const body = [
    '// SPDX-License-Identifier: MIT',
    `// Vendored from readable-stream@${VERSION} (${info.integrity}) by scripts/vendor-readable-stream.mjs.`,
    '// Node.js streams, published by the Node.js team. Do not edit by hand. See docs/decisions/0010.',
    '/* eslint-disable */',
    '',
    `export const VERSION = ${JSON.stringify(VERSION)};`,
    `export const INTEGRITY = ${JSON.stringify(info.integrity)};`,
    `export const LICENSE = ${JSON.stringify(license)};`,
    '',
    '/** Package-relative path → CommonJS source. */',
    `export const FILES: Record<string, string> = ${JSON.stringify(files, null, 1)};`,
    '',
  ].join('\n');
  writeFileSync(OUT, body);
  console.log(
    `wrote ${Object.keys(files).length} files (${body.length} bytes) to ${relative(process.cwd(), OUT)}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
