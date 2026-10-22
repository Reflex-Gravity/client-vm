// SPDX-License-Identifier: Apache-2.0
import type { OutputStream } from '@clientvm/process';
import { format, inspect } from './inspect.ts';

/** Node's global `console`, writing to the process's stdout/stderr. */
export function createConsole(stdout: OutputStream, stderr: OutputStream) {
  let indent = '';
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();

  const write = (stream: OutputStream, args: unknown[]) => {
    let text = format(...args);
    if (indent !== '') text = indent + text.replaceAll('\n', `\n${indent}`);
    stream.write(text + '\n');
  };

  return {
    log: (...args: unknown[]) => write(stdout, args),
    info: (...args: unknown[]) => write(stdout, args),
    debug: (...args: unknown[]) => write(stdout, args),
    error: (...args: unknown[]) => write(stderr, args),
    warn: (...args: unknown[]) => write(stderr, args),
    trace: (...args: unknown[]) => {
      const err = new Error(format(...args));
      err.name = 'Trace';
      write(stderr, [err.stack ?? String(err)]);
    },
    dir: (value: unknown, options?: { depth?: number }) =>
      write(stdout, [inspect(value, options?.depth === undefined ? {} : { depth: options.depth })]),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition)
        write(stderr, ['Assertion failed' + (args.length ? ': ' + format(...args) : '')]);
    },
    group: (...args: unknown[]) => {
      if (args.length) write(stdout, args);
      indent += '  ';
    },
    groupEnd: () => {
      indent = indent.slice(2);
    },
    count: (label = 'default') => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      write(stdout, [`${label}: ${n}`]);
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => timers.set(label, performance.now()),
    timeEnd: (label = 'default') => {
      const t = timers.get(label);
      if (t === undefined) return;
      timers.delete(label);
      write(stdout, [`${label}: ${(performance.now() - t).toFixed(3)}ms`]);
    },
    timeLog: (label = 'default', ...args: unknown[]) => {
      const t = timers.get(label);
      if (t !== undefined)
        write(stdout, [`${label}: ${(performance.now() - t).toFixed(3)}ms`, ...args]);
    },
    table: (data: unknown) => write(stdout, [data]),
    Console,
  };
}

type Writable = { write(chunk: string): unknown };

/**
 * `console.Console` / `require('console').Console`: a console over any
 * writable streams, `new Console(stdout, stderr)` or `new Console({ stdout, stderr })`.
 * Subclasses (Jest's CustomConsole) extend it, so its methods are on the prototype.
 */
interface ConsoleClass {
  new (
    stdout: Writable | { stdout: Writable; stderr?: Writable },
    stderr?: Writable,
  ): ReturnType<typeof createConsole>;
}

const IMPL = Symbol('clientvm.console');

const Console = function Console(
  this: Record<PropertyKey, unknown> | undefined,
  out: Writable | { stdout: Writable; stderr?: Writable },
  err?: Writable,
) {
  if (!(this instanceof Console)) return new (Console as unknown as ConsoleClass)(out, err);
  const opts = 'stdout' in out && typeof (out as { write?: unknown }).write !== 'function';
  const stdout = (opts ? (out as { stdout: Writable }).stdout : out) as Writable;
  const stderr = (
    opts ? ((out as { stderr?: Writable }).stderr ?? stdout) : (err ?? stdout)
  ) as Writable;
  this[IMPL] = createConsole(stdout as OutputStream, stderr as OutputStream);
  return undefined;
} as unknown as ConsoleClass;

for (const name of [
  'log',
  'info',
  'debug',
  'error',
  'warn',
  'trace',
  'dir',
  'assert',
  'group',
  'groupEnd',
  'count',
  'countReset',
  'time',
  'timeEnd',
  'timeLog',
  'table',
] as const) {
  Object.defineProperty(Console.prototype, name, {
    value: function (this: Record<PropertyKey, unknown>, ...args: unknown[]) {
      const impl = this[IMPL] as Record<string, (...a: unknown[]) => unknown>;
      return impl[name]!(...args);
    },
    writable: true,
    configurable: true,
  });
}
