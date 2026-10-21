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
  /**
   * A worker thread (`worker_threads.Worker`): the kernel links parent and
   * child with a MessageChannel (`port` in child-spawned and init).
   */
  thread?: boolean;
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
      /** For worker threads: the channel to the parent thread. */
      threadPort?: MessagePort;
    }
  /** Data for this process's stdin; null is end-of-file. */
  | { t: 'stdin'; data: Uint8Array | null }
  /** Liveness check: the process answers `pong` from its event loop. */
  | { t: 'ping'; n: number }
  | { t: 'child-spawned'; id: number; pid: number; port?: MessagePort }
  | { t: 'child-error'; id: number; code: string; message: string }
  | { t: 'child-output'; id: number; fd: 1 | 2; data: Uint8Array }
  | { t: 'child-exit'; id: number; code: number | null; signal: Signal | null }
  | { t: 'watch-event'; id: number; events: WireFsEvent[] }
  | NetToProcess;

/** Process worker -> kernel. */
export type ProcessToKernel =
  | { t: 'ready' }
  | { t: 'pong'; n: number }
  | { t: 'doorbell' }
  | { t: 'stdout'; data: Uint8Array }
  | { t: 'stderr'; data: Uint8Array }
  | { t: 'exit'; code: number }
  /** Starts a child process; `id` is chosen by the parent to correlate replies. */
  | { t: 'spawn'; id: number; request: ChildSpawnRequest }
  | { t: 'child-stdin'; id: number; data: Uint8Array | null }
  | { t: 'child-kill'; id: number; signal: Signal }
  | { t: 'watch'; id: number; path: string; recursive: boolean }
  | { t: 'unwatch'; id: number }
  | NetToKernel;

/**
 * Virtual networking. A listener (`id`, chosen by the process) owns a port.
 * Sockets (`sid`) are positive when the kernel created them (incoming
 * requests, upgrades, accepted connections) and negative when the process did
 * (outgoing connections), so the two never collide.
 */
export type NetToKernel =
  /** Listen on `port` (0 picks a free one). `http` gets requests; `tcp` gets raw connections. */
  | { t: 'net-listen'; id: number; port: number; kind: 'http' | 'tcp' }
  | { t: 'net-unlisten'; id: number }
  /** Opens a raw connection to a `tcp` listener in this instance. */
  | { t: 'net-connect'; sid: number; port: number }
  | {
      t: 'http-res-head';
      sid: number;
      status: number;
      statusText: string;
      headers: [string, string][];
    }
  | { t: 'http-res-body'; sid: number; data: Uint8Array }
  | { t: 'http-res-end'; sid: number }
  | { t: 'sock-data'; sid: number; data: Uint8Array }
  /** Closes the socket (both directions). */
  | { t: 'sock-end'; sid: number };

export type NetToProcess =
  | { t: 'net-listening'; id: number; port: number }
  | { t: 'net-listen-error'; id: number; code: string }
  | { t: 'net-connected'; sid: number }
  | { t: 'net-connect-error'; sid: number; code: string }
  /** A request for listener `id`. With `upgrade`, the socket `sid` then carries raw bytes. */
  | {
      t: 'http-req';
      sid: number;
      id: number;
      method: string;
      url: string;
      headers: [string, string][];
      upgrade: boolean;
    }
  | { t: 'http-req-body'; sid: number; data: Uint8Array }
  | { t: 'http-req-end'; sid: number }
  /** The client went away before the response finished. */
  | { t: 'http-req-abort'; sid: number }
  | { t: 'tcp-accept'; sid: number; id: number }
  | { t: 'sock-data'; sid: number; data: Uint8Array }
  | { t: 'sock-end'; sid: number };
