// SPDX-License-Identifier: Apache-2.0
// tar, gzip, gunzip and zcat (GNU behavior for the common options). Archives
// are built in memory: fine for project-sized trees, not for multi-GB files.

import { createZlib, readTar, writeTar } from '@clientvm/node-compat';
import type { TarEntry } from '@clientvm/node-compat';
import { readAll } from '../io.ts';
import type { CommandContext } from '../types.ts';
import { complain, inputs, parseOptions, resolvePath, strerror, withUsage } from './util.ts';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

let zlib: Record<string, unknown> | undefined;
const codec = (name: 'gzipSync' | 'gunzipSync') =>
  (zlib ??= createZlib(() => {
    throw new Error('zlib streams are not used by the shell');
  }))[name] as (b: Uint8Array) => Uint8Array;

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

// ----------------------------------------------------------------------- tar

function modeString(type: TarEntry['type'], mode: number): string {
  const kind = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : type === 'link' ? 'h' : '-';
  let s = kind;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 7;
    s += `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  }
  return s;
}

function listLine(e: TarEntry): string {
  const d = new Date(e.mtime * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const link =
    e.type === 'symlink' ? ` -> ${e.linkname}` : e.type === 'link' ? ` link to ${e.linkname}` : '';
  return `${modeString(e.type, e.mode)} user/user ${String(e.size).padStart(8)} ${date} ${e.path}${link}`;
}

/** GNU tar accepts old-style bundled options as the first argument (`tar xzf a.tgz`). */
function expandOldStyle(args: readonly string[]): string[] {
  const first = args[0];
  if (first === undefined || first.startsWith('-') || !/^[A-Za-z]+$/.test(first)) return [...args];
  const out: string[] = [];
  let i = 1;
  for (const c of first) {
    out.push(`-${c}`);
    if ('fCT'.includes(c) && i < args.length) out.push(args[i++]!);
  }
  return [...out, ...args.slice(i)];
}

export async function tar(ctx: CommandContext): Promise<number> {
  return withUsage(
    ctx,
    async () => {
      const o = parseOptions(expandOldStyle(ctx.argv.slice(1)), {
        short: 'cxtzvOkpa',
        shortArg: 'fC',
        long: {
          create: { name: 'c' },
          extract: { name: 'x' },
          get: { name: 'x' },
          list: { name: 't' },
          gzip: { name: 'z' },
          gunzip: { name: 'z' },
          verbose: { name: 'v' },
          file: { name: 'f', arg: true },
          directory: { name: 'C', arg: true },
          'to-stdout': { name: 'O' },
          'keep-old-files': { name: 'k' },
          'strip-components': { name: 'strip', arg: true },
          exclude: { name: 'exclude', arg: true },
          'preserve-permissions': { name: 'p' },
          'auto-compress': { name: 'a' },
          'no-same-owner': { name: 'no-same-owner' },
        },
      });
      const f = o.flags;
      const modes = ['c', 'x', 't'].filter((m) => f.has(m));
      if (modes.length !== 1) {
        await complain(
          ctx,
          modes.length === 0
            ? "You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"
            : "You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option",
        );
        await ctx.stderr.write(`Try '${ctx.argv[0]} --help' for more information.\n`);
        return 2;
      }
      const file = f.get('f');
      const archivePath = typeof file === 'string' && file !== '-' ? file : null;
      let dir = ctx.cwd;
      const verbose = f.has('v');
      const excludes = o.list.filter((l) => l.name === 'exclude').map((l) => String(l.value));
      const excluded = (name: string) =>
        excludes.some((pat) => {
          const re = new RegExp(
            `(^|/)${pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '[^/]*')
              .replace(/\?/g, '[^/]')}(/|$)`,
          );
          return re.test(name);
        });
      for (const l of o.list) if (l.name === 'C') dir = resolvePath(dir, String(l.value));

      if (f.has('c')) {
        if (o.operands.length === 0) {
          await complain(ctx, 'Cowardly refusing to create an empty archive');
          return 2;
        }
        const entries: TarEntry[] = [];
        let status = 0;
        let warnedRoot = false;
        const add = async (abs: string, name: string) => {
          if (excluded(name)) return;
          const st = ctx.fs.lstatSync(abs);
          const kind = st.mode & S_IFMT;
          const mtime = Math.floor(st.mtimeMs / 1000);
          const mode = st.mode & 0o7777;
          if (kind === S_IFDIR) {
            entries.push({
              path: `${name}/`,
              type: 'dir',
              mode,
              size: 0,
              mtime,
              linkname: '',
              data: new Uint8Array(0),
            });
            if (verbose) await ctx.stdout.write(`${name}/\n`);
            for (const child of ctx.fs.readdirSync(abs).sort()) {
              await add(`${abs === '/' ? '' : abs}/${child}`, `${name}/${child}`);
            }
          } else if (kind === S_IFLNK) {
            const linkname = ctx.fs.readlinkSync(abs) as string;
            entries.push({
              path: name,
              type: 'symlink',
              mode,
              size: 0,
              mtime,
              linkname,
              data: new Uint8Array(0),
            });
            if (verbose) await ctx.stdout.write(`${name}\n`);
          } else {
            const data = ctx.fs.readFileSync(abs);
            entries.push({
              path: name,
              type: 'file',
              mode,
              size: data.length,
              mtime,
              linkname: '',
              data,
            });
            if (verbose) await ctx.stdout.write(`${name}\n`);
          }
        };
        for (const operand of o.operands) {
          let name = operand.replace(/\/+$/, '') || '/';
          if (name.startsWith('/')) {
            if (!warnedRoot) {
              await complain(ctx, "Removing leading `/' from member names");
              warnedRoot = true;
            }
            name = name.replace(/^\/+/, '') || '.';
          }
          try {
            await add(resolvePath(dir, operand), name);
          } catch (err) {
            await complain(ctx, `${operand}: Cannot stat: ${strerror(err)}`);
            status = 2;
          }
        }
        let bytes = writeTar(entries);
        const gz =
          f.has('z') || (f.has('a') && archivePath !== null && /\.(tgz|gz)$/.test(archivePath));
        if (gz) bytes = codec('gzipSync')(bytes);
        if (archivePath === null) await ctx.stdout.write(bytes);
        else ctx.fs.writeFileSync(resolvePath(ctx.cwd, archivePath), bytes);
        if (status) await complain(ctx, 'Exiting with failure status due to previous errors');
        return status;
      }

      // -x / -t: read the archive (gzip is detected, as GNU tar does for files).
      let bytes: Uint8Array;
      try {
        bytes =
          archivePath === null
            ? await readAll(ctx.stdin)
            : ctx.fs.readFileSync(resolvePath(ctx.cwd, archivePath));
      } catch (err) {
        await complain(ctx, `${archivePath}: Cannot open: ${strerror(err)}`);
        await complain(ctx, 'Error is not recoverable: exiting now');
        return 2;
      }
      if (isGzip(bytes)) bytes = codec('gunzipSync')(bytes);
      const strip = Number(f.get('strip') ?? 0);
      const wanted = o.operands.map((p) => p.replace(/\/+$/, ''));
      const matched = new Set<string>();
      let status = 0;
      try {
        for (const entry of readTar(bytes)) {
          const name = entry.path.replace(/\/+$/, '');
          const hit = wanted.find((w) => name === w || name.startsWith(`${w}/`));
          if (wanted.length > 0 && hit === undefined) continue;
          if (hit !== undefined) matched.add(hit);
          if (excluded(name)) continue;
          if (f.has('t')) {
            await ctx.stdout.write(`${verbose ? listLine(entry) : entry.path}\n`);
            continue;
          }
          const parts = name.split('/').filter((p) => p !== '' && p !== '.');
          if (parts.includes('..')) {
            await complain(ctx, `${entry.path}: Member name contains '..'`);
            status = 2;
            continue;
          }
          const rel = parts.slice(strip);
          if (rel.length === 0) continue;
          if (verbose) await ctx.stdout.write(`${entry.path}\n`);
          if (f.has('O')) {
            if (entry.type === 'file') await ctx.stdout.write(entry.data);
            continue;
          }
          const dest = `${dir === '/' ? '' : dir}/${rel.join('/')}`;
          const parent = dest.slice(0, dest.lastIndexOf('/')) || '/';
          try {
            ctx.fs.mkdirSync(parent, { recursive: true });
            if (entry.type === 'dir') {
              ctx.fs.mkdirSync(dest, { recursive: true });
              continue;
            }
            const existing = (() => {
              try {
                return ctx.fs.lstatSync(dest);
              } catch {
                return null;
              }
            })();
            if (existing && f.has('k')) {
              await complain(ctx, `${rel.join('/')}: Cannot open: File exists`);
              status = 2;
              continue;
            }
            if (existing && (existing.mode & S_IFMT) !== S_IFDIR) ctx.fs.unlinkSync(dest);
            if (entry.type === 'symlink') {
              ctx.fs.symlinkSync(entry.linkname, dest);
            } else if (entry.type === 'link') {
              const target = entry.linkname.split('/').filter(Boolean).slice(strip).join('/');
              ctx.fs.linkSync(`${dir === '/' ? '' : dir}/${target}`, dest);
            } else if (entry.type === 'file') {
              ctx.fs.writeFileSync(dest, entry.data);
              ctx.fs.chmodSync(dest, entry.mode & 0o777);
              ctx.fs.utimesSync(dest, entry.mtime, entry.mtime);
            }
          } catch (err) {
            await complain(ctx, `${rel.join('/')}: Cannot open: ${strerror(err)}`);
            status = 2;
          }
        }
      } catch (err) {
        await complain(ctx, (err as Error).message.replace(/^TAR_BAD_ARCHIVE: /, ''));
        await complain(ctx, 'This does not look like a tar archive');
        await complain(ctx, 'Exiting with failure status due to previous errors');
        return 2;
      }
      for (const w of wanted) {
        if (!matched.has(w)) {
          await complain(ctx, `${w}: Not found in archive`);
          status = 2;
        }
      }
      if (status) await complain(ctx, 'Exiting with failure status due to previous errors');
      return status;
    },
    2,
  );
}

