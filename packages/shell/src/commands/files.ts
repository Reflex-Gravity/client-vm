// SPDX-License-Identifier: Apache-2.0
// File commands with GNU coreutils behavior and messages.

import type { ShellFs } from '../types.ts';
import type { CommandContext } from '../types.ts';
import {
  basename,
  complain,
  dirname,
  errorCode,
  exists,
  inputs,
  parseOptions,
  quoteName,
  resolvePath,
  strerror,
  withUsage,
} from './util.ts';

type Stats = ReturnType<ShellFs['statSync']>;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function lstatOrNull(fs: ShellFs, p: string): Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function statOrNull(fs: ShellFs, p: string): Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

const isDir = (s: Stats | null) => s !== null && (s.mode & S_IFMT) === S_IFDIR;
const isLink = (s: Stats | null) => s !== null && (s.mode & S_IFMT) === S_IFLNK;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ----------------------------------------------------------------------- cat

export async function cat(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'nbsETAvetu',
      long: {
        number: { name: 'n' },
        'number-nonblank': { name: 'b' },
        'squeeze-blank': { name: 's' },
        'show-ends': { name: 'E' },
        'show-tabs': { name: 'T' },
        'show-all': { name: 'A' },
      },
    });
    const f = o.flags;
    const showEnds = f.has('E') || f.has('A') || f.has('e');
    const showTabs = f.has('T') || f.has('A') || f.has('t');
    const nonblank = f.has('b');
    const number = f.has('n') || nonblank;
    const squeeze = f.has('s');
    const nonprinting = f.has('v') || f.has('A') || f.has('e') || f.has('t');
    const plain = !number && !squeeze && !showEnds && !showTabs && !nonprinting;
    let status = 0;
    let lineNo = 0;
    let prevBlank = false;
    let atLineStart = true;
    for await (const input of inputs(ctx, o.operands)) {
      if ('error' in input) {
        await complain(ctx, `${input.name}: ${strerror(input.error)}`);
        status = 1;
        continue;
      }
      for (
        let chunk = await input.source.read();
        chunk !== null;
        chunk = await input.source.read()
      ) {
        if (plain) {
          await ctx.stdout.write(chunk);
          continue;
        }
        // Work on bytes (as latin1 code units) so -v sees each byte.
        let out = '';
        const text = latin1(chunk);
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
          const hasNewline = i < parts.length - 1;
          let line = parts[i]!;
          if (!hasNewline && line === '') break;
          const blank = atLineStart && line === '' && hasNewline;
          if (squeeze && blank && prevBlank) continue;
          if (atLineStart) {
            prevBlank = blank;
            if (number && !(nonblank && blank)) out += `${String(++lineNo).padStart(6)}\t`;
          }
          if (showTabs) line = line.replace(/\t/g, '^I');
          if (nonprinting) line = showNonprinting(line);
          out += line;
          if (hasNewline) out += showEnds ? '$\n' : '\n';
          atLineStart = hasNewline;
        }
        await ctx.stdout.write(fromLatin1(out));
      }
    }
    return status;
  });
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** `cat -v`: ^X for control bytes, ^? for DEL, M- for bytes >= 128 (tab and newline pass). */
function showNonprinting(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    let b = line.charCodeAt(i);
    let prefix = '';
    if (b >= 128) {
      prefix = 'M-';
      b -= 128;
    }
    if (b === 9 && !prefix) out += '\t';
    else if (b < 32) out += `${prefix}^${String.fromCharCode(b + 64)}`;
    else if (b === 127) out += `${prefix}^?`;
    else out += prefix + String.fromCharCode(b);
  }
  return out;
}

// ----------------------------------------------------------------------- stat

const FILE_TYPES = (st: Stats) =>
  isDir(st)
    ? 'directory'
    : isLink(st)
      ? 'symbolic link'
      : st.size === 0
        ? 'regular empty file'
        : 'regular file';

function statTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000 +0000`;
}

function formatStat(
  fmt: string,
  name: string,
  path: string,
  st: Stats,
  ctx: CommandContext,
): string {
  return fmt.replace(
    /%([%aAbBdfFgGhinNostuUxXyYzZ])|\\([nt\\])/g,
    (_m, c: string | undefined, esc: string | undefined) => {
      if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
      switch (c) {
        case '%':
          return '%';
        case 'a':
          return (st.mode & 0o7777).toString(8);
        case 'A':
          return modeString(st.mode);
        case 'b':
          return String(Math.ceil(st.size / 512));
        case 'B':
          return '512';
        case 'd':
          return String(st.dev);
        case 'f':
          return st.mode.toString(16);
        case 'F':
          return FILE_TYPES(st);
        case 'g':
        case 'u':
          return '1000';
        case 'G':
        case 'U':
          return ctx.env['USER'] ?? 'user';
        case 'h':
          return String(st.nlink);
        case 'i':
          return String(st.ino);
        case 'n':
          return name;
        case 'N':
          if (isLink(st)) {
            try {
              return `'${name}' -> '${ctx.fs.readlinkSync(path)}'`;
            } catch {
              return `'${name}'`;
            }
          }
          return `'${name}'`;
        case 'o':
          return '4096';
        case 's':
          return String(st.size);
        case 't':
        case 'T':
          return '0';
        case 'x':
          return statTime(st.atimeMs);
        case 'X':
          return String(Math.floor(st.atimeMs / 1000));
        case 'y':
          return statTime(st.mtimeMs);
        case 'Y':
          return String(Math.floor(st.mtimeMs / 1000));
        case 'z':
          return statTime(st.ctimeMs);
        case 'Z':
          return String(Math.floor(st.ctimeMs / 1000));
      }
      return '';
    },
  );
}

export async function stat(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'Lt',
      shortArg: 'c',
      long: {
        format: { name: 'c', arg: true },
        printf: { name: 'printf', arg: true },
        dereference: { name: 'L' },
        terse: { name: 't' },
      },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      await ctx.stderr.write("Try 'stat --help' for more information.\n");
      return 1;
    }
    let status = 0;
    let out = '';
    for (const name of o.operands) {
      const path = resolvePath(ctx.cwd, name);
      let st: Stats;
      try {
        st = o.flags.has('L') ? ctx.fs.statSync(path) : ctx.fs.lstatSync(path);
      } catch (err) {
        await ctx.stdout.write(out);
        out = '';
        await complain(ctx, `cannot statx ${quoteName(name)}: ${strerror(err)}`);
        status = 1;
        continue;
      }
      if (o.flags.has('c')) out += `${formatStat(String(o.flags.get('c')), name, path, st, ctx)}\n`;
      else if (o.flags.has('printf'))
        out += formatStat(String(o.flags.get('printf')), name, path, st, ctx);
      else if (o.flags.has('t'))
        out += `${formatStat('%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o', name, path, st, ctx)}\n`;
      else {
        out += formatStat(
          '  File: %N\n  Size: %s\tBlocks: %b\tIO Block: %o\t%F\nDevice: %d\tInode: %i\tLinks: %h\nAccess: (0%a/%A)  Uid: ( %u/  %U)   Gid: ( %g/  %G)\nAccess: %x\nModify: %y\nChange: %z\n Birth: -\n',
          name,
          path,
          st,
          ctx,
        );
      }
    }
    await ctx.stdout.write(out);
    return status;
  });
}

// ------------------------------------------------------------------------ ls

interface LsOptions {
  all: boolean;
  almostAll: boolean;
  long: boolean;
  recursive: boolean;
  directory: boolean;
  classify: boolean;
  slash: boolean;
  human: boolean;
  reverse: boolean;
  sortTime: boolean;
  sortSize: boolean;
  unsorted: boolean;
  inode: boolean;
  oneLine: boolean;
  dereference: boolean;
}

function modeString(mode: number): string {
  const type = mode & S_IFMT;
  let s = type === S_IFDIR ? 'd' : type === S_IFLNK ? 'l' : '-';
  const rwx = 'rwxrwxrwx';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? rwx[i] : '-';
  return s;
}

function humanSize(n: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + units[u];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lsTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const recent = now - ms < 182 * 24 * 3600 * 1000 && ms <= now + 3600 * 1000;
  const day = String(d.getDate()).padStart(2);
  const tail = recent
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${day} ${tail}`;
}

function classifySuffix(st: Stats, o: LsOptions): string {
  if (o.classify) {
    if (isDir(st)) return '/';
    if (isLink(st)) return '@';
    if (st.mode & 0o111) return '*';
    return '';
  }
  return o.slash && isDir(st) ? '/' : '';
}

export async function ls(ctx: CommandContext): Promise<number> {
  return withUsage(
    ctx,
    async () => {
      const p = parseOptions(ctx.argv.slice(1), {
        short: 'aAlRdFphrtSUi1CxmLGgnoQNsv',
        long: {
          all: { name: 'a' },
          'almost-all': { name: 'A' },
          recursive: { name: 'R' },
          directory: { name: 'd' },
          classify: { name: 'F' },
          'human-readable': { name: 'h' },
          reverse: { name: 'r' },
          color: { name: 'color', arg: 'optional' },
          'group-directories-first': { name: 'gdf' },
          dereference: { name: 'L' },
          inode: { name: 'i' },
        },
      });
      const f = p.flags;
      const o: LsOptions = {
        all: f.has('a'),
        almostAll: f.has('A'),
        long: f.has('l') || f.has('g') || f.has('n') || f.has('o'),
        recursive: f.has('R'),
        directory: f.has('d'),
        classify: f.has('F'),
        slash: f.has('p'),
        human: f.has('h'),
        reverse: f.has('r'),
        sortTime: f.has('t'),
        sortSize: f.has('S'),
        unsorted: f.has('U'),
        inode: f.has('i'),
        oneLine: true,
        dereference: f.has('L'),
      };
      const operands = p.operands.length > 0 ? p.operands : ['.'];
      let status = 0;
      const files: { name: string; path: string; st: Stats }[] = [];
      const dirs: { name: string; path: string }[] = [];
      for (const name of operands) {
        const path = resolvePath(ctx.cwd, name);
        const lst = lstatOrNull(ctx.fs, path);
        if (!lst) {
          await complain(ctx, `cannot access ${quoteName(name)}: No such file or directory`);
          status = 2;
          continue;
        }
        const st =
          isLink(lst) && (o.dereference || !o.long || name.endsWith('/'))
            ? (statOrNull(ctx.fs, path) ?? lst)
            : lst;
        if (isDir(st) && !o.directory) dirs.push({ name, path });
        else files.push({ name, path, st });
      }
      const sorted = <T extends { name: string; st?: Stats }>(
        list: T[],
        statOf: (x: T) => Stats | null,
      ) => {
        if (o.unsorted) return list;
        const out = [...list].sort((a, b) => {
          if (o.sortTime) {
            const d = (statOf(b)?.mtimeMs ?? 0) - (statOf(a)?.mtimeMs ?? 0);
            if (d !== 0) return d;
          } else if (o.sortSize) {
            const d = (statOf(b)?.size ?? 0) - (statOf(a)?.size ?? 0);
            if (d !== 0) return d;
          }
          return compareNames(a.name, b.name);
        });
        return o.reverse ? out.reverse() : out;
      };
      let out = '';
      const sortedFiles = sorted(files, (x) => x.st);
      out += formatEntries(ctx, sortedFiles, o);
      const showHeaders = operands.length > 1 || o.recursive;
      let first = sortedFiles.length === 0;
      const visit = async (name: string, path: string) => {
        let names: string[];
        try {
          names = ctx.fs.readdirSync(path) as string[];
        } catch (err) {
          await ctx.stdout.write(out);
          out = '';
          await complain(ctx, `cannot open directory ${quoteName(name)}: ${strerror(err)}`);
          status = 2;
          return;
        }
        let entries = names
          .filter((n) => o.all || o.almostAll || !n.startsWith('.'))
          .map((n) => {
            const full = path === '/' ? `/${n}` : `${path}/${n}`;
            const lst = lstatOrNull(ctx.fs, full)!;
            const st = o.dereference && isLink(lst) ? (statOrNull(ctx.fs, full) ?? lst) : lst;
            return { name: n, path: full, st };
          })
          .filter((e) => e.st !== null);
        if (o.all) {
          entries.push({ name: '.', path, st: ctx.fs.statSync(path) });
          entries.push({ name: '..', path: dirname(path), st: ctx.fs.statSync(dirname(path)) });
        }
        entries = sorted(entries, (x) => x.st);
        if (showHeaders) {
          if (!first) out += '\n';
          out += `${name}:\n`;
        }
        first = false;
        if (o.long) {
          let blocks = 0;
          for (const e of entries) blocks += Math.ceil(e.st.size / 4096) * 4;
          out += `total ${blocks}\n`;
        }
        out += formatEntries(ctx, entries, o);
        if (out.length > 32768) {
          await ctx.stdout.write(out);
          out = '';
        }
        if (o.recursive) {
          for (const e of entries) {
            if (e.name === '.' || e.name === '..' || !isDir(e.st) || isLink(e.st)) continue;
            await visit(name.endsWith('/') ? `${name}${e.name}` : `${name}/${e.name}`, e.path);
          }
        }
      };
      for (const d of sorted(dirs, (x) => statOrNull(ctx.fs, x.path))) await visit(d.name, d.path);
      await ctx.stdout.write(out);
      return status;
    },
    2,
  );
}

