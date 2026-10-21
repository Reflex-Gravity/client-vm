// SPDX-License-Identifier: Apache-2.0
// `child_process`: children are ClientVM processes in the same instance,
// started by the kernel (PATH lookup, shebangs). There is no shell yet (3c):
// `shell: true` and exec() run through /bin/sh only once it exists.

import type { ProcessContext } from '@clientvm/process';
import { Op, SystemError, decode, encode } from '@clientvm/protocol';
import type { KernelToProcess, Signal, StdioMode, Value } from '@clientvm/protocol';
import { Buffer, codeError } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';
import type { EventLoop } from './event-loop.ts';
import { EventEmitter } from './events.ts';
import type { PosixPath } from './path.ts';

type StreamModule = Record<string, unknown> & {
  Readable: new (opts?: object) => ReadableLike;
  Writable: new (opts?: object) => EventEmitter & Record<string, unknown>;
};
type ReadableLike = EventEmitter & {
  push(chunk: unknown): boolean;
  setEncoding(e: string): unknown;
  destroy(): void;
};

export interface ChildProcessDeps {
  ctx: ProcessContext;
  path: PosixPath;
  loop: EventLoop;
  stream: () => StreamModule;
  env: () => Record<string, string | undefined>;
  cwd: () => string;
}

const SIGNALS: Record<string, Signal> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
  SIGINT: 'SIGINT',
  SIGHUP: 'SIGHUP',
  SIGPIPE: 'SIGPIPE',
  SIGXCPU: 'SIGXCPU',
};
const SIGNAL_BY_NUMBER: Record<number, Signal> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  13: 'SIGPIPE',
  15: 'SIGTERM',
  24: 'SIGXCPU',
};

interface SpawnOptions {
  cwd?: string | URL | undefined;
  env?: Record<string, string | undefined> | undefined;
  stdio?: StdioMode | (StdioMode | 'overlapped' | null | undefined | number)[] | undefined;
  shell?: boolean | string | undefined;
  detached?: boolean | undefined;
  windowsHide?: boolean | undefined;
  argv0?: string | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
  killSignal?: string | number | undefined;
  encoding?: BufferEncoding | 'buffer' | null | undefined;
  input?: string | Uint8Array | undefined;
  maxBuffer?: number | undefined;
  /** fork(): open an IPC channel. */
  ipc?: { serialization: 'json' | 'advanced' } | undefined;
}

/** IPC messages on a fork's channel (the kernel-linked MessagePort). */
type IpcWire =
  | { t: 'ipc-init'; serialization: 'json' | 'advanced' }
  | { t: 'ipc'; v: unknown }
  | { t: 'ipc-disconnect' };

/** Serializes like Node's 'json' IPC (a JSON round trip) or passes through for 'advanced'. */
function ipcEncode(value: unknown, serialization: 'json' | 'advanced'): unknown {
  if (serialization === 'advanced') return value;
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "message" argument must be serializable',
    );
  }
  return json;
}

