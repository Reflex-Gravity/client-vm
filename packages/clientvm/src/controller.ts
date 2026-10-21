// SPDX-License-Identifier: Apache-2.0
import {
  MAILBOX_HOST,
  PORT_BRIDGE_PATH,
  RpcEndpoint,
  portLabel,
  withTransfer,
} from '@clientvm/protocol';
import type {
  ControllerRpc,
  InstanceEvents,
  InstanceInit,
  InstanceRpc,
  RunResult,
  MirrorOp,
  SpawnRequest,
  TreeEntry,
  WireRequest,
  WireResponse,
} from '@clientvm/protocol';
import { CapabilityTable, parseCapability, subjectOf } from './capabilities.ts';
import { connectInstance, connectPortBridge } from './connect.ts';
import { ClientVMError } from './errors.ts';
import { PreviewImpl } from './preview.ts';
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
  NetworkLogEntry,
  Preview,
  PreviewOptions,
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

/**
 * Instance ids double as DNS labels: lowercase letters, digits and hyphens.
 * At most 56 characters so port origins (`<id>-p65535`) fit in a 63-character
 * label; ids may not end in `-p<digits>` so they never collide with one.
 */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;
const PORT_SUFFIX = /-p\d+$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => ID_ALPHABET[b & 31]).join('');
}

/** Creates a controller. Call it on the host page; it never runs instance code itself. */
export function createClientVM(options: ClientVMOptions): ClientVM {
  return new Controller(options);
}

/** Options accepted internally by instance creation (adds the fork image and granting parent). */
type CreateOptions = InstanceOptions & { image?: Uint8Array[]; grantedBy?: InstanceId };

const MAX_MESSAGE_BYTES = 1 << 20;

class Controller implements ClientVM {
  readonly options: Required<Omit<ClientVMOptions, 'container'>> & { container?: HTMLElement };
  private readonly instances = new Map<InstanceId, InstanceImpl>();
  private readonly names = new Map<string, InstanceId>();
  /** @internal */
  readonly caps = new CapabilityTable();

  constructor(options: ClientVMOptions) {
    this.options = {
      instancePath: '/__clientvm/instance.html',
      bootTimeoutMs: 15_000,
      ...options,
    };
  }

