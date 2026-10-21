// SPDX-License-Identifier: Apache-2.0
import { MemoryVfs } from '@clientvm/vfs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENV, installBuiltinCommands, resolveCommand } from './commands.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function setup(): MemoryVfs {
  const vfs = new MemoryVfs();
  installBuiltinCommands(vfs, ['node', 'sh']);
  vfs.mkdir('/proj/node_modules/.bin', { recursive: true });
  vfs.mkdir('/proj/node_modules/vite/bin', { recursive: true });
  vfs.writeFile(
    '/proj/node_modules/vite/bin/vite.js',
    enc('#!/usr/bin/env node\nconsole.log(1)'),
    0o755,
  );
  vfs.symlink('../vite/bin/vite.js', '/proj/node_modules/.bin/vite');
  vfs.writeFile('/proj/flags.js', enc('#!/usr/bin/env -S node --no-warnings\n'), 0o755);
  vfs.writeFile('/proj/direct.js', enc('#!/usr/local/bin/node\n'), 0o755);
  vfs.writeFile('/proj/noexec.js', enc('#!/usr/bin/env node\n'), 0o644);
  vfs.writeFile('/proj/plain.txt', enc('hello'), 0o755);
  vfs.writeFile('/proj/py.sh', enc('#!/usr/bin/python3\n'), 0o755);
  return vfs;
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return `${(e as { code: string }).code} ${(e as { syscall: string }).syscall}`;
  }
};

describe('resolveCommand', () => {
  const env = { ...DEFAULT_ENV, PATH: `/proj/node_modules/.bin:${DEFAULT_ENV['PATH']}` };

  it('finds built-ins on PATH and keeps arguments', () => {
    expect(resolveCommand(setup(), ['node', '-e', '1'], DEFAULT_ENV, '/')).toEqual([
      'node',
      '-e',
      '1',
    ]);
  });

  it('runs scripts through their shebang interpreter, via node_modules/.bin symlinks', () => {
    const vfs = setup();
    expect(resolveCommand(vfs, ['vite', '--port', '3000'], env, '/proj')).toEqual([
      'node',
      '/proj/node_modules/.bin/vite',
      '--port',
      '3000',
    ]);
    expect(resolveCommand(vfs, ['./flags.js', 'x'], env, '/proj')).toEqual([
      'node',
      '--no-warnings',
      '/proj/flags.js',
      'x',
    ]);
    expect(resolveCommand(vfs, ['/proj/direct.js'], env, '/')).toEqual(['node', '/proj/direct.js']);
  });

  it('reports spawn errors like Linux/Node', () => {
    const vfs = setup();
    expect(codeOf(() => resolveCommand(vfs, ['nope'], env, '/proj'))).toBe('ENOENT spawn nope');
    expect(codeOf(() => resolveCommand(vfs, ['./noexec.js'], env, '/proj'))).toBe(
      'EACCES spawn ./noexec.js',
    );
    expect(codeOf(() => resolveCommand(vfs, ['/proj'], env, '/'))).toBe('EACCES spawn /proj');
    expect(codeOf(() => resolveCommand(vfs, ['./plain.txt'], env, '/proj'))).toBe(
      'ENOEXEC spawn ./plain.txt',
    );
    expect(codeOf(() => resolveCommand(vfs, ['./py.sh'], env, '/proj'))).toBe(
      'ENOENT spawn /usr/bin/python3',
    );
    expect(codeOf(() => resolveCommand(vfs, ['vite'], DEFAULT_ENV, '/proj'))).toBe(
      'ENOENT spawn vite',
    );
  });
});
