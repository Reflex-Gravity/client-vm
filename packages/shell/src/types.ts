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
}

/**
 * Starts an external program (a separate ClientVM process) and resolves with
 * its exit status (128 + n when killed by signal n). Rejects with a
 * SystemError (ENOENT, EACCES, ENOEXEC, EAGAIN) when it cannot start.
 */
export type Spawner = (argv: readonly string[], stdio: SpawnStdio) => Promise<number>;
