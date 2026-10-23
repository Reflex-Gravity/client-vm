// SPDX-License-Identifier: Apache-2.0
import { SystemError } from '@clientvm/protocol';
import type { ErrnoCode, StatData } from '@clientvm/protocol';
import {
  O_ACCMODE,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_TRUNC,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  INODE_OVERHEAD_BYTES,
  inodeBytes,
} from './inode.ts';
import type { DirInode, Dirent, FileInode, Inode, SymlinkInode } from './inode.ts';
import { Watchers } from './watch.ts';
import type { FsEvent, WatchListener } from './watch.ts';

const DEV = 1;
const BLKSIZE = 4096;
const ROOT_INO = 1;
const MAX_SYMLINK_HOPS = 40;
const NAME_MAX = 255;
const PATH_MAX = 4096;
const X_OK = 1;
const utf8 = new TextEncoder();

export interface VfsLimits {
  /** Bytes of file contents plus per-inode overhead the live tree may hold. */
  quotaBytes?: number;
  maxInodes?: number;
}

/** An immutable point-in-time view of a VFS, created by {@link MemoryVfs.snapshot}. */
export interface Snapshot {
  readonly inodes: ReadonlyMap<number, Readonly<Inode>>;
  readonly nextIno: number;
  readonly epoch: number;
}

/** Result of resolving a path: where the final entry lives and what (if anything) is there. */
interface Resolved {
  parentIno: number;
  name: string;
  /** Undefined when the final component does not exist. */
  ino: number | undefined;
  trailingSlash: boolean;
  /** The path's last component was '.' or '..' (which rename/rmdir/unlink reject). */
  dotLast: boolean;
}

/**
 * Synchronous in-memory filesystem with Linux semantics. Owned by one kernel;
 * paths must be absolute (callers resolve against their cwd first).
 *
 * - Path walking is physical: `..` follows the directory's real parent, and
 *   symlinks are followed with a 40-hop limit.
 * - `snapshot()` is O(inodes) and copy-on-write: unchanged inodes and file
 *   data are shared between the live tree, snapshots and forks.
 * - Access times are not updated on reads (noatime).
 */
export class MemoryVfs {
  private inodes = new Map<number, Inode>();
  private nextIno = ROOT_INO;
  private epoch = 0;
  private usedBytes = 0;
  /** Open file descriptions per inode; keeps unlinked inodes alive until closed. */
  private readonly openRefs = new Map<number, number>();
  private readonly limits: VfsLimits;
  private readonly watchers = new Watchers();
  private mutateListener: (() => void) | null = null;

  constructor(limits: VfsLimits = {}, from?: Snapshot) {
    this.limits = limits;
    if (from) {
      this.inodes = new Map(from.inodes as ReadonlyMap<number, Inode>);
      this.nextIno = from.nextIno;
      this.epoch = from.epoch + 1;
      for (const node of this.inodes.values()) this.usedBytes += inodeBytes(node);
      return;
    }
    const root = this.alloc<DirInode>({
      kind: 'dir',
      mode: S_IFDIR | 0o755,
      entries: new Map(),
      parent: ROOT_INO,
      name: '',
    });
    root.parent = root.ino;
  }

