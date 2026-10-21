// SPDX-License-Identifier: Apache-2.0
// The rest of `fs` on top of the sync core: more sync APIs, the callback API,
// `fs.promises` with FileHandle, Dir, and read/write streams.
//
// Async operations run their sync counterpart and deliver the result on a
// later tick. Syscalls are in-memory and take microseconds, so this keeps
// Node's async contract (callbacks never run synchronously) without the
// complexity of a second async syscall path.

import { Buffer, codeError } from './buffer.ts';
import type { Buffer as BufferT } from './buffer.ts';
import type { NodeFs } from './fs.ts';
import type { PosixPath } from './path.ts';

type Fn = (...args: never[]) => unknown;
type StreamModule = Record<string, unknown> & {
  Readable: new (opts: object) => ReadableLike;
  Writable: new (opts: object) => WritableLike;
};
interface ReadableLike {
  push(chunk: unknown): boolean;
  destroy(err?: Error): void;
  emit(event: string, ...args: unknown[]): boolean;
  [key: string]: unknown;
}
interface WritableLike {
  emit(event: string, ...args: unknown[]): boolean;
  destroy(err?: Error): void;
  [key: string]: unknown;
}

export interface FsExtraDeps {
  fs: NodeFs;
  path: PosixPath;
  /** Loaded lazily: streams are only needed if a stream API is used. */
  stream: () => StreamModule;
  /** Schedules a callback on a later tick, keeping the process alive until it runs. */
  defer: (fn: () => void) => void;
}

const SKIP_CALLBACKIFY = new Set(['existsSync']);

