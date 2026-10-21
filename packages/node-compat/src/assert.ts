// SPDX-License-Identifier: Apache-2.0
import { inspect } from './inspect.ts';
import { deepEqual } from './util.ts';

/** `assert`: Node's assertion module with Node's AssertionError shape (code ERR_ASSERTION). */
export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION';
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string | undefined;
  readonly generatedMessage: boolean;

  constructor(options: {
    message?: string | Error | undefined;
    actual?: unknown;
    expected?: unknown;
    operator?: string | undefined;
    /** @internal Set when assert itself wrote `message` (not the caller). */
    generated?: boolean;
  }) {
    const generated = options.generated === true || options.message === undefined;
    let message: string;
    if (typeof options.message === 'string') {
      message = options.message;
      // Node 24 appends the comparison to a caller's message for strictEqual on primitives.
      if (
        !options.generated &&
        options.operator === 'strictEqual' &&
        (typeof options.actual !== 'object' || options.actual === null) &&
        (typeof options.expected !== 'object' || options.expected === null)
      ) {
        message += `\n\n${inspect(options.actual)} !== ${inspect(options.expected)}\n`;
      }
    } else if (options.message === undefined) {
      message = generateMessage(options.actual, options.expected, options.operator);
    } else {
      message = String(options.message);
    }
    super(message);
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.generatedMessage = generated;
  }
}

const OPERATOR_TEXT: Record<string, string> = {
  strictEqual: 'Expected values to be strictly equal:',
  deepStrictEqual: 'Expected values to be strictly deep-equal:',
  deepEqual: 'Expected values to be loosely deep-equal:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
};

function generateMessage(actual: unknown, expected: unknown, operator?: string): string {
  if (operator === '==') return `${inspect(actual)} == ${inspect(expected)}`;
  if (operator === '!=') return `${inspect(actual)} != ${inspect(expected)}`;
  const header = operator ? OPERATOR_TEXT[operator] : undefined;
  if (header) {
    if (operator === 'strictEqual' && typeof actual !== 'object' && typeof expected !== 'object') {
      return `${header}\n\n${inspect(actual)} !== ${inspect(expected)}\n`;
    }
    return `${header}\n\n${inspect(actual)}\n\nshould equal\n\n${inspect(expected)}`;
  }
  return `${inspect(actual)} ${operator ?? '=='} ${inspect(expected)}`;
}

function fail(options: ConstructorParameters<typeof AssertionError>[0]): never {
  if (options.message instanceof Error) throw options.message;
  throw new AssertionError(options);
}

/** Fails with assert's own wording unless the caller supplied a message. */
function failWith(
  callerMessage: Msg,
  defaultMessage: string,
  rest: Omit<ConstructorParameters<typeof AssertionError>[0], 'message'>,
): never {
  if (callerMessage === undefined) fail({ ...rest, message: defaultMessage, generated: true });
  fail({ ...rest, message: callerMessage });
}

type Msg = string | Error | undefined;

function innerOk(value: unknown, argLen: number, message: Msg): void {
  if (value) return;
  if (argLen === 0)
    failWith(undefined, 'No value argument passed to `assert.ok()`', {
      actual: undefined,
      expected: true,
      operator: '==',
    });
  failWith(
    message,
    'The expression evaluated to a falsy value:\n\n  assert.ok(' + inspect(value) + ')\n',
    { actual: value, expected: true, operator: '==' },
  );
}

