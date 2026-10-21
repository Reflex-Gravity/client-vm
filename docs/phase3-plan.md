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
- [ADR 0009](decisions/0009-cjs-module-lexer.md): Node's cjs-module-lexer for CommonJS named exports.
- [ADR 0010](decisions/0010-vendor-readable-stream.md): Node's streams (readable-stream) for `stream`.
- [ADR 0011](decisions/0011-in-process-shell-commands.md): the shell runs its commands in-process; every command is also a runtime.
- [ADR 0012](decisions/0012-npm-on-first-use.md): npm is the unmodified release, fetched and verified on first use.

## Progress

| Slice | Status |
|---|---|
| 3a1 | done |
| 3a2 | done |
| 3b1 | done: streams (ADR 0010) and async fs |
| 3b2 | done: `child_process` with execve-style command resolution, stdin/stdout streams, handle-based liveness, `fs.watch` |
| 3a3 | done. The instance page now boots its kernel only after the service worker controls it, because workers inherit their controller at creation. This adds about 45 ms to the first boot of each instance. Process spawn rose to about 9 ms as node-compat grew |
| 3d | done: `http`/`https`/`net`/`dns`/`tls` on virtual ports with streamed responses, upgrade sockets and a WebSocket shim for previews; one origin per port (ADR 0008) with a bridge page; `zlib` (pako, ADR 0007) and `crypto` pulled forward from 3e because Express and ws need them. Golden fixture: unmodified Express 4 + ws 8 |
| 3e | done: real npm 11.6.1, unmodified, fetched and integrity-checked on first use (ADR 0012): `install`/`ci`/`run`/`npx`, lifecycle scripts and bin links against the public registry. New in node-compat: `readline`, `http2` constants, `v8`, main-thread `worker_threads`, `path.win32`; dynamic `import()` keeps the process alive. Shell gains `tar`, `gzip`/`gunzip`/`zcat` and `curl`. Closed local ports now refuse connections (`ECONNREFUSED`, curl exit 7) instead of answering 502 |
| 3c | done: `@clientvm/shell` (POSIX sh + common bash extensions) with 50 commands in-process (ADR 0011). About 170 differential scripts vs real bash and GNU tools, a parser fuzz test, and e2e scripts piping between commands and `node`. `Instance.exec` with timeouts; killing a process kills its children. A 10,000-iteration `while` loop takes about 0.4 s in Node (bash: 0.03 s) |

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
