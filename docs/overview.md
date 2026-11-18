# Overview

**A dev machine for every AI agent, inside a browser tab.** ClientVM runs Node.js 24, a real
`bash` and the unmodified `npm` entirely in the browser. Each agent gets isolated instances with
their own filesystem, processes and network. It runs `npm install` and `npm run dev` and previews
the app it built, with no containers and no servers to pay for.

[Quickstart](quickstart.md) · [Hosting](hosting.md) · [API reference](interfaces.md) ·
[Live demo](https://clientvm.joeldsouza.me/) · [GitHub](https://github.com/Reflex-Gravity/client-vm)

```sh
npm install @clientvm/clientvm @clientvm/terminal
```

![Your page holds the ClientVM controller, your UI and the terminal and agent tools. Each instance is a hidden iframe on its own sandbox origin, where a kernel worker owns an in-memory filesystem and runs node, bash and other tools as Web Workers that make synchronous syscalls over SharedArrayBuffer. A service worker routes module loads and preview requests to the kernel, and each open port is previewed on its own origin.](diagrams/overview.svg)

## Choose your path

- **Run code an agent writes.** Boot an instance, give it files, run `exec` and `spawn`, and show
  the preview. Start with the [quickstart](quickstart.md).
- **Give an LLM a computer.** `@clientvm/agent-api` turns an instance into tool definitions for
  files, commands, dev servers and driving the preview. See the [agent tool API](agent-api.md).
- **Show users what is running.** `@clientvm/terminal` attaches an interactive `bash`, or a
  read-only feed of the agent's commands, to any xterm.js-compatible terminal
  ([terminal README](../packages/terminal/README.md)).
- **Understand the sandbox before you trust it.** Read [how it works](architecture.md) and the
  [security model](security.md).

## Quick start

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });
const app = await vm.createInstance({ preset: 'vite-react-ts' });

app.onPortOpen((port, url) => (preview.src = url));
await app.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
```

- `createClientVM` creates the **controller** on your page. `sandboxOrigin` says where the
  [sandbox you deploy](hosting.md) answers for each instance.
- `createInstance` boots an **instance**. The `vite-react-ts` preset is a ready Vite + React +
  TypeScript project with `node_modules` installed. It is built once and then boots in about
  0.2 s.
- `onPortOpen` reports the preview URL when a server inside the instance starts listening.
- `spawn` starts a process and streams its output. `exec` runs a command line to completion.

The [quickstart](quickstart.md) walks through each step, including the terminal and the agent
tools.

## How ClientVM works

1. **Your page runs the controller.** It is the only trusted part. It boots each instance in a
   hidden iframe on a sandbox origin of its own and checks every message that comes back.
2. **Each instance is a small operating system.** A kernel worker owns an in-memory filesystem,
   a process table, terminals, signals and virtual ports. Every process (`node`, `bash`, `npm`,
   `vite`) is a Web Worker. Blocking calls such as `fs.readFileSync` really block, on a
   `SharedArrayBuffer`, while the kernel answers.
3. **Servers become private previews.** When a process listens on a port, the instance's service
   worker routes requests from a preview iframe to it, on an origin of its own.

Read [how it works](architecture.md) for the details, with diagrams.

## What ClientVM supports

| | |
|---|---|
| **Runtime** | Node.js 24 APIs: `fs`, streams, `http`/`net` on virtual ports, `child_process`, `worker_threads`, `crypto`, `zlib`, CommonJS and native ESM. 592 of Node's own tests pass in CI ([compatibility matrix](compatibility.md)) |
| **Package managers** | The unmodified npm 11 and pnpm 10, fetched and verified on first use |
| **Tooling** | Stock Vite 6 and Vite 8 with HMR, React, Tailwind CSS 4, Express, `git` (on isomorphic-git) |
| **Shell** | `sh`/`bash` with pipes, job control, an interactive mode and about 60 Linux commands |
| **Isolation** | One browser origin per instance and per preview port; capabilities between instances |
| **Browser** | Chromium. Your app needs no COOP/COEP headers |
| **Not supported** | Safari and Firefox, native Node addons (other than the WebAssembly stand-ins), Python and other languages, raw TCP/UDP, outbound requests that CORS blocks |

## Using a coding agent?

Every docs page is also served as Markdown: add `.md` to its URL, or start from
[`/llms.txt`](https://clientvm.joeldsouza.me/llms.txt). All the docs in one file are at
[`/llms-full.txt`](https://clientvm.joeldsouza.me/llms-full.txt). The landing page's **Copy agent
prompt** button puts a ready integration prompt on your clipboard.

## Next steps

- **Deploy the sandbox:** the [hosting guide](hosting.md) covers the domain, headers and a
  deployment check.
- **Look up an API:** the [API reference](interfaces.md).
- **Why is it built this way?** The [design decisions](decisions.md), summarised on one page.
