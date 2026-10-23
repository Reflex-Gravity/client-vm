// SPDX-License-Identifier: Apache-2.0
// Presets (ADR 0018): `createInstance({ preset: 'vite-react-ts' })` builds
// the project once in a hidden instance (npm ci, stand-ins), keeps the image
// in the host origin's Cache Storage, and boots later instances from it with
// no network.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const APP = '/home/user/app';

test.describe('presets', () => {
  test.setTimeout(400_000);

  test('vite-react-ts: built once, cached across page loads, runs vite', async ({ page }) => {
    await openHost(page);
    const built = Date.now();
    const first = await host(page, 'createInstance', { preset: 'vite-react-ts' });
    test
      .info()
      .annotations.push({ type: 'cold build ms', description: String(Date.now() - built) });
    const ls = await host(
      page,
      'exec',
      first,
      'ls node_modules/.bin/vite src /usr/local/lib/clientvm/standins',
      {
        cwd: APP,
      },
    );
    expect(ls.code, ls.stderr).toBe(0);
    expect(ls.stdout).toContain('App.tsx');
    expect(ls.stdout).toMatch(/rolldown/);
    // The builder is gone; only the instance that asked remains.
    expect(await host(page, 'list')).toEqual([first]);

    const { url } = await host(
      page,
      'startServer',
      first,
      'npm',
      ['run', 'dev', '--', '--port', '5173'],
      { cwd: APP },
      5173,
    );
    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    await expect(frame.locator('h1')).toHaveText('Vite + React + TS', { timeout: 60_000 });
    await frame.locator('button').click();
    await expect(frame.locator('button')).toHaveText('count is 1');

    // A new page load: the image comes from Cache Storage, not the registry.
    const registry: string[] = [];
    page.on('request', (req) => {
      if (req.url().startsWith('https://registry.npmjs.org/')) registry.push(req.url());
    });
    await openHost(page);
    const started = Date.now();
    const second = await host(page, 'createInstance', { preset: 'vite-react-ts' });
    const bootMs = Date.now() - started;
    test.info().annotations.push({ type: 'cached boot ms', description: String(bootMs) });
    const again = await host(page, 'exec', second, 'ls node_modules/vite/package.json', {
      cwd: APP,
    });
    expect(again.code, again.stderr).toBe(0);
    expect(registry).toEqual([]);
    expect(bootMs).toBeLessThan(10_000);
  });

  test('rejects unknown presets and fs.from with a preset', async ({ page }) => {
    await openHost(page);
    const fail = (options: unknown) =>
      page.evaluate(
        (options) =>
          (
            window as unknown as { __clientvm: { createInstance(o: unknown): Promise<string> } }
          ).__clientvm
            .createInstance(options)
            .then(
              () => 'ok',
              (e: { code?: string }) => e.code,
            ),
        options,
      );
    expect(await fail({ preset: 'nope' })).toBe('ERR_INVALID_PRESET');
    expect(await fail({ preset: 'vite-react-ts', fs: { from: { a: 'b' } } })).toBe(
      'ERR_INVALID_PRESET',
    );
  });
});
