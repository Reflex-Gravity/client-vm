// SPDX-License-Identifier: Apache-2.0

/**
 * Subset of `util.inspect` / `util.format`, following Node's layout rules
 * (breakLength 80, compact 3, array grouping) so console output matches Node.
 * Not supported yet: colors, Proxy detection, custom inspect symbols, getters
 * invocation, `showHidden`.
 */

export interface InspectOptions {
  depth?: number;
  breakLength?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

interface Ctx {
  depth: number;
  breakLength: number;
  compact: number;
  maxArrayLength: number;
  maxStringLength: number;
  indentationLvl: number;
  currentDepth: number;
  seen: unknown[];
}

const enum_kObjectType = 0;
const enum_kArrayExtrasType = 1;

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

export function inspect(value: unknown, options: InspectOptions = {}): string {
  const ctx: Ctx = {
    depth: options.depth ?? 2,
    breakLength: options.breakLength ?? 80,
    compact: 3,
    maxArrayLength: options.maxArrayLength ?? 100,
    maxStringLength: options.maxStringLength ?? 10000,
    indentationLvl: 0,
    currentDepth: 0,
    seen: [],
  };
  return formatValue(ctx, value, 0);
}

function formatValue(ctx: Ctx, value: unknown, recurseTimes: number): string {
  if (typeof value !== 'object' && typeof value !== 'function') {
    return formatPrimitive(ctx, value);
  }
  if (value === null) return 'null';
  if (ctx.seen.includes(value)) return '[Circular *1]';
  return formatRaw(ctx, value as object, recurseTimes);
}

function formatPrimitive(ctx: Ctx, value: unknown): string {
  switch (typeof value) {
    case 'string': {
      let trailer = '';
      let s = value;
      if (s.length > ctx.maxStringLength) {
        const remaining = s.length - ctx.maxStringLength;
        s = s.slice(0, ctx.maxStringLength);
        trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
      }
      // Long multi-line strings are split into concatenated lines, as Node does.
      if (
        ctx.compact !== 3 ||
        s.length <= 16 ||
        s.length <= ctx.breakLength - ctx.indentationLvl - 4
      ) {
        return quote(s) + trailer;
      }
      const lines = s.split(/(?<=\n)/);
      if (lines.length === 1) return quote(s) + trailer;
      return lines.map(quote).join(` +\n${' '.repeat(ctx.indentationLvl + 2)}`) + trailer;
    }
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint':
      return `${value}n`;
    case 'boolean':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return value.toString();
    default:
      return String(value);
  }
}

const ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '\\': '\\\\',
};

function quote(s: string): string {
  let q = "'";
  if (s.includes("'")) {
    if (!s.includes('"')) q = '"';
    else if (!s.includes('`') && !s.includes('${')) q = '`';
  }
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === q) out += `\\${q}`;
    else if (ESCAPES[ch] !== undefined) out += ESCAPES[ch];
    else if (code < 0x20 || code === 0x7f)
      out += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += ch;
  }
  return `${q}${out}${q}`;
}

