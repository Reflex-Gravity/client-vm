// SPDX-License-Identifier: Apache-2.0
// `node:test`: the common subset of Node's test runner. Tests and suites run
// one at a time in registration order (Node's default concurrency for a
// file), with subtests, hooks, skip/todo, plan, mock.fn/mock.method, and a
// spec-style report. A failure sets process.exitCode to 1.

type Fn = (...args: unknown[]) => unknown;

interface TestOptions {
  skip?: boolean | string;
  todo?: boolean | string;
  only?: boolean;
  timeout?: number;
  concurrency?: number | boolean;
  plan?: number;
}

interface Hooks {
  before: Fn[];
  after: Fn[];
  beforeEach: Fn[];
  afterEach: Fn[];
}

interface Node {
  name: string;
  fn: Fn | undefined;
  options: TestOptions;
  kind: 'test' | 'suite';
  parent: Node | null;
  children: Node[];
  hooks: Hooks;
  depth: number;
  done: Promise<void>;
  resolve: () => void;
}

interface Deps {
  write: (text: string) => void;
  setExitCode: (code: number) => void;
  /** Keeps the process alive while tests run. */
  hold: () => { close(): void };
  assert: unknown;
  setImmediate: (fn: () => void) => unknown;
}

const emptyHooks = (): Hooks => ({ before: [], after: [], beforeEach: [], afterEach: [] });

