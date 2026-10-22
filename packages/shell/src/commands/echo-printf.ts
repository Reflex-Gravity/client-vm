// SPDX-License-Identifier: Apache-2.0
// `echo` (bash builtin flavor: -n -e -E) and `printf` (bash: %b %q, `-v var`).

import type { CommandContext } from '../types.ts';

/** Expands backslash escapes (echo -e, printf %b). `stop` is set by \c. */
function escapes(s: string, printfFormat: boolean): { text: string; stop: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i]!;
    switch (n) {
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'c':
        if (printfFormat) {
          out += '\\c';
          break;
        }
        return { text: out, stop: true };
      case 'e':
      case 'E':
        out += '\x1b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'v':
        out += '\v';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += printfFormat ? '"' : '\\"';
        break;
      case "'":
        out += printfFormat ? "'" : "\\'";
        break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (!m) {
          out += '\\x';
          break;
        }
        out += String.fromCharCode(parseInt(m[0], 16));
        i += m[0].length;
        break;
      }
      case 'u':
      case 'U': {
        const m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(i + 1));
        if (!m) {
          out += `\\${n}`;
          break;
        }
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
        break;
      }
      default:
        if (/[0-7]/.test(n)) {
          // echo -e and %b: \0NNN (up to 3 digits after 0); printf format: \NNN.
          const re = printfFormat ? /^[0-7]{1,3}/ : n === '0' ? /^0[0-7]{0,3}/ : /^[0-7]{1,3}/;
          const m = re.exec(s.slice(i))!;
          const digits = !printfFormat && n === '0' ? m[0].slice(1) || '0' : m[0];
          out += String.fromCharCode(parseInt(digits, 8) & 0xff);
          i += m[0].length - 1;
        } else {
          out += `\\${n}`;
        }
    }
  }
  return { text: out, stop: false };
}

export async function echo(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let newline = true;
  let interpret = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (!/^-[neE]+$/.test(a)) break;
    for (const f of a.slice(1)) {
      if (f === 'n') newline = false;
      else if (f === 'e') interpret = true;
      else interpret = false;
    }
  }
  let text = args.slice(i).join(' ');
  if (interpret) {
    const r = escapes(text, false);
    text = r.text;
    if (r.stop) newline = false;
  }
  await ctx.stdout.write(newline ? `${text}\n` : text);
  return 0;
}

// --------------------------------------------------------------------- printf

class PrintfState {
  status = 0;
  errors: string[] = [];
}

function parseIntArg(arg: string | undefined, st: PrintfState): bigint {
  if (arg === undefined || arg === '') return 0n;
  if (arg[0] === "'" || arg[0] === '"') return BigInt(arg.codePointAt(1) ?? 0);
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(arg);
  if (!m) {
    st.errors.push(`${arg}: invalid number`);
    st.status = 1;
    return 0n;
  }
  const body = m[2]!;
  let n: bigint;
  if (/^0[xX]/.test(body)) n = BigInt(body);
  else if (body.length > 1 && body[0] === '0') n = BigInt(`0o${body.slice(1)}`);
  else n = BigInt(body);
  if (m[1] === '-') n = -n;
  if (m[0].length !== arg.length) {
    st.errors.push(`${arg}: invalid number`);
    st.status = 1;
  }
  return n;
}

function parseFloatArg(arg: string | undefined, st: PrintfState): number {
  if (arg === undefined || arg === '') return 0;
  if (arg[0] === "'" || arg[0] === '"') return arg.codePointAt(1) ?? 0;
  const t = arg.trim();
  const n = /^[+-]?0[xX]/.test(t) ? Number(BigInt(t.replace(/^\+/, ''))) : Number(t);
  if (Number.isNaN(n) && !/^[+-]?nan$/i.test(t)) {
    st.errors.push(`${arg}: invalid number`);
    st.status = 1;
    return parseFloat(t) || 0;
  }
  return n;
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) {
    const sign = /^[+\- ]/.test(s) ? s[0]! : '';
    const prefix = /^[+\- ]?0[xX]/.test(s) ? s.slice(0, sign.length + 2) : sign;
    return prefix + '0'.repeat(width - s.length) + s.slice(prefix.length);
  }
  return ' '.repeat(width - s.length) + s;
}

/** C's %g: shortest of %e/%f with `precision` significant digits. */
function formatG(n: number, precision: number, alt: boolean, upper: boolean): string {
  if (!Number.isFinite(n)) return formatSpecial(n, upper);
  const p = precision === 0 ? 1 : precision;
  if (n === 0) return alt ? `0.${'0'.repeat(p - 1)}` : '0';
  const exp = Math.floor(Math.log10(Math.abs(Number(n.toExponential(p - 1)))));
  let s: string;
  if (exp < -4 || exp >= p) {
    s = formatE(n, p - 1, upper);
    if (!alt) s = s.replace(/\.?0+(?=[eE])/, '');
  } else {
    s = n.toFixed(Math.max(p - 1 - exp, 0));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

function formatE(n: number, precision: number, upper: boolean): string {
  if (!Number.isFinite(n)) return formatSpecial(n, upper);
  const s = n.toExponential(precision).replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

function formatSpecial(n: number, upper: boolean): string {
  const s = Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';
  return upper ? s.toUpperCase() : s;
}

/** bash `printf %q`. */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) {
    let out = "$'";
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (ch === "'" || ch === '\\') out += `\\${ch}`;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
      else out += ch;
    }
    return `${out}'`;
  }
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, '\\$&');
}