  /** Copy-on-write fork of a snapshot (in the same kernel). */
  static fromSnapshot(snapshot: Snapshot, limits: VfsLimits = {}): MemoryVfs {
    return new MemoryVfs(limits, snapshot);
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(): Snapshot {
    const snap: Snapshot = {
      inodes: new Map(this.inodes),
      nextIno: this.nextIno,
      epoch: this.epoch,
    };
    this.epoch++;
    return snap;
  }

  /** Registers a callback invoked synchronously on every mutation (used by write-behind persistence). */
  onMutate(listener: (() => void) | null): void {
    this.mutateListener = listener;
  }

  /** Bytes charged against the quota by the live tree. */
  get used(): { bytes: number; inodes: number } {
    return { bytes: this.usedBytes, inodes: this.inodes.size };
  }

  // ---------------------------------------------------------------- metadata

  stat(path: string): StatData {
    return this.toStat(this.get(this.existing(path, true, 'stat')));
  }

  lstat(path: string): StatData {
    return this.toStat(this.get(this.existing(path, false, 'lstat')));
  }

  /** Entry names in lexicographic (UTF-16 code unit) order. */
  readdir(path: string): string[] {
    return this.readdirTyped(path).map((d) => d.name);
  }

  readdirTyped(path: string): Dirent[] {
    const node = this.get(this.existing(path, true, 'scandir'));
    if (node.kind !== 'dir') throw new SystemError('ENOTDIR', 'scandir', path);
    return [...node.entries.keys()].sort().map((name) => ({
      name,
      type: this.get(node.entries.get(name)!).kind,
    }));
  }

  readlink(path: string): string {
    const node = this.get(this.existing(path, false, 'readlink'));
    if (node.kind !== 'symlink') throw new SystemError('EINVAL', 'readlink', path);
    return node.target;
  }

  realpath(path: string): string {
    const r = this.resolve(path, true, 'realpath');
    if (r.ino === undefined) throw new SystemError('ENOENT', 'realpath', path);
    const node = this.get(r.ino);
    if (node.kind === 'dir') return this.dirPath(r.ino);
    const parent = this.dirPath(r.parentIno);
    return parent === '/' ? `/${r.name}` : `${parent}/${r.name}`;
  }

  access(path: string, mode = 0): void {
    const node = this.get(this.existing(path, true, 'access'));
    // Processes run as root: only execute permission is ever denied.
    if (mode & X_OK && node.kind !== 'dir' && (node.mode & 0o111) === 0) {
      throw new SystemError('EACCES', 'access', path);
    }
  }

  chmod(path: string, mode: number): void {
    this.setPerm(this.existing(path, true, 'chmod'), mode);
  }

  utimes(path: string, atimeMs: number, mtimeMs: number): void {
    const ino = this.existing(path, true, 'utime');
    const node = this.mut(ino);
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = Date.now();
    this.emitIno('modify', ino);
  }

  // ---------------------------------------------------------------- files

  /**
   * Returns the file's contents. The returned view aliases VFS storage and
   * must be treated as read-only; copy before handing it to untrusted code.
   */
  readFile(path: string): Uint8Array {
    const node = this.get(this.existing(path, true, 'open'));
    if (node.kind === 'dir') throw new SystemError('EISDIR', 'read');
    if (node.kind !== 'file') throw new SystemError('EINVAL', 'read');
    return node.data.subarray(0, node.size);
  }

  /** Creates or truncates `path` (following symlinks). The parent directory must exist. */
  writeFile(path: string, data: Uint8Array, mode = 0o644): void {
    this.rejectCreateWithSlash(path, 'open');
    const r = this.resolve(path, true, 'open');
    if (r.ino === undefined) {
      // Through a symlink whose target ends in '/'.
      if (r.trailingSlash) throw new SystemError('EISDIR', 'open', path);
      this.createFile(r, mode, data.slice(), 'open', path);
      this.emit('create', r);
      return;
    }
    const existing = this.get(r.ino);
    if (existing.kind === 'dir') throw new SystemError('EISDIR', 'open', path);
    this.setFileData(r.ino, data.slice(), 'open', path);
    this.emit('modify', r);
  }

  truncate(path: string, length: number): void {
    const ino = this.existing(path, true, 'open');
    this.truncateIno(ino, length, 'open', path);
  }

  /**
   * libuv's copyfile: open `src`, open `dest` with O_WRONLY|O_CREAT (|O_EXCL), give it the
   * source's mode, then copy. Reading a directory source fails only after `dest` is
   * open, and libuv then unlinks `dest`.
   */
  copyFile(src: string, dest: string, exclusive = false): void {
    const err = (code: ErrnoCode) => new SystemError(code, 'copyfile', src, dest);
    const srcIno = this.existing(src, true, 'copyfile', dest);
    const srcNode = this.get(srcIno);
    this.rejectCreateWithSlash(dest, 'copyfile', src, dest);
    // O_CREAT|O_EXCL never follows a final symlink.
    const r = this.resolve(dest, !exclusive, 'copyfile', src, dest);
    if (r.ino === undefined) {
      if (r.trailingSlash) throw err('EISDIR');
      // Created, failed to read the directory, then unlinked: nothing is left.
      if (srcNode.kind === 'dir') throw err('EISDIR');
      const data = (srcNode as FileInode).data.slice(0, (srcNode as FileInode).size);
      this.createFile(r, srcNode.mode & 0o7777, data, 'copyfile', src, dest);
      this.emit('create', r);
      return;
    }
    if (exclusive) throw err('EEXIST');
    if (this.get(r.ino).kind === 'dir') throw err('EISDIR');
    if (r.ino === srcIno) return;
    if (srcNode.kind === 'dir') {
      // The existing file was truncated and chmodded through its fd before the read failed.
      this.truncateIno(r.ino, 0, 'copyfile', src);
      this.setPerm(r.ino, srcNode.mode);
      try {
        this.unlink(dest);
      } catch {
        // libuv ignores the unlink result.
      }
      throw err('EISDIR');
    }
    this.setFileData(
      r.ino,
      (srcNode as FileInode).data.slice(0, (srcNode as FileInode).size),
      'copyfile',
      src,
      dest,
    );
    this.setPerm(r.ino, srcNode.mode);
    this.emit('modify', r);
  }

  // ---------------------------------------------------------------- open file descriptions

  /**
   * open(2): resolves `path`, creating or truncating per `flags`, and takes an
   * open reference on the inode. Pair with {@link release}.
   */
  open(path: string, flags: number, mode = 0o666): number {
    // O_CREAT|O_EXCL never follows a final symlink: an existing link is EEXIST.
    const exclusive = (flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0;
    if (flags & O_CREAT) this.rejectCreateWithSlash(path, 'open');
    const r = this.resolve(path, !exclusive, 'open');
    let ino = r.ino;
    if (ino === undefined) {
      if (!(flags & O_CREAT)) throw new SystemError('ENOENT', 'open', path);
      // Through a symlink whose target ends in '/'.
      if (r.trailingSlash) throw new SystemError('EISDIR', 'open', path);
      ino = this.createFile(r, mode, new Uint8Array(0), 'open', path);
      this.emit('create', r);
    } else {
      if (flags & O_CREAT && flags & O_EXCL) throw new SystemError('EEXIST', 'open', path);
      const node = this.get(ino);
      const writable = (flags & O_ACCMODE) !== O_RDONLY;
      if (node.kind === 'dir' && (writable || flags & O_TRUNC))
        throw new SystemError('EISDIR', 'open', path);
      if (flags & O_TRUNC && writable && node.kind === 'file' && node.size > 0) {
        this.truncateIno(ino, 0, 'open', path);
      }
    }
    this.retain(ino);
    return ino;
  }

  retain(ino: number): void {
    this.openRefs.set(ino, (this.openRefs.get(ino) ?? 0) + 1);
  }

  release(ino: number): void {
    const refs = (this.openRefs.get(ino) ?? 0) - 1;
    if (refs > 0) {
      this.openRefs.set(ino, refs);
      return;
    }
    this.openRefs.delete(ino);
    const node = this.inodes.get(ino);
    if (node && node.nlink === 0) this.free(ino);
  }

  fstat(ino: number): StatData {
    return this.toStat(this.get(ino));
  }

  /** Reads up to `length` bytes at `position`. Returns a copy. */
  readAt(ino: number, length: number, position: number): Uint8Array {
    const node = this.get(ino);
    if (node.kind === 'dir') throw new SystemError('EISDIR', 'read');
    if (node.kind !== 'file') throw new SystemError('EINVAL', 'read');
    if (position >= node.size) return new Uint8Array(0);
    return node.data.slice(position, Math.min(node.size, position + length));
  }

  /** Writes `data` at `position` (or at the end when `append`). Returns the new end offset. */
  writeAt(ino: number, data: Uint8Array, position: number, append = false): number {
    const current = this.get(ino);
    if (current.kind !== 'file') throw new SystemError('EISDIR', 'write');
    // A zero-length write never extends the file.
    if (data.length === 0) return append ? current.size : position;
    const at = append ? current.size : position;
    const end = at + data.length;
    this.charge(Math.max(0, end - current.size), 0, 'write');
    const node = this.mut(ino) as FileInode;
    if (node.dataShared || end > node.data.length) {
      const capacity =
        end > node.data.length
          ? Math.max(end, Math.min(node.data.length * 2, end + (1 << 24)))
          : node.data.length;
      const next = new Uint8Array(capacity);
      next.set(node.data.subarray(0, node.size));
      node.data = next;
      node.dataShared = false;
    }
    // A write past EOF leaves a hole that reads as zeros; the buffer may hold stale bytes there.
    if (at > node.size) node.data.fill(0, node.size, at);
    node.data.set(data, at);
    if (end > node.size) {
      this.usedBytes += end - node.size;
      node.size = end;
    }
    node.mtimeMs = node.ctimeMs = Date.now();
    this.emitIno('modify', ino);
    return end;
  }

  ftruncate(ino: number, length: number): void {
    this.truncateIno(ino, length, 'ftruncate');
  }

  // ---------------------------------------------------------------- directories and links

  /**
   * Node semantics: returns undefined when not recursive; when recursive,
   * returns the first directory created, or undefined if it already existed.
   */
  mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}): string | undefined {
    const mode = options.mode ?? 0o777;
    if (!options.recursive) {
      const r = this.resolve(path, 'name', 'mkdir');
      if (r.ino !== undefined) throw new SystemError('EEXIST', 'mkdir', path);
      this.createDir(r, mode, path);
      this.emit('create', r);
      return undefined;
    }
    // Port of libuv/Node mkdirp: physical resolution, retrying after creating the
    // lexical dirname on ENOENT, so results match Node even through symlinks and '..'.
    if (!path.startsWith('/')) throw new SystemError('EINVAL', 'mkdir', path);
    const stack = [path];
    let first: string | undefined;
    while (stack.length > 0) {
      const next = stack.pop()!;
      let r: Resolved;
      try {
        r = this.resolve(next, false, 'mkdir', path);
      } catch (err) {
        const dirname = next.slice(0, next.lastIndexOf('/'));
        if (err instanceof SystemError && err.code === 'ENOENT' && dirname !== '') {
          stack.push(next, dirname);
          continue;
        }
        throw err;
      }
      if (r.ino === undefined) {
        // The final component is missing and its parent exists: create it.
        this.createDir(r, mode, path);
        first ??= next;
        this.emit('create', r);
        continue;
      }
      const existing = this.resolve(next, true, 'mkdir', path);
      if (existing.ino === undefined) {
        // A dangling symlink: mkdir(2) reports EEXIST and stat fails with ENOENT.
        throw new SystemError('ENOENT', 'mkdir', path);
      }
      if (this.get(existing.ino).kind !== 'dir') {
        throw new SystemError(stack.length > 0 ? 'ENOTDIR' : 'EEXIST', 'mkdir', path);
      }
    }
    return first;
  }

