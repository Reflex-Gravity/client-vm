// SPDX-License-Identifier: Apache-2.0
// Phase 4: capabilities brokered by the controller, the mailbox (host API and
// http://mailbox.internal/ for processes), and HTTP between instances
// (http://<name>.internal:<port>/).
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

test.describe('capabilities and mailbox', () => {
  test.setTimeout(60_000);

  test('grants, delegation, revocation, and messages both ways', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance', { name: 'alpha' });
    const b = await host(page, 'createInstance', { name: 'beta' });
    const c = await host(page, 'createInstance');
    await host(page, 'recordMail', b);

    // Nothing is allowed by default.
    expect(await host(page, 'as', a, 'send', 'beta', { hi: 1 })).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
    expect(await host(page, 'as', a, 'send', 'nobody', 1)).toMatchObject({
      ok: false,
      code: 'ERR_NO_INSTANCE',
    });
    // An instance grants capabilities about itself, and delegates ones it holds.
    expect(await host(page, 'as', b, 'grant', a, { kind: 'channel', peer: b })).toEqual({
      ok: true,
    });
    expect(await host(page, 'as', a, 'grant', c, { kind: 'channel', peer: b })).toEqual({
      ok: true,
    });
    expect(await host(page, 'as', a, 'grant', c, { kind: 'net', peer: b })).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
    expect(await host(page, 'capabilities', a)).toEqual([{ kind: 'channel', peer: b }]);

    // Host API send; the message reaches host listeners and the kernel inbox.
    expect(await host(page, 'as', a, 'send', 'beta', { hi: 1 })).toEqual({ ok: true });
    expect(await host(page, 'mail', b)).toEqual([{ from: a, message: { hi: 1 } }]);
    const recv = await host(page, 'exec', b, "curl -s 'mailbox.internal/recv?timeout=1000'");
    expect(JSON.parse(recv.stdout)).toEqual({ from: a, fromName: 'alpha', message: { hi: 1 } });

    // A process waits on the mailbox while another instance's process sends.
    const waiting = host(page, 'exec', b, "curl -s 'http://mailbox.internal/recv?timeout=10000'");
    await page.waitForTimeout(300);
    const sent = await host(
      page,
      'exec',
      c,
      `curl -s -w ' %{http_code}' -d '{"n":2}' http://mailbox.internal/send/beta`,
    );
    expect(sent.stdout).toBe('{"sent":true}\n 202');
    expect(JSON.parse((await waiting).stdout)).toEqual({
      from: c,
      fromName: null,
      message: { n: 2 },
    });
    expect(
      (await host(page, 'exec', b, "curl -s -w '%{http_code}' 'mailbox.internal/recv'")).stdout,
    ).toBe('204');
    expect((await host(page, 'exec', b, 'curl -s mailbox.internal/')).stdout).toBe(
      `{"id":"${b}","name":"beta","pending":0}\n`,
    );
    // Node processes use the same endpoint with fetch.
    const fromNode = await host(
      page,
      'exec',
      a,
      `node -e "fetch('http://mailbox.internal/send/beta', { method: 'POST', body: JSON.stringify([1, 'two']) }).then(r => console.log(r.status))"`,
    );
    expect(fromNode.stdout).toBe('202\n');
    expect((await host(page, 'mail', b)).at(-1)).toEqual({ from: a, message: [1, 'two'] });

    // Revocation applies to processes too.
    expect(await host(page, 'as', b, 'revoke', c, { kind: 'channel', peer: b })).toEqual({
      ok: true,
    });
    const denied = await host(
      page,
      'exec',
      c,
      `curl -s -w ' %{http_code}' -d '{}' http://mailbox.internal/send/beta`,
    );
    expect(denied.stdout).toMatch(/has no channel capability for beta\n 403$/);
    // An instance cannot revoke capabilities about someone else.
    expect(await host(page, 'as', a, 'revoke', c, { kind: 'channel', peer: b })).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
  });

  test('spawn-instance gates forks and bounds their limits', async ({ page }) => {
    await openHost(page);
    const a = await host(page, 'createInstance');
    expect(await host(page, 'as', a, 'fork')).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
    await host(page, 'grant', a, { kind: 'spawn-instance', limits: { maxProcesses: 3 } });
    expect(await host(page, 'as', a, 'fork', { limits: { maxProcesses: 10 } })).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
    const forked = await host(page, 'as', a, 'fork', { name: 'kid' });
    expect(forked.ok).toBe(true);
    const kid = (forked as { value: string }).value;
    // The child inherited the capability's limit of 3 processes: sh plus two nodes, then EAGAIN.
    const r = await host(
      page,
      'exec',
      kid,
      "for i in 1 2 3; do node -e 'setTimeout(() => {}, 500)' & done; wait",
    );
    expect(r.stderr).toMatch(/Resource temporarily unavailable|EAGAIN/);
    // A child cannot be given capabilities its parent could not grant.
    expect(
      await host(page, 'as', a, 'fork', { capabilities: [{ kind: 'net', peer: kid }] }),
    ).toMatchObject({ ok: false, code: 'ERR_NO_CAPABILITY' });
  });
});

test.describe('HTTP between instances', () => {
  test.setTimeout(60_000);

  test('<name>.internal reaches another instance only with a net capability', async ({ page }) => {
    await openHost(page);
    const api = await host(page, 'createInstance', { name: 'api' });
    const web = await host(page, 'createInstance', { name: 'web' });
    const { pid } = await host(
      page,
      'startServer',
      api,
      'node',
      [
        '-e',
        String.raw`
          require('http').createServer((req, res) => {
            let body = '';
            req.on('data', (d) => (body += d));
            req.on('end', () => {
              if (req.url === '/stream') {
                res.write('one,');
                setTimeout(() => res.end('two'), 50);
                return;
              }
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
            });
          }).listen(3000);`,
      ],
      {},
      3000,
    );

    const denied = await host(
      page,
      'exec',
      web,
      "curl -s -w ' %{http_code}' http://api.internal:3000/",
    );
    expect(denied.stdout).toMatch(/no net capability for api:3000\n 403$/);

    await host(page, 'grant', web, { kind: 'net', peer: api, ports: [3000, 3001] });
    const r = await host(
      page,
      'exec',
      web,
      [
        'curl -s http://api.internal:3000/a?b=1',
        "curl -s -d 'x=1' http://api.internal:3000/post",
        'curl -s http://api.internal:3000/stream',
        'echo',
        `node -e "fetch('http://api.internal:3000/f').then(r => r.json()).then(j => console.log(j.url, j.host))"`,
        `node -e "require('http').get('http://api.internal:3000/h', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => console.log(r.statusCode, JSON.parse(b).url)); })"`,
        // Ports outside the grant, closed ports, and unknown instances.
        "curl -s -o /dev/null -w '%{http_code}\\n' http://api.internal:4000/",
        'curl -s http://api.internal:3001/; echo "closed=$?"',
        'curl -s http://nope.internal:3000/; echo "unknown=$?"',
      ].join('; '),
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      [
        '{"method":"GET","url":"/a?b=1","host":"api.internal:3000","body":""}{"method":"POST","url":"/post","host":"api.internal:3000","body":"x=1"}one,two',
        '/f api.internal:3000',
        '200 /h',
        '403',
        'closed=7',
        'unknown=7',
        '',
      ].join('\n'),
    );
    // The api instance cannot reach web: capabilities are one-way.
    const back = await host(
      page,
      'exec',
      api,
      "curl -s -o /dev/null -w '%{http_code}' http://web.internal/",
    );
    expect(back.stdout).toBe('403');
    await host(page, 'kill', api, pid);
  });
});
