// SPDX-License-Identifier: Apache-2.0

/** POSIX `path` module. Follows Node's algorithms so results match byte for byte. */

import { createWin32Path } from './path-win32.ts';

/** Resolves `.` and `..` segments; `allowAboveRoot` keeps leading `..` for relative paths. */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  for (let i = 0; i <= path.length; ++i) {
    const char = i < path.length ? path[i] : '/';
    if (char === '/') {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment or `.`
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || !res.endsWith('..')) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (char === '.' && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function assertPath(path: unknown, name = 'path'): asserts path is string {
  if (typeof path !== 'string') {
    const err = new TypeError(
      `The "${name}" argument must be of type string. Received ${typeof path}`,
    );
    (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

/** Resolves against `cwd` (the process working directory) when no absolute segment is given. */
export function createPosixPath(cwd: () => string) {
  const sep = '/';
  const delimiter = ':';

  function resolve(...args: string[]): string {
    let resolvedPath = '';
    let resolvedAbsolute = false;
    for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const path = i >= 0 ? args[i] : cwd();
      assertPath(path, `paths[${i}]`);
      if (path.length === 0) continue;
      resolvedPath = `${path}/${resolvedPath}`;
      resolvedAbsolute = path.startsWith('/');
    }
    resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
    if (resolvedAbsolute) return `/${resolvedPath}`;
    return resolvedPath.length > 0 ? resolvedPath : '.';
  }

  function normalize(path: string): string {
    assertPath(path);
    if (path.length === 0) return '.';
    const isAbs = path.startsWith('/');
    const trailingSeparator = path.endsWith('/');
    let out = normalizeString(path, !isAbs);
    if (out.length === 0) {
      if (isAbs) return '/';
      return trailingSeparator ? './' : '.';
    }
    if (trailingSeparator) out += '/';
    return isAbs ? `/${out}` : out;
  }

  function isAbsolute(path: string): boolean {
    assertPath(path);
    return path.startsWith('/');
  }

  function join(...args: string[]): string {
    let joined: string | undefined;
    for (const arg of args) {
      assertPath(arg);
      if (arg.length > 0) joined = joined === undefined ? arg : `${joined}/${arg}`;
    }
    return joined === undefined ? '.' : normalize(joined);
  }

  function relative(from: string, to: string): string {
    assertPath(from, 'from');
    assertPath(to, 'to');
    if (from === to) return '';
    from = resolve(from);
    to = resolve(to);
    if (from === to) return '';
    const fromParts = from === '/' ? [] : from.slice(1).split('/');
    const toParts = to === '/' ? [] : to.slice(1).split('/');
    let common = 0;
    while (
      common < fromParts.length &&
      common < toParts.length &&
      fromParts[common] === toParts[common]
    ) {
      common++;
    }
    const up = fromParts.slice(common).map(() => '..');
    return [...up, ...toParts.slice(common)].join('/');
  }

  function dirname(path: string): string {
    assertPath(path);
    if (path.length === 0) return '.';
    const hasRoot = path.startsWith('/');
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path[i] === '/') {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) return hasRoot ? '/' : '.';
    if (hasRoot && end === 1) return '//';
    return path.slice(0, end);
  }

  function basename(path: string, suffix?: string): string {
    assertPath(path);
    let end = path.length;
    while (end > 0 && path[end - 1] === '/') end--;
    if (end === 0) return '';
    const start = path.lastIndexOf('/', end - 1) + 1;
    const base = path.slice(start, end);
    if (suffix !== undefined && suffix.length > 0 && base.endsWith(suffix)) {
      return base.slice(0, base.length - suffix.length);
    }
    return base;
  }

  function extname(path: string): string {
    assertPath(path);
    const base = basename(path);
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || (dot === 1 && base === '..')) return '';
    return base.slice(dot);
  }

  /** Port of Node's posix.parse, including its edge cases (e.g. parse('/..').ext === '.'). */
  function parse(path: string): ParsedPath {
    assertPath(path);
    const ret: ParsedPath = { root: '', dir: '', base: '', ext: '', name: '' };
    if (path.length === 0) return ret;
    const isAbs = path.startsWith('/');
    let start = 0;
    if (isAbs) {
      ret.root = '/';
      start = 1;
    }
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    // 0: no dot seen before the last dot; 1: dots only; -1: other chars before it.
    let preDotState = 0;
    for (let i = path.length - 1; i >= start; --i) {
      const ch = path[i];
      if (ch === '/') {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (ch === '.') {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    if (end !== -1) {
      const from = startPart === 0 && isAbs ? 1 : startPart;
      if (
        startDot === -1 ||
        preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(from, end);
      } else {
        ret.name = path.slice(from, startDot);
        ret.base = path.slice(from, end);
        ret.ext = path.slice(startDot, end);
      }
    }
    if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
    else if (isAbs) ret.dir = '/';
    return ret;
  }

  function format(p: Partial<ParsedPath>): string {
    const dir = p.dir ?? p.root;
    const base =
      p.base ?? `${p.name ?? ''}${p.ext ? (p.ext.startsWith('.') ? p.ext : `.${p.ext}`) : ''}`;
    if (!dir) return base;
    return dir === p.root ? `${dir}${base}` : `${dir}/${base}`;
  }

  const posix = {
    sep,
    delimiter,
    resolve,
    normalize,
    isAbsolute,
    join,
    relative,
    dirname,
    basename,
    extname,
    parse,
    format,
    toNamespacedPath: (p: string) => p,
    posix: undefined as unknown,
    win32: undefined as unknown,
  };
  const win32 = createWin32Path(
    cwd,
    () => (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {},
  );
  posix.posix = win32.posix = posix;
  posix.win32 = win32.win32 = win32;
  return posix;
}

export type PosixPath = ReturnType<typeof createPosixPath>;
