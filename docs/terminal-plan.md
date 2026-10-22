# Terminal plan: seeing and driving what an instance runs

Goal: a builder app on ClientVM can show the commands that run in an instance (the agent's and
the user's) with their live output and status, as Bolt and StackBlitz do, and later give the
user an interactive terminal. The UI layer is small. The runtime gaps are what make this work:

| Gap | Before this plan |
|---|---|
| No way to observe processes | Only the caller of `spawn`/`exec` saw output. `exec` returned it all at exit |
| No TTY | `isatty()` is always false. No colours or spinners, `ls` prints one name per line, readline has no line editing (compatibility.md) |
| No signals | `kill` terminates. `process.on('SIGINT')` handlers never run; there is no `SIGWINCH` |
| Shell is non-interactive | No prompt, history, line editing or foreground job |

## Slices

| Slice | Contents | Tested by |
|---|---|---|
| T1 | **Activity view.** `Instance.onProcess` (spawn, output, exit, bounded replay) and `SpawnOptions.tag`. `exec` streams. agent-api tags what it starts. New `@clientvm/terminal`: `createActivityFeed` (immutable command blocks for any UI), `attachActivityView` (writes to any xterm.js-compatible terminal), an output sanitizer. Playground shows the feed ([ADR 0016](decisions/0016-process-events-and-terminal-package.md)) | Vitest, e2e `terminal.spec.ts`, `example.spec.ts` |
| T2 | **Interactive terminal.** Pseudo-terminals in the kernel (line discipline, raw mode, window size), process groups, real signal delivery, `isTTY`/`setRawMode`/`SIGWINCH` in node-compat, readline terminal mode, an interactive shell (prompt, history, completion, Ctrl+C, background jobs), `attachShell(term, instance)`; the terminal page uses it ([ADR 0017](decisions/0017-pty-and-signals.md)) | Vitest (line discipline, line editor, `attachShell`), readline differential vs Node, e2e `pty.spec.ts` and `terminal-page.spec.ts` |
| T3 | **Polish.** Multiple shell tabs, search, scrollback that survives a reload, output rate limiting in the view, port URLs in output as links, compatibility.md updates | e2e |

## Decisions taken (2026-10-22)

- **xterm.js is not a dependency.** `attachActivityView` writes to a structural `TerminalLike`
  (`write(data: string)`), which an xterm.js `Terminal` satisfies. `@clientvm/terminal` has no
  runtime dependencies besides `@clientvm/clientvm`; the host app brings its own emulator.
- **Agent and user commands are separate processes**, told apart by `tag`, not one shared shell
  session. Sharing `cd` and environment between an agent and a person typing at the same time
  is confusing for both.
- **Agent commands do not get `FORCE_COLOR`.** Colour codes in tool results cost the model
  tokens. Colour arrives with PTYs (T2), only for terminals that ask for one.

Still open (docs/open-questions.md): whether the agent may read the user's terminal.

## Status

| Slice | State |
|---|---|
| T1 | Done |
| T2 | Done. Measured: 5 ms keystroke to echo, about 12 ms Ctrl+C to prompt (ADR 0017). Not done: job control (Ctrl+Z, `fg`/`bg`), differential sessions against bash in a real PTY |
| T3 | Not started |
