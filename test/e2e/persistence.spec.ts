// SPDX-License-Identifier: Apache-2.0
// OPFS persistence: write → flush → reload page → reattach by id → read back.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const persistent = (id: string, extra: object = {}) => ({ id, fs: { persist: true }, ...extra });

test.describe('persistence', () => {
  test('state survives a page reload when the instance is reattached by id', async ({ page }) => {
    await openHost(page);
    const id = await host(
      page,
      'createInstance',
      persistent('persist1', { fs: { persist: true, from: { 'seed.txt': 'seeded' } } }),
    );
    await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        "const fs = require('fs'); fs.mkdirSync('/home/user/app'); fs.writeFileSync('/home/user/app/data.json', JSON.stringify({ n: 42 })); fs.symlinkSync('app', '/home/user/link')",
      ],
    });
    await host(page, 'flush', id);

    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
    // The seed is ignored on restore: persisted state wins.
    const again = await host(
      page,
      'createInstance',
      persistent('persist1', { fs: { persist: true, from: { 'other.txt': 'x' } } }),
    );
    expect(again).toBe('persist1');
    expect((await host(page, 'usage', again)).persist?.restored).toBe(true);
    const out = await host(page, 'run', again, {
      argv: ['node', '-p', "require('fs').readFileSync('/home/user/link/data.json', 'utf8')"],
    });
    expect(out.stdout).toBe('{"n":42}\n');
    expect(await host(page, 'readFile', again, '/seed.txt')).toBe('seeded');
    await expect(host(page, 'readFile', again, '/other.txt')).rejects.toThrow(/ENOENT/);
  });

  test('destroy flushes pending writes; purge deletes the store', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', persistent('persist2'));
    await host(page, 'writeFile', id, '/tmp/x', 'written just before destroy');
    await host(page, 'destroy', id);

    const back = await host(page, 'createInstance', persistent('persist2'));
    expect(await host(page, 'readFile', back, '/tmp/x')).toBe('written just before destroy');
    await host(page, 'destroy', back, true);

    const fresh = await host(page, 'createInstance', persistent('persist2'));
    expect((await host(page, 'usage', fresh)).persist?.restored).toBe(false);
    await expect(host(page, 'readFile', fresh, '/tmp/x')).rejects.toThrow(/ENOENT/);
  });

  test('stores are per instance', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance', persistent('persista'));
    await host(page, 'writeFile', a, '/tmp/owner', 'a');
    await host(page, 'destroy', a);
    const b = await host(page, 'createInstance', persistent('persistb'));
    await expect(host(page, 'readFile', b, '/tmp/owner')).rejects.toThrow(/ENOENT/);
  });

  test('a second tab cannot open the same persistent instance', async ({ page, context }) => {
    await openHost(page);
    await host(page, 'createInstance', persistent('persistlock'));
    const other = await context.newPage();
    await openHost(other);
    await expect(host(other, 'createInstance', persistent('persistlock'))).rejects.toThrow(/EBUSY/);
  });

  test('non-persistent instances do not touch storage', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    expect((await host(page, 'usage', id)).persist).toBeNull();
  });
});
