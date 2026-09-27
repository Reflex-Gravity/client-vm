// SPDX-License-Identifier: Apache-2.0
import { defaultClientConditions, defineConfig } from 'vite';

/**
 * Cross-origin isolation is required for SharedArrayBuffer and Atomics.wait,
 * which the synchronous syscall channel depends on.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources; no prebuild needed.
  resolve: { conditions: ['@clientvm/source', ...defaultClientConditions] },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { target: 'es2023' },
});
