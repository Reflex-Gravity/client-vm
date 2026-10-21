// SPDX-License-Identifier: Apache-2.0

/** Linux errno values. Node exposes these negated on `SystemError.errno`. */
export const Errno = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EIO: 5,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  EAGAIN: 11,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EMFILE: 24,
  EFBIG: 27,
  ENOSPC: 28,
  EROFS: 30,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EPIPE: 32,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ECONNRESET: 104,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
} as const;

export type ErrnoCode = keyof typeof Errno;

const DESCRIPTIONS: Record<ErrnoCode, string> = {
  EPERM: 'operation not permitted',
  ENOENT: 'no such file or directory',
  ESRCH: 'no such process',
  EIO: 'i/o error',
  E2BIG: 'argument list too long',
  ENOEXEC: 'exec format error',
  EBADF: 'bad file descriptor',
  EAGAIN: 'resource temporarily unavailable',
  EACCES: 'permission denied',
  EBUSY: 'resource busy or locked',
  EEXIST: 'file already exists',
  EXDEV: 'cross-device link not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  EINVAL: 'invalid argument',
  EMFILE: 'too many open files',
  EFBIG: 'file too large',
  ENOSPC: 'no space left on device',
  EROFS: 'read-only file system',
  ENAMETOOLONG: 'name too long',
  ENOSYS: 'function not implemented',
  ENOTEMPTY: 'directory not empty',
  ELOOP: 'too many symbolic links encountered',
  EPIPE: 'broken pipe',
  EADDRINUSE: 'address already in use',
  EADDRNOTAVAIL: 'address not available',
  ECONNRESET: 'connection reset by peer',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
};

const BY_NUMBER = new Map<number, ErrnoCode>(
  Object.entries(Errno).map(([code, n]) => [n, code as ErrnoCode]),
);

export function errnoCode(errno: number): ErrnoCode {
  return BY_NUMBER.get(Math.abs(errno)) ?? 'EIO';
}

/**
 * Error shaped like Node's libuv-backed system errors, e.g.
 * `ENOENT: no such file or directory, open '/nope'`.
 */
export class SystemError extends Error {
  // `declare` keeps these out of the class-field initialization order, so own
  // properties are created below in Node's order and absent ones stay absent.
  /** Negative errno, as Node reports it. */
  declare readonly errno: number;
  declare readonly code: ErrnoCode;
  declare readonly syscall: string;
  declare readonly path?: string;
  declare readonly dest?: string;

  constructor(code: ErrnoCode, syscall: string, path?: string, dest?: string) {
    let message = `${code}: ${DESCRIPTIONS[code]}, ${syscall}`;
    if (path !== undefined) message += ` '${path}'`;
    if (dest !== undefined) message += ` -> '${dest}'`;
    super(message);
    const self = this as {
      -readonly [K in 'errno' | 'code' | 'syscall' | 'path' | 'dest']?: unknown;
    };
    self.errno = -Errno[code];
    self.code = code;
    self.syscall = syscall;
    if (path !== undefined) self.path = path;
    if (dest !== undefined) self.dest = dest;
  }
}

/** Extracts a positive errno from anything thrown by a syscall handler. */
export function errnoOf(err: unknown): number {
  if (err instanceof SystemError) return Errno[err.code];
  return Errno.EIO;
}
