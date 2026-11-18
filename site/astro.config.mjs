// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'astro/config';
import { defaultClientConditions } from 'vite';
import { satteri } from '@astrojs/markdown-satteri';
import { docLinks } from './src/lib/doc-links-plugin.ts';
import { docHtml } from './src/lib/doc-html-plugin.ts';

// A static site on Cloudflare Pages (.github/workflows/site.yml). It is a ClientVM host app: it needs no
// isolation headers, because instances get cross-origin isolation from their
// own pages on the sandbox domain (docs/hosting.md). It also publishes the
// user-facing docs/ as pages under /docs/.
export default defineConfig({
  site: 'https://clientvm.joeldsouza.me',
  output: 'static',
  server: { port: 5190 },
  // The docs pages (src/content.config.ts): links between docs stay on the site,
  // and GitHub-style alerts become callouts.
  markdown: {
    processor: satteri({ mdastPlugins: [docLinks], hastPlugins: [docHtml] }),
    shikiConfig: { theme: 'vitesse-dark' },
  },
  vite: {
    // Resolve workspace packages to their TypeScript sources, as the examples do.
    resolve: { conditions: ['@clientvm/source', ...defaultClientConditions] },
    build: { target: 'es2023' },
  },
});
