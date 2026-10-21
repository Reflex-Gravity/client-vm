// SPDX-License-Identifier: Apache-2.0
import { codeError } from './buffer.ts';

/**
 * Node's `events` module. Mirrors Node's lib/events.js semantics: listener
 * order, `once` wrappers (`listener` property), 'newListener' /
 * 'removeListener' events, error handling, captureRejections and the
 * max-listeners leak warning.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- listeners take event-specific arguments, as in Node's typings
type Listener = (...args: any[]) => unknown;
type OnceWrapper = Listener & { listener: Listener };
type Handlers = Record<string | symbol, Listener | Listener[] | undefined>;

export const kCapture = Symbol('kCapture');
export const captureRejectionSymbol = Symbol.for('nodejs.rejection');
export const errorMonitor = Symbol('events.errorMonitor');

let defaultMaxListeners = 10;
let defaultCaptureRejections = false;

/** Hook for the max-listeners warning; the node runtime routes it to process.emitWarning. */
export const warningHook: { emit: (warning: Error) => void } = {
  emit: (w) => console.warn(`${w.name}: ${w.message}`),
};

function checkListener(listener: unknown): asserts listener is Listener {
  if (typeof listener !== 'function') {
    const received =
      listener === null
        ? 'null'
        : typeof listener === 'object'
          ? 'an instance of Object'
          : `type ${typeof listener} (${String(listener)})`;
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      `The "listener" argument must be of type function. Received ${received}`,
    );
  }
}

class EventEmitterImpl {
  // Declared, not initialized: Node keeps these on the prototype until init() runs.
  declare _events: Handlers;
  declare _eventsCount: number;
  declare _maxListeners: number | undefined;
  declare [kCapture]?: boolean;

  static captureRejectionSymbol = captureRejectionSymbol;
  static errorMonitor = errorMonitor;

  static get defaultMaxListeners(): number {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(n: number) {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
      throw codeError(
        RangeError,
        'ERR_OUT_OF_RANGE',
        `The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ${String(n)}`,
      );
    }
    defaultMaxListeners = n;
  }

  static get captureRejections(): boolean {
    return defaultCaptureRejections;
  }

  static set captureRejections(v: boolean) {
    defaultCaptureRejections = v;
  }

  constructor(opts?: { captureRejections?: boolean }) {
    EventEmitterImpl.init.call(this, opts);
  }

  /** Called by legacy subclasses via `EventEmitter.call(this)`. */
  static init(this: EventEmitterImpl, opts?: { captureRejections?: boolean }): void {
    if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
      this._events = Object.create(null) as Handlers;
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
    if (opts?.captureRejections) this[kCapture] = true;
    else if (this[kCapture] === undefined) this[kCapture] = defaultCaptureRejections;
  }

