// SPDX-License-Identifier: Apache-2.0
// Runs the same operation script against real node:fs (in a temp dir) and the
// ClientVM MemoryVfs, and requires identical results and error codes.
// Note: the reference must be a case-sensitive filesystem for case tests; CI runs on Linux.
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVfs } from '@clientvm/vfs';
import { afterAll, describe, expect, it } from 'vitest';

type Step =
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'write'; path: string; data: string }
  | { op: 'read'; path: string }
  | { op: 'readdir'; path: string }
  | { op: 'stat'; path: string };

type Outcome = { ok: unknown } | { error: string | undefined };

interface Target {
  run(step: Step): unknown;
}

function nodeTarget(root: string): Target {
  const p = (path: string) => join(root, path);
  return {
    run(step) {
      switch (step.op) {
        case 'mkdir': {
          const created = mkdirSync(p(step.path), { recursive: step.recursive ?? false });
          return created === undefined ? undefined : created.slice(root.length);
        }
        case 'write':
          return writeFileSync(p(step.path), step.data);
        case 'read':
          return readFileSync(p(step.path), 'utf8');
        case 'readdir':
          return readdirSync(p(step.path)).sort();
        case 'stat': {
          const s = statSync(p(step.path));
          return { file: s.isFile(), dir: s.isDirectory(), size: s.isFile() ? s.size : null };
        }
      }
    },
  };
}

function vfsTarget(vfs: MemoryVfs): Target {
  return {
    run(step) {
      switch (step.op) {
        case 'mkdir':
          return vfs.mkdir(step.path, { recursive: step.recursive ?? false });
        case 'write':
          return vfs.writeFile(step.path, new TextEncoder().encode(step.data));
        case 'read':
          return new TextDecoder().decode(vfs.readFile(step.path));
        case 'readdir':
          return vfs.readdir(step.path);
        case 'stat': {
          const s = vfs.stat(step.path);
          const type = s.mode & 0o170000;
          return {
            file: type === 0o100000,
            dir: type === 0o040000,
            size: type === 0o100000 ? s.size : null,
          };
        }
      }
    },
  };
}

function outcome(target: Target, step: Step): Outcome {
  try {
    return { ok: target.run(step) };
  } catch (err) {
    return { error: (err as { code?: string }).code };
  }
}

const scripts: Record<string, Step[]> = {
  'create and read files': [
    { op: 'mkdir', path: '/src' },
    { op: 'write', path: '/src/index.js', data: 'console.log(1)' },
    { op: 'read', path: '/src/index.js' },
    { op: 'stat', path: '/src/index.js' },
    { op: 'stat', path: '/src' },
    { op: 'readdir', path: '/src' },
    { op: 'write', path: '/src/index.js', data: 'overwritten' },
    { op: 'read', path: '/src/index.js' },
  ],
  'recursive mkdir return values': [
    { op: 'mkdir', path: '/a/b/c', recursive: true },
    { op: 'mkdir', path: '/a/b/c', recursive: true },
    { op: 'mkdir', path: '/a/b/d', recursive: true },
    { op: 'readdir', path: '/a/b' },
  ],
  'error codes': [
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
  'dot segments': [
    { op: 'mkdir', path: '/p/q', recursive: true },
    { op: 'write', path: '/p/q/../file', data: 'dots' },
    { op: 'read', path: '/p/./file' },
    { op: 'readdir', path: '/p/q/..' },
  ],
  'unicode names': [
    { op: 'write', path: '/héllo-日本.txt', data: '😀' },
    { op: 'read', path: '/héllo-日本.txt' },
    { op: 'stat', path: '/héllo-日本.txt' },
  ],
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('fs differential: MemoryVfs vs node:fs', () => {
  for (const [name, steps] of Object.entries(scripts)) {
    it(name, () => {
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
