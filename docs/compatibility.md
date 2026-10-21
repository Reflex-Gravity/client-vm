# Compatibility matrix

ClientVM does not claim generic "Node compatibility". This page is the source of truth for what
works, how it is tested, and the known gaps.

- **Node target:** Node.js **24 LTS** (`process.version` = `v24.11.0`). See [ADR 0001](decisions/0001-node-24-target.md).
- **Browser:** Chromium only, cross-origin isolated (COOP `same-origin` + COEP `require-corp`).
  Verified on Chromium 156. Minimum version: TBD in Phase 2 (needs `Atomics.waitAsync`,
  module workers, nested workers, OPFS sync access handles).
- **Required frameworks (v1 goal):** Vite + React dev server with HMR, Express. Both are not yet
  working.

Status legend: **none** = not implemented · **partial** = subset, see gaps · **full** = matches Node for all tested behavior.

## Core modules

| Module | Status | Tested by | Known gaps |
|---|---|---|---|
| `fs` (sync) | partial | e2e fs differential vs real Node, fs differential + seeded random-op fuzz vs `node:fs` | Paths: `readFileSync writeFileSync appendFileSync readdirSync statSync lstatSync existsSync mkdirSync rmdirSync unlinkSync rmSync renameSync linkSync symlinkSync readlinkSync realpathSync(.native) accessSync chmodSync utimesSync truncateSync copyFileSync`. Fds: `openSync closeSync readSync writeSync fstatSync ftruncateSync`. Returns `Uint8Array`, not `Buffer`; only `utf8`; no `opendirSync`, `cpSync`, `watch` (VFS watchers exist, not yet exposed), `fchmod`/`futimes`, `fsync` |
| `fs` (callback / promises) | none | | |
| `path` | partial (posix full) | path differential vs `node:path.posix` | `win32` not provided |
| `util` | partial | inspect differential vs `node:util` | Only `format` and `inspect`. No `showHidden` (`%o`), colors, custom inspect symbol, Proxy detection, or getters option |
| `console` | partial | e2e spike | `table` prints like `log`. No `Console` class |
| `process` | partial | e2e spike | No EventEmitter (`on` is a no-op), no stdin, no signals. `memoryUsage` missing. `arch` reports `x64` |
| `timers` | partial | e2e spike | Process exit waits for timers. Pending promises (e.g. `fetch`) do not keep the process alive |
| module loading | partial | e2e spike | `require` of builtins only. No filesystem modules, no ESM, no `exports` maps |
| `buffer` | none | | |
| `events` | none | | |
| `stream` | none | | |
| `crypto` | none | | |
| `zlib` | none | | |
| `http` / `https` | none | | |
| `net` | none | | |
| `os` | none | | |
| `child_process` | none | | |
| `worker_threads` | none | | |
| `url` | none | | Global `URL` works (browser built-in) |
| `assert` | none | | |

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
