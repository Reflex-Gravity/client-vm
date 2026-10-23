// SPDX-License-Identifier: Apache-2.0
// Regenerates packages/clientvm/src/presets/<name>.ts from the project
// templates in packages/clientvm/presets/<name>/ (ADR 0018). Each module holds
// the template's files and a version: a hash of them, so a changed template
// never reuses an image cached from the old one. Usage:
//   node scripts/build-presets.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { format, resolveConfig } from 'prettier';

const PRESETS = ['vite-react-ts'];
const ROOT = new URL('../packages/clientvm/', import.meta.url).pathname;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name));
    else yield join(dir, entry.name);
  }
}

/** Same scheme as `presetVersion` in packages/clientvm/src/presets.test.ts. */
function version(files) {
  const hash = createHash('sha256');
  for (const [path, text] of files) hash.update(`${path}\0${text}\0`);
  return hash.digest('hex').slice(0, 16);
}

for (const name of PRESETS) {
  const dir = join(ROOT, 'presets', name);
  const files = [...walk(dir)].map((file) => [relative(dir, file), readFileSync(file, 'utf8')]);
  const tree = {};
  for (const [path, text] of files) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = text;
  }
  const out = join(ROOT, 'src', 'presets', `${name}.ts`);
  const source = [
    '// SPDX-License-Identifier: Apache-2.0',
    `// Generated from packages/clientvm/presets/${name}/ by scripts/build-presets.mjs.`,
    '// Do not edit by hand.',
    "import type { PresetTemplate } from '../presets.ts';",
    '',
    `export const template: PresetTemplate = ${JSON.stringify({ version: version(files), files: tree })};`,
    '',
  ].join('\n');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await format(source, { ...(await resolveConfig(out)), filepath: out }));
  console.log(`wrote ${out}`);
}
