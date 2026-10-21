// SPDX-License-Identifier: Apache-2.0
import { RpcEndpoint } from '@clientvm/protocol';
import type {
  InstanceEvents,
  InstanceInit,
  InstanceRpc,
  RunResult,
  SpawnRequest,
} from '@clientvm/protocol';
import { connectInstance } from './connect.ts';
import { ClientVMError, NotImplementedError } from './errors.ts';
import { ProcessHandleImpl } from './process.ts';
import type {
  Capability,
  ClientVM,
  DirEntry,
  Disposable,
  ExecOptions,
  ExecResult,
  FileSystem,
  FileTree,
  FsEvent,
  Instance,
  InstanceId,
  InstanceInfo,
  InstanceOptions,
  Mailbox,
  MountSource,
  Process,
  Signal,
  SnapshotId,
  SpawnOptions,
  Stat,
} from './types.ts';
import * as v from './validate.ts';

export interface ClientVMOptions {
  /**
   * Maps an instance id to its origin, e.g. `(id) => \`https://${id}.sandbox.example.dev\``.
   * Each instance must get its own origin: that is the isolation boundary.
   */
  sandboxOrigin: (id: string) => string;
  /** Path of the instance page on each sandbox origin. Default `/__clientvm/instance.html`. */
  instancePath?: string;
  /** Where hidden instance iframes are attached. Default `document.body`. */
  container?: HTMLElement;
  /** Default 15000. */
  bootTimeoutMs?: number;
}

/** Instance ids double as DNS labels: lowercase letters and digits, 1-63 chars. */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => ID_ALPHABET[b & 31]).join('');
}

/** Creates a controller. Call it on the host page; it never runs instance code itself. */
export function createClientVM(options: ClientVMOptions): ClientVM {
  return new Controller(options);
}

/** Options accepted internally by instance creation (adds the fork image). */
type CreateOptions = InstanceOptions & { image?: Uint8Array[] };

class Controller implements ClientVM {
  readonly options: Required<Omit<ClientVMOptions, 'container'>> & { container?: HTMLElement };
  private readonly instances = new Map<InstanceId, InstanceImpl>();

  constructor(options: ClientVMOptions) {
    this.options = {
      instancePath: '/__clientvm/instance.html',
      bootTimeoutMs: 15_000,
      ...options,
    };
  }

  async createInstance(opts: CreateOptions = {}): Promise<Instance> {
    const id = (opts.id ?? randomId()) as InstanceId;
    if (!ID_PATTERN.test(id)) {
      throw new ClientVMError(`invalid instance id "${id}"`, 'ERR_INVALID_ID');
    }
    if (this.instances.has(id))
      throw new ClientVMError(`instance ${id} already exists`, 'ERR_EXISTS');
    const origin = new URL(this.options.sandboxOrigin(id)).origin;

    const init: InstanceInit = { id };
    const limits = {
      ...(opts.fs?.quotaBytes === undefined ? {} : { quotaBytes: opts.fs.quotaBytes }),
      ...(opts.limits?.maxProcesses === undefined
        ? {}
        : { maxProcesses: opts.limits.maxProcesses }),
    };
    if (Object.keys(limits).length > 0) init.limits = limits;
    if (opts.image) {
      init.image = opts.image;
    } else if (typeof opts.fs?.from === 'string') {
      init.image = await this.exportSnapshot(opts.fs.from);
    } else if (opts.fs?.from) {
      init.files = flattenTree(opts.fs.from);
    }

    const { iframe, port } = await connectInstance({
      origin,
      path: this.options.instancePath,
      container: this.options.container ?? document.body,
      timeoutMs: this.options.bootTimeoutMs,
      init,
    });
    const instance = new InstanceImpl(this, id, origin, iframe, port, opts);
    try {
      const pong = await withTimeout(
        instance.rpc.call('ping'),
        this.options.bootTimeoutMs,
        'kernel boot',
      );
      if (pong?.crossOriginIsolated !== true) {
        throw new ClientVMError('instance kernel is not cross-origin isolated', 'ERR_NOT_ISOLATED');
      }
    } catch (err) {
      instance.teardown();
      throw err;
    }
    this.instances.set(id, instance);
    return instance;
  }

