// SPDX-License-Identifier: Apache-2.0
// CommonJS resolution: our CjsResolver vs real Node's require.resolve, on the
// same fixture tree on disk. Results (paths) and error codes/messages must match.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CjsResolver, PackageJsonCache } from '@clientvm/node-compat';
import type { ResolverFs } from '@clientvm/node-compat';
import { afterAll, describe, expect, it } from 'vitest';

const FILES: Record<string, string> = {
  'app/main.js': '',
  'app/lib/util.js': '',
  'app/lib/data.json': '{}',
  'app/lib/noext': '',
  'app/lib/both.js': '',
  'app/lib/both.json': '{}',
  'app/lib/dir/index.js': '',
  'app/lib/dironlyjson/index.json': '{}',
  'app/lib/dirmain/package.json': '{"main": "entry"}',
  'app/lib/dirmain/entry.js': '',
  'app/lib/dirmaindir/package.json': '{"main": "./sub"}',
  'app/lib/dirmaindir/sub/index.js': '',
  'app/lib/badmain/package.json': '{"main": "missing.js"}',
  'app/lib/badmain/index.js': '',
  'app/lib/reallybadmain/package.json': '{"main": "missing.js"}',
  'app/lib/emptymain/package.json': '{"main": ""}',
  'app/lib/emptymain/index.js': '',
  'app/package.json': JSON.stringify({
    name: 'app',
    exports: { '.': './main.js', './util': './lib/util.js' },
    imports: {
      '#util': './lib/util.js',
      '#cond': { node: './lib/both.js', default: './lib/data.json' },
      '#star/*': './lib/*.js',
      '#dep': 'plain',
      '#missing': './lib/nope.js',
    },
  }),
  // node_modules: plain packages
  'app/node_modules/plain/index.js': '',
  'app/node_modules/plain/other.js': '',
  'app/node_modules/plain/package.json': '{"name":"plain"}',
  'app/node_modules/withmain/package.json': '{"main":"lib/start.js"}',
  'app/node_modules/withmain/lib/start.js': '',
  'app/node_modules/@scope/pkg/index.js': '',
  'app/node_modules/@scope/pkg/deep/file.js': '',
  // exports variants
  'app/node_modules/exp-string/package.json': '{"exports":"./dist/main.js"}',
  'app/node_modules/exp-string/dist/main.js': '',
  'app/node_modules/exp-string/hidden.js': '',
  'app/node_modules/exp-cond/package.json': JSON.stringify({
    exports: {
      '.': { import: './esm.mjs', require: './cjs.js', default: './default.js' },
      './feature': {
        browser: './browser.js',
        node: { require: './node-req.js', default: './node.js' },
      },
      './array': ['./nope-invalid', './array-ok.js'],
      './null': null,
      './sub/*': './src/*.js',
      './sub/private/*': null,
      './assets/*': './assets/*',
      './pkg': './package.json',
      './bad-target': 'no-dot-slash.js',
      './escape': './../outside.js',
      './nm/*': './node_modules/*',
    },
  }),
  'app/node_modules/exp-cond/cjs.js': '',
  'app/node_modules/exp-cond/esm.mjs': '',
  'app/node_modules/exp-cond/default.js': '',
  'app/node_modules/exp-cond/node-req.js': '',
  'app/node_modules/exp-cond/node.js': '',
  'app/node_modules/exp-cond/array-ok.js': '',
  'app/node_modules/exp-cond/src/a.js': '',
  'app/node_modules/exp-cond/src/nested/b.js': '',
  'app/node_modules/exp-cond/src/private/c.js': '',
  'app/node_modules/exp-cond/assets/logo.svg': '',
  'app/node_modules/exp-sugar/package.json': JSON.stringify({
    exports: { require: './r.js', default: './d.js' },
  }),
  'app/node_modules/exp-sugar/r.js': '',
  'app/node_modules/exp-sugar/d.js': '',
  'app/node_modules/exp-nomain/package.json': JSON.stringify({
    exports: { './only': './only.js' },
  }),
  'app/node_modules/exp-nomain/only.js': '',
  'app/node_modules/exp-nomain/index.js': '',
  'app/node_modules/exp-missing-file/package.json': JSON.stringify({ exports: './gone.js' }),
  'app/node_modules/exp-mixed/package.json': JSON.stringify({
    exports: { '.': './a.js', require: './b.js' },
  }),
  'app/node_modules/exp-mixed/a.js': '',
  'app/node_modules/exp-esmonly/package.json': JSON.stringify({ exports: { import: './x.mjs' } }),
  'app/node_modules/broken-json/package.json': '{ not json',
  'app/node_modules/broken-json/index.js': '',
  // nested lookup: a dependency requiring its own dependency, and hoisted fallback
  'app/node_modules/outer/index.js': '',
  'app/node_modules/outer/node_modules/inner/index.js': '',
  'app/node_modules/hoisted/index.js': '',
  // self-reference
  'app/node_modules/selfref/package.json': JSON.stringify({
    name: 'selfref',
    exports: { '.': './i.js', './x': './x.js' },
  }),
  'app/node_modules/selfref/i.js': '',
  'app/node_modules/selfref/x.js': '',
  // real package behind a symlink (pnpm layout)
  'store/real-pkg/index.js': '',
  'store/real-pkg/package.json': '{"name":"real-pkg"}',
  // a file outside any package
  'loose/script.js': '',
};

const SYMLINKS: [target: string, link: string][] = [
  ['../../store/real-pkg', 'app/node_modules/linked'],
];

