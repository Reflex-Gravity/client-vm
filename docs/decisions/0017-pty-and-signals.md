# ADR 0017: pseudo-terminals and signal delivery

- **Status:** proposed (2026-10-22). To be settled at the start of terminal slice T2.
- **Context:** An interactive terminal (docs/terminal-plan.md, T2) needs what Linux gives a
  program on a terminal: `isatty()` true with a size, echo and line editing, raw mode for
  full-screen programs, Ctrl+C reaching the foreground job, and resize notifications.
  ClientVM's stdio is pipes only, and `kill` terminates without running handlers
  (compatibility.md: `process`, `tty`, `readline`, `child_process`).
- **Proposal:**
  - **PTY in the kernel.** `spawn(cmd, args, { pty: { cols, rows } })` gives the process a
    terminal: one kernel object behind fds 0–2 with a line discipline (canonical mode with echo
    and erase, raw mode via `setRawMode`, `^C` → `SIGINT`, `^\` → `SIGQUIT`, `^D` → EOF,
    `\n` → `\r\n` on output). `Process.resize(cols, rows)` sends `SIGWINCH`. Children inherit
    the terminal.
  - **Process groups and sessions.** Each pipeline is a process group; the terminal has one
    foreground group, which receives terminal signals. Builtins running inside the shell's
    worker (ADR 0011) join their pipeline's group logically.
  - **Signal delivery.** The kernel queues a signal for the target process; the process runtime
    takes it at its next syscall or event-loop turn and emits it on `process`. Default actions
    (terminate, ignore) follow Linux. A process with no handler, or one blocked in pure
    JavaScript, is terminated after a grace period, as `kill` does today. `SIGKILL` stays
    immediate.
  - **node-compat.** `tty.isatty`, `process.stdout.isTTY`, `columns`/`rows`, `getWindowSize`,
    `setRawMode`, `'resize'` events; readline line editing and history when its input is a TTY.
  - **Shell.** An interactive mode (`sh -i`, or a TTY on stdin): `PS1`, history (optionally in
    the VFS), Tab completion, foreground/background jobs (`&`, `fg`, `jobs`, `wait`).
- **Open points to measure first:** latency of keystroke → echo through the kernel (target:
  under one frame), and whether signal delivery at syscall boundaries is prompt enough for dev
  servers that sit in their event loop.
- **Testing:** differential sessions against real bash and Node in a PTY (`script(1)` or
  node-pty in CI), using the same harness as the shell differential tests.
