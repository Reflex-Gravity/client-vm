// SPDX-License-Identifier: Apache-2.0
import type { SyscallClient } from '@clientvm/protocol';

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
