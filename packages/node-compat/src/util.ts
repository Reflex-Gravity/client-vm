// SPDX-License-Identifier: Apache-2.0
import { Buffer, codeError } from './buffer.ts';
import { EventEmitter } from './events.ts';
import { customInspectSymbol, format, inspect } from './inspect.ts';

/** `util.types`: the checks Node implements natively, done with the JS tools available. */
const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);
export const types = {
  isAnyArrayBuffer: (v: unknown) =>
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v: unknown) =>
    typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isUint8ClampedArray: (v: unknown) => v instanceof Uint8ClampedArray,
  isUint16Array: (v: unknown) => v instanceof Uint16Array,
  isUint32Array: (v: unknown) => v instanceof Uint32Array,
  isInt8Array: (v: unknown) => v instanceof Int8Array,
  isInt16Array: (v: unknown) => v instanceof Int16Array,
  isInt32Array: (v: unknown) => v instanceof Int32Array,
  isFloat32Array: (v: unknown) => v instanceof Float32Array,
  isFloat64Array: (v: unknown) => v instanceof Float64Array,
  isBigInt64Array: (v: unknown) => v instanceof BigInt64Array,
  isBigUint64Array: (v: unknown) => v instanceof BigUint64Array,
  isDataView: (v: unknown) => v instanceof DataView,
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isPromise: (v: unknown) => v instanceof Promise,
  isNativeError: (v: unknown) => v instanceof Error,
  isAsyncFunction: (v: unknown) => typeof v === 'function' && tag(v) === 'AsyncFunction',
  isGeneratorFunction: (v: unknown) => typeof v === 'function' && /GeneratorFunction$/.test(tag(v)),
  isGeneratorObject: (v: unknown) => tag(v) === 'Generator',
  isMapIterator: (v: unknown) => tag(v) === 'Map Iterator',
  isSetIterator: (v: unknown) => tag(v) === 'Set Iterator',
  isBoxedPrimitive: (v: unknown) =>
    v instanceof Number ||
    v instanceof String ||
    v instanceof Boolean ||
    v instanceof BigInt ||
    v instanceof Symbol,
  isNumberObject: (v: unknown) => v instanceof Number,
  isStringObject: (v: unknown) => v instanceof String,
  isBooleanObject: (v: unknown) => v instanceof Boolean,
  isBigIntObject: (v: unknown) => typeof v === 'object' && v instanceof BigInt,
  isSymbolObject: (v: unknown) => typeof v === 'object' && v instanceof Symbol,
  isModuleNamespaceObject: (v: unknown) => tag(v) === 'Module',
  isProxy: () => false,
  isExternal: () => false,
  isKeyObject: () => false,
  isCryptoKey: (v: unknown) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey,
  isArgumentsObject: (v: unknown) => tag(v) === 'Arguments',
  isWeakRef: (v: unknown) => v instanceof WeakRef,
};

const kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');

type Callback = (err: unknown, ...values: unknown[]) => void;

export function promisify<T extends (...args: never[]) => unknown>(
  original: T,
): (...args: unknown[]) => Promise<unknown> {
  if (typeof original !== 'function') {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "original" argument must be of type function',
    );
  }
  const custom = (original as unknown as Record<symbol, unknown>)[kCustomPromisify];
  if (typeof custom === 'function') return custom as (...args: unknown[]) => Promise<unknown>;
  const fn = function (this: unknown, ...args: unknown[]) {
    return new Promise((resolve, reject) => {
      (original as unknown as (...a: unknown[]) => void).call(this, ...args, ((err, ...values) => {
        if (err) reject(err);
        else resolve(values[0]);
      }) as Callback);
    });
  };
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperty(fn, kCustomPromisify, { value: fn, configurable: true });
  return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
}
promisify.custom = kCustomPromisify;

export function callbackify(original: (...args: unknown[]) => Promise<unknown>) {
  if (typeof original !== 'function') {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "original" argument must be of type function',
    );
  }
  return function (this: unknown, ...args: unknown[]) {
    const cb = args.pop() as Callback;
    if (typeof cb !== 'function') {
      throw codeError(
        TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The last argument must be of type function',
      );
    }
    original.apply(this, args).then(
      (v) => queueMicrotask(() => cb(null, v)),
      (err: unknown) => {
        let reason = err;
        if (!reason) {
          reason = codeError(
            Error,
            'ERR_FALSY_VALUE_REJECTION',
            'Promise was rejected with falsy value',
          );
          (reason as { reason?: unknown }).reason = err;
        }
        queueMicrotask(() => cb(reason));
      },
    );
  };
}

