# Compatibility matrix

ClientVM does not claim generic "Node compatibility". This page is the source of truth for what
works, how it is tested, and the known gaps.

- **Node target:** Node.js **24 LTS** (`process.version` = `v24.11.0`). See [ADR 0001](decisions/0001-node-24-target.md).
- **Browser:** Chromium only, cross-origin isolated (COOP `same-origin` + COEP `require-corp`).
  Verified on Chromium 156. Instance pages rely on `Document-Isolation-Policy` (host apps need no
  COOP/COEP), `Atomics.waitAsync`, and nested module workers. The exact minimum version is still to
  be pinned by testing older Chromium builds (see open-questions.md).
- **Required frameworks (v1 goal):** Vite + React dev server with HMR, Express. Both are not yet
  working.

Status legend: **none** = not implemented · **partial** = subset, see gaps · **full** = matches Node for all tested behavior.

## Core modules

| Module | Status | Tested by | Known gaps |
|---|---|---|---|
| `fs` (sync) | partial | e2e fs differential vs real Node, fs differential + seeded random-op fuzz vs `node:fs` | Paths: `readFileSync writeFileSync appendFileSync readdirSync statSync lstatSync existsSync mkdirSync rmdirSync unlinkSync rmSync renameSync linkSync symlinkSync readlinkSync realpathSync(.native) accessSync chmodSync utimesSync truncateSync copyFileSync`. Fds: `openSync closeSync readSync writeSync fstatSync ftruncateSync`. Returns `Buffer`; all Buffer encodings; fds accepted by `readFileSync`/`writeFileSync`; no `opendirSync`, `cpSync`, `watch` (VFS watchers exist, not yet exposed), `fchmod`/`futimes`, `fsync` |
| `fs` (callback / promises) | none | | |
| `path` | partial (posix full) | path differential vs `node:path.posix` | `win32` not provided |
| `util` | partial | inspect + events + modules differentials vs `node:util`, e2e | `format`, `inspect` (custom inspect, depth), `types`, `promisify`/`callbackify`, `inherits`, `deprecate`, `isDeepStrictEqual`, `parseArgs` (common cases), `debuglog`, legacy `isX`. No `showHidden` (`%o`), colors, Proxy detection, `MIMEType`, `TextEncoder` streaming options |
| `console` | partial | e2e spike | `table` prints like `log`. No `Console` class |
| `process` | partial | e2e | EventEmitter with `exit`, `beforeExit`, `uncaughtException`, `unhandledRejection`, `warning`; `emitWarning`, `hrtime`, `nextTick`, `memoryUsage`, `stdout`/`stderr` (minimal writables). No stdin data, signals, or `stream`-based stdio yet (3b). `arch` reports `x64` |
| `timers` | partial | e2e spike | Process exit waits for timers. Pending promises (e.g. `fetch`) do not keep the process alive |
| module loading | partial | e2e spike | `require` of builtins only. No filesystem modules, no ESM, no `exports` maps |
| `buffer` | full (tested surface) | Buffer differential vs `node:buffer` (thousands of cases: encodings, search, numeric reads/writes, errors), e2e | `Buffer` is a callable function sharing `FastBuffer.prototype`, as in Node. `Blob`/`File` are the browser's. No `transcode` for exotic encodings |
| `events` | full (tested surface) | events differential vs `node:events`, e2e | `EventEmitter` (callable for legacy `EventEmitter.call(this)`), `once`, `on`, captureRejections, errorMonitor, max-listener warnings. `EventTarget` helpers partial |
| `stream` | none | | |
| `crypto` | none | | |
| `zlib` | none | | |
| `querystring` | full (tested surface) | modules differential vs `node:querystring` | |
| `string_decoder` | full (tested surface) | modules differential | utf16le surrogate pairs split at an odd byte decode correctly (Node emits U+FFFD) |
| `timers/promises` | partial | | `setTimeout`, `setImmediate`, `scheduler` |
| `http` / `https` | none | | Virtual ports, the service-worker route and static serving exist (Phase 2); `http.createServer` is Phase 3 |
| `net` | none | | |
| `os` | partial | e2e | A fixed Linux identity (`hostname` `clientvm`, `x64`); CPU count from the browser. Memory figures are nominal |
| `child_process` | none | | |
| `worker_threads` | none | | |
| `url` | partial | url differential vs `node:url` | WHATWG `URL` (browser), legacy `parse`/`format`/`resolve`, `fileURLToPath`/`pathToFileURL`, `urlToHttpOptions`. `domainToUnicode` is identity |
| `assert` | partial | assert differential vs `node:assert` | All common assertions, strict mode, `AssertionError` shape. Diff-style messages for objects are simplified |

## CLI

| Command | Status | Notes |
|---|---|---|
| `node -e/-p/--eval/--print <code>` | partial | Runs in global scope with `require`, `module`, `exports` |
| `node <script.js>` | partial | CommonJS only, builtins-only `require` |
| `node` (REPL) | none | |
| shell and Linux commands | none | Phase 3 |
| `npm` / `npx` / `pnpm` | none | Phase 3 (real npm, unmodified) |

## Filesystem semantics

- Linux semantics are the reference (CI runs the differentials on Linux; a few macOS-divergent cases are skipped locally).
- Symlinks are followed with a 40-hop limit (`ELOOP`); `..` is resolved physically, as the kernel does.
- Hard links, unlinked-but-open files, `O_APPEND`/`O_EXCL`/`O_TRUNC`, and zero-filled holes behave as on Linux.
- No access time updates on reads (`noatime`). Every process runs as root: only execute permission is checked (`access(X_OK)`).
- Per-instance quotas (`quotaBytes`, `maxInodes`) fail with `ENOSPC`; per-process open files are capped at 1024 (`EMFILE`).

- `readdir` returns entries in sorted order (code-unit order). Linux ext4 returns hash order, so
  don't rely on order in tests.
- Paths are case-sensitive.
- Errors carry Linux errno values and Node's `code`, `errno`, `syscall`, and `path`.
