# ClientVM

An open-source (Apache-2.0) browser runtime that runs Node.js-style workloads, a shell, and
common Linux commands **entirely in the browser**, with no server-side compute. Built for AI-agent
app builders: each agent gets isolated instances with their own filesystem, processes, and
network namespace.

> **Status: early development (Phase 2 complete).** Not production-ready yet. See
> [CLAUDE.md](CLAUDE.md) for the roadmap and [docs/compatibility.md](docs/compatibility.md) for
> exactly what works.

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
- **`node -e` / `node -p` / `node script.js`** with a Node 24 compat subset: most of sync `fs`,
  `path`, `util.format` / `util.inspect`, `console`, `process`, and timers.
- **Preview routing:** a per-instance service worker forwards requests to virtual ports
  (static serving for now; `http.createServer` is Phase 3).

## Development

Requires Node 24 and pnpm (via Corepack).

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + differential tests vs real Node
pnpm exec playwright install chromium
pnpm test:e2e                              # Chromium, cross-origin isolated
pnpm bench                                 # writes bench-results.json
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
| `@clientvm/clientvm` | Public API: the controller (`createClientVM`) and types |

Docs: [architecture](docs/architecture.md) · [interfaces](docs/interfaces.md) · [hosting](docs/hosting.md) ·
[security](docs/security.md) · [open questions](docs/open-questions.md) · [decisions](docs/decisions/)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
