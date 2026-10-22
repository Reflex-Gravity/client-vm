// SPDX-License-Identifier: Apache-2.0
// worker_threads, child_process.fork with IPC, the CPU watchdog (maxCpuMs),
// and host-side stdin for spawned processes.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

test.describe('threads, IPC and limits', () => {
  test.setTimeout(60_000);

  test('worker_threads: workerData, messages, SharedArrayBuffer, errors, terminate', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: {
        from: {
          app: {
            'main.js': String.raw`
              const { Worker, isMainThread, threadId } = require('worker_threads');
              const sab = new SharedArrayBuffer(4);
              const counter = new Int32Array(sab);
              const w = new Worker(__dirname + '/worker.js', { workerData: { start: 40, sab } });
              w.on('online', () => console.log('online'));
              w.on('message', (m) => {
                console.log('from worker', JSON.stringify(m), 'shared', Atomics.load(counter, 0));
                if (m.done) w.postMessage('bye');
              });
              w.on('exit', (code) => {
                console.log('worker exit', code, isMainThread, threadId);
                const bad = new Worker('throw new RangeError("nope")', { eval: true });
                bad.on('error', (e) => console.log('error event', e.name, e.message));
                bad.on('exit', (c) => {
                  console.log('bad exit', c);
                  const spin = new Worker('setInterval(() => {}, 1000)', { eval: true });
                  spin.on('online', () => spin.terminate().then((c) => console.log('terminated', c)));
                });
              });`,
            'worker.js': String.raw`
              const { parentPort, workerData, isMainThread, threadId } = require('worker_threads');
              const counter = new Int32Array(workerData.sab);
              Atomics.add(counter, 0, 7);
              parentPort.postMessage({ sum: workerData.start + 2, isMainThread, hasThreadId: threadId > 0, done: true });
              parentPort.on('message', (m) => { if (m === 'bye') parentPort.close(); });`,
          },
        },
      },
    });
    const r = await host(page, 'exec', id, 'node /app/main.js');
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      [
        'online',
        'from worker {"sum":42,"isMainThread":false,"hasThreadId":true,"done":true} shared 7',
        'worker exit 0 true 0',
        'error event RangeError nope',
        'bad exit 1',
        'terminated 1',
        '',
      ].join('\n'),
    );
  });

  test('child_process.fork: messages both ways, JSON serialization, disconnect, exit', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: {
        from: {
          app: {
            'parent.js': String.raw`
              const { fork } = require('child_process');
              const child = fork(__dirname + '/child.js', ['arg1']);
              child.on('message', (m) => {
                console.log('parent got', JSON.stringify(m));
                if (m.ready) child.send({ n: 21, when: new Date(0), skip: undefined });
                if (m.answer) child.disconnect();
              });
              child.on('disconnect', () => console.log('parent disconnect'));
              child.on('exit', (code) => console.log('child exit', code, child.connected));`,
            'child.js': String.raw`
              process.on('message', (m) => process.send({ answer: m.n * 2, when: m.when, keys: Object.keys(m) }));
              process.on('disconnect', () => console.log('child disconnect'));
              process.send({ ready: true, argv: process.argv.slice(2), connected: process.connected });`,
          },
        },
      },
    });
    const r = await host(page, 'exec', id, 'node /app/parent.js');
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual(
      [
        'parent got {"ready":true,"argv":["arg1"],"connected":true}',
        'parent got {"answer":42,"when":"1970-01-01T00:00:00.000Z","keys":["n","when"]}',
        'parent disconnect',
        'child disconnect',
        'child exit 0 false',
      ].sort(),
    );
  });

  test('maxCpuMs kills spinning processes but not blocked or yielding ones', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { limits: { maxCpuMs: 400 } });
    const spin = await host(page, 'run', id, { argv: ['node', '-e', 'while (true) {}'] });
    expect(spin).toMatchObject({ code: 152, signal: 'SIGXCPU' });
    expect(spin.stderr).toMatch(/without yielding \(maxCpuMs 400\); killed/);
    // Blocked in a syscall (execSync waits on a child) and yielding loops are fine.
    const ok = await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        String.raw`
          require('child_process').execSync('node -e "setTimeout(() => {}, 900)"');
          let n = 0;
          const t = setInterval(() => { const end = Date.now() + 100; while (Date.now() < end) {} if (++n === 8) { clearInterval(t); console.log('ok'); } }, 0);`,
      ],
    });
    expect(ok).toMatchObject({ code: 0, stdout: 'ok\n' });
  });

  test('host stdin reaches spawned processes', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const out = await host(
      page,
      'pipeThrough',
      id,
      'node',
      ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"],
      ['hello ', 'world'],
    );
    expect(out).toEqual({ stdout: 'HELLO WORLD', code: 0 });
  });
});