// ---------------------------------------------------------------------- gzip

async function gzipMain(ctx: CommandContext, defaults: { d?: boolean; c?: boolean }) {
  return withUsage(ctx, async () => {
    const o = parseOptions(ctx.argv.slice(1), {
      short: 'cdfkqnNrtv123456789',
      long: {
        stdout: { name: 'c' },
        'to-stdout': { name: 'c' },
        decompress: { name: 'd' },
        uncompress: { name: 'd' },
        force: { name: 'f' },
        keep: { name: 'k' },
        quiet: { name: 'q' },
        test: { name: 't' },
        verbose: { name: 'v' },
      },
    });
    const f = o.flags;
    const decompress = defaults.d || f.has('d') || f.has('t');
    const toStdout = defaults.c || f.has('c') || f.has('t');
    let status = 0;
    const transform = (b: Uint8Array) =>
      decompress ? codec('gunzipSync')(b) : codec('gzipSync')(b);
    const files = o.operands.length === 0 ? ['-'] : o.operands;
    for await (const input of inputs(ctx, files)) {
      if ('error' in input) {
        await complain(ctx, `${input.name}: ${strerror(input.error)}`);
        status = 1;
        continue;
      }
      const bytes = await readAll(input.source);
      let out: Uint8Array;
      try {
        if (decompress && !isGzip(bytes)) throw new Error('not in gzip format');
        out = transform(bytes);
      } catch (err) {
        await complain(
          ctx,
          `${input.name === '-' ? 'stdin' : input.name}: ${(err as Error).message}`,
        );
        status = 1;
        continue;
      }
      if (f.has('t')) continue;
      if (toStdout || input.name === '-') {
        await ctx.stdout.write(out);
        continue;
      }
      const src = resolvePath(ctx.cwd, input.name);
      let dest: string;
      if (decompress) {
        const m = /\.(gz|tgz|z)$/i.exec(input.name);
        if (!m) {
          await complain(ctx, `${input.name}: unknown suffix -- ignored`);
          status = status || 2;
          continue;
        }
        dest =
          src.slice(0, src.length - m[0].length) + (m[1]!.toLowerCase() === 'tgz' ? '.tar' : '');
      } else {
        if (input.name.endsWith('.gz')) {
          await complain(ctx, `${input.name} already has .gz suffix -- unchanged`);
          status = status || 2;
          continue;
        }
        dest = `${src}.gz`;
      }
      let exists = false;
      try {
        ctx.fs.lstatSync(dest);
        exists = true;
      } catch {
        // dest is free
      }
      if (exists && !f.has('f')) {
        await complain(
          ctx,
          `${dest.slice(dest.lastIndexOf('/') + 1)} already exists; not overwritten`,
        );
        status = status || 2;
        continue;
      }
      ctx.fs.writeFileSync(dest, out);
      try {
        ctx.fs.chmodSync(dest, ctx.fs.statSync(src).mode & 0o777);
      } catch {
        // keep the default mode
      }
      if (!f.has('k')) ctx.fs.unlinkSync(src);
    }
    return status;
  });
}

export const gzip = (ctx: CommandContext) => gzipMain(ctx, {});
export const gunzip = (ctx: CommandContext) => gzipMain(ctx, { d: true });
export const zcat = (ctx: CommandContext) => gzipMain(ctx, { d: true, c: true });
