// SPDX-License-Identifier: Apache-2.0
// `http` / `https`. Servers listen on virtual ports: the kernel relays each
// request as messages and the response streams back to the service worker.
// Upgrades (WebSocket) get a raw byte socket. Clients use the browser's
// fetch: requests to localhost reach this instance's ports, anything else is
// a cross-origin fetch subject to CORS (docs/compatibility.md).

import { NO_LISTENER_HEADER } from '@clientvm/protocol';
import type { NetToProcess } from '@clientvm/protocol';
import { Buffer } from './buffer.ts';
import type { Handle } from './event-loop.ts';
import { EventEmitter } from './events.ts';
import type { NetModule, NetServer } from './net.ts';
import { netError, virtualUrl } from './net.ts';

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

export const METHODS = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCALENDAR',
  'MKCOL',
  'MOVE',
  'NOTIFY',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'QUERY',
  'REBIND',
  'REPORT',
  'SEARCH',
  'SOURCE',
  'SUBSCRIBE',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
  'UNSUBSCRIBE',
];

const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const INVALID_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

function codeError(Ctor: new (m: string) => Error, code: string, message: string): Error {
  const e = new Ctor(message);
  (e as Error & { code: string }).code = code;
  return e;
}

export function validateHeaderName(name: unknown): void {
  if (typeof name !== 'string' || !name || !TOKEN.test(name)) {
    throw codeError(
      TypeError,
      'ERR_INVALID_HTTP_TOKEN',
      `Header name must be a valid HTTP token ["${String(name)}"]`,
    );
  }
}

export function validateHeaderValue(name: string, value: unknown): void {
  if (value === undefined) {
    throw codeError(
      TypeError,
      'ERR_HTTP_INVALID_HEADER_VALUE',
      `Invalid value "${String(value)}" for header "${name}"`,
    );
  }
  if (INVALID_VALUE.test(String(value))) {
    throw codeError(
      TypeError,
      'ERR_INVALID_CHAR',
      `Invalid character in header content ["${name}"]`,
    );
  }
}

/** Builds Node's `headers` object: lowercase keys, duplicates joined (set-cookie as an array). */
function headersObject(pairs: [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [k, v] of pairs) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, v] : [v];
    } else if (key in out) {
      out[key] = key === 'cookie' ? `${out[key] as string}; ${v}` : `${out[key] as string}, ${v}`;
    } else out[key] = v;
  }
  return out;
}

type Stream = Record<string, unknown> & {
  Readable: new (opts?: object) => EventEmitter & Record<string, unknown>;
  Writable: new (opts?: object) => EventEmitter & Record<string, unknown>;
};

export interface HttpDeps {
  net: NetModule;
  stream: () => Stream;
}

/** Headers stripped from cross-origin requests: forbidden for fetch, or they force a CORS preflight servers reject. */
const DROP_CROSS_ORIGIN =
  /^(host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|user-agent|accept-encoding|referer|origin|cookie|proxy-.*|npm-.*|pacote-.*|x-npm-.*)$/i;
const DROP_ALWAYS =
  /^(host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|accept-encoding)$/i;

