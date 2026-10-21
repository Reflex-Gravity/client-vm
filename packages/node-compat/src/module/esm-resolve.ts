// SPDX-License-Identifier: Apache-2.0
// Node's ESM resolver (https://nodejs.org/api/esm.html#resolution-algorithm-specification)
// and module format detection. Shared by the kernel (static imports, at serve
// time) and processes (dynamic import(), import.meta.resolve).

import { codeError } from '../internal/errors.ts';
import { createPosixPath } from '../path.ts';
import { isBuiltin } from './builtin-names.ts';
import { analyzeEsm } from './lexer.ts';
import { PackageJsonCache, parsePackageName, resolveExports, resolveImports } from './resolve.ts';
import type { ResolverFs } from './resolve.ts';

const path = createPosixPath(() => '/');

/** Conditions Node 24 uses for import. */
export const ESM_CONDITIONS: ReadonlySet<string> = new Set(['node', 'import', 'module-sync']);

export type EsmResolution =
  | { kind: 'builtin'; name: string }
  | { kind: 'file'; path: string }
  /** A URL the browser can import as-is (data:). */
  | { kind: 'url'; url: string };

export type ModuleFormat = 'module' | 'commonjs' | 'json' | 'wasm';

function notFound(what: string, base: string, isPackage = false): Error {
  return codeError(
    Error,
    'ERR_MODULE_NOT_FOUND',
    `Cannot find ${isPackage ? 'package' : 'module'} '${what}' imported from ${base}`,
  );
}

/** Encodes an absolute path as a file: URL (as Node's pathToFileURL does). */
export function fileUrl(p: string): string {
  return `file://${p
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%40/g, '@'))
    .join('/')}`;
}

export class EsmResolver {
  readonly fs: ResolverFs;
  readonly packages: PackageJsonCache;
  private readonly conditions: ReadonlySet<string>;

  constructor(fs: ResolverFs, packages = new PackageJsonCache(fs), conditions = ESM_CONDITIONS) {
    this.fs = fs;
    this.packages = packages;
    this.conditions = conditions;
  }

  /** ESM_RESOLVE(specifier, parentURL) where `parent` is an absolute file path. */
  resolve(specifier: string, parent: string): EsmResolution {
    if (isBuiltin(specifier)) {
      return {
        kind: 'builtin',
        name: specifier.startsWith('node:') ? specifier.slice(5) : specifier,
      };
    }
    if (specifier.startsWith('node:')) {
      throw codeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${specifier}`);
    }
    if (specifier.startsWith('data:')) return { kind: 'url', url: specifier };

    let resolved: string;
    if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) {
      resolved = this.urlToPath(new URL(specifier, fileUrl(parent)));
    } else if (specifier.startsWith('#')) {
      const pkg = this.packages.scopeOf(parent);
      if (!pkg) {
        throw codeError(
          TypeError,
          'ERR_PACKAGE_IMPORT_NOT_DEFINED',
          `Package import specifier "${specifier}" is not defined imported from ${parent}`,
        );
      }
      resolved = resolveImports(pkg, specifier, this.conditions, parent, (s, dir) =>
        this.packageResolve(s, `${dir}/package.json`),
      );
    } else {
      let url: URL | null = null;
      try {
        url = new URL(specifier);
      } catch {
        /* bare specifier */
      }
      if (url) {
        if (url.protocol === 'file:') resolved = this.urlToPath(url);
        else {
          throw codeError(
            Error,
            'ERR_UNSUPPORTED_ESM_URL_SCHEME',
            `Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol '${url.protocol}'`,
          );
        }
      } else {
        resolved = this.packageResolve(specifier, parent);
      }
    }
    return { kind: 'file', path: this.finalize(resolved, parent) };
  }

  private urlToPath(url: URL): string {
    if (/%2f|%5c/i.test(url.pathname)) {
      throw codeError(
        TypeError,
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module "${url.href}" must not include encoded "/" or "\\" characters`,
      );
    }
    return decodeURIComponent(url.pathname);
  }

  /** The file must exist and not be a directory; returns its real path. */
  private finalize(resolved: string, parent: string): string {
    const rc = this.fs.stat(resolved);
    if (rc === 1 || resolved.endsWith('/')) {
      throw codeError(
        Error,
        'ERR_UNSUPPORTED_DIR_IMPORT',
        `Directory import '${resolved}' is not supported resolving ES modules imported from ${parent}`,
      );
    }
    if (rc !== 0) throw notFound(resolved, parent);
    return this.fs.realpath(resolved);
  }

  /** PACKAGE_RESOLVE. */
  private packageResolve(specifier: string, parent: string): string {
    const parsed = parsePackageName(specifier);
    if (!parsed) {
      throw codeError(
        TypeError,
        'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module "${specifier}" is not a valid package name imported from ${parent}`,
      );
    }
    const { name, subpath } = parsed;
    // Self-reference.
    const scope = this.packages.scopeOf(parent);
    if (scope?.name === name && scope.exports !== undefined && scope.exports !== null) {
      return resolveExports(scope, subpath, this.conditions, parent, (s, dir) =>
        this.packageResolve(s, `${dir}/package.json`),
      );
    }
    let dir = path.dirname(parent);
    for (;;) {
      if (path.basename(dir) !== 'node_modules') {
        const pkgDir = path.join(dir, 'node_modules', name);
        if (this.fs.stat(pkgDir) === 1) {
          const pkg = this.packages.read(pkgDir);
          if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
            return resolveExports(pkg, subpath, this.conditions, parent, (s, d) =>
              this.packageResolve(s, `${d}/package.json`),
            );
          }
          if (subpath === '.') return this.legacyMainResolve(pkgDir, pkg?.main, parent);
          return path.join(pkgDir, subpath);
        }
      }
      if (dir === '/') break;
      dir = path.dirname(dir);
    }
    throw notFound(name, parent, true);
  }

  /** LEGACY_MAIN_RESOLVE: "main" with CommonJS-style guessing, then index files. */
  private legacyMainResolve(pkgDir: string, main: string | undefined, parent: string): string {
    const candidates: string[] = [];
    if (main) {
      const m = path.join(pkgDir, main);
      candidates.push(
        m,
        `${m}.js`,
        `${m}.json`,
        `${m}.node`,
        `${m}/index.js`,
        `${m}/index.json`,
        `${m}/index.node`,
      );
    }
    candidates.push(`${pkgDir}/index.js`, `${pkgDir}/index.json`, `${pkgDir}/index.node`);
    for (const c of candidates) if (this.fs.stat(c) === 0) return c;
    throw notFound(`${pkgDir}/`, parent, true);
  }

  /**
   * How Node would load `file`: by extension, then the package "type", then
   * (for "type"-less .js) by looking for ESM syntax, as Node 24's detection does.
   */
  format(file: string, source?: () => string): ModuleFormat {
    if (file.endsWith('.mjs')) return 'module';
    if (file.endsWith('.cjs')) return 'commonjs';
    if (file.endsWith('.json')) return 'json';
    if (file.endsWith('.wasm')) return 'wasm';
    const type = this.packages.scopeOf(file)?.type;
    if (type === 'module') return 'module';
    if (type === 'commonjs') return 'commonjs';
    if (!file.endsWith('.js') && path.extname(file) !== '') {
      throw codeError(
        TypeError,
        'ERR_UNKNOWN_FILE_EXTENSION',
        `Unknown file extension "${path.extname(file)}" for ${file}`,
      );
    }
    if (source && analyzeEsm(source()).hasModuleSyntax) return 'module';
    return 'commonjs';
  }
}
