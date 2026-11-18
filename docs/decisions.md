# Design decisions

Every significant choice in ClientVM is recorded as an architecture decision record (ADR) in
[`docs/decisions/`](https://github.com/Reflex-Gravity/client-vm/tree/main/docs/decisions). This page summarises all of them. Follow a link for the full
context, the alternatives, the measurements and the consequences.

## Principles that keep coming back

- **Let the browser enforce isolation.** Instances and previews get origins of their own, so
  the browser's origin model, not ClientVM's code, keeps them apart.
- **Run the real thing.** Wherever upstream code can run unchanged (npm, pnpm, Node's streams,
  `path` and tests, `cjs-module-lexer`, WebAssembly builds of native tools), ClientVM runs it
  rather than reimplementing it, and fixes the compat layer instead of patching the tool.
- **Download big tools on first use, and verify them.** npm, git and the WebAssembly stand-ins
  are fetched when first needed and checked against pinned or registry integrity hashes.
- **Measure before deciding.** Wake mechanisms, storage and persistence were chosen from
  measurements taken in Chromium, recorded in each ADR.
- **No runtime dependencies in core packages,** except where an ADR justifies one.

## Isolation and hosting

| Decision | Why | ADR |
|---|---|---|
| **One kernel per instance, on the instance's own origin** (a hidden iframe on `<id>.<sandbox-domain>`); the controller brokers everything between instances | Workers share their origin's storage and channels; one shared origin would let instances reach each other around the kernel | [0003](decisions/0003-kernel-per-instance-origin.md) |
| **Document-Isolation-Policy** on instance pages | Gives instances `SharedArrayBuffer` without forcing COOP/COEP on the host app, which breaks embeds and OAuth popups | [0005](decisions/0005-document-isolation-policy.md) |
| **One origin per virtual port** (`<id>-p<port>.<sandbox-domain>`) | Dev servers emit absolute URLs that break under a path prefix, and previews should not share an origin with the kernel | [0008](decisions/0008-sub-origin-per-port.md) |
| **Presets are built once and cached on the host origin** (Cache Storage) | Instance origins cannot share anything; a ready Vite + React project then boots in about 0.2 s instead of a fresh install | [0018](decisions/0018-presets-cached-on-host-origin.md) |

## Processes and syscalls

| Decision | Why | ADR |
|---|---|---|
| **The kernel wakes with `Atomics.waitAsync`**, with a postMessage doorbell as a fallback | About 10 µs per round trip against 13.7 µs, and the kernel's event loop stays free | [0002](decisions/0002-syscall-wake-mechanism.md) |
| **The shell runs its commands in its own worker**; every command is also a standalone runtime | A worker per `grep` in a loop would take seconds; `PATH` lookup still decides, as `execve` would | [0011](decisions/0011-in-process-shell-commands.md) |
| **Pseudo-terminals and delivered signals** in the kernel, with job control | Programs need `isatty`, raw mode, Ctrl+C reaching handlers and resize events to behave as on Linux | [0017](decisions/0017-pty-and-signals.md) |
| **Process events and a terminal package with no emulator dependency** | Host apps choose their own UI; output history is bounded because instance output is hostile | [0016](decisions/0016-process-events-and-terminal-package.md) |

## Filesystem

| Decision | Why | ADR |
|---|---|---|
| **Memory-first filesystem with write-behind OPFS persistence** | An OPFS call costs 145–375 µs against ~10 µs in memory; `npm install` makes tens of thousands of calls | [0004](decisions/0004-memory-first-vfs-opfs-persistence.md) |

## Node compatibility

| Decision | Why | ADR |
|---|---|---|
| **Target Node.js 24 LTS** (`v24.11.0`) | The compat layer, the ported tests and the differential suites need one fixed reference | [0001](decisions/0001-node-24-target.md) |
| **Native ES modules, served by the service worker** | Real live bindings, cycles and top-level await, instead of an approximate ESM-to-CJS transform | [0006](decisions/0006-native-esm-via-service-worker.md) |
| **Node's own `cjs-module-lexer`** for CommonJS named exports | Its heuristics *are* the specification; a reimplementation matched only 55% of 1,500 files | [0009](decisions/0009-cjs-module-lexer.md) |
| **Vendor `readable-stream`** for `stream` | Node's most behaviour-sensitive code; a rewrite would only approximate it | [0010](decisions/0010-vendor-readable-stream.md) |
| **Vendor pako** for `zlib` | npm needs synchronous, incremental inflate, which the browser does not offer | [0007](decisions/0007-vendor-pako-for-zlib.md) |
| **Vendor Node's `lib/path.js` and the passing subset of Node's tests** | `path` then matches Node by construction, and the test subset is a ratchet in CI | [0015](decisions/0015-vendor-node-path-and-tests.md) |

## Tools and packages

| Decision | Why | ADR |
|---|---|---|
| **npm is the unmodified release, fetched and SHA-512-verified on first use** | Too big to bundle into every instance; running it unpatched avoids reimplementing its resolution | [0012](decisions/0012-npm-on-first-use.md) |
| **WebAssembly stand-ins for native toolchain packages** (esbuild, rollup, rolldown, lightningcss, Tailwind's oxide) | Stock Vite projects work unchanged, using each project's own official WebAssembly build of the same version | [0013](decisions/0013-wasm-stand-ins-for-native-packages.md) |
| **`git` on isomorphic-git, fetched and verified on first use** | A pure-JavaScript git that reads and writes real repositories; porcelain output is diffed against real git | [0014](decisions/0014-git-on-isomorphic-git.md) |

## Proposing a change

Decisions are not relitigated silently. To change one, write a new ADR that supersedes it (as
0003 superseded the original single shared kernel), and update this page.
