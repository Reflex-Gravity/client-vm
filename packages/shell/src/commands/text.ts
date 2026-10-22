// SPDX-License-Identifier: Apache-2.0
// Text commands: head tail wc sort uniq cut tr tee seq yes.

import { decode, readAll, readLines } from '../io.ts';
import type { Sink, Source } from '../io.ts';
import type { CommandContext } from '../types.ts';
import {
  complain,
  inputs,
  parseOptions,
  quoteName,
  resolvePath,
  strerror,
  UsageError,
  withUsage,
} from './util.ts';

const NL = 0x0a;

function parseCount(s: string, what: string): { n: number; sign: '' | '+' | '-' } {
  const m = /^([+-]?)(\d+)([bkKmMG]?)$/.exec(s.trim());
  if (!m) throw new UsageError(`invalid number of ${what}: ${quoteName(s)}`);
  const mult =
    { '': 1, b: 512, k: 1024, K: 1024, m: 1048576, M: 1048576, G: 1073741824 }[m[3]!] ?? 1;
  return { n: Number(m[2]) * mult, sign: m[1] as '' | '+' | '-' };
}

// ---------------------------------------------------------------------- head

export async function head(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'qvz',
      shortArg: 'nc',
      numeric: 'n',
      long: {
        lines: { name: 'n', arg: true },
        bytes: { name: 'c', arg: true },
        quiet: { name: 'q' },
        silent: { name: 'q' },
        verbose: { name: 'v' },
      },
    });
    const byBytes = o.flags.has('c') && (!o.flags.has('n') || lastOf(o.list, ['c', 'n']) === 'c');
    const spec = parseCount(
      String(o.flags.get(byBytes ? 'c' : 'n') ?? '10'),
      byBytes ? 'bytes' : 'lines',
    );
    const allBut = spec.sign === '-';
    const files = o.operands;
    const headers = (files.length > 1 && !o.flags.has('q')) || o.flags.has('v');
    let status = 0;
    let first = true;
    for await (const input of inputs(ctx, files)) {
      if ('error' in input) {
        await complain(
          ctx,
          `cannot open ${quoteName(input.name)} for reading: ${strerror(input.error)}`,
        );
        status = 1;
        continue;
      }
      if (headers) {
        await ctx.stdout.write(
          `${first ? '' : '\n'}==> ${input.name === '-' ? 'standard input' : input.name} <==\n`,
        );
      }
      first = false;
      if (byBytes) {
        if (allBut) {
          const all = await readAll(input.source);
          await ctx.stdout.write(all.subarray(0, Math.max(0, all.length - spec.n)));
          continue;
        }
        let left = spec.n;
        while (left > 0) {
          const chunk = await input.source.read();
          if (chunk === null) break;
          const part = chunk.subarray(0, left);
          await ctx.stdout.write(part);
          left -= part.length;
          if (chunk.length > part.length) input.source.unshift(chunk.subarray(part.length));
        }
        continue;
      }
      if (allBut) {
        const all = await readAll(input.source);
        const ends: number[] = [];
        for (let i = all.indexOf(NL); i >= 0; i = all.indexOf(NL, i + 1)) ends.push(i);
        const totalLines = ends.length + (all.length > 0 && all[all.length - 1] !== NL ? 1 : 0);
        const keep = totalLines - spec.n;
        if (keep <= 0) continue;
        const end = keep - 1 < ends.length ? ends[keep - 1]! + 1 : all.length;
        await ctx.stdout.write(all.subarray(0, end));
        continue;
      }
      let left = spec.n;
      while (left > 0) {
        const chunk = await input.source.read();
        if (chunk === null) break;
        let i = 0;
        let cut = -1;
        while (left > 0) {
          const j = chunk.indexOf(NL, i);
          if (j < 0) break;
          left--;
          i = j + 1;
          if (left === 0) cut = i;
        }
        if (cut >= 0) {
          await ctx.stdout.write(chunk.subarray(0, cut));
          // Leave the rest unread (like head on a seekable file).
          if (cut < chunk.length) input.source.unshift(chunk.subarray(cut));
          break;
        }
        await ctx.stdout.write(chunk);
      }
    }
    return status;
  });
}

function lastOf(list: { name: string }[], names: string[]): string | undefined {
  for (let i = list.length - 1; i >= 0; i--)
    if (names.includes(list[i]!.name)) return list[i]!.name;
  return undefined;
}

// ---------------------------------------------------------------------- tail

