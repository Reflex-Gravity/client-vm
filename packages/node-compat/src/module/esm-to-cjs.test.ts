// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { esmToCjs } from './esm-to-cjs.ts';

/** Runs converted source as a CommonJS module; `deps` answers require(). */
function run(source: string, deps: Record<string, unknown> = {}): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> };
  const require = (id: string) => {
    if (!(id in deps)) throw new Error(`unexpected require(${id})`);
    return deps[id];
  };
  new Function('exports', 'require', 'module', esmToCjs(source))(module.exports, require, module);
  return module.exports;
}

describe('esmToCjs', () => {
  it('converts imports', () => {
    const cjsDep = { a: 1, b: 2 };
    const esDep = { __esModule: true, default: 'd', c: 3 };
    const out = run(
      `import 'side';
import x, { a, b as bee } from 'cjs';
import y, * as ns from 'es';
export const sum = a + bee + ns.c;
export const defaults = [x, y];
`,
      { side: {}, cjs: cjsDep, es: esDep },
    );
    expect(out['sum']).toBe(6);
    expect(out['defaults']).toEqual([cjsDep, 'd']);
  });

  it('keeps local exports live and declarations hoisted', () => {
    const out = run(`
export function bump() { count++; return hoisted(); }
export let count = 0;
function hoisted() { return count; }
class Thing {}
const one = 1;
export { Thing, one as 'uno' };
export default function main() { return 'main'; }
`);
    expect(out['count']).toBe(0);
    expect((out['bump'] as () => number)()).toBe(1);
    expect(out['count']).toBe(1);
    expect(typeof out['Thing']).toBe('function');
    expect(out['uno']).toBe(1);
    expect((out['default'] as () => string)()).toBe('main');
    expect(out['__esModule']).toBe(true);
  });

  it('converts re-exports and default expressions', () => {
    const dep = { p: 1, q: 2, default: 'skip' };
    const out = run(
      `export * from 'dep';
export { p as pee } from 'dep';
export * as all from 'dep';
export default { answer: 42 };`,
      { dep },
    );
    expect(out['p']).toBe(1);
    expect(out['q']).toBe(2);
    expect(out['pee']).toBe(1);
    expect(out['all']).toBe(dep);
    expect(out['default']).toEqual({ answer: 42 });
  });

  it('keeps line numbers', () => {
    const source = `import { a } from 'dep';\n\nexport { a };\nthrow new Error('line 4');\n`;
    const out = esmToCjs(source);
    expect(out.split('\n')).toHaveLength(source.split('\n').length);
    expect(out.split('\n')[3]).toBe(`throw new Error('line 4');`);
  });

  it('ignores export inside strings and member names', () => {
    const out = run(`const o = { export: 1 }; export const s = 'export const x = 1' + o.export;`);
    expect(out['s']).toBe('export const x = 11');
  });

  it("gives import.meta the file's url and paths", () => {
    const module = { exports: {} as Record<string, unknown> };
    const require = (id: string) =>
      id === 'url' ? { pathToFileURL: (p: string) => ({ href: `file://${p}` }) } : {};
    new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      esmToCjs('export const m = import.meta;'),
    )(module.exports, require, module, '/a/b.js', '/a');
    expect(module.exports['m']).toEqual({
      url: 'file:///a/b.js',
      filename: '/a/b.js',
      dirname: '/a',
    });
  });

  it('exports every declarator, and ends a declaration without semicolons at the next statement', () => {
    expect(run('export const a = 1, b = [2, 3], c = { d: 4 };')).toEqual({
      a: 1,
      b: [2, 3],
      c: { d: 4 },
    });
    // No semicolons (ASI): the comma in the later `let` is not this declaration's.
    const out = run(`export const E = 'e'
const f = (x, y) => x + y
let g, h
export function sum() { return f(1, 2) }
`);
    expect(out).toEqual({ E: 'e', sum: expect.any(Function) });
    expect((out['sum'] as () => number)()).toBe(3);
  });

  it('rejects what it cannot convert faithfully', () => {
    expect(() => esmToCjs('export const a = 1, { b } = o;')).toThrow(/destructuring/);
    expect(() => esmToCjs('export const { a } = o;')).toThrow(/unsupported/);
  });
});
