// SPDX-License-Identifier: Apache-2.0
// `npm` and `npx`: the real, unmodified npm CLI on the node runtime. On first
// use the pinned npm release is downloaded from the registry, its SHA-512
// integrity checked, and unpacked into the global prefix
// (/usr/local/lib/node_modules/npm), where Node installs keep it too.

import type { ProcessContext } from '@clientvm/process';
import { createFs } from './fs.ts';
import { nodeRuntime } from './node-main.ts';
import { createPosixPath } from './path.ts';
import { installTarball } from './registry.ts';

/** The npm release Node.js 24 LTS bundles (ADR 0012). */
export const NPM_VERSION = '11.6.1';
const NPM_INTEGRITY =
  'sha512-7iDSHDoup6uMQJ37yWrhfqcbMhF0UEfGRap6Nv+aKQcrIJXlCi2cKbj75WBmiHlcwsQCy/U0zEwDZdAx6H/Vaw==';
const NPM_ROOT = '/usr/local/lib/node_modules/npm';

/** Where the npm tarball comes from; `CLIENTVM_NPM_TARBALL` overrides it (mirrors, tests). */
function tarballUrl(env: Record<string, string>): string {
  return env['CLIENTVM_NPM_TARBALL'] ?? `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`;
}

type Fs = ReturnType<typeof createFs>;

function installedVersion(fs: Fs): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(`${NPM_ROOT}/package.json`, 'utf8') as string) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

async function installNpm(ctx: ProcessContext, fs: Fs): Promise<void> {
  await installTarball(
    fs,
    { tarball: tarballUrl(ctx.env), integrity: NPM_INTEGRITY },
    NPM_ROOT,
    ctx.pid,
  );
}

/** A runtime for `npm` (`npm-cli.js`) or `npx` (`npx-cli.js`). */
export function npmRuntime(tool: 'npm' | 'npx'): (ctx: ProcessContext) => Promise<number> {
  return async (ctx) => {
    const fs = createFs(
      ctx.syscall,
      createPosixPath(() => ctx.cwd),
    );
    if (installedVersion(fs) !== NPM_VERSION) {
      try {
        await installNpm(ctx, fs);
      } catch (e) {
        ctx.stderr.write(`${tool}: cannot install npm ${NPM_VERSION}: ${(e as Error).message}\n`);
        return 1;
      }
    }
    return nodeRuntime({
      ...ctx,
      // The pinned npm cannot be upgraded in place, so its upgrade notice is noise.
      env: { npm_config_update_notifier: 'false', ...ctx.env },
      argv: ['node', `${NPM_ROOT}/bin/${tool}-cli.js`, ...ctx.argv.slice(1)],
    });
  };
}
