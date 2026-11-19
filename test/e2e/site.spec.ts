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

test('site: a failed boot offers Retry, and the preview toolbar follows open ports', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The sandbox origin is unreachable, so the instance cannot boot.
  const sandbox = /\.localhost:\d+\//;
  await page.route(sandbox, (route) => route.abort());
  await page.goto(SITE);
  await page.getByRole('button', { name: /Shell & Node/ }).click();
  await page.getByRole('button', { name: 'Start a bash shell' }).click();
  await expect(page.locator('[data-demo-note-title]')).toHaveText('The sandbox failed to boot', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-demo-note]')).toContainText('Retrying is usually worth it');
  const retry = page.locator('[data-demo-overlay] [data-demo-retry]');
  await expect(retry).toBeVisible();

  // With the sandbox back, Retry boots the same demo.
  await page.unroute(sandbox);
  await retry.click();
  await expect(page.locator('[data-demo-status]')).toContainText('bash ready', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-demo-note-title]')).toBeHidden();
  // Until the visitor uses the terminal, it says it is a real one.
  const hint = page.locator('[data-demo-term-hint]');
  await expect(hint).toBeVisible();
  await page.locator('[data-demo-term]').click();
  await expect(hint).toBeHidden();

  // One server: its port shows, with no picker.
  const ports = page.locator('[data-demo-ports]');
  await page.getByRole('button', { name: 'serve in background' }).click();
  const app = page.frameLocator('[data-demo-preview]');
  await expect(app.locator('h1')).toHaveText('Sales by region', { timeout: 30_000 });
  await expect(page.locator('[data-demo-port]')).toHaveText('● port 8080');
  await expect(ports).toBeHidden();

  // A second server opens a second port; the picker switches between them.
  await page.locator('[data-demo-term]').click();
  await page.keyboard.type(
    `node -e "require('http').createServer((q, s) => s.end('<h1>second</h1>')).listen(9090)" &`,
  );
  await page.keyboard.press('Enter');
  await expect(ports).toBeVisible({ timeout: 30_000 });
  await expect(ports).toHaveValue('9090');
  await expect(app.locator('h1')).toHaveText('second', { timeout: 15_000 });
  await ports.selectOption('8080');
  await expect(app.locator('h1')).toHaveText('Sales by region', { timeout: 15_000 });

  // Full-size preview hides the terminal and editor; Escape brings them back.
  await page.locator('[data-demo-expand]').click();
  await expect(page.locator('[data-demo-term]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-demo-term]')).toBeVisible();

  await page.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(page.locator('[data-demo-status]')).toHaveText('idle');
});

