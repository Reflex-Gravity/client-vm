// SPDX-License-Identifier: Apache-2.0
// `git` for local repositories, on isomorphic-git (MIT), which is fetched
// from the registry on first use and checked against a pinned integrity, as
// npm is (ADR 0012). Objects are byte-compatible with real git: the same
// content, author and dates give the same commit ids. Remote operations
// (clone/fetch/pull/push) go through fetch, so most hosts need a CORS proxy
// (GIT_CORS_PROXY). See docs/compatibility.md for what is covered.

import { Buffer, installTarball, toBuffer } from '@clientvm/node-compat';
import type { CommandContext } from '../types.ts';
import { unifiedHunks } from './diff.ts';
import { resolvePath } from './util.ts';

const VERSION = '1.44.3';
const INTEGRITY =
  'sha512-xlEIMsVUrMfOR25F4jWB9He9s/rUHWsgfJJJ3zpdwFssv9X2QfoIUyYH9CEFok9yk2tx2UDipj2gJ+KVvV/qGA==';
const ROOT = `/usr/local/lib/clientvm/isomorphic-git@${VERSION}`;

type Fn = (args: Record<string, unknown>) => Promise<unknown>;
type Git = Record<string, Fn> & { STAGE: Fn; TREE: Fn; WORKDIR: Fn };

let cached: { git: Git; http: unknown } | undefined;

async function loadGit(ctx: CommandContext): Promise<{ git: Git; http: unknown }> {
  if (cached) return cached;
  const fs = ctx.fs;
  if (!fs.existsSync(`${ROOT}/package.json`)) {
    await installTarball(
      fs as never,
      {
        tarball: `https://registry.npmjs.org/isomorphic-git/-/isomorphic-git-${VERSION}.tgz`,
        integrity: INTEGRITY,
      },
      ROOT,
      Math.floor(Math.random() * 1e9),
    );
  }
  const load = (file: string): unknown => {
    const src = new TextDecoder().decode(fs.readFileSync(`${ROOT}/${file}`));
    const module = { exports: {} as unknown };
    // UMD bundles: they check `module`/`exports` first, then fall back to
    // `self`. isomorphic-git expects Node's Buffer as a free variable.
    new Function('module', 'exports', 'self', 'define', 'Buffer', src)(
      module,
      module.exports,
      globalThis,
      undefined,
      Buffer,
    );
    return module.exports;
  };
  cached = { git: load('index.umd.min.js') as Git, http: load('http/web/index.umd.js') };
  return cached;
}

/** isomorphic-git's promise fs, over the shell's synchronous fs. */
function promiseFs(ctx: CommandContext) {
  const fs = ctx.fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrap =
    (name: string, adapt?: (r: unknown, args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      const r = fs[name]!(...args);
      return adapt ? adapt(r, args) : r;
    };
  return {
    promises: {
      readFile: wrap('readFileSync', (r, args) => {
        const opts = args[1] as { encoding?: string } | string | undefined;
        const enc = typeof opts === 'string' ? opts : opts?.encoding;
        if (typeof r === 'string') return r;
        return enc ? new TextDecoder().decode(r as Uint8Array) : toBuffer(r as Uint8Array);
      }),
      writeFile: async (
        path: string,
        data: string | Uint8Array,
        opts?: { mode?: number } | string,
      ) => {
        fs['writeFileSync']!(path, data);
        if (typeof opts === 'object' && opts?.mode) fs['chmodSync']!(path, opts.mode);
      },
      unlink: wrap('unlinkSync'),
      readdir: wrap('readdirSync'),
      mkdir: async (path: string) => void fs['mkdirSync']!(path),
      rmdir: wrap('rmdirSync'),
      stat: wrap('statSync'),
      lstat: wrap('lstatSync'),
      readlink: wrap('readlinkSync'),
      symlink: wrap('symlinkSync'),
      chmod: wrap('chmodSync'),
    },
  };
}

// --------------------------------------------------------------------- utils

class GitError extends Error {
  readonly status: number;
  constructor(message: string, status = 128) {
    super(message);
    this.status = status;
  }
}

interface Person {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

interface CommitInfo {
  oid: string;
  commit: { message: string; tree: string; parent: string[]; author: Person; committer: Person };
}

const short = (oid: string) => oid.slice(0, 7);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function gitDate(p: Person): string {
  const d = new Date((p.timestamp - p.timezoneOffset * 60) * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -p.timezoneOffset;
  const tz = `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} ${tz}`;
}

/** Parses GIT_*_DATE values: unix seconds (optionally "@<s> <tz>") or an ISO date. */
function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^@?(\d+)(?:\s+[+-]\d{4})?$/.exec(value.trim());
  if (m) return Number(m[1]);
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = /^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (sec) section = sec[2] ? `${sec[1]}.${sec[2]}` : sec[1]!;
    else {
      const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
      if (kv && section)
        out[`${section}.${kv[1]}`.toLowerCase()] = kv[2]!.replace(/^"(.*)"$/, '$1');
    }
  }
  return out;
}

/** A tiny argv parser: flags (with values for `valued`) and positional operands. */
function parse(args: string[], valued: string[] = []) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  let paths: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (paths) paths.push(a);
    else if (a === '--') paths = [];
    else if (a.startsWith('--') && a.includes('='))
      flags.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else if (valued.includes(a)) flags.set(a, args[++i] ?? '');
    else if (/^-[A-Za-z]{2,}$/.test(a)) {
      // Bundled short flags; a valued one takes the rest of the word or the next arg.
      for (let j = 1; j < a.length; j++) {
        const f = `-${a[j]}`;
        if (valued.includes(f)) {
          flags.set(f, j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? ''));
          break;
        }
        flags.set(f, true);
      }
    } else if (a.startsWith('-') && a !== '-') flags.set(a, true);
    else rest.push(a);
  }
  return { flags, rest, paths: paths ?? [] };
}

// ------------------------------------------------------------------ command

