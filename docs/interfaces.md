# Interfaces

The public API is declared in [`packages/clientvm/src/types.ts`](../packages/clientvm/src/types.ts)
(types only until Phases 2–4 implement it). Changes to that file must update this page and, if they
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

## Internal interfaces (not public API)

- **Syscall channel** (`@clientvm/protocol`): `SyscallClient.call(op, bytes) → bytes` and
  `SyscallServer(sab, handler)`. Bytes in, bytes out, so it can be replaced by Rust/WASM if
  profiling demands.
- **Process runtime** (`@clientvm/process`): `type Runtime = (ctx: ProcessContext) => number | void
  | Promise<…>`. `ctx` provides `argv`, `env`, `cwd`, `syscall`, `stdout`, and `stderr`.
- **Kernel worker RPC** (`@clientvm/kernel` `KernelRpc`): `ping`, `run`, `writeFile`, `readFile`,
  `mkdir`. This is the spike surface. It becomes the instance API in Phase 2.
