// SPDX-License-Identifier: Apache-2.0
// Serves a process's ES module graph from the VFS (ADR 0006). Processes
// import `/__clientvm/fs/<path>`; the instance service worker forwards those
// requests here. ES modules are served with their specifiers resolved (Node's
// ESM algorithm) and rewritten to such URLs; CommonJS files are served as ES
// facades whose named exports are what Node's cjs-module-lexer detects.

import {
  CjsResolver,
  EsmResolver,
  PackageJsonCache,
  analyzeEsm,
  fileUrl,
  isBuiltin,
  stringValue,
} from '@clientvm/node-compat';
import type { ResolverFs, StaticImport } from '@clientvm/node-compat';
import type { WireRequest, WireResponse } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';
import { S_IFDIR, S_IFMT } from '@clientvm/vfs';
import { initSync as initCjsLexer, parse as parseCjs } from 'cjs-module-lexer';

export const MODULE_PREFIX = '/__clientvm/fs';
export const ERROR_MODULE_PREFIX = '/__clientvm/error/';
const MAX_ERROR_MODULES = 2048;
const utf8 = new TextDecoder();

let cjsLexerReady = false;
/** The package's ESM build is WebAssembly; it must be instantiated before the first parse. */
function ensureCjsLexer(): void {
  if (cjsLexerReady) return;
  initCjsLexer();
  cjsLexerReady = true;
}

/** URL path under which a process imports the file at `path`. */
export function moduleUrl(path: string): string {
  return MODULE_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

function js(body: string, status = 200): WireResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: [
      ['content-type', 'text/javascript; charset=utf-8'],
      ['cache-control', 'no-store'],
    ],
    body: new TextEncoder().encode(body),
  };
}

interface ErrorModule {
  code: string;
  message: string;
  name: string;
  exportNames: string[];
}

export class ModuleServer {
  private readonly vfs: MemoryVfs;
  private readonly fs: ResolverFs;
  private readonly errors = new Map<string, ErrorModule>();
  private nextError = 1;

  constructor(vfs: MemoryVfs) {
    this.vfs = vfs;
    this.fs = {
      stat(p) {
        try {
          return (vfs.stat(p).mode & S_IFMT) === S_IFDIR ? 1 : 0;
        } catch {
          return -1;
        }
      },
      readFile(p) {
        try {
          return utf8.decode(vfs.readFile(p));
        } catch {
          return null;
        }
      },
      realpath: (p) => vfs.realpath(p),
    };
  }

  handles(path: string): boolean {
    return path.startsWith(`${MODULE_PREFIX}/`) || path.startsWith(ERROR_MODULE_PREFIX);
  }

  handle(request: WireRequest): WireResponse {
    const pathname = new URL(request.path, 'http://x').pathname;
    if (pathname.startsWith(ERROR_MODULE_PREFIX)) {
      const error = this.errors.get(pathname.slice(ERROR_MODULE_PREFIX.length));
      if (!error) return js('throw new Error("ClientVM: unknown error module");');
      return js(errorModuleSource(error));
    }
    let file: string;
    try {
      file = pathname.slice(MODULE_PREFIX.length).split('/').map(decodeURIComponent).join('/');
    } catch {
      return js('throw new URIError("ClientVM: malformed module path");', 404);
    }
    const source = this.fs.readFile(file);
    if (source === null)
      return js(`throw new Error(${JSON.stringify(`Cannot find module '${file}'`)});`, 404);

    // A fresh package.json cache per request: the VFS may have changed (npm install).
    const packages = new PackageJsonCache(this.fs);
    const esm = new EsmResolver(this.fs, packages);
    let format: string;
    try {
      format = esm.format(file, () => source);
    } catch (err) {
      return js(errorModuleSource(toErrorModule(err, [])));
    }
    switch (format) {
      case 'module':
        return js(this.rewriteEsm(file, source, esm));
      case 'commonjs':
        return js(this.cjsFacade(file, source, packages));
      case 'json':
        return {
          status: 200,
          statusText: 'OK',
          headers: [
            ['content-type', 'application/json; charset=utf-8'],
            ['cache-control', 'no-store'],
          ],
          body: new TextEncoder().encode(source),
        };
      default:
        return js(
          errorModuleSource({
            name: 'TypeError',
            code: 'ERR_UNKNOWN_FILE_EXTENSION',
            message: `Unknown file extension "${file.slice(file.lastIndexOf('.'))}" for ${file}`,
            exportNames: [],
          }),
        );
    }
  }

