// SPDX-License-Identifier: Apache-2.0

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

/** open(2) flags, Linux values. */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;

export type DirentType = 'file' | 'dir' | 'symlink';

export interface Dirent {
  name: string;
  type: DirentType;
}

export interface InodeBase {
  ino: number;
  mode: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  /**
   * Copy-on-write generation. An inode whose epoch is older than the VFS's
   * current epoch may be referenced by a snapshot and must be cloned before
   * it is mutated.
   */
  epoch: number;
}

export interface FileInode extends InodeBase {
  kind: 'file';
  /** Backing store; only the first `size` bytes are file contents. */
  data: Uint8Array;
  size: number;
  /** True when `data` may also be referenced by a snapshot; copy before writing in place. */
  dataShared: boolean;
}

export interface DirInode extends InodeBase {
  kind: 'dir';
  entries: Map<string, number>;
  /** Directories have exactly one parent; the root is its own parent. */
  parent: number;
  /** Name in the parent directory ('' for the root). */
  name: string;
}

export interface SymlinkInode extends InodeBase {
  kind: 'symlink';
  target: string;
}

export type Inode = FileInode | DirInode | SymlinkInode;

/** Bytes charged against the quota for every inode, on top of its contents. */
export const INODE_OVERHEAD_BYTES = 256;

export function inodeBytes(node: Inode): number {
  switch (node.kind) {
    case 'file':
      return INODE_OVERHEAD_BYTES + node.size;
    case 'symlink':
      return INODE_OVERHEAD_BYTES + node.target.length;
    case 'dir':
      return INODE_OVERHEAD_BYTES;
  }
}
