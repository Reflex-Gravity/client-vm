// SPDX-License-Identifier: Apache-2.0
// The ClientVM service worker (scope "/"), registered on two kinds of origin:
//
// - the instance origin (`<id>.<sandbox-domain>`): forwards requests from
//   processes (module imports, fetch) to the kernel, `/__port/<n>/` to port n;
// - a port origin (`<id>-p<port>.<sandbox-domain>`): forwards every request
//   to that one virtual port, injects the WebSocket shim into HTML pages, and
//   tunnels the shim's WebSockets to the server.
//
// It runs on origins that also run instance code, so it is only as trusted as
// that code.
import {
  NET_PATH_PREFIX,
  PORT_BRIDGE_PATH,
  PORT_PATH_PREFIX,
  PREVIEW_AGENT_PATH,
  RESERVED_PATH_PREFIX,
  RpcEndpoint,
  WS_SHIM_PATH,
} from '@clientvm/protocol';
import type { HttpRpc, ServiceWorkerMessage, WireRequest, WireResponse } from '@clientvm/protocol';

declare const self: ServiceWorkerGlobalScope;

const INSTANCE_PAGE = `${RESERVED_PATH_PREFIX}instance.html`;
/** Reserved paths the kernel answers: ES modules from the VFS and resolution-error modules. */
const KERNEL_ROUTES = [`${RESERVED_PATH_PREFIX}fs/`, `${RESERVED_PATH_PREFIX}error/`];
const KERNEL_TIMEOUT_MS = 3000;
/** Time to the response head; bodies then stream for as long as the server writes. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Paths Vite's dev server uses for the instance page itself (dev only, instance origin only). */
const DEV_PASSTHROUGH = import.meta.env.DEV ? ['/src/', '/@', '/node_modules/'] : [];
/** Request headers never forwarded: the SW cannot pass compressed bodies through as-is. */
const DROP_REQUEST_HEADERS = new Set(['accept-encoding']);

type KernelLink = RpcEndpoint<Record<string, never>, HttpRpc>;

let kernel: KernelLink | null = null;
/** Set on a port origin: the virtual port every request goes to. */
let fixedPort: number | null = null;
let waiters: (() => void)[] = [];

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const isLinkPage = (url: string) => {
  const path = new URL(url).pathname;
  return path === INSTANCE_PAGE || path === PORT_BRIDGE_PATH;
};

self.addEventListener('message', (event) => {
  const msg = event.data as Partial<ServiceWorkerMessage> | null;
  const port = event.ports[0];
  const source = event.source as WindowClient | null;
  if (!msg || !port || !source) return;
  if (msg.t === 'clientvm:ws-open') {
    void openTunnel(msg as Extract<ServiceWorkerMessage, { t: 'clientvm:ws-open' }>, port);
    return;
  }
  // Only ClientVM's own pages (same origin by construction) may hand us a kernel link.
  if (msg.t !== 'clientvm:sw-connect' || !isLinkPage(source.url)) return;
  fixedPort = typeof msg.port === 'number' && Number.isInteger(msg.port) ? msg.port : null;
  kernel = new RpcEndpoint<Record<string, never>, HttpRpc>(port, {});
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
});

/** Returns the kernel link, asking a ClientVM page to reconnect if this SW restarted and lost it. */
async function getKernel(): Promise<KernelLink | null> {
  if (kernel) return kernel;
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const page = pages.find((c) => isLinkPage(c.url));
  if (!page) return null;
  const linked = new Promise<void>((resolve) => {
    waiters.push(resolve);
    setTimeout(resolve, KERNEL_TIMEOUT_MS);
  });
  const reconnect: ServiceWorkerMessage = { t: 'clientvm:sw-reconnect' };
  page.postMessage(reconnect);
  await linked;
  return kernel;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(RESERVED_PATH_PREFIX)) {
    // ClientVM's own files go to the network, except the module routes the kernel serves.
    if (fixedPort !== null || !KERNEL_ROUTES.some((p) => url.pathname.startsWith(p))) return;
  }
  if (fixedPort === null && DEV_PASSTHROUGH.some((p) => url.pathname.startsWith(p))) return;
  event.respondWith(forward(event.request, url));
});

function wireHeaders(headers: Headers, url: URL): [string, string][] {
  const out = [...headers].filter(([k]) => !DROP_REQUEST_HEADERS.has(k));
  // Host is a forbidden header: the browser sends it but the SW cannot read it.
  if (!headers.has('host')) out.unshift(['host', url.host]);
  return out;
}

