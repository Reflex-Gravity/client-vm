// SPDX-License-Identifier: Apache-2.0
import {
  DEFAULT_PAYLOAD_BYTES,
  SIGNAL_NUMBERS,
  SyscallServer,
  SystemError,
  createChannelBuffer,
  decode,
  encode,
  errnoOf,
} from '@clientvm/protocol';
import type {
  ChildSpawnRequest,
  KernelToProcess,
  ProcessToKernel,
  Signal,
  SyscallMode,
  Value,
} from '@clientvm/protocol';
import { MemoryVfs, importImage } from '@clientvm/vfs';
import type { Snapshot, VfsLimits } from '@clientvm/vfs';
import { installBuiltinCommands, resolveCommand } from './commands.ts';
import { installDevices } from './devices.ts';
import { createSyscallHandler } from './dispatcher.ts';
import { FdTable } from './fd-table.ts';
import type { NetStack } from './net.ts';

/** The subset of `Worker` the kernel needs; lets tests substitute Node worker_threads. */
export interface ProcessWorkerLike {
  postMessage(message: KernelToProcess): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ProcessToKernel>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface KernelOptions {
  createProcessWorker: () => ProcessWorkerLike;
  /** Names of the built-in runtimes; each gets a marker file in /usr/local/bin. */
  commands?: readonly string[];
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
  /** Boot from a snapshot (e.g. restored from persistent storage). Takes precedence over `image`. */
  snapshot?: Snapshot;
  /** The instance's virtual network; without it, `listen`/`connect` fail with ENOSYS. */
  net?: NetStack;
}

export interface SpawnOptions {
  env?: Record<string, string>;
  cwd?: string;
  syscallMode?: SyscallMode;
  /** 'pipe' keeps stdin open for `writeStdin`; 'closed' (default) starts at end-of-file. */
  stdin?: 'pipe' | 'closed';
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
  /** Writes to stdin (null closes it). Ignored unless spawned with `stdin: 'pipe'`. */
  writeStdin(data: Uint8Array | null): void;
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

/** spawnSync results larger than this are truncated, like Node's default maxBuffer. */
const SPAWN_SYNC_MAX_BUFFER = 1024 * 1024 * 64;

export class Kernel {
  readonly vfs: MemoryVfs;
  private readonly options: KernelOptions;
  private nextPid = 1;
  private readonly processes = new Map<number, ProcessHandle>();
  private readonly snapshots = new Map<number, Snapshot>();
  private nextSnapshot = 1;

