// SPDX-License-Identifier: Apache-2.0
import { createTestModule } from './test-runner.ts';
import { installStdioFds } from './fs-stdio.ts';
import { createV8 } from './v8.ts';
import { createWasi } from './wasi.ts';
import type { WasiFs } from './wasi.ts';
import { createHttp2 } from './http2.ts';
import { createReadline } from './readline.ts';
import { assertModule } from './assert.ts';
import { bufferModule } from './buffer.ts';
import type { createConsole } from './console.ts';
import { eventsModule } from './events.ts';
import type { NodeFs } from './fs.ts';
import { createOs } from './os.ts';
import type { PosixPath } from './path.ts';
import type { NodeProcess } from './process-object.ts';
import { querystringModule } from './querystring.ts';
import { diagnosticsChannelModule } from './diagnostics-channel.ts';
import { asyncHooksModule } from './async-hooks.ts';
import { stringDecoderModule } from './string-decoder.ts';
import { urlModule } from './url.ts';
import { utilModule } from './util.ts';
import { extendFs } from './fs-extra.ts';
import { createConsumers, loadStreamModule } from './stream.ts';
import { createChildProcess, createWatchers } from './child-process.ts';
import type { EventLoop } from './event-loop.ts';
import type { ProcessContext } from '@clientvm/process';
import { createNet } from './net.ts';
import type { NetModule } from './net.ts';
import { createHttp } from './http.ts';
import { createZlib } from './zlib.ts';
import { cryptoModule } from './crypto.ts';
import { createDns, createTls } from './dns-tls.ts';

export interface BuiltinDeps {
  fs: NodeFs;
  path: PosixPath;
  process: NodeProcess;
  console: ReturnType<typeof createConsole>;
  timers: Record<string, unknown>;
  env: () => Record<string, string>;
  ctx: ProcessContext;
  loop: EventLoop;
  cwd: () => string;
  /** The `worker_threads` module (created up front: a thread needs it before any require). */
  workerThreads: Record<string, unknown>;
}

/**
 * The builtin module table for one process (`require('fs')`, `node:fs`).
 * Modules not listed here fail with MODULE_NOT_FOUND until implemented; see
 * docs/compatibility.md.
 */