function formatEntries(
  ctx: CommandContext,
  entries: { name: string; path: string; st: Stats }[],
  o: LsOptions,
): string {
  if (!o.long) {
    let out = '';
    for (const e of entries) {
      const ino = o.inode ? `${e.st.ino} ` : '';
      out += `${ino}${e.name}${classifySuffix(e.st, o)}\n`;
    }
    return out;
  }
  const rows = entries.map((e) => {
    const size = o.human ? humanSize(e.st.size) : String(e.st.size);
    let name = e.name + (isLink(e.st) ? '' : classifySuffix(e.st, o));
    if (isLink(e.st)) {
      try {
        name += ` -> ${ctx.fs.readlinkSync(e.path)}`;
      } catch {
        // dangling or unreadable
      }
    }
    return {
      ino: String(e.st.ino),
      mode: modeString(e.st.mode),
      nlink: String(e.st.nlink),
      size,
      time: lsTime(e.st.mtimeMs),
      name,
    };
  });
  const w = (k: 'nlink' | 'size' | 'ino') => Math.max(0, ...rows.map((r) => r[k].length));
  const wl = w('nlink');
  const ws = w('size');
  const wi = w('ino');
  return rows
    .map(
      (r) =>
        `${o.inode ? `${r.ino.padStart(wi)} ` : ''}${r.mode} ${r.nlink.padStart(wl)} user user ${r.size.padStart(ws)} ${r.time} ${r.name}\n`,
    )
    .join('');
}

// --------------------------------------------------------------------- mkdir

export async function mkdir(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'pv',
      shortArg: 'm',
      long: { parents: { name: 'p' }, verbose: { name: 'v' }, mode: { name: 'm', arg: true } },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      await ctx.stderr.write("Try 'mkdir --help' for more information.\n");
      return 1;
    }
    const mode = o.flags.has('m') ? parseInt(String(o.flags.get('m')), 8) : 0o777;
    let status = 0;
    for (const name of o.operands) {
      const path = resolvePath(ctx.cwd, name);
      try {
        if (o.flags.has('p')) {
          const created = ctx.fs.mkdirSync(path, { recursive: true, mode }) as string | undefined;
          if (o.flags.has('v') && created) {
            // Report each created component.
            let p = created;
            const parts: string[] = [];
            while (p.length <= path.length) {
              parts.push(p);
              if (p === path) break;
              const next = path.indexOf('/', p.length + 1);
              p = next < 0 ? path : path.slice(0, next);
            }
            for (const c of parts)
              await ctx.stdout.write(
                `mkdir: created directory ${quoteName(relativeTo(name, path, c))}\n`,
              );
          }
        } else {
          ctx.fs.mkdirSync(path, { mode });
          if (o.flags.has('v'))
            await ctx.stdout.write(`mkdir: created directory ${quoteName(name)}\n`);
        }
      } catch (err) {
        await complain(ctx, `cannot create directory ${quoteName(name)}: ${strerror(err)}`);
        status = 1;
      }
    }
    return status;
  });
}

function relativeTo(name: string, full: string, component: string): string {
  // Map an absolute created component back to the user's spelling of the path.
  const suffix = full.slice(component.length);
  return suffix ? name.slice(0, name.length - suffix.length).replace(/\/+$/, '') : name;
}

// --------------------------------------------------------------------- rmdir

export async function rmdir(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'pv',
      long: {
        parents: { name: 'p' },
        verbose: { name: 'v' },
        'ignore-fail-on-non-empty': { name: 'ignore' },
      },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      return 1;
    }
    let status = 0;
    for (const name of o.operands) {
      const targets = [name];
      if (o.flags.has('p')) {
        let d = name.replace(/\/+$/, '');
        while (d.includes('/')) {
          d = dirname(d);
          if (d === '.' || d === '/') break;
          targets.push(d);
        }
      }
      for (const t of targets) {
        try {
          ctx.fs.rmdirSync(resolvePath(ctx.cwd, t));
          if (o.flags.has('v'))
            await ctx.stdout.write(`rmdir: removing directory, ${quoteName(t)}\n`);
        } catch (err) {
          if (o.flags.has('ignore') && errorCode(err) === 'ENOTEMPTY') break;
          await complain(ctx, `failed to remove ${quoteName(t)}: ${strerror(err)}`);
          status = 1;
          break;
        }
      }
    }
    return status;
  });
}

