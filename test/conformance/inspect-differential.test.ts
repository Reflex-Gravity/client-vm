// SPDX-License-Identifier: Apache-2.0
// Compares the node-compat inspect/format with Node's util, since console output must match Node.
import { format as nodeFormat, inspect as nodeInspect } from 'node:util';
import { format, inspect } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

class Point {
  x = 1;
  y = 2;
}

const values: [string, unknown][] = [
  ['strings', ['plain', "it's", 'say "hi"', `both ' and "`, 'tab\there', 'nl\nhere', '\x01']],
  ['numbers', [0, -0, 1.5, NaN, Infinity, -Infinity, 10n]],
  ['primitives', [null, undefined, true, Symbol('s')]],
  ['empty containers', [[], {}, new Map(), new Set(), new Uint8Array(0)]],
  ['root listing', ['bin', 'etc', 'home', 'tmp', 'usr']],
  ['short number array', [1, 2, 3]],
  ['grouped number array', Array.from({ length: 30 }, (_, i) => i * 7)],
  [
    'grouped string array',
    Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i).repeat((i % 5) + 1)),
  ],
  ['long array', Array.from({ length: 150 }, (_, i) => i)],
  ['sparse array', [1, , , 4]], // eslint-disable-line no-sparse-arrays
  ['object', { a: 1, b: 'two', 'needs-quote': true, nested: { deep: { deeper: { deepest: 1 } } } }],
  [
    'wide object',
    Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, `value number ${i}`])),
  ],
  [
    'map and set',
    [
      new Map<unknown, unknown>([
        ['a', 1],
        [{ k: 1 }, [1, 2]],
      ]),
      new Set([1, 'two', [3]]),
    ],
  ],
  ['typed array', new Uint8Array([1, 2, 3, 250])],
  ['class instance', new Point()],
  ['null prototype', Object.assign(Object.create(null), { a: 1 })],
  ['functions', [function named() {}, () => {}, class Foo {}, async function af() {}]],
  ['date and regexp', [new Date(0), /ab+c/gi]],
  ['array with extra key', Object.assign([1, 2], { extra: true })],
  ['nested arrays', [[1, [2, [3, [4, [5]]]]], { a: [{ b: [{ c: 1 }] }] }]],
];

describe('inspect differential: node-compat vs node:util', () => {
  for (const [name, value] of values) {
    it(name, () => {
      expect(inspect(value)).toBe(nodeInspect(value));
    });
  }

  it('errors with extra properties', () => {
    const err = Object.assign(new Error('boom'), { code: 'E_X', errno: -2 });
    expect(inspect(err)).toBe(nodeInspect(err));
  });

  it('format', () => {
    const cases: unknown[][] = [
      ['plain'],
      ['%s is %d years', 'Bob', 42],
      ['%i %f %j', 3.9, '2.5', { a: 1 }],
      // %o implies showHidden, which inspect does not support yet (see docs/compatibility.md).
      ['%O', { a: [1] }],
      ['100%% done', 'extra'],
      ['%s', { nested: { obj: 1 } }],
      ['%d', 10n],
      [1, 'two', { three: 3 }],
      ['missing %s %s', 'one'],
      ['', 1],
    ];
    for (const args of cases) {
      expect(format(...args), nodeInspect(args)).toBe(nodeFormat(...args));
    }
  });
});
