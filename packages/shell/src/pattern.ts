// SPDX-License-Identifier: Apache-2.0
// Shell pattern matching (fnmatch): `*`, `?`, bracket expressions with
// POSIX classes. Patterns use a backslash to mark a quoted character; the
// expander escapes quoted text that way so it matches literally.

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
  word: 'a-zA-Z0-9_',
};

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g;

export function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL, '\\$&');
}

/** Escapes text so it matches itself as a shell pattern. */
export function escapePattern(s: string): string {
  return s.replace(/[\\*?[\]]/g, '\\$&');
}

/**
 * Parses a bracket expression starting at `pattern[i] === '['`. Returns the
 * regex class and the index after `]`, or null when there is no closing `]`.
 */
export function bracketToRegex(pattern: string, i: number): { re: string; end: number } | null {
  let j = i + 1;
  let negate = false;
  if (pattern[j] === '!' || pattern[j] === '^') {
    negate = true;
    j++;
  }
  let body = '';
  let first = true;
  for (; j < pattern.length; j++) {
    const c = pattern[j]!;
    if (c === ']' && !first) {
      return { re: `[${negate ? '^' : ''}${body}]`, end: j + 1 };
    }
    first = false;
    if (c === '[' && pattern[j + 1] === ':') {
      const close = pattern.indexOf(':]', j + 2);
      if (close > 0) {
        const cls = CLASSES[pattern.slice(j + 2, close)];
        if (cls !== undefined) {
          body += cls;
          j = close + 1;
          continue;
        }
      }
    }
    if (c === '\\' && j + 1 < pattern.length) {
      body += escapeRegex(pattern[++j]!);
      continue;
    }
    if (c === '-' && body !== '' && pattern[j + 1] !== ']' && pattern[j + 1] !== undefined) {
      body += '-';
      continue;
    }
    body += escapeRegex(c);
  }
  return null;
}

/** Converts a shell pattern to a regex source (unanchored). */
export function patternToRegex(pattern: string): string {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      if (i + 1 < pattern.length) re += escapeRegex(pattern[++i]!);
      else re += '\\\\';
    } else if (c === '*') {
      re += '[\\s\\S]*';
    } else if (c === '?') {
      re += '[\\s\\S]';
    } else if (c === '[') {
      const b = bracketToRegex(pattern, i);
      if (b) {
        re += b.re;
        i = b.end - 1;
      } else re += '\\[';
    } else {
      re += escapeRegex(c);
    }
  }
  return re;
}

const cache = new Map<string, RegExp>();

/** True when `s` matches the whole pattern. */
export function matchPattern(pattern: string, s: string, ignoreCase = false): boolean {
  const key = (ignoreCase ? 'i:' : 's:') + pattern;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(`^(?:${patternToRegex(pattern)})$`, ignoreCase ? 'i' : '');
    if (cache.size > 500) cache.clear();
    cache.set(key, re);
  }
  return re.test(s);
}

/** True when the pattern has unescaped glob metacharacters. */
export function hasGlob(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (c === '*' || c === '?') return true;
    else if (c === '[' && bracketToRegex(pattern, i)) return true;
  }
  return false;
}

/** Removes the backslash escapes of a pattern (the literal it denotes). */
export function unescapePattern(pattern: string): string {
  return pattern.replace(/\\([\s\S])/g, '$1');
}

/** `${x#p}` / `${x##p}` / `${x%p}` / `${x%%p}`. */
export function trimPattern(
  value: string,
  pattern: string,
  from: 'start' | 'end',
  longest: boolean,
): string {
  const n = value.length;
  if (from === 'start') {
    if (longest) {
      for (let i = n; i >= 0; i--)
        if (matchPattern(pattern, value.slice(0, i))) return value.slice(i);
    } else {
      for (let i = 0; i <= n; i++)
        if (matchPattern(pattern, value.slice(0, i))) return value.slice(i);
    }
  } else if (longest) {
    for (let i = 0; i <= n; i++)
      if (matchPattern(pattern, value.slice(i))) return value.slice(0, i);
  } else {
    for (let i = n; i >= 0; i--)
      if (matchPattern(pattern, value.slice(i))) return value.slice(0, i);
  }
  return value;
}

/** `${x/p/r}` and friends: longest match at the leftmost position. */
export function replacePattern(
  value: string,
  pattern: string,
  replacement: string,
  all: boolean,
  anchor: 'start' | 'end' | null,
): string {
  if (pattern === '') return value;
  const n = value.length;
  if (anchor === 'start') {
    for (let j = n; j >= 0; j--)
      if (matchPattern(pattern, value.slice(0, j))) return replacement + value.slice(j);
    return value;
  }
  if (anchor === 'end') {
    for (let i = 0; i <= n; i++)
      if (matchPattern(pattern, value.slice(i))) return value.slice(0, i) + replacement;
    return value;
  }
  let out = '';
  let i = 0;
  while (i < n) {
    let matched = -1;
    for (let j = n; j > i; j--) {
      if (matchPattern(pattern, value.slice(i, j))) {
        matched = j;
        break;
      }
    }
    if (matched < 0) {
      out += value[i];
      i++;
      continue;
    }
    out += replacement;
    i = matched;
    if (!all) return out + value.slice(i);
  }
  return out;
}
