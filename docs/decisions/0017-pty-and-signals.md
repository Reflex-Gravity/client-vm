# ADR 0017: pseudo-terminals and signal delivery

- **Status:** accepted (2026-10-22)
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
  - Not yet: job control (Ctrl+Z, `fg`/`bg` that move the terminal between groups), SIGTTIN,
    `stty`, a `kill` command, wide-character widths in line editing, and differential tests of
    interactive sessions against real bash in a PTY.
