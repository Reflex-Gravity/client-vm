// SPDX-License-Identifier: Apache-2.0

/** Syscall opcodes carried in the channel header. */
export const Op = {
  NOOP: 0,
  STAT: 1,
  LSTAT: 2,
  READDIR: 3,
  READ_FILE: 4,
  WRITE_FILE: 5,
  MKDIR: 6,
  RMDIR: 7,
  UNLINK: 8,
  RM_TREE: 9,
  RENAME: 10,
  SYMLINK: 11,
  READLINK: 12,
  LINK: 13,
  REALPATH: 14,
  ACCESS: 15,
  CHMOD: 16,
  UTIMES: 17,
  TRUNCATE: 18,
  COPY_FILE: 19,
  // File descriptors (per-process tables live in the kernel).
  OPEN: 20,
  CLOSE: 21,
  READ: 22,
  WRITE: 23,
  FSTAT: 24,
  FTRUNCATE: 25,
  /** Runs a child to completion while the caller blocks (spawnSync / execSync). */
  SPAWN_SYNC: 26,
} as const;

export type Op = (typeof Op)[keyof typeof Op];

/**
 * Channel-level opcodes used to stream payloads larger than the shared buffer.
 * Negative so they never collide with syscall opcodes.
 */
export const ChannelOp = {
  /** Next chunk of a request whose total length exceeds the payload capacity. */
  REQUEST_MORE: -1,
  /** Ask for the next chunk of a response that did not fit. */
  RESPONSE_MORE: -2,
} as const;