  async createInstance(opts: CreateOptions = {}): Promise<Instance> {
    const id = (opts.id ?? randomId()) as InstanceId;
    if (!ID_PATTERN.test(id) || PORT_SUFFIX.test(id)) {
      throw new ClientVMError(`invalid instance id "${id}"`, 'ERR_INVALID_ID');
    }
    if (this.instances.has(id) || this.names.has(id))
      throw new ClientVMError(`instance ${id} already exists`, 'ERR_EXISTS');
    const name = opts.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !ID_PATTERN.test(name) || name === MAILBOX_HOST) {
        throw new ClientVMError(`invalid instance name "${String(name)}"`, 'ERR_INVALID_ID');
      }
      if (this.names.has(name) || this.instances.has(name as InstanceId) || name === id)
        throw new ClientVMError(`an instance named ${name} already exists`, 'ERR_EXISTS');
    }
    const capabilities = (opts.capabilities ?? []).map(parseCapability);
    if (opts.grantedBy !== undefined) {
      for (const cap of capabilities) {
        if (!this.caps.canGrant(opts.grantedBy, cap))
          throw noCapability(`${opts.grantedBy} cannot give its child a ${cap.kind} capability`);
      }
    }
    const origin = new URL(this.options.sandboxOrigin(id)).origin;

    const init: InstanceInit = { id, ...(name === undefined ? {} : { name }) };
    const limits = {
      ...(opts.fs?.quotaBytes === undefined ? {} : { quotaBytes: opts.fs.quotaBytes }),
      ...(opts.limits?.maxProcesses === undefined
        ? {}
        : { maxProcesses: opts.limits.maxProcesses }),
    };
    if (Object.keys(limits).length > 0) init.limits = limits;
    if (opts.fs?.persist) init.persist = true;
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
    if (name !== undefined) this.names.set(name, id);
    for (const cap of capabilities) this.caps.grant(id, cap);
    return instance;
  }

  grant(to: InstanceId, cap: Capability): void {
    if (!this.instances.has(to)) throw noInstance(to);
    this.caps.grant(to, parseCapability(cap));
  }

  revoke(to: InstanceId, cap: Capability): boolean {
    return this.caps.revoke(to, parseCapability(cap));
  }

  /** @internal An instance by id or name. */
  resolve(nameOrId: string): InstanceImpl | undefined {
    return (
      this.instances.get(nameOrId as InstanceId) ??
      this.instances.get(this.names.get(nameOrId) ?? ('' as InstanceId))
    );
  }

  /** @internal Delivers `message` from `sender` to `to` if `sender` holds a channel to it. */
  mailboxSend(sender: InstanceImpl, to: unknown, message: unknown): void {
    if (typeof to !== 'string')
      throw new ClientVMError('mailbox: bad recipient', 'ERR_INVALID_MESSAGE');
    const target = this.resolve(to);
    if (!target) throw noInstance(to);
    if (!this.caps.has(sender.id, { kind: 'channel', peer: target.id }))
      throw noCapability(`${sender.label} has no channel capability for ${to}`);
    let json: string | undefined;
    try {
      json = JSON.stringify(message);
    } catch {
      json = undefined;
    }
    if (json === undefined)
      throw new ClientVMError('mailbox: messages must be JSON values', 'ERR_INVALID_MESSAGE');
    if (json.length > MAX_MESSAGE_BYTES)
      throw new ClientVMError('mailbox: message larger than 1 MiB', 'ERR_INVALID_MESSAGE');
    // A fresh copy: the recipient never shares objects with the sender.
    target.deliverMail(sender, JSON.parse(json));
  }

  /** @internal Forwards `request` from `sender` to `http://<peer>.internal:<port>/`. */
  async netFetch(sender: InstanceImpl, peer: unknown, request: unknown): Promise<WireResponse> {
    if (typeof peer !== 'string') throw noInstance(String(peer));
    const target = this.resolve(peer);
    if (!target) throw noInstance(peer);
    const req: WireRequest = v.wireRequest(request);
    const port = req.port ?? 80;
    if (!this.caps.has(sender.id, { kind: 'net', peer: target.id, ports: [port] }))
      throw noCapability(`${sender.label} has no net capability for ${peer}:${port}`);
    const res = v.wireResponse(
      await target.rpc.call('fetchPort', { ...req, port, from: sender.id }),
    );
    return res.body instanceof ReadableStream ? withTransfer(res, [res.body]) : res;
  }

  getInstance(id: InstanceId): Instance | undefined {
    return this.instances.get(id);
  }

  listInstances(): InstanceInfo[] {
    return [...this.instances.values()].map((i) => i.info());
  }

  /** @internal */
  forget(id: InstanceId): void {
    const instance = this.instances.get(id);
    this.instances.delete(id);
    if (instance?.name !== undefined) this.names.delete(instance.name);
    this.caps.drop(id);
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
  readonly name?: string;
  readonly origin: string;
  readonly fs: FileSystem;
  readonly mailbox: Mailbox;
  /** @internal */
  readonly rpc: RpcEndpoint<InstanceEvents & ControllerRpc, InstanceRpc>;

  private readonly controller: Controller;
  private readonly iframe: HTMLIFrameElement;
  private readonly port: MessagePort;
  private readonly opts: InstanceOptions;
  private readonly createdAt = Date.now();
  private readonly processes = new Map<number, ProcessHandleImpl>();
  private readonly watchers = new Map<number, (e: FsEvent) => void>();
  private readonly openPorts = new Map<number, string>();
  private readonly portListeners = new Set<(port: number, url: string) => void>();
  private readonly portCloseListeners = new Set<(port: number) => void>();
  private readonly mailListeners = new Set<(from: InstanceId, msg: unknown) => void>();
  private readonly previews = new Set<PreviewImpl>();
  /** Mounts by path: stops the source watch. */
  private readonly mounts = new Map<string, () => void>();
  /** Bridge iframe per port origin (null while linking). */
  private readonly portBridges = new Map<number, HTMLIFrameElement | null>();
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
    if (opts.name !== undefined) this.name = opts.name;
    this.rpc = new RpcEndpoint<InstanceEvents & ControllerRpc, InstanceRpc>(port, {
      // Requests from the kernel run with this instance's capabilities.
      mailboxSend: (to, message) => controller.mailboxSend(this, to, message),
      netFetch: (peer, request) => controller.netFetch(this, peer, request),
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
      portOpen: (port) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535 || this.portBridges.has(port))
          return;
        this.portBridges.set(port, null);
        void this.openPortOrigin(port);
      },
      portClose: (port) => {
        if (!this.portBridges.has(port)) return;
        this.portBridges.get(port)?.remove();
        this.portBridges.delete(port);
        if (this.openPorts.delete(port)) for (const cb of this.portCloseListeners) cb(port);
      },
    });
    this.fs = new InstanceFs(this);
    this.mailbox = {
      send: async (to, msg) => {
        this.assertAlive();
        controller.mailboxSend(this, to, msg);
      },
      onMessage: (cb) => {
        this.mailListeners.add(cb);
        return { dispose: () => void this.mailListeners.delete(cb) };
      },
    };
  }

  /** @internal How errors name this instance. */
  get label(): string {
    return this.name ?? this.id;
  }

  /** @internal Puts a message in this instance's inbox and tells host listeners. */
  deliverMail(sender: InstanceImpl, message: unknown): void {
    void this.rpc.call('mailboxDeliver', sender.id, sender.name ?? null, message).catch(() => {});
    for (const cb of this.mailListeners) cb(sender.id, message);
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

  /**
   * Runs a command line through `sh -c` to completion and returns its output.
   * `timeoutMs` sends SIGTERM to the shell and everything it started.
   */
  async exec(commandLine: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    if (typeof commandLine !== 'string') throw new TypeError('commandLine must be a string');
    const request: SpawnRequest = {
      argv: ['sh', '-c', commandLine],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    };
    const r = v.runResult(await this.rpc.call('run', request));
    return {
      code: r.code,
      ...(r.signal ? { signal: r.signal } : {}),
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }

  /**
   * Calls `cb` for every virtual port that is open now and opens later, with
   * the URL that reaches it: the port's own origin,
   * `https://<id>-p<port>.<sandbox-domain>/` (ADR 0008). Load the URL in an
   * iframe to preview it.
   */
  onPortOpen(cb: (port: number, url: string) => void): Disposable {
    this.portListeners.add(cb);
    for (const [port, url] of this.openPorts) cb(port, url);
    return { dispose: () => void this.portListeners.delete(cb) };
  }

  /** Calls `cb` when a port reported by {@link onPortOpen} stops listening. */
  onPortClose(cb: (port: number) => void): Disposable {
    this.portCloseListeners.add(cb);
    return { dispose: () => void this.portCloseListeners.delete(cb) };
  }

  async openPreview(port: number, opts: PreviewOptions = {}): Promise<Preview> {
    this.assertAlive();
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new ClientVMError(`invalid port ${String(port)}`, 'ERR_INVALID_PORT');
    let url = this.openPorts.get(port);
    if (url === undefined) {
      url = await withTimeout(
        new Promise<string>((resolve) => {
          const sub = this.onPortOpen((p, u) => {
            if (p !== port) return;
            queueMicrotask(() => sub.dispose());
            resolve(u);
          });
        }),
        this.controller.options.bootTimeoutMs,
        `waiting for port ${port}`,
      );
    }
    const preview = new PreviewImpl(
      new URL(opts.path ?? '/', url).href,
      opts.container ?? this.controller.options.container ?? document.body,
      opts,
    );
    this.previews.add(preview);
    return preview;
  }

  async networkLog(since = 0): Promise<NetworkLogEntry[]> {
    this.assertAlive();
    return v.networkLog(await this.rpc.call('networkLog', since));
  }

  /** Embeds the bridge page on the port's origin and links its service worker to the kernel. */
  private async openPortOrigin(port: number): Promise<void> {
    const options = this.controller.options;
    const origin = new URL(options.sandboxOrigin(portLabel(this.id, port))).origin;
    let iframe: HTMLIFrameElement;
    try {
      iframe = await connectPortBridge({
        origin,
        path: PORT_BRIDGE_PATH,
        port,
        container: options.container ?? document.body,
        timeoutMs: options.bootTimeoutMs,
        link: (channel) => this.rpc.callTransfer('linkPort', [port, channel], [channel]),
      });
    } catch {
      this.portBridges.delete(port);
      return;
    }
    if (this.destroyed || !this.portBridges.has(port)) {
      iframe.remove();
      return;
    }
    this.portBridges.set(port, iframe);
    const url = `${origin}/`;
    this.openPorts.set(port, url);
    for (const cb of this.portListeners) cb(port, url);
  }

  /**
   * @internal Serves a VFS directory on a virtual port. A stand-in until
   * `http.createServer` exists (Phase 3); for tests and demos.
   */
  async debugServeStatic(port: number, dir: string): Promise<void> {
    this.assertAlive();
    await this.rpc.call('serveStatic', port, dir);
  }

  async snapshot(): Promise<SnapshotId> {
    this.assertAlive();
    const n = v.int(await this.rpc.call('snapshot'), 'snapshot id');
    return `${this.id}:${n}` as SnapshotId;
  }

  /**
   * Copies this instance's filesystem into a new child instance. Needs a
   * `spawn-instance` capability; the child's limits default to (and may not
   * exceed) the capability's.
   */
  async fork(opts: InstanceOptions = {}): Promise<Instance> {
    this.assertAlive();
    const childOpts = this.childOptions(opts);
    const image = v.chunks(await this.rpc.call('exportImage', null));
    return this.controller.createInstance({ ...childOpts, image } as CreateOptions);
  }

  /** @internal Checks `spawn-instance` and applies its limits to a child's options. */
  childOptions(opts: InstanceOptions): CreateOptions {
    const held = this.controller.caps.list(this.id).filter((c) => c.kind === 'spawn-instance');
    if (held.length === 0) throw noCapability(`${this.label} has no spawn-instance capability`);
    const wanted = {
      ...(opts.limits?.maxProcesses === undefined
        ? {}
        : { maxProcesses: opts.limits.maxProcesses }),
      ...(opts.fs?.quotaBytes === undefined ? {} : { quotaBytes: opts.fs.quotaBytes }),
    };
    const cap = held.find((c) =>
      this.controller.caps.has(this.id, {
        kind: 'spawn-instance',
        limits: { ...c.limits, ...wanted },
      }),
    );
    if (!cap) throw noCapability(`${this.label} cannot create a child with those limits`);
    const limits = { ...cap.limits, ...wanted };
    return {
      ...opts,
      parent: this.id,
      grantedBy: this.id,
      ...(limits.maxProcesses === undefined
        ? {}
        : { limits: { ...opts.limits, maxProcesses: limits.maxProcesses } }),
      ...(limits.quotaBytes === undefined
        ? {}
        : { fs: { ...opts.fs, quotaBytes: limits.quotaBytes } }),
    };
  }

  /** @internal See {@link FileSystem.mount}. */
  async mountFrom(path: string, source: MountSource): Promise<void> {
    this.assertAlive();
    if (typeof path !== 'string' || !path.startsWith('/'))
      throw new ClientVMError('mount path must be absolute', 'ERR_INVALID_PATH');
    const root = normalizePath(path);
    if (this.mounts.has(root)) throw new ClientVMError(`${root} is already a mount`, 'ERR_EXISTS');
    let src: InstanceImpl | undefined;
    let srcPath = '/';
    let snapshot: number | null = null;
    if (source?.kind === 'instance') {
      if (source.readOnly !== true)
        throw new ClientVMError('only read-only mounts are supported', 'ERR_NOT_SUPPORTED');
      src = this.controller.resolve(source.from);
      srcPath = source.path;
    } else if (source?.kind === 'snapshot') {
      const id = String(source.snapshot);
      const sep = id.lastIndexOf(':');
      src = this.controller.resolve(id.slice(0, sep));
      snapshot = Number(id.slice(sep + 1));
      if (sep < 0 || !Number.isSafeInteger(snapshot))
        throw new ClientVMError(`unknown snapshot ${id}`, 'ERR_NO_SNAPSHOT');
    } else {
      throw new ClientVMError('invalid mount source', 'ERR_INVALID_MOUNT');
    }
    if (!src) throw noInstance(source.kind === 'instance' ? source.from : String(source.snapshot));
    const cap = parseCapability({ kind: 'mount', from: src.id, path: srcPath, readOnly: true });
    const from = (cap as { path: string }).path;
    if (!this.controller.caps.has(this.id, cap))
      throw noCapability(`${this.label} has no mount capability for ${src.label}:${from}`);
    const entries = await src.rpc.call('exportTree', from, snapshot);
    if (!Array.isArray(entries))
      throw new ClientVMError('instance sent a malformed tree', 'ERR_INSTANCE_PROTOCOL');
    await this.rpc.call('mountMirror', root, entries as TreeEntry[]);
    if (snapshot !== null) {
      this.mounts.set(root, () => {});
      return;
    }
    this.mounts.set(root, this.mirror(src, from, root, cap));
  }

  /** Keeps a mount in step with its source; returns a function that stops it. */
  private mirror(src: InstanceImpl, srcRoot: string, root: string, cap: Capability): () => void {
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain = Promise.resolve();
    let stopped = false;
    const inside = (p: string) => srcRoot === '/' || p === srcRoot || p.startsWith(`${srcRoot}/`);
    const relOf = (p: string) =>
      p === srcRoot ? '' : p.slice(srcRoot === '/' ? 1 : srcRoot.length + 1);
    const flush = async () => {
      if (stopped || this.destroyed) return;
      // A revoked capability (or a vanished source) ends the sync; the copy stays.
      if (!this.controller.caps.has(this.id, cap)) return stop();
      const paths = [...changed].sort();
      changed.clear();
      const ops: MirrorOp[] = [];
      for (const p of paths) {
        if (!inside(p) || paths.some((q) => q !== p && p.startsWith(`${q}/`))) continue;
        try {
          const entries = await src.rpc.call('exportTree', p, null);
          if (Array.isArray(entries)) ops.push({ op: 'put', at: relOf(p), entries });
        } catch {
          ops.push({ op: 'delete', at: relOf(p) });
        }
      }
      if (ops.length > 0) await this.rpc.call('mirrorUpdate', root, ops).catch(() => {});
    };
    const sub = src.fs.watch(srcRoot, (e) => {
      if (e.type === 'rename') {
        changed.add(e.from);
        changed.add(e.to);
      } else {
        changed.add(e.path);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        chain = chain.then(flush, flush);
      }, 20);
    });
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      sub.dispose();
    };
    return stop;
  }

  /** @internal See {@link FileSystem.unmount}. */
  async unmountAt(path: string): Promise<void> {
    this.assertAlive();
    const root = normalizePath(String(path));
    const stop = this.mounts.get(root);
    if (!stop) throw new ClientVMError(`${root} is not a mount`, 'ERR_INVALID_PATH');
    stop();
    this.mounts.delete(root);
    await this.rpc.call('unmount', root);
  }

  async grant(to: InstanceId, cap: Capability): Promise<void> {
    this.assertAlive();
    const parsed = parseCapability(cap);
    if (!this.controller.getInstance(to)) throw noInstance(to);
    if (!this.controller.caps.canGrant(this.id, parsed))
      throw noCapability(`${this.label} cannot grant this ${parsed.kind} capability`);
    this.controller.caps.grant(to, parsed);
  }

  async revoke(to: InstanceId, cap: Capability): Promise<void> {
    this.assertAlive();
    const parsed = parseCapability(cap);
    if (subjectOf(parsed) !== this.id)
      throw noCapability(`${this.label} can only revoke capabilities about itself`);
    this.controller.caps.revoke(to, parsed);
  }

  capabilities(): Capability[] {
    return this.controller.caps.list(this.id);
  }

  async flush(): Promise<void> {
    this.assertAlive();
    await this.rpc.call('flush');
  }

  async destroy(opts: { purge?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    try {
      if (opts.purge) await this.rpc.call('purge');
      await withTimeout(this.rpc.call('shutdown'), 10_000, 'shutdown');
    } finally {
      this.teardown();
    }
  }

  /** @internal Removes the iframe and settles anything still pending. */
  teardown(): void {
    this.destroyed = true;
    for (const proc of this.processes.values()) proc.deliverExit(137, 'SIGKILL');
    this.processes.clear();
    this.watchers.clear();
    this.portListeners.clear();
    this.portCloseListeners.clear();
    this.mailListeners.clear();
    for (const stop of this.mounts.values()) stop();
    this.mounts.clear();
    for (const preview of this.previews) preview.close();
    this.previews.clear();
    for (const bridge of this.portBridges.values()) bridge?.remove();
    this.portBridges.clear();
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

  mount(path: string, source: MountSource): Promise<void> {
    return this.instance.mountFrom(path, source);
  }

  unmount(path: string): Promise<void> {
    return this.instance.unmountAt(path);
  }
}

function isSignal(s: unknown): s is Signal {
  return s === 'SIGTERM' || s === 'SIGKILL' || s === 'SIGINT' || s === 'SIGHUP' || s === 'SIGPIPE';
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

function noCapability(message: string): ClientVMError {
  return new ClientVMError(message, 'ERR_NO_CAPABILITY');
}

function noInstance(nameOrId: string): ClientVMError {
  return new ClientVMError(`no instance named ${nameOrId}`, 'ERR_NO_INSTANCE');
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}
