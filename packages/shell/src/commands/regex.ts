// SPDX-License-Identifier: Apache-2.0
// POSIX basic/extended regular expressions (with GNU extensions) translated
// to JavaScript RegExp source. Matching is leftmost-first (JS), not POSIX
// leftmost-longest; the two differ only for some alternations.

const CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

export class RegexSyntaxError extends Error {}

const escapeChar = (c: string) => (/[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c);

/** POSIX bracket expression: backslash is literal inside brackets. */
function bracket(src: string, i: number): { re: string; end: number } {
  let j = i + 1;
  let negate = false;
  if (src[j] === '^') {
    negate = true;
    j++;
  }
  let body = '';
  let first = true;
  for (; j < src.length; j++) {
    const c = src[j]!;
    if (c === ']' && !first) return { re: `[${negate ? '^' : ''}${body}]`, end: j + 1 };
    first = false;
    if (c === '[' && (src[j + 1] === ':' || src[j + 1] === '=' || src[j + 1] === '.')) {
      const kind = src[j + 1]!;
      const close = src.indexOf(`${kind}]`, j + 2);
      if (close > 0) {
        const name = src.slice(j + 2, close);
        if (kind === ':') {
          const cls = CLASSES[name];
          if (cls === undefined) throw new RegexSyntaxError('Invalid character class name');
          body += cls;
        } else body += name.split('').map(escapeChar).join('');
        j = close + 1;
        continue;
      }
    }
    if (c === '-' && body !== '' && src[j + 1] !== ']' && j + 1 < src.length) {
      body += '-';
      continue;
    }
    body += escapeChar(c);
  }
  throw new RegexSyntaxError('Unmatched [, [^, [:, [., or [=');
}

/** Translates a POSIX regex to JS source. `extended` selects ERE. */
export function posixToJs(src: string, extended: boolean): string {
  let out = '';
  let depth = 0;
  // Position where `*` is literal and `^` is an anchor: start, after ( or |.
  let atStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const startHere: boolean = atStart;
    atStart = false;
    if (c === '\\') {
      const n = src[++i];
      if (n === undefined) throw new RegexSyntaxError('Trailing backslash');
      if (
        !extended &&
        (n === '(' || n === ')' || n === '|' || n === '{' || n === '}' || n === '+' || n === '?')
      ) {
        // GNU BRE operators.
        if (n === '(') {
          depth++;
          out += '(';
          atStart = true;
        } else if (n === ')') {
          if (depth === 0) throw new RegexSyntaxError('Unmatched ) or \\)');
          depth--;
          out += ')';
        } else if (n === '|') {
          out += '|';
          atStart = true;
        } else if (n === '{') {
          const close = src.indexOf('\\}', i);
          if (close < 0) throw new RegexSyntaxError('Unmatched \\{');
          out += `{${src.slice(i + 1, close)}}`;
          i = close + 1;
        } else if (n === '}') {
          out += '\\}';
        } else if (startHere) {
          out += `\\${n}`;
        } else out += n;
        continue;
      }
      if (n === '<') out += '(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])';
      else if (n === '>') out += '(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])';
      else if (n === '`') out += '^';
      else if (n === "'") out += '$';
      else if ('wWsSbB'.includes(n)) out += `\\${n}`;
      else if (/[1-9]/.test(n)) out += `\\${n}`;
      else if (n === 'n') out += '\\n';
      else if (n === 't') out += '\\t';
      else out += escapeChar(n);
      continue;
    }
    if (c === '[') {
      const b = bracket(src, i);
      out += b.re;
      i = b.end - 1;
      continue;
    }
    if (c === '*') {
      out += startHere ? '\\*' : '*';
      continue;
    }
    if (c === '^') {
      if (extended || startHere) {
        out += '^';
        atStart = !extended || startHere;
      } else out += '\\^';
      continue;
    }
    if (c === '$') {
      const atEnd =
        extended ||
        i === src.length - 1 ||
        src.startsWith('\\)', i + 1) ||
        src.startsWith('\\|', i + 1);
      out += atEnd ? '$' : '\\$';
      continue;
    }
    if (extended) {
      if (c === '(') {
        depth++;
        out += '(';
        atStart = true;
        continue;
      }
      if (c === ')') {
        if (depth === 0) {
          out += '\\)';
          continue;
        }
        depth--;
        out += ')';
        continue;
      }
      if (c === '|') {
        out += '|';
        atStart = true;
        continue;
      }
      if (c === '+' || c === '?') {
        out += startHere ? `\\${c}` : c;
        continue;
      }
      if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        if (m && !startHere) {
          out += m[0];
          i += m[0].length - 1;
        } else out += '\\{';
        continue;
      }
      if (c === '}') {
        out += '\\}';
        continue;
      }
    }
    // POSIX `.` matches any character, including a newline in sed's pattern space.
    out += c === '.' ? '[\\s\\S]' : escapeChar(c);
  }
  if (depth > 0) throw new RegexSyntaxError(extended ? 'Unmatched ( or \\(' : 'Unmatched ( or \\(');
  return out;
}

export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** Compiles a POSIX regex; throws RegexSyntaxError on invalid syntax. */
export function compilePosix(src: string, extended: boolean, flags = ''): RegExp {
  const js = posixToJs(src, extended);
  try {
    return new RegExp(js, flags);
  } catch (err) {
    throw new RegexSyntaxError(err instanceof Error ? err.message : String(err));
  }
}
