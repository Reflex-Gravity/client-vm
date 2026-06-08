// SPDX-License-Identifier: Apache-2.0

/**
 * Compact binary encoding for syscall arguments and results.
 *
 * Bytes in, bytes out: nothing here depends on the transport, so the codec can
 * be swapped (or moved to WASM) without touching callers.
 */
export type Value =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Value[]
  | { readonly [key: string]: Value };

const Tag = {
  NULL: 0,
  UNDEFINED: 1,
  FALSE: 2,
  TRUE: 3,
  INT32: 4,
  FLOAT64: 5,
  STRING: 6,
  BYTES: 7,
  ARRAY: 8,
  OBJECT: 9,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(n: number): void {
    this.ensure(1);
    this.buf[this.pos++] = n;
  }

  u32(n: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, n, true);
    this.pos += 4;
  }

  i32(n: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, n, true);
    this.pos += 4;
  }

  f64(n: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, n, true);
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  string(s: string): void {
    // Worst case UTF-8 expansion is 3 bytes per UTF-16 code unit.
    this.ensure(4 + s.length * 3);
    const lenPos = this.pos;
    this.pos += 4;
    const { written } = textEncoder.encodeInto(s, this.buf.subarray(this.pos));
    this.view.setUint32(lenPos, written, true);
    this.pos += written;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('codec: unexpected end of input');
    return this.buf[this.pos++]!;
  }

  u32(): number {
    const n = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return n;
  }

  i32(): number {
    const n = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return n;
  }

  f64(): number {
    const n = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return n;
  }

  bytes(): Uint8Array {
    const len = this.u32();
    if (this.pos + len > this.buf.length) throw new RangeError('codec: bytes overrun');
    // slice() copies, so the result never aliases a SharedArrayBuffer.
    const out = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return textDecoder.decode(this.bytes());
  }
}

function write(w: Writer, value: Value): void {
  if (value === null) return w.u8(Tag.NULL);
  if (value === undefined) return w.u8(Tag.UNDEFINED);
  switch (typeof value) {
    case 'boolean':
      return w.u8(value ? Tag.TRUE : Tag.FALSE);
    case 'number':
      if (
        Number.isInteger(value) &&
        value >= -0x80000000 &&
        value <= 0x7fffffff &&
        !Object.is(value, -0)
      ) {
        w.u8(Tag.INT32);
        return w.i32(value);
      }
      w.u8(Tag.FLOAT64);
      return w.f64(value);
    case 'string':
      w.u8(Tag.STRING);
      return w.string(value);
    case 'object':
      break;
    default:
      throw new TypeError(`codec: cannot encode ${typeof value}`);
  }
  if (value instanceof Uint8Array) {
    w.u8(Tag.BYTES);
    return w.bytes(value);
  }
  if (Array.isArray(value)) {
    w.u8(Tag.ARRAY);
    w.u32(value.length);
    for (const item of value as readonly Value[]) write(w, item);
    return;
  }
  const entries = Object.entries(value as { readonly [key: string]: Value });
  w.u8(Tag.OBJECT);
  w.u32(entries.length);
  for (const [k, v] of entries) {
    w.string(k);
    write(w, v);
  }
}

function read(r: Reader): Value {
  const tag = r.u8();
  switch (tag) {
    case Tag.NULL:
      return null;
    case Tag.UNDEFINED:
      return undefined;
    case Tag.FALSE:
      return false;
    case Tag.TRUE:
      return true;
    case Tag.INT32:
      return r.i32();
    case Tag.FLOAT64:
      return r.f64();
    case Tag.STRING:
      return r.string();
    case Tag.BYTES:
      return r.bytes();
    case Tag.ARRAY: {
      const n = r.u32();
      const out: Value[] = [];
      for (let i = 0; i < n; i++) out.push(read(r));
      return out;
    }
    case Tag.OBJECT: {
      const n = r.u32();
      const out: Record<string, Value> = {};
      for (let i = 0; i < n; i++) {
        const key = r.string();
        out[key] = read(r);
      }
      return out;
    }
    default:
      throw new RangeError(`codec: unknown tag ${tag}`);
  }
}

export function encode(value: Value): Uint8Array {
  const w = new Writer();
  write(w, value);
  return w.finish();
}

export function decode(bytes: Uint8Array): Value {
  return read(new Reader(bytes));
}

export function encodeUtf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** Decodes UTF-8, copying first if the bytes live in a SharedArrayBuffer (TextDecoder rejects those). */
export function decodeUtf8(bytes: Uint8Array): string {
  const safe = bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
  return textDecoder.decode(safe);
}