  rmdir(path: string): void {
    const r = this.resolve(path, 'name', 'rmdir');
    if (r.ino === undefined) throw new SystemError('ENOENT', 'rmdir', path);
    if (r.dotLast) {
      throw new SystemError(
        path.replace(/\/+$/, '').endsWith('..') ? 'ENOTEMPTY' : 'EINVAL',
        'rmdir',
        path,
      );
    }
    if (r.ino === ROOT_INO) throw new SystemError('EBUSY', 'rmdir', path);
    const node = this.get(r.ino);
    if (node.kind !== 'dir') throw new SystemError('ENOTDIR', 'rmdir', path);
    if (node.entries.size > 0) throw new SystemError('ENOTEMPTY', 'rmdir', path);
    this.emit('delete', r);
    this.unlinkEntry(r.parentIno, r.name);
  }

  unlink(path: string): void {
    const r = this.resolve(path, 'name', 'unlink');
    if (r.ino === undefined) throw new SystemError('ENOENT', 'unlink', path);
    const node = this.get(r.ino);
    if (node.kind === 'dir') throw new SystemError('EISDIR', 'unlink', path);
    if (r.trailingSlash) throw new SystemError('ENOTDIR', 'unlink', path);
    this.emit('delete', r);
    this.unlinkEntry(r.parentIno, r.name);
  }

