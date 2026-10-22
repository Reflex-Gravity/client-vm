// SPDX-License-Identifier: Apache-2.0
// The shell inside a real instance: in-process commands piped to and from
// spawned node processes, scripts with shebangs, child_process with a shell,
// and Instance.exec. Deterministic scripts are diffed against real bash + Node.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const GEN = "for (let i = 1; i <= 5; i++) console.log(`item ${i}`);\nconsole.error('to stderr');\n";

const SCRIPT = String.raw`set -e
node gen.js | grep -v 3 | wc -l
node gen.js 2>/dev/null | sed 's/item/ITEM/' | sort -r | head -2
node gen.js 2>&1 >/dev/null | tr a-z A-Z
echo "from stdin" | node -e "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"
printf '#!/bin/sh\necho "script $1"\nexit 4\n' > s.sh
chmod +x s.sh
./s.sh a || echo "status $?"
sh s.sh b || echo "status $?"
node -e "console.log(require('child_process').execSync('echo via execSync && ls | sort | head -1').toString().trim())"
node -e "require('child_process').exec('echo \$((6*7)) | tr 4 X', (e, out) => process.stdout.write(out))"
FOO=bar node -p 'process.env.FOO'
x=$(node -p '1+1'); echo "x=$x"
yes | node -e "process.stdin.once('data', () => process.exit(0))"; echo "yes done"
for f in *.js; do echo "$f: $(wc -l < "$f")"; done
node -e 'process.exit(3)' || echo "node exited $?"
cat <<EOF | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).a))"
{"a": "heredoc json"}
EOF
`;

function expected(): { code: number; stdout: string; stderr: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-sh-')));
  try {
    writeFileSync(join(dir, 'gen.js'), GEN);
    const r = spawnSync('bash', ['-c', SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], HOME: dir, LC_ALL: 'C' },
    });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scripts mixing in-process commands and node match real bash', async ({ page }) => {
  const want = expected();
  await openHost(page);
  const id = await host(page, 'createInstance', {
    fs: { from: { home: { user: { proj: { 'gen.js': GEN } } } } },
  });
  const r = await host(page, 'exec', id, SCRIPT, { cwd: '/home/user/proj' });
  expect(r).toEqual(want);
  expect(r.code).toBe(0);
});

test('Instance.exec options, errors and timeouts', async ({ page }) => {
  await openHost(page);
  const id = await host(page, 'createInstance');

  const withOpts = await host(page, 'exec', id, 'pwd; echo "$GREETING"; cat | tr a-z A-Z', {
    cwd: '/tmp',
    env: { GREETING: 'hi' },
    stdin: 'piped\n',
  });
  expect(withOpts).toEqual({ code: 0, stdout: '/tmp\nhi\nPIPED\n', stderr: '' });

  const syntax = await host(page, 'exec', id, 'echo (');
  expect(syntax.code).toBe(2);
  expect(syntax.stderr).toContain("syntax error near unexpected token `newline'");

  const missing = await host(page, 'exec', id, 'definitely-not-a-command');
  expect(missing).toEqual({
    code: 127,
    stdout: '',
    stderr: 'sh: line 1: definitely-not-a-command: command not found\n',
  });

  // The timeout reaches the node process the shell started, not just the shell.
  const started = Date.now();
  const slow = await host(page, 'exec', id, "node -e 'setInterval(() => {}, 1000)'; echo never", {
    timeoutMs: 300,
  });
  expect(slow.signal).toBe('SIGTERM');
  expect(slow.code).toBe(143);
  expect(slow.stdout).toBe('');
  expect(Date.now() - started).toBeLessThan(5000);
  const after = await host(page, 'usage', id);
  expect(after.processes).toBe(0);
});

test('commands run as standalone processes and via child_process shell', async ({ page }) => {
  await openHost(page);
  const id = await host(page, 'createInstance');
  const r = await host(page, 'run', id, {
    argv: [
      'node',
      '-e',
      String.raw`
        const cp = require('child_process');
        require('fs').writeFileSync('/tmp/f.txt', 'b\na\nc\n');
        console.log(cp.spawnSync('sort', ['/tmp/f.txt'], { encoding: 'utf8' }).stdout.trim().split('\n').join(','));
        console.log(cp.execSync('ls /tmp | grep f.txt', { encoding: 'utf8' }).trim());
        console.log(cp.spawnSync('/bin/sh', ['-c', 'exit 5']).status);
        const child = cp.spawn('cat', [], { stdio: ['pipe', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', (code) => console.log('cat:', out.trim(), code));
        child.stdin.end('through cat');`,
    ],
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('a,b,c\nf.txt\n5\ncat: through cat 0\n');
});
