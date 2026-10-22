# Security review checklist

CLAUDE.md §9 requires a security review of the sandbox boundary before any 1.0 claim. This is the
checklist for that review. The threat model is in [security.md](security.md). Each item says what
must hold, how it is checked today, and its status.

Status: **tested** = an automated test fails if it breaks · **by design** = follows from the
architecture, no dedicated test · **open** = not yet verified or not implemented.

**Overall: not yet reviewed.** The items below have been checked by the authors only. An
independent review, including a manual attempt to break each boundary, is still required.

## 1. Host app ↔ instance (boundary 1)

| # | Property | How it is checked | Status |
|---|---|---|---|
| 1.1 | No instance code runs on the host app's origin | Instances boot in iframes on `<id>.<sandbox-domain>`; `test/e2e/instances.spec.ts` (instances are isolated while the host page is not) | tested |
| 1.2 | The handshake accepts only the parent window at its claimed origin, once | `packages/sandbox-host/src/instance.ts` checks `event.source` and `event.origin`; the controller pins `targetOrigin` | by design |
| 1.3 | The controller validates every value an instance sends (RPC replies, events, controller RPC requests) | `packages/clientvm/src/validate.ts`; `validate.test.ts` feeds every guard 3,000 random values and requires a well-formed result or `ERR_INSTANCE_PROTOCOL` | tested |
| 1.4 | A hostile instance cannot make the controller throw, hang, or allocate without bound | `packages/protocol/src/rpc.test.ts`: 5,000 seeded malformed messages never throw, method names never reach `Object.prototype`, a throwing handler does not break the link. Output caps (8 MiB per stream); at most 64 port origins (bridge iframes) per instance (`instances.spec.ts`). A crashed or unresponsive kernel is detected by a heartbeat and its calls reject with `ERR_INSTANCE_CRASHED` instead of hanging (`instances.spec.ts`). Output for pids the controller did not spawn is dropped. Not bounded yet: the rate of mailbox and `netFetch` requests | tested; **open**: rate limits for controller RPC |
| 1.6 | A crashed instance does not take down the host page or other instances | `instances.spec.ts` crashes one instance's renderer (CDP `Page.crash`) and checks the host page and another instance still work | tested |
| 1.5 | `frame-ancestors` restricts embedding in production deployments | Documented in hosting.md; the dev server supports `CLIENTVM_FRAME_ANCESTORS` | by design (deployment) |

## 2. Instance ↔ instance (boundary 2)

| # | Property | How it is checked | Status |
|---|---|---|---|
| 2.1 | Filesystems, OPFS, BroadcastChannel and service workers are per instance | `instances.spec.ts` (filesystems isolated; no reach via BroadcastChannel or OPFS) | tested |
| 2.2 | Every cross-instance interaction needs a capability held in the controller | `multi.spec.ts` (grants, delegation, revocation; `.internal` HTTP only with `net`; `spawn-instance` gates forks and bounds limits; mounts) and `packages/clientvm/src/capabilities.test.ts` | tested |
| 2.3 | Children never get more than their parent could grant | `capabilities.test.ts`, `multi.spec.ts` (fork limits) | tested |
| 2.4 | Mailbox messages are re-serialized, so instances never share objects | `packages/clientvm/src/controller.ts`; `multi.spec.ts` | tested |
| 2.5 | Read-only mounts reject every write path, including through symlinks | `multi.spec.ts` (mounts), kernel unit tests (`EROFS`) | tested |
| 2.6 | An instance id never collides with another instance's port origin (`-p<digits>`) | `PORT_SUFFIX` check in `packages/clientvm/src/controller.ts` | by design |
| 2.7 | Site isolation: whether Chromium puts same-site instance origins in separate renderer processes | Measured on Chromium 141 with `*.localhost` origins: each instance iframe is an out-of-process frame, the renderer count grows with each instance, and crashing one instance's renderer leaves the host page and other instances running (1.6). In every run the instance frames were in different processes from the host page. Not yet measured on a real registrable domain, where Chromium may consolidate same-site frames under memory pressure | tested (localhost); **open**: repeat on a production domain; recommend the Public Suffix List |

