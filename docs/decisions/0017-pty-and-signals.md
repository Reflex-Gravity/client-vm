# ADR 0017: pseudo-terminals and signal delivery

- **Status:** accepted (2026-10-22); amended 2026-10-23 with job control (below)
- **Context:** An interactive terminal (docs/terminal-plan.md, T2) needs what Linux gives a
  program on a terminal: `isatty()` true with a size, echo and line editing, raw mode for
  full-screen programs, Ctrl+C reaching the foreground job, and resize notifications. ClientVM's
  stdio was pipes only, and `kill` terminated a worker without running handlers. So npm, which
  shows progress only on a terminal, printed nothing until it finished, and Ctrl+C could not
  reach a dev server's cleanup code.
- **Decision:**
  - **Signals are delivered.** The kernel posts a signal to the process. Handlers
    (`process.on('SIGINT')`, a shell `trap`) take it and acknowledge it; without one, the
    default action applies: ignore SIGCHLD and SIGWINCH, terminate on the rest (exit status
    128 + n, `signal` set). A process that neither acknowledges nor exits within 1 s (stuck in
    JavaScript) is terminated by the kernel. SIGKILL, SIGPIPE and SIGXCPU stay immediate. A
    process ended by a signal still takes its descendants with it (ADR 0011). The known signals
    are now HUP INT QUIT KILL USR1 USR2 PIPE ALRM TERM CHLD XCPU WINCH.
  - **A pseudo-terminal in the kernel.** `spawn(cmd, args, { pty: { cols, rows } })` starts a
    session on a new terminal: the process's stdio is the terminal, all its output arrives on
    `stdout`, and `stdin` writes are keystrokes. Its line discipline (`kernel/src/pty.ts`)
    does what Linux's n_tty does by default: in cooked mode echo, erase, kill line, word erase,
    Ctrl+C → SIGINT and Ctrl+\ → SIGQUIT to the foreground, Ctrl+D → end of file (an empty
    chunk, so the terminal stays open for later reads), Enter → `\n`; in raw mode
    (`setRawMode(true)`) bytes pass through. Output gets ONLCR (`\n` → `\r\n`).
    `Process.resize(cols, rows)` updates every process on the terminal, then sends SIGWINCH to
    the foreground.
  - **Process groups, simplified.** A child joins its parent's group and inherits the
    controlling terminal; a stdio stream is the terminal when inherited from one. A shell's
    background job and `child_process.spawn({ detached: true })` start a new group, which
    terminal signals and input skip. The foreground group is the session leader's: there is no
    `tcsetpgrp`, no stopping (Ctrl+Z, SIGTSTP) and no SIGTTIN. Input goes to the newest process
    in the foreground whose stdin is the terminal, so `node` started from the shell reads keys
    while it runs and the shell reads them again afterwards. A process that set raw mode and
    exits leaves the terminal cooked.
  - **node-compat:** `isTTY`, `columns`/`rows`, `getWindowSize`, `getColorDepth`/`hasColors`
    (Node's FORCE_COLOR/NO_COLOR/TERM rules), the cursor methods, `'resize'` events,
    `setRawMode`/`isRaw`, `tty.isatty`, signal events on `process`, `process.kill(process.pid)`,
    `readline.emitKeypressEvents`, and terminal-mode `readline.Interface` (raw mode, line
    editing, history, completer, `SIGINT` event), diffed against Node in
    `test/conformance/readline-differential.test.ts`. Terminal sessions get `TERM=xterm-256color`.
  - **Interactive shell:** `bash -i`, or `sh`/`bash` without a script when stdin and stderr are
    the terminal. PS1/PS2 with bash's escapes (Ubuntu's coloured default), line editing in raw
    mode with history in `~/.bash_history`, Tab completion of commands and paths, continuation
    lines, background jobs announced with `[n] pid` and `[n]+ Done`. Ctrl+C stops work running
    in the shell at once; for a foreground program the shell waits, and abandons the rest of
    the line only if the program died of the signal, as bash does. `trap` actions run on
    delivered signals in any shell.
  - `@clientvm/terminal`'s `attachShell(term, instance)` connects an xterm.js-compatible
    terminal to `bash -i` on a pty.
