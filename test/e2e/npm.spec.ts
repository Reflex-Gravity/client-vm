// SPDX-License-Identifier: Apache-2.0
// Real npm (unmodified, downloaded and integrity-checked on first use) running
// on the Node-compat layer against the public registry; plus curl and tar.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const SLOW = { timeoutMs: 120_000 };

test.describe('npm', () => {
  test.setTimeout(240_000);

  test('install, scripts, bins, npx, ci, ls', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance');
    const sh = async (cmd: string) => {
      const r = await host(page, 'exec', id, cmd, { cwd: '/home/user/app', ...SLOW });
      expect(r.stderr, cmd).toBe('');
      expect(r.code, cmd).toBe(0);
      return r.stdout;
    };
    await host(page, 'exec', id, 'mkdir -p /home/user/app');

    expect(await sh('npm --version')).toBe('11.6.1\n');
    await sh('npm init -y >/dev/null');
    await sh(
      `npm pkg set scripts.start="node -e \\"console.log(require('express/package.json').version)\\"" scripts.moo="cowsay moo"`,
    );
    expect(await sh('npm install express@4.21.2 cowsay@1.6.0 --no-fund')).toMatch(
      /^\nadded \d+ packages in \d+s\n$/,
    );
    const pkg = JSON.parse(await sh('cat package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ cowsay: '^1.6.0', express: '^4.21.2' });

    expect(await sh('npm start')).toContain('\n4.21.2\n');
    expect(await sh('npm run moo')).toContain('< moo >');
    expect(await sh('npx cowsay hi')).toContain('< hi >');
    expect(await sh('ls node_modules/.bin')).toContain('cowsay\n');
    expect(await sh('npm ls --depth=0')).toMatch(/├── cowsay@1\.6\.0\n└── express@4\.21\.2/);

    // A served app built from what npm installed.
    const app = await sh(
      `node -e "const app = require('express')(); app.get('/', (q, r) => r.json({ ok: 1 })); const s = app.listen(3001, async () => { console.log(await (await fetch('http://localhost:3001/')).text()); s.close(); })"`,
    );
    expect(app).toBe('{"ok":1}\n');

    // npm ci reproduces the tree from the lockfile.
    expect(await sh('rm -rf node_modules && npm ci --no-fund')).toMatch(/added \d+ packages/);
    expect(await sh("node -p \"require('cowsay').say({ text: 'x' }).length > 0\"")).toBe('true\n');
  });

  test('lifecycle scripts and local bins', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: {
        from: {
          home: {
            user: {
              dep: {
                'package.json': JSON.stringify({
                  name: 'dep',
                  version: '1.0.0',
                  bin: { depbin: 'cli.js' },
                  scripts: {
                    postinstall: `node -e "require('fs').writeFileSync('built.txt', process.env.npm_lifecycle_event)"`,
                  },
                }),
                'cli.js':
                  '#!/usr/bin/env node\nconsole.log("depbin", process.argv.slice(2).join(","))\n',
              },
              use: { 'package.json': '{"name":"use","version":"1.0.0"}' },
            },
          },
        },
      },
    });
    const r = await host(
      page,
      'exec',
      id,
      'npm install ../dep --no-fund >/dev/null && cat node_modules/dep/built.txt && echo && npx depbin a b && ./node_modules/.bin/depbin c',
      { cwd: '/home/user/use', ...SLOW },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('postinstall\ndepbin a,b\ndepbin c\n');
  });
});

test.describe('curl and tar', () => {
  test.setTimeout(60_000);

  test('curl reaches virtual ports; tar round-trips a tree', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: { from: { home: { user: { src: { 'a.txt': 'hello\n', sub: { 'b.js': 'b\n' } } } } } },
    });
    const { pid } = await host(
      page,
      'startServer',
      id,
      'node',
      [
        '-e',
        `require('http').createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { r.setHeader('x-m', q.method); r.statusCode = q.url === '/missing' ? 404 : 200; r.end(q.method + ' ' + q.url + ' ' + b); }); }).listen(5000)`,
      ],
      {},
      5000,
    );
    const r = await host(
      page,
      'exec',
      id,
      [
        'curl -s localhost:5000/a?b=1',
        'echo',
        'curl -s -d x=1 -d y=2 http://127.0.0.1:5000/post',
        'echo',
        "curl -s -o out.txt -w '%{http_code}\\n' localhost:5000/file",
        'cat out.txt; echo',
        'curl -sI localhost:5000/ | grep -i x-m',
        'curl -sf localhost:5000/missing; echo " fail=$?"',
        'curl -s localhost:5999/ ; echo "refused=$?"',
      ].join('; '),
      { cwd: '/home/user' },
    );
    expect(r.stdout).toBe(
      [
        'GET /a?b=1 ',
        'POST /post x=1&y=2',
        '200',
        'GET /file ',
        'x-m: HEAD\r',
        ' fail=22',
        'refused=7',
        '',
      ].join('\n'),
    );
    await host(page, 'kill', id, pid);

    const t = await host(
      page,
      'exec',
      id,
      'tar czf src.tgz src && gzip -l src.tgz >/dev/null 2>&1; mkdir x && tar xzf src.tgz -C x && cat x/src/a.txt x/src/sub/b.js && tar tzf src.tgz | sort',
      { cwd: '/home/user' },
    );
    expect(t.stderr).toBe('');
    expect(t.stdout).toBe('hello\nb\nsrc/\nsrc/a.txt\nsrc/sub/\nsrc/sub/b.js\n');
  });
});
