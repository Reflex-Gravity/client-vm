// SPDX-License-Identifier: Apache-2.0
export type * from './ast.ts';
export { ParseError, parse } from './parser.ts';
export { ArithError, evaluateArith } from './arith.ts';
export { matchPattern, patternToRegex } from './pattern.ts';
export {
  BrokenPipe,
  BufferedSource,
  CollectSink,
  Pipe,
  bytesSource,
  emptySource,
  readAll,
} from './io.ts';
export type { Sink, Source } from './io.ts';
export { Io, Shell, ShellState, runCommandFn } from './shell.ts';
export type { ShellHost } from './shell.ts';
export { COMMANDS } from './commands/index.ts';
export { posixToJs } from './commands/regex.ts';
export type { CommandContext, CommandFn, ExecOptions, SpawnStdio, Spawner } from './types.ts';
export {
  SHELL_COMMAND_NAMES,
  commandRuntime,
  createSpawner,
  shellRuntime,
  shellRuntimes,
} from './runtime.ts';
