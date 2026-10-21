# ADR 0008: One sub-origin per virtual port

- **Status:** accepted (2026-10-21). Implemented in Phase 3d; until then ports other than the
  primary are served under `/__port/<n>/`.
- **Context:** Dev servers emit absolute URLs (`/assets/x.js`, `/@vite/client`). Under a
  `/__port/<n>/` prefix those resolve against the wrong server. Previews served from the kernel's
  own origin also share storage with the kernel and processes.
- **Decision:** Each open port gets its own origin, `<id>-p<port>.<sandbox-domain>`. The
  controller links that origin's service worker to the instance kernel by transferring a
  MessagePort through a small bridge page on the port origin.
- **Consequences:** Every port behaves like a real origin, and preview code no longer shares an
  origin with the kernel. The same wildcard DNS works, but instance ids must leave room for the
  `-p<port>` suffix within a 63-character DNS label.
