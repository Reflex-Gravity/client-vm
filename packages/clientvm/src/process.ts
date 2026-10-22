// SPDX-License-Identifier: Apache-2.0
import { ClientVMError } from './errors.ts';
import type { Process, Signal, WindowSize } from './types.ts';
import { isWindowSize } from './validate.ts';

/** Unread output kept per stream; beyond this, output is dropped (with a note) until read. */
const OUTPUT_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Controller-side handle for a process running in an instance. Unread output
 * is kept up to 8 MiB per stream; past that it is dropped and a note says how
 * much, so a chatty process cannot exhaust the host page's memory.
 */
export class ProcessHandleImpl implements Process {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<{ code: number; signal?: Signal }>;

  private readonly outCtl: ReadableStreamDefaultController<Uint8Array>;
  private readonly errCtl: ReadableStreamDefaultController<Uint8Array>;
  private readonly dropped = { 1: 0, 2: 0 };
  private resolveExit!: (value: { code: number; signal?: Signal }) => void;
  private exited = false;
  private readonly sendKill: (signal: Signal) => Promise<void>;
  private readonly sendResize: ((size: WindowSize) => Promise<void>) | null;

  constructor(
    pid: number,
    sendKill: (signal: Signal) => Promise<void>,
    sendStdin: (data: Uint8Array | null) => Promise<void>,
    sendResize: ((size: WindowSize) => Promise<void>) | null = null,
  ) {
    this.pid = pid;
    this.sendKill = sendKill;
    this.sendResize = sendResize;
    let outCtl!: ReadableStreamDefaultController<Uint8Array>;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    const strategy = (): QueuingStrategy<Uint8Array> => ({
      highWaterMark: OUTPUT_BUFFER_BYTES,
      size: (chunk) => chunk.byteLength,
    });
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => void (outCtl = c) }, strategy());
    this.stderr = new ReadableStream<Uint8Array>({ start: (c) => void (errCtl = c) }, strategy());
    this.outCtl = outCtl;
    this.errCtl = errCtl;
    this.stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!(chunk instanceof Uint8Array)) throw new TypeError('stdin takes Uint8Array chunks');
        if (!this.exited) await sendStdin(chunk);
      },
      close: async () => {
        if (!this.exited) await sendStdin(null);
      },
    });
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  kill(signal: Signal = 'SIGTERM'): void {
    if (this.exited) return;
    // A process may exit on its own before the kill arrives (ESRCH); that's fine.
    this.sendKill(signal).catch(() => {});
  }

  resize(cols: number, rows: number): void {
    if (!this.sendResize)
      throw new ClientVMError(`process ${this.pid} has no terminal`, 'ERR_NOT_A_TERMINAL');
    const size = { cols, rows };
    if (!isWindowSize(size))
      throw new TypeError('cols and rows must be whole numbers from 1 to 10000');
    if (this.exited) return;
    this.sendResize(size).catch(() => {});
  }

  /** @internal */
  deliverOutput(fd: 1 | 2, data: Uint8Array): void {
    if (this.exited) return;
    const ctl = fd === 1 ? this.outCtl : this.errCtl;
    if ((ctl.desiredSize ?? 0) <= 0) {
      this.dropped[fd] += data.length;
      return;
    }
    if (this.dropped[fd] > 0) {
      ctl.enqueue(
        new TextEncoder().encode(
          `\n[clientvm: ${this.dropped[fd]} bytes of unread output dropped]\n`,
        ),
      );
      this.dropped[fd] = 0;
    }
    ctl.enqueue(data);
  }

  /** @internal */
  deliverExit(code: number, signal: Signal | null): void {
    if (this.exited) return;
    this.exited = true;
    this.outCtl.close();
    this.errCtl.close();
    this.resolveExit(signal ? { code, signal } : { code });
  }
}
