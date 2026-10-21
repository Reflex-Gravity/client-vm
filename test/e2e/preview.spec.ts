// SPDX-License-Identifier: Apache-2.0
// Preview routing: preview iframe → instance service worker → kernel virtual port → VFS.
import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const SITE = {
  site: {
    'index.html':
      '<!doctype html><link rel="stylesheet" href="/style.css"><h1 id="t">Hello from the VFS</h1><script type="module" src="/app.js"></script>',
    'style.css': 'h1 { color: rgb(0, 128, 0); }',
    'app.js':
      "document.body.dataset.app = 'ran'; fetch('/data/info.json').then((r) => r.json()).then((j) => { document.body.dataset.info = j.ok; });",
    data: { 'info.json': '{"ok":"yes"}' },
  },
};

async function previewFrame(page: Page, url: string): Promise<Frame> {
  await host(page, 'openPreview', url);
  // Exact match: the hidden instance iframe shares the origin (and so the URL prefix).
  const frame = page.frames().find((f) => f.url() === url);
  if (!frame) throw new Error(`no frame for ${url}`);
  return frame;
}

test.describe('preview routing', () => {
  test('a preview iframe loads a site served from the VFS, with subresources', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    const url = await host(page, 'serveStatic', id, 3000, '/site');
    expect(url).toMatch(new RegExp(`^http://${id}\\.localhost:\\d+/$`));

    const frame = await previewFrame(page, url);
    await expect(frame.locator('#t')).toHaveText('Hello from the VFS');
    await expect(frame.locator('#t')).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect(frame.locator('body')).toHaveAttribute('data-app', 'ran');
    await expect(frame.locator('body')).toHaveAttribute('data-info', 'yes');
  });

  test('edits in the VFS are visible on reload; missing files 404', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    const url = await host(page, 'serveStatic', id, 3000, '/site');
    const frame = await previewFrame(page, url);
    await host(page, 'writeFile', id, '/site/index.html', '<h1 id="t">Edited</h1>');
    await frame.goto(url);
    await expect(frame.locator('#t')).toHaveText('Edited');
    const status = await frame.evaluate(async () => (await fetch('/missing.js')).status);
    expect(status).toBe(404);
  });

  test('a second port is reachable under /__port/<n>/; unknown ports give 502', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: { from: { ...SITE, api: { 'index.html': 'api root', 'v1.json': '{"v":1}' } } },
    });
    const primary = await host(page, 'serveStatic', id, 3000, '/site');
    const second = await host(page, 'serveStatic', id, 4000, '/api');
    expect(second).toBe(`${primary}__port/4000/`);
    const frame = await previewFrame(page, primary);
    const result = await frame.evaluate(async () => ({
      v1: await (await fetch('/__port/4000/v1.json')).json(),
      unknown: (await fetch('/__port/5000/')).status,
    }));
    expect(result).toEqual({ v1: { v: 1 }, unknown: 502 });
  });

  test('processes reach their own virtual servers with fetch', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    await host(page, 'serveStatic', id, 3000, '/site');
    const result = await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        "const t = setInterval(() => {}, 50); fetch('/data/info.json').then((r) => r.text()).then((b) => { console.log(b); clearInterval(t); })",
      ],
    });
    expect(result.stdout).toBe('{"ok":"yes"}\n');
  });

  test('requests keep working after the service worker is stopped', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    const url = await host(page, 'serveStatic', id, 3000, '/site');
    const frame = await previewFrame(page, url);
    await expect(frame.locator('#t')).toHaveText('Hello from the VFS');

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');

    // The restarted SW has no kernel link; it must ask the instance page to reconnect.
    const body = await frame.evaluate(async () => (await fetch('/data/info.json')).text());
    expect(body).toBe('{"ok":"yes"}');
    await frame.goto(url);
    await expect(frame.locator('#t')).toHaveText('Hello from the VFS');
  });

  test('a new service worker version takes over and is re-linked to the kernel', async ({
    page,
  }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    const url = await host(page, 'serveStatic', id, 3000, '/site');
    const instanceFrame = page
      .frames()
      .find(
        (f) => f.url().includes(`${id}.localhost`) && f.url().includes('/__clientvm/instance.html'),
      )!;

    // A different script URL is a new SW version: it installs, skips waiting and claims clients.
    const before = await instanceFrame.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL,
    );
    await instanceFrame.evaluate(async () => {
      const changed = new Promise((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }),
      );
      await navigator.serviceWorker.register('/__clientvm/sw.js?version=2', {
        scope: '/',
        type: 'module',
      });
      await changed;
    });
    const after = await instanceFrame.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    expect(after).not.toBe(before);
    expect(after).toContain('version=2');

    const frame = await previewFrame(page, url);
    await expect(frame.locator('#t')).toHaveText('Hello from the VFS');
  });

  test('ClientVM files are never routed to the app server', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: { from: { __clientvm: { 'instance.html': 'hijacked' }, ...SITE } },
    });
    const url = await host(page, 'serveStatic', id, 3000, '/');
    const frame = await previewFrame(page, `${url}site/`);
    const instancePage = await frame.evaluate(async () =>
      (await fetch('/__clientvm/instance.html')).text(),
    );
    expect(instancePage).not.toContain('hijacked');
    expect(instancePage).toContain('/__clientvm/assets/');
  });
});
