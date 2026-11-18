// SPDX-License-Identifier: Apache-2.0
// site/: the landing page. Its live demo boots an instance only when a visitor
// starts it, streams npm install and the server's output into the setup log,
// runs a real shell in xterm.js, and previews the server. xterm.js and the
// packages come from the network, so this test needs network access.
import { expect, test } from '@playwright/test';

const SITE = `http://localhost:${process.env['CLIENTVM_E2E_SITE_PORT']}/`;

test('site: the live demo loads nothing until started, then streams its setup log', async ({
  page,
}) => {
  // Installs express from the public registry, as a visitor would.
  test.setTimeout(240_000);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(SITE);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  // No ClientVM runtime, xterm.js or sandbox origin before the visitor asks.
  expect(requests.filter((u) => /\/run\.[^/]*\.js|jsdelivr|\.localhost:/.test(u))).toEqual([]);

  await page.getByRole('button', { name: 'Start an Express app' }).click();
  const log = page.getByRole('list', { name: 'Setup log' });
  await expect(log).toContainText('Booting the sandbox');
  await expect(log).toContainText(/Sandbox \w+ is up/, { timeout: 30_000 });

  // npm's own output, live: the command, a registry fetch, and the summary.
  await expect(log).toContainText('$ npm install --no-audit --no-fund --loglevel http');
  await expect(log).toContainText('npm http fetch GET 200 https://registry.npmjs.org/express', {
    timeout: 120_000,
  });
  await expect(log).toContainText(/added \d+ packages/, { timeout: 120_000 });
  await expect(page.locator('[data-step="packages"]')).toHaveAttribute('data-state', 'done', {
    timeout: 30_000,
  });
  await expect(log).toContainText('$ npm start');
  await expect(log).toContainText('listening on http://localhost:3000', { timeout: 30_000 });
  await expect(page.locator('[data-setup-title]')).toContainText('Ready in');

  // The preview takes over; the log stays one click away.
  await expect(page.frameLocator('[data-demo-preview]').locator('h1')).toHaveText(
    'Hello from ClientVM',
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-demo-setup]')).toBeHidden();
  await page.getByRole('button', { name: 'log', exact: true }).click();
  await expect(log).toBeVisible();
  await page.getByRole('button', { name: 'log', exact: true }).click();

  // The visitor's shell sees the installed project.
  const shell = page.locator('[data-demo-term] .xterm-rows');
  await expect(shell).toContainText('user@clientvm:~/app$');
  await page.locator('[data-demo-term]').click();
  await page.keyboard.type(`node -p "'express ' + require('express/package.json').version"`);
  await page.keyboard.press('Enter');
  await expect(shell).toContainText(/express 4\.\d+\.\d+/);

  // Reset tears the instance down and offers the choices again.
  await page.getByRole('button', { name: 'reset' }).click();
  await expect(page.getByRole('button', { name: 'Start an Express app' })).toBeVisible();
  await expect(page.locator('[data-demo-status]')).toHaveText('idle');
});

test('site: browsers without Chromium get an explanation instead of the demo', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  await page.goto(SITE);
  await expect(page.locator('[data-demo-note]')).toContainText('Chromium-based browser');
  await expect(page.getByRole('button', { name: 'Start an Express app' })).toBeHidden();
});

test('site: the page as markdown and llms.txt', async ({ request }) => {
  const md = await request.get(`${SITE}index.md`);
  expect(md.ok()).toBe(true);
  expect(await md.text()).toContain('## Quickstart');
  const llms = await request.get(`${SITE}llms.txt`);
  expect(await llms.text()).toMatch(/^# ClientVM\n/);
});
