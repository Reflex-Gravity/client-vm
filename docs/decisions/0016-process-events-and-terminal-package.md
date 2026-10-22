# ADR 0016: process events and a dependency-free terminal package

- **Status:** accepted (2026-10-22)
- **Context:** A builder app needs to show what runs in an instance: each command the agent or
  the user starts, its output while it runs, and how it ended (docs/terminal-plan.md). Only the
  caller of `spawn` saw a process's output, and `exec` ran through the kernel's `run` method,
  which returned all output at exit. Terminal emulators (xterm.js) are large and their choice
  belongs to the host app; core packages have no runtime dependencies (CLAUDE.md §5).
- **Decision:**
  - `Instance.onProcess(cb)` reports `spawn` (pid, argv, cwd, tag, start time), `output` (fd 1
    or 2, bytes) and `exit` (code, signal, exit time) for processes started with `spawn` or
    `exec`. Their children's output reaches listeners through them, as it does on a terminal.
  - The controller keeps a bounded history and replays it to each new listener: the last 100
    processes (running ones are never dropped) and the last 256 KiB of output each, with a note
    of how much was dropped. Instance output is hostile and must not grow host memory without
    limit. Teardown reports every running process as exited with `SIGKILL`.
  - `SpawnOptions.tag` (and so `ExecOptions.tag`) labels a process for listeners, e.g.
    `{ source: 'agent', tool: 'exec', toolUseId }`. It stays in the controller and is never sent
    to the instance. `AgentTools.call(name, input, { tag })` tags what each tool starts.
  - `exec` is built on `spawn`: the `spawn` RPC now accepts `stdin` (fed then closed; empty
    starts at end-of-file), and the controller enforces `timeoutMs` with SIGTERM, as the
    kernel's `run` did. So `exec` output streams to listeners. If the instance is destroyed or
    crashes mid-command, `exec` still rejects with `ERR_DESTROYED`/`ERR_INSTANCE_CRASHED`.
  - New package `@clientvm/terminal`, depending only on `@clientvm/clientvm`:
    `createActivityFeed` (immutable `CommandBlock` snapshots with `subscribe`/`getSnapshot`,
    the shape React's `useSyncExternalStore` takes), `attachActivityView(term, instance)`
    (writes to any `{ write(data: string) }`, which an xterm.js `Terminal` is), and
    `createSanitizer`, which the view applies to output.
- **Consequences:**
  - Hosts choose their UI: DOM blocks from the feed (the playground), or xterm.js.
  - `exec` output now goes through the 8 MiB per-stream handle buffer. `exec` reads it as it
    arrives, so this only drops output that arrives faster than the host page can read it.
  - Every `exec` and `spawn` costs a little host memory for the history while listeners are
    absent; the bounds above cap it at about 25 MiB per instance in the worst case.
  - The kernel's `run` method remains for `debugRun` (tests and benchmarks).
  - Output is not a TTY yet, so most tools print plain text. PTYs are ADR 0017.
