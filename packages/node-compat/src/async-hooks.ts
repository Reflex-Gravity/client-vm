// SPDX-License-Identifier: Apache-2.0
// `async_hooks`: AsyncLocalStorage and AsyncResource.
//
// Node propagates async context through every async operation, `await`
// included. Browsers have no hook for that (TC39 AsyncContext is not shipped),
// so here a context is a frame (store per AsyncLocalStorage) that is current
// during synchronous calls and is carried by the scheduling the runtime owns:
// timers, setImmediate, process.nextTick, and callbacks wrapped with
// AsyncResource.bind / AsyncLocalStorage.bind. Promise continuations (`.then`,
// `await`) run without it. createHook() hooks never fire.

type Frame = ReadonlyMap<AsyncLocalStorage<unknown>, unknown>;

let current: Frame | undefined;
/** False until the first AsyncLocalStorage exists, so binding costs nothing for most programs. */
let active = false;

function runInFrame<R>(frame: Frame | undefined, fn: () => R): R {
  const saved = current;
  current = frame;
  try {
    return fn();
  } finally {
    current = saved;
  }
}

/** Binds `fn` to the current async context. Used by the runtime's own scheduling. */
export function bindAsyncContext<F extends (...args: never[]) => unknown>(fn: F): F {
  if (!active) return fn;
  const frame = current;
  return function (this: unknown, ...args: Parameters<F>) {
    return runInFrame(frame, () => Reflect.apply(fn, this, args));
  } as F;
}

export class AsyncLocalStorage<T> {
  private enabled = true;

  constructor() {
    active = true;
  }

  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    active = true;
    return bindAsyncContext(fn);
  }

  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const frame = current;
    return (fn, ...args) => runInFrame(frame, () => fn(...args));
  }

  getStore(): T | undefined {
    return this.enabled
      ? (current?.get(this as AsyncLocalStorage<unknown>) as T | undefined)
      : undefined;
  }

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    this.enabled = true;
    const frame = new Map(current);
    frame.set(this as AsyncLocalStorage<unknown>, store);
    return runInFrame(frame, () => callback(...args));
  }

  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const frame = new Map(current);
    frame.delete(this as AsyncLocalStorage<unknown>);
    return runInFrame(frame, () => callback(...args));
  }

  enterWith(store: T): void {
    this.enabled = true;
    const frame = new Map(current);
    frame.set(this as AsyncLocalStorage<unknown>, store);
    current = frame;
  }

  disable(): void {
    this.enabled = false;
    if (current?.has(this as AsyncLocalStorage<unknown>)) {
      const frame = new Map(current);
      frame.delete(this as AsyncLocalStorage<unknown>);
      current = frame;
    }
  }
}

let nextAsyncId = 2;

export class AsyncResource {
  readonly type: string;
  private readonly frame: Frame | undefined;
  private readonly id = nextAsyncId++;

  constructor(type: string, _opts?: unknown) {
    if (typeof type !== 'string') {
      const err = new TypeError(
        `The "type" argument must be of type string. Received ${type === null ? 'null' : typeof type}`,
      );
      (err as TypeError & { code: string }).code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    this.type = type;
    this.frame = current;
  }

  static bind<F extends (...args: never[]) => unknown>(fn: F, type?: string, thisArg?: unknown): F {
    return new AsyncResource(type ?? 'bound-anonymous-fn').bind(fn, thisArg);
  }

  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return runInFrame(this.frame, () => Reflect.apply(fn, thisArg, args));
  }

  bind<F extends (...args: never[]) => unknown>(fn: F, thisArg?: unknown): F {
    const run = this.runInAsyncScope.bind(this);
    const bound = function (this: unknown, ...args: unknown[]) {
      return run(
        fn as unknown as (...a: unknown[]) => unknown,
        thisArg === undefined ? this : thisArg,
        ...args,
      );
    };
    Object.defineProperty(bound, 'length', { value: fn.length });
    Object.defineProperty(bound, 'asyncResource', { value: this, enumerable: true });
    return bound as unknown as F;
  }

  emitDestroy(): this {
    return this;
  }

  asyncId(): number {
    return this.id;
  }

  triggerAsyncId(): number {
    return 1;
  }
}

export const asyncHooksModule = {
  AsyncLocalStorage,
  AsyncResource,
  /** Hooks are accepted but never fire (no async resource tracking in ClientVM). */
  createHook: () => ({
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  }),
  executionAsyncId: () => 1,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
  asyncWrapProviders: Object.freeze({}),
};
