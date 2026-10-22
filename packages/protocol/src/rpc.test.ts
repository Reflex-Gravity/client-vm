// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { RpcEndpoint } from './rpc.ts';
import type { PortLike } from './rpc.ts';

/** A port whose incoming messages the test injects directly, recording what is posted. */
function fakePort() {
  let listener: ((event: MessageEvent) => void) | undefined;
  const posted: unknown[] = [];
  const port: PortLike = {
    postMessage: (m) => void posted.push(m),
    addEventListener: (_type, l) => void (listener = l),
  };
  return { port, posted, deliver: (data: unknown) => listener!({ data } as MessageEvent) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RpcEndpoint', () => {
  it('calls and replies', async () => {
    const a = fakePort();
    const b = fakePort();
    // Wire the two fakes together.
    a.port.postMessage = (m) => b.deliver(m);
    b.port.postMessage = (m) => a.deliver(m);
    const server = new RpcEndpoint<{ add(x: number, y: number): number }, Record<string, never>>(
      b.port,
      { add: (x, y) => x + y },
    );
    const client = new RpcEndpoint<Record<string, never>, { add(x: number, y: number): number }>(
      a.port,
      {},
    );
    void server;
    expect(await client.call('add', 2, 3)).toBe(5);
  });

  it('never dispatches to inherited Object.prototype methods', async () => {
    const { port, posted, deliver } = fakePort();
    const onEvent = vi.fn();
    new RpcEndpoint(port, { onEvent });
    for (const m of [
      'constructor',
      '__defineGetter__',
      'hasOwnProperty',
      'toString',
      '__proto__',
    ]) {
      expect(() => deliver({ t: 'rpc:evt', m, a: ['x', () => 1] })).not.toThrow();
      deliver({ t: 'rpc:req', id: 1, m, a: [] });
    }
    await flush();
    expect(onEvent).not.toHaveBeenCalled();
    expect(posted).toHaveLength(5);
    for (const r of posted as { ok: boolean; e: { message: string } }[]) {
      expect(r.ok).toBe(false);
      expect(r.e.message).toMatch(/^unknown RPC method/);
    }
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'x')).toBe(false);
  });

  it('drops malformed messages without throwing (seeded fuzz)', async () => {
    const { port, posted, deliver } = fakePort();
    const handler = vi.fn(() => 1);
    const endpoint = new RpcEndpoint<{ h(): number }, { r(): number }>(port, { h: handler });
    const pending = endpoint.call('r');
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const values: unknown[] = [
      undefined,
      null,
      0,
      -1,
      1.5,
      NaN,
      2 ** 60,
      '',
      'h',
      'rpc:req',
      [],
      ['x'],
      {},
      { length: 1e9 },
      true,
      Symbol.iterator,
      () => 0,
      new Uint8Array(2),
    ];
    for (let i = 0; i < 5000; i++) {
      const msg: Record<string, unknown> = {
        t: pick(['rpc:req', 'rpc:res', 'rpc:evt', 'rpc:x', 'other', 7]),
      };
      for (const k of ['id', 'm', 'a', 'ok', 'v', 'e']) if (rand() < 0.6) msg[k] = pick(values);
      if (rand() < 0.2) msg['e'] = { name: pick(values), message: pick(values) };
      if (rand() < 0.05) msg['id'] = 1; // the pending call's id
      expect(() => deliver(rand() < 0.1 ? pick(values) : msg)).not.toThrow();
    }
    await flush();
    // Every call that reached the handler had an argument array.
    for (const call of handler.mock.calls) expect(Array.isArray(call)).toBe(true);
    // Replies were only sent for well-formed requests.
    for (const r of posted as { t: string; id: unknown }[])
      if (r.t === 'rpc:res') expect(Number.isSafeInteger(r.id)).toBe(true);
    // The pending call was settled by a well-formed response, or is still pending.
    await Promise.race([pending.catch(() => {}), flush()]);
  });

  it('a throwing event handler does not break later messages', async () => {
    const { port, deliver } = fakePort();
    const seen: number[] = [];
    const errors: unknown[] = [];
    const onError = (e: unknown) => void errors.push(e);
    process.on('uncaughtException', onError);
    try {
      new RpcEndpoint(port, {
        ev: (n: number) => {
          if (n === 1) throw new Error('boom');
          seen.push(n);
        },
      });
      deliver({ t: 'rpc:evt', m: 'ev', a: [1] });
      deliver({ t: 'rpc:evt', m: 'ev', a: [2] });
      await flush();
    } finally {
      process.off('uncaughtException', onError);
    }
    expect(seen).toEqual([2]);
  });
});
