// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal typed request/response RPC over anything with postMessage
 * (MessagePort, Worker, DedicatedWorkerGlobalScope).
 */

export interface PortLike {
  postMessage(message: unknown): void;
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

function isRpcMessage(data: unknown): data is Request | Response | Event {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { t?: unknown }).t === 'string' &&
    (data as { t: string }).t.startsWith('rpc:')
  );
}

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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ t: 'rpc:req', id, m: method, a: args } satisfies Request);
    });
  }

  emit<K extends keyof Remote & string>(method: K, ...args: Parameters<Remote[K]>): void {
    this.port.postMessage({ t: 'rpc:evt', m: method, a: args } satisfies Event);
  }

  private onMessage(data: unknown): void {
    if (!isRpcMessage(data)) return;
    if (data.t === 'rpc:res') {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.v);
      else p.reject(new RpcError(data.e.name, data.e.message, data.e.code));
      return;
    }
    const handler = this.handlers[data.m];
    if (data.t === 'rpc:evt') {
      handler?.(...data.a);
      return;
    }
    const { id } = data;
    Promise.resolve()
      .then(() => {
        if (!handler) throw new RpcError('Error', `unknown RPC method ${data.m}`);
        return handler(...data.a);
      })
      .then(
        (v) => this.port.postMessage({ t: 'rpc:res', id, ok: true, v } satisfies Response),
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
