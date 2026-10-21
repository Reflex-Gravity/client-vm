// SPDX-License-Identifier: Apache-2.0
// The CommonJS module system: Node's `Module` with the same monkeypatchable
// entry points (Module._load, _resolveFilename, _extensions, prototype._compile)
// that tools like tsx, pirates and require-in-the-middle hook into.

import { codeError } from '../buffer.ts';
import type { PosixPath } from '../path.ts';
import { NODE_BUILTINS, isBuiltin } from './builtin-names.ts';
import { analyzeEsm } from './lexer.ts';
import { CjsResolver, PackageJsonCache, nodeModulePaths } from './resolve.ts';
import type { ResolverFs } from './resolve.ts';

export interface ModuleSystemDeps {
  fs: ResolverFs;
  path: PosixPath;
  /** Implemented builtins by name (without `node:`). */
  builtins: Record<string, unknown>;
  cwd: () => string;
  env: () => Record<string, string | undefined>;
  emitWarning: (message: string, type: string, code: string) => void;
  /** Runs the module wrapper source; returns the wrapper function. */
  compile: (source: string, filename: string) => (...args: unknown[]) => unknown;
  /** Called when a .mjs or "type": "module" file is required. */
  requireEsm?: (filename: string, parent: string | undefined) => unknown;
}

interface ModuleLike {
  id: string;
  path: string;
  exports: unknown;
  filename: string | null;
  loaded: boolean;
  children: ModuleLike[];
  paths: string[];
  parent?: ModuleLike | null | undefined;
  require(id: string): unknown;
  load(filename: string): void;
  _compile(content: string, filename: string): unknown;
}

export interface RequireFunction {
  (id: string): unknown;
  resolve: ((request: string, options?: { paths?: string[] }) => string) & {
    paths: (request: string) => string[] | null;
  };
  main: ModuleLike | undefined;
  extensions: Record<string, unknown>;
  cache: Record<string, ModuleLike>;
}

export type ModuleConstructor = {
  new (id?: string, parent?: ModuleLike | null): ModuleLike;
  (id?: string, parent?: ModuleLike | null): void;
  _cache: Record<string, ModuleLike>;
  _pathCache: Record<string, string>;
  _extensions: Record<string, (module: ModuleLike, filename: string) => void>;
  _load(request: string, parent: ModuleLike | null | undefined, isMain?: boolean): unknown;
  _resolveFilename(
    request: string,
    parent: ModuleLike | null | undefined,
    isMain?: boolean,
    options?: { paths?: string[] },
  ): string;
  _nodeModulePaths(from: string): string[];
  _resolveLookupPaths(request: string, parent: ModuleLike | null | undefined): string[] | null;
  _findPath(request: string, paths: string[], isMain?: boolean): string | false;
  _initPaths(): void;
  globalPaths: string[];
  builtinModules: readonly string[];
  isBuiltin(request: string): boolean;
  createRequire(filename: string | URL): RequireFunction;
  wrap(script: string): string;
  wrapper: [string, string];
  syncBuiltinESMExports(): void;
  findSourceMap(): undefined;
  register(): void;
  enableCompileCache(): { status: number };
  getCompileCacheDir(): undefined;
  runMain(main?: string): void;
  Module: ModuleConstructor;
  /** @internal */
  _runMainFile(filename: string): unknown;
  /** @internal */
  _makeEvalModule(): ModuleLike;
};

const WRAPPER: [string, string] = [
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});',
];

function requireEsmError(filename: string, parent: string | undefined): Error {
  return codeError(
    Error,
    'ERR_REQUIRE_ESM',
    `require() of ES Module ${filename}${parent ? ` from ${parent}` : ''} not supported.\nInstead change the require of ${filename} to a dynamic import() which is available in all CommonJS modules.`,
  );
}

