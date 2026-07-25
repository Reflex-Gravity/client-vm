// SPDX-License-Identifier: Apache-2.0
import { SyscallServer, createChannelBuffer, DEFAULT_PAYLOAD_BYTES } from '@clientvm/protocol';
import type {
  KernelToProcess,
  ProcessToKernel,
  SyscallHandler,
  SyscallMode,
} from '@clientvm/protocol';
import { MemoryVfs } from '@clientvm/vfs';
import { createSyscallHandler } from './dispatcher.ts';

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

export interface ProcessHandle {
  readonly pid: number;
  readonly exit: Promise<number>;
  readonly timing: ProcessTiming;
  kill(): void;
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

/** Exit code reported when a process dies without calling exit (128 + SIGKILL). */
const KILLED_EXIT_CODE = 137;

export class Kernel {
  readonly vfs = new MemoryVfs();
  private readonly options: KernelOptions;
  private readonly handler: SyscallHandler;
  private nextPid = 1;
  private readonly processes = new Map<number, ProcessHandle>();

  constructor(options: KernelOptions) {
    this.options = options;
    this.handler = createSyscallHandler(this.vfs);
    for (const dir of options.seedDirs ?? DEFAULT_SEED_DIRS)
      this.vfs.mkdir(dir, { recursive: true });
  }

  spawn(argv: string[], options: SpawnOptions = {}): ProcessHandle {
    const pid = this.nextPid++;
    const syscallMode = options.syscallMode ?? 'waitAsync';
    const channel = createChannelBuffer(this.options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES);
    const server = new SyscallServer(channel, this.handler);
    const timing: ProcessTiming = { spawnedAt: performance.now() };
    const worker = this.options.createProcessWorker();

    let settle!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      settle = (code) => {
        if (timing.exitedAt !== undefined) return;
        timing.exitedAt = performance.now();
        server.close();
        worker.terminate();
        this.processes.delete(pid);
        resolve(code);
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

    const handle: ProcessHandle = { pid, exit, timing, kill: () => settle(KILLED_EXIT_CODE) };
    this.processes.set(pid, handle);
    return handle;
  }

  getProcess(pid: number): ProcessHandle | undefined {
    return this.processes.get(pid);
  }
}