export async function tail(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    // Obsolete `tail +N` means `tail -n +N`.
    const args = ctx.argv
      .slice(1)
      .map((a, i, all) =>
        /^\+\d+$/.test(a) && !/^-[nc]$|^--(lines|bytes)$/.test(all[i - 1] ?? '') ? `-n${a}` : a,
      );
    const o = parseOptions(args, {
      short: 'qvzfF',
      shortArg: 'ncs',
      numeric: 'n',
      long: {
        lines: { name: 'n', arg: true },
        bytes: { name: 'c', arg: true },
        quiet: { name: 'q' },
        silent: { name: 'q' },
        verbose: { name: 'v' },
        follow: { name: 'f', arg: 'optional' },
        retry: { name: 'retry' },
        'sleep-interval': { name: 's', arg: true },
        pid: { name: 'pid', arg: true },
      },
    });
    const byBytes = o.flags.has('c') && (!o.flags.has('n') || lastOf(o.list, ['c', 'n']) === 'c');
    const spec = parseCount(
      String(o.flags.get(byBytes ? 'c' : 'n') ?? '10'),
      byBytes ? 'bytes' : 'lines',
    );
    const fromStart = spec.sign === '+';
    const files = o.operands;
    const headers = (files.length > 1 && !o.flags.has('q')) || o.flags.has('v');
    let status = 0;
    let first = true;
    for await (const input of inputs(ctx, files)) {
      if ('error' in input) {
        await complain(
          ctx,
          `cannot open ${quoteName(input.name)} for reading: ${strerror(input.error)}`,
        );
        status = 1;
        continue;
      }
      if (headers) {
        await ctx.stdout.write(
          `${first ? '' : '\n'}==> ${input.name === '-' ? 'standard input' : input.name} <==\n`,
        );
      }
      first = false;
      const all = await readAll(input.source);
      await ctx.stdout.write(tailSlice(all, spec.n, fromStart, byBytes));
    }
    if (o.flags.has('f') || o.flags.has('F')) {
      const files2 = files.filter((f) => f !== '-');
      if (files2.length > 0) await follow(ctx, files2);
    }
    return status;
  });
}

function tailSlice(all: Uint8Array, n: number, fromStart: boolean, byBytes: boolean): Uint8Array {
  if (byBytes)
    return fromStart ? all.subarray(Math.max(0, n - 1)) : all.subarray(Math.max(0, all.length - n));
  if (fromStart) {
    let line = 1;
    let i = 0;
    while (line < n) {
      const j = all.indexOf(NL, i);
      if (j < 0) return all.subarray(all.length);
      i = j + 1;
      line++;
    }
    return all.subarray(i);
  }
  if (n === 0) return all.subarray(all.length);
  let end = all.length;
  if (end > 0 && all[end - 1] === NL) end--;
  let count = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (all[i] === NL && ++count === n) return all.subarray(i + 1);
  }
  return all;
}

/** `tail -f`: polls the files for growth until the process is killed. */
async function follow(ctx: CommandContext, files: string[]): Promise<void> {
  const sizes = new Map<string, number>();
  for (const f of files) {
    try {
      sizes.set(f, ctx.fs.statSync(resolvePath(ctx.cwd, f)).size);
    } catch {
      sizes.set(f, 0);
    }
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    for (const f of files) {
      const path = resolvePath(ctx.cwd, f);
      let size: number;
      try {
        size = ctx.fs.statSync(path).size;
      } catch {
        continue;
      }
      const prev = sizes.get(f) ?? 0;
      if (size < prev) {
        await ctx.stderr.write(`tail: ${f}: file truncated\n`);
        sizes.set(f, 0);
        continue;
      }
      if (size === prev) continue;
      const fd = ctx.fs.openSync(path, 'r');
      try {
        const buf = new Uint8Array(size - prev);
        const n = ctx.fs.readSync(fd, buf, 0, buf.length, prev);
        await ctx.stdout.write(buf.subarray(0, n));
      } finally {
        ctx.fs.closeSync(fd);
      }
      sizes.set(f, size);
    }
  }
}

// ------------------------------------------------------------------------ wc

export async function wc(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'lwcmL',
      long: {
        lines: { name: 'l' },
        words: { name: 'w' },
        bytes: { name: 'c' },
        chars: { name: 'm' },
        'max-line-length': { name: 'L' },
        total: { name: 'total', arg: true },
      },
    });
    let want = ['l', 'w', 'm', 'c', 'L'].filter((k) => o.flags.has(k));
    if (want.length === 0) want = ['l', 'w', 'c'];
    const files = o.operands;
    const rows: { counts: number[]; name: string | null }[] = [];
    const totals = want.map(() => 0);
    let status = 0;
    let regularTotal = 0;
    let nonRegular = files.length === 0;
    for await (const input of inputs(ctx, files)) {
      if ('error' in input) {
        await complain(ctx, `${input.name}: ${strerror(input.error)}`);
        status = 1;
        continue;
      }
      if (input.name === '-') nonRegular = true;
      const bytes = await readAll(input.source);
      if (input.name !== '-') regularTotal += bytes.length;
      const c = countText(bytes);
      const counts = want.map((k) => c[k as keyof typeof c]);
      counts.forEach((v, i) => {
        totals[i] = want[i] === 'L' ? Math.max(totals[i]!, v) : totals[i]! + v;
      });
      rows.push({ counts, name: files.length === 0 ? null : input.name });
    }
    const totalMode = String(o.flags.get('total') ?? 'auto');
    if ((rows.length > 1 && totalMode === 'auto') || totalMode === 'always')
      rows.push({ counts: totals, name: 'total' });
    let width = 1;
    if (!(want.length === 1 && files.length <= 1)) {
      width = String(regularTotal).length;
      if (nonRegular) width = Math.max(width, 7);
    }
    if (totalMode === 'only') {
      await ctx.stdout.write(`${totals.join(' ')}\n`);
      return status;
    }
    let out = '';
    for (const r of rows) {
      if (totalMode === 'never' && r.name === 'total' && rows.length > 1) continue;
      out +=
        r.counts.map((n) => String(n).padStart(width)).join(' ') +
        (r.name !== null ? ` ${r.name}` : '') +
        '\n';
    }
    await ctx.stdout.write(out);
    return status;
  });
}

