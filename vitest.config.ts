// SPDX-License-Identifier: Apache-2.0
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a prior build.
  resolve: { conditions: ['@clientvm/source'] },
  ssr: { resolve: { conditions: ['@clientvm/source', ...defaultServerConditions] } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'test/conformance/**/*.test.ts'],
    environment: 'node',
  },
});
