# ADR 0013: WebAssembly stand-ins for native toolchain packages

- **Status:** accepted (2026-10-21)
- **Context:** Native addons and binaries are a v1 non-goal (CLAUDE.md §3). The golden template
  is a stock Vite + React project, and Vite depends on two native packages:
  - **esbuild:** a Go binary, spawned as a child process.
  - **rollup:** a Rust addon, loaded with `require('…/rollup.linux-x64-gnu.node')`.

  npm installs the platform build of each, and neither can run in ClientVM. Both projects also
  publish official WebAssembly builds with the same interface: `esbuild-wasm` (the same CLI and
  service protocol) and `@rollup/wasm-node` (the same binding exports). Asking agents to add
  `overrides` to every project would make ClientVM projects differ from normal ones.
- **Decision:**
  - When a stock project reaches for one of these native parts, ClientVM uses the matching
    WebAssembly build of the **same version** instead. It fetches that build from the registry on
    first use, checks it against the registry's published integrity, and unpacks it into
    `/usr/local/lib/clientvm/standins/<name>@<version>`.
  - **esbuild:** the default environment sets `ESBUILD_BINARY_PATH` to
    `/usr/local/lib/clientvm/bin/esbuild`. esbuild's install script and runtime both honor this
    variable. The file is a marker for the `clientvm-esbuild` runtime, which runs esbuild-wasm on
    the node runtime. It takes the version from `--service=<version>`, which esbuild's JS API
    passes, or else from the nearest `node_modules/esbuild`.
  - **rollup:** the CommonJS loader's `.node` handler asks the stand-in table before it fails
    with `ERR_DLOPEN_FAILED`. A rollup binding gets `@rollup/wasm-node`'s `dist/native.js`.
    `require()` is synchronous, so this download uses synchronous XHR, which dedicated workers
    allow.
  - The table is deliberately short: only packages whose authors publish a drop-in WebAssembly
    build. Other native addons still fail with `ERR_DLOPEN_FAILED`.
- **Consequences:**
  - A stock Vite 6 project installs, serves with HMR, and builds without changes. The first use
    of each stand-in costs a download: about 4 MB for esbuild-wasm and 1.5 MB for
    @rollup/wasm-node.
  - npm still downloads the unused native optional dependencies, such as `@esbuild/linux-x64`
    (about 10 MB), because `process.platform`/`arch` report linux/x64.
  - `env` shows `ESBUILD_BINARY_PATH`. A project that sets its own value takes precedence.
  - The integrity of a stand-in comes from the registry's own metadata, not from a value pinned
    in ClientVM as npm's is (ADR 0012). It is as trustworthy as the registry over TLS, which is
    the same trust `npm install` already places in it.
  - Vite 7+ moves to rolldown, whose WebAssembly build needs WASI threads. That stand-in is not
    covered yet (docs/open-questions.md).
