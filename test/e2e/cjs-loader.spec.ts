// SPDX-License-Identifier: Apache-2.0
// The CommonJS loader on a realistic project: same tree on real Node and in ClientVM.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'proj',
    exports: { '.': './main.js', './feature': './lib/feature.js' },
    imports: { '#cfg': './config.json' },
  }),
  'config.json': '{ "port": 3000, "tags": ["a", "b"] }',
  'bad.json': '{ "unterminated": ',
  'main.js': String.raw`
const rel = (p) => require('path').relative(__dirname, p) || '.';
const out = (...a) => console.log(...a);

out('main', require.main === module, module.id, rel(__filename), typeof module.parent);
out('json', require('./config').port, require('#cfg').tags.length);
out('dir index', require('./lib').name);
out('scoped', require('@acme/widgets').widget());
out('exports', require('dual'), require('dual/package.json').name);
out('nested', require('consumer'));
out('self', require('proj/feature').feature);
out('cycle', JSON.stringify(require('./cycle/a')));
out('cache identity', require('./lib') === require('./lib/index.js'), rel(Object.keys(require.cache).sort()[0]));
out('node: prefix', require('node:fs') === require('fs'), require('module').isBuiltin('node:path'));
out('children', module.children.map((m) => rel(m.id)).slice(0, 3).join(','));
out('resolve', rel(require.resolve('dual')), rel(require.resolve('./lib')));

require.extensions['.txt'] = (m, filename) => { m.exports = require('fs').readFileSync(filename, 'utf8').trim().toUpperCase(); };
out('custom extension', require('./notes.txt'));

const { createRequire } = require('module');
const fromLib = createRequire(__dirname + '/lib/');
out('createRequire', fromLib('./feature').feature, rel(fromLib.resolve('dual')));

for (const req of ['./missing', 'nope-pkg', 'dual/secret', './bad.json', 'node:nope']) {
  try { require(req); } catch (e) { out('error', req, e.code ?? e.name, e.message.split(__dirname).join('<proj>').split('\n')[0]); }
}
try { require('./lib/requires-missing'); } catch (e) { out('stack', e.message.split(__dirname).join('<proj>').replace(/\n/g, ' | ')); }
out('exports alias', require('./exports-alias').both, require('./exports-alias').replaced);
out('this === exports', require('./this-check'));
out('module.exports fn', require('./fn-export')(2));
out('dirname', rel(require('./lib/where').dir));
`,
  'notes.txt': ' hello notes ',
  'lib/index.js': "exports.name = 'lib-index';",
  'lib/feature.js': 'exports.feature = "feature!";',
  'lib/where.js': 'exports.dir = __dirname;',
  'lib/requires-missing.js': "require('./really-missing');",
  'cycle/a.js': "exports.a1 = true; const b = require('./b'); exports.a2 = b.sawA;",
  'cycle/b.js': "const a = require('./a'); exports.sawA = JSON.stringify(a);",
  'exports-alias.js': "exports.both = 1; module.exports.replaced = 'yes';",
  'this-check.js': 'module.exports = this === exports;',
  'fn-export.js': 'module.exports = (x) => x * 21;',
  'node_modules/@acme/widgets/package.json': '{"name":"@acme/widgets","main":"dist/index"}',
  'node_modules/@acme/widgets/dist/index.js': "exports.widget = () => 'widget';",
  'node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: {
      '.': { import: './esm.mjs', require: './cjs.js' },
      './package.json': './package.json',
    },
  }),
  'node_modules/dual/cjs.js': "module.exports = 'dual-cjs';",
  'node_modules/dual/esm.mjs': "export default 'dual-esm';",
  'node_modules/dual/secret.js': '',
  'node_modules/consumer/index.js': "module.exports = require('dep') + '+' + require('shared');",
  'node_modules/consumer/node_modules/dep/index.js': "module.exports = 'dep@2';",
  'node_modules/dep/index.js': "module.exports = 'dep@1';",
  'node_modules/shared/index.js': "module.exports = 'shared';",
};

function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

function runOnRealNode(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-cjs-')));
  try {
    for (const [file, content] of Object.entries(PROJECT)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return execFileSync(process.execPath, ['main.js'], {
      cwd: root,
      encoding: 'utf8',
      env: plainEnv(),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('CommonJS loader matches real Node on a project with node_modules', async ({ page }) => {
  const expected = runOnRealNode();
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
