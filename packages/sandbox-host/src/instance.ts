// SPDX-License-Identifier: Apache-2.0
// The instance page: runs on <id>.<sandbox-domain>, embedded by the controller.
// It only performs the handshake and starts the kernel worker; the controller
// then talks to the kernel directly over the transferred MessagePort.
import type {
  KernelBootMessage,
  KernelFlushMessage,
  KernelHttpPortMessage,
  KernelMeasureMemoryMessage,
  MemoryReply,
} from '@clientvm/kernel';
import type { HandshakeMessage, ServiceWorkerMessage } from '@clientvm/protocol';

// Built to a stable path (see vite.config.ts); Vite serves the source in dev.
const SW_URL = import.meta.env.DEV ? '/src/sw.ts' : '/__clientvm/sw.js';

const parentOrigin = new URLSearchParams(location.search).get('parent');

/**
 * Resolves once the instance service worker controls this page. Workers take
 * their controller from their creator when they start, so the kernel (and every
 * process it spawns) must be created after this, or module imports and fetches
 * from processes would bypass the service worker.
 */
function controlledByServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  const registered = navigator.serviceWorker.register(SW_URL, {
    scope: '/',
    type: 'module',
    updateViaCache: 'none',
  });
  if (navigator.serviceWorker.controller) return registered.then(() => undefined);
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });
}

function start(parent: string): void {
  // Registration overlaps the handshake round trip with the controller.
  const ready = controlledByServiceWorker();
  let connected = false;
  window.addEventListener('message', (event) => {
    // Only our embedder, at the origin it claimed, may connect, and only once.
    if (connected || event.source !== window.parent || event.origin !== parent) return;
    const msg = event.data as Partial<HandshakeMessage> | null;
    const port = event.ports[0];
    if (msg?.t !== 'clientvm:connect' || msg.v !== 1 || !msg.init || !port) return;
    connected = true;
    void ready.then(() => bootKernel(msg.init!, port));
  });

  const hello: HandshakeMessage = {
    t: 'clientvm:hello',
    v: 1,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
  // targetOrigin pins delivery to the claimed parent; a page lying about its origin never hears back.
  window.parent.postMessage(hello, parent);
}

function bootKernel(init: KernelBootMessage['init'], port: MessagePort): void {
  const kernel = new Worker(new URL('./kernel.worker.ts', import.meta.url), {
    type: 'module',
    name: `clientvm-kernel-${init.id}`,
  });
  const boot: KernelBootMessage = { t: 'clientvm:kernel-boot', init: init, port };
  const buffers = new Set<ArrayBuffer>();
  for (const chunk of init.image ?? []) {
    if (chunk.buffer instanceof ArrayBuffer) buffers.add(chunk.buffer);
  }
  kernel.postMessage(boot, [port, ...buffers]);
  void linkServiceWorker(kernel);
  kernel.addEventListener('message', (event) => {
    const msg = event.data as Partial<KernelMeasureMemoryMessage> | null;
    if (msg?.t === 'clientvm:measure-memory' && msg.port) void measureMemory(msg.port);
  });

  // Best effort: the page may be gone before an async flush completes.
  // Instance.flush() is the durability point.
  const flush: KernelFlushMessage = { t: 'clientvm:flush' };
  window.addEventListener('pagehide', () => kernel.postMessage(flush));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') kernel.postMessage(flush);
  });
}

/** Measures this origin's agent cluster (page, kernel, processes) for the kernel. */
async function measureMemory(port: MessagePort): Promise<void> {
  const perf = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };
  let bytes: number | null = null;
  try {
    if (perf.measureUserAgentSpecificMemory)
      bytes = (await perf.measureUserAgentSpecificMemory()).bytes;
  } catch {
    // Not cross-origin isolated, or the measurement was aborted.
  }
  const reply: MemoryReply = { bytes };
  port.postMessage(reply);
  port.close();
}

/**
 * Registers the instance service worker and gives it a MessagePort to the
 * kernel. Repeated when the SW restarts (it asks via `sw-reconnect`) or a new
 * SW version takes over (`controllerchange`).
 */
async function linkServiceWorker(kernel: Worker): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const connect = async () => {
    const registration = await navigator.serviceWorker.ready;
    const sw = registration.active;
    if (!sw) return;
    const channel = new MessageChannel();
    const toKernel: KernelHttpPortMessage = { t: 'clientvm:http-port', port: channel.port1 };
    kernel.postMessage(toKernel, [channel.port1]);
    const toSw: ServiceWorkerMessage = { t: 'clientvm:sw-connect' };
    sw.postMessage(toSw, [channel.port2]);
  };
  navigator.serviceWorker.addEventListener('message', (event) => {
    if ((event.data as Partial<ServiceWorkerMessage> | null)?.t === 'clientvm:sw-reconnect')
      void connect();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => void connect());
  await connect();
}

if (window.parent === window || !parentOrigin) {
  document.body.textContent = 'ClientVM instance page: must be embedded by a ClientVM controller.';
} else {
  start(parentOrigin);
}
