# ClientVM

An open-source (Apache-2.0) browser runtime that runs Node.js-style workloads, a shell, and
common Linux commands **entirely in the browser**, with no server-side compute. Think StackBlitz
WebContainers, but open source and built for AI-agent app builders: each agent gets isolated
instances with their own filesystem, processes, and network namespace, runs real `npm install`
and `npm run dev`, and drives the app it built through a private, in-browser preview.

> **Status: pre-1.0 (Phases 0–5 implemented).** Not production-ready until the sandbox boundary
> has had an independent [security review](docs/security-review.md). See [CLAUDE.md](CLAUDE.md)
> for the roadmap and [docs/compatibility.md](docs/compatibility.md) for exactly what works.
> **Chromium only** for v1.

## How it works

```
Your app's page (host origin)
  └─ createClientVM()  ← the controller: trusted, validates every message
       ├─ instance A: hidden iframe on https://<a-id>.<sandbox-domain>
       │     └─ kernel worker: in-memory filesystem, processes, virtual ports
       │           ├─ node, npm, pnpm, git … (one Web Worker per process)
       │           └─ bash and ~60 Linux commands (in TypeScript)
       └─ instance B: same, on its own origin
```

- Every instance runs on **its own origin**. The browser's origin isolation keeps agent code
  away from your app's cookies and storage, and from other instances.
- Synchronous Node APIs (`fs.readFileSync`, …) block on `SharedArrayBuffer` + `Atomics.wait`
  while the kernel answers. The instance page gets cross-origin isolation from
  Document-Isolation-Policy, so **your app needs no COOP/COEP headers**.
- A server started inside an instance (`http.createServer`, Vite) gets a preview origin,
  `https://<id>-p<port>.<sandbox-domain>/`, served by a service worker. Previews are private to
  the browser tab.
- The sandbox is **static files only**: one deployment of `@clientvm/sandbox-host` behind a
  wildcard subdomain. Nothing runs on a server.

More: [architecture](docs/architecture.md) · [security model](docs/security.md).

## Try it locally

Requires Node 24, pnpm 10 (via Corepack) and Chromium.

```sh
git clone https://github.com/Reflex-Gravity/client-vm.git && cd client-vm
corepack enable
pnpm install
pnpm --filter @clientvm/sandbox-host build && pnpm --filter @clientvm/sandbox-host preview  # sandbox on :4173
pnpm --filter @clientvm/example-agent-playground dev                                         # app on :5180
```

- http://localhost:5180 is the [agent playground](examples/agent-playground). It has an
  instance, a command line, a preview, and the agent tools to call by hand.
- http://localhost:5180/terminal.html is an interactive `bash` in xterm.js.
- http://localhost:5180/terminal.html?preset=vite-react-ts is the same terminal, starting from a
  ready Vite + React + TypeScript project. Run `npm run dev`.

Locally, `<id>.localhost` stands in for the wildcard sandbox domain.

## Integrate it into your app

The `@clientvm/*` packages are not on npm yet. Until they are, use them from a checkout (as a pnpm
workspace or git submodule, `"@clientvm/clientvm": "workspace:*"`), built with `pnpm build`.

### 1. Deploy the sandbox

Build the static sandbox and serve it on a wildcard subdomain of a **separate registrable domain**
(e.g. `*.myapp-sandbox.dev`, never `*.myapp.com`), with no cookies:

```sh
pnpm --filter @clientvm/sandbox-host build   # → packages/sandbox-host/dist
```

Every response needs these headers (`Service-Worker-Allowed: /` on `/__clientvm/sw.js` too):

```
Document-Isolation-Policy: isolate-and-require-corp
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy: frame-ancestors https://your-app.example
```

Check a deployment with the same script CI uses:

```sh
node scripts/check-sandbox-headers.mjs 'https://{id}.myapp-sandbox.dev' --app https://your-app.example
```

The full checklist is in the [hosting guide](docs/hosting.md).

### 2. Create a controller and an instance

