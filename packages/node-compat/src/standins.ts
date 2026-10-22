// SPDX-License-Identifier: Apache-2.0
// WebAssembly stand-ins for native packages that dev toolchains depend on
// (ADR 0013). ClientVM cannot run native binaries or addons, but esbuild,
// rollup, rolldown and lightningcss publish official WebAssembly builds with
// the same API. When a stock project reaches for the native part, the
// matching WebAssembly build of the same version is fetched from the registry
// (integrity-checked) into /usr/local/lib/clientvm/standins and used instead.

import type { ProcessContext } from '@clientvm/process';
import { createFs } from './fs.ts';
import { nodeRuntime } from './node-main.ts';
import { createPosixPath } from './path.ts';
import { esmToCjs } from './module/esm-to-cjs.ts';
import { analyzeEsm } from './module/lexer.ts';
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

/** What stand-ins installed with npm need from the process: a synchronous child, and stderr. */
export interface StandInHost {
  pid: number;
  /** Runs a command to completion (child_process.spawnSync). */
  spawnSync(
    file: string,
    args: string[],
    options: { cwd: string },
  ): { status: number | null; stderr: unknown; error?: Error };
  warn(message: string): void;
}

/** Rewrites the ES modules of `"type": "module"` packages under `nodeModules` as CommonJS. */
function convertEsmPackages(fs: Fs, nodeModules: string): void {
  const packages: string[] = [];
  for (const name of fs.readdirSync(nodeModules) as string[]) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) packages.push(`${nodeModules}/${name}`);
    else
      for (const sub of fs.readdirSync(`${nodeModules}/${name}`) as string[])
        packages.push(`${nodeModules}/${name}/${sub}`);
  }
  for (const dir of packages) {
    const pkg = readJson(fs, `${dir}/package.json`);
    if (pkg?.['type'] !== 'module') continue;
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d) as string[]) {
        const file = `${d}/${name}`;
        if (name === 'node_modules') continue;
        if (fs.lstatSync(file)!.isDirectory()) walk(file);
        else if (name.endsWith('.js')) {
          const source = fs.readFileSync(file, 'utf8') as string;
          if (!analyzeEsm(source).hasModuleSyntax) continue;
          try {
            fs.writeFileSync(file, esmToCjs(source));
          } catch {
            // Left as it was: a form esmToCjs does not cover (a browser or build file, so far).
          }
        }
      }
    };
    walk(dir);
    fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ ...pkg, type: 'commonjs' }, null, 2));
  }
}

/**
 * Installs `name@version` with its dependencies at `standinDir(name, version)`
 * (as `node_modules/<name>`), using npm, which checks each package's registry
 * integrity. Their ES module helpers are rewritten as CommonJS, since the
 * native loaders they stand in for load them with require(). Returns the
 * package directory, or undefined (after a warning) if the install failed.
 */
function installWithNpm(
  fs: Fs,
  name: string,
  version: string,
  owner: string,
  host: StandInHost,
): string | undefined {
  const dir = standinDir(name, version);
  const pkgDir = `${dir}/node_modules/${name}`;
  if (installed(fs, pkgDir)) return pkgDir;
  const spec = `${name}@${version}`;
  host.warn(`ClientVM: installing ${spec}, the WebAssembly build of ${owner} (first use)\n`);
  const staging = `${dir}.staging-${host.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(`${staging}/package.json`, '{"private":true}\n');
    const args = ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
    const r = host.spawnSync('npm', [...args, '--ignore-scripts', '--loglevel=error', spec], {
      cwd: staging,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`npm exited with ${r.status}: ${String(r.stderr).trim()}`);
    convertEsmPackages(fs, `${staging}/node_modules`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return pkgDir;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    host.warn(`ClientVM: cannot install ${spec}: ${(err as Error).message}\n`);
    return undefined;
  }
}

const ROLLUP_NATIVE = /\/(?:@rollup\/rollup-[^/]+|rollup\/dist)\/rollup\.[^/]+\.node$/;
// The platform package's binary (`lightningcss-linux-x64-gnu/…`), or one built into the main package.
const LIGHTNINGCSS_NATIVE = /\/node_modules\/lightningcss(?:-[^/]+)?\/lightningcss\.[^/]+\.node$/;

/**
 * For the CommonJS loader's `.node` handler: the exports that replace a native
 * addon, or undefined when no stand-in exists for it.
 */
export function nativeStandIn(
  fs: Fs,
  filename: string,
  host: StandInHost,
  requireFile: (file: string) => unknown,
): unknown {
  if (ROLLUP_NATIVE.test(filename)) {
    const version = owningVersion(fs, filename);
    if (!version) return undefined;
    const dir = standinDir('@rollup/wasm-node', version);
    if (!installed(fs, dir))
      installFromRegistrySync(fs, '@rollup/wasm-node', version, dir, host.pid);
    // Same exports as rollup's native binding (parse, parseAsync, xxhash*).
    return requireFile(`${dir}/dist/native.js`);
  }
  if (LIGHTNINGCSS_NATIVE.test(filename)) {
    const version = owningVersion(fs, filename);
    const dir = version && installWithNpm(fs, 'lightningcss-wasm', version, 'lightningcss', host);
    // The synchronous Node build: the same exports as lightningcss's own index.
    return dir ? requireFile(`${dir}/wasm-node.cjs`) : undefined;
  }
  return undefined;
}

/**
 * WebAssembly binding packages that a native loader falls back to when its
 * platform binding fails, keyed by name, with the package that requires them
 * (whose version they must match). They are not in the owner's dependencies,
 * so npm never installs them.
 */
const WASI_BINDINGS: Record<string, string> = {
  '@rolldown/binding-wasm32-wasi': 'rolldown',
};

/**
 * For the CommonJS resolver, when `request` was not found: the extra
 * node_modules directories that hold its stand-in, or undefined when it has
 * none. The stand-in (with its dependencies) is installed by npm on first use.
 */
export function packageStandIn(
  fs: Fs,
  request: string,
  parentFile: string | null,
  host: StandInHost,
): string[] | undefined {
  const name = /^(@[^/]+\/[^/]+|[^@/][^/]*)/.exec(request)?.[1];
  const owner = name === undefined ? undefined : WASI_BINDINGS[name];
  if (!name || !owner || !parentFile) return undefined;
  const ownerDir = new RegExp(`^(.*/node_modules/${owner})/`).exec(parentFile)?.[1];
  const version = ownerDir && readJson(fs, `${ownerDir}/package.json`)?.['version'];
  if (typeof version !== 'string') return undefined;
  return installWithNpm(fs, name, version, owner, host)
    ? [`${standinDir(name, version)}/node_modules`]
    : undefined;
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
