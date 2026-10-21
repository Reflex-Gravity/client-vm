# Interfaces

The public API is declared in [`packages/clientvm/src/types.ts`](../packages/clientvm/src/types.ts)
and implemented by `createClientVM()` in [`controller.ts`](../packages/clientvm/src/controller.ts). Changes to that file must update this page and, if they
affect decisions, CLAUDE.md.

## Refinements over the CLAUDE.md §6 sketch

| Change | Why |
|---|---|
| `InstanceId` and `SnapshotId` are branded strings | Prevents mixing ids with names or paths at compile time |
| Added `Disposable`, `Signal`, `ProcessType`, `FileTree`, `Limits`, `InstanceInfo`, `DirEntry`, `Stat`, `FsEvent`, `MountSource`, `SpawnOptions`, `ExecOptions`, `ExecResult` | The sketch referenced them without defining them |
| `ProcessType = 'js' \| 'builtin' \| 'wasi' \| 'vm'` | Reserves the future tiers (§2: no CPU emulator in v1, but keep the interface) |
| `Limits.quotaBytes`, `Limits.maxCpuMs` | Per-instance budgets from the security model |
| `ExecOptions.timeoutMs`, `ExecOptions.stdin` | Agents need bounded, non-interactive exec |
| `MountSource` is a union of instance-dir and snapshot mounts | Mounting needs a source and a read-only flag that a capability can check |

## Implementation status (Phase 2b)

| API | Status |
|---|---|
| `createClientVM({ sandboxOrigin, instancePath?, container?, bootTimeoutMs? })` | done |
| `createInstance`, `getInstance`, `listInstances` | done. `id` + `fs.persist` reattach to persisted storage |
| `InstanceOptions.fs.persist`, `Instance.flush()`, `destroy({ purge })` | done (2c): write-behind OPFS persistence, one tab per persistent instance (`EBUSY` otherwise) |
| `InstanceOptions.fs.from` (`FileTree` or `SnapshotId`), `fs.quotaBytes`, `limits.maxProcesses` | done |
| `Instance.fs`: `readFile writeFile readdir stat mkdir rm rename symlink watch` | done (`watch` is recursive) |
| `Instance.fs.mount` | Phase 4 → `NotImplementedError` |
| `Instance.spawn` → `Process` with streaming `stdout`/`stderr`, `kill`, `exit` | done. `stdin` writes reject until node-compat reads stdin. Output is buffered without bound until read |
| `Instance.snapshot()` → `"<instanceId>:<n>"` | done. Held by the source kernel; gone when it is destroyed |
| `Instance.fork()` | done: image export → new origin |
| `Instance.destroy()` | done |
| `Instance.exec` | done (3c): `sh -c` to completion with `cwd`, `env`, `stdin`, `timeoutMs` (SIGTERM to the shell and every process it started) |
| `Instance.onPortOpen` | done (2d): fires for open and future virtual ports with a preview URL. Until `http.createServer` exists (Phase 3), ports are opened with the internal `serveStatic` |
| `Instance.mailbox`, `Instance.grant` | Phase 4 → `NotImplementedError` |

Errors raised by the controller are `ClientVMError` with a `code` (`ERR_NOT_ISOLATED`,
`ERR_BOOT_TIMEOUT`, `ERR_INSTANCE_PROTOCOL`, `ERR_DESTROYED`, ...). Errors from inside an instance
keep the system error `code` (`ENOENT`, `EAGAIN`, ...).

## Internal interfaces (not public API)

- **Syscall channel** (`@clientvm/protocol`): `SyscallClient.call(op, bytes) → bytes` and
  `SyscallServer(sab, handler)`. Bytes in, bytes out, so it can be replaced by Rust/WASM if
  profiling demands.
- **Process runtime** (`@clientvm/process`): `type Runtime = (ctx: ProcessContext) => number | void
  | Promise<…>`. `ctx` provides `argv`, `env`, `cwd`, `syscall`, `stdout`, and `stderr`.
- **Instance RPC** (`@clientvm/protocol` `InstanceRpc` / `InstanceEvents`): what an instance kernel
  serves to the controller over its MessagePort, plus the handshake messages.
