// SPDX-License-Identifier: Apache-2.0
// Async fs and streams inside a ClientVM process, diffed against real Node.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openSandbox, run } from './sandbox.ts';

const SCRIPT = String.raw`
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline, Readable, Transform } = require('stream');
const { text } = require('stream/consumers');
const log = (...a) => console.log(...a);

fs.mkdirSync('w/sub/deep', { recursive: true });
process.chdir('w');

// The callback section runs to completion before the promise section: how two
// independent async chains interleave depends on libuv thread-pool timing in Node.
const callbacks = () => new Promise((done) => {
  fs.writeFile('cb.txt', 'callback data', (err) => {
    log('writeFile cb', err);
    fs.readFile('cb.txt', 'utf8', (err, data) => {
      log('readFile cb', err, data);
      fs.stat('cb.txt', (err, st) => {
        log('stat cb', st.size, st.isFile());
        fs.readFile('missing', (err) => {
          log('missing cb', err.code, err.syscall);
          let sync = true;
          fs.access('cb.txt', () => { log('callbacks are async', !sync); done(); });
          sync = false;
        });
      });
    });
  });
});

(async () => {
  await callbacks();
  await fsp.writeFile('p.txt', 'promise data');
  log('readFile promise', await fsp.readFile('p.txt', 'utf8'));
  await fsp.appendFile('p.txt', '+more');
  log('append', await fsp.readFile('p.txt', { encoding: 'utf8' }));
  log('readdir withFileTypes', (await fsp.readdir('.', { withFileTypes: true })).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort());
  fs.writeFileSync('sub/deep/f.txt', 'x');
  log('readdir recursive', (await fsp.readdir('.', { recursive: true })).sort());
  try { await fsp.readFile('nope'); } catch (e) { log('promise rejects', e.code); }

  const fh = await fsp.open('fh.bin', 'w+');
  await fh.write('hello world');
  const { bytesRead, buffer } = await fh.read(Buffer.alloc(5), 0, 5, 6);
  log('FileHandle', bytesRead, buffer.toString(), (await fh.stat()).size);
  await fh.close();

  const dir = await fsp.opendir('sub');
  for await (const ent of dir) log('opendir', ent.name, ent.isDirectory());

  fs.cpSync('sub', 'copy', { recursive: true });
  log('cp', fs.readFileSync('copy/deep/f.txt', 'utf8'));
  const tmp = fs.mkdtempSync('tmp-');
  log('mkdtemp', tmp.startsWith('tmp-'), tmp.length, fs.statSync(tmp).isDirectory());

  // Streams.
  const big = 'line\n'.repeat(50000);
  fs.writeFileSync('big.txt', big);
  let chunks = 0, total = 0;
  for await (const chunk of fs.createReadStream('big.txt')) { chunks++; total += chunk.length; }
  log('read stream', chunks, total);
  log('ranged', await text(fs.createReadStream('big.txt', { start: 5, end: 13, encoding: 'utf8' })));

  await new Promise((resolve, reject) => pipeline(
    fs.createReadStream('big.txt'),
    new Transform({ transform(c, _e, cb) { cb(null, c.toString().toUpperCase()); } }),
    fs.createWriteStream('upper.txt'),
    (err) => (err ? reject(err) : resolve()),
  ));
  log('pipeline', fs.statSync('upper.txt').size, fs.readFileSync('upper.txt', 'utf8').slice(0, 5));

  const ws = fs.createWriteStream('ws.txt');
  ws.on('open', (fd) => log('ws open', typeof fd));
  ws.write('a');
  ws.end('b', () => log('ws finished', fs.readFileSync('ws.txt', 'utf8'), ws.bytesWritten));
  await new Promise((r) => ws.on('close', r));
  log('ws closed');

  const rs = fs.createReadStream('does-not-exist');
  rs.on('error', (e) => log('stream error', e.code));
  await new Promise((r) => rs.on('close', r));
  log('consumers', await text(Readable.from(['x', 'y', 'z'])));
})();
`;

function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

test('async fs and streams match real Node', async ({ page }) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clientvm-afs-')));
  let expected: string;
  try {
    expected = execFileSync(process.execPath, ['-e', SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: plainEnv(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await openSandbox(page);
  const result = await run(page, ['node', '-e', SCRIPT]);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(expected);
});
