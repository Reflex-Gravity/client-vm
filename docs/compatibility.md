# Compatibility matrix

ClientVM does not claim generic "Node compatibility". This page is the source of truth for what
works, how it is tested, and the known gaps.

- **Node target:** Node.js **24 LTS** (`process.version` = `v24.11.0`). See [ADR 0001](decisions/0001-node-24-target.md).
- **Browser:** Chromium only, cross-origin isolated (COOP `same-origin` + COEP `require-corp`).
  Verified on Chromium 156. Instance pages rely on `Document-Isolation-Policy` (host apps need no
  COOP/COEP), `Atomics.waitAsync`, and nested module workers. The exact minimum version is still to
  be pinned by testing older Chromium builds (see open-questions.md).
- **Required frameworks (v1 goal):** Vite + React dev server with HMR, Express. Both work as
  golden fixtures: Express 4 + ws 8, and a stock Vite 6 + React 18 project (dev server, React Fast
  Refresh, CSS HMR, error overlay, `vite build`).
- **Native packages:** native addons and binaries do not run. esbuild and rollup are replaced by
  their official WebAssembly builds of the same version (ADR 0013); other native addons fail
  with `ERR_DLOPEN_FAILED`.

Status legend: **none** = not implemented · **partial** = subset, see gaps · **full** = matches Node for all tested behavior.

## Core modules

