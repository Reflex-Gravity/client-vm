// SPDX-License-Identifier: Apache-2.0
// Node's module resolution: the CommonJS algorithm (require.resolve) and the
// package.json "exports"/"imports" resolver shared with ESM. Ported from
// https://nodejs.org/api/modules.html#all-together and
// https://nodejs.org/api/esm.html#resolution-algorithm-specification.
// Filesystem access goes through ResolverFs so the same code runs in a
// process (sync syscalls), in the kernel, and against node:fs in tests.

import { codeError } from '../internal/errors.ts';
import { createPosixPath } from '../path.ts';

const path = createPosixPath(() => '/');

export interface ResolverFs {
  /** 0 = file, 1 = directory, -1 = missing (follows symlinks). */
  stat(path: string): 0 | 1 | -1;
  /** File contents as UTF-8, or null if it cannot be read. */
  readFile(path: string): string | null;
  realpath(path: string): string;
}

export interface PackageJson {
  /** Absolute path of the package.json file. */
  path: string;
  name?: string;
  main?: string;
  type?: 'commonjs' | 'module';
  exports?: unknown;
  imports?: unknown;
}

/** Caches parsed package.json files, as Node does for the life of a process. */
export class PackageJsonCache {
  private readonly fs: ResolverFs;
  private readonly cache = new Map<string, PackageJson | null>();

  constructor(fs: ResolverFs) {
    this.fs = fs;
  }

