// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultClientConditions, defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Per-origin response headers (see docs/hosting.md):
 *
 * - Instance origins (`<id>.localhost` here, `<id>.<sandbox-domain>` in
 *   production) get Document-Isolation-Policy, which makes the instance page
 *   and its workers cross-origin isolated (SharedArrayBuffer, Atomics.wait)
 *   without requiring the embedding host app to be isolated. COEP + CORP are
 *   sent as well so the page also works under a host that uses COOP/COEP.
 * - The host app origin gets no isolation headers, unless `?coi=1` is used
 *   to test the COOP/COEP fallback.
 *
 * CLIENTVM_FRAME_ANCESTORS (space-separated origins) restricts who may embed
 * instance pages.
 */
function isolationHeaders(): Plugin {
  const frameAncestors = process.env['CLIENTVM_FRAME_ANCESTORS'];
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (hostname.endsWith('.localhost')) {
      res.setHeader('Document-Isolation-Policy', 'isolate-and-require-corp');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (frameAncestors)
        res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      // The service worker script lives under /__clientvm/ but controls the whole origin.
      if (req.headers['service-worker'] === 'script') res.setHeader('Service-Worker-Allowed', '/');
    } else if (/[?&]coi=1(&|$)/.test(req.url ?? '')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
  };
  return {
    name: 'clientvm-isolation-headers',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig({
  plugins: [isolationHeaders()],
  // Resolve workspace packages to their TypeScript sources; no prebuild needed.
  resolve: { conditions: ['@clientvm/source', ...defaultClientConditions] },
  // Function and class names are observable inside processes (`<Buffer ...>`,
  // `Stats {}`, constructor.name checks), so minification must keep them.
  worker: { format: 'es', rollupOptions: { output: { keepNames: true } } },
  build: {
    target: 'es2023',
    // Everything ClientVM serves lives under /__clientvm/, which the instance
    // service worker never intercepts; all other paths belong to the app.
    assetsDir: '__clientvm/assets',
    rollupOptions: {
      input: { host: 'index.html', instance: '__clientvm/instance.html', sw: 'src/sw.ts' },
      output: {
        keepNames: true,
        // The service worker needs a stable URL so updates replace it in place.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? '__clientvm/sw.js' : '__clientvm/assets/[name]-[hash].js',
      },
    },
  },
});
