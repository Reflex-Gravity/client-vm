// SPDX-License-Identifier: Apache-2.0
// `dns` and `tls`. Browsers resolve names and do TLS inside fetch, so these
// exist for code that loads them: local names resolve to loopback, other
// names to a placeholder address, and TLS client sockets cannot connect.

import type { NetModule } from './net.ts';
import { isIPv4, isIPv6, isLocalHost, netError } from './net.ts';

/** Placeholder for names the instance cannot resolve itself (requests go through fetch by name). */
const UNRESOLVED = '0.0.0.0';

type LookupCb = (
  err: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

function lookupSync(host: string): { address: string; family: number } {
  if (isIPv4(host)) return { address: host, family: 4 };
  if (isIPv6(host)) return { address: host, family: 6 };
  if (isLocalHost(host)) return { address: '127.0.0.1', family: 4 };
  return { address: UNRESOLVED, family: 4 };
}

export function createDns(): Record<string, unknown> {
  const lookup = (host: string, opts?: unknown, cb?: LookupCb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as LookupCb;
    const all =
      typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all === true;
    const r = lookupSync(String(host));
    queueMicrotask(() => (all ? callback(null, [r]) : callback(null, r.address, r.family)));
  };
  const noData =
    (syscall: string) =>
    (host: string, ...rest: unknown[]) => {
      const cb = rest.pop() as (e: Error) => void;
      queueMicrotask(() => cb(netError('ENOTFOUND', syscall, host)));
    };
  const promises = {
    lookup: async (host: string, opts?: { all?: boolean }) => {
      const r = lookupSync(String(host));
      return opts?.all ? [r] : r;
    },
    resolve: async (host: string) => {
      throw netError('ENOTFOUND', 'queryA', host);
    },
    resolve4: async (host: string) => {
      throw netError('ENOTFOUND', 'queryA', host);
    },
    resolve6: async (host: string) => {
      throw netError('ENOTFOUND', 'queryAaaa', host);
    },
    setDefaultResultOrder: () => {},
    getDefaultResultOrder: () => 'verbatim',
    getServers: () => [],
    setServers: () => {},
  };
  return {
    lookup,
    lookupService: (
      address: string,
      port: number,
      cb: (e: Error | null, h?: string, s?: string) => void,
    ) =>
      queueMicrotask(() =>
        cb(
          null,
          isLocalHost(address) || address === '127.0.0.1' ? 'localhost' : address,
          String(port),
        ),
      ),
    resolve: noData('queryA'),
    resolve4: noData('queryA'),
    resolve6: noData('queryAaaa'),
    resolveMx: noData('queryMx'),
    resolveTxt: noData('queryTxt'),
    resolveSrv: noData('querySrv'),
    resolveCname: noData('queryCname'),
    reverse: noData('getHostByAddr'),
    setDefaultResultOrder: () => {},
    getDefaultResultOrder: () => 'verbatim',
    getServers: () => [],
    setServers: () => {},
    promises,
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    NOTFOUND: 'ENOTFOUND',
    NODATA: 'ENODATA',
    Resolver: class Resolver {
      resolve = noData('queryA');
      resolve4 = noData('queryA');
      resolve6 = noData('queryAaaa');
      setServers() {}
      getServers() {
        return [];
      }
      cancel() {}
    },
  };
}

export function createTls(net: NetModule): Record<string, unknown> {
  const connect = (...args: unknown[]) => {
    const Socket = net.module['Socket'] as new () => { destroy(e: Error): unknown };
    const sock = new Socket();
    const opts = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as {
      host?: string;
      port?: number;
    };
    const host = typeof args[1] === 'string' ? args[1] : (opts.host ?? 'localhost');
    const port = typeof args[0] === 'number' ? args[0] : (opts.port ?? 443);
    queueMicrotask(() => {
      const err = netError('ECONNREFUSED', 'connect', host, port);
      err.message += ' (TLS sockets are not available in the browser; use https/fetch)';
      sock.destroy(err);
    });
    return sock;
  };
  return {
    connect,
    createServer: (...args: unknown[]) =>
      (net.module['createServer'] as (...a: unknown[]) => unknown)(
        ...args.filter((a) => typeof a === 'function'),
      ),
    get Server() {
      return net.module['Server'];
    },
    get TLSSocket() {
      return net.module['Socket'];
    },
    createSecureContext: () => ({ context: {} }),
    checkServerIdentity: () => undefined,
    getCiphers: () => [
      'tls_aes_128_gcm_sha256',
      'tls_aes_256_gcm_sha384',
      'tls_chacha20_poly1305_sha256',
    ],
    rootCertificates: [],
    DEFAULT_ECDH_CURVE: 'auto',
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_CIPHERS: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  };
}
