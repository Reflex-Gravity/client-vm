// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { MemoryVfs, S_IFDIR, S_IFMT, S_IFREG } from './memory-vfs.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('MemoryVfs', () => {
  it('starts with an empty root directory', () => {
    const vfs = new MemoryVfs();
    expect(vfs.readdir('/')).toEqual([]);
    expect(vfs.stat('/').mode & S_IFMT).toBe(S_IFDIR);
  });

  it('writes, reads and overwrites files', () => {
    const vfs = new MemoryVfs();
    vfs.writeFile('/a.txt', bytes('one'));
    expect(text(vfs.readFile('/a.txt'))).toBe('one');
    vfs.writeFile('/a.txt', bytes('two!'));
    expect(text(vfs.readFile('/a.txt'))).toBe('two!');
    const st = vfs.stat('/a.txt');
    expect(st.mode & S_IFMT).toBe(S_IFREG);
    expect(st.size).toBe(4);
  });

  it('copies written data so callers cannot mutate storage', () => {
    const vfs = new MemoryVfs();
    const data = bytes('abc');
    vfs.writeFile('/f', data);
    data[0] = 0;
    expect(text(vfs.readFile('/f'))).toBe('abc');
  });

  it('lists directories in sorted order, with types', () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/d');
    vfs.writeFile('/d/b', bytes(''));
    vfs.mkdir('/d/a');
    vfs.writeFile('/d/C', bytes(''));
    expect(vfs.readdir('/d')).toEqual(['C', 'a', 'b']);
    expect(vfs.readdirTyped('/d')).toEqual([
      { name: 'C', type: 'file' },
      { name: 'a', type: 'dir' },
      { name: 'b', type: 'file' },
    ]);
  });

  it('normalizes . and .. and repeated slashes', () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/x/y', { recursive: true });
    vfs.writeFile('/x/y/f', bytes('ok'));
    expect(text(vfs.readFile('//x/./y/../y//f'))).toBe('ok');
    expect(vfs.readdir('/..')).toEqual(['x']);
  });

  it('mkdir follows Node semantics for recursive and non-recursive calls', () => {
    const vfs = new MemoryVfs();
    expect(vfs.mkdir('/a/b/c', { recursive: true })).toBe('/a');
    expect(vfs.mkdir('/a/b/c', { recursive: true })).toBeUndefined();
    expect(vfs.mkdir('/a/b/d')).toBeUndefined();
    expect(codeOf(() => vfs.mkdir('/a'))).toBe('EEXIST');
    expect(codeOf(() => vfs.mkdir('/missing/child'))).toBe('ENOENT');
    expect(codeOf(() => vfs.mkdir('/'))).toBe('EEXIST');
    vfs.writeFile('/file', bytes(''));
    expect(codeOf(() => vfs.mkdir('/file', { recursive: true }))).toBe('EEXIST');
    expect(codeOf(() => vfs.mkdir('/file/sub', { recursive: true }))).toBe('ENOTDIR');
  });

  it('reports errno codes like Linux', () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/dir');
    vfs.writeFile('/file', bytes('x'));
    expect(codeOf(() => vfs.readFile('/nope'))).toBe('ENOENT');
    expect(codeOf(() => vfs.readFile('/dir'))).toBe('EISDIR');
    expect(codeOf(() => vfs.readFile('/file/x'))).toBe('ENOTDIR');
    expect(codeOf(() => vfs.readFile('/file/'))).toBe('ENOTDIR');
    expect(codeOf(() => vfs.readdir('/file'))).toBe('ENOTDIR');
    expect(codeOf(() => vfs.writeFile('/dir', bytes('')))).toBe('EISDIR');
    expect(codeOf(() => vfs.writeFile('/nope/f', bytes('')))).toBe('ENOENT');
    expect(codeOf(() => vfs.writeFile('/new/', bytes('')))).toBe('EISDIR');
    expect(codeOf(() => vfs.stat('relative'))).toBe('EINVAL');
  });

  it('tracks nlink for directories', () => {
    const vfs = new MemoryVfs();
    vfs.mkdir('/p');
    expect(vfs.stat('/p').nlink).toBe(2);
    vfs.mkdir('/p/c1');
    vfs.mkdir('/p/c2');
    vfs.writeFile('/p/f', bytes(''));
    expect(vfs.stat('/p').nlink).toBe(4);
  });
});
