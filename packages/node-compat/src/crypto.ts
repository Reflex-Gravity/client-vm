// SPDX-License-Identifier: Apache-2.0
// `crypto`: synchronous hashes, HMAC, PBKDF2 and randomness (what package
// managers, servers and build tools use). Ciphers and key pairs are not
// provided; `webcrypto`/`subtle` are the browser's.

import { Buffer } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';
import { HASH_NAMES, digestFor } from './hashes.ts';
import type { Digest } from './hashes.ts';

function codeError(Ctor: new (m: string) => Error, code: string, message: string): Error {
  const e = new Ctor(message);
  (e as Error & { code: string }).code = code;
  return e;
}

function bytesOf(data: unknown, encoding?: BufferEncoding): Uint8Array {
  if (typeof data === 'string')
    return Buffer.from(data, encoding ?? 'utf8') as unknown as Uint8Array;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw codeError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
  );
}

function encodeOut(bytes: Uint8Array, encoding?: string): Buffer | string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return encoding && encoding !== 'buffer' ? buf.toString(encoding as BufferEncoding) : buf;
}

function newDigest(algorithm: string): Digest {
  const d = digestFor(String(algorithm));
  if (!d) throw new Error('Digest method not supported');
  return d;
}

export class Hash {
  private d: Digest | null;
  readonly #alg: string;
  constructor(algorithm: string, _options?: unknown, digest?: Digest) {
    this.#alg = algorithm;
    this.d = digest ?? newDigest(algorithm);
  }
  update(data: unknown, encoding?: BufferEncoding): this {
    if (!this.d) throw codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    this.d.update(bytesOf(data, encoding));
    return this;
  }
  digest(encoding?: string): Buffer | string {
    if (!this.d) throw codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    const out = this.d.digest();
    this.d = null;
    return encodeOut(out, encoding);
  }
  copy(): Hash {
    if (!this.d) throw codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    return new Hash(this.#alg, undefined, this.d.clone());
  }
}

export class Hmac {
  private inner: Digest | null;
  private outer: Digest;
  constructor(algorithm: string, key: unknown) {
    const inner = newDigest(algorithm);
    let k = bytesOf(
      typeof key === 'object' && key !== null && 'export' in key
        ? (key as { export(): Uint8Array }).export()
        : key,
    );
    if (k.length > inner.blockSize) {
      const kd = newDigest(algorithm);
      kd.update(k);
      k = kd.digest();
    }
    const block = new Uint8Array(inner.blockSize);
    block.set(k);
    const ipad = block.map((b) => b ^ 0x36);
    const opad = block.map((b) => b ^ 0x5c);
    inner.update(ipad);
    this.inner = inner;
    this.outer = newDigest(algorithm);
    this.outer.update(opad);
  }
  update(data: unknown, encoding?: BufferEncoding): this {
    if (!this.inner) throw codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    this.inner.update(bytesOf(data, encoding));
    return this;
  }
  digest(encoding?: string): Buffer | string {
    if (!this.inner) throw codeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
    this.outer.update(this.inner.digest());
    this.inner = null;
    return encodeOut(this.outer.digest(), encoding);
  }
}

function hmacBytes(algorithm: string, key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Hmac(algorithm, key).update(data).digest() as unknown as Uint8Array;
}

export function pbkdf2Sync(
  password: unknown,
  salt: unknown,
  iterations: number,
  keylen: number,
  digest = 'sha1',
): Buffer {
  const pw = bytesOf(password);
  const s = bytesOf(salt);
  const hlen = newDigest(digest).outputLength;
  const out = new Uint8Array(keylen);
  const blocks = Math.ceil(keylen / hlen);
  for (let i = 1; i <= blocks; i++) {
    const block = new Uint8Array(s.length + 4);
    block.set(s);
    new DataView(block.buffer).setUint32(s.length, i);
    let u = hmacBytes(digest, pw, block);
    const t = Uint8Array.from(u);
    for (let j = 1; j < iterations; j++) {
      u = hmacBytes(digest, pw, u);
      for (let k = 0; k < t.length; k++) t[k]! ^= u[k]!;
    }
    out.set(t.subarray(0, Math.min(hlen, keylen - (i - 1) * hlen)), (i - 1) * hlen);
  }
  return Buffer.from(out.buffer);
}

function fillRandom(view: Uint8Array): void {
  for (let i = 0; i < view.length; i += 65536)
    crypto.getRandomValues(view.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>);
}

export function randomBytes(
  size: number,
  cb?: (err: Error | null, buf: Buffer) => void,
): Buffer | undefined {
  if (!Number.isInteger(size) || size < 0 || size > 2 ** 31 - 1) {
    throw codeError(
      RangeError,
      'ERR_OUT_OF_RANGE',
      `The value of "size" is out of range. Received ${size}`,
    );
  }
  const buf = Buffer.alloc(size);
  fillRandom(buf as unknown as Uint8Array);
  if (cb) {
    queueMicrotask(() => cb(null, buf));
    return undefined;
  }
  return buf;
}

export function randomFillSync<T extends ArrayBufferView>(buf: T, offset = 0, size?: number): T {
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  fillRandom(view.subarray(offset, size === undefined ? undefined : offset + size));
  return buf;
}

function randomInt(
  min: number,
  max?: number | ((e: Error | null, n: number) => void),
  cb?: (e: Error | null, n: number) => void,
): number | undefined {
  let lo = 0;
  let hi = min;
  let callback = cb;
  if (typeof max === 'number') {
    lo = min;
    hi = max;
  } else if (typeof max === 'function') callback = max;
  const range = hi - lo;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || range <= 0 || range > 2 ** 48) {
    throw codeError(
      RangeError,
      'ERR_OUT_OF_RANGE',
      `The value of "max" is out of range. It must be greater than the value of "min" (${lo}). Received ${hi}`,
    );
  }
  // Rejection sampling over 48 random bits, as Node does.
  const limit = 2 ** 48 - (2 ** 48 % range);
  let x: number;
  do {
    const b = new Uint8Array(6);
    crypto.getRandomValues(b);
    x = b.reduce((acc, v) => acc * 256 + v, 0);
  } while (x >= limit);
  const n = lo + (x % range);
  if (callback) {
    queueMicrotask(() => callback!(null, n));
    return undefined;
  }
  return n;
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) {
    throw codeError(
      RangeError,
      'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
      'Input buffers must have the same byte length',
    );
  }
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const unsupported = (name: string) => () => {
  throw codeError(
    Error,
    'ERR_CLIENTVM_UNSUPPORTED',
    `crypto.${name} is not available in ClientVM (docs/compatibility.md)`,
  );
};