function stripBOM(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Builds the `module` builtin (Module) for one process. */
export function createModuleSystem(deps: ModuleSystemDeps): ModuleConstructor {
  const { fs, path } = deps;
  const packages = new PackageJsonCache(fs);
  let mainModule: ModuleLike | undefined;

  const Module = function Module(this: ModuleLike, id = '', parent?: ModuleLike | null) {
    this.id = id;
    this.path = path.dirname(id);
    this.exports = {};
    this.filename = null;
    this.loaded = false;
    this.children = [];
    this.paths = [];
    Object.defineProperty(this, 'parent', {
      value: parent,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    if (parent && !parent.children.includes(this)) parent.children.push(this);
  } as unknown as ModuleConstructor;

  Module.Module = Module;
  Module._cache = Object.create(null) as Record<string, ModuleLike>;
  Module._pathCache = Object.create(null) as Record<string, string>;
  Module.builtinModules = Object.freeze([...NODE_BUILTINS]);
  Module.isBuiltin = isBuiltin;
  Module.wrapper = WRAPPER;
  Module.wrap = (script: string) => WRAPPER[0] + script + WRAPPER[1];
  Module.syncBuiltinESMExports = () => {};
  Module.findSourceMap = () => undefined;
  Module.register = () => {};
  Module.enableCompileCache = () => ({ status: 3 });
  Module.getCompileCacheDir = () => undefined;
  Module._nodeModulePaths = nodeModulePaths;
  Module.globalPaths = [];

  Module._initPaths = () => {
    const env = deps.env();
    const home = env['HOME'];
    const paths = ['/usr/local/lib/node'];
    if (home)
      paths.unshift(path.resolve(home, '.node_libraries'), path.resolve(home, '.node_modules'));
    const nodePath = env['NODE_PATH'];
    const fromEnv = nodePath
      ? nodePath
          .split(':')
          .filter(Boolean)
          .map((p) => path.resolve(p))
      : [];
    Module.globalPaths = [...fromEnv, ...paths];
  };
  Module._initPaths();

  const extensionList = () => Object.keys(Module._extensions);

  const resolver = () =>
    new CjsResolver(fs, packages, {
      extensions: extensionList(),
      globalPaths: Module.globalPaths,
      isBuiltin,
      onMainFallback: (pkgPath) =>
        deps.emitWarning(
          `Invalid 'main' field in '${pkgPath}' of 'undefined'. Please either fix that or report it to the module author`,
          'DeprecationWarning',
          'DEP0128',
        ),
    });

  const requireStackOf = (parent: ModuleLike | null | undefined): string[] => {
    const stack: string[] = [];
    for (let m = parent; m; m = m.parent) stack.push(m.filename ?? m.id);
    return stack;
  };

  Module._resolveLookupPaths = (request, parent) => {
    if (isBuiltin(request)) return null;
    const relative =
      request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..';
    if (!relative) {
      const base = parent?.paths?.length ? parent.paths : nodeModulePaths(deps.cwd());
      return [...base, ...Module.globalPaths];
    }
    if (!parent?.filename) return [deps.cwd()];
    return [path.dirname(parent.filename)];
  };

  Module._findPath = (request, paths) => {
    const cacheKey = `${request}\0${paths.join('\0')}`;
    const cached = Module._pathCache[cacheKey];
    if (cached) return cached;
    const found = resolver().findPath(request, paths, []);
    if (found) Module._pathCache[cacheKey] = found;
    return found ?? false;
  };

  Module._resolveFilename = (request, parent, _isMain, options) => {
    if (typeof request !== 'string') {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        `The "id" argument must be of type string. Received ${typeof request}`,
      );
    }
    if (isBuiltin(request)) return request;
    const parentFile = parent?.filename ?? null;
    const parentDir = parentFile ? path.dirname(parentFile) : deps.cwd();
    let paths: string[] | undefined;
    if (options?.paths) {
      const relative =
        request.startsWith('./') ||
        request.startsWith('../') ||
        request === '.' ||
        request === '..';
      paths = relative
        ? options.paths.map((p) => path.resolve(p))
        : [
            ...options.paths.flatMap((p) => nodeModulePaths(path.resolve(p))),
            ...Module.globalPaths,
          ];
    }
    return resolver().resolve(request, parentFile, parentDir, requireStackOf(parent), paths);
  };

  Module._load = (request, parent, isMain = false) => {
    if (request.startsWith('node:')) {
      const name = request.slice(5);
      if (!isBuiltin(request)) {
        throw codeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${request}`);
      }
      return loadBuiltin(name);
    }
    const filename = Module._resolveFilename(request, parent, isMain);
    const cached = Module._cache[filename];
    if (cached !== undefined) {
      if (parent && !parent.children.includes(cached)) parent.children.push(cached);
      return cached.exports;
    }
    if (isBuiltin(filename)) return loadBuiltin(filename);

    const module = new Module(filename, parent);
    if (isMain) {
      mainModule = module;
      module.id = '.';
      const proc = deps.builtins['process'] as { mainModule?: ModuleLike } | undefined;
      if (proc) proc.mainModule = module;
    }
    Module._cache[filename] = module;
    let threw = true;
    try {
      module.load(filename);
      threw = false;
    } finally {
      if (threw) {
        delete Module._cache[filename];
        if (parent) {
          const i = parent.children.indexOf(module);
          if (i !== -1) parent.children.splice(i, 1);
        }
      }
    }
    return module.exports;
  };

  function loadBuiltin(name: string): unknown {
    if (Object.prototype.hasOwnProperty.call(deps.builtins, name)) return deps.builtins[name];
    if (name === 'module') return Module;
    throw codeError(
      Error,
      'ERR_CLIENTVM_UNSUPPORTED_BUILTIN',
      `The Node.js builtin "node:${name}" is not available in ClientVM yet (see docs/compatibility.md)`,
    );
  }

  function findLongestRegisteredExtension(filename: string): string {
    const name = path.basename(filename);
    let index = 0;
    while ((index = name.indexOf('.', index + 1)) !== -1) {
      const ext = name.slice(index);
      if (Object.prototype.hasOwnProperty.call(Module._extensions, ext)) return ext;
    }
    return '.js';
  }

  function isEsmFile(filename: string): boolean {
    if (filename.endsWith('.mjs')) return true;
    if (!filename.endsWith('.js')) return false;
    return packages.scopeOf(filename)?.type === 'module';
  }

  const proto = Module.prototype as ModuleLike;

  proto.load = function load(this: ModuleLike, filename: string) {
    this.filename = filename;
    this.paths = nodeModulePaths(path.dirname(filename));
    if (isEsmFile(filename)) {
      if (deps.requireEsm) {
        this.exports = deps.requireEsm(filename, this.parent?.filename ?? undefined);
        this.loaded = true;
        return;
      }
      throw requireEsmError(filename, this.parent?.filename ?? undefined);
    }
    const ext = findLongestRegisteredExtension(filename);
    Module._extensions[ext]!(this, filename);
    this.loaded = true;
  };

  proto.require = function require(this: ModuleLike, id: string) {
    if (typeof id !== 'string') {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        `The "id" argument must be of type string. Received ${id === null ? 'null' : typeof id}`,
      );
    }
    if (id === '') {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_VALUE',
        "The argument 'id' must be a non-empty string. Received ''",
      );
    }
    return Module._load(id, this, false);
  };

  proto._compile = function _compile(this: ModuleLike, content: string, filename: string) {
    let source = content;
    // V8 only accepts a hashbang at the very start of a script, not inside the wrapper.
    if (source.startsWith('#!')) source = `//${source.slice(2)}`;
    const wrapper = deps.compile(Module.wrap(source), filename);
    const require = makeRequireFunction(this);
    return wrapper.call(
      this.exports,
      this.exports,
      require,
      this,
      filename,
      path.dirname(filename),
    );
  };

  Module._extensions = Object.create(null) as ModuleConstructor['_extensions'];
  Module._extensions['.js'] = (module, filename) => {
    const content = fs.readFile(filename);
    if (content === null)
      throw codeError(Error, 'ENOENT', `ENOENT: no such file or directory, open '${filename}'`);
    try {
      module._compile(stripBOM(content), filename);
    } catch (err) {
      // Node 24 detects ESM syntax in "type"-less .js files when CommonJS compilation fails.
      if (
        err instanceof SyntaxError &&
        packages.scopeOf(filename)?.type === undefined &&
        analyzeEsm(content).hasModuleSyntax
      ) {
        throw requireEsmError(filename, module.parent?.filename ?? undefined);
      }
      throw err;
    }
  };
  Module._extensions['.json'] = (module, filename) => {
    const content = fs.readFile(filename);
    if (content === null)
      throw codeError(Error, 'ENOENT', `ENOENT: no such file or directory, open '${filename}'`);
    try {
      module.exports = JSON.parse(stripBOM(content));
    } catch (err) {
      (err as Error).message = `${filename}: ${(err as Error).message}`;
      throw err;
    }
  };
  Module._extensions['.node'] = (_module, filename) => {
    throw codeError(
      Error,
      'ERR_DLOPEN_FAILED',
      `ClientVM cannot load native addons (${filename}). Use a pure-JavaScript or WebAssembly alternative.`,
    );
  };

  function makeRequireFunction(mod: ModuleLike): RequireFunction {
    const require = function require(id: string) {
      return mod.require(id);
    } as RequireFunction;
    const resolve = (request: string, options?: { paths?: string[] }) => {
      if (typeof request !== 'string') {
        throw codeError(
          TypeError,
          'ERR_INVALID_ARG_TYPE',
          `The "request" argument must be of type string. Received ${typeof request}`,
        );
      }
      return Module._resolveFilename(request, mod, false, options);
    };
    resolve.paths = (request: string) => Module._resolveLookupPaths(request, mod);
    require.resolve = resolve;
    Object.defineProperty(require, 'main', {
      get: () => mainModule,
      enumerable: true,
      configurable: true,
    });
    require.extensions = Module._extensions;
    require.cache = Module._cache;
    return require;
  }

  Module.createRequire = (filename: string | URL) => {
    let file: string;
    if (filename instanceof URL || (typeof filename === 'string' && filename.startsWith('file:'))) {
      file = decodeURIComponent(new URL(String(filename)).pathname);
    } else if (typeof filename === 'string' && filename.startsWith('/')) {
      file = filename;
    } else {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_VALUE',
        `The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${JSON.stringify(filename)}`,
      );
    }
    // A trailing slash means "require from inside this directory".
    const proxyPath = file.endsWith('/') ? path.join(file, 'noop.js') : file;
    const m = new Module(proxyPath);
    m.filename = proxyPath;
    m.paths = nodeModulePaths(path.dirname(proxyPath));
    return makeRequireFunction(m);
  };

  Module._runMainFile = (filename: string) => Module._load(filename, null, true);
  Module.runMain = (main?: string) => {
    const argv = (deps.builtins['process'] as { argv?: string[] } | undefined)?.argv;
    const file = main ?? argv?.[1];
    if (file) Module._runMainFile(file);
  };

  Module._makeEvalModule = () => {
    const m = new Module('[eval]');
    m.filename = path.join(deps.cwd(), '[eval]');
    m.paths = nodeModulePaths(deps.cwd());
    (m as ModuleLike & { _require?: RequireFunction })._require = makeRequireFunction(m);
    return m;
  };

  return Module;
}

/** The `require` a module object exposes (for eval modules created by _makeEvalModule). */
export function requireOf(module: unknown): RequireFunction {
  return (module as { _require: RequireFunction })._require;
}
