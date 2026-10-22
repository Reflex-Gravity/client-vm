// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { InstanceRateLimiter, TokenBucket } from './rate-limit.ts';

describe('TokenBucket', () => {
  it('allows a burst, then the sustained rate', () => {
    let t = 0;
    const b = new TokenBucket(10, 3, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t = 100; // one token per 100 ms
    expect([b.take(), b.take()]).toEqual([true, false]);
    t = 10_000; // refills only up to the burst
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});

describe('InstanceRateLimiter', () => {
  const limits = {
    mailboxPerSecond: 1,
    mailboxBurst: 2,
    fetchPerSecond: 1000,
    fetchBurst: 1000,
    fetchConcurrent: 2,
  };

  it('rejects mail beyond the rate with ERR_RATE_LIMITED', () => {
    const r = new InstanceRateLimiter(limits, () => 0);
    r.mailboxSend();
    r.mailboxSend();
    expect(() => r.mailboxSend()).toThrow(expect.objectContaining({ code: 'ERR_RATE_LIMITED' }));
  });

  it('caps fetches in flight, and frees the slot when one settles', async () => {
    const r = new InstanceRateLimiter(limits, () => 0);
    let release!: () => void;
    const pending = new Promise<void>((res) => (release = res));
    const a = r.fetch(() => pending);
    const b = r.fetch(() => pending);
    await expect(r.fetch(async () => 1)).rejects.toMatchObject({ code: 'ERR_RATE_LIMITED' });
    release();
    await Promise.all([a, b]);
    await expect(r.fetch(async () => 'ok')).resolves.toBe('ok');
    // A failed fetch frees its slot too.
    await expect(r.fetch(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(r.fetch(async () => 2)).resolves.toBe(2);
  });
});
