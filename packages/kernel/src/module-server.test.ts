// SPDX-License-Identifier: Apache-2.0
import { MemoryVfs } from '@clientvm/vfs';
import { describe, expect, it } from 'vitest';
import { ModuleServer, moduleUrl } from './module-server.ts';

const enc = new TextEncoder();

function serve(
  files: Record<string, string>,
  path: string,
): { status: number; type: string; body: string } {
  const vfs = new MemoryVfs();
  for (const [file, content] of Object.entries(files)) {
    vfs.mkdir(file.slice(0, file.lastIndexOf('/')) || '/', { recursive: true });
    vfs.writeFile(file, enc.encode(content));
  }
  const res = new ModuleServer(vfs).handle({
    port: null,
    method: 'GET',
    path: moduleUrl(path),
    headers: [],
    body: null,
  });
  return {
    status: res.status,
    type: res.headers.find(([k]) => k === 'content-type')![1],
    body: new TextDecoder().decode(res.body),
  };
}

describe('ModuleServer', () => {
  it('serves CommonJS as a facade with Node-detected named exports, following reexports', () => {
    const out = serve(
      {
        '/p/node_modules/r/package.json': '{"main":"index.js"}',
        '/p/node_modules/r/index.js':
          "if (x) { module.exports = require('./a.js'); } else { module.exports = require('./b.js'); }",
        '/p/node_modules/r/a.js': 'exports.useA = 1; exports.shared = 2;',
        '/p/node_modules/r/b.js': 'exports.useB = 1; exports.shared = 2;',
      },
      '/p/node_modules/r/index.js',
    );
    expect(out.body).toContain('globalThis.__clientvmRequireCjs("/p/node_modules/r/index.js")');
    expect(out.body).toContain('as "useB"');
    expect(out.body).toContain('as "shared"');
    expect(out.body).toContain('__m as default');
  });

  it('rewrites ESM specifiers, builtins, import.meta and dynamic import, keeping line numbers', () => {
    const src = [
      "import fs, { readFileSync as rf } from 'node:fs';",
      "import * as path from 'path';",
      "import { x } from './dep.js';",
      "export { y as z } from './dep.js';",
      'export { join } from "path";',
      "import { gone } from './missing.js';",
      "const m = import.meta.url; const d = import('./dep.js');",
    ].join('\n');
    const out = serve(
      {
        '/p/package.json': '{"type":"module"}',
        '/p/main.js': src,
        '/p/dep.js': 'export const x = 1, y = 2;',
      },
      '/p/main.js',
    );
    expect(out.type).toContain('text/javascript');
    const [line1, ...rest] = out.body.split('\n');
    expect(line1).toContain('const fs = globalThis.__clientvmBuiltin("fs");');
    expect(line1).toContain('const { "readFileSync": rf } = globalThis.__clientvmBuiltin("fs");');
    expect(line1).toContain('const path = globalThis.__clientvmBuiltinNs("path");');
    expect(line1).toContain('const __cvm_meta = globalThis.__clientvmImportMeta("/p/main.js");');
    expect(rest[1]).toBe('import { x } from "/__clientvm/fs/p/dep.js";');
    expect(rest[2]).toBe('export { y as z } from "/__clientvm/fs/p/dep.js";');
    expect(rest[3]).toBe('export { __cvm_b0 as "join" };');
    expect(rest[4]).toMatch(/^import \{ gone \} from "\/__clientvm\/error\/\d+";$/);
    expect(rest[5]).toBe("const m = __cvm_meta.url; const d = __cvm_import('./dep.js');");
    expect(out.body).toContain('//# sourceURL=file:///p/main.js');
    // Seven source lines in, seven out (plus the sourceURL line).
    expect(out.body.split('\n')).toHaveLength(8);
  });

  it('serves resolution errors as modules that throw Node errors but still link', () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/p', { recursive: true });
    vfs.writeFile('/p/main.mjs', enc.encode("import { a, default as b } from 'nope';"));
    const server = new ModuleServer(vfs);
    const main = new TextDecoder().decode(
      server.handle({
        port: null,
        method: 'GET',
        path: moduleUrl('/p/main.mjs'),
        headers: [],
        body: null,
      }).body,
    );
    const errPath = /"(\/__clientvm\/error\/\d+)"/.exec(main)![1]!;
    const err = new TextDecoder().decode(
      server.handle({ port: null, method: 'GET', path: errPath, headers: [], body: null }).body,
    );
    expect(err).toContain('ERR_MODULE_NOT_FOUND');
    expect(err).toContain("Cannot find package 'nope' imported from /p/main.mjs");
    expect(err).toContain('export { __x as "a", __x as "default" };');
  });

  it('serves JSON as JSON and detects ESM in "type"-less .js', () => {
    expect(serve({ '/p/d.json': '{"a":1}' }, '/p/d.json').type).toContain('application/json');
    expect(serve({ '/p/m.js': 'export const a = 1;' }, '/p/m.js').body).toContain(
      'export const a = 1;',
    );
    expect(serve({ '/p/c.js': 'exports.a = 1;' }, '/p/c.js').body).toContain(
      '__clientvmRequireCjs',
    );
  });
});
