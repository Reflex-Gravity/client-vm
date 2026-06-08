// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { decode, decodeUtf8, encode } from './codec.ts';
import type { Value } from './codec.ts';

describe('codec', () => {
  const cases: [string, Value][] = [
    ['null', null],
    ['undefined', undefined],
    ['booleans', [true, false]],
    ['int32 bounds', [0, 1, -1, 2 ** 31 - 1, -(2 ** 31)]],
    [
      'floats and non-int32 numbers',
      [1.5, 2 ** 31, -(2 ** 40), Number.MAX_SAFE_INTEGER, Infinity, -Infinity],
    ],
    ['unicode strings', ['', 'ascii', 'héllo', '日本語', '😀 emoji', 'nul\0byte']],
    ['bytes', new Uint8Array([0, 1, 254, 255])],
    ['nested', { a: [1, { b: 'c' }], 'key with spaces': null, empty: {}, list: [] }],
  ];

  for (const [name, value] of cases) {
    it(`round-trips ${name}`, () => {
      expect(decode(encode(value))).toEqual(value);
    });
  }

  it('preserves -0 and NaN', () => {
    expect(Object.is(decode(encode(-0)), -0)).toBe(true);
    expect(decode(encode(NaN))).toBeNaN();
  });

  it('grows its buffer for large payloads', () => {
    const big = new Uint8Array(1_000_000).fill(7);
    const out = decode(encode([big, 'x'.repeat(100_000)])) as [Uint8Array, string];
    expect(out[0]).toEqual(big);
    expect(out[1].length).toBe(100_000);
  });

  it('rejects truncated and unknown input', () => {
    expect(() => decode(new Uint8Array([]))).toThrow(RangeError);
    expect(() => decode(new Uint8Array([200]))).toThrow(/unknown tag/);
  });

  it('decodes UTF-8 that lives in a SharedArrayBuffer', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(5));
    shared.set(new TextEncoder().encode('hello'));
    expect(decodeUtf8(shared)).toBe('hello');
  });
});
