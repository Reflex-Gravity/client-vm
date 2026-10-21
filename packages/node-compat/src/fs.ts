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

type OpenFlags = string | number;

const FLAG_STRINGS: Record<string, number> = {
  r: 0,
  rs: 0,
  sr: 0,
  'r+': 2,
  'rs+': 2,
  'sr+': 2,
  w: 0o1101,
  wx: 0o1301,
  xw: 0o1301,
  'w+': 0o1102,
  'wx+': 0o1302,
  'xw+': 0o1302,
  a: 0o2101,
  ax: 0o2301,
  xa: 0o2301,
  as: 0o2101,
  sa: 0o2101,
  'a+': 0o2102,
  'ax+': 0o2302,
  'xa+': 0o2302,
  'as+': 0o2102,
  'sa+': 0o2102,
};

function parseFlags(flags: OpenFlags): number {
  if (typeof flags === 'number') return flags;
  const value = FLAG_STRINGS[flags];
  if (value === undefined) {
    throw Object.assign(new TypeError(`The value "${flags}" is invalid for option "flags"`), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
  }
  return value;
}

/** Synchronous `fs` subset backed by kernel syscalls. */
export function createFs(syscall: SyscallClient, path: PosixPath) {
  /**
   * Issues a syscall and rethrows kernel errnos as Node-shaped errors that
   * name the syscall and the path exactly as the caller passed it.
   */
  function call(
    op: number,
    args: Value,
    syscallName: string,
    displayPath?: string,
    displayDest?: string,
  ): Uint8Array {
    try {
      return syscall.call(op, encode(args));
    } catch (err) {
      if (!(err instanceof SyscallError)) throw err;
      const code = errnoCode(err.errno);
      // Node reports reading a directory as a failed read(2), without a path.
      if (code === 'EISDIR' && syscallName === 'open' && op === Op.READ_FILE) {
        throw new SystemError(code, 'read');
      }
      throw new SystemError(code, syscallName, displayPath, displayDest);
    }
  }

  /** Runs a path-based syscall that returns nothing. */
  const pathCall = (op: number, syscallName: string, file: PathLike, ...rest: Value[]): void => {
    const p = toPathString(file);
    call(op, [path.resolve(p), ...rest], syscallName, p);
  };

  /** Runs a two-path syscall (errors show `'from' -> 'to'`). */
  const twoPathCall = (
    op: number,
    syscallName: string,
    from: PathLike,
    to: PathLike,
    ...rest: Value[]
  ): void => {
    const f = toPathString(from);
    const t = toPathString(to);
    call(op, [path.resolve(f), path.resolve(t), ...rest], syscallName, f, t);
  };

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

  function rmdirSync(dir: PathLike): void {
    pathCall(Op.RMDIR, 'rmdir', dir);
  }

  function unlinkSync(file: PathLike): void {
    pathCall(Op.UNLINK, 'unlink', file);
  }

  /** `fs.rmSync`. Unlike Node 24.11, a dangling symlink is removed (see docs/open-questions.md). */
  function rmSync(target: PathLike, options: { recursive?: boolean; force?: boolean } = {}): void {
    const p = toPathString(target);
    const stat = lstatSync(p, { throwIfNoEntry: false });
    if (!stat) {
      if (options.force) return;
      throw new SystemError('ENOENT', 'lstat', p);
    }
    if (stat.isDirectory() && !options.recursive) {
      const err = new SystemError('EISDIR', 'rm', p);
      throw Object.assign(err, {
        message: `Path is a directory: rm returned EISDIR (is a directory) ${p}`,
        code: 'ERR_FS_EISDIR',
      });
    }
    pathCall(Op.RM_TREE, 'rm', p);
  }

  function renameSync(from: PathLike, to: PathLike): void {
    twoPathCall(Op.RENAME, 'rename', from, to);
  }

  function linkSync(existing: PathLike, newPath: PathLike): void {
    twoPathCall(Op.LINK, 'link', existing, newPath);
  }

  function symlinkSync(target: PathLike, file: PathLike): void {
    // The target is stored verbatim (relative targets resolve against the link's directory).
    const t = toPathString(target);
    const p = toPathString(file);
    call(Op.SYMLINK, [t, path.resolve(p)], 'symlink', t, p);
  }

  function readlinkSync(file: PathLike): string {
    const p = toPathString(file);
    return decode(call(Op.READLINK, [path.resolve(p)], 'readlink', p)) as string;
  }

  function realpathSync(file: PathLike): string {
    const p = toPathString(file);
    return decode(call(Op.REALPATH, [path.resolve(p)], 'lstat', p)) as string;
  }
  realpathSync.native = (file: PathLike): string => {
    const p = toPathString(file);
    return decode(call(Op.REALPATH, [path.resolve(p)], 'realpath', p)) as string;
  };

  function accessSync(file: PathLike, mode = 0): void {
    pathCall(Op.ACCESS, 'access', file, mode);
  }

  function chmodSync(file: PathLike, mode: number | string): void {
    pathCall(Op.CHMOD, 'chmod', file, typeof mode === 'string' ? parseInt(mode, 8) : mode);
  }

  function utimesSync(file: PathLike, atime: number | Date, mtime: number | Date): void {
    const ms = (t: number | Date) => (t instanceof Date ? t.getTime() : t * 1000);
    pathCall(Op.UTIMES, 'utime', file, ms(atime), ms(mtime));
  }

  function truncateSync(file: PathLike, len = 0): void {
    pathCall(Op.TRUNCATE, 'open', file, len);
  }

  function copyFileSync(src: PathLike, dest: PathLike, mode = 0): void {
    twoPathCall(Op.COPY_FILE, 'copyfile', src, dest, (mode & constants.COPYFILE_EXCL) !== 0);
  }

  // ------------------------------------------------------------ file descriptors

  function openSync(file: PathLike, flags: OpenFlags = 'r', mode = 0o666): number {
    const p = toPathString(file);
    return decode(call(Op.OPEN, [path.resolve(p), parseFlags(flags), mode], 'open', p)) as number;
  }

  function closeSync(fd: number): void {
    call(Op.CLOSE, [fd], 'close');
  }

  function readSync(
    fd: number,
    buffer: Uint8Array,
    offsetOrOptions: number | { offset?: number; length?: number; position?: number | null } = 0,
    length?: number,
    position?: number | null,
  ): number {
    const opts =
      typeof offsetOrOptions === 'object'
        ? offsetOrOptions
        : { offset: offsetOrOptions, length, position };
    const offset = opts.offset ?? 0;
    const len = opts.length ?? buffer.length - offset;
    if (offset < 0 || len < 0 || offset + len > buffer.length) {
      throw Object.assign(new RangeError('The value of "length" is out of range.'), {
        code: 'ERR_OUT_OF_RANGE',
      });
    }
    const pos = typeof opts.position === 'number' && opts.position >= 0 ? opts.position : null;
    const data = call(Op.READ, [fd, len, pos], 'read');
    buffer.set(data, offset);
    return data.length;
  }

  function writeSync(
    fd: number,
    data: string | Uint8Array,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | string,
    position?: number | null,
  ): number {
    let bytes: Uint8Array;
    let pos: number | null | undefined;
    if (typeof data === 'string') {
      bytes = encodeUtf8(data);
      pos = offsetOrPosition;
    } else {
      const offset = offsetOrPosition ?? 0;
      const len = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : data.length - offset;
      bytes = data.subarray(offset, offset + len);
      pos = position;
    }
    return decode(
      call(Op.WRITE, [fd, bytes, typeof pos === 'number' ? pos : null], 'write'),
    ) as number;
  }

  function fstatSync(fd: number): Stats {
    return new Stats(decodeStat(call(Op.FSTAT, [fd], 'fstat')));
  }

  function ftruncateSync(fd: number, len = 0): void {
    call(Op.FTRUNCATE, [fd, len], 'ftruncate');
  }

  function appendFileSync(file: PathLike, data: string | Uint8Array): void {
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  const constants = {
    S_IFMT,
    S_IFREG,
    S_IFDIR,
    S_IFLNK,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 0o100,
    O_EXCL: 0o200,
    O_TRUNC: 0o1000,
    O_APPEND: 0o2000,
    COPYFILE_EXCL: 1,
  };

  return {
    readFileSync,
    writeFileSync,
    readdirSync,
    statSync,
    lstatSync,
    existsSync,
    mkdirSync,
    rmdirSync,
    unlinkSync,
    rmSync,
    renameSync,
    linkSync,
    symlinkSync,
    readlinkSync,
    realpathSync,
    accessSync,
    chmodSync,
    utimesSync,
    truncateSync,
    copyFileSync,
    openSync,
    closeSync,
    readSync,
    writeSync,
    fstatSync,
    ftruncateSync,
    appendFileSync,
    constants,
    Stats,
    Dirent,
  };
}

export type NodeFs = ReturnType<typeof createFs>;
