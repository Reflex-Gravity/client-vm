// SPDX-License-Identifier: Apache-2.0
// The instance's virtual network: ports owned by processes, HTTP requests
// relayed to them as messages with streamed responses, and raw byte sockets
// (HTTP upgrades, `net` connections) linked end to end.

import { SystemError } from '@clientvm/protocol';
import type { KernelToProcess, NetToKernel, WireRequest, WireResponse } from '@clientvm/protocol';
import type { HttpRouter } from './http.ts';

/** One end of a byte socket: data, or null for close. */
interface Endpoint {
  send(data: Uint8Array | null): void;
}

interface PendingResponse {
  resolve: (r: WireResponse) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  settled: boolean;
}

/** First port handed out for `listen(0)`, like Linux's ephemeral range. */
const EPHEMERAL_START = 32768;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

function badGateway(message: string): WireResponse {
  return {
    status: 502,
    statusText: 'Bad Gateway',
    headers: [['content-type', 'text/plain; charset=utf-8']],
    body: new TextEncoder().encode(message),
  };
}

export class NetStack {
  private readonly router: HttpRouter;
  /** Raw `net` listeners: port -> process + listener id. */
  private readonly tcp = new Map<number, { proc: ProcessNet; id: number }>();
  private nextSid = 1;
  private nextEphemeral = EPHEMERAL_START;

  constructor(router: HttpRouter) {
    this.router = router;
  }

  /** The network view of one process; `post` delivers kernel messages to it. */
  attach(post: (msg: KernelToProcess) => void): ProcessNet {
    return new ProcessNet(this, post);
  }

  /** @internal */
  allocSid(): number {
    return this.nextSid++;
  }

  /** @internal */
  portInUse(port: number): boolean {
    return this.tcp.has(port) || this.router.ports.some((p) => p.port === port);
  }

  /** @internal */
  pickPort(): number {
    for (let i = 0; i < 28232; i++) {
      const port = this.nextEphemeral++;
      if (this.nextEphemeral > 60999) this.nextEphemeral = EPHEMERAL_START;
      if (!this.portInUse(port)) return port;
    }
    throw new SystemError('EADDRINUSE', 'listen');
  }

  /** @internal */
  listen(proc: ProcessNet, id: number, port: number, kind: 'http' | 'tcp'): number {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new SystemError('EINVAL', 'listen');
    const p = port === 0 ? this.pickPort() : port;
    if (this.portInUse(p)) throw new SystemError('EADDRINUSE', 'listen');
    if (kind === 'tcp') this.tcp.set(p, { proc, id });
    else {
      this.router.listen(p, {
        fetch: (req) => proc.request(id, req),
        upgrade: (req, socket) => proc.upgrade(id, req, socket),
      });
    }
    return p;
  }

  /** @internal */
  unlisten(port: number, kind: 'http' | 'tcp'): void {
    if (kind === 'tcp') this.tcp.delete(port);
    else this.router.close(port);
  }

  /** @internal Connects a process's outgoing socket to a tcp listener. */
  connect(client: ProcessNet, clientSid: number, port: number): void {
    const listener = this.tcp.get(port);
    if (!listener) throw new SystemError('ECONNREFUSED', 'connect');
    const serverSid = this.allocSid();
    const toClient = client.endpoint(clientSid);
    const toServer = listener.proc.endpoint(serverSid);
    client.link(clientSid, toServer);
    listener.proc.link(serverSid, toClient);
    listener.proc.post({ t: 'tcp-accept', sid: serverSid, id: listener.id });
  }
}

/** One process's listeners, sockets and in-flight requests. */
export class ProcessNet {
  private readonly stack: NetStack;
  readonly post: (msg: KernelToProcess) => void;
  private readonly listeners = new Map<number, { port: number; kind: 'http' | 'tcp' }>();
  /** Where bytes written to each of this process's sockets go. */
  private readonly peers = new Map<number, Endpoint>();
  private readonly responses = new Map<number, PendingResponse>();
  private closed = false;

  constructor(stack: NetStack, post: (msg: KernelToProcess) => void) {
    this.stack = stack;
    this.post = post;
  }

  /** An endpoint that delivers bytes into socket `sid` of this process. */
  endpoint(sid: number): Endpoint {
    return {
      send: (data) => {
        if (this.closed) return;
        // null is a half-close: the process can still write back until it ends too.
        if (data === null) this.post({ t: 'sock-end', sid });
        else this.post({ t: 'sock-data', sid, data });
      },
    };
  }

