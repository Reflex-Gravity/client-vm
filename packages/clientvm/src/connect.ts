// SPDX-License-Identifier: Apache-2.0
import type { HandshakeMessage, InstanceInit } from '@clientvm/protocol';
import { ClientVMError } from './errors.ts';

export interface ConnectOptions {
  /** Instance origin, e.g. `https://<id>.sandbox.example.dev`. */
  origin: string;
  /** Path of the instance page on the sandbox origin. */
  path: string;
  container: HTMLElement;
  timeoutMs: number;
  init: InstanceInit;
}

export interface Connection {
  iframe: HTMLIFrameElement;
  port: MessagePort;
}

/**
 * Loads the instance page in a hidden iframe and hands it a MessagePort.
 *
 * Handshake: the page posts `hello` to its parent; we accept it only from that
 * iframe's window and the exact instance origin, check the page is
 * cross-origin isolated, then post `connect` with the port, targeted at that
 * origin. The page in turn accepts `connect` only from its parent's origin.
 */
export function connectInstance(options: ConnectOptions): Promise<Connection> {
  const { origin, path, container, timeoutMs, init } = options;
  const iframe = document.createElement('iframe');
  const url = new URL(path, origin);
  url.searchParams.set('parent', location.origin);
  iframe.src = url.href;
  // Lets the instance use cross-origin isolation when the host page is itself isolated.
  iframe.allow = 'cross-origin-isolated';
  iframe.title = 'ClientVM instance';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: 'absolute',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const fail = (err: Error) => {
      cleanup();
      iframe.remove();
      reject(err);
    };
    const timer = setTimeout(
      () =>
        fail(
          new ClientVMError(
            `instance at ${origin} did not respond within ${timeoutMs} ms`,
            'ERR_BOOT_TIMEOUT',
          ),
        ),
      timeoutMs,
    );
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== origin) return;
      const msg = event.data as Partial<HandshakeMessage> | null;
      if (msg?.t !== 'clientvm:hello' || msg.v !== 1) return;
      if (msg.crossOriginIsolated !== true) {
        fail(
          new ClientVMError(
            `instance page at ${origin} is not cross-origin isolated; serve it with ` +
              '"Document-Isolation-Policy: isolate-and-require-corp" (see docs/hosting.md)',
            'ERR_NOT_ISOLATED',
          ),
        );
        return;
      }
      const channel = new MessageChannel();
      const transfer: Transferable[] = [channel.port2];
      // Move (don't copy) image chunks; each buffer may only be listed once.
      const buffers = new Set<ArrayBuffer>();
      for (const chunk of init.image ?? []) {
        if (chunk.buffer instanceof ArrayBuffer) buffers.add(chunk.buffer);
      }
      transfer.push(...buffers);
      const connect: HandshakeMessage = { t: 'clientvm:connect', v: 1, init };
      iframe.contentWindow!.postMessage(connect, origin, transfer);
      cleanup();
      resolve({ iframe, port: channel.port1 });
    };
    window.addEventListener('message', onMessage);
    container.append(iframe);
  });
}