function countText(bytes: Uint8Array) {
  let l = 0;
  let w = 0;
  let inWord = false;
  for (const b of bytes) {
    if (b === NL) l++;
    const space = b === 0x20 || (b >= 0x09 && b <= 0x0d);
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      w++;
    }
  }
  const text = decode(bytes);
  const m = [...text].length;
  let L = 0;
  for (const line of text.split('\n')) {
    let width = 0;
    for (const ch of line) width = ch === '\t' ? width + 8 - (width % 8) : width + 1;
    L = Math.max(L, width);
  }
  return { l, w, c: bytes.length, m, L };
}

// ---------------------------------------------------------------------- sort

interface KeySpec {
  startField: number;
  startChar: number;
  endField: number;
  endChar: number;
  opts: SortOpts;
}

interface SortOpts {
  numeric: boolean;
  general: boolean;
  human: boolean;
  version: boolean;
  reverse: boolean;
  fold: boolean;
  blanks: boolean;
  dictionary: boolean;
  ignoreNonprinting: boolean;
  month: boolean;
}

const MONTH_ORDER = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

function parseKey(spec: string, global: SortOpts): KeySpec {
  const m = /^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*))?$/.exec(spec);
  if (!m) throw new UsageError(`invalid key specification ${quoteName(spec)}`);
  const flags = (m[3] ?? '') + (m[6] ?? '');
  const opts: SortOpts = flags ? optsFrom(flags) : { ...global };
  return {
    startField: Number(m[1]),
    startChar: m[2] ? Number(m[2]) : 1,
    endField: m[4] ? Number(m[4]) : Infinity,
    endChar: m[5] ? Number(m[5]) : 0,
    opts,
  };
}

function optsFrom(flags: string): SortOpts {
  return {
    numeric: flags.includes('n'),
    general: flags.includes('g'),
    human: flags.includes('h'),
    version: flags.includes('V'),
    reverse: flags.includes('r'),
    fold: flags.includes('f'),
    blanks: flags.includes('b'),
    dictionary: flags.includes('d'),
    ignoreNonprinting: flags.includes('i'),
    month: flags.includes('M'),
  };
}

function fieldsOf(line: string, sep: string | null): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (sep !== null) {
    let start = 0;
    for (;;) {
      const i = line.indexOf(sep, start);
      if (i < 0) {
        out.push({ start, end: line.length });
        return out;
      }
      out.push({ start, end: i });
      start = i + sep.length;
    }
  }
  // Default: a field is leading blanks plus non-blanks.
  let i = 0;
  while (i < line.length) {
    const start = i;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
    out.push({ start, end: i });
  }
  if (out.length === 0) out.push({ start: 0, end: 0 });
  return out;
}

function extractKey(line: string, k: KeySpec, sep: string | null): string {
  const fields = fieldsOf(line, sep);
  const sf = fields[k.startField - 1];
  if (!sf) return '';
  let start = sf.start;
  if (k.opts.blanks)
    while (start < sf.end && (line[start] === ' ' || line[start] === '\t')) start++;
  start = Math.min(start + k.startChar - 1, sf.end);
  let end = line.length;
  if (k.endField !== Infinity) {
    const ef = fields[k.endField - 1];
    if (!ef) end = line.length;
    else if (k.endChar === 0) end = ef.end;
    else {
      let s = ef.start;
      if (k.opts.blanks) while (s < ef.end && (line[s] === ' ' || line[s] === '\t')) s++;
      end = Math.min(s + k.endChar, ef.end);
    }
  }
  return end > start ? line.slice(start, end) : '';
}

function numericValue(s: string): number {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return 0;
  return Number(`${m[1]}${m[2] || '0'}.${m[3] || '0'}`);
}

