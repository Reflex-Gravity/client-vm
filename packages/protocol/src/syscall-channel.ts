// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous syscall channel over a SharedArrayBuffer.
 *
 * One channel per process. The process (client) writes a request, flips
 * `state` to REQUEST and blocks in `Atomics.wait`. The kernel (server) is woken
 * either by `Atomics.waitAsync` on the same slot or by a postMessage doorbell,
 * services the request, writes the response and flips `state` to RESPONSE.
 *
 * Payloads larger than the shared payload region are streamed in chunks using
 * the channel-level opcodes in {@link ChannelOp}, so the buffer never grows.
 *
 * Layout: [ header: Int32 x HEADER_SLOTS | payload: capacity bytes ]
 */
import { ChannelOp } from './opcodes.ts';
import { errnoOf } from './errors.ts';

const Slot = {
  STATE: 0,
  OP: 1,
  /** Bytes of payload in this message. */
  LEN: 2,
  /** Positive errno for a failed response, 0 on success. */
  ERRNO: 3,
  /** Total length of the request/response being streamed. */
  TOTAL: 4,
  /** 1 while the process is stopped (job control); it waits on this slot. */
  STOPPED: 5,
} as const;

const HEADER_SLOTS = 8;
const HEADER_BYTES = HEADER_SLOTS * Int32Array.BYTES_PER_ELEMENT;

const State = {
  IDLE: 0,
  REQUEST: 1,
  RESPONSE: 2,
} as const;

export const DEFAULT_PAYLOAD_BYTES = 256 * 1024;

export function createChannelBuffer(payloadBytes = DEFAULT_PAYLOAD_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + payloadBytes);
}

/** Raised on the client when the kernel answers with a non-zero errno. */
export class SyscallError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super(`syscall failed with errno ${errno}`);
    this.name = 'SyscallError';
    this.errno = errno;
  }
}

class ChannelView {
  readonly header: Int32Array;
  readonly payload: Uint8Array;
  readonly capacity: number;

  constructor(sab: SharedArrayBuffer) {
    if (sab.byteLength <= HEADER_BYTES) throw new RangeError('syscall channel buffer too small');
    this.header = new Int32Array(sab, 0, HEADER_SLOTS);
    this.payload = new Uint8Array(sab, HEADER_BYTES);
    this.capacity = this.payload.length;
  }
}

export interface SyscallClientOptions {
  /**
   * Called after a request is posted, to wake a kernel that is not parked in
   * `Atomics.waitAsync` (the postMessage doorbell mode).
   */
  doorbell?: () => void;
}

/** Process side. Blocks the calling thread; must not run on a browser main thread. */
export class SyscallClient {
  private readonly ch: ChannelView;
  private readonly doorbell: (() => void) | undefined;

  constructor(sab: SharedArrayBuffer, options: SyscallClientOptions = {}) {
    this.ch = new ChannelView(sab);
    this.doorbell = options.doorbell;
  }

  /** Performs one syscall. Throws {@link SyscallError} on a non-zero errno. */
  call(op: number, request: Uint8Array = EMPTY): Uint8Array {
    const { header, payload, capacity } = this.ch;
    const total = request.length;

    let offset = 0;
    do {
      const n = Math.min(capacity, total - offset);
      payload.set(request.subarray(offset, offset + n));
      header[Slot.OP] = offset === 0 ? op : ChannelOp.REQUEST_MORE;
      header[Slot.LEN] = n;
      header[Slot.TOTAL] = total;
      this.roundTrip();
      offset += n;
    } while (offset < total);

    const errno = header[Slot.ERRNO]!;
    if (errno !== 0) throw new SyscallError(errno);

    const len = header[Slot.LEN]!;
    const responseTotal = header[Slot.TOTAL]!;
    // slice() copies into a non-shared buffer that callers can keep and decode.
    const first = payload.slice(0, len);
    if (len === responseTotal) return first;

    const out = new Uint8Array(responseTotal);
    out.set(first);
    let received = len;
    while (received < responseTotal) {
      header[Slot.OP] = ChannelOp.RESPONSE_MORE;
      header[Slot.LEN] = 0;
      this.roundTrip();
      const chunk = header[Slot.LEN]!;
      out.set(payload.subarray(0, chunk), received);
      received += chunk;
    }
    return out;
  }

  private roundTrip(): void {
    const { header } = this.ch;
    Atomics.store(header, Slot.STATE, State.REQUEST);
    if (this.doorbell) this.doorbell();
    else Atomics.notify(header, Slot.STATE);
    while (Atomics.load(header, Slot.STATE) === State.REQUEST) {
      Atomics.wait(header, Slot.STATE, State.REQUEST);
    }
  }
}

