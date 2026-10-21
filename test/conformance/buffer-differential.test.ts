// SPDX-License-Identifier: Apache-2.0
// Compares the node-compat Buffer with Node's own, operation by operation.
import { Buffer as NodeBuffer } from 'node:buffer';
import { Buffer as OurBuffer } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

type B = typeof NodeBuffer;
const Ours = OurBuffer as unknown as B;

/** Runs `fn` against both implementations; compares results or error codes. */
function same(label: string, fn: (Buf: B) => unknown): void {
  const run = (Buf: B) => {
    try {
      return { ok: normalize(fn(Buf)) };
    } catch (err) {
      return { error: (err as { code?: string }).code ?? (err as Error).name };
    }
  };
  expect(run(Ours), label).toEqual(run(NodeBuffer));
}

function normalize(v: unknown): unknown {
  if (v instanceof Uint8Array)
    return { bytes: Array.from(v), isBuffer: NodeBuffer.isBuffer(v) || OurBuffer.isBuffer(v) };
  if (typeof v === 'bigint') return `${v}n`;
  if (Array.isArray(v)) return v.map(normalize);
  return v;
}

const STRINGS = [
  '',
  'hello',
  'héllo wörld',
  '日本語テキスト',
  '😀🎉',
  'a\u0000b',
  '\ud800',
  'x'.repeat(300),
];
const ENCODINGS = [
  'utf8',
  'utf-8',
  'hex',
  'base64',
  'base64url',
  'latin1',
  'binary',
  'ascii',
  'utf16le',
  'ucs2',
  'UTF8',
  'bogus',
] as const;
const BYTES = [
  [],
  [0],
  [255, 0, 128],
  [0xe6, 0x97, 0xa5],
  [0xc3],
  [0xf0, 0x9f, 0x98],
  Array.from({ length: 70 }, (_, i) => (i * 37) & 0xff),
];