function humanValue(s: string): number {
  const m = /^\s*(-?\d*(?:\.\d*)?)([KMGTPEZY]?)/.exec(s);
  if (!m || m[1] === '' || m[1] === '-') return 0;
  const idx = ' KMGTPEZY'.indexOf(m[2] || ' ');
  return Number(m[1]) * 1024 ** Math.max(idx, 0);
}

function versionCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareKey(a: string, b: string, o: SortOpts): number {
  let x = a;
  let y = b;
  if (o.blanks) {
    x = x.replace(/^[ \t]+/, '');
    y = y.replace(/^[ \t]+/, '');
  }
  if (o.dictionary) {
    x = x.replace(/[^A-Za-z0-9 \t]/g, '');
    y = y.replace(/[^A-Za-z0-9 \t]/g, '');
  }
  if (o.ignoreNonprinting) {
    x = x.replace(/[^\x20-\x7e]/g, '');
    y = y.replace(/[^\x20-\x7e]/g, '');
  }
  let r: number;
  if (o.numeric) r = numericValue(x) - numericValue(y);
  else if (o.general) {
    const nx = parseFloat(x);
    const ny = parseFloat(y);
    r = Number.isNaN(nx) ? (Number.isNaN(ny) ? 0 : -1) : Number.isNaN(ny) ? 1 : nx - ny;
  } else if (o.human) r = humanValue(x) - humanValue(y);
  else if (o.version) r = versionCompare(x, y);
  else if (o.month)
    r =
      MONTH_ORDER.indexOf(x.trim().slice(0, 3).toUpperCase()) -
      MONTH_ORDER.indexOf(y.trim().slice(0, 3).toUpperCase());
  else if (o.fold) r = compareStrings(x.toUpperCase(), y.toUpperCase());
  else r = compareStrings(x, y);
  return o.reverse ? -r : r;
}

export async function sort(ctx: CommandContext): Promise<number> {
  return withUsage(
    ctx,
    async () => {
      const o = parseOptions(ctx.argv.slice(1), {
        short: 'bdfgiMhnRrVcCsuz',
        shortArg: 'ktoST',
        long: {
          reverse: { name: 'r' },
          numeric: { name: 'n' },
          'numeric-sort': { name: 'n' },
          'general-numeric-sort': { name: 'g' },
          'human-numeric-sort': { name: 'h' },
          'version-sort': { name: 'V' },
          'month-sort': { name: 'M' },
          'ignore-case': { name: 'f' },
          'ignore-leading-blanks': { name: 'b' },
          'dictionary-order': { name: 'd' },
          unique: { name: 'u' },
          key: { name: 'k', arg: true },
          'field-separator': { name: 't', arg: true },
          output: { name: 'o', arg: true },
          stable: { name: 's' },
          check: { name: 'c', arg: 'optional' },
          'zero-terminated': { name: 'z' },
          'random-sort': { name: 'R' },
          parallel: { name: 'parallel', arg: true },
          'buffer-size': { name: 'S', arg: true },
        },
      });
      const f = o.flags;
      const global = optsFrom([...'bdfgiMhnrV'].filter((c) => f.has(c)).join(''));
      const keys = o.list
        .filter((x) => x.name === 'k')
        .map((x) => parseKey(String(x.value), global));
      const sepRaw = f.get('t');
      let sep: string | null = null;
      if (typeof sepRaw === 'string') {
        sep = sepRaw === '\\0' ? '\0' : sepRaw;
        if (sep.length !== 1) throw new UsageError(`multi-character tab ${quoteName(sep)}`);
      }
      const delim = f.has('z') ? 0 : NL;
      const lines: string[] = [];
      const status = 0;
      for await (const input of inputs(ctx, o.operands)) {
        if ('error' in input) {
          await complain(ctx, `cannot read: ${input.name}: ${strerror(input.error)}`);
          return 2;
        }
        for (const l of await readLines(input.source, delim)) lines.push(l.text);
      }
      const cmp = (a: string, b: string): number => {
        if (keys.length > 0) {
          for (const k of keys) {
            const r = compareKey(extractKey(a, k, sep), extractKey(b, k, sep), k.opts);
            if (r !== 0) return r;
          }
        } else {
          const r = compareKey(a, b, global);
          if (r !== 0) return r;
        }
        if (f.has('s') || f.has('u')) return 0;
        // Last resort: whole-line byte comparison (reversed with -r).
        const r = compareStrings(a, b);
        return global.reverse ? -r : r;
      };
      if (f.has('c') || f.has('C')) {
        for (let i = 1; i < lines.length; i++) {
          const r = cmp(lines[i - 1]!, lines[i]!);
          if (r > 0 || (f.has('u') && r === 0)) {
            if (!f.has('C') && f.get('c') !== 'quiet' && f.get('c') !== 'silent') {
              await ctx.stderr.write(
                `sort: ${o.operands[0] ?? '-'}:${i + 1}: disorder: ${lines[i]}\n`,
              );
            }
            return 1;
          }
        }
        return 0;
      }
      const indexed = lines.map((l, i) => ({ l, i }));
      indexed.sort((a, b) => cmp(a.l, b.l) || a.i - b.i);
      let out = indexed.map((x) => x.l);
      if (f.has('u')) {
        const uniq: string[] = [];
        for (const l of out)
          if (uniq.length === 0 || cmp(uniq[uniq.length - 1]!, l) !== 0) uniq.push(l);
        out = uniq;
      }
      const term = f.has('z') ? '\0' : '\n';
      const text = out.map((l) => l + term).join('');
      if (f.has('o')) {
        try {
          ctx.fs.writeFileSync(resolvePath(ctx.cwd, String(f.get('o'))), text);
        } catch (err) {
          await complain(ctx, `open failed: ${f.get('o')}: ${strerror(err)}`);
          return 2;
        }
      } else await ctx.stdout.write(text);
      return status;
    },
    2,
  );
}

