// SPDX-License-Identifier: Apache-2.0

/**
 * Contract between an instance's service workers and its kernel: a service
 * worker forwards HTTP requests made on its origin (preview iframes on a port
 * origin, fetch from processes on the instance origin) to the kernel's virtual
 * servers.
 */

export interface WireRequest {
  /** Target virtual port; null routes to the primary (first opened) port. */
  port: number | null;
  method: string;
  /** Path plus query string, e.g. `/assets/app.js?v=1`. */
  path: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

export interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** Whole body, or a stream (transferred) for responses produced incrementally. */
  body: Uint8Array | ReadableStream<Uint8Array>;
}

export type HttpRpc = {
  fetch(request: WireRequest): Promise<WireResponse>;
  /**
   * Opens an HTTP upgrade (WebSocket) to a virtual port. `socket` carries the
   * raw bytes both ways: the server's 101 response and frames come back as
   * `Uint8Array` messages, and `null` means the other side closed.
   */
  upgrade(request: WireRequest, socket: MessagePort): Promise<void>;
};

/** Messages between ClientVM pages and their service worker. */
export type ServiceWorkerMessage =
  /**
   * Page → SW, with a MessagePort connected to the kernel. `port` is set on a
   * port origin (`<id>-p<port>`): every request there goes to that port.
   */
  | { t: 'clientvm:sw-connect'; port?: number }
  /** SW → page: the SW restarted and lost its link; please connect again. */
  | { t: 'clientvm:sw-reconnect' }
  /**
   * Preview page → SW, with a MessagePort for a WebSocket tunnel. `headers`
   * are the upgrade request's (Upgrade, Sec-WebSocket-Key, ...).
   */
  | { t: 'clientvm:ws-open'; url: string; headers: [string, string][] };

/** Messages between the controller and the bridge page on a port origin. */
export type PortBridgeMessage =
  | { t: 'clientvm:port-hello'; v: 1 }
  /** Controller → bridge, with a MessagePort whose other end the kernel serves for `port`. */
  | { t: 'clientvm:port-connect'; v: 1; port: number }
  /** Bridge → controller: the channel reached the port origin's service worker. */
  | { t: 'clientvm:port-ready'; v: 1 }
  /** Bridge → controller: the port origin's SW lost its link; send a new channel. */
  | { t: 'clientvm:port-reconnect'; v: 1 };

/** Paths on an instance origin that always go to the network (ClientVM's own files). */
export const RESERVED_PATH_PREFIX = '/__clientvm/';
/** `/__port/<n>/...` addresses a non-primary virtual port from the instance origin. */
export const PORT_PATH_PREFIX = '/__port/';
/** Script injected into HTML previews: routes same-origin WebSockets through the SW. */
export const WS_SHIM_PATH = '/__clientvm/ws-shim.js';

/**
 * Set on the kernel's 502 for a port nothing listens on, so in-instance
 * clients (fetch, http, curl) report ECONNREFUSED as Node and curl would.
 */
export const NO_LISTENER_HEADER = 'x-clientvm-no-listener';
/** The bridge page on a port origin. */
export const PORT_BRIDGE_PATH = '/__clientvm/port.html';

/** The DNS label of a port origin: `<instance id>-p<port>`. */
export const portLabel = (instanceId: string, port: number): string => `${instanceId}-p${port}`;
