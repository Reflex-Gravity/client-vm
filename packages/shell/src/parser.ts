// SPDX-License-Identifier: Apache-2.0
// Recursive-descent parser for the POSIX shell grammar plus the bash
// extensions agents commonly write ([[ ]], (( )), $'...', <<<, `function`,
// ${x//a/b}, ${x:1:2}, <(cmd)). Lexing is driven by the parser because shell
// tokens depend on context (heredocs, reserved words, command substitution).

import type {
  Assignment,
  Case,
  CaseItem,
  Command,
  CondExpr,
  ArithFor,
  For,
  FunctionDef,
  If,
  List,
  ParamOp,
  ParamPart,
  Pipeline,
  Redirect,
  RedirectOp,
  SimpleCommand,
  Word,
  WordPart,
} from './ast.ts';

export class ParseError extends Error {
  readonly line: number;
  /** True when the input ended inside a construct (more input could complete it). */
  readonly incomplete: boolean;
  constructor(message: string, line: number, incomplete = false) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.incomplete = incomplete;
  }
}

type Token =
  | { k: 'word'; word: Word; plain: string | null; line: number }
  | { k: 'op'; v: string; line: number }
  | { k: 'io'; fd: number; line: number }
  | { k: 'arith'; expr: Word; line: number }
  | { k: 'nl'; line: number }
  | { k: 'eof'; line: number };

