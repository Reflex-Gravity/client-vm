// SPDX-License-Identifier: Apache-2.0
// Runs ClientVM's shell against a MemoryVfs inside the test thread, and the
// same script under real bash in a temp dir, so outputs can be diffed.
//
// The in-thread "kernel" here runs every process's runtime in this thread with
// a direct (synchronous) syscall client: no workers, but the same runtimes,
// command resolution and child-process messages as in the browser.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FdTable,
  createSyscallHandler,
  installBuiltinCommands,
  resolveCommand,
} from '@clientvm/kernel';
import { ExitSignal } from '@clientvm/process';
import type { InputStream, ProcessContext, RuntimeTable } from '@clientvm/process';
import { SIGNAL_NUMBERS, SyscallError, errnoOf } from '@clientvm/protocol';
import type { KernelToProcess, ProcessToKernel, Signal, SyscallClient } from '@clientvm/protocol';
import { SHELL_COMMAND_NAMES, shellRuntimes } from '@clientvm/shell';
import { MemoryVfs } from '@clientvm/vfs';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Proc {
  pid: number;
  exit: Promise<{ code: number; signal: Signal | null }>;
  writeStdin(data: Uint8Array | null): void;
  kill(signal: Signal): void;
}

interface SpawnOpts {
  env: Record<string, string>;
  cwd: string;
  stdin: 'pipe' | 'closed';
  onStdout?: ((d: Uint8Array) => void) | undefined;
  onStderr?: ((d: Uint8Array) => void) | undefined;
}

export class InThreadKernel {
  readonly vfs: MemoryVfs;
  private readonly runtimes: RuntimeTable;
  private nextPid = 100;

  constructor(vfs = new MemoryVfs(), runtimes: RuntimeTable = shellRuntimes()) {
    this.vfs = vfs;
    this.runtimes = runtimes;
    for (const d of ['/bin', '/usr/bin', '/tmp', '/home/user']) vfs.mkdir(d, { recursive: true });
    installBuiltinCommands(vfs, [...SHELL_COMMAND_NAMES]);
  }

