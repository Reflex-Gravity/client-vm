// SPDX-License-Identifier: Apache-2.0
// diagnostics_channel compared with Node's own: channel identity, pub/sub,
// and the event order of tracing channels (sync, promise, callback, errors).
import * as nodeDc from 'node:diagnostics_channel';
import { diagnosticsChannelModule } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

type Dc = typeof nodeDc;

async function scenario(dc: Dc, prefix: string): Promise<unknown[]> {
  const log: unknown[] = [];
  const ch = dc.channel(`${prefix}a`);
  log.push(ch === dc.channel(`${prefix}a`), ch.hasSubscribers, dc.hasSubscribers(`${prefix}a`));
  const f = (m: unknown, n: string | symbol) => log.push(['msg', m, String(n)]);
  dc.subscribe(`${prefix}a`, f);
  ch.publish({ x: 1 });
  log.push(ch.hasSubscribers, dc.unsubscribe(`${prefix}a`, f), dc.unsubscribe(`${prefix}a`, f));
  ch.publish('unseen');
  log.push(ch.hasSubscribers);

  const tc = dc.tracingChannel<string, Record<string, unknown>>(`${prefix}t`);
  log.push(tc.start.name, tc.hasSubscribers);
  const handlers = {
    start: () => log.push('start'),
    end: () => log.push('end'),
    asyncStart: () => log.push('asyncStart'),
    asyncEnd: () => log.push('asyncEnd'),
    error: (c: unknown) => log.push(['error', String((c as { error: Error }).error.message)]),
  };
  tc.subscribe(handlers);
  const ctx: Record<string, unknown> = {};
  log.push(
    tc.traceSync((x: number) => x * 2, ctx, null, 21),
    ctx['result'],
  );
  try {
    tc.traceSync(() => {
      throw new Error('boom');
    }, {});
  } catch (e) {
    log.push((e as Error).message);
  }
  log.push(await tc.tracePromise(async () => 5, {}));
  await tc
    .tracePromise(() => Promise.reject(new Error('rej')), {})
    .catch((e: Error) => log.push(e.message));
  await new Promise<void>((resolve) => {
    tc.traceCallback(
      (cb: (e: unknown, r: unknown) => void) => setTimeout(() => cb(null, 7), 0),
      0,
      {},
      null,
      (_e: unknown, r: unknown) => {
        log.push(['cb', r]);
        resolve();
      },
    );
  });
  log.push(tc.unsubscribe(handlers), tc.hasSubscribers);
  return log;
}

describe('diagnostics_channel differential', () => {
  it('matches node:diagnostics_channel', async () => {
    const expected = await scenario(nodeDc, 'n');
    const actual = await scenario(diagnosticsChannelModule as unknown as Dc, 'n');
    expect(actual).toEqual(expected);
  });
});
