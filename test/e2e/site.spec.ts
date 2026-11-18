// SPDX-License-Identifier: Apache-2.0
// site/: the landing page. Its live demo boots an instance only when a visitor
// starts it, types npm install and the server's start into a real shell in
// xterm.js, opens the project in an editor that saves as you type, and
// previews the server. xterm.js and the packages come from the network, so
// this test needs network access.
import { expect, test } from '@playwright/test';

const SITE = `http://localhost:${process.env['CLIENTVM_E2E_SITE_PORT']}/`;

test('site: the live demo loads nothing until started, then runs its setup in the terminal and edits live', async ({
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
  // The setup is typed into the terminal's bash, so the command and its output
  // show there. xterm.js renders only the rows in view, so these check lines
  // while they are on screen.
  const term = page.locator('[data-demo-term] .xterm-rows');
  await expect(term).toContainText('Booting the sandbox');
  await expect(term).toContainText(
    'user@clientvm:~/app$ npm install --no-audit --no-fund && npm start',
    {
      timeout: 30_000,
    },
  );
  await expect(term).toContainText(/added \d+ packages/, { timeout: 180_000 });
  await expect(term).toContainText('node server.js');
  await expect(term).toContainText('listening on http://localhost:3000', { timeout: 30_000 });

  const heading = page.frameLocator('[data-demo-preview]').locator('h1');
  await expect(heading).toHaveText('Hello from ClientVM', { timeout: 30_000 });
  await expect(page.locator('[data-demo-empty]')).toBeHidden();
  // The server's own request log shows in the terminal.
  await expect(term).toContainText('GET /');

  // The editor has the project open. An edit to server.js stops the server
  // with Ctrl+C in the terminal and runs it again; the preview follows.
  const editor = page.locator('[data-editor-input]');
  await expect(page.getByRole('tab', { name: 'server.js' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor).toHaveValue(/Hello from ClientVM/);
  await editor.fill((await editor.inputValue()).replace('Hello from ClientVM', 'Edited live'));
  await expect(page.locator('[data-editor-state]')).toHaveText('saved server.js');
  await expect(term).toContainText(/\^C\s*user@clientvm:~\/app\$ npm start/, { timeout: 15_000 });
  await expect(heading).toHaveText('Edited live', { timeout: 30_000 });

  // The visitor stops the server and uses the shell, which sees the edit.
  await page.locator('[data-demo-term]').click();
  await page.keyboard.press('Control+C');
  await page.keyboard.type(`node -p "'express ' + require('express/package.json').version"`);
  await page.keyboard.press('Enter');
  await expect(term).toContainText(/express 4\.\d+\.\d+/);
  await page.keyboard.type('grep -c "Edited live" server.js');
  await page.keyboard.press('Enter');
  await expect(term).toContainText(/server\.js\s*1\s*user@/);

  // A change made in the shell shows in the editor.
  await page.keyboard.type('echo "changed from bash" >> README.md');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'README.md' }).click();
  await expect(editor).toHaveValue(/changed from bash/);

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
