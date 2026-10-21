// SPDX-License-Identifier: Apache-2.0

/**
 * Contract between an instance's service worker and its kernel: the service
 * worker forwards HTTP requests made on the instance origin (preview iframes,
 * fetch from processes) to the kernel's virtual servers.
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
  body: Uint8Array;
}

export type HttpRpc = {
  fetch(request: WireRequest): Promise<WireResponse>;
};

/** Messages between the instance page and its service worker. */
export type ServiceWorkerMessage =
  /** Page → SW, with a MessagePort connected to the kernel. */
  | { t: 'clientvm:sw-connect' }
  /** SW → page: the SW restarted and lost its port; please connect again. */
  | { t: 'clientvm:sw-reconnect' };

/** Paths on an instance origin that always go to the network (ClientVM's own files). */
export const RESERVED_PATH_PREFIX = '/__clientvm/';
/** `/__port/<n>/...` addresses a non-primary virtual port. */
export const PORT_PATH_PREFIX = '/__port/';
