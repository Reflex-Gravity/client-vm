// SPDX-License-Identifier: Apache-2.0
// node-compat's synchronous crypto against node:crypto.
import * as nodeCrypto from 'node:crypto';
import { cryptoModule } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

const ours = cryptoModule as unknown as typeof nodeCrypto;
const ALGS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'SHA256', 'RSA-SHA512'];
const INPUTS = [
  '',
  'abc',
  'a'.repeat(55),
  'a'.repeat(56),
  'a'.repeat(64),
  'b'.repeat(111),
  'b'.repeat(112),
  'b'.repeat(128),
  'The quick brown fox jumps over the lazy dog',
  'x'.repeat(10_000) + 'é中',
];

describe('crypto differential vs node:crypto', () => {
  for (const alg of ALGS) {
    it(`createHash(${alg})`, () => {
      for (const input of INPUTS) {
        for (const enc of ['hex', 'base64', 'base64url'] as const) {
          expect(ours.createHash(alg).update(input).digest(enc)).toBe(
            nodeCrypto.createHash(alg).update(input).digest(enc),
          );
        }
      }
    });
    it(`incremental updates and copy (${alg})`, () => {
      const data = Buffer.from(INPUTS.join('|'));
      const a = ours.createHash(alg);
      const b = nodeCrypto.createHash(alg);
      for (let i = 0; i < data.length; i += 37) {
        a.update(data.subarray(i, i + 37));
        b.update(data.subarray(i, i + 37));
      }
      const copy = a.copy();
      expect(a.digest('hex')).toBe(b.digest('hex'));
      expect(copy.update('more').digest('hex')).toBe(
        nodeCrypto.createHash(alg).update(data).update('more').digest('hex'),
      );
    });
    it(`createHmac(${alg})`, () => {
      for (const key of ['k', 'x'.repeat(200)]) {
        expect(ours.createHmac(alg, key).update('message').digest('hex')).toBe(
          nodeCrypto.createHmac(alg, key).update('message').digest('hex'),
        );
      }
    });
  }

  it('pbkdf2Sync', () => {
    expect(ours.pbkdf2Sync('pw', 'salt', 1000, 40, 'sha256').toString('hex')).toBe(
      nodeCrypto.pbkdf2Sync('pw', 'salt', 1000, 40, 'sha256').toString('hex'),
    );
  });

  it('errors and randomness', () => {
    expect(() => ours.createHash('nope')).toThrow('Digest method not supported');
    const h = ours.createHash('sha1');
    h.digest();
    expect(() => h.digest()).toThrow(
      expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
    );
    expect(ours.randomBytes(16)).toHaveLength(16);
    expect(ours.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    const n = ours.randomInt(5, 10);
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThan(10);
    expect(ours.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(ours.hash('sha1', 'abc')).toBe(nodeCrypto.hash('sha1', 'abc'));
  });
});
