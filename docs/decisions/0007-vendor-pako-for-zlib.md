# ADR 0007: Vendor pako for zlib

- **Status:** accepted (2026-10-21)
- **Context:** npm's tarball pipeline (`minizlib`, `tar`) and many packages use Node's `zlib`,
  which offers synchronous and incremental inflate/deflate. The browser's
  `DecompressionStream` is async only.
- **Decision:** Use [pako](https://github.com/nodeca/pako) (MIT, no dependencies, a port of
  zlib) as the one runtime dependency of `@clientvm/node-compat`, pinned to an exact version
  and bundled into the process worker. This is an exception to the zero-runtime-dependency rule
  (CLAUDE.md §5).
- **Justification:** It is the most widely used JS zlib, its license is compatible with
  Apache-2.0, and it has no transitive dependencies. Writing and fuzzing our own deflate would
  cost far more than auditing pako.
- **Consequences:** Record pako in `NOTICE`. Brotli is out of scope until something needs it.