function parseArgs(args: unknown[]): { name: string; options: TestOptions; fn: Fn | undefined } {
  let name = '<anonymous>';
  let options: TestOptions = {};
  let fn: Fn | undefined;
  for (const a of args) {
    if (typeof a === 'string') name = a;
    else if (typeof a === 'function') {
      fn = a as Fn;
      if (name === '<anonymous>' && (a as Fn).name) name = (a as Fn).name;
    } else if (a && typeof a === 'object') options = a as TestOptions;
  }
  return { name, options, fn };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

export function createTestModule(deps: Deps): Record<string, unknown> {
  const counts = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const started = performance.now();
  let current: Node | null = null;
  let running = false;
  let handle: { close(): void } | null = null;
  const root = makeNode('<root>', undefined, {}, 'suite', null);
  const restorers: (() => void)[] = [];

  function makeNode(
    name: string,
    fn: Fn | undefined,
    options: TestOptions,
    kind: Node['kind'],
    parent: Node | null,
  ): Node {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    return {
      name,
      fn,
      options,
      kind,
      parent,
      children: [],
      hooks: emptyHooks(),
      depth: parent ? (parent === root ? 0 : parent.depth + 1) : 0,
      done,
      resolve,
    };
  }

  const indent = (n: Node) => '  '.repeat(n.depth);
  const ms = (t: number) =>
    `(${(performance.now() - t).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}ms)`;

  function eachHooks(node: Node, key: 'beforeEach' | 'afterEach'): Fn[] {
    const chain: Node[] = [];
    for (let n: Node | null = node.parent; n; n = n.parent) chain.unshift(n);
    const hooks = chain.flatMap((n) => n.hooks[key]);
    return key === 'afterEach' ? hooks.reverse() : hooks;
  }

  async function callWith(
    fn: Fn,
    self: unknown,
    ctx: unknown,
    timeout: number | undefined,
  ): Promise<void> {
    const run =
      fn.length >= 2
        ? new Promise<void>((resolve, reject) => {
            try {
              const r = fn.call(self, ctx, (err?: unknown) => (err ? reject(err) : resolve()));
              if (r && typeof (r as Promise<unknown>).then === 'function')
                reject(new Error('passed a callback but also returned a Promise'));
            } catch (e) {
              reject(e);
            }
          })
        : Promise.resolve().then(() => fn.call(self, ctx));
    if (!timeout || !Number.isFinite(timeout)) {
      await run;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run,
      new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`test timed out after ${timeout}ms`)), timeout);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function contextFor(node: Node) {
    let planned: number | undefined = node.options.plan;
    let asserted = 0;
    const abort = new AbortController();
    const ctx = {
      name: node.name,
      get fullName() {
        const names: string[] = [];
        for (let n: Node | null = node; n && n !== root; n = n.parent) names.unshift(n.name);
        return names.join(' > ');
      },
      signal: abort.signal,
      diagnostic: (msg: string) => deps.write(`${indent(node)}  ℹ ${msg}\n`),
      skip: (msg?: string) => {
        node.options = { ...node.options, skip: msg ?? true };
      },
      todo: (msg?: string) => {
        node.options = { ...node.options, todo: msg ?? true };
      },
      plan: (n: number) => {
        planned = n;
      },
      runOnly: () => {},
      before: (fn: Fn) => node.hooks.before.push(fn),
      after: (fn: Fn) => node.hooks.after.push(fn),
      beforeEach: (fn: Fn) => node.hooks.beforeEach.push(fn),
      afterEach: (fn: Fn) => node.hooks.afterEach.push(fn),
      test: (...args: unknown[]) => {
        const { name, options, fn } = parseArgs(args);
        const child = makeNode(name, fn, options, 'test', node);
        node.children.push(child);
        return runNode(child);
      },
      mock: mockApi,
      assert: new Proxy(deps.assert as object, {
        get(target, key) {
          const v = (target as Record<string | symbol, unknown>)[key];
          if (typeof v !== 'function') return v;
          return (...a: unknown[]) => {
            asserted++;
            return (v as Fn).apply(target, a);
          };
        },
      }),
      checkPlan: () => {
        if (planned !== undefined && planned !== asserted)
          throw new Error(`plan expected ${planned} assertions but received ${asserted}`);
      },
    };
    return ctx;
  }

  async function runNode(node: Node): Promise<void> {
    const t0 = performance.now();
    const skip = node.options.skip;
    const todo = node.options.todo;
    if (node.kind === 'suite') counts.suites++;
    else counts.tests++;
    if (skip) {
      counts.skipped++;
      deps.write(
        `${indent(node)}﹣ ${node.name} ${ms(t0)} # ${typeof skip === 'string' ? skip : 'SKIP'}\n`,
      );
      node.resolve();
      return;
    }
    const prev = current;
    current = node;
    let error: unknown = null;
    const ctx = contextFor(node);
    try {
      if (node.kind === 'suite') {
        // Suites register children synchronously (or via a returned promise), then run them.
        if (node.fn) await callWith(node.fn, ctx, ctx, undefined);
        current = node;
        deps.write(`${indent(node)}▶ ${node.name}\n`);
        for (const h of node.hooks.before) await callWith(h, ctx, ctx, undefined);
        for (const child of node.children) {
          await runNode(child);
        }
        for (const h of node.hooks.after) await callWith(h, ctx, ctx, undefined);
      } else {
        for (const h of eachHooks(node, 'beforeEach')) await callWith(h, ctx, ctx, undefined);
        if (node.fn) await callWith(node.fn, ctx, ctx, node.options.timeout);
        // Subtests started with t.test() finish before their parent.
        await Promise.all(node.children.map((c) => c.done));
        for (const h of node.hooks.after) await callWith(h, ctx, ctx, undefined);
        for (const h of eachHooks(node, 'afterEach')) await callWith(h, ctx, ctx, undefined);
        ctx.checkPlan();
      }
    } catch (err) {
      error = err;
    }
    current = prev;
    const failedChild = node.children.some((c) => (c as Node & { failed?: boolean }).failed);
    const failed = (error !== null || failedChild) && !todo;
    (node as Node & { failed?: boolean }).failed = failed;
    if (node.kind === 'test') {
      if (todo) counts.todo++;
      else if (failed) counts.fail++;
      else counts.pass++;
    }
    const mark = failed ? '✖' : '✔';
    const suffix = todo ? ` # ${typeof todo === 'string' ? todo : 'TODO'}` : '';
    deps.write(`${indent(node)}${mark} ${node.name} ${ms(t0)}${suffix}\n`);
    if (error !== null && !todo) {
      deps.write(
        `${errorText(error)
          .split('\n')
          .map((l) => `${indent(node)}  ${l}`)
          .join('\n')}\n`,
      );
    }
    node.resolve();
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    handle ??= deps.hold();
    for (const h of root.hooks.before) await callWith(h, null, {}, undefined).catch(() => {});
    for (let i = 0; i < root.children.length; i++) await runNode(root.children[i]!);
    running = false;
    for (const h of root.hooks.after) await callWith(h, null, {}, undefined).catch(() => {});
    report();
    handle?.close();
    handle = null;
  }

  function report(): void {
    const lines = [
      `ℹ tests ${counts.tests}`,
      `ℹ suites ${counts.suites}`,
      `ℹ pass ${counts.pass}`,
      `ℹ fail ${counts.fail}`,
      `ℹ cancelled ${counts.cancelled}`,
      `ℹ skipped ${counts.skipped}`,
      `ℹ todo ${counts.todo}`,
      `ℹ duration_ms ${(performance.now() - started).toFixed(3)}`,
    ];
    deps.write(`${lines.join('\n')}\n`);
    if (counts.fail > 0) deps.setExitCode(1);
  }

  function register(kind: Node['kind'], args: unknown[]): Promise<void> {
    const { name, options, fn } = parseArgs(args);
    const parent = current ?? root;
    const node = makeNode(name, fn, options, kind, parent);
    if (parent !== root && parent.kind === 'test') {
      // test() inside a running test is a subtest.
      parent.children.push(node);
      return runNode(node);
    }
    parent.children.push(node);
    if (parent === root && !running) {
      handle ??= deps.hold();
      deps.setImmediate(() => void drain());
    }
    return node.done;
  }

  const test = (...args: unknown[]) => register('test', args);
  const describe = (...args: unknown[]) => register('suite', args);
  const withModifiers = <T extends (...a: unknown[]) => unknown>(f: T) =>
    Object.assign(f, {
      skip: (...a: unknown[]) => f(...a, { skip: true }),
      todo: (...a: unknown[]) => f(...a, { todo: true }),
      only: (...a: unknown[]) => f(...a, { only: true }),
    });
  const hook = (key: keyof Hooks) => (fn: Fn) => (current ?? root).hooks[key].push(fn);

  // ------------------------------------------------------------------- mocks

  interface Call {
    arguments: unknown[];
    result?: unknown;
    error?: unknown;
    this: unknown;
    target: unknown;
  }

  function mockFn(original?: Fn, implementation?: Fn, opts?: { times?: number }): Fn {
    let impl = implementation ?? original ?? (() => undefined);
    const once = new Map<number, Fn>();
    let remaining = opts?.times ?? Infinity;
    const calls: Call[] = [];
    const ctx = {
      calls,
      callCount: () => calls.length,
      mockImplementation: (f: Fn) => {
        impl = f;
      },
      mockImplementationOnce: (f: Fn, onCall?: number) => {
        once.set(onCall ?? calls.length, f);
      },
      resetCalls: () => {
        calls.length = 0;
      },
      restore: () => {
        impl = original ?? (() => undefined);
      },
    };
    const mocked = function (this: unknown, ...args: unknown[]) {
      const index = calls.length;
      const use = once.get(index) ?? (remaining-- > 0 ? impl : (original ?? impl));
      once.delete(index);
      const call: Call = { arguments: args, this: this, target: new.target };
      calls.push(call);
      try {
        const result = new.target
          ? Reflect.construct(use, args, new.target)
          : use.apply(this, args);
        call.result = result;
        return result;
      } catch (err) {
        call.error = err;
        throw err;
      }
    };
    Object.defineProperty(mocked, 'mock', { value: ctx, enumerable: false });
    return mocked as Fn;
  }

  const mockApi = {
    fn: (original?: unknown, implementation?: unknown, opts?: { times?: number }) => {
      const o = typeof original === 'function' ? (original as Fn) : undefined;
      const i = typeof implementation === 'function' ? (implementation as Fn) : undefined;
      const options = (typeof implementation === 'object' ? implementation : opts) as
        { times?: number } | undefined;
      return mockFn(o, i, options);
    },
    method: (
      object: Record<string, unknown>,
      name: string,
      implementation?: unknown,
      opts?: unknown,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      const original = object[name] as Fn;
      const mocked = mockFn(
        original,
        typeof implementation === 'function' ? (implementation as Fn) : undefined,
        (typeof implementation === 'object' ? implementation : opts) as
          { times?: number } | undefined,
      );
      object[name] = mocked;
      restorers.push(() => {
        if (descriptor) Object.defineProperty(object, name, descriptor);
        else delete object[name];
      });
      return mocked;
    },
    getter: () => {
      throw new Error('mock.getter is not available in ClientVM yet');
    },
    setter: () => {
      throw new Error('mock.setter is not available in ClientVM yet');
    },
    reset: () => {
      while (restorers.length) restorers.pop()!();
    },
    restoreAll: () => {
      while (restorers.length) restorers.pop()!();
    },
  };

  const testFn = withModifiers(test);
  const describeFn = withModifiers(describe);
  return Object.assign(testFn as unknown as Record<string, unknown>, {
    test: testFn,
    it: testFn,
    describe: describeFn,
    suite: describeFn,
    before: hook('before'),
    after: hook('after'),
    beforeEach: hook('beforeEach'),
    afterEach: hook('afterEach'),
    mock: mockApi,
    run: () => {
      throw new Error('node:test run() is not available in ClientVM yet');
    },
  });
}
