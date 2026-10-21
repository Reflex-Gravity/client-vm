// SPDX-License-Identifier: Apache-2.0
// Runs the same EventEmitter scenarios against node:events and node-compat; compares traces.
import * as nodeEvents from 'node:events';
import { eventsModule } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

type Mod = typeof nodeEvents.EventEmitter & typeof nodeEvents;
const NODE = nodeEvents.EventEmitter as unknown as Mod;
const OURS = eventsModule as unknown as Mod;

async function trace(
  EE: Mod,
  scenario: (EE: Mod, log: (...a: unknown[]) => void) => unknown,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const log = (...a: unknown[]) =>
    out.push(
      a.map((x) =>
        typeof x === 'function' ? `fn:${x.name}` : typeof x === 'symbol' ? x.toString() : x,
      ),
    );
  try {
    await scenario(EE, log);
  } catch (err) {
    out.push(['threw', (err as { code?: string }).code ?? (err as Error).message]);
  }
  return out;
}

const scenarios: Record<string, (EE: Mod, log: (...a: unknown[]) => void) => unknown> = {
  'order, once, return values'(EE, log) {
    const e = new EE();
    e.on('x', (a: unknown) => log('first', a));
    e.prependListener('x', (a: unknown) => log('prepended', a));
    e.once('x', (a: unknown) => log('once', a));
    log(e.emit('x', 1), e.emit('x', 2), e.emit('nothing'));
    log(e.listenerCount('x'), e.eventNames());
  },
  'newListener and removeListener events'(EE, log) {
    const e = new EE();
    e.on('newListener', (name: unknown, fn: unknown) => log('new', name, fn));
    e.on('removeListener', (name: unknown, fn: unknown) => log('removed', name, fn));
    function handler() {}
    e.on('a', handler);
    e.once('b', function onceHandler() {});
    e.off('a', handler);
    e.emit('b');
    e.removeAllListeners();
    log(e.eventNames());
  },
  'removing during emit does not skip listeners'(EE, log) {
    const e = new EE();
    const b = () => log('b');
    e.on('x', () => {
      log('a');
      e.removeListener('x', b);
    });
    e.on('x', b);
    e.emit('x');
    e.emit('x');
  },
  'error events'(EE, log) {
    const e = new EE();
    try {
      e.emit('error', new Error('boom'));
    } catch (err) {
      log('caught', (err as Error).message);
    }
    try {
      e.emit('error', 'just a string');
    } catch (err) {
      log('caught', (err as { code?: string }).code, (err as { context?: unknown }).context);
    }
    e.on(EE.errorMonitor, (err: Error) => log('monitor', err.message));
    e.on('error', (err: Error) => log('handled', err.message));
    e.emit('error', new Error('later'));
  },
  'listeners vs rawListeners'(EE, log) {
    const e = new EE();
    function a() {}
    e.once('x', a);
    log(
      e.listeners('x')[0] === a,
      e.rawListeners('x')[0] === a,
      (e.rawListeners('x')[0] as { listener?: unknown }).listener === a,
    );
    e.removeListener('x', a);
    log(e.listenerCount('x'));
  },
  'max listeners'(EE, log) {
    const e = new EE();
    log(e.getMaxListeners(), EE.defaultMaxListeners);
    e.setMaxListeners(1);
    log(e.getMaxListeners());
    try {
      e.setMaxListeners(-1);
    } catch (err) {
      log('threw', (err as { code?: string }).code);
    }
  },
  'invalid listener'(EE) {
    new EE().on('x', 'nope' as unknown as () => void);
  },
  'legacy subclassing with call()'(EE, log) {
    function Legacy(this: { ok?: boolean }) {
      EE.call(this as never);
      this.ok = true;
    }
    Object.setPrototypeOf(Legacy.prototype, EE.prototype);
    const inst = new (Legacy as unknown as new () => InstanceType<Mod> & { ok: boolean })();
    inst.on('ping', () => log('pong', inst.ok));
    inst.emit('ping');
    log(inst instanceof EE);
  },
  'class subclassing'(EE, log) {
    class Sub extends EE {
      hello() {
        this.emit('hi', 'there');
      }
    }
    const s = new Sub();
    s.on('hi', (v: unknown) => log(v));
    s.hello();
    log(s instanceof EE, Object.getPrototypeOf(Sub) === EE);
  },
  async 'events.once'(EE, log) {
    const e = new EE();
    queueMicrotask(() => e.emit('ready', 1, 2));
    log(await EE.once(e, 'ready'));
    queueMicrotask(() => e.emit('error', new Error('bad')));
    try {
      await EE.once(e, 'never');
    } catch (err) {
      log('rejected', (err as Error).message);
    }
    log(e.listenerCount('never'), e.listenerCount('error'));
  },
  async 'events.on async iterator'(EE, log) {
    const e = new EE();
    queueMicrotask(() => {
      e.emit('data', 'a');
      e.emit('data', 'b');
      e.emit('data', 'c');
    });
    let n = 0;
    for await (const [value] of EE.on(e, 'data')) {
      log(value);
      if (++n === 3) break;
    }
    log(e.listenerCount('data'));
  },
  async captureRejections(EE, log) {
    const e = new EE({ captureRejections: true });
    e.on('x', async () => {
      throw new Error('async fail');
    });
    e.on('error', (err: Error) => log('captured', err.message));
    e.emit('x');
    await new Promise((r) => setTimeout(r, 5));
  },
  'symbols as event names'(EE, log) {
    const e = new EE();
    const sym = Symbol('evt');
    e.on(sym, () => log('sym fired'));
    e.emit(sym);
    log(e.eventNames().length);
  },
  'module shape'(EE, log) {
    log(
      typeof EE,
      typeof EE.EventEmitter,
      EE.EventEmitter === EE,
      typeof EE.once,
      typeof EE.on,
      typeof EE.getEventListeners,
    );
  },
};

describe('events differential: node-compat vs node:events', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, async () => {
      expect(await trace(OURS, scenario)).toEqual(await trace(NODE, scenario));
    });
  }
});

describe('EventEmitter aliases', () => {
  it('on/addListener and off/removeListener are the same functions', () => {
    expect(OURS.prototype.on).toBe(OURS.prototype.addListener);
    expect(OURS.prototype.off).toBe(OURS.prototype.removeListener);
    // A subclass overriding one alias and calling super with the other (minipass).
    class Sub extends OURS {
      override removeListener(t: string, l: (...a: unknown[]) => void) {
        return this.off(t, l);
      }
      override off(t: string, l: (...a: unknown[]) => void) {
        return super.off(t, l);
      }
    }
    const s = new Sub();
    const fn = () => {};
    s.on('x', fn);
    s.removeListener('x', fn);
    expect(s.listenerCount('x')).toBe(0);
  });
});

describe('EventEmitter prototype', () => {
  it("has Node's method names and no extra internals subclasses could shadow", () => {
    const names = (p: object) =>
      Object.getOwnPropertyNames(p)
        .filter((n) => n !== 'constructor')
        .sort();
    expect(names(OURS.prototype).filter((n) => !n.startsWith('_'))).toEqual(
      names(NODE.prototype).filter((n) => !n.startsWith('_')),
    );
  });

  it('a subclass with its own add() still receives listeners (chokidar)', () => {
    class Watcher extends OURS {
      added: string[] = [];
      add(path: string) {
        this.added.push(path);
        return this;
      }
    }
    const w = new Watcher();
    let got = 0;
    w.on('change', () => got++);
    w.emit('change');
    expect(got).toBe(1);
    expect(w.added).toEqual([]);
  });
});
