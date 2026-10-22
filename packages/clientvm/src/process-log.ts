// SPDX-License-Identifier: Apache-2.0
import type { Disposable, ProcessEvent, ProcessInfo, Signal } from './types.ts';

interface Entry {
  info: ProcessInfo;
  chunks: { fd: 1 | 2; data: Uint8Array }[];
  bytes: number;
  /** Output bytes no longer kept (the oldest go first). */
  dropped: number;
  exit: Extract<ProcessEvent, { type: 'exit' }> | null;
}

export interface ProcessLogLimits {
  /** Processes kept; the oldest exited ones are forgotten first. */
  maxProcesses: number;
  /** Output kept per process; the most recent is kept. */
  maxBytesPerProcess: number;
}

const DEFAULT_LIMITS: ProcessLogLimits = { maxProcesses: 100, maxBytesPerProcess: 256 * 1024 };

/**
 * The events behind `Instance.onProcess`, plus a bounded history replayed to
 * each new listener: an instance's output is hostile and must not grow the
 * host page's memory without limit.
 */
export class ProcessLog {
  private readonly entries = new Map<number, Entry>();
  private readonly listeners = new Set<(e: ProcessEvent) => void>();
  private readonly limits: ProcessLogLimits;

  constructor(limits: Partial<ProcessLogLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  spawn(info: ProcessInfo): void {
    // Kernels never reuse pids, but a hostile one could; keep replay in spawn order.
    this.entries.delete(info.pid);
    this.entries.set(info.pid, { info, chunks: [], bytes: 0, dropped: 0, exit: null });
    this.evict();
    this.emit({ type: 'spawn', process: info });
  }

  output(pid: number, fd: 1 | 2, data: Uint8Array): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.exit) return;
    entry.chunks.push({ fd, data });
    entry.bytes += data.byteLength;
    while (entry.bytes > this.limits.maxBytesPerProcess && entry.chunks.length > 1) {
      const old = entry.chunks.shift()!;
      entry.bytes -= old.data.byteLength;
      entry.dropped += old.data.byteLength;
    }
    this.emit({ type: 'output', pid, fd, data });
  }

  exit(pid: number, code: number, signal: Signal | null): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.exit) return;
    entry.exit = { type: 'exit', pid, code, ...(signal ? { signal } : {}), exitedAt: Date.now() };
    this.emit(entry.exit);
  }

  /** Replays the history to `cb`, then reports new events. */
  subscribe(cb: (e: ProcessEvent) => void): Disposable {
    for (const entry of this.entries.values()) {
      const { pid } = entry.info;
      cb({ type: 'spawn', process: entry.info });
      if (entry.dropped > 0)
        cb({
          type: 'output',
          pid,
          fd: 1,
          data: new TextEncoder().encode(`[clientvm: ${entry.dropped} earlier bytes not kept]\n`),
        });
      for (const { fd, data } of entry.chunks) cb({ type: 'output', pid, fd, data });
      if (entry.exit) cb(entry.exit);
    }
    this.listeners.add(cb);
    return { dispose: () => void this.listeners.delete(cb) };
  }

  /** Stops reporting; the history is dropped. */
  clear(): void {
    this.entries.clear();
    this.listeners.clear();
  }

  private evict(): void {
    for (const [pid, entry] of this.entries) {
      if (this.entries.size <= this.limits.maxProcesses) return;
      if (entry.exit) this.entries.delete(pid);
    }
  }

  private emit(e: ProcessEvent): void {
    for (const cb of this.listeners) {
      // A throwing listener must not stop delivery to the process handle or other listeners.
      try {
        cb(e);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
