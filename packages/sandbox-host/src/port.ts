// SPDX-License-Identifier: Apache-2.0
// Bridge page on a port origin (<id>-p<port>.<sandbox-domain>), embedded by
// the controller (ADR 0008). It registers the service worker for this origin
// and hands it the channel the controller connected to the instance kernel.
import type { PortBridgeMessage, ServiceWorkerMessage } from '@clientvm/protocol';

const SW_URL = import.meta.env.DEV ? '/src/sw.ts' : '/__clientvm/sw.js';
const parentOrigin = new URLSearchParams(location.search).get('parent');

function send(msg: PortBridgeMessage, origin: string): void {
  window.parent.postMessage(msg, origin);
}

async function start(parent: string): Promise<void> {
  await navigator.serviceWorker.register(SW_URL, {
    scope: '/',
    type: 'module',
    updateViaCache: 'none',
  });
  const registration = await navigator.serviceWorker.ready;

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parent) return;
    const msg = event.data as Partial<PortBridgeMessage> | null;
    const channel = event.ports[0];
    if (
      msg?.t !== 'clientvm:port-connect' ||
      msg.v !== 1 ||
      !channel ||
      !Number.isInteger(msg.port)
    )
      return;
    const sw = registration.active;
    if (!sw) return;
    const connect: ServiceWorkerMessage = { t: 'clientvm:sw-connect', port: msg.port! };
    sw.postMessage(connect, [channel]);
    send({ t: 'clientvm:port-ready', v: 1 }, parent);
  });

  // The SW asks again after a restart, and a new SW version needs its own link.
  const reconnect = () => send({ t: 'clientvm:port-reconnect', v: 1 }, parent);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if ((event.data as Partial<ServiceWorkerMessage> | null)?.t === 'clientvm:sw-reconnect')
      reconnect();
  });
  navigator.serviceWorker.addEventListener('controllerchange', reconnect);
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', (e) => {
      if ((e.target as ServiceWorker).state === 'activated') reconnect();
    });
  });

  send({ t: 'clientvm:port-hello', v: 1 }, parent);
}

if (window.parent === window || !parentOrigin || !('serviceWorker' in navigator)) {
  document.body.textContent = 'ClientVM port bridge: must be embedded by a ClientVM controller.';
} else {
  void start(parentOrigin);
}