// ---------------------------------------------------------------------- uniq

export async function uniq(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'cdDuiz',
      shortArg: 'fsw',
      long: {
        count: { name: 'c' },
        repeated: { name: 'd' },
        'all-repeated': { name: 'D', arg: 'optional' },
        unique: { name: 'u' },
        'ignore-case': { name: 'i' },
        'skip-fields': { name: 'f', arg: true },
        'skip-chars': { name: 's', arg: true },
        'check-chars': { name: 'w', arg: true },
        'zero-terminated': { name: 'z' },
      },
    });
    const f = o.flags;
    const skipFields = Number(f.get('f') ?? 0);
    const skipChars = Number(f.get('s') ?? 0);
    const check = f.has('w') ? Number(f.get('w')) : Infinity;
    const keyOf = (line: string) => {
      let s = line;
      for (let i = 0; i < skipFields; i++) s = s.replace(/^[ \t]*[^ \t]*/, '');
      s = s.slice(skipChars);
      if (check !== Infinity) s = [...s].slice(0, check).join('');
      return f.has('i') ? s.toLowerCase() : s;
    };
    const [inName, outName] = o.operands;
    let src: Source = ctx.stdin;
    let sink: Sink = ctx.stdout;
    const closers: (() => void)[] = [];
    if (inName !== undefined && inName !== '-') {
      const it = inputs(ctx, [inName]);
      const r = await it.next();
      const input = r.value as { name: string; source: Source } | { name: string; error: unknown };
      if ('error' in input) {
        await complain(ctx, `${inName}: ${strerror(input.error)}`);
        return 1;
      }
      src = input.source;
      closers.push(() => void it.return(undefined));
    }
    const chunks: string[] = [];
    if (outName !== undefined && outName !== '-')
      sink = { write: (d) => void chunks.push(typeof d === 'string' ? d : decode(d)) };
    const delim = f.has('z') ? 0 : NL;
    const term = f.has('z') ? '\0' : '\n';
    let prev: string | null = null;
    let prevKey = '';
    let count = 0;
    let groupStarted = false;
    const allRepeated = f.has('D');
    const sepMode = f.get('D');
    let out = '';
    const flush = () => {
      if (prev === null) return;
      if (allRepeated) return;
      if (f.has('d') && count < 2) return;
      if (f.has('u') && count > 1) return;
      out += f.has('c') ? `${String(count).padStart(7)} ${prev}${term}` : `${prev}${term}`;
    };
    const group: string[] = [];
    const flushGroup = () => {
      if (allRepeated && group.length > 1) {
        if (sepMode === 'prepend' || (sepMode === 'separate' && groupStarted)) out += term;
        out += group.map((l) => l + term).join('');
        groupStarted = true;
      }
      group.length = 0;
    };
    for (const l of await readLines(src, delim)) {
      const key = keyOf(l.text);
      if (prev !== null && key === prevKey) {
        count++;
        group.push(l.text);
        continue;
      }
      flush();
      flushGroup();
      prev = l.text;
      prevKey = key;
      count = 1;
      group.push(l.text);
    }
    flush();
    flushGroup();
    await sink.write(out);
    for (const c of closers) c();
    if (outName !== undefined && outName !== '-')
      ctx.fs.writeFileSync(resolvePath(ctx.cwd, outName), chunks.join(''));
    return 0;
  });
}

// ----------------------------------------------------------------------- cut

function parseList(spec: string): { ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  for (const part of spec.split(/[, ]/)) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (m[1] === '' && m[3] === '') || (m[2] === '' && m[3] !== '')) {
      throw new UsageError(
        part === '' ? 'fields and positions are numbered from 1' : `invalid field range`,
      );
    }
    const a = m[1] === '' ? 1 : Number(m[1]);
    const b = m[2] === '' ? a : m[3] === '' ? Infinity : Number(m[3]);
    if (a === 0 || b === 0) throw new UsageError('fields and positions are numbered from 1');
    if (b < a) throw new UsageError('invalid decreasing range');
    ranges.push([a, b]);
  }
  return { ranges };
}

