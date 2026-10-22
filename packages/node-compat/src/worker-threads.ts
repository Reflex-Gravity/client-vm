// SPDX-License-Identifier: Apache-2.0
// `worker_threads`. A Worker is a child process (its own Web Worker) that
// the kernel links to its parent with a MessageChannel; the child's node
// runtime receives `workerData` over it and exposes it as `parentPort`.
// Threads share the instance's filesystem (as threads share a process's),
// and SharedArrayBuffers are shared, not copied.

import type { ProcessContext } from '@clientvm/process';
import type { KernelToProcess } from '@clientvm/protocol';
import type { Handle } from './event-loop.ts';
import { EventEmitter } from './events.ts';
import type { PosixPath } from './path.ts';

/** Sent by the parent as the first message on a new thread's port. */
export interface ThreadInit {
  t: 'init';
  threadId: number;
  workerData: unknown;
  environmentData: [unknown, unknown][];
  resourceLimits: Record<string, number>;
}

type Wire =
  | ThreadInit
  | { t: 'online' }
  | { t: 'message'; v: unknown }
  /** The thread's last message, sent as it exits. */
  | { t: 'exit' }
  | { t: 'error'; error: { name: string; message: string; stack?: string; code?: string } };

/** Thread ids live above child_process ids in the kernel's per-process child table. */
const ID_BASE = 0x40000000;
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

/**
 * The first message on a linked child's port: a worker thread's `init`, or a
 * fork's `ipc-init` (child_process IPC).
 */
export type LinkInit = ThreadInit | { t: 'ipc-init'; serialization: 'json' | 'advanced' };

/** Receives the parent's first message on a linked child's port. */
export function receiveLinkInit(port: MessagePort): Promise<LinkInit> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as LinkInit;
      if (data?.t !== 'init' && data?.t !== 'ipc-init') return;
      port.removeEventListener('message', onMessage);
      resolve(data);
    };
    port.addEventListener('message', onMessage);
    port.start();
  });
}

interface Deps {
  ctx: ProcessContext;
  loop: { handle(): Handle };
  path: PosixPath;
  cwd: () => string;
  env: () => Record<string, string>;
  /** Set when this process is a worker thread. */
  thread: { port: MessagePort; init: ThreadInit } | null;
}

/** A Node-style MessagePort over a browser MessagePort: 'message' listeners get the data. */
class NodeMessagePort extends EventEmitter {
  readonly _port: MessagePort;
  private handle: Handle | null = null;
  private refed = true;
  private readonly hold: () => Handle;
  /**
   * Messages that arrived before any 'message' listener. Node queues them on
   * the port until one is attached; a browser port may already be started (a
   * thread's port is, to read its init), and would drop them. An ES module
   * worker attaches its listener only after its graph loads.
   */
  private pending: unknown[] = [];

  constructor(port: MessagePort, hold: () => Handle) {
    super();
    this._port = port;
    this.hold = hold;
    port.addEventListener('message', (e) => {
      const data = e.data as Wire;
      if (data?.t !== 'message') return;
      const value = unwrapPorts(data.v, hold);
      if (this.listenerCount('message') > 0) this.emit('message', value);
      else this.pending.push(value);
    });
    port.addEventListener('messageerror', (e) => this.emit('messageerror', e));
    this.on('newListener', (event: string) => {
      if (event !== 'message') return;
      port.start();
      if (this.refed) this.handle ??= this.hold();
      // 'newListener' fires before the listener is added.
      if (this.pending.length > 0) queueMicrotask(() => this.flush());
    });
  }

  private flush(): void {
    while (this.pending.length > 0 && this.listenerCount('message') > 0) {
      this.emit('message', this.pending.shift());
    }
  }

  postMessage(value: unknown, transferList?: readonly unknown[]): void {
    this._port.postMessage({ t: 'message', v: wrapPorts(value) }, rawTransfers(transferList));
  }

  start(): void {
    this._port.start();
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
    this._port.close();
    queueMicrotask(() => this.emit('close'));
  }

  ref(): this {
    this.refed = true;
    if (this.listenerCount('message') > 0) this.handle ??= this.hold();
    return this;
  }

  unref(): this {
    this.refed = false;
    this.handle?.close();
    this.handle = null;
    return this;
  }

  hasRef(): boolean {
    return this.handle !== null;
  }
}

/** Ports inside a message travel as raw ports (top level or one property deep). */
function wrapPorts(value: unknown): unknown {
  if (value instanceof NodeMessagePort) return value._port;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof NodeMessagePort) {
        copy ??= { ...(value as Record<string, unknown>) };
        copy[k] = v._port;
      }
    }
    return copy ?? value;
  }
  return value;
}

function unwrapPorts(value: unknown, hold: () => Handle): unknown {
  if (value instanceof MessagePort) return new NodeMessagePort(value, hold);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof MessagePort)
        (value as Record<string, unknown>)[k] = new NodeMessagePort(v, hold);
    }
  }
  return value;
}

