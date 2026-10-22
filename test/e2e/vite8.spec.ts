// SPDX-License-Identifier: Apache-2.0
// Golden template: an unmodified Vite 8 + React 19 project (fixture
// test/fixtures/vite8-react). Vite 8 bundles with rolldown and minifies CSS
// with lightningcss, both native; ClientVM installs their WebAssembly builds
// on first use (ADR 0013). rolldown's runs on WASI threads (node:wasi and
// worker_threads with shared memory).
import { expect, test } from '@playwright/test';
import { fixtureTree } from './fixtures.ts';
import { host, openHost } from './sandbox.ts';

test.describe('Vite 8 (rolldown)', () => {
  test.setTimeout(240_000);

  test('dev server: preview, HMR with preserved state, CSS updates', async ({ page }) => {
    const app = fixtureTree('vite8-react');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      // What `npm run dev` runs (fixture trees have no node_modules/.bin).
      'node',
      ['node_modules/vite/bin/vite.js', '--port', '5173'],
      { cwd: '/home/user/app' },
      5173,
    );
    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    await expect(frame.locator('#title')).toHaveText('Hello from Vite', { timeout: 60_000 });
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('count is 1');

    const source = await host(page, 'readFile', id, '/home/user/app/src/App.jsx');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/app/src/App.jsx',
      source.replace('Hello from Vite', 'Hot updated'),
    );
    await expect(frame.locator('#title')).toHaveText('Hot updated', { timeout: 15_000 });
    await expect(frame.locator('#count')).toHaveText('count is 1');

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

    await host(page, 'kill', id, pid);
    const output = await host(page, 'output', pid);
    expect(output).toContain('VITE v8.3.5');
    expect(output).not.toMatch(/Cannot find native binding|error/i);
  });

  test('vite build with rolldown and lightningcss as WebAssembly stand-ins', async ({ page }) => {
    const app = fixtureTree('vite8-react');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const r = await host(page, 'exec', id, 'node node_modules/vite/bin/vite.js build', {
      cwd: '/home/user/app',
      timeoutMs: 200_000,
    });
    expect(r.stdout + r.stderr).not.toMatch(/error/i);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('vite v8.3.5');
    expect(r.stdout).toMatch(/✓ \d+ modules transformed/);
    // First use announces each install; the stand-ins match the locked versions.
    expect(r.stderr).toContain('installing @rolldown/binding-wasm32-wasi@1.2.15');
    expect(r.stderr).toContain('installing lightningcss-wasm@1.33.0');
    const standins = await host(page, 'readdir', id, '/usr/local/lib/clientvm/standins');
    expect(standins).toEqual(expect.arrayContaining(['@rolldown', 'lightningcss-wasm@1.33.0']));
    const assets = await host(page, 'readdir', id, '/home/user/app/dist/assets');
    expect(assets.some((f) => /^index-.*\.js$/.test(f))).toBe(true);
    expect(assets.some((f) => /^index-.*\.css$/.test(f))).toBe(true);

    // A second build reuses the installed stand-ins.
    const again = await host(page, 'exec', id, 'node node_modules/vite/bin/vite.js build', {
      cwd: '/home/user/app',
      timeoutMs: 120_000,
    });
    expect(again.code).toBe(0);
    expect(again.stderr).toBe('');

    const url = await host(page, 'serveStatic', id, 8080, '/home/user/app/dist');
    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    await expect(frame.locator('#title')).toHaveText('Hello from Vite');
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText('count is 1');
    test.info().annotations.push({ type: 'output', description: r.stdout });
  });
});