export function inherits(
  ctor: { prototype: object; super_?: unknown },
  superCtor: { prototype: object },
): void {
  if (ctor === undefined || ctor === null) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "ctor" argument must be of type function',
    );
  }
  if (superCtor === undefined || superCtor === null) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "superCtor" argument must be of type function',
    );
  }
  if (superCtor.prototype === undefined) {
    throw codeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "superCtor.prototype" property must be of type object',
    );
  }
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

const deprecationsWarned = new Set<string>();
/** Hook for deprecation warnings; the node runtime routes it to process.emitWarning. */
export const deprecationHook = {
  emit: (msg: string, code?: string) =>
    console.warn(`${code ? `[${code}] ` : ''}DeprecationWarning: ${msg}`),
};

export function deprecate<T extends (...args: never[]) => unknown>(
  fn: T,
  msg: string,
  code?: string,
): T {
  const key = code ?? msg;
  return function (this: unknown, ...args: never[]) {
    if (!deprecationsWarned.has(key)) {
      deprecationsWarned.add(key);
      deprecationHook.emit(msg, code);
    }
    return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
  } as unknown as T;
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b, true, new Map());
}

/** Structural equality following Node's assert.deepStrictEqual / deepEqual rules (common cases). */
export function deepEqual(
  a: unknown,
  b: unknown,
  strict: boolean,
  memo: Map<object, object>,
): boolean {
  if (
    strict
      ? Object.is(a, b)
      : a === b ||
        (a == b && (typeof a !== 'object' || a === null) && (typeof b !== 'object' || b === null))
  ) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return !strict &&
      typeof a !== 'object' &&
      typeof b !== 'object' &&
      Number.isNaN(a) &&
      Number.isNaN(b)
      ? true
      : false;
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (tag(a) !== tag(b)) return false;
  if (memo.get(a) === b) return true;
  memo.set(a, b);

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp)
    return String(a) === String(b) && a.lastIndex === (b as RegExp).lastIndex;
  if (a instanceof Error && (a.message !== (b as Error).message || a.name !== (b as Error).name))
    return false;
  if (types.isBoxedPrimitive(a)) {
    if (
      !Object.is((a as { valueOf(): unknown }).valueOf(), (b as { valueOf(): unknown }).valueOf())
    )
      return false;
  }
  if (ArrayBuffer.isView(a)) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const yv = b as ArrayBufferView;
    const y = new Uint8Array(yv.buffer, yv.byteOffset, yv.byteLength);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  if (a instanceof Map) {
    const bm = b as Map<unknown, unknown>;
    if (a.size !== bm.size) return false;
    for (const [k, v] of a) {
      if (!bm.has(k) || !deepEqual(v, bm.get(k), strict, memo)) return false;
    }
  } else if (a instanceof Set) {
    const bs = b as Set<unknown>;
    if (a.size !== bs.size) return false;
    outer: for (const v of a) {
      if (bs.has(v)) continue;
      if (typeof v === 'object' && v !== null) {
        for (const w of bs) if (deepEqual(v, w, strict, memo)) continue outer;
      }
      return false;
    }
  }
  const keysA = ownEnumerable(a, ArrayBuffer.isView(a));
  const keysB = ownEnumerable(b, ArrayBuffer.isView(b));
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false;
    if (
      !deepEqual(
        (a as Record<PropertyKey, unknown>)[k],
        (b as Record<PropertyKey, unknown>)[k],
        strict,
        memo,
      )
    )
      return false;
  }
  return true;
}

function ownEnumerable(obj: object, skipIndices: boolean): PropertyKey[] {
  const keys: PropertyKey[] = Object.keys(obj).filter((k) => !skipIndices || !/^\d+$/.test(k));
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    if (Object.prototype.propertyIsEnumerable.call(obj, sym)) keys.push(sym);
  }
  return keys;
}

export function stripVTControlCharacters(str: string): string {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g,
    '',
  );
}

function styleText(_format: string | string[], text: string): string {
  // Processes have no TTY; Node strips styles when colors are disabled.
  return text;
}

