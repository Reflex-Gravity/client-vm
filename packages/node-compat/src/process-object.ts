// SPDX-License-Identifier: Apache-2.0
import { bindAsyncContext } from './async-hooks.ts';
import { ExitSignal } from '@clientvm/process';
import type { OutputStream, ProcessContext, Tty } from '@clientvm/process';
import { SIGNAL_NUMBERS, isSignal } from '@clientvm/protocol';
import type { Signal } from '@clientvm/protocol';
import { Buffer } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';
import { NODE_EXEC_PATH, NODE_VERSION } from './constants.ts';
import { EventEmitter } from './events.ts';

export interface ProcessState {
  cwd: string;
  exiting: boolean;
}

type StreamModule = Record<string, unknown> & {
  Readable: new (
    opts?: object,
  ) => EventEmitter & Record<string, unknown> & { push(c: unknown): boolean };
  Writable: new (opts?: object) => EventEmitter & Record<string, unknown>;
};

export interface StdioDeps {
  stream: () => StreamModule;
  /** Keeps the process alive while something reads stdin. */
  handle: () => { ref(): unknown; unref(): unknown; close(): void };
}

/**
 * Node's getColorDepth: FORCE_COLOR, then NO_COLOR / NODE_DISABLE_COLORS /
 * TERM=dumb, then COLORTERM and TERM.
 */
export function colorDepth(env: Record<string, string | undefined>): number {
  const force = env['FORCE_COLOR'];
  if (force !== undefined) {
    if (force === '' || force === '1' || force === 'true') return 4;
    if (force === '2') return 8;
    if (force === '3') return 24;
    return 1;
  }
  if (env['NO_COLOR'] !== undefined || env['NODE_DISABLE_COLORS'] !== undefined) return 1;
  const term = env['TERM'];
  if (term === 'dumb') return 1;
  const colorterm = env['COLORTERM'];
  if (colorterm === 'truecolor' || colorterm === '24bit') return 24;
  if (!term) return 1;
  if (/-256(color)?$/.test(term)) return 8;
  if (/^(xterm|screen|tmux|vt100|vt220|rxvt|linux|ansi|cygwin|konsole|kitty|alacritty)/.test(term))
    return 4;
  return 1;
}

/** The tty.WriteStream methods and properties of a stdio stream that is the terminal. */
function makeTtyWritable(stream: Record<string, unknown>, tty: Tty, env: () => object) {
  const write = (data: string, cb?: () => void) => {
    (stream['write'] as (d: string, cb?: () => void) => boolean)(data, cb);
    return true;
  };
  const csi = '\x1b[';
  Object.defineProperties(stream, {
    columns: { get: () => tty.size.cols, enumerable: true, configurable: true },
    rows: { get: () => tty.size.rows, enumerable: true, configurable: true },
  });
  Object.assign(stream, {
    isTTY: true,
    getWindowSize: () => [tty.size.cols, tty.size.rows],
    getColorDepth: (e?: object) => colorDepth((e ?? env()) as Record<string, string | undefined>),
    hasColors(count?: number | object, e?: object) {
      const n = typeof count === 'number' ? count : 16;
      const vars = typeof count === 'object' ? count : (e ?? env());
      return 2 ** colorDepth(vars as Record<string, string | undefined>) >= n;
    },
    cursorTo(x: number, y?: number | (() => void), cb?: () => void) {
      const callback = typeof y === 'function' ? y : cb;
      const text =
        typeof y === 'number' ? `${csi}${y + 1};${x + 1}H` : `${csi}${(x as number) + 1}G`;
      return write(text, callback);
    },
    moveCursor(dx: number, dy: number, cb?: () => void) {
      let text = '';
      if (dx) text += `${csi}${Math.abs(dx)}${dx < 0 ? 'D' : 'C'}`;
      if (dy) text += `${csi}${Math.abs(dy)}${dy < 0 ? 'A' : 'B'}`;
      return write(text, cb);
    },
    clearLine: (dir: number, cb?: () => void) =>
      write(dir < 0 ? `${csi}1K` : dir > 0 ? `${csi}0K` : `${csi}2K`, cb),
    clearScreenDown: (cb?: () => void) => write(`${csi}0J`, cb),
  });
}

