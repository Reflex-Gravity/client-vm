// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { List, SimpleCommand } from './ast.ts';
import { ParseError, ScriptReader, parse } from './parser.ts';

const first = (src: string) => parse(src).items[0]!.cmd.first.commands[0]!;

describe('parse', () => {
  it('splits words, assignments and redirects', () => {
    const cmd = first('A=1 B+=x echo "a b" c 2>&1 >out <in') as SimpleCommand;
    expect(cmd.type).toBe('simple');
    expect(cmd.assigns.map((a) => [a.name, a.append])).toEqual([
      ['A', false],
      ['B', true],
    ]);
    expect(cmd.words).toHaveLength(3);
    expect(cmd.redirects.map((r) => [r.fd, r.op])).toEqual([
      [2, '>&'],
      [null, '>'],
      [null, '<'],
    ]);
  });

  it('keeps quoting structure', () => {
    const cmd = first(`echo a'b'"c$x"\\d $'\\t'`) as SimpleCommand;
    expect(cmd.words[1]!.parts).toEqual([
      { t: 'lit', v: 'a' },
      { t: 'sq', v: 'b' },
      {
        t: 'dq',
        parts: [
          { t: 'sq', v: 'c' },
          { t: 'param', name: 'x' },
        ],
      },
      { t: 'sq', v: 'd' },
    ]);
    expect(cmd.words[2]!.parts).toEqual([{ t: 'sq', v: '\t' }]);
  });

  it('parses parameter operators', () => {
    const cmd = first(
      'echo ${a:-x} ${#b} ${c##*/} ${d//x/y} ${e:1:2} ${!f} ${g^^}',
    ) as SimpleCommand;
    const ops = cmd.words.slice(1).map((w) => {
      const p = w.parts[0]!;
      return p.t === 'param'
        ? (p.op?.k ?? (p.length ? 'length' : p.indirect ? 'indirect' : 'none'))
        : p.t;
    });
    expect(ops).toEqual(['default', 'length', 'trim', 'replace', 'substr', 'indirect', 'case']);
  });

  it('parses compound commands', () => {
    const src = [
      'if a; then b; elif c; then d; else e; fi',
      'while a; do b; done',
      'until a; do b; done',
      'for x in 1 2; do b; done',
      'for ((i=0;i<3;i++)); do b; done',
      'case $x in a|b) c;; *) d;& esac',
      '{ a; b; }',
      '(a; b)',
      'f() { a; }',
      'function g { a; }',
      '[[ -n $x && $y == z* ]]',
      '(( x += 2 ))',
    ].join('\n');
    const types = parse(src).items.map((i) => i.cmd.first.commands[0]!.type);
    expect(types).toEqual([
      'if',
      'while',
      'until',
      'for',
      'arith-for',
      'case',
      'group',
      'subshell',
      'function',
      'function',
      'cond',
      'arith-cmd',
    ]);
  });

  it('reads heredocs after the line ends', () => {
    const list = parse('cat <<EOF; echo after\nhello $x\nEOF\ncat <<-"Q"\n\tlit $x\n\tQ\n');
    const r1 = (list.items[0]!.cmd.first.commands[0] as SimpleCommand).redirects[0]!;
    expect(r1.heredoc!.parts).toEqual([
      { t: 'sq', v: 'hello ' },
      { t: 'param', name: 'x' },
      { t: 'sq', v: '\n' },
    ]);
    const r2 = (list.items[2]!.cmd.first.commands[0] as SimpleCommand).redirects[0]!;
    expect(r2.heredoc!.parts).toEqual([{ t: 'sq', v: 'lit $x\n' }]);
  });

  it('nests command substitution, backquotes and arithmetic', () => {
    const cmd = first('echo $(a $(b) `c`) $((1 + $(d)))') as SimpleCommand;
    expect(cmd.words[1]!.parts[0]!.t).toBe('cmd');
    expect(cmd.words[2]!.parts[0]!.t).toBe('arith');
  });

  it('reports bash-style syntax errors', () => {
    const err = (src: string) => {
      try {
        parse(src);
        return null;
      } catch (e) {
        return e instanceof ParseError ? [e.message, e.line, e.incomplete] : e;
      }
    };
    expect(err('if then fi')).toEqual(["syntax error near unexpected token `then'", 1, false]);
    expect(err('echo a\n)')).toEqual(["syntax error near unexpected token `)'", 2, false]);
    expect(err('if true; then')).toEqual(['syntax error: unexpected end of file', 1, true]);
    expect((err('echo "abc') as unknown[])[2]).toBe(true);
  });

  it('reads one complete command at a time', () => {
    const r = new ScriptReader('a; b\nc &\n\nd(\n');
    const lines: List[] = [];
    expect(() => {
      for (let l = r.next(); l; l = r.next()) lines.push(l);
    }).toThrow(ParseError);
    expect(lines.map((l) => l.items.length)).toEqual([2, 1]);
  });
});

describe('parser fuzz', () => {
  // Random shell-flavored input must either parse or fail with a ParseError,
  // never crash or hang.
  const ALPHABET = [
    ' ',
    '\n',
    ';',
    '&',
    '|',
    '(',
    ')',
    '{',
    '}',
    '<',
    '>',
    '$',
    '`',
    "'",
    '"',
    '\\',
    '#',
    '=',
    '*',
    '?',
    '[',
    ']',
    '!',
    '-',
    '~',
    ':',
    '%',
    '/',
    ',',
    '+',
    'a',
    'x',
    '1',
    '0',
    'if',
    'then',
    'fi',
    'do',
    'done',
    'for',
    'in',
    'case',
    'esac',
    'while',
    '[[',
    ']]',
    '((',
    '))',
    '$(',
    '${',
    '<<',
    'EOF',
    '&&',
    '||',
  ];
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  it('never throws anything but ParseError', () => {
    for (let i = 0; i < 3000; i++) {
      let src = '';
      const len = 1 + rand(30);
      for (let j = 0; j < len; j++) src += ALPHABET[rand(ALPHABET.length)];
      try {
        parse(src);
      } catch (e) {
        if (!(e instanceof ParseError)) {
          throw new Error(`${JSON.stringify(src)}: ${String(e)}`, { cause: e });
        }
      }
    }
  });
});
