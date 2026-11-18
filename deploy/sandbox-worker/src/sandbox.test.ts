// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isSandboxHost, sandboxResponse } from './sandbox.ts';

const env = {
  HOST_SUFFIX: '-cvm.joeldsouza.me',
  FRAME_ANCESTORS: 'https://clientvm.joeldsouza.me',
};
const assets = async (r: Request) =>
  new Response(`asset ${new URL(r.url).pathname}`, {
    headers: { 'content-type': 'text/javascript', 'set-cookie': 'a=b' },
  });
const get = (url: string, init?: RequestInit) =>
  sandboxResponse(new Request(url, init), env, assets);

describe('demo sandbox worker', () => {
  it('accepts instance and port labels only', () => {
    expect(isSandboxHost('k3x9abcdefghijkl-cvm.joeldsouza.me', env.HOST_SUFFIX)).toBe(true);
    expect(isSandboxHost('k3x9abcdefghijkl-p5173-cvm.joeldsouza.me', env.HOST_SUFFIX)).toBe(true);
    expect(isSandboxHost('-cvm.joeldsouza.me', env.HOST_SUFFIX)).toBe(false);
    expect(isSandboxHost('a.b-cvm.joeldsouza.me', env.HOST_SUFFIX)).toBe(false);
    expect(isSandboxHost('clientvm.joeldsouza.me', env.HOST_SUFFIX)).toBe(false);
    expect(isSandboxHost('x-cvm.joeldsouza.me.evil.dev', env.HOST_SUFFIX)).toBe(false);
  });

  it('serves /__clientvm/ with the isolation headers and no cookies', async () => {
    const res = await get('https://abc-cvm.joeldsouza.me/__clientvm/assets/kernel-1.js');
    expect(await res.text()).toBe('asset /__clientvm/assets/kernel-1.js');
    expect(res.headers.get('document-isolation-policy')).toBe('isolate-and-require-corp');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://clientvm.joeldsouza.me',
    );
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('lets the service worker control the whole origin and be revalidated', async () => {
    const res = await get('https://abc-cvm.joeldsouza.me/__clientvm/sw.js');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves nothing outside /__clientvm/, nor on other hosts or methods', async () => {
    const app = await get('https://abc-p5173-cvm.joeldsouza.me/index.html');
    expect(app.status).toBe(404);
    expect(app.headers.get('document-isolation-policy')).toBe('isolate-and-require-corp');
    expect((await get('https://clientvm.joeldsouza.me/__clientvm/sw.js')).status).toBe(404);
    const post = await get('https://abc-cvm.joeldsouza.me/__clientvm/sw.js', { method: 'POST' });
    expect(post.status).toBe(405);
  });
});
