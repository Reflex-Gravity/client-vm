// SPDX-License-Identifier: Apache-2.0
// Process glue: the `sh`/`bash` runtime, one runtime per command, and
// external command spawning over the kernel's child-process messages.

import { createFs, createPosixPath } from '@clientvm/node-compat';
import type { ProcessContext, Runtime, RuntimeTable } from '@clientvm/process';
import { SIGNAL_NUMBERS, SystemError } from '@clientvm/protocol';
import type { ErrnoCode, KernelToProcess, StdioMode } from '@clientvm/protocol';
import { COMMANDS } from './commands/index.ts';
import { basename } from './commands/util.ts';
import { BrokenPipe, BufferedSource, macrotask, readAll } from './io.ts';
import type { Sink, Source } from './io.ts';
import { runInteractive } from './interactive.ts';
import { Io, Shell, runCommandFn } from './shell.ts';
import type { ShellHost } from './shell.ts';
import { asShellFs } from './types.ts';
import type { CommandFn, Spawner } from './types.ts';

const PUMP_YIELD_BYTES = 64 * 1024;

/** This process's stdin as a Source. On a terminal, Ctrl+D (an empty chunk) ends it. */
function processStdin(ctx: ProcessContext): Source {
  const queue: (Uint8Array | null)[] = [];
  let wake: (() => void) | null = null;
  let subscribed = false;
  const terminal = ctx.tty?.stdin === true;
  return new BufferedSource(
    async () => {
      if (!subscribed) {
        subscribed = true;
        ctx.stdin.subscribe((d) => {
          queue.push(d);
          wake?.();
        });
      }
      while (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = null;
      const chunk = queue.shift()!;
      return chunk !== null && chunk.length === 0 ? null : chunk;
    },
    undefined,
    terminal,
  );
}

function processSink(ctx: ProcessContext, fd: 1 | 2): Sink {
  const stream = fd === 1 ? ctx.stdout : ctx.stderr;
  return { write: (d) => stream.write(d), inherit: fd };
}

/**
 * Spawns external programs as child processes of this process. Output the
 * shell routes to its own stdout/stderr is inherited (no copy through here).
 */
export function createSpawner(ctx: ProcessContext): Spawner {
  let nextId = 1;
  const handlers = new Map<number, (msg: KernelToProcess) => void>();
  ctx.onMessage((msg) => {
    if (
      msg.t === 'child-spawned' ||
      msg.t === 'child-error' ||
      msg.t === 'child-output' ||
      msg.t === 'child-exit'
    ) {
      handlers.get(msg.id)?.(msg);
    }
  });
  return (argv, stdio) =>
    new Promise<number>((resolve, reject) => {
      const id = nextId++;
      // A foreground program reads the shell's terminal itself.
      const stdinMode: StdioMode =
        stdio.stdin.inherit === 0 && !stdio.background ? 'inherit' : 'pipe';
      const stdoutMode: StdioMode = stdio.stdout.inherit === 1 ? 'inherit' : 'pipe';
      const stderrMode: StdioMode = stdio.stderr.inherit === 2 ? 'inherit' : 'pipe';
      let writes: Promise<void> = Promise.resolve();
      let broken = false;
      let pumping = true;
      const deliver = (sink: Sink, data: Uint8Array) => {
        writes = writes.then(async () => {
          if (broken) return;
          try {
            await sink.write(data);
          } catch (err) {
            if (err instanceof BrokenPipe) {
              broken = true;
              ctx.send({ t: 'child-kill', id, signal: 'SIGPIPE' });
            }
          }
        });
      };
      const pump = async () => {
        let sinceYield = 0;
        for (;;) {
          const chunk = await stdio.stdin.read();
          if (!pumping) {
            if (chunk) stdio.stdin.unshift(chunk);
            return;
          }
          ctx.send({ t: 'child-stdin', id, data: chunk });
          if (chunk === null) return;
          // No acknowledgements from the child: yield so its exit can arrive
          // (`yes | node ...` would otherwise feed it forever in microtasks).
          sinceYield += chunk.length;
          if (sinceYield >= PUMP_YIELD_BYTES) {
            sinceYield = 0;
            await macrotask();
          }
        }
      };
      handlers.set(id, (msg) => {
        switch (msg.t) {
          case 'child-spawned':
            if (stdinMode === 'pipe') void pump();
            break;
          case 'child-error':
            handlers.delete(id);
            reject(new SystemError(msg.code as ErrnoCode, 'spawn', argv[0]));
            break;
          case 'child-output':
            deliver(msg.fd === 1 ? stdio.stdout : stdio.stderr, msg.data);
            break;
          case 'child-exit':
            handlers.delete(id);
            pumping = false;
            void writes.then(() =>
              resolve(msg.signal ? 128 + (SIGNAL_NUMBERS[msg.signal] ?? 15) : (msg.code ?? 1)),
            );
            break;
        }
      });
      ctx.send({
        t: 'spawn',
        id,
        request: {
          argv: [...argv],
          env: stdio.env,
          cwd: stdio.cwd,
          stdio: [stdinMode, stdoutMode, stderrMode],
          ...(stdio.background ? { newGroup: true } : {}),
        },
      });
    });
}

function hostFor(ctx: ProcessContext, commands: Readonly<Record<string, CommandFn>>): ShellHost {
  const fs = asShellFs(
    createFs(
      ctx.syscall,
      createPosixPath(() => '/'),
    ),
  );
  return { fs, spawn: createSpawner(ctx), commands, pid: ctx.pid };
}

const SET_FLAGS = new Set([
  'e',
  'u',
  'x',
  'f',
  'C',
  'a',
  'v',
  'h',
  'B',
  'm',
  'b',
  'n',
  'p',
  'P',
  'T',
  'k',
  'H',
]);

/** `sh` / `bash`: `-c string [name [args]]`, a script file, or a script on stdin. */
export function shellRuntime(commands: Readonly<Record<string, CommandFn>> = COMMANDS): Runtime {
  return async (ctx) => {
    const name = basename(ctx.argv[0] ?? 'sh');
    const args = ctx.argv.slice(1);
    let command: string | null = null;
    let readStdin = false;
    let interactiveFlag = false;
    const opts: { name: string; on: boolean }[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--' || a === '-') {
        i++;
        break;
      }
      if (a === '--login' || a === '--norc' || a === '--noprofile' || a === '--posix') continue;
      if (a === '--version') {
        ctx.stdout.write(
          'GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu) [ClientVM shell]\n',
        );
        return 0;
      }
      if (!/^[-+][A-Za-z]+$/.test(a)) break;
      const on = a[0] === '-';
      for (const f of a.slice(1)) {
        if (f === 'c' && on) command = '';
        else if (f === 's' && on) readStdin = true;
        else if (f === 'o') opts.push({ name: args[++i] ?? '', on });
        else if (f === 'i' && on) interactiveFlag = true;
        else if (f === 'i' || f === 'l') {
          // +i, login: no effect
        } else if (SET_FLAGS.has(f)) opts.push({ name: f, on });
        else {
          ctx.stderr.write(`${name}: -${f}: invalid option\n`);
          return 2;
        }
      }
    }
    const rest = args.slice(i);
    let arg0 = name;
    let scriptPath: string | null = null;
    let positional: string[];
    if (command !== null) {
      command = rest[0] ?? null;
      if (command === null) {
        ctx.stderr.write(`${name}: -c: option requires an argument\n`);
        return 2;
      }
      arg0 = rest[1] ?? name;
      positional = rest.slice(2);
    } else if (!readStdin && rest.length > 0) {
      scriptPath = rest[0]!;
      arg0 = scriptPath;
      positional = rest.slice(1);
    } else {
      positional = rest;
    }

    const host = hostFor(ctx, commands);
    const shell = Shell.create(host, {
      env: ctx.env,
      cwd: ctx.cwd,
      arg0,
      args: positional,
      scriptName: arg0,
    });
    shell.commandString = command !== null;
    for (const o of opts) {
      const set = await shell.dispatch(
        [
          'set',
          `${o.on ? '-' : '+'}${o.name.length === 1 ? o.name : 'o'}`,
          ...(o.name.length === 1 ? [] : [o.name]),
        ],
        ioFor(ctx),
      );
      if (set !== 0) return 2;
    }
    // `trap` actions run when a signal arrives; an empty action ignores it.
    ctx.onSignal((signal) => {
      const action = shell.state.traps.get(signal.slice(3));
      if (action === undefined) return false;
      if (action !== '') void shell.runString(action, ioFor(ctx)).catch(() => {});
      return true;
    });
    // Like bash: interactive with -i, or with no script when stdin and stderr are a terminal.
    const tty = ctx.tty;
    const interactive =
      tty?.stdin === true &&
      command === null &&
      scriptPath === null &&
      (interactiveFlag || (!readStdin && tty.stderr));
    if (interactive)
      return runInteractive(shell, ctx, tty, (stdin) =>
        Io.of(stdin, processSink(ctx, 1), processSink(ctx, 2)),
      );
    const io = ioFor(ctx);
    let src: string;
    if (command !== null) src = command;
    else if (scriptPath !== null) {
      try {
        const path = scriptPath.startsWith('/') ? scriptPath : `${ctx.cwd}/${scriptPath}`;
        src = new TextDecoder().decode(host.fs.readFileSync(path));
      } catch (err) {
        const code = (err as { code?: string }).code;
        ctx.stderr.write(
          `${name}: ${scriptPath}: ${code === 'EISDIR' ? 'Is a directory' : 'No such file or directory'}\n`,
        );
        return code === 'EISDIR' ? 126 : 127;
      }
    } else {
      src = new TextDecoder().decode(await readAll(io.stdin));
    }
    return shell.run(src, io);
  };
}

