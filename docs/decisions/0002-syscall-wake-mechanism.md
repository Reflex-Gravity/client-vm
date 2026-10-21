# ADR 0002: Wake the kernel with Atomics.waitAsync for sync syscalls

- **Status:** accepted (2026-10-21), based on [spike results](../spike-results.md)
- **Context:** A process blocks in `Atomics.wait` after posting a syscall into its shared channel.
  The kernel worker must notice the request without blocking its own event loop, which also serves
  async RPC. The candidates were (A) parking on each channel with `Atomics.waitAsync`, and (B) a
  postMessage "doorbell" from the process.
- **Decision:** Default to (A). Keep (B) as a per-process option.
- **Evidence:** NOOP round trip of ~10 µs (A) vs ~13.7 µs (B) batch-mean p50. The two are equal for
  1 MiB reads.
- **Consequences:** The kernel holds one pending `waitAsync` per live process, which is cheap. If a
  future Chromium change regresses `waitAsync`, switch the default to (B) without protocol changes.
