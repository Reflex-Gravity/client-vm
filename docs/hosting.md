# Hosting the sandbox

ClientVM needs one static deployment of `@clientvm/sandbox-host` (`pnpm --filter
@clientvm/sandbox-host build` → `packages/sandbox-host/dist`). It must be reachable at every
instance origin `https://<id>.<sandbox-domain>/`. No server-side code runs.

## Requirements

1. **A dedicated registrable domain** for the sandbox, separate from your app's (for example
   `myapp-sandbox.dev`, not `sandbox.myapp.com`). Instances run hostile code, so they must not be
   same-site with your app.
2. **Wildcard DNS and TLS** for `*.<sandbox-domain>`, serving the same static files for every
   subdomain. Instance ids are DNS labels (`[a-z0-9-]`, up to 63 chars).
3. **No cookies, ever,** on the sandbox domain, and no authenticated endpoints. Consider adding the
   domain to the [Public Suffix List](https://publicsuffix.org/) so each instance becomes its own
   site to the browser.
4. **Response headers on every response** from instance origins:

   ```
   Document-Isolation-Policy: isolate-and-require-corp
   Cross-Origin-Embedder-Policy: require-corp
   Cross-Origin-Resource-Policy: cross-origin
   Content-Security-Policy: frame-ancestors https://your-app.example
   ```

   `frame-ancestors` should list the app origins allowed to embed instances. The handshake is
   already origin-checked; this is defense in depth.

The development and preview servers (`packages/sandbox-host/vite.config.ts`) apply these headers
to `*.localhost`. Set `CLIENTVM_FRAME_ANCESTORS` to add the CSP header.

## In your app

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });
const instance = await vm.createInstance({ fs: { from: { 'index.js': "console.log('hi')" } } });
```

Your app needs **no** special headers. If your app already uses COOP/COEP, instances still work
(fallback mode).