  /** Rewrites an ES module's specifiers to resolved URLs; builtins become prelude bindings. */
  private rewriteEsm(file: string, source: string, esm: EsmResolver): string {
    const analysis = analyzeEsm(source);
    const edits: { start: number; end: number; text: string }[] = [];
    const prelude: string[] = [];
    let builtinCounter = 0;

    for (const imp of analysis.imports) {
      const specifier = stringValue(imp.specifier);
      let resolution;
      try {
        resolution = esm.resolve(specifier, file);
      } catch (err) {
        const id = this.storeError(toErrorModule(err, exportNamesOf(imp)));
        edits.push({
          start: imp.specifier.start,
          end: imp.specifier.end,
          text: JSON.stringify(ERROR_MODULE_PREFIX + id),
        });
        continue;
      }
      if (resolution.kind === 'file') {
        edits.push({
          start: imp.specifier.start,
          end: imp.specifier.end,
          text: JSON.stringify(moduleUrl(resolution.path)),
        });
      } else if (resolution.kind === 'builtin') {
        const name = JSON.stringify(resolution.name);
        const replacement = builtinBindings(imp, name, () => `__cvm_b${builtinCounter++}`, prelude);
        edits.push({
          start: imp.statementStart,
          end: imp.statementEnd,
          text: blank(source.slice(imp.statementStart, imp.statementEnd), replacement),
        });
      }
      // data: URLs are left for the browser.
    }

    if (analysis.dynamicImports.length > 0) {
      prelude.push(
        `const __cvm_import = (s, o) => globalThis.__clientvmDynamicImport(${JSON.stringify(file)}, s, o);`,
      );
      for (const t of analysis.dynamicImports)
        edits.push({ start: t.start, end: t.end, text: '__cvm_import' });
    }
    if (analysis.importMetas.length > 0) {
      prelude.push(`const __cvm_meta = globalThis.__clientvmImportMeta(${JSON.stringify(file)});`);
      for (const [start, end] of analysis.importMetas)
        edits.push({ start, end, text: '__cvm_meta' });
    }

    let out = applyEdits(source, edits);
    // The prelude shares line 1 so line numbers in stack traces stay correct.
    if (out.startsWith('#!')) out = `//${out.slice(2)}`;
    return `${prelude.join('')}${out}\n//# sourceURL=${fileUrl(file)}`;
  }

  /** An ES facade over a CommonJS module, executed by the process's CJS loader. */
  private cjsFacade(file: string, source: string, packages: PackageJsonCache): string {
    const names = new Set<string>();
    this.collectCjsNames(file, source, packages, names, new Set());
    names.delete('default');
    const lines = [
      `const __m = globalThis.__clientvmRequireCjs(${JSON.stringify(file)});`,
      `export { __m as default, __m as "module.exports" };`,
    ];
    let i = 0;
    for (const name of names) {
      if (name === 'module.exports') continue;
      lines.push(
        `const __e${i} = __m[${JSON.stringify(name)}]; export { __e${i} as ${JSON.stringify(name)} };`,
      );
      i++;
    }
    return lines.join('\n');
  }

  /** Export names of a CJS file, following reexports the way Node does. */
  private collectCjsNames(
    file: string,
    source: string,
    packages: PackageJsonCache,
    names: Set<string>,
    seen: Set<string>,
  ): void {
    if (seen.has(file)) return;
    seen.add(file);
    let parsed: { exports: string[]; reexports: string[] };
    try {
      ensureCjsLexer();
      parsed = parseCjs(source);
    } catch {
      return; // Node falls back to only the default export when lexing fails.
    }
    for (const name of parsed.exports) names.add(name);
    if (parsed.reexports.length === 0) return;
    const resolver = new CjsResolver(this.fs, packages, {
      extensions: ['.js', '.json', '.node'],
      globalPaths: [],
      isBuiltin,
    });
    const dir = file.slice(0, file.lastIndexOf('/')) || '/';
    for (const spec of parsed.reexports) {
      if (isBuiltin(spec)) continue;
      let target: string;
      try {
        target = resolver.resolve(spec, file, dir, []);
      } catch {
        continue;
      }
      if (!target.endsWith('.js') && !target.endsWith('.cjs')) continue;
      const text = this.fs.readFile(target);
      if (text !== null) this.collectCjsNames(target, text, packages, names, seen);
    }
  }