describe('Buffer differential: node-compat vs node:buffer', () => {
  it('from(string, encoding) and toString(encoding)', () => {
    for (const s of [
      ...STRINGS,
      'aGVsbG8=',
      'aGVs bG8',
      'aGVsbG8_-w',
      'zz',
      'abc',
      'ABCDEF1',
      '0g',
    ]) {
      for (const enc of ENCODINGS) {
        same(`from(${JSON.stringify(s)}, ${enc})`, (Buf) => Buf.from(s, enc as BufferEncoding));
        same(`byteLength(${JSON.stringify(s)}, ${enc})`, (Buf) =>
          Buf.byteLength(s, enc as BufferEncoding),
        );
      }
    }
    for (const bytes of BYTES) {
      for (const enc of ENCODINGS) {
        same(`toString(${bytes}, ${enc})`, (Buf) =>
          Buf.from(bytes).toString(enc as BufferEncoding),
        );
      }
      same(`toString ranges ${bytes}`, (Buf) => {
        const b = Buf.from(bytes);
        return [
          b.toString('hex', 1),
          b.toString('hex', 1, 2),
          b.toString('hex', -5, 100),
          b.toString('utf8', 2, 1),
        ];
      });
    }
  });

  it('from other sources', () => {
    same('array', (Buf) => Buf.from([1, 2, 256, -1, 3.7, '9' as unknown as number]));
    same('typed array', (Buf) => Buf.from(new Uint16Array([1, 0x1234])));
    same('arraybuffer shares memory', (Buf) => {
      const ab = new ArrayBuffer(8);
      const b = Buf.from(ab, 2, 4);
      new Uint8Array(ab)[3] = 7;
      return [b, b.length];
    });
    same('arraybuffer out of bounds', (Buf) => Buf.from(new ArrayBuffer(4), 5));
    same('buffer copy', (Buf) => {
      const a = Buf.from('abc');
      const b = Buf.from(a);
      a[0] = 0;
      return b;
    });
    same('json shape', (Buf) => Buf.from({ type: 'Buffer', data: [1, 2] } as unknown as string));
    same('invalid', (Buf) => Buf.from(42 as unknown as string));
    same('String object', (Buf) => Buf.from(new String('obj') as unknown as string));
  });

  it('alloc, concat, compare, equals', () => {
    same('alloc', (Buf) => [
      Buf.alloc(4),
      Buf.alloc(5, 'ab'),
      Buf.alloc(4, 0x101),
      Buf.alloc(6, 'aGk=', 'base64'),
      Buf.alloc(3, Buf.from([9, 8])),
    ]);
    same('alloc negative', (Buf) => Buf.alloc(-1));
    same('alloc non-number', (Buf) => Buf.alloc('3' as unknown as number));
    same('concat', (Buf) => [
      Buf.concat([Buf.from('ab'), new Uint8Array([1]), Buf.from('cd')]),
      Buf.concat([Buf.from('abcdef')], 3),
      Buf.concat([Buf.from('ab')], 5),
      Buf.concat([]),
    ]);
    same('concat bad', (Buf) => Buf.concat(['x' as unknown as Uint8Array]));
    same('compare', (Buf) => [
      Buf.compare(Buf.from('a'), Buf.from('b')),
      Buf.compare(Buf.from('b'), Buf.from('a')),
      Buf.compare(Buf.from('ab'), Buf.from('a')),
      Buf.compare(Buf.from(''), Buf.from('')),
    ]);
    same('instance compare', (Buf) => {
      const a = Buf.from('abcdef');
      return [
        a.compare(Buf.from('cd'), 0, 2, 2, 4),
        a.compare(Buf.from('zz')),
        a.compare(Buf.from('a'), 1, 1, 0, 0),
        a.compare(Buf.from('a'), 0, 1, 3, 3),
      ];
    });
    same('compare out of range', (Buf) => Buf.from('a').compare(Buf.from('b'), 0, 5));
    same('equals', (Buf) => [
      Buf.from('a').equals(Buf.from('a')),
      Buf.from('a').equals(new Uint8Array([98])),
    ]);
    same('isEncoding', (Buf) =>
      ['utf8', 'UTF-8', 'Hex', 'bogus', '', 'binary', 'ucs-2'].map((e) => Buf.isEncoding(e)),
    );
    same('isBuffer', (Buf) => [
      Buf.isBuffer(Buf.alloc(1)),
      Buf.isBuffer(new Uint8Array(1)),
      Buf.isBuffer('x'),
    ]);
  });

  it('slicing, copying, filling', () => {
    same('slice shares memory', (Buf) => {
      const b = Buf.from('abcdef');
      const s = b.slice(1, -1);
      s[0] = 0x5a;
      return [b, s, b.slice(-2), b.slice(4, 2), b.subarray(2), Buf.isBuffer(b.subarray(1))];
    });
    same('copy', (Buf) => {
      const src = Buf.from('abcdef');
      const dst = Buf.alloc(4, '.');
      const n = src.copy(dst, 1, 2);
      return [n, dst, src.copy(dst, 10), src.copy(Buf.alloc(2), 0, 4, 100)];
    });
    same('copy negative', (Buf) => Buf.from('abc').copy(Buf.alloc(2), -1));
    same('fill', (Buf) => [
      Buf.alloc(5).fill('ab'),
      Buf.alloc(5).fill(0x41, 1, 3),
      Buf.alloc(4).fill('6162', 'hex'),
      Buf.alloc(4).fill(Buf.from([1, 2, 3])),
      Buf.alloc(3).fill(''),
      Buf.alloc(3).fill(257),
    ]);
    same('fill invalid hex', (Buf) => Buf.alloc(3).fill('zz', 'hex'));
    same('write', (Buf) => {
      const b = Buf.alloc(8);
      return [
        b.write('héllo'),
        b.write('ab', 6),
        b.write('ffee', 1, 'hex'),
        b.write('日本', 6),
        b.write('xyz', 2, 1),
        b,
      ];
    });
    same('write utf16le odd length', (Buf) => {
      const b = Buf.alloc(5);
      return [b.write('abc', 0, 5, 'utf16le'), b];
    });
    same('write out of range', (Buf) => Buf.alloc(2).write('a', 3));
    same('toJSON', (Buf) => JSON.stringify(Buf.from('hi')));
  });

  it('searching', () => {
    const haystacks = ['abcabc', '', 'aaa', 'héllo héllo'];
    const needles: (string | number)[] = ['a', 'bc', 'abc', '', 'z', 98, 0x161, 'é'];
    const offsets = [undefined, 0, 1, -2, 100, -100, 'utf8', 'hex', NaN];
    for (const h of haystacks) {
      for (const n of needles) {
        for (const o of offsets) {
          same(`indexOf(${h}, ${n}, ${o})`, (Buf) => Buf.from(h).indexOf(n, o as number));
          same(`lastIndexOf(${h}, ${n}, ${o})`, (Buf) => Buf.from(h).lastIndexOf(n, o as number));
          same(`includes(${h}, ${n}, ${o})`, (Buf) => Buf.from(h).includes(n, o as number));
        }
      }
    }
    same('buffer needle', (Buf) => Buf.from('xxabcxx').indexOf(Buf.from('abc')));
  });

  it('numeric reads and writes', () => {
    const bytes = [0x01, 0x82, 0xff, 0x7f, 0x80, 0x00, 0x10, 0xfe, 0x33];
    const readers = [
      'readUInt8',
      'readInt8',
      'readUInt16LE',
      'readUInt16BE',
      'readInt16LE',
      'readInt16BE',
      'readUInt32LE',
      'readUInt32BE',
      'readInt32LE',
      'readInt32BE',
      'readFloatLE',
      'readFloatBE',
      'readDoubleLE',
      'readDoubleBE',
      'readBigUInt64LE',
      'readBigUInt64BE',
      'readBigInt64LE',
      'readBigInt64BE',
      'readUint16LE',
      'readUint32BE',
    ];
    for (const r of readers) {
      for (const off of [undefined, 0, 1, 7, 9, -1, 1.5]) {
        same(`${r}(${off})`, (Buf) =>
          (Buf.from(bytes) as unknown as Record<string, (o?: number) => unknown>)[r]!(off),
        );
      }
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 0]) {
      for (const r of ['readUIntLE', 'readUIntBE', 'readIntLE', 'readIntBE']) {
        same(`${r}(1, ${n})`, (Buf) =>
          (Buf.from(bytes) as unknown as Record<string, (o: number, n: number) => unknown>)[r]!(
            1,
            n,
          ),
        );
      }
    }
    const writes: [string, number | bigint][] = [
      ['writeUInt8', 255],
      ['writeUInt8', 256],
      ['writeInt8', -128],
      ['writeInt8', 128],
      ['writeUInt16LE', 0xbeef],
      ['writeUInt16BE', 0xbeef],
      ['writeInt16LE', -2],
      ['writeUInt32LE', 0xdeadbeef],
      ['writeUInt32BE', -1],
      ['writeInt32BE', -123456],
      ['writeFloatLE', 1.5],
      ['writeDoubleBE', Math.PI],
      ['writeBigUInt64LE', 2n ** 63n],
      ['writeBigInt64BE', -5n],
      ['writeBigUInt64LE', -1n],
      ['writeBigInt64LE', 5 as unknown as bigint],
    ];
    for (const [w, v] of writes) {
      for (const off of [undefined, 0, 1, 7]) {
        same(`${w}(${v}, ${off})`, (Buf) => {
          const b = Buf.alloc(10);
          const end = (b as unknown as Record<string, (v: unknown, o?: number) => number>)[w]!(
            v,
            off,
          );
          return [end, b];
        });
      }
    }
    for (const [v, n] of [
      [0x1234, 2],
      [-1, 3],
      [2 ** 40, 6],
      [2 ** 48, 6],
      [-(2 ** 47), 6],
    ] as const) {
      for (const w of ['writeUIntLE', 'writeUIntBE', 'writeIntLE', 'writeIntBE']) {
        same(`${w}(${v}, 0, ${n})`, (Buf) => {
          const b = Buf.alloc(8);
          return [
            (b as unknown as Record<string, (v: number, o: number, n: number) => number>)[w]!(
              v,
              0,
              n,
            ),
            b,
          ];
        });
      }
    }
  });

  it('swaps and misc', () => {
    same('swap16', (Buf) => Buf.from([1, 2, 3, 4]).swap16());
    same('swap32', (Buf) => Buf.from([1, 2, 3, 4, 5, 6, 7, 8]).swap32());
    same('swap64', (Buf) => Buf.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64());
    same('swap16 odd', (Buf) => Buf.from([1, 2, 3]).swap16());
    same('constructor identity', (Buf) => [
      Buf.from('a').constructor === Buf,
      Buf.from('a') instanceof Buf,
      Buf.from('a') instanceof Uint8Array,
    ]);
    same('legacy call', (Buf) => [
      (Buf as unknown as (s: string) => Uint8Array)('abc'),
      new (Buf as unknown as new (n: number) => Uint8Array)(3),
    ]);
    same('map keeps Buffer', (Buf) => Buf.from([1, 2]).map((x) => x * 2));
    same('iteration', (Buf) => [...Buf.from('ab').entries()]);
    same('poolSize', (Buf) => Buf.poolSize);
  });
});