  constructor(options: KernelOptions) {
    this.options = options;
    if (options.snapshot) {
      this.vfs = MemoryVfs.fromSnapshot(options.snapshot, options.fsLimits);
    } else if (options.image) {
      this.vfs = MemoryVfs.fromSnapshot(importImage(options.image), options.fsLimits);
    } else {
      this.vfs = new MemoryVfs(options.fsLimits);
      for (const dir of options.seedDirs ?? DEFAULT_SEED_DIRS)
        this.vfs.mkdir(dir, { recursive: true });
    }
    // Refreshed on every boot: restored filesystems may predate a runtime.
    installBuiltinCommands(this.vfs, options.commands ?? []);
    installDevices(this.vfs);
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

  /**
   * Starts a process. argv[0] is resolved like execve: PATH lookup, exec
   * permission, shebang interpreters. Throws spawn errors (ENOENT, EACCES, EAGAIN).
   */
  spawn(argv: string[], options: SpawnOptions = {}): ProcessHandle {
    const { maxProcesses } = this.options;
    if (maxProcesses !== undefined && this.processes.size >= maxProcesses) {
      throw new SystemError('EAGAIN', 'spawn');
    }
    const env = options.env ?? {};
    const cwd = options.cwd ?? '/home/user';
    const resolvedArgv = resolveCommand(this.vfs, argv, env, cwd);

    const pid = this.nextPid++;
    const syscallMode = options.syscallMode ?? 'waitAsync';
    const channel = createChannelBuffer(this.options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES);
    const fds = new FdTable(this.vfs);
    const children = new Map<number, ProcessHandle>();
    /** Every live child (spawn and spawnSync), killed with this process like a process group. */
    const descendants = new Set<ProcessHandle>();
    const watches = new Map<number, () => void>();
    const timing: ProcessTiming = { spawnedAt: performance.now() };
    const worker = this.options.createProcessWorker();
    const post = (msg: KernelToProcess) => {
      if (timing.exitedAt === undefined) worker.postMessage(msg);
    };
    const server = new SyscallServer(
      channel,
      createSyscallHandler(this.vfs, fds, {
        spawnSync: (request) => this.spawnSync(request, options, descendants),
      }),
    );

    const net = this.options.net?.attach(post);
    let settle!: (code: number, signal?: Signal) => void;
    const exit = new Promise<ProcessExit>((resolve) => {
      settle = (code, signal) => {
        if (timing.exitedAt !== undefined) return;
        timing.exitedAt = performance.now();
        server.close();
        worker.terminate();
        fds.closeAll();
        for (const stop of watches.values()) stop();
        net?.close();
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
        case 'spawn':
          this.spawnChild(msg.id, msg.request, children, descendants, post, options);
          break;
        case 'child-stdin':
          children.get(msg.id)?.writeStdin(msg.data);
          break;
        case 'child-kill':
          children.get(msg.id)?.kill(msg.signal);
          break;
        case 'watch':
          try {
            const id = msg.id;
            watches.set(
              id,
              this.vfs.watch(msg.path, { recursive: msg.recursive }, (events) =>
                post({ t: 'watch-event', id, events }),
              ),
            );
          } catch {
            // The process stats the path first and reports errors itself.
          }
          break;
        case 'unwatch':
          watches.get(msg.id)?.();
          watches.delete(msg.id);
          break;
        case 'net-listen':
          if (!net) post({ t: 'net-listen-error', id: msg.id, code: 'ENOSYS' });
          else net.handle(msg);
          break;
        case 'net-connect':
          if (!net) post({ t: 'net-connect-error', sid: msg.sid, code: 'ENOSYS' });
          else net.handle(msg);
          break;
        case 'net-unlisten':
        case 'http-res-head':
        case 'http-res-body':
        case 'http-res-end':
        case 'sock-data':
        case 'sock-end':
          net?.handle(msg);
          break;
      }
    });
    worker.addEventListener('error', (event) => {
      options.onStderr?.(new TextEncoder().encode(`process ${pid} crashed: ${event.message}\n`));
      settle(1);
    });

    if (syscallMode === 'waitAsync') void server.listen();

    const stdinOpen = options.stdin === 'pipe';
    worker.postMessage({
      t: 'init',
      pid,
      channel,
      syscallMode,
      argv: resolvedArgv,
      env,
      cwd,
      stdinOpen,
    });

    let stdinClosed = !stdinOpen;
    const handle: ProcessHandle = {
      pid,
      exit,
      timing,
      kill: (signal = 'SIGTERM') => {
        if (timing.exitedAt !== undefined) return;
        settle(128 + SIGNAL_NUMBERS[signal], signal);
        // Like a signal to the process group: children (e.g. a shell's pipeline) go too.
        for (const d of [...descendants]) d.kill(signal);
      },
      writeStdin: (data) => {
        if (stdinClosed) return;
        if (data === null) stdinClosed = true;
        post({ t: 'stdin', data });
      },
    };
    this.processes.set(pid, handle);
    return handle;
  }

  /** A child requested by a process (child_process.spawn). */
  private spawnChild(
    id: number,
    request: ChildSpawnRequest,
    children: Map<number, ProcessHandle>,
    descendants: Set<ProcessHandle>,
    post: (msg: KernelToProcess) => void,
    parent: SpawnOptions,
  ): void {
    const [stdinMode, stdoutMode, stderrMode] = request.stdio;
    const route = (mode: string, fd: 1 | 2, inherit: ((d: Uint8Array) => void) | undefined) =>
      mode === 'pipe'
        ? (data: Uint8Array) => post({ t: 'child-output', id, fd, data })
        : mode === 'inherit'
          ? inherit
          : undefined;
    let child: ProcessHandle;
    try {
      const onStdout = route(stdoutMode, 1, parent.onStdout);
      const onStderr = route(stderrMode, 2, parent.onStderr);
      child = this.spawn(request.argv, {
        env: request.env,
        cwd: request.cwd,
        stdin: stdinMode === 'pipe' ? 'pipe' : 'closed',
        ...(onStdout ? { onStdout } : {}),
        ...(onStderr ? { onStderr } : {}),
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      post({ t: 'child-error', id, code: e.code ?? 'EIO', message: e.message ?? String(err) });
      return;
    }
    children.set(id, child);
    descendants.add(child);
    post({ t: 'child-spawned', id, pid: child.pid });
    void child.exit.then(({ code, signal }) => {
      children.delete(id);
      descendants.delete(child);
      post({ t: 'child-exit', id, code: signal ? null : code, signal });
    });
  }

  /**
   * SPAWN_SYNC: runs a child to completion while the calling process blocks
   * in its syscall. `inherit` streams go straight to the caller's outputs.
   */
  private async spawnSync(
    request: Uint8Array,
    parent: SpawnOptions,
    descendants: Set<ProcessHandle>,
  ): Promise<Uint8Array> {
    const args = decode(request) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      input: Uint8Array | null;
      stdio: string[];
      timeout: number | null;
      killSignal: Signal | null;
    };
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const collect = (
      mode: string | undefined,
      bucket: Uint8Array[],
      add: (n: number) => number,
      inherit?: (d: Uint8Array) => void,
    ) => {
      if (mode === 'inherit') return inherit;
      if (mode === 'ignore') return undefined;
      return (d: Uint8Array) => {
        if (add(d.length) <= SPAWN_SYNC_MAX_BUFFER) bucket.push(d);
      };
    };
    let child: ProcessHandle;
    try {
      const onStdout = collect(args.stdio[1], out, (n) => (outBytes += n), parent.onStdout);
      const onStderr = collect(args.stdio[2], err, (n) => (errBytes += n), parent.onStderr);
      child = this.spawn(args.argv, {
        env: args.env,
        cwd: args.cwd,
        stdin: 'pipe',
        ...(onStdout ? { onStdout } : {}),
        ...(onStderr ? { onStderr } : {}),
      });
    } catch (e) {
      return encode({
        error: {
          code: (e as { code?: string }).code ?? 'EIO',
          errno: -errnoOf(e),
          message: (e as Error).message,
        },
      });
    }
    descendants.add(child);
    void child.exit.then(() => descendants.delete(child));
    if (args.input) child.writeStdin(args.input);
    child.writeStdin(null);
    let timedOut = false;
    const timer =
      args.timeout && args.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill(args.killSignal ?? 'SIGTERM');
          }, args.timeout)
        : undefined;
    const { code, signal } = await child.exit;
    if (timer) clearTimeout(timer);
    const result: Record<string, Value> = {
      pid: child.pid,
      status: signal ? null : code,
      signal,
      stdout: concat(out),
      stderr: concat(err),
    };
    if (timedOut)
      result['error'] = {
        code: 'ETIMEDOUT',
        errno: -110,
        message: `spawnSync ${args.argv[0]} ETIMEDOUT`,
      };
    if (outBytes > SPAWN_SYNC_MAX_BUFFER || errBytes > SPAWN_SYNC_MAX_BUFFER) {
      result['error'] = {
        code: 'ENOBUFS',
        errno: -105,
        message: `spawnSync ${args.argv[0]} ENOBUFS`,
      };
    }
    return encode(result);
  }

  getProcess(pid: number): ProcessHandle | undefined {
    return this.processes.get(pid);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
