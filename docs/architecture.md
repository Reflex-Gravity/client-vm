# Architecture

The target architecture is in [CLAUDE.md §4](../CLAUDE.md#4-architecture). This page records what
is built and how a syscall travels today.

## Thread layout (as of the Phase 1 spike)

```
Sandbox page (main thread, COOP: same-origin, COEP: require-corp)
  │  RpcEndpoint over Worker.postMessage   (@clientvm/protocol rpc)
  ▼
Kernel worker (dedicated)                  (@clientvm/kernel)
  ├─ MemoryVfs                             (@clientvm/vfs)
  ├─ process table: pid → { channel SAB, SyscallServer, Worker }
  │
  │  new Worker()  (nested dedicated worker, one per process)
  ▼
Process worker                             (@clientvm/process + runtime)
  ├─ runtime chosen by argv[0]: node → @clientvm/node-compat, clientvm-bench → builtin
  ├─ sync syscalls: SyscallClient over the channel SAB (Atomics.wait)
  └─ async: postMessage to the kernel for stdout / stderr / ready / exit
```

Phase 2 inserts the controller → sandbox-origin iframe hop and per-instance subdomain origins
above the kernel worker.

## Sync syscall path

1. node-compat (`fs.readFileSync('x')`) resolves the path against the process cwd and encodes the
   arguments with the binary codec.
2. `SyscallClient.call(op, bytes)` writes the header (`OP`, `LEN`, `TOTAL`) and payload into the
   SAB, stores `STATE = REQUEST`, then calls `Atomics.notify`, or posts a doorbell in
   `postMessage` mode. It then blocks in `Atomics.wait` while `STATE == REQUEST`.
3. The kernel's `SyscallServer` wakes from `Atomics.waitAsync` (or the doorbell), decodes the
   request, calls the VFS, and writes the response. It sets `ERRNO` on failure, stores
   `STATE = RESPONSE`, and calls `Atomics.notify`.
4. The client copies the response out of the SAB (the result never aliases shared memory) and maps
   a non-zero errno to a Node-shaped `SystemError`.

Payloads larger than the 256 KiB region are streamed with the channel-level opcodes
`REQUEST_MORE` and `RESPONSE_MORE`, so the buffer never grows. Handlers may return a Promise, which
leaves room for async backends like OPFS. The blocked process doesn't care how long the kernel
takes.

### Channel layout

| Int32 slot | Meaning |
|---|---|
| 0 `STATE` | 0 idle, 1 request posted, 2 response ready |
| 1 `OP` | syscall opcode (≥ 0) or channel opcode (< 0) |
| 2 `LEN` | payload bytes in this message |
| 3 `ERRNO` | positive errno on failure, else 0 |
| 4 `TOTAL` | total bytes of the request or response being streamed |
| 5–7 | reserved |

Then come `capacity` payload bytes.

## Package dependency graph

```
protocol ◄── vfs ◄── kernel
   ▲                   
   ├──── process ◄── node-compat
   └──── (all)  ◄── sandbox-host (composes kernel + process + node-compat into worker entries)
clientvm: public types only (no runtime code yet)
```

The process package does not depend on node-compat. Runtimes are injected as a `RuntimeTable` by
the worker entry in sandbox-host, which keeps process tiers (`js`, `builtin`, later `wasi`/`vm`)
pluggable.

## Workspace conventions

- Sources import siblings with `.ts` extensions. `tsc` rewrites them to `.js`
  (`rewriteRelativeImportExtensions`), and Node 24 can run the sources directly through type
  stripping (`erasableSyntaxOnly`). This is how the channel tests run real worker threads.
- Each package's `exports` has a `@clientvm/source` condition pointing at `src/index.ts`. Vite and
  Vitest resolve it, so neither needs a prior build. Published consumers get `dist/`.