export async function cut(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'snz',
      shortArg: 'bcfd',
      long: {
        bytes: { name: 'b', arg: true },
        characters: { name: 'c', arg: true },
        fields: { name: 'f', arg: true },
        delimiter: { name: 'd', arg: true },
        'only-delimited': { name: 's' },
        complement: { name: 'complement' },
        'output-delimiter': { name: 'od', arg: true },
        'zero-terminated': { name: 'z' },
      },
    });
    const f = o.flags;
    const modes = ['b', 'c', 'f'].filter((k) => f.has(k));
    if (modes.length !== 1) {
      throw new UsageError(
        modes.length === 0
          ? 'you must specify a list of bytes, characters, or fields'
          : 'only one list may be specified',
      );
    }
    const mode = modes[0]!;
    const { ranges } = parseList(String(f.get(mode)));
    const complement = f.has('complement');
    const selected = (i: number) => ranges.some(([a, b]) => i >= a && i <= b) !== complement;
    const delim = typeof f.get('d') === 'string' ? (f.get('d') as string) : '\t';
    if (mode === 'f' && delim.length !== 1)
      throw new UsageError('the delimiter must be a single character');
    const outDelim =
      typeof f.get('od') === 'string' ? (f.get('od') as string) : mode === 'f' ? delim : null;
    const term = f.has('z') ? '\0' : '\n';
    let status = 0;
    for await (const input of inputs(ctx, o.operands)) {
      if ('error' in input) {
        await complain(ctx, `${input.name}: ${strerror(input.error)}`);
        status = 1;
        continue;
      }
      let out = '';
      for (const l of await readLines(input.source, f.has('z') ? 0 : NL)) {
        const line = l.text;
        if (mode === 'f') {
          if (!line.includes(delim)) {
            if (!f.has('s')) out += line + term;
            continue;
          }
          const parts = line.split(delim);
          out += parts.filter((_, i) => selected(i + 1)).join(outDelim ?? delim) + term;
        } else {
          const units =
            mode === 'c'
              ? [...line]
              : [...new TextEncoder().encode(line)].map((b) => String.fromCharCode(b));
          if (outDelim === null) {
            const picked = units.filter((_, i) => selected(i + 1)).join('');
            out += (mode === 'b' ? latin1ToUtf8(picked) : picked) + term;
          } else {
            // With --output-delimiter, separate runs of selected positions.
            const runs: string[] = [];
            let cur: string | null = null;
            units.forEach((u, i) => {
              if (selected(i + 1)) cur = (cur ?? '') + u;
              else if (cur !== null) {
                runs.push(cur);
                cur = null;
              }
            });
            if (cur !== null) runs.push(cur);
            out += runs.map((r) => (mode === 'b' ? latin1ToUtf8(r) : r)).join(outDelim) + term;
          }
        }
      }
      await ctx.stdout.write(out);
    }
    return status;
  });
}

