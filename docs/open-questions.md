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
- **Process/site isolation** for same-site subdomains: measured on `*.localhost` (each instance
  gets its own renderer process; security-review.md 2.7). Repeat on a real registrable domain.
- **MessagePort `close` events** are not in Chromium 141, so crashed instances are found by a
  heartbeat (up to four `heartbeatMs` intervals). Switch to the event when it ships.
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

- ~~Per-process CPU budgets~~: `limits.maxCpuMs` kills a process that runs without yielding
  (5c). Still open: how a process gets a `SIGINT`-style signal while it is blocked in
  `Atomics.wait`. A signal slot in the channel header is one option.
- **`maxMemoryMB` is not enforced.** `performance.measureUserAgentSpecificMemory()` on the
  instance page counts the page and the kernel worker but not process workers (nested workers
  are not attributed), and each measurement waits for a GC (10–60 s). Options: estimate from
  `performance.memory` in each process (non-standard, coarse), have each process report its own
  heap, or rely on Chromium's per-tab OOM handling and document it.
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
- ~~git~~: isomorphic-git, fetched on first use (ADR 0014). Still open: remote operations need
  a CORS proxy for most hosts (`GIT_CORS_PROXY`), which ClientVM does not provide. Should the
  docs recommend one, or should hosts be told to run their own?
- ~~pnpm~~: pnpm 10 runs unmodified, fetched on first use like npm (5e, `test/e2e/pnpm.spec.ts`).
- **`AsyncLocalStorage` across `await`.** Context does not survive promise continuations, which
  frameworks that keep per-request context (Next.js, some loggers) rely on. Revisit when
  Chromium ships TC39 AsyncContext; patching `Promise.prototype.then` would not cover `await`.
- **`require()` of ES modules** (Node 22.12+). ESM loads asynchronously through the service
  worker, so a synchronous `require` of an ES module fails with `ERR_REQUIRE_ESM`. Packages that
  only ship ESM under the `require` condition (svelte 4's main entry) need `import()`.
- **Top-1,000 npm smoke test (§9).** A curated 50-package list runs in CI (`test/e2e/smoke.spec.ts`).
  The full list needs about an hour of registry traffic per run; make it an opt-in scheduled job.
- **Node test pass rates.** 592 of 1,889 non-skipped `test/parallel` tests pass (compatibility.md).
  The largest gaps are `http`/`net` internals, `fs` permission and watch tests, and exact
  `util.inspect`/`assert` message formats.
- **npm without network.** npm is fetched on first use (ADR 0012). Offline or air-gapped hosts
  need `CLIENTVM_NPM_TARBALL` pointing at a copy they serve. Should the sandbox host offer a
  same-origin copy as an optional asset?
- **npm swallowed an uncaught error once.** While minipass recursed infinitely (since fixed),
  `npm install` exited 1 with no message, though `node -e` reports the same error. Find out why
  npm's exit handler printed nothing.
- **More native stand-ins (ADR 0013).** Vite 7+/8 use rolldown (`@rolldown/binding-wasm32-wasi`
  needs WASI and `worker_threads`); Next.js uses SWC (`@swc/wasm`); Tailwind 4 and Vite's CSS use
  lightningcss (`lightningcss-wasm`). Each needs a stand-in mapping and an e2e test. Real
  `worker_threads` would unlock the WASI ones.
- **Unused native downloads.** npm fetches platform binaries (`@esbuild/linux-x64`, about 10 MB)
  that ClientVM never runs. Reporting a platform no native package targets would skip them, but
  it would also break packages that pick a binding by platform (rollup throws before `require`).
