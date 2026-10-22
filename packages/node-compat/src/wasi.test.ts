// SPDX-License-Identifier: Apache-2.0
// Differential test: the same preview1 calls against ClientVM's WASI (over
// the host's fs) and Node's own node:wasi, on a scratch directory. Guest
// memory is shared, as it is for a threaded module such as rolldown's.
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI as NodeWASI } from 'node:wasi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPosixPath } from './path.ts';
import { createWasi } from './wasi.ts';
import type { WasiFs } from './wasi.ts';

type Imports = Record<string, (...args: (number | bigint)[]) => number>;
interface WasiLike {
  wasiImport: Imports;
  initialize(instance: object): void;
}

// The WASI layer passes Linux open(2) flags (what ClientVM's kernel takes);
// the host running this test may number them differently.
const LINUX_FLAGS: [number, number][] = [
  [0o100, nodeFs.constants.O_CREAT],
  [0o200, nodeFs.constants.O_EXCL],
  [0o1000, nodeFs.constants.O_TRUNC],
  [0o2000, nodeFs.constants.O_APPEND],
];
const hostFs = {
  ...nodeFs,
  openSync: (p: string, flags: number, mode?: number) =>
    nodeFs.openSync(
      p,
      LINUX_FLAGS.reduce((f, [linux, host]) => (flags & linux ? f | host : f), flags & 3),
      mode,
    ),
};

const ClientWASI = createWasi({
  fs: hostFs as unknown as WasiFs,
  path: createPosixPath(() => process.cwd()),
})['WASI'] as new (options: object) => WasiLike;

let dir: string;

beforeEach(() => {
  dir = nodeFs.mkdtempSync(join(tmpdir(), 'clientvm-wasi-'));
  nodeFs.writeFileSync(join(dir, 'a.txt'), 'hello wasi');
  nodeFs.mkdirSync(join(dir, 'sub'));
  nodeFs.writeFileSync(join(dir, 'sub', 'x'), '');
});

afterEach(() => nodeFs.rmSync(dir, { recursive: true, force: true }));

const STR = 0x1000;
const OUT = 0x2000;
const IOV = 0x3000;
const BUF = 0x4000;

