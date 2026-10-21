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

- **Port → URL mapping.** The primary port is served at the instance origin root; others under
  `/__port/<n>/`. Apps that use absolute paths (`/assets/x.js`) only work on the primary port.
  Options: a sub-origin per port (`<id>-<port>.<sandbox-domain>` bridged to the kernel), or
  rewriting. Decide with a probe before Phase 3 servers (Vite, Express) depend on it.
- **Request/response streaming.** The service worker currently buffers whole bodies. Vite HMR and
  long-lived responses (SSE) will need streaming through the kernel link (Phase 3).

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
- **Shell background jobs** (`cmd &` of in-process commands) live in the shell's worker and end
  when the shell exits; bash leaves them running. Do agents need detached in-process jobs, or is
  `Instance.spawn` enough?
- **Stdin flow control to spawned children.** The shell feeds a child's stdin without
  acknowledgements, so a fast producer (`yes | node slow.js`) can queue unbounded data in the
  kernel. A credit-based `child-stdin` protocol would bound it.
- **Shell arrays** (`a=(...)`, `"${a[@]}"`) are not implemented. Add them if agent scripts need
  them (common in hand-written bash, rare in generated build scripts).