```ts
import { createClientVM } from '@clientvm/clientvm';

const vm = createClientVM({ sandboxOrigin: (id) => `https://${id}.myapp-sandbox.dev` });

// Start from your own files…
const instance = await vm.createInstance({
  fs: { from: { home: { user: { app: { 'index.js': "console.log('hi')" } } } } },
  limits: { maxProcesses: 64, maxCpuMs: 30_000 },
});

// …or from a ready Vite 8 + React 19 + TypeScript project with node_modules installed.
const app = await vm.createInstance({ preset: 'vite-react-ts' });
```

- **`preset`** builds the project once, which takes about 10 s in a hidden instance. The result
  is kept in your origin's Cache Storage, and every later instance boots from it in about 0.2 s
  with no downloads. To keep it somewhere else, pass `presetStore` to `createClientVM`
  ([ADR 0018](docs/decisions/0018-presets-cached-on-host-origin.md)).
- **Persistence:** add `fs: { persist: true }` and a fixed `id` to keep an instance's files
  across reloads.

### 3. Run commands and show the preview

```ts
const { code, stdout } = await instance.exec('node index.js', { cwd: '/home/user/app' });

app.onPortOpen((port, url) => {
  previewIframe.src = url; // https://<id>-p5173.myapp-sandbox.dev/
});
await app.spawn('npm', ['run', 'dev'], { cwd: '/home/user/app' });
```

- `spawn` returns a process with streaming `stdout`/`stderr`, `stdin`, `kill()` and `exit`.
- `instance.fs` reads and writes the instance's files from the host page.
- `snapshot()`, `fork()` and `destroy()` manage the instance's lifetime
  ([interfaces](docs/interfaces.md)).

### 4. Add a terminal

`@clientvm/terminal` attaches a real interactive `bash` to any xterm.js-compatible terminal. You
choose the terminal emulator; it is not a dependency.

```ts
import { Terminal } from '@xterm/xterm';
import { attachShell, attachActivityView } from '@clientvm/terminal';

const term = new Terminal();
term.open(element);
await attachShell(term, app, { cwd: '/home/user/app' }); // history, Tab completion, Ctrl+C, job control

// Or a read-only feed of what the agent runs:
attachActivityView(agentTerm, app, { filter: (p) => p.tag?.['source'] === 'agent' });
```

See the [terminal README](packages/terminal/README.md).

### 5. Hand it to an agent

`@clientvm/agent-api` turns an instance into LLM tool definitions. The tools cover files, `exec`,
background processes, driving the preview, screenshots, the mailbox and child instances.

```ts
import { createAgentTools } from '@clientvm/agent-api';