/** Runs a fixed scenario of calls and returns what the guest would observe. */
function scenario(WASI: new (options: object) => WasiLike): unknown[] {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  const wasi = new WASI({
    version: 'preview1',
    args: ['prog', 'ärg'],
    env: { A: '1', B: 'two' },
    preopens: { '/sandbox': dir },
  });
  wasi.initialize({ exports: { memory, _initialize: () => {} } });
  const w = wasi.wasiImport;
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  const put = (s: string) => {
    const b = new TextEncoder().encode(s);
    u8().set(b, STR);
    return b.length;
  };
  const text = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len).slice());
  const u32 = (ptr: number) => dv().getUint32(ptr, true);
  const u64 = (ptr: number) => dv().getBigUint64(ptr, true);
  const iov = (len: number) => {
    dv().setUint32(IOV, BUF, true);
    dv().setUint32(IOV + 4, len, true);
  };
  const open = (path: string, oflags = 0, rights = 0x2n | 0x40n, fdflags = 0) => {
    const r = w.path_open!(3, 1, STR, put(path), oflags, rights, rights, fdflags, OUT);
    return [r, r === 0 ? u32(OUT) : -1] as const;
  };
  const log: unknown[] = [];

  log.push('args', w.args_sizes_get!(OUT, OUT + 4), u32(OUT), u32(OUT + 4));
  w.args_get!(OUT, BUF);
  log.push(text(u32(OUT), 4), text(u32(OUT + 4), 4));
  log.push('environ', w.environ_sizes_get!(OUT, OUT + 4), u32(OUT), u32(OUT + 4));
  w.environ_get!(OUT, BUF);
  log.push(text(u32(OUT), 3), text(u32(OUT + 4), 5));

  log.push('prestat', w.fd_prestat_get!(3, OUT), dv().getUint8(OUT), u32(OUT + 4));
  log.push(w.fd_prestat_dir_name!(3, BUF, 8), text(BUF, 8));
  log.push('prestat-4', w.fd_prestat_get!(4, OUT));

  const [r1, fd] = open('a.txt');
  log.push('open', r1, fd);
  iov(5);
  log.push('read', w.fd_read!(fd, IOV, 1, OUT), u32(OUT), text(BUF, 5));
  log.push('tell', w.fd_tell!(fd, OUT), u64(OUT));
  log.push('seek', w.fd_seek!(fd, -3n, 2, OUT), u64(OUT));
  iov(64);
  log.push('read-rest', w.fd_read!(fd, IOV, 1, OUT), u32(OUT), text(BUF, u32(OUT)));
  log.push('pread', w.fd_pread!(fd, IOV, 1, 6n, OUT), u32(OUT), text(BUF, u32(OUT)));
  log.push('fdstat', w.fd_fdstat_get!(fd, OUT), dv().getUint8(OUT));
  log.push('filestat', w.fd_filestat_get!(fd, OUT), dv().getUint8(OUT + 16), u64(OUT + 32));
  log.push('close', w.fd_close!(fd), w.fd_close!(fd));

  const [r2, out] = open('new.txt', 1 | 8);
  log.push('create', r2);
  u8().set(new TextEncoder().encode('abcdef'), BUF);
  iov(6);
  log.push('write', w.fd_write!(out, IOV, 1, OUT), u32(OUT));
  log.push('pwrite', w.fd_pwrite!(out, IOV, 1, 10n, OUT), u32(OUT));
  log.push('setsize', w.fd_filestat_set_size!(out, 4n));
  w.fd_close!(out);
  log.push('content', nodeFs.readFileSync(join(dir, 'new.txt'), 'utf8'));

  const [r3, app] = open('new.txt', 0, 0x40n, 1);
  iov(2);
  log.push('append', r3, w.fd_write!(app, IOV, 1, OUT), u32(OUT));
  w.fd_close!(app);
  log.push('appended', nodeFs.readFileSync(join(dir, 'new.txt'), 'utf8'));

  log.push('excl', open('new.txt', 1 | 4)[0]);
  log.push('missing', open('nope')[0]);
  log.push('escape', open('../outside')[0]);
  log.push('notdir', open('a.txt', 2)[0]);
  log.push('dir-trunc', open('sub', 8)[0]);

  const [r4, sub] = open('sub', 2, 0x4000n);
  log.push('opendir', r4, w.fd_fdstat_get!(sub, OUT), dv().getUint8(OUT));
  log.push('read-dir', w.fd_read!(sub, IOV, 1, OUT));
  log.push('readdir', w.fd_readdir!(sub, BUF, 4096, 0n, OUT));
  const names: string[] = [];
  for (let at = BUF, end = BUF + u32(OUT); at < end;) {
    const len = dv().getUint32(at + 16, true);
    names.push(`${text(at + 24, len)}:${dv().getUint8(at + 20)}`);
    at += 24 + len;
  }
  log.push(names.sort());
  log.push('readdir-small', w.fd_readdir!(sub, BUF, 10, 0n, OUT), u32(OUT));
  w.fd_close!(sub);

  log.push(
    'mkdir',
    w.path_create_directory!(3, STR, put('made')),
    w.path_create_directory!(3, STR, put('made')),
  );
  log.push('stat', w.path_filestat_get!(3, 1, STR, put('made'), OUT), dv().getUint8(OUT + 16));
  log.push('rmdir-nonempty', w.path_remove_directory!(3, STR, put('sub')));
  log.push('rmdir', w.path_remove_directory!(3, STR, put('made')));
  const target = new TextEncoder().encode('a.txt');
  u8().set(target, BUF);
  log.push('symlink', w.path_symlink!(BUF, target.length, 3, STR, put('link')));
  log.push('lstat', w.path_filestat_get!(3, 0, STR, put('link'), OUT), dv().getUint8(OUT + 16));
  log.push('stat-follow', w.path_filestat_get!(3, 1, STR, put('link'), OUT), u64(OUT + 32));
  log.push('nofollow-open', open('link', 0, 0x2n)[0] === 0 ? 'opened' : 'refused');
  log.push(
    'readlink',
    w.path_readlink!(3, STR, put('link'), BUF + 100, 64, OUT),
    text(BUF + 100, u32(OUT)),
  );
  log.push(
    'unlink',
    w.path_unlink_file!(3, STR, put('link')),
    w.path_unlink_file!(3, STR, put('link')),
  );
  u8().set(new TextEncoder().encode('renamed.txt'), BUF);
  log.push('rename', w.path_rename!(3, STR, put('new.txt'), 3, BUF, 11));
  log.push('renamed', nodeFs.existsSync(join(dir, 'renamed.txt')));

  log.push('badf', w.fd_read!(42, IOV, 1, OUT), w.fd_seek!(42, 0n, 0, OUT));
  log.push('clock', w.clock_time_get!(0, 1n, OUT), u64(OUT) > 1_600_000_000_000_000_000n);
  log.push('clock-bad', w.clock_time_get!(9, 1n, OUT));
  log.push('random', w.random_get!(BUF, 32));
  log.push('yield', w.sched_yield!());
  return log;
}

describe('node:wasi', () => {
  it('matches Node for the same preview1 calls', () => {
    const ours = scenario(ClientWASI);
    nodeFs.rmSync(dir, { recursive: true });
    nodeFs.mkdirSync(dir);
    nodeFs.writeFileSync(join(dir, 'a.txt'), 'hello wasi');
    nodeFs.mkdirSync(join(dir, 'sub'));
    nodeFs.writeFileSync(join(dir, 'sub', 'x'), '');
    const node = scenario(NodeWASI as unknown as new (options: object) => WasiLike);
    expect(ours).toEqual(node);
  });

  it('sleeps in poll_oneoff on a relative clock', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasi = new ClientWASI({ version: 'preview1' });
    wasi.initialize({ exports: { memory } });
    const dv = new DataView(memory.buffer);
    dv.setBigUint64(0, 7n, true); // userdata
    dv.setUint8(8, 0); // clock
    dv.setUint32(16, 1, true); // monotonic
    dv.setBigUint64(24, 30_000_000n, true); // 30 ms
    const t0 = performance.now();
    expect(wasi.wasiImport.poll_oneoff!(0, 64, 1, 128)).toBe(0);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
    expect(dv.getUint32(128, true)).toBe(1);
    expect(dv.getBigUint64(64, true)).toBe(7n);
  });

  it('validates options and instances like Node', () => {
    expect(() => new ClientWASI({})).toThrow(/options\.version/);
    expect(() => new ClientWASI({ version: 'preview2' })).toThrow(/preview1/);
    const wasi = new ClientWASI({ version: 'preview1' });
    expect(() => wasi.initialize({ exports: {} })).toThrow(/memory/);
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.initialize({ exports: { memory } });
    expect(() => wasi.initialize({ exports: { memory } })).toThrow(
      expect.objectContaining({ code: 'ERR_WASI_ALREADY_STARTED' }),
    );
  });
});
