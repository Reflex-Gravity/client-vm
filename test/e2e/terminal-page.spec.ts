// SPDX-License-Identifier: Apache-2.0
// examples/agent-playground/terminal.html: an interactive shell on a
// pseudo-terminal in xterm.js (attachShell), and the agent's commands in a
// second tab (attachActivityView). xterm.js loads from a CDN, so this test
// needs network access.
import { expect, test } from '@playwright/test';

test('terminal page: interactive shell, Ctrl+C, history, and the agent tab', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`http://localhost:${process.env['CLIENTVM_E2E_EXAMPLE_PORT']}/terminal.html`);
  await expect(page.locator('#status')).toContainText('instance', { timeout: 30_000 });
  const shell = page.locator('#terminal .xterm-rows');
  await expect(shell).toContainText('user@clientvm:~/app$');

  const type = async (text: string) => {
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };

  await type('echo hello && ls');
  await expect(shell).toContainText('hello');
  await expect(shell).toContainText('server.js');

  // Programs see a terminal.
  await type(`node -e "console.log('tty', process.stdout.isTTY, process.stdout.columns > 20)"`);
  await expect(shell).toContainText('tty true true');

  // Ctrl+C stops a running program and returns to the prompt.
  await type('node -e "setInterval(() => {}, 1000)"');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+C');
  await type('echo status=$?');
  await expect(shell).toContainText('status=130');

  // History and cd.
  await type('cd /tmp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(shell).toContainText('status=0');
  await expect(shell).toContainText('user@clientvm:/tmp$');

  // Agent actions show in the agent tab, which opens when they run.
  const agent = page.locator('#agent-terminal .xterm-rows');
  await page.getByRole('button', { name: 'Build' }).click();
  await expect(page.locator('#agent-terminal')).toBeVisible();
  await expect(agent).toContainText('$ node build.js');
  await expect(agent).toContainText('✓ built in 1.6s');
  await page.getByRole('button', { name: 'Run tests (fails)' }).click();
  await expect(agent).toContainText('expected 201, got 500');
  await expect(page.locator('#agent-result')).toContainText('error · exit code 1');
  // The user's shell commands are not in the agent tab.
  await expect(agent).not.toContainText('echo hello');
  await page.getByRole('button', { name: 'Start server' }).click();
  // The first npm run in an instance downloads npm (ADR 0012), slower when tests run in parallel.
  await expect(agent).toContainText('listening on 3000', { timeout: 30_000 });
  await expect(page.frameLocator('#preview').locator('h1')).toHaveText('Hello from ClientVM', {
    timeout: 30_000,
  });
  // The page learns the server's process id when start_process returns, which can be after the preview loads.
  await expect(page.locator('#agent-result')).toContainText(/process \d+ running/);
  await page.getByRole('button', { name: 'Stop server' }).click();
  await expect(page.locator('#agent-result')).toContainText('stopped');

  // Back to the shell tab: it kept its state.
  await page.getByRole('tab', { name: 'Terminal 1' }).click();
  await expect(shell).toContainText('user@clientvm:/tmp$');

  // Search the visible terminal.
  await page.locator('#search').fill('status=130');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#search-status')).toHaveText('found');
  await page.locator('#search').fill('no such text anywhere');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#search-status')).toHaveText('not found');

  // A second shell in its own tab, with its own working directory.
  await page.getByTitle('New shell').click();
  const second = page.locator('#terminal-2 .xterm-rows');
  await expect(second).toContainText('user@clientvm:~/app$');
  await page.locator('#terminal-2 .xterm-helper-textarea').focus();
  await page.keyboard.type('echo second-tab');
  await page.keyboard.press('Enter');
  await expect(second).toContainText('second-tab');
  await expect(shell).not.toContainText('second-tab');

  // After a reload both tabs come back with their scrollback (a new instance behind them).
  await page.reload();
  await expect(page.locator('#status')).toContainText('instance', { timeout: 30_000 });
  await expect(page.getByRole('tab', { name: 'Terminal 2' })).toBeVisible();
  await expect(shell).toContainText('status=130');
  await expect(shell).toContainText('restored from before the page reloaded');
  await page.getByRole('tab', { name: 'Terminal 2' }).click();
  await expect(second).toContainText('second-tab');
  await page.getByRole('tab', { name: /Agent/ }).click();
  await expect(agent).toContainText('$ node build.js');
});
