# @clientvm/kernel

The ClientVM host kernel. Owns the VFS and the process table, and services syscalls.

- `Kernel`: spawns process workers and services their syscall channels.
- `startKernelWorker`: serves `KernelRpc` from inside a dedicated worker.
