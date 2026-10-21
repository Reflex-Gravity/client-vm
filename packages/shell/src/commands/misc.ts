// SPDX-License-Identifier: Apache-2.0
// env, printenv, which, sleep, date, uname, whoami, hostname, nproc, true,
// false, pwd, id, clear.

import type { CommandContext } from '../types.ts';
import { complain, resolvePath } from './util.ts';

export async function env(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let vars: Record<string, string> = { ...ctx.env };
  let cwd = ctx.cwd;
  let nul = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-i' || a === '-' || a === '--ignore-environment') vars = {};
    else if (a === '-0' || a === '--null') nul = true;
    else if (a === '-u' || a === '--unset') delete vars[args[++i] ?? ''];
    else if (a.startsWith('--unset=')) delete vars[a.slice(8)];
    else if (a.startsWith('-u') && a.length > 2) delete vars[a.slice(2)];
    else if (a === '-C' || a === '--chdir') cwd = resolvePath(ctx.cwd, args[++i] ?? '.');
    else if (a === '-S' || a === '--split-string') {
      const s = args[++i] ?? '';
      args.splice(i + 1, 0, ...s.split(/\s+/).filter(Boolean));
    } else if (a === '--') {
      i++;
      break;
    } else if (a.startsWith('-') && a.length > 1 && !a.includes('=')) {
      await complain(ctx, `invalid option -- '${a.slice(1)}'`);
      return 125;
    } else break;
  }
  for (; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    if (eq <= 0) break;
    vars[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const cmd = args.slice(i);
  if (cmd.length === 0) {
    const end = nul ? '\0' : '\n';
    await ctx.stdout.write(
      Object.entries(vars)
        .map(([k, v]) => `${k}=${v}${end}`)
        .join(''),
    );
    return 0;
  }
  return ctx.exec(cmd, { env: vars, cwd });
}

export async function printenv(ctx: CommandContext): Promise<number> {
  const names = ctx.argv.slice(1).filter((a) => !a.startsWith('-'));
  if (names.length === 0) {
    await ctx.stdout.write(
      Object.entries(ctx.env)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    );
    return 0;
  }
  let status = 0;
  for (const n of names) {
    const v = ctx.env[n];
    if (v === undefined) status = 1;
    else await ctx.stdout.write(`${v}\n`);
  }
  return status;
}

export async function which(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  const all = args.includes('-a');
  const names = args.filter((a) => a !== '-a' && a !== '-s');
  if (names.length === 0) return 1;
  let status = 0;
  for (const name of names) {
    let found = false;
    const candidates = name.includes('/')
      ? [resolvePath(ctx.cwd, name)]
      : (ctx.env['PATH'] ?? '').split(':').map((d) => `${resolvePath(ctx.cwd, d || '.')}/${name}`);
    for (const c of candidates) {
      try {
        const st = ctx.fs.statSync(c);
        if (st.isDirectory() || (st.mode & 0o111) === 0) continue;
      } catch {
        continue;
      }
      await ctx.stdout.write(`${name.includes('/') ? name : c}\n`);
      found = true;
      if (!all) break;
    }
    if (!found) status = 1;
  }
  return status;
}

export async function sleep(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  if (args.length === 0) {
    await complain(ctx, 'missing operand');
    await ctx.stderr.write("Try 'sleep --help' for more information.\n");
    return 1;
  }
  let ms = 0;
  for (const a of args) {
    const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(a);
    if (!m) {
      if (a === 'infinity' || a === 'inf') {
        ms = Infinity;
        continue;
      }
      await complain(ctx, `invalid time interval '${a}'`);
      await ctx.stderr.write("Try 'sleep --help' for more information.\n");
      return 1;
    }
    const unit = { '': 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]!]!;
    ms += Number(m[1]) * unit;
  }
  if (ms === Infinity) await new Promise(() => {});
  // setTimeout caps at ~24.8 days; chain for longer sleeps.
  while (ms > 0) {
    const step = Math.min(ms, 2 ** 31 - 1);
    await new Promise((r) => setTimeout(r, step));
    ms -= step;
  }
  return 0;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** strftime over a UTC date (ClientVM reports UTC). */
export function strftime(fmt: string, d: Date): string {
  const p = (n: number, w = 2, c = '0') => String(n).padStart(w, c);
  const dayOfYear =
    Math.floor(
      (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        Date.UTC(d.getUTCFullYear(), 0, 1)) /
        86400000,
    ) + 1;
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c !== '%') {
      out += c;
      continue;
    }
    let f = fmt[++i];
    let pad: string | null = null;
    if (f === '-' || f === '_' || f === '0') {
      pad = f;
      f = fmt[++i];
    }
    const num = (n: number, w = 2) =>
      pad === '-' ? String(n) : pad === '_' ? p(n, w, ' ') : p(n, w);
    switch (f) {
      case 'Y':
        out += d.getUTCFullYear();
        break;
      case 'C':
        out += num(Math.floor(d.getUTCFullYear() / 100));
        break;
      case 'y':
        out += num(d.getUTCFullYear() % 100);
        break;
      case 'm':
        out += num(d.getUTCMonth() + 1);
        break;
      case 'd':
        out += num(d.getUTCDate());
        break;
      case 'e':
        out += pad === '-' ? String(d.getUTCDate()) : p(d.getUTCDate(), 2, pad === '0' ? '0' : ' ');
        break;
      case 'H':
        out += num(d.getUTCHours());
        break;
      case 'I':
        out += num(d.getUTCHours() % 12 || 12);
        break;
      case 'k':
        out += p(d.getUTCHours(), 2, ' ');
        break;
      case 'l':
        out += p(d.getUTCHours() % 12 || 12, 2, ' ');
        break;
      case 'M':
        out += num(d.getUTCMinutes());
        break;
      case 'S':
        out += num(d.getUTCSeconds());
        break;
      case 'N':
        out += p(d.getUTCMilliseconds(), 3) + '000000';
        break;
      case 'p':
        out += d.getUTCHours() < 12 ? 'AM' : 'PM';
        break;
      case 'P':
        out += d.getUTCHours() < 12 ? 'am' : 'pm';
        break;
      case 'a':
        out += DAYS[d.getUTCDay()]!.slice(0, 3);
        break;
      case 'A':
        out += DAYS[d.getUTCDay()];
        break;
      case 'b':
      case 'h':
        out += MONTHS[d.getUTCMonth()]!.slice(0, 3);
        break;
      case 'B':
        out += MONTHS[d.getUTCMonth()];
        break;
      case 'j':
        out += num(dayOfYear, 3);
        break;
      case 'u':
        out += d.getUTCDay() || 7;
        break;
      case 'w':
        out += d.getUTCDay();
        break;
      case 's':
        out += Math.floor(d.getTime() / 1000);
        break;
      case 'Z':
        out += 'UTC';
        break;
      case 'z':
        out += '+0000';
        break;
      case 'F':
        out += strftime('%Y-%m-%d', d);
        break;
      case 'T':
        out += strftime('%H:%M:%S', d);
        break;
      case 'R':
        out += strftime('%H:%M', d);
        break;
      case 'D':
        out += strftime('%m/%d/%y', d);
        break;
      case 'c':
        out += strftime('%a %b %e %H:%M:%S %Y', d);
        break;
      case 'x':
        out += strftime('%m/%d/%y', d);
        break;
      case 'X':
        out += strftime('%H:%M:%S', d);
        break;
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case '%':
        out += '%';
        break;
      default:
        out += `%${f ?? ''}`;
    }
  }
  return out;
}

