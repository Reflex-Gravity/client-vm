# Security model and threat model

ClientVM runs code written by AI agents and code from arbitrary npm packages. **All of it is
treated as hostile.** This document must stay current. Every PR that changes a trust boundary
updates it.

## Assets

1. **Host app origin.** Its cookies, storage, credentials, and DOM. The most important asset.
2. **Other instances.** Their filesystems, processes, network ports, and mailboxes.
3. **The user's browser tab.** Memory, CPU, and responsiveness.
4. **The user's network position.** Requests sent from the user's browser and IP.

## Adversaries

- Agent-generated code running in a process, including code an attacker prompt-injected into the
  agent.
- Malicious or compromised npm packages (install scripts and runtime code).
- Content inside a preview iframe, such as a generated app that loads third-party scripts.

## Trust boundaries

```
Host app + controller (trusted, app origin, never runs instance code)
  ║ handshake via postMessage: exact source window + origin checks; then a MessagePort.
  ║ The controller validates every value an instance sends.          ← boundary 1
Instance iframe on <id>.<sandbox-domain> (one origin per instance)    ← boundary 2 (browser origin model)
  └─ kernel worker (our code, but shares the origin with hostile code)
       ║ SAB channel + postMessage; kernel validates every request   ← boundary 3
       └─ process workers (untrusted code)
  └─ service worker for module loading and in-instance fetch
Port origins <id>-p<port>.<sandbox-domain> (one per open port, ADR 0008)
  └─ bridge page + service worker + preview iframes running the app's own pages.
     The SW only reaches its own port through a channel the controller handed the kernel.
```

## Mitigations (planned and status)

