# Packages

A guide to the ten packages under `packages/` and how they work together. For the big picture
with diagrams see [how ClientVM works](architecture.md); for the decisions behind them see the
[design decisions](decisions.md); for the public API see the [API reference](interfaces.md); for
what works see the [compatibility matrix](compatibility.md).

## Overview

ClientVM runs Node.js 24 programs, a POSIX shell and common Linux commands entirely inside a Chromium tab, with no server-side compute. It is an Apache-2.0 TypeScript monorepo of ten packages under `packages/`, built for AI-agent app builders: each agent gets its own sandboxed filesystem and processes, and the React + Node apps it generates run and preview in the browser.

The mental model is a small operating system:

- An **instance** is a sandboxed machine. It has a filesystem, a process table, a virtual network and resource limits, and it lives on its own origin (`<id>.<sandbox-domain>`).
- A **kernel** runs in a Web Worker on that origin and owns all instance state.
- Every **process** (`node`, `sh`, `npm`, `vite`) is another Web Worker. It talks to the kernel through **syscalls**. Blocking calls like `fs.readFileSync` really block, on a `SharedArrayBuffer` with `Atomics.wait`.
- A **controller** on the host app page creates instances and brokers everything between them. It never runs untrusted code itself.

On top of that, real unmodified npm, pnpm, Vite, git (isomorphic-git) and WebAssembly builds of esbuild, rollup and friends run as ordinary programs. Native addons, other languages and raw TCP are out of scope for v1.

## Architecture

ClientVM has four layers of execution, each in a different browser context. The trust boundary sits between the controller and the instance pages: everything below the controller treats its inputs as hostile.

```
Host app page (app origin, trusted)
  ├─ Controller (@clientvm/clientvm): validation, capabilities, mailbox, forks
  └─ agent-api, terminal: LLM tools, activity feed, interactive shell
        │
        │ MessagePort: InstanceRpc ↔ ControllerRpc
        ▼
Instance origin <id>.<sandbox-domain> (Document-Isolation-Policy)
  ├─ Instance page: handshake, boots the kernel
  ├─ Service worker: module + fetch routing ───────────────┐
  └─ Kernel worker (@clientvm/kernel + vfs)  ◄─────────────┘
       │  MemoryVfs · process table · fd tables · PTYs · signals · limits
       │  virtual net + HTTP router · module server · mailbox · mounts
       │
       │ sync SAB + async messages
       ├─ node            (node-compat runtime)
       ├─ sh, ls, grep, … (shell runtime)
       └─ npm, vite, scripts (unmodified tools)
              ▲
              │ requests to its port
Port origin <id>-p<port>.<sandbox-domain> (one per open port, ADR 0008)
  ├─ Preview iframe: app pages + ws-shim + agent script
  └─ Port bridge + service worker: routes to one virtual port
```

The host page holds only trusted code. Everything that runs agent code (the kernel, the process workers and the previews) lives on per-instance and per-port sandbox origins.

| Layer | Runs in | Origin | Owned by package | Job |
| --- | --- | --- | --- | --- |
| Controller | Host app page | App's own origin, no isolation headers needed | `clientvm` | Creates instances, validates every message, brokers capabilities, mailbox, cross-instance network and forks |
| Instance page | Hidden iframe | `https://<id>.<sandbox-domain>/__clientvm/instance.html` | `sandbox-host` | Cross-origin isolated by Document-Isolation-Policy; registers the service worker, then starts the kernel |
| Service worker | Per instance origin, scope `/` | Same as instance | `sandbox-host` | Forwards preview traffic, process `fetch` and module loads (`/__clientvm/fs/...`) to the kernel |
| Kernel worker | Dedicated worker under the instance page | Same as instance | `kernel` (+ `vfs`) | Owns the VFS, process table, fd tables, PTYs, virtual net, module server, limits |
| Process workers | Nested dedicated workers, one per process | Same as instance | `process` + a runtime (`node-compat`, `shell`) | Run user code; make sync syscalls over a SAB and async ones over `postMessage` |

Three channels connect them:

- **Controller to kernel**: a `MessagePort` handed over after an origin-checked handshake. The kernel serves `InstanceRpc` (spawn, fs ops, snapshot, grants) and calls back with `ControllerRpc` (`mailboxSend`, `netFetch`).
- **Process to kernel, synchronous**: a 256 KiB `SharedArrayBuffer` per process. The process writes a request and blocks in `Atomics.wait`; the kernel wakes on `Atomics.waitAsync` and writes the reply.
- **Process to kernel, asynchronous**: `postMessage` for stdout/stderr chunks, readiness, exit, signals and HTTP relay messages.

Each preview port gets its own origin too, `https://<id>-p<port>.<sandbox-domain>/` (ADR 0008), served by the same static deployment. No server-side code runs anywhere: the sandbox domain is pure static hosting with a few required response headers (`docs/hosting.md`).

## Package map

Ten workspace packages, ordered from the bottom of the stack up. `protocol` has no dependencies; `clientvm` (the controller) depends only on `protocol`'s types and RPC, so the host page never bundles kernel or runtime code.

| Package | Runs in | Role | Depends on | Source size (lines, excl. tests/vendor) |
| --- | --- | --- | --- | --- |
| `@clientvm/protocol` | Everywhere | Errno/`SystemError`, opcodes, binary codec, sync syscall channel, `RpcEndpoint`, message and RPC type contracts | none | ~1,700 |
| `@clientvm/vfs` | Kernel worker | `MemoryVfs` (inodes, symlinks, CoW snapshots, quotas, watchers), filesystem images, OPFS write-behind persistence | `protocol` | ~1,700 |
| `@clientvm/process` | Process worker | Worker bootstrap, `ProcessContext`, stdio streams, TTY info, `Runtime` / `RuntimeTable` contract | `protocol` | ~430 |
| `@clientvm/node-compat` | Process worker | The `node` runtime: Node 24 core module shims, CJS loader, ESM resolver, npm/pnpm launchers, WASM stand-ins | `process`, `protocol`, `pako` | ~17,400 |
| `@clientvm/shell` | Process worker | `sh`/`bash` parser and interpreter, interactive mode, ~50 Linux commands, git | `node-compat`, `process`, `protocol` | ~15,500 |
| `@clientvm/kernel` | Kernel worker | Process table, syscall dispatcher, fd tables, command resolution, PTYs, virtual net, HTTP router, module server, mailbox, mounts | `vfs`, `protocol`, `node-compat`, `cjs-module-lexer` | ~3,200 |
| `@clientvm/sandbox-host` (private) | Sandbox origin | The static deployment: instance page, kernel and process worker entries, service worker, port page, WebSocket shim | all of the above | ~1,600 |
| `@clientvm/clientvm` | Host page | Public API: `createClientVM`, instances, capabilities, presets, previews, validation, rate limiting | `protocol` | ~2,700 |
| `@clientvm/agent-api` | Host page | LLM tool definitions and dispatcher on top of an `Instance` | `clientvm` | ~680 |
| `@clientvm/terminal` | Host page | Activity feed and interactive shell attachment for any xterm.js-compatible terminal | `clientvm` | ~700 |

