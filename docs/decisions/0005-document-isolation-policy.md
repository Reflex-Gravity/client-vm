# ADR 0005: Document-Isolation-Policy for instance pages

- **Status:** accepted (2026-10-21), based on probes in [phase2-probes.md](../phase2-probes.md)
- **Context:** Sync syscalls need `SharedArrayBuffer` and `Atomics.wait`, so instance pages must be
  cross-origin isolated. With COOP/COEP that requires the top-level host app to be isolated too.
  That breaks third-party embeds, OAuth popups and similar features in the integrator's app.
- **Decision:** Serve instance pages and workers with
  `Document-Isolation-Policy: isolate-and-require-corp`. In Chromium 156 this isolates the iframe
  and its workers while the host page stays non-isolated. Also send `COEP: require-corp` and
  `CORP: cross-origin`, so the same pages work under a host that uses COOP/COEP (the fallback).
  Both modes are covered by e2e tests.
- **Consequences:** Integrators need no special headers on their own app. The controller checks
  the instance's `crossOriginIsolated` during the handshake and fails with `ERR_NOT_ISOLATED`, so
  misconfigured hosting is caught at boot rather than surfacing as obscure errors later. The
  minimum Chromium version is the one that shipped DIP; it is recorded in
  `docs/compatibility.md`.