  setMaxListeners(n: number): this {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
      throw codeError(
        RangeError,
        'ERR_OUT_OF_RANGE',
        `The value of "n" is out of range. It must be a non-negative number. Received ${String(n)}`,
      );
    }
    this._maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this._maxListeners === undefined ? defaultMaxListeners : this._maxListeners;
  }

  emit(type: string | symbol, ...args: unknown[]): boolean {
    let doError = type === 'error';
    const events = this._events;
    if (events !== undefined) {
      if (doError && events[errorMonitor] !== undefined)
        Reflect.apply(this.emit, this, [errorMonitor, ...args]);
      doError = doError && events['error'] === undefined;
    } else if (!doError) {
      return false;
    }

    if (doError) {
      const er = args[0];
      if (er instanceof Error) throw er;
      const err = codeError(Error, 'ERR_UNHANDLED_ERROR', `Unhandled error. (${inspectValue(er)})`);
      (err as Error & { context?: unknown }).context = er;
      throw err;
    }

    const handler = events![type];
    if (handler === undefined) return false;
    if (typeof handler === 'function') {
      const result = Reflect.apply(handler, this, args);
      if (result !== undefined && result !== null) addCatch(this, result, type, args);
    } else {
      // Index loops, as Node's own: user code may have replaced Array iteration.
      const listeners = handler.slice();
      for (let i = 0; i < listeners.length; i++) {
        const result = Reflect.apply(listeners[i]!, this, args);
        if (result !== undefined && result !== null) addCatch(this, result, type, args);
      }
    }
    return true;
  }

  addListener(type: string | symbol, listener: Listener): this {
    return addListenerImpl(this, type, listener, false);
  }

  on(type: string | symbol, listener: Listener): this {
    return addListenerImpl(this, type, listener, false);
  }

  prependListener(type: string | symbol, listener: Listener): this {
    return addListenerImpl(this, type, listener, true);
  }

  once(type: string | symbol, listener: Listener): this {
    checkListener(listener);
    return this.on(type, onceWrap(this, type, listener));
  }

  prependOnceListener(type: string | symbol, listener: Listener): this {
    checkListener(listener);
    return this.prependListener(type, onceWrap(this, type, listener));
  }

  removeListener(type: string | symbol, listener: Listener): this {
    checkListener(listener);
    const events = this._events;
    if (events === undefined) return this;
    const list = events[type];
    if (list === undefined) return this;

    if (list === listener || (list as Partial<OnceWrapper>).listener === listener) {
      this._eventsCount--;
      if (this._eventsCount === 0) this._events = Object.create(null) as Handlers;
      else delete events[type];
      if (events['removeListener'] !== undefined) {
        this.emit('removeListener', type, (list as Partial<OnceWrapper>).listener ?? listener);
      }
    } else if (typeof list !== 'function') {
      let position = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i]!;
        if (l === listener || (l as Partial<OnceWrapper>).listener === listener) {
          position = i;
          break;
        }
      }
      if (position < 0) return this;
      const [removed] = list.splice(position, 1);
      if (list.length === 1) events[type] = list[0];
      if (events['removeListener'] !== undefined) {
        this.emit('removeListener', type, (removed as Partial<OnceWrapper>).listener ?? listener);
      }
    }
    return this;
  }

  off(type: string | symbol, listener: Listener): this {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type?: string | symbol): this {
    const events = this._events;
    if (events === undefined) return this;
    if (events['removeListener'] === undefined) {
      if (arguments.length === 0) {
        this._events = Object.create(null) as Handlers;
        this._eventsCount = 0;
      } else if (events[type!] !== undefined) {
        if (--this._eventsCount === 0) this._events = Object.create(null) as Handlers;
        else delete events[type!];
      }
      return this;
    }
    if (arguments.length === 0) {
      for (const key of Reflect.ownKeys(events)) {
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = Object.create(null) as Handlers;
      this._eventsCount = 0;
      return this;
    }
    const listeners = events[type!];
    if (typeof listeners === 'function') {
      this.removeListener(type!, listeners);
    } else if (listeners !== undefined) {
      for (let i = listeners.length - 1; i >= 0; i--) this.removeListener(type!, listeners[i]!);
    }
    return this;
  }

  listeners(type: string | symbol): Listener[] {
    const l = this._events?.[type];
    if (l === undefined) return [];
    if (typeof l === 'function') return [(l as Partial<OnceWrapper>).listener ?? l];
    return l.map((x) => (x as Partial<OnceWrapper>).listener ?? x);
  }

  rawListeners(type: string | symbol): Listener[] {
    const l = this._events?.[type];
    if (l === undefined) return [];
    return typeof l === 'function' ? [l] : l.slice();
  }

  listenerCount(type: string | symbol, listener?: Listener): number {
    const l = this._events?.[type];
    if (l === undefined) return 0;
    const list = typeof l === 'function' ? [l] : l;
    if (listener === undefined) return list.length;
    return list.filter((x) => x === listener || (x as Partial<OnceWrapper>).listener === listener)
      .length;
  }

  eventNames(): (string | symbol)[] {
    return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
  }
}

/**
 * Node's EventEmitter is a plain function, so legacy code can do
 * `EventEmitter.call(this)` in a constructor; a class can't be called. The
 * function shares the class's prototype, so `class X extends EventEmitter`
 * and `instanceof` work too.
 */
export const EventEmitter = function EventEmitter(
  this: EventEmitterImpl,
  opts?: { captureRejections?: boolean },
) {
  EventEmitterImpl.init.call(this, opts);
} as unknown as typeof EventEmitterImpl & { EventEmitter: typeof EventEmitterImpl };
export type EventEmitter = EventEmitterImpl;

