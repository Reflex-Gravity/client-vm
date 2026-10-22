// SPDX-License-Identifier: Apache-2.0
import {
  DEFAULT_PAYLOAD_BYTES,
  IGNORED_BY_DEFAULT,
  KERNEL_SIGNALS,
  SIGNAL_NUMBERS,
  STOP_SIGNALS,
  SyscallServer,
  SystemError,
  catchesSignal,
  continueStopped,
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
  TtyInfo,
  Value,
  WindowSize,
} from '@clientvm/protocol';
import { MemoryVfs, importImage } from '@clientvm/vfs';
import type { Snapshot, VfsLimits } from '@clientvm/vfs';
import { installBuiltinCommands, resolveCommand } from './commands.ts';
import { installDevices } from './devices.ts';
import { ReadOnlyMounts } from './mounts.ts';
import { createSyscallHandler } from './dispatcher.ts';
import { FdTable } from './fd-table.ts';
import type { NetStack } from './net.ts';
import { Pty } from './pty.ts';

/** The subset of `Worker` the kernel needs; lets tests substitute Node worker_threads. */
export interface ProcessWorkerLike {
  postMessage(message: KernelToProcess, transfer?: Transferable[]): void;
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
  /**
   * A process that runs JavaScript this long without returning to its event
   * loop (time blocked in syscalls does not count) is killed with SIGXCPU.
   */
  maxCpuMs?: number;
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
  /** For worker threads: the child's end of the channel to its parent thread. */
  threadPort?: MessagePort;
  /**
   * Starts a session on a new pseudo-terminal: the process's stdio is the
   * terminal, `onOutput` gets what the terminal displays, and `writeStdin` is
   * keyboard input. `onStdout`/`onStderr` are not used.
   */
  pty?: { size: WindowSize; onOutput: (data: Uint8Array) => void };
}

/** How long a process may take to act on a delivered signal before the kernel terminates it. */
export const SIGNAL_GRACE_MS = 1000;

/** A pseudo-terminal and the processes it controls. */
class Terminal {
  readonly pty: Pty;
  /** The session leader's group, which is the foreground group (no tcsetpgrp yet). */
  readonly foreground: number;
  /** Every process on this terminal. */
  readonly members = new Set<ProcEntry>();
  /** Processes whose stdin is the terminal, oldest first; input goes to the newest in the foreground. */
  readonly readers: ProcEntry[] = [];
  /** The process that last set raw mode; the terminal leaves raw mode when it exits. */
  rawOwner: ProcEntry | null = null;

  constructor(foreground: number, size: WindowSize, onOutput: (data: Uint8Array) => void) {
    this.foreground = foreground;
    this.pty = new Pty(size, {
      output: onOutput,
      deliver: (data) => {
        const reader = this.readers.findLast((r) => r.pgid === this.foreground && !r.stopped);
        reader?.post({ t: 'stdin', data });
      },
      signal: (signal) => this.signalForeground(signal),
    });
  }

  signalForeground(signal: Signal): void {
    for (const m of [...this.members]) if (m.pgid === this.foreground) m.handle.kill(signal);
  }

  resize(size: WindowSize): void {
    if (!this.pty.resize(size)) return;
    for (const m of this.members) m.post({ t: 'winsize', size: { ...size } });
    this.signalForeground('SIGWINCH');
  }

  setRaw(entry: ProcEntry, raw: boolean): void {
    this.pty.setRaw(raw);
    this.rawOwner = raw ? entry : null;
  }

  attach(entry: ProcEntry): void {
    this.members.add(entry);
    if (entry.tty?.stdin) this.readers.push(entry);
  }

  detach(entry: ProcEntry): void {
    this.members.delete(entry);
    const i = this.readers.indexOf(entry);
    if (i >= 0) this.readers.splice(i, 1);
    if (this.rawOwner === entry) this.setRaw(entry, false);
  }
}

/** The kernel's view of a running process. */
interface ProcEntry {
  readonly handle: ProcessHandle;
  /** Changes when a shell moves a job between the foreground and the background (setpgid). */
  pgid: number;
  /** Stopped by job control (SIGTSTP/SIGSTOP) until SIGCONT. */
  stopped: boolean;
  /** Live children (spawn and spawnSync), for signals to a whole job. */
  readonly descendants: Set<ProcessHandle>;
  /** Told when the process stops or continues (its parent, which reports it as child-stopped). */
  readonly onJobState: Set<(state: { stopped: boolean; signal?: Signal }) => void>;
  /** The controlling terminal, and which stdio streams are it. */
  readonly tty: { term: Terminal; stdin: boolean; stdout: boolean; stderr: boolean } | null;
  post(msg: KernelToProcess, transfer?: Transferable[]): void;
}