Workspace conventions: sources import siblings with `.ts` extensions, and each package's `exports` has a `@clientvm/source` condition pointing at `src/index.ts`, so Vite and Vitest need no prior build. Every source file carries `// SPDX-License-Identifier: Apache-2.0`.

## Package deep dives

### @clientvm/protocol: the shared contracts

Every other package speaks through `protocol`. It holds no state and has no dependencies, and its interfaces are bytes in, bytes out, so the hot paths can later move to Rust/WASM without touching callers.

- **Errors** (`errors.ts`): `Errno` numbers with Linux values, `SystemError`, and `errnoCode`/`errnoOf` to map between `ENOENT`-style codes and numbers.
- **Binary codec** (`codec.ts`): a compact tagged encoding for syscall arguments and results. The tags are `NULL`, `UNDEFINED`, `FALSE`, `TRUE`, `INT32`, `FLOAT64`, `STRING`, `BYTES`, `ARRAY`, `OBJECT`, with little-endian lengths. It is also used for VFS images and checkpoints.
- **Opcodes** (`opcodes.ts`): 27 syscall ops. Path ops are `STAT` … `COPY_FILE` (1–19), fd ops are `OPEN` … `FTRUNCATE` (20–25), and `SPAWN_SYNC` (26) blocks the caller until a child exits. Two negative channel ops, `REQUEST_MORE` and `RESPONSE_MORE`, stream payloads too big for the buffer.
- **Syscall channel** (`syscall-channel.ts`): `SyscallClient` (process side) and `SyscallServer` (kernel side) over one `SharedArrayBuffer`. The buffer is an 8 × Int32 header (`STATE`, `OP`, `LEN`, `ERRNO`, `TOTAL`, plus slots for `STOPPED` and `CAUGHT`) followed by a 256 KiB payload (`DEFAULT_PAYLOAD_BYTES`). The client blocks in `Atomics.wait`; the server parks in `Atomics.waitAsync`, with a `postMessage` doorbell as fallback (ADR 0002). Handlers may return a Promise.
- **Job control on the same buffer**: `markStopped` / `waitWhileStopped` / `continueStopped` park a stopped process until SIGCONT. `setCaughtSignals` / `catchesSignal` publish a bitmask of the signals a process handles, so the kernel knows what to do with a signal that arrives while the process is blocked in a syscall.
- **RPC** (`rpc.ts`): `RpcEndpoint<Local, Remote>` is typed request/response over any `MessagePort`-like object. Messages are `{t:'rpc:req', id, m, a}` and replies are matched by id; `callTransfer` and `withTransfer` move buffers and streams instead of cloning them. It carries controller ↔ kernel and service worker ↔ kernel traffic.
- **Message contracts**: `instance-rpc.ts` (`InstanceRpc`, `InstanceEvents`, the handshake, signal tables like `SIGNAL_NUMBERS` and `STOP_SIGNALS`), `process-messages.ts` (`ProcessToKernel`, `KernelToProcess`, net messages, `BUILTIN_MARKER`), `http-rpc.ts`, `preview-rpc.ts`, and `stat.ts` (fixed binary `StatLayout`).

### @clientvm/vfs: the filesystem

`MemoryVfs` is a synchronous, in-memory filesystem with Linux semantics, owned by exactly one kernel. Memory comes first and OPFS is only write-behind persistence (ADR 0004), so a syscall never waits on storage.

- **Inodes** (`inode.ts`): a `Map<ino, Inode>` of file, dir and symlink inodes with `mode` (Linux `S_IF*` bits), `nlink`, four timestamps and an `epoch`. Directories map names to inode numbers, so hard links and `rename` are cheap. Open flags use Linux values (`O_CREAT = 0o100`, `O_APPEND = 0o2000`, …).
- **Path walking**: paths must be absolute (callers resolve against cwd). `..` follows the physical parent. Symlinks are followed up to 40 hops (`ELOOP` after that), and trailing-slash rules match Linux (for example `EISDIR`/`ENOTDIR`). Reads do not update atime (noatime).
- **Copy-on-write snapshots**: `snapshot()` is O(inodes). It freezes the inode map and bumps the VFS epoch. Any inode whose epoch is older than the current one may be shared with a snapshot, so it is cloned before its first mutation. File data is shared until written. `MemoryVfs.fromSnapshot()` forks a snapshot within the same kernel.
- **Limits**: `VfsLimits.quotaBytes` counts file contents plus per-inode overhead in the live tree, and `maxInodes` caps the inode count. Writes past either fail with `ENOSPC`.
- **fd-level API**: `open`/`retain`/`release` reference-count inodes, so an unlinked file stays readable while open. `readAt`, `writeAt` (with append) and `ftruncate` back the kernel's fd table.
- **Watchers** (`watch.ts`): `watch(path, {recursive}, listener)` emits `FsEvent`s on mutation, for `fs.watch`, Vite HMR, `Instance.fs.watch` and live mounts.
- **Images** (`image.ts`): `exportImage` / `importImage` serialise a snapshot with the codec, with file contents moved into a blob section. This is how `fork()` moves a filesystem to a new origin and how presets are cached.
- **Persistence** (`persistence.ts`, `opfs-backend.ts`): `Persister` marks itself dirty on every mutation and flushes after a 250 ms debounce. The store is content-addressed under `clientvm/v1/` in the instance origin's OPFS: `HEAD` (generation), `checkpoint-<gen>` (inode table in 500-inode parts) and `blobs/<sha256>`. A flush writes blobs, then the checkpoint, then `HEAD`, then garbage-collects, so a crash always leaves a complete checkpoint. `acquireStoreLock` (Web Locks, `ifAvailable`) keeps a persistent instance to one tab; a second tab gets `EBUSY`.

### @clientvm/process: the worker bootstrap

`process` is a thin, runtime-agnostic shell around a process worker. It knows nothing about Node: sandbox-host injects a `RuntimeTable` (`{ node: nodeRuntime, sh: shellRuntime, ls: …}`), which keeps the `js`, `builtin` and future `wasi`/`vm` tiers pluggable.

