// SPDX-License-Identifier: Apache-2.0
// Unix-style command resolution. Commands are files: built-in runtimes are
// marker files (`#!/clientvm/builtin node`) in /usr/local/bin, and scripts run
// through their shebang interpreter, so PATH lookup, node_modules/.bin
// symlinks, `#!/usr/bin/env node` and exec permissions behave as on Linux.

import { BUILTIN_MARKER, SystemError } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';
import { S_IFDIR, S_IFMT } from '@clientvm/vfs';

export const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
const BIN_DIR = '/usr/local/bin';
const MAX_INTERPRETER_DEPTH = 4;

/** The environment a process started by the controller gets unless overridden. */
export const DEFAULT_ENV: Readonly<Record<string, string>> = {
  PATH: DEFAULT_PATH,
  HOME: '/home/user',
  USER: 'user',
  LOGNAME: 'user',
  SHELL: '/bin/sh',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  // esbuild's native binary cannot run; this launcher runs esbuild-wasm instead (ADR 0013).
  ESBUILD_BINARY_PATH: '/usr/local/lib/clientvm/bin/esbuild',
};

/** Well-known paths scripts hard-code (`#!/bin/sh`, `#!/bin/bash`, `/usr/bin/env`). */
const WELL_KNOWN_PATHS: Readonly<Record<string, string>> = {
  sh: '/bin/sh',
  bash: '/bin/bash',
  env: '/usr/bin/env',
  'clientvm-esbuild': '/usr/local/lib/clientvm/bin/esbuild',
};

/**
 * Writes (or refreshes) a marker file for each built-in runtime in
 * /usr/local/bin, plus /bin/sh, /bin/bash and /usr/bin/env when those exist.
 */
export function installBuiltinCommands(vfs: MemoryVfs, names: readonly string[]): void {
  vfs.mkdir(BIN_DIR, { recursive: true });
  for (const name of names) {
    const marker = new TextEncoder().encode(`${BUILTIN_MARKER}${name}\n`);
    vfs.writeFile(`${BIN_DIR}/${name}`, marker, 0o755);
    const alias = WELL_KNOWN_PATHS[name];
    if (alias) {
      vfs.mkdir(alias.slice(0, alias.lastIndexOf('/')), { recursive: true });
      vfs.writeFile(alias, marker, 0o755);
    }
  }
}

function spawnError(code: 'ENOENT' | 'EACCES' | 'ENOEXEC', command: string): SystemError {
  return new SystemError(code, `spawn ${command}`, command);
}

function joinPath(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  const parts = `${dir}/${name}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

/**
 * Resolves argv[0] to a built-in runtime and returns the argv the runtime
 * receives (argv[0] = runtime name). Throws Node-shaped spawn errors.
 */
export function resolveCommand(
  vfs: MemoryVfs,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  depth = 0,
): string[] {
  const command = argv[0];
  if (!command) throw spawnError('ENOENT', '');
  if (depth > MAX_INTERPRETER_DEPTH) throw spawnError('ENOEXEC', command);

  let file: string | undefined;
  if (command.includes('/')) {
    file = joinPath(cwd, command);
    if (!exists(vfs, file)) throw spawnError('ENOENT', command);
  } else {
    for (const dir of (env['PATH'] ?? DEFAULT_PATH).split(':')) {
      const candidate = joinPath(dir === '' ? cwd : joinPath(cwd, dir), command);
      if (exists(vfs, candidate) && !isDir(vfs, candidate)) {
        file = candidate;
        break;
      }
    }
    if (!file) throw spawnError('ENOENT', command);
  }

  const mode = vfs.stat(file).mode;
  if ((mode & S_IFMT) === S_IFDIR || (mode & 0o111) === 0) throw spawnError('EACCES', command);

  const head =
    new TextDecoder().decode(vfs.readFile(file).subarray(0, 256)).split('\n', 1)[0] ?? '';
  if (head.startsWith(BUILTIN_MARKER))
    return [head.slice(BUILTIN_MARKER.length).trim(), ...argv.slice(1)];
  if (!head.startsWith('#!')) throw spawnError('ENOEXEC', command);

  // #!/usr/bin/env node, #!/usr/bin/env -S node --flag, #!/usr/local/bin/node --flag
  let [interpreter = '', ...interpreterArgs] = head.slice(2).trim().split(/\s+/);
  if (interpreter.endsWith('/env') || interpreter === 'env') {
    if (interpreterArgs[0] === '-S') interpreterArgs = interpreterArgs.slice(1);
    interpreter = interpreterArgs.shift() ?? '';
  }
  if (!interpreter) throw spawnError('ENOEXEC', command);
  return resolveCommand(
    vfs,
    [interpreter, ...interpreterArgs, file, ...argv.slice(1)],
    env,
    cwd,
    depth + 1,
  );
}

function exists(vfs: MemoryVfs, path: string): boolean {
  try {
    vfs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function isDir(vfs: MemoryVfs, path: string): boolean {
  return (vfs.stat(path).mode & S_IFMT) === S_IFDIR;
}
