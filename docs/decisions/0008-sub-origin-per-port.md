# ADR 0008: One sub-origin per virtual port

- **Status:** accepted (2026-10-21), implemented in Phase 3d. Processes inside the instance still
  reach ports through `/__port/<n>/` on the instance origin (that is where their `localhost`
  requests go).
- **Context:** Dev servers emit absolute URLs (`/assets/x.js`, `/@vite/client`). Under a
  `/__port/<n>/` prefix those resolve against the wrong server. Previews served from the kernel's
  own origin also share storage with the kernel and processes.
- **Decision:** Each open port gets its own origin, `<id>-p<port>.<sandbox-domain>`. The
  controller links that origin's service worker to the instance kernel by transferring a
  MessagePort through a small bridge page on the port origin.
- **Consequences:** Every port behaves like a real origin, and preview code no longer shares an
  origin with the kernel. The same wildcard DNS works, but instance ids must leave room for the
  `-p<port>` suffix within a 63-character DNS label: ids are limited to 56 characters and may not
  end in `-p<digits>`.
- **Implementation:** the controller embeds `/__clientvm/port.html` on the port origin. The bridge
  registers the same service worker, says hello, receives a MessagePort whose other end the
  controller handed to the kernel (`linkPort`), passes it to its service worker, and acknowledges.
  Only then is the URL reported. A service worker that restarts or updates asks the bridge, which
  asks the controller for a fresh channel. On a port origin the service worker forwards every
  path except `/__clientvm/*` to the port, injects `/__clientvm/ws-shim.js` into HTML documents,
  and tunnels the shim's WebSockets to the server's `upgrade` handler.