// ------------------------------------------------------------------------ rm

export async function rm(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'rRfdviI',
      long: {
        recursive: { name: 'r' },
        force: { name: 'f' },
        dir: { name: 'd' },
        verbose: { name: 'v' },
        'no-preserve-root': { name: 'npr' },
        'preserve-root': { name: 'pr', arg: 'optional' },
      },
    });
    const f = o.flags;
    const recursive = f.has('r') || f.has('R');
    const force = f.has('f');
    if (o.operands.length === 0) {
      if (force) return 0;
      await complain(ctx, 'missing operand');
      await ctx.stderr.write("Try 'rm --help' for more information.\n");
      return 1;
    }
    let status = 0;
    for (const name of o.operands) {
      const base = basename(name);
      if ((base === '.' || base === '..') && (recursive || f.has('d'))) {
        await complain(
          ctx,
          `refusing to remove '.' or '..' directory: skipping ${quoteName(name)}`,
        );
        status = 1;
        continue;
      }
      const path = resolvePath(ctx.cwd, name);
      if (path === '/' && recursive && !f.has('npr')) {
        await complain(ctx, "it is dangerous to operate recursively on '/'");
        await complain(ctx, 'use --no-preserve-root to override this failsafe');
        status = 1;
        continue;
      }
      const st = lstatOrNull(ctx.fs, path);
      if (!st) {
        if (!force) {
          await complain(ctx, `cannot remove ${quoteName(name)}: No such file or directory`);
          status = 1;
        }
        continue;
      }
      try {
        if (isDir(st)) {
          if (recursive) {
            if (f.has('v')) await removeVerbose(ctx, path, name);
            else ctx.fs.rmSync(path, { recursive: true, force: true });
          } else if (f.has('d')) {
            ctx.fs.rmdirSync(path);
            if (f.has('v')) await ctx.stdout.write(`removed directory ${quoteName(name)}\n`);
          } else {
            await complain(ctx, `cannot remove ${quoteName(name)}: Is a directory`);
            status = 1;
          }
        } else {
          ctx.fs.unlinkSync(path);
          if (f.has('v')) await ctx.stdout.write(`removed ${quoteName(name)}\n`);
        }
      } catch (err) {
        await complain(ctx, `cannot remove ${quoteName(name)}: ${strerror(err)}`);
        status = 1;
      }
    }
    return status;
  });
}

async function removeVerbose(ctx: CommandContext, path: string, name: string): Promise<void> {
  const st = ctx.fs.lstatSync(path);
  if (isDir(st)) {
    for (const child of (ctx.fs.readdirSync(path) as string[]).sort(compareNames)) {
      await removeVerbose(ctx, `${path}/${child}`, `${name.replace(/\/+$/, '')}/${child}`);
    }
    ctx.fs.rmdirSync(path);
    await ctx.stdout.write(`removed directory ${quoteName(name)}\n`);
  } else {
    ctx.fs.unlinkSync(path);
    await ctx.stdout.write(`removed ${quoteName(name)}\n`);
  }
}

// --------------------------------------------------------------------- touch

function parseTouchDate(s: string): number | null {
  if (/^@\d+(\.\d+)?$/.test(s)) return Number(s.slice(1)) * 1000;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

export async function touch(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'camh',
      shortArg: 'drt',
      long: {
        'no-create': { name: 'c' },
        date: { name: 'd', arg: true },
        reference: { name: 'r', arg: true },
        'no-dereference': { name: 'h' },
      },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing file operand');
      await ctx.stderr.write("Try 'touch --help' for more information.\n");
      return 1;
    }
    let time = Date.now();
    if (o.flags.has('d')) {
      const t = parseTouchDate(String(o.flags.get('d')));
      if (t === null) {
        await complain(ctx, `invalid date format ${quoteName(String(o.flags.get('d')))}`);
        return 1;
      }
      time = t;
    }
    if (o.flags.has('t')) {
      const m = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(
        String(o.flags.get('t')),
      );
      if (!m) {
        await complain(ctx, `invalid date format ${quoteName(String(o.flags.get('t')))}`);
        return 1;
      }
      const year = m[2] ? Number((m[1] ?? '20') + m[2]) : new Date().getFullYear();
      time = new Date(
        year,
        Number(m[3]) - 1,
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
        Number(m[7] ?? 0),
      ).getTime();
    }
    if (o.flags.has('r')) {
      try {
        time = ctx.fs.statSync(resolvePath(ctx.cwd, String(o.flags.get('r')))).mtimeMs;
      } catch (err) {
        await complain(
          ctx,
          `failed to get attributes of ${quoteName(String(o.flags.get('r')))}: ${strerror(err)}`,
        );
        return 1;
      }
    }
    let status = 0;
    for (const name of o.operands) {
      const path = resolvePath(ctx.cwd, name);
      try {
        const st = statOrNull(ctx.fs, path);
        if (!st) {
          if (o.flags.has('c')) continue;
          ctx.fs.writeFileSync(path, new Uint8Array(0), { flag: 'a' });
        }
        const cur = statOrNull(ctx.fs, path);
        const atime = o.flags.has('m') && !o.flags.has('a') ? (cur?.atimeMs ?? time) : time;
        const mtime = o.flags.has('a') && !o.flags.has('m') ? (cur?.mtimeMs ?? time) : time;
        ctx.fs.utimesSync(path, atime / 1000, mtime / 1000);
      } catch (err) {
        await complain(ctx, `cannot touch ${quoteName(name)}: ${strerror(err)}`);
        status = 1;
      }
    }
    return status;
  });
}

// ------------------------------------------------------------------- cp / mv

