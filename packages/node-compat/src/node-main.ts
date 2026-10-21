// SPDX-License-Identifier: Apache-2.0
import { nativeStandIn } from './standins.ts';
import { NO_LISTENER_HEADER, SystemError } from '@clientvm/protocol';
import { ExitSignal } from '@clientvm/process';
import type { ProcessContext } from '@clientvm/process';
import { createConsole } from './console.ts';
import { netError, virtualUrl } from './net.ts';
import { NODE_EXEC_PATH, NODE_VERSION } from './constants.ts';
import { createEventLoop } from './event-loop.ts';
import { createFs } from './fs.ts';
import { inspect } from './inspect.ts';
import { createPosixPath } from './path.ts';
import { createProcessObject } from './process-object.ts';
import { createModuleSystem, requireOf } from './module/cjs-loader.ts';
import { EsmResolver } from './module/esm-resolve.ts';
import { installEsmRuntime } from './module/esm-runtime.ts';
import type { EsmRuntime } from './module/esm-runtime.ts';
import type { ResolverFs } from './module/resolve.ts';
import type { NodeFs } from './fs.ts';
import { createBuiltins } from './builtins.ts';
import { bufferModule } from './buffer.ts';
import { warningHook } from './events.ts';
import { deprecationHook } from './util.ts';

type Invocation =
  | { kind: 'eval'; code: string; print: boolean; rest: string[] }
  | { kind: 'script'; script: string; rest: string[] }
  | { kind: 'error'; message: string };

/** fetch() that reaches this instance's own servers for `http://localhost:<port>` URLs. */
function localFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const local = virtualUrl(url);
    if (!local) return fetch(input, init);
    return fetch(input instanceof Request ? new Request(local, input) : local, init).then((res) => {
      if (!res.headers.has(NO_LISTENER_HEADER)) return res;
      // As undici reports a refused connection.
      const port = new URL(url).port || '80';
      throw new TypeError('fetch failed', {
        cause: netError('ECONNREFUSED', 'connect', '127.0.0.1', Number(port)),
      });
    });
  };
}

/** Exit code Node uses for invalid command-line arguments. */
const BAD_OPTION_EXIT_CODE = 9;

export function parseNodeArgs(args: readonly string[]): Invocation {
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      const script = args[i + 1];
      if (script === undefined) return { kind: 'error', message: 'node: REPL is not supported' };
      return { kind: 'script', script, rest: args.slice(i + 2) };
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      // `-p <code>` is shorthand for `-p -e <code>`.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-'))
        return { kind: 'eval', code: next, print, rest: args.slice(i + 2) };
      continue;
    }
    if (arg === '-e' || arg === '--eval' || arg === '-pe' || arg === '-ep') {
      if (arg !== '-e' && arg !== '--eval') print = true;
      const code = args[i + 1];
      if (code === undefined)
        return { kind: 'error', message: `node: ${arg} requires an argument` };
      return { kind: 'eval', code, print, rest: args.slice(i + 2) };
    }
    if (arg.startsWith('--eval=') || arg.startsWith('--print=')) {
      const eq = arg.indexOf('=');
      return {
        kind: 'eval',
        code: arg.slice(eq + 1),
        print: print || arg.startsWith('--print'),
        rest: args.slice(i + 1),
      };
    }
    if (arg.startsWith('-')) return { kind: 'error', message: `node: bad option: ${arg}` };
    return { kind: 'script', script: arg, rest: args.slice(i + 1) };
  }
  return { kind: 'error', message: 'node: REPL is not supported' };
}

