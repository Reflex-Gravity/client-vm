# ADR 0003: One kernel per instance, on the instance's own origin

- **Status:** accepted (2026-10-21). This supersedes the single-host-kernel diagram in the original
  CLAUDE.md §4.
- **Context:** Workers share their origin's storage (OPFS, IndexedDB, Cache Storage),
  `BroadcastChannel`, and service worker. A `SharedArrayBuffer` cannot be posted to a different
  origin. If one kernel on one sandbox origin ran every instance's processes, hostile code in
  instance A could read B's persisted files and talk to B's processes. The kernel couldn't
  prevent it, because those APIs don't go through syscalls.
- **Decision:** Each instance is a hidden iframe on `<id>.<sandbox-domain>`. Its page starts a
  kernel worker, which starts that instance's process workers. The **controller** on the host
  page is the trusted broker for everything that crosses instances: creation, fork, and later
  mailbox, virtual network and capabilities. The controller talks to each kernel over a
  `MessagePort` and treats everything it receives as untrusted.
- **Consequences:**
  - Isolation between instances is enforced by the browser's origin model, not our code. The
    `instances.spec.ts` e2e suite checks it (BroadcastChannel, OPFS).
  - Forks across instances copy data: an image is exported, transferred and imported. Snapshots
    stay copy-on-write inside one kernel.
  - Each instance pays for an iframe plus a kernel worker (about 56 ms to boot, small memory).
  - Cross-instance services (Phase 4) are brokered through the controller. Revisit a dedicated
    hub origin if the controller becomes a bottleneck.
