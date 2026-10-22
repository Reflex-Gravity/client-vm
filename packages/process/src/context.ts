// SPDX-License-Identifier: Apache-2.0
import type {
  KernelToProcess,
  ProcessToKernel,
  Signal,
  SyscallClient,
  WindowSize,
} from '@clientvm/protocol';

export interface OutputStream {
  write(data: string | Uint8Array): void;
}

/** Everything a runtime needs to execute one process. */
export interface ProcessContext {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly syscall: SyscallClient;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin: InputStream;
  /** Sends a message to the kernel (child processes, watchers). */
  send(message: ProcessToKernel, transfer?: Transferable[]): void;
  /** Subscribes to kernel messages (child output, watch events). */
  onMessage(listener: (message: KernelToProcess) => void): () => void;
  /** For worker threads: the channel to the parent thread. */
  readonly threadPort?: MessagePort;
  /** The controlling terminal, when the process has one (ADR 0017). */
  readonly tty?: Tty;
  /**
   * Handles signals. A handler returns true when it took the signal; when no
   * handler does, the default action applies (terminate, or ignore for
   * SIGCHLD and SIGWINCH). Returns an unsubscribe function.
   */
  onSignal(handler: (signal: Signal) => boolean): () => void;
}

/** A process's controlling terminal. */
export interface Tty {
  /** Which stdio streams are the terminal. */
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  /** Current size; updated before `onResize` listeners and SIGWINCH. */
  readonly size: WindowSize;
  readonly raw: boolean;
  /** Raw mode (no echo, line editing or signal keys) when stdin is the terminal. */
  setRaw(raw: boolean): void;
  onResize(listener: (size: WindowSize) => void): () => void;
}

/** This process's stdin as pushed by the kernel. */
export interface InputStream {
  /** False once end-of-file has been delivered (or stdin was never open). */
  readonly open: boolean;
  /**
   * Receives each chunk and finally null (EOF). Chunks before subscribing are
   * buffered. On a terminal an empty chunk is Ctrl+D: the end of one read,
   * not of the stream.
   */
  subscribe(listener: (data: Uint8Array | null) => void): void;
}

/**
 * A process type's entry point (`node`, a builtin command, ...). Returns the
 * exit code; `undefined` means 0.
 */
export type Runtime = (ctx: ProcessContext) => number | void | Promise<number | void>;

/** Runtimes keyed by command name (the basename of argv[0]). */
export type RuntimeTable = Readonly<Record<string, Runtime>>;

/** Throw to terminate the process immediately with `code` (e.g. from `process.exit`). */
export class ExitSignal {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}