interface CopyOptions {
  recursive: boolean;
  force: boolean;
  noClobber: boolean;
  verbose: boolean;
  preserve: boolean;
  dereference: boolean;
  update: boolean;
}

function copyEntry(
  ctx: CommandContext,
  src: string,
  dest: string,
  o: CopyOptions,
  top: boolean,
  log: string[],
  srcName: string,
  destName: string,
): void {
  const fs = ctx.fs;
  const lst = fs.lstatSync(src);
  const st = isLink(lst) && (o.dereference || (top && !o.recursive)) ? fs.statSync(src) : lst;
  const destSt = lstatOrNull(fs, dest);
  if (isDir(st)) {
    if (destSt && !isDir(destSt)) {
      throw new CopyError(
        `cannot overwrite non-directory ${quoteName(destName)} with directory ${quoteName(srcName)}`,
      );
    }
    if (!destSt) {
      fs.mkdirSync(dest, { mode: st.mode & 0o7777 });
      if (o.verbose) log.push(`${quoteName(srcName)} -> ${quoteName(destName)}`);
    }
    for (const child of (fs.readdirSync(src) as string[]).sort(compareNames)) {
      copyEntry(
        ctx,
        `${src}/${child}`,
        `${dest}/${child}`,
        o,
        false,
        log,
        `${srcName}/${child}`,
        `${destName}/${child}`,
      );
    }
    if (o.preserve) fs.utimesSync(dest, st.atimeMs / 1000, st.mtimeMs / 1000);
    return;
  }
  if (destSt) {
    if (o.noClobber) return;
    if (o.update && destSt.mtimeMs >= st.mtimeMs) return;
    if (destSt.ino === st.ino && !isLink(st)) {
      throw new CopyError(`${quoteName(srcName)} and ${quoteName(destName)} are the same file`);
    }
    if (isDir(destSt))
      throw new CopyError(`cannot overwrite directory ${quoteName(destName)} with non-directory`);
  }
  if (isLink(st)) {
    if (destSt) fs.unlinkSync(dest);
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else {
    if (destSt && isLink(destSt) && o.force) fs.unlinkSync(dest);
    try {
      fs.copyFileSync(src, dest);
    } catch (err) {
      if (o.force && destSt && errorCode(err) === 'EACCES') {
        fs.unlinkSync(dest);
        fs.copyFileSync(src, dest);
      } else throw err;
    }
    if (o.preserve) {
      fs.chmodSync(dest, st.mode & 0o7777);
      fs.utimesSync(dest, st.atimeMs / 1000, st.mtimeMs / 1000);
    }
  }
  if (o.verbose) log.push(`${quoteName(srcName)} -> ${quoteName(destName)}`);
}

class CopyError extends Error {}

export async function cp(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const p = parseOptions(ctx.argv.slice(1), {
      short: 'rRfinvpaLPTdHlsu',
      shortArg: 't',
      long: {
        recursive: { name: 'r' },
        force: { name: 'f' },
        'no-clobber': { name: 'n' },
        verbose: { name: 'v' },
        archive: { name: 'a' },
        preserve: { name: 'p', arg: 'optional' },
        dereference: { name: 'L' },
        'no-dereference': { name: 'P' },
        'target-directory': { name: 't', arg: true },
        'no-target-directory': { name: 'T' },
        update: { name: 'u', arg: 'optional' },
        parents: { name: 'parents' },
      },
    });
    const f = p.flags;
    const o: CopyOptions = {
      recursive: f.has('r') || f.has('R') || f.has('a'),
      force: f.has('f'),
      noClobber: f.has('n'),
      verbose: f.has('v'),
      preserve: f.has('p') || f.has('a'),
      dereference: f.has('L'),
      update: f.has('u'),
    };
    return transfer(ctx, p.operands, f, 'cp', async (src, dest, srcName, destName) => {
      const st = statOrNull(ctx.fs, src);
      const lst = lstatOrNull(ctx.fs, src);
      if (!lst) throw new CopyError(`cannot stat ${quoteName(srcName)}: No such file or directory`);
      if (isDir(st) && !isLink(lst) && !o.recursive) {
        throw new CopyError(`-r not specified; omitting directory ${quoteName(srcName)}`);
      }
      if (isDir(st) && !isLink(lst)) {
        const rd = resolvePath('/', dest);
        if (rd === src || rd.startsWith(`${src}/`)) {
          throw new CopyError(
            `cannot copy a directory, ${quoteName(srcName)}, into itself, ${quoteName(destName)}`,
          );
        }
      }
      const log: string[] = [];
      try {
        copyEntry(ctx, src, dest, o, true, log, srcName, destName);
      } finally {
        for (const l of log) await ctx.stdout.write(`${l}\n`);
      }
    });
  });
}

export async function mv(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const p = parseOptions(ctx.argv.slice(1), {
      short: 'finvTu',
      shortArg: 't',
      long: {
        force: { name: 'f' },
        'no-clobber': { name: 'n' },
        verbose: { name: 'v' },
        'target-directory': { name: 't', arg: true },
        'no-target-directory': { name: 'T' },
        update: { name: 'u', arg: 'optional' },
      },
    });
    const f = p.flags;
    return transfer(ctx, p.operands, f, 'mv', async (src, dest, srcName, destName) => {
      const lst = lstatOrNull(ctx.fs, src);
      if (!lst) throw new CopyError(`cannot stat ${quoteName(srcName)}: No such file or directory`);
      const destSt = lstatOrNull(ctx.fs, dest);
      if (destSt) {
        if (f.has('n')) return;
        if (f.has('u') && destSt.mtimeMs >= lst.mtimeMs) return;
        if (destSt.ino === lst.ino) {
          throw new CopyError(`${quoteName(srcName)} and ${quoteName(destName)} are the same file`);
        }
        if (isDir(destSt) && !isDir(lst)) {
          throw new CopyError(
            `cannot overwrite directory ${quoteName(destName)} with non-directory`,
          );
        }
        if (!isDir(destSt) && isDir(lst)) {
          throw new CopyError(
            `cannot overwrite non-directory ${quoteName(destName)} with directory ${quoteName(srcName)}`,
          );
        }
      }
      if (isDir(lst) && (dest === src || dest.startsWith(`${src}/`))) {
        throw new CopyError(
          `cannot move ${quoteName(srcName)} to a subdirectory of itself, ${quoteName(destName)}`,
        );
      }
      try {
        ctx.fs.renameSync(src, dest);
      } catch (err) {
        throw new CopyError(
          `cannot move ${quoteName(srcName)} to ${quoteName(destName)}: ${strerror(err)}`,
        );
      }
      if (f.has('v'))
        await ctx.stdout.write(`renamed ${quoteName(srcName)} -> ${quoteName(destName)}\n`);
    });
  });
}

