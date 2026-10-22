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
| `Instance.fs.mount`/`unmount` | done (4c): read-only mirrors of another instance's directory (kept in step from its watch events) or of a snapshot; needs a `mount` capability; writes under a mount fail with `EROFS`, including through symlinks; writable mounts reject with `ERR_NOT_SUPPORTED` |
| `Instance.spawn` → `Process` with streaming `stdout`/`stderr`, `stdin`, `kill`, `exit` | done. `stdin` writes reach the process (`process.stdin`, `fs.read(0)`); closing it sends EOF. Unread output is buffered up to 8 MiB per stream, then dropped with a note on that stream (5c) |
| `Limits.maxCpuMs` | done (5c): a watchdog pings each process; one that runs JavaScript for `maxCpuMs` without yielding (time blocked in syscalls does not count) is killed with `SIGXCPU` (exit 152) |
| `Limits.maxMemoryMB` | accepted, not enforced (open-questions.md) |
| `Instance.measureMemory()` | done (5c): bytes for the instance page and kernel worker via `performance.measureUserAgentSpecificMemory()` on the instance origin; process workers are not attributed by Chromium. Tracked by the benchmark gate |
| `Instance.snapshot()` → `"<instanceId>:<n>"` | done. Held by the source kernel; gone when it is destroyed |
| `Instance.createChild(opts)` | done (4e): a child instance with a fresh filesystem; needs `spawn-instance` like `fork` |
| `@clientvm/agent-api` `createAgentTools({ instance })` | done (4e): LLM tool definitions and a dispatcher ([agent-api.md](agent-api.md)). Since T1, `call(name, input, { tag })` tags the processes a tool starts with `{ source: 'agent', tool, ...tag }` |
| `Instance.fork()` | done: image export → new origin. Since 4a it needs a `spawn-instance` capability, whose limits bound the child's |
| `Instance.destroy()` | done |
| `Instance.exec` | done (3c): `sh -c` to completion with `cwd`, `env`, `stdin`, `timeoutMs` (SIGTERM to the shell and every process it started). Since T1 it runs on `spawn`, so its output streams to `onProcess` |
| `Instance.onProcess`, `SpawnOptions.tag`, `ProcessInfo`, `ProcessEvent` | done (T1, ADR 0016): spawn/output/exit of processes started with `spawn` or `exec`, replaying the last 100 (256 KiB of output each) to new listeners. `tag` is a host-side label, never sent to the instance |
| `@clientvm/terminal` | done (T1): `createActivityFeed`, `attachActivityView`, `createSanitizer`, `displayCommand`, `stripAnsi` ([terminal-plan.md](terminal-plan.md)) |
| `Instance.onPortOpen` | done (3d): fires for open and future virtual ports with the port's own origin, `https://<id>-p<port>.<sandbox-domain>/` (ADR 0008), once its service worker is linked |
| `Instance.onPortClose` | done (3d): fires when a reported port stops listening (its server closed or its process exited) |
| `InstanceOptions.name`, `Instance.name` | done (4a): a DNS label, unique among live instances; the instance's `<name>.internal` host name |
| `ClientVM.grant`/`revoke`, `Instance.grant`/`revoke`/`capabilities`, `InstanceOptions.capabilities` | done (4a): the controller's capability table. Instances grant what is about themselves or delegate what they hold; children get no more than their parent could grant (docs/phase4-plan.md) |
| `Instance.mailbox` | done (4a): `send` needs a `channel` capability; JSON values up to 1 MiB; delivery goes to host listeners and to the kernel inbox, which processes read at `http://mailbox.internal/` |
| `Instance.openPreview(port, opts)` → `Preview` | done (4d): an iframe on the port origin driven through the injected agent: `snapshot` (outline with `[ref=eN]` targets, optional HTML), `click`, `type`, `press`, `waitFor`, `evaluate`, `screenshot` (PNG via SVG `foreignObject`), `console` (captured from the first script of each page, across navigations), `navigate`, `reload`, `close` |
| `Instance.networkLog(since)` | done (4d): the last 500 requests served on virtual ports (method, path, status, time to headers, requesting instance) |
| `http://<name>.internal:<port>/` from processes | done (4b): needs a `net` capability for the peer (and port); HTTP only, responses stream |

Instances that crash (their renderer process dies) are detected by a heartbeat
(`ClientVMOptions.heartbeatMs`, default 5000; a kernel silent for four intervals is gone): the
instance is torn down, its processes exit with `SIGKILL`, and pending and later calls reject with
`ERR_INSTANCE_CRASHED`. At most 64 ports per instance get a port origin (bridge iframe); further
ports are not reported by `onPortOpen`.

Errors raised by the controller are `ClientVMError` with a `code` (`ERR_NOT_ISOLATED`, `ERR_INSTANCE_CRASHED`,
`ERR_BOOT_TIMEOUT`, `ERR_INSTANCE_PROTOCOL`, `ERR_DESTROYED`, `ERR_NO_CAPABILITY`,
`ERR_NO_INSTANCE`, `ERR_INVALID_CAPABILITY`, `ERR_INVALID_MESSAGE`, ...). Errors from inside an instance
keep the system error `code` (`ENOENT`, `EAGAIN`, ...).

## Internal interfaces (not public API)

- **Syscall channel** (`@clientvm/protocol`): `SyscallClient.call(op, bytes) → bytes` and
  `SyscallServer(sab, handler)`. Bytes in, bytes out, so it can be replaced by Rust/WASM if
  profiling demands.
- **Process runtime** (`@clientvm/process`): `type Runtime = (ctx: ProcessContext) => number | void
  | Promise<…>`. `ctx` provides `argv`, `env`, `cwd`, `syscall`, `stdout`, and `stderr`.
- **Instance RPC** (`@clientvm/protocol` `InstanceRpc` / `InstanceEvents`): what an instance kernel
  serves to the controller over its MessagePort, plus the handshake messages.
- **Controller RPC** (`ControllerRpc`): requests a kernel makes of the controller on the same
  port (`mailboxSend`, `netFetch`). They run with the calling instance's capabilities.
