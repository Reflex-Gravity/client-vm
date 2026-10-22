// SPDX-License-Identifier: Apache-2.0
import type { Signal, WindowSize, WireFsEvent } from './instance-rpc.ts';

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

/** A process's terminal: which of its stdio streams are the terminal, and its size. */
export interface TtyInfo extends WindowSize {
  stdin: boolean;
  stdout: boolean;
  stderr: boolean;
}

/** Where a child's stdio stream goes. */
export type StdioMode = 'pipe' | 'inherit' | 'ignore';

export interface ChildSpawnRequest {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** stdin `inherit` attaches the child to the parent's terminal when the parent's stdin is one. */
  stdio: [StdioMode, StdioMode, StdioMode];
  /**
   * Starts a new process group (a shell's background job): terminal signals
   * such as Ctrl+C and terminal input no longer reach it or its children.
   */
  newGroup?: boolean;
  /**
   * A worker thread (`worker_threads.Worker`): the kernel links parent and
   * child with a MessageChannel (`port` in child-spawned and init).
   */
  thread?: boolean;
  /**
   * The child's end of a channel the parent made itself (instead of the
   * kernel's). The parent can post on its end at once, and the thread gets
   * those messages even while the parent is blocked (a WASI thread pool whose
   * caller waits on shared memory). child-spawned then carries no port.
   */
  threadPort?: MessagePort;
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
      /** Set when the process has a controlling terminal; says which stdio streams are it. */
      tty?: TtyInfo;
    }
  /**
   * Data for this process's stdin; null is end-of-file. On a terminal, an
   * empty chunk is an end-of-file key (Ctrl+D): it ends the current read, but
   * the terminal stays open for later reads.
   */
  | { t: 'stdin'; data: Uint8Array | null }
  /** A signal for the process. It answers `signal-ack` if a handler took it, else applies the default action. */
  | { t: 'signal'; signal: Signal }
  /** The terminal was resized. */
  | { t: 'winsize'; size: WindowSize }
  /** Liveness check: the process answers `pong` from its event loop. */
  | { t: 'ping'; n: number }
  | { t: 'child-spawned'; id: number; pid: number; port?: MessagePort }
  | { t: 'child-error'; id: number; code: string; message: string }
  | { t: 'child-output'; id: number; fd: 1 | 2; data: Uint8Array }
  | { t: 'child-exit'; id: number; code: number | null; signal: Signal | null }
  /** The child stopped (Ctrl+Z, SIGTSTP/SIGSTOP), or continued after SIGCONT. */
  | { t: 'child-stopped'; id: number; signal: Signal }
  | { t: 'child-continued'; id: number }
  | { t: 'watch-event'; id: number; events: WireFsEvent[] }
  | NetToProcess;

/** Process worker -> kernel. */
export type ProcessToKernel =
  | { t: 'ready' }
  | { t: 'pong'; n: number }
  | { t: 'doorbell' }
  | { t: 'stdout'; data: Uint8Array }
  | { t: 'stderr'; data: Uint8Array }
  /** `signal` is set when the process ended by a signal's default action. */
  | { t: 'exit'; code: number; signal?: Signal }
  /** A handler took the last delivered signal (no default action). */
  | { t: 'signal-ack' }
  /** The process stopped (a stop signal's default action) and waits for SIGCONT. */
  | { t: 'stopped'; signal: Signal }
  /** Switches the terminal between raw and cooked input (`setRawMode`); needs stdin to be the terminal. */
  | { t: 'tty-mode'; raw: boolean }
  /** Starts a child process; `id` is chosen by the parent to correlate replies. */
  | { t: 'spawn'; id: number; request: ChildSpawnRequest }
  | { t: 'child-stdin'; id: number; data: Uint8Array | null }
  /** With `tree`, the signal goes to the child and everything it started (a job). */
  | { t: 'child-kill'; id: number; signal: Signal; tree?: boolean }
  /**
   * Moves the child and everything it started into the parent's process group
   * (`foreground`: it gets terminal input and Ctrl+C) or a group of its own.
   */
  | { t: 'child-setpgid'; id: number; foreground: boolean }
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