  /** Removes `path` and, for directories, everything under it (rm -rf without -f). */
  rmTree(path: string): void {
    const r = this.resolve(path, false, 'rm');
    if (r.ino === undefined) throw new SystemError('ENOENT', 'rm', path);
    if (r.ino === ROOT_INO) throw new SystemError('EBUSY', 'rm', path);
    this.emit('delete', r);
    this.removeRecursive(r.parentIno, r.name);
  }

  symlink(target: string, path: string): void {
    if (target.length === 0) throw new SystemError('ENOENT', 'symlink', target, path);
    const r = this.resolve(path, 'name', 'symlink', target, path);
    if (r.ino !== undefined) throw new SystemError('EEXIST', 'symlink', target, path);
    if (r.trailingSlash) throw new SystemError('ENOENT', 'symlink', target, path);
    this.charge(target.length, 1, 'symlink', target, path);
    const node = this.alloc<SymlinkInode>({ kind: 'symlink', mode: S_IFLNK | 0o777, target });
    this.addEntry(r.parentIno, r.name, node.ino);
    this.emit('create', r);
  }

  link(existing: string, newPath: string): void {
    const src = this.resolve(existing, false, 'link', existing, newPath);
    if (src.ino === undefined) throw new SystemError('ENOENT', 'link', existing, newPath);
    // Linux order: the new path's lookup errors, EEXIST and a trailing slash on a missing
    // name (ENOENT) all come before linking a directory (EPERM).
    const dest = this.resolve(newPath, 'name', 'link', existing, newPath);
    if (dest.ino !== undefined) throw new SystemError('EEXIST', 'link', existing, newPath);
    if (dest.trailingSlash) throw new SystemError('ENOENT', 'link', existing, newPath);
    if (this.get(src.ino).kind === 'dir') throw new SystemError('EPERM', 'link', existing, newPath);
    const node = this.mut(src.ino);
    node.nlink++;
    node.ctimeMs = Date.now();
    this.addEntry(dest.parentIno, dest.name, src.ino);
    this.emit('create', dest);
  }

