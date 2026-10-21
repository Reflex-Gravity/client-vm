// SPDX-License-Identifier: Apache-2.0
import { Op, decode, decodeStat, encode } from '@clientvm/protocol';
import { MemoryVfs } from '@clientvm/vfs';
import { describe, expect, it } from 'vitest';
import { createSyscallHandler } from './dispatcher.ts';
import { installDevices } from './devices.ts';
import { FdTable } from './fd-table.ts';

describe('syscall dispatcher', () => {
  const vfs = new MemoryVfs();
  const handle = createSyscallHandler(vfs, new FdTable(vfs));
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

  it('keeps per-process descriptors with offsets', () => {
    const own = new MemoryVfs();
    const fds = new FdTable(own, 4);
    const h = createSyscallHandler(own, fds);
    const c = (op: number, args: Parameters<typeof encode>[0]) => h(op, encode(args)) as Uint8Array;
    const enc = new TextEncoder();
    const fd = decode(c(Op.OPEN, ['/f', 0o102, 0o644])) as number; // O_RDWR | O_CREAT
    expect(fd).toBe(3);
    c(Op.WRITE, [fd, enc.encode('abc'), null]);
    c(Op.WRITE, [fd, enc.encode('def'), null]);
    expect(new TextDecoder().decode(c(Op.READ, [fd, 10, 0]))).toBe('abcdef');
    expect(decodeStat(c(Op.FSTAT, [fd])).size).toBe(6);
    c(Op.CLOSE, [fd]);
    expect(() => c(Op.READ, [fd, 1, null])).toThrow(/EBADF/);
    const ro = decode(c(Op.OPEN, ['/f', 0, 0])) as number;
    expect(() => c(Op.WRITE, [ro, enc.encode('x'), null])).toThrow(/EBADF/);
    c(Op.OPEN, ['/f', 0, 0]);
    c(Op.OPEN, ['/f', 0, 0]);
    c(Op.OPEN, ['/f', 0, 0]);
    expect(() => c(Op.OPEN, ['/f', 0, 0])).toThrow(/EMFILE/);
    fds.closeAll();
    expect(() => c(Op.CLOSE, [ro])).toThrow(/EBADF/);
  });

  it('serves character devices by path', () => {
    const own = new MemoryVfs();
    installDevices(own);
    const h = createSyscallHandler(own, new FdTable(own));
    const c = (op: number, args: Parameters<typeof encode>[0]) => h(op, encode(args)) as Uint8Array;
    expect(decode(c(Op.READDIR, ['/dev', false]))).toEqual(['null', 'random', 'urandom', 'zero']);
    const st = decodeStat(c(Op.STAT, ['/dev/null']));
    expect(st.mode & 0o170000).toBe(0o020000);
    expect(st.rdev).toBe(259);
    c(Op.WRITE_FILE, ['/dev/null', new Uint8Array(10), null]);
    expect(c(Op.READ_FILE, ['/dev/null']).length).toBe(0);
    const zero = decode(c(Op.OPEN, ['/dev/zero', 0, 0])) as number;
    expect(c(Op.READ, [zero, 8, null])).toEqual(new Uint8Array(8));
    const rnd = decode(c(Op.OPEN, ['//dev/urandom', 0, 0])) as number;
    expect(c(Op.READ, [rnd, 32, null]).length).toBe(32);
    const sink = decode(c(Op.OPEN, ['/dev/null', 1, 0])) as number;
    expect(decode(c(Op.WRITE, [sink, new Uint8Array(5), null]))).toBe(5);
    expect(decodeStat(c(Op.FSTAT, [sink])).mode & 0o170000).toBe(0o020000);
    c(Op.CLOSE, [sink]);
  });
});
