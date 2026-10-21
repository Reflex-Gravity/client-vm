// SPDX-License-Identifier: Apache-2.0
// Shared harness: run the same filesystem operations against real node:fs (in a
// temp dir) and against MemoryVfs, and normalize the outcomes for comparison.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  MemoryVfs,
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
} from '@clientvm/vfs';

export type Step =
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'write'; path: string; data: string }
  | { op: 'read'; path: string }
  | { op: 'readdir'; path: string }
  | { op: 'stat'; path: string }
  | { op: 'lstat'; path: string }
  | { op: 'unlink'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'rmTree'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'symlink'; target: string; path: string }
  | { op: 'readlink'; path: string }
  | { op: 'link'; existing: string; path: string }
  | { op: 'realpath'; path: string }
  | { op: 'chmod'; path: string; mode: number }
  | { op: 'truncate'; path: string; length: number }
  | { op: 'copyFile'; src: string; dest: string; exclusive?: boolean }
  /** open + write at position (or append) + close, then report the file size via fstat. */
  | { op: 'fdWrite'; path: string; flags: string; data: string; position?: number }
  /** open read-only + read `length` bytes at `position` + close. */
  | { op: 'fdRead'; path: string; length: number; position: number };

export type Outcome = { ok: unknown } | { error: string | undefined };

export interface Target {
  run(step: Step): unknown;
}

type StatSummary = {
  type: string;
  size: number | null;
  perm: number | null;
  nlink: number | null;
};

function typeOf(mode: number): string {
  switch (mode & 0o170000) {
    case 0o100000:
      return 'file';
    case 0o040000:
      return 'dir';
    case 0o120000:
      return 'symlink';
    default:
      return 'other';
  }
}

/** Directory sizes and nlink differ between filesystems by design; only compare them for files. */
function summarize(mode: number, size: number, nlink: number): StatSummary {
  const type = typeOf(mode);
  // Symlink sizes are target lengths, which differ because absolute targets are rebased into the temp root.
  const comparableSize = type === 'file';
  // Linux reports symlinks as 0777; macOS applies the umask. Linux is the reference.
  const comparablePerm = type !== 'symlink' || process.platform === 'linux';
  return {
    type,
    size: comparableSize ? size : null,
    perm: comparablePerm ? mode & 0o777 : null,
    nlink: type === 'dir' ? null : nlink,
  };
}

const NODE_FLAGS: Record<string, number> = {
  r: O_RDONLY,
  'r+': O_RDWR,
  w: O_WRONLY | O_CREAT | O_TRUNC,
  wx: O_WRONLY | O_CREAT | O_TRUNC | O_EXCL,
  'w+': O_RDWR | O_CREAT | O_TRUNC,
  a: O_WRONLY | O_CREAT | O_APPEND,
  'a+': O_RDWR | O_CREAT | O_APPEND,
};

/**
 * `rm -r` built from POSIX calls. Not fs.rmSync: on Node 24.11 it reports
 * success for a dangling symlink without removing it.
 */
function removeTree(path: string): void {
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) removeTree(`${path}/${name}`);
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

