# ADR 0015: Vendor Node's `lib/path.js` and the passing subset of Node's tests

- **Status:** accepted (2026-10-21)
- **Context:**
  - CLAUDE.md §9 asks for a ported subset of Node's own `test/parallel` suite run against the
    compat layer.
  - Seeded fuzzing (5b) of `path.win32` against Node 24.11 kept finding divergences in edge
    cases: reserved device names, the CVE-2024-36139 drive-letter guard, and UNC roots. Each
    fix to our port was a new chance to differ.
  - `path` is pure string code with no I/O, so Node's own source runs unchanged in a browser.
- **Decision:**
  - **`path`:** `scripts/vendor-node-path.mjs` downloads `lib/path.js` from the v24.11.0 tag and
    checks its SHA-256. It wraps the file in a factory and writes
    `packages/node-compat/src/vendor/node-path.ts`, which is not edited by hand.
    `packages/node-compat/src/path.ts` supplies what the file imports from Node's internals: a
    small primordials shim, the argument validators, `process.cwd()`, and the glob matcher.
  - **Tests:** `scripts/vendor-node-tests.mjs` takes a discovery run's results and copies the
    passing tests from Node's `test/parallel` into `test/conformance/node-tests`, unmodified. It
    also copies `test/common`, the fixtures those tests reference, and Node's LICENSE.
    `test/e2e/node-tests.spec.ts` runs all of them in CI, so a test that stops passing fails the
    build.
  - Vendored files keep Node's license (MIT) and are excluded from formatting, linting and the
    SPDX header check. NOTICE credits them.
- **Consequences:**
  - `path` behaves like Node 24.11 by construction. Upgrading Node means re-running the script
    with a new tag and hash.
  - The test subset is a ratchet: it only grows when a discovery run is re-vendored. Pass rates
    per module are published in compatibility.md.
  - The repository carries about 3.4 MB of Node test files.