/** Shared operand handling for cp and mv (SOURCE DEST, SOURCE... DIR, -t, -T). */
async function transfer(
  ctx: CommandContext,
  operands: string[],
  f: Map<string, string | true>,
  name: string,
  one: (src: string, dest: string, srcName: string, destName: string) => Promise<void>,
): Promise<number> {
  let sources = operands;
  let target: string | undefined;
  if (f.has('t')) target = String(f.get('t'));
  else {
    if (operands.length === 0) {
      await complain(ctx, 'missing file operand');
      await ctx.stderr.write(`Try '${name} --help' for more information.\n`);
      return 1;
    }
    if (operands.length === 1) {
      await complain(ctx, `missing destination file operand after ${quoteName(operands[0]!)}`);
      await ctx.stderr.write(`Try '${name} --help' for more information.\n`);
      return 1;
    }
    target = operands[operands.length - 1]!;
    sources = operands.slice(0, -1);
  }
  const targetPath = resolvePath(ctx.cwd, target);
  const targetIsDir = !f.has('T') && isDir(statOrNull(ctx.fs, targetPath));
  if (!targetIsDir && (sources.length > 1 || f.has('t'))) {
    await complain(ctx, `target ${quoteName(target)} is not a directory`);
    return 1;
  }
  let status = 0;
  for (const s of sources) {
    const src = resolvePath(ctx.cwd, s);
    let dest = targetPath;
    let destName = target;
    if (targetIsDir) {
      const b = basename(s);
      dest = `${targetPath === '/' ? '' : targetPath}/${b}`;
      destName = `${target.replace(/\/+$/, '')}/${b}`;
    }
    try {
      await one(src, dest, s, destName);
    } catch (err) {
      if (err instanceof CopyError) await complain(ctx, err.message);
      else {
        const code = errorCode(err);
        const what = code === 'ENOENT' && !exists(ctx.fs, dirname(dest)) ? destName : s;
        await complain(
          ctx,
          `cannot ${name === 'cp' ? (what === destName ? 'create regular file' : 'stat') : 'move'} ${quoteName(what)}: ${strerror(err)}`,
        );
      }
      status = 1;
    }
  }
  return status;
}

// ------------------------------------------------------------------------ ln

export async function ln(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const p = parseOptions(ctx.argv.slice(1), {
      short: 'sfnvTrLP',
      shortArg: 't',
      long: {
        symbolic: { name: 's' },
        force: { name: 'f' },
        'no-dereference': { name: 'n' },
        verbose: { name: 'v' },
        relative: { name: 'r' },
        'target-directory': { name: 't', arg: true },
        'no-target-directory': { name: 'T' },
      },
    });
    const f = p.flags;
    let ops = p.operands;
    if (ops.length === 0) {
      await complain(ctx, 'missing file operand');
      return 1;
    }
    let dir: string | undefined;
    if (f.has('t')) dir = String(f.get('t'));
    else if (ops.length === 1) {
      dir = '.';
    } else {
      const last = ops[ops.length - 1]!;
      const lastPath = resolvePath(ctx.cwd, last);
      const st = f.has('n') ? lstatOrNull(ctx.fs, lastPath) : statOrNull(ctx.fs, lastPath);
      if (!f.has('T') && isDir(st) && !(f.has('n') && isLink(st))) {
        dir = last;
        ops = ops.slice(0, -1);
      } else if (ops.length > 2) {
        await complain(ctx, `target ${quoteName(last)} is not a directory`);
        return 1;
      }
    }
    const pairs: [string, string][] =
      dir !== undefined
        ? (f.has('t') || ops.length === 1 ? ops : ops).map((t) => [
            t,
            `${dir!.replace(/\/+$/, '')}/${basename(t)}`,
          ])
        : [[ops[0]!, ops[1]!]];
    let status = 0;
    for (const [targetName, linkName] of pairs) {
      const linkPath = resolvePath(
        ctx.cwd,
        dir === '.' && ops.length === 1 ? basename(targetName) : linkName,
      );
      const shownLink = dir === '.' && ops.length === 1 ? basename(targetName) : linkName;
      try {
        if (f.has('f') && lstatOrNull(ctx.fs, linkPath)) {
          if (isDir(lstatOrNull(ctx.fs, linkPath)))
            throw Object.assign(new Error(), { code: 'EISDIR' });
          ctx.fs.unlinkSync(linkPath);
        }
        if (f.has('s')) {
          let t = targetName;
          if (f.has('r')) t = relativePath(dirname(linkPath), resolvePath(ctx.cwd, targetName));
          ctx.fs.symlinkSync(t, linkPath);
        } else {
          ctx.fs.linkSync(resolvePath(ctx.cwd, targetName), linkPath);
        }
        if (f.has('v'))
          await ctx.stdout.write(`${quoteName(shownLink)} -> ${quoteName(targetName)}\n`);
      } catch (err) {
        const code = errorCode(err);
        if (!f.has('s') && code === 'ENOENT' && !exists(ctx.fs, resolvePath(ctx.cwd, targetName))) {
          await complain(
            ctx,
            `failed to access ${quoteName(targetName)}: No such file or directory`,
          );
        } else {
          await complain(
            ctx,
            `failed to create ${f.has('s') ? 'symbolic' : 'hard'} link ${quoteName(shownLink)}${
              code === 'EEXIST' ? '' : ` -> ${quoteName(targetName)}`
            }: ${strerror(err)}`,
          );
        }
        status = 1;
      }
    }
    return status;
  });
}

