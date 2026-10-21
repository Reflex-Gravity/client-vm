# ADR 0004: Memory-first VFS with write-behind OPFS persistence

- **Status:** accepted (2026-10-21), based on [phase2-probes.md](../phase2-probes.md)
- **Context:** An OPFS operation costs 145–375 µs, while an in-memory syscall costs about 10 µs.
  `npm install` and module loading issue tens of thousands of syscalls, so OPFS on the syscall
  path would make the runtime 10–30× slower.
- **Decision:** Syscalls always hit the in-memory `MemoryVfs`. Persistent instances
  (`fs.persist: true`) write behind to the instance origin's OPFS:
  - **Layout:** content-addressed blobs (`blobs/<sha256>`) plus one checkpoint (the inode table,
    referencing blobs by hash) plus `HEAD`.
  - **Flush:** debounced 250 ms after the first change. It writes new blobs, then the checkpoint,
    then `HEAD`, then garbage-collects. A crash at any point leaves `HEAD` on a complete
    generation (unit-tested by crashing at every write).
  - Hashes are cached per buffer, so a flush hashes and writes only data that changed.
  - Checkpoints are encoded in parts, and the flush yields to the event loop between them, so
    syscalls keep being serviced.
  - Boot loads the checkpoint and all blobs eagerly.
  - A Web Lock gives one tab exclusive ownership of an instance's store.
- **Measured (5,000 files, ~15 MB):**
  - Full flush: ~780 ms. Restore boot: ~270 ms.
  - During a flush, NOOP syscalls stay at p50 11.5 µs and p99 159 µs (batch means), with a worst
    single call of ~1.9 ms.
  - A dedicated persistence worker is therefore not justified yet.
- **Consequences:**
  - Writes after the last flush can be lost on crash or tab close. `Instance.flush()` and
    `destroy()` are the durability points; `pagehide` triggers a best-effort flush.
  - Memory use equals the instance's filesystem size, bounded by `quotaBytes`.
  - A journal (incremental checkpoints) and lazy blob loading are possible later optimizations.
    They would cut flush cost for very large trees.
