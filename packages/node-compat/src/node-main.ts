// SPDX-License-Identifier: Apache-2.0
import { SystemError } from '@clientvm/protocol';
import { ExitSignal } from '@clientvm/process';
import type { ProcessContext } from '@clientvm/process';
import { createConsole } from './console.ts';
import { NODE_EXEC_PATH, NODE_VERSION } from './constants.ts';
import { createEventLoop } from './event-loop.ts';
import { createFs } from './fs.ts';
import { format, inspect } from './inspect.ts';
import { createPosixPath } from './path.ts';
import { createProcessObject } from './process-object.ts';
import { createRequire } from './require.ts';

type Invocation =
  | { kind: 'eval'; code: string; print: boolean; rest: string[] }
  | { kind: 'script'; script: string; rest: string[] }
  | { kind: 'error'; message: string };

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

  const state = { cwd: ctx.cwd };
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

  const proc = createProcessObject(ctx, state, argv, chdir);
  const console = createConsole(ctx.stdout, ctx.stderr);
  const loop = createEventLoop(globalThis);
  const util = { format, inspect };
  const builtins = { fs, path, process: proc, util, timers: loop.timers };
  const require = createRequire(builtins);

  // One process per worker, so the worker's globals are this process's globals.
  const g = globalThis as unknown as Record<string, unknown>;
  Object.assign(g, loop.timers, { global: globalThis, process: proc, console });

  // Async failures (timer callbacks, rejected promises) end the process like in Node.
  const fatal = new Promise<number>((resolve) => {
    const onFatal = (error: unknown) => {
      if (error instanceof ExitSignal) return resolve(error.code);
      reportUncaught(ctx, error);
      resolve(1);
    };
    globalThis.addEventListener('error', (e) => {
      e.preventDefault();
      onFatal(e.error);
    });
    globalThis.addEventListener('unhandledrejection', (e) => {
      e.preventDefault();
      onFatal(e.reason);
    });
  });

  try {
    if (invocation.kind === 'eval') {
      const module = { exports: {}, id: '[eval]', filename: '[eval]', loaded: false };
      Object.assign(g, {
        require,
        module,
        exports: module.exports,
        __filename: '[eval]',
        __dirname: '.',
      });
      const result: unknown = (0, eval)(`${invocation.code}\n//# sourceURL=[eval]`);
      if (invocation.print) console.log(result);
    } else {
      const file = scriptPath!;
      const source = fs.readFileSync(file, 'utf8') as string;
      const body = source.startsWith('#!') ? `//${source}` : source;
      const wrapper = (0, eval)(
        `(function (exports, require, module, __filename, __dirname) {${body}\n})\n//# sourceURL=${file}`,
      ) as (...args: unknown[]) => void;
      const module = { exports: {}, id: '.', filename: file, loaded: false };
      wrapper.call(module.exports, module.exports, require, module, file, path.dirname(file));
      module.loaded = true;
    }
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    reportUncaught(ctx, err);
    return 1;
  }

  const code = await Promise.race([loop.drain().then(() => proc.exitCode ?? 0), fatal]);
  return code;
}

function reportUncaught(ctx: ProcessContext, err: unknown): void {
  const text = err instanceof Error ? inspect(err) : `Uncaught ${inspect(err)}`;
  ctx.stderr.write(`${text}\n\nNode.js ${NODE_VERSION}\n`);
}
