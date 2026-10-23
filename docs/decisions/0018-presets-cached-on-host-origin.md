# ADR 0018: Presets, built once and cached on the host origin

- **Status:** accepted (2026-10-23)
- **Context:** The common start for an agent or a user is the same: a Vite + React +
  TypeScript project, ready for `npm run dev`. From scratch that costs an `npm ci` (about
  50 packages), plus first-use downloads of rolldown's and lightningcss's WebAssembly stand-ins
  (ADR 0013, about 27 MB) when Vite first reaches for them. Every instance paid this again: each
  runs on its own origin, so nothing one instance downloaded or persisted (OPFS, ADR 0004)
  could help another. Only the browser's HTTP cache was shared, and only for the downloads,
  not the unpacking and installing.
- **Decision:**
  - `createInstance({ preset: 'vite-react-ts' })` starts an instance from a ready-made project
    in `/home/user/app`: its files, its installed `node_modules`, and the stand-ins its
    toolchain uses. It cannot be combined with `fs.from`. A restored persistent filesystem still
    wins over it, as it wins over `fs.from`.
  - A preset is a **template** and a **setup command**. The template is a real project in
    `packages/clientvm/presets/<name>/` with a committed lockfile that pins every package to an
    exact version and sha512 integrity. `scripts/build-presets.mjs` embeds it in
    `src/presets/<name>.ts` with a hash of its files. A unit test fails if the two drift. The
    setup for `vite-react-ts` is `npm ci`, a throwaway `vite build` to fetch the stand-ins, and
    removing `dist` and npm's download cache.
  - **Building:** the first request for a preset starts a hidden **builder** instance. It runs
    the template and setup with the stock runtime (the same npm and stand-in paths as any
    instance), and the controller exports its filesystem image (the format forks use). Then the
    builder is destroyed. Concurrent requests share one build.
  - **Caching:** the image goes into a `PresetStore` owned by the controller. The default store
    is the **host origin's Cache Storage** (cache `clientvm-presets`), so a preset is built once
    per browser profile and host app. Where Cache Storage is unavailable, the store is memory
    for the page's lifetime. Host apps can pass their own store (`ClientVMOptions.presetStore`),
    for example IndexedDB or a store that is preloaded at deploy time.
  - **Keying:** an image is stored under `<name>@<template hash>.<format>`. A changed template,
    or a bumped `PRESET_FORMAT` (for a changed setup or image contents), gets a new key. Storing
    a new version drops older ones of the same preset.
  - Each instance boots from its own copy of the image. Boot transfers the buffers to the
    kernel, and nothing is shared after boot.
- **Why the host origin:** this is the first state ClientVM keeps on the host app's origin.
  Instance origins are per instance and cannot share. A dedicated cache subdomain would keep the
  host origin clean, but it would need another iframe and protocol, and its storage would be
  partitioned under the host's top-level site anyway. The controller is already the trusted
  party on the host page, so it owns the store.
- **Security:**
  - Agent instances never write to the store. Only builders do, and a builder runs only the
    pinned template and setup, never agent code. So one instance cannot plant files in another
    instance's starting image.
  - What a builder installs is what the lockfile pins, integrity-checked by npm, plus stand-ins
    checked against registry integrity (ADR 0013). This is the same trust as running `npm ci` in
    the instance yourself.
  - The image is still treated as untrusted at boot: the kernel validates its structure
    (`importImage`). A truncated or garbled stored image is detected by its framing, dropped, and
    rebuilt.
  - The store is readable by any script on the host origin. It holds only public packages and
    the template, so nothing in it is secret.
- **Consequences:**
  - Measured (`test/e2e/preset.spec.ts`, Chromium, warm HTTP cache): the first `vite-react-ts`
    instance takes about 10 s, building included. Later instances, including after a reload,
    boot in about 0.2 s and make no registry requests.
  - The first build needs the registry. Building in an instance with a limited `quotaBytes`
    is not possible, because builders use the default limits.
  - Cache Storage counts against the host origin's storage quota. One `vite-react-ts` image is
    tens of MB, mostly the stand-ins' WebAssembly. Browsers may evict it under storage pressure,
    which only costs a rebuild.
  - Presets are fixed by ClientVM's release. Custom templates are a possible extension (a
    `FileTree` plus setup, keyed by its hash) but are not part of this change.
  - The open question about a shared package cache (`docs/open-questions.md`) is answered for
    preset projects only. Arbitrary `npm install`s in an instance still download per instance.
