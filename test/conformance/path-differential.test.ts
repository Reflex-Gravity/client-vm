// SPDX-License-Identifier: Apache-2.0
// Compares the node-compat `path` module with Node's own path.posix.
import { posix, win32 } from 'node:path';
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

describe('path.win32 matches Node', () => {
  const win = ours.win32 as unknown as typeof win32;
  const winInputs = [
    ...inputs,
    'C:',
    'C:\\',
    'C:/',
    'c:\\a\\b',
    'C:a\\b',
    'C:\\a\\..\\..\\b',
    '\\\\server\\share',
    '\\\\server\\share\\',
    '\\\\server\\share\\dir\\file.txt',
    '//server/share/x',
    '\\\\server',
    '\\\\?\\C:\\x',
    '\\a\\b\\',
    'a\\b\\..\\c',
    'C:\\dir\\file.tar.gz',
    'C:\\.env',
    'C:\\..',
    '\\',
    '/',
    'a/b\\c',
    'D:\\x\\y\\..\\z\\',
    'a:b',
    'x\\C:',
    'x\\..\\C:\\y',
    'a:\\..\\b:',
    'CON',
    'dir\\NUL.txt',
    'a\\b:c\\d',
  ];
  const fns = ['normalize', 'isAbsolute', 'dirname', 'basename', 'extname', 'parse'] as const;
  for (const fn of fns) {
    it(fn, () => {
      for (const p of winInputs) {
        expect([p, (win[fn] as (p: string) => unknown)(p)]).toEqual([
          p,
          (win32[fn] as (p: string) => unknown)(p),
        ]);
      }
    });
  }
  it('basename with suffix, format', () => {
    for (const p of winInputs) {
      for (const ext of ['.txt', 'e', '.gz', 'C:']) {
        expect([p, ext, win.basename(p, ext)]).toEqual([p, ext, win32.basename(p, ext)]);
      }
      const parsed = win32.parse(p);
      expect(win.format(parsed)).toBe(win32.format(parsed));
    }
  });
  it('join, resolve, relative, toNamespacedPath', () => {
    for (const a of winInputs) {
      for (const b of ['x', '..\\y', 'C:\\z', '\\\\s\\h\\q', '', 'D:rel']) {
        expect([a, b, win.join(a, b)]).toEqual([a, b, win32.join(a, b)]);
        expect([a, b, win.resolve('C:\\base', a, b)]).toEqual([
          a,
          b,
          win32.resolve('C:\\base', a, b),
        ]);
        expect([a, b, win.relative(`C:\\r\\${a}`, b ? `C:\\r\\${b}` : 'C:\\')]).toEqual([
          a,
          b,
          win32.relative(`C:\\r\\${a}`, b ? `C:\\r\\${b}` : 'C:\\'),
        ]);
      }
      expect([a, win.toNamespacedPath(`C:\\${a}`)]).toEqual([
        a,
        win32.toNamespacedPath(`C:\\${a}`),
      ]);
    }
  });
  it('cross links', () => {
    expect(ours.win32).toBe((ours.win32 as typeof win32).win32);
    expect((ours.win32 as typeof win32).posix).toBe(ours);
    expect(win.sep).toBe('\\');
    expect(win.delimiter).toBe(';');
  });
});
