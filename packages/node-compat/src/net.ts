// SPDX-License-Identifier: Apache-2.0
// `net`: servers listen on the instance's virtual ports and sockets carry
// bytes through the kernel. There is no real TCP: only processes (and
// previews, through the service worker) inside the same instance can connect.

import type { ProcessContext } from '@clientvm/process';
import type { KernelToProcess, NetToProcess } from '@clientvm/protocol';
import { Buffer } from './buffer.ts';
import type { EventLoop, Handle } from './event-loop.ts';
import { EventEmitter } from './events.ts';

type Duplex = EventEmitter & {
  push(chunk: unknown): boolean;
  destroy(err?: Error): unknown;
  destroyed: boolean;
  writable: boolean;
  readable: boolean;
  end(...args: unknown[]): unknown;
  write(...args: unknown[]): boolean;
};
type DuplexCtor = new (opts?: object) => Duplex;

export interface NetDeps {
  ctx: ProcessContext;
  loop: EventLoop;
  stream: () => { Duplex: DuplexCtor };
}

const ERRNO: Record<string, number> = {
  EADDRINUSE: -98,
  EADDRNOTAVAIL: -99,
  ECONNREFUSED: -111,
  ECONNRESET: -104,
  EINVAL: -22,
  ENOSYS: -38,
  ENOTFOUND: -3008,
  EACCES: -13,
};

/** Node-shaped network error, e.g. `connect ECONNREFUSED 127.0.0.1:3000`. */
export function netError(code: string, syscall: string, address?: string, port?: number): Error {
  const where = address === undefined ? '' : ` ${address}${port === undefined ? '' : `:${port}`}`;
  const err = new Error(`${syscall} ${code}${where}`) as Error & Record<string, unknown>;
  err['errno'] = ERRNO[code] ?? -5;
  err['code'] = code;
  err['syscall'] = syscall;
  if (address !== undefined) err['address'] = address;
  if (port !== undefined) err['port'] = port;
  return err;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::', '']);

/** True for hostnames that mean "this machine" (the instance). */
export const isLocalHost = (host: string | undefined | null): boolean =>
  LOCAL_HOSTS.has((host ?? '').toLowerCase());

/**
 * Maps a URL that targets this instance (`http://localhost:3000/x`) to the
 * instance origin path the service worker routes to that port.
 */
export function virtualUrl(url: string | URL): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLocalHost(u.hostname)) return null;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const origin = (globalThis as { location?: { origin: string } }).location?.origin ?? '';
  return `${origin}/__port/${port}${u.pathname}${u.search}`;
}

export function isIPv4(s: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
}