export async function git(ctx: CommandContext): Promise<number> {
  const argv = ctx.argv.slice(1);
  // Global options before the subcommand.
  let cwd = ctx.cwd;
  while (argv[0] === '-C' || argv[0] === '-c') {
    if (argv[0] === '-C') cwd = resolvePath(cwd, argv[1] ?? '.');
    argv.splice(0, 2);
  }
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '--help' || cmd === 'help') {
    await ctx.stdout.write(
      'usage: git <command> [<args>]\n\nClientVM git (isomorphic-git) supports: init clone status add rm mv commit log show diff\nbranch checkout switch restore reset merge tag stash rev-parse ls-files config remote fetch pull push\n',
    );
    return cmd ? 0 : 1;
  }
  if (cmd === '--version' || cmd === 'version') {
    await ctx.stdout.write(`git version 2.47.0 (ClientVM, isomorphic-git ${VERSION})\n`);
    return 0;
  }
  try {
    const { git: G, http } = await loadGit(ctx);
    const fs = promiseFs(ctx);
    const out = (s: string) => ctx.stdout.write(s);
    const findRoot = async (): Promise<string> => {
      try {
        return (await G.findRoot!({ fs, filepath: cwd })) as string;
      } catch {
        throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
      }
    };
    const rel = (dir: string, p: string) => {
      const abs = resolvePath(cwd, p);
      if (abs === dir) return '.';
      if (!abs.startsWith(`${dir}/`))
        throw new GitError(`fatal: ${p}: '${p}' is outside repository at '${dir}'`);
      return abs.slice(dir.length + 1);
    };
    const display = (dir: string, filepath: string) => {
      const abs = `${dir}/${filepath}`;
      const base = cwd === dir ? '' : cwd.slice(dir.length + 1);
      if (!base) return filepath;
      if (abs.startsWith(`${cwd}/`)) return abs.slice(cwd.length + 1);
      const up = base
        .split('/')
        .map(() => '..')
        .join('/');
      return `${up}/${filepath}`;
    };
    const config = async (dir: string | null, key: string): Promise<string | undefined> => {
      if (dir) {
        const v = (await G.getConfig!({ fs, dir, path: key })) as string | undefined;
        if (v !== undefined) return v;
      }
      const home = ctx.env['HOME'] ?? '/home/user';
      try {
        return parseIni(decode(ctx.fs.readFileSync(`${home}/.gitconfig`)))[key.toLowerCase()];
      } catch {
        return undefined;
      }
    };
    const person = async (dir: string, kind: 'AUTHOR' | 'COMMITTER'): Promise<Person> => {
      const name =
        ctx.env[`GIT_${kind}_NAME`] ??
        (await config(dir, 'user.name')) ??
        ctx.env['USER'] ??
        'user';
      const email =
        ctx.env[`GIT_${kind}_EMAIL`] ??
        (await config(dir, 'user.email')) ??
        `${name}@clientvm.local`;
      const timestamp = parseDate(ctx.env[`GIT_${kind}_DATE`]) ?? Math.floor(Date.now() / 1000);
      return { name, email, timestamp, timezoneOffset: 0 };
    };
    const branchName = async (dir: string) =>
      ((await G.currentBranch!({ fs, dir, fullname: false })) as string | undefined) ?? null;
    const headOid = async (dir: string): Promise<string | null> => {
      try {
        return (await G.resolveRef!({ fs, dir, ref: 'HEAD' })) as string;
      } catch {
        return null;
      }
    };
    const resolve = async (dir: string, ref: string): Promise<string> => {
      const m = /^(.*?)((?:[~^]\d*)+)$/.exec(ref);
      let base = m ? m[1]! : ref;
      if (base === '' || base === '@') base = 'HEAD';
      let oid: string;
      try {
        oid = (await G.resolveRef!({ fs, dir, ref: base })) as string;
      } catch {
        try {
          oid = (await G.expandOid!({ fs, dir, oid: base })) as string;
        } catch {
          throw new GitError(
            `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`,
          );
        }
      }
      for (const step of m ? (m[2]!.match(/[~^]\d*/g) ?? []) : []) {
        const n = step.length > 1 ? Number(step.slice(1)) : 1;
        for (let i = 0; i < (step[0] === '~' ? n : 1); i++) {
          const c = (await G.readCommit!({ fs, dir, oid })) as CommitInfo;
          const parent = c.commit.parent[step[0] === '^' ? n - 1 : 0];
          if (!parent)
            throw new GitError(
              `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`,
            );
          oid = parent;
        }
      }
      return oid;
    };
    /** Any object name: a revision, `rev^{tree}`, `rev^{commit}` or `rev:path`. */
    const resolveObject = async (dir: string, spec: string): Promise<string> => {
      const colon = spec.indexOf(':');
      if (colon >= 0) {
        const commit = await resolve(dir, spec.slice(0, colon) || 'HEAD');
        const filepath = spec.slice(colon + 1).replace(/^\.\/|\/$/g, '');
        if (!filepath)
          return ((await G.readCommit!({ fs, dir, oid: commit })) as CommitInfo).commit.tree;
        try {
          return ((await G.readBlob!({ fs, dir, oid: commit, filepath })) as { oid: string }).oid;
        } catch {
          try {
            return ((await G.readTree!({ fs, dir, oid: commit, filepath })) as { oid: string }).oid;
          } catch {
            throw new GitError(
              `fatal: path '${filepath}' does not exist in '${spec.slice(0, colon) || 'HEAD'}'`,
            );
          }
        }
      }
      const peel = /^(.*)\^\{(tree|commit)\}$/.exec(spec);
      if (peel) {
        const oid = await resolve(dir, peel[1]!);
        return peel[2] === 'tree'
          ? ((await G.readCommit!({ fs, dir, oid })) as CommitInfo).commit.tree
          : oid;
      }
      try {
        return await resolve(dir, spec);
      } catch (err) {
        // A full or abbreviated id of a tree or blob.
        if (/^[0-9a-f]{4,40}$/.test(spec))
          return (await G.expandOid!({ fs, dir, oid: spec })) as string;
        throw err;
      }
    };
    const readObject = async (dir: string, oid: string) =>
      (await G.readObject!({ fs, dir, oid, format: 'content' })) as {
        type: string;
        object: Uint8Array;
      };
    const prettyObject = async (dir: string, oid: string): Promise<Uint8Array | string> => {
      const o = await readObject(dir, oid);
      if (o.type !== 'tree') return o.object;
      const { tree } = (await G.readTree!({ fs, dir, oid })) as {
        tree: { mode: string; path: string; oid: string; type: string }[];
      };
      return tree.map((e) => `${e.mode.padStart(6, '0')} ${e.type} ${e.oid}\t${e.path}\n`).join('');
    };
    /** Commits reachable from `ref`, newest first, in git's default order. */
    const walkLog = async (dir: string, ref: string, depth?: number) => {
      // git pops the newest commit by committer date; equal dates go first in, first out.
      const start = (await G.resolveRef!({ fs, dir, ref }).catch(() => ref)) as string;
      const seen = new Set([start]);
      let queue = [(await G.readCommit!({ fs, dir, oid: start })) as CommitInfo];
      const result: CommitInfo[] = [];
      while (queue.length && (depth === undefined || result.length < depth)) {
        const c = queue.shift()!;
        result.push(c);
        for (const p of c.commit.parent) {
          if (seen.has(p)) continue;
          seen.add(p);
          const pc = (await G.readCommit!({ fs, dir, oid: p })) as CommitInfo;
          const at = queue.findIndex(
            (q) => q.commit.committer.timestamp < pc.commit.committer.timestamp,
          );
          queue = at < 0 ? [...queue, pc] : [...queue.slice(0, at), pc, ...queue.slice(at)];
        }
      }
      return result;
    };
    const readBlobAt = async (
      dir: string,
      oid: string | null,
      filepath: string,
    ): Promise<Uint8Array | null> => {
      if (!oid) return null;
      try {
        return ((await G.readBlob!({ fs, dir, oid, filepath })) as { blob: Uint8Array }).blob;
      } catch {
        return null;
      }
    };
    const statusMatrix = async (dir: string, filepaths?: string[]) =>
      (await G.statusMatrix!({ fs, dir, ...(filepaths?.length ? { filepaths } : {}) })) as [
        string,
        number,
        number,
        number,
      ][];
    const indexBlob = async (dir: string, filepath: string): Promise<Uint8Array | null> => {
      // The staged version: walk the index for one path.
      let found: Uint8Array | null = null;
      await G.walk!({
        fs,
        dir,
        trees: [G.STAGE!({})],
        map: async (path: string, [entry]: [{ oid(): Promise<string> } | null]) => {
          // Index entries carry only an object id; the blob is in the object store.
          if (path === filepath && entry)
            found = (
              (await G.readBlob!({ fs, dir, oid: await entry.oid() })) as { blob: Uint8Array }
            ).blob;
          return path === '.' || filepath.startsWith(`${path}/`) || path === filepath ? true : null;
        },
      });
      return found;
    };
    const blobId = async (content: Uint8Array | null) =>
      content
        ? ((await G.hashBlob!({ object: content })) as { oid: string }).oid
        : '0000000000000000000000000000000000000000';
    // Paths a merge left conflicted. Real git keeps these as index stages
    // 1-3; isomorphic-git's index has no stages, so they are listed here
    // until `git add` marks them resolved.
    const unmergedFile = (dir: string) => `${dir}/.git/clientvm-unmerged`;
    const readUnmerged = (dir: string): string[] => {
      try {
        return decode(ctx.fs.readFileSync(unmergedFile(dir)))
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const writeUnmerged = (dir: string, files: string[]) => {
      if (files.length) ctx.fs.writeFileSync(unmergedFile(dir), `${files.join('\n')}\n`);
      else ctx.fs.rmSync(unmergedFile(dir), { force: true });
    };
    const isMerging = (dir: string) => ctx.fs.existsSync(`${dir}/.git/MERGE_HEAD`);
    /** `git status` output, long or short format. */
    const statusReport = async (dir: string, shortFormat: boolean): Promise<string> => {
      const rows = await statusMatrix(dir);
      const head = await headOid(dir);
      const tracked = new Set(rows.filter(([, h, , s]) => h !== 0 || s !== 0).map(([f]) => f));
      const collapse = (file: string) => {
        // Untracked files in a directory with nothing tracked show as the directory.
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++) {
          const prefix = `${parts.slice(0, i).join('/')}/`;
          if (![...tracked].some((t) => t.startsWith(prefix))) return prefix;
        }
        return file;
      };
      const staged: [string, string][] = [];
      const unstaged: [string, string][] = [];
      const untracked = new Set<string>();
      const short_: string[] = [];
      const merging = isMerging(dir);
      const unmerged = merging ? readUnmerged(dir) : [];
      for (const [file, h, w, s] of rows) {
        if (h === 1 && w === 1 && s === 1) continue;
        if (unmerged.includes(file)) {
          short_.push(`UU ${display(dir, file)}`);
          continue;
        }
        if (h === 0 && s === 0) {
          if (w !== 0) untracked.add(collapse(file));
          continue;
        }
        const X = h === 0 ? 'A' : s === 0 ? 'D' : s === 1 ? ' ' : 'M';
        const Y = s === 0 ? ' ' : w === 0 ? 'D' : s === 2 || (s === 1 && w === 1) ? ' ' : 'M';
        if (X !== ' ')
          staged.push([X === 'A' ? 'new file' : X === 'D' ? 'deleted' : 'modified', file]);
        if (Y !== ' ') unstaged.push([Y === 'D' ? 'deleted' : 'modified', file]);
        short_.push(`${X}${Y} ${display(dir, file)}`);
        if (s === 0 && w !== 0) untracked.add(collapse(file));
      }
      if (shortFormat) {
        const lines = [...short_, ...[...untracked].map((f) => `?? ${display(dir, f)}`)];
        return lines.length ? `${lines.join('\n')}\n` : '';
      }
      const branch = await branchName(dir);
      let s = branch ? `On branch ${branch}\n` : `HEAD detached at ${short(head ?? '')}\n`;
      if (!head) s += '\nNo commits yet\n\n';
      if (merging)
        s += unmerged.length
          ? 'You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n'
          : 'All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n';
      const sections: string[] = [];
      if (staged.length) {
        let s = merging
          ? 'Changes to be committed:\n'
          : `Changes to be committed:\n  (use "${head ? 'git restore --staged <file>...' : 'git rm --cached <file>...'}" to unstage)\n`;
        for (const [k, f] of staged) s += `\t${`${k}:`.padEnd(12)}${display(dir, f)}\n`;
        sections.push(s);
      }
      if (unmerged.length) {
        let s = 'Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n';
        for (const f of unmerged) s += `\tboth modified:   ${display(dir, f)}\n`;
        sections.push(s);
      }
      if (unstaged.length) {
        let s = `Changes not staged for commit:\n  (use "git add${unstaged.some(([k]) => k === 'deleted') ? '/rm' : ''} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`;
        for (const [k, f] of unstaged) s += `\t${`${k}:`.padEnd(12)}${display(dir, f)}\n`;
        sections.push(s);
      }
      if (untracked.size) {
        let s = `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n`;
        for (const f of [...untracked].sort()) s += `\t${display(dir, f)}\n`;
        sections.push(s);
      }
      if (sections.length) s += `${sections.join('\n')}\n`;
      if (!staged.length && (unstaged.length || unmerged.length))
        s += 'no changes added to commit (use "git add" and/or "git commit -a")\n';
      else if (!staged.length && untracked.size)
        s += `nothing added to commit but untracked files present (use "git add" to track)\n`;
      else if (!staged.length)
        s += head
          ? 'nothing to commit, working tree clean\n'
          : 'nothing to commit (create/copy files and use "git add" to track)\n';
      return s;
    };
    const isBinary = (b: Uint8Array | null) => !!b && b.subarray(0, 8000).includes(0);
    type Pair = [string, Uint8Array | null, Uint8Array | null];
    /** The files that differ between two commits, with both sides' contents. */
    const commitPairs = async (dir: string, a: string | null, b: string | null) => {
      const files = [...new Set([...(await treeFiles(dir, a)), ...(await treeFiles(dir, b))])];
      const pairs: Pair[] = [];
      for (const f of files.sort()) {
        const pa = await readBlobAt(dir, a, f);
        const pb = await readBlobAt(dir, b, f);
        if (!(pa && pb && pa.length === pb.length && pa.every((x, i) => x === pb[i])))
          pairs.push([f, pa, pb]);
      }
      return pairs;
    };
    /** `--stat` output, as git prints it for an 80-column terminal. */
    const diffstat = (pairs: Pair[], modes = false) => {
      if (!pairs.length) return '';
      const rows = pairs.map(([f, a, b]) => {
        if (isBinary(a) || isBinary(b))
          return { f, bin: `Bin ${a?.length ?? 0} -> ${b?.length ?? 0} bytes`, i: 0, d: 0 };
        let i = 0;
        let d = 0;
        for (const line of unifiedHunks(a ? decode(a) : '', b ? decode(b) : '').split('\n')) {
          if (line.startsWith('+')) i++;
          else if (line.startsWith('-')) d++;
        }
        return { f, bin: '', i, d };
      });
      const nameW = Math.max(...rows.map((r) => r.f.length));
      const numW = Math.max(...rows.map((r) => (r.bin ? 3 : String(r.i + r.d).length)));
      const max = Math.max(...rows.map((r) => r.i + r.d));
      const room = Math.max(80 - nameW - numW - 6, 10);
      let text = '';
      let ti = 0;
      let td = 0;
      for (const r of rows) {
        ti += r.i;
        td += r.d;
        if (r.bin) {
          text += ` ${r.f.padEnd(nameW)} | ${r.bin}\n`;
          continue;
        }
        let [pi, pd] = [r.i, r.d];
        if (max > room) {
          pi = Math.round((r.i * room) / max) || (r.i ? 1 : 0);
          pd = Math.round((r.d * room) / max) || (r.d ? 1 : 0);
        }
        text += ` ${r.f.padEnd(nameW)} | ${String(r.i + r.d).padStart(numW)} ${'+'.repeat(pi)}${'-'.repeat(pd)}\n`;
      }
      const n = pairs.length;
      text += ` ${n} file${n === 1 ? '' : 's'} changed`;
      if (ti || !td) text += `, ${ti} insertion${ti === 1 ? '' : 's'}(+)`;
      if (td) text += `, ${td} deletion${td === 1 ? '' : 's'}(-)`;
      text += '\n';
      if (modes)
        for (const [f, a, b] of pairs) {
          if (!a) text += ` create mode 100644 ${f}\n`;
          else if (!b) text += ` delete mode 100644 ${f}\n`;
        }
      return text;
    };
    const patch = async (
      file: string,
      a: Uint8Array | null,
      b: Uint8Array | null,
      modeA = '100644',
      modeB = '100644',
    ) => {
      if (a && b && a.length === b.length && a.every((x, i) => x === b[i])) return '';
      let s = `diff --git a/${file} b/${file}\n`;
      if (!a) s += `new file mode ${modeB}\n`;
      if (!b) s += `deleted file mode ${modeA}\n`;
      s += `index ${short(await blobId(a))}..${short(await blobId(b))}${a && b ? ` ${modeB}` : ''}\n`;
      if (isBinary(a) || isBinary(b))
        return `${s}Binary files ${a ? `a/${file}` : '/dev/null'} and ${b ? `b/${file}` : '/dev/null'} differ\n`;
      const hunks = unifiedHunks(a ? decode(a) : '', b ? decode(b) : '');
      if (!hunks) return s;
      return `${s}--- ${a ? `a/${file}` : '/dev/null'}\n+++ ${b ? `b/${file}` : '/dev/null'}\n${hunks}`;
    };
    const treeFiles = async (dir: string, oid: string | null): Promise<string[]> =>
      oid ? ((await G.listFiles!({ fs, dir, ref: oid })) as string[]) : [];
    const logLine = (c: CommitInfo) =>
      `commit ${c.oid}\n${c.commit.parent.length > 1 ? `Merge: ${c.commit.parent.map(short).join(' ')}\n` : ''}Author: ${c.commit.author.name} <${c.commit.author.email}>\nDate:   ${gitDate(c.commit.author)}\n\n${c.commit.message
        .replace(/\n$/, '')
        .split('\n')
        .map((l) => `    ${l}`.replace(/^\s+$/, ''))
        .join('\n')}\n`;
    const subject = (c: CommitInfo) => c.commit.message.split('\n')[0] ?? '';

    switch (cmd) {
      case 'init': {
        const { flags, rest } = parse(args, ['-b', '--initial-branch']);
        const dir = resolvePath(cwd, rest[0] ?? '.');
        ctx.fs.mkdirSync(dir, { recursive: true });
        const existed = ctx.fs.existsSync(`${dir}/.git`);
        const defaultBranch = String(
          flags.get('-b') ??
            flags.get('--initial-branch') ??
            (await config(null, 'init.defaultBranch')) ??
            'main',
        );
        await G.init!({ fs, dir, defaultBranch });
        if (!flags.has('-q') && !flags.has('--quiet'))
          await out(
            `${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${dir}/.git/\n`,
          );
        return 0;
      }
      case 'config': {
        const { flags, rest } = parse(args);
        const global = flags.has('--global');
        const home = ctx.env['HOME'] ?? '/home/user';
        const dir = global ? null : await findRoot();
        const key = rest[0];
        if (!key) throw new GitError('error: key does not contain a section', 2);
        if (rest.length === 1 || flags.has('--get')) {
          const v = await config(dir, key);
          if (v === undefined) return 1;
          await out(`${v}\n`);
          return 0;
        }
        if (dir) await G.setConfig!({ fs, dir, path: key, value: rest[1] });
        else {
          const file = `${home}/.gitconfig`;
          const current = ctx.fs.existsSync(file)
            ? parseIni(decode(ctx.fs.readFileSync(file)))
            : {};
          current[key.toLowerCase()] = rest[1]!;
          const sections = new Map<string, string[]>();
          for (const [k, v] of Object.entries(current)) {
            const dot = k.lastIndexOf('.');
            const sec = k.slice(0, dot);
            const head = sec.includes('.')
              ? `${sec.slice(0, sec.indexOf('.'))} "${sec.slice(sec.indexOf('.') + 1)}"`
              : sec;
            sections.set(head, [...(sections.get(head) ?? []), `\t${k.slice(dot + 1)} = ${v}`]);
          }
          ctx.fs.writeFileSync(
            file,
            [...sections].map(([s, l]) => `[${s}]\n${l.join('\n')}\n`).join(''),
          );
        }
        return 0;
      }
      case 'status': {
        const dir = await findRoot();
        const { flags } = parse(args);
        await out(
          await statusReport(
            dir,
            flags.has('-s') || flags.has('--short') || flags.has('--porcelain'),
          ),
        );
        return 0;
      }
      case 'add': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args);
        const all = flags.has('-A') || flags.has('--all');
        const targets = [...rest, ...paths];
        if (!all && targets.length === 0) {
          await ctx.stderr.write('Nothing specified, nothing added.\n');
          return 0;
        }
        const filepaths = all ? undefined : targets.map((p) => rel(dir, p));
        const rows = await statusMatrix(dir, filepaths?.includes('.') ? undefined : filepaths);
        let matched = false;
        const unmerged = readUnmerged(dir);
        for (const [file, h, w, s] of rows) {
          matched = true;
          if (unmerged.includes(file)) unmerged.splice(unmerged.indexOf(file), 1);
          if (w === 0 && (h !== 0 || s !== 0)) await G.remove!({ fs, dir, filepath: file });
          else if (w !== 0 && !(h === 1 && w === 1 && s === 1))
            await G.add!({ fs, dir, filepath: file });
        }
        if (!matched && filepaths && !filepaths.includes('.')) {
          throw new GitError(`fatal: pathspec '${targets[0]}' did not match any files`);
        }
        writeUnmerged(dir, unmerged);
        return 0;
      }
      case 'rm': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args);
        for (const p of [...rest, ...paths]) {
          const file = rel(dir, p);
          const files = ((await G.listFiles!({ fs, dir })) as string[]).filter(
            (f) => f === file || f.startsWith(`${file}/`),
          );
          if (files.length === 0)
            throw new GitError(`fatal: pathspec '${p}' did not match any files`);
          if (files.length > 1 && !flags.has('-r'))
            throw new GitError(`fatal: not removing '${p}' recursively without -r`);
          for (const f of files) {
            await G.remove!({ fs, dir, filepath: f });
            if (!flags.has('--cached')) ctx.fs.rmSync(`${dir}/${f}`, { force: true });
            if (!flags.has('-q')) await out(`rm '${f}'\n`);
          }
        }
        return 0;
      }
      case 'mv': {
        const dir = await findRoot();
        const { rest } = parse(args);
        const [from, to] = rest;
        if (!from || !to) throw new GitError('usage: git mv <source> <destination>', 129);
        const a = rel(dir, from);
        let b = rel(dir, to);
        if (ctx.fs.existsSync(`${dir}/${b}`) && ctx.fs.statSync(`${dir}/${b}`).isDirectory())
          b = `${b}/${a.split('/').pop()}`;
        ctx.fs.renameSync(`${dir}/${a}`, `${dir}/${b}`);
        await G.remove!({ fs, dir, filepath: a });
        await G.add!({ fs, dir, filepath: b });
        return 0;
      }
      case 'commit': {
        const dir = await findRoot();
        const { flags } = parse(args, ['-m', '--message', '-F', '--file']);
        if (flags.has('-a') || flags.has('--all')) {
          for (const [file, h, w, s] of await statusMatrix(dir)) {
            if (h === 0) continue;
            if (w === 0) await G.remove!({ fs, dir, filepath: file });
            else if (!(w === 1 && s === 1)) await G.add!({ fs, dir, filepath: file });
          }
        }
        if (flags.has('-a') || flags.has('--all')) writeUnmerged(dir, []);
        if (readUnmerged(dir).length)
          throw new GitError(
            "error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.",
          );
        const mergeHead = `${dir}/.git/MERGE_HEAD`;
        const merging = ctx.fs.existsSync(mergeHead)
          ? decode(ctx.fs.readFileSync(mergeHead)).trim()
          : null;
        let message = flags.get('-m') ?? flags.get('--message');
        if (merging && typeof message !== 'string')
          message = decode(ctx.fs.readFileSync(`${dir}/.git/MERGE_MSG`));
        const file = flags.get('-F') ?? flags.get('--file');
        if (typeof file === 'string') message = decode(ctx.fs.readFileSync(resolvePath(cwd, file)));
        if (typeof message !== 'string')
          throw new GitError('error: ClientVM git needs -m <message> (no editor)', 1);
        const head = await headOid(dir);
        const rows = await statusMatrix(dir);
        const changes = rows.filter(([, h, , s]) => !(h === 0 && s === 0) && !(h === 1 && s === 1));
        if (changes.length === 0 && !flags.has('--allow-empty') && !merging) {
          await out(await statusReport(dir, false));
          return 1;
        }
        // Diff stats against HEAD, computed before the commit moves it.
        let ins = 0;
        let del = 0;
        const modes: string[] = [];
        for (const [f, h, , s] of changes) {
          const a = h ? await readBlobAt(dir, head, f) : null;
          const b = s ? await indexBlob(dir, f) : null;
          if (!h) modes.push(` create mode 100644 ${f}`);
          if (!s) modes.push(` delete mode 100644 ${f}`);
          if (isBinary(a) || isBinary(b)) continue;
          for (const line of unifiedHunks(a ? decode(a) : '', b ? decode(b) : '').split('\n')) {
            if (line.startsWith('+')) ins++;
            else if (line.startsWith('-')) del++;
          }
        }
        const oid = (await G.commit!({
          fs,
          dir,
          message: message.endsWith('\n') ? message : `${message}\n`,
          author: await person(dir, 'AUTHOR'),
          committer: await person(dir, 'COMMITTER'),
          ...(merging && head ? { parent: [head, merging] } : {}),
        })) as string;
        if (merging) {
          ctx.fs.rmSync(mergeHead, { force: true });
          ctx.fs.rmSync(`${dir}/.git/MERGE_MSG`, { force: true });
        }
        if (!flags.has('-q') && !flags.has('--quiet')) {
          const n = changes.length;
          let stat = ` ${n} file${n === 1 ? '' : 's'} changed`;
          if (ins || !del) stat += `, ${ins} insertion${ins === 1 ? '' : 's'}(+)`;
          if (del) stat += `, ${del} deletion${del === 1 ? '' : 's'}(-)`;
          await out(
            `[${await branchName(dir)}${head ? '' : ' (root-commit)'} ${short(oid)}] ${message.split('\n')[0]}\n${n ? `${stat}\n` : ''}${modes.map((m) => `${m}\n`).join('')}`,
          );
        }
        return 0;
      }
      case 'log': {
        const dir = await findRoot();
        const { flags, rest } = parse(args, ['-n', '--max-count']);
        let depth: number | undefined;
        const n = flags.get('-n') ?? flags.get('--max-count');
        if (typeof n === 'string') depth = Number(n);
        for (const k of flags.keys()) if (/^-\d+$/.test(k)) depth = Number(k.slice(1));
        if (!(await headOid(dir)) && !rest[0]) {
          throw new GitError(
            `fatal: your current branch '${await branchName(dir)}' does not have any commits yet`,
          );
        }
        const commits = await walkLog(dir, rest[0] ? await resolve(dir, rest[0]) : 'HEAD', depth);
        const format = flags.get('--format') ?? flags.get('--pretty');
        let text = '';
        if (flags.has('--oneline'))
          text = commits.map((c) => `${short(c.oid)} ${subject(c)}\n`).join('');
        else if (typeof format === 'string') {
          const f = format.replace(/^format:|^tformat:/, '');
          text = commits
            .map(
              (c) =>
                `${f
                  .replace(/%H/g, c.oid)
                  .replace(/%h/g, short(c.oid))
                  .replace(/%T/g, c.commit.tree)
                  .replace(/%P/g, c.commit.parent.join(' '))
                  .replace(/%an/g, c.commit.author.name)
                  .replace(/%ae/g, c.commit.author.email)
                  .replace(/%at/g, String(c.commit.author.timestamp))
                  .replace(/%ad/g, gitDate(c.commit.author))
                  .replace(/%cn/g, c.commit.committer.name)
                  .replace(/%s/g, subject(c))
                  .replace(/%B/g, c.commit.message)
                  .replace(/%n/g, '\n')}\n`,
            )
            .join('');
        } else text = commits.map(logLine).join('\n');
        await out(text);
        return 0;
      }
      case 'cat-file': {
        const dir = await findRoot();
        const { flags, rest } = parse(args);
        const spec = rest[rest.length - 1];
        if (!spec) throw new GitError('usage: git cat-file (-t | -s | -e | -p) <object>', 129);
        let oid: string;
        try {
          oid = await resolveObject(dir, spec);
        } catch (err) {
          if (flags.has('-e') && /^[0-9a-f]{40}$/.test(spec)) return 1;
          if (err instanceof GitError && err.message.startsWith('fatal: path')) throw err;
          throw new GitError(`fatal: Not a valid object name ${spec}`);
        }
        if (flags.has('-e')) return 0;
        const o = await readObject(dir, oid);
        if (flags.has('-t')) await out(`${o.type}\n`);
        else if (flags.has('-s')) await out(`${o.object.length}\n`);
        else if (flags.has('-p')) await ctx.stdout.write(await prettyObject(dir, oid));
        else if (rest.length === 2) await ctx.stdout.write(o.object);
        else throw new GitError('usage: git cat-file (-t | -s | -e | -p) <object>', 129);
        return 0;
      }
      case 'show': {
        const dir = await findRoot();
        const { flags, rest } = parse(args);
        if (rest[0]?.includes(':')) {
          await ctx.stdout.write(await prettyObject(dir, await resolveObject(dir, rest[0])));
          return 0;
        }
        const oid = await resolve(dir, rest[0] ?? 'HEAD');
        const c = (await G.readCommit!({ fs, dir, oid })) as CommitInfo;
        let s = `${logLine(c)}\n`;
        const pairs = await commitPairs(dir, c.commit.parent[0] ?? null, oid);
        if (flags.has('--stat')) s += diffstat(pairs);
        else if (flags.has('--name-only')) s += pairs.map(([f]) => `${f}\n`).join('');
        else for (const [f, a, b] of pairs) s += await patch(f, a, b);
        await out(s);
        return 0;
      }
      case 'diff': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args);
        const staged = flags.has('--staged') || flags.has('--cached');
        const nameOnly = flags.has('--name-only');
        const stat = flags.has('--stat');
        const head = await headOid(dir);
        const filter = paths.map((p) => rel(dir, p));
        const inScope = (f: string) =>
          filter.length === 0 || filter.some((p) => f === p || f.startsWith(`${p}/`) || p === '.');
        let pairs: [string, Uint8Array | null, Uint8Array | null][] = [];
        if (rest.length === 2) {
          const [a, b] = [await resolve(dir, rest[0]!), await resolve(dir, rest[1]!)];
          pairs = (await commitPairs(dir, a, b)).filter(([f]) => inScope(f));
        } else {
          const base = rest[0] ? await resolve(dir, rest[0]) : null;
          for (const [f, h, w, s] of await statusMatrix(dir)) {
            if (!inScope(f) || (h === 0 && s === 0)) continue;
            const work = () =>
              w === 0 ? null : (ctx.fs.readFileSync(`${dir}/${f}`) as Uint8Array);
            if (base) pairs.push([f, await readBlobAt(dir, base, f), work()]);
            else if (staged)
              pairs.push([
                f,
                h ? await readBlobAt(dir, head, f) : null,
                s ? await indexBlob(dir, f) : null,
              ]);
            else if (s !== 0 && !(s === 2 && w !== 0) && !(s === 1 && w === 1))
              pairs.push([f, await indexBlob(dir, f), work()]);
          }
        }
        let text = '';
        pairs = pairs.filter(
          ([, a, b]) => !(a && b && a.length === b.length && a.every((x, i) => x === b[i])),
        );
        if (nameOnly) text = pairs.map(([f]) => `${f}\n`).join('');
        else if (stat) text = diffstat(pairs, false);
        else for (const [f, a, b] of pairs) text += await patch(f, a, b);
        await out(text);
        return flags.has('--exit-code') && pairs.length > 0 ? 1 : 0;
      }
      case 'branch': {
        const dir = await findRoot();
        const { flags, rest } = parse(args);
        if (flags.has('--show-current')) {
          const b = await branchName(dir);
          if (b) await out(`${b}\n`);
          return 0;
        }
        if (flags.has('-d') || flags.has('-D') || flags.has('--delete')) {
          for (const ref of rest) {
            const oid = await resolve(dir, ref);
            await G.deleteBranch!({ fs, dir, ref });
            await out(`Deleted branch ${ref} (was ${short(oid)}).\n`);
          }
          return 0;
        }
        if (flags.has('-m') || flags.has('-M')) {
          const [a, b] = rest.length === 1 ? [await branchName(dir), rest[0]] : rest;
          await G.renameBranch!({
            fs,
            dir,
            oldref: a,
            ref: b,
            checkout: (await branchName(dir)) === a,
          });
          return 0;
        }
        if (rest.length) {
          await G.branch!({
            fs,
            dir,
            ref: rest[0],
            object: rest[1] ? await resolve(dir, rest[1]) : undefined,
          });
          return 0;
        }
        const current = await branchName(dir);
        const branches = ((await G.listBranches!({ fs, dir })) as string[]).sort();
        await out(branches.map((b) => `${b === current ? '*' : ' '} ${b}\n`).join(''));
        return 0;
      }
      case 'switch':
      case 'checkout': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args, ['-b', '-B', '-c', '-C']);
        const create = flags.get('-b') ?? flags.get('-c') ?? flags.get('-B') ?? flags.get('-C');
        if (
          cmd === 'checkout' &&
          (paths.length || (rest.length && !create && !(await isBranchOrCommit(rest[0]!))))
        ) {
          // git checkout [<rev>] -- <paths>: restore files.
          const files = paths.length ? paths : rest;
          const source = paths.length && rest[0] ? await resolve(dir, rest[0]) : null;
          for (const p of files) {
            const f = rel(dir, p);
            const blob = source ? await readBlobAt(dir, source, f) : await indexBlob(dir, f);
            if (!blob)
              throw new GitError(
                `error: pathspec '${p}' did not match any file(s) known to git`,
                1,
              );
            ctx.fs.writeFileSync(`${dir}/${f}`, blob);
          }
          return 0;
        }
        if (typeof create === 'string') {
          await G.branch!({
            fs,
            dir,
            ref: create,
            object: rest[0] ? await resolve(dir, rest[0]) : undefined,
            force: flags.has('-B') || flags.has('-C'),
          });
          await G.checkout!({ fs, dir, ref: create });
          await ctx.stderr.write(`Switched to a new branch '${create}'\n`);
          return 0;
        }
        const target = rest[0];
        if (!target) throw new GitError('fatal: missing branch or commit argument', 128);
        const branches = (await G.listBranches!({ fs, dir })) as string[];
        if (branches.includes(target)) {
          await G.checkout!({ fs, dir, ref: target });
          await ctx.stderr.write(`Switched to branch '${target}'\n`);
        } else {
          const oid = await resolve(dir, target);
          await G.checkout!({ fs, dir, ref: oid });
          await ctx.stderr.write(`HEAD is now at ${short(oid)}\n`);
        }
        return 0;

        async function isBranchOrCommit(ref: string) {
          try {
            await resolve(dir, ref);
            return true;
          } catch {
            return false;
          }
        }
      }
      case 'restore': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args, ['-s', '--source']);
        const head = await headOid(dir);
        for (const p of [...rest, ...paths]) {
          const f = rel(dir, p);
          if (flags.has('--staged') || flags.has('-S'))
            await G.resetIndex!({ fs, dir, filepath: f, ...(head ? { ref: head } : {}) });
          if (!flags.has('--staged') || flags.has('-W') || flags.has('--worktree')) {
            const src = flags.get('-s') ?? flags.get('--source');
            const blob =
              typeof src === 'string'
                ? await readBlobAt(dir, await resolve(dir, src), f)
                : await indexBlob(dir, f);
            if (blob) ctx.fs.writeFileSync(`${dir}/${f}`, blob);
            else if (!flags.has('--staged'))
              throw new GitError(
                `error: pathspec '${p}' did not match any file(s) known to git`,
                1,
              );
          }
        }
        return 0;
      }
      case 'reset': {
        const dir = await findRoot();
        const { flags, rest, paths } = parse(args);
        const target = rest[0] ? await resolve(dir, rest[0]) : await headOid(dir);
        if (paths.length || (rest.length && !target)) {
          for (const p of paths.length ? paths : rest)
            await G.resetIndex!({ fs, dir, filepath: rel(dir, p) });
          return 0;
        }
        if (!target) return 0;
        const branch = await branchName(dir);
        if (branch)
          await G.writeRef!({ fs, dir, ref: `refs/heads/${branch}`, value: target, force: true });
        if (flags.has('--soft')) return 0;
        const files = new Set([
          ...(await treeFiles(dir, target)),
          ...((await G.listFiles!({ fs, dir })) as string[]),
        ]);
        if (flags.has('--hard')) {
          await G.checkout!({ fs, dir, ref: branch ?? target, force: true });
          for (const f of files) {
            if (!(await readBlobAt(dir, target, f))) {
              await G.remove!({ fs, dir, filepath: f });
              ctx.fs.rmSync(`${dir}/${f}`, { force: true });
            }
          }
          const c = (await G.readCommit!({ fs, dir, oid: target })) as CommitInfo;
          if (!flags.has('-q') && !flags.has('--quiet'))
            await out(`HEAD is now at ${short(target)} ${subject(c)}\n`);
          return 0;
        }
        for (const f of files) await G.resetIndex!({ fs, dir, filepath: f, ref: target });
        return 0;
      }
      case 'rev-parse': {
        const { flags, rest } = parse(args);
        if (flags.has('--is-inside-work-tree')) {
          await findRoot();
          await out('true\n');
          return 0;
        }
        const dir = await findRoot();
        if (flags.has('--show-toplevel')) {
          await out(`${dir}\n`);
          return 0;
        }
        if (flags.has('--git-dir')) {
          await out(`${cwd === dir ? '.git' : `${dir}/.git`}\n`);
          return 0;
        }
        for (const ref of rest) {
          if (flags.has('--abbrev-ref'))
            await out(`${ref === 'HEAD' ? ((await branchName(dir)) ?? 'HEAD') : ref}\n`);
          else {
            const oid = await resolve(dir, ref);
            await out(`${flags.has('--short') ? short(oid) : oid}\n`);
          }
        }
        return 0;
      }
      case 'ls-files': {
        const dir = await findRoot();
        const files = ((await G.listFiles!({ fs, dir })) as string[]).sort();
        await out(files.map((f) => `${display(dir, f)}\n`).join(''));
        return 0;
      }
      case 'tag': {
        const dir = await findRoot();
        const { flags, rest } = parse(args, ['-m']);
        if (flags.has('-d')) {
          for (const t of rest) await G.deleteTag!({ fs, dir, ref: t });
          return 0;
        }
        if (!rest.length) {
          const tags = ((await G.listTags!({ fs, dir })) as string[]).sort();
          await out(tags.map((t) => `${t}\n`).join(''));
          return 0;
        }
        const object = rest[1] ? await resolve(dir, rest[1]) : undefined;
        const message = flags.get('-m');
        if (flags.has('-a') || typeof message === 'string') {
          await G.annotatedTag!({
            fs,
            dir,
            ref: rest[0],
            message: typeof message === 'string' ? message : rest[0],
            tagger: await person(dir, 'COMMITTER'),
            ...(object ? { object } : {}),
          });
        } else await G.tag!({ fs, dir, ref: rest[0], ...(object ? { object } : {}) });
        return 0;
      }
      case 'merge': {
        const dir = await findRoot();
        const { flags, rest } = parse(args, ['-m']);
        const mergeHead = `${dir}/.git/MERGE_HEAD`;
        if (flags.has('--abort')) {
          if (!ctx.fs.existsSync(mergeHead))
            throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
          await G.checkout!({ fs, dir, ref: (await branchName(dir)) ?? 'HEAD', force: true });
          ctx.fs.rmSync(mergeHead, { force: true });
          ctx.fs.rmSync(`${dir}/.git/MERGE_MSG`, { force: true });
          writeUnmerged(dir, []);
          return 0;
        }
        const theirs = rest[0];
        if (!theirs) throw new GitError('fatal: no merge target given', 128);
        const ours = await branchName(dir);
        const before = await headOid(dir);
        try {
          const r = (await G.merge!({
            fs,
            dir,
            ours: ours ?? undefined,
            theirs,
            fastForward: !flags.has('--no-ff'),
            fastForwardOnly: flags.has('--ff-only'),
            // Like git, leave conflict markers in the tree; `git commit` then
            // records the merge from MERGE_HEAD.
            abortOnConflict: false,
            message:
              typeof flags.get('-m') === 'string' ? flags.get('-m') : `Merge branch '${theirs}'`,
            author: await person(dir, 'AUTHOR'),
            committer: await person(dir, 'COMMITTER'),
          })) as { oid: string; alreadyMerged?: boolean; fastForward?: boolean };
          if (r.alreadyMerged) await out('Already up to date.\n');
          else {
            await G.checkout!({ fs, dir, ref: ours ?? r.oid, force: true });
            await out(
              (r.fastForward
                ? `Updating ${short(before ?? '')}..${short(r.oid)}\nFast-forward\n`
                : "Merge made by the 'ort' strategy.\n") +
                diffstat(await commitPairs(dir, before, r.oid), true),
            );
          }
          return 0;
        } catch (err) {
          const e = err as { code?: string; data?: { filepaths?: string[] } };
          if (e.code === 'MergeConflictError' || e.code === 'MergeNotSupportedError') {
            if (e.code === 'MergeConflictError') {
              ctx.fs.writeFileSync(mergeHead, `${await resolve(dir, theirs)}\n`);
              const files = e.data?.filepaths ?? [];
              ctx.fs.writeFileSync(
                `${dir}/.git/MERGE_MSG`,
                `Merge branch '${theirs}'\n\n# Conflicts:\n${files.map((f) => `#\t${f}\n`).join('')}`,
              );
              writeUnmerged(dir, files);
              // isomorphic-git labels our side with the branch name; git says HEAD.
              for (const f of files) {
                const path = `${dir}/${f}`;
                const lines = decode(ctx.fs.readFileSync(path)).split('\n');
                const marker = `<<<<<<< ${ours}`;
                ctx.fs.writeFileSync(
                  path,
                  lines.map((l) => (l === marker ? '<<<<<<< HEAD' : l)).join('\n'),
                );
              }
            }
            for (const f of e.data?.filepaths ?? [])
              await out(`Auto-merging ${f}\nCONFLICT (content): Merge conflict in ${f}\n`);
            await out('Automatic merge failed; fix conflicts and then commit the result.\n');
            return 1;
          }
          throw err;
        }
      }
      case 'stash': {
        const dir = await findRoot();
        const { flags, rest } = parse(args, ['-m', '--message']);
        const quiet = flags.has('-q') || flags.has('--quiet');
        const op = rest[0] ?? 'push';
        const map: Record<string, string> = {
          push: 'push',
          save: 'push',
          pop: 'pop',
          apply: 'apply',
          drop: 'drop',
          list: 'list',
          clear: 'clear',
        };
        if (!map[op]) throw new GitError(`error: unknown subcommand: ${op}`, 129);
        const head = await headOid(dir);
        if (map[op] === 'push') {
          const dirty = (await statusMatrix(dir)).some(
            ([, h, w, s]) => !(h === 0 && s === 0) && !(h === 1 && w === 1 && s === 1),
          );
          if (!dirty) {
            await out('No local changes to save\n');
            return 0;
          }
        }
        let stashOid: string | null = null;
        try {
          stashOid = (await G.resolveRef!({ fs, dir, ref: 'refs/stash' })) as string;
        } catch {
          // no stash yet
        }
        const message = flags.get('-m') ?? flags.get('--message');
        const r = await G.stash!({
          fs,
          dir,
          op: map[op],
          ...(typeof message === 'string' ? { message } : {}),
          author: await person(dir, 'AUTHOR'),
        } as never);
        if (op === 'list' && Array.isArray(r))
          await out(r.map((s, i) => `stash@{${i}}: ${String(s)}\n`).join(''));
        if (quiet) return 0;
        if (map[op] === 'push' && head) {
          const c = (await G.readCommit!({ fs, dir, oid: head })) as CommitInfo;
          await out(
            `Saved working directory and index state ${typeof message === 'string' ? `On ${await branchName(dir)}: ${message}` : `WIP on ${await branchName(dir)}: ${short(head)} ${subject(c)}`}\n`,
          );
        } else if (op === 'pop' || op === 'apply') {
          await out(await statusReport(dir, false));
          if (op === 'pop' && stashOid) await out(`Dropped refs/stash@{0} (${stashOid})\n`);
        } else if (op === 'drop' && stashOid) await out(`Dropped refs/stash@{0} (${stashOid})\n`);
        return 0;
      }
      case 'remote': {
        const dir = await findRoot();
        const { flags, rest } = parse(args);
        if (rest[0] === 'add') {
          await G.addRemote!({ fs, dir, remote: rest[1], url: rest[2] });
          return 0;
        }
        if (rest[0] === 'remove' || rest[0] === 'rm') {
          await G.deleteRemote!({ fs, dir, remote: rest[1] });
          return 0;
        }
        const remotes = (await G.listRemotes!({ fs, dir })) as { remote: string; url: string }[];
        await out(
          remotes
            .map((r) =>
              flags.has('-v')
                ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n`
                : `${r.remote}\n`,
            )
            .join(''),
        );
        return 0;
      }
      case 'clone':
      case 'fetch':
      case 'pull':
      case 'push': {
        const corsProxy = ctx.env['GIT_CORS_PROXY'];
        const { flags, rest } = parse(args, ['-b', '--branch', '--depth']);
        const auth = ctx.env['GIT_TOKEN']
          ? { onAuth: () => ({ username: ctx.env['GIT_TOKEN'], password: 'x-oauth-basic' }) }
          : {};
        const common = { fs, http, ...(corsProxy ? { corsProxy } : {}), ...auth };
        const depth = flags.get('--depth');
        try {
          if (cmd === 'clone') {
            const url = rest[0];
            if (!url) throw new GitError('fatal: You must specify a repository to clone.', 129);
            const name =
              rest[1] ??
              url
                .replace(/\/+$/, '')
                .split('/')
                .pop()!
                .replace(/\.git$/, '');
            const dir = resolvePath(cwd, name);
            await ctx.stderr.write(`Cloning into '${name}'...\n`);
            const ref = flags.get('-b') ?? flags.get('--branch');
            await G.clone!({
              ...common,
              dir,
              url,
              singleBranch: true,
              ...(typeof ref === 'string' ? { ref } : {}),
              ...(typeof depth === 'string' ? { depth: Number(depth) } : {}),
            });
            return 0;
          }
          const dir = await findRoot();
          const remote = rest[0] ?? 'origin';
          if (cmd === 'fetch') await G.fetch!({ ...common, dir, remote });
          else if (cmd === 'pull')
            await G.pull!({
              ...common,
              dir,
              remote,
              ...(rest[1] ? { ref: rest[1] } : {}),
              author: await person(dir, 'AUTHOR'),
              fastForwardOnly: flags.has('--ff-only'),
            });
          else
            await G.push!({
              ...common,
              dir,
              remote,
              ...(rest[1] ? { ref: rest[1] } : {}),
              force: flags.has('-f') || flags.has('--force'),
            });
          return 0;
        } catch (err) {
          if (err instanceof GitError) throw err;
          const hint = corsProxy
            ? ''
            : '\nhint: browsers need a CORS proxy for most git hosts; set GIT_CORS_PROXY (e.g. https://cors.isomorphic-git.org)';
          throw new GitError(`fatal: ${(err as Error).message}${hint}`);
        }
      }
      default:
        throw new GitError(`git: '${cmd}' is not a git command in ClientVM. See 'git --help'.`, 1);
    }
  } catch (err) {
    if (err instanceof GitError) {
      await ctx.stderr.write(`${err.message}\n`);
      return err.status;
    }
    const e = err as { code?: string; message?: string };
    await ctx.stderr.write(`fatal: ${e.message ?? String(err)}\n`);
    return 128;
  }
}
