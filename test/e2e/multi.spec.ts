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

test.describe('mounts', () => {
  test.setTimeout(60_000);

  test('read-only mirrors of another instance, kept in step; snapshot mounts', async ({ page }) => {
    await openHost(page);
    const lib = await host(page, 'createInstance', {
      name: 'lib',
      fs: {
        from: {
          shared: { 'util.js': 'module.exports = 1;\n', docs: { 'a.md': '# A\n' } },
          secret: { 'key.txt': 'k' },
        },
      },
    });
    const app = await host(page, 'createInstance');
    const source = { kind: 'instance', from: lib, path: '/shared', readOnly: true };

    expect(await host(page, 'as', app, 'mount', '/mnt/lib', source)).toMatchObject({
      ok: false,
      code: 'ERR_NO_CAPABILITY',
    });
    await host(page, 'as', lib, 'grant', app, {
      kind: 'mount',
      from: lib,
      path: '/shared',
      readOnly: true,
    });
    // The capability covers /shared, not the rest of lib.
    expect(
      await host(page, 'as', app, 'mount', '/mnt/secret', { ...source, path: '/secret' }),
    ).toMatchObject({ ok: false, code: 'ERR_NO_CAPABILITY' });
    expect(
      await host(page, 'as', app, 'mount', '/mnt/rw', { ...source, readOnly: false }),
    ).toMatchObject({ ok: false, code: 'ERR_NOT_SUPPORTED' });
    expect(await host(page, 'as', app, 'mount', '/mnt/lib', source)).toEqual({ ok: true });

    const sh = async (cmd: string) => host(page, 'exec', app, cmd);
    expect((await sh('find /mnt/lib | sort; node -p "require(\'/mnt/lib/util.js\')"')).stdout).toBe(
      '/mnt/lib\n/mnt/lib/docs\n/mnt/lib/docs/a.md\n/mnt/lib/util.js\n1\n',
    );
    // Writes fail with EROFS, including through a symlink into the mount.
    const ro = await sh(
      "echo x > /mnt/lib/new.txt; rm /mnt/lib/util.js; mkdir /mnt/lib/d; ln -s /mnt/lib /tmp/l; echo y > /tmp/l/z; rm -rf /mnt; node -e \"require('fs').writeFileSync('/mnt/lib/n', '1')\" 2>&1 | grep -o \"EROFS[^,]*\" | head -1; ls /mnt/lib",
    );
    expect(ro.stdout).toBe('EROFS: read-only file system\ndocs\nutil.js\n');
    expect(ro.stderr).toContain('/mnt/lib/new.txt: Read-only file system');
    expect(ro.stderr).toContain('/tmp/l/z: Read-only file system');
    expect(ro.stderr).toContain("rm: cannot remove '/mnt': Read-only file system");
    expect(ro.stderr).toContain("cannot remove '/mnt/lib/util.js': Read-only file system");

    // Changes in the source show up in the mirror.
    await host(
      page,
      'exec',
      lib,
      'cd /shared && echo "module.exports = 2;" > util.js && mkdir -p new/deep && echo n > new/deep/n.txt && rm -r docs && ln -s util.js link.js',
    );
    await expect
      .poll(
        async () =>
          (await sh('cd /mnt/lib && find . | sort && cat util.js && readlink link.js')).stdout,
      )
      .toBe(
        '.\n./link.js\n./new\n./new/deep\n./new/deep/n.txt\n./util.js\nmodule.exports = 2;\nutil.js\n',
      );
    await host(page, 'exec', lib, 'mv /shared/new /shared/moved');
    await expect
      .poll(async () => (await sh('ls /mnt/lib')).stdout)
      .toBe('link.js\nmoved\nutil.js\n');

    // Revoking the capability stops the sync; the copy stays.
    await host(page, 'as', lib, 'revoke', app, {
      kind: 'mount',
      from: lib,
      path: '/shared',
      readOnly: true,
    });
    await host(page, 'exec', lib, 'echo late > /shared/late.txt');
    await page.waitForTimeout(300);
    expect((await sh('ls /mnt/lib')).stdout).toBe('link.js\nmoved\nutil.js\n');
    expect(await host(page, 'as', app, 'unmount', '/mnt/lib')).toEqual({ ok: true });
    expect((await sh('ls -A /mnt/lib; echo hi > /mnt/lib/w && cat /mnt/lib/w')).stdout).toBe(
      'hi\n',
    );

    // Snapshot mounts copy a point in time and never change.
    const snap = await host(page, 'snapshot', lib);
    await host(page, 'exec', lib, 'echo after > /shared/util.js');
    await host(page, 'grant', app, { kind: 'mount', from: lib, path: '/', readOnly: true });
    expect(
      await host(page, 'as', app, 'mount', '/snap', {
        kind: 'snapshot',
        snapshot: snap,
        readOnly: true,
      }),
    ).toEqual({ ok: true });
    expect((await sh('cat /snap/shared/util.js /snap/secret/key.txt')).stdout).toBe(
      'module.exports = 2;\nk',
    );
  });
});
