# Releasing

The packages under `packages/` are published to npmjs.com as `@clientvm/*` by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `v<version>` tag is
pushed. `@clientvm/sandbox-host` is private: it is the static sandbox site you deploy
([hosting guide](hosting.md)), not an npm package.

All publishable packages share one version. The workflow fails if the tag and any package version
differ (`scripts/check-release-version.mjs`), then runs lint, typecheck and unit tests, builds,
copies `LICENSE` and `NOTICE` into each package and runs `pnpm -r publish`. pnpm rewrites
`workspace:*` dependencies to the published version and skips versions already on the registry, so
a failed run can simply be re-run. Every package is published with npm provenance.

## One-time setup

1. Create the `clientvm` organization on npmjs.com (or confirm you own it).
2. Create a granular access token with read and write access to the `@clientvm` scope and add it
   to the repository's Actions secrets as `NPM_TOKEN`.
3. Optional, after the first release: configure each package for trusted publishing (GitHub
   Actions, workflow `release.yml`) on npmjs.com, then remove `NPM_TOKEN`. npm only allows this
   for packages that already exist.

## Cutting a release

```sh
# bump every publishable package to the same version, e.g. 0.2.0
pnpm -r --filter './packages/*' exec npm pkg set version=0.2.0
git commit -am 'Release 0.2.0'
git tag v0.2.0
git push origin main v0.2.0
```

To see what a package would ship without publishing: `pnpm --dir packages/vfs pack --dry-run`.
