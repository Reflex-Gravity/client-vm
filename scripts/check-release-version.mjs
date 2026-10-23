// SPDX-License-Identifier: Apache-2.0
// Fails unless every publishable package under packages/ has the given version.
// Usage: node scripts/check-release-version.mjs 0.1.0
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('../packages', import.meta.url).pathname;
const want = process.argv[2];
if (!want) {
  console.error('usage: check-release-version.mjs <version>');
  process.exit(2);
}

const mismatched = [];
for (const dir of await readdir(ROOT)) {
  const pkg = JSON.parse(await readFile(join(ROOT, dir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  if (pkg.version !== want) mismatched.push(`${pkg.name}@${pkg.version}`);
}

if (mismatched.length > 0) {
  console.error(`Tag is v${want} but these packages differ:\n  ${mismatched.join('\n  ')}`);
  process.exit(1);
}
console.log(`All publishable packages are at ${want}.`);
