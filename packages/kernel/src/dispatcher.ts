// SPDX-License-Identifier: Apache-2.0
import { Op, SystemError, decode, encode, encodeStat } from '@clientvm/protocol';
import type { SyscallHandler, Value } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';
import { O_ACCMODE, O_APPEND, O_CREAT, O_TRUNC } from '@clientvm/vfs';
import type { FdTable } from './fd-table.ts';
import { deviceAt, deviceStat } from './devices.ts';
import type { ReadOnlyMounts } from './mounts.ts';

const EMPTY = new Uint8Array(0);

/**
 * Maps syscall opcodes onto VFS calls for one process. Arguments arrive as a
 * codec-encoded array and are validated here: process code is untrusted.
 */
export interface SyscallHooks {
  /** Runs a child to completion (Op.SPAWN_SYNC); resolves with the encoded result. */
  spawnSync?: (request: Uint8Array) => Promise<Uint8Array>;
  /** Read-only mounts: mutations under them fail with EROFS. */
  readOnly?: ReadOnlyMounts;
}

const WRITE_FLAGS = O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND;

export function createSyscallHandler(
  vfs: MemoryVfs,
  fds: FdTable,
  hooks: SyscallHooks = {},
): SyscallHandler {
  return (op, request) => {
    if (op === Op.NOOP) return EMPTY;
    if (op === Op.SPAWN_SYNC) {
      if (!hooks.spawnSync) throw new SystemError('ENOSYS', 'spawnSync');
      return hooks.spawnSync(request);
    }
    const a = new Args(request);
    // Character devices are resolved by path before the VFS sees them.
    const device =
      op === Op.STAT ||
      op === Op.LSTAT ||
      op === Op.READ_FILE ||
      op === Op.WRITE_FILE ||
      op === Op.ACCESS ||
      op === Op.TRUNCATE
        ? deviceAt(a.str(0))
        : undefined;
    if (device) {
      if (op === Op.STAT || op === Op.LSTAT) return encodeStat(deviceStat(device));
      // Reading a whole infinite device has no end; return one chunk like a short read.
      if (op === Op.READ_FILE) return device.read(0);
      return EMPTY;
    }
    const ro = hooks.readOnly;
    if (ro && ro.size > 0) checkReadOnly(ro, op, a);
    switch (op) {
      case Op.STAT:
        return encodeStat(vfs.stat(a.str(0)));
      case Op.LSTAT:
        return encodeStat(vfs.lstat(a.str(0)));
      case Op.READDIR: {
        const path = a.str(0);
        if (a.bool(1)) return encode(vfs.readdirTyped(path).map((d) => [d.name, d.type]));
        return encode(vfs.readdir(path));
      }
      case Op.READ_FILE:
        // Raw bytes, no codec framing: this is the hot path for module loading.
        return vfs.readFile(a.str(0));
      case Op.WRITE_FILE:
        vfs.writeFile(a.str(0), a.bytes(1), a.optInt(2));
        return EMPTY;
      case Op.MKDIR: {
        const mode = a.optInt(2);
        return encode(
          vfs.mkdir(a.str(0), { recursive: a.bool(1), ...(mode === undefined ? {} : { mode }) }) ??
            null,
        );
      }
      case Op.RMDIR:
        vfs.rmdir(a.str(0));
        return EMPTY;
      case Op.UNLINK:
        vfs.unlink(a.str(0));
        return EMPTY;
      case Op.RM_TREE:
        vfs.rmTree(a.str(0));
        return EMPTY;
      case Op.RENAME:
        vfs.rename(a.str(0), a.str(1));
        return EMPTY;
      case Op.SYMLINK:
        vfs.symlink(a.str(0), a.str(1));
        return EMPTY;
      case Op.READLINK:
        return encode(vfs.readlink(a.str(0)));
      case Op.LINK:
        vfs.link(a.str(0), a.str(1));
        return EMPTY;
      case Op.REALPATH:
        return encode(vfs.realpath(a.str(0)));
      case Op.ACCESS:
        vfs.access(a.str(0), a.optInt(1) ?? 0);
        return EMPTY;
      case Op.CHMOD:
        vfs.chmod(a.str(0), a.int(1));
        return EMPTY;
      case Op.UTIMES:
        vfs.utimes(a.str(0), a.num(1), a.num(2));
        return EMPTY;
      case Op.TRUNCATE:
        vfs.truncate(a.str(0), a.int(1));
        return EMPTY;
      case Op.COPY_FILE:
        vfs.copyFile(a.str(0), a.str(1), a.bool(2));
        return EMPTY;
      case Op.OPEN:
        return encode(fds.open(a.str(0), a.int(1), a.optInt(2) ?? 0o666));
      case Op.CLOSE:
        fds.close(a.int(0));
        return EMPTY;
      case Op.READ:
        // Raw bytes, like READ_FILE.
        return fds.read(a.int(0), a.int(1), a.optInt(2) ?? null);
      case Op.WRITE:
        return encode(fds.write(a.int(0), a.bytes(1), a.optInt(2) ?? null));
      case Op.FSTAT: {
        const file = fds.get(a.int(0), 'fstat');
        return encodeStat(file.device ? deviceStat(file.device) : vfs.fstat(file.ino));
      }
      case Op.FTRUNCATE:
        if (fds.get(a.int(0), 'ftruncate').device) return EMPTY;
        vfs.ftruncate(fds.get(a.int(0), 'ftruncate').ino, a.int(1));
        return EMPTY;
      default:
        throw new SystemError('ENOSYS', `syscall ${op}`);
    }
  };
}

