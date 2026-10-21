// SPDX-License-Identifier: Apache-2.0
// child_process, stdin and fs.watch inside ClientVM, diffed against real Node where
// output is deterministic.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const FILES: Record<string, { content: string; mode?: number }> = {
  'echo-args.js': {
    content:
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)), process.env.EXTRA ?? '-', process.cwd().endsWith('/sub'));",
    mode: 0o755,
  },
  'upper.js': {
    content:
      "#!/usr/bin/env node\nlet s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => s += d); process.stdin.on('end', () => process.stdout.write(s.toUpperCase()));",
    mode: 0o755,
  },
  'fail.js': {
    content: "#!/usr/bin/env node\nconsole.error('oops'); process.exit(3);",
    mode: 0o755,
  },
  'slow.js': { content: '#!/usr/bin/env node\nsetInterval(() => {}, 1000);', mode: 0o755 },
  'not-exec.js': { content: '#!/usr/bin/env node\n', mode: 0o644 },
  'node_modules/tool/cli.js': {
    content: "#!/usr/bin/env node\nconsole.log('tool via .bin', process.argv.length);",
    mode: 0o755,
  },
  'sub/.keep': { content: '' },
};

const MAIN = String.raw`
const cp = require('child_process');
const { promisify } = require('util');
const out = (...a) => console.log(...a);
const env = { ...process.env, PATH: process.cwd() + '/node_modules/.bin:' + process.env.PATH };

(async () => {
  out('execFileSync', cp.execFileSync('../echo-args.js', ['a', 'b c'], { encoding: 'utf8', cwd: 'sub', env: { ...env, EXTRA: 'x' } }).trim());
  out('spawnSync input', cp.spawnSync('./upper.js', { input: 'piped in', encoding: 'utf8' }).stdout);
  const failed = cp.spawnSync('./fail.js', { encoding: 'utf8' });
  out('spawnSync status', failed.status, failed.signal, JSON.stringify(failed.stderr));
  try { cp.execFileSync('./fail.js', { stdio: 'pipe' }); } catch (e) { out('execFileSync throws', e.status, String(e.stderr).trim()); }
  out('missing sync', cp.spawnSync('nope-cmd').error.code);
  out('not executable', cp.spawnSync('./not-exec.js').error.code);
  out('bin lookup', cp.execFileSync('tool', { encoding: 'utf8', env }).trim());

  const child = cp.spawn('./upper.js', { stdio: ['pipe', 'pipe', 'inherit'] });
  let got = '';
  child.stdout.on('data', (d) => (got += d));
  child.stdin.write('hello ');
  child.stdin.end('world');
  const [code] = await require('events').once(child, 'close');
  out('spawn pipes', got, code, typeof child.pid);

  const errChild = cp.spawn('nope-cmd');
  out('spawn error', (await require('events').once(errChild, 'error'))[0].code);

  const slow = cp.spawn('./slow.js');
  setTimeout(() => slow.kill(), 50);
  const [c2, sig] = await require('events').once(slow, 'exit');
  out('kill', c2, sig, slow.killed);

  const execFile = promisify(cp.execFile);
  out('promisified', (await execFile('./echo-args.js', ['p'])).stdout.trim());
  try { await execFile('./fail.js'); } catch (e) { out('promisified rejects', e.code, e.stderr.trim()); }

  // 'close' must fire even when nobody reads the child's piped output.
  const unread = cp.spawn('./echo-args.js', ['unread']);
  out('unread close', (await require('events').once(unread, 'close'))[0]);

  const inherited = cp.spawn('./echo-args.js', ['inherited'], { stdio: 'inherit' });
  await require('events').once(inherited, 'close');
})();
`;

function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

function asTree(): Record<string, unknown> {
  const tree: Record<string, unknown> = { 'main.js': MAIN };
  for (const [file, { content }] of Object.entries(FILES)) {
    const parts = file.split('/');
    let node = tree;
    for (const dir of parts.slice(0, -1)) node = (node[dir] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = content;
  }
  return tree;
}

test('child_process matches real Node', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-cp-')));
  let expected: string;
  try {
    for (const [file, { content, mode }] of Object.entries(FILES)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), content);
      if (mode) chmodSync(join(root, file), mode);
    }
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync('../tool/cli.js', join(root, 'node_modules/.bin/tool'));
    writeFileSync(join(root, 'main.js'), MAIN);
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
    fs: { from: { home: { user: { proj: asTree() } } } },
  });
  // File trees carry no modes or symlinks; set them up inside the instance.
  const setup = String.raw`
    const fs = require('fs');
    for (const f of ${JSON.stringify(
      Object.entries(FILES)
        .filter(([, v]) => v.mode)
        .map(([k, v]) => [k, v.mode]),
    )}) fs.chmodSync(f[0], f[1]);
    fs.mkdirSync('node_modules/.bin', { recursive: true });
    fs.symlinkSync('../tool/cli.js', 'node_modules/.bin/tool');`;
  expect(
    (await host(page, 'run', id, { argv: ['node', '-e', setup], cwd: '/home/user/proj' } as never))
      .stderr,
  ).toBe('');
  const result = await host(page, 'run', id, {
    argv: ['node', 'main.js'],
    cwd: '/home/user/proj',
  } as never);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(expected);
});

test('stdin, process.stdout as a stream, and fs.watch', async ({ page }) => {
  await openHost(page);
  const id = await host(page, 'createInstance');
  const cat = await host(page, 'run', id, {
    argv: [
      'node',
      '-e',
      "process.stdin.pipe(require('stream').Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } })).pipe(process.stdout)",
    ],
    stdin: 'streamed through stdin\n',
  } as never);
  expect(cat.stdout).toBe('STREAMED THROUGH STDIN\n');

  // No stdin reader: the process exits without waiting for input (stdin is closed).
  const quick = await host(page, 'run', id, {
    argv: ['node', '-e', 'process.stdin; console.log("done")'],
  });
  expect(quick.stdout).toBe('done\n');

  const watch = await host(page, 'run', id, {
    argv: [
      'node',
      '-e',
      String.raw`
        const fs = require('fs');
        fs.mkdirSync('/tmp/w');
        const seen = [];
        const w = fs.watch('/tmp/w', (event, name) => seen.push(event + ':' + name));
        fs.writeFileSync('/tmp/w/a.txt', '1');
        setTimeout(() => {
          fs.appendFileSync('/tmp/w/a.txt', '2');
          fs.renameSync('/tmp/w/a.txt', '/tmp/w/b.txt');
          setTimeout(() => { w.close(); console.log(seen.join(' ')); }, 20);
        }, 20);`,
    ],
  });
  expect(watch.stdout).toBe('rename:a.txt change:a.txt rename:a.txt rename:b.txt\n');
});