export function isIPv6(s: string): boolean {
  if (!s.includes(':') || !/^[0-9a-fA-F:.]+$/.test(s)) return false;
  const parts = s.split('::');
  if (parts.length > 2) return false;
  const groups = s.split(':').filter((g) => g !== '');
  if (groups.some((g) => g.length > 4 && !isIPv4(g))) return false;
  return parts.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** Shared state for one process's sockets and servers, fed by kernel messages. */
export class NetHub {
  readonly ctx: ProcessContext;
  readonly loop: EventLoop;
  private readonly streamModule: () => { Duplex: DuplexCtor };
  readonly sockets = new Map<number, { onData(d: Uint8Array): void; onEnd(): void }>();
  readonly listeners = new Map<number, { onMessage(m: NetToProcess): void }>();
  readonly connects = new Map<number, (err: string | null) => void>();
  readonly requests = new Map<number, { onMessage(m: NetToProcess): void }>();
  private nextListener = 1;
  private nextClientSid = -1;

  constructor(deps: NetDeps) {
    this.ctx = deps.ctx;
    this.loop = deps.loop;
    this.streamModule = deps.stream;
    deps.ctx.onMessage((msg: KernelToProcess) => this.dispatch(msg));
  }

  get Duplex(): DuplexCtor {
    return this.streamModule().Duplex;
  }

  listenerId(): number {
    return this.nextListener++;
  }

  clientSid(): number {
    return this.nextClientSid--;
  }

  private dispatch(msg: KernelToProcess): void {
    switch (msg.t) {
      case 'net-listening':
      case 'net-listen-error':
      case 'tcp-accept':
        this.listeners.get(msg.id)?.onMessage(msg);
        break;
      case 'http-req':
        this.listeners.get(msg.id)?.onMessage(msg);
        break;
      case 'http-req-body':
      case 'http-req-end':
      case 'http-req-abort':
        this.requests.get(msg.sid)?.onMessage(msg);
        break;
      case 'net-connected':
        this.connects.get(msg.sid)?.(null);
        break;
      case 'net-connect-error':
        this.connects.get(msg.sid)?.(msg.code);
        break;
      case 'sock-data':
        this.sockets.get(msg.sid)?.onData(msg.data);
        break;
      case 'sock-end':
        this.sockets.get(msg.sid)?.onEnd();
        break;
    }
  }
}

export interface NetModule {
  module: Record<string, unknown>;
  hub: NetHub;
  Server: new (...args: unknown[]) => NetServer;
  /** Wraps a kernel socket (an upgrade or accepted connection) as a net.Socket. */
  socketFor(sid: number): Duplex;
  /** A socket-shaped placeholder for HTTP requests that have no byte stream. */
  fakeSocket(): EventEmitter & Record<string, unknown>;
}

export type NetServer = EventEmitter & {
  listening: boolean;
  /** @internal Kind of listener http servers register. */
  _kind: 'http' | 'tcp';
  _onKernel(msg: NetToProcess): void;
};

export function createNet(deps: NetDeps): NetModule {
  const hub = new NetHub(deps);
  let SocketClass: (new (opts?: Record<string, unknown>) => Duplex) | undefined;

  const getSocket = () => {
    if (SocketClass) return SocketClass;
    const Base = hub.Duplex;
    class Socket extends Base {
      connecting = false;
      pending = true;
      remoteAddress: string | undefined = undefined;
      remotePort: number | undefined = undefined;
      remoteFamily: string | undefined = undefined;
      localAddress = '127.0.0.1';
      localPort: number | undefined = undefined;
      bytesRead = 0;
      bytesWritten = 0;
      encrypted = false;
      declare _sid: number | null;
      declare _handle: Handle | null;
      declare _queued: [Uint8Array, () => void][];
      declare _timeoutMs: number;
      declare _timer: ReturnType<EventLoop['timers']['setTimeout']> | null;
      declare _ended: boolean;

      constructor(opts: Record<string, unknown> = {}) {
        super({ allowHalfOpen: opts['allowHalfOpen'] === true, decodeStrings: true });
        this._sid = null;
        this._handle = null;
        this._queued = [];
        this._timeoutMs = 0;
        this._timer = null;
        this._ended = false;
        if (typeof opts['_sid'] === 'number') this._attach(opts['_sid']);
      }

      /** @internal Binds this socket to kernel socket `sid` (connected). */
      _attach(sid: number): void {
        this._sid = sid;
        this.pending = false;
        this.connecting = false;
        this.remoteAddress = '127.0.0.1';
        this.remoteFamily = 'IPv4';
        this._handle = hub.loop.handle();
        hub.sockets.set(sid, {
          onData: (d) => {
            this.bytesRead += d.length;
            this._touch();
            this.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
          },
          onEnd: () => {
            this.push(null);
          },
        });
        for (const [chunk, cb] of this._queued.splice(0)) this._send(chunk, cb);
      }

      connect(...args: unknown[]): this {
        let port: number;
        let host = 'localhost';
        let cb: (() => void) | undefined;
        const first = args[0];
        if (typeof first === 'object' && first !== null) {
          const o = first as { port?: unknown; host?: string; path?: string };
          if (o.path !== undefined) {
            queueMicrotask(() => this.destroy(netError('ENOENT', 'connect', o.path)));
            return this;
          }
          port = Number(o.port);
          host = o.host ?? host;
          cb = args[1] as (() => void) | undefined;
        } else {
          port = Number(first);
          if (typeof args[1] === 'string') {
            host = args[1];
            cb = args[2] as (() => void) | undefined;
          } else cb = args[1] as (() => void) | undefined;
        }
        if (typeof cb === 'function') this.once('connect', cb);
        this.connecting = true;
        this.remotePort = port;
        const address = host === 'localhost' ? '127.0.0.1' : host;
        if (!isLocalHost(host)) {
          // Only the instance's own ports exist; the browser cannot open TCP connections.
          queueMicrotask(() => this.destroy(netError('ECONNREFUSED', 'connect', address, port)));
          return this;
        }
        const sid = hub.clientSid();
        const handle = hub.loop.handle();
        hub.connects.set(sid, (err) => {
          hub.connects.delete(sid);
          handle.close();
          if (err) {
            this.connecting = false;
            this.destroy(netError(err, 'connect', address, port));
            return;
          }
          this._attach(sid);
          this.emit('connect');
          this.emit('ready');
        });
        hub.ctx.send({ t: 'net-connect', sid, port });
        return this;
      }

      private _send(chunk: Uint8Array, cb: () => void): void {
        this.bytesWritten += chunk.length;
        this._touch();
        hub.ctx.send({
          t: 'sock-data',
          sid: this._sid!,
          data: Uint8Array.prototype.slice.call(chunk),
        });
        cb();
      }

      _write(chunk: Uint8Array, _enc: string, cb: () => void): void {
        if (this._sid === null) this._queued.push([chunk, cb]);
        else this._send(chunk, cb);
      }

      _read(): void {}

      _final(cb: () => void): void {
        this._sendEnd();
        cb();
      }

      private _sendEnd(): void {
        if (this._ended || this._sid === null) return;
        this._ended = true;
        hub.ctx.send({ t: 'sock-end', sid: this._sid });
      }

      _destroy(err: Error | null, cb: (e: Error | null) => void): void {
        this._sendEnd();
        if (this._sid !== null) hub.sockets.delete(this._sid);
        this._handle?.close();
        if (this._timer) this._timer.close();
        cb(err);
      }

      private _touch(): void {
        if (this._timer) this._timer.refresh();
      }

      setTimeout(ms: number, cb?: () => void): this {
        if (this._timer) {
          this._timer.close();
          this._timer = null;
        }
        this._timeoutMs = ms;
        if (cb) this.once('timeout', cb);
        if (ms > 0)
          this._timer = hub.loop.timers.setTimeout(() => this.emit('timeout'), ms).unref();
        return this;
      }
      setNoDelay(): this {
        return this;
      }
      setKeepAlive(): this {
        return this;
      }
      ref(): this {
        this._handle?.ref();
        return this;
      }
      unref(): this {
        this._handle?.unref();
        return this;
      }
      address(): { address: string; family: string; port: number } {
        return { address: this.localAddress, family: 'IPv4', port: this.localPort ?? 0 };
      }
      get readyState(): string {
        if (this.connecting) return 'opening';
        if (this.readable && this.writable) return 'open';
        if (this.readable) return 'readOnly';
        if (this.writable) return 'writeOnly';
        return 'closed';
      }
      get timeout(): number {
        return this._timeoutMs;
      }
      get bufferSize(): number {
        return 0;
      }
      resetAndDestroy(): this {
        this.destroy();
        return this;
      }
    }
    SocketClass = Socket as unknown as new (opts?: Record<string, unknown>) => Duplex;
    return SocketClass;
  };

  class Server extends EventEmitter {
    listening = false;
    maxConnections: number | undefined = undefined;
    _kind: 'http' | 'tcp' = 'tcp';
    private _id: number | null = null;
    private _port = 0;
    private _host: string | undefined;
    private _handle: Handle | null = null;
    private _connections = new Set<Duplex>();

    constructor(...args: unknown[]) {
      super();
      const listener = args.find((a) => typeof a === 'function') as
        ((s: Duplex) => void) | undefined;
      if (listener) this.on('connection', listener);
    }

    listen(...args: unknown[]): this {
      let port = 0;
      let host: string | undefined;
      let cb: (() => void) | undefined;
      const rest = [...args];
      if (typeof rest[rest.length - 1] === 'function') cb = rest.pop() as () => void;
      const first = rest[0];
      if (typeof first === 'object' && first !== null) {
        const o = first as { port?: unknown; host?: string; path?: string };
        if (o.path !== undefined) {
          queueMicrotask(() => this.emit('error', netError('EACCES', 'listen', o.path)));
          return this;
        }
        port = Number(o.port ?? 0);
        host = o.host;
      } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
        queueMicrotask(() => this.emit('error', netError('EACCES', 'listen', first)));
        return this;
      } else if (first !== undefined && first !== null) {
        port = Number(first);
        if (typeof rest[1] === 'string') host = rest[1];
      }
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        const err = new RangeError(
          `options.port should be >= 0 and < 65536. Received ${String(first)}.`,
        );
        (err as RangeError & { code: string }).code = 'ERR_SOCKET_BAD_PORT';
        throw err;
      }
      if (this.listening) {
        const err = new Error('Listen method has been called more than once without closing.');
        (err as Error & { code: string }).code = 'ERR_SERVER_ALREADY_LISTEN';
        throw err;
      }
      if (cb) this.once('listening', cb);
      this._host = host;
      this._port = port;
      const id = hub.listenerId();
      this._id = id;
      this._handle = hub.loop.handle();
      hub.listeners.set(id, { onMessage: (m) => this._onKernel(m) });
      hub.ctx.send({ t: 'net-listen', id, port, kind: this._kind });
      return this;
    }

    /** @internal */
    _onKernel(msg: NetToProcess): void {
      if (msg.t === 'net-listening') {
        this.listening = true;
        this._port = msg.port;
        this.emit('listening');
      } else if (msg.t === 'net-listen-error') {
        this._cleanup();
        const address = this._host === undefined ? '::' : this._host;
        this.emit('error', netError(msg.code, 'listen', address, this._port || undefined));
      } else if (msg.t === 'tcp-accept') {
        const Socket = getSocket();
        const sock = new Socket({ _sid: msg.sid });
        (sock as unknown as { localPort: number }).localPort = this._port;
        this._connections.add(sock);
        sock.once('close', () => {
          this._connections.delete(sock);
          this._maybeClosed();
        });
        this.emit('connection', sock);
      }
    }

    private _closing = false;
    private _closeCbs: ((err?: Error) => void)[] = [];

    private _cleanup(): void {
      if (this._id !== null) hub.listeners.delete(this._id);
      this._id = null;
      this.listening = false;
      this._handle?.close();
      this._handle = null;
    }

    /** @internal Tracks a connection so close() waits for it. */
    _track(sock: Duplex): void {
      this._connections.add(sock);
      sock.once('close', () => {
        this._connections.delete(sock);
        this._maybeClosed();
      });
    }

    private _maybeClosed(): void {
      if (!this._closing || this._connections.size > 0) return;
      this._closing = false;
      const cbs = this._closeCbs.splice(0);
      queueMicrotask(() => {
        this.emit('close');
        for (const cb of cbs) cb();
      });
    }

    close(cb?: (err?: Error) => void): this {
      if (!this.listening && this._id === null) {
        if (cb) {
          const err = new Error('Server is not running.');
          (err as Error & { code: string }).code = 'ERR_SERVER_NOT_RUNNING';
          queueMicrotask(() => cb(err));
        }
        return this;
      }
      if (this._id !== null) hub.ctx.send({ t: 'net-unlisten', id: this._id });
      this._cleanup();
      if (cb) this._closeCbs.push(cb);
      this._closing = true;
      this._maybeClosed();
      return this;
    }

    address(): { address: string; family: string; port: number } | null {
      if (!this.listening) return null;
      const host = this._host;
      if (host === undefined || host === '::') {
        return { address: '::', family: 'IPv6', port: this._port };
      }
      const address = host === 'localhost' ? '127.0.0.1' : host;
      return { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: this._port };
    }

    getConnections(cb: (err: Error | null, n: number) => void): this {
      queueMicrotask(() => cb(null, this._connections.size));
      return this;
    }

    ref(): this {
      this._handle?.ref();
      return this;
    }
    unref(): this {
      this._handle?.unref();
      return this;
    }
  }

  const createServer = (...args: unknown[]) => new Server(...args);
  const connect = (...args: unknown[]) => {
    const Socket = getSocket();
    const opts =
      typeof args[0] === 'object' && args[0] !== null ? (args[0] as Record<string, unknown>) : {};
    const sock = new Socket(opts) as Duplex & { connect(...a: unknown[]): unknown };
    sock.connect(...args);
    return sock;
  };

  const fakeSocket = () => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(s, {
      remoteAddress: '127.0.0.1',
      remotePort: 0,
      remoteFamily: 'IPv4',
      localAddress: '127.0.0.1',
      localPort: 0,
      encrypted: false,
      readable: true,
      writable: true,
      destroyed: false,
      bytesRead: 0,
      bytesWritten: 0,
      setTimeout: () => s,
      setNoDelay: () => s,
      setKeepAlive: () => s,
      ref: () => s,
      unref: () => s,
      destroy: () => s,
      end: () => s,
      write: () => true,
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 0 }),
    });
    return s;
  };

  const module: Record<string, unknown> = {
    createServer,
    Server,
    connect,
    createConnection: connect,
    isIP: (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily: () => true,
    setDefaultAutoSelectFamily: () => {},
    getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
    setDefaultAutoSelectFamilyAttemptTimeout: () => {},
    BlockList: class BlockList {
      addAddress() {}
      addRange() {}
      addSubnet() {}
      check() {
        return false;
      }
    },
    SocketAddress: class SocketAddress {
      address: string;
      port: number;
      family: string;
      flowlabel = 0;
      constructor(o: { address?: string; port?: number; family?: string } = {}) {
        this.address = o.address ?? '127.0.0.1';
        this.port = o.port ?? 0;
        this.family = o.family ?? 'ipv4';
      }
    },
  };
  Object.defineProperty(module, 'Socket', { get: getSocket, enumerable: true });
  Object.defineProperty(module, 'Stream', { get: getSocket, enumerable: true });

  return {
    module,
    hub,
    Server: Server as unknown as new (...args: unknown[]) => NetServer,
    socketFor: (sid) => {
      const Socket = getSocket();
      return new Socket({ _sid: sid, allowHalfOpen: true });
    },
    fakeSocket,
  };
}
