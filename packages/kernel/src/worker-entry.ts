// SPDX-License-Identifier: Apache-2.0
import { RpcEndpoint, SystemError, decodeUtf8, encodeUtf8 } from '@clientvm/protocol';
import type {
  FileKind,
  HttpRpc,
  InstanceEvents,
  InstanceInit,
  InstanceRpc,
  PortLike,
  SpawnRequest,
  StatData,
  WireStat,
} from '@clientvm/protocol';
import {
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
import { Kernel } from './kernel.ts';
import type { KernelOptions, ProcessHandle } from './kernel.ts';

/** Sent by the instance page to its kernel worker once the controller has connected. */
export interface KernelBootMessage {
  t: 'clientvm:kernel-boot';
  init: InstanceInit;
  /** The controller's end of the RPC channel. */
  port: MessagePort;
}

export type KernelWorkerOptions = Pick<KernelOptions, 'createProcessWorker' | 'payloadBytes'> & {
  /**
   * Opens the persistent store for `init.persist`. Defaults to the instance
   * origin's OPFS, guarded by a Web Lock so only one tab owns it.
   */
  openPersistence?: () => Promise<{ backend: PersistenceBackend; release(): void }>;
};

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
  let rpc: RpcEndpoint<InstanceRpc, InstanceEvents>;
  const ready = boot(init, options, (event, ...args) => rpc.emit(event, ...args)).then((booted) => {
    methods = booted.methods;
    return booted.served;
  });
  const gated = new Proxy({} as InstanceRpc, {
    get:
      (_target, name: string) =>
      async (...args: unknown[]) => {
        await ready;
        const method = (methods as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
        if (!method) throw new SystemError('ENOSYS', name);
        return method(...args);
      },
  });
  rpc = new RpcEndpoint<InstanceRpc, InstanceEvents>(port, gated);
  return ready;
}

type Emit = <K extends keyof InstanceEvents>(
  event: K,
  ...args: Parameters<InstanceEvents[K]>
) => void;

async function boot(
  init: InstanceInit,
  options: KernelWorkerOptions,
  emit: Emit,
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

  const { quotaBytes, maxInodes, maxProcesses } = init.limits ?? {};
  const kernel = new Kernel({
    createProcessWorker: options.createProcessWorker,
    ...(options.payloadBytes === undefined ? {} : { payloadBytes: options.payloadBytes }),
    fsLimits: {
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      ...(maxInodes === undefined ? {} : { maxInodes }),
    },
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
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

  // Ports are announced only once a service worker link exists, so a preview
  // iframe opened in response always reaches the kernel.
  let httpLinked = false;
  const router = new HttpRouter((port, primary) => {
    if (httpLinked) emit('portOpen', port, primary);
  });
  const attachHttpPort = (port: MessagePort) => {
    new RpcEndpoint<HttpRpc, Record<string, never>>(port, { fetch: (req) => router.handle(req) });
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
    const proc = kernel.spawn(request.argv, {
      ...(request.env ? { env: request.env } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.syscallMode ? { syscallMode: request.syscallMode } : {}),
      onStdout: (d) => (onOutput ? onOutput(1, d) : emit('output', proc.pid, 1, d)),
      onStderr: (d) => (onOutput ? onOutput(2, d) : emit('output', proc.pid, 2, d)),
    });
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
    async run(request) {
      const out: Uint8Array[] = [];
      const err: Uint8Array[] = [];
      const proc = spawn(request, (fd, d) => (fd === 1 ? out : err).push(d));
      const { code, signal } = await proc.exit;
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