/** Formats once through `format`; returns the output, args consumed, and whether %b hit \c. */
function formatOnce(
  format: string,
  args: string[],
  start: number,
  st: PrintfState,
): { out: string; used: number; stop: boolean } {
  let out = '';
  let ai = start;
  const next = () => args[ai++];
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!;
    if (c === '\\') {
      const m =
        /^\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[\s\S])?/.exec(
          format.slice(i),
        )!;
      const seq = m[0];
      if (seq === '\\c') return { out, used: ai - start, stop: true };
      out += escapes(seq, true).text;
      i += seq.length - 1;
      continue;
    }
    if (c !== '%') {
      out += c;
      continue;
    }
    const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXfFeEgGcsbqaA%])/.exec(format.slice(i));
    if (!m) {
      const conv = format[i + 1] ?? '';
      st.errors.push(`%${conv}: invalid format character`);
      st.status = 1;
      return { out, used: ai - start, stop: true };
    }
    i += m[0].length - 1;
    const flags = m[1]!;
    const conv = m[4]!;
    if (conv === '%') {
      out += '%';
      continue;
    }
    let width = 0;
    let left = flags.includes('-');
    if (m[2] === '*') {
      const w = Number(parseIntArg(next(), st));
      if (w < 0) left = true;
      width = Math.abs(w);
    } else if (m[2]) width = Number(m[2]);
    let precision: number | null = null;
    if (m[3] !== undefined) {
      precision = m[3] === '*' ? Number(parseIntArg(next(), st)) : Number(m[3] || 0);
      if (precision < 0) precision = null;
    }
    const zero = flags.includes('0') && !left;
    const plus = flags.includes('+');
    const space = flags.includes(' ');
    const alt = flags.includes('#');
    const sign = (neg: boolean) => (neg ? '-' : plus ? '+' : space ? ' ' : '');
    let s: string;
    switch (conv) {
      case 's':
        s = next() ?? '';
        if (precision !== null) s = s.slice(0, precision);
        out += pad(s, width, left, false);
        break;
      case 'b': {
        const r = escapes(next() ?? '', false);
        s = r.text;
        if (precision !== null) s = s.slice(0, precision);
        out += pad(s, width, left, false);
        if (r.stop) return { out, used: ai - start, stop: true };
        break;
      }
      case 'q':
        out += pad(shellQuote(next() ?? ''), width, left, false);
        break;
      case 'c':
        out += pad((next() ?? '').slice(0, 1), width, left, false);
        break;
      case 'd':
      case 'i': {
        const n = parseIntArg(next(), st);
        let digits = (n < 0n ? -n : n).toString();
        if (precision !== null) digits = digits.padStart(precision, '0');
        if (precision === 0 && n === 0n) digits = '';
        out += pad(sign(n < 0n) + digits, width, left, zero && precision === null);
        break;
      }
      case 'u':
      case 'o':
      case 'x':
      case 'X': {
        let n = parseIntArg(next(), st);
        if (n < 0n) n = BigInt.asUintN(64, n);
        let digits = conv === 'o' ? n.toString(8) : conv === 'u' ? n.toString() : n.toString(16);
        if (conv === 'X') digits = digits.toUpperCase();
        if (precision !== null) digits = digits.padStart(precision, '0');
        if (alt && n !== 0n) {
          if (conv === 'o' && !digits.startsWith('0')) digits = `0${digits}`;
          if (conv === 'x') digits = `0x${digits}`;
          if (conv === 'X') digits = `0X${digits}`;
        }
        out += pad(digits, width, left, zero && precision === null);
        break;
      }
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G':
      case 'a':
      case 'A': {
        const n = parseFloatArg(next(), st);
        const p = precision ?? 6;
        const upper = conv === conv.toUpperCase();
        let body: string;
        const abs = Math.abs(n);
        if (conv === 'f' || conv === 'F')
          body = Number.isFinite(abs) ? abs.toFixed(p) : formatSpecial(abs, upper);
        else if (conv === 'e' || conv === 'E') body = formatE(abs, p, upper);
        else if (conv === 'g' || conv === 'G') body = formatG(abs, p, alt, upper);
        else body = abs.toString(16);
        if (alt && p === 0 && (conv === 'f' || conv === 'F') && !body.includes('.')) body += '.';
        const neg = n < 0 || Object.is(n, -0);
        out += pad(sign(neg) + body, width, left, zero && Number.isFinite(n));
        break;
      }
    }
  }
  return { out, used: ai - start, stop: false };
}

/** Formats `format` with `args`, reusing the format while arguments remain. */
export function printfFormat(
  format: string,
  args: string[],
): { out: string; status: number; errors: string[] } {
  const st = new PrintfState();
  let out = '';
  let pos = 0;
  do {
    const r = formatOnce(format, args, pos, st);
    out += r.out;
    pos += r.used;
    if (r.stop || r.used === 0) break;
  } while (pos < args.length);
  return { out, status: st.status, errors: st.errors };
}

export async function printf(ctx: CommandContext): Promise<number> {
  let args = ctx.argv.slice(1);
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0) {
    await ctx.stderr.write('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  const r = printfFormat(args[0]!, args.slice(1));
  await ctx.stdout.write(r.out);
  for (const e of r.errors) await ctx.stderr.write(`${ctx.argv[0]}: ${e}\n`);
  return r.status;
}
