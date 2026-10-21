# ADR 0009: Use cjs-module-lexer for CommonJS named exports

- **Status:** accepted (2026-10-21)
- **Context:** When an ES module imports a CommonJS module, Node exposes the named exports that
  `cjs-module-lexer` detects in the source. `import { useState } from 'react'` works because
  the lexer follows React's `module.exports = require(...)` re-exports. Whatever that lexer
  returns *is* the specification. A re-implementation tested against the real lexer on 1,500
  package files matched only 55% of them exactly. Its heuristics (unsafe getters, star-export
  bindings, last-reexport-wins, object literal rules) are what make Node's behavior.
- **Decision:** Use `cjs-module-lexer` itself as a runtime dependency of `@clientvm/kernel`,
  pinned to **2.1.0**, the version bundled with Node 24.11. The kernel uses it when serving a
  CommonJS file as an ES facade.
- **Justification:** It is Node's own component (MIT, no dependencies, about 30 kB). Using it
  gives exact fidelity, and any other choice would be an approximation of it.
- **Consequences:**
  - The package's ESM build is WebAssembly, initialized synchronously on first use in the
    kernel worker.
  - Bump the pin together with the Node target ([ADR 0001](0001-node-24-target.md)).
  - The ESM side uses our own lexer. It matches `es-module-lexer` exactly on the 793-file
    corpus and also returns the import-clause details the rewriter needs.
