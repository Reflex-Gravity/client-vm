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

  // The todo app is picked to start with.
  await expect(page.getByRole('button', { name: 'Start the todo app' })).toBeVisible();
  await page.getByRole('button', { name: /Express server/ }).click();
  await page.getByRole('button', { name: 'Start an Express app' }).click();
  // The setup is typed into the terminal's bash, so the command and its output
  // show there. xterm.js renders only the rows in view, so these check lines
  // while they are on screen.
  const term = page.locator('[data-demo-term] .xterm-rows');
  await expect(term).toContainText('Booting the sandbox');
  // The command is wider than the terminal, so only its start is on one row.
  await expect(term).toContainText('user@clientvm:~/app$ npm install', { timeout: 30_000 });
  // npm logs each registry fetch, so the install shows progress as it goes.
  await expect(term).toContainText(/npm http fetch GET 200/, { timeout: 60_000 });
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

  // A "try" chip types its command into the shell and runs it.
  await page.getByRole('button', { name: 'git commit' }).click();
  await expect(term).toContainText(/[0-9a-f]{7} init/, { timeout: 30_000 });
  // On a running server, a chip presses Ctrl+C first.
  await page.getByRole('button', { name: 'start server' }).click();
  await expect(term).toContainText('listening on http://localhost:3000', { timeout: 30_000 });
  await page.getByRole('button', { name: 'count packages' }).click();
  await expect(term).toContainText(/\^C\s*user@clientvm:~\/app\$ ls node_modules \| wc -l/, {
    timeout: 15_000,
  });

  // Reset tears the instance down and offers the choices again.
  await page.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start an Express app' })).toBeVisible();
  await expect(page.locator('[data-demo-status]')).toHaveText('idle');
});

