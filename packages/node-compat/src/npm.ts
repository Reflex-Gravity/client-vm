// SPDX-License-Identifier: Apache-2.0
// `npm` and `npx`: the real, unmodified npm CLI on the node runtime. On first
// use the pinned npm release is downloaded from the registry, its SHA-512
// integrity checked, and unpacked into the global prefix
// (/usr/local/lib/node_modules/npm), where Node installs keep it too.

import type { ProcessContext } from '@clientvm/process';
import { createFs } from './fs.ts';
import { nodeRuntime } from './node-main.ts';
import { createPosixPath } from './path.ts';
import { readTar } from './tar.ts';
import { createZlib } from './zlib.ts';

/** The npm release Node.js 24 LTS bundles (ADR 0012). */
export const NPM_VERSION = '11.6.1';
const NPM_INTEGRITY =
  'sha512-7iDSHDoup6uMQJ37yWrhfqcbMhF0UEfGRap6Nv+aKQcrIJXlCi2cKbj75WBmiHlcwsQCy/U0zEwDZdAx6H/Vaw==';
const NPM_ROOT = '/usr/local/lib/node_modules/npm';

/** Where the npm tarball comes from; `CLIENTVM_NPM_TARBALL` overrides it (mirrors, tests). */
function tarballUrl(env: Record<string, string>): string {
  return env['CLIENTVM_NPM_TARBALL'] ?? `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
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
  const url = tarballUrl(ctx.env);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', tgz));
  if (`sha512-${base64(digest)}` !== NPM_INTEGRITY) {
    throw new Error(`integrity check failed for ${url}`);
  }
  const zlib = createZlib(() => {
    throw new Error('zlib streams are not needed here');
  });
  const tar = (zlib['gunzipSync'] as (b: Uint8Array) => Uint8Array)(tgz);

  // Unpack beside the target, then rename, so a half-written npm is never used.
  const staging = `${NPM_ROOT}.staging-${ctx.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of readTar(tar)) {
    const rel = entry.path.replace(/^package\//, '').replace(/\/$/, '');
    if (!rel || rel.split('/').some((part) => part === '..')) continue;
    const dest = `${staging}/${rel}`;
    if (entry.type === 'dir') {
      fs.mkdirSync(dest, { recursive: true });
    } else if (entry.type === 'file') {
      fs.mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(dest, entry.data);
      // npm's packed modes are often 0644 even for bins; its bins run through node.
      fs.chmodSync(dest, entry.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  fs.rmSync(NPM_ROOT, { recursive: true, force: true });
  fs.renameSync(staging, NPM_ROOT);
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
      argv: ['node', `${NPM_ROOT}/bin/${tool}-cli.js`, ...ctx.argv.slice(1)],
    });
  };
}