/** process.stdout / process.stderr: Writable streams over the kernel output pipe, or the terminal. */
function createStdioWritable(
  out: OutputStream,
  fd: number,
  deps: StdioDeps,
  tty: Tty | undefined,
  env: () => object,
) {
  const { Writable } = deps.stream();
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string | Uint8Array, encoding: string, cb: () => void) {
      if (
        typeof chunk === 'string' &&
        encoding !== 'utf8' &&
        encoding !== 'utf-8' &&
        Buffer.isEncoding(encoding)
      ) {
        out.write(Buffer.from(chunk, encoding as BufferEncoding) as unknown as Uint8Array);
      } else {
        out.write(chunk);
      }
      cb();
    },
  });
  // Node never closes stdio on end() (other code may still write).
  Object.assign(stream, {
    fd,
    isTTY: false,
    _isStdio: true,
    destroySoon: () => {},
    _destroy: (_err: unknown, cb: (e?: unknown) => void) => cb(),
    hasColors: () => false,
    getColorDepth: () => 1,
  });
  if (tty) {
    makeTtyWritable(stream as unknown as Record<string, unknown>, tty, env);
    tty.onResize(() => stream.emit('resize'));
  }
  return stream;
}

/** process.stdin: a Readable over the kernel's stdin pipe or the terminal; live only while consumed. */
function createStdin(ctx: ProcessContext, deps: StdioDeps) {
  const tty = ctx.tty?.stdin ? ctx.tty : undefined;
  const { Readable } = deps.stream();
  let handle: ReturnType<StdioDeps['handle']> | null = null;
  let subscribed = false;
  const stream = new Readable({
    read() {
      if (subscribed) return;
      subscribed = true;
      if (ctx.stdin.open) handle ??= deps.handle();
      ctx.stdin.subscribe((data) => {
        // On a terminal, Ctrl+D (an empty chunk) ends the stream as in Node.
        if (data === null || (tty && data.length === 0)) {
          handle?.close();
          stream.push(null);
        } else {
          stream.push(Buffer.from(data));
        }
      });
    },
  });
  // A paused stdin (no reader) does not keep the process alive, as in Node.
  stream.on('pause', () => handle?.unref());
  stream.on('resume', () => handle?.ref());
  Object.assign(stream, { fd: 0, isTTY: false, setRawMode: undefined });
  if (tty) {
    Object.defineProperty(stream, 'isRaw', { get: () => tty.raw, configurable: true });
    Object.assign(stream, {
      isTTY: true,
      setRawMode(mode: boolean) {
        tty.setRaw(Boolean(mode));
        return stream;
      },
    });
  }
  return stream;
}

