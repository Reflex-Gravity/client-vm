// SPDX-License-Identifier: Apache-2.0
import { SyscallClient, encodeUtf8 } from '@clientvm/protocol';
import type { KernelToProcess, ProcessToKernel } from '@clientvm/protocol';
import { ExitSignal } from './context.ts';
import type { OutputStream, ProcessContext, RuntimeTable } from './context.ts';

/** The subset of `DedicatedWorkerGlobalScope` the bootstrap uses. */
export interface ProcessScopeLike {
  postMessage(message: ProcessToKernel): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<KernelToProcess>) => void): void;
  close?(): void;
}

const COMMAND_NOT_FOUND = 127;

/** Waits for the kernel's init message, then runs the matching runtime to completion. */
export function startProcessWorker(scope: ProcessScopeLike, runtimes: RuntimeTable): void {
  let started = false;
  scope.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.t !== 'init' || started) return;
    started = true;
    void run(scope, runtimes, msg);
  });
}

async function run(
  scope: ProcessScopeLike,
  runtimes: RuntimeTable,
  init: KernelToProcess,
): Promise<void> {
  const stream = (t: 'stdout' | 'stderr'): OutputStream => ({
    write(data) {
      scope.postMessage({ t, data: typeof data === 'string' ? encodeUtf8(data) : data.slice() });
    },
  });

  const syscall = new SyscallClient(
    init.channel,
    init.syscallMode === 'postMessage'
      ? { doorbell: () => scope.postMessage({ t: 'doorbell' }) }
      : {},
  );

  const ctx: ProcessContext = {
    pid: init.pid,
    argv: init.argv,
    env: init.env,
    cwd: init.cwd,
    syscall,
    stdout: stream('stdout'),
    stderr: stream('stderr'),
  };

  const command = basename(init.argv[0] ?? '');
  const runtime = runtimes[command];
  scope.postMessage({ t: 'ready' });

  let code: number;
  if (!runtime) {
    ctx.stderr.write(`${command}: command not found\n`);
    code = COMMAND_NOT_FOUND;
  } else {
    try {
      code = (await runtime(ctx)) ?? 0;
    } catch (err) {
      if (err instanceof ExitSignal) {
        code = err.code;
      } else {
        ctx.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        code = 1;
      }
    }
  }
  scope.postMessage({ t: 'exit', code });
  scope.close?.();
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
