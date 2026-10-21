# Phase 1 spike results: synchronous syscalls over SharedArrayBuffer

**Status:** spike complete; all exit criteria met. Recommended to proceed to Phase 2.

## What was proven

`node -e "console.log(require('fs').readdirSync('/'))"` runs in a process worker and prints
`[ 'bin', 'etc', 'home', 'tmp', 'usr' ]`, byte-identical to Node 24. It runs against a
kernel-owned in-memory VFS through a blocking `SharedArrayBuffer` + `Atomics.wait` syscall, under
COOP/COEP in Chromium (Playwright, `test/e2e/spike.spec.ts`, 14 tests, both wake mechanisms).

Also covered by the e2e suite: Node-shaped `ENOENT` errors (`message`, `code`, `errno`, `syscall`,
`path`), a 4 MiB write + read through the chunked channel (request and response streaming),
host-to-process file visibility, uncaught errors → exit 1, `process.exit()` from a timer, and
`command not found` → 127.

## Setup

| | |
|---|---|
| Machine | Apple M1 Pro, 16 GiB, macOS 26 |
| Browser | Playwright Chromium 156.0.8078.4, headless |
| Build | `vite build` production bundle, served by `vite preview` with COOP/COEP |
| Channel | 256 KiB payload region per process; larger payloads stream in chunks |
| Method | 10,000 calls per case (500 for 1 MiB) after 1,000 warm-up calls, timed in batches of 50 |

`performance.now()` is coarsened to 5 µs in cross-origin-isolated contexts, so per-call numbers
are quantized; **batch means** (total batch time / 50) are the precise figure.

Reproduce: `pnpm bench` (writes `bench-results.json`).

## Results (two runs, batch-mean µs)

| Case | waitAsync p50 | waitAsync p99 | postMessage p50 | postMessage p99 |
|---|---|---|---|---|
| NOOP round trip | 10.1 / 9.9 | 15.7 / 15.5 | 13.7 / 13.6 | 18.8 / 18.7 |
| `stat` | 15.2 / 14.4 | 21.1 / 17.8 | 16.6 / 16.6 | 25.2 / 25.6 |
| `readFile` 4 KiB | 15.3 / 15.7 | 18.4 / 19.2 | 17.1 / 17.4 | 26.0 / 24.3 |
| `readFile` 1 MiB (4 chunks) | 261 / 249 | 353 / 286 | 244 / 247 | 296 / 281 |

Throughput: about 98k NOOP syscalls/s and about 65k `stat`/s per process with `waitAsync`.
Per-call p99 stayed at or below 25 µs for small calls (with occasional outliers of 0.1–0.5 ms
from GC or scheduling, visible in `max`).

| Startup | waitAsync | postMessage |
|---|---|---|
| Kernel worker boot (page → first RPC reply) | 8.3 / 8.5 ms | (same) |
| First process spawn (cold, fetch + compile bundle) | 5.5 / 5.3 ms | 4.3 / 4.3 ms |
| Spawn → runtime ready, p50 (warm) | 4.1 ms | 3.9–4.0 ms |
| `node -e 0` end to end, p50 (warm) | 4.5 ms | 4.4 ms |

## Against the provisional exit criteria

| Criterion | Target | Measured | |
|---|---|---|---|
| NOOP p50 | ≲ 20 µs | ~10 µs | ✅ |
| NOOP p99 | ≲ 200 µs | ~16 µs (batch), 20 µs (per call) | ✅ |
| `readFile` 1 MiB | ≲ 2 ms | ~0.25 ms | ✅ |
| Process spawn | ≲ 50 ms | ~4–5.5 ms | ✅ |

## Decision: kernel wake mechanism

Default to **`Atomics.waitAsync`** (the kernel parks on each channel's state word). It is about
3.5 µs (27%) faster per small syscall than a postMessage doorbell and needs no message on the hot
path. The two are equivalent for large payloads, where copying dominates. Keep `postMessage` as a
selectable fallback (`SpawnOptions.syscallMode`); both are covered by the same e2e suite. See
[ADR 0002](decisions/0002-syscall-wake-mechanism.md).

## Observations and follow-ups

- `TextDecoder` rejects SharedArrayBuffer-backed views in Chromium; every read copies out of the
  SAB first (`SyscallClient.call` returns a non-shared copy). The cost is included above.
- 1 MiB reads cost about 60 µs per 256 KiB chunk round trip. A larger payload region or
  per-process buffer sizing is a cheap win if module loading profiles show it matters.
- These are single-process numbers. Kernel contention with many concurrent processes (`npm
  install`) is untested: add a multi-process bench in Phase 2.
- Spawn time is dominated by worker creation plus bundle evaluation. The process bundle is 26 kB
  today, and it will grow with node-compat, so track it in CI.
- Numbers come from one development machine. CI runners will differ, so compare trends rather than
  absolute values.
