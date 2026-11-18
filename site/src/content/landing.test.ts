// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version } from './landing.ts';

describe('landing copy', () => {
  it('names the current release in its beta notice', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../packages/clientvm/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(version).toBe(pkg.version);
  });
});
