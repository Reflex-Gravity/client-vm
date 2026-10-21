// SPDX-License-Identifier: Apache-2.0
// `path.win32`, following Node's algorithms (lib/path.js) so results match.
// Packages such as tar use it to sanitize archive paths on every platform.

import type { ParsedPath } from './path.ts';

const BACKSLASH = 92;
const SLASH = 47;
const DOT = 46;
const COLON = 58;
const QUESTION = 63;

const isSep = (c: number) => c === SLASH || c === BACKSLASH;
const isDeviceRoot = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

function assertPath(path: unknown, name = 'path'): asserts path is string {
  if (typeof path !== 'string') {
    const err = new TypeError(
      `The "${name}" argument must be of type string. Received ${typeof path}`,
    );
    (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isSep(code)) break;
    else code = SLASH;
    if (isSep(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment or `.`
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || !res.endsWith('..')) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('\\');
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf('\\');
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
          res += res.length > 0 ? '\\..' : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `\\${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/** The `\\server\share` prefix length of a UNC path, or 0 (`full` true when nothing follows it). */
function uncRoot(path: string): { device: string; end: number; full: boolean } | null {
  const len = path.length;
  let j = 2;
  let last = j;
  while (j < len && !isSep(path.charCodeAt(j))) j++;
  if (j >= len || j === last) return null;
  const firstPart = path.slice(last, j);
  last = j;
  while (j < len && isSep(path.charCodeAt(j))) j++;
  if (j >= len || j === last) return null;
  last = j;
  while (j < len && !isSep(path.charCodeAt(j))) j++;
  if (j !== len && j === last) return null;
  return { device: `\\\\${firstPart}\\${path.slice(last, j)}`, end: j, full: j === len };
}

export function createWin32Path(cwd: () => string, env: () => Record<string, string | undefined>) {
  function resolve(...args: string[]): string {
    let resolvedDevice = '';
    let resolvedTail = '';
    let resolvedAbsolute = false;
    for (let i = args.length - 1; i >= -1; i--) {
      let path: string;
      if (i >= 0) {
        path = args[i]!;
        assertPath(path, `paths[${i}]`);
        if (path.length === 0) continue;
      } else if (resolvedDevice.length === 0) {
        path = cwd();
      } else {
        path = env()[`=${resolvedDevice}`] || cwd();
        if (
          path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
          path.charCodeAt(2) === BACKSLASH
        ) {
          path = `${resolvedDevice}\\`;
        }
      }
      const len = path.length;
      let rootEnd = 0;
      let device = '';
      let isAbsolute = false;
      const code = path.charCodeAt(0);
      if (len === 1) {
        if (isSep(code)) {
          rootEnd = 1;
          isAbsolute = true;
        }
      } else if (isSep(code)) {
        isAbsolute = true;
        if (isSep(path.charCodeAt(1))) {
          const unc = uncRoot(path);
          if (unc) {
            device = unc.device;
            rootEnd = unc.end;
          }
        } else {
          rootEnd = 1;
        }
      } else if (isDeviceRoot(code) && path.charCodeAt(1) === COLON) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isSep(path.charCodeAt(2))) {
          isAbsolute = true;
          rootEnd = 3;
        }
      }
      if (device.length > 0) {
        if (resolvedDevice.length > 0) {
          if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
        } else {
          resolvedDevice = device;
        }
      }
      if (resolvedAbsolute) {
        if (resolvedDevice.length > 0) break;
      } else {
        resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
        resolvedAbsolute = isAbsolute;
        if (isAbsolute && resolvedDevice.length > 0) break;
      }
    }
    resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute);
    return resolvedAbsolute
      ? `${resolvedDevice}\\${resolvedTail}`
      : `${resolvedDevice}${resolvedTail}` || '.';
  }

  function normalize(path: string): string {
    assertPath(path);
    const len = path.length;
    if (len === 0) return '.';
    let rootEnd = 0;
    let device: string | undefined;
    let isAbsolute = false;
    const code = path.charCodeAt(0);
    if (len === 1) return code === SLASH ? '\\' : path;
    if (isSep(code)) {
      isAbsolute = true;
      if (isSep(path.charCodeAt(1))) {
        const unc = uncRoot(path);
        if (unc?.full) return `${unc.device}\\`;
        if (unc) {
          device = unc.device;
          rootEnd = unc.end;
        }
      } else {
        rootEnd = 1;
      }
    } else if (isDeviceRoot(code) && path.charCodeAt(1) === COLON) {
      device = path.slice(0, 2);
      rootEnd = 2;
      if (len > 2 && isSep(path.charCodeAt(2))) {
        isAbsolute = true;
        rootEnd = 3;
      }
    }
    let tail = rootEnd < len ? normalizeString(path.slice(rootEnd), !isAbsolute) : '';
    if (tail.length === 0 && !isAbsolute) tail = '.';
    if (tail.length > 0 && isSep(path.charCodeAt(len - 1))) tail += '\\';
    if (!isAbsolute && device === undefined && path.includes(':')) {
      // A relative result must not read as a drive path (CVE-2024-36139).
      if (tail.length >= 2 && isDeviceRoot(tail.charCodeAt(0)) && tail.charCodeAt(1) === COLON) {
        return `.\\${tail}`;
      }
      for (let index = path.indexOf(':'); index !== -1; index = path.indexOf(':', index + 1)) {
        if (index === len - 1 || isSep(path.charCodeAt(index + 1))) return `.\\${tail}`;
      }
    }
    if (device === undefined) return isAbsolute ? `\\${tail}` : tail;
    return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
  }

  function isAbsolute(path: string): boolean {
    assertPath(path);
    const len = path.length;
    if (len === 0) return false;
    const code = path.charCodeAt(0);
    return (
      isSep(code) ||
      (len > 2 && isDeviceRoot(code) && path.charCodeAt(1) === COLON && isSep(path.charCodeAt(2)))
    );
  }

  function join(...args: string[]): string {
    if (args.length === 0) return '.';
    let joined: string | undefined;
    let firstPart = '';
    for (let i = 0; i < args.length; ++i) {
      const arg = args[i]!;
      assertPath(arg, `paths[${i}]`);
      if (arg.length > 0) {
        if (joined === undefined) joined = firstPart = arg;
        else joined += `\\${arg}`;
      }
    }
    if (joined === undefined) return '.';
    // Collapse a leading run of separators unless the first part is a UNC root.
    let needsReplace = true;
    let slashCount = 0;
    if (isSep(firstPart.charCodeAt(0))) {
      ++slashCount;
      const firstLen = firstPart.length;
      if (firstLen > 1 && isSep(firstPart.charCodeAt(1))) {
        ++slashCount;
        if (firstLen > 2) {
          if (isSep(firstPart.charCodeAt(2))) ++slashCount;
          else needsReplace = false;
        }
      }
    }
    if (needsReplace) {
      while (slashCount < joined.length && isSep(joined.charCodeAt(slashCount))) slashCount++;
      if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
    }
    return normalize(joined);
  }

  function relative(from: string, to: string): string {
    assertPath(from, 'from');
    assertPath(to, 'to');
    if (from === to) return '';
    const fromOrig = resolve(from);
    const toOrig = resolve(to);
    if (fromOrig === toOrig) return '';
    from = fromOrig.toLowerCase();
    to = toOrig.toLowerCase();
    if (from === to) return '';
    let fromStart = 0;
    while (fromStart < from.length && from.charCodeAt(fromStart) === BACKSLASH) fromStart++;
    let fromEnd = from.length;
    while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === BACKSLASH) fromEnd--;
    const fromLen = fromEnd - fromStart;
    let toStart = 0;
    while (toStart < to.length && to.charCodeAt(toStart) === BACKSLASH) toStart++;
    let toEnd = to.length;
    while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === BACKSLASH) toEnd--;
    const toLen = toEnd - toStart;
    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      else if (fromCode === BACKSLASH) lastCommonSep = i;
    }
    if (i !== length) {
      if (lastCommonSep === -1) return toOrig;
    } else {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === BACKSLASH) return toOrig.slice(toStart + i + 1);
        if (i === 2) return toOrig.slice(toStart + i);
      }
      if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === BACKSLASH) lastCommonSep = i;
        else if (i === 2) lastCommonSep = 3;
      }
      if (lastCommonSep === -1) lastCommonSep = 0;
    }
    let out = '';
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === BACKSLASH)
        out += out.length === 0 ? '..' : '\\..';
    }
    toStart += lastCommonSep;
    if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;
    if (toOrig.charCodeAt(toStart) === BACKSLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
  }

  function toNamespacedPath(path: unknown): unknown {
    if (typeof path !== 'string' || path.length === 0) return path;
    const resolved = resolve(path);
    if (resolved.length <= 2) return path;
    if (resolved.charCodeAt(0) === BACKSLASH) {
      if (resolved.charCodeAt(1) === BACKSLASH) {
        const code = resolved.charCodeAt(2);
        if (code !== QUESTION && code !== DOT) return `\\\\?\\UNC\\${resolved.slice(2)}`;
      }
    } else if (
      isDeviceRoot(resolved.charCodeAt(0)) &&
      resolved.charCodeAt(1) === COLON &&
      resolved.charCodeAt(2) === BACKSLASH
    ) {
      return `\\\\?\\${resolved}`;
    }
    return resolved;
  }

  function dirname(path: string): string {
    assertPath(path);
    const len = path.length;
    if (len === 0) return '.';
    let rootEnd = -1;
    let offset = 0;
    const code = path.charCodeAt(0);
    if (len === 1) return isSep(code) ? path : '.';
    if (isSep(code)) {
      rootEnd = offset = 1;
      if (isSep(path.charCodeAt(1))) {
        const unc = uncRoot(path);
        if (unc?.full) return path;
        if (unc) rootEnd = offset = unc.end + 1;
      }
    } else if (isDeviceRoot(code) && path.charCodeAt(1) === COLON) {
      rootEnd = len > 2 && isSep(path.charCodeAt(2)) ? 3 : 2;
      offset = rootEnd;
    }
    let end = -1;
    let matchedSlash = true;
    for (let i = len - 1; i >= offset; --i) {
      if (isSep(path.charCodeAt(i))) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) {
      if (rootEnd === -1) return '.';
      end = rootEnd;
    }
    return path.slice(0, end);
  }

  function basename(path: string, suffix?: string): string {
    if (suffix !== undefined) assertPath(suffix, 'suffix');
    assertPath(path);
    let start = 0;
    let end = -1;
    let matchedSlash = true;
    if (path.length >= 2 && isDeviceRoot(path.charCodeAt(0)) && path.charCodeAt(1) === COLON) {
      start = 2;
    }
    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) return '';
      let extIdx = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= start; --i) {
        const code = path.charCodeAt(i);
        if (isSep(code)) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) end = i;
            } else {
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }
      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }
    for (let i = path.length - 1; i >= start; --i) {
      if (isSep(path.charCodeAt(i))) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }
    if (end === -1) return '';
    return path.slice(start, end);
  }

  /** The shared tail of extname and parse: base, name and ext after `rootEnd`. */
  function scanBase(path: string, rootEnd: number) {
    let startDot = -1;
    let startPart = rootEnd;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;
    for (let i = path.length - 1; i >= rootEnd; --i) {
      const code = path.charCodeAt(i);
      if (isSep(code)) {
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
      if (code === DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    const noExt =
      startDot === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1);
    return { startDot, startPart, end, noExt };
  }

  function extname(path: string): string {
    assertPath(path);
    const start =
      path.length >= 2 && path.charCodeAt(1) === COLON && isDeviceRoot(path.charCodeAt(0)) ? 2 : 0;
    const { startDot, end, noExt } = scanBase(path, start);
    if (end === -1 || noExt) return '';
    return path.slice(startDot, end);
  }

  function format(p: Partial<ParsedPath>): string {
    if (p === null || typeof p !== 'object') {
      const err = new TypeError(
        `The "pathObject" argument must be of type object. Received ${p === null ? 'null' : typeof p}`,
      );
      (err as { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    const dir = p.dir || p.root;
    const ext = p.ext ? (p.ext.startsWith('.') ? p.ext : `.${p.ext}`) : '';
    const base = p.base || `${p.name || ''}${ext}`;
    if (!dir) return base;
    return dir === p.root ? `${dir}${base}` : `${dir}\\${base}`;
  }

  function parse(path: string): ParsedPath {
    assertPath(path);
    const ret: ParsedPath = { root: '', dir: '', base: '', ext: '', name: '' };
    if (path.length === 0) return ret;
    const len = path.length;
    let rootEnd = 0;
    const code = path.charCodeAt(0);
    if (len === 1) {
      if (isSep(code)) {
        ret.root = ret.dir = path;
        return ret;
      }
      ret.base = ret.name = path;
      return ret;
    }
    if (isSep(code)) {
      rootEnd = 1;
      if (isSep(path.charCodeAt(1))) {
        const unc = uncRoot(path);
        if (unc) rootEnd = unc.full ? unc.end : unc.end + 1;
      }
    } else if (isDeviceRoot(code) && path.charCodeAt(1) === COLON) {
      if (len <= 2) {
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 2;
      if (isSep(path.charCodeAt(2))) {
        if (len === 3) {
          ret.root = ret.dir = path;
          return ret;
        }
        rootEnd = 3;
      }
    }
    if (rootEnd > 0) ret.root = path.slice(0, rootEnd);
    const { startDot, startPart, end, noExt } = scanBase(path, rootEnd);
    if (end !== -1) {
      if (noExt) {
        ret.base = ret.name = path.slice(startPart, end);
      } else {
        ret.name = path.slice(startPart, startDot);
        ret.base = path.slice(startPart, end);
        ret.ext = path.slice(startDot, end);
      }
    }
    ret.dir = startPart > 0 && startPart !== rootEnd ? path.slice(0, startPart - 1) : ret.root;
    return ret;
  }

  return {
    sep: '\\',
    delimiter: ';',
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
    toNamespacedPath,
    win32: undefined as unknown,
    posix: undefined as unknown,
  };
}

export type Win32Path = ReturnType<typeof createWin32Path>;
