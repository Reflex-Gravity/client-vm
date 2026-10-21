// SPDX-License-Identifier: Apache-2.0
// File descriptors 0, 1 and 2 in `fs`. The kernel's fd table holds only files
// this process opened, so fs calls on stdio go to the process's stdio streams:
// async reads of fd 0 pull from process.stdin (Go's WebAssembly runtime reads
// stdin this way), writes to 1 and 2 go to stdout/stderr, and fstat reports
// pipes. A synchronous read of fd 0 would block the worker; it fails with
// EAGAIN, as Node does for a non-blocking stdin.

import { SystemError } from '@clientvm/protocol';
import { Stats } from './fs.ts';

type Fn = (...args: unknown[]) => unknown;

interface StdinLike {
  read(size?: number): Uint8Array | null;
  unshift(chunk: Uint8Array): void;
  once(event: string, fn: () => void): unknown;
  removeListener(event: string, fn: () => void): unknown;
  readableEnded: boolean;
}

interface StdoutLike {
  write(chunk: Uint8Array, cb?: (err?: Error | null) => void): boolean;
}

interface Stdio {
  stdin: StdinLike;
  stdout: StdoutLike;
  stderr: StdoutLike;
}

const S_IFIFO = 0o010000;

function pipeStat(): Stats {
  const now = Date.now();
  return new Stats({
    dev: 0,
    mode: S_IFIFO | 0o600,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: 0,
    size: 0,
    blocks: 0,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
  } as never);
}

function toBytes(data: unknown, encoding?: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  void encoding;
  return new TextEncoder().encode(String(data));
}

export function installStdioFds(fs: Record<string, unknown>, stdio: () => Stdio): void {
  const isStdio = (fd: unknown) => fd === 0 || fd === 1 || fd === 2;
  const out = (fd: number) => (fd === 2 ? stdio().stderr : stdio().stdout);

  const fstatSync = fs['fstatSync'] as Fn;
  fs['fstatSync'] = (fd: unknown, ...rest: unknown[]) =>
    isStdio(fd) ? pipeStat() : fstatSync(fd, ...rest);
  const fstat = fs['fstat'] as Fn;
  fs['fstat'] = (fd: unknown, ...rest: unknown[]) => {
    if (!isStdio(fd)) return fstat(fd, ...rest);
    const cb = rest.pop() as (e: unknown, s?: Stats) => void;
    queueMicrotask(() => cb(null, pipeStat()));
  };

  /** Slices (data, offset, length) the way fs.write/writeSync take them. */
  const slice = (data: unknown, a?: unknown, b?: unknown): Uint8Array => {
    if (typeof data === 'string') return toBytes(data, typeof b === 'string' ? b : undefined);
    const bytes = toBytes(data);
    const offset = typeof a === 'number' ? a : 0;
    const length = typeof b === 'number' ? b : bytes.length - offset;
    return bytes.subarray(offset, offset + length);
  };

  const writeSync = fs['writeSync'] as Fn;
  fs['writeSync'] = (fd: unknown, data: unknown, a?: unknown, b?: unknown, ...rest: unknown[]) => {
    if (fd !== 1 && fd !== 2) return writeSync(fd, data, a, b, ...rest);
    const bytes = slice(data, a, b);
    out(fd).write(bytes);
    return bytes.length;
  };
  const write = fs['write'] as Fn;
  fs['write'] = (fd: unknown, data: unknown, ...rest: unknown[]) => {
    if (fd !== 1 && fd !== 2) return write(fd, data, ...rest);
    const cb = rest.pop() as (e: unknown, n?: number, d?: unknown) => void;
    const bytes = slice(data, rest[0], rest[1]);
    out(fd).write(bytes, (err) => (err ? cb(err) : cb(null, bytes.length, data)));
  };

  const readSync = fs['readSync'] as Fn;
  fs['readSync'] = (fd: unknown, ...rest: unknown[]) => {
    if (fd !== 0) return readSync(fd, ...rest);
    throw new SystemError('EAGAIN', 'read');
  };
  const read = fs['read'] as Fn;
  fs['read'] = (fd: unknown, ...args: unknown[]) => {
    if (fd !== 0) return read(fd, ...args);
    const cb = args.pop() as (e: unknown, n?: number, b?: Uint8Array) => void;
    let buffer: Uint8Array;
    let offset = 0;
    let length: number;
    if (args[0] instanceof Uint8Array) {
      buffer = args[0];
      offset = typeof args[1] === 'number' ? args[1] : 0;
      length = typeof args[2] === 'number' ? args[2] : buffer.length - offset;
    } else {
      const o = (args[0] ?? {}) as { buffer?: Uint8Array; offset?: number; length?: number };
      buffer = o.buffer ?? new Uint8Array(16384);
      offset = o.offset ?? 0;
      length = o.length ?? buffer.length - offset;
    }
    const stdin = stdio().stdin;
    const attempt = () => {
      if (length === 0) return cb(null, 0, buffer);
      const chunk = stdin.read();
      if (chunk === null) {
        if (stdin.readableEnded) return cb(null, 0, buffer);
        const retry = () => {
          stdin.removeListener('readable', retry);
          stdin.removeListener('end', retry);
          attempt();
        };
        stdin.once('readable', retry);
        stdin.once('end', retry);
        return;
      }
      const n = Math.min(length, chunk.length);
      buffer.set(chunk.subarray(0, n), offset);
      if (n < chunk.length) stdin.unshift(chunk.subarray(n));
      cb(null, n, buffer);
    };
    queueMicrotask(attempt);
  };
}
