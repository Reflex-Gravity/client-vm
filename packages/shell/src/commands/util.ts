// SPDX-License-Identifier: Apache-2.0
// Helpers shared by the commands: path resolution, GNU-style error text,
// option parsing with GNU argument permutation, and file sources.

import type { ShellFs } from '../types.ts';
import { BufferedSource, bytesSource, emptySource } from '../io.ts';
import type { Sink, Source } from '../io.ts';
import type { CommandContext } from '../types.ts';

const STRERROR: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  ENOSPC: 'No space left on device',
  EXDEV: 'Invalid cross-device link',
  EBADF: 'Bad file descriptor',
  EMFILE: 'Too many open files',
  ENAMETOOLONG: 'File name too long',
  EBUSY: 'Device or resource busy',
  EIO: 'Input/output error',
  ENOEXEC: 'Exec format error',
  EAGAIN: 'Resource temporarily unavailable',
  EPIPE: 'Broken pipe',
  ENOSYS: 'Function not implemented',
  EROFS: 'Read-only file system',
  EDQUOT: 'Disk quota exceeded',
};

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** strerror(3)-style text for a thrown fs error. */
export function strerror(err: unknown): string {
  const code = errorCode(err);
  if (code && STRERROR[code]) return STRERROR[code];
  return err instanceof Error ? err.message : String(err);
}

export function resolvePath(cwd: string, p: string): string {
  const joined = p.startsWith('/') ? p : `${cwd}/${p}`;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return p.startsWith('/') ? '/' : '';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return p.startsWith('/') ? '/' : '.';
  const i = trimmed.lastIndexOf('/');
  if (i < 0) return '.';
  const d = trimmed.slice(0, i).replace(/\/+$/, '');
  return d === '' ? '/' : d;
}

/** Shell-quotes a name the way GNU tools do in messages ('it''s' -> "it's"). */
export function quoteName(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class Out {
  private readonly sink: Sink;
  constructor(sink: Sink) {
    this.sink = sink;
  }
  write(s: string | Uint8Array): void | Promise<void> {
    return this.sink.write(s);
  }
}

/** Writes `name: message\n` to stderr. */
export async function complain(ctx: CommandContext, message: string): Promise<void> {
  await ctx.stderr.write(`${ctx.argv[0]}: ${message}\n`);
}

export interface ParsedOptions {
  /** Flag -> value (true for boolean flags). Repeated flags keep the last value. */
  flags: Map<string, string | true>;
  /** Every occurrence, in order (for repeatable options like -e). */
  list: { name: string; value: string | true }[];
  operands: string[];
}

export interface OptionSpec {
  /** Boolean short flags, e.g. 'alR1'. */
  short?: string;
  /** Short flags that take a value, e.g. 'nt'. */
  shortArg?: string;
  /** Long options: name -> canonical flag name and whether it takes a value. */
  long?: Record<string, { name: string; arg?: boolean | 'optional' }>;
  /** Stop at the first operand (POSIX) instead of permuting (GNU). */
  stopAtOperand?: boolean;
  /** Treat -<digits> as a numeric option (head -5). */
  numeric?: string;
}

export class UsageError extends Error {}

export function parseOptions(args: readonly string[], spec: OptionSpec): ParsedOptions {
  const flags = new Map<string, string | true>();
  const list: { name: string; value: string | true }[] = [];
  const operands: string[] = [];
  const set = (name: string, value: string | true) => {
    flags.set(name, value);
    list.push({ name, value });
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') && spec.long) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const matches = Object.keys(spec.long).filter((k) => k === name || k.startsWith(name));
      const exact = matches.includes(name) ? name : matches.length === 1 ? matches[0] : undefined;
      if (exact === undefined) {
        throw new UsageError(
          matches.length > 1 ? `option '${arg}' is ambiguous` : `unrecognized option '${arg}'`,
        );
      }
      const def = spec.long[exact]!;
      if (def.arg === true) {
        if (eq >= 0) set(def.name, arg.slice(eq + 1));
        else {
          const v = args[++i];
          if (v === undefined) throw new UsageError(`option '--${exact}' requires an argument`);
          set(def.name, v);
        }
      } else if (def.arg === 'optional') {
        set(def.name, eq >= 0 ? arg.slice(eq + 1) : true);
      } else {
        if (eq >= 0) throw new UsageError(`option '--${exact}' doesn't allow an argument`);
        set(def.name, true);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (spec.numeric && /^-\d+$/.test(arg)) {
        set(spec.numeric, arg.slice(1));
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]!;
        if (spec.shortArg?.includes(c)) {
          const rest = arg.slice(j + 1);
          if (rest) set(c, rest);
          else {
            const v = args[++i];
            if (v === undefined) throw new UsageError(`option requires an argument -- '${c}'`);
            set(c, v);
          }
          break;
        }
        if (spec.short?.includes(c)) set(c, true);
        else throw new UsageError(`invalid option -- '${c}'`);
      }
      continue;
    }
    if (spec.stopAtOperand) {
      operands.push(...args.slice(i));
      break;
    }
    operands.push(arg);
  }
  return { flags, list, operands };
}

/** Runs `body`, turning a UsageError into the GNU usage message and status. */
export async function withUsage(
  ctx: CommandContext,
  body: () => Promise<number> | number,
  status = 1,
): Promise<number> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof UsageError) {
      await complain(ctx, err.message);
      await ctx.stderr.write(`Try '${ctx.argv[0]} --help' for more information.\n`);
      return status;
    }
    throw err;
  }
}

const CHUNK = 64 * 1024;

/** A source reading a file through an fd (lazily, in chunks). */
export function fileSource(fs: ShellFs, path: string): Source {
  if (path === '/dev/null') return emptySource();
  const fd = fs.openSync(path, 'r');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(fd);
  };
  return new BufferedSource(() => {
    if (closed) return null;
    const buf = new Uint8Array(CHUNK);
    const n = fs.readSync(fd, buf, 0, CHUNK, null);
    if (n === 0) {
      close();
      return null;
    }
    return buf.subarray(0, n);
  }, close);
}

/** Opens each operand (or stdin for none / `-`), reporting errors GNU-style. */
export async function* inputs(
  ctx: CommandContext,
  operands: readonly string[],
): AsyncGenerator<{ name: string; source: Source } | { name: string; error: unknown }> {
  if (operands.length === 0) {
    yield { name: '-', source: ctx.stdin };
    return;
  }
  for (const name of operands) {
    if (name === '-') {
      yield { name, source: ctx.stdin };
      continue;
    }
    let source: Source;
    try {
      const path = resolvePath(ctx.cwd, name);
      if (path !== '/dev/null' && ctx.fs.statSync(path).isDirectory()) {
        yield { name, error: Object.assign(new Error('Is a directory'), { code: 'EISDIR' }) };
        continue;
      }
      source = path === '/dev/stdin' ? ctx.stdin : fileSource(ctx.fs, path);
    } catch (error) {
      yield { name, error };
      continue;
    }
    try {
      yield { name, source };
    } finally {
      if (source !== ctx.stdin) source.close();
    }
  }
}

export { bytesSource };

/** True for an existing path (not following a final symlink when `lstat`). */
export function exists(fs: ShellFs, path: string, lstat = false): boolean {
  try {
    if (lstat) fs.lstatSync(path);
    else fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}
