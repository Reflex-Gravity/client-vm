// SPDX-License-Identifier: Apache-2.0
import { SystemError } from '@clientvm/protocol';
import { O_ACCMODE, O_APPEND, O_RDONLY, O_WRONLY } from '@clientvm/vfs';
import type { MemoryVfs } from '@clientvm/vfs';
import { deviceAt } from './devices.ts';
import type { Device } from './devices.ts';

/** An open file description: inode plus offset and access mode. */
export interface OpenFile {
  ino: number;
  flags: number;
  position: number;
  /** Set for character devices; `ino` is then unused. */
  device?: Device;
}

/** First fd handed out; 0-2 are reserved for stdio. */
const FIRST_FD = 3;
export const DEFAULT_MAX_OPEN_FILES = 1024;

/** Per-process file descriptor table. Holds VFS open references until closed. */
export class FdTable {
  private readonly files = new Map<number, OpenFile>();
  private readonly vfs: MemoryVfs;
  private readonly maxOpen: number;

  constructor(vfs: MemoryVfs, maxOpen = DEFAULT_MAX_OPEN_FILES) {
    this.vfs = vfs;
    this.maxOpen = maxOpen;
  }

  open(path: string, flags: number, mode: number): number {
    if (this.files.size >= this.maxOpen) throw new SystemError('EMFILE', 'open', path);
    const device = deviceAt(path);
    const ino = device ? -1 : this.vfs.open(path, flags, mode);
    let fd = FIRST_FD;
    while (this.files.has(fd)) fd++;
    this.files.set(fd, device ? { ino, flags, position: 0, device } : { ino, flags, position: 0 });
    return fd;
  }

  get(fd: number, syscall: string): OpenFile {
    const file = this.files.get(fd);
    if (!file) throw new SystemError('EBADF', syscall);
    return file;
  }

  close(fd: number): void {
    const file = this.get(fd, 'close');
    this.files.delete(fd);
    if (!file.device) this.vfs.release(file.ino);
  }

  /** Reads at `position`, or at (and advancing) the file offset when null. */
  read(fd: number, length: number, position: number | null): Uint8Array {
    const file = this.get(fd, 'read');
    if ((file.flags & O_ACCMODE) === O_WRONLY) throw new SystemError('EBADF', 'read');
    if (file.device) return file.device.read(length);
    const data = this.vfs.readAt(file.ino, length, position ?? file.position);
    if (position === null) file.position += data.length;
    return data;
  }

  /** Writes at `position`, or at (and advancing) the file offset when null. Returns bytes written. */
  write(fd: number, data: Uint8Array, position: number | null): number {
    const file = this.get(fd, 'write');
    if ((file.flags & O_ACCMODE) === O_RDONLY) throw new SystemError('EBADF', 'write');
    if (file.device) return data.length;
    // Linux: O_APPEND writes always go to the end, even with an explicit position.
    const append = (file.flags & O_APPEND) !== 0;
    const end = this.vfs.writeAt(file.ino, data, position ?? file.position, append);
    if (position === null || append) file.position = end;
    return data.length;
  }

  /** Closes everything (process exit). */
  closeAll(): void {
    for (const fd of [...this.files.keys()]) this.close(fd);
  }
}
