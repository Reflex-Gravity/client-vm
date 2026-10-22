// SPDX-License-Identifier: Apache-2.0
// WebAssembly stand-ins for native packages that dev toolchains depend on
// (ADR 0013). ClientVM cannot run native binaries or addons, but esbuild and
// rollup publish official WebAssembly builds with the same API. When a stock
// project reaches for the native part, the matching WebAssembly build of the
// same version is fetched from the registry (integrity-checked) into
// /usr/local/lib/clientvm/standins and used instead.

import type { ProcessContext } from '@clientvm/process';
import { createFs } from './fs.ts';
import { nodeRuntime } from './node-main.ts';
import { createPosixPath } from './path.ts';
import { installFromRegistry, installFromRegistrySync } from './registry.ts';

export const STANDIN_ROOT = '/usr/local/lib/clientvm/standins';
/** Where `ESBUILD_BINARY_PATH` points: a marker for the `clientvm-esbuild` runtime. */
export const ESBUILD_LAUNCHER = '/usr/local/lib/clientvm/bin/esbuild';

type Fs = ReturnType<typeof createFs>;

function readJson(fs: Fs, file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') as string) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const standinDir = (name: string, version: string) => `${STANDIN_ROOT}/${name}@${version}`;
const installed = (fs: Fs, dir: string) => readJson(fs, `${dir}/package.json`) !== undefined;

/** The version of the package that contains `file` (nearest package.json with a version). */
function owningVersion(fs: Fs, file: string): string | undefined {
  let dir = file.slice(0, file.lastIndexOf('/'));
  while (dir) {
    const v = readJson(fs, `${dir}/package.json`)?.['version'];
    if (typeof v === 'string') return v;
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  return undefined;
}

const ROLLUP_NATIVE = /\/(?:@rollup\/rollup-[^/]+|rollup\/dist)\/rollup\.[^/]+\.node$/;

/**
 * For the CommonJS loader's `.node` handler: the exports that replace a native
 * addon, or undefined when no stand-in exists for it.
 */
export function nativeStandIn(
  fs: Fs,
  filename: string,
  pid: number,
  requireFile: (file: string) => unknown,
): unknown {
  if (!ROLLUP_NATIVE.test(filename)) return undefined;
  const version = owningVersion(fs, filename);
  if (!version) return undefined;
  const dir = standinDir('@rollup/wasm-node', version);
  if (!installed(fs, dir)) installFromRegistrySync(fs, '@rollup/wasm-node', version, dir, pid);
  // Same exports as rollup's native binding (parse, parseAsync, xxhash*).
  return requireFile(`${dir}/dist/native.js`);
}

/** The esbuild version a launcher call is for: `--service=<v>`, else the project's esbuild. */
function esbuildVersion(fs: Fs, ctx: ProcessContext): string | undefined {
  for (const arg of ctx.argv) {
    const m = /^--service=(.+)$/.exec(arg);
    if (m) return m[1];
  }
  let dir = ctx.cwd;
  for (;;) {
    const v = readJson(fs, `${dir === '/' ? '' : dir}/node_modules/esbuild/package.json`)?.[
      'version'
    ];
    if (typeof v === 'string') return v;
    if (dir === '/') return undefined;
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
  }
}

/** The `clientvm-esbuild` runtime: runs esbuild-wasm of the requested version. */
export async function esbuildRuntime(ctx: ProcessContext): Promise<number> {
  const fs = createFs(
    ctx.syscall,
    createPosixPath(() => ctx.cwd),
  );
  const version = esbuildVersion(fs, ctx);
  if (!version) {
    ctx.stderr.write(
      'esbuild: cannot tell which esbuild version to run (no node_modules/esbuild)\n',
    );
    return 1;
  }
  const dir = standinDir('esbuild-wasm', version);
  if (!installed(fs, dir)) {
    try {
      await installFromRegistry(fs, 'esbuild-wasm', version, dir, ctx.pid);
    } catch (e) {
      ctx.stderr.write(
        `esbuild: cannot install esbuild-wasm@${version}: ${(e as Error).message}\n`,
      );
      return 1;
    }
  }
  return nodeRuntime({ ...ctx, argv: ['node', `${dir}/bin/esbuild`, ...ctx.argv.slice(1)] });
}