| Mitigation | Status |
|---|---|
| Runtime executes on a separate sandbox origin, never the host app's origin | **done** (2b) |
| One origin and one kernel per instance, isolating storage, BroadcastChannel and SW between instances ([ADR 0003](decisions/0003-kernel-per-instance-origin.md)) | **done** (2b), e2e-tested |
| Sandbox origin serves static files only, sets no cookies, and has no authenticated endpoints | **documented** ([hosting.md](hosting.md)) |
| Host ↔ instance handshake checks the source window and exact origin on both sides; the controller validates all instance replies and events | **done** (2b) |
| `frame-ancestors` CSP restricts who can embed instance pages | **supported** (hosting config) |
| Kernel decodes every syscall defensively (type-checked args, `EINVAL` on malformed input, `ENOSYS` on unknown ops) | **done** (spike) |
| Process workers get no direct VFS access, only the syscall channel | **done** |
| Each process gets its own channel SAB, so processes cannot read each other's syscall traffic | **done** |
| Capabilities for every cross-instance interaction, checked in the **controller** (kernels run hostile code and never see the table) | **done** (4a–4c) for mailbox, `.internal` HTTP, mounts and `spawn-instance`, e2e-tested. Revoking a mount capability stops its sync |
| The preview agent accepts a connection only from its parent window, and the host validates everything it sends (snapshots, console entries, screenshots). `evaluate` runs in the preview's port origin, which already runs the instance's code. Agent output is untrusted data for an LLM (prompt-injection risk), not instructions | **done** (4d) |
| Requests a kernel makes of the controller (`mailboxSend`, `netFetch`) are validated and run with that instance's capabilities only; mailbox messages are re-serialized as JSON so instances never share objects | **done** (4a/4b) |
| Resource limits per instance: `maxProcesses`, `quotaBytes`/`maxInodes` (`ENOSPC`), 1024 open files per process, `maxCpuMs` (a process that runs without yielding is killed with `SIGXCPU`), 8 MiB of unread output per stream in the controller, `Instance.exec` `timeoutMs` | **done** (2c, 5c), e2e-tested. **`maxMemoryMB` is not enforced** (open-questions.md) |
| The service worker never routes `/__clientvm/*` (ClientVM's own page, workers and SW script) to instance servers, so instance code cannot shadow them | **done** (2d), e2e-tested |
| The service worker accepts a kernel link only from the instance page | **done** (2d) |
| Preview pages run on a per-port origin, not the kernel's: app code cannot touch the kernel's OPFS store, the instance page, or other ports' storage. A port origin's link serves only its own port, never the module routes | **done** (3d), e2e-tested |
| Instance ids cannot end in `-p<digits>`, so an instance never shares an origin with another instance's port | **done** (3d) |
| Fuzzing of codec, channel, VFS, resolver, shell parser | **done** (5b): seeded tests for the protocol codec, tar reader, path, CommonJS resolver, VFS operations and shell parser. Runs in CI with fixed seeds; `FUZZ_SEED`/`FUZZ_ITERATIONS` for longer runs |
| Threads (`worker_threads`, `child_process.fork`) are kernel processes: same syscall checks, process limit and CPU watchdog. Parent and child share only a MessagePort the kernel created | **done** (5a) |
| Process output shown in the host page (`@clientvm/terminal`, ADR 0016): the controller keeps at most 100 processes and 256 KiB of output each for `onProcess` replay; `attachActivityView` strips string escape sequences (OSC 52 clipboard writes, OSC 8 links, DCS/APC) except titles and draws commands without control characters; feed output is meant to be rendered as text, never HTML | **done** (T1), unit-tested. Output rate limiting in the view is not done yet (terminal-plan.md T3) |
| Agent-supplied regexes (`grep`, `sed`, `find -regex`, `[[ =~ ]]`) run on the JS regex engine and can backtrack catastrophically. They run in the instance's own worker, so a bad pattern only stalls that process; `Instance.exec` `timeoutMs` stops it | **documented** |

## What a compromised instance can do

Code in an instance can do anything its own origin can do. It can rewrite its own kernel's memory
(the kernel shares the agent cluster), read and write its own filesystem and OPFS, register a
service worker for its own origin, and send arbitrary messages to the controller. It cannot reach
other instances' storage or channels, or the host app's origin. Everything it sends the controller
is validated before use. A hostile instance can lie about its own files and process output, but
it cannot affect the controller or other instances.

## Persisted data

A persistent instance's store lives in its own origin's OPFS (`clientvm/v1/`). Processes in that
instance can read and tamper with it, which only affects that instance. Loading validates the
structure and fails closed on corruption. Storage partitioning keys it by the host app's
top-level site.

## Known risks and open issues

- **Spectre / high-resolution timers.** Cross-origin isolation re-enables SAB and precise timers.
  COEP keeps cross-origin resources that haven't opted in out of the process, but code in a process
  can still time other code in the same agent cluster. Per-instance origins limit what shares that
  cluster. Verify how Chromium assigns site isolation and processes for subdomains of one
  registrable domain: same-site subdomains may share a renderer process.
- **Embedding by third parties.** Anyone can embed an instance page. They cannot connect to it
  unless they are its parent at the claimed origin. Storage partitioning keys an embedded
  instance's OPFS by the top-level site, so other sites cannot read your users' persisted
  instances. `frame-ancestors` adds defense in depth.
- **Same-site subdomains.** `<id>.<sandbox-domain>` origins are same-site with each other.
  Cookies with `Domain=<sandbox-domain>` would be shared, so the sandbox domain must never set
  cookies. Consider listing the sandbox domain on the Public Suffix List so each instance is its own
  site.
- **Service worker hijack.** Preview documents and processes share the instance origin with the
  SW, so they can register a replacement SW or read the instance's storage. The blast radius is
  that one instance's previews and data, which that code already controls. A replacement SW
  cannot affect other instances (different origins) or the host app. Preview documents should
  not be treated as trustworthy by the host app; only read them through the controller.
- **Kernel DoS.** `maxCpuMs` stops a process that spins without yielding, output caps bound
  what the controller buffers, and `quotaBytes` bounds the filesystem. Still open: a process that
  yields regularly can run forever (use `timeoutMs` or `kill`), memory is not capped
  (`maxMemoryMB`), and the defaults are unlimited: integrators must set limits for untrusted use.
- **`eval` in process workers.** The node runtime uses indirect `eval` by design. The sandbox
  boundary is the worker and origin, not the JS realm.
- **Outbound network.** Process code can `fetch` any CORS-enabled endpoint from the user's
  browser. Document this for integrators. A capability gate on outbound fetch is an open question.
- **WebAssembly stand-ins (ADR 0013).** esbuild-wasm and @rollup/wasm-node are fetched on first
  use and checked against the integrity the registry publishes for them. That is the same trust
  `npm install` places in the registry, not a pin in ClientVM. They run with the instance's
  authority like any package code.
- **pnpm and git.** pnpm 10.34.7 and isomorphic-git 1.44.3 are pinned by SHA-512 like npm
  (ADRs 0012, 0014), so a compromised registry cannot swap them. `GIT_TOKEN` and
  `GIT_CORS_PROXY` are visible to everything in the instance; a CORS proxy sees every request
  and credential sent through it.
- **npm supply chain.** npm itself is pinned by SHA-512 (ADR 0012), so a compromised registry
  or mirror cannot swap the npm CLI. Packages that npm installs are checked against their lockfile
  integrity, as npm normally does, but their code and lifecycle scripts are untrusted and run with
  the instance's full authority. Running `npm install --ignore-scripts` reduces what runs during
  install, not what runs at `require` time.

## Review status

Before any 1.0 claim (CLAUDE.md §9) the sandbox boundary needs an independent review.
[security-review.md](security-review.md) is the checklist for it, with what has been verified so
far and how.

## Not in scope

The host app's own security, and anything the user explicitly deploys outside ClientVM.
