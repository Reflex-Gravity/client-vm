// SPDX-License-Identifier: Apache-2.0
// `find` (GNU findutils subset) and `xargs`.

import type { ShellFs } from '../types.ts';
import { decode, readAll } from '../io.ts';
import { matchPattern } from '../pattern.ts';
import type { CommandContext } from '../types.ts';
import { posixToJs } from './regex.ts';
import { complain, quoteName, resolvePath, strerror } from './util.ts';

type Stats = ReturnType<ShellFs['statSync']>;

interface Entry {
  /** Path as printed (starting point + relative part). */
  path: string;
  abs: string;
  name: string;
  depth: number;
  st: Stats;
  start: string;
}

type Expr =
  | { k: 'and' | 'or' | 'comma'; a: Expr; b: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'test'; fn: (e: Entry) => boolean }
  | { k: 'action'; fn: (e: Entry) => Promise<boolean> | boolean };

class FindError extends Error {}

function sizeTest(spec: string): (st: Stats) => boolean {
  const m = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(spec);
  if (!m) throw new FindError(`invalid argument ${quoteName(spec)} to -size`);
  const unit = { '': 512, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 }[m[3]!]!;
  const n = Number(m[2]);
  return (st) => {
    const units = Math.ceil(st.size / unit);
    if (m[1] === '+') return units > n;
    if (m[1] === '-') return units < n;
    return units === n;
  };
}

function numTest(spec: string, what: string): (v: number) => boolean {
  const m = /^([+-]?)(\d+)$/.exec(spec);
  if (!m) throw new FindError(`invalid argument ${quoteName(spec)} to ${what}`);
  const n = Number(m[2]);
  return (v) => (m[1] === '+' ? v > n : m[1] === '-' ? v < n : v === n);
}

