# API reference

The public API of `@clientvm/clientvm`, grouped by what you are trying to do. The types are
declared in [`packages/clientvm/src/types.ts`](../packages/clientvm/src/types.ts) and implemented
by `createClientVM()` in [`controller.ts`](../packages/clientvm/src/controller.ts); changes to
that file must update this page.

> [!NOTE]
> Everything listed here is implemented unless it says otherwise. The only accepted-but-not-enforced
> option today is `Limits.maxMemoryMB`.

## Create a controller

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });
```

| API | What it does |
|---|---|
| `createClientVM({ sandboxOrigin, instancePath?, container?, bootTimeoutMs?, heartbeatMs?, presetStore? })` | Creates the controller on your page. `sandboxOrigin` maps an instance id (or a port label `<id>-p<port>`) to its origin ([hosting](hosting.md)) |
| `vm.createInstance(opts)`, `vm.getInstance(id)`, `vm.listInstances()` | Boot, find and list instances. Passing an existing `id` with `fs.persist` reattaches to persisted storage |
| `vm.grant` / `vm.revoke` | Grant or revoke capabilities between instances from the host |

## Boot an instance

| Option | What it does |
|---|---|
| `fs.from` | Start from a `FileTree` or a `SnapshotId` |
| `preset: 'vite-react-ts'` | Start from a ready project in `/home/user/app`: one of `vite-react-ts`, `vite-vanilla-ts`, `vite-vue-ts`, `vite-svelte-ts`, `tanstack-router-react`, `node-express`, `nuxt` (`npm run dev` starts each), built once in a hidden instance and cached in your origin's Cache Storage ([ADR 0018](decisions/0018-presets-cached-on-host-origin.md)). `presetStore` (`cachePresetStore`, `memoryPresetStore` or your own) changes where. Unknown names, or a preset combined with `fs.from`, fail with `ERR_INVALID_PRESET`; a failed setup with `ERR_PRESET_BUILD` |
| `onPresetBuild` | Watch the hidden builder's process events (`npm ci`, warm-up build) while you wait on a preset build. Late joiners get the history replayed; not called when the image is already stored |
| `fs.persist`, `fs.quotaBytes` | Write-behind OPFS persistence (one tab per persistent instance, `EBUSY` otherwise) and a filesystem quota |
| `limits.maxProcesses`, `limits.maxCpuMs` | Process count, and CPU time: a process that runs JavaScript for `maxCpuMs` without yielding is killed with `SIGXCPU` (exit 152). Time blocked in syscalls does not count |
| `limits.maxMemoryMB` | Accepted, **not enforced** yet |
| `name` | A DNS label, unique among live instances: the instance's `<name>.internal` host name |
| `capabilities` | Capabilities granted at creation |

| Instance API | What it does |
|---|---|
| `instance.flush()` | Persist now (for `fs.persist` instances) |
| `instance.destroy({ purge })` | Tear down, optionally deleting persisted storage |
| `instance.measureMemory()` | Bytes used by the instance page and kernel worker (`performance.measureUserAgentSpecificMemory()`). Process workers are not attributed by Chromium |

## Read and write files

`instance.fs` mirrors the Node promise API on the instance's filesystem:
`readFile writeFile readdir stat mkdir rm rename symlink watch` (`watch` is recursive).

| API | What it does |
|---|---|
| `instance.fs.mount(path, source)` / `unmount` | Read-only mirrors of another instance's directory (kept in step from its watch events) or of a snapshot. Needs a `mount` capability. Writes under a mount fail with `EROFS`, including through symlinks; writable mounts reject with `ERR_NOT_SUPPORTED` |
| `instance.snapshot()` → `"<instanceId>:<n>"` | A copy-on-write snapshot, held by the instance's kernel and gone when it is destroyed |

## Run commands

| API | What it does |
|---|---|
| `instance.exec(commandLine, { cwd, env, stdin, timeoutMs, tag })` | Runs `sh -c` to completion and returns `{ code, stdout, stderr }`. On timeout it sends SIGTERM to the shell and every process it started. Output also streams to `onProcess` |
| `instance.spawn(cmd, args, opts)` → `Process` | A process with streaming `stdout`/`stderr`, `stdin` (writes reach `process.stdin` and `fs.read(0)`; closing it sends EOF), `kill(signal)` and `exit`. Unread output is buffered up to 8 MiB per stream, then dropped with a note |
| `SpawnOptions.pty`, `process.resize(cols, rows)` | Run on a pseudo-terminal: TTY stdio, keystrokes on `stdin`, all output on `stdout`, SIGWINCH on resize. `resize` without a terminal throws `ERR_NOT_A_TERMINAL` ([ADR 0017](decisions/0017-pty-and-signals.md)) |
| `process.kill(signal)` | Delivers HUP INT QUIT KILL USR1 USR2 PIPE ALRM TERM CHLD XCPU WINCH (and job-control signals). A handler may take it; otherwise the default action applies, and a process that does neither within 1 s is terminated |
| `instance.onProcess(cb)`, `SpawnOptions.tag` | Spawn, output and exit events for processes started with `spawn` or `exec`. New listeners get the last 100 processes replayed (256 KiB of output each). `tag` is a host-side label, never sent to the instance ([ADR 0016](decisions/0016-process-events-and-terminal-package.md)) |

## Previews and the network

| API | What it does |
|---|---|
| `instance.onPortOpen((port, url) => …)` | Fires for open and future virtual ports with the port's own origin, `https://<id>-p<port>.<sandbox-domain>/`, once its service worker is linked. At most 64 ports per instance get an origin |
| `instance.onPortClose(cb)` | Fires when a reported port stops listening |
| `instance.openPreview(port, opts)` → `Preview` | An iframe on the port origin driven by an injected agent: `snapshot` (an outline with `[ref=eN]` targets, optional HTML), `click`, `type`, `press`, `waitFor`, `evaluate`, `screenshot` (PNG), `console`, `navigate`, `reload`, `close` |
| `instance.networkLog(since)` | The last 500 requests served on virtual ports: method, path, status, time to headers, requesting instance |
| `http://<name>.internal:<port>/` | From processes: reach another instance's port. Needs a `net` capability for the peer (and port). HTTP only; responses stream |

