// SPDX-License-Identifier: Apache-2.0
import { codeError } from './internal/errors.ts';

/**
 * Node's `Buffer`, implemented over Uint8Array the way Node does it: an
 * internal `FastBuffer` subclass carries the prototype, and `Buffer` is a
 * legacy-callable function sharing that prototype. Checked against real Node
 * by test/conformance/buffer-differential.test.ts.
 */

export type BufferEncoding =
  | 'utf8'
  | 'utf-8'
  | 'hex'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'binary'
  | 'ascii'
  | 'utf16le'
  | 'utf-16le'
  | 'ucs2'
  | 'ucs-2';

type Canonical = 'utf8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'ascii' | 'utf16le';

export const kMaxLength = 2 ** 32;
export const kStringMaxLength = 2 ** 29 - 24;
export const INSPECT_MAX_BYTES = 50;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function normalizeEncoding(enc: unknown): Canonical | undefined {
  if (enc === undefined || enc === null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  if (typeof enc !== 'string') return undefined;
  switch (enc.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'hex':
      return 'hex';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return 'utf16le';
    default:
      return undefined;
  }
}

function unknownEncoding(enc: unknown): TypeError {
  return codeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${String(enc)}`);
}

export { codeError };

function outOfRange(name: string, range: string, value: unknown): RangeError {
  return codeError(
    RangeError,
    'ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  );
}

function invalidArgType(name: string, expected: string, value: unknown): TypeError {
  let received: string;
  if (value === null) received = 'null';
  else if (value === undefined) received = 'undefined';
  else if (typeof value === 'function')
    received = `function ${(value as { name?: string }).name ?? ''}`;
  else if (typeof value === 'object') {
    const ctor = (value as object).constructor?.name;
    received = ctor ? `an instance of ${ctor}` : 'an object';
  } else {
    let shown = String(value);
    if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
    if (typeof value === 'string') shown = `'${shown}'`;
    received = `type ${typeof value} (${shown})`;
  }
  return codeError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    `The "${name}" argument must be ${expected}. Received ${received}`,
  );
}

// ---------------------------------------------------------------- encoders

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP[B64.charCodeAt(i)] = i;
  B64_LOOKUP[B64URL.charCodeAt(i)] = i;
}

function base64Encode(bytes: Bytes, url: boolean): string {
  const alphabet = url ? B64URL : B64;
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]!;
    if (!url) out += '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]!;
    if (!url) out += '=';
  }
  return out;
}

/** Lenient like Node: accepts both alphabets, skips invalid characters, stops at '='. */
function base64Decode(str: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((str.length * 3) / 4));
  let len = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 61 /* = */) break;
    const v = c < 256 ? B64_LOOKUP[c]! : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, len);
}

/** Size Node reports for a base64 string (before decoding, ignoring invalid characters). */
function base64ByteLength(str: string): number {
  let n = str.length;
  if (n > 0 && str.charCodeAt(n - 1) === 61) n--;
  if (n > 1 && str.charCodeAt(n - 1) === 61) n--;
  return (n * 3) >>> 2;
}

function hexDecode(str: string): Uint8Array {
  const out = new Uint8Array(str.length >>> 1);
  let i = 0;
  for (; i < out.length; i++) {
    const hi = parseHexDigit(str.charCodeAt(i * 2));
    const lo = parseHexDigit(str.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) break;
    out[i] = (hi << 4) | lo;
  }
  return out.subarray(0, i);
}

function parseHexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function encodeString(str: string, enc: Canonical): Uint8Array {
  switch (enc) {
    case 'utf8':
      return utf8Encoder.encode(str);
    case 'hex':
      return hexDecode(str);
    case 'base64':
    case 'base64url':
      return base64Decode(str);
    case 'latin1':
    case 'ascii': {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case 'utf16le': {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = c >>> 8;
      }
      return out;
    }
  }
}

function decodeBytes(bytes: Bytes, enc: Canonical): string {
  switch (enc) {
    case 'utf8':
      // Copy shared memory with Uint8Array's slice (Buffer's slice shares); TextDecoder rejects SAB views.
      return utf8Decoder.decode(
        (bytes.buffer instanceof ArrayBuffer
          ? bytes
          : Uint8Array.prototype.slice.call(bytes)) as Uint8Array<ArrayBuffer>,
      );
    case 'hex': {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
      return out;
    }
    case 'base64':
      return base64Encode(bytes, false);
    case 'base64url':
      return base64Encode(bytes, true);
    case 'latin1':
      return chunkedFromCharCode(bytes, 0xff);
    case 'ascii':
      return chunkedFromCharCode(bytes, 0x7f);
    case 'utf16le': {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2)
        out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      return out;
    }
  }
}

function chunkedFromCharCode(bytes: Bytes, mask: number): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, i + CHUNK);
    const codes = new Uint16Array(part.length);
    for (let j = 0; j < part.length; j++) codes[j] = part[j]! & mask;
    out += String.fromCharCode(...codes);
  }
  return out;
}

function byteLengthOf(str: string, enc: Canonical): number {
  switch (enc) {
    case 'utf8':
      return utf8ByteLength(str);
    case 'hex':
      return str.length >>> 1;
    case 'base64':
    case 'base64url':
      return base64ByteLength(str);
    case 'latin1':
    case 'ascii':
      return str.length;
    case 'utf16le':
      return str.length * 2;
  }
}

function utf8ByteLength(str: string): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------- Buffer

/** Anything with bytes: a Buffer or a plain Uint8Array. */
type Bytes = Uint8Array | Buffer;

/** The real class behind every Buffer (as in Node). */
class FastBuffer extends Uint8Array {}

export interface Buffer extends Omit<
  Uint8Array<ArrayBufferLike>,
  | 'slice'
  | 'subarray'
  | 'toString'
  | 'indexOf'
  | 'lastIndexOf'
  | 'includes'
  | 'fill'
  | 'toLocaleString'
> {
  [index: number]: number;
  toLocaleString(encoding?: BufferEncoding, start?: number, end?: number): string;
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  write(
    string: string,
    offset?: number | BufferEncoding,
    length?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
  equals(other: Uint8Array): boolean;
  compare(
    target: Uint8Array,
    targetStart?: number,
    targetEnd?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  toJSON(): { type: 'Buffer'; data: number[] };
  indexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
  lastIndexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number;
  includes(
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): boolean;
  fill(
    value: string | number | Uint8Array,
    offset?: number | BufferEncoding,
    end?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): this;
  [key: string]: unknown;
}

interface BufferConstructorLike {
  (arg: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  new (arg: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  from(value: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer;
  allocUnsafe(size: number): Buffer;
  allocUnsafeSlow(size: number): Buffer;
  isBuffer(value: unknown): value is Buffer;
  isEncoding(encoding: unknown): boolean;
  byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: BufferEncoding): number;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  compare(a: Uint8Array, b: Uint8Array): number;
  copyBytesFrom(view: ArrayBufferView, offset?: number, length?: number): Buffer;
  poolSize: number;
  readonly prototype: Buffer;
  [key: string]: unknown;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return new FastBuffer(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.length,
  ) as unknown as Buffer;
}

function validateSize(size: unknown): asserts size is number {
  if (typeof size !== 'number') throw invalidArgType('size', 'of type number', size);
  if (!(size >= 0 && size <= kMaxLength))
    throw outOfRange('size', `>= 0 && <= ${kMaxLength}`, size);
}

function from(value: unknown, encodingOrOffset?: unknown, length?: number): Buffer {
  if (typeof value === 'string') {
    const enc = normalizeEncoding(encodingOrOffset);
    if (!enc) throw unknownEncoding(encodingOrOffset);
    return asBuffer(encodeString(value, enc));
  }
  if (typeof value === 'object' && value !== null) {
    if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
    ) {
      const byteOffset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset) >>> 0;
      const maxLength = value.byteLength - byteOffset;
      if (maxLength < 0)
        throw codeError(
          RangeError,
          'ERR_BUFFER_OUT_OF_BOUNDS',
          '"offset" is outside of buffer bounds',
        );
      const len = length === undefined ? maxLength : Math.floor(Number(length)) || 0;
      if (len > maxLength)
        throw codeError(
          RangeError,
          'ERR_BUFFER_OUT_OF_BOUNDS',
          '"length" is outside of buffer bounds',
        );
      return new FastBuffer(value as ArrayBuffer, byteOffset, len) as unknown as Buffer;
    }
    if (ArrayBuffer.isView(value)) {
      // Copies (for any typed array, element values are truncated to bytes as in Node).
      // Uint8Array's slice copies; Buffer's own slice() would share memory.
      if (value instanceof Uint8Array) return asBuffer(Uint8Array.prototype.slice.call(value));
      const src = value as unknown as ArrayLike<number>;
      const out = new FastBuffer(src.length);
      for (let i = 0; i < src.length; i++) out[i] = Number(src[i]) & 0xff;
      return out as unknown as Buffer;
    }
    const primitive = (value as { valueOf?: () => unknown }).valueOf?.();
    if (primitive !== undefined && primitive !== null && primitive !== value) {
      return from(primitive, encodingOrOffset, length);
    }
    const toPrimitive = (value as { [Symbol.toPrimitive]?: (hint: string) => unknown })[
      Symbol.toPrimitive
    ];
    if (typeof toPrimitive === 'function')
      return from(toPrimitive.call(value, 'string'), encodingOrOffset, length);
    const obj = value as { type?: unknown; data?: unknown; length?: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) return fromArrayLike(obj.data);
    if (typeof obj.length === 'number' || Array.isArray(value))
      return fromArrayLike(value as ArrayLike<unknown>);
  }
  throw invalidArgType(
    'first argument',
    'of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object',
    value,
  );
}

function fromArrayLike(arr: ArrayLike<unknown>): Buffer {
  const len = arr.length < 0 ? 0 : Math.floor(arr.length) >>> 0;
  const out = new FastBuffer(len);
  for (let i = 0; i < len; i++) out[i] = Number(arr[i]) & 0xff;
  return out as unknown as Buffer;
}

function alloc(
  size: number,
  fill?: string | number | Uint8Array,
  encoding?: BufferEncoding,
): Buffer {
  validateSize(size);
  const buf = new FastBuffer(size) as unknown as Buffer;
  if (fill !== undefined && fill !== 0 && size > 0) buf.fill(fill, 0, size, encoding);
  return buf;
}

function byteLength(
  value: string | ArrayBufferView | ArrayBuffer,
  encoding?: BufferEncoding,
): number {
  if (typeof value !== 'string') {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
    if (
      typeof SharedArrayBuffer !== 'undefined' &&
      (value as unknown) instanceof SharedArrayBuffer
    ) {
      return (value as SharedArrayBuffer).byteLength;
    }
    throw invalidArgType('string', 'of type string or an instance of Buffer or ArrayBuffer', value);
  }
  return byteLengthOf(value, normalizeEncoding(encoding) ?? 'utf8');
}

function concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
  if (!Array.isArray(list)) throw invalidArgType('list', 'an instance of Array', list);
  if (list.length === 0) return new FastBuffer(0) as unknown as Buffer;
  let length = totalLength;
  if (length === undefined) {
    length = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!(item instanceof Uint8Array)) {
        throw invalidArgType(`list[${i}]`, 'an instance of Buffer or Uint8Array', item);
      }
      length += item.length;
    }
  } else {
    length = Math.floor(length) >>> 0;
  }
  const out = new FastBuffer(length);
  let pos = 0;
  for (let i = 0; i < list.length && pos < length; i++) {
    const item = list[i]!;
    if (!(item instanceof Uint8Array))
      throw invalidArgType(`list[${i}]`, 'an instance of Buffer or Uint8Array', item);
    const n = Math.min(item.length, length - pos);
    out.set(item.subarray(0, n), pos);
    pos += n;
  }
  return out as unknown as Buffer;
}

function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Legacy `Buffer(arg)` / `new Buffer(arg)` (deprecated in Node, still used by old packages). */
const BufferFn = function Buffer(
  arg: unknown,
  encodingOrOffset?: unknown,
  length?: number,
): Buffer {
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw invalidArgType('string', 'of type string', arg);
    }
    return alloc(arg);
  }
  return from(arg, encodingOrOffset, length);
} as unknown as BufferConstructorLike;

export const Buffer = BufferFn;

Object.defineProperty(Buffer, 'prototype', { value: FastBuffer.prototype, writable: false });
Object.defineProperty(FastBuffer.prototype, 'constructor', {
  value: Buffer,
  writable: true,
  configurable: true,
});
Object.setPrototypeOf(Buffer, Uint8Array);
// subarray()/map()/filter() construct through the species, like Node.
Object.defineProperty(Buffer, Symbol.species, { get: () => FastBuffer, configurable: true });

Object.assign(Buffer, {
  poolSize: 8 * 1024,
  from,
  alloc,
  allocUnsafe(size: number) {
    validateSize(size);
    return new FastBuffer(size) as unknown as Buffer;
  },
  allocUnsafeSlow(size: number) {
    validateSize(size);
    return new FastBuffer(size) as unknown as Buffer;
  },
  isBuffer: (value: unknown): value is Buffer => value instanceof FastBuffer,
  isEncoding: (encoding: unknown) =>
    typeof encoding === 'string' && encoding !== '' && normalizeEncoding(encoding) !== undefined,
  byteLength,
  concat,
  compare(a: Uint8Array, b: Uint8Array) {
    if (!(a instanceof Uint8Array))
      throw invalidArgType('buf1', 'an instance of Buffer or Uint8Array', a);
    if (!(b instanceof Uint8Array))
      throw invalidArgType('buf2', 'an instance of Buffer or Uint8Array', b);
    return compareBytes(a, b);
  },
  copyBytesFrom(view: ArrayBufferView, offset = 0, length?: number) {
    const bytesPerElement =
      (view as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const elements = view.byteLength / bytesPerElement;
    const end = length === undefined ? elements : Math.min(elements, offset + length);
    const start = Math.min(offset, end);
    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset + start * bytesPerElement,
      (end - start) * bytesPerElement,
    );
    return asBuffer(bytes.slice());
  },
});

// ---------------------------------------------------------------- prototype methods

type Proto = Buffer & Record<string, unknown>;
const proto = FastBuffer.prototype as unknown as Proto;

function adjustOffset(offset: number, length: number): number {
  offset = Math.trunc(offset);
  if (offset === 0 || Number.isNaN(offset)) return 0;
  if (offset < 0) {
    offset += length;
    return offset > 0 ? offset : 0;
  }
  return offset < length ? offset : length;
}

const methods = {
  toString(this: Buffer, encoding?: BufferEncoding, start?: number, end?: number): string {
    if (arguments.length === 0) return decodeBytes(this, 'utf8');
    // Node checks the range before the encoding: an empty range never throws.
    const s =
      start === undefined || start <= 0
        ? 0
        : start >= this.length
          ? this.length
          : Math.trunc(start) || 0;
    const e =
      end === undefined || end > this.length ? this.length : end <= s ? s : Math.trunc(end) || 0;
    if (e <= s) return '';
    const enc = normalizeEncoding(encoding);
    if (!enc) throw unknownEncoding(encoding);
    return decodeBytes(this.subarray(s, e), enc);
  },

  toLocaleString(this: Buffer, encoding?: BufferEncoding, start?: number, end?: number): string {
    return (methods.toString as (...a: unknown[]) => string).apply(
      this,
      [encoding, start, end].slice(0, arguments.length),
    );
  },

  equals(this: Buffer, other: Uint8Array): boolean {
    if (!(other instanceof Uint8Array))
      throw invalidArgType('otherBuffer', 'an instance of Buffer or Uint8Array', other);
    return this === other || compareBytes(this, other) === 0;
  },

  compare(
    this: Buffer,
    target: Uint8Array,
    targetStart = 0,
    targetEnd = target.length,
    sourceStart = 0,
    sourceEnd = this.length,
  ): number {
    if (!(target instanceof Uint8Array))
      throw invalidArgType('target', 'an instance of Buffer or Uint8Array', target);
    const check = (name: string, v: number, max: number) => {
      if (v < 0 || v > max) throw outOfRange(name, `>= 0 && <= ${max}`, v);
    };
    check('targetStart', targetStart, target.length);
    check('targetEnd', targetEnd, target.length);
    check('sourceStart', sourceStart, this.length);
    check('sourceEnd', sourceEnd, this.length);
    if (sourceStart >= sourceEnd) return targetStart >= targetEnd ? 0 : -1;
    if (targetStart >= targetEnd) return 1;
    return compareBytes(
      this.subarray(sourceStart, sourceEnd),
      target.subarray(targetStart, targetEnd),
    );
  },

  copy(
    this: Buffer,
    target: Uint8Array,
    targetStart = 0,
    sourceStart = 0,
    sourceEnd = this.length,
  ): number {
    if (!(target instanceof Uint8Array))
      throw invalidArgType('target', 'an instance of Buffer or Uint8Array', target);
    targetStart = Math.trunc(targetStart) || 0;
    sourceStart = Math.trunc(sourceStart) || 0;
    sourceEnd = Math.trunc(sourceEnd) || 0;
    if (targetStart < 0) throw outOfRange('targetStart', '>= 0', targetStart);
    if (sourceStart < 0 || sourceStart > this.length)
      throw outOfRange('sourceStart', `>= 0 && <= ${this.length}`, sourceStart);
    if (sourceEnd < 0) throw outOfRange('sourceEnd', '>= 0', sourceEnd);
    if (sourceEnd > this.length) sourceEnd = this.length;
    if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;
    const n = Math.min(sourceEnd - sourceStart, target.length - targetStart);
    target.set(this.subarray(sourceStart, sourceStart + n), targetStart);
    return n;
  },

  /** In Node, slice() is subarray(): it shares memory. */
  slice(this: Buffer, start?: number, end?: number): Buffer {
    const len = this.length;
    const s = start === undefined ? 0 : adjustOffset(Number(start), len);
    const e = end === undefined ? len : adjustOffset(Number(end), len);
    return new FastBuffer(
      this.buffer as ArrayBuffer,
      this.byteOffset + s,
      Math.max(0, e - s),
    ) as unknown as Buffer;
  },

  toJSON(this: Buffer): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  },

  write(
    this: Buffer,
    string: string,
    offset?: number | BufferEncoding,
    length?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number {
    if (typeof string !== 'string') throw invalidArgType('argument', 'of type string', string);
    let off = 0;
    let len = this.length;
    let enc: unknown = 'utf8';
    if (typeof offset === 'string') {
      enc = offset;
    } else if (offset !== undefined) {
      off = offset >>> 0;
      if (off > this.length) throw outOfRange('offset', `>= 0 && <= ${this.length}`, offset);
      len = this.length - off;
      if (typeof length === 'string') enc = length;
      else if (length !== undefined) {
        len = Math.min(len, length >>> 0);
        if (encoding !== undefined) enc = encoding;
      }
    }
    const canonical = normalizeEncoding(enc);
    if (!canonical) throw unknownEncoding(enc);
    let bytes = encodeString(string, canonical);
    if (bytes.length > len) {
      bytes = bytes.subarray(0, len);
      if (canonical === 'utf8') bytes = bytes.subarray(0, completeUtf8Length(bytes));
      else if (canonical === 'utf16le') bytes = bytes.subarray(0, len & ~1);
    }
    this.set(bytes, off);
    return bytes.length;
  },

  fill(
    this: Buffer,
    value: string | number | Uint8Array,
    offset?: number | BufferEncoding,
    end?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): Buffer {
    let start = 0;
    let stop = this.length;
    let enc: unknown = encoding;
    if (typeof offset === 'string') {
      enc = offset;
    } else {
      if (offset !== undefined) start = offset;
      if (typeof end === 'string') enc = end;
      else if (end !== undefined) stop = end;
    }
    if (start < 0 || start > this.length)
      throw outOfRange('offset', `>= 0 && <= ${this.length}`, start);
    if (stop < 0 || stop > this.length) throw outOfRange('end', `>= 0 && <= ${this.length}`, stop);
    if (stop <= start) return this;
    if (typeof value === 'number') {
      Uint8Array.prototype.fill.call(this, value & 0xff, start, stop);
      return this;
    }
    let pattern: Uint8Array;
    if (typeof value === 'string') {
      const canonical = normalizeEncoding(enc);
      if (!canonical) throw unknownEncoding(enc);
      pattern = encodeString(value, canonical);
      if (pattern.length === 0) {
        if (value.length === 0) {
          Uint8Array.prototype.fill.call(this, 0, start, stop);
          return this;
        }
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_VALUE',
          `The argument 'value' is invalid. Received '${value}'`,
        );
      }
    } else if (value instanceof Uint8Array) {
      pattern = value;
      if (pattern.length === 0) {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_VALUE',
          "The argument 'value' is invalid. Received Uint8Array(0) []",
        );
      }
    } else if (typeof value === 'boolean') {
      Uint8Array.prototype.fill.call(this, Number(value), start, stop);
      return this;
    } else {
      Uint8Array.prototype.fill.call(this, Number(value) & 0xff, start, stop);
      return this;
    }
    for (let i = start, j = 0; i < stop; i++, j = (j + 1) % pattern.length) this[i] = pattern[j]!;
    return this;
  },

  indexOf(
    this: Buffer,
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number {
    return search(this, value, byteOffset, encoding, true);
  },

  lastIndexOf(
    this: Buffer,
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): number {
    return search(this, value, byteOffset, encoding, false);
  },

  includes(
    this: Buffer,
    value: string | number | Uint8Array,
    byteOffset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ): boolean {
    return search(this, value, byteOffset, encoding, true) !== -1;
  },

  swap16(this: Buffer): Buffer {
    if (this.length % 2 !== 0)
      throw codeError(
        RangeError,
        'ERR_INVALID_BUFFER_SIZE',
        'Buffer size must be a multiple of 16-bits',
      );
    for (let i = 0; i < this.length; i += 2) [this[i], this[i + 1]] = [this[i + 1]!, this[i]!];
    return this;
  },
  swap32(this: Buffer): Buffer {
    if (this.length % 4 !== 0)
      throw codeError(
        RangeError,
        'ERR_INVALID_BUFFER_SIZE',
        'Buffer size must be a multiple of 32-bits',
      );
    for (let i = 0; i < this.length; i += 4) this.subarray(i, i + 4).reverse();
    return this;
  },
  swap64(this: Buffer): Buffer {
    if (this.length % 8 !== 0)
      throw codeError(
        RangeError,
        'ERR_INVALID_BUFFER_SIZE',
        'Buffer size must be a multiple of 64-bits',
      );
    for (let i = 0; i < this.length; i += 8) this.subarray(i, i + 8).reverse();
    return this;
  },

  latin1Slice(this: Buffer, s?: number, e?: number) {
    return this.toString('latin1', s, e);
  },
  utf8Slice(this: Buffer, s?: number, e?: number) {
    return this.toString('utf8', s, e);
  },
  hexSlice(this: Buffer, s?: number, e?: number) {
    return this.toString('hex', s, e);
  },
  asciiSlice(this: Buffer, s?: number, e?: number) {
    return this.toString('ascii', s, e);
  },
  base64Slice(this: Buffer, s?: number, e?: number) {
    return this.toString('base64', s, e);
  },
  utf8Write(this: Buffer, str: string, offset?: number, length?: number) {
    return this.write(str, offset, length, 'utf8');
  },
  latin1Write(this: Buffer, str: string, offset?: number, length?: number) {
    return this.write(str, offset, length, 'latin1');
  },
};

/** Bytes of `bytes` that form complete UTF-8 sequences (Node never writes partial characters). */
function completeUtf8Length(bytes: Uint8Array): number {
  let end = bytes.length;
  // Walk back over continuation bytes to the last lead byte.
  let i = end - 1;
  while (i >= 0 && (bytes[i]! & 0xc0) === 0x80) i--;
  if (i < 0) return 0;
  const lead = bytes[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (end - i < need) end = i;
  return end;
}

function search(
  buf: Buffer,
  value: string | number | Uint8Array,
  byteOffset: number | BufferEncoding | undefined,
  encoding: BufferEncoding | undefined,
  forward: boolean,
): number {
  let enc: unknown = encoding;
  let offset: number;
  if (typeof byteOffset === 'string') {
    enc = byteOffset;
    offset = forward ? 0 : buf.length;
  } else if (byteOffset === undefined || byteOffset === null) {
    offset = forward ? 0 : buf.length;
  } else {
    offset = Number(byteOffset);
    if (Number.isNaN(offset)) offset = forward ? 0 : buf.length;
    else offset = Math.trunc(offset);
  }
  if (offset < 0) offset += buf.length;

  if (typeof value === 'number') {
    const byte = value & 0xff;
    if (forward) {
      for (let i = Math.max(0, offset); i < buf.length; i++) if (buf[i] === byte) return i;
    } else {
      for (let i = Math.min(offset, buf.length - 1); i >= 0; i--) if (buf[i] === byte) return i;
    }
    return -1;
  }
  let needle: Uint8Array;
  if (typeof value === 'string') {
    const canonical = normalizeEncoding(enc);
    if (!canonical) throw unknownEncoding(enc);
    needle = encodeString(value, canonical);
  } else if (value instanceof Uint8Array) {
    needle = value;
  } else {
    throw invalidArgType(
      'value',
      'one of type number or string or an instance of Buffer or Uint8Array',
      value,
    );
  }
  if (needle.length === 0) {
    return forward
      ? Math.min(Math.max(offset, 0), buf.length)
      : Math.min(Math.max(offset, 0), buf.length);
  }
  if (forward) {
    for (let i = Math.max(0, offset); i + needle.length <= buf.length; i++)
      if (matchAt(buf, needle, i)) return i;
  } else {
    if (offset < 0) return -1;
    for (let i = Math.min(offset, buf.length - needle.length); i >= 0; i--)
      if (matchAt(buf, needle, i)) return i;
  }
  return -1;
}

function matchAt(hay: Bytes, needle: Bytes, at: number): boolean {
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
}

// Numeric read/write methods via DataView, with Node's bounds errors.
function view(buf: Bytes): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function checkOffset(buf: Bytes, offset: unknown, size: number): number {
  if (offset === undefined) offset = 0;
  if (typeof offset !== 'number') throw invalidArgType('offset', 'of type number', offset);
  if (!Number.isInteger(offset)) throw outOfRange('offset', 'an integer', offset);
  if (offset < 0 || offset + size > buf.length) {
    if (buf.length - size < 0) {
      throw codeError(
        RangeError,
        'ERR_BUFFER_OUT_OF_BOUNDS',
        'Attempt to access memory outside buffer bounds',
      );
    }
    throw outOfRange('offset', `>= 0 and <= ${buf.length - size}`, offset);
  }
  return offset;
}

type NumKind = [size: number, get: string, set: string, min: number | bigint, max: number | bigint];
const NUMERIC: Record<string, NumKind> = {
  UInt8: [1, 'getUint8', 'setUint8', 0, 255],
  Int8: [1, 'getInt8', 'setInt8', -128, 127],
  UInt16: [2, 'getUint16', 'setUint16', 0, 0xffff],
  Int16: [2, 'getInt16', 'setInt16', -0x8000, 0x7fff],
  UInt32: [4, 'getUint32', 'setUint32', 0, 0xffffffff],
  Int32: [4, 'getInt32', 'setInt32', -0x80000000, 0x7fffffff],
  Float: [4, 'getFloat32', 'setFloat32', -Infinity, Infinity],
  Double: [8, 'getFloat64', 'setFloat64', -Infinity, Infinity],
  BigUInt64: [8, 'getBigUint64', 'setBigUint64', 0n, 2n ** 64n - 1n],
  BigInt64: [8, 'getBigInt64', 'setBigInt64', -(2n ** 63n), 2n ** 63n - 1n],
};

for (const [name, [size, get, set, min, max]] of Object.entries(NUMERIC)) {
  const endians = size === 1 ? [''] : ['LE', 'BE'];
  for (const endian of endians) {
    const little = endian === 'LE';
    const read = function (this: Buffer, offset?: number) {
      const at = checkOffset(this, offset, size);
      return (view(this) as unknown as Record<string, (o: number, le: boolean) => number | bigint>)[
        get
      ]!(at, little);
    };
    const write = function (this: Buffer, value: number | bigint, offset?: number) {
      const at = checkOffset(this, offset, size);
      const isBig = typeof min === 'bigint';
      if (isBig) {
        // Node's own check is V8's: mixing a number into BigInt math throws a plain TypeError.
        if (typeof value !== 'bigint')
          throw new TypeError('Cannot mix BigInt and other types, use explicit conversions');
        if (value < (min as bigint) || value > (max as bigint)) {
          throw outOfRange(
            'value',
            `>= ${min === 0n ? '0n' : `-(2n ** 63n)`} and ${min === 0n ? '< 2n ** 64n' : '< 2n ** 63n'}`,
            value,
          );
        }
      } else if (name !== 'Float' && name !== 'Double') {
        const n = Number(value);
        if (n < (min as number) || n > (max as number)) {
          throw outOfRange('value', `>= ${min} and <= ${max}`, value);
        }
      }
      (
        view(this) as unknown as Record<
          string,
          (o: number, v: number | bigint, le: boolean) => void
        >
      )[set]!(at, isBig ? value : Number(value), little);
      return at + size;
    };
    const names = [name];
    if (name.startsWith('UInt') || name === 'BigUInt64') names.push(name.replace('UInt', 'Uint'));
    for (const n of names) {
      (methods as Record<string, unknown>)[`read${n}${endian}`] = read;
      (methods as Record<string, unknown>)[`write${n}${endian}`] = write;
    }
  }
}

// Variable-width integers (1-6 bytes).
function readVar(
  buf: Buffer,
  offset: number,
  byteLength: number,
  little: boolean,
  signed: boolean,
): number {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
    throw outOfRange('byteLength', '>= 1 and <= 6', byteLength);
  }
  checkOffset(buf, offset, byteLength);
  let value = 0;
  for (let i = 0; i < byteLength; i++) {
    const b = buf[little ? offset + i : offset + byteLength - 1 - i]!;
    value += b * 2 ** (8 * i);
  }
  if (signed && value >= 2 ** (8 * byteLength - 1)) value -= 2 ** (8 * byteLength);
  return value;
}

function writeVar(
  buf: Buffer,
  value: number,
  offset: number,
  byteLength: number,
  little: boolean,
  signed: boolean,
): number {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
    throw outOfRange('byteLength', '>= 1 and <= 6', byteLength);
  }
  checkOffset(buf, offset, byteLength);
  const bits = 8 * byteLength;
  const min = signed ? -(2 ** (bits - 1)) : 0;
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (value < min || value > max) {
    throw outOfRange(
      'value',
      signed ? `>= -(2 ** ${bits - 1}) and < 2 ** ${bits - 1}` : `>= 0 and < 2 ** ${bits}`,
      value,
    );
  }
  let v = value < 0 ? value + 2 ** bits : value;
  for (let i = 0; i < byteLength; i++) {
    buf[little ? offset + i : offset + byteLength - 1 - i] = v % 256;
    v = Math.floor(v / 256);
  }
  return offset + byteLength;
}

Object.assign(methods, {
  readUIntLE(this: Buffer, o: number, n: number) {
    return readVar(this, o, n, true, false);
  },
  readUIntBE(this: Buffer, o: number, n: number) {
    return readVar(this, o, n, false, false);
  },
  readIntLE(this: Buffer, o: number, n: number) {
    return readVar(this, o, n, true, true);
  },
  readIntBE(this: Buffer, o: number, n: number) {
    return readVar(this, o, n, false, true);
  },
  writeUIntLE(this: Buffer, v: number, o: number, n: number) {
    return writeVar(this, v, o, n, true, false);
  },
  writeUIntBE(this: Buffer, v: number, o: number, n: number) {
    return writeVar(this, v, o, n, false, false);
  },
  writeIntLE(this: Buffer, v: number, o: number, n: number) {
    return writeVar(this, v, o, n, true, true);
  },
  writeIntBE(this: Buffer, v: number, o: number, n: number) {
    return writeVar(this, v, o, n, false, true);
  },
});
for (const n of ['readUInt', 'writeUInt']) {
  (methods as Record<string, unknown>)[`${n.replace('UInt', 'Uint')}LE`] = (
    methods as Record<string, unknown>
  )[`${n}LE`];
  (methods as Record<string, unknown>)[`${n.replace('UInt', 'Uint')}BE`] = (
    methods as Record<string, unknown>
  )[`${n}BE`];
}

for (const [name, fn] of Object.entries(methods)) {
  Object.defineProperty(proto, name, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

Object.defineProperty(proto, 'parent', {
  get(this: Buffer) {
    return this.buffer;
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(proto, 'offset', {
  get(this: Buffer) {
    return this.byteOffset;
  },
  enumerable: true,
  configurable: true,
});

// `<Buffer 68 69>` in console.log, as in Node.
Object.defineProperty(proto, Symbol.for('nodejs.util.inspect.custom'), {
  value(this: Buffer) {
    const max = INSPECT_MAX_BYTES;
    let str = '';
    for (let i = 0; i < Math.min(max, this.length); i++) str += (i > 0 ? ' ' : '') + HEX[this[i]!];
    const remaining = this.length - max;
    if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    // Node always puts a space after the name, even for an empty buffer: `<Buffer >`.
    return `<${this.constructor.name} ${str}>`;
  },
  writable: true,
  configurable: true,
});

/** Wraps bytes from a syscall (or any Uint8Array) as a Buffer without copying. */
export function toBuffer(bytes: Uint8Array): Buffer {
  return asBuffer(bytes);
}

export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };

export const SlowBuffer = function SlowBuffer(size: number) {
  return Buffer.allocUnsafeSlow(size);
};

export function isUtf8(input: ArrayBufferView | ArrayBuffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input: ArrayBufferView | ArrayBuffer): boolean {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  for (const b of bytes) if (b > 0x7f) return false;
  return true;
}

export function atob(data: string): string {
  return globalThis.atob(data);
}

export function btoa(data: string): string {
  return globalThis.btoa(data);
}

/** The `buffer` builtin module. */
export const bufferModule = {
  Buffer,
  SlowBuffer,
  kMaxLength,
  kStringMaxLength,
  INSPECT_MAX_BYTES,
  constants,
  isUtf8,
  isAscii,
  atob,
  btoa,
  Blob: globalThis.Blob,
  File: globalThis.File,
  transcode(source: Uint8Array, fromEnc: BufferEncoding, toEnc: BufferEncoding): Buffer {
    const from = normalizeEncoding(fromEnc);
    const to = normalizeEncoding(toEnc);
    if (!from) throw unknownEncoding(fromEnc);
    if (!to) throw unknownEncoding(toEnc);
    return asBuffer(encodeString(decodeBytes(source, from), to));
  },
};
