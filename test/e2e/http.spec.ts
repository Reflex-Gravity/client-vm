// SPDX-License-Identifier: Apache-2.0
// http/net on virtual ports: an unmodified Express + ws app (golden fixture)
// serves a preview on its port origin, streams responses, and talks
// WebSocket through the injected shim; processes reach it over http and net.
import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { fixtureTree } from './fixtures.ts';
import { host, openHost } from './sandbox.ts';

async function previewFrame(page: Page, url: string): Promise<Frame> {
  await host(page, 'openPreview', url);
  const frame = page.frames().find((f) => f.url() === url);
  if (!frame) throw new Error(`no frame for ${url}`);
  return frame;
}

test.describe('http and WebSocket servers', () => {
  test.setTimeout(60_000);

  test('Express + ws: pages, JSON, streaming, redirects, WebSockets', async ({ page }) => {
    const app = fixtureTree('express-ws');
    await openHost(page);
    const id = await host(page, 'createInstance', { fs: { from: { home: { user: { app } } } } });
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      'node',
      ['server.js'],
      { cwd: '/home/user/app' },
      3000,
    );
    expect(url).toMatch(new RegExp(`^http://${id}-p3000\\.localhost:\\d+/$`));

    const frame = await previewFrame(page, url);
    await expect(frame.locator('#t')).toHaveText('Hello from Express');

    const http = await frame.evaluate(async () => {
      const info = await (await fetch('/api/info?x=1')).json();
      const echo = await fetch('/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: [1, 2] }),
      });
      const missing = await fetch('/nope');
      const redirected = await fetch('/redirect');
      // Chunks arrive as the server writes them.
      const res = await fetch('/stream');
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      return {
        info,
        echo: { status: echo.status, header: echo.headers.get('x-echo'), body: await echo.json() },
        missing: { status: missing.status, body: await missing.text() },
        redirected: {
          url: new URL(redirected.url).pathname + new URL(redirected.url).search,
          body: await redirected.json(),
        },
        stream: { text: chunks.join(''), chunks: chunks.length },
      };
    });
    expect(http.info).toEqual({ method: 'GET', path: '/api/info', query: { x: '1' }, host: true });
    expect(http.echo).toEqual({ status: 201, header: 'yes', body: { got: { a: [1, 2] } } });
    expect(http.missing).toEqual({ status: 404, body: 'no route for /nope' });
    expect(http.redirected.url).toBe('/api/info?from=redirect');
    expect(http.redirected.body.query).toEqual({ from: 'redirect' });
    expect(http.stream.text).toBe('chunk 0\nchunk 1\nchunk 2\ndone\n');
    expect(http.stream.chunks).toBeGreaterThan(1);

    const ws = await frame.evaluate(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const log: unknown[] = [];
          const sock = new WebSocket(`ws://${location.host}/live?room=1`);
          sock.binaryType = 'arraybuffer';
          sock.onopen = () => log.push('open');
          sock.onmessage = (e) => {
            log.push(typeof e.data === 'string' ? e.data : Array.from(new Uint8Array(e.data)));
            if (log.length === 2) sock.send('hi');
            if (log.length === 3) sock.send(new Uint8Array([1, 2, 255]));
            if (log.length === 4) sock.send('x'.repeat(70000).slice(0, 0) + 'bye');
          };
          sock.onclose = (e) => resolve({ log, code: e.code, reason: e.reason, clean: e.wasClean });
          sock.onerror = () => reject(new Error('websocket error'));
        }),
    );
    expect(ws).toEqual({
      log: ['open', 'welcome /live?room=1', 'echo: hi', [1, 2, 255]],
      code: 4000,
      reason: 'requested',
      clean: true,
    });

    // Processes reach the server through localhost, with http.get and fetch.
    const client = await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        String.raw`
          const http = require('http');
          http.get('http://localhost:3000/api/info?via=http', (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => (body += d));
            res.on('end', async () => {
              console.log(res.statusCode, res.headers['content-type'], body);
              const r = await fetch('http://127.0.0.1:3000/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":1}' });
              console.log(r.status, await r.text());
            });
          });`,
      ],
    });
    expect(client.stderr).toBe('');
    expect(client.stdout).toBe(
      '200 application/json; charset=utf-8 {"method":"GET","path":"/api/info","query":{"via":"http"},"host":true}\n' +
        '201 {"got":{"n":1}}\n',
    );

    await host(page, 'kill', id, pid);
    expect(await host(page, 'output', pid)).toContain('listening on 3000');
  });

  test('ports close with their server; EADDRINUSE; listen(0); net sockets', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const r = await host(page, 'run', id, {
      argv: [
        'node',
        '-e',
        String.raw`
          const http = require('http');
          const net = require('net');
          const a = http.createServer((req, res) => res.end('a')).listen(4100, () => {
            const b = http.createServer();
            b.on('error', (e) => {
              console.log('second listen:', e.code, e.syscall, e.port);
              const c = http.createServer().listen(0, () => {
                const port = c.address().port;
                console.log('ephemeral', port >= 32768);
                c.close(() => console.log('closed c'));
                const echo = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d))).listen(4200, () => {
                  const sock = net.connect(4200, 'localhost', () => sock.write('ping'));
                  sock.on('data', (d) => {
                    console.log(String(d));
                    sock.end();
                    echo.close();
                    a.close(() => console.log('closed a'));
                  });
                });
                net.connect(4999).on('error', (e) => console.log('refused:', e.code));
              });
            });
            b.listen(4100);
          });`,
      ],
    });
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual(
      [
        'closed a',
        'closed c',
        'echo:ping',
        'ephemeral true',
        'refused: ECONNREFUSED',
        'second listen: EADDRINUSE listen 4100',
      ].sort(),
    );
    // The process exited, so none of its ports remain.
    const status = await host(
      page,
      'exec',
      id,
      'node -e "fetch(\'http://localhost:4100/\').then(r => console.log(r.status), e => console.log(e.cause.code))"',
    );
    expect(status.stdout).toBe('ECONNREFUSED\n');
  });
});
