// SPDX-License-Identifier: Apache-2.0
// A small syntax highlighter for the demo's editor: comments, strings,
// numbers, keywords and markup tags, enough to read the template files. It
// returns HTML for a <pre>; file contents come from the sandbox, so every
// character outside the spans it adds is escaped.

export type Lang = 'js' | 'json' | 'css' | 'html' | 'text';

const KEYWORDS = new Set(
  (
    'import from export default const let var function return if else for while do ' +
    'switch case break continue new async await class extends try catch finally throw ' +
    'typeof instanceof of in as interface type void delete yield'
  ).split(' '),
);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this']);

// One pass, first match wins: comment, string, number, word, tag.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|(`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$-]*)|(<\/?[A-Za-z][\w.-]*|\/?>)/g;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

export function langOf(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'js';
  if (ext === 'json') return 'json';
  if (ext === 'css') return 'css';
  if (ext === 'html') return 'html';
  return 'text';
}

const span = (cls: string, text: string) => `<span class="tk-${cls}">${escapeHtml(text)}</span>`;

export function highlight(code: string, lang: Lang): string {
  if (lang === 'text') return escapeHtml(code);
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const [text, comment, str, num, word, tag] = m;
    out += escapeHtml(code.slice(last, m.index));
    last = m.index + text.length;
    if (comment !== undefined) {
      // `//` starts a comment only in scripts (in CSS it is part of a URL).
      const isComment = lang === 'js' || !comment.startsWith('//');
      out += isComment ? span('com', text) : escapeHtml(text);
    } else if (str !== undefined) {
      // In JSON, a string followed by a colon is a key.
      const key = lang === 'json' && /^\s*:/.test(code.slice(last));
      out += span(key ? 'key' : 'str', text);
    } else if (num !== undefined) {
      out += span('num', text);
    } else if (word !== undefined) {
      if (lang === 'js' && KEYWORDS.has(word)) out += span('kw', text);
      else if ((lang === 'js' || lang === 'json') && LITERALS.has(word)) out += span('lit', text);
      else out += escapeHtml(text);
    } else if (tag !== undefined && (lang === 'js' || lang === 'html')) {
      out += span('tag', text);
    } else {
      out += escapeHtml(text);
    }
  }
  return out + escapeHtml(code.slice(last));
}
