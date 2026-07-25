// SPDX-License-Identifier: Apache-2.0
import { Op, decode, decodeStat, encode } from '@clientvm/protocol';
import { MemoryVfs } from '@clientvm/vfs';
import { describe, expect, it } from 'vitest';
import { createSyscallHandler } from './dispatcher.ts';

describe('syscall dispatcher', () => {
  const vfs = new MemoryVfs();
  const handle = createSyscallHandler(vfs);
  const call = (op: number, args: Parameters<typeof encode>[0]) =>
    handle(op, encode(args)) as Uint8Array;

  it('maps fs opcodes onto the VFS', () => {
    expect(decode(call(Op.MKDIR, ['/a/b', true, null]))).toBe('/a');
    call(Op.WRITE_FILE, ['/a/b/f.txt', new TextEncoder().encode('hey'), null]);
    expect(new TextDecoder().decode(call(Op.READ_FILE, ['/a/b/f.txt']))).toBe('hey');
    expect(decode(call(Op.READDIR, ['/a/b', false]))).toEqual(['f.txt']);
    expect(decode(call(Op.READDIR, ['/a', true]))).toEqual([['b', 'dir']]);
    expect(decodeStat(call(Op.STAT, ['/a/b/f.txt'])).size).toBe(3);
    expect(handle(Op.NOOP, new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('rejects malformed arguments and unknown opcodes', () => {
    expect(() => call(Op.STAT, [42])).toThrow(/EINVAL/);
    expect(() => call(Op.STAT, 'not-an-array')).toThrow(/EINVAL/);
    expect(() => call(999, [])).toThrow(/ENOSYS/);
  });
});
