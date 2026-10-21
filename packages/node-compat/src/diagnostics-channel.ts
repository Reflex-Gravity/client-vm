// SPDX-License-Identifier: Apache-2.0
// `diagnostics_channel`: named pub/sub channels and tracing channels, as in
// Node's lib/diagnostics_channel.js. Libraries (undici, fastify, pino)
// publish to channels unconditionally and check `hasSubscribers` first.
// Store binding (`bindStore`/`runStores`) runs the function without an
// AsyncLocalStorage context, since ClientVM has none.

type Subscriber = (message: unknown, name: string | symbol) => void;

class Channel {
  readonly name: string | symbol;
  private subscribers: Subscriber[] = [];
  private stores = new Map<unknown, ((message: unknown) => unknown) | undefined>();

  constructor(name: string | symbol) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.subscribers.length > 0 || this.stores.size > 0;
  }

  subscribe(subscription: Subscriber): void {
    if (typeof subscription !== 'function') throw invalidArg('subscription', subscription);
    this.subscribers = [...this.subscribers, subscription];
  }

  unsubscribe(subscription: Subscriber): boolean {
    const i = this.subscribers.indexOf(subscription);
    if (i < 0) return false;
    // Copy on write, so publishing while a subscriber unsubscribes is safe.
    this.subscribers = [...this.subscribers.slice(0, i), ...this.subscribers.slice(i + 1)];
    return true;
  }

  publish(message: unknown): void {
    const subscribers = this.subscribers;
    for (let i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i]!(message, this.name);
      } catch (err) {
        // Node reports subscriber errors as uncaught without stopping the publisher.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  bindStore(store: unknown, transform?: (message: unknown) => unknown): void {
    this.stores.set(store, transform);
  }

  unbindStore(store: unknown): boolean {
    return this.stores.delete(store);
  }

  runStores<T>(
    message: unknown,
    fn: (...args: unknown[]) => T,
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    this.publish(message);
    return Reflect.apply(fn, thisArg, args);
  }
}

const channels = new Map<string | symbol, Channel>();

function invalidArg(name: string, value: unknown): TypeError {
  const err = new TypeError(
    `The "${name}" argument must be of type function. Received ${value === null ? 'null' : typeof value}`,
  );
  (err as TypeError & { code: string }).code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function channel(name: string | symbol): Channel {
  if (typeof name !== 'string' && typeof name !== 'symbol') {
    const err = new TypeError(
      `The "channel" argument must be one of type string or symbol. Received ${typeof name}`,
    );
    (err as TypeError & { code: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  let c = channels.get(name);
  if (!c) channels.set(name, (c = new Channel(name)));
  return c;
}

const EVENTS = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const;
type TracingEvent = (typeof EVENTS)[number];
type Handlers = Partial<Record<TracingEvent, Subscriber>>;

class TracingChannel {
  readonly start: Channel;
  readonly end: Channel;
  readonly asyncStart: Channel;
  readonly asyncEnd: Channel;
  readonly error: Channel;

  constructor(nameOrChannels: string | Partial<Record<TracingEvent, Channel>>) {
    const get = (event: TracingEvent): Channel => {
      if (typeof nameOrChannels === 'string') return channel(`tracing:${nameOrChannels}:${event}`);
      const c = nameOrChannels[event];
      if (!(c instanceof Channel)) throw invalidArg(`nameOrChannels.${event}`, c);
      return c;
    };
    this.start = get('start');
    this.end = get('end');
    this.asyncStart = get('asyncStart');
    this.asyncEnd = get('asyncEnd');
    this.error = get('error');
  }

  get hasSubscribers(): boolean {
    return EVENTS.some((e) => this[e].hasSubscribers);
  }

  subscribe(handlers: Handlers): void {
    for (const e of EVENTS) if (handlers[e]) this[e].subscribe(handlers[e]);
  }

  unsubscribe(handlers: Handlers): boolean {
    let done = true;
    for (const e of EVENTS) if (handlers[e]) done = this[e].unsubscribe(handlers[e]) && done;
    return done;
  }

  traceSync<T>(
    fn: (...args: unknown[]) => T,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    this.start.publish(context);
    try {
      const result = Reflect.apply(fn, thisArg, args);
      context['result'] = result;
      return result;
    } catch (err) {
      context['error'] = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }

  tracePromise<T>(
    fn: (...args: unknown[]) => Promise<T>,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): Promise<T> {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    this.start.publish(context);
    try {
      const promise = Promise.resolve(Reflect.apply(fn, thisArg, args));
      return promise.then(
        (result) => {
          context['result'] = result;
          this.asyncStart.publish(context);
          this.asyncEnd.publish(context);
          return result;
        },
        (err: unknown) => {
          context['error'] = err;
          this.error.publish(context);
          this.asyncStart.publish(context);
          this.asyncEnd.publish(context);
          throw err;
        },
      );
    } catch (err) {
      context['error'] = err;
      this.error.publish(context);
      throw err;
    } finally {
      this.end.publish(context);
    }
  }

  traceCallback<T>(
    fn: (...args: unknown[]) => T,
    position = -1,
    context: Record<string, unknown> = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const index = position < 0 ? args.length + position : position;
    const callback = args[index];
    if (typeof callback !== 'function') throw invalidArg('callback', callback);
    args[index] = (err: unknown, result: unknown) => {
      if (err) {
        context['error'] = err;
        this.error.publish(context);
      } else context['result'] = result;
      this.asyncStart.publish(context);
      try {
        return Reflect.apply(callback, this, [err, result]);
      } finally {
        this.asyncEnd.publish(context);
      }
    };
    return this.traceSync(fn, context, thisArg, ...args);
  }
}

export const diagnosticsChannelModule = {
  channel,
  hasSubscribers: (name: string | symbol) => channels.get(name)?.hasSubscribers ?? false,
  subscribe: (name: string | symbol, subscription: Subscriber) =>
    channel(name).subscribe(subscription),
  unsubscribe: (name: string | symbol, subscription: Subscriber) =>
    channel(name).unsubscribe(subscription),
  tracingChannel: (nameOrChannels: string | Partial<Record<TracingEvent, Channel>>) =>
    new TracingChannel(nameOrChannels),
  Channel,
};
