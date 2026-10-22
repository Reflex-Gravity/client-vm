// SPDX-License-Identifier: Apache-2.0
// `wasi`: WASI preview1 over the process's own `fs`, as Node's uvwasi sits on
// libuv, with uvwasi's rights checks and errno order (EBADF, then
// ENOTCAPABLE, then the file-type checks). Each WASI object has its own
// descriptor table (preopens from 3), so a WASI thread (one object per
// worker) sees the same files but not the same descriptors, as in Node.
// Guest memory may be a shared WebAssembly.Memory: views are taken per call
// (it can grow), and bytes are copied out of it before TextDecoder or
// getRandomValues, which refuse shared buffers.

import { codeError } from './internal/errors.ts';
import type { PosixPath } from './path.ts';

/** The synchronous `fs` calls WASI needs (the process's full `fs`, with stdio fds). */
export interface WasiFs {
  openSync(path: string, flags: number, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buf: Uint8Array, offset: number, length: number, pos: number | null): number;
  writeSync(
    fd: number,
    buf: Uint8Array,
    offset: number,
    length: number,
    pos: number | null,
  ): number;
  fstatSync(fd: number): WasiStat;
  statSync(path: string): WasiStat;
  lstatSync(path: string): WasiStat;
  ftruncateSync(fd: number, len: number): void;
  readdirSync(path: string, options: { withFileTypes: true }): WasiDirent[];
  mkdirSync(path: string): void;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  linkSync(existing: string, path: string): void;
  symlinkSync(target: string, path: string): void;
  readlinkSync(path: string): string;
  utimesSync(path: string, atime: number, mtime: number): void;
}

interface WasiStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface WasiDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

// Errno values in the order the WASI spec numbers them.
const ERRNO_NAMES = (
  'SUCCESS 2BIG ACCES ADDRINUSE ADDRNOTAVAIL AFNOSUPPORT AGAIN ALREADY BADF BADMSG BUSY ' +
  'CANCELED CHILD CONNABORTED CONNREFUSED CONNRESET DEADLK DESTADDRREQ DOM DQUOT EXIST FAULT ' +
  'FBIG HOSTUNREACH IDRM ILSEQ INPROGRESS INTR INVAL IO ISCONN ISDIR LOOP MFILE MLINK MSGSIZE ' +
  'MULTIHOP NAMETOOLONG NETDOWN NETRESET NETUNREACH NFILE NOBUFS NODEV NOENT NOEXEC NOLCK ' +
  'NOLINK NOMEM NOMSG NOPROTOOPT NOSPC NOSYS NOTCONN NOTDIR NOTEMPTY NOTRECOVERABLE NOTSOCK ' +
  'NOTSUP NOTTY NXIO OVERFLOW OWNERDEAD PERM PIPE PROTO PROTONOSUPPORT PROTOTYPE RANGE ROFS ' +
  'SPIPE SRCH STALE TIMEDOUT TXTBSY XDEV NOTCAPABLE'
).split(' ');
const ERRNO = Object.fromEntries(ERRNO_NAMES.map((n, i) => [n, i])) as Record<string, number>;
const SUCCESS = 0;
const BADF = 8;
const EXIST = 20;
const INVAL = 28;
const IO = 29;
const ISDIR = 31;
const LOOP = 32;
const NOENT = 44;
const NOSYS = 52;
const NOTDIR = 54;
const NOTSUP = 58;
const SPIPE = 70;
const NOTCAPABLE = 76;

const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;

const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const LOOKUP_SYMLINK_FOLLOW = 1;
const FSTFLAGS_ATIM = 1;
const FSTFLAGS_ATIM_NOW = 2;
const FSTFLAGS_MTIM = 4;
const FSTFLAGS_MTIM_NOW = 8;

