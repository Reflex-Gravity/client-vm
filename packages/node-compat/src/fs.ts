// SPDX-License-Identifier: Apache-2.0
import {
  Op,
  SyscallError,
  SystemError,
  decode,
  decodeStat,
  decodeUtf8,
  encode,
  encodeUtf8,
  errnoCode,
} from '@clientvm/protocol';
import type { StatData, Value } from '@clientvm/protocol';
import type { SyscallClient } from '@clientvm/protocol';
import type { PosixPath } from './path.ts';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

type PathLike = string | URL;
type Encoding = 'utf8' | 'utf-8';
type EncodingOption = Encoding | { encoding?: Encoding | null; flag?: string } | null | undefined;

export class Stats implements StatData {
  declare dev: number;
  declare mode: number;
  declare nlink: number;
  declare uid: number;
  declare gid: number;
  declare rdev: number;
  declare blksize: number;
  declare ino: number;
  declare size: number;
  declare blocks: number;
  declare atimeMs: number;
  declare mtimeMs: number;
  declare ctimeMs: number;
  declare birthtimeMs: number;
  declare atime: Date;
  declare mtime: Date;
  declare ctime: Date;
  declare birthtime: Date;

  constructor(s: StatData) {
    // Assigned in the order Node's Stats prints them.
    Object.assign(this, {
      dev: s.dev,
      mode: s.mode,
      nlink: s.nlink,
      uid: s.uid,
      gid: s.gid,
      rdev: s.rdev,
      blksize: s.blksize,
      ino: s.ino,
      size: s.size,
      blocks: s.blocks,
      atimeMs: s.atimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs,
      birthtimeMs: s.birthtimeMs,
      atime: new Date(s.atimeMs),
      mtime: new Date(s.mtimeMs),
      ctime: new Date(s.ctimeMs),
      birthtime: new Date(s.birthtimeMs),
    });
  }

  isFile(): boolean {
    return (this.mode & S_IFMT) === S_IFREG;
  }
  isDirectory(): boolean {
    return (this.mode & S_IFMT) === S_IFDIR;
  }
  isSymbolicLink(): boolean {
    return (this.mode & S_IFMT) === S_IFLNK;
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

const direntKind = Symbol('type');

export class Dirent {
  declare name: string;
  declare parentPath: string;
  declare path: string;
  declare private readonly [direntKind]: string;

  constructor(name: string, parentPath: string, kind: string) {
    Object.assign(this, { name, parentPath, path: parentPath });
    Object.defineProperty(this, direntKind, { value: kind });
  }

  isFile(): boolean {
    return this[direntKind] === 'file';
  }
  isDirectory(): boolean {
    return this[direntKind] === 'dir';
  }
  isSymbolicLink(): boolean {
    return this[direntKind] === 'symlink';
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

function invalidArg(name: string, expected: string, actual: unknown): TypeError {
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${typeof actual}`,
  );
  (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function toPathString(path: PathLike): string {
  if (typeof path === 'string') return path;
  if (path instanceof URL) {
    if (path.protocol !== 'file:')
      throw invalidArg('path', 'of type string or an instance of URL with scheme file:', path);
    return decodeURIComponent(path.pathname);
  }
  throw invalidArg('path', 'of type string or an instance of URL', path);
}

function encodingOf(options: EncodingOption): Encoding | null {
  if (options === null || options === undefined) return null;
  if (typeof options === 'string') return options;
  return options.encoding ?? null;
}

/** Synchronous `fs` subset backed by kernel syscalls. */
export function createFs(syscall: SyscallClient, path: PosixPath) {
  /**
   * Issues a syscall and rethrows kernel errnos as Node-shaped errors that
   * name the syscall and the path exactly as the caller passed it.
   */
  function call(op: number, args: Value, syscallName: string, displayPath: string): Uint8Array {
    try {
      return syscall.call(op, encode(args));
    } catch (err) {
      if (!(err instanceof SyscallError)) throw err;
      const code = errnoCode(err.errno);
      // Node reports reading a directory as a failed read(2), without a path.
      if (code === 'EISDIR' && syscallName === 'open' && op === Op.READ_FILE) {
        throw new SystemError(code, 'read');
      }
      throw new SystemError(code, syscallName, displayPath);
    }
  }

  function readFileSync(file: PathLike, options?: EncodingOption): string | Uint8Array {
    const p = toPathString(file);
    const data = call(Op.READ_FILE, [path.resolve(p)], 'open', p);
    const encoding = encodingOf(options);
    return encoding ? decodeUtf8(data) : data;
  }

  function writeFileSync(
    file: PathLike,
    data: string | Uint8Array,
    options?: Encoding | { encoding?: Encoding | null; mode?: number; flag?: string } | null,
  ): void {
    const p = toPathString(file);
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw invalidArg(
        'data',
        'of type string or an instance of Buffer, TypedArray, or DataView',
        data,
      );
    }
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    const mode = typeof options === 'object' && options !== null ? options.mode : undefined;
    call(Op.WRITE_FILE, [path.resolve(p), bytes, mode ?? null], 'open', p);
  }

  function readdirSync(
    dir: PathLike,
    options?: Encoding | { encoding?: Encoding | null; withFileTypes?: boolean } | null,
  ): string[] | Dirent[] {
    const p = toPathString(dir);
    const withFileTypes =
      typeof options === 'object' && options !== null && options.withFileTypes === true;
    const result = decode(call(Op.READDIR, [path.resolve(p), withFileTypes], 'scandir', p));
    if (!withFileTypes) return result as string[];
    return (result as [string, string][]).map(([name, kind]) => new Dirent(name, p, kind));
  }

  function statWith(op: number, syscallName: string) {
    return (file: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined => {
      const p = toPathString(file);
      try {
        return new Stats(decodeStat(call(op, [path.resolve(p)], syscallName, p)));
      } catch (err) {
        if (
          options?.throwIfNoEntry === false &&
          err instanceof SystemError &&
          err.code === 'ENOENT'
        ) {
          return undefined;
        }
        throw err;
      }
    };
  }

  const statSync = statWith(Op.STAT, 'stat');
  const lstatSync = statWith(Op.LSTAT, 'lstat');

  function existsSync(file: PathLike): boolean {
    try {
      statSync(file);
      return true;
    } catch {
      return false;
    }
  }

  function mkdirSync(
    dir: PathLike,
    options?: number | { recursive?: boolean; mode?: number },
  ): string | undefined {
    const p = toPathString(dir);
    const opts = typeof options === 'number' ? { mode: options } : (options ?? {});
    const created = decode(
      call(Op.MKDIR, [path.resolve(p), opts.recursive === true, opts.mode ?? null], 'mkdir', p),
    );
    return typeof created === 'string' ? created : undefined;
  }

  const constants = { S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

  return {
    readFileSync,
    writeFileSync,
    readdirSync,
    statSync,
    lstatSync,
    existsSync,
    mkdirSync,
    constants,
    Stats,
    Dirent,
  };
}

export type NodeFs = ReturnType<typeof createFs>;
