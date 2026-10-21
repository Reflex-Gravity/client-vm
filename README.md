# ClientVM

An open-source (Apache-2.0) browser runtime that runs Node.js-style workloads, a shell, and
common Linux commands **entirely in the browser**, with no server-side compute. Built for AI-agent
app builders: each agent gets isolated instances with their own filesystem, processes, and
network namespace.

> **Status: early development (Phase 1 spike complete).** Not usable yet. See
> [CLAUDE.md](CLAUDE.md) for the roadmap and [docs/compatibility.md](docs/compatibility.md) for
> exactly what works.

## What works today

- A kernel worker with an in-memory filesystem.
- Process workers making **synchronous** syscalls (`fs.readFileSync` and friends) over
  `SharedArrayBuffer` + `Atomics.wait`, at about 10 µs per round trip
  ([spike results](docs/spike-results.md)).
- `node -e` / `node -p` / `node script.js` with a small Node 24 compat layer (`fs` subset, `path`,
  `util.format` / `util.inspect`, `console`, `process`, timers).

## Development

Requires Node 24 and pnpm (via Corepack).

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + differential tests vs real Node
pnpm exec playwright install chromium
pnpm test:e2e                              # Chromium, cross-origin isolated
pnpm bench                                 # writes bench-results.json
pnpm --filter @clientvm/sandbox-host dev   # open the sandbox page; try __clientvm.run(['node','-p','1+1'])
```

## Layout

| Package | Purpose |
|---|---|
| `@clientvm/protocol` | Binary codec, SAB syscall channel, RPC, errno/`SystemError` |
| `@clientvm/vfs` | Virtual filesystem (memory backend) |
| `@clientvm/kernel` | Process table and syscall dispatch |
| `@clientvm/process` | Process worker bootstrap, stdio, built-in bench |
| `@clientvm/node-compat` | Node core module shims and the `node` command |
| `@clientvm/sandbox-host` | Static sandbox page and worker entries (COOP/COEP) |
| `@clientvm/clientvm` | Public API types |

Docs: [architecture](docs/architecture.md) · [interfaces](docs/interfaces.md) ·
[security](docs/security.md) · [open questions](docs/open-questions.md) · [decisions](docs/decisions/)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
