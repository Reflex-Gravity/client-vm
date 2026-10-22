// SPDX-License-Identifier: Apache-2.0
// Character devices: /dev/null, /dev/zero, /dev/random and /dev/urandom.
// They are handled by path in the syscall layer (the VFS stores only empty
// placeholders, so `ls /dev` lists them and snapshots need no device inodes).

import type { StatData } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';

const S_IFCHR = 0o020000;
/** Reads of the infinite devices return at most this much per call. */
const MAX_CHUNK = 64 * 1024;

export interface Device {
  /** Linux major/minor, for `rdev`. */
  readonly rdev: number;
  read(length: number): Uint8Array;
}

const random = (length: number) =>
  crypto.getRandomValues(new Uint8Array(Math.min(Math.max(length, 0), MAX_CHUNK)));

export const DEVICES: ReadonlyMap<string, Device> = new Map<string, Device>([
  ['/dev/null', { rdev: (1 << 8) | 3, read: () => new Uint8Array(0) }],
  [
    '/dev/zero',
    { rdev: (1 << 8) | 5, read: (n) => new Uint8Array(Math.min(Math.max(n, 0), MAX_CHUNK)) },
  ],
  ['/dev/random', { rdev: (1 << 8) | 8, read: random }],
  ['/dev/urandom', { rdev: (1 << 8) | 9, read: random }],
]);

/** The device at `path` (absolute, lexically normalized), if any. */
export function deviceAt(path: string): Device | undefined {
  if (!path.includes('dev/')) return undefined;
  return DEVICES.get(path.replace(/\/+/g, '/'));
}

const BOOT = Date.now();

export function deviceStat(device: Device): StatData {
  return {
    dev: 5,
    ino: 0,
    mode: S_IFCHR | 0o666,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: device.rdev,
    size: 0,
    blksize: 4096,
    blocks: 0,
    atimeMs: BOOT,
    mtimeMs: BOOT,
    ctimeMs: BOOT,
    birthtimeMs: BOOT,
  };
}

/** Creates /dev with placeholder entries so directory listings show the devices. */
export function installDevices(vfs: MemoryVfs): void {
  vfs.mkdir('/dev', { recursive: true });
  for (const path of DEVICES.keys()) {
    try {
      vfs.lstat(path);
    } catch {
      vfs.writeFile(path, new Uint8Array(0), 0o666);
    }
  }
}