test('site: the todo app, on Vite + React, stays in sync with bash and the editor', async ({
  page,
}) => {
  // The first start in a browser builds the Vite preset once.
  test.setTimeout(240_000);
  await page.goto(SITE);
  await page.getByRole('button', { name: 'Start the todo app' }).click();
  await expect(page.locator('[data-demo-status]')).toContainText('port 5173', {
    timeout: 180_000,
  });
  const term = page.locator('[data-demo-term] .xterm-rows');
  const app = page.frameLocator('[data-demo-preview]');
  await expect(app.locator('h1')).toHaveText('Todos', { timeout: 30_000 });
  await expect(app.locator('li')).toHaveCount(3);

  // A todo added with curl in bash shows in the page, which polls the API.
  await page.getByRole('button', { name: 'add from bash' }).click();
  await expect(app.locator('li', { hasText: 'Added from bash' })).toBeVisible({
    timeout: 15_000,
  });

  // Ticking one off in the page writes todos.json, which the editor shows,
  // and the server logs it in the terminal.
  const editor = page.locator('[data-editor-input]');
  await expect(page.getByRole('tab', { name: 'src/App.tsx' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'todos.json' }).click();
  await app.locator('li', { hasText: 'Tick this off' }).locator('input').check();
  await expect(term).toContainText('✓ Tick this off in the preview', { timeout: 15_000 });
  await expect(editor).toHaveValue(/"title": "Tick this off in the preview",\s*"done": true/);

  // An edit to todos.json in the editor shows in the page.
  await editor.fill((await editor.inputValue()).replace('Boot Node.js', 'Edited in the editor:'));
  await expect(app.locator('li', { hasText: 'Edited in the editor:' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'count open' }).click();
  await expect(term).toContainText(/todos\.json\s*2\s*user@/, { timeout: 15_000 });

  // The React code type-checks, and an edit to it hot-reloads the page.
  await page.getByRole('button', { name: 'type-check' }).click();
  await expect(term).toContainText('types ok', { timeout: 60_000 });
  await page.getByRole('tab', { name: 'src/App.tsx' }).click();
  await editor.fill((await editor.inputValue()).replace('<h1>Todos</h1>', '<h1>My todos</h1>'));
  await expect(app.locator('h1')).toHaveText('My todos', { timeout: 30_000 });

  await page.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(page.locator('[data-demo-status]')).toHaveText('idle');
});

test('site: the shell example boots without an install and its chips drive bash', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(SITE);
  await page.getByRole('button', { name: /Shell & Node/ }).click();
  await page.getByRole('button', { name: 'Start a bash shell' }).click();
  await expect(page.locator('[data-demo-status]')).toContainText('bash ready', {
    timeout: 30_000,
  });
  const term = page.locator('[data-demo-term] .xterm-rows');
  // The visitor is told what to run: in the terminal, the editor and the preview.
  await expect(term).toContainText('Welcome to bash, running in your browser tab');
  await expect(page.getByRole('tab', { name: 'README.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-demo-empty-text]')).toContainText('node serve.js &');
  // The terminal's rows fit inside its window.
  const rows = await page.locator('[data-demo-term] .xterm-screen').boundingBox();
  const body = await page.locator('[data-demo-term]').boundingBox();
  expect(rows!.y + rows!.height).toBeLessThanOrEqual(body!.y + body!.height + 1);
  await page.getByRole('button', { name: 'pipe a CSV' }).click();
  await expect(term).toContainText(/5 north\s+3 west/, { timeout: 15_000 });

  // A server in the background opens the preview; curl reaches it.
  await page.getByRole('button', { name: 'serve in background' }).click();
  const heading = page.frameLocator('[data-demo-preview]').locator('h1');
  await expect(heading).toHaveText('Sales by region', { timeout: 30_000 });
  await page.getByRole('button', { name: 'curl it' }).click();
  await expect(term).toContainText('"north":650', { timeout: 15_000 });

  await page.getByRole('button', { name: 'reset', exact: true }).click();
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
  const index = await llms.text();
  expect(index).toMatch(/^# ClientVM\n/);
  expect(index).toContain('/docs/quickstart.md');
  // Every doc in one file, and a sitemap of every page.
  const full = await (await request.get(`${SITE}llms-full.txt`)).text();
  expect(full).toContain('# Hosting the sandbox');
  expect(full).toContain('# ADR 0018');
  const sitemap = await (await request.get(`${SITE}sitemap.xml`)).text();
  expect(sitemap).toContain('/docs/decisions/0003-kernel-per-instance-origin/</loc>');
  expect(await (await request.get(`${SITE}robots.txt`)).text()).toContain('Sitemap:');
});

test('site: the quickstart shows its steps in order and the docs stay on the site', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(SITE);
  const qs = page.locator('#quickstart');
  await qs.scrollIntoViewIfNeeded();

  // Three steps, all visible at once, the sandbox first.
  const steps = qs.locator('ol.steps > li h3');
  await expect(steps).toHaveText([
    'Deploy the sandbox, once',
    'Install the runtime in your app',
    'Boot an instance and show its preview',
  ]);
  // Why a subdomain, behind a disclosure.
  const why = qs.getByText('Why a wildcard subdomain on a separate domain?');
  await why.click();
  await expect(qs.getByText(/k3x9-p5173\.myapp-sandbox\.dev/)).toBeVisible();

  // Copying a step puts its snippet on the clipboard.
  await qs.getByRole('button', { name: 'Copy the Install snippet' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'npm install @clientvm/clientvm',
  );

  // The add-ons are tabs.
  await expect(qs.getByRole('tabpanel')).toContainText('attachShell');
  await qs.getByRole('tab', { name: 'Agent tools' }).click();
  await expect(qs.getByRole('tabpanel')).toContainText('createAgentTools');

  // The hosting guide is a page here, and its links to other docs stay here.
  await page.getByRole('link', { name: 'Hosting guide →', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/hosting\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hosting the sandbox');
  await expect(page.locator('#why-subdomains')).toBeVisible();
  await page.locator('article').getByRole('link', { name: 'security model' }).first().click();
  await expect(page).toHaveURL(/\/docs\/security\/$/);
  await expect(
    page.getByRole('navigation', { name: 'Docs' }).locator('[aria-current="page"]'),
  ).toHaveText(/Security/);

  // Agents get the same page as markdown.
  const md = await page.request.get(new URL('docs/hosting.md', SITE).href);
  expect(md.headers()['content-type']).toContain('text/markdown');
  expect(await md.text()).toContain('## Why subdomains');
});
