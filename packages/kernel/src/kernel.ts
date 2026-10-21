// SPDX-License-Identifier: Apache-2.0
import {
  DEFAULT_PAYLOAD_BYTES,
  SIGNAL_NUMBERS,
  SyscallServer,
  SystemError,
  createChannelBuffer,
} from '@clientvm/protocol';
import type { KernelToProcess, ProcessToKernel, Signal, SyscallMode } from '@clientvm/protocol';
import { MemoryVfs, importImage } from '@clientvm/vfs';
import type { Snapshot, VfsLimits } from '@clientvm/vfs';
import { createSyscallHandler } from './dispatcher.ts';
import { FdTable } from './fd-table.ts';

/** The subset of `Worker` the kernel needs; lets tests substitute Node worker_threads. */
export interface ProcessWorkerLike {
  postMessage(message: KernelToProcess): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ProcessToKernel>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface KernelOptions {
  createProcessWorker: () => ProcessWorkerLike;
  /** Bytes in each process's shared syscall payload region. */
  payloadBytes?: number;
  /** Directories created at boot. */
  seedDirs?: readonly string[];
  /** Filesystem limits (ENOSPC when exceeded). */
  fsLimits?: VfsLimits;
  /** Maximum concurrently running processes (spawn fails with EAGAIN beyond it). */
  maxProcesses?: number;
  /** Boot from a filesystem image (see `exportImage`) instead of seeding directories. */
  image?: readonly Uint8Array[];
}

export interface SpawnOptions {
  env?: Record<string, string>;
  cwd?: string;
  syscallMode?: SyscallMode;
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
}

export interface ProcessTiming {
  /** `performance.now()` in the kernel when spawn was called. */
  spawnedAt: number;
  /** When the process reported its runtime was booted. */
  readyAt?: number;
  exitedAt?: number;
}

export interface ProcessExit {
  code: number;
  /** Set when the process was killed by a signal. */
  signal: Signal | null;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly exit: Promise<ProcessExit>;
  readonly timing: ProcessTiming;
  /** Terminates the process worker immediately; exit code is 128 + signal number. */
  kill(signal?: Signal): void;
}

export const DEFAULT_SEED_DIRS = [
  '/bin',
  '/etc',
  '/home',
  '/home/user',
  '/tmp',
  '/usr',
  '/usr/bin',
];

export class Kernel {
  readonly vfs: MemoryVfs;
  private readonly options: KernelOptions;
  private nextPid = 1;
  private readonly processes = new Map<number, ProcessHandle>();
  private readonly snapshots = new Map<number, Snapshot>();
  private nextSnapshot = 1;

  constructor(options: KernelOptions) {
    this.options = options;
    if (options.image) {
      this.vfs = MemoryVfs.fromSnapshot(importImage(options.image), options.fsLimits);
      return;
    }
    this.vfs = new MemoryVfs(options.fsLimits);
    for (const dir of options.seedDirs ?? DEFAULT_SEED_DIRS) {
      this.vfs.mkdir(dir, { recursive: true });
    }
  }

  get processCount(): number {
    return this.processes.size;
  }

  /** Takes a copy-on-write snapshot held by this kernel. */
  snapshot(): number {
    const id = this.nextSnapshot++;
    this.snapshots.set(id, this.vfs.snapshot());
    return id;
  }

  getSnapshot(id: number): Snapshot {
    const snap = this.snapshots.get(id);
    if (!snap) throw new SystemError('ENOENT', 'snapshot', String(id));
    return snap;
  }

  dropSnapshot(id: number): void {
    this.snapshots.delete(id);
  }

  /** Kills every process (instance shutdown). */
  killAll(signal: Signal = 'SIGKILL'): void {
    for (const proc of [...this.processes.values()]) proc.kill(signal);
  }

  spawn(argv: string[], options: SpawnOptions = {}): ProcessHandle {
    const { maxProcesses } = this.options;
    if (maxProcesses !== undefined && this.processes.size >= maxProcesses) {
      throw new SystemError('EAGAIN', 'spawn');
    }
    const pid = this.nextPid++;
    const syscallMode = options.syscallMode ?? 'waitAsync';
    const channel = createChannelBuffer(this.options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES);
    const fds = new FdTable(this.vfs);
    const server = new SyscallServer(channel, createSyscallHandler(this.vfs, fds));
    const timing: ProcessTiming = { spawnedAt: performance.now() };
    const worker = this.options.createProcessWorker();

    let settle!: (code: number, signal?: Signal) => void;
    const exit = new Promise<ProcessExit>((resolve) => {
      settle = (code, signal) => {
        if (timing.exitedAt !== undefined) return;
        timing.exitedAt = performance.now();
        server.close();
        worker.terminate();
        fds.closeAll();
        this.processes.delete(pid);
        resolve({ code, signal: signal ?? null });
      };
    });

    worker.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.t) {
        case 'doorbell':
          void server.service();
          break;
        case 'stdout':
          options.onStdout?.(msg.data);
          break;
        case 'stderr':
          options.onStderr?.(msg.data);
          break;
        case 'ready':
          timing.readyAt = performance.now();
          break;
        case 'exit':
          settle(msg.code);
          break;
      }
    });
    worker.addEventListener('error', (event) => {
      options.onStderr?.(new TextEncoder().encode(`process ${pid} crashed: ${event.message}\n`));
      settle(1);
    });

    if (syscallMode === 'waitAsync') void server.listen();

    worker.postMessage({
      t: 'init',
      pid,
      channel,
      syscallMode,
      argv,
      env: options.env ?? {},
      cwd: options.cwd ?? '/home/user',
    });

    const handle: ProcessHandle = {
      pid,
      exit,
      timing,
      kill: (signal = 'SIGTERM') => settle(128 + SIGNAL_NUMBERS[signal], signal),
    };
    this.processes.set(pid, handle);
    return handle;
  }

  getProcess(pid: number): ProcessHandle | undefined {
    return this.processes.get(pid);
  }
}
