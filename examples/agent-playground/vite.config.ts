// SPDX-License-Identifier: Apache-2.0
import { defaultClientConditions, defineConfig } from 'vite';

// The host app needs no isolation headers: instances get cross-origin
// isolation from their own pages (docs/hosting.md).
export default defineConfig({
  resolve: { conditions: ['@clientvm/source', ...defaultClientConditions] },
  server: { port: 5180 },
  build: {
    target: 'es2023',
    rollupOptions: { input: { main: 'index.html', terminal: 'terminal.html' } },
  },
});