export async function date(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  let d = new Date();
  let format = '%a %b %e %H:%M:%S %Z %Y';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('+')) format = a.slice(1);
    else if (a === '-u' || a === '--utc' || a === '--universal') {
      // always UTC
    } else if (
      a === '-d' ||
      a === '--date' ||
      a.startsWith('--date=') ||
      (a.startsWith('-d') && a.length > 2)
    ) {
      const v =
        a === '-d' || a === '--date'
          ? (args[++i] ?? '')
          : a.startsWith('--date=')
            ? a.slice(7)
            : a.slice(2);
      const t = /^@-?\d+(\.\d+)?$/.test(v)
        ? Number(v.slice(1)) * 1000
        : v === 'now'
          ? Date.now()
          : Date.parse(
              /[zZ]|[+-]\d\d:?\d\d$/.test(v) || !/\d:\d/.test(v) ? v : `${v.replace(' ', 'T')}Z`,
            );
      if (Number.isNaN(t)) {
        await complain(ctx, `invalid date '${v}'`);
        return 1;
      }
      d = new Date(t);
    } else if (a === '-I' || a.startsWith('--iso-8601') || a.startsWith('-I')) {
      const spec = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a.slice(2) || 'date';
      format =
        spec === 'seconds'
          ? '%Y-%m-%dT%H:%M:%S+00:00'
          : spec === 'minutes'
            ? '%Y-%m-%dT%H:%M+00:00'
            : spec === 'hours'
              ? '%Y-%m-%dT%H+00:00'
              : spec === 'ns'
                ? '%Y-%m-%dT%H:%M:%S,%N+00:00'
                : '%Y-%m-%d';
    } else if (a === '-R' || a === '--rfc-email') format = '%a, %d %b %Y %H:%M:%S +0000';
    else if (a.startsWith('-')) {
      await complain(ctx, `invalid option -- '${a.slice(1)}'`);
      return 1;
    }
  }
  await ctx.stdout.write(`${strftime(format, d)}\n`);
  return 0;
}

