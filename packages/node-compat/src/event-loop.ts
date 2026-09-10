// SPDX-License-Identifier: Apache-2.0

/** Browser timers return numbers; Node's typings (used when type-checking tests) return objects. */
type TimerId = ReturnType<typeof setTimeout>;

/**
 * Tracks timers so the process can exit once its event loop drains, like Node.
 * Promise-only work (e.g. a pending fetch) is not tracked yet.
 */
export function createEventLoop(scope: typeof globalThis) {
  const native = {
    setTimeout: scope.setTimeout.bind(scope),
    clearTimeout: scope.clearTimeout.bind(scope),
    setInterval: scope.setInterval.bind(scope),
    clearInterval: scope.clearInterval.bind(scope),
  };
  const active = new Set<TimerId>();
  let onIdle: (() => void) | null = null;

  function release(id: TimerId): void {
    if (!active.delete(id)) return;
    // Defer the idle check one macrotask so callbacks may schedule more work.
    if (active.size === 0 && onIdle) native.setTimeout(checkIdle, 0);
  }

  function checkIdle(): void {
    if (active.size === 0 && onIdle) {
      const done = onIdle;
      onIdle = null;
      done();
    }
  }

  const timers = {
    setTimeout(fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimerId {
      const id: TimerId = native.setTimeout(() => {
        try {
          fn(...args);
        } finally {
          release(id);
        }
      }, ms);
      active.add(id);
      return id;
    },
    clearTimeout(id: TimerId | undefined): void {
      if (id === undefined) return;
      native.clearTimeout(id);
      release(id);
    },
    setInterval(fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): TimerId {
      const id: TimerId = native.setInterval(() => fn(...args), ms);
      active.add(id);
      return id;
    },
    clearInterval(id: TimerId | undefined): void {
      if (id === undefined) return;
      native.clearInterval(id);
      release(id);
    },
    setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]): TimerId {
      return timers.setTimeout(fn, 0, ...args);
    },
    clearImmediate(id: TimerId | undefined): void {
      timers.clearTimeout(id);
    },
  };

  /** Resolves once no timers are pending (after at least one macrotask turn). */
  function drain(): Promise<void> {
    return new Promise((resolve) => {
      onIdle = resolve;
      native.setTimeout(checkIdle, 0);
    });
  }

  return { timers, drain };
}