const OPERATORS = [
  ';;&',
  '<<<',
  '<<-',
  '&>>',
  '&&',
  '||',
  ';;',
  ';&',
  '|&',
  '<<',
  '<&',
  '<>',
  '>>',
  '>&',
  '>|',
  '&>',
  '|',
  '&',
  ';',
  '(',
  ')',
  '<',
  '>',
];
const REDIRECT_OPS = new Set<string>([
  '<',
  '>',
  '>>',
  '>|',
  '<>',
  '<&',
  '>&',
  '&>',
  '&>>',
  '<<',
  '<<-',
  '<<<',
]);
const METACHARS = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')']);
const LIST_END_WORDS = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}']);
const COND_UNARY = new Set([
  '-a',
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-p',
  '-r',
  '-s',
  '-t',
  '-u',
  '-w',
  '-x',
  '-G',
  '-L',
  '-N',
  '-O',
  '-S',
  '-z',
  '-n',
  '-o',
  '-v',
  '-R',
]);
const COND_BINARY = new Set([
  '==',
  '=',
  '!=',
  '=~',
  '<',
  '>',
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
  '-nt',
  '-ot',
  '-ef',
]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;

/** Parses a complete script. Throws {@link ParseError}. */
export function parse(src: string, firstLine = 1): List {
  const p = new Parser(src, firstLine);
  const list = p.parseList();
  const tok = p.peek();
  if (tok.k !== 'eof') throw p.unexpected(tok);
  return list;
}

/**
 * Reads a script one complete command (line) at a time, the way bash
 * executes scripts: commands before a syntax error still run.
 */
export class ScriptReader {
  private readonly parser: Parser;
  constructor(src: string, firstLine = 1) {
    this.parser = new Parser(src, firstLine);
  }
  /** The next complete command, or null at end of input. Throws {@link ParseError}. */
  next(): List | null {
    return this.parser.parseLine();
  }
}

/** Parses the body of a heredoc or other double-quote-like text (`$`, `` ` `` and `\` are special). */
export function parseExpandable(src: string, line = 1): Word {
  const p = new Parser(src, line);
  return { parts: p.readParts('heredoc') };
}

interface PendingHeredoc {
  redirect: Redirect;
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

type PartsMode = 'word' | 'dq' | 'heredoc' | 'param' | 'param-dq' | 'arith' | 'regex';

class Parser {
  private readonly src: string;
  private pos = 0;
  private line: number;
  private peeked: Token | null = null;
  private pendingHeredocs: PendingHeredoc[] = [];
  /** Stop characters for `param` mode (e.g. `}` or `/`). */
  private paramStops = '}';

  constructor(src: string, line: number) {
    this.src = src;
    this.line = line;
  }

  // ---------------------------------------------------------------- tokens

  peek(): Token {
    return (this.peeked ??= this.lex());
  }

  next(): Token {
    const t = this.peek();
    this.peeked = null;
    return t;
  }

  unexpected(tok: Token): ParseError {
    if (tok.k === 'eof')
      return new ParseError('syntax error: unexpected end of file', tok.line, true);
    const text =
      tok.k === 'nl'
        ? 'newline'
        : tok.k === 'op'
          ? tok.v
          : tok.k === 'word'
            ? (tok.plain ?? 'word')
            : tok.k === 'io'
              ? String(tok.fd)
              : '((';
    return new ParseError(`syntax error near unexpected token \`${text}'`, tok.line);
  }

  private lex(): Token {
    const src = this.src;
    for (;;) {
      const c = src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') this.pos++;
      else if (c === '\\' && src[this.pos + 1] === '\n') {
        this.pos += 2;
        this.line++;
      } else if (c === '#') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++;
      } else break;
    }
    const line = this.line;
    if (this.pos >= src.length) {
      if (this.pendingHeredocs.length > 0) this.readHeredocs();
      return { k: 'eof', line };
    }
    const c = src[this.pos]!;
    if (c === '\n') {
      this.pos++;
      this.line++;
      this.readHeredocs();
      return { k: 'nl', line };
    }
    if (c === '(' && src[this.pos + 1] === '(') {
      const end = this.scanArith(this.pos + 2);
      if (end >= 0) {
        const text = src.slice(this.pos + 2, end);
        this.pos = end + 2;
        return { k: 'arith', expr: this.subWord(text, 'arith', line), line };
      }
    }
    if ((c === '<' || c === '>') && src[this.pos + 1] === '(') return this.lexWord(line);
    for (const op of OPERATORS) {
      if (src.startsWith(op, this.pos)) {
        this.pos += op.length;
        return { k: 'op', v: op, line };
      }
    }
    const io = /^\d+(?=[<>])/.exec(src.slice(this.pos, this.pos + 12));
    if (io) {
      this.pos += io[0].length;
      return { k: 'io', fd: Number(io[0]), line };
    }
    return this.lexWord(line);
  }

  private lexWord(line: number): Token {
    const start = this.pos;
    const parts = this.readParts('word');
    if (this.pos === start) {
      throw new ParseError(`syntax error near unexpected token \`${this.src[this.pos]}'`, line);
    }
    const word = { parts };
    return { k: 'word', word, plain: plainText(word), line };
  }

  /** Finds the `))` closing an arithmetic expression starting at `i`, or -1. */
  private scanArith(i: number): number {
    const src = this.src;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === "'" || c === '"') {
        const close = src.indexOf(c, i + 1);
        if (close < 0) return -1;
        i = close;
      } else if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) return src[i + 1] === ')' ? i : -1;
        depth--;
      } else if (c === '\n' && depth === 0) {
        // Arithmetic rarely spans lines; treat as nested subshells instead.
        return -1;
      }
    }
    return -1;
  }

  private subWord(text: string, mode: PartsMode, line: number): Word {
    const p = new Parser(text, line);
    return { parts: p.readParts(mode) };
  }

  // ----------------------------------------------------------------- words

  /**
   * Reads word parts at the current position until the mode's terminator.
   * `word`: stops at unquoted metacharacters. `dq`: stops at `"`. `heredoc`
   * and `arith`: run to the end of input. `param`: stops at `paramStops`.
   */
  readParts(mode: PartsMode): WordPart[] {
    const src = this.src;
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit)
        parts.push({
          t: mode === 'word' || mode === 'param' || mode === 'regex' ? 'lit' : 'sq',
          v: lit,
        });
      lit = '';
    };
    const quotedMode = mode === 'dq' || mode === 'heredoc' || mode === 'param-dq';
    let braceDepth = 0;
    let parenDepth = 0;
    while (this.pos < src.length) {
      const c = src[this.pos]!;
      if (mode === 'word' && METACHARS.has(c)) {
        if ((c === '<' || c === '>') && src[this.pos + 1] === '(' && parts.length === 0 && !lit) {
          this.pos += 2;
          parts.push({ t: 'procsub', body: this.parseNested(')') });
          continue;
        }
        break;
      }
      if (mode === 'regex') {
        if (c === '(') parenDepth++;
        else if (c === ')') {
          if (parenDepth === 0) break;
          parenDepth--;
        } else if ((c === ' ' || c === '\t' || c === '\n') && parenDepth === 0) break;
        else if ((c === '&' || c === '|') && parenDepth === 0 && src[this.pos + 1] === c) break;
      }
      if (mode === 'dq' && c === '"') break;
      if (mode === 'param' || mode === 'param-dq') {
        if (c === '}' && braceDepth === 0) break;
        if (this.paramStops.includes(c) && braceDepth === 0) break;
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
      if (c === '\\') {
        const n = src[this.pos + 1];
        if (n === undefined) {
          lit += c;
          this.pos++;
          continue;
        }
        if (n === '\n') {
          this.pos += 2;
          this.line++;
          continue;
        }
        if (quotedMode || mode === 'arith') {
          // Inside double quotes a backslash only escapes $ ` " \ (and } in ${}).
          const escapable =
            n === '$' ||
            n === '`' ||
            n === '\\' ||
            (n === '"' && mode !== 'heredoc') ||
            (n === '}' && mode === 'param-dq');
          lit += escapable ? n : c + n;
          this.pos += 2;
          continue;
        }
        flush();
        parts.push({ t: 'sq', v: n });
        this.pos += 2;
        continue;
      }
      if (c === "'" && !quotedMode) {
        const close = src.indexOf("'", this.pos + 1);
        if (close < 0)
          throw new ParseError("unexpected EOF while looking for matching `''", this.line, true);
        flush();
        const v = src.slice(this.pos + 1, close);
        this.countLines(v);
        parts.push({ t: 'sq', v });
        this.pos = close + 1;
        continue;
      }
      if (c === '"' && (!quotedMode || mode === 'param-dq')) {
        flush();
        this.pos++;
        const inner = this.readParts('dq');
        if (src[this.pos] !== '"')
          throw new ParseError('unexpected EOF while looking for matching `"\'', this.line, true);
        this.pos++;
        parts.push({ t: 'dq', parts: inner });
        continue;
      }
      if (c === '`') {
        flush();
        parts.push(this.readBackquote());
        continue;
      }
      if (c === '$') {
        const part = this.readDollar(quotedMode);
        if (part) {
          flush();
          parts.push(part);
          continue;
        }
        lit += '$';
        this.pos++;
        continue;
      }
      if (c === '\n') this.line++;
      lit += c;
      this.pos++;
    }
    flush();
    return parts;
  }

  private countLines(s: string): void {
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) this.line++;
  }

  private readBackquote(): WordPart {
    const src = this.src;
    const startLine = this.line;
    let i = this.pos + 1;
    let body = '';
    for (; i < src.length && src[i] !== '`'; i++) {
      if (src[i] === '\\' && (src[i + 1] === '`' || src[i + 1] === '\\' || src[i + 1] === '$')) {
        body += src[++i];
      } else body += src[i];
    }
    if (i >= src.length)
      throw new ParseError("unexpected EOF while looking for matching ``'", this.line, true);
    this.countLines(src.slice(this.pos, i));
    this.pos = i + 1;
    return { t: 'cmd', body: parse(body, startLine) };
  }

  /** Parses a nested command list up to `close` (for `$(...)` and `<(...)`). */
  private parseNested(close: ')'): List {
    const savedPeek = this.peeked;
    const savedHeredocs = this.pendingHeredocs;
    this.peeked = null;
    this.pendingHeredocs = [];
    const list = this.parseList();
    const tok = this.next();
    if (tok.k !== 'op' || tok.v !== close) throw this.unexpected(tok);
    this.peeked = savedPeek;
    this.pendingHeredocs = savedHeredocs;
    return list;
  }

  /** Reads `$...` at pos. Returns null when the `$` is literal. */
  private readDollar(inDq: boolean): WordPart | null {
    const src = this.src;
    const n = src[this.pos + 1];
    if (n === '(') {
      if (src[this.pos + 2] === '(') {
        const end = this.scanArith(this.pos + 3);
        if (end >= 0) {
          const text = src.slice(this.pos + 3, end);
          const line = this.line;
          this.countLines(text);
          this.pos = end + 2;
          return { t: 'arith', expr: this.subWord(text, 'arith', line) };
        }
      }
      this.pos += 2;
      return { t: 'cmd', body: this.parseNested(')') };
    }
    if (n === '{') {
      this.pos += 2;
      return this.readBraceParam(inDq);
    }
    if (n === "'" && !inDq) {
      const { value, end } = ansiC(src, this.pos + 2);
      this.pos = end;
      return { t: 'sq', v: value };
    }
    if (n === '"' && !inDq) {
      // $"..." (locale translation) is plain double quoting here.
      this.pos++;
      return null;
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(this.pos + 1))!;
      this.pos += 1 + m[0].length;
      return { t: 'param', name: m[0] };
    }
    if (n !== undefined && /[0-9@*#?\-$!]/.test(n)) {
      this.pos += 2;
      return { t: 'param', name: n };
    }
    return null;
  }

  private readBraceParam(inDq: boolean): ParamPart {
    const src = this.src;
    const fail = () => new ParseError('bad substitution', this.line);
    const part: ParamPart = { t: 'param', name: '' };
    if (
      src[this.pos] === '#' &&
      src[this.pos + 1] !== '}' &&
      /[A-Za-z_0-9@*#?$!-]/.test(src[this.pos + 1] ?? '')
    ) {
      part.length = true;
      this.pos++;
    } else if (src[this.pos] === '!' && /[A-Za-z_]/.test(src[this.pos + 1] ?? '')) {
      part.indirect = true;
      this.pos++;
    }
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!0-])/.exec(src.slice(this.pos));
    if (!m) throw fail();
    part.name = m[0];
    this.pos += m[0].length;
    if (src[this.pos] === '}') {
      this.pos++;
      return part;
    }
    if (part.length) throw fail();
    const mode: PartsMode = inDq ? 'param-dq' : 'param';
    const word = (stops = '}'): Word => {
      const saved = this.paramStops;
      this.paramStops = stops;
      const parts = this.readParts(mode);
      this.paramStops = saved;
      return { parts };
    };
    let op: ParamOp;
    const rest = src.slice(this.pos, this.pos + 2);
    if (/^:[-=?+]/.test(rest) || /^[-=?+]/.test(rest)) {
      const colon = rest[0] === ':';
      const ch = colon ? rest[1] : rest[0];
      this.pos += colon ? 2 : 1;
      const k = ch === '-' ? 'default' : ch === '=' ? 'assign' : ch === '?' ? 'error' : 'alt';
      op = { k, colon, word: word() };
    } else if (rest[0] === '#' || rest[0] === '%') {
      const longest = rest[1] === rest[0];
      this.pos += longest ? 2 : 1;
      op = { k: 'trim', from: rest[0] === '#' ? 'start' : 'end', longest, pattern: word() };
    } else if (rest[0] === '/') {
      this.pos++;
      let all = false;
      let anchor: 'start' | 'end' | null = null;
      if (src[this.pos] === '/') {
        all = true;
        this.pos++;
      } else if (src[this.pos] === '#') {
        anchor = 'start';
        this.pos++;
      } else if (src[this.pos] === '%') {
        anchor = 'end';
        this.pos++;
      }
      const pattern = word('}/');
      let replacement: Word | null = null;
      if (src[this.pos] === '/') {
        this.pos++;
        replacement = word();
      }
      op = { k: 'replace', all, anchor, pattern, replacement };
    } else if (rest[0] === ':') {
      this.pos++;
      const offset = word('}:');
      let length: Word | null = null;
      if (src[this.pos] === ':') {
        this.pos++;
        length = word();
      }
      op = { k: 'substr', offset, length };
    } else if (rest[0] === '^' || rest[0] === ',') {
      const all = rest[1] === rest[0];
      this.pos += all ? 2 : 1;
      op = { k: 'case', upper: rest[0] === '^', all };
      // A pattern argument is accepted but ignored (it applies to every character).
      word();
    } else {
      throw fail();
    }
    if (src[this.pos] !== '}') throw fail();
    this.pos++;
    part.op = op;
    return part;
  }

  // ------------------------------------------------------------- heredocs

  private readHeredocs(): void {
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const h of pending) {
      const startLine = this.line;
      let body = '';
      let found = false;
      while (this.pos < this.src.length) {
        let end = this.src.indexOf('\n', this.pos);
        if (end < 0) end = this.src.length;
        let lineText = this.src.slice(this.pos, end);
        this.pos = Math.min(end + 1, this.src.length);
        this.line++;
        if (h.stripTabs) lineText = lineText.replace(/^\t+/, '');
        if (lineText === h.delimiter) {
          found = true;
          break;
        }
        body += lineText + '\n';
      }
      if (!found && this.pos >= this.src.length) {
        // bash warns and uses what it has; so do we.
      }
      h.redirect.heredoc = h.quoted
        ? { parts: [{ t: 'sq', v: body }] }
        : { parts: new Parser(body, startLine).readParts('heredoc') };
    }
  }

  // ---------------------------------------------------------------- lists

  private isListEnd(tok: Token): boolean {
    if (tok.k === 'eof') return true;
    if (tok.k === 'op') return tok.v === ')' || tok.v === ';;' || tok.v === ';&' || tok.v === ';;&';
    if (tok.k === 'word') return tok.plain !== null && LIST_END_WORDS.has(tok.plain);
    return false;
  }

  private skipNewlines(): void {
    while (this.peek().k === 'nl') this.next();
  }

  /** compound_list: and-or lists separated by `;`, `&` or newlines. */
  parseList(): List {
    const list: List = { type: 'list', items: [] };
    this.skipNewlines();
    while (!this.isListEnd(this.peek())) {
      const cmd = this.parseAndOr();
      let background = false;
      const sep = this.peek();
      if (sep.k === 'op' && (sep.v === ';' || sep.v === '&')) {
        this.next();
        background = sep.v === '&';
      } else if (sep.k === 'nl') {
        // handled by skipNewlines below
      } else if (!this.isListEnd(sep)) {
        throw this.unexpected(sep);
      }
      list.items.push({ cmd, background });
      this.skipNewlines();
    }
    return list;
  }

  /** One complete command: and-or lists up to the end of the line. Null at end of input. */
  parseLine(): List | null {
    this.skipNewlines();
    if (this.peek().k === 'eof') return null;
    const list: List = { type: 'list', items: [] };
    for (;;) {
      const t = this.peek();
      if (t.k === 'eof') break;
      if (t.k === 'nl') {
        this.next();
        break;
      }
      if (this.isListEnd(t)) throw this.unexpected(t);
      const cmd = this.parseAndOr();
      let background = false;
      const sep = this.peek();
      if (sep.k === 'op' && (sep.v === ';' || sep.v === '&')) {
        this.next();
        background = sep.v === '&';
      } else if (sep.k !== 'nl' && sep.k !== 'eof') {
        throw this.unexpected(sep);
      }
      list.items.push({ cmd, background });
    }
    return list;
  }

  /** A list that must contain at least one command (bodies of compound commands). */
  private parseBody(): List {
    const list = this.parseList();
    if (list.items.length === 0) throw this.unexpected(this.peek());
    return list;
  }

  private parseAndOr() {
    const first = this.parsePipeline();
    const rest: { op: '&&' | '||'; pipeline: Pipeline }[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op' || (t.v !== '&&' && t.v !== '||')) break;
      this.next();
      this.skipNewlines();
      rest.push({ op: t.v, pipeline: this.parsePipeline() });
    }
    return { type: 'andor' as const, first, rest };
  }

  private parsePipeline(): Pipeline {
    let bang = false;
    let t = this.peek();
    while (t.k === 'word' && t.plain === '!') {
      this.next();
      bang = !bang;
      t = this.peek();
    }
    const commands = [this.parseCommand()];
    const stderrToo: boolean[] = [];
    for (;;) {
      const op = this.peek();
      if (op.k !== 'op' || (op.v !== '|' && op.v !== '|&')) break;
      this.next();
      this.skipNewlines();
      stderrToo.push(op.v === '|&');
      commands.push(this.parseCommand());
    }
    return { type: 'pipeline', bang, commands, stderrToo };
  }

  // ------------------------------------------------------------- commands

  private expectWord(word: string): void {
    const t = this.next();
    if (t.k !== 'word' || t.plain !== word) throw this.unexpected(t);
  }

  private parseRedirects(redirects: Redirect[]): void {
    for (;;) {
      const t = this.peek();
      if (t.k === 'io' || (t.k === 'op' && REDIRECT_OPS.has(t.v)))
        redirects.push(this.parseRedirect());
      else break;
    }
  }

  private parseRedirect(): Redirect {
    let fd: number | null = null;
    let t = this.next();
    if (t.k === 'io') {
      fd = t.fd;
      t = this.next();
    }
    if (t.k !== 'op' || !REDIRECT_OPS.has(t.v)) throw this.unexpected(t);
    const op = t.v as RedirectOp;
    const target = this.next();
    if (target.k !== 'word') throw this.unexpected(target);
    const redirect: Redirect = { fd, op, target: target.word };
    if (op === '<<' || op === '<<-') {
      let delimiter = '';
      let quoted = false;
      for (const part of target.word.parts) {
        if (part.t === 'lit') delimiter += part.v;
        else {
          quoted = true;
          delimiter += partText(part);
        }
      }
      this.pendingHeredocs.push({ redirect, delimiter, quoted, stripTabs: op === '<<-' });
    }
    return redirect;
  }

  private parseCommand(): Command {
    const t = this.peek();
    let cmd: Exclude<Command, SimpleCommand | FunctionDef>;
    if (t.k === 'op' && t.v === '(') {
      this.next();
      const body = this.parseBody();
      const close = this.next();
      if (close.k !== 'op' || close.v !== ')') throw this.unexpected(close);
      cmd = { type: 'subshell', body, redirects: [] };
    } else if (t.k === 'arith') {
      this.next();
      cmd = { type: 'arith-cmd', expr: t.expr, redirects: [], line: t.line };
    } else if (t.k === 'word' && t.plain !== null) {
      switch (t.plain) {
        case '{': {
          this.next();
          const body = this.parseBody();
          this.expectWord('}');
          cmd = { type: 'group', body, redirects: [] };
          break;
        }
        case 'if':
          cmd = this.parseIf();
          break;
        case 'while':
        case 'until': {
          this.next();
          const cond = this.parseBody();
          this.expectWord('do');
          const body = this.parseBody();
          this.expectWord('done');
          cmd = { type: t.plain, cond, body, redirects: [] };
          break;
        }
        case 'for':
          cmd = this.parseFor();
          break;
        case 'case':
          cmd = this.parseCase();
          break;
        case '[[':
          this.next();
          cmd = { type: 'cond', expr: this.parseCondOr(), redirects: [], line: t.line };
          this.expectWord(']]');
          break;
        case 'function':
          return this.parseFunctionKeyword();
        default:
          if (LIST_END_WORDS.has(t.plain) || t.plain === 'in' || t.plain === ']]')
            throw this.unexpected(t);
          return this.parseSimple();
      }
    } else {
      return this.parseSimple();
    }
    this.parseRedirects(cmd.redirects);
    return cmd;
  }

  private parseIf(): If {
    this.next();
    const clauses: { cond: List; body: List }[] = [];
    let elseBody: List | null = null;
    for (;;) {
      const cond = this.parseBody();
      this.expectWord('then');
      const body = this.parseBody();
      clauses.push({ cond, body });
      const t = this.next();
      if (t.k === 'word' && t.plain === 'elif') continue;
      if (t.k === 'word' && t.plain === 'else') {
        elseBody = this.parseBody();
        this.expectWord('fi');
        break;
      }
      if (t.k === 'word' && t.plain === 'fi') break;
      throw this.unexpected(t);
    }
    return { type: 'if', clauses, else: elseBody, redirects: [] };
  }

  private parseFor(): For | ArithFor {
    this.next();
    const t = this.next();
    if (t.k === 'arith') {
      // for (( init; cond; step ))
      const text = flattenArith(t.expr);
      const pieces = text.split(';');
      if (pieces.length !== 3)
        throw new ParseError('syntax error: arithmetic expression required', t.line);
      const w = (s: string): Word | null => (s.trim() ? this.subWord(s, 'arith', t.line) : null);
      const sep = this.peek();
      if (sep.k === 'op' && sep.v === ';') this.next();
      this.skipNewlines();
      const body = this.parseDoGroup();
      return {
        type: 'arith-for',
        init: w(pieces[0]!),
        cond: w(pieces[1]!),
        step: w(pieces[2]!),
        body,
        redirects: [],
      };
    }
    if (t.k !== 'word' || t.plain === null || !NAME_RE.test(t.plain))
      throw new ParseError(
        `\`${t.k === 'word' ? (t.plain ?? '') : ''}': not a valid identifier`,
        t.line,
      );
    const name = t.plain;
    let words: Word[] | null = null;
    this.skipNewlines();
    const n = this.peek();
    if (n.k === 'word' && n.plain === 'in') {
      this.next();
      words = [];
      for (;;) {
        const w = this.peek();
        if (w.k !== 'word') break;
        this.next();
        words.push(w.word);
      }
      const sep = this.next();
      if (!(sep.k === 'nl' || (sep.k === 'op' && sep.v === ';'))) throw this.unexpected(sep);
    } else if (n.k === 'op' && n.v === ';') {
      this.next();
    }
    this.skipNewlines();
    const body = this.parseDoGroup();
    return { type: 'for', name, words, body, redirects: [] };
  }

  private parseDoGroup(): List {
    const t = this.peek();
    if (t.k === 'word' && t.plain === '{') {
      this.next();
      const body = this.parseBody();
      this.expectWord('}');
      return body;
    }
    this.expectWord('do');
    const body = this.parseBody();
    this.expectWord('done');
    return body;
  }

  private parseCase(): Case {
    this.next();
    const subject = this.next();
    if (subject.k !== 'word') throw this.unexpected(subject);
    this.skipNewlines();
    this.expectWord('in');
    this.skipNewlines();
    const items: CaseItem[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === 'word' && t.plain === 'esac') {
        this.next();
        break;
      }
      if (t.k === 'op' && t.v === '(') this.next();
      const patterns: Word[] = [];
      for (;;) {
        const w = this.next();
        if (w.k !== 'word') throw this.unexpected(w);
        patterns.push(w.word);
        const sep = this.next();
        if (sep.k === 'op' && sep.v === '|') continue;
        if (sep.k === 'op' && sep.v === ')') break;
        throw this.unexpected(sep);
      }
      const body = this.parseList();
      const end = this.peek();
      let terminator: CaseItem['terminator'] = ';;';
      if (end.k === 'op' && (end.v === ';;' || end.v === ';&' || end.v === ';;&')) {
        this.next();
        terminator = end.v;
      } else if (!(end.k === 'word' && end.plain === 'esac')) {
        throw this.unexpected(end);
      }
      items.push({ patterns, body, terminator });
      this.skipNewlines();
    }
    return { type: 'case', word: subject.word, items, redirects: [] };
  }

  private parseFunctionKeyword(): Command {
    this.next();
    const t = this.next();
    if (t.k !== 'word' || t.plain === null) throw this.unexpected(t);
    const open = this.peek();
    if (open.k === 'op' && open.v === '(') {
      this.next();
      const close = this.next();
      if (close.k !== 'op' || close.v !== ')') throw this.unexpected(close);
    }
    this.skipNewlines();
    return { type: 'function', name: t.plain, body: this.parseFunctionBody() };
  }

  private parseFunctionBody(): Command {
    const body = this.parseCommand();
    if (body.type === 'simple' || body.type === 'function')
      throw new ParseError('syntax error: function body must be a compound command', this.line);
    return body;
  }

  private parseSimple(): Command {
    const cmd: SimpleCommand = {
      type: 'simple',
      assigns: [],
      words: [],
      redirects: [],
      line: this.peek().line,
    };
    for (;;) {
      const t = this.peek();
      if (t.k === 'io' || (t.k === 'op' && REDIRECT_OPS.has(t.v))) {
        cmd.redirects.push(this.parseRedirect());
        continue;
      }
      if (t.k !== 'word') break;
      this.next();
      if (cmd.words.length === 0) {
        const assign = asAssignment(t.word);
        if (assign) {
          cmd.assigns.push(assign);
          continue;
        }
        // name() compound-command
        const open = this.peek();
        if (
          cmd.assigns.length === 0 &&
          cmd.redirects.length === 0 &&
          t.plain !== null &&
          open.k === 'op' &&
          open.v === '('
        ) {
          this.next();
          const close = this.next();
          if (close.k !== 'op' || close.v !== ')') throw this.unexpected(close);
          this.skipNewlines();
          return { type: 'function', name: t.plain, body: this.parseFunctionBody() };
        }
      }
      cmd.words.push(t.word);
    }
    if (cmd.words.length === 0 && cmd.assigns.length === 0 && cmd.redirects.length === 0)
      throw this.unexpected(this.peek());
    return cmd;
  }

  // ------------------------------------------------------------- [[ ... ]]

  private condWord(): Word {
    const t = this.next();
    if (t.k === 'word') return t.word;
    if (t.k === 'op' && (t.v === '<' || t.v === '>')) return { parts: [{ t: 'lit', v: t.v }] };
    throw this.unexpected(t);
  }

  private parseCondOr(): CondExpr {
    let left = this.parseCondAnd();
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.k !== 'op' || t.v !== '||') return left;
      this.next();
      this.skipNewlines();
      left = { k: 'or', left, right: this.parseCondAnd() };
    }
  }

  private parseCondAnd(): CondExpr {
    let left = this.parseCondNot();
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.k !== 'op' || t.v !== '&&') return left;
      this.next();
      this.skipNewlines();
      left = { k: 'and', left, right: this.parseCondNot() };
    }
  }

  private parseCondNot(): CondExpr {
    this.skipNewlines();
    const t = this.peek();
    if (t.k === 'word' && t.plain === '!') {
      this.next();
      return { k: 'not', expr: this.parseCondNot() };
    }
    if (t.k === 'op' && t.v === '(') {
      this.next();
      const inner = this.parseCondOr();
      const close = this.next();
      if (close.k !== 'op' || close.v !== ')') throw this.unexpected(close);
      return inner;
    }
    const first = this.condWord();
    const firstPlain = plainText(first);
    const n = this.peek();
    if (firstPlain !== null && COND_UNARY.has(firstPlain) && n.k === 'word' && n.plain !== ']]') {
      this.next();
      return { k: 'unary', op: firstPlain, arg: n.word };
    }
    const opText =
      n.k === 'word' ? n.plain : n.k === 'op' && (n.v === '<' || n.v === '>') ? n.v : null;
    if (opText !== null && COND_BINARY.has(opText)) {
      this.next();
      if (opText === '=~') {
        while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') this.pos++;
        const right = { parts: this.readParts('regex') };
        return { k: 'binary', op: opText, left: first, right };
      }
      return { k: 'binary', op: opText, left: first, right: this.condWord() };
    }
    return { k: 'word', word: first };
  }
}