function ipcDecode(value: unknown, serialization: 'json' | 'advanced'): unknown {
  return serialization === 'json' && typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * The child side of a fork's IPC channel: `process.send`, `'message'`,
 * `process.connected`, `process.disconnect()`, `process.channel`. The
 * channel keeps the process alive only while 'message' listeners exist.
 */
export function attachIpcToProcess(
  proc: EventEmitter & Record<string, unknown>,
  port: MessagePort,
  serialization: 'json' | 'advanced',
  hold: () => { close(): void },
): void {
  let handle: { close(): void } | null = null;
  let refed = true;
  const sync = () => {
    const want = refed && proc['connected'] === true && proc.listenerCount('message') > 0;
    if (want && !handle) handle = hold();
    if (!want && handle) {
      handle.close();
      handle = null;
    }
  };
  proc['connected'] = true;
  proc['send'] = (message: unknown, ...rest: unknown[]) => {
    const cb = rest.find((r) => typeof r === 'function') as ((e: Error | null) => void) | undefined;
    if (proc['connected'] !== true) {
      const err = codeError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => proc.emit('error', err));
      return false;
    }
    port.postMessage({ t: 'ipc', v: ipcEncode(message, serialization) } satisfies IpcWire);
    if (cb) queueMicrotask(() => cb(null));
    return true;
  };
  const disconnected = () => {
    if (proc['connected'] !== true) return;
    proc['connected'] = false;
    sync();
    proc.emit('disconnect');
  };
  proc['disconnect'] = () => {
    if (proc['connected'] !== true) return;
    port.postMessage({ t: 'ipc-disconnect' } satisfies IpcWire);
    port.close();
    disconnected();
  };
  proc['channel'] = {
    ref: () => {
      refed = true;
      sync();
    },
    unref: () => {
      refed = false;
      sync();
    },
  };
  port.addEventListener('message', (e) => {
    const data = e.data as IpcWire;
    if (data?.t === 'ipc') proc.emit('message', ipcDecode(data.v, serialization), undefined);
    else if (data?.t === 'ipc-disconnect') disconnected();
  });
  proc.on('newListener', (event: string) => {
    if (event === 'message') queueMicrotask(sync);
  });
  proc.on('removeListener', (event: string) => {
    if (event === 'message') sync();
  });
  port.start();
}

function normalizeStdio(stdio: SpawnOptions['stdio']): [StdioMode, StdioMode, StdioMode] {
  const one = (v: unknown): StdioMode =>
    v === 'inherit' || v === 'ignore' ? v : v === 0 || v === 1 || v === 2 ? 'inherit' : 'pipe';
  if (typeof stdio === 'string') return [one(stdio), one(stdio), one(stdio)];
  const arr = stdio ?? [];
  return [one(arr[0]), one(arr[1]), one(arr[2])];
}