| Module | Status | Tested by | Known gaps |
|---|---|---|---|
| `fs` (sync) | partial | e2e fs differential vs real Node, fs differential + seeded random-op fuzz vs `node:fs` | Paths: `readFileSync writeFileSync appendFileSync readdirSync statSync lstatSync existsSync mkdirSync rmdirSync unlinkSync rmSync renameSync linkSync symlinkSync readlinkSync realpathSync(.native) accessSync chmodSync utimesSync truncateSync copyFileSync`. Fds: `openSync closeSync readSync writeSync fstatSync ftruncateSync`. Returns `Buffer`; all Buffer encodings; fds accepted by `readFileSync`/`writeFileSync`; no `opendirSync`, `cpSync`, `watch` (VFS watchers exist, not yet exposed), `fchmod`/`futimes`, `fsync` |
| `fs` (callback / promises) | partial | e2e diffed against real Node | Callback and `fs.promises` APIs for every sync API, `FileHandle`, `Dir`/`opendir`, `mkdtemp`, `cp`, recursive `readdir`, `createReadStream`/`createWriteStream` (ranges, `fd`, events). Operations run synchronously and complete on a later tick. `watch`, `watchFile`, `fs.promises.watch` via kernel VFS watchers. Not yet: `glob`; `statfs` returns fixed values |
| `path` | full | path differential and seeded fuzzing vs `node:path.posix` and `node:path.win32`, Node's own `test-path-*` | Node 24.11's `lib/path.js`, vendored unmodified (`scripts/vendor-node-path.mjs`, checked by SHA-256) and run with a primordials shim, so `posix`, `win32`, `matchesGlob` and the Windows reserved-name rules are Node's code |
| `util` | partial | inspect + events + modules differentials vs `node:util`, e2e | `format`, `inspect` (custom inspect, depth), `types`, `promisify`/`callbackify`, `inherits`, `deprecate`, `isDeepStrictEqual`, `parseArgs` (common cases), `debuglog`, `getCallSites`, legacy `isX`. No `showHidden` (`%o`), colors, Proxy detection, `MIMEType`, `TextEncoder` streaming options |
| `console` | partial | e2e spike | `table` prints like `log`. No `Console` class |
| `process` | partial | e2e | EventEmitter with `exit`, `beforeExit`, `uncaughtException`, `unhandledRejection`, `warning`; `stdin` is a Readable over the kernel pipe, `stdout`/`stderr` are Writables (not TTYs); liveness follows referenced handles (timers, children, stdin while read, watchers, in-flight `fetch`) with `ref`/`unref`. No signals delivered to the process. `arch` reports `x64` |
| `timers` | partial | e2e | Node `Timeout` objects with `ref`/`unref`/`refresh`/`hasRef`; `setImmediate` is a macrotask. Promise-only work (other than `fetch`) does not keep the process alive |
| `fs` on fds 0–2 | partial | e2e (esbuild-wasm service) | `fs.read(0)` reads stdin asynchronously; `write`/`writeSync` to 1 and 2 go to stdout/stderr; `fstat` reports pipes. `readSync(0)` fails with `EAGAIN` (a sync read would block the worker) |
| module loading (CommonJS) | full (tested surface) | resolution differential vs `require.resolve` (69 cases), e2e project diffed against real Node | `node_modules` lookup, `main`, `exports`/`imports` (conditions `require`, `node`, `node-addons`), self-reference, symlinks (realpath), JSON, cycles, `require.cache`, `require.extensions`, `createRequire`, `Module._load`/`_resolveFilename`/`_compile` hooks, `NODE_PATH`. **`require()` of ES modules is not supported** (`ERR_REQUIRE_ESM`; Node 24 supports it), so the `module-sync` condition is not used. Native addons (`.node`) fail with `ERR_DLOPEN_FAILED`, except rollup's binding (ADR 0013) |
| module loading (ESM) | full (tested surface) | ESM resolution differential vs Node `import()` (34 cases), lexer differential vs es-module-lexer (793 files), e2e project diffed against real Node | Native browser ESM through the instance service worker (ADR 0006): `exports`/`imports` with `import`/`node`/`module-sync`, CommonJS interop with Node's named exports (cjs-module-lexer, ADR 0009), builtins, `import.meta` (`url`, `filename`, `dirname`, `resolve`, `main`), top-level await, cycles, JSON with `with { type: 'json' }`, `import()` from CommonJS and eval, `type`-less `.js` syntax detection. Not supported: `export * from` a builtin, `--input-type=module`, loader hooks (`module.register`), `.wasm` imports. Errors are Node's codes and messages, but a failed static import throws when its module would evaluate, not before the whole graph links |
| `buffer` | full (tested surface) | Buffer differential vs `node:buffer` (thousands of cases: encodings, search, numeric reads/writes, errors), e2e | `Buffer` is a callable function sharing `FastBuffer.prototype`, as in Node. `Blob`/`File` are the browser's. No `transcode` for exotic encodings |
| `events` | full (tested surface) | events differential vs `node:events`, e2e | `EventEmitter` (callable for legacy `EventEmitter.call(this)`), `once`, `on`, captureRejections, errorMonitor, max-listener warnings. `EventTarget` helpers partial |
| `stream` | full (tested surface) | stream differential vs `node:stream`, e2e | Node's own implementation (readable-stream 4.8, Node 18.19 core; ADR 0010): Readable/Writable/Duplex/Transform/PassThrough, `pipeline`/`finished`/`compose`, iterator helpers, `stream/promises`, `stream/consumers`, `stream/web` (browser globals). `Readable.fromWeb`/`toWeb` not yet |
| `crypto` | partial | crypto differential vs `node:crypto` | Synchronous `createHash`/`hash` (md5, sha1, sha224, sha256, sha384, sha512 and OpenSSL aliases), `createHmac`, `pbkdf2(Sync)`, `randomBytes`, `randomFill(Sync)`, `randomInt`, `randomUUID`, `getRandomValues`, `timingSafeEqual`; `webcrypto`/`subtle` are the browser's. Not available (throw `ERR_CLIENTVM_UNSUPPORTED`): ciphers, sign/verify, key pairs, scrypt, ECDH. `Hash` is not a stream |
| `zlib` | partial | zlib differential vs `node:zlib` | pako 2.1 (ADR 0007): sync, callback and stream APIs for deflate/inflate/gzip/gunzip/raw/unzip, `crc32`, Node's error codes, and the `_processChunk`/`_handle` internals minizlib uses. No brotli (absent, so feature detection falls back). `params()` cannot change the level mid-stream |
| `querystring` | full (tested surface) | modules differential vs `node:querystring` | |
| `string_decoder` | full (tested surface) | modules differential | utf16le surrogate pairs split at an odd byte decode correctly (Node emits U+FFFD) |
| `timers/promises` | partial | | `setTimeout`, `setImmediate`, `scheduler` |
| `http` / `https` | partial | e2e: unmodified Express 4 + ws 8 (golden fixture) | Servers listen on virtual ports; previews reach them on their port origin (ADR 0008). Requests and responses stream; `upgrade` gets a raw socket (WebSockets from previews go through an injected shim). `IncomingMessage`/`ServerResponse`/`Server` are Node-shaped (Express extends their prototypes). Request bodies are buffered by the service worker. `https.createServer` serves plain HTTP (TLS is the browser's). Clients use `fetch`: `localhost`/`127.0.0.1` reach this instance's ports; other hosts are cross-origin fetches that need CORS, follow redirects themselves, and drop headers that force preflights (`user-agent`, `npm-*`, ...); compressed responses arrive decoded. Agents are accepted and ignored |
| `net` | partial | e2e | `createServer`/`connect` between processes of one instance on virtual ports (half-close supported); `isIP*`; non-local hosts fail with `ECONNREFUSED`. No Unix sockets |
| `dns` | partial | | `lookup` resolves local names to loopback and other names to `0.0.0.0` (requests go through fetch by name); `resolve*` fail with `ENOTFOUND` |
| `tls` | partial | | Loadable; `connect` fails (the browser does TLS inside fetch); `createServer` is a plain `net` server |
| `os` | partial | e2e | A fixed Linux identity (`hostname` `clientvm`, `x64`); CPU count from the browser. Memory figures are nominal |
| `module` | partial | e2e | `Module` with Node's internal hooks, `createRequire`, `builtinModules`, `isBuiltin`. `register()` (loader hooks) is a no-op |
| `vm` | partial | | Runs in the process's own realm; `runInNewContext` uses `with` over the sandbox object (no separate globals) |
| `tty`, `perf_hooks`, `sys` | partial | | `isatty()` is always false |
| `child_process` | partial | e2e diffed against real Node, Node's `test-child-process-*` | `spawn`, `exec`, `execFile` (+ promisified), `spawnSync`, `execSync`, `execFileSync`, `fork`; stdio `pipe`/`inherit`/`ignore`/`ipc`, `input`, `cwd`, `env`, `timeout`, `killSignal`, `signal`, `maxBuffer`; Node's `exit`/`close` ordering and spawn errors (`ENOENT`, `EACCES`, `ENOEXEC`). Commands resolve like `execve`: `PATH`, exec bits, shebangs incl. `/usr/bin/env -S`, `node_modules/.bin` symlinks. `shell: true` and `exec` run through `/bin/sh`. IPC (`fork`, `stdio: 'ipc'`): `send`/`message`/`disconnect` both ways with `json` or `advanced` (structured clone) serialization; handles (sockets, servers) cannot be sent. Not yet: `detached`, signals other than TERM/KILL/INT/HUP/XCPU |
| `worker_threads` | partial | e2e, Node's `test-worker-*` | `Worker` (file, `eval: true`, `data:` URLs), `workerData`, `parentPort`, `MessageChannel`/`MessagePort` (ports can be transferred), `SharedArrayBuffer` and `Atomics` across threads, `terminate()` (exit code 1), `error`/`exit`/`online` events, `env` and `SHARE_ENV`, environment data. A thread is a process in the kernel (one Web Worker) linked to its parent by a `MessagePort`. Not supported: `receiveMessageOnPort` (returns `undefined`), `resourceLimits` enforcement, `getHeapSnapshot`, `BroadcastChannel` across instances |
| `diagnostics_channel` | full (tested surface) | diagnostics-channel differential vs Node | Channels, `subscribe`/`unsubscribe`, `tracingChannel` with `traceSync`/`tracePromise`/`traceCallback`. `bindStore`/`runStores` publish and run, but without store context (see `async_hooks`) |
| `async_hooks` | partial | e2e compared with Node | `AsyncLocalStorage` (`run`, `exit`, `getStore`, `enterWith`, `disable`, `bind`, `snapshot`) and `AsyncResource`. Context follows synchronous calls, timers, `setImmediate`, `process.nextTick` and bound callbacks, **but not promise continuations or `await`** (browsers have no async context hook yet). `createHook` hooks never fire |
| `test` (`node:test`) | partial | e2e | `test`/`it`/`describe`/`suite` with hooks, `skip`/`todo`/`only`, subtests, `t.assert`, `mock.fn`/`mock.method`, TAP output, non-zero exit on failure. No `--test` runner CLI, coverage, snapshot tests or `mock.timers` |
| `readline` / `readline/promises` | partial | e2e (npm) | `createInterface` over any readable: `line`/`close` events, `question` (callback and promise), `prompt`, async iteration, `\r\n` handling; cursor helpers write ANSI codes. No line editing, history or completion (stdio is never a TTY) |
| `http2` | partial | | `constants` only (header, method and status names). `connect`/`createServer` throw `ERR_CLIENTVM_UNSUPPORTED` |
| `v8` | partial | | `getHeapStatistics` from Chromium's `performance.memory`; `serialize`/`deserialize` use JSON, not V8's wire format; no heap snapshots |
| `url` | partial | url differential vs `node:url` | WHATWG `URL` (browser), legacy `parse`/`format`/`resolve`, `fileURLToPath`/`pathToFileURL`, `urlToHttpOptions`. `domainToUnicode` is identity |
| `assert` | partial | assert differential vs `node:assert` | All common assertions, strict mode, `AssertionError` shape. Diff-style messages for objects are simplified |

## CLI

| Command | Status | Notes |
|---|---|---|
| `node -e/-p/--eval/--print <code>` | partial | Runs in global scope with `require`, `module`, `exports` |
| `node <script.js>` | partial | CommonJS and ESM entry points (`.mjs`, `"type": "module"`, detected ESM syntax) |
| `node -v` / options | partial | `-v`/`--version`. Options that only tune V8 or diagnostics (`--no-warnings`, `--max-old-space-size=`, `--experimental-*`, `--enable-source-maps`, `--stack-size=`, ...) are accepted and ignored. Others (`--inspect`, `-r`, `--import`, `--test`) fail with exit code 9 |
| `node --check` / `-c` | partial | Parses without running (CommonJS with `Function`, ESM by linking a copy with its imports blanked). Errors show the file and the message; the source line and caret are not shown |
| `node` (REPL) | none | |
| `sh` / `bash` | partial | See [Shell](#shell) |
| Linux commands | partial | See [Commands](#commands) |
| `npm` / `npx` | partial | npm 11.6.1, unmodified, fetched and integrity-checked on first use (ADR 0012). Tested in e2e: `init`, `pkg`, `install` from the public registry (110-package tree), `ci`, `ls`, `run`, lifecycle scripts, bin links, `npx`. Registry traffic is CORS `fetch` (the registry allows it). Not yet tested: git dependencies, private registries with auth, `npm publish` |
| `pnpm` / `pnpx` | partial | pnpm 10.34.7, unmodified, fetched and integrity-checked on first use (as npm, ADR 0012). Tested in e2e: `init`, `add`, the content-addressed store and `.pnpm` symlink layout, `install --frozen-lockfile`, `run`, `exec`, `pnpx`, workspaces with `workspace:*` and `--filter` |
| npm packages | partial | `test/e2e/smoke.spec.ts` installs 50 popular pure-JavaScript packages with npm and loads each (require or import) with a functional check: React, Express, Fastify, Koa, socket.io, axios, lodash, zod, TypeScript, Sass, Vue, Svelte, three, GraphQL, cheerio and others. Packages with native addons are out of scope (§3) |

## Node's own tests

`test/conformance/node-tests` holds the tests from Node 24.11's `test/parallel` that pass inside
an instance, unmodified, with the real `test/common` (MIT; see that directory's LICENSE).
`test/e2e/node-tests.spec.ts` runs all of them in CI; a test that stops passing fails the build.
A discovery run (`scripts/vendor-node-tests.mjs` documents it) re-runs every test for the
prefixes below and refreshes the set. Tests that skip themselves (`1..0 # Skipped`, for example
because there is no OpenSSL) count as skipped, not passed.

| Prefix | Pass / run | Skipped | Notes |
|---|---|---|---|
| `path` | 13 / 15 | 1 | |
| `stream`, `stream2`, `stream3` | 165 / 199 | 1 | |
| `event`, `events` | 25 / 35 | | |
| `fs` | 105 / 307 | 8 | Many use `fs.watch` timing, permissions or `/proc` |
| `buffer` | 29 / 64 | | |
| `http` | 66 / 365 | 7 | Many need real sockets (`net.Socket` internals, `server.address()` details) |
| `net` | 18 / 143 | 3 | |
| `child-process` | 19 / 105 | 2 | Many spawn `process.execPath` with flags we do not support |
| `worker` | 41 / 128 | 7 | |
| `timers` | 22 / 58 | | |
| `zlib` | 14 / 58 | 1 | No brotli |
| `vm` | 18 / 92 | | Contexts share the process realm |
| `process` | 17 / 88 | 4 | |
| `require`, `module` | 20 / 48 | 3 | |
| `url`, `querystring`, `string` | 7 / 21 | | |
| `util`, `assert`, `console` | 8 / 67 | | Mostly exact `inspect` output and assertion message formats |
| `readline`, `tty`, `os`, `dns` | 5 / 59 | | No TTY; `dns` has no resolver |
| `crypto`, `https` | 0 / 0 | 178 | All skip: no OpenSSL |
| **Total** | **592 / 1889** | **215** | Of 2104 tests matched by these prefixes |

## Shell

One interpreter serves `sh`, `bash`, `/bin/sh` and `/bin/bash`. It implements POSIX `sh` plus the
bash extensions agents commonly write. Tested by `test/conformance/shell-differential.test.ts`:
about 175 scripts run under real bash 5.2 and under ClientVM, and stdout, stderr and exit status
must match. Parser fuzzing is in `packages/shell/src/parser.test.ts`; e2e coverage, including
pipes to and from `node`, is in `test/e2e/shell.spec.ts`. Design:
[ADR 0011](decisions/0011-in-process-shell-commands.md).

| Feature | Status | Notes |
|---|---|---|
| Lists, pipelines, `&&` `\|\|` `;` `&`, `!`, `\|&` | full (tested surface) | `set -o pipefail` |
| Quoting: `'...'`, `"..."`, backslash, `$'...'`, `$"..."` | full (tested surface) | |
| Expansions: parameters, `${x:-}` `:=` `:?` `:+`, `#` `##` `%` `%%`, `/` `//` `/#` `/%`, `:off:len`, `^^` `,,`, `${#x}`, `${!x}` | full (tested surface) | `${@:n:m}` slices positional parameters |
| Command substitution `$(...)` and backquotes, arithmetic `$((...))` | full (tested surface) | 64-bit wrapping integers, bash operators and error messages |
| Field splitting (IFS), pathname expansion (`*` `?` `[...]`, classes), tilde, brace expansion (`{a,b}`, `{1..10..2}`) | full (tested surface) | `shopt -s nullglob dotglob failglob nocasematch`. No `extglob` |
| Redirections: `<` `>` `>>` `>\|` `<>` `n>&m` `n>&-` `&>` `&>>`, heredocs (`<<`, `<<-`, quoted), `<<<` | full (tested surface) | `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` |
| `if` `while` `until` `for` (incl. `for ((;;))`) `case` (`;;` `;&` `;;&`) `{ }` `( )` functions (`f()`, `function f`), `[[ ]]` (incl. `=~`), `(( ))` | full (tested surface) | `BASH_REMATCH` holds only the whole match (no arrays) |
| `set -euxfCa`, `set -o pipefail`, `trap ... EXIT` | full (tested surface) | Other traps are stored but never fire (no signals are delivered) |
| Builtins: `cd pwd echo printf test [ true false : export unset readonly local declare typeset set shift exit return break continue read eval source . exec command type hash wait jobs trap umask let getopts alias unalias shopt pushd popd dirs builtin times` | partial | `printf -v`, `read -r -d -n -p -u`. `alias` stores aliases, but non-interactive bash does not expand them, and neither do we |
| Scripts: `sh file`, `./file` with shebang, `sh -c 'cmd' name args`, script on stdin | full (tested surface) | Run one complete command (line) at a time, like bash. Syntax errors use bash's two-line format |
| Background jobs `&`, `wait`, `$!` | partial | Run in the shell's worker; they end when the shell exits. Spawned programs keep running |
| Process substitution `<(cmd)` | partial | Implemented with a temp file (the command finishes first). `>(cmd)` is not supported |
| Arrays (`a=(...)`, `${a[@]}`), `mapfile`, `select`, `coproc`, `time`, job control, history | none | `declare -a` and `read -a` fail with a clear error |
| `type`/`declare -f` printing function bodies | none | `type -t` works |
| Locale | partial | Text is UTF-8 (`LANG=C.UTF-8`). `LC_ALL=C` byte semantics (e.g. `${#x}` in bytes) are not emulated |

## Commands

Commands run in the shell's own worker when invoked from the shell, and as their own process when
spawned (`child_process.spawn('ls')`). Behavior and messages follow GNU coreutils, grep 3.11,
sed 4.9, findutils 4.9 and diffutils 3.10; the differential suite compares them with the real
tools.

| Command | Notes |
|---|---|
| `ls` | `-aAlRdFphrtSUi1L`. Output is one name per line (never columns: stdout is not a TTY). `-l` shows `user user` as owner |
| `cat cp mv rm mkdir rmdir touch ln chmod stat realpath readlink basename dirname mktemp` | Common GNU options. `chmod` takes octal and symbolic modes, `-R`. `stat -c/--printf` formats |
| `head tail wc sort uniq cut tr tee seq yes rev` | `sort -k -t -n -g -h -V -M -f -r -u -s -c -o`. `tail -f` polls every 250 ms. `tr` is byte-based like GNU's |
| `grep` (`egrep`, `fgrep`) | `-EFGP -ivwxclLnhHoqsr -e -f -A -B -C -m --include --exclude --exclude-dir`. JS regex engine: matching is leftmost-first, not POSIX leftmost-longest, so a few alternations match differently. `-P` is JS regex syntax |
| `sed` | Addresses (`N`, `$`, `/re/`, `first~step`, ranges, `addr,+N`, `0,/re/`, `!`), commands `s y d D p P n N g G h H x a i c = q Q l r w b t T : { } z F`, `-n -e -f -E -r -i[SUF] -s -z`, `\U \L \u \l \E` in replacements. No `e` command or `s///e` |
| `find` | Tests `-name -iname -path -regex -type -size -empty -newer -mtime -mmin -perm -maxdepth -mindepth`; actions `-print -print0 -printf -delete -exec -execdir -prune -quit`; `! -a -o ( ) ,`. Directory entries are visited in sorted order |
| `xargs` | `-n -L -I -0 -d -r -t`. Runs invocations one at a time (`-P` is accepted and ignored) |
| `diff` | Normal and unified (`-u`, `-U N`) output, `-q -r -N -i -w -b -B -s --label`. Timestamps in headers are UTC |
| `env printenv which sleep date uname whoami hostname nproc id true false pwd echo printf test [ clear` | `date` formats in UTC only (`%Z` is `UTC`) |
| `tar` | `-c -x -t -z -v -f -C -O -k -a --strip-components --exclude`, old-style bundles (`tar xzf a.tgz`). Reads ustar, pax and GNU long names; writes ustar with pax headers. gzip is detected on extract. Members containing `..` are skipped, as in GNU tar. Archives are built in memory |
| `gzip gunzip zcat` | `-c -d -k -f -t -q`; levels are accepted and ignored |
| `curl` | Uses the browser's `fetch`: `localhost`/`127.0.0.1` reach virtual ports, other origins need CORS. `-s -S -f -i -I -o -O -X -H -d --data-* --json -G -u -A -e -w -m -T -v`. Redirects are always followed (`-L` is implied). A refused local port exits 7, as curl does |
| `git` | isomorphic-git 1.44.3, fetched and integrity-checked on first use (ADR 0014). Diffed against real git in `test/e2e/git.spec.ts` (stdout and exit codes, fixed dates): commit ids are identical. `init config status add rm mv commit log show diff branch checkout switch restore reset merge stash tag rev-parse ls-files cat-file remote clone fetch pull push`. `log` follows git's date order; `diff`/`show` print unified patches and `--stat`; `merge` fast-forwards or creates merge commits and leaves conflict markers (resolved with `git add` + `git commit`). No editor (`commit` needs `-m`, `-F` or a pending merge message), no rebase, cherry-pick, blame, submodules, hooks, `.gitattributes` or rename detection. Remotes go through `fetch`: most hosts need a CORS proxy (`GIT_CORS_PROXY`); `GIT_TOKEN` authenticates |

## Previews

- HTML documents on port origins get three injected scripts at the top of `<head>`: an inline console capture, the WebSocket shim and the preview agent. A page with a Content-Security-Policy that forbids inline scripts loses console output from before the agent loads; one that forbids same-origin scripts loses the shim and agent.
- Screenshots render the DOM through SVG `foreignObject`: same-origin images are inlined; cross-origin images, canvases, video and iframes are blank.

## Filesystem semantics

- Read-only mounts (`Instance.fs.mount`) fail mutations with `EROFS`; `rm -rf` of a directory containing a mount fails rather than skipping it.
- `/dev/null`, `/dev/zero`, `/dev/random` and `/dev/urandom` are character devices (by path; `ls /dev` lists them). Reading a whole infinite device with `readFile` returns nothing rather than looping.
- Linux semantics are the reference (CI runs the differentials on Linux; a few macOS-divergent cases are skipped locally).
- Symlinks are followed with a 40-hop limit (`ELOOP`); `..` is resolved physically, as the kernel does.
- Hard links, unlinked-but-open files, `O_APPEND`/`O_EXCL`/`O_TRUNC`, and zero-filled holes behave as on Linux.
- No access time updates on reads (`noatime`). Every process runs as root: only execute permission is checked (`access(X_OK)`).
- Per-instance quotas (`quotaBytes`, `maxInodes`) fail with `ENOSPC`; per-process open files are capped at 1024 (`EMFILE`).

- `readdir` returns entries in sorted order (code-unit order). Linux ext4 returns hash order, so
  don't rely on order in tests.
- Paths are case-sensitive.
- Errors carry Linux errno values and Node's `code`, `errno`, `syscall`, and `path`.