/** The `node` command: runs `-e`/`-p` code or a CommonJS script against the Node-compat globals. */
export async function nodeRuntime(ctx: ProcessContext): Promise<number> {
  const invocation = parseNodeArgs(ctx.argv.slice(1));
  if (invocation.kind === 'error') {
    ctx.stderr.write(`${invocation.message}\n`);
    return BAD_OPTION_EXIT_CODE;
  }

  const state = { cwd: ctx.cwd, exiting: false };
  const path = createPosixPath(() => state.cwd);
  const fs = createFs(ctx.syscall, path);
  const scriptPath = invocation.kind === 'script' ? path.resolve(invocation.script) : undefined;
  const argv = [NODE_EXEC_PATH, ...(scriptPath ? [scriptPath] : []), ...invocation.rest];

  const chdir = (dir: string): string => {
    const target = path.resolve(dir);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat) throw new SystemError('ENOENT', 'chdir', state.cwd, dir);
    if (!stat.isDirectory()) throw new SystemError('ENOTDIR', 'chdir', state.cwd, dir);
    return target;
  };

  const loop = createEventLoop(globalThis);
  let streamModule: Record<string, unknown> | undefined;
  const lazyStream = () => (streamModule ??= builtins['stream'] as Record<string, unknown>);
  const proc = createProcessObject(ctx, state, argv, chdir, {
    stream: lazyStream as never,
    handle: () => loop.handle(),
  });
  const console = createConsole(ctx.stdout, ctx.stderr);
  const emitWarning = proc['emitWarning'] as (
    w: string | Error,
    type?: string,
    code?: string,
  ) => void;
  warningHook.emit = (w) => emitWarning(w);
  deprecationHook.emit = (msg, code) => emitWarning(msg, 'DeprecationWarning', code);
  const env = () => proc['env'] as Record<string, string>;
  const builtins = createBuiltins({
    fs,
    path,
    process: proc,
    console,
    timers: loop.timers,
    env,
    ctx,
    loop,
    cwd: () => state.cwd,
  });
  const resolverFs = resolverFsFrom(fs);
  const esm = new EsmResolver(resolverFs);
  let mainFile: string | undefined;
  // eslint-disable-next-line prefer-const -- the loader's compile hook needs the runtime created after it
  let esmRuntime: EsmRuntime;
  const Module = createModuleSystem({
    fs: resolverFs,
    path,
    builtins,
    cwd: () => state.cwd,
    env,
    emitWarning: (msg, type, code) => emitWarning(msg, type, code),
    nativeStandIn: (filename, requireFile) => nativeStandIn(fs, filename, ctx.pid, requireFile),
    compile: (source, filename) =>
      (0, eval)(`${esmRuntime.rewriteDynamicImports(source)}\n//# sourceURL=${filename}`) as (
        ...args: unknown[]
      ) => unknown,
  });
  builtins['module'] = Module;
  esmRuntime = installEsmRuntime({
    esm,
    Module,
    path,
    cwd: () => state.cwd,
    mainFile: () => mainFile,
    hold: () => loop.handle(),
  });

  // One process per worker, so the worker's globals are this process's globals.
  const g = globalThis as unknown as Record<string, unknown>;
  Object.assign(g, loop.timers, {
    global: globalThis,
    process: proc,
    console,
    Buffer: bufferModule.Buffer,
    ...(loop.fetch ? { fetch: localFetch(loop.fetch) } : {}),
    setImmediate: loop.timers.setImmediate,
    clearImmediate: loop.timers.clearImmediate,
  });

  /** Runs 'exit' listeners once (Node emits it on normal exit and on process.exit()). */
  const finish = (code: number): number => {
    if (!state.exiting) {
      state.exiting = true;
      try {
        proc.emit('exit', proc.exitCode ?? code);
      } catch (err) {
        if (err instanceof ExitSignal) return err.code;
        reportUncaught(ctx, err);
        return 7;
      }
    }
    return proc.exitCode ?? code;
  };
  /** Gives 'uncaughtException' listeners a chance to handle an error, as Node does. */
  const handledByListener = (error: unknown, origin: string): boolean => {
    if (proc.listenerCount('uncaughtException') === 0) return false;
    proc.emit('uncaughtException', error, origin);
    return true;
  };

  // Async failures (timer callbacks, rejected promises) end the process like in Node.
  const fatal = new Promise<number>((resolve) => {
    const onFatal = (error: unknown, origin: string) => {
      if (error instanceof ExitSignal) return resolve(error.code);
      try {
        if (handledByListener(error, origin)) return;
      } catch (err) {
        if (err instanceof ExitSignal) return resolve(err.code);
        error = err;
      }
      reportUncaught(ctx, error);
      resolve(finish(1));
    };
    globalThis.addEventListener('error', (e) => {
      e.preventDefault();
      onFatal(e.error, 'uncaughtException');
    });
    globalThis.addEventListener('unhandledrejection', (e) => {
      e.preventDefault();
      if (e.reason instanceof ExitSignal) return onFatal(e.reason, 'unhandledRejection');
      if (proc.listenerCount('unhandledRejection') > 0) {
        proc.emit('unhandledRejection', e.reason, e.promise);
        return;
      }
      onFatal(e.reason, 'unhandledRejection');
    });
  });

  try {
    if (invocation.kind === 'eval') {
      const module = Module._makeEvalModule();
      Object.assign(g, {
        require: requireOf(module),
        module,
        exports: module.exports,
        __filename: '[eval]',
        __dirname: '.',
      });
      const code = esmRuntime.rewriteDynamicImports(invocation.code);
      const result: unknown = (0, eval)(`${code}\n//# sourceURL=[eval]`);
      if (invocation.print) console.log(result);
    } else {
      // Node resolves the entry with CommonJS rules, then picks the loader by format.
      mainFile = Module._resolveFilename(scriptPath!, null, true);
      const format = esm.format(mainFile, () => resolverFs.readFile(mainFile!) ?? '');
      if (format === 'module') await esmRuntime.importFile(mainFile);
      else Module._runMainFile(mainFile);
    }
  } catch (thrown) {
    if (thrown instanceof ExitSignal) return thrown.code;
    let err: unknown = thrown;
    let handled = false;
    try {
      handled = handledByListener(err, 'uncaughtException');
    } catch (inner) {
      if (inner instanceof ExitSignal) return inner.code;
      err = inner;
    }
    if (!handled) {
      reportUncaught(ctx, err);
      return finish(1);
    }
  }

  const drained = loop.drain().then(() => {
    // Node emits 'beforeExit' when the loop empties; listeners may schedule more work.
    proc.emit('beforeExit', proc.exitCode ?? 0);
    return loop.drain();
  });
  return Promise.race([drained.then(() => finish(0)), fatal]);
}

function reportUncaught(ctx: ProcessContext, err: unknown): void {
  const text = err instanceof Error ? inspect(err) : `Uncaught ${inspect(err)}`;
  ctx.stderr.write(`${text}\n\nNode.js ${NODE_VERSION}\n`);
}

/** Resolver filesystem access through the process's sync fs. */
function resolverFsFrom(fs: NodeFs): ResolverFs {
  return {
    stat(p) {
      try {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        return st ? (st.isDirectory() ? 1 : 0) : -1;
      } catch {
        return -1;
      }
    },
    readFile(p) {
      try {
        return fs.readFileSync(p, 'utf8') as string;
      } catch {
        return null;
      }
    },
    realpath: (p) => fs.realpathSync(p),
  };
}