async function forward(request: Request, url: URL): Promise<Response> {
  // Make sure we know whether this is a port origin before routing.
  const first = await getKernel();
  let port: number | null = fixedPort;
  let path = url.pathname;
  let peer: string | undefined;
  if (port === null && path.startsWith(NET_PATH_PREFIX)) {
    // A process reaching http://<peer>.internal:<port>/ (another instance, or the mailbox).
    const match = /^\/__net\/([a-z0-9-]{1,63})\/(\d{1,5})(\/.*)?$/.exec(path);
    if (!match) return plain(404, 'Not Found');
    peer = match[1]!;
    port = Number(match[2]);
    path = match[3] ?? '/';
  } else if (port === null && path.startsWith(PORT_PATH_PREFIX)) {
    const match = /^\/__port\/(\d{1,5})(\/.*)?$/.exec(path);
    if (!match) return plain(404, 'Not Found');
    port = Number(match[1]);
    path = match[2] ?? '/';
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const wire: WireRequest = {
    port,
    method: request.method,
    path: path + url.search,
    headers: wireHeaders(request.headers, url),
    body: hasBody ? new Uint8Array(await request.arrayBuffer()) : null,
  };
  if (peer !== undefined) {
    wire.peer = peer;
    wire.headers = [
      ['host', `${peer}.internal${port === 80 ? '' : `:${port}`}`],
      ...wire.headers.filter(([k]) => k !== 'host'),
    ];
  }
  // Content-Length is forbidden for scripts too; servers use it to detect a body.
  if (wire.body) {
    wire.headers = wire.headers.filter(([k]) => k !== 'content-length');
    wire.headers.push(['content-length', String(wire.body.length)]);
  }

  // One retry: a kernel link can die silently (instance page reloaded).
  let link = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    link ??= await getKernel();
    if (!link) return plain(503, 'This ClientVM instance is not running.', { 'retry-after': '1' });
    try {
      const res = await withTimeout(link.call('fetch', wire), REQUEST_TIMEOUT_MS);
      return await toResponse(res, request);
    } catch {
      if (kernel === link) kernel = null;
      link = null;
    }
  }
  return plain(504, 'The ClientVM instance did not respond.');
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

async function toResponse(res: WireResponse, request: Request): Promise<Response> {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599)
    return plain(502, 'Bad Gateway');
  const nullBody = NULL_BODY_STATUS.has(res.status) || request.method === 'HEAD';
  let body: BodyInit | null = nullBody
    ? null
    : (res.body as Uint8Array<ArrayBuffer> | ReadableStream);
  const headers = new Headers();
  for (const [k, v] of res.headers) {
    try {
      headers.append(k, v);
    } catch {
      // not a valid header for a Response; drop it
    }
  }
  if (body !== null && fixedPort !== null && isHtmlDocument(request, headers)) {
    body = await injectShim(res.body);
    headers.delete('content-length');
  }
  if (body !== null && headers.has('content-encoding')) {
    // The page would receive the bytes as-is; decode them like the network stack would.
    const encoding = headers.get('content-encoding')!.toLowerCase();
    if (encoding === 'gzip' || encoding === 'deflate') {
      const stream = toStream(body as Uint8Array | ReadableStream<Uint8Array>);
      body = stream.pipeThrough(
        new DecompressionStream(encoding) as unknown as TransformStream<Uint8Array, Uint8Array>,
      );
      headers.delete('content-encoding');
      headers.delete('content-length');
    }
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

function toStream(body: Uint8Array | ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new Response(body as Uint8Array<ArrayBuffer>).body!;
}

function isHtmlDocument(request: Request, headers: Headers): boolean {
  const type = headers.get('content-type') ?? '';
  const doc =
    request.destination === 'document' ||
    request.destination === 'iframe' ||
    request.mode === 'navigate';
  return doc && /^text\/html\b/i.test(type);
}

/**
 * Inserts the WebSocket shim as the first script of an HTML page. It is a
 * module script, so it runs before the page's own module scripts (Vite's
 * client among them) but after classic scripts.
 */
/**
 * Runs before any page script (classic, inline, first in <head>) and buffers
 * console output and errors until the preview agent module takes them over.
 */
const CONSOLE_CAPTURE =
  '(function(){var w=window,c={q:[],sink:null};w.__clientvmConsole=c;' +
  'function s(l,a){var e=[l,a,Date.now()];if(c.sink)c.sink(e);else if(c.q.length<500)c.q.push(e)}' +
  "['log','info','warn','error','debug'].forEach(function(l){var o=console[l];" +
  'console[l]=function(){var a=Array.prototype.slice.call(arguments);s(l,a);return o.apply(this,a)}});' +
  "w.addEventListener('error',function(e){s('error',[e.error||e.message])});" +
  "w.addEventListener('unhandledrejection',function(e){s('error',['Unhandled promise rejection:',e.reason])})})();";

async function injectShim(
  body: Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const html = await new Response(body as BodyInit).text();
  const tag =
    `<script>${CONSOLE_CAPTURE}</script>` +
    `<script type="module" src="${WS_SHIM_PATH}"></script>` +
    `<script type="module" src="${PREVIEW_AGENT_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const out = head
    ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    : /<html(\s[^>]*)?>/i.test(html)
      ? html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}${tag}`)
      : tag + html;
  return new TextEncoder().encode(out);
}

/** Connects a preview page's WebSocket (via the shim) to the server's upgrade handler. */
async function openTunnel(
  msg: Extract<ServiceWorkerMessage, { t: 'clientvm:ws-open' }>,
  socket: MessagePort,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(msg.url);
  } catch {
    socket.postMessage(null);
    return;
  }
  const link = await getKernel();
  if (!link || fixedPort === null || !Array.isArray(msg.headers)) {
    socket.postMessage(null);
    return;
  }
  const wire: WireRequest = {
    port: fixedPort,
    method: 'GET',
    path: url.pathname + url.search,
    headers: msg.headers.filter(
      (h) => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string',
    ),
    body: null,
  };
  try {
    await link.callTransfer('upgrade', [wire, socket], [socket]);
  } catch {
    // the page sees the tunnel close
  }
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
