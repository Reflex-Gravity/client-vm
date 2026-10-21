// SPDX-License-Identifier: Apache-2.0
// `zlib` on pako (ADR 0007): sync, callback and stream APIs for deflate,
// inflate, gzip, gunzip, raw and unzip. Streams also expose the
// `_processChunk` / `_handle` internals that minizlib (npm, tar) drives
// synchronously. Brotli is not provided, so feature checks fall back.

import { Deflate, Inflate } from 'pako';
import { Buffer } from './buffer.ts';

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4865,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
} as const;

const CODES: Record<number, string> = {
  1: 'Z_STREAM_END',
  2: 'Z_NEED_DICT',
  [-1]: 'Z_ERRNO',
  [-2]: 'Z_STREAM_ERROR',
  [-3]: 'Z_DATA_ERROR',
  [-4]: 'Z_MEM_ERROR',
  [-5]: 'Z_BUF_ERROR',
  [-6]: 'Z_VERSION_ERROR',
};

type Mode = 'deflate' | 'inflate' | 'gzip' | 'gunzip' | 'deflateRaw' | 'inflateRaw' | 'unzip';

interface ZlibOptions {
  level?: number;
  windowBits?: number;
  memLevel?: number;
  strategy?: number;
  chunkSize?: number;
  dictionary?: Uint8Array;
  flush?: number;
  finishFlush?: number;
  info?: boolean;
  maxOutputLength?: number;
}

function zlibError(code: number, message: string): Error {
  const err = new Error(message) as Error & { errno: number; code: string };
  err.errno = code;
  err.code = CODES[code] ?? 'Z_ERRNO';
  return err;
}

const isDeflate = (m: Mode) => m === 'deflate' || m === 'gzip' || m === 'deflateRaw';

function engineFor(mode: Mode, o: ZlibOptions): Deflate | Inflate {
  const windowBits = o.windowBits ?? 15;
  const chunkSize = Math.max(o.chunkSize ?? 16384, 64);
  if (isDeflate(mode)) {
    return new Deflate({
      level: o.level ?? -1,
      windowBits,
      memLevel: o.memLevel ?? 8,
      strategy: o.strategy ?? 0,
      chunkSize,
      ...(mode === 'gzip' ? { gzip: true } : {}),
      ...(mode === 'deflateRaw' ? { raw: true } : {}),
      ...(o.dictionary ? { dictionary: o.dictionary } : {}),
    });
  }
  return new Inflate({
    // unzip: +32 auto-detects a gzip or zlib header; gunzip: +16 requires gzip.
    windowBits:
      mode === 'unzip' ? windowBits + 32 : mode === 'gunzip' ? windowBits + 16 : windowBits,
    chunkSize,
    ...(mode === 'inflateRaw' ? { raw: true } : {}),
    ...(o.dictionary ? { dictionary: o.dictionary } : {}),
  });
}

/** Incremental (de)compressor: feeds input, returns the output produced. */
class Codec {
  private engine: Deflate | Inflate;
  private out: Uint8Array[] = [];
  readonly mode: Mode;
  ended = false;
  bytesWritten = 0;

  constructor(mode: Mode, options: ZlibOptions) {
    this.mode = mode;
    this.engine = engineFor(mode, options);
    this.engine.onData = (chunk) => this.out.push(chunk);
  }

  run(input: Uint8Array, flush: number): Uint8Array[] {
    this.bytesWritten += input.length;
    if (this.ended) {
      // Node ignores trailing data after the end of a deflate stream.
      return [];
    }
    if (input.length > 0 || flush !== constants.Z_NO_FLUSH) {
      this.engine.push(input, flush);
    }
    const err = this.engine.err;
    if (
      err &&
      err !== constants.Z_STREAM_END &&
      !(err === constants.Z_BUF_ERROR && flush !== constants.Z_FINISH)
    ) {
      throw zlibError(err, this.engine.msg || 'zlib error');
    }
    if (this.engine.ended) this.ended = true;
    if (flush === constants.Z_FINISH && !isDeflate(this.mode) && !this.ended) {
      throw zlibError(constants.Z_BUF_ERROR, 'unexpected end of file');
    }
    const chunks = this.out;
    this.out = [];
    return chunks;
  }
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data) as unknown as Uint8Array;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const err = new TypeError(
    'The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.',
  );
  (err as TypeError & { code: string }).code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function concat(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks);
}

function syncFn(mode: Mode) {
  return (data: unknown, options: ZlibOptions = {}): Buffer => {
    const codec = new Codec(mode, options);
    const out = codec.run(toBytes(data), options.finishFlush ?? constants.Z_FINISH);
    const result = concat(out);
    if (options.maxOutputLength !== undefined && result.length > options.maxOutputLength) {
      const err = new RangeError(
        `Cannot create a Buffer larger than ${options.maxOutputLength} bytes`,
      );
      (err as RangeError & { code: string }).code = 'ERR_BUFFER_TOO_LARGE';
      throw err;
    }
    return result;
  };
}

