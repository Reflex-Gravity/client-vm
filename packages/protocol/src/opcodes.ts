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
