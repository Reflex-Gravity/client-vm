# @clientvm/process

Bootstrap for ClientVM process workers.

- `startProcessWorker(scope, runtimes)`: waits for the kernel init message and runs the runtime for `argv[0]`.
- `benchRuntime`: the `clientvm-bench` builtin that measures syscall latency.