  spawn(argv: string[], opts: SpawnOpts): Proc {
    const resolved = resolveCommand(this.vfs, argv, opts.env, opts.cwd);
    const runtime = this.runtimes[resolved[0]!];
    const pid = this.nextPid++;
    const handler = createSyscallHandler(this.vfs, new FdTable(this.vfs));
    const syscall = {
      call(op: number, request: Uint8Array) {
        let r;
        try {
          r = handler(op, request);
        } catch (err) {
          throw new SyscallError(errnoOf(err));
        }
        if (r instanceof Promise) throw new SyscallError(38);
        return r;
      },
    } as unknown as SyscallClient;

    let killed: Signal | null = null;
    let settle!: (r: { code: number; signal: Signal | null }) => void;
    const exit = new Promise<{ code: number; signal: Signal | null }>((r) => (settle = r));
    let done = false;
    const finish = (code: number, signal: Signal | null) => {
      if (done) return;
      done = true;
      settle({ code, signal });
    };

    // stdin
    const pending: (Uint8Array | null)[] = [];
    let stdinListener: ((d: Uint8Array | null) => void) | null = null;
    let stdinEnded = opts.stdin === 'closed';
    if (stdinEnded) pending.push(null);
    const stdin: InputStream = {
      get open() {
        return !stdinEnded;
      },
      subscribe(l) {
        stdinListener = l;
        for (const d of pending.splice(0)) l(d);
      },
    };

    // kernel -> process messages are delivered asynchronously, in order.
    const listeners = new Set<(m: KernelToProcess) => void>();
    let chain = Promise.resolve();
    const post = (m: KernelToProcess) => {
      chain = chain.then(() => {
        if (done) return;
        for (const l of listeners) l(m);
      });
    };
    const children = new Map<number, Proc>();
    const write = (cb: SpawnOpts['onStdout']) => (d: string | Uint8Array) => {
      if (killed) throw new Error('process killed');
      cb?.(typeof d === 'string' ? enc.encode(d) : d.slice());
    };

    const ctx: ProcessContext = {
      pid,
      argv: resolved,
      env: opts.env,
      cwd: opts.cwd,
      syscall,
      stdout: { write: write(opts.onStdout) },
      stderr: { write: write(opts.onStderr) },
      stdin,
      send: (msg: ProcessToKernel) => {
        if (msg.t === 'spawn') {
          const { id, request } = msg;
          const route = (mode: string, fd: 1 | 2, inherit: SpawnOpts['onStdout']) =>
            mode === 'pipe'
              ? (d: Uint8Array) => post({ t: 'child-output', id, fd, data: d })
              : mode === 'inherit'
                ? inherit
                : undefined;
          let child: Proc;
          try {
            child = this.spawn(request.argv, {
              env: request.env,
              cwd: request.cwd,
              stdin: request.stdio[0] === 'pipe' ? 'pipe' : 'closed',
              onStdout: route(request.stdio[1], 1, opts.onStdout),
              onStderr: route(request.stdio[2], 2, opts.onStderr),
            });
          } catch (err) {
            const e = err as { code?: string; message?: string };
            post({ t: 'child-error', id, code: e.code ?? 'EIO', message: e.message ?? '' });
            return;
          }
          children.set(id, child);
          post({ t: 'child-spawned', id, pid: child.pid });
          void child.exit.then(({ code, signal }) => {
            children.delete(id);
            post({ t: 'child-exit', id, code: signal ? null : code, signal });
          });
        } else if (msg.t === 'child-stdin') children.get(msg.id)?.writeStdin(msg.data);
        else if (msg.t === 'child-kill') children.get(msg.id)?.kill(msg.signal);
      },
      onMessage(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      // The in-thread kernel terminates on kill; nothing is delivered to handlers.
      onSignal: () => () => {},
    };

    void (async () => {
      if (!runtime) {
        ctx.stderr.write(`${resolved[0]}: runtime not available\n`);
        finish(127, null);
        return;
      }
      try {
        finish((await runtime(ctx)) ?? 0, null);
      } catch (err) {
        if (err instanceof ExitSignal) finish(err.code, null);
        else if (killed) finish(128 + SIGNAL_NUMBERS[killed], killed);
        else {
          try {
            opts.onStderr?.(
              enc.encode(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`),
            );
          } catch {
            // ignore
          }
          finish(1, null);
        }
      }
    })();

    return {
      pid,
      exit,
      writeStdin(data) {
        if (stdinEnded) return;
        if (data === null) stdinEnded = true;
        if (stdinListener) stdinListener(data);
        else pending.push(data);
      },
      kill(signal) {
        killed = signal;
        finish(128 + SIGNAL_NUMBERS[signal], signal);
      },
    };
  }

  /** Runs argv to completion and collects its output. */
  async run(
    argv: string[],
    opts: { env?: Record<string, string>; cwd?: string; stdin?: string } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    const proc = this.spawn(argv, {
      env: opts.env ?? DEFAULT_TEST_ENV,
      cwd: opts.cwd ?? '/home/user',
      stdin: opts.stdin === undefined ? 'closed' : 'pipe',
      onStdout: (d) => out.push(d),
      onStderr: (d) => err.push(d),
    });
    if (opts.stdin !== undefined) {
      proc.writeStdin(enc.encode(opts.stdin));
      proc.writeStdin(null);
    }
    const { code } = await proc.exit;
    // Let trailing output messages drain.
    await new Promise((r) => setTimeout(r, 0));
    return { code, stdout: dec.decode(concat(out)), stderr: dec.decode(concat(err)) };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const DEFAULT_TEST_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/user',
  USER: 'user',
  LANG: 'C',
  LC_ALL: 'C',
  TMPDIR: '/tmp',
};

export type FileTree = Record<
  string,
  string | { symlink: string } | { mode: number; content: string } | null
>;

export interface CaseResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a script with real bash in a fresh temp dir holding `files`. */
export function runReal(
  script: string,
  files: FileTree,
  opts: { stdin?: string; shell?: string } = {},
): CaseResult & { dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cvm-sh-')));
  try {
    writeTree(dir, files);
    const r = spawnSync(opts.shell ?? 'bash', ['-c', script], {
      cwd: dir,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dir,
        USER: 'user',
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: dir,
        TZ: 'UTC',
      },
      input: opts.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    return { code: r.status ?? 128, stdout: r.stdout, stderr: r.stderr, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTree(dir: string, files: FileTree): void {
  for (const [rel, v] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    if (v === null) mkdirSync(p, { recursive: true });
    else if (typeof v === 'string') writeFileSync(p, v);
    else if ('symlink' in v) symlinkSync(v.symlink, p);
    else {
      writeFileSync(p, v.content);
      chmodSync(p, v.mode);
    }
  }
}

/** Runs a script with ClientVM's bash in `dir` (same absolute path as the real run). */
export async function runOurs(
  script: string,
  files: FileTree,
  dir: string,
  opts: { stdin?: string; shell?: string } = {},
): Promise<CaseResult> {
  const k = new InThreadKernel();
  k.vfs.mkdir(dir, { recursive: true });
  for (const [rel, v] of Object.entries(files)) {
    const p = `${dir}/${rel}`;
    k.vfs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    if (v === null) k.vfs.mkdir(p, { recursive: true });
    else if (typeof v === 'string') k.vfs.writeFile(p, enc.encode(v));
    else if ('symlink' in v) k.vfs.symlink(v.symlink, p);
    else k.vfs.writeFile(p, enc.encode(v.content), v.mode);
  }
  return k.run([opts.shell ?? 'bash', '-c', script], {
    cwd: dir,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: dir,
      USER: 'user',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: dir,
      TZ: 'UTC',
    },
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
  });
}
