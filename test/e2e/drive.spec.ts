// SPDX-License-Identifier: Apache-2.0
// The driveable preview (slice 4d): outline snapshots with refs, clicks,
// typing, key presses, waits, evaluation, console capture across navigations,
// screenshots, and the instance's network log.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const SERVER = readFileSync(new URL('../fixtures/drive-app/server.js', import.meta.url), 'utf8');

type Snap = { url: string; title: string; outline: string; truncated: boolean; html?: string };

test.describe('driveable preview', () => {
  test.setTimeout(60_000);

  test('read, click, type, navigate, console, screenshot, network log', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: { from: { app: { 'server.js': SERVER } } },
    });
    await host(page, 'startServer', id, 'node', ['/app/server.js'], {}, 5050);
    const p = await host(page, 'drive', id, 5050);
    const call = (method: string, ...args: unknown[]) =>
      host(page, 'previewCall', p, method, ...args);
    const snap = async () => (await call('snapshot')) as Snap;

    const first = await snap();
    expect(first.title).toBe('Drive me');
    expect(first.outline).toBe(
      [
        '- heading[1] "Todo"',
        '- text "0 items"',
        '- button "Add item" [ref=e1]',
        '- text "Name"',
        '- textbox(text) "Name = \\"\\"" [ref=e2]',
        '- button "Save" [ref=e3]',
        '- link(/about) "About us" [ref=e4]',
      ].join('\n'),
    );

    // Refs, selectors and visible text all pick elements.
    await call('click', { ref: 'e1' });
    await call('click', { selector: '#add' });
    await call('click', { text: 'add item' });
    expect((await snap()).outline).toContain('- text "3 items"');
    expect((await snap()).outline).toContain('- text "item 3"');
    expect(await call('click', { text: 'nothing like this' })).toMatchObject({ error: 'Error' });

    await call('type', { selector: '#name' }, 'Ada', { submit: true });
    expect(await call('waitFor', { text: 'hello Ada' }, { timeoutMs: 2000 })).toBe(true);
    expect(await call('waitFor', { text: 'secret text' }, { timeoutMs: 200 })).toBe(false);
    expect(await call('evaluate', 'document.querySelectorAll("li").length')).toBe(3);
    expect(await call('evaluate', 'fetch("/data.json").then(r => r.json())')).toEqual({ ok: true });

    const shot = (await call('screenshot', { maxWidth: 400 })) as { png: string };
    const png = Buffer.from(shot.png, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(400);

    // Navigation by clicking a link; reads made meanwhile land on the new page.
    await call('click', { text: 'About us' });
    expect(await call('waitFor', { text: 'Home' })).toBe(true);
    expect((await snap()).title).toBe('About');
    await call('navigate', '/');
    expect((await snap()).outline).toContain('- text "0 items"');

    const logs = (await call('console')) as { level: string; text: string; url: string }[];
    // Inline scripts' output is captured from the very start of each page.
    expect(logs.map((l) => `${l.level} ${l.text.split('\n')[0]}`)).toEqual([
      'error Error: boom after load',
      'log added 1 {"n":1}',
      'log added 2 {"n":2}',
      'log added 3 {"n":3}',
      'warn submitted',
      'info about page',
      'error Error: boom after load',
    ]);

    const net = await host(page, 'networkLog', id);
    expect(net.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(
      expect.arrayContaining(['GET / 200', 'GET /data.json 200', 'GET /about 200']),
    );
    expect(net.every((e) => e.port === 5050)).toBe(true);
    expect(await host(page, 'networkLog', id, net.at(-1)!.seq)).toEqual([]);
  });

  test('React app: refs drive state through React event handlers', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: {
        from: {
          app: {
            'server.js': String.raw`
              require('http').createServer((q, r) => {
                r.setHeader('content-type', 'text/html');
                r.end('<!doctype html><div id="root"></div><script>' + require('fs').readFileSync('/app/ui.js', 'utf8') + '</script>');
              }).listen(5060);`,
            // A tiny controlled input, the way React tracks values.
            'ui.js': String.raw`
              const input = document.createElement('input');
              const out = document.createElement('p');
              let tracked = '';
              Object.defineProperty(input, 'value', {
                get() { return tracked; },
                set(v) { tracked = String(v); },
                configurable: true,
              });
              input.addEventListener('input', () => { out.textContent = 'typed: ' + HTMLInputElement.prototype.__lookupGetter__('value').call(input); });
              document.getElementById('root').append(input, out);`,
          },
        },
      },
    });
    await host(page, 'startServer', id, 'node', ['/app/server.js'], {}, 5060);
    const p = await host(page, 'drive', id, 5060);
    await host(page, 'previewCall', p, 'type', { selector: 'input' }, 'xyz');
    expect(await host(page, 'previewCall', p, 'waitFor', { text: 'typed: xyz' })).toBe(true);
  });
});

export type { Page };
