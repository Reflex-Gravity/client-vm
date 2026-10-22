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

5. **For the service worker script** (`/__clientvm/sw.js`), also send
   `Service-Worker-Allowed: /` so it can control the whole instance origin. Serve it with
   `Cache-Control: no-cache` so updates are picked up.
6. **Keep everything under `/__clientvm/`.** The instance service worker forwards every other path
   on an instance origin to the instance's own virtual servers, which serve its previews.

The development and preview servers (`packages/sandbox-host/vite.config.ts`) apply these headers
to `*.localhost`. Set `CLIENTVM_FRAME_ANCESTORS` to add the CSP header.

## Check your deployment

```sh
node scripts/check-sandbox-headers.mjs 'https://{id}.myapp-sandbox.dev' --app https://myapp.example
```

It requests an instance page, the service worker and a port origin on random subdomains and
fails if a requirement above is not met (it warns when `frame-ancestors` is missing).

## In your app

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });
const instance = await vm.createInstance({ fs: { from: { 'index.js': "console.log('hi')" } } });
```

Your app needs **no** special headers. If your app already uses COOP/COEP, instances still work
(fallback mode).

## Previews

When a server inside an instance opens a port, `instance.onPortOpen((port, url) => ...)` reports
the port's own origin, `https://<id>-p<port>.<sandbox-domain>/` (ADR 0008). The same wildcard
deployment serves it: the controller embeds `/__clientvm/port.html` there to link that origin's
service worker to the instance. Load the URL in an iframe to show the preview. Previews are
private: they only resolve inside the browser tab that runs the instance.

The service worker adds a module script, `/__clientvm/ws-shim.js`, to HTML pages on port origins:
browsers do not let service workers see WebSockets, so the shim carries same-origin (and
`localhost`) WebSockets to the server through the service worker. Port origins get the same
headers as instance origins; preview responses themselves carry only the app server's headers.
