// SPDX-License-Identifier: Apache-2.0
// examples/agent-playground/terminal.html: an interactive shell on a
// pseudo-terminal in xterm.js (attachShell), and the agent's commands in a
// second tab (attachActivityView). xterm.js loads from a CDN, so this test
// needs network access.
import { expect, test } from '@playwright/test';

test('terminal page: interactive shell, Ctrl+C, history, and the agent tab', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('http://localhost:5180/terminal.html');
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
  await page.getByRole('button', { name: 'Stop server' }).click();
  await expect(page.locator('#agent-result')).toContainText('stopped');

  // Back to the shell tab: it kept its state.
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(shell).toContainText('user@clientvm:/tmp$');
});