function getPrefix(constructor: string | null, tag: string, fallback: string, size = ''): string {
  if (constructor === null) {
    if (tag !== '' && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `;
    return `[${fallback}${size}: null prototype] `;
  }
  if (tag !== '' && constructor !== tag) return `${constructor}${size} [${tag}] `;
  return `${constructor}${size} `;
}

function getConstructorName(obj: object): string | null {
  let proto: object | null = obj;
  while (proto !== null) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (desc !== undefined && typeof desc.value === 'function' && desc.value.name !== '') {
      return desc.value.name as string;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return null;
}

function formatRaw(ctx: Ctx, value: object, recurseTimes: number): string {
  const constructor = getConstructorName(value);
  const rawTag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  const tag = typeof rawTag === 'string' && rawTag !== constructor ? rawTag : '';
  let keys: (string | symbol)[] = ownEnumerableKeys(value);
  let base = '';
  let braces: [string, string];
  let extrasType = enum_kObjectType;
  let formatter: (ctx: Ctx, value: never, recurseTimes: number) => string[] = formatObjectEntries;
  let noIterator = true;

  if (Array.isArray(value)) {
    noIterator = false;
    const prefix =
      constructor !== 'Array' || tag !== ''
        ? getPrefix(constructor, tag, 'Array', `(${value.length})`)
        : '';
    keys = keys.filter((k) => typeof k === 'symbol' || !isIndex(k));
    braces = [`${prefix}[`, ']'];
    if (value.length === 0 && keys.length === 0) return `${braces[0]}]`;
    extrasType = enum_kArrayExtrasType;
    formatter = formatArray as typeof formatter;
  } else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    noIterator = false;
    const ta = value as unknown as ArrayLike<number | bigint>;
    const fallback = constructor ?? 'TypedArray';
    keys = keys.filter((k) => typeof k === 'symbol' || !isIndex(k));
    braces = [`${getPrefix(constructor, tag, fallback, `(${ta.length})`)}[`, ']'];
    if (ta.length === 0 && keys.length === 0) return `${braces[0]}]`;
    extrasType = enum_kArrayExtrasType;
    formatter = formatTypedArray as typeof formatter;
  } else if (value instanceof Set) {
    noIterator = false;
    const prefix = getPrefix(constructor, tag, 'Set', `(${value.size})`);
    formatter = formatSet as typeof formatter;
    braces = [`${prefix}{`, '}'];
    if (value.size === 0 && keys.length === 0) return `${prefix}{}`;
  } else if (value instanceof Map) {
    noIterator = false;
    const prefix = getPrefix(constructor, tag, 'Map', `(${value.size})`);
    formatter = formatMap as typeof formatter;
    braces = [`${prefix}{`, '}'];
    if (value.size === 0 && keys.length === 0) return `${prefix}{}`;
  }

  if (noIterator) {
    braces = ['{', '}'];
    if (typeof value === 'function') {
      base = functionBase(value as (...args: never[]) => unknown, constructor, tag);
      if (keys.length === 0) return base;
    } else if (value instanceof RegExp) {
      base = RegExp.prototype.toString.call(value);
      if (keys.length === 0) return base;
    } else if (value instanceof Date) {
      base = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
      if (keys.length === 0) return base;
    } else if (value instanceof Error) {
      base = formatError(value);
      keys = keys.filter((k) => k !== 'stack' && k !== 'message');
      if (keys.length === 0) return base;
    } else if (constructor === 'Object' && tag === '') {
      if (keys.length === 0) return '{}';
    } else {
      braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
      if (keys.length === 0) return `${braces[0]}}`;
    }
  }

  if (recurseTimes > ctx.depth) {
    const name = (constructor ?? tag) || 'Object';
    return Array.isArray(value) ? '[Array]' : `[${name}]`;
  }

  recurseTimes += 1;
  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output: string[];
  try {
    output = formatter(ctx, value as never, recurseTimes);
    for (const key of keys) {
      output.push(formatProperty(ctx, value, recurseTimes, key, enum_kObjectType));
    }
  } finally {
    ctx.seen.pop();
  }
  return reduceToSingleString(ctx, output, base, braces!, extrasType, recurseTimes, value);
}

function functionBase(
  fn: (...args: never[]) => unknown,
  constructor: string | null,
  tag: string,
): string {
  const source = Function.prototype.toString.call(fn);
  if (source.startsWith('class') && /^class\s*[{\w$]/.test(source)) {
    return fn.name ? `[class ${fn.name}]` : '[class (anonymous)]';
  }
  let type = 'Function';
  if (constructor === 'AsyncFunction') type = 'AsyncFunction';
  else if (constructor === 'GeneratorFunction') type = 'GeneratorFunction';
  else if (constructor === 'AsyncGeneratorFunction') type = 'AsyncGeneratorFunction';
  let base = `[${type}`;
  if (constructor === null) base += ' (null prototype)';
  base += fn.name === '' ? ' (anonymous)' : `: ${fn.name}`;
  base += ']';
  if (constructor !== type && constructor !== null) base += ` ${constructor}`;
  if (tag !== '' && constructor !== tag) base += ` [${tag}]`;
  return base;
}

function formatError(err: Error): string {
  const stack =
    typeof err.stack === 'string' && err.stack !== ''
      ? err.stack
      : Error.prototype.toString.call(err);
  return stack;
}

function ownEnumerableKeys(value: object): (string | symbol)[] {
  const keys: (string | symbol)[] = Object.keys(value);
  for (const sym of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, sym)) keys.push(sym);
  }
  return keys;
}

function isIndex(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

function formatObjectEntries(): string[] {
  return [];
}

function formatArray(ctx: Ctx, value: unknown[], recurseTimes: number): string[] {
  const output: string[] = [];
  const len = Math.min(ctx.maxArrayLength, value.length);
  let holes = 0;
  let i = 0;
  for (; i < value.length && output.length < len; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      holes++;
      continue;
    }
    if (holes > 0) {
      output.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
      holes = 0;
      if (output.length >= len) break;
    }
    output.push(formatProperty(ctx, value, recurseTimes, String(i), enum_kArrayExtrasType));
  }
  if (holes > 0 && output.length < len) {
    output.push(`<${holes} empty item${holes > 1 ? 's' : ''}>`);
  }
  const remaining = value.length - i;
  if (remaining > 0 && output.length >= len) {
    output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  }
  return output;
}

function formatTypedArray(
  ctx: Ctx,
  value: ArrayLike<number | bigint>,
  _recurseTimes: number,
): string[] {
  const len = Math.min(ctx.maxArrayLength, value.length);
  const output: string[] = [];
  for (let i = 0; i < len; i++) {
    const v = value[i]!;
    output.push(typeof v === 'bigint' ? `${v}n` : Object.is(v, -0) ? '-0' : String(v));
  }
  const remaining = value.length - len;
  if (remaining > 0) output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  return output;
}

function formatSet(ctx: Ctx, value: Set<unknown>, recurseTimes: number): string[] {
  ctx.indentationLvl += 2;
  const output = [...value].map((v) => formatValue(ctx, v, recurseTimes));
  ctx.indentationLvl -= 2;
  return output;
}

function formatMap(ctx: Ctx, value: Map<unknown, unknown>, recurseTimes: number): string[] {
  ctx.indentationLvl += 2;
  const output = [...value].map(
    ([k, v]) => `${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`,
  );
  ctx.indentationLvl -= 2;
  return output;
}

function formatProperty(
  ctx: Ctx,
  value: object,
  recurseTimes: number,
  key: string | symbol,
  type: number,
): string {
  const desc = Object.getOwnPropertyDescriptor(value, key) ?? {
    value: (value as Record<string | symbol, unknown>)[key],
    enumerable: true,
  };
  let str: string;
  if (desc.value !== undefined || !('get' in desc || 'set' in desc)) {
    ctx.indentationLvl += 2;
    str = formatValue(ctx, desc.value, recurseTimes);
    ctx.indentationLvl -= 2;
  } else if (desc.get !== undefined) {
    str = desc.set !== undefined ? '[Getter/Setter]' : '[Getter]';
  } else {
    str = desc.set !== undefined ? '[Setter]' : 'undefined';
  }
  if (type === enum_kArrayExtrasType) return str;
  let name: string;
  if (typeof key === 'symbol') name = `[${key.toString()}]`;
  else if (IDENTIFIER.test(key)) name = key;
  else name = quote(key);
  return `${name}: ${str}`;
}

function isBelowBreakLength(ctx: Ctx, output: string[], start: number, base: string): boolean {
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength) return false;
  for (const entry of output) {
    totalLength += entry.length;
    if (totalLength > ctx.breakLength) return false;
  }
  return base === '' || !base.includes('\n');
}

function reduceToSingleString(
  ctx: Ctx,
  output: string[],
  base: string,
  braces: [string, string],
  extrasType: number,
  recurseTimes: number,
  value: unknown,
): string {
  const entries = output.length;
  if (extrasType === enum_kArrayExtrasType && entries > 6) {
    output = groupArrayElements(ctx, output, value as ArrayLike<unknown>);
  }
  if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
    const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
    if (isBelowBreakLength(ctx, output, start, base)) {
      const joined = output.join(', ');
      if (!joined.includes('\n')) {
        return `${base ? `${base} ` : ''}${braces[0]} ${joined} ${braces[1]}`;
      }
    }
  }
  const indentation = `\n${' '.repeat(ctx.indentationLvl)}`;
  return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
}

function groupArrayElements(ctx: Ctx, output: string[], value: ArrayLike<unknown>): string[] {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  // The "... more items" trailer is not grouped.
  if (ctx.maxArrayLength < value.length && outputLength > 0) outputLength--;
  const separatorSpace = 2;
  const dataLen: number[] = new Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const len = output[i]!.length;
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  const actualMax = maxLength + separatorSpace;
  if (
    actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
    (totalLength / actualMax > 5 || maxLength <= 6)
  ) {
    const approxCharHeights = 2.5;
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      ctx.compact * 4,
      15,
    );
    if (columns <= 1) return output;
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j]! > lineLength) lineLength = dataLen[j]!;
      }
      maxLineLength.push(lineLength + separatorSpace);
    }
    let padStart = true;
    for (let i = 0; i < output.length; i++) {
      const v = value[i];
      if (typeof v !== 'number' && typeof v !== 'bigint') {
        padStart = false;
        break;
      }
    }
    const tmp: string[] = [];
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i]!;
        str += padStart ? `${output[j]}, `.padStart(padding) : `${output[j]}, `.padEnd(padding);
      }
      if (padStart) {
        str += output[j]!.padStart(maxLineLength[j - i]! - separatorSpace);
      } else {
        str += output[j];
      }
      tmp.push(str);
    }
    if (outputLength < output.length) tmp.push(output[outputLength]!);
    return tmp;
  }
  return output;
}

/** `util.format`: printf-style `%s %d %i %f %j %o %O %c %%`, remaining args inspected. */
export function format(...args: unknown[]): string {
  const first = args[0];
  let out = '';
  let a = 1;
  if (typeof first === 'string') {
    if (args.length === 1) return first;
    let last = 0;
    for (let i = 0; i < first.length - 1; i++) {
      if (first[i] !== '%') continue;
      const c = first[i + 1]!;
      if (c === '%') {
        out += first.slice(last, i) + '%';
        last = i + 2;
        i++;
        continue;
      }
      if (a >= args.length || !'sdifjoOc'.includes(c)) continue;
      const arg = args[a++];
      let rep: string;
      switch (c) {
        case 's':
          rep =
            typeof arg === 'string'
              ? arg
              : typeof arg === 'bigint'
                ? `${arg}n`
                : typeof arg === 'object' && arg !== null
                  ? inspect(arg, { depth: 0 })
                  : formatPrimitiveTop(arg);
          break;
        case 'd':
        case 'i': {
          if (typeof arg === 'bigint') rep = `${arg}n`;
          else if (typeof arg === 'symbol') rep = 'NaN';
          else {
            const n = Number(arg);
            rep = formatPrimitiveTop(c === 'i' ? Math.trunc(n) : n);
          }
          break;
        }
        case 'f':
          rep = typeof arg === 'symbol' ? 'NaN' : formatPrimitiveTop(parseFloat(String(arg)));
          break;
        case 'j':
          try {
            rep = JSON.stringify(arg) ?? 'undefined';
          } catch {
            rep = '[Circular]';
          }
          break;
        case 'o':
        case 'O':
          rep = inspect(arg, c === 'o' ? { depth: 4 } : {});
          break;
        default:
          rep = '';
      }
      out += first.slice(last, i) + rep;
      last = i + 2;
      i++;
    }
    out += first.slice(last);
  } else {
    a = 0;
  }
  for (; a < args.length; a++) {
    const arg = args[a];
    const s = typeof arg === 'string' ? arg : inspect(arg);
    out += (out === '' && a === 0 ? '' : ' ') + s;
  }
  return out;
}

function formatPrimitiveTop(v: unknown): string {
  return Object.is(v, -0) ? '-0' : String(v);
}
