// SPDX-License-Identifier: Apache-2.0
import { Buffer, codeError } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';

/**
 * `string_decoder`: decodes a byte stream to strings without splitting
 * multi-byte characters across chunks. utf8 and utf16le buffer partial
 * characters; base64 buffers incomplete 3-byte groups; others are stateless.
 */
export interface StringDecoder {
  readonly encoding: string;
  write(buf: Uint8Array | string): string;
  end(buf?: Uint8Array | string): string;
}

interface DecoderState {
  encoding: string;
  _pending: Uint8Array;
  _decoder: TextDecoder | null;
}

/**
 * A plain constructor function, like Node's: libraries such as iconv-lite call
 * `StringDecoder.call(this, enc)` and reuse `StringDecoder.prototype`.
 */
export const StringDecoder = function StringDecoder(
  this: DecoderState,
  encoding: BufferEncoding | string = 'utf8',
) {
  const enc = String(encoding).toLowerCase();
  const canonical =
    enc === 'utf-8'
      ? 'utf8'
      : enc === 'ucs2' || enc === 'ucs-2' || enc === 'utf-16le'
        ? 'utf16le'
        : enc === 'binary'
          ? 'latin1'
          : enc;
  if (!Buffer.isEncoding(canonical)) {
    throw codeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${String(encoding)}`);
  }
  this.encoding = canonical;
  this._pending = new Uint8Array(0);
  this._decoder =
    canonical === 'utf8'
      ? new TextDecoder('utf-8')
      : canonical === 'utf16le'
        ? new TextDecoder('utf-16le')
        : null;
} as unknown as new (encoding?: BufferEncoding | string) => StringDecoder;

Object.defineProperties(StringDecoder.prototype, {
  write: {
    writable: true,
    configurable: true,
    value: function write(this: DecoderState, buf: Uint8Array | string): string {
      if (typeof buf === 'string') return buf;
      if (this._decoder) return this._decoder.decode(copy(buf), { stream: true });
      if (this.encoding === 'base64' || this.encoding === 'base64url') {
        const all = concat(this._pending, buf);
        const usable = all.length - (all.length % 3);
        this._pending = all.slice(usable);
        return Buffer.from(all.subarray(0, usable)).toString(this.encoding as BufferEncoding);
      }
      return Buffer.from(buf).toString(this.encoding as BufferEncoding);
    },
  },
  end: {
    writable: true,
    configurable: true,
    value: function end(this: DecoderState & StringDecoder, buf?: Uint8Array | string): string {
      let out = buf === undefined ? '' : this.write(buf);
      if (this._decoder) out += this._decoder.decode();
      else if (this._pending.length > 0) {
        out += Buffer.from(this._pending).toString(this.encoding as BufferEncoding);
        this._pending = new Uint8Array(0);
      }
      return out;
    },
  },
});
function copy(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  return (
    buf.buffer instanceof ArrayBuffer ? buf : Uint8Array.prototype.slice.call(buf)
  ) as Uint8Array<ArrayBuffer>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export const stringDecoderModule = { StringDecoder };