// ------------------------------------------------------------------ helpers

function partText(part: WordPart): string {
  switch (part.t) {
    case 'lit':
    case 'sq':
      return part.v;
    case 'dq':
      return part.parts.map(partText).join('');
    case 'param':
      return `$${part.name}`;
    default:
      return '';
  }
}

/** The word's text when it is entirely unquoted literal text (reserved word check), else null. */
export function plainText(word: Word): string | null {
  if (word.parts.length !== 1) return null;
  const p = word.parts[0]!;
  return p.t === 'lit' ? p.v : null;
}

function flattenArith(word: Word): string {
  return word.parts.map((p) => (p.t === 'lit' || p.t === 'sq' ? p.v : partText(p))).join('');
}

function asAssignment(word: Word): Assignment | null {
  const first = word.parts[0];
  if (!first || first.t !== 'lit') return null;
  const m = ASSIGN_RE.exec(first.v);
  if (!m) return null;
  const restLit = first.v.slice(m[0].length);
  const parts: WordPart[] = restLit ? [{ t: 'lit', v: restLit }] : [];
  parts.push(...word.parts.slice(1));
  return { name: m[1]!, append: m[2] === '+', value: { parts } };
}

/** Decodes `$'...'` starting after the opening quote. */
function ansiC(src: string, i: number): { value: string; end: number } {
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = src[++i];
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'e':
      case 'E':
        out += '\x1b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '\\':
      case "'":
      case '"':
      case '?':
        out += n;
        break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(src.slice(i + 1));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += `\\${n}`;
        break;
      }
      case 'c': {
        const ch = src[++i] ?? '';
        out += String.fromCharCode(ch.toUpperCase().charCodeAt(0) ^ 0x40);
        break;
      }
      default:
        if (n !== undefined && /[0-7]/.test(n)) {
          const m = /^[0-7]{1,3}/.exec(src.slice(i))!;
          out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
          i += m[0].length - 1;
        } else out += `\\${n ?? ''}`;
    }
  }
  throw new ParseError("unexpected EOF while looking for matching `''", 0, true);
}
