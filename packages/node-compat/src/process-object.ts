// SPDX-License-Identifier: Apache-2.0
import { ExitSignal } from '@clientvm/process';
import type { OutputStream, ProcessContext } from '@clientvm/process';
import { Buffer } from './buffer.ts';
import type { BufferEncoding } from './buffer.ts';
import { NODE_EXEC_PATH, NODE_VERSION } from './constants.ts';
import { EventEmitter } from './events.ts';

export interface ProcessState {
  cwd: string;
  exiting: boolean;
}

/**
 * A minimal writable for process.stdout/stderr until `stream` lands (3b):
 * write(chunk, encoding?, cb?), end(), and the EventEmitter API.
 */
function createStdioStream(out: OutputStream, fd: number) {
  const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(stream, {
    fd,
    isTTY: false,
    writable: true,
    _isStdio: true,
    write(chunk: string | Uint8Array, encoding?: string | (() => void), cb?: () => void) {
      if (typeof encoding === 'function') cb = encoding;
      if (
        typeof chunk === 'string' &&
        typeof encoding === 'string' &&
        Buffer.isEncoding(encoding)
      ) {
        out.write(Buffer.from(chunk, encoding as BufferEncoding) as unknown as Uint8Array);
      } else {
        out.write(chunk);
      }
      if (cb) queueMicrotask(cb);
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void), cb?: () => void) {
      if (typeof chunk === 'function') cb = chunk;
      else if (chunk !== undefined) out.write(chunk);
      queueMicrotask(() => {
        stream.emit('finish');
        cb?.();
      });
      return stream;
    },
    cork() {},
    uncork() {},
    setDefaultEncoding() {
      return stream;
    },
    hasColors: () => false,
    getColorDepth: () => 1,
  });
  return stream;
}

/** Node's global `process`: an EventEmitter with Node's properties. */
export function createProcessObject(
  ctx: ProcessContext,
  state: ProcessState,
  argv: string[],
  chdir: (dir: string) => string,
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
  const stdout = createStdioStream(ctx.stdout, 1);
  const stderr = createStdioStream(ctx.stderr, 2);
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(stdin, {
    fd: 0,
    isTTY: false,
    readable: true,
    setEncoding: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    // No stdin data yet (Phase 3b); behave like an empty pipe.
    read: () => null,
  });
  // Let 'data'/'end' listeners on stdin see an immediately-closed stream.
  stdin.on('newListener', (event: unknown) => {
    if (event === 'end' || event === 'close') queueMicrotask(() => stdin.emit(event as string));
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
    execArgv: [] as string[],
    argv,
    argv0: 'node',
    env: { ...ctx.env },
    exitCode: undefined,
    stdout,
    stderr,
    stdin,
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
      throw new ExitSignal(143);
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
      queueMicrotask(() => fn(...args));
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
  return proc;
}

/** The `process` global: an EventEmitter carrying Node's process properties. */
export type NodeProcess = EventEmitter & Record<string, unknown> & { exitCode: number | undefined };
