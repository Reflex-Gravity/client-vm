# Open questions

Questions recorded instead of guessed (CLAUDE.md §11.6). Resolve with an ADR in `docs/decisions/`.

## Product / scope

- Which single SQL library the generated apps should use (SQLite-WASM vs PGlite). Outside runtime
  scope, deferred.
- CPU-emulator backend for a future `vm` tier: benchmark spike later, check licensing.
- Whether to add a pre-resolved install plan or shared package cache fast path once npm works.
  Answered for preset projects: built once, cached on the host origin (ADR 0018). Arbitrary
  `npm install`s still download per instance.
- Package scope (`@clientvm/*` on npm) and sandbox domain availability. Publishing targets
  npmjs.com under `@clientvm` (docs/releasing.md); the npm org still has to be claimed.
- **Should the agent see the user's terminal?** `onProcess` reports user and agent commands alike
  (told apart by `tag`), but `read_console` only covers processes the agent started. Giving the
  agent the user's output adds context and also exposes whatever the user typed or printed
  (docs/terminal-plan.md).

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

- ~~PTYs and signals~~: accepted in ADR 0017 after measuring (5 ms keystroke to echo, about
  12 ms Ctrl+C to prompt).
- ~~Job control~~: Ctrl+Z, `fg`, `bg`, SIGTSTP/SIGSTOP/SIGCONT (ADR 0017 amendment). Still
  open: SIGTTIN, and stopping a process that never yields to its event loop.

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
  (5c). Signals to a process blocked in a syscall (`execSync`) use a slot in the channel header
  where the process publishes the signals it catches (ADR 0017 amendment): uncaught ones end it
  at once, caught ones wait for the call to return. Still open: a process blocked in its own
  `Atomics.wait` (not a syscall) cannot run a handler until it wakes.
- **`maxMemoryMB` is not enforced.** `performance.measureUserAgentSpecificMemory()` on the
  instance page counts the page and the kernel worker but not process workers (nested workers
  are not attributed), and each measurement waits for a GC (10–60 s). Options: estimate from
  `performance.memory` in each process (non-standard, coarse), have each process report its own
  heap, or rely on Chromium's per-tab OOM handling and document it. Measured 2026-10-22 on
  Chromium 156: dedicated workers have neither `performance.memory` nor
  `measureUserAgentSpecificMemory` (even cross-origin isolated), so a process cannot report its
  own heap; only the window has `performance.memory`. What bounds memory today is that each
  instance renders in its own process and a crashed one is detected (security-review.md 1.6,
  2.7). Decision needed: keep `maxMemoryMB` as an advisory value, remove it, or document the
  per-renderer bound as the limit.
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
  frameworks that keep per-request context (Next.js, some loggers) rely on. Chromium 156 has no
  `AsyncContext` global, in windows or workers (measured 2026-10-22). Patching
  `Promise.prototype.then` would not cover `await`. The remaining route is a source transform:
  rewrite each `await x` so the continuation restores the context captured before it, and bind
  the context through `then` callbacks, timers and `nextTick`. That rewrites all executed code
  (CommonJS compile hook and ES modules from the service worker); decision needed before it is
  built. It is the blocker for Next.js.
- **`require()` of ES modules** (Node 22.12+) works by rewriting the module as CommonJS
  (`module/esm-to-cjs.ts`), so a module that is both required and imported runs twice (Node
  shares one instance). Sharing would need the CommonJS loader to read the ESM runtime's module
  records synchronously.
- **Top-1,000 npm smoke test (§9).** A curated 50-package list runs in CI (`test/e2e/smoke.spec.ts`).
  The full run (`test/e2e/smoke-full.spec.ts`, the 1,000 most-downloaded packages from
  npm-high-impact in `test/conformance/npm-top.json`) is a weekly and on-demand workflow
  (`.github/workflows/smoke-full.yml`) that uploads a per-package report. First full run
  (2026-10-23): 919 of 936 loadable packages install and load (98.2%); 64 are types-only,
  data-only, subpath-only or another platform's binary. Of the 17 failures, `console.Console`
  (@jest/console) and `node:repl` (ts-node) are fixed since; the rest are native (`sharp`), peer
  conflicts between packages of one batch (now retried with `--legacy-peer-deps`), or fail on
  real Node too (`ts-api-utils` with TypeScript 7, `@noble/hashes`' root import, Jest-only
  packages). The workflow fails below 97%.
  The curated test failed twice in nine local runs without a captured error; watch CI for it.
- **Node test pass rates.** 591 of 1,889 non-skipped `test/parallel` tests pass (compatibility.md).
  The largest gaps are `http`/`net` internals, `fs` permission and watch tests, and exact
  `util.inspect`/`assert` message formats.
- **npm without network.** npm is fetched on first use (ADR 0012). Offline or air-gapped hosts
  need `CLIENTVM_NPM_TARBALL` pointing at a copy they serve. Should the sandbox host offer a
  same-origin copy as an optional asset?
- **npm swallowed an uncaught error once.** While minipass recursed infinitely (since fixed),
  `npm install` exited 1 with no message, though `node -e` reports the same error. Find out why
  npm's exit handler printed nothing.
- **More native stand-ins (ADR 0013).** rolldown, lightningcss (Vite 8) and Tailwind 4's oxide
  are covered. Next.js 16 needs none for SWC: with `--webpack` it downloads its own
  `@next/swc-wasm-nodejs` and compiles (Turbopack, its default, has no WebAssembly build).
  `next build --webpack` then stops prerendering at "Expected workStore to be initialized":
  Next keeps request state in `AsyncLocalStorage`, which loses its store across `await` (below).
  WASI bindings built by napi-rs load the same way as rolldown's (node:wasi plus
  `worker_threads`).
- **TypeScript 7 is a native binary.** `typescript@7` (npm `latest` since 2026) is the Go
  compiler: a per-platform executable with no JavaScript API and no WebAssembly build, so `tsc`
  from a fresh `npm i typescript` cannot run in ClientVM, and ts-node needs TypeScript's JS API.
  `create-vite` templates pin `typescript ~6.0.3` (JavaScript), and `tsc -b && vite build` from
  the `react-ts` template works end to end (measured 2026-10-23). Agents should keep projects
  on TypeScript 6 until there is a WebAssembly build to stand in (ADR 0013).
- **Stand-in install needs the registry at first use.** rolldown's, lightningcss's and oxide's
  stand-ins install with npm inside the instance (they have dependencies). A transient npm
  failure (network, timeout, 5xx) is retried twice, after 1 s and 3 s; an offline host still
  gets the native-binding error. Offline hosts can point npm at a registry mirror they serve
  (`npm_config_registry` in the instance env); a bundled same-origin copy is still open.
- **Unused native downloads.** npm fetches platform binaries (`@esbuild/linux-x64`, about 10 MB)
  that ClientVM never runs. Reporting a platform no native package targets would skip them, but
  it would also break packages that pick a binding by platform (rollup throws before `require`).