  link(sid: number, peer: Endpoint): void {
    this.peers.set(sid, peer);
  }

  /** Relays an HTTP request to listener `id`; resolves once the response head arrives. */
  request(id: number, req: WireRequest): Promise<WireResponse> {
    if (this.closed) return Promise.resolve(badGateway('The server process has exited.'));
    const sid = this.stack.allocSid();
    return new Promise((resolve) => {
      this.responses.set(sid, { resolve, controller: null, settled: false });
      this.post({
        t: 'http-req',
        sid,
        id,
        method: req.method,
        url: req.path,
        headers: req.headers,
        upgrade: false,
      });
      if (req.body && req.body.length > 0) this.post({ t: 'http-req-body', sid, data: req.body });
      this.post({ t: 'http-req-end', sid });
    });
  }

  /** Hands an upgrade request to listener `id`; `socket` then carries raw bytes. */
  upgrade(id: number, req: WireRequest, socket: MessagePort): void {
    if (this.closed) {
      socket.postMessage(null);
      socket.close();
      return;
    }
    const sid = this.stack.allocSid();
    this.peers.set(sid, {
      send(data) {
        socket.postMessage(data);
        if (data === null) socket.close();
      },
    });
    socket.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (data instanceof Uint8Array) this.post({ t: 'sock-data', sid, data });
      else if (data === null) this.post({ t: 'sock-end', sid });
    };
    this.post({
      t: 'http-req',
      sid,
      id,
      method: req.method,
      url: req.path,
      headers: req.headers,
      upgrade: true,
    });
  }

  handle(msg: NetToKernel): void {
    switch (msg.t) {
      case 'net-listen': {
        try {
          const port = this.stack.listen(this, msg.id, msg.port, msg.kind);
          this.listeners.set(msg.id, { port, kind: msg.kind });
          this.post({ t: 'net-listening', id: msg.id, port });
        } catch (err) {
          this.post({
            t: 'net-listen-error',
            id: msg.id,
            code: (err as SystemError).code ?? 'EIO',
          });
        }
        break;
      }
      case 'net-unlisten': {
        const l = this.listeners.get(msg.id);
        if (!l) break;
        this.listeners.delete(msg.id);
        this.stack.unlisten(l.port, l.kind);
        break;
      }
      case 'net-connect':
        try {
          this.stack.connect(this, msg.sid, msg.port);
          this.post({ t: 'net-connected', sid: msg.sid });
        } catch (err) {
          this.post({
            t: 'net-connect-error',
            sid: msg.sid,
            code: (err as SystemError).code ?? 'EIO',
          });
        }
        break;
      case 'http-res-head': {
        const r = this.responses.get(msg.sid);
        if (!r || r.settled) break;
        r.settled = true;
        const sid = msg.sid;
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            r.controller = controller;
          },
          cancel: () => {
            this.responses.delete(sid);
            this.post({ t: 'http-req-abort', sid });
          },
        });
        r.resolve({
          status: msg.status,
          statusText: msg.statusText,
          headers: msg.headers.filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())),
          body,
        });
        break;
      }
      case 'http-res-body':
        try {
          this.responses.get(msg.sid)?.controller?.enqueue(msg.data);
        } catch {
          // the reader cancelled
        }
        break;
      case 'http-res-end': {
        const r = this.responses.get(msg.sid);
        this.responses.delete(msg.sid);
        try {
          r?.controller?.close();
        } catch {
          // already cancelled
        }
        break;
      }
      case 'sock-data':
        this.peers.get(msg.sid)?.send(msg.data);
        break;
      case 'sock-end': {
        const peer = this.peers.get(msg.sid);
        this.peers.delete(msg.sid);
        peer?.send(null);
        break;
      }
    }
  }

  /** Process exit: close its ports, sockets and unfinished responses. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.values()) this.stack.unlisten(l.port, l.kind);
    this.listeners.clear();
    for (const peer of this.peers.values()) peer.send(null);
    this.peers.clear();
    for (const r of this.responses.values()) {
      if (!r.settled) {
        r.settled = true;
        r.resolve(badGateway('The server process exited before responding.'));
      } else {
        try {
          r.controller?.error(new Error('server process exited'));
        } catch {
          // already closed
        }
      }
    }
    this.responses.clear();
  }
}