function asyncFn(mode: Mode) {
  const sync = syncFn(mode);
  return (
    data: unknown,
    options?: ZlibOptions | ((e: Error | null, r?: Buffer) => void),
    cb?: (e: Error | null, r?: Buffer) => void,
  ) => {
    const callback = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'object' && options !== null ? options : {};
    if (typeof callback !== 'function') {
      const err = new TypeError('The "callback" argument must be of type function');
      (err as TypeError & { code: string }).code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    let result: Buffer;
    try {
      result = sync(data, opts);
    } catch (err) {
      setTimeout(() => callback(err as Error), 0);
      return;
    }
    setTimeout(() => callback(null, result), 0);
  };
}

type TransformCtor = new (opts?: object) => Record<string, unknown> & {
  push(chunk: unknown): boolean;
  emit(event: string, ...args: unknown[]): boolean;
  destroy(err?: Error): unknown;
};

/** Builds the zlib module; stream classes need the (lazily loaded) stream module. */
export function createZlib(
  loadStream: () => { Transform: TransformCtor },
): Record<string, unknown> {
  let classes: Record<string, unknown> | undefined;
  const makeClasses = () => {
    if (classes) return classes;
    const Transform = loadStream().Transform;

    class ZlibBase extends Transform {
      _codec: Codec;
      _defaultFlush: number;
      _finishFlush: number;
      _closed = false;
      /** minizlib replaces `_handle.close` around `_processChunk`. */
      _handle: { close(): void } | null;
      constructor(mode: Mode, options: ZlibOptions = {}) {
        super({ ...options, readableHighWaterMark: options.chunkSize ?? 16384 } as object);
        this._codec = new Codec(mode, options);
        this._defaultFlush = options.flush ?? constants.Z_NO_FLUSH;
        this._finishFlush = options.finishFlush ?? constants.Z_FINISH;
        this._handle = { close: () => {} };
      }
      get bytesWritten(): number {
        return this._codec.bytesWritten;
      }
      get _level(): number {
        return -1;
      }
      /** Synchronous processing, as Node's zlib exposes it (used by minizlib). */
      _processChunk(
        chunk: Uint8Array,
        flushFlag: number,
        cb?: (e: Error | null, r?: Buffer) => void,
      ): Buffer | undefined {
        const out = this._codec.run(toBytes(chunk), flushFlag);
        if (typeof cb === 'function') {
          for (const o of out) this.push(Buffer.from(o.buffer, o.byteOffset, o.byteLength));
          cb(null);
          return undefined;
        }
        // Looked up at call time: minizlib swaps Buffer.concat to receive the chunk list.
        return Buffer.concat(out);
      }
      _transform(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void): void {
        try {
          for (const o of this._codec.run(toBytes(chunk), this._defaultFlush)) {
            this.push(Buffer.from(o.buffer, o.byteOffset, o.byteLength));
          }
          cb();
        } catch (err) {
          cb(err as Error);
        }
      }
      _flush(cb: (e?: Error | null) => void): void {
        try {
          for (const o of this._codec.run(new Uint8Array(0), this._finishFlush)) {
            this.push(Buffer.from(o.buffer, o.byteOffset, o.byteLength));
          }
          cb();
        } catch (err) {
          cb(err as Error);
        }
      }
      flush(kind?: number | (() => void), cb?: () => void): void {
        const callback = typeof kind === 'function' ? kind : cb;
        const flag = typeof kind === 'number' ? kind : constants.Z_FULL_FLUSH;
        try {
          for (const o of this._codec.run(new Uint8Array(0), flag)) {
            this.push(Buffer.from(o.buffer, o.byteOffset, o.byteLength));
          }
        } catch (err) {
          this.destroy(err as Error);
        }
        if (callback) queueMicrotask(callback);
      }
      params(_level: number, _strategy: number, cb?: () => void): void {
        // pako cannot change level mid-stream; flush so callers still see their data.
        this.flush(constants.Z_SYNC_FLUSH, cb);
      }
      close(cb?: () => void): void {
        this._closed = true;
        this._handle = null;
        if (cb) queueMicrotask(cb);
        this.destroy();
      }
      reset(): void {}
    }
    const make = (mode: Mode) =>
      class extends ZlibBase {
        constructor(options?: ZlibOptions) {
          super(mode, options);
        }
      };
    const Deflate = make('deflate');
    const Inflate = make('inflate');
    const Gzip = make('gzip');
    const Gunzip = make('gunzip');
    const DeflateRaw = make('deflateRaw');
    const InflateRaw = make('inflateRaw');
    const Unzip = make('unzip');
    for (const [name, C] of Object.entries({
      Deflate,
      Inflate,
      Gzip,
      Gunzip,
      DeflateRaw,
      InflateRaw,
      Unzip,
    })) {
      Object.defineProperty(C, 'name', { value: name });
    }
    classes = { Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip, Zlib: ZlibBase };
    return classes;
  };

  const zlib: Record<string, unknown> = {
    constants,
    ...constants,
    codes: Object.fromEntries(
      Object.entries(CODES).flatMap(([k, v]) => [
        [v, Number(k)],
        [k, v],
      ]),
    ),
    deflateSync: syncFn('deflate'),
    inflateSync: syncFn('inflate'),
    gzipSync: syncFn('gzip'),
    gunzipSync: syncFn('gunzip'),
    deflateRawSync: syncFn('deflateRaw'),
    inflateRawSync: syncFn('inflateRaw'),
    unzipSync: syncFn('unzip'),
    deflate: asyncFn('deflate'),
    inflate: asyncFn('inflate'),
    gzip: asyncFn('gzip'),
    gunzip: asyncFn('gunzip'),
    deflateRaw: asyncFn('deflateRaw'),
    inflateRaw: asyncFn('inflateRaw'),
    unzip: asyncFn('unzip'),
    crc32: (data: unknown, value = 0) => crc32(toBytes(data), value),
  };
  const ctor = (name: string) => (options?: ZlibOptions) =>
    new (makeClasses()[name] as new (o?: ZlibOptions) => unknown)(options);
  for (const name of [
    'Deflate',
    'Inflate',
    'Gzip',
    'Gunzip',
    'DeflateRaw',
    'InflateRaw',
    'Unzip',
  ]) {
    zlib[`create${name}`] = ctor(name);
    Object.defineProperty(zlib, name, { get: () => makeClasses()[name], enumerable: true });
  }
  return zlib;
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array, value: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
