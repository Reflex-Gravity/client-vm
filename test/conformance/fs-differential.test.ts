// SPDX-License-Identifier: Apache-2.0
// Runs the same operation script against real node:fs (in a temp dir) and the
// ClientVM MemoryVfs, and requires identical results and error codes.
// Linux is the reference. Scripts marked `linuxOnly` exercise syscalls whose
// semantics differ on macOS (e.g. link(2) following symlinks); they run in CI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVfs } from '@clientvm/vfs';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeTarget, outcome, vfsTarget } from './fs-harness.ts';
import type { Step } from './fs-harness.ts';

const isLinux = process.platform === 'linux';

const scripts: Record<string, { steps: Step[]; linuxOnly?: boolean }> = {
  'create and read files': {
    steps: [
      { op: 'mkdir', path: '/src' },
      { op: 'write', path: '/src/index.js', data: 'console.log(1)' },
      { op: 'read', path: '/src/index.js' },
      { op: 'stat', path: '/src/index.js' },
      { op: 'stat', path: '/src' },
      { op: 'readdir', path: '/src' },
      { op: 'write', path: '/src/index.js', data: 'overwritten' },
      { op: 'read', path: '/src/index.js' },
    ],
  },
  'recursive mkdir return values': {
    steps: [
      { op: 'mkdir', path: '/a/b/c', recursive: true },
      { op: 'mkdir', path: '/a/b/c', recursive: true },
      { op: 'mkdir', path: '/a/b/d', recursive: true },
      { op: 'readdir', path: '/a/b' },
    ],
  },
  'error codes': {
    steps: [
      { op: 'read', path: '/missing' },
      { op: 'mkdir', path: '/x/y' },
      { op: 'mkdir', path: '/d' },
      { op: 'mkdir', path: '/d' },
      { op: 'read', path: '/d' },
      { op: 'write', path: '/d', data: '' },
      { op: 'write', path: '/f', data: 'x' },
      { op: 'read', path: '/f/inside' },
      { op: 'readdir', path: '/f' },
      { op: 'mkdir', path: '/f', recursive: true },
      { op: 'mkdir', path: '/f/sub', recursive: true },
      { op: 'write', path: '/nodir/file', data: '' },
      { op: 'stat', path: '/missing/deeper' },
    ],
  },
  'dot segments': {
    steps: [
      { op: 'mkdir', path: '/p/q', recursive: true },
      { op: 'write', path: '/p/q/../file', data: 'dots' },
      { op: 'read', path: '/p/./file' },
      { op: 'readdir', path: '/p/q/..' },
    ],
  },
  'unicode names': {
    steps: [
      { op: 'write', path: '/héllo-日本.txt', data: '😀' },
      { op: 'read', path: '/héllo-日本.txt' },
      { op: 'stat', path: '/héllo-日本.txt' },
    ],
  },
  'unlink and rmdir': {
    steps: [
      { op: 'mkdir', path: '/d' },
      { op: 'write', path: '/d/f', data: 'x' },
      { op: 'rmdir', path: '/d' },
      { op: 'rmdir', path: '/d/f' },
      { op: 'unlink', path: '/d/f' },
      { op: 'unlink', path: '/d/f' },
      { op: 'rmdir', path: '/d' },
      { op: 'readdir', path: '/' },
      { op: 'rmdir', path: '/nope' },
    ],
  },
  'recursive removal': {
    steps: [
      { op: 'mkdir', path: '/t/a/b', recursive: true },
      { op: 'write', path: '/t/a/b/f', data: '1' },
      { op: 'write', path: '/t/g', data: '2' },
      { op: 'symlink', target: '/t/a', path: '/t/link' },
      { op: 'rmTree', path: '/t' },
      { op: 'readdir', path: '/' },
      { op: 'rmTree', path: '/t' },
    ],
  },
  'rename files and directories': {
    steps: [
      { op: 'mkdir', path: '/a/inner', recursive: true },
      { op: 'write', path: '/a/inner/f', data: 'moved' },
      { op: 'write', path: '/x', data: 'x' },
      { op: 'write', path: '/y', data: 'y' },
      { op: 'rename', from: '/x', to: '/y' },
      { op: 'read', path: '/y' },
      { op: 'rename', from: '/a', to: '/b' },
      { op: 'read', path: '/b/inner/f' },
      { op: 'rename', from: '/b', to: '/b/inner/deeper' },
      { op: 'mkdir', path: '/empty' },
      { op: 'rename', from: '/b/inner', to: '/empty' },
      { op: 'readdir', path: '/empty' },
      { op: 'mkdir', path: '/full/child', recursive: true },
      { op: 'rename', from: '/empty', to: '/full' },
      { op: 'rename', from: '/y', to: '/full' },
      { op: 'rename', from: '/full', to: '/y' },
      { op: 'rename', from: '/missing', to: '/z' },
      { op: 'rename', from: '/y', to: '/y' },
      { op: 'rename', from: '/y', to: '/nodir/y' },
    ],
  },
  symlinks: {
    steps: [
      { op: 'mkdir', path: '/real/sub', recursive: true },
      { op: 'write', path: '/real/sub/f.txt', data: 'through link' },
      { op: 'symlink', target: '/real', path: '/abs' },
      { op: 'symlink', target: 'real/sub', path: '/rel' },
      { op: 'symlink', target: '../real/sub/f.txt', path: '/real/up' },
      { op: 'read', path: '/abs/sub/f.txt' },
      { op: 'read', path: '/rel/f.txt' },
      { op: 'read', path: '/real/up' },
      { op: 'readlink', path: '/rel' },
      { op: 'readlink', path: '/real/up' },
      { op: 'readlink', path: '/real' },
      { op: 'lstat', path: '/abs' },
      { op: 'stat', path: '/abs' },
      { op: 'realpath', path: '/abs/sub/../sub/f.txt' },
      { op: 'realpath', path: '/rel' },
      { op: 'readdir', path: '/abs' },
      { op: 'symlink', target: '/nowhere', path: '/dangling' },
      { op: 'stat', path: '/dangling' },
      { op: 'lstat', path: '/dangling' },
      { op: 'write', path: '/dangling', data: 'created via link' },
      { op: 'read', path: '/nowhere' },
      { op: 'symlink', target: '/x', path: '/abs' },
      { op: 'symlink', target: '/loop2', path: '/loop1' },
      { op: 'symlink', target: '/loop1', path: '/loop2' },
      { op: 'read', path: '/loop1' },
      { op: 'unlink', path: '/abs' },
      { op: 'stat', path: '/real/sub/f.txt' },
    ],
  },
  'symlink to directory with dotdot is physical': {
    steps: [
      { op: 'mkdir', path: '/deep/er', recursive: true },
      { op: 'write', path: '/deep/marker', data: 'physical parent' },
      { op: 'symlink', target: '/deep/er', path: '/shortcut' },
      { op: 'read', path: '/shortcut/../marker' },
    ],
  },
  'file descriptors': {
    steps: [
      { op: 'fdWrite', path: '/f', flags: 'w', data: 'hello' },
      { op: 'fdWrite', path: '/f', flags: 'a', data: ' world' },
      { op: 'read', path: '/f' },
      { op: 'fdWrite', path: '/f', flags: 'r+', data: 'J', position: 0 },
      { op: 'read', path: '/f' },
      { op: 'fdWrite', path: '/f', flags: 'r+', data: '!', position: 15 },
      { op: 'stat', path: '/f' },
      { op: 'fdRead', path: '/f', length: 5, position: 6 },
      { op: 'fdRead', path: '/f', length: 10, position: 100 },
      { op: 'fdWrite', path: '/f', flags: 'wx', data: 'x' },
      { op: 'fdWrite', path: '/new', flags: 'wx', data: 'x' },
      { op: 'fdWrite', path: '/missing', flags: 'r+', data: 'x' },
      { op: 'fdRead', path: '/missing', length: 1, position: 0 },
      { op: 'mkdir', path: '/dir' },
      { op: 'fdWrite', path: '/dir', flags: 'w', data: 'x' },
    ],
  },
  'truncate, chmod, copyFile': {
    steps: [
      { op: 'write', path: '/f', data: 'abcdef' },
      { op: 'truncate', path: '/f', length: 3 },
      { op: 'read', path: '/f' },
      { op: 'truncate', path: '/f', length: 5 },
      { op: 'stat', path: '/f' },
      { op: 'truncate', path: '/missing', length: 0 },
      { op: 'chmod', path: '/f', mode: 0o600 },
      { op: 'stat', path: '/f' },
      { op: 'copyFile', src: '/f', dest: '/g' },
      { op: 'read', path: '/g' },
      { op: 'stat', path: '/g' },
      { op: 'copyFile', src: '/f', dest: '/g', exclusive: true },
      { op: 'copyFile', src: '/missing', dest: '/h' },
      { op: 'mkdir', path: '/d' },
      { op: 'copyFile', src: '/f', dest: '/d' },
    ],
  },
  'hard links': {
    linuxOnly: true,
    steps: [
      { op: 'write', path: '/a', data: 'shared' },
      { op: 'link', existing: '/a', path: '/b' },
      { op: 'stat', path: '/a' },
      { op: 'fdWrite', path: '/b', flags: 'a', data: '+' },
      { op: 'read', path: '/a' },
      { op: 'unlink', path: '/a' },
      { op: 'stat', path: '/b' },
      { op: 'link', existing: '/b', path: '/b' },
      { op: 'mkdir', path: '/d' },
      { op: 'link', existing: '/d', path: '/e' },
      { op: 'symlink', target: '/b', path: '/s' },
      { op: 'link', existing: '/s', path: '/t' },
      { op: 'lstat', path: '/t' },
      { op: 'rename', from: '/b', to: '/t' },
      { op: 'readdir', path: '/' },
    ],
  },
  'linux-specific error codes': {
    linuxOnly: true,
    steps: [
      { op: 'mkdir', path: '/d' },
      { op: 'unlink', path: '/d' },
      { op: 'write', path: '/f', data: 'x' },
      { op: 'read', path: '/f/' },
      { op: 'rename', from: '/f', to: '/g/' },
      { op: 'symlink', target: '/f', path: '/s' },
      { op: 'read', path: '/s/' },
    ],
  },
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('fs differential: MemoryVfs vs node:fs', () => {
  for (const [name, { steps, linuxOnly }] of Object.entries(scripts)) {
    it.skipIf(linuxOnly && !isLinux)(name, () => {
      const root = mkdtempSync(join(tmpdir(), 'clientvm-fsdiff-'));
      roots.push(root);
      const reference = nodeTarget(root);
      const subject = vfsTarget(new MemoryVfs());
      for (const step of steps) {
        expect(outcome(subject, step), JSON.stringify(step)).toEqual(outcome(reference, step));
      }
    });
  }
});