/** Handles one decoded request. Throw a `SystemError` to answer with its errno. */
export type SyscallHandler = (op: number, request: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Kernel side of one process's channel. */
export class SyscallServer {
  private readonly ch: ChannelView;
  private readonly handler: SyscallHandler;
  private busy = false;
  private closed = false;
  private pendingRequest: { op: number; data: Uint8Array; received: number } | null = null;
  private pendingResponse: { data: Uint8Array; sent: number } | null = null;

  constructor(sab: SharedArrayBuffer, handler: SyscallHandler) {
    this.ch = new ChannelView(sab);
    this.handler = handler;
  }

  /**
   * Services a pending request if there is one. Call this from a doorbell, or
   * let {@link listen} drive it. Returns false if there was nothing to do.
   */
  service(): boolean | Promise<boolean> {
    if (this.busy || Atomics.load(this.ch.header, Slot.STATE) !== State.REQUEST) return false;
    this.busy = true;
    let result: Uint8Array | Promise<Uint8Array> | undefined;
    try {
      result = this.dispatch();
    } catch (err) {
      this.respondError(err);
      return true;
    }
    if (result instanceof Uint8Array) {
      this.respond(result);
      return true;
    }
    return result.then(
      (bytes) => {
        this.respond(bytes);
        return true;
      },
      (err: unknown) => {
        this.respondError(err);
        return true;
      },
    );
  }

  /** Parks on the channel with `Atomics.waitAsync` and services requests until closed. */
  async listen(): Promise<void> {
    const { header } = this.ch;
    while (!this.closed) {
      const state = Atomics.load(header, Slot.STATE);
      if (state === State.REQUEST) {
        await this.service();
        continue;
      }
      const waiter = Atomics.waitAsync(header, Slot.STATE, state);
      if (waiter.async) await waiter.value;
    }
  }

  /** True while the process is parked in a syscall (it cannot run JavaScript then). */
  get waiting(): boolean {
    return this.busy || Atomics.load(this.ch.header, Slot.STATE) === State.REQUEST;
  }

  close(): void {
    this.closed = true;
    // Wake a parked listen() loop so it can observe `closed`.
    Atomics.notify(this.ch.header, Slot.STATE);
  }

  private dispatch(): Uint8Array | Promise<Uint8Array> {
    const { header, payload } = this.ch;
    const op = header[Slot.OP]!;
    const len = header[Slot.LEN]!;
    const total = header[Slot.TOTAL]!;

    if (op === ChannelOp.RESPONSE_MORE) {
      const pending = this.pendingResponse;
      if (!pending) throw new Error('RESPONSE_MORE without a pending response');
      return pending.data;
    }

    if (op === ChannelOp.REQUEST_MORE) {
      const pending = this.pendingRequest;
      if (!pending) throw new Error('REQUEST_MORE without a pending request');
      pending.data.set(payload.subarray(0, len), pending.received);
      pending.received += len;
      if (pending.received < pending.data.length) return ACK;
      this.pendingRequest = null;
      return this.handler(pending.op, pending.data);
    }

    this.pendingResponse = null;
    if (len < total) {
      const data = new Uint8Array(total);
      data.set(payload.subarray(0, len));
      this.pendingRequest = { op, data, received: len };
      return ACK;
    }
    return this.handler(op, payload.slice(0, len));
  }

  private respond(data: Uint8Array): void {
    const { header, payload, capacity } = this.ch;
    let start = 0;
    if (header[Slot.OP] === ChannelOp.RESPONSE_MORE && this.pendingResponse) {
      start = this.pendingResponse.sent;
    }
    const n = Math.min(capacity, data.length - start);
    payload.set(data.subarray(start, start + n));
    if (start + n < data.length) {
      this.pendingResponse = { data, sent: start + n };
    } else {
      this.pendingResponse = null;
    }
    header[Slot.LEN] = n;
    header[Slot.TOTAL] = data.length;
    header[Slot.ERRNO] = 0;
    this.finish();
  }

  private respondError(err: unknown): void {
    const { header } = this.ch;
    this.pendingRequest = null;
    this.pendingResponse = null;
    header[Slot.LEN] = 0;
    header[Slot.TOTAL] = 0;
    header[Slot.ERRNO] = errnoOf(err);
    this.finish();
  }

  private finish(): void {
    this.busy = false;
    Atomics.store(this.ch.header, Slot.STATE, State.RESPONSE);
    Atomics.notify(this.ch.header, Slot.STATE);
  }
}

const EMPTY = new Uint8Array(0);
const ACK = new Uint8Array(0);

/**
 * Process side of a stop (job control): blocks the calling thread until the
 * kernel continues it with {@link continueStopped}. The process reports
 * `stopped` to the kernel after this marks it, so a SIGCONT cannot be lost.
 */
export function markStopped(sab: SharedArrayBuffer): void {
  Atomics.store(new Int32Array(sab, 0, HEADER_SLOTS), Slot.STOPPED, 1);
}

/** Blocks while the process is marked stopped. */
export function waitWhileStopped(sab: SharedArrayBuffer): void {
  const header = new Int32Array(sab, 0, HEADER_SLOTS);
  while (Atomics.load(header, Slot.STOPPED) === 1) Atomics.wait(header, Slot.STOPPED, 1);
}

/** Kernel side: wakes a stopped process (SIGCONT). */
export function continueStopped(sab: SharedArrayBuffer): void {
  const header = new Int32Array(sab, 0, HEADER_SLOTS);
  Atomics.store(header, Slot.STOPPED, 0);
  Atomics.notify(header, Slot.STOPPED);
}
