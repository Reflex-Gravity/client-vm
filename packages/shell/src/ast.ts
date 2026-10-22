// SPDX-License-Identifier: Apache-2.0
// Shell syntax tree. Words keep their quoting structure so expansion can
// apply field splitting and globbing only where POSIX says to.

/** One piece of a word. */
export type WordPart =
  /** Unquoted text: subject to tilde, brace and pathname expansion. */
  | { t: 'lit'; v: string }
  /** Quoted text ('...', $'...', or a backslash-escaped character). */
  | { t: 'sq'; v: string }
  | { t: 'dq'; parts: WordPart[] }
  | ParamPart
  | { t: 'cmd'; body: List }
  | { t: 'arith'; expr: Word }
  /** `<(cmd)`: replaced by the path of a file holding the command's output. */
  | { t: 'procsub'; body: List };

export interface ParamPart {
  t: 'param';
  /** Variable name, positional number, or special (`@ * # ? - $ ! 0`). */
  name: string;
  /** `${#name}` */
  length?: boolean;
  /** `${!name}` */
  indirect?: boolean;
  op?: ParamOp;
}

export type ParamOp =
  /** `-` `=` `?` `+`, with `colon` for the `:-` forms. */
  | { k: 'default' | 'assign' | 'error' | 'alt'; colon: boolean; word: Word }
  /** `#` `##` `%` `%%` */
  | { k: 'trim'; from: 'start' | 'end'; longest: boolean; pattern: Word }
  /** `/` `//` `/#` `/%` */
  | {
      k: 'replace';
      all: boolean;
      anchor: 'start' | 'end' | null;
      pattern: Word;
      replacement: Word | null;
    }
  /** `:offset` `:offset:length` (arithmetic) */
  | { k: 'substr'; offset: Word; length: Word | null }
  /** `^` `^^` `,` `,,` */
  | { k: 'case'; upper: boolean; all: boolean };

export interface Word {
  parts: WordPart[];
}

export type RedirectOp =
  '<' | '>' | '>>' | '>|' | '<>' | '<&' | '>&' | '&>' | '&>>' | '<<' | '<<-' | '<<<';

export interface Redirect {
  /** Explicit fd number (`2>`), or null for the operator's default. */
  fd: number | null;
  op: RedirectOp;
  /** Target file, fd number, delimiter (heredocs) or string (`<<<`). */
  target: Word;
  /** Heredoc body, filled in when the lexer reaches the end of the line. */
  heredoc?: Word;
}

export interface Assignment {
  name: string;
  value: Word;
  append: boolean;
}

export interface SimpleCommand {
  type: 'simple';
  assigns: Assignment[];
  words: Word[];
  redirects: Redirect[];
  line: number;
}

export interface Subshell {
  type: 'subshell';
  body: List;
  redirects: Redirect[];
}

export interface Group {
  type: 'group';
  body: List;
  redirects: Redirect[];
}

export interface If {
  type: 'if';
  clauses: { cond: List; body: List }[];
  else: List | null;
  redirects: Redirect[];
}

export interface Loop {
  type: 'while' | 'until';
  cond: List;
  body: List;
  redirects: Redirect[];
}

export interface For {
  type: 'for';
  name: string;
  /** null iterates the positional parameters. */
  words: Word[] | null;
  body: List;
  redirects: Redirect[];
}

/** `for (( init; cond; step ))` */
export interface ArithFor {
  type: 'arith-for';
  init: Word | null;
  cond: Word | null;
  step: Word | null;
  body: List;
  redirects: Redirect[];
}

export interface CaseItem {
  patterns: Word[];
  body: List;
  /** `;;` stop, `;&` fall through, `;;&` test the next patterns. */
  terminator: ';;' | ';&' | ';;&';
}

export interface Case {
  type: 'case';
  word: Word;
  items: CaseItem[];
  redirects: Redirect[];
}

/** `[[ expr ]]` */
export interface Cond {
  type: 'cond';
  expr: CondExpr;
  redirects: Redirect[];
  line: number;
}

export type CondExpr =
  | { k: 'and' | 'or'; left: CondExpr; right: CondExpr }
  | { k: 'not'; expr: CondExpr }
  | { k: 'unary'; op: string; arg: Word }
  | { k: 'binary'; op: string; left: Word; right: Word }
  | { k: 'word'; word: Word };

/** `(( expr ))` */
export interface ArithCommand {
  type: 'arith-cmd';
  expr: Word;
  redirects: Redirect[];
  line: number;
}

export interface FunctionDef {
  type: 'function';
  name: string;
  body: Command;
}

export type Command =
  | SimpleCommand
  | Subshell
  | Group
  | If
  | Loop
  | For
  | ArithFor
  | Case
  | Cond
  | ArithCommand
  | FunctionDef;

export interface Pipeline {
  type: 'pipeline';
  bang: boolean;
  commands: Command[];
  /** Per joint: true for `|&` (stderr joins stdout). */
  stderrToo: boolean[];
}

export interface AndOr {
  type: 'andor';
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
}

export interface List {
  type: 'list';
  items: { cmd: AndOr; background: boolean }[];
}