`startProcessWorker(scope, runtimes)` works in four steps:

1. It binds `postMessage` once, because user code may overwrite the global, and waits for the kernel's `init` message (pid, argv, env, cwd, channel SAB, syscall mode, stdin state, optional TTY).
2. It builds a `ProcessContext`: a `SyscallClient` over the SAB, `stdout`/`stderr` that post byte chunks, a pushable `stdin`, `send` / `onMessage` for async kernel traffic, `tty`, `onSignal` and `catchSignals`.
3. It posts `ready` and looks up `runtimes[argv[0]]`. The kernel has already resolved the command to a runtime name. An unknown name exits with 127.
4. It awaits the runtime and posts `exit` with the returned code. Throwing `ExitSignal` sets the code; an uncaught error prints its stack and exits 1.

While the runtime runs, the worker also answers the kernel's CPU-watchdog `ping` with `pong`, delivers `signal` messages to handlers (default action: exit with 128 + signal number), reports `stopped` for job control and forwards TTY mode changes. `bench.ts` is a built-in `clientvm-bench` runtime that measures syscall latency.

### @clientvm/kernel: one instance's operating system

The `Kernel` class runs in the instance's kernel worker and owns all of the instance's mutable state. `worker-entry.ts` (`startKernelWorker` / `serveInstance`) boots it from seed directories, a filesystem image, a snapshot or a persisted store, then serves `InstanceRpc` to the controller over the transferred port. Requests that arrive during boot wait for it.

**Process lifecycle** (`kernel.ts`, `Kernel.spawn` → `start`):

1. Enforce `maxProcesses`: beyond it, spawn throws `EAGAIN`.
2. Resolve `argv[0]` with `resolveCommand` (below). The default cwd is `/home/user`.
3. Assign a pid and a process group: a new group, or the parent's group for a child. Attach the controlling terminal, either a new `Terminal` for `spawn(..., { pty })` or the one inherited from the parent.
4. Allocate a 256 KiB channel SAB, a fresh `FdTable`, and a `SyscallServer` whose handler is `createSyscallHandler(vfs, fds, { spawnSync, readOnly: mounts })`.
5. Create the process worker (the factory is injected by sandbox-host), attach it to the net stack, start the CPU watchdog, and post `init`.
6. On exit, release fds and watches, kill all descendants (like a signal to the process group) and resolve the `exit` promise.

**Command resolution** (`commands.ts`): commands are files, as with `execve`. Built-in runtimes are marker files in `/usr/local/bin` containing `#!/clientvm/builtin <name>`. `/bin/sh`, `/bin/bash` and `/usr/bin/env` are installed as well. `resolveCommand` does the `PATH` lookup (default `/usr/local/bin:/usr/bin:/bin`), checks exec bits and follows shebang interpreters up to 4 levels deep. That is why `node_modules/.bin` symlinks and `#!/usr/bin/env node` scripts just work. Errors are Node-shaped `ENOENT`/`EACCES`/`ENOEXEC`. `DEFAULT_ENV` sets `HOME=/home/user`, `USER=user`, `SHELL=/bin/sh`, `LANG=C.UTF-8` and `ESBUILD_BINARY_PATH` to the WASM launcher.

