# Phase 5 plan: hardening

Goal (CLAUDE.md §8, §9): conformance suites, fuzzing, resource limits, performance tracking with a
regression gate, pnpm support, docs and examples. The aim is to earn "battle-tested" with
measurements. Nothing is asserted without one.

## Slices

| Slice | Contents | Tested by |
|---|---|---|
| 5a | **Node's own tests.** Run Node 24.11's `test/parallel`, with the real `test/common`, inside instances. A discovery runner records which tests pass for each module. The passing set is vendored (MIT, with Node's license) and runs in CI as a regression suite. Pass rates go into the compatibility matrix | e2e `node-tests.spec.ts` |
| 5b | **Fuzzing.** Seeded random tests for the protocol codec, the tar reader, path (posix and win32, against Node), and the CommonJS resolver (random package trees, against Node's `require.resolve`). Existing: VFS random ops, shell parser | Vitest |
| 5c | **Resource limits.** Caps on process output and the controller's per-process buffers. Per-instance memory measured with `performance.measureUserAgentSpecificMemory()` where Chromium allows it, and `maxMemoryMB` enforced by killing the largest process. A CPU watchdog: a process that does not yield for `maxCpuMs` is killed | e2e |
| 5d | **Benchmarks with a regression gate.** Kernel boot, process spawn, syscall latency, `npm ci` of a fixture from a local mirror, and memory per instance, compared against `bench/baseline.json`. CI fails when a metric gets more than 2x worse (wide, because shared CI runners are noisy) | CI |
| 5e | **pnpm.** A `pnpm` runtime fetched and verified on first use, like npm (ADR 0012) | e2e |
| 5f | **git.** A `git` command for local repositories (`init add commit status log diff branch checkout`) on isomorphic-git, fetched on first use (open question resolved) | e2e |
| 5g | **Examples and docs.** `examples/agent-playground`, a minimal host app wiring a ClientVM instance to agent tools; the security review checklist; updated README and compatibility matrix | build in CI |

## Not in this phase

- The top-1,000 npm package smoke test (§9). The runner is cheap, but a full run needs about an
  hour of registry traffic per run. The runner lands with a curated list of 50 packages. The full
  list stays an opt-in job, tracked in open-questions.md.
- Rust/WASM rewrites. No profile so far shows a hot path that needs one. Syscalls take about
  10 µs, and the time goes to workers and module loading.

## Status

| Slice | State |
|---|---|
| 5a | Done. 592 of Node's tests pass and run in CI (ADR 0015, compatibility.md). Fixes found along the way: Node's global enumerability, `atob`/`btoa` from `buffer`, `node:test`, `util.getCallSites`, `node --check`, shutdown that never calls user-patched builtins |
| 5b | Done. `test/conformance/fuzz.test.ts`; it found the `path.win32` divergences that led to vendoring Node's `path` |
| 5c | Done except `maxMemoryMB` (open question). `maxCpuMs` watchdog, 8 MiB host output caps, host `stdin`, `measureMemory` |
| 5d | Done. `scripts/bench-gate.mjs` against `bench/baseline.json` (3x, memory 2x) |
| 5e | Done. pnpm 10.34.7 on first use; `test/e2e/pnpm.spec.ts`. Fixed on the way: `fs.realpath.native`, Node's enumerable EventEmitter prototype |
| 5f | Done. ADR 0014, `test/e2e/git.spec.ts` |
| 5g | Done. `examples/agent-playground` (built and tested in CI by `example.spec.ts`), [security-review.md](security-review.md), README. The curated npm smoke test (`smoke.spec.ts`, 50 packages) added `diagnostics_channel`, `async_hooks` and `node -v` |
