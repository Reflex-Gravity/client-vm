# @clientvm/terminal

Terminals for a ClientVM instance: an interactive shell the user types into, and a view of each
command the agent runs with its live output and how it ended. Built on pseudo-terminals
([ADR 0017](../../docs/decisions/0017-pty-and-signals.md)) and `Instance.onProcess`
([ADR 0016](../../docs/decisions/0016-process-events-and-terminal-package.md)). No runtime
dependencies besides `@clientvm/clientvm`; bring your own UI or terminal emulator.

## An interactive shell (xterm.js)

```ts
import { Terminal } from '@xterm/xterm';
import { attachShell } from '@clientvm/terminal';

const term = new Terminal();
term.open(element);
const session = await attachShell(term, instance, { cwd: '/home/user/app' });
// session.process, session.exit; session.dispose() hangs up
```

This runs `bash -i` on a pseudo-terminal the size of `term`: a prompt, line editing, history
(↑/↓), Tab completion, and Ctrl+C. Programs see a TTY, so npm shows its progress, tools use
colour, and prompts (`npm create vite`) and dev-server shortcuts read keys. Resizing `term`
(e.g. with `@xterm/addon-fit`) resizes the terminal. Pass `command`/`args` to run something else.

## A list of command blocks (any UI framework)

```ts
import { createActivityFeed, stripAnsi } from '@clientvm/terminal';

const feed = createActivityFeed(instance, {
  filter: (p) => p.tag?.['source'] === 'agent', // optional
});
// React: const commands = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
feed.subscribe(() => {
  for (const c of feed.getSnapshot())
    console.log(c.command, c.status, c.code, stripAnsi(c.output));
});
```

Each `CommandBlock` has `pid`, `command` (the command line, e.g. `npm install`), `argv`, `cwd`,
`tag`, `startedAt`, `status` (`running`/`exited`), `code`, `signal`, `exitedAt` and `output`
(stdout and stderr interleaved; the last 200,000 characters). Snapshots are immutable: a changed
block is a new object. `examples/agent-playground` renders them as DOM.

## The agent's commands in a terminal emulator

```ts
import { Terminal } from '@xterm/xterm';
import { attachActivityView } from '@clientvm/terminal';

const term = new Terminal({ fontSize: 12 });
term.open(element);
const view = attachActivityView(term, instance, {
  filter: (p) => p.tag?.['source'] === 'agent',
});
// later: view.dispose()
```

Each command is drawn as a `$ command` line, its output, and a `✔ 1.2 s` or `✖ exit 1 300 ms`
line. Options: `filter` picks the processes to show, and `label` puts text before a command's
`$`, e.g. `(p) => (p.tag?.source === 'agent' ? '🤖 ' : undefined)`. When concurrent processes take turns writing (a dev server and an `npm install`), the
switch is labelled `[npm run dev]`. Any object with `write(data: string)` works in place of
xterm.js.

## Tagging processes

Pass `tag` to `spawn`/`exec` to tell processes apart; agent tools tag what they start with
`{ source: 'agent', tool }`, plus the tag you give `call`:

```ts
await instance.exec('npm test', { tag: { source: 'user' } });
await tools.call(block.name, block.input, { tag: { toolUseId: block.id } });
```

## Security

Process output is written by untrusted code and drawn in the host page. `attachShell` and
`attachActivityView` pass text, colours and cursor movement, and remove string escape sequences (clipboard writes
with OSC 52, OSC 8 hyperlinks, DCS/APC) except window titles. Commands are drawn without control
characters. `createActivityFeed` keeps output raw: render it as text (`textContent`), never as
HTML, and use `stripAnsi` or `createSanitizer` as needed.
