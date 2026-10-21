// SPDX-License-Identifier: Apache-2.0
// Instance service worker (scope "/"). Forwards every request on the instance
// origin, except ClientVM's own files, to the instance kernel's virtual ports.
// It runs on the instance origin, so it is only as trusted as the code there.
import { PORT_PATH_PREFIX, RESERVED_PATH_PREFIX, RpcEndpoint } from '@clientvm/protocol';
import type { HttpRpc, ServiceWorkerMessage, WireRequest, WireResponse } from '@clientvm/protocol';

declare const self: ServiceWorkerGlobalScope;

const INSTANCE_PAGE = `${RESERVED_PATH_PREFIX}instance.html`;
const KERNEL_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Paths Vite's dev server uses for the instance page itself (dev only). */
const DEV_PASSTHROUGH = import.meta.env.DEV ? ['/src/', '/@', '/node_modules/'] : [];

let kernel: RpcEndpoint<Record<string, never>, HttpRpc> | null = null;
let waiters: (() => void)[] = [];

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data as Partial<ServiceWorkerMessage> | null;
  const port = event.ports[0];
  const source = event.source as WindowClient | null;
  // Only the instance page (same origin, by construction of SW messaging) may hand us a kernel port.
  if (
    msg?.t !== 'clientvm:sw-connect' ||
    !port ||
    !source ||
    new URL(source.url).pathname !== INSTANCE_PAGE
  ) {
    return;
  }
  kernel = new RpcEndpoint<Record<string, never>, HttpRpc>(port, {});
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
});

/** Returns the kernel link, asking the instance page to reconnect if this SW restarted and lost it. */
async function getKernel(): Promise<RpcEndpoint<Record<string, never>, HttpRpc> | null> {
  if (kernel) return kernel;
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const page = pages.find((c) => new URL(c.url).pathname === INSTANCE_PAGE);
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
  if (url.pathname.startsWith(RESERVED_PATH_PREFIX)) return;
  if (DEV_PASSTHROUGH.some((p) => url.pathname.startsWith(p))) return;
  event.respondWith(forward(event.request, url));
});

async function forward(request: Request, url: URL): Promise<Response> {
  let port: number | null = null;
  let path = url.pathname;
  if (path.startsWith(PORT_PATH_PREFIX)) {
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
    headers: [...request.headers],
    body: hasBody ? new Uint8Array(await request.arrayBuffer()) : null,
  };

  // One retry: a kernel link can die silently (instance page reloaded).
  for (let attempt = 0; attempt < 2; attempt++) {
    const link = await getKernel();
    if (!link) return plain(503, 'This ClientVM instance is not running.', { 'retry-after': '1' });
    try {
      return toResponse(await withTimeout(link.call('fetch', wire), REQUEST_TIMEOUT_MS));
    } catch {
      if (kernel === link) kernel = null;
    }
  }
  return plain(504, 'The ClientVM instance did not respond.');
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function toResponse(res: WireResponse): Response {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599)
    return plain(502, 'Bad Gateway');
  // Bodies arrive by structured clone, so they are never SharedArrayBuffer-backed.
  const body = res.body as Uint8Array<ArrayBuffer>;
  return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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
