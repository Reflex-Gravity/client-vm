// SPDX-License-Identifier: Apache-2.0
// Shell arithmetic ($(( )), (( )), let): C-like 64-bit integer expressions
// with bash's operator set and precedence.

export class ArithError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArithError';
  }
}

export interface ArithScope {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

const wrap = (n: bigint) => BigInt.asIntN(64, n);

type Tok = ({ k: 'num'; v: bigint } | { k: 'id'; v: string } | { k: 'op'; v: string }) & {
  start: number;
};

const OPS = [
  '<<=',
  '>>=',
  '**',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '*=',
  '/=',
  '%=',
  '+=',
  '-=',
  '&=',
  '^=',
  '|=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '&',
  '^',
  '|',
  '!',
  '~',
  '?',
  ':',
  '=',
  ',',
  '(',
  ')',
];

function parseNumber(text: string, expr: string): bigint {
  let base = 10;
  let digits = text;
  const hash = text.indexOf('#');
  if (hash > 0) {
    base = Number(text.slice(0, hash));
    digits = text.slice(hash + 1);
    if (!(base >= 2 && base <= 64)) throw new ArithError(`${text}: invalid arithmetic base`);
  } else if (/^0[xX]/.test(text)) {
    base = 16;
    digits = text.slice(2);
  } else if (text.length > 1 && text[0] === '0') {
    base = 8;
    digits = text.slice(1);
  }
  if (digits === '') throw new ArithError(`${expr}: invalid number`);
  let n = 0n;
  for (const ch of digits) {
    let d: number;
    if (ch >= '0' && ch <= '9') d = ch.charCodeAt(0) - 48;
    else if (ch >= 'a' && ch <= 'z') d = ch.charCodeAt(0) - 87;
    else if (ch >= 'A' && ch <= 'Z') d = base <= 36 ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 29;
    else if (ch === '@') d = 62;
    else if (ch === '_') d = 63;
    else d = 99;
    if (d >= base)
      throw new ArithError(`${text}: value too great for base (error token is "${text}")`);
    n = wrap(n * BigInt(base) + BigInt(d));
  }
  return n;
}

function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+#[0-9A-Za-z@_]+|^0[xX][0-9A-Fa-f]*|^[0-9]+[0-9A-Za-z]*/.exec(
        expr.slice(i),
      )!;
      out.push({ k: 'num', v: parseNumber(m[0], expr), start: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i))!;
      out.push({ k: 'id', v: m[0], start: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => expr.startsWith(o, i));
    if (!op) {
      throw new ArithError(
        `${expr}: syntax error: operand expected (error token is "${expr.slice(i)}")`,
      );
    }
    out.push({ k: 'op', v: op, start: i });
    i += op.length;
  }
  return out;
}

const BINARY_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
};

const ASSIGN_OPS = new Set(['=', '*=', '/=', '%=', '+=', '-=', '<<=', '>>=', '&=', '^=', '|=']);

