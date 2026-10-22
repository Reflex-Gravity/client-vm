// SPDX-License-Identifier: Apache-2.0
// Rewrites a static ES module as CommonJS. The CommonJS loader uses it for
// require() of an ES module (ESM itself loads asynchronously, through the
// service worker), and stand-in installs (ADR 0013) use it on helper
// packages that ship only as ESM.
//
// Covered: import clauses, export-from (named, `*`, `* as`), `export { a as b }`,
// `export default`, and `export function|class|const|let|var name`. Exports
// are getters, so local bindings stay live; imports are bound when the module
// starts, so a cycle sees what its peer had exported so far. `import.meta`
// becomes { url, filename, dirname } of the file. `export const a = 1, b = 2`
// exports both. Anything else (a destructuring declarator after `export`) throws.

import { analyzeEsm, stringValue, tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';

const DECLARATIONS = new Set(['function', 'class', 'const', 'let', 'var', 'async']);

const getter = (name: string, expr: string) =>
  `Object.defineProperty(exports, ${JSON.stringify(name)}, { enumerable: true, get: function () { return ${expr}; } });`;

/** Converts `source` (an ES module) to CommonJS source with the same line numbers. */
export function esmToCjs(source: string): string {
  const tokens = tokenize(source);
  const analysis = analyzeEsm(source, tokens);
  /** [start, end, replacement]; statements are blanked to spaces, keeping newlines. */
  const edits: [number, number, string][] = [];
  for (const [start, end] of analysis.importMetas) edits.push([start, end, '__esm_meta']);
  const blank = (start: number, end: number) =>
    edits.push([start, end, source.slice(start, end).replace(/[^\n]/g, ' ')]);
  const exportGetters: string[] = [];
  const requires: string[] = [];
  const reexports: string[] = [];
  let n = 0;

  for (const imp of analysis.imports) {
    const spec = JSON.stringify(stringValue(imp.specifier));
    blank(imp.statementStart, imp.statementEnd);
    if (imp.sideEffectOnly) {
      requires.push(`require(${spec});`);
      continue;
    }
    const id = `__esm_r${n++}`;
    requires.push(`var ${id} = require(${spec});`);
    for (const { imported, local } of imp.names) {
      if (imp.kind === 'import') {
        if (imported === '*') requires.push(`var ${local} = ${id};`);
        else if (imported === 'default')
          requires.push(`var ${local} = ${id} && ${id}.__esModule ? ${id}.default : ${id};`);
        else requires.push(`var ${local} = ${id}[${JSON.stringify(imported)}];`);
      } else if (imported === '*' && local === '') {
        reexports.push(
          `Object.keys(${id}).forEach(function (k) { if (k === "default" || k === "__esModule" || Object.prototype.hasOwnProperty.call(exports, k)) return; Object.defineProperty(exports, k, { enumerable: true, get: function () { return ${id}[k]; } }); });`,
        );
      } else {
        reexports.push(getter(local, imported === '*' ? id : `${id}[${JSON.stringify(imported)}]`));
      }
    }
  }

  const handled = new Set(analysis.imports.map((i) => i.statementStart));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== 'id' || t.text !== 'export' || handled.has(t.start)) continue;
    const prev = tokens[i - 1];
    if (prev?.type === 'punct' && (prev.text === '.' || prev.text === '?.')) continue;
    const next = tokens[i + 1];
    // A property key (`{ export: 1 }`) or method (`export() {}`), not a statement.
    if (!next || (next.type === 'punct' && (next.text === ':' || next.text === '('))) continue;
    if (next.text === '{') {
      // export { a, b as c };
      let k = i + 2;
      for (; k < tokens.length && tokens[k]!.text !== '}'; k++) {
        const name = tokens[k]!;
        if (name.text === ',') continue;
        let exported = name.text;
        if (tokens[k + 1]?.text === 'as') {
          const alias = tokens[k + 2]!;
          exported = alias.type === 'str' ? stringValue(alias) : alias.text;
          k += 2;
        }
        exportGetters.push(getter(exported, name.text));
      }
      const end = tokens[k + 1]?.text === ';' ? tokens[k + 1]!.end : tokens[k]!.end;
      blank(t.start, end);
      i = k;
      continue;
    }
    if (next.type === 'id' && next.text === 'default') {
      let k = i + 2;
      if (tokens[k]?.text === 'async') k++;
      const kind = tokens[k];
      if (kind?.text === 'function' && tokens[k + 1]?.text === '*') k++;
      const name =
        kind && (kind.text === 'function' || kind.text === 'class') ? tokens[k + 1] : undefined;
      if (name?.type === 'id') {
        // A named declaration stays a hoisted declaration.
        blank(t.start, next.end);
        exportGetters.push(getter('default', name.text));
      } else {
        // `export default <expression>` (or an anonymous function or class).
        edits.push([t.start, next.end, 'var __esm_default =']);
        exportGetters.push(getter('default', '__esm_default'));
      }
      continue;
    }
    if (next.type === 'id' && DECLARATIONS.has(next.text)) {
      let k = i + 1;
      if (tokens[k]!.text === 'async') k++;
      if (tokens[k]!.text === 'function' && tokens[k + 1]?.text === '*') k++;
      const name: Token | undefined = tokens[k + 1];
      if (name?.type !== 'id') throw new Error(`unsupported export at offset ${t.start}`);
      const names = ['const', 'let', 'var'].includes(tokens[k]!.text)
        ? [name.text, ...moreDeclarators(source, tokens, k + 2)]
        : [name.text];
      blank(t.start, t.end);
      for (const n of names) exportGetters.push(getter(n, n));
      continue;
    }
    throw new Error(`unsupported export at offset ${t.start}`);
  }

  let out = source;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  // Getters first, so a cycle that reaches this module mid-way sees its names.
  const header = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    ...exportGetters,
    ...(analysis.importMetas.length > 0
      ? [
          'var __esm_meta = { url: require("url").pathToFileURL(__filename).href, filename: __filename, dirname: __dirname };',
        ]
      : []),
    ...requires,
    ...reexports,
  ].join(' ');
  return `${header}${out}`;
}

/** Keywords that start a statement: one on a new line ends a declaration without `;` (ASI). */
const STATEMENT_START = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'export',
  'import',
  'if',
  'for',
  'while',
  'do',
  'return',
  'throw',
  'try',
  'switch',
]);

/**
 * The names of a `const`/`let`/`var` declaration's declarators after the
 * first, from token `k` (just after the first name). Throws for a
 * destructuring declarator.
 */
function moreDeclarators(source: string, tokens: Token[], k: number): string[] {
  const names: string[] = [];
  let depth = 0;
  for (; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (
      depth === 0 &&
      t.type === 'id' &&
      STATEMENT_START.has(t.text) &&
      source.slice(tokens[k - 1]!.end, t.start).includes('\n')
    )
      return names;
    if (t.type !== 'punct') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
    else if (depth === 0 && t.text === ';') return names;
    else if (depth === 0 && t.text === ',') {
      const next = tokens[k + 1];
      if (next?.type !== 'id')
        throw new Error(`unsupported export (destructuring declarator) at offset ${t.start}`);
      names.push(next.text);
    }
    if (depth < 0) return names;
  }
  return names;
}