  rename(oldPath: string, newPath: string): void {
    // Linux order (do_renameat2): both parents resolve, '/', '.' and '..' are EBUSY, the
    // source must exist, trailing slashes need a directory, then the ancestor checks, then
    // vfs_rename's type mismatches and a non-empty target.
    const from = this.resolve(oldPath, 'name', 'rename', oldPath, newPath);
    const to = this.resolve(newPath, 'name', 'rename', oldPath, newPath);
    const err = (code: ErrnoCode) => new SystemError(code, 'rename', oldPath, newPath);
    if (from.ino === ROOT_INO || to.ino === ROOT_INO || from.dotLast || to.dotLast)
      throw err('EBUSY');
    if (from.ino === undefined) throw err('ENOENT');
    const fromNode = this.get(from.ino);
    if (fromNode.kind !== 'dir' && (from.trailingSlash || to.trailingSlash)) throw err('ENOTDIR');

    const toNode = to.ino === undefined ? undefined : this.get(to.ino);
    const isAncestor = (dir: number, of: number) => {
      for (let ino = of; ; ino = (this.get(ino) as DirInode).parent) {
        if (ino === dir) return true;
        if (ino === ROOT_INO) return false;
      }
    };
    if (from.parentIno !== to.parentIno) {
      // Moving a directory into itself; replacing a directory that contains the source.
      if (fromNode.kind === 'dir' && isAncestor(from.ino, to.parentIno)) throw err('EINVAL');
      if (toNode?.kind === 'dir' && isAncestor(to.ino!, from.parentIno)) throw err('ENOTEMPTY');
    }
    if (to.ino === from.ino) return;
    if (toNode) {
      if (fromNode.kind === 'dir' && toNode.kind !== 'dir') throw err('ENOTDIR');
      if (fromNode.kind !== 'dir' && toNode.kind === 'dir') throw err('EISDIR');
    }
    if (toNode?.kind === 'dir' && toNode.entries.size > 0) throw err('ENOTEMPTY');

    const fromPath = this.watchers.active ? this.entryPath(from) : '';
    if (to.ino !== undefined) this.unlinkEntry(to.parentIno, to.name);
    const now = Date.now();
    const oldParent = this.mut(from.parentIno) as DirInode;
    oldParent.entries.delete(from.name);
    oldParent.mtimeMs = oldParent.ctimeMs = now;
    const newParent = this.mut(to.parentIno) as DirInode;
    newParent.entries.set(to.name, from.ino);
    newParent.mtimeMs = newParent.ctimeMs = now;
    const moved = this.mut(from.ino);
    moved.ctimeMs = now;
    if (moved.kind === 'dir') {
      moved.parent = to.parentIno;
      moved.name = to.name;
      if (from.parentIno !== to.parentIno) {
        oldParent.nlink--;
        newParent.nlink++;
      }
    }
    if (this.watchers.active)
      this.watchers.emit({ type: 'rename', from: fromPath, to: this.entryPath(to) });
  }

