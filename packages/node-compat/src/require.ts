// SPDX-License-Identifier: Apache-2.0

/** Builtin-only CommonJS `require`. Filesystem modules and `exports` maps arrive in Phase 3. */
export function createRequire(builtins: Readonly<Record<string, unknown>>) {
  const require = (id: string): unknown => {
    const name = id.startsWith('node:') ? id.slice(5) : id;
    if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
    const err = new Error(`Cannot find module '${id}'`);
    (err as { code?: string }).code = 'MODULE_NOT_FOUND';
    throw err;
  };
  require.cache = Object.create(null) as Record<string, unknown>;
  require.resolve = (id: string): string => {
    const name = id.startsWith('node:') ? id.slice(5) : id;
    if (Object.prototype.hasOwnProperty.call(builtins, name)) return id;
    const err = new Error(`Cannot find module '${id}'`);
    (err as { code?: string }).code = 'MODULE_NOT_FOUND';
    throw err;
  };
  return require;
}
