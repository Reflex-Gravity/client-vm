// SPDX-License-Identifier: Apache-2.0
// `diff`: normal and unified output (-u/-U N), -q, -r, -N, -i -w -b -B.

import { decode } from '../io.ts';
import { readAll } from '../io.ts';
import type { CommandContext } from '../types.ts';
import { complain, fileSource, parseOptions, resolvePath, strerror, withUsage } from './util.ts';

interface Hunk {
  /** Start index (0-based) and length in each file. */
  a: number;
  aLen: number;
  b: number;
  bLen: number;
}

/** Myers' O(ND) diff over keys; returns the edit as matched index pairs. */
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // Trim common prefix and suffix first.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const N = A.length;
  const M = B.length;
  const max = N + M;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!)) x = v[max + k + 1]!;
      else x = v[max + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const mid: [number, number][] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[max + k - 1]! < vd[max + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[max + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      mid.push([x - 1 + start, y - 1 + start]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    mid.push([x - 1 + start, y - 1 + start]);
    x--;
    y--;
  }
  pairs.push(...mid.reverse());
  for (let i = 0; i < n - endA; i++) pairs.push([endA + i, endB + i]);
  return pairs;
}

function hunksFrom(pairs: [number, number][], n: number, m: number): Hunk[] {
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [x, y] of [...pairs, [n, m] as [number, number]]) {
    if (x > ai || y > bi) hunks.push({ a: ai, aLen: x - ai, b: bi, bLen: y - bi });
    ai = x + 1;
    bi = y + 1;
  }
  return hunks;
}

const range = (start: number, len: number) =>
  len <= 1 ? String(start + (len === 0 ? 0 : 1)) : `${start + 1},${start + len}`;

interface Lines {
  lines: string[];
  /** False when the file does not end with a newline. */
  finalNewline: boolean;
}

function splitLines(text: string): Lines {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  const lines = (finalNewline ? text.slice(0, -1) : text).split('\n');
  return { lines, finalNewline };
}

const NO_NEWLINE = '\\ No newline at end of file\n';

function normalDiff(A: Lines, B: Lines, hunks: Hunk[]): string {
  let out = '';
  const line = (side: Lines, i: number, mark: string) =>
    `${mark} ${side.lines[i]}\n${i === side.lines.length - 1 && !side.finalNewline ? NO_NEWLINE : ''}`;
  for (const h of hunks) {
    if (h.aLen === 0) out += `${h.a}a${range(h.b, h.bLen)}\n`;
    else if (h.bLen === 0) out += `${range(h.a, h.aLen)}d${h.b}\n`;
    else out += `${range(h.a, h.aLen)}c${range(h.b, h.bLen)}\n`;
    for (let i = 0; i < h.aLen; i++) out += line(A, h.a + i, '<');
    if (h.aLen > 0 && h.bLen > 0) out += '---\n';
    for (let i = 0; i < h.bLen; i++) out += line(B, h.b + i, '>');
  }
  return out;
}

function unifiedDiff(A: Lines, B: Lines, hunks: Hunk[], context: number): string {
  let out = '';
  // Group hunks whose context overlaps.
  const groups: Hunk[][] = [];
  for (const h of hunks) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && h.a - (prev.a + prev.aLen) <= 2 * context) g.push(h);
    else groups.push([h]);
  }
  const ln = (side: Lines, i: number, mark: string) =>
    `${mark}${side.lines[i]}\n${i === side.lines.length - 1 && !side.finalNewline ? NO_NEWLINE : ''}`;
  for (const g of groups) {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const aStart = Math.max(0, first.a - context);
    const bStart = Math.max(0, first.b - context);
    const aEnd = Math.min(A.lines.length, last.a + last.aLen + context);
    const bEnd = Math.min(B.lines.length, last.b + last.bLen + context);
    const r = (start: number, len: number) =>
      len === 1 ? `${start + 1}` : `${len === 0 ? start : start + 1},${len}`;
    out += `@@ -${r(aStart, aEnd - aStart)} +${r(bStart, bEnd - bStart)} @@\n`;
    let ai = aStart;
    for (const h of g) {
      for (; ai < h.a; ai++) out += ln(A, ai, ' ');
      for (let i = 0; i < h.aLen; i++) out += ln(A, h.a + i, '-');
      for (let i = 0; i < h.bLen; i++) out += ln(B, h.b + i, '+');
      ai = h.a + h.aLen;
    }
    for (; ai < aEnd; ai++) out += ln(A, ai, ' ');
  }
  return out;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000000 +0000`;
}

export async function diff(ctx: CommandContext): Promise<number> {
  return withUsage(
    ctx,
    async () => {
      const o = parseOptions(ctx.argv.slice(1), {
        short: 'uqrNiwbBsatcy',
        shortArg: 'UC',
        long: {
          unified: { name: 'U', arg: 'optional' },
          brief: { name: 'q' },
          recursive: { name: 'r' },
          'new-file': { name: 'N' },
          'ignore-case': { name: 'i' },
          'ignore-all-space': { name: 'w' },
          'ignore-space-change': { name: 'b' },
          'ignore-blank-lines': { name: 'B' },
          'report-identical-files': { name: 's' },
          text: { name: 'a' },
          color: { name: 'color', arg: 'optional' },
          label: { name: 'label', arg: true },
          'strip-trailing-cr': { name: 'strip-cr' },
        },
      });
      const f = o.flags;
      if (o.operands.length !== 2) {
        await complain(
          ctx,
          o.operands.length < 2
            ? `missing operand after '${o.operands[0] ?? 'diff'}'`
            : `extra operand '${o.operands[2]}'`,
        );
        await ctx.stderr.write("diff: Try 'diff --help' for more information.\n");
        return 2;
      }
      const unified = f.has('u') || f.has('U');
      const uArg = f.get('U');
      const context = typeof uArg === 'string' ? Number(uArg) : 3;
      const labels = o.list.filter((x) => x.name === 'label').map((x) => String(x.value));
      const key = (s: string) => {
        let k = s;
        if (f.has('strip-cr')) k = k.replace(/\r$/, '');
        if (f.has('i')) k = k.toLowerCase();
        if (f.has('w')) k = k.replace(/\s+/g, '');
        else if (f.has('b')) k = k.replace(/\s+/g, ' ').replace(/ $/, '');
        return k;
      };
      let status: number;
      let out = '';

      const read = async (name: string): Promise<{ text: string; mtime: number } | null> => {
        if (name === '-') return { text: decode(await readAll(ctx.stdin)), mtime: Date.now() };
        const path = resolvePath(ctx.cwd, name);
        const st = ctx.fs.statSync(path);
        const src = fileSource(ctx.fs, path);
        const text = decode(await readAll(src));
        src.close();
        return { text, mtime: st.mtimeMs };
      };

      const compareFiles = async (
        an: string,
        bn: string,
        ad: { text: string; mtime: number } | null,
        bd: { text: string; mtime: number } | null,
      ): Promise<number> => {
        const A = splitLines(ad?.text ?? '');
        const B = splitLines(bd?.text ?? '');
        if ((ad?.text ?? '') === (bd?.text ?? '') && ad !== null && bd !== null) {
          if (f.has('s')) out += `Files ${an} and ${bn} are identical\n`;
          return 0;
        }
        const ka = A.lines.map(key);
        const kb = B.lines.map(key);
        // A missing final newline makes the last line differ.
        if (!A.finalNewline && ka.length > 0) ka[ka.length - 1] += '\u0000nonl';
        if (!B.finalNewline && kb.length > 0) kb[kb.length - 1] += '\u0000nonl';
        let hunks = hunksFrom(lcsPairs(ka, kb), ka.length, kb.length);
        if (f.has('B')) {
          hunks = hunks.filter((h) => {
            const changed = [
              ...A.lines.slice(h.a, h.a + h.aLen),
              ...B.lines.slice(h.b, h.b + h.bLen),
            ];
            return changed.some((l) => l.trim() !== '');
          });
        }
        if (hunks.length === 0) {
          if (f.has('s')) out += `Files ${an} and ${bn} are identical\n`;
          return 0;
        }
        if (f.has('q')) {
          out += `Files ${an} and ${bn} differ\n`;
          return 1;
        }
        if (unified) {
          const la = labels[0] ?? `${an}\t${stamp(ad?.mtime ?? 0)}`;
          const lb = labels[1] ?? `${bn}\t${stamp(bd?.mtime ?? 0)}`;
          out += `--- ${la}\n+++ ${lb}\n`;
          out += unifiedDiff(A, B, hunks, context);
        } else out += normalDiff(A, B, hunks);
        return 1;
      };

      const statOf = (name: string) => {
        try {
          return ctx.fs.statSync(resolvePath(ctx.cwd, name));
        } catch {
          return null;
        }
      };

      const compare = async (an: string, bn: string, top: boolean): Promise<number> => {
        const sa = an === '-' ? null : statOf(an);
        const sb = bn === '-' ? null : statOf(bn);
        if (an !== '-' && !sa && !(f.has('N') && !top)) {
          await complain(ctx, `${an}: No such file or directory`);
          return 2;
        }
        if (bn !== '-' && !sb && !(f.has('N') && !top)) {
          await complain(ctx, `${bn}: No such file or directory`);
          return 2;
        }
        const aDir = sa?.isDirectory() ?? false;
        const bDir = sb?.isDirectory() ?? false;
        if (aDir && bDir) {
          if (!f.has('r') && !top) {
            out += `Common subdirectories: ${an} and ${bn}\n`;
            return 0;
          }
          const na = new Set(ctx.fs.readdirSync(resolvePath(ctx.cwd, an)) as string[]);
          const nb = new Set(ctx.fs.readdirSync(resolvePath(ctx.cwd, bn)) as string[]);
          let s = 0;
          for (const n of [...new Set([...na, ...nb])].sort()) {
            const ca = `${an.replace(/\/+$/, '')}/${n}`;
            const cb = `${bn.replace(/\/+$/, '')}/${n}`;
            if (!na.has(n) && !f.has('N')) {
              out += `Only in ${bn.replace(/\/+$/, '')}: ${n}\n`;
              s = Math.max(s, 1);
              continue;
            }
            if (!nb.has(n) && !f.has('N')) {
              out += `Only in ${an.replace(/\/+$/, '')}: ${n}\n`;
              s = Math.max(s, 1);
              continue;
            }
            const sub = statOf(na.has(n) ? ca : cb);
            if (sub?.isDirectory() && !f.has('r')) {
              out += `Common subdirectories: ${ca} and ${cb}\n`;
              continue;
            }
            if (unified || !f.has('q')) {
              if (sub && !sub.isDirectory()) {
                const ad = na.has(n) ? await read(ca) : null;
                const bd = nb.has(n) ? await read(cb) : null;
                if ((ad?.text ?? null) !== (bd?.text ?? null))
                  out +=
                    `diff ${ctx.argv.slice(1, -2).join(' ')}${ctx.argv.length > 3 ? ' ' : ''}${ca} ${cb}\n`.replace(
                      'diff  ',
                      'diff ',
                    );
                s = Math.max(s, await compareFiles(ca, cb, ad, bd));
                continue;
              }
            }
            s = Math.max(s, await compare(ca, cb, false));
          }
          return s;
        }
        if (aDir || bDir) {
          if (top) {
            // diff dir file -> compare dir/basename(file) with file.
            const file = aDir ? bn : an;
            const dir = aDir ? an : bn;
            const inner = `${dir.replace(/\/+$/, '')}/${file.split('/').pop()}`;
            return aDir ? compare(inner, bn, true) : compare(an, inner, true);
          }
          out += `File ${aDir ? an : bn} is a directory while file ${aDir ? bn : an} is a regular file\n`;
          return 1;
        }
        return compareFiles(
          an,
          bn,
          sa || an === '-' ? await read(an) : null,
          sb || bn === '-' ? await read(bn) : null,
        );
      };

      try {
        status = await compare(o.operands[0]!, o.operands[1]!, true);
      } catch (err) {
        await ctx.stdout.write(out);
        await complain(ctx, strerror(err));
        return 2;
      }
      await ctx.stdout.write(out);
      return status;
    },
    2,
  );
}

/** The `@@` hunks of a unified diff between two texts (no file headers); '' when equal. */
export function unifiedHunks(oldText: string, newText: string, context = 3): string {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const hunks = hunksFrom(lcsPairs(A.lines, B.lines), A.lines.length, B.lines.length);
  return hunks.length === 0 ? '' : unifiedDiff(A, B, hunks, context);
}
