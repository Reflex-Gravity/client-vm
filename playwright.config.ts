// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';

// Overridable so a second checkout (a worktree) can run e2e beside another's servers.
const PORT = Number(process.env['CLIENTVM_E2E_PORT'] ?? 4173);
const EXAMPLE_PORT = Number(process.env['CLIENTVM_E2E_EXAMPLE_PORT'] ?? 5180);
process.env['CLIENTVM_E2E_PORT'] = String(PORT);
process.env['CLIENTVM_E2E_EXAMPLE_PORT'] = String(EXAMPLE_PORT);

export default defineConfig({
  testDir: 'test/e2e',
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'e2e', testIgnore: /bench\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'bench',
      testMatch: /bench\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 300_000,
    },
  ],
  webServer: [
    // A production build, so worker startup numbers reflect bundled code rather than Vite's dev module graph.
    {
      command: `vite build packages/sandbox-host && vite preview packages/sandbox-host --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    // examples/agent-playground, a host app on its own origin (example.spec.ts).
    {
      command: `vite build examples/agent-playground && vite preview examples/agent-playground --port ${EXAMPLE_PORT} --strictPort`,
      env: { VITE_SANDBOX: `http://{id}.localhost:${PORT}` },
      url: `http://localhost:${EXAMPLE_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
