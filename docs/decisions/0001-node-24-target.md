# ADR 0001: Target Node.js 24 LTS for the compat layer

- **Status:** accepted (2026-10-21)
- **Context:** CLAUDE.md §12 left the Node major version open. The compat layer, the ported Node
  test subset, the `process.version` we report, and the differential tests all need one fixed
  reference.
- **Decision:** Target **Node.js 24 LTS** (`process.version` reports `v24.11.0`). The differential
  tests and CI run on Node 24.
- **Consequences:** API behavior is matched against Node 24. Moving to Node 26 LTS later is a
  deliberate change: bump the reference, rerun the differential suites, and update
  `docs/compatibility.md`.