export async function find(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let follow = false;
  while (args[0] === '-H' || args[0] === '-L' || args[0] === '-P') {
    follow = args.shift() === '-L';
  }
  const starts: string[] = [];
  while (
    args.length > 0 &&
    !(args[0]!.startsWith('-') && args[0]!.length > 1) &&
    args[0] !== '(' &&
    args[0] !== '!'
  ) {
    starts.push(args.shift()!);
  }
  if (starts.length === 0) starts.push('.');

  let maxDepth = Infinity;
  let minDepth = 0;
  let depthFirst = false;
  let hasAction = false;
  let pruned = false;
  let quit = false;
  let status = 0;
  const batches: { argv: string[]; files: string[] }[] = [];
  const out: string[] = [];
  const flush = async () => {
    if (out.length > 0) await ctx.stdout.write(out.splice(0).join(''));
  };

  let pos = 0;
  const peek = () => args[pos];
  // The predicate has been consumed; its argument is at `pos` (callers advance past it).
  const need = (opt: string) => {
    const v = args[pos];
    if (v === undefined) throw new FindError(`missing argument to \`${opt}'`);
    return v;
  };

  const primary = (): Expr => {
    const t = args[pos];
    if (t === undefined) throw new FindError('expected an expression');
    if (t === '(') {
      pos++;
      const e = parseOr();
      if (args[pos] !== ')')
        throw new FindError(
          "invalid expression; I was expecting to find a ')' somewhere but did not see one.",
        );
      pos++;
      return e;
    }
    if (t === '!' || t === '-not') {
      pos++;
      return { k: 'not', e: primary() };
    }
    pos++;
    switch (t) {
      case '-name':
      case '-iname': {
        const p = need(t);
        pos++;
        return { k: 'test', fn: (e) => matchPattern(p, e.name, t === '-iname') };
      }
      case '-path':
      case '-wholename':
      case '-ipath': {
        const p = need(t);
        pos++;
        return { k: 'test', fn: (e) => matchPattern(p, e.path, t === '-ipath') };
      }
      case '-regex':
      case '-iregex': {
        const p = need(t);
        pos++;
        const re = new RegExp(`^(?:${posixToJs(p, false)})$`, t === '-iregex' ? 'i' : '');
        return { k: 'test', fn: (e) => re.test(e.path) };
      }
      case '-type': {
        const types = need(t).split(',');
        pos++;
        return {
          k: 'test',
          fn: (e) =>
            types.some((ty) =>
              ty === 'f'
                ? e.st.isFile()
                : ty === 'd'
                  ? e.st.isDirectory()
                  : ty === 'l'
                    ? e.st.isSymbolicLink()
                    : false,
            ),
        };
      }
      case '-size': {
        const test = sizeTest(need(t));
        pos++;
        return { k: 'test', fn: (e) => test(e.st) };
      }
      case '-empty':
        return {
          k: 'test',
          fn: (e) =>
            e.st.isDirectory()
              ? (ctx.fs.readdirSync(e.abs) as string[]).length === 0
              : e.st.isFile() && e.st.size === 0,
        };
      case '-mtime':
      case '-mmin':
      case '-atime':
      case '-amin':
      case '-ctime':
      case '-cmin': {
        const test = numTest(need(t), t);
        pos++;
        const unit = t.endsWith('min') ? 60_000 : 86_400_000;
        const field = t[1] === 'm' ? 'mtimeMs' : t[1] === 'a' ? 'atimeMs' : 'ctimeMs';
        const now = Date.now();
        return { k: 'test', fn: (e) => test(Math.floor((now - e.st[field]) / unit)) };
      }
      case '-newer': {
        const ref = need(t);
        pos++;
        let refTime: number;
        try {
          refTime = ctx.fs.statSync(resolvePath(ctx.cwd, ref)).mtimeMs;
        } catch (err) {
          throw new FindError(`${quoteName(ref)}: ${strerror(err)}`);
        }
        return { k: 'test', fn: (e) => e.st.mtimeMs > refTime };
      }
      case '-perm': {
        const spec = need(t);
        pos++;
        const mode = parseInt(spec.replace(/^[-/]/, ''), 8);
        if (Number.isNaN(mode)) throw new FindError(`invalid mode ${quoteName(spec)}`);
        return {
          k: 'test',
          fn: (e) => {
            const m = e.st.mode & 0o7777;
            if (spec.startsWith('-')) return (m & mode) === mode;
            if (spec.startsWith('/')) return mode === 0 || (m & mode) !== 0;
            return m === mode;
          },
        };
      }
      case '-executable':
        return { k: 'test', fn: (e) => (e.st.mode & 0o111) !== 0 };
      case '-readable':
        return { k: 'test', fn: (e) => (e.st.mode & 0o444) !== 0 };
      case '-writable':
        return { k: 'test', fn: (e) => (e.st.mode & 0o222) !== 0 };
      case '-links': {
        const test = numTest(need(t), t);
        pos++;
        return { k: 'test', fn: (e) => test(e.st.nlink) };
      }
      case '-user':
      case '-group':
        need(t);
        pos++;
        return { k: 'test', fn: () => true };
      case '-true':
        return { k: 'test', fn: () => true };
      case '-false':
        return { k: 'test', fn: () => false };
      case '-maxdepth':
        maxDepth = Number(need(t));
        pos++;
        return { k: 'test', fn: () => true };
      case '-mindepth':
        minDepth = Number(need(t));
        pos++;
        return { k: 'test', fn: () => true };
      case '-depth':
      case '-d':
        depthFirst = true;
        return { k: 'test', fn: () => true };
      case '-xdev':
      case '-mount':
      case '-noleaf':
      case '-ignore_readdir_race':
        return { k: 'test', fn: () => true };
      case '-follow':
        follow = true;
        return { k: 'test', fn: () => true };
      case '-prune':
        return {
          k: 'action',
          fn: () => {
            pruned = true;
            return true;
          },
        };
      case '-print':
        hasAction = true;
        return { k: 'action', fn: (e) => (out.push(`${e.path}\n`), true) };
      case '-print0':
        hasAction = true;
        return { k: 'action', fn: (e) => (out.push(`${e.path}\0`), true) };
      case '-printf': {
        hasAction = true;
        const fmt = need(t);
        pos++;
        return { k: 'action', fn: (e) => (out.push(printfEntry(fmt, e)), true) };
      }
      case '-ls':
        hasAction = true;
        return { k: 'action', fn: (e) => (out.push(`${e.st.ino} ${e.path}\n`), true) };
      case '-delete':
        hasAction = true;
        depthFirst = true;
        return {
          k: 'action',
          fn: async (e) => {
            try {
              if (e.st.isDirectory()) ctx.fs.rmdirSync(e.abs);
              else ctx.fs.unlinkSync(e.abs);
              return true;
            } catch (err) {
              await flush();
              await complain(ctx, `cannot delete ${quoteName(e.path)}: ${strerror(err)}`);
              status = 1;
              return false;
            }
          },
        };
      case '-quit':
        return {
          k: 'action',
          fn: () => {
            quit = true;
            return true;
          },
        };
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir': {
        hasAction = true;
        const cmd: string[] = [];
        while (
          pos < args.length &&
          args[pos] !== ';' &&
          !(args[pos] === '+' && args[pos - 1] === '{}')
        )
          cmd.push(args[pos++]!);
        const term = args[pos];
        if (term === undefined) throw new FindError(`missing argument to \`${t}'`);
        pos++;
        if (cmd.length === 0) throw new FindError(`missing argument to \`${t}'`);
        const dirMode = t.endsWith('dir');
        if (term === '+') {
          const batch = { argv: cmd.slice(0, -1), files: [] as string[] };
          batches.push(batch);
          return {
            k: 'action',
            fn: (e) => (batch.files.push(dirMode ? `./${e.name}` : e.path), true),
          };
        }
        return {
          k: 'action',
          fn: async (e) => {
            await flush();
            const p = dirMode ? `./${e.name}` : e.path;
            const argv = cmd.map((a) => a.replaceAll('{}', p));
            const cwd = dirMode ? resolvePath(e.abs, '..') : ctx.cwd;
            const code = await ctx.exec(argv, { cwd });
            return code === 0;
          },
        };
      }
      default:
        if (t.startsWith('-')) throw new FindError(`unknown predicate \`${t}'`);
        throw new FindError(`paths must precede expression: \`${t}'`);
    }
  };
  const parseAnd = (): Expr => {
    let a = primary();
    for (;;) {
      const t = peek();
      if (t === undefined || t === ')' || t === '-o' || t === '-or' || t === ',') return a;
      if (t === '-a' || t === '-and') pos++;
      a = { k: 'and', a, b: primary() };
    }
  };
  const parseOr = (): Expr => {
    let a = parseAnd();
    for (;;) {
      const t = peek();
      if (t === '-o' || t === '-or') {
        pos++;
        a = { k: 'or', a, b: parseAnd() };
      } else if (t === ',') {
        pos++;
        a = { k: 'comma', a, b: parseAnd() };
      } else return a;
    }
  };

  let expr: Expr | null = null;
  try {
    if (args.length > 0) {
      expr = parseOr();
      if (pos < args.length) throw new FindError(`unexpected extra predicate '${args[pos]}'`);
    }
  } catch (err) {
    if (err instanceof FindError || err instanceof SyntaxError) {
      await complain(ctx, err.message);
      return 1;
    }
    throw err;
  }
  const printDefault = !hasAction;

  const evaluate = async (e: Expr, entry: Entry): Promise<boolean> => {
    switch (e.k) {
      case 'and':
        return (await evaluate(e.a, entry)) && evaluate(e.b, entry);
      case 'or':
        return (await evaluate(e.a, entry)) || evaluate(e.b, entry);
      case 'comma':
        await evaluate(e.a, entry);
        return evaluate(e.b, entry);
      case 'not':
        return !(await evaluate(e.e, entry));
      case 'test':
        return e.fn(entry);
      case 'action':
        return e.fn(entry);
    }
  };

  const visit = async (entry: Entry): Promise<void> => {
    if (quit) return;
    const process = async () => {
      if (entry.depth < minDepth) return;
      const ok = expr ? await evaluate(expr, entry) : true;
      if (ok && printDefault) out.push(`${entry.path}\n`);
      if (out.length > 512) await flush();
    };
    pruned = false;
    if (!depthFirst) await process();
    const descend = entry.st.isDirectory() && !pruned && entry.depth < maxDepth;
    if (descend) {
      let names: string[];
      try {
        names = (ctx.fs.readdirSync(entry.abs) as string[]).sort();
      } catch (err) {
        await flush();
        await complain(ctx, `${quoteName(entry.path)}: ${strerror(err)}`);
        status = 1;
        names = [];
      }
      for (const n of names) {
        if (quit) break;
        const abs = entry.abs === '/' ? `/${n}` : `${entry.abs}/${n}`;
        let st: Stats;
        try {
          st = follow ? ctx.fs.statSync(abs) : ctx.fs.lstatSync(abs);
        } catch {
          try {
            st = ctx.fs.lstatSync(abs);
          } catch {
            continue;
          }
        }
        const path = entry.path.endsWith('/') ? `${entry.path}${n}` : `${entry.path}/${n}`;
        await visit({ path, abs, name: n, depth: entry.depth + 1, st, start: entry.start });
      }
    }
    if (depthFirst) await process();
  };

  for (const start of starts) {
    if (quit) break;
    const abs = resolvePath(ctx.cwd, start);
    let st: Stats;
    try {
      st = follow ? ctx.fs.statSync(abs) : ctx.fs.lstatSync(abs);
      if (st.isSymbolicLink() && start.endsWith('/')) st = ctx.fs.statSync(abs);
    } catch (err) {
      await flush();
      await complain(ctx, `${quoteName(start)}: ${strerror(err)}`);
      status = 1;
      continue;
    }
    const name = start === '/' ? '/' : (start.replace(/\/+$/, '').split('/').pop() ?? start);
    await visit({ path: start, abs, name, depth: 0, st, start });
  }
  await flush();
  for (const b of batches) {
    if (b.files.length === 0) continue;
    for (let i = 0; i < b.files.length; i += 1000) {
      const code = await ctx.exec([...b.argv, ...b.files.slice(i, i + 1000)]);
      if (code !== 0) status = 1;
    }
  }
  return status;
}

