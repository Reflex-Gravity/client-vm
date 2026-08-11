// SPDX-License-Identifier: Apache-2.0
// Compares the node-compat `path` module with Node's own path.posix.
import { posix } from 'node:path';
import { createPosixPath } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

const ours = createPosixPath(() => process.cwd());

const inputs = [
  '',
  '.',
  '..',
  '/',
  '//',
  '///a',
  'a',
  'a/',
  'a//b',
  '/a/b/c',
  '/a/b/c/',
  'a/./b',
  'a/../b',
  '../a',
  '../../a/b',
  '/..',
  '/../a',
  'a/b/../../..',
  './a',
  '.hidden',
  'file.txt',
  'file.tar.gz',
  '/dir/.env',
  'a.',
  '..a',
  '...',
  '/a/b.c/d',
  'dir/file.js/',
  '/a//b//../c/./d',
];

describe('path differential: node-compat vs node:path.posix', () => {
  for (const fn of [
    'normalize',
    'dirname',
    'basename',
    'extname',
    'isAbsolute',
    'parse',
  ] as const) {
    it(fn, () => {
      for (const input of inputs) {
        expect(
          (ours[fn] as (p: string) => unknown)(input),
          `${fn}(${JSON.stringify(input)})`,
        ).toEqual((posix[fn] as (p: string) => unknown)(input));
      }
    });
  }

  it('basename with suffix', () => {
    for (const [p, s] of [
      ['/a/b.js', '.js'],
      ['b.js', 'b.js'],
      ['/a/b.js/', '.js'],
      ['aaa', 'a'],
    ] as const) {
      expect(ours.basename(p, s)).toBe(posix.basename(p, s));
    }
  });

  it('join / resolve / relative', () => {
    const pairs = inputs.flatMap((a) => inputs.slice(0, 12).map((b) => [a, b] as const));
    for (const [a, b] of pairs) {
      expect(ours.join(a, b), `join(${a}, ${b})`).toBe(posix.join(a, b));
      expect(ours.resolve(a, b), `resolve(${a}, ${b})`).toBe(posix.resolve(a, b));
      expect(ours.relative(a, b), `relative(${a}, ${b})`).toBe(posix.relative(a, b));
    }
  });

  it('format', () => {
    for (const p of [
      { dir: '/a', base: 'b.js' },
      { root: '/', base: 'x' },
      { name: 'n', ext: 'e' },
      { name: 'n', ext: '.e' },
      {},
    ]) {
      expect(ours.format(p)).toBe(posix.format(p));
    }
  });
});
