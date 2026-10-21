// SPDX-License-Identifier: Apache-2.0
import { Buffer, codeError } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';

/**
 * `string_decoder`: decodes a byte stream to strings without splitting
 * multi-byte characters across chunks. utf8 and utf16le buffer partial
 * characters; base64 buffers incomplete 3-byte groups; others are stateless.
 */
export class StringDecoder {
  readonly encoding: string;
  private pending: Uint8Array = new Uint8Array(0);
  private readonly decoder: TextDecoder | null;

  constructor(encoding: BufferEncoding | string = 'utf8') {
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
    this.decoder =
      canonical === 'utf8'
        ? new TextDecoder('utf-8')
        : canonical === 'utf16le'
          ? new TextDecoder('utf-16le')
          : null;
  }

  write(buf: Uint8Array | string): string {
    if (typeof buf === 'string') return buf;
    if (this.decoder) return this.decoder.decode(copy(buf), { stream: true });
    if (this.encoding === 'base64' || this.encoding === 'base64url') {
      const all = concat(this.pending, buf);
      const usable = all.length - (all.length % 3);
      this.pending = all.slice(usable);
      return Buffer.from(all.subarray(0, usable)).toString(this.encoding as BufferEncoding);
    }
    return Buffer.from(buf).toString(this.encoding as BufferEncoding);
  }

  end(buf?: Uint8Array | string): string {
    let out = buf === undefined ? '' : this.write(buf);
    if (this.decoder) out += this.decoder.decode();
    else if (this.pending.length > 0) {
      out += Buffer.from(this.pending).toString(this.encoding as BufferEncoding);
      this.pending = new Uint8Array(0);
    }
    return out;
  }
}

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
