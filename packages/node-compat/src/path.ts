// SPDX-License-Identifier: Apache-2.0

/**
 * The `path` module: Node's own lib/path.js (vendored, see
 * scripts/vendor-node-path.mjs), so posix and win32 results match Node
 * byte for byte, run with the few internals it needs.
 */

import { createNodePath } from './vendor/node-path.ts';

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export interface PathModule {
  sep: string;
  delimiter: string;
  resolve(...paths: string[]): string;
  normalize(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  parse(path: string): ParsedPath;
  format(pathObject: Partial<ParsedPath>): string;
  toNamespacedPath<T>(path: T): T;
  matchesGlob(path: string, pattern: string): boolean;
  posix: PathModule;
  win32: PathModule;
}

const CONSTANTS = {
  CHAR_UPPERCASE_A: 65,
  CHAR_LOWERCASE_A: 97,
  CHAR_UPPERCASE_Z: 90,
  CHAR_LOWERCASE_Z: 122,
  CHAR_DOT: 46,
  CHAR_FORWARD_SLASH: 47,
  CHAR_BACKWARD_SLASH: 92,
  CHAR_COLON: 58,
  CHAR_QUESTION_MARK: 63,
};

/** `StringPrototypeSlice` → `(s, ...a) => String.prototype.slice.call(s, ...a)`, and so on. */
const primordials = new Proxy({} as Record<string, unknown>, {
  get(cache, name) {
    if (typeof name !== 'string') return undefined;
    if (name in cache) return cache[name];
    const m = /^(Array|String|Function|Object|RegExp|Number)(Prototype)?(\w+)$/.exec(name);
    if (!m) throw new Error(`primordial ${name} is not available`);
    const ctor = globalThis[m[1] as 'Array'] as unknown as Record<string, unknown> & {
      prototype: Record<string, unknown>;
    };
    const key = m[3]![0]!.toLowerCase() + m[3]!.slice(1);
    const value = m[2]
      ? (self: unknown, ...args: unknown[]) =>
          (ctor.prototype[key] as (...a: unknown[]) => unknown).apply(self, args)
      : ctor[m[3]!];
    cache[name] = value;
    return value;
  },
});

function invalidType(name: string, expected: string, value: unknown): TypeError {
  const received =
    value === null
      ? 'null'
      : value === undefined
        ? 'undefined'
        : typeof value === 'function'
          ? `function ${(value as { name?: string }).name ?? ''}`
          : typeof value === 'object'
            ? `an instance of ${(value as object).constructor?.name ?? 'Object'}`
            : `type ${typeof value} (${JSON.stringify(value)})`;
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${received}`,
  );
  (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

/** Glob matching for `path.matchesGlob` (`*`, `**`, `?`, `[...]`, `{a,b}`). */
function matchGlobPattern(path: string, pattern: string, windows: boolean): boolean {
  const norm = (s: string) => (windows ? s.replace(/\\/g, '/') : s);
  let re = '';
  const p = norm(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slash = p[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${p
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      const end = p.indexOf('}', i + 1);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${p
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, windows ? 'i' : '').test(norm(path));
}

/** The `path` module (posix), with `win32` attached. `cwd` serves `resolve`. */
export function createPosixPath(cwd: () => string): PathModule {
  const internals: Record<string, unknown> = {
    'internal/constants': CONSTANTS,
    'internal/validators': {
      validateString(value: unknown, name: string) {
        if (typeof value !== 'string') throw invalidType(name, 'string', value);
      },
      validateObject(value: unknown, name: string) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw invalidType(name, 'object', value);
      },
    },
    'internal/util': {
      isWindows: false,
      getLazy: <T>(make: () => T) => {
        let value: T | undefined;
        let made = false;
        return () => {
          if (!made) {
            value = make();
            made = true;
          }
          return value as T;
        };
      },
    },
    'internal/fs/glob': { matchGlobPattern },
  };
  const require = (id: string) => {
    if (!(id in internals)) throw new Error(`lib/path.js requires ${id}`);
    return internals[id];
  };
  const process = {
    cwd,
    platform: 'linux',
    get env() {
      return (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
    },
  };
  return createNodePath(primordials, require, process) as PathModule;
}

export type PosixPath = PathModule;
