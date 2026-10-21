// SPDX-License-Identifier: Apache-2.0

/** Node's `querystring` (legacy), following lib/querystring.js. */

// Characters Node leaves unescaped: A-Z a-z 0-9 - . _ ~ ! ' ( ) *
const UNESCAPED = /[A-Za-z0-9\-._~!'()*]/;

export function escape(str: unknown): string {
  const s = typeof str === 'string' ? str : String(str);
  let out = '';
  for (const ch of s) {
    if (UNESCAPED.test(ch)) {
      out += ch;
      continue;
    }
    for (const b of new TextEncoder().encode(ch))
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function unescape(s: string, _decodeSpaces?: boolean): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Node's fallback (unescapeBuffer): decode %XX to bytes, keep malformed escapes
    // literally, then decode the bytes as UTF-8 (invalid sequences become U+FFFD).
    return new TextDecoder().decode(unescapeBytes(s));
  }
}

function unescapeBytes(s: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push(...encoder.encode(ch));
      i += ch.length - 1;
    }
  }
  return new Uint8Array(out);
}

function stringifyPrimitive(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

export function stringify(
  obj: Record<string, unknown> | null | undefined,
  sep = '&',
  eq = '=',
  options?: { encodeURIComponent?: (s: string) => string },
): string {
  const encode = options?.encodeURIComponent ?? escape;
  if (obj === null || typeof obj !== 'object') return '';
  const fields: string[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const ks = encode(stringifyPrimitive(key)) + eq;
    if (Array.isArray(value)) {
      for (const v of value) fields.push(ks + encode(stringifyPrimitive(v)));
    } else {
      fields.push(ks + encode(stringifyPrimitive(value)));
    }
  }
  return fields.join(sep);
}

export function parse(
  qs: unknown,
  sep = '&',
  eq = '=',
  options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string },
): Record<string, string | string[]> {
  const obj: Record<string, string | string[]> = Object.create(null);
  if (typeof qs !== 'string' || qs.length === 0) return obj;
  const decode = options?.decodeURIComponent ?? unescape;
  const maxKeys = options?.maxKeys ?? 1000;
  let parts = qs.split(sep);
  if (maxKeys > 0) parts = parts.slice(0, maxKeys);
  for (const part of parts) {
    if (part === '') continue;
    const idx = part.indexOf(eq);
    const rawKey = idx >= 0 ? part.slice(0, idx) : part;
    const rawValue = idx >= 0 ? part.slice(idx + eq.length) : '';
    const key = decode(rawKey.replace(/\+/g, ' '));
    const value = decode(rawValue.replace(/\+/g, ' '));
    const existing = obj[key];
    if (existing === undefined) obj[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else obj[key] = [existing, value];
  }
  return obj;
}

export const querystringModule = {
  escape,
  unescape,
  stringify,
  encode: stringify,
  parse,
  decode: parse,
  unescapeBuffer: unescapeBytes,
};
