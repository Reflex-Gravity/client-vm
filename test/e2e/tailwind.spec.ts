// SPDX-License-Identifier: Apache-2.0
// Golden template: Vite 8 + React 19 + Tailwind CSS 4 (fixture
// test/fixtures/vite8-tailwind). Tailwind's oxide scanner is native; its
// loader falls back to @tailwindcss/oxide-wasm32-wasi, which ClientVM installs
// on first use (ADR 0013) and runs on node:wasi like rolldown's binding.
import { expect, test } from '@playwright/test';
import { fixtureTree } from './fixtures.ts';
import { host, openHost } from './sandbox.ts';

test.describe('Tailwind CSS 4', () => {
  test.setTimeout(240_000);

  test('dev server: utility classes, and new classes picked up on edit', async ({ page }) => {
    const app = fixtureTree('vite8-tailwind');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      'node',
      ['node_modules/vite/bin/vite.js', '--port', '5173'],
      { cwd: '/home/user/app' },
      5173,
    );
    await host(page, 'openPreview', url);
    const frame = page.frames().find((f) => f.url() === url)!;
    const title = frame.locator('#title');
    await expect(title).toHaveText('Hello from Tailwind', { timeout: 60_000 });
    await expect
      .poll(() => title.evaluate((e) => getComputedStyle(e).color))
      .toBe('rgb(10, 20, 30)');
    expect(await title.evaluate((e) => getComputedStyle(e).fontWeight)).toBe('700');

    // A class that was not in the source before: oxide rescans and the CSS updates.
    const source = await host(page, 'readFile', id, '/home/user/app/src/App.jsx');
    await host(
      page,
      'writeFile',
      id,
      '/home/user/app/src/App.jsx',
      source.replace('text-[rgb(10,20,30)]', 'text-[rgb(200,0,0)]'),
    );
    await expect
      .poll(() => title.evaluate((e) => getComputedStyle(e).color), { timeout: 15_000 })
      .toBe('rgb(200, 0, 0)');

    await host(page, 'kill', id, pid);
    const output = await host(page, 'output', pid);
    expect(output).toContain('installing @tailwindcss/oxide-wasm32-wasi@4.3.3');
    expect(output).not.toMatch(/Cannot find native binding|error/i);
  });

  test('vite build emits the used utilities', async ({ page }) => {
    const app = fixtureTree('vite8-tailwind');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const r = await host(page, 'exec', id, 'node node_modules/vite/bin/vite.js build', {
      cwd: '/home/user/app',
      timeoutMs: 200_000,
    });
    expect(r.stdout + r.stderr).not.toMatch(/error/i);
    expect(r.code).toBe(0);
    const assets = await host(page, 'readdir', id, '/home/user/app/dist/assets');
    const cssFile = assets.find((f) => /^index-.*\.css$/.test(f))!;
    const css = await host(page, 'readFile', id, `/home/user/app/dist/assets/${cssFile}`);
    expect(css).toContain('font-weight:var(--font-weight-bold)');
    expect(css).toMatch(/\.p-4\{/);
  });
});
