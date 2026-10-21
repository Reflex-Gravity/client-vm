// SPDX-License-Identifier: Apache-2.0
// Golden template: an unmodified Vite 6 + React 18 dev server (fixture
// test/fixtures/vite-react) serving a preview with React Fast Refresh over the
// WebSocket shim. Editing a component keeps its state; editing CSS hot-swaps.
import { expect, test } from '@playwright/test';
import { fixtureTree } from './fixtures.ts';
import { host, openHost } from './sandbox.ts';

test.describe('Vite + React golden template', () => {
  test.setTimeout(120_000);

  test('dev server, preview, HMR with preserved state, CSS updates', async ({ page }) => {
    const app = fixtureTree('vite-react');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const started = Date.now();
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      'node',
      ['node_modules/vite/bin/vite.js', '--port', '5173'],
      { cwd: '/home/user/app' },
      5173,
    );
    expect(url).toMatch(new RegExp(`^http://${id}-p5173\\.localhost:\\d+/$`));
    const bootMs = Date.now() - started;

    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    await expect(frame.locator('#title')).toHaveText('Hello from Vite', { timeout: 30_000 });
    const firstPaintMs = Date.now() - started;
    await frame.locator('#count').click();
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('count is 2');
    // A marker on window survives HMR but not a full reload.
    await frame.evaluate(() => ((window as unknown as { marker: number }).marker = 42));

    const source = await host(page, 'readFile', id, '/home/user/app/src/App.jsx');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/app/src/App.jsx',
      source.replace('Hello from Vite', 'Hot updated'),
    );
    await expect(frame.locator('#title')).toHaveText('Hot updated', { timeout: 15_000 });
    await expect(frame.locator('#count')).toHaveText('count is 2');
    expect(await frame.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);

    const css = await host(page, 'readFile', id, '/home/user/app/src/index.css');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/app/src/index.css',
      css.replace('rgb(10, 20, 30)', 'rgb(200, 0, 0)'),
    );
    await expect
      .poll(() => frame.evaluate(() => getComputedStyle(document.body).color), { timeout: 15_000 })
      .toBe('rgb(200, 0, 0)');
    expect(await frame.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);

    // A syntax error shows Vite's overlay; fixing it recovers.
    await host(
      page,
      'writeFile',
      id,
      '/home/user/app/src/App.jsx',
      `${source}\nexport const = ;\n`,
    );
    await expect(frame.locator('vite-error-overlay')).toHaveCount(1, { timeout: 15_000 });
    // chokidar drops a second change to one file within 50 ms (on Node too).
    await page.waitForTimeout(200);
    await host(page, 'writeFile', id, '/home/user/app/src/App.jsx', source);
    await expect(frame.locator('#title')).toHaveText('Hello from Vite', { timeout: 15_000 });

    await host(page, 'kill', id, pid);
    expect(await host(page, 'output', pid)).toContain('VITE v6.4.5');
    test.info().annotations.push({
      type: 'timing',
      description: `server ready ${bootMs} ms, first paint ${firstPaintMs} ms`,
    });
  });
});

test.describe('Vite production build', () => {
  test.setTimeout(120_000);

  test('vite build (rollup and esbuild as WebAssembly stand-ins) and a static preview', async ({
    page,
  }) => {
    const app = fixtureTree('vite-react');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const r = await host(page, 'exec', id, 'node node_modules/vite/bin/vite.js build', {
      cwd: '/home/user/app',
      timeoutMs: 90_000,
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ \d+ modules transformed/);
    const assets = await host(page, 'readdir', id, '/home/user/app/dist/assets');
    expect(assets.some((f) => /^index-.*\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /^index-.*\.css$/.test(f))).toBe(true);
    // The stand-ins match the versions the lockfile pinned.
    const standins = await host(page, 'readdir', id, '/usr/local/lib/clientvm/standins');
    expect(standins).toContain('esbuild-wasm@0.25.12');

    const url = await host(page, 'serveStatic', id, 8080, '/home/user/app/dist');
    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    await expect(frame.locator('#title')).toHaveText('Hello from Vite');
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('count is 1');
  });
});
