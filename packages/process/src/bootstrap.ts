// SPDX-License-Identifier: Apache-2.0
import { IGNORED_BY_DEFAULT, SIGNAL_NUMBERS, SyscallClient, encodeUtf8 } from '@clientvm/protocol';
import type { KernelToProcess, ProcessToKernel, Signal, WindowSize } from '@clientvm/protocol';
import { ExitSignal } from './context.ts';
import type { InputStream, OutputStream, ProcessContext, RuntimeTable, Tty } from './context.ts';

/** The subset of `DedicatedWorkerGlobalScope` the bootstrap uses. */
export interface ProcessScopeLike {
  postMessage(message: ProcessToKernel, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<KernelToProcess>) => void): void;
  close?(): void;
}

const COMMAND_NOT_FOUND = 127;

/** Waits for the kernel's init message, then runs the matching runtime to completion. */
export function startProcessWorker(worker: ProcessScopeLike, runtimes: RuntimeTable): void {
  // The kernel channel is bound once: code running in this worker may replace
  // the global postMessage (Node has none, so libraries define their own).
  const scope: ProcessScopeLike = {
    postMessage: worker.postMessage.bind(worker),
    addEventListener: worker.addEventListener.bind(worker),
    ...(worker.close ? { close: worker.close.bind(worker) } : {}),
  };
  let started = false;
  const listeners = new Set<(m: KernelToProcess) => void>();
  const signals = createSignals(scope);
  let tty: ReturnType<typeof createTty> | undefined;
  const stdin = createStdin();
  scope.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.t === 'init') {
      if (started) return;
      started = true;
      if (!msg.stdinOpen) stdin.push(null);
      if (msg.tty) tty = createTty(scope, msg.tty);
      void run(scope, runtimes, msg, stdin, listeners, signals, tty);
      return;
    }
    if (msg.t === 'stdin') {
      stdin.push(msg.data);
      return;
    }
    if (msg.t === 'ping') {
      scope.postMessage({ t: 'pong', n: msg.n });
      return;
    }
    if (msg.t === 'signal') {
      signals.deliver(msg.signal);
      return;
    }
    if (msg.t === 'winsize') {
      tty?.resized(msg.size);
      return;
    }
    for (const l of listeners) l(msg);
  });
}

/** Signal handlers, and the default action when none takes a signal. */
function createSignals(scope: ProcessScopeLike) {
  const handlers = new Set<(signal: Signal) => boolean>();
  let ended = false;
  return {
    on(handler: (signal: Signal) => boolean): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    deliver(signal: Signal): void {
      if (ended) return;
      let handled = false;
      for (const h of [...handlers]) {
        try {
          if (h(signal)) handled = true;
        } catch {
          // A failing handler counts as not handling it.
        }
      }
      if (handled) {
        scope.postMessage({ t: 'signal-ack' });
        return;
      }
      if (IGNORED_BY_DEFAULT.has(signal)) return;
      // Default action: terminate, reporting the signal (exit status 128 + n).
      ended = true;
      scope.postMessage({ t: 'exit', code: 128 + SIGNAL_NUMBERS[signal], signal });
      scope.close?.();
    },
  };
}

function createTty(
  scope: ProcessScopeLike,
  info: { stdin: boolean; stdout: boolean; stderr: boolean } & WindowSize,
): Tty & { resized(size: WindowSize): void } {
  const resizeListeners = new Set<(size: WindowSize) => void>();
  let size: WindowSize = { cols: info.cols, rows: info.rows };
  let raw = false;
  return {
    stdin: info.stdin,
    stdout: info.stdout,
    stderr: info.stderr,
    get size() {
      return size;
    },
    get raw() {
      return raw;
    },
    setRaw(mode) {
      if (!info.stdin) return;
      raw = mode;
      scope.postMessage({ t: 'tty-mode', raw: mode });
    },
    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    resized(next) {
      size = { ...next };
      for (const l of [...resizeListeners]) l(size);
    },
  };
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
  signals: ReturnType<typeof createSignals>,
  tty: Tty | undefined,
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
    send: (message, transfer = []) => scope.postMessage(message, transfer),
    ...(init.threadPort ? { threadPort: init.threadPort } : {}),
    ...(tty ? { tty } : {}),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSignal: (handler) => signals.on(handler),
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
