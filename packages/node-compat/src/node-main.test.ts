// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseNodeArgs } from './node-main.ts';

describe('parseNodeArgs', () => {
  it.each([
    [['-e', 'x', 'a'], { kind: 'eval', code: 'x', print: false, rest: ['a'] }],
    [['--eval', 'x'], { kind: 'eval', code: 'x', print: false, rest: [] }],
    [['--eval=x=1'], { kind: 'eval', code: 'x=1', print: false, rest: [] }],
    [['-p', '1+1'], { kind: 'eval', code: '1+1', print: true, rest: [] }],
    [['-pe', '1+1'], { kind: 'eval', code: '1+1', print: true, rest: [] }],
    [['-p', '-e', '2'], { kind: 'eval', code: '2', print: true, rest: [] }],
    [['app.js', '--flag'], { kind: 'script', script: 'app.js', rest: ['--flag'] }],
    [['--', '-weird.js'], { kind: 'script', script: '-weird.js', rest: [] }],
  ])('parses %j', (args, expected) => {
    expect(parseNodeArgs(args)).toEqual(expected);
  });

  it.each([[[]], [['-e']], [['--inspect']]])('rejects %j', (args) => {
    expect(parseNodeArgs(args).kind).toBe('error');
  });
});