  private storeError(error: ErrorModule): string {
    const id = String(this.nextError++);
    this.errors.set(id, error);
    if (this.errors.size > MAX_ERROR_MODULES) this.errors.delete(this.errors.keys().next().value!);
    return id;
  }
}

/** Names the importing statement expects the module to provide. */
function exportNamesOf(imp: StaticImport): string[] {
  return imp.names.map((n) => n.imported).filter((n) => n !== '*');
}

function toErrorModule(err: unknown, exportNames: string[]): ErrorModule {
  const e = err as { code?: string; message?: string; name?: string };
  return {
    code: e.code ?? 'ERR_MODULE_NOT_FOUND',
    message: e.message ?? String(err),
    name: e.name === 'TypeError' ? 'TypeError' : 'Error',
    exportNames,
  };
}

/**
 * A module that throws the resolution error when evaluated. It declares the
 * exports its importer asked for, so linking succeeds and the importer sees
 * Node's error (code and message) rather than a missing-export SyntaxError.
 */
function errorModuleSource(error: ErrorModule): string {
  const exports = error.exportNames.map((n) => `__x as ${JSON.stringify(n)}`);
  return [
    `throw Object.assign(new ${error.name}(${JSON.stringify(error.message)}), { code: ${JSON.stringify(error.code)} });`,
    'let __x;',
    exports.length > 0 ? `export { ${[...new Set(exports)].join(', ')} };` : '',
  ].join('\n');
}

/**
 * Turns an import/export-from of a builtin into prelude bindings over the
 * process's builtin module object; returns what replaces the statement.
 */
function builtinBindings(
  imp: StaticImport,
  name: string,
  fresh: () => string,
  prelude: string[],
): string {
  if (imp.kind === 'import') {
    const named: string[] = [];
    for (const { imported, local } of imp.names) {
      if (imported === 'default')
        prelude.push(`const ${local} = globalThis.__clientvmBuiltin(${name});`);
      else if (imported === '*')
        prelude.push(`const ${local} = globalThis.__clientvmBuiltinNs(${name});`);
      else named.push(`${JSON.stringify(imported)}: ${local}`);
    }
    if (named.length > 0)
      prelude.push(`const { ${named.join(', ')} } = globalThis.__clientvmBuiltin(${name});`);
    return '';
  }
  // export ... from 'builtin'
  const parts: string[] = [];
  for (const { imported, local } of imp.names) {
    if (imported === '*' && local === '') {
      prelude.push(
        `throw new SyntaxError("ClientVM does not support 'export * from' a Node builtin");`,
      );
      continue;
    }
    const binding = fresh();
    const value =
      imported === '*'
        ? `globalThis.__clientvmBuiltinNs(${name})`
        : imported === 'default'
          ? `globalThis.__clientvmBuiltin(${name})`
          : `globalThis.__clientvmBuiltin(${name})[${JSON.stringify(imported)}]`;
    prelude.push(`const ${binding} = ${value};`);
    parts.push(`${binding} as ${JSON.stringify(local)}`);
  }
  return parts.length > 0 ? `export { ${parts.join(', ')} };` : '';
}

/** Replaces `original` with `replacement`, padded so line breaks (and line numbers) are kept. */
function blank(original: string, replacement: string): string {
  const newlines = original.split('\n').length - 1;
  return replacement + '\n'.repeat(newlines);
}

function applyEdits(source: string, edits: { start: number; end: number; text: string }[]): string {
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue; // Overlapping edit (statement already replaced).
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + source.slice(pos);
}
