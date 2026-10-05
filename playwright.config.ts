// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

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
  // A production build, so worker startup numbers reflect bundled code rather than Vite's dev module graph.
  webServer: {
    command: `vite build packages/sandbox-host && vite preview packages/sandbox-host --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
