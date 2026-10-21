// SPDX-License-Identifier: Apache-2.0
import { SyscallClient, encodeUtf8 } from '@clientvm/protocol';
import type { KernelToProcess, ProcessToKernel } from '@clientvm/protocol';
import { ExitSignal } from './context.ts';
import type { InputStream, OutputStream, ProcessContext, RuntimeTable } from './context.ts';

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
  const listeners = new Set<(m: KernelToProcess) => void>();
  const stdin = createStdin();
  scope.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.t === 'init') {
      if (started) return;
      started = true;
      if (!msg.stdinOpen) stdin.push(null);
      void run(scope, runtimes, msg, stdin, listeners);
      return;
    }
    if (msg.t === 'stdin') {
      stdin.push(msg.data);
      return;
    }
    for (const l of listeners) l(msg);
  });
}

function createStdin(): InputStream & { push(data: Uint8Array | null): void } {
  const buffered: (Uint8Array | null)[] = [];
  let listener: ((data: Uint8Array | null) => void) | null = null;
  let ended = false;
  return {
    get open() {
      return !ended;
    },
    push(data) {
      if (ended) return;
      if (data === null) ended = true;
      if (listener) listener(data);
      else buffered.push(data);
    },
    subscribe(l) {
      listener = l;
      for (const d of buffered.splice(0)) l(d);
    },
  };
}

async function run(
  scope: ProcessScopeLike,
  runtimes: RuntimeTable,
  init: Extract<KernelToProcess, { t: 'init' }>,
  stdin: InputStream,
  listeners: Set<(m: KernelToProcess) => void>,
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
    stdin,
    send: (message) => scope.postMessage(message),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  // The kernel resolved argv[0] to a runtime name before spawning.
  const command = init.argv[0] ?? '';
  const runtime = runtimes[command];
  scope.postMessage({ t: 'ready' });

  let code: number;
  if (!runtime) {
    ctx.stderr.write(`${command}: runtime not available in this build\n`);
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
