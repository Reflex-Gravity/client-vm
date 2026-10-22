# ClientVM

An open-source (Apache-2.0) browser runtime that runs Node.js-style workloads, a shell, and
common Linux commands **entirely in the browser**, with no server-side compute. Built for AI-agent
app builders: each agent gets isolated instances with their own filesystem, processes, and
network namespace.

> **Status: pre-1.0 (Phases 0–5 implemented).** Not production-ready until the sandbox boundary
> has had an independent [security review](docs/security-review.md). See [CLAUDE.md](CLAUDE.md)
> for the roadmap and [docs/compatibility.md](docs/compatibility.md) for exactly what works.

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
- **Vite + React with HMR.** A stock project runs its dev server and production build. esbuild and
  rollup run as their official WebAssembly builds.
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
```

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
