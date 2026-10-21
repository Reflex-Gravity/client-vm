// SPDX-License-Identifier: Apache-2.0

/** Every module name Node 24 reports in `builtinModules`. */
export const NODE_BUILTINS: readonly string[] = [
  '_http_agent',
  '_http_client',
  '_http_common',
  '_http_incoming',
  '_http_outgoing',
  '_http_server',
  '_stream_duplex',
  '_stream_passthrough',
  '_stream_readable',
  '_stream_transform',
  '_stream_wrap',
  '_stream_writable',
  '_tls_common',
  '_tls_wrap',
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];
/** Builtins that only exist with the `node:` prefix. */
const PREFIX_ONLY = new Set(['sea', 'sqlite', 'test', 'test/reporters']);
const BUILTIN_SET = new Set(NODE_BUILTINS);

export function isBuiltin(request: string): boolean {
  if (request.startsWith('node:')) {
    const name = request.slice(5);
    return BUILTIN_SET.has(name) || PREFIX_ONLY.has(name);
  }
  return BUILTIN_SET.has(request);
}
