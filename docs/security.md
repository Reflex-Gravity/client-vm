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
| Capabilities for every cross-instance interaction, checked in the kernel | Phase 4 |
| Resource limits per instance (processes, memory, FS quota, CPU time via kill on timeout) | Phase 2/5 |
| The service worker never routes `/__clientvm/*` (ClientVM's own page, workers and SW script) to instance servers, so instance code cannot shadow them | **done** (2d), e2e-tested |
| The service worker accepts a kernel link only from the instance page | **done** (2d) |
| Preview pages run on a per-port origin, not the kernel's: app code cannot touch the kernel's OPFS store, the instance page, or other ports' storage. A port origin's link serves only its own port, never the module routes | **done** (3d), e2e-tested |
| Instance ids cannot end in `-p<digits>`, so an instance never shares an origin with another instance's port | **done** (3d) |
| Fuzzing of codec, channel, VFS, resolver, shell parser | Phase 5 (VFS: seeded random-op differential done; shell parser: seeded random-input test done) |
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
- **Kernel DoS.** A process can spin forever, flood stdout, or issue huge writes. Today
  `writeFile` accepts any size up to memory. Quotas and output caps are required before untrusted
  use.
- **`eval` in process workers.** The node runtime uses indirect `eval` by design. The sandbox
  boundary is the worker and origin, not the JS realm.
- **Outbound network.** Process code can `fetch` any CORS-enabled endpoint from the user's
  browser. Document this for integrators. A capability gate on outbound fetch is an open question.
- **npm supply chain.** npm itself is pinned by SHA-512 (ADR 0012), so a compromised registry
  or mirror cannot swap the npm CLI. Packages that npm installs are checked against their lockfile
  integrity, as npm normally does, but their code and lifecycle scripts are untrusted and run with
  the instance's full authority. Running `npm install --ignore-scripts` reduces what runs during
  install, not what runs at `require` time.

## Not in scope

The host app's own security, and anything the user explicitly deploys outside ClientVM.
