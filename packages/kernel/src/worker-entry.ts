// SPDX-License-Identifier: Apache-2.0
import { RpcEndpoint, SystemError, decodeUtf8, encodeUtf8 } from '@clientvm/protocol';
import type {
  FileKind,
  InstanceEvents,
  InstanceInit,
  InstanceRpc,
  PortLike,
  SpawnRequest,
  StatData,
  WireStat,
} from '@clientvm/protocol';
import { S_IFDIR, S_IFLNK, S_IFMT, exportImage } from '@clientvm/vfs';
import { Kernel } from './kernel.ts';
import type { KernelOptions, ProcessHandle } from './kernel.ts';

/** Sent by the instance page to its kernel worker once the controller has connected. */
export interface KernelBootMessage {
  t: 'clientvm:kernel-boot';
  init: InstanceInit;
  /** The controller's end of the RPC channel. */
  port: MessagePort;
}

export type KernelWorkerOptions = Pick<KernelOptions, 'createProcessWorker' | 'payloadBytes'>;

/**
 * Entry point for an instance's kernel worker: waits for the boot message,
 * then serves {@link InstanceRpc} to the controller on the transferred port.
 */
export function startKernelWorker(
  scope: { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void },
  options: KernelWorkerOptions,
): void {
  let booted = false;
  scope.addEventListener('message', (event) => {
    const msg = event.data as Partial<KernelBootMessage> | null;
    if (booted || msg?.t !== 'clientvm:kernel-boot' || !msg.init || !msg.port) return;
    booted = true;
    serveInstance(msg.port, msg.init, options);
  });
}

/** Boots a kernel for `init` and serves it on `port`. Exported for tests. */
export function serveInstance(
  port: PortLike,
  init: InstanceInit,
  options: KernelWorkerOptions,
): Kernel {
  const { quotaBytes, maxInodes, maxProcesses } = init.limits ?? {};
  const kernel = new Kernel({
    ...options,
    fsLimits: {
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      ...(maxInodes === undefined ? {} : { maxInodes }),
    },
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    ...(init.image ? { image: init.image } : {}),
  });
  for (const [path, contents] of Object.entries(init.files ?? {})) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) kernel.vfs.mkdir(dir, { recursive: true });
    kernel.vfs.writeFile(path, typeof contents === 'string' ? encodeUtf8(contents) : contents);
  }

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
      onStdout: (d) => (onOutput ? onOutput(1, d) : rpc.emit('output', proc.pid, 1, d)),
      onStderr: (d) => (onOutput ? onOutput(2, d) : rpc.emit('output', proc.pid, 2, d)),
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
        kernel.vfs.watch(path, { recursive }, (events) => rpc.emit('fsEvents', id, events)),
      );
      return id;
    },
    unwatch(id) {
      watches.get(id)?.();
      watches.delete(id);
    },
    spawn(request) {
      const proc = spawn(request);
      void proc.exit.then(({ code, signal }) => rpc.emit('exit', proc.pid, code, signal));
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
    usage: () => ({ ...kernel.vfs.used, processes: kernel.processCount }),
    shutdown() {
      kernel.killAll('SIGKILL');
      for (const stop of watches.values()) stop();
      watches.clear();
    },
  };

  const rpc = new RpcEndpoint<InstanceRpc, InstanceEvents>(port, methods);
  return kernel;
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