  // ---------------------------------------------------------------- watchers

  /**
   * Watches a path. Non-recursive watches on a directory see changes to its
   * direct children; recursive ones see the whole subtree. Paths in events are
   * canonical (symlink-free). Events are delivered in a microtask batch.
   */
  watch(path: string, options: { recursive?: boolean }, listener: WatchListener): () => void {
    const canonical = this.realpath(path);
    return this.watchers.add(canonical, options.recursive === true, listener);
  }

  // ---------------------------------------------------------------- internals

  private get(ino: number): Inode {
    const node = this.inodes.get(ino);
    if (!node) throw new Error(`vfs: dangling inode ${ino}`);
    return node;
  }

  /** Returns a mutable inode, cloning it first if a snapshot may reference it. */
  private mut(ino: number): Inode {
    this.mutateListener?.();
    const node = this.get(ino);
    if (node.epoch === this.epoch) return node;
    let clone: Inode;
    switch (node.kind) {
      case 'dir':
        clone = { ...node, entries: new Map(node.entries), epoch: this.epoch };
        break;
      case 'file':
        clone = { ...node, dataShared: true, epoch: this.epoch };
        break;
      case 'symlink':
        clone = { ...node, epoch: this.epoch };
        break;
    }
    this.inodes.set(ino, clone);
    return clone;
  }

  private alloc<T extends Inode>(
    fields: Omit<T, 'ino' | 'nlink' | 'atimeMs' | 'mtimeMs' | 'ctimeMs' | 'birthtimeMs' | 'epoch'>,
  ): T {
    this.mutateListener?.();
    const now = Date.now();
    const node = {
      ...fields,
      ino: this.nextIno++,
      nlink: fields.kind === 'dir' ? 2 : 1,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      epoch: this.epoch,
    } as T;
    this.inodes.set(node.ino, node);
    this.usedBytes += inodeBytes(node);
    return node;
  }

  private free(ino: number): void {
    this.mutateListener?.();
    const node = this.inodes.get(ino);
    if (!node) return;
    this.usedBytes -= inodeBytes(node);
    this.inodes.delete(ino);
  }

  /** Throws ENOSPC if adding `bytes` and `inodes` would exceed the limits. */
  private charge(
    bytes: number,
    inodes: number,
    syscall: string,
    path?: string,
    dest?: string,
  ): void {
    const { quotaBytes, maxInodes } = this.limits;
    const overhead = inodes * INODE_OVERHEAD_BYTES;
    if (quotaBytes !== undefined && this.usedBytes + bytes + overhead > quotaBytes) {
      throw new SystemError('ENOSPC', syscall, path, dest);
    }
    if (maxInodes !== undefined && this.inodes.size + inodes > maxInodes) {
      throw new SystemError('ENOSPC', syscall, path, dest);
    }
  }

  private createFile(
    r: Resolved,
    mode: number,
    data: Uint8Array,
    syscall: string,
    path: string,
    dest?: string,
  ): number {
    this.charge(data.length, 1, syscall, path, dest);
    const node = this.alloc<FileInode>({
      kind: 'file',
      mode: S_IFREG | (mode & 0o7777),
      data,
      size: data.length,
      dataShared: false,
    });
    this.addEntry(r.parentIno, r.name, node.ino);
    return node.ino;
  }

  private createDir(r: Resolved, mode: number, path: string): number {
    this.charge(0, 1, 'mkdir', path);
    const node = this.alloc<DirInode>({
      kind: 'dir',
      mode: S_IFDIR | (mode & 0o7777),
      entries: new Map(),
      parent: r.parentIno,
      name: r.name,
    });
    this.addEntry(r.parentIno, r.name, node.ino);
    const parent = this.mut(r.parentIno);
    parent.nlink++;
    return node.ino;
  }

  private setFileData(
    ino: number,
    data: Uint8Array,
    syscall: string,
    path: string,
    dest?: string,
  ): void {
    const current = this.get(ino) as FileInode;
    this.charge(Math.max(0, data.length - current.size), 0, syscall, path, dest);
    const node = this.mut(ino) as FileInode;
    this.usedBytes += data.length - node.size;
    node.data = data;
    node.size = data.length;
    node.dataShared = false;
    node.mtimeMs = node.ctimeMs = Date.now();
  }

