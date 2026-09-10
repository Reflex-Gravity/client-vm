// SPDX-License-Identifier: Apache-2.0
import { ExitSignal } from '@clientvm/process';
import type { ProcessContext } from '@clientvm/process';
import { NODE_EXEC_PATH, NODE_VERSION } from './constants.ts';

export interface ProcessState {
  cwd: string;
}

/** Node's global `process`, minus EventEmitter behavior (Phase 3). */
export function createProcessObject(
  ctx: ProcessContext,
  state: ProcessState,
  argv: string[],
  chdir: (dir: string) => string,
) {
  const start = performance.now();
  const noop = function (this: unknown) {
    return this;
  };

  const hrtime = (prev?: [number, number]): [number, number] => {
    const nowNs = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    let sec = Number(nowNs / 1_000_000_000n);
    let ns = Number(nowNs % 1_000_000_000n);
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
  hrtime.bigint = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

  const proc = {
    title: 'node',
    version: NODE_VERSION,
    versions: { node: NODE_VERSION.slice(1) },
    release: { name: 'node' },
    platform: 'linux',
    arch: 'x64',
    pid: ctx.pid,
    ppid: 0,
    execPath: NODE_EXEC_PATH,
    execArgv: [] as string[],
    argv,
    argv0: 'node',
    env: { ...ctx.env },
    exitCode: undefined as number | undefined,
    stdout: { write: (d: string | Uint8Array) => (ctx.stdout.write(d), true), isTTY: false, fd: 1 },
    stderr: { write: (d: string | Uint8Array) => (ctx.stderr.write(d), true), isTTY: false, fd: 2 },
    cwd: () => state.cwd,
    chdir: (dir: string) => {
      state.cwd = chdir(dir);
    },
    exit(code?: number): never {
      throw new ExitSignal(code ?? proc.exitCode ?? 0);
    },
    hrtime,
    uptime: () => (performance.now() - start) / 1000,
    nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
      queueMicrotask(() => fn(...args));
    },
    emitWarning(warning: string | Error) {
      const msg =
        typeof warning === 'string' ? `Warning: ${warning}` : `${warning.name}: ${warning.message}`;
      ctx.stderr.write(`(node:${ctx.pid}) ${msg}\n`);
    },
    on: noop,
    once: noop,
    off: noop,
    addListener: noop,
    removeListener: noop,
    removeAllListeners: noop,
    emit: () => false,
    listenerCount: () => 0,
  };
  return proc;
}

export type NodeProcess = ReturnType<typeof createProcessObject>;
