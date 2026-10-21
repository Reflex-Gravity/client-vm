# Phase 4 plan: multiple instances and the agent API

Goal (CLAUDE.md §8): mailbox, virtual network between instances, capability grants, mounts,
snapshot/fork, the agent-facing tool API, and a driveable preview.

Snapshot and fork already work (Phase 2). Everything else in this phase crosses instance
boundaries, so the **controller brokers it** (ADR 0003). Each instance runs in its own origin,
iframe and kernel. Kernels never talk to each other directly. The controller is trusted code on
the host page: it checks every cross-instance request against the capability table, and it treats
every value from a kernel as hostile input.

## Design

### Capabilities (slice 4a)

The controller keeps a table: for each holder instance, a set of the `Capability` values it holds
(the types are in `types.ts`). Each capability names the resource it covers:

| Capability | Lets the holder… | Resource owner |
|---|---|---|
| `{ kind: 'channel', peer }` | send mailbox messages to `peer` | `peer` |
| `{ kind: 'net', peer, ports? }` | reach `http://<peer>.internal:<port>/` (all ports, or the listed ones) | `peer` |
| `{ kind: 'mount', from, path, readOnly }` | mount `from`'s subtree at or under `path` | `from` |
| `{ kind: 'spawn-instance', limits? }` | create child instances (`fork`, `createInstance({ parent })`) within `limits` | none: only the host or a holder can grant it |

- **Who can grant:** the host can grant anything, through `ClientVM.grant(to, cap)` or
  `InstanceOptions.capabilities` at creation. An instance can grant through `Instance.grant(to, cap)`
  in two cases:
  - the capability covers the instance itself (it is the `peer` or `from`); or
  - the instance holds the same capability or a broader one (delegation). For `spawn-instance`,
    the delegated limits must be at least as strict.

  `Instance.revoke(to, cap)` removes a grant. The host can revoke anything; an instance can revoke
  only capabilities over itself.
- **Children:** a child instance's `capabilities` option follows the same rule as `grant`, applied
  to its parent. A child never gets more than its parent could give.
- **Enforcement:** every check happens in the controller. This includes calls the host makes on an
  instance's behalf, such as `instance.mailbox.send`. An agent holding only its own `Instance`
  object cannot reach outside its grants.

### Mailbox (slice 4a)

- Instances are addressed by `name` (unique among live instances) or by id.
- `instance.mailbox.send(to, msg)` requires a `channel` capability to `to`. The message must be
  structured-cloneable JSON data of at most 1 MiB.
- Delivery goes to the target's host listeners (`mailbox.onMessage`) and to the target kernel's
  inbox. The inbox is bounded: 1,000 messages or 8 MiB, oldest dropped first.
- Processes use the mailbox over HTTP, so any language or `curl` can:
  - `POST http://mailbox.internal/send/<to>` with a JSON body: 202, or 403 without the
    capability.
  - `GET http://mailbox.internal/recv?timeout=<ms>`: the next `{ from, message }`, or 204 when
    the timeout passes. This is a long poll.

### Virtual network between instances (slice 4b)

- `fetch`, `http.request` and `curl` in instance A can reach `http://<B>.internal:<port>/`.
- The request path is: process fetch → A's service worker (`/__net/<B>/<port>/…`) → A's kernel →
  controller (checks A's `net` capability for B and the port) → B's kernel router → B's server.
- The response streams back the same way. Its body is a `ReadableStream` that is transferred at
  each hop.
- Only HTTP is supported. WebSocket upgrades and raw `net` sockets between instances are not
  supported yet.

### Mounts (slice 4c)

- `instance.fs.mount(path, source)` requires a matching `mount` capability.
- **Decision:** a mount is a read-only **mirror**, not live remote access. Processes read files
  with synchronous syscalls, and a sync syscall cannot wait on another kernel through the
  controller without a much larger kernel change. So the controller works like this:
  1. It copies the source subtree into the target.
  2. It marks that subtree read-only in the target kernel. Writes fail with `EROFS`.
  3. It keeps the copy in step by applying the source's watch events, typically within
     milliseconds.
- Writable mounts are rejected (`ERR_NOT_SUPPORTED`). Merging changes back is the explicit merge
  operation that CLAUDE.md §2 defers.
- `{ kind: 'snapshot' }` sources are copied once and never change.

### Driveable preview and observability (slice 4d)

- The port-origin service worker injects `/__clientvm/agent.js` into HTML pages, next to the
  WebSocket shim.
- The host connects to the script through a `MessageChannel` and can:
  - read a DOM snapshot (text outline and HTML);
  - click, type and press keys;
  - wait for a selector;
  - navigate;
  - read console messages and errors;
  - take a screenshot. The script renders the DOM through SVG `foreignObject`, so this is best
    effort: cross-origin images and canvases are blank.
- Public API: `instance.openPreview(port, { container })` returns a `Preview` handle.
- The kernel keeps a network log for each instance (method, path, status, duration, bytes) for
  `readNetworkLog`.

### Agent tool API (slice 4e)

- `@clientvm/agent-api` is a new package with zero runtime dependencies.
- `createAgentTools({ vm, instance })` returns tool definitions (name, description, JSON Schema
  input) and `call(name, input)`. The tools are:
  - files: `read_file`, `write_file`, `list_dir`, `delete_path`;
  - commands and processes: `exec`, `start_process`, `read_console`, `stop_process`;
  - instances and messages: `spawn_instance`, `send_message`, `read_messages`;
  - observation: `read_network_log`;
  - preview: `preview_dom`, `preview_click`, `preview_type`, `preview_screenshot`.
- Results are text, or a PNG image for screenshots, so they map directly onto LLM tool-use APIs.
- Every tool works through the agent's own `Instance`, so capabilities bound what an agent can do.

## Deviations from CLAUDE.md to note

- `packages/net` (from the §5 layout) is not created. Cross-instance routing lives in the
  controller because the controller is the broker (ADR 0003). The in-instance parts live in the
  kernel and the service worker.
- Mounts are read-only mirrors (above). §6 sketches mounts generally; this narrows them for v1.

## Progress

| Slice | Status |
|---|---|
| 4a | done: capability table, grant/revoke/delegation, `spawn-instance` gating forks, mailbox (host API and `http://mailbox.internal/`), instance names. Also `/dev/null` and friends |
| 4d | done: driveable preview (agent script injected with an inline early console capture; outline snapshots with refs, click/type/press/waitFor/evaluate/screenshot/navigate; React apps drive through their own event handlers), network log in the kernel router |
| 4c | done: read-only mirrored mounts (initial copy, then batched updates from the source's watch events, about 20 ms), snapshot mounts, `unmount`, `EROFS` enforced in the syscall layer through symlinks; revocation stops the sync |
| 4b | done: `http://<name>.internal:<port>/` through the controller with streamed responses; 403 without a `net` capability, refused connections for closed ports and unknown instances |

## Slices

| Slice | Contents | Tested by |
|---|---|---|
| 4a | Capability table, grant/revoke, mailbox (host and `mailbox.internal`) | e2e: grants, denials, delivery both ways, curl from processes |
| 4b | `<name>.internal` HTTP between instances | e2e: Express in B reached from A with and without `net` |
| 4c | Read-only mirrored mounts, snapshot mounts, `EROFS` | e2e: mount, live updates, write denial |
| 4d | Driveable preview, console capture, network log | e2e: drive the Vite golden app |
| 4e | `@clientvm/agent-api` | unit tests plus e2e of a scripted agent session |
