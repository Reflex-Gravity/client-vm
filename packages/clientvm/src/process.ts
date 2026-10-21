// SPDX-License-Identifier: Apache-2.0
import type { Process, Signal } from './types.ts';
import { NotImplementedError } from './errors.ts';

/**
 * Controller-side handle for a process running in an instance. Output is
 * buffered without bound until read; consumers should drain stdout/stderr.
 */
export class ProcessHandleImpl implements Process {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<{ code: number; signal?: Signal }>;

  private readonly outCtl: ReadableStreamDefaultController<Uint8Array>;
  private readonly errCtl: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (value: { code: number; signal?: Signal }) => void;
  private exited = false;
  private readonly sendKill: (signal: Signal) => Promise<void>;

  constructor(pid: number, sendKill: (signal: Signal) => Promise<void>) {
    this.pid = pid;
    this.sendKill = sendKill;
    let outCtl!: ReadableStreamDefaultController<Uint8Array>;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    this.stdout = new ReadableStream({ start: (c) => void (outCtl = c) });
    this.stderr = new ReadableStream({ start: (c) => void (errCtl = c) });
    this.outCtl = outCtl;
    this.errCtl = errCtl;
    this.stdin = new WritableStream({
      write: () => Promise.reject(new NotImplementedError('process stdin')),
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

  /** @internal */
  deliverOutput(fd: 1 | 2, data: Uint8Array): void {
    if (this.exited) return;
    (fd === 1 ? this.outCtl : this.errCtl).enqueue(data);
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