/** Adds callback and promise APIs, Dir, streams and the remaining sync APIs to `fs`. */
export function extendFs(deps: FsExtraDeps): NodeFs & Record<string, unknown> {
  const { fs, path, defer } = deps;
  const out = fs as NodeFs & Record<string, unknown>;

  // ------------------------------------------------------------ more sync APIs

  const mkdtempSync = (prefix: string): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 100; attempt++) {
      let suffix = '';
      for (const b of crypto.getRandomValues(new Uint8Array(6)))
        suffix += alphabet[b % alphabet.length];
      const dir = `${prefix}${suffix}`;
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        return dir;
      } catch (err) {
        if ((err as { code?: string }).code !== 'EEXIST') throw err;
      }
    }
    throw codeError(Error, 'EEXIST', `EEXIST: file already exists, mkdtemp '${prefix}XXXXXX'`);
  };

  const cpSync = (
    src: string,
    dest: string,
    opts: {
      recursive?: boolean;
      force?: boolean;
      errorOnExist?: boolean;
      filter?: (s: string, d: string) => boolean;
      dereference?: boolean;
    } = {},
  ): void => {
    const force = opts.force ?? true;
    const copy = (s: string, d: string) => {
      if (opts.filter && !opts.filter(s, d)) return;
      const st = opts.dereference ? fs.statSync(s)! : fs.lstatSync(s)!;
      if (st.isDirectory()) {
        if (!opts.recursive) {
          throw codeError(
            Error,
            'ERR_FS_EISDIR',
            `Recursive option is required to copy a directory: ${s}`,
          );
        }
        fs.mkdirSync(d, { recursive: true });
        for (const name of fs.readdirSync(s) as string[])
          copy(path.join(s, name), path.join(d, name));
      } else if (st.isSymbolicLink()) {
        if (fs.existsSync(d) || fs.lstatSync(d, { throwIfNoEntry: false })) {
          if (!force) return;
          fs.unlinkSync(d);
        }
        fs.symlinkSync(fs.readlinkSync(s), d);
      } else {
        if (fs.existsSync(d)) {
          if (opts.errorOnExist && !force)
            throw codeError(
              Error,
              'ERR_FS_CP_EEXIST',
              `Target already exists: cp returned EEXIST (${d} already exists)`,
            );
          if (!force) return;
        }
        fs.copyFileSync(s, d);
        fs.chmodSync(d, st.mode & 0o7777);
      }
    };
    copy(path.resolve(src), path.resolve(dest));
  };

  class Dirent {
    readonly name: string;
    readonly parentPath: string;
    private readonly st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
    constructor(name: string, parentPath: string, st: Dirent['st']) {
      this.name = name;
      this.parentPath = parentPath;
      this.st = st;
    }
    get path(): string {
      return this.parentPath;
    }
    isFile() {
      return this.st.isFile();
    }
    isDirectory() {
      return this.st.isDirectory();
    }
    isSymbolicLink() {
      return this.st.isSymbolicLink();
    }
    isBlockDevice() {
      return false;
    }
    isCharacterDevice() {
      return false;
    }
    isFIFO() {
      return false;
    }
    isSocket() {
      return false;
    }
  }

  class Dir {
    readonly path: string;
    private entries:
      | { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[]
      | null;
    private closed = false;
    constructor(dirPath: string) {
      this.path = dirPath;
      this.entries = fs.readdirSync(dirPath, {
        withFileTypes: true,
      }) as unknown as typeof this.entries;
    }
    readSync() {
      if (this.closed) throw codeError(Error, 'ERR_DIR_CLOSED', 'Directory handle was closed');
      const e = this.entries!.shift();
      return e ? new Dirent(e.name, this.path, e) : null;
    }
    read(cb?: (err: Error | null, d: Dirent | null) => void) {
      if (cb) {
        defer(() => {
          try {
            cb(null, this.readSync());
          } catch (err) {
            cb(err as Error, null);
          }
        });
        return undefined;
      }
      return Promise.resolve().then(() => this.readSync());
    }
    closeSync() {
      if (this.closed) throw codeError(Error, 'ERR_DIR_CLOSED', 'Directory handle was closed');
      this.closed = true;
      this.entries = null;
    }
    close(cb?: (err: Error | null) => void) {
      if (cb) {
        defer(() => {
          try {
            this.closeSync();
            cb(null);
          } catch (err) {
            cb(err as Error);
          }
        });
        return undefined;
      }
      return Promise.resolve().then(() => this.closeSync());
    }
    async *[Symbol.asyncIterator]() {
      try {
        for (let d = this.readSync(); d; d = this.readSync()) yield d;
      } finally {
        if (!this.closed) this.closeSync();
      }
    }
    *entriesSync() {
      for (let d = this.readSync(); d; d = this.readSync()) yield d;
    }
  }

  const opendirSync = (p: string) => new Dir(path.resolve(String(p)));

  /** readdirSync with `recursive: true` (Node 20+). */
  const baseReaddir = fs.readdirSync;
  const readdirSync = (
    p: string,
    options?: { withFileTypes?: boolean; recursive?: boolean; encoding?: string } | string,
  ) => {
    if (typeof options !== 'object' || options === null || !options.recursive)
      return baseReaddir(p, options as never);
    const root = String(p);
    const result: unknown[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of baseReaddir(dir, { withFileTypes: true }) as unknown as {
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      }[]) {
        const relName = rel ? `${rel}/${e.name}` : e.name;
        result.push(options.withFileTypes ? new Dirent(e.name, dir, e) : relName);
        if (e.isDirectory()) walk(path.join(dir, e.name), relName);
      }
    };
    walk(root, '');
    return result;
  };

  const fdNoop = (fd: number) => {
    fs.fstatSync(fd); // Validates the descriptor (EBADF).
  };
  const readvSync = (fd: number, buffers: Uint8Array[], position?: number | null) => {
    let total = 0;
    for (const b of buffers) {
      const n = fs.readSync(
        fd,
        b,
        0,
        b.length,
        typeof position === 'number' ? position + total : null,
      );
      total += n;
      if (n < b.length) break;
    }
    return total;
  };
  const writevSync = (fd: number, buffers: Uint8Array[], position?: number | null) => {
    let total = 0;
    for (const b of buffers)
      total += fs.writeSync(
        fd,
        b,
        0,
        b.length,
        typeof position === 'number' ? position + total : null,
      );
    return total;
  };

  Object.assign(out, {
    readdirSync,
    mkdtempSync,
    cpSync,
    opendirSync,
    readvSync,
    writevSync,
    fsyncSync: fdNoop,
    fdatasyncSync: fdNoop,
    // Every process runs as root in its instance; ownership is not tracked.
    chownSync: (p: string) => void fs.statSync(p),
    lchownSync: (p: string) => void fs.lstatSync(p),
    fchownSync: fdNoop,
    fchmodSync: fdNoop,
    futimesSync: fdNoop,
    lutimesSync: (p: string, a: number | Date, m: number | Date) => fs.utimesSync(p, a, m),
    lchmodSync: undefined,
    statfsSync: () => ({
      type: 0x01021994,
      bsize: 4096,
      blocks: 1 << 20,
      bfree: 1 << 19,
      bavail: 1 << 19,
      files: 1 << 20,
      ffree: 1 << 19,
    }),
    Dir,
    Dirent,
    globSync: undefined,
  });

  // ------------------------------------------------------------ callback API

  const withCallback = (fn: Fn, asyncName: string) =>
    function (this: unknown, ...args: unknown[]) {
      const cb = args.pop();
      if (typeof cb !== 'function') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          `The "cb" argument must be of type function. Received ${cb === undefined ? 'undefined' : typeof cb}`,
        );
      }
      let result: unknown;
      let error: unknown = null;
      try {
        result = (fn as Fn).apply(out, args as never[]);
      } catch (err) {
        error = err;
      }
      defer(() =>
        error
          ? cb(error)
          : asyncName === 'read' || asyncName === 'write'
            ? cb(null, result, args[1])
            : cb(null, result),
      );
    };
  for (const [name, fn] of Object.entries(out)) {
    if (!name.endsWith('Sync') || SKIP_CALLBACKIFY.has(name) || typeof fn !== 'function') continue;
    out[name.slice(0, -4)] = withCallback(fn as Fn, name.slice(0, -4));
  }
  const realpathNative = (out['realpathSync'] as { native?: Fn } | undefined)?.native;
  if (realpathNative)
    (out['realpath'] as { native?: unknown }).native = withCallback(realpathNative, 'realpath');
  // fs.exists has a nonstandard callback (no error argument).
  out['exists'] = (p: string, cb: (exists: boolean) => void) => {
    const result = fs.existsSync(p);
    defer(() => cb(result));
  };
  // read(fd, cb) / read(fd, { buffer }, cb) forms default the buffer, as in Node.
  const readCb = out['read'] as Fn;
  out['read'] = (fd: number, ...rest: unknown[]) => {
    if (
      typeof rest[0] === 'function' ||
      (rest[0] !== null && typeof rest[0] === 'object' && !(rest[0] instanceof Uint8Array))
    ) {
      const cb = rest.pop() as (err: unknown, n?: number, buf?: Uint8Array) => void;
      const opts = (rest[0] ?? {}) as {
        buffer?: Uint8Array;
        offset?: number;
        length?: number;
        position?: number | null;
      };
      const buffer = opts.buffer ?? Buffer.alloc(16384);
      return (readCb as (...a: unknown[]) => void)(
        fd,
        buffer,
        opts.offset ?? 0,
        opts.length ?? buffer.length - (opts.offset ?? 0),
        opts.position ?? null,
        cb,
      );
    }
    return (readCb as (...a: unknown[]) => void)(fd, ...rest);
  };
  // write(fd, string, ...) calls back with the string, not a buffer.
  const writeCb = out['write'] as Fn;
  out['write'] = (fd: number, data: unknown, ...rest: unknown[]) => {
    const cb = rest.pop() as (err: unknown, n?: number, d?: unknown) => void;
    (writeCb as (...a: unknown[]) => void)(fd, data, ...rest, (err: unknown, n: number) =>
      cb(err, n, data),
    );
  };

  // ------------------------------------------------------------ promises

  class FileHandle {
    readonly fd: number;
    private closed = false;
    constructor(fd: number) {
      this.fd = fd;
    }
    private check(): number {
      if (this.closed)
        throw codeError(Error, 'EBADF', 'EBADF: bad file descriptor, file handle closed');
      return this.fd;
    }
    async read(
      buffer?:
        | Uint8Array
        | { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null },
      offset?: number,
      length?: number,
      position?: number | null,
    ) {
      const fd = this.check();
      let buf: Uint8Array;
      if (buffer === undefined || (!(buffer instanceof Uint8Array) && typeof buffer === 'object')) {
        const o = (buffer ?? {}) as {
          buffer?: Uint8Array;
          offset?: number;
          length?: number;
          position?: number | null;
        };
        buf = o.buffer ?? (Buffer.alloc(16384) as unknown as Uint8Array);
        offset = o.offset;
        length = o.length;
        position = o.position;
      } else {
        buf = buffer;
      }
      const off = offset ?? 0;
      const bytesRead = fs.readSync(fd, buf, off, length ?? buf.length - off, position ?? null);
      return { bytesRead, buffer: buf };
    }
    async write(data: Uint8Array | string, ...rest: unknown[]) {
      const fd = this.check();
      const bytesWritten = (fs.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
      return { bytesWritten, buffer: data };
    }
    async readFile(options?: unknown) {
      return (fs.readFileSync as (...a: unknown[]) => unknown)(this.check(), options);
    }
    async writeFile(data: unknown, options?: unknown) {
      fs.writeFileSync(this.check(), data, options as never);
    }
    async appendFile(data: unknown, options?: unknown) {
      fs.writeFileSync(this.check(), data, options as never);
    }
    async stat() {
      return fs.fstatSync(this.check());
    }
    async truncate(len = 0) {
      fs.ftruncateSync(this.check(), len);
    }
    async sync() {
      this.check();
    }
    async datasync() {
      this.check();
    }
    async chmod() {
      this.check();
    }
    async chown() {
      this.check();
    }
    async utimes() {
      this.check();
    }
    async readv(buffers: Uint8Array[], position?: number | null) {
      return { bytesRead: readvSync(this.check(), buffers, position), buffers };
    }
    async writev(buffers: Uint8Array[], position?: number | null) {
      return { bytesWritten: writevSync(this.check(), buffers, position), buffers };
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      fs.closeSync(this.fd);
    }
    async [Symbol.for('nodejs.asyncDispose')]() {
      await this.close();
    }
    readLines() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const handle = this;
      return (async function* () {
        const text = String(await handle.readFile('utf8'));
        const lines = text.split(/\r?\n/);
        if (lines[lines.length - 1] === '') lines.pop();
        yield* lines;
      })();
    }
    createReadStream(options?: object) {
      return createReadStream(null, { ...options, fd: this.check() });
    }
    createWriteStream(options?: object) {
      return createWriteStream(null, { ...options, fd: this.check() });
    }
  }

  const promises: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(out)) {
    if (!name.endsWith('Sync') || typeof fn !== 'function') continue;
    const base = name.slice(0, -4);
    if (
      [
        'exists',
        'read',
        'write',
        'close',
        'fstat',
        'ftruncate',
        'fsync',
        'fdatasync',
        'fchown',
        'fchmod',
        'futimes',
        'readv',
        'writev',
        'opendir',
      ].includes(base)
    ) {
      continue;
    }
    promises[base] = async (...args: unknown[]) => (fn as Fn).apply(out, args as never[]);
  }
  Object.assign(promises, {
    async open(p: string, flags?: string | number, mode?: number) {
      return new FileHandle(fs.openSync(p, flags, mode));
    },
    async opendir(p: string) {
      return opendirSync(p);
    },
    async readFile(p: string | FileHandle, options?: unknown) {
      if (p instanceof FileHandle) return p.readFile(options);
      return (fs.readFileSync as (...a: unknown[]) => unknown)(p, options);
    },
    async writeFile(p: string | FileHandle, data: unknown, options?: unknown) {
      if (p instanceof FileHandle) return p.writeFile(data, options);
      if (
        data &&
        typeof data === 'object' &&
        (Symbol.asyncIterator in (data as object) || Symbol.iterator in (data as object)) &&
        !(data instanceof Uint8Array) &&
        typeof data !== 'string'
      ) {
        const chunks: Uint8Array[] = [];
        for await (const c of data as AsyncIterable<unknown>)
          chunks.push(
            typeof c === 'string' ? (Buffer.from(c) as unknown as Uint8Array) : (c as Uint8Array),
          );
        data = Buffer.concat(chunks);
      }
      fs.writeFileSync(p, data, options as never);
    },
    constants: fs.constants,
    FileHandle,
  });
  out['promises'] = promises;

  // ------------------------------------------------------------ streams

  function createReadStream(
    file: string | null,
    options:
      | string
      | {
          fd?: number;
          flags?: string;
          encoding?: string;
          start?: number;
          end?: number;
          highWaterMark?: number;
          autoClose?: boolean;
          emitClose?: boolean;
          signal?: AbortSignal;
        } = {},
  ) {
    const opts = typeof options === 'string' ? { encoding: options } : options;
    const { Readable } = deps.stream();
    let fd = opts.fd ?? null;
    let pos = opts.start ?? null;
    const end = opts.end ?? Infinity;
    const hwm = opts.highWaterMark ?? 64 * 1024;
    const stream = new Readable({
      highWaterMark: hwm,
      ...(opts.encoding ? { encoding: opts.encoding } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      emitClose: opts.emitClose ?? true,
      autoDestroy: opts.autoClose ?? true,
      construct(cb: (err?: Error | null) => void) {
        if (fd !== null) {
          cb();
          return;
        }
        try {
          fd = fs.openSync(file!, opts.flags ?? 'r');
          stream['fd'] = fd;
          stream['pending'] = false;
          stream.emit('open', fd);
          stream.emit('ready');
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      read(n: number) {
        // Node 24 always asks for highWaterMark-sized reads; the vendored (Node 18)
        // stream core can pass larger sizes, so clamp to keep chunking identical.
        void n;
        const remaining = pos === null ? Infinity : Math.max(0, end - pos + 1);
        const toRead = Math.min(hwm, remaining);
        if (toRead <= 0) {
          stream.push(null);
          return;
        }
        let chunk: Uint8Array | null;
        try {
          const buf = Buffer.allocUnsafe(toRead);
          const bytes = fs.readSync(fd!, buf as unknown as Uint8Array, 0, toRead, pos);
          if (pos !== null) pos += bytes;
          stream['bytesRead'] = (stream['bytesRead'] as number) + bytes;
          chunk = bytes > 0 ? (buf.subarray(0, bytes) as unknown as Uint8Array) : null;
        } catch (err) {
          stream.destroy(err as Error);
          return;
        }
        // Node's fs reads complete on a later tick; pushing synchronously would let
        // the stream read ahead and coalesce chunks differently.
        defer(() => stream.push(chunk));
      },
      destroy(err: Error | null, cb: (err: Error | null) => void) {
        if (fd !== null && (opts.autoClose ?? true)) {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
          fd = null;
        }
        cb(err);
      },
    } as object);
    Object.assign(stream, {
      path: file,
      fd,
      bytesRead: 0,
      pending: fd === null,
      flags: opts.flags ?? 'r',
      mode: 0o666,
      start: opts.start,
      end: opts.end,
    });
    stream['close'] = (cb?: (err?: Error | null) => void) => {
      if (cb)
        (stream as unknown as { once(e: string, f: () => void): void }).once('close', () => cb());
      stream.destroy();
    };
    return stream;
  }

  function createWriteStream(
    file: string | null,
    options:
      | string
      | {
          fd?: number;
          flags?: string;
          encoding?: string;
          start?: number;
          mode?: number;
          autoClose?: boolean;
          emitClose?: boolean;
          flush?: boolean;
        } = {},
  ) {
    const opts = typeof options === 'string' ? { encoding: options } : options;
    const { Writable } = deps.stream();
    let fd = opts.fd ?? null;
    let pos = opts.start ?? null;
    const stream = new Writable({
      decodeStrings: true,
      ...(opts.encoding ? { defaultEncoding: opts.encoding } : {}),
      emitClose: opts.emitClose ?? true,
      autoDestroy: opts.autoClose ?? true,
      construct(cb: (err?: Error | null) => void) {
        if (fd !== null) {
          cb();
          return;
        }
        try {
          fd = fs.openSync(file!, opts.flags ?? 'w', opts.mode ?? 0o666);
          stream['fd'] = fd;
          stream['pending'] = false;
          stream.emit('open', fd);
          stream.emit('ready');
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      write(chunk: BufferT, _enc: string, cb: (err?: Error | null) => void) {
        try {
          const n = fs.writeSync(fd!, chunk as unknown as Uint8Array, 0, chunk.length, pos);
          if (pos !== null) pos += n;
          stream['bytesWritten'] = (stream['bytesWritten'] as number) + n;
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      destroy(err: Error | null, cb: (err: Error | null) => void) {
        if (fd !== null && (opts.autoClose ?? true)) {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
          fd = null;
        }
        cb(err);
      },
    } as object);
    Object.assign(stream, {
      path: file,
      fd,
      bytesWritten: 0,
      pending: fd === null,
      flags: opts.flags ?? 'w',
      mode: opts.mode ?? 0o666,
      start: opts.start,
    });
    stream['close'] = (cb?: (err?: Error | null) => void) => {
      if (cb)
        (stream as unknown as { once(e: string, f: () => void): void }).once('close', () => cb());
      (stream as unknown as { end(): void }).end();
    };
    return stream;
  }

  out['createReadStream'] = (p: string, o?: object) => createReadStream(String(p), o);
  out['createWriteStream'] = (p: string, o?: object) => createWriteStream(String(p), o);
  // Accessors like Node's: graceful-fs redefines them on its clone of fs.
  for (const [name, base] of [
    ['ReadStream', 'Readable'],
    ['WriteStream', 'Writable'],
    ['FileReadStream', 'Readable'],
    ['FileWriteStream', 'Writable'],
  ] as const) {
    let override: unknown;
    Object.defineProperty(out, name, {
      get: () => override ?? deps.stream()[base],
      set: (v: unknown) => (override = v),
      enumerable: true,
      configurable: true,
    });
  }

  return out;
}