## Work with many instances

| API | What it does |
|---|---|
| `instance.grant` / `revoke` / `capabilities` | Instances grant what is about themselves, or delegate what they hold. Children never get more than their parent could grant |
| `instance.mailbox.send(to, msg)` / `onMessage` | JSON messages up to 1 MiB. Sending needs a `channel` capability. Processes read their inbox at `http://mailbox.internal/` |
| `instance.fork(opts)` | Copies the filesystem into a new instance on a new origin. Needs `spawn-instance`, whose limits bound the child's |
| `instance.createChild(opts)` | A child instance with a fresh filesystem. Needs `spawn-instance` |

## Companion packages

| Package | API |
|---|---|
| `@clientvm/terminal` | `attachShell(term, instance, opts)`: `bash -i` on a pty connected to an xterm.js-compatible terminal; `dispose()` hangs up. `createActivityFeed`, `attachActivityView`, `createSanitizer`, `displayCommand`, `stripAnsi`; both views take `OutputOptions` (`throttle`, `linkPorts`, `persist`) |
| `@clientvm/agent-api` | `createAgentTools({ instance })`: LLM tool definitions and a dispatcher ([agent tool API](agent-api.md)). `call(name, input, { tag })` tags the processes a tool starts with `{ source: 'agent', tool, ...tag }` |

## Errors

Errors raised by the controller are `ClientVMError` with a `code`:

| Code | Meaning |
|---|---|
| `ERR_NOT_ISOLATED` | The instance page is not cross-origin isolated: check the [hosting headers](hosting.md#requirements) |
| `ERR_BOOT_TIMEOUT` | The instance did not finish booting in `bootTimeoutMs` |
| `ERR_INSTANCE_CRASHED` | The instance's renderer died; a kernel silent for four heartbeats is torn down and its processes exit with `SIGKILL` |
| `ERR_DESTROYED` | The instance was destroyed |
| `ERR_NO_CAPABILITY`, `ERR_INVALID_CAPABILITY` | A cross-instance call without, or with a malformed, capability |
| `ERR_NO_INSTANCE` | No such instance |
| `ERR_INSTANCE_PROTOCOL`, `ERR_INVALID_MESSAGE` | The instance sent something the controller rejected |
| `ERR_RATE_LIMITED` | The instance sent requests (such as mail) too fast |

Errors from inside an instance keep their system error `code` (`ENOENT`, `EAGAIN`, …).

## Types worth knowing

| Type | Notes |
|---|---|
| `InstanceId`, `SnapshotId` | Branded strings, so ids cannot be mixed up with names or paths at compile time |
| `ProcessType = 'js' \| 'builtin' \| 'wasi' \| 'vm'` | `wasi` and `vm` are reserved for future tiers |
| `MountSource` | An instance directory or a snapshot, with a read-only flag a capability can check |
| `Disposable`, `Signal`, `FileTree`, `Limits`, `InstanceInfo`, `DirEntry`, `Stat`, `FsEvent`, `SpawnOptions`, `ExecOptions`, `ExecResult`, `ProcessInfo`, `ProcessEvent`, `WindowSize` | See `types.ts` |

## Internal interfaces

Not public API, but useful when reading the code:

- **Syscall channel** (`@clientvm/protocol`): `SyscallClient.call(op, bytes) → bytes` and
  `SyscallServer(sab, handler)`. Bytes in, bytes out, so it can be replaced by Rust/WASM if
  profiling demands.
- **Process runtime** (`@clientvm/process`): `type Runtime = (ctx: ProcessContext) => number | void
  | Promise<…>`. `ctx` provides `argv`, `env`, `cwd`, `syscall`, `stdout`, and `stderr`.
- **Instance RPC** (`@clientvm/protocol` `InstanceRpc` / `InstanceEvents`): what an instance kernel
  serves to the controller over its MessagePort, plus the handshake messages.
- **Controller RPC** (`ControllerRpc`): requests a kernel makes of the controller on the same
  port (`mailboxSend`, `netFetch`). They run with the calling instance's capabilities.