function ioFor(ctx: ProcessContext): Io {
  return Io.of(processStdin(ctx), processSink(ctx, 1), processSink(ctx, 2));
}

/** Runs one command as a whole process (e.g. `child_process.spawn('ls')`). */
export function commandRuntime(
  fn: CommandFn,
  commands: Readonly<Record<string, CommandFn>> = COMMANDS,
): Runtime {
  return async (ctx) => {
    const host = hostFor(ctx, commands);
    const shell = Shell.create(host, { env: ctx.env, cwd: ctx.cwd, arg0: ctx.argv[0] ?? 'sh' });
    const cmdCtx = shell.commandContext(ctx.argv, ioFor(ctx), ctx.env, ctx.cwd);
    return runCommandFn(fn, cmdCtx);
  };
}

/** Runtimes for `sh`, `bash` and every command in {@link COMMANDS}. */
export function shellRuntimes(
  commands: Readonly<Record<string, CommandFn>> = COMMANDS,
): RuntimeTable {
  const table: Record<string, Runtime> = {
    sh: shellRuntime(commands),
    bash: shellRuntime(commands),
  };
  for (const [name, fn] of Object.entries(commands)) table[name] = commandRuntime(fn, commands);
  return table;
}

/** Command names the kernel should install marker files for. */
export const SHELL_COMMAND_NAMES: readonly string[] = ['sh', 'bash', ...Object.keys(COMMANDS)];