export function nodeTarget(root: string): Target {
  // Concatenate rather than path.join: join would collapse '..' lexically, but the OS resolves it physically.
  const p = (path: string) => root + path;
  const realRoot = realpathSync(root);
  return {
    run(step) {
      switch (step.op) {
        case 'mkdir': {
          const created = mkdirSync(p(step.path), {
            recursive: step.recursive ?? false,
            mode: 0o755,
          });
          return created === undefined ? undefined : created.slice(root.length);
        }
        case 'write':
          return writeFileSync(p(step.path), step.data, { mode: 0o644 });
        case 'read':
          return readFileSync(p(step.path), 'utf8');
        case 'readdir':
          return readdirSync(p(step.path)).sort();
        case 'stat': {
          const s = statSync(p(step.path));
          return summarize(s.mode, s.size, s.nlink);
        }
        case 'lstat': {
          const s = lstatSync(p(step.path));
          return summarize(s.mode, s.size, s.nlink);
        }
        case 'unlink':
          return unlinkSync(p(step.path));
        case 'rmdir':
          return rmdirSync(p(step.path));
        case 'rmTree':
          return removeTree(p(step.path));
        case 'rename':
          return renameSync(p(step.from), p(step.to));
        case 'symlink':
          // Absolute targets are rebased into the temp root; relative ones are kept as-is.
          return symlinkSync(
            step.target.startsWith('/') ? p(step.target) : step.target,
            p(step.path),
          );
        case 'readlink': {
          const target = readlinkSync(p(step.path));
          return target.startsWith(root) ? target.slice(root.length) : target;
        }
        case 'link':
          return linkSync(p(step.existing), p(step.path));
        case 'realpath':
          // realpath(3) semantics; Node's JS realpathSync normalizes '..' lexically first.
          return realpathSync.native(p(step.path)).slice(realRoot.length) || '/';
        case 'chmod':
          return chmodSync(p(step.path), step.mode);
        case 'truncate':
          return truncateSync(p(step.path), step.length);
        case 'copyFile':
          return copyFileSync(
            p(step.src),
            p(step.dest),
            step.exclusive ? constants.COPYFILE_EXCL : 0,
          );
        case 'fdWrite': {
          const fd = openSync(p(step.path), step.flags, 0o644);
          try {
            writeSync(fd, step.data, step.position ?? null);
            return statSync(p(step.path)).size;
          } finally {
            closeSync(fd);
          }
        }
        case 'fdRead': {
          const fd = openSync(p(step.path), 'r');
          try {
            const buf = Buffer.alloc(step.length);
            const n = readSync(fd, buf, 0, step.length, step.position);
            return buf.subarray(0, n).toString('utf8');
          } finally {
            closeSync(fd);
          }
        }
      }
    },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function vfsTarget(vfs: MemoryVfs): Target {
  return {
    run(step) {
      switch (step.op) {
        case 'mkdir':
          return vfs.mkdir(step.path, { recursive: step.recursive ?? false, mode: 0o755 });
        case 'write':
          return vfs.writeFile(step.path, enc.encode(step.data), 0o644);
        case 'read':
          return dec.decode(vfs.readFile(step.path));
        case 'readdir':
          return vfs.readdir(step.path);
        case 'stat': {
          const s = vfs.stat(step.path);
          return summarize(s.mode, s.size, s.nlink);
        }
        case 'lstat': {
          const s = vfs.lstat(step.path);
          return summarize(s.mode, s.size, s.nlink);
        }
        case 'unlink':
          return vfs.unlink(step.path);
        case 'rmdir':
          return vfs.rmdir(step.path);
        case 'rmTree':
          return vfs.rmTree(step.path);
        case 'rename':
          return vfs.rename(step.from, step.to);
        case 'symlink':
          return vfs.symlink(step.target, step.path);
        case 'readlink':
          return vfs.readlink(step.path);
        case 'link':
          return vfs.link(step.existing, step.path);
        case 'realpath':
          return vfs.realpath(step.path);
        case 'chmod':
          return vfs.chmod(step.path, step.mode);
        case 'truncate':
          return vfs.truncate(step.path, step.length);
        case 'copyFile':
          return vfs.copyFile(step.src, step.dest, step.exclusive ?? false);
        case 'fdWrite': {
          const flags = NODE_FLAGS[step.flags]!;
          const ino = vfs.open(step.path, flags, 0o644);
          try {
            vfs.writeAt(ino, enc.encode(step.data), step.position ?? 0, (flags & O_APPEND) !== 0);
            return vfs.fstat(ino).size;
          } finally {
            vfs.release(ino);
          }
        }
        case 'fdRead': {
          const ino = vfs.open(step.path, O_RDONLY);
          try {
            return dec.decode(vfs.readAt(ino, step.length, step.position));
          } finally {
            vfs.release(ino);
          }
        }
      }
    },
  };
}

export function outcome(target: Target, step: Step): Outcome {
  try {
    return { ok: target.run(step) };
  } catch (err) {
    return { error: (err as { code?: string }).code };
  }
}