function printfEntry(fmt: string, e: Entry): string {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c === '\\') {
      const n = fmt[++i];
      out +=
        n === 'n' ? '\n' : n === 't' ? '\t' : n === '0' ? '\0' : n === '\\' ? '\\' : `\\${n ?? ''}`;
      continue;
    }
    if (c !== '%') {
      out += c;
      continue;
    }
    const m = /^(-?\d*)([pfhsdPmyTt%])/.exec(fmt.slice(i + 1));
    if (!m) {
      out += '%';
      continue;
    }
    i += m[0].length;
    let v: string;
    switch (m[2]) {
      case 'p':
        v = e.path;
        break;
      case 'f':
        v = e.name;
        break;
      case 'h': {
        const k = e.path.lastIndexOf('/');
        v = k < 0 ? '.' : k === 0 ? '/' : e.path.slice(0, k);
        break;
      }
      case 's':
        v = String(e.st.size);
        break;
      case 'd':
        v = String(e.depth);
        break;
      case 'P':
        v = e.path === e.start ? '' : e.path.slice(e.start.replace(/\/+$/, '').length + 1);
        break;
      case 'm':
        v = (e.st.mode & 0o7777).toString(8);
        break;
      case 'y':
        v = e.st.isDirectory() ? 'd' : e.st.isSymbolicLink() ? 'l' : 'f';
        break;
      case 'T':
      case 't':
        v = new Date(e.st.mtimeMs).toISOString();
        break;
      default:
        v = '%';
    }
    const w = m[1]!;
    if (w) {
      const width = Math.abs(Number(w));
      v = w.startsWith('-') ? v.padEnd(width) : v.padStart(width);
    }
    out += v;
  }
  return out;
}