export function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  const rel = [...up, ...b.slice(i)].join('/');
  return rel || '.';
}

// --------------------------------------------------------------------- chmod

/** Applies a chmod mode spec (octal or symbolic) to `mode`; null when invalid. */
export function applyMode(
  spec: string,
  mode: number,
  isDirectory: boolean,
  umask = 0o022,
): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return (mode & ~0o7777) | parseInt(spec, 8);
  let m = mode;
  for (const clause of spec.split(',')) {
    const c = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause);
    if (!c) {
      // Multiple ops in one clause (u+x-w) are rare; reject like an invalid mode.
      return null;
    }
    const who = c[1] || '';
    const op = c[2]!;
    const perms = c[3]!;
    let mask = 0;
    const whoMask =
      who === ''
        ? 0o777 & ~umask
        : (who.includes('a') ? 0o777 : 0) |
          (who.includes('u') ? 0o700 : 0) |
          (who.includes('g') ? 0o070 : 0) |
          (who.includes('o') ? 0o007 : 0);
    let bits = 0;
    if (perms === 'u' || perms === 'g' || perms === 'o') {
      const shift = perms === 'u' ? 6 : perms === 'g' ? 3 : 0;
      const v = (m >> shift) & 7;
      bits = (v << 6) | (v << 3) | v;
    } else {
      for (const p of perms) {
        if (p === 'r') bits |= 0o444;
        else if (p === 'w') bits |= 0o222;
        else if (p === 'x') bits |= 0o111;
        else if (p === 'X' && (isDirectory || (m & 0o111) !== 0)) bits |= 0o111;
        else if (p === 's')
          mask |=
            (who.includes('u') || who === '' || who.includes('a') ? 0o4000 : 0) |
            (who.includes('g') || who === '' || who.includes('a') ? 0o2000 : 0);
        else if (p === 't') mask |= 0o1000;
      }
    }
    bits = (bits & whoMask) | mask;
    if (op === '+') m |= bits;
    else if (op === '-') m &= ~bits;
    else {
      const clear =
        (who === '' ? 0o777 : whoMask) |
        (who.includes('u') || who === '' || who.includes('a') ? 0o4000 : 0) |
        (who.includes('g') || who === '' || who.includes('a') ? 0o2000 : 0);
      m = (m & ~clear) | bits;
    }
  }
  return m;
}

export async function chmod(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (/^-[Rvfc]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
    else if (a === '--recursive') flags.add('R');
    else if (a === '--verbose') flags.add('v');
    else rest.push(a);
  }
  const [spec, ...files] = rest;
  if (spec === undefined) {
    await complain(ctx, 'missing operand');
    return 1;
  }
  if (files.length === 0) {
    await complain(ctx, `missing operand after ${quoteName(spec)}`);
    return 1;
  }
  let status = 0;
  const apply = async (path: string, name: string, top: boolean) => {
    let st: Stats;
    try {
      st = top ? ctx.fs.statSync(path) : ctx.fs.lstatSync(path);
    } catch (err) {
      if (!flags.has('f'))
        await complain(ctx, `cannot access ${quoteName(name)}: ${strerror(err)}`);
      status = 1;
      return;
    }
    if (isLink(st)) return;
    const next = applyMode(spec, st.mode, isDir(st));
    if (next === null) {
      await complain(ctx, `invalid mode: ${quoteName(spec)}`);
      status = 1;
      return;
    }
    ctx.fs.chmodSync(path, next & 0o7777);
    if (flags.has('v') || (flags.has('c') && next !== st.mode)) {
      const o = (st.mode & 0o7777).toString(8).padStart(4, '0');
      const n = (next & 0o7777).toString(8).padStart(4, '0');
      await ctx.stdout.write(
        next === st.mode
          ? `mode of ${quoteName(name)} retained as ${o} (${modeString(st.mode).slice(1)})\n`
          : `mode of ${quoteName(name)} changed from ${o} (${modeString(st.mode).slice(1)}) to ${n} (${modeString(next).slice(1)})\n`,
      );
    }
    if (flags.has('R') && isDir(st)) {
      for (const child of (ctx.fs.readdirSync(path) as string[]).sort(compareNames)) {
        await apply(`${path}/${child}`, `${name.replace(/\/+$/, '')}/${child}`, false);
      }
    }
  };
  for (const name of files) await apply(resolvePath(ctx.cwd, name), name, true);
  return status;
}

// ------------------------------------------------------- realpath / readlink

/** Canonicalizes a path. `mode`: 'e' all components exist, 'E' all but the last, 'm' none. */
export function canonicalize(fs: ShellFs, path: string, mode: 'e' | 'E' | 'm'): string | null {
  const parts = path.split('/').filter(Boolean);
  let cur = '/';
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = cur === '/' ? `/${part}` : `${cur}/${part}`;
    const st = lstatOrNull(fs, next);
    if (!st) {
      const last = i === parts.length - 1;
      if (mode === 'e' || (mode === 'E' && !last)) return null;
      cur = next;
      continue;
    }
    if (isLink(st)) {
      if (++hops > 40) return null;
      const target = fs.readlinkSync(next);
      const rest = parts.slice(i + 1);
      const base = target.startsWith('/') ? target : `${cur}/${target}`;
      return canonicalizeWithHops(fs, [base, ...rest].join('/'), mode, hops);
    }
    if (i < parts.length - 1 && !isDir(st) && mode !== 'm') return null;
    cur = next;
  }
  return cur;
}

