# ClientVM: Development Brief

> Feed this file to Claude (Claude Code) at the root of the repo. It is the source of truth for scope, decisions, architecture and the first tasks. Update it as decisions change.

## 1. What we are building

**ClientVM** is an open-source (Apache-2.0), browser-based runtime library, similar in spirit to StackBlitz WebContainers, WebVM and BrowserPod. It runs JavaScript/Node-style workloads, a shell and common Linux commands **entirely in the browser, with no server-side compute**.

Primary use case: an AI-agent app-building platform (Bolt/Lovable-style). Agents build React + Node.js apps; the generated apps run in an in-browser sandbox (no server-side pods). Each agent gets its own filesystem and can spin up its own sandboxed runtimes.

The library must be **production-ready and battle-tested**. That is earned through a defined compatibility target and a serious test harness (section 9), not asserted.

## 2. Decisions already made (do not relitigate without asking)

| Area | Decision |
|---|---|
| Name | **ClientVM** (npm scope `@clientvm/*`, verify availability) |
| License | **Apache-2.0** (add LICENSE, NOTICE, and SPDX headers) |
| Browser target (v1) | **Chromium only** (use OPFS sync access handles, SharedArrayBuffer/Atomics, JSPI where useful) |
| Language | **TypeScript-first. No Rust/WASM in v1.** Keep perf-sensitive modules behind narrow bytes-in/bytes-out interfaces so they can be swapped to Rust/WASM later if profiling justifies it |
| Language support (v1) | **JavaScript/Node only**, targeting **Node.js 24 LTS** (ADR 0001) |
| "Linux" support | A **shell plus popular Linux commands implemented in TS** (like StackBlitz's `jsh`). **No CPU emulator / real Linux VM in v1.** Reserve a `vm` process-type interface for the future |
| Package manager | **Run real npm (then pnpm) unmodified on the Node-compat layer.** No custom installer in v1 (StackBlitz abandoned its custom client, Turbo, for native npm/pnpm/yarn). A fast-path cache can come later |
| Filesystem model | **Dedicated FS per instance** (isolated, copy-on-write forks and snapshots). Merging is an explicit later operation |
| Multi-agent | Each agent owns one or more **instances** and can spawn child instances. Agents may talk to each other through a mailbox and a virtual network, brokered by capabilities |
| Sandbox hosting | **Wildcard subdomains are available** (static hosting only): `<instance-id>.<sandbox-domain>`. Each instance gets its own origin |
| Previews | Private, in-browser only. No shareable preview URLs. Optional deploy step is outside this library |
| Databases | Out of scope for the runtime. SQL (one chosen lib, e.g. SQLite-WASM or PGlite) is the app's concern, not the runtime's |
| Tooling | pnpm 10 via Corepack (`packageManager` pinned), TypeScript 6, Vitest, Playwright, GitHub Actions CI |
| Sync syscall wake | Kernel parks on each channel with `Atomics.waitAsync`; postMessage doorbell kept as fallback (ADR 0002, measured in `docs/spike-results.md`) |

## 3. Non-goals for v1

- Safari / Firefox support
- Native Node addons (node-gyp, sharp, prisma engines, etc.)
- Running arbitrary ELF binaries / x86 or RISC-V emulation
- Python, Go, or other language runtimes
- Raw TCP/UDP networking (browsers cannot)
- A server-side component of any kind (no CORS proxy in the core)

## 4. Architecture

```
Controller (main thread, host app)
   └─ Sandbox origin iframe (static page, wildcard subdomain)
        └─ Host kernel (dedicated worker)
             ├─ Instance A: own VFS, own net namespace, own resource budget
             │     ├─ process: js        (Node-compat, one Worker per process)
             │     ├─ process: builtin   (shell + commands in TS)
             │     └─ process: wasi      (optional later: WASM commands)
             ├─ Instance B: ...
             └─ Shared services: virtual network switch, mailbox bus,
                snapshot store, permission/capability manager
```

### Key concepts

- **Instance**: the sandbox unit (FS + processes + network namespace + budget). Agents create, snapshot, fork, and destroy instances.
- **Process**: runs in a Web Worker. Types: `js`, `builtin`, later `wasi` / `vm`.
- **Syscalls**: asynchronous by default over typed `MessagePort` RPC. **Synchronous syscalls** (needed for `fs.readFileSync` and the like) use `SharedArrayBuffer` + `Atomics.wait` in the process worker, with the kernel servicing the request. This requires cross-origin isolation (COOP/COEP), so the sandbox page must be served with the right headers.
- **Virtual network**: `http.createServer` and `net.listen` register virtual ports. A **service worker** on the instance's sandbox origin routes preview-iframe requests to the in-instance server. Instances can reach each other via `http://<name>.internal:<port>` only if granted.
- **Capabilities**: every cross-instance interaction (mount, channel, port access, spawn) is an explicit capability granted by the parent. Everything flows through the kernel so it is observable and recordable.
- **Outbound network**: browser `fetch` subject to CORS. Document this limitation clearly.

### Security model (critical)

Workers share their origin's storage and credentials. Agent-written code must never run on the host app's origin.

- Runtime executes in a **separate sandbox origin** (not the app's origin), with **per-instance subdomain origins**.
- No cookies/credentials shared with the host app. Sandbox origin must have no ambient authority.
- Resource limits per instance (memory, process count, CPU time, FS quota).
- Treat all agent-supplied code and package contents as hostile.
- Document the threat model in `docs/security.md` early and keep it current.

## 5. Monorepo layout (pnpm workspace, ESM only)

```
clientvm/
├─ CLAUDE.md              # this file
├─ LICENSE  NOTICE        # Apache-2.0
├─ packages/
│  ├─ protocol/           # typed RPC over MessagePort, message schemas, error types
│  ├─ vfs/                # virtual FS: memory + OPFS backends, CoW, snapshots, watchers, symlinks
│  ├─ kernel/             # instance manager, process table, capability manager, resource limits
│  ├─ process/            # worker bootstrap, sync-syscall bridge (Atomics), stdio, signals
│  ├─ node-compat/        # Node core module shims + CJS/ESM resolution
│  ├─ shell/              # shell parser/interpreter + builtin commands
│  ├─ net/                # virtual network switch, service-worker routing, mailbox
│  ├─ sandbox-host/       # static sandbox page, service worker, COOP/COEP setup
│  ├─ agent-api/          # high-level API for agents (fs, exec, spawn-instance, observe)
│  └─ clientvm/           # public entry point re-exporting a stable API
├─ test/
│  ├─ conformance/        # differential + ported Node tests
│  ├─ e2e/                # Playwright (Chromium) golden-project tests
│  └─ fixtures/           # golden project templates (vite-react, express, ...)
├─ docs/
└─ examples/
```

Rules:
- **Zero runtime dependencies in core packages** where feasible (supply-chain risk matters for a sandbox). Dev dependencies are fine. Any runtime dep must be justified in the PR description and be Apache-2.0-compatible.
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`), ESM only, Vitest for unit tests, Playwright for browser tests.
- Every package has a clear public interface; no cross-package deep imports.
- SPDX header on every source file: `// SPDX-License-Identifier: Apache-2.0`.

## 6. Core interfaces (first drafts, refine in Phase 0)

```ts
// @clientvm/clientvm public surface (sketch)
export interface ClientVM {
  createInstance(opts?: InstanceOptions): Promise<Instance>;
  getInstance(id: string): Instance | undefined;
  listInstances(): InstanceInfo[];
}

export interface InstanceOptions {
  name?: string;
  parent?: InstanceId;
  fs?: { from?: SnapshotId | FileTree; quotaBytes?: number; persist?: boolean };
  limits?: { maxProcesses?: number; maxMemoryMB?: number };
  capabilities?: Capability[];
}

export interface Instance {
  readonly id: InstanceId;
  readonly origin: string;                 // e.g. https://<id>.sandbox.example.dev
  fs: FileSystem;
  spawn(cmd: string, args?: string[], opts?: SpawnOptions): Promise<Process>;
  exec(commandLine: string, opts?: ExecOptions): Promise<ExecResult>; // runs via shell
  onPortOpen(cb: (port: number, url: string) => void): Disposable;
  mailbox: Mailbox;
  snapshot(): Promise<SnapshotId>;
  fork(opts?: InstanceOptions): Promise<Instance>;
  grant(to: InstanceId, cap: Capability): Promise<void>;
  destroy(): Promise<void>;
}

export interface Process {
  readonly pid: number;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: Signal): void;
  exit: Promise<{ code: number; signal?: Signal }>;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stat>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  watch(path: string, cb: (e: FsEvent) => void): Disposable;
  mount(path: string, source: MountSource): Promise<void>; // e.g. read-only mount of another instance's dir
}

export interface Mailbox {
  send(to: InstanceName | InstanceId, msg: unknown): Promise<void>;
  onMessage(cb: (from: InstanceId, msg: unknown) => void): Disposable;
}

export type Capability =
  | { kind: 'mount'; from: InstanceId; path: string; readOnly: boolean }
  | { kind: 'channel'; peer: InstanceId }
  | { kind: 'net'; peer: InstanceId; ports?: number[] }
  | { kind: 'spawn-instance'; limits?: Limits };
```

Agent-facing tools (in `agent-api`): `fs.*`, `exec`, `spawnInstance`, `readConsole`, `readNetworkLog`, `getPreviewDOM` / `screenshot` / `driveInput` (driveable preview via an injected agent script and `postMessage` channel).

## 7. Shell and command set (v1)

- **Shell features**: pipes, redirects, `&&` `||` `;`, quoting, globbing, env vars, command substitution, background jobs, script files, exit codes.
- **Commands**: `ls cat cp mv rm mkdir rmdir touch echo pwd cd head tail wc grep find sort uniq cut tr tee xargs env which chmod ln diff tar gzip gunzip curl git node npm npx pnpm` (git via isomorphic-git or equivalent; curl limited by CORS).
- **Basic `sed` in v1; `awk` deferred.**
- Build a **differential test harness**: run the same script on real `dash`/`bash` and on our shell in CI and diff output and exit codes.

## 8. Phases

**Phase 0: Spec and harness.** Finalize interfaces, define the compatibility matrix (target Node major version, required API list, required frameworks), set up the monorepo, CI, Playwright, Vitest, licensing files, and the threat model doc.

**Phase 1: Spike (done; see `docs/spike-results.md`).** Prove the foundation: a VFS (memory backend) plus one process worker that does a **synchronous `fs.readFileSync` via `SharedArrayBuffer` + `Atomics.wait`** against the kernel, running `node -e "console.log(require('fs').readdirSync('/'))"`. Verify under COOP/COEP in Chromium via Playwright. Measure per-syscall latency and report numbers. Do not build outward until this works and the numbers are acceptable.

**Phase 2: Host kernel.** Full VFS (OPFS backend, symlinks, watchers, CoW snapshots/forks, quotas), instance manager, process table, sandbox-origin plumbing and service worker.

**Phase 3: JS tier.** Node-compat shims (`fs path buffer stream events crypto zlib http https net os child_process worker_threads url util assert timers` etc.), CJS and ESM resolution including `exports` maps, shell and commands, **run real npm** (`npm install` works), Vite dev server with HMR through the service worker, and a golden React+Vite template running end to end.

**Phase 4: Multi-instance and agent API.** Mailbox, virtual network between instances, capability grants, mounts, snapshot/fork, the agent-facing tool API, driveable preview.

**Phase 5: Hardening.** Conformance suites, fuzzing (VFS, resolver, shell parser), resource limits, performance work (consider Rust/WASM only where profiling proves need), pnpm support, docs and examples.

## 9. Quality bar ("battle-tested")

- Documented **compatibility matrix**; never claim "Node compatible" generically.
- Ported subset of Node's own `test/parallel` suite run against the compat layer.
- Smoke test: install and import of the top ~1,000 npm packages.
- Golden project templates (Vite+React, Express, etc.) in CI on Chromium via Playwright.
- Differential tests for the shell (vs `dash`/`bash`) and for `fs` behavior (vs real Node).
- Fuzzing for the VFS, module resolver, and shell parser.
- Performance benchmarks tracked in CI (boot time, `npm install` time, syscall latency, memory per instance). Regressions block merges.
- Security review of the sandbox boundary before any 1.0 claim.

## 10. Known constraints to design around

- Cross-origin isolation (COOP/COEP) is required for synchronous syscalls and limits embedding of third-party iframes; document this for integrators.
- Per-tab memory limits; budget memory per instance and enforce limits.
- No `fork()`; process spawn means creating a worker (slower), so keep worker startup lean.
- Service worker lifecycle edge cases (restarts, updates) must be handled and tested.
- Items to **verify against current Chromium** before relying on them: JSPI status, OPFS sync access handle behavior and limits, cross-origin isolation requirements for iframes on wildcard subdomains.

## 11. Working agreements for Claude

1. Start with **Phase 0, then the Phase 1 spike**. Do not skip ahead.
2. Before writing substantial code in a new area, propose the design briefly and flag any decision from section 2 that you believe should change; do not silently deviate.
3. Keep PRs small and tested; every public interface change updates `docs/` and this file if it affects decisions.
4. When unsure about browser behavior, write a minimal test page and **measure** instead of assuming.
5. Prefer standards-based web APIs; avoid dependencies unless justified (see section 5).
6. Record open questions in `docs/open-questions.md` rather than guessing.

## 12. Open questions

The full, current list lives in `docs/open-questions.md`.

- ~~Exact Node major version~~: decided, Node.js 24 LTS (`docs/decisions/0001-node-24-target.md`).
- Which single SQL library the *apps* should use (outside runtime scope; defer).
- CPU-emulator backend for a future `vm` tier (benchmark spike later; consider licensing).
- Whether to add a pre-resolved install-plan / shared package cache fast path after npm works.
- Package scope and domain availability for `@clientvm/*`.
