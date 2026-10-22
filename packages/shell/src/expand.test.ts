// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ArithError, evaluateArith } from './arith.ts';
import { matchPattern, replacePattern, trimPattern } from './pattern.ts';
import { posixToJs } from './commands/regex.ts';
import { braceExpand } from './shell.ts';
import { parse } from './parser.ts';
import type { SimpleCommand } from './ast.ts';

const scope = (vars: Record<string, string> = {}) => ({
  get: (n: string) => vars[n],
  set: (n: string, v: string) => {
    vars[n] = v;
  },
});

describe('arithmetic', () => {
  it('uses 64-bit wrapping integers', () => {
    expect(evaluateArith('9223372036854775807 + 1', scope())).toBe(-9223372036854775808n);
    expect(evaluateArith('-7 / 2', scope())).toBe(-3n);
    expect(evaluateArith('2 ** 62 * 4', scope())).toBe(0n);
  });

  it('evaluates variables recursively and assigns', () => {
    const vars: Record<string, string> = { a: 'b + 1', b: '2' };
    expect(evaluateArith('a * 3', scope(vars))).toBe(9n);
    expect(evaluateArith('c = 5, c += 2, c++', scope(vars))).toBe(7n);
    expect(vars['c']).toBe('8');
  });

  it('short-circuits without side effects', () => {
    const vars: Record<string, string> = {};
    evaluateArith('0 && (x = 1)', scope(vars));
    evaluateArith('1 || (y = 1)', scope(vars));
    evaluateArith('1 ? 2 : (z = 1)', scope(vars));
    expect(vars).toEqual({});
  });

  it('reports errors with bash wording', () => {
    expect(() => evaluateArith('1/0', scope())).toThrow(/division by 0 \(error token is "0"\)/);
    expect(() => evaluateArith('1 +', scope())).toThrow(ArithError);
    expect(() => evaluateArith('08', scope())).toThrow(/value too great for base/);
  });
});

describe('patterns', () => {
  it('matches globs', () => {
    expect(matchPattern('*.js', 'a.js')).toBe(true);
    expect(matchPattern('*.js', 'a.ts')).toBe(false);
    expect(matchPattern('[!a]?', 'bc')).toBe(true);
    expect(matchPattern('[[:digit:]]*', '9z')).toBe(true);
    expect(matchPattern('\\*', '*')).toBe(true);
    expect(matchPattern('\\*', 'x')).toBe(false);
  });

  it('trims and replaces', () => {
    expect(trimPattern('a/b/c', '*/', 'start', false)).toBe('b/c');
    expect(trimPattern('a/b/c', '*/', 'start', true)).toBe('c');
    expect(trimPattern('x.tar.gz', '.*', 'end', false)).toBe('x.tar');
    expect(trimPattern('x.tar.gz', '.*', 'end', true)).toBe('x');
    expect(replacePattern('aXbXc', 'X', '-', true, null)).toBe('a-b-c');
    expect(replacePattern('abc', 'b*', '', false, null)).toBe('a');
  });
});

describe('POSIX regex translation', () => {
  it.each([
    ['a\\(b\\)*\\{2\\}', false, 'a(b)*{2}'],
    ['a(b)+|c', false, 'a\\(b\\)\\+\\|c'],
    ['a(b)+|c', true, 'a(b)+|c'],
    ['*a', false, '\\*a'],
    ['[]a.]', false, '[\\]a\\.]'],
    ['[[:alpha:]_]', true, '[a-zA-Z_]'],
    ['x\\.y', true, 'x\\.y'],
    ['a$b', false, 'a\\$b'],
  ])('%s (ERE %s)', (src, ere, want) => {
    expect(posixToJs(src, ere).replaceAll('[\\s\\S]', '.')).toBe(want);
  });
});

describe('brace expansion', () => {
  const expand = (src: string) =>
    braceExpand(
      (parse(`echo ${src}`).items[0]!.cmd.first.commands[0] as SimpleCommand).words[1]!,
    ).map((w) => w.parts.map((p) => (p.t === 'lit' || p.t === 'sq' ? p.v : `<${p.t}>`)).join(''));
  it('expands lists, sequences and nesting', () => {
    expect(expand('a{b,c}d')).toEqual(['abd', 'acd']);
    expect(expand('{1..3}')).toEqual(['1', '2', '3']);
    expect(expand('{03..1}')).toEqual(['03', '02', '01']);
    expect(expand('{a..e..2}')).toEqual(['a', 'c', 'e']);
    expect(expand('{x,y{1,2}}')).toEqual(['x', 'y1', 'y2']);
    expect(expand('{a,$v}')).toEqual(['a', '<param>']);
  });
  it('leaves non-expressions alone', () => {
    expect(expand('{}')).toEqual(['{}']);
    expect(expand('{a}')).toEqual(['{a}']);
    expect(expand("'{a,b}'")).toEqual(['{a,b}']);
  });
});
