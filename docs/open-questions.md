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

- ~~Port → URL mapping~~: one origin per port (ADR 0008, implemented in 3d).
- **WebSocket shim timing.** The shim is a module script, so classic scripts that open a WebSocket
  while the page is parsing get the browser's own (which cannot reach the instance). Building it as
  a classic script would close that gap.
- ~~Request/response streaming~~: responses stream (3d). Request bodies are still buffered by
  the service worker, and nothing applies backpressure from the page to a server's writes or from a
  socket reader to its writer; large uploads or fast producers queue in memory.

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
- **Brotli** is absent from `zlib`. Add a decoder if a package needs it (most feature-detect).