export const cryptoModule: Record<string, unknown> = {
  createHash: (algorithm: string, options?: unknown) => new Hash(algorithm, options),
  createHmac: (algorithm: string, key: unknown) => new Hmac(algorithm, key),
  hash: (algorithm: string, data: unknown, encoding = 'hex') =>
    new Hash(algorithm).update(data).digest(encoding),
  Hash,
  Hmac,
  getHashes: () => [...HASH_NAMES, 'RSA-SHA256', 'RSA-SHA1', 'RSA-SHA512'],
  getCiphers: () => [],
  getCurves: () => [],
  pbkdf2Sync,
  pbkdf2: (
    password: unknown,
    salt: unknown,
    iterations: number,
    keylen: number,
    digest: string,
    cb: (e: Error | null, k?: Buffer) => void,
  ) => {
    let key: Buffer;
    try {
      key = pbkdf2Sync(password, salt, iterations, keylen, digest);
    } catch (err) {
      queueMicrotask(() => cb(err as Error));
      return;
    }
    queueMicrotask(() => cb(null, key));
  },
  randomBytes,
  pseudoRandomBytes: randomBytes,
  prng: randomBytes,
  rng: randomBytes,
  randomFillSync,
  randomFill: (buf: ArrayBufferView, ...rest: unknown[]) => {
    const cb = rest.pop() as (e: Error | null, b: ArrayBufferView) => void;
    randomFillSync(buf, ...(rest as [number?, number?]));
    queueMicrotask(() => cb(null, buf));
  },
  randomInt,
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (a: ArrayBufferView<ArrayBuffer>) => crypto.getRandomValues(a),
  timingSafeEqual,
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto?.subtle,
  constants: {},
  getFips: () => 0,
  setFips: () => {},
  createCipheriv: unsupported('createCipheriv'),
  createDecipheriv: unsupported('createDecipheriv'),
  createSign: unsupported('createSign'),
  createVerify: unsupported('createVerify'),
  generateKeyPair: unsupported('generateKeyPair'),
  generateKeyPairSync: unsupported('generateKeyPairSync'),
  createPublicKey: unsupported('createPublicKey'),
  createPrivateKey: unsupported('createPrivateKey'),
  createSecretKey: (key: unknown) => ({ type: 'secret', export: () => Buffer.from(bytesOf(key)) }),
  scryptSync: unsupported('scryptSync'),
  scrypt: unsupported('scrypt'),
  createECDH: unsupported('createECDH'),
  createDiffieHellman: unsupported('createDiffieHellman'),
};
