// SPDX-License-Identifier: Apache-2.0
// The preview server meets docs/hosting.md, per scripts/check-sandbox-headers.mjs
// (the same check integrators run against their own deployment).
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';

test('sandbox host sends the required headers', () => {
  const script = new URL('../../scripts/check-sandbox-headers.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script, 'http://{id}.localhost:4173'], {
    encoding: 'utf8',
  });
  expect(r.stdout).toContain('All requirements met');
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
