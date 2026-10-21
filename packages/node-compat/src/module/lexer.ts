// SPDX-License-Identifier: Apache-2.0
// A small JavaScript tokenizer for module analysis: finding import/export
// specifiers (ESM) and CommonJS export names (as Node's cjs-module-lexer does).
// It is not a parser: it only needs to tell code from strings, comments,
// template literals and regular expressions reliably.

export type TokenType = 'id' | 'str' | 'tpl' | 'num' | 'punct' | 'regex' | 'priv';

export interface Token {
  type: TokenType;
  /** Source text of the token (for strings: including quotes). */
  text: string;
  start: number;
  end: number;
}

const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '!',
  '~',
  '?',
  ':',
  '=',
  '.',
  '@',
];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);

function isIdStart(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c === 92 || c > 127
  );
}

function isIdPart(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57) || c === 0x200c || c === 0x200d;
}

/**
 * Tokenizes `source`. Template literals are emitted as one `tpl` token per
 * literal chunk; the expressions inside `${}` are tokenized normally.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let i = 0;
  // For each open `${`, the brace depth at which it closes back into the template.
  const templateStack: number[] = [];
  let braceDepth = 0;

  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (
      prev.type === 'num' ||
      prev.type === 'str' ||
      prev.type === 'tpl' ||
      prev.type === 'regex' ||
      prev.type === 'priv'
    ) {
      return false;
    }
    if (prev.type === 'id') return REGEX_AFTER_KEYWORD.has(prev.text);
    return prev.text !== ')' && prev.text !== ']' && prev.text !== '++' && prev.text !== '--';
  };

  const readTemplateChunk = (start: number): number => {
    // `start` is just after the opening backtick or the closing `}` of an expression.
    let j = start;
    while (j < len) {
      const c = source.charCodeAt(j);
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 96) return j + 1; // closing backtick
      if (c === 36 && source.charCodeAt(j + 1) === 123) {
        templateStack.push(braceDepth);
        braceDepth++;
        return j + 2;
      }
      j++;
    }
    return len;
  };

  while (i < len) {
    const c = source.charCodeAt(i);
    // Whitespace and line terminators.
    if (
      c === 32 ||
      c === 9 ||
      c === 10 ||
      c === 13 ||
      c === 11 ||
      c === 12 ||
      c === 0xa0 ||
      c === 0xfeff ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c > 127 && /\s/.test(source[i]!))
    ) {
      i++;
      continue;
    }
    // Comments.
    if (c === 47 && source.charCodeAt(i + 1) === 47) {
      while (i < len && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 42) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    // Hashbang (only at the very start).
    if (i === 0 && c === 35 && source.charCodeAt(1) === 33) {
      while (i < len && source.charCodeAt(i) !== 10) i++;
      continue;
    }
    const start = i;
    if (isIdStart(c)) {
      i++;
      while (i < len && isIdPart(source.charCodeAt(i))) i++;
      tokens.push({ type: 'id', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === 35 /* # */ && isIdStart(source.charCodeAt(i + 1))) {
      i += 2;
      while (i < len && isIdPart(source.charCodeAt(i))) i++;
      tokens.push({ type: 'priv', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (
      (c >= 48 && c <= 57) ||
      (c === 46 && source.charCodeAt(i + 1) >= 48 && source.charCodeAt(i + 1) <= 57)
    ) {
      i++;
      while (i < len) {
        const d = source.charCodeAt(i);
        if (isIdPart(d) || d === 46) i++;
        else if (
          (d === 43 || d === 45) &&
          /[eE]/.test(source[i - 1]!) &&
          !/^0[xX]/.test(source.slice(start, i))
        )
          i++;
        else break;
      }
      tokens.push({ type: 'num', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === 39 || c === 34) {
      i++;
      while (i < len) {
        const d = source.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === c) {
          i++;
          break;
        } else if (d === 10) break;
        else i++;
      }
      tokens.push({ type: 'str', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === 96) {
      i = readTemplateChunk(i + 1);
      tokens.push({ type: 'tpl', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (
      c === 125 /* } */ &&
      templateStack.length > 0 &&
      templateStack[templateStack.length - 1] === braceDepth - 1
    ) {
      templateStack.pop();
      braceDepth--;
      i = readTemplateChunk(i + 1);
      tokens.push({ type: 'tpl', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === 47 /* / */ && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < len) {
        const d = source.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === 91) {
          inClass = true;
          i++;
        } else if (d === 93) {
          inClass = false;
          i++;
        } else if (d === 47 && !inClass) {
          i++;
          break;
        } else if (d === 10) break;
        else i++;
      }
      while (i < len && isIdPart(source.charCodeAt(i))) i++;
      tokens.push({ type: 'regex', text: source.slice(start, i), start, end: i });
      continue;
    }
    let matched = '';
    for (const p of PUNCTUATORS) {
      if (source.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (!matched) matched = source[i]!;
    // `?.` followed by a digit is a conditional plus a number (a ?.5 : b).
    if (matched === '?.' && /[0-9]/.test(source[i + 2] ?? '')) matched = '?';
    if (matched === '{') braceDepth++;
    else if (matched === '}') braceDepth--;
    i += matched.length;
    tokens.push({ type: 'punct', text: matched, start, end: i });
  }
  return tokens;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** The value of a string literal token, with escapes decoded. */
export function stringValue(token: Token): string {
  const body = token.text.slice(1, -1);
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[++i] ?? '';
    if (next in SIMPLE_ESCAPES && !(next === '0' && /[0-9]/.test(body[i + 1] ?? ''))) {
      out += SIMPLE_ESCAPES[next];
    } else if (next === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u' && body[i + 1] === '{') {
      const close = body.indexOf('}', i);
      out += String.fromCodePoint(parseInt(body.slice(i + 2, close), 16));
      i = close;
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === '\r' || next === '\n' || next === '\u2028' || next === '\u2029') {
      // Line continuation.
      if (next === '\r' && body[i + 1] === '\n') i++;
    } else {
      out += next;
    }
  }
  return out;
}

const isMemberAccess = (tokens: Token[], i: number) => {
  const prev = tokens[i - 1];
  return prev?.type === 'punct' && (prev.text === '.' || prev.text === '?.');
};

// ---------------------------------------------------------------- ESM

/** A name bound by an import clause or listed in an export-from clause. */
export interface ImportedName {
  /** Name in the source module ('default' for default imports, '*' for namespace). */
  imported: string;
  /** Local binding (or exported alias for export-from). */
  local: string;
}

export interface StaticImport {
  kind: 'import' | 'export';
  /** The specifier string token. */
  specifier: Token;
  /** Start of the `import`/`export` keyword. */
  statementStart: number;
  /** End of the statement (after attributes and an optional `;`). */
  statementEnd: number;
  /** Names imported, or re-exported for export-from (`export *` gives `*` with local ''). */
  names: ImportedName[];
  /** For `import 'x'` side-effect imports. */
  sideEffectOnly: boolean;
}

export interface EsmAnalysis {
  imports: StaticImport[];
  /** `import(` call sites: the `import` token. */
  dynamicImports: Token[];
  /** `import.meta` sites: [start, end). */
  importMetas: [number, number][];
  /** Whether the source has static ESM syntax (used for "type"-less .js detection). */
  hasModuleSyntax: boolean;
}

function parseNameList(
  tokens: Token[],
  from: number,
  to: number,
  forExport: boolean,
): ImportedName[] {
  // Tokens between `{` and `}`: entries `a`, `a as b`, `'str' as b`, `default as b`.
  const names: ImportedName[] = [];
  let k = from;
  while (k < to) {
    const t = tokens[k]!;
    if (t.type === 'punct' && t.text === ',') {
      k++;
      continue;
    }
    const name = t.type === 'str' ? stringValue(t) : t.text;
    let local = name;
    if (tokens[k + 1]?.type === 'id' && tokens[k + 1]!.text === 'as' && k + 2 < to) {
      const alias = tokens[k + 2]!;
      local = alias.type === 'str' ? stringValue(alias) : alias.text;
      k += 3;
    } else {
      k++;
    }
    names.push(forExport ? { imported: name, local } : { imported: name, local });
  }
  return names;
}

/** Finds static imports/exports-from, dynamic imports and import.meta in ESM source. */
export function analyzeEsm(source: string, tokens: Token[] = tokenize(source)): EsmAnalysis {
  const imports: StaticImport[] = [];
  const dynamicImports: Token[] = [];
  const importMetas: [number, number][] = [];
  let hasModuleSyntax = false;

  const endOfStatement = (afterSpecifier: number): number => {
    // Skip `with { ... }` / `assert { ... }` attributes and a trailing semicolon.
    let k = afterSpecifier;
    const kw = tokens[k];
    if (
      kw?.type === 'id' &&
      (kw.text === 'with' || kw.text === 'assert') &&
      tokens[k + 1]?.text === '{'
    ) {
      let depth = 0;
      for (k = k + 1; k < tokens.length; k++) {
        if (tokens[k]!.text === '{') depth++;
        else if (tokens[k]!.text === '}' && --depth === 0) {
          k++;
          break;
        }
      }
    }
    if (tokens[k]?.text === ';') k++;
    return k;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== 'id' || isMemberAccess(tokens, i)) continue;

    if (t.text === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'punct' && next.text === '(') {
        // `import(url) { ... }` is a method named import (class or object literal), not a call.
        let depth = 0;
        let k = i + 1;
        for (; k < tokens.length; k++) {
          if (tokens[k]!.text === '(' && tokens[k]!.type === 'punct') depth++;
          else if (tokens[k]!.text === ')' && tokens[k]!.type === 'punct' && --depth === 0) break;
        }
        if (tokens[k + 1]?.type === 'punct' && tokens[k + 1]!.text === '{') continue;
        dynamicImports.push(t);
        continue;
      }
      if (next.type === 'punct' && next.text === '.') {
        const meta = tokens[i + 2];
        if (meta?.type === 'id' && meta.text === 'meta') {
          importMetas.push([t.start, meta.end]);
          hasModuleSyntax = true;
          i += 2;
        }
        continue;
      }
      if (next.type === 'str') {
        const end = endOfStatement(i + 2);
        imports.push({
          kind: 'import',
          specifier: next,
          statementStart: t.start,
          statementEnd: tokens[end - 1]!.end,
          names: [],
          sideEffectOnly: true,
        });
        hasModuleSyntax = true;
        i = end - 1;
        continue;
      }
      // import <clause> from 'x'
      const names: ImportedName[] = [];
      let k = i + 1;
      let ok = false;
      for (; k < tokens.length; k++) {
        const c = tokens[k]!;
        if (c.type === 'id' && c.text === 'from' && tokens[k + 1]?.type === 'str') {
          ok = true;
          break;
        }
        if (c.type === 'punct' && c.text === '{') {
          const close = tokens.findIndex((x, idx) => idx > k && x.text === '}');
          if (close === -1) break;
          names.push(...parseNameList(tokens, k + 1, close, false));
          k = close;
        } else if (c.type === 'punct' && c.text === '*') {
          const alias = tokens[k + 2];
          if (tokens[k + 1]?.text === 'as' && alias)
            names.push({ imported: '*', local: alias.text });
          k += 2;
        } else if (c.type === 'id' && k === i + 1) {
          names.push({ imported: 'default', local: c.text });
        } else if (c.type === 'punct' && c.text === ',') {
          continue;
        } else if (!(c.type === 'id' && k === i + 1)) {
          break;
        }
      }
      if (!ok) continue;
      const spec = tokens[k + 1]!;
      const end = endOfStatement(k + 2);
      imports.push({
        kind: 'import',
        specifier: spec,
        statementStart: t.start,
        statementEnd: tokens[end - 1]!.end,
        names,
        sideEffectOnly: false,
      });
      hasModuleSyntax = true;
      i = end - 1;
      continue;
    }

    if (t.text === 'export') {
      // `export` at statement level is module syntax; `x.export` was excluded above.
      const next = tokens[i + 1];
      if (!next) continue;
      hasModuleSyntax = true;
      let names: ImportedName[] | null = null;
      let k = i + 1;
      if (next.text === '*') {
        if (tokens[k + 1]?.text === 'as') {
          const alias = tokens[k + 2]!;
          names = [
            { imported: '*', local: alias.type === 'str' ? stringValue(alias) : alias.text },
          ];
          k += 3;
        } else {
          names = [{ imported: '*', local: '' }];
          k += 1;
        }
      } else if (next.text === '{') {
        const close = tokens.findIndex((x, idx) => idx > k && x.text === '}');
        if (close === -1) continue;
        names = parseNameList(tokens, k + 1, close, true);
        k = close + 1;
      }
      if (
        names &&
        tokens[k]?.type === 'id' &&
        tokens[k]!.text === 'from' &&
        tokens[k + 1]?.type === 'str'
      ) {
        const spec = tokens[k + 1]!;
        const end = endOfStatement(k + 2);
        imports.push({
          kind: 'export',
          specifier: spec,
          statementStart: t.start,
          statementEnd: tokens[end - 1]!.end,
          names,
          sideEffectOnly: false,
        });
        i = end - 1;
      }
      continue;
    }

    // Top-level await alone also makes a module (Node's syntax detection), but
    // detecting "top-level" needs scope tracking; static import/export suffice in practice.
  }
  return { imports, dynamicImports, importMetas, hasModuleSyntax };
}
