// SPDX-License-Identifier: Apache-2.0
import { Op, SystemError, decode, encode, encodeStat } from '@clientvm/protocol';
import type { SyscallHandler, Value } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';

const EMPTY = new Uint8Array(0);

/** Maps syscall opcodes onto VFS calls. Arguments arrive as a codec-encoded array. */
export function createSyscallHandler(vfs: MemoryVfs): SyscallHandler {
  return (op, request) => {
    switch (op) {
      case Op.NOOP:
        return EMPTY;
      case Op.STAT: {
        const [path] = args(request, 'stat');
        return encodeStat(vfs.stat(str(path, 'stat')));
      }
      case Op.LSTAT: {
        const [path] = args(request, 'lstat');
        return encodeStat(vfs.lstat(str(path, 'lstat')));
      }
      case Op.READDIR: {
        const [path, withTypes] = args(request, 'scandir');
        const p = str(path, 'scandir');
        if (withTypes === true) return encode(vfs.readdirTyped(p).map((d) => [d.name, d.type]));
        return encode(vfs.readdir(p));
      }
      case Op.READ_FILE: {
        const [path] = args(request, 'open');
        // Raw bytes, no codec framing: this is the hot path for module loading.
        return vfs.readFile(str(path, 'open'));
      }
      case Op.WRITE_FILE: {
        const [path, data, mode] = args(request, 'open');
        if (!(data instanceof Uint8Array)) throw new SystemError('EINVAL', 'write');
        vfs.writeFile(str(path, 'open'), data, typeof mode === 'number' ? mode : undefined);
        return EMPTY;
      }
      case Op.MKDIR: {
        const [path, recursive, mode] = args(request, 'mkdir');
        const created = vfs.mkdir(str(path, 'mkdir'), {
          recursive: recursive === true,
          ...(typeof mode === 'number' ? { mode } : {}),
        });
        return encode(created ?? null);
      }
      default:
        throw new SystemError('ENOSYS', `syscall ${op}`);
    }
  };
}

function args(request: Uint8Array, syscall: string): readonly Value[] {
  const value = decode(request);
  if (!Array.isArray(value)) throw new SystemError('EINVAL', syscall);
  return value as readonly Value[];
}

function str(value: Value, syscall: string): string {
  if (typeof value !== 'string') throw new SystemError('EINVAL', syscall);
  return value;
}
