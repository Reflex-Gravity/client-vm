// SPDX-License-Identifier: Apache-2.0
// Golden template: an unmodified Nuxt 4 project (fixture test/fixtures/nuxt4).
// Nuxt builds the client with Vite 8 (rolldown, lightningcss) and the server
// with Nitro (rollup, esbuild). Its dev server runs Nitro in a worker thread
// that fetches SSR modules from the main process over a Unix-domain socket
// (vite-node IPC).
//
// The installed tree is ~190 MB, too large to hand to createInstance, so the
// sources and lockfile go in and npm installs inside the instance, as a host
// app (a code workspace) would.
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { readTree } from './fixtures.ts';
import { host, openHost } from './sandbox.ts';

const NUXT = 'node_modules/nuxt/bin/nuxt.mjs';
const APP = '/home/user/app';
const ENV = { NUXT_TELEMETRY_DISABLED: '1', CI: '1' };
const SRC = join(new URL('../..', import.meta.url).pathname, 'test', 'fixtures', 'nuxt4');

async function exec(page: Page, id: string, cmd: string, timeoutMs: number) {
  const r = await host(page, 'exec', id, cmd, { cwd: APP, env: ENV, timeoutMs });
  if (r.code !== 0) console.log(`--- ${cmd} (code ${r.code})\n${r.stdout}\n${r.stderr}`);
  return r;
}

async function expectHydrated(page: Page, url: string) {
  const frame = page.frames().find((f) => f.url() === url)!;
  await expect(frame.locator('#title')).toHaveText(/Hello from Nuxt|Hot updated/, {
    timeout: 120_000,
  });
  // Server-rendered by useFetch through the Nitro API route.
  await expect(frame.locator('#api')).toHaveText('server says hi to /api/hello');
  // Clicks only count once the app has hydrated.
  await expect(async () => {
    await frame.locator('#count').click();
    await expect(frame.locator('#count')).toHaveText(/count is [1-9]/, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return frame;
}

test('Nuxt 4: npm install, nuxt build + Nitro server, nuxt dev + HMR', async ({ page }) => {
  test.setTimeout(600_000);
  // Nuxt's diagnostics print only their code; record the cause they carry.
  // Keyed by the frame's origin: a killed server's page keeps polling it.
  const nuxtErrors: { origin: string; text: string }[] = [];
  const errorsFrom = (url: string) =>
    nuxtErrors.filter((e) => e.origin === new URL(url).origin).map((e) => e.text);
  page.on('console', (m) => {
    if (m.type() === 'error' && /NUXT_\w+ cause:/.test(m.text()))
      nuxtErrors.push({ origin: new URL(m.location().url).origin, text: m.text() });
  });
  await page.addInitScript(() => {
    const capture = Error.captureStackTrace;
    if (!capture) return;
    Error.captureStackTrace = function (obj: object, fn?: (...a: never[]) => unknown) {
      const e = obj as { code?: string; cause?: unknown };
      if (typeof e.code === 'string' && e.code.startsWith('NUXT_')) {
        const c = Array.isArray(e.cause) ? e.cause[0] : e.cause;
        console.error(`${e.code} cause: ${(c as Error)?.stack ?? String(c)}`);
      }
      return capture.call(Error, obj, fn);
    } as typeof capture;
  });

  await openHost(page);
  const id = await host(page, 'createInstance', {
    fs: { from: { home: { user: { app: readTree(SRC) } } } },
  });

  // npm runs `nuxt prepare` as postinstall. It loads rollup-plugin-visualizer,
  // which promisifies zlib.brotliCompress at import time.
  const install = await exec(page, id, 'npm install --no-audit --no-fund', 300_000);
  expect(install.code).toBe(0);
  expect(await host(page, 'readdir', id, `${APP}/.nuxt`)).toContain('tsconfig.json');

  // Nitro copies public assets with fs.promises.cp into directories that do not exist yet.
  const build = await exec(page, id, `node ${NUXT} build`, 300_000);
  expect(build.code).toBe(0);
  expect(build.stdout).toContain('Build complete');
  // Vite's preload helper is built from Function#toString; ClientVM's import.meta
  // handling must not leak into it.
  const leaks = await exec(
    page,
    id,
    `grep -rl "__cvm_\\|__clientvm" .output/public || true`,
    60_000,
  );
  expect(leaks.stdout).toBe('');

  await test.step('Nitro production server: SSR, API route, hydration, client nav', async () => {
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      'node',
      ['.output/server/index.mjs'],
      { cwd: APP, env: { PORT: '3000', HOST: '0.0.0.0' } },
      3000,
    );
    await host(page, 'openPreview', url);
    const frame = await expectHydrated(page, url);
    await frame.locator('#about-link').click();
    await expect(frame.locator('#about')).toHaveText('About page');
    expect(errorsFrom(url)).toEqual([]);
    await host(page, 'kill', id, pid);
  });

  await test.step('nuxt dev: SSR, API route, hydration, HMR with preserved state', async () => {
    const { pid, url } = await host(
      page,
      'startServer',
      id,
      'node',
      [NUXT, 'dev', '--port', '3001', '--host', '0.0.0.0'],
      // Nitro's dev worker serves HTTP on an abstract Unix socket on Linux; ClientVM
      // routes HTTP by port only, so it uses a TCP port instead (Nitro's own switch).
      { cwd: APP, env: { ...ENV, NITRO_NO_UNIX_SOCKET: '1' } },
      3001,
    );
    try {
      await host(page, 'openPreview', url);
      const frame = await expectHydrated(page, url);
      const count = await frame.locator('#count').textContent();

      const file = `${APP}/app/pages/index.vue`;
      const source = await host(page, 'readFile', id, file);
      await host(page, 'writeFile', id, file, source.replace('Hello from Nuxt', 'Hot updated'));
      await expect(frame.locator('#title')).toHaveText('Hot updated', { timeout: 30_000 });
      await expect(frame.locator('#count')).toHaveText(count!);
      expect(errorsFrom(url)).toEqual([]);
    } catch (err) {
      console.log(`--- nuxt dev output\n${await host(page, 'output', pid)}`);
      throw err;
    } finally {
      const output = await host(page, 'output', pid);
      await host(page, 'kill', id, pid);
      expect(output).toContain('Nuxt 4.6.4');
      expect(output).not.toMatch(/EACCES|uncaughtException|\[error\]/);
    }
  });
});