/** Typed accessors over a decoded argument array; anything malformed is EINVAL. */
class Args {
  private readonly values: readonly Value[];

  constructor(request: Uint8Array) {
    const value = decode(request);
    if (!Array.isArray(value)) throw new SystemError('EINVAL', 'syscall');
    this.values = value as readonly Value[];
  }

  str(i: number): string {
    const v = this.values[i];
    if (typeof v !== 'string') throw new SystemError('EINVAL', 'syscall');
    return v;
  }

  num(i: number): number {
    const v = this.values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new SystemError('EINVAL', 'syscall');
    return v;
  }

  int(i: number): number {
    const v = this.num(i);
    if (!Number.isSafeInteger(v) || v < 0) throw new SystemError('EINVAL', 'syscall');
    return v;
  }

  optInt(i: number): number | undefined {
    const v = this.values[i];
    return v === null || v === undefined ? undefined : this.int(i);
  }

  bool(i: number): boolean {
    return this.values[i] === true;
  }

  bytes(i: number): Uint8Array {
    const v = this.values[i];
    if (!(v instanceof Uint8Array)) throw new SystemError('EINVAL', 'syscall');
    return v;
  }
}

/** EROFS for any mutation that would land under a read-only mount. */
function checkReadOnly(ro: ReadOnlyMounts, op: number, a: Args): void {
  switch (op) {
    case Op.WRITE_FILE:
    case Op.MKDIR:
    case Op.UNLINK:
    case Op.CHMOD:
    case Op.UTIMES:
    case Op.TRUNCATE:
      ro.check(a.str(0), 'write');
      return;
    case Op.RMDIR:
    case Op.RM_TREE:
      ro.checkTree(a.str(0), 'rm');
      return;
    case Op.RENAME:
      ro.checkTree(a.str(0), 'rename');
      ro.checkTree(a.str(1), 'rename');
      return;
    case Op.SYMLINK:
      ro.check(a.str(1), 'symlink');
      return;
    case Op.LINK:
    case Op.COPY_FILE:
      ro.check(a.str(1), 'link');
      return;
    case Op.OPEN:
      if ((a.int(1) & WRITE_FLAGS) !== 0) ro.check(a.str(0), 'open');
      return;
  }
}