Object.defineProperty(EventEmitter, 'prototype', {
  value: EventEmitterImpl.prototype,
  writable: false,
});
Object.defineProperty(EventEmitterImpl.prototype, 'constructor', {
  value: EventEmitter,
  writable: true,
  configurable: true,
});
for (const key of Reflect.ownKeys(EventEmitterImpl)) {
  if (key === 'prototype' || key === 'length' || key === 'name') continue;
  Object.defineProperty(EventEmitter, key, Object.getOwnPropertyDescriptor(EventEmitterImpl, key)!);
}
// Node's aliases are the same function objects; subclasses (minipass) rely on
// that when they override one name and call super with the other.
Object.defineProperty(EventEmitterImpl.prototype, 'on', {
  ...Object.getOwnPropertyDescriptor(EventEmitterImpl.prototype, 'addListener')!,
});
Object.defineProperty(EventEmitterImpl.prototype, 'off', {
  ...Object.getOwnPropertyDescriptor(EventEmitterImpl.prototype, 'removeListener')!,
});
// Instance properties Node puts on the prototype, so subclasses that never call super still work.
Object.assign(EventEmitter.prototype, {
  _events: undefined,
  _eventsCount: 0,
  _maxListeners: undefined,
});
EventEmitter.EventEmitter = EventEmitter;

function onceWrap(
  target: EventEmitterImpl,
  type: string | symbol,
  listener: Listener,
): OnceWrapper {
  const state = {
    fired: false,
    wrapFn: undefined as unknown as OnceWrapper,
    target,
    type,
    listener,
  };
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!state.fired) {
      state.target.removeListener(state.type, state.wrapFn);
      state.fired = true;
      return state.listener.apply(state.target, args);
    }
    return undefined;
  } as OnceWrapper;
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

function inspectValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

interface AbortableOptions {
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  Object.assign(err, { code: 'ABORT_ERR', cause: signal.reason });
  return err;
}

