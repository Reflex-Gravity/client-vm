// SPDX-License-Identifier: Apache-2.0
// `pnpm` and `pnpx`: the real, unmodified pnpm CLI on the node runtime,
// installed on first use exactly as npm is (ADR 0012): the pinned release
// is downloaded from the registry, its SHA-512 integrity checked, and
// unpacked into the global prefix (/usr/local/lib/node_modules/pnpm).

import type { ProcessContext } from '@clientvm/process';
import { createFs } from './fs.ts';
import { nodeRuntime } from './node-main.ts';
import { createPosixPath } from './path.ts';
import { installTarball } from './registry.ts';

/** pnpm 10, the major the repository's own tooling pins. */
export const PNPM_VERSION = '10.34.7';
const PNPM_INTEGRITY =
  'sha512-upirxYVTmTM3W1lx9LxtbHOhtLftxKh559EC/lQj0eAjCdZ8YKEfBJVQk6luUhrZw7E4zdZUylvlY/N4s65IvQ==';
const PNPM_ROOT = '/usr/local/lib/node_modules/pnpm';

/** Where the pnpm tarball comes from; `CLIENTVM_PNPM_TARBALL` overrides it (mirrors, tests). */
function tarballUrl(env: Record<string, string>): string {
  return (
    env['CLIENTVM_PNPM_TARBALL'] ?? `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
  );
}

type Fs = ReturnType<typeof createFs>;

function installedVersion(fs: Fs): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(`${PNPM_ROOT}/package.json`, 'utf8') as string) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** A runtime for `pnpm` (`bin/pnpm.cjs`) or `pnpx` (`bin/pnpx.cjs`). */
export function pnpmRuntime(tool: 'pnpm' | 'pnpx'): (ctx: ProcessContext) => Promise<number> {
  return async (ctx) => {
    const fs = createFs(
      ctx.syscall,
      createPosixPath(() => ctx.cwd),
    );
    if (installedVersion(fs) !== PNPM_VERSION) {
      try {
        await installTarball(
          fs,
          { tarball: tarballUrl(ctx.env), integrity: PNPM_INTEGRITY },
          PNPM_ROOT,
          ctx.pid,
        );
      } catch (e) {
        ctx.stderr.write(`${tool}: cannot install pnpm ${PNPM_VERSION}: ${(e as Error).message}\n`);
        return 1;
      }
    }
    return nodeRuntime({
      ...ctx,
      // The pinned pnpm cannot be upgraded in place, so its update check is noise.
      env: { npm_config_update_notifier: 'false', ...ctx.env },
      argv: ['node', `${PNPM_ROOT}/bin/${tool}.cjs`, ...ctx.argv.slice(1)],
    });
  };
}
