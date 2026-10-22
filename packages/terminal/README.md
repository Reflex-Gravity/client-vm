# @clientvm/terminal

Shows what a ClientVM instance runs: each command (the agent's and the user's), its output as it
arrives, and how it ended. Built on `Instance.onProcess`
([ADR 0016](../../docs/decisions/0016-process-events-and-terminal-package.md)). No runtime
dependencies besides `@clientvm/clientvm`; bring your own UI or terminal emulator.

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

## In a terminal emulator (xterm.js)

```ts
import { Terminal } from '@xterm/xterm';
import { attachActivityView } from '@clientvm/terminal';

const term = new Terminal({ fontSize: 12 });
term.open(element);
const view = attachActivityView(term, instance);
// later: view.dispose()
```

Each command is drawn as a `$ command` line, its output, and a `✔ 1.2 s` or `✖ exit 1 300 ms`
line. When concurrent processes take turns writing (a dev server and an `npm install`), the
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

Process output is written by untrusted code and drawn in the host page. `attachActivityView`
passes text, colours and cursor movement, and removes string escape sequences (clipboard writes
with OSC 52, OSC 8 hyperlinks, DCS/APC) except window titles. Commands are drawn without control
characters. `createActivityFeed` keeps output raw: render it as text (`textContent`), never as
HTML, and use `stripAnsi` or `createSanitizer` as needed.