function matchesError(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && err instanceof (expected as new () => unknown))
      return true;
    if (Object.prototype.isPrototypeOf.call(Error, expected)) return false;
    return (expected as (e: unknown) => unknown)(err) === true;
  }
  if (expected instanceof RegExp) return expected.test(String(err));
  if (typeof expected === 'object' && expected !== null) {
    for (const [key, value] of Object.entries(expected)) {
      const actual = (err as Record<string, unknown>)[key];
      if (value instanceof RegExp && typeof actual === 'string') {
        if (!value.test(actual)) return false;
      } else if (!deepEqual(actual, value, true, new Map())) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function assert(value: unknown, message?: Msg): void {
  innerOk(value, arguments.length, message);
}

const methods = {
  ok(value: unknown, message?: Msg) {
    innerOk(value, arguments.length, message);
  },
  equal(actual: unknown, expected: unknown, message?: Msg) {
    if (!(actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))) {
      fail({ message, actual, expected, operator: '==' });
    }
  },
  notEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))
      fail({ message, actual, expected, operator: '!=' });
  },
  strictEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (!Object.is(actual, expected)) fail({ message, actual, expected, operator: 'strictEqual' });
  },
  notStrictEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (Object.is(actual, expected))
      fail({ message, actual, expected, operator: 'notStrictEqual' });
  },
  deepEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (!deepEqual(actual, expected, false, new Map()))
      fail({ message, actual, expected, operator: 'deepEqual' });
  },
  notDeepEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (deepEqual(actual, expected, false, new Map()))
      fail({ message, actual, expected, operator: 'notDeepEqual' });
  },
  deepStrictEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (!deepEqual(actual, expected, true, new Map()))
      fail({ message, actual, expected, operator: 'deepStrictEqual' });
  },
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: Msg) {
    if (deepEqual(actual, expected, true, new Map()))
      fail({ message, actual, expected, operator: 'notDeepStrictEqual' });
  },
  throws(fn: () => unknown, expected?: unknown, message?: Msg) {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
      fn();
    } catch (err) {
      if (!matchesError(err, expected)) {
        if (typeof expected === 'function' && !(expected as { prototype?: unknown }).prototype)
          throw err;
        if (typeof expected === 'function' && !(err instanceof (expected as new () => unknown)))
          throw err;
        failWith(message, `The error does not match the expected value`, {
          actual: err,
          expected,
          operator: 'throws',
        });
      }
      return;
    }
    fail({
      message: message ?? 'Missing expected exception.',
      actual: undefined,
      expected,
      operator: 'throws',
    });
  },
  doesNotThrow(fn: () => unknown, _expected?: unknown, message?: Msg) {
    try {
      fn();
    } catch (err) {
      fail({
        message: message ?? `Got unwanted exception.\nActual message: "${(err as Error)?.message}"`,
        actual: err,
        operator: 'doesNotThrow',
      });
    }
  },
  async rejects(
    promiseOrFn: Promise<unknown> | (() => Promise<unknown>),
    expected?: unknown,
    message?: Msg,
  ) {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
      await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (err) {
      if (!matchesError(err, expected))
        failWith(message, 'The error does not match the expected value', {
          actual: err,
          expected,
          operator: 'rejects',
        });
      return;
    }
    fail({
      message: message ?? 'Missing expected rejection.',
      actual: undefined,
      expected,
      operator: 'rejects',
    });
  },
  async doesNotReject(
    promiseOrFn: Promise<unknown> | (() => Promise<unknown>),
    _expected?: unknown,
    message?: Msg,
  ) {
    try {
      await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (err) {
      fail({
        message: message ?? `Got unwanted rejection.\nActual message: "${(err as Error)?.message}"`,
        actual: err,
        operator: 'doesNotReject',
      });
    }
  },
  match(actual: string, regexp: RegExp, message?: Msg) {
    if (typeof actual !== 'string' || !regexp.test(actual)) {
      failWith(
        message,
        `The input did not match the regular expression ${String(regexp)}. Input:\n\n${inspect(actual)}\n`,
        { actual, expected: regexp, operator: 'match' },
      );
    }
  },
  doesNotMatch(actual: string, regexp: RegExp, message?: Msg) {
    if (typeof actual === 'string' && regexp.test(actual)) {
      failWith(
        message,
        `The input was expected to not match the regular expression ${String(regexp)}. Input:\n\n${inspect(actual)}\n`,
        { actual, expected: regexp, operator: 'doesNotMatch' },
      );
    }
  },
  fail(message: Msg = 'Failed') {
    fail({ message, operator: 'fail' });
  },
  ifError(value: unknown) {
    if (value !== null && value !== undefined) {
      if (value instanceof Error) throw value;
      fail({
        message: `ifError got unwanted exception: ${inspect(value)}`,
        actual: value,
        expected: null,
        operator: 'ifError',
      });
    }
  },
  AssertionError,
};

Object.assign(assert, methods);
const strict = Object.assign(
  function strictAssert(value: unknown, message?: Msg) {
    innerOk(value, arguments.length, message);
  },
  methods,
  {
    equal: methods.strictEqual,
    notEqual: methods.notStrictEqual,
    deepEqual: methods.deepStrictEqual,
    notDeepEqual: methods.notDeepStrictEqual,
  },
);
Object.assign(strict, { strict });
Object.assign(assert, { strict });

export const assertModule = assert as typeof assert & typeof methods & { strict: typeof strict };
