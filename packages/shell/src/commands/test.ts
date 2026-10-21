// SPDX-License-Identifier: Apache-2.0
// `test` / `[`: POSIX argument-count rules plus the common extensions.

import type { ShellFs } from '../types.ts';
import type { CommandContext } from '../types.ts';
import { resolvePath } from './util.ts';

const S_IFMT = 0o170000;

function stat(fs: ShellFs, path: string, follow = true) {
  try {
    return follow ? fs.statSync(path) : fs.lstatSync(path);
  } catch {
    return null;
  }
}

/** File test operators shared by `test` and `[[ ]]`. */
export function testFileOp(fs: ShellFs, op: string, path: string): boolean {
  switch (op) {
    case '-e':
    case '-a':
      return stat(fs, path) !== null;
    case '-f':
      return stat(fs, path)?.isFile() ?? false;
    case '-d':
      return stat(fs, path)?.isDirectory() ?? false;
    case '-h':
    case '-L':
      return stat(fs, path, false)?.isSymbolicLink() ?? false;
    case '-s':
      return (stat(fs, path)?.size ?? 0) > 0;
    case '-r':
    case '-w':
    case '-x': {
      const st = stat(fs, path);
      if (!st) return false;
      const bit = op === '-r' ? 4 : op === '-w' ? 2 : 1;
      // Everything runs as the owning user.
      return (
        ((st.mode >> 6) & bit) !== 0 || (op === '-x' && st.isDirectory() && (st.mode & 0o111) !== 0)
      );
    }
    case '-b':
    case '-c':
    case '-p':
    case '-S':
      return false;
    case '-g':
      return ((stat(fs, path)?.mode ?? 0) & 0o2000) !== 0;
    case '-u':
      return ((stat(fs, path)?.mode ?? 0) & 0o4000) !== 0;
    case '-k':
      return ((stat(fs, path)?.mode ?? 0) & 0o1000) !== 0;
    case '-O':
    case '-G':
      return stat(fs, path) !== null;
    case '-N': {
      const st = stat(fs, path);
      return st !== null && st.mtimeMs > st.atimeMs;
    }
  }
  return false;
}

export function testBinaryOp(fs: ShellFs, op: string, a: string, b: string): boolean {
  const sa = stat(fs, a);
  const sb = stat(fs, b);
  switch (op) {
    case '-nt':
      return sa !== null && (sb === null || sa.mtimeMs > sb.mtimeMs);
    case '-ot':
      return sb !== null && (sa === null || sa.mtimeMs < sb.mtimeMs);
    case '-ef':
      return (
        sa !== null && sb !== null && sa.ino === sb.ino && (sa.mode & S_IFMT) === (sb.mode & S_IFMT)
      );
  }
  return false;
}

const UNARY = new Set([
  '-e',
  '-a',
  '-f',
  '-d',
  '-h',
  '-L',
  '-s',
  '-r',
  '-w',
  '-x',
  '-b',
  '-c',
  '-p',
  '-S',
  '-g',
  '-u',
  '-k',
  '-O',
  '-G',
  '-N',
  '-z',
  '-n',
  '-t',
  '-v',
  '-o',
]);
const BINARY = new Set([
  '=',
  '==',
  '!=',
  '<',
  '>',
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
  '-nt',
  '-ot',
  '-ef',
]);

class TestError extends Error {}

function toInt(s: string): bigint {
  const t = s.trim();
  if (!/^[+-]?[0-9]+$/.test(t)) throw new TestError(`${s}: integer expression expected`);
  return BigInt(t);
}

/** Evaluates `test` arguments. Throws TestError (status 2) on syntax errors. */
function evaluate(
  args: string[],
  ctx: { fs: ShellFs; cwd: string; env: Record<string, string> },
): boolean {
  let pos = 0;
  const unary = (op: string, arg: string): boolean => {
    if (op === '-z') return arg === '';
    if (op === '-n') return arg !== '';
    if (op === '-t') return false;
    if (op === '-v') return arg in ctx.env;
    if (op === '-o') return false;
    return testFileOp(ctx.fs, op, resolvePath(ctx.cwd, arg));
  };
  const binary = (a: string, op: string, b: string): boolean => {
    switch (op) {
      case '=':
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '-eq':
        return toInt(a) === toInt(b);
      case '-ne':
        return toInt(a) !== toInt(b);
      case '-lt':
        return toInt(a) < toInt(b);
      case '-le':
        return toInt(a) <= toInt(b);
      case '-gt':
        return toInt(a) > toInt(b);
      case '-ge':
        return toInt(a) >= toInt(b);
      default:
        return testBinaryOp(ctx.fs, op, resolvePath(ctx.cwd, a), resolvePath(ctx.cwd, b));
    }
  };

  // POSIX: decide by argument count first.
  const byCount = (n: number): boolean | undefined => {
    const a = args.slice(pos, pos + n);
    if (n === 0) return false;
    if (n === 1) return a[0] !== '';
    if (n === 2) {
      if (a[0] === '!') return a[1] === '';
      if (UNARY.has(a[0]!)) return unary(a[0]!, a[1]!);
      throw new TestError(`${a[0]}: unary operator expected`);
    }
    if (n === 3) {
      if (BINARY.has(a[1]!)) return binary(a[0]!, a[1]!, a[2]!);
      if (a[1] === '-a') return a[0] !== '' && a[2] !== '';
      if (a[1] === '-o') return a[0] !== '' || a[2] !== '';
      if (a[0] === '!') {
        pos++;
        return !byCount(2);
      }
      if (a[0] === '(' && a[2] === ')') return a[1] !== '';
      throw new TestError(`${a[1]}: binary operator expected`);
    }
    if (n === 4) {
      if (a[0] === '!') {
        pos++;
        return !byCount(3);
      }
      if (a[0] === '(' && a[3] === ')') {
        pos++;
        return byCount(2);
      }
    }
    return undefined;
  };
  const simple = byCount(args.length);
  if (simple !== undefined) return simple;

  // Longer expressions: -o lowest, then -a, then !, then primaries.
  const peek = () => args[pos];
  const primary = (): boolean => {
    const t = args[pos];
    if (t === undefined) throw new TestError('argument expected');
    if (t === '!') {
      pos++;
      return !primary();
    }
    if (t === '(') {
      pos++;
      const v = orExpr();
      if (args[pos] !== ')') throw new TestError("')' expected");
      pos++;
      return v;
    }
    const next = args[pos + 1];
    if (next !== undefined && BINARY.has(next) && args[pos + 2] !== undefined) {
      pos += 3;
      return binary(t, next, args[pos - 1]!);
    }
    if (UNARY.has(t) && next !== undefined) {
      pos += 2;
      return unary(t, next);
    }
    pos++;
    return t !== '';
  };
  const andExpr = (): boolean => {
    let v = primary();
    while (peek() === '-a') {
      pos++;
      const r = primary();
      v = v && r;
    }
    return v;
  };
  const orExpr = (): boolean => {
    let v = andExpr();
    while (peek() === '-o') {
      pos++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const v = orExpr();
  if (pos < args.length) throw new TestError(`${args[pos]}: unexpected argument`);
  return v;
}

export async function test(ctx: CommandContext): Promise<number> {
  let args = ctx.argv.slice(1);
  if (ctx.argv[0] === '[') {
    if (args[args.length - 1] !== ']') {
      await ctx.stderr.write("[: missing `]'\n");
      return 2;
    }
    args = args.slice(0, -1);
  }
  try {
    return evaluate(args, ctx) ? 0 : 1;
  } catch (err) {
    if (err instanceof TestError) {
      await ctx.stderr.write(`${ctx.argv[0]}: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
