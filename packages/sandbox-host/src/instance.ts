// SPDX-License-Identifier: Apache-2.0
// The instance page: runs on <id>.<sandbox-domain>, embedded by the controller.
// It only performs the handshake and starts the kernel worker; the controller
// then talks to the kernel directly over the transferred MessagePort.
import type { KernelBootMessage } from '@clientvm/kernel';
import type { HandshakeMessage } from '@clientvm/protocol';

const parentOrigin = new URLSearchParams(location.search).get('parent');

function start(parent: string): void {
  let connected = false;
  window.addEventListener('message', (event) => {
    // Only our embedder, at the origin it claimed, may connect, and only once.
    if (connected || event.source !== window.parent || event.origin !== parent) return;
    const msg = event.data as Partial<HandshakeMessage> | null;
    const port = event.ports[0];
    if (msg?.t !== 'clientvm:connect' || msg.v !== 1 || !msg.init || !port) return;
    connected = true;

    const kernel = new Worker(new URL('./kernel.worker.ts', import.meta.url), {
      type: 'module',
      name: `clientvm-kernel-${msg.init.id}`,
    });
    const boot: KernelBootMessage = { t: 'clientvm:kernel-boot', init: msg.init, port };
    const buffers = new Set<ArrayBuffer>();
    for (const chunk of msg.init.image ?? []) {
      if (chunk.buffer instanceof ArrayBuffer) buffers.add(chunk.buffer);
    }
    kernel.postMessage(boot, [port, ...buffers]);
  });

  const hello: HandshakeMessage = {
    t: 'clientvm:hello',
    v: 1,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
  // targetOrigin pins delivery to the claimed parent; a page lying about its origin never hears back.
  window.parent.postMessage(hello, parent);
}

if (window.parent === window || !parentOrigin) {
  document.body.textContent = 'ClientVM instance page: must be embedded by a ClientVM controller.';
} else {
  start(parentOrigin);
}
