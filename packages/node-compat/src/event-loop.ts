// SPDX-License-Identifier: Apache-2.0

/**
 * Node's event-loop liveness: the process exits when no *referenced* handle
 * is left. Handles are timers, child processes, stdin while listened to,
 * watchers, servers, and in-flight fetches. Each can be unref()'d.
 */
export interface Handle {
  ref(): this;
  unref(): this;
  hasRef(): boolean;
  /** Marks the handle finished; it no longer keeps the process alive. */
  close(): void;
}

/** Node's Timeout object (what setTimeout returns in Node). */
export interface Timeout extends Handle {
  refresh(): this;
  [Symbol.toPrimitive](): number;
}

export function createEventLoop(scope: typeof globalThis) {
  const native = {
    setTimeout: scope.setTimeout.bind(scope),
    clearTimeout: scope.clearTimeout.bind(scope),
    setInterval: scope.setInterval.bind(scope),
    clearInterval: scope.clearInterval.bind(scope),
    fetch: scope.fetch?.bind(scope),
  };
  const refd = new Set<object>();
  let onIdle: (() => void) | null = null;
  let checkScheduled = false;

  function scheduleCheck(): void {
    // Defer one macrotask so callbacks may schedule more work.
    if (!onIdle || checkScheduled) return;
    checkScheduled = true;
    native.setTimeout(() => {
      checkScheduled = false;
      if (refd.size === 0 && onIdle) {
        const done = onIdle;
        onIdle = null;
        done();
      }
    }, 0);
  }

  /** Creates a liveness handle (referenced until unref()/close()). */
  function handle(): Handle {
    const token = {};
    let closed = false;
    let wantRef = true;
    const h: Handle = {
      ref() {
        wantRef = true;
        if (!closed) refd.add(token);
        return h;
      },
      unref() {
        wantRef = false;
        refd.delete(token);
        scheduleCheck();
        return h;
      },
      hasRef: () => wantRef && !closed,
      close() {
        if (closed) return;
        closed = true;
        refd.delete(token);
        scheduleCheck();
      },
    };
    refd.add(token);
    return h;
  }

  let nextTimerId = 1;
  const timersById = new Map<number, Timeout>();

  function makeTimer(
    repeat: boolean,
    fn: (...args: unknown[]) => void,
    ms: unknown,
    args: unknown[],
  ): Timeout {
    if (typeof fn !== 'function') {
      throw Object.assign(
        new TypeError(`The "callback" argument must be of type function. Received ${typeof fn}`),
        {
          code: 'ERR_INVALID_ARG_TYPE',
        },
      );
    }
    let delay = Number(ms);
    if (!(delay >= 1 && delay <= 2 ** 31 - 1)) delay = 1;
    const h = handle();
    const id = nextTimerId++;
    let nativeId: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      nativeId = (repeat ? native.setInterval : native.setTimeout)(() => {
        if (!repeat) {
          h.close();
          timersById.delete(id);
        }
        fn(...args);
      }, delay);
    };
    const t: Timeout = {
      ref: () => (h.ref(), t),
      unref: () => (h.unref(), t),
      hasRef: () => h.hasRef(),
      close() {
        (repeat ? native.clearInterval : native.clearTimeout)(nativeId);
        h.close();
        timersById.delete(id);
      },
      refresh() {
        (repeat ? native.clearInterval : native.clearTimeout)(nativeId);
        arm();
        return t;
      },
      [Symbol.toPrimitive]: () => id,
    };
    Object.defineProperty(t, 'constructor', { value: { name: 'Timeout' }, enumerable: false });
    timersById.set(id, t);
    arm();
    return t;
  }

  /** Accepts a Timeout or its numeric id, as Node does. */
  const clear = (t: unknown) => {
    if (t === undefined || t === null) return;
    const timer = typeof t === 'object' ? (t as Timeout) : timersById.get(Number(t));
    timer?.close();
  };

  /** setImmediate runs after I/O callbacks; a macrotask is the closest browser analog. */
  function makeImmediate(fn: (...args: unknown[]) => void, args: unknown[]) {
    const h = handle();
    let cancelled = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      h.close();
      if (!cancelled) fn(...args);
    };
    channel.port2.postMessage(null);
    const imm = {
      ref: () => (h.ref(), imm),
      unref: () => (h.unref(), imm),
      hasRef: () => h.hasRef(),
      _cancel() {
        cancelled = true;
        channel.port1.close();
        h.close();
      },
    };
    return imm;
  }

  const timers = {
    setTimeout: (fn: (...args: unknown[]) => void, ms?: unknown, ...args: unknown[]) =>
      makeTimer(false, fn, ms, args),
    setInterval: (fn: (...args: unknown[]) => void, ms?: unknown, ...args: unknown[]) =>
      makeTimer(true, fn, ms, args),
    clearTimeout: clear,
    clearInterval: clear,
    setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) => makeImmediate(fn, args),
    clearImmediate: (imm: unknown) => (imm as { _cancel?: () => void } | undefined)?._cancel?.(),
  };

  /** fetch that keeps the process alive while the request is in flight. */
  const fetch = native.fetch
    ? (input: RequestInfo | URL, init?: RequestInit) => {
        const h = handle();
        return native.fetch!(input, init).finally(() => h.close());
      }
    : undefined;

  /** Resolves once no referenced handle remains (after at least one macrotask turn). */
  function drain(): Promise<void> {
    return new Promise((resolve) => {
      onIdle = resolve;
      scheduleCheck();
    });
  }

  return { timers, handle, fetch, drain };
}

export type EventLoop = ReturnType<typeof createEventLoop>;
