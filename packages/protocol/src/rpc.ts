// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal typed request/response RPC over anything with postMessage
 * (MessagePort, Worker, DedicatedWorkerGlobalScope).
 */

export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** MessagePorts only deliver to addEventListener listeners after start(). */
  start?(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Methods = Record<string, (...args: any[]) => unknown>;

type Request = { t: 'rpc:req'; id: number; m: string; a: unknown[] };
type Response =
  | { t: 'rpc:res'; id: number; ok: true; v: unknown }
  | { t: 'rpc:res'; id: number; ok: false; e: { name: string; message: string; code?: unknown } };
type Event = { t: 'rpc:evt'; m: string; a: unknown[] };

/**
 * Checks a message's shape. The other end may be hostile (an instance kernel
 * runs on an origin shared with untrusted code), so anything malformed is
 * dropped rather than allowed to throw in a message listener.
 */
function parseRpcMessage(data: unknown): Request | Response | Event | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m['t']) {
    case 'rpc:evt':
      return typeof m['m'] === 'string' && Array.isArray(m['a']) ? (m as Event) : null;
    case 'rpc:req':
      return Number.isSafeInteger(m['id']) && typeof m['m'] === 'string' && Array.isArray(m['a'])
        ? (m as Request)
        : null;
    case 'rpc:res': {
      if (!Number.isSafeInteger(m['id'])) return null;
      if (m['ok'] === true) return m as Response;
      const e = m['e'] as Record<string, unknown> | null | undefined;
      return m['ok'] === false &&
        typeof e === 'object' &&
        e !== null &&
        typeof e['name'] === 'string' &&
        typeof e['message'] === 'string'
        ? (m as Response)
        : null;
    }
    default:
      return null;
  }
}

/**
 * Wraps an RPC argument list or return value whose parts must be transferred
 * (MessagePorts, ReadableStreams, ArrayBuffers) rather than cloned.
 */
export class Transfer<T> {
  readonly value: T;
  readonly transfer: Transferable[];
  constructor(value: T, transfer: Transferable[]) {
    this.value = value;
    this.transfer = transfer;
  }
}

/** Marks a handler's return value for transfer. */
export const withTransfer = <T>(value: T, transfer: Transferable[]): T =>
  new Transfer(value, transfer) as unknown as T;

export class RpcError extends Error {
  readonly code: unknown;
  constructor(name: string, message: string, code?: unknown) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/**
 * One end of an RPC link. `Local` are the methods this side serves; `Remote`
 * are the methods the other side serves. Events reuse the same method shape
 * but get no reply.
 */
export class RpcEndpoint<Local extends Methods, Remote extends Methods> {
  private readonly port: PortLike;
  private readonly handlers: Partial<Local>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  private closed: Error | null = null;

  constructor(port: PortLike, handlers: Partial<Local>) {
    this.port = port;
    this.handlers = handlers;
    port.addEventListener('message', (event) => this.onMessage(event.data));
    port.start?.();
  }

  call<K extends keyof Remote & string>(
    method: K,
    ...args: Parameters<Remote[K]>
  ): Promise<Awaited<ReturnType<Remote[K]>>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ t: 'rpc:req', id, m: method, a: args } satisfies Request);
    });
  }

  /** Like {@link call}, transferring `transfer` instead of cloning it. */
  callTransfer<K extends keyof Remote & string>(
    method: K,
    args: Parameters<Remote[K]>,
    transfer: Transferable[],
  ): Promise<Awaited<ReturnType<Remote[K]>>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ t: 'rpc:req', id, m: method, a: args } satisfies Request, transfer);
    });
  }

  /**
   * Ends the link: pending and future calls reject with `reason`, and
   * incoming messages are ignored. For when the other side is gone.
   */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  emit<K extends keyof Remote & string>(method: K, ...args: Parameters<Remote[K]>): void {
    this.port.postMessage({ t: 'rpc:evt', m: method, a: args } satisfies Event);
  }

  private onMessage(raw: unknown): void {
    if (this.closed) return;
    const data = parseRpcMessage(raw);
    if (!data) return;
    if (data.t === 'rpc:res') {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.v);
      else p.reject(new RpcError(data.e.name, data.e.message, data.e.code));
      return;
    }
    // Handlers may be a class instance, so methods can be inherited, but a
    // name like "constructor" or "__defineGetter__" must not reach
    // Object.prototype (or a class constructor).
    const found =
      data.m === 'constructor' ? undefined : (this.handlers as Record<string, unknown>)[data.m];
    const handler =
      typeof found === 'function' &&
      found !== (Object.prototype as unknown as Record<string, unknown>)[data.m]
        ? (found as (...args: unknown[]) => unknown).bind(this.handlers)
        : undefined;
    if (data.t === 'rpc:evt') {
      if (!handler) return;
      try {
        handler(...data.a);
      } catch (err) {
        // An event has no reply; report the failure without breaking the listener.
        queueMicrotask(() => {
          throw err;
        });
      }
      return;
    }
    const { id } = data;
    Promise.resolve()
      .then(() => {
        if (!handler) throw new RpcError('Error', `unknown RPC method ${data.m.slice(0, 100)}`);
        return handler(...data.a);
      })
      .then(
        (v) => {
          if (v instanceof Transfer) {
            this.port.postMessage(
              { t: 'rpc:res', id, ok: true, v: v.value } satisfies Response,
              v.transfer,
            );
          } else this.port.postMessage({ t: 'rpc:res', id, ok: true, v } satisfies Response);
        },
        (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          const code = (e as { code?: unknown }).code;
          this.port.postMessage({
            t: 'rpc:res',
            id,
            ok: false,
            e: { name: e.name, message: e.message, ...(code === undefined ? {} : { code }) },
          } satisfies Response);
        },
      );
  }
}
