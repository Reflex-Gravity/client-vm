// SPDX-License-Identifier: Apache-2.0
// The instance's mailbox inbox and its HTTP face, `http://mailbox.internal/`,
// so processes in any language (or curl) can send and receive messages.
// Sending goes through the controller, which checks `channel` capabilities.

import type { WireRequest, WireResponse } from '@clientvm/protocol';
import { decodeUtf8, encodeUtf8 } from '@clientvm/protocol';

export interface MailboxMessage {
  from: string;
  fromName: string | null;
  message: unknown;
}

const MAX_MESSAGES = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_WAIT_MS = 5 * 60_000;

export class Inbox {
  private readonly queue: { entry: MailboxMessage; size: number }[] = [];
  private bytes = 0;
  private readonly waiters: ((m: MailboxMessage | null) => void)[] = [];

  get size(): number {
    return this.queue.length;
  }

  deliver(entry: MailboxMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(entry);
      return;
    }
    const size = JSON.stringify(entry.message ?? null).length;
    this.queue.push({ entry, size });
    this.bytes += size;
    // Bounded: the oldest messages go first.
    while (this.queue.length > MAX_MESSAGES || this.bytes > MAX_BYTES) {
      this.bytes -= this.queue.shift()!.size;
    }
  }

  /** The next message, waiting up to `timeoutMs`; null on timeout. */
  next(timeoutMs: number): Promise<MailboxMessage | null> {
    const head = this.queue.shift();
    if (head) {
      this.bytes -= head.size;
      return Promise.resolve(head.entry);
    }
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (m: MailboxMessage | null) => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(
        () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        },
        Math.min(timeoutMs, MAX_WAIT_MS),
      );
      this.waiters.push(waiter);
    });
  }
}

function json(status: number, value: unknown): WireResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : status === 202 ? 'Accepted' : '',
    headers: [['content-type', 'application/json']],
    body: encodeUtf8(`${JSON.stringify(value)}\n`),
  };
}

function text(status: number, statusText: string, message: string): WireResponse {
  return {
    status,
    statusText,
    headers: [['content-type', 'text/plain; charset=utf-8']],
    body: encodeUtf8(`${message}\n`),
  };
}

/**
 * `GET /` → `{ id, name, pending }`; `POST /send/<to>` (JSON body) → 202;
 * `GET /recv?timeout=<ms>` → the next `{ from, fromName, message }`, or 204.
 */
export function mailboxHandler(
  self: { id: string; name: string | null },
  inbox: Inbox,
  send: (to: string, message: unknown) => Promise<void>,
): (req: WireRequest) => Promise<WireResponse> {
  return async (req) => {
    const url = new URL(req.path, 'http://mailbox.internal');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/') {
      return json(200, { id: self.id, name: self.name, pending: inbox.size });
    }
    if (req.method === 'GET' && path === '/recv') {
      const timeout = Number(url.searchParams.get('timeout') ?? 0);
      const entry = await inbox.next(Number.isFinite(timeout) ? timeout : 0);
      return entry === null
        ? { status: 204, statusText: 'No Content', headers: [], body: new Uint8Array(0) }
        : json(200, entry);
    }
    const send_ = /^\/send\/([^/]+)$/.exec(path);
    if (send_ && req.method === 'POST') {
      let message: unknown;
      try {
        message = JSON.parse(decodeUtf8(req.body ?? new Uint8Array(0)));
      } catch {
        return text(400, 'Bad Request', 'mailbox: the body must be JSON');
      }
      try {
        await send(decodeURIComponent(send_[1]!), message);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code === 'ERR_NO_CAPABILITY') return text(403, 'Forbidden', msg);
        if (code === 'ERR_NO_INSTANCE') return text(404, 'Not Found', msg);
        return text(400, 'Bad Request', msg);
      }
      return json(202, { sent: true });
    }
    return text(404, 'Not Found', 'mailbox: use GET /, GET /recv or POST /send/<to>');
  };
}
