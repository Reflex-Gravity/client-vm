// SPDX-License-Identifier: Apache-2.0
import type { Signal, WireFsEvent } from './instance-rpc.ts';

/**
 * How a process wakes the kernel after posting a sync syscall:
 * - `waitAsync`: the kernel is parked in `Atomics.waitAsync` on the channel.
 * - `postMessage`: the process sends a doorbell message to the kernel.
 */
export type SyscallMode = 'waitAsync' | 'postMessage';

/**
 * First line of a command file that names a built-in runtime
 * (`#!/clientvm/builtin node`). The kernel resolves these on exec; the shell
 * runs the ones it implements in-process.
 */
export const BUILTIN_MARKER = '#!/clientvm/builtin ';

/** Where a child's stdio stream goes. */
export type StdioMode = 'pipe' | 'inherit' | 'ignore';

export interface ChildSpawnRequest {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdio: [StdioMode, StdioMode, StdioMode];
}

/** Kernel -> process worker. */
export type KernelToProcess =
  | {
      t: 'init';
      pid: number;
      channel: SharedArrayBuffer;
      syscallMode: SyscallMode;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      /** False when stdin is closed from the start (no writer). */
      stdinOpen: boolean;
    }
  /** Data for this process's stdin; null is end-of-file. */
  | { t: 'stdin'; data: Uint8Array | null }
  | { t: 'child-spawned'; id: number; pid: number }
  | { t: 'child-error'; id: number; code: string; message: string }
  | { t: 'child-output'; id: number; fd: 1 | 2; data: Uint8Array }
  | { t: 'child-exit'; id: number; code: number | null; signal: Signal | null }
  | { t: 'watch-event'; id: number; events: WireFsEvent[] };

/** Process worker -> kernel. */
export type ProcessToKernel =
  | { t: 'ready' }
  | { t: 'doorbell' }
  | { t: 'stdout'; data: Uint8Array }
  | { t: 'stderr'; data: Uint8Array }
  | { t: 'exit'; code: number }
  /** Starts a child process; `id` is chosen by the parent to correlate replies. */
  | { t: 'spawn'; id: number; request: ChildSpawnRequest }
  | { t: 'child-stdin'; id: number; data: Uint8Array | null }
  | { t: 'child-kill'; id: number; signal: Signal }
  | { t: 'watch'; id: number; path: string; recursive: boolean }
  | { t: 'unwatch'; id: number };