**Syscall dispatch** (`dispatcher.ts`): maps the opcodes onto `MemoryVfs` calls for one process. Arguments arrive codec-encoded and are validated, because process code is untrusted. Writes under a read-only mount fail with `EROFS`, and `SPAWN_SYNC` runs a child while the caller blocks (output capped at 64 MiB, like Node's `maxBuffer`).

| Module | What it does |
| --- | --- |
| `fd-table.ts` | Per-process fd table starting at fd 3, `DEFAULT_MAX_OPEN_FILES = 1024` (`EMFILE` beyond it) |
| `devices.ts` | `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` as character devices (64 KiB per read) |
| `pty.ts` | Pseudo-terminal line discipline: canonical mode with a 4096-character line limit, echo, erase/kill/werase, `^C` → SIGINT, `^\` → SIGQUIT, `^Z` → SIGTSTP, `^D` → EOF; raw mode; window size and SIGWINCH (ADR 0017) |
| `net.ts` | `NetStack`: virtual ports for `listen`/`connect`, ephemeral ports from 32768, HTTP relayed to the owning process as messages, raw byte sockets linked end to end, hop-by-hop headers stripped |
| `http.ts` | `HttpRouter`: virtual port → server, open/close callbacks that drive `onPortOpen`, a 500-entry network log; `staticHandler` serves VFS files without lexical escape from its root |
| `module-server.ts` | Serves `/__clientvm/fs/<path>` module requests from the service worker: resolves specifiers with Node's ESM algorithm, rewrites them to module URLs, and wraps CommonJS as ES facades whose named exports come from `cjs-module-lexer` (WASM) (ADR 0006, 0009) |
| `mailbox.ts` | The kernel inbox at `http://mailbox.internal/`: `GET /`, `POST /send/<to>`, `GET /recv?timeout=` (≤ 5 min wait); at most 1,000 messages / 8 MiB queued |
| `mounts.ts` | `ReadOnlyMounts`: mirror trees of another instance's directory or a snapshot; mutations under them are rejected |

**Signals and limits.** `kill` delivers a signal to the process. If no handler takes it within `SIGNAL_GRACE_MS = 1000`, the worker is terminated; SIGKILL, SIGPIPE and SIGXCPU are immediate. A process blocked in a syscall gets an uncaught signal's default action at once, using the `CAUGHT` bitmask in its channel. Stops park the process on the channel's `STOPPED` slot until SIGCONT. The CPU watchdog pings each process every `clamp(maxCpuMs / 4, 20, 250)` ms. Time spent blocked in a syscall or stopped does not count. A process that runs JavaScript for `maxCpuMs` without answering is killed with SIGXCPU (exit 152).

### @clientvm/node-compat: the `node` runtime

The largest package (~17,400 lines) is the Node.js 24 environment a `js` process runs in. `process.version` reports `v24.11.0`. `nodeRuntime` (`node-main.ts`) is the `Runtime` that `node` resolves to. It parses Node's CLI (`-e`, `-p`, `-c`, `--input-type`, `-v`; V8 tuning flags are accepted and ignored), builds the core modules, installs Node's globals, and loads the entry as CommonJS or ESM.

**Core modules.** `builtins.ts` wires each module from shared deps: one `fs`, `path`, `process`, `console`, event loop and `ProcessContext` per process. Most modules are shims written in TypeScript. Some are vendored from upstream to match Node exactly:

| Group | Modules | How |
| --- | --- | --- |
| Filesystem | `fs`, `fs/promises` | Sync calls are syscalls over the SAB; callback and promise forms wrap them. `fs.watch` uses kernel watch messages |
| Data | `buffer`, `string_decoder`, `querystring`, `url`, `punycode` | `Buffer` follows Node's `FastBuffer` design; `punycode` and `path` are Node 24.11's own `lib/*.js`, vendored unmodified (ADR 0015) |
| Core | `events`, `util`, `assert`, `console`, `timers`, `os`, `process`, `async_hooks`, `diagnostics_channel`, `readline`, `v8`, `inspector`, `test` | TypeScript shims, tested by differentials against real Node |
| Streams | `stream`, `stream/promises`, `stream/web` | Node's own implementation via vendored readable-stream 4.8 (ADR 0010) |
| Compression, crypto | `zlib`, `crypto` | zlib on vendored pako 2.1 (ADR 0007); crypto on WebCrypto plus TS hashes |
| Processes | `child_process`, `worker_threads` | Each child or worker thread is a new kernel process (its own Web Worker) linked by a `MessagePort`; `spawnSync` is the `SPAWN_SYNC` syscall; IPC for `fork` |
| Network | `http`, `https`, `net`, `dns`, `tls`, `http2` | Servers listen on kernel virtual ports; clients use `fetch` (CORS applies off-instance); `http2` and TLS sockets are stubs |
| Other | `wasi`, `tty`, `module`, `perf_hooks` | WASI preview1 over the process's `fs`, matching uvwasi's errno order |

**Event loop** (`event-loop.ts`): Node's liveness rule. The process exits when no *referenced* handle is left. Timers, children, stdin while read, watchers, servers and in-flight fetches are handles, and each can be `unref()`'d. Promise-only work does not keep the process alive.

**Module loading** (`module/`):

- `resolve.ts`: the CommonJS resolver (`node_modules` walk, `exports`/`imports` maps, conditions, self-reference, `NODE_PATH`), with a `PackageJsonCache`.
- `cjs-loader.ts`: Node's `Module` (`require.cache`, `require.extensions`, `_load`, `_resolveFilename`, `_compile`). `require()` of an ES module goes through `esm-to-cjs.ts`, a source rewrite that keeps line numbers and live bindings.
- `esm-resolve.ts` + `esm-runtime.ts`: real ES modules load with the browser's native `import()` from `/__clientvm/fs/<path>`. The kernel's module server resolves specifiers and serves CJS facades. Top-level await, cycles, JSON imports and `import.meta` work (ADR 0006).
- `lexer.ts`: an ESM lexer, diffed against es-module-lexer on 793 files.

**Package managers** (`npm.ts`, `pnpm.ts`): `npm` and `pnpm` are runtimes that, on first use, download the unmodified release tarball (npm 11.6.1, pnpm 10.34.7), verify its pinned SHA-512 and unpack it into `/usr/local/lib/node_modules`. Then they run it like any Node program (ADR 0012). `CLIENTVM_NPM_TARBALL` / `CLIENTVM_PNPM_TARBALL` override the source URL.

**WASM stand-ins** (`standins.ts`, ADR 0013): native addons cannot run. When a project reaches for esbuild, rollup, rolldown, lightningcss or Tailwind's oxide, the official WebAssembly build of the *same version* is installed through npm (registry integrity-checked) into `/usr/local/lib/clientvm/standins` and used instead. The CJS loader's `.node` handler and resolver fallback point at it, and `ESBUILD_BINARY_PATH` points at a launcher. rolldown's napi-rs WASI build runs on `node:wasi` + `worker_threads`. Any other native addon fails with `ERR_DLOPEN_FAILED`.

### @clientvm/shell: `sh`, `bash` and the Linux commands

One TypeScript interpreter serves both `sh` and `bash`, and its output is diffed against real bash in CI (ADR 0011). It is the runtime behind `Instance.exec`, `child_process` with `shell: true`, npm scripts and the interactive terminal.

- **Parser** (`parser.ts`, `ast.ts`): builds a POSIX AST with pipelines, `&&` `||` `;` `&`, redirections and here-docs, subshells and groups, `if`/`for`/`while`/`until`/`case`, functions, and bash extensions like `[[ ]]` and arrays. `arith.ts` evaluates `$(( ))` and `let`; `pattern.ts` compiles glob and `case` patterns.
- **Interpreter** (`shell.ts`, `ShellState`): expansion (parameters, command substitution, arithmetic, field splitting, globbing against the VFS), exit codes, `set -e`/`-u`/`-x`/`-o pipefail`, traps and background jobs. Pipelines are connected by in-memory `Pipe`s (`io.ts`) with back-pressure and `BrokenPipe` (SIGPIPE semantics).
- **In-process vs spawned** (`runtime.ts`): a command runs inside the shell's own worker when `PATH` resolves to its marker file in `/usr/local/bin`. This applies to builtins and every command in `COMMANDS`, and saves a worker start per command. Anything else (`node`, scripts, `.bin` shims) is spawned through the kernel with `createSpawner`, and output the shell does not redirect is inherited directly. Every command is also exported as a standalone runtime (`commandRuntime`), so a Node program can spawn `ls` or `grep` directly.
- **Builtins** (`builtins.ts`): `cd pwd echo printf test [ true false export readonly unset set shopt shift exit return break continue local declare typeset read eval source . exec command type hash wait jobs fg bg trap umask let getopts alias unalias pushd popd dirs history times builtin`.
- **Interactive mode** (`interactive.ts`): `bash -i`, or `sh`/`bash` with no script when stdio is a terminal. It provides PS1/PS2 prompts, raw-mode line editing (`node-compat`'s `line-editor.ts`), history in `~/.bash_history`, Tab completion, Ctrl+C that cancels the line without ending the shell, and job control (Ctrl+Z, `fg`, `bg`, finish notices).

The commands in `commands/`:

| File | Commands |
| --- | --- |
| `files.ts` | `ls cat cp mv rm mkdir rmdir touch ln chmod stat readlink realpath mktemp basename dirname` |
| `text.ts`, `grep.ts`, `sed.ts` | `head tail wc sort uniq cut tr tee rev seq yes xargs`, `grep egrep fgrep` (POSIX regex translated by `regex.ts`), basic `sed` |
| `find.ts`, `diff.ts`, `test.ts`, `echo-printf.ts` | `find`, `diff`, `test [`, `echo printf` |
| `archive.ts` | `tar gzip gunzip zcat` |
| `curl.ts` | `curl` over `fetch` (CORS applies) |
| `git.ts` | `git` on isomorphic-git, fetched and integrity-checked on first use. Objects are byte-compatible with real git; remotes need `GIT_CORS_PROXY` (ADR 0014) |
| `misc.ts` | `env printenv which pwd date sleep uname hostname id whoami nproc clear true false` |

`awk` is deferred past v1.

### @clientvm/sandbox-host: the static deployment

A private Vite app (`pnpm --filter @clientvm/sandbox-host build` → `dist/`) that is deployed once and served at every `*.<sandbox-domain>` subdomain. This is where the libraries are composed into real browser entry points. Everything it serves lives under `/__clientvm/`; any other path on an instance origin belongs to the instance's own virtual servers.

| File | Served as | Role |
| --- | --- | --- |
| `instance.ts` | `/__clientvm/instance.html` on `<id>.<sandbox-domain>` | Handshake with the controller, registers the service worker, waits until it controls the page, *then* starts the kernel worker, so every process worker inherits SW control. Reconnects the SW when it restarts (`sw-reconnect`) |
| `kernel.worker.ts` | Kernel worker | `startKernelWorker(self, { commands, createProcessWorker, measureMemory })`. Registers the runtime names (`node npm npx pnpm pnpx clientvm-esbuild clientvm-bench` + every shell command) as marker files |
| `process.worker.ts` | Each process worker | `startProcessWorker(self, { ...shellRuntimes(), node, npm, npx, pnpm, pnpx, 'clientvm-esbuild', 'clientvm-bench' })`; this table must match the kernel's list |
| `sw.ts` | `/__clientvm/sw.js`, scope `/` | On an instance origin: forwards module loads (`/__clientvm/fs/...`) and other requests to the kernel. On a port origin: forwards every request to that virtual port, injects the WebSocket shim into HTML pages, and tunnels its sockets. Only trusted code runs in it |
| `port.ts` | `/__clientvm/port.html` on `<id>-p<port>.<sandbox-domain>` | Bridge page the controller embeds per open port; registers that origin's SW and hands it the channel to the kernel (ADR 0008) |
| `ws-shim.ts` | Injected first module script in previews | Service workers cannot see WebSockets, so this replaces `WebSocket` for same-origin and `localhost` URLs with an RFC 6455 client over a byte tunnel through the SW |
| `agent.ts` | Injected into previews | The driveable-preview agent: console capture, DOM outline with `[ref=eN]` targets, click/type/press, `waitFor`, `evaluate`, screenshots via SVG `foreignObject` |
| `host.ts` | Dev only | Example host app and e2e harness on a plain, non-isolated origin, with instances on `http://<id>.localhost:<port>` |

The deployment must send `Document-Isolation-Policy: isolate-and-require-corp`, COEP `require-corp`, CORP `cross-origin`, and a CSP `frame-ancestors` for the app origin on every response, plus `Service-Worker-Allowed: /` on the SW script. It must use a separate registrable domain with no cookies. `vite.config.ts` applies these headers to `*.localhost` in dev, and `clientvm-check-sandbox` (this package's bin; `scripts/check-sandbox-headers.mjs` in a checkout) checks a real deployment. The package publishes `dist/__clientvm` and that bin only.

### @clientvm/clientvm: the controller and public API

The only package a host app needs. `createClientVM(options)` returns a `ClientVM` that creates, finds and lists instances. It runs on the host page, never runs instance code, and depends only on `protocol`, so it bundles no kernel code. The public types live in `types.ts` and are documented in `docs/interfaces.md`.

```ts
import { createClientVM } from '@clientvm/clientvm'

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` })
const instance = await vm.createInstance({ preset: 'vite-react-ts' })
const result = await instance.exec('npm run build')
instance.onPortOpen((port, url) => showPreview(url))
```

**Options**: `sandboxOrigin(id)` (required), `instancePath` (default `/__clientvm/instance.html`), `container` (default `document.body`), `bootTimeoutMs` (default 15000), `heartbeatMs` (default 5000), `presetStore`.

**Instance surface**: `fs` (`readFile writeFile readdir stat mkdir rm rename symlink watch mount unmount`), `spawn` → `Process` (streaming `stdin`/`stdout`/`stderr`, `kill`, `resize`, `exit`), `exec` (`sh -c` with `cwd`, `env`, `stdin`, `timeoutMs`), `onProcess`, `onPortOpen`/`onPortClose`, `openPreview`, `networkLog`, `mailbox`, `snapshot`, `fork`, `createChild`, `grant`/`revoke`/`capabilities`, `measureMemory`, `flush`, `destroy`.

| Module | Responsibility |
| --- | --- |
| `connect.ts` | Creates the hidden iframe and runs the handshake. The page posts `hello`; the controller accepts it only from that iframe's window at the exact instance origin, checks the page is cross-origin isolated, then posts `connect` with a `MessagePort` targeted at that origin. Also embeds the port bridge page for each open port |
| `controller.ts` | `ClientVM` / `Instance` implementations over `RpcEndpoint`; serves `ControllerRpc` (`mailboxSend`, `netFetch`) back to each kernel with that instance's capabilities; heartbeat: a kernel silent for 4 intervals is declared crashed (`ERR_INSTANCE_CRASHED`, processes exit with SIGKILL) |
| `validate.ts` | Shape-checks every value an instance sends, including replies to the controller's own requests. The instance origin runs hostile code |
| `capabilities.ts` | The capability table, which kernels never see. An instance may grant what is about itself, or delegate what it holds; a child gets no more than its parent could grant |
| `rate-limit.ts` | Token buckets per instance: mailbox 200/s (burst 400), cross-instance fetch 100/s (burst 200), 32 fetches in flight; beyond that, `ERR_RATE_LIMITED` |
| `process.ts` | Controller-side `Process`. Unread output is buffered up to 8 MiB per stream, then dropped with a note |
| `process-log.ts` | Backs `onProcess`: spawn/output/exit events, replaying the last 100 processes (256 KiB output each) to new listeners. `tag` labels stay on the host |
| `presets.ts` | Builds and caches preset images (ADR 0018, see Multi-instance below) |
| `preview.ts` | `openPreview(port)`: iframe on the port origin plus an RPC channel to the injected agent (10 s agent timeout, 30 s per call, 1,000 console entries kept) |
| `errors.ts` | `ClientVMError` with a `code` (`ERR_NOT_ISOLATED`, `ERR_BOOT_TIMEOUT`, `ERR_NO_CAPABILITY`, `ERR_INVALID_MESSAGE`, …); errors from inside an instance keep their errno code (`ENOENT`, `EAGAIN`) |

### @clientvm/agent-api: tools for an LLM agent

`createAgentTools({ instance, onSpawn? })` turns one instance into a tool set. Its `definitions` are `{ name, description, input_schema }`, the shape LLM tool-use APIs take, and `call(name, input, { tag })` dispatches a tool and returns content blocks (`text`, or base64 PNG `image`). Processes a tool starts are tagged `{ source: 'agent', tool, ... }`, so terminals can tell agent commands from user commands. It has zero runtime dependencies beyond `clientvm`.

| Tools | What they do |
| --- | --- |
| `read_file`, `write_file`, `edit_file`, `list_dir`, `delete_path` | Filesystem access. `edit_file` replaces an exact, unique string; `read_file` pages by line and truncates long files in the middle |
| `exec` | A shell command to completion: exit code, stdout, stderr. Default timeout 2 minutes |
| `start_process`, `read_console`, `stop_process`, `list_processes` | Background processes (dev servers) with buffered output, plus open ports and preview URLs |
| `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_wait`, `preview_screenshot`, `preview_console` | Drive the app's preview through the injected agent: text outline with `[ref=eN]` refs, input, waits, PNG screenshots, console errors |
| `read_network_log` | HTTP requests the instance served |
| `send_message`, `read_messages` | The mailbox (sending needs a `channel` capability) |
| `spawn_instance`, `grant_capability` | Child instances (needs `spawn-instance`) and grants for messaging, ports (`http://<name>.internal:<port>/`) or read-only mounts |

### @clientvm/terminal: watching and driving an instance

This package has no terminal-emulator dependency. It writes to anything with an xterm.js-compatible `write()` (ADR 0016).

- `createActivityFeed(instance)`: the commands an instance runs as immutable `CommandBlock` snapshots, with `subscribe`/`getSnapshot` shaped for React's `useSyncExternalStore`.
- `attachActivityView(term, instance)`: writes a `$` line per command, its output (labelled when concurrent processes interleave), and its exit status and run time. Recent history is replayed first.
- `attachShell(term, instance)`: runs `bash -i` on a kernel pseudo-terminal. Keys go to the shell, output is drawn, and resizes arrive as SIGWINCH; `dispose()` hangs up.
- `createSanitizer()`: process output is hostile but drawn by the host page's terminal. CSI sequences (colours, cursor) pass through, but OSC 52 (clipboard), OSC 8 (links) and DCS/APC are stripped; only window titles (OSC 0/1/2) are kept.
- `OutputOptions`: drawing throttled to once per frame with a bounded backlog, `linkPorts` turns the instance's own port URLs into preview links, and `persist` keeps scrollback in `sessionStorage` across reloads.
- `displayCommand`, `stripAnsi`: helpers to show a command line the way a person reads it.

## How it works end to end

Five traces through the stack show how the packages cooperate.

### 1. `vm.createInstance()`

1. The controller (`clientvm`) picks an id and creates a hidden iframe at `sandboxOrigin(id) + /__clientvm/instance.html`.
2. The instance page (`sandbox-host/instance.ts`) posts `hello`. The controller accepts it only from that iframe's window and origin, checks `crossOriginIsolated` (granted by Document-Isolation-Policy), and replies `connect` with a `MessagePort`.
3. The page registers `/__clientvm/sw.js` and waits until the service worker controls it. Only then does it start the kernel worker and hand it the port and boot options.
4. The kernel boots `MemoryVfs` from seed directories, a `FileTree`, a snapshot or image (`fs.from`, `preset`, `fork`), or a persisted OPFS store. It installs `/dev` and the marker files in `/usr/local/bin`, then serves `InstanceRpc`.
5. The controller starts the heartbeat and returns the `Instance`. If boot takes longer than `bootTimeoutMs` (15 s), it rejects with `ERR_BOOT_TIMEOUT`.

### 2. A synchronous `fs.readFileSync('x')`

1. node-compat resolves `x` against the process cwd and encodes `[path]` with the codec.
2. `SyscallClient.call(Op.READ_FILE, bytes)` writes the header and payload into the process's SAB, sets `STATE = REQUEST`, notifies, and blocks in `Atomics.wait`.
3. The kernel's `SyscallServer`, parked in `Atomics.waitAsync`, wakes. The dispatcher validates the arguments, checks mounts and calls `vfs.readFile`.
4. The kernel writes the response, or sets `ERRNO`, then sets `STATE = RESPONSE` and notifies. A response larger than 256 KiB streams in chunks via `RESPONSE_MORE`.
5. The client copies the bytes out (never aliasing shared memory) and returns a `Buffer`, or throws a Node-shaped `SystemError` (`ENOENT`, …).

### 3. `instance.exec('ls src | grep .tsx > out.txt')`

1. The controller sends `spawn(['sh', '-c', line])` over RPC. `exec` is built on `spawn`, so the output also streams to `onProcess` listeners.
2. The kernel resolves `sh` to its marker file, allocates a pid, channel, fd table and worker, and posts `init`. The process worker runs `shellRuntime`.
3. The shell parses the line. `ls` and `grep` resolve to marker files, so both run *in-process* in the shell worker, connected by an in-memory `Pipe`. The redirect opens `out.txt` through the `OPEN`/`WRITE` syscalls.
4. If a stage were `node script.js`, the shell would spawn it through the kernel as a child in the same process group, sharing the terminal and inherited stdio.
5. The exit code travels kernel → controller, and `exec` resolves `{ code, stdout, stderr }`. `timeoutMs` sends SIGTERM to the shell and everything it started.

### 4. `npm install`

1. `npm` resolves to the `npm` runtime. On first use it fetches `npm-11.6.1.tgz` from the registry, checks the pinned SHA-512, and unpacks it to `/usr/local/lib/node_modules/npm` with node-compat's `tar` and `zlib`.
2. The unmodified npm CLI then runs on node-compat. Registry metadata and tarballs come over CORS `fetch` (the npm registry allows it), integrity is checked by npm itself, and files land in the VFS through ordinary `fs` syscalls.
3. Lifecycle scripts and bin links work because scripts run through `/bin/sh` and `.bin` symlinks resolve like `execve`.
4. When a dependency later reaches for a native package (for example `@rollup/rollup-linux-x64-gnu`), the resolver fallback installs the matching WASM stand-in on first use.

### 5. `npm run dev` → Vite preview with HMR

1. Vite's Node server calls `http.createServer().listen(5173)`. node-compat registers the virtual port with the kernel's `NetStack`, and `HttpRouter` reports it open.
2. The controller embeds `/__clientvm/port.html` on `https://<id>-p5173.<sandbox-domain>/`, links that origin's service worker to the kernel, and fires `onPortOpen(5173, url)`.
3. The host loads `url` in an iframe. Each request goes from the port-origin SW to the kernel router to the Vite process as relay messages, and the response streams back as a transferred `ReadableStream`.
4. The SW injects `ws-shim.js` into HTML, so Vite's HMR WebSocket becomes a byte tunnel through the SW to the server's `upgrade` handler.
5. When the agent edits a file, the VFS watcher fires, Vite's `fs.watch` sees it and pushes an HMR update over the tunnel, and React Fast Refresh swaps the module.

## Multi-instance

Instances never talk to each other directly. Every cross-instance interaction goes through the controller, which checks it against a capability table the kernels never see (docs/phase4-plan.md).

**Capabilities**

| Capability | Lets the holder… | Owner who can grant it |
| --- | --- | --- |
| `{ kind: 'channel', peer }` | Send mailbox messages to `peer` | `peer` |
| `{ kind: 'net', peer, ports? }` | Reach `http://<peer>.internal:<port>/` (all ports or the listed ones) | `peer` |
| `{ kind: 'mount', from, path, readOnly }` | Mount `from`'s subtree at or under `path` | `from` |
| `{ kind: 'spawn-instance', limits? }` | Create children (`fork`, `createChild`, `createInstance({ parent })`) within `limits` | Only the host or a holder |

The host can grant anything (`ClientVM.grant`, or `InstanceOptions.capabilities`). An instance can grant a capability over itself, or delegate one it holds; delegated `spawn-instance` limits must be at least as strict. A child never gets more than its parent could give. The host can revoke anything; an instance can revoke only grants over itself.

**Mailbox.** `instance.mailbox.send(to, msg)` needs `channel`. Messages are JSON, at most 1 MiB, addressed by name or id. They are delivered to host listeners and to the target kernel's inbox (bounded at 1,000 messages / 8 MiB, oldest dropped first). Processes in any language use it over HTTP: `POST http://mailbox.internal/send/<to>` returns 202, 403 without the capability, or 429 when rate-limited. `GET /recv?timeout=<ms>` long-polls.

**Virtual network.** A `fetch`, `http.request` or `curl` in instance A to `http://B.internal:3000/` goes: process → A's service worker (`/__net/B/3000/…`) → A's kernel → controller (checks A's `net` grant for B and the port) → B's kernel router → B's server. The response body is a `ReadableStream` transferred at each hop. Only HTTP is supported; there are no WebSocket upgrades or raw sockets between instances yet.

**Mounts.** A mount is a read-only *mirror*, not live remote access, because a sync syscall cannot wait on another kernel. The controller copies the source subtree into the target, marks it read-only (writes fail with `EROFS`, including through symlinks), and keeps it in step from the source's watch events. Snapshot sources are copied once. Writable mounts are rejected with `ERR_NOT_SUPPORTED`; merging back is deferred.

**Snapshot, fork, child.**

- `snapshot()` returns `"<instanceId>:<n>"`, a CoW snapshot held by the source kernel. It is gone when that instance is destroyed.
- `fork()` exports a filesystem image, transfers it to a new instance on a new origin, and imports it there. It needs `spawn-instance`, whose limits bound the child.
- `createChild(opts)` makes a child with a fresh filesystem, under the same capability rule.

**Presets** (ADR 0018). `createInstance({ preset: 'vite-react-ts' })` boots a ready project in `/home/user/app`, with `node_modules` and the WASM stand-ins already installed. The template lives in `packages/clientvm/presets/<name>/` with a pinned lockfile; `scripts/build-presets.mjs` embeds every directory there with a content hash. Presets: `vite-react-ts`, `vite-vanilla-ts`, `vite-vue-ts`, `vite-svelte-ts`, `tanstack-router-react`, `node-express`, `nuxt`. Vite presets warm up with `vite build`, `nuxt` with `nuxt build` (then `nuxt prepare`), `node-express` needs only `npm ci`.

1. The first request starts a hidden *builder* instance. It runs `npm ci`, then a throwaway `vite build` to fetch the stand-ins (~27 MB), then cleanup.
2. The controller exports the builder's image and destroys the builder. Concurrent requests share one build.
3. The image is stored in a `PresetStore`. By default this is the host origin's Cache Storage (cache `clientvm-presets`), keyed `<name>@<template hash>.<format>`. This is the only state ClientVM keeps on the host origin.
4. Every later instance boots from its own copy of the image.

## Security model

All agent-written code and package contents are treated as hostile. ClientVM keeps that code off the host app's origin and lets the browser's origin model do the isolation (`docs/security.md`, `docs/security-review.md`).

**What is protected**, in priority order: the host app origin (cookies, storage, credentials, DOM), other instances, the user's tab (memory, CPU), and the user's network position. **Adversaries**: agent-generated code (including prompt-injected code), malicious npm packages, and third-party scripts inside preview pages.

**Trust boundaries**

1. **Controller ↔ instance**: the handshake checks the exact window and origin on both sides, then everything flows over one `MessagePort`. The controller validates every value an instance sends (`validate.ts`), even replies to its own requests.
2. **Instance ↔ instance**: each instance has its own origin, and so its own storage, service worker, BroadcastChannel and kernel (ADR 0003). Cross-instance work needs a capability checked in the controller.
3. **Process ↔ kernel**: processes have no direct VFS access, only their own syscall channel. The kernel decodes every request defensively (`EINVAL` on malformed input, `ENOSYS` on unknown ops).
4. **Preview ↔ kernel**: app pages run on per-port origins, so preview code cannot touch the kernel's OPFS store or other ports. Instance ids cannot end in `-p<digits>`, which stops them colliding with a port origin.

**Key mitigations**

- A separate registrable sandbox domain with no cookies and no authenticated endpoints, `frame-ancestors` CSP, and Document-Isolation-Policy, so the host app needs no COOP/COEP (ADR 0005).
- Resource limits: `maxProcesses` (`EAGAIN`), `quotaBytes`/`maxInodes` (`ENOSPC`), 1024 fds per process, `maxCpuMs` (SIGXCPU), 8 MiB unread output per stream, a bounded `onProcess` replay, and controller rate limits. `maxMemoryMB` is accepted but not yet enforced.
- Terminal output sanitising (OSC 52/8 and DCS/APC stripped) and validated window sizes (1–10000).
- Supply chain: npm, pnpm and isomorphic-git are pinned by SHA-512, WASM stand-ins are integrity-checked by npm, and core packages have almost no runtime dependencies (`pako`, `cjs-module-lexer`, vendored readable-stream).
- Seeded fuzzing of the codec, tar reader, path, CJS resolver, VFS and shell parser.

**Accepted risks**: cross-origin isolation re-enables SAB and precise timers (Spectre class). Instance subdomains are same-site with each other unless the domain is on the Public Suffix List. Process code can `fetch` any CORS-enabled endpoint from the user's IP. A catastrophic regex only stalls its own process, and `exec`'s `timeoutMs` stops it. A compromised instance can do anything its own origin can, including lying about its own files and output, but it cannot reach the host app or other instances.

## Testing and quality

Compatibility is claimed only where it is tested. `docs/compatibility.md` is the matrix of record and lists each module as none, partial or full, with its test and known gaps. The suites:

| Suite | Where | What it proves |
| --- | --- | --- |
| Unit | `packages/*/src/*.test.ts` (Vitest) | Package internals: codec, RPC, syscall channel (real worker threads), VFS and snapshots, persistence, parser, PTY, dispatcher, capabilities, rate limits, presets, sanitizer |
| Differential vs real Node | `test/conformance/*-differential.test.ts` | Same inputs to ClientVM's module and to `node:*`, outputs diffed: buffer, crypto, events, fs, inspect, modules, path, readline, stream, tar, zlib, CJS and ESM resolution, and the lexer vs es-module-lexer |
| Shell differential | `test/conformance/shell-differential.test.ts` | Scripts run on real bash and on ClientVM's shell; stdout, stderr and exit codes diffed |
| Node's own tests | `test/conformance/node-tests/` (591 files from `test/parallel`, vendored unmodified, ADR 0015) + `test/e2e/node-tests.spec.ts` | The passing subset of Node's suite, run inside an instance |
| Fuzzing | `fuzz.test.ts`, `fs-random.test.ts` | Seeded runs over codec, tar, path, resolver, VFS ops and shell parser; `FUZZ_SEED` / `FUZZ_ITERATIONS` for longer runs |
| E2E (Playwright, Chromium) | `test/e2e/*.spec.ts` | Real browser, real origins: instances, fs, ESM/CJS, child processes, http, npm, pnpm, git, presets, previews, driveable preview, multi-instance, persistence, PTY, hosting headers |
| Golden projects | `test/fixtures/` | `vite-react` (Vite 6 + React 18), `vite8-react` (rolldown), `vite8-tailwind` (Tailwind 4), `express-ws` (Express 4 + ws 8), `drive-app` |
| Package smoke | `test/e2e/smoke-full.spec.ts`, `npm-top.json` (1,000 packages) | Install and import of the top npm packages, in its own workflow (`smoke-full.yml`) |
| Benchmarks | `test/e2e/bench.spec.ts` + `scripts/bench-gate.mjs` | Fails CI when a metric regresses past its allowed factor against `bench/baseline.json` |

Baseline numbers from `bench/baseline.json` (Chromium 141, CI runner): kernel boot 163 ms, instance create p50 134 ms, no-op syscall p50 30 µs, `stat` syscall p50 35 µs, spawn-to-ready p50 48 ms, `node -e 0` p50 57 ms, 10k-iteration shell loop 253 ms, full flush of 5,000 files 1.36 s, restore boot 0.97 s, 1.6 MB per instance.

**CI** (`.github/workflows/ci.yml`): `pnpm install --frozen-lockfile`, SPDX header check, lint, typecheck, Vitest, then Playwright e2e and the bench gate on Chromium. `release.yml` repeats those checks, verifies the tag matches the package version, and publishes to npm with provenance.

## Key decisions and glossary

The design is recorded in 18 ADRs under `docs/decisions/`. Each one maps to the package where it lives:

| ADR | Decision | Lives in |
| --- | --- | --- |
| 0001 | Target Node.js 24 LTS | `node-compat` |
| 0002 | Wake the kernel with `Atomics.waitAsync`, `postMessage` doorbell as fallback | `protocol`, `kernel` |
| 0003 | One kernel per instance, on the instance's own origin | `sandbox-host`, `clientvm` |
| 0004 | Memory-first VFS, OPFS write-behind persistence | `vfs` |
| 0005 | Document-Isolation-Policy for instance pages (host needs no COOP/COEP) | `sandbox-host` |
| 0006 | Native ES modules served by the instance service worker | `kernel` (module server), `node-compat` |
| 0007 | Vendor pako for `zlib` | `node-compat` |
| 0008 | One sub-origin per virtual port | `sandbox-host`, `clientvm` |
| 0009 | cjs-module-lexer for CommonJS named exports | `kernel` |
| 0010 | Vendor readable-stream for `stream` | `node-compat` |
| 0011 | Shell runs commands in-process; every command is also a runtime | `shell` |
| 0012 | Unmodified npm, fetched and verified on first use | `node-compat` |
| 0013 | WebAssembly stand-ins for native toolchain packages | `node-compat` |
| 0014 | `git` on isomorphic-git, fetched and verified on first use | `shell` |
| 0015 | Vendor Node's `lib/path.js` and passing `test/parallel` subset | `node-compat`, `test/` |
| 0016 | Process events and a dependency-free terminal package | `clientvm`, `terminal` |
| 0017 | Pseudo-terminals and signal delivery | `kernel`, `process`, `shell`, `terminal` |
| 0018 | Presets built once, cached on the host origin | `clientvm` |

**Glossary**

- **Instance**: a sandboxed machine (filesystem, processes, network, limits) with its own origin and kernel.
- **Controller**: the trusted broker on the host page (`createClientVM`).
- **Kernel**: the worker that owns an instance's state and serves syscalls.
- **Process**: a Web Worker running one runtime (`node`, `sh`, `ls`, …) with a pid and an fd table.
- **Runtime**: a function `(ctx: ProcessContext) => exitCode` registered under a command name.
- **Marker file**: `/usr/local/bin/<name>` containing `#!/clientvm/builtin <name>`, which tells the kernel a command is a built-in runtime.
- **Syscall channel**: the per-process `SharedArrayBuffer` for blocking calls.
- **Port origin**: `<id>-p<port>.<sandbox-domain>`, where a virtual server is previewed.
- **Capability**: a controller-checked grant for one cross-instance interaction.
- **Stand-in**: the official WebAssembly build that replaces a native package.
- **Preset**: a ready project image, built once and cached on the host origin.
- **Snapshot / image**: a CoW point-in-time view of a VFS / that view serialised for transfer.
