# Phase 2 probes (Chromium 156, M1 Pro)

These were measured before designing Phase 2 (CLAUDE.md §11.4). The test pages ran a host on
`http://localhost` with instance iframes on `http://a.localhost` and `http://b.localhost`.

## Cross-origin isolation of an iframe

| Instance headers | Host headers | Host COI | Iframe COI | SAB + `Atomics.wait` in iframe worker |
|---|---|---|---|---|
| none | none | no | no | `SharedArrayBuffer` undefined |
| `Document-Isolation-Policy: isolate-and-require-corp` | none | no | **yes** | works |
| COOP + COEP `require-corp`, CORP | COOP + COEP | yes | yes | works (needs `allow="cross-origin-isolated"`) |

## OPFS (sync access handle, dedicated worker)

| Operation | Cost |
|---|---|
| 4 KiB write | ~280 µs |
| 4 KiB read | ~145 µs |
| 1 MiB read | ~380 µs |
| open + close a handle | ~375 µs |
| Quota (not persisted) | ~10 GB |

This is 10–30× slower than an in-memory syscall (~10 µs), so the VFS stays memory-first and
persists to OPFS in the background ([ADR 0004](decisions/0004-memory-first-vfs-opfs-persistence.md)).

## Persistence (after implementation)

Measured by `pnpm bench` with 5,000 files across 100 directories (~15 MB):

| | |
|---|---|
| First full flush | ~780 ms |
| Restore at boot (load checkpoint + all blobs) | ~270 ms |
| NOOP syscall during a flush, batch-mean p50 / p99 | 11.5 / 159 µs (baseline 10.5 / 14 µs) |
| Worst single syscall during a flush | ~1.9 ms (10.5 ms before encoding was made incremental) |