function debuglog(section: string) {
  const enabled = new RegExp(
    `^(${(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['NODE_DEBUG'] ?? ''}`
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((s) => s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*'))
      .join('|') + ')$',
    'i',
  );
  const on = enabled.source !== '^()$' && enabled.test(section);
  const log = (...args: unknown[]) => {
    if (on) console.error('%s %d: %s', section.toUpperCase(), 0, format(...args));
  };
  log.enabled = on;
  return log;
}

function getSystemErrorName(errno: number): string {
  const names: Record<number, string> = {
    [-2]: 'ENOENT',
    [-13]: 'EACCES',
    [-17]: 'EEXIST',
    [-20]: 'ENOTDIR',
    [-21]: 'EISDIR',
    [-22]: 'EINVAL',
  };
  return names[errno] ?? `Unknown system error ${errno}`;
}

/** Node's `util.parseArgs`, covering the documented behavior for common configurations. */
function parseArgs(config: {
  args?: string[];
  options?: Record<
    string,
    { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }
  >;
  strict?: boolean;
  allowPositionals?: boolean;
}) {
  const args =
    config.args ?? ((globalThis as { process?: { argv?: string[] } }).process?.argv ?? []).slice(2);
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const values: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  const shortToLong = new Map<string, string>();
  for (const [name, o] of Object.entries(options)) if (o.short) shortToLong.set(o.short, name);
  const store = (name: string, value: unknown) => {
    const o = options[name];
    if (!o && strict)
      throw codeError(TypeError, 'ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '--${name}'`);
    if (o?.multiple) ((values[name] ??= []) as unknown[]).push(value);
    else values[name] = value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const o = options[name];
      if (o?.type === 'string') {
        const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined && strict) {
          throw codeError(
            TypeError,
            'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
            `Option '--${name} <value>' argument missing`,
          );
        }
        store(name, value);
      } else {
        store(name, eq === -1 ? true : arg.slice(eq + 1));
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const short = arg[j]!;
        const name = shortToLong.get(short) ?? short;
        if (options[name]?.type === 'string') {
          store(name, j + 1 < arg.length ? arg.slice(j + 1) : args[++i]);
          break;
        }
        store(name, true);
      }
    } else {
      if (!allowPositionals) {
        throw codeError(
          TypeError,
          'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          `Unexpected argument '${arg}'. This command does not take positional arguments`,
        );
      }
      positionals.push(arg);
    }
  }
  for (const [name, o] of Object.entries(options)) {
    if (values[name] === undefined && o.default !== undefined) values[name] = o.default;
  }
  return { values, positionals };
}

function isArray(v: unknown): boolean {
  return Array.isArray(v);
}

Object.assign(inspect, {
  custom: customInspectSymbol,
  defaultOptions: { depth: 2, breakLength: 80, maxArrayLength: 100, maxStringLength: 10000 },
});

/** The `util` builtin module. */
export const utilModule: Record<string, unknown> = {
  format,
  formatWithOptions: (_opts: unknown, ...args: unknown[]) => format(...args),
  inspect,
  types,
  promisify,
  callbackify,
  inherits,
  deprecate,
  isDeepStrictEqual,
  debuglog,
  debug: debuglog,
  stripVTControlCharacters,
  styleText,
  getSystemErrorName,
  parseArgs,
  toUSVString: (s: string) => String(s).toWellFormed?.() ?? String(s),
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  isArray,
  isBoolean: (v: unknown) => typeof v === 'boolean',
  isBuffer: (v: unknown) => Buffer.isBuffer(v),
  isNull: (v: unknown) => v === null,
  isNullOrUndefined: (v: unknown) => v === null || v === undefined,
  isNumber: (v: unknown) => typeof v === 'number',
  isString: (v: unknown) => typeof v === 'string',
  isSymbol: (v: unknown) => typeof v === 'symbol',
  isUndefined: (v: unknown) => v === undefined,
  isRegExp: types.isRegExp,
  isObject: (v: unknown) => v !== null && typeof v === 'object',
  isDate: types.isDate,
  isError: types.isNativeError,
  isFunction: (v: unknown) => typeof v === 'function',
  isPrimitive: (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
  aborted: (signal: AbortSignal) =>
    new Promise<void>((resolve) =>
      signal.aborted
        ? resolve()
        : signal.addEventListener('abort', () => resolve(), { once: true }),
    ),
  EventEmitter,
};