export function createHttp(deps: HttpDeps, protocol: 'http:' | 'https:'): Record<string, unknown> {
  const { net } = deps;
  const hub = net.hub;
  const S = deps.stream();

  // ----------------------------------------------------------- IncomingMessage

  class IncomingMessage extends (S.Readable as unknown as new (opts?: object) => EventEmitter & {
    push(c: unknown): boolean;
    destroy(e?: Error): unknown;
  }) {
    httpVersion = '1.1';
    httpVersionMajor = 1;
    httpVersionMinor = 1;
    headers: Record<string, string | string[]> = Object.create(null);
    rawHeaders: string[] = [];
    trailers: Record<string, string> = Object.create(null);
    rawTrailers: string[] = [];
    method: string | undefined = undefined;
    url = '';
    statusCode: number | null = null;
    statusMessage: string | null = null;
    complete = false;
    aborted = false;
    upgrade = false;
    socket: unknown;
    constructor(socket?: unknown) {
      super({});
      this.socket = socket ?? null;
    }
    get connection(): unknown {
      return this.socket;
    }
    get headersDistinct(): Record<string, string[]> {
      const out: Record<string, string[]> = Object.create(null);
      for (let i = 0; i < this.rawHeaders.length; i += 2) {
        const k = this.rawHeaders[i]!.toLowerCase();
        (out[k] ??= []).push(this.rawHeaders[i + 1]!);
      }
      return out;
    }
    _read(): void {}
    setTimeout(_ms: number, cb?: () => void): this {
      if (cb) this.on('timeout', cb);
      return this;
    }
    /** @internal */
    _setHeaders(pairs: [string, string][]): void {
      this.headers = headersObject(pairs);
      this.rawHeaders = pairs.flat();
    }
  }

  // ------------------------------------------------------------ OutgoingMessage

  type HeaderValue = string | number | string[];
  const Writable = S.Writable as unknown as new (opts?: object) => EventEmitter & {
    write(...a: unknown[]): boolean;
    end(...a: unknown[]): unknown;
    destroy(e?: Error): unknown;
    destroyed: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
  };

  class OutgoingMessage extends Writable {
    /** lowercase name -> [original name, value] */
    _headerMap = new Map<string, [string, HeaderValue]>();
    headersSent = false;
    sendDate = false;
    socket: unknown = null;
    constructor(options: object = {}) {
      super({ decodeStrings: true, ...options });
    }
    get connection(): unknown {
      return this.socket;
    }
    get finished(): boolean {
      return this.writableEnded;
    }
    setHeader(name: string, value: HeaderValue): this {
      if (this.headersSent) {
        throw codeError(
          Error,
          'ERR_HTTP_HEADERS_SENT',
          'Cannot set headers after they are sent to the client',
        );
      }
      validateHeaderName(name);
      validateHeaderValue(name, value);
      this._headerMap.set(name.toLowerCase(), [name, value]);
      return this;
    }
    setHeaders(headers: Headers | Map<string, HeaderValue>): this {
      for (const [k, v] of headers as Iterable<[string, HeaderValue]>) this.setHeader(k, v);
      return this;
    }
    appendHeader(name: string, value: HeaderValue): this {
      const prev = this._headerMap.get(name.toLowerCase());
      if (!prev) return this.setHeader(name, value);
      const merged = ([] as (string | number)[]).concat(prev[1], value).map(String);
      this._headerMap.set(name.toLowerCase(), [prev[0], merged]);
      return this;
    }
    getHeader(name: string): HeaderValue | undefined {
      return this._headerMap.get(String(name).toLowerCase())?.[1];
    }
    getHeaders(): Record<string, HeaderValue> {
      const out: Record<string, HeaderValue> = Object.create(null);
      for (const [k, [, v]] of this._headerMap) out[k] = v;
      return out;
    }
    getHeaderNames(): string[] {
      return [...this._headerMap.keys()];
    }
    getRawHeaderNames(): string[] {
      return [...this._headerMap.values()].map(([n]) => n);
    }
    hasHeader(name: string): boolean {
      return this._headerMap.has(String(name).toLowerCase());
    }
    removeHeader(name: string): void {
      if (this.headersSent) {
        throw codeError(
          Error,
          'ERR_HTTP_HEADERS_SENT',
          'Cannot remove headers after they are sent to the client',
        );
      }
      this._headerMap.delete(String(name).toLowerCase());
    }
    /** @internal */
    _headerPairs(): [string, string][] {
      const pairs: [string, string][] = [];
      for (const [name, value] of this._headerMap.values()) {
        if (Array.isArray(value)) for (const v of value) pairs.push([name, String(v)]);
        else pairs.push([name, String(value)]);
      }
      return pairs;
    }
    setTimeout(_ms: number, cb?: () => void): this {
      if (cb) this.on('timeout', cb);
      return this;
    }
    addTrailers(): void {}
    flushHeaders(): void {}
    cork(): void {}
    uncork(): void {}
  }

  // ------------------------------------------------------------- ServerResponse

  class ServerResponse extends OutgoingMessage {
    statusCode = 200;
    statusMessage: string | undefined = undefined;
    req: InstanceType<typeof IncomingMessage>;
    strictContentLength = false;
    declare _sid: number;
    declare _aborted: boolean;
    declare _noBody: boolean;
    constructor(req: InstanceType<typeof IncomingMessage>) {
      super();
      this.req = req;
      this.sendDate = true;
      this.socket = req.socket;
      this._aborted = false;
      this._noBody = req.method === 'HEAD';
    }
    writeHead(status: number, ...rest: unknown[]): this {
      if (this.headersSent) {
        throw codeError(
          Error,
          'ERR_HTTP_HEADERS_SENT',
          'Cannot write headers after they are sent to the client',
        );
      }
      if (!Number.isInteger(status) || status < 100 || status > 999) {
        throw codeError(
          RangeError,
          'ERR_HTTP_INVALID_STATUS_CODE',
          `Invalid status code: ${status}`,
        );
      }
      this.statusCode = status;
      let headers = rest[0];
      if (typeof headers === 'string') {
        this.statusMessage = headers;
        headers = rest[1];
      }
      if (Array.isArray(headers)) {
        if (headers.length > 0 && Array.isArray(headers[0])) {
          for (const [k, v] of headers as [string, string][]) this.appendHeader(k, v);
        } else {
          for (let i = 0; i < headers.length; i += 2)
            this.appendHeader(String(headers[i]), headers[i + 1] as string);
        }
      } else if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers))
          if (v !== undefined) this.setHeader(k, v as HeaderValue);
      }
      this._sendHead();
      return this;
    }
    override flushHeaders(): void {
      this._sendHead();
    }
    writeContinue(): void {}
    writeProcessing(): void {}
    writeEarlyHints(): void {}
    assignSocket(): void {}
    detachSocket(): void {}
    /** @internal */
    _sendHead(): void {
      if (this.headersSent) return;
      this.headersSent = true;
      if (this.statusCode === 204 || this.statusCode === 304) this._noBody = true;
      if (this.sendDate && !this._headerMap.has('date')) {
        this._headerMap.set('date', ['Date', new Date().toUTCString()]);
      }
      if (this._aborted) return;
      hub.ctx.send({
        t: 'http-res-head',
        sid: this._sid,
        status: this.statusCode,
        statusText: this.statusMessage ?? STATUS_CODES[this.statusCode] ?? 'unknown',
        headers: this._headerPairs(),
      });
    }
    _write(chunk: Uint8Array, _enc: string, cb: () => void): void {
      this._sendHead();
      if (!this._aborted && !this._noBody && chunk.length > 0) {
        hub.ctx.send({
          t: 'http-res-body',
          sid: this._sid,
          data: Uint8Array.prototype.slice.call(chunk),
        });
      }
      cb();
    }
    _final(cb: () => void): void {
      this._sendHead();
      if (!this._aborted) hub.ctx.send({ t: 'http-res-end', sid: this._sid });
      hub.requests.delete(this._sid);
      cb();
    }
  }

  // --------------------------------------------------------------------- Server

  const NetServerBase = net.Server as unknown as new (...a: unknown[]) => NetServer;

  class Server extends NetServerBase {
    timeout = 0;
    keepAliveTimeout = 5000;
    headersTimeout = 60000;
    requestTimeout = 300000;
    maxHeadersCount: number | null = null;
    maxRequestsPerSocket = 0;
    constructor(...args: unknown[]) {
      super();
      this._kind = 'http';
      const listener = args.find((a) => typeof a === 'function') as
        ((...a: unknown[]) => void) | undefined;
      if (listener) this.on('request', listener);
    }
    override _onKernel(msg: NetToProcess): void {
      if (msg.t !== 'http-req') {
        super._onKernel(msg);
        return;
      }
      const sid = msg.sid;
      if (msg.upgrade) {
        const socket = net.socketFor(sid);
        (this as unknown as { _track(s: unknown): void })._track(socket);
        const req = new IncomingMessage(socket);
        req.method = msg.method;
        req.url = msg.url;
        req.upgrade = true;
        req._setHeaders(msg.headers);
        req.complete = true;
        req.push(null);
        if (this.listenerCount('upgrade') > 0) this.emit('upgrade', req, socket, Buffer.alloc(0));
        else socket.destroy();
        return;
      }
      const socket = net.fakeSocket();
      const req = new IncomingMessage(socket);
      req.method = msg.method;
      req.url = msg.url;
      req._setHeaders(msg.headers);
      const res = new ServerResponse(req);
      res._sid = sid;
      hub.requests.set(sid, {
        onMessage: (m) => {
          if (m.t === 'http-req-body')
            req.push(Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength));
          else if (m.t === 'http-req-end') {
            req.complete = true;
            req.push(null);
          } else if (m.t === 'http-req-abort') {
            hub.requests.delete(sid);
            res._aborted = true;
            req.aborted = true;
            req.emit('aborted');
            req.emit('close');
            if (!res.writableFinished) res.emit('close');
          }
        },
      });
      res.on('finish', () => hub.requests.delete(sid));
      this.emit('request', req, res);
    }
    setTimeout(ms: number, cb?: () => void): this {
      this.timeout = ms;
      if (cb) this.on('timeout', cb);
      return this;
    }
    closeAllConnections(): void {}
    closeIdleConnections(): void {}
  }

  // -------------------------------------------------------------- ClientRequest

  class ClientRequest extends OutgoingMessage {
    method: string;
    path: string;
    host: string;
    protocol: string;
    port: number;
    aborted = false;
    reusedSocket = false;
    maxHeadersCount: number | null = null;
    declare _url: string;
    declare _body: Uint8Array[];
    declare _abort: AbortController;
    declare _handle: Handle;
    declare _timeout: number;
    declare _signal: AbortSignal | undefined;

    constructor(input: unknown, options?: unknown, cb?: unknown) {
      // The request ends (finish) long before the response; 'close' comes from _send.
      super({ autoDestroy: false, emitClose: false });
      let opts: Record<string, unknown> = {};
      if (typeof input === 'string' || input instanceof URL) {
        const u = new URL(String(input));
        opts = {
          protocol: u.protocol,
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: u.port,
          path: `${u.pathname}${u.search}`,
          ...(u.username
            ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` }
            : {}),
        };
        if (typeof options === 'function') cb = options;
        else if (options && typeof options === 'object') opts = { ...opts, ...(options as object) };
      } else if (input && typeof input === 'object') {
        opts = { ...(input as object) };
        if (typeof options === 'function') cb = options;
      }
      const proto = String(opts['protocol'] ?? protocol);
      if (proto !== 'http:' && proto !== 'https:') {
        throw codeError(
          TypeError,
          'ERR_INVALID_PROTOCOL',
          `Protocol "${proto}" not supported. Expected "${protocol}"`,
        );
      }
      this.protocol = proto;
      this.method = String(opts['method'] ?? 'GET').toUpperCase();
      this.host = String(opts['hostname'] ?? opts['host'] ?? 'localhost').replace(/:\d+$/, '');
      this.port = Number(opts['port'] || (proto === 'https:' ? 443 : 80));
      this.path = String(opts['path'] ?? '/');
      this._timeout = Number(opts['timeout'] ?? 0);
      this._signal = opts['signal'] as AbortSignal | undefined;
      const defaultPort = proto === 'https:' ? 443 : 80;
      const hostPart = this.host.includes(':') ? `[${this.host}]` : this.host;
      this._url = `${proto}//${hostPart}${this.port === defaultPort ? '' : `:${this.port}`}${this.path}`;
      this._body = [];
      this._abort = new AbortController();
      this._handle = hub.loop.handle();
      const headers = opts['headers'];
      if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i += 2)
          this.appendHeader(String(headers[i]), headers[i + 1] as string);
      } else if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers))
          if (v !== undefined) this.setHeader(k, v as HeaderValue);
      }
      if (opts['auth'] && !this.hasHeader('authorization')) {
        this.setHeader('Authorization', `Basic ${btoa(String(opts['auth']))}`);
      }
      if (typeof cb === 'function') this.once('response', cb as (...a: unknown[]) => void);
      const socket = net.fakeSocket();
      this.socket = socket;
      queueMicrotask(() => {
        this.emit('socket', socket);
        socket.emit('connect');
        if (proto === 'https:') socket.emit('secureConnect');
      });
      if (this._signal) {
        if (this._signal.aborted) queueMicrotask(() => this.destroy(abortError()));
        else
          this._signal.addEventListener('abort', () => this.destroy(abortError()), { once: true });
      }
    }

    _write(chunk: Uint8Array, _enc: string, cb: () => void): void {
      this._body.push(Uint8Array.prototype.slice.call(chunk));
      cb();
    }

    _final(cb: () => void): void {
      this.headersSent = true;
      void this._send();
      cb();
    }

    private async _send(): Promise<void> {
      const local = virtualUrl(this._url);
      const target = local ?? this._url;
      const drop = local ? DROP_ALWAYS : DROP_CROSS_ORIGIN;
      const headers = new Headers();
      for (const [k, v] of this._headerPairs()) {
        if (drop.test(k)) continue;
        try {
          headers.append(k, v);
        } catch {
          // invalid for fetch; Node would have sent it
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this._timeout > 0) timer = setTimeout(() => this.emit('timeout'), this._timeout);
      const hasBody = this.method !== 'GET' && this.method !== 'HEAD' && this._body.length > 0;
      let response: Response;
      try {
        response = await fetch(target, {
          method: this.method,
          headers,
          ...(hasBody ? { body: concat(this._body) as Uint8Array<ArrayBuffer> } : {}),
          signal: this._abort.signal,
          redirect: 'follow',
          credentials: 'omit',
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this._handle.close();
        if (this.aborted || this.destroyed) return;
        const e = netError(
          local ? 'ECONNREFUSED' : 'ECONNREFUSED',
          'connect',
          this.host,
          this.port,
        ) as Error & {
          cause?: unknown;
        };
        if (!local) {
          e.message = `request to ${this._url} failed (${err instanceof Error ? err.message : String(err)}; cross-origin requests need CORS)`;
        }
        e.cause = err;
        this.emit('error', e);
        this.emit('close');
        return;
      }
      if (timer) clearTimeout(timer);
      if (local && response.headers.has(NO_LISTENER_HEADER)) {
        this._handle.close();
        if (this.aborted || this.destroyed) return;
        this.emit('error', netError('ECONNREFUSED', 'connect', '127.0.0.1', this.port));
        this.emit('close');
        return;
      }
      const res = new IncomingMessage(this.socket);
      res.statusCode = response.status;
      res.statusMessage = response.statusText || STATUS_CODES[response.status] || '';
      const pairs: [string, string][] = [];
      const decoded = response.headers.has('content-encoding');
      response.headers.forEach((v, k) => {
        // fetch already decompressed the body.
        if (decoded && (k === 'content-encoding' || k === 'content-length')) return;
        pairs.push([k, v]);
      });
      res._setHeaders(pairs);
      (res as unknown as { req: unknown }).req = this;
      if (this.listenerCount('response') > 0) this.emit('response', res);
      else (res as unknown as { resume(): void }).resume();
      try {
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          }
        }
        res.complete = true;
        res.push(null);
      } catch (err) {
        res.aborted = true;
        res.emit('aborted');
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } finally {
        // Node closes the request (and lets the process exit) once the response is consumed.
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          this._handle.close();
          this.emit('close');
        };
        const res2 = res as unknown as { readableEnded: boolean; destroyed: boolean };
        if (res2.readableEnded || res2.destroyed) close();
        else {
          res.once('end', close);
          res.once('close', close);
        }
      }
    }

    abort(): void {
      if (this.aborted) return;
      this.aborted = true;
      this._abort.abort();
      this._handle.close();
      queueMicrotask(() => {
        this.emit('abort');
        this.emit('close');
      });
    }

    override destroy(err?: Error): this {
      this._abort.abort();
      this._handle.close();
      super.destroy(err);
      return this;
    }

    setNoDelay(): void {}
    setSocketKeepAlive(): void {}
    override setTimeout(ms: number, cb?: () => void): this {
      this._timeout = ms;
      if (cb) this.once('timeout', cb);
      return this;
    }
  }

  class Agent extends EventEmitter {
    options: Record<string, unknown>;
    maxSockets: number;
    maxFreeSockets: number;
    maxTotalSockets: number;
    keepAlive: boolean;
    defaultPort = protocol === 'https:' ? 443 : 80;
    protocol = protocol;
    sockets: Record<string, unknown[]> = Object.create(null);
    freeSockets: Record<string, unknown[]> = Object.create(null);
    requests: Record<string, unknown[]> = Object.create(null);
    constructor(options: Record<string, unknown> = {}) {
      super();
      this.options = { path: null, ...options };
      this.keepAlive = options['keepAlive'] === true;
      this.maxSockets = Number(options['maxSockets'] ?? Infinity);
      this.maxFreeSockets = Number(options['maxFreeSockets'] ?? 256);
      this.maxTotalSockets = Number(options['maxTotalSockets'] ?? Infinity);
    }
    getName(o: { host?: string; port?: number; localAddress?: string } = {}): string {
      return `${o.host ?? 'localhost'}:${o.port ?? ''}:${o.localAddress ?? ''}`;
    }
    destroy(): void {}
    keepSocketAlive(): boolean {
      return true;
    }
    reuseSocket(): void {}
  }

  const request = (...args: unknown[]) => new ClientRequest(args[0], args[1], args[2]);
  const get = (...args: unknown[]) => {
    const req = request(...args);
    req.end();
    return req;
  };

  return {
    STATUS_CODES,
    METHODS,
    IncomingMessage,
    OutgoingMessage,
    ServerResponse,
    ClientRequest,
    Server,
    Agent,
    globalAgent: new Agent({ keepAlive: true }),
    createServer: (...args: unknown[]) => new Server(...args),
    request,
    get,
    validateHeaderName,
    validateHeaderValue,
    maxHeaderSize: 16384,
    setMaxIdleHTTPParsers: () => {},
  };
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  (e as Error & { code: string }).code = 'ABORT_ERR';
  return e;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
