// SPDX-License-Identifier: Apache-2.0
// End-to-end fs differential: the same script runs under real Node (in a temp
// dir) and inside a ClientVM process in Chromium; stdout must be identical.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openSandbox, run } from './sandbox.ts';

const SCRIPT = String.raw`
const fs = require('fs');
const log = (label, fn) => {
  try { console.log(label, JSON.stringify(fn())); }
  catch (e) { console.log(label, 'throws', e.code, e.syscall); }
};
fs.mkdirSync('work/src', { recursive: true });
process.chdir('work');
fs.writeFileSync('src/a.txt', 'alpha');
log('append', () => { fs.appendFileSync('src/a.txt', '+beta'); return fs.readFileSync('src/a.txt', 'utf8'); });

const fd = fs.openSync('src/data.bin', 'w+');
log('write string', () => fs.writeSync(fd, 'hello world'));
log('pwrite', () => fs.writeSync(fd, 'J', 6));
const buf = new Uint8Array(5);
log('pread', () => [fs.readSync(fd, buf, 0, 5, 6), new TextDecoder().decode(buf)]);
log('fstat size', () => fs.fstatSync(fd).size);
log('ftruncate', () => { fs.ftruncateSync(fd, 5); return fs.fstatSync(fd).size; });
fs.closeSync(fd);
log('closed fd', () => fs.fstatSync(fd));
log('read data', () => fs.readFileSync('src/data.bin', 'utf8'));
log('excl open', () => fs.openSync('src/data.bin', 'wx'));

fs.symlinkSync('src', 'link');
log('readlink', () => fs.readlinkSync('link'));
log('through link', () => fs.readFileSync('link/a.txt', 'utf8'));
log('lstat is link', () => fs.lstatSync('link').isSymbolicLink());
log('realpath', () => fs.realpathSync('link/a.txt').endsWith('/work/src/a.txt'));

fs.renameSync('src/a.txt', 'src/b.txt');
log('renamed', () => fs.readdirSync('src').sort());
log('rename missing', () => fs.renameSync('src/nope', 'src/x'));
fs.linkSync('src/b.txt', 'hard.txt');
log('nlink', () => fs.statSync('src/b.txt').nlink);
fs.copyFileSync('hard.txt', 'copy.txt');
log('copy excl', () => fs.copyFileSync('hard.txt', 'copy.txt', fs.constants.COPYFILE_EXCL));
fs.truncateSync('copy.txt', 3);
log('truncated', () => fs.readFileSync('copy.txt', 'utf8'));
fs.chmodSync('copy.txt', 0o600);
log('mode', () => (fs.statSync('copy.txt').mode & 0o777).toString(8));
fs.utimesSync('copy.txt', 1000, 2000);
log('mtime', () => fs.statSync('copy.txt').mtimeMs);
log('access missing', () => fs.accessSync('missing'));

log('rmdir non-empty', () => fs.rmdirSync('src'));
log('unlink', () => { fs.unlinkSync('hard.txt'); return fs.existsSync('hard.txt'); });
log('rm dir without recursive', () => fs.rmSync('src'));
fs.rmSync('src', { recursive: true });
fs.rmSync('missing', { force: true });
log('final', () => fs.readdirSync('.').sort());
`;

function runOnRealNode(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clientvm-e2e-fs-'));
  try {
    return execFileSync(process.execPath, ['-e', SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: plainEnv(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reference Node runs without a TTY or forced colors, like a ClientVM process. */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

test('fs syscalls inside a ClientVM process match real Node', async ({ page }) => {
  const expected = runOnRealNode();
  await openSandbox(page);
  const result = await run(page, ['node', '-e', SCRIPT]);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(expected);
  expect(result.code).toBe(0);
});
