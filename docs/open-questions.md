# Open questions

Questions recorded instead of guessed (CLAUDE.md §11.6). Resolve with an ADR in `docs/decisions/`.

## Product / scope

- Which single SQL library the generated apps should use (SQLite-WASM vs PGlite). Outside runtime
  scope, deferred.
- CPU-emulator backend for a future `vm` tier: benchmark spike later, check licensing.
- Whether to add a pre-resolved install plan or shared package cache fast path once npm works.
- Package scope (`@clientvm/*` on npm) and sandbox domain availability.

## Browser behavior to verify (measure, don't assume)

- **JSPI status** in current Chromium and whether it helps the sync-over-async boundary (e.g. for
  OPFS-backed syscalls).
- **OPFS sync access handles:** limits, per-file locking, behavior with many open handles, and
  performance vs. the in-memory VFS.
- **Cross-origin isolation for iframes on wildcard subdomains:** whether the host app also needs
  COOP/COEP or can embed a cross-origin-isolated iframe (`allow="cross-origin-isolated"`), and how
  that interacts with third-party embeds.
- **Process/site isolation** for same-site subdomains (see security.md).
- **Minimum Chromium version:** test which release first supports `Document-Isolation-Policy`
  well enough for instance pages, and pin it in compatibility.md.
- ~~Cross-origin isolation for iframes on wildcard subdomains~~: resolved with
  Document-Isolation-Policy (ADR 0005, docs/phase2-probes.md).

## Runtime design

- **`fs.rmSync` quirk:** on Node 24.11, `rmSync(path, { recursive: true })` reports success on a
  dangling symlink but does not remove it. `MemoryVfs.rmTree` removes it, as `rm -rf` and POSIX do.
  When `rmSync` lands in node-compat (Phase 3), decide whether to replicate the quirk.

- Should the kernel enforce per-process CPU budgets by terminating workers, and how does a process
  get a `SIGINT`-style signal while it is blocked in `Atomics.wait`? A signal slot in the channel
  header is one option.
- `Buffer`: implement it in node-compat (TS) or vendor the `buffer` package? The latter is a
  runtime dependency, so it would need justification.
- Event-loop liveness: how to keep a process alive for pending promises (`fetch`, streams) without
  Node's handle tracking.
- Multi-process kernel contention: does a single kernel worker remain fast with dozens of
  processes (e.g. `npm install`)? Needs a benchmark in Phase 2.
