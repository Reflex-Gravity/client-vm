// SPDX-License-Identifier: Apache-2.0
// The process side of native ESM (ADR 0006): globals that kernel-rewritten
// modules call (`import()`, `import.meta`, builtins, CommonJS facades), and
// dynamic import() support for CommonJS and eval code.

import type { PosixPath } from '../path.ts';
import type { ModuleConstructor } from './cjs-loader.ts';
import { fileUrl } from './esm-resolve.ts';
import type { EsmResolver } from './esm-resolve.ts';
import { analyzeEsm, tokenize } from './lexer.ts';

const MODULE_PREFIX = '/__clientvm/fs';

export interface EsmRuntimeDeps {
  esm: EsmResolver;
  Module: ModuleConstructor;
  path: PosixPath;
  cwd: () => string;
  /** The entry module's real path, for import.meta.main. */
  mainFile: () => string | undefined;
  /** A liveness handle held while a module graph loads (Node reads it from disk). */
  hold?: () => { close(): void };
}

export interface EsmRuntime {
  /** Imports an absolute file path as an ES module (graph served by the kernel). */
  importFile(path: string): Promise<unknown>;
  /** Rewrites `import(` in CommonJS or eval source to the process's resolver. */
  rewriteDynamicImports(source: string): string;
}

function moduleUrl(path: string): string {
  return MODULE_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

/** Installs the ESM globals for this process. */
export function installEsmRuntime(deps: EsmRuntimeDeps): EsmRuntime {
  const { esm, Module, path } = deps;
  const g = globalThis as unknown as Record<string, unknown>;
  const namespaces = new Map<string, object>();

  const builtin = (name: string): unknown => Module._load(`node:${name}`, null, false);
  const builtinNamespace = (name: string): object => {
    let ns = namespaces.get(name);
    if (!ns) {
      const mod = builtin(name) as Record<string, unknown>;
      // Like Node's builtin namespaces: own enumerable properties plus default.
      ns = Object.freeze(Object.assign(Object.create(null) as object, mod, { default: mod }));
      namespaces.set(name, ns);
    }
    return ns;
  };

  /** Parent path for resolution; eval and REPL code resolve from the cwd. */
  const parentPath = (parent: string): string =>
    parent.startsWith('/') ? parent : path.join(deps.cwd(), '[eval]');

  const held = async (url: string, options?: ImportCallOptions): Promise<unknown> => {
    const h = deps.hold?.();
    try {
      return await import(/* @vite-ignore */ url, options);
    } finally {
      h?.close();
    }
  };

  const importFile = (file: string, options?: ImportCallOptions): Promise<unknown> =>
    held(moduleUrl(file), options);

  const dynamicImport = async (
    parent: string,
    specifier: unknown,
    options?: ImportCallOptions,
  ): Promise<unknown> => {
    const resolution = esm.resolve(String(specifier), parentPath(parent));
    switch (resolution.kind) {
      case 'builtin':
        return builtinNamespace(resolution.name);
      case 'url':
        return held(resolution.url, options);
      case 'file':
        return importFile(resolution.path, options);
    }
  };

  const importMeta = (file: string) => ({
    url: fileUrl(file),
    filename: file,
    dirname: path.dirname(file),
    main: deps.mainFile() === file,
    resolve(specifier: string): string {
      const r = esm.resolve(String(specifier), file);
      return r.kind === 'file' ? fileUrl(r.path) : r.kind === 'builtin' ? `node:${r.name}` : r.url;
    },
  });

  Object.assign(g, {
    __clientvmDynamicImport: dynamicImport,
    __clientvmImportMeta: importMeta,
    __clientvmRequireCjs: (file: string) => Module._load(file, null, false),
    __clientvmBuiltin: builtin,
    __clientvmBuiltinNs: builtinNamespace,
  });

  return {
    importFile: (file) => importFile(file),
    rewriteDynamicImports(source) {
      if (!/\bimport\s*\(/.test(source)) return source;
      const tokens = tokenize(source);
      const sites = analyzeEsm(source, tokens).dynamicImports;
      if (sites.length === 0) return source;
      let out = '';
      let pos = 0;
      for (const site of sites) {
        // `import(` → `__clientvmDynamicImport(__filename, ` (`__filename` is in scope in CJS and eval).
        const paren = source.indexOf('(', site.end);
        out += `${source.slice(pos, site.start)}__clientvmDynamicImport(__filename, `;
        pos = paren + 1;
      }
      return out + source.slice(pos);
    },
  };
}

interface ImportCallOptions {
  with?: Record<string, string>;
}
