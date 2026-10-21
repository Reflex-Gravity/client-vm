// SPDX-License-Identifier: Apache-2.0
// Instances on per-instance origins: isolation, lifecycle, limits, forks.
import { expect, test } from '@playwright/test';
import { host, hostIsolated, openHost } from './sandbox.ts';

/** Node script that reports what this process sees in shared per-origin storage. */
const PROBE_LISTENER = String.raw`
// Pending promises don't keep a ClientVM process alive yet; hold a timer until done.
const keepAlive = setInterval(() => {}, 50);
const ch = new BroadcastChannel('clientvm-isolation-test');
let got = 0;
ch.onmessage = () => { got++; };
setTimeout(async () => {
  const root = await navigator.storage.getDirectory();
  let opfs = false;
  try { await root.getFileHandle('marker'); opfs = true; } catch {}
  console.log(JSON.stringify({ broadcast: got, opfs }));
  ch.close();
  clearInterval(keepAlive);
}, 600);
`;

const PROBE_SENDER = String.raw`
(async () => {
  const root = await navigator.storage.getDirectory();
  await root.getFileHandle('marker', { create: true });
  const ch = new BroadcastChannel('clientvm-isolation-test');
  for (let i = 0; i < 5; i++) { ch.postMessage('hi'); await new Promise((r) => setTimeout(r, 50)); }
  ch.close();
})();
setTimeout(() => {}, 400);
`;

test.describe('instances', () => {
  test('instances are cross-origin isolated while the host page is not', async ({ page }) => {
    await openHost(page);
    expect(await hostIsolated(page)).toBe(false);
    const id = await host(page, 'createInstance');
    const result = await host(page, 'run', id, { argv: ['node', '-p', 'crossOriginIsolated'] });
    expect(result.stdout).toBe('true\n');
    const origin = await page.evaluate(
      (id) => document.querySelector<HTMLIFrameElement>(`iframe[src*="${id}."]`)?.src,
      id,
    );
    expect(origin).toMatch(new RegExp(`^http://${id}\\.localhost:\\d+/__clientvm/instance\\.html`));
  });

  test('also works under a COOP/COEP host page (fallback mode)', async ({ page }) => {
    await openHost(page, { coi: true });
    expect(await hostIsolated(page)).toBe(true);
    const id = await host(page, 'createInstance');
    const result = await host(page, 'run', id, { argv: ['node', '-p', '1 + 1'] });
    expect(result.stdout).toBe('2\n');
  });

  test('filesystems are isolated between instances', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance');
    const b = await host(page, 'createInstance');
    await host(page, 'writeFile', a, '/home/user/secret.txt', 'only in A');
    expect(await host(page, 'readFile', a, '/home/user/secret.txt')).toBe('only in A');
    await expect(host(page, 'readFile', b, '/home/user/secret.txt')).rejects.toThrow(/ENOENT/);
  });

  test('processes cannot reach another instance via BroadcastChannel or OPFS', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance');
    const b = await host(page, 'createInstance');
    // Control: two processes in the same instance (same origin) DO share both.
    const [sameListener] = await Promise.all([
      host(page, 'run', a, { argv: ['node', '-e', PROBE_LISTENER] }),
      new Promise((r) => setTimeout(r, 100)).then(() =>
        host(page, 'run', a, { argv: ['node', '-e', PROBE_SENDER] }),
      ),
    ]);
    expect(JSON.parse(sameListener.stdout)).toEqual({ broadcast: 5, opfs: true });

    // Across instances: nothing leaks.
    const [otherListener] = await Promise.all([
      host(page, 'run', b, { argv: ['node', '-e', PROBE_LISTENER] }),
      new Promise((r) => setTimeout(r, 100)).then(() =>
        host(page, 'run', a, { argv: ['node', '-e', PROBE_SENDER] }),
      ),
    ]);
    expect(JSON.parse(otherListener.stdout)).toEqual({ broadcast: 0, opfs: false });
  });

  test('spawn streams output as it is produced, and kill reports the signal', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const ticker =
      "let i = 0; const t = setInterval(() => { console.log('tick', ++i); if (i === 3) clearInterval(t); }, 60);";
    const streamed = await host(page, 'spawnAndCollect', id, 'node', ['-e', ticker]);
    expect(streamed.stdout.join('')).toBe('tick 1\ntick 2\ntick 3\n');
    expect(streamed.stdout.length).toBeGreaterThanOrEqual(3); // arrived as separate chunks
    expect(streamed.code).toBe(0);

    const killed = await host(
      page,
      'spawnAndCollect',
      id,
      'node',
      ['-e', 'setInterval(() => {}, 1000)'],
      200,
    );
    expect(killed).toMatchObject({ code: 137, signal: 'SIGKILL' });
  });

  test('maxProcesses limits concurrent processes', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { limits: { maxProcesses: 1 } });
    const first = host(page, 'run', id, { argv: ['node', '-e', 'setTimeout(() => {}, 300)'] });
    await new Promise((r) => setTimeout(r, 50));
    await expect(host(page, 'run', id, { argv: ['node', '-e', '0'] })).rejects.toThrow(/EAGAIN/);
    expect((await first).code).toBe(0);
    expect((await host(page, 'run', id, { argv: ['node', '-e', '0'] })).code).toBe(0);
  });

  test('quotaBytes fails writes with ENOSPC inside processes', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { quotaBytes: 64 * 1024 } });
    const result = await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        "try { require('fs').writeFileSync('/big', new Uint8Array(100000)) } catch (e) { console.log(e.code) }",
      ],
    });
    expect(result.stdout).toBe('ENOSPC\n');
  });

  test('fork copies the filesystem into a new origin and both diverge independently', async ({
    page,
  }) => {
    await openHost(page);
    const a = await host(page, 'createInstance', {
      fs: { from: { app: { 'index.js': "console.log('v1')" } } },
      capabilities: [{ kind: 'spawn-instance' }],
    });
    expect((await host(page, 'run', a, { argv: ['node', '/app/index.js'] })).stdout).toBe('v1\n');
    const b = await host(page, 'fork', a);
    expect(b).not.toBe(a);
    expect((await host(page, 'run', b, { argv: ['node', '/app/index.js'] })).stdout).toBe('v1\n');
    await host(page, 'writeFile', b, '/app/index.js', "console.log('v2')");
    expect((await host(page, 'run', a, { argv: ['node', '/app/index.js'] })).stdout).toBe('v1\n');
    expect((await host(page, 'run', b, { argv: ['node', '/app/index.js'] })).stdout).toBe('v2\n');
  });

  test('createInstance from a snapshot id restores that point in time', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance');
    await host(page, 'writeFile', a, '/tmp/state', 'before');
    const snap = await host(page, 'snapshot', a);
    await host(page, 'writeFile', a, '/tmp/state', 'after');
    const restored = await host(page, 'createInstance', { fs: { from: snap } });
    expect(await host(page, 'readFile', restored, '/tmp/state')).toBe('before');
  });

  test('destroy removes the instance and its iframe', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    expect(await host(page, 'list')).toContain(id);
    await host(page, 'destroy', id);
    expect(await host(page, 'list')).not.toContain(id);
    expect(await page.locator(`iframe[src*="${id}."]`).count()).toBe(0);
  });
});