/** [from file (relative to root), request] */
const CASES: [string, string][] = [
  ['app/main.js', './lib/util'],
  ['app/main.js', './lib/util.js'],
  ['app/main.js', './lib/data'],
  ['app/main.js', './lib/noext'],
  ['app/main.js', './lib/both'],
  ['app/main.js', './lib/dir'],
  ['app/main.js', './lib/dir/'],
  ['app/main.js', './lib/dironlyjson'],
  ['app/main.js', './lib/dirmain'],
  ['app/main.js', './lib/dirmaindir'],
  ['app/main.js', './lib/badmain'],
  ['app/main.js', './lib/reallybadmain'],
  ['app/main.js', './lib/emptymain'],
  ['app/main.js', './lib/util/'],
  ['app/main.js', './missing'],
  ['app/main.js', '.'],
  ['app/lib/util.js', '..'],
  ['app/lib/util.js', '../main'],
  ['app/main.js', 'plain'],
  ['app/main.js', 'plain/other'],
  ['app/main.js', 'plain/other.js'],
  ['app/main.js', 'plain/package.json'],
  ['app/main.js', 'withmain'],
  ['app/main.js', '@scope/pkg'],
  ['app/main.js', '@scope/pkg/deep/file'],
  ['app/main.js', '@scope'],
  ['app/main.js', 'exp-string'],
  ['app/main.js', 'exp-string/hidden.js'],
  ['app/main.js', 'exp-cond'],
  ['app/main.js', 'exp-cond/feature'],
  ['app/main.js', 'exp-cond/array'],
  ['app/main.js', 'exp-cond/null'],
  ['app/main.js', 'exp-cond/sub/a'],
  ['app/main.js', 'exp-cond/sub/nested/b'],
  ['app/main.js', 'exp-cond/sub/private/c'],
  ['app/main.js', 'exp-cond/sub/missing'],
  ['app/main.js', 'exp-cond/assets/logo.svg'],
  ['app/main.js', 'exp-cond/pkg'],
  ['app/main.js', 'exp-cond/bad-target'],
  ['app/main.js', 'exp-cond/escape'],
  ['app/main.js', 'exp-cond/sub/../../x'],
  ['app/main.js', 'exp-cond/nm/x'],
  ['app/main.js', 'exp-cond/cjs.js'],
  ['app/main.js', 'exp-sugar'],
  ['app/main.js', 'exp-nomain'],
  ['app/main.js', 'exp-nomain/only'],
  ['app/main.js', 'exp-missing-file'],
  ['app/main.js', 'exp-mixed'],
  ['app/main.js', 'exp-esmonly'],
  ['app/main.js', 'broken-json'],
  ['app/node_modules/outer/index.js', 'inner'],
  ['app/node_modules/outer/index.js', 'hoisted'],
  ['app/main.js', 'inner'],
  ['app/node_modules/selfref/i.js', 'selfref'],
  ['app/node_modules/selfref/i.js', 'selfref/x'],
  ['app/node_modules/selfref/i.js', 'selfref/nope'],
  ['app/main.js', 'app'],
  ['app/main.js', 'app/util'],
  ['app/main.js', '#util'],
  ['app/main.js', '#cond'],
  ['app/main.js', '#star/util'],
  ['app/main.js', '#dep'],
  ['app/main.js', '#missing'],
  ['app/main.js', '#undefined'],
  ['loose/script.js', '#util'],
  ['app/main.js', 'linked'],
  ['app/main.js', 'nonexistent-pkg'],
  ['app/main.js', 'nonexistent-pkg/sub'],
];

let root = '';

function setup(): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-resolve-')));
  for (const [file, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  for (const [target, link] of SYMLINKS) symlinkSync(target, join(root, link));
}

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Outcome = { ok: string } | { error: string; message: string };

function nodeOutcomes(): Outcome[] {
  const script = `
    const { createRequire } = require('module');
    const cases = JSON.parse(process.argv[1]);
    const out = cases.map(([from, request]) => {
      try { return { ok: createRequire(from).resolve(request) }; }
      catch (e) { return { error: e.code, message: e.message }; }
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const cases = CASES.map(([from, request]) => [join(root, from), request]);
  return JSON.parse(
    execFileSync(process.execPath, ['--no-warnings', '-e', script, JSON.stringify(cases)], {
      encoding: 'utf8',
    }),
  ) as Outcome[];
}

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

describe('CommonJS resolution differential: CjsResolver vs node require.resolve', () => {
  it('matches Node on every case', () => {
    setup();
    const expected = nodeOutcomes();
    const resolver = new CjsResolver(realFs, new PackageJsonCache(realFs), {
      extensions: ['.js', '.json', '.node'],
      globalPaths: [],
      isBuiltin: () => false,
    });
    const mismatches: string[] = [];
    CASES.forEach(([from, request], i) => {
      const file = join(root, from);
      let actual: Outcome;
      try {
        actual = { ok: resolver.resolve(request, file, dirname(file), [file]) };
      } catch (e) {
        actual = { error: (e as { code: string }).code, message: (e as Error).message };
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected[i])) {
        const strip = (o: unknown) => JSON.stringify(o).replaceAll(root, '<root>');
        mismatches.push(
          `${from} → ${request}\n  node: ${strip(expected[i])}\n  ours: ${strip(actual)}`,
        );
      }
    });
    expect(mismatches.join('\n')).toBe('');
  });
});
