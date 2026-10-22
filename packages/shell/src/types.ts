// SPDX-License-Identifier: Apache-2.0
import type { NodeFs, Stats } from '@clientvm/node-compat';
import type { Sink, Source } from './io.ts';

/** The synchronous fs the shell and commands use (Node's API, narrowed to the forms used here). */
export interface ShellFs extends Omit<
  NodeFs,
  'statSync' | 'lstatSync' | 'readFileSync' | 'readdirSync'
> {
  statSync(path: string): Stats;
  lstatSync(path: string): Stats;
  readFileSync(path: string): Uint8Array;
  readdirSync(path: string): string[];
}

/** Narrows a node-compat fs to {@link ShellFs}. */
export const asShellFs = (fs: NodeFs): ShellFs => fs as unknown as ShellFs;

export interface ExecOptions {
  stdin?: Source;
  stdout?: Sink;
  stderr?: Sink;
  cwd?: string;
  env?: Record<string, string>;
}

/** What an in-process command receives (a process image without the worker). */
export interface CommandContext {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly stdin: Source;
  readonly stdout: Sink;
  readonly stderr: Sink;
  /** Synchronous Node-style fs; pass absolute paths (see `resolve`). */
  readonly fs: ShellFs;
  /** Runs another command by PATH lookup (xargs, find -exec, env). Resolves to its exit status. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<number>;
}

/** A command implemented in TypeScript. Returns the exit status. */
export type CommandFn = (ctx: CommandContext) => Promise<number> | number;

export interface SpawnStdio {
  env: Record<string, string>;
  cwd: string;
  stdin: Source;
  stdout: Sink;
  stderr: Sink;
  /** Part of a background job: the program gets its own process group. */
  background?: boolean;
}

/**
 * Starts an external program (a separate ClientVM process) and resolves with
 * its exit status (128 + n when killed by signal n). Rejects with a
 * SystemError (ENOENT, EACCES, ENOEXEC, EAGAIN) when it cannot start.
 */
export type Spawner = (argv: readonly string[], stdio: SpawnStdio) => Promise<number>;

/**
 * Job control over the programs a shell started (ids are the spawner's).
 * Only the process runtime provides it; an interactive shell uses it for
 * Ctrl+Z, `fg` and `bg`.
 */
export interface JobControl {
  /** Programs started in the foreground that are still running (stopped or not). */
  foreground(): number[];
  /** Called with a program's id when it stops. */
  onStop(listener: (id: number) => void): () => void;
  /** Moves programs (and what they started) into the shell's process group, or groups of their own. */
  setForeground(ids: readonly number[], foreground: boolean): void;
  /** Signals programs and everything they started. */
  signal(ids: readonly number[], signal: 'SIGCONT' | 'SIGHUP'): void;
}
