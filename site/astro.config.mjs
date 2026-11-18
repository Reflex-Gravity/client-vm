// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'astro/config';
import { defaultClientConditions } from 'vite';

// A static site on GitHub Pages. It is a ClientVM host app: it needs no
// isolation headers, because instances get cross-origin isolation from their
// own pages on the sandbox domain (docs/hosting.md).
export default defineConfig({
  site: 'https://clientvm.joeldsouza.me',
  output: 'static',
  server: { port: 5190 },
  vite: {
    // Resolve workspace packages to their TypeScript sources, as the examples do.
    resolve: { conditions: ['@clientvm/source', ...defaultClientConditions] },
    build: { target: 'es2023' },
  },
});
