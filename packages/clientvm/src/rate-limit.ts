// SPDX-License-Identifier: Apache-2.0
// Per-instance limits on what an instance's kernel may ask of the controller
// (mailbox sends and cross-instance fetches), so a hostile instance cannot
// flood the host page (docs/security-review.md, 1.4).

import { ClientVMError } from './errors.ts';

export interface RateLimits {
  /** Mailbox messages per second, sustained. */
  mailboxPerSecond: number;
  /** Mailbox messages allowed in a burst above the sustained rate. */
  mailboxBurst: number;
  /** Cross-instance fetches started per second, sustained. */
  fetchPerSecond: number;
  fetchBurst: number;
  /** Cross-instance fetches in flight at once. */
  fetchConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  mailboxPerSecond: 200,
  mailboxBurst: 400,
  fetchPerSecond: 100,
  fetchBurst: 200,
  fetchConcurrent: 32,
};

/** A token bucket: `take()` is false when the bucket is empty. */
export class TokenBucket {
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;
  constructor(perSecond: number, burst: number, now: () => number = () => performance.now()) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const limited = (what: string) =>
  new ClientVMError(`${what}: too many requests from this instance`, 'ERR_RATE_LIMITED');

/** The controller-call limits of one instance. */
export class InstanceRateLimiter {
  private readonly limits: RateLimits;
  private readonly mailbox: TokenBucket;
  private readonly fetches: TokenBucket;
  private inFlight = 0;

  constructor(limits: RateLimits = DEFAULT_RATE_LIMITS, now?: () => number) {
    this.limits = limits;
    this.mailbox = new TokenBucket(limits.mailboxPerSecond, limits.mailboxBurst, now);
    this.fetches = new TokenBucket(limits.fetchPerSecond, limits.fetchBurst, now);
  }

  /** Throws `ERR_RATE_LIMITED` when the instance sends mail too fast. */
  mailboxSend(): void {
    if (!this.mailbox.take()) throw limited('mailbox');
  }

  /** Runs `fn` as one cross-instance fetch, or throws `ERR_RATE_LIMITED`. */
  async fetch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limits.fetchConcurrent || !this.fetches.take())
      throw limited('fetch');
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
    }
  }
}