  private truncateIno(ino: number, length: number, syscall: string, path?: string): void {
    if (length < 0 || !Number.isInteger(length)) throw new SystemError('EINVAL', syscall, path);
    const current = this.get(ino);
    if (current.kind === 'dir') throw new SystemError('EISDIR', syscall, path);
    if (current.kind !== 'file') throw new SystemError('EINVAL', syscall, path);
    this.charge(Math.max(0, length - current.size), 0, syscall, path);
    const node = this.mut(ino) as FileInode;
    if (length > node.data.length || (node.dataShared && length > node.size)) {
      const next = new Uint8Array(length);
      next.set(node.data.subarray(0, node.size));
      node.data = next;
      node.dataShared = false;
    } else if (length > node.size) {
      // Bytes past the old size may hold stale data from an earlier shrink.
      node.data.fill(0, node.size, length);
    }
    this.usedBytes += length - node.size;
    node.size = length;
    node.mtimeMs = node.ctimeMs = Date.now();
    this.emitIno('modify', ino);
  }

  private addEntry(parentIno: number, name: string, ino: number): void {
    const parent = this.mut(parentIno) as DirInode;
    parent.entries.set(name, ino);
    parent.mtimeMs = parent.ctimeMs = Date.now();
  }

  /** Removes a directory entry, dropping a link to its inode. Directories must be empty. */
  private unlinkEntry(parentIno: number, name: string): void {
    const parent = this.mut(parentIno) as DirInode;
    const ino = parent.entries.get(name)!;
    parent.entries.delete(name);
    parent.mtimeMs = parent.ctimeMs = Date.now();
    const node = this.mut(ino);
    if (node.kind === 'dir') {
      parent.nlink--;
      node.nlink = 0;
    } else {
      node.nlink--;
      node.ctimeMs = Date.now();
    }
    if (node.nlink === 0 && !this.openRefs.has(ino)) this.free(ino);
  }

  private removeRecursive(parentIno: number, name: string): void {
    const ino = (this.get(parentIno) as DirInode).entries.get(name)!;
    const node = this.get(ino);
    if (node.kind === 'dir') {
      for (const child of [...node.entries.keys()]) this.removeRecursive(ino, child);
    }
    this.unlinkEntry(parentIno, name);
  }

  /** fchmod(2): replaces the permission bits, keeping the file type. */
  private setPerm(ino: number, mode: number): void {
    const node = this.mut(ino);
    node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    node.ctimeMs = Date.now();
    this.emitIno('modify', ino);
  }

  /**
   * open(2) with O_CREAT on 'name/' is EISDIR as soon as the parent resolves, whatever
   * 'name' is ('.' and '..' excepted: those name a directory and fail later).
   */
  private rejectCreateWithSlash(
    path: string,
    syscall: string,
    errPath = path,
    dest?: string,
  ): void {
    if (path.length <= 1 || !path.endsWith('/')) return;
    const r = this.resolve(path, 'name', syscall, errPath, dest);
    if (!r.dotLast) throw new SystemError('EISDIR', syscall, errPath, dest);
  }

  /** Resolves a path that must exist. */
  private existing(path: string, follow: boolean, syscall: string, dest?: string): number {
    const r = this.resolve(path, follow, syscall, path, dest);
    if (r.ino === undefined) throw new SystemError('ENOENT', syscall, path, dest);
    return r.ino;
  }