function latin1ToUtf8(s: string): Uint8Array | string {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ------------------------------------------------------------------------ tr

const TR_CLASSES: Record<string, () => number[]> = {
  alpha: () => [...range(65, 90), ...range(97, 122)],
  digit: () => range(48, 57),
  alnum: () => [...range(48, 57), ...range(65, 90), ...range(97, 122)],
  upper: () => range(65, 90),
  lower: () => range(97, 122),
  space: () => [9, 10, 11, 12, 13, 32],
  blank: () => [9, 32],
  punct: () => [...range(33, 47), ...range(58, 64), ...range(91, 96), ...range(123, 126)],
  xdigit: () => [...range(48, 57), ...range(65, 70), ...range(97, 102)],
  cntrl: () => [...range(0, 31), 127],
  print: () => range(32, 126),
  graph: () => range(33, 126),
};

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Parses a tr SET into bytes. Returns class names used (for upper/lower pairing). */
function parseSet(spec: string): { bytes: number[]; classes: string[] } {
  const src = [...new TextEncoder().encode(spec)];
  const out: number[] = [];
  const classes: string[] = [];
  const text = String.fromCharCode(...src);
  let i = 0;
  const readChar = (): number => {
    const c = text.charCodeAt(i);
    if (text[i] === '\\' && i + 1 < text.length) {
      const n = text[i + 1]!;
      const esc: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        a: 7,
        b: 8,
        f: 12,
        v: 11,
        '\\': 92,
      };
      if (n in esc) {
        i += 2;
        return esc[n]!;
      }
      const m = /^[0-7]{1,3}/.exec(text.slice(i + 1));
      if (m) {
        i += 1 + m[0].length;
        return parseInt(m[0], 8) & 0xff;
      }
      i += 2;
      return n.charCodeAt(0);
    }
    i++;
    return c;
  };
  while (i < text.length) {
    if (text.startsWith('[:', i)) {
      const end = text.indexOf(':]', i + 2);
      const name = end > 0 ? text.slice(i + 2, end) : '';
      const cls = TR_CLASSES[name];
      if (cls) {
        out.push(...cls());
        classes.push(name);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '[' && /^\[.\*\d*\]/.test(text.slice(i))) {
      const m = /^\[(.)\*(\d*)\]/.exec(text.slice(i))!;
      const ch = m[1]!.charCodeAt(0);
      const n = m[2] ? parseInt(m[2], m[2].startsWith('0') ? 8 : 10) : -1;
      // -1 means "fill to the length of SET1"; marked with a negative placeholder.
      if (n < 0) out.push(-1 - ch);
      else for (let k = 0; k < n; k++) out.push(ch);
      i += m[0].length;
      continue;
    }
    const a = readChar();
    if (text[i] === '-' && i + 1 < text.length) {
      i++;
      const b = readChar();
      if (b < a)
        throw new UsageError(
          `range-endpoints of '${String.fromCharCode(a)}-${String.fromCharCode(b)}' are in reverse collating sequence order`,
        );
      out.push(...range(a, b));
      continue;
    }
    out.push(a);
  }
  return { bytes: out, classes };
}

export async function tr(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'cCdst',
      long: {
        complement: { name: 'c' },
        delete: { name: 'd' },
        'squeeze-repeats': { name: 's' },
        'truncate-set1': { name: 't' },
      },
    });
    const f = o.flags;
    const complement = f.has('c') || f.has('C');
    const del = f.has('d');
    const squeeze = f.has('s');
    const [s1, s2] = o.operands;
    if (s1 === undefined) throw new UsageError('missing operand');
    if (!del && !squeeze && s2 === undefined)
      throw new UsageError(`missing operand after ${quoteName(s1)}`);
    const set1 = parseSet(s1);
    let in1 = new Set(set1.bytes.filter((b) => b >= 0));
    if (complement) {
      const c = new Set<number>();
      for (let b = 0; b < 256; b++) if (!in1.has(b)) c.add(b);
      in1 = c;
    }
    const map = new Map<number, number>();
    let squeezeSet = new Set<number>();
    if (!del && s2 !== undefined) {
      const set2 = parseSet(s2);
      const list1 = complement ? [...in1].sort((a, b) => a - b) : set1.bytes.filter((b) => b >= 0);
      let list2 = set2.bytes;
      const fill = list2.findIndex((b) => b < 0);
      if (fill >= 0) {
        const ch = -1 - list2[fill]!;
        const n = Math.max(0, list1.length - (list2.length - 1));
        list2 = [...list2.slice(0, fill), ...Array<number>(n).fill(ch), ...list2.slice(fill + 1)];
      }
      if (set1.classes.includes('upper') && set2.classes.includes('lower') && !complement) {
        for (let b = 65; b <= 90; b++) map.set(b, b + 32);
      } else if (set1.classes.includes('lower') && set2.classes.includes('upper') && !complement) {
        for (let b = 97; b <= 122; b++) map.set(b, b - 32);
      } else {
        if (list2.length === 0)
          throw new UsageError('when not truncating set1, string2 must be non-empty');
        if (f.has('t')) list1.splice(list2.length);
        const last = list2[list2.length - 1]!;
        list1.forEach((b, i) => map.set(b, list2[i] ?? last));
      }
      squeezeSet = new Set(list2);
    } else if (squeeze) {
      squeezeSet = del && s2 !== undefined ? new Set(parseSet(s2).bytes) : in1;
    }
    if (del && squeeze && s2 === undefined) throw new UsageError('missing operand');
    let last = -1;
    for (let chunk = await ctx.stdin.read(); chunk !== null; chunk = await ctx.stdin.read()) {
      const out: number[] = [];
      for (const b of chunk) {
        let x = b;
        if (del) {
          if (in1.has(x)) continue;
        } else if (map.size > 0 || !squeeze) {
          if (in1.has(x)) x = map.get(x) ?? x;
        }
        if (squeeze && squeezeSet.has(x) && x === last) continue;
        out.push(x);
        last = x;
      }
      await ctx.stdout.write(Uint8Array.from(out));
    }
    return 0;
  });
}

// ----------------------------------------------------------------------- tee