  getInstance(id: InstanceId): Instance | undefined {
    return this.instances.get(id);
  }

  listInstances(): InstanceInfo[] {
    return [...this.instances.values()].map((i) => i.info());
  }

  /** @internal */
  forget(id: InstanceId): void {
    this.instances.delete(id);
  }

  private async exportSnapshot(snapshotId: SnapshotId): Promise<Uint8Array[]> {
    const sep = snapshotId.lastIndexOf(':');
    const source = this.instances.get(snapshotId.slice(0, sep) as InstanceId);
    const n = Number(snapshotId.slice(sep + 1));
    if (!source || sep < 0 || !Number.isSafeInteger(n)) {
      throw new ClientVMError(`unknown snapshot ${snapshotId}`, 'ERR_NO_SNAPSHOT');
    }
    return v.chunks(await source.rpc.call('exportImage', n));
  }
}

class InstanceImpl implements Instance {
  readonly id: InstanceId;
  readonly origin: string;
  readonly fs: FileSystem;
  readonly mailbox: Mailbox;
  /** @internal */
  readonly rpc: RpcEndpoint<InstanceEvents, InstanceRpc>;

  private readonly controller: Controller;
  private readonly iframe: HTMLIFrameElement;
  private readonly port: MessagePort;
  private readonly opts: InstanceOptions;
  private readonly createdAt = Date.now();
  private readonly processes = new Map<number, ProcessHandleImpl>();
  private readonly watchers = new Map<number, (e: FsEvent) => void>();
  private destroyed = false;

  constructor(
    controller: Controller,
    id: InstanceId,
    origin: string,
    iframe: HTMLIFrameElement,
    port: MessagePort,
    opts: InstanceOptions,
  ) {
    this.controller = controller;
    this.id = id;
    this.origin = origin;
    this.iframe = iframe;
    this.port = port;
    this.opts = opts;
    this.rpc = new RpcEndpoint<InstanceEvents, InstanceRpc>(port, {
      output: (pid, fd, data) => {
        if ((fd === 1 || fd === 2) && v.isUint8Array(data))
          this.processes.get(pid)?.deliverOutput(fd, data);
      },
      exit: (pid, code, signal) => {
        const proc = this.processes.get(pid);
        if (!proc || typeof code !== 'number') return;
        this.processes.delete(pid);
        proc.deliverExit(code, isSignal(signal) ? signal : null);
      },
      fsEvents: (watchId, events) => {
        const cb = this.watchers.get(watchId);
        const parsed = v.fsEvents(events);
        if (cb && parsed) for (const e of parsed) cb(e);
      },
    });
    this.fs = new InstanceFs(this);
    this.mailbox = {
      send: () => Promise.reject(new NotImplementedError('mailbox')),
      onMessage: () => {
        throw new NotImplementedError('mailbox');
      },
    };
  }

  info(): InstanceInfo {
    return {
      id: this.id,
      ...(this.opts.name === undefined ? {} : { name: this.opts.name }),
      ...(this.opts.parent === undefined ? {} : { parent: this.opts.parent }),
      origin: this.origin,
      processCount: this.processes.size,
      createdAt: this.createdAt,
    };
  }

