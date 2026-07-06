// SPDX-License-Identifier: Apache-2.0
import { SystemError } from '@clientvm/protocol';
import type { StatData } from '@clientvm/protocol';

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export type DirentType = 'file' | 'dir';

export interface Dirent {
  name: string;
  type: DirentType;
}

interface InodeBase {
  ino: number;
  mode: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface FileInode extends InodeBase {
  kind: 'file';
  data: Uint8Array;
}

interface DirInode extends InodeBase {
  kind: 'dir';
  entries: Map<string, number>;
}

type Inode = FileInode | DirInode;

const DEV = 1;
const BLKSIZE = 4096;

/**
 * Synchronous in-memory filesystem. Owned by the kernel; paths must be
 * absolute (relative resolution against a process cwd happens in the caller).
 *
 * Symlinks, watchers, quotas and copy-on-write snapshots are Phase 2.
 */
export class MemoryVfs {
  private readonly inodes = new Map<number, Inode>();
  private nextIno = 1;
  private readonly rootIno: number;

  constructor() {
    this.rootIno = this.allocDir(0o755).ino;
  }

  stat(path: string): StatData {
    return this.toStat(this.lookup(path, 'stat'));
  }

  /** No symlinks yet, so identical to {@link stat}. */
  lstat(path: string): StatData {
    return this.toStat(this.lookup(path, 'lstat'));
  }

  /** Entry names in lexicographic (UTF-16 code unit) order. */
  readdir(path: string): string[] {
    return this.readdirTyped(path).map((d) => d.name);
  }

  readdirTyped(path: string): Dirent[] {
    const node = this.lookup(path, 'scandir');
    if (node.kind !== 'dir') throw new SystemError('ENOTDIR', 'scandir', path);
    node.atimeMs = Date.now();
    return [...node.entries.keys()].sort().map((name) => ({
      name,
      type: this.get(node.entries.get(name)!).kind,
    }));
  }

  /**
   * Returns the file's contents. The returned view aliases VFS storage and
   * must be treated as read-only; copy before handing it to untrusted code.
   */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path, 'open');
    if (node.kind !== 'file') throw new SystemError('EISDIR', 'read');
    node.atimeMs = Date.now();
    return node.data;
  }

  /** Creates or truncates `path`. The parent directory must exist. */
  writeFile(path: string, data: Uint8Array, mode = 0o644): void {
    const { parent, name } = this.lookupParent(path, 'open');
    const existingIno = parent.entries.get(name);
    const now = Date.now();
    if (existingIno !== undefined) {
      const existing = this.get(existingIno);
      if (existing.kind !== 'file') throw new SystemError('EISDIR', 'open', path);
      existing.data = data.slice();
      existing.mtimeMs = existing.ctimeMs = now;
      return;
    }
    if (path.endsWith('/')) throw new SystemError('EISDIR', 'open', path);
    const file = this.alloc<FileInode>({
      kind: 'file',
      mode: S_IFREG | (mode & 0o7777),
      data: data.slice(),
    });
    parent.entries.set(name, file.ino);
    parent.mtimeMs = parent.ctimeMs = now;
  }

  /**
   * Node semantics: returns undefined when not recursive; when recursive,
   * returns the first directory created, or undefined if it already existed.
   */
  mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): string | undefined {
    const mode = options.mode ?? 0o777;
    if (!options.recursive) {
      const { parent, name } = this.lookupParent(path, 'mkdir');
      if (parent.entries.has(name)) throw new SystemError('EEXIST', 'mkdir', path);
      this.link(parent, name, this.allocDir(mode));
      return undefined;
    }

    const parts = splitPath(path, 'mkdir');
    let dir = this.get(this.rootIno) as DirInode;
    let first: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const childIno = dir.entries.get(name);
      if (childIno === undefined) {
        const created = this.allocDir(mode);
        this.link(dir, name, created);
        first ??= '/' + parts.slice(0, i + 1).join('/');
        dir = created;
        continue;
      }
      const child = this.get(childIno);
      if (child.kind !== 'dir') {
        throw new SystemError(i === parts.length - 1 ? 'EEXIST' : 'ENOTDIR', 'mkdir', path);
      }
      dir = child;
    }
    return first;
  }

  private lookup(path: string, syscall: string): Inode {
    const parts = splitPath(path, syscall);
    let node: Inode = this.get(this.rootIno);
    for (const name of parts) {
      if (node.kind !== 'dir') throw new SystemError('ENOTDIR', syscall, path);
      const next = node.entries.get(name);
      if (next === undefined) throw new SystemError('ENOENT', syscall, path);
      node = this.get(next);
    }
    if (path.endsWith('/') && node.kind !== 'dir') throw new SystemError('ENOTDIR', syscall, path);
    return node;
  }

  private lookupParent(path: string, syscall: string): { parent: DirInode; name: string } {
    const parts = splitPath(path, syscall);
    const name = parts.pop();
    if (name === undefined) throw new SystemError('EEXIST', syscall, path);
    let node: Inode = this.get(this.rootIno);
    for (const part of parts) {
      if (node.kind !== 'dir') throw new SystemError('ENOTDIR', syscall, path);
      const next = node.entries.get(part);
      if (next === undefined) throw new SystemError('ENOENT', syscall, path);
      node = this.get(next);
    }
    if (node.kind !== 'dir') throw new SystemError('ENOTDIR', syscall, path);
    return { parent: node, name };
  }

  private link(parent: DirInode, name: string, child: DirInode): void {
    parent.entries.set(name, child.ino);
    parent.nlink++;
    parent.mtimeMs = parent.ctimeMs = Date.now();
  }

  private get(ino: number): Inode {
    const node = this.inodes.get(ino);
    if (!node) throw new Error(`vfs: dangling inode ${ino}`);
    return node;
  }

  private allocDir(mode: number): DirInode {
    return this.alloc<DirInode>({
      kind: 'dir',
      mode: S_IFDIR | (mode & 0o7777),
      entries: new Map(),
    });
  }

  private alloc<T extends Inode>(fields: Omit<T, keyof InodeBase> & { mode: number }): T {
    const now = Date.now();
    const node = {
      ...fields,
      ino: this.nextIno++,
      nlink: fields.kind === 'dir' ? 2 : 1,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
    } as T;
    this.inodes.set(node.ino, node);
    return node;
  }

  private toStat(node: Inode): StatData {
    const size = node.kind === 'file' ? node.data.length : BLKSIZE;
    return {
      dev: DEV,
      ino: node.ino,
      mode: node.mode,
      nlink: node.nlink,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: BLKSIZE,
      blocks: Math.ceil(size / 512),
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    };
  }
}

/** Splits an absolute path into normalized components, resolving `.` and `..`. */
function splitPath(path: string, syscall: string): string[] {
  if (!path.startsWith('/')) throw new SystemError('EINVAL', syscall, path);
  if (path.includes('\0')) throw new SystemError('EINVAL', syscall, path);
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}
