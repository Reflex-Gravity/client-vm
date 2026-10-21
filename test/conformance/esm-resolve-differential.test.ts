// SPDX-License-Identifier: Apache-2.0
// ESM resolution: EsmResolver vs real Node import(), on a fixture tree on disk.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EsmResolver } from '@clientvm/node-compat';
import type { ResolverFs } from '@clientvm/node-compat';
import { afterAll, describe, expect, it } from 'vitest';

const FILES: Record<string, string> = {
  'app/package.json': JSON.stringify({
    name: 'app',
    type: 'module',
    exports: { '.': './main.js', './x': './lib/x.js' },
    imports: {
      '#x': './lib/x.js',
      '#c': { import: './lib/esm.js', require: './lib/cjs.cjs' },
      '#dep/*': 'dual/*',
    },
  }),
  'app/main.js': '',
  'app/lib/x.js': '',
  'app/lib/esm.js': '',
  'app/lib/cjs.cjs': '',
  'app/lib/noext': '',
  'app/lib/dir/index.js': '',
  'app/lib/space name.js': '',
  'app/data.json': '{}',
  'app/node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: {
      '.': { import: './esm.mjs', require: './cjs.cjs' },
      './sync': { 'module-sync': './sync.mjs', default: './nosync.cjs' },
      './feature/*': './f/*.js',
      './package.json': './package.json',
    },
  }),
  'app/node_modules/dual/esm.mjs': '',
  'app/node_modules/dual/cjs.cjs': '',
  'app/node_modules/dual/sync.mjs': '',
  'app/node_modules/dual/nosync.cjs': '',
  'app/node_modules/dual/f/a.js': '',
  'app/node_modules/legacy/package.json': JSON.stringify({ main: 'lib/main' }),
  'app/node_modules/legacy/lib/main.js': '',
  'app/node_modules/legacy/lib/sub.js': '',
  'app/node_modules/legacy-index/index.js': '',
  'app/node_modules/legacy-dirmain/package.json': JSON.stringify({ main: './dist' }),
  'app/node_modules/legacy-dirmain/dist/index.js': '',
  'app/node_modules/legacy-broken/package.json': JSON.stringify({ main: 'missing.js' }),
  'app/node_modules/@sc/pkg/package.json': JSON.stringify({ exports: './i.js' }),
  'app/node_modules/@sc/pkg/i.js': '',
};

const CASES: [string, string][] = [
  ['app/main.js', './lib/x.js'],
  ['app/main.js', './lib/x'],
  ['app/main.js', './lib/noext'],
  ['app/main.js', './lib/dir'],
  ['app/main.js', './lib/dir/'],
  ['app/main.js', './lib/dir/index.js'],
  ['app/main.js', './lib/space%20name.js'],
  ['app/main.js', './lib/%2fx.js'],
  ['app/main.js', '/nonexistent/abs.js'],
  ['app/main.js', '../app/lib/esm.js?query=1'],
  ['app/main.js', 'dual'],
  ['app/main.js', 'dual/sync'],
  ['app/main.js', 'dual/feature/a'],
  ['app/main.js', 'dual/feature/missing'],
  ['app/main.js', 'dual/hidden'],
  ['app/main.js', 'legacy'],
  ['app/main.js', 'legacy/lib/sub.js'],
  ['app/main.js', 'legacy/lib/sub'],
  ['app/main.js', 'legacy-index'],
  ['app/main.js', 'legacy-dirmain'],
  ['app/main.js', 'legacy-broken'],
  ['app/main.js', '@sc/pkg'],
  ['app/main.js', 'nope'],
  ['app/main.js', 'app'],
  ['app/main.js', 'app/x'],
  ['app/main.js', '#x'],
  ['app/main.js', '#c'],
  ['app/main.js', '#dep/esm.mjs'],
  ['app/main.js', '#nope'],
  ['app/main.js', 'fs'],
  ['app/main.js', 'node:path'],
  ['app/main.js', 'node:nope'],
  ['app/main.js', 'https://example.com/x.js'],
  ['app/lib/x.js', '../data.json'],
];

let root = '';
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Outcome = { ok: string } | { error: string };

const realFs: ResolverFs = {
  stat(p) {
    try {
      return statSync(p).isDirectory() ? 1 : 0;
    } catch {
      return -1;
    }
  },
  readFile(p) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  realpath: (p) => realpathSync(p),
};

describe('ESM resolution differential: EsmResolver vs node import()', () => {
  it('matches Node on every case', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-esm-')));
    for (const [file, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    // One probe module per "from" directory, so resolution starts from the right place.
    const probes = new Map<string, string>();
    for (const [from] of CASES) {
      const dir = dirname(join(root, from));
      if (probes.has(dir)) continue;
      const probe = join(dir, '__probe.mjs');
      writeFileSync(
        probe,
        `import { fileURLToPath } from 'node:url';
export async function probe(spec) {
  try {
    const url = import.meta.resolve(spec);
    try { await import(spec, spec.endsWith('.json') ? { with: { type: 'json' } } : undefined); }
    catch (e) { if (e.code !== 'ERR_IMPORT_ATTRIBUTE_MISSING') return { error: e.code }; }
    return { ok: url.startsWith('file:') ? fileURLToPath(url) : url };
  } catch (e) { return { error: e.code }; }
}`,
      );
      probes.set(dir, probe);
    }
    const script = `
      const cases = JSON.parse(process.argv[1]);
      const out = [];
      for (const [probe, spec] of cases) out.push(await (await import(probe)).probe(spec));
      process.stdout.write(JSON.stringify(out));`;
    const nodeCases = CASES.map(([from, spec]) => [probes.get(dirname(join(root, from))), spec]);
    const expected = JSON.parse(
      execFileSync(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', script, JSON.stringify(nodeCases)],
        { encoding: 'utf8' },
      ),
    ) as Outcome[];

    if (process.env['DUMP_TO'])
      writeFileSync(process.env['DUMP_TO'], JSON.stringify(expected).replaceAll(root, '<root>'));
    const resolver = new EsmResolver(realFs);
    const mismatches: string[] = [];
    CASES.forEach(([from, spec], i) => {
      let actual: Outcome;
      try {
        const r = resolver.resolve(spec, join(root, from));
        actual = {
          ok: r.kind === 'file' ? r.path : r.kind === 'builtin' ? `node:${r.name}` : r.url,
        };
      } catch (e) {
        actual = { error: (e as { code: string }).code };
      }
      let want = expected[i]!;
      // Node resolves the query string into the URL; ClientVM resolves the file.
      if ('ok' in want && want.ok.includes('?'))
        want = { ok: want.ok.slice(0, want.ok.indexOf('?')) };
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        const strip = (o: unknown) => JSON.stringify(o).replaceAll(root, '<root>');
        mismatches.push(`${from} → ${spec}\n  node: ${strip(want)}\n  ours: ${strip(actual)}`);
      }
    });
    expect(mismatches.join('\n')).toBe('');
  });
});
