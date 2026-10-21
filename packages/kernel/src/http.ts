// SPDX-License-Identifier: Apache-2.0
import { SystemError } from '@clientvm/protocol';
import type { WireRequest, WireResponse } from '@clientvm/protocol';
import type { MemoryVfs } from '@clientvm/vfs';

/** Handles one HTTP request for a virtual port. */
export type HttpHandler = (request: WireRequest) => WireResponse | Promise<WireResponse>;

/** A virtual server: requests, and optionally upgrades (raw byte sockets over a MessagePort). */
export interface HttpServer {
  fetch: HttpHandler;
  upgrade?(request: WireRequest, socket: MessagePort): void;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

export function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

const text = (status: number, statusText: string, body: string): WireResponse => ({
  status,
  statusText,
  headers: [['content-type', 'text/plain; charset=utf-8']],
  body: new TextEncoder().encode(body),
});

/**
 * Serves files under `root` from the VFS: GET/HEAD only, `index.html` for
 * directories, 404 otherwise. Request paths never escape `root` lexically
 * (symlinks inside it are followed; they can only reach this instance's own files).
 */
export function staticHandler(vfs: MemoryVfs, root: string): HttpHandler {
  const base = root.replace(/\/+$/, '') || '';
  return (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return {
        ...text(405, 'Method Not Allowed', 'Method Not Allowed'),
        headers: [['allow', 'GET, HEAD']],
      };
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.path, 'http://x').pathname);
    } catch {
      return text(400, 'Bad Request', 'Bad Request');
    }
    if (pathname.includes('\0')) return text(400, 'Bad Request', 'Bad Request');
    const segments: string[] = [];
    for (const part of pathname.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') segments.pop();
      else segments.push(part);
    }
    let file = `${base}/${segments.join('/')}`;
    try {
      if ((vfs.stat(file).mode & 0o170000) === 0o040000)
        file = `${file.replace(/\/$/, '')}/index.html`;
      const data = vfs.readFile(file).slice();
      return {
        status: 200,
        statusText: 'OK',
        headers: [
          ['content-type', contentType(file)],
          ['content-length', String(data.length)],
          ['cache-control', 'no-cache'],
        ],
        body: request.method === 'HEAD' ? new Uint8Array(0) : data,
      };
    } catch (err) {
      if (
        err instanceof SystemError &&
        (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR')
      ) {
        return text(404, 'Not Found', 'Not Found');
      }
      throw err;
    }
  };
}

/** The instance's virtual ports. Requests arrive from the service workers. */
export class HttpRouter {
  private readonly servers = new Map<number, HttpServer>();
  private primary: number | null = null;
  private readonly onOpen: (port: number, primary: boolean) => void;
  private readonly onClose: (port: number) => void;

  constructor(
    onOpen: (port: number, primary: boolean) => void,
    onClose: (port: number) => void = () => {},
  ) {
    this.onOpen = onOpen;
    this.onClose = onClose;
  }

  get ports(): { port: number; primary: boolean }[] {
    return [...this.servers.keys()].map((port) => ({ port, primary: port === this.primary }));
  }

  listen(port: number, server: HttpHandler | HttpServer): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new SystemError('EINVAL', 'listen');
    if (this.servers.has(port)) throw new SystemError('EADDRINUSE', 'listen');
    this.servers.set(port, typeof server === 'function' ? { fetch: server } : server);
    this.primary ??= port;
    this.onOpen(port, port === this.primary);
  }

  close(port: number): void {
    if (!this.servers.delete(port)) return;
    if (this.primary === port) this.primary = this.servers.keys().next().value ?? null;
    this.onClose(port);
  }

  private resolve(request: WireRequest): { port: number | null; server: HttpServer | undefined } {
    const port = request.port ?? this.primary;
    return { port, server: port === null ? undefined : this.servers.get(port) };
  }

  async handle(request: WireRequest): Promise<WireResponse> {
    const { port, server } = this.resolve(request);
    if (!server) {
      return text(
        502,
        'Bad Gateway',
        port === null
          ? 'No server is listening in this instance.'
          : `Nothing is listening on port ${port}.`,
      );
    }
    try {
      return await server.fetch(request);
    } catch (err) {
      return text(500, 'Internal Server Error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Routes an upgrade; the socket is closed when nothing accepts it. */
  upgrade(request: WireRequest, socket: MessagePort): void {
    const { server } = this.resolve(request);
    if (!server?.upgrade) {
      socket.postMessage(null);
      socket.close();
      return;
    }
    server.upgrade(request, socket);
  }
}
