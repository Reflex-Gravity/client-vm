// SPDX-License-Identifier: Apache-2.0

/**
 * How a process wakes the kernel after posting a sync syscall:
 * - `waitAsync`: the kernel is parked in `Atomics.waitAsync` on the channel.
 * - `postMessage`: the process sends a doorbell message to the kernel.
 */
export type SyscallMode = 'waitAsync' | 'postMessage';

/** Kernel -> process worker. */
export type KernelToProcess = {
  t: 'init';
  pid: number;
  channel: SharedArrayBuffer;
  syscallMode: SyscallMode;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
};

/** Process worker -> kernel. */
export type ProcessToKernel =
  | { t: 'ready' }
  | { t: 'doorbell' }
  | { t: 'stdout'; data: Uint8Array }
  | { t: 'stderr'; data: Uint8Array }
  | { t: 'exit'; code: number };
