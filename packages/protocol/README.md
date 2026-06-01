# @clientvm/protocol

Wire-level building blocks shared by every ClientVM thread.

- `codec`: compact binary value encoding (bytes in, bytes out).
- `SyscallClient` / `SyscallServer`: synchronous syscall channel over a `SharedArrayBuffer` with chunked streaming. See [architecture](../../docs/architecture.md#sync-syscall-path).
- `RpcEndpoint`: typed async request/response over `postMessage`.
- `SystemError`, `Errno`: Node-shaped system errors.
