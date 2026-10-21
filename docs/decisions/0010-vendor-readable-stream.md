# ADR 0010: Vendor Node's streams (readable-stream) for `stream`

- **Status:** accepted (2026-10-21)
- **Context:** `stream` underlies most of Node's I/O APIs (fs streams, stdio, http, zlib,
  child_process) and much of npm. It is Node's most behavior-sensitive code: buffering,
  backpressure, event ordering, and error and destroy semantics. A re-implementation would be
  thousands of lines that only approximate Node.
- **Decision:** Vendor `readable-stream` **4.8.0** (MIT). It is published by the Node.js team as
  a userland copy of `lib/internal/streams` from Node 18.19.
  - `scripts/vendor-readable-stream.mjs` regenerates
    `packages/node-compat/src/vendor/readable-stream.ts` from the npm tarball, and the file
    records the tarball's integrity hash.
  - The sources are evaluated through a private CommonJS registry on first `require('stream')`.
    Its `buffer`, `events`, `string_decoder` and `process` dependencies are ClientVM's own
    builtins, so streams carry our `Buffer`s and use our `nextTick`. No npm polyfills are
    involved.
- **Consequences:**
  - Behavior is Node 18.19's stream core. The differences from Node 24 that we know about are
    patched at the edges:
    - `fs` read streams use Node 24's 64 KiB `highWaterMark`.
    - `fs` reads deliver on a later tick, as Node's thread-pool reads do.
  - `test/conformance/stream-differential.test.ts` compares behavior with `node:stream`.
  - Upgrading means re-running the script with a newer version and the differential suite.
  - The vendored file is excluded from lint and formatting and keeps its MIT SPDX header.