/** Node's global `process`: an EventEmitter with Node's properties. */
export function createProcessObject(
  ctx: ProcessContext,
  state: ProcessState,
  argv: string[],
  chdir: (dir: string) => string,
  stdioDeps: StdioDeps,
  execArgv: string[] = [],
): NodeProcess {
  const start = performance.now();

  const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const hrtime = (prev?: [number, number]): [number, number] => {
    const now = nowNs();
    let sec = Number(now / 1_000_000_000n);
    let ns = Number(now % 1_000_000_000n);
    if (prev) {
      sec -= prev[0];
      ns -= prev[1];
      if (ns < 0) {
        sec--;
        ns += 1e9;
      }
    }
    return [sec, ns];
  };
  hrtime.bigint = nowNs;

  const proc = new EventEmitter() as EventEmitter &
    Record<string, unknown> & { exitCode: number | undefined };
  const env = () => proc['env'] as object;
  const tty = ctx.tty;
  // stdio streams are created on first access: loading streams costs a few ms.
  let stdout: unknown, stderr: unknown, stdin: unknown;
  Object.defineProperties(proc, {
    stdout: {
      get: () =>
        (stdout ??= createStdioWritable(
          ctx.stdout,
          1,
          stdioDeps,
          tty?.stdout ? tty : undefined,
          env,
        )),
      enumerable: true,
      configurable: true,
    },
    stderr: {
      get: () =>
        (stderr ??= createStdioWritable(
          ctx.stderr,
          2,
          stdioDeps,
          tty?.stderr ? tty : undefined,
          env,
        )),
      enumerable: true,
      configurable: true,
    },
    stdin: {
      get: () => (stdin ??= createStdin(ctx, stdioDeps)),
      enumerable: true,
      configurable: true,
    },
  });

  Object.assign(proc, {
    title: 'node',
    version: NODE_VERSION,
    versions: {
      node: NODE_VERSION.slice(1),
      v8: '13.6.233.10-node.32',
      uv: '1.51.0',
      modules: '137',
    },
    release: { name: 'node', lts: 'Krypton' },
    platform: 'linux',
    arch: 'x64',
    pid: ctx.pid,
    ppid: 1,
    execPath: NODE_EXEC_PATH,
    execArgv,
    argv,
    argv0: 'node',
    env: { ...ctx.env },
    exitCode: undefined,
    config: { variables: {} },
    features: {
      inspector: false,
      debug: false,
      uv: true,
      ipv6: true,
      tls_alpn: true,
      tls_sni: true,
      tls_ocsp: false,
      tls: true,
      cached_builtins: true,
      typescript: false,
    },
    cwd: () => state.cwd,
    chdir: (dir: string) => {
      state.cwd = chdir(dir);
    },
    umask: () => 0o022,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    exit(code?: number): never {
      if (code !== undefined) proc.exitCode = code;
      const final = proc.exitCode ?? 0;
      if (!state.exiting) {
        state.exiting = true;
        proc.emit('exit', final);
      }
      throw new ExitSignal(proc.exitCode ?? final);
    },
    reallyExit(code?: number): never {
      throw new ExitSignal(code ?? 0);
    },
    abort(): never {
      throw new ExitSignal(134);
    },
    kill(pid: number, signal?: string | number) {
      if (pid !== ctx.pid)
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' });
      if (signal === 0) return true;
      const sig = signalName(signal ?? 'SIGTERM');
      if (!sig)
        throw Object.assign(new TypeError(`Unknown signal: ${String(signal)}`), {
          code: 'ERR_UNKNOWN_SIGNAL',
        });
      // To itself: listeners run on a later tick, as when the kernel delivers it.
      if (onSignal(sig)) return true;
      if (sig === 'SIGWINCH' || sig === 'SIGCHLD') return true;
      throw new ExitSignal(128 + SIGNAL_NUMBERS[sig]);
    },
    hrtime,
    uptime: () => (performance.now() - start) / 1000,
    cpuUsage: () => ({ user: Math.round((performance.now() - start) * 1000), system: 0 }),
    resourceUsage: () => ({
      userCPUTime: Math.round((performance.now() - start) * 1000),
      maxRSS: 0,
    }),
    memoryUsage: Object.assign(
      () => {
        const heap = (
          performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
        ).memory;
        return {
          rss: heap?.totalJSHeapSize ?? 0,
          heapTotal: heap?.totalJSHeapSize ?? 0,
          heapUsed: heap?.usedJSHeapSize ?? 0,
          external: 0,
          arrayBuffers: 0,
        };
      },
      { rss: () => 0 },
    ),
    nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
      if (typeof fn !== 'function') {
        throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      }
      const bound = bindAsyncContext(fn);
      queueMicrotask(() => bound(...args));
    },
    emitWarning(
      warning: string | Error,
      typeOrOptions?: string | { type?: string; code?: string },
      code?: string,
    ) {
      const type =
        typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions?.type ?? 'Warning');
      const c = typeof typeOrOptions === 'object' ? typeOrOptions.code : code;
      const w =
        typeof warning === 'string' ? Object.assign(new Error(warning), { name: type }) : warning;
      if (c) (w as Error & { code?: string }).code = c;
      if (proc.listenerCount('warning') > 0) {
        queueMicrotask(() => proc.emit('warning', w));
        return;
      }
      const env = proc['env'] as Record<string, string | undefined>;
      if (w.name === 'DeprecationWarning' && env['NODE_NO_WARNINGS']) return;
      if (env['NODE_NO_WARNINGS'] === '1') return;
      ctx.stderr.write(`(node:${ctx.pid}) ${c ? `[${c}] ` : ''}${w.name}: ${w.message}\n`);
    },
    binding: () => {
      throw new Error('No such module');
    },
    allowedNodeEnvironmentFlags: new Set<string>(),
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }) },
    setUncaughtExceptionCaptureCallback: () => {},
    hasUncaughtExceptionCaptureCallback: () => false,
    setSourceMapsEnabled: () => {},
  });

  /** Emits a signal to `process` listeners; returns whether there were any. */
  const onSignal = (sig: Signal): boolean => {
    if (proc.listenerCount(sig) === 0) return false;
    // A listener that throws is an uncaught exception, as in Node.
    queueMicrotask(() => proc.emit(sig, sig, SIGNAL_NUMBERS[sig]));
    return true;
  };
  ctx.onSignal(onSignal);
  // Tell the kernel which signals have listeners, for while the process is blocked in a syscall.
  const publish = (adding?: Signal) =>
    ctx.catchSignals(
      'process',
      (Object.keys(SIGNAL_NUMBERS) as Signal[]).filter(
        (s) => s === adding || proc.listenerCount(s) > 0,
      ),
    );
  proc.on('newListener', (event: unknown) => {
    if (typeof event === 'string' && isSignal(event)) publish(event);
  });
  proc.on('removeListener', (event: unknown) => {
    if (typeof event === 'string' && isSignal(event)) publish();
  });
  return proc;
}

function signalName(signal: string | number): Signal | undefined {
  if (typeof signal === 'number')
    return (Object.keys(SIGNAL_NUMBERS) as Signal[]).find((s) => SIGNAL_NUMBERS[s] === signal);
  return isSignal(signal) ? signal : undefined;
}

/** The `process` global: an EventEmitter carrying Node's process properties. */
export type NodeProcess = EventEmitter & Record<string, unknown> & { exitCode: number | undefined };