function toSignal(sig: string | number | undefined): Signal {
  if (sig === undefined) return 'SIGTERM';
  if (typeof sig === 'number') return SIGNAL_BY_NUMBER[sig] ?? 'SIGTERM';
  const s = SIGNALS[sig];
  if (!s) throw codeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${sig}`);
  return s;
}

/** The `child_process` module object. */
export type ChildProcessModule = Record<string, unknown>;

export function createChildProcess(deps: ChildProcessDeps): ChildProcessModule {
  const { ctx, path, loop } = deps;
  let nextId = 1;
  const children = new Map<number, ChildProcess>();

  ctx.onMessage((msg: KernelToProcess) => {
    if (
      msg.t === 'child-spawned' ||
      msg.t === 'child-error' ||
      msg.t === 'child-output' ||
      msg.t === 'child-exit'
    )
      children.get(msg.id)?._onKernel(msg);
  });

  const resolveArgs = (file: string, args: readonly string[], opts: SpawnOptions): string[] => {
    if (opts.shell) {
      const shell = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
      return [shell, '-c', [file, ...args].join(' ')];
    }
    return [file, ...args];
  };
  const childEnv = (opts: SpawnOptions): Record<string, string> => {
    const env = opts.env ?? deps.env();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = String(v);
    return out;
  };
  const childCwd = (opts: SpawnOptions): string =>
    opts.cwd === undefined
      ? deps.cwd()
      : path.resolve(opts.cwd instanceof URL ? decodeURIComponent(opts.cwd.pathname) : opts.cwd);

  class ChildProcess extends EventEmitter {
    pid: number | undefined = undefined;
    exitCode: number | null = null;
    signalCode: Signal | null = null;
    killed = false;
    connected = false;
    spawnfile: string;
    spawnargs: string[];
    stdin: (EventEmitter & Record<string, unknown>) | null = null;
    stdout: ReadableLike | null = null;
    stderr: ReadableLike | null = null;
    stdio: unknown[];
    private readonly id: number;
    private ipcPort: MessagePort | null = null;
    private readonly ipc: { serialization: 'json' | 'advanced' } | undefined;
    private readonly ipcQueue: unknown[] = [];
    private readonly handle;
    private exited = false;
    private streamsOpen = 0;
    private exitInfo: [number | null, Signal | null] | null = null;

    constructor(file: string, args: string[], opts: SpawnOptions) {
      super();
      this.id = nextId++;
      this.ipc = opts.ipc;
      this.spawnfile = file;
      this.spawnargs = [opts.argv0 ?? file, ...args];
      this.handle = loop.handle();
      const stdio = normalizeStdio(opts.stdio);
      const S = deps.stream();
      if (stdio[0] === 'pipe') {
        const id = this.id;
        const w = new S.Writable({
          write(chunk: Uint8Array, _e: string, cb: () => void) {
            ctx.send({ t: 'child-stdin', id, data: Uint8Array.prototype.slice.call(chunk) });
            cb();
          },
          final(cb: () => void) {
            ctx.send({ t: 'child-stdin', id, data: null });
            cb();
          },
        });
        this.stdin = w;
      }
      const readable = () => {
        const r = new S.Readable({ read() {} });
        this.streamsOpen++;
        // Like Node: a pipe counts as closed when its stream closes, and the child's
        // 'close' waits for that, even if nobody reads the stream.
        r.on('close', () => {
          this.streamsOpen--;
          this.maybeClose();
        });
        return r;
      };
      if (stdio[1] === 'pipe') this.stdout = readable();
      if (stdio[2] === 'pipe') this.stderr = readable();
      this.stdio = [this.stdin, this.stdout, this.stderr];
      children.set(this.id, this);
      ctx.send({
        t: 'spawn',
        id: this.id,
        request: {
          argv: resolveArgs(file, args, opts),
          env: childEnv(opts),
          cwd: childCwd(opts),
          stdio,
          ...(opts.ipc ? { thread: true } : {}),
        },
      });
      if (opts.signal) {
        const onAbort = () => {
          this.kill(toSignal(opts.killSignal));
          const err = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
            code: 'ABORT_ERR',
            cause: opts.signal!.reason,
          });
          this.emit('error', err);
        };
        if (opts.signal.aborted) queueMicrotask(onAbort);
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (opts.timeout && opts.timeout > 0) {
        const t = loop.timers
          .setTimeout(() => this.kill(toSignal(opts.killSignal)), opts.timeout)
          .unref();
        this.once('exit', () => t.close());
      }
    }

    /** @internal */
    _onKernel(msg: KernelToProcess): void {
      switch (msg.t) {
        case 'child-spawned':
          this.pid = msg.pid;
          if (this.ipc && msg.port) this.openIpc(msg.port);
          this.emit('spawn');
          break;
        case 'child-error': {
          // The kernel reports Linux errno codes (ENOENT, EACCES, ENOEXEC, EAGAIN).
          const err = new SystemError(
            msg.code as ConstructorParameters<typeof SystemError>[0],
            `spawn ${this.spawnfile}`,
            this.spawnfile,
          );
          Object.assign(err, { spawnargs: this.spawnargs.slice(1) });
          children.delete(this.id);
          this.handle.close();
          for (const s of [this.stdout, this.stderr]) s?.push(null);
          queueMicrotask(() => {
            this.emit('error', err);
            this.exitInfo = [-2, null];
            this.exited = true;
            this.maybeClose();
          });
          break;
        }
        case 'child-output':
          (msg.fd === 1 ? this.stdout : this.stderr)?.push(Buffer.from(msg.data));
          break;
        case 'child-exit':
          if (this.connected) {
            this.connected = false;
            this.ipcPort?.close();
            this.emit('disconnect');
          }
          this.exitCode = msg.code;
          this.signalCode = msg.signal;
          this.exited = true;
          this.exitInfo = [msg.code, msg.signal];
          children.delete(this.id);
          this.handle.close();
          this.emit('exit', msg.code, msg.signal);
          for (const s of [this.stdout, this.stderr]) {
            if (!s) continue;
            s.push(null);
            // Unread output is discarded once the child is gone, as with a closed pipe.
            if ((s as unknown as { readableFlowing: boolean | null }).readableFlowing === null) {
              (s as unknown as { resume(): void }).resume();
            }
          }
          this.maybeClose();
          break;
      }
    }

    private openIpc(port: MessagePort): void {
      const { serialization } = this.ipc!;
      this.ipcPort = port;
      this.connected = true;
      port.addEventListener('message', (e) => {
        const data = e.data as IpcWire;
        if (data?.t === 'ipc') this.emit('message', ipcDecode(data.v, serialization), undefined);
        else if (data?.t === 'ipc-disconnect' && this.connected) {
          this.connected = false;
          this.emit('disconnect');
        }
      });
      port.start();
      port.postMessage({ t: 'ipc-init', serialization } satisfies IpcWire);
      for (const v of this.ipcQueue.splice(0)) port.postMessage({ t: 'ipc', v } satisfies IpcWire);
    }

    /** IPC (fork): sends a message to the child. */
    send(message: unknown, ...rest: unknown[]): boolean {
      const cb = rest.find((r) => typeof r === 'function') as
        ((e: Error | null) => void) | undefined;
      if (!this.ipc || this.exited || (this.ipcPort && !this.connected)) {
        const err = codeError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
        if (cb) queueMicrotask(() => cb(err));
        else queueMicrotask(() => this.emit('error', err));
        return false;
      }
      const v = ipcEncode(message, this.ipc.serialization);
      if (this.ipcPort) this.ipcPort.postMessage({ t: 'ipc', v } satisfies IpcWire);
      else this.ipcQueue.push(v);
      if (cb) queueMicrotask(() => cb(null));
      return true;
    }

    disconnect(): void {
      if (!this.connected || !this.ipcPort) return;
      this.ipcPort.postMessage({ t: 'ipc-disconnect' } satisfies IpcWire);
      this.ipcPort.close();
      this.connected = false;
      queueMicrotask(() => this.emit('disconnect'));
    }

    private maybeClose(): void {
      if (!this.exited || this.streamsOpen > 0 || !this.exitInfo) return;
      const [code, signal] = this.exitInfo;
      this.exitInfo = null;
      this.emit('close', code, signal);
    }

    kill(signal?: string | number): boolean {
      if (this.exited) return false;
      ctx.send({ t: 'child-kill', id: this.id, signal: toSignal(signal) });
      this.killed = true;
      return true;
    }

    ref(): void {
      this.handle.ref();
    }

    unref(): void {
      this.handle.unref();
    }
  }

  function spawn(
    file: string,
    args?: readonly string[] | SpawnOptions,
    opts?: SpawnOptions,
  ): ChildProcess {
    if (!Array.isArray(args)) {
      opts = args as SpawnOptions | undefined;
      args = [];
    }
    if (typeof file !== 'string' || file === '') {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "file" argument must be of type string',
      );
    }
    return new ChildProcess(file, [...(args as string[])], opts ?? {});
  }

  type ExecCallback = (
    err: (Error & Record<string, unknown>) | null,
    stdout: string | Uint8Array,
    stderr: string | Uint8Array,
  ) => void;

  function execFile(file: string, ...rest: unknown[]): ChildProcess {
    let args: string[] = [];
    let opts: SpawnOptions = {};
    let cb: ExecCallback | undefined;
    for (const r of rest) {
      if (Array.isArray(r)) args = r as string[];
      else if (typeof r === 'function') cb = r as ExecCallback;
      else if (r && typeof r === 'object') opts = r as SpawnOptions;
    }
    const child = spawn(file, args, { ...opts, stdio: 'pipe' });
    const encoding = opts.encoding === undefined ? 'utf8' : opts.encoding;
    const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let size = 0;
    let killedForBuffer = false;
    const onData = (bucket: Uint8Array[]) => (d: Uint8Array) => {
      size += d.length;
      if (size > maxBuffer && !killedForBuffer) {
        killedForBuffer = true;
        child.kill();
      }
      bucket.push(d);
    };
    child.stdout?.on('data', onData(out));
    child.stderr?.on('data', onData(err));
    const decodeOut = (chunks: Uint8Array[]) => {
      const b = Buffer.concat(chunks);
      return encoding && encoding !== 'buffer' ? b.toString(encoding) : b;
    };
    let errored: Error | null = null;
    child.on('error', (e: Error) => {
      errored = e;
    });
    child.on('close', (code: number | null, signal: Signal | null) => {
      if (!cb) return;
      const stdout = decodeOut(out);
      const stderr = decodeOut(err);
      if (errored)
        return cb(errored as Error & Record<string, unknown>, stdout as never, stderr as never);
      if (code === 0 && !signal && !killedForBuffer)
        return cb(null, stdout as never, stderr as never);
      const cmd = [file, ...args].join(' ');
      const e = killedForBuffer
        ? codeError(
            RangeError,
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            'stdout maxBuffer length exceeded',
          )
        : new Error(`Command failed: ${cmd}\n${typeof stderr === 'string' ? stderr : ''}`);
      Object.assign(e, {
        code: killedForBuffer ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code,
        killed: child.killed,
        signal,
        cmd,
      });
      cb(e as Error & Record<string, unknown>, stdout as never, stderr as never);
    });
    return child;
  }

  function exec(
    command: string,
    opts?: SpawnOptions | ExecCallback,
    cb?: ExecCallback,
  ): ChildProcess {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    return execFile(
      command,
      [],
      { ...(opts ?? {}), shell: (opts as SpawnOptions)?.shell || true },
      cb,
    );
  }

  interface SpawnSyncResult {
    pid: number;
    output: (string | Uint8Array | null)[];
    stdout: string | Uint8Array | null;
    stderr: string | Uint8Array | null;
    status: number | null;
    signal: Signal | null;
    error?: Error;
  }

  function spawnSync(
    file: string,
    args?: readonly string[] | SpawnOptions,
    opts?: SpawnOptions,
  ): SpawnSyncResult {
    if (!Array.isArray(args)) {
      opts = args as SpawnOptions | undefined;
      args = [];
    }
    const o = opts ?? {};
    const stdio = normalizeStdio(o.stdio);
    const input =
      o.input === undefined ? null : typeof o.input === 'string' ? Buffer.from(o.input) : o.input;
    const raw = decode(
      ctx.syscall.call(
        Op.SPAWN_SYNC,
        encode({
          argv: resolveArgs(file, args as string[], o),
          env: childEnv(o),
          cwd: childCwd(o),
          input: input as Value,
          stdio,
          timeout: o.timeout ?? null,
          killSignal: o.killSignal === undefined ? null : toSignal(o.killSignal),
        }),
      ),
    ) as {
      pid?: number;
      status?: number | null;
      signal?: Signal | null;
      stdout?: Uint8Array;
      stderr?: Uint8Array;
      error?: { code: string; errno: number; message: string };
    };
    const encoding = o.encoding && o.encoding !== 'buffer' ? o.encoding : null;
    const conv = (b: Uint8Array | undefined, mode: StdioMode): string | Uint8Array | null => {
      if (mode !== 'pipe') return null;
      const buf = Buffer.from(b ?? new Uint8Array(0));
      return encoding ? buf.toString(encoding) : (buf as unknown as Uint8Array);
    };
    const stdout = conv(raw.stdout, stdio[1]);
    const stderr = conv(raw.stderr, stdio[2]);
    const result: SpawnSyncResult = {
      pid: raw.pid ?? 0,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status: raw.status ?? null,
      signal: raw.signal ?? null,
    };
    if (raw.error) {
      const err = Object.assign(new Error(`spawnSync ${file} ${raw.error.code}`), {
        errno: raw.error.errno,
        code: raw.error.code,
        syscall: `spawnSync ${file}`,
        path: file,
        spawnargs: [...(args as string[])],
      });
      result.error = err;
      if (raw.pid === undefined) {
        result.status = null;
        result.stdout = result.stderr = null;
        result.output = [null, null, null];
      }
    }
    return result;
  }

  function checkSync(result: SpawnSyncResult, cmd: string): void {
    if (result.error)
      throw Object.assign(result.error, {
        status: result.status,
        signal: result.signal,
        output: result.output,
        pid: result.pid,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    if (result.status !== 0) {
      const stderrText = result.stderr === null ? '' : String(result.stderr);
      const err = new Error(`Command failed: ${cmd}${stderrText ? `\n${stderrText}` : ''}`);
      throw Object.assign(err, {
        status: result.status,
        signal: result.signal,
        output: result.output,
        pid: result.pid,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
  }

  function execFileSync(
    file: string,
    args?: readonly string[] | SpawnOptions,
    opts?: SpawnOptions,
  ): string | Uint8Array | null {
    if (!Array.isArray(args)) {
      opts = args as SpawnOptions | undefined;
      args = [];
    }
    const o = { stdio: ['pipe', 'pipe', 'inherit'] as SpawnOptions['stdio'], ...(opts ?? {}) };
    const result = spawnSync(file, args, o);
    checkSync(result, [file, ...(args as string[])].join(' '));
    return result.stdout;
  }

  function execSync(command: string, opts?: SpawnOptions): string | Uint8Array | null {
    const o = {
      stdio: ['pipe', 'pipe', 'inherit'] as SpawnOptions['stdio'],
      ...(opts ?? {}),
      shell: opts?.shell || true,
    };
    const result = spawnSync(command, [], o);
    checkSync(result, command);
    return result.stdout;
  }

  /** fork(modulePath[, args][, options]): a node child with an IPC channel. */
  function fork(modulePath: string | URL, ...rest: unknown[]): ChildProcess {
    const args = (Array.isArray(rest[0]) ? rest.shift() : []) as unknown[];
    const opts = (rest[0] ?? {}) as SpawnOptions & {
      execPath?: string;
      execArgv?: string[];
      silent?: boolean;
      serialization?: 'json' | 'advanced';
    };
    let file = modulePath instanceof URL ? modulePath.href : String(modulePath);
    if (file.startsWith('file:')) file = decodeURIComponent(new URL(file).pathname);
    const stdio = Array.isArray(opts.stdio)
      ? (opts.stdio as unknown[]).filter((s) => s !== 'ipc')
      : opts.silent
        ? ['pipe', 'pipe', 'pipe']
        : ['inherit', 'inherit', 'inherit'];
    return spawn(opts.execPath ?? 'node', [...(opts.execArgv ?? []), file, ...args.map(String)], {
      ...opts,
      stdio: stdio as SpawnOptions['stdio'],
      shell: false,
      ipc: { serialization: opts.serialization === 'advanced' ? 'advanced' : 'json' },
    }) as ChildProcess;
  }

  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const promisified =
    (fn: typeof exec | typeof execFile) =>
    (...args: unknown[]) => {
      let child!: ChildProcess;
      const p = new Promise((resolve, reject) => {
        child = (fn as (...a: unknown[]) => ChildProcess)(
          ...args,
          (err: unknown, stdout: unknown, stderr: unknown) => {
            if (err) reject(Object.assign(err as object, { stdout, stderr }));
            else resolve({ stdout, stderr });
          },
        );
      });
      return Object.assign(p, { child });
    };
  Object.defineProperty(exec, promisifyCustom, { value: promisified(exec) });
  Object.defineProperty(execFile, promisifyCustom, { value: promisified(execFile) });

  return {
    ChildProcess,
    spawn,
    spawnSync,
    exec,
    execSync,
    execFile,
    execFileSync,
    fork,
    _forkChild: fork,
  };
}

/** fs.watch / fs.watchFile backed by kernel VFS watchers. */
export function createWatchers(deps: {
  ctx: ProcessContext;
  loop: EventLoop;
  path: PosixPath;
  statSync: (p: string) => { mtimeMs: number; size: number } | undefined;
}): Record<'watch' | 'watchFile' | 'unwatchFile', (...args: never[]) => unknown> {
  const { ctx, loop } = deps;
  let nextId = 1;
  const listeners = new Map<
    number,
    (events: { type: string; path?: string; from?: string; to?: string }[]) => void
  >();
  ctx.onMessage((msg) => {
    if (msg.t === 'watch-event') listeners.get(msg.id)?.(msg.events as never);
  });

  function watch(
    filename: string,
    options?: unknown,
    listener?: (event: string, name: string | null) => void,
  ) {
    if (typeof options === 'function') {
      listener = options as typeof listener;
      options = {};
    }
    const opts = (typeof options === 'string' ? { encoding: options } : (options ?? {})) as {
      recursive?: boolean;
      persistent?: boolean;
      signal?: AbortSignal;
    };
    const target = deps.path.resolve(String(filename));
    if (!deps.statSync(target)) {
      throw new SystemError('ENOENT', 'watch', String(filename));
    }
    const watcher = new EventEmitter() as EventEmitter & Record<string, unknown>;
    if (listener) watcher.on('change', listener as never);
    const id = nextId++;
    const handle = loop.handle();
    if (opts.persistent === false) handle.unref();
    const rel = (p: string) =>
      p === target
        ? deps.path.basename(target)
        : p.startsWith(`${target}/`)
          ? p.slice(target.length + 1)
          : deps.path.basename(p);
    listeners.set(id, (events) => {
      for (const e of events) {
        if (e.type === 'rename') {
          watcher.emit('change', 'rename', rel(e.from!));
          watcher.emit('change', 'rename', rel(e.to!));
        } else {
          watcher.emit('change', e.type === 'modify' ? 'change' : 'rename', rel(e.path!));
        }
      }
    });
    ctx.send({ t: 'watch', id, path: target, recursive: opts.recursive === true });
    const close = () => {
      if (!listeners.delete(id)) return;
      ctx.send({ t: 'unwatch', id });
      handle.close();
      queueMicrotask(() => watcher.emit('close'));
    };
    opts.signal?.addEventListener('abort', close, { once: true });
    Object.assign(watcher, {
      close,
      ref: () => (handle.ref(), watcher),
      unref: () => (handle.unref(), watcher),
    });
    return watcher;
  }

  const statWatchers = new Map<
    string,
    { timer: { close(): void }; fns: Set<(cur: unknown, prev: unknown) => void> }
  >();
  function watchFile(
    filename: string,
    options?: unknown,
    listener?: (cur: unknown, prev: unknown) => void,
  ) {
    if (typeof options === 'function') {
      listener = options as typeof listener;
      options = {};
    }
    const { interval = 5007, persistent = true } = (options ?? {}) as {
      interval?: number;
      persistent?: boolean;
    };
    const target = deps.path.resolve(String(filename));
    let entry = statWatchers.get(target);
    if (!entry) {
      let prev = deps.statSync(target) ?? { mtimeMs: 0, size: 0 };
      const fns = new Set<(cur: unknown, prev: unknown) => void>();
      const timer = loop.timers.setInterval(() => {
        const cur = deps.statSync(target) ?? { mtimeMs: 0, size: 0 };
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
          for (const fn of fns) fn(cur, prev);
        }
        prev = cur;
      }, interval);
      if (!persistent) timer.unref();
      entry = { timer, fns };
      statWatchers.set(target, entry);
    }
    if (listener) entry.fns.add(listener);
    return new EventEmitter();
  }
  function unwatchFile(filename: string, listener?: (cur: unknown, prev: unknown) => void) {
    const target = deps.path.resolve(String(filename));
    const entry = statWatchers.get(target);
    if (!entry) return;
    if (listener) entry.fns.delete(listener);
    else entry.fns.clear();
    if (entry.fns.size === 0) {
      entry.timer.close();
      statWatchers.delete(target);
    }
  }
  return { watch, watchFile, unwatchFile };
}
