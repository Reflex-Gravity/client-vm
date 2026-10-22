// SPDX-License-Identifier: Apache-2.0
// Real pnpm 10 (unmodified, downloaded and integrity-checked on first use)
// on the Node-compat layer against the public registry.
import { expect, test } from '@playwright/test';
import { host, openHost } from './sandbox.ts';

const SLOW = { timeoutMs: 120_000 };

test.describe('pnpm', () => {
  test.setTimeout(240_000);

  test('add, frozen-lockfile install, run, exec, pnpx, workspaces', async ({ page }) => {
    await openHost(page);
    const id = await host(page, 'createInstance', {
      fs: {
        from: {
          home: {
            user: {
              ws: {
                'package.json': JSON.stringify({ name: 'root', private: true }),
                'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
                packages: {
                  a: {
                    'package.json': JSON.stringify({
                      name: 'a',
                      version: '1.0.0',
                      main: 'index.js',
                    }),
                    'index.js': 'module.exports = "from a";\n',
                  },
                  b: {
                    'package.json': JSON.stringify({
                      name: 'b',
                      version: '1.0.0',
                      dependencies: { a: 'workspace:*' },
                      scripts: { show: 'node -p "require(\'a\')"' },
                    }),
                  },
                },
              },
            },
          },
        },
      },
    });
    const sh = async (cmd: string, cwd = '/home/user/app') => {
      const r = await host(page, 'exec', id, cmd, { cwd, ...SLOW });
      expect(r.code, `${cmd}\n${r.stderr}`).toBe(0);
      return r.stdout;
    };
    await host(page, 'exec', id, 'mkdir -p /home/user/app');

    expect(await sh('pnpm --version')).toBe('10.34.7\n');
    await sh('pnpm init >/dev/null');
    await sh('npm pkg set scripts.start="node -p \\"require(\'ms\')(60000)\\""');
    expect(await sh('pnpm add ms@2.1.3 cowsay@1.6.0')).toMatch(/\+ ms 2\.1\.3/);
    expect(await sh('ls node_modules/.pnpm')).toContain('ms@2.1.3\n');
    expect(await sh('readlink node_modules/ms')).toBe('.pnpm/ms@2.1.3/node_modules/ms\n');
    expect(await sh('pnpm start')).toContain('\n1m\n');
    expect(await sh('pnpm exec cowsay hi')).toContain('< hi >');

    // The lockfile reproduces the tree.
    expect(await sh('cat pnpm-lock.yaml')).toContain("lockfileVersion: '9.0'");
    await sh('rm -rf node_modules && pnpm install --frozen-lockfile');
    expect(await sh('node -p "require(\'ms\')(1000)"')).toBe('1s\n');

    expect(await sh('pnpx cowsay@1.6.0 moo')).toContain('< moo >');

    // Workspaces link local packages.
    await sh('pnpm install', '/home/user/ws');
    expect(await sh('readlink node_modules/a', '/home/user/ws/packages/b')).toBe('../../a\n');
    expect(await sh('pnpm --filter b run show', '/home/user/ws')).toContain('from a\n');
  });
});