export function createBuiltins(deps: BuiltinDeps): Record<string, unknown> {
  const { fs, path, process } = deps;
  const url = {
    ...urlModule,
    pathToFileURL: (p: string) => urlModule.pathToFileURL(p, (x) => path.resolve(x)),
  };
  const timersPromises = {
    setTimeout: (ms?: number, value?: unknown) =>
      new Promise((r) =>
        (deps.timers['setTimeout'] as (f: () => void, ms?: number) => void)(() => r(value), ms),
      ),
    setImmediate: (value?: unknown) =>
      new Promise((r) => (deps.timers['setImmediate'] as (f: () => void) => void)(() => r(value))),
    scheduler: {
      wait: (ms: number) =>
        new Promise((r) =>
          (deps.timers['setTimeout'] as (f: () => void, ms?: number) => void)(r as () => void, ms),
        ),
      yield: () =>
        new Promise((r) =>
          (deps.timers['setImmediate'] as (f: () => void) => void)(r as () => void),
        ),
    },
  };
  let stream: Record<string, unknown> | undefined;
  const loadStream = () =>
    (stream ??= loadStreamModule({
      buffer: bufferModule,
      events: eventsModule,
      string_decoder: stringDecoderModule,
      process,
    }));
  const defer = (fn: () => void) => (deps.timers['setImmediate'] as (f: () => void) => void)(fn);
  const fsFull = extendFs({ fs, path, stream: loadStream as never, defer });
  installStdioFds(fsFull, () => process as never);
  const statForWatch = (p: string) =>
    fs.statSync(p, { throwIfNoEntry: false }) as { mtimeMs: number; size: number } | undefined;
  Object.assign(
    fsFull,
    createWatchers({ ctx: deps.ctx, loop: deps.loop, path, statSync: statForWatch }),
  );
  const fsPromises = fsFull['promises'] as Record<string, unknown>;
  fsPromises['watch'] = async function* (
    filename: string,
    options: { recursive?: boolean; signal?: AbortSignal } = {},
  ) {
    const queue: { eventType: string; filename: string | null }[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const watcher = (
      fsFull['watch'] as (
        f: string,
        o: object,
        l: (e: string, n: string | null) => void,
      ) => { close(): void }
    )(filename, options, (eventType, name) => {
      queue.push({ eventType, filename: name });
      wake?.();
    });
    options.signal?.addEventListener('abort', () => {
      closed = true;
      wake?.();
    });
    try {
      while (!closed) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (queue.length > 0) yield queue.shift()!;
      }
    } finally {
      watcher.close();
    }
  };
  const childProcess = createChildProcess({
    ctx: deps.ctx,
    path,
    loop: deps.loop,
    stream: loadStream as never,
    env: deps.env,
    cwd: deps.cwd,
  });
  const table: Record<string, unknown> = {
    assert: assertModule,
    'assert/strict': assertModule.strict,
    buffer: bufferModule,
    console: deps.console,
    crypto: cryptoModule,
    constants: { ...fs.constants, ...createOs(deps.env).constants.signals },
    events: eventsModule,
    fs: fsFull,
    child_process: childProcess,
    'fs/promises': fsFull['promises'],
    os: createOs(deps.env),
    path,
    'path/posix': path,
    'path/win32': path.win32,
    process,
    querystring: querystringModule,
    diagnostics_channel: diagnosticsChannelModule,
    async_hooks: asyncHooksModule,
    string_decoder: stringDecoderModule,
    timers: deps.timers,
    'timers/promises': timersPromises,
    url,
    util: utilModule,
    'util/types': utilModule['types'],
  };
  const term = deps.ctx.tty;
  const tty = {
    // fds 0-2 are the terminal when the kernel says so; other fds are files or devices.
    isatty: (fd: number) =>
      (fd === 0 && term?.stdin === true) ||
      (fd === 1 && term?.stdout === true) ||
      (fd === 2 && term?.stderr === true),
    ReadStream: class ReadStream {
      isTTY = false;
    },
    WriteStream: class WriteStream {
      isTTY = false;
      getColorDepth() {
        return 1;
      }
      hasColors() {
        return false;
      }
    },
  };
  const perfHooks = {
    performance: globalThis.performance,
    PerformanceObserver: globalThis.PerformanceObserver,
    PerformanceEntry: globalThis.PerformanceEntry,
    constants: {},
    monitorEventLoopDelay: () => ({
      enable() {},
      disable() {},
      percentile: () => 0,
      min: 0,
      max: 0,
      mean: 0,
      stddev: 0,
    }),
    createHistogram: () => ({ record() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }),
  };
  // Streams are loaded on first use (they are ~7k lines of Node's own code).
  const lazy = (name: string, get: () => unknown) =>
    Object.defineProperty(table, name, { get, enumerable: true, configurable: true });
  lazy('stream', loadStream);
  let net: NetModule | undefined;
  const loadNet = () =>
    (net ??= createNet({ ctx: deps.ctx, loop: deps.loop, stream: loadStream as never }));
  let http: Record<string, unknown> | undefined;
  let https: Record<string, unknown> | undefined;
  lazy('net', () => loadNet().module);
  let dns: Record<string, unknown> | undefined;
  let tls: Record<string, unknown> | undefined;
  lazy('dns', () => (dns ??= createDns()));
  lazy('dns/promises', () => (dns ??= createDns())['promises']);
  lazy('tls', () => (tls ??= createTls(loadNet())));
  let readline: ReturnType<typeof createReadline> | undefined;
  lazy('readline', () => (readline ??= createReadline()).readline);
  lazy('readline/promises', () => (readline ??= createReadline()).promises);
  let v8: Record<string, unknown> | undefined;
  lazy('v8', () => (v8 ??= createV8()));
  let wasi: Record<string, unknown> | undefined;
  lazy('wasi', () => (wasi ??= createWasi({ fs: fsFull as unknown as WasiFs, path })));
  table['worker_threads'] = deps.workerThreads;
  let testModule: Record<string, unknown> | undefined;
  lazy(
    'test',
    () =>
      (testModule ??= createTestModule({
        write: (text) =>
          (process as unknown as { stdout: { write(s: string): void } }).stdout.write(text),
        setExitCode: (code) => ((process as unknown as { exitCode?: number }).exitCode = code),
        hold: () => deps.loop.handle(),
        assert: assertModule,
        setImmediate: (fn) => (deps.timers['setImmediate'] as (f: () => void) => unknown)(fn),
      })),
  );
  let http2: Record<string, unknown> | undefined;
  lazy('http2', () => (http2 ??= createHttp2()));
  let zlib: Record<string, unknown> | undefined;
  lazy('zlib', () => (zlib ??= createZlib(loadStream as never)));
  lazy(
    'http',
    () => (http ??= createHttp({ net: loadNet(), stream: loadStream as never }, 'http:')),
  );
  lazy(
    'https',
    () => (https ??= createHttp({ net: loadNet(), stream: loadStream as never }, 'https:')),
  );
  lazy('stream/promises', () => loadStream()['promises']);
  lazy('stream/consumers', () => createConsumers(bufferModule.Buffer as never));
  lazy('_stream_readable', () => loadStream()['Readable']);
  lazy('_stream_writable', () => loadStream()['Writable']);
  lazy('_stream_duplex', () => loadStream()['Duplex']);
  lazy('_stream_transform', () => loadStream()['Transform']);
  lazy('_stream_passthrough', () => loadStream()['PassThrough']);
  table['stream/web'] = {
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
    WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,
    TextEncoderStream: globalThis.TextEncoderStream,
    TextDecoderStream: globalThis.TextDecoderStream,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
  };
  table['tty'] = tty;
  table['perf_hooks'] = perfHooks;
  table['sys'] = utilModule;
  table['vm'] = createVm();
  return table;
}