const tools = createAgentTools({ instance: app });
// Send tools.definitions as `tools` to the model; run each tool_use block through
// tools.call(block.name, block.input) and return the result as a tool_result.
```

The [agent API guide](docs/agent-api.md) has a full tool-use loop with the Claude API. Keep your
API key on your server, and relay tool calls to the page that owns the `ClientVM`.

## What works today

- **Instances on their own origins.** `createClientVM()` boots each instance in a hidden iframe on
  `<id>.<sandbox-domain>` with its own kernel, so browser origin isolation separates instances.
  Host apps need no COOP/COEP ([hosting guide](docs/hosting.md)).
- **A Linux-semantics in-memory filesystem:** symlinks, hard links, file descriptors, rename,
  quotas, watchers, and copy-on-write snapshots. It is checked against real `node:fs` by
  differential and random-operation tests.
- **Snapshots and forks** into new instances, and **OPFS persistence** that restores an instance by
  id after a reload.
- **Processes** making synchronous syscalls over `SharedArrayBuffer` + `Atomics.wait` at about
  10 µs per round trip, with streaming output, `kill`, and per-instance process limits.
- **Node 24 compatibility layer:** `fs` (sync, callback, and promises), streams, `http`/`net`
  on virtual ports, `child_process` (including `fork` with IPC), `worker_threads`, `crypto`
  hashes, `zlib`, `readline`, `node:test`, `async_hooks`, `diagnostics_channel`, CommonJS and
  native ESM with `exports` maps. Unmodified Express and ws run as golden fixtures
  ([compatibility matrix](docs/compatibility.md)).
- **Measured against Node itself:** 592 tests from Node 24's own `test/parallel` suite pass and
  run in CI, alongside differential tests against real Node, bash, GNU tools and git, and seeded
  fuzzing.
- **A POSIX shell with about 60 Linux commands** (`ls grep sed find xargs diff tar curl ...`),
  checked against real bash and GNU tools.
- **Real npm and pnpm.** The unmodified npm 11 and pnpm 10 are fetched and verified on first use.
  npm handles `install`, `ci`, `run` and `npx` with lifecycle scripts; pnpm handles `add`,
  frozen-lockfile installs, `exec`, `pnpx` and workspaces. A smoke test installs and loads 50
  popular packages.
- **git** for local repositories (`commit`, `diff`, `log`, `branch`, `merge`, `stash`, ...), on
  isomorphic-git, with output and commit ids matching real git.
- **Vite + React with HMR.** Stock Vite 6 and Vite 8 projects run their dev server and production
  build. esbuild, rollup, rolldown and lightningcss run as their official WebAssembly builds. The
  `vite-react-ts` preset boots a ready project from a cache that all instances share.
- **Previews:** each port gets its own origin, with WebSockets and HMR. A driveable preview
  provides DOM outlines, clicks, typing, screenshots, and console capture.
- **Multiple instances:** capabilities, a mailbox, HTTP between instances
  (`http://<name>.internal:<port>/`), and read-only mounts.
- **Agent tools:** `@clientvm/agent-api` exposes all of this as LLM tool definitions
  ([agent API](docs/agent-api.md)). [examples/agent-playground](examples/agent-playground) is a
  minimal host app that uses them.
- **Limits:** process count, filesystem quota, open files, a CPU watchdog for processes that never
  yield, and output caps. A benchmark gate in CI fails on performance regressions.

## Development

Requires Node 24 and pnpm (via Corepack).

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + differential tests vs real Node
pnpm exec playwright install chromium
pnpm test:e2e                              # Chromium, cross-origin isolated
pnpm bench                                 # writes bench-results.json
node scripts/bench-gate.mjs                # compares it with bench/baseline.json
pnpm --filter @clientvm/sandbox-host dev   # test host page; see packages/sandbox-host/src/host.ts
node scripts/build-presets.mjs             # after editing packages/clientvm/presets/
```

To run e2e beside another checkout's servers, set `CLIENTVM_E2E_PORT` and
`CLIENTVM_E2E_EXAMPLE_PORT`.

## Layout

| Package | Purpose |
|---|---|
| `@clientvm/protocol` | Binary codec, SAB syscall channel, RPC, errno/`SystemError` |
| `@clientvm/vfs` | Virtual filesystem, snapshots/images, OPFS persistence |
| `@clientvm/kernel` | Per-instance kernel: processes, fds, syscalls, virtual HTTP ports |
| `@clientvm/process` | Process worker bootstrap, stdio, built-in bench |
| `@clientvm/node-compat` | Node core module shims and the `node` command |
| `@clientvm/sandbox-host` | Static instance page, service worker, worker entries, and a test host page |
| `@clientvm/shell` | The shell and Linux commands |
| `@clientvm/clientvm` | Public API: the controller (`createClientVM`), capabilities, previews, and types |
| `@clientvm/agent-api` | Tool definitions for LLM agents |
| `@clientvm/terminal` | The commands an instance runs and their live output, for any UI or terminal emulator |
| `examples/agent-playground` | A minimal host app: an instance, a command line with live command output, a preview, and the agent tools |

Docs: [architecture](docs/architecture.md) · [interfaces](docs/interfaces.md) · [agent API](docs/agent-api.md) · [hosting](docs/hosting.md) ·
[terminal plan](docs/terminal-plan.md) · [security](docs/security.md) · [security review](docs/security-review.md) · [open questions](docs/open-questions.md) · [decisions](docs/decisions/)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
