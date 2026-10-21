# Phase 3 plan: JS tier

Goal (CLAUDE.md §8): Node-compat core modules, CJS + ESM resolution with `exports` maps, the
shell and commands, **real npm** (`npm install` works), Vite dev server with HMR through the
service worker, and a golden React + Vite template running end to end.

## Probes (Chromium 156)

| Question | Result |
|---|---|
| Can a process worker `import()` ES modules served by the instance SW? | **Yes**, including cycles and top-level await |
| npm registry from an isolated instance | Metadata and tarballs send `Access-Control-Allow-Origin: *`, about 0.9 s for metadata + one tarball. A preflight with npm's custom headers (`npm-command`, `pacote-version`, …) gets a 404, so the `https` shim must strip non-safelisted headers |
| Do WebSockets from previews go through the SW? | **No.** HMR needs a `WebSocket` shim injected into preview HTML |
| `CompressionStream` / `DecompressionStream` | Available, but async only (npm needs sync zlib) |

## Decisions

- [ADR 0006](decisions/0006-native-esm-via-service-worker.md): native ESM, served by the instance SW.
- [ADR 0007](decisions/0007-vendor-pako-for-zlib.md): vendor `pako` for zlib.
- [ADR 0008](decisions/0008-sub-origin-per-port.md): one sub-origin per virtual port.

## Slices (each tested and committed separately)

| Slice | Contents | Tested by |
|---|---|---|
| 3a1 | Core modules: `buffer`, `events`, `util`, `url`, `querystring`, `os`, `assert`, `string_decoder`. `fs` returns Buffers | Differential vs real Node (Vitest), e2e |
| 3a2 | CommonJS loader: `node_modules` lookup, `package.json` `main`/`exports`/`imports`, JSON, `require.cache`, `module.createRequire` | Resolver differential vs Node on fixture trees |
| 3a3 | ESM via SW: kernel module route, specifier-rewriting lexer, CJS facades with named exports, `import.meta`, `node x.mjs`, `type: module` | Lexer fuzz/corpus tests, e2e |
| 3b | Async `fs` (callbacks + promises), `stream`, process stdio streams, event-loop liveness for handles, `child_process` basics | Differential, e2e |
| 3c | Shell (parser + interpreter) and builtin commands; `Instance.exec` | Differential vs `bash`/`dash` |
| 3d | `http`/`net` on virtual ports, sub-origin per port, streaming bodies, WebSocket tunnel | e2e (Express) |
| 3e | `crypto` (sync hashes, randomness), `zlib` (pako), `https` via fetch, **`npm install`** | e2e on real packages |
| 3f | Vite + React golden template with HMR | Playwright golden test |