## 3. Kernel ↔ process (boundary 3)

| # | Property | How it is checked | Status |
|---|---|---|---|
| 3.1 | The kernel decodes every syscall defensively (`EINVAL`/`ENOSYS`, never a crash) | `packages/kernel/src/dispatcher.test.ts`; codec fuzzing in `test/conformance/fuzz.test.ts` | tested |
| 3.2 | Each process has its own syscall channel; processes cannot read each other's traffic | One SharedArrayBuffer per process (`packages/kernel/src/kernel.ts`) | by design |
| 3.3 | Process limits: `maxProcesses`, 1024 open files, `quotaBytes`/`maxInodes`, `maxCpuMs` | `instances.spec.ts` (process limit, `ENOSPC`), `threads.spec.ts` (`maxCpuMs`), `dispatcher.test.ts` (`EMFILE`) | tested |
| 3.4 | Memory per instance is bounded | `maxMemoryMB` is accepted but not enforced | **open** |
| 3.5 | Threads and forked children obey the same limits as processes | They are kernel processes (`threads.spec.ts`) | tested |
| 3.6 | The kernel shares its origin with hostile code, so a process may tamper with the kernel; the damage stays in that instance | Follows from 2.1 and 1.3 | by design |

## 4. Service workers and previews

| # | Property | How it is checked | Status |
|---|---|---|---|
| 4.1 | `/__clientvm/*` is never routed to instance servers | `preview.spec.ts` (ClientVM files are never routed to the app server) | tested |
| 4.2 | Each port has its own origin, separate from the kernel's | `preview.spec.ts` (each port has its own origin) | tested |
| 4.3 | A replaced or restarted service worker is re-linked, and only by the instance page | `preview.spec.ts` (SW stopped; new SW version) | tested |
| 4.4 | The preview agent talks only to its parent, and the host validates what it returns | `drive.spec.ts`; `packages/clientvm/src/preview.ts` | tested |
| 4.5 | Preview output given to an LLM is data, not instructions (prompt injection) | Documented in agent-api.md; integrators must handle it | **open** (integrator guidance only) |

## 5. Supply chain

| # | Property | How it is checked | Status |
|---|---|---|---|
| 5.1 | npm, pnpm and isomorphic-git are pinned by SHA-512 | `packages/node-compat/src/npm.ts`, `pnpm.ts`, `packages/shell/src/commands/git.ts`; install fails on mismatch | tested (`checkIntegrity` in `test/conformance/tar-differential.test.ts`) |
| 5.2 | esbuild-wasm and @rollup/wasm-node are checked against the registry's published integrity | ADR 0013 | by design |
| 5.3 | Core packages have zero runtime dependencies; vendored code is pinned and credited | `packages/*/package.json`; vendored files checked by hash (`scripts/vendor-node-path.mjs`); NOTICE | by design |

## 6. Deployment

| # | Property | How it is checked | Status |
|---|---|---|---|
| 6.1 | The sandbox domain is a separate registrable domain, sets no cookies and has no authenticated endpoints | hosting.md requirements | by design (deployment) |
| 6.2 | Required headers are sent on every instance response | `scripts/check-sandbox-headers.mjs <url template>` checks a deployment (isolation headers, no cookies, `frame-ancestors`, service-worker scope and caching, wildcard port origins); `hosting.spec.ts` runs it against the preview server in CI | tested (dev server); integrators run it on their deployment |
| 6.3 | Outbound `fetch` from instances can reach any CORS-enabled endpoint from the user's browser | Documented; no capability gate | **open** (design question in open-questions.md) |

## Before 1.0

1. Close or explicitly accept every **open** item above.
2. Commission an independent review of boundaries 1–3 with this list as its starting point.
3. Record the outcome here, with the commit reviewed.
