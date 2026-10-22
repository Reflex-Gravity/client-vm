// SPDX-License-Identifier: Apache-2.0
// Core modules inside a ClientVM process, diffed against the same script on real Node.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openSandbox, run } from './sandbox.ts';

const SCRIPT = String.raw`
const fs = require('fs');
const { EventEmitter, once } = require('events');
const util = require('node:util');
const assert = require('assert');
const qs = require('querystring');
const url = require('url');
const { StringDecoder } = require('string_decoder');

// Buffers everywhere: globals, fs, console.
const b = Buffer.from('héllo');
console.log(b, b.toString('base64'), b.toString('hex'), Buffer.isBuffer(b));
fs.writeFileSync('/tmp/b.bin', Buffer.from([1, 2, 3]));
const back = fs.readFileSync('/tmp/b.bin');
console.log(back, Buffer.isBuffer(back), back.readUInt16BE(1));
console.log(fs.readFileSync('/tmp/b.bin', 'hex'), fs.readFileSync('/tmp/b.bin', { encoding: 'base64' }));
fs.writeFileSync('/tmp/h.txt', '68690a', 'hex');
console.log(JSON.stringify(fs.readFileSync('/tmp/h.txt', 'utf8')));

// events + util
class Job extends EventEmitter {}
const job = new Job();
job.on('done', (x) => console.log('done', x));
job.emit('done', 42);
function Legacy() { EventEmitter.call(this); }
util.inherits(Legacy, EventEmitter);
console.log(new Legacy() instanceof EventEmitter, Legacy.super_ === EventEmitter);
console.log(util.format('%s=%d %j', 'n', 7, { a: [1] }), util.inspect({ deep: { er: { est: 1 } } }, { depth: 0 }));
console.log(util.types.isDate(new Date()), util.isDeepStrictEqual({ a: [1] }, { a: [1] }));
const sleep = util.promisify((ms, cb) => setTimeout(() => cb(null, 'slept ' + ms), ms));

// assert, qs, url, string_decoder
try { assert.deepStrictEqual({ a: 1 }, { a: 2 }); } catch (e) { console.log(e.code, e.name, e.operator); }
console.log(qs.stringify({ a: [1, 2], b: 'x y' }), JSON.stringify(qs.parse('a=1&a=2&c=%20')));
console.log(url.parse('http://u@h.com:81/p?q=1#f').port, url.fileURLToPath('file:///tmp/x%20y'));
const d = new StringDecoder('utf8');
const euro = Buffer.from('€');
console.log(JSON.stringify(d.write(euro.subarray(0, 1)) + d.write(euro.subarray(1))));

// vm: a new context's globalThis is the sandbox (how Next.js reads its manifests).
const vm = require('vm');
const sandbox = {};
vm.runInNewContext('globalThis.m = (globalThis.m || {}); globalThis.m.page = JSON.stringify([1])', sandbox);
console.log('vm', JSON.stringify(sandbox), typeof globalThis.m, vm.runInNewContext('a + 1', { a: 41 }));

// inspector: no debugger attached.
console.log('inspector', require('inspector').url(), typeof require('inspector').Session);

// process events and async
process.on('exit', (code) => console.log('exit event', code));
(async () => {
  console.log(await sleep(5));
  setTimeout(() => job.emit('later', 'ok'), 5);
  const [v] = await once(job, 'later');
  console.log('once', v);
})();
`;

/** Reference Node runs without a TTY or forced colors, like a ClientVM process. */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['FORCE_COLOR'];
  return env;
}

test('core modules match real Node', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'clientvm-core-'));
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
