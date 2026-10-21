// SPDX-License-Identifier: Apache-2.0
// Read-only mirrored mounts (docs/phase4-plan.md, slice 4c). The controller
// copies another instance's subtree in and keeps it in step; processes see an
// ordinary read-only directory. Writes anywhere under a mount root fail with
// EROFS, including through symlinks that point into it.

import { SystemError } from '@clientvm/protocol';
import type { MirrorOp, TreeEntry } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';
import { S_IFDIR, S_IFLNK, S_IFMT } from '@clientvm/vfs';

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}

const within = (path: string, root: string) =>
  root === '/' || path === root || path.startsWith(`${root}/`);

/** Validates a relative path from the controller: no `..`, no leading slash. */
export function checkRel(rel: unknown): string {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.split('/').some((p) => p === '..'))
    throw new SystemError('EINVAL', 'mount');
  return rel.replace(/\/+$/, '');
}

/** Copies the subtree at `path` (following nothing: symlinks stay symlinks). */
export function exportTree(vfs: MemoryVfs, path: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (abs: string, rel: string) => {
    const st = vfs.lstat(abs);
    const kind = st.mode & S_IFMT;
    if (kind === S_IFLNK) {
      out.push({ rel, type: 'symlink', target: vfs.readlink(abs) });
    } else if (kind === S_IFDIR) {
      out.push({ rel, type: 'dir', mode: st.mode & 0o7777 });
      for (const name of vfs.readdir(abs).sort()) {
        walk(`${abs === '/' ? '' : abs}/${name}`, rel ? `${rel}/${name}` : name);
      }
    } else {
      out.push({ rel, type: 'file', mode: st.mode & 0o7777, data: vfs.readFile(abs).slice() });
    }
  };
  walk(normalize(path), '');
  return out;
}

export class ReadOnlyMounts {
  private readonly roots = new Set<string>();
  private readonly vfs: MemoryVfs;

  constructor(vfs: MemoryVfs) {
    this.vfs = vfs;
  }

  get size(): number {
    return this.roots.size;
  }

  has(root: string): boolean {
    return this.roots.has(normalize(root));
  }

  /** The path with its directory part resolved through symlinks, as a write would land. */
  private canonical(path: string): string {
    const p = normalize(path);
    if (p === '/') return p;
    const slash = p.lastIndexOf('/');
    const dir = p.slice(0, slash) || '/';
    try {
      const real = this.vfs.realpath(dir);
      return `${real === '/' ? '' : real}${p.slice(slash)}`;
    } catch {
      return p;
    }
  }

  /** EROFS when `path` is in a mount (writes, creates, deletes of one entry). */
  check(path: string, syscall: string): void {
    if (this.roots.size === 0) return;
    const p = this.canonical(path);
    for (const root of this.roots) {
      if (within(p, root)) throw new SystemError('EROFS', syscall, path);
    }
  }

  /** Also EROFS when a mount lies inside `path` (recursive removal, renaming a parent). */
  checkTree(path: string, syscall: string): void {
    this.check(path, syscall);
    if (this.roots.size === 0) return;
    const p = this.canonical(path);
    for (const root of this.roots) {
      if (within(root, p)) throw new SystemError('EROFS', syscall, path);
    }
  }

  /** Creates the mount at `root` from `entries` (the root must be absent or an empty directory). */
  mount(root: string, entries: TreeEntry[]): void {
    const r = normalize(root);
    if (r === '/') throw new SystemError('EINVAL', 'mount', root);
    try {
      if (this.vfs.readdir(r).length > 0) throw new SystemError('ENOTEMPTY', 'mount', root);
    } catch (err) {
      if (!(err instanceof SystemError) || err.code !== 'ENOENT') throw err;
    }
    this.checkTree(r, 'mount');
    this.apply(r, [{ op: 'put', at: '', entries }]);
    this.roots.add(r);
  }

  unmount(root: string): void {
    const r = normalize(root);
    if (!this.roots.delete(r)) throw new SystemError('EINVAL', 'umount', root);
    this.vfs.rmTree(r);
    this.vfs.mkdir(r, { recursive: true });
  }

  /** Applies mirror updates under a mount root (bypassing the read-only check). */
  update(root: string, ops: MirrorOp[]): void {
    const r = normalize(root);
    if (!this.roots.has(r)) throw new SystemError('EINVAL', 'mount', root);
    this.apply(r, ops);
  }

  private apply(root: string, ops: MirrorOp[]): void {
    const vfs = this.vfs;
    const join = (rel: string) => (rel ? `${root}/${rel}` : root);
    const remove = (abs: string) => {
      try {
        vfs.lstat(abs);
      } catch {
        return;
      }
      vfs.rmTree(abs);
    };
    for (const op of ops) {
      const at = checkRel(op.at);
      if (op.op === 'delete') {
        if (at) remove(join(at));
        continue;
      }
      for (const entry of op.entries) {
        const rel = checkRel(entry.rel);
        const abs = join([at, rel].filter(Boolean).join('/'));
        const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
        vfs.mkdir(parent, { recursive: true });
        if (entry.type === 'dir') {
          let isDir = false;
          try {
            isDir = (vfs.lstat(abs).mode & S_IFMT) === S_IFDIR;
          } catch {
            // absent
          }
          if (!isDir) {
            remove(abs);
            vfs.mkdir(abs, { mode: entry.mode });
          }
          vfs.chmod(abs, entry.mode);
        } else if (entry.type === 'file') {
          if (!(entry.data instanceof Uint8Array)) throw new SystemError('EINVAL', 'mount');
          try {
            if ((vfs.lstat(abs).mode & S_IFMT) !== 0o100000) remove(abs);
          } catch {
            // absent
          }
          vfs.writeFile(abs, entry.data, entry.mode);
          vfs.chmod(abs, entry.mode);
        } else if (entry.type === 'symlink') {
          if (typeof entry.target !== 'string') throw new SystemError('EINVAL', 'mount');
          remove(abs);
          vfs.symlink(entry.target, abs);
        } else {
          throw new SystemError('EINVAL', 'mount');
        }
      }
    }
  }
}