function canonicalizeWithHops(
  fs: ShellFs,
  path: string,
  mode: 'e' | 'E' | 'm',
  hops: number,
): string | null {
  if (hops > 40) return null;
  return canonicalize(fs, path, mode);
}

export async function realpath(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'emsqLPz',
      long: {
        'canonicalize-existing': { name: 'e' },
        'canonicalize-missing': { name: 'm' },
        'no-symlinks': { name: 's' },
        strip: { name: 's' },
        quiet: { name: 'q' },
        'relative-to': { name: 'relto', arg: true },
      },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      return 1;
    }
    let status = 0;
    const mode = o.flags.has('e') ? 'e' : o.flags.has('m') ? 'm' : 'E';
    for (const name of o.operands) {
      const abs = resolvePath(ctx.cwd, name);
      const r = o.flags.has('s') ? abs : canonicalize(ctx.fs, abs, mode);
      if (r === null) {
        if (!o.flags.has('q')) await complain(ctx, `${name}: No such file or directory`);
        status = 1;
        continue;
      }
      const rel = o.flags.get('relto');
      await ctx.stdout.write(
        `${typeof rel === 'string' ? relativePath(canonicalize(ctx.fs, resolvePath(ctx.cwd, rel), 'm') ?? rel, r) : r}\n`,
      );
    }
    return status;
  });
}

export async function readlink(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'femnqsvz',
      long: {
        canonicalize: { name: 'f' },
        'canonicalize-existing': { name: 'e' },
        'canonicalize-missing': { name: 'm' },
        'no-newline': { name: 'n' },
      },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      return 1;
    }
    let status = 0;
    const nl = o.flags.has('n') && o.operands.length === 1 ? '' : '\n';
    for (const name of o.operands) {
      const abs = resolvePath(ctx.cwd, name);
      const mode = o.flags.has('f') ? 'E' : o.flags.has('e') ? 'e' : o.flags.has('m') ? 'm' : null;
      if (mode) {
        const r = canonicalize(ctx.fs, abs, mode);
        if (r === null) status = 1;
        else await ctx.stdout.write(r + nl);
        continue;
      }
      try {
        await ctx.stdout.write(ctx.fs.readlinkSync(abs) + nl);
      } catch (err) {
        if (o.flags.has('v')) await complain(ctx, `${name}: ${strerror(err)}`);
        status = 1;
      }
    }
    return status;
  });
}

// ------------------------------------------------------- basename / dirname

export async function basenameCmd(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'az',
      shortArg: 's',
      long: { multiple: { name: 'a' }, suffix: { name: 's', arg: true }, zero: { name: 'z' } },
    });
    if (o.operands.length === 0) {
      await complain(ctx, 'missing operand');
      await ctx.stderr.write("Try 'basename --help' for more information.\n");
      return 1;
    }
    let suffix = o.flags.has('s') ? String(o.flags.get('s')) : undefined;
    let names = o.operands;
    if (!o.flags.has('a') && !o.flags.has('s')) {
      if (names.length > 2) {
        await complain(ctx, `extra operand ${quoteName(names[2]!)}`);
        await ctx.stderr.write("Try 'basename --help' for more information.\n");
        return 1;
      }
      suffix = names[1];
      names = names.slice(0, 1);
    }
    const end = o.flags.has('z') ? '\0' : '\n';
    let out = '';
    for (const n of names) {
      let b = basename(n);
      if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
      out += b + end;
    }
    await ctx.stdout.write(out);
    return 0;
  });
}

export async function dirnameCmd(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1).filter((a) => a !== '--');
  if (args.length === 0) {
    await complain(ctx, 'missing operand');
    await ctx.stderr.write("Try 'dirname --help' for more information.\n");
    return 1;
  }
  await ctx.stdout.write(args.map((a) => `${dirname(a)}\n`).join(''));
  return 0;
}

// -------------------------------------------------------------------- mktemp

export async function mktemp(ctx: CommandContext): Promise<number> {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'dqut',
      shortArg: 'p',
      long: {
        directory: { name: 'd' },
        quiet: { name: 'q' },
        'dry-run': { name: 'u' },
        tmpdir: { name: 'p', arg: 'optional' },
        suffix: { name: 'suffix', arg: true },
      },
    });
    const template = o.operands[0] ?? 'tmp.XXXXXXXXXX';
    const suffix = o.flags.has('suffix') ? String(o.flags.get('suffix')) : '';
    const m = /X{3,}$/.exec(template);
    if (!m) {
      await complain(ctx, `too few X's in template ${quoteName(template)}`);
      return 1;
    }
    let dir: string | undefined;
    if (o.flags.has('p') || o.flags.has('t') || o.operands.length === 0) {
      const p = o.flags.get('p');
      dir = typeof p === 'string' && p ? p : ctx.env['TMPDIR'] || '/tmp';
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempt = 0; attempt < 100; attempt++) {
      let rand = '';
      for (let i = 0; i < m[0].length; i++) rand += chars[Math.floor(Math.random() * chars.length)];
      const name = template.slice(0, m.index) + rand + suffix;
      const shown = dir ? `${dir.replace(/\/+$/, '')}/${name}` : name;
      const path = resolvePath(ctx.cwd, shown);
      if (exists(ctx.fs, path, true)) continue;
      try {
        if (!o.flags.has('u')) {
          if (o.flags.has('d')) ctx.fs.mkdirSync(path, { mode: 0o700 });
          else ctx.fs.writeFileSync(path, new Uint8Array(0), { flag: 'wx', mode: 0o600 });
        }
      } catch (err) {
        if (!o.flags.has('q')) {
          await complain(
            ctx,
            `failed to create ${o.flags.has('d') ? 'directory' : 'file'} via template ${quoteName(template)}: ${strerror(err)}`,
          );
        }
        return 1;
      }
      await ctx.stdout.write(`${shown}\n`);
      return 0;
    }
    return 1;
  });
}