// Rights, by bit.
const R = (bit: number) => 1n << BigInt(bit);
const FD_DATASYNC = R(0);
const FD_READ = R(1);
const FD_SEEK = R(2);
const FD_FDSTAT_SET_FLAGS = R(3);
const FD_SYNC = R(4);
const FD_TELL = R(5);
const FD_WRITE = R(6);
const FD_ADVISE = R(7);
const FD_ALLOCATE = R(8);
const PATH_CREATE_DIRECTORY = R(9);
const PATH_CREATE_FILE = R(10);
const PATH_LINK_SOURCE = R(11);
const PATH_LINK_TARGET = R(12);
const PATH_OPEN = R(13);
const FD_READDIR = R(14);
const PATH_READLINK = R(15);
const PATH_RENAME_SOURCE = R(16);
const PATH_RENAME_TARGET = R(17);
const PATH_FILESTAT_GET = R(18);
const PATH_FILESTAT_SET_SIZE = R(19);
const PATH_FILESTAT_SET_TIMES = R(20);
const FD_FILESTAT_GET = R(21);
const FD_FILESTAT_SET_SIZE = R(22);
const FD_FILESTAT_SET_TIMES = R(23);
const PATH_SYMLINK = R(24);
const PATH_REMOVE_DIRECTORY = R(25);
const PATH_UNLINK_FILE = R(26);
const POLL_FD_READWRITE = R(27);
// The most a descriptor of each type can hold (uvwasi's tables).
const FILE_RIGHTS =
  FD_DATASYNC |
  FD_READ |
  FD_SEEK |
  FD_FDSTAT_SET_FLAGS |
  FD_SYNC |
  FD_TELL |
  FD_WRITE |
  FD_ADVISE |
  FD_ALLOCATE |
  FD_FILESTAT_GET |
  FD_FILESTAT_SET_SIZE |
  FD_FILESTAT_SET_TIMES |
  POLL_FD_READWRITE;
const DIR_RIGHTS =
  FD_FDSTAT_SET_FLAGS |
  FD_SYNC |
  FD_ADVISE |
  PATH_CREATE_DIRECTORY |
  PATH_CREATE_FILE |
  PATH_LINK_SOURCE |
  PATH_LINK_TARGET |
  PATH_OPEN |
  FD_READDIR |
  PATH_READLINK |
  PATH_RENAME_SOURCE |
  PATH_RENAME_TARGET |
  PATH_FILESTAT_GET |
  PATH_FILESTAT_SET_SIZE |
  PATH_FILESTAT_SET_TIMES |
  FD_FILESTAT_GET |
  FD_FILESTAT_SET_TIMES |
  PATH_SYMLINK |
  PATH_UNLINK_FILE |
  PATH_REMOVE_DIRECTORY |
  POLL_FD_READWRITE;
const DIR_INHERITING = DIR_RIGHTS | FILE_RIGHTS;
const TTY_RIGHTS = FD_READ | FD_FDSTAT_SET_FLAGS | FD_WRITE | FD_FILESTAT_GET | POLL_FD_READWRITE;

// Linux open(2) flags, as the kernel takes them.
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

interface Rights {
  base: bigint;
  inheriting: bigint;
}
type Entry = Rights &
  (
    | { kind: 'stdio'; host: number }
    | { kind: 'dir'; path: string; root: string; preopen?: string; list?: WasiDirent[] }
    | { kind: 'file'; host: number; path: string; root: string; pos: number; append: boolean }
  );
type Dir = Extract<Entry, { kind: 'dir' }>;

/** proc_exit unwinds the guest with this; `start` turns it into a return value. */
class WasiExit {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

const kInstance = Symbol('kInstance');
const kSetMemory = Symbol('kSetMemory');
const kStarted = Symbol('kStarted');
const kExitCode = Symbol('kExitCode');

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function filetypeOf(st: { mode: number }): number {
  switch (st.mode & 0o170000) {
    case 0o040000:
      return FILETYPE_DIRECTORY;
    case 0o100000:
      return FILETYPE_REGULAR_FILE;
    case 0o120000:
      return FILETYPE_SYMBOLIC_LINK;
    case 0o020000:
      return FILETYPE_CHARACTER_DEVICE;
    default:
      return FILETYPE_UNKNOWN;
  }
}

function direntType(d: WasiDirent): number {
  if (d.isDirectory()) return FILETYPE_DIRECTORY;
  if (d.isFile()) return FILETYPE_REGULAR_FILE;
  if (d.isSymbolicLink()) return FILETYPE_SYMBOLIC_LINK;
  return FILETYPE_UNKNOWN;
}

/** The WASI errno for a thrown fs error. */
function errnoOf(err: unknown): number {
  if (err instanceof WasiExit) throw err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code.startsWith('E')) return ERRNO[code.slice(1)] ?? IO;
  return IO;
}

const ns = (ms: number) => BigInt(Math.round(ms * 1e6));

export interface WasiDeps {
  fs: WasiFs;
  path: PosixPath;
}

