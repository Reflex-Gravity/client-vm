# Demo sandbox (Cloudflare Worker)

Serves `packages/sandbox-host/dist` for the live demo on https://clientvm.joeldsouza.me. Every
instance and preview port gets its own origin, `<label>-cvm.joeldsouza.me`, and every response
carries the headers from [docs/hosting.md](../../docs/hosting.md). Paths outside `/__clientvm/`
return 404: on a sandbox origin they belong to the instance's service worker.

This is a demo deployment. It shares the registrable domain `joeldsouza.me` with the landing page,
which the hosting guide advises against for production. It's acceptable here only because nothing
on `joeldsouza.me` uses cookies or logins (see [docs/security.md](../../docs/security.md)).

## One-time setup

1. In the `joeldsouza.me` zone, add a **proxied** DNS record `*` → `AAAA 100::`. Explicit records
   such as `clientvm` (the site, on Cloudflare Pages) still take precedence over the wildcard.
2. Create an API token with **Workers Scripts: Edit** and **Workers Routes: Edit** on the zone, and
   add it to the repository's Actions secrets as `CLOUDFLARE_API_TOKEN`, with
   `CLOUDFLARE_ACCOUNT_ID`.

The free Universal SSL certificate covers `*.joeldsouza.me`, so flat names such as
`abc-cvm.joeldsouza.me` need no extra certificate. Names one level deeper would.

## Deploy

The `sandbox` workflow deploys on pushes to `main` that touch the sandbox. By hand:

```sh
pnpm --filter @clientvm/sandbox-host build
pnpm --filter @clientvm/sandbox-worker run deploy
node scripts/check-sandbox-headers.mjs 'https://{id}-cvm.joeldsouza.me' --app https://clientvm.joeldsouza.me
```