/** What a child takes from its parent: group, terminal, and which stdio streams it inherits. */
interface Parentage {
  entry: ProcEntry;
  /** stdin, stdout, stderr inherited (so the terminal, if the parent's are). */
  stdio: [boolean, boolean, boolean];
  /** A new process group (a shell's background job). */
  newGroup: boolean;
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
  /**
   * Sends a signal (default SIGTERM). SIGKILL, SIGPIPE and SIGXCPU end the
   * process at once; others are delivered, and a process that neither handles
   * one nor exits within {@link SIGNAL_GRACE_MS} is terminated. A process
   * ended by a signal exits with 128 + its number and takes its descendants
   * with it, like a signal to a process group.
   */
  kill(signal?: Signal): void;
  /**
   * Writes to stdin (null closes it). Ignored unless spawned with `stdin: 'pipe'`
   * or `pty`; for a terminal it is keyboard input, and null hangs up (SIGHUP).
   */
  writeStdin(data: Uint8Array | null): void;
  /** Resizes the terminal of a process spawned with `pty`; ENOTTY otherwise. */
  resize(size: WindowSize): void;
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
  /** Read-only mirrored mounts (mutations under them fail with EROFS). */
  readonly mounts: ReadOnlyMounts;
  private readonly options: KernelOptions;
  private nextPid = 1;
  private readonly processes = new Map<number, ProcessHandle>();
  private readonly entries = new Map<number, ProcEntry>();
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
    this.mounts = new ReadOnlyMounts(this.vfs);
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
    return this.start(argv, options, null);
  }

  /** Starts a process: a new session, or a child of `parent` in its group and on its terminal. */
  private start(argv: string[], options: SpawnOptions, parent: Parentage | null): ProcessHandle {
    const { maxProcesses } = this.options;
    if (maxProcesses !== undefined && this.processes.size >= maxProcesses) {
      throw new SystemError('EAGAIN', 'spawn');
    }
    const env = options.env ?? {};
    const cwd = options.cwd ?? '/home/user';
    const resolvedArgv = resolveCommand(this.vfs, argv, env, cwd);

    const pid = this.nextPid++;
    const pgid = parent && !parent.newGroup ? parent.entry.pgid : pid;
    let tty: ProcEntry['tty'] = null;
    if (options.pty) {
      const term = new Terminal(pgid, options.pty.size, options.pty.onOutput);
      const write = (data: Uint8Array) => term.pty.write(data);
      options = { ...options, onStdout: write, onStderr: write };
      tty = { term, stdin: true, stdout: true, stderr: true };
    } else if (parent?.entry.tty) {
      // The controlling terminal is inherited; a stdio stream is the terminal if inherited from it.
      const [stdin, stdout, stderr] = parent.stdio;
      const from = parent.entry.tty;
      tty = {
        term: from.term,
        stdin: stdin && from.stdin && !parent.newGroup,
        stdout: stdout && from.stdout,
        stderr: stderr && from.stderr,
      };
    }
    const syscallMode = options.syscallMode ?? 'waitAsync';
    const channel = createChannelBuffer(this.options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES);
    const fds = new FdTable(this.vfs);
    const children = new Map<number, ProcessHandle>();
    /** Every live child (spawn and spawnSync), killed with this process like a process group. */
    const descendants = new Set<ProcessHandle>();
    const watches = new Map<number, () => void>();
    const timing: ProcessTiming = { spawnedAt: performance.now() };
    const worker = this.options.createProcessWorker();
    const post = (msg: KernelToProcess, transfer: Transferable[] = []) => {
      if (timing.exitedAt === undefined) worker.postMessage(msg, transfer);
    };
    const server = new SyscallServer(
      channel,
      createSyscallHandler(this.vfs, fds, {
        spawnSync: (request) => this.spawnSync(request, options, descendants, entry),
        readOnly: this.mounts,
      }),
    );

    const net = this.options.net?.attach(post);
    let settle!: (code: number, signal?: Signal) => void;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<ProcessExit>((resolve) => {
      settle = (code, signal) => {
        if (timing.exitedAt !== undefined) return;
        timing.exitedAt = performance.now();
        clearTimeout(graceTimer);
        server.close();
        worker.terminate();
        fds.closeAll();
        for (const stop of watches.values()) stop();
        net?.close();
        this.processes.delete(pid);
        this.entries.delete(pid);
        if (tty) {
          tty.term.detach(entry);
          // The session leader is gone: the terminal hangs up on the rest of its foreground.
          if (options.pty) tty.term.signalForeground('SIGHUP');
        }
        resolve({ code, signal: signal ?? null });
        // Like a signal to a process group: children (e.g. a shell's pipeline) go too.
        if (signal) for (const d of [...descendants]) d.kill(signal);
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
        case 'pong':
          lastSeen = performance.now();
          break;
        case 'exit':
          settle(msg.code, msg.signal);
          break;
        case 'signal-ack':
          clearTimeout(graceTimer);
          break;
        case 'stopped':
          clearTimeout(graceTimer);
          entry.stopped = true;
          for (const l of entry.onJobState) l({ stopped: true, signal: msg.signal });
          break;
        case 'tty-mode':
          if (tty?.stdin) tty.term.setRaw(entry, msg.raw === true);
          break;
        case 'spawn':
          this.spawnChild(msg.id, msg.request, children, descendants, post, options, entry);
          break;
        case 'child-stdin':
          children.get(msg.id)?.writeStdin(msg.data);
          break;
        case 'child-kill': {
          const child = children.get(msg.id);
          if (child) {
            if (msg.tree) this.signalTree(child, msg.signal);
            else child.kill(msg.signal);
          }
          break;
        }
        case 'child-setpgid': {
          const child = children.get(msg.id);
          if (child) this.setTreeGroup(child, msg.foreground ? entry.pgid : child.pid);
          break;
        }
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

    // CPU watchdog: ping the process; one that neither answers nor waits in a syscall is spinning.
    let lastSeen = performance.now();
    const maxCpuMs = this.options.maxCpuMs;
    if (maxCpuMs !== undefined && maxCpuMs > 0) {
      let n = 0;
      const tick = Math.max(20, Math.min(250, maxCpuMs / 4));
      const watchdog = setInterval(() => {
        const now = performance.now();
        if (timing.exitedAt !== undefined) return clearInterval(watchdog);
        if (server.waiting || entry.stopped || timing.readyAt === undefined) lastSeen = now;
        if (now - lastSeen > maxCpuMs) {
          clearInterval(watchdog);
          options.onStderr?.(
            new TextEncoder().encode(
              `clientvm: process ${pid} ran ${Math.round(now - lastSeen)} ms without yielding (maxCpuMs ${maxCpuMs}); killed\n`,
            ),
          );
          handle.kill('SIGXCPU');
          return;
        }
        worker.postMessage({ t: 'ping', n: ++n });
      }, tick);
    }

    const stdinOpen = options.stdin === 'pipe' || tty?.stdin === true;
    const ttyInfo: TtyInfo | undefined = tty
      ? { stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stderr, ...tty.term.pty.size }
      : undefined;
    worker.postMessage(
      {
        t: 'init',
        pid,
        channel,
        syscallMode,
        argv: resolvedArgv,
        env,
        cwd,
        stdinOpen,
        ...(options.threadPort ? { threadPort: options.threadPort } : {}),
        ...(ttyInfo ? { tty: ttyInfo } : {}),
      },
      options.threadPort ? [options.threadPort] : [],
    );

    let stdinClosed = !stdinOpen;
    const handle: ProcessHandle = {
      pid,
      exit,
      timing,
      kill: (signal = 'SIGTERM') => {
        if (timing.exitedAt !== undefined) return;
        if (KERNEL_SIGNALS.has(signal)) {
          settle(128 + SIGNAL_NUMBERS[signal], signal);
          return;
        }
        if (signal === 'SIGCONT' && entry.stopped) {
          entry.stopped = false;
          continueStopped(channel);
          for (const l of entry.onJobState) l({ stopped: false });
        }
        post({ t: 'signal', signal });
        // Ignored, a stop (the process reports it), or pending until a stopped process continues.
        if (IGNORED_BY_DEFAULT.has(signal) || STOP_SIGNALS.has(signal) || entry.stopped) return;
        const n = SIGNAL_NUMBERS[signal];
        // Blocked in a syscall (spawnSync) it cannot act on the signal itself: one it does not
        // catch takes its default action now, as on Linux; a caught one waits for the call.
        if (server.waiting && !catchesSignal(channel, n)) {
          settle(128 + n, signal);
          return;
        }
        // A process stuck in JavaScript cannot act on it; end it as the default action would.
        // The grace period starts once it is out of any syscall.
        clearTimeout(graceTimer);
        const arm = () => {
          if (timing.exitedAt !== undefined) return;
          graceTimer = server.waiting
            ? setTimeout(arm, 50)
            : setTimeout(() => settle(128 + n, signal), SIGNAL_GRACE_MS);
        };
        arm();
      },
      writeStdin: (data) => {
        if (options.pty && tty) {
          if (data === null) tty.term.signalForeground('SIGHUP');
          else tty.term.pty.input(data);
          return;
        }
        if (stdinClosed) return;
        if (data === null) stdinClosed = true;
        post({ t: 'stdin', data });
      },
      resize: (size) => {
        if (!options.pty || !tty) throw new SystemError('ENOTTY', 'ioctl');
        tty.term.resize(size);
      },
    };
    const entry: ProcEntry = {
      handle,
      pgid,
      tty,
      post,
      stopped: false,
      descendants,
      onJobState: new Set(),
    };
    this.processes.set(pid, handle);
    this.entries.set(pid, entry);
    tty?.term.attach(entry);
    return handle;
  }

  /** A child requested by a process (child_process.spawn). */
  private spawnChild(
    id: number,
    request: ChildSpawnRequest,
    children: Map<number, ProcessHandle>,
    descendants: Set<ProcessHandle>,
    post: (msg: KernelToProcess, transfer?: Transferable[]) => void,
    parent: SpawnOptions,
    parentEntry: ProcEntry,
  ): void {
    const [stdinMode, stdoutMode, stderrMode] = request.stdio;
    const route = (mode: string, fd: 1 | 2, inherit: ((d: Uint8Array) => void) | undefined) =>
      mode === 'pipe'
        ? (data: Uint8Array) => post({ t: 'child-output', id, fd, data })
        : mode === 'inherit'
          ? inherit
          : undefined;
    let child: ProcessHandle;
    const own = request.threadPort;
    const link = request.thread === true && !own ? new MessageChannel() : null;
    const threadPort = own ?? link?.port2;
    try {
      const onStdout = route(stdoutMode, 1, parent.onStdout);
      const onStderr = route(stderrMode, 2, parent.onStderr);
      child = this.start(
        request.argv,
        {
          env: request.env,
          cwd: request.cwd,
          stdin: stdinMode === 'pipe' ? 'pipe' : 'closed',
          ...(onStdout ? { onStdout } : {}),
          ...(onStderr ? { onStderr } : {}),
          ...(threadPort ? { threadPort } : {}),
        },
        {
          entry: parentEntry,
          // stdin `inherit` is the parent's terminal; without one the child's stdin is closed.
          stdio: [stdinMode === 'inherit', stdoutMode === 'inherit', stderrMode === 'inherit'],
          newGroup: request.newGroup === true,
        },
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      post({ t: 'child-error', id, code: e.code ?? 'EIO', message: e.message ?? String(err) });
      return;
    }
    children.set(id, child);
    descendants.add(child);
    if (link) post({ t: 'child-spawned', id, pid: child.pid, port: link.port1 }, [link.port1]);
    else post({ t: 'child-spawned', id, pid: child.pid });
    const onJobState = (state: { stopped: boolean; signal?: Signal }) =>
      post(
        state.stopped
          ? { t: 'child-stopped', id, signal: state.signal ?? 'SIGSTOP' }
          : { t: 'child-continued', id },
      );
    this.entries.get(child.pid)?.onJobState.add(onJobState);
    void child.exit.then(({ code, signal }) => {
      children.delete(id);
      descendants.delete(child);
      post({ t: 'child-exit', id, code: signal ? null : code, signal });
    });
  }

  /** Signals a process and everything it started (`kill` of a job). */
  private signalTree(handle: ProcessHandle, signal: Signal): void {
    const entry = this.entries.get(handle.pid);
    const below = entry ? [...entry.descendants] : [];
    handle.kill(signal);
    for (const d of below) this.signalTree(d, signal);
  }

  /** Moves a process and everything it started into process group `pgid`. */
  private setTreeGroup(handle: ProcessHandle, pgid: number): void {
    const entry = this.entries.get(handle.pid);
    if (!entry) return;
    entry.pgid = pgid;
    for (const d of entry.descendants) this.setTreeGroup(d, pgid);
  }

  /**
   * SPAWN_SYNC: runs a child to completion while the calling process blocks
   * in its syscall. `inherit` streams go straight to the caller's outputs.
   */
  private async spawnSync(
    request: Uint8Array,
    parent: SpawnOptions,
    descendants: Set<ProcessHandle>,
    parentEntry: ProcEntry,
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
      child = this.start(
        args.argv,
        {
          env: args.env,
          cwd: args.cwd,
          stdin: 'pipe',
          ...(onStdout ? { onStdout } : {}),
          ...(onStderr ? { onStderr } : {}),
        },
        {
          entry: parentEntry,
          // spawnSync feeds stdin itself; output streams may be the terminal.
          stdio: [false, args.stdio[1] === 'inherit', args.stdio[2] === 'inherit'],
          newGroup: false,
        },
      );
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