  async spawn(cmd: string, args: string[] = [], opts: SpawnOptions = {}): Promise<Process> {
    this.assertAlive();
    const request: SpawnRequest = {
      argv: [cmd, ...args],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
    const pid = await this.rpc.call('spawn', request);
    if (!v.isPid(pid))
      throw new ClientVMError('instance sent a malformed pid', 'ERR_INSTANCE_PROTOCOL');
    const proc = new ProcessHandleImpl(pid, (signal) => this.rpc.call('kill', pid, signal));
    this.processes.set(pid, proc);
    return proc;
  }

  /**
   * @internal Runs a process to completion inside the kernel and returns its
   * output and kernel-side timing. For tests and benchmarks; not public API.
   */
  debugRun(request: SpawnRequest): Promise<RunResult> {
    this.assertAlive();
    return this.rpc.call('run', request);
  }

  exec(_commandLine: string, _opts?: ExecOptions): Promise<ExecResult> {
    return Promise.reject(new NotImplementedError('exec (needs the shell, Phase 3)'));
  }

  onPortOpen(_cb: (port: number, url: string) => void): Disposable {
    throw new NotImplementedError('onPortOpen (Phase 3)');
  }

  async snapshot(): Promise<SnapshotId> {
    this.assertAlive();
    const n = v.int(await this.rpc.call('snapshot'), 'snapshot id');
    return `${this.id}:${n}` as SnapshotId;
  }

  async fork(opts: InstanceOptions = {}): Promise<Instance> {
    this.assertAlive();
    const image = v.chunks(await this.rpc.call('exportImage', null));
    return this.controller.createInstance({ ...opts, parent: this.id, image } as CreateOptions);
  }

  grant(_to: InstanceId, _cap: Capability): Promise<void> {
    return Promise.reject(new NotImplementedError('capability grants (Phase 4)'));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await withTimeout(this.rpc.call('shutdown'), 2000, 'shutdown').catch(() => {});
    this.teardown();
  }

  /** @internal Removes the iframe and settles anything still pending. */
  teardown(): void {
    this.destroyed = true;
    for (const proc of this.processes.values()) proc.deliverExit(137, 'SIGKILL');
    this.processes.clear();
    this.watchers.clear();
    this.port.close();
    this.iframe.remove();
    this.controller.forget(this.id);
  }

  /** @internal */
  addWatcher(id: number, cb: (e: FsEvent) => void): void {
    this.watchers.set(id, cb);
  }

  /** @internal */
  removeWatcher(id: number): void {
    this.watchers.delete(id);
  }

  /** @internal */
  assertAlive(): void {
    if (this.destroyed)
      throw new ClientVMError(`instance ${this.id} was destroyed`, 'ERR_DESTROYED');
  }
}

class InstanceFs implements FileSystem {
  private readonly instance: InstanceImpl;

  constructor(instance: InstanceImpl) {
    this.instance = instance;
  }

  private get rpc() {
    this.instance.assertAlive();
    return this.instance.rpc;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return v.bytes(await this.rpc.call('readFile', path), 'file');
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.rpc.call('writeFile', path, data);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return v.dirEntries(await this.rpc.call('readdir', path));
  }

  async stat(path: string): Promise<Stat> {
    return v.stat(await this.rpc.call('stat', path));
  }

  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.rpc.call('mkdir', path, opts.recursive === true);
  }

  async rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.rpc.call('rm', path, opts.recursive === true, opts.force === true);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.rpc.call('rename', from, to);
  }

  async symlink(target: string, path: string): Promise<void> {
    await this.rpc.call('symlink', target, path);
  }

  watch(path: string, cb: (e: FsEvent) => void): Disposable {
    let disposed = false;
    let watchId: number | undefined;
    const rpc = this.rpc;
    void rpc.call('watch', path, true).then((id) => {
      watchId = v.int(id, 'watch id');
      if (disposed) void rpc.call('unwatch', watchId).catch(() => {});
      else this.instance.addWatcher(watchId, cb);
    });
    return {
      dispose: () => {
        disposed = true;
        if (watchId === undefined) return;
        this.instance.removeWatcher(watchId);
        void rpc.call('unwatch', watchId).catch(() => {});
      },
    };
  }

  mount(_path: string, _source: MountSource): Promise<void> {
    return Promise.reject(new NotImplementedError('mounts (Phase 4)'));
  }
}

function isSignal(s: unknown): s is Signal {
  return s === 'SIGTERM' || s === 'SIGKILL' || s === 'SIGINT' || s === 'SIGHUP';
}

function flattenTree(tree: FileTree, prefix = ''): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {};
  for (const [name, value] of Object.entries(tree)) {
    if (name === '' || name.includes('/') || name === '.' || name === '..') {
      throw new ClientVMError(`invalid file name "${name}" in file tree`, 'ERR_INVALID_TREE');
    }
    const path = `${prefix}/${name}`;
    if (typeof value === 'string' || value instanceof Uint8Array) out[path] = value;
    else Object.assign(out, flattenTree(value, path));
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ClientVMError(`${what} timed out after ${ms} ms`, 'ERR_TIMEOUT')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
