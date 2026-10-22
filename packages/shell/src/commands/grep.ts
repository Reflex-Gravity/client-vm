// SPDX-License-Identifier: Apache-2.0
// `grep` (GNU options: -EFGP -ivwxclLnhHoqsr -e -f -A -B -C -m --include ...).

import { decode, readAll } from '../io.ts';
import { matchPattern } from '../pattern.ts';
import type { CommandContext } from '../types.ts';
import { RegexSyntaxError, escapeRegex, posixToJs } from './regex.ts';
import {
  complain,
  fileSource,
  parseOptions,
  resolvePath,
  strerror,
  UsageError,
  withUsage,
} from './util.ts';

export async function grep(ctx: CommandContext): Promise<number> {
  const name = ctx.argv[0] ?? 'grep';
  const implied = name === 'egrep' ? ['-E'] : name === 'fgrep' ? ['-F'] : [];
  return withUsage(
    ctx,
    async () => {
      const o = parseOptions([...implied, ...ctx.argv.slice(1)], {
        short: 'EFGPivwxclLnhHoqsrRyabIzZU',
        shortArg: 'efABCm',
        numeric: 'C',
        long: {
          'extended-regexp': { name: 'E' },
          'fixed-strings': { name: 'F' },
          'basic-regexp': { name: 'G' },
          'perl-regexp': { name: 'P' },
          'ignore-case': { name: 'i' },
          'no-ignore-case': { name: 'noi' },
          'invert-match': { name: 'v' },
          'word-regexp': { name: 'w' },
          'line-regexp': { name: 'x' },
          count: { name: 'c' },
          'files-with-matches': { name: 'l' },
          'files-without-match': { name: 'L' },
          'line-number': { name: 'n' },
          'no-filename': { name: 'h' },
          'with-filename': { name: 'H' },
          'only-matching': { name: 'o' },
          quiet: { name: 'q' },
          silent: { name: 'q' },
          'no-messages': { name: 's' },
          recursive: { name: 'r' },
          'dereference-recursive': { name: 'R' },
          regexp: { name: 'e', arg: true },
          file: { name: 'f', arg: true },
          'after-context': { name: 'A', arg: true },
          'before-context': { name: 'B', arg: true },
          context: { name: 'C', arg: true },
          'max-count': { name: 'm', arg: true },
          include: { name: 'include', arg: true },
          exclude: { name: 'exclude', arg: true },
          'exclude-dir': { name: 'exclude-dir', arg: true },
          color: { name: 'color', arg: 'optional' },
          colour: { name: 'color', arg: 'optional' },
          'line-buffered': { name: 'lb' },
          text: { name: 'a' },
          'byte-offset': { name: 'b' },
          'null-data': { name: 'z' },
          null: { name: 'Z' },
          label: { name: 'label', arg: true },
        },
      });
      const f = o.flags;
      const operands = [...o.operands];
      const patterns: string[] = [];
      for (const item of o.list) {
        if (item.name === 'e') patterns.push(...String(item.value).split('\n'));
        if (item.name === 'f') {
          const file = String(item.value);
          try {
            const text = decode(ctx.fs.readFileSync(resolvePath(ctx.cwd, file)));
            patterns.push(
              ...text
                .replace(/\n$/, '')
                .split('\n')
                .filter((_, i, a) => !(a.length === 1 && a[0] === '')),
            );
          } catch (err) {
            await complain(ctx, `${file}: ${strerror(err)}`);
            return 2;
          }
        }
      }
      if (!o.list.some((x) => x.name === 'e' || x.name === 'f')) {
        const p = operands.shift();
        if (p === undefined) {
          await ctx.stderr.write(
            `Usage: ${name} [OPTION]... PATTERNS [FILE]...\nTry '${name} --help' for more information.\n`,
          );
          return 2;
        }
        patterns.push(...p.split('\n'));
      }
      const mode = lastMode(o.list);
      const ignoreCase = (f.has('i') || f.has('y')) && !lastIs(o.list, 'noi', ['i', 'y']);
      let re: RegExp;
      try {
        re = buildRegex(patterns, mode, ignoreCase, f.has('w'), f.has('x'));
      } catch (err) {
        if (err instanceof RegexSyntaxError) {
          await complain(ctx, err.message);
          return 2;
        }
        throw err;
      }
      const recursive = f.has('r') || f.has('R');
      // `grep -r pat` searches `.` but names files without a `./` prefix.
      const implicitRoot = recursive && operands.length === 0;
      if (implicitRoot) operands.push('.');
      const showNames = !f.has('h') && (f.has('H') || operands.length > 1 || recursive);
      const after = Number(f.get('A') ?? f.get('C') ?? 0);
      const before = Number(f.get('B') ?? f.get('C') ?? 0);
      if (!Number.isInteger(after) || !Number.isInteger(before) || after < 0 || before < 0) {
        throw new UsageError(
          `${f.get('A') ?? f.get('B') ?? f.get('C')}: invalid context length argument`,
        );
      }
      const maxCount = f.has('m') ? Number(f.get('m')) : Infinity;
      const includes = o.list.filter((x) => x.name === 'include').map((x) => String(x.value));
      const excludes = o.list.filter((x) => x.name === 'exclude').map((x) => String(x.value));
      const excludeDirs = o.list
        .filter((x) => x.name === 'exclude-dir')
        .map((x) => String(x.value));
      const quiet = f.has('q');
      const term = f.has('z') ? '\0' : '\n';

      let matchedAny = false;
      let error = false;
      let out = '';
      const flush = async () => {
        if (out) await ctx.stdout.write(out);
        out = '';
      };
      let lastPrintedGroup = false;

      const searchText = async (data: Uint8Array, display: string): Promise<boolean> => {
        const binary = !f.has('a') && data.includes(0) && !f.has('z');
        const text = decode(data);
        const lines = text.split(term);
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const prefix = (n: number, sep: string) =>
          `${showNames ? `${display}${sep}` : ''}${f.has('n') ? `${n}${sep}` : ''}`;
        let count = 0;
        let lastShown = -1;
        let afterLeft = 0;
        for (let i = 0; i < lines.length; i++) {
          if (count >= maxCount) {
            break;
          }
          const line = lines[i]!;
          re.lastIndex = 0;
          const isMatch = re.test(line) !== f.has('v');
          if (!isMatch) {
            if (afterLeft > 0 && !quiet && !f.has('c') && !f.has('l') && !f.has('L') && !binary) {
              out += `${prefix(i + 1, '-')}${line}${term}`;
              lastShown = i;
              afterLeft--;
            }
            continue;
          }
          count++;
          matchedAny = true;
          if (quiet) return true;
          if (f.has('l') || f.has('L')) break;
          if (f.has('c') || binary) continue;
          if (
            (before > 0 || after > 0) &&
            lastPrintedGroup &&
            lastShown >= 0 &&
            i - before > lastShown + 1
          )
            out += `--${term}`;
          if ((before > 0 || after > 0) && lastPrintedGroup && lastShown < 0) out += `--${term}`;
          for (let j = Math.max(lastShown + 1, i - before); j < i; j++)
            out += `${prefix(j + 1, '-')}${lines[j]}${term}`;
          if (f.has('o') && !f.has('v')) {
            const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
            for (let m = g.exec(line); m !== null; m = g.exec(line)) {
              if (m[0] === '') {
                g.lastIndex++;
                continue;
              }
              out += `${prefix(i + 1, ':')}${m[0]}${term}`;
            }
          } else if (!f.has('o')) {
            out += `${prefix(i + 1, ':')}${line}${term}`;
          }
          lastShown = i;
          lastPrintedGroup = true;
          afterLeft = after;
          if (out.length > 65536) await flush();
        }
        if (f.has('c')) out += `${showNames ? `${display}:` : ''}${count}\n`;
        if (f.has('l') && count > 0) out += `${display}${f.has('Z') ? '\0' : '\n'}`;
        if (f.has('L') && count === 0) out += `${display}${f.has('Z') ? '\0' : '\n'}`;
        if (binary && count > 0 && !f.has('c') && !f.has('l') && !f.has('L')) {
          await flush();
          out += `${name}: ${display}: binary file matches\n`;
        }
        return count > 0;
      };

      const included = (file: string) => {
        const base = file.slice(file.lastIndexOf('/') + 1);
        if (includes.length > 0 && !includes.some((g) => matchPattern(g, base))) return false;
        if (excludes.some((g) => matchPattern(g, base))) return false;
        return true;
      };

      const searchPath = async (display: string, top: boolean): Promise<boolean> => {
        const path = resolvePath(ctx.cwd, display);
        let st;
        try {
          st = top || f.has('R') ? ctx.fs.statSync(path) : ctx.fs.lstatSync(path);
        } catch (err) {
          if (!f.has('s')) {
            await flush();
            await complain(ctx, `${display}: ${strerror(err)}`);
          }
          error = true;
          return false;
        }
        if (st.isSymbolicLink()) return false;
        if (st.isDirectory()) {
          if (!recursive) {
            if (!f.has('s')) {
              await flush();
              await complain(ctx, `${display}: Is a directory`);
            }
            return false;
          }
          const base = display.replace(/\/+$/, '').split('/').pop() ?? '';
          if (!top && excludeDirs.some((g) => matchPattern(g, base))) return false;
          let any = false;
          const names = ctx.fs.readdirSync(path).sort();
          for (const n of names) {
            const child = top && implicitRoot ? n : `${display.replace(/\/+$/, '')}/${n}`;
            if (await searchPath(child, false)) {
              any = true;
              if (quiet) return true;
            }
          }
          return any;
        }
        if (!top && !included(display)) return false;
        if (top && (includes.length > 0 || excludes.length > 0) && !included(display)) return false;
        let data: Uint8Array;
        try {
          const src = fileSource(ctx.fs, path);
          data = await readAll(src);
          src.close();
        } catch (err) {
          if (!f.has('s')) {
            await flush();
            await complain(ctx, `${display}: ${strerror(err)}`);
          }
          error = true;
          return false;
        }
        return searchText(data, display);
      };

      if (operands.length === 0) {
        const data = await readAll(ctx.stdin);
        await searchText(
          data,
          typeof f.get('label') === 'string' ? String(f.get('label')) : '(standard input)',
        );
      } else {
        for (const p of operands) {
          if (p === '-') {
            await searchText(await readAll(ctx.stdin), '(standard input)');
          } else if (await searchPath(p, true)) {
            if (quiet) break;
          }
        }
      }
      await flush();
      if (quiet && matchedAny) return 0;
      if (error) return 2;
      return matchedAny ? 0 : 1;
    },
    2,
  );
}

function lastMode(list: { name: string }[]): 'E' | 'F' | 'G' | 'P' {
  let mode: 'E' | 'F' | 'G' | 'P' = 'G';
  for (const x of list)
    if (x.name === 'E' || x.name === 'F' || x.name === 'G' || x.name === 'P') mode = x.name;
  return mode;
}

function lastIs(list: { name: string }[], name: string, others: string[]): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.name === name) return true;
    if (others.includes(list[i]!.name)) return false;
  }
  return false;
}

function buildRegex(
  patterns: string[],
  mode: 'E' | 'F' | 'G' | 'P',
  ignoreCase: boolean,
  word: boolean,
  line: boolean,
): RegExp {
  const sources = patterns.map((p) => {
    if (mode === 'F') return escapeRegex(p);
    if (mode === 'P') return p;
    return posixToJs(p, mode === 'E');
  });
  let src = sources.length === 1 ? sources[0]! : sources.map((s) => `(?:${s})`).join('|');
  if (word) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
  if (line) src = `^(?:${src})$`;
  try {
    return new RegExp(src, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new RegexSyntaxError(err instanceof Error ? err.message : String(err));
  }
}
