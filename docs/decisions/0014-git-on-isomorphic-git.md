# ADR 0014: `git` runs on isomorphic-git, fetched and verified on first use

- **Status:** accepted (2026-10-21)
- **Context:** CLAUDE.md §7 lists `git` among the v1 commands, "via isomorphic-git or
  equivalent". Agents use git to checkpoint work, diff their changes, and branch experiments.
  isomorphic-git (MIT) is a pure-JavaScript implementation that reads and writes real git
  repositories. Its package is about 1.2 MB as a tarball and 5 MB unpacked. Bundling it into the
  shell would add a runtime dependency to a core package (§5) and grow every process worker.
- **Decision:**
  - `git` is a shell command (`packages/shell/src/commands/git.ts`). On first use it downloads
    the pinned release `isomorphic-git@1.44.3` from the registry, checks its SHA-512 integrity,
    and unpacks it into `/usr/local/lib/clientvm/isomorphic-git@1.44.3`, reusing npm's installer
    (ADR 0012). The bundle is evaluated with Node's `Buffer` in scope; the command adapts the
    shell's synchronous filesystem to isomorphic-git's promise API.
  - The command implements git's porcelain on top of isomorphic-git's plumbing and matches real
    git's output. `test/e2e/git.spec.ts` runs the same steps under ClientVM and the host's git
    with fixed dates and compares stdout, exit codes and commit ids.
  - Where isomorphic-git lacks a feature that git's porcelain needs, the command fills it in:
    - `log` walks history in git's date order.
    - Merge conflicts leave `MERGE_HEAD`, `MERGE_MSG` and conflict markers labelled `HEAD`, and
      the next `commit` records both parents. isomorphic-git's index has no conflict stages, so
      unmerged paths are listed in `.git/clientvm-unmerged` until `git add` resolves them.
  - Remote operations use `fetch`. Most git hosts do not send CORS headers, so `clone`, `fetch`,
    `pull` and `push` need a CORS proxy (`GIT_CORS_PROXY`). ClientVM has no server-side component
    and does not provide one.
- **Consequences:**
  - The first `git` call in an instance costs one registry download (about 1.2 MB); later calls
    load the unpacked copy. Upgrading means changing the version and integrity constants and
    re-running `git.spec.ts`.
  - Not supported: an editor (`commit` needs `-m`/`-F`), rebase, cherry-pick, blame, hooks,
    submodules, `.gitattributes`, rename detection.
  - `.git/clientvm-unmerged` is not a real git file. Real git ignores it, and an interrupted
    merge must be finished in ClientVM.
