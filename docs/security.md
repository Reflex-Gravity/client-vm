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
Host app (trusted, own origin)
  ║ postMessage only, origin-checked                       ← boundary 1
Sandbox origin iframe (static page, no credentials)
  ║ same-origin dedicated worker
Kernel worker (trusted code, enforces capabilities)
  ║ SAB channel + postMessage, kernel validates every request ← boundary 2
Process workers (untrusted code)
Preview iframe + service worker on <instance-id>.<sandbox-domain> ← boundary 3 (per instance)
```

## Mitigations (planned and status)

| Mitigation | Status |
|---|---|
| Runtime executes on a separate sandbox origin, never the host app's origin | Phase 2 |
| Per-instance subdomain origins (`<instance-id>.<sandbox-domain>`) to isolate storage and SW between instances | Phase 2 |
| Sandbox origin serves static files only, sets no cookies, and has no authenticated endpoints | Phase 2 (hosting guidance) |
| Host ↔ sandbox `postMessage` checks `origin` on both sides and uses a typed protocol | Phase 2 |
| Kernel decodes every syscall defensively (type-checked args, `EINVAL` on malformed input, `ENOSYS` on unknown ops) | **done** (spike) |
| Process workers get no direct VFS access, only the syscall channel | **done** |
| Each process gets its own channel SAB, so processes cannot read each other's syscall traffic | **done** |
| Capabilities for every cross-instance interaction, checked in the kernel | Phase 4 |
| Resource limits per instance (processes, memory, FS quota, CPU time via kill on timeout) | Phase 2/5 |
| Fuzzing of codec, channel, VFS, resolver, shell parser | Phase 5 |

## Known risks and open issues

- **Spectre / high-resolution timers.** Cross-origin isolation re-enables SAB and precise timers.
  COEP keeps cross-origin resources that haven't opted in out of the process, but code in a process
  can still time other code in the same agent cluster. Per-instance origins limit what shares that
  cluster. Verify how Chromium assigns site isolation and processes for subdomains of one
  registrable domain: same-site subdomains may share a renderer process.
- **Same-site subdomains.** `<id>.<sandbox-domain>` origins are same-site with each other.
  Cookies with `Domain=<sandbox-domain>` would be shared, so the sandbox domain must never set
  cookies. Consider listing the sandbox domain on the Public Suffix List so each instance is its own
  site.
- **Service worker hijack.** A process that can register or replace the instance's service worker
  could intercept preview traffic. Phase 2 must ensure only the trusted sandbox page registers the
  SW and that untrusted code cannot run on that origin's top-level document.
- **Kernel DoS.** A process can spin forever, flood stdout, or issue huge writes. Today
  `writeFile` accepts any size up to memory. Quotas and output caps are required before untrusted
  use.
- **`eval` in process workers.** The node runtime uses indirect `eval` by design. The sandbox
  boundary is the worker and origin, not the JS realm.
- **Outbound network.** Process code can `fetch` any CORS-enabled endpoint from the user's
  browser. Document this for integrators. A capability gate on outbound fetch is an open question.

## Not in scope

The host app's own security, and anything the user explicitly deploys outside ClientVM.
