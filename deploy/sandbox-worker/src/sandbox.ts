// SPDX-License-Identifier: Apache-2.0
// What the demo sandbox answers, independent of the Workers runtime so it can
// be unit tested (sandbox.test.ts).

export interface SandboxEnv {
  /** Host names served are `<label><HOST_SUFFIX>`, e.g. `-cvm.joeldsouza.me`. */
  HOST_SUFFIX: string;
  /** Space-separated origins allowed to embed instances (CSP frame-ancestors). */
  FRAME_ANCESTORS: string;
}

/** An instance id or port label (`<id>-p<port>`): a DNS label. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Scripts whose URL never changes; browsers must revalidate them. */
const STABLE = new Set([
  '/__clientvm/sw.js',
  '/__clientvm/ws-shim.js',
  '/__clientvm/agent.js',
  '/__clientvm/instance.html',
  '/__clientvm/port.html',
]);

export function isSandboxHost(hostname: string, suffix: string): boolean {
  if (!hostname.endsWith(suffix)) return false;
  return LABEL.test(hostname.slice(0, -suffix.length));
}

export async function sandboxResponse(
  request: Request,
  env: SandboxEnv,
  assets: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  let response: Response;
  if (!isSandboxHost(url.hostname, env.HOST_SUFFIX)) {
    response = new Response('Not a sandbox origin\n', { status: 404 });
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    response = new Response('Method not allowed\n', {
      status: 405,
      headers: { allow: 'GET, HEAD' },
    });
  } else if (!url.pathname.startsWith('/__clientvm/')) {
    // Everything else on an instance origin belongs to the instance's own
    // servers, answered by its service worker. Reaching here means no service
    // worker controls the page (yet).
    response = new Response('Not found\n', { status: 404 });
  } else {
    response = await assets(request);
  }

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.set('Document-Isolation-Policy', 'isolate-and-require-corp');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Content-Security-Policy', `frame-ancestors ${env.FRAME_ANCESTORS}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (url.pathname === '/__clientvm/sw.js') headers.set('Service-Worker-Allowed', '/');
  if (STABLE.has(url.pathname)) headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