/** `events.once(emitter, name)`: resolves with the arguments array, rejects on 'error'. */
export function once(
  emitter: EventEmitter | EventTarget,
  name: string | symbol,
  options: AbortableOptions = {},
): Promise<unknown[]> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    if ('addEventListener' in emitter && !(emitter instanceof EventEmitter)) {
      const handler = (event: Event) => {
        signal?.removeEventListener('abort', onAbort);
        resolve([event]);
      };
      const onAbort = () => {
        emitter.removeEventListener(name as string, handler);
        reject(abortError(signal!));
      };
      emitter.addEventListener(name as string, handler, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      return;
    }
    const ee = emitter as EventEmitter;
    const errorListener = (err: unknown) => {
      ee.removeListener(name, resolver);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    const resolver = (...args: unknown[]) => {
      if (name !== 'error') ee.removeListener('error', errorListener);
      signal?.removeEventListener('abort', onAbort);
      resolve(args);
    };
    const onAbort = () => {
      ee.removeListener(name, resolver);
      ee.removeListener('error', errorListener);
      reject(abortError(signal!));
    };
    ee.once(name, resolver);
    if (name !== 'error') ee.once('error', errorListener);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `events.on(emitter, name)`: an async iterator of argument arrays. */
export function on(
  emitter: EventEmitter,
  name: string | symbol,
  options: AbortableOptions = {},
): AsyncIterableIterator<unknown[]> {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  const unconsumed: unknown[][] = [];
  const pending: {
    resolve: (v: IteratorResult<unknown[]>) => void;
    reject: (e: unknown) => void;
  }[] = [];
  let error: unknown = null;
  let finished = false;

  const handler = (...args: unknown[]) => {
    const p = pending.shift();
    if (p) p.resolve({ value: args, done: false });
    else unconsumed.push(args);
  };
  const errorHandler = (err: unknown) => {
    finished = true;
    const p = pending.shift();
    if (p) p.reject(err);
    else error = err;
    void iterator.return!();
  };
  const onAbort = () => errorHandler(abortError(signal!));
  emitter.on(name, handler);
  if (name !== 'error') emitter.on('error', errorHandler);
  signal?.addEventListener('abort', onAbort, { once: true });

  const iterator: AsyncIterableIterator<unknown[]> = {
    next() {
      const value = unconsumed.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (error) {
        const p = Promise.reject(error);
        error = null;
        return p;
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    return() {
      emitter.removeListener(name, handler);
      emitter.removeListener('error', errorHandler);
      signal?.removeEventListener('abort', onAbort);
      finished = true;
      for (const p of pending.splice(0)) p.resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown) {
      error = err;
      emitter.removeListener(name, handler);
      emitter.removeListener('error', errorHandler);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

export function getEventListeners(
  emitter: EventEmitter | EventTarget,
  name: string | symbol,
): Listener[] {
  if (emitter instanceof EventEmitter) return emitter.listeners(name);
  return [];
}

export function getMaxListeners(emitter: EventEmitter): number {
  return emitter.getMaxListeners();
}

export function setMaxListeners(n = defaultMaxListeners, ...targets: EventEmitter[]): void {
  if (targets.length === 0) defaultMaxListeners = n;
  for (const t of targets) if (t instanceof EventEmitter) t.setMaxListeners(n);
}

export function listenerCount(emitter: EventEmitter, type: string | symbol): number {
  return emitter.listenerCount(type);
}

/** `Symbol.dispose` where the engine has it (Chromium does); a registered symbol otherwise. */
const disposeSymbol: symbol =
  (Symbol as { dispose?: symbol }).dispose ?? Symbol.for('Symbol.dispose');

export function addAbortListener(
  signal: AbortSignal,
  listener: (e: Event) => void,
): Record<symbol, () => void> {
  if (signal.aborted) queueMicrotask(() => listener(new Event('abort')));
  else signal.addEventListener('abort', listener, { once: true });
  return { [disposeSymbol]: () => signal.removeEventListener('abort', listener) };
}

/** The `events` builtin module: the EventEmitter constructor with helpers attached, as in Node. */
export const eventsModule = Object.assign(EventEmitter, {
  once,
  on,
  getEventListeners,
  getMaxListeners,
  setMaxListeners,
  listenerCount,
  addAbortListener,
  EventEmitterAsyncResource: EventEmitter,
  usingDomains: false,
  default: EventEmitter,
});

/** captureRejections: routes a listener's rejected promise to the emitter. */
function addCatch(
  self: EventEmitterImpl,
  promise: unknown,
  type: string | symbol,
  args: unknown[],
): void {
  if (!self[kCapture]) return;
  const then = (promise as { then?: unknown }).then;
  if (typeof then !== 'function') return;
  then.call(promise, undefined, (err: unknown) => {
    queueMicrotask(() => {
      const handler = (self as unknown as Record<symbol, unknown>)[captureRejectionSymbol];
      if (typeof handler === 'function') {
        self[kCapture] = false;
        try {
          handler.call(self, err, type, ...args);
        } finally {
          self[kCapture] = true;
        }
      } else {
        const prev = self[kCapture];
        try {
          self[kCapture] = false;
          self.emit('error', err);
        } finally {
          self[kCapture] = prev ?? false;
        }
      }
    });
  });
}

/**
 * Shared by on/addListener/prependListener. A module function, not a method:
 * subclasses define their own `add` (chokidar's FSWatcher does).
 */
function addListenerImpl<T extends EventEmitterImpl>(
  self: T,
  type: string | symbol,
  listener: Listener,
  prepend: boolean,
): T {
  checkListener(listener);
  let events = self._events;
  if (events === undefined) {
    events = self._events = Object.create(null) as Handlers;
    self._eventsCount = 0;
  } else if (events['newListener'] !== undefined) {
    self.emit('newListener', type, (listener as Partial<OnceWrapper>).listener ?? listener);
    events = self._events;
  }
  const existing = events[type];
  if (existing === undefined) {
    events[type] = listener;
    self._eventsCount++;
    return self;
  }
  const list =
    typeof existing === 'function'
      ? (events[type] = prepend ? [listener, existing] : [existing, listener])
      : existing;
  if (typeof existing !== 'function') {
    if (prepend) list.unshift(listener);
    else list.push(listener);
  }
  const max = self.getMaxListeners();
  const warned = list as Listener[] & { warned?: boolean };
  if (max > 0 && list.length > max && !warned.warned) {
    warned.warned = true;
    const name = typeof type === 'symbol' ? type.toString() : type;
    const w = new Error(
      `Possible EventEmitter memory leak detected. ${list.length} ${name} listeners added to ${self.constructor.name === 'EventEmitter' ? '[EventEmitter]' : `[${self.constructor.name}]`}. MaxListeners is ${max}. Use emitter.setMaxListeners() to increase limit`,
    );
    w.name = 'MaxListenersExceededWarning';
    Object.assign(w, { emitter: self, type, count: list.length });
    warningHook.emit(w);
  }
  return self;
}