- **Measured (headless Chromium, M-series Mac, production build):** keystroke to echo at the
  prompt, 5.3 ms median, 5.5 ms p95 (under one 16 ms frame). Ctrl+C to the next prompt for
  `sleep 30` and for `node -e "setInterval(...)"`, about 12 ms. A process in its event loop
  acts on a signal on its next turn, so the 1 s grace period only matters for code that does
  not yield.
- **Consequences:**
  - `npm install` on a terminal shows npm's own progress spinner; tools that colour only on a
    TTY now do. `exec` and the agent tools still use pipes, so tool results carry no colour codes.
  - `kill('SIGTERM')` no longer ends a process synchronously: a handler can clean up (or ignore
    it, as on Linux). `Instance.exec` timeouts are unaffected unless the command traps SIGTERM.
  - The shell's spawned children read the terminal directly (`stdin: 'inherit'`) instead of
    having input copied through the shell, but only on a terminal. Pipes behave as before.
  - Not yet: SIGTTIN (a background job that reads the terminal simply gets no input), `stty`, a `kill` command, and wide-character widths in line editing. Interactive sessions are
    diffed against real bash in a real PTY (`pty-differential.spec.ts`: both outputs are
    drawn by `@xterm/headless` and the screens compared).

## Amendment (2026-10-23): job control

Asked for in the roadmap, so the "no job control" simplification above is lifted:

- **Stopping.** SIGTSTP (Ctrl+Z in cooked mode, like `^C`) and SIGSTOP stop a process, and
  SIGCONT continues it. A browser cannot pause a worker from outside, so a stopped process
  stops itself: its default action marks a slot in its syscall channel's header, reports
  `stopped` to the kernel and blocks in `Atomics.wait` on that slot until the kernel's SIGCONT
  clears it. SIGSTOP cannot be caught; SIGTSTP can. Other signals to a stopped process wait
  until it continues (no grace timer), except SIGKILL. A stopped process counts as waiting for
  the CPU watchdog, and terminal input skips it.
- **Process groups move.** `child-setpgid` puts a child and everything it started into the
  parent's group (the terminal's foreground) or a group of its own; `child-kill` with `tree`
  signals a whole job. Parents hear `child-stopped` and `child-continued`.
- **The interactive shell** ignores SIGTSTP. A line whose programs stop becomes a Stopped job
  (`[1]+  Stopped  cmd`, `$?` 148); its programs leave the shell's group, so the prompt's input
  and Ctrl+C no longer reach them. `fg [%n]` moves a job back and waits for it (it can be
  stopped again); `bg [%n]` continues it in its own group; `jobs` shows Running/Stopped/Done.
  Exiting the shell hangs up stopped jobs and continues them so they can act on it.
- **Limits.** A process that never returns to its event loop (a busy loop) cannot act on
  SIGTSTP, as it cannot act on SIGINT; it is not stopped. Commands the shell runs in its own
  worker (`sleep`, `cat`, `grep`, ...; ADR 0011) are not separate processes, so Ctrl+Z does not
  stop them; bash would stop its external `sleep`. A job started with `&` and brought to
  the foreground with `fg` does not read the terminal (it was started without it).

### Signals to a process blocked in a syscall

A process blocked in a synchronous syscall (`execSync`, `spawnSync`) cannot run a handler, and
the 1 s grace period used to end it even when it had one. The process now publishes the signal
numbers it catches in another slot of its channel header (node's `process` listeners, the
shell's traps, the interactive shell's own). For a blocked process the kernel reads it: an
uncaught signal takes its default action at once, as on Linux; a caught one is delivered and
its grace period starts only once the call returns, so the handler runs then, as in Node.

