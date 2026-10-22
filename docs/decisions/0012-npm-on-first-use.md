# ADR 0012: npm is the unmodified release, fetched and verified on first use

- **Status:** accepted (2026-10-21)
- **Context:** CLAUDE.md §2 says to run real npm unmodified on the Node-compat layer. Node ships
  npm inside its distribution, at `<prefix>/lib/node_modules/npm`. ClientVM has no install step and
  ships no Node distribution. npm is about 2.9 MB gzipped and 12.5 MB unpacked (2,160 files). That
  is too large to put in the sandbox-host bundle or in every new instance's file tree.
- **Decision:**
  - `npm` and `npx` are **runtimes**: `npmRuntime` in `@clientvm/node-compat`. Each instance has
    marker files for them on `PATH`.
  - On first use in an instance, the runtime does the following:
    1. It downloads the pinned release `npm@11.6.1` from the registry. This is the release Node
       24.11 bundles.
    2. It checks the tarball's **SHA-512 integrity** against the value pinned in the source.
    3. It unpacks the tarball into a staging directory. A tar reader in node-compat does this; the
       same reader also backs the shell's `tar` command.
    4. It renames the staging directory to `/usr/local/lib/node_modules/npm`, so a half-written
       copy is never used.
    5. It then runs `bin/npm-cli.js` (or `npx-cli.js`) on the node runtime with the user's
       arguments.
  - Later runs use the unpacked copy. Persisted instances keep it through OPFS, and forks keep it
    through CoW. The download goes through the browser's HTTP cache, which instances of one site
    share.
  - `CLIENTVM_NPM_TARBALL` overrides the download URL, for mirrors and offline tests. The integrity
    check still applies to the override.
  - npm's code is not patched. Every gap it hit was fixed in node-compat instead:
    - `readline`
    - `http2` constants
    - `v8` heap statistics
    - a main-thread `worker_threads`
    - `path.win32`
    - configurable `fs.ReadStream`
    - EventEmitter alias identity
    - `util.debuglog`
    - liveness while `import()` loads
- **Consequences:**
  - The first `npm` call in an instance costs about 1 s of network plus unpacking. `npm install`
    of Express and cowsay (110 packages) takes about 11 s cold, and `npm ci` from the lockfile
    about 3 s.
  - Upgrading npm means changing two pinned constants and re-running the e2e suite.
  - Lifecycle scripts run as they would in Node: they are spawned through `/bin/sh` in the
    instance. Package code is hostile by assumption (docs/security.md); the instance boundary
    contains it.
  - Without network access, npm cannot run until the tarball is reachable or provided through the
    override.
