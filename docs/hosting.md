# Hosting the sandbox

ClientVM needs one static deployment of the sandbox: the files in `@clientvm/sandbox-host`'s
`dist/`. It must be reachable at every instance origin `https://<id>.<sandbox-domain>/`. No
server-side code runs, and your own app needs no changes to its headers.

![Your app stays on its own domain and needs no special headers. The sandbox is one static deployment of @clientvm/sandbox-host on a wildcard subdomain of a separate registrable domain, with one subdomain per instance and one per preview port. Every sandbox response carries Document-Isolation-Policy, COEP, CORP and a frame-ancestors CSP. The two domains are cross-site.](diagrams/hosting.svg)

**At a glance:**

1. Pick a **separate registrable domain** for the sandbox, such as `myapp-sandbox.dev`.
2. Point **wildcard DNS and TLS** for `*.myapp-sandbox.dev` at one static deployment.
3. Upload `@clientvm/sandbox-host`'s `dist/` and set the [response headers](#requirements).
4. Run `clientvm-check-sandbox` against it.
5. Pass `sandboxOrigin` to `createClientVM` in your app.

```sh
npm install -D @clientvm/sandbox-host
# deploy node_modules/@clientvm/sandbox-host/dist, then check it:
npx clientvm-check-sandbox 'https://{id}.myapp-sandbox.dev' --app https://myapp.example
```

From a checkout of this repository, `pnpm --filter @clientvm/sandbox-host build` writes the same
files to `packages/sandbox-host/dist`.

## Why subdomains

The browser's unit of isolation is the origin. ClientVM gives each instance its own, so the
browser itself keeps agent code apart:

- **One origin per instance** (`k3x9.myapp-sandbox.dev`). Each instance's storage, service worker
  and windows are its own, out of reach of your app and of every other instance ([ADR 0003](decisions/0003-kernel-per-instance-origin.md)).
- **One origin per preview port** (`k3x9-p5173.myapp-sandbox.dev`). A dev server inside an instance
  is served on its own origin by that origin's service worker, so its pages are isolated too
  ([ADR 0008](decisions/0008-sub-origin-per-port.md)).
- **A wildcard, because ids are made at runtime.** Instances and ports come and go; the deployment
  must answer for any subdomain without a list.
- **A separate registrable domain.** Under your app's domain (`sandbox.myapp.com`) instance code
  would be same-site with your app: it could set cookies on `.myapp.com` and send same-site
  requests that carry your users' credentials. A domain of its own (`myapp-sandbox.dev`) is
  cross-site.
- **The headers** make each instance page cross-origin isolated through Document-Isolation-Policy.
  That is what lets `fs.readFileSync` block on `SharedArrayBuffer` and `Atomics.wait`, and why your
  app needs no COOP/COEP headers ([ADR 0005](decisions/0005-document-isolation-policy.md)).

## Requirements

> [!WARNING]
> Never serve the sandbox from a subdomain of your app's domain. Instance code would be
> same-site with your app.

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
npx clientvm-check-sandbox 'https://{id}.myapp-sandbox.dev' --app https://myapp.example
```

From a checkout, `node scripts/check-sandbox-headers.mjs` runs the same check. It requests an instance page, the service worker and a port origin on random subdomains and
fails if a requirement above is not met (it warns when `frame-ancestors` is missing).

## Flat sandbox names

`sandboxOrigin` maps a label to an origin. The label is either an instance id or a port label,
`<id>-p<port>`. It doesn't have to be the first DNS label of a dedicated domain. A suffix works too:

```ts
createClientVM({ sandboxOrigin: (label) => `https://${label}-cvm.example.dev` });
```

Instances then live at `https://<id>-cvm.example.dev` and previews at
`https://<id>-p5173-cvm.example.dev`. Everything stays one level below the zone, so a single
wildcard certificate (`*.example.dev`) and one wildcard DNS record cover every origin. The
project's own demo uses this scheme on Cloudflare (`deploy/sandbox-worker`).

A flat scheme only works under a domain that is itself dedicated to the sandbox, or one with no
cookies and no authenticated endpoints anywhere on it. Every origin it creates is same-site with
the rest of that domain (see the [security model](security.md)).

## In your app

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });
const instance = await vm.createInstance({ fs: { from: { 'index.js': "console.log('hi')" } } });
```

> [!TIP]
> Your app needs **no** special headers. If your app already uses COOP/COEP, instances still work
> (fallback mode).

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
