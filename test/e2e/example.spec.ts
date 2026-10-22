// SPDX-License-Identifier: Apache-2.0
// examples/agent-playground: a host app on its own origin boots an instance,
// runs commands, drives the agent tools, and shows the instance's preview.
import { expect, test } from '@playwright/test';

test('agent playground: shell, agent tools and preview', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`http://localhost:${process.env['CLIENTVM_E2E_EXAMPLE_PORT']}/`);
  await expect(page.locator('#status')).toContainText('instance', { timeout: 30_000 });

  await page.locator('#cmd').fill('cat package.json | grep start && node -v');
  await page.locator('#cmd').press('Enter');
  await expect(page.locator('#terminal')).toContainText('"start": "node server.js"');
  await expect(page.locator('#terminal')).toContainText('v24.11.0');

  // The preselected tool call starts the starter app's server.
  await expect(page.locator('#tool')).toHaveValue('start_process');
  await page.locator('#call').click();
  await expect(page.locator('#result')).not.toContainText('ERROR');
  await expect(page.locator('#url')).toHaveText('port 3000', { timeout: 30_000 });
  await expect(page.frameLocator('#preview').locator('h1')).toHaveText('Hello from ClientVM', {
    timeout: 30_000,
  });

  // Another tool: list_processes reports the server and its port.
  await page.locator('#tool').selectOption('list_processes');
  await page.locator('#input').fill('{}');
  await page.locator('#call').click();
  await expect(page.locator('#result')).toContainText('3000');
});