test('site: browsers without Chromium get an explanation instead of the demo', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  await page.goto(SITE);
  await expect(page.locator('[data-demo-note-title]')).toHaveText('Unsupported browser');
  await expect(page.locator('[data-demo-note]')).toContainText('Chromium-based browser');
  // There is nothing to retry: the browser cannot run it.
  await expect(page.locator('[data-demo-overlay] [data-demo-retry]')).toBeHidden();
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

test('site: the demos gallery links every demo to a page that runs it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${SITE}demos/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Runs in this tab.');
  const cards = page.locator('.demo-card');
  await expect(cards).toHaveCount(6);
  await cards.filter({ hasText: 'Shell & Node' }).click();
  await expect(page).toHaveURL(/\/demos\/shell\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shell & Node');
  // One demo, so no picker; it starts as on the landing page.
  await expect(page.locator('[data-demo-picker]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start a bash shell' }).click();
  await expect(page.locator('[data-demo-status]')).toContainText('bash ready', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'versions' }).click();
  await expect(page.locator('[data-demo-term] .xterm-rows')).toContainText(/v24\.\d+/, {
    timeout: 15_000,
  });
  // The page's own copy, and three more demos.
  await expect(page.getByRole('heading', { name: "How it's built" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View source ↗' })).toHaveAttribute(
    'href',
    /\/blob\/main\/site\/src\/demos\/shell\.ts$/,
  );
  await expect(page.locator('.demo-card')).toHaveCount(3);

  // Agents get the gallery and each demo as markdown, also from llms.txt.
  const gallery = await (await page.request.get(`${SITE}demos.md`)).text();
  expect(gallery).toContain('/demos/agent-drives-preview.md');
  const one = await page.request.get(`${SITE}demos/shell.md`);
  expect(one.headers()['content-type']).toContain('text/markdown');
  expect(await one.text()).toContain("## How it's built");
  expect(await (await page.request.get(`${SITE}llms.txt`)).text()).toContain('## Demos');
});

test('site: the Tailwind demo picks up a new class while Vite 8 runs', async ({ page }) => {
  // npm installs Vite 8 and Tailwind 4, and the WebAssembly stand-ins download.
  test.setTimeout(300_000);
  await page.goto(`${SITE}demos/vite8-tailwind/`);
  await page.getByRole('button', { name: 'Start Vite 8 with Tailwind' }).click();
  await expect(page.locator('[data-demo-status]')).toContainText('port 5173', {
    timeout: 240_000,
  });
  const app = page.frameLocator('[data-demo-preview]');
  await expect(app.locator('#title')).toHaveText('Hello from Tailwind', { timeout: 30_000 });
  const bg = () => app.locator('#count').evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await bg();
  // A utility the page did not use before: the scanner finds it, Vite updates the CSS.
  await page.getByRole('button', { name: 'swap the colour' }).click();
  await expect.poll(bg, { timeout: 30_000 }).not.toBe(before);
});

test('site: the chat demo talks over a WebSocket, and bash joins in', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${SITE}demos/websocket-chat/`);
  await page.getByRole('button', { name: 'Start the chat server' }).click();
  const app = page.frameLocator('[data-demo-preview]');
  await expect(app.locator('#state')).toHaveText('connected over a WebSocket', {
    timeout: 200_000,
  });
  await app.locator('#msg').fill('hi from the page');
  await app.locator('#msg').press('Enter');
  await expect(app.locator('li', { hasText: 'page: hi from the page' })).toBeVisible();
  await page.getByRole('button', { name: 'say from bash' }).click();
  await expect(app.locator('li', { hasText: 'bash: hello from bash' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-demo-term] .xterm-rows')).toContainText(
    'chat: bash: hello from bash',
  );
});

test('site: the agent demo drives the preview with agent tool calls', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${SITE}demos/agent-drives-preview/`);
  await page.getByRole('button', { name: 'Start the app for the agent' }).click();
  await expect(page.locator('[data-demo-status]')).toContainText('port 5050', {
    timeout: 60_000,
  });
  const term = page.locator('[data-demo-term] .xterm-rows');

  // The model's view of the page: an outline with element refs.
  await page.getByRole('button', { name: 'read the page' }).click();
  await expect(term).toContainText('agent ▸ preview_snapshot');
  await expect(term).toContainText(/\[ref=e\d+\]/, { timeout: 30_000 });

  // The agent's own preview is the one on show, so its clicks are visible.
  const app = page.frameLocator('[data-demo-agent-preview] iframe');
  await page.getByRole('button', { name: 'click “Add item”' }).click();
  await expect(app.locator('#status')).toHaveText('1 items', { timeout: 15_000 });
  await page.getByRole('button', { name: 'fill the form' }).click();
  await expect(app.locator('#status')).toHaveText('hello Ada', { timeout: 15_000 });
  await page.getByRole('button', { name: 'read the console' }).click();
  await expect(term).toContainText('submitted', { timeout: 15_000 });

  // An edit to the project shows on the next load.
  await page.getByRole('button', { name: 'edit index.html' }).click();
  await expect(term).toContainText('agent ▸ edit_file');
  await page.getByRole('button', { name: 'reload and read' }).click();
  await expect(app.locator('h1')).toHaveText('Edited by the agent', { timeout: 30_000 });

  await page.getByRole('button', { name: 'reset', exact: true }).click();
  await expect(page.locator('[data-demo-agent-preview] iframe')).toHaveCount(0);
});