export function createWasi(deps: WasiDeps): Record<string, unknown> {
  const { fs, path } = deps;

  class WASI {
    readonly wasiImport: Record<string, (...args: never[]) => number>;
    private readonly version: string;
    private readonly returnOnExit: boolean;
    declare [kInstance]: { exports: Record<string, unknown> } | undefined;
    declare [kStarted]: boolean;
    declare [kExitCode]: number;
    declare [kSetMemory]: (memory: WebAssembly.Memory) => void;

    constructor(options: Record<string, unknown> = {}) {
      if (typeof options !== 'object' || options === null) {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "options" argument must be of type object.',
        );
      }
      const version = options['version'];
      if (typeof version !== 'string') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "options.version" property must be of type string.',
        );
      }
      if (version !== 'preview1' && version !== 'unstable') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_VALUE',
          `The property 'options.version' must be one of: 'unstable', 'preview1'. Received '${version}'`,
        );
      }
      this.version = version;
      this.returnOnExit = options['returnOnExit'] !== false;
      const args = ((options['args'] as unknown[]) ?? []).map(String);
      const envObj = (options['env'] as Record<string, unknown>) ?? {};
      const env = Object.entries(envObj).map(([k, v]) => `${k}=${String(v)}`);
      const fds = new Map<number, Entry>();
      const stdio = (host: unknown): Entry => ({
        kind: 'stdio',
        host: Number(host),
        base: TTY_RIGHTS,
        inheriting: 0n,
      });
      fds.set(0, stdio(options['stdin'] ?? 0));
      fds.set(1, stdio(options['stdout'] ?? 1));
      fds.set(2, stdio(options['stderr'] ?? 2));
      let nextFd = 3;
      for (const [guest, host] of Object.entries(
        (options['preopens'] as Record<string, string>) ?? {},
      )) {
        const root = path.resolve(String(host));
        fds.set(nextFd++, {
          kind: 'dir',
          path: root,
          root,
          preopen: guest,
          base: DIR_RIGHTS,
          inheriting: DIR_INHERITING,
        });
      }
      const allocFd = (entry: Entry) => {
        while (fds.has(nextFd)) nextFd++;
        fds.set(nextFd, entry);
        return nextFd++;
      };

      let memory: WebAssembly.Memory | undefined;
      Object.defineProperty(this, kSetMemory, {
        value: (m: WebAssembly.Memory) => (memory = m),
      });
      this[kInstance] = undefined;
      this[kStarted] = false;
      this[kExitCode] = 0;

      const mem = () => {
        if (!memory) throw new Error('WASI: memory is not set (call start or initialize first)');
        return memory.buffer;
      };
      const view = () => new DataView(mem());
      const bytes = () => new Uint8Array(mem());
      /** A non-shared copy of guest bytes. */
      const copyOut = (ptr: number, len: number) => new Uint8Array(mem(), ptr, len).slice();
      const str = (ptr: number, len: number) => fromUtf8.decode(copyOut(ptr, len));
      const iovecs = (iovs: number, count: number): [number, number][] => {
        const dv = view();
        const out: [number, number][] = [];
        for (let i = 0; i < count; i++) {
          out.push([dv.getUint32(iovs + i * 8, true), dv.getUint32(iovs + i * 8 + 4, true)]);
        }
        return out;
      };
      const writeStat = (ptr: number, st: WasiStat) => {
        const dv = view();
        dv.setBigUint64(ptr, BigInt(st.dev), true);
        dv.setBigUint64(ptr + 8, BigInt(st.ino), true);
        dv.setUint8(ptr + 16, filetypeOf(st));
        dv.setBigUint64(ptr + 24, BigInt(st.nlink), true);
        dv.setBigUint64(ptr + 32, BigInt(st.size), true);
        dv.setBigUint64(ptr + 40, ns(st.atimeMs), true);
        dv.setBigUint64(ptr + 48, ns(st.mtimeMs), true);
        dv.setBigUint64(ptr + 56, ns(st.ctimeMs), true);
      };
      const writeStrings = (list: string[], ptrs: number, buf: number) => {
        const dv = view();
        const b = bytes();
        let at = buf;
        list.forEach((s, i) => {
          const enc = utf8.encode(`${s}\0`);
          dv.setUint32(ptrs + i * 4, at, true);
          b.set(enc, at);
          at += enc.length;
        });
        return SUCCESS;
      };
      const writeSizes = (list: string[], countPtr: number, sizePtr: number) => {
        const dv = view();
        dv.setUint32(countPtr, list.length, true);
        dv.setUint32(
          sizePtr,
          list.reduce((n, s) => n + utf8.encode(s).length + 1, 0),
          true,
        );
        return SUCCESS;
      };
      /** The entry for `fd` if it holds the rights, else EBADF or ENOTCAPABLE. */
      const get = (fd: number, base: bigint, inheriting = 0n): Entry | number => {
        const e = fds.get(fd);
        if (!e) return BADF;
        if ((e.base & base) !== base || (e.inheriting & inheriting) !== inheriting) {
          return NOTCAPABLE;
        }
        return e;
      };
      /** `path` under directory fd `fd` (which must hold `right`), or an errno. */
      const resolveAt = (
        fd: number,
        right: bigint,
        ptr: number,
        len: number,
        inheriting = 0n,
      ): [Dir, string] | number => {
        const dir = get(fd, right, inheriting);
        if (typeof dir === 'number') return dir;
        if (dir.kind !== 'dir') return NOTDIR;
        const target = path.resolve(dir.path, str(ptr, len));
        // Like uvwasi, a path may not leave the preopen it came from.
        const inside = dir.root === '/' ? '/' : `${dir.root}/`;
        if (target !== dir.root && !target.startsWith(inside)) return NOTCAPABLE;
        return [dir, target];
      };
      /** Wraps a syscall body: fs errors become errnos. */
      const guard = (fn: () => number) => {
        try {
          return fn();
        } catch (err) {
          return errnoOf(err);
        }
      };
      const sleepCell = new Int32Array(new SharedArrayBuffer(4));
      const now = (id: number) =>
        id === 0
          ? ns(performance.timeOrigin + performance.now())
          : id <= 3
            ? ns(performance.now())
            : undefined;

      type Io = Extract<Entry, { kind: 'file' | 'stdio' }>;
      const readInto = (e: Io, iovs: number, count: number, at: number | null) => {
        let total = 0;
        for (const [ptr, len] of iovecs(iovs, count)) {
          if (len === 0) continue;
          const tmp = new Uint8Array(len);
          const pos = at !== null ? at + total : e.kind === 'file' ? e.pos : null;
          const n = fs.readSync(e.host, tmp, 0, len, pos);
          bytes().set(tmp.subarray(0, n), ptr);
          total += n;
          if (e.kind === 'file' && at === null) e.pos += n;
          if (n < len) break;
        }
        return total;
      };
      const writeFrom = (e: Io, iovs: number, count: number, at: number | null) => {
        let total = 0;
        for (const [ptr, len] of iovecs(iovs, count)) {
          if (len === 0) continue;
          const data = copyOut(ptr, len);
          if (e.kind === 'stdio') {
            total += fs.writeSync(e.host, data, 0, len, null);
            continue;
          }
          const pos = at !== null ? at + total : e.append ? null : e.pos;
          const n = fs.writeSync(e.host, data, 0, len, pos);
          if (at === null) e.pos = e.append ? fs.fstatSync(e.host).size : e.pos + n;
          total += n;
        }
        return total;
      };
      /** Reads or writes through `fd`; `at` is an explicit offset (pread/pwrite). */
      const transfer = (
        fd: number,
        right: bigint,
        iovs: number,
        count: number,
        at: number | null,
        out: number,
      ) =>
        guard(() => {
          const e = get(fd, at === null ? right : right | FD_SEEK);
          if (typeof e === 'number') return e;
          if (e.kind === 'dir') return ISDIR;
          if (at !== null && e.kind === 'stdio') return SPIPE;
          const n =
            right === FD_READ ? readInto(e, iovs, count, at) : writeFrom(e, iovs, count, at);
          view().setUint32(out, n, true);
          return SUCCESS;
        });
      const setTimes = (p: string, atim: bigint, mtim: bigint, flags: number) => {
        if (
          (flags & FSTFLAGS_ATIM && flags & FSTFLAGS_ATIM_NOW) ||
          (flags & FSTFLAGS_MTIM && flags & FSTFLAGS_MTIM_NOW)
        ) {
          return INVAL;
        }
        const st = fs.statSync(p);
        const t = (set: number, setNow: number, value: bigint, old: number) =>
          flags & setNow ? Date.now() / 1000 : flags & set ? Number(value) / 1e9 : old / 1000;
        fs.utimesSync(
          p,
          t(FSTFLAGS_ATIM, FSTFLAGS_ATIM_NOW, atim, st.atimeMs),
          t(FSTFLAGS_MTIM, FSTFLAGS_MTIM_NOW, mtim, st.mtimeMs),
        );
        return SUCCESS;
      };
      /** A descriptor-only call that has nothing to do beyond its rights check. */
      const check = (right: bigint) => (fd: number) => {
        const e = get(fd, right);
        return typeof e === 'number' ? e : SUCCESS;
      };
      /** A path call under a directory fd holding `right`. */
      const atPath =
        (right: bigint, fn: (p: string) => number) => (fd: number, ptr: number, len: number) =>
          guard(() => {
            const r = resolveAt(fd, right, ptr, len);
            return typeof r === 'number' ? r : fn(r[1]);
          });

      const wasi: Record<string, (...args: never[]) => number> = {
        args_get: (argv: number, buf: number) => writeStrings(args, argv, buf),
        args_sizes_get: (count: number, size: number) => writeSizes(args, count, size),
        environ_get: (ptrs: number, buf: number) => writeStrings(env, ptrs, buf),
        environ_sizes_get: (count: number, size: number) => writeSizes(env, count, size),
        clock_res_get: (id: number, out: number) => {
          if (id > 3) return INVAL;
          view().setBigUint64(out, 1000n, true);
          return SUCCESS;
        },
        clock_time_get: (id: number, _precision: bigint, out: number) => {
          const t = now(id);
          if (t === undefined) return INVAL;
          view().setBigUint64(out, t, true);
          return SUCCESS;
        },
        fd_advise: check(FD_ADVISE),
        fd_allocate: (fd: number, offset: bigint, len: bigint) =>
          guard(() => {
            const e = get(fd, FD_ALLOCATE);
            if (typeof e === 'number') return e;
            if (e.kind !== 'file') return e.kind === 'dir' ? ISDIR : SPIPE;
            const end = Number(offset + len);
            if (fs.fstatSync(e.host).size < end) fs.ftruncateSync(e.host, end);
            return SUCCESS;
          }),
        fd_close: (fd: number) =>
          guard(() => {
            const e = fds.get(fd);
            if (!e) return BADF;
            if (e.kind === 'file') fs.closeSync(e.host);
            fds.delete(fd);
            return SUCCESS;
          }),
        fd_datasync: check(FD_DATASYNC),
        fd_sync: check(FD_SYNC),
        fd_fdstat_get: (fd: number, out: number) => {
          const e = fds.get(fd);
          if (!e) return BADF;
          const dv = view();
          const type =
            e.kind === 'dir'
              ? FILETYPE_DIRECTORY
              : e.kind === 'file'
                ? FILETYPE_REGULAR_FILE
                : FILETYPE_CHARACTER_DEVICE;
          dv.setUint8(out, type);
          dv.setUint16(out + 2, e.kind === 'file' && e.append ? FDFLAGS_APPEND : 0, true);
          dv.setBigUint64(out + 8, e.base, true);
          dv.setBigUint64(out + 16, e.inheriting, true);
          return SUCCESS;
        },
        fd_fdstat_set_flags: (fd: number, flags: number) => {
          const e = get(fd, FD_FDSTAT_SET_FLAGS);
          if (typeof e === 'number') return e;
          if (e.kind === 'file') e.append = (flags & FDFLAGS_APPEND) !== 0;
          return SUCCESS;
        },
        fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint) => {
          const e = fds.get(fd);
          if (!e) return BADF;
          // Rights can only be dropped.
          if ((e.base | base) !== e.base || (e.inheriting | inheriting) !== e.inheriting) {
            return NOTCAPABLE;
          }
          e.base = base;
          e.inheriting = inheriting;
          return SUCCESS;
        },
        fd_filestat_get: (fd: number, out: number) =>
          guard(() => {
            const e = get(fd, FD_FILESTAT_GET);
            if (typeof e === 'number') return e;
            if (e.kind === 'stdio') {
              new Uint8Array(mem(), out, 64).fill(0);
              view().setUint8(out + 16, FILETYPE_CHARACTER_DEVICE);
              return SUCCESS;
            }
            writeStat(out, e.kind === 'file' ? fs.fstatSync(e.host) : fs.statSync(e.path));
            return SUCCESS;
          }),
        fd_filestat_set_size: (fd: number, size: bigint) =>
          guard(() => {
            const e = get(fd, FD_FILESTAT_SET_SIZE);
            if (typeof e === 'number') return e;
            if (e.kind !== 'file') return e.kind === 'dir' ? ISDIR : INVAL;
            fs.ftruncateSync(e.host, Number(size));
            return SUCCESS;
          }),
        fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) =>
          guard(() => {
            const e = get(fd, FD_FILESTAT_SET_TIMES);
            if (typeof e === 'number') return e;
            if (e.kind === 'stdio') return SUCCESS;
            return setTimes(e.path, atim, mtim, flags);
          }),
        fd_pread: (fd: number, iovs: number, count: number, offset: bigint, out: number) =>
          transfer(fd, FD_READ, iovs, count, Number(offset), out),
        fd_pwrite: (fd: number, iovs: number, count: number, offset: bigint, out: number) =>
          transfer(fd, FD_WRITE, iovs, count, Number(offset), out),
        fd_read: (fd: number, iovs: number, count: number, out: number) =>
          transfer(fd, FD_READ, iovs, count, null, out),
        fd_write: (fd: number, iovs: number, count: number, out: number) =>
          transfer(fd, FD_WRITE, iovs, count, null, out),
        fd_prestat_get: (fd: number, out: number) => {
          const e = fds.get(fd);
          if (e?.kind !== 'dir' || e.preopen === undefined) return BADF;
          const dv = view();
          dv.setUint8(out, 0);
          dv.setUint32(out + 4, utf8.encode(e.preopen).length, true);
          return SUCCESS;
        },
        fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
          const e = fds.get(fd);
          if (e?.kind !== 'dir' || e.preopen === undefined) return BADF;
          bytes().set(utf8.encode(e.preopen).subarray(0, len), ptr);
          return SUCCESS;
        },
        fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, out: number) =>
          guard(() => {
            const e = get(fd, FD_READDIR);
            if (typeof e === 'number') return e;
            if (e.kind !== 'dir') return NOTDIR;
            if (cookie === 0n || !e.list) e.list = fs.readdirSync(e.path, { withFileTypes: true });
            let used = 0;
            for (let i = Number(cookie); i < e.list.length && used < bufLen; i++) {
              const d = e.list[i]!;
              const name = utf8.encode(d.name);
              const rec = new Uint8Array(24 + name.length);
              const dv = new DataView(rec.buffer);
              dv.setBigUint64(0, BigInt(i + 1), true);
              dv.setUint32(16, name.length, true);
              dv.setUint8(20, direntType(d));
              rec.set(name, 24);
              // A record that does not fit is cut off; the caller sees a full buffer and retries.
              const n = Math.min(rec.length, bufLen - used);
              bytes().set(rec.subarray(0, n), buf + used);
              used += n;
            }
            view().setUint32(out, used, true);
            return SUCCESS;
          }),
        fd_renumber: (from: number, to: number) =>
          guard(() => {
            const e = fds.get(from);
            const old = fds.get(to);
            if (!e || !old) return BADF;
            if (old.kind === 'file') fs.closeSync(old.host);
            fds.set(to, e);
            fds.delete(from);
            return SUCCESS;
          }),
        fd_seek: (fd: number, offset: bigint, whence: number, out: number) =>
          guard(() => {
            const tellOnly = offset === 0n && whence === 1;
            const e = get(fd, tellOnly ? FD_TELL : FD_SEEK);
            if (typeof e === 'number') return e;
            if (e.kind !== 'file') return e.kind === 'dir' ? ISDIR : SPIPE;
            const base =
              whence === 0
                ? 0
                : whence === 1
                  ? e.pos
                  : whence === 2
                    ? fs.fstatSync(e.host).size
                    : NaN;
            const next = base + Number(offset);
            if (!(next >= 0)) return INVAL;
            e.pos = next;
            view().setBigUint64(out, BigInt(next), true);
            return SUCCESS;
          }),
        fd_tell: (fd: number, out: number) => {
          const e = get(fd, FD_TELL);
          if (typeof e === 'number') return e;
          if (e.kind !== 'file') return e.kind === 'dir' ? ISDIR : SPIPE;
          view().setBigUint64(out, BigInt(e.pos), true);
          return SUCCESS;
        },
        path_create_directory: atPath(PATH_CREATE_DIRECTORY, (p) => {
          fs.mkdirSync(p);
          return SUCCESS;
        }),
        path_filestat_get: (fd: number, flags: number, ptr: number, len: number, out: number) =>
          guard(() => {
            const r = resolveAt(fd, PATH_FILESTAT_GET, ptr, len);
            if (typeof r === 'number') return r;
            writeStat(out, flags & LOOKUP_SYMLINK_FOLLOW ? fs.statSync(r[1]) : fs.lstatSync(r[1]));
            return SUCCESS;
          }),
        path_filestat_set_times: (
          fd: number,
          _flags: number,
          ptr: number,
          len: number,
          atim: bigint,
          mtim: bigint,
          fstFlags: number,
        ) =>
          guard(() => {
            const r = resolveAt(fd, PATH_FILESTAT_SET_TIMES, ptr, len);
            return typeof r === 'number' ? r : setTimes(r[1], atim, mtim, fstFlags);
          }),
        path_link: (
          oldFd: number,
          _flags: number,
          oldPtr: number,
          oldLen: number,
          newFd: number,
          newPtr: number,
          newLen: number,
        ) =>
          guard(() => {
            const from = resolveAt(oldFd, PATH_LINK_SOURCE, oldPtr, oldLen);
            if (typeof from === 'number') return from;
            const to = resolveAt(newFd, PATH_LINK_TARGET, newPtr, newLen);
            if (typeof to === 'number') return to;
            fs.linkSync(from[1], to[1]);
            return SUCCESS;
          }),
        path_open: (
          fd: number,
          lookup: number,
          ptr: number,
          len: number,
          oflags: number,
          base: bigint,
          inheriting: bigint,
          fdflags: number,
          out: number,
        ) =>
          guard(() => {
            let needed = PATH_OPEN;
            if (oflags & OFLAGS_CREAT) needed |= PATH_CREATE_FILE;
            if (oflags & OFLAGS_TRUNC) needed |= PATH_FILESTAT_SET_SIZE;
            const r = resolveAt(fd, needed, ptr, len, base | inheriting);
            if (typeof r === 'number') return r;
            const [dir, p] = r;
            const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
            let st: WasiStat | undefined;
            try {
              st = follow ? fs.statSync(p) : fs.lstatSync(p);
            } catch (err) {
              if ((err as { code?: string }).code !== 'ENOENT' || !(oflags & OFLAGS_CREAT))
                throw err;
            }
            if (st && oflags & OFLAGS_CREAT && oflags & OFLAGS_EXCL) return EXIST;
            if (st && !follow && st.isSymbolicLink()) return LOOP;
            const read = (base & (FD_READ | FD_READDIR)) !== 0n;
            const write =
              (base & (FD_DATASYNC | FD_WRITE | FD_ALLOCATE | FD_FILESTAT_SET_SIZE)) !== 0n;
            if (st?.isDirectory()) {
              if (write || oflags & OFLAGS_TRUNC) return ISDIR;
              const entry: Entry = {
                kind: 'dir',
                path: p,
                root: dir.root,
                base: base & DIR_RIGHTS,
                inheriting: inheriting & DIR_INHERITING,
              };
              view().setUint32(out, allocFd(entry), true);
              return SUCCESS;
            }
            if (oflags & OFLAGS_DIRECTORY) return st ? NOTDIR : NOENT;
            const append = (fdflags & FDFLAGS_APPEND) !== 0;
            let flags = write ? (read ? O_RDWR : O_WRONLY) : O_RDONLY;
            if (oflags & OFLAGS_CREAT) flags |= O_CREAT;
            if (oflags & OFLAGS_EXCL) flags |= O_EXCL;
            if (oflags & OFLAGS_TRUNC) flags |= O_TRUNC;
            if (append) flags |= O_APPEND;
            const host = fs.openSync(p, flags, 0o666);
            const entry: Entry = {
              kind: 'file',
              host,
              path: p,
              root: dir.root,
              pos: 0,
              append,
              base: base & FILE_RIGHTS,
              inheriting: 0n,
            };
            view().setUint32(out, allocFd(entry), true);
            return SUCCESS;
          }),
        path_readlink: (
          fd: number,
          ptr: number,
          len: number,
          buf: number,
          bufLen: number,
          out: number,
        ) =>
          guard(() => {
            const r = resolveAt(fd, PATH_READLINK, ptr, len);
            if (typeof r === 'number') return r;
            const target = utf8.encode(fs.readlinkSync(r[1])).subarray(0, bufLen);
            bytes().set(target, buf);
            view().setUint32(out, target.length, true);
            return SUCCESS;
          }),
        path_remove_directory: atPath(PATH_REMOVE_DIRECTORY, (p) => {
          fs.rmdirSync(p);
          return SUCCESS;
        }),
        path_rename: (
          fd: number,
          oldPtr: number,
          oldLen: number,
          newFd: number,
          newPtr: number,
          newLen: number,
        ) =>
          guard(() => {
            const from = resolveAt(fd, PATH_RENAME_SOURCE, oldPtr, oldLen);
            if (typeof from === 'number') return from;
            const to = resolveAt(newFd, PATH_RENAME_TARGET, newPtr, newLen);
            if (typeof to === 'number') return to;
            fs.renameSync(from[1], to[1]);
            return SUCCESS;
          }),
        path_symlink: (
          oldPtr: number,
          oldLen: number,
          fd: number,
          newPtr: number,
          newLen: number,
        ) =>
          guard(() => {
            const r = resolveAt(fd, PATH_SYMLINK, newPtr, newLen);
            if (typeof r === 'number') return r;
            fs.symlinkSync(str(oldPtr, oldLen), r[1]);
            return SUCCESS;
          }),
        path_unlink_file: atPath(PATH_UNLINK_FILE, (p) => {
          fs.unlinkSync(p);
          return SUCCESS;
        }),
        poll_oneoff: (inPtr: number, outPtr: number, count: number, eventsOut: number) => {
          if (count === 0) return INVAL;
          const dv = view();
          // Descriptors are always ready; clocks are slept on (this is a worker, so it may block).
          const ready: number[] = [];
          let soonest = Infinity;
          const clocks: [number, number][] = [];
          for (let i = 0; i < count; i++) {
            const sub = inPtr + i * 48;
            if (dv.getUint8(sub + 8) !== 0) {
              ready.push(i);
              continue;
            }
            const id = dv.getUint32(sub + 16, true);
            const timeout = Number(dv.getBigUint64(sub + 24, true)) / 1e6;
            const abs = (dv.getUint16(sub + 40, true) & 1) !== 0;
            const base = now(id);
            const ms = abs && base !== undefined ? timeout - Number(base) / 1e6 : timeout;
            clocks.push([i, ms]);
            soonest = Math.min(soonest, ms);
          }
          if (ready.length === 0 && soonest > 0 && Number.isFinite(soonest)) {
            Atomics.wait(sleepCell, 0, 0, soonest);
          }
          if (ready.length === 0) for (const [i, ms] of clocks) if (ms <= soonest) ready.push(i);
          const ev = view();
          ready.forEach((i, n) => {
            const sub = inPtr + i * 48;
            const e = outPtr + n * 32;
            new Uint8Array(mem(), e, 32).fill(0);
            ev.setBigUint64(e, ev.getBigUint64(sub, true), true);
            ev.setUint8(e + 10, ev.getUint8(sub + 8));
          });
          ev.setUint32(eventsOut, ready.length, true);
          return SUCCESS;
        },
        proc_exit: (code: number) => {
          throw new WasiExit(code);
        },
        proc_raise: () => NOSYS,
        random_get: (ptr: number, len: number) => {
          const tmp = new Uint8Array(len);
          for (let i = 0; i < len; i += 65536) crypto.getRandomValues(tmp.subarray(i, i + 65536));
          bytes().set(tmp, ptr);
          return SUCCESS;
        },
        sched_yield: () => SUCCESS,
        sock_accept: () => NOTSUP,
        sock_recv: () => NOTSUP,
        sock_send: () => NOTSUP,
        sock_shutdown: () => NOTSUP,
      };
      this.wasiImport = wasi;
    }

    getImportObject(): Record<string, unknown> {
      const name = this.version === 'unstable' ? 'wasi_unstable' : 'wasi_snapshot_preview1';
      return { [name]: this.wasiImport };
    }

    private begin(instance: unknown, entry: '_start' | '_initialize'): Record<string, unknown> {
      if (typeof instance !== 'object' || instance === null) {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "instance" argument must be of type object.',
        );
      }
      const exports = (instance as { exports?: Record<string, unknown> }).exports;
      if (typeof exports !== 'object' || exports === null) {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "instance.exports" property must be of type object.',
        );
      }
      if (!(exports['memory'] instanceof WebAssembly.Memory)) {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "instance.exports.memory" property must be a WebAssembly.Memory.',
        );
      }
      const other = entry === '_start' ? '_initialize' : '_start';
      if (typeof exports[other] === 'function') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          `The "instance.exports.${other}" property must be undefined.`,
        );
      }
      if (this[kStarted]) {
        throw codeError(Error, 'ERR_WASI_ALREADY_STARTED', 'WASI instance has already started');
      }
      this[kStarted] = true;
      this[kInstance] = instance as { exports: Record<string, unknown> };
      this[kSetMemory](exports['memory']);
      return exports;
    }

    start(instance: unknown): number | undefined {
      const exports = this.begin(instance, '_start');
      if (typeof exports['_start'] !== 'function') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "instance.exports._start" property must be of type function.',
        );
      }
      try {
        (exports['_start'] as () => void)();
      } catch (err) {
        if (!(err instanceof WasiExit)) throw err;
        if (!this.returnOnExit) {
          (globalThis as { process?: { exit(code: number): void } }).process?.exit(err.code);
        }
        return (this[kExitCode] = err.code);
      }
      return (this[kExitCode] = 0);
    }

    initialize(instance: unknown): void {
      const exports = this.begin(instance, '_initialize');
      const init = exports['_initialize'];
      if (init !== undefined && typeof init !== 'function') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          'The "instance.exports._initialize" property must be of type function.',
        );
      }
      (init as (() => void) | undefined)?.();
    }
  }

  return { WASI };
}