  /** Reads `<dir>/package.json`. Throws ERR_INVALID_PACKAGE_CONFIG on malformed JSON. */
  read(dir: string): PackageJson | null {
    const file = dir === '/' ? '/package.json' : `${dir}/package.json`;
    if (this.cache.has(file)) return this.cache.get(file)!;
    const text = this.fs.readFile(file);
    let result: PackageJson | null = null;
    if (text !== null) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        const e = codeError(Error, 'ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${file}.`);
        (e as Error & { cause?: unknown }).cause = err;
        throw e;
      }
      result = { path: file };
      if (raw && typeof raw === 'object') {
        if (typeof raw['name'] === 'string') result.name = raw['name'];
        if (typeof raw['main'] === 'string') result.main = raw['main'];
        if (raw['type'] === 'module' || raw['type'] === 'commonjs') result.type = raw['type'];
        if (raw['exports'] !== undefined) result.exports = raw['exports'];
        if (raw['imports'] !== undefined) result.imports = raw['imports'];
      }
    }
    this.cache.set(file, result);
    return result;
  }

  /** The package.json governing `file`: the nearest one in an ancestor directory. */
  scopeOf(file: string): PackageJson | null {
    let dir = path.dirname(file);
    for (;;) {
      // Node stops at node_modules boundaries: a file in node_modules/x has no scope above it.
      if (path.basename(dir) === 'node_modules') return null;
      const pkg = this.read(dir);
      if (pkg) return pkg;
      if (dir === '/') return null;
      dir = path.dirname(dir);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------- exports / imports

const DEPRECATED_INVALID_SEGMENT =
  /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;

function invalidTarget(
  pkgDir: string,
  key: string,
  target: unknown,
  isImports: boolean,
  base?: string,
): Error {
  const rel =
    typeof target === 'string' && !isImports && target.length > 0 && !target.startsWith('./');
  const t = JSON.stringify(target);
  let msg: string;
  if (key === '.') {
    msg = `Invalid "exports" main target ${t} defined in the package config ${pkgDir}/package.json${base ? ` imported from ${base}` : ''}${rel ? '; targets must start with "./"' : ''}`;
  } else {
    msg = `Invalid "${isImports ? 'imports' : 'exports'}" target ${t} defined for '${key}' in the package config ${pkgDir}/package.json${base ? ` imported from ${base}` : ''}${rel ? '; targets must start with "./"' : ''}`;
  }
  return codeError(Error, 'ERR_INVALID_PACKAGE_TARGET', msg);
}

function invalidConfig(file: string, base: string | undefined, message: string): Error {
  return codeError(
    Error,
    'ERR_INVALID_PACKAGE_CONFIG',
    `Invalid package config ${file}${base ? ` while importing ${base}` : ''}. ${message}`,
  );
}

export interface TargetContext {
  pkgDir: string;
  conditions: ReadonlySet<string>;
  isImports: boolean;
  base: string | undefined;
  /** Resolves a bare specifier from an "imports" target (`"#x": "dep/sub"`). */
  resolveBare: (specifier: string, fromDir: string) => string;
}

/** PACKAGE_TARGET_RESOLVE. Returns an absolute path, null (explicitly excluded) or undefined (no match). */
function resolveTarget(
  ctx: TargetContext,
  key: string,
  target: unknown,
  subpath: string,
  pattern: boolean,
): string | null | undefined {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) {
      if (ctx.isImports && !target.startsWith('../') && !target.startsWith('/')) {
        let isUrl = false;
        try {
          new URL(target);
          isUrl = true;
        } catch {
          /* bare specifier */
        }
        if (!isUrl) {
          const spec = pattern ? target.replaceAll('*', subpath) : target + subpath;
          return ctx.resolveBare(spec, ctx.pkgDir);
        }
      }
      throw invalidTarget(ctx.pkgDir, key, target, ctx.isImports, ctx.base);
    }
    // '.', '..' and 'node_modules' segments are invalid; empty segments ('a//b') only warn in Node.
    if (DEPRECATED_INVALID_SEGMENT.test(target.slice(2))) {
      throw invalidTarget(ctx.pkgDir, key, target, ctx.isImports, ctx.base);
    }
    const resolved = path.join(ctx.pkgDir, target);
    if (
      !resolved.startsWith(ctx.pkgDir === '/' ? '/' : `${ctx.pkgDir}/`) &&
      resolved !== ctx.pkgDir
    ) {
      throw invalidTarget(ctx.pkgDir, key, target, ctx.isImports, ctx.base);
    }
    if (subpath === '')
      return resolved + (target.endsWith('/') && !resolved.endsWith('/') ? '/' : '');
    if (DEPRECATED_INVALID_SEGMENT.test(subpath)) {
      const request = pattern ? key.replace('*', () => subpath) : key + subpath;
      throw codeError(
        TypeError,
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module "${request}" request is not a valid match in pattern "${key}" for the "${ctx.isImports ? 'imports' : 'exports'}" resolution of ${ctx.pkgDir}/package.json${ctx.base ? ` imported from ${ctx.base}` : ''}`,
      );
    }
    if (pattern) return path.join(ctx.pkgDir, target.replaceAll('*', subpath));
    return path.join(ctx.pkgDir, target + subpath);
  }
  if (Array.isArray(target)) {
    if (target.length === 0) return null;
    let lastError: unknown;
    for (const item of target) {
      let resolved: string | null | undefined;
      try {
        resolved = resolveTarget(ctx, key, item, subpath, pattern);
      } catch (err) {
        lastError = err;
        if ((err as { code?: string }).code === 'ERR_INVALID_PACKAGE_TARGET') continue;
        throw err;
      }
      if (resolved === undefined) continue;
      if (resolved === null) {
        lastError = null;
        continue;
      }
      return resolved;
    }
    if (lastError === undefined || lastError === null) return lastError as null | undefined;
    throw lastError;
  }
  if (target !== null && typeof target === 'object') {
    for (const k of Object.keys(target)) {
      if (/^\d+$/.test(k)) {
        throw invalidConfig(
          `${ctx.pkgDir}/package.json`,
          ctx.base,
          '"exports" cannot contain numeric property keys.',
        );
      }
    }
    for (const [k, value] of Object.entries(target as Record<string, unknown>)) {
      if (k === 'default' || ctx.conditions.has(k)) {
        const resolved = resolveTarget(ctx, key, value, subpath, pattern);
        if (resolved === undefined) continue;
        return resolved;
      }
    }
    return undefined;
  }
  if (target === null) return null;
  throw invalidTarget(ctx.pkgDir, key, target, ctx.isImports, ctx.base);
}

function patternKeyCompare(a: string, b: string): number {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const baseA = aStar === -1 ? a.length : aStar + 1;
  const baseB = bStar === -1 ? b.length : bStar + 1;
  if (baseA > baseB) return -1;
  if (baseB > baseA) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/** PACKAGE_IMPORTS_EXPORTS_RESOLVE. */
function resolveMap(
  ctx: TargetContext,
  matchKey: string,
  map: Record<string, unknown>,
): string | null | undefined {
  if (Object.prototype.hasOwnProperty.call(map, matchKey) && !matchKey.includes('*')) {
    return resolveTarget(ctx, matchKey, map[matchKey], '', false);
  }
  let bestMatch = '';
  let bestSubpath = '';
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const base = key.slice(0, star);
    if (!matchKey.startsWith(base) || matchKey === base) continue;
    const trailer = key.slice(star + 1);
    if (trailer.length > 0 && (!matchKey.endsWith(trailer) || matchKey.length < key.length))
      continue;
    if (bestMatch === '' || patternKeyCompare(bestMatch, key) === 1) {
      bestMatch = key;
      bestSubpath = matchKey.slice(base.length, matchKey.length - trailer.length);
    }
  }
  if (bestMatch) return resolveTarget(ctx, bestMatch, map[bestMatch], bestSubpath, true);
  return undefined;
}

function isConditionalSugar(exports: unknown, file: string, base: string | undefined): boolean {
  if (typeof exports === 'string' || Array.isArray(exports)) return true;
  if (typeof exports !== 'object' || exports === null) return false;
  let isSugar: boolean | undefined;
  for (const key of Object.keys(exports)) {
    const cur = key === '' || !key.startsWith('.');
    if (isSugar === undefined) isSugar = cur;
    else if (isSugar !== cur) {
      throw invalidConfig(
        file,
        base,
        '"exports" cannot contain some keys starting with \'.\' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.',
      );
    }
  }
  return isSugar ?? false;
}

/** PACKAGE_EXPORTS_RESOLVE: `subpath` is "." or "./x". Returns an absolute path. */
export function resolveExports(
  pkg: PackageJson,
  subpath: string,
  conditions: ReadonlySet<string>,
  base: string | undefined,
  resolveBare: TargetContext['resolveBare'],
): string {
  const pkgDir = path.dirname(pkg.path);
  let exports = pkg.exports;
  if (isConditionalSugar(exports, pkg.path, base)) exports = { '.': exports };
  const ctx: TargetContext = { pkgDir, conditions, isImports: false, base, resolveBare };
  if (exports !== null && typeof exports === 'object' && !Array.isArray(exports)) {
    const resolved = resolveMap(ctx, subpath, exports as Record<string, unknown>);
    if (resolved !== null && resolved !== undefined) return resolved;
  }
  if (subpath === '.') {
    throw codeError(
      Error,
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `No "exports" main defined in ${pkg.path}${base ? ` imported from ${base}` : ''}`,
    );
  }
  throw codeError(
    Error,
    'ERR_PACKAGE_PATH_NOT_EXPORTED',
    `Package subpath '${subpath}' is not defined by "exports" in ${pkg.path}${base ? ` imported from ${base}` : ''}`,
  );
}

/** PACKAGE_IMPORTS_RESOLVE for a "#x" specifier. */
export function resolveImports(
  pkg: PackageJson,
  specifier: string,
  conditions: ReadonlySet<string>,
  base: string | undefined,
  resolveBare: TargetContext['resolveBare'],
): string {
  if (specifier === '#' || specifier.startsWith('#/')) {
    throw codeError(
      TypeError,
      'ERR_INVALID_MODULE_SPECIFIER',
      `Invalid module "${specifier}" is not a valid internal imports specifier name${base ? ` imported from ${base}` : ''}`,
    );
  }
  const imports = pkg.imports;
  if (imports !== null && typeof imports === 'object' && !Array.isArray(imports)) {
    const ctx: TargetContext = {
      pkgDir: path.dirname(pkg.path),
      conditions,
      isImports: true,
      base,
      resolveBare,
    };
    const resolved = resolveMap(ctx, specifier, imports as Record<string, unknown>);
    if (resolved !== null && resolved !== undefined) return resolved;
  }
  throw codeError(
    TypeError,
    'ERR_PACKAGE_IMPORT_NOT_DEFINED',
    `Package import specifier "${specifier}" is not defined in package ${pkg.path}${base ? ` imported from ${base}` : ''}`,
  );
}

/** Splits "pkg/sub" or "@scope/pkg/sub" into the package name and "./sub" (or "."). */
export function parsePackageName(specifier: string): { name: string; subpath: string } | null {
  let sep = specifier.indexOf('/');
  if (specifier.startsWith('@')) {
    if (sep === -1) return null;
    sep = specifier.indexOf('/', sep + 1);
  }
  const name = sep === -1 ? specifier : specifier.slice(0, sep);
  if (name === '' || name.startsWith('.') || name.includes('\\') || name.includes('%')) return null;
  return { name, subpath: `.${sep === -1 ? '' : specifier.slice(sep)}` };
}

// ---------------------------------------------------------------- CommonJS

/** Conditions Node 24 uses for require(). ("module-sync" is omitted: require(esm) is unsupported.) */
export const CJS_CONDITIONS: ReadonlySet<string> = new Set(['require', 'node', 'node-addons']);

export interface CjsResolveOptions {
  /** Extensions tried in order (Module._extensions keys). */
  extensions: readonly string[];
  /** Directories from NODE_PATH and the global folders, searched after node_modules. */
  globalPaths: readonly string[];
  isBuiltin: (request: string) => boolean;
  conditions?: ReadonlySet<string>;
  /** Called for Node's DEP0128 (package.json "main" falls back to index). */
  onMainFallback?: (pkgPath: string) => void;
}

/** NODE_MODULES_PATHS(START): the lookup directories for bare requests from `from`. */
export function nodeModulePaths(from: string): string[] {
  const resolved = path.resolve(from);
  if (resolved === '/') return ['/node_modules'];
  const paths: string[] = [];
  const parts = resolved.split('/');
  for (let i = parts.length; i > 0; i--) {
    if (parts[i - 1] === 'node_modules') continue;
    const dir = parts.slice(0, i).join('/') || '';
    paths.push(`${dir}/node_modules`);
  }
  paths.push('/node_modules');
  return paths;
}

export function moduleNotFound(request: string, requireStack: string[], extra?: string): Error {
  let message = `Cannot find module '${request}'`;
  if (extra) message += `. ${extra}`;
  if (requireStack.length > 0) message += `\nRequire stack:\n- ${requireStack.join('\n- ')}`;
  const err = codeError(Error, 'MODULE_NOT_FOUND', message);
  (err as Error & { requireStack?: string[] }).requireStack = requireStack;
  return err;
}

/** Node's CommonJS resolver (Module._resolveFilename without the builtin and cache layers). */
export class CjsResolver {
  readonly fs: ResolverFs;
  readonly packages: PackageJsonCache;
  private readonly opts: CjsResolveOptions;
  private readonly conditions: ReadonlySet<string>;

  constructor(fs: ResolverFs, packages: PackageJsonCache, opts: CjsResolveOptions) {
    this.fs = fs;
    this.packages = packages;
    this.opts = opts;
    this.conditions = opts.conditions ?? CJS_CONDITIONS;
  }

  /**
   * Resolves `request` as required from `parentFile` (null for the entry
   * point / eval, which resolves against `parentDir`). Returns the real path
   * of the module file.
   */
  resolve(
    request: string,
    parentFile: string | null,
    parentDir: string,
    requireStack: string[],
    paths?: readonly string[],
  ): string {
    if (request.startsWith('#') && parentFile) {
      const pkg = this.packages.scopeOf(parentFile);
      if (pkg && pkg.imports !== undefined && pkg.imports !== null) {
        return this.finalize(
          resolveImports(pkg, request, this.conditions, parentFile, (s, d) =>
            this.resolveFromNodeModules(s, d, requireStack),
          ),
        );
      }
    }

    // Package self-reference: a package may require itself by name when it has "exports".
    if (parentFile && !isRelative(request)) {
      const pkg = this.packages.scopeOf(parentFile);
      if (pkg?.name && pkg.exports !== undefined && pkg.exports !== null) {
        if (request === pkg.name || request.startsWith(`${pkg.name}/`)) {
          const subpath = `.${request.slice(pkg.name.length)}`;
          return this.finalize(
            resolveExports(pkg, subpath, this.conditions, parentFile, (s, d) =>
              this.resolveFromNodeModules(s, d, requireStack),
            ),
          );
        }
      }
    }

    const lookup =
      paths ??
      (isRelative(request)
        ? [parentDir]
        : [...nodeModulePaths(parentDir), ...this.opts.globalPaths]);
    const found = this.findPath(request, lookup, requireStack);
    if (found !== null) return found;
    throw moduleNotFound(request, requireStack);
  }

  /** Module._findPath. */
  findPath(request: string, paths: readonly string[], requireStack: string[]): string | null {
    const absolute = request.startsWith('/');
    const searchPaths = absolute ? [''] : paths;
    const trailingSlash =
      request.length > 0 &&
      (request.endsWith('/') ||
        request === '.' ||
        request === '..' ||
        request.endsWith('/.') ||
        request.endsWith('/..'));

    for (const dir of searchPaths) {
      if (!absolute && dir !== '' && this.fs.stat(dir) !== 1) continue;
      if (!absolute && !isRelative(request)) {
        const exported = this.resolveExportsIn(dir, request, requireStack);
        if (exported !== undefined) return exported;
      }
      const basePath = absolute ? path.resolve(request) : path.resolve(dir, request);
      const rc = this.fs.stat(basePath);
      if (!trailingSlash) {
        if (rc === 0) return this.fs.realpath(basePath);
        const withExt = this.tryExtensions(basePath);
        if (withExt) return withExt;
      }
      if (rc === 1) {
        const fromDir = this.tryPackage(basePath);
        if (fromDir) return fromDir;
      }
    }
    return null;
  }

  /** LOAD_PACKAGE_EXPORTS for a node_modules directory. undefined = package has no "exports". */
  private resolveExportsIn(
    nodeModulesDir: string,
    request: string,
    requireStack: string[],
  ): string | undefined {
    const parsed = parsePackageName(request);
    if (!parsed) return undefined;
    const pkg = this.packages.read(path.join(nodeModulesDir, parsed.name));
    if (!pkg || pkg.exports === undefined || pkg.exports === null) return undefined;
    return this.finalize(
      resolveExports(pkg, parsed.subpath, this.conditions, undefined, (s, d) =>
        this.resolveFromNodeModules(s, d, requireStack),
      ),
    );
  }

  /** Bare specifiers found through "imports" targets resolve like a require from that package. */
  private resolveFromNodeModules(
    specifier: string,
    fromDir: string,
    requireStack: string[],
  ): string {
    const found = this.findPath(
      specifier,
      [...nodeModulePaths(fromDir), ...this.opts.globalPaths],
      requireStack,
    );
    if (found === null) throw moduleNotFound(specifier, requireStack);
    return found;
  }

  /** finalizeEsmResolution: the target must be an existing file (no extension guessing). */
  /** Like Node, a missing "exports"/"imports" target reports no require stack. */
  private finalize(resolved: string): string {
    if (/%2f|%5c/i.test(resolved)) {
      throw codeError(
        TypeError,
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module "${resolved}" must not include encoded "/" or "\\" characters`,
      );
    }
    const rc = this.fs.stat(resolved);
    if (rc === 0 && !resolved.endsWith('/')) return this.fs.realpath(resolved);
    throw moduleNotFound(resolved, []);
  }

  private tryExtensions(basePath: string): string | null {
    for (const ext of this.opts.extensions) {
      const file = basePath + ext;
      if (this.fs.stat(file) === 0) return this.fs.realpath(file);
    }
    return null;
  }

  private tryIndex(dir: string): string | null {
    return this.tryExtensions(path.join(dir, 'index'));
  }

  /** LOAD_AS_DIRECTORY. */
  private tryPackage(dir: string): string | null {
    const pkg = this.packages.read(dir);
    const main = pkg?.main;
    if (!main) return this.tryIndex(dir);
    const filename = path.resolve(dir, main);
    const actual =
      (this.fs.stat(filename) === 0 ? this.fs.realpath(filename) : null) ??
      this.tryExtensions(filename) ??
      this.tryIndex(filename);
    if (actual) return actual;
    const fallback = this.tryIndex(dir);
    if (fallback) {
      this.opts.onMainFallback?.(pkg.path);
      return fallback;
    }
    // Node's message for a bad "main" has no require stack.
    const err = moduleNotFound(
      filename,
      [],
      `Please verify that the package.json has a valid "main" entry`,
    );
    Object.assign(err, { path: pkg.path, requestPath: dir });
    throw err;
  }
}

function isRelative(request: string): boolean {
  return (
    request === '.' ||
    request === '..' ||
    request.startsWith('./') ||
    request.startsWith('../') ||
    request.startsWith('/')
  );
}
