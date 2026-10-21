# ADR 0011: The shell runs its commands in-process; every command is also a runtime

- **Status:** accepted (2026-10-21)
- **Context:** Shell scripts run many short commands: `ls`, `grep`, `sed`, `mkdir -p`, pipelines,
  `$(...)`, and loops that run a command per file. A ClientVM process is a Web Worker with
  syscall channels, and a process spawn costs about 9 ms (docs/phase3-plan.md). A worker per
  command would make `for f in *.js; do grep -q x "$f"; done` take seconds. StackBlitz's `jsh`
  and busybox avoid this by running applets inside the shell process.
- **Decision:**
  - The commands in `@clientvm/shell` (`ls cat grep sed find ...`) and the shell builtins run
    **inside the shell's worker** as async functions. Pipelines between them use in-memory pipes
    with backpressure, and EPIPE becomes exit status 141. Subshells, pipeline stages and `$(...)`
    are copies of the shell state, as `fork()` would give.
  - The choice still goes through **`PATH` lookup**, as `execve` would. The shell resolves
    `argv[0]` to a file. If the file is a builtin marker (`#!/clientvm/builtin grep`) for a
    command it implements, the command runs in-process. Anything else (`node`, scripts,
    `node_modules/.bin` shims, an earlier file of the same name on `PATH`) is spawned as a real
    child process through the kernel. Output that goes to the shell's own stdout or stderr is
    **inherited** (the kernel routes it), not copied through the shell.
  - Every command is also registered as a **standalone runtime**, so `child_process.spawn('ls')`,
    `execSync('grep ...')` and `xargs`/`find -exec` from a spawned program work as on Linux.
    `sh` and `bash` are runtimes too, with marker files at `/bin/sh`, `/bin/bash` and
    `/usr/bin/env`.
  - One implementation targets both shells: POSIX `sh` plus the bash extensions agents commonly
    write. Behavior is checked against **real bash and GNU coreutils** in CI
    (`test/conformance/shell-differential.test.ts`).
- **Consequences:**
  - A loop iteration costs microseconds instead of a worker spawn.
  - In-process background jobs (`cmd &`) live in the shell's worker and end when the shell
    exits. Spawned children keep running, as orphans do on Linux.
  - Killing a process kills its descendants, like a signal to a process group. `Instance.exec`
    timeouts therefore stop the whole command line.
  - Nothing acknowledges stdin data the shell feeds to a spawned child. The feeding loop yields to
    the event loop every 64 KiB, so the child's exit is seen (`yes | node ...` terminates).
  - A command bug can affect the shell that runs it, but both run in the same sandboxed worker
    with the same authority. This is not a new boundary.
