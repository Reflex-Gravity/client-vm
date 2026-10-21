// SPDX-License-Identifier: Apache-2.0
// Preview routing: preview iframe on a port origin → its service worker → kernel virtual port → VFS.
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
  // Exact match: the hidden bridge iframe shares the origin (and so the URL prefix).
  const frame = page.frames().find((f) => f.url() === url);
  if (!frame) throw new Error(`no frame for ${url}`);
  return frame;
}

test.describe('preview routing', () => {
  test('a preview iframe loads a site served from the VFS, with subresources', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: SITE } });
    const url = await host(page, 'serveStatic', id, 3000, '/site');
    // Each port gets its own origin (ADR 0008).
    expect(url).toMatch(new RegExp(`^http://${id}-p3000\\.localhost:\\d+/$`));

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

  test('each port has its own origin; absolute paths stay on that port', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: { from: { ...SITE, api: { 'index.html': 'api root', 'v1.json': '{"v":1}' } } },
    });
    const primary = await host(page, 'serveStatic', id, 3000, '/site');
    const second = await host(page, 'serveStatic', id, 4000, '/api');
    expect(second).toBe(primary.replace('-p3000.', '-p4000.'));
    const frame = await previewFrame(page, second);
    const result = await frame.evaluate(async () => ({
      v1: await (await fetch('/v1.json')).json(),
      missing: (await fetch('/index.css')).status,
    }));
    expect(result).toEqual({ v1: { v: 1 }, missing: 404 });
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
    const frame = await previewFrame(page, url);
    await expect(frame.locator('#t')).toHaveText('Hello from the VFS');

    // A different script URL is a new SW version: it installs, skips waiting and claims clients.
    // It starts without a kernel link and must get one through the bridge page.
    const before = await frame.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await frame.evaluate(async () => {
      const changed = new Promise((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }),
      );
      await navigator.serviceWorker.register('/__clientvm/sw.js?version=2', {
        scope: '/',
        type: 'module',
      });
      await changed;
    });
    const after = await frame.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    expect(after).not.toBe(before);
    expect(after).toContain('version=2');

    await frame.goto(url);
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