function rawTransfers(list: readonly unknown[] | undefined): Transferable[] {
  return (list ?? []).map((t) => (t instanceof NodeMessagePort ? t._port : t)) as Transferable[];
}

function serializeError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
} {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

/**
 * Node's `ref()`/`unref()`/`hasRef()` on the global MessagePort (one process
 * per worker, so these are this process's ports): a ref'd port keeps the
 * process alive until it is unref'd or closed. emnapi holds the event loop
 * open this way while native async work runs.
 */
export function installPortRefs(hold: () => Handle): void {
  const handles = new WeakMap<MessagePort, Handle>();
  const release = (port: MessagePort) => {
    handles.get(port)?.close();
    handles.delete(port);
  };
  const proto = MessagePort.prototype as MessagePort & Record<string, unknown>;
  const close = proto.close;
  Object.defineProperties(proto, {
    ref: {
      configurable: true,
      writable: true,
      value(this: MessagePort) {
        if (!handles.has(this)) handles.set(this, hold());
        return this;
      },
    },
    unref: {
      configurable: true,
      writable: true,
      value(this: MessagePort) {
        release(this);
        return this;
      },
    },
    hasRef: {
      configurable: true,
      writable: true,
      value(this: MessagePort) {
        return handles.has(this);
      },
    },
    close: {
      configurable: true,
      writable: true,
      value(this: MessagePort) {
        release(this);
        close.call(this);
      },
    },
  });
}

export interface WorkerThreads {
  module: Record<string, unknown>;
  /** For a worker thread: reports an uncaught error to the parent (instead of printing it). */
  reportError(err: unknown): boolean;
  /** For a worker thread: tells the parent nothing more will be posted. */
  signalExit(): void;
}

export function createWorkerThreads(deps: Deps): WorkerThreads {
  const { ctx, loop, thread } = deps;
  const hold = () => loop.handle();
  const environmentData = new Map<unknown, unknown>(thread?.init.environmentData ?? []);
  const workers = new Map<number, Worker>();
  let nextId = 1;

  ctx.onMessage((msg: KernelToProcess) => {
    if (
      (msg.t === 'child-spawned' || msg.t === 'child-error' || msg.t === 'child-exit') &&
      msg.id >= ID_BASE
    )
      workers.get(msg.id)?._onKernel(msg);
  });

  class Worker extends EventEmitter {
    threadId = -1;
    readonly resourceLimits: Record<string, number>;
    readonly stdin = null;
    readonly stdout = null;
    readonly stderr = null;
    readonly performance = {
      eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    };
    private readonly id: number;
    private port: MessagePort | null = null;
    private readonly queue: [unknown, Transferable[]][] = [];
    private handle: Handle | null;
    private exitCode: number | null = null;
    private readonly exited: Promise<number>;
    private resolveExit!: (code: number) => void;
    private terminated = false;
    private sawExit = false;
    private pendingExit: number | null = null;
    private exitFallback: ReturnType<typeof setTimeout> | undefined;
    private readonly init: Omit<ThreadInit, 'threadId'>;
    private readonly initTransfer: Transferable[];

    constructor(filename: string | URL, options: Record<string, unknown> = {}) {
      super();
      const isEval = options['eval'] === true;
      let argv: string[];
      if (isEval) {
        argv = ['node', '-e', String(filename)];
      } else {
        let file = filename instanceof URL ? filename.href : String(filename);
        if (file.startsWith('file:')) file = decodeURIComponent(new URL(file).pathname);
        else if (!file.startsWith('/') && !file.startsWith('./') && !file.startsWith('../')) {
          const err = new TypeError(
            `The worker script or module filename must be an absolute path or a relative path starting with './' or '../'. Received "${file}"`,
          );
          (err as { code?: string }).code = 'ERR_WORKER_PATH';
          throw err;
        }
        argv = [
          'node',
          deps.path.resolve(deps.cwd(), file),
          ...((options['argv'] as unknown[]) ?? []).map(String),
        ];
      }
      const env =
        options['env'] === SHARE_ENV || options['env'] === undefined
          ? deps.env()
          : Object.fromEntries(
              Object.entries(options['env'] as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ]),
            );
      this.resourceLimits = (options['resourceLimits'] as Record<string, number>) ?? {};
      this.init = {
        t: 'init',
        workerData: wrapPorts(options['workerData']),
        environmentData: [...environmentData],
        resourceLimits: this.resourceLimits,
      };
      this.initTransfer = rawTransfers(options['transferList'] as unknown[] | undefined);
      this.exited = new Promise((r) => (this.resolveExit = r));
      this.id = ID_BASE + nextId++;
      this.handle = hold();
      workers.set(this.id, this);
      ctx.send({
        t: 'spawn',
        id: this.id,
        request: {
          argv,
          env,
          cwd: deps.cwd(),
          stdio: ['ignore', 'inherit', 'inherit'],
          thread: true,
        },
      });
    }

    /** @internal */
    _onKernel(msg: KernelToProcess): void {
      if (msg.t === 'child-spawned') {
        this.threadId = msg.pid;
        const port = msg.port;
        if (!port) return;
        this.port = port;
        port.addEventListener('message', (e) => this.onPortMessage(e.data as Wire));
        port.start();
        port.postMessage({ ...this.init, threadId: msg.pid }, this.initTransfer);
        for (const [v, t] of this.queue.splice(0)) port.postMessage({ t: 'message', v }, t);
      } else if (msg.t === 'child-error') {
        const err = Object.assign(new Error(msg.message), { code: msg.code });
        queueMicrotask(() => {
          this.emit('error', err);
          this.finish(1);
        });
      } else if (msg.t === 'child-exit') {
        // A thread's exit code is its own; a kill (terminate) reports 1, as Node does.
        const code = msg.code ?? 1;
        // The kernel's exit notice and the thread's port are separate channels.
        // Node emits everything the thread posted (an 'error' above all) before
        // 'exit', so wait for the thread's last message; one killed outright
        // never sends it.
        if (this.port && !this.sawExit && !this.terminated) {
          this.pendingExit = code;
          this.exitFallback = setTimeout(() => this.finish(code), 500);
        } else this.finish(code);
      }
    }

    private onPortMessage(data: Wire): void {
      if (data?.t === 'exit') {
        this.sawExit = true;
        if (this.pendingExit !== null) this.finish(this.pendingExit);
        return;
      }
      if (data?.t === 'online') this.emit('online');
      else if (data?.t === 'message') this.emit('message', unwrapPorts(data.v, hold));
      else if (data?.t === 'error') {
        const e = data.error;
        const err = new (globalThis[e.name as 'Error'] ?? Error)(e.message);
        if (e.stack) err.stack = e.stack;
        if (e.code) (err as { code?: string }).code = e.code;
        this.emit('error', err);
      }
    }

    private finish(code: number): void {
      if (this.exitCode !== null) return;
      clearTimeout(this.exitFallback);
      this.exitCode = this.terminated ? 1 : code;
      workers.delete(this.id);
      this.port?.close();
      this.handle?.close();
      this.handle = null;
      this.resolveExit(this.exitCode);
      this.emit('exit', this.exitCode);
    }

    postMessage(value: unknown, transferList?: readonly unknown[]): void {
      const v = wrapPorts(value);
      const t = rawTransfers(transferList);
      if (this.port) this.port.postMessage({ t: 'message', v }, t);
      else if (this.exitCode === null) this.queue.push([v, t]);
    }

    terminate(): Promise<number> {
      if (this.exitCode === null) {
        this.terminated = true;
        ctx.send({ t: 'child-kill', id: this.id, signal: 'SIGKILL' });
      }
      return this.exited;
    }

    ref(): this {
      if (this.exitCode === null) this.handle ??= hold();
      return this;
    }

    unref(): this {
      this.handle?.close();
      this.handle = null;
      return this;
    }

    getHeapSnapshot(): Promise<never> {
      return Promise.reject(new Error('worker.getHeapSnapshot is not available in ClientVM'));
    }
  }

  const parentPort = thread ? new NodeMessagePort(thread.port, hold) : null;
  if (thread) thread.port.postMessage({ t: 'online' } satisfies Wire);
  // A thread's port must not keep it alive by itself (only 'message' listeners do).
  thread?.port.start();

  class MessageChannel {
    readonly port1: NodeMessagePort;
    readonly port2: NodeMessagePort;
    constructor() {
      const ch = new globalThis.MessageChannel();
      this.port1 = new NodeMessagePort(ch.port1, hold);
      this.port2 = new NodeMessagePort(ch.port2, hold);
    }
  }

  const module: Record<string, unknown> = {
    isMainThread: thread === null,
    isInternalThread: false,
    threadId: thread?.init.threadId ?? 0,
    parentPort,
    workerData: thread ? unwrapPorts(thread.init.workerData, hold) : null,
    resourceLimits: thread?.init.resourceLimits ?? {},
    SHARE_ENV,
    Worker,
    MessageChannel,
    MessagePort: NodeMessagePort,
    BroadcastChannel: globalThis.BroadcastChannel,
    getEnvironmentData: (key: unknown) => environmentData.get(key),
    setEnvironmentData: (key: unknown, value: unknown) =>
      value === undefined ? environmentData.delete(key) : environmentData.set(key, value),
    markAsUntransferable: () => {},
    isMarkedAsUntransferable: () => false,
    markAsUncloneable: () => {},
    moveMessagePortToContext: (port: unknown) => port,
    // A browser MessagePort cannot be read synchronously.
    receiveMessageOnPort: () => undefined,
  };

  return {
    module,
    reportError(err) {
      if (!thread) return false;
      thread.port.postMessage({ t: 'error', error: serializeError(err) } satisfies Wire);
      return true;
    },
    signalExit() {
      thread?.port.postMessage({ t: 'exit' } satisfies Wire);
    },
  };
}