/** Evaluates an arithmetic expression (already parameter-expanded). */
export function evaluateArith(expr: string, scope: ArithScope, depth = 0): bigint {
  if (depth > 32) throw new ArithError(`${expr}: expression recursion level exceeded`);
  const toks = tokenize(expr);
  if (toks.length === 0) return 0n;
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => {
    const t = toks[pos];
    return t !== undefined && t.k === 'op' && t.v === v;
  };
  const errorToken = (at = pos) => {
    const t = toks[at];
    return t ? expr.slice(t.start).trim() : '';
  };
  const syntaxError = (what = 'operand expected') =>
    new ArithError(`${expr}: syntax error: ${what} (error token is "${errorToken()}")`);

  const readVar = (name: string): bigint => {
    const v = scope.get(name);
    if (v === undefined || v === '') return 0n;
    if (/^-?[0-9]+$/.test(v.trim())) return wrap(BigInt(v.trim()));
    return evaluateArith(v, scope, depth + 1);
  };

  const binary = (op: string, a: bigint, b: bigint, at = pos): bigint => {
    switch (op) {
      case '+':
        return wrap(a + b);
      case '-':
        return wrap(a - b);
      case '*':
        return wrap(a * b);
      case '/':
      case '%':
        if (b === 0n)
          throw new ArithError(`${expr}: division by 0 (error token is "${errorToken(at)}")`);
        return wrap(op === '/' ? a / b : a % b);
      case '**':
        if (b < 0n)
          throw new ArithError(
            `${expr}: exponent less than 0 (error token is "${errorToken(at)}")`,
          );
        return wrap(a ** b);
      case '<<':
        return wrap(a << (b & 63n));
      case '>>':
        return wrap(a >> (b & 63n));
      case '<':
        return a < b ? 1n : 0n;
      case '>':
        return a > b ? 1n : 0n;
      case '<=':
        return a <= b ? 1n : 0n;
      case '>=':
        return a >= b ? 1n : 0n;
      case '==':
        return a === b ? 1n : 0n;
      case '!=':
        return a !== b ? 1n : 0n;
      case '&':
        return wrap(a & b);
      case '^':
        return wrap(a ^ b);
      case '|':
        return wrap(a | b);
    }
    throw syntaxError();
  };

  // skip: evaluate without side effects (the untaken side of && || ?:).
  const comma = (skip: boolean): bigint => {
    let v = assignment(skip);
    while (isOp(',')) {
      pos++;
      v = assignment(skip);
    }
    return v;
  };

  const assignment = (skip: boolean): bigint => {
    const t = peek();
    const next = toks[pos + 1];
    if (t?.k === 'id' && next?.k === 'op' && ASSIGN_OPS.has(next.v)) {
      pos += 2;
      const rhs = assignment(skip);
      if (skip) return rhs;
      const value = next.v === '=' ? rhs : binary(next.v.slice(0, -1), readVar(t.v), rhs);
      scope.set(t.v, String(value));
      return value;
    }
    return ternary(skip);
  };

  const ternary = (skip: boolean): bigint => {
    const cond = binaryExpr(1, skip);
    if (!isOp('?')) return cond;
    pos++;
    const a = assignment(skip || cond === 0n);
    if (!isOp(':')) throw syntaxError("expected `:'");
    pos++;
    const b = assignment(skip || cond !== 0n);
    return cond !== 0n ? a : b;
  };

  const binaryExpr = (minPrec: number, skip: boolean): bigint => {
    let left = unary(skip);
    for (;;) {
      const t = peek();
      if (!t || t.k !== 'op') break;
      const prec = BINARY_PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      pos++;
      if (t.v === '&&') {
        const right = binaryExpr(prec + 1, skip || left === 0n);
        left = left !== 0n && right !== 0n ? 1n : 0n;
        continue;
      }
      if (t.v === '||') {
        const right = binaryExpr(prec + 1, skip || left !== 0n);
        left = left !== 0n || right !== 0n ? 1n : 0n;
        continue;
      }
      // ** is right-associative.
      const at = pos;
      const right = binaryExpr(t.v === '**' ? prec : prec + 1, skip);
      left =
        skip && (t.v === '/' || t.v === '%') && right === 0n ? 0n : binary(t.v, left, right, at);
    }
    return left;
  };

  const unary = (skip: boolean): bigint => {
    const t = peek();
    if (!t) throw syntaxError();
    if (t.k === 'op') {
      switch (t.v) {
        case '-':
          pos++;
          return wrap(-unary(skip));
        case '+':
          pos++;
          return unary(skip);
        case '!':
          pos++;
          return unary(skip) === 0n ? 1n : 0n;
        case '~':
          pos++;
          return wrap(~unary(skip));
        case '++':
        case '--': {
          pos++;
          const id = peek();
          if (id?.k !== 'id') throw syntaxError();
          pos++;
          const v = wrap(readVar(id.v) + (t.v === '++' ? 1n : -1n));
          if (!skip) scope.set(id.v, String(v));
          return v;
        }
      }
    }
    return postfix(skip);
  };

  const postfix = (skip: boolean): bigint => {
    const t = peek();
    if (
      t?.k === 'id' &&
      toks[pos + 1]?.k === 'op' &&
      (isOpAt(pos + 1, '++') || isOpAt(pos + 1, '--'))
    ) {
      pos += 2;
      const old = readVar(t.v);
      if (!skip) scope.set(t.v, String(wrap(old + (isOpAt(pos - 1, '++') ? 1n : -1n))));
      return old;
    }
    return primary(skip);
  };

  const isOpAt = (i: number, v: string) => {
    const t = toks[i];
    return t !== undefined && t.k === 'op' && t.v === v;
  };

  const primary = (skip: boolean): bigint => {
    const t = peek();
    if (!t) throw syntaxError();
    if (t.k === 'num') {
      pos++;
      return t.v;
    }
    if (t.k === 'id') {
      pos++;
      return readVar(t.v);
    }
    if (t.v === '(') {
      pos++;
      const v = comma(skip);
      if (!isOp(')')) throw syntaxError("missing `)'");
      pos++;
      return v;
    }
    throw syntaxError();
  };

  const result = comma(false);
  if (pos < toks.length) throw syntaxError('invalid arithmetic operator');
  return result;
}
