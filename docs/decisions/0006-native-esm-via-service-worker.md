# ADR 0006: Run ES modules natively, served by the instance service worker

- **Status:** accepted (2026-10-21)
- **Context:** Node packages ship as CommonJS, ESM, or both. Transforming ESM into an
  internal CommonJS format needs a full JavaScript parser, and it can only approximate live
  bindings, cycles, and top-level await.
- **Decision:** Processes load ES modules with the browser's native `import()` from
  `/__clientvm/fs/<absolute path>` on the instance origin. The instance service worker forwards
  these requests to the kernel. The kernel:
  - resolves specifiers using Node's ESM algorithm (`exports`/`imports`, conditions
    `import`/`node`/`default`), with no extension guessing for relative imports;
  - rewrites them with a small TS lexer;
  - serves CommonJS files as ES facades whose named exports are detected lexically, as Node does
    with cjs-module-lexer;
  - serves builtins (`node:fs`) as facades over the process's builtin modules.

  `import.meta.url` is a `file:` URL. A probe confirmed that cycles and top-level await work.
- **Consequences:**
  - Real ESM semantics: live bindings, cycles, top-level await, correct evaluation order.
  - `require()` of an ES module is not supported (native import is async), matching Node
    before 22.12; Node 24 allows it, so this is documented as a gap.
  - Loading an ESM graph costs one SW → kernel round trip per module. Measure on Vite.
  - The kernel transforms modules for all processes in one thread. Measure, and cache per
    (path, mtime) if needed.
