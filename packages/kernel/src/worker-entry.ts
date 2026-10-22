// SPDX-License-Identifier: Apache-2.0
import {
  MAILBOX_HOST,
  NO_LISTENER_HEADER,
  RpcEndpoint,
  SystemError,
  decodeUtf8,
  encodeUtf8,
  withTransfer,
} from '@clientvm/protocol';
import type {
  ControllerRpc,
  FileKind,
  HttpRpc,
  InstanceEvents,
  InstanceInit,
  InstanceRpc,
  PortLike,
  SpawnRequest,
  StatData,
  WireRequest,
  WireResponse,
  WireStat,
} from '@clientvm/protocol';
import {
  MemoryVfs,
  OpfsBackend,
  Persister,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  acquireStoreLock,
  exportImage,
  loadPersisted,
  purgePersisted,
} from '@clientvm/vfs';
import type { PersistenceBackend, Snapshot } from '@clientvm/vfs';
import { HttpRouter, staticHandler } from './http.ts';
import { Inbox, mailboxHandler } from './mailbox.ts';
import { exportTree } from './mounts.ts';
import { NetStack } from './net.ts';
import { ModuleServer } from './module-server.ts';
import { DEFAULT_ENV } from './commands.ts';
import { Kernel } from './kernel.ts';
import type { KernelOptions, ProcessHandle } from './kernel.ts';

/** Sent by the instance page to its kernel worker once the controller has connected. */
/** A terminal size the kernel accepts (whole cells, at most 10000 each way). */
const validSize = (cols: unknown, rows: unknown): cols is number =>
  Number.isInteger(cols) &&
  Number.isInteger(rows) &&
  (cols as number) >= 1 &&
  (rows as number) >= 1 &&
  (cols as number) <= 10_000 &&
  (rows as number) <= 10_000;

export interface KernelBootMessage {
  t: 'clientvm:kernel-boot';
  init: InstanceInit;
  /** The controller's end of the RPC channel. */
  port: MessagePort;
}

export type KernelWorkerOptions = Pick<
  KernelOptions,
  'createProcessWorker' | 'payloadBytes' | 'commands'
> & {
  /**
   * Opens the persistent store for `init.persist`. Defaults to the instance
   * origin's OPFS, guarded by a Web Lock so only one tab owns it.
   */
  openPersistence?: () => Promise<{ backend: PersistenceBackend; release(): void }>;
  /**
   * Measures the instance's memory in bytes. Dedicated workers lack
   * `performance.measureUserAgentSpecificMemory`, so the instance page
   * measures (its agent cluster: page, kernel and process workers).
   */
  measureMemory?: () => Promise<number | null>;
};

/** Sent by the kernel to the instance page; the page answers on `port` with {@link MemoryReply}. */
export interface KernelMeasureMemoryMessage {
  t: 'clientvm:measure-memory';
  port: MessagePort;
}

export interface MemoryReply {
  bytes: number | null;
}

/** Sent by the instance page when it is being hidden or unloaded. */
export interface KernelFlushMessage {
  t: 'clientvm:flush';
}

/** Sent by the instance page with a port whose other end belongs to the service worker. */
export interface KernelHttpPortMessage {
  t: 'clientvm:http-port';
  port: MessagePort;
}

export interface ServedInstance {
  kernel: Kernel;
  /** Serves HTTP requests from the service worker on `port`. */
  attachHttpPort(port: MessagePort): void;
  /** Persists pending changes (no-op when not persistent). */
  flush(): Promise<void>;
}