// --------------------------------------------------------------------- xargs

function splitXargs(text: string): string[] | string {
  const out: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close < 0)
        return `unmatched ${c === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`;
      const inner = text.slice(i + 1, close);
      if (inner.includes('\n'))
        return `unmatched ${c === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`;
      cur += inner;
      has = true;
      i = close;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export async function xargs(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let maxArgs = Infinity;
  let maxLines = 0;
  let replace: string | null = null;
  let nul = false;
  let delim: string | null = null;
  let noRunIfEmpty = false;
  let trace = false;
  let i = 0;
  const value = (a: string, short: string) => {
    if (a.length > short.length) return a.slice(short.length);
    const v = args[++i];
    if (v === undefined) throw new Error(`option requires an argument -- '${short.slice(1)}'`);
    return v;
  };
  try {
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--') {
        i++;
        break;
      }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '-0' || a === '--null') nul = true;
      else if (a === '-r' || a === '--no-run-if-empty') noRunIfEmpty = true;
      else if (a === '-t' || a === '--verbose') trace = true;
      else if (a === '-x' || a === '--exit') {
        // size limits are not enforced
      } else if (a.startsWith('-n')) maxArgs = Number(value(a, '-n'));
      else if (a.startsWith('--max-args=')) maxArgs = Number(a.slice(11));
      else if (a.startsWith('-L')) maxLines = Number(value(a, '-L'));
      else if (a.startsWith('-I')) replace = value(a, '-I');
      else if (a === '-i' || a.startsWith('--replace'))
        replace = a.includes('=') ? a.slice(a.indexOf('=') + 1) : '{}';
      else if (a.startsWith('-d')) {
        const d = value(a, '-d');
        delim = d === '\\n' ? '\n' : d === '\\t' ? '\t' : d === '\\0' ? '\0' : (d[0] ?? '\n');
      } else if (a.startsWith('-P')) value(a, '-P');
      else if (a.startsWith('-s')) value(a, '-s');
      else if (a.startsWith('-E')) value(a, '-E');
      else if (a.startsWith('-a')) value(a, '-a');
      else {
        await complain(ctx, `invalid option -- '${a.slice(1)}'`);
        return 1;
      }
    }
  } catch (err) {
    await complain(ctx, (err as Error).message);
    return 1;
  }
  const cmd = args.slice(i);
  if (cmd.length === 0) cmd.push('echo');
  const text = decode(await readAll(ctx.stdin));

  // Split input into items (and remember line boundaries for -L / -I).
  let lines: string[][];
  if (replace !== null) {
    lines = text
      .split(nul ? '\0' : (delim ?? '\n'))
      .filter((l, idx, a) => !(idx === a.length - 1 && l === ''))
      .map((l) => [delim || nul ? l : l.replace(/^[ \t]+/, '')])
      .filter((l) => l[0] !== '' || delim !== null || nul);
  } else if (nul || delim !== null) {
    const items = text.split(nul ? '\0' : delim!);
    if (items.length > 0 && items[items.length - 1] === '') items.pop();
    lines = items.map((x) => [x]);
  } else {
    lines = [];
    for (const line of text.split('\n')) {
      const r = splitXargs(line);
      if (typeof r === 'string') {
        await complain(ctx, r);
        return 1;
      }
      if (r.length > 0) lines.push(r);
    }
  }

  const invocations: string[][] = [];
  if (replace !== null) {
    for (const [item] of lines) invocations.push(cmd.map((a) => a.replaceAll(replace!, item!)));
  } else {
    let group: string[] = [];
    let groupLines = 0;
    const push = () => {
      if (group.length > 0) invocations.push([...cmd, ...group]);
      group = [];
      groupLines = 0;
    };
    for (const items of lines) {
      for (const item of items) {
        group.push(item);
        if (group.length >= maxArgs) push();
      }
      if (maxLines > 0 && ++groupLines >= maxLines) push();
    }
    push();
    if (invocations.length === 0 && !noRunIfEmpty) invocations.push([...cmd]);
  }

  let status = 0;
  for (const argv of invocations) {
    if (trace) await ctx.stderr.write(`${argv.join(' ')}\n`);
    const code = await ctx.exec(argv);
    if (code === 255) {
      await complain(ctx, `${argv[0]}: exited with status 255; aborting`);
      return 124;
    }
    if (code === 127 || code === 126) return code;
    if (code > 128) return 125;
    if (code !== 0) status = 123;
  }
  return status;
}
