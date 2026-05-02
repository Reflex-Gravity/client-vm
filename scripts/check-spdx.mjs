// SPDX-License-Identifier: Apache-2.0
// Fails if any first-party source file lacks the SPDX header on its first line.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HEADER = '// SPDX-License-Identifier: Apache-2.0';
const EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  '.git',
  'test-results',
  'playwright-report',
  'coverage',
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield join(dir, entry.name);
    }
  }
}

const missing = [];
for await (const file of walk(ROOT)) {
  const firstLine = (await readFile(file, 'utf8')).split('\n', 1)[0];
  if (firstLine !== HEADER) missing.push(relative(ROOT, file));
}

if (missing.length > 0) {
  console.error(`Missing "${HEADER}" on line 1 of:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('SPDX headers OK');