async function openOpfs(): Promise<{ backend: PersistenceBackend; release(): void }> {
  const release = await acquireStoreLock();
  if (!release) {
    throw new SystemError('EBUSY', 'persist', 'instance is open in another tab or window');
  }
  try {
    return { backend: await OpfsBackend.open(), release };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Entry point for an instance's kernel worker: waits for the boot message,
 * then serves {@link InstanceRpc} to the controller on the transferred port.
 */
export function startKernelWorker(
  scope: { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void },
  options: KernelWorkerOptions,
): void {
  let served: Promise<ServedInstance> | null = null;
  scope.addEventListener('message', (event) => {
    const msg = event.data as
      | Partial<KernelBootMessage>
      | Partial<KernelFlushMessage>
      | Partial<KernelHttpPortMessage>
      | null;
    if (msg?.t === 'clientvm:flush') {
      void served?.then((s) => s.flush()).catch(() => {});
      return;
    }
    if (msg?.t === 'clientvm:http-port') {
      const port = (msg as KernelHttpPortMessage).port;
      if (port) void served?.then((s) => s.attachHttpPort(port)).catch(() => {});
      return;
    }
    if (served || msg?.t !== 'clientvm:kernel-boot' || !msg.init || !msg.port) return;
    served = serveInstance(msg.port, msg.init, options);
    // Boot failures are reported to the controller through the RPC channel.
    served.catch(() => {});
  });
}

/**
 * Serves {@link InstanceRpc} on `port` for a kernel booted from `init`.
 * Requests that arrive during boot wait for it; if boot fails (e.g. a locked
 * or corrupt store), every request fails with that error.
 */
export function serveInstance(
  port: PortLike,
  init: InstanceInit,
  options: KernelWorkerOptions,
): Promise<ServedInstance> {
  let methods: InstanceRpc | undefined;
  // eslint-disable-next-line prefer-const -- assigned after the endpoint that boot() emits through
  let rpc: RpcEndpoint<InstanceRpc, InstanceEvents & ControllerRpc>;
  const ready = boot(
    init,
    options,
    (event, ...args) => rpc.emit(event, ...args),
    (method, ...args) => rpc.call(method, ...args),
  ).then((booted) => {
    methods = booted.methods;
    return booted.served;
  });
  const gated = new Proxy({} as InstanceRpc, {
    get:
      (_target, name: string) =>
      async (...args: unknown[]) => {
        await ready;
        const table = methods as unknown as Record<string, (...a: unknown[]) => unknown>;
        const method = Object.hasOwn(table, name) ? table[name] : undefined;
        if (typeof method !== 'function') throw new SystemError('ENOSYS', name);
        return method(...args);
      },
  });
  rpc = new RpcEndpoint<InstanceRpc, InstanceEvents & ControllerRpc>(port, gated);
  return ready;
}

type Emit = <K extends keyof InstanceEvents>(
  event: K,
  ...args: Parameters<InstanceEvents[K]>
) => void;

type CallController = <K extends keyof ControllerRpc>(
  method: K,
  ...args: Parameters<ControllerRpc[K]>
) => Promise<Awaited<ReturnType<ControllerRpc[K]>>>;

async function boot(
  init: InstanceInit,
  options: KernelWorkerOptions,
  emit: Emit,
  callController: CallController,
): Promise<{ methods: InstanceRpc; served: ServedInstance }> {
  let store: { backend: PersistenceBackend; release(): void } | null = null;
  let restored: { snapshot: Snapshot; generation: number } | null = null;
  if (init.persist) {
    store = await (options.openPersistence ?? openOpfs)();
    try {
      restored = await loadPersisted(store.backend);
    } catch (err) {
      store.release();
      throw err;
    }
  }

  const { quotaBytes, maxInodes, maxProcesses, maxCpuMs } = init.limits ?? {};

  // Ports are announced only once a service worker link exists, so a preview
  // opened in response always reaches the kernel.
  let httpLinked = false;
  const router = new HttpRouter(
    (port, primary) => {
      if (httpLinked) emit('portOpen', port, primary);
    },
    (port) => emit('portClose', port),
  );
  const net = new NetStack(router);
  const kernel = new Kernel({
    createProcessWorker: options.createProcessWorker,
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.payloadBytes === undefined ? {} : { payloadBytes: options.payloadBytes }),
    fsLimits: {
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      ...(maxInodes === undefined ? {} : { maxInodes }),
    },
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    ...(typeof maxCpuMs === 'number' && maxCpuMs > 0 ? { maxCpuMs } : {}),
    net,
    ...(restored ? { snapshot: restored.snapshot } : init.image ? { image: init.image } : {}),
  });
  if (!restored) {
    for (const [path, contents] of Object.entries(init.files ?? {})) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) kernel.vfs.mkdir(dir, { recursive: true });
      kernel.vfs.writeFile(path, typeof contents === 'string' ? encodeUtf8(contents) : contents);
    }
  }
  const persister = store
    ? await Persister.attach(kernel.vfs, store.backend, restored?.generation ?? 0)
    : null;
  const flush = async () => {
    await persister?.flush();
  };

  const modules = new ModuleServer(kernel.vfs);
  const inbox = new Inbox();
  const mailbox = mailboxHandler({ id: init.id, name: init.name ?? null }, inbox, (to, message) =>
    callController('mailboxSend', to, message),
  );
  /** Requests from processes to `http://<peer>.internal/`: the mailbox, or another instance. */
  const fetchPeer = async (req: WireRequest & { peer: string }): Promise<WireResponse> => {
    if (req.peer === MAILBOX_HOST) return mailbox(req);
    try {
      return await callController('netFetch', req.peer, req);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: code === 'ERR_NO_CAPABILITY' ? 403 : 502,
        statusText: code === 'ERR_NO_CAPABILITY' ? 'Forbidden' : 'Bad Gateway',
        headers: [
          ['content-type', 'text/plain; charset=utf-8'],
          // An unknown instance refuses connections, like a closed port.
          ...(code === 'ERR_NO_INSTANCE'
            ? ([[NO_LISTENER_HEADER, '1']] as [string, string][])
            : []),
        ],
        body: encodeUtf8(`ClientVM: ${message}\n`),
      };
    }
  };
  const attachHttpPort = (port: MessagePort) => {
    new RpcEndpoint<HttpRpc, Record<string, never>>(port, {
      fetch: async (req) => {
        if (typeof req.peer === 'string')
          return transferBody(await fetchPeer(req as WireRequest & { peer: string }));
        // Module requests (a process importing from the VFS) only come from the instance origin itself.
        if (req.port === null && modules.handles(new URL(req.path, 'http://x').pathname))
          return modules.handle(req);
        return transferBody(await router.handle(req));
      },
      upgrade: async (req, socket) => {
        if (socket instanceof MessagePort) router.upgrade(req, socket);
      },
    });
    if (httpLinked) return;
    httpLinked = true;
    for (const p of router.ports) emit('portOpen', p.port, p.primary);
  };

  const watches = new Map<number, () => void>();
  let nextWatch = 1;

  const spawn = (
    request: SpawnRequest,
    onOutput?: (fd: 1 | 2, data: Uint8Array) => void,
  ): ProcessHandle => {
    if (request.pty && !onOutput) {
      const { cols, rows } = request.pty;
      if (!validSize(cols, rows)) throw new SystemError('EINVAL', 'spawn');
      const term: ProcessHandle = kernel.spawn(request.argv, {
        // Terminal programs look at TERM for colours and capabilities.
        env: { ...DEFAULT_ENV, TERM: 'xterm-256color', ...request.env },
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.syscallMode ? { syscallMode: request.syscallMode } : {}),
        pty: { size: { cols, rows }, onOutput: (d) => emit('output', term.pid, 1, d) },
      });
      return term;
    }
    const proc = kernel.spawn(request.argv, {
      // Processes started by the controller get a login-like environment.
      env: { ...DEFAULT_ENV, ...request.env },
      // Without `request.stdin`, `spawn` keeps stdin open for writeStdin and `run` closes it.
      // With it, stdin is fed and closed; empty stdin starts at end-of-file.
      stdin:
        request.stdin === undefined
          ? onOutput
            ? 'closed'
            : 'pipe'
          : request.stdin.length > 0
            ? 'pipe'
            : 'closed',
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.syscallMode ? { syscallMode: request.syscallMode } : {}),
      onStdout: (d) => (onOutput ? onOutput(1, d) : emit('output', proc.pid, 1, d)),
      onStderr: (d) => (onOutput ? onOutput(2, d) : emit('output', proc.pid, 2, d)),
    });
    if (request.stdin !== undefined && request.stdin.length > 0) {
      proc.writeStdin(
        typeof request.stdin === 'string' ? encodeUtf8(request.stdin) : request.stdin,
      );
      proc.writeStdin(null);
    }
    return proc;
  };

  const methods: InstanceRpc = {
    ping: () => ({ crossOriginIsolated: globalThis.crossOriginIsolated === true }),
    readFile: (path) => kernel.vfs.readFile(path).slice(),
    writeFile(path, data) {
      kernel.vfs.writeFile(path, typeof data === 'string' ? encodeUtf8(data) : data);
    },
    readdir: (path) => kernel.vfs.readdirTyped(path),
    stat: (path) => toWireStat(kernel.vfs.stat(path)),
    mkdir(path, recursive) {
      kernel.vfs.mkdir(path, { recursive });
    },
    rm(path, recursive, force) {
      let isDir: boolean;
      try {
        isDir = (kernel.vfs.lstat(path).mode & S_IFMT) === S_IFDIR;
      } catch (err) {
        if (force && err instanceof SystemError && err.code === 'ENOENT') return;
        throw err;
      }
      if (isDir && !recursive) throw new SystemError('EISDIR', 'rm', path);
      kernel.vfs.rmTree(path);
    },
    rename(from, to) {
      kernel.vfs.rename(from, to);
    },
    symlink(target, path) {
      kernel.vfs.symlink(target, path);
    },
    watch(path, recursive) {
      const id = nextWatch++;
      watches.set(
        id,
        kernel.vfs.watch(path, { recursive }, (events) => emit('fsEvents', id, events)),
      );
      return id;
    },
    unwatch(id) {
      watches.get(id)?.();
      watches.delete(id);
    },
    spawn(request) {
      const proc = spawn(request);
      void proc.exit.then(({ code, signal }) => emit('exit', proc.pid, code, signal));
      return proc.pid;
    },
    kill(pid, signal) {
      const proc = kernel.getProcess(pid);
      if (!proc) throw new SystemError('ESRCH', 'kill');
      proc.kill(signal);
    },
    writeStdin(pid, data) {
      const proc = kernel.getProcess(pid);
      if (!proc) throw new SystemError('ESRCH', 'write');
      if (data !== null && !(data instanceof Uint8Array)) throw new SystemError('EINVAL', 'write');
      proc.writeStdin(data);
    },
    resize(pid, cols, rows) {
      const proc = kernel.getProcess(pid);
      if (!proc) throw new SystemError('ESRCH', 'ioctl');
      if (!validSize(cols, rows)) throw new SystemError('EINVAL', 'ioctl');
      proc.resize({ cols, rows });
    },
    async run(request) {
      const out: Uint8Array[] = [];
      const err: Uint8Array[] = [];
      const proc = spawn(request, (fd, d) => (fd === 1 ? out : err).push(d));
      const timeout = request.timeoutMs;
      const timer =
        typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
          ? setTimeout(() => proc.kill('SIGTERM'), timeout)
          : undefined;
      const { code, signal } = await proc.exit;
      if (timer !== undefined) clearTimeout(timer);
      const { spawnedAt, readyAt, exitedAt } = proc.timing;
      return {
        code,
        signal,
        stdout: decodeUtf8(concat(out)),
        stderr: decodeUtf8(concat(err)),
        spawnToReadyMs: readyAt === undefined ? null : readyAt - spawnedAt,
        totalMs: (exitedAt ?? performance.now()) - spawnedAt,
      };
    },
    snapshot: () => kernel.snapshot(),
    dropSnapshot(id) {
      kernel.dropSnapshot(id);
    },
    exportImage: (id) => exportImage(id === null ? kernel.vfs.snapshot() : kernel.getSnapshot(id)),
    usage: () => ({
      ...kernel.vfs.used,
      processes: kernel.processCount,
      persist: persister
        ? {
            generation: persister.stats.generation,
            flushes: persister.stats.flushes,
            lastFlushMs: persister.stats.lastFlushMs,
            bytesWritten: persister.stats.bytesWritten,
            restored: restored !== null,
          }
        : null,
    }),
    flush,
    linkPort(port, channel) {
      if (!Number.isInteger(port) || !(channel instanceof MessagePort))
        throw new SystemError('EINVAL', 'linkPort');
      // A port origin only ever reaches its own port; module routes stay on the instance origin.
      new RpcEndpoint<HttpRpc, Record<string, never>>(channel, {
        fetch: async (req) => transferBody(await router.handle({ ...req, port })),
        upgrade: async (req, socket) => {
          if (socket instanceof MessagePort) router.upgrade({ ...req, port }, socket);
        },
      });
    },
    serveStatic(port, dir) {
      if (typeof dir !== 'string' || !dir.startsWith('/'))
        throw new SystemError('EINVAL', 'listen');
      router.listen(port, staticHandler(kernel.vfs, dir));
    },
    async purge() {
      if (!persister || !store) return;
      persister.close();
      await purgePersisted(store.backend);
    },
    mailboxDeliver(from, fromName, message) {
      if (typeof from !== 'string') throw new SystemError('EINVAL', 'mailbox');
      inbox.deliver({ from, fromName: typeof fromName === 'string' ? fromName : null, message });
    },
    async fetchPort(request) {
      // The controller already routed it here; serve it as a local request.
      const req: WireRequest = { ...request };
      delete req.peer;
      return transferBody(await router.handle(req));
    },
    exportTree(path, snapshot) {
      if (typeof path !== 'string' || !path.startsWith('/'))
        throw new SystemError('EINVAL', 'export');
      const vfs =
        snapshot === null ? kernel.vfs : MemoryVfs.fromSnapshot(kernel.getSnapshot(snapshot));
      return exportTree(vfs, path);
    },
    mountMirror(path, entries) {
      if (typeof path !== 'string' || !path.startsWith('/') || !Array.isArray(entries))
        throw new SystemError('EINVAL', 'mount');
      kernel.mounts.mount(path, entries);
    },
    mirrorUpdate(path, ops) {
      if (typeof path !== 'string' || !Array.isArray(ops)) throw new SystemError('EINVAL', 'mount');
      kernel.mounts.update(path, ops);
    },
    async measureMemory() {
      if (options.measureMemory) {
        const bytes = await options.measureMemory();
        return bytes === null ? null : { bytes };
      }
      const perf = performance as Performance & {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
      };
      if (!perf.measureUserAgentSpecificMemory) return null;
      try {
        return { bytes: (await perf.measureUserAgentSpecificMemory()).bytes };
      } catch {
        return null;
      }
    },
    networkLog: (since) => router.networkLog(typeof since === 'number' ? since : 0),
    unmount(path) {
      if (typeof path !== 'string') throw new SystemError('EINVAL', 'umount');
      kernel.mounts.unmount(path);
    },
    async shutdown() {
      kernel.killAll('SIGKILL');
      for (const stop of watches.values()) stop();
      watches.clear();
      if (persister) {
        await persister.flush().catch(() => {});
        persister.close();
      }
      store?.release();
    },
  };

  return { methods, served: { kernel, flush, attachHttpPort } };
}

/** Streams are transferred to the service worker rather than cloned (they cannot be). */
function transferBody(res: WireResponse): WireResponse {
  return res.body instanceof ReadableStream ? withTransfer(res, [res.body]) : res;
}

function kindOf(mode: number): FileKind {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'file';
  }
}

function toWireStat(s: StatData): WireStat {
  return {
    type: kindOf(s.mode),
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    birthtimeMs: s.birthtimeMs,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