/**
 * `vm`: code runs in the process's own realm. ClientVM has no V8 contexts, so
 * "new context" functions evaluate with the sandbox's properties in scope
 * via `with`; this is not a security boundary (neither is Node's vm).
 */
function createVm() {
  const runInThisContext = (code: string, options?: { filename?: string } | string) => {
    const filename = typeof options === 'string' ? options : options?.filename;
    return (0, eval)(filename ? `${code}\n//# sourceURL=${filename}` : code);
  };
  const contexts = new WeakSet<object>();
  const runInContext = (code: string, context: object) => {
    const fn = new Function('__ctx', `with (__ctx) { return eval(${JSON.stringify(code)}); }`) as (
      c: object,
    ) => unknown;
    return fn(context);
  };
  class Script {
    readonly code: string;
    readonly filename: string | undefined;
    constructor(code: string, options?: { filename?: string } | string) {
      this.code = code;
      this.filename = typeof options === 'string' ? options : options?.filename;
    }
    runInThisContext() {
      return runInThisContext(this.code, this.filename ? { filename: this.filename } : undefined);
    }
    runInContext(context: object) {
      return runInContext(this.code, context);
    }
    runInNewContext(sandbox: object = {}) {
      return runInContext(this.code, sandbox);
    }
    createCachedData() {
      return new Uint8Array(0);
    }
  }
  return {
    Script,
    runInThisContext,
    runInContext,
    runInNewContext: (code: string, sandbox: object = {}) => runInContext(code, sandbox),
    createContext: (sandbox: object = {}) => {
      contexts.add(sandbox);
      return sandbox;
    },
    isContext: (obj: object) => contexts.has(obj),
    compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
  };
}
