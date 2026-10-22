// SPDX-License-Identifier: Apache-2.0
// Golden fixtures (test/fixtures/<name>): installed once with the host's npm
// (`npm ci` from the committed lockfile, cached by its hash) and loaded into an
// instance as a file tree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const CACHE = join(ROOT, 'node_modules', '.cache', 'clientvm-fixtures');

export interface FileTree {
  [name: string]: string | Uint8Array | FileTree;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text when the bytes are valid UTF-8 without NULs, else the bytes (wasm, images). */
function contents(bytes: Buffer): string | Uint8Array {
  if (!bytes.includes(0)) {
    try {
      return utf8.decode(bytes);
    } catch {
      // binary
    }
  }
  return new Uint8Array(bytes);
}

/**
 * The platform ClientVM reports (process.platform/arch, glibc), so optional
 * native packages are the ones npm would pick inside an instance, whatever the
 * host running the tests is.
 */
const PLATFORM = ['--os=linux', '--cpu=x64', '--libc=glibc'];

/** Returns the path of an installed copy of fixture `name`. */
export function installFixture(name: string): string {
  const src = join(ROOT, 'test', 'fixtures', name);
  const lock = readFileSync(join(src, 'package-lock.json'));
  const hash = createHash('sha256')
    .update(lock)
    .update(readFileSync(join(src, 'package.json')))
    .update(PLATFORM.join(' '))
    .digest('hex')
    .slice(0, 12);
  const dest = join(CACHE, `${name}-${hash}`);
  if (!existsSync(join(dest, 'node_modules'))) {
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    cpSync(src, tmp, { recursive: true });
    execFileSync(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...PLATFORM],
      { cwd: tmp, stdio: 'inherit' },
    );
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  // Fixture sources may change without touching the lockfile.
  for (const entry of readdirSync(src)) {
    if (entry !== 'node_modules') cpSync(join(src, entry), join(dest, entry), { recursive: true });
  }
  return dest;
}

/** Reads a directory into a file tree (symlinks and `.bin` are skipped). */
export function readTree(dir: string): FileTree {
  const tree: FileTree = {};
  for (const name of readdirSync(dir)) {
    if (name === '.bin' || name === '.package-lock.json') continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) tree[name] = readTree(path);
    else if (st.isFile()) tree[name] = contents(readFileSync(path));
  }
  return tree;
}

/** The installed fixture as a file tree. */
export function fixtureTree(name: string): FileTree {
  return readTree(installFixture(name));
}