export async function tee(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'aip',
      long: {
        append: { name: 'a' },
        'ignore-interrupts': { name: 'i' },
        'output-error': { name: 'p', arg: 'optional' },
      },
    });
    let status = 0;
    const fds: { fd: number; name: string }[] = [];
    for (const name of o.operands) {
      try {
        fds.push({
          fd: ctx.fs.openSync(resolvePath(ctx.cwd, name), o.flags.has('a') ? 'a' : 'w'),
          name,
        });
      } catch (err) {
        await complain(ctx, `${name}: ${strerror(err)}`);
        status = 1;
      }
    }
    try {
      for (let chunk = await ctx.stdin.read(); chunk !== null; chunk = await ctx.stdin.read()) {
        for (const f of fds) ctx.fs.writeSync(f.fd, chunk);
        await ctx.stdout.write(chunk);
      }
    } finally {
      for (const f of fds) ctx.fs.closeSync(f.fd);
    }
    return status;
  });
}

// ----------------------------------------------------------------------- seq

export async function seq(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const args = ctx.argv.slice(1);
    let sep = '\n';
    let width = false;
    let format: string | null = null;
    const nums: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-s' || a === '--separator') sep = args[++i] ?? '';
      else if (a.startsWith('-s') && !/^-s?\d/.test(a) && a.length > 2) sep = a.slice(2);
      else if (a.startsWith('--separator=')) sep = a.slice(12);
      else if (a === '-w' || a === '--equal-width') width = true;
      else if (a === '-f' || a === '--format') format = args[++i] ?? '';
      else if (a.startsWith('--format=')) format = a.slice(9);
      else nums.push(a);
    }
    if (nums.length === 0) throw new UsageError('missing operand');
    if (nums.length > 3) throw new UsageError(`extra operand ${quoteName(nums[3]!)}`);
    for (const n of nums) {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(n)) {
        await complain(ctx, `invalid floating point argument: ${quoteName(n)}`);
        await ctx.stderr.write("Try 'seq --help' for more information.\n");
        return 1;
      }
    }
    const first = nums.length > 1 ? nums[0]! : '1';
    const inc = nums.length === 3 ? nums[1]! : '1';
    const last = nums[nums.length - 1]!;
    const decimals = (s: string) => (/e/i.test(s) ? 0 : (s.split('.')[1] ?? '').length);
    const prec = Math.max(decimals(first), decimals(inc));
    const a = Number(first);
    const step = Number(inc);
    const b = Number(last);
    if (step === 0) {
      await complain(ctx, `invalid Zero increment value: ${quoteName(inc)}`);
      return 1;
    }
    const values: string[] = [];
    const count = Math.floor((b - a) / step + 1e-10);
    for (let k = 0; k <= count; k++) {
      const v = a + k * step;
      values.push(
        format ? formatNumber(format, v) : prec > 0 ? v.toFixed(prec) : String(Math.round(v)),
      );
      if (values.length > 10_000_000) break;
    }
    let out = values;
    if (width && !format) {
      const w = Math.max(...values.map((v) => v.replace('-', '').length), 0);
      out = values.map((v) =>
        v.startsWith('-') ? `-${v.slice(1).padStart(w - 1, '0')}` : v.padStart(w, '0'),
      );
    }
    if (out.length > 0) await ctx.stdout.write(out.join(sep) + '\n');
    return 0;
  });
}

function formatNumber(format: string, v: number): string {
  return format.replace(
    /%([-+ #0]*)(\d*)(?:\.(\d+))?([feEgG%])/g,
    (_m, flags: string, w: string, p: string | undefined, conv: string) => {
      if (conv === '%') return '%';
      const precision = p === undefined ? 6 : Number(p);
      let s =
        conv === 'f'
          ? v.toFixed(precision)
          : conv.toLowerCase() === 'e'
            ? v.toExponential(precision)
            : String(Number(v.toPrecision(precision || 1)));
      if (conv === 'E' || conv === 'G') s = s.toUpperCase();
      const width = Number(w || 0);
      if (s.length < width)
        s = flags.includes('-')
          ? s.padEnd(width)
          : flags.includes('0')
            ? s.padStart(width, '0')
            : s.padStart(width);
      return s;
    },
  );
}

// ----------------------------------------------------------------------- rev

export async function rev(ctx: CommandContext): Promise<number> {
  let status = 0;
  for await (const input of inputs(ctx, ctx.argv.slice(1))) {
    if ('error' in input) {
      await complain(ctx, `cannot open ${input.name}: ${strerror(input.error)}`);
      status = 1;
      continue;
    }
    let out = '';
    for (const l of await readLines(input.source))
      out += [...l.text].reverse().join('') + (l.newline ? '\n' : '');
    await ctx.stdout.write(out);
  }
  return status;
}

// ----------------------------------------------------------------------- yes

export async function yes(ctx: CommandContext): Promise<number> {
  const text = `${ctx.argv.length > 1 ? ctx.argv.slice(1).join(' ') : 'y'}\n`;
  // Write in batches; the pipe's EPIPE ends the loop.
  const batch = new TextEncoder().encode(text.repeat(Math.max(1, Math.floor(8192 / text.length))));
  for (;;) await ctx.stdout.write(batch);
}
