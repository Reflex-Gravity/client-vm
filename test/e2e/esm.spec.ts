// SPDX-License-Identifier: Apache-2.0
// Native ESM through the instance service worker: the same project on real Node and in ClientVM.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'proj',
    type: 'module',
    imports: { '#util': './lib/util.js' },
  }),
  'main.js': String.raw`
import { readFileSync } from 'node:fs';
import path, { join as pjoin } from 'path';
import * as events from 'events';
import def, { named, counter, bump } from './lib/esm.js';
import cjs, { fromCjs, viaDefine } from './lib/legacy.cjs';
import { useThing, version } from 'reactish';
import dual from 'dual';
import { helper } from '#util';
import data from './data.json' with { type: 'json' };
import { a } from './cycle/a.js';

const rel = (p) => path.relative(import.meta.dirname, p);
console.log('esm', def, named, typeof events.EventEmitter, typeof events.default.once);
console.log('live binding', counter, bump(), counter);
console.log('cjs interop', cjs.fromCjs, fromCjs, viaDefine, typeof cjs);
console.log('reexports', useThing(), version);
console.log('dual', dual);
console.log('imports field', helper());
console.log('json', data.answer);
console.log('cycle', a);
console.log('builtins', pjoin('a', 'b'), readFileSync(new URL('./data.json', import.meta.url), 'utf8').length > 0);
console.log('meta', import.meta.url.startsWith('file:///'), rel(import.meta.filename), import.meta.main, rel(new URL(import.meta.resolve('./lib/esm.js')).pathname));
const tla = await new Promise((r) => setTimeout(() => r('tla ok'), 5));
console.log(tla);
const dyn = await import('./lib/esm.js');
console.log('dynamic', dyn.named, dyn === await import('./lib/esm.js'));
const { requireDynamic } = await import('./lib/uses-import.cjs');
console.log('import() from cjs', (await requireDynamic()).named);
for (const spec of ['./missing.js', 'nope-pkg', './lib', 'node:nope']) {
  try { await import(spec); } catch (e) { console.log('error', spec, e.code); }
}
try { await import('./lib/bad-static.js'); } catch (e) { console.log('static error', e.code, e.message.split(import.meta.dirname).join('<proj>')); }
`,
  'data.json': '{ "answer": 42 }',
  'lib/esm.js':
    "export default 'esm-default'; export const named = 'esm-named'; export let counter = 0; export function bump() { counter++; return counter; }",
  'lib/util.js': "export const helper = () => 'helped';",
  'lib/legacy.cjs':
    "exports.fromCjs = 'from-cjs'; Object.defineProperty(exports, 'viaDefine', { enumerable: true, value: 'defined' });",
  'lib/uses-import.cjs': "exports.requireDynamic = () => import('./esm.js');",
  'lib/bad-static.js': "import { x } from './does-not-exist.js'; export default x;",
  'cycle/a.js': "import { b } from './b.js'; export const a = 'a+' + b;",
  'cycle/b.js': "export const b = 'b'; import './a.js';",
  // React's shape: CommonJS index that re-exports one of two builds.
  'node_modules/reactish/package.json': JSON.stringify({ name: 'reactish', main: 'index.js' }),
  'node_modules/reactish/index.js':
    "if (process.env.NODE_ENV === 'production') { module.exports = require('./prod.js'); } else { module.exports = require('./dev.js'); }",
  'node_modules/reactish/dev.js':
    "exports.useThing = () => 'dev-thing'; exports.version = '1.0.0';",
  'node_modules/reactish/prod.js':
    "exports.useThing = () => 'prod-thing'; exports.version = '1.0.0';",
  'node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: { import: './esm.mjs', require: './cjs.cjs' },
  }),
  'node_modules/dual/esm.mjs': "export default 'dual-esm';",
  'node_modules/dual/cjs.cjs': "module.exports = 'dual-cjs';",
};

function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

function writeTree(root: string, files: Record<string, string> = PROJECT): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

function asTree(files: Record<string, string>): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const [file, content] of Object.entries(files)) {
    const parts = file.split('/');
    let node = tree;
    for (const dir of parts.slice(0, -1)) node = (node[dir] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = content;
  }
  return tree;
}

test('ES modules match real Node', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-esm-')));
  let expected: string;
  try {
    writeTree(root);
    expected = execFileSync(process.execPath, ['main.js'], {
      cwd: root,
      encoding: 'utf8',
      env: plainEnv(),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await openHost(page);
  const id = await host(page, 'createInstance', {
    fs: { from: { home: { user: { proj: asTree(PROJECT) } } } },
  });
  const result = await host(page, 'run', id, {
    argv: ['node', 'main.js'],
    cwd: '/home/user/proj',
  } as never);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(expected);
});

/** require() of ES modules (Node 22.12+): a CommonJS project, run on real Node and in ClientVM. */
const REQUIRE_ESM: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'cjs-proj' }),
  'main.js': String.raw`
const lib = require('./lib.mjs');
console.log('named', lib.a, lib.b(), typeof lib.default, lib.default());
console.log('same instance', require('./lib.mjs') === lib);
console.log('nested import', lib.c);
console.log('module.exports export', require('./fn.mjs')('x'));
const only = require('esm-only');
console.log('esm-only package', only.hello(), Object.keys(only).sort().join());
console.log('module-sync condition', require('dual-sync').kind);
for (const f of ['./tla.mjs']) {
  try { require(f); } catch (e) { console.log('tla', e.code); }
}
`,
  'lib.mjs': String.raw`
import { c } from './dep.mjs';
export const a = 1;
export function b() { return 'b'; }
export default function () { return 'def'; }
export { c };
`,
  'dep.mjs': 'export const c = "from dep";\n',
  'fn.mjs': String.raw`
const fn = (s) => 'fn ' + s;
export { fn as 'module.exports' };
`,
  'tla.mjs': 'await Promise.resolve();\nexport const z = 1;\n',
  'node_modules/esm-only/package.json': JSON.stringify({
    name: 'esm-only',
    type: 'module',
    exports: './index.js',
  }),
  'node_modules/esm-only/index.js': 'export const hello = () => "hi";\nexport const x = 2;\n',
  'node_modules/dual-sync/package.json': JSON.stringify({
    name: 'dual-sync',
    exports: { 'module-sync': './esm.mjs', default: './cjs.cjs' },
  }),
  'node_modules/dual-sync/esm.mjs': 'export const kind = "esm";\n',
  'node_modules/dual-sync/cjs.cjs': 'exports.kind = "cjs";\n',
  'flag.js': String.raw`
try { require('./lib.mjs'); console.log('loaded'); } catch (e) { console.log(e.code); }
`,
};

test('require() of ES modules matches real Node', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-require-esm-')));
  const node = (args: string[]) =>
    execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: plainEnv() });
  let expected: string;
  let expectedFlag: string;
  try {
    writeTree(root, REQUIRE_ESM);
    expected = node(['main.js']);
    expectedFlag = node(['--no-experimental-require-module', 'flag.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await openHost(page);
  const id = await host(page, 'createInstance', {
    fs: { from: { home: { user: { proj: asTree(REQUIRE_ESM) } } } },
  });
  const run = (argv: string[]) =>
    host(page, 'run', id, { argv: ['node', ...argv], cwd: '/home/user/proj' } as never);
  const result = await run(['main.js']);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(expected);
  const flag = await run(['--no-experimental-require-module', 'flag.js']);
  expect(flag.stdout).toBe(expectedFlag);
  expect(flag.stdout).toBe('ERR_REQUIRE_ESM\n');
});