  /**
   * Physical path walk. Intermediate symlinks are always followed; the final
   * component is followed when `follow` is set or the path ends in '/'.
   * With `follow: 'name'` the final component is only looked up in its parent, never
   * followed or required to be a directory, even after a '/' (Linux's lookup for
   * creating, renaming and removing a name).
   * Errors name `errPath` (defaults to `path`) so callers report what they were given.
   */
  private resolve(
    path: string,
    follow: boolean | 'name',
    syscall: string,
    errPath: string = path,
    dest?: string,
  ): Resolved {
    if (path.length > PATH_MAX) throw new SystemError('ENAMETOOLONG', syscall, errPath, dest);
    if (!path.startsWith('/') || path.includes('\0'))
      throw new SystemError('EINVAL', syscall, errPath, dest);
    const fail = (code: ErrnoCode): never => {
      throw new SystemError(code, syscall, errPath, dest);
    };

    // A final symlink whose target ends in '/' counts as a trailing slash (Linux keeps the
    // target's slash on its last component), so it becomes true while walking.
    let trailingSlash = path.length > 1 && path.endsWith('/');
    const nameOnly = follow === 'name';
    const rawLast = path
      .split('/')
      .filter((p) => p !== '')
      .pop();
    const dotLast = rawLast === '.' || rawLast === '..';
    // Remaining components, consumed from the front.
    const queue = path.split('/').filter((p) => p !== '' && p !== '.');
    let dirIno = ROOT_INO;
    let hops = 0;

    while (queue.length > 0) {
      const name = queue.shift()!;
      const isLast = queue.length === 0;
      const dir = this.get(dirIno) as DirInode;
      if (name === '..') {
        if (isLast)
          return { parentIno: dir.parent, name: '..', ino: dir.parent, trailingSlash, dotLast };
        dirIno = dir.parent;
        continue;
      }
      // A UTF-16 code unit is at most 3 UTF-8 bytes, so only long names need encoding.
      if (name.length * 3 > NAME_MAX && utf8.encode(name).length > NAME_MAX) fail('ENAMETOOLONG');
      const childIno = dir.entries.get(name);
      if (childIno === undefined) {
        if (isLast) return { parentIno: dirIno, name, ino: undefined, trailingSlash, dotLast };
        fail('ENOENT');
      }
      const child = this.get(childIno!);
      if (
        child.kind === 'symlink' &&
        (!isLast || follow === true || (trailingSlash && !nameOnly))
      ) {
        if (++hops > MAX_SYMLINK_HOPS) fail('ELOOP');
        const target = child.target;
        if (isLast && target.endsWith('/')) trailingSlash = true;
        queue.unshift(...target.split('/').filter((p) => p !== '' && p !== '.'));
        if (target.startsWith('/')) dirIno = ROOT_INO;
        if (queue.length === 0)
          return { parentIno: dirIno, name: '', ino: dirIno, trailingSlash, dotLast };
        continue;
      }
      if (isLast) {
        if (trailingSlash && !nameOnly && child.kind !== 'dir') fail('ENOTDIR');
        return { parentIno: dirIno, name, ino: childIno, trailingSlash, dotLast };
      }
      if (child.kind !== 'dir') fail('ENOTDIR');
      dirIno = childIno!;
    }
    // The path named a directory reached without a final component ('/', '/a/..').
    return {
      parentIno: (this.get(dirIno) as DirInode).parent,
      name: '',
      ino: dirIno,
      trailingSlash,
      dotLast,
    };
  }

  /** Canonical path of a directory, from parent pointers. */
  private dirPath(ino: number): string {
    const parts: string[] = [];
    while (ino !== ROOT_INO) {
      const dir = this.get(ino) as DirInode;
      parts.push(dir.name);
      ino = dir.parent;
    }
    return '/' + parts.reverse().join('/');
  }

  private entryPath(r: Resolved): string {
    const parent = this.dirPath(r.parentIno);
    if (r.name === '' || r.name === '..') return this.dirPath(r.ino ?? r.parentIno);
    return parent === '/' ? `/${r.name}` : `${parent}/${r.name}`;
  }

  private emit(type: 'create' | 'modify' | 'delete', r: Resolved): void {
    if (!this.watchers.active) return;
    this.watchers.emit({ type, path: this.entryPath(r) } as FsEvent);
  }

  /** Emits for an inode reached through a descriptor; the path is unknown unless it's a directory. */
  private emitIno(type: 'modify', ino: number): void {
    if (!this.watchers.active) return;
    const paths = this.pathsOf(ino);
    for (const path of paths) this.watchers.emit({ type, path });
  }

  /** All canonical paths that currently link to `ino` (linear scan; only used when watching). */
  private pathsOf(ino: number): string[] {
    const out: string[] = [];
    for (const [dirIno, node] of this.inodes) {
      if (node.kind !== 'dir') continue;
      for (const [name, child] of node.entries) {
        if (child !== ino) continue;
        const dir = this.dirPath(dirIno);
        out.push(dir === '/' ? `/${name}` : `${dir}/${name}`);
      }
    }
    return out;
  }

  private toStat(node: Inode): StatData {
    const size =
      node.kind === 'file' ? node.size : node.kind === 'symlink' ? node.target.length : BLKSIZE;
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

export { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG };
