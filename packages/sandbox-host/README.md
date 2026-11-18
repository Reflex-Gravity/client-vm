# @clientvm/sandbox-host

The static files ClientVM instances run on: the instance page, the kernel and process workers, and
the service worker that serves previews. There is no server code. You deploy `dist/` once, to a
wildcard subdomain of a domain of its own, and point `createClientVM({ sandboxOrigin })` at it.

```sh
npm install -D @clientvm/sandbox-host
# deploy node_modules/@clientvm/sandbox-host/dist to https://*.myapp-sandbox.dev
npx clientvm-check-sandbox 'https://{id}.myapp-sandbox.dev' --app https://myapp.example
```

**Why a wildcard subdomain.** Every instance gets its own origin (`<id>.myapp-sandbox.dev`), and
every port it serves a preview on gets another (`<id>-p5173.myapp-sandbox.dev`). The browser keeps
origins apart (storage, service workers, windows), which is what keeps agent code away from your
app and from other instances. Ids are created at runtime, so the deployment must answer for any
subdomain. The domain must be a separate registrable domain with no cookies, so instances are not
same-site with your app.

Every response needs these headers (and `Service-Worker-Allowed: /` on `/__clientvm/sw.js`):

```
Document-Isolation-Policy: isolate-and-require-corp
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy: frame-ancestors https://myapp.example
```

`clientvm-check-sandbox` requests an instance page, the service worker and a port origin on random
subdomains and fails if a requirement is not met. The full checklist is the
[hosting guide](https://clientvm.joeldsouza.me/docs/hosting/).

## Developing

- `pnpm dev`: development server with the isolation headers on `*.localhost`.
- `pnpm build && pnpm preview`: production bundle on :4173 (used by Playwright).