export async function uname(ctx: CommandContext): Promise<number> {
  const flags = new Set(
    ctx.argv
      .slice(1)
      .flatMap((a) => (a === '--all' ? ['a'] : a.startsWith('-') ? [...a.slice(1)] : [])),
  );
  const fields: [string, string][] = [
    ['s', 'Linux'],
    ['n', 'clientvm'],
    ['r', '6.1.0-clientvm'],
    ['v', '#1 SMP ClientVM'],
    ['m', 'x86_64'],
    ['o', 'GNU/Linux'],
  ];
  const all = flags.has('a');
  const picked = fields.filter(([k]) => all || flags.has(k));
  if (flags.has('p') && !all) picked.push(['p', 'unknown']);
  if (flags.has('i') && !all) picked.push(['i', 'unknown']);
  await ctx.stdout.write(
    `${(picked.length ? picked : [fields[0]!]).map(([, v]) => v).join(' ')}\n`,
  );
  return 0;
}

export async function whoami(ctx: CommandContext): Promise<number> {
  await ctx.stdout.write(`${ctx.env['USER'] ?? 'user'}\n`);
  return 0;
}

export async function hostname(ctx: CommandContext): Promise<number> {
  await ctx.stdout.write('clientvm\n');
  return 0;
}

export async function nproc(ctx: CommandContext): Promise<number> {
  const n = Math.max(1, Math.min(globalThis.navigator?.hardwareConcurrency || 4, 64));
  await ctx.stdout.write(`${n}\n`);
  return 0;
}

export async function id(ctx: CommandContext): Promise<number> {
  const user = ctx.env['USER'] ?? 'user';
  const args = ctx.argv.slice(1);
  if (args.includes('-u')) await ctx.stdout.write(args.includes('-n') ? `${user}\n` : '1000\n');
  else if (args.includes('-g'))
    await ctx.stdout.write(args.includes('-n') ? `${user}\n` : '1000\n');
  else await ctx.stdout.write(`uid=1000(${user}) gid=1000(${user}) groups=1000(${user})\n`);
  return 0;
}

export const trueCmd = () => 0;
export const falseCmd = () => 1;

export async function pwd(ctx: CommandContext): Promise<number> {
  let cwd = ctx.cwd;
  if (ctx.argv.includes('-P')) {
    try {
      cwd = ctx.fs.realpathSync(cwd);
    } catch {
      // keep logical
    }
  }
  await ctx.stdout.write(`${cwd}\n`);
  return 0;
}

export async function clear(ctx: CommandContext): Promise<number> {
  await ctx.stdout.write('\x1b[H\x1b[2J\x1b[3J');
  return 0;
}
